import cron from 'node-cron';
import { fetchWeather } from './src/fetcher.js';
import { parseWeatherData } from './src/parser.js';
import { runModel } from './src/model.js';
import { runLearner } from './src/learner.js';
import { runSmoother } from './src/smoother.js';
import { fetchPrices } from './src/price-fetcher.js';
import { estimateConsumption } from './src/consumption.js';
import { runOptimizer } from './src/optimizer.js';
import { getScheduleForRange, upsertConsumption, updateActual, upsertEnergySnapshot, getSnapshotAtOrBefore } from './src/db.js';
import { getDriver, getDriverConfig } from './src/inverter-dispatcher.js';
import config from './config.js';
import app from './src/api.js';
import log from './src/logger.js';

const PORT = process.env.PORT || 3000;

// --- Pipeline functions ---

async function fetchPipeline() {
  try {
    log.info('fetch', 'Starting fetch pipeline');
    const data = await fetchWeather();
    parseWeatherData(data);
    runModel();
    log.info('fetch', 'Fetch pipeline complete');
  } catch (err) {
    log.error('fetch', 'Fetch pipeline error', err);
  }
}

function learnPipeline() {
  try {
    runLearner();
  } catch (err) {
    log.error('learn', 'Learn pipeline error', err);
  }
}

function smoothPipeline() {
  try {
    runSmoother();
  } catch (err) {
    log.error('smooth', 'Smooth pipeline error', err);
  }
}

// --- Battery optimizer pipeline ---

function localTs(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

async function batteryPipeline() {
  try {
    log.info('battery', 'Starting battery optimizer pipeline');
    await fetchPrices();
    const consumption = await estimateConsumption();

    const now = new Date();
    const currentSlot = new Date(now);
    currentSlot.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
    const endSlot = new Date(currentSlot.getTime() + 24 * 60 * 60 * 1000);

    const fromTs = localTs(currentSlot);
    const toTs = localTs(endSlot);

    // Read live SOC from inverter if available
    const options = {};
    const driver = getDriver();
    if (driver) {
      try {
        const state = await driver.getState(getDriverConfig());
        options.startSoc = state.soc;
        log.info('battery', `Live SOC from inverter: ${state.soc}%`);
      } catch (err) {
        log.warn('battery', `Could not read inverter SOC: ${err.message}`);
      }
    }

    runOptimizer(fromTs, toTs, consumption, options);
    log.info('battery', 'Battery optimizer pipeline complete');
  } catch (err) {
    log.error('battery', 'Battery optimizer error', err);
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
    const snapshotTs = localTs(new Date());
    upsertEnergySnapshot(
      snapshotTs,
      totals.pv_today_kwh,
      totals.load_today_kwh,
      totals.grid_import_today_kwh,
      totals.grid_export_today_kwh,
    );
    log.info('snapshot', `${snapshotTs}: PV=${totals.pv_today_kwh}kWh load=${totals.load_today_kwh}kWh grid_in=${totals.grid_import_today_kwh}kWh`);
  } catch (err) {
    log.error('snapshot', 'Snapshot pipeline error', err);
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

  const currentHourTs = localTs(currentHour);
  const prevHourTs    = localTs(prevHour);

  try {
    const snapNow  = getSnapshotAtOrBefore(currentHourTs);
    const snapPrev = getSnapshotAtOrBefore(prevHourTs);

    if (snapNow && snapPrev) {
      // Compute deltas; handle midnight reset (daily counter drops back to 0)
      const deltaLoad = snapNow.load_today_kwh >= snapPrev.load_today_kwh
        ? snapNow.load_today_kwh - snapPrev.load_today_kwh
        : snapNow.load_today_kwh;  // counter reset — value since midnight is the new reading

      const deltaPv = snapNow.pv_today_kwh >= snapPrev.pv_today_kwh
        ? snapNow.pv_today_kwh - snapPrev.pv_today_kwh
        : snapNow.pv_today_kwh;

      // kWh over 1 hour = average kW = average W × 1000
      const consumption_w = deltaLoad * 1000;
      upsertConsumption(prevHourTs, consumption_w, outdoorTemp, 'inverter_delta');

      // prod_actual stored in kW (matches prod_forecast units)
      updateActual(prevHourTs, deltaPv);

      log.info('consumption', `${prevHourTs}: load=${deltaLoad.toFixed(2)}kWh (${Math.round(consumption_w)}W), PV=${deltaPv.toFixed(2)}kWh, temp=${outdoorTemp}°C`);
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
  } catch (err) {
    log.error('consumption', 'Consumption fallback error', err);
  }
}

// --- Inverter execution pipeline ---

async function executePipeline() {
  const driver = getDriver();
  if (!driver) return; // no inverter configured — skip silently

  const cfg = getDriverConfig();
  try {
    log.info('execute', 'Starting inverter execution pipeline');

    // Read actual SOC
    const state = await driver.getState(cfg);
    log.info('execute', `Inverter SOC: ${state.soc}%, power: ${state.power_w}W, mode: ${state.mode}`);

    // Get schedule for now → +24h
    const now = new Date();
    const currentSlot = new Date(now);
    currentSlot.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
    const endSlot = new Date(currentSlot.getTime() + 24 * 60 * 60 * 1000);

    const fromTs = localTs(currentSlot);
    const toTs = localTs(endSlot);

    const slots = getScheduleForRange(fromTs, toTs);
    if (!slots.length) {
      log.warn('execute', 'No schedule slots found — skipping execution');
      return;
    }

    // Filter to future slots only
    const nowTs = localTs(now);
    const futureSlots = slots.filter(s => s.slot_ts >= nowTs);
    if (!futureSlots.length) {
      log.warn('execute', 'No future slots — skipping execution');
      return;
    }

    const result = await driver.applySchedule(futureSlots, cfg);
    log.info('execute', `Inverter execution done: ${result.applied} applied, ${result.skipped} skipped`);
  } catch (err) {
    log.error('execute', 'Inverter execution error', err);
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

// Every 15 min: snapshot energy totals + (unless data_collection_only) push schedule to inverter
cron.schedule('*/15 * * * *', () => {
  snapshotPipeline();
  if (!config.inverter.data_collection_only) {
    executePipeline();
  }
});

// --- Start server ---

app.listen(PORT, () => {
  log.info('scheduler', `Solar Forecast API running on port ${PORT}`);
  log.info('scheduler', `Cron jobs: fetch (6h), learn (1h), smooth (24h), battery (${dayAheadHour}:15 + hourly), consumption (:05), execute (15min)`);
});

// Run initial pipelines on startup
fetchPipeline();
batteryPipeline();
snapshotPipeline();
consumptionPipeline();
if (!config.inverter.data_collection_only) {
  executePipeline();
}
