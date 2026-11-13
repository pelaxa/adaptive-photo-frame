/**
 * caption.js - builds the one-line caption shown on a photo from the `display.caption` template.
 *
 * The template is plain text with tokens in braces: {date}, {year}, {city}, {state}, {country}, for example "{city}, {year}".
 * A photo source gives only the facts it has. A token with no value is left out together with the text in front of it
 * (its separator), so "{city}, {year}" gives "Paris, 2021", "2021" without a city, and "Paris" without a date.
 * Pure functions (no page access), so they are unit-tested.
 */

/** The tokens a template may use. */
export const CAPTION_TOKENS = ['date', 'year', 'city', 'state', 'country'];

/** A date as plugins give it: the first ten characters are the day the photo was taken (year-month-day). */
const DAY = /^(\d{4})-(\d\d)-(\d\d)/;

/**
 * Looks up the text for one token of one photo.
 * @param {string} token - One of CAPTION_TOKENS.
 * @param {{date?: string, city?: string, state?: string, country?: string}} photo - The photo's facts.
 * @param {string | undefined} locale - Language tag for {date} (undefined = the browser's own).
 * @returns {string} The text, or '' if the photo has no value for it.
 */
function tokenValue(token, photo, locale) {
  if (token === 'date' || token === 'year') {
    const day = DAY.exec(photo.date ?? '');
    if (!day) return '';
    if (token === 'year') return day[1];
    const date = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    if (Number.isNaN(date.getTime())) return '';
    try {
      // UTC, so the day is printed as given and never shifted by the viewer's time zone.
      return date.toLocaleDateString(locale || undefined, { dateStyle: 'long', timeZone: 'UTC' });
    } catch {
      return date.toISOString().slice(0, 10); // an unusable locale tag: fall back to year-month-day
    }
  }
  return photo[token] ?? '';
}

/**
 * Fills in a caption template for one photo.
 * shortcut: a missing token drops only the literal text directly before it, so keep templates to values joined by
 * simple separators such as ", " or " - " (text after a token, such as a closing bracket, stays), upgrade if brackets are needed.
 * @param {string} template - The `display.caption` text.
 * @param {{date?: string, city?: string, state?: string, country?: string}} photo - The photo's facts.
 * @param {string} [locale] - Language tag for {date}.
 * @returns {string} The caption, or '' if the template is empty or no token has a value.
 */
export function formatCaption(template, photo, locale) {
  if (!template) return '';
  // split() with a capturing group alternates text and token names: [text, token, text, token, ..., text]
  const pieces = template.split(/\{(\w+)\}/);
  let out = '';
  let any = false;
  for (let i = 1; i < pieces.length; i += 2) {
    const value = CAPTION_TOKENS.includes(pieces[i]) ? tokenValue(pieces[i], photo, locale) : '';
    if (!value) continue;
    if (!any && i === 1) out += pieces[0]; // text before the very first token stays only if that token is shown
    else if (any) out += pieces[i - 1]; // the separator in front of a later token
    out += value;
    any = true;
  }
  return any ? out + pieces.at(-1) : '';
}
