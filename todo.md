# Battery Optimizer — Implementation Todo

Three features planned for the LP optimizer. Architecture is documented in `battery-optimizer.md` (Roadmap section). Do not start tasks until reviewed.

Recommended order: A → B → C (dependencies increase; each feature is independent but C builds on B's helper).

---

## Feature A — Sell Energy in LP ✅ Done 2026-03-13

Pure LP formulation change. No DB schema changes. No new API endpoints.

### A1 — Config ✅
- [x] Add `grid.max_export_w: 4000` to `config.js` with comment (hardware export cap)
- [x] Update `config.js` comment for `sell_enabled` to reference the LP as the consumer

### A2 — LP formulation (`src/optimizer-lp.js`) ✅
- [x] Add `sell_t` variable (W) per slot to the LP variable set
- [x] Compute `maxSellW[t]`: `0` when `!grid.sell_enabled` or `sell_price[t] <= 0`; else `min(grid.max_export_w, bat.max_discharge_w)`
- [x] Add `sell_t` bounds to the LP string: `0 <= sell_t <= maxSellW[t]`
- [x] Add joint discharge constraint per slot: `d_t + sell_t <= max_discharge_w` (as a `Subject To` row)
- [x] Update SOC continuity constraint: add `− h·sell_t` term → `s_{t+1} = s_t + η·h·(cg + cs) − h·d − h·sell`
- [x] Update objective: add `−sell_price[t] × h/1000 × sell_t` term per slot
- [x] In solution parsing (step 6): extract `sell_t` primal value; if `> NOISE_W`, set `action = 'sell'`, `watts = sell_t`. Priority order: `charge_grid` > `discharge` > `sell` > `charge_solar`
- [x] Update savings summary (step 7): subtract sell revenue from `costWith` for `sell` slots

### A3 — Validation
- [ ] Verify `sell` slots appear correctly in `data/battery-schedule.json` output (sold kWh in summary)

### A4 — Docs & validation
- [ ] Update LP formulation table in `battery-optimizer.md` to include `sell_t` variable and updated SOC equation
- [ ] Remove "Sell-to-grid not yet modeled" note from LP section
- [ ] Run `node run-battery-once.js` with `sell_enabled: true` in config to verify LP picks sell slots when profitable
- [ ] Run with `sell_enabled: false` to verify no sell slots appear

---

## Feature B — Time-varying Peak Shaving Limit

The scheduler infrastructure is already complete (`getPeakShavingLimit` + `executePipeline` calling `setPeakShavingTarget` every 15 min). This feature is about enabling it correctly and closing two gaps.

### B1 — Config (`config.js`)
- [ ] Set `peak_shaving.enabled: true` (schedule examples and default_kw: 4.4 are already correct)

### B2 — Midnight-spanning window support
- [ ] Decide: document-only or fix the code
  - **Option 1 (simple):** add a comment in config and `config-validator.js` explaining the split requirement — no code change
  - **Option 2 (better UX):** update `getPeakShavingLimit` in `scheduler.js` to handle `from > to` as overnight span (e.g. `22:00–06:00`); update validator to allow `from >= to` when the intent is overnight
- [ ] Update `config-validator.js` accordingly (relax or remove the `from < to` assertion if Option 2)

### B3 — Startup write (`scheduler.js`)
- [ ] After driver is confirmed available at startup, compute the schedule-appropriate limit for the current time and call `driver.setPeakShavingTarget(limit, cfg)` if `peak_shaving.enabled`
- [ ] Log: `[startup] Peak shaving limit set: X kW`

### B4 — Docs & validation
- [ ] Update the Peak Shaving section in `battery-optimizer.md` to reflect that the feature is enabled and working
- [ ] Update implementation status table: mark "Peak shaving schedule" Done
- [ ] Test: set a night window, restart app, verify register 800 reads the schedule limit during the window and reverts to 4.5 kW outside it

---

## Feature C — EV Charging Recognition

Largest scope: DB migration, API, consumption pipeline, consumption estimator, LP input.

### C1 — DB migration
- [ ] In `src/db.js`, add migration block (after existing migrations): `ALTER TABLE consumption_readings ADD COLUMN ev_detected INTEGER DEFAULT 0` guarded by `PRAGMA table_info` column check
- [ ] Add `ev_schedule` table to schema init:
  ```sql
  CREATE TABLE IF NOT EXISTS ev_schedule (
    id        INTEGER PRIMARY KEY,
    start_ts  DATETIME NOT NULL,
    end_ts    DATETIME NOT NULL,
    power_w   REAL NOT NULL,
    note      TEXT
  );
  ```
- [ ] Add DB helper `flagEvDetected(hourTs, detected)` — upsert `ev_detected` on `consumption_readings`
- [ ] Add DB helper `upsertEvSession({ start_ts, end_ts, power_w, note })` → returns inserted `id`
- [ ] Add DB helper `deleteEvSession(id)`
- [ ] Add DB helper `getUpcomingEvSessions(fromTs)` — returns sessions with `end_ts >= fromTs`

### C2 — EV detection in consumption pipeline (`scheduler.js` / `src/consumption.js`)
- [ ] In `consumptionPipeline`, after writing to `consumption_readings`, call `flagEvDetected(hourTs, consumption_w > config.consumption.max_house_w)`
- [ ] Log when EV charging is detected: `[consumption] EV charging detected at HH:00 (XXXX W > max_house_w)`

### C3 — API endpoints (`src/battery-api.js`)
- [ ] `GET /battery/ev-schedule` — return upcoming EV sessions from `getUpcomingEvSessions(now)`
- [ ] `POST /battery/ev-schedule` — body: `{ start_ts, end_ts, power_w, note? }`; validate fields; call `upsertEvSession`; return created session with `id`
- [ ] `DELETE /battery/ev-schedule/:id` — call `deleteEvSession(id)`; 404 if not found
- [ ] Input validation: `start_ts < end_ts`, `power_w > 0`, timestamps in `YYYY-MM-DDTHH:MM` format

### C4 — Consumption estimator (`src/consumption.js`)
- [ ] Import `getUpcomingEvSessions` from `src/db.js`
- [ ] After building the hourly consumption estimate array, overlay EV sessions: for each session, find overlapping `hour_ts` entries and add `session.power_w` to `consumption_w`
- [ ] Log overlay: `[consumption] EV session overlays HH:00–HH:00 (+XXXX W)`

### C5 — Docs & validation
- [ ] Add EV schedule table schema to `battery-optimizer.md` (Database section)
- [ ] Add EV API endpoints to the API section
- [ ] Update the architecture diagram in `battery-optimizer.md` to show `ev_schedule → estimateConsumption → LP`
- [ ] Declare a test EV session via `POST /battery/ev-schedule` and run `node run-battery-once.js` — confirm LP grid-charges before the session window
- [ ] Confirm `ev_detected` is set correctly on historical rows by inspecting `consumption_readings`

---

## Post-feature

- [ ] Update implementation status table in `battery-optimizer.md` to mark each feature Done
