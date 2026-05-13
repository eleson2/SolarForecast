import db from './db-instance.js';

const stmts = {
  upsertConsumption: db.prepare(`
    INSERT INTO consumption_readings (hour_ts, consumption_w, outdoor_temp, source)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hour_ts) DO UPDATE SET
      consumption_w = excluded.consumption_w,
      outdoor_temp = excluded.outdoor_temp,
      source = excluded.source
  `),
  getConsumptionForRange: db.prepare(`
    SELECT * FROM consumption_readings
    WHERE hour_ts >= ? AND hour_ts <= ?
    ORDER BY hour_ts ASC
  `),
  upsertEnergySnapshot: db.prepare(`
    INSERT INTO energy_snapshots (snapshot_ts, pv_today_kwh, load_today_kwh, grid_import_today_kwh, grid_export_today_kwh, battery_soc)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_ts) DO UPDATE SET
      pv_today_kwh = COALESCE(excluded.pv_today_kwh, energy_snapshots.pv_today_kwh),
      load_today_kwh = COALESCE(excluded.load_today_kwh, energy_snapshots.load_today_kwh),
      grid_import_today_kwh = COALESCE(excluded.grid_import_today_kwh, energy_snapshots.grid_import_today_kwh),
      grid_export_today_kwh = COALESCE(excluded.grid_export_today_kwh, energy_snapshots.grid_export_today_kwh),
      battery_soc = COALESCE(excluded.battery_soc, energy_snapshots.battery_soc)
  `),
  getSnapshotAtOrBefore: db.prepare(`
    SELECT * FROM energy_snapshots
    WHERE snapshot_ts <= ?
    ORDER BY snapshot_ts DESC LIMIT 1
  `),
  getSnapshotsForRange: db.prepare(`
    SELECT * FROM energy_snapshots
    WHERE snapshot_ts >= ? AND snapshot_ts <= ?
    ORDER BY snapshot_ts ASC
  `),
  getDaytimeConsumptionHistory: db.prepare(`
    SELECT outdoor_temp, consumption_w
    FROM consumption_readings
    WHERE outdoor_temp IS NOT NULL 
      AND consumption_w IS NOT NULL 
      AND (CAST(strftime('%H', hour_ts) AS INTEGER) BETWEEN 8 AND 18)
      AND consumption_w <= ?
  `),
  upsertConsumptionModel: db.prepare(`
    INSERT INTO consumption_model (model_key, slope, intercept, sample_count, r_squared, last_updated)
    VALUES ('daytime', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(model_key) DO UPDATE SET
      slope = excluded.slope,
      intercept = excluded.intercept,
      sample_count = excluded.sample_count,
      r_squared = excluded.r_squared,
      last_updated = excluded.last_updated
  `),
  getDaytimeConsumptionModel: db.prepare(`
    SELECT * FROM consumption_model WHERE model_key = 'daytime'
  `)
};

export function upsertConsumption(hourTs, consumptionW, outdoorTemp, source) {
  return stmts.upsertConsumption.run(hourTs, consumptionW, outdoorTemp, source);
}

export function getConsumptionForRange(fromTs, toTs) {
  return stmts.getConsumptionForRange.all(fromTs, toTs);
}

export function upsertEnergySnapshot(snapshotTs, pvTodayKwh, loadTodayKwh, gridImportTodayKwh, gridExportTodayKwh, batterySoc = null) {
  return stmts.upsertEnergySnapshot.run(snapshotTs, pvTodayKwh, loadTodayKwh, gridImportTodayKwh, gridExportTodayKwh, batterySoc);
}

export function getSnapshotAtOrBefore(ts) {
  return stmts.getSnapshotAtOrBefore.get(ts);
}

export function getSnapshotsForRange(fromTs, toTs) {
  return stmts.getSnapshotsForRange.all(fromTs, toTs);
}

export function getDaytimeConsumptionHistory(maxHouseW) {
  return stmts.getDaytimeConsumptionHistory.all(maxHouseW);
}

export function upsertConsumptionModel(slope, intercept, sampleCount, rSquared) {
  return stmts.upsertConsumptionModel.run(slope, intercept, sampleCount, rSquared);
}

export function getDaytimeConsumptionModel() {
  return stmts.getDaytimeConsumptionModel.get();
}
