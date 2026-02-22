/**
 * Growatt MIN series inverter driver.
 *
 * Uses the Growatt OpenAPI V1 (TLX endpoints) to read battery state
 * and push time-segment schedules derived from the optimizer.
 *
 * Supports MIN 2500–6000TL-X/XE/XH/XA, MOD, MID, MIC series.
 */

const MAX_SEGMENTS = 9;

// --- Action → batt_mode mapping ---

const ACTION_TO_BATT_MODE = {
  charge_grid:  1,  // battery_first — charges from grid
  discharge:    0,  // load_first — battery powers house
  charge_solar: 0,  // load_first — solar surplus charges battery
  sell:         1,  // battery_first — export stored energy
  idle:         0,  // load_first — normal self-consumption
};

// --- HTTP helper ---

async function growattFetch(method, path, cfg, body) {
  const base = (cfg.server || 'https://openapi.growatt.com/').replace(/\/$/, '');
  const url = `${base}/${path.replace(/^\//, '')}`;

  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      token: cfg.token,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Growatt API ${method} ${path} → ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.error_code && json.error_code !== 0) {
    throw new Error(`Growatt API error ${json.error_code}: ${json.error_msg || JSON.stringify(json)}`);
  }
  return json;
}

// --- Driver interface ---

/**
 * Read current battery state from inverter.
 * @param {object} cfg — inverter config from config.js
 * @returns {Promise<{ soc: number, power_w: number, mode: string }>}
 */
export async function getState(cfg) {
  const data = await growattFetch('POST', 'v1/device/tlx/tlx_last_data', cfg, {
    tlx_sn: cfg.device_sn,
  });

  const d = data.data || data;
  return {
    soc:     Number(d.soc ?? d.batSoc ?? 0),
    power_w: Number(d.batPower ?? d.bat_power ?? 0),
    mode:    String(d.workMode ?? d.work_mode ?? 'unknown'),
  };
}

/**
 * Read extended telemetry from inverter including consumption.
 * Uses the same tlx_last_data endpoint as getState() but parses additional fields.
 *
 * @param {object} cfg — inverter config from config.js
 * @returns {Promise<{ soc: number, battery_w: number, grid_import_w: number, grid_export_w: number, solar_w: number, consumption_w: number }>}
 */
export async function getMetrics(cfg) {
  const data = await growattFetch('POST', 'v1/device/tlx/tlx_last_data', cfg, {
    tlx_sn: cfg.device_sn,
  });

  const d = data.data || data;

  const soc = Number(d.soc ?? d.batSoc ?? 0);
  const battery_w = Number(d.batPower ?? d.bat_power ?? 0);
  const grid_import_w = Number(d.pactouser ?? d.pac_to_user ?? 0);
  const grid_export_w = Number(d.pactogrid ?? d.pac_to_grid ?? 0);
  const solar_w = Number(d.ppv ?? ((Number(d.ppv1 ?? 0)) + (Number(d.ppv2 ?? 0))));
  const consumption_w = Number(d.pload ?? d.pac ?? d.plocaload ?? 0)
    || Math.max(0, solar_w + grid_import_w - grid_export_w - battery_w);

  return { soc, battery_w, grid_import_w, grid_export_w, solar_w, consumption_w };
}

/**
 * Merge consecutive 15-min slots with the same action into time windows,
 * then push them as Growatt time segments.
 *
 * @param {Array<{ slot_ts: string, action: string, watts?: number }>} slots
 * @param {object} cfg — inverter config
 * @returns {Promise<{ applied: number, skipped: number }>}
 */
export async function applySchedule(slots, cfg) {
  if (!slots.length) return { applied: 0, skipped: 0 };

  const windows = mergeSlots(slots);

  // Growatt supports max 9 segments
  if (windows.length > MAX_SEGMENTS) {
    console.warn(`[growatt] ${windows.length} windows exceed max ${MAX_SEGMENTS} — keeping first ${MAX_SEGMENTS}`);
  }
  const active = windows.slice(0, MAX_SEGMENTS);

  let applied = 0;
  let skipped = 0;

  // Push active segments
  for (let i = 0; i < active.length; i++) {
    const w = active[i];
    try {
      await pushSegment(i + 1, w, cfg);
      applied++;
    } catch (err) {
      console.error(`[growatt] Failed to push segment ${i + 1}:`, err.message);
      skipped++;
    }
  }

  // Disable unused segments
  for (let i = active.length; i < MAX_SEGMENTS; i++) {
    try {
      await disableSegment(i + 1, cfg);
    } catch (err) {
      console.error(`[growatt] Failed to disable segment ${i + 1}:`, err.message);
    }
  }

  return { applied, skipped };
}

/**
 * Reset all 9 time segments to disabled — inverter returns to default mode.
 * @param {object} cfg — inverter config
 */
export async function resetToDefault(cfg) {
  console.log('[growatt] Resetting all segments to default');
  for (let i = 1; i <= MAX_SEGMENTS; i++) {
    try {
      await disableSegment(i, cfg);
    } catch (err) {
      console.error(`[growatt] Failed to disable segment ${i}:`, err.message);
    }
  }
}

// --- Slot merging ---

/**
 * Merge consecutive 15-min slots with the same action into windows.
 * @param {Array<{ slot_ts: string, action: string }>} slots — sorted chronologically
 * @returns {Array<{ startHour: number, startMin: number, endHour: number, endMin: number, batt_mode: number, action: string }>}
 */
export function mergeSlots(slots) {
  if (!slots.length) return [];

  const sorted = [...slots].sort((a, b) => a.slot_ts.localeCompare(b.slot_ts));
  const windows = [];
  let current = null;

  for (const slot of sorted) {
    const time = slot.slot_ts.slice(11, 16); // "HH:MM"
    const [h, m] = time.split(':').map(Number);
    const batt_mode = ACTION_TO_BATT_MODE[slot.action] ?? 0;

    if (current && current.action === slot.action) {
      // Extend: end = this slot + 15 min
      const endMin = m + 15;
      current.endHour = h + Math.floor(endMin / 60);
      current.endMin = endMin % 60;
    } else {
      // New window
      const endMin = m + 15;
      current = {
        startHour: h,
        startMin: m,
        endHour: h + Math.floor(endMin / 60),
        endMin: endMin % 60,
        batt_mode,
        action: slot.action,
      };
      windows.push(current);
    }
  }

  return windows;
}

// --- Segment push helpers ---

async function pushSegment(index, window, cfg) {
  const pad = (n) => String(n).padStart(2, '0');
  const label = `${pad(window.startHour)}:${pad(window.startMin)}-${pad(window.endHour)}:${pad(window.endMin)} ${window.action}`;

  if (cfg.dry_run) {
    console.log(`[growatt] DRY-RUN segment ${index}: ${label} (batt_mode=${window.batt_mode})`);
    return;
  }

  console.log(`[growatt] Pushing segment ${index}: ${label}`);

  await growattFetch('POST', 'v1/tlxSet', cfg, {
    tlx_sn: cfg.device_sn,
    type: `time_segment${index}`,
    param1: String(window.batt_mode),
    param2: String(window.startHour),
    param3: String(window.startMin),
    param4: String(window.endHour),
    param5: String(window.endMin),
    param6: '1',  // enabled
    param7: '', param8: '', param9: '', param10: '',
    param11: '', param12: '', param13: '', param14: '',
    param15: '', param16: '', param17: '', param18: '', param19: '',
  });
}

async function disableSegment(index, cfg) {
  if (cfg.dry_run) {
    console.log(`[growatt] DRY-RUN disable segment ${index}`);
    return;
  }

  await growattFetch('POST', 'v1/tlxSet', cfg, {
    tlx_sn: cfg.device_sn,
    type: `time_segment${index}`,
    param1: '0', param2: '0', param3: '0', param4: '0', param5: '0',
    param6: '0',  // disabled
    param7: '', param8: '', param9: '', param10: '',
    param11: '', param12: '', param13: '', param14: '',
    param15: '', param16: '', param17: '', param18: '', param19: '',
  });
}
