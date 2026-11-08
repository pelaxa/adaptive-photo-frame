/**
 * docker/healthcheck.js - used by the Docker HEALTHCHECK (and handy by hand): exits 0 if the server answers and its photo source is
 * ready, 1 otherwise. It reads the port from the same config file the server uses: APF_CONFIG, or `--config <file>`, or ./config/config.jsonc.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.js';

const baseDir = fileURLToPath(new URL('..', import.meta.url));
const flag = process.argv.indexOf('--config');
const file = flag > 0 ? process.argv[flag + 1] : process.env.APF_CONFIG ?? join(baseDir, 'config', 'config.jsonc');

try {
  const { server } = await loadConfig(file, { warn() {} });
  const host = server.host === '0.0.0.0' || server.host === '::' ? '127.0.0.1' : server.host;
  const response = await fetch(`http://${host}:${server.port}/api/config`, { signal: AbortSignal.timeout(4000) });
  const ready = response.ok && (await response.json()).ready === true;
  process.exit(ready ? 0 : 1);
} catch {
  process.exit(1);
}
