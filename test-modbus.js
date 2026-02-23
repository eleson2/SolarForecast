/**
 * Test script — read all known registers from MOD TL3-XH.
 *
 * Usage: node test-modbus.js
 */

import ModbusRTU from 'modbus-serial';
import config from './config.js';

const cfg = config.inverter;

async function main() {
  const client = new ModbusRTU();

  console.log(`Connecting to ${cfg.host}:${cfg.port}...\n`);
  await client.connectTCP(cfg.host, { port: cfg.port });
  client.setID(cfg.unit_id);
  client.setTimeout(cfg.timeout_ms || 5000);

  // --- SOC control registers (holding) ---
  console.log('=== SOC Control (holding registers) ===\n');
  await delay(1000);
  const socRegs = await client.readHoldingRegisters(3048, 1);
  await delay(1000);
  const discRegs = await client.readHoldingRegisters(3067, 1);
  await delay(1000);
  const peakRegs = await client.readHoldingRegisters(3310, 1);

  await delay(1000);
  const peakPower = await client.readHoldingRegisters(800, 2);

  console.log(`  ChargeStopSOC (3048):        ${socRegs.data[0]}%`);
  console.log(`  DischargingStopSOC (3067):   ${discRegs.data[0]}%`);
  console.log(`  LoadFirstStopSoc (3310):     ${peakRegs.data[0]}%`);
  console.log(`  Holding 800:                 ${peakPower.data[0]}  (×100W = ${peakPower.data[0] * 100}W, ×0.1kW = ${peakPower.data[0] / 10}kW)`);
  console.log(`  Holding 801:                 ${peakPower.data[1]}  (×100W = ${peakPower.data[1] * 100}W, ×0.1kW = ${peakPower.data[1] / 10}kW)`);

  // --- Battery state (BMS + holding 807) ---
  console.log('\n=== Battery State ===\n');
  await delay(1000);
  const bms = await client.readInputRegisters(3169, 3);
  await delay(1000);
  const socHold = await client.readHoldingRegisters(807, 1);

  const soc = bms.data[2];
  const currentA = signed16(bms.data[1]) / 10;

  console.log(`  BMS SOC (input 3171):        ${soc}%`);
  console.log(`  SOC mirror (holding 807):    ${socHold.data[0]}%`);
  console.log(`  Battery current (3170):      ${currentA} A (negative = charging)`);
  console.log(`  Battery voltage raw (3169):  ${bms.data[0]}`);

  // --- PV + AC output (Group 1) ---
  console.log('\n=== Inverter (Group 1) ===\n');
  await delay(1000);
  const g1 = await client.readInputRegisters(0, 53);
  const d = g1.data;

  console.log(`  Status:           ${d[0]} (0=waiting, 1=normal, 3=fault)`);
  console.log(`  Total PV:         ${u32(d, 1) / 10} W`);
  console.log(`  PV1:              ${u32(d, 5) / 10} W (${d[3] / 10}V, ${d[4] / 10}A)`);
  console.log(`  PV2:              ${u32(d, 9) / 10} W (${d[7] / 10}V, ${d[8] / 10}A)`);
  console.log(`  AC output:        ${u32(d, 35) / 10} W`);
  console.log(`  Grid frequency:   ${d[37] / 100} Hz`);
  console.log(`  Grid L1:          ${d[38] / 10}V, ${d[39] / 10}A`);
  console.log(`  Grid L3:          ${d[42] / 10}V, ${d[43] / 10}A`);

  // --- Energy counters ---
  console.log('\n=== Energy ===\n');
  await delay(1000);
  const g1b = await client.readInputRegisters(53, 4);
  console.log(`  Today:            ${u32(g1b.data, 0) / 10} kWh`);
  console.log(`  Total:            ${u32(g1b.data, 2) / 10} kWh`);

  client.close(() => {});
  console.log('\nDone.');
}

function u32(buf, offset) {
  return ((buf[offset] << 16) | buf[offset + 1]) >>> 0;
}

function signed16(val) {
  return val > 32767 ? val - 65536 : val;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
