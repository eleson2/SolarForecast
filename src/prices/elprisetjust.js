import config from '../../config.js';
import log from '../logger.js';
import { withRetry } from '../fetcher.js';

/**
 * Fetch prices for a single date from elprisetjustnu.se.
 * The API returns native 15-min data (96 entries per day).
 * Returns array of { slot_ts, spot_price, region } or null if not available.
 */
export async function fetchPricesForDate(dateStr, region) {
  const [yyyy, mm, dd] = dateStr.split('-');
  const url = `https://www.elprisetjustnu.se/api/v1/prices/${yyyy}/${mm}-${dd}_${region}.json`;

  return withRetry(async () => {
    log.info('price', `GET ${url}`);
    const t0 = Date.now();
    const res = await fetch(url);
    log.info('price', `${res.status} in ${Date.now() - t0}ms`);

    if (res.status === 404) {
      return null; // prices not yet available (e.g. tomorrow before ~13:00)
    }
    if (!res.ok) {
      throw new Error(`elprisetjust API request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    // 1:1 mapping — API already returns 15-min slots with SEK_per_kWh
    const prices = data.map(entry => {
      const startDate = new Date(entry.time_start);
      const slotParts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: config.location.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(startDate);
      const sp = Object.fromEntries(slotParts.map(({ type, value }) => [type, value]));
      const slotTs = `${sp.year}-${sp.month}-${sp.day}T${sp.hour}:${sp.minute}`;

      return {
        slot_ts: slotTs,
        spot_price: entry.SEK_per_kWh,
        region,
      };
    });

    return { prices, raw: data };
  }, { attempts: 3, delayMs: 5000 });
}
