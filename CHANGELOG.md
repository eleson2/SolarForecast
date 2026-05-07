# Changelog

All notable changes to SolarForecast/Battery Optimizer are recorded here.
Format: date, what changed, and why.

---

## 2026-05-08

### Config — `dawn_soc_penalty: 0` (disabled)
- **Was:** 0.1 (reduced from 0.3 on 2026-05-06)
- **Why:** Penalty was causing optimizer to drain battery to floor overnight, then charge back from grid at expensive dawn prices (0.94–1.36 SEK/kWh). System was cycling charge/discharge instead of coasting. LP optimizer handles solar headroom naturally without this penalty.

---

## 2026-05-06

### Config — `dawn_soc_penalty: 0.3 → 0.1`
- Attempted to reduce aggressive overnight drain. Did not resolve root cause — dawn grid charge still fired at expensive prices.

---

## 2026-05-03

### Feature — YR.no weather integration (`src/yr-fetcher.js`, `src/yr-parser.js`)
- Added YR.no as a supplemental weather source for cloud cover and fog data.
- `cloud_cover_yr` column added to `solar_readings`; used preferentially over Open-Meteo cloud cover in `model.js` (better local accuracy for Norwegian/Swedish sites).
- Fog suppression factor added to model: `fog_suppression_max: 0.90` in config — applied on top of cloud suppression when `fog_area_fraction` is reported.
- Config: `fog_suppression_max: 0.90` added under `learning`.

---

## 2026-05-02

### Feature — Dawn SOC penalty (`src/optimizer-lp.js`, `config.js`)
- Added `dawn_soc_penalty` (0.3) — LP cost term on SOC during 3h pre-sunrise window.
- Intent: nudge optimizer to discharge more before dawn, leaving room for solar.
- Outcome: caused expensive dawn grid charges; rolled back 2026-05-06 → 2026-05-08.

### Feature — `charge_grid_max_buy_price` gate (`src/optimizer-lp.js`, `config.js`)
- Added per-slot price ceiling for grid charging. Currently `null` (inactive).
- When set, prevents grid charging above the specified SEK/kWh threshold.

### Feature — Cloud-irradiance cap (`src/model.js`, `config.js`)
- Caps `prod_forecast` when cloud cover is 30–65% AND irradiance forecast ≥ 400 W/m².
- `cap_factor: 0.80` — at most 80% of clear-sky physics output under these conditions.
- Config: `cloud_irradiance_cap` block added under `learning`.

### Config — `solar_forecast_confidence` and `min_grid_charge_kwh` removed
- These config keys were present but never implemented in `optimizer-lp.js`.
- Removed from config to avoid confusion. Replaced by dawn penalty approach (later reverted).

### Diagnostic — Min-SOC run warning (`src/optimizer-lp.js`)
- Logs a warning when the optimizer plans ≥4h of continuous min-SOC idle.
- Behavioral change: none (diagnostic only).

---

## 2026-04-26

### Feature — EV auto-charge alongside Grid Rewards (`scheduler.js`)
- When Grid Rewards active and EV is detected charging, battery also charges to support EV load.

### Feature — Optimizer data injection for testing (`src/optimizer-lp.js`)
- `options.prices` and `options.solarReadings` allow injecting test data without DB.
- Tests refactored to use injection; startup crash loop fixed.

---

## 2026-04-12

### Feature — Date ranges for peak shaving (`src/peak-shaving.js`)
- Seasonal date ranges configurable for different import/export limits.
- Summer period (1 Apr – late autumn): import 12 kW, export 11 kW.
- Winter period: tighter limits.

---

## 2026-04-02

### Config — `config_reload_debounce_ms: 240000` (4 min)
- Increased debounce from default to prevent double-restart when editors write config twice.

---

## 2026-03-29

### Refactor — Greedy optimizer removed
- `src/optimizer.js` (greedy) deleted. `src/optimizer-lp.js` (HiGHS LP) is sole optimizer.
- `run-compare-optimizers.js` also deleted.
- LP empty schedule → log warning + return early (no fallback).

---

## 2026-03-24

### Feature — EV charging detection and sell mode (`scheduler.js`, `src/optimizer-lp.js`)
- EV load detected via consumption spike above `max_house_w`; tagged `inverter_delta_ev`.
- `sell_enabled` config flag added; optimizer can plan battery→grid export when enabled.
- `sell_price_factor`, `max_export_w`, `transfer_export_kwh` added to config.

---

## 2026-03-19–20

### Feature — Selling / Grid First mode (`src/inverters/growatt-modbus.js`)
- TOU register 3038 used for Grid First mode during sell slots.
- Peak shaving import limit via holding register 3307.

---

## 2026-03-13

### Refactor — LP optimizer introduced (`src/optimizer-lp.js`)
- HiGHS WASM LP solver replaces greedy optimizer.
- Globally optimal 24h charge/discharge schedule.
- SOC deviation guard and manual override API added.

---

## 2026-03-01 (approx)

### Feature — Modbus resilience (`src/inverters/growatt-modbus.js`, `scheduler.js`)
- `withReconnect()` retry wrapper with configurable retries and delay.
- `lastKnownSoc` fallback: last successful SOC read used when Modbus times out.
- Transient errors skip `resetToDefault` — leave inverter in last-written state.
