import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeakShavingLimits } from '../peak-shaving.js';

// ---------------------------------------------------------------------------
// Shared fixture — the config in production use (Oct–Mar / Apr–Sep / default)
// ---------------------------------------------------------------------------
const psConfig = {
  enabled: true,
  date_ranges: [
    {
      from: '10-01', to: '03-31',       // wraps year boundary
      default_import_kw: 4.1,
      default_export_kw: 4.0,
      schedule: [
        { from: '00:00', to: '06:45', import_kw: 12, export_kw: 11 },
        { from: '21:05', to: '23:59', import_kw: 12, export_kw: 11 },
      ],
    },
    {
      from: '04-01', to: '09-30',
      default_import_kw: 3.5,
      default_export_kw: 3.4,
      schedule: [],
    },
    {
      default: true,
      default_import_kw: 13,
      default_export_kw: 12,
      schedule: [],
    },
  ],
};

// ---------------------------------------------------------------------------
describe('resolvePeakShavingLimits — disabled / missing config', () => {
  it('returns null when enabled is false', () => {
    const result = resolvePeakShavingLimits({ enabled: false, date_ranges: [] }, '2026-04-12T14:00');
    assert.equal(result, null);
  });

  it('returns null when date_ranges is missing', () => {
    const result = resolvePeakShavingLimits({ enabled: true }, '2026-04-12T14:00');
    assert.equal(result, null);
  });

  it('returns null when psConfig is null', () => {
    assert.equal(resolvePeakShavingLimits(null, '2026-04-12T14:00'), null);
  });

  it('returns null when no date range matches and no default entry', () => {
    const cfg = {
      enabled: true,
      date_ranges: [
        { from: '04-01', to: '09-30', default_import_kw: 3.5, default_export_kw: 3.4, schedule: [] },
      ],
    };
    // January — falls outside Apr–Sep, no catch-all
    const result = resolvePeakShavingLimits(cfg, '2026-01-15T12:00');
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
describe('resolvePeakShavingLimits — date range matching', () => {
  it('matches Apr–Sep range in April', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-04-12T14:00');
    assert.deepEqual(r, { import_kw: 3.5, export_kw: 3.4 });
  });

  it('matches Apr–Sep range on the first day (04-01)', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-04-01T10:00');
    assert.deepEqual(r, { import_kw: 3.5, export_kw: 3.4 });
  });

  it('matches Apr–Sep range on the last day (09-30)', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-09-30T23:59');
    assert.deepEqual(r, { import_kw: 3.5, export_kw: 3.4 });
  });

  it('matches Oct–Mar (year-wrap) in November', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-11-15T14:00');
    assert.deepEqual(r, { import_kw: 4.1, export_kw: 4.0 });
  });

  it('matches Oct–Mar (year-wrap) in January', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-01-20T14:00');
    assert.deepEqual(r, { import_kw: 4.1, export_kw: 4.0 });
  });

  it('matches Oct–Mar (year-wrap) on Oct 01 boundary', () => {
    // Use 12:00 — outside the EV schedule windows, so range defaults apply
    const r = resolvePeakShavingLimits(psConfig, '2026-10-01T12:00');
    assert.deepEqual(r, { import_kw: 4.1, export_kw: 4.0 });
  });

  it('matches Oct–Mar (year-wrap) on Mar 31 boundary', () => {
    // Use 14:00 — outside the EV schedule windows, so range defaults apply
    const r = resolvePeakShavingLimits(psConfig, '2026-03-31T14:00');
    assert.deepEqual(r, { import_kw: 4.1, export_kw: 4.0 });
  });

  it('does NOT match Oct–Mar range in April (uses Apr–Sep instead)', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-04-05T12:00');
    // Should be Apr–Sep, not Oct–Mar
    assert.deepEqual(r, { import_kw: 3.5, export_kw: 3.4 });
  });
});

// ---------------------------------------------------------------------------
describe('resolvePeakShavingLimits — time schedule within range', () => {
  it('returns schedule import_kw/export_kw when time is inside a window', () => {
    // Oct–Mar, 03:00 falls in 00:00–06:45 window
    const r = resolvePeakShavingLimits(psConfig, '2026-11-10T03:00');
    assert.deepEqual(r, { import_kw: 12, export_kw: 11 });
  });

  it('matches schedule window at exact from boundary (00:00)', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-11-10T00:00');
    assert.deepEqual(r, { import_kw: 12, export_kw: 11 });
  });

  it('matches schedule window at exact to boundary (06:45)', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-11-10T06:45');
    assert.deepEqual(r, { import_kw: 12, export_kw: 11 });
  });

  it('returns range defaults when time is outside all schedule windows', () => {
    // Oct–Mar, 12:00 is outside both windows
    const r = resolvePeakShavingLimits(psConfig, '2026-11-10T12:00');
    assert.deepEqual(r, { import_kw: 4.1, export_kw: 4.0 });
  });

  it('returns range defaults when schedule is empty', () => {
    // Apr–Sep has no schedule entries
    const r = resolvePeakShavingLimits(psConfig, '2026-06-15T03:00');
    assert.deepEqual(r, { import_kw: 3.5, export_kw: 3.4 });
  });

  it('matches second schedule window (21:05–23:59)', () => {
    const r = resolvePeakShavingLimits(psConfig, '2026-12-01T22:00');
    assert.deepEqual(r, { import_kw: 12, export_kw: 11 });
  });
});

// ---------------------------------------------------------------------------
describe('resolvePeakShavingLimits — default: true catch-all', () => {
  it('catch-all returns its defaults when no date range matches', () => {
    const cfg = {
      enabled: true,
      date_ranges: [
        { from: '04-01', to: '09-30', default_import_kw: 3.5, default_export_kw: 3.4, schedule: [] },
        { default: true, default_import_kw: 13, default_export_kw: 12, schedule: [] },
      ],
    };
    // January — outside Apr–Sep, hits catch-all
    const r = resolvePeakShavingLimits(cfg, '2026-01-15T12:00');
    assert.deepEqual(r, { import_kw: 13, export_kw: 12 });
  });

  it('catch-all is not reached when a date range already matched', () => {
    const cfg = {
      enabled: true,
      date_ranges: [
        { from: '04-01', to: '09-30', default_import_kw: 3.5, default_export_kw: 3.4, schedule: [] },
        { default: true, default_import_kw: 13, default_export_kw: 12, schedule: [] },
      ],
    };
    // May — matches Apr–Sep, not catch-all
    const r = resolvePeakShavingLimits(cfg, '2026-05-10T12:00');
    assert.deepEqual(r, { import_kw: 3.5, export_kw: 3.4 });
  });
});
