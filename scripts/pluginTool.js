/**
 * scripts/pluginTool.js - command-line helper for plugin authors and set-up.
 *
 *   npm run check   Starts the active plugin from config.jsonc and tests the contract: init, getImages,
 *                   getImage (first photo) and getUploadUrl, printing what it found. Exits with an
 *                   error if anything is wrong. Use it while writing a plugin, without running the wall.
 *   npm run setup   Runs the plugin's optional setup(ctx) function, which may ask questions
 *                   (ctx.prompt) and print values to paste into config.jsonc.
 *
 * Both use the first enabled plugin; add `-- --config other.jsonc` to use another config file.
 */
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { createImageService } from '../lib/images.js';
import { createRuntime, PluginError } from '../lib/plugins.js';
import { SettingsError } from '../lib/settings.js';

/** Longest side (pixels) of the photo that `npm run check` asks the plugin for: the largest size the app ever uses. */
const CHECK_MAX_PIXELS = 1440;
/** Seconds the image service waits for the check's photo download. */
const CHECK_TIMEOUT_SECONDS = 15;

const baseDir = fileURLToPath(new URL('..', import.meta.url));
const command = process.argv[2];
const i = process.argv.indexOf('--config');
const file = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : join(baseDir, 'config', 'config.jsonc');

/**
 * Prints a failed check and ends the program with an error code.
 * @param {string} message - What went wrong.
 * @returns {never}
 */
function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

/**
 * Runs the contract check against the active plugin.
 * @param {import('../lib/plugins.js').Runtime} runtime - The loaded (not yet started) plugin.
 * @param {import('../lib/logger.js').Logger} log - Logger.
 * @returns {Promise<void>}
 */
async function check(runtime, log) {
  const { plugin, settings } = runtime;
  console.log(`Plugin "${plugin.name}" loaded (settings valid)`);
  await plugin.init(settings, runtime.allowedPostHosts).catch(e => fail(`init() threw: ${e.message}`));
  console.log('ok    init()');

  const album = await runtime.getImages().catch(e => fail(`getImages() threw: ${e.message}`));
  if (!album.images.length) fail('getImages() returned no images (the wall would show "No photos yet")');
  const ratios = album.images.map(p => p.ratio);
  console.log(`ok    getImages(): "${album.title}", ${album.images.length} images, ratios ${Math.min(...ratios).toFixed(2)}-${Math.max(...ratios).toFixed(2)}`);

  // The first image goes through the same service the server uses: bytes or URL, then checked, resized and cached.
  const raw = await runtime.getImage(album.images[0].id, { maxPixels: CHECK_MAX_PIXELS }).catch(e => fail(`getImage() threw: ${e.message}`));
  console.log(`ok    getImage(): returned ${raw.url ? 'a URL for the app to download' : 'the image bytes'}`);
  const service = createImageService({ getImage: async () => raw, pluginId: 'check', cacheDir: join(baseDir, '.cache', 'check'), timeoutSeconds: CHECK_TIMEOUT_SECONDS });
  const image = await service.get(album.images[0].id, CHECK_MAX_PIXELS).catch(e => fail(`the app could not use that image: ${e.message}`));
  console.log(`ok    image service: ${image.contentType}, ${image.body.length} bytes after checking and resizing`);

  console.log(`ok    getUploadUrl(): ${(await plugin.getUploadUrl()) ?? '(none - no QR code will show)'}`);
  console.log('All checks passed.');
}

try {
  const log = createLogger('info');
  const config = await loadConfig(file, log);
  // setup may ask questions; a sandboxed plugin's questions are passed through to this terminal
  const rl = command === 'setup' ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const runtime = await createRuntime({ config, log: createLogger(config.server.logLevel), baseDir, start: false, prompt: rl && (q => rl.question(q)) });
  if (command === 'check') {
    await check(runtime, log);
  } else if (command === 'setup') {
    if (!runtime.plugin.setup) {
      console.log(`Plugin "${runtime.plugin.name}" has no setup step.`);
    } else {
      await runtime.plugin.setup(runtime.allowedPostHosts);
    }
    rl.close();
  } else {
    console.log('Usage: npm run check | npm run setup');
  }
  process.exit(0);
} catch (e) {
  if (!(e instanceof ConfigError || e instanceof PluginError || e instanceof SettingsError)) throw e;
  fail(e.message);
}
