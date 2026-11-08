// Run with `npm test`. Checks the layout maths that decides how photos are cropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalWidth, frameHeightPercents, placeColumns, layoutRatio, isPanorama, photoLimits, accordionStrips, STRIP_OVERLAP, rowFill, MIN_ROW_FILL } from '../public/layout.js';

/**
 * Checks two numbers are equal apart from rounding error.
 * @param {number} a - First number.
 * @param {number} b - Second number.
 * @returns {void}
 */
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test('a single photo is as wide as its ratio says', () => near(naturalWidth([1.5], 100), 150));

test('two stacked landscapes share one narrow column', () => near(naturalWidth([1.5, 1.5], 100), 75));

test('stacked frames add up to the full height and keep each photo shape', () => {
  const [top, bottom] = frameHeightPercents([2, 1]);
  near(top + bottom, 100);
  near(top, 100 / 3); // a 2:1 photo needs half the height of a 1:1 photo at equal width
});

test('columns fill the row exactly and touch each other', () => {
  const spots = placeColumns([150, 75, 75], 600);
  near(spots.at(-1).left + spots.at(-1).width, 600);
  near(spots[1].left, spots[0].width);
});

test('extreme ratios are clamped', () => near(layoutRatio(9), 2.4));

test('panoramas: wide enough to fill a row on a 16:9 screen (rows about 3.6:1), but ordinary wide photos are not', () => {
  const [w, h] = [1920, 534]; // one of two rows on a 1080p screen
  assert.equal(isPanorama(4.73, w, h), true);  // a true panorama
  assert.equal(isPanorama(3, w, h), true);     // loses under 20% top and bottom
  assert.equal(isPanorama(2.5, w, h), false);  // would lose too much top and bottom
  assert.equal(isPanorama(1.78, w, h), false); // an ordinary landscape photo
});

test('a big album keeps the configured limits', () => assert.deepEqual(photoLimits(132, 8, 12), { min: 8, max: 12 }));

test('a small album gets a lower maximum, so the same photo is never on screen twice', () => {
  assert.deepEqual(photoLimits(11, 8, 12), { min: 8, max: 9 }); // 11 images: 9 showing, 2 spare for a stacked pair
  assert.deepEqual(photoLimits(8, 8, 12), { min: 6, max: 6 });  // the minimum cannot exceed what is possible
  assert.deepEqual(photoLimits(2, 8, 12), { min: 1, max: 1 });  // never below one photo
  assert.deepEqual(photoLimits(0, 8, 12), { min: 1, max: 1 });
});

test('accordion strips are whole pixels that add up to the full length', () => {
  const strips = accordionStrips(543.7, 4);
  assert.equal(strips.length, 4);
  for (const s of strips) assert.ok(Number.isInteger(s.from) && Number.isInteger(s.span), `${JSON.stringify(s)} is not whole pixels`);
  assert.equal(strips.reduce((sum, s) => sum + s.span, 0), 544);
  assert.equal(strips[0].from, 0);
  strips.slice(1).forEach((s, i) => assert.equal(s.from, strips[i].from + strips[i].span)); // no gap between the parts of the picture
});

test('every accordion strip but the last reaches one pixel under the next', () => {
  const strips = accordionStrips(400, 4);
  strips.slice(0, -1).forEach(s => assert.equal(s.length, s.span + STRIP_OVERLAP));
  assert.equal(strips.at(-1).length, strips.at(-1).span);
  assert.equal(accordionStrips(100, 1)[0].length, 100); // a single strip has nothing to overlap
});

test('row fill: a lone pair, two pairs or one regular photo are too empty for a 16:9 row, a real mix is not', () => {
  const h = 540; // half of a 1080 screen
  const w = 1920;
  /**
   * How full a 1920-pixel-wide, 540-pixel-tall row is with these columns.
   * @param {number[][]} columns - Photo ratios of each column.
   * @returns {number}
   */
  const fill = columns => rowFill(columns.map(ratios => naturalWidth(ratios, h)), w);
  const pair = [1.5, 1.5];
  const single = [1.5];
  assert.ok(fill([pair]) < MIN_ROW_FILL);
  assert.ok(fill([pair, pair]) < MIN_ROW_FILL);
  assert.ok(fill([single]) < MIN_ROW_FILL); // a regular photo alone would be cropped like a panorama
  assert.ok(fill([single, single]) >= MIN_ROW_FILL);
  assert.ok(fill([single, pair, pair]) >= MIN_ROW_FILL);
  near(rowFill([100, 50], 200), 0.75);
});
