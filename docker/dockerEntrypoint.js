/**
 * docker/dockerEntrypoint.js - what the Docker image runs at start-up. Not used outside Docker.
 *
 * 1. First run: if the config folder (the folder of APF_CONFIG, default /app/config) lacks config.example.jsonc, config.jsonc,
 *    custom.example.css or custom.css, creates them from the examples kept in the image (lib/firstRun.js). Existing files are never overwritten.
 * 2. Starts the server with the config file at APF_CONFIG. A `--config` given on the command line wins (and skips step 1).
 * Written in Node so it needs no shell tricks; it never needs root.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../lib/logger.js';
import { ensureConfigFiles } from '../lib/firstRun.js';

const baseDir = fileURLToPath(new URL('..', import.meta.url));
const log = createLogger('info').child('docker');

if (!process.argv.includes('--config')) {
  const file = process.env.APF_CONFIG ?? join(baseDir, 'config', 'config.jsonc');
  try {
    const created = await ensureConfigFiles(dirname(file), join(baseDir, 'defaults'));
    if (created.length) log.info(`created ${created.join(' and ')} in ${dirname(file)}; edit config.jsonc to choose a plugin and set it up (custom.css holds optional style overrides)`);
  } catch (e) {
    console.error(`\nCannot start: ${e.message}\n`);
    process.exit(1);
  }
  process.argv.push('--config', file);
}
await import('../server.js');
