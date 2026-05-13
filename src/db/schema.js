import db from './db-instance.js';

export function initSchema() {
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
      month           INTEGER,
      day_of_month    INTEGER,
      hour_of_day     INTEGER,
      correction_avg  REAL,
      sample_count    INTEGER,
      PRIMARY KEY (month, day_of_month, hour_of_day)
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
      grid_export_today_kwh REAL,
      battery_soc           REAL
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

  // --- pipeline_runs table (health-check) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      pipeline    TEXT PRIMARY KEY,
      last_run_ts TEXT,
      last_status TEXT
    )
  `);

  // --- Migrations ---
  
  // energy_snapshots: add battery_soc
  const esCols = db.prepare("PRAGMA table_info(energy_snapshots)").all();
  if (esCols.length > 0 && !esCols.some(c => c.name === 'battery_soc')) {
    db.exec('ALTER TABLE energy_snapshots ADD COLUMN battery_soc REAL');
  }

  // consumption_model: cleanup and recreate
  const cmCols = db.prepare("PRAGMA table_info(consumption_model)").all();
  if (cmCols.length > 0 && cmCols.some(c => c.name === 'hour_of_day')) {
    db.exec('DROP TABLE IF EXISTS consumption_model');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS consumption_model (
      model_key     TEXT PRIMARY KEY,
      slope         REAL,
      intercept     REAL,
      sample_count  INTEGER,
      r_squared     REAL,
      last_updated  DATETIME
    )
  `);

  // correction_matrix_smooth: migrate day_of_year to month/day/hour
  const smoothCols = db.prepare("PRAGMA table_info(correction_matrix_smooth)").all();
  if (smoothCols.length > 0 && smoothCols.some(c => c.name === 'day_of_year')) {
    db.exec('DROP TABLE correction_matrix_smooth');
    db.exec(`
      CREATE TABLE correction_matrix_smooth (
        month           INTEGER,
        day_of_month    INTEGER,
        hour_of_day     INTEGER,
        correction_avg  REAL,
        sample_count    INTEGER,
        PRIMARY KEY (month, day_of_month, hour_of_day)
      )
    `);
  }

  // correction_matrix: migrate month/hour to month/day/hour
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

  // solar_readings: add columns
  const srColumns = db.prepare("PRAGMA table_info(solar_readings)").all();
  if (!srColumns.some(c => c.name === 'correction_applied')) {
    db.exec(`ALTER TABLE solar_readings ADD COLUMN correction_applied REAL`);
  }
  if (!srColumns.some(c => c.name === 'cloud_cover')) {
    db.exec(`ALTER TABLE solar_readings ADD COLUMN cloud_cover REAL`);
  }
  if (!srColumns.some(c => c.name === 'fog_area_fraction')) {
    db.exec(`ALTER TABLE solar_readings ADD COLUMN fog_area_fraction REAL`);
  }
  if (!srColumns.some(c => c.name === 'cloud_cover_yr')) {
    db.exec(`ALTER TABLE solar_readings ADD COLUMN cloud_cover_yr REAL`);
  }

  // correction_matrix: add total_weight
  const hasWeight = db.prepare("PRAGMA table_info(correction_matrix)").all().some(c => c.name === 'total_weight');
  if (!hasWeight) {
    db.exec(`ALTER TABLE correction_matrix ADD COLUMN total_weight REAL DEFAULT 0`);
    db.exec(`UPDATE correction_matrix SET total_weight = sample_count WHERE sample_count > 0`);
  }

  // Seed correction_matrix
  const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const existingCount = db.prepare('SELECT COUNT(*) AS cnt FROM correction_matrix').get();
  if (existingCount.cnt === 0) {
    const insert = db.prepare(
      'INSERT INTO correction_matrix (month, day_of_month, hour_of_day, correction_avg, sample_count, max_prod, last_updated) VALUES (?, ?, ?, 1.0, 0, NULL, NULL)'
    );
    db.transaction(() => {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= DAYS_IN_MONTH[m]; d++) {
          for (let h = 0; h <= 23; h++) {
            insert.run(m, d, h);
          }
        }
      }
    })();
  }
}
