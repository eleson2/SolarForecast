import os from 'os';
// Lower process priority so the scheduler doesn't lag the desktop
try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch {}

import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from './src/config-validator.js';
import { fetchWeather } from './src/fetcher.js';
import { parseWeatherData } from './src/parser.js';
import { fetchYr } from './src/yr-fetcher.js';
import { parseYrData } from './src/yr-parser.js';
import { localTs } from './src/timeutils.js';
import { runModel } from './src/model.js';
import { runLearner } from './src/learner.js';
import { learnConsumptionModel } from './src/consumption-learner.js';
import { runSmoother } from './src/smoother.js';
import { fetchPrices } from './src/price-fetcher.js';
import { estimateConsumption } from './src/consumption.js';
import { runOptimizer as runOptimizerLP } from './src/optimizer-lp.js';
import { getScheduleForRange, upsertConsumption, updateActual, upsertEnergySnapshot, getSnapshotAtOrBefore, getSnapshotsForRange, recordPipelineRun, getIntradaySolarRatio, getIntradaySolarRatioByBand } from './src/db.js';
import { getDriver, getDriverConfig } from './src/inverter-dispatcher.js';
import { getOverride, setOverride, clearOverrideBySource } from './src/override.js';
import { resolvePeakShavingLimits } from './src/peak-shaving.js';
import { setLpShadow, setSellShadow } from './src/battery-api.js';
import config from './config.js';
import app from './src/api.js';
import log from './src/logger.js';

// Validate config at startup — fail fast with a clear message rather than
// a cryptic runtime error deep in a pipeline.
try {
  validateConfig(config);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Global safety net: log unhandled promise rejections instead of crashing.
// The pipelines all have their own try/catch, but if something slips through
// (e.g. a fire-and-forget call that throws before its try block) this prevents
// a crash-restart loop when the inverter is offline.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error('scheduler', 'Unhandled promise rejection (non-fatal)', err);
});

const PORT = process.env.PORT || 3000;

// Last SOC successfully read from the inverter.
// Used as fallback when a live read fails, so Modbus timeouts don't reset the
// optimizer back to the pessimistic min_soc default.
let lastKnownSoc = null;

// Returns the current 15-minute slot window as local timestamp strings.
function currentWindow() {
  const now = new Date();
  const currentSlot = new Date(now);
  currentSlot.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
  const endSlot = new Date(currentSlot.getTime() + 24 * 60 * 60 * 1000);
  return {
    currentSlot,
    fromTs: localTs(currentSlot, config.location.timezone),
    toTs:   localTs(endSlot, config.location.timezone),
  };
}

// --- Pipeline functions ---

async function fetchPipeline() {
  try {
    log.info('fetch', 'Starting fetch pipeline');

    // Fetch both sources in parallel — no data dependency between them.
    const [omResult, yrResult] = await Promise.allSettled([fetchWeather(), fetchYr()]);

    if (omResult.status === 'rejected') throw omResult.reason;
    parseWeatherData(omResult.value);

    if (yrResult.status === 'fulfilled') {
      parseYrData(yrResult.value);
    } else {
      log.warn('fetch', `YR fetch failed (non-fatal, using Open-Meteo cloud data): ${yrResult.reason?.message}`);
    }

    runModel();
    log.info('fetch', 'Fetch pipeline complete');
    recordPipelineRun('fetch');
  } catch (err) {
    log.error('fetch', 'Fetch pipeline error', err);
    recordPipelineRun('fetch', 'error');
  }
}

function learnPipeline() {
  try {
    runLearner();
    learnConsumptionModel();
    // Re-run the model for all future hours so that correction-matrix and
    // recency-bias updates from the learner immediately flow into remaining-day forecasts.
    runModel();
    recordPipelineRun('learn');
  } catch (err) {
    log.error('learn', 'Learn pipeline error', err);
    recordPipelineRun('learn', 'error');
  }
}

function smoothPipeline() {
  try {
    runSmoother();
    recordPipelineRun('smooth');
  } catch (err) {
    log.error('smooth', 'Smooth pipeline error', err);
    recordPipelineRun('smooth', 'error');
  }
}

// --- Battery optimizer pipeline ---

async function batteryPipeline() {
  try {
    log.info('battery', 'Starting battery optimizer pipeline');
    await fetchPrices();

    const { currentSlot, fromTs, toTs } = currentWindow();
    const consumption = await estimateConsumption(currentSlot);

    // Read live SOC from inverter if available
    const options = {};
    const driver = getDriver();
    if (driver) {
      try {
        const state = await driver.getState(getDriverConfig());
        options.startSoc = state.soc;
        lastKnownSoc = state.soc;
        log.info('battery', `Live SOC from inverter: ${state.soc}%`);
      } catch (err) {
        if (lastKnownSoc !== null) {
          options.startSoc = lastKnownSoc;
          log.warn('battery', `Could not read inverter SOC: ${err.message} — using last known ${lastKnownSoc}%`);
        } else {
          log.warn('battery', `Could not read inverter SOC: ${err.message}`);
        }
      }
    }

    // Intra-day solar correction: if today's actuals diverge from the forecast,
    // (1) trigger a re-fetch so future hours use the latest NWP data, then
    // (2) apply per-cloud-cover-band scalars so each remaining hour is corrected
    //     using completed hours that experienced similar sky conditions.
    const todayDate = fromTs.slice(0, 10);
    const rawRatio = getIntradaySolarRatio(todayDate);
    const scalarMax = config.learning.intraday_scalar_max ?? 3.0;
    const refetchThreshold = config.learning.intraday_refetch_threshold ?? 1.8;

    if (rawRatio !== null && rawRatio > refetchThreshold) {
      log.info('battery', `Intra-day ratio ${rawRatio.toFixed(2)}× > ${refetchThreshold} — triggering re-fetch for fresh NWP data`);
      await fetchPipeline();
    }

    if (rawRatio !== null) {
      const bandRows = getIntradaySolarRatioByBand(todayDate);
      const cloudBandScalars = new Map();
      for (const row of bandRows) {
        if (row.sample_count >= 1 && row.forecast_sum > 0) {
          cloudBandScalars.set(row.band, Math.max(0.1, Math.min(scalarMax, row.actual_sum / row.forecast_sum)));
        }
      }

      if (cloudBandScalars.size > 0) {
        options.cloudBandScalars = cloudBandScalars;
        // Global scalar acts as fallback for hours with no cloud_cover data
        options.intradayScalar = Math.max(0.1, Math.min(scalarMax, rawRatio));
        const bandSummary = [...cloudBandScalars.entries()]
          .map(([b, s]) => `${b}%:${s.toFixed(2)}×`)
          .join(' ');
        log.info('battery', `Intra-day scalars by cloud band: ${bandSummary} (global fallback: ${options.intradayScalar.toFixed(2)}×)`);
      } else {
        options.intradayScalar = Math.max(0.1, Math.min(scalarMax, rawRatio));
        log.info('battery', `Intra-day solar scalar: ${options.intradayScalar.toFixed(2)}× (actual/forecast=${(rawRatio * 100).toFixed(0)}%, no band data)`);
      }
    }

    const { summary, schedule } = await runOptimizerLP(fromTs, toTs, consumption, options);
    if (!schedule.length) {
      log.warn('battery', 'LP returned no schedule — skipping DB write');
      return;
    }
    setLpShadow(summary, schedule); // keep API shadow field up to date
    log.info('battery', `LP optimizer: savings ${summary?.estimated_savings} ${config.price.currency}`);

    // Sell shadow: if sell is currently disabled, run a dry-run with sell enabled
    // to show potential extra savings on the dashboard without affecting the schedule.
    if (!config.grid.sell_enabled) {
      const { summary: sellSum } = await runOptimizerLP(fromTs, toTs, consumption,
        { ...options, dryRun: true, sellEnabled: true });
      if (sellSum) {
        setSellShadow(sellSum);
        const extra = (sellSum.estimated_savings - summary.estimated_savings).toFixed(2);
        log.info('battery', `Sell shadow (dry-run): savings ${sellSum.estimated_savings} ${config.price.currency} (extra ${extra >= 0 ? '+' : ''}${extra})`);
      }
    }

    log.info('battery', 'Battery optimizer pipeline complete');
    recordPipelineRun('battery');
  } catch (err) {
    log.error('battery', 'Battery optimizer error', err);
    recordPipelineRun('battery', 'error');
  }
}

// --- Energy snapshot pipeline (every 15 min) ---
// Reads daily cumulative energy totals from inverter and stores a timestamped snapshot.
// These snapshots are later used by consumptionPipeline to derive hourly deltas.

async function snapshotPipeline() {
  const driver = getDriver();
  if (!driver || typeof driver.getEnergyTotals !== 'function') return;

  const cfg = getDriverConfig();
  try {
    const totals = await driver.getEnergyTotals(cfg);
    const snapshotTs = localTs(new Date(), config.location.timezone);
    upsertEnergySnapshot(
      snapshotTs,
      totals.pv_today_kwh,
      totals.load_today_kwh,
      totals.grid_import_today_kwh,
      totals.grid_export_today_kwh,
    );
    log.info('snapshot', `${snapshotTs}: PV=${totals.pv_today_kwh}kWh load=${totals.load_today_kwh}kWh grid_in=${totals.grid_import_today_kwh}kWh`);
    recordPipelineRun('snapshot');
  } catch (err) {
    log.error('snapshot', 'Snapshot pipeline error', err);
    recordPipelineRun('snapshot', 'error');
  }
}

// --- Consumption collection pipeline (hourly) ---
// Derives last hour's energy consumption and PV production from the delta between
// the snapshot at the current hour start and the snapshot one hour prior.

async function consumptionPipeline() {
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

      // ── Sub-hourly EV detection ───────────────────────────────────────────────
      // Build a snapshot chain spanning [snapPrev, …15-min snapshots…, snapNow].
      // Walk consecutive pairs: normalise each slot to watts, flag slots where
      // load > max_house_w as EV-charging, and sum house-only energy separately.
      // This catches both intra-hour EV cycling (missed by hourly averages) and
      // boundary-offset inflation (a 75-min delta treated as 60 min falsely
      // exceeds the threshold — per-slot normalisation eliminates the distortion).
      let consumption_w;
      let consumptionSource = 'inverter_delta';

      const evEnabled  = config.ev?.enabled && (config.ev.charge_watts > 0);
      const maxHouseW  = config.consumption?.max_house_w ?? Infinity;
      const evChargeW  = config.ev?.charge_watts ?? 0;

      if (evEnabled && maxHouseW < Infinity) {
        // Fetch all snapshots in [prevHourTs, currentHourTs]; prepend snapPrev if
        // it sits before prevHourTs (boundary-offset case).
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

          // Per-slot kWh (handle midnight reset within the chain)
          const slotKwh = (s1.load_today_kwh ?? 0) >= (s0.load_today_kwh ?? 0)
            ? (s1.load_today_kwh ?? 0) - (s0.load_today_kwh ?? 0)
            : (s1.load_today_kwh ?? 0);
          if (slotKwh <= 0) { houseEnergyKwh += 0; continue; }

          // Normalise to 1-hour equivalent watts for threshold comparison
          const slotW = slotKwh / slotMin * 60 * 1000;

          if (slotW > maxHouseW) {
            // EV charging this slot — strip EV draw, keep house-only energy
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
          // Normalise accumulated house energy to the actual chain span
          const spanMin = (new Date(chain[chain.length - 1].snapshot_ts) - new Date(chain[0].snapshot_ts)) / 60000;
          consumption_w = Math.round(houseEnergyKwh / spanMin * 60 * 1000);

          if (evDetected) {
            consumptionSource = 'inverter_delta_ev';
            log.info('consumption',
              `${prevHourTs}: EV detected in ${evSlots} of ${chain.length - 1} sub-hourly slot(s) — storing house-only ${consumption_w}W`);
          }
        } else {
          // Fewer than 2 snapshots in chain — fall back to time-normalised hourly delta
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
        // EV detection disabled — just time-normalise
        const spanMin = (new Date(snapNow.snapshot_ts) - new Date(snapPrev.snapshot_ts)) / 60000;
        consumption_w = Math.round(deltaLoad * 1000 * 60 / Math.max(1, spanMin));
      }
      upsertConsumption(prevHourTs, consumption_w, outdoorTemp, consumptionSource);

      // prod_actual stored in kW (matches prod_forecast units)
      updateActual(prevHourTs, deltaPv);

      log.info('consumption', `${prevHourTs}: load=${(deltaLoad ?? 0).toFixed(2)}kWh (${Math.round(consumption_w)}W), PV=${deltaPv.toFixed(2)}kWh, temp=${outdoorTemp}°C`);
      recordPipelineRun('consumption');
      return;
    }
  } catch (err) {
    log.error('consumption', 'Consumption delta error', err);
  }

  // Fallback: no snapshots available — use instantaneous reading
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

// Returns { import_kw, export_kw } for the given "YYYY-MM-DDTHH:MM" timestamp,
// or null if peak shaving is disabled / not configured.
function getPeakShavingLimits(psConfig, slotTs) {
  return resolvePeakShavingLimits(psConfig, slotTs);
}

// --- Inverter execution pipeline ---

let lastPeakShavingKey = null; // track last written "{import}/{export}" to avoid redundant writes

async function executePipeline() {
  const driver = getDriver();
  if (!driver) return; // no inverter configured — skip silently

  const cfg = getDriverConfig();
  try {
    log.info('execute', 'Starting inverter execution pipeline');

    // Read inverter state. Use getMetrics() when EV auto-charge is enabled so we
    // can see solar_w and consumption_w for EV detection; otherwise getState() suffices.
    const evAutoCharge = config.ev?.enabled && config.ev?.auto_charge_grid;
    const state = evAutoCharge && typeof driver.getMetrics === 'function'
      ? await driver.getMetrics(cfg)
      : await driver.getState(cfg);
    lastKnownSoc = state.soc;
    log.info('execute', `Inverter SOC: ${state.soc}%, power: ${state.power_w ?? state.battery_w ?? 0}W`
      + (state.solar_w != null ? `, solar: ${Math.round(state.solar_w)}W, load: ${Math.round(state.consumption_w)}W` : ''));

    // Persist actual SOC into energy snapshot for dashboard historical display.
    // Use the slot boundary timestamp (not wall-clock) so the dashboard lookup
    // by slot matches exactly. COALESCE upsert merges with energy totals if
    // snapshotPipeline already wrote this slot.
    const { fromTs: slotTs } = currentWindow();
    upsertEnergySnapshot(slotTs, null, null, null, null, state.soc);

    // EV auto-charge: when the EV is drawing power AND solar is not producing,
    // trigger a 'charge' override so the battery fills to charge_soc (90%) alongside
    // the EV — useful during Tibber Grid Rewards events.
    // Detection: total load significantly exceeds max house load alone.
    // Guard: skip when solar is producing to avoid buying grid power unnecessarily.
    if (evAutoCharge && state.consumption_w != null) {
      const maxHouseW   = config.consumption?.max_house_w ?? 5000;
      const evChargeW   = config.ev?.charge_watts ?? 5300;
      const solarThresh = config.ev?.auto_charge_solar_threshold_w ?? 200;
      const evDetected  = state.consumption_w > maxHouseW + evChargeW * 0.5;
      const solarLow    = (state.solar_w ?? 0) < solarThresh;

      if (evDetected && solarLow) {
        log.info('execute', `EV charging detected (load ${Math.round(state.consumption_w)}W > house ${maxHouseW}W + half EV ${evChargeW / 2}W) — triggering battery charge`);
        setOverride('charge', 20, 'ev_detection'); // refreshed every 15-min cycle while EV active
      } else {
        clearOverrideBySource('ev_detection');
        if (evDetected && !solarLow) {
          log.info('execute', `EV detected but solar active (${Math.round(state.solar_w)}W) — skipping auto-charge`);
        }
      }
    }

    // Apply override if active (manual takes priority; ev_detection was just set above if needed).
    const activeOverride = getOverride();
    if (activeOverride) {
      log.info('execute', `Override active [${activeOverride.source}]: ${activeOverride.action}, ${activeOverride.remaining_minutes} min remaining`);
      if (typeof driver[activeOverride.action] === 'function') {
        await driver[activeOverride.action](cfg);
        log.info('execute', `Applied override action: ${activeOverride.action}`);
      }
      recordPipelineRun('execute');
      return;
    }

    // Get schedule for now → +24h
    const { fromTs, toTs } = currentWindow();
    const slots = getScheduleForRange(fromTs, toTs);
    if (!slots.length) {
      log.warn('execute', 'No schedule slots found — skipping execution');
      return;
    }

    // SOC deviation guard: actual below plan by more than threshold → replan (price-aware)
    // unless SOC is below soc_replan_min_soc, in which case charge immediately (safety floor).
    const socDeviationThreshold = config.battery?.soc_deviation_threshold ?? 8;
    const socReplanMinSoc = config.battery?.soc_replan_min_soc ?? 30;
    const plannedSoc = slots[0]?.soc_start;
    let triggerReplan = false;
    let forceCharge = false;
    if (plannedSoc != null && state.soc < plannedSoc - socDeviationThreshold) {
      const deficit = Math.round(plannedSoc - state.soc);
      if (state.soc >= socReplanMinSoc) {
        log.warn('execute', `SOC deviation: actual ${state.soc}% vs planned ${plannedSoc}% (−${deficit}%) — SOC above ${socReplanMinSoc}%, triggering replan`);
        triggerReplan = true;
      } else {
        log.warn('execute', `SOC deviation: actual ${state.soc}% vs planned ${plannedSoc}% (−${deficit}%) — SOC below ${socReplanMinSoc}%, forcing charge_grid`);
        forceCharge = true;
      }
    }

    const dispatchSlots = forceCharge
      ? [{ ...slots[0], action: 'charge_grid' }, ...slots.slice(1)]
      : slots;
    const result = await driver.applySchedule(dispatchSlots, cfg);
    log.info('execute', `Inverter execution done: ${result.applied} applied, ${result.skipped} skipped`);

    // Apply peak shaving limits only when they change (avoids writing every 15 min)
    const psLimits = getPeakShavingLimits(config.peak_shaving, fromTs);
    const psKey = psLimits ? `${psLimits.import_kw}/${psLimits.export_kw}` : null;
    if (psLimits !== null && psKey !== lastPeakShavingKey && typeof driver.setPeakShavingTarget === 'function') {
      try {
        await driver.setPeakShavingTarget(psLimits, cfg);
        lastPeakShavingKey = psKey;
        log.info('execute', `Peak shaving limits set: import=${psLimits.import_kw} kW, export=${psLimits.export_kw} kW`);
      } catch (psErr) {
        log.warn('execute', `Peak shaving write failed (non-fatal): ${psErr.message}`);
      }
    }

    recordPipelineRun('execute');
    return triggerReplan;
  } catch (err) {
    log.error('execute', 'Inverter execution error', err);
    // For transient connection failures (timeout, refused) the inverter is likely
    // still operating correctly on whatever was last written. Resetting would
    // clobber that state (e.g., interrupt an active charge) for no benefit.
    const isTransient = /timed out|timeout|ECONNREFUSED|ETIMEDOUT/i.test(err.message);
    if (isTransient) {
      log.warn('execute', 'Transient connection error — leaving inverter state unchanged');
      return;
    }
    try {
      await driver.resetToDefault(cfg);
      log.info('execute', 'Inverter reset to default after error');
    } catch (resetErr) {
      log.error('execute', 'Inverter reset also failed', resetErr);
    }
  }
}

// --- Cron schedules ---

// Every 6 hours: fetch → parse → model
cron.schedule('0 */6 * * *', () => {
  fetchPipeline();
});

// Every 1 hour: learner
cron.schedule('0 * * * *', () => {
  learnPipeline();
});

// Every 24 hours at 02:00: smoother
cron.schedule('0 2 * * *', () => {
  smoothPipeline();
});

// Shortly after day-ahead prices publish: fetch tomorrow's prices → run optimizer
const dayAheadHour = config.price.day_ahead_hour;
cron.schedule(`15 ${dayAheadHour} * * *`, () => {
  batteryPipeline();
});

// Every 1 hour at :30: re-optimize remaining slots
cron.schedule('30 * * * *', () => {
  batteryPipeline();
});

// Every 1 hour at :05: collect consumption from inverter
cron.schedule('5 * * * *', () => {
  consumptionPipeline();
});

// Every 15 min: snapshot → execute.
// batteryPipeline is NOT run here on every cycle — it runs hourly at :30.
// The stable hourly SOC curve is what lets the deviation guard detect unexpected drain.
// Exception: if executePipeline detects a SOC deviation above soc_replan_min_soc, a replan
// is triggered immediately so the optimizer can find the cheapest recovery slot.
// Below soc_replan_min_soc, charge_grid is forced directly (safety floor — no waiting).
cron.schedule('*/15 * * * *', async () => {
  await snapshotPipeline();
  if (!config.inverter.data_collection_only) {
    const deviated = await executePipeline();
    if (deviated) await batteryPipeline();
  }
});

// --- Config file watcher ---
// Exit cleanly on config change so PM2 auto-restarts with the new settings.
// Debounce guards against editors that write the file twice in quick succession.
const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config.js');
let configReloadTimer = null;
const configWatcher = fs.watch(configPath, () => {
  if (configReloadTimer) return;
  const debounceMs = config.system?.config_reload_debounce_ms ?? 30000;
  configReloadTimer = setTimeout(() => {
    log.info('scheduler', 'config.js changed — restarting to apply new settings');
    process.exit(0);
  }, debounceMs);
});
process.on('exit', () => configWatcher.close());

// --- Start server ---

app.listen(PORT, () => {
  log.info('scheduler', `Solar Forecast API running on port ${PORT}`);
  log.info('scheduler', `Cron jobs: fetch (6h), learn (1h), smooth (24h), battery (${dayAheadHour}:15 + hourly), consumption (:05), execute (15min)`);
});

// Run initial pipelines on startup.
// fetchPipeline and consumptionPipeline don't use the inverter — run in parallel.
// snapshotPipeline, batteryPipeline, and executePipeline all open Modbus connections:
// run them sequentially so we never hammer the datalogger with concurrent TCP connections,
// which can trigger its rate-limiter and turn a transient timeout into a crash loop.
fetchPipeline();
consumptionPipeline();
(async () => {
  await snapshotPipeline();
  await batteryPipeline();
  if (!config.inverter.data_collection_only) {
    await executePipeline();
  }
})().catch(err => log.error('scheduler', 'Startup pipeline error', err));
