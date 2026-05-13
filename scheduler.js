import os from 'os';
// Lower process priority so the scheduler doesn't lag the desktop
try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch {}

import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateConfig } from './src/config-validator.js';
import { 
  fetchPipeline, 
  batteryPipeline, 
  snapshotPipeline, 
  executePipeline 
} from './src/inverter-engine.js';
import { runConsumptionPipeline } from './src/consumption.js';
import { runLearnPipeline } from './src/learner.js';
import { runSmoothPipeline } from './src/smoother.js';
import config from './config.js';
import app from './src/api.js';
import log from './src/logger.js';

// Validate config at startup
try {
  validateConfig(config);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Global safety net
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error('scheduler', 'Unhandled promise rejection (non-fatal)', err);
});

const PORT = process.env.PORT || 3000;

// --- Cron schedules ---

// Every 6 hours: fetch → parse → model
cron.schedule('0 */6 * * *', fetchPipeline);

// Every 1 hour: learner
cron.schedule('0 * * * *', runLearnPipeline);

// Every 24 hours at 02:00: smoother
cron.schedule('0 2 * * *', runSmoothPipeline);

// Shortly after day-ahead prices publish: fetch tomorrow's prices → run optimizer
const dayAheadHour = config.price.day_ahead_hour;
cron.schedule(`15 ${dayAheadHour} * * *`, batteryPipeline);

// Every 1 hour at :30: re-optimize remaining slots
cron.schedule('30 * * * *', batteryPipeline);

// Every 1 hour at :05: collect consumption from inverter
cron.schedule('5 * * * *', runConsumptionPipeline);

// Every 15 min: snapshot → execute
cron.schedule('*/15 * * * *', async () => {
  await snapshotPipeline();
  if (!config.inverter.data_collection_only) {
    const deviated = await executePipeline();
    if (deviated) await batteryPipeline();
  }
});

// --- Config file watcher ---
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

// --- Initial pipelines on startup ---
// Independent non-inverter tasks run in parallel
Promise.all([
  fetchPipeline(),
  runConsumptionPipeline()
]).catch(err => log.error('scheduler', 'Parallel startup error', err));

// Inverter-bound tasks must run sequentially to avoid Modbus contention
(async () => {
  await snapshotPipeline();
  await batteryPipeline();
  if (!config.inverter.data_collection_only) {
    await executePipeline();
  }
})().catch(err => log.error('scheduler', 'Inverter startup pipeline error', err));
