// Tests for src/behavior/pending.js: the pure queue of pending direct pings
// (see mention.oneAtATime in src/discord/events.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPending, isExpired, popOldest, requeuePending } from '../src/behavior/pending.js';

function ping(channelId, arrivedAt, overrides = {}) {
  return { channelId, channel: { id: channelId }, trigger: { id: `m-${channelId}` }, kind: 'mention', arrivedAt, ...overrides };
}

// --- addPending --------------------------------------------------------------

test('addPending: the entry a newer ping replaced comes back as replaced, null when none was', () => {
  const older = ping('s1', 100, { trigger: { id: 'call-1' }, destination: { id: 'd1' } });
  const fresh = addPending([], older, 3);
  assert.equal(fresh.replaced, null);

  const { list, replaced, evicted } = addPending(fresh.list, ping('s1', 200, { trigger: { id: 'call-2' }, destination: { id: 'd1' } }), 3);
  assert.equal(replaced, older, 'the caller can log the call that left the queue');
  assert.equal(evicted, null);
  assert.deepEqual(list.map((p) => p.trigger.id), ['call-2']);

  const other = addPending(list, ping('c2', 300), 3);
  assert.equal(other.replaced, null, 'another channel replaces nothing');
});

test('addPending: exceeding maxPending evicts the single OLDEST entry across all channels', () => {
  let list = [];
  ({ list } = addPending(list, ping('c1', 100), 2));
  ({ list } = addPending(list, ping('c2', 200), 2));
  const { list: after, evicted } = addPending(list, ping('c3', 300), 2);
  assert.equal(evicted.channelId, 'c1');
  assert.deepEqual(after.map((p) => p.channelId).sort(), ['c2', 'c3']);
});

test('pending: a routed ping keeps its source slot and its destination', () => {
  const main = { id: 'd1' };
  // The main channel's own ping waits; a routed call from the source s1 joins it.
  let list = addPending([], ping('d1', 100), 3).list;
  const routed = ping('s1', 200, { trigger: { id: 'call-1' }, destination: main });
  let evicted;
  ({ list, evicted } = addPending(list, routed, 3));
  assert.equal(evicted, null);
  assert.deepEqual(list.map((p) => [p.channelId, p.trigger.id]), [['d1', 'm-d1'], ['s1', 'call-1']], 'never replaces the destination\'s ping');
  assert.equal(list[1].destination, main);
  assert.equal(list[1].channel.id, 's1', 'the channel stays the source');

  // A newer call from the same source takes its slot and keeps its own destination.
  ({ list, evicted } = addPending(list, ping('s1', 300, { trigger: { id: 'call-2' }, destination: main }), 3));
  assert.equal(evicted, null);
  assert.deepEqual(list.map((p) => [p.channelId, p.trigger.id]), [['d1', 'm-d1'], ['s1', 'call-2']]);
  assert.equal(list[1].destination, main);

  // Re-queued after a busy turn, it keeps the destination too.
  const { list: back } = requeuePending([], { ...routed, decided: true }, 3);
  assert.equal(back[0].destination, main);
});

test('addPending: a routed ping past maxPending evicts the oldest entry of any channel, its destination\'s included', () => {
  let list = [];
  ({ list } = addPending(list, ping('d1', 100), 2));
  ({ list } = addPending(list, ping('c2', 200), 2));
  const { list: after, evicted } = addPending(list, ping('s1', 300, { destination: { id: 'd1' } }), 2);
  assert.equal(evicted.channelId, 'd1', 'the slot key is the source, the cap counts every channel');
  assert.deepEqual(after.map((p) => p.channelId), ['c2', 's1']);
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

test('isExpired: false just under the window', () => {
  assert.equal(isExpired(ping('c1', 1000), 1000 + 10 * 60_000 - 1, 10), false);
});

test('isExpired: true once the window has fully elapsed', () => {
  assert.equal(isExpired(ping('c1', 1000), 1000 + 10 * 60_000, 10), true);
});

// --- popOldest -------------------------------------------------------------

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

// --- requeuePending ----------------------------------------------------------

test('requeuePending: a newer ping already queued for the same channel wins; the re-queued one is dropped', () => {
  const newer = ping('c1', 500, { trigger: { id: 'newer' } });
  const old = ping('c1', 100, { trigger: { id: 'old' } });
  const { list, dropped, evicted } = requeuePending([newer], old, 3);
  assert.equal(list.length, 1);
  assert.equal(list[0].trigger.id, 'newer');
  assert.equal(dropped, old);
  assert.equal(evicted, null);
});

test('requeuePending: an OLDER entry for the same channel is replaced, as addPending would', () => {
  const older = ping('c1', 50, { trigger: { id: 'older' } });
  const back = ping('c1', 100, { trigger: { id: 'back' } });
  const { list, dropped, replaced } = requeuePending([older], back, 3);
  assert.deepEqual(list.map((p) => p.trigger.id), ['back']);
  assert.equal(dropped, null);
  assert.equal(replaced, older, 'reported like addPending reports it');
  assert.equal(requeuePending([], back, 3).replaced, null);
});

test('requeuePending: mention.maxPending still applies -- the oldest entry overall is evicted', () => {
  const list0 = [ping('c2', 200), ping('c3', 300)];
  const { list, dropped, evicted } = requeuePending(list0, ping('c1', 100), 2);
  assert.equal(dropped, null);
  assert.equal(evicted.channelId, 'c1', 'the re-queued ping is the oldest, so it is the one evicted');
  assert.deepEqual(list.map((p) => p.channelId).sort(), ['c2', 'c3']);
});

test('requeuePending: keeps the extra fields carried on the ping', () => {
  const { list } = requeuePending([], ping('c1', 100, { decided: true, superseded: ['call-0'] }), 3);
  assert.equal(list[0].decided, true);
  assert.deepEqual(list[0].superseded, ['call-0']);
});

// --- superseded: the calls a routed ping took the place of ---------------------

const MAIN = { id: 'd1' };

/** A routed call from the source `s1`, answered in MAIN. */
function routedPing(arrivedAt, callId, overrides = {}) {
  return ping('s1', arrivedAt, { trigger: { id: callId }, destination: MAIN, ...overrides });
}

test('addPending: a routed ping that takes the slot of an older one carries that call and what it carried, each once', () => {
  let list = addPending([], routedPing(100, 'call-1', { superseded: ['call-0'] }), 3).list;
  const newer = routedPing(200, 'call-2', { superseded: ['call-0'] });
  const { list: next, replaced } = addPending(list, newer, 3);
  assert.equal(replaced.trigger.id, 'call-1');
  assert.deepEqual(next.map((p) => [p.trigger.id, p.superseded]), [['call-2', ['call-0', 'call-1']]]);
  assert.equal(next[0].destination, MAIN);
  assert.equal(newer.superseded.length, 1, 'the ping handed in is not mutated');

  // A slot taken for the first time carries only what the ping brought.
  list = addPending([], routedPing(300, 'call-3'), 3).list;
  assert.equal('superseded' in list[0], false);
});

test('requeuePending: the newer routed ping that wins over a re-queued one carries that call and what it carried', () => {
  const queued = routedPing(500, 'call-2');
  const back = routedPing(100, 'call-1', { decided: true, superseded: ['call-0'] });
  const { list, dropped } = requeuePending([queued], back, 3);
  assert.equal(dropped, back);
  assert.deepEqual(list.map((p) => [p.trigger.id, p.superseded, p.arrivedAt]), [['call-2', ['call-0', 'call-1'], 500]]);
  assert.equal('superseded' in queued, false, 'the queued entry is not mutated');

  // A re-queued routed ping that replaces an older one carries it, as addPending would.
  const older = routedPing(50, 'call-0');
  const replacing = requeuePending([older], routedPing(100, 'call-1', { decided: true }), 3);
  assert.deepEqual(replacing.list.map((p) => [p.trigger.id, p.superseded]), [['call-1', ['call-0']]]);

  // An ordinary ping that loses its slot hands nothing on.
  const plain = requeuePending([ping('c1', 500, { trigger: { id: 'newer' } })], ping('c1', 100), 3);
  assert.equal('superseded' in plain.list[0], false);
});
