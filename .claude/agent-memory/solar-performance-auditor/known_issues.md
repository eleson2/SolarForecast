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
- **Pattern:** Correlated with 6 PM2 scheduler restarts on the same day. Each restart likely triggers a new Modbus connection sequence. The "Illegal function" error suggests register 3310 (LoadFirstStopSocSet holding register) writes are being rejected.
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

## Issue: 6+ PM2 Scheduler Restarts on 2026-03-25 (escalated to 12 total)
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

## Issue: SOC stuck at 100% during sell window (observed 2026-03-31)
- **What**: Between 15:15 and 16:30, executePipeline reported SOC=100% for 6 consecutive cycles. Schedule had sell actions but power output was 0W or very low (219.51W max at 16:30).
- **Cause**: When SOC=100%, the inverter is in peak-production mode. The sell action sets discharge_soc=20 (floor), but this doesn't force export. The inverter was self-consuming PV + nothing more. Export only starts when the battery can't absorb more PV.
- **Effect**: Real export started once SOC began dropping (after ~17:00). This is expected behaviour given the load-first architecture.
