import { Router } from 'express';
import config from '../config.js';
import { getScheduleForRange, getSnapshotsForRange } from './db.js';
import { getDriver, getDriverConfig } from './inverter-dispatcher.js';
import { setOverride, clearOverride, getOverride } from './override.js';

const router = Router();

// In-memory LP shadow result — updated by scheduler after each battery pipeline run.
let lpShadow = null; // { summary, schedule, computed_at }

/** Called by scheduler.js after each LP dry-run. */
export function setLpShadow(summary, schedule) {
  lpShadow = { summary, schedule, computed_at: new Date().toISOString() };
}

/**
 * Format a Date as "YYYY-MM-DDTHH:MM" in configured timezone.
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

router.get('/schedule', (req, res) => {
  const now = new Date();
  const currentSlot = new Date(now);
  currentSlot.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
  const endSlot = new Date(currentSlot.getTime() + 24 * 60 * 60 * 1000);

  const fromTs = localTs(currentSlot);
  const toTs = localTs(endSlot);

  const rows = getScheduleForRange(fromTs, toTs);

  // Compute savings summary from the rows
  let costWithout = 0;
  let costWith = 0;
  const slotHours = 0.25;
  const importFee = config.grid.transfer_import_kwh + config.grid.energy_tax_kwh;
  const exportFee = config.grid.transfer_export_kwh;

  for (const row of rows) {
    const buyPrice = row.price_kwh + importFee;
    const consumptionKwh = row.consumption_watts * slotHours / 1000;
    const solarKwh = Math.min(row.solar_watts, row.consumption_watts) * slotHours / 1000;
    const gridNeededKwh = Math.max(0, consumptionKwh - solarKwh);

    costWithout += gridNeededKwh * buyPrice;

    switch (row.action) {
      case 'charge_grid':
        costWith += gridNeededKwh * buyPrice;
        costWith += (row.watts * slotHours / 1000) * buyPrice;
        break;
      case 'discharge': {
        const dischargeKwh = row.watts * slotHours / 1000;
        costWith += Math.max(0, gridNeededKwh - dischargeKwh) * buyPrice;
        break;
      }
      case 'sell':
        costWith += gridNeededKwh * buyPrice;
        costWith -= (row.watts * slotHours / 1000) * (row.price_kwh * config.grid.sell_price_factor - exportFee);
        break;
      default:
        costWith += gridNeededKwh * buyPrice;
    }
  }

  res.json({
    generated_at: now.toISOString(),
    timezone: config.location.timezone,
    inverter_config: {
      discharge_soc: config.inverter?.discharge_soc ?? 20,
      charge_soc:    config.inverter?.charge_soc    ?? 90,
      peak_shaving: {
        enabled:    config.peak_shaving?.enabled    ?? false,
        default_kw: config.peak_shaving?.default_kw ?? 4.5,
        schedule:   config.peak_shaving?.schedule   ?? [],
      },
    },
    schedule: rows.map(r => ({
      slot: r.slot_ts,
      action: r.action,
      watts: r.watts,
      price_kwh: r.price_kwh,
      solar_watts: r.solar_watts,
      consumption_watts: r.consumption_watts,
      soc_start: r.soc_start,
      soc_end: r.soc_end,
    })),
    summary: {
      estimated_cost_without_battery: Math.round(costWithout * 100) / 100,
      estimated_cost_with_battery: Math.round(costWith * 100) / 100,
      estimated_savings: Math.round((costWithout - costWith) * 100) / 100,
    },
    lp_shadow: lpShadow ? {
      computed_at: lpShadow.computed_at,
      summary:     lpShadow.summary,
      soc:         lpShadow.schedule.map(r => ({ slot: r.slot_ts, soc_start: r.soc_start, action: r.action })),
    } : null,
  });
});

// Last 24h: planned schedule + actual energy snapshots for comparison
router.get('/history', (req, res) => {
  const now = new Date();
  const fromSlot = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  fromSlot.setSeconds(0, 0);

  const fromTs = localTs(fromSlot);
  const toTs   = localTs(now);

  const schedule  = getScheduleForRange(fromTs, toTs);
  const snapshots = getSnapshotsForRange(fromTs, toTs);

  res.json({
    generated_at: now.toISOString(),
    timezone: config.location.timezone,
    inverter_config: {
      discharge_soc: config.inverter?.discharge_soc ?? 20,
      charge_soc:    config.inverter?.charge_soc    ?? 90,
      peak_shaving: {
        enabled:    config.peak_shaving?.enabled    ?? false,
        default_kw: config.peak_shaving?.default_kw ?? 4.5,
        schedule:   config.peak_shaving?.schedule   ?? [],
      },
    },
    schedule: schedule.map(r => ({
      slot:               r.slot_ts,
      action:             r.action,
      watts:              r.watts,
      price_kwh:          r.price_kwh,
      solar_watts:        r.solar_watts,
      consumption_watts:  r.consumption_watts,
      soc_start:          r.soc_start,
      soc_end:            r.soc_end,
    })),
    snapshots: snapshots.map(s => ({
      ts:                      s.snapshot_ts,
      pv_today_kwh:            s.pv_today_kwh,
      load_today_kwh:          s.load_today_kwh,
      grid_import_today_kwh:   s.grid_import_today_kwh,
      grid_export_today_kwh:   s.grid_export_today_kwh,
    })),
  });
});

// --- Manual override ---
// A persistent override keeps the inverter in a fixed mode (charge/discharge/idle)
// for a requested duration, surviving scheduled execute cycles.
// executePipeline in scheduler.js checks getOverride() on every run.

const VALID_OVERRIDE_ACTIONS = ['charge', 'discharge', 'idle'];

router.get('/override', (req, res) => {
  const active = getOverride();
  res.json(active ? { active: true, ...active } : { active: false });
});

router.post('/override', async (req, res) => {
  const { action, duration_minutes } = req.body ?? {};
  if (!VALID_OVERRIDE_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${VALID_OVERRIDE_ACTIONS.join(', ')}` });
  }
  const duration = Number(duration_minutes);
  if (!Number.isFinite(duration) || duration < 1 || duration > 1440) {
    return res.status(400).json({ error: 'duration_minutes must be between 1 and 1440' });
  }

  const driver = getDriver();
  if (!driver) return res.status(503).json({ error: 'No inverter configured' });
  if (typeof driver[action] !== 'function') {
    return res.status(501).json({ error: `Driver does not support '${action}'` });
  }

  const cfg = getDriverConfig();
  try {
    const result = await driver[action](cfg);
    setOverride(action, duration);
    const state = getOverride();
    res.json({
      active: true,
      action,
      duration_minutes: duration,
      expires_at: state.expires_at,
      soc: result.soc,
      target_soc: result.target,
      dry_run: cfg.dry_run ?? false,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.delete('/override', (req, res) => {
  const was = getOverride();
  clearOverride();
  res.json({ cancelled: was !== null, previous_action: was?.action ?? null });
});

// --- Inverter manual control ---
// One-shot commands: apply immediately, last only until the next execute cycle.
// For persistent control use /override above.
//
// All commands respect dry_run from config. data_collection_only does NOT apply
// here — manual commands are always attempted so the user can test independently
// of the automated schedule.

router.get('/control/status', async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(503).json({ error: 'No inverter configured' });
  try {
    const state = await driver.getState(getDriverConfig());
    res.json({ soc: state.soc, power_w: state.power_w, mode: state.mode });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

async function runControl(res, action) {
  const driver = getDriver();
  if (!driver) return res.status(503).json({ error: 'No inverter configured' });
  if (typeof driver[action] !== 'function') {
    return res.status(501).json({ error: `Driver does not support '${action}'` });
  }
  const cfg = getDriverConfig();
  try {
    const result = await driver[action](cfg);
    res.json({
      action,
      soc: result.soc,
      target_soc: result.target,
      dry_run: cfg.dry_run ?? false,
      note: 'Override active until next scheduled execute cycle (~15 min)',
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

router.post('/control/charge',    (req, res) => runControl(res, 'charge'));
router.post('/control/discharge', (req, res) => runControl(res, 'discharge'));
router.post('/control/idle',      (req, res) => runControl(res, 'idle'));

router.post('/control/peak-shaving', async (req, res) => {
  const driver = getDriver();
  if (!driver) return res.status(503).json({ error: 'No inverter configured' });
  if (typeof driver.setPeakShavingTarget !== 'function') {
    return res.status(501).json({ error: "Driver does not support 'setPeakShavingTarget'" });
  }
  const limit_kw = Number(req.body?.limit_kw);
  if (!isFinite(limit_kw) || limit_kw <= 0) {
    return res.status(400).json({ error: 'limit_kw must be a positive number' });
  }
  const cfg = getDriverConfig();
  try {
    const result = await driver.setPeakShavingTarget(limit_kw, cfg);
    res.json({
      action: 'peak-shaving',
      target_kw: result.target_kw,
      reg_value: result.reg_value,
      dry_run: cfg.dry_run ?? false,
      note: 'Override active until next scheduled execute cycle (~15 min)',
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
