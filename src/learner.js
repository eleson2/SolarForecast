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

  let count = 0;
  for (const row of rows) {
    const correction = row.prod_actual / row.prod_forecast;
    const weight = sampleWeight(row.irr_forecast);

    // Store correction on the reading
    updateCorrection(row.hour_ts, correction);

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

  console.log(`[learner] Processed ${count} actuals`);
  return count;
}
