/**
 * sandboxChild.js - runs INSIDE the sandboxed process that hosts one plugin. Not imported by the server.
 *
 * lib/sandbox.js starts this file with Node's permission system on: the process can read only the
 * plugin's own folder (plus this file and guardedFetch.js), cannot write files, start programs,
 * start worker threads or load native addons, and starts with an empty environment. The network is
 * left open so plugins can talk to their photo service with any HTTP library.
 *
 * The only way to the rest of the server is messages to the parent process:
 *   parent -> child  { type: 'call', id, method, args }   run a plugin function
 *                    { type: 'answer', id, value }         reply to a prompt
 *   child -> parent  { type: 'result', id, ok, value | error }
 *                    { type: 'log', level, msg }           a log line from ctx.log
 *                    { type: 'prompt', id, question }      ctx.prompt() during `npm run setup`
 *
 * Command line: node sandboxChild.js <plugin file> <plugin folder (or file, for a single-file plugin)>
 */
import { pathToFileURL } from 'node:url';
import { createGuardedFetch } from './guardedFetch.js';

const [pluginFile, pluginDir] = process.argv.slice(2);

/** The plugin's default export, set by the `load` call. */
let mod;
/** What the plugin receives as its second argument (see lib/plugins.js for the contract). */
let ctx;
/** Replies the parent has not yet received answers for, keyed by prompt id. @type {Map<number, (value: string) => void>} */
const prompts = new Map();
let nextPrompt = 1;

/**
 * Builds the `ctx` object handed to the plugin: the guarded fetch, a logger that forwards each line
 * to the parent, the plugin's own folder (the one place it may read), and prompt() for the setup step.
 * @returns {{fetch: typeof fetch, log: object, pluginDir: string, prompt: (question: string) => Promise<string>}}
 */
function makeContext() {
  const log = {};
  for (const level of ['error', 'warn', 'info', 'debug']) {
    log[level] = (msg, ...extra) => process.send({ type: 'log', level, msg: [msg, ...extra].join(' ') });
  }
  return {
    fetch: createGuardedFetch(mod.allowedPostHosts ?? []),
    log,
    pluginDir,
    prompt: question => new Promise(resolve => {
      const id = nextPrompt++;
      prompts.set(id, resolve);
      process.send({ type: 'prompt', id, question });
    })
  };
}

/**
 * The calls the parent can make. Each returns a value that can be sent back as a message.
 * @type {Record<string, (...args: any[]) => Promise<any>>}
 */
const methods = {
  /** Imports the plugin and describes it (functions cannot be sent, so only data and flags go back). */
  async load() {
    mod = (await import(pathToFileURL(pluginFile).href)).default;
    /**
     * Whether the plugin module exports a function with this name.
     * @param {string} name - Contract method name such as 'init'.
     * @returns {boolean}
     */
    const has = name => typeof mod?.[name] === 'function';
    return {
      apiVersion: mod?.apiVersion, name: mod?.name, settings: mod?.settings, allowedPostHosts: mod?.allowedPostHosts,
      has: { init: has('init'), setup: has('setup'), getImages: has('getImages'), getImage: has('getImage'), getUploadUrl: has('getUploadUrl') }
    };
  },
  async init(settings) {
    ctx = makeContext();
    return mod.init(settings, ctx);
  },
  async setup() {
    ctx ??= makeContext();
    return mod.setup(ctx);
  },
  getImages: () => mod.getImages(),
  getImage: (id, opts) => mod.getImage(id, opts),
  getUploadUrl: async () => mod.getUploadUrl()
};

process.on('message', async msg => {
  if (msg.type === 'answer') {
    prompts.get(msg.id)?.(msg.value);
    prompts.delete(msg.id);
  } else if (msg.type === 'call') {
    try {
      process.send({ type: 'result', id: msg.id, ok: true, value: await methods[msg.method](...(msg.args ?? [])) });
    } catch (e) {
      process.send({ type: 'result', id: msg.id, ok: false, error: String(e?.message ?? e) });
    }
  }
});

// If the server goes away, so does the plugin process.
process.on('disconnect', () => process.exit(0));
