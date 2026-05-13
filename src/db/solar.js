import db from './db-instance.js';

const stmts = {
  upsertReading: db.prepare(`
    INSERT INTO solar_readings (hour_ts, irr_forecast, cloud_cover)
    VALUES (?, ?, ?)
    ON CONFLICT(hour_ts) DO UPDATE SET
      irr_forecast = excluded.irr_forecast,
      cloud_cover = excluded.cloud_cover
  `),
  updateForecast: db.prepare(`
    UPDATE solar_readings
    SET prod_forecast = ?, confidence = ?, correction_applied = ?
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
    SELECT * FROM solar_readings
    WHERE prod_actual IS NOT NULL AND correction IS NULL
    ORDER BY hour_ts ASC
  `),
  getReadingsForForecast: db.prepare(`
    SELECT * FROM solar_readings
    WHERE hour_ts >= ? AND hour_ts <= ?
    ORDER BY hour_ts ASC
  `),
  getSolarReadingsForRange: db.prepare(`
    SELECT * FROM solar_readings
    WHERE hour_ts >= ? AND hour_ts <= ?
    ORDER BY hour_ts ASC
  `),
  getReadingsWithoutForecast: db.prepare(`
    SELECT * FROM solar_readings
    WHERE prod_forecast IS NULL AND irr_forecast IS NOT NULL
    ORDER BY hour_ts ASC
  `),
  getCorrectionCell: db.prepare(`
    SELECT * FROM correction_matrix
    WHERE month = ? AND day_of_month = ? AND hour_of_day = ?
  `),
  updateCorrectionMatrix: db.prepare(`
    UPDATE correction_matrix
    SET correction_avg = ?, sample_count = ?, total_weight = ?, max_prod = ?, last_updated = CURRENT_TIMESTAMP
    WHERE month = ? AND day_of_month = ? AND hour_of_day = ?
  `),
  getAllCorrections: db.prepare('SELECT * FROM correction_matrix'),
  upsertSmooth: db.prepare(`
    INSERT INTO correction_matrix_smooth (month, day_of_month, hour_of_day, correction_avg, sample_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(month, day_of_month, hour_of_day) DO UPDATE SET
      correction_avg = excluded.correction_avg,
      sample_count = excluded.sample_count
  `),
  getSmoothCell: db.prepare(`
    SELECT * FROM correction_matrix_smooth
    WHERE month = ? AND day_of_month = ? AND hour_of_day = ?
  `),
  getReadingsForSmoothing: db.prepare(`
    SELECT * FROM solar_readings
    WHERE prod_actual IS NOT NULL AND prod_forecast IS NOT NULL AND confidence > 0
  `),
  getRecentActualsForBias: db.prepare(`
    SELECT prod_actual, prod_forecast, irr_forecast
    FROM solar_readings
    WHERE hour_ts >= ? AND prod_actual IS NOT NULL AND prod_forecast IS NOT NULL AND prod_forecast > 0
  `),
  getLastActualForHour: db.prepare(`
    SELECT prod_actual FROM solar_readings
    WHERE prod_actual IS NOT NULL AND strftime('%H', hour_ts) = ?
    ORDER BY hour_ts DESC LIMIT 1
  `),
  getSolarMAE: db.prepare(`
    SELECT 
      AVG(ABS(prod_actual - prod_forecast)) as mae,
      COUNT(*) as samples
    FROM solar_readings
    WHERE hour_ts >= ? AND prod_actual IS NOT NULL AND prod_forecast IS NOT NULL
  `),
  getIntradaySolarRatio: db.prepare(`
    SELECT 
      SUM(prod_actual) as actual_sum, 
      SUM(prod_forecast) as forecast_sum
    FROM solar_readings
    WHERE hour_ts LIKE ? || '%' 
      AND prod_actual IS NOT NULL 
      AND prod_forecast IS NOT NULL 
      AND irr_forecast >= ?
  `),
  getIntradaySolarRatioByBand: db.prepare(`
    SELECT 
      (CAST(cloud_cover / 25 AS INTEGER) * 25) as band,
      SUM(prod_actual) as actual_sum,
      SUM(prod_forecast) as forecast_sum,
      COUNT(*) as sample_count
    FROM solar_readings
    WHERE hour_ts LIKE ? || '%'
      AND prod_actual IS NOT NULL
      AND prod_forecast IS NOT NULL
      AND irr_forecast >= ?
      AND cloud_cover IS NOT NULL
    GROUP BY band
  `)
};

export function upsertReading(hourTs, irrForecast, cloudCover = null) {
  return stmts.upsertReading.run(hourTs, irrForecast, cloudCover);
}

export function updateForecast(hourTs, prodForecast, confidence, correctionApplied) {
  return stmts.updateForecast.run(prodForecast, confidence, correctionApplied, hourTs);
}

export function updateActual(hourTs, prodActual) {
  return stmts.updateActual.run(prodActual, hourTs);
}

export function updateCorrection(hourTs, correction) {
  return stmts.updateCorrection.run(correction, hourTs);
}

export function upsertYrDataBatch(rows) {
  const upsert = db.prepare(`
    UPDATE solar_readings
    SET cloud_cover_yr = ?
    WHERE hour_ts = ?
  `);
  const runBatch = db.transaction((rows) => {
    for (const row of rows) upsert.run(row.cloud_cover_yr, row.hour_ts);
  });
  runBatch(rows);
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

export function getIntradaySolarRatio(dateStr, minIrr = 10, minSamples = 2) {
  const row = stmts.getIntradaySolarRatio.get(dateStr, minIrr);
  if (!row || row.actual_sum === null || row.forecast_sum === null) return null;
  return row.actual_sum / row.forecast_sum;
}

export function getIntradaySolarRatioByBand(dateStr, minIrr = 10) {
  return stmts.getIntradaySolarRatioByBand.all(dateStr, minIrr);
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

export function upsertSmooth(month, dayOfMonth, hourOfDay, correctionAvg, sampleCount) {
  return stmts.upsertSmooth.run(month, dayOfMonth, hourOfDay, correctionAvg, sampleCount);
}

export function getSmoothCell(month, dayOfMonth, hourOfDay) {
  return stmts.getSmoothCell.get(month, dayOfMonth, hourOfDay);
}

export function getReadingsForSmoothing() {
  return stmts.getReadingsForSmoothing.all();
}

export function getRecentActualsForBias(fromTs) {
  return stmts.getRecentActualsForBias.all(fromTs);
}

export function getLastActualForHour(hourOfDay) {
  const hStr = String(hourOfDay).padStart(2, '0');
  return stmts.getLastActualForHour.get(hStr);
}

export function getSolarMAE(fromTs) {
  return stmts.getSolarMAE.get(fromTs);
}
