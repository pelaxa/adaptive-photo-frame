/**
 * logger.js - the app's logger.
 *
 * One logger is created at start-up with the level from config.jsonc (server.logLevel).
 * Plugins receive a child logger whose lines are prefixed with the plugin's name, so it is
 * always clear who wrote a line:  2026-01-01T12:00:00.000Z INFO  [Immich] connected
 */

/** Severity order; a logger prints its own level and everything more severe. */
export const LEVELS = ['error', 'warn', 'info', 'debug'];

/**
 * @typedef {object} Logger
 * @property {(msg: string, ...extra: any[]) => void} error - Something failed.
 * @property {(msg: string, ...extra: any[]) => void} warn - Something is wrong but we carry on.
 * @property {(msg: string, ...extra: any[]) => void} info - Normal progress messages.
 * @property {(msg: string, ...extra: any[]) => void} debug - Detail for troubleshooting.
 * @property {(prefix: string) => Logger} child - Same level, with `[prefix]` added to every line.
 */

/**
 * Creates a logger.
 * @param {string} [level='info'] - One of LEVELS; anything less severe is not printed.
 * @param {string} [prefix=''] - Text shown in square brackets after the level, e.g. a plugin name.
 * @param {(line: string, level: string) => void} [write] - Where lines go; defaults to the console
 *   (errors and warnings to stderr). Tests pass their own.
 * @returns {Logger}
 */
export function createLogger(level = 'info', prefix = '', write = defaultWrite) {
  const limit = LEVELS.indexOf(level) === -1 ? LEVELS.indexOf('info') : LEVELS.indexOf(level);
  const logger = { child: name => createLogger(level, name, write) };
  LEVELS.forEach((name, severity) => {
    logger[name] = (msg, ...extra) => {
      if (severity > limit) return;
      const tag = prefix ? ` [${prefix}]` : '';
      write(`${new Date().toISOString()} ${name.toUpperCase().padEnd(5)}${tag} ${[msg, ...extra].join(' ')}`, name);
    };
  });
  return logger;
}

/**
 * Prints one log line to the console.
 * @param {string} line - The finished line.
 * @param {string} level - Its level; error and warn go to stderr.
 * @returns {void}
 */
function defaultWrite(line, level) {
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}
