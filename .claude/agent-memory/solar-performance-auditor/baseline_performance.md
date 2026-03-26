---
name: baseline_performance
description: Observed performance baselines for solar forecast accuracy, pipeline health, and hardware behaviour as of 2026-03-25
type: project
---

## Solar Forecast Accuracy Baselines (as of 2026-03-25)
- System is YOUNG — correction matrix has data only from approximately 2026-02-24 onward (~1 month of data).
- During 100% cloud cover days (common in early spring), irradiance forecasts are near-zero (2–40 W/m²) but actual production can reach 0.1–0.2 kWh/h due to diffuse light. This creates very high MAPE (~500–3600%) on low-irradiance hours, but MAE is tiny in absolute terms (<0.2 kWh).
- On partially cloudy days with afternoon clearing, production can exceed forecast by 2–7x. The intra-day solar scalar is capped at 2.00 (actual/forecast up to 286% observed on 2026-03-25).
- Daytime MAE (hours 08–18 with irradiance>0) on overcast days: ~0.08 kWh/h.
- On partly-cloudy days with clearing (e.g. 2026-03-25 afternoon), MAE for productive hours can reach ~0.5–1.5 kWh/h due to sudden irradiance bursts.

## Battery Schedule & SOC
- Typical overnight grid charge window: 01:00–06:00 at prices 0.015–0.045 SEK/kWh (SE3 region sees very low prices in deep night on active days).
- Peak discharge window: 17:00–19:00, prices reaching 0.5–0.78 SEK/kWh in SE3.
- SOC deviation guard threshold: 10%. Fired once on 2026-03-25 at 01:15 (actual 41% vs planned 51.8%, −11%). Guard triggered replan correctly.
- Battery charged to near 100% on cheap nights (observed 94% at 05:00 on 2026-03-25).

## Pipeline Health Baselines
- All 7 pipelines (fetch, learn, smooth, battery, consumption, execute, snapshot) reporting ok status.
- consumptionPipeline fires hourly at :05 correctly; learn pipeline at :00.
- smoothPipeline expected at 02:00 — last run shows 01:00 on 2026-03-25 (1h early or smoothPipeline registered differently).
- executePipeline normally completes in ~2–3s per cycle when hardware is healthy.

## Modbus / Hardware Observations
- "Modbus exception 1: Illegal function" errors began appearing at 12:00 on 2026-03-25 and continued through 21:30. This is the dominant error type (38 occurrences in 10h). Appears correlated with PM2 restarts (6 scheduler restarts observed on 2026-03-25).
- ETIMEDOUT errors: 2 occurrences on 2026-03-25 (04:45, plus one during Modbus error cluster).
- Short "Timed out" errors: 6 occurrences during the afternoon cluster.
- The pattern of "Illegal function" errors suggests the Modbus write register sequence is being rejected — possibly after a datalogger firmware state change or after too many rapid reconnections post-restart.
- After errors: system correctly falls back to "leaving inverter in last-written state" for transient errors and resets to default for "Illegal function" errors.
- No dry_run mode observed. No lastKnownSoc fallback activation seen in logs.
- Grid export confirmed well below 4.0 kW limit (max observed: ~1.3 kWh exported by 21:30).

## Price Optimisation Patterns (SE3, 2026-03-25)
- Cheapest window: 00:45–05:00, floor ~0.016 SEK/kWh. Correctly identified for grid charging.
- Peak window: 17:30–18:30, reaching 0.73 SEK/kWh. Discharge correctly scheduled.
- Daily price range on 2026-03-25: 0.016–0.733 SEK/kWh, avg ~0.279 SEK/kWh (24h window including Mar 24 and Mar 26 look-ahead data).
- LP optimizer savings estimates ranged from 5.2 to 17.8 SEK across the day as the schedule was re-optimised with improving solar actuals.

## Consumption Model
- R²=0.08 (temperature explains almost none of variance) — persistent WARNING every hour.
- 8 readings excluded above 5000W threshold (EV charging detection active).
- This R² is expected given variable load + EV charging — not a system failure.
