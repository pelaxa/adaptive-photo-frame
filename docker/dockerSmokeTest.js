/**
 * docker/dockerSmokeTest.js - starts the Docker image the way it is meant to be deployed and checks it (`npm run docker:test`).
 *
 *   npm run docker:test                   tests adaptive-photo-frame:latest
 *   npm run docker:test -- some/image:tag tests another image (the CI workflow does this)
 *
 * It uses the hardened settings from docker/docker-compose.yml (read-only root filesystem, all capabilities dropped, no-new-privileges, mounted
 * config, plugins and cache) and a few generated photos in the folder plugin. Checks, in order:
 *   - the image is configured to run as a non-root user, and the process really is not root
 *   - the image has a shell and npm; the first run fills an empty config folder (settings and styles) and a restart leaves the files alone; custom.css is served
 *   - the app starts, reports ready, and lists and serves photos; the page loads
 *   - the health check passes, and the version, revision, creation time and source labels are there
 *   - the console shows the app's log lines, and no log file (or any other file) appeared in the container
 *   - `docker stop` is quick and exits cleanly (the app handles SIGTERM)
 * Everything it creates (container, volumes, temporary folder) is removed afterwards. Exits 1 if any check fails.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

/** Width and height of each generated test photo: a landscape, a portrait, a wide one and a panorama. */
const PHOTO_SHAPES = [[1600, 1067], [1067, 1600], [1600, 900], [3000, 700]];
/** Permission bits that let the container's user (not the same user as on the host) write into the temporary folders. */
const WORLD_WRITABLE = 0o777;
/** How many times, and how far apart (milliseconds), to look for the files the first run should create. */
const FIRST_RUN_TRIES = 30;
const FIRST_RUN_POLL_MS = 500;
/** Seconds `docker restart` waits for a clean stop, and how long (milliseconds) to let the app come back before looking at its files. */
const RESTART_GRACE_SECONDS = 3;
const RESTART_SETTLE_MS = 3000;
/** How many times, and how far apart (milliseconds), to ask whether the app is ready, and how long (milliseconds) one question may take. */
const READY_TRIES = 60;
const READY_POLL_MS = 1000;
const READY_REQUEST_MS = 2000;
/** `docker stop` must finish within this many milliseconds (the app handles SIGTERM at once). */
const STOP_LIMIT_MS = 3000;
/** How many characters of a long value are shown when a check fails. */
const DETAIL_CHARS = 200;

const image = process.argv[2] ?? 'adaptive-photo-frame:latest';
const name = `apf-smoke-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), 'apf-smoke-'));
let failures = 0;

/**
 * Runs a docker command and returns its result.
 * @param {string[]} args - Arguments for the docker command line.
 * @returns {{ok: boolean, out: string, err: string}} ok is true if the command exited with 0.
 */
function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/**
 * Prints one check result and counts failures.
 * @param {boolean} passed - Whether the check passed.
 * @param {string} what - What was checked.
 * @param {string} [detail] - Extra information, shown when the check fails.
 * @returns {void}
 */
function check(passed, what, detail = '') {
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${what}${!passed && detail ? `\n        ${detail}` : ''}`);
  if (!passed) failures++;
}

/** Removes everything this script created. */
function cleanup() {
  docker(['rm', '-f', name]);
  docker(['volume', 'rm', '-f', `${name}-cache`]);
  rmSync(work, { recursive: true, force: true });
}

try {
  console.log(`Testing ${image}\n`);

  // 1. Who the image is set up to run as, and what it contains.
  const user = docker(['image', 'inspect', image, '--format', '{{.Config.User}}']);
  check(user.ok && /^[1-9]\d*(:\d+)?$/.test(user.out), 'the image is set to run as a numeric non-root user', `Config.User is "${user.out}"`);
  const uid = docker(['run', '--rm', '--entrypoint', 'node', image, '-e', 'process.exit(process.getuid() === 0 ? 1 : 0)']);
  check(uid.ok, 'the process does not run as root');
  const npm = docker(['run', '--rm', '--entrypoint', 'sh', image, '-c', 'npm --version']);
  check(npm.ok, 'the image has a shell and npm (users add plugins with them)', npm.err);

  // 2. Start it as it would be deployed: photos and config mounted, hardened settings.
  mkdirSync(join(work, 'photos'));
  for (const [i, [width, height]] of PHOTO_SHAPES.entries()) {
    const file = join(work, 'photos', `p${i}.jpg`);
    await sharp({ create: { width, height, channels: 3, background: { r: 60 + i * 40, g: 100, b: 170 } } }).jpeg().toFile(file);
  }
  mkdirSync(join(work, 'config'));
  mkdirSync(join(work, 'plugins'));
  // Docker bind mounts keep the host's owner, and the app runs as uid 1000: make the (temporary) folders writable for it.
  for (const dir of ['config', 'plugins', 'photos']) chmodSync(join(work, dir), WORLD_WRITABLE);
  const run = docker(['run', '-d', '--name', name, '-p', '127.0.0.1::3000',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp',
    '-v', `${name}-cache:/app/.cache`, '-v', `${join(work, 'config')}:/app/config`, '-v', `${join(work, 'plugins')}:/app/plugins`,
    '-v', `${join(work, 'photos')}:/app/builtin-plugins/folder/photos:ro`, image]);
  check(run.ok, 'the container starts with a read-only root, no capabilities and no-new-privileges', run.err);
  if (!run.ok) throw new Error('cannot continue without a running container');

  // First run: the empty config folder was filled. Then the user's own settings replace config.jsonc and a restart must keep them.
  for (let i = 0; i < FIRST_RUN_TRIES && !existsSync(join(work, 'config', 'config.jsonc')); i++) await new Promise(resolve => setTimeout(resolve, FIRST_RUN_POLL_MS));
  check(['config.example.jsonc', 'config.jsonc', 'custom.example.css', 'custom.css'].every(f => existsSync(join(work, 'config', f))), 'the first run creates the example and working config and style files in the empty config folder');
  const mine = '{ "plugins": [ { "id": "folder", "settings": { "minAgeSeconds": 0 } } ] }\n';
  // The container (uid 1000) owns the created file; on Linux hosts (CI runs as another uid) it cannot be overwritten, but the world-writable folder lets it be replaced.
  rmSync(join(work, 'config', 'config.jsonc'));
  writeFileSync(join(work, 'config', 'config.jsonc'), mine);
  check(docker(['restart', '-t', String(RESTART_GRACE_SECONDS), name]).ok, 'the container restarts');
  await new Promise(resolve => setTimeout(resolve, RESTART_SETTLE_MS));
  check(readFileSync(join(work, 'config', 'config.jsonc'), 'utf8') === mine, 'a restart does not overwrite an existing config.jsonc');

  const port = docker(['port', name, '3000/tcp']).out.split(':').pop();
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < READY_TRIES && !ready; i++) {
    ready = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(READY_REQUEST_MS) }).then(r => r.json()).then(c => c.ready === true, () => false);
    if (!ready) await new Promise(resolve => setTimeout(resolve, READY_POLL_MS));
  }
  check(ready, 'the app starts and reports its photo source ready', docker(['logs', '--tail', '15', name]).out);

  // 3. It does its job.
  const list = ready ? await fetch(`${base}/api/images`).then(r => r.json()) : { images: [] };
  check(list.images.length === PHOTO_SHAPES.length && list.order === 'sequence', `the folder plugin lists the ${PHOTO_SHAPES.length} photos (in sequence order)`, JSON.stringify(list).slice(0, DETAIL_CHARS));
  const photo = list.images[0] ? await fetch(`${base}/api/image/${encodeURIComponent(list.images[0].id)}`) : null;
  check(photo?.status === 200 && photo.headers.get('content-type') === 'image/jpeg', 'a photo is served, checked and resized');
  check((await fetch(`${base}/`).catch(() => null))?.status === 200, 'the page loads');
  rmSync(join(work, 'config', 'custom.css')); // container-owned, same as config.jsonc above
  writeFileSync(join(work, 'config', 'custom.css'),'.frame { border-color: transparent; }');
  const css = await fetch(`${base}/custom.css`).catch(() => null);
  check(css?.status === 200 && css.headers.get('content-type') === 'text/css' && (await css.text()).includes('transparent'), 'custom.css from the config folder is served (and picked up without a restart)');
  const health = docker(['exec', name, 'node', '/app/docker/healthcheck.js']);
  check(health.ok, 'the health check passes');
  const declared = docker(['image', 'inspect', image, '--format', '{{json .Config.Healthcheck.Test}}']);
  check(declared.out.includes('healthcheck.js'), 'the image declares that health check');
  // Labels: version, revision and creation time always; the repository address only has to be there in CI (a local clone may have no remote yet).
  const labels = JSON.parse(docker(['image', 'inspect', image, '--format', '{{json .Config.Labels}}']).out || '{}');
  /**
   * One standard image label, or '' when the image has none.
   * @param {string} key - The label name after `org.opencontainers.image.`, for example 'source'.
   * @returns {string}
   */
  const label = key => labels[`org.opencontainers.image.${key}`] ?? '';
  /**
   * Whether a text is a plain http(s) web address.
   * @param {string} text - The text to check.
   * @returns {boolean}
   */
  const isUrl = text => /^https?:\/\/\S+$/.test(text);
  check(label('version') !== '' && label('revision') !== '' && !Number.isNaN(Date.parse(label('created'))), 'the image labels carry the version, revision and creation time', JSON.stringify(labels));
  check(process.env.CI ? isUrl(label('source')) && isUrl(label('url')) : [label('source'), label('url')].every(v => v === '' || isUrl(v)), 'the source and url labels are web addresses', `source="${label('source')}" url="${label('url')}"`);

  // 4. Logging goes to the console, and nothing is written to a file in the container.
  const logs = docker(['logs', name]);
  check(/ready/.test(logs.out + logs.err), 'the app\'s log lines are on the console (docker logs)');
  const changed = docker(['diff', name]).out.split('\n').filter(Boolean);
  const outsideMounts = changed.filter(line => !/^[CA] \/(app|app\/\.cache.*|app\/config.*|app\/plugins.*|app\/builtin-plugins.*|tmp.*)$/.test(line));
  check(!changed.some(line => /\.log\b|\/logs?(\/|$)/i.test(line)), 'no log file was written in the container');
  check(outsideMounts.length === 0, 'nothing changed in the container outside its mounts', outsideMounts.slice(0, 5).join('\n        '));

  // 5. Clean shutdown.
  const started = Date.now();
  docker(['stop', name]);
  const took = Date.now() - started;
  const exitCode = docker(['inspect', name, '--format', '{{.State.ExitCode}}']).out;
  check(took < STOP_LIMIT_MS && exitCode === '0', 'docker stop is quick and exits cleanly', `took ${took} ms, exit code ${exitCode}`);
} catch (e) {
  check(false, 'the test ran to the end', e.message);
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
