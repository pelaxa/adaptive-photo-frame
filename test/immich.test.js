// Checks the Immich plugin's ordering against a pretend Immich server (no network needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import immich, { EXIF_FIELDS, sortRows, resolveOrder } from '../builtin-plugins/immich-sharedAlbum/index.js';

/**
 * A pretend Immich: answers the few GET requests the plugin makes, from a list of assets.
 * @param {{id: string, ratio?: number, isImage?: boolean, fileCreatedAt?: string, exif?: object, fail?: boolean}[]} assets
 * @returns {{fetch: typeof fetch, requests: string[]}} `requests` lists every path asked for.
 */
function fakeImmich(assets) {
  const requests = [];
  /**
   * A JSON response like Immich's.
   * @param {any} body - Value to send.
   * @param {number} [status=200] - HTTP status.
   * @returns {Response}
   */
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /**
   * A stand-in fetch that answers like an Immich server and records which paths were asked for.
   * @param {string | Request} input - Address or request.
   * @returns {Promise<Response>}
   */
  const fetch = async input => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const path = url.pathname.replace('/api', '');
    requests.push(path);
    if (path.startsWith('/albums/')) return json({ albumName: 'Test album', assetCount: assets.length });
    if (path === '/timeline/buckets') return json([{ timeBucket: '2024-01-01T00:00:00.000Z', count: assets.length }]);
    if (path === '/timeline/bucket') {
      return json({
        id: assets.map(a => a.id), ratio: assets.map(a => a.ratio ?? 1.5), isImage: assets.map(a => a.isImage ?? true),
        fileCreatedAt: assets.map(a => a.fileCreatedAt ?? null), city: assets.map(a => a.city ?? null)
      });
    }
    const asset = assets.find(a => path === `/assets/${a.id}`);
    if (asset) return asset.fail ? json({ message: 'nope' }, 500) : json({ id: asset.id, exifInfo: asset.exif ?? null });
    return json({ message: 'not found' }, 404);
  };
  return { fetch, requests };
}

/** Starts the plugin on a pretend Immich with the given order.by (and optionally order.sort) setting. */
async function start(assets, by, sort) {
  const fake = fakeImmich(assets);
  const warnings = [];
  const log = { info() {}, debug() {}, error() {}, warn: m => warnings.push(m) };
  await immich.init({ url: 'https://immich.test', albumId: 'alb', shareKey: 'key', ...(by === undefined ? {} : { order: { by, ...(sort ? { sort } : {}) } }) }, { fetch: fake.fetch, log });
  return { ...fake, warnings };
}
/**
 * The ids of the images in a plugin result.
 * @param {{images: {id: string}[]}} result - What getImages returned.
 * @returns {string[]}
 */
const ids = result => result.images.map(i => i.id);

test('random is the default: the list keeps the order Immich gave, and asks for random', async () => {
  const t = await start([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }], 'random');
  const result = await immich.getImages();
  assert.equal(result.order, 'random');
  assert.deepEqual(ids(result), ['r1', 'r2', 'r3']);
  assert.equal(t.warnings.length, 0);
});

test('DateTimeOriginal (any capitalisation) orders newest first from the timeline, with no extra requests; videos are skipped', async () => {
  const t = await start([
    { id: 'd1', fileCreatedAt: '2020-05-01T10:00:00.000Z' },
    { id: 'd2', fileCreatedAt: '2023-05-01T10:00:00.000Z' },
    { id: 'd3', isImage: false, fileCreatedAt: '2024-05-01T10:00:00.000Z' },
    { id: 'd4', fileCreatedAt: '2021-05-01T10:00:00.000Z' },
    { id: 'd5' } // no date: last
  ], 'dateTIMEoriginal');
  const result = await immich.getImages();
  assert.equal(result.order, 'sequence');
  assert.deepEqual(ids(result), ['d2', 'd4', 'd1', 'd5']);
  assert.ok(t.requests.every(p => !p.startsWith('/assets/')), 'the timeline already has the date, so no per-photo requests');
});

test('another EXIF field is looked up once per photo, remembered, largest first, and missing values come last', async () => {
  const t = await start([
    { id: 'i1', exif: { iso: 200 } },
    { id: 'i2', exif: { iso: 1600 } },
    { id: 'i3', exif: {} },
    { id: 'i4', exif: { iso: 800 } },
    { id: 'i5', fail: true }
  ], 'ISO');
  const first = await immich.getImages();
  assert.deepEqual(ids(first), ['i2', 'i4', 'i1', 'i3', 'i5']);
  /**
   * The per-photo lookups the plugin made.
   * @returns {string[]} Request paths that start with /assets/.
   */
  const lookups = () => t.requests.filter(p => p.startsWith('/assets/')).length;
  assert.equal(lookups(), 5);
  await immich.getImages();
  assert.equal(lookups(), 6, 'only the photo whose lookup failed is asked about again');
});

test('a name that is not an EXIF field Immich keeps is logged as a warning and the order is random', async () => {
  const t = await start([{ id: 'w1' }, { id: 'w2' }], 'ShutterColour');
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /order.by "ShutterColour" is not an EXIF field Immich keeps.*random order/);
  const result = await immich.getImages();
  assert.equal(result.order, 'random');
  assert.deepEqual(ids(result), ['w1', 'w2']);
});

test('resolveOrder and newestFirst', () => {
  assert.deepEqual(resolveOrder('random'), { field: null, valid: true });
  assert.deepEqual(resolveOrder('FNUMBER'), { field: 'fNumber', valid: true });
  assert.deepEqual(resolveOrder('Bogus'), { field: null, valid: false });
  assert.ok(EXIF_FIELDS.includes('dateTimeOriginal'));
  const rows = [{ k: 'a', value: 1 }, { k: 'b', value: null }, { k: 'c', value: 3 }, { k: 'd', value: '2024-01-02T00:00:00Z' }, { k: 'e', value: 3 }];
  const numbers = rows.filter(r => typeof r.value !== 'string');
  assert.deepEqual(sortRows(numbers, 'desc').map(r => r.k), ['c', 'e', 'a', 'b']); // equal values keep their order; no value last
  assert.deepEqual(sortRows(numbers, 'asc').map(r => r.k), ['a', 'c', 'e', 'b']);  // ... and still last when ascending
  assert.deepEqual(sortRows([{ k: 'x', value: '2020-01-01' }, { k: 'y', value: '2024-01-01' }], 'desc').map(r => r.k), ['y', 'x']);
});

test('sort "asc" lists the oldest first, "desc" (the default) the newest first', async () => {
  const assets = [
    { id: 's1', fileCreatedAt: '2022-01-01T00:00:00.000Z' },
    { id: 's2', fileCreatedAt: '2020-01-01T00:00:00.000Z' },
    { id: 's3', fileCreatedAt: '2024-01-01T00:00:00.000Z' }
  ];
  await start(assets, 'DateTimeOriginal', 'asc');
  assert.deepEqual(ids(await immich.getImages()), ['s2', 's1', 's3']);
  await start(assets, 'DateTimeOriginal');
  assert.deepEqual(ids(await immich.getImages()), ['s3', 's1', 's2']);
});
