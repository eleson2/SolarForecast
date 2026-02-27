import config from '../config.js';
import { getConsumptionForRange, getConsumptionModelForHour } from './db.js';

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" in configured timezone.
 */
function localTs(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

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
 * Estimate hourly consumption for today (24 entries).
 * Returns array of { hour_ts, consumption_w }.
 *
 * Strategy:
 * 1. If source='yesterday' and yesterday's data exists: use it with temp correction
 * 2. Fallback: flat_watts from config
 */
export async function estimateConsumption() {
  const now = new Date();

  // Compute yesterday and today start timestamps in local time
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  // Adjust to local timezone midnight
  const todayStartTs = localTs(todayStart).slice(0, 11) + '00:00';
  const todayDateStr = todayStartTs.slice(0, 10);

  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStartTs = localTs(yesterday).slice(0, 11) + '00:00';
  const yesterdayDateStr = yesterdayStartTs.slice(0, 10);

  const tomorrowStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStartTs = localTs(tomorrowStart).slice(0, 11) + '00:00';

  const estimates = [];

  if (config.consumption.source === 'yesterday') {
    // Try to get yesterday's consumption from DB
    const yesterdayData = getConsumptionForRange(
      `${yesterdayDateStr}T00:00`,
      `${todayDateStr}T00:00`
    );

    // Always fetch temperatures — needed by both model and yesterday-based paths
    let temps;
    try {
      temps = await fetchTemperatures();
    } catch (err) {
      console.log(`[consumption] Temperature fetch failed, skipping correction: ${err.message}`);
      temps = null;
    }

    // Build lookup: hour (0-23) → yesterday's {w, temp}
    const yesterdayByHour = new Map();
    for (const row of yesterdayData) {
      const hour = parseInt(row.hour_ts.slice(11, 13), 10);
      yesterdayByHour.set(hour, { w: row.consumption_w, temp: row.outdoor_temp });
    }

    if (yesterdayData.length > 0) {
      let modelHours = 0;
      let yesterdayHours = 0;

      for (let h = 0; h < 24; h++) {
        const hStr = String(h).padStart(2, '0');
        const hourTs = `${todayDateStr}T${hStr}:00`;
        const forecastTemp = temps?.get(hourTs) ?? null;

        // --- Path 1: learned regression model ---
        // Use when a model with sufficient samples exists AND forecast temp is available.
        const model = getConsumptionModelForHour(h);
        if (model && forecastTemp !== null) {
          const predicted = Math.round(model.slope * forecastTemp + model.intercept);
          // Clamp to a plausible range (never below 100 W, never above 3× flat_watts)
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

        let factor = 1.0;
        if (temps && forecastTemp !== null) {
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
        ? `model(${modelHours}h) + yesterday(${yesterdayHours}h)`
        : `yesterday(${yesterdayHours}h)`;
      console.log(`[consumption] Estimated 24h via ${src}`);
      return estimates;
    }

    console.log('[consumption] No yesterday data, falling back to flat estimate');
  }

  // Fallback: flat watts
  for (let h = 0; h < 24; h++) {
    const hStr = String(h).padStart(2, '0');
    estimates.push({
      hour_ts: `${todayDateStr}T${hStr}:00`,
      consumption_w: config.consumption.flat_watts,
    });
  }

  console.log(`[consumption] Using flat estimate: ${config.consumption.flat_watts}W`);
  return estimates;
}
