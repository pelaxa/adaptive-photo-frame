// Checks how settings are validated (used for both config.jsonc and plugin settings).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettings, maskSecrets, SettingsError } from '../lib/settings.js';

const warnings = [];
const log = { warn: m => warnings.push(m) };
const specs = [
  { key: 'url', type: 'string', required: true, description: 'address' },
  { key: 'count', type: 'number', default: 5, min: 1, max: 10, integer: true, description: 'n' },
  { key: 'on', type: 'boolean', default: true, description: 'flag' },
  { key: 'mode', type: 'enum', values: ['a', 'b'], default: 'a', description: 'mode' },
  { key: 'tint', type: 'color', values: ['blur'], default: 'blur', description: 'colour' },
  { key: 'key', type: 'string', secret: true, description: 'secret' }
];

test('defaults are applied and optional settings without default are left out', () => {
  const s = readSettings(specs, { url: 'x' }, 'p', log);
  assert.deepEqual(s, { url: 'x', count: 5, on: true, mode: 'a', tint: 'blur' });
});

test('a missing required setting names the setting', () => {
  assert.throws(() => readSettings(specs, {}, 'plugins.x', log), /plugins\.x\.url is required/);
});

test('wrong types are rejected with the setting name', () => {
  assert.throws(() => readSettings(specs, { url: 1 }, 'p', log), /p\.url must be text/);
  assert.throws(() => readSettings(specs, { url: 'x', count: '5' }, 'p', log), /p\.count must be a number/);
  assert.throws(() => readSettings(specs, { url: 'x', on: 'yes' }, 'p', log), /true or false/);
  assert.throws(() => readSettings(specs, { url: 'x', mode: 'c' }, 'p', log), /one of a, b/);
  assert.throws(() => readSettings(specs, { url: 'x', tint: 'red;x' }, 'p', log), /colour/);
});

test('out-of-range numbers are clamped with a warning, and rounded when integer', () => {
  warnings.length = 0;
  assert.equal(readSettings(specs, { url: 'x', count: 99 }, 'p', log).count, 10);
  assert.equal(readSettings(specs, { url: 'x', count: 2.6 }, 'p', log).count, 3);
  assert.match(warnings[0], /outside 1-10/);
});

test('colours accept hex codes, names and the extra allowed words', () => {
  assert.equal(readSettings(specs, { url: 'x', tint: '#3B4E31' }, 'p', log).tint, '#3B4E31');
  assert.equal(readSettings(specs, { url: 'x', tint: 'white' }, 'p', log).tint, 'white');
});

test('unknown keys only produce a warning', () => {
  warnings.length = 0;
  readSettings(specs, { url: 'x', urll: 'typo' }, 'p', log);
  assert.match(warnings[0], /p\.urll is not a known setting/);
});

test('secrets are masked for logging', () => {
  assert.deepEqual(maskSecrets(specs, { url: 'x', key: 'abc' }), { url: 'x', key: '****' });
});

test('settings must be an object', () => {
  assert.throws(() => readSettings(specs, [], 'p', log), SettingsError);
});

test('an object setting is checked field by field, and its defaults fill in what is missing', () => {
  const group = [{
    key: 'order', type: 'object', description: 'order', fields: [
      { key: 'by', type: 'string', default: 'random', description: 'field' },
      { key: 'sort', type: 'enum', values: ['asc', 'desc'], default: 'desc', description: 'direction' }
    ]
  }];
  assert.deepEqual(readSettings(group, undefined, 'p', log), { order: { by: 'random', sort: 'desc' } }); // missing object
  assert.deepEqual(readSettings(group, { order: { by: 'iso' } }, 'p', log), { order: { by: 'iso', sort: 'desc' } }); // partial
  assert.throws(() => readSettings(group, { order: 'iso' }, 'p', log), /p\.order must be an object/);
  assert.throws(() => readSettings(group, { order: { sort: 'sideways' } }, 'p', log), /p\.order\.sort must be one of asc, desc/);
  warnings.length = 0;
  readSettings(group, { order: { byy: 'typo' } }, 'p', log);
  assert.match(warnings[0], /p\.order\.byy is not a known setting/);
});

test('a list setting takes a list of non-empty text values and trims them', () => {
  const specs = [{ key: 'names', type: 'list', default: [], description: 'x' }];
  assert.deepEqual(readSettings(specs, undefined, 'p', { warn() {} }), { names: [] });
  assert.deepEqual(readSettings(specs, { names: [' a ', 'b'] }, 'p', { warn() {} }), { names: ['a', 'b'] });
  for (const bad of ['a', [1], [''], [' ']]) assert.throws(() => readSettings(specs, { names: bad }, 'p', { warn() {} }), /p\.names must be a list/);
});
