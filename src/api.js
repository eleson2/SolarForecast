import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { getReadingsForForecast, getSolarReadingsForRange, getPricesForRange } from './db.js';
import batteryRouter from './battery-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// --- Electricity prices: next 48 hours ---
app.get('/api/prices', (req, res) => {
  const now = new Date();
  const from = new Date(now);
  from.setMinutes(0, 0, 0);
  const to = new Date(from.getTime() + 48 * 60 * 60 * 1000);
  const rows = getPricesForRange(localTs(from), localTs(to));
  res.json({ timezone: config.location.timezone, prices: rows });
});

// --- Solar readings: history + forecast in one range ---
app.get('/api/solar', (req, res) => {
  const now = new Date();
  // last 7 days → next 2 days
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  from.setMinutes(0, 0, 0);
  const to = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const rows = getSolarReadingsForRange(localTs(from), localTs(to));
  res.json({
    timezone: config.location.timezone,
    readings: rows.map(r => ({
      hour: r.hour_ts,
      irr_wm2: r.irr_forecast,
      prod_forecast_w: r.prod_forecast != null ? Math.round(r.prod_forecast * 1000) : null,
      prod_actual_w:   r.prod_actual   != null ? Math.round(r.prod_actual   * 1000) : null,
    })),
  });
});

app.use('/battery', batteryRouter);

// Serve dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

export default app;
