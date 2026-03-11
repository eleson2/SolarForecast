/**
 * run-compare-optimizers.js
 *
 * Side-by-side comparison of the greedy and LP battery optimizers.
 * Greedy schedule is written to DB as normal; LP runs in dry_run mode (no DB write).
 *
 * Usage:
 *   node run-compare-optimizers.js
 */

import config from './config.js';
import { fetchPrices }        from './src/price-fetcher.js';
import { estimateConsumption } from './src/consumption.js';
import { runOptimizer as runGreedy } from './src/optimizer.js';
import { runOptimizer as runLP     } from './src/optimizer-lp.js';

// ── Timestamp helper ──────────────────────────────────────────────────────────

function localTs(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// ── Display helpers ───────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const YELLOW = '\x1b[33m';
const GREEN  = '\x1b[32m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function pad(s, n) { return String(s ?? '').padEnd(n); }
function rpad(s, n) { return String(s ?? '').padStart(n); }

function actionLabel(action, watts) {
  if (!action || action === 'idle') return pad('idle', 14);
  const w = watts ? ` ${Math.round(watts)}W` : '';
  return pad(`${action}${w}`, 14);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`${BOLD}=== Battery Optimizer Comparison: Greedy vs LP ===${RESET}\n`);

  // CLI: --soc N  overrides live inverter read
  const args = process.argv.slice(2);
  const socArg = args.includes('--soc') ? Number(args[args.indexOf('--soc') + 1]) : null;

  // 1. Shared inputs
  console.log('Fetching prices...');
  const priceResult = await fetchPrices();
  console.log(`Prices: today=${priceResult.today} slots, tomorrow=${priceResult.tomorrow} slots\n`);

  console.log('Estimating consumption...');
  const consumption = await estimateConsumption();

  const options = {};
  if (socArg != null && !isNaN(socArg)) {
    options.startSoc = socArg;
    console.log(`Using --soc override: ${socArg}%\n`);
  } else {
    console.log(`No --soc provided — optimizers will use conservative default (${config.battery.min_soc}%)\n`);
  }

  const now = new Date();
  const snap = new Date(now);
  snap.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
  const fromTs = localTs(snap);
  const toTs   = localTs(new Date(snap.getTime() + 24 * 60 * 60 * 1000));

  // 2. Run both optimizers
  console.log(`${BOLD}─── Greedy ─────────────────────────────────────────────────${RESET}`);
  const { schedule: sg, summary: sumG } = runGreedy(fromTs, toTs, consumption, options);

  console.log(`\n${BOLD}─── LP ─────────────────────────────────────────────────────${RESET}`);
  const { schedule: sl, summary: sumL } = await runLP(fromTs, toTs, consumption,
    { ...options, dry_run: true });

  if (!sg.length && !sl.length) {
    console.log('\nNo schedules produced — check price data.');
    return;
  }

  // 3. Side-by-side slot comparison
  console.log(`\n${BOLD}─── Slot-by-slot comparison ─────────────────────────────────${RESET}`);
  console.log(
    pad('Time',  6),
    pad('Price', 7),
    pad('── Greedy ──────────────', 26),
    pad('── LP ──────────────────', 26),
    'Diff?'
  );
  console.log('─'.repeat(80));

  const slotMap = new Map(sl.map(s => [s.slot_ts, s]));
  let diffCount = 0;

  for (const g of sg) {
    const l        = slotMap.get(g.slot_ts);
    const isDiff   = l && (g.action !== l.action || Math.abs(g.watts - l.watts) > 50);
    const prefix   = isDiff ? YELLOW : (g.action === 'idle' ? DIM : '');
    const diffMark = isDiff ? `${YELLOW}◀ DIFF${RESET}` : '';
    if (isDiff) diffCount++;

    // Skip idle-on-both rows unless it's an hour boundary, to reduce clutter
    if (!isDiff && g.action === 'idle' && l?.action === 'idle' && !g.slot_ts.endsWith(':00')) continue;

    const gSoc = `${g.soc_start}%→${g.soc_end}%`;
    const lSoc = l ? `${l.soc_start}%→${l.soc_end}%` : '—';

    console.log(
      `${prefix}${g.slot_ts.slice(11, 16)}${RESET}`,
      rpad((g.price_kwh ?? 0).toFixed(3), 6),
      `${prefix}${pad(actionLabel(g.action, g.watts), 18)}${rpad(gSoc, 12)}${RESET}`,
      `${prefix}${pad(l ? actionLabel(l.action, l.watts) : 'no data', 18)}${rpad(lSoc, 12)}${RESET}`,
      diffMark
    );
  }

  console.log('─'.repeat(80));
  console.log(`${diffCount} slot(s) differ between greedy and LP\n`);

  // 4. Savings summary
  console.log(`${BOLD}─── Savings summary ─────────────────────────────────────────${RESET}`);
  const cur = config.price.currency;

  const fmtRow = (label, gVal, lVal) => {
    const diff  = lVal - gVal;
    const mark  = diff > 0.01 ? `${GREEN}+${diff.toFixed(2)} LP wins${RESET}`
                : diff < -0.01 ? `${YELLOW}${diff.toFixed(2)} Greedy wins${RESET}`
                : `${DIM}≈ equal${RESET}`;
    console.log(`  ${pad(label, 32)} Greedy: ${rpad(gVal?.toFixed(2), 8)} ${cur}   LP: ${rpad(lVal?.toFixed(2), 8)} ${cur}   ${mark}`);
  };

  if (sumG && sumL) {
    fmtRow('Cost without battery',   sumG.estimated_cost_without_battery, sumL.estimated_cost_without_battery);
    fmtRow('Cost with battery',      sumG.estimated_cost_with_battery,    sumL.estimated_cost_with_battery);
    fmtRow('Estimated savings',      sumG.estimated_savings,              sumL.estimated_savings);

    const advantage = sumL.estimated_savings - sumG.estimated_savings;
    console.log();
    if (advantage > 0.05) {
      console.log(`${BOLD}${GREEN}LP saves ${advantage.toFixed(2)} ${cur} more than greedy (${((advantage / sumG.estimated_savings) * 100).toFixed(0)}% improvement)${RESET}`);
    } else if (advantage < -0.05) {
      console.log(`${BOLD}${YELLOW}Greedy saves ${(-advantage).toFixed(2)} ${cur} more than LP${RESET}`);
    } else {
      console.log(`${CYAN}Both optimizers produce equivalent savings.${RESET}`);
    }
  } else {
    console.log('  (one or both optimizers returned no summary)');
  }

  // 5. Grid charge comparison
  const gChargeKwh = sg.filter(s => s.action === 'charge_grid')
    .reduce((t, s) => t + s.watts * 0.25 / 1000, 0);
  const lChargeKwh = sl.filter(s => s.action === 'charge_grid')
    .reduce((t, s) => t + s.watts * 0.25 / 1000, 0);
  const gDisKwh = sg.filter(s => s.action === 'discharge')
    .reduce((t, s) => t + s.watts * 0.25 / 1000, 0);
  const lDisKwh = sl.filter(s => s.action === 'discharge')
    .reduce((t, s) => t + s.watts * 0.25 / 1000, 0);

  console.log(`\n  Grid charged:  Greedy ${gChargeKwh.toFixed(1)} kWh   LP ${lChargeKwh.toFixed(1)} kWh`);
  console.log(`  Discharged:    Greedy ${gDisKwh.toFixed(1)} kWh   LP ${lDisKwh.toFixed(1)} kWh`);

  const firstGCharge = sg.find(s => s.action === 'charge_grid');
  const firstLCharge = sl.find(s => s.action === 'charge_grid');
  console.log(`  First charge slot: Greedy ${firstGCharge?.slot_ts.slice(11, 16) ?? '—'}   LP ${firstLCharge?.slot_ts.slice(11, 16) ?? '—'}`);
  console.log();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
