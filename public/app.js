/**
 * app.js - browser code for the photo wall (a modern take on the photo frame on the first iPad).
 *
 * How it works:
 *  1. Ask the server for the album (a list of photo ids with their aspect ratios).
 *  2. Fill two rows with columns. A column is one large photo, or two small photos
 *     stacked; widths follow the photos' shapes so almost nothing is cropped.
 *  3. Every few seconds one column is replaced using a randomly chosen EFFECT (slide, page
 *     flip, accordion, conveyor). Each effect pairs an exit with a matching entrance moving
 *     the same way. The old column goes underneath, its neighbours slide across to close the
 *     gap, and the new column arrives on top at the end of the row. Row 1 grows from the
 *     right, row 2 from the left.
 *  4. The album is re-read periodically, so new photos appear and deleted ones leave.
 *
 * All tunable settings come from the server (/api/config, set in config.jsonc); see README.md.
 * The browser only talks to this app's own server; it never sees Immich itself.
 * Pure layout maths lives in layout.js (unit tested); this file does the DOM work.
 */
import { naturalWidth, frameHeightPercents, placeColumns, layoutRatio, isPanorama, photoLimits, accordionStrips, rowFill, MIN_ROW_FILL } from './layout.js';
import { createClockFormatter, msUntilNextTick } from './clock.js';
import { pickCorners } from './corners.js';
import { pickInSequence, registerNewImages, shuffle } from './sequence.js';

// ---- Constants: tuning numbers first, then the ones that come from the server's settings ----

/** Easing used for all movement: gentle start and finish. */
const EASING = 'cubic-bezier(.65, 0, .35, 1)';
/** How many random columns are compared when looking for the best fit. */
const CANDIDATES = 16;
/** How many times planRow draws a row before settling for the fullest one it saw. */
const PLAN_ATTEMPTS = 8;
/** The next photo is drawn at random from this many of the photos that were shown longest ago. */
const SAMPLE_POOL_SIZE = 24;
/** While the photo source is still starting, how often (milliseconds) the page asks whether it is ready. */
const START_POLL_MS = 3000;
/** Planning stops adding columns to a row when less than this many row-heights of width are left. */
const MIN_COLUMN_ROOM = 0.4;
/** A candidate column may be this much wider than the space left (the row then squeezes its columns slightly). */
const FIT_TOLERANCE = 1.12;
/** Roughly how many row-heights of width a stacked pair of photos takes; used to keep room for the photos a row still needs. */
const PAIR_WIDTH_ROWS = 0.8;
/** When less than this many row-heights of width are left in a row, the column that fills the gap best is chosen. */
const NEAR_END_ROWS = 1.1;
/** The arriving column starts this fraction of ANIM_MS after the old one starts leaving. */
const ENTER_DELAY_FRACTION = 0.3;
/** The neighbours of a replaced column wait this fraction of ANIM_MS before they slide across to close the gap. */
const NEIGHBOUR_DELAY_FRACTION = 0.15;
/** Delay (milliseconds) between one new column and the next when a whole row is built at once. */
const COLUMN_STAGGER_MS = 150;
/** Degrees a column swings in a page flip. */
const FLIP_DEGREES = 90;
/** Degrees the first strip of an accordion swings. */
const ACCORDION_FIRST_DEGREES = 90;
/** Degrees every later accordion strip swings, back and forth relative to its neighbour. */
const ACCORDION_FOLD_DEGREES = 180;
/** Stacking order of a column that is leaving: under its neighbours, which sit at 2 (see .column in style.css). */
const Z_LEAVING = 1;
/** Stacking order of a column that is arriving: over its neighbours. */
const Z_ARRIVING = 3;
/** Quiet time (milliseconds) after the last window resize before the columns are re-stretched. */
const RESIZE_DEBOUNCE_MS = 200;
/**
 * How often burn-in protection moves the clock and the QR code. Fixed on purpose (not a setting): an hour is short enough to spread
 * the wear and long enough not to distract.
 */
const BURN_IN_MOVE_MS = 60 * 60 * 1000;
/** How long a corner box takes to fade out (and back in) around a move; keep it in step with the `.moving` transition in style.css. */
const BURN_IN_FADE_MS = 1000;

/**
 * Settings from the server's config.jsonc. Fields: ready (false while the photo source is still
 * starting), tileSeconds, refreshSeconds, animationSeconds,
 * minPhotos, maxPhotos, stackChance, burnInProtection, accordionStrips, hardware ('low-power' | 'standard' | 'high-power'),
 * qr ({enabled, position, text} where position is a corner such as 'top-left' and text is the caption, which may be empty;
 * its colours are CSS, see style.css and custom.css),
 * clock ({enabled, position, showDate, showTime, dateFormat, timeFormat, showSeconds, locale}, see clock.js).
 */
const config = await getJson('/api/config');

// The photo source may still be starting (e.g. waiting for the network). Show a message, check
// every few seconds, and reload once it is ready. The never-ending await stops the rest of this
// file from running until then.
if (!config.ready) {
  const starting = document.querySelector('.message');
  starting.textContent = 'Starting...';
  starting.hidden = false;
  setInterval(() => getJson('/api/config').then(c => c.ready && location.reload(), () => {}), START_POLL_MS);
  await new Promise(() => {});
}
/** Length of every slide/fold animation, in milliseconds. */
const ANIM_MS = config.animationSeconds * 1000;
/** Chance that a row change shows a panorama across the whole row (when the album has one to show). */
const PANORAMA_CHANCE = config.panoramaChance;
/** Chance that a new column is two small stacked photos rather than one large photo. */
const PAIR_CHANCE = config.stackChance;
/** Configured fewest photos on screen at once, across both rows (stacked pairs are used to reach it). */
const CONFIGURED_MIN_PHOTOS = config.minPhotos;
/** Configured most photos on screen at once, across both rows (keeps the wall calm and photos large). */
const CONFIGURED_MAX_PHOTOS = config.maxPhotos;

/**
 * The three hardware levels (display.hardware):
 *   high-power  every animation: slides, page flips, accordions, and neighbours that glide by animating left and width.
 *   standard    slides only, and neighbours glide with a transform alone (cheap for the graphics chip).
 *   low-power   no animation at all: frames are simply replaced.
 */
const NO_ANIMATION = config.hardware === 'low-power';
/** True unless the hardware is high-power: only cheap, transform-only movement is used. */
const SIMPLE_MOTION = config.hardware !== 'high-power';
/** Delay (ms) between the old column starting to leave and the new one starting to arrive. */
const ENTER_DELAY = ANIM_MS * ENTER_DELAY_FRACTION;
/** Number of hinged strips an accordion fold is made of. */
const ACCORDION_STRIPS = config.accordionStrips;


/**
 * Effect definitions. Pairs of matching exit/entrance animations. The two halves of an effect always move the
 * same way (e.g. the old column goes up while the new one comes up from below), so the new
 * column looks like it is pushing the old one out. Both halves take the column element, its
 * size in pixels, the row's entry side, and (entrance only) a start delay; each returns a
 * Promise that resolves when the animation has finished.
 * They are grouped so that slow hardware can use only the cheap groups.
 * @typedef {{exit: (el: HTMLElement, w: number, h: number, dir: 1|-1) => Promise<void>,
 *         enter: (el: HTMLElement, w: number, h: number, dir: 1|-1, delay?: number) => Promise<void>}} Effect
 */

/** @type {Effect[]} Plain sideways/up/down movement: cheap, because only the compositor moves the column. */
const SLIDES = [
  // Slide: old column leaves upward, new one rises from below (and the mirror image).
  ...[true, false].map(up => ({
    exit: el => play(el, [{ transform: 'translateY(0)' }, { transform: `translateY(${up ? -100 : 100}%)` }], 0, 'forwards'),
    enter: (el, w, h, dir, delay = ENTER_DELAY) =>
      play(el, [{ transform: `translateY(${up ? 100 : -100}%)` }, { transform: 'translateY(0)' }], delay, 'backwards')
  }))
];

/** @type {Effect[]} 3D hinged flips: need 3D transforms. */
const FLIPS = [
  // Page flip: old column swings up/down on a hinge, new one swings in from the opposite hinge.
  ...[true, false].map(up => ({
    exit: el => play(el, [
      { transformOrigin: up ? 'top' : 'bottom', transform: 'rotateX(0deg)' },
      { transformOrigin: up ? 'top' : 'bottom', transform: `rotateX(${up ? FLIP_DEGREES : -FLIP_DEGREES}deg)` }
    ], 0, 'forwards'),
    enter: (el, w, h, dir, delay = ENTER_DELAY) => play(el, [
      { transformOrigin: up ? 'bottom' : 'top', transform: `rotateX(${up ? -FLIP_DEGREES : FLIP_DEGREES}deg)` },
      { transformOrigin: up ? 'bottom' : 'top', transform: 'rotateX(0deg)' }
    ], delay, 'backwards')
  }))
];

/** @type {Effect[]} Accordions: heaviest, as each fold copies the picture into several 3D strips. */
const ACCORDIONS = [
  // Vertical accordion: old column folds up into its top edge, new one unfolds upward from its bottom edge.
  ...[true, false].map(up => ({
    exit: (el, w, h) => accordion(el, w, h, true, up, false, 0),
    enter: (el, w, h, dir, delay = ENTER_DELAY) => accordion(el, w, h, true, !up, true, delay)
  })),
  // Horizontal accordion: old column folds towards the side the neighbours are shifting to,
  // new one unfolds from the row's outer edge.
  {
    exit: (el, w, h, dir) => accordion(el, w, h, false, dir > 0, false, 0),
    enter: (el, w, h, dir, delay = ENTER_DELAY) => accordion(el, w, h, false, dir < 0, true, delay)
  }
];

/** @type {Effect} Conveyor: new column slides in from the row's end while the old one drops out up or down. */
const CONVEYOR = {
  exit: el => play(el, [{ transform: 'translateY(0)' }, { transform: `translateY(${Math.random() < 0.5 ? -100 : 100}%)` }], 0, 'forwards'),
  enter: (el, w, h, dir, delay = ENTER_DELAY) =>
    play(el, [{ transform: `translateX(${dir * 100}%)` }, { transform: 'translateX(0)' }], delay, 'backwards')
};

/** Effects used on 'standard' hardware: slides only, no 3D. */
const STANDARD_EFFECTS = [...SLIDES, CONVEYOR];
/** @type {Effect} No effect at all, for 'low-power' hardware: the leaving column vanishes and the arriving one is simply there. */
const INSTANT = { exit: async () => {}, enter: async () => {} };
/** The effect pool actually used, chosen once from the hardware setting. */
const EFFECTS = NO_ANIMATION ? [INSTANT] : SIMPLE_MOTION ? STANDARD_EFFECTS : [...SLIDES, ...FLIPS, ...ACCORDIONS, CONVEYOR];

/**
 * @typedef {{id: string, ratio: number}} Photo
 *   A photo from the album; ratio is width / height.
 * @typedef {{el: HTMLElement, photos: Photo[], left?: number, width?: number}} Column
 *   One or two stacked photos; left/width are the current pixel position inside the row.
 * @typedef {{el: HTMLElement, dir: 1|-1, columns: Column[], busy: boolean, pano: boolean}} Row
 *   pano is true while the row holds a single panorama that fills it (the one case where fewer than minPhotos may be on screen);
 *   dir is the side new columns enter from (1 = right end, -1 = left end);
 *   busy is true while an animation is running so a row is never changed twice at once.
 */

// ---- State: what the page remembers while it runs ----
const gallery = document.querySelector('.gallery');
const message = document.querySelector('.message');

/** @type {Photo[]} Everything currently in the album. */
let images = [];
/** @type {Map<string, number>} Photo id -> timestamp it was last put on screen. */
const lastShown = new Map();
/** @type {Map<string, number>} Photo id -> how many times it has been put on screen (used to cycle through a sequence). */
const shownCount = new Map();
/** How the plugin wants photos chosen: 'sequence' (its list order, round after round) or 'random'. */
let imageOrder = 'random';
/** @type {Row[]} */
const rows = [0, 1].map(i => {
  const el = document.createElement('div');
  el.className = 'row';
  gallery.append(el);
  return { el, dir: i === 0 ? 1 : -1, columns: [], busy: false, pano: false };
});

/**
 * Photos that have been chosen for a row but are not on screen yet (they are still loading). They count
 * as on screen, so the other row cannot choose the same photo at the same moment (as happens at
 * start-up, when both rows are planned together).
 * @type {Set<string>}
 */
const reserved = new Set();

/** Row changed by the previous tick, so the next tick prefers the other row. */
let lastRow;

// ---- Functions ----

/**
 * Fetches and parses JSON from this app's server. (A function declaration, so the settings can be fetched near the top of the file,
 * ahead of the code that is written below.)
 * @param {string} url - Path such as '/api/images'.
 * @returns {Promise<any>} The parsed response body.
 */
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}


/**
 * Re-reads the album from the server and updates the page title.
 * On failure the previous list is kept so the wall keeps running.
 * @returns {Promise<void>}
 */
async function refresh() {
  try {
    const album = await getJson('/api/images');
    document.title = album.title;
    images = album.images;
    imageOrder = album.order === 'sequence' ? 'sequence' : 'random';
    registerNewImages(images, shownCount); // photos added to the source join the round in progress
  } catch (e) {
    console.error('Could not refresh album', e);
  }
}

/**
 * Ids of all photos currently shown on the wall.
 * @returns {Set<string>}
 */
const onScreenIds = () => new Set([...reserved, ...rows.flatMap(r => r.columns.flatMap(c => c.photos.map(p => p.id)))]);

/**
 * The most photos the wall may show right now: the configured maximum, lowered if the album is too small to
 * rotate in different images (see photoLimits). It is read each time, because the album can change.
 * @returns {number}
 */
const maxPhotos = () => photoLimits(images.length, CONFIGURED_MIN_PHOTOS, CONFIGURED_MAX_PHOTOS).max;

/**
 * The fewest photos the wall aims for: the configured minimum, never more than maxPhotos().
 * @returns {number}
 */
const minPhotos = () => photoLimits(images.length, CONFIGURED_MIN_PHOTOS, CONFIGURED_MAX_PHOTOS).min;

/**
 * Picks photos to show next. Photos on screen (or about to be) are never chosen while others are free.
 * If the plugin asked for a sequence, the next photos in its order are chosen (every photo once per
 * round, new ones included, before any repeats). Otherwise it prefers photos shown longest ago
 * (never-shown photos first), with some randomness so the order is not predictable.
 * @param {number} count - How many photos are wanted.
 * @param {Set<string>} taken - Extra ids to avoid, e.g. photos already planned but not yet on screen.
 * @returns {Photo[]} Up to `count` photos (fewer only if the album is tiny).
 */
function samplePhotos(count, taken) {
  const onScreen = onScreenIds();
  if (imageOrder === 'sequence') {
    // In the plugin's order, round after round (see sequence.js). Too few free images falls through to the repeat rules below.
    const next = pickInSequence(images, shownCount, new Set([...onScreen, ...taken]), count);
    if (next.length >= count) return next;
  }
  let pool = images.filter(p => !onScreen.has(p.id) && !taken.has(p.id));
  // Small albums: allow repeats rather than running dry.
  if (pool.length < count) pool = images.filter(p => !taken.has(p.id));
  if (pool.length < count) pool = images;
  const oldestFirst = shuffle(pool).sort((a, b) => (lastShown.get(a.id) ?? 0) - (lastShown.get(b.id) ?? 0));
  return shuffle(oldestFirst.slice(0, SAMPLE_POOL_SIZE)).slice(0, count);
}

/**
 * Builds a random column: usually two stacked landscape photos or one large photo.
 * Portraits always get a column to themselves at full height, because stacking a
 * portrait would make a very thin column.
 * @param {Set<string>} taken - Photo ids to avoid.
 * @param {number} maxPhotos - Most photos the column may hold (1 forbids stacking).
 * @param {number} [minPhotos=1] - Photos the column should hold; 2 forces an attempt at a stacked pair
 *   (it can still come back as one photo if a portrait is drawn).
 * @returns {Photo[]} One or two photos.
 */
function randomColumn(taken, maxPhotos, minPhotos = 1) {
  const wantPair = maxPhotos >= 2 && (minPhotos >= 2 || Math.random() < PAIR_CHANCE);
  const photos = samplePhotos(wantPair ? 2 : 1, taken);
  const stackable = photos.length === 2 && photos.every(p => layoutRatio(p.ratio) >= 1);
  return stackable ? photos : photos.slice(0, 1);
}

/**
 * Natural (uncropped) pixel width of a set of photos as one column in a row.
 * @param {Photo[]} photos - The photos in the column.
 * @param {number} rowHeight - Row height in pixels.
 * @returns {number}
 */
const widthOf = (photos, rowHeight) => naturalWidth(photos.map(p => p.ratio), rowHeight);

/**
 * From several candidate columns returns the one whose width is closest to a target.
 * @param {Photo[][]} candidates - Possible columns.
 * @param {number} target - Wanted natural width in pixels.
 * @param {number} rowHeight - Row height in pixels.
 * @returns {Photo[]} The best-fitting candidate.
 */
function bestFit(candidates, target, rowHeight) {
  /**
   * How far a candidate column's natural width is from the target.
   * @param {Photo[]} c - The candidate column.
   * @returns {number}
   */
  const miss = c => Math.abs(widthOf(c, rowHeight) - target);
  return candidates.reduce((best, c) => (miss(c) < miss(best) ? c : best));
}

/**
 * Preloads the image of every photo in a column, so nothing animates in half-loaded.
 * @param {Photo[]} photos - Photos to load.
 * @returns {Promise<HTMLImageElement[] | null>} Loaded images in the same order, or null if any failed.
 */
function loadImages(photos) {
  return Promise.all(photos.map(photo => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.draggable = false;
    img.src = `/api/image/${encodeURIComponent(photo.id)}`; // ids are opaque text chosen by the plugin
  }))).catch(() => null);
}

/**
 * Creates the DOM for a column: one frame per photo, stacked, each as tall as its
 * photo's shape needs. The column is not attached to the page yet.
 * @param {Photo[]} photos - The photos in the column.
 * @param {HTMLImageElement[]} imgs - Their loaded images, same order.
 * @returns {Column}
 */
function createColumn(photos, imgs) {
  const el = document.createElement('div');
  el.className = 'column';
  const heights = frameHeightPercents(photos.map(p => p.ratio));
  imgs.forEach((img, i) => {
    const frame = document.createElement('div');
    frame.className = 'frame';
    frame.style.height = `${heights[i]}%`;
    frame.append(img);
    el.append(frame);
    lastShown.set(photos[i].id, Date.now());
    shownCount.set(photos[i].id, (shownCount.get(photos[i].id) ?? 0) + 1);
  });
  return { el, photos };
}

/**
 * Runs one Web Animation and resolves when it has finished (or was cancelled).
 * @param {HTMLElement} el - Element to animate.
 * @param {Keyframe[]} keyframes - Start and end styles.
 * @param {number} delay - Milliseconds to wait before starting.
 * @param {'forwards'|'backwards'} fill - 'forwards' keeps the end state (leaving columns, which are
 *   removed afterwards); 'backwards' applies the start state during the delay (arriving columns).
 * @returns {Promise<void>}
 */
const play = (el, keyframes, delay, fill) =>
  el.animate(keyframes, { duration: ANIM_MS, delay, easing: EASING, fill }).finished.then(() => {}, () => {});

/**
 * Builds a stack of hinged strips that shows the same picture as `el`, used to
 * animate an accordion. Strips are nested: each strip is a child of the previous one,
 * attached at its far edge, so rotating one strip carries all the strips after it.
 * @param {HTMLElement} el - Column whose picture is copied into the strips.
 * @param {number} w - Column width in pixels.
 * @param {number} h - Column height in pixels.
 * @param {boolean} vertical - True to fold up/down (horizontal strips), false to fold left/right.
 * @param {boolean} atStart - True if the fixed hinge is the top/left edge, false for bottom/right.
 * @returns {{overlay: HTMLElement, strips: HTMLElement[]}} The overlay to attach to the column and
 *   the strips (outermost first) to animate.
 */
function buildAccordion(el, w, h, vertical, atStart) {
  const size = vertical ? h : w;
  // Whole-pixel strips that overlap their neighbour by a pixel: fractional sizes or exact edge-to-edge strips leave hairline gaps.
  const layout = accordionStrips(size, ACCORDION_STRIPS);
  const overlay = document.createElement('div');
  overlay.className = 'accordion';
  const strips = [];
  let parent = overlay;
  for (let k = 0; k < ACCORDION_STRIPS; k++) {
    const strip = document.createElement('div');
    strip.className = 'strip';
    // The first strip sits on the fixed hinge edge; each later strip hangs off the previous one's far edge (the previous strip's own
    // span, not its drawn length, which is a pixel longer).
    const { from, length } = layout[k];
    const edge = vertical ? (atStart ? 'top' : 'bottom') : (atStart ? 'left' : 'right');
    strip.style[edge] = k === 0 ? '0' : `${layout[k - 1].span}px`;
    strip.style[vertical ? 'width' : 'height'] = '100%';
    strip.style[vertical ? 'height' : 'width'] = `${length}px`;
    strip.style.transformOrigin = edge;

    // A full-size copy of the column, shifted so this strip shows its own slice of the picture.
    const slice = el.cloneNode(true);
    slice.classList.remove('folding');
    Object.assign(slice.style, { left: '0', top: '0', width: `${w}px`, height: `${h}px`, zIndex: '' });
    const shift = atStart ? -from : -(size - from - length);
    slice.style[vertical ? 'top' : 'left'] = `${shift}px`;
    const clip = document.createElement('div');
    clip.className = 'clip';
    clip.append(slice);
    strip.append(clip);

    parent.append(strip);
    parent = strip;
    strips.push(strip);
  }
  return { overlay, strips };
}

/**
 * Folds a column up like an accordion (or unfolds it, when `reverse` is true).
 * Folding: the first strip swings 90 degrees and every later strip swings back and forth
 * by 180 degrees relative to its neighbour, giving a zig-zag that collapses onto the hinge edge.
 * @param {HTMLElement} el - The column.
 * @param {number} w - Column width in pixels.
 * @param {number} h - Column height in pixels.
 * @param {boolean} vertical - True for a top/bottom fold, false for a left/right fold.
 * @param {boolean} atStart - True if the column stays attached at its top/left edge.
 * @param {boolean} reverse - True to unfold (arriving column), false to fold away (leaving column).
 * @param {number} delay - Milliseconds before the animation starts.
 * @returns {Promise<void>} Resolves when finished. Unfolding cleans up its helper elements;
 *   a folded-away column is simply removed by the caller.
 */
async function accordion(el, w, h, vertical, atStart, reverse, delay) {
  const { overlay, strips } = buildAccordion(el, w, h, vertical, atStart);
  const axis = vertical ? 'rotateX' : 'rotateY';
  // Sign picked so the strips swing out towards the viewer; any consistent sign looks like a fold.
  const sign = (vertical ? 1 : -1) * (atStart ? 1 : -1);
  el.classList.add('folding'); // hides the flat picture while the strips stand in for it
  el.append(overlay);
  await Promise.all(strips.map((strip, k) => {
    const folded = k === 0 ? ACCORDION_FIRST_DEGREES : (k % 2 ? -ACCORDION_FOLD_DEGREES : ACCORDION_FOLD_DEGREES);
    const frames = [{ transform: `${axis}(0deg)` }, { transform: `${axis}(${sign * folded}deg)` }];
    return play(strip, reverse ? frames.reverse() : frames, delay, reverse ? 'backwards' : 'forwards');
  }));
  if (reverse) {
    overlay.remove();
    el.classList.remove('folding');
  }
}

/**
 * Returns a random element of a list.
 * @template T
 * @param {T[]} list - Non-empty list.
 * @returns {T}
 */
const randomOf = list => list[Math.floor(Math.random() * list.length)];

/**
 * Positions every column of a row so together they fill the row's width exactly.
 * With `animate`, columns that already existed glide from their old spot to the new one.
 * Newly created columns (no previous position) are placed instantly; the caller animates them.
 * @param {Row} row - The row to lay out.
 * @param {boolean} animate - True to slide existing columns, false to jump (e.g. on resize).
 * @param {number} [delay=0] - Milliseconds to wait before sliding starts.
 * @returns {void}
 */
function layoutRow(row, animate, delay = 0) {
  const height = row.el.clientHeight;
  const spots = placeColumns(row.columns.map(c => widthOf(c.photos, height)), row.el.clientWidth);
  row.columns.forEach((col, i) => {
    const { left, width } = spots[i];
    if (animate && col.width !== undefined && !NO_ANIMATION) {
      // High power: animate left and width (smooth, but the browser re-lays-out every frame).
      // Standard: move with a transform only and snap the width, which is far cheaper.
      // Low power: no animation at all, the columns just jump to their new places.
      const frames = SIMPLE_MOTION
        ? [{ transform: `translateX(${col.left - left}px)` }, { transform: 'translateX(0)' }]
        : [{ left: `${col.left}px`, width: `${col.width}px` }, { left: `${left}px`, width: `${width}px` }];
      col.el.animate(frames, { duration: ANIM_MS, delay, easing: EASING, fill: 'backwards' });
    }
    col.el.style.left = `${left}px`;
    col.el.style.width = `${width}px`;
    col.left = left;
    col.width = width;
  });
}

/**
 * Plans a full row of ordinary columns. A plan that would fill less than MIN_ROW_FILL of the row (for example a lone stacked pair, two
 * pairs, or one regular photo) is thrown away and drawn again, because the columns would be stretched and heavily cropped: only a
 * panorama may fill a row by itself. If no attempt is full enough (a very small album, say) the fullest one is used.
 * @param {Row} row - The row to plan for (its size is read from the page).
 * @returns {Photo[][]} The photos of each planned column, left to right.
 */
function planRow(row) {
  const height = row.el.clientHeight;
  const width = row.el.clientWidth;
  let best = [];
  let bestFill = -1;
  for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
    const plan = planRowOnce(row);
    const fill = rowFill(plan.map(c => widthOf(c, height)), width);
    if (fill >= MIN_ROW_FILL) return plan;
    if (fill > bestFill) { best = plan; bestFill = fill; }
  }
  return best;
}

/**
 * One draw for planRow: picks photos for columns left to right until the row is
 * (nearly) full or its share of the photo limit is used. Nothing is loaded or shown yet.
 * @param {Row} row - The row to plan for (its size is read from the page).
 * @returns {Photo[][]} The photos of each planned column, left to right.
 */
function planRowOnce(row) {
  const height = row.el.clientHeight;
  const width = row.el.clientWidth;
  const taken = new Set();
  const plan = [];
  let used = 0;
  let budget = Math.floor(maxPhotos() / rows.length); // each row gets an equal share of the limits
  let needed = Math.ceil(minPhotos() / rows.length); // photos this row still has to reach

  // Keep adding columns until the row is (nearly) full or its photo budget is spent.
  while (width - used >= height * MIN_COLUMN_ROOM && budget > 0) {
    const remaining = width - used;
    const fits = Array.from({ length: CANDIDATES }, () => randomColumn(taken, budget, needed > 1 ? 2 : 1))
      .filter(c => c.length && widthOf(c, height) <= remaining * FIT_TOLERANCE);
    if (!fits.length) break;
    // Prefer columns that leave room for the photos still needed: each extra pair of photos takes
    // roughly PAIR_WIDTH_ROWS row-heights of width when stacked. If nothing qualifies, take what fits.
    const roomy = fits.filter(c => needed <= c.length
      || remaining - widthOf(c, height) >= Math.ceil((needed - c.length) / 2) * height * PAIR_WIDTH_ROWS);
    const choices = roomy.length ? roomy : fits;
    // Near the end pick whatever fills the gap best; otherwise any column gives variety.
    const nearEnd = remaining < height * NEAR_END_ROWS;
    const column = nearEnd ? bestFit(choices, remaining, height) : choices[0];
    column.forEach(p => taken.add(p.id));
    plan.push(column);
    budget -= column.length;
    needed -= column.length;
    used += widthOf(column, height);
    if (nearEnd && needed <= 0) break;
  }
  if (!plan.length) plan.push(randomColumn(taken, 1));
  return plan;
}

/**
 * Puts a planned set of columns on a row. Whatever the row held leaves with one random effect while
 * the new columns arrive with the matching entrance, all together. An empty row (start-up) just
 * builds up column by column, each with its own random entrance.
 * @param {Row} row - The row to change; must not be busy.
 * @param {Photo[][]} plan - The photos of each new column, left to right.
 * @param {boolean} pano - True if the plan is one panorama meant to fill the whole row.
 * @returns {Promise<void>}
 */
async function showRow(row, plan, pano) {
  row.busy = true;
  const planned = plan.flat().map(p => p.id);
  planned.forEach(id => reserved.add(id));
  try {
    const height = row.el.clientHeight;
    const loaded = await Promise.all(plan.map(loadImages));
    const fresh = plan.flatMap((photos, i) => (loaded[i] ? [createColumn(photos, loaded[i])] : []));
    if (!fresh.length) return; // nothing loaded: the row stays as it is and the next tick tries again

    const old = row.columns;
    row.columns = fresh;
    row.pano = pano && fresh.length === 1;
    fresh.forEach(col => row.el.append(col.el));
    layoutRow(row, false);

    const effect = randomOf(EFFECTS);
    // Layering as in replaceColumn: leaving columns under (Z_LEAVING), arriving columns over (Z_ARRIVING).
    old.forEach(col => { col.el.style.zIndex = Z_LEAVING; });
    await Promise.all([
      ...old.map(col => effect.exit(col.el, col.width, height, row.dir).then(() => col.el.remove())),
      ...fresh.map((col, i) => {
        col.el.style.zIndex = Z_ARRIVING;
        const entrance = old.length ? effect : randomOf(EFFECTS);
        return entrance.enter(col.el, col.width, height, row.dir, (old.length ? ENTER_DELAY : 0) + i * COLUMN_STAGGER_MS)
          .then(() => { col.el.style.zIndex = ''; });
      })
    ]);
  } finally {
    planned.forEach(id => reserved.delete(id)); // on screen by now, or abandoned
    row.busy = false;
  }
}

/**
 * Fills an empty row with a fresh set of ordinary columns. Used at start-up and to recover a row
 * whose images failed to load.
 * @param {Row} row - The (empty) row to fill.
 * @returns {Promise<void>}
 */
const fillRow = row => showRow(row, planRow(row), false);

/**
 * Picks a panorama to fill a whole row: a photo wide enough for the row (see isPanorama) that is not
 * on screen, preferring the one shown longest ago.
 * @param {Row} row - The row the panorama is for (its size decides what counts as wide enough).
 * @returns {Photo | undefined} The panorama, or undefined if the album has none to show.
 */
function pickPanorama(row) {
  const onScreen = onScreenIds();
  const pool = images.filter(p => !onScreen.has(p.id) && isPanorama(p.ratio, row.el.clientWidth, row.el.clientHeight));
  return shuffle(pool).sort((x, y) => (lastShown.get(x.id) ?? 0) - (lastShown.get(y.id) ?? 0))[0];
}

/**
 * Replaces one column in a row. The old column exits (slide/fold), the columns
 * after it slide across to close the gap, and a new column enters at the row's end.
 * The replacement is chosen so the row still fills the screen with little stretching.
 * Columns holding photos that were deleted from the album are replaced first.
 * @param {Row} row - The row to change; must have at least one column and not be busy.
 * @returns {Promise<void>}
 */
async function replaceColumn(row) {
  row.busy = true;
  const chosen = []; // ids reserved for the new column, released when the row is done
  try {
    const height = row.el.clientHeight;
    const width = row.el.clientWidth;
    const albumIds = new Set(images.map(p => p.id));

    // Which column leaves: a stale one if there is one, otherwise random.
    let index = row.columns.findIndex(c => c.photos.some(p => !albumIds.has(p.id)));
    if (index < 0) index = Math.floor(Math.random() * row.columns.length);
    const old = row.columns[index];

    // Choose the new column whose width best fills the space the old one leaves.
    const others = row.columns.filter(c => c !== old);
    const space = width - others.reduce((sum, c) => sum + widthOf(c.photos, height), 0);
    // The new column may hold as many photos as the old one plus whatever is left of the on-screen limit.
    // It must also hold enough photos to keep the wall at or above the minimum; if the random draw
    // cannot manage that (e.g. only portraits drawn), it still goes ahead with what it has.
    // Exception: while the other row holds a panorama (one photo), the wall cannot reach the minimum, so this row
    // only aims for its own half of it instead of cramming in small stacked photos.
    const otherPhotos = onScreenIds().size - old.photos.length;
    const most = old.photos.length + maxPhotos() - onScreenIds().size;
    const panoElsewhere = rows.some(r => r !== row && r.pano);
    const rowOthers = others.reduce((sum, c) => sum + c.photos.length, 0);
    const fewest = Math.max(1, panoElsewhere ? Math.ceil(minPhotos() / rows.length) - rowOthers : minPhotos() - otherPhotos);
    const candidates = Array.from({ length: CANDIDATES }, () => randomColumn(new Set(), most, fewest)).filter(c => c.length);
    const enough = candidates.filter(c => c.length >= fewest);
    const photos = bestFit(enough.length ? enough : candidates, space, height);

    // Never leave the row emptier than MIN_ROW_FILL because of this swap (it would stretch and crop the photos): if the best
    // replacement does that, and makes the row emptier than it is now, rebuild the whole row instead.
    const widths = row.columns.map(c => widthOf(c.photos, height));
    const fillAfter = rowFill([...others.map(c => widthOf(c.photos, height)), widthOf(photos, height)], width);
    if (fillAfter < MIN_ROW_FILL && fillAfter < rowFill(widths, width)) return await showRow(row, planRow(row), false);
    photos.forEach(p => { reserved.add(p.id); chosen.push(p.id); }); // chosen, but still loading: no other row may pick them meanwhile

    const imgs = await loadImages(photos);
    if (!imgs) return; // image failed to load; try again on the next tick
    const column = createColumn(photos, imgs);

    // New column joins at the row's entry side; the others keep their order.
    row.columns = row.dir > 0 ? [...others, column] : [column, ...others];
    row.el.append(column.el);
    layoutRow(row, true, ANIM_MS * NEIGHBOUR_DELAY_FRACTION);

    // Layering: the leaving column goes under the sliding neighbours (Z_LEAVING, below their 2),
    // the arriving column goes over them (Z_ARRIVING), so nothing slides "behind" a leaving column.
    const effect = randomOf(EFFECTS);
    old.el.style.zIndex = Z_LEAVING;
    column.el.style.zIndex = Z_ARRIVING;
    await Promise.all([
      effect.exit(old.el, old.width, height, row.dir).then(() => old.el.remove()),
      effect.enter(column.el, column.width, height, row.dir).then(() => { column.el.style.zIndex = ''; })
    ]);
  } finally {
    chosen.forEach(id => reserved.delete(id));
    row.busy = false;
  }
}

/**
 * One step of the wall: refills an empty row if there is one, otherwise changes a row that is not
 * busy (preferring rows showing deleted photos, then the row that was not changed last). The change is
 * usually one column replaced; sometimes (display.panoramaChance) the row becomes one panorama; and a
 * row that holds a panorama is rebuilt with ordinary columns, or another panorama.
 * @returns {void}
 */
function tick() {
  const free = rows.filter(r => !r.busy);
  const empty = free.find(r => !r.columns.length);
  if (empty) return void fillRow(empty);

  const albumIds = new Set(images.map(p => p.id));
  const stale = free.find(r => r.columns.some(c => c.photos.some(p => !albumIds.has(p.id))));
  const row = stale ?? free.find(r => r !== lastRow) ?? free[0];
  if (!row) return;
  lastRow = row;
  // Sometimes the row becomes one panorama across its whole width. Never both rows at once.
  const wide = Math.random() < PANORAMA_CHANCE && !rows.some(r => r !== row && r.pano) ? pickPanorama(row) : undefined;
  if (wide) void showRow(row, [[wide]], true);
  else if (row.pano) void showRow(row, planRow(row), false); // a lone panorama cannot swap "one column": the row is rebuilt
  else void replaceColumn(row);
}

// ---- QR code (upload link) ----
const qrBox = document.querySelector('.qrcode');
if (config.qr.enabled) {
  qrBox.dataset.position = config.qr.position; // style.css places the box in that corner
  qrBox.querySelector('p').textContent = config.qr.text; // textContent, so the text can never be read as HTML
  qrBox.querySelector('p').hidden = !config.qr.text;
  qrBox.hidden = false; // starts hidden so it never flashes up when it is switched off
} else {
  qrBox.remove();
}

// ---- clock (date and time) ----
const clockBox = document.querySelector('.clock');
if (config.clock.enabled) {
  const { position, showDate, showTime, showSeconds } = config.clock;
  const dateEl = clockBox.querySelector('.clock-date');
  const timeEl = clockBox.querySelector('.clock-time');
  clockBox.dataset.position = position; // style.css places the box in that corner
  if (config.qr.enabled && config.qr.position === position) clockBox.classList.add('beside-qr'); // same corner: sit next to the QR code
  if (!showDate) dateEl.remove();
  if (!showTime) timeEl.remove();
  const format = createClockFormatter(config.clock);
  /** Writes the current date and time (textContent, so nothing is ever read as HTML), then schedules the next change. */
  const tickClock = () => {
    const now = new Date();
    const text = format(now);
    dateEl.textContent = text.date;
    timeEl.textContent = text.time;
    setTimeout(tickClock, msUntilNextTick(now, showSeconds));
  };
  tickClock();
  clockBox.hidden = false; // starts hidden so it never flashes up when it is switched off
} else {
  clockBox.remove();
}

// ---- burn-in protection (OLED screens): move the clock and the QR code between corners now and then ----
if (config.burnInProtection) {
  /** The boxes that are on screen, by name. A box that is switched off (or the QR code with no upload address) is not here. */
  const boxes = {};
  if (config.clock.enabled) boxes.clock = clockBox;
  if (config.qr.enabled) boxes.qr = qrBox;
  /**
   * Puts every box in its corner. `beside-qr` (the clock sitting next to the QR code) only applies while both share a corner.
   * @param {Record<string, string>} corners - The corner for each box, keyed like `boxes`.
   * @returns {void}
   */
  const place = corners => {
    for (const [name, corner] of Object.entries(corners)) boxes[name].dataset.position = corner;
    clockBox.classList?.toggle('beside-qr', corners.clock !== undefined && corners.clock === corners.qr);
  };
  /**
   * The corner each visible box is in now.
   * @returns {Record<string, string>} For example { clock: 'top-left', qr: 'bottom-left' }.
   */
  const current = () => Object.fromEntries(Object.entries(boxes).map(([name, box]) => [name, box.dataset.position]));
  if (config.clock.enabled && config.qr.enabled && config.clock.position === config.qr.position) place(pickCorners(current())); // never the same corner at once
  /** Fades the boxes out, moves them while invisible, fades them back in (the fade is the .moving rule in style.css, BURN_IN_FADE_MS long). */
  const move = () => {
    const next = pickCorners(current());
    Object.values(boxes).forEach(box => box.classList.add('moving'));
    setTimeout(() => {
      place(next);
      Object.values(boxes).forEach(box => box.classList.remove('moving'));
    }, BURN_IN_FADE_MS);
  };
  if (Object.keys(boxes).length) setInterval(move, BURN_IN_MOVE_MS);
}

// ---- start-up ----
const { tileSeconds, refreshSeconds } = config;
await refresh();

if (!images.length) {
  message.textContent = 'No photos yet - scan the code to add some!';
  message.hidden = false;
  setInterval(() => location.reload(), refreshSeconds * 1000);
} else {
  rows.forEach(fillRow);
  setInterval(refresh, refreshSeconds * 1000);
  setInterval(tick, tileSeconds * 1000);
  document.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); tick(); }
  });
  // shortcut: a resize only restretches the columns; upgrade to a full rebuild if the
  // screen's shape changes a lot (e.g. rotating a tablet).
  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => rows.forEach(r => layoutRow(r, false)), RESIZE_DEBOUNCE_MS);
  });
}
