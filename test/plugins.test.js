// Checks plugin lookup, apiVersion handling, contract validation and the image list cache/timeouts.
// Every plugin runs in the sandbox, so these tests start real plugin processes; sandbox.test.js covers what the sandbox blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin, resolvePlugin, createRuntime, normalizeImages, PluginError } from '../lib/plugins.js';

const quiet = { warn() {}, info() {}, debug() {}, error() {}, child() { return quiet; } };

/** A plugin module's source text, with overridable parts. */
const source = (over = {}) => `export default {
  apiVersion: 1, name: 'Test', settings: [{ key: 'n', type: 'number', default: 1, description: 'n' }],
  async init() {}, async getImages() { return { title: 'T', images: [{ id: 'a', ratio: 1.5 }] }; },
  async getImage() { return { body: Buffer.from('x'), contentType: 'image/jpeg' }; },
  ...${JSON.stringify(over)} };`;

/** Makes a temporary server folder containing the given plugin files. */
async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'apf-plugins-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

const config = { server: { pluginTimeoutSeconds: 1, startupRetrySeconds: 1 }, plugin: { id: 'test', settings: {} } };

test('ids resolve to plugins/<id>/index.js and plugins/<id>.js', async () => {
  const dir = await fixture({ 'plugins/b.js': source(), 'plugins/c/index.js': source() });
  assert.ok((await resolvePlugin('b', dir)).file.endsWith('b.js'));
  assert.ok((await resolvePlugin('c', dir)).file.endsWith('index.js'));
});

test('ids are found in builtin-plugins/ (shipped) and plugins/ (user); the same id in both is refused', async () => {
  const dir = await fixture({ 'builtin-plugins/shipped/index.js': source(), 'plugins/mine/index.js': source(), 'builtin-plugins/both/index.js': source(), 'plugins/both/index.js': source() });
  assert.ok((await resolvePlugin('shipped', dir)).file.includes('builtin-plugins'));
  assert.ok((await resolvePlugin('mine', dir)).file.includes('plugins'));
  await assert.rejects(resolvePlugin('both', dir), /ambiguous/);
});

test('only builtin-plugins/ and plugins/ are searched: a providers/ folder is not looked at', async () => {
  const dir = await fixture({ 'providers/old/index.js': source() });
  await assert.rejects(resolvePlugin('old', dir), /not found/);
});

test('missing, invalid and ambiguous ids are refused', async () => {
  const dir = await fixture({ 'plugins/dup/index.js': source(), 'plugins/dup.js': source() });
  await assert.rejects(resolvePlugin('nope', dir), /not found/);
  await assert.rejects(resolvePlugin('../x', dir), /Invalid plugin id/);
  await assert.rejects(resolvePlugin('dup', dir), /ambiguous/);
});

test('unknown apiVersion is refused with the supported versions', async () => {
  const dir = await fixture({ 'plugins/new.js': source({ apiVersion: 99 }) });
  await assert.rejects(loadPlugin('new', dir), /apiVersion 99; this server supports 1/);
});

test('contract problems are named', async () => {
  const dir = await fixture({ 'plugins/noname.js': source({ name: '' }), 'plugins/nosettings.js': source({ settings: 5 }), 'plugins/bad.js': 'export default {apiVersion:1,name:"x",settings:[]}' });
  await assert.rejects(loadPlugin('noname', dir), /"name" must be text/);
  await assert.rejects(loadPlugin('nosettings', dir), /"settings" must be a list/);
  await assert.rejects(loadPlugin('bad', dir), /missing required function getImages/);
});

test('runtime starts the plugin, validates settings and serves a cleaned album', async () => {
  const dir = await fixture({ 'plugins/test.js': source() });
  const rt = await createRuntime({ config, log: quiet, baseDir: dir });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(rt.ready(), true);
  assert.deepEqual(rt.settings, { n: 1 });
  assert.deepEqual((await rt.getImages()).images, [{ id: 'a', ratio: 1.5 }]);
  assert.equal(rt.getUploadUrl(), null);
  rt.close();
});

test('settings errors stop start-up with the setting name', async () => {
  const dir = await fixture({ 'plugins/test.js': source() });
  const bad = { ...config, plugin: { id: 'test', settings: { n: 'x' } } };
  await assert.rejects(createRuntime({ config: bad, log: quiet, baseDir: dir }), /settings\.n must be a number/);
});

test('a plugin that hangs is timed out', async () => {
  const dir = await fixture({ 'plugins/test.js': source().replace('async getImages() {', 'async getImages() { await new Promise(() => {});') });
  const rt = await createRuntime({ config, log: quiet, baseDir: dir, start: false });
  await assert.rejects(rt.getImages(), /getImages timed out after 1s/);
  rt.close();
});

test('invalid and duplicate photo entries are dropped', () => {
  const warned = [];
  const out = normalizeImages({ title: 'T', images: [{ id: 'a', ratio: 1 }, { id: 'a', ratio: 1 }, { id: 'b', ratio: 0 }, { id: 5, ratio: 1 }, { id: 'c', ratio: 2 }] }, { warn: m => warned.push(m) });
  assert.deepEqual(out.images.map(i => i.id), ['a', 'c']);
  assert.equal(warned.length, 1);
  assert.throws(() => normalizeImages({ title: 'T' }, quiet), /must return/);
});

test('the order a plugin asks for is passed on; anything else is random', () => {
  const warned = [];
  const log = { warn: m => warned.push(m) };
  assert.equal(normalizeImages({ title: 'T', images: [], order: 'sequence' }, log).order, 'sequence');
  assert.equal(normalizeImages({ title: 'T', images: [] }, log).order, 'random');
  assert.equal(warned.length, 0);
  assert.equal(normalizeImages({ title: 'T', images: [], order: 'sideways' }, log).order, 'random');
  assert.match(warned[0], /unknown order "sideways"/);
});

test('normalizeImages keeps the optional caption facts that are text and drops the rest', () => {
  const out = normalizeImages({ title: 'T', images: [{ id: 'a', ratio: 1, date: '2021-03-05T10:00:00', city: 'Paris', state: '', country: 5, extra: 'x' }] }, { warn() {} });
  assert.deepEqual(out.images, [{ id: 'a', ratio: 1, date: '2021-03-05T10:00:00', city: 'Paris' }]);
});
