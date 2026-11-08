/**
 * customCss.js - reads the user's optional custom.css (next to config.jsonc) for the /custom.css route.
 *
 * The page loads it after its own style.css, so the user can override styles without touching the app. The path is fixed by the
 * server (never taken from a request). A missing file is normal and simply means "no overrides".
 */
import { readFile } from 'node:fs/promises';

/**
 * Reads the custom stylesheet.
 * @param {string} file - Path of custom.css.
 * @returns {Promise<string>} The file's text, or '' if the file does not exist.
 * @throws {Error} Any other read problem (permissions, the path is a folder...), so it shows up in the log.
 */
export async function readCustomCss(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}
