import { getReadingsForSmoothing, upsertSmooth } from './db.js';
import { parseTs, dayOfYear } from './timeutils.js';

const KERNEL_HALF_WIDTH = 7; // ±7 days
const SIGMA = 3.0;           // Gaussian sigma in days

/**
 * Gaussian weight for distance in days.
 */
function gaussianWeight(distanceDays) {
  return Math.exp(-(distanceDays * distanceDays) / (2 * SIGMA * SIGMA));
}

/**
 * Day-of-year distance handling year-wrap (365→1).
 */
function dayDistance(a, b) {
  const diff = Math.abs(a - b);
  return Math.min(diff, 365 - diff);
}

/**
 * Smooth the correction matrix across ±7 days of day-of-year
 * and populate correction_matrix_smooth.
 */
export function runSmoother() {
  const readings = getReadingsForSmoothing();
  if (readings.length === 0) {
    console.log('[smoother] No correction data available for smoothing');
    return 0;
  }

  // Group readings by (day_of_year, hour_of_day)
  const byDayHour = new Map();
  for (const r of readings) {
    const { month, day, hour } = parseTs(r.hour_ts);
    const doy = dayOfYear(month, day);
    const key = `${doy}:${hour}`;

    if (!byDayHour.has(key)) {
      byDayHour.set(key, []);
    }
    byDayHour.get(key).push({
      doy,
      hour,
      correction: r.correction,
      confidence: r.confidence,
      prodActual: r.prod_actual,
    });
  }

  let count = 0;

  // For each (day_of_year, hour) cell, compute Gaussian-weighted average
  for (let targetDoy = 1; targetDoy <= 365; targetDoy++) {
    for (let targetHour = 0; targetHour <= 23; targetHour++) {
      let weightedSum = 0;
      let totalWeight = 0;
      let totalSamples = 0;

      // Gather contributions from nearby days
      for (let offset = -KERNEL_HALF_WIDTH; offset <= KERNEL_HALF_WIDTH; offset++) {
        let neighborDoy = targetDoy + offset;
        // Handle year-wrap
        if (neighborDoy < 1) neighborDoy += 365;
        if (neighborDoy > 365) neighborDoy -= 365;

        const key = `${neighborDoy}:${targetHour}`;
        const entries = byDayHour.get(key);
        if (!entries) continue;

        const dist = dayDistance(targetDoy, neighborDoy);
        const gWeight = gaussianWeight(dist);

        for (const entry of entries) {
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
        const smoothedCorrection = weightedSum / totalWeight;
        upsertSmooth(targetDoy, targetHour, smoothedCorrection, totalSamples);
        count++;
      }
    }
  }

  console.log(`[smoother] Updated ${count} cells in correction_matrix_smooth`);
  return count;
}

