import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import log from '../logger.js';

// logger.js reads LOG_LEVEL at module load time, so the active level in these
// tests is whatever was set when the process started — typically 'info' in CI
// and during normal test runs (LOG_LEVEL not set).

describe('logger — module contract', () => {
  it('exports debug, info, warn, error methods', () => {
    assert.equal(typeof log.debug, 'function');
    assert.equal(typeof log.info,  'function');
    assert.equal(typeof log.warn,  'function');
    assert.equal(typeof log.error, 'function');
  });

  it('exposes isDebug as a boolean', () => {
    assert.equal(typeof log.isDebug, 'boolean');
  });

  it('isDebug is false when LOG_LEVEL is not set to debug', () => {
    // In the normal test environment LOG_LEVEL is unset → defaults to info.
    // If someone runs tests with LOG_LEVEL=debug this assertion is intentionally skipped.
    if (process.env.LOG_LEVEL?.toLowerCase() === 'debug') return;
    assert.equal(log.isDebug, false);
  });

  it('methods do not throw when called', () => {
    assert.doesNotThrow(() => log.debug('test', 'debug message'));
    assert.doesNotThrow(() => log.info ('test', 'info message'));
    assert.doesNotThrow(() => log.warn ('test', 'warn message'));
    assert.doesNotThrow(() => log.error('test', 'error message', new Error('test error')));
  });

  it('error method accepts undefined error without throwing', () => {
    assert.doesNotThrow(() => log.error('test', 'error with no err object'));
  });
});
