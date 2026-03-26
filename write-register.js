/**
 * Write a single holding register via Modbus TCP.
 * Tries both function code 6 (write single) and function code 16 (write multiple)
 * so you can see which one the inverter accepts.
 *
 * Usage:
 *   node write-register.js <register> <value>
 *
 * Examples:
 *   node write-register.js 3309 43    # set peak shaving to 4.3 kW
 *   node write-register.js 3310 20    # set discharge floor to 20%
 */

import ModbusRTU from 'modbus-serial';
import config from './config.js';

const [,, regArg, valArg] = process.argv;

if (!regArg || !valArg) {
  console.error('Usage: node write-register.js <register> <value>');
  process.exit(1);
}

const register = parseInt(regArg, 10);
const value    = parseInt(valArg, 10);

if (isNaN(register) || isNaN(value)) {
  console.error('Both register and value must be integers.');
  process.exit(1);
}

const host   = config.inverter.host;
const port   = config.inverter.port ?? 502;
const unitId = config.inverter.unit_id ?? 1;

async function tryWrite(label, fn) {
  const client = new ModbusRTU();
  try {
    await client.connectTCP(host, { port });
    client.setID(unitId);
    client.setTimeout(5000);
    await fn(client);
    console.log(`  ✓ ${label} succeeded`);

    // Read back to confirm
    await new Promise(r => setTimeout(r, 500));
    const readback = await client.readHoldingRegisters(register, 1);
    console.log(`  readback: ${readback.data[0]}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${label} failed: ${err.message}`);
    return false;
  } finally {
    try { client.close(); } catch (_) {}
    await new Promise(r => setTimeout(r, 1000)); // pause between attempts
  }
}

console.log(`Writing value ${value} to holding register ${register} on ${host}:${port}\n`);

// FC6 — Write Single Register
const fc6ok = await tryWrite('FC6 (writeSingleRegister)', c => c.writeRegister(register, value));

// FC16 — Write Multiple Registers (what the app currently uses)
const fc16ok = await tryWrite('FC16 (writeRegisters)', c => c.writeRegisters(register, [value]));

if (!fc6ok && !fc16ok) {
  console.log('\nBoth function codes rejected — register may be read-only or unsupported.');
  process.exit(1);
} else {
  console.log(`\nWorking function code: ${fc6ok ? 'FC6' : 'FC16'}`);
}
