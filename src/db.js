import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'solar.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema initialization ---

db.exec(`
  CREATE TABLE IF NOT EXISTS solar_readings (
    id              INTEGER PRIMARY KEY,
    hour_ts         DATETIME UNIQUE,
    irr_forecast    REAL,
    prod_forecast   REAL,
    prod_actual     REAL,
    correction      REAL,
    confidence      REAL
  );

  CREATE TABLE IF NOT EXISTS correction_matrix (
    month           INTEGER,
    day_of_month    INTEGER,
    hour_of_day     INTEGER,
    correction_avg  REAL,
    sample_count    INTEGER,
    max_prod        REAL,
    last_updated    DATETIME,
    PRIMARY KEY (month, day_of_month, hour_of_day)
  );

  CREATE TABLE IF NOT EXISTS correction_matrix_smooth (
    day_of_year     INTEGER,
    hour_of_day     INTEGER,
    correction_avg  REAL,
    sample_count    INTEGER,
    PRIMARY KEY (day_of_year, hour_of_day)
  );

  CREATE TABLE IF NOT EXISTS price_readings (
    slot_ts         DATETIME PRIMARY KEY,
    spot_price      REAL,
    region          TEXT
  );

  CREATE TABLE IF NOT EXISTS consumption_readings (
    hour_ts         DATETIME PRIMARY KEY,
    consumption_w   REAL,
    outdoor_temp    REAL,
    source          TEXT
  );

  CREATE TABLE IF NOT EXISTS energy_snapshots (
    snapshot_ts           TEXT PRIMARY KEY,
    pv_today_kwh          REAL,
    load_today_kwh        REAL,
    grid_import_today_kwh REAL,
    grid_export_today_kwh REAL
  );

  CREATE TABLE IF NOT EXISTS battery_schedule (
    slot_ts           DATETIME PRIMARY KEY,
    action            TEXT,
    watts             REAL,
    soc_start         REAL,
    soc_end           REAL,
    price_kwh         REAL,
    solar_watts       REAL,
    consumption_watts REAL
  );
`);

// --- Migrate correction_matrix from old month×hour schema to month×day×hour ---

const columns = db.prepare("PRAGMA table_info(correction_matrix)").all();
const hasDayOfMonth = columns.some(c => c.name === 'day_of_month');
if (!hasDayOfMonth) {
  db.exec('DROP TABLE correction_matrix');
  db.exec(`
    CREATE TABLE correction_matrix (
      month           INTEGER,
      day_of_month    INTEGER,
      hour_of_day     INTEGER,
      correction_avg  REAL,
      sample_count    INTEGER,
      max_prod        REAL,
      last_updated    DATETIME,
      PRIMARY KEY (month, day_of_month, hour_of_day)
    )
  `);
}

// --- Migrate correction_matrix: add total_weight column if missing ---

const hasWeight = db.prepare("PRAGMA table_info(correction_matrix)").all().some(c => c.name === 'total_weight');
if (!hasWeight) {
  db.exec(`ALTER TABLE correction_matrix ADD COLUMN total_weight REAL DEFAULT 0`);
  // Existing rows used equal weight (1.0 per sample) — total_weight = sample_count
  db.exec(`UPDATE correction_matrix SET total_weight = sample_count WHERE sample_count > 0`);
}

// --- Seed correction_matrix with 8,784 rows (366 days × 24 hours) ---

const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const existingCount = db.prepare('SELECT COUNT(*) AS cnt FROM correction_matrix').get();
if (existingCount.cnt === 0) {
  const insert = db.prepare(
    'INSERT INTO correction_matrix (month, day_of_month, hour_of_day, correction_avg, sample_count, max_prod, last_updated) VALUES (?, ?, ?, 1.0, 0, NULL, NULL)'
  );
  const seedAll = db.transaction(() => {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= DAYS_IN_MONTH[m]; d++) {
        for (let h = 0; h <= 23; h++) {
          insert.run(m, d, h);
        }
      }
    }
  });
  seedAll();
}

// --- Query helpers ---

const stmts = {
  upsertReading: db.prepare(`
    INSERT INTO solar_readings (hour_ts, irr_forecast)
    VALUES (?, ?)
    ON CONFLICT(hour_ts) DO UPDATE SET irr_forecast = excluded.irr_forecast
  `),

  updateForecast: db.prepare(`
    UPDATE solar_readings
    SET prod_forecast = ?, confidence = ?
    WHERE hour_ts = ?
  `),

  updateActual: db.prepare(`
    UPDATE solar_readings
    SET prod_actual = ?
    WHERE hour_ts = ?
  `),

  updateCorrection: db.prepare(`
    UPDATE solar_readings
    SET correction = ?
    WHERE hour_ts = ?
  `),

  getUnprocessedActuals: db.prepare(`
    SELECT id, hour_ts, irr_forecast, prod_forecast, prod_actual
    FROM solar_readings
    WHERE prod_actual IS NOT NULL
      AND correction IS NULL
      AND prod_forecast IS NOT NULL
      AND prod_forecast > 0
  `),

  getReadingsForForecast: db.prepare(`
    SELECT hour_ts, irr_forecast, prod_forecast, confidence
    FROM solar_readings
    WHERE hour_ts >= ? AND hour_ts < ?
    ORDER BY hour_ts
  `),

  getSolarReadingsForRange: db.prepare(`
    SELECT hour_ts, irr_forecast, prod_forecast, prod_actual, confidence
    FROM solar_readings
    WHERE hour_ts >= ? AND hour_ts < ?
    ORDER BY hour_ts
  `),

  getReadingsWithoutForecast: db.prepare(`
    SELECT hour_ts, irr_forecast
    FROM solar_readings
    WHERE irr_forecast IS NOT NULL AND prod_forecast IS NULL
    ORDER BY hour_ts
  `),

  getCorrectionCell: db.prepare(`
    SELECT correction_avg, sample_count, total_weight, max_prod
    FROM correction_matrix
    WHERE month = ? AND day_of_month = ? AND hour_of_day = ?
  `),

  updateCorrectionMatrix: db.prepare(`
    UPDATE correction_matrix
    SET correction_avg = ?, sample_count = ?, total_weight = ?, max_prod = ?, last_updated = datetime('now')
    WHERE month = ? AND day_of_month = ? AND hour_of_day = ?
  `),

  getAllCorrections: db.prepare(`
    SELECT month, day_of_month, hour_of_day, correction_avg, sample_count, max_prod
    FROM correction_matrix
    ORDER BY month, day_of_month, hour_of_day
  `),

  upsertSmooth: db.prepare(`
    INSERT INTO correction_matrix_smooth (day_of_year, hour_of_day, correction_avg, sample_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(day_of_year, hour_of_day) DO UPDATE
    SET correction_avg = excluded.correction_avg, sample_count = excluded.sample_count
  `),

  getSmoothCell: db.prepare(`
    SELECT correction_avg, sample_count
    FROM correction_matrix_smooth
    WHERE day_of_year = ? AND hour_of_day = ?
  `),

  getReadingsForSmoothing: db.prepare(`
    SELECT hour_ts, correction, confidence, prod_actual
    FROM solar_readings
    WHERE correction IS NOT NULL AND confidence IS NOT NULL
  `),
};

export function upsertReading(hourTs, irrForecast) {
  return stmts.upsertReading.run(hourTs, irrForecast);
}

export function updateForecast(hourTs, prodForecast, confidence) {
  return stmts.updateForecast.run(prodForecast, confidence, hourTs);
}

export function updateActual(hourTs, prodActual) {
  return stmts.updateActual.run(prodActual, hourTs);
}

export function updateCorrection(hourTs, correction) {
  return stmts.updateCorrection.run(correction, hourTs);
}

export function getUnprocessedActuals() {
  return stmts.getUnprocessedActuals.all();
}

export function getReadingsForForecast(fromTs, toTs) {
  return stmts.getReadingsForForecast.all(fromTs, toTs);
}

export function getSolarReadingsForRange(fromTs, toTs) {
  return stmts.getSolarReadingsForRange.all(fromTs, toTs);
}

export function getReadingsWithoutForecast() {
  return stmts.getReadingsWithoutForecast.all();
}

export function getCorrectionCell(month, dayOfMonth, hourOfDay) {
  return stmts.getCorrectionCell.get(month, dayOfMonth, hourOfDay);
}

export function updateCorrectionMatrix(month, dayOfMonth, hourOfDay, correctionAvg, sampleCount, totalWeight, maxProd) {
  return stmts.updateCorrectionMatrix.run(correctionAvg, sampleCount, totalWeight, maxProd, month, dayOfMonth, hourOfDay);
}

export function getAllCorrections() {
  return stmts.getAllCorrections.all();
}

export function upsertSmooth(dayOfYear, hourOfDay, correctionAvg, sampleCount) {
  return stmts.upsertSmooth.run(dayOfYear, hourOfDay, correctionAvg, sampleCount);
}

export function getSmoothCell(dayOfYear, hourOfDay) {
  return stmts.getSmoothCell.get(dayOfYear, hourOfDay);
}

export function getReadingsForSmoothing() {
  return stmts.getReadingsForSmoothing.all();
}

// --- Battery optimizer query helpers ---

const batteryStmts = {
  upsertPrice: db.prepare(`
    INSERT INTO price_readings (slot_ts, spot_price, region)
    VALUES (?, ?, ?)
    ON CONFLICT(slot_ts) DO UPDATE SET spot_price = excluded.spot_price, region = excluded.region
  `),

  getPricesForRange: db.prepare(`
    SELECT slot_ts, spot_price, region
    FROM price_readings
    WHERE slot_ts >= ? AND slot_ts < ?
    ORDER BY slot_ts
  `),

  upsertConsumption: db.prepare(`
    INSERT INTO consumption_readings (hour_ts, consumption_w, outdoor_temp, source)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hour_ts) DO UPDATE SET
      consumption_w = excluded.consumption_w,
      outdoor_temp = excluded.outdoor_temp,
      source = excluded.source
  `),

  getConsumptionForRange: db.prepare(`
    SELECT hour_ts, consumption_w, outdoor_temp, source
    FROM consumption_readings
    WHERE hour_ts >= ? AND hour_ts < ?
    ORDER BY hour_ts
  `),

  upsertSchedule: db.prepare(`
    INSERT INTO battery_schedule (slot_ts, action, watts, soc_start, soc_end, price_kwh, solar_watts, consumption_watts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slot_ts) DO UPDATE SET
      action = excluded.action,
      watts = excluded.watts,
      soc_start = excluded.soc_start,
      soc_end = excluded.soc_end,
      price_kwh = excluded.price_kwh,
      solar_watts = excluded.solar_watts,
      consumption_watts = excluded.consumption_watts
  `),

  getScheduleForRange: db.prepare(`
    SELECT slot_ts, action, watts, soc_start, soc_end, price_kwh, solar_watts, consumption_watts
    FROM battery_schedule
    WHERE slot_ts >= ? AND slot_ts < ?
    ORDER BY slot_ts
  `),

  deleteScheduleForRange: db.prepare(`
    DELETE FROM battery_schedule
    WHERE slot_ts >= ? AND slot_ts < ?
  `),
};

export function upsertPrice(slotTs, spotPrice, region) {
  return batteryStmts.upsertPrice.run(slotTs, spotPrice, region);
}

export function upsertPricesBatch(prices) {
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      batteryStmts.upsertPrice.run(r.slot_ts, r.spot_price, r.region);
    }
  });
  return tx(prices);
}

export function getPricesForRange(fromTs, toTs) {
  return batteryStmts.getPricesForRange.all(fromTs, toTs);
}

export function upsertConsumption(hourTs, consumptionW, outdoorTemp, source) {
  return batteryStmts.upsertConsumption.run(hourTs, consumptionW, outdoorTemp, source);
}

export function getConsumptionForRange(fromTs, toTs) {
  return batteryStmts.getConsumptionForRange.all(fromTs, toTs);
}

export function upsertScheduleBatch(slots) {
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      batteryStmts.upsertSchedule.run(
        r.slot_ts, r.action, r.watts, r.soc_start, r.soc_end,
        r.price_kwh, r.solar_watts, r.consumption_watts
      );
    }
  });
  return tx(slots);
}

export function getScheduleForRange(fromTs, toTs) {
  return batteryStmts.getScheduleForRange.all(fromTs, toTs);
}

export function deleteScheduleForRange(fromTs, toTs) {
  return batteryStmts.deleteScheduleForRange.run(fromTs, toTs);
}

// --- Energy snapshot helpers (daily cumulative totals → hourly delta consumption) ---

const energyStmts = {
  upsertSnapshot: db.prepare(`
    INSERT INTO energy_snapshots (snapshot_ts, pv_today_kwh, load_today_kwh, grid_import_today_kwh, grid_export_today_kwh)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_ts) DO UPDATE SET
      pv_today_kwh          = excluded.pv_today_kwh,
      load_today_kwh        = excluded.load_today_kwh,
      grid_import_today_kwh = excluded.grid_import_today_kwh,
      grid_export_today_kwh = excluded.grid_export_today_kwh
  `),

  // Get the most recent snapshot at or before a given timestamp
  getSnapshotAtOrBefore: db.prepare(`
    SELECT * FROM energy_snapshots
    WHERE snapshot_ts <= ?
    ORDER BY snapshot_ts DESC
    LIMIT 1
  `),

  getSnapshotsForRange: db.prepare(`
    SELECT * FROM energy_snapshots
    WHERE snapshot_ts >= ? AND snapshot_ts <= ?
    ORDER BY snapshot_ts
  `),

  // Most recent prod_actual + irr_forecast for a given hour-of-day (for model fallback)
  getLastActualForHour: db.prepare(`
    SELECT prod_actual, irr_forecast
    FROM solar_readings
    WHERE strftime('%H', hour_ts) = ?
      AND prod_actual IS NOT NULL
      AND irr_forecast IS NOT NULL
      AND irr_forecast > 0
    ORDER BY hour_ts DESC
    LIMIT 1
  `),
};

export function upsertEnergySnapshot(snapshotTs, pvTodayKwh, loadTodayKwh, gridImportTodayKwh, gridExportTodayKwh) {
  return energyStmts.upsertSnapshot.run(snapshotTs, pvTodayKwh, loadTodayKwh, gridImportTodayKwh, gridExportTodayKwh);
}

export function getSnapshotAtOrBefore(ts) {
  return energyStmts.getSnapshotAtOrBefore.get(ts);
}

export function getSnapshotsForRange(fromTs, toTs) {
  return energyStmts.getSnapshotsForRange.all(fromTs, toTs);
}

export function getLastActualForHour(hourOfDay) {
  const hStr = String(hourOfDay).padStart(2, '0');
  return energyStmts.getLastActualForHour.get(hStr);
}

export default db;
