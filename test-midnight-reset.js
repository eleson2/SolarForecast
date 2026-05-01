/**
 * Tests for the midnight-reset zero-consumption artefact fix in scheduler.js.
 *
 * The fix is pure branch logic — no DB or inverter needed. This file replicates
 * the exact branch from consumptionPipeline and verifies both the artefact path
 * (near-zero delta → flat_watts substitution) and the normal reset path (real
 * energy accumulated since midnight → use it as-is).
 */

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

/**
 * Replicated logic from consumptionPipeline (scheduler.js).
 * Returns { consumption_w, consumptionSource }.
 */
function applyMidnightResetLogic(snapNow, snapPrev) {
  const midnightReset = snapNow.load_today_kwh < snapPrev.load_today_kwh;
  const deltaLoad = midnightReset
    ? snapNow.load_today_kwh           // counter reset — value since midnight
    : snapNow.load_today_kwh - snapPrev.load_today_kwh;

  let totalW = deltaLoad * 1000;
  let consumptionSource = 'inverter_delta';

  if (midnightReset && totalW < config.consumption.flat_watts * 0.2) {
    totalW = config.consumption.flat_watts;
    consumptionSource = 'flat_fallback';
  }

  return { consumption_w: totalW, consumptionSource };
}

// ── Test 1: artefact — first snapshot taken seconds after midnight (near-zero) ─
console.log('\n=== 1: midnight-reset near-zero delta → flat_watts substitution ===');
{
  // snapPrev: 23:00 yesterday, counter at 12.5 kWh for the day
  // snapNow:  00:00 today,     counter just reset — only 0.008 kWh (≈ 5 min) accumulated
  const snapPrev = { load_today_kwh: 12.5 };
  const snapNow  = { load_today_kwh: 0.008 };

  const { consumption_w, consumptionSource } = applyMidnightResetLogic(snapNow, snapPrev);

  assert(consumptionSource === 'flat_fallback',
    `source is 'flat_fallback' (got '${consumptionSource}')`);
  assert(consumption_w === config.consumption.flat_watts,
    `consumption_w equals flat_watts ${config.consumption.flat_watts} W (got ${consumption_w} W)`);
}

// ── Test 2: valid reset — real energy accumulated since midnight (> threshold) ─
console.log('\n=== 2: midnight-reset with real energy → use actual delta ===');
{
  // snapPrev: 23:00 yesterday, counter at 14.2 kWh
  // snapNow:  00:00 today,     counter shows 0.85 kWh (34 min of typical load)
  const snapPrev = { load_today_kwh: 14.2 };
  const snapNow  = { load_today_kwh: 0.85 };

  const expectedW = 0.85 * 1000; // 850 W
  const { consumption_w, consumptionSource } = applyMidnightResetLogic(snapNow, snapPrev);

  assert(consumptionSource === 'inverter_delta',
    `source is 'inverter_delta' (got '${consumptionSource}')`);
  assert(Math.abs(consumption_w - expectedW) < 1,
    `consumption_w is ${expectedW} W (got ${consumption_w} W)`);
}

// ── Test 3: normal (no reset) — counter continues rising ─────────────────────
console.log('\n=== 3: no midnight reset — normal hourly delta ===');
{
  // snapPrev: 14:00, counter at 8.3 kWh
  // snapNow:  15:00, counter at 9.1 kWh  → delta = 0.8 kWh = 800 W
  const snapPrev = { load_today_kwh: 8.3 };
  const snapNow  = { load_today_kwh: 9.1 };

  const expectedW = (9.1 - 8.3) * 1000; // 800 W
  const { consumption_w, consumptionSource } = applyMidnightResetLogic(snapNow, snapPrev);

  assert(consumptionSource === 'inverter_delta',
    `source is 'inverter_delta' (got '${consumptionSource}')`);
  assert(Math.abs(consumption_w - expectedW) < 1,
    `consumption_w is ${expectedW} W (got ${consumption_w} W)`);
}

// ── Test 4: boundary — delta exactly at the substitution threshold ────────────
console.log('\n=== 4: delta at substitution boundary (flat_watts × 0.2) ===');
{
  // Threshold = flat_watts * 0.2 = 800 * 0.2 = 160 W = 0.16 kWh
  // delta = 0.16 kWh exactly — should NOT substitute (condition is strictly <)
  const threshold = config.consumption.flat_watts * 0.2 / 1000; // kWh
  const snapPrev = { load_today_kwh: 12.0 };
  const snapNow  = { load_today_kwh: threshold }; // exactly at boundary

  const { consumption_w, consumptionSource } = applyMidnightResetLogic(snapNow, snapPrev);

  assert(consumptionSource === 'inverter_delta',
    `source is 'inverter_delta' at exact boundary (got '${consumptionSource}')`);
  assert(Math.abs(consumption_w - threshold * 1000) < 1,
    `consumption_w is ${threshold * 1000} W at boundary (got ${consumption_w} W)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-hourly EV detection tests
// Replicates the chain-walk from consumptionPipeline (scheduler.js).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a snapshot object (only fields used by the walk logic).
 * snapshot_ts as ISO string (minute precision), load_today_kwh as cumulative counter.
 */
function snap(ts, loadKwh) {
  return { snapshot_ts: ts, load_today_kwh: loadKwh };
}

/**
 * Replicated chain-walk EV detection from consumptionPipeline.
 * Returns { consumption_w, consumptionSource, evDetected, evSlots }.
 */
function walkChain(chain, maxHouseW, evChargeW) {
  let houseEnergyKwh = 0;
  let evDetected     = false;
  let evSlots        = 0;

  for (let i = 1; i < chain.length; i++) {
    const s0 = chain[i - 1];
    const s1 = chain[i];
    const slotMin = (new Date(s1.snapshot_ts) - new Date(s0.snapshot_ts)) / 60000;
    if (slotMin <= 0) continue;

    const slotKwh = (s1.load_today_kwh ?? 0) >= (s0.load_today_kwh ?? 0)
      ? (s1.load_today_kwh ?? 0) - (s0.load_today_kwh ?? 0)
      : (s1.load_today_kwh ?? 0);
    if (slotKwh <= 0) { continue; }

    const slotW = slotKwh / slotMin * 60 * 1000;

    if (slotW > maxHouseW) {
      const houseSlotW   = Math.max(100, slotW - evChargeW);
      const houseSlotKwh = houseSlotW / 1000 * slotMin / 60;
      houseEnergyKwh += houseSlotKwh;
      evDetected = true;
      evSlots++;
    } else {
      houseEnergyKwh += slotKwh;
    }
  }

  const spanMin = (new Date(chain[chain.length - 1].snapshot_ts) - new Date(chain[0].snapshot_ts)) / 60000;
  const consumption_w = Math.round(houseEnergyKwh / spanMin * 60 * 1000);
  const consumptionSource = evDetected ? 'inverter_delta_ev' : 'inverter_delta';
  return { consumption_w, consumptionSource, evDetected, evSlots };
}

const MAX_HOUSE_W  = 5000;
const EV_CHARGE_W  = 5300;

// ── Test 5: EV active in every slot (classic case) ────────────────────────────
console.log('\n=== 5: EV detected in all sub-hourly slots ===');
{
  // Three 15-min slots, each drawing ~10 300 W (house 5000 + EV 5300)
  // load increments = 10300 W × 0.25 h / 1000 = 0.2575 kWh each
  const inc = (MAX_HOUSE_W + EV_CHARGE_W) * 0.25 / 1000; // ≈ 0.2575 kWh
  const chain = [
    snap('2026-05-01T16:00', 8.0),
    snap('2026-05-01T16:15', 8.0 + inc),
    snap('2026-05-01T16:30', 8.0 + inc * 2),
    snap('2026-05-01T16:45', 8.0 + inc * 3),
  ];

  const { consumption_w, consumptionSource, evDetected, evSlots } = walkChain(chain, MAX_HOUSE_W, EV_CHARGE_W);

  assert(evDetected, `EV detected (got ${evDetected})`);
  assert(evSlots === 3, `evSlots = 3 (got ${evSlots})`);
  assert(consumptionSource === 'inverter_delta_ev', `source 'inverter_delta_ev' (got '${consumptionSource}')`);
  // house-only = 100 W (max(100, 10300 - 5300) = 5000 W per slot)
  const expectedW = 5000;
  assert(Math.abs(consumption_w - expectedW) < 5,
    `house-only ~${expectedW} W (got ${consumption_w} W)`);
}

// ── Test 6: EV in only one of three slots (missed by hourly average) ──────────
console.log('\n=== 6: EV in 1 of 3 slots — missed by hourly average but caught per-slot ===');
{
  // Three 15-min slots:
  //   Slot 1: house-only 1000 W → +0.25 kWh
  //   Slot 2: EV + house 10300 W → +2.575 kWh
  //   Slot 3: house-only 1000 W → +0.25 kWh
  // Hourly average W = 3.075 kWh / 45 min × 60 × 1000 = 4100 W → BELOW max_house_w (5000)
  // Sub-hourly detects EV in slot 2 and strips it correctly.
  const houseIncKwh = 1000 * 15 / 60 / 1000;  // 0.25 kWh per house slot
  const evIncKwh    = (MAX_HOUSE_W + EV_CHARGE_W) * 15 / 60 / 1000; // 2.575 kWh for EV slot
  const load0 = 5.0;
  const load1 = load0 + houseIncKwh;            // 5.25
  const load2 = load1 + evIncKwh;               // 7.825
  const load3 = load2 + houseIncKwh;            // 8.075

  const chain = [
    snap('2026-05-01T14:00', load0),
    snap('2026-05-01T14:15', load1),
    snap('2026-05-01T14:30', load2),
    snap('2026-05-01T14:45', load3),
  ];

  const { consumption_w, consumptionSource, evDetected, evSlots } = walkChain(chain, MAX_HOUSE_W, EV_CHARGE_W);

  assert(evDetected, `EV detected (got ${evDetected})`);
  assert(evSlots === 1, `evSlots = 1 (got ${evSlots})`);
  // house energy:
  //   slot 1: 0.25 kWh
  //   slot 2 (EV): houseSlotW = max(100, 10300 - 5300) = 5000 W → 5000/1000 * 15/60 = 1.25 kWh
  //   slot 3: 0.25 kWh
  //   total = 1.75 kWh over 45 min → 1.75/45×60×1000 = 2333 W
  const expectedW = Math.round(1.75 / 45 * 60 * 1000); // 2333 W
  assert(Math.abs(consumption_w - expectedW) <= 5,
    `house-only ~${expectedW} W (got ${consumption_w} W)`);
}

// ── Test 7: boundary-offset — snapPrev 15 min before prevHourTs ───────────────
console.log('\n=== 7: boundary-offset span (75-min chain) normalised correctly ===');
{
  // snapPrev captured at 12:45 (15 min before 13:00 hour boundary).
  // Three 15-min slots follow: 13:00, 13:15, 13:30 (representing the 13:00 hour).
  // All slots are house-only 1000 W. Without normalisation, a 75-min delta
  // of 1.25 kWh / 60 min would show 1250 W — incorrect. With 75-min span
  // normalisation it should return ~1000 W.
  const inc = 1000 * 15 / 60 / 1000; // 0.25 kWh per 15-min slot at 1000 W
  const chain = [
    snap('2026-05-01T12:45', 10.0),
    snap('2026-05-01T13:00', 10.0 + inc),
    snap('2026-05-01T13:15', 10.0 + inc * 2),
    snap('2026-05-01T13:30', 10.0 + inc * 3),
  ];

  const { consumption_w, consumptionSource, evDetected } = walkChain(chain, MAX_HOUSE_W, EV_CHARGE_W);

  assert(!evDetected, `no EV (got ${evDetected})`);
  assert(consumptionSource === 'inverter_delta', `source 'inverter_delta' (got '${consumptionSource}')`);
  // span = 45 min, energy = 3 × 0.25 = 0.75 kWh → 0.75 / 45 × 60 × 1000 = 1000 W
  assert(Math.abs(consumption_w - 1000) < 5,
    `normalised ~1000 W over 45-min span (got ${consumption_w} W)`);
}

// ── Test 8: no EV — all slots below threshold ─────────────────────────────────
console.log('\n=== 8: no EV charging — all slots below max_house_w ===');
{
  const chain = [
    snap('2026-05-01T10:00', 3.0),
    snap('2026-05-01T10:15', 3.0 + 800 * 0.25 / 1000),  // 800 W
    snap('2026-05-01T10:30', 3.2 + 800 * 0.25 / 1000),
    snap('2026-05-01T10:45', 3.4 + 800 * 0.25 / 1000),
  ];

  const { consumption_w, consumptionSource, evDetected } = walkChain(chain, MAX_HOUSE_W, EV_CHARGE_W);

  assert(!evDetected, `no EV (got ${evDetected})`);
  assert(consumptionSource === 'inverter_delta', `source 'inverter_delta' (got '${consumptionSource}')`);
  assert(Math.abs(consumption_w - 800) < 5,
    `~800 W (got ${consumption_w} W)`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
