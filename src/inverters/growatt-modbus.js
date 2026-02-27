/**
 * Growatt MOD TL3-XH Modbus TCP driver.
 *
 * Reads telemetry and steers battery via local Modbus TCP instead of cloud API.
 * Uses SOC buffer control — writes a single register (LoadFirstStopSocSet)
 * rather than managing time segments.
 *
 * Same interface as growatt.js:
 *   getState(cfg), getMetrics(cfg), applySchedule(slots, cfg), resetToDefault(cfg)
 *
 * Register map (verified empirically — differs from Growatt protocol V1.24 doc):
 *   - LoadFirstStopSocSet: holding 3310 (confirmed as "reserved SOC for peak shaving"; 808 is a mirror)
 *   - Battery SOC:         input 3171 (BMS range; doc's input 3014 returns 0)
 *   - Battery current:     input 3170 (BMS, signed 0.1A; negative = charging)
 *   - PV power:            input 1-2 (Group 1, 0.1W, 32-bit) — works as documented
 *   - Grid frequency:      input 37 (0.01Hz) — works as documented
 *   - Grid voltage:        input 38 (0.1V) — works as documented
 *   - Storage 3000+ input registers for battery power/voltage return zeros on this datalogger
 */

import ModbusRTU from 'modbus-serial';

// --- Register addresses (empirically verified) ---

const REG = {
  // Holding registers (writable)
  LOAD_FIRST_STOP_SOC: 3310,    // Peak shaving reserve — battery stops discharging to load at this SOC
  PEAK_SHAVING_POWER:  800,     // Grid import power cap (0.1 kW/unit; value 45 = 4.5 kW)
  CHARGE_STOP_SOC:     3048,    // Upper limit — battery stops charging at this SOC
  DISCHARGE_STOP_SOC:  3067,    // Absolute floor — battery never goes below this SOC

  // Input registers — Group 1 (inverter)
  PV_POWER_H:          1,       // Total PV power high word (0.1W)
  PV_POWER_L:          2,       // Total PV power low word

  // Input registers — BMS (battery)
  BMS_VOLTAGE:         3169,    // Battery voltage
  BMS_CURRENT:         3170,    // Battery current (signed, 0.1A; negative = charging)
  BMS_SOC:             3171,    // State of charge (0–100%)

  // Input registers — daily energy totals (0.1 kWh, reset at midnight)
  // Read as 40-register block starting at 3045
  ENERGY_BLOCK_START:  3045,    // Start of energy block read
  ENERGY_BLOCK_COUNT:  40,      // Covers 3045–3084
  // Offsets within the block (reg - 3045):
  //   0/1  → 3045/3046: load power H/L (0.1W)
  //   4/5  → 3049/3050: AC gen today H/L (0.1 kWh)
  //  22/23 → 3067/3068: grid import today H/L (0.1 kWh)
  //  26/27 → 3071/3072: grid export today H/L (0.1 kWh)
  //  30/31 → 3075/3076: load energy today H/L (0.1 kWh)
  //  38/39 → 3083/3084: PV energy today H/L (0.1 kWh)
};

// --- Work mode lookup ---

// MOD TL3-XH system work modes (input register 0)
const WORK_MODES = {
  0: 'waiting',
  1: 'normal',
  3: 'fault',
  4: 'flash',
  5: 'pv_bat_online',      // normal: PV + battery, grid-tied
  6: 'bat_online',          // normal: battery only, grid-tied
  7: 'pv_offline',          // PV, off-grid/EPS
  8: 'bat_offline',         // battery, off-grid/EPS
};

// --- Action → SOC intent mapping ---

const ACTION_TO_SOC_INTENT = {
  charge_grid:  'charge',
  charge_solar: 'charge',
  discharge:    'discharge',
  sell:         'discharge',
  idle:         'idle',
};

// --- Connection management ---

const CONNECT_TIMEOUT_MS = 10_000;  // TCP handshake limit
const CMD_INTERVAL_MS    = 1_000;   // min gap between Modbus commands

let client = null;
let lastCmd = 0;

function timeout(ms, label) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
}

function destroyClient() {
  try { client?.close?.(); } catch (_) {}
  client = null;
}

async function getConnection(cfg) {
  if (client?.isOpen) return client;
  destroyClient();
  client = new ModbusRTU();
  try {
    await Promise.race([
      client.connectTCP(cfg.host, { port: cfg.port || 502 }),
      timeout(CONNECT_TIMEOUT_MS, `TCP connect to ${cfg.host}`),
    ]);
  } catch (err) {
    destroyClient();
    throw err;
  }
  client.setID(cfg.unit_id || 1);
  client.setTimeout(cfg.timeout_ms || 5000);
  return client;
}

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, CMD_INTERVAL_MS - (now - lastCmd));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCmd = Date.now();
}

// Wrap any driver call so a hung/failed read destroys the client,
// forcing a fresh TCP connection on the next invocation.
async function withReconnect(fn) {
  try {
    return await fn();
  } catch (err) {
    destroyClient();
    throw err;
  }
}

// --- Driver interface ---

/**
 * Read current battery state from inverter via Modbus TCP.
 * Uses BMS registers for SOC/current (storage group 3000+ returns zeros on this datalogger).
 * @param {object} cfg — inverter config from config.js
 * @returns {Promise<{ soc: number, power_w: number, mode: string }>}
 */
export async function getState(cfg) {
  return withReconnect(async () => {
  const conn = await getConnection(cfg);

  // Read inverter status (input reg 0)
  await throttle();
  const status = await conn.readInputRegisters(0, 1);
  const modeCode = status.data[0];
  const mode = WORK_MODES[modeCode] || `unknown(${modeCode})`;

  // Read BMS: voltage, current, SOC (input regs 3169–3171)
  await throttle();
  const bms = await conn.readInputRegisters(REG.BMS_VOLTAGE, 3);
  const soc = bms.data[2];                          // reg 3171
  const currentA = signed16(bms.data[1]) / 10;      // reg 3170, signed 0.1A
  const voltageRaw = bms.data[0];                    // reg 3169
  // Estimate power from voltage × current (sign: positive = discharging)
  const power_w = -(voltageRaw * currentA / 10);     // scale TBD, rough estimate

  return { soc, power_w, mode };
  }); // withReconnect
}

/**
 * Read extended telemetry from inverter via Modbus TCP.
 *
 * Sources:
 *   - Group 1 (input 0–52): PV power, AC output, grid voltage/current/frequency
 *   - BMS (input 3169–3171): battery SOC and current
 *   - Grid import: input 3021-3022 (storage range — one of the few that works)
 *
 * Note: most storage input registers (3009–3014, 3029–3038) return zeros or
 * garbage on this datalogger. Grid import (3021-3022) is the exception.
 *
 * @param {object} cfg — inverter config from config.js
 * @returns {Promise<{ soc: number, battery_w: number, grid_import_w: number, grid_export_w: number, solar_w: number, consumption_w: number }>}
 */
export async function getMetrics(cfg) {
  return withReconnect(async () => {
  const conn = await getConnection(cfg);

  // Read Group 1: PV power (input regs 0–10, only need regs 1-2)
  await throttle();
  const g1 = await conn.readInputRegisters(0, 11);
  const solar_w = u32(g1.data, 1) / 10;         // regs 1-2: total PV (0.1W)

  // Read BMS: voltage, current, SOC (input regs 3169–3171)
  await throttle();
  const bms = await conn.readInputRegisters(REG.BMS_VOLTAGE, 3);
  const soc = bms.data[2];                          // reg 3171
  const battCurrentA = signed16(bms.data[1]) / 10;  // reg 3170, negative = charging

  // Read energy block: load power + daily totals (input regs 3045–3084)
  await throttle();
  const eb = await conn.readInputRegisters(REG.ENERGY_BLOCK_START, REG.ENERGY_BLOCK_COUNT);

  // Instantaneous load power (regs 3045/3046, 0.1W) — verified working
  const consumption_w = u32(eb.data, 0) / 10;

  // Grid import from storage range (input regs 3021-3022 — verified working)
  await throttle();
  const gridData = await conn.readInputRegisters(3021, 2);
  const grid_import_w = u32(gridData.data, 0) / 10;

  // Battery power derived from energy balance
  const battery_w = Math.max(0, consumption_w) - solar_w - grid_import_w;

  // Grid export: not directly readable, derive from balance
  const grid_export_w = Math.max(0, solar_w - consumption_w - Math.max(0, -battery_w));

  // Daily energy totals (0.1 kWh scale)
  const pv_today_kwh          = u32(eb.data, 38) / 10;  // regs 3083/3084
  const load_today_kwh        = u32(eb.data, 30) / 10;  // regs 3075/3076
  const grid_import_today_kwh = u32(eb.data, 22) / 10;  // regs 3067/3068
  const grid_export_today_kwh = u32(eb.data, 26) / 10;  // regs 3071/3072

  return {
    soc, battery_w, grid_import_w, grid_export_w, solar_w, consumption_w,
    pv_today_kwh, load_today_kwh, grid_import_today_kwh, grid_export_today_kwh,
  };
  }); // withReconnect
}

/**
 * Read only the daily cumulative energy totals (no BMS, no grid import).
 * Lightweight — used by snapshotPipeline every 15 min.
 * @returns {Promise<{ pv_today_kwh, load_today_kwh, grid_import_today_kwh, grid_export_today_kwh }>}
 */
export async function getEnergyTotals(cfg) {
  return withReconnect(async () => {
  const conn = await getConnection(cfg);
  await throttle();
  const eb = await conn.readInputRegisters(REG.ENERGY_BLOCK_START, REG.ENERGY_BLOCK_COUNT);
  return {
    pv_today_kwh:          u32(eb.data, 38) / 10,  // regs 3083/3084
    load_today_kwh:        u32(eb.data, 30) / 10,  // regs 3075/3076
    grid_import_today_kwh: u32(eb.data, 22) / 10,  // regs 3067/3068
    grid_export_today_kwh: u32(eb.data, 26) / 10,  // regs 3071/3072
  };
  }); // withReconnect
}

/**
 * Translate optimizer schedule to a single SOC buffer register write.
 *
 * Finds the current slot, maps its action to a target SOC value, and writes
 * holding register 808 (LoadFirstStopSocSet).
 *
 * @param {Array<{ slot_ts: string, action: string }>} slots
 * @param {object} cfg — inverter config
 * @returns {Promise<{ applied: number, skipped: number }>}
 */
export async function applySchedule(slots, cfg) {
  if (!slots.length) return { applied: 0, skipped: 0 };

  // Find current slot (latest slot whose timestamp is <= now)
  const now = new Date().toISOString().slice(0, 16);
  const currentSlot = [...slots]
    .filter(s => s.slot_ts <= now)
    .sort((a, b) => b.slot_ts.localeCompare(a.slot_ts))[0]
    ?? slots[0]; // fallback to first

  const intent = ACTION_TO_SOC_INTENT[currentSlot.action] ?? 'idle';
  let targetSoc;

  if (intent === 'charge') {
    targetSoc = cfg.charge_soc ?? 90;
  } else if (intent === 'discharge') {
    targetSoc = cfg.discharge_soc ?? 20;
  } else {
    // idle: read current SOC and hold there
    const state = await getState(cfg);
    targetSoc = state.soc;
  }

  targetSoc = Math.max(13, Math.min(100, targetSoc));

  if (cfg.dry_run) {
    console.log(`[growatt-modbus] DRY-RUN: would set LoadFirstStopSoc=${targetSoc}% (action=${currentSlot.action})`);
    return { applied: 1, skipped: 0 };
  }

  return withReconnect(async () => {
    const conn = await getConnection(cfg);
    await throttle();
    await conn.writeRegister(REG.LOAD_FIRST_STOP_SOC, targetSoc);
    console.log(`[growatt-modbus] Set LoadFirstStopSoc=${targetSoc}% (action=${currentSlot.action})`);
    return { applied: 1, skipped: 0 };
  });
}

// --- Direct control primitives ---
// All three read current SOC first (for logging / idle hold value), then write
// holding register 3310 (LoadFirstStopSocSet) to steer the battery.

/**
 * Force battery to charge: set discharge floor to charge_soc (default 90%).
 * The inverter must keep SOC ≥ floor, so it draws from grid/PV to fill the battery.
 * @param {object} cfg — inverter config
 * @returns {Promise<{ soc: number, target: number }>}
 */
export async function charge(cfg) {
  const state = await getState(cfg);
  const target = cfg.charge_soc ?? 90;
  console.log(`[growatt-modbus] charge: SOC=${state.soc}% → setting LoadFirstStopSoc=${target}%`);
  if (cfg.dry_run) {
    console.log(`[growatt-modbus] DRY-RUN: would set LoadFirstStopSoc=${target}%`);
    return { soc: state.soc, target };
  }
  return withReconnect(async () => {
    const conn = await getConnection(cfg);
    await throttle();
    await conn.writeRegister(REG.LOAD_FIRST_STOP_SOC, target);
    return { soc: state.soc, target };
  });
}

/**
 * Allow battery to discharge: set discharge floor to discharge_soc (default 20%).
 * The inverter serves loads from the battery down to the floor.
 * @param {object} cfg — inverter config
 * @returns {Promise<{ soc: number, target: number }>}
 */
export async function discharge(cfg) {
  const state = await getState(cfg);
  const target = cfg.discharge_soc ?? 20;
  console.log(`[growatt-modbus] discharge: SOC=${state.soc}% → setting LoadFirstStopSoc=${target}%`);
  if (cfg.dry_run) {
    console.log(`[growatt-modbus] DRY-RUN: would set LoadFirstStopSoc=${target}%`);
    return { soc: state.soc, target };
  }
  return withReconnect(async () => {
    const conn = await getConnection(cfg);
    await throttle();
    await conn.writeRegister(REG.LOAD_FIRST_STOP_SOC, target);
    return { soc: state.soc, target };
  });
}

/**
 * Hold battery at current SOC: set discharge floor = current SOC.
 * The battery can neither charge above nor discharge below its present level.
 * @param {object} cfg — inverter config
 * @returns {Promise<{ soc: number, target: number }>}
 */
export async function idle(cfg) {
  const state = await getState(cfg);
  const target = state.soc;
  console.log(`[growatt-modbus] idle: SOC=${state.soc}% → setting LoadFirstStopSoc=${target}% (hold)`);
  if (cfg.dry_run) {
    console.log(`[growatt-modbus] DRY-RUN: would set LoadFirstStopSoc=${target}%`);
    return { soc: state.soc, target };
  }
  return withReconnect(async () => {
    const conn = await getConnection(cfg);
    await throttle();
    await conn.writeRegister(REG.LOAD_FIRST_STOP_SOC, target);
    return { soc: state.soc, target };
  });
}

/**
 * Set the grid import power cap (peak shaving limit).
 * Writes holding register 800 (PeakShavingPower), scale 0.1 kW.
 * Example: targetKw=4.5 → register value 45.
 * @param {number} targetKw — desired import limit in kW
 * @param {object} cfg — inverter config
 * @returns {Promise<{ target_kw: number, reg_value: number }>}
 */
export async function setPeakShavingTarget(targetKw, cfg) {
  const regValue = Math.round(targetKw * 10);
  console.log(`[growatt-modbus] setPeakShavingTarget: ${targetKw} kW → reg 800 = ${regValue}`);
  if (cfg.dry_run) {
    console.log(`[growatt-modbus] DRY-RUN: would set PeakShavingPower=${regValue} (${targetKw} kW)`);
    return { target_kw: targetKw, reg_value: regValue };
  }
  return withReconnect(async () => {
    const conn = await getConnection(cfg);
    await throttle();
    await conn.writeRegister(REG.PEAK_SHAVING_POWER, regValue);
    console.log(`[growatt-modbus] Set PeakShavingPower=${regValue} (${targetKw} kW)`);
    return { target_kw: targetKw, reg_value: regValue };
  });
}

/**
 * Reset SOC floor back to a safe default (min_soc from config).
 * @param {object} cfg — inverter config
 */
export async function resetToDefault(cfg) {
  const defaultSoc = cfg.discharge_soc ?? 13;
  if (cfg.dry_run) {
    console.log(`[growatt-modbus] DRY-RUN: would reset LoadFirstStopSoc=${defaultSoc}%`);
    return;
  }
  return withReconnect(async () => {
    const conn = await getConnection(cfg);
    await throttle();
    await conn.writeRegister(REG.LOAD_FIRST_STOP_SOC, defaultSoc);
    console.log(`[growatt-modbus] Reset LoadFirstStopSoc=${defaultSoc}%`);
  });
}

// --- Helpers ---

function u32(buf, offset) {
  return ((buf[offset] << 16) | buf[offset + 1]) >>> 0;
}

function signed16(val) {
  return val > 32767 ? val - 65536 : val;
}
