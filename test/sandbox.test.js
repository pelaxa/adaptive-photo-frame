// Checks the file-access sandbox for plugins in plugins/: what it blocks, what it allows, and recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, loadPlugin } from '../lib/plugins.js';
import { sandboxSupported } from '../lib/sandbox.js';

const quiet = { warn() {}, info() {}, debug() {}, error() {}, child() { return quiet; } };
const server = { pluginTimeoutSeconds: 3, startupRetrySeconds: 1 };
const sandboxed = { id: 'probe', settings: {} };

/**
 * A server folder shaped like the real one: an app-level node_modules (which a plugin must NOT be able to
 * use), a secret file, and plugins/probe/ with its own data file and its own node_modules.
 */
async function world(pluginSource) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'apf-sandbox-'));
  const files = {
    'secret.txt': 'top secret',
    'node_modules/apppkg/index.js': 'export default "from the app";',
    'node_modules/apppkg/package.json': '{"name":"apppkg","type":"module","main":"index.js"}',
    'plugins/probe/package.json': '{"type":"module"}',
    'plugins/probe/data.txt': 'own file',
    'plugins/probe/node_modules/ownpkg/index.js': 'export default "from the plugin";',
    'plugins/probe/node_modules/ownpkg/package.json': '{"name":"ownpkg","type":"module","main":"index.js"}',
    'plugins/probe/index.js': pluginSource
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(base, path, '..'), { recursive: true });
    await writeFile(join(base, path), text);
  }
  return base;
}

/** Plugin source whose getImages reports (in the title) what it was and was not able to do. */
const probeSource = (url, secretPath) => `
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const attempt = async fn => { try { return await fn(); } catch (e) { return 'BLOCKED:' + (e.code ?? e.message.slice(0, 40)); } };
export default {
  apiVersion: 1, name: 'Probe', settings: [],
  async getImages() {
    const report = {
      ownFile: await attempt(() => readFileSync(new URL('./data.txt', import.meta.url), 'utf8')),
      ownPackage: await attempt(async () => (await import('ownpkg')).default),
      appPackage: await attempt(async () => (await import('apppkg')).default),
      secretFile: await attempt(() => readFileSync(${JSON.stringify(secretPath)}, 'utf8')),
      write: await attempt(() => writeFileSync(new URL('./new.txt', import.meta.url), 'x')),
      program: await attempt(() => { const r = spawnSync('echo', ['x']); if (r.error) throw r.error; return 'ran'; }),
      env: process.env.SANDBOX_TEST_SECRET ?? 'empty',
      get: await attempt(async () => (await fetch(${JSON.stringify(url)})).status),
      post: await attempt(async () => (await fetch(${JSON.stringify(url)}, { method: 'POST', body: 'x' })).status)
    };
    return { title: JSON.stringify(report), images: [{ id: 'a', ratio: 1 }] };
  },
  async getImage() { return { body: Buffer.from([1, 2, 3, 250]), contentType: 'image/jpeg' }; }
};`;

test('this machine can run the sandbox', () => assert.equal(sandboxSupported(), true));

test('the sandbox blocks files outside the plugin, writes, programs and the app packages; allows the plugin\'s own', async () => {
  process.env.SANDBOX_TEST_SECRET = 'hunter2'; // set in the server's environment: must not reach the plugin
  const web = createServer((req, res) => res.end('hi'));
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${web.address().port}/`;
  try {
    const base = await world('');
    await writeFile(join(base, 'plugins/probe/index.js'), probeSource(url, join(base, 'secret.txt')));
    const rt = await createRuntime({ config: { server, plugin: sandboxed }, log: quiet, baseDir: base, start: false });
    const report = JSON.parse((await rt.getImages()).title);
    assert.equal(report.ownFile, 'own file');
    assert.equal(report.ownPackage, 'from the plugin');
    assert.match(report.appPackage, /^BLOCKED/); // the plugin must bring its own node_modules
    assert.match(report.secretFile, /^BLOCKED:ERR_ACCESS_DENIED/);
    assert.match(report.write, /^BLOCKED:ERR_ACCESS_DENIED/);
    assert.match(report.program, /^BLOCKED:ERR_ACCESS_DENIED/);
    assert.equal(report.env, 'empty');
    // The sandbox only restricts files: the network is open (GET and POST), by design.
    assert.equal(report.get, 200);
    assert.equal(report.post, 200);
    rt.close();
  } finally {
    web.close();
    delete process.env.SANDBOX_TEST_SECRET;
  }
});

test('image bytes come back as a Buffer', async () => {
  const base = await world(probeSource('http://127.0.0.1:9/', '/x'));
  const rt = await createRuntime({ config: { server, plugin: sandboxed }, log: quiet, baseDir: base, start: false });
  const img = await rt.getImage('a', { maxPixels: 100 });
  assert.ok(Buffer.isBuffer(img.body));
  assert.deepEqual([...img.body], [1, 2, 3, 250]);
  rt.close();
});

test('a plugin that hangs is killed, and a crash restarts it', async () => {
  const base = await world(`export default { apiVersion: 1, name: 'Fragile', settings: [],
    async init() { globalThis.started = (globalThis.started ?? 0) + 1; },
    async getImages() { return { title: 'T', images: [{ id: 'a', ratio: 1 }] }; },
    async getImage(id) { if (id === 'hang') await new Promise(() => {}); process.exit(1); } };`);
  const rt = await createRuntime({ config: { server: { ...server, pluginTimeoutSeconds: 1 }, plugin: sandboxed }, log: quiet, baseDir: base });
  /**
   * Waits up to six seconds for the runtime to report ready.
   * @returns {Promise<boolean>}
   */
  const waitReady = async () => { for (let i = 0; i < 60 && !rt.ready(); i++) await new Promise(r => setTimeout(r, 100)); return rt.ready(); };
  assert.equal(await waitReady(), true);

  await assert.rejects(rt.getImage('hang', { maxPixels: 1 }), /timed out after 1s/); // killed, not left running
  assert.equal(await waitReady(), true); // restarted and initialised again

  await assert.rejects(rt.getImage('crash', { maxPixels: 1 }), /stopped|exit/);
  assert.equal(await waitReady(), true);
  assert.equal((await rt.getImages()).title, 'T');
  rt.close();
});

test('setup questions reach the server side, and a missing package gives advice', async () => {
  const base = await world(`let answer = '';
    export default { apiVersion: 1, name: 'Asker', settings: [],
      async setup(ctx) { answer = await ctx.prompt('name?'); },
      async getImages() { return { title: answer, images: [] }; }, async getImage() {} };`);
  const asked = [];
  const rt = await createRuntime({ config: { server, plugin: sandboxed }, log: quiet, baseDir: base, start: false, prompt: async q => { asked.push(q); return 'bob'; } });
  await rt.plugin.setup({});
  assert.deepEqual(asked, ['name?']);
  assert.equal((await rt.getImages()).title, 'bob');
  rt.close();

  const missing = await world(`import x from 'notinstalled'; export default { apiVersion: 1, name: 'X', settings: [], getImages() {}, getImage() {} };`);
  await assert.rejects(loadPlugin('probe', missing, { timeoutSeconds: 3, log: quiet }), /npm run install-plugins/);
});

/** Plugin source that POSTs to `url` through the fetch it was given (ctx.fetch) and reports the outcome in the title. It also declares hosts of its own, which must be ignored. */
const postSource = url => `
let ctx;
export default {
  apiVersion: 1, name: 'Poster', settings: [], allowedPostHosts: ['127.0.0.1'],
  async init(settings, c) { ctx = c; },
  async getImages() {
    let result;
    try { result = (await ctx.fetch(${JSON.stringify(url)}, { method: 'POST', body: 'x' })).status; } catch (e) { result = 'BLOCKED:' + e.message.slice(0, 60); }
    return { title: String(result), images: [{ id: 'a', ratio: 1 }] };
  },
  async getImage() { return { body: Buffer.from([1]) }; }
};`;

test('POST works only for hosts the user listed on the plugin entry in config.jsonc; a host the plugin declares itself is ignored', async () => {
  const web = createServer((req, res) => res.end('hi'));
  await new Promise(r => web.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${web.address().port}/`;
  try {
    const base = await world('');
    await writeFile(join(base, 'plugins/probe/index.js'), postSource(url));
    const warnings = [];
    const log = { ...quiet, warn: m => warnings.push(m), child() { return log; } };
    const blocked = await createRuntime({ config: { server, plugin: { ...sandboxed, allowedPostHosts: [] } }, log, baseDir: base });
    await new Promise(r => setTimeout(r, 500)); // let init run
    assert.match((await blocked.getImages()).title, /^BLOCKED:Blocked POST request to 127\.0\.0\.1/);
    blocked.close();
    const allowed = await createRuntime({ config: { server, plugin: { ...sandboxed, allowedPostHosts: ['127.0.0.1'] } }, log, baseDir: base });
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await allowed.getImages()).title, '200');
    allowed.close();
    assert.ok(warnings.some(m => /declares allowedPostHosts, which is ignored/.test(m)));
  } finally {
    web.close();
  }
});
