// Tests for src/memory/details.js: applyDetailOps (add/seen/remove, the
// confirmation weight/gap rule shared with interests, id assignment/reuse,
// clamping, eviction) and migrateDetails (legacy string array -> atomic
// items). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDetailOps, migrateDetails } from '../src/memory/details.js';
import { isConfirmed } from '../src/memory/interests.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21T12:00:00Z
const HOUR = 3_600_000;

function opts(overrides = {}) {
  return { maxDetails: 15, fieldChars: 200, confirmGapHours: 12, seenAt: NOW, nextId: 1, ...overrides };
}

// ---- applyDetailOps: add, a brand new item -----------------------------------

test('applyDetailOps: add of new text inserts an item with weight 1 and a fresh id', () => {
  const { items, nextId } = applyDetailOps([], { add: ['Owns a cat'] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 1);
  assert.equal(items[0].text, 'Owns a cat');
  assert.equal(items[0].weight, 1);
  assert.equal(items[0].firstSeen, new Date(NOW).toISOString());
  assert.equal(items[0].lastSeen, new Date(NOW).toISOString());
  assert.equal(nextId, 2);
});

test('applyDetailOps: add accepts {text, sure} objects too', () => {
  const { items } = applyDetailOps([], { add: [{ text: 'Plays guitar' }] }, opts());
  assert.equal(items[0].text, 'Plays guitar');
  assert.equal(items[0].weight, 1);
});

test('applyDetailOps: add with sure:false starts at weight 0', () => {
  const { items } = applyDetailOps([], { add: [{ text: 'Maybe owns a cat', sure: false }] }, opts());
  assert.equal(items[0].weight, 0);
  assert.equal(isConfirmed(items[0]), false);
});

// ---- applyDetailOps: identity / dedupe on add --------------------------------

test('applyDetailOps: add of already-known text (trimmed, whitespace-collapsed, lowercased) is a sighting, not a duplicate', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null }];
  const { items } = applyDetailOps(existing, { add: ['  owns   a CAT '] }, opts({ nextId: 2 }));
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Owns a cat', 'the originally stored text is kept, not the new casing');
  assert.equal(items[0].weight, 2);
});

// ---- applyDetailOps: the confirmation weight / gap rule ----------------------

test('applyDetailOps: a sighting close in time to lastSeen does not bump the weight', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: new Date(NOW).toISOString() }];
  const { items } = applyDetailOps(existing, { seen: [1] }, opts({ seenAt: NOW + 2 * HOUR, nextId: 2 }));
  assert.equal(items[0].weight, 1);
});

test('applyDetailOps: a sighting past confirmGapHours away bumps the weight once', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: new Date(NOW).toISOString() }];
  const { items } = applyDetailOps(existing, { seen: [1] }, opts({ seenAt: NOW + 13 * HOUR, nextId: 2 }));
  assert.equal(items[0].weight, 2);
});

test('applyDetailOps: sure:false on an EXISTING item changes nothing at all', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 3, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' }];
  const { items } = applyDetailOps(existing, { add: [{ text: 'Owns a cat', sure: false }] }, opts({ seenAt: NOW, nextId: 2 }));
  assert.deepEqual(items, existing);
});

// ---- applyDetailOps: seen -----------------------------------------------------

test('applyDetailOps: seen by numeric id is a sighting', () => {
  const existing = [{ id: 3, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null }];
  const { items } = applyDetailOps(existing, { seen: [3] }, opts({ nextId: 4 }));
  assert.equal(items[0].weight, 2);
});

test('applyDetailOps: seen by exact stored text is a sighting', () => {
  const existing = [{ id: 3, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null }];
  const { items } = applyDetailOps(existing, { seen: ['owns a cat'] }, opts({ nextId: 4 }));
  assert.equal(items[0].weight, 2);
});

test('applyDetailOps: seen of an unknown id/text never creates one', () => {
  const { items } = applyDetailOps([], { seen: [99] }, opts());
  assert.deepEqual(items, []);
});

// ---- applyDetailOps: remove ----------------------------------------------------

test('applyDetailOps: remove by numeric id deletes the matching item', () => {
  const existing = [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: 'a', lastSeen: null },
  ];
  const { items } = applyDetailOps(existing, { remove: [1] }, opts({ nextId: 3 }));
  assert.deepEqual(items.map((i) => i.id), [2]);
});

test('applyDetailOps: remove by exact stored text deletes the matching item', () => {
  const existing = [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: null }];
  const { items } = applyDetailOps(existing, { remove: ['Owns a cat'] }, opts({ nextId: 2 }));
  assert.deepEqual(items, []);
});

// ---- id assignment / never reused --------------------------------------------

test('applyDetailOps: ids increment across calls and are never reused after a remove', () => {
  let result = applyDetailOps([], { add: ['a', 'b'] }, opts({ nextId: 1 }));
  assert.deepEqual(result.items.map((i) => i.id), [1, 2]);
  assert.equal(result.nextId, 3);

  result = applyDetailOps(result.items, { remove: [1] }, opts({ nextId: result.nextId }));
  assert.deepEqual(result.items.map((i) => i.id), [2]);

  result = applyDetailOps(result.items, { add: ['c'] }, opts({ nextId: result.nextId }));
  assert.deepEqual(result.items.map((i) => i.id), [2, 3], 'id 1 is never reused');
  assert.equal(result.nextId, 4);
});

test('applyDetailOps: nextId defaults to 1 when omitted or invalid', () => {
  assert.equal(applyDetailOps([], { add: ['a'] }, { seenAt: NOW }).nextId, 2);
  assert.equal(applyDetailOps([], { add: ['a'] }, { seenAt: NOW, nextId: 0 }).items[0].id, 1);
  assert.equal(applyDetailOps([], { add: ['a'] }, { seenAt: NOW, nextId: -3 }).items[0].id, 1);
});

// ---- clamping / rejection -----------------------------------------------------

test('applyDetailOps: text is clamped to fieldChars', () => {
  const { items } = applyDetailOps([], { add: ['x'.repeat(60)] }, opts({ fieldChars: 5 }));
  assert.equal(items[0].text.length, 5);
});

test('applyDetailOps: an empty/whitespace-only text is rejected', () => {
  const { items } = applyDetailOps([], { add: ['   ', ''] }, opts());
  assert.deepEqual(items, []);
});

// ---- eviction: weight then age -------------------------------------------------

test('applyDetailOps: evicts the lowest weight first once over maxDetails', () => {
  const existing = [
    { id: 1, text: 'a', weight: 5, firstSeen: 'x', lastSeen: '2026-01-01T00:00:00.000Z' },
    { id: 2, text: 'b', weight: 1, firstSeen: 'x', lastSeen: '2026-01-02T00:00:00.000Z' },
    { id: 3, text: 'c', weight: 3, firstSeen: 'x', lastSeen: '2026-01-03T00:00:00.000Z' },
  ];
  const { items } = applyDetailOps(existing, { add: ['d'] }, opts({ maxDetails: 3, nextId: 4 }));
  assert.deepEqual(items.map((i) => i.text).sort(), ['a', 'c', 'd']);
});

test('applyDetailOps: among equal weights, evicts the oldest lastSeen first', () => {
  const existing = [
    { id: 1, text: 'a', weight: 3, firstSeen: 'x', lastSeen: '2026-01-01T00:00:00.000Z' },
    { id: 2, text: 'b', weight: 3, firstSeen: 'x', lastSeen: '2026-01-05T00:00:00.000Z' },
    { id: 3, text: 'c', weight: 3, firstSeen: 'x', lastSeen: '2026-01-03T00:00:00.000Z' },
  ];
  const { items } = applyDetailOps(existing, {}, opts({ maxDetails: 2, nextId: 4 }));
  assert.deepEqual(items.map((i) => i.text).sort(), ['b', 'c']);
});

// ---- garbage tolerance ----------------------------------------------------------

test('applyDetailOps: garbage ops never throw and change nothing', () => {
  const existing = [{ id: 1, text: 'a', weight: 1, firstSeen: 'x', lastSeen: null }];
  for (const garbage of [null, undefined, 'not an object', 42, [1, 2, 3], { add: 'nope' }, { add: [null, 42, {}] }, { seen: [{}] }, { remove: [{}] }]) {
    const { items } = applyDetailOps(existing, garbage, opts({ nextId: 2 }));
    assert.equal(items.length, 1, `garbage ${JSON.stringify(garbage)} must not throw or add anything`);
  }
});

test('applyDetailOps: existing undefined/non-array is tolerated', () => {
  const { items } = applyDetailOps(undefined, { add: ['first ever detail'] }, opts());
  assert.equal(items.length, 1);
});

test('applyDetailOps: does not mutate the existing array or its items', () => {
  const existing = [{ id: 1, text: 'a', weight: 1, firstSeen: 'x', lastSeen: null }];
  const copy = existing.map((i) => ({ ...i }));
  applyDetailOps(existing, { seen: [1] }, opts({ seenAt: NOW + 100 * HOUR, nextId: 2 }));
  assert.deepEqual(existing, copy);
});

// ---- migrateDetails: legacy string array ----------------------------------------

test('migrateDetails: a legacy array of bare strings becomes items with weight 1, null dates, fresh ids', () => {
  const { items, nextId } = migrateDetails(['Owns a cat', 'Plays guitar'], 1);
  assert.deepEqual(items, [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: null, lastSeen: null },
  ]);
  assert.equal(nextId, 3);
});

test('migrateDetails: startId offsets the assigned ids', () => {
  const { items, nextId } = migrateDetails(['a', 'b'], 5);
  assert.deepEqual(items.map((i) => i.id), [5, 6]);
  assert.equal(nextId, 7);
});

test('migrateDetails: blank/whitespace-only entries are dropped', () => {
  const { items } = migrateDetails(['  ', 'Owns a cat', '']);
  assert.deepEqual(items.map((i) => i.text), ['Owns a cat']);
});

test('migrateDetails: an array already in the item shape passes through, keeping valid ids', () => {
  const { items, nextId } = migrateDetails([{ id: 7, text: 'Owns a cat', weight: 3, firstSeen: 'a', lastSeen: 'b' }], 1);
  assert.deepEqual(items, [{ id: 7, text: 'Owns a cat', weight: 3, firstSeen: 'a', lastSeen: 'b' }]);
  assert.equal(nextId, 8, 'the sequence continues past the highest id seen');
});

test('migrateDetails: item-shaped entries missing a valid id get one assigned fresh', () => {
  const { items } = migrateDetails([{ text: 'Owns a cat' }], 1);
  assert.deepEqual(items, [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null }]);
});

test('migrateDetails: garbage entries never throw, valid ones survive', () => {
  const { items } = migrateDetails([null, 42, {}, { text: '' }, 'Owns a cat'], 1);
  assert.deepEqual(items.map((i) => i.text), ['Owns a cat']);
});

test('migrateDetails: null/undefined/number/object all yield an empty list', () => {
  assert.deepEqual(migrateDetails(null).items, []);
  assert.deepEqual(migrateDetails(undefined).items, []);
  assert.deepEqual(migrateDetails(42).items, []);
  assert.deepEqual(migrateDetails({ not: 'an array' }).items, []);
});
