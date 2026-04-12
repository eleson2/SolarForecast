/**
 * Validates the config object at startup.
 * Throws an Error with a human-readable message on the first problem found.
 * Call this before any pipeline or cron setup so bad config fails fast.
 */

const KNOWN_PRICE_SOURCES = ['elprisetjust', 'awattar', 'nordpool', 'energidataservice'];
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

  // --- consumption (optional fields) ---
  if (cfg.consumption?.max_house_w !== undefined && cfg.consumption.max_house_w !== 0) {
    finite(cfg.consumption.max_house_w, 'consumption.max_house_w');
    need(cfg.consumption.max_house_w > 0, 'consumption.max_house_w must be positive');
  }

  // --- price ---
  need(cfg.price, 'price section is missing');
  const priceSources = Array.isArray(cfg.price.sources)
    ? cfg.price.sources
    : (cfg.price.source ? [cfg.price.source] : null); // backward compat
  need(priceSources && priceSources.length > 0,
    'price.sources must be a non-empty array of source names');
  for (const s of priceSources) {
    need(KNOWN_PRICE_SOURCES.includes(s),
      `price.sources entry "${s}" is unknown — valid values: ${KNOWN_PRICE_SOURCES.join(', ')}`);
  }
  need(typeof cfg.price.region === 'string' && cfg.price.region.length > 0,
    'price.region must be a non-empty string');

  // --- peak_shaving (optional, validate if enabled) ---
  if (cfg.peak_shaving?.enabled) {
    need(Array.isArray(cfg.peak_shaving.date_ranges) && cfg.peak_shaving.date_ranges.length > 0,
      'peak_shaving.date_ranges must be a non-empty array');
    const mmddRe = /^\d{2}-\d{2}$/;
    for (const [i, r] of cfg.peak_shaving.date_ranges.entries()) {
      const label = `peak_shaving.date_ranges[${i}]`;
      if (!r.default) {
        need(typeof r.from === 'string' && mmddRe.test(r.from),
          `${label}.from must be "MM-DD" (got ${JSON.stringify(r.from)})`);
        need(typeof r.to === 'string' && mmddRe.test(r.to),
          `${label}.to must be "MM-DD" (got ${JSON.stringify(r.to)})`);
      }
      finite(r.default_import_kw, `${label}.default_import_kw`);
      need(r.default_import_kw > 0, `${label}.default_import_kw must be positive`);
      finite(r.default_export_kw, `${label}.default_export_kw`);
      need(r.default_export_kw > 0, `${label}.default_export_kw must be positive`);
      need(r.default_export_kw <= r.default_import_kw,
        `${label}.default_export_kw must be ≤ default_import_kw`);
      for (const [j, entry] of (r.schedule || []).entries()) {
        const slabel = `${label}.schedule[${j}]`;
        need(typeof entry.from === 'string' && /^\d{2}:\d{2}$/.test(entry.from),
          `${slabel}.from must be "HH:MM" (got ${JSON.stringify(entry.from)})`);
        need(typeof entry.to === 'string' && /^\d{2}:\d{2}$/.test(entry.to),
          `${slabel}.to must be "HH:MM" (got ${JSON.stringify(entry.to)})`);
        need(entry.from < entry.to,
          `${slabel}: from (${entry.from}) must be before to (${entry.to})`);
        finite(entry.import_kw, `${slabel}.import_kw`);
        need(entry.import_kw > 0, `${slabel}.import_kw must be positive`);
        finite(entry.export_kw, `${slabel}.export_kw`);
        need(entry.export_kw > 0, `${slabel}.export_kw must be positive`);
        need(entry.export_kw <= entry.import_kw, `${slabel}.export_kw must be ≤ import_kw`);
      }
    }
  }

  // --- ev (optional, validate if enabled) ---
  if (cfg.ev?.enabled) {
    finite(cfg.ev.charge_watts, 'ev.charge_watts');
    need(cfg.ev.charge_watts > 0, 'ev.charge_watts must be positive');
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
