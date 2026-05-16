/**
 * Levelled logger — writes timestamped lines to stdout and logs/app.log.
 *
 * Levels (lowest → highest): debug < info < warn < error
 * Set LOG_LEVEL=debug in the environment (or NSSM AppEnvironmentExtra) to enable
 * verbose output during development. Production default is 'info'.
 *
 * NSSM captures stdout/stderr to logs/nssm-out.log and logs/nssm-error.log.
 * The local logs/app.log lets you tail -f without going through NSSM.
 *
 * Usage:
 *   import log from './src/logger.js';
 *   log.debug('model', `row ${hourTs}: prodForecast=${val}`);  // dev only
 *   log.info('scheduler', 'pipeline started');
 *   log.warn('modbus', 'reconnecting after timeout');
 *   log.error('scheduler', 'pipeline failed', err);
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR  = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

const LEVELS = {
  debug: { val: 0, name: 'DEBUG' },
  info:  { val: 1, name: 'INFO ' },
  warn:  { val: 2, name: 'WARN ' },
  error: { val: 3, name: 'ERROR' },
};
const activeLevel = (LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info).val;

// Max log file size before rotation (10 MB)
const MAX_BYTES = 10 * 1024 * 1024;

fs.mkdirSync(LOG_DIR, { recursive: true });

function rotatIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch (_) { /* file doesn't exist yet — fine */ }
}

function write(level, tag, msg, err) {
  if (level.val < activeLevel) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const errPart = err ? ` | ${err.stack ?? err.message ?? err}` : '';
  const line = `${ts} [${level.name}] [${tag}] ${msg}${errPart}\n`;

  process.stdout.write(line);

  try {
    rotatIfNeeded();
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) { /* never let logging crash the app */ }
}

const log = {
  debug: (tag, msg)       => write(LEVELS.debug, tag, msg),
  info:  (tag, msg)       => write(LEVELS.info,  tag, msg),
  warn:  (tag, msg)       => write(LEVELS.warn,  tag, msg),
  error: (tag, msg, err)  => write(LEVELS.error, tag, msg, err),
  isDebug: activeLevel <= LEVELS.debug.val,
};

export default log;
