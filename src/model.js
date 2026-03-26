import config from '../config.js';
import { getReadingsWithoutForecast, getCorrectionCell, getSmoothCell, updateForecast, getLastActualForHour, getRecentActualsForBias } from './db.js';
import { parseTs, dayOfYear } from './timeutils.js';

// Half-saturation constant for irradiance weighting — matches learner.js
const WEIGHT_K = 50;

/**
 * Convert GHI (W/m², horizontal) to POA (W/m², plane-of-array) for the configured
 * panel tilt and azimuth using:
 *   1. Spencer solar position (declination + equation of time)
 *   2. Erbs beam/diffuse decomposition
 *   3. Hay–Davies transposition (beam + isotropic diffuse + ground-reflected)
 *
 * @param {number} ghiWm2   Horizontal global irradiance (W/m²)
 * @param {number} month    1–12
 * @param {number} dom      Day of month 1–31
 * @param {number} hour     Local clock hour 0–23 (centre of the averaging interval)
 */
function ghiToPoa(ghiWm2, month, dom, hour) {
  if (ghiWm2 <= 0) return 0;

  const doy = dayOfYear(month, dom);

  // --- Solar declination & equation of time (Spencer 1971) ---
  const B = ((doy - 1) * 2 * Math.PI) / 365;
  const declRad = 0.006918 - 0.399912 * Math.cos(B) + 0.070257 * Math.sin(B)
    - 0.006758 * Math.cos(2 * B) + 0.000907 * Math.sin(2 * B);               // radians
  const eotMin = 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B)
    - 0.014615 * Math.cos(2 * B) - 0.04089 * Math.sin(2 * B));                // minutes

  // --- Hour angle ---
  // Solar time = local clock time + longitude correction + equation of time.
  // Standard meridian for Europe/Stockholm: 15 °E (UTC+1). DST adds 1 h but
  // shifts clocks rather than changing the sun — approximating with CET (UTC+1)
  // introduces ≤1 h error in solar-noon timing, acceptable for hourly averages.
  const { lat, lon } = config.location;
  const lonCorrection = 4 * (lon - 15); // minutes; 15 °E = standard meridian for CET
  const solarHour = hour + (lonCorrection + eotMin) / 60;   // decimal hours, solar time
  const hRad = (solarHour - 12) * 15 * Math.PI / 180;       // hour angle in radians

  // --- Solar altitude ---
  const latRad = lat * Math.PI / 180;
  const sinAlt = Math.sin(declRad) * Math.sin(latRad) + Math.cos(declRad) * Math.cos(latRad) * Math.cos(hRad);
  if (sinAlt <= 0) return 0; // sun below horizon

  // --- Solar azimuth (from south, positive = west) via atan2 ---
  // Using atan2 avoids the quadrant ambiguity of the acos formula and gives
  // the correct sign in both morning (east, negative) and afternoon (west, positive).
  const cosAlt = Math.sqrt(1 - sinAlt * sinAlt);
  const sinAzNum = Math.sin(hRad) * Math.cos(declRad);         // sin(Az) × cosAlt
  const cosAzNum = sinAlt * Math.sin(latRad) - Math.sin(declRad); // cos(Az) × cosAlt × cos(lat)
  const sunAzRad = Math.atan2(sinAzNum / cosAlt, cosAzNum / (cosAlt * Math.cos(latRad)));

  // --- Panel geometry ---
  const tiltRad = config.panel.tilt * Math.PI / 180;
  // Config azimuth is geographic (0=N, 180=S); convert to south-zero convention
  const panelAzRad = (config.panel.azimuth - 180) * Math.PI / 180;
  const cosAoi = sinAlt * Math.cos(tiltRad) + cosAlt * Math.cos(sunAzRad - panelAzRad) * Math.sin(tiltRad);

  // --- Erbs diffuse-fraction decomposition ---
  const GHI_ext = 1361 * sinAlt; // extraterrestrial horizontal (W/m²)
  const Kt = Math.min(1, ghiWm2 / Math.max(1, GHI_ext)); // clearness index
  let diffFrac;
  if (Kt <= 0.22)      diffFrac = 1 - 0.09 * Kt;
  else if (Kt <= 0.80) diffFrac = 0.9511 - 0.1604 * Kt + 4.388 * Kt ** 2 - 16.638 * Kt ** 3 + 12.336 * Kt ** 4;
  else                 diffFrac = 0.165;

  const DHI = ghiWm2 * diffFrac;
  const DNI = (ghiWm2 - DHI) / sinAlt;

  // --- Hay–Davies transposition ---
  const beam      = Math.max(0, DNI * Math.max(0, cosAoi));
  const diffuse   = DHI * (1 + Math.cos(tiltRad)) / 2;
  const reflected = ghiWm2 * 0.2 * (1 - Math.cos(tiltRad)) / 2; // 0.2 = typical ground albedo

  return beam + diffuse + reflected;
}

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
 * Forecast production for all readings that have irradiance but no forecast yet.
 */
export function runModel() {
  const rows = getReadingsWithoutForecast();
  if (rows.length === 0) {
    console.log('[model] No new readings to forecast');
    return 0;
  }

  const biasScalar = computeRecencyBias();
  const suppressionMax = config.learning.cloud_suppression_max ?? 0.65;

  // Pre-load last actuals for all hours so the fallback lookup inside the loop
  // is a Map.get() rather than a DB query per row.
  const lastActualByHour = new Map();
  for (let h = 0; h < 24; h++) {
    const row = getLastActualForHour(h);
    if (row) lastActualByHour.set(h, row);
  }

  let count = 0;
  for (const row of rows) {
    const { month, day, hour } = parseTs(row.hour_ts);

    // Get learned correction — prefer the Gaussian-smoothed value (broader temporal
    // signal, blends ±7 days of neighbours) over the raw per-cell entry when the
    // smooth table has been populated. Fall back to the raw cell for cells that haven't
    // been through the smoother yet (smooth runs nightly).
    const smoothCell = getSmoothCell(month, day, hour);
    const cell       = smoothCell ?? getCorrectionCell(month, day, hour);
    const matrixCorrection = cell ? cell.correction_avg : 1.0;
    const sampleCount      = cell ? cell.sample_count   : 0;

    // Blend empirical vs fallback based on observation count
    const empiricalWeight = Math.min(1.0, sampleCount / config.learning.empirical_blend_threshold);

    // Convert stored GHI to Plane-of-Array (POA) irradiance for the configured panel tilt/azimuth.
    // Open-Meteo returns shortwave_radiation as GHI (horizontal), but tilted panels receive
    // significantly more irradiance in spring/autumn when the sun is low. Using POA means
    // the correction matrix only needs to capture real deviations (shading, temperature,
    // soiling) rather than the large geometry effect.
    const poaWm2 = ghiToPoa(row.irr_forecast, month, day, hour);

    // Fallback correction when the matrix has no data for this cell.
    // With POA irradiance the "ideal physics" baseline is 1.0 — POA already
    // encodes panel tilt and azimuth geometry, so no further geometric scaling
    // is needed before real data arrives.
    let fallbackCorrection = 1.0;
    if (sampleCount === 0) {
      const lastActual = lastActualByHour.get(hour);
      if (lastActual && lastActual.irr_forecast > 0) {
        const lastPoa = ghiToPoa(lastActual.irr_forecast, month, day, hour);
        const base = config.panel.peak_kw * (lastPoa / 1000);
        const implied = base > 0 ? lastActual.prod_actual / base : null;
        if (implied > 0 && implied < 5) fallbackCorrection = implied;
      }
    }

    const correction = (empiricalWeight * matrixCorrection)
                     + ((1 - empiricalWeight) * fallbackCorrection);

    // Cloud-cover suppression: heavy overcast days exceed what the correction matrix
    // expects because the matrix averages over mixed-sky conditions. Scale down
    // proportionally to cloud cover so 100% cloud applies the full suppression factor.
    const cloudFactor = (row.cloud_cover != null)
      ? 1 - (row.cloud_cover / 100) * suppressionMax
      : 1.0;

    // Core formula: prod_forecast = peak_kw × (poa / 1000) × correction × biasScalar × cloudFactor
    // Capped at peak_kw — panels cannot exceed rated capacity regardless of correction.
    const prodForecast = Math.min(
      config.panel.peak_kw,
      config.panel.peak_kw * (poaWm2 / 1000) * correction * biasScalar * cloudFactor
    );

    // Confidence based on irradiance level
    const confidence = Math.min(1.0, row.irr_forecast / config.learning.min_irradiance_weight);

    updateForecast(row.hour_ts, Math.max(0, prodForecast), confidence, correction);
    count++;
  }

  console.log(`[model] Forecasted ${count} hours`);
  return count;
}
