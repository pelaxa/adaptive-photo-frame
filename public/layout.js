/**
 * layout.js - pure layout maths for the photo rows (no DOM, so it can be unit tested).
 *
 * Vocabulary:
 *  - A "row" is a horizontal strip that fills half of the screen height.
 *  - A "column" sits in a row and is either ONE photo at full row height (a large
 *    frame) or TWO photos stacked on top of each other (two small frames).
 *  - A column's "natural width" is the width at which every photo in it fits its
 *    frame exactly, i.e. with zero cropping. A row is filled with columns and the
 *    leftover (or overflow) is shared out evenly, which only crops a few percent.
 */

/** Panoramas and very tall photos are laid out as if they were this extreme at most. */
export const MIN_RATIO = 0.5;
export const MAX_RATIO = 2.4;

/**
 * An ordinary (non-panorama) row must have columns whose natural widths add up to at least this fraction of the row's width.
 * The columns are stretched evenly to fill the row, so a row with too little in it would crop every photo heavily: a lone stacked
 * pair, two pairs, or one regular photo alone would be shown as if they were panoramas. Only a real panorama may fill a row by itself.
 * At 0.75 the stretch is at most a third wider than natural. (On a 16:9 screen a pair is about 0.21 of a row, a landscape photo
 * about 0.42, two landscapes 0.84.) shortcut: a fixed fraction for every screen shape, tune it here if rows look too empty or too strict.
 */
export const MIN_ROW_FILL = 0.75;

/** A photo counts as a panorama when it is at least this fraction as wide (as a shape) as the row it would fill. */
export const PANORAMA_FILL = 0.8;

/** Pixels each accordion strip reaches into the next one, so no hairline gap can open between two strips. */
export const STRIP_OVERLAP = 1;

/**
 * Limits an aspect ratio so one odd photo cannot create an absurdly wide or thin column.
 * @param {number} ratio - Photo width divided by height (1.5 = landscape, 0.67 = portrait).
 * @returns {number} The ratio clamped to [MIN_RATIO, MAX_RATIO].
 */
export function layoutRatio(ratio) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/**
 * Width a column needs so that its photos fit their frames without cropping.
 * One photo: height * ratio. Two stacked photos share one width, and the two frame
 * heights must add up to the row height, which gives height / (1/r1 + 1/r2).
 * @param {number[]} ratios - Aspect ratio of each photo in the column (1 or 2 entries).
 * @param {number} rowHeight - Height of the row in pixels.
 * @returns {number} The natural width of the column in pixels.
 */
export function naturalWidth(ratios, rowHeight) {
  return rowHeight / ratios.reduce((sum, r) => sum + 1 / layoutRatio(r), 0);
}

/**
 * How much of a column's height each stacked frame gets (matches each photo's shape).
 * @param {number[]} ratios - Aspect ratio of each photo in the column, top to bottom.
 * @returns {number[]} Height of each frame as a percentage of the column height (sums to 100).
 */
export function frameHeightPercents(ratios) {
  const inverse = ratios.map(r => 1 / layoutRatio(r));
  const total = inverse.reduce((a, b) => a + b, 0);
  return inverse.map(i => (i / total) * 100);
}

/**
 * Positions columns side by side and stretches them evenly so they fill the row exactly.
 * @param {number[]} naturalWidths - Natural width of each column, in visual left-to-right order.
 * @param {number} rowWidth - Width of the row in pixels.
 * @returns {{left: number, width: number}[]} Pixel position and width of each column.
 */
export function placeColumns(naturalWidths, rowWidth) {
  const scale = rowWidth / naturalWidths.reduce((a, b) => a + b, 0);
  let left = 0;
  return naturalWidths.map(w => {
    const spot = { left, width: w * scale };
    left += spot.width;
    return spot;
  });
}

/**
 * How much of a row's width a set of columns fills at their natural (uncropped) widths.
 * @param {number[]} naturalWidths - Natural width of each column, in pixels.
 * @param {number} rowWidth - Width of the row, in pixels.
 * @returns {number} 1 means the columns fit exactly; below 1 they must be stretched, above 1 squeezed.
 */
export function rowFill(naturalWidths, rowWidth) {
  return naturalWidths.reduce((a, b) => a + b, 0) / rowWidth;
}

/**
 * Whether a photo is wide enough to be shown filling a whole row. It then shows the centre of the photo,
 * cropped to the row's shape: at most 20% is cut off the top and bottom for a photo only just wide enough,
 * and a wider one loses its sides instead (a 4.7:1 photo on a 16:9 screen, where a row is about 3.6:1,
 * loses about a quarter of its width).
 * @param {number} ratio - Photo width divided by height.
 * @param {number} rowWidth - Width of a row in pixels.
 * @param {number} rowHeight - Height of a row in pixels.
 * @returns {boolean} True if the photo may fill a whole row.
 */
export function isPanorama(ratio, rowWidth, rowHeight) {
  return ratio >= PANORAMA_FILL * (rowWidth / rowHeight);
}

/**
 * How many photos the wall may show, given how many different images the album has. A replacement is
 * chosen while the old photos are still on screen, and may be a stacked pair, so the album needs some
 * spare images beyond those showing; otherwise the same photo would appear twice at once. A small album
 * therefore gets a lower maximum than the configured one.
 * @param {number} imageCount - Number of different images in the album.
 * @param {number} configuredMin - The configured fewest photos on screen.
 * @param {number} configuredMax - The configured most photos on screen.
 * @param {number} [spare=2] - Unseen images that must remain available (2 = enough for a stacked pair).
 * @returns {{min: number, max: number}} The limits to use; min never exceeds max, and max is at least 1.
 */
export function photoLimits(imageCount, configuredMin, configuredMax, spare = 2) {
  const max = Math.max(1, Math.min(configuredMax, imageCount - spare));
  return { min: Math.min(configuredMin, max), max };
}

/**
 * Splits the length of an accordion fold into strips of WHOLE pixels. Strips of fractional size meet between two pixels, and the
 * anti-aliased edges of two separately drawn 3D strips then leave a thin line of the background showing through. So the boundaries
 * are rounded, and every strip except the last is drawn STRIP_OVERLAP pixel longer, reaching under its neighbour.
 * @param {number} size - Length of the column along the fold (its height for a vertical fold, its width for a horizontal one).
 * @param {number} count - Number of strips (at least 1).
 * @returns {{from: number, span: number, length: number}[]} One entry per strip, nearest the hinge first. `from` is the distance
 *   from the hinge end to where the strip's part of the picture starts, `span` is the strip's own whole-pixel part of the fold, and
 *   `length` is how long the strip is drawn (span plus the overlap, none for the last strip).
 */
export function accordionStrips(size, count) {
  const edges = Array.from({ length: count + 1 }, (_, k) => Math.round(k * size / count));
  return Array.from({ length: count }, (_, k) => {
    const span = edges[k + 1] - edges[k];
    return { from: edges[k], span, length: span + (k < count - 1 ? STRIP_OVERLAP : 0) };
  });
}
