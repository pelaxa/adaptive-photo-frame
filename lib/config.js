/**
 * config.js - loads and validates config.jsonc, the app's only configuration file.
 *
 * config.jsonc is JSON with comments (JSONC). It has:
 *   server   - network address/port, plugin timeout, start-up retry, log level
 *   display  - what the wall looks like (timings, photo counts, animations)
 *   qr       - the QR code's appearance (it only appears if the active plugin offers an upload address)
 *   plugins  - a list of photo sources; the FIRST entry with "enabled": true is the one used
 * Plugin-specific settings live inside each plugin entry and are validated later by the
 * plugin loader, because only the loaded plugin knows what they should be.
 * An entry may also carry `allowedPostHosts`: the only hosts its plugin's `fetch` may send non-GET requests to (default none).
 * It is the user's list, not the plugin's: a plugin cannot grant itself POST access.
 */
import { readFile } from 'node:fs/promises';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { readSettings } from './settings.js';
import { LEVELS } from './logger.js';

/** What a host name in `allowedPostHosts` may look like: just the name (no scheme, port or path), as `new URL(...).hostname` reports it. */
const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** Error thrown for any problem with config.jsonc; the message is meant to be shown to the user. */
export class ConfigError extends Error {}

/** @type {import('./settings.js').SettingSpec[]} */
export const SERVER_SPECS = [
  { key: 'host', type: 'string', default: '0.0.0.0', description: 'Network address to listen on (127.0.0.1 = this computer only)' },
  { key: 'port', type: 'number', default: 3000, min: 1, max: 65535, integer: true, description: 'Port the page is served on' },
  { key: 'pluginTimeoutSeconds', type: 'number', default: 15, min: 1, max: 300, description: 'Longest any plugin call may take' },
  { key: 'startupRetrySeconds', type: 'number', default: 10, min: 1, max: 3600, description: 'Delay between attempts to start a plugin that failed' },
  { key: 'logLevel', type: 'enum', values: LEVELS, default: 'info', description: 'How much is logged: error, warn, info or debug' }
];

/** @type {import('./settings.js').SettingSpec[]} */
export const DISPLAY_SPECS = [
  { key: 'tileSeconds', type: 'number', default: 5, min: 1, max: 3600, description: 'Seconds between photo changes' },
  { key: 'refreshSeconds', type: 'number', default: 60, min: 5, max: 86400, description: 'Seconds between re-reading the photo source' },
  { key: 'minPhotos', type: 'number', default: 8, min: 1, max: 40, integer: true, description: 'Fewest photos on screen' },
  { key: 'maxPhotos', type: 'number', default: 12, min: 2, max: 40, integer: true, description: 'Most photos on screen' },
  { key: 'panoramaChance', type: 'number', default: 0.2, min: 0, max: 1, description: 'Chance a row change shows a panorama across a whole row' },
  { key: 'stackChance', type: 'number', default: 0.3, min: 0, max: 1, description: 'Chance a new frame is a stack of two small photos' },
  { key: 'hardware', type: 'enum', values: ['low-power', 'standard', 'high-power'], default: 'standard', description: 'high-power = every animation, standard = slides only, low-power = no animation at all' },
  { key: 'animationSeconds', type: 'number', default: 1, min: 0.2, max: 5, description: 'Length of each animation' },
  { key: 'burnInProtection', type: 'boolean', default: false, description: 'For OLED screens: every hour, move the clock and the QR code to other corners (never the same corner at once)' },
  { key: 'accordionStrips', type: 'number', default: 4, min: 2, max: 8, integer: true, description: 'Folds in an accordion animation' },
  { key: 'caption', type: 'string', default: '', description: 'One line of text on each photo, built from the photo\'s details: tokens {date}, {year}, {city}, {state}, {country}; e.g. "{city}, {year}" (empty = no caption). A token the photo source does not provide is skipped' }
];

/** @type {import('./settings.js').SettingSpec[]} */
export const QR_SPECS = [
  { key: 'enabled', type: 'boolean', default: true, description: 'Show the QR code (needs a plugin that provides an upload address)' },
  { key: 'position', type: 'enum', values: ['bottom-left', 'bottom-right', 'top-left', 'top-right'], default: 'bottom-left', description: 'Corner for the QR code' },
  { key: 'text', type: 'string', default: 'Scan to upload', description: 'Caption above the QR code (empty = none)' }
];

/** Former QR settings that are now styles in custom.css; an old config that still has them gets a warning, not an error. */
const MOVED_QR_KEYS = ['color', 'background'];

/** @type {import('./settings.js').SettingSpec[]} */
export const CLOCK_SPECS = [
  { key: 'enabled', type: 'boolean', default: true, description: 'Show the clock' },
  { key: 'position', type: 'enum', values: ['bottom-left', 'bottom-right', 'top-left', 'top-right'], default: 'top-left', description: 'Corner for the clock' },
  { key: 'showDate', type: 'boolean', default: true, description: 'Show the date' },
  { key: 'showTime', type: 'boolean', default: true, description: 'Show the time' },
  { key: 'dateFormat', type: 'enum', values: ['full', 'long', 'medium', 'short', 'iso'], default: 'full', description: 'full = Saturday, November 7, 2026; long = November 7, 2026; medium = Nov 7, 2026; short = 11/7/26; iso = 2026-11-07 (the order and words follow the locale, except iso)' },
  { key: 'timeFormat', type: 'enum', values: ['auto', '12h', '24h'], default: 'auto', description: 'auto = the locale\'s usual clock, 12h = 9:05 PM, 24h = 21:05' },
  { key: 'showSeconds', type: 'boolean', default: false, description: 'Include seconds in the time' },
  { key: 'locale', type: 'string', default: '', description: 'Language and region for the date and time, such as "en-US" or "de-DE" (empty = the browser\'s own)' }
];

/**
 * Checks the clock settings that need more than one setting at a time.
 * @param {Record<string, any>} clock - The validated clock settings.
 * @returns {void}
 * @throws {Error} If the clock is on but shows neither date nor time, or the locale is malformed.
 */
function checkClock(clock) {
  if (clock.enabled && !clock.showDate && !clock.showTime) {
    throw new Error('clock.showDate and clock.showTime are both false, so the clock would show nothing: set clock.enabled to false instead');
  }
  if (clock.locale) {
    try {
      new Intl.DateTimeFormat(clock.locale);
    } catch {
      throw new Error(`clock.locale "${clock.locale}" is not a valid language tag (examples: "en-US", "de-DE", "fr")`);
    }
  }
}

/**
 * @typedef {object} PluginEntry
 * @property {string} id - Which plugin to load (matches its file or folder name).
 * @property {boolean} enabled - False means it is ignored.
 * @property {Record<string, any>} settings - Raw plugin settings, validated by the plugin loader.
 * @property {string[]} allowedPostHosts - Host names the plugin may send non-GET requests to (empty = GET only).
 *
 * @typedef {object} AppConfig
 * @property {Record<string, any>} server - Validated server settings (see SERVER_SPECS).
 * @property {Record<string, any>} display - Validated display settings (see DISPLAY_SPECS).
 * @property {Record<string, any>} qr - Validated QR settings (see QR_SPECS).
 * @property {Record<string, any>} clock - Validated clock settings (see CLOCK_SPECS).
 * @property {PluginEntry} plugin - The active plugin: the first enabled entry of "plugins".
 */

/**
 * Turns a character offset in a text into a "line:column" position for error messages.
 * @param {string} text - The whole file.
 * @param {number} offset - Zero-based character offset.
 * @returns {string} Position like "12:5" (1-based).
 */
function position(text, offset) {
  const before = text.slice(0, offset).split('\n');
  return `${before.length}:${before.at(-1).length + 1}`;
}

/**
 * Parses and validates the text of a config file.
 * @param {string} text - JSONC text.
 * @param {{warn: (msg: string) => void}} log - Receives warnings (unknown keys, clamped numbers).
 * @param {string} [file='config.jsonc'] - Name used in error messages.
 * @returns {AppConfig} The validated configuration.
 * @throws {ConfigError} If the text is not valid JSONC, or a setting is wrong, or no plugin is enabled.
 */
export function parseConfig(text, log, file = 'config.jsonc') {
  const errors = [];
  const raw = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const e = errors[0];
    throw new ConfigError(`${file}:${position(text, e.offset)} ${printParseErrorCode(e.error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${file} must contain one { ... } object`);
  }

  try {
    const server = readSettings(SERVER_SPECS, raw.server, 'server', log);
    const display = readSettings(DISPLAY_SPECS, raw.display, 'display', log);
    const moved = MOVED_QR_KEYS.filter(key => raw.qr && typeof raw.qr === 'object' && key in raw.qr);
    if (moved.length) {
      log.warn(`qr.${moved.join(' and qr.')} ${moved.length > 1 ? 'are' : 'is'} no longer a setting and ${moved.length > 1 ? 'are' : 'is'} ignored: the QR code's colours are styles now (see custom.example.css and "Custom styles" in the README)`);
      raw.qr = Object.fromEntries(Object.entries(raw.qr).filter(([key]) => !moved.includes(key)));
    }
    const qr = readSettings(QR_SPECS, raw.qr, 'qr', log);
    const clock = readSettings(CLOCK_SPECS, raw.clock, 'clock', log);
    checkClock(clock);
    display.minPhotos = Math.min(display.minPhotos, display.maxPhotos); // the minimum can never exceed the maximum

    for (const key of Object.keys(raw)) {
      if (!['server', 'display', 'qr', 'clock', 'plugins'].includes(key)) log.warn(`${key} is not a known section and is ignored (typo?)`);
    }
    return { server, display, qr, clock, plugin: pickPlugin(raw.plugins) };
  } catch (e) {
    throw new ConfigError(`${file}: ${e.message}`);
  }
}

/**
 * Finds the plugin to use: the first entry whose "enabled" is true (default true when omitted).
 * Later entries are ignored, so several set-ups can be kept in the file and switched by order.
 * @param {any} list - The raw "plugins" value.
 * @returns {PluginEntry} The active entry.
 * @throws {Error} If "plugins" is not a list, an entry is malformed, or none is enabled.
 */
function pickPlugin(list) {
  if (!Array.isArray(list)) throw new Error('"plugins" must be a list [ ... ] of plugin entries');
  list.forEach((entry, i) => {
    if (typeof entry?.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(entry.id)) {
      throw new Error(`plugins[${i}].id must be text using only letters, digits and hyphens`);
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error(`plugins[${i}].enabled must be true or false`);
    }
    // Not an option any more. Fail loudly instead of ignoring it, so nobody believes a plugin runs unsandboxed.
    if (entry.allowedPostHosts !== undefined && !(Array.isArray(entry.allowedPostHosts) && entry.allowedPostHosts.every(h => typeof h === 'string' && HOST_NAME.test(h)))) {
      throw new Error(`plugins[${i}].allowedPostHosts must be a list of host names such as ["photos.example.com"] (the name only: no https://, port or path)`);
    }
    if (entry.sandbox !== undefined) {
      throw new Error(`plugins[${i}].sandbox is not a setting: plugins in plugins/ are always sandboxed, so remove this line`);
    }
  });
  const entry = list.find(e => e.enabled !== false);
  if (!entry) throw new Error('no plugin is enabled: set "enabled": true on one entry in "plugins"');
  return { id: entry.id, enabled: true, settings: entry.settings, allowedPostHosts: (entry.allowedPostHosts ?? []).map(h => h.toLowerCase()) };
}

/**
 * Reads, parses and validates a config file from disk.
 * @param {string} path - Path to config.jsonc.
 * @param {{warn: (msg: string) => void}} log - Receives warnings.
 * @returns {Promise<AppConfig>}
 * @throws {ConfigError} For any problem, including a missing file.
 */
export async function loadConfig(path, log) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read ${path} (${e.code}). Copy config/config.example.jsonc to config/config.jsonc and edit it.`);
  }
  return parseConfig(text, log, path);
}
