/**
 * Optimizer contract and integration tests.
 *
 * All tests use data injection (options.prices, options.solarReadings,
 * options.scheduleStore) so no database or hardware is required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runOptimizer } from '../optimizer-lp.js';

// ---------------------------------------------------------------------------
// Synthetic data helpers
// ---------------------------------------------------------------------------

const FROM_TS = '2026-04-12T00:00';
const TO_TS   = '2026-04-12T23:45';

/**
 * Generate 96 × 15-min price slots for a single day.
 * priceByHour: array of 24 spot prices (index = hour). Defaults to flat 0.50.
 */
function makePrices(priceByHour = Array(24).fill(0.50)) {
  const rows = [];
  for (let h = 0; h < 24; h++) {
    for (const mm of ['00', '15', '30', '45']) {
      const hh = String(h).padStart(2, '0');
      rows.push({ slot_ts: `2026-04-12T${hh}:${mm}`, spot_price: priceByHour[h] });
    }
  }
  return rows;
}

/**
 * Generate 24 hourly solar reading rows.
 * solarByHour: array of 24 prod_forecast values in kWh (index = hour).
 */
function makeSolar(solarByHour = Array(24).fill(0)) {
  return solarByHour.map((kwh, h) => ({
    hour_ts:       `2026-04-12T${String(h).padStart(2, '0')}:00`,
    prod_forecast: kwh,
    irr_forecast:  kwh > 0 ? 200 : 0,   // non-zero irradiance when solar is present
    cloud_cover:   0,
  }));
}

/** Flat consumption estimate: 500 W every hour. */
const FLAT_CONSUMPTION = Array.from({ length: 24 }, (_, h) => ({
  hour_ts:       `2026-04-12T${String(h).padStart(2, '0')}:00`,
  consumption_w: 500,
}));

// ---------------------------------------------------------------------------
// Invariant checker (shared with any future caller)
// ---------------------------------------------------------------------------

export function assertOptimizerResult(result, { capacityKwh = 15, minSoc = 10, maxSoc = 95 } = {}) {
  const { schedule, summary } = result;

  assert.ok(Array.isArray(schedule), 'schedule must be an array');
  assert.ok(schedule.length > 0, 'schedule must be non-empty');
  assert.ok(typeof summary === 'object' && summary !== null, 'summary must be an object');
  assert.ok('estimated_savings' in summary, 'summary must have estimated_savings');

  const VALID_ACTIONS = new Set(['charge_grid', 'charge_solar', 'discharge', 'sell', 'idle']);

  for (const slot of schedule) {
    assert.ok(typeof slot.slot_ts === 'string',
      `slot_ts must be a string (got ${slot.slot_ts})`);
    assert.ok(VALID_ACTIONS.has(slot.action),
      `unknown action "${slot.action}" at ${slot.slot_ts}`);
    assert.ok(typeof slot.watts === 'number' && slot.watts >= 0,
      `watts must be ≥ 0 at ${slot.slot_ts} (got ${slot.watts})`);
    assert.ok(slot.soc_start >= minSoc - 0.1,
      `soc_start ${slot.soc_start}% < min_soc ${minSoc}% at ${slot.slot_ts}`);
    assert.ok(slot.soc_start <= maxSoc + 0.1,
      `soc_start ${slot.soc_start}% > max_soc ${maxSoc}% at ${slot.slot_ts}`);
    assert.ok(slot.soc_end >= minSoc - 0.1,
      `soc_end ${slot.soc_end}% < min_soc ${minSoc}% at ${slot.slot_ts}`);
    assert.ok(slot.soc_end <= maxSoc + 0.1,
      `soc_end ${slot.soc_end}% > max_soc ${maxSoc}% at ${slot.slot_ts}`);
    if (slot.action === 'idle') {
      assert.equal(slot.watts, 0, `idle slot must have watts=0 at ${slot.slot_ts}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

describe('optimizer-lp — module contract', () => {
  it('exports runOptimizer as a function', () => {
    assert.equal(typeof runOptimizer, 'function');
  });
});

// ---------------------------------------------------------------------------
// Empty input handling
// ---------------------------------------------------------------------------

describe('optimizer-lp — empty input handling', () => {
  it('returns empty schedule when no prices are injected', async () => {
    const result = await runOptimizer(FROM_TS, TO_TS, FLAT_CONSUMPTION, {
      prices: [],
      solarReadings: makeSolar(),
      scheduleStore: () => {},
    });
    assert.deepEqual(result, { schedule: [], summary: null });
  });
});

// ---------------------------------------------------------------------------
// Flat price — no arbitrage opportunity
// ---------------------------------------------------------------------------

describe('optimizer-lp — flat prices (no arbitrage)', () => {
  it('produces a valid schedule with no grid charging or discharge', async () => {
    // Start at min_soc — no stored energy to use.
    // At flat prices, charging from grid + discharging costs more than buying direct
    // (90% round-trip efficiency means 10% loss), so no charge_grid or discharge.
    const result = await runOptimizer(FROM_TS, TO_TS, FLAT_CONSUMPTION, {
      prices:        makePrices(),          // flat 0.50 SEK all day
      solarReadings: makeSolar(),           // no solar
      startSoc:      10,                    // at min_soc — nothing stored
      scheduleStore: () => {},
    });
    assertOptimizerResult(result);
    assert.equal(result.schedule.length, 96);

    const hasGridCharge = result.schedule.some(s => s.action === 'charge_grid');
    const hasDischarge  = result.schedule.some(s => s.action === 'discharge');
    assert.ok(!hasGridCharge, 'flat prices: no grid charging expected');
    assert.ok(!hasDischarge,  'flat prices: no discharge expected');
  });
});

// ---------------------------------------------------------------------------
// Price spread — optimizer should charge cheap, discharge expensive
// ---------------------------------------------------------------------------

describe('optimizer-lp — price spread (charge cheap / discharge expensive)', () => {
  it('produces charge slots during cheap hours and discharge during expensive hours', async () => {
    // Night cheap (0.20), evening peak expensive (1.50), rest moderate (0.50)
    const priceByHour = Array(24).fill(0.50);
    for (let h = 0;  h < 6;  h++) priceByHour[h] = 0.20;   // cheap overnight
    for (let h = 17; h < 21; h++) priceByHour[h] = 1.50;   // expensive peak

    const result = await runOptimizer(FROM_TS, TO_TS, FLAT_CONSUMPTION, {
      prices:        makePrices(priceByHour),
      solarReadings: makeSolar(),
      startSoc:      10,
      scheduleStore: () => {},
    });
    assertOptimizerResult(result);

    const chargeSlots    = result.schedule.filter(s => s.action === 'charge_grid');
    const dischargeSlots = result.schedule.filter(s => s.action === 'discharge');

    assert.ok(chargeSlots.length > 0,    'should have grid charge slots');
    assert.ok(dischargeSlots.length > 0, 'should have discharge slots');

    // All charge slots must be in the cheap window (00:00–05:45) — no reason to
    // charge at moderate or expensive prices when cheap slots are available.
    for (const s of chargeSlots) {
      const hh = parseInt(s.slot_ts.slice(11, 13), 10);
      assert.ok(hh < 6, `grid charge at ${s.slot_ts} is outside cheap window`);
    }

    // Discharge must include the expensive peak window (17:00–20:45).
    // The optimizer may also discharge during moderate hours (avoiding transfer fee
    // on cheap battery energy beats paying grid tariff), so we only assert that
    // at least some discharge falls in the peak window.
    const peakDischarge = dischargeSlots.some(s => {
      const hh = parseInt(s.slot_ts.slice(11, 13), 10);
      return hh >= 17 && hh < 21;
    });
    assert.ok(peakDischarge, 'discharge should include the expensive peak window (17:00–20:45)');
  });

  it('estimates positive savings when there is a price spread', async () => {
    const priceByHour = Array(24).fill(0.50);
    for (let h = 0;  h < 6;  h++) priceByHour[h] = 0.20;
    for (let h = 17; h < 21; h++) priceByHour[h] = 1.50;

    const { summary } = await runOptimizer(FROM_TS, TO_TS, FLAT_CONSUMPTION, {
      prices:        makePrices(priceByHour),
      solarReadings: makeSolar(),
      startSoc:      10,
      scheduleStore: () => {},
    });
    assert.ok(summary.estimated_savings > 0, `savings should be positive (got ${summary.estimated_savings})`);
  });
});

// ---------------------------------------------------------------------------
// Solar surplus — surplus should be captured as charge_solar, not charge_grid
// ---------------------------------------------------------------------------

describe('optimizer-lp — solar surplus', () => {
  it('uses charge_solar during solar surplus hours', async () => {
    // Strong solar midday: 3 kWh/h for 6 hours vs 0.5 kW consumption
    const solarByHour = Array(24).fill(0);
    for (let h = 10; h < 16; h++) solarByHour[h] = 3.0;

    const result = await runOptimizer(FROM_TS, TO_TS, FLAT_CONSUMPTION, {
      prices:        makePrices(),
      solarReadings: makeSolar(solarByHour),
      startSoc:      10,
      scheduleStore: () => {},
    });
    assertOptimizerResult(result);

    const solarChargeSlots = result.schedule.filter(s => s.action === 'charge_solar');
    assert.ok(solarChargeSlots.length > 0, 'should have charge_solar slots during surplus');

    // Solar charge should only happen during solar hours (10:00–15:45)
    for (const s of solarChargeSlots) {
      const hh = parseInt(s.slot_ts.slice(11, 13), 10);
      assert.ok(hh >= 10 && hh < 16, `charge_solar at ${s.slot_ts} is outside solar window`);
    }
  });
});

// ---------------------------------------------------------------------------
// scheduleStore injection — verify write callback receives correct data
// ---------------------------------------------------------------------------

describe('optimizer-lp — scheduleStore injection', () => {
  it('calls scheduleStore with fromTs, toTs, and the schedule rows', async () => {
    let storedFrom, storedTo, storedRows;

    await runOptimizer(FROM_TS, TO_TS, FLAT_CONSUMPTION, {
      prices:        makePrices(),
      solarReadings: makeSolar(),
      startSoc:      50,
      scheduleStore: (f, t, rows) => { storedFrom = f; storedTo = t; storedRows = rows; },
    });

    assert.equal(storedFrom, FROM_TS);
    assert.equal(storedTo,   TO_TS);
    assert.ok(Array.isArray(storedRows) && storedRows.length === 96);
    // Each row has the DB schema fields
    const row = storedRows[0];
    assert.ok('slot_ts' in row);
    assert.ok('action' in row);
    assert.ok('watts' in row);
    assert.ok('soc_start' in row);
    assert.ok('soc_end' in row);
  });

  it('does not call scheduleStore when prices are empty (early return)', async () => {
    let called = false;
    await runOptimizer(FROM_TS, TO_TS, FLAT_CONSUMPTION, {
      prices:        [],
      solarReadings: makeSolar(),
      scheduleStore: () => { called = true; },
    });
    assert.ok(!called, 'scheduleStore should not be called on empty prices');
  });
});

// ---------------------------------------------------------------------------
// assertOptimizerResult helper self-tests
// ---------------------------------------------------------------------------

describe('assertOptimizerResult — helper self-tests', () => {
  const goodResult = {
    schedule: [
      { slot_ts: '2026-04-12T00:00', action: 'charge_grid', watts: 3000, soc_start: 20, soc_end: 22, price_kwh: 0.5, solar_watts: 0, consumption_watts: 500 },
      { slot_ts: '2026-04-12T00:15', action: 'idle',        watts: 0,    soc_start: 22, soc_end: 22, price_kwh: 0.5, solar_watts: 0, consumption_watts: 500 },
    ],
    summary: { estimated_cost_without_battery: 10, estimated_cost_with_battery: 8, estimated_savings: 2 },
  };

  it('accepts a well-formed synthetic result', () => {
    assert.doesNotThrow(() => assertOptimizerResult(goodResult));
  });

  it('rejects SOC below min_soc', () => {
    const bad = { schedule: [{ ...goodResult.schedule[0], soc_start: 5, soc_end: 5 }], summary: { estimated_savings: 0 } };
    assert.throws(() => assertOptimizerResult(bad), /soc_start.*< min_soc/);
  });

  it('rejects unknown action', () => {
    const bad = { schedule: [{ ...goodResult.schedule[0], action: 'levitate' }], summary: { estimated_savings: 0 } };
    assert.throws(() => assertOptimizerResult(bad), /unknown action/);
  });

  it('rejects idle slot with non-zero watts', () => {
    const bad = { schedule: [{ ...goodResult.schedule[1], watts: 100 }], summary: { estimated_savings: 0 } };
    assert.throws(() => assertOptimizerResult(bad), /idle slot must have watts=0/);
  });
});
