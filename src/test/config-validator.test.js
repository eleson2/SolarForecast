import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../config-validator.js';
import { validConfig, validPeakShaving } from './helpers/config-fixture.js';

function ok(cfg) {
  assert.doesNotThrow(() => validateConfig(cfg), 'expected config to be valid');
}

function fails(cfg, pattern) {
  assert.throws(() => validateConfig(cfg), (err) => {
    assert.match(err.message, pattern);
    return true;
  });
}

// ---------------------------------------------------------------------------
describe('validateConfig — valid config', () => {
  it('accepts a minimal valid config', () => {
    ok(validConfig);
  });

  it('accepts config with valid peak_shaving', () => {
    ok({ ...validConfig, peak_shaving: validPeakShaving });
  });

  it('accepts peak_shaving when disabled (no date_ranges required)', () => {
    ok({ ...validConfig, peak_shaving: { enabled: false } });
  });
});

// ---------------------------------------------------------------------------
describe('validateConfig — location', () => {
  it('rejects missing location', () => {
    const cfg = structuredClone(validConfig);
    delete cfg.location;
    fails(cfg, /location section is missing/);
  });

  it('rejects latitude out of range', () => {
    const cfg = structuredClone(validConfig);
    cfg.location.lat = 91;
    fails(cfg, /location\.lat/);
  });

  it('rejects invalid timezone', () => {
    const cfg = structuredClone(validConfig);
    cfg.location.timezone = 'Not/ATimezone';
    fails(cfg, /not a valid IANA timezone/);
  });
});

// ---------------------------------------------------------------------------
describe('validateConfig — battery', () => {
  it('rejects min_soc >= max_soc', () => {
    const cfg = structuredClone(validConfig);
    cfg.battery.min_soc = 50;
    cfg.battery.max_soc = 50;
    fails(cfg, /min_soc.*must be less than.*max_soc/);
  });

  it('rejects non-finite capacity', () => {
    const cfg = structuredClone(validConfig);
    cfg.battery.capacity_kwh = Infinity;
    fails(cfg, /battery\.capacity_kwh/);
  });
});

// ---------------------------------------------------------------------------
describe('validateConfig — price', () => {
  it('rejects unknown price source', () => {
    const cfg = structuredClone(validConfig);
    cfg.price.sources = ['unknown-source'];
    fails(cfg, /unknown/);
  });

  it('rejects empty sources array', () => {
    const cfg = structuredClone(validConfig);
    cfg.price.sources = [];
    fails(cfg, /price\.sources/);
  });

  it('rejects missing region', () => {
    const cfg = structuredClone(validConfig);
    cfg.price.region = '';
    fails(cfg, /price\.region/);
  });
});

// ---------------------------------------------------------------------------
describe('validateConfig — peak_shaving (date_ranges schema)', () => {
  it('rejects missing date_ranges when enabled', () => {
    const cfg = { ...validConfig, peak_shaving: { enabled: true } };
    fails(cfg, /date_ranges must be a non-empty array/);
  });

  it('rejects empty date_ranges array', () => {
    const cfg = { ...validConfig, peak_shaving: { enabled: true, date_ranges: [] } };
    fails(cfg, /date_ranges must be a non-empty array/);
  });

  it('rejects invalid MM-DD format for range.from', () => {
    const cfg = structuredClone(validConfig);
    cfg.peak_shaving = {
      enabled: true,
      date_ranges: [
        { from: 'October', to: '03-31', default_import_kw: 4, default_export_kw: 3, schedule: [] },
      ],
    };
    fails(cfg, /from must be "MM-DD"/);
  });

  it('rejects missing default_import_kw', () => {
    const cfg = structuredClone(validConfig);
    cfg.peak_shaving = {
      enabled: true,
      date_ranges: [
        { from: '10-01', to: '03-31', default_export_kw: 3, schedule: [] },
      ],
    };
    fails(cfg, /default_import_kw/);
  });

  it('rejects export_kw > import_kw on range defaults', () => {
    const cfg = structuredClone(validConfig);
    cfg.peak_shaving = {
      enabled: true,
      date_ranges: [
        { from: '10-01', to: '03-31', default_import_kw: 3, default_export_kw: 5, schedule: [] },
      ],
    };
    fails(cfg, /default_export_kw must be ≤ default_import_kw/);
  });

  it('rejects schedule entry with invalid HH:MM for from', () => {
    const cfg = structuredClone(validConfig);
    cfg.peak_shaving = {
      enabled: true,
      date_ranges: [
        {
          from: '10-01', to: '03-31',
          default_import_kw: 4, default_export_kw: 3,
          schedule: [{ from: '0000', to: '06:45', import_kw: 12, export_kw: 11 }],
        },
      ],
    };
    fails(cfg, /from must be "HH:MM"/);
  });

  it('rejects schedule entry where from >= to', () => {
    const cfg = structuredClone(validConfig);
    cfg.peak_shaving = {
      enabled: true,
      date_ranges: [
        {
          from: '10-01', to: '03-31',
          default_import_kw: 4, default_export_kw: 3,
          schedule: [{ from: '07:00', to: '06:00', import_kw: 12, export_kw: 11 }],
        },
      ],
    };
    fails(cfg, /from.*must be before.*to/);
  });

  it('rejects schedule entry where export_kw > import_kw', () => {
    const cfg = structuredClone(validConfig);
    cfg.peak_shaving = {
      enabled: true,
      date_ranges: [
        {
          from: '10-01', to: '03-31',
          default_import_kw: 4, default_export_kw: 3,
          schedule: [{ from: '00:00', to: '06:45', import_kw: 5, export_kw: 10 }],
        },
      ],
    };
    fails(cfg, /export_kw must be ≤ import_kw/);
  });

  it('accepts default: true entry without from/to', () => {
    const cfg = {
      ...validConfig,
      peak_shaving: {
        enabled: true,
        date_ranges: [
          { default: true, default_import_kw: 13, default_export_kw: 12, schedule: [] },
        ],
      },
    };
    ok(cfg);
  });
});

// ---------------------------------------------------------------------------
describe('validateConfig — inverter (growatt-modbus)', () => {
  it('rejects unknown inverter brand', () => {
    const cfg = { ...validConfig, inverter: { brand: 'unknown-brand' } };
    fails(cfg, /inverter\.brand.*unknown/);
  });

  it('rejects growatt-modbus without host', () => {
    const cfg = {
      ...validConfig,
      inverter: { brand: 'growatt-modbus', host: '', charge_soc: 90, discharge_soc: 20 },
    };
    fails(cfg, /inverter\.host/);
  });

  it('rejects discharge_soc >= charge_soc', () => {
    const cfg = {
      ...validConfig,
      inverter: { brand: 'growatt-modbus', host: '192.168.1.1', charge_soc: 50, discharge_soc: 50 },
    };
    fails(cfg, /discharge_soc.*must be less than.*charge_soc/);
  });
});
