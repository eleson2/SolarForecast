import config from '../config.js';
import { getConsumptionForRange, getDaytimeConsumptionModel } from './db.js';
import { localTs } from './timeutils.js';

const DAYTIME_START = 8;   // first hour covered by the temperature model (inclusive)
const DAYTIME_END   = 18;  // last hour covered by the temperature model (inclusive)

/**
 * Fetch today's and yesterday's hourly temperatures from Open-Meteo.
 * Returns Map of "YYYY-MM-DDTHH:00" → temperature_2m (°C).
 */
async function fetchTemperatures() {
  const { lat, lon, timezone } = config.location;
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m`
    + `&past_days=1&forecast_days=2`
    + `&timezone=${encodeURIComponent(timezone)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo temperature request failed: ${res.status}`);
  }
  const data = await res.json();
  const temps = new Map();
  for (let i = 0; i < data.hourly.time.length; i++) {
    temps.set(data.hourly.time[i], data.hourly.temperature_2m[i]);
  }
  return temps;
}

/**
 * Estimate hourly consumption for the next 24 hours starting from windowStart.
 * Returns array of { hour_ts, consumption_w } with timestamps matching the
 * optimizer window so the consumptionMap lookup doesn't fall back to flat_watts.
 *
 * @param {Date} [windowStart] - Start of the optimizer window (defaults to now).
 *   Should be the same Date used to compute fromTs in batteryPipeline.
 *
 * Strategy:
 * 1. If source='yesterday' and yesterday's data exists: use it with temp correction
 * 2. Fallback: flat_watts from config
 */

export async function estimateConsumption(windowStart = null) {
  const now = new Date();

  // Floor the window start to the beginning of the current hour (UTC-aligned, works
  // for any whole-hour timezone offset such as Europe/Stockholm UTC+1/+2).
  const baseMs = Math.floor((windowStart ?? now).getTime() / 3_600_000) * 3_600_000;

  // Generate the 24 hour_ts strings for the window in the configured timezone.
  // Each entry also carries the hour-of-day for looking up historical data.
  const windowHours = [];
  for (let i = 0; i < 24; i++) {
    const d = new Date(baseMs + i * 3_600_000);
    const ts = localTs(d, config.location.timezone).slice(0, 13) + ':00';   // "YYYY-MM-DDTHH:00"
    const hourOfDay = parseInt(ts.slice(11, 13), 10);
    windowHours.push({ ts, hourOfDay });
  }

  // Yesterday's date (for historical consumption lookup)
  const yesterday = new Date(baseMs - 24 * 3_600_000);
  const yesterdayDateStr = localTs(yesterday, config.location.timezone).slice(0, 10);
  const todayDateStr = windowHours[0].ts.slice(0, 10); // date the window starts on

  const estimates = [];

  if (config.consumption.source === 'yesterday') {
    const yesterdayData = getConsumptionForRange(
      `${yesterdayDateStr}T00:00`,
      `${todayDateStr}T00:00`
    );

    let temps;
    try {
      temps = await fetchTemperatures();
    } catch (err) {
      console.log(`[consumption] Temperature fetch failed, skipping correction: ${err.message}`);
      temps = null;
    }

    // Build lookup: hour-of-day (0-23) → yesterday's { w, temp }
    const yesterdayByHour = new Map();
    for (const row of yesterdayData) {
      const hour = parseInt(row.hour_ts.slice(11, 13), 10);
      yesterdayByHour.set(hour, { w: row.consumption_w, temp: row.outdoor_temp });
    }

    if (yesterdayData.length > 0) {
      const daytimeModel = getDaytimeConsumptionModel();
      let modelHours = 0;
      let yesterdayHours = 0;

      for (const { ts: hourTs, hourOfDay: h } of windowHours) {
        const forecastTemp = temps?.get(hourTs) ?? null;

        // --- Path 1: learned regression model (daytime hours only) ---
        if (h >= DAYTIME_START && h <= DAYTIME_END && daytimeModel && forecastTemp !== null) {
          const predicted = Math.round(daytimeModel.slope * forecastTemp + daytimeModel.intercept);
          const clamped = Math.max(100, Math.min(config.consumption.flat_watts * 3, predicted));
          estimates.push({ hour_ts: hourTs, consumption_w: clamped });
          modelHours++;
          continue;
        }

        // --- Path 2: yesterday's value + temperature correction ---
        const yesterdayEntry = yesterdayByHour.get(h);
        if (!yesterdayEntry) {
          estimates.push({ hour_ts: hourTs, consumption_w: config.consumption.flat_watts });
          continue;
        }

        // If yesterday's reading exceeds max_house_w it was likely EV charging —
        // using it directly would over-estimate consumption and cause the optimizer
        // to over-discharge. Fall back to flat_watts instead.
        const maxHouseW = config.consumption?.max_house_w ?? Infinity;
        if (maxHouseW < Infinity && yesterdayEntry.w > maxHouseW) {
          estimates.push({ hour_ts: hourTs, consumption_w: config.consumption.flat_watts });
          continue;
        }

        let factor = 1.0;
        if (temps && forecastTemp !== null) {
          const hStr = String(h).padStart(2, '0');
          const yesterdayHourTs = `${yesterdayDateStr}T${hStr}:00`;
          const yesterdayTemp = yesterdayEntry.temp ?? temps.get(yesterdayHourTs);
          if (yesterdayTemp != null) {
            const tempDiff = forecastTemp - yesterdayTemp;
            const sensitivity = config.consumption.heating_sensitivity;
            factor = config.consumption.climate === 'heating'
              ? 1.0 - (tempDiff * sensitivity)
              : 1.0 + (tempDiff * sensitivity);
            factor = Math.max(0.7, Math.min(1.3, factor));
          }
        }

        estimates.push({
          hour_ts: hourTs,
          consumption_w: Math.round(yesterdayEntry.w * factor),
        });
        yesterdayHours++;
      }

      const src = modelHours > 0
        ? `model(${modelHours}h daytime) + yesterday(${yesterdayHours}h)`
        : `yesterday(${yesterdayHours}h)`;
      console.log(`[consumption] Estimated 24h via ${src}`);
      return estimates;
    }

    console.log('[consumption] No yesterday data, falling back to flat estimate');
  }

  // Fallback: flat watts for each window hour
  for (const { ts: hourTs } of windowHours) {
    estimates.push({ hour_ts: hourTs, consumption_w: config.consumption.flat_watts });
  }
  console.log(`[consumption] Using flat estimate: ${config.consumption.flat_watts}W`);
  return estimates;
}
