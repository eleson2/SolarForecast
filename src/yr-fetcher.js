import config from '../config.js';
import { withRetry, saveRaw } from './fetcher.js';
import log from './logger.js';

export async function fetchYr() {
  const { lat, lon } = config.location;
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;

  return withRetry(async () => {
    log.info('yr-fetch', `GET ${url}`);
    const t0 = Date.now();
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'SolarForecast/1.0 erland.lestander@gmail.com',
      },
    });
    log.info('yr-fetch', `${res.status} in ${Date.now() - t0}ms`);
    if (!res.ok) throw new Error(`YR request failed: ${res.status} ${res.statusText}`);

    const data = await res.json();
    const filename = saveRaw('yr', data);
    log.info('yr-fetch', `Saved raw YR data to ${filename}`);
    return data;
  });
}
