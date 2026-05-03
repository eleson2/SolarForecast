import { upsertYrDataBatch } from './db.js';
import { localTs } from './timeutils.js';
import config from '../config.js';
import log from './logger.js';

/**
 * Parse a MET Norway Locationforecast 2.0 /complete response and update
 * solar_readings rows with YR cloud cover and fog fraction.
 *
 * Only updates existing rows (created by the Open-Meteo fetch) — does not
 * insert new rows, since irradiance from Open-Meteo is required to exist first.
 *
 * cloud_cover_yr is stored separately from cloud_cover (Open-Meteo) so both
 * sources remain available for post-hoc accuracy comparison.
 */
export function parseYrData(data, storeFn = upsertYrDataBatch) {
  const timeseries = data?.properties?.timeseries;
  if (!timeseries) throw new Error('[yr-parser] Invalid YR response: missing timeseries');

  const rows = [];
  for (const entry of timeseries) {
    const details = entry?.data?.instant?.details;
    if (!details) continue;

    // YR timestamps are UTC ISO strings like "2026-05-03T06:00:00Z".
    // Skip sub-hourly entries (YR includes 6-hourly entries beyond ~48h).
    if (!/T\d{2}:00:00Z$/.test(entry.time)) continue;

    const hourTs = localTs(new Date(entry.time), config.location.timezone);
    const cloud = details.cloud_area_fraction ?? null;  // 0–100 %
    const fog   = details.fog_area_fraction   ?? null;  // 0–100 %

    if (cloud == null && fog == null) continue;
    rows.push([hourTs, cloud, fog]);
  }

  storeFn(rows);
  log.info('yr-parse', `Updated ${rows.length} hourly cloud/fog readings from YR`);
  return rows.length;
}
