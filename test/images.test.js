// Checks the app's image service: format checks, resizing, URL downloads, caching and limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createImageService, prepareImage, sniff } from '../lib/images.js';

/** An in-memory image: JPEG by default; `orientation` adds an EXIF rotation tag. */
async function image(width, height, { format = 'jpeg', orientation } = {}) {
  let img = sharp({ create: { width, height, channels: 3, background: '#808080' } })[format]();
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}
/**
 * Width and height of an image.
 * @param {Buffer} bytes - The image file.
 * @returns {Promise<number[]>} [width, height].
 */
const size = async bytes => { const m = await sharp(bytes).metadata(); return [m.width, m.height]; };

test('sniff recognises JPEG, PNG and WebP by their first bytes, and nothing else', async () => {
  assert.equal(sniff(await image(8, 8)), 'jpeg');
  assert.equal(sniff(await image(8, 8, { format: 'png' })), 'png');
  assert.equal(sniff(await image(8, 8, { format: 'webp' })), 'webp');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniff(Buffer.from('<html>')), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test('an image that is small enough and upright is passed through unchanged', async () => {
  const small = await image(100, 60);
  const out = await prepareImage(small, 200);
  assert.equal(out.contentType, 'image/jpeg');
  assert.deepEqual(out.body, small);
});

test('a large image is shrunk to fit and re-encoded as JPEG, whatever it started as', async () => {
  const out = await prepareImage(await image(800, 400, { format: 'png' }), 200);
  assert.equal(out.contentType, 'image/jpeg');
  assert.deepEqual(await size(out.body), [200, 100]);
});

test('EXIF rotation is baked in, so the browser shows the photo upright', async () => {
  const out = await prepareImage(await image(100, 60, { orientation: 6 }), 500);
  assert.deepEqual(await size(out.body), [60, 100]);
  assert.equal((await sharp(out.body).metadata()).orientation, undefined);
});

test('things that are not JPEG, PNG or WebP are refused before any decoder sees them', async () => {
  await assert.rejects(prepareImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"></svg>'), 100), /not a JPEG, PNG or WebP/);
  await assert.rejects(prepareImage(Buffer.from('hello'), 100), /not a JPEG, PNG or WebP/);
  const truncated = (await image(400, 400)).subarray(0, 300); // looks like a JPEG, is not complete
  await assert.rejects(prepareImage(truncated, 100));
});

/** A service whose plugin answers with `answer(id)`; counts how often the plugin was asked. */
async function service(answer, overrides = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'apf-images-'));
  const calls = [];
  const svc = createImageService({ getImage: async (id, opts) => { calls.push(id); return answer(id, opts); }, pluginId: 'p', cacheDir, timeoutSeconds: 5, ...overrides });
  return { svc, calls, cacheDir };
}

test('bytes from a plugin are checked, resized and cached: the plugin is asked once', async () => {
  const big = await image(600, 300);
  const { svc, calls } = await service(() => ({ body: big }));
  const a = await svc.get('x', 100);
  assert.deepEqual(await size(a.body), [100, 50]);
  const b = await svc.get('x', 100);
  assert.deepEqual(b.body, a.body);
  assert.equal(calls.length, 1);
  await svc.get('x', 200); // a different size is a different cache entry
  assert.equal(calls.length, 2);
});

test('the cache is per plugin, and expires after a day', async () => {
  const img = await image(600, 300);
  const { svc, calls, cacheDir } = await service(() => ({ body: img }));
  await svc.get('x', 100);
  const other = createImageService({ getImage: async () => ({ body: img }), pluginId: 'other', cacheDir, timeoutSeconds: 5 });
  await other.get('x', 100);
  assert.equal((await readdir(cacheDir)).length, 2); // same id and size, different plugin
  const old = new Date(Date.now() - 2 * 86400_000);
  for (const f of await readdir(cacheDir)) await utimes(join(cacheDir, f), old, old);
  await svc.get('x', 100);
  assert.equal(calls.length, 2); // fetched again
});

test('viewers asking for the same image at the same time share one fetch', async () => {
  const img = await image(600, 300);
  const { svc, calls } = await service(async () => { await new Promise(r => setTimeout(r, 50)); return { body: img }; });
  await Promise.all([svc.get('x', 100), svc.get('x', 100), svc.get('x', 100)]);
  assert.equal(calls.length, 1);
});

test('a plugin answer that is neither bytes nor a URL is an error', async () => {
  const { svc } = await service(() => ({ nothing: true }));
  await assert.rejects(svc.get('x', 100), /must return \{ body: Buffer \} or \{ url: string \}/);
});

/** Starts a tiny web server for URL tests; `handler` answers requests. */
async function web(handler) {
  const server = createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('a URL from a plugin is downloaded with the headers it asked for', async () => {
  const img = await image(600, 300);
  const seen = [];
  const w = await web((req, res) => { seen.push(req.headers['x-test']); res.setHeader('content-type', 'image/jpeg'); res.end(img); });
  try {
    const { svc } = await service(() => ({ url: `${w.base}/photo`, headers: { 'x-test': 'key123' } }));
    assert.deepEqual(await size((await svc.get('x', 100)).body), [100, 50]);
    assert.deepEqual(seen, ['key123']);
  } finally { w.close(); }
});

test('download problems are reported without the address\'s query string (where keys live)', async () => {
  const w = await web((req, res) => { res.statusCode = 404; res.end('no'); });
  try {
    const { svc } = await service(() => ({ url: `${w.base}/photo?key=SECRETKEY` }));
    await assert.rejects(svc.get('x', 100), e => /answered 404/.test(e.message) && !e.message.includes('SECRETKEY'));
    const { svc: dead } = await service(() => ({ url: 'http://127.0.0.1:9/photo?key=SECRETKEY' }));
    await assert.rejects(dead.get('x', 100), e => /could not download/.test(e.message) && !e.message.includes('SECRETKEY'));
  } finally { w.close(); }
});

test('only http and https addresses are downloaded', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a.jpg', 'not a url']) {
    const { svc } = await service(() => ({ url }));
    await assert.rejects(svc.get('x', 100), /http or https|valid URL/);
  }
});

test('a download that is not an image is refused, and one that is too large is stopped', async () => {
  const w = await web((req, res) => {
    if (req.url === '/html') return res.end('<html>hi</html>');
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    /**
     * Writes 60 chunks to the response (more than the 50 MB limit), pausing whenever the connection is full.
     * @returns {void}
     */
    const more = () => { while (sent < 60) { sent++; if (!res.write(chunk)) return res.once('drain', more); } res.end(); };
    more(); // 60 MB, more than the 50 MB limit
  });
  try {
    await assert.rejects((await service(() => ({ url: `${w.base}/html` }))).svc.get('x', 100), /not a JPEG, PNG or WebP/);
    await assert.rejects((await service(() => ({ url: `${w.base}/big` }))).svc.get('x', 100), /larger than/);
  } finally { w.close(); }
});

test('a cache folder that cannot be written does not stop photos: they are served uncached, with one warning', async () => {
  const img = await image(600, 300);
  const warnings = [];
  const blocker = join(await mkdtemp(join(tmpdir(), 'apf-cache-')), 'file');
  await writeFile(blocker, 'a file, not a folder'); // a cache "folder" inside a plain file can never be created
  let asked = 0;
  const svc = createImageService({ getImage: async () => { asked++; return { body: img }; }, pluginId: 'p', cacheDir: join(blocker, 'cache'), timeoutSeconds: 5, log: { warn: m => warnings.push(m) } });
  assert.deepEqual(await size((await svc.get('a', 100)).body), [100, 50]);
  await svc.get('b', 100);
  await svc.get('a', 100);
  assert.equal(asked, 3); // nothing was cached, so every request asks the plugin again
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot write the image cache/);
});
