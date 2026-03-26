/**
 * Read a single Modbus register from the Growatt datalogger.
 *
 * Usage:
 *   node read-register.js <register> [holding|input] [host] [port]
 *
 * Examples:
 *   node read-register.js 3309          # holding 3309 (peak shaving limit)
 *   node read-register.js 3171 input    # input 3171 (battery SOC)
 *   node read-register.js 800 holding 192.168.1.180 502
 *
 * Defaults: type=holding, host and port from config.js
 */

import ModbusRTU from 'modbus-serial';
import config from './config.js';

const [,, regArg, typeArg = 'holding', hostArg, portArg] = process.argv;

if (!regArg) {
  console.error('Usage: node read-register.js <register> [holding|input] [host] [port]');
  process.exit(1);
}

const register = parseInt(regArg, 10);
const type     = typeArg.toLowerCase();
const host     = hostArg ?? config.inverter.host;
const port     = portArg ? parseInt(portArg, 10) : (config.inverter.port ?? 502);
const unitId   = config.inverter.unit_id ?? 1;

if (isNaN(register)) {
  console.error(`Invalid register: ${regArg}`);
  process.exit(1);
}
if (type !== 'holding' && type !== 'input') {
  console.error(`Invalid type "${type}" — must be "holding" or "input"`);
  process.exit(1);
}

const client = new ModbusRTU();

try {
  console.log(`Connecting to ${host}:${port} (unit ${unitId}) …`);
  await client.connectTCP(host, { port });
  client.setID(unitId);
  client.setTimeout(5000);

  let result;
  if (type === 'holding') {
    result = await client.readHoldingRegisters(register, 1);
  } else {
    result = await client.readInputRegisters(register, 1);
  }

  const raw = result.data[0];
  // Print raw value plus common interpretations
  console.log(`\n${type} register ${register}:`);
  console.log(`  raw value : ${raw}`);
  console.log(`  ×0.1      : ${(raw * 0.1).toFixed(1)}`);
  console.log(`  ×0.01     : ${(raw * 0.01).toFixed(2)}`);
  // Signed 16-bit interpretation
  const signed = raw >= 0x8000 ? raw - 0x10000 : raw;
  if (signed !== raw) console.log(`  signed    : ${signed}  (×0.1 → ${(signed * 0.1).toFixed(1)})`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
} finally {
  try { client.close(); } catch (_) {}
}
