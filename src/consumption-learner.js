/**
 * Learns a per-hour linear regression model from historical (outdoor_temp, consumption_w) pairs.
 *
 * Model: consumption_w = slope × outdoor_temp + intercept
 *
 * For a heating climate (most Swedish homes) the slope is negative:
 * colder outdoor temps → higher electrical consumption (space heating, hot water).
 *
 * Only hours DAYTIME_START–DAYTIME_END (08:00–18:00) are modelled.
 * Nighttime hours are intentionally excluded because that is when electric vehicles
 * are typically charged, which creates large consumption spikes unrelated to temperature.
 * Nighttime consumption estimation falls back to yesterday's data (see consumption.js).
 *
 * Future enhancement: detect EV charging sessions from consumption spikes and exclude
 * those individual readings from the regression even during daytime, once enough data
 * exists to distinguish baseline from charging load.
 *
 * Coefficients are stored in the consumption_model table and refreshed hourly.
 * A minimum of MIN_SAMPLES data points per hour is required before a model is written.
 */

import { getConsumptionHistoryForHour, upsertConsumptionModel } from './db.js';
import log from './logger.js';

const MIN_SAMPLES    = 10;  // need at least 10 days of data per hour before trusting the fit
const DAYTIME_START  = 8;   // first hour to model (inclusive)
const DAYTIME_END    = 18;  // last hour to model (inclusive) — nighttime excluded (EV charging)

/**
 * Compute ordinary least-squares linear regression for arrays xs, ys.
 * Returns { slope, intercept, rSquared, n } or null if underdetermined.
 */
function ols(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;

  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;

  let ssXY = 0, ssXX = 0, ssYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    ssXY += dx * dy;
    ssXX += dx * dx;
    ssYY += dy * dy;
  }

  if (ssXX === 0) return null; // all same temperature — can't fit a line

  const slope     = ssXY / ssXX;
  const intercept = yMean - slope * xMean;

  // R² = 1 – SS_residual / SS_total
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += (ys[i] - pred) ** 2;
  }
  const rSquared = ssYY > 0 ? Math.max(0, 1 - ssRes / ssYY) : 0;

  return { slope, intercept, rSquared, n };
}

/**
 * Rebuild consumption_model for all 24 hours from historical consumption_readings.
 * Skips hours with fewer than MIN_SAMPLES (10) temperature+consumption pairs.
 * Called hourly via learnPipeline in scheduler.js.
 */
export function learnConsumptionModel() {
  let updated = 0;
  let skipped = 0;
  const r2Log = [];

  for (let h = DAYTIME_START; h <= DAYTIME_END; h++) {
    const rows = getConsumptionHistoryForHour(h);

    if (rows.length < MIN_SAMPLES) {
      skipped++;
      continue;
    }

    const xs = rows.map(r => r.outdoor_temp);
    const ys = rows.map(r => r.consumption_w);

    const fit = ols(xs, ys);
    if (!fit) { skipped++; continue; }

    upsertConsumptionModel(h, fit.slope, fit.intercept, fit.n, fit.rSquared);
    updated++;

    r2Log.push(`h${String(h).padStart(2,'0')} R²=${fit.rSquared.toFixed(2)} slope=${fit.slope.toFixed(0)}W/°C n=${fit.n}`);
  }

  const total = DAYTIME_END - DAYTIME_START + 1;
  if (updated > 0) {
    log.info('consumption-model', `Updated ${updated}/${total} daytime hours (skipped ${skipped} with <${MIN_SAMPLES} samples)`);
    log.info('consumption-model', r2Log.join(' | '));
  } else {
    log.info('consumption-model', `Not enough data yet — need ${MIN_SAMPLES} days per daytime hour (currently ${skipped}/${total} below threshold)`);
  }
}
