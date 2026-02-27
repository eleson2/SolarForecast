import express from 'express';
import basicAuth from 'express-basic-auth';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { getReadingsForForecast, getSolarReadingsForRange, getPricesForRange, getAllPipelineRuns, getSolarMAE, getAllConsumptionModels } from './db.js';
import batteryRouter from './battery-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

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

// Expected maximum interval (minutes) between successful runs per pipeline
const PIPELINE_INTERVALS = {
  fetch:       6 * 60,
  learn:       60,
  smooth:      24 * 60,
  battery:     60,
  consumption: 60,
  snapshot:    15,
  execute:     15,
};

app.get('/health', (req, res) => {
  const runs = getAllPipelineRuns();
  const now = Date.now();
  const pipelines = {};
  let allOk = true;

  for (const [name, maxMinutes] of Object.entries(PIPELINE_INTERVALS)) {
    const row = runs.find(r => r.pipeline === name);
    if (!row) {
      pipelines[name] = { status: 'never_run', overdue: true };
      allOk = false;
      continue;
    }
    const ageMs = now - new Date(row.last_run_ts + 'Z').getTime();
    const ageMin = Math.round(ageMs / 60000);
    const overdue = ageMin > maxMinutes * 1.5; // 50% grace period
    const ok = row.last_status === 'ok' && !overdue;
    if (!ok) allOk = false;
    pipelines[name] = { last_run: row.last_run_ts, status: row.last_status, age_min: ageMin, overdue };
  }

  res.status(allOk ? 200 : 503).json({ ok: allOk, pipelines });
});

// Forecast accuracy metrics
app.get('/api/metrics', (req, res) => {
  const now = new Date();
  const days7  = new Date(now - 7  * 86400000).toISOString().slice(0, 16);
  const days30 = new Date(now - 30 * 86400000).toISOString().slice(0, 16);

  const mae7  = getSolarMAE(days7);
  const mae30 = getSolarMAE(days30);

  res.json({
    solar_mae_kwh: {
      last_7_days:  mae7.n  > 0 ? Math.round(mae7.mae  * 1000) / 1000 : null,
      last_30_days: mae30.n > 0 ? Math.round(mae30.mae * 1000) / 1000 : null,
      note: 'Mean absolute error between prod_forecast and prod_actual (kWh), irr > 50 W/m² only',
    },
    sample_counts: { last_7_days: mae7.n, last_30_days: mae30.n },
  });
});

// Consumption temperature model — per-hour OLS regression coefficients
app.get('/api/consumption-model', (req, res) => {
  const rows = getAllConsumptionModels();
  res.json({
    note: 'Linear model: consumption_w = slope * outdoor_temp + intercept. Daytime hours (08–18) typically show strongest correlation.',
    hours: rows.map(r => ({
      hour: r.hour_of_day,
      slope_w_per_c:  r.slope    != null ? Math.round(r.slope)    : null,
      intercept_w:    r.intercept != null ? Math.round(r.intercept) : null,
      r_squared:      r.r_squared != null ? Math.round(r.r_squared * 100) / 100 : null,
      sample_count:   r.sample_count,
      last_updated:   r.last_updated,
    })),
  });
});

app.use('/battery', batteryRouter);

// Serve dashboard (with optional basic auth)
if (config.dashboard?.auth_pass) {
  app.use(basicAuth({
    users: { [config.dashboard.auth_user || 'admin']: config.dashboard.auth_pass },
    challenge: true,
    realm: 'SolarForecast',
  }));
}
app.use(express.static(path.join(__dirname, '..', 'public')));

export default app;
