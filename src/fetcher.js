import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, '..', 'data', 'raw');

export async function fetchWeather() {
  const { lat, lon } = config.location;

  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&hourly=shortwave_radiation,direct_radiation,diffuse_radiation`
    + `&forecast_days=2`
    + `&timezone=${encodeURIComponent(config.location.timezone)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  // Write raw JSON to data/raw/
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const filename = `openmeteo_${stamp}_${time}.json`;
  fs.writeFileSync(path.join(RAW_DIR, filename), JSON.stringify(data, null, 2));

  console.log(`[fetcher] Saved raw weather data to ${filename}`);
  return data;
}
