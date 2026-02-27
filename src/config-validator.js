/**
 * Validates the config object at startup.
 * Throws an Error with a human-readable message on the first problem found.
 * Call this before any pipeline or cron setup so bad config fails fast.
 */

const KNOWN_PRICE_SOURCES = ['elprisetjust', 'awattar'];
const KNOWN_INVERTER_BRANDS = ['growatt', 'growatt-modbus'];

function need(condition, message) {
  if (!condition) throw new Error(`[config] ${message}`);
}

function finite(value, name) {
  need(typeof value === 'number' && isFinite(value), `${name} must be a finite number (got ${JSON.stringify(value)})`);
}

function inRange(value, min, max, name) {
  finite(value, name);
  need(value >= min && value <= max, `${name} must be between ${min} and ${max} (got ${value})`);
}

export function validateConfig(cfg) {
  // --- location ---
  need(cfg.location, 'location section is missing');
  inRange(cfg.location.lat, -90, 90, 'location.lat');
  inRange(cfg.location.lon, -180, 180, 'location.lon');
  need(typeof cfg.location.timezone === 'string' && cfg.location.timezone.length > 0,
    'location.timezone must be a non-empty string');
  try {
    Intl.DateTimeFormat('en', { timeZone: cfg.location.timezone });
  } catch {
    throw new Error(`[config] location.timezone "${cfg.location.timezone}" is not a valid IANA timezone`);
  }

  // --- panel ---
  need(cfg.panel, 'panel section is missing');
  finite(cfg.panel.peak_kw, 'panel.peak_kw');
  need(cfg.panel.peak_kw > 0, `panel.peak_kw must be positive (got ${cfg.panel.peak_kw})`);
  inRange(cfg.panel.tilt, 0, 90, 'panel.tilt');
  inRange(cfg.panel.azimuth, 0, 360, 'panel.azimuth');

  // --- battery ---
  need(cfg.battery, 'battery section is missing');
  finite(cfg.battery.capacity_kwh, 'battery.capacity_kwh');
  need(cfg.battery.capacity_kwh > 0, 'battery.capacity_kwh must be positive');
  finite(cfg.battery.max_charge_w, 'battery.max_charge_w');
  finite(cfg.battery.max_discharge_w, 'battery.max_discharge_w');
  inRange(cfg.battery.min_soc, 0, 100, 'battery.min_soc');
  inRange(cfg.battery.max_soc, 0, 100, 'battery.max_soc');
  need(cfg.battery.min_soc < cfg.battery.max_soc,
    `battery.min_soc (${cfg.battery.min_soc}) must be less than battery.max_soc (${cfg.battery.max_soc})`);

  // --- price ---
  need(cfg.price, 'price section is missing');
  need(KNOWN_PRICE_SOURCES.includes(cfg.price.source),
    `price.source "${cfg.price.source}" is unknown — valid values: ${KNOWN_PRICE_SOURCES.join(', ')}`);
  need(typeof cfg.price.region === 'string' && cfg.price.region.length > 0,
    'price.region must be a non-empty string');

  // --- peak_shaving (optional, validate if enabled) ---
  if (cfg.peak_shaving?.enabled) {
    finite(cfg.peak_shaving.default_kw, 'peak_shaving.default_kw');
    need(cfg.peak_shaving.default_kw > 0, 'peak_shaving.default_kw must be positive');
    for (const entry of (cfg.peak_shaving.schedule || [])) {
      need(typeof entry.from === 'string' && /^\d{2}:\d{2}$/.test(entry.from),
        `peak_shaving.schedule entry.from must be "HH:MM" (got ${JSON.stringify(entry.from)})`);
      need(typeof entry.to === 'string' && /^\d{2}:\d{2}$/.test(entry.to),
        `peak_shaving.schedule entry.to must be "HH:MM" (got ${JSON.stringify(entry.to)})`);
      need(entry.from < entry.to,
        `peak_shaving.schedule entry: from (${entry.from}) must be before to (${entry.to})`);
      finite(entry.limit_kw, 'peak_shaving.schedule entry.limit_kw');
      need(entry.limit_kw > 0, 'peak_shaving.schedule entry.limit_kw must be positive');
    }
  }

  // --- inverter (optional section, but validate if present) ---
  if (cfg.inverter?.brand) {
    need(KNOWN_INVERTER_BRANDS.includes(cfg.inverter.brand),
      `inverter.brand "${cfg.inverter.brand}" is unknown — valid values: ${KNOWN_INVERTER_BRANDS.join(', ')}`);

    if (cfg.inverter.brand === 'growatt-modbus') {
      need(typeof cfg.inverter.host === 'string' && cfg.inverter.host.length > 0,
        'inverter.host must be set for growatt-modbus');
      inRange(cfg.inverter.charge_soc ?? 90, 1, 100, 'inverter.charge_soc');
      inRange(cfg.inverter.discharge_soc ?? 20, 1, 100, 'inverter.discharge_soc');
      need((cfg.inverter.discharge_soc ?? 20) < (cfg.inverter.charge_soc ?? 90),
        `inverter.discharge_soc (${cfg.inverter.discharge_soc}) must be less than inverter.charge_soc (${cfg.inverter.charge_soc})`);
    }
  }
}
