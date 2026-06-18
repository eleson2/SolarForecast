import os from 'os';
// Lower process priority so the scheduler doesn't lag the desktop
try { os.setPriority(os.constants.priority.PRIORITY_LOW); } catch {}

import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { validateConfig } from './src/config-validator.js';
import {
  fetchPipeline,
  batteryPipeline,
  snapshotPipeline,
  executePipeline,
  runExecuteCycle
} from './src/inverter-engine.js';
import { runConsumptionPipeline } from './src/consumption.js';
import { runLearnPipeline } from './src/learner.js';
import { runSmoothPipeline } from './src/smoother.js';
import config from './config.js';
import app from './src/api.js';
import { registerExecuteRunner } from './src/battery-api.js';
import log from './src/logger.js';

// Let the WakeToRun scheduled task drive the execute cycle via POST /battery/execute
// after a sleep-wake (node-cron can't be relied on to fire in the brief post-resume
// window). Same function as the cron below; debounced so the two can't double-run.
registerExecuteRunner(runExecuteCycle);

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

// Every 15 min: snapshot → execute. Fires when the host is awake; when it's asleep the
// WakeToRun scheduled task wakes it and triggers the same cycle via POST /battery/execute.
cron.schedule('*/15 * * * *', () => runExecuteCycle({ source: 'cron' }));

// --- Config file watcher ---
const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'config.js');
let configReloadTimer = null;
// Snapshot the file hash at startup so spurious fs.watch events (Windows NTFS access-time
// updates, Search Indexer touches, etc.) don't trigger unnecessary restarts.
const configHashAtStart = createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');

const configWatcher = fs.watch(configPath, () => {
  if (configReloadTimer) return;
  let currentHash;
  try {
    currentHash = createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
  } catch { return; }
  if (currentHash === configHashAtStart) {
    log.info('scheduler', 'config.js watch event — content unchanged, ignoring (spurious OS event)');
    return;
  }
  const debounceMs = config.system?.config_reload_debounce_ms ?? 30000;
  configReloadTimer = setTimeout(() => {
    log.info('scheduler', 'config.js changed — restarting to apply new settings');
    // Close the HTTP server before exiting so NSSM's immediate restart doesn't hit EADDRINUSE
    server.close(() => process.exit(0));
  }, debounceMs);
});
process.on('exit', () => configWatcher.close());

// --- Start server ---
const server = app.listen(PORT, () => {
  log.info('scheduler', `Solar Forecast API running on port ${PORT}`);
  log.info('scheduler', `Cron jobs: fetch (6h), learn (1h), smooth (24h), battery (${dayAheadHour}:15 + hourly), consumption (:05), execute (15min)`);
});
// Fail loudly (not via an unhandled 'error' crash) if the port is taken — this means a second
// instance is running (e.g. a duplicate service). Without this, the duplicate crash-loops and
// each launch fires the startup pipelines, producing a "fetch storm". See todo-ops.md.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error('scheduler', `Port ${PORT} already in use — another SolarForecast instance is already running. Exiting this duplicate.`);
  } else {
    log.error('scheduler', 'HTTP server error', err);
  }
  process.exit(1);
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
