/**
 * images.js - the app's image service: fetches, checks, resizes and caches every image for the wall.
 *
 * Plugins only say WHERE an image is. getImage() returns either the image's bytes ({ body }) or a web
 * address for the app to download ({ url, headers? }). Everything after that happens here, in one
 * place and with `sharp`, so plugins need no image library (they run in a sandbox that cannot load one):
 *   1. get the bytes (from the plugin, or by downloading the URL with a time and size limit);
 *   2. check they are really a JPEG, PNG or WebP (by their first bytes, before any decoder sees them);
 *   3. resize to fit `maxPixels` and bake in the EXIF rotation, unless the image is already fine as it is;
 *   4. keep the result on disk (cacheDir), so each image is fetched and resized once, not once per viewer.
 *
 * shortcut: the cache is never pruned; a cached image is reused for CACHE_SECONDS and then fetched
 * again. Delete .cache/images to reclaim space, upgrade to a size-limited cache if photos run to many GB.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/** How long (seconds) a cached image is reused before the plugin is asked for it again. */
export const CACHE_SECONDS = 86400;
/** Largest download or plugin-supplied image accepted, in bytes. */
export const MAX_BYTES = 50 * 1024 * 1024;
/** Largest image accepted, in pixels (width x height); protects against decompression bombs. */
const MAX_INPUT_PIXELS = 100_000_000;

/** Quality (1-100) of the JPEG that is made when a photo has to be resized or rotated. */
const JPEG_QUALITY = 85;
/** Length of the hexadecimal name of a cache file, taken from the start of a hash. */
const CACHE_KEY_LENGTH = 32;

/** Output file type for each format that is allowed in. */
const TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * Works out an image's format from its first bytes. This runs before any image library sees the
 * data, so formats that can reference other files (SVG) or are not wanted are never decoded.
 * @param {Buffer} bytes - The start of the file.
 * @returns {'jpeg' | 'png' | 'webp' | null} The format, or null if it is not an allowed one.
 */
export function sniff(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Downloads an image for a plugin. Only http(s) addresses are fetched, with a time limit, a size
 * limit, and without sending any cookies. Error messages show the address without its query string,
 * because that is where services put keys.
 * @param {string} address - The URL the plugin gave.
 * @param {Record<string, string>} headers - Extra request headers the plugin asked for (e.g. an API key).
 * @param {number} timeoutSeconds - Time allowed for the whole download.
 * @returns {Promise<Buffer>} The downloaded bytes.
 * @throws {Error} If the address is not http(s), the download fails, or it is larger than MAX_BYTES.
 */
async function download(address, headers, timeoutSeconds) {
  let url;
  try { url = new URL(address); } catch { throw new Error('the image address is not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`the image address must be http or https, not ${url.protocol}`);
  const where = `${url.origin}${url.pathname}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutSeconds * 1000) })
    .catch(e => { throw new Error(`could not download ${where}: ${e.message}`); });
  if (!res.ok) throw new Error(`downloading ${where} answered ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error(`${where} is larger than ${MAX_BYTES} bytes`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BYTES) throw new Error(`${where} is larger than ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Checks an image and, if needed, shrinks and straightens it.
 * An image that is already small enough, upright, and in an allowed format is returned unchanged
 * (no quality loss, no work). Anything else becomes a JPEG at quality 85 that fits maxPixels.
 * @param {Buffer} bytes - The image file.
 * @param {number} maxPixels - Longest side wanted.
 * @returns {Promise<{body: Buffer, contentType: string}>}
 * @throws {Error} If the bytes are not an allowed, decodable image.
 */
export async function prepareImage(bytes, maxPixels) {
  const format = sniff(bytes);
  if (!format) throw new Error('the image is not a JPEG, PNG or WebP file');
  const options = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' };
  const meta = await sharp(bytes, options).metadata();
  const upright = (meta.orientation ?? 1) === 1;
  if (upright && Math.max(meta.width, meta.height) <= maxPixels) return { body: bytes, contentType: TYPES[format] };
  const body = await sharp(bytes, options)
    .rotate() // bake in the EXIF rotation; the metadata is dropped, so it cannot be applied twice
    .resize({ width: maxPixels, height: maxPixels, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { body, contentType: TYPES.jpeg };
}

/**
 * Creates the image service for one running plugin.
 * @param {object} options
 * @param {(id: string, opts: {maxPixels: number}) => Promise<any>} options.getImage - The plugin's getImage (see
 *   lib/plugins.js): returns { body } or { url, headers? }.
 * @param {string} options.pluginId - Part of the cache key, so switching plugins never shows another plugin's image.
 * @param {string} options.cacheDir - Folder for cached images (created on first use).
 * @param {number} options.timeoutSeconds - Time allowed for downloading a plugin-supplied URL.
 * @param {{warn: (msg: string) => void}} [options.log] - Receives one warning if the cache folder cannot be written.
 * @returns {{get: (id: string, maxPixels: number) => Promise<{body: Buffer, contentType: string}>}}
 */
export function createImageService({ getImage, pluginId, cacheDir, timeoutSeconds, log }) {
  let warnedAboutCache = false;
  /** Requests being worked on, so viewers asking for the same image at once share one fetch. @type {Map<string, Promise<any>>} */
  const inFlight = new Map();

  /**
   * Gets one image from the cache, or builds it and stores it.
   * @param {string} id - The plugin's image id.
   * @param {number} maxPixels - Longest side wanted.
   * @returns {Promise<{body: Buffer, contentType: string}>}
   */
  async function build(id, maxPixels) {
    const key = createHash('sha256').update(`${pluginId}\0${id}\0${maxPixels}`).digest('hex').slice(0, CACHE_KEY_LENGTH);
    for (const [format, contentType] of Object.entries(TYPES)) {
      const file = join(cacheDir, `${key}.${format}`);
      const st = await stat(file).catch(() => null);
      if (st && Date.now() - st.mtimeMs < CACHE_SECONDS * 1000) return { body: await readFile(file), contentType };
    }

    const result = await getImage(id, { maxPixels });
    let bytes;
    if (result?.url) bytes = await download(result.url, result.headers ?? {}, timeoutSeconds);
    else if (result?.body instanceof Uint8Array) bytes = Buffer.from(result.body.buffer, result.body.byteOffset, result.body.byteLength);
    else throw new Error('getImage() must return { body: Buffer } or { url: string }');
    if (bytes.length > MAX_BYTES) throw new Error(`the image is larger than ${MAX_BYTES} bytes`);

    const out = await prepareImage(bytes, maxPixels);
    try {
      await mkdir(cacheDir, { recursive: true });
      const file = join(cacheDir, `${key}.${Object.keys(TYPES).find(f => TYPES[f] === out.contentType)}`);
      const temp = `${file}.${process.pid}.tmp`; // write then rename, so a half-written file is never read
      await writeFile(temp, out.body);
      await rename(temp, file);
    } catch (e) {
      // A cache that cannot be written (read-only disk, a folder owned by another user) must not stop photos from showing.
      if (!warnedAboutCache) log?.warn(`cannot write the image cache in ${cacheDir} (${e.code ?? e.message}); photos are still shown, but fetched and resized again each time`);
      warnedAboutCache = true;
    }
    return out;
  }

  return {
    get(id, maxPixels) {
      const key = `${id}\0${maxPixels}`;
      if (!inFlight.has(key)) inFlight.set(key, build(id, maxPixels).finally(() => inFlight.delete(key)));
      return inFlight.get(key);
    }
  };
}
