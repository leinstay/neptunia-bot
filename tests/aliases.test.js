// Tests for src/memory/aliases.js: applyAliasOps -- add/sighting/remove,
// ignoring an alias equal to a display name, clamping, rank-based eviction.
// Pure, no I/O. Shares its confirmation/gap/rank mechanics with
// src/memory/interests.js#applyRankedOps -- see tests/interests.test.js for
// the exhaustive coverage of that shared core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAliasOps } from '../src/memory/aliases.js';
import { topByRank } from '../src/memory/ranking.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const HOUR = 3_600_000;

function opts(overrides = {}) {
  return { maxAliases: 5, maxAliasesStored: 15, confirmGapHours: 12, seenAt: NOW, ...overrides };
}

test('applyAliasOps: add of a new alias inserts it with weight 1', () => {
  const items = applyAliasOps([], { add: ['Vertex'] }, ['LongDisplayName'], opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Vertex');
  assert.equal(items[0].weight, 1);
  assert.equal(items[0].firstSeen, new Date(NOW).toISOString());
});

test('applyAliasOps: add of an already-known alias (case-insensitive) is a sighting', () => {
  const existing = [{ name: 'Vertex', weight: 1, firstSeen: 'a', lastSeen: new Date(NOW - 20 * HOUR).toISOString() }];
  const items = applyAliasOps(existing, { add: ['vertex'] }, [], opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Vertex', 'original casing kept');
  assert.equal(items[0].weight, 2);
});

test('applyAliasOps: a sighting inside the confirmGapHours window does not bump the weight', () => {
  const existing = [{ name: 'Vertex', weight: 1, firstSeen: 'a', lastSeen: new Date(NOW).toISOString() }];
  const items = applyAliasOps(existing, { add: ['Vertex'] }, [], opts({ seenAt: NOW + 2 * HOUR }));
  assert.equal(items[0].weight, 1);
});

test('applyAliasOps: an add equal (case-insensitively) to a stored display name is ignored outright', () => {
  const items = applyAliasOps([], { add: ['prime', 'Vertex'] }, ['Prime'], opts());
  assert.deepEqual(items.map((i) => i.name), ['Vertex'], 'the one matching a display name never becomes an alias');
});

test('applyAliasOps: an add equal to a display name does not even count as a sighting on an existing alias', () => {
  // A stored alias that later becomes identical to a (new) display name is
  // untouched by this call -- only fresh `add`s are filtered.
  const existing = [{ name: 'Prime', weight: 3, firstSeen: 'a', lastSeen: 'a' }];
  const items = applyAliasOps(existing, {}, ['Prime'], opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].weight, 3, 'untouched: no op targeted it');
});

test('applyAliasOps: remove deletes the alias, case-insensitively', () => {
  const existing = [
    { name: 'Vertex', weight: 3, firstSeen: 'a', lastSeen: 'a' },
    { name: 'Prime', weight: 1, firstSeen: 'a', lastSeen: 'a' },
  ];
  const items = applyAliasOps(existing, { remove: ['vertex'] }, [], opts());
  assert.deepEqual(items.map((i) => i.name), ['Prime']);
});

test('applyAliasOps: an alias is clamped to 40 characters', () => {
  const items = applyAliasOps([], { add: ['x'.repeat(60)] }, [], opts());
  assert.equal(items[0].name.length, 40);
});

test('applyAliasOps: eviction keeps the top maxAliasesStored/maxAliases by rank', () => {
  const existing = [
    { name: 'a', weight: 5, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
    { name: 'b', weight: 1, firstSeen: '2026-01-02T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z' },
    { name: 'c', weight: 3, firstSeen: '2026-01-03T00:00:00.000Z', lastSeen: '2026-01-03T00:00:00.000Z' },
  ];
  const items = applyAliasOps(existing, { add: ['d'] }, [], opts({ maxAliases: 3, maxAliasesStored: 3 }));
  assert.deepEqual(items.map((i) => i.name).sort(), ['a', 'c', 'd']);
});

test('applyAliasOps: the storage cap is max(maxAliasesStored, maxAliases) -- a smaller stored cap never wins', () => {
  const existing = [
    { name: 'a', weight: 1, firstSeen: 'x', lastSeen: '2026-01-01T00:00:00.000Z' },
    { name: 'b', weight: 1, firstSeen: 'x', lastSeen: '2026-01-02T00:00:00.000Z' },
  ];
  const items = applyAliasOps(existing, {}, [], opts({ maxAliases: 5, maxAliasesStored: 1 }));
  assert.equal(items.length, 2, 'stored cap floored at the shown cap, so both survive');
});

test('applyAliasOps: garbage ops never throw and change nothing', () => {
  const existing = [{ name: 'Vertex', weight: 1, firstSeen: 'a', lastSeen: 'a' }];
  for (const garbage of [null, undefined, 'nope', 42, [1, 2], { add: 'nope' }, { add: [null, 42, {}] }, { remove: [null, 42] }]) {
    const items = applyAliasOps(existing, garbage, [], opts());
    assert.equal(items.length, 1, `garbage ${JSON.stringify(garbage)} must not throw or add anything`);
  }
});

test('applyAliasOps: existing undefined (a profile without aliases yet) is tolerated', () => {
  const items = applyAliasOps(undefined, { add: ['Vertex'] }, [], opts());
  assert.equal(items.length, 1);
});

test('applyAliasOps: does not mutate the existing array or its items', () => {
  const existing = [{ name: 'Vertex', weight: 1, firstSeen: 'a', lastSeen: 'a' }];
  const copy = existing.map((i) => ({ ...i }));
  applyAliasOps(existing, { add: ['Vertex'] }, [], opts());
  assert.deepEqual(existing, copy);
});

test('applyAliasOps: with halfLifeDays, top-ranked aliases can be selected the same way as interests', () => {
  const existing = [
    { name: 'Ancient nickname', weight: 10, firstSeen: '2021-01-01T00:00:00.000Z', lastSeen: '2021-01-01T00:00:00.000Z' },
    { name: 'Fresh nickname', weight: 2, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-01T00:00:00.000Z' },
  ];
  const shown = topByRank(existing, 1, 180);
  assert.equal(shown[0].name, 'Fresh nickname');
});
