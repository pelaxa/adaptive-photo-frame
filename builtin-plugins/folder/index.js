/**
 * builtin-plugins/folder - photo source: a folder of image files inside this plugin's own folder.
 *
 * Photos are added by any outside means (copying files into builtin-plugins/folder/photos, a network share, a sync
 * tool); there is no upload. The folder is re-read every time the app asks for the image list (at most
 * every 30 seconds), so new files show up on the next page refresh (display.refreshSeconds).
 *
 * This plugin runs in the file-access sandbox, which shapes how it works:
 *  - It can read only its own folder, so the photos live inside it (default: builtin-plugins/folder/photos).
 *    `path` is relative to this folder; absolute paths and `..` are refused.
 *  - It cannot write, so there is no cache here: it returns the original file and the app resizes and
 *    caches it. It cannot load native modules either, so photo shapes come from `image-size` (pure JavaScript).
 *  - Symbolic links are NEVER followed, under any circumstance: links to files and to folders are skipped,
 *    and the photo folder itself must not be a link. Files are checked with lstat before reading and opened
 *    with O_NOFOLLOW (where the operating system supports it). Photos therefore have to be copied into the
 *    folder, not linked.
 *  - Files whose names start with "." and folders named node_modules are ignored, and files changed in the
 *    last `minAgeSeconds` are skipped, because they may still be copying.
 *  - Image ids are hashes, and nothing from a request is ever used as a path.
 *
 * Order: the `order` setting is { by, sort }. `by` is an EXIF field name (any capitalisation) or "random"; the default is
 * DateTimeOriginal, the date a photo was TAKEN. `sort` is "desc" (newest / largest first, the default) or "asc" (oldest /
 * smallest first). The app shows the photos in that order, round after round (order: 'sequence'), so every photo is shown
 * before any repeats, and a photo added later is shown before the round ends. For the date fields (DateTimeOriginal, CreateDate,
 * ModifyDate), a photo without one is placed by the file's modified time instead; for any other field a photo without a
 * value comes last (in either direction). Ties are broken by path. A `by` that is not an EXIF field is logged as a warning, and
 * the order is random.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { imageSize } from 'image-size';
import exifr from 'exifr/dist/full.esm.mjs';

/** File types that are shown. */
const SHOWN = new Set(['.jpg', '.jpeg', '.png', '.webp']);
/** Photo or video types that exist but are not supported; reported once so users know why they are missing. */
const UNSUPPORTED = new Set(['.heic', '.heif', '.gif', '.tif', '.tiff', '.bmp', '.avif', '.mp4', '.mov', '.m4v', '.avi', '.mkv']);
/** Bigger files are not sent to the app (it accepts at most 50 MB). */
const MAX_BYTES = 50 * 1024 * 1024;
/** How much of a file is read to learn its shape; enough for the header of nearly every photo. */
const HEADER_BYTES = 64 * 1024;

/** The date fields: a photo without one falls back to the file's modified time. Lower case. */
const DATE_FIELDS = new Set(['datetimeoriginal', 'createdate', 'modifydate']);

/** Length of a photo's id: the start of a hash of its path, change time and size. */
const ID_LENGTH = 24;

/**
 * State for the running instance, created by init().
 * @type {{
 *   root: string, settings: Record<string, any>, log: import('node:console').Console,
 *   index: Map<string, {path: string}>, orderField: string | null, sort: 'asc' | 'desc',
 *   meta: Map<string, {mtimeMs: number, size: number, ratio: number|null, value: any}>, reported: Set<string>
 * }}
 */
let state;

/**
 * Works out the photo folder from the `path` setting.
 * @param {string} path - The setting: relative to the plugin folder.
 * @param {string} pluginDir - The plugin's own folder.
 * @returns {string} Absolute folder path (not yet checked for existence).
 * @throws {Error} If the path is absolute or climbs out of the plugin folder.
 */
export function resolveFolder(path, pluginDir) {
  if (isAbsolute(path)) {
    throw new Error(`path "${path}" is absolute, but this plugin can only read inside its own folder; put the photos in ${pluginDir} and use a relative path`);
  }
  const root = resolve(pluginDir, path);
  const rel = relative(pluginDir, root);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path "${path}" must stay inside the plugin folder`);
  }
  return root;
}

/**
 * Logs a message only the first time it is seen, so a bad file does not repeat on every scan.
 * @param {string} key - Identifies the message.
 * @param {() => void} log - Called the first time only.
 * @returns {void}
 */
function once(key, log) {
  if (!state.reported.has(key)) {
    state.reported.add(key);
    log();
  }
}

/**
 * Reads a file without ever following a symbolic link, up to a limit.
 * @param {string} path - File to read.
 * @param {number} [limit=MAX_BYTES] - Most bytes to read.
 * @returns {Promise<Buffer>} The bytes (fewer than `limit` if the file is shorter).
 * @throws {Error} If the file is a symbolic link or cannot be read.
 */
async function readBytes(path, limit = MAX_BYTES) {
  if ((await lstat(path)).isSymbolicLink()) throw new Error(`${path} is a symbolic link; links are never followed`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const length = Math.min((await handle.stat()).size, limit);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Collects the files in a folder (and its sub-folders if asked). Hidden entries and node_modules are
 * skipped, and symbolic links (to files or folders) are skipped without looking at where they point.
 * @param {string} dir - Folder to read.
 * @param {boolean} recursive - Whether to descend into sub-folders.
 * @param {string[]} out - Receives the file paths.
 * @returns {Promise<void>}
 */
async function listFiles(dir, recursive, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      once(`link:${full}`, () => state.log.info(`skipping ${full}: symbolic links are never followed`));
    } else if (entry.isDirectory()) {
      if (recursive) await listFiles(full, recursive, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

/**
 * Turns the `order` setting into the EXIF field to sort by.
 * @param {string} value - The setting: "random", or an EXIF field name in any capitalisation.
 * @returns {{field: string | null, valid: boolean}} field = the EXIF tag's proper name (null for random); valid = false if
 *   the name is not an EXIF tag (random is then used, and the caller should warn).
 */
export function resolveOrder(value) {
  const wanted = String(value ?? '').trim().toLowerCase();
  if (!wanted || wanted === 'random') return { field: null, valid: true };
  for (const names of exifr.tagKeys.values()) {
    for (const name of names.values()) if (name.toLowerCase() === wanted) return { field: name, valid: true };
  }
  return { field: null, valid: false };
}

/**
 * Reads the EXIF value a photo is ordered by. For DateTimeOriginal it falls back to CreateDate, as most
 * cameras write both.
 * @param {Buffer} bytes - The start of the file (the EXIF data sits at the very start of a JPEG).
 * @param {string} field - The EXIF tag name.
 * @returns {Promise<any>} A number, string or Date; null if the file has no (readable, simple) value for it.
 */
async function fieldValue(bytes, field) {
  try {
    const names = field.toLowerCase() === 'datetimeoriginal' ? ['DateTimeOriginal', 'CreateDate'] : [field];
    const tags = (await exifr.parse(bytes, names)) ?? {};
    const value = names.map(n => tags[n]).find(v => v !== undefined && v !== null && v !== '');
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    return typeof value === 'number' || typeof value === 'string' ? value : null; // lists and objects are not sortable
  } catch {
    return null;
  }
}

/**
 * Sorts rows by their value, largest / newest first ("desc") or smallest / oldest first ("asc"). Rows without a value
 * come last in both directions. Rows with equal values are ordered by their path.
 * @param {{value: number | string | null, path: string}[]} rows - Rows to sort.
 * @param {'asc' | 'desc'} sort - The direction.
 * @returns {{value: number | string | null, path: string}[]} A new, sorted array.
 */
export function sortRows(rows, sort) {
  const direction = sort === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (a.value === null || b.value === null) return (a.value === null) - (b.value === null) || a.path.localeCompare(b.path);
    const order = typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : String(a.value).localeCompare(String(b.value), undefined, { numeric: true });
    return order * direction || a.path.localeCompare(b.path);
  });
}

/**
 * Reads a photo's shape and the EXIF value it is ordered by, remembering them until the file changes. A photo that
 * cannot be read is remembered as unreadable (ratio null) until it changes, so it is reported once.
 * @param {string} path - Path of the file (also the cache key).
 * @param {import('node:fs').Stats} st - The file's lstat result.
 * @returns {Promise<{ratio: number|null, value: any}>} ratio = width / height after EXIF rotation, or null if
 *   unreadable; value = the EXIF value of the ordering field, or null (also when ordering is random).
 */
async function describe(path, st) {
  const cached = state.meta.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  let ratio = null;
  let value = null;
  try {
    let bytes = await readBytes(path, HEADER_BYTES);
    let info;
    try {
      info = imageSize(bytes);
    } catch {
      bytes = await readBytes(path); // the shape was not in the first bytes: read the whole file
      info = imageSize(bytes);
    }
    if (state.orderField) value = await fieldValue(bytes, state.orderField);
    // EXIF orientations 5-8 are rotated a quarter turn, so the displayed width and height swap.
    const [w, h] = info.orientation >= 5 ? [info.height, info.width] : [info.width, info.height];
    ratio = w && h ? w / h : null;
  } catch (e) {
    once(`bad:${path}:${st.mtimeMs}`, () => state.log.warn(`skipping ${path}: not a readable image (${e.message})`));
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, ratio, value };
  state.meta.set(path, entry);
  return entry;
}

export default {
  apiVersion: 1,
  name: 'Folder',

  settings: [
    { key: 'path', type: 'path', default: 'photos', description: 'Folder of photos, relative to this plugin\'s folder (default: builtin-plugins/folder/photos). Absolute paths and symbolic links are not allowed' },
    { key: 'recursive', type: 'boolean', default: true, description: 'Also include photos in sub-folders' },
    { key: 'title', type: 'string', description: 'Window title; defaults to the folder name' },
    {
      key: 'order', type: 'object', description: 'How photos are ordered: { by, sort }', fields: [
        { key: 'by', type: 'string', default: 'DateTimeOriginal', description: '"random", or the EXIF field to order by (default: DateTimeOriginal, the date taken). An unknown name is logged and gives random' },
        { key: 'sort', type: 'enum', values: ['asc', 'desc'], default: 'desc', description: '"desc" = newest / largest first, "asc" = oldest / smallest first' }
      ]
    },
    { key: 'minAgeSeconds', type: 'number', default: 10, min: 0, max: 3600, description: 'Ignore files changed more recently than this, so half-copied files are not read' }
  ],

  /**
   * Checks the photo folder exists and is a real folder, not a symbolic link.
   * @param {Record<string, any>} settings - Validated settings.
   * @param {{log: object, pluginDir: string}} ctx - Logger and the plugin's own folder.
   * @returns {Promise<void>}
   * @throws {Error} If the path is not allowed, missing, a symbolic link, or not a folder.
   */
  async init(settings, ctx) {
    const root = resolveFolder(settings.path, ctx.pluginDir);
    const st = await lstat(root);
    if (st.isSymbolicLink()) throw new Error(`${root} is a symbolic link; links are never followed, so the photos have to be copied into a real folder`);
    if (!st.isDirectory()) throw new Error(`${root} is not a folder`);
    const order = resolveOrder(settings.order.by);
    state = { root, settings, log: ctx.log, orderField: order.field, sort: settings.order.sort, index: new Map(), meta: new Map(), reported: new Set() };
    ctx.log.info(`using folder ${root}`);
    if (!order.valid) ctx.log.warn(`order.by "${settings.order.by}" is not an EXIF field name, so photos are shown in random order. Use "random" or a field such as DateTimeOriginal, ISO, Make or Model`);
    else if (order.field) ctx.log.info(`ordering photos by ${order.field}, ${state.sort === 'asc' ? 'oldest / smallest' : 'newest / largest'} first`);
  },

  /**
   * Scans the folder and returns its images in the configured order (see the Order note at the top of this file).
   * @returns {Promise<{title: string, images: {id: string, ratio: number}[], order: 'sequence' | 'random'}>}
   */
  async getImages() {
    const { root, settings, log } = state;
    const files = [];
    await listFiles(root, settings.recursive, files);

    const index = new Map();
    const found = [];
    /**
     * Adds one file to the list if it is a supported photo (an unsupported photo or video type is reported once instead).
     * @param {string} path - Full path of the file.
     * @returns {Promise<void>}
     */
    const consider = async path => {
      const ext = extname(path).toLowerCase();
      if (!SHOWN.has(ext)) {
        if (UNSUPPORTED.has(ext)) once(`ext:${path}`, () => log.info(`skipping ${path}: ${ext} files are not supported`));
        return;
      }
      let st;
      try {
        st = await lstat(path); // lstat does not follow links: a link swapped in since the listing is not a file
      } catch {
        return; // removed since the listing
      }
      if (!st.isFile()) return;
      // Only files modified around now can still be copying. A time far in the future (a camera with the wrong
      // date, say) is not that, so the age is taken without its sign.
      if (Math.abs(Date.now() - st.mtimeMs) < settings.minAgeSeconds * 1000) {
        once(`young:${path}:${st.mtimeMs}`, () => log.debug(`skipping ${path}: changed less than ${settings.minAgeSeconds}s ago`));
        return;
      }
      const { ratio, value } = await describe(path, st);
      if (!ratio) return;
      // The id changes if the file does, so a replaced photo is treated as new and never served from a stale cache.
      const id = createHash('sha256').update(`${relative(root, path)}\0${st.mtimeMs}\0${st.size}`).digest('hex').slice(0, ID_LENGTH);
      index.set(id, { path });
      // A date field falls back to the file's modified time when the photo has none.
      const sortValue = value ?? (state.orderField && DATE_FIELDS.has(state.orderField.toLowerCase()) ? st.mtimeMs : null);
      found.push({ id, ratio, value: sortValue, path: relative(root, path) });
    };
    // Read a few files at a time: faster than one by one, without opening thousands at once.
    for (let i = 0; i < files.length; i += 8) await Promise.all(files.slice(i, i + 8).map(consider));

    // Sorted by the field when there is one; the path breaks ties (files copied together share one modified time).
    const images = (state.orderField ? sortRows(found, state.sort) : found).map(({ id, ratio }) => ({ id, ratio }));

    state.index = index;
    log.debug(`found ${images.length} images`);
    return { title: settings.title ?? basename(root), images, order: state.orderField ? 'sequence' : 'random' };
  },

  /**
   * Returns the original file; the app resizes and caches it. The file is checked with lstat and
   * opened with O_NOFOLLOW so a symbolic link can never be read.
   * @param {string} id - Image id from getImages.
   * @returns {Promise<{body: Buffer}>}
   * @throws {Error} If the id is not from the last scan, the file is too large, or it has become a symbolic link.
   */
  async getImage(id) {
    const entry = state.index.get(id);
    if (!entry) throw new Error('unknown photo');
    const st = await lstat(entry.path);
    if (st.size > MAX_BYTES) throw new Error(`${entry.path} is larger than ${MAX_BYTES} bytes`);
    return { body: await readBytes(entry.path) };
  }
};
