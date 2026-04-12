import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { localTs, parseTs, dayOfYear, doyToMonthDay, calendarDayDistance, CALENDAR_DATES } from '../timeutils.js';

// ---------------------------------------------------------------------------
describe('localTs', () => {
  it('formats a UTC midnight as the correct local time in Stockholm (winter = UTC+1)', () => {
    // 2026-01-15 00:00 UTC → 2026-01-15 01:00 Stockholm (CET, UTC+1)
    const d = new Date('2026-01-15T00:00:00Z');
    assert.equal(localTs(d, 'Europe/Stockholm'), '2026-01-15T01:00');
  });

  it('formats a UTC time as the correct local time in Stockholm (summer = UTC+2)', () => {
    // 2026-06-15 22:00 UTC → 2026-06-16 00:00 Stockholm (CEST, UTC+2)
    const d = new Date('2026-06-15T22:00:00Z');
    assert.equal(localTs(d, 'Europe/Stockholm'), '2026-06-16T00:00');
  });

  it('produces a string in YYYY-MM-DDTHH:MM format', () => {
    const d = new Date('2026-03-01T12:30:00Z');
    const result = localTs(d, 'UTC');
    assert.match(result, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('handles DST transition (Sweden clocks forward at 02:00 on last Sunday of March)', () => {
    // 2026-03-29 01:00 UTC → 03:00 Stockholm (jumped from CET to CEST)
    const d = new Date('2026-03-29T01:00:00Z');
    assert.equal(localTs(d, 'Europe/Stockholm'), '2026-03-29T03:00');
  });
});

// ---------------------------------------------------------------------------
describe('parseTs', () => {
  it('parses year, month, day, hour correctly', () => {
    assert.deepEqual(parseTs('2026-04-12T14:30'), { year: 2026, month: 4, day: 12, hour: 14 });
  });

  it('parses midnight correctly', () => {
    assert.deepEqual(parseTs('2026-01-01T00:00'), { year: 2026, month: 1, day: 1, hour: 0 });
  });

  it('parses end-of-day correctly', () => {
    assert.deepEqual(parseTs('2026-12-31T23:59'), { year: 2026, month: 12, day: 31, hour: 23 });
  });
});

// ---------------------------------------------------------------------------
describe('dayOfYear', () => {
  it('Jan 1 is day 1', () => {
    assert.equal(dayOfYear(1, 1), 1);
  });

  it('Jan 31 is day 31', () => {
    assert.equal(dayOfYear(1, 31), 31);
  });

  it('Feb 1 is day 32', () => {
    assert.equal(dayOfYear(2, 1), 32);
  });

  it('Dec 31 is day 365', () => {
    assert.equal(dayOfYear(12, 31), 365);
  });

  it('Jul 1 is day 182', () => {
    assert.equal(dayOfYear(7, 1), 182);
  });
});

// ---------------------------------------------------------------------------
describe('doyToMonthDay', () => {
  it('round-trips with dayOfYear for all days of the year', () => {
    for (const { month, day } of CALENDAR_DATES) {
      const doy = dayOfYear(month, day);
      const result = doyToMonthDay(doy);
      assert.deepEqual(result, { month, day },
        `round-trip failed for month=${month}, day=${day} (doy=${doy})`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('calendarDayDistance', () => {
  it('same date → distance 0', () => {
    assert.equal(calendarDayDistance(6, 15, 6, 15), 0);
  });

  it('adjacent days → distance 1', () => {
    assert.equal(calendarDayDistance(1, 1, 1, 2), 1);
  });

  it('picks the shorter path across year boundary', () => {
    // Jan 1 to Dec 31: direct = 364 days, wrap = 1 day → should return 1
    assert.equal(calendarDayDistance(1, 1, 12, 31), 1);
  });

  it('Jun 15 to Dec 15 = 183 days direct, 182 wrap → returns 182', () => {
    // dayOfYear(6,15)=166, dayOfYear(12,15)=349, diff=183, wrap=365-183=182
    assert.equal(calendarDayDistance(6, 15, 12, 15), 182);
  });

  it('is symmetric', () => {
    const a = calendarDayDistance(3, 10, 9, 20);
    const b = calendarDayDistance(9, 20, 3, 10);
    assert.equal(a, b);
  });

  it('maximum distance is at most 182', () => {
    for (const a of CALENDAR_DATES) {
      for (const b of CALENDAR_DATES) {
        const d = calendarDayDistance(a.month, a.day, b.month, b.day);
        assert.ok(d <= 182, `distance ${d} exceeds 182 for ${a.month}-${a.day} vs ${b.month}-${b.day}`);
      }
    }
  });
});
