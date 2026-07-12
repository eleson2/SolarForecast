---
name: known_issues
description: Persistent or recurring issues observed during audits, with dates and context
type: project
---

## Issue: "sell" action does not actively export — it relies on load-first inverter behaviour (confirmed 2026-03-31)
- **What**: Both "sell" and "discharge" actions dispatch the SAME Modbus register write: set LoadFirstStopSoc (reg 3310) to discharge_soc (20%). The inverter is in load-first mode — it never actively pushes battery power to the grid on command.
- **Implication**: A "sell" slot only exports to grid if solar production exceeds house load AND battery is full. When battery SOC is falling (draining to cover load), "sell" slots appear to do nothing extra compared to "discharge" — the inverter simply discharges to cover load, with any excess PV going to grid if present.
- **Evidence**: 18:30–18:45 sell slots showed SOC dropping from 95% to 78% while export_today stayed flat at 9.5 kWh. Real export happened 15:00–18:15 when SOC was 100% and PV was high.
- **Why this matters**: The optimizer may overestimate revenue from "sell" slots that are planned for hours when solar is waning and battery is already below max. The actual export mechanism is passive — it cannot be forced.
- **Status**: Architectural limitation of load-first control mode via single register. Export can only be forced if a dedicated export-mode register is available (reg 3308 / export limit not yet tested). Not a bug — understand this when reviewing sell revenue estimates.

## Issue: Modbus "Illegal function" error cluster (first observed 2026-03-25)
- **What:** "Modbus exception 1: Illegal function (device does not support this read/write function)" errors from executePipeline starting at 12:00 on 2026-03-25 and continuing through at least 21:30.
- **Count:** 38 "Illegal function" + 6 short "Timed out" + 2 ETIMEDOUT = 46 total execution errors in one day.
- **Pattern:** Correlated with 6 scheduler restarts on the same day. Each restart likely triggers a new Modbus connection sequence. The "Illegal function" error suggests register 3310 (LoadFirstStopSocSet holding register) writes are being rejected.
- **Mitigation seen:** System correctly resets to default after each error and continues next cycle. Production was not blocked (inverter was still readable — SOC reads succeeded).
- **Why this matters:** If the register write is consistently rejected, the battery dispatch actions (charge_grid, discharge) are not being applied to the inverter. The inverter operates in its default/fallback mode.
- **Status as of 2026-03-25:** Unresolved. Preceded full network outage that started at 22:01 on 2026-03-25 (see below).

## CRITICAL INCIDENT: Full Modbus Network Outage — 2026-03-25 22:01 to at least 2026-03-26 06:45 (ongoing)
- **Last successful dispatch:** 2026-03-25 22:01:32 (pipeline_runs.execute last_status='ok' at 2026-03-25 09:30:14 is stale — actual last successful per log was 22:01)
- **Failure onset:** Immediately after the last success at 22:01:32, a "Modbus exception 1: Illegal function" error fired at 22:01:41 on the reset-to-default step. Within 60 seconds a config.js change triggered a process restart. From that restart (22:03+) the inverter became completely unreachable: TCP connect to 192.168.1.180 timed out.
- **Error progression:**
  1. 21:47–22:01 — "Illegal function" cluster on the reset-to-default step (register write rejected, but SOC reads still succeeding)
  2. 22:01:41 — Final "Illegal function" error
  3. 22:02:57 — Process restarted due to config.js edit
  4. 22:03+ — All connections to 192.168.1.180:502 time out (TCP connect timeout 10000ms). SOC reads fail too.
  5. 01:30 (2026-03-26) — EHOSTUNREACH error (host unreachable, not just timeout) — stronger network-layer failure signal
  6. Ongoing through at least 06:45 on 2026-03-26 — 92 consecutive execute errors, zero successes.
- **Failure duration:** At least 8h 44min with no recovery as of last log entry.
- **Root cause hypothesis:** The datalogger at 192.168.1.180 became unreachable at the network layer. Most likely causes: (a) datalogger lost its IP (DHCP lease expired or reassigned), (b) home router rebooted, (c) datalogger hung/rebooted and is on a different IP, (d) WiFi/LAN disruption. The EHOSTUNREACH at 01:30 (vs ETIMEDOUT earlier) suggests the router knows the device is gone, not just slow.
- **Effect:** No inverter commands have been sent for 8h+. Battery is operating in whatever default/last-written state it was in at 22:01. Scheduled actions (charge_grid, discharge) are all being skipped. Battery SOC unknown.
- **12 config.js restarts total** (12 "config.js changed — restarting" events in log). Cluster of rapid restarts between 21:47–22:05 on 2026-03-25 (6 in ~18 minutes) strongly correlates with the onset of network failure — suggesting someone was actively editing config.js at that time.

## Issue: 6+ Scheduler Restarts on 2026-03-25 (escalated to 12 total)
- First batch restarts at: 11:59:41, 13:42:45, 14:27:57, 14:43:23, 18:39:41 (6 during the day)
- Second cluster: 21:47:21, 21:48:06, 21:59:04, 22:02:57, 22:05:51, 22:34:43, 23:04:03, 23:04:54, 23:05:42 (6+ more in the evening)
- The evening cluster at 21:47–22:05 directly correlates with onset of network outage. Likely cause: user editing config.js (possibly changing inverter IP, port, or brand) which triggered the watcher restarts.
- Each restart triggers fresh cron job registration and may cause mid-cycle state loss.
- The 11:59 restart caused the 10:00 consumption_readings slot to be missing.

## Issue: SOC undershoots plan during discharge (first quantified 2026-03-28 evening; recurring 2026-03-31)
- **What**: During discharge cycles in the evening, actual SOC is consistently 12–20% below planned soc_start.
- **Count**: 14 consecutive slots from 19:00–22:15 on 2026-03-28 all showed actual < plan by 12–20%. Worst: 21:45 slot, actual 32% vs plan 52.4% (−20%). On 2026-03-31: 6 consecutive evening slots showed −13% to −28% deviation (19:30 worst at −28%).
- **Root cause**: LP optimizer models consumption at the per-slot consumption_w estimate (~1.7–2.2 kW), but actual household load on 2026-03-28 evening was 2.4–4.9 kW including what appears to be a large appliance or partial EV charge event at 21:45 (4955W discharge reading). On 2026-03-31 evening, actual discharge was faster than the LP model projected.
- **Effect**: Battery drained faster than planned; reached 21% at 23:45 vs planned ~33%. This is BELOW the planned min_soc floor but the SOC deviation guard did NOT fire (actual remained above guard threshold because the guard compares against soc_start of the NEXT slot, not the depleted actual).
- **No operational impact**: The LP optimizer re-planned correctly each half-hour. No SOC deviation guard needed to activate.

## Issue: Recency bias clamp persistent (observed 2026-03-25 through 2026-03-29)
- **What:** `[model] Recency bias clamped X → 2 (check for metering error)` fires on every learnPipeline run (hourly). Raw values range 3.0–3.5, clamped to 2.
- **Count:** 35 events on 2026-03-28, 32 on 2026-03-27. Persistent since at least 2026-03-25.
- **What it means:** The intra-day actual/forecast ratio is consistently 3× or higher. The model caps the scalar at 2 to avoid over-correction. Today's overall ratio was 1.93× (actual 20.10 kWh vs forecast 10.40 kWh).
- **Root cause:** The correction matrix forecasts are severely low compared to actuals on overcast days — Open-Meteo irradiance dramatically underestimates production under diffuse/overcast sky. The correction matrix has not yet accumulated enough March data to learn the scaling.
- **Status:** Expected to improve as correction matrix accumulates more March observations (currently ~10 days of March data, 1 sample per cell).

## Issue: charge_grid during high-price slot (recurring, confirmed 2026-04-30 06:00)
- **What**: A single charge_grid slot appeared at 06:00 at price 0.979 SEK/kWh, mid-way through an overnight discharge sequence. The slot charged from 22% to 31% SOC.
- **Context**: Overnight prices were expensive (0.69–1.89 SEK/kWh). The optimizer re-ran at 05:30 and apparently inserted a brief recharge before resuming discharge. This looks like a plan discontinuity caused by SOC having drifted slightly from plan, combined with the intra-day scalar being in flux.
- **Effect**: Wasted ~0.9% SOC worth of cheap grid import at an expensive price. Minor cost impact (~0.1 SEK). No operational harm.
- **Status**: Likely a known artefact of hourly re-optimisation — LP recalculates from current SOC and may see brief recharge as locally optimal due to plan discontinuity. Monitor for recurrence.

## Issue: SOC deviation guard threshold may be 8%, not 10% (observed 2026-04-12)
- The 18:00 guard activation on 2026-04-12 showed "actual 67% vs planned 75.2% (−8%)" — an 8% deviation that still triggered the guard.
- The MEMORY previously recorded 10% as the threshold. Either (a) the log message rounds differently from the actual comparison, (b) the config threshold was changed, or (c) the guard uses `>= 8%` not `> 10%`. Verify against `config.js` soc_deviation_threshold.
- **Status:** Needs config verification — threshold documentation may be inaccurate.

## Issue: Consumption model R²=0.06 (persistent, was 0.08)
- Every hourly learnPipeline run emits "Low R²=0.06 — temperature explains little of the variance; check for EV charging or other large variable loads"
- This is a known property of this household: EV charging creates large unpredictable load spikes. 9 readings above 5000W are being excluded.
- This is informational, not actionable. The optimizer uses a flat consumption estimate per slot, not the temperature model directly.
- **Status:** Expected/acceptable. Not worth filing as a bug unless R² drops further.

## Issue: Snapshot boundary offsets in consumptionPipeline (recurring)
- Occurs when the pipeline restarts and the previous energy snapshot is not at the expected 15-min or 60-min boundary.
- Seen on 2026-03-24 at 02:05 and 03:05 (75-min deltas), 2026-03-25 at 11:59 (180-min delta) and 12:05 (150-min delta), and 2026-03-29 at 08:05 and 09:05 (both 75-min deltas after 01:10 restart). Also 2026-03-31 at 06:56/07:05 and 12:28/13:05 (two pairs — two restart events).
- Results in a corrupted consumption_readings entry or a missed hour slot.
- Root cause: each config.js restart re-triggers the snapshot anchor; if the restart happens mid-hour, the next :05 consumption run spans a >60-min delta.
- **Pattern**: restart at minute X causes :05 consumption run to fire with a 75-min delta, and the subsequent run at the next :05 also shows a 75-min offset (second bounce). Two boundary warnings always appear in pairs after each restart.

## Issue: Missing consumption_readings slot for 10:00 on 2026-03-25
- The hourly record for 2026-03-25T10:00 is absent from consumption_readings.
- The process restarted at 11:59:41 — the last normal consumption log before that was 09:05. The 10:05 pipeline run was missed entirely.
- The 11:00 slot (logged at 11:59:41 as part of restart) shows 0W load which is clearly wrong.

## Issue: Missing consumption_readings slot for 11:00 on 2026-03-31
- The hourly record for 2026-03-31T11:00 is absent from consumption_readings.
- Cause: restart event around 06:56 (snapshot boundary offset pair observed). The 11:05 consumption run was missed or produced a bad reading that was not stored.
- This pattern of boundary offset restarts causing missing consumption slots is recurring.

## Issue: Sustained Modbus outage 2026-05-07 08:00–20:00 (12h) — UNRESOLVED
- **What**: 175 error events on May 7. All execute cycles 08:00–20:00 failed. 41 execute errors, 20 snapshot errors, 13 lastKnownSoc fallback activations.
- **Pattern**: ETIMEDOUT clusters then EHOSTUNREACH at 09:15 and 16:30. Datalogger (192.168.1.180) lost network at layer 3, not just rate limited.
- **Effect**: Approximately 48 execute cycles missed (08:00–19:45). Inverter held at last-written discharge floor (20%). Battery continued operating in load-first mode autonomously. No schedule commands were applied during this window.
- **Recovery**: Partial — energy_snapshots show data resuming ~11:30–11:45 (Modbus reads working again), but execute remained failing through 19:46 restart. Full recovery after 19:46 config.js restart.
- **Root cause hypothesis**: Datalogger rebooted or lost DHCP lease. Router may have reassigned 192.168.1.180. The EHOSTUNREACH signals the router knew the device was gone (not just slow).
- **Note on impact**: During outage, inverter was in "discharge" mode (floor=20%) from last write. Battery continued discharging normally overnight and into morning. No operational catastrophe.
- **Status**: Recurring pattern — similar outages on 2026-03-25 (8h+) and shorter bursts on prior days. Datalogger appears to randomly lose network. Consider static IP assignment for 192.168.1.180.

## Issue: Dawn pre-charge RESOLVED — dawn_soc_penalty set to 0 (confirmed 2026-05-10 and 2026-05-11)
- **Status: RESOLVED**. With dawn_soc_penalty=0 (commit 24fb4cb), zero charge_grid slots appeared on May 10 or May 11. No expensive dawn pre-charge events observed.
- Prior behavior: penalty=0.3 (May 5–6) and penalty=0.1 (May 7) both produced dawn charge_grid at 0.94–1.30 SEK.
- Disable (=0) is the correct fix. No side effects observed — battery naturally idles overnight without the recharge.

## Issue: Dawn pre-charge at high price — penalty reduction to 0.1 did not resolve (confirmed 2026-05-07)
- **Status updated**: dawn_soc_penalty reduced from 0.3 to 0.1 (applied before May 7). The dawn charge_grid STILL APPEARED on May 7 at 05:15 price=1.2972 SEK (HIGHER than May 5–6 at 0.94–0.97 SEK with penalty 0.3). Pattern persists.
- **New hypothesis**: The dawn recharge is not primarily driven by the penalty — it may be driven by a minimum SOC constraint at solar ramp-up time. Even with penalty=0.1, the optimizer sees a benefit in having some buffer before solar output begins at 07:00–08:00.
- **What to try next**: Consider `charge_grid_max_buy_price` cap (if config supports it), or raise `min_soc` from 10 to 20 so the floor is already above where dawn recharge targets.

## CRITICAL NEW ISSUE: config.js restart storm — hourly automatic restarts (first observed 2026-05-15)
- **What**: 24 config.js restarts in 24h on May 15, approximately one per hour at ~:21 past each hour. Prior maximum was 5 restarts in one day.
- **Pattern**: Restarts occur at regular ~60-min intervals, NOT clustered around user editing sessions. Debounce is 240,000ms (4 min) — these restarts are separated by 60 min so each fires fully. The regularity suggests an automated process (not a user) is writing config.js.
- **Likely causes**: (a) An antivirus or backup agent that scans/touches config.js hourly, (b) a cron job or scheduled task writing to the file, (c) a Windows automatic update process touching the project directory.
- **Impact**: 717 fetch pipeline starts vs expected 4; 78 consumption pipeline runs vs expected 24; 49 battery pipeline runs vs expected ~24; 116 execute starts vs expected 96. Excessive API calls to Open-Meteo and met.no. Snapshot boundary offsets every hour (pairs of WARN messages). High CPU usage.
- **No data corruption** observed — each restart completed cleanly and pipelines re-ran correctly.
- **Status**: UNRESOLVED. Investigate what is writing config.js hourly. Check Windows Task Scheduler, antivirus logs, and any backup agents.

## Issue: Grid export exceeding 4.0 kW max_export_w limit (recurring — May 1 and May 12)
- **What**: energy_snapshots show grid export rate of 4.3 kW on May 1 (13:15) and 5.2 kW on May 12 (17:30 — worst case so far). These exceed the configured max_export_w=4000 limit.
- **Context**: Max export config is enforced via peak shaving register 3308. Summer config sets export=11kW (not a grid constraint — user-chosen). The 4.0 kW limit in config.js max_export_w appears to be a separate software limit used by the LP optimizer for sell planning. The actual Modbus export register may be set to 11kW.
- **Effect**: Grid export is occurring freely during 100% SOC + active PV windows. The 5.2 kW event suggests the peak shaving export register is NOT limiting to 4.0 kW.
- **Risk**: If there are grid operator constraints in winter, this behavior could be problematic. In summer (current period), export is freely allowed by grid operator. No immediate operational harm.
- **Status**: MONITOR — the discrepancy between max_export_w=4000 (software) and actual behavior (>5 kW exported) suggests the export limit register is not constraining output. Investigate register 3308 setting.

## Issue: Dawn pre-charge at high price driven by dawn_soc_penalty (confirmed recurring 2026-05-05 and 2026-05-06)
- **What**: Every night the optimizer discharges battery to floor (10–20% SOC), then inserts a charge_grid slot at dawn (~06:00) at prices 0.94–0.97 SEK/kWh (expensive). This creates a "drain to floor then top-up at high price" pattern.
- **Root cause**: dawn_soc_penalty: 0.3 penalises holding SOC overnight, making it cheaper to discharge and recharge at dawn even at high prices. On expensive-overnight-price days, the optimizer correctly discharges. But the dawn charge_grid then kicks in at whatever dawn price exists, which is also expensive.
- **Effect**: ~0.74–1.45 kWh of grid import at 0.94–1.36 SEK = 0.70–1.97 SEK cost that could be avoided if optimizer held 15–20% SOC overnight instead.
- **May 6 special case**: A second charge_grid slot at 07:45 (price 1.36 SEK, 265W) appeared — likely a replan artefact when SOC drifted below plan mid-morning before solar was sufficient.
- **Status**: Configuration issue to investigate. Lowering dawn_soc_penalty from 0.3 to 0.1–0.2 may reduce the dawn pre-charge frequency. Alternatively, raising soc_replan_min_soc above 20 or setting a charge_grid_max_buy_price would cap the dawn-charge price.

## Issue: soc_replan_min_soc force-charge guard — REMOVED 2026-05-25
- **What**: Old guard triggered `charge_grid` override when SOC ≤ 30%, bypassing the optimizer. This force-charged at whatever the current price was, regardless of upcoming cheaper windows.
- **Manifestation today**: Battery drained overnight to ~26% by 06:30 at prices 0.60–0.68 SEK/kWh. Had the old guard been active, it would have force-charged at ~0.65 SEK. With the guard removed, the optimizer (via replan) correctly identified that prices collapse to 0.46 SEK at 08:30 and near-zero by 08:45, so it waited for solar (and near-free grid) rather than charging at 0.65 SEK.
- **Result**: Zero charge_grid events today. Grid import = 0.8 kWh total (all overnight, no voluntary charging).
- **Status: RESOLVED**. Guard replaced by unconditional replan trigger in inverter-engine.js. The SOC deviation guard still fires (compares actual vs plan) but now always replans rather than force-charging.

## Issue: Battery schedule discharges at near-zero/negative prices (observed 2026-05-25)
- **What**: Slots at 09:30–10:45 show discharge action at prices 0.020→0.011→0.002→0.000→−0.001 SEK/kWh. The LP optimizer chose discharge into negative-price slots.
- **Context**: These slots appeared in the schedule from a prior (06:30) replan. The schedule's soc_start values (34%, 32%, 30%) did not match actual SOC (which was rising due to solar charging). By 09:30, actual SOC was 34% (matching plan) but rising fast from solar. A subsequent replan at 10:30 showed soc_start=52% — clearly a new replan had updated the slot.
- **Root cause**: Schedule is not invalidated when actual SOC overtakes planned SOC. When solar is actively charging faster than plan, idle/charge_solar slots from the next replan would have been better. But discharge into near-zero prices has negligible cost impact.
- **Status**: Monitor. Minor inefficiency (discharging at ~0 SEK when the battery is filling from solar anyway).

## Issue: Cloud-irradiance cap fires but is insufficient on high-diffuse May days (first observed 2026-05-01)
- **What**: The cloud-irradiance cap (enabled: true, cloud_pct_threshold: 30, irr_wm2_threshold: 400, cap_factor: 0.45) fired at 11:00, 12:00, and 13:00 on May 1. The cap constrained forecast to 1.94/2.20/2.36 kWh respectively — but actual production was 5.1/5.6/5.9 kWh. The cap helped slightly but the forecast was still 2.5–3× too low.
- **Root cause**: May 1 had 45–93% cloud cover during the midday peak, yet actual production was extremely high — consistent with a uniform diffuse overcast that lets through 70–85% of GHI. Open-Meteo irradiance values underestimated this. The correction matrix has zero May samples, so no learned correction exists yet. The 0.45 cap factor, combined with a POA-to-GHI physics baseline that's already underestimated, produces a bound that is still far below reality.
- **Cap has no log statement**: It fires silently. There is no log evidence of cap activation — only deducible from comparing stored prod_forecast to 0.45 × (peak_kw × POA/1000). Added to audit checklist.
- **Status**: Expected for the first month of May data. Correction matrix will learn this pattern after several May observations. The cap is working correctly given the model state.

## Issue: charge_grid dispatch is NOT power-limited to the LP's planned watts (confirmed 2026-07-12)
- **What**: `applySchedule()` in `src/inverters/growatt-modbus.js` (~line 344-399) never writes a power/current register for any action. For `charge_grid` it only writes holding reg 3310/808 (LoadFirstStopSoc) to `cfg.charge_soc` (config default 90%). The LP's computed `watts` field for that slot is purely an economic planning number — it is NEVER sent to the inverter. Once the floor is raised to 90%, the inverter charges from grid at whatever rate it determines (observed ~7-9 kW, close to/above the configured `max_charge_w: 7500`) for the entire 15-min slot, or until the next execute cycle (15 min later) resets the floor back down.
- **Manifestation (2026-07-12T09:45 local)**: LP planned a modest charge_grid of 3290W (price 0.0326 SEK/kWh, day's cheapest slot) intending to raise SOC 38.5%→42.3% (+3.8pts, ~0.8kWh). Actual telemetry (energy_snapshots) showed SOC jump 40%→50% (+10pts, ~2kWh) and grid_import +1.9kWh in that single 15-min window — roughly 2.3× the planned energy, at an average rate close to the 7.5kW hardware max. This is the same single-register/no-power-control architecture already documented for "sell"/"discharge" (see entry above), now confirmed to also apply to charge_grid.
- **User impact**: This is very likely the cause of "sudden power usage that clearly wasn't needed" reports — any charge_grid slot, even one intended as a tiny cheap-price top-up, can trigger a near-max-rate grid charge for the full 15 minutes because there is no way to throttle to the LP's intended wattage with the current single-SOC-floor control scheme. Financially harmless when price is near-zero (as it was here), but the power magnitude is real and would be visible on a home energy monitor / inverter display.
- **Not the cause this time**: config.js `battery.capacity_kwh` 15→20 change (verify — see baseline/project notes), stale LP SOC data, manual override, or a Modbus write failure — all ruled out for the 2026-07-12 event. The LP's SOC assumptions were accurate at dispatch time; the gap is purely between "planned watts" (informational) and "actual charge rate" (uncontrolled, mode/floor-based).
- **Status**: Architectural limitation, not a bug introduced recently — likely present since charge_grid was implemented. Worth flagging to the user as a fix candidate: either (a) add a charge-power/current register write if the Growatt supports one, or (b) have executePipeline re-check every few minutes within a charge_grid slot and drop the floor back down once the LP's intended kWh has been delivered, or (c) at minimum, document that charge_grid `watts` is aspirational, not enforced, and expect full-rate charging bursts whenever it fires.

## RESOLVED 2026-07-12: daylight charge_grid arbitrage removed — floor-protection gate now closes ALL daylight slots
- **History**: Until 2026-07-12, `src/optimizer-lp.js` held the grid-charge gate unconditionally OPEN for daylight slots (`solar_watts >= MIN_SOLAR_W` = 50W): `if (isRelief[t]) { cgGateOpen[t] = true; continue; }`. This allowed pure price arbitrage during the day — e.g. 2026-07-12 09:45, grid charge at 38-40% SOC on the day's cheapest slot (0.0326 SEK/kWh vs 0.94 evening peak, LP logged savings 6.29 SEK). Economically rational per the LP objective, but it contradicted the documented design intent in config.js (`grid_charge_floor_buffer_soc` comment: "the optimizer never grid-charges for arbitrage/hedging... rides down toward the margin and imports directly rather than pre-buying") and the user explicitly rejected it ("the decision to charge the battery was plainly wrong").
- **Fix (2026-07-12)**: the daylight branch was flipped to `cgGateOpen[t] = false` — daylight slots are now ALWAYS closed to grid charging. Pre-sunrise slots keep the existing bridge check (open only if baseline no-grid-charge SOC would breach the margin `min_soc + grid_charge_floor_buffer_soc` = 14+5 = 19% before sunrise). Grid charging is now floor-protection only, matching the config.js comment. Tests unaffected (fixture omits `grid_charge_floor_buffer_soc` → gate disabled in tests).
- **How to audit going forward**: any daylight `charge_grid` slot in a schedule produced AFTER this fix went live IS a bug (check the service was restarted to pick up the code — a commit alone doesn't reload it). Pre-sunrise charge_grid slots remain legitimate when the bridge check fails. The EV auto-charge override (`ev.auto_charge_grid`, `source='ev_detection'`) is a separate path and may still legitimately charge from grid during the day when an EV is detected.
- **Separate issue also fixed same day**: `applySchedule()` in growatt-modbus.js now targets the slot's planned `soc_end` for charge_grid instead of the flat `charge_soc` (90%) — see entry above; the "uncapped power magnitude" concern is bounded by the SOC target now, though the instantaneous rate within that band is still the inverter's choice.

## Log timestamp timezone gotcha: app.log line-prefix is UTC, but ALL embedded/DB timestamps are local (Europe/Stockholm) — do not naively string-match dates (confirmed 2026-07-12)
- **What**: `logs/app.log` line prefixes (e.g. `2026-07-12 09:45:00.771`) are in UTC. But everything else — `slot_ts` in `battery_schedule`/`consumption_readings`, `snapshot_ts` in `energy_snapshots`, and even the `[snapshot]` log line's own embedded label (e.g. `2026-07-12T11:45` inside a line prefixed `09:45:00`) — is in local time (`config.location.timezone`, UTC+2 in summer/CEST).
- **How to verify**: cross-check a `[snapshot]` log line's line-prefix time against its embedded slot label — the embedded label is always local-prefix+2h in summer (CEST). Also cross-checked via a config.js-triggered restart: file mtime (Windows/git-bash, local) read 07:53:17 while the log's own "config.js changed — restarting" entry for the same event read 05:57:17 — consistent with the same 2h gap.
- **Why this matters**: If you grep app.log for a DB slot_ts string like `2026-07-12 09:45` expecting to find the dispatch of that slot, you will silently match the WRONG 15-minute window (actually 2 hours later in wall-clock/UTC terms) and misdiagnose stale-SOC or dispatch-timing issues. Always subtract 2h (summer) from a local slot_ts before grepping app.log, or better, grep a wider window and match on the embedded `[snapshot]`/price labels instead of the line prefix.
- **Status**: Confirmed mechanism, not yet root-caused in code (likely `log.js` uses `new Date().toISOString()` or similar UTC formatter for the line prefix while pipeline code formats local strings via `timeutils.js` for DB/embedded content). Worth a code fix to make logging consistently local, but low priority — just remember the offset when auditing.

## Issue: SOC stuck at 100% during sell window (observed 2026-03-31)
- **What**: Between 15:15 and 16:30, executePipeline reported SOC=100% for 6 consecutive cycles. Schedule had sell actions but power output was 0W or very low (219.51W max at 16:30).
- **Cause**: When SOC=100%, the inverter is in peak-production mode. The sell action sets discharge_soc=20 (floor), but this doesn't force export. The inverter was self-consuming PV + nothing more. Export only starts when the battery can't absorb more PV.
- **Effect**: Real export started once SOC began dropping (after ~17:00). This is expected behaviour given the load-first architecture.
