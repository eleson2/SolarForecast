import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseYrData } from '../yr-parser.js';

// ---------------------------------------------------------------------------
// Minimal YR /complete response builder
// ---------------------------------------------------------------------------

function makeEntry(utcTime, cloud, fog) {
  const details = {};
  if (cloud !== undefined) details.cloud_area_fraction = cloud;
  if (fog   !== undefined) details.fog_area_fraction   = fog;
  return { time: utcTime, data: { instant: { details } } };
}

function makeYrResponse(entries) {
  return { properties: { timeseries: entries } };
}

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

describe('yr-parser — module contract', () => {
  it('exports parseYrData as a function', () => {
    assert.equal(typeof parseYrData, 'function');
  });
});

// ---------------------------------------------------------------------------
// Invalid / missing response
// ---------------------------------------------------------------------------

describe('yr-parser — invalid input', () => {
  it('throws on null input', () => {
    assert.throws(() => parseYrData(null, () => {}),
      /Invalid YR response/);
  });

  it('throws when timeseries is missing', () => {
    assert.throws(() => parseYrData({ properties: {} }, () => {}),
      /Invalid YR response/);
  });

  it('throws when properties is missing', () => {
    assert.throws(() => parseYrData({}, () => {}),
      /Invalid YR response/);
  });
});

// ---------------------------------------------------------------------------
// Row extraction
// ---------------------------------------------------------------------------

describe('yr-parser — row extraction', () => {
  it('extracts cloud and fog from a valid on-the-hour entry', () => {
    const data = makeYrResponse([
      makeEntry('2026-05-03T08:00:00Z', 75, 10),
    ]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.equal(captured.length, 1);
    const [hourTs, cloud, fog] = captured[0];
    assert.equal(cloud, 75);
    assert.equal(fog, 10);
  });

  it('converts UTC timestamp to Europe/Stockholm local time (winter UTC+1)', () => {
    // 2026-01-15T07:00:00Z → 2026-01-15T08:00 in Stockholm (CET, UTC+1)
    const data = makeYrResponse([
      makeEntry('2026-01-15T07:00:00Z', 50, 0),
    ]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.equal(captured[0][0], '2026-01-15T08:00');
  });

  it('converts UTC timestamp to Europe/Stockholm local time (summer UTC+2)', () => {
    // 2026-06-15T10:00:00Z → 2026-06-15T12:00 in Stockholm (CEST, UTC+2)
    const data = makeYrResponse([
      makeEntry('2026-06-15T10:00:00Z', 20, 0),
    ]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.equal(captured[0][0], '2026-06-15T12:00');
  });

  it('accepts entry with cloud only (fog absent)', () => {
    const data = makeYrResponse([
      makeEntry('2026-05-03T08:00:00Z', 60, undefined),
    ]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.equal(captured.length, 1);
    const [, cloud, fog] = captured[0];
    assert.equal(cloud, 60);
    assert.equal(fog, null);
  });

  it('accepts entry with fog only (cloud absent)', () => {
    const data = makeYrResponse([
      makeEntry('2026-05-03T08:00:00Z', undefined, 45),
    ]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.equal(captured.length, 1);
    const [, cloud, fog] = captured[0];
    assert.equal(cloud, null);
    assert.equal(fog, 45);
  });

  it('processes multiple entries and returns the correct count', () => {
    const data = makeYrResponse([
      makeEntry('2026-05-03T08:00:00Z', 10, 0),
      makeEntry('2026-05-03T09:00:00Z', 20, 5),
      makeEntry('2026-05-03T10:00:00Z', 30, 0),
    ]);
    let captured;
    const count = parseYrData(data, rows => { captured = rows; });
    assert.equal(count, 3);
    assert.equal(captured.length, 3);
  });

  it('returns 0 and calls storeFn with empty array when all entries are filtered', () => {
    const data = makeYrResponse([
      makeEntry('2026-05-03T08:30:00Z', 50, 10), // sub-hourly — filtered
    ]);
    let captured;
    const count = parseYrData(data, rows => { captured = rows; });
    assert.equal(count, 0);
    assert.deepEqual(captured, []);
  });
});

// ---------------------------------------------------------------------------
// Sub-hourly filtering
// ---------------------------------------------------------------------------

describe('yr-parser — sub-hourly filtering', () => {
  it('skips entries with minutes != 00', () => {
    const data = makeYrResponse([
      makeEntry('2026-05-03T08:30:00Z', 50, 0),  // :30 — skip
      makeEntry('2026-05-03T09:00:00Z', 60, 0),  // :00 — keep
    ]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.equal(captured.length, 1);
  });

  it('skips entries with seconds != 00', () => {
    const data = makeYrResponse([
      makeEntry('2026-05-03T08:00:30Z', 50, 0),  // :00:30 — skip
      makeEntry('2026-05-03T09:00:00Z', 60, 0),  // :00:00 — keep
    ]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.equal(captured.length, 1);
  });

  it('keeps all 24 on-the-hour entries from a full day', () => {
    const entries = Array.from({ length: 24 }, (_, h) => {
      const hh = String(h).padStart(2, '0');
      return makeEntry(`2026-05-03T${hh}:00:00Z`, h, 0);
    });
    const data = makeYrResponse(entries);
    let captured;
    const count = parseYrData(data, rows => { captured = rows; });
    assert.equal(count, 24);
  });
});

// ---------------------------------------------------------------------------
// Both-null filtering
// ---------------------------------------------------------------------------

describe('yr-parser — both-null filtering', () => {
  it('skips entry where both cloud and fog are absent', () => {
    const data = makeYrResponse([
      makeEntry('2026-05-03T08:00:00Z'),           // no cloud, no fog
      makeEntry('2026-05-03T09:00:00Z', 50, 0),   // has cloud + fog — keep
    ]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.equal(captured.length, 1);
  });

  it('skips entry where details is missing entirely', () => {
    const entry = { time: '2026-05-03T08:00:00Z', data: { instant: {} } };
    const data = makeYrResponse([entry]);
    let captured;
    parseYrData(data, rows => { captured = rows; });
    assert.deepEqual(captured, []);
  });
});
