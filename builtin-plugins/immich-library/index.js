/**
 * builtin-plugins/immich-library - photo source: an Immich library read with an API key, in one of three modes.
 *
 *   album   photos of the albums named in `albumIds` / `albumNames` (albums you own or that are shared with you)
 *   memory  Immich's "on this day" memories: photos taken on today's date in earlier years, from `daysBefore` days
 *           ago up to MEMORY_DAYS_AHEAD days ahead (Immich keeps its memories only about two days ahead)
 *   search  Immich's smart search (`query`, e.g. "dogs" or "mountain sunset"), optionally limited to people, favourites,
 *           a city or a country
 *
 * Unlike the shared-album plugin (one album, a share key), this one uses a full API key, so the key can read the
 * whole library. Create it in Immich with read-only permissions only: asset.read, album.read, memory.read, timeline.read
 * (and person.read if `personIds` is used). Everything the plugin does is read-only:
 *   - Every request is a GET, except the smart search, which Immich only offers as a POST (it still changes nothing).
 *     That one POST goes to /search/smart and nowhere else, and works only if the user listed the Immich host in
 *     `allowedPostHosts` on this plugin's entry in config.jsonc. Albums and memories never POST.
 *   - The pictures are not downloaded here: getImage() hands the app Immich's preview address plus the API key as a
 *     request header (never in the address), and the app downloads, resizes and caches it (see lib/images.js).
 *
 * Calling Immich once a day: getImages() answers from the list it built earlier and asks Immich again only on the
 * first call after the local date changes (or after a start-up). If that refresh fails, the old list stays in use and
 * Immich is left alone for REFRESH_RETRY_MS. So a photo added to Immich appears the next day (or after a restart).
 * "Local date" is the date in the time zone this plugin's process runs in (its environment is empty, so in Docker that
 * is UTC unless the host's /etc/localtime is mounted).
 *
 * Order: the `order` setting is { by, sort }, as in the shared-album plugin: "random" (default) or an EXIF field name,
 * newest / largest first ("desc", default) or last ("asc"). Search mode ignores `order` (a warning if it is set): the photos
 * stay in Immich's own ranking, best match first, as in its search box. Memory and search results already carry their EXIF, so
 * ordering by any field costs nothing extra; for albums, the timeline fields are free and any other field needs one
 * lookup per photo (limited to EXIF_BUDGET_MS per refresh, remembered).
 *
 * Captions: every photo carries its local date, city, state and country (where Immich knows them) for `display.caption`.
 */
import { init, defaults, getAllAlbums, getAlbumInfo, getAssetInfo, getTimeBuckets, getTimeBucket, searchMemories, searchSmart } from '@immich/sdk';

/** How many days AFTER today memory mode includes. Immich keeps its "on this day" memories about two days ahead, so asking for more finds nothing. */
export const MEMORY_DAYS_AHEAD = 2;
/** Largest `daysBefore`: Immich keeps its memories for roughly a month, so more than about two weeks back is not reliable. */
const MEMORY_DAYS_BEFORE_MAX = 15;
/** Default `daysBefore`. */
const MEMORY_DAYS_BEFORE_DEFAULT = 7;
/** Photos search mode fetches when `maxImages` is 0 (search results are open-ended, so they need some limit). */
const SEARCH_DEFAULT_LIMIT = 200;
/** Largest page Immich's search returns at once. */
const SEARCH_PAGE_SIZE = 1000;
/** After a failed refresh, how long (ms) Immich is left alone before the next try. */
export const REFRESH_RETRY_MS = 10 * 60 * 1000;
/** How many per-photo EXIF lookups (see lookUpExif) run at once. */
const EXIF_PARALLEL = 8;
/** Longest (ms) one refresh spends looking up per-photo EXIF details for album ordering. */
const EXIF_BUDGET_MS = 8000;
/** Milliseconds in an hour (to turn Immich's timeline offsets into local times). */
const HOUR_MS = 3_600_000;

/** The EXIF fields Immich keeps for a photo (its ExifResponseDto), which `order` may name. */
export const EXIF_FIELDS = [
  'city', 'country', 'dateTimeOriginal', 'description', 'exifImageHeight', 'exifImageWidth', 'exposureTime', 'fNumber',
  'fileSizeInByte', 'focalLength', 'iso', 'latitude', 'lensModel', 'longitude', 'make', 'model', 'modifyDate',
  'orientation', 'projectionType', 'rating', 'state', 'timeZone'
];
/** Fields the album timeline already carries, as the name of the timeline array that holds each. */
const TIMELINE_FIELDS = { dateTimeOriginal: 'fileCreatedAt', city: 'city', country: 'country', latitude: 'latitude', longitude: 'longitude' };
/** Settings that only one mode uses, for the warning when they are set in another mode. */
const MODE_SETTINGS = { album: ['albumIds', 'albumNames'], search: ['query', 'personIds', 'isFavorite', 'city', 'country'], memory: [] };

/** Validated settings, set by init(). @type {Record<string, any>} */
let cfg;
/** The EXIF field to order by (one of EXIF_FIELDS), or null for random. Set by init(). @type {string | null} */
let orderField = null;
/** True in search mode: Immich's ranking (best match first) is kept and `order` is ignored. Set by init(). */
let keepRelevance = false;
/** Logger from init(). @type {import('../lib/logger.js').Logger} */
let log;
/** Albums album mode reads, resolved at init(). @type {{id: string, name: string}[]} */
let albums = [];
/** Per-photo EXIF details looked up so far (album ordering), by photo id. @type {Map<string, Record<string, any>>} */
const exifCache = new Map();
/** The last good list and the local day it was built for. @type {{day: string, result: object} | null} */
let cache = null;
/** Until this time (ms since 1970) Immich is not asked again after a failed refresh. */
let retryAfter = 0;
/** The error of the failed refresh, shown again while waiting. @type {Error | null} */
let lastError = null;
/** A refresh in progress, so calls made at the same time share it. @type {Promise<object> | null} */
let refreshing = null;

/**
 * Turns the `order` setting into the field to sort by.
 * shortcut: copied from the shared-album plugin, because a sandboxed plugin can read only its own folder; keep the two in step.
 * @param {string} value - The setting: "random", or an EXIF field name in any capitalisation.
 * @returns {{field: string | null, valid: boolean}} field = the matching name from EXIF_FIELDS (null for random);
 *   valid = false if the name matched nothing (random is used then, and the caller should warn).
 */
export function resolveOrder(value) {
  const wanted = String(value ?? '').trim().toLowerCase();
  if (!wanted || wanted === 'random') return { field: null, valid: true };
  const field = EXIF_FIELDS.find(f => f.toLowerCase() === wanted);
  return field ? { field, valid: true } : { field: null, valid: false };
}

/**
 * Makes a value from Immich comparable: dates (ISO text) become milliseconds, numbers stay, empty becomes null.
 * @param {any} value - A timeline entry or EXIF value.
 * @returns {number | string | null}
 */
function comparable(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'object') return null;
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d/.test(value) && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  return value;
}

/**
 * Sorts rows by their value, largest / newest first ("desc") or smallest / oldest first ("asc"). Rows without a
 * value come last in both directions. Rows with equal values keep the order they had.
 * shortcut: copied from the shared-album plugin (see resolveOrder).
 * @template {{value: any}} T
 * @param {T[]} rows - Rows with a `value` to sort by.
 * @param {'asc' | 'desc'} sort - The direction.
 * @returns {T[]} A new, sorted array.
 */
export function sortRows(rows, sort) {
  const direction = sort === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: comparable(row.value) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) return (a.key === null) - (b.key === null) || a.index - b.index;
      const order = typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : String(a.key).localeCompare(String(b.key), undefined, { numeric: true });
      return order * direction || a.index - b.index;
    })
    .map(entry => entry.row);
}

/**
 * The day (and time) a photo was taken as the place where it was taken showed it, from Immich's timeline, which keeps
 * the capture time in UTC plus the hours of offset that place had.
 * @param {string | null | undefined} iso - Capture time in UTC (ISO text).
 * @param {number} [offsetHours=0] - Hours the photo's place was ahead of UTC.
 * @returns {string | undefined} Local time as ISO text without a zone (its first ten characters are the day), or undefined if there is no usable date.
 */
export function localDate(iso, offsetHours = 0) {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? undefined : new Date(ms + offsetHours * HOUR_MS).toISOString().slice(0, 19);
}

/**
 * Formats a date as its local year-month-day, the form Immich's memories endpoint takes.
 * @param {Date} date - The date.
 * @returns {string} For example "2026-11-07".
 */
function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * The days memory mode asks Immich about: `daysBefore` days ago up to MEMORY_DAYS_AHEAD days ahead, today included.
 * @param {Date} now - The current time.
 * @param {number} daysBefore - How many days back to start.
 * @returns {string[]} Local dates as year-month-day, oldest first.
 */
export function memoryDays(now, daysBefore) {
  return Array.from({ length: daysBefore + MEMORY_DAYS_AHEAD + 1 }, (_, i) =>
    ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBefore + i)));
}

/**
 * Width / height of a photo as it is displayed. Uses the EXIF pixel size and swaps it for the sideways orientations
 * (EXIF 5 to 8), falling back to the width and height Immich reports.
 * @param {{width?: number | null, height?: number | null, exifInfo?: {exifImageWidth?: number | null, exifImageHeight?: number | null, orientation?: string | null}}} asset - An Immich asset.
 * @returns {number} The ratio, or 0 if the size is unknown.
 */
export function ratioOf(asset) {
  const e = asset.exifInfo ?? {};
  let w = e.exifImageWidth ?? asset.width;
  let h = e.exifImageHeight ?? asset.height;
  if (!(w > 0 && h > 0)) return 0;
  if (e.exifImageWidth && ['5', '6', '7', '8'].includes(String(e.orientation))) [w, h] = [h, w];
  return w / h;
}

/**
 * Shortens a list to `max` photos: the first ones when ordered, a random selection otherwise.
 * @template T
 * @param {T[]} rows - The photos.
 * @param {number} max - The most to keep (0 = keep all).
 * @param {boolean} ordered - True if the list is in a meaningful order that should be kept.
 * @param {() => number} [random=Math.random] - Random source in [0, 1) (a parameter so tests control it).
 * @returns {T[]} The kept photos.
 */
export function capRows(rows, max, ordered, random = Math.random) {
  if (!max || rows.length <= max) return rows;
  if (ordered) return rows.slice(0, max);
  const copy = [...rows];
  for (let i = copy.length - 1; i > 0; i--) { // Fisher-Yates
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, max);
}

/**
 * Turns an Immich asset (from a memory or a search) into a row for the list, or null if it cannot be shown.
 * @param {any} asset - An Immich AssetResponseDto.
 * @returns {{id: string, ratio: number, value: any, date?: string, city?: string, state?: string, country?: string} | null}
 *   null for videos, trashed photos and photos of unknown size.
 */
function assetRow(asset) {
  if (asset.type !== 'IMAGE' || asset.isTrashed) return null;
  const ratio = ratioOf(asset);
  if (!ratio) return null;
  const e = asset.exifInfo ?? {};
  return {
    id: asset.id, ratio, value: orderField ? e[orderField] : undefined,
    date: asset.localDateTime ? String(asset.localDateTime).slice(0, 19) : localDate(e.dateTimeOriginal),
    city: e.city ?? undefined, state: e.state ?? undefined, country: e.country ?? undefined
  };
}

/**
 * Collects rows into a map by id, so a photo found twice (in two albums, or two memories) is listed once.
 * @param {Map<string, object>} into - The map to add to.
 * @param {(object | null)[]} rows - Rows to add; nulls are skipped.
 * @returns {number} How many rows were null (photos that could not be shown).
 */
function addRows(into, rows) {
  let skipped = 0;
  for (const row of rows) {
    if (!row) skipped++;
    else if (!into.has(row.id)) into.set(row.id, row);
  }
  return skipped;
}

/**
 * Looks up the EXIF details of album photos that have not been looked up yet, a few at a time, until they are
 * all done or EXIF_BUDGET_MS has passed. A failed lookup is simply tried again on the next refresh.
 * shortcut: copied from the shared-album plugin (see resolveOrder).
 * @param {string[]} ids - Photo ids that need their details.
 * @returns {Promise<void>}
 */
async function lookUpExif(ids) {
  const todo = ids.filter(id => !exifCache.has(id));
  if (!todo.length) return;
  const deadline = Date.now() + EXIF_BUDGET_MS;
  let next = 0;
  await Promise.all(Array.from({ length: EXIF_PARALLEL }, async () => {
    while (next < todo.length && Date.now() < deadline) {
      const id = todo[next++];
      try {
        exifCache.set(id, (await getAssetInfo({ id })).exifInfo ?? {});
      } catch (e) {
        log.debug(`could not look up the details of a photo (${e.message}); trying again on the next refresh`);
      }
    }
  }));
  const missing = todo.filter(id => !exifCache.has(id)).length;
  if (missing) log.info(`ordering by ${orderField}: ${missing} of ${todo.length} photos not looked up yet; continuing on the next refresh`);
}

/**
 * Says what went wrong with an Immich request in words: the SDK's own message is just "Error: 400", while Immich's answer
 * says what it did not like. (Immich's error text never contains the API key.)
 * @param {any} e - The error thrown by an SDK call.
 * @returns {string} For example "HTTP 400: Validation failed", or the error's own message if it is not an HTTP error.
 */
export function describeError(e) {
  if (typeof e?.status !== 'number') return e?.message ?? String(e);
  const detail = e.data?.message ?? e.data?.error;
  return `HTTP ${e.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`;
}

/**
 * Runs one step of reading Immich and, if it fails, throws an error that names the step and Immich's reason.
 * @template T
 * @param {string} step - What was being done, e.g. "reading album abc".
 * @param {() => Promise<T>} work - The SDK call(s).
 * @returns {Promise<T>} The result.
 * @throws {Error} "<step> failed: <reason>".
 */
async function inStep(step, work) {
  try {
    return await work();
  } catch (e) {
    if (e?.message?.includes(' failed: ')) throw e; // already described by an inner step
    throw new Error(`${step} failed: ${describeError(e)}`);
  }
}

/**
 * Works out which albums album mode reads. Ids win over names; names must match an album exactly (capitals count).
 * @returns {Promise<{id: string, name: string}[]>}
 * @throws {Error} If an id cannot be read or a name matches no album.
 */
async function resolveAlbums() {
  if (cfg.albumIds.length) {
    if (cfg.albumNames.length) log.warn('albumIds and albumNames are both set: albumIds is used and albumNames is ignored');
    return Promise.all(cfg.albumIds.map(id => inStep(`reading album "${id}"`, async () => ({ id, name: (await getAlbumInfo({ id })).albumName }))));
  }
  // Owned albums, and albums shared with this user: two lists, merged.
  const [owned, shared] = await inStep('listing the albums', () => Promise.all([getAllAlbums({}), getAllAlbums({ isShared: true })]));
  const byName = new Map([...owned, ...shared].map(a => [a.albumName, { id: a.id, name: a.albumName }]));
  return cfg.albumNames.map(name => {
    const found = byName.get(name);
    if (!found) throw new Error(`no album is named "${name}" (names must match exactly, capitals included)`);
    return found;
  });
}

/**
 * Lists the photos of the chosen albums from their timelines (newer Immich versions do not list assets in the album response).
 * @returns {Promise<object[]>} Rows (see assetRow), without duplicates; videos and trashed photos are left out.
 */
async function albumRows() {
  const rows = new Map();
  const timelineKey = orderField && TIMELINE_FIELDS[orderField];
  for (const album of albums) {
    const { buckets, days } = await inStep(`reading the photos of album "${album.name}"`, async () => {
      const buckets = await getTimeBuckets({ albumId: album.id });
      return { buckets, days: await Promise.all(buckets.map(b => getTimeBucket({ albumId: album.id, timeBucket: b.timeBucket }))) };
    });
    // The timeline returns parallel arrays (id[i], ratio[i], isImage[i] describe photo i).
    addRows(rows, days.flatMap(d => d.id.map((id, i) => (d.isImage[i] && !d.isTrashed?.[i] ? {
      id, ratio: d.ratio[i], value: timelineKey ? d[timelineKey]?.[i] : undefined,
      date: localDate(d.fileCreatedAt?.[i], d.localOffsetHours?.[i]), city: d.city?.[i] ?? undefined, country: d.country?.[i] ?? undefined
    } : null))));
  }
  const list = [...rows.values()];
  if (orderField && !timelineKey) {
    await lookUpExif(list.map(r => r.id));
    list.forEach(r => { r.value = exifCache.get(r.id)?.[orderField]; });
  }
  return list;
}

/**
 * Lists the photos of Immich's "on this day" memories for the days around today: one request per day.
 * @param {Date} now - The current time.
 * @returns {Promise<object[]>} Rows, without duplicates.
 */
async function memoryRows(now) {
  const rows = new Map();
  for (const day of memoryDays(now, cfg.daysBefore)) {
    const memories = await inStep(`reading the memories for ${day}`, () => searchMemories({ $for: day }));
    addRows(rows, memories.flatMap(m => m.assets.map(assetRow)));
  }
  return [...rows.values()];
}

/**
 * Runs one smart search. It is the only POST this plugin makes: Immich offers smart search only as a POST, and it reads only.
 * @param {number} page - Page number, from 1.
 * @param {number} size - Photos wanted on the page.
 * @returns {Promise<{items: any[], nextPage: string | null}>}
 * @throws {Error} With a hint about allowedPostHosts and Immich's machine learning if the search is refused.
 */
async function smartSearch(page, size) {
  try {
    const found = await searchSmart({
      smartSearchDto: {
        query: cfg.query, type: 'IMAGE', withExif: true, page, size,
        ...(cfg.personIds.length ? { personIds: cfg.personIds } : {}),
        ...(cfg.isFavorite ? { isFavorite: true } : {}),
        ...(cfg.city ? { city: cfg.city } : {}),
        ...(cfg.country ? { country: cfg.country } : {})
      }
    });
    return found.assets;
  } catch (e) {
    throw new Error(`smart search failed: ${describeError(e)}. Search needs this Immich host in "allowedPostHosts" on this plugin's entry in config.jsonc, and Immich's smart search (machine learning) must be switched on`);
  }
}

/**
 * Lists the photos matching the search, page by page, up to `maxImages` (SEARCH_DEFAULT_LIMIT if that is 0).
 * @returns {Promise<object[]>} Rows, without duplicates, in Immich's order of relevance.
 */
async function searchRows() {
  const limit = cfg.maxImages || SEARCH_DEFAULT_LIMIT;
  const rows = new Map();
  for (let page = 1; rows.size < limit;) {
    const found = await smartSearch(page, Math.min(SEARCH_PAGE_SIZE, limit - rows.size));
    addRows(rows, found.items.map(assetRow));
    if (!found.nextPage || !found.items.length) break;
    page = Number(found.nextPage);
  }
  return [...rows.values()];
}

/**
 * Builds the whole list from Immich: fetch by mode, order, cap.
 * @param {Date} now - The current time.
 * @returns {Promise<{title: string, images: object[], order: 'sequence' | 'random'}>}
 */
async function build(now) {
  const fetched = cfg.mode === 'album' ? await albumRows() : cfg.mode === 'memory' ? await memoryRows(now) : await searchRows();
  const ordered = !!orderField || keepRelevance;
  const rows = orderField ? sortRows(fetched, cfg.order.sort) : fetched;
  const images = capRows(rows, cfg.mode === 'search' ? 0 : cfg.maxImages, ordered)
    .map(({ id, ratio, date, city, state, country }) => ({ id, ratio, date, city, state, country }));
  const title = cfg.mode === 'album' ? albums.map(a => a.name).join(', ') : cfg.mode === 'memory' ? 'Memories' : `Search: ${cfg.query}`;
  log.info(`${cfg.mode}: ${images.length} photos${fetched.length > images.length ? ` (of ${fetched.length} found)` : ''}`);
  return { title, images, order: ordered ? 'sequence' : 'random' };
}

/**
 * Warns about settings that belong to another mode, so a typo or a leftover is noticed.
 * @returns {void}
 */
function warnUnusedSettings() {
  for (const [mode, keys] of Object.entries(MODE_SETTINGS)) {
    if (mode === cfg.mode) continue;
    const used = keys.filter(k => (Array.isArray(cfg[k]) ? cfg[k].length : cfg[k]));
    if (used.length) log.warn(`${used.join(', ')} only ${used.length > 1 ? 'apply' : 'applies'} in "${mode}" mode and ${used.length > 1 ? 'are' : 'is'} ignored in "${cfg.mode}" mode`);
  }
}

export default {
  apiVersion: 1,
  name: 'Immich library',

  settings: [
    { key: 'url', type: 'string', required: true, description: 'Address of your Immich server, e.g. https://photos.example.com (no /api)' },
    { key: 'apiKey', type: 'string', required: true, secret: true, description: 'Immich API key (Account Settings > API Keys). Give it read-only permissions: asset.read, album.read, memory.read, timeline.read (and person.read for personIds)' },
    { key: 'mode', type: 'enum', values: ['album', 'memory', 'search'], required: true, description: 'album = photos of the chosen albums, memory = "on this day" photos from earlier years, search = smart search by meaning' },
    { key: 'maxImages', type: 'number', default: 0, min: 0, max: 100000, integer: true, description: `Most photos to use (0 = all; in search mode 0 means ${SEARCH_DEFAULT_LIMIT}). Too many are dropped at random, or from the end when ordered` },
    {
      key: 'order', type: 'object', description: 'How photos are ordered: { by, sort }', fields: [
        { key: 'by', type: 'string', default: 'random', description: '"random", or the EXIF field to order by (e.g. DateTimeOriginal). Ignored in search mode, which keeps Immich\'s ranking. An unknown name is logged and gives random' },
        { key: 'sort', type: 'enum', values: ['asc', 'desc'], default: 'desc', description: '"desc" = newest / largest first, "asc" = oldest / smallest first' }
      ]
    },
    { key: 'albumIds', type: 'list', default: [], description: 'album mode: album ids (the last part of an album\'s address in Immich); used instead of albumNames when both are set' },
    { key: 'albumNames', type: 'list', default: [], description: 'album mode: album names, spelled exactly (capitals count)' },
    { key: 'daysBefore', type: 'number', default: MEMORY_DAYS_BEFORE_DEFAULT, min: 0, max: MEMORY_DAYS_BEFORE_MAX, integer: true, description: `memory mode: how many days back from today to include; the ${MEMORY_DAYS_AHEAD} days after today are always included (all of it: earlier years, on those dates)` },
    { key: 'query', type: 'string', default: '', description: 'search mode: what to look for, in words, e.g. "dogs on a beach" (required in search mode)' },
    { key: 'personIds', type: 'list', default: [], description: 'search mode: only photos of these people (person ids)' },
    { key: 'isFavorite', type: 'boolean', default: false, description: 'search mode: only photos marked as favourites' },
    { key: 'city', type: 'string', default: '', description: 'search mode: only photos taken in this city' },
    { key: 'country', type: 'string', default: '', description: 'search mode: only photos taken in this country' }
  ],

  /**
   * Connects the SDK to Immich and makes the mode's first request, so a wrong address, key, album or a refused search is
   * reported (and retried) at start-up instead of showing an empty wall.
   * @param {Record<string, any>} settings - Validated settings.
   * @param {{fetch: typeof fetch, log: import('../lib/logger.js').Logger}} ctx - Guarded fetch and logger.
   * @returns {Promise<void>}
   */
  async init(settings, ctx) {
    cfg = { ...settings, url: settings.url.replace(/\/$/, '') };
    log = ctx.log;
    cache = null;
    retryAfter = 0;
    lastError = null;
    if (cfg.mode === 'album' && !cfg.albumIds.length && !cfg.albumNames.length) throw new Error('album mode needs albumIds or albumNames');
    if (cfg.mode === 'search' && !cfg.query.trim()) throw new Error('search mode needs a query, e.g. "dogs"');
    warnUnusedSettings();
    keepRelevance = cfg.mode === 'search';
    if (keepRelevance && cfg.order.by.trim().toLowerCase() !== 'random') log.warn('order is ignored in search mode: photos stay in Immich\'s ranking, best match first');
    const order = keepRelevance ? { field: null, valid: true } : resolveOrder(cfg.order.by);
    orderField = order.field;
    if (!order.valid) {
      log.warn(`order.by "${cfg.order.by}" is not an EXIF field Immich keeps, so photos are shown in random order. Use "random" or one of: ${EXIF_FIELDS.join(', ')}`);
    } else if (orderField) {
      log.info(`ordering photos by ${orderField}, ${cfg.order.sort === 'asc' ? 'oldest / smallest' : 'newest / largest'} first`);
    }
    init({ baseUrl: `${cfg.url}/api`, apiKey: cfg.apiKey });
    defaults.fetch = ctx.fetch; // all SDK calls now go through the guard (GET only, unless the user allowed POST to this host)
    if (cfg.mode === 'album') {
      albums = await resolveAlbums();
      log.info(`reading ${albums.length} album${albums.length === 1 ? '' : 's'}: ${albums.map(a => `"${a.name}"`).join(', ')}`);
    } else if (cfg.mode === 'memory') {
      await inStep('reading memories', () => searchMemories({ $for: ymd(new Date()) }));
      log.info(`memories: from ${cfg.daysBefore} day${cfg.daysBefore === 1 ? '' : 's'} ago to ${MEMORY_DAYS_AHEAD} days ahead`);
    } else {
      await smartSearch(1, 1);
      log.info(`searching for "${cfg.query}"`);
    }
  },

  /**
   * The list of photos. Immich is asked only on the first call of each local day (see the notes at the top of this file); other
   * calls return the stored list.
   * @returns {Promise<{title: string, images: {id: string, ratio: number, date?: string, city?: string, state?: string, country?: string}[], order: 'sequence' | 'random'}>}
   */
  async getImages() {
    const now = new Date();
    const day = ymd(now);
    if (cache?.day === day) return cache.result;
    if (Date.now() < retryAfter) { // a refresh failed a moment ago: do not ask again yet
      if (cache) return cache.result;
      throw lastError;
    }
    refreshing ??= build(now).then(result => {
      cache = { day, result };
      lastError = null;
      return result;
    }, e => {
      retryAfter = Date.now() + REFRESH_RETRY_MS;
      lastError = e;
      if (!cache) throw e;
      log.warn(`could not refresh the list (${e.message}); using the previous one and trying again in ${REFRESH_RETRY_MS / 60000} minutes`);
      return cache.result;
    }).finally(() => { refreshing = null; });
    return refreshing;
  },

  /**
   * Gives the app the address of Immich's "preview" size (about 1440 pixels) of one photo; the app downloads it. The
   * API key goes in a request header, not in the address, so it can never appear in a log line or error message.
   * @param {string} id - Photo id from getImages.
   * @returns {Promise<{url: string, headers: Record<string, string>}>}
   */
  async getImage(id) {
    return { url: `${cfg.url}/api/assets/${encodeURIComponent(id)}/thumbnail?size=preview`, headers: { 'x-api-key': cfg.apiKey } };
  }
};
