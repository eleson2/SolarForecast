import { fetchWeather } from './src/fetcher.js';
import { parseWeatherData } from './src/parser.js';
import { runModel } from './src/model.js';
import { getReadingsForForecast } from './src/db.js';
import config from './config.js';
import fs from 'fs';

function localTs(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

async function main() {
  console.log('Fetching weather data...');
  const data = await fetchWeather();

  console.log('Parsing...');
  parseWeatherData(data);

  console.log('Running model...');
  runModel();

  // Build forecast JSON (same logic as api.js)
  const now = new Date();
  const fromHour = new Date(now.getTime() + 60 * 60 * 1000);
  fromHour.setMinutes(0, 0, 0);
  const toHour = new Date(fromHour.getTime() + config.forecast.horizon_hours * 60 * 60 * 1000);
  const fromTs = localTs(fromHour);
  const toTs = localTs(toHour);

  const rows = getReadingsForForecast(fromTs, toTs);
  const forecast = {
    generated_at: now.toISOString(),
    timezone: config.location.timezone,
    horizon_hours: config.forecast.horizon_hours,
    forecast: rows.map(r => ({
      hour: r.hour_ts,
      avg_watts: r.prod_forecast != null ? Math.round(r.prod_forecast * 1000) : null,
      irr_wm2: r.irr_forecast != null ? Math.round(r.irr_forecast) : null,
      confidence: r.confidence != null ? Math.round(r.confidence * 100) / 100 : null,
    })),
  };

  fs.writeFileSync('data/forecast.json', JSON.stringify(forecast, null, 2));
  console.log(`Forecast written to data/forecast.json (${forecast.forecast.length} hours)`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
