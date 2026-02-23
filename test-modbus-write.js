/**
 * Test script — write to a holding register and verify.
 *
 * Usage:
 *   node test-modbus-write.js <register> <value>
 *
 * Examples:
 *   node test-modbus-write.js 3067 10    # Set DischargingStopSOC to 10%
 *   node test-modbus-write.js 3048 95    # Set ChargeStopSOC to 95%
 *   node test-modbus-write.js 3310 44    # Set LoadFirstStopSoc (peak shaving) to 44%
 *
 * Known writable registers:
 *   3067  DischargingStopSOC    — absolute discharge floor (%)
 *   3048  ChargeStopSOC         — upper charge limit (%)
 *   3310  LoadFirstStopSocSet   — peak shaving reserve (%)
 */

import ModbusRTU from 'modbus-serial';
import config from './config.js';

const cfg = config.inverter;

const register = parseInt(process.argv[2]);
const value = parseInt(process.argv[3]);

if (isNaN(register) || isNaN(value)) {
  console.log('Usage: node test-modbus-write.js <register> <value>');
  console.log('');
  console.log('Known registers:');
  console.log('  3067  DischargingStopSOC  (absolute floor)');
  console.log('  3048  ChargeStopSOC       (upper charge limit)');
  console.log('  3310  LoadFirstStopSocSet (peak shaving reserve)');
  process.exit(1);
}

async function main() {
  const client = new ModbusRTU();

  console.log(`Connecting to ${cfg.host}:${cfg.port}...\n`);
  await client.connectTCP(cfg.host, { port: cfg.port });
  client.setID(cfg.unit_id);
  client.setTimeout(cfg.timeout_ms || 5000);

  // Read before
  const before = await client.readHoldingRegisters(register, 1);
  console.log(`BEFORE: Holding ${register} = ${before.data[0]}`);

  if (before.data[0] === value) {
    console.log(`\nAlready at ${value}, nothing to do.`);
    client.close(() => {});
    return;
  }

  // Write
  console.log(`\nWriting ${value} to holding ${register}...`);
  await delay(1000);
  await client.writeRegister(register, value);
  console.log('Write completed.');

  // Read after
  await delay(1000);
  const after = await client.readHoldingRegisters(register, 1);
  console.log(`\nAFTER:  Holding ${register} = ${after.data[0]}`);

  if (after.data[0] === value) {
    console.log('\nRegister updated. Check inverter panel to confirm it took effect.');
  } else {
    console.log(`\nWARNING — expected ${value}, got ${after.data[0]}.`);
  }

  client.close(() => {});
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
