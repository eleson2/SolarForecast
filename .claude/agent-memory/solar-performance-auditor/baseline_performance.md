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
- nssm replaces PM2 as the process manager for this installation (observed 2026-04-13).
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
