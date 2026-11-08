// Checks the clock's date and time text: formats, 12/24 hours, seconds, locale, and when the next update is due.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClockFormatter, msUntilNextTick } from '../public/clock.js';

const base = { dateFormat: 'full', timeFormat: 'auto', showSeconds: false, locale: 'en-US' };
const evening = new Date(2026, 10, 7, 21, 5, 9); // Saturday 7 November 2026, 21:05:09 local time

test('date formats follow the chosen style', () => {
  /**
   * The formatted date for the evening test time in one style.
   * @param {string} style - A dateFormat value.
   * @returns {string}
   */
  const fmt = style => createClockFormatter({ ...base, dateFormat: style })(evening).date;
  assert.match(fmt('full'), /Saturday, November 7, 2026/);
  assert.match(fmt('long'), /^November 7, 2026$/);
  assert.match(fmt('medium'), /^Nov 7, 2026$/);
  assert.equal(fmt('iso'), '2026-11-07');
});

test('the locale changes the words and the order', () => {
  assert.match(createClockFormatter({ ...base, locale: 'de-DE', dateFormat: 'long' })(evening).date, /7\. November 2026/);
});

test('12 and 24 hour clocks, with or without seconds', () => {
  /**
   * The formatted time for the evening test time.
   * @param {object} options - Clock settings that replace the base ones.
   * @returns {string} With every kind of space turned into a plain space.
   */
  const time = options => createClockFormatter({ ...base, ...options })(evening).time.replace(/\s/g, ' '); // newer ICU uses a narrow no-break space before PM
  assert.equal(time({ timeFormat: '24h' }), '21:05');
  assert.equal(time({ timeFormat: '24h', showSeconds: true }), '21:05:09');
  assert.match(time({ timeFormat: '12h' }), /^9:05 PM$/);
  assert.match(time({ timeFormat: '12h', showSeconds: true }), /^9:05:09 PM$/);
  assert.match(time({ timeFormat: 'auto' }), /PM/); // en-US usually uses 12 hours
  assert.equal(time({ timeFormat: 'auto', locale: 'de-DE' }), '21:05');
});

test('midnight on a 24 hour clock is 00:00, never 24:00', () => {
  assert.equal(createClockFormatter({ ...base, timeFormat: '24h' })(new Date(2026, 10, 8, 0, 3, 0)).time, '00:03');
});

test('the next update is due at the next second or minute boundary, just after it', () => {
  assert.equal(msUntilNextTick(new Date(2026, 10, 7, 21, 5, 9, 250), true), 750 + 20);
  assert.equal(msUntilNextTick(new Date(2026, 10, 7, 21, 5, 9, 250), false), 50 * 1000 + 750 + 20);
  assert.equal(msUntilNextTick(new Date(2026, 10, 7, 21, 5, 59, 999), false), 1 + 20);
});
