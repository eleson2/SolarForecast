---
name: baseline_performance
description: Observed performance baselines for solar forecast accuracy, pipeline health, and hardware behaviour (last updated 2026-04-30)
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

## Solar Forecast Accuracy Baselines (2026-03-31 — variable cloud, good production)
- Total actual: 32.0 kWh. Total forecast: 62.1 kWh. Ratio 0.52× (model over-forecasts on days with partial cloud shadow / mountain blocking).
- MAE: 1.98 kWh/h. MAPE: 138% across 11 active daytime hours.
- 9 of 11 active hours showed >30% deviation. The forecast was consistently too HIGH — model set to 6.5 kWh/h cap for high irradiance hours but actuals ranged 0.8–6.1 kWh/h.
- 18:00 was extreme outlier: forecast 6.50 kWh, actual 0.80 kWh (−88%): mountain shadow cut-off combined with cloud. Expected site behaviour.
- 13:00 was a surprise drop: forecast 6.50 kWh, actual 2.60 kWh (−60%). Cloud cover 5% — suggests a localised cloud shadow event not in Open-Meteo.
- Intra-day scalar at 15:30 and later runs: 0.57–0.64×, declining as afternoon actuals came in below forecast. Scalar correctly pulled down through the afternoon.

## Battery Schedule & SOC
- Typical overnight grid charge window: 01:00–06:00 at prices 0.015–0.045 SEK/kWh (SE3 region sees very low prices in deep night on active days).
- Peak discharge window: 17:00–19:00, prices reaching 0.5–0.78 SEK/kWh in SE3.
- SOC deviation guard threshold: 10%. Fired once on 2026-03-25 at 01:15 (actual 41% vs planned 51.8%, −11%). Guard triggered replan correctly.
- Battery charged to near 100% on cheap nights (observed 94% at 05:00 on 2026-03-25).

## Battery Schedule & SOC (2026-03-31)
- SOC at midnight: 89%. Battery started the day very high.
- Overnight price was VERY HIGH: 0.59–0.88 SEK/kWh all night — optimizer correctly discharged battery 02:30–08:30 to near 20%.
- Battery recovered 09:00–14:00 via sell/charge_solar from PV. Reached 100% by ~14:00 on solar alone.
- Evening sell window: sell scheduled 15:15–18:45 at prices 0.68–2.00 SEK/kWh. 31 total sell slots today.
- SOC was stuck at 100% during 15:15–16:30 (6 execute cycles). Inverter was reporting 0W output during sell slots at 100% — NORMAL: inverter is export-limited by peak shaving register at 4.1 kW default.
- Large SOC deviations in evening sell window: 18:30 actual 82% vs plan 95% (−13%), 18:45 actual 78% vs plan 95% (−17%). Battery discharged faster than planned.
- Evening discharge (19:00+) had deviations up to −28%. Actual SOC 20% below plan throughout 19:00–19:45 window.
- No SOC deviation guard activations observed on 2026-03-31 despite large deviations.
- No manual overrides observed.
- Grid export totalled 9.5–9.7 kWh today (snapshot data), consistent with sell actions being executed.

## Pipeline Health Baselines
- All 7 pipelines (fetch, learn, smooth, battery, consumption, execute, snapshot) reporting ok status.
- consumptionPipeline fires hourly at :05 correctly; learn pipeline at :00.
- smoothPipeline expected at 02:00 — last run shows 01:00 on 2026-03-25 (1h early or smoothPipeline registered differently).
- executePipeline normally completes in ~2–3s per cycle when hardware is healthy.

## Modbus / Hardware Observations (2026-03-31)
- 5 connection errors today: 1 Timed out (07:15), 1 EHOSTUNREACH (14:15), 2 EHOSTUNREACH (16:45 execute + reset), 1 Timed out (17:30 battery SOC read).
- All errors were brief and recovered within 1 cycle. No sustained outage like 2026-03-25.
- 16:45 was the worst: EHOSTUNREACH on both execute and reset steps. The 17:00 cycle succeeded normally.
- lastKnownSoc fallback activated at 16:30 (TCP timeout, used 100%) and 17:30 (Timed out, used 95%).
- 2 snapshot boundary offsets today: 06:56 and 07:05 (pair — caused by single restart event around 06:56), plus pair at 12:28 and 13:05.
- 1 config.js restart at 19:57 (user was editing config). Triggered double-fire of fetch+battery.
- Peak shaving limit set to 12 kW at 19:15 and 19:57 (schedule window: 21:05–23:59 limit_kw=12 — this fired early, suggesting schedule boundaries are matched against local time correctly).
- Missing consumption slot: 2026-03-31T11:00 not in consumption_readings.
- 80 of 96 expected energy snapshots present today (16 missing).

## Price Optimisation Patterns (SE3, 2026-03-31)
- Day price range: 0.443–2.043 SEK/kWh (96 slots). Average: 1.072 SEK/kWh.
- Unusual price profile: HIGH ALL DAY including overnight (0.59–0.88 SEK/kWh) — no cheap nighttime window.
- Peak evening: 18:30–21:00 at 1.65–2.04 SEK/kWh. Correctly targeted for sell.
- Sell enabled: True. sell_price_factor: 0.80. max_export_w: 4000.
- Planned 31 sell slots today covering 09:00–18:45. Estimated planned sell revenue: ~17.9 SEK.
- Key insight: "sell" action dispatches same register write as "discharge" (both set discharge_soc floor to 20%). The inverter is load-first — it doesn't actively push to grid. Export happens naturally when PV > load + battery capacity.
- After 19:00, optimizer switched to "discharge" (not "sell") even though prices were 1.60–2.04 SEK/kWh — because solar_watts = 0, inverter had no solar to export, only battery discharge to cover consumption.

## Consumption Model
- R²=0.06 (updated from 0.08 — temperature explains even less variance). Persistent WARNING every hour.
- 9 readings excluded above 5000W threshold as of 2026-03-29 (EV charging detection active).
- This R² is expected given variable load + EV charging — not a system failure.
- Status: Expected/acceptable. Not worth filing as a bug unless R² drops further.

## Price Optimisation Patterns (SE3, 2026-03-29)
- Day price range: 0.029–0.602 SEK/kWh (92 slots, 4 missing at 02:00–02:45).
- Overnight (00:00–09:00) prices unusually HIGH for SE3: avg 0.551 SEK/kWh (vs typical 0.015–0.045). No cheap charging window overnight.
- Midday cheap window (12:00–17:00): prices drop to 0.029–0.108 SEK/kWh — cheapest midday prices observed in dataset so far.
- Peak evening: 19:00–20:15 at 0.54–0.60 SEK/kWh. Discharge correctly planned.
- LP optimizer correctly identified: do NOT charge overnight (expensive), DO charge 11:45–17:00 at sub-0.11 SEK/kWh, then discharge 17:30–22:00+ at 0.34–0.60 SEK/kWh. Estimated savings 9–12 SEK at overnight horizon.
- Tomorrow's prices (2026-03-30) not yet available as of 01:10 (elprisetjust 404, nordpool 204 empty). Normal behavior.

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

## Battery Schedule & SOC (2026-03-28 to 2026-03-29)
- SOC at 18:00 Mar 28: ~94% (charged from solar during day, sell action fired 15:45–18:15).
- Discharge overnight 18:00–23:00: from 94% down to 21% at 23:45. Normal — planned.
- 19 SOC deviations > 10% observed vs plan: all in 19:00–22:15 window (actual consistently 12–20% below plan during discharge). Battery is discharging faster than the LP model projects, likely due to higher-than-modelled actual consumption (3.6–4.9 kW loads vs model's 1.7–2.2 kW estimate).
- 21:45 spike: actual 32% vs plan 52.4% (−20% — largest overnight deviation). 4955W discharge at 21:45 explains the sudden drop.
- Battery bottomed at 17% SOC at 05:00, recovered to ~23% by 08:30 via solar.
- No grid charge scheduled overnight — LP optimizer correctly identified that midday 2026-03-29 prices (0.03–0.11 SEK/kWh) are dramatically cheaper than overnight (0.51–0.59 SEK/kWh). Grid charging was planned for 11:45 onward at <0.11 SEK/kWh.
- No SOC deviation guard activations observed overnight 2026-03-28 → 2026-03-29.
- No manual overrides observed.

## Solar Forecast Accuracy Baselines (2026-04-12 — full overcast, thin diffuse light)
- Cloud cover: 100% for all 13 daytime hours (07:00–19:00). Extreme diffuse conditions.
- Total actual: 5.60 kWh. Total forecast: 3.14 kWh. Ratio 1.78× (model underestimates on pure overcast days — consistent with prior pattern).
- MAE: 0.181 kWh/h. MAPE: 157% across 13 daytime hours. Both dominated by tiny forecasts producing huge percentage errors.
- 10 of 13 active hours showed >30% deviation. All biased positive (actual > forecast).
- Worst hour: 07:00, forecast 0.014 kWh, actual 0.100 kWh (+591%). Morning low-irradiance hours remain most unreliable.
- Best hours: 12:00 (+23%) and 13:00 (+21%) — correction matrix is learning the peak midday behaviour.
- 19:00 was forecast 0.037 kWh but actual was 0 kWh (model forecasted residual light, mountain shadow cut it). Expected site behaviour.
- Intra-day scalar reached 2.60× by 10:30 (raw actual/forecast ratio), clamped throughout the day.
- Apr 13 partial (07:00–14:00): ratio 1.75× — very similar pattern confirming persistent underestimate on 100% cloud cover days.

## Battery Schedule & SOC (2026-04-12 — complex price structure)
- Starting SOC at midnight: ~62% (from previous evening's discharge window end).
- Apr 12 price range: 0.059–1.325 SEK/kWh. Average 0.484 SEK/kWh.
- Cheapest window: 12:45–15:30, floor 0.059–0.135 SEK/kWh. Optimizer correctly used for grid charging.
- Peak discharge window: 18:00–23:15 at 0.698–1.325 SEK/kWh. 44 discharge slots planned, price floor 0.35 SEK/kWh.
- Overnight early (00:00–10:00): mixed idle and some discharge at 0.29–0.51 SEK/kWh. Complex structure.
- EV charging detected 12:00–15:00 Apr 12 (source: inverter_delta_ev): 4 slots. Actual consumption 14:00 = 5600W (highest of day).
- 2 SOC deviation guard activations on Apr 12:
  (1) 15:00: actual 77% vs planned 87.5% (−11%) — triggered replan. Battery had discharged faster during midday charge_grid phase (EV charging taking grid import, pushing SOC plan estimates off).
  (2) 18:00: actual 67% vs planned 75.2% (−8%) — triggered replan. Below 10% threshold but guard fired anyway (guard threshold may be 8%, not 10%).
- Evening discharge (17:00–23:45): SOC fell from ~89% at 17:30 to 24% at 23:45. Discharge was smooth and extended — matching the planned pattern.
- Grid export: 1.7 kWh total for Apr 12. Very modest — most discharge was load-first (covering house load, not exporting).
- LP optimizer savings estimate: 17–20 SEK throughout the day, fairly stable.
- Sell shadow (dry-run) tracked discharge closely — sell price not beneficial enough to unlock sell mode.
- 5 config.js restarts on Apr 12: 12:25, 12:32, 12:42, 13:56, 15:07. All within lunchtime window. Caused extra batteryPipeline runs but no data loss.

## Modbus / Hardware Observations (2026-04-12)
- 4 execute timeout errors: 03:30, 11:15, 20:30, and 10:15 on Apr 13. All transient, recovered next cycle.
- 1 snapshot timeout at 13:15 on Apr 13 (TCP connect timeout). Only snapshot affected — execute succeeded on retry.
- nssm-error.log: empty (0 bytes) — no process-level errors.
- NSSM is the process manager for this installation (Windows service `SolarForecast`; logs to `logs/nssm-out.log` / `logs/nssm-error.log`).
- A process restart occurred around 13:15 on Apr 13 — startup banner visible in nssm-out.log. Triggered by user action (config.js watch or manual restart). Caused day-ahead batteryPipeline to fire at 13:15.
- Apr 13: 13:15 restart caused tomorrow's prices (2026-04-14) to be fetched and day-ahead optimization to fire. Prices 2026-04-14 were available and loaded correctly.
- Power reading at 13:15:58 showed −7188.3W (negative = charging). This is the highest charge rate seen in dataset — likely a charge_grid slot in progress.
- Peak shaving import=12kW, export=11kW set at 13:16. Significantly higher than baseline 4.1kW observed on prior days — this is a new configuration.

## Price Optimisation Patterns (SE3, 2026-04-12)
- Apr 12 range: 0.059–1.325 SEK/kWh. Avg: 0.484. Complex intraday structure with multiple peaks.
- Cheapest midday: 12:45–15:30 at 0.059–0.135 SEK/kWh — typical cheap midday solar pattern.
- Evening peak: 18:00–22:00 at 0.698–1.325 SEK/kWh. Optimizer correctly planned 44 discharge slots from 03:30 onward.
- Apr 13 range: 0.399–1.436 SEK/kWh. Avg: 0.684. Elevated floor — no sub-0.4 pricing all day.
- Apr 13: optimizer planned charge_grid at night (00:00–01:45 at ~0.51 SEK) even though prices are high — likely forced by need to fill battery before discharge window. Unusual but rational given high floor prices all day.
- sell shadow showing 0.00 extra vs discharge on Apr 13 — sell mode offering no marginal benefit (consistent with load-first architecture finding).

## Consumption Model
- R² updated to 0.214 as of 2026-04-30 22:00 (significant jump from 0.079 — model improving with more data). Still emitting WARN every hour.
- 638 samples in model as of 2026-04-30 22:00. EV exclusions: 13 readings above 5000W threshold.
- Slope: -108 W/°C, intercept: 2420 W. Model is improving as dataset grows.

## Solar Forecast Accuracy Baselines (2026-04-30 — overcast morning, clearing afternoon)
- Cloud cover: 87% at dawn (06:00–07:00), declining to 2–3% at 15:00–16:00, rising again to 48% by 18:00.
- Total actual production: 19.80 kWh. Total forecast: 45.84 kWh. Ratio 0.43× (model severely over-forecasts on days with morning cloud and afternoon clearing).
- MAE: 1.691 kWh/h. MAPE: 109.9% across 16 active hours.
- 12 of 16 active hours showed >30% deviation.
- Morning hours 06:00–08:00: actual > forecast (cloud underestimated diffuse contribution). Reversal from 09:00 onward — forecast dramatically over-predicted clearing.
- Peak overestimate: 13:00 — forecast 6.41 kWh, actual 1.70 kWh (−277%). Cloud cover 33% but actual production capped around 1.7–2.1 kWh for midday hours 09:00–14:00.
- 15:00–16:00: cloud_cover dropped to 2–3%, actual production 3.3–3.5 kWh — still well below forecast of 6.0 kWh. This may indicate cloud cover readings lagging actual sky conditions.
- Mountain shadow effect: expected drop at 17:00–18:00 confirmed (1.9 and 1.0 kWh vs forecast 3.5 and 1.9 kWh).
- Intra-day scalars correctly pulled down as day progressed (from 1.58× at 07:30 to 0.35× by 14:30). Correction matrix is learning to downscale midday.
- Correction factors for Apr 30 midday: 0.28–0.37× (09:00–13:00), 0.55–0.58× at 15:00–16:00. Learning from this single observation.

## Battery Schedule & SOC (2026-04-30 — complex price day)
- Starting SOC at midnight: 75% (high, from previous day's solar charging and discharge strategy).
- Apr 30 price range: −0.051 to 1.886 SEK/kWh (96 slots). Average: 0.403 SEK/kWh. Negative prices observed 12:45–16:30 May 1 window.
- Night strategy: Correct overnight discharge 00:00–09:30. Battery drained from 75% → 20% by 09:45. Prices were expensive overnight (0.69–1.70 SEK/kWh).
- Anomaly: charge_grid at 06:00 (price 0.979 SEK/kWh) — brief 1-slot recharge 22% → 31% mid-discharge run. Likely a replan artefact as optimizer re-evaluated with updated intra-day scalar.
- Midday charging: charge_solar 11:30–13:45 (SOC 23% → 34%) at prices 0.037–0.059 SEK/kWh. Correct cheap-window use.
- Grid charge burst 14:00–15:15: 6 consecutive charge_grid slots at prices 0.021–0.039 SEK/kWh (exceptionally cheap for SE3). SOC rose rapidly 36% → 90%. Excellent optimizer decision.
- Battery reached 100% SOC at 13:45 and remained at 100% through 19:15 (sustained export window). This is the expected load-first export behavior.
- Evening discharge 19:30–23:45: smooth discharge from 98% → 60%. Prices were 0.91–1.89 SEK/kWh.
- SOC deviation analysis: Only 2 slots with ≥8% deviation (02:00–02:15 actual 59% vs plan 50.5–49.1%, +8.5–8.9%). Inverter SOC was higher than LP plan — harmless positive overshoot.
- Mean absolute SOC deviation for all 90 paired slots: 2.3% — excellent adherence. No SOC deviation guard activations.
- No manual overrides activated.
- Grid import Apr 30: 11.0 kWh (majority from 14:00–15:15 cheap burst charging).
- Grid export Apr 30: 6.2 kWh (passive export during 100% SOC window 15:45–19:15).
- Total load Apr 30: 26.7 kWh. PV production: 19.8 kWh.

## Price Optimisation Patterns (SE3, 2026-04-30)
- Price range Apr 30: 0.441–1.886 SEK/kWh. Avg: 0.403 SEK/kWh (excluding negative May 1 prices visible in 24h window).
- Expensive throughout the night: 0.69–1.89 SEK/kWh 00:00–09:30 — no cheap overnight window.
- Cheapest window Apr 30: 14:00–15:15 at 0.021–0.039 SEK/kWh — optimizer correctly used for grid-charge burst.
- May 1 prices available from 11:15 onward (elprisetjust.nu returned 200). Prior to 11:15 nordpool returned 204 (no data yet).
- May 1 overnight prices: 0.19–0.30 SEK/kWh — moderate, below Apr 30 nights. Optimizer plans discharge overnight (correct).
- Sell shadow: marginally positive or negative throughout day (-6 to +0.55 extra). Sell mode not triggered — consistent with load-first architecture showing no benefit from sell action.
- LP optimizer savings estimate: 4.88–11.30 SEK throughout day (increased as battery filled and cheap window locked in).
- Day-ahead re-optimisation trigger: May 1 prices loaded at batteryPipeline 11:15.

## Modbus / Hardware Observations (2026-04-30)
- Total Modbus errors: 8 distinct error events (compared to baseline of 4–5 on a typical day).
- Error breakdown: 1 ECONNRESET at 00:45, 2 Timed out (01:15, 03:30), 1 ECONNRESET at 23:30 (pre-window), 5 ETIMEDOUT cluster at 12:15–12:16 (CRITICAL window — see anomaly section).
- 12:15–12:16 outage cluster: Snapshot timeout + execute TCP timeout + 4 unhandled ETIMEDOUT rejections in ~2 minutes. Execute pipeline failed with transient flag; inverter left in last-known state. Recovered by 12:30.
- No lastKnownSoc fallback activations logged on Apr 30.
- 3 null-SOC snapshots in energy_snapshots (01:30, 03:15, 05:30) — correlate with Modbus timeout events.
- Grid export peak: ~3.5–3.9 kW during 15:00–15:30 (battery 100%, strong PV) — within 4.0 kW limit.
- dry_run: false — all commands live.
- No "Illegal function" errors (contrast with 2026-03-25 cluster).
- Snapshot count Apr 30: 93 of 96 expected. Missing: 10:00, 14:15, 20:45.

## R² Improvement Note (2026-04-30)
- R² jumped from 0.079 (Apr 13) to 0.214 (Apr 30). This is a meaningful improvement, driven by more samples (638 vs 455) covering more seasonal variety. Model is learning. WARN continues to fire but is increasingly less concerning.

## Solar Forecast Accuracy Baselines (2026-05-06 to 2026-05-07)
- May 6 (clear day, confirmed): Total actual 48.0 kWh. Total forecast 51.9 kWh. Ratio 0.92x. MAE 0.368 kWh/h (15 active hours). MAPE 24.4%. 3 hours >30% (07:00 +144%, 18:00 +40%, 20:00 -39%). Outstanding accuracy for midday (09:00–14:00 all within 10%).
- May 7 (variable cloud day): Total actual ~47.4 kWh (inverter pv_today), forecast ~35–38 kWh estimated. Model significantly under-forecast due to cloud_cover 60–88% in afternoon while actual PV was very high — classic high-diffuse May pattern. Solar readings show prod_actual=11.5 kWh at 13:00 (correction=2.19x), 6.8 kWh at 15:00 (cloud_cover=60%), 4.5 kWh at 16:00 (cloud_cover=88%). The correction matrix did not have enough May samples to anticipate this.
- Persistent over-forecast pattern at 15:00–17:00 (mountain shadow earlier than model predicts): 0.5–0.8 kWh excess each hour. Expected and documented site behaviour.
- Dawn (06:00) consistently forecasts 0.11–0.12 kWh but actual is 0 kWh. Not a bug — panel not yet illuminated at this sun angle.

## Solar Forecast Accuracy Baselines (2026-05-05 and 2026-05-06 — clear days, strong production)
- May 5: Total actual 44.0 kWh (solar_readings sum) / 47.1 kWh (inverter pv_today). Total forecast 50.68 kWh. Ratio 0.87× (model slightly over-forecasts on clear days).
- May 5: MAE 0.528 kWh/h across 13 active hours with prod_actual>0. MAPE 23.6%. 3 hours >30% deviation (06:00 miss=dawn, 16:00 mountain shadow, 20:00 twilight residual).
- May 6: Total actual 48.0 kWh (partial, prod_actual missing 21:00+) / 48.0 kWh (inverter). Total forecast 51.90 kWh. Ratio 0.92× (good day, model close).
- May 6: MAE 0.386 kWh/h across 14 active hours. MAPE 24.4%. 3 hours >30% deviation (same pattern as May 5: dawn, 18:00 mountain shadow, 20:00 twilight).
- Both days showed consistent over-forecast of ~0.5–0.8 kWh at 15:00–17:00 (mountain shadow earlier than model predicts).
- 06:00 dawn hour: model forecasts 0.11–0.12 kWh but actual is 0 kWh — correction=0. Expected: panel not yet illuminated. Not a system failure.
- Recency bias stable at 1.13–1.14× on these clear days (well within normal range, no clamping).
- Correction matrix (May day=6): only 1 sample per hour cell. Smooth matrix uses Gaussian-blended May neighbours. Both still young.

## Battery Schedule — Dawn SOC Penalty and Overnight Discharge (2026-05-05)
- Starting SOC: 71% at 00:00.
- May 5 overnight prices: 0.28–1.29 SEK/kWh — expensive throughout, no cheap window. Minimum was 0.2825 at 01:45.
- Optimizer scheduled ALL-NIGHT discharge (49 slots) draining from 71% to floor, with only 1 charge_grid slot at 06:00 (price 0.9651 SEK).
- dawn_soc_penalty: 0.3 (configured). This penalises holding SOC overnight to incentivise discharging before solar arrives.
- SOC hit 19% at 04:00 (planned 31.2%): EV charging at night caused faster drain (01:00 and 02:00 marked inverter_delta_ev, consumption 1075–1575W above baseline).
- SOC deviation guard fired twice: (1) 00:45 — actual 40% vs planned 49.8% (−10%), SOC≥30%, triggered replan. (2) 02:00:15 — actual 19% vs planned 31.2% (−12%), SOC<30%, forced charge_grid.
- After 02:00 charge_grid (SOC recovered to ~30%), battery continued discharging to floor again by 04:00 (EV still active).
- At 04:00 the schedule scheduled another charge_grid at 06:00 (price 0.9651 SEK) — this is the dawn pre-charge pattern.
- Grid import May 5: 6.1 kWh. Grid export May 5: 28.3 kWh (enormous — battery was 100% all afternoon with strong PV).
- SOC reached 100% by 12:15 on solar alone (solar surplus: PV ~5.7–6.5 kWh/h with low load ~300–500W).
- Battery remained at 100% from 12:15 through 19:45. All export was passive PV spillover.
- Mean absolute SOC deviation May 5: 4.70% across 92 paired slots. Normal.
- Notable positive deviations: 11:45 (+36%), 12:00 (+44%), 12:15 (+50%) — solar charged much faster than plan expected (plan held at 50% due to solar under-forecast).

## Battery Schedule — May 6 Dawn Charge_Grid at Expensive Prices (ANOMALY)
- Starting SOC: 66% at 00:00 (battery at 70% from previous day, still discharging as of midnight).
- May 6 overnight prices: 0.81–1.29 SEK/kWh — uniformly expensive. No cheap overnight window. Avg 1.157 SEK/kWh (highest overnight average in dataset).
- Optimizer scheduled overnight discharge 00:00–05:30, SOC fell 66% → 19% by 05:30. Correct given high prices.
- ANOMALY: charge_grid at 06:00 (price 0.9408 SEK, 5805W, SOC plan 20→28.7%) and 07:45 (price 1.3593 SEK, 265W, SOC plan 20→20.4%).
  - The 06:00 charge_grid is the dawn_soc_penalty pre-charge. At 0.94 SEK this is expensive but may reflect the dawn_soc_penalty incentivising a charge before solar begins.
  - The 07:45 charge_grid (1.36 SEK, 265W) is unusual — a tiny partial charge at the day's most expensive morning price. Likely a replan artefact triggered by SOC deviation at 07:30 (actual SOC drifting below plan during morning).
- Grid import May 6: 5.6 kWh (by 21:15). Export: 30.7 kWh.
- SOC reached 100% by 12:00, remained at 100% through 18:45. Strong export window.
- Mean absolute SOC deviation May 6: 3.94% across 77 paired slots. Excellent.
- 11 slots with >=8% deviation, all positive (actual above plan) during 08:00–12:15 — solar charging faster than plan expected.

## Sell Shadow — Significant Missed Revenue (2026-05-05 and 2026-05-06)
- sell_enabled: false (current config). sell_price_factor: 0.80.
- May 5 sell shadow: +14.79 to +25.02 SEK extra throughout the day. Peaked at +24.75 SEK extra at 17:30 after battery hit 100%.
- May 6 sell shadow: +18.89 to +27.62 SEK extra throughout the day.
- Sell mode is disabled — this is intentional. But the shadow consistently shows significant unrealised value when battery is at 100% and strong PV export is occurring.
- Key: these are passive export-only days (battery 100%, load-first architecture). Sell mode would allow LP optimizer to plan export more explicitly and potentially capture sell_price_factor × spot_price revenue.

## Price Optimisation Patterns (SE3, 2026-05-05 and 2026-05-06)
- May 5: price range 0.2825–1.4666 SEK/kWh. Average 0.814 SEK/kWh. No cheap overnight window (floor 0.28 at 01:45 is marginally cheap but not like typical 0.05–0.10 cheap windows).
- May 6: price range 0.7460–1.7943 SEK/kWh. Average 1.157 SEK/kWh. All slots above 0.74 — exceptionally expensive day.
- Both days: optimizer correctly discharged battery overnight (prices > daytime midday marginal cost of solar), held idle during export window (100% SOC + PV surplus), discharged in evening.
- Dawn pre-charge slots at high prices (0.94–1.36 SEK) are driven by dawn_soc_penalty: 0.3. The penalty makes holding SOC overnight costly, so battery discharges to floor then charges a small amount at dawn to have minimum buffer for morning load.
- LP optimizer savings estimate May 6: 21.4–22.02 SEK (very stable all day, reflecting a high and flat price curve with excellent solar).

## Modbus / Hardware Observations (2026-05-05 and 2026-05-06)
- May 5 total Modbus error events: ~8 distinct events.
  - 05:15: ETIMEDOUT cluster (4 unhandled), snapshot pipeline error, ECONNRESET.
  - 09:15: execute Timed out, transient flag set.
  - 10:00: fetch Open-Meteo 504 (1st attempt, retried successfully).
  - 13:45: 3 ETIMEDOUT + snapshot timeout (execute recovered next cycle).
- May 6 total Modbus error events: ~11 distinct events.
  - 08:30: execute Timed out, transient flag.
  - 08:45: ETIMEDOUT cluster (4 unhandled), snapshot pipeline error.
  - 11:15: execute Timed out + lastKnownSoc fallback activated (used 100%) — batteryPipeline used last known SOC for optimization.
  - 11:45: ETIMEDOUT + execute Timed out + ECONNRESET cluster.
  - 16:00: ETIMEDOUT + execute TCP timeout + ECONNRESET cluster.
  - 16:00: Open-Meteo 504 (1st attempt, retried successfully — fetchPipeline completed ok).
- lastKnownSoc fallback activated May 6 at 11:15: used 100%. This is actually the correct value (battery was at 100% all afternoon). Harmless.
- dry_run: false. All commands live.
- No "Illegal function" errors.
- Snapshot count May 5: ~88 of 96 (missing: 05:30, 07:15, 11:15, 15:45 — null SOC entries from timeouts).
- Snapshot count May 6: ~93 of 96 (missing/null: 10:30, 13:15, 13:45, 18:00 — null SOC).

## Known Dawn Charge_Grid Pattern — Updated after dawn_soc_penalty change to 0.1 (2026-05-07)
- With dawn_soc_penalty: 0.3 (May 5–6): charge_grid at 06:00, price 0.94–0.97 SEK. Battery drained to 18–19% then charged at dawn.
- With dawn_soc_penalty: 0.1 (May 7 onward): charge_grid moved to 05:15 at 1.2972 SEK, 4768W. Battery still drained to ~23% by 04:00 and still recharged at dawn — the pattern PERSISTS but the timing shifted earlier. The penalty reduction did NOT eliminate the dawn charge; the optimizer still concluded that a pre-solar charge was needed. The dawn floor SOC (~23%) is similar to prior behaviour (~18–20%).
- KEY FINDING (2026-05-07): dawn_soc_penalty=0.1 did not meaningfully change the "drain overnight, charge at dawn" pattern. The optimizer chose a HIGHER price dawn recharge (1.30 vs 0.94 SEK) than with 0.3 penalty. This may be because the constraint forcing minimum SOC at solar start is binding regardless of penalty level.
- A second charge_grid appeared on May 7 at 14:00 (price 1.100 SEK, 3436W) — this is a day-ahead replan mid-afternoon, adding charge as solar declined. Different from the dawn pre-charge pattern.
- Conclusion: dawn_soc_penalty tuning alone may not fix the expensive dawn recharge. Consider instead: min_soc higher (25–30%), or a hard constraint on charge_grid_max_price.

## Modbus / Hardware Observations (2026-05-07 — CRITICAL SUSTAINED OUTAGE)
- Total Modbus error events May 7: 175 (vs 11 on May 6 — 16x higher). This is the highest error count in the dataset.
- SUSTAINED OUTAGE 08:00–20:00 (approx 12h): Every execute cycle failed. 41 execute failures, 20 snapshot failures, 13 lastKnownSoc activations.
- Error pattern: ETIMEDOUT clusters (8–10 errors per 15-min cycle), ECONNRESET, EHOSTUNREACH at 09:15. Characteristic of datalogger network layer failure — not just rate limiting.
- 1 EHOSTUNREACH at 09:15 (host unreachable at network layer) and 1 at 16:30 (execute EHOSTUNREACH + reset also failed). Strong signal that the datalogger lost network connectivity.
- lastKnownSoc fallback used: 08:30→35%, 09:30→55%, 10:30→83%, 11:15→83%, 11:30→83%, 12:30→100%, 13:30→100%, 14:30→100%, 15:30→100%, 16:30→100%, 17:30→100%, 18:30→96%, 19:30→92%. 13 activations in sequence.
- Recovery visible in energy_snapshots: inverter data resumed appearing ~11:45 (SOC=83, from 11:30 null). But execute continued failing through 19:00+.
- 1 ERR_STREAM_WRITE_AFTER_END error at 00:30 (non-fatal, batteryPipeline completed ok).
- 2 snapshot null-rows at 04:15 and 08:15.
- 1 config.js restart at 19:46 (user action). Triggered extra battery+fetch+execute runs.
- All execute failures were transient-flagged — inverter left in last-written state (discharge floor = 20%). During the outage window, the inverter continued normal operation at last-set floor.
- Connectivity before 08:00: fully healthy (execute success every cycle 00:00–07:45).
- dry_run: false. All commands live.

## Solar Correction Matrix State (May 2026)
- As of 2026-05-07: May cells now have 2–3 samples each. May 7 actuals show high corrections (13:00=2.19, 15:00=1.96, 16:00=1.92) from the high-diffuse afternoon. These will update the smooth matrix.
- As of 2026-05-06: May cells have 1 sample each (hours 06:00–18:00 populated by May 5 and May 6 actuals).
- Smooth matrix uses Gaussian-blended neighbours — 3–7 samples per May hour cell.
- Correction values for May 6 day=6: hour 8=0.84, 9=1.02, 10=1.02, 11=0.92, 12=0.91, 13=0.99, 14=1.10, 15=0.89, 16=0.85, 17=0.85, 18=0.72. Generally close to 1.0 (model well-calibrated for clear days in May). The 18:00 correction (0.72) reflects mountain shadow cutting afternoon production.
- Hours 06:00 and 07:00 have corrections of 0.0 and 0.41 — these are dawn hours where the panel barely produces (actual ~0.0 and 0.3 kWh vs forecast 0.12 and 0.73 kWh). Expected — the sun rises but is still below effective angle.

## Solar Forecast Accuracy Baselines (2026-05-01 — variable cloud/clearing day, high production)
- Cloud cover: 45% at 07:00, mixed/clearing morning (1–4% at 08:00–09:00), cloudy 10:00–13:00 (45–93%), clearing rapidly 14:00–17:00 (0–20%), light evening cloud.
- Total actual production: 46.30 kWh (daily cumulative from energy_snapshots). Total forecast: 38.70 kWh. Ratio 1.20× (model under-forecasted on this high-production day — May is first-year data for the correction matrix).
- MAE: 1.107 kWh/h across 16 active hours. MAPE: 45.8% (15 hours with prod_actual > 0.05 kWh).
- 10 of 15 eligible hours showed >30% deviation.
- Morning under-forecast: 10:00–13:00 hugely under-forecast (actual 4.1–5.9 vs forecast 1.6–2.9 kWh). Cloud cover paradox — cloud_cover was 45–93% but actual production was very high, indicating diffuse/gap light that the correction matrix has not yet learned for May.
- Cloud-irradiance cap FIRED at 11:00, 12:00, 13:00 (conditions met: cloud>=30%, irr>=400). Cap constrained forecast at 1.94, 2.20, 2.36 kWh vs uncapped estimates that would have been higher — but actual was 5.1, 5.6, 5.9 kWh. Cap was CORRECT DIRECTION but insufficient; the underlying model still dramatically under-forecasts on high-diffuse-light cloudy days.
- Afternoon over-forecast: 14:00 (−38%), 17:00 (−38%), 18:00 (−36%) — mountain shadow earlier than forecast expected.
- 15:00 was exceptional match: forecast 6.50 kWh vs actual 6.70 kWh (+3%). The best-predicted hour of the day.
- 20:00: forecast 0 kWh, actual 0.1 kWh — Nordic midsummer long twilight producing residual power not captured by irradiance model.
- Intra-day scalars updated to 2.09–2.35× for 25% and 75% cloud bands by afternoon. These are high but correct given observed underestimate.
- May is month 1 of the year in the correction matrix — all May cells start at sample_count=0 (correction_avg=1.0) before today. Today's actuals will begin populating May cells.

## Battery Schedule & SOC (2026-05-01 — excellent adherence day)
- Starting SOC at midnight: 54% (from prior discharge strategy).
- May 1 price range: −0.051 to 0.295 SEK/kWh (96 slots). Average: 0.109 SEK/kWh. Negative prices present 12:00–16:15.
- Night strategy: discharge 00:00–04:45 at 0.187–0.295 SEK/kWh. Prices were cheap overall, but optimizer still correctly discharged battery first (prices still moderately higher than midday negatives). SOC fell 54% → 20% by 04:45. Correct.
- 05:00–09:15: idle at min_soc (20%). 19 consecutive idle slots — battery at floor for ~3.5h in schedule. Min-SOC idle window warning threshold is 4h (16 slots) — this came within 1 slot of triggering.
- Actual SOC during idle window: 18–22% (below plan of 20% by 2–4%). Confirms inverter drained slightly past floor before solar ramp-up.
- Solar charging: organic charge_solar from ~09:15, SOC rose naturally from 20% → 100% by 13:00. Very rapid charge indicating high PV surplus (5–6 kW output, low consumption ~600–900W).
- 13:00–18:45: idle at high SOC (92–100%). Battery full. Negative/near-zero prices meant no incentive to hold or export. Export occurred passively during EV charging window.
- EV detected 11:45–13:15 (inverter draw 5300–7600W, house-only consumption stored). EV auto-charge skipped all 6 slots because solar active. Correct behavior.
- Evening discharge 19:00–23:45: smooth from ~100% to 61%. Prices 0.08–0.21 SEK/kWh. Very modest price spread.
- Mean absolute SOC deviation (91 paired slots): 2.65% — excellent adherence, comparable to Apr 30 (2.3%).
- Notable positive deviations (actual > plan): 10:15 (+14%), 11:15 (+20.5%), 12:15 (+22%) — battery charged faster than plan expected due to solar underforecast. Harmless positive overshoots.
- No SOC deviation guard activations (all deviations were positive overshoot).
- No manual overrides.
- Grid import May 1: 10.0 kWh. Grid export May 1: 7.8 kWh.
- Total load May 1: ~48 kWh. PV production: 46.3 kWh.

## Price Optimisation Patterns (SE3, 2026-05-01)
- Price range May 1: −0.051 to 0.295 SEK/kWh. Average: 0.109 SEK/kWh. Very low price day.
- Negative prices during 12:00–16:15 (passive export to grid undesirable; optimizer held idle correctly).
- Night discharge: 00:00–04:45 at 0.175–0.295 SEK/kWh was cheaper than average but still worth discharging vs grid.
- No cheap overnight charging window — prices were uniform and moderate (0.075–0.295 SEK/kWh all night).
- LP optimizer savings estimates: 2.5–6.7 SEK range through the day. Stabilised at ~6.49–6.61 SEK from 11:15 onward.
- Sell shadow: +0.41 to +0.63 SEK extra throughout day. Sell mode not enabled (sell_enabled: false). Leaving ~0.5 SEK/cycle unrealised. On a negative-price day, sell would allow absorbing export payments.
- Day-ahead re-optimisation: May 2 prices loaded at batteryPipeline 11:15 (elprisetjust.nu returned 200 for May 2 immediately). No separate day-ahead trigger needed — prices arrived before the scheduled 13:15 battery cron.
- May 2 prices: 0.054–0.075 SEK/kWh overnight boundary — even cheaper than May 1. Optimizer scheduling discharge toward evening.

## Modbus / Hardware Observations (2026-05-01)
- Total distinct error events: 11 (up from 8 on Apr 30 — elevated but manageable).
- Error breakdown: 1 ECONNRESET + 1 ETIMEDOUT at 00:00 (snapshot missed, execute succeeded), 5 ETIMEDOUT+ECONNRESET cluster at 03:00–03:01 (execute failed, transient flag set, recovered at 03:15), 2 ETIMEDOUT at 07:15 (non-fatal unhandled), 1 execute timeout at 07:30 (transient), 1 ECONNRESET + 1 ETIMEDOUT at 15:45 (non-fatal).
- 2 execute pipeline failures: 03:00 (TCP timeout, transient flag, recovered 03:15) and 07:30 (Timed out, transient flag, recovered 07:45).
- 3 snapshot timeouts: 00:00, 03:00, 09:30 (null SOC in energy_snapshots).
- No lastKnownSoc fallback activations logged.
- Peak PV output at 11:00: −5309W (charging at 5309W), solar input 5933W — confirms strong May production.
- No "Illegal function" errors.
- dry_run: false. All commands live.
- Snapshot count May 1: 94 of 96 expected (missing 03:15 and 09:30 — both null-SOC from timeouts, confirmed in energy_snapshots).
- Grid export peak: ~4.3 kW observed at 13:15 (power=4617W snapshot) — slightly above 4.0 kW max export limit. Warrants monitoring.

## Consumption Model (2026-05-01)
- R² declining through the day: 0.21 → 0.18. n=638→649. EV exclusions holding at 13 readings.
- Decline driven by high-temperature daytime hours (16–18°C) with LOW actual consumption (600–900W) — temperature model predicts ~840–900W at those temps but actual was also low, so not a contradiction. The variance is in the EV-charging and high-load hours.
- Slope declining day over day: -108 → -96 W/°C. Temperature sensitivity weakening as more warm-weather low-consumption data is added.
- WARN fires every hour — expected and acceptable. Not actionable.

## Solar Forecast Accuracy Baselines (2026-05-10 — heavy overcast day with mystery afternoon clearing)
- Cloud cover: variable — 88% at 06:00, falling to 14–27% at 08:00 and 16:00, spiking 92–100% 10:00–14:00, then clearing to 2–15% for 16:00–19:00.
- Total actual production (energy_snapshots): 35.8 kWh. Total forecast (solar_readings, 15 active hours): 28.76 kWh. Ratio 1.24× (model under-forecasted overall).
- MAE: 1.293 kWh/h across 15 active hours. MAPE: 57.4% (dominated by large under-forecasts in the cloudy midday peak).
- 11 of 15 active hours showed >30% deviation.
- Most severe under-forecasts: 13:00 (forecast 0.845 kWh, actual 4.9 kWh, +480% — cloud_cover=100% yet actual output extremely high, correction_factor=5.8×). This is the classic high-diffuse overcast paradox: 100% cloud cover does NOT mean low output in May.
- After-noon over-forecast: 16:00 (6.32 → 4.70 kWh, −25.6%), 17:00 (5.93 → 3.60, −39%), 18:00 (3.66 → 2.20, −40%). Mountain shadow + cloud combined. Expected site behaviour.
- 10:00–14:00: cloud_cover 92–100% yet actuals 3.2–4.9 kWh/h vs forecasts 0.84–1.57 kWh/h. Correction matrix is learning (corrections 2.04–5.80×) but intra-day scalars only reached 1.54–1.63× (clamped by intraday_scalar_max=3.0 at upper end).
- Battery was full (100% SOC) by 13:45 and remained full through 19:00. SOC correction that caused fast charging from 34%→100% in 08:30–13:30 was entirely solar-driven.
- No charge_grid slots on May 10 — dawn_soc_penalty=0 (disabled as of this commit) confirmed to have ELIMINATED the dawn pre-charge pattern entirely.

## Battery Schedule & SOC (2026-05-10 — discharge-then-idle-then-passive-export day)
- Starting SOC at 00:00: 66% (from previous day's discharge strategy).
- May 10 strategy: discharge 00:00–08:30 (from 66% to 34%), then idle/solar-charge 08:30–13:30 (SOC 34% to 100%), then idle at 100% through 19:00 (passive export), then discharge 19:00–23:45 (100% → 70%).
- All schedule actions were discharge or idle. Zero charge_grid slots — dawn_soc_penalty=0 effect confirmed.
- Mean absolute SOC deviation: 2.78% across 95 paired slots. Excellent adherence.
- 5 slots with ≥8% deviation: all POSITIVE (actual above plan) during 08:00–13:15. Solar charged faster than LP model expected (under-forecast mid-morning). Largest: +13% at 11:15 (actual 65% vs plan 52%). Harmless positive overshoot.
- No SOC deviation guard activations.
- No manual overrides.
- Grid import May 10: 3.5 kWh (small — idle/discharge overnight, no charging). Grid export May 10: 16.9 kWh (huge passive export window 13:45–19:30 at 100% SOC with strong PV).
- Total PV May 10: 35.8 kWh. Total load: 22.3 kWh.
- Peak export rate: confirmed >1.0 kWh/15min window around 15:30–16:30, consistent with 4.0 kW grid export limit in summer peak_shaving config (import=12 kW, export=11 kW for Apr–Sep).
- LP optimizer savings estimate: stable at ~19 SEK throughout day.
- Sell shadow peak on May 11: +13.89 SEK extra (sell_enabled=false). Significant unrealised sell revenue continuing.

## Battery Schedule & SOC (2026-05-11 — partial day up to 18:00, overcast/cloudy with high production)
- Starting SOC at 00:00: 70% (from May 10 end-of-day discharge).
- May 11 strategy: idle 00:00–05:15 (SOC drifting 70%→63% from grid covering load), discharge 05:30–08:45 (63%→47%), charge_solar 09:00–09:15 (47%→48%), idle 09:30 onward once solar surplus built. SOC reached 100% by 12:30 on solar alone.
- Battery at 100% from 12:30 through at least 18:00. Passive export ongoing.
- 4 slots with ≥8% deviation on May 11: all POSITIVE at 11:00–12:15 (+8% to +18%), again solar charging faster than plan expected.
- No SOC deviation guard activations as of 18:00.
- EV charging detected at 11:00 (source=inverter_delta_ev, 11275W). Auto-charge not triggered (solar was active). Normal behaviour.
- Grid import May 11 (up to 18:00): 4.8 kWh (all overnight from idle strategy drawing grid to cover house load).

## Price Optimisation Patterns (SE3, 2026-05-10 and 2026-05-11)
- May 10: price range 0.098–1.239 SEK/kWh. Avg: 0.699 SEK/kWh. Mixed day — cheap midday 08:45 (0.148) and 10:00–12:45 (0.098–0.292), expensive evening 20:00–23:00 (1.01–1.24 SEK).
- May 10: optimizer correctly: discharged morning (68%→34% by 08:30 at 0.80–0.96 SEK), switched to idle at 08:30 as prices dropped (0.56/0.15 SEK at 08:30/08:45 — those are the cheapest slots), held idle through solar charging at midday low prices (0.10–0.16 SEK), then discharged again 19:00+ at 1.0–1.24 SEK.
- May 10: brief anomaly at 08:30 — battery schedule switched from discharge (at 0.925 SEK) to idle at price 0.564 SEK (next slot). This is correct — optimizer recognised prices dropped sharply and correctly stopped discharging.
- May 11: price range 0.978–1.801 SEK/kWh. Avg: 1.214 SEK/kWh. Very expensive day — floor nearly 1.0 SEK. All slots >0.97 SEK. No cheap window for grid charging.
- May 11: optimizer correctly: avoided all grid charging (no charge_grid slots all day), preferred idle/discharge strategy. Discharging overnight at 1.0–1.4 SEK was correct given battery was partially full.
- May 11: discharge from 05:30 at 1.18 SEK and rising to 1.80 SEK at 08:00 — optimizer front-loaded discharge during expensive morning window.
- May 12 prices: 96 slots loaded in DB (day-ahead fetched at 11:15 when elprisetjust returned 200). Day-ahead re-optimization triggered correctly at 11:15.

## Modbus / Hardware Observations (2026-05-10 and 2026-05-11 up to 18:00)
- May 10 total Modbus error events: 2 (minimal day).
  - 04:30: batteryPipeline SOC read timed out — lastKnownSoc fallback used 41%. Harmless (optimizer used conservative SOC).
  - 08:45: ECONNRESET unhandled (non-fatal). Execute succeeded nearby.
- May 10 snapshot count: 96/96 expected. 1 null SOC entry (01:30). Excellent hardware day.
- May 11 total Modbus error events: 9 distinct error events (elevated but manageable).
  - 00:30: ERR_STREAM_WRITE_AFTER_END ×2 + execute Timed out + lastKnownSoc 63%.
  - 01:30: ETIMEDOUT ×3 + ECONNRESET + execute TCP timeout (full execute failure for this cycle).
  - 09:30: snapshot TCP timeout (execute succeeded — batteryPipeline got SOC from execute path instead).
- May 11 snapshot count: 73/~72 expected as of 18:00. Null SOC: 3 (02:30, 03:30, 18:03).
- 18:03 null SOC at "2026-05-11T18:03" is from the config.js restart-triggered snapshot — non-standard timestamp (not on 15-min boundary). Not a genuine missing slot.
- lastKnownSoc activated May 11 at 00:30 (used 63%) and indirectly at 01:30 via batteryPipeline fallback.
- dry_run: false. All commands live.
- No "Illegal function" errors.
- Peak shaving: import=12 kW, export=11 kW (correct Apr–Sep summer range).
- 1 config.js restart at 16:03 on May 11 (user action). Triggered extra fetch, battery, execute, and consumption runs. Snapshot at 16:03 created boundary offset pair warning at 14:05 and 15:05 (two :05 runs surrounding the restart).

## dawn_soc_penalty=0 Effect (confirmed 2026-05-10 and 2026-05-11)
- With dawn_soc_penalty: 0 (disabled as of commit 24fb4cb): ZERO charge_grid slots on either day. The optimizer is no longer pre-charging at dawn.
- Contrast with prior behavior: May 5 (penalty=0.3) and May 7 (penalty=0.1) both had dawn charge_grid at 0.94–1.30 SEK.
- Battery on May 11 stayed in idle mode overnight (63%→60% natural drift) without a dawn recharge, then solar took over. No high-price grid charging event.
- This confirms dawn_soc_penalty=0 is the correct fix for the expensive dawn pre-charge issue.

## Consumption Model (2026-05-11)
- n=736, R²=0.184, slope=-91 W/°C, intercept=2285 W. EV exclusions: 22 readings.
- EV detected at 11:00 (11275W source=inverter_delta_ev). EV exclusion count rose from 13 (May 1) to 22 by May 11 — EV charging events accumulating in dataset.
- R²=0.184 is slightly below the Apr 30 peak of 0.214 — expected as more variable warm-weather data added. Still above the early 0.06–0.08 baseline.
- Recency bias: 1.404–1.424 throughout May 11 (stable, moderate — the intra-day scalar is learning the overcast=high-output pattern for May).

## Solar Forecast Accuracy Baselines (2026-05-12 — heavy overcast, high-diffuse May day)
- Cloud cover: 80–95% throughout the entire daytime period (06:00–20:00). Persistent thick overcast.
- Total actual production (energy_snapshots): 24.8 kWh. Total forecast (solar_readings, 15 active hours): 18.23 kWh. Ratio 1.48x (model under-forecasts on heavy-overcast high-diffuse May days — consistent recurring pattern).
- MAE: 1.080 kWh/h across 15 active hours. MAPE: 47.7% across 14 hours with prod_actual>0.05 kWh.
- 11 of 15 active hours showed >30% deviation. Model consistently under-forecasts on heavy-overcast May days (diffuse light paradox).
- Notable anomaly: 09:00 hour — prod_actual=0 stored in solar_readings, yet energy_snapshots show PV continuing to accumulate (2.1→2.4 kWh between 09:00 and 09:15). The zero is a data artefact from the 08:05 consumptionPipeline flat_fallback warning — the inverter daily counter reset mid-hour causing a near-zero delta read, substituted with flat_watts but PV=0. This is a known reading failure mode, not a real zero-production hour.
- 10:00 hour: forecast 1.56 kWh, actual 5.0 kWh (+221%). Extreme correction_factor 3.20x. Highest single-hour under-forecast of the day. Cloud cover=95% yet production was extremely high (5.0 kWh/h) — extreme diffuse light event.
- 14:00 hour: forecast 1.70 kWh, actual 4.3 kWh (+153%). Correction_factor 2.52x. Second-largest under-forecast.
- Late afternoon (16:00–18:00): actual still 1.6–2.5 kWh/h despite 88–90% cloud cover. Model under-forecasts by 56–68%. Mountain shadow effect was expected but the high cloud cover masked it.
- 20:00: forecast 0.021 kWh, actual 0.10 kWh. Twilight diffuse light production not in model. Expected site behaviour.
- Recency bias: 1.437 at start of day, rising to 1.500 (capped) by evening as actuals exceeded forecasts. Bias rising but not clamping during daytime (raw ratio reaching 1.5x).
- Correction matrix (May, day=12): learnPipeline updates from this day should pull May corrections higher for the 10:00–14:00 heavy-overcast window.

## Battery Schedule & SOC (2026-05-12 — overnight discharge, solar-charge afternoon, passive export evening)
- Starting SOC at 00:00: 59% (from prior day).
- Strategy: Discharge overnight 00:00–07:45 (59%→30% by 07:45), transition to charge_solar 08:00–08:15 (29%→30%), idle 08:30–09:15, charge_solar 09:30–09:45, marginal discharge 10:00–10:15, idle 10:30–12:45, charge_solar 13:15–15:15 (57%→87% then 95%), idle 15:30–16:45 at 100% SOC (passive export window), marginal discharge 17:00–17:45, charge_solar 18:00, idle 18:15–18:45, discharge 19:00–23:45 (95%→71%).
- Battery reached 100% SOC at 15:00 (actual 98%, plan 85.8% — the only deviation ≥8% for the day: +12.2%, positive overshoot). Solar charged faster than plan expected. Battery remained at 100% from 15:00–18:45.
- Mean absolute SOC deviation: 1.70% across 93 paired slots. Outstanding adherence — best result in dataset so far.
- Slots ≥8% deviation: 1 (at 15:00, positive overshoot, harmless). No negative deviations ≥8%.
- No SOC deviation guard activations. No manual overrides. No config.js restarts.
- Zero charge_grid slots — dawn_soc_penalty=0 confirmed to eliminate dawn pre-charge for the third consecutive day.
- Grid import May 12: 4.1 kWh (overnight idle drawing grid to cover load — inverter idle means grid covers house). Grid export: 7.4 kWh (passive export 15:00–18:45 at 100% SOC).
- Total PV May 12: 24.8 kWh. Total load: 20.1 kWh.
- End-of-day SOC: 71% (from 23:45 snapshot). Battery in excellent state for May 13.
- EV detected 3 times: 01:00 (1475W house-only), 05:00 (6575W house-only), 10:00 (10275W house-only — large EV charge event, 11.6 kWh load logged). All EV events correctly excluded from consumption model. EV exclusion count rose from 22 to 23.
- Flat fallback at 09:00: consumptionPipeline substituted flat_watts=800W because the daily counter delta near midnight was near zero. PV=0 logged for this hour. Data artefact, not real.

## Price Optimisation Patterns (SE3, 2026-05-12)
- Price range May 12: 0.807–1.636 SEK/kWh. Average: 1.158 SEK/kWh. Uniformly high all day — no sub-0.80 prices anywhere. This is only the second day in the dataset with a floor above 0.80 SEK (after May 11 floor of 0.978 SEK).
- No cheap overnight charging window. All 97 price slots between 0.807 and 1.636 SEK/kWh.
- Peak evening: 19:30–21:00 at 1.51–1.64 SEK/kWh. Discharge correctly planned for this window.
- LP optimizer correctly: discharged overnight (cost-effective given uniform high prices vs holding SOC), allowed solar to charge battery during the overcast-but-productive afternoon, then discharged again in the expensive evening.
- Savings estimate ranged 7.32 SEK (07:30) to 25.73 SEK (17:30). Settled at 21–26 SEK from 12:30 onward once the solar-charged battery strategy locked in.
- Sell shadow: largely +0.00 extra throughout the day. Peaked at +9.04 SEK at 09:30 (when battery was at 37–39% SOC and solar was active) but declined to +0.00 from 17:30 onward. Sell mode would have added modest value mid-morning. Not enabled.
- Day-ahead prices for May 13: loaded at the first batteryPipeline run that checked (00:30). elprisetjust.nu returned 200 for May 13 from 00:30 onward. May 14 prices not yet available as of 23:30 (elprisetjust 404, nordpool 204 — normal).
- Day-ahead re-optimisation (13:15 trigger): not visibly distinct — May 13 prices were available from 00:30 so every half-hour battery run had full tomorrow data. No separate day-ahead firing needed.

## Modbus / Hardware Observations (2026-05-12)
- Total distinct Modbus error events: 17 (three clusters of ~5–6 errors each, manageable compared to May 7's 175).
- Cluster 1: 03:45–03:46 — ECONNRESET + snapshot TCP timeout + 2x ETIMEDOUT. Execute succeeded (03:46 timestamp slight delay). 1 null-entry snapshot at 03:45.
- Cluster 2: 08:00–08:01 — ECONNRESET + snapshot TCP timeout + 2x ETIMEDOUT. Execute started at 08:00:37 (delayed by 37s) and succeeded. 1 null-entry snapshot at 08:00. consumptionPipeline at 08:05 returned flat_fallback for 09:00 due to near-zero delta (related to this cluster's timing impact on the inverter daily counter read).
- Cluster 3 (worst): 12:15–12:16 — Snapshot "Timed out" + 5x ETIMEDOUT/ECONNRESET + execute TCP timeout → execute FAILED with transient flag. 1 execute cycle missed (12:15 slot). Inverter left in last-written state. Recovery by 12:30 (execute succeeded). 1 null-entry snapshot at 12:00 (null grid/pv fields).
- Isolated event: 22:45 — 1x ETIMEDOUT (non-fatal, execute recovered).
- Total execute failures: 1 (12:15 — transient flagged).
- Total snapshot errors: 3 (03:45, 08:00, 12:15).
- Null-SOC snapshots: 0 (all 98 snapshots had battery_soc populated — excellent).
- Snapshot count May 12: 98 of expected 96 (2 extra from 00:00 prior-day rollover and 00:15 overlap). All 96 standard slots covered. Excellent.
- No lastKnownSoc fallback activations during the May 12 window.
- No "Illegal function" errors.
- dry_run: false (all commands live).
- Max grid export rate: 5.2 kW at 17:30 — EXCEEDS the 4.0 kW max_export_w limit. Warrants investigation (same issue flagged on May 1 at 4.3 kW — this is now 5.2 kW and above threshold more definitively).
- Peak shaving registers not explicitly confirmed in May 12 logs (no peak_shaving log lines visible — confirms summer config import=12kW / export=11kW is still set).
- Process restart: 2 restarts on May 13 at 05:38 and 05:39 (config.js edit). Outside the May 12 audit window but relevant for continuity.

## Consumption Model (2026-05-12)
- n=738→745, R²=0.19, slope=-91 to -93 W/°C, intercept=2287–2294 W. EV exclusions: 22→23 readings.
- Large EV event at 10:00 (10275W) correctly excluded (inverter_delta_ev flag).
- R² stable at 0.19 — not improving but not declining. Temperature model remains weak predictor.
- Recency bias: 1.437 at midnight, 1.500 (max observed) by 20:00 and continuing through end of day. Bias at cap level means model's daily intra-day correction was being pushed to the ceiling.

## Solar Forecast Accuracy Baselines (2026-05-15 — mixed clouds with strong solar clearing afternoon)
- Cloud cover: heavy overnight (66–97%), 62–89% morning (06:00–11:00), dropping 40→6% midday (12:00–15:00), then 0–21% afternoon.
- Total actual production (energy_snapshots pv_today_kwh): 46.2 kWh. Total forecast (solar_readings, 15 active hours 06:00–20:00): 37.05 kWh. Ratio 1.25× (under-forecast day — strong midday PV exceeded model).
- MAE: 1.143 kWh/h across 15 active hours. MAPE: 65.1% (dominated by 06:00 +404% and 13:00 +84%).
- Notable hours >30% deviation: 06:00 (+404%, actual 0.30 vs forecast 0.060 kWh — dawn with cloud), 10:00 (+77%, actual 4.0 vs 2.25 kWh — heavy cloud but strong diffuse), 11:00 (+41%), 13:00 (+84%, actual 7.5 vs 4.08 kWh — best production hour of day), 15:00 (-21%), 17:00 (-27%), 19:00 (-46%), 20:00 (-65%).
- Key finding: 13:00 actual 7.5 kWh was exceptional — this hour coincided with all-day EV charging (all 5 sub-slots showed EV). The actual=7.5 kWh stored in solar_readings likely includes EV load delta and PV combined (consumption=460W house-only, total load 7.2 kWh this hour). This may be a data artefact rather than genuine 7.5 kWh/h PV production. Warrants investigation — the correction_factor of 1.84× stored in the matrix for May day=15 hour=13 is plausible only if actual solar was genuinely that high.
- Mountain shadow expected at 17:00 (forecast 3.31 vs actual 2.40 kWh, -27%) and 19:00 (forecast 0.74 vs actual 0.40 kWh, -46%) — consistent with site behaviour.
- 20:00: forecast 0.285 kWh, actual 0.10 kWh (-65%). Nordic twilight residual — model slightly over-estimates at this marginal hour.
- Correction matrix for May day=15: only 1 sample per hour (first time this calendar day has been observed). Values now stored: correction_avg for hours 07, 09, 12, 13, 14, 15, 16, 17, 18, 19, 20.

## Battery Schedule & SOC (2026-05-15 — overnight discharge + EV session + passive export)
- Starting SOC: 60% at 00:00 (from prior day discharge strategy).
- Strategy: discharge overnight 00:00–07:45 (60%→26% by 06:00), brief charge_grid at 06:00 (26%→36%, price 0.874 SEK — dawn_soc_penalty=0 but optimizer still chose grid charge here), solar charging rapid 09:00–12:45 (34%→95%), battery reached 100% at 13:30, held 100% through 19:15 (passive export window), evening discharge 19:15–23:45 (100%→78%).
- charge_grid at 06:00 despite dawn_soc_penalty=0: This is a new observation. Battery reached 26% by 06:00 which is below min_soc=10% floor but close to it. The optimizer may have inserted this recharge because a heavy discharge slot at 05:45 (1341W at 1.09 SEK) dropped SOC to 26%, and the 06:00 price (0.87 SEK) was relatively cheaper in the local context. Not a dawn_soc_penalty artefact — the charge is driven by local price valley (06:00 is the cheapest slot in the 06:00–07:45 window at 0.87 vs 1.07–1.28 SEK).
- Mean absolute SOC deviation: 2.68% across 90 paired slots. Excellent adherence.
- 9 slots with ≥8% deviation — ALL positive (actual above plan), occurring 10:00–19:00. Pattern: solar charged battery significantly faster than LP plan expected (model used battery schedule assumptions that did not capture actual PV surplus). Largest: 12:00 actual 78% vs plan 59% (+19%). Harmless positive overshoots — battery filled to 100% earlier than planned.
- SOC deviation guard: did NOT fire. All overruns were positive (actual > plan), so guard threshold was not triggered (guard only fires when actual < plan − threshold).
- Manual override: EV-detection auto-charge fired at 21:30 and 21:36 (both executed). EV detected in 21:00 hour. Auto-charge lasted ~20 min, then cleared.
- No negative SOC deviations ≥8% at any slot.
- Grid import May 15: 8.9 kWh (includes 6:00 dawn charge_grid: ~2.0 kWh grid burst at 06:15 when SOC jumped 26→36%, and overnight grid covering house load at idle). Grid export: 2.9 kWh (passive during 100% SOC window 14:00–19:30 at modest 2 kW rate).
- End-of-day SOC: 78% at 23:45.
- Total PV May 15: 46.2 kWh. Total load May 15: 49.9 kWh (high — EV charging all afternoon 11:00–17:00).

## Price Optimisation Patterns (SE3, 2026-05-15)
- Price range: 0.314–1.406 SEK/kWh. Average: 0.969 SEK/kWh. VERY expensive day — floor nearly 0.31 SEK, avg ~1 SEK.
- No cheap overnight window (all night: 0.87–1.09 SEK/kWh). Floor was at 06:00 (0.874 SEK) — the only sub-0.90 slot in the entire day.
- Daytime cheapest: 15:00 (0.314 SEK), 16:00 (0.421 SEK), 13:45 (0.357 SEK). These are unusual — midday was cheap due to solar surplus in the market.
- Peak price: 22:00 (1.406 SEK), 21:00 (1.400 SEK), 18:30–19:45 (1.30–1.37 SEK). Evening peak correctly targeted for discharge.
- LP optimizer savings: 12.52 SEK at midnight, declining to 11.20 SEK at 01:30 as battery discharged. Stable range 11–13 SEK throughout overnight.
- Sell shadow: +8.05 SEK extra at midnight (sell_enabled=false). This is significant — sell mode would have captured material extra revenue on a high-price day with 2.9 kWh passive export. Pattern: sell shadow elevated at +7.9–8.1 SEK throughout all overnight battery runs.
- Day-ahead re-optimisation: May 16 prices available from midnight (battery pipeline at 00:30 had full data). No separate day-ahead trigger visible.
- Optimizer action summary: 96 slots total — ~35 discharge, ~25 idle, ~30 discharge (evening), 1 charge_grid (06:00), 2 charge_solar (15:00 and 16:00 plan — actually battery was at 100% by then so these were artefacts of schedule not tracking actual SOC).

## Modbus / Hardware Observations (2026-05-15)
- Total distinct Modbus error events: ~10 (significantly lower than May 12's 17, much lower than May 7's 175).
- 02:00: 1× ETIMEDOUT unhandled (non-fatal, execute not affected).
- 05:00: execute Timed out → transient flag set, inverter left in last-written state. 1× ETIMEDOUT unhandled. Execute recovered at 05:15.
- 06:15: 1× ETIMEDOUT unhandled (during charge_grid slot — CRITICAL: may have interrupted the charge_grid execution).
- 06:25: execute Timed out + transient flag + ECONNRESET. Execute recovered at 06:30. 06:30 batteryPipeline used lastKnownSoc=32% (Port Not Open fallback).
- 08:30: batteryPipeline lastKnownSoc=48% (Timed out). Execute succeeded this cycle.
- 17:30: execute Timed out → transient flag. Recovered at 17:45.
- 18:30: execute PortNotOpenError → reset to default (non-transient: reset fired, inverter briefly returned to default state before next cycle wrote correct values).
- 21:30: ev_detection override active, applied charge action (2 consecutive cycles).
- Total execute failures: 3 (05:00, 06:25, 17:30 transient — plus 18:30 PortNotOpen with reset).
- lastKnownSoc fallback activations: 2 (06:30 at 32%, 08:30 at 48%). Both during morning solar ramp-up. Values were within plausible range.
- No "Illegal function" errors.
- No sustained outage (contrast with May 7's 12-hour blackout).
- dry_run: false. All commands live.
- Snapshot count: 116 in DB, of which 26 have null battery_soc (all are off-boundary timestamps from config.js restarts creating extra snapshot entries). All 96 standard 15-min boundary slots have SOC populated.
- CRITICAL: 24 config.js restarts over 24h (one approximately every hour). This is abnormal and appears to be a process triggering the config watcher in a loop — NOT user-initiated editing. The debounce is 240,000ms (4 min), yet restarts fired exactly ~60 min apart (matching cron intervals). This is a NEW pattern not seen before. Each restart caused: duplicate fetch pipeline run, duplicate battery run, duplicate consumption run, duplicate execute run, and snapshot boundary offset. The 717 fetch pipeline starts (vs expected 4) directly caused by this restart storm.
- Peak shaving confirmed: import=12 kW, export=11 kW (summer config, set at 00:21 and 01:21 restarts).
- Max grid export rate: 2.0 kW (from 0.5 kWh/15min delta at 18:15). Well within 4.0 kW limit — no export exceedance today.

## Consumption Model (2026-05-15)
- n=789, R²=0.187, slope=-93.2 W/°C, intercept=2261.9 W. EV exclusions: 24+ readings.
- EV detected at 11:00 (1 sub-slot), 13:00 (all 5 sub-slots), 14:00 (all 5), 15:00 (all 4), 16:00 (3 of 5), 17:00 (2 of 4), 21:00 (1 of 4), 23:00 (2 of 5). Heavy EV day.
- House-only consumption well-behaved: 180–2267W (12:00 anomaly at 2267W — see 75-min snapshot boundary offset artefact).
- R²=0.187 stable from prior days. Temperature 5.1–14.4°C throughout day.

## Config Restart Storm — New Issue (2026-05-15)
- 24 config.js restarts observed, approximately one per hour on the hour (:21 past each hour from 00:21 through ~19:31, then at :33, :36, :38 late evening). This matches NO prior audit pattern.
- Prior maximum: 5 restarts (Apr 12 lunchtime cluster). 24 in one day is 5× worse than any prior day.
- The regularity (every 60 min) strongly suggests the config watcher is being triggered by something other than user edits — possibly an external process, cron job, or antivirus touching config.js. The 4-min debounce should prevent double-fires from editor writes, but ~60-min regularity bypasses the debounce.
- Impact: 717 fetch pipeline starts (expected 4), 78 consumption pipeline runs (expected 24), 116 execute starts (expected 96). No data corruption observed but significant CPU waste and excessive API calls to Open-Meteo and met.no.
