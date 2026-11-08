/**
 * sequence.js - choosing photos "in order" when a plugin asks for it (getImages returns order: 'sequence').
 *
 * The plugin lists its images in the order they should be shown (the folder plugin: oldest first). The
 * wall cycles through that list as a series of passes, with two guarantees:
 *   - every image is shown once before any image is shown a second time, and
 *   - an image added to the list between passes (or in the middle of one) is shown before the cycle comes
 *     round again, wherever it falls in the order.
 * That works by always choosing among the images that have been shown the FEWEST times. Among those, the
 * next ones in list order are the candidates; a few photos of look-ahead let the wall pick frames of the
 * right shape for the space available, so the order is followed loosely, not to the exact photo.
 */

/** How many photos of look-ahead are considered when choosing the next ones. */
export const LOOK_AHEAD = 6;

/**
 * Returns a copy of an array in random order (Fisher-Yates).
 * @template T
 * @param {T[]} list - Items to shuffle; not modified.
 * @param {() => number} [random=Math.random] - Random number source in [0, 1); a parameter so tests can control it.
 * @returns {T[]} New array with the same items in random order.
 */
export function shuffle(list, random = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Chooses the next photos in the sequence.
 * @param {{id: string}[]} images - All images, in the order the plugin wants them shown.
 * @param {Map<string, number>} shownCount - How many times each image id has been shown (missing = never).
 * @param {Set<string>} unavailable - Ids that cannot be chosen now (on screen, or already chosen for a column).
 * @param {number} want - How many photos are wanted.
 * @param {number} [lookAhead=LOOK_AHEAD] - How many of the next photos to choose among.
 * @returns {{id: string}[]} Up to `want` photos (fewer only if too few are available). Photos that have been shown
 *   the fewest times come first; a photo with a higher count is only chosen when none with a lower count is left.
 */
export function pickInSequence(images, shownCount, unavailable, want, lookAhead = LOOK_AHEAD) {
  /**
   * How many times a photo has been shown.
   * @param {{id: string}} p - The photo.
   * @returns {number}
   */
  const count = p => shownCount.get(p.id) ?? 0;
  const free = images.filter(p => !unavailable.has(p.id));
  if (!free.length) return [];
  const lowest = free.reduce((least, p) => Math.min(least, count(p)), Infinity); // (not Math.min(...), which fails on huge albums)
  const next = free.filter(p => count(p) === lowest);
  if (next.length <= want) {
    // Everything left in this round is wanted: take it all, then start on the next round (stable sort keeps list order).
    const later = free.filter(p => count(p) !== lowest).sort((a, b) => count(a) - count(b));
    return [...next, ...later].slice(0, want);
  }
  return shuffle(next.slice(0, Math.max(lookAhead, want))).slice(0, want);
}

/**
 * Makes sure every image has a shown-count, giving images the wall has not seen before the count of the
 * round in progress (the lowest count among the images already known). That way an image added later
 * is shown once before the round ends and the cycle comes round, instead of being shown over and over
 * to catch up on rounds it was not part of.
 * @param {{id: string}[]} images - All images now in the list.
 * @param {Map<string, number>} shownCount - The counts so far; updated in place.
 * @returns {void}
 */
export function registerNewImages(images, shownCount) {
  const known = images.filter(p => shownCount.has(p.id)).map(p => shownCount.get(p.id));
  const round = known.length ? Math.min(...known) : 0;
  for (const p of images) if (!shownCount.has(p.id)) shownCount.set(p.id, round);
}
