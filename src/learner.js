import { getUnprocessedActuals, updateCorrection, getCorrectionCell, updateCorrectionMatrix } from './db.js';
import { parseTs } from './timeutils.js';

/**
 * Find rows where prod_actual is set but correction is null.
 * Compute correction = prod_actual / prod_forecast and update the correction matrix.
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

    // Store correction on the reading
    updateCorrection(row.hour_ts, correction);

    // Update the correction matrix weighted average
    const { month, day, hour } = parseTs(row.hour_ts);

    const cell = getCorrectionCell(month, day, hour);
    const oldAvg = cell.correction_avg;
    const oldCount = cell.sample_count;

    // Incremental weighted average
    const newCount = oldCount + 1;
    const newAvg = oldAvg + (correction - oldAvg) / newCount;

    // Track maximum production ever observed for this calendar cell
    const newMaxProd = Math.max(cell.max_prod ?? 0, row.prod_actual);

    updateCorrectionMatrix(month, day, hour, newAvg, newCount, newMaxProd);
    count++;
  }

  console.log(`[learner] Processed ${count} actuals`);
  return count;
}
