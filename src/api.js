import express from 'express';
import config from '../config.js';
import { getReadingsForForecast } from './db.js';
import batteryRouter from './battery-api.js';

const app = express();

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" in the configured timezone.
 */
function localTs(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

app.get('/forecast', (req, res) => {
  const now = new Date();
  const fromHour = new Date(now.getTime() + 60 * 60 * 1000); // next full hour (approx)
  fromHour.setMinutes(0, 0, 0);
  const toHour = new Date(fromHour.getTime() + config.forecast.horizon_hours * 60 * 60 * 1000);

  const fromTs = localTs(fromHour);
  const toTs = localTs(toHour);

  const rows = getReadingsForForecast(fromTs, toTs);

  const forecast = rows.map(r => ({
    hour: r.hour_ts,
    avg_watts: r.prod_forecast != null ? Math.round(r.prod_forecast * 1000) : null,
    irr_wm2: r.irr_forecast != null ? Math.round(r.irr_forecast) : null,
    confidence: r.confidence != null ? Math.round(r.confidence * 100) / 100 : null,
  }));

  res.json({
    generated_at: now.toISOString(),
    timezone: config.location.timezone,
    horizon_hours: config.forecast.horizon_hours,
    forecast,
  });
});

app.use('/battery', batteryRouter);

export default app;
