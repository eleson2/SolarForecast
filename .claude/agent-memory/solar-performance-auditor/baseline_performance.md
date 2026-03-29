---
name: baseline_performance
description: Observed performance baselines for solar forecast accuracy, pipeline health, and hardware behaviour (last updated 2026-03-29)
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
- 9 readings excluded above 5000W threshold as of 2026-03-29 (EV charging detection active).
- This R² is expected given variable load + EV charging — not a system failure.

## Solar Forecast Accuracy Baselines (2026-03-29 partial day, updated)
- Today (2026-03-29) is showing model OVER-forecast: actuals are below forecast, opposite of 2026-03-28.
- 08:00–11:00: forecast ranged 0.88–3.91 kWh/h, actual 0.50–1.60 kWh/h. Actuals are 40–80% below forecast.
- MAE for first 5 daytime hours: 1.273 kWh/h. Pattern: intra-day scalar (learned from sunny 2026-03-28) is too high for overcast 2026-03-29.
- Key finding: intra-day scalars at 08:30 by cloud band: 0%: 0.68x, 25%: 0.20x (cloud cover 32%). The 25% band scalar is being applied at 25% cloud but actual production is still lower. Correction matrix is not yet capturing the March overcast pattern at the correct cloud bands.

## Battery Schedule & SOC (2026-03-28 to 2026-03-29)
- SOC at 18:00 Mar 28: ~94% (charged from solar during day, sell action fired 15:45–18:15).
- Discharge overnight 18:00–23:00: from 94% down to 21% at 23:45. Normal — planned.
- 19 SOC deviations > 10% observed vs plan: all in 19:00–22:15 window (actual consistently 12–20% below plan during discharge). Battery is discharging faster than the LP model projects, likely due to higher-than-modelled actual consumption (3.6–4.9 kW loads vs model's 1.7–2.2 kW estimate).
- 21:45 spike: actual 32% vs plan 52.4% (−20% — largest overnight deviation). 4955W discharge at 21:45 explains the sudden drop.
- Battery bottomed at 17% SOC at 05:00, recovered to ~23% by 08:30 via solar.
- No grid charge scheduled overnight — LP optimizer correctly identified that midday 2026-03-29 prices (0.03–0.11 SEK/kWh) are dramatically cheaper than overnight (0.51–0.59 SEK/kWh). Grid charging was planned for 11:45 onward at <0.11 SEK/kWh.
- No SOC deviation guard activations observed overnight 2026-03-28 → 2026-03-29.
- No manual overrides observed.

## Price Optimisation Patterns (SE3, 2026-03-29)
- Day price range: 0.029–0.602 SEK/kWh (92 slots, 4 missing at 02:00–02:45).
- Overnight (00:00–09:00) prices unusually HIGH for SE3: avg 0.551 SEK/kWh (vs typical 0.015–0.045). No cheap charging window overnight.
- Midday cheap window (12:00–17:00): prices drop to 0.029–0.108 SEK/kWh — cheapest midday prices observed in dataset so far.
- Peak evening: 19:00–20:15 at 0.54–0.60 SEK/kWh. Discharge correctly planned.
- LP optimizer correctly identified: do NOT charge overnight (expensive), DO charge 11:45–17:00 at sub-0.11 SEK/kWh, then discharge 17:30–22:00+ at 0.34–0.60 SEK/kWh. Estimated savings 9–12 SEK at overnight horizon.
- Tomorrow's prices (2026-03-30) not yet available as of 01:10 (elprisetjust 404, nordpool 204 empty). Normal behavior.

## Pipeline Health (2026-03-28 to 2026-03-29)
- 2 config.js restarts in the 24h window: 2026-03-28 19:34, 2026-03-29 01:10. Both caused a double-fire of fetch+battery pipelines at startup.
- 1 ETIMEDOUT on 2026-03-28 15:00 (single, recovered).
- 1 ETIMEDOUT on 2026-03-29 07:00 (single, recovered — execute pipeline missed 08:00 cycle).
- Missing consumption slot: 2026-03-29T02:00 (restart at 01:10 caused boundary offset; 08:05 and 09:05 show further boundary offsets from that restart chain).
- Missing price slots: 2026-03-29T02:00–02:45 (4 slots — not in DB). These correspond to the restart window; prices likely were not fetched for those 15-min slots.
- Missing schedule slots: 2026-03-29T02:00–02:45 (4 slots — same cause as price gaps).
- Missing energy snapshot at 2026-03-29T10:00 (snapshot pipeline fired at 10:15 instead).
- All pipelines reporting last_status='ok' as of 11:45 on 2026-03-29.
- smoothPipeline last ran 2026-03-28 01:00 (expected 02:00 — still showing 1h offset from previous observation).
