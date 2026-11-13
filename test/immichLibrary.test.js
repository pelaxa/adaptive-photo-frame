// Checks the Immich library plugin (albums, memories, search) against a pretend Immich server (no network needed).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { describeError, memoryDays, ratioOf, capRows, localDate, sortRows, resolveOrder, REFRESH_RETRY_MS, MEMORY_DAYS_AHEAD } from '../builtin-plugins/immich-library/index.js';

/**
 * A pretend Immich asset as memories and searches return it.
 * @param {string} id - Asset id.
 * @param {object} [extra] - Fields to override.
 * @returns {object}
 */
const asset = (id, extra = {}) => ({
  id, type: 'IMAGE', isTrashed: false, width: 3000, height: 2000, localDateTime: '2021-03-05T21:30:00.000Z',
  exifInfo: { exifImageWidth: 3000, exifImageHeight: 2000, orientation: '1', city: 'Paris', state: 'Ile-de-France', country: 'France', dateTimeOriginal: '2021-03-05T20:30:00.000Z' },
  ...extra
});

/**
 * A pretend Immich. `data` says what it holds; `requests` records "METHOD path?query" for each call and `bodies` the POST bodies.
 * @param {{albums?: {id: string, albumName: string, timeline?: object[]}[], memories?: Record<string, object[][]>, search?: object[], failMemories?: boolean}} data
 * @returns {{fetch: typeof fetch, requests: string[], bodies: any[]}}
 */
function fakeImmich(data) {
  const requests = [];
  const bodies = [];
  /** A JSON response like Immich's. */
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (opts.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace('/api', '');
    requests.push(`${method} ${path}${url.search}`);
    if (method === 'POST') {
      bodies.push(JSON.parse(opts.body));
      if (path !== '/search/smart') return json({ message: 'no' }, 404);
      const { page, size } = bodies.at(-1);
      const all = data.search ?? [];
      const items = all.slice((page - 1) * size, page * size);
      return json({ albums: {}, assets: { items, total: all.length, count: items.length, facets: [], nextPage: page * size < all.length ? String(page + 1) : null } });
    }
    if (path === '/memories') {
      if (data.failMemories) return json({ message: 'down' }, 500);
      return json((data.memories?.[url.searchParams.get('for')] ?? []).map(assets => ({ type: 'on_this_day', assets })));
    }
    if (path === '/albums') return json((data.albums ?? []).map(a => ({ id: a.id, albumName: a.albumName })));
    const album = (data.albums ?? []).find(a => path === `/albums/${a.id}`);
    if (album) return json({ id: album.id, albumName: album.albumName });
    if (path === '/timeline/buckets') return json([{ timeBucket: '2024-01-01T00:00:00.000Z', count: 1 }]);
    if (path === '/timeline/bucket') {
      const rows = (data.albums ?? []).find(a => a.id === url.searchParams.get('albumId'))?.timeline ?? [];
      return json({
        id: rows.map(r => r.id), ratio: rows.map(r => r.ratio ?? 1.5), isImage: rows.map(() => true), isTrashed: rows.map(() => false),
        fileCreatedAt: rows.map(r => r.date ?? null), localOffsetHours: rows.map(() => 0), city: rows.map(r => r.city ?? null), country: rows.map(() => null)
      });
    }
    return json({ message: 'not found' }, 404);
  };
  return { fetch, requests, bodies };
}

/**
 * Starts the plugin on a pretend Immich with the given settings.
 * @param {object} data - What the pretend Immich holds.
 * @param {object} settings - Plugin settings (url and apiKey are filled in).
 * @returns {Promise<{fake: ReturnType<typeof fakeImmich>, warnings: string[]}>}
 */
async function start(data, settings) {
  const fake = fakeImmich(data);
  const warnings = [];
  const log = { info() {}, debug() {}, error() {}, warn: m => warnings.push(m) };
  const defaultsFor = { albumIds: [], albumNames: [], daysBefore: 7, query: '', personIds: [], isFavorite: false, city: '', country: '', maxImages: 0, order: { by: 'random', sort: 'desc' } };
  await plugin.init({ url: 'https://immich.test', apiKey: 'secret-key', ...defaultsFor, ...settings }, { fetch: fake.fetch, log });
  fake.requests.length = 0; // forget the start-up check
  fake.bodies.length = 0;
  return { fake, warnings };
}
/** The ids in a plugin result. */
const ids = result => result.images.map(i => i.id);

test('memoryDays: from daysBefore days ago to MEMORY_DAYS_AHEAD ahead, across month and year ends', () => {
  assert.deepEqual(memoryDays(new Date(2026, 10, 10), 2), ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  assert.equal(MEMORY_DAYS_AHEAD, 2);
  assert.deepEqual(memoryDays(new Date(2027, 0, 1), 0), ['2027-01-01', '2027-01-02', '2027-01-03']);
  const back = memoryDays(new Date(2027, 0, 3), 15);
  assert.equal(back.length, 18);
  assert.equal(back[0], '2026-12-19');
});

test('ratioOf swaps the sides of sideways photos, falls back to width and height, and gives 0 when unknown', () => {
  assert.equal(ratioOf({ exifInfo: { exifImageWidth: 4000, exifImageHeight: 3000, orientation: '1' } }), 4000 / 3000);
  assert.equal(ratioOf({ exifInfo: { exifImageWidth: 4000, exifImageHeight: 3000, orientation: '6' } }), 3000 / 4000);
  assert.equal(ratioOf({ width: 1000, height: 500 }), 2);
  assert.equal(ratioOf({ width: null, height: null }), 0);
});

test('capRows keeps the first ones when ordered and a random selection otherwise', () => {
  const rows = [1, 2, 3, 4, 5];
  assert.deepEqual(capRows(rows, 0, false), rows);
  assert.deepEqual(capRows(rows, 2, true), [1, 2]);
  const picked = capRows(rows, 3, false, () => 0);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked).size, 3);
});

test('order helpers behave like the shared-album plugin\'s', () => {
  assert.deepEqual(resolveOrder('dateTIMEoriginal'), { field: 'dateTimeOriginal', valid: true });
  assert.deepEqual(sortRows([{ k: 'a', value: 1 }, { k: 'b', value: null }, { k: 'c', value: 3 }], 'desc').map(r => r.k), ['c', 'a', 'b']);
  assert.equal(localDate('2024-05-01T23:30:00.000Z', 9).slice(0, 10), '2024-05-02');
});

test('memory mode asks for each day once, lists each photo once, skips videos, and carries the caption facts', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 10, 12).getTime() });
  try {
    const { fake } = await start({
      memories: {
        '2026-11-09': [[asset('m1'), asset('v1', { type: 'VIDEO' })]],
        '2026-11-10': [[asset('m1'), asset('m2', { localDateTime: '2023-11-10T08:00:00.000Z', exifInfo: { exifImageWidth: 2000, exifImageHeight: 3000, orientation: '1' } })]],
        '2026-11-12': [[asset('m3')]]
      }
    }, { mode: 'memory', daysBefore: 1 });
    const result = await plugin.getImages();
    assert.deepEqual(fake.requests, ['GET /memories?for=2026-11-09', 'GET /memories?for=2026-11-10', 'GET /memories?for=2026-11-11', 'GET /memories?for=2026-11-12']);
    assert.deepEqual(ids(result), ['m1', 'm2', 'm3']);
    assert.equal(result.title, 'Memories');
    assert.equal(result.order, 'random');
    assert.deepEqual(result.images[0], { id: 'm1', ratio: 1.5, date: '2021-03-05T21:30:00', city: 'Paris', state: 'Ile-de-France', country: 'France' });
    assert.equal(result.images[1].city, undefined);
  } finally {
    mock.timers.reset();
  }
});

test('Immich is asked once a day: later calls reuse the list until the date changes', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 10, 8).getTime() });
  try {
    const { fake } = await start({ memories: { '2026-11-10': [[asset('a1')]], '2026-11-11': [[asset('a2')]], '2026-11-12': [[asset('a2')]] } }, { mode: 'memory', daysBefore: 0 });
    await plugin.getImages();
    const first = fake.requests.length;
    mock.timers.setTime(new Date(2026, 10, 10, 23, 59).getTime());
    assert.deepEqual(ids(await plugin.getImages()), ['a1', 'a2']);
    assert.equal(fake.requests.length, first, 'same day: no new requests');
    mock.timers.setTime(new Date(2026, 10, 11, 0, 1).getTime());
    await plugin.getImages();
    assert.ok(fake.requests.length > first, 'next day: asked again');
    assert.ok(fake.requests.includes('GET /memories?for=2026-11-11'));
  } finally {
    mock.timers.reset();
  }
});

test('a failed refresh keeps the old list and leaves Immich alone for a while', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 10, 8).getTime() });
  try {
    const data = { memories: { '2026-11-10': [[asset('k1')]] } };
    const { fake, warnings } = await start(data, { mode: 'memory', daysBefore: 0 });
    await plugin.getImages();
    data.failMemories = true;
    mock.timers.setTime(new Date(2026, 10, 11, 8).getTime());
    assert.deepEqual(ids(await plugin.getImages()), ['k1'], 'the old list is kept');
    assert.equal(warnings.length, 1);
    const asked = fake.requests.length;
    mock.timers.setTime(new Date(2026, 10, 11, 8).getTime() + REFRESH_RETRY_MS / 2);
    await plugin.getImages();
    assert.equal(fake.requests.length, asked, 'no new request inside the retry delay');
    data.failMemories = false;
    mock.timers.setTime(new Date(2026, 10, 11, 8).getTime() + REFRESH_RETRY_MS + 1000);
    await plugin.getImages();
    assert.ok(fake.requests.length > asked, 'after the delay it tries again');
  } finally {
    mock.timers.reset();
  }
});

test('search mode pages through results up to maxImages, sends only the filters set, and POSTs only to /search/smart', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => asset(`s${i}`));
  const { fake } = await start({ search: many }, { mode: 'search', query: 'dogs', maxImages: 1500, isFavorite: true, personIds: ['p1'], country: 'France' });
  const result = await plugin.getImages();
  assert.equal(result.images.length, 1500);
  assert.equal(result.title, 'Search: dogs');
  assert.ok(fake.bodies.length >= 2, 'more than one page was needed');
  assert.deepEqual(fake.bodies[0], { query: 'dogs', type: 'IMAGE', withExif: true, page: 1, size: 1000, personIds: ['p1'], isFavorite: true, country: 'France' });
  assert.ok(fake.requests.filter(r => !r.startsWith('GET ')).every(r => r.startsWith('POST /search/smart')), 'the only non-GET request is the smart search');
});

test('search mode without maxImages uses a default limit; filters left empty are not sent', async () => {
  const many = Array.from({ length: 500 }, (_, i) => asset(`d${i}`));
  const { fake } = await start({ search: many }, { mode: 'search', query: 'beach' });
  assert.equal((await plugin.getImages()).images.length, 200);
  assert.deepEqual(Object.keys(fake.bodies[0]).sort(), ['page', 'query', 'size', 'type', 'withExif']);
});

test('album mode: names are resolved exactly, the timeline is read, photos in two albums are listed once, captions come along', async () => {
  const data = {
    albums: [
      { id: 'a1', albumName: 'Trip', timeline: [{ id: 't1', date: '2024-05-01T23:30:00.000Z', city: 'Rome' }, { id: 't2' }] },
      { id: 'a2', albumName: 'Pets', timeline: [{ id: 't2' }, { id: 't3' }] }
    ]
  };
  await start(data, { mode: 'album', albumNames: ['Trip', 'Pets'] });
  const result = await plugin.getImages();
  assert.deepEqual(ids(result), ['t1', 't2', 't3']);
  assert.equal(result.title, 'Trip, Pets');
  assert.equal(result.images[0].city, 'Rome');
  assert.equal(result.images[0].date.slice(0, 10), '2024-05-01');
  await assert.rejects(start(data, { mode: 'album', albumNames: ['trip'] }), /no album is named "trip"/);
});

test('album ids win over names (with a warning), and ordering by date sorts newest first', async () => {
  const data = { albums: [{ id: 'a1', albumName: 'Trip', timeline: [{ id: 'o1', date: '2020-01-01T00:00:00.000Z' }, { id: 'o2', date: '2024-01-01T00:00:00.000Z' }] }] };
  const { warnings } = await start(data, { mode: 'album', albumIds: ['a1'], albumNames: ['Other'], order: { by: 'DateTimeOriginal', sort: 'desc' } });
  const result = await plugin.getImages();
  assert.deepEqual(ids(result), ['o2', 'o1']);
  assert.equal(result.order, 'sequence');
  assert.ok(warnings.some(w => /albumIds is used/.test(w)));
});

test('mistakes in the settings stop start-up with a message; settings of another mode are warned about', async () => {
  await assert.rejects(start({}, { mode: 'album' }), /album mode needs albumIds or albumNames/);
  await assert.rejects(start({}, { mode: 'search', query: '  ' }), /search mode needs a query/);
  const { warnings } = await start({}, { mode: 'memory', query: 'dogs', albumNames: ['x'] });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some(w => /^query only applies in "search" mode/.test(w)));
  assert.ok(warnings.some(w => /^albumNames only applies in "album" mode/.test(w)));
});

test('the API key travels in a header, never in the photo address', async () => {
  await start({}, { mode: 'memory' });
  const image = await plugin.getImage('abc/1');
  assert.equal(image.url, 'https://immich.test/api/assets/abc%2F1/thumbnail?size=preview');
  assert.deepEqual(image.headers, { 'x-api-key': 'secret-key' });
  assert.ok(!image.url.includes('secret-key'));
});

test('a refused search says what to check', async () => {
  const blocking = async () => { throw new Error('Blocked POST request to immich.test: plugins may only read (GET) unless the host is in this plugin\'s allowedPostHosts in config.jsonc'); };
  const log = { info() {}, debug() {}, error() {}, warn() {} };
  await assert.rejects(
    plugin.init({ url: 'https://immich.test', apiKey: 'k', mode: 'search', query: 'dogs', albumIds: [], albumNames: [], daysBefore: 7, personIds: [], isFavorite: false, city: '', country: '', maxImages: 0, order: { by: 'random', sort: 'desc' } }, { fetch: blocking, log }),
    /smart search failed: Blocked POST.*allowedPostHosts.*machine learning/s
  );
});

test('search mode ignores order: Immich\'s ranking is kept and a sequence is asked for (with a warning if order is set)', async () => {
  const found = ['r3', 'r1', 'r2'].map((id, i) => asset(id, { localDateTime: `202${i}-01-01T00:00:00.000Z` }));
  const { warnings } = await start({ search: found }, { mode: 'search', query: 'scenery', order: { by: 'DateTimeOriginal', sort: 'desc' } });
  const result = await plugin.getImages();
  assert.deepEqual(ids(result), ['r3', 'r1', 'r2']);
  assert.equal(result.order, 'sequence');
  assert.ok(warnings.some(w => /order is ignored in search mode/.test(w)));
  const quiet = await start({ search: found }, { mode: 'search', query: 'scenery' });
  assert.equal(quiet.warnings.length, 0);
});

test('errors from Immich say the step and Immich\'s own reason', async () => {
  assert.equal(describeError({ status: 400, data: { message: 'Validation failed' } }), 'HTTP 400: Validation failed');
  assert.equal(describeError({ status: 404, data: {} }), 'HTTP 404');
  assert.equal(describeError(new Error('boom')), 'boom');
  const bad = async () => new Response(JSON.stringify({ message: 'id must be a UUID' }), { status: 400, headers: { 'content-type': 'application/json' } });
  const log = { info() {}, debug() {}, error() {}, warn() {} };
  const settings = { url: 'https://immich.test', apiKey: 'k', mode: 'album', albumIds: ['not-a-uuid'], albumNames: [], daysBefore: 7, query: '', personIds: [], isFavorite: false, city: '', country: '', maxImages: 0, order: { by: 'random', sort: 'desc' } };
  await assert.rejects(plugin.init(settings, { fetch: bad, log }), /reading album "not-a-uuid" failed: HTTP 400: id must be a UUID/);
});
