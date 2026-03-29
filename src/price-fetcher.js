import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { upsertPricesBatch } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, '..', 'data', 'raw');

/**
 * Format a Date as "YYYY-MM-DD" in configured timezone.
 */
function localDate(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Fetch prices for a single date, trying configured sources in order.
 * Returns array of { slot_ts, spot_price, region } or null if all sources fail.
 */
async function fetchPricesForDate(date) {
  const sources = Array.isArray(config.price.sources)
    ? config.price.sources
    : [config.price.source]; // backward compat with legacy single-source config

  const dateStr = localDate(date);

  for (const source of sources) {
    let provider;
    try {
      provider = await import(`./prices/${source}.js`);
    } catch {
      throw new Error(`Unknown price source '${source}': no file found at src/prices/${source}.js`);
    }

    const result = await provider.fetchPricesForDate(dateStr, config.price.region);
    if (!result) {
      const hasNext = sources.indexOf(source) < sources.length - 1;
      console.log(`[price-fetcher] ${source}: no prices for ${dateStr}${hasNext ? ', trying next source' : ''}`);
      continue;
    }

    // Archive raw JSON
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
    const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
    const filename = `prices_${source}_${stamp}_${time}_${dateStr}.json`;
    fs.writeFileSync(path.join(RAW_DIR, filename), JSON.stringify(result.raw, null, 2));
    console.log(`[price-fetcher] Saved raw price data to ${filename}`);
    if (source !== sources[0]) {
      console.log(`[price-fetcher] Used fallback source: ${source}`);
    }

    return result.prices;
  }

  return null; // all sources exhausted
}

/**
 * Fetch today's and tomorrow's prices, upsert into DB.
 * Returns { today: count, tomorrow: count }.
 */
export async function fetchPrices() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // Fetch today
  const todayPrices = await fetchPricesForDate(now);
  let todayCount = 0;
  if (todayPrices) {
    upsertPricesBatch(todayPrices);
    todayCount = todayPrices.length;
    console.log(`[price-fetcher] Upserted ${todayCount} price slots for today`);
  }

  // Fetch tomorrow (may not be available yet)
  let tomorrowCount = 0;
  const tomorrowPrices = await fetchPricesForDate(tomorrow);
  if (tomorrowPrices) {
    upsertPricesBatch(tomorrowPrices);
    tomorrowCount = tomorrowPrices.length;
    console.log(`[price-fetcher] Upserted ${tomorrowCount} price slots for tomorrow`);
  } else {
    console.log('[price-fetcher] Tomorrow\'s prices not yet available');
  }

  return { today: todayCount, tomorrow: tomorrowCount };
}
