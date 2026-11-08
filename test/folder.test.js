// Checks the folder plugin: scanning, shapes, safety rules, minimum age and serving originals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import folder, { resolveFolder, resolveOrder, sortRows } from '../builtin-plugins/folder/index.js';

const quiet = { warn() {}, info() {}, debug() {}, error() {} };

/** Writes a plain JPEG of the given size; `orientation` adds an EXIF rotation tag. */
async function jpeg(path, width, height, orientation) {
  let img = sharp({ create: { width, height, channels: 3, background: '#808080' } }).jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  await img.toFile(path);
  const old = new Date(Date.now() - 3600_000); // an hour old, so the minimum-age rule does not skip it
  await utimes(path, old, old);
}

/** Makes a plugin folder containing photos/, and a function that starts the plugin on it. */
async function start(extra = {}) {
  const pluginDir = await mkdtemp(join(tmpdir(), 'apf-folder-'));
  const photos = join(pluginDir, 'photos');
  await mkdir(photos);
  const settings = { path: 'photos', recursive: true, minAgeSeconds: 10, order: { by: 'DateTimeOriginal', sort: 'desc' }, ...extra };
  return { pluginDir, photos, init: () => folder.init(settings, { log: quiet, pluginDir }) };
}

test('the path is relative to the plugin folder; absolute paths and ".." are refused', () => {
  assert.equal(resolveFolder('photos', '/srv/plugin'), '/srv/plugin/photos');
  assert.throws(() => resolveFolder('/mnt/usb/photos', '/srv/plugin'), /absolute.*own folder/);
  assert.throws(() => resolveFolder('../photos', '/srv/plugin'), /must stay inside/);
  assert.throws(() => resolveFolder('a/../../x', '/srv/plugin'), /must stay inside/);
});

test('lists images with their displayed shape, honouring EXIF rotation', async () => {
  const t = await start();
  await jpeg(join(t.photos, 'wide.jpg'), 300, 200);
  await jpeg(join(t.photos, 'tall.jpg'), 200, 300);
  await jpeg(join(t.photos, 'rotated.jpg'), 300, 200, 6); // stored wide, displayed tall
  await sharp({ create: { width: 40, height: 20, channels: 3, background: '#fff' } }).png().toFile(join(t.photos, 'a.png'));
  await utimes(join(t.photos, 'a.png'), new Date(0), new Date(0));
  await t.init();
  const { images } = await folder.getImages();
  assert.deepEqual(images.map(p => +p.ratio.toFixed(2)).sort(), [0.67, 0.67, 1.5, 2]);
});

test('ignores hidden files, non-images, unreadable images, unsupported types and node_modules', async () => {
  const t = await start();
  await jpeg(join(t.photos, 'ok.jpg'), 30, 20);
  await jpeg(join(t.photos, '.hidden.jpg'), 30, 20);
  await mkdir(join(t.photos, 'node_modules'));
  await jpeg(join(t.photos, 'node_modules', 'pkg.jpg'), 30, 20);
  await writeFile(join(t.photos, 'notes.txt'), 'hi');
  await writeFile(join(t.photos, 'fake.jpg'), 'this is not an image');
  await writeFile(join(t.photos, 'clip.mp4'), 'x');
  await t.init();
  assert.equal((await folder.getImages()).images.length, 1);
});

test('a file time far in the future (a camera with the wrong date) does not hide the photo', async () => {
  const t = await start();
  await jpeg(join(t.photos, 'future.jpg'), 30, 20);
  const future = new Date(Date.now() + 365 * 86400_000);
  await utimes(join(t.photos, 'future.jpg'), future, future);
  await t.init();
  assert.equal((await folder.getImages()).images.length, 1);
});

test('files changed within minAgeSeconds are skipped (they may still be copying)', async () => {
  const t = await start();
  await jpeg(join(t.photos, 'old.jpg'), 30, 20);
  await sharp({ create: { width: 30, height: 20, channels: 3, background: '#fff' } }).jpeg().toFile(join(t.photos, 'new.jpg'));
  await t.init();
  assert.equal((await folder.getImages()).images.length, 1);
});

test('sub-folders are included only when recursive is on', async () => {
  const t = await start({ recursive: false });
  await mkdir(join(t.photos, 'sub'));
  await jpeg(join(t.photos, 'sub', 'a.jpg'), 30, 20);
  await t.init();
  assert.equal((await folder.getImages()).images.length, 0);
});

test('symbolic links are never followed: not to files, not to folders, not even inside the folder', async () => {
  const t = await start();
  const outside = join(t.pluginDir, 'secret.jpg');
  await jpeg(outside, 30, 20);
  await mkdir(join(t.pluginDir, 'elsewhere'));
  await jpeg(join(t.pluginDir, 'elsewhere', 'far.jpg'), 30, 20);
  await jpeg(join(t.photos, 'real.jpg'), 30, 20);
  await symlink(outside, join(t.photos, 'link-outside.jpg'));
  await symlink(join(t.photos, 'real.jpg'), join(t.photos, 'link-inside.jpg'));
  await symlink(join(t.pluginDir, 'elsewhere'), join(t.photos, 'linked-folder'));
  await t.init();
  assert.equal((await folder.getImages()).images.length, 1); // only real.jpg
});

test('the photo folder itself may not be a symbolic link', async () => {
  const t = await start({ path: 'link-to-photos' });
  await symlink(t.photos, join(t.pluginDir, 'link-to-photos'));
  await assert.rejects(t.init(), /symbolic link/);
});

test('a file swapped for a link after the scan is refused when served', async () => {
  const t = await start();
  const outside = join(t.pluginDir, 'secret.jpg');
  await jpeg(outside, 30, 20);
  await jpeg(join(t.photos, 'a.jpg'), 30, 20);
  await t.init();
  const { images } = await folder.getImages();
  await unlink(join(t.photos, 'a.jpg'));
  await symlink(outside, join(t.photos, 'a.jpg'));
  await assert.rejects(folder.getImage(images[0].id), /symbolic link|ELOOP/);
});

test('getImage returns the original file untouched (the app resizes it), and rejects unknown ids', async () => {
  const t = await start();
  await jpeg(join(t.photos, 'big.jpg'), 400, 200);
  await t.init();
  const { images } = await folder.getImages();
  const out = await folder.getImage(images[0].id);
  assert.deepEqual(out.body, await readFile(join(t.photos, 'big.jpg')));
  await assert.rejects(folder.getImage('../../etc/passwd'), /unknown photo/);
});

test('a missing photo folder fails init so the server retries', async () => {
  const t = await start({ path: 'nope' });
  await assert.rejects(t.init(), /ENOENT/);
});

/** Writes a JPEG whose shape identifies it in the results; `taken` adds an EXIF date, `modified` sets the file time. */
async function dated(dir, name, width, height, { taken, modified }) {
  let img = sharp({ create: { width, height, channels: 3, background: '#808080' } }).jpeg();
  if (taken) img = img.withExif({ IFD2: { DateTimeOriginal: taken } });
  await img.toFile(join(dir, name));
  await utimes(join(dir, name), modified, modified);
}

test('images are listed NEWEST first by taken date, then file time, then path, and ask to be shown in that order', async () => {
  const t = await start();
  /**
   * A date in June of the given year.
   * @param {number} y - The year.
   * @returns {Date}
   */
  const old = y => new Date(`${y}-06-15T12:00:00Z`);
  // the width is 100 for all, so the ratio (= 100 / height) tells the files apart
  await dated(t.photos, 'a.jpg', 100, 50, { taken: '2020:03:01 10:00:00', modified: old(2030) }); // taken 2020, copied much later
  await dated(t.photos, 'b.jpg', 100, 40, { taken: '2018:03:01 10:00:00', modified: old(2030) }); // taken 2018
  await dated(t.photos, 'c.jpg', 100, 30, { modified: old(2019) });                                // no EXIF: file time 2019
  await dated(t.photos, 'd.jpg', 100, 20, { modified: old(2021) });                                // no EXIF: file time 2021
  await dated(t.photos, 'e.jpg', 100, 25, { modified: old(2021) });                                // same time as d: path breaks the tie
  await t.init();
  const result = await folder.getImages();
  assert.equal(result.order, 'sequence');
  assert.deepEqual(result.images.map(p => +(1 / p.ratio * 100).toFixed(0)), [20, 25, 50, 30, 40]); // d, e (2021, path breaks the tie), a (2020), c (2019), b (2018)
});

test('a photo added later takes its place in the order', async () => {
  const t = await start();
  /**
   * A date in June of the given year.
   * @param {number} y - The year.
   * @returns {Date}
   */
  const when = y => new Date(`${y}-06-15T12:00:00Z`);
  await dated(t.photos, 'a.jpg', 100, 50, { modified: when(2020) });
  await dated(t.photos, 'c.jpg', 100, 30, { modified: when(2022) });
  await t.init();
  await folder.getImages();
  await dated(t.photos, 'b.jpg', 100, 40, { modified: when(2021) });
  const { images } = await folder.getImages();
  assert.deepEqual(images.map(p => +(1 / p.ratio * 100).toFixed(0)), [30, 40, 50]); // c (2022), b (2021), a (2020)
});

/** A start() whose logger remembers warnings. */
async function startWithWarnings(extra) {
  const t = await start(extra);
  const warnings = [];
  const settings = { path: 'photos', recursive: true, minAgeSeconds: 10, order: { by: 'DateTimeOriginal', sort: 'desc' }, ...extra };
  return { ...t, warnings, init: () => folder.init(settings, { log: { ...quiet, warn: m => warnings.push(m) }, pluginDir: t.pluginDir }) };
}

test('any EXIF field can be the order, in any capitalisation; photos without a value come last', async () => {
  const t = await start({ order: { by: 'make', sort: 'desc' } });
  /**
   * Writes a grey test photo, with the camera make in its EXIF data when given, an hour old.
   * @param {string} name - File name.
   * @param {number} height - Photo height in pixels (the width is 100).
   * @param {string} [value] - Camera make to store, or nothing for no EXIF.
   * @returns {Promise<void>}
   */
  const make = async (name, height, value) => {
    let img = sharp({ create: { width: 100, height, channels: 3, background: '#808080' } }).jpeg();
    if (value) img = img.withExif({ IFD0: { Make: value } });
    await img.toFile(join(t.photos, name));
    await utimes(join(t.photos, name), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  };
  await make('p.jpg', 50, 'Alpha');
  await make('q.jpg', 40, 'Zeta');
  await make('r.jpg', 30, null);
  await t.init();
  const result = await folder.getImages();
  assert.equal(result.order, 'sequence');
  assert.deepEqual(result.images.map(p => +(1 / p.ratio * 100).toFixed(0)), [40, 50, 30]); // Zeta, Alpha, none
});

test('"random" asks for random order and does not need EXIF at all', async () => {
  const t = await start({ order: { by: 'random', sort: 'desc' } });
  await jpeg(join(t.photos, 'a.jpg'), 30, 20);
  await t.init();
  const result = await folder.getImages();
  assert.equal(result.order, 'random');
  assert.equal(result.images.length, 1);
});

test('a name that is not an EXIF field is logged as a warning and the order is random', async () => {
  const t = await startWithWarnings({ order: { by: 'NotARealField', sort: 'desc' } });
  await jpeg(join(t.photos, 'a.jpg'), 30, 20);
  await t.init();
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /"NotARealField" is not an EXIF field name.*random order/);
  assert.equal((await folder.getImages()).order, 'random');
  const ok = await startWithWarnings({ order: { by: 'iso', sort: 'desc' } }); // real field, any capitalisation: no warning
  await ok.init();
  assert.equal(ok.warnings.length, 0);
});

test('resolveOrder recognises random and real EXIF names only', () => {
  assert.deepEqual(resolveOrder('random'), { field: null, valid: true });
  assert.deepEqual(resolveOrder('  RANDOM '), { field: null, valid: true });
  assert.deepEqual(resolveOrder('datetimeoriginal'), { field: 'DateTimeOriginal', valid: true });
  assert.deepEqual(resolveOrder('Bogus'), { field: null, valid: false });
});

test('sort "asc" reverses the order (oldest first), and photos without a value still come last', async () => {
  const t = await start({ order: { by: 'DateTimeOriginal', sort: 'asc' } });
  /**
   * A date in June of the given year.
   * @param {number} y - The year.
   * @returns {Date}
   */
  const when = y => new Date(`${y}-06-15T12:00:00Z`);
  await dated(t.photos, 'a.jpg', 100, 50, { taken: '2020:03:01 10:00:00', modified: when(2030) });
  await dated(t.photos, 'b.jpg', 100, 40, { taken: '2018:03:01 10:00:00', modified: when(2030) });
  await dated(t.photos, 'c.jpg', 100, 30, { modified: when(2019) });
  await t.init();
  const { images } = await folder.getImages();
  assert.deepEqual(images.map(p => +(1 / p.ratio * 100).toFixed(0)), [40, 30, 50]); // b (2018), c (2019 by file time), a (2020)
  assert.deepEqual(sortRows([{ value: null, path: 'a' }, { value: 5, path: 'b' }, { value: 1, path: 'c' }], 'asc').map(r => r.path), ['c', 'b', 'a']);
  assert.deepEqual(sortRows([{ value: null, path: 'a' }, { value: 5, path: 'b' }, { value: 1, path: 'c' }], 'desc').map(r => r.path), ['b', 'c', 'a']);
});
