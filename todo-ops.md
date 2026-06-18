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

### Revised policy 2026-06-17 — sleep RE-ENABLED with wake timers (Option 3)
The host is a power-hungry gaming laptop, so running it awake 24/7 is wasteful.
Re-examining the data showed sleep was **never** the cause of the big error spikes
(those were the duplicate NSSM service, fixed Jun 3, and the out-of-range
`discharge_soc=8` write rejection, fixed Jun 11). Crucially, the May 19–Jun 3 logs
prove the service handled sleep gracefully: while sleeping **150–228×/day**, the Node
process was **never restarted by NSSM** (0 `EADDRINUSE`/restart banners), **94–96 of 96**
execute cycles still completed daily, and the Modbus error rate (1–8/day) matched the
sleepless rate (~4/day). The old sleeps were only ~9 s each, so they rarely overlapped a
15-min execute slot — for real power savings we need *longer* sleeps + deliberate wake.

New setup (2026-06-17):
- [x] `powercfg` on the active **Balanced** plan: `standby-timeout-ac/dc 4`,
  `RTCWAKE` = 1 (all wake timers enabled, AC+DC), `hibernate-timeout 0`,
  `monitor-timeout 2`. Verified in effect on SCHEME_CURRENT.

> **RESOLVED 2026-06-17 — Razer Cortex was switching the active power plan.**
> Symptom: `powercfg /change` settings kept "disappearing" because Cortex (System
> Booster) flipped the active scheme between its own "Razer Cortex Power Plan" and
> **Balanced**; settings only ever apply to the *active* plan. Fix: **user disabled
> Boost in Razer Cortex**, after which the system stays on Balanced, and we re-applied
> the sleep/wake settings there. Note Balanced previously had `RTCWAKE=2` ("important
> wake timers only") which would have blocked our scheduled WakeToRun task — now set to
> 1 (all wake timers). If you ever manually switch to another plan (e.g. High
> Performance), re-apply these there too. Cortex still runs ~12 processes (minor
> background draw) — optional cleanup later.
> **ROOT CAUSE of the instant re-wake (found 2026-06-17, test pending).** After
> disabling Boost, the laptop finally slept (4-min idle) but woke **1–2 s later, every
> ~4.6 min** (`/lastwake` source = "Unknown"). Long-standing, predates the Razer mouse
> (user confirmed) → not the mouse. The Realtek 2.5GbE NIC has **"Wake on pattern match"
> = Enabled**, which wakes the host on ordinary inbound LAN broadcast/multicast traffic
> (constant on a home LAN) → deterministic ~1–2 s wake. **Fix (run elevated, test
> pending):** `Set-NetAdapterAdvancedProperty -Name "Ethernet 3" -DisplayName "Wake on
> pattern match" -DisplayValue "Disabled"` (keeps Wake-on-Magic-Packet for deliberate
> WOL). Then idle 5–6 min and confirm it stays asleep. If still waking, also disable
> Wake on Magic Packet / `powercfg /devicedisablewake "Realtek Gaming 2.5GbE Family
> Controller #2"`.
> **REVISED 2026-06-18 — no-op wake task FAILED under real sleep; switched to "task runs
> execute".** Once the host actually slept deeply (after disarming the Razer dongle, below),
> the original no-op wake task woke the box but execute did NOT run: node-cron, frozen
> during sleep, doesn't reliably fire in the brief post-wake window (Windows re-sleeps
> ~2 min after a timer wake). Result: only 1 of ~10 cycles ran over 2 h (17:30 ok, then
> 17:45–19:30 all missed); inverter sat on a stale slot. Wake-source log confirmed the task
> *did* wake the box (`NT TASK\SolarForecast-WakeForExecute`), so waking works — the gap was
> node-cron not running. **Fix:** the task now POSTs to `http://127.0.0.1:3000/battery/execute`
> at each slot boundary (:00/:15/:30/:45 +30 s), which runs the cycle directly in the live
> service (`runExecuteCycle` in `inverter-engine.js`, debounced vs the node-cron job).
- [x] Registered the wake task (elevated run of `scripts/setup-wake-timer.ps1`):
  `SolarForecast-WakeForExecute` — `WakeToRun=true`, runs as SYSTEM, every 15 min at
  :00/:15/:30/:45 (+30 s); action POSTs `/battery/execute`. NOTE: runs as SYSTEM so a
  non-elevated `Get-ScheduledTask`/`schtasks /query` can't see it — use an elevated shell
  or `powercfg /waketimers`. **Re-run `setup-wake-timer.ps1` elevated to apply the new
  action/trigger (the old no-op version must be replaced).**
- [ ] Verify after an idle window: long sleeps occur (not 2 s), AND `app.log` shows an
  execute cycle at every :00/:15/:30/:45 with no >15-min gaps, 0 restart banners, Modbus
  errors in the normal band.
- [ ] KNOWN GAP: only execute (+ its conditional re-optimize) is wake-driven. `battery`
  (:30), `learn` (:00), `fetch`, `smooth` land on wake minutes so they run; **`consumption`
  (:05) is skipped during sleep** (box asleep at :05). Non-fatal, but if it matters, align
  the consumption cron to a wake minute or add a :05 wake. Long term the RPi migration
  makes all of this moot.

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
