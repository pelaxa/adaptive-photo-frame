/**
 * scripts/installPlugins.js - installs the packages every plugin needs (`npm run install-plugins`).
 *
 * Plugins in builtin-plugins/ and plugins/ run in a sandbox that cannot see the app's own node_modules, so each plugin
 * folder with a package.json keeps its own. Running `npm install` once inside each one does the
 * same job as this script, which simply does it for all of them.
 *
 * Install scripts are switched off (--ignore-scripts): a plugin's dependencies must not be able to
 * run code on the server during installation, outside the sandbox. Native modules (which need an
 * install script) cannot be loaded by a sandboxed plugin anyway.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_FOLDERS } from '../lib/plugins.js';

const baseDir = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let failed = false;

for (const group of PLUGIN_FOLDERS) {
  const root = join(baseDir, group);
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, entry.name);
    if (!entry.isDirectory() || !existsSync(join(dir, 'package.json'))) continue;
    console.log(`\n== ${group}/${entry.name}`);
    const result = spawnSync(npm, ['install', '--omit=dev', '--ignore-scripts'], { cwd: dir, stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
console.log(failed ? '\nSome plugins failed to install (see above).' : '\nPlugin packages are installed.');
process.exit(failed ? 1 : 0);
