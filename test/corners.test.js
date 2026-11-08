// Checks burn-in protection's corner choice: every box moves, and no two boxes share a corner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CORNERS, pickCorners } from '../public/corners.js';

test('two boxes always move to new corners and never share one (checked over many random draws)', () => {
  for (const clock of CORNERS) {
    for (const qr of CORNERS.filter(c => c !== clock)) {
      for (let i = 0; i < 40; i++) {
        const next = pickCorners({ clock, qr });
        assert.notEqual(next.clock, clock);
        assert.notEqual(next.qr, qr);
        assert.notEqual(next.clock, next.qr);
        assert.ok(CORNERS.includes(next.clock) && CORNERS.includes(next.qr));
      }
    }
  }
});

test('even boxes that start in the same corner end up apart', () => {
  for (let i = 0; i < 40; i++) {
    const next = pickCorners({ clock: 'top-left', qr: 'top-left' });
    assert.notEqual(next.clock, next.qr);
  }
});

test('a single box moves, and boxes that are not on screen are not invented', () => {
  for (let i = 0; i < 40; i++) assert.notEqual(pickCorners({ clock: 'top-left' }).clock, 'top-left');
  assert.deepEqual(Object.keys(pickCorners({ qr: 'bottom-right' })), ['qr']);
  assert.deepEqual(pickCorners({}), {});
});

test('over time every corner gets used', () => {
  const seen = new Set();
  let current = { clock: 'top-left', qr: 'bottom-left' };
  for (let i = 0; i < 200; i++) { current = pickCorners(current); seen.add(current.clock); seen.add(current.qr); }
  assert.equal(seen.size, 4);
});
