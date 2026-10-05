// Tests for src/time.js: the UTC day key and the per-day counter shared by
// the state.json rails. Pure, no I/O, no real clock. The time units are
// exercised by every module that computes with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcDay, dailyCounter, bumpDaily, countToday } from '../src/time.js';

const KEYS = { dayKey: 'fooDay', countKey: 'fooCount' };
const NOON = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21T12:00:00Z

test('utcDay: the UTC date key of an epoch ms', () => {
  assert.equal(utcDay(NOON), '2026-09-21');
  assert.equal(utcDay(0), '1970-01-01');
});

test('utcDay: the day turns at UTC midnight, not local midnight', () => {
  const midnight = Date.UTC(2026, 8, 22, 0, 0, 0);
  assert.equal(utcDay(midnight - 1), '2026-09-21');
  assert.equal(utcDay(midnight), '2026-09-22');
});

test('dailyCounter: a fresh state starts the day at zero', () => {
  const state = {};
  assert.deepEqual(dailyCounter(state, KEYS, NOON), { day: '2026-09-21', count: 0, rolled: true });
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 0 });
});

test('dailyCounter: the same day keeps the count and does not roll', () => {
  const state = { fooDay: '2026-09-21', fooCount: 7 };
  assert.deepEqual(dailyCounter(state, KEYS, NOON), { day: '2026-09-21', count: 7, rolled: false });
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 7 });
});

test('dailyCounter: a new day resets the count to zero', () => {
  const state = { fooDay: '2026-09-20', fooCount: 7, other: 1 };
  assert.deepEqual(dailyCounter(state, KEYS, NOON), { day: '2026-09-21', count: 0, rolled: true });
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 0, other: 1 });
});

test('dailyCounter: a missing or invalid count on the same day reads as zero', () => {
  for (const bad of [undefined, null, 'x', NaN, -3]) {
    const state = { fooDay: '2026-09-21', fooCount: bad };
    assert.equal(dailyCounter(state, KEYS, NOON).count, 0, `count ${String(bad)}`);
  }
});

test('bumpDaily: adds one by default and returns the new count', () => {
  const state = { fooDay: '2026-09-21', fooCount: 2 };
  assert.deepEqual(bumpDaily(state, KEYS, NOON), { day: '2026-09-21', count: 3 });
  assert.equal(state.fooCount, 3);
});

test('bumpDaily: adds `by` and rolls a stale day over first', () => {
  const state = { fooDay: '2026-09-20', fooCount: 50 };
  assert.deepEqual(bumpDaily(state, KEYS, NOON, 5), { day: '2026-09-21', count: 5 });
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 5 });
});

test('countToday: the count stored for today, read without writing', () => {
  const state = { fooDay: '2026-09-21', fooCount: 7, other: 1 };
  assert.equal(countToday(state, KEYS, NOON), 7);
  assert.deepEqual(state, { fooDay: '2026-09-21', fooCount: 7, other: 1 });
});

test('countToday: 0 for yesterday\'s stamp, and the stale pair is left as it was', () => {
  const state = { fooDay: '2026-09-20', fooCount: 7 };
  assert.equal(countToday(state, KEYS, NOON), 0);
  assert.deepEqual(state, { fooDay: '2026-09-20', fooCount: 7 }, 'only dailyCounter rolls the pair over');
  const fresh = {};
  assert.equal(countToday(fresh, KEYS, NOON), 0);
  assert.deepEqual(fresh, {}, 'a fresh state gets no stamp from a read');
});

test('countToday: the day turns at UTC midnight', () => {
  const state = { fooDay: '2026-09-21', fooCount: 4 };
  const midnight = Date.UTC(2026, 8, 22, 0, 0, 0);
  assert.equal(countToday(state, KEYS, midnight - 1), 4);
  assert.equal(countToday(state, KEYS, midnight), 0);
});

test('countToday: a count that is not a finite number >= 0 reads as zero, by dailyCounter\'s rule', () => {
  for (const bad of [undefined, null, 'x', '7', NaN, Infinity, -3, {}]) {
    const state = { fooDay: '2026-09-21', fooCount: bad };
    assert.equal(countToday(state, KEYS, NOON), 0, `count ${String(bad)}`);
    assert.equal(countToday(state, KEYS, NOON), dailyCounter({ ...state }, KEYS, NOON).count, `same as dailyCounter for ${String(bad)}`);
  }
});

test('countToday: a missing state or a clock that is neither a time nor a day key reads as zero', () => {
  for (const state of [undefined, null, 'x', 7]) assert.equal(countToday(state, KEYS, NOON), 0, String(state));
  const state = { fooDay: '2026-09-21', fooCount: 7 };
  for (const clock of [undefined, null, NaN, Infinity, '', {}]) assert.equal(countToday(state, KEYS, clock), 0, String(clock));
  assert.equal(countToday({ fooCount: 7 }, KEYS, undefined), 0, 'a missing stamp never equals a missing clock');
});

test('countToday: a caller that already holds the UTC day key passes it instead of the clock', () => {
  const state = { fooDay: '2026-09-21', fooCount: 7 };
  assert.equal(countToday(state, KEYS, '2026-09-21'), 7);
  assert.equal(countToday(state, KEYS, utcDay(NOON)), countToday(state, KEYS, NOON));
  assert.equal(countToday(state, KEYS, '2026-09-22'), 0);
});
