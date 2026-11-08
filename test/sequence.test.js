// Checks the "in order, round after round" photo choice: nothing repeats before everything has been shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOK_AHEAD, pickInSequence, registerNewImages } from '../public/sequence.js';

/**
 * A list of n images with ids p0, p1, ...
 * @param {number} n - How many.
 * @returns {{id: string}[]}
 */
const album = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
/**
 * The gap between the most and least shown photo.
 * @param {Map<string, number>} counts - Times each photo was shown.
 * @returns {number}
 */
const spread = counts => Math.max(...counts.values()) - Math.min(...counts.values());

/** Shows photos the way the wall does (one or two at a time, nothing on screen) and counts them. */
function show(images, counts, picks, want = () => 1) {
  const log = [];
  for (let i = 0; i < picks; i++) {
    for (const p of pickInSequence(images, counts, new Set(), want(i))) {
      counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
      log.push(p.id);
    }
  }
  return log;
}

test('photos come in the plugin\'s order, loosely: each one is within the look-ahead of the next unshown photo', () => {
  const images = album(30);
  const shown = show(images, new Map(), 12).map(id => Number(id.slice(1)));
  shown.forEach((n, k) => assert.ok(n < k + LOOK_AHEAD, `photo ${n} was shown as number ${k + 1}, too far ahead`));
});

test('every photo is shown once before any is shown twice, however many are picked at a time', () => {
  const images = album(10);
  const counts = new Map();
  for (let i = 0; i < 200; i++) {
    show(images, counts, 1, () => 1 + (i % 2)); // alternate singles and stacked pairs
    const seen = images.map(p => counts.get(p.id) ?? 0);
    assert.ok(Math.max(...seen) - Math.min(...seen) <= 1, `uneven after step ${i}: ${seen}`);
  }
});

test('photos on screen are skipped, and are shown later in the round', () => {
  const images = album(5);
  const picked = pickInSequence(images, new Map(), new Set(['p0', 'p1']), 5).map(p => p.id).sort();
  assert.deepEqual(picked, ['p2', 'p3', 'p4']);
});

test('a photo added in the middle of a round is shown before the round ends, once, not over and over', () => {
  const images = album(8);
  const counts = new Map();
  registerNewImages(images, counts);
  show(images, counts, 8 * 3 + 3);               // three whole rounds and three photos into the fourth
  const withNew = [...images, { id: 'new' }];     // lands at the END of the list, but is not made to wait for round five
  registerNewImages(withNew, counts);
  const log = show(withNew, counts, 6);           // the five photos left in round four, plus the new one
  assert.ok(log.includes('new'), 'the new photo was not shown in the round in progress');
  assert.equal(log.filter(id => id === 'new').length, 1);
  assert.equal(spread(counts), 0, 'the round should end with every photo, including the new one, shown the same number of times');
});

test('a photo that sorts BEFORE everything already shown is still shown before the loop comes round', () => {
  const counts = new Map();
  const images = album(6);
  registerNewImages(images, counts);
  show(images, counts, 6 * 2 + 2);
  const withOld = [{ id: 'oldest' }, ...images];  // dated before the rest, found only now
  registerNewImages(withOld, counts);
  const log = show(withOld, counts, 5);           // four photos left in round three, plus the new one
  assert.ok(log.includes('oldest'));
});

test('removed photos are simply never chosen; a tiny album returns what it has', () => {
  assert.deepEqual(pickInSequence(album(1), new Map(), new Set(), 2).map(p => p.id), ['p0']);
  assert.deepEqual(pickInSequence([], new Map(), new Set(), 2), []);
});
