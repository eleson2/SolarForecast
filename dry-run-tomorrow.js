/**
 * Dry-run simulation — show what the optimizer would do for tomorrow.
 *
 * Fetches electricity prices, reads solar forecast from DB, uses 2500W flat
 * consumption, reads live SOC from inverter, and prints a formatted table
 * with projected actions and what Modbus commands would be sent.
 *
 * Usage: node dry-run-tomorrow.js [--consumption 2500]
 */

import config from './config.js';
import { fetchPrices } from './src/price-fetcher.js';
import { runOptimizer } from './src/optimizer.js';
import { getDriver, getDriverConfig } from './src/inverter-dispatcher.js';

const args = process.argv.slice(2);
const consumptionIdx = args.indexOf('--consumption');
const CONSUMPTION_W = consumptionIdx >= 0
  ? parseInt(args[consumptionIdx + 1], 10)
  : 2500;

const ACTION_TO_SOC = {
  charge_grid:  config.inverter.charge_soc ?? 95,
  charge_solar: config.inverter.charge_soc ?? 95,
  discharge:    config.inverter.discharge_soc ?? 13,
  sell:         config.inverter.discharge_soc ?? 13,
  idle:         null, // "hold current SOC"
};

function localDate(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function localTs(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.location.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

async function main() {
  // 1. Fetch prices
  console.log('Fetching electricity prices...');
  const priceResult = await fetchPrices();
  console.log(`Prices: today=${priceResult.today} slots, tomorrow=${priceResult.tomorrow} slots`);

  if (priceResult.tomorrow === 0) {
    console.log('\nTomorrow\'s prices not available yet. Try again after 13:00 UTC.');
    process.exit(1);
  }

  // 2. Read live SOC from inverter
  const options = {};
  const driver = getDriver();
  if (driver) {
    try {
      const state = await driver.getState(getDriverConfig());
      options.startSoc = state.soc;
      console.log(`Live SOC from inverter: ${state.soc}%`);
    } catch (err) {
      console.log(`Could not read inverter SOC: ${err.message}`);
      console.log('Using conservative default (min_soc)');
    }
  }

  // 3. Build flat consumption array for tomorrow (24 hours)
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = localDate(tomorrow);

  const consumption = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0');
    consumption.push({
      hour_ts: `${tomorrowStr}T${hh}:00`,
      consumption_w: CONSUMPTION_W,
    });
  }

  // 4. Run optimizer for tomorrow 00:00 – next day 00:00
  const fromTs = `${tomorrowStr}T00:00`;
  const dayAfter = new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000);
  const toTs = `${localDate(dayAfter)}T00:00`;

  console.log(`\nRunning optimizer for ${fromTs} → ${toTs}`);
  console.log(`Consumption: ${CONSUMPTION_W}W flat\n`);

  const { schedule, summary } = runOptimizer(fromTs, toTs, consumption, options);

  if (!schedule || schedule.length === 0) {
    console.log('No schedule generated — check if price/solar data exists in DB.');
    process.exit(1);
  }

  // 5. Print formatted table
  console.log('');
  console.log('=' .repeat(110));
  console.log('  DRY-RUN SIMULATION — Battery Schedule for Tomorrow');
  console.log('='.repeat(110));
  console.log('');

  const header = [
    'Time'.padEnd(6),
    'Price'.padStart(7),
    'Solar'.padStart(7),
    'Cons'.padStart(6),
    'Net'.padStart(7),
    'Action'.padEnd(14),
    'Watts'.padStart(6),
    'SOC'.padStart(8),
    'Modbus Command'.padEnd(30),
  ].join(' | ');

  console.log(header);
  console.log('-'.repeat(110));

  let lastAction = null;
  let modbusCommands = [];

  for (const slot of schedule) {
    const time = slot.slot_ts.slice(11, 16);
    const price = (slot.price_kwh ?? 0).toFixed(2);
    const solar = Math.round(slot.solar_watts ?? 0);
    const cons = Math.round(slot.consumption_watts ?? 0);
    const net = Math.round((slot.solar_watts ?? 0) - (slot.consumption_watts ?? 0));
    const action = slot.action;
    const watts = Math.round(slot.watts ?? 0);
    const socStart = (slot.soc_start ?? 0).toFixed(1);
    const socEnd = (slot.soc_end ?? 0).toFixed(1);

    // Determine what Modbus command would be sent when action changes
    let modbusCmd = '';
    if (action !== lastAction) {
      const targetSoc = ACTION_TO_SOC[action];
      if (targetSoc != null) {
        modbusCmd = `write(3310, ${targetSoc})`;
        modbusCommands.push({
          time: slot.slot_ts,
          register: 3310,
          value: targetSoc,
          reason: action,
        });
      } else {
        // idle: hold at current SOC
        const holdSoc = Math.round(parseFloat(socStart));
        modbusCmd = `write(3310, ${holdSoc}) [hold]`;
        modbusCommands.push({
          time: slot.slot_ts,
          register: 3310,
          value: holdSoc,
          reason: `idle (hold at ${holdSoc}%)`,
        });
      }
      lastAction = action;
    }

    const row = [
      time.padEnd(6),
      (price + ' kr').padStart(7),
      (solar + 'W').padStart(7),
      (cons + 'W').padStart(6),
      ((net >= 0 ? '+' : '') + net + 'W').padStart(7),
      action.padEnd(14),
      (watts + 'W').padStart(6),
      `${socStart}→${socEnd}%`.padStart(8),
      modbusCmd.padEnd(30),
    ].join(' | ');

    console.log(row);
  }

  console.log('-'.repeat(110));

  // 6. Summary
  console.log('');
  console.log('=== COST SUMMARY ===');
  console.log(`  Without battery: ${summary.estimated_cost_without_battery.toFixed(2)} ${config.price.currency}`);
  console.log(`  With battery:    ${summary.estimated_cost_with_battery.toFixed(2)} ${config.price.currency}`);
  console.log(`  Savings:         ${summary.estimated_savings.toFixed(2)} ${config.price.currency}`);

  // 7. Modbus command summary
  console.log('');
  console.log('=== MODBUS COMMANDS (what would be sent) ===');
  console.log(`  Register: holding 3310 (LoadFirstStopSocSet — peak shaving reserve)`);
  console.log(`  Current config: charge_soc=${config.inverter.charge_soc}%, discharge_soc=${config.inverter.discharge_soc}%`);
  console.log('');

  for (const cmd of modbusCommands) {
    const time = cmd.time.slice(11, 16);
    console.log(`  ${time}  →  writeRegister(${cmd.register}, ${cmd.value})  // ${cmd.reason}`);
  }

  console.log(`\n  Total register writes: ${modbusCommands.length} (one per action change)`);

  // 8. Action breakdown
  const actionCounts = {};
  const actionMinutes = {};
  for (const s of schedule) {
    actionCounts[s.action] = (actionCounts[s.action] || 0) + 1;
    actionMinutes[s.action] = (actionMinutes[s.action] || 0) + 15;
  }

  console.log('');
  console.log('=== ACTION BREAKDOWN ===');
  for (const [action, count] of Object.entries(actionCounts)) {
    const hours = (actionMinutes[action] / 60).toFixed(1);
    console.log(`  ${action.padEnd(14)} ${count} slots (${hours}h)`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
