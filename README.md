# SolarForecast

Predicts hourly PV production and uses the forecast together with spot prices
to optimise battery charge/discharge scheduling for a grid-tied home system.
Runs as a background service on a home server with local Modbus TCP access to
the inverter.

## What it does

- Fetches hourly irradiance forecast from Open-Meteo every 6 hours
- Learns an empirical correction matrix from actual vs forecast production
- Applies a recency bias scalar to catch short-term deviations (dirty panel etc.)
- Fetches day-ahead spot prices (elprisetjustnu.se or aWATTar)
- Runs a greedy optimizer to plan 24 h of battery charge/discharge slots
- Pushes the active slot to the inverter every 15 minutes via Modbus TCP
- Replans after every executed command so the schedule stays fresh

---

## Prerequisites

- Node.js 22+
- PM2 (`npm install -g pm2`)
- Growatt MOD TL3-XH (or compatible) inverter reachable on the local network
- Windows or Linux home server on the same LAN as the inverter

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

Edit `config.js`. Minimum required fields:

```js
location: {
    lat, lon,               // your GPS coordinates
    timezone                // IANA timezone, e.g. 'Europe/Stockholm'
},
panel: {
    peak_kw,                // installed PV peak power in kW
    tilt,                   // panel tilt in degrees from horizontal
    azimuth,                // panel azimuth (180 = south)
},
battery: {
    capacity_kwh,           // usable battery capacity
    max_charge_w,           // max charge rate in watts
    max_discharge_w,        // max discharge rate in watts
    min_soc, max_soc,       // SOC limits (%)
},
inverter: {
    host,                   // datalogger IP, e.g. '192.168.1.180'
    dry_run: true,          // keep true until ready to go live
    data_collection_only: true,  // keep true until ready to dispatch
    charge_soc: 90,         // SOC floor when charging
    discharge_soc: 20,      // SOC floor when discharging
},
price: {
    source: 'elprisetjust', // or 'awattar'
    region: 'SE3',          // provider-specific region code
    currency: 'SEK',
}
```

Optional: enable peak shaving (grid import cap via inverter register 800):
```js
peak_shaving: {
    enabled: true,
    default_kw: 4.5,       // default cap in kW
    schedule: [
        { from: '00:00', to: '06:45', limit_kw: 10 },  // higher limit overnight
        { from: '21:05', to: '23:59', limit_kw: 10 },
    ],
}
```

Config is validated at startup — misconfigurations produce a clear error and
exit immediately rather than failing silently inside a pipeline.

### 3. Test the data pipeline (no inverter writes)

```bash
node run-once.js
```

This runs fetch → parse → model once and writes `data/forecast.json`. Check
that irradiance values and production forecasts look plausible.

### 4. Test the battery optimizer

```bash
node run-battery-once.js
```

Fetches prices, reads live SOC from the inverter (read-only), runs the
optimizer, and prints the 24 h schedule. No writes to the inverter.

---

## Going live

Follow this sequence. Do not skip steps.

### Step 1 — Data collection only (safe)

`dry_run: true`, `data_collection_only: true` (defaults)

Run as a service and let it collect data for at least a few days:

```bash
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

The system reads SOC and telemetry from the inverter but never writes anything.
Check `logs/app.log` or `pm2 logs solar-forecast` to confirm pipelines are
running cleanly.

Verify the health endpoint:
```
GET http://localhost:3000/health
```
All pipelines should show `status: "ok"` within their expected intervals.

### Step 2 — Enable dispatch, keep dry-run (safe)

In `config.js`:
```js
data_collection_only: false,   // scheduler will now call executePipeline
dry_run: true,                 // writes are still mocked — logged only
```

Restart: `pm2 restart solar-forecast`

Watch the logs for lines like:
```
[growatt-modbus] DRY-RUN: would set LoadFirstStopSoc=20%  (action=discharge)
```

Confirm the correct action is being selected for the current time slot.
Let this run for at least one full 15-minute execute cycle before proceeding.

### Step 3 — Go live

In `config.js`:
```js
dry_run: false,
```

Restart: `pm2 restart solar-forecast`

Watch for:
```
[growatt-modbus] Set LoadFirstStopSoc=20%  (action=discharge)
```

Verify in the Growatt app or on the inverter display that the register changed.

---

## Dashboard

Open `http://localhost:3000` in a browser.

For remote access (phone, other machines on the LAN), set a password in
`config.js`:
```js
dashboard: {
    auth_user: 'admin',
    auth_pass: 'yourpassword',
}
```

> **Warning:** HTTP only. Do not expose to the internet without a TLS reverse
> proxy (e.g. nginx with Let's Encrypt).

### API endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Pipeline run status and overdue detection |
| `GET /api/metrics` | Solar forecast MAE (7d / 30d) |
| `GET /api/consumption-model` | Per-hour temperature→consumption regression coefficients and R² |
| `GET /api/solar` | Solar readings: last 7 days + next 2 days |
| `GET /api/prices` | Spot prices: next 48 hours |
| `GET /battery/schedule` | Active 24 h battery schedule + savings estimate |
| `GET /battery/history` | Last 24 h schedule vs actual energy snapshots |
| `GET /battery/control/status` | Live SOC, power, and inverter mode |
| `POST /battery/control/charge` | Force battery to charge (sets SOC floor to charge_soc) |
| `POST /battery/control/discharge` | Allow battery to discharge (sets SOC floor to discharge_soc) |
| `POST /battery/control/idle` | Hold battery at current SOC |
| `POST /battery/control/peak-shaving` | Set grid import cap: `{"limit_kw": 4.5}` |

Manual overrides via the control endpoints last until the next 15-minute
execute cycle resumes schedule-based control.

---

## Monitoring

### Logs

```bash
pm2 logs solar-forecast          # live stream
pm2 logs solar-forecast --lines 200
```

Log files are also written to `logs/app.log` (rotated at 10 MB).

### Health check

```bash
curl http://localhost:3000/health
```

Returns `ok: true` when all pipelines have run within their expected intervals:

| Pipeline | Expected interval |
|---|---|
| fetch | 6 hours |
| learn | 1 hour |
| smooth | 24 hours |
| battery | 1 hour |
| consumption | 1 hour |
| snapshot | 15 minutes |
| execute | 15 minutes |

### Forecast accuracy

```bash
curl http://localhost:3000/api/metrics
```

Reports mean absolute error (MAE) between predicted and actual production.
Accuracy improves as the correction matrix accumulates data over weeks.

---

## Troubleshooting

### Inverter unreachable — "Port not Open" or TCP timeout

The Growatt datalogger rate-limits connections after rapid successive
requests. **Wait 5–10 minutes** before retrying. The driver has a 10-second
connect timeout and 1-second inter-command throttle to minimise this.

If the error persists after waiting, check:
- Datalogger is powered and on the network (`ping 192.168.1.180`)
- `inverter.port` is 502 (standard Modbus TCP)
- No other tool is holding a connection to the datalogger

### Recency bias clamped warning

```
[model] Recency bias clamped 2.46 → 2 (check for metering error)
```

This fires when the global actual/forecast ratio is outside `[0.5, 2.0]`.
Common early in operation when the correction matrix has few samples and
the base physics model is still poorly calibrated. As the matrix learns
over weeks the bias will settle toward 1.0. If it persists beyond a month,
check that `panel.peak_kw` is correct in config.

### Savings estimate is negative

Normal when starting SOC is low — the optimizer must charge heavily before
it can discharge, and the charging cost dominates the 24 h window. The
strategy is still correct. The savings figure becomes meaningful once the
battery cycles through a full day starting from a typical SOC (~50–60%).

### Schedule has no charge slots

Either prices are flat (no arbitrage opportunity) or tomorrow's prices
haven't published yet. Day-ahead prices typically publish around 13:00 CET.
The `day_ahead_hour` config value triggers a replan when they arrive.

### PM2 process restarts in a loop

Check startup errors:
```bash
pm2 logs solar-forecast --lines 50 --err
```

Config validation runs first — a bad config.js will print a clear error
and exit. Fix the reported field and restart.

### Consumption readings are zero or missing

The consumption pipeline runs at :05 each hour and computes the delta
between energy snapshots at the current and previous hour boundary. If the
snapshot pipeline was down during either boundary, the delta falls back to
an instantaneous reading. Run:

```bash
node scripts/backfill-consumption.js --dry-run
```

to preview gaps, then without `--dry-run` to fill them.

---

## Adding a price provider

Create `src/prices/<name>.js` exporting:
```js
export async function fetchPricesForDate(dateStr, region)
// Returns { prices: [{ slot_ts, spot_price, region }], raw } or null
// Must return 96 slots (4 × 15 min per hour) for the full day
// slot_ts format: "YYYY-MM-DDTHH:MM" in configured timezone
```

Register the name in `src/price-fetcher.js` and add it to
`KNOWN_PRICE_SOURCES` in `src/config-validator.js`.

## Adding an inverter driver

Create `src/inverters/<name>.js` exporting:
```js
export async function getState(cfg)       // → { soc, power_w, mode }
export async function applySchedule(slots, cfg)  // → { applied, skipped }
export async function resetToDefault(cfg)
export async function charge(cfg)         // → { soc, target }
export async function discharge(cfg)      // → { soc, target }
export async function idle(cfg)           // → { soc, target }
```

Register the name in `src/inverter-dispatcher.js` and
`src/config-validator.js`.
