/**
 * Tests for optimizer-lp.js changes:
 *   A. charge_grid price ceiling  — no charge_grid above config.battery.charge_grid_max_buy_price
 *   B. min-SOC idle window warning — WARN logged when battery sits at min_soc for > 4 h
 */

import { runOptimizer } from './src/optimizer-lp.js';
import config from './config.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function makePrice(datePrefix, spotFn) {
  const slots = [];
  for (let h = 0; h < 24; h++) {
    for (const m of ['00', '15', '30', '45']) {
      const hh = String(h).padStart(2, '0');
      slots.push({ slot_ts: `${datePrefix}${hh}:${m}`, spot_price: spotFn(h) });
    }
  }
  return slots;
}

function makeSolar(datePrefix, prodFn = () => 0) {
  return Array.from({ length: 24 }, (_, h) => ({
    hour_ts: `${datePrefix}${String(h).padStart(2, '0')}:00`,
    prod_forecast: prodFn(h),
    irr_forecast: 0,
    cloud_cover: 0,
  }));
}

function makeConsumption(datePrefix, wattsFn = () => 500) {
  return Array.from({ length: 24 }, (_, h) => ({
    hour_ts: `${datePrefix}${String(h).padStart(2, '0')}:00`,
    consumption_w: wattsFn(h),
  }));
}

// ── Test A: charge_grid price ceiling ────────────────────────────────────────
console.log('\n=== A: charge_grid price ceiling ===');
{
  // cheap hours 02–06 (spot 0.20), expensive hours 18–22 (spot 1.60), rest 0.50
  // buy_price = spot + 0.50 (transfer_import) + 0.00 (energy_tax)
  //   cheap  buy = 0.70   expensive buy = 2.10   mid buy = 1.00
  // Set ceiling to 1.05 → allows cheap+mid, blocks expensive
  const CEILING = 1.05;
  config.battery.charge_grid_max_buy_price = CEILING;

  const D = '2026-05-01T';
  const prices = makePrice(D, h =>
    h >= 2 && h < 6  ? 0.20 :
    h >= 18 && h < 22 ? 1.60 : 0.50
  );
  const solar  = makeSolar(D);
  const consumption = makeConsumption(D, () => 600);

  let result = [];
  await runOptimizer(`${D}00:00`, `${D}23:45`, consumption, {
    startSoc: 50,
    prices,
    solarReadings: solar,
    scheduleStore: (_, __, rows) => { result = rows; },
  });

  // No charge_grid where buy_price > CEILING
  const violations = result.filter(s => {
    if (s.action !== 'charge_grid') return false;
    const p = prices.find(p => p.slot_ts === s.slot_ts);
    const buyPrice = (p?.spot_price ?? 0)
      + config.grid.transfer_import_kwh
      + config.grid.energy_tax_kwh;
    return buyPrice > CEILING;
  });
  assert(violations.length === 0,
    `No charge_grid slots above ceiling ${CEILING} SEK/kWh (found ${violations.length} violation(s))`);

  // Cheap slots are still usable — optimizer should have charged in some of them
  const cheapCharges = result.filter(s => {
    if (s.action !== 'charge_grid') return false;
    const p = prices.find(p => p.slot_ts === s.slot_ts);
    const buyPrice = (p?.spot_price ?? 0)
      + config.grid.transfer_import_kwh
      + config.grid.energy_tax_kwh;
    return buyPrice <= CEILING;
  });
  assert(cheapCharges.length > 0,
    `Optimizer still charges in cheap slots below ceiling (found ${cheapCharges.length} slot(s))`);

  config.battery.charge_grid_max_buy_price = null; // restore
}

// ── Test B: min-SOC idle window warning ──────────────────────────────────────
console.log('\n=== B: min-SOC idle window warning ===');
{
  // Battery starts at min_soc (discharge_soc = 20%), consumption = 0, no solar.
  // Optimizer has nothing to do — battery stays at min_soc all 96 slots (24 h).
  // The post-solve scan should emit a WARN covering the full window.
  const minSocPct = config.inverter?.discharge_soc ?? config.battery.min_soc; // 20

  const D = '2026-05-02T';
  const prices    = makePrice(D, () => 0.50);
  const solar     = makeSolar(D);
  const consumption = makeConsumption(D, () => 0);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); origWarn(...args); };

  await runOptimizer(`${D}00:00`, `${D}23:45`, consumption, {
    startSoc: minSocPct,
    prices,
    solarReadings: solar,
    scheduleStore: () => {},
  });

  console.warn = origWarn;

  const minSocWarn = warnings.find(w =>
    w.includes('min_soc') && w.includes('SOC guard')
  );
  assert(minSocWarn != null, 'min-SOC idle WARN emitted for 24-hour floor window');
  if (minSocWarn) console.log(`  INFO  "${minSocWarn.trim()}"`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
