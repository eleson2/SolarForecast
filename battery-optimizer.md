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
| Optimizer engine         | Done        | `src/optimizer.js` — greedy v1, solar-aware pairing + SOC tracking |
| Battery state tracker    | Done        | Integrated in optimizer (SOC forward pass) |
| Inverter integration     | Growatt MIN + MOD done | See [`inverter-integration.md`](inverter-integration.md) — Cloud API + Modbus TCP drivers |
| Live SOC seeding         | Done        | Optimizer accepts `options.startSoc` from inverter; scheduler + CLI read SOC before each run |
| Last-known SOC fallback  | Done        | `lastKnownSoc` in `scheduler.js` — Modbus timeouts no longer reset optimizer to `min_soc` default |
| Solar forecast confidence| Done        | `battery.solar_forecast_confidence` multiplier + `min_grid_charge_kwh` floor prevent solar forecast from crowding out all grid charging |
| SOC deviation guard      | Done        | `executePipeline` compares live SOC to `slots[0].soc_start`; overrides to `charge_grid` if deficit > `soc_deviation_threshold` |
| Manual override API      | Done        | `src/override.js` + `GET/POST/DELETE /battery/override` — persists action across 15-min execute cycles |
| Modbus retry logic       | Done        | `withReconnect()` retries up to `modbus_retries` times with `modbus_retry_delay_ms` delay (config-driven) |
| Stale forecast fix       | Done        | `upsertReading` clears `prod_forecast`/`correction_applied` on irradiance update if no `prod_actual` yet; `getReadingsWithoutForecast` always returns future rows so every model run refreshes remaining-day forecasts |
| Hourly model re-run      | Done        | `learnPipeline` calls `runModel()` after the learner updates the correction matrix — ensures intraday corrections flow into remaining hours within ~1h, not up to 6h |
| Hour-boundary fix        | Done        | `getReadingsForForecast` floors `fromTs` to hour start so :15/:30/:45 optimizer runs don't miss the current partial hour's solar data |
| Soft transient reset     | Done        | `executePipeline` skips `resetToDefault` for ETIMEDOUT/ECONNREFUSED — leaves inverter in last-written state |
| Charge/discharge window logging | Done | `logWindows()` in `optimizer.js` groups consecutive slots into time windows with kWh and avg price |
| Consumption collection   | Done        | `getMetrics()` driver interface; hourly cron stores to `consumption_readings` |
| API / schedule output    | Done        | `src/battery-api.js` — GET /battery/schedule |
| Transfer tariffs         | Done        | Separate import/export transfer fees + energy tax |
| Peak shaving             | Design only | Deferred until real-time consumption available |
| EV-aware scheduling      | Not started | v2 — detect EV charging, plan around it  |

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

**Primary approach: "yesterday + temperature correction"**

Use yesterday's actual hourly consumption as the baseline for today's forecast.
Adjust for outdoor temperature difference, since heating and cooling are the main
variable loads in most households.

```
consumption_estimate(hour) = yesterday_actual(hour) × temperature_factor
```

Where `temperature_factor` accounts for the difference between today's forecast
temperature and yesterday's actual temperature. Heating-dominated climates use
more energy when it's colder; cooling-dominated climates use more when it's hotter.

**Temperature correction model:**

```javascript
// Heating degree difference: how much colder is today vs yesterday
const temp_diff = forecast_temp(hour) - yesterday_temp(hour);

// Each degree colder → ~3% more consumption (configurable)
// Each degree warmer → ~3% less consumption (in heating climates)
const temp_factor = 1.0 - (temp_diff * heating_sensitivity);
// Clamp to reasonable range
const factor = Math.max(0.7, Math.min(1.3, temp_factor));
```

**Data sources for yesterday's consumption:**
- Smart meter / P1 port — direct hourly readings
- Inverter API — grid import values
- Computed: `grid_import + solar_production - battery_charge + battery_discharge`

**Fallback chain:**
1. Yesterday's actual hourly consumption (temperature-adjusted)
2. Same weekday last week (if yesterday was atypical)
3. Manual profile from config (weekday/weekend patterns)
4. Flat estimate as last resort

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
        // optimizer's planned soc_start for the current slot, executePipeline overrides
        // the current slot to charge_grid to recover the deficit.
        soc_deviation_threshold: 10,
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
        enabled: false,              // v2 — EV-aware scheduling
        // see "EV-Aware Scheduling" section below
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

### Greedy strategy (v1) — solar-aware pairing

The optimizer pairs cheap charge slots with expensive discharge slots, but is
**solar-aware**: it only charges enough to cover actual grid deficits.

Before pairing, it computes how much of the battery's empty headroom solar is
expected to fill, and reserves the rest for grid charging:

```
solarAbsorbWh = min(solarSurplusWh × solar_forecast_confidence,
                    batteryRoomWh − min_grid_charge_kwh × 1000)
gridHeadroomWh = max(0, batteryRoomWh − solarAbsorbWh)
```

- `solar_forecast_confidence` (default 0.7) discounts the forecast to account for
  uncertainty — clouds, seasonal model errors.
- `min_grid_charge_kwh` (default 4.0 kWh) is a hard floor: even if the solar forecast
  is large enough to absorb the entire battery, this many kWh of headroom are always
  reserved for grid charging. **Exception:** if total forecast solar ≥ battery room +
  total forecast consumption, the floor is waived — solar alone will fill the battery
  and cover all loads, so grid charging is never needed.
- `max_solar_for_grid_charge_w` (default 100 W) restricts grid-charge candidate slots
  to hours where the solar forecast is below this watt threshold. Any slot forecasting
  more than 100 W of solar is excluded — the battery will charge for free via
  `charge_solar` so grid-charging there is wasteful. Night and heavy-overcast slots
  (≤ 100 W) remain eligible.

The optimizer logs this calculation on each run:
```
[optimizer] Solar-aware: 17.1 kWh forecast × 0.7 confidence = 3.7 kWh credited
            (cap 3.7 kWh), grid headroom 4.0 kWh
[optimizer] Cloud cover: avg 58% over 11 daytime forecast hours
```

#### Step 1: Compute avoidable energy per slot

For each 15-min slot, compute the grid deficit that a battery discharge could
displace:

```
net_production = solar_forecast - consumption_estimate   (watts)
grid_deficit   = max(0, -net_production)                 (watts needing grid)
avoidable_wh   = min(grid_deficit, max_discharge_w) × 0.25
```

Slots where solar covers consumption have `avoidable_wh = 0` — discharging
there wastes stored energy since there's nothing to displace.

#### Step 2: Filter candidates

- **Discharge candidates**: only slots with `avoidable_wh > 0`, sorted by
  `buy_price` descending (most expensive first)
- **Charge candidates**: slots where `net_production ≤ 0` AND `solar_watts ≤ consumption_watts × 0.5`
  (solar covering less than half of load), sorted by `buy_price` ascending (cheapest first).
  Excluding slots where solar already covers ≥50% of consumption prevents grid charging during
  the solar ramp-up window — those slots show up cheap in the price sort but grid-charging
  there competes with free solar and creates scattered short charge windows.

#### Step 3: Pair charge ↔ discharge

Pair cheapest charge with most expensive discharge while:
- Price spread exceeds efficiency loss: `discharge_price - charge_price > min_spread`
- Battery capacity not exceeded

Each pair's energy is capped to the discharge slot's `avoidable_wh` — the battery
only charges what it will actually use. This means:

- **Morning peak** (7–9, no solar) → high avoidable_wh → gets paired
- **Sunny midday** (solar surplus) → zero avoidable_wh → skipped entirely
- **Battery charges just enough** for the morning gap + any evening deficit

#### Step 4: Solar surplus & sell

After pairing, remaining idle slots with solar surplus get `charge_solar`.
If the battery is full and grid sell is enabled, surplus becomes `sell`.

#### Efficiency threshold

A charge/discharge cycle only makes sense when the price spread exceeds the
efficiency loss:

```
min_spread = buy_price × (1 / efficiency - 1)
// At 90% efficiency and 0.50 SEK/kWh buy price: min_spread ≈ 0.056 SEK/kWh
```

Only schedule a cycle when `discharge_price - charge_price > min_spread`.

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
battery-optimizer/
├── src/
│   ├── price-fetcher.js     # Thin dispatcher — routes to provider
│   ├── prices/
│   │   ├── elprisetjust.js  # Nordics: elprisetjustnu.se (15-min)
│   │   └── awattar.js       # DE/AT: aWATTar API (hourly → 4×15-min)
│   ├── inverters/           # Pluggable inverter drivers (see inverter-integration.md)
│   │   ├── growatt.js       # Cloud REST API, time-segment based
│   │   ├── solaredge.js     # Local Modbus TCP, per-register
│   │   ├── huawei.js        # Local Modbus, TOU mode
│   │   ├── sma.js           # Local Modbus, manual setpoint
│   │   ├── enphase.js       # Local REST + JWT
│   │   ├── tesla.js         # Cloud Fleet API, reserve-% control
│   │   └── givenergy.js     # Cloud REST or local MQTT/GivTCP
│   ├── consumption.js       # Yesterday's usage + temperature correction
│   ├── optimizer.js         # Greedy v1: solar-aware charge/discharge pairing
│   ├── battery-state.js     # Track SOC, enforce constraints
│   └── battery-api.js       # Express endpoints for schedule
├── battery-config.js        # Battery + grid + price + EV configuration
└── (integrated into scheduler.js)
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

Then register the provider in `src/price-fetcher.js`:

```javascript
import * as myProvider from './prices/my-provider.js';
const providers = { elprisetjust, awattar, myProvider };
```

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
| `charge_grid` / `charge_solar` | `charge_soc` (default 95%) | High floor → battery charges     |
| `discharge` / `sell`     | `discharge_soc` (default 13%) | Low floor → battery discharges |
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
correction. After computing `futureSlots`, it checks:

```
if (slots[0].soc_start - state.soc > soc_deviation_threshold) AND (not already charging)
→ override futureSlots[0] to charge_grid at max_charge_w
```

This fires when actual battery SOC is significantly below what the optimizer planned —
e.g. unexpectedly high load during the night. The override lasts one 15-minute slot; the
subsequent `batteryPipeline` re-plans from the corrected SOC.

Configurable via `config.battery.soc_deviation_threshold` (default: 10 %).

---

## EV-Aware Scheduling (v2)

Electric vehicles are large, flexible loads that can dramatically change the
optimization landscape. A typical EV charges at 3.6–11 kW — often more than
the rest of the household combined.

### Why it matters

- EV charging at peak price can cost 5–10× more than charging at the cheapest hour
- An EV plugged in overnight has 8+ hours of flexibility — perfect for optimization
- Without EV awareness, the optimizer sees a huge unexpected load and its schedule breaks

### v2 approach

```javascript
ev: {
    enabled: true,
    charge_rate_w: 7400,          // typical home charger (32A single-phase)
    target_soc: 80,               // desired SOC by departure
    departure_time: '07:30',      // when the car needs to be ready
    battery_kwh: 60,              // EV battery size
    current_soc: 40,              // from EV API or manual
    charger_type: 'smart',        // 'smart' (can schedule) or 'dumb' (charges immediately)
}
```

The optimizer would:
1. Calculate kWh needed: `(target_soc - current_soc) / 100 × battery_kwh`
2. Calculate hours needed: `kwh_needed / (charge_rate_w / 1000)`
3. Pick the cheapest hours before `departure_time` to schedule charging
4. Coordinate with house battery — don't charge both from grid simultaneously
   if it would exceed the grid connection limit

### Detection (future)
If no EV config is provided, detect EV charging from consumption patterns:
sustained high load (>3 kW) appearing in the evening is likely an EV.
Flag it and suggest the user configure EV settings.

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

The peak shaving layer runs **before** the greedy pairing:
1. Identify slots where forecast consumption exceeds peak_target
2. Mark those slots as mandatory discharge (regardless of spot price)
3. Reserve battery Wh for those slots
4. Then run normal greedy pairing with remaining capacity

### Why deferred

Peak shaving needs actual consumption metering data to track the monthly
peak. The current system estimates consumption from yesterday's data,
which isn't precise enough for peak tracking. Implementation should wait
until real-time consumption reading is available (e.g. from P1 port or
inverter grid import readings).

---

## Future Considerations

- **Optimal strategy (v2+)** — dynamic programming over 24h horizon for globally optimal schedule
- **Multi-day optimization** — look ahead 48h when prices are volatile
- **Grid capacity selling** — participate in frequency regulation markets
- **Multiple EVs** — household with two electric vehicles
- **Vehicle-to-grid (V2G)** — use EV battery as additional storage
- **Machine learning pricing** — predict price spikes from weather/demand patterns
- **Dashboard** — visualize schedule, savings, and battery state over time
