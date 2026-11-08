// Checks config.jsonc parsing, validation and plugin selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../lib/config.js';

const log = { warn() {} };
const plugin = '{ "id": "immich", "settings": { "url": "u" } }';

test('comments and trailing commas are allowed; defaults fill the gaps', () => {
  const c = parseConfig(`{ // comment\n "plugins": [${plugin},], }`, log);
  assert.equal(c.server.port, 3000);
  assert.equal(c.display.maxPhotos, 12);
  assert.equal(c.display.panoramaChance, 0.2);
  assert.deepEqual(c.qr, { enabled: true, position: 'bottom-left', text: 'Scan to upload' });
});

test('the first enabled plugin wins; disabled ones are skipped', () => {
  const c = parseConfig(`{ "plugins": [
    { "id": "folder", "enabled": false },
    { "id": "immich", "enabled": true, "settings": { "url": "a" } },
    { "id": "other", "enabled": true } ] }`, log);
  assert.equal(c.plugin.id, 'immich');
  assert.deepEqual(c.plugin.settings, { url: 'a' });
});

test('no enabled plugin is an error', () => {
  assert.throws(() => parseConfig('{ "plugins": [{ "id": "a", "enabled": false }] }', log), /no plugin is enabled/);
  assert.throws(() => parseConfig('{ "plugins": [] }', log), /no plugin is enabled/);
});

test('syntax errors report line and column', () => {
  assert.throws(() => parseConfig('{\n  "server": { "port": }\n}', log), /config\.jsonc:2:\d+/);
});

test('bad values name the setting; ids are checked', () => {
  assert.throws(() => parseConfig(`{ "server": { "port": "80" }, "plugins": [${plugin}] }`, log), /server\.port must be a number/);
  assert.throws(() => parseConfig('{ "plugins": [{ "id": "../evil" }] }', log), /plugins\[0\]\.id/);
  assert.equal(parseConfig('{ "plugins": [{ "id": "immich-sharedAlbum" }] }', log).plugin.id, 'immich-sharedAlbum'); // ids may use capitals
  assert.throws(() => parseConfig('{ "plugins": [{ "id": "a", "enabled": "yes" }] }', log), ConfigError);
});

test('minPhotos can never exceed maxPhotos', () => {
  const c = parseConfig(`{ "display": { "minPhotos": 30, "maxPhotos": 5 }, "plugins": [${plugin}] }`, log);
  assert.equal(c.display.minPhotos, 5);
});

test('"sandbox" is not a setting: plugins are always sandboxed, so any use of it is an error', () => {
  assert.throws(() => parseConfig('{ "plugins": [{ "id": "a", "sandbox": false }] }', log), /plugins\[0\]\.sandbox is not a setting/);
  assert.throws(() => parseConfig('{ "plugins": [{ "id": "a", "sandbox": true }] }', log), /always sandboxed/);
});

test('the clock has defaults and is checked', () => {
  const c = parseConfig(`{ "plugins": [${plugin}] }`, log);
  assert.deepEqual([c.clock.enabled, c.clock.position, c.clock.showDate, c.clock.showTime, c.clock.dateFormat, c.clock.timeFormat, c.clock.showSeconds, c.clock.locale],
    [true, 'top-left', true, true, 'full', 'auto', false, '']);
  assert.equal(parseConfig(`{ "clock": { "position": "bottom-right", "timeFormat": "24h" }, "plugins": [${plugin}] }`, log).clock.timeFormat, '24h');
  assert.throws(() => parseConfig(`{ "clock": { "position": "middle" }, "plugins": [${plugin}] }`, log), /clock\.position/);
  assert.throws(() => parseConfig(`{ "clock": { "dateFormat": "dd/mm" }, "plugins": [${plugin}] }`, log), /clock\.dateFormat/);
  assert.throws(() => parseConfig(`{ "clock": { "showDate": false, "showTime": false }, "plugins": [${plugin}] }`, log), /would show nothing/);
  assert.doesNotThrow(() => parseConfig(`{ "clock": { "enabled": false, "showDate": false, "showTime": false }, "plugins": [${plugin}] }`, log));
  assert.throws(() => parseConfig(`{ "clock": { "locale": "not a locale!" }, "plugins": [${plugin}] }`, log), /clock\.locale/);
});

test('the old qr.color and qr.background are ignored with a warning that points to custom.css', () => {
  const warnings = [];
  const c = parseConfig(`{ "qr": { "position": "top-right", "color": "#000", "background": "white" }, "plugins": [${plugin}] }`, { ...log, warn: m => warnings.push(m) });
  assert.deepEqual(c.qr, { enabled: true, position: 'top-right', text: 'Scan to upload' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /qr\.color and qr\.background are no longer a setting.*custom\.example\.css/);
});

test('burn-in protection is off by default and has no interval setting', () => {
  assert.equal(parseConfig(`{ "plugins": [${plugin}] }`, log).display.burnInProtection, false);
  assert.equal(parseConfig(`{ "display": { "burnInProtection": true }, "plugins": [${plugin}] }`, log).display.burnInProtection, true);
  const warnings = [];
  parseConfig(`{ "display": { "burnInMinutes": 5 }, "plugins": [${plugin}] }`, { warn: m => warnings.push(m) });
  assert.ok(warnings.some(w => /burnInMinutes/.test(w)), 'the interval is fixed, so a setting for it is flagged as unknown');
});
