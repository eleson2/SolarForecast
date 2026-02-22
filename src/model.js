import config from '../config.js';
import { getReadingsWithoutForecast, getCorrectionCell, updateForecast } from './db.js';
import { parseTs } from './timeutils.js';

/**
 * Geometry-based fallback correction factor.
 * Simple cosine approximation based on panel tilt — not precise,
 * but the learning system will correct it over time.
 */
function geometryCorrection(month, hour) {
  // Approximate solar noon performance factor based on tilt
  // This is intentionally simplistic — the empirical matrix will take over
  const tiltRad = (config.panel.tilt * Math.PI) / 180;
  const seasonFactor = 1.0 - 0.15 * Math.abs(month - 6.5) / 5.5; // peaks in summer
  const hourFactor = Math.max(0, Math.cos(((hour - 12) * Math.PI) / 12)); // peaks at noon
  return Math.cos(tiltRad) * seasonFactor * Math.max(0.1, hourFactor);
}

/**
 * Forecast production for all readings that have irradiance but no forecast yet.
 */
export function runModel() {
  const rows = getReadingsWithoutForecast();
  if (rows.length === 0) {
    console.log('[model] No new readings to forecast');
    return 0;
  }

  let count = 0;
  for (const row of rows) {
    const { month, day, hour } = parseTs(row.hour_ts);

    // Get learned correction
    const cell = getCorrectionCell(month, day, hour);
    const matrixCorrection = cell ? cell.correction_avg : 1.0;
    const sampleCount = cell ? cell.sample_count : 0;

    // Blend empirical vs geometry based on observation count
    const empiricalWeight = Math.min(1.0, sampleCount / config.learning.empirical_blend_threshold);
    const geoCorrection = geometryCorrection(month, hour);
    const correction = (empiricalWeight * matrixCorrection)
                     + ((1 - empiricalWeight) * geoCorrection);

    // Core formula: prod_forecast = peak_kw × (irr_forecast / 1000) × correction
    const prodForecast = config.panel.peak_kw * (row.irr_forecast / 1000) * correction;

    // Confidence based on irradiance level
    const confidence = Math.min(1.0, row.irr_forecast / config.learning.min_irradiance_weight);

    updateForecast(row.hour_ts, Math.max(0, prodForecast), confidence);
    count++;
  }

  console.log(`[model] Forecasted ${count} hours`);
  return count;
}
