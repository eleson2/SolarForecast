import config from '../config.js';
import {
  getConsumptionForRange,
  getDaytimeConsumptionModel,
  upsertConsumption,
  updateActual,
  getSnapshotAtOrBefore,
  getSnapshotsForRange,
  getSolarReadingsForRange,
  recordPipelineRun
} from './db.js';
import { localTs } from './timeutils.js';
import { getDriver, getDriverConfig } from './inverter-dispatcher.js';
import log from './logger.js';

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

/**
 * Derive last hour's energy consumption and PV production from the delta between
 * the snapshot at the current hour start and the snapshot one hour prior.
 */
export async function runConsumptionPipeline() {
  const driver = getDriver();
  if (!driver) return;

  const cfg = getDriverConfig();

  // Fetch current outdoor temperature from Open-Meteo
  let outdoorTemp = null;
  try {
    const { lat, lon } = config.location;
    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      outdoorTemp = data.current?.temperature_2m ?? null;
    }
  } catch (err) {
    log.warn('consumption', `Could not fetch outdoor temp: ${err.message}`);
  }

  // Derive last hour's energy from snapshots
  // At HH:05 we compare snapshot at HH:00 vs (HH-1):00
  const now = new Date();
  const currentHour = new Date(now);
  currentHour.setMinutes(0, 0, 0);
  const prevHour = new Date(currentHour.getTime() - 60 * 60 * 1000);

  const currentHourTs = localTs(currentHour, config.location.timezone);
  const prevHourTs    = localTs(prevHour, config.location.timezone);

  try {
    const snapNow  = getSnapshotAtOrBefore(currentHourTs);
    const snapPrev = getSnapshotAtOrBefore(prevHourTs);

    if (snapNow && snapPrev) {
      // Warn if nearest snapshot is far from the expected hour boundary
      const snapNowAge  = Math.round(Math.abs(new Date(currentHourTs) - new Date(snapNow.snapshot_ts))  / 60000);
      const snapPrevAge = Math.round(Math.abs(new Date(prevHourTs)    - new Date(snapPrev.snapshot_ts)) / 60000);
      if (snapNowAge > 10 || snapPrevAge > 10) {
        const spanMin = 60 + snapNowAge + snapPrevAge;
        log.warn('consumption', `Snapshot boundary offset: now=${snapNowAge}min prev=${snapPrevAge}min — delta spans ~${spanMin}min instead of 60`);
      }

      // Compute deltas; handle midnight reset (daily counter drops back to 0)
      const midnightReset = snapNow.load_today_kwh < snapPrev.load_today_kwh;
      const deltaLoad = midnightReset
        ? snapNow.load_today_kwh  // counter reset — value since midnight is the new reading
        : snapNow.load_today_kwh - snapPrev.load_today_kwh;

      const pvNow  = snapNow.pv_today_kwh  ?? 0;
      const pvPrev = snapPrev.pv_today_kwh ?? 0;
      const deltaPv = pvNow >= pvPrev ? pvNow - pvPrev : pvNow;

      // Midnight-reset artefact: the first snapshot after midnight has accumulated only
      // a few minutes of energy, making the delta for the 23:00 hour near-zero. Detect
      // this and substitute flat_watts so the consumption model isn't corrupted.
      const rawTotalW = deltaLoad * 1000;
      if (midnightReset && rawTotalW < config.consumption.flat_watts * 0.2) {
        log.warn('consumption',
          `${prevHourTs}: midnight-reset delta near zero (${Math.round(rawTotalW)}W) — substituting flat_watts`);
        upsertConsumption(prevHourTs, config.consumption.flat_watts, outdoorTemp, 'flat_fallback');
        updateActual(prevHourTs, deltaPv);
        log.info('consumption', `${prevHourTs}: load=flat_fallback (${config.consumption.flat_watts}W), PV=${deltaPv.toFixed(2)}kWh, temp=${outdoorTemp}°C`);
        recordPipelineRun('consumption');
        return;
      }

      // ── Multi-hour gap fill ───────────────────────────────────────────────────
      // If the previous snapshot is stale by more than one hour, the inverter (or
      // host) was offline and this single delta actually spans the whole gap.
      // Cumulative daily counters mean no energy is lost, but attributing it all to
      // one hour creates an unrealistic spike that pollutes prod_actual and the
      // correction matrix. Spread the accumulated energy across the empty hours:
      // PV weighted by each hour's prod_forecast (even split if no forecast), load
      // split evenly, tagged 'inverter_gap_fill'.
      //
      // Daily counters reset at midnight, so a raw delta is only meaningful within a
      // single calendar day. If the gap crossed midnight we can still reconstruct
      // *today's* portion — the counters already hold energy-since-midnight
      // (pvNow / loadNow) — and distribute it from 00:00. The pre-midnight tail is
      // unrecoverable from two readings and is left untouched (stays NULL, so the
      // learner simply skips those hours rather than ingesting a spike).
      if (snapPrevAge > 65) {
        const crossedMidnight =
          snapNow.snapshot_ts.slice(0, 10) !== snapPrev.snapshot_ts.slice(0, 10)
          || pvNow < pvPrev
          || snapNow.load_today_kwh < snapPrev.load_today_kwh;

        const pvToDistribute   = crossedMidnight ? pvNow : pvNow - pvPrev;
        const loadToDistribute = crossedMidnight
          ? snapNow.load_today_kwh
          : snapNow.load_today_kwh - snapPrev.load_today_kwh;

        // Nothing accumulated (e.g. ongoing outage with a frozen snapshot, or a
        // negative artefact) — let the normal single-hour path handle it.
        if (pvToDistribute > 0 || loadToDistribute > 0) {
          // Format a Date back into a "YYYY-MM-DDTHH:00" hour label using the same
          // (system-local) components new Date() parsed from the timestamp string, so
          // the round-trip is timezone-independent and matches the stored hour_ts.
          const fmtHour = (d) => {
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
          };

          // First gap hour: the hour containing snapPrev, or today's 00:00 if the gap
          // crossed midnight. Last gap hour: prevHour.
          const firstGap = crossedMidnight
            ? new Date(snapNow.snapshot_ts)
            : new Date(snapPrev.snapshot_ts);
          if (crossedMidnight) firstGap.setHours(0, 0, 0, 0);
          else firstGap.setMinutes(0, 0, 0);

          const lastGap = new Date(prevHourTs);
          const hourCount = Math.round((lastGap - firstGap) / 3600000) + 1;

          if (hourCount >= 1) {
            const gapHours = [];
            for (let i = 0; i < hourCount; i++) {
              gapHours.push(fmtHour(new Date(firstGap.getTime() + i * 3600000)));
            }

            // PV weights from forecast shape (clamp ≥0); even split if no forecast.
            const fcByHour = {};
            for (const r of getSolarReadingsForRange(gapHours[0], prevHourTs)) {
              fcByHour[r.hour_ts] = Math.max(0, r.prod_forecast ?? 0);
            }
            let weightSum = 0;
            for (const h of gapHours) weightSum += (fcByHour[h] ?? 0);

            const loadPerHourW = Math.round(loadToDistribute * 1000 / hourCount);

            for (const h of gapHours) {
              const pvShare = weightSum > 0
                ? pvToDistribute * ((fcByHour[h] ?? 0) / weightSum)
                : pvToDistribute / hourCount;
              updateActual(h, pvShare);
              upsertConsumption(h, loadPerHourW, outdoorTemp, 'inverter_gap_fill');
            }

            log.warn('consumption',
              `Gap fill${crossedMidnight ? ' (post-midnight portion)' : ''}: distributed `
              + `PV=${pvToDistribute.toFixed(2)}kWh, load=${loadToDistribute.toFixed(2)}kWh `
              + `across ${hourCount}h (${gapHours[0]}→${prevHourTs}), `
              + `weighting=${weightSum > 0 ? 'forecast' : 'even'}`);
            recordPipelineRun('consumption');
            return;
          }
        }
      }

      // ── Sub-hourly EV detection ───────────────────────────────────────────────
      // Build a snapshot chain spanning [snapPrev, …15-min snapshots…, snapNow].
      // Walk consecutive pairs: normalise each slot to watts, flag slots where
      // load > max_house_w as EV-charging, and sum house-only energy separately.
      let consumption_w;
      let consumptionSource = 'inverter_delta';

      const evEnabled  = config.ev?.enabled && (config.ev.charge_watts > 0);
      const maxHouseW  = config.consumption?.max_house_w ?? Infinity;
      const evChargeW  = config.ev?.charge_watts ?? 0;

      if (evEnabled && maxHouseW < Infinity) {
        const hourSnaps = getSnapshotsForRange(prevHourTs, currentHourTs);
        const chain = (snapPrev.snapshot_ts < prevHourTs)
          ? [snapPrev, ...hourSnaps]
          : hourSnaps;

        let houseEnergyKwh = 0;
        let evDetected     = false;
        let evSlots        = 0;

        for (let i = 1; i < chain.length; i++) {
          const s0 = chain[i - 1];
          const s1 = chain[i];
          const slotMin = (new Date(s1.snapshot_ts) - new Date(s0.snapshot_ts)) / 60000;
          if (slotMin <= 0) continue;

          const slotKwh = (s1.load_today_kwh ?? 0) >= (s0.load_today_kwh ?? 0)
            ? (s1.load_today_kwh ?? 0) - (s0.load_today_kwh ?? 0)
            : (s1.load_today_kwh ?? 0);
          if (slotKwh <= 0) { houseEnergyKwh += 0; continue; }

          const slotW = slotKwh / slotMin * 60 * 1000;

          if (slotW > maxHouseW) {
            const houseSlotW   = Math.max(100, slotW - evChargeW);
            const houseSlotKwh = houseSlotW / 1000 * slotMin / 60;
            houseEnergyKwh += houseSlotKwh;
            evDetected = true;
            evSlots++;
          } else {
            houseEnergyKwh += slotKwh;
          }
        }

        if (chain.length >= 2) {
          const spanMin = (new Date(chain[chain.length - 1].snapshot_ts) - new Date(chain[0].snapshot_ts)) / 60000;
          consumption_w = Math.round(houseEnergyKwh / spanMin * 60 * 1000);

          if (evDetected) {
            consumptionSource = 'inverter_delta_ev';
            log.info('consumption',
              `${prevHourTs}: EV detected in ${evSlots} of ${chain.length - 1} sub-hourly slot(s) — storing house-only ${consumption_w}W`);
          }
        } else {
          const spanMin = (new Date(snapNow.snapshot_ts) - new Date(snapPrev.snapshot_ts)) / 60000;
          const normW   = Math.round(deltaLoad * 1000 * 60 / Math.max(1, spanMin));
          if (normW > maxHouseW) {
            consumption_w = Math.max(100, normW - evChargeW);
            consumptionSource = 'inverter_delta_ev';
            log.info('consumption', `${prevHourTs}: EV detected (normalised ${normW}W, span ${Math.round(spanMin)}min) — storing house-only ${consumption_w}W`);
          } else {
            consumption_w = normW;
          }
        }
      } else {
        const spanMin = (new Date(snapNow.snapshot_ts) - new Date(snapPrev.snapshot_ts)) / 60000;
        consumption_w = Math.round(deltaLoad * 1000 * 60 / Math.max(1, spanMin));
      }
      upsertConsumption(prevHourTs, consumption_w, outdoorTemp, consumptionSource);
      updateActual(prevHourTs, deltaPv);

      log.info('consumption', `${prevHourTs}: load=${(deltaLoad ?? 0).toFixed(2)}kWh (${Math.round(consumption_w)}W), PV=${deltaPv.toFixed(2)}kWh, temp=${outdoorTemp}°C`);
      recordPipelineRun('consumption');
      return;
    }
  } catch (err) {
    log.error('consumption', 'Consumption delta error', err);
  }

  // Fallback: instantaneous reading
  if (typeof driver.getMetrics !== 'function') return;
  try {
    log.warn('consumption', 'No energy snapshots — falling back to instantaneous reading');
    const metrics = await driver.getMetrics(cfg);
    upsertConsumption(currentHourTs, metrics.consumption_w, outdoorTemp, 'inverter_instant');
    updateActual(currentHourTs, metrics.solar_w / 1000);
    log.info('consumption', `Instantaneous fallback at ${currentHourTs}: consumption=${Math.round(metrics.consumption_w)}W, solar=${Math.round(metrics.solar_w)}W`);
    recordPipelineRun('consumption');
  } catch (err) {
    log.error('consumption', 'Consumption fallback error', err);
    recordPipelineRun('consumption', 'error');
  }
}
