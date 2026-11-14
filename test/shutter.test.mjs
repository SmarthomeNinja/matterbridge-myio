// A redony-pozicio becslesenek tesztje (tiszta logika, kezi oraval).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShutterTracker, POS_OPEN, POS_CLOSED, endTarget } from '../dist/shutter.js';

const T = 20_000;   // teljes futasido (ms)

test('targets within 1 % of an end stop are the end stop', () => {
  assert.deepEqual([endTarget(0), endTarget(100), endTarget(101), endTarget(5000.4), endTarget(9899), endTarget(9900), endTarget(10000)], [0, 0, 101, 5000, 9899, 10000, 10000]);
});

test('full close and open: runs to the end stop without a timed stop', () => {
  const t = new ShutterTracker(POS_OPEN, T, 0);
  assert.deepEqual(t.plan(POS_CLOSED, 0), { dir: 'close' });
  t.start('close', POS_CLOSED, 0);
  t.advance(5_000);
  assert.deepEqual(t.report(), { current: 2500, target: 10000, status: 'closing' });
  t.observe('closing', 21_000);                       // a rele meg be van kapcsolva, de a becsles szerint mar lent van
  assert.deepEqual(t.report(), { current: 10000, target: 10000, status: 'stopped' });
  t.observe('stopped', 25_000);                       // a vezerlo idozitoje kikapcsolta
  assert.deepEqual(t.report(), { current: 10000, target: 10000, status: 'stopped' });
  assert.equal(t.target, null);
});

test('an end-stop command is always sent, even when the estimate says it is already there', () => {
  const t = new ShutterTracker(POS_OPEN, T, 0);
  assert.deepEqual(t.plan(POS_OPEN, 0), { dir: 'open' });
  assert.deepEqual(t.plan(50, 0), { dir: 'open' });
});

test('intermediate target: direction and run time from the distance', () => {
  const t = new ShutterTracker(POS_OPEN, T, 0);
  assert.deepEqual(t.plan(3000, 0), { dir: 'close', runMs: 6000 });
  t.start('close', 3000, 0);
  t.advance(3_000);
  assert.deepEqual(t.report(), { current: 1500, target: 3000, status: 'closing' });
  t.stop(6_050, true);                                // idozitett leallitas: a becsles pontosan a cel
  assert.deepEqual(t.report(), { current: 3000, target: 3000, status: 'stopped' });
  assert.deepEqual(t.plan(1000, 6_050), { dir: 'open', runMs: 4000 });
  assert.deepEqual(t.plan(3040, 6_050), { dir: 'none' });
});

test('moved from the wall button: followed from the relay states, target is the end stop', () => {
  const t = new ShutterTracker(4000, T, 0);
  t.observe('opening', 1_000);
  t.observe('opening', 3_000);
  assert.deepEqual(t.report(), { current: 3000, target: 0, status: 'opening' });
  t.observe('stopped', 5_000);
  assert.deepEqual(t.report(), { current: 2000, target: 2000, status: 'stopped' });
});

test('a commanded move stopped or reversed from outside loses its target', () => {
  const t = new ShutterTracker(POS_OPEN, T, 0);
  t.start('close', 8000, 0);
  t.observe('stopped', 4_000);                        // valaki megallitotta
  assert.equal(t.target, null);
  assert.deepEqual(t.report(), { current: 2000, target: 2000, status: 'stopped' });
  t.start('close', 8000, 4_000);
  t.observe('opening', 6_000);                        // valaki megforditotta
  assert.equal(t.target, null);
  assert.deepEqual(t.report(), { current: 3000, target: 0, status: 'opening' });
});

test('the estimate never leaves 0..100 % and a full run resynchronises it', () => {
  const t = new ShutterTracker(7000, T, 0);           // elcsuszott becsles: valojaban mar lent van
  t.start('close', POS_CLOSED, 0);
  t.advance(60_000);
  assert.equal(t.pos, POS_CLOSED);
  t.stop(60_000);
  t.start('open', POS_OPEN, 60_000);
  t.advance(200_000);
  assert.equal(t.pos, POS_OPEN);
  assert.equal(new ShutterTracker(-5, T, 0).pos, 0);
  assert.equal(new ShutterTracker(20000, T, 0).pos, 10000);
});

test('a manual stop keeps the estimated position', () => {
  const t = new ShutterTracker(POS_OPEN, T, 0);
  t.start('close', POS_CLOSED, 0);
  t.stop(10_000);
  assert.deepEqual(t.report(), { current: 5000, target: 5000, status: 'stopped' });
});
