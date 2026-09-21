// Tests for src/behavior/pending.js: the pure queue of pending direct pings
// (see mention.oneAtATime in src/discord/events.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPending, isExpired, popOldest } from '../src/behavior/pending.js';

function ping(channelId, arrivedAt, overrides = {}) {
  return { channelId, channel: { id: channelId }, trigger: { id: `m-${channelId}` }, kind: 'mention', arrivedAt, ...overrides };
}

// --- addPending --------------------------------------------------------------

test('addPending: adds a new channel to an empty list', () => {
  const { list, evicted } = addPending([], ping('c1', 100), 3);
  assert.equal(list.length, 1);
  assert.equal(list[0].channelId, 'c1');
  assert.equal(evicted, null);
});

test('addPending: a newer ping in the same channel replaces the older one', () => {
  const first = addPending([], ping('c1', 100, { trigger: { id: 'first' } }), 3).list;
  const { list, evicted } = addPending(first, ping('c1', 200, { trigger: { id: 'second' } }), 3);
  assert.equal(list.length, 1);
  assert.equal(list[0].trigger.id, 'second');
  assert.equal(list[0].arrivedAt, 200);
  assert.equal(evicted, null);
});

test('addPending: distinct channels accumulate up to maxPending', () => {
  let list = [];
  ({ list } = addPending(list, ping('c1', 100), 3));
  ({ list } = addPending(list, ping('c2', 200), 3));
  ({ list } = addPending(list, ping('c3', 300), 3));
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((p) => p.channelId).sort(), ['c1', 'c2', 'c3']);
});

test('addPending: exceeding maxPending evicts the single OLDEST entry across all channels', () => {
  let list = [];
  ({ list } = addPending(list, ping('c1', 100), 2));
  ({ list } = addPending(list, ping('c2', 200), 2));
  const { list: after, evicted } = addPending(list, ping('c3', 300), 2);
  assert.equal(evicted.channelId, 'c1');
  assert.deepEqual(after.map((p) => p.channelId).sort(), ['c2', 'c3']);
});

test('addPending: replacing a channel never counts as growing the list toward the cap', () => {
  let list = [];
  ({ list } = addPending(list, ping('c1', 100), 2));
  ({ list } = addPending(list, ping('c2', 200), 2));
  // c1 gets a newer ping -- still only 2 channels total, nothing should be evicted.
  const { list: after, evicted } = addPending(list, ping('c1', 300), 2);
  assert.equal(evicted, null);
  assert.equal(after.length, 2);
});

// --- isExpired -----------------------------------------------------------------

test('isExpired: false right when it arrives', () => {
  assert.equal(isExpired(ping('c1', 1000), 1000, 10), false);
});

test('isExpired: false just under the window', () => {
  assert.equal(isExpired(ping('c1', 1000), 1000 + 10 * 60_000 - 1, 10), false);
});

test('isExpired: true once the window has fully elapsed', () => {
  assert.equal(isExpired(ping('c1', 1000), 1000 + 10 * 60_000, 10), true);
});

// --- popOldest -------------------------------------------------------------

test('popOldest: null for an empty list', () => {
  assert.deepEqual(popOldest([]), { ping: null, list: [] });
});

test('popOldest: removes and returns the entry with the smallest arrivedAt', () => {
  const list = [ping('c1', 300), ping('c2', 100), ping('c3', 200)];
  const { ping: popped, list: rest } = popOldest(list);
  assert.equal(popped.channelId, 'c2');
  assert.deepEqual(rest.map((p) => p.channelId).sort(), ['c1', 'c3']);
});

test('popOldest: draining one at a time yields arrival order', () => {
  let list = [ping('c1', 300), ping('c2', 100), ping('c3', 200)];
  const order = [];
  while (list.length > 0) {
    const { ping: popped, list: rest } = popOldest(list);
    order.push(popped.channelId);
    list = rest;
  }
  assert.deepEqual(order, ['c2', 'c3', 'c1']);
});
