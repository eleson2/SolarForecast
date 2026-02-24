/**
 * Minimal logger — writes timestamped lines to stdout and logs/app.log.
 *
 * PM2 captures stdout/stderr to its own log files (~/.pm2/logs/).
 * The local logs/app.log lets you tail -f without going through PM2.
 *
 * Usage:
 *   import log from './src/logger.js';
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
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const errPart = err ? ` | ${err.stack ?? err.message ?? err}` : '';
  const line = `${ts} [${level}] [${tag}] ${msg}${errPart}\n`;

  // stdout — PM2 captures this
  process.stdout.write(line);

  // local file
  try {
    rotatIfNeeded();
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) { /* never let logging crash the app */ }
}

const log = {
  info:  (tag, msg)       => write('INFO ', tag, msg),
  warn:  (tag, msg)       => write('WARN ', tag, msg),
  error: (tag, msg, err)  => write('ERROR', tag, msg, err),
};

export default log;
