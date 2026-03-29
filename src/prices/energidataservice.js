import config from '../../config.js';
import log from '../logger.js';
import { withRetry } from '../fetcher.js';

// Fallback EUR/SEK rate used if the exchange rate API is unreachable.
const EUR_SEK_FALLBACK = 11.5;

/**
 * Fetch the current EUR/SEK exchange rate from open.er-api.com.
 * Returns a fallback rate on failure so price fetching can still proceed.
 */
async function fetchEurSekRate() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/EUR');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const rate = body.rates?.SEK;
    if (typeof rate !== 'number' || rate <= 0) throw new Error('SEK rate missing from response');
    return rate;
  } catch (err) {
    log.warn('price', `EUR/SEK rate fetch failed (${err.message}) — using fallback ${EUR_SEK_FALLBACK}`);
    return EUR_SEK_FALLBACK;
  }
}

/**
 * Fetch prices for a single date from Energi Data Service (Danish TSO — Energinet).
 * Returns SpotPriceEUR (EUR/MWh) converted to SEK/kWh, expanded to 4×15-min slots.
 * Returns { prices, raw } or null if not available.
 *
 * Note: SE3 is covered by this service. Prices are always converted from EUR regardless
 * of config.price.currency — use only for SEK-currency installations.
 */
export async function fetchPricesForDate(dateStr, region) {
  // Build a UTC window that covers the full local day for UTC+1 (CET) and UTC+2 (CEST).
  // Local midnight = UTC 22:00–23:00 of the previous day; local 23:00 = UTC 21:00–22:00.
  const dateParts = dateStr.split('-');
  const targetUtc = Date.UTC(+dateParts[0], +dateParts[1] - 1, +dateParts[2]);
  const prevDayStr = new Date(targetUtc - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const startUtc = `${prevDayStr}T22:00`;
  const endUtc = `${dateStr}T23:00`;

  const params = new URLSearchParams({
    filter: JSON.stringify({ PriceArea: region }),
    start: startUtc,
    end: endUtc,
    sort: 'HourUTC ASC',
    timezone: 'utc',
  });
  const url = `https://api.energidataservice.dk/dataset/Elspotprices?${params}`;

  return withRetry(async () => {
    log.info('price', `GET ${url}`);
    const t0 = Date.now();
    const res = await fetch(url);
    log.info('price', `${res.status} in ${Date.now() - t0}ms`);

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Energi Data Service API request failed: ${res.status} ${res.statusText}`);

    const body = await res.json();
    const records = body.records;
    if (!records || records.length === 0) return null;

    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: config.location.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });

    // Keep only records whose UTC hour falls within the target local date.
    const inTargetDate = records.filter(r => {
      const utcDate = new Date(r.HourUTC + 'Z');
      const parts = fmt.formatToParts(utcDate);
      const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      return `${p.year}-${p.month}-${p.day}` === dateStr;
    });

    if (inTargetDate.length === 0) return null;

    const eurSek = await fetchEurSekRate();

    const prices = [];
    for (const record of inTargetDate) {
      const eurPerMwh = record.SpotPriceEUR;
      if (eurPerMwh == null) continue;

      const pricePerKwh = (eurPerMwh * eurSek) / 1000; // EUR/MWh × rate → SEK/kWh
      const startDate = new Date(record.HourUTC + 'Z');

      for (let q = 0; q < 4; q++) {
        const slotDate = new Date(startDate.getTime() + q * 15 * 60 * 1000);
        const slotParts = fmt.formatToParts(slotDate);
        const sp = Object.fromEntries(slotParts.map(({ type, value }) => [type, value]));
        const slotTs = `${sp.year}-${sp.month}-${sp.day}T${sp.hour}:${sp.minute}`;

        prices.push({
          slot_ts: slotTs,
          spot_price: Math.round(pricePerKwh * 100000) / 100000,
          region,
        });
      }
    }

    if (prices.length === 0) return null;
    return { prices, raw: records };
  }, { attempts: 3, delayMs: 5000 });
}
