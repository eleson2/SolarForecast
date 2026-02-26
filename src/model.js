import config from '../config.js';
import { getReadingsWithoutForecast, getCorrectionCell, updateForecast, getLastActualForHour, getRecentActualsForBias } from './db.js';
import { parseTs } from './timeutils.js';

// Half-saturation constant for irradiance weighting — matches learner.js
const WEIGHT_K = 50;

/**
 * Compute the global recency bias scalar b.
 *
 * b = irradiance-weighted mean of (prod_actual / prod_forecast) over the last
 * window_days days. It captures short-term systematic deviations (dirty panel,
 * new obstruction) that the slow-moving correction matrix hasn't absorbed yet.
 *
 * Returns 1.0 if there is insufficient high-quality data in the window.
 */
function computeRecencyBias() {
  const { window_days, min_samples, clamp_min, clamp_max } = config.learning.recency_bias;

  // Window start as a timestamp string. UTC-based; ~1–2 h error is irrelevant
  // for a 14-day window filtered against local-time strings in the DB.
  const fromTs = new Date(Date.now() - window_days * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 16);

  const rows = getRecentActualsForBias(fromTs);

  let weightedSum = 0;
  let totalWeight = 0;

  for (const row of rows) {
    const residual = row.prod_actual / row.prod_forecast;
    const w = row.irr_forecast / (row.irr_forecast + WEIGHT_K);
    weightedSum += residual * w;
    totalWeight += w;
  }

  if (totalWeight < min_samples) {
    console.log(`[model] Recency bias: insufficient data (weight ${totalWeight.toFixed(1)} < ${min_samples}), using 1.0`);
    return 1.0;
  }

  const raw = weightedSum / totalWeight;
  const clamped = Math.max(clamp_min, Math.min(clamp_max, raw));

  if (clamped !== raw) {
    console.warn(`[model] Recency bias clamped ${raw.toFixed(3)} → ${clamped} (check for metering error)`);
  } else {
    console.log(`[model] Recency bias: ${raw.toFixed(3)} (${rows.length} samples, weight ${totalWeight.toFixed(1)})`);
  }

  return clamped;
}

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

  const biasScalar = computeRecencyBias();

  let count = 0;
  for (const row of rows) {
    const { month, day, hour } = parseTs(row.hour_ts);

    // Get learned correction
    const cell = getCorrectionCell(month, day, hour);
    const matrixCorrection = cell ? cell.correction_avg : 1.0;
    const sampleCount = cell ? cell.sample_count : 0;

    // Blend empirical vs fallback based on observation count
    const empiricalWeight = Math.min(1.0, sampleCount / config.learning.empirical_blend_threshold);

    // When matrix has no data, try to seed from the most recent actual for this hour.
    // Back-calculate an implied correction: actual / (peak_kw × irr/1000)
    let fallbackCorrection = geometryCorrection(month, hour);
    if (sampleCount === 0) {
      const lastActual = getLastActualForHour(hour);
      if (lastActual && lastActual.irr_forecast > 0) {
        const implied = lastActual.prod_actual / (config.panel.peak_kw * (lastActual.irr_forecast / 1000));
        if (implied > 0 && implied < 10) { // sanity bounds
          fallbackCorrection = implied;
        }
      }
    }

    const correction = (empiricalWeight * matrixCorrection)
                     + ((1 - empiricalWeight) * fallbackCorrection);

    // Core formula: prod_forecast = peak_kw × (irr_forecast / 1000) × correction × biasScalar
    const prodForecast = config.panel.peak_kw * (row.irr_forecast / 1000) * correction * biasScalar;

    // Confidence based on irradiance level
    const confidence = Math.min(1.0, row.irr_forecast / config.learning.min_irradiance_weight);

    updateForecast(row.hour_ts, Math.max(0, prodForecast), confidence, correction);
    count++;
  }

  console.log(`[model] Forecasted ${count} hours`);
  return count;
}
