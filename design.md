# Solar Forecast System — Design Document

## Project Vision

This project has two parts:

1. **Solar Forecast** (this document) — predict solar production hourly over a 24-hour horizon.
   Open source, useful to anyone with solar panels. **Done.**
2. **Battery Optimizer** ([battery-optimizer.md](battery-optimizer.md)) — use solar forecast +
   electricity prices to plan when to charge, discharge, or sell battery capacity.
   **Implemented** — greedy optimizer, price fetcher, consumption estimator, inverter control (Growatt cloud API + Modbus TCP).

## Overview

A Node.js system that predicts solar power generation on an hourly basis for a 24-hour horizon.
It starts with a physics-based estimate, then continuously learns from actual production data
to build an empirical correction model that captures installation-specific behaviour —
panel angles, local shadowing from trees, and seasonal effects.

The output is a simple API: **forecasted average watts for each of the next 24 hours.**
Battery charge/discharge optimization is handled by the Battery Optimizer module.

---

## Implementation Status

| Component          | Status      | Notes                                              |
|--------------------|-------------|----------------------------------------------------|
| Project setup      | Done        | ESM, dependencies installed                        |
| `config.js`        | Done        | User-editable, timezone-aware                      |
| `src/db.js`        | Done        | Schema init, seeding, all query helpers             |
| `src/fetcher.js`   | Done        | Open-Meteo fetch, raw JSON archival                |
| `src/parser.js`    | Done        | Decoupled from source format                       |
| `src/model.js`     | Done        | Geometry fallback + empirical blending             |
| `src/learner.js`   | Done        | Incremental weighted average updates               |
| `src/smoother.js`  | Done        | Gaussian kernel, year-wrap, production weighting   |
| `src/api.js`       | Done        | `GET /forecast` endpoint                           |
| `src/timeutils.js` | Done        | Timezone-safe timestamp parsing from DB strings    |
| `scheduler.js`     | Done        | Cron orchestration + Express server                |
| `run-once.js`      | Done        | One-shot pipeline, writes `data/forecast.json`     |
| Fallback strategy  | Not started | Use previous irradiance when API is unavailable    |
| Actuals ingestion  | Done        | `snapshotPipeline` polls daily energy totals every 15 min; `consumptionPipeline` derives hourly deltas → `prod_actual` + `consumption_readings` |
| Modbus TCP driver  | Done        | `growatt-modbus` — local Modbus TCP for MOD TL3-XH, SOC buffer control |
| Data-collection mode | Done      | `config.inverter.data_collection_only = true` disables inverter dispatch; all data collection continues |
| Yesterday PV fallback | Done     | `model.js` seeds correction factor from last recorded actual for the same hour when matrix is empty |

---

## Goals

- 1-hour resolution, 24-hour forecast horizon
- Forecast updated every 6 or 12 hours
- Starts dumb (angles + peak kW), gets smarter from real data
- Handles shadowing and angle compensation empirically, not through physics modelling
- Stores at least one year of hourly data
- Decoupled from weather source — raw data staged to files first

---

## Architecture

```
solar-forecast/
├── data/
│   ├── raw/              # Open-Meteo JSON files (kept for replay/debug)
│   ├── solar.db          # SQLite database
│   └── forecast.json     # Latest forecast output (from run-once.js)
├── src/
│   ├── fetcher.js        # Pull from Open-Meteo, write raw JSON to data/raw/
│   ├── parser.js         # Read raw JSON, write irradiance to solar_readings
│   ├── model.js          # Forecast production from irradiance + correction matrix
│   ├── learner.js        # Update correction_matrix from actuals vs predicted
│   ├── smoother.js       # Smooth correction_matrix, manage observation weights
│   ├── consumption.js    # Yesterday's consumption + temperature correction
│   ├── optimizer.js      # Battery charge/discharge optimizer (greedy v1)
│   ├── price-fetcher.js  # Pluggable price provider dispatcher
│   ├── prices/           # Price providers (elprisetjust, awattar)
│   ├── inverters/        # Pluggable inverter drivers (growatt cloud, growatt-modbus, …)
│   ├── inverter-dispatcher.js  # Driver selection based on config.inverter.brand
│   ├── battery-api.js    # GET /battery/schedule endpoint
│   ├── db.js             # DB connection, schema init, all queries
│   ├── api.js            # Express endpoint — serves 24h forecast
│   └── timeutils.js      # Timezone-safe timestamp parsing (no Date objects)
├── config.js             # Installation-specific parameters
├── scheduler.js          # Cron orchestration + Express server
├── run-once.js           # One-shot: fetch → parse → model → write forecast.json
├── run-battery-once.js   # One-shot: prices → consumption → optimize → optional push
└── package.json
```

---

## Configuration (`config.js`)

Everything installation-specific lives here. The learning system will correct for inaccuracies
over time, so initial values only need to be approximate.

```javascript
export default {
    location: {
        lat: 57.48,
        lon: 11.94,
        timezone: 'Europe/Stockholm'  // IANA timezone — all timestamps use this
    },
    panel: {
        peak_kw: 10.0,
        tilt: 35,        // degrees from horizontal
        azimuth: 180,    // 180 = south
        efficiency: 0.19 // starting estimate — learning will correct this
    },
    learning: {
        min_irradiance_weight: 400,    // W/m² — below this, observation gets low confidence
        empirical_blend_threshold: 30  // number of observations before fully trusting matrix
    },
    forecast: {
        horizon_hours: 24,
        fetch_interval_hours: 6
    }
}
```

### Timezone handling

All timestamps throughout the system are in the configured timezone. The Open-Meteo API
receives the timezone parameter, returns local timestamps, and all DB storage and forecast
output uses the same timezone. Internal timestamp parsing (`src/timeutils.js`) works directly
on the `"YYYY-MM-DDTHH:MM"` strings — no `Date` object conversions — to avoid
system-timezone or UTC conversion issues.

---

## Usage

### One-shot (development)

```bash
node run-once.js
```

Fetches weather, runs the full pipeline, and writes `data/forecast.json`. Exits when done.

### Persistent server (production)

```bash
node scheduler.js
```

Starts the Express API on port 3000 (or `PORT` env var), registers cron jobs, and runs
the fetch pipeline immediately on startup. Runs until stopped with Ctrl+C.

---

## Data Pipeline

### 1. Fetch
`fetcher.js` pulls from Open-Meteo every 6 hours and writes a raw JSON file:

```
data/raw/openmeteo_YYYYMMDD_HHMM.json
```

The timestamp in the filename is when the fetch occurred, not the forecast period.
Raw files are retained for at least a few months for debugging and replay.

### 2. Parse
`parser.js` reads raw JSON files and writes hourly irradiance values to `solar_readings`.
This decouples the weather source — switching from Open-Meteo to another provider
(or to a file-based guesstimate) only requires changes in `parser.js`.

### 3. Model
`model.js` produces `prod_forecast` for each hour using:

```
prod_forecast = peak_kw × (irr_forecast / 1000) × correction_factor(month, hour)
```

Where `correction_factor` comes from the learned matrix. Before enough data exists,
it falls back to a geometry-based estimate derived from tilt and azimuth.

### 4. Learn
`learner.js` runs hourly. When `prod_actual` is available for a past hour, it computes:

```
correction = prod_actual / prod_forecast
```

This is written to `solar_readings` and used to update the `correction_matrix`.

### 5. Smooth
`smoother.js` periodically updates the correction matrix using weighted averages.
Low-irradiance hours contribute less (noisy signal). Observations are smoothed across
±7 days of day-of-year using a Gaussian kernel (σ=3 days) to reduce noise from
individual cloudy days. Year-wrap (365→1) is handled.

---

## Fallback Strategy

If the weather API is unavailable or returns no data:

1. Use last known good irradiance for the same hour
2. Fall back to the previous day's irradiance for that hour
3. If neither is available, use the correction matrix alone with a historical average

> **Status:** Not yet implemented.

---

## Database Schema (SQLite)

### `solar_readings` — one row per hour
Stores the raw forecast, model output, actual production, and derived correction.

```sql
CREATE TABLE solar_readings (
    id              INTEGER PRIMARY KEY,
    hour_ts         DATETIME UNIQUE,  -- exact hour, in configured timezone
    irr_forecast    REAL,             -- W/m², from weather source
    prod_forecast   REAL,             -- kWh, model output
    prod_actual     REAL,             -- kWh, from inverter/meter (null until known)
    correction      REAL,             -- prod_actual / prod_forecast (null until known)
    confidence      REAL              -- observation weight 0–1, based on irradiance level
);
```

At 8,760 rows/year this is trivially small. Retain at least one full year (preferably two)
so the correction matrix can compare year-over-year.

The `correction_matrix` is seeded with 8,784 rows (366 days × 24 hours, including Feb 29)
on first run, all with `correction_avg = 1.0`.

### `correction_matrix` — 8,784 rows, month × day × hour
The learned fingerprint of the installation. Starts at 1.0 everywhere and drifts toward
empirical reality as observations accumulate. Uses month + day-of-month as key so that
leap years are handled naturally (Feb 29 simply has its own cells).

```sql
CREATE TABLE correction_matrix (
    month           INTEGER,          -- 1–12
    day_of_month    INTEGER,          -- 1–31
    hour_of_day     INTEGER,          -- 0–23
    correction_avg  REAL,             -- weighted average correction factor
    sample_count    INTEGER,          -- number of observations
    max_prod        REAL,             -- maximum production ever observed (kWh)
    last_updated    DATETIME,
    PRIMARY KEY (month, day_of_month, hour_of_day)
);
```

### `correction_matrix_smooth` — 8,760 rows, day-of-year × hour
High-resolution version. Captures effects like "trees shadow panel 14:00–16:00 in June"
rather than smearing them across a whole month. Populated after a full year of data.

```sql
CREATE TABLE correction_matrix_smooth (
    day_of_year     INTEGER,          -- 1–365
    hour_of_day     INTEGER,          -- 0–23
    correction_avg  REAL,
    sample_count    INTEGER,
    PRIMARY KEY (day_of_year, hour_of_day)
);
```

### Battery optimizer tables

The battery optimizer adds three more tables — documented in detail in
[`battery-optimizer.md`](battery-optimizer.md):

- **`price_readings`** — spot prices at 15-min resolution (slot_ts, spot_price, region)
- **`consumption_readings`** — hourly household consumption with outdoor temperature (hour_ts, consumption_w, outdoor_temp, source); `source` is `inverter_delta` when derived from energy snapshots
- **`energy_snapshots`** — 15-min snapshots of daily cumulative energy totals from inverter (snapshot_ts, pv_today_kwh, load_today_kwh, grid_import_today_kwh, grid_export_today_kwh)
- **`battery_schedule`** — optimizer output: 15-min slots with action, watts, SOC tracking, prices

---

## Learning Model

### Confidence weighting
Low irradiance hours are noisy — a cloudy morning gives little useful signal.

```javascript
const confidence = Math.min(1.0, irr_forecast / 400);
// 400 W/m² = full weight, tapers to zero below that
```

### Empirical blending
Blend geometry model with empirical matrix based on how many observations exist:

```javascript
const empirical_weight = Math.min(1.0, sample_count / 30);
const correction = (empirical_weight * matrix_correction)
                 + ((1 - empirical_weight) * geometry_correction);
```

### Smoothing
Correction matrix values are smoothed across ±7 days of day-of-year using a Gaussian kernel
(σ=3 days). This handles year-wrap at day 365→1. Days with low total production (e.g. overcast)
are given lower weight in the smoothing pass.

---

## API

Single endpoint, served by `api.js` (Express):

```
GET /forecast
```

Response:
```json
{
  "generated_at": "2026-02-20T16:42:33.244Z",
  "timezone": "Europe/Stockholm",
  "horizon_hours": 24,
  "forecast": [
    { "hour": "2026-02-21T09:00", "prod_kw": 0.01, "irr_wm2": 3, "confidence": 0.01 },
    { "hour": "2026-02-21T10:00", "prod_kw": 0.05, "irr_wm2": 12, "confidence": 0.03 },
    { "hour": "2026-02-21T11:00", "prod_kw": 0.07, "irr_wm2": 17, "confidence": 0.04 },
    ...
  ]
}
```

`confidence` here reflects irradiance level and the maturity of the correction matrix
for that month/hour cell. The battery optimizer can use this to decide how aggressively
to act on the forecast.

---

## Scheduler

```
Every 6 hours     → fetchPipeline    (fetch → parse → model)
Every 1 hour :00  → learnPipeline    (check for new actuals, update correction matrix)
Every 1 hour :05  → consumptionPipeline (read inverter telemetry → consumption_readings + prod_actual)
Every 1 hour :30  → batteryPipeline  (fetch prices → estimate consumption → read SOC → optimize)
Every 24h at 02:00→ smoothPipeline   (re-smooth correction matrix)
Day-ahead + :15   → batteryPipeline  (re-optimize when tomorrow's prices publish)
Every 15 min      → snapshotPipeline (read daily energy totals → energy_snapshots)
Every 15 min      → executePipeline  (push schedule to inverter hardware — skipped if data_collection_only)
```

---

## Technology Stack

| Concern         | Choice                        |
|-----------------|-------------------------------|
| Runtime         | Node.js (ESM)                 |
| Database        | SQLite via `better-sqlite3`   |
| Weather source  | Open-Meteo (free, no API key) |
| HTTP API        | Express                       |
| Scheduling      | `node-cron`                   |
| Modbus TCP      | `modbus-serial` (local inverter communication) |

---

## Weather Source

Open-Meteo provides GHI (Global Horizontal Irradiance), DNI, and DHI at 1-hour resolution,
free with no API key required. Example query parameters:

```
latitude=57.48&longitude=11.94
&hourly=shortwave_radiation,direct_radiation,diffuse_radiation
&forecast_days=2
&timezone=Europe/Stockholm
```

Switching source later requires only changes to `fetcher.js` and `parser.js`.

---

## Future Considerations

- **Fallback strategy** — use previous irradiance when the weather API is unavailable
- **Ensemble forecasting** — average across multiple weather sources for better confidence
- **Panel degradation tracking** — long-term trend in correction factors signals degradation
