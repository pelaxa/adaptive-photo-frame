/**
 * builtin-plugins/immich-sharedAlbum - photo source: one Immich shared album, read through its shared link.
 *
 * Named after the kind of Immich source it reads, so other Immich plugins (for example one for a whole
 * library) can be added next to it with their own ids.
 *
 * Lists the album with the official @immich/sdk, using the album's shared-link key. Those requests are
 * GETs and go through the guarded fetch the server gives plugins (ctx.fetch). The images themselves are
 * not downloaded here: getImage() hands the app Immich's thumbnail address and the app downloads,
 * resizes and caches it (see lib/images.js).
 * It also provides the shared-link page as the upload address, so the QR code lets guests add photos.
 *
 * Order: the `order` setting is { by, sort }. `by` is "random" (the default) or the name of an EXIF field Immich knows
 * about (see EXIF_FIELDS; any capitalisation, so DateTimeOriginal and dateTimeOriginal both work). `sort` is "desc"
 * (largest / newest first, the default) or "asc". The app shows the photos in that order, round after round, so with
 * "desc" on a date the newest photos come first in every round, and a photo added later is shown before the round ends.
 * A `by` that is not one of the fields is logged as a warning and the order stays random.
 * Photos without a value for the field come last, in either direction.
 *   - dateTimeOriginal is Immich's own capture date (the timeline carries it), as are city, country, latitude and
 *     longitude, so ordering by those costs nothing extra.
 *   - Any other field needs one request per photo for its details. They are fetched a few at a time, remembered,
 *     and limited to EXIF_BUDGET_MS per refresh, so a big album fills in over a few refreshes (photos not yet looked
 *     up come last until then).
 */
import { init, defaults, getAlbumInfo, getAssetInfo, getTimeBuckets, getTimeBucket } from '@immich/sdk';

/** The EXIF fields Immich keeps for a photo (its ExifResponseDto), which `order` may name. */
export const EXIF_FIELDS = [
  'city', 'country', 'dateTimeOriginal', 'description', 'exifImageHeight', 'exifImageWidth', 'exposureTime', 'fNumber',
  'fileSizeInByte', 'focalLength', 'iso', 'latitude', 'lensModel', 'longitude', 'make', 'model', 'modifyDate',
  'orientation', 'projectionType', 'rating', 'state', 'timeZone'
];
/** Fields the album timeline already carries, as the name of the timeline array that holds each. */
const TIMELINE_FIELDS = { dateTimeOriginal: 'fileCreatedAt', city: 'city', country: 'country', latitude: 'latitude', longitude: 'longitude' };
/** Longest (ms) one refresh spends looking up per-photo EXIF details. */
const EXIF_BUDGET_MS = 8000;
/** How many per-photo lookups run at once. */
const EXIF_PARALLEL = 8;

/** Validated settings, set by init(). @type {{url: string, albumId: string, shareKey: string, order: {by: string, sort: 'asc' | 'desc'}}} */
let cfg;
/** The EXIF field to order by (one of EXIF_FIELDS), or null for random. Set by init(). @type {string | null} */
let orderField = null;
/** The direction to sort in. Set by init(). @type {'asc' | 'desc'} */
let orderSort = 'desc';
/** Per-photo EXIF details looked up so far, by photo id (they do not change). @type {Map<string, Record<string, any>>} */
const exifCache = new Map();
/** Logger from init(). @type {import('../lib/logger.js').Logger} */
let log;

/**
 * The day (and time) a photo was taken, as the place where it was taken showed it, for the app's caption.
 * Immich keeps the capture time in UTC plus the hours of offset that place had; adding the offset gives the local clock reading.
 * @param {string | null | undefined} iso - Capture time in UTC (ISO text).
 * @param {number} [offsetHours=0] - Hours the photo's place was ahead of UTC.
 * @returns {string | undefined} Local time as ISO text without a zone (its first ten characters are the day), or undefined if there is no usable date.
 */
export function localDate(iso, offsetHours = 0) {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? undefined : new Date(ms + offsetHours * 3_600_000).toISOString().slice(0, 19);
}

/**
 * Turns the `order` setting into the field to sort by.
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
 * Looks up the EXIF details of photos that have not been looked up yet, a few at a time, until they are
 * all done or EXIF_BUDGET_MS has passed. A failed lookup is simply tried again on the next refresh.
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
        exifCache.set(id, (await getAssetInfo({ id, key: cfg.shareKey })).exifInfo ?? {});
      } catch (e) {
        log.debug(`could not look up the details of a photo (${e.message}); trying again on the next refresh`);
      }
    }
  }));
  const missing = todo.filter(id => !exifCache.has(id)).length;
  if (missing) log.info(`ordering by ${orderField}: ${missing} of ${todo.length} photos not looked up yet; continuing on the next refresh`);
}

export default {
  apiVersion: 1,
  name: 'Immich shared album',

  settings: [
    { key: 'url', type: 'string', required: true, description: 'Address of your Immich server, e.g. https://photos.example.com (no /api)' },
    { key: 'albumId', type: 'string', required: true, description: 'Album id: the last part of the album\'s address in Immich (.../albums/<id>)' },
    { key: 'shareKey', type: 'string', required: true, secret: true, description: 'Key of the album\'s shared link: the part after /share/' },
    {
      key: 'order', type: 'object', description: 'How photos are ordered: { by, sort }', fields: [
        { key: 'by', type: 'string', default: 'random', description: '"random", or the EXIF field to order by (e.g. DateTimeOriginal). An unknown name is logged and gives random' },
        { key: 'sort', type: 'enum', values: ['asc', 'desc'], default: 'desc', description: '"desc" = newest / largest first, "asc" = oldest / smallest first' }
      ]
    }
  ],

  /**
   * Connects the SDK to Immich and checks the album can be read, so a wrong address or key is
   * reported (and retried) at start-up instead of showing an empty wall.
   * @param {typeof cfg} settings - Validated settings.
   * @param {{fetch: typeof fetch, log: import('../lib/logger.js').Logger}} ctx - Guarded fetch and logger.
   * @returns {Promise<void>}
   */
  async init(settings, ctx) {
    cfg = { ...settings, url: settings.url.replace(/\/$/, '') };
    log = ctx.log;
    const order = resolveOrder(cfg.order.by);
    orderField = order.field;
    orderSort = cfg.order.sort;
    if (!order.valid) {
      log.warn(`order.by "${cfg.order.by}" is not an EXIF field Immich keeps, so photos are shown in random order. Use "random" or one of: ${EXIF_FIELDS.join(', ')}`);
    } else if (orderField) {
      log.info(`ordering photos by ${orderField}, ${orderSort === 'asc' ? 'oldest / smallest' : 'newest / largest'} first`);
    }
    init({ baseUrl: `${cfg.url}/api` });
    defaults.fetch = ctx.fetch; // all SDK calls now go through the GET-only guard
    const album = await getAlbumInfo({ id: cfg.albumId, key: cfg.shareKey });
    ctx.log.info(`connected to album "${album.albumName}" (${album.assetCount} items)`);
  },

  /**
   * Lists the album's photos. Newer Immich versions do not include assets in the album response,
   * so the list comes from the album's timeline (one request per time bucket). Videos are skipped.
   * With an `order.by` field the list is sorted by it, in the `order.sort` direction (see the notes at the top of this file).
   * @returns {Promise<{title: string, images: {id: string, ratio: number, date?: string, city?: string, country?: string}[], order: 'sequence' | 'random'}>}
   */
  async getImages() {
    const opts = { albumId: cfg.albumId, key: cfg.shareKey };
    const [info, buckets] = await Promise.all([getAlbumInfo({ id: cfg.albumId, key: cfg.shareKey }), getTimeBuckets(opts)]);
    const days = await Promise.all(buckets.map(b => getTimeBucket({ ...opts, timeBucket: b.timeBucket })));
    // The timeline returns parallel arrays (id[i], ratio[i], isImage[i] describe photo i).
    const timelineKey = orderField && TIMELINE_FIELDS[orderField];
    let rows = days.flatMap(d => d.id.flatMap((id, i) => (d.isImage[i]
      ? [{
        id, ratio: d.ratio[i], value: timelineKey ? d[timelineKey]?.[i] : undefined,
        date: localDate(d.fileCreatedAt?.[i], d.localOffsetHours?.[i]), city: d.city?.[i] ?? undefined, country: d.country?.[i] ?? undefined
      }]
      : [])));

    if (orderField) {
      if (!timelineKey) {
        await lookUpExif(rows.map(r => r.id));
        rows.forEach(r => { r.value = exifCache.get(r.id)?.[orderField]; });
      }
      rows = sortRows(rows, orderSort);
    }
    return {
      title: info.albumName,
      images: rows.map(({ id, ratio, date, city, country }) => ({ id, ratio, date, city, country })),
      order: orderField ? 'sequence' : 'random'
    };
  },

  /**
   * Gives the app the address of Immich's "preview" size (about 1440 pixels) of one photo; the app
   * downloads it. The shared-link key goes in the documented `key` query parameter (the SDK uses the same
   * one). The app never logs or shows a download address's query string, so the key stays out of its logs.
   * An `x-immich-share-key` header also works today, but it is not part of Immich's documented API.
   * @param {string} id - Photo id from getImages.
   * @returns {Promise<{url: string}>}
   */
  async getImage(id) {
    return { url: `${cfg.url}/api/assets/${encodeURIComponent(id)}/thumbnail?size=preview&key=${encodeURIComponent(cfg.shareKey)}` };
  },

  /**
   * The shared-link page, where guests can add photos if the link allows it.
   * @returns {string}
   */
  getUploadUrl() {
    return `${cfg.url}/share/${cfg.shareKey}`;
  }
};
