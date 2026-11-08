/**
 * corners.js - chooses which screen corner the clock and the QR code sit in when burn-in protection moves them (pure, no DOM, unit tested).
 *
 * Two rules: after every move each box is in a DIFFERENT corner than before (so a pixel is never lit for long by the same box), and the
 * boxes are never in the same corner at once.
 */
import { shuffle } from './sequence.js';

/** The four corners a box can sit in. */
export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/**
 * Picks new corners for the boxes that are on screen.
 * @param {Record<string, string>} current - Current corner of each visible box, keyed by name (for example { clock: 'top-left', qr: 'bottom-left' }).
 * @param {() => number} [random=Math.random] - Random number source in [0, 1); a parameter so tests can control it.
 * @returns {Record<string, string>} A corner for every key of `current`: never the key's current corner, and no two keys with the same corner.
 */
export function pickCorners(current, random = Math.random) {
  const next = {};
  const taken = new Set();
  // A random order, so the same box does not always get first pick of the corners.
  const names = shuffle(Object.keys(current), random);
  for (const name of names) {
    const options = CORNERS.filter(c => c !== current[name] && !taken.has(c));
    // With at most 4 boxes this cannot run dry for 1-2 boxes; for a crowded case fall back to any free corner.
    const pool = options.length ? options : CORNERS.filter(c => !taken.has(c));
    next[name] = pool[Math.floor(random() * pool.length)];
    taken.add(next[name]);
  }
  return next;
}
