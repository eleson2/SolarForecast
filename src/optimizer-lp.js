/**
 * LP-based battery optimizer.
 * Same public interface as optimizer.js — drop-in replacement candidate.
 *
 * Formulation (96 × 15-min slots, N slots total):
 *   Variables per slot t:
 *     cg_t   — grid charge power (W)
 *     d_t    — discharge power (W)
 *     cs_t   — solar charge power (W)   [free energy, zero cost]
 *     s_t    — battery SOC (Wh)         [s_0 … s_N, N+1 values]
 *
 *   Objective:  minimize Σ buy_price[t] * cg_t * h/1000
 *                       − Σ buy_price[t] * d_t  * h/1000
 *     (h = 0.25 h per slot; /1000 converts W→kW; buy_price in currency/kWh)
 *
 *   Constraints:
 *     SOC continuity:  s_{t+1} = s_t + η·h·(cg_t + cs_t) − h·d_t   ∀t
 *     Initial SOC:     s_0 fixed to startSocWh
 *     SOC bounds:      min_soc_wh ≤ s_t ≤ max_soc_wh
 *     Charge bounds:   0 ≤ cg_t ≤ max_charge_w
 *     Discharge bound: 0 ≤ d_t  ≤ min(max_discharge_w, grid_deficit_w[t])
 *     Solar bound:     0 ≤ cs_t ≤ min(max_charge_w, solar_surplus_w[t])
 *
 * Mutual exclusion (charge + discharge same slot) is not needed explicitly —
 * efficiency < 1 makes round-tripping always net-negative, so the solver
 * never charges and discharges in the same slot.
 */

import config from '../config.js';
import {
  getPricesForRange,
  getReadingsForForecast,
  upsertScheduleBatch,
  deleteScheduleForRange,
} from './db.js';
import Highs from 'highs';

const currency = config.price.currency;

// Module-level HiGHS instance (loaded once, reused across calls).
// output_flag: false suppresses solver log lines on stdout.
let _highs = null;
async function getHighs() {
  if (!_highs) _highs = await Highs({ output_flag: false });
  return _highs;
}

/** Interpolate hourly values to 15-min slots (4× expansion). */
function interpolateTo15Min(hourlyData) {
  const slots = [];
  for (const entry of hourlyData) {
    const prefix = entry.hour_ts.slice(0, 11);
    const hour   = entry.hour_ts.slice(11, 13);
    for (const min of ['00', '15', '30', '45']) {
      slots.push({ slot_ts: `${prefix}${hour}:${min}`, value: entry.value });
    }
  }
  return slots;
}

/** Log contiguous charge/discharge windows with kWh and avg price. */
function logWindows(label, actionSlots, priceFn) {
  if (actionSlots.length === 0) return;
  const windows = [];
  let winSlots = [actionSlots[0]];
  for (let i = 1; i < actionSlots.length; i++) {
    const [ph, pm] = actionSlots[i - 1].slot_ts.slice(11, 16).split(':').map(Number);
    const [ch, cm] = actionSlots[i].slot_ts.slice(11, 16).split(':').map(Number);
    const gap = ((ch * 60 + cm) - (ph * 60 + pm) + 1440) % 1440;
    if (gap === 15) { winSlots.push(actionSlots[i]); }
    else { windows.push(winSlots); winSlots = [actionSlots[i]]; }
  }
  windows.push(winSlots);
  for (const w of windows) {
    const kWh      = w.reduce((s, sl) => s + sl.watts * 0.25 / 1000, 0);
    const avgPrice = w.reduce((s, sl) => s + priceFn(sl), 0) / w.length;
    const from     = w[0].slot_ts.slice(11, 16);
    const [lh, lm] = w[w.length - 1].slot_ts.slice(11, 16).split(':').map(Number);
    const endMins  = lh * 60 + lm + 15;
    const to       = `${String(Math.floor(endMins / 60) % 24).padStart(2, '0')}:${String(endMins % 60).padStart(2, '0')}`;
    console.log(`[optimizer-lp]   ${label}: ${from}–${to}  ${kWh.toFixed(1)} kWh  avg ${avgPrice.toFixed(2)} ${currency}/kWh`);
  }
}

/**
 * Run the LP optimizer.
 * Same signature as the greedy runOptimizer() — async due to HiGHS WASM loading.
 *
 * @param {string} fromTs
 * @param {string} toTs
 * @param {Array}  consumptionEstimates  [{hour_ts, consumption_w}]
 * @param {Object} [options]
 * @param {number} [options.startSoc]    Live battery SOC % (0–100)
 * @param {number} [options.intradayScalar]
 * @param {boolean}[options.dry_run]     If true, skip writing to DB
 * @returns {Promise<{schedule: Array, summary: Object}>}
 */
export async function runOptimizer(fromTs, toTs, consumptionEstimates, options = {}) {
  const bat  = config.battery;
  const grid = config.grid;

  // ── 1. Gather inputs ────────────────────────────────────────────────────────

  const prices = getPricesForRange(fromTs, toTs);
  if (prices.length === 0) {
    console.log('[optimizer-lp] No price data available for range');
    return { schedule: [], summary: null };
  }

  const solarRows = getReadingsForForecast(fromTs, toTs);

  const daytimeRows = solarRows.filter(r => r.irr_forecast > 0 && r.cloud_cover != null);
  if (daytimeRows.length > 0) {
    const avgCloud = Math.round(daytimeRows.reduce((s, r) => s + r.cloud_cover, 0) / daytimeRows.length);
    console.log(`[optimizer-lp] Cloud cover: avg ${avgCloud}% over ${daytimeRows.length} daytime forecast hours`);
  }

  const intradayScalar = (options.intradayScalar != null && isFinite(options.intradayScalar))
    ? options.intradayScalar : 1.0;
  if (intradayScalar !== 1.0) {
    console.log(`[optimizer-lp] Intra-day solar scalar: ${intradayScalar.toFixed(2)}`);
  }

  // Minimum solar power to be treated as real generation — suppresses pre-dawn
  // forecast artefacts that would otherwise cause spurious SOC increases.
  const MIN_SOLAR_W = 50;

  const solarMap = new Map(
    interpolateTo15Min(solarRows.map(r => ({
      hour_ts: r.hour_ts,
      value: r.prod_forecast != null ? r.prod_forecast * 1000 * intradayScalar : 0,
    }))).map(s => [s.slot_ts, Math.max(0, s.value) < MIN_SOLAR_W ? 0 : s.value])
  );

  const consumptionMap = new Map(
    interpolateTo15Min(
      consumptionEstimates.map(c => ({ hour_ts: c.hour_ts, value: c.consumption_w }))
    ).map(c => [c.slot_ts, c.value])
  );

  // ── 2. Build slot objects ────────────────────────────────────────────────────

  const slots = prices.map(p => {
    const solar       = solarMap.get(p.slot_ts) ?? 0;
    const consumption = consumptionMap.get(p.slot_ts) ?? config.consumption.flat_watts;
    const buyPrice    = p.spot_price + grid.transfer_import_kwh + grid.energy_tax_kwh;
    const sellPrice   = grid.sell_enabled
      ? p.spot_price * grid.sell_price_factor - grid.transfer_export_kwh : 0;
    return {
      slot_ts: p.slot_ts, spot_price: p.spot_price, buy_price: buyPrice,
      sell_price: sellPrice, solar_watts: solar, consumption_watts: consumption,
      net_production: solar - consumption,
      action: 'idle', watts: 0, soc_start: 0, soc_end: 0,
    };
  });

  // ── 3. Battery constants ─────────────────────────────────────────────────────

  const N          = slots.length;
  const capacityWh = bat.capacity_kwh * 1000;
  const minSocPct  = config.inverter?.discharge_soc ?? bat.min_soc;
  const minSocWh   = (minSocPct / 100) * capacityWh;
  const maxSocWh   = (bat.max_soc / 100) * capacityWh;
  const h          = 0.25;               // slot duration in hours
  const etaH       = bat.efficiency * h; // charge efficiency × slot hours
  const startSocWh = options.startSoc != null
    ? Math.max(minSocWh, Math.min(maxSocWh, (options.startSoc / 100) * capacityWh))
    : minSocWh;

  if (options.startSoc != null) {
    console.log(`[optimizer-lp] Starting SOC: ${options.startSoc}% (${Math.round(startSocWh)} Wh)`);
  } else {
    console.log(`[optimizer-lp] Starting SOC: ${minSocPct}% (conservative default)`);
  }

  // Peak shaving: per-slot grid import cap → limits how fast the battery can charge from grid.
  // cg_t upper bound = max(0, peakShavingW[t] - consumption_watts[t])
  // Note: default_kw is the *physical* hardware limit (written to inverter register 800).
  // It applies regardless of whether 'enabled' is true — 'enabled' only controls whether
  // the scheduler re-dispatches the register every 15 min.
  const psConfig = config.peak_shaving;
  function peakShavingLimitW(slotTs) {
    if (!psConfig?.default_kw) return bat.max_charge_w;
    const hhmm = slotTs.slice(11, 16);
    for (const entry of (psConfig.schedule || [])) {
      if (hhmm >= entry.from && hhmm <= entry.to) return entry.limit_kw * 1000;
    }
    return psConfig.default_kw * 1000;
  }
  if (psConfig?.default_kw) {
    console.log(`[optimizer-lp] Grid import cap: ${psConfig.default_kw} kW → max charge rate = cap − consumption`);
  }

  // ── 4. Build LP problem string ───────────────────────────────────────────────
  //
  // Variable index convention (all watts):
  //   cg_T   charge_grid[T]   T = 0..N-1
  //   d_T    discharge[T]     T = 0..N-1
  //   cs_T   charge_solar[T]  T = 0..N-1
  //   s_T    soc[T]           T = 0..N  (N+1 values; s_0 fixed = startSocWh)

  // Tiebreaker: tiny epsilon added linearly to cg_t coefficients.
  // Breaks LP degeneracy on flat overnight price segments (e.g. all slots 01:00–04:00 same price).
  // ε is ~10–40× smaller than any real price difference the optimizer acts on.
  const avgBuyPrice = slots.reduce((s, sl) => s + sl.buy_price, 0) / slots.length;
  const epsilonPerKwh = avgBuyPrice * 0.005;
  console.log(`[optimizer-lp] Charge tiebreaker ε=${epsilonPerKwh.toFixed(4)} ${currency}/kWh ` +
    `(0.5% of avg buy price ${avgBuyPrice.toFixed(3)})`);

  // Objective: minimize Σ coeff_t * cg_t − Σ coeff_t * d_t − endSocBonus * s_N
  // The end-SOC bonus is a soft incentive to end the 24h window with higher SOC,
  // preventing the solver from draining the battery in the last expensive slot
  // with no cost for the next optimization window starting depleted.
  const endSocBonusCoeff = (avgBuyPrice * 0.1 * h / 1000).toFixed(8); // ~10% of avg slot value per Wh

  const objLines = [];
  for (let t = 0; t < N; t++) {
    const tiebreak = epsilonPerKwh * (t / N) * h / 1000;
    const coeff    = (slots[t].buy_price * h / 1000 + tiebreak).toFixed(8);
    objLines.push(`${coeff} cg_${t}`);
  }
  for (let t = 0; t < N; t++) {
    const coeff = (slots[t].buy_price * h / 1000).toFixed(8);
    objLines.push(`-${coeff} d_${t}`);
  }
  // Soft penalty for low terminal SOC (subtract bonus for s_N — minimize means solver prefers high s_N)
  objLines.push(`-${endSocBonusCoeff} s_${N}`);

  // Wrap long objective over multiple lines (LP format allows leading whitespace)
  const objStr = objLines.join('\n    + ').replace(/\+ -/g, '- ');

  // SOC continuity constraints: s_{t+1} - s_t - etaH*cg_t - etaH*cs_t + h*d_t = 0
  const constrLines = [];
  for (let t = 0; t < N; t++) {
    constrLines.push(
      `  sc_${t}: - s_${t} + s_${t + 1}` +
      ` - ${etaH.toFixed(8)} cg_${t}` +
      ` - ${etaH.toFixed(8)} cs_${t}` +
      ` + ${h.toFixed(8)} d_${t} = 0`
    );
  }

  // Variable bounds
  const boundLines = [];

  // s_0 fixed to startSocWh
  boundLines.push(`  ${startSocWh.toFixed(4)} <= s_0 <= ${startSocWh.toFixed(4)}`);
  // s_1 .. s_N free within SOC limits
  for (let t = 1; t <= N; t++) {
    boundLines.push(`  ${minSocWh.toFixed(4)} <= s_${t} <= ${maxSocWh.toFixed(4)}`);
  }
  // Decision variable bounds
  for (let t = 0; t < N; t++) {
    const maxDis = Math.min(bat.max_discharge_w,
                            Math.max(0, slots[t].consumption_watts - slots[t].solar_watts));
    const maxSol = Math.min(bat.max_charge_w,
                            Math.max(0, slots[t].solar_watts - slots[t].consumption_watts));
    const psLimitW = peakShavingLimitW(slots[t].slot_ts);
    const maxCgW   = Math.max(0, Math.min(bat.max_charge_w, psLimitW - slots[t].consumption_watts));
    boundLines.push(`  0 <= cg_${t} <= ${maxCgW.toFixed(4)}`);
    boundLines.push(`  0 <= d_${t}  <= ${maxDis.toFixed(4)}`);
    boundLines.push(`  0 <= cs_${t} <= ${maxSol.toFixed(4)}`);
  }

  const lpStr =
    `\\ Battery optimizer — LP formulation
Minimize
    obj: ${objStr}
Subject To
${constrLines.join('\n')}
Bounds
${boundLines.join('\n')}
End`;

  // ── 5. Solve ─────────────────────────────────────────────────────────────────

  const highs = await getHighs();
  let result;
  try {
    result = highs.solve(lpStr);
  } catch (err) {
    console.log(`[optimizer-lp] Solver error: ${err.message}`);
    return { schedule: [], summary: null };
  }

  if (result.Status !== 'Optimal' && result.Status !== 'Feasible') {
    console.log(`[optimizer-lp] Solver returned status: ${result.Status} — no schedule produced`);
    return { schedule: [], summary: null };
  }

  console.log(`[optimizer-lp] Solved: ${result.Status}, objective = ${result.ObjectiveValue.toFixed(4)} ${currency}`);

  // ── 6. Parse solution → slot actions ─────────────────────────────────────────

  const NOISE_W = 10; // watts — ignore numerical noise / marginal round-trips below this threshold

  for (let t = 0; t < N; t++) {
    const cgW  = Math.max(0, result.Columns[`cg_${t}`]?.Primal ?? 0);
    const dW   = Math.max(0, result.Columns[`d_${t}`]?.Primal  ?? 0);
    const csW  = Math.max(0, result.Columns[`cs_${t}`]?.Primal ?? 0);
    const socT = result.Columns[`s_${t}`]?.Primal  ?? startSocWh;
    const socN = result.Columns[`s_${t + 1}`]?.Primal ?? startSocWh;

    slots[t].soc_start = Math.round((socT / capacityWh) * 100 * 10) / 10;
    slots[t].soc_end   = Math.round((socN / capacityWh) * 100 * 10) / 10;
    slots[t].price_kwh = slots[t].spot_price;

    if (cgW > NOISE_W) {
      slots[t].action = 'charge_grid';
      slots[t].watts  = Math.round(cgW);
    } else if (dW > NOISE_W) {
      slots[t].action = 'discharge';
      slots[t].watts  = Math.round(dW);
    } else if (csW > NOISE_W) {
      slots[t].action = 'charge_solar';
      slots[t].watts  = Math.round(csW);
    } else {
      slots[t].action = 'idle';
      slots[t].watts  = 0;
    }
  }

  // ── 7. Savings summary ───────────────────────────────────────────────────────

  let costWithout = 0;
  let costWith    = 0;
  for (const slot of slots) {
    const consumptionKwh = slot.consumption_watts * h / 1000;
    const solarKwh       = Math.min(slot.solar_watts, slot.consumption_watts) * h / 1000;
    const gridNeededKwh  = Math.max(0, consumptionKwh - solarKwh);

    costWithout += gridNeededKwh * slot.buy_price;

    switch (slot.action) {
      case 'charge_grid':
        costWith += gridNeededKwh * slot.buy_price;
        costWith += (slot.watts * h / 1000) * slot.buy_price;
        break;
      case 'discharge': {
        const dischargeKwh = slot.watts * h / 1000;
        costWith += Math.max(0, gridNeededKwh - dischargeKwh) * slot.buy_price;
        break;
      }
      default:
        costWith += gridNeededKwh * slot.buy_price;
    }
  }

  const summary = {
    estimated_cost_without_battery: Math.round(costWithout * 100) / 100,
    estimated_cost_with_battery:    Math.round(costWith    * 100) / 100,
    estimated_savings:              Math.round((costWithout - costWith) * 100) / 100,
  };

  // ── 8. Log ───────────────────────────────────────────────────────────────────

  const actionCounts = {};
  for (const s of slots) actionCounts[s.action] = (actionCounts[s.action] || 0) + 1;
  console.log(`[optimizer-lp] Schedule: ${slots.length} slots — ${JSON.stringify(actionCounts)}`);
  console.log(`[optimizer-lp] Savings: ${summary.estimated_savings} ${currency}` +
    ` (${summary.estimated_cost_without_battery} → ${summary.estimated_cost_with_battery})`);
  logWindows('Charge grid', slots.filter(s => s.action === 'charge_grid'), s => s.buy_price);
  logWindows('Discharge  ', slots.filter(s => s.action === 'discharge'),   s => s.buy_price);

  // ── 9. Write to DB (skip on dry_run) ─────────────────────────────────────────

  const dbRows = slots.map(s => ({
    slot_ts:           s.slot_ts,
    action:            s.action,
    watts:             s.watts,
    soc_start:         s.soc_start,
    soc_end:           s.soc_end,
    price_kwh:         s.price_kwh,
    solar_watts:       s.solar_watts,
    consumption_watts: s.consumption_watts,
  }));

  if (!options.dry_run) {
    deleteScheduleForRange(fromTs, toTs);
    upsertScheduleBatch(dbRows);
  }

  return { schedule: dbRows, summary };
}
