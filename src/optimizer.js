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
 * Group an array of slots (already sorted by slot_ts) into contiguous windows
 * and log each window with its time range, kWh, and average price.
 */
function logWindows(label, actionSlots, priceFn, currency) {
  if (actionSlots.length === 0) return;
  // Group consecutive 15-min slots into windows
  const windows = [];
  let winStart = actionSlots[0];
  let winSlots = [actionSlots[0]];
  for (let i = 1; i < actionSlots.length; i++) {
    const prev = actionSlots[i - 1].slot_ts;
    const cur  = actionSlots[i].slot_ts;
    // Two slots are consecutive if their timestamps are exactly 15 min apart.
    // Compare as strings after normalising: increment last two digits by 15.
    const [ph, pm] = prev.slice(11, 16).split(':').map(Number);
    const [ch, cm] = cur.slice(11, 16).split(':').map(Number);
    const prevMins = ph * 60 + pm;
    const curMins  = ch * 60 + cm;
    // Handle day-boundary wrap (e.g. 23:45 → 00:00 next day)
    const gap = ((curMins - prevMins) + 1440) % 1440;
    if (gap === 15) {
      winSlots.push(actionSlots[i]);
    } else {
      windows.push({ start: winStart, slots: winSlots });
      winStart = actionSlots[i];
      winSlots = [actionSlots[i]];
    }
  }
  windows.push({ start: winStart, slots: winSlots });

  for (const w of windows) {
    const kWh     = w.slots.reduce((s, sl) => s + sl.watts * 0.25 / 1000, 0);
    const avgPrice = w.slots.reduce((s, sl) => s + priceFn(sl), 0) / w.slots.length;
    const fromStr  = w.slots[0].slot_ts.slice(11, 16);
    const lastSlot = w.slots[w.slots.length - 1];
    // End label = start of the slot after the last one (human-readable window end)
    const [lh, lm] = lastSlot.slot_ts.slice(11, 16).split(':').map(Number);
    const endMins  = lh * 60 + lm + 15;
    const endStr   = `${String(Math.floor(endMins / 60) % 24).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;
    console.log(`[optimizer]   ${label}: ${fromStr}–${endStr}  ${kWh.toFixed(1)} kWh  avg ${avgPrice.toFixed(2)} ${currency}/kWh`);
  }
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

  // Log average daytime cloud cover from forecast (hours where irradiance > 0)
  const daytimeRows = solarRows.filter(r => r.irr_forecast > 0 && r.cloud_cover != null);
  const avgCloud = daytimeRows.length > 0
    ? Math.round(daytimeRows.reduce((s, r) => s + r.cloud_cover, 0) / daytimeRows.length)
    : 0;
  if (daytimeRows.length > 0) {
    console.log(`[optimizer] Cloud cover: avg ${avgCloud}% over ${daytimeRows.length} daytime forecast hours`);
  }

  // Intra-day solar correction: scale remaining forecast by today's actual/forecast ratio.
  const intradayScalar = (options.intradayScalar != null && isFinite(options.intradayScalar))
    ? options.intradayScalar : 1.0;
  if (intradayScalar !== 1.0) {
    console.log(`[optimizer] Intra-day solar scalar: ${intradayScalar.toFixed(2)} applied to remaining forecast`);
  }

  // Minimum solar power to be treated as real generation — suppresses pre-dawn
  // forecast artefacts that would otherwise cause spurious SOC increases.
  const MIN_SOLAR_W = 50;

  const solarHourly = solarRows.map(r => ({
    hour_ts: r.hour_ts,
    value: r.prod_forecast != null ? r.prod_forecast * 1000 * intradayScalar : 0, // kW → W
  }));
  const solar15min = interpolateTo15Min(solarHourly);
  const solarMap = new Map(solar15min.map(s => [s.slot_ts, Math.max(0, s.value) < MIN_SOLAR_W ? 0 : s.value]));

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
  const minSocPct  = config.inverter?.discharge_soc ?? bat.min_soc;
  const minSocWh   = (minSocPct / 100) * capacityWh;
  const maxSocWh   = (bat.max_soc / 100) * capacityWh;
  const slotHours = 0.25; // 15 min = 0.25 hours
  const maxChargeWh = bat.max_charge_w * slotHours;
  const maxDischargeWh = bat.max_discharge_w * slotHours;

  // Starting SOC (needed for solar-aware headroom calculation below)
  const startSocWh = options.startSoc != null
    ? Math.max(minSocWh, Math.min(maxSocWh, (options.startSoc / 100) * capacityWh))
    : minSocWh;

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

  // Charge candidates: slots where solar does not cover consumption (no free surplus).
  // Slots with net surplus are excluded (charge_solar handles those for free).
  // The solar-aware headroom calculation already limits how much we grid-charge
  // based on expected solar fills — no need to additionally block by solar watts.
  const chargeOrder = slots
    .map((_, i) => i)
    .filter(i => slots[i].net_production <= 0)
    .sort((a, b) => slots[a].buy_price - slots[b].buy_price);

  // --- Solar-aware grid charging headroom ---
  // Solar surplus will charge the battery for free. Avoid grid-charging energy
  // that solar will provide — that wastes both money and solar.
  //
  // solarAbsorbWh  = how much solar the battery can actually absorb (limited by room)
  // gridHeadroomWh = remaining room for grid charging after solar fills its share
  const solarSurplusWh = slots
    .filter(s => s.net_production > 0)
    .reduce((sum, s) => sum + Math.min(s.net_production * slotHours, maxChargeWh), 0);
  const batteryRoomWh  = maxSocWh - startSocWh;
  const solarConfidence    = bat.solar_forecast_confidence ?? 0.7;

  // If total forecast solar exceeds battery room + total consumption, solar alone will
  // fill the battery and cover all loads — waive the min_grid_charge_kwh floor entirely.
  const totalSolarWh       = slots.reduce((sum, s) => sum + s.solar_watts * slotHours, 0);
  const totalConsumptionWh = slots.reduce((sum, s) => sum + s.consumption_watts * slotHours, 0);
  const solarSufficient    = totalSolarWh >= batteryRoomWh + totalConsumptionWh;

  // Cloud-adjusted solar confidence: on overcast days solar delivers near zero,
  // so crediting 70% of forecast against battery headroom wastes capacity.
  // effectiveConfidence scales to zero at 100% cloud cover.
  const effectiveConfidence = solarConfidence * (1 - avgCloud / 100);

  // Cloud-adjusted minimum grid reserve: on very overcast days (>80% cloud),
  // solar won't fill the gap so there's no point saving room for it.
  const baseMinReserveKwh  = bat.min_grid_charge_kwh ?? 4.0;
  const cloudReductionFactor = Math.max(0, (avgCloud - 80) / 20); // 0 at ≤80%, 1 at 100%
  const effectiveMinReserveKwh = baseMinReserveKwh * (1 - cloudReductionFactor);
  const minGridReserveWh   = solarSufficient ? 0 : effectiveMinReserveKwh * 1000;

  const solarAbsorbCap     = Math.max(0, batteryRoomWh - minGridReserveWh);
  const solarAbsorbWh      = Math.min(solarSurplusWh * effectiveConfidence, solarAbsorbCap);
  const gridHeadroomWh = Math.max(0, batteryRoomWh - solarAbsorbWh);
  const existAboveMinWh = startSocWh - minSocWh;

  if (solarAbsorbWh > 0 || avgCloud > 0) {
    console.log(`[optimizer] Solar-aware: ${(solarSurplusWh / 1000).toFixed(1)} kWh forecast × ${effectiveConfidence.toFixed(2)} confidence ` +
                `(${solarConfidence} × ${(1 - avgCloud / 100).toFixed(2)} cloud adj) ` +
                `= ${(solarAbsorbWh / 1000).toFixed(1)} kWh credited, ` +
                `min reserve ${effectiveMinReserveKwh.toFixed(1)} kWh, ` +
                `grid headroom ${(gridHeadroomWh / 1000).toFixed(1)} kWh` +
                (solarSufficient ? ' (min_grid_charge floor waived — solar covers all)' : ''));
  }

  let chargeSlots   = [];
  let dischargeSlots = [];
  let ci = 0, di = 0;
  let gridChargedWh = 0;
  let dischargedWh  = 0;

  // Phase A: pair cheapest grid-charge with most expensive discharge.
  // Grid charging is capped to gridHeadroomWh — solar fills the rest.
  // Temporal constraint: charge must precede discharge in time. If the cheapest
  // charge slot comes after the most expensive discharge, skip that discharge.
  while (ci < chargeOrder.length && di < dischargeOrder.length && gridChargedWh < gridHeadroomWh) {
    const cIdx = chargeOrder[ci];
    const dIdx = dischargeOrder[di];

    if (cIdx === dIdx) { ci++; continue; }

    // Charge must come before discharge — skip discharge if no valid charge exists yet
    if (slots[cIdx].slot_ts >= slots[dIdx].slot_ts) { di++; continue; }

    const spread = slots[dIdx].buy_price - slots[cIdx].buy_price;
    if (spread <= minSpread) { di++; continue; }

    const dischargeWh = Math.min(slots[dIdx].avoidable_wh, maxDischargeWh,
                                 (gridHeadroomWh - gridChargedWh) * bat.efficiency);
    const chargeWh    = Math.min(dischargeWh / bat.efficiency, maxChargeWh,
                                 gridHeadroomWh - gridChargedWh);
    if (chargeWh <= 0) { di++; continue; }

    chargeSlots.push({ idx: cIdx, wh: chargeWh });
    dischargeSlots.push({ idx: dIdx, wh: dischargeWh });
    gridChargedWh += chargeWh;
    dischargedWh  += dischargeWh;
    ci++;
    di++;
  }

  // Phase B: plan discharge of solar + existing battery energy at most profitable times.
  // Solar charges the battery for free; discharge it when prices are high.
  // Budget = all energy available (existing above min + grid charged + solar absorbed),
  // minus what Phase A already scheduled for discharge.
  {
    const phaseBBudget = Math.max(0, existAboveMinWh + gridChargedWh + solarAbsorbWh - dischargedWh);
    const alreadyIdx   = new Set(dischargeSlots.map(d => d.idx));
    let solarDischargedWh = 0;

    for (const dIdx of dischargeOrder) {
      if (solarDischargedWh >= phaseBBudget) break;
      if (alreadyIdx.has(dIdx)) continue;

      const dischargeWh = Math.min(slots[dIdx].avoidable_wh, maxDischargeWh,
                                   phaseBBudget - solarDischargedWh);
      if (dischargeWh <= 0) continue;

      dischargeSlots.push({ idx: dIdx, wh: dischargeWh });
      solarDischargedWh += dischargeWh;
    }

    if (solarDischargedWh > 0) {
      console.log(`[optimizer] Solar discharge: ${(solarDischargedWh / 1000).toFixed(1)} kWh planned from solar/existing energy`);
    }
  }

  // Phase C: overnight recharge opportunity.
  // Phase B uses the existing SOC for tonight's discharge. After that the battery
  // is at minSocWh — a fresh full-range headroom is available for a second cycle.
  // Detect when the battery first depletes, then pair cheap overnight charge slots
  // with expensive next-morning discharge slots.
  {
    // Mini forward-pass to find the first slot where SOC reaches minSocWh.
    let socSim = startSocWh;
    let depletedAtIdx = -1;
    const dSimMap = new Map(dischargeSlots.map(d => [d.idx, d.wh]));
    const cSimMap  = new Map(chargeSlots.map(c => [c.idx, c.wh]));
    for (let i = 0; i < slots.length; i++) {
      if (cSimMap.has(i)) {
        socSim = Math.min(maxSocWh, socSim + cSimMap.get(i) * bat.efficiency);
      } else if (dSimMap.has(i)) {
        const ex = Math.min(dSimMap.get(i), socSim - minSocWh);
        socSim = Math.max(minSocWh, socSim - ex);
      } else if (slots[i].net_production > 0) {
        socSim = Math.min(maxSocWh, socSim + slots[i].net_production * slotHours);
      }
      if (depletedAtIdx === -1 && socSim <= minSocWh + 100) depletedAtIdx = i;
    }

    if (depletedAtIdx >= 0 && depletedAtIdx < slots.length - 1) {
      const alreadyDs = new Set(dischargeSlots.map(d => d.idx));
      const alreadyCs = new Set(chargeSlots.map(c => c.idx));

      // Charge candidates after depletion, sorted cheapest first
      const postChargeOrder = slots
        .map((_, i) => i)
        .filter(i => i > depletedAtIdx && slots[i].net_production <= 0 && !alreadyCs.has(i))
        .sort((a, b) => slots[a].buy_price - slots[b].buy_price);

      // Discharge candidates after depletion, sorted most expensive first
      const postDischargeOrder = slots
        .map((_, i) => i)
        .filter(i => i > depletedAtIdx && slots[i].avoidable_wh > 0 && !alreadyDs.has(i))
        .sort((a, b) => slots[b].buy_price - slots[a].buy_price);

      const phaseCBudgetWh = maxSocWh - minSocWh;
      let phaseCChargedWh = 0;
      let pci = 0, pdi = 0;

      while (pci < postChargeOrder.length && pdi < postDischargeOrder.length
             && phaseCChargedWh < phaseCBudgetWh) {
        const cIdx = postChargeOrder[pci];
        const dIdx = postDischargeOrder[pdi];

        // Temporal constraint: charge must precede discharge
        if (slots[cIdx].slot_ts >= slots[dIdx].slot_ts) { pci++; continue; }

        const spread = slots[dIdx].buy_price - slots[cIdx].buy_price;
        if (spread <= minSpread) { pdi++; continue; }

        const dischargeWh = Math.min(slots[dIdx].avoidable_wh, maxDischargeWh,
                                     (phaseCBudgetWh - phaseCChargedWh) * bat.efficiency);
        const chargeWh    = Math.min(dischargeWh / bat.efficiency, maxChargeWh,
                                     phaseCBudgetWh - phaseCChargedWh);
        if (chargeWh <= 0) { pdi++; continue; }

        chargeSlots.push({ idx: cIdx, wh: chargeWh });
        dischargeSlots.push({ idx: dIdx, wh: dischargeWh });
        phaseCChargedWh += chargeWh;
        pci++;
        pdi++;
      }

      if (phaseCChargedWh > 0) {
        console.log(`[optimizer] Phase C (overnight): ${(phaseCChargedWh / 1000).toFixed(1)} kWh grid charge planned after battery depletion`);
      }
    }
  }

  // Temporal feasibility correction: Phase B budgets energy globally but the forward SOC pass
  // runs chronologically. Low-value early discharges can deplete the battery before high-value
  // later slots execute. Swap them out: find the most valuable discharge slot that would be
  // cancelled (executed < 50% of planned), remove the cheapest earlier discharge, repeat.
  {
    const chargeMap = new Map(chargeSlots.map(cs => [cs.idx, cs.wh]));
    const maxIter = 20;

    for (let iter = 0; iter < maxIter; iter++) {
      // Simulate forward SOC with current plan
      const dischargeMap = new Map(dischargeSlots.map(ds => [ds.idx, ds.wh]));
      let soc = startSocWh;
      const executedWh = new Map();

      for (let i = 0; i < slots.length; i++) {
        if (chargeMap.has(i)) {
          soc = Math.min(maxSocWh, soc + chargeMap.get(i) * bat.efficiency);
        } else if (dischargeMap.has(i)) {
          const planned  = dischargeMap.get(i);
          const executed = Math.min(planned, soc - minSocWh);
          executedWh.set(i, executed);
          soc = Math.max(minSocWh, soc - executed);
        } else if (slots[i].net_production > 0) {
          soc = Math.min(maxSocWh, soc + slots[i].net_production * slotHours);
        }
      }

      // Find the most valuable slot that executes at less than 50% of planned
      let bestCompromised = null;
      for (const ds of dischargeSlots) {
        const executed = executedWh.get(ds.idx) ?? 0;
        if (executed >= ds.wh * 0.5) continue;
        const hasCheaperBefore = dischargeSlots.some(other =>
          slots[other.idx].slot_ts < slots[ds.idx].slot_ts &&
          slots[other.idx].buy_price < slots[ds.idx].buy_price
        );
        if (hasCheaperBefore &&
            (!bestCompromised || slots[ds.idx].buy_price > slots[bestCompromised.idx].buy_price)) {
          bestCompromised = ds;
        }
      }

      if (!bestCompromised) break;

      // Remove the cheapest discharge slot that runs before the compromised one
      const before   = dischargeSlots.filter(ds => slots[ds.idx].slot_ts < slots[bestCompromised.idx].slot_ts);
      const toRemove = before.reduce((min, ds) =>
        slots[ds.idx].buy_price < slots[min.idx].buy_price ? ds : min
      );
      dischargeSlots.splice(dischargeSlots.indexOf(toRemove), 1);
      console.log(`[optimizer] Correction: removed discharge ${slots[toRemove.idx].slot_ts.slice(11,16)} ` +
        `(${slots[toRemove.idx].buy_price.toFixed(4)}) to preserve SOC for ` +
        `${slots[bestCompromised.idx].slot_ts.slice(11,16)} ` +
        `(${slots[bestCompromised.idx].buy_price.toFixed(4)})`);
    }
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
  let currentSocWh = startSocWh;
  if (options.startSoc != null) {
    console.log(`[optimizer] Starting SOC: ${options.startSoc}% (${Math.round(currentSocWh)}Wh from inverter)`);
  } else {
    console.log(`[optimizer] Starting SOC: ${minSocPct}% (conservative default)`);
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

  // Log charge and discharge windows with price context
  logWindows('Charge grid', slots.filter(s => s.action === 'charge_grid'), s => s.buy_price, currency);
  logWindows('Discharge  ', slots.filter(s => s.action === 'discharge'),   s => s.buy_price, currency);

  return { schedule: dbRows, summary };
}
