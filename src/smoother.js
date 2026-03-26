import config from '../config.js';
import { getReadingsForSmoothing, upsertSmooth } from './db.js';
import { parseTs, dayOfYear, doyToMonthDay, CALENDAR_DATES } from './timeutils.js';

const KERNEL_HALF_WIDTH = 7; // ±7 days
const SIGMA = 3.0;           // Gaussian sigma in days

function gaussianWeight(distanceDays) {
  return Math.exp(-(distanceDays * distanceDays) / (2 * SIGMA * SIGMA));
}

/**
 * Smooth the correction matrix across ±7 days and populate correction_matrix_smooth.
 * Keyed by (month, day, hour) — same as the raw correction_matrix.
 */
export function runSmoother() {
  const readings = getReadingsForSmoothing();
  if (readings.length === 0) {
    console.log('[smoother] No correction data available for smoothing');
    return 0;
  }

  // Group readings by (month, day, hour)
  const byDayHour = new Map();
  for (const r of readings) {
    const { month, day, hour } = parseTs(r.hour_ts);
    const key = `${month}:${day}:${hour}`;
    if (!byDayHour.has(key)) byDayHour.set(key, []);
    byDayHour.get(key).push({
      correction: r.correction,
      confidence: r.confidence,
      prodActual: r.prod_actual,
      cloudCover: r.cloud_cover,
    });
  }

  const maxCorrection = config.learning.max_correction_sample ?? 4.0;
  const cloudThreshold = config.learning.cloud_matrix_exclude_pct ?? 80;
  let count = 0;

  for (const { month: targetMonth, day: targetDay } of CALENDAR_DATES) {
    const targetDoy = dayOfYear(targetMonth, targetDay);

    for (let targetHour = 0; targetHour <= 23; targetHour++) {
      let weightedSum = 0;
      let totalWeight = 0;
      let totalSamples = 0;

      for (let offset = -KERNEL_HALF_WIDTH; offset <= KERNEL_HALF_WIDTH; offset++) {
        let neighborDoy = targetDoy + offset;
        if (neighborDoy < 1)   neighborDoy += 365;
        if (neighborDoy > 365) neighborDoy -= 365;

        const { month: nm, day: nd } = doyToMonthDay(neighborDoy);
        const entries = byDayHour.get(`${nm}:${nd}:${targetHour}`);
        if (!entries) continue;

        // |offset| is the exact day distance (year-wrap already handled above)
        const gWeight = gaussianWeight(Math.abs(offset));

        for (const entry of entries) {
          // Skip the same samples the learner rejects so that the smooth table
          // reflects the same signal as the correction matrix.
          if (entry.correction > maxCorrection) continue;
          if (entry.cloudCover != null && entry.cloudCover >= cloudThreshold) continue;

          // Low-production days get lower weight
          const prodWeight = entry.prodActual != null && entry.prodActual > 0
            ? Math.min(1.0, entry.prodActual / 2.0) // scale: 2 kWh = full weight
            : 0.1;

          const w = gWeight * entry.confidence * prodWeight;
          weightedSum += entry.correction * w;
          totalWeight += w;
          totalSamples++;
        }
      }

      if (totalWeight > 0) {
        upsertSmooth(targetMonth, targetDay, targetHour, weightedSum / totalWeight, totalSamples);
        count++;
      }
    }
  }

  console.log(`[smoother] Updated ${count} cells in correction_matrix_smooth`);
  return count;
}
