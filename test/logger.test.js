// Checks log levels and plugin-name prefixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../lib/logger.js';

test('lines below the level are dropped', () => {
  const lines = [];
  const log = createLogger('warn', '', l => lines.push(l));
  log.error('e'); log.warn('w'); log.info('i'); log.debug('d');
  assert.equal(lines.length, 2);
});

test('child loggers add the plugin name in brackets and keep the level', () => {
  const lines = [];
  const log = createLogger('info', '', l => lines.push(l)).child('Immich');
  log.info('connected'); log.debug('hidden');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /INFO  \[Immich\] connected$/);
});

test('an unknown level falls back to info', () => {
  const lines = [];
  const log = createLogger('loud', '', l => lines.push(l));
  log.info('i'); log.debug('d');
  assert.equal(lines.length, 1);
});
