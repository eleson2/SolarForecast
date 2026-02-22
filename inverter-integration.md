# Inverter Integration — Design Document

## Overview

The battery optimizer produces a 24 h schedule of 15-min slots, each with an
action (`charge_grid`, `discharge`, `charge_solar`, `sell`, `idle`) and a target
wattage. This document describes how that schedule gets **executed** by talking
to actual inverter/battery hardware.

The integration layer is pluggable — one driver per brand, same interface.

---

## Implementation Status

| Brand          | Driver module              | Status      | Notes                            |
|----------------|----------------------------|-------------|----------------------------------|
| Growatt        | `src/inverters/growatt.js`  | Done        | Cloud API, time-segment based    |
| SolarEdge      | `src/inverters/solaredge.js`| Not started | Local Modbus TCP                 |
| Huawei         | `src/inverters/huawei.js`   | Not started | Local Modbus via FusionSolar     |
| SMA            | `src/inverters/sma.js`      | Not started | Local Modbus TCP                 |
| Enphase        | `src/inverters/enphase.js`  | Not started | Local REST API + token           |
| Tesla Powerwall| `src/inverters/tesla.js`    | Not started | Cloud Fleet API                  |
| GivEnergy      | `src/inverters/givenergy.js`| Not started | Cloud REST or local MQTT/GivTCP  |

---

## Driver Interface

Every driver in `src/inverters/<brand>.js` exports the same shape:

```javascript
/**
 * Read current battery state.
 * @returns {Promise<{ soc: number, power_w: number, mode: string }>}
 *   soc       — current state of charge in % (0–100)
 *   power_w   — current charge (+) or discharge (−) power in watts
 *   mode      — current inverter mode as reported by hardware
 */
export async function getState(driverConfig) { ... }

/**
 * Apply a schedule window to the inverter.
 * Translates optimizer actions into inverter-native commands.
 *
 * @param {Array<{ slot_ts, action, watts }>} slots — contiguous block of schedule slots
 * @param {object} driverConfig — brand-specific config from config.js
 * @returns {Promise<{ applied: number, skipped: number }>}
 */
export async function applySchedule(slots, driverConfig) { ... }

/**
 * Set inverter back to default autonomous mode (e.g. self-consumption).
 * Called on error or when schedule window ends.
 * @returns {Promise<void>}
 */
export async function resetToDefault(driverConfig) { ... }

/**
 * (Optional) Read extended telemetry including consumption.
 * Used by the consumption collection pipeline to populate consumption_readings.
 * Drivers that don't implement this are silently skipped.
 *
 * @returns {Promise<{ soc: number, battery_w: number, grid_import_w: number, grid_export_w: number, solar_w: number, consumption_w: number }>}
 *   soc            — battery SOC %
 *   battery_w      — charge (+) / discharge (−) watts
 *   grid_import_w  — watts drawn from grid
 *   grid_export_w  — watts sent to grid
 *   solar_w        — PV production watts
 *   consumption_w  — household load watts
 */
export async function getMetrics(driverConfig) { ... }
```

#### Per-brand consumption data sources

| Brand       | Consumption source                                            |
|-------------|---------------------------------------------------------------|
| Growatt     | `pload`/`pac` from `tlx_last_data` (implemented)             |
| SolarEdge   | Modbus registers: grid power, PV power, load power            |
| Huawei      | Modbus registers: active power, grid power via FusionSolar    |
| SMA         | Modbus registers: grid feed-in, load power                    |
| Enphase     | `GET /api/v1/production` + `/consumption` local endpoints     |
| Tesla       | Fleet API: battery and grid power readings                    |
| GivEnergy   | MQTT `givtcp/xxx/grid` + `givtcp/xxx/load` or REST           |

---

## Dispatcher — `src/inverter-dispatcher.js`

The dispatcher selects the correct driver based on `config.inverter.brand`.
Same pattern as `src/price-fetcher.js` for price providers.

```javascript
import { getDriver, getDriverConfig } from './src/inverter-dispatcher.js';

const driver = getDriver();       // → driver module or null
const cfg    = getDriverConfig();  // → config.inverter or null

if (driver) {
  const state = await driver.getState(cfg);
  const result = await driver.applySchedule(slots, cfg);
  await driver.resetToDefault(cfg);
}
```

When `config.inverter` is missing or `brand` is empty, `getDriver()` returns
`null` and the system continues without inverter control.

---

## Configuration

```javascript
// config.js
inverter: {
    brand: 'growatt',           // driver name — matches src/inverters/<brand>.js
    // Brand-specific settings (passed as driverConfig):
    host: '192.168.1.100',      // for local Modbus/REST brands
    port: 502,                  // Modbus TCP port (SolarEdge, Huawei, SMA)
    token: '',                  // API token (Growatt cloud, Enphase, Tesla, GivEnergy)
    plant_id: '',               // Growatt: plant ID from ShinePhone
    device_sn: '',              // device serial number
    unit_id: 1,                 // Modbus unit ID (default 1)
    poll_interval_s: 30,        // how often to read SOC during execution
    failsafe_mode: 'self_consumption', // mode to revert to on error
},
```

### Growatt-specific config

```javascript
inverter: {
    brand: 'growatt',
    server: 'https://openapi.growatt.com/',   // EU; use -us (US) or -cn (CN)
    token: '',                                // OpenAPI V1 token from Growatt portal
    device_sn: '',                            // MIN inverter serial number
    poll_interval_s: 30,
    failsafe_mode: 'load_first',
},
```

**How to get a token:** Log in to the [Growatt web portal](https://server.growatt.com/)
or the ShinePhone app → Settings → API Management → generate an API token.

---

## Brand Details

### Growatt — `src/inverters/growatt.js` ✅ Implemented

**Protocol:** Growatt OpenAPI V1 (Cloud REST, same backend as ShinePhone app)
**Auth:** API token in HTTP header `{ "token": "<api_token>" }`
**Base URL:** `https://openapi.growatt.com/` (EU), `-us` (US), `-cn` (CN)
**Battery models:** MIN, MOD, MID, MIC series with lithium battery packs

#### API endpoints used

| Endpoint                          | Method | Purpose                  |
|-----------------------------------|--------|--------------------------|
| `v1/device/tlx/tlx_last_data`    | POST   | Read SOC, power, mode    |
| `v1/device/tlx/tlx_set_info`     | GET    | Read current settings    |
| `v1/tlxSet`                       | POST   | Write time segment 1–9   |

#### `getState(cfg)` — read battery state

Calls `POST v1/device/tlx/tlx_last_data` with `{ tlx_sn: cfg.device_sn }`.

Returns:
```javascript
{ soc: 72, power_w: 1500, mode: 'normal' }
```

Field mapping from API response (handles multiple response shapes):
- `soc` ← `data.soc` or `data.batSoc`
- `power_w` ← `data.batPower` or `data.bat_power`
- `mode` ← `data.workMode` or `data.work_mode`

#### `applySchedule(slots, cfg)` — push time segments

1. **Merge** consecutive 15-min slots with the same action into time windows
2. **Cap** to 9 windows (Growatt hardware limit) — logs warning if exceeded
3. **Push** each window via `POST v1/tlxSet`
4. **Disable** unused segments (fill remaining slots up to 9)

Returns `{ applied: number, skipped: number }`.

##### `tlxSet` request body

```javascript
{
  tlx_sn: 'ABC123',           // inverter serial number
  type: 'time_segment1',      // time_segment1 through time_segment9
  param1: '1',                // batt_mode: 0=load_first, 1=battery_first, 2=grid_first
  param2: '7',                // start hour
  param3: '0',                // start minute
  param4: '8',                // end hour
  param5: '30',               // end minute
  param6: '1',                // enabled: "1" or "0"
  param7: '', ..., param19: ''  // reserved, sent as empty strings
}
```

##### Action → batt_mode mapping

| Optimizer action | `param1` (batt_mode) | Growatt behavior                |
|------------------|----------------------|---------------------------------|
| `charge_grid`    | `1` (battery_first)  | Charges battery from grid       |
| `discharge`      | `0` (load_first)     | Battery powers the house        |
| `charge_solar`   | `0` (load_first)     | Solar surplus charges battery   |
| `sell`           | `1` (battery_first)  | Export stored energy to grid    |
| `idle`           | `0` (load_first)     | Normal self-consumption         |

#### `resetToDefault(cfg)` — failsafe

Disables all 9 time segments by posting each with `param6: '0'` (disabled).
The inverter falls back to its built-in default mode (typically load-first
self-consumption).

Called automatically by `scheduler.js` when `applySchedule` throws.

#### Slot merging algorithm

The `mergeSlots()` function (exported for testing) converts 15-min schedule
slots into Growatt time windows:

```
Input:
  07:00 charge_grid
  07:15 charge_grid
  07:30 charge_grid
  07:45 discharge
  08:00 discharge

Output:
  Window 1: 07:00–07:45  batt_mode=1 (charge_grid)
  Window 2: 07:45–08:15  batt_mode=0 (discharge)
```

Rules:
- Consecutive slots with the same `action` are merged into one window
- End time = last slot's timestamp + 15 minutes
- If more than 9 windows result, only the first 9 are pushed (a warning is logged)
- Slots are sorted by `slot_ts` before processing

#### Dry-run mode

When `cfg.dry_run` is `true`, the driver logs what it would send without
making any API calls. Used by `run-battery-once.js --dry-run`.

```
[growatt] DRY-RUN segment 1: 07:00-07:45 charge_grid (batt_mode=1)
[growatt] DRY-RUN segment 2: 07:45-08:15 discharge (batt_mode=0)
[growatt] DRY-RUN disable segment 3
...
[growatt] DRY-RUN disable segment 9
```

#### HTTP helper — `growattFetch(method, path, cfg, body?)`

Internal function handling all Growatt API communication:
- Builds URL from `cfg.server` + `path`
- Sets `Content-Type: application/json` and `token` header from `cfg.token`
- Throws on non-200 HTTP status or non-zero `error_code` in response body
- Uses Node.js built-in `fetch()` (no external HTTP dependency)

#### Error handling

| Scenario                    | Behavior                                           |
|-----------------------------|----------------------------------------------------|
| HTTP error (non-200)        | Throws with status code and response body          |
| API error (`error_code ≠ 0`)| Throws with error code and message                 |
| Single segment push fails   | Logged, counted as `skipped`, other segments continue |
| All segments fail           | `applySchedule` returns `{ applied: 0, skipped: N }` |
| Scheduler catches error     | Calls `resetToDefault()` → disables all segments   |

#### Supported models (OpenAPI V1 token auth)
- MIN 2500–6000TL-X/XE/XH/XA Series
- MIN 3000–7600TL-XH US Series
- MOD 3–10KTL3-XH Series
- MID 11–30KTL3-XH Series
- MIC 600–3300TL-X Series
- SPH series (via ShinePhone username/password auth)

#### References
- [Growatt Home Assistant integration](https://www.home-assistant.io/integrations/growatt_server/)
- [Predbat Growatt setup](https://springfall2008.github.io/batpred/inverter-setup/)
- [DIY Solar Forum — Growatt API](https://diysolarforum.com/threads/growatt-inverter-api-help.96639/)
- [PyPi GrowattServer](https://pypi.org/project/growattServer/) — reverse-engineered API reference

---

### SolarEdge

**Protocol:** Modbus TCP (local network, no cloud dependency)
**Auth:** None (network access to inverter)
**Battery models:** StorEdge, BYD compatible via SolarEdge inverter

#### API capabilities

| Capability           | Method                                              |
|----------------------|-----------------------------------------------------|
| Read SOC             | Modbus register — battery state of energy           |
| Set storage mode     | Register 63236 → Remote; Register 63242 → mode      |
| Set charge profile   | Scheduled charge/discharge profile via registers    |
| Power limits         | Configurable charge/discharge rate registers        |

#### Control model — Modbus registers

Storage must be set to **Remote Control** mode (register 63236) before
schedule commands are accepted. Then register 63242 selects the mode:

| Register 63242 value | Mode                        |
|-----------------------|-----------------------------|
| 0                     | Disabled                    |
| 1                     | Charge from PV excess       |
| 2                     | Charge from PV + grid       |
| 3                     | Maximize export             |
| 4                     | Discharge to minimize import|
| 7                     | Maximize self-consumption   |

**Mapping optimizer actions → SolarEdge modes:**

| Optimizer action | SolarEdge mode (63242)     | Notes                      |
|------------------|----------------------------|----------------------------|
| `charge_grid`    | 2 — Charge from PV + grid  | Set charge rate limit      |
| `discharge`      | 4 — Discharge to minimize  | Set discharge rate limit   |
| `charge_solar`   | 1 — Charge from PV excess  |                            |
| `sell`           | 3 — Maximize export        |                            |
| `idle`           | 7 — Self-consumption       |                            |

**Refresh strategy:** Write registers at each slot boundary (every 15 min)
since Modbus is local and low-latency.

#### Multi-battery support
SolarEdge supports up to 3 batteries (b1, b2, b3). SOC is read per-battery
and averaged. Commands apply to all batteries.

#### References
- [SolarEdge Modbus HA integration](https://github.com/binsentsu/home-assistant-solaredge-modbus)
- [StorEdge charge/discharge programming (PDF)](https://knowledge-center.solaredge.com/sites/kc/files/storedge_charge_discharge_profile_programming.pdf)
- [HA Community — SolarEdge Modbus setup](https://community.home-assistant.io/t/solaredge-modbus-configuration-for-single-inverter-and-battery/464084)

---

### Huawei (FusionSolar)

**Protocol:** Modbus TCP (local, via Huawei Solar integration)
**Auth:** None (local network access)
**Battery models:** LUNA2000 series

#### API capabilities

| Capability           | Method                                    |
|----------------------|-------------------------------------------|
| Read SOC             | Modbus register — direct %                |
| Set work mode        | TOU (Time of Use) mode via registers      |
| Set charge window    | Start/end times + target SOC              |
| Set charge rate      | Separate AC and DC charge limits          |

#### Control model — TOU mode

Huawei requires the inverter to be in **TOU mode** to accept time-based
schedules. Charge/discharge windows are defined with start/end times and
target SOC.

**Important:** Huawei has separate AC and DC charging limits. The driver
must set the appropriate limit based on whether the charge source is grid
(AC) or solar (DC).

**Minimum reserve:** Typically 12% — the driver should never set discharge
SOC below this.

#### References
- [Predbat Huawei setup](https://springfall2008.github.io/batpred/inverter-setup/)

---

### SMA

**Protocol:** Modbus TCP (local)
**Auth:** Installer password for register access
**Battery models:** BYD compatible, SMA own battery modules

#### API capabilities

| Capability           | Method                              |
|----------------------|-------------------------------------|
| Read SOC             | Modbus register                     |
| Set operating mode   | Modbus register — manual mode       |
| Set active power     | Charge/discharge W target           |
| Read grid feed-in    | Modbus register                     |

#### Control model

SMA uses Modbus registers to switch between automatic and manual mode.
In manual mode, a signed active power setpoint controls charge (positive)
and discharge (negative) in watts.

**Mapping optimizer actions → SMA:**

| Optimizer action | SMA command                      |
|------------------|----------------------------------|
| `charge_grid`    | Manual mode, positive setpoint   |
| `discharge`      | Manual mode, negative setpoint   |
| `charge_solar`   | Automatic mode (default)         |
| `sell`           | Manual mode, negative setpoint   |
| `idle`           | Automatic mode                   |

#### References
- [SMA Modbus documentation (Sunny Portal)](https://www.sma.de/en/products/monitoring-control/modbus-protocol-interface)

---

### Enphase

**Protocol:** Local REST API + JWT token
**Auth:** JWT token from Enphase account (valid 1 year)
**Battery models:** IQ Battery 3/10 (Encharge)

#### API capabilities

| Capability           | Method                               |
|----------------------|--------------------------------------|
| Read SOC             | `GET /api/v1/production/inverters`   |
| Set storage mode     | `PUT /ivp/ss/mode`                   |
| Set reserve %        | `PUT /ivp/ss/self_consumption`       |
| Read production      | `GET /api/v1/production`             |

#### Control model

Enphase supports three modes via the local Envoy gateway:

| Mode                | Behavior                                 |
|---------------------|------------------------------------------|
| `self-consumption`  | Normal: charge from solar, discharge to cover load |
| `savings`           | TOU-aware: charge/discharge by schedule  |
| `backup`            | Reserve for grid outage                  |

For schedule execution, use **savings mode** with time-of-use programming.

#### References
- [Enphase local API documentation (community)](https://enphase.com/download/iq-gateway-access-using-local-apis-or-local-ui-token-for-firmware)

---

### Tesla Powerwall

**Protocol:** Cloud REST API (Tesla Fleet API)
**Auth:** OAuth2 via Tesla account
**Battery models:** Powerwall 2, Powerwall 3, Powerwall+

#### API capabilities

| Capability           | Method                                  |
|----------------------|-----------------------------------------|
| Read SOC             | Fleet API — battery level %             |
| Set operation mode   | `self_consumption` or `backup`          |
| Set reserve %        | Backup reserve percentage               |
| Set export mode      | Battery export control                  |

#### Control model

Tesla's control is relatively limited compared to Modbus-based inverters.
The main lever is **backup reserve %** — setting it high forces the battery
to charge, setting it low allows discharge.

**Mapping optimizer actions → Tesla:**

| Optimizer action | Tesla approach                          |
|------------------|-----------------------------------------|
| `charge_grid`    | Set reserve to high % (forces charge)   |
| `discharge`      | Set reserve to min % (allows discharge) |
| `charge_solar`   | Self-consumption mode (default)         |
| `sell`           | Requires Powerwall export agreement     |
| `idle`           | Self-consumption, reserve at current SOC|

**Limitation:** No direct wattage control — charge/discharge rate is managed
by the Powerwall firmware. Schedule execution is approximate.

#### References
- [Tesla Fleet API](https://developer.tesla.com/docs/fleet-api)
- [Predbat Tesla setup](https://springfall2008.github.io/batpred/inverter-setup/)

---

### GivEnergy

**Protocol:** Cloud REST API or local MQTT (via GivTCP)
**Auth:** API key (cloud) or local MQTT broker
**Battery models:** All-in-One, hybrid inverter + battery packs

#### API capabilities (GivTCP — local)

| Capability           | Method                           |
|----------------------|----------------------------------|
| Read SOC             | MQTT topic `givtcp/xxx/soc`      |
| Set charge target    | REST call to GivTCP              |
| Set charge window    | Start/end times                  |
| Set discharge target | REST call to GivTCP              |
| Set discharge window | Start/end times                  |
| Set power rate       | Charge/discharge rate in watts   |

#### Control model

GivEnergy is similar to Growatt — time-window based with charge/discharge
enable and target SOC. The local GivTCP option avoids cloud latency and
dependency.

#### References
- [GivEnergy API documentation](https://givenergy.cloud/docs/api/v1)
- [GivTCP (local)](https://github.com/britkat1980/giv_tcp)

---

## Execution Flow — implemented in `scheduler.js`

The scheduler runs an `executePipeline()` every 15 minutes (`*/15 * * * *`),
plus once on startup. It is separate from `batteryPipeline()` (which
re-optimizes the schedule).

### `executePipeline()` — every 15 min

```
1. getDriver() via dispatcher
   → null? skip silently (no inverter configured)
2. driver.getState(cfg)
   → log SOC, power, mode
3. getScheduleForRange(now, now+24h) from DB
   → no slots? skip
4. Filter to future slots only (slot_ts >= now)
   → no future slots? skip
5. driver.applySchedule(futureSlots, cfg)
   → log applied/skipped counts
```

### Error handling / failsafe

```
if applySchedule or getState throws:
  → log error
  → driver.resetToDefault(cfg)  // disable all segments
  → log confirmation (or log second error if reset also fails)
  → retry on next 15-min cycle
```

### Slot merging

Most inverters (Growatt, GivEnergy, Huawei) work with **time windows**
rather than per-slot commands. Each driver merges consecutive
15-min slots with the same action into windows before sending:

```
Slots:  07:00 charge_grid, 07:15 charge_grid, 07:30 charge_grid, 07:45 discharge
  →  Window 1: 07:00–07:45 charge_grid
     Window 2: 07:45–08:00 discharge
```

Modbus-based inverters (SolarEdge, SMA) can accept per-slot commands since
writes are fast and local.

### CLI usage — `run-battery-once.js`

```bash
# Normal run: optimize + write JSON (no inverter push)
node run-battery-once.js

# Dry-run: optimize + log what segments would be sent (no API calls)
node run-battery-once.js --dry-run

# Live push: optimize + actually send segments to inverter
node run-battery-once.js --push
```

`--dry-run` sets `cfg.dry_run = true` so the driver logs segment details
without calling the Growatt API. Useful for verifying the slot merge logic.

---

## Protocol Comparison

| Brand         | Protocol     | Latency  | Cloud dependency | Granularity      |
|---------------|-------------|----------|------------------|------------------|
| Growatt       | Cloud REST  | ~1-3s    | Yes              | Time segments (9 max) |
| SolarEdge     | Modbus TCP  | ~50ms    | No               | Per-register instant  |
| Huawei        | Modbus TCP  | ~50ms    | No               | TOU windows      |
| SMA           | Modbus TCP  | ~50ms    | No               | Per-register instant  |
| Enphase       | Local REST  | ~200ms   | No (token only)  | Mode + TOU       |
| Tesla         | Cloud REST  | ~1-3s    | Yes              | Reserve % only   |
| GivEnergy     | MQTT/REST   | ~100ms   | Optional         | Time windows     |

---

## Adding a New Inverter Driver

1. Create `src/inverters/<brand>.js` exporting `getState(cfg)`,
   `applySchedule(slots, cfg)`, and `resetToDefault(cfg)`
2. Map the 5 optimizer actions (`charge_grid`, `discharge`, `charge_solar`,
   `sell`, `idle`) to the inverter's native command set
3. Handle slot merging if the inverter uses time windows (see Growatt's
   `mergeSlots()` for reference)
4. Support `cfg.dry_run` — log intended actions without making API calls
5. Register in `src/inverter-dispatcher.js`:
   ```javascript
   import * as myBrand from './inverters/mybrand.js';
   const drivers = { growatt, myBrand };
   ```
6. Add brand-specific config fields to the `inverter` section in `config.js`
7. Add a brand section to this document under "Brand Details"

---

## Design Decisions

### Why not Home Assistant as middleware?

Many setups use HA as the control layer. We **could** add an HA driver that
calls HA service endpoints — this would get free support for any HA-integrated
inverter. However:

- Adds a hard dependency on HA running
- Extra latency hop
- Users without HA would be excluded

The approach here is **direct drivers first**, with an optional HA driver as
a future addition that delegates to HA services.

### Why merge slots into windows?

Cloud APIs (Growatt, Tesla) have rate limits and are not designed for per-slot
updates every 15 minutes. Merging reduces API calls and avoids hitting limits.
Local Modbus brands can still use per-slot updates.

### SOC feedback loop

Reading actual SOC and comparing to the optimizer's predicted SOC is critical.
If the forecast was wrong (more clouds than expected, unexpected load), the
optimizer should re-run with the real SOC as starting point rather than blindly
following a stale schedule.
