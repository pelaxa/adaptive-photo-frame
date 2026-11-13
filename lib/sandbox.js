/**
 * sandbox.js - runs a plugin in its own, restricted Node process (file-access sandbox).
 *
 * Plugins from plugins/ run this way. The process is started with Node's permission system, so it can
 * read ONLY the plugin's own folder: it cannot read config.jsonc, the app's node_modules or any
 * other file, cannot write files, run programs, start workers or load native addons, and it starts
 * with an empty environment. The network stays open (plugins talk to their photo service
 * directly), so the sandbox does NOT stop a plugin from sending its own data over the network or
 * from making non-GET requests; the read-only `fetch` is advice there, not a rule.
 * Because the process cannot see the app's node_modules, a plugin must bring its own.
 *
 * The plugin's functions are called through messages (see sandboxChild.js). This file makes the
 * plugin look like an ordinary module object, so the rest of the server treats it like any other.
 * If the plugin process dies or hangs, it is killed and a new one is started on the next call.
 */
import { fork, spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./sandboxChild.js', import.meta.url));
const GUARDED_FETCH = fileURLToPath(new URL('./guardedFetch.js', import.meta.url));

/**
 * Whether this Node can run a process with the permission system and network access enabled.
 * @returns {boolean} False on older Node versions, which lack these flags.
 */
export function sandboxSupported() {
  const probe = spawnSync(process.execPath, ['--permission', '--allow-net', '-e', '0'], { env: {}, stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Starts a plugin in a sandboxed process and returns a module-like object for it.
 * @param {object} options
 * @param {string} options.file - The plugin's entry file.
 * @param {string} options.readable - The only path the plugin may read: its folder, or its file if it is a single file.
 * @param {import('./logger.js').Logger} options.log - Receives the plugin's log lines (already prefixed by its caller).
 * @param {number} options.timeoutSeconds - A call that takes longer is failed and the process is killed.
 * @param {(question: string) => Promise<string>} [options.prompt] - Answers ctx.prompt() during setup.
 * @returns {Promise<object & {onExit: (cb: () => void) => void, close: () => void}>} A module-like object: the plugin's
 *   data (apiVersion, name, settings, and allowedPostHosts if the plugin still declares one) plus functions that call into the process. `onExit(cb)` registers a
 *   callback for when the process stops unexpectedly; `close()` stops it for good.
 */
export async function loadSandboxed({ file, readable, log, timeoutSeconds, prompt }) {
  // Node's permission checks compare real paths, and the loader resolves the plugin to its real path,
  // so the allow-list must use real paths too (the OS may reach a folder through a link such as /var -> /private/var).
  [file, readable] = await Promise.all([realpath(file), realpath(readable)]);
  const [childEntry, guardedFetch] = await Promise.all([realpath(CHILD), realpath(GUARDED_FETCH)]);
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let nextId = 1;
  let closed = false;
  /** Calls waiting for an answer, keyed by id. @type {Map<number, {resolve: Function, reject: Function}>} */
  const pending = new Map();
  /** @type {(() => void)[]} */
  const exitCallbacks = [];
  let description = null;

  /**
   * Starts the process and loads the plugin in it.
   * @returns {Promise<void>}
   */
  async function spawn() {
    const proc = fork(childEntry, [file, readable], {
      execArgv: ['--permission', '--allow-net', '--disable-warning=ExperimentalWarning', `--allow-fs-read=${readable}`, `--allow-fs-read=${childEntry}`, `--allow-fs-read=${guardedFetch}`],
      env: {},
      serialization: 'advanced', // lets image bytes (Buffer) travel in messages
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    child = proc;
    proc.on('message', msg => {
      if (msg.type === 'result') {
        const call = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) call?.resolve(msg.value);
        else call?.reject(new Error(msg.error));
      } else if (msg.type === 'log') {
        log[msg.level]?.(msg.msg);
      } else if (msg.type === 'prompt') {
        Promise.resolve(prompt?.(msg.question) ?? '').then(value => proc.send({ type: 'answer', id: msg.id, value }));
      }
    });
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null;
      for (const call of pending.values()) call.reject(new Error(`plugin process stopped (${signal ?? `exit code ${code}`})`));
      pending.clear();
      if (!closed) exitCallbacks.forEach(cb => cb());
    });
    description = await rpc('load', []);
  }

  /**
   * Sends one call to the current process and waits for the answer, with a time limit.
   * @param {string} method - A name from sandboxChild.js `methods`.
   * @param {any[]} args - Arguments (must be sendable in a message).
   * @returns {Promise<any>} The result.
   */
  function rpc(method, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutSeconds}s (plugin process killed)`));
        child?.kill('SIGKILL'); // a hung plugin is stopped, not left running
      }, timeoutSeconds * 1000);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.send({ type: 'call', id, method, args });
    });
  }

  /** The start-up in progress, so calls made at the same time share one new process. @type {Promise<void> | null} */
  let starting = null;

  /**
   * Calls a plugin function, starting a fresh process first if there is none.
   * @param {string} method - Plugin function name.
   * @param {any[]} args - Its arguments.
   * @returns {Promise<any>}
   */
  async function call(method, args) {
    if (closed) throw new Error('plugin process was closed');
    if (!child?.connected) {
      starting ??= spawn().finally(() => { starting = null; });
      await starting;
    }
    return rpc(method, args);
  }

  try {
    await spawn();
  } catch (e) {
    closed = true; // the plugin could not even load: do not leave its process running
    child?.kill();
    throw e;
  }
  const has = description.has;
  return {
    apiVersion: description.apiVersion,
    name: description.name,
    settings: description.settings,
    allowedPostHosts: description.allowedPostHosts,
    init: has.init ? (settings, allowedPostHosts) => call('init', [settings, allowedPostHosts]) : undefined,
    setup: has.setup ? allowedPostHosts => call('setup', [allowedPostHosts]) : undefined,
    getImages: has.getImages ? () => call('getImages', []) : undefined,
    getImage: has.getImage ? async (id, opts) => {
      const result = await call('getImage', [id, opts]);
      // Messages deliver bytes as a plain Uint8Array; the server works with Buffers. (A { url } answer has no bytes.)
      const b = result?.body;
      return b && !Buffer.isBuffer(b) ? { ...result, body: Buffer.from(b.buffer, b.byteOffset, b.byteLength) } : result;
    } : undefined,
    getUploadUrl: has.getUploadUrl ? () => call('getUploadUrl', []) : undefined,
    onExit: cb => exitCallbacks.push(cb),
    close: () => { closed = true; child?.kill(); }
  };
}
