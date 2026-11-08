/**
 * plugins.js - finds, loads and runs the one active photo-source plugin.
 *
 * A plugin is an ES module whose default export follows the contract below. Its id is its folder
 * or file name, and it lives in plugins/:
 *   plugins/<id>/index.js     the usual form: a folder with its own package.json and node_modules
 *   plugins/<id>.js           a single file (Node's built-in modules only)
 * EVERY plugin runs in a file-access SANDBOX (see sandbox.js); there is no setting to turn that off and
 * nothing runs inside the server. A plugin can only use packages installed in its own folder
 * (`npm install` there, or `npm run install-plugins` for all), plus Node's built-in modules.
 *
 * THE CONTRACT (apiVersion 1)
 *   apiVersion: 1                      required; the server refuses versions it does not know
 *   name: 'Immich'                     required; shown in logs, which are prefixed with it
 *   settings: [SettingSpec, ...]       required (may be empty); what config.jsonc may contain for it
 *   allowedPostHosts: ['host']         optional; hosts that may receive non-GET requests
 *   init(settings, ctx)                optional; runs at every start; throw if not ready (it is retried)
 *   setup(ctx)                         optional; run by hand with `npm run setup`
 *   getImages()                        required; -> { title, images: [{ id, ratio }], order? }
 *                                      order 'sequence' = show the images in the order listed, round after round
 *                                      (every image once before any repeats); 'random' (default) = chosen at random
 *   getImage(id, { maxPixels })        required; -> { body: Buffer }  OR  { url, headers? }
 *                                      Either the image's bytes, or a web address (http/https) for the app to
 *                                      download, with optional request headers such as an API key. The app
 *                                      checks, resizes (to about maxPixels) and caches it: see images.js.
 *   getUploadUrl()                     optional; -> address of the service's own upload page, or null
 *                                      (may be async; it is read once, right after init succeeds)
 * ctx is { fetch, log, pluginDir, prompt }: fetch is GET-only advice (see guardedFetch.js), log is prefixed
 * with the plugin name, pluginDir is the plugin's own folder (the one place it may read; for a single-file
 * plugin, the file itself), prompt asks a question on the terminal during `npm run setup`.
 *
 * Adding a new contract version: add it to ADAPTERS, which turns the module into the internal
 * shape used here. Nothing else in the server needs to know about versions.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSettings, maskSecrets } from './settings.js';
import { LEVELS } from './logger.js';
import { loadSandboxed, sandboxSupported } from './sandbox.js';

/** Error thrown when a plugin cannot be found or does not follow the contract. */
export class PluginError extends Error {}

/** How long (ms) the image list is reused, so many viewers do not each hit the photo service. */
export const IMAGE_LIST_TTL = 30_000;

/** Where plugins live: the ones shipped with the app, then the ones the user adds (an id may exist in only one of them). */
export const PLUGIN_FOLDERS = ['builtin-plugins', 'plugins'];

/**
 * The internal shape every plugin is converted to, whatever contract version it was written for.
 * @typedef {object} Plugin
 * @property {string} name
 * @property {import('./settings.js').SettingSpec[]} settings
 * @property {string[]} allowedPostHosts
 * @property {((settings: object) => Promise<void>) | undefined} init
 * @property {(() => Promise<void>) | undefined} setup
 * @property {() => Promise<{title: string, images: {id: string, ratio: number}[]}>} getImages
 * @property {(id: string, opts: {maxPixels: number}) => Promise<{body?: Buffer, url?: string, headers?: Record<string, string>}>} getImage
 * @property {() => string | null | undefined | Promise<string | null | undefined>} getUploadUrl
 * @property {(callback: () => void) => void} onExit - Registers a callback for when the plugin process stops unexpectedly.
 * @property {() => void} close - Stops the plugin process.
 */

/**
 * Converters from each supported contract version to the internal shape. The keys are the
 * apiVersion values the server accepts.
 * @type {Record<number, (mod: any, where: string) => Plugin>}
 */
const ADAPTERS = {
  1(mod, where) {
    if (typeof mod.name !== 'string' || !mod.name.trim()) throw new PluginError(`${where}: "name" must be text`);
    if (!Array.isArray(mod.settings)) throw new PluginError(`${where}: "settings" must be a list (use [] for none)`);
    for (const fn of ['getImages', 'getImage']) {
      if (typeof mod[fn] !== 'function') throw new PluginError(`${where}: missing required function ${fn}()`);
    }
    for (const fn of ['init', 'setup', 'getUploadUrl']) {
      if (mod[fn] !== undefined && typeof mod[fn] !== 'function') throw new PluginError(`${where}: ${fn} must be a function`);
    }
    return {
      name: mod.name.trim(),
      settings: mod.settings,
      allowedPostHosts: mod.allowedPostHosts ?? [],
      init: mod.init && (settings => mod.init(settings)),
      setup: mod.setup && (() => mod.setup()),
      getImages: () => mod.getImages(),
      getImage: (id, opts) => mod.getImage(id, opts),
      getUploadUrl: () => mod.getUploadUrl?.() ?? null,
      onExit: mod.onExit,
      close: mod.close
    };
  }
};

/** Contract versions this server understands. */
export const API_VERSIONS = Object.keys(ADAPTERS).map(Number);

/**
 * Whether a file exists.
 * @param {string} path - File path.
 * @returns {Promise<boolean>}
 */
const exists = path => access(path).then(() => true, () => false);

/**
 * @typedef {object} PluginLocation
 * @property {string} file - The plugin's entry file.
 * @property {string} readable - The only path the sandboxed plugin may read: its folder, or its file if it is a single file.
 */

/**
 * Finds where a plugin id lives. If the id exists in both forms the server refuses to guess.
 * @param {string} id - Plugin id (letters, digits and hyphens; case-sensitive, so it must match the file or folder name exactly).
 * @param {string} baseDir - The server folder containing builtin-plugins/ (shipped with the app) and plugins/ (added by the user).
 * @returns {Promise<PluginLocation>}
 * @throws {PluginError} If the id is invalid, not found, or ambiguous.
 */
export async function resolvePlugin(id, baseDir) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new PluginError(`Invalid plugin id "${id}" (letters, digits and hyphens only)`);
  const candidates = PLUGIN_FOLDERS.flatMap(folder => [
    { file: join(baseDir, folder, id, 'index.js'), readable: join(baseDir, folder, id) },
    { file: join(baseDir, folder, `${id}.js`), readable: join(baseDir, folder, `${id}.js`) }
  ]);
  const found = [];
  for (const c of candidates) if (await exists(c.file)) found.push(c);
  if (!found.length) throw new PluginError(`Plugin "${id}" not found. Looked for:\n  ${candidates.map(c => c.file).join('\n  ')}`);
  if (found.length > 1) throw new PluginError(`Plugin id "${id}" is ambiguous, it exists in:\n  ${found.map(c => c.file).join('\n  ')}\nRename or remove one.`);
  return found[0];
}

/**
 * Loads a plugin into its sandboxed process and converts it to the internal shape.
 * @param {string} id - Plugin id.
 * @param {string} baseDir - The server folder.
 * @param {object} [options]
 * @param {import('./logger.js').Logger} [options.log] - Receives the plugin's log lines.
 * @param {number} [options.timeoutSeconds=15] - Time limit for each call to the plugin.
 * @param {(question: string) => Promise<string>} [options.prompt] - Answers ctx.prompt() for the plugin's setup step.
 * @returns {Promise<Plugin>}
 * @throws {PluginError} If it cannot be found, loaded, or does not follow the contract.
 */
export async function loadPlugin(id, baseDir, { log, timeoutSeconds = 15, prompt } = {}) {
  const location = await resolvePlugin(id, baseDir);
  let mod;
  try {
    if (!sandboxSupported()) {
      throw new Error('this version of Node cannot sandbox plugins (it lacks the permission flags). A newer Node is needed');
    }
    mod = await loadSandboxed({ file: location.file, readable: location.readable, log, timeoutSeconds, prompt });
  } catch (e) {
    throw new PluginError(`Plugin "${id}" (${location.file}) failed to load: ${e.message}${hint(e)}`);
  }
  if (!mod || typeof mod !== 'object') throw new PluginError(`Plugin "${id}" must export an object as its default export`);
  const adapter = ADAPTERS[mod.apiVersion];
  if (!adapter) {
    mod.close?.();
    throw new PluginError(`Plugin "${id}" was written for apiVersion ${mod.apiVersion}; this server supports ${API_VERSIONS.join(', ')}`);
  }
  try {
    return adapter(mod, `Plugin "${id}"`);
  } catch (e) {
    mod.close?.(); // do not leave the process of a plugin that breaks the contract running
    throw e;
  }
}

/**
 * Extra advice for the most common load failure: a plugin whose packages were never installed.
 * @param {Error} e - The load error.
 * @returns {string} Text to append to the message, or ''.
 */
function hint(e) {
  return /Cannot find (package|module)/.test(e.message)
    ? '\n  (a package is missing: run `npm install` inside the plugin\'s folder, or `npm run install-plugins`. Plugins cannot use the app\'s own packages.)'
    : '';
}

/**
 * Rejects if a promise takes longer than the timeout.
 * @template T
 * @param {Promise<T>} promise - The work.
 * @param {number} seconds - Time allowed.
 * @param {string} label - What was being done, for the error message.
 * @returns {Promise<T>} The promise's result.
 */
function withTimeout(promise, seconds, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${seconds}s`)), seconds * 1000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Checks and cleans the image list returned by a plugin: drops entries with a bad id or ratio
 * and repeated ids, so one bad entry cannot break the wall.
 * @param {any} result - Whatever getImages returned.
 * @param {{warn: (msg: string) => void}} log - Receives a warning if entries were dropped.
 * @returns {{title: string, images: {id: string, ratio: number}[], order: 'sequence'|'random'}} The list in the shape the browser uses.
 * @throws {Error} If the result is not an object with an images list.
 */
export function normalizeImages(result, log) {
  if (!result || !Array.isArray(result.images)) throw new Error('getImages() must return { title, images: [...] }');
  const seen = new Set();
  const images = result.images
    .filter(p => typeof p?.id === 'string' && p.id && Number.isFinite(p.ratio) && p.ratio > 0 && !seen.has(p.id) && seen.add(p.id))
    .map(p => ({ id: p.id, ratio: p.ratio }));
  if (images.length !== result.images.length) log.warn(`ignored ${result.images.length - images.length} invalid or duplicate image entries`);
  if (result.order !== undefined && result.order !== 'sequence' && result.order !== 'random') {
    log.warn(`ignored unknown order "${result.order}" (use 'sequence' or 'random')`);
  }
  return { title: String(result.title ?? ''), images, order: result.order === 'sequence' ? 'sequence' : 'random' };
}

/**
 * @typedef {object} Runtime
 * @property {() => boolean} ready - True once the plugin's init has succeeded.
 * @property {() => Promise<{title: string, images: {id: string, ratio: number}[]}>} getImages - Cached image list.
 * @property {(id: string, opts: {maxPixels: number}) => Promise<{body?: Buffer, url?: string, headers?: Record<string, string>}>} getImage - The plugin's own answer; the app's image service (images.js) turns it into an image.
 * @property {() => string | null} getUploadUrl - Upload page of the photo service (read once after start-up), or null.
 * @property {() => void} close - Stops the plugin's process.
 * @property {Plugin} plugin - The loaded plugin.
 * @property {Record<string, any>} settings - Its validated settings.
 */

/**
 * Loads the active plugin, checks its settings, and starts it in the background.
 * Problems with the configuration (plugin not found, wrong apiVersion, bad settings) throw
 * straight away, because retrying cannot fix them. Problems while starting (e.g. the network is
 * not up yet) are logged and retried every `startupRetrySeconds`, and the page shows "Starting".
 * @param {object} options
 * @param {import('./config.js').AppConfig} options.config - The validated app config.
 * @param {import('./logger.js').Logger} options.log - The app logger.
 * @param {string} options.baseDir - The server folder.
 * @param {boolean} [options.start=true] - False to load and validate only (used by the tools).
 * @param {(question: string) => Promise<string>} [options.prompt] - Answers ctx.prompt() during `npm run setup`.
 * @returns {Promise<Runtime>}
 * @throws {PluginError|import('./settings.js').SettingsError} For configuration problems.
 */
export async function createRuntime({ config, log, baseDir, start = true, prompt }) {
  const { pluginTimeoutSeconds: timeout, startupRetrySeconds: retry } = config.server;
  // A sandboxed plugin starts logging as soon as it is loaded, but its name (the log prefix) is only
  // known after that. This logger writes under the plugin's id first and switches to the name below.
  const route = { to: log.child(config.plugin.id) };
  const routedLog = Object.fromEntries(LEVELS.map(level => [level, (...args) => route.to[level](...args)]));
  const plugin = await loadPlugin(config.plugin.id, baseDir, { log: routedLog, timeoutSeconds: timeout, prompt });
  let settings;
  try {
    settings = readSettings(plugin.settings, config.plugin.settings, `plugins["${config.plugin.id}"].settings`, log);
  } catch (e) {
    plugin.close(); // wrong settings: do not leave the plugin's process running
    throw e;
  }
  const pluginLog = log.child(plugin.name);
  route.to = pluginLog;
  pluginLog.debug('settings', JSON.stringify(maskSecrets(plugin.settings, settings)));

  let isReady = false;
  let starting = false;
  let uploadUrl = null;
  let cache = { at: 0, album: null };

  /**
   * Runs init until it succeeds, then reads the upload address once; never throws.
   * @returns {Promise<void>} Resolves once the plugin is ready (or at once if a loop is already running).
   */
  async function startLoop() {
    if (starting) return;
    starting = true;
    for (;;) {
      try {
        await withTimeout(Promise.resolve(plugin.init?.(settings)), timeout, 'init');
        uploadUrl = await withTimeout(Promise.resolve(plugin.getUploadUrl()), timeout, 'getUploadUrl').then(u => u ?? null, e => {
          pluginLog.warn(`getUploadUrl failed (${e.message}); no QR code will be shown`);
          return null;
        });
        isReady = true;
        starting = false;
        pluginLog.info('ready');
        return;
      } catch (e) {
        pluginLog.warn(`could not start: ${e.message}; trying again in ${retry}s`);
        await new Promise(resolve => setTimeout(resolve, retry * 1000));
      }
    }
  }
  // The plugin's process can die (or be killed for hanging). Start it again from the beginning.
  plugin.onExit(() => {
    if (isReady) pluginLog.warn('the plugin process stopped; restarting it');
    isReady = false;
    if (start) startLoop();
  });
  if (start) startLoop();

  return {
    plugin, settings,
    ready: () => isReady,
    getUploadUrl: () => (isReady ? uploadUrl : null),
    close: () => plugin.close(),

    async getImages() {
      if (cache.album && Date.now() - cache.at < IMAGE_LIST_TTL) return cache.album;
      try {
        const list = normalizeImages(await withTimeout(plugin.getImages(), timeout, 'getImages'), pluginLog);
        cache = { at: Date.now(), album: list };
        return list;
      } catch (e) {
        // Keep showing the last good list if the photo service has a hiccup.
        if (cache.album) {
          pluginLog.warn(`could not refresh the album (${e.message}); using the previous list`);
          cache.at = Date.now();
          return cache.album;
        }
        throw e;
      }
    },

    getImage: (id, opts) => withTimeout(plugin.getImage(id, opts), timeout, 'getImage')
  };
}
