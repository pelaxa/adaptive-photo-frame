/**
 * clock.js - the text shown by the clock box (pure functions, no DOM, so they can be unit tested).
 *
 * The date and time come from the browser's own Intl formatting, so the words and the order follow the language (`locale`), and nothing
 * needs translating here. The time shown is the time of the device that displays the page.
 */

/** Milliseconds added to the delay until the next second or minute, so the timer fires just after the boundary and never just before it. */
const TICK_MARGIN_MS = 20;

/**
 * Builds a function that turns a Date into the two texts the clock shows.
 * @param {object} clock - The clock settings from /api/config.
 * @param {string} clock.dateFormat - 'full' | 'long' | 'medium' | 'short' | 'iso'.
 * @param {string} clock.timeFormat - 'auto' | '12h' | '24h'.
 * @param {boolean} clock.showSeconds - Include seconds in the time.
 * @param {string} clock.locale - Language tag such as 'en-US', or '' for the browser's own.
 * @returns {(date: Date) => {date: string, time: string}} The formatter.
 */
export function createClockFormatter({ dateFormat, timeFormat, showSeconds, locale }) {
  const tag = locale || undefined;
  const dateFormatter = dateFormat === 'iso' ? null : new Intl.DateTimeFormat(tag, { dateStyle: dateFormat });
  const timeOptions = { minute: '2-digit', ...(showSeconds ? { second: '2-digit' } : {}) };
  if (timeFormat === '12h') Object.assign(timeOptions, { hour: 'numeric', hour12: true });
  else if (timeFormat === '24h') Object.assign(timeOptions, { hour: '2-digit', hourCycle: 'h23' }); // h23 never shows "24:05"
  else timeOptions.hour = 'numeric'; // 'auto': the locale decides between 12 and 24 hours
  const timeFormatter = new Intl.DateTimeFormat(tag, timeOptions);
  /**
   * Pads a number to two digits.
   * @param {number} n - A number from 0 to 99.
   * @returns {string}
   */
  const two = n => String(n).padStart(2, '0');
  return date => ({
    date: dateFormatter ? dateFormatter.format(date) : `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`,
    time: timeFormatter.format(date)
  });
}

/**
 * Milliseconds until the clock next needs to change: the start of the next second (when seconds are shown) or minute.
 * A few milliseconds are added so the timer fires just after the boundary, never just before it (which would show the old time again).
 * @param {Date} now - The current time.
 * @param {boolean} showSeconds - Whether the clock shows seconds.
 * @returns {number} Delay in milliseconds (always above zero).
 */
export function msUntilNextTick(now, showSeconds) {
  const sinceSecond = now.getMilliseconds();
  const wait = showSeconds ? 1000 - sinceSecond : (59 - now.getSeconds()) * 1000 + (1000 - sinceSecond);
  return wait + TICK_MARGIN_MS;
}
