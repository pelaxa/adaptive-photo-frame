// Checks the caption template: tokens, skipped tokens and their separators, dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCaption } from '../public/caption.js';

const photo = { date: '2021-03-05T21:30:00', city: 'Paris', state: 'Île-de-France', country: 'France' };

test('fills in tokens', () => {
  assert.equal(formatCaption('{city}, {year}', photo), 'Paris, 2021');
  assert.equal(formatCaption('{city}, {state}, {country}', photo), 'Paris, Île-de-France, France');
  assert.equal(formatCaption('{date}', photo, 'en-US'), 'March 5, 2021');
});

test('the date is printed as given, whatever the time zone', () => {
  assert.equal(formatCaption('{date}', { date: '2021-01-01T00:30:00' }, 'en-US'), 'January 1, 2021');
  assert.equal(formatCaption('{date}', { date: '2021-12-31T23:59:59Z' }, 'en-US'), 'December 31, 2021');
});

test('a token the photo does not have is skipped with its separator', () => {
  assert.equal(formatCaption('{city}, {year}', { date: '2021-03-05' }), '2021');
  assert.equal(formatCaption('{city}, {year}', { city: 'Paris' }), 'Paris');
  assert.equal(formatCaption('{city}, {state}, {country}', { city: 'Paris', country: 'France' }), 'Paris, France');
  assert.equal(formatCaption('{city}, {state}, {country}', { country: 'France' }), 'France');
});

test('nothing to show gives an empty caption; an empty template gives none', () => {
  assert.equal(formatCaption('Taken in {city}', {}), '');
  assert.equal(formatCaption('', photo), '');
  assert.equal(formatCaption('{city}', {}), '');
});

test('text around the tokens stays; unknown tokens and bad dates are skipped', () => {
  assert.equal(formatCaption('Taken in {city}', photo), 'Taken in Paris');
  assert.equal(formatCaption('{nothing}, {year}', photo), '2021');
  assert.equal(formatCaption('{year}', { date: 'soon' }), '');
  assert.equal(formatCaption('{date}', photo, 'not a locale!'), '2021-03-05');
});
