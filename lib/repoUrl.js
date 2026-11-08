/**
 * repoUrl.js - turns a git remote address into a public web address for the image labels (used by docker/dockerBuild.js).
 *
 * Remotes look like git@github.com:owner/repo.git or https://user:token@github.com/owner/repo.git. The label is public, so any
 * password or token in the address must never reach it.
 */

/**
 * Converts a git remote to a plain https address without credentials or ".git".
 * @param {string} remote - Output of `git remote get-url origin` (may be empty).
 * @returns {string} For example "https://github.com/owner/repo", or '' if the remote is empty or not understood.
 */
export function publicRepoUrl(remote) {
  const text = (remote ?? '').trim();
  const ssh = text.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return `https://${url.host}${url.pathname.replace(/(?:\.git)?\/?$/, '')}`; // host only: user name, password and query are dropped
  } catch {
    return '';
  }
}
