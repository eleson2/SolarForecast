---
name: known_issues
description: Persistent or recurring issues observed during audits, with dates and context
type: project
---

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

## Issue: Consumption model R²=0.08 (persistent)
- Every hourly learnPipeline run emits "Low R²=0.08 — temperature explains little of the variance; check for EV charging or other large variable loads"
- This is a known property of this household: EV charging creates large unpredictable load spikes. 8 readings above 5000W are being excluded.
- This is informational, not actionable. The optimizer uses a flat consumption estimate per slot, not the temperature model directly.
- **Status:** Expected/acceptable. Not worth filing as a bug unless R² drops further.

## Issue: Snapshot boundary offsets in consumptionPipeline
- Occurs when the pipeline restarts and the previous energy snapshot is not at the expected 15-min or 60-min boundary.
- Seen on 2026-03-24 at 02:05 and 03:05 (75-min deltas), and on 2026-03-25 at 11:59 (180-min delta) and 12:05 (150-min delta).
- Results in a corrupted consumption_readings entry (the 11:00 slot showing 0W load is likely an artefact of the 180-min boundary spanning a period with no data).

## Issue: Missing consumption_readings slot for 10:00 on 2026-03-25
- The hourly record for 2026-03-25T10:00 is absent from consumption_readings.
- The process restarted at 11:59:41 — the last normal consumption log before that was 09:05. The 10:05 pipeline run was missed entirely.
- The 11:00 slot (logged at 11:59:41 as part of restart) shows 0W load which is clearly wrong.
