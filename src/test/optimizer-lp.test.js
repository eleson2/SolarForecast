/**
 * Optimizer contract tests.
 *
 * These tests verify the shape and invariants of the optimizer's output given
 * a known synthetic schedule, without relying on a real database or hardware.
 *
 * The optimizer currently reads prices and solar data from SQLite. To keep
 * these tests self-contained we spin up an in-memory test DB, seed it with
 * known values, then call runOptimizer with dryRun: true.
 *
 * TODO: When runOptimizer is refactored to accept injected data (rather than
 * reading from DB directly), replace the DB seed approach with direct injection.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Build a minimal in-memory SQLite DB that mirrors the schema the optimizer
// expects, seeded with 24 hours of flat prices and zero solar.
// ---------------------------------------------------------------------------

const TZ = 'Europe/Stockholm';

function makeTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS price_slots (
      slot_ts   TEXT PRIMARY KEY,
      price_kwh REAL NOT NULL,
      buy_price REAL NOT NULL,
      sell_price REAL NOT NULL,
      source    TEXT
    );
    CREATE TABLE IF NOT EXISTS solar_readings (
      hour_ts       TEXT PRIMARY KEY,
      prod_forecast REAL,
      prod_actual   REAL,
      cloud_cover   REAL
    );
    CREATE TABLE IF NOT EXISTS consumption_readings (
      hour_ts         TEXT PRIMARY KEY,
      consumption_w   REAL,
      outdoor_temp_c  REAL,
      source          TEXT
    );
    CREATE TABLE IF NOT EXISTS battery_schedule (
      slot_ts           TEXT PRIMARY KEY,
      action            TEXT,
      watts             REAL,
      soc_start         REAL,
      soc_end           REAL,
      price_kwh         REAL,
      solar_watts       REAL,
      consumption_watts REAL
    );
  `);

  // 96 × 15-min slots for 2026-04-12 (flat 0.50 SEK/kWh, no solar)
  const insertPrice = db.prepare(`
    INSERT INTO price_slots (slot_ts, price_kwh, buy_price, sell_price, source)
    VALUES (?, 0.50, 1.00, 0.40, 'test')
  `);
  const insertSolar = db.prepare(`
    INSERT INTO solar_readings (hour_ts, prod_forecast, prod_actual, cloud_cover)
    VALUES (?, 0, 0, 0)
  `);

  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    insertSolar.run(`2026-04-12T${hh}:00`);
    for (let m = 0; m < 60; m += 15) {
      const mm = String(m).padStart(2, '0');
      insertPrice.run(`2026-04-12T${hh}:${mm}`);
    }
  }

  return db;
}

// ---------------------------------------------------------------------------
// We need to inject the test DB into the optimizer's db module. The cleanest
// way without refactoring the module is to patch the module-level db reference.
// For now we test the module can be imported and exported correctly, and
// document the full integration test path for when injection is available.
// ---------------------------------------------------------------------------

describe('optimizer-lp — module contract', () => {
  it('exports runOptimizer as a function', async () => {
    const mod = await import('../optimizer-lp.js');
    assert.equal(typeof mod.runOptimizer, 'function');
  });
});

// ---------------------------------------------------------------------------
// Output shape invariants — documented expectations for when integration tests
// are wired to a test DB. Each invariant is expressed as a helper so it can
// be reused once real runs are available.
// ---------------------------------------------------------------------------

/**
 * Assert that an optimizer result has the correct shape and satisfies
 * physical invariants.
 *
 * @param {{ schedule: Array, summary: Object }} result
 * @param {{ capacityKwh: number, minSoc: number, maxSoc: number }} battery
 */
export function assertOptimizerResult(result, battery) {
  const { schedule, summary } = result;

  // Shape
  assert.ok(Array.isArray(schedule), 'schedule must be an array');
  assert.ok(schedule.length > 0, 'schedule must be non-empty');
  assert.ok(typeof summary === 'object', 'summary must be an object');
  assert.ok('estimated_savings' in summary, 'summary must have estimated_savings');

  const VALID_ACTIONS = new Set(['charge_grid', 'charge_solar', 'discharge', 'sell', 'idle']);
  const capWh = battery.capacityKwh * 1000;
  const minWh = (battery.minSoc / 100) * capWh;
  const maxWh = (battery.maxSoc / 100) * capWh;

  for (const slot of schedule) {
    // Every slot has required fields
    assert.ok(typeof slot.slot_ts === 'string', `slot_ts must be a string (got ${slot.slot_ts})`);
    assert.ok(VALID_ACTIONS.has(slot.action), `unknown action "${slot.action}"`);
    assert.ok(typeof slot.watts === 'number' && slot.watts >= 0, `watts must be ≥ 0 (got ${slot.watts})`);

    // SOC bounds respected
    assert.ok(slot.soc_start >= battery.minSoc - 0.1,
      `soc_start ${slot.soc_start}% below min_soc ${battery.minSoc}%`);
    assert.ok(slot.soc_start <= battery.maxSoc + 0.1,
      `soc_start ${slot.soc_start}% above max_soc ${battery.maxSoc}%`);
    assert.ok(slot.soc_end >= battery.minSoc - 0.1,
      `soc_end ${slot.soc_end}% below min_soc ${battery.minSoc}%`);
    assert.ok(slot.soc_end <= battery.maxSoc + 0.1,
      `soc_end ${slot.soc_end}% above max_soc ${battery.maxSoc}%`);

    // Watts only present for active actions
    if (slot.action === 'idle') {
      assert.equal(slot.watts, 0, 'idle slot must have watts=0');
    }
  }
}

describe('optimizer-lp — output invariants (documented)', () => {
  it('assertOptimizerResult helper validates a well-formed synthetic result', () => {
    const syntheticResult = {
      schedule: [
        { slot_ts: '2026-04-12T00:00', action: 'charge_grid', watts: 3000, soc_start: 20, soc_end: 22, price_kwh: 0.5, solar_watts: 0, consumption_watts: 500 },
        { slot_ts: '2026-04-12T00:15', action: 'idle',        watts: 0,    soc_start: 22, soc_end: 22, price_kwh: 0.5, solar_watts: 0, consumption_watts: 500 },
        { slot_ts: '2026-04-12T00:30', action: 'discharge',   watts: 2000, soc_start: 80, soc_end: 78, price_kwh: 0.5, solar_watts: 0, consumption_watts: 500 },
      ],
      summary: { estimated_cost_without_battery: 10, estimated_cost_with_battery: 8, estimated_savings: 2 },
    };
    assert.doesNotThrow(() => assertOptimizerResult(syntheticResult, { capacityKwh: 15, minSoc: 10, maxSoc: 95 }));
  });

  it('assertOptimizerResult catches SOC below min_soc', () => {
    const bad = {
      schedule: [
        { slot_ts: '2026-04-12T00:00', action: 'idle', watts: 0, soc_start: 5, soc_end: 5, price_kwh: 0.5, solar_watts: 0, consumption_watts: 500 },
      ],
      summary: { estimated_savings: 0 },
    };
    assert.throws(() => assertOptimizerResult(bad, { capacityKwh: 15, minSoc: 10, maxSoc: 95 }),
      /soc_start.*below min_soc/);
  });

  it('assertOptimizerResult catches unknown action', () => {
    const bad = {
      schedule: [
        { slot_ts: '2026-04-12T00:00', action: 'levitate', watts: 0, soc_start: 50, soc_end: 50, price_kwh: 0.5, solar_watts: 0, consumption_watts: 500 },
      ],
      summary: { estimated_savings: 0 },
    };
    assert.throws(() => assertOptimizerResult(bad, { capacityKwh: 15, minSoc: 10, maxSoc: 95 }),
      /unknown action/);
  });
});
