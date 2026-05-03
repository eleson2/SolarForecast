import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import log from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, '..', 'data', 'raw');

/**
 * Retry a async function up to `attempts` times with a fixed delay between tries.
 * Throws the last error if all attempts fail.
 */
export async function withRetry(fn, { attempts = 3, delayMs = 5000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        log.warn('fetch', `Attempt ${i}/${attempts} failed: ${err.message} — retrying in ${delayMs / 1000}s`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

export function saveRaw(prefix, data) {
  const iso = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const filename = `${prefix}_${iso}.json`;
  fs.writeFileSync(path.join(RAW_DIR, filename), JSON.stringify(data, null, 2));
  return filename;
}

export async function fetchWeather() {
  const { lat, lon } = config.location;

  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&hourly=shortwave_radiation,cloud_cover`
    + `&forecast_days=2`
    + `&timezone=${encodeURIComponent(config.location.timezone)}`;

  return withRetry(async () => {
    log.info('fetch', `GET ${url}`);
    const t0 = Date.now();
    const res = await fetch(url);
    log.info('fetch', `${res.status} in ${Date.now() - t0}ms`);
    if (!res.ok) {
      throw new Error(`Open-Meteo request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const filename = saveRaw('openmeteo', data);
    log.info('fetch', `Saved raw weather data to ${filename}`);
    return data;
  });
}
