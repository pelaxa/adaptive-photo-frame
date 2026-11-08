// Checks the read-only fetch handed to plugins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedFetch } from '../lib/guardedFetch.js';

const calls = [];
/**
 * A stand-in fetch that records the address and method it was called with.
 * @param {string | URL} url - The address.
 * @param {{method?: string}} [opts] - Request options.
 * @returns {Promise<string>} Always 'ok'.
 */
const fake = async (url, opts) => { calls.push([String(url), opts?.method]); return 'ok'; };

test('GET passes through', async () => {
  assert.equal(await createGuardedFetch([], fake)('https://a.test/x'), 'ok');
});

test('non-GET requests are blocked', () => {
  const guarded = createGuardedFetch([], fake);
  for (const method of ['POST', 'put', 'DELETE', 'PATCH']) {
    assert.throws(() => guarded('https://a.test/x', { method }), /Blocked/);
  }
});

test('POST is allowed only to hosts the plugin declared', async () => {
  const guarded = createGuardedFetch(['search.test'], fake);
  assert.equal(await guarded('https://search.test/q', { method: 'POST' }), 'ok');
  assert.throws(() => guarded('https://other.test/q', { method: 'POST' }), /Blocked POST request to other\.test/);
});
