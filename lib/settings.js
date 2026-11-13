/**
 * settings.js - checks and cleans up settings, for both the app's own config and every plugin's.
 *
 * A plugin lists the settings it understands (name, type, default, ...). This file takes the
 * raw values from config.jsonc and returns clean, correctly-typed values, or throws an error
 * that says exactly which setting is wrong. Mistakes are caught at start-up instead of
 * causing odd behaviour later.
 */

/**
 * @typedef {object} SettingSpec
 * @property {string} key - Name in config.jsonc.
 * @property {'string'|'number'|'boolean'|'path'|'enum'|'color'|'object'|'list'} type - Expected kind of value.
 *   'path' is a non-empty string (the plugin decides how to resolve it); 'color' is a hex code
 *   such as #fff or a plain colour name; 'object' is a group of settings described by `fields`;
 *   'list' is a list of non-empty text values, such as ["a", "b"] (surrounding spaces are removed).
 * @property {string} description - What the setting does (shown in docs and error messages).
 * @property {boolean} [required] - True if there is no default and the setting must be given.
 * @property {*} [default] - Value used when the setting is missing.
 * @property {number} [min] - Smallest allowed number (smaller values are raised to it, with a warning).
 * @property {number} [max] - Largest allowed number (larger values are lowered to it, with a warning).
 * @property {boolean} [integer] - For numbers: round to a whole number.
 * @property {SettingSpec[]} [fields] - For 'object': the settings inside it. Each has its own default, so a partly
 *   filled (or missing) object still gets complete values.
 * @property {string[]} [values] - For 'enum' (and extra words allowed for 'color'): the accepted values.
 * @property {boolean} [secret] - True for keys and tokens, so they are masked in logs.
 */

/** Error thrown for a setting that is missing or the wrong kind; the message names the setting. */
export class SettingsError extends Error {}

const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+)$/i;

/**
 * Validates raw values against a list of setting specs.
 * @param {SettingSpec[]} specs - The settings that are understood.
 * @param {Record<string, any> | undefined} raw - Values from config.jsonc (a missing object counts as empty).
 * @param {string} where - Where the values came from, e.g. "display" or "plugins.immich.settings";
 *   used at the start of error messages.
 * @param {{warn: (msg: string) => void}} log - Receives warnings for unknown keys and clamped numbers.
 * @returns {Record<string, any>} Clean values, with defaults applied. Optional settings that have
 *   neither a value nor a default are left out.
 * @throws {SettingsError} If a required setting is missing, or a value has the wrong type.
 */
export function readSettings(specs, raw, where, log) {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new SettingsError(`${where} must be an object { ... }`);
  }
  raw ??= {};
  const known = new Set(specs.map(s => s.key));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) log.warn(`${where}.${key} is not a known setting and is ignored (typo?)`);
  }

  const out = {};
  for (const spec of specs) {
    const name = `${where}.${spec.key}`;
    let value = raw[spec.key];
    if (spec.type === 'object') { // validated field by field; a missing object is the same as an empty one
      out[spec.key] = readSettings(spec.fields, value, name, log);
      continue;
    }
    if (value === undefined) {
      if (spec.required) throw new SettingsError(`${name} is required: ${spec.description}`);
      if (spec.default !== undefined) out[spec.key] = spec.default;
      continue;
    }
    out[spec.key] = checkValue(spec, value, name, log);
  }
  return out;
}

/**
 * Checks one value against its spec.
 * @param {SettingSpec} spec - The setting's description.
 * @param {*} value - The raw value (never undefined).
 * @param {string} name - Full setting name for messages.
 * @param {{warn: (msg: string) => void}} log - Receives clamping warnings.
 * @returns {*} The cleaned value.
 * @throws {SettingsError} If the value has the wrong type or is not an accepted choice.
 */
function checkValue(spec, value, name, log) {
  /**
   * Rejects the value with a message that names the setting and what was expected.
   * @param {string} expected - What a valid value looks like, for example 'a number'.
   * @returns {never}
   */
  const fail = expected => {
    throw new SettingsError(`${name} must be ${expected}, got ${JSON.stringify(value)}`);
  };
  switch (spec.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('a number');
      let n = spec.integer ? Math.round(value) : value;
      const clamped = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n));
      if (clamped !== n) log.warn(`${name} = ${n} is outside ${spec.min}-${spec.max}; using ${clamped}`);
      return clamped;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : fail('true or false');
    case 'enum':
      return spec.values.includes(value) ? value : fail(`one of ${spec.values.join(', ')}`);
    case 'color':
      if (spec.values?.includes(value)) return value;
      return typeof value === 'string' && COLOR.test(value.trim()) ? value.trim()
        : fail(`a colour such as #ffffff or white${spec.values ? ` (or ${spec.values.join(', ')})` : ''}`);
    case 'list':
      return Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim()) ? value.map(v => v.trim()) : fail('a list of non-empty text values, such as ["a", "b"]');
    case 'path':
      return typeof value === 'string' && value.trim() ? value : fail('a non-empty text value');
    default:
      return typeof value === 'string' ? value : fail('text');
  }
}

/**
 * Copy of settings that is safe to log: values of 'secret' settings are replaced by "****".
 * @param {SettingSpec[]} specs - The setting specs (to know which are secret).
 * @param {Record<string, any>} values - Clean values from readSettings.
 * @returns {Record<string, any>} Same keys, secrets masked.
 */
export function maskSecrets(specs, values) {
  const secret = new Set(specs.filter(s => s.secret).map(s => s.key));
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, secret.has(k) ? '****' : v]));
}
