import config from '../config.js';
import log from './logger.js';
import { getDriver, getDriverConfig } from './inverter-dispatcher.js';
import { getScheduleForRange, upsertEnergySnapshot, recordPipelineRun, getIntradaySolarRatio, getIntradaySolarRatioByBand } from './db.js';
import { getOverride, setOverride, clearOverrideBySource } from './override.js';
import { resolvePeakShavingLimits } from './peak-shaving.js';
import { currentWindow, localTs } from './timeutils.js';
import { fetchPrices } from './price-fetcher.js';
import { estimateConsumption } from './consumption.js';
import { runOptimizer as runOptimizerLP } from './optimizer-lp.js';
import { setLpShadow, setSellShadow } from './battery-api.js';
import { fetchWeather } from './fetcher.js';
import { parseWeatherData } from './parser.js';
import { fetchYr } from './yr-fetcher.js';
import { parseYrData } from './yr-parser.js';
import { runModel } from './model.js';

let lastPeakShavingKey = null; // track last written "{import}/{export}" to avoid redundant writes
let lastKnownSoc = null;
let fetchPipelineInFlight = false;

export function getLastKnownSoc() {
  return lastKnownSoc;
}

export function setLastKnownSoc(soc) {
  lastKnownSoc = soc;
}

// Guards against the 15-min cycle running twice in quick succession when both the
// node-cron job (fires when awake) and the wake-task HTTP trigger (fires after a
// sleep-wake) land in the same window. Real cycles are 15 min apart, so a 4-min
// debounce only ever suppresses the genuine duplicate.
let lastExecuteCycleTs = 0;

/**
 * The full 15-min cycle: snapshot → execute → (conditional re-optimize on deviation).
 * Driven by node-cron when the host is awake AND by the WakeToRun scheduled task
 * (via POST /battery/execute) after a sleep-wake — whichever fires first wins.
 * @param {{source?: string}} opts - 'cron' or 'wake-task', for logging.
 */
export async function runExecuteCycle({ source = 'cron' } = {}) {
  const now = Date.now();
  const sinceMs = now - lastExecuteCycleTs;
  if (sinceMs < 4 * 60 * 1000) {
    log.info('execute', `Execute cycle skipped — ran ${Math.round(sinceMs / 1000)}s ago (source=${source})`);
    return { ran: false, skipped: true };
  }
  lastExecuteCycleTs = now;
  log.info('execute', `Execute cycle start (source=${source})`);
  await snapshotPipeline();
  if (!config.inverter.data_collection_only) {
    const deviated = await executePipeline();
    if (deviated) await batteryPipeline();
  }
  return { ran: true, skipped: false };
}

/**
 * Weather fetch pipeline.
 */
export async function fetchPipeline() {
  if (fetchPipelineInFlight) {
    log.warn('fetch', 'Fetch already in progress — skipping duplicate call');
    return;
  }
  fetchPipelineInFlight = true;
  try {
    log.info('fetch', 'Starting fetch pipeline');
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
  } finally {
    fetchPipelineInFlight = false;
  }
}

/**
 * Battery optimizer pipeline.
 */
export async function batteryPipeline() {
  try {
    log.info('battery', 'Starting battery optimizer pipeline');
    await fetchPrices();

    const optimizerHorizonH = config.battery.optimizer_window_hours ?? 24;
    const { currentSlot, fromTs, toTs } = currentWindow(config.location.timezone, optimizerHorizonH);
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

    // Intra-day solar correction
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
    setLpShadow(summary, schedule);
    log.info('battery', `LP optimizer: savings ${summary?.estimated_savings} ${config.price.currency}`);

    // Sell shadow
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

/**
 * Energy snapshot pipeline.
 * Reads daily cumulative energy totals from inverter and stores a timestamped snapshot.
 */
export async function snapshotPipeline() {
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

/**
 * Main inverter execution pipeline.
...
 * Dispatches the active schedule slot to the inverter and handles overrides/guards.
 * @returns {Promise<boolean>} - true if a SOC deviation triggered a request for an immediate replan.
 */
export async function executePipeline() {
  const driver = getDriver();
  if (!driver) return false;

  const cfg = getDriverConfig();
  try {
    log.info('execute', 'Starting inverter execution pipeline');

    // Read inverter state
    const evAutoCharge = config.ev?.enabled && config.ev?.auto_charge_grid;
    const state = evAutoCharge && typeof driver.getMetrics === 'function'
      ? await driver.getMetrics(cfg)
      : await driver.getState(cfg);
    
    lastKnownSoc = state.soc;
    log.info('execute', `Inverter SOC: ${state.soc}%, power: ${state.power_w ?? state.battery_w ?? 0}W`
      + (state.solar_w != null ? `, solar: ${Math.round(state.solar_w)}W, load: ${Math.round(state.consumption_w)}W` : ''));

    // Persist actual SOC into energy snapshot
    const { fromTs: slotTs } = currentWindow(config.location.timezone);
    upsertEnergySnapshot(slotTs, null, null, null, null, state.soc);

    // EV auto-charge detection
    if (evAutoCharge && state.consumption_w != null) {
      const maxHouseW   = config.consumption?.max_house_w ?? 5000;
      const evChargeW   = config.ev?.charge_watts ?? 5300;
      const solarThresh = config.ev?.auto_charge_solar_threshold_w ?? 200;
      const evDetected  = state.consumption_w > maxHouseW + evChargeW * 0.5;
      const solarLow    = (state.solar_w ?? 0) < solarThresh;

      if (evDetected && solarLow) {
        log.info('execute', `EV charging detected (load ${Math.round(state.consumption_w)}W > house ${maxHouseW}W + half EV ${evChargeW / 2}W) — triggering battery charge`);
        setOverride('charge', 20, 'ev_detection');
      } else {
        clearOverrideBySource('ev_detection');
        if (evDetected && !solarLow) {
          log.info('execute', `EV detected but solar active (${Math.round(state.solar_w)}W) — skipping auto-charge`);
        }
      }
    }

    // Apply override if active
    const activeOverride = getOverride();
    if (activeOverride) {
      log.info('execute', `Override active [${activeOverride.source}]: ${activeOverride.action}, ${activeOverride.remaining_minutes} min remaining`);
      if (typeof driver[activeOverride.action] === 'function') {
        await driver[activeOverride.action](cfg);
        log.info('execute', `Applied override action: ${activeOverride.action}`);
      }
      recordPipelineRun('execute');
      return false;
    }

    // Get schedule for now
    const { fromTs, toTs } = currentWindow(config.location.timezone);
    const slots = getScheduleForRange(fromTs, toTs);
    if (!slots.length) {
      log.warn('execute', 'No schedule slots found — skipping execution');
      return false;
    }

    // SOC deviation guard
    const socDeviationThreshold = config.battery?.soc_deviation_threshold ?? 8;
    const plannedSoc = slots[0]?.soc_start;
    let triggerReplan = false;
    if (plannedSoc != null && state.soc < plannedSoc - socDeviationThreshold) {
      const deficit = Math.round(plannedSoc - state.soc);
      log.warn('execute', `SOC deviation: actual ${state.soc}% vs planned ${plannedSoc}% (−${deficit}%) — triggering replan`);
      triggerReplan = true;
    }

    const result = await driver.applySchedule(slots, cfg);
    log.info('execute', `Inverter execution done: ${result.applied} applied, ${result.skipped} skipped`);

    // Apply peak shaving limits
    const psLimits = resolvePeakShavingLimits(config.peak_shaving, fromTs);
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
    // Transient datalogger faults: leave the inverter in its last state and
    // retry next cycle. A failed write changed nothing, so there is no unsafe
    // state to reset — and resetToDefault() would only push more writes onto an
    // already-contended datalogger (its RS485 link to the inverter is shared
    // with the cloud uplink), amplifying the failure into the multi-hour storms
    // seen in the logs. "Modbus exception 0" is the datalogger returning a
    // corrupted/garbage write response under that contention, not a real device
    // exception, so treat it as transient too.
    // Note: sell mode is disabled, so a write failure cannot leave Grid First
    // TOU half-enabled; if sell is ever enabled, revisit whether reset is needed
    // when only the TOU write succeeded.
    const isTransient = /timed out|timeout|ECONNREFUSED|ETIMEDOUT|Modbus exception/i.test(err.message);
    if (isTransient) {
      log.warn('execute', 'Transient datalogger error — leaving inverter state unchanged, will retry next cycle');
      return false;
    }
    try {
      await driver.resetToDefault(cfg);
      log.info('execute', 'Inverter reset to default after error');
    } catch (resetErr) {
      log.error('execute', 'Inverter reset also failed', resetErr);
    }
    return false;
  }
}
