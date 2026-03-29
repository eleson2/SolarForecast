import config from '../../config.js';
import log from '../logger.js';
import { withRetry } from '../fetcher.js';

/**
 * Fetch prices for a single date from the Nord Pool dataportal (unofficial endpoint).
 * Returns native 15-min data (96 entries/day) in configured currency/MWh — converted to currency/kWh.
 * Returns { prices, raw } or null if not available.
 *
 * Note: this endpoint is not officially supported for unauthenticated use; Nord Pool can
 * revoke access at any time. Use as a fallback, not a primary source.
 */
export async function fetchPricesForDate(dateStr, region) {
  const currency = config.price.currency;
  const url = `https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices` +
    `?market=DayAhead&deliveryArea=${region}&currency=${currency}&date=${dateStr}`;

  return withRetry(async () => {
    log.info('price', `GET ${url}`);
    const t0 = Date.now();
    const res = await fetch(url);
    log.info('price', `${res.status} in ${Date.now() - t0}ms`);

    if (res.status === 404 || res.status === 204) return null; // 204 = prices not yet published
    if (!res.ok) throw new Error(`Nord Pool API request failed: ${res.status} ${res.statusText}`);

    const body = await res.json();
    const entries = body.multiAreaEntries;
    if (!entries || entries.length === 0) return null;

    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: config.location.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });

    // API already returns 96 native 15-min slots — map each directly to slot_ts.
    const prices = [];
    for (const entry of entries) {
      const rawPrice = entry.entryPerArea?.[region];
      if (rawPrice == null || rawPrice < 0) continue; // skip missing/unavailable areas

      const pricePerKwh = rawPrice / 1000; // currency/MWh → currency/kWh
      const slotDate = new Date(entry.deliveryStart);
      const slotParts = fmt.formatToParts(slotDate);
      const sp = Object.fromEntries(slotParts.map(({ type, value }) => [type, value]));
      const slotTs = `${sp.year}-${sp.month}-${sp.day}T${sp.hour}:${sp.minute}`;

      prices.push({
        slot_ts: slotTs,
        spot_price: Math.round(pricePerKwh * 100000) / 100000,
        region,
      });
    }

    if (prices.length === 0) return null;
    return { prices, raw: body };
  }, { attempts: 3, delayMs: 5000 });
}
