/**
 * Modbus write-failure probe — Growatt MOD TL3-XH datalogger.
 *
 * Characterises the intermittent "Modbus exception 0" FC16 write failures that
 * leave the discharge floor (holding 3310) stuck and block battery discharge.
 *
 * It runs several groups of trials and reports the success/fail rate + exception
 * code histogram for each, to answer:
 *   A. Baseline — does FC16 to 3310 fail right now, and how often?
 *   B. Mirror   — does the mirror register 808 land when 3310 does not?
 *   C. Gap      — does a longer settle gap AFTER the read (before the write) help?
 *   D. Socket   — does a fresh TCP connection per write help vs a shared socket?
 *   E. No-read  — does dropping the preceding read change the write outcome?
 *   F. FC06     — reconfirm the datalogger rejects FC06 (expected: exception 1).
 *
 * SAFE / NON-DESTRUCTIVE: every write re-writes the register's OWN current value
 * (a no-op). It exercises the write path without changing any inverter setting,
 * and reads back afterwards to confirm the value is unchanged.
 *
 * ⚠️ STOP THE SERVICE FIRST:  nssm stop SolarForecast
 *    Running this while the service is live = two Modbus masters on one datalogger
 *    = self-inflicted contention that invalidates the results.
 *
 * Usage:
 *   nssm stop SolarForecast
 *   node probe-write-failures.js [trials]      # trials per group, default 20
 *   nssm start SolarForecast
 */

import ModbusRTU from 'modbus-serial';
import config from './config.js';

const HOST    = config.inverter.host;
const PORT    = config.inverter.port ?? 502;
const UNIT    = config.inverter.unit_id ?? 1;
const TIMEOUT = config.inverter.timeout_ms ?? 5000;

const REG_3310 = 3310;   // LoadFirstStopSocSet (discharge floor)
const REG_808  = 808;    // mirror of 3310
const REG_MODE = 0;      // input reg 0 — system work mode

const TRIALS = Math.max(1, parseInt(process.argv[2] ?? '20', 10));

const delay = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const c = new ModbusRTU();
  await c.connectTCP(HOST, { port: PORT });
  c.setID(UNIT);
  c.setTimeout(TIMEOUT);
  return c;
}

function closeQuiet(c) { try { c?.close?.(); } catch (_) {} }

// Single write attempt (no retry). Returns structured outcome incl. modbusCode.
async function writeOnce(client, reg, value, { fc = 16 } = {}) {
  const t0 = Date.now();
  try {
    if (fc === 6) await client.writeRegister(reg, value);
    else          await client.writeRegisters(reg, [value]);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      code: err?.modbusCode ?? null,
      msg: err.message,
    };
  }
}

async function readReg(client, reg, type = 'holding') {
  const r = type === 'input'
    ? await client.readInputRegisters(reg, 1)
    : await client.readHoldingRegisters(reg, 1);
  return r.data[0];
}

// Run `trials` write attempts of `value` to `reg` and summarise.
//   readBefore : do a read of `reg` (holding) before each write (timing trigger test)
//   gapMs      : pause between that read and the write
//   freshConn  : open+close a new TCP connection per trial (else reuse `shared`)
async function runGroup(label, { reg, value, trials, readBefore = true, gapMs = 1000, freshConn = false, fc = 16, shared }) {
  const codes = {};
  let ok = 0, fail = 0, totalMs = 0;
  const firstFails = [];

  for (let i = 0; i < trials; i++) {
    let client = shared;
    if (freshConn) { try { client = await connect(); } catch (e) { fail++; codes['connect-fail'] = (codes['connect-fail'] || 0) + 1; continue; } }

    if (readBefore) {
      try { await readReg(client, reg); } catch (_) { /* read failure is itself a datapoint but rare */ }
    }
    if (gapMs > 0) await delay(gapMs);

    const res = await writeOnce(client, reg, value, { fc });
    totalMs += res.ms;
    if (res.ok) { ok++; }
    else {
      fail++;
      const key = res.code == null ? 'no-code' : `code ${res.code}`;
      codes[key] = (codes[key] || 0) + 1;
      if (firstFails.length < 2) firstFails.push(res.msg);
    }

    if (freshConn) closeQuiet(client);
    await delay(800); // base inter-trial spacing so we don't hammer
  }

  const rate = ((fail / trials) * 100).toFixed(0);
  console.log(`\n[${label}]`);
  console.log(`  reg=${reg} value=${value} fc=FC${fc} trials=${trials} readBefore=${readBefore} gap=${gapMs}ms freshConn=${freshConn}`);
  console.log(`  ok=${ok}  fail=${fail}  failRate=${rate}%  avgWriteLatency=${Math.round(totalMs / trials)}ms`);
  if (Object.keys(codes).length) console.log(`  failure codes: ${JSON.stringify(codes)}`);
  if (firstFails.length) console.log(`  sample error: ${firstFails[0]}`);
  return { ok, fail, rate: fail / trials };
}

async function main() {
  console.log('================ Modbus write-failure probe ================');
  console.log(`Target ${HOST}:${PORT} unit ${UNIT}, timeout ${TIMEOUT}ms, ${TRIALS} trials/group`);
  console.log('NON-DESTRUCTIVE: re-writes each register\'s current value (no-op).');
  console.log('\n⚠️  The service MUST be stopped (nssm stop SolarForecast) or results are bogus.');
  console.log('    Starting in 5s — Ctrl-C to abort...');
  await delay(5000);

  const shared = await connect();

  // Baseline reads (so we re-write the SAME value = no-op, and can restore at end).
  const orig3310 = await readReg(shared, REG_3310);
  let orig808 = null;
  try { orig808 = await readReg(shared, REG_808); } catch (_) { console.log('  (reg 808 not readable — mirror test will be skipped)'); }
  let mode = null;
  try { mode = await readReg(shared, REG_MODE, 'input'); } catch (_) {}
  console.log(`\nBaseline: reg 3310=${orig3310}%  reg 808=${orig808 ?? 'n/a'}  workMode=${mode ?? 'n/a'}`);

  // F — reconfirm FC06 is rejected (illegal function), 3 quick trials.
  await runGroup('F: FC06 to 3310 (expect exception 1)', { reg: REG_3310, value: orig3310, trials: 3, fc: 6, shared });

  // A — baseline FC16, read-then-write, 1s gap, shared socket.
  const a = await runGroup('A: FC16 3310 baseline (read→1s→write, shared)', { reg: REG_3310, value: orig3310, trials: TRIALS, shared });

  // B — mirror register 808.
  if (orig808 != null) {
    await runGroup('B: FC16 808 mirror (read→1s→write, shared)', { reg: REG_808, value: orig808, trials: TRIALS, shared });
  }

  // C — gap sweep (does more settle time after the read help?).
  for (const gap of [250, 2000, 4000]) {
    await runGroup(`C: FC16 3310 gap=${gap}ms`, { reg: REG_3310, value: orig3310, trials: Math.max(8, Math.floor(TRIALS / 2)), gapMs: gap, shared });
  }

  // D — fresh connection per write.
  await runGroup('D: FC16 3310 fresh connection per write', { reg: REG_3310, value: orig3310, trials: TRIALS, freshConn: true, shared });

  // E — bare write, no preceding read.
  await runGroup('E: FC16 3310 no preceding read', { reg: REG_3310, value: orig3310, trials: TRIALS, readBefore: false, shared });

  // Restore / verify nothing moved.
  console.log('\n---------------- verify / restore ----------------');
  try {
    const now3310 = await readReg(shared, REG_3310);
    if (now3310 !== orig3310) {
      console.log(`  reg 3310 changed ${orig3310}→${now3310}, restoring...`);
      await delay(1000);
      await writeOnce(shared, REG_3310, orig3310);
    }
    console.log(`  reg 3310 final = ${await readReg(shared, REG_3310)} (orig ${orig3310})`);
  } catch (e) { console.log(`  could not verify reg 3310: ${e.message}`); }

  closeQuiet(shared);
  console.log('\n================ done — restart the service: nssm start SolarForecast ================');
}

main().catch(err => { console.error('PROBE ERROR:', err); process.exit(1); });
