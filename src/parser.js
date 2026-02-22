import { upsertReading } from './db.js';

/**
 * Parse Open-Meteo JSON response and upsert hourly irradiance into solar_readings.
 * Only this file knows the Open-Meteo JSON shape.
 */
export function parseWeatherData(data) {
  const hourly = data?.hourly;
  if (!hourly || !hourly.time || !hourly.shortwave_radiation) {
    throw new Error('[parser] Invalid Open-Meteo response: missing hourly data');
  }

  let count = 0;
  for (let i = 0; i < hourly.time.length; i++) {
    const hourTs = hourly.time[i]; // ISO string like "2025-06-15T07:00"
    const irr = hourly.shortwave_radiation[i];

    if (irr == null) continue;

    upsertReading(hourTs, irr);
    count++;
  }

  console.log(`[parser] Upserted ${count} hourly irradiance readings`);
  return count;
}
