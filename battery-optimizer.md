# Battery Optimizer — Design Document

## Overview

A module that decides **when to charge, discharge, or sell battery capacity** based on:

- Solar production forecast (from the Solar Forecast module)
- Electricity spot prices (15-min intervals, from pluggable price provider)
- Household consumption estimate (yesterday's actual usage, temperature-adjusted)
- Battery state and constraints

The goal: minimize electricity cost — or maximize revenue — by shifting energy use
across hours. Charge the battery when electricity is cheap or solar is abundant,
discharge when prices peak, and sell capacity back to the grid when profitable.

---

## Implementation Status

| Component                | Status      | Notes                                    |
|--------------------------|-------------|------------------------------------------|
| Design                   | Done        | This document                            |
| Price fetcher            | Done        | `src/price-fetcher.js` — pluggable provider dispatch |
| Consumption estimator    | Done        | `src/consumption.js` — yesterday + temp correction |
| Optimizer engine (LP)    | **Primary (sole optimizer)** | `src/optimizer-lp.js` — HiGHS LP, globally optimal, writes to DB |
| Battery state tracker    | Done        | Integrated in optimizer (SOC forward pass) |
| Inverter integration     | Growatt MIN + MOD done | See [`inverter-integration.md`](inverter-integration.md) — Cloud API + Modbus TCP drivers |
| Live SOC seeding         | Done        | Optimizer accepts `options.startSoc` from inverter; scheduler + CLI read SOC before each run |
| Last-known SOC fallback  | Done        | `lastKnownSoc` in `scheduler.js` — Modbus timeouts no longer reset optimizer to `min_soc` default |
| Solar forecast confidence| Done        | `battery.solar_forecast_confidence` multiplier + `min_grid_charge_kwh` floor prevent solar forecast from crowding out all grid charging. Both are now **cloud-adjusted**: `effectiveConfidence = confidence × (1 − cloud/100)` at runtime; `effectiveMinReserve` scales to 0 kWh at 100% cloud cover (linearly from 80%) so the battery charges more from grid on fully overcast days. |
| SOC deviation guard      | Done        | `executePipeline` compares live SOC to `slots[0].soc_start`; if deficit > `soc_deviation_threshold`: SOC ≥ `soc_replan_min_soc` → triggers replan (price-aware recovery); SOC < `soc_replan_min_soc` → forces `charge_grid` immediately (safety floor) |
| Manual override API      | Done        | `src/override.js` + `GET/POST/DELETE /battery/override` — persists action across 15-min execute cycles |
| Modbus retry logic       | Done        | `withReconnect()` retries up to `modbus_retries` times with `modbus_retry_delay_ms` delay (config-driven) |
| Stale forecast fix       | Done        | `upsertReading` clears `prod_forecast`/`correction_applied` on irradiance update if no `prod_actual` yet; `getReadingsWithoutForecast` always returns future rows so every model run refreshes remaining-day forecasts |
| Hourly model re-run      | Done        | `learnPipeline` calls `runModel()` after the learner updates the correction matrix — ensures intraday corrections flow into remaining hours within ~1h, not up to 6h |
| Hour-boundary fix        | Done        | `getReadingsForForecast` floors `fromTs` to hour start so :15/:30/:45 optimizer runs don't miss the current partial hour's solar data |
| Soft transient reset     | Done        | `executePipeline` skips `resetToDefault` for ETIMEDOUT/ECONNREFUSED — leaves inverter in last-written state |
| Charge/discharge window logging | Done | `logWindows()` groups consecutive slots into time windows with kWh and avg price |
| Cloud-cover suppression  | Done        | `model.js` applies `cloudFactor = 1 - (cloud_cover/100) * cloud_suppression_max` to every forecast hour; `cloud_suppression_max` (default 0.65) is in `config.learning`; at 100% cloud the forecast is scaled to ~35% of the irradiance-only value |
| Solar overflow / export cap | Done       | `optimizer-lp.js`: new `clip_t` slack variable + `ec_t` constraint per surplus slot. LP plans pre-emptive `sell` before high-solar hours to keep battery below full; unavoidable clipping is logged as a warning. No new config needed — uses `config.grid.max_export_w`. |
| Adaptive recency bias cap | Done        | `model.js` `adaptiveClampMax(month)` replaces the fixed `clamp_max` in `config.learning.recency_bias`. Cap interpolates 3.5× (0 matrix samples/cell) → 1.8× (≥20 samples/cell) for the current month's active solar hours. Allows aggressive correction early in the year when the matrix is sparse; auto-tightens as data accumulates. Fixed `clamp_max` in config is no longer used (only `clamp_min` is read). |
| Intra-day solar scalar   | Done        | `batteryPipeline` calls `getIntradaySolarRatio(today)` — ratio of actual-to-forecast for completed daylight hours — and passes it to the optimizer as `options.intradayScalar`; optimizer multiplies remaining-day solar forecast values by this scalar before planning |
| Temporal feasibility correction | Done | After Phase B, a correction loop simulates forward SOC and detects discharge slots that would be cancelled (executed < 50% of planned). It removes the cheapest earlier discharge to free SOC for the higher-value later slot, repeating up to 20 times. Prevents low-margin early discharges (e.g. 0.70 €/kWh at 16:00) from depleting the battery before the price peak (e.g. 1.11 €/kWh at 19:00). |
| Consumption collection   | Done        | `getMetrics()` driver interface; hourly cron stores to `consumption_readings` |
| API / schedule output    | Done        | `src/battery-api.js` — GET /battery/schedule |
| Transfer tariffs         | Done        | Separate import/export transfer fees + energy tax |
| Sell to grid             | Done        | `sell_t` LP variable; `sell_price` in objective; `applySchedule` maps `sell` → `discharge_soc` floor; enabled via `grid.sell_enabled` |
| Peak shaving             | Partial     | Register write API (`POST /battery/control/peak-shaving`) implemented; autonomous optimizer integration (monthly peak tracking + reserve capacity) not started — needs real-time consumption metering |
| EV-aware scheduling      | Done        | `config.ev`: `enabled`, `charge_watts`, `price_threshold_kwh`. `consumptionPipeline` stores house-only `consumption_w` (strips EV load, tags `'inverter_delta_ev'`). LP optimizer: `maxDis` uses house-only consumption so battery never discharges to cover EV; `maxCgW` subtracts `evLoadW(slot)` from the peak-shaving cap so grid-charge headroom correctly accounts for EV draw. |
| LP terminal SOC penalty   | Done        | Soft bonus `−avgBuyPrice×0.1×h/1000 × s_N` in LP objective discourages draining battery at end of 24h window, preventing reactive SOC deviation guard from triggering on next cycle |
| LP noise threshold        | Done        | `NOISE_W` reduced from 50W to 10W — previously suppressed up to 12.5 Wh/slot of valid operations |
| Consumption EV filter     | Done        | `consumptionPipeline`: if `ev.enabled` and total load > `max_house_w`, stores house-only portion (`total − ev.charge_watts`, min 100 W) tagged `'inverter_delta_ev'`. `estimateConsumption` Path 2: if yesterday's reading > `max_house_w` (legacy guard, still active when `ev.enabled=false`), falls back to `flat_watts`. |

---

## LP Optimizer

### Motivation

The greedy algorithm has structural limitations: Phase A pairs charge/discharge slots by price without enforcing temporal ordering (cheap overnight charge can be paired with same-evening discharge, which is physically impossible). Phase B allocates a global energy budget that doesn't account for SOC depletion order. These cause suboptimal plans, which the correction loop only partially fixes.

LP solves all constraints simultaneously and guarantees a globally optimal schedule within the model. First comparison (2026-03-10, SOC 61%): **LP saved 10.5 SEK vs greedy's 5.6 SEK — 87% more savings** — primarily by correctly avoiding unnecessary overnight grid charging that the greedy incorrectly schedules.

### Inputs

The LP optimizer reads from exactly the same DB tables as the greedy optimizer:

| Source | DB call | Used for |
|--------|---------|----------|
| `price_readings` | `getPricesForRange` | `buy_price` objective coefficients; `slot_ts` schedule keys |
| `solar_readings` | `getReadingsForForecast` | `prod_forecast` → solar surplus upper bound per slot; `cloud_cover` → diagnostic log |
| Passed in | `consumptionEstimates` | Consumption per slot; sets discharge upper bound |

Both solar and consumption are hourly; `interpolateTo15Min()` expands each hour into 4 identical 15-min slots before building the LP.

Solar values below `MIN_SOLAR_W = 50 W` are zeroed out to suppress pre-dawn forecast artefacts that would otherwise create spurious free charging headroom in the LP bounds.

The `intradayScalar` (actual/forecast ratio for completed daylight hours) is applied to all remaining solar values, same as the greedy optimizer.

### Formulation

**Variables per slot** `t = 0…N-1` (N = 96 for 24 h):

| Variable | Meaning | Bounds |
|----------|---------|--------|
| `cg_t` | Grid charge power (W) | `[0, max_charge_w]` |
| `d_t`  | Discharge power (W)   | `[0, min(max_discharge_w, max(0, consumption_t − solar_t))]` |
| `cs_t` | Solar charge power (W)| `[0, min(max_charge_w, max(0, solar_t − consumption_t))]` |
| `s_t`  | Battery SOC (Wh)      | `[min_soc_wh, max_soc_wh]`, `s_0` fixed to `startSocWh` |

`d_t` is upper-bounded to the grid deficit only — the LP cannot discharge into a slot where solar already covers consumption (the surplus bound makes `d_t = 0` optimal there regardless, but the explicit bound keeps the problem tight). `cs_t` is non-zero only when solar exceeds consumption.

**Objective** — minimize incremental grid cost:

```
minimize  Σ buy_price[t]  × cg_t   × h/1000
        − Σ buy_price[t]  × d_t    × h/1000
        − Σ sell_price[t] × sell_t × h/1000   [when grid.sell_enabled]
```

where `h = 0.25` (slot duration in hours). Charging costs money; discharging avoids buying at `buy_price`; selling earns `sell_price = spot × sell_price_factor − transfer_export_kwh`.

**Variables per slot** `t = 0…N-1` (N = 96 for 24 h):

| Variable | Meaning | Bounds |
|----------|---------|--------|
| `cg_t`   | Grid charge power (W)      | `[0, max_charge_w]` |
| `d_t`    | Discharge power (W)        | `[0, min(max_discharge_w, max(0, consumption_t − solar_t))]` |
| `cs_t`   | Solar charge power (W)     | `[0, min(max_charge_w, max(0, solar_t − consumption_t))]` |
| `sell_t` | Battery→grid export (W)    | `[0, min(max_export_w, max_discharge_w)]` when `sell_enabled`; else 0 |
| `s_t`    | Battery SOC (Wh)           | `[min_soc_wh, max_soc_wh]`, `s_0` fixed to `startSocWh` |

**SOC continuity** (one equality constraint per slot — no temporal ordering bugs possible):

```
s_{t+1} = s_t + η·h·(cg_t + cs_t) − h·d_t − h·sell_t    ∀t
```

where `η = bat.efficiency` (round-trip charge efficiency). This single set of constraints replaces all of the greedy's Phase A/B/C heuristics and the correction loop.

**Joint discharge limit** (when `sell_enabled`):

```
d_t + sell_t ≤ max_discharge_w    ∀t
```

Mutual exclusion (no simultaneous charge + discharge) is not needed explicitly — round-trip efficiency < 1 makes it always net-negative in the objective, so the solver never chooses both in the same slot.

### Solver

[HiGHS](https://highs.dev) via `highs` npm package (WASM build). MIT licensed, production-grade LP/MIP solver. For 96 slots (≈385 variables, ≈200 equality/bound constraints) it solves in <100 ms.

The HiGHS instance is initialised once at module load and reused across all calls (`optimizer-lp.js` module scope). `output_flag: false` suppresses solver log lines on stdout.

The LP is passed as a string in HiGHS LP file format. If the solver returns `Optimal` or `Feasible`, solution values are read via `result.Columns[varName].Primal`. Values below `NOISE_W = 50 W` are treated as numerical noise and mapped to `idle`.

### Solution parsing → actions

After solving, each slot is assigned one action:

| Condition | Action |
|-----------|--------|
| `cg_t > 50 W` | `charge_grid` |
| `d_t > 50 W`  | `discharge` |
| `cs_t > 50 W` | `charge_solar` |
| otherwise      | `idle` |

SOC values are read directly from the `s_t` variables — no forward simulation needed.

**Charge timing tiebreaker:** When overnight prices are flat, HiGHS may pick a degenerate later charge slot with identical cost. A small epsilon (`avgBuyPrice × 0.005 SEK/kWh`) is added linearly to `cg_t` coefficients, making the solver prefer earlier charge slots among equals. This is 10–40× smaller than any price difference the optimizer would act on, so it cannot override genuine late-night price dips.

**Peak shaving charge rate cap:** When `config.peak_shaving.enabled` is true, the grid import cap (e.g. 4.4 kW) limits how fast the battery can charge from the grid. The LP enforces this per-slot as `cg_t ≤ max(0, peakShavingW[t] − consumption_watts[t])`, matching the physical reality that consumption and charging share the same grid connection. Time-of-day schedule overrides (`peak_shaving.schedule`) are also applied per slot.

### Public interface

```javascript
// async — call with await in scheduler
import { runOptimizer } from './src/optimizer-lp.js';

const { schedule, summary } = await runOptimizer(fromTs, toTs, consumptionEstimates, {
  startSoc: 61,           // live SOC % from inverter (optional)
  intradayScalar: 0.85,   // actual/forecast ratio for today (optional)
  dryRun: true,           // skip DB write (optional, default false)
});
```

`runOptimizer` is `async` — HiGHS loads a WASM module on first call. Call with `await`.

---

## Inputs

### 1. Solar production forecast
From the Solar Forecast module — `GET /forecast` or direct DB access.

```
{ hour: "2026-06-15T12:00", avg_watts: 4200, confidence: 0.92 }
```

### 2. Electricity prices
Spot prices available in **15-minute intervals**, day-ahead. The price fetcher is
pluggable — each provider lives in `src/prices/<name>.js` and exports
`fetchPricesForDate(dateStr, region)`.

#### Implemented providers

| Provider         | Module                       | Markets              | Resolution | Auth   |
|------------------|------------------------------|----------------------|------------|--------|
| `elprisetjust`   | `src/prices/elprisetjust.js` | Nordics (SE/NO/DK/FI) | 15 min   | None   |
| `awattar`        | `src/prices/awattar.js`      | Germany, Austria     | 60 min → 4×15 min | None |

#### Future providers (not yet implemented)

| Market          | Source                        | Resolution   |
|-----------------|-------------------------------|--------------|
| UK              | Octopus Agile / ENTSO-E      | 30 min       |
| US              | Varies by ISO (CAISO, PJM)   | 5–15 min     |

15-minute resolution enables finer optimization than hourly — the optimizer can
shift loads to the cheapest quarter within an hour, which matters when prices
spike briefly (e.g. 17:00–17:15 vs 17:15–17:30 can differ significantly).

### 3. Household consumption estimate

**Two-layer approach: OLS daytime model + yesterday's actuals for nighttime**

**Daytime (08:00–18:00) — `consumption-learner.js`**

A single linear OLS regression is fitted across all daytime readings:
```
consumption_w = slope × outdoor_temp + intercept
```

Heat loss from a building is governed by the indoor/outdoor temperature differential,
not the time of day. One regression line across all daytime hours pools far more data
(11× more samples for the same number of days) than per-hour models would.

Refreshed hourly by `learnPipeline`. Requires ≥ 50 samples (~5 days) before activating.

Readings above `consumption.max_house_w` are excluded from the regression to prevent
EV charging sessions from corrupting the slope. Nighttime hours (19:00–07:00) are
excluded for the same reason — EV charging typically happens overnight.

The fitted slope and intercept are stored in the `consumption_model` table and logged
each run with R². A low R² (< 0.3) triggers a warning — this may be normal when
large variable loads (EV, oven) add uncorrelated variance.

**Nighttime (19:00–07:00) — yesterday's actual readings**

Yesterday's hourly actuals from `consumption_readings` are used directly for overnight
hours, where the temperature model is unreliable and EV charging spikes are excluded
from the regression anyway.

**Fallback**

If the model has fewer than 50 samples or the DB has no yesterday data, falls back
to `config.consumption.flat_watts` as a flat estimate.

### 4. Battery state
From inverter API or manual config:

- Current state of charge (SOC) in %
- Usable capacity in kWh
- Max charge rate in W
- Max discharge rate in W
- Round-trip efficiency (typically 85–95%)

**Live SOC seeding:** The optimizer accepts an optional `options.startSoc` (percentage)
parameter. When provided (from `driver.getState()`), the forward SOC pass starts from
the actual battery level instead of the conservative `min_soc` default. This produces
significantly better schedules when the battery is partially charged — e.g. at 60%
instead of the assumed 10%.

---

## Configuration

```javascript
// config.js (relevant sections)
export default {
    battery: {
        capacity_kwh: 10.0,        // usable capacity
        max_charge_w: 5000,         // max charge rate
        max_discharge_w: 5000,      // max discharge rate
        efficiency: 0.90,           // round-trip efficiency
        min_soc: 10,                // never go below 10%
        max_soc: 95,                // never charge above 95%

        // Solar forecast confidence — fraction of forecasted solar surplus credited when
        // computing how much solar will absorb vs how much headroom to leave for grid charging.
        // 0.7 = apply 30% discount for forecast uncertainty (clouds, seasonal error).
        // Lower = more grid charging as insurance; higher = rely more on solar.
        solar_forecast_confidence: 0.7,

        // Minimum kWh of grid charging headroom to preserve regardless of solar forecast.
        // Prevents large solar forecasts from crowding out all grid charging.
        // Set to 0 to disable and rely solely on the confidence multiplier.
        min_grid_charge_kwh: 4.0,

        // SOC deviation guard — if actual SOC falls this many percentage points below the
        // optimizer's planned soc_start for the current slot, executePipeline responds:
        //   SOC >= soc_replan_min_soc → trigger a full replan (price-aware recovery).
        //   SOC <  soc_replan_min_soc → force charge_grid this slot (safety floor).
        soc_deviation_threshold: 8,
        soc_replan_min_soc: 30,
    },
    grid: {
        sell_enabled: false,         // can sell back to grid?
        sell_price_factor: 0.80,     // % of spot price received when selling
        transfer_import_kwh: 0.05,   // nätavgift import (SEK/kWh)
        transfer_export_kwh: 0.00,   // nätavgift export (SEK/kWh) — often 0
        energy_tax_kwh: 0.36,        // energiskatt (SEK/kWh) — only on import
    },
    consumption: {
        source: 'yesterday',        // 'yesterday', 'profile', 'flat'
        heating_sensitivity: 0.03,  // 3% per degree C
        climate: 'heating',         // 'heating' or 'cooling' — which direction costs more
        flat_watts: 800,            // fallback: average household consumption
        // Maximum expected house consumption without EV charging (watts).
        // Daytime readings above this are excluded from the temperature regression,
        // preventing EV sessions from corrupting the consumption model slope.
        // Rule of thumb: peak heating load + all appliances, but not the EV charger.
        max_house_w: 5000,
    },
    price: {
        source: 'elprisetjust',     // 'elprisetjust' (Nordics) or 'awattar' (DE/AT)
        region: 'SE3',              // Provider-specific region code
        currency: 'SEK',            // Display currency
        day_ahead_hour: 13,         // Hour (UTC) when tomorrow's prices publish
    },
    inverter: {
        // ... connection settings ...
        timeout_ms: 5000,             // Modbus TCP response timeout
        modbus_retries: 3,            // retry attempts on Modbus error (1 = no retry)
        modbus_retry_delay_ms: 4000,  // delay between retries in ms
    },
    ev: {
        enabled: false,
        charge_watts: 5520,          // 3-phase 8A 230V
        price_threshold_kwh: 0.05,   // below this spot price, assume EV is charging
    }
}
```

---

## Core Logic

### The optimization problem

For each 15-min slot in the next 24 hours, decide one of:

- **Charge from solar** — free energy, store excess production
- **Charge from grid** — buy cheap electricity now, use later
- **Discharge to house** — avoid buying expensive electricity
- **Sell to grid** — export stored energy at high prices
- **Idle** — do nothing, let solar cover consumption directly

### Decision factors per hour

```
net_production = solar_forecast - consumption_estimate    (watts)
buy_price      = spot_price + transfer_import + energy_tax  (per kWh)
sell_price     = spot_price × sell_factor − transfer_export (per kWh)
```

---

## Database

### `consumption_readings` — one row per hour
Tracks actual household consumption for the "yesterday" model.

```sql
CREATE TABLE consumption_readings (
    hour_ts         DATETIME PRIMARY KEY,
    consumption_w   REAL,             -- actual consumption in watts
    outdoor_temp    REAL,             -- °C, for temperature correction
    source          TEXT              -- 'inverter', 'meter', 'computed', 'estimate'
);
```

### `price_readings` — one row per 15-minute slot
Stores spot prices at 15-minute resolution.

```sql
CREATE TABLE price_readings (
    slot_ts         DATETIME PRIMARY KEY,  -- e.g. "2026-06-15T17:15"
    spot_price      REAL,                  -- per kWh, in local currency
    region          TEXT
);
```

### `battery_schedule` — one row per 15-minute slot
The optimizer's output. 15-minute resolution matches price data and allows
finer control over charge/discharge timing.

```sql
CREATE TABLE battery_schedule (
    slot_ts         DATETIME PRIMARY KEY,  -- 15-min slot
    action          TEXT,                  -- idle, charge_solar, charge_grid, discharge, sell
    watts           REAL,
    soc_start       REAL,
    soc_end         REAL,
    price_kwh       REAL,
    solar_watts     REAL,
    consumption_watts REAL
);
```

---

## Output

### Schedule API

```
GET /battery/schedule
```

```json
{
  "generated_at": "2026-06-15T06:00:00Z",
  "timezone": "Europe/Stockholm",
  "schedule": [
    {
      "hour": "2026-06-15T07:00",
      "action": "charge_grid",
      "watts": 5000,
      "price_kwh": 0.12,
      "solar_watts": 800,
      "consumption_watts": 600,
      "soc_start": 20,
      "soc_end": 70
    },
    {
      "hour": "2026-06-15T18:00",
      "action": "discharge",
      "watts": 3000,
      "price_kwh": 1.85,
      "solar_watts": 0,
      "consumption_watts": 1200,
      "soc_start": 90,
      "soc_end": 60
    }
  ],
  "summary": {
    "estimated_cost_without_battery": 12.50,
    "estimated_cost_with_battery": 7.20,
    "estimated_savings": 5.30
  }
}
```

### Actions

| Action          | Meaning                                      |
|-----------------|----------------------------------------------|
| `idle`          | No battery action, solar covers load or buy from grid |
| `charge_solar`  | Store excess solar production                |
| `charge_grid`   | Buy from grid to charge battery              |
| `discharge`     | Power house from battery instead of grid     |
| `sell`          | Export battery energy to grid                |

---

## Scheduler

```
When day-ahead prices available → run optimizer, produce 24h schedule
Every 1 hour                   → re-optimize remaining hours with updated SOC
```

Day-ahead prices publish at different times per market — configured via
`config.price.day_ahead_hour` (UTC). The scheduler triggers 15 minutes after
that hour, then re-optimizes hourly as actuals deviate from forecast.

---

## Architecture

```
(integrated into the main SolarForecast project)
src/
├── price-fetcher.js          # Thin dispatcher — routes to price provider
├── prices/
│   ├── elprisetjust.js       # Nordics: elprisetjustnu.se (15-min)
│   └── awattar.js            # DE/AT: aWATTar API (hourly → 4×15-min)
├── inverters/                # Pluggable inverter drivers
│   ├── growatt.js            # Growatt cloud REST API (MIN/MIX series)
│   └── growatt-modbus.js     # Local Modbus TCP (MOD TL3-XH) — primary driver
├── consumption.js            # Consumption estimator: OLS model (day) + yesterday (night)
├── consumption-learner.js    # Fits OLS regression from consumption_readings
├── optimizer-lp.js           # LP optimizer: HiGHS-based global optimizer (sole optimizer)
├── override.js               # Persistent manual override state
└── battery-api.js            # Express endpoints: schedule, history, override, control
```

---

## Price Provider Configuration Examples

### Sweden (default)
```javascript
price: {
    source: 'elprisetjust',
    region: 'SE3',           // SE1–SE4
    currency: 'SEK',
    day_ahead_hour: 13,      // Nord Pool publishes ~13:00 CET
},
```

### Germany
```javascript
price: {
    source: 'awattar',
    region: 'DE',
    currency: 'EUR',
    day_ahead_hour: 13,
},
```

### Austria
```javascript
price: {
    source: 'awattar',
    region: 'AT',
    currency: 'EUR',
    day_ahead_hour: 13,
},
```

---

## Adding a New Provider

Create `src/prices/<name>.js` exporting one function:

```javascript
/**
 * @param {string} dateStr  - "YYYY-MM-DD"
 * @param {string} region   - Provider-specific region code
 * @returns {Promise<{ prices: Array<{slot_ts, spot_price, region}>, raw: any } | null>}
 */
export async function fetchPricesForDate(dateStr, region) { ... }
```

Requirements:
- Return `null` when prices aren't available yet (e.g. 404).
- `slot_ts` must be `"YYYY-MM-DDTHH:MM"` in the configured timezone.
- `spot_price` must be per kWh in the local currency.
- Output exactly 96 slots (4 per hour × 24 hours). If the API returns hourly data,
  expand each hour into 4×15-min slots with the same price.
- Include raw API response in `raw` for archiving.

Then add the filename (without `.js`) to `config.price.sources`. Sources are tried in order — the first to return data wins. No other changes needed — `src/price-fetcher.js` loads providers dynamically by convention.

### Built-in providers

| File | Source | Auth | Resolution | Notes |
|------|--------|------|------------|-------|
| `elprisetjust.js` | elprisetjustnu.se | None | 15-min native | Default primary; hobby project, no SLA |
| `nordpool.js` | dataportal-api.nordpoolgroup.com | None | Hourly → 4×15-min | Unofficial endpoint; no ToS guarantee |
| `energidataservice.js` | api.energidataservice.dk (Energinet/Danish TSO) | None | Hourly → 4×15-min | **Not suitable as primary/fallback for SE3** — Elspotprices dataset stopped updating Oct 2025; kept for DK regions if resumed |
| `awattar.js` | api.awattar.de/at | None | Hourly → 4×15-min | DE/AT markets only |

---

## Data Flow

```
Solar Forecast ─────┐
                     │
Electricity Prices ──┼──→ Optimizer ──→ 24h Schedule ──→ Inverter Driver ──→ Hardware
                     │    (startSoc)                      (slot merge +      (Growatt,
Yesterday's Usage ───┤        ▲                            apply)            SolarEdge,
Outdoor Temperature ─┤        │                                              Huawei, …)
Battery SOC ─────────┘        │                                                │
                              │      ◄── SOC feedback (getState) ◄─────────────┤
                              │                                                │
                              ├── consumption_readings ◄── getMetrics() ◄──────┤
                              │                                                │
                              └── solar_readings.prod_actual ◄── solar_w ◄─────┘
                                        │
                                        ▼
                                   learner → correction_matrix → model (forecast improves)
```

---

## Consumption Collection Pipeline

The `consumptionPipeline()` in `scheduler.js` collects real household consumption
from the inverter and stores it in `consumption_readings` for the "yesterday"
estimator to use.

### Interface

Drivers that support telemetry export a `getMetrics(driverConfig)` function
(optional — see [`inverter-integration.md`](inverter-integration.md)). It returns:

```javascript
{
  soc: number,            // battery SOC %
  battery_w: number,      // charge (+) / discharge (−) watts
  grid_import_w: number,  // watts drawn from grid
  grid_export_w: number,  // watts sent to grid
  solar_w: number,        // PV production watts
  consumption_w: number,  // household load watts
}
```

### Schedule

- **Cron:** `5 * * * *` (hourly at :05, avoids collision with learner at :00 and optimizer at :30)
- **Also runs on startup**

### Data flow

```
Inverter ──getMetrics()──→ consumptionPipeline()
                              │
                              ├── consumption_w ──→ upsertConsumption(hour_ts, watts, temp, 'inverter')
                              │                         │
                              │                         ▼
                              │                    consumption_readings table
                              │                         │
                              │                         ▼
                              │                    estimateConsumption() → "yesterday" model
                              │
                              ├── solar_w ──→ updateActual(hour_ts, kW)
                              │                    │
                              │                    ▼
                              │               solar_readings.prod_actual
                              │                    │
                              │                    ▼
                              │               learner → correction_matrix → smoother
                              │               (production learning loop — see design.md)
                              │
                              └── outdoor temp ◄── Open-Meteo current endpoint
```

### Fallback

If the driver doesn't implement `getMetrics()` (`typeof driver.getMetrics !== 'function'`),
the pipeline is silently skipped. The consumption estimator falls back to flat watts
from config, as before.

---

## Modbus TCP Steering — SOC Buffer Control

### Overview

The `growatt-modbus` driver (`src/inverters/growatt-modbus.js`) communicates with the
inverter directly over Modbus TCP on the local network, replacing the cloud API used by
the `growatt` driver. This provides:

- **Low latency** — <100ms vs 1-5s cloud round-trip
- **No internet dependency** — works offline
- **Simple control** — single register write instead of 9 time segments

### How it works

Instead of managing time segments (the cloud API approach), the Modbus driver uses
**SOC buffer control** via a single holding register:

- **Holding register 3310** (`LoadFirstStopSocSet` / reserved SOC for peak shaving) —
  the SOC percentage at which the battery stops discharging to the load. The inverter
  is always in "Load First" mode; this register acts as the discharge floor.
  (Holding register 808 is a mirror. Growatt V1.24 doc says 3082, which doesn't work.)

The `applySchedule()` function translates optimizer actions to a target SOC value:

| Optimizer action         | SOC target                  | Effect                           |
|--------------------------|-----------------------------|----------------------------------|
| `charge_grid` / `charge_solar` | `charge_soc` (default 90%) | High floor → battery charges     |
| `discharge` / `sell`     | `discharge_soc` (default 20%) | Low floor → battery discharges |
| `idle`                   | Current SOC                 | Holds current level              |

This runs every 15 minutes (via `executePipeline` in the scheduler), so the SOC floor
is continuously adjusted to match the current optimizer slot.

### Telemetry

The driver reads telemetry from three input register groups:

1. **Input registers 0–52** — Group 1: PV power, AC output, grid voltage/frequency
2. **Input registers 3021–3022** — Grid import power (one of the few working storage registers)
3. **Input registers 3169–3171** — BMS: battery voltage, current, SOC

Note: most storage input registers (3000–3040) return zeros on this datalogger.
Battery data comes from the BMS range (3169+) instead of the documented 3009–3014.

### Configuration

```javascript
inverter: {
    brand: 'growatt-modbus',
    host: '192.168.1.XXX',     // datalogger IP on local network
    port: 502,                  // Modbus TCP port
    unit_id: 1,                 // Modbus slave address
    dry_run: true,              // true = log only, false = write registers
    charge_soc: 95,             // SOC target for charge actions
    discharge_soc: 13,          // SOC floor for discharge actions
},
```

Set `dry_run: true` initially. When logs confirm correct behavior, switch to `false`.

### Connection management

The driver maintains a lazy singleton TCP connection with automatic reconnect.
A 1-second throttle between Modbus commands prevents overwhelming the datalogger.

Modbus operations run inside `withReconnect(fn)`, which retries up to `modbus_retries`
times (config-driven, default 3) with `modbus_retry_delay_ms` delay (default 4 s) between
attempts. The TCP client is destroyed and recreated on each retry to avoid stale state.
After all retries are exhausted, the error propagates to the caller.

### Transient error handling

When `executePipeline` catches a Modbus error:

- **Transient** (`ETIMEDOUT`, `ECONNREFUSED`, `timed out`): the inverter likely continued
  operating on the last-written register value. The pipeline logs a warning and exits
  **without** calling `resetToDefault` — interrupting an active charge/discharge for no
  reason would be worse than leaving the inverter alone.
- **Hard protocol errors**: `resetToDefault` is called as before.

### Last-known SOC fallback

`scheduler.js` maintains a module-level `lastKnownSoc` variable updated on every successful
`driver.getState()` call in both `batteryPipeline` and `executePipeline`. When a Modbus
timeout occurs, the optimizer uses `lastKnownSoc` instead of falling back to the pessimistic
`min_soc` default — which would otherwise cause the solar surplus calculation to assume
a nearly-empty battery and block all grid charging.

---

## Manual Override API

A persistent override keeps the inverter in a fixed mode for a requested duration,
surviving multiple 15-minute execute cycles.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/battery/override` | Get current override status |
| `POST` | `/battery/override` | Set override: `{ action, duration_minutes }` |
| `DELETE` | `/battery/override` | Cancel active override |

Valid actions: `charge`, `discharge`, `idle`. Duration: 1–1440 minutes.

### Behavior

- On `POST`: the driver action is applied immediately, then an in-memory expiry is set in
  `src/override.js`. Each `executePipeline` run checks `getOverride()` first — if active,
  it applies the override action and returns early (skipping schedule dispatch).
- Overrides expire automatically when `expires_at` is reached.
- Use the override for manual testing or emergency situations. For normal automation, rely on
  the schedule.

### SOC Deviation Guard

In addition to the manual override, `executePipeline` includes an automatic reactive
correction. When actual SOC falls more than `soc_deviation_threshold` below the planned
curve, the response depends on how much charge remains:

```
deficit = slots[0].soc_start − state.soc

if deficit > soc_deviation_threshold:
    if state.soc >= soc_replan_min_soc:
        → trigger batteryPipeline immediately (price-aware recovery)
    else:
        → force current slot to charge_grid (safety floor — battery too low to wait)
```

**Above `soc_replan_min_soc` (default 30%):** a full replan runs immediately so the
optimizer can choose the cheapest upcoming slot to recover — avoiding expensive grid
charging when cheaper prices are imminent.

**Below `soc_replan_min_soc`:** the current 15-min slot is overridden to `charge_grid`
regardless of price. The battery is too low to be selective; the next hourly
`batteryPipeline` re-plans from the recovered SOC.

Configurable via `config.battery.soc_deviation_threshold` (default: 8 %) and
`config.battery.soc_replan_min_soc` (default: 30 %).

---

## EV Charging

EV charging is controlled externally by the electricity supplier, which activates
the charger in two scenarios: (1) spot price below a threshold (cheap grid energy),
(2) grid-support events (excess supply — user is reimbursed for consumption). Both
result in the EV consuming power that flows through the home meter.

### Config

```js
ev: {
    enabled: false,
    charge_watts: 5520,         // 3-phase 8A 230V = 5520 W
    price_threshold_kwh: 0.05,  // below this spot price, assume EV is charging
}
```

### Historical data cleaning (`consumptionPipeline`)

When `ev.enabled` and `total_load_w > consumption.max_house_w`, the pipeline stores
the house-only portion (`total − ev.charge_watts`, min 100 W) in `consumption_w` and
tags `source = 'inverter_delta_ev'`. This keeps the consumption model clean without
a DB schema change.

### LP optimizer — EV-aware bounds (`optimizer-lp.js`)

The house battery must **not** discharge to cover EV load — EV draws directly from
the grid. This is enforced via two separate LP bounds:

- **`maxDis`** uses `house_consumption_watts` only (i.e. `consumption_watts` from
  `estimateConsumption`, which is already house-only). Battery discharge is bounded
  to `max(0, house − solar)` — it cannot be planned to supply the EV.
- **`maxCgW`** uses `psLimit − house_consumption − ev_load_w`. The `ev_load_w` is
  computed by `evLoadW(slot)` in the optimizer: returns `ev.charge_watts` when
  `slot.spot_price < ev.price_threshold_kwh`, else 0. This ensures the peak-shaving
  cap correctly accounts for the EV's grid draw, leaving the right headroom for
  house-battery charging.

### Peak shaving interaction

During EV charging, total draw is `house_load + ev.charge_watts ≈ 6-7 kW`. The
default peak-shaving limit (4.4 kW) would set `max_cg_w = 0`, blocking house-battery
grid charging during the same cheap slots. Raise `peak_shaving.schedule` for those
hours:

```js
peak_shaving: {
    enabled: true,
    default_kw: 4.4,
    schedule: [
        { from: '00:00', to: '06:00', limit_kw: 12 },  // EV + house + battery
    ],
}
```

---

## Peak Shaving — Design (v2)

### Problem

Many Swedish DSOs charge a monthly **peak power fee** (effektavgift) based on
the highest single-hour average power drawn from the grid during the month.
Typical tariffs: 40–80 SEK/kW/month. A 10 kW peak costs 400–800 SEK/month.

The battery can reduce peaks by discharging during high-consumption moments,
even when spot prices are low — the peak fee savings can outweigh the
spot-price arbitrage loss.

### Data model

New table `peak_readings`:
```sql
CREATE TABLE peak_readings (
    month       TEXT PRIMARY KEY,  -- "YYYY-MM"
    peak_w      REAL,              -- highest hour-average import watts this month
    peak_hour   DATETIME,          -- when the peak occurred
    updated_at  DATETIME
);
```

### Config

```javascript
grid: {
    // ... existing fields ...
    peak_fee_kw_month: 0,       // SEK/kW/month — 0 disables peak shaving
    peak_window_hours: [7,8,9,17,18,19],  // hours when peaks typically occur
},
```

### Algorithm — adaptive peak target

1. Track the current month's observed peak import power
2. At each optimization run, compute a **peak target** = current_peak × 0.95
   (try to stay below current peak, with margin)
3. For slots where consumption > peak_target:
   - Reserve battery capacity for discharge during those slots
   - Even if spot price is low — peak fee savings justify it
4. The cost of a new peak kW = `peak_fee_kw_month`
   - Added to the "virtual buy price" of high-consumption slots
   - Makes the optimizer prefer discharging to avoid setting new peaks

### Integration with optimizer

The peak shaving layer integrates with the LP optimizer:
1. Identify slots where forecast consumption exceeds peak_target
2. Mark those slots as mandatory discharge (regardless of spot price)
3. Reserve battery Wh for those slots
4. LP optimizes remaining capacity across the full horizon

### What is implemented

The register write is live: `POST /battery/control/peak-shaving` calls
`driver.setPeakShavingTarget(limit_kw)` which writes to holding register 800.
The scheduler also writes the configured `peak_shaving.default_kw` value on startup
and can apply time-of-day schedule overrides.

### What is not yet implemented

The **autonomous optimizer integration** — tracking the monthly peak, reserving
battery capacity for peak-shaving slots, and incorporating peak fee savings into
the pairing algorithm — is not started. This requires reliable real-time grid
import readings (available via Modbus input 3021–3022) to track intra-hour peaks.

---

## Roadmap — Next Features

Three features are planned for the LP optimizer. This section describes the architecture for each. Implementation tasks are in `todo.md`.

---

### Feature A — Sell Energy (LP)

**Goal:** when spot price is high enough to exceed the round-trip cost and sell tariff discount, the LP should choose to export battery energy to the grid rather than just discharging to cover house load.

**LP changes:**

Add a new variable `sell_t` (W) per slot — battery power exported to grid:

```
New variable:   0 ≤ sell_t ≤ max_export_w   (only if sell_enabled and sell_price[t] > 0)
SOC continuity: s_{t+1} = s_t + η·h·(cg_t + cs_t) − h·d_t − h·sell_t
Joint limit:    d_t + sell_t ≤ max_discharge_w   (inverter discharge limit)
Objective:      minimize  Σ buy·cg·h/1000  −  Σ buy·d·h/1000  −  Σ sell_price·sell·h/1000
```

`sell_price[t]` is already computed per slot in the LP slot-building code but not used in the objective. `d_t` remains bounded by the grid deficit (`consumption − solar`) — it represents battery covering house load. `sell_t` is bounded by `max_export_w` (hardware export cap, separate from discharge limit).

**Config additions:**

```javascript
grid: {
  sell_enabled: true,         // already exists
  sell_price_factor: 0.80,    // already exists
  transfer_export_kwh: 0.50,  // already exists
  max_export_w: 4000,         // NEW — hardware grid export cap
}
```

**Note:** direct solar export (solar → grid when battery full) is not modelled — the inverter handles it automatically. The LP only controls battery-sourced export.

**Solution parsing:** if `sell_t > NOISE_W`, action = `sell`. Priority: `charge_grid` > `discharge` > `sell` > `charge_solar` (a slot can only hold one action — the LP naturally won't combine them due to cost structure).

**Savings summary:** subtract sell revenue: `costWith -= sell_t × h/1000 × sell_price[t]`.

---

### Feature B — Time-varying Peak Shaving Limit

**Goal:** the peak shaving power cap written to inverter register 800 (`PeakShavingPower`) has a configurable default (4.5 kW) that applies at all times. During defined time windows (e.g. at night when loads are low or EV is charging) a different limit is applied, then the default is automatically restored when the window ends.

**Current state — already mostly implemented:**

`scheduler.js` already contains `getPeakShavingLimit(psConfig, slotTs)` which returns `entry.limit_kw` when `slotTs` falls within a schedule window, or `psConfig.default_kw` otherwise. `executePipeline` (every 15 min) calls `setPeakShavingTarget(psLimit, cfg)` → writes register 800. The config has `peak_shaving.schedule` with the correct `{ from, to, limit_kw }` structure and the validator already checks all fields. The feature is currently **disabled** (`enabled: false`). The `default_kw` (4.4 kW) and schedule example entries are already correct in config.

**What still needs doing:**

The only config change needed is setting `enabled: true`. The `default_kw: 4.4` and the commented-out schedule examples are already correct.

**Midnight-spanning windows:** the validator enforces `from < to`, so a window crossing midnight must be split into two entries (e.g. `23:00–23:59` and `00:00–06:45`). Either document this limitation clearly or fix the validator and `getPeakShavingLimit` to handle overnight spans natively.

**Startup write:** `executePipeline` writes the limit every 15 min, but on cold start there is up to a 15-minute gap before the first write. The app should write the schedule-appropriate limit immediately on startup when `enabled: true`.

**No LP or DB changes required.** The peak shaving limit is a hardware-level grid import cap enforced by inverter firmware, independent of the battery schedule. The LP does not model register 800.

---

### Feature C — EV Charging Recognition

**Status: Done.** See the "EV Charging" section for the implemented design.

Detection is price-based (no DB schema change, no API needed): the supplier activates
EV charging at low/negative spot prices, both of which are already in `price_readings`.
`consumptionPipeline` strips the EV load from historical readings; `estimateConsumption`
overlays expected EV load on future cheap-price slots before passing to the LP optimizer.

---

### Recommended implementation order

1. **Feature A (Sell)** — pure LP formula change, no DB/API work, most self-contained
2. **Feature B (peak shaving schedule)** — mostly already implemented; enable in config + startup write + midnight-window fix
3. **Feature C (EV)** — Done

---

## Solar Overflow / Export Cap (Summer Design)

### Problem

In summer, peak PV production (up to 7 kW) can exceed house consumption (0.3–0.8 kW) + grid export cap (4.0 kW). When the battery is full or near-full, the inverter clips PV output to enforce the export cap, wasting potentially 1–3 kWh/day.

**Example:** solar 6 kW, house 0.5 kW, battery full → export attempt 5.5 kW → inverter clips to 4.0 kW → **1.5 kW wasted**.

The current LP optimizer has no awareness of the export cap. It fills the battery to `max_soc` and then has no plan for what happens to the remaining solar.

The export cap applies to both import and export (same peak power cost), so the constraint is symmetric.

---

### Why Pre-Emptive Discharge Helps

If the battery is partially discharged *before* peak solar hours, it has headroom to absorb the surplus that would otherwise be clipped:

```
Battery at 60% (not 95%) at 10:00
→ Solar 6 kW, house 0.5 kW, battery absorbs 5.5 kW at max_charge_w
→ Grid export: 0 kW  ← no clipping, no peak violation
```

The LP already knows how to plan discharge/sell before expensive periods. The missing piece is a constraint that makes the optimizer *see* the export limit as a reason to discharge earlier.

---

### LP Solution: Export Constraint + Clip Slack Variable

**New variable per slot:** `clip_t ≥ 0` (W) — solar energy that cannot be absorbed and exceeds the export cap (unavoidably wasted).

**New constraint** (surplus slots only, where `solar_t > consumption_t`):

```
solar_surplus_t − cs_t + sell_t − clip_t  ≤  max_export_w
```

Where:
- `solar_surplus_t = solar_t − consumption_t` (W, known parameter)
- `cs_t` = solar→battery charge (existing decision variable)
- `sell_t` = battery→grid discharge (existing decision variable)
- `clip_t ≥ 0` = slack — clipped solar (new variable)

**Objective penalty for clipping:**

```
+ sell_price[t] × h/1000 × clip_t   (added to minimise objective)
```

Clipping is penalised at the sell price of that slot — the LP loses exactly the revenue it would have earned by selling that solar. This makes pre-emptive discharge economically attractive whenever the avoided clipping revenue exceeds the cost of discharging earlier at a lower price.

**Why a slack variable (not a hard constraint)?**

A hard `≤ max_export_w` constraint becomes infeasible when the battery is unavoidably full (e.g., already at `max_soc` with no prior discharge opportunity). The slack `clip_t` keeps the LP always feasible while still incentivising the optimizer to avoid clipping wherever possible.

---

### LP Constraint Mechanics

**Case 1 — Battery has room (`cs_t > 0` possible):**
The constraint forces `cs_t − sell_t ≥ solar_surplus_t − max_export_w`.
Battery absorbs the overflow. `clip_t = 0`. No revenue lost.

**Case 2 — Battery full (`cs_t = 0` due to SOC bound), avoidable:**
Before this slot, the LP plans `sell_t` actions to lower SOC, creating room. At the high-solar slot, `cs_t > 0` because the battery has headroom again.

**Case 3 — Unavoidable (battery full all day, no prior discharge possible):**
`clip_t > 0`. LP accepts the loss but minimises it. This handles edge cases (e.g., consecutive high-solar days with no overnight discharge opportunity).

---

### Interaction with Existing Variables

| Variable | Behaviour change |
|----------|-----------------|
| `cs_t` | Upper bound unchanged. Now also implicitly constrained by export cap when `sell_t = 0` |
| `sell_t` | Now economically motivated to create headroom before high-solar hours, not just by price arbitrage |
| `d_t` | Unchanged — discharge to house not relevant in solar surplus slots (`maxDis = 0` when solar > consumption) |
| `s_t` | Will now stay below `max_soc_wh` before predicted overflow hours instead of filling completely |

No new config parameters needed — `config.grid.max_export_w` (already `4000`) is used.

---

### Energy Balance Check

SOC continuity constraint is **unchanged** — `clip_t` is solar that never reaches the battery or grid; it's clipped at the inverter before any energy exchange. Only `cs_t` and `sell_t` flow through the battery.

---

### Known Limitations

**1. CC/CV charge taper (BMS behaviour near full charge)**
The LP assumes `max_charge_w = 7500 W` is available at all SOC levels. In reality, the BMS tapers charge current above ~85% SOC. This means even when the LP says `cs_t = 5 kW`, the actual charge rate may be 2–3 kW near the top, causing the battery to fill more slowly than planned and export to spike before the LP expected.

*Mitigation:* Lower `config.battery.max_soc` from 95% to 88% in summer. This creates a structural 7% × 15 kWh = 1.05 kWh of natural headroom and keeps the battery in the linear CC region where charge rate is more predictable.

**2. Forecast accuracy**
Pre-emptive discharge depends on the solar forecast being accurate. If the forecast underestimates (as seen in the audit, 2× ratio in early spring), the LP won't see the overflow coming and won't plan discharge. The intraday re-optimisation loop (triggered when actual/forecast ratio > 1.8×) partially mitigates this by replanning mid-morning once actuals show the day will be sunny.

**3. Same-day replanning latency**
The export constraint helps most when planned 12–24h ahead (overnight plan). If a clear day wasn't forecast, the intraday replan may have too little time to fully discharge the battery before peak solar. Pre-emptive sell at 08:00–09:00 (low prices) may be economically marginal.

---

### Implementation Plan

1. **`src/optimizer-lp.js`** — Add per-surplus-slot:
   - `clip_t` variable with bound `0 ≤ clip_t ≤ solar_surplus_t` (can't clip more than production)
   - Constraint: `- cs_t + sell_t - clip_t ≤ max_export_w - solar_surplus_t`
   - Objective term: `+ sell_price[t] × h/1000 × clip_t`
   - Log total predicted clipping (kWh) after solve

2. **`config.js`** — Consider adding `battery.max_soc_summer` (e.g. 88%) with a seasonal selector in the optimizer, or simply lower `max_soc` manually in June.

3. **`battery-optimizer.md`** — Move this section from design to implementation status once built.

---

## Future Considerations

- **Multi-day optimization** — look ahead 48h when prices are volatile
- **Grid capacity selling** — participate in frequency regulation markets
- **EV charging pattern prediction** — auto-detect typical charge schedule from history (phase 2 of Feature C)
- **Vehicle-to-grid (V2G)** — use EV battery as additional storage
- **Dashboard** — visualize schedule, savings, and battery state over time
