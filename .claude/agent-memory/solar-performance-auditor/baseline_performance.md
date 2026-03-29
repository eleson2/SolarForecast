---
name: baseline_performance
description: Observed performance baselines for solar forecast accuracy, pipeline health, and hardware behaviour as of 2026-03-25
type: project
---

## Solar Forecast Accuracy Baselines (updated 2026-03-28)
- **2026-03-28 was a sunny day with cloud-shadow mix.** Despite cloud_cover reading 100% for most morning hours (09:00–13:00), production was very high (2.4–2.8 kWh/h) due to diffuse and gap-irradiance. Open-Meteo irradiance was heavily underestimated (forecast ~0.4–0.5 kWh/h vs 2.4+ kWh/h actual).
- Daily actual production on 2026-03-28: 20.10 kWh. Daily forecast: 10.40 kWh. Overall ratio 1.93×.
- MAE for active daytime hours: 1.10 kWh/h (high). MAPE: 323% (dominated by low-denominator early-morning hours with tiny forecasts).
- 10 of 12 active hours show >30% deviation — this is a systemic model underestimate day, not isolated misses.
- Evening hours 17:00–18:00: actual BELOW forecast (0.7 vs 1.44 kWh at 17:00; 0.1 vs 1.13 kWh at 18:00) — consistent with mountain shadow cut-off (expected site behaviour).
- 16:00 hour was the only one where actual matched forecast well (actual 2.30, forecast 2.15 kWh, +7%).
- Recency bias scalar: clamped at 2× throughout the day (raw 3.0–3.3). Clamping prevented even larger plan errors.

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

## Price Optimisation Patterns (SE3, 2026-03-28)
- Day-ahead price range: 0.066–0.694 SEK/kWh (99 slots over 24h+).
- Cheapest window: 01:45–06:00 at 0.107–0.112 SEK/kWh. Correctly used for grid charging.
- Peak sell window: 15:45–18:15 at 0.36–0.64 SEK/kWh. Sell action scheduled and executed.
- LP optimizer savings estimates ranged from 5.4 SEK (early night before prices loaded) to 23.2 SEK (afternoon, after solar actuals raised confidence).
- Tomorrow's prices (2026-03-29) were not available at 23:30–00:30 (elprisetjust 404, nordpool 204 empty). First available by 13:30 on 2026-03-28 (200 OK from elprisetjust).
- Day-ahead re-optimization: scheduled for 13:15 but batteryPipeline ran at 13:30 (15-min offset due to cron contention). Prices for 2026-03-29 confirmed loaded at 13:30.

## Price Optimisation Patterns (SE3, 2026-03-25)
- Cheapest window: 00:45–05:00, floor ~0.016 SEK/kWh. Correctly identified for grid charging.
- Peak window: 17:30–18:30, reaching 0.73 SEK/kWh. Discharge correctly scheduled.
- Daily price range on 2026-03-25: 0.016–0.733 SEK/kWh, avg ~0.279 SEK/kWh (24h window including Mar 24 and Mar 26 look-ahead data).
- LP optimizer savings estimates ranged from 5.2 to 17.8 SEK across the day as the schedule was re-optimised with improving solar actuals.

## Battery Schedule & SOC (2026-03-28)
- SOC at midnight: 18–20%. Discharged overnight from 90% (2026-03-27 evening) down to 18% by 00:15. Normal — discharge planned all night.
- Grid charging occurred 01:45–06:00 in 7 burst slots (max 7.5 kW each). Battery recovered to ~73% by 04:30.
- 13 SOC deviation events > 10% vs plan. Most in 02:45–04:15 window where actual charged FASTER than planned (actual 42–73% vs plan 27–54%). Caused by re-optimization refreshing the plan at the wrong anchor. System healthy — just planning lag.
- Battery reached 100% SOC at 15:45. Sell action correctly fired 15:45–18:15 during afternoon price peak.
- No SOC deviation guard activations observed on 2026-03-28.
- No manual overrides observed on 2026-03-28.

## Consumption Model
- R²=0.08 (temperature explains almost none of variance) — persistent WARNING every hour.
- 8 readings excluded above 5000W threshold (EV charging detection active).
- This R² is expected given variable load + EV charging — not a system failure.
