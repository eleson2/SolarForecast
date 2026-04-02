---
name: baseline_performance
description: Observed performance baselines for solar forecast accuracy, pipeline health, and hardware behaviour (last updated 2026-03-31)
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
