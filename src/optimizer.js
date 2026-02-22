import config from '../config.js';
import { getPricesForRange, getReadingsForForecast, upsertScheduleBatch, deleteScheduleForRange } from './db.js';

const currency = config.price.currency;

/**
 * Interpolate hourly values to 15-min slots.
 * Input: array of { hour_ts: "YYYY-MM-DDTHH:00", value }
 * Output: array of { slot_ts: "YYYY-MM-DDTHH:MM", value } (4× length)
 */
function interpolateTo15Min(hourlyData) {
  const slots = [];
  for (const entry of hourlyData) {
    const base = entry.hour_ts; // "YYYY-MM-DDTHH:00"
    const prefix = base.slice(0, 11); // "YYYY-MM-DDT"
    const hour = base.slice(11, 13);
    for (const min of ['00', '15', '30', '45']) {
      slots.push({
        slot_ts: `${prefix}${hour}:${min}`,
        value: entry.value,
      });
    }
  }
  return slots;
}

/**
 * Run the greedy v1 optimizer.
 * Inputs: solar forecast (from DB), prices (from DB), consumption estimates.
 * Writes schedule to battery_schedule table.
 *
 * @param {string} fromTs - Start of schedule window "YYYY-MM-DDTHH:MM"
 * @param {string} toTs   - End of schedule window "YYYY-MM-DDTHH:MM"
 * @param {Array}  consumptionEstimates - Array of { hour_ts, consumption_w }
 * @param {Object} [options={}] - Optional settings
 * @param {number} [options.startSoc] - Live battery SOC % from inverter (0–100)
 * @returns {{ schedule: Array, summary: Object }}
 */
export function runOptimizer(fromTs, toTs, consumptionEstimates, options = {}) {
  const bat = config.battery;
  const grid = config.grid;

  // 1. Gather inputs
  const prices = getPricesForRange(fromTs, toTs);
  if (prices.length === 0) {
    console.log('[optimizer] No price data available for range');
    return { schedule: [], summary: null };
  }

  // Solar forecast (hourly) → interpolate to 15-min
  const solarRows = getReadingsForForecast(fromTs, toTs);
  const solarHourly = solarRows.map(r => ({
    hour_ts: r.hour_ts,
    value: r.prod_forecast != null ? r.prod_forecast * 1000 : 0, // kW → W
  }));
  const solar15min = interpolateTo15Min(solarHourly);
  const solarMap = new Map(solar15min.map(s => [s.slot_ts, s.value]));

  // Consumption (hourly) → interpolate to 15-min
  const consumption15min = interpolateTo15Min(
    consumptionEstimates.map(c => ({ hour_ts: c.hour_ts, value: c.consumption_w }))
  );
  const consumptionMap = new Map(consumption15min.map(c => [c.slot_ts, c.value]));

  // 2. Build slot objects
  const slots = prices.map(p => {
    const solar = solarMap.get(p.slot_ts) ?? 0;
    const consumption = consumptionMap.get(p.slot_ts) ?? config.consumption.flat_watts;
    const netProduction = solar - consumption;
    const buyPrice = p.spot_price + grid.transfer_import_kwh + grid.energy_tax_kwh;
    const sellPrice = grid.sell_enabled
      ? p.spot_price * grid.sell_price_factor - grid.transfer_export_kwh
      : 0;

    return {
      slot_ts: p.slot_ts,
      spot_price: p.spot_price,
      buy_price: buyPrice,
      sell_price: sellPrice,
      solar_watts: solar,
      consumption_watts: consumption,
      net_production: netProduction,
      action: 'idle',
      watts: 0,
      soc_start: 0,
      soc_end: 0,
    };
  });

  // 3. Greedy scheduling
  const capacityWh = bat.capacity_kwh * 1000;
  const minSocWh = (bat.min_soc / 100) * capacityWh;
  const maxSocWh = (bat.max_soc / 100) * capacityWh;
  const slotHours = 0.25; // 15 min = 0.25 hours
  const maxChargeWh = bat.max_charge_w * slotHours;
  const maxDischargeWh = bat.max_discharge_w * slotHours;

  // Min price spread to justify a charge/discharge cycle
  const avgBuyPrice = slots.reduce((s, sl) => s + sl.buy_price, 0) / slots.length;
  const minSpread = avgBuyPrice * (1 / bat.efficiency - 1);

  // Compute avoidable Wh per slot: how much grid energy discharge could displace.
  // Slots where solar covers consumption have zero avoidable — no point discharging there.
  for (const slot of slots) {
    const gridDeficitW = Math.max(0, -slot.net_production); // watts the grid must supply
    slot.avoidable_wh = Math.min(gridDeficitW, bat.max_discharge_w) * slotHours;
  }

  // Discharge candidates: only slots with actual grid deficit, sorted most expensive first
  const dischargeOrder = slots
    .map((_, i) => i)
    .filter(i => slots[i].avoidable_wh > 0)
    .sort((a, b) => slots[b].buy_price - slots[a].buy_price);

  // Charge candidates: only slots without solar surplus (don't buy grid power during sunshine),
  // sorted cheapest first
  const chargeOrder = slots
    .map((_, i) => i)
    .filter(i => slots[i].net_production <= 0)
    .sort((a, b) => slots[a].buy_price - slots[b].buy_price);

  // Paired approach: only charge as much as we plan to discharge profitably
  let chargeSlots = [];
  let dischargeSlots = [];

  let ci = 0;
  let di = 0;
  let remainingCapacityWh = maxSocWh - minSocWh;
  let chargedWh = 0;

  // Pair cheapest charge with most expensive discharge while spread is profitable.
  // Discharge amount is capped to avoidable_wh — no more than the slot's grid deficit.
  while (ci < chargeOrder.length && di < dischargeOrder.length && chargedWh < remainingCapacityWh) {
    const cIdx = chargeOrder[ci];
    const dIdx = dischargeOrder[di];

    // Skip if same slot
    if (cIdx === dIdx) { ci++; continue; }

    const spread = slots[dIdx].buy_price - slots[cIdx].buy_price;
    if (spread <= minSpread) break; // No more profitable pairs

    // Cap to what the discharge slot actually needs and what fits in the battery
    const dischargeWh = Math.min(slots[dIdx].avoidable_wh, maxDischargeWh, remainingCapacityWh - chargedWh);
    // Charge must account for round-trip efficiency loss
    const chargeWh = Math.min(dischargeWh / bat.efficiency, maxChargeWh);

    if (chargeWh <= 0) { di++; continue; }

    chargeSlots.push({ idx: cIdx, wh: chargeWh });
    dischargeSlots.push({ idx: dIdx, wh: dischargeWh });
    chargedWh += chargeWh;

    ci++;
    di++;
  }

  // Apply charge_grid actions
  for (const cs of chargeSlots) {
    slots[cs.idx].action = 'charge_grid';
    slots[cs.idx].watts = Math.round(cs.wh / slotHours);
  }

  // Apply discharge actions
  for (const ds of dischargeSlots) {
    slots[ds.idx].action = 'discharge';
    slots[ds.idx].watts = Math.round(ds.wh / slotHours);
  }

  // Handle solar surplus: charge battery or sell
  for (const slot of slots) {
    if (slot.action !== 'idle') continue;
    if (slot.net_production > 0) {
      // Solar surplus — charge battery with it
      slot.action = 'charge_solar';
      slot.watts = Math.min(slot.net_production, bat.max_charge_w);
    }
  }

  // 4. Forward pass: track SOC through the schedule
  let currentSocWh;
  if (options.startSoc != null) {
    currentSocWh = Math.max(minSocWh, Math.min(maxSocWh, (options.startSoc / 100) * capacityWh));
    console.log(`[optimizer] Starting SOC: ${options.startSoc}% (${Math.round(currentSocWh)}Wh from inverter)`);
  } else {
    currentSocWh = minSocWh;
    console.log(`[optimizer] Starting SOC: ${bat.min_soc}% (conservative default)`);
  }

  for (const slot of slots) {
    slot.soc_start = Math.round((currentSocWh / capacityWh) * 100 * 10) / 10;
    const slotWh = slot.watts * slotHours;

    switch (slot.action) {
      case 'charge_grid': {
        const chargeWh = Math.min(slotWh * bat.efficiency, maxSocWh - currentSocWh);
        if (chargeWh <= 0) { slot.action = 'idle'; slot.watts = 0; }
        else { currentSocWh += chargeWh; slot.watts = Math.round(chargeWh / slotHours / bat.efficiency); }
        break;
      }
      case 'charge_solar': {
        const chargeWh = Math.min(slotWh, maxSocWh - currentSocWh);
        if (chargeWh <= 0) {
          // Battery full — sell if enabled
          if (grid.sell_enabled && slot.sell_price > 0) {
            slot.action = 'sell';
            slot.watts = Math.min(slot.net_production, bat.max_discharge_w);
          } else {
            slot.action = 'idle';
            slot.watts = 0;
          }
        } else {
          currentSocWh += chargeWh;
          slot.watts = Math.round(chargeWh / slotHours);
        }
        break;
      }
      case 'discharge': {
        const dischargeWh = Math.min(slotWh, currentSocWh - minSocWh);
        if (dischargeWh <= 0) { slot.action = 'idle'; slot.watts = 0; }
        else { currentSocWh -= dischargeWh; slot.watts = Math.round(dischargeWh / slotHours); }
        break;
      }
      case 'sell': {
        const sellWh = Math.min(slotWh, currentSocWh - minSocWh);
        if (sellWh <= 0) { slot.action = 'idle'; slot.watts = 0; }
        else { currentSocWh -= sellWh; slot.watts = Math.round(sellWh / slotHours); }
        break;
      }
      // idle: no SOC change
    }

    slot.soc_end = Math.round((currentSocWh / capacityWh) * 100 * 10) / 10;
    slot.price_kwh = slot.spot_price;
  }

  // 5. Compute savings summary
  let costWithout = 0;
  let costWith = 0;
  for (const slot of slots) {
    const consumptionKwh = slot.consumption_watts * slotHours / 1000;
    const solarKwh = Math.min(slot.solar_watts, slot.consumption_watts) * slotHours / 1000;
    const gridNeededKwh = consumptionKwh - solarKwh;

    // Without battery: buy all grid-needed at buy_price
    costWithout += Math.max(0, gridNeededKwh) * slot.buy_price;

    // With battery
    switch (slot.action) {
      case 'charge_grid':
        costWith += Math.max(0, gridNeededKwh) * slot.buy_price;
        costWith += (slot.watts * slotHours / 1000) * slot.buy_price;
        break;
      case 'discharge':
        // Battery covers some/all consumption — reduce grid buy
        const dischargeKwh = slot.watts * slotHours / 1000;
        const remainingKwh = Math.max(0, gridNeededKwh - dischargeKwh);
        costWith += remainingKwh * slot.buy_price;
        break;
      case 'sell':
        costWith += Math.max(0, gridNeededKwh) * slot.buy_price;
        costWith -= (slot.watts * slotHours / 1000) * slot.sell_price;
        break;
      default:
        costWith += Math.max(0, gridNeededKwh) * slot.buy_price;
    }
  }

  const summary = {
    estimated_cost_without_battery: Math.round(costWithout * 100) / 100,
    estimated_cost_with_battery: Math.round(costWith * 100) / 100,
    estimated_savings: Math.round((costWithout - costWith) * 100) / 100,
  };

  // 6. Write to DB
  const dbRows = slots.map(s => ({
    slot_ts: s.slot_ts,
    action: s.action,
    watts: s.watts,
    soc_start: s.soc_start,
    soc_end: s.soc_end,
    price_kwh: s.price_kwh,
    solar_watts: s.solar_watts,
    consumption_watts: s.consumption_watts,
  }));

  deleteScheduleForRange(fromTs, toTs);
  upsertScheduleBatch(dbRows);

  const actionCounts = {};
  for (const s of slots) {
    actionCounts[s.action] = (actionCounts[s.action] || 0) + 1;
  }
  console.log(`[optimizer] Schedule: ${slots.length} slots — ${JSON.stringify(actionCounts)}`);
  console.log(`[optimizer] Savings: ${summary.estimated_savings} ${currency} (${summary.estimated_cost_without_battery} → ${summary.estimated_cost_with_battery})`);

  return { schedule: dbRows, summary };
}
