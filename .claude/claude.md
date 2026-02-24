# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Rules

- Always update `design.md` or `battery-optimizer.md` when adding or changing functionality.
- Always create a todo list before starting work so tasks can be picked up across sessions.

## Commands

```bash
# Install dependencies
npm install

# --- Production (PM2) ---
pm2 start ecosystem.config.cjs    # start as managed service
pm2 stop solar-forecast           # stop
pm2 restart solar-forecast        # restart
pm2 logs solar-forecast           # stream logs (Ctrl+C to exit)
pm2 logs solar-forecast --lines 200  # last 200 lines
pm2 save && pm2 startup           # auto-start on Windows reboot

# Log files (also written directly by the app)
#   logs/app.log       — app log (rotated at 10 MB)
#   logs/pm2-out.log   — PM2 stdout capture
#   logs/pm2-error.log — PM2 stderr capture

# --- Development ---
node scheduler.js                 # run directly (no auto-restart)
node run-once.js                  # one-shot: fetch → parse → model → data/forecast.json
node run-battery-once.js          # one-shot: prices → consumption → optimize
```

There are no test scripts. Manual one-shot scripts serve as integration tests.

## Architecture

Node.js ESM project (`"type": "module"`). No build step. Entry point is `scheduler.js` for production.

### Two modules in one repo

1. **Solar Forecast** — predicts hourly PV production using Open-Meteo irradiance data + an empirical correction matrix learned from actuals.
2. **Battery Optimizer** — uses the forecast + spot prices + estimated consumption to produce a 24h charge/discharge schedule, then pushes it to inverter hardware every 15 minutes.

### Data pipeline

```
fetcher.js → data/raw/*.json → parser.js → solar_readings (DB)
                                               ↓
model.js (irradiance × correction_matrix) → prod_forecast
                                               ↓
learner.js (prod_actual / prod_forecast) → correction_matrix
                                               ↓
smoother.js (Gaussian kernel, σ=3 days) → correction_matrix / correction_matrix_smooth
```

Battery pipeline:

```
price-fetcher.js + consumption.js + driver.getState()
        ↓
optimizer.js → battery_schedule (DB) → inverter-dispatcher.js → driver.applySchedule()
```

### Key files

| File | Purpose |
|------|---------|
| `config.js` | All installation-specific settings (location, panel, battery, inverter, prices) |
| `scheduler.js` | Express server + all cron jobs; orchestrates every pipeline |
| `src/db.js` | SQLite connection, schema init, all query helpers |
| `src/timeutils.js` | Timezone-safe timestamp parsing — operates on `"YYYY-MM-DDTHH:MM"` strings directly, no `Date` objects |
| `src/model.js` | Physics fallback + empirical blending for production forecast |
| `src/optimizer.js` | Greedy solar-aware charge/discharge pairing |
| `src/inverter-dispatcher.js` | Selects inverter driver from `config.inverter.brand` |
| `src/inverters/growatt-modbus.js` | Modbus TCP driver for Growatt MOD TL3-XH |
| `src/inverters/growatt.js` | Growatt cloud API driver (MIN/MIX series) |
| `src/prices/elprisetjust.js` | Nordic spot price provider (15-min) |
| `src/prices/awattar.js` | DE/AT spot price provider |

### Scheduler cron jobs

| Schedule | Pipeline |
|----------|---------|
| Every 6 hours | `fetchPipeline` — fetch Open-Meteo → parse → model |
| Hourly at :00 | `learnPipeline` — update correction matrix from actuals |
| Hourly at :05 | `consumptionPipeline` — read inverter telemetry → `consumption_readings` + `prod_actual` |
| Hourly at :30 | `batteryPipeline` — prices → consumption → optimize |
| Daily at 02:00 | `smoothPipeline` — re-smooth correction matrix |
| Day-ahead hour +15 min | `batteryPipeline` — re-optimize when tomorrow's prices publish |
| Every 15 min | `executePipeline` — push schedule slot to inverter hardware |

### Adding a price provider

Create `src/prices/<name>.js` exporting `fetchPricesForDate(dateStr, region)`. Must return 96 slots (4×15 min per hour) with `slot_ts` in `"YYYY-MM-DDTHH:MM"` format (configured timezone). Register in `src/price-fetcher.js`.

### Adding an inverter driver

Create `src/inverters/<name>.js` exporting `getState(cfg)`, `applySchedule(schedule, cfg)`, `resetToDefault(cfg)`, and optionally `getMetrics(cfg)`. Register in `src/inverter-dispatcher.js`.

### Timezone handling

All timestamps throughout the system are in `config.location.timezone`. Open-Meteo receives the timezone parameter and returns local timestamps. `src/timeutils.js` parses DB strings directly — never use `new Date()` with these strings as it will apply system timezone.

### Inverter hardware notes (Growatt MOD TL3-XH Modbus TCP)

- Datalogger: `192.168.1.180:502`
- Control register: **holding 3310** (`LoadFirstStopSocSet`) — discharge floor SOC. Register 808 mirrors it; doc's 3082 does not work.
- Battery SOC: **input 3171** (not 3014 — that returns 0)
- Battery current: **input 3170** (signed, 0.1A units; negative = charging)
- Most storage input registers (3000–3040) return 0 on this datalogger
- Rate-limit: wait a few minutes if "Port not Open" errors appear after rapid connections
- Always test with `dry_run: true` before enabling live writes
