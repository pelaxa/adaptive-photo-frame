/**
 * guardedFetch.js - the `fetch` handed to plugins.
 *
 * Plugins are meant to only READ from photo services. This wrapper makes accidents impossible:
 * it throws for anything except GET, unless the target host is in the plugin entry's `allowedPostHosts`
 * in config.jsonc (some services use POST for read-only searches). The list is the user's choice; a plugin cannot extend it.
 *
 * IMPORTANT: this is a seatbelt, not a security boundary. A plugin that uses Node's `http`
 * module, another HTTP library, or the global `fetch` directly bypasses it. See the README
 * warning about third-party plugins.
 */

/**
 * Creates the guarded fetch for one plugin.
 * @param {string[]} [allowedPostHosts=[]] - Host names (e.g. "photos.example.com", from config.jsonc) that may
 *   receive non-GET requests.
 * @param {typeof fetch} [realFetch=globalThis.fetch] - The fetch to call when a request is allowed
 *   (tests pass a fake).
 * @returns {typeof fetch} A drop-in replacement for fetch.
 */
export function createGuardedFetch(allowedPostHosts = [], realFetch = globalThis.fetch) {
  /**
   * @param {string | URL | Request} input - What to fetch.
   * @param {RequestInit} [opts] - Fetch options.
   * @returns {Promise<Response>}
   * @throws {Error} If the request is not a GET and its host is not allowed.
   */
  return (input, opts) => {
    const method = (opts?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!allowedPostHosts.includes(url.hostname)) {
        throw new Error(`Blocked ${method} request to ${url.hostname}: plugins may only read (GET) unless the host is in this plugin's allowedPostHosts in config.jsonc`);
      }
    }
    return realFetch(input, opts);
  };
}
