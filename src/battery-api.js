import { Router } from 'express';
import config from '../config.js';
import { getScheduleForRange } from './db.js';

const router = Router();

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
  });
});

export default router;
