/**
 * server.js - the back end of the photo wall.
 *
 * It does three jobs:
 *  1. Serves the web page in ./public, so opening this server in any browser starts the wall.
 *  2. Loads the active photo-source plugin chosen in config.jsonc (see lib/plugins.js) and passes
 *     its photos to the page. The page never talks to the photo service, so addresses and keys
 *     stay on the server.
 *  3. Makes the QR code for the plugin's upload address, if it has one.
 *
 * Endpoints (all GET):
 *   /api/config      { ready, ...display settings, qr: {...} }
 *   /api/images       { title, images: [{ id, ratio }] }  (503 while the plugin is still starting)
 *   /api/image/:id   one photo, checked, resized and cached by the app (lib/images.js), only for ids in the current list
 *   /api/qr.svg      the QR code (404 if there is no upload address)
 *   /*               static files from ./public
 *
 * Start with `npm start`; use `npm start -- --config other.jsonc` for another config file.
 * The default port is 3000 (server.port in config.jsonc); if it is already in use the server says so and stops.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { ConfigError, loadConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { createImageService } from './lib/images.js';
import { createRuntime, PluginError } from './lib/plugins.js';
import { SettingsError } from './lib/settings.js';
import { readCustomCss } from './lib/customCss.js';

const baseDir = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(baseDir, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
/** Longest side (pixels) of each photo sent to the browser on high-power hardware. */
const HIGH_POWER_PIXELS = 1440;
/** Longest side (pixels) of each photo sent to the browser on the other hardware levels: smaller, so lighter to decode. */
const STANDARD_PIXELS = 1080;
/** After a shutdown signal, how long (milliseconds) to wait for a clean stop before exiting anyway. */
const SHUTDOWN_GRACE_MS = 2000;
/** The user's optional style overrides: custom.css in the same folder as the config file. (configPath is a function declaration, so it can be used here, above where it is written.) */
const CUSTOM_CSS = join(dirname(configPath()), 'custom.css');

// ---- start-up: any configuration problem stops the server with a readable message ----
let config, log, runtime;
try {
  config = await loadConfig(configPath(), createLogger('info'));
  log = createLogger(config.server.logLevel);
  runtime = await createRuntime({ config, log, baseDir });
} catch (e) {
  if (!(e instanceof ConfigError || e instanceof PluginError || e instanceof SettingsError)) throw e;
  console.error(`\nCannot start: ${e.message}\n`);
  process.exit(1);
}
const { display, qr, clock } = config;
/** Longest side (pixels) of each photo sent to the browser, by the configured hardware level. */
const MAX_PIXELS = display.hardware === 'high-power' ? HIGH_POWER_PIXELS : STANDARD_PIXELS;
/** Fetches photos from the plugin and resizes and caches them. */
const images = createImageService({
  getImage: runtime.getImage,
  pluginId: config.plugin.id,
  cacheDir: join(baseDir, '.cache', 'images'),
  timeoutSeconds: config.server.pluginTimeoutSeconds,
  log
});

/**
 * Value of the --config command-line option, or the default config file next to this file.
 * @returns {string} Path to the config file.
 */
function configPath() {
  const i = process.argv.indexOf('--config');
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : join(baseDir, 'config', 'config.jsonc');
}

/**
 * Writes a complete HTTP response.
 * @param {import('node:http').ServerResponse} res - The response to write to.
 * @param {number} status - HTTP status code.
 * @param {string | Buffer} body - Response body.
 * @param {string} [type='application/json'] - Content-Type header.
 * @param {Record<string, string>} [extra={}] - Additional headers, e.g. Cache-Control.
 * @returns {void}
 */
const send = (res, status, body, type = 'application/json', extra = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
};

/**
 * Handles one HTTP request: API routes first, then static files from ./public.
 * Errors from the plugin become a 502 so the page can simply try again later.
 * @param {import('node:http').IncomingMessage} req - The request.
 * @param {import('node:http').ServerResponse} res - The response.
 * @returns {Promise<void>}
 */
async function handle(req, res) {
  try {
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
    const { pathname } = new URL(req.url, 'http://x');

    if (pathname === '/api/config') {
      const hasQr = qr.enabled && !!runtime.getUploadUrl();
      return send(res, 200, JSON.stringify({ ready: runtime.ready(), ...display, qr: { ...qr, enabled: hasQr }, clock }), 'application/json', { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/images') {
      if (!runtime.ready()) return send(res, 503, JSON.stringify({ status: 'starting' }), 'application/json', { 'Cache-Control': 'no-store' });
      return send(res, 200, JSON.stringify(await runtime.getImages()), 'application/json', { 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/qr.svg') {
      const url = qr.enabled ? runtime.getUploadUrl() : null;
      if (!url) return send(res, 404, 'Not found', 'text/plain');
      // Plain black squares on a transparent background: the page uses the SVG as a mask and paints it in its own colour (the .qrcode
      // `color` in CSS), so the look is set from style.css / custom.css and not from here.
      const svg = await QRCode.toString(url, { type: 'svg', margin: 0, color: { dark: '#000000', light: '#00000000' } });
      return send(res, 200, svg, 'image/svg+xml', { 'Cache-Control': 'max-age=3600' });
    }
    const m = pathname.match(/^\/api\/image\/([^/]+)$/);
    if (m) {
      if (!runtime.ready()) return send(res, 503, 'Starting', 'text/plain');
      let id;
      try { id = decodeURIComponent(m[1]); } catch { return send(res, 404, 'Not found', 'text/plain'); }
      // Only serve images that are in the current list, so the plugin is never asked for anything else.
      if (!(await runtime.getImages()).images.some(i => i.id === id)) return send(res, 404, 'Not found', 'text/plain');
      const image = await images.get(id, MAX_PIXELS);
      return send(res, 200, image.body, image.contentType, { 'Cache-Control': 'max-age=86400' });
    }

    if (pathname === '/custom.css') {
      // The user's optional style overrides, kept next to config.jsonc. Fixed path; no cache so an edit shows on the next page load.
      return send(res, 200, await readCustomCss(CUSTOM_CSS), 'text/css', { 'Cache-Control': 'no-cache' });
    }

    // Static files. normalize + startsWith stops "../" tricks from escaping ./public.
    const file = normalize(join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return send(res, 404, 'Not found', 'text/plain');
    log.error(`${req.url}: ${e.message}`);
    send(res, 502, 'Upstream error', 'text/plain');
  }
}

const server = createServer(handle);
server.on('error', e => {
  console.error(`\nCannot listen on ${config.server.host}:${config.server.port}: ${e.code === 'EADDRINUSE' ? 'that port is already in use (is another copy running? change server.port in config.jsonc)' : e.message}\n`);
  process.exit(1);
});
server.listen(config.server.port, config.server.host, () =>
  log.info(`Adaptive Photo Frame on http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}`));

// Stop cleanly on Ctrl+C or `docker stop`. As process 1 in a container, Node ignores these signals unless it handles them.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    runtime.close(); // stops the plugin's process
    server.close(() => process.exit(0));
    server.closeAllConnections(); // browsers keep connections open; do not wait for them
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
}
