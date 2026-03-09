import config from '../config.js';
import { getUnprocessedActuals, updateCorrection, getCorrectionCell, updateCorrectionMatrix } from './db.js';
import { parseTs } from './timeutils.js';

// Weight function: how much to trust a correction sample based on irradiance.
// Uses a soft half-saturation curve: weight = irr / (irr + k).
// k = 50 W/m² means irr=50 → weight=0.5, irr=200 → weight=0.8, irr=5 → weight=0.09.
// This heavily discounts overcast readings without discarding them entirely.
const WEIGHT_K = 50;

function sampleWeight(irr_wm2) {
  if (!irr_wm2 || irr_wm2 <= 0) return 0;
  return irr_wm2 / (irr_wm2 + WEIGHT_K);
}

/**
 * Find rows where prod_actual is set but correction is null.
 * Compute correction = prod_actual / prod_forecast and update the correction matrix
 * using an irradiance-weighted running average.
 *
 * Weighting rationale: a correction learned at 5 W/m² (heavy overcast) is much
 * less reliable than one learned at 400 W/m² (clear sky). The soft weight curve
 * means cloudy-day samples still contribute but are heavily discounted, so they
 * cannot dominate the average the way an unweighted scheme allows.
 */
export function runLearner() {
  const rows = getUnprocessedActuals();
  if (rows.length === 0) {
    console.log('[learner] No new actuals to process');
    return 0;
  }

  // Cloud cover threshold above which a sample is excluded from the matrix.
  // The cloud suppression in model.js already adjusts prod_forecast for heavy overcast,
  // so the correction = actual/forecast ratio on those days reflects both the panel
  // behaviour AND the cloud suppression factor. Including such samples would inflate
  // the matrix, gradually undoing the cloud suppression on clear days.
  const cloudExcludeThreshold = config.learning.cloud_matrix_exclude_pct ?? 80;

  let count = 0;
  let skippedCloud = 0;
  for (const row of rows) {
    const correction = row.prod_actual / row.prod_forecast;
    const weight = sampleWeight(row.irr_forecast);

    // Always mark the reading as processed so we don't revisit it next hour.
    updateCorrection(row.hour_ts, correction);

    // Skip matrix update for heavy-overcast readings — the forecast was already
    // cloud-suppressed, so the correction here is artificially close to 1.0 and
    // would inflate the matrix for that (month, day, hour) cell.
    if (row.cloud_cover != null && row.cloud_cover >= cloudExcludeThreshold) {
      skippedCloud++;
      continue;
    }

    // Update the correction matrix with weighted average
    const { month, day, hour } = parseTs(row.hour_ts);
    const cell = getCorrectionCell(month, day, hour);

    const oldAvg         = cell.correction_avg;
    const oldTotalWeight = cell.total_weight ?? 0;
    const oldCount       = cell.sample_count;

    // Weighted incremental average:
    //   newAvg = (oldAvg * oldTotalWeight + correction * weight) / (oldTotalWeight + weight)
    const newTotalWeight = oldTotalWeight + weight;
    const newAvg = newTotalWeight > 0
      ? (oldAvg * oldTotalWeight + correction * weight) / newTotalWeight
      : correction;

    const newCount   = oldCount + 1;
    const newMaxProd = Math.max(cell.max_prod ?? 0, row.prod_actual);

    updateCorrectionMatrix(month, day, hour, newAvg, newCount, newTotalWeight, newMaxProd);
    count++;
  }

  const skippedMsg = skippedCloud > 0 ? `, skipped ${skippedCloud} high-cloud` : '';
  console.log(`[learner] Processed ${count} actuals${skippedMsg}`);
  return count;
}
