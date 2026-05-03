import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveRaw } from '../fetcher.js';

const RAW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/raw');
const createdFiles = [];

after(() => {
  for (const f of createdFiles) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
});

describe('saveRaw', () => {
  it('returns a filename with the given prefix', () => {
    const filename = saveRaw('yr', { test: true });
    createdFiles.push(path.join(RAW_DIR, filename));
    assert.ok(filename.startsWith('yr_'), `expected "yr_" prefix, got "${filename}"`);
  });

  it('returns a filename ending in .json', () => {
    const filename = saveRaw('openmeteo', {});
    createdFiles.push(path.join(RAW_DIR, filename));
    assert.ok(filename.endsWith('.json'));
  });

  it('filename matches expected pattern PREFIX_YYYYMMDD_HHMMSS.json', () => {
    const filename = saveRaw('test', {});
    createdFiles.push(path.join(RAW_DIR, filename));
    assert.match(filename, /^test_\d{8}_\d{6}\.json$/);
  });

  it('writes valid JSON to the raw directory', () => {
    const payload = { source: 'yr', values: [1, 2, 3] };
    const filename = saveRaw('yr', payload);
    const fullPath = path.join(RAW_DIR, filename);
    createdFiles.push(fullPath);
    const written = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    assert.deepEqual(written, payload);
  });

  it('composite prefix (prices_elprisetjust_2026-05-03) works correctly', () => {
    const filename = saveRaw('prices_elprisetjust_2026-05-03', { raw: [] });
    createdFiles.push(path.join(RAW_DIR, filename));
    assert.ok(filename.startsWith('prices_elprisetjust_2026-05-03_'));
    assert.ok(filename.endsWith('.json'));
  });
});
