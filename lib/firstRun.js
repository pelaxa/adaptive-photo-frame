/**
 * firstRun.js - creates the settings and style files in an empty config folder (used by the Docker image's start-up).
 *
 * The config folder is normally a folder on the host, mounted over the image's own, so it starts out empty. This puts the commented
 * examples (config.example.jsonc, custom.example.css) there and copies each to its working name (config.jsonc, custom.css), so the app
 * can start and the user has something to edit.
 * Files that already exist are NEVER overwritten (not even the examples: it would change a file the user owns behind their back).
 * shortcut: the example in the folder is not refreshed after an upgrade, the current one is always in the image (see the README).
 */
import { copyFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

/** Example files shipped in the image, and the working copies made from them. */
const FILES = [
  ['config.example.jsonc', 'config.example.jsonc'], ['config.example.jsonc', 'config.jsonc'],
  ['custom.example.css', 'custom.example.css'], ['custom.example.css', 'custom.css']
];

/**
 * Copies a file only if the destination does not exist (COPYFILE_EXCL makes that check and the copy one step, so no race).
 * @param {string} from - Source file.
 * @param {string} to - Destination file.
 * @returns {Promise<boolean>} True if it was created, false if it was already there.
 * @throws {Error} Any error other than "already exists" (for example the folder is not writable).
 */
async function copyIfMissing(from, to) {
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Makes sure the config folder holds the examples and the working files made from them.
 * @param {string} configDir - The config folder (created if missing).
 * @param {string} defaultsDir - The folder in the image that holds the examples.
 * @returns {Promise<string[]>} Names of the files that were created (empty when nothing was needed).
 * @throws {Error} If the folder cannot be written to; the message says how to fix it.
 */
export async function ensureConfigFiles(configDir, defaultsDir) {
  const created = [];
  try {
    await mkdir(configDir, { recursive: true });
    for (const [from, name] of FILES) {
      if (await copyIfMissing(join(defaultsDir, from), join(configDir, name))) created.push(name);
    }
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') {
      throw new Error(`cannot write to the config folder ${configDir} (${e.code}). Make it writable by the user the container runs as (uid 1000), or put config.jsonc in it yourself`);
    }
    throw e;
  }
  return created;
}
