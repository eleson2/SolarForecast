import config from '../../config.js';
import log from '../logger.js';
import { withRetry } from '../fetcher.js';

/**
 * Map region code to aWATTar TLD.
 */
function regionToTld(region) {
  switch (region.toUpperCase()) {
    case 'AT': return 'at';
    case 'DE':
    default:   return 'de';
  }
}

/**
 * Fetch prices for a single date from aWATTar API (Germany/Austria).
 * API returns hourly EUR/MWh — we convert to EUR/kWh and expand to 4×15-min slots.
 * Returns array of { slot_ts, spot_price, region } or null if not available.
 */
export async function fetchPricesForDate(dateStr, region) {
  const tld = regionToTld(region);

  // Build start/end timestamps for the requested date (midnight to midnight UTC)
  const startMs = new Date(`${dateStr}T00:00:00Z`).getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;

  const url = `https://api.awattar.${tld}/v1/marketdata?start=${startMs}&end=${endMs}`;

  return withRetry(async () => {
    log.info('price', `GET ${url}`);
    const t0 = Date.now();
    const res = await fetch(url);
    log.info('price', `${res.status} in ${Date.now() - t0}ms`);

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`aWATTar API request failed: ${res.status} ${res.statusText}`);

    const body = await res.json();
    const data = body.data;
    if (!data || data.length === 0) return null;

  // Each entry: { start_timestamp, end_timestamp, marketprice (EUR/MWh), unit }
  // Convert EUR/MWh → EUR/kWh (÷1000), expand each hour into 4×15-min slots
  const prices = [];
  for (const entry of data) {
    const pricePerKwh = entry.marketprice / 1000;
    const startDate = new Date(entry.start_timestamp);

    for (let q = 0; q < 4; q++) {
      const slotDate = new Date(startDate.getTime() + q * 15 * 60 * 1000);
      const slotParts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: config.location.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(slotDate);
      const sp = Object.fromEntries(slotParts.map(({ type, value }) => [type, value]));
      const slotTs = `${sp.year}-${sp.month}-${sp.day}T${sp.hour}:${sp.minute}`;

      prices.push({
        slot_ts: slotTs,
        spot_price: Math.round(pricePerKwh * 100000) / 100000, // 5 decimal places
        region,
      });
    }
  }

    return { prices, raw: data };
  }, { attempts: 3, delayMs: 5000 });
}
