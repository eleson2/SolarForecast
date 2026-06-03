# Operational / Reliability Todo

Findings from the 24h system assessment on **2026-06-03**. These are runtime/host
reliability issues, separate from the feature roadmap in `todo.md`.

---

## ROOT CAUSE of the fetch storm: a DUPLICATE NSSM service

**Confirmed 2026-06-03 via instrumentation (caller stack trace at `fetchPipeline` entry).**
There were **two** NSSM services both running `node G:\projects\SolarForecast\scheduler.js`:
- `SolarForecast` (the legit one) — binds port 3000, runs normally.
- `solar-forecast` (a stray duplicate) — crash-loops because port 3000 is already taken
  (`Error: listen EADDRINUSE` at `scheduler.js:97`, see `logs/nssm-error.log`). NSSM
  restarts it every ~128 s; **each launch runs the startup `fetchPipeline()` at
  `scheduler.js:105` and then dies before the fetch completes** — producing the ~28/hour
  "Starting fetch pipeline" with no completion/error and no in-flight-guard hit (fresh
  process every time). The crashing instance also briefly contended for the inverter Modbus
  connection, contributing to the timeout noise.

### Fix (done 2026-06-03)
- [x] Removed the duplicate service: `nssm stop solar-forecast` + `nssm remove solar-forecast confirm`.
- [x] Restarted `SolarForecast`; it bound port 3000 cleanly (no EADDRINUSE) — storm stopped.
- [x] Added an `EADDRINUSE` guard to `scheduler.js` so any future stray instance logs a clear
  message and exits instead of crash-looping silently.
- [x] Hardened weather fetch with an undici `httpDispatcher` (socket-level timeouts, bounded
  pool) — defensive; a stalled fetch can no longer wedge the pool. Added `undici` dep.

---

## Secondary: host sleeps every ~10 min (affects inverter Modbus)

The Windows host was also configured to **sleep after 10 minutes idle**
(`powercfg` `STANDBYIDLE = 0x258 = 600 s`, AC & DC); the System event log showed
Kernel-Power **sleep (ID 42) → resume (ID 107)** cycles every ~10.5 min, 24/7. Each sleep
severs the NIC and contributes to the overnight inverter Modbus timeouts (#2).

### Fix (primary)
- [x] Disable system sleep on this always-on host (done 2026-06-03):
  `standby-timeout-ac/dc 0` + `hibernate-timeout-ac/dc 0` applied via `powercfg /change`.
  `STANDBYIDLE` now `0x0`.
- [x] Verify no further ID 42/107 events after the change — 0 sleep events in the 15 min
  after the change (was ~6/hour).
- [ ] Note: this is a power-saving vs 24/7-reliability tradeoff — confirm the host is
  meant to run the service continuously (it is, via NSSM). Long term this is solved by
  the planned RPi migration (dedicated always-on device).

---

## #1 — Fetch storm (forecasts stopped refreshing)

**Symptom:** `fetchPipeline` logged `Starting fetch pipeline` ~28×/hour (656 in 24h vs
expected ~4). Over a 2h sample, 59 starts but only **1** HTTP response / `Fetch pipeline
complete`. The other 58 fetches hang with no response, no error, and the 30s
`AbortController` timeout never fires.

**Mechanism (ACTUAL, confirmed):** a duplicate NSSM service crash-loops on EADDRINUSE; each
launch fires the startup `fetchPipeline()` and dies before it completes. See ROOT CAUSE
above. (An earlier hypothesis blamed host-sleep severing sockets + undici pool exhaustion —
that turned out to be wrong for the storm, though sleep is a real secondary issue for #2.)

### Immediate
- [x] Removed the duplicate `solar-forecast` service + restarted `SolarForecast` clean
  (done 2026-06-03). Storm stopped.

### Code hardening (defensive)
- [x] Added a dedicated undici `Agent` (`httpDispatcher` in `src/fetcher.js`) with
  `connect.timeout`/`headersTimeout`/`bodyTimeout` (10s/30s/30s) and bounded `connections: 8`;
  wired into `fetchWeather` and `fetchYr` via the `dispatcher` option. Socket-level timeouts
  survive sleep/resume where the JS `AbortController` timer does not. Added `undici` dep.
  (done 2026-06-03)
- [ ] Optional follow-up: add a watchdog — if N consecutive fetch cycles produce no HTTP
  response, log a clear WARN (and optionally recreate the dispatcher) for extra safety.
- [ ] Optional follow-up: re-verify the in-flight guard (`fetchPipelineInFlight`) behaves
  correctly now that stalls actually time out; the storm masked its behaviour.

---

## #2 — Inverter (Modbus) connectivity failures overnight

**Symptom:** 19/90 `execute` cycles failed (`ETIMEDOUT`/`ECONNRESET`/`EHOSTUNREACH` to
`192.168.1.180:502`), concentrated ~05:30–08:45 local; SOC reads fell back to last-known;
`snapshot` frequently failed. Morning peak-discharge slots only partially applied.

**Mechanism:** two contributors — (a) host sleep (NIC down during each ~10-min sleep), and
(b) the duplicate service's crashing instances also briefly opened Modbus connections to the
datalogger, adding contention.

Additionally the **Growatt datalogger endpoint itself** (`192.168.1.180`) responds poorly,
while the rest of the network is perfect. Measured 2026-06-03 from the PC (`192.168.1.17`):
router `192.168.1.1` = 0% loss / ~0 ms, internet `1.1.1.1` = 0% loss / ~11 ms, but
datalogger `192.168.1.180` = **70–80% loss / 600–1500 ms RTT**. This is NOT a LAN/network
problem — it is specific to the datalogger device. Likely its Wi‑Fi link to the router is
weak (the datalogger joins over Wi‑Fi; PC→router is wired/~0 ms), and/or it is rate-limiting
after the duplicate service hammered it.

### Fix
- [x] Disable host sleep (done) — removes the periodic NIC outage.
- [ ] Address the **datalogger** `192.168.1.180` (not the network — router/internet are 0% loss):
  check the datalogger's Wi‑Fi signal strength / distance to router / 2.4 GHz channel
  congestion; consider relocating it or adding a Wi‑Fi repeater near the inverter. Re-measure
  `ping 192.168.1.180` (target 0% loss, <50 ms).
- [ ] Re-check after the datalogger has had time to recover from the duplicate-service
  hammering (rate-limit cooldown) — re-measure in ~30 min before assuming a hardware issue.
- [ ] Re-assess Modbus failure rate once the datalogger responds reliably.

---

## #3 — Consumption model can't predict a large variable load (likely EV)

**Symptom:** `consumption-model` logged **R²=0.19** repeatedly ("temperature explains little
of the variance; check for EV charging or other large variable loads"). Grid import was
heavy (10.5 kWh) with high load (9.1 kWh) by ~08:45. A big intermittent load is polluting the
temperature regression, degrading the consumption estimate that feeds the LP optimizer.

### Fix
- [ ] Model the EV load explicitly instead of letting it leak into the temperature regression.
  This is exactly **Feature C — EV Charging Recognition** already scoped in `todo.md`
  (DB `ev_schedule`, detection in consumption pipeline, API, estimator overlay, LP input).
- [ ] Short term: if EV charging times are roughly known, add them as scheduled sessions so
  `estimateConsumption` overlays them and the temperature regression is computed on
  house-only load.
- [ ] Validate R² improves once the EV component is removed from the regression input.
