/**
 * Learns a single linear regression model from daytime (outdoor_temp, consumption_w) pairs.
 *
 * Model: consumption_w = slope × outdoor_temp + intercept
 *
 * Rationale: heat loss from a building is governed by the temperature differential
 * between inside and outside, not by the time of day. A house at 5°C outside needs
 * the same watts to stay warm at 10:00 as at 15:00. One regression line across all
 * daytime hours (08–18) is therefore correct and also pools far more data points
 * than per-hour models would (11× more samples for the same number of days).
 *
 * Nighttime hours (19:00–07:00) are intentionally excluded because that is when
 * electric vehicles are typically charged, creating large consumption spikes that
 * are unrelated to temperature and would corrupt the slope.
 * Nighttime consumption estimation falls back to yesterday's data (see consumption.js).
 *
 * Future enhancement: detect EV charging sessions from anomalous consumption spikes
 * and exclude those individual readings from the regression, once enough data exists
 * to estimate a per-hour baseline and standard deviation.
 *
 * The fitted coefficients are stored as a single 'daytime' row in consumption_model
 * and refreshed hourly via learnPipeline in scheduler.js.
 */

import { getDaytimeConsumptionHistory, upsertConsumptionModel } from './db.js';
import log from './logger.js';

const MIN_SAMPLES = 50;  // ~5 days × 11 daytime hours — enough for a stable regression line

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

  if (ssXX === 0) return null; // all readings at same temperature — can't fit a line

  const slope     = ssXY / ssXX;
  const intercept = yMean - slope * xMean;

  // R² = 1 – SS_residual / SS_total
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
  }
  const rSquared = ssYY > 0 ? Math.max(0, 1 - ssRes / ssYY) : 0;

  return { slope, intercept, rSquared, n };
}

/**
 * Fit a single linear model to all daytime (08–18) consumption + temperature readings.
 * Stores result in consumption_model as model_key='daytime'.
 * Called hourly via learnPipeline in scheduler.js.
 */
export function learnConsumptionModel() {
  const rows = getDaytimeConsumptionHistory();

  if (rows.length < MIN_SAMPLES) {
    log.info('consumption-model', `Not enough data yet — ${rows.length}/${MIN_SAMPLES} daytime samples (need ~${Math.ceil(MIN_SAMPLES / 11)} days)`);
    return;
  }

  const xs = rows.map(r => r.outdoor_temp);
  const ys = rows.map(r => r.consumption_w);

  const fit = ols(xs, ys);
  if (!fit) {
    log.warn('consumption-model', 'OLS failed — all readings at identical temperature');
    return;
  }

  upsertConsumptionModel(fit.slope, fit.intercept, fit.n, fit.rSquared);

  log.info('consumption-model',
    `Daytime model: slope=${fit.slope.toFixed(0)} W/°C  intercept=${fit.intercept.toFixed(0)} W  R²=${fit.rSquared.toFixed(2)}  n=${fit.n}`
  );

  if (fit.rSquared < 0.3) {
    log.warn('consumption-model', `Low R²=${fit.rSquared.toFixed(2)} — temperature explains little of the variance; check for EV charging or other large variable loads`);
  }
}
