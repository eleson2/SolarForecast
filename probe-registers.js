/**
 * probe-registers.js
 *
 * Empirically tests which Modbus input registers return non-zero values
 * on the Growatt MOD TL3-XH datalogger.
 *
 * Targets registers relevant to PV production and load/consumption:
 *   - Group 1 (0–52):   PV power, AC output, grid voltage/freq
 *   - Storage (3000+):  energy totals, load, grid import/export
 *   - BMS (3169–3171):  battery SOC, current, voltage
 *
 * Usage:
 *   node probe-registers.js            # probe all target ranges
 *   node probe-registers.js --raw      # also dump raw hex values
 *   node probe-registers.js --range 3040 3090   # probe a custom range
 */

import ModbusRTU from 'modbus-serial';
import config from './config.js';

const cfg = config.inverter;

// --- Named registers to annotate in output ---
const KNOWN = {
  // Group 1 — inverter
  0:    'InverterStatus',
  1:    'Ppv H (PV power high, 0.1W)',
  2:    'Ppv L (PV power low)',
  3:    'Vpv1 (PV1 voltage, 0.1V)',
  4:    'Ipv1 (PV1 current, 0.1A)',
  5:    'Ppv1 H',
  6:    'Ppv1 L',
  7:    'Vpv2',
  8:    'Ipv2',
  9:    'Ppv2 H',
  10:   'Ppv2 L',
  35:   'Pac H (AC output power high, 0.1W)',
  36:   'Pac L',
  37:   'Fac (grid freq, 0.01Hz)',
  38:   'Vac1 (grid voltage, 0.1V)',
  46:   'Eac_today H (AC energy today high, 0.1kWh)',
  47:   'Eac_today L',
  48:   'Eac_total H',
  49:   'Eac_total L',

  // Storage range — energy totals
  3021: 'Pgrid H (grid import power high, 0.1W)',
  3022: 'Pgrid L',
  3045: 'PtoloadH (load power high, 0.1W)',
  3046: 'PtoloadL',
  3049: 'EactodayH (AC gen today high, 0.1kWh)',
  3050: 'EactodayL',
  3051: 'EactotalH (AC gen total high)',
  3052: 'EactotalL',
  3053: 'Epv_totalH (all PV total high, 0.1kWh)',
  3054: 'Epv_totalL',
  3055: 'Epv1_todayH (PV1 today high)',
  3056: 'Epv1_todayL',
  3057: 'Epv1_totalH',
  3058: 'Epv1_totalL',
  3059: 'Epv2_todayH',
  3060: 'Epv2_todayL',
  3061: 'Epv2_totalH',
  3062: 'Epv2_totalL',
  3067: 'Etouser_todayH (grid→user today high, 0.1kWh)',
  3068: 'Etouser_todayL',
  3069: 'Etouser_totalH',
  3070: 'Etouser_totalL',
  3071: 'Etogrid_todayH (inverter→grid today high)',
  3072: 'Etogrid_todayL',
  3073: 'Etogrid_totalH',
  3074: 'Etogrid_totalL',
  3075: 'Eload_todayH (load energy today high, 0.1kWh)',
  3076: 'Eload_todayL',
  3077: 'Eload_totalH',
  3078: 'Eload_totalL',
  3083: 'Epv_todayH (combined PV today high, 0.1kWh)',
  3084: 'Epv_todayL',

  // BMS
  3169: 'BMS_Voltage',
  3170: 'BMS_Current (signed, 0.1A)',
  3171: 'BMS_SOC (%)',
};

// --- Ranges to probe (start, count) ---
const RANGES = [
  { label: 'Group 1: inverter (PV + AC)',   start: 0,    count: 53 },
  { label: 'Storage: grid import',          start: 3021, count: 2  },
  { label: 'Storage: load power',           start: 3045, count: 2  },
  { label: 'Storage: AC energy totals',     start: 3049, count: 4  },
  { label: 'Storage: PV energy totals',     start: 3053, count: 32 },  // 3053–3084
  { label: 'Storage: grid energy totals',   start: 3067, count: 12 },  // 3067–3078
  { label: 'BMS registers',                 start: 3169, count: 3  },
];

const showRaw = process.argv.includes('--raw');

// Custom range override: node probe-registers.js --range 3040 3090
const rangeIdx = process.argv.indexOf('--range');
if (rangeIdx !== -1) {
  const start = parseInt(process.argv[rangeIdx + 1], 10);
  const end   = parseInt(process.argv[rangeIdx + 2], 10);
  if (!isNaN(start) && !isNaN(end) && end >= start) {
    RANGES.length = 0;
    RANGES.push({ label: `Custom range ${start}–${end}`, start, count: end - start + 1 });
  } else {
    console.error('Usage: --range <start> <end>  (e.g. --range 3040 3090)');
    process.exit(1);
  }
}

// --- Helpers ---

function u32(buf, offset) {
  return ((buf[offset] << 16) | buf[offset + 1]) >>> 0;
}

function signed16(val) {
  return val > 32767 ? val - 65536 : val;
}

function pad(n, width) {
  return String(n).padStart(width, ' ');
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Main ---

async function probe() {
  const client = new ModbusRTU();
  console.log(`\nConnecting to ${cfg.host}:${cfg.port || 502} (unit ${cfg.unit_id || 1})...`);
  await client.connectTCP(cfg.host, { port: cfg.port || 502 });
  client.setID(cfg.unit_id || 1);
  client.setTimeout(cfg.timeout_ms || 5000);
  console.log('Connected.\n');

  const results = [];

  for (const range of RANGES) {
    console.log(`\n=== ${range.label} (regs ${range.start}–${range.start + range.count - 1}) ===`);
    await sleep(500); // be gentle with the datalogger

    let data;
    try {
      const res = await client.readInputRegisters(range.start, range.count);
      data = res.data;
    } catch (err) {
      console.log(`  ERROR reading range: ${err.message}`);
      continue;
    }

    for (let i = 0; i < data.length; i++) {
      const reg = range.start + i;
      const raw = data[i];
      const name = KNOWN[reg] ?? '';
      const nonzero = raw !== 0 ? ' <<<' : '';
      const rawHex = showRaw ? `  0x${raw.toString(16).padStart(4, '0')}` : '';

      if (raw !== 0 || name) {
        console.log(`  reg ${pad(reg, 4)}: ${pad(raw, 6)}${rawHex}  ${name}${nonzero}`);
      }

      if (raw !== 0) {
        results.push({ reg, raw, name });
      }
    }

    // Check for consecutive non-zero pairs → interpret as 32-bit u32
    for (let i = 0; i < data.length - 1; i++) {
      const reg = range.start + i;
      if (data[i] !== 0 || data[i + 1] !== 0) {
        const val32 = u32(data, i);
        const name = KNOWN[reg];
        if (name && name.includes('H')) {
          const decoded = val32 / 10;
          console.log(`    → 32-bit pair ${reg}/${reg+1}: ${val32} raw = ${decoded.toFixed(1)} (÷10 scale)`);
        }
      }
    }
  }

  // Summary
  console.log('\n\n========== SUMMARY: Non-zero registers ==========');
  if (results.length === 0) {
    console.log('  No non-zero registers found.');
  } else {
    for (const { reg, raw, name } of results) {
      const s16 = signed16(raw);
      console.log(`  reg ${pad(reg, 4)}: raw=${pad(raw, 6)}  s16=${pad(s16, 7)}  ${name}`);
    }
  }

  console.log('\n========== KEY TARGETS for data collection ==========');
  const targets = [
    { reg: 3083, pair: 3084, label: 'PV today (Epv_today)',      scale: 0.1, unit: 'kWh' },
    { reg: 3055, pair: 3056, label: 'PV1 today (Epv1_today)',    scale: 0.1, unit: 'kWh' },
    { reg: 3059, pair: 3060, label: 'PV2 today (Epv2_today)',    scale: 0.1, unit: 'kWh' },
    { reg: 3075, pair: 3076, label: 'Load today (Eload_today)',  scale: 0.1, unit: 'kWh' },
    { reg: 3067, pair: 3068, label: 'Grid→user today',           scale: 0.1, unit: 'kWh' },
    { reg: 3071, pair: 3072, label: 'Inverter→grid today',       scale: 0.1, unit: 'kWh' },
    { reg: 3049, pair: 3050, label: 'AC gen today (Eactoday)',   scale: 0.1, unit: 'kWh' },
  ];

  for (const t of targets) {
    const found = results.find(r => r.reg === t.reg || r.reg === t.pair);
    const status = found ? 'NON-ZERO ✓' : 'zero / not found';
    console.log(`  ${status.padEnd(14)} reg ${t.reg}/${t.pair}  ${t.label}`);
  }

  client.close();
  console.log('\nDone.\n');
}

probe().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
