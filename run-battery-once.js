import fs from 'fs';
import config from './config.js';
import { fetchPrices } from './src/price-fetcher.js';
import { estimateConsumption } from './src/consumption.js';
import { runOptimizer } from './src/optimizer.js';
import { getDriver, getDriverConfig } from './src/inverter-dispatcher.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const pushToInverter = args.includes('--push') || dryRun;

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
  console.log('Fetching electricity prices...');
  const priceResult = await fetchPrices();
  console.log(`Prices: today=${priceResult.today} slots, tomorrow=${priceResult.tomorrow} slots`);

  console.log('Estimating consumption...');
  const consumption = await estimateConsumption();

  // Read live SOC from inverter if available
  const options = {};
  const driver = getDriver();
  if (driver) {
    try {
      const state = await driver.getState(getDriverConfig());
      options.startSoc = state.soc;
      console.log(`Live SOC from inverter: ${state.soc}%`);
    } catch (err) {
      console.log(`Could not read inverter SOC: ${err.message}`);
    }
  }

  console.log('Running optimizer...');
  const now = new Date();
  const currentSlot = new Date(now);
  currentSlot.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
  const endSlot = new Date(currentSlot.getTime() + 24 * 60 * 60 * 1000);

  const fromTs = localTs(currentSlot);
  const toTs = localTs(endSlot);

  const { schedule, summary } = runOptimizer(fromTs, toTs, consumption, options);

  const output = {
    generated_at: now.toISOString(),
    timezone: config.location.timezone,
    from: fromTs,
    to: toTs,
    schedule,
    summary,
  };

  fs.writeFileSync('data/battery-schedule.json', JSON.stringify(output, null, 2));
  console.log(`Schedule written to data/battery-schedule.json (${schedule.length} slots)`);

  // --- Inverter push ---
  if (pushToInverter) {
    const driver = getDriver();
    if (!driver) {
      console.log('No inverter configured — skipping push');
      return;
    }

    const cfg = { ...getDriverConfig(), dry_run: dryRun };
    console.log(`\n${dryRun ? 'DRY-RUN' : 'PUSHING'} schedule to inverter (${config.inverter.brand})...`);

    // Filter to future slots
    const nowTs = localTs(now);
    const futureSlots = schedule.filter(s => s.slot_ts >= nowTs);

    const result = await driver.applySchedule(futureSlots, cfg);
    console.log(`Inverter: ${result.applied} segments applied, ${result.skipped} skipped`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
