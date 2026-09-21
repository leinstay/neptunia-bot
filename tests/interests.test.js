// Tests for src/memory/interests.js: applyInterestOps (add/update/seen/remove,
// the confirmation weight/gap rule, clamping, rejection, eviction),
// migrateInterests (legacy prose -> atomic items) and the isConfirmed/isStale
// helpers. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInterestOps,
  migrateInterests,
  normalizeTopic,
  isConfirmed,
  isStale,
  stripTrailingParenthetical,
} from '../src/memory/interests.js';
import { topByRank } from '../src/memory/ranking.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21T12:00:00Z
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function opts(overrides = {}) {
  return { maxInterests: 12, topicChars: 40, noteChars: 120, confirmGapHours: 12, seenAt: NOW, ...overrides };
}

// ---- normalizeTopic ---------------------------------------------------------

test('normalizeTopic: trims, collapses inner whitespace, lowercases', () => {
  assert.equal(normalizeTopic('  Board   Games  '), 'board games');
});

test('normalizeTopic: is Unicode-aware (accented Latin / Greek casing)', () => {
  assert.equal(normalizeTopic('Café'), 'café');
  assert.equal(normalizeTopic('ΚΑΦΕΣ'), 'καφες');
});

test('normalizeTopic: null/undefined behave like an empty string', () => {
  assert.equal(normalizeTopic(undefined), '');
  assert.equal(normalizeTopic(null), '');
});

// ---- applyInterestOps: add, a brand new topic --------------------------------

test('applyInterestOps: add of a new topic inserts it with weight 1', () => {
  const items = applyInterestOps([], { add: [{ topic: 'Chess', note: 'plays weekly' }] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].topic, 'Chess');
  assert.equal(items[0].note, 'plays weekly');
  assert.equal(items[0].weight, 1);
  assert.equal(items[0].firstSeen, new Date(NOW).toISOString());
  assert.equal(items[0].lastSeen, new Date(NOW).toISOString());
});

test('applyInterestOps: add with sure:false on a brand new topic starts at weight 0', () => {
  const items = applyInterestOps([], { add: [{ topic: 'Chess', note: 'maybe', sure: false }] }, opts());
  assert.equal(items[0].weight, 0);
  assert.equal(isConfirmed(items[0]), false);
});

// ---- applyInterestOps: the confirmation weight / gap rule --------------------

function stored(list) {
  return list.map(([topic, weight, lastSeen, firstSeen = lastSeen]) => ({ topic, note: '', weight, firstSeen, lastSeen }));
}

test('applyInterestOps: a sighting close in time to lastSeen (same conversation split over two batches) does not bump the weight', () => {
  const existing = stored([['Chess', 1, new Date(NOW).toISOString()]]);
  const laterSameConvo = NOW + 2 * HOUR; // well under the 12h confirmGapHours
  const items = applyInterestOps(existing, { seen: ['chess'] }, opts({ seenAt: laterSameConvo }));
  assert.equal(items[0].weight, 1, 'still the same occasion, no bump');
  assert.equal(items[0].lastSeen, new Date(laterSameConvo).toISOString(), 'lastSeen still advances');
});

test('applyInterestOps: a sighting past confirmGapHours away from lastSeen bumps the weight once', () => {
  const existing = stored([['Chess', 1, new Date(NOW).toISOString()]]);
  const muchLater = NOW + 13 * HOUR; // past the 12h gap
  const items = applyInterestOps(existing, { seen: ['chess'] }, opts({ seenAt: muchLater }));
  assert.equal(items[0].weight, 2);
});

test('applyInterestOps: at most one bump per item per call, even when add/update/seen all target it', () => {
  const existing = stored([['Chess', 1, new Date(NOW).toISOString()]]);
  const muchLater = NOW + 30 * HOUR;
  const items = applyInterestOps(
    existing,
    { add: [{ topic: 'Chess', note: '' }], update: [{ topic: 'chess', note: '' }], seen: ['CHESS'] },
    opts({ seenAt: muchLater }),
  );
  assert.equal(items[0].weight, 2, 'only one bump total, not three');
});

test('applyInterestOps: a null lastSeen counts as far away, so the very first re-sighting always bumps', () => {
  const existing = [{ topic: 'Chess', note: '', weight: 1, firstSeen: null, lastSeen: null }];
  const items = applyInterestOps(existing, { seen: ['chess'] }, opts({ seenAt: NOW }));
  assert.equal(items[0].weight, 2);
});

test('applyInterestOps: sure:false new item needs two later, well-spaced sightings to reach confirmAfter 2', () => {
  let items = applyInterestOps([], { add: [{ topic: 'Chess', sure: false }] }, opts({ seenAt: NOW }));
  assert.equal(items[0].weight, 0);
  assert.equal(isConfirmed(items[0], 2), false);

  items = applyInterestOps(items, { seen: ['chess'] }, opts({ seenAt: NOW + 20 * HOUR }));
  assert.equal(items[0].weight, 1);
  assert.equal(isConfirmed(items[0], 2), false);

  items = applyInterestOps(items, { seen: ['chess'] }, opts({ seenAt: NOW + 40 * HOUR }));
  assert.equal(items[0].weight, 2);
  assert.equal(isConfirmed(items[0], 2), true);
});

test('applyInterestOps: sure:false on an EXISTING item changes nothing at all', () => {
  const existing = [{ topic: 'Chess', note: 'plays weekly', weight: 3, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' }];
  const items = applyInterestOps(
    existing,
    { add: [{ topic: 'Chess', note: 'something else entirely', sure: false }] },
    opts({ seenAt: NOW }),
  );
  assert.deepEqual(items, existing);
});

test('applyInterestOps: out-of-order history -- an older batch processed after a newer one keeps lastSeen, lowers firstSeen', () => {
  const newer = NOW;
  const older = NOW - 5 * DAY;
  let items = applyInterestOps([], { add: [{ topic: 'Chess', note: '' }] }, opts({ seenAt: newer }));
  assert.equal(items[0].firstSeen, new Date(newer).toISOString());
  assert.equal(items[0].lastSeen, new Date(newer).toISOString());

  items = applyInterestOps(items, { add: [{ topic: 'Chess', note: '' }] }, opts({ seenAt: older }));
  assert.equal(items[0].firstSeen, new Date(older).toISOString(), 'firstSeen moves earlier');
  assert.equal(items[0].lastSeen, new Date(newer).toISOString(), 'lastSeen stays at the newer date');
});

// ---- applyInterestOps: add of an existing topic ------------------------------

test('applyInterestOps: add of an existing topic keeps the note when the incoming one is empty', () => {
  const existing = [{ topic: 'Chess', note: 'plays weekly', weight: 2, firstSeen: 'a', lastSeen: new Date(NOW - 20 * HOUR).toISOString() }];
  const items = applyInterestOps(existing, { add: [{ topic: 'chess', note: '' }] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].note, 'plays weekly', 'an empty incoming note never erases the stored one');
  assert.equal(items[0].lastSeen, new Date(NOW).toISOString());
});

test('applyInterestOps: add of an existing topic replaces the note when the incoming one is non-empty, regardless of the gap', () => {
  const existing = [{ topic: 'Chess', note: 'plays weekly', weight: 2, firstSeen: 'a', lastSeen: new Date(NOW - 1 * HOUR).toISOString() }];
  const items = applyInterestOps(existing, { add: [{ topic: 'Chess', note: 'joined a tournament' }] }, opts());
  assert.equal(items[0].note, 'joined a tournament');
  assert.equal(items[0].weight, 2, 'the gap was too short to bump the weight, but the note still replaces');
});

test('applyInterestOps: topic identity is case-insensitive', () => {
  const existing = [{ topic: 'Anime', note: '', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { add: [{ topic: 'ANIME', note: '' }] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].topic, 'Anime', 'the original casing is kept, only the weight/lastSeen change');
  assert.equal(items[0].weight, 2);
});

// ---- applyInterestOps: update -------------------------------------------------

test('applyInterestOps: update of an existing topic is a sighting like add', () => {
  const existing = [{ topic: 'Fishing', note: 'lake trips', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { update: [{ topic: 'fishing', note: 'caught a big bass' }] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].weight, 2);
  assert.equal(items[0].note, 'caught a big bass');
});

test('applyInterestOps: update of an unknown topic behaves as add', () => {
  const items = applyInterestOps([], { update: [{ topic: 'Cooking', note: 'loves pasta' }] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].topic, 'Cooking');
  assert.equal(items[0].weight, 1);
});

// ---- applyInterestOps: seen ---------------------------------------------------

test('applyInterestOps: seen of a known topic by plain string is a sighting, never touches the note', () => {
  const existing = [{ topic: 'Chess', note: 'plays weekly', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { seen: ['Chess'] }, opts());
  assert.equal(items[0].weight, 2);
  assert.equal(items[0].note, 'plays weekly');
});

test('applyInterestOps: seen of an unknown topic never creates one', () => {
  const items = applyInterestOps([], { seen: ['Chess'] }, opts());
  assert.deepEqual(items, []);
});

// ---- applyInterestOps: remove -------------------------------------------------

test('applyInterestOps: remove deletes the item matching that topic, case-insensitively', () => {
  const existing = [
    { topic: 'Chess', note: '', weight: 3, firstSeen: 'a', lastSeen: 'a' },
    { topic: 'Anime', note: '', weight: 1, firstSeen: 'a', lastSeen: 'a' },
  ];
  const items = applyInterestOps(existing, { remove: ['chess'] }, opts());
  assert.deepEqual(items.map((i) => i.topic), ['Anime']);
});

test('applyInterestOps: remove of a topic not present is a no-op', () => {
  const existing = [{ topic: 'Chess', note: '', weight: 3, firstSeen: 'a', lastSeen: 'a' }];
  const items = applyInterestOps(existing, { remove: ['Cooking'] }, opts());
  assert.equal(items.length, 1);
});

// ---- clamping / rejection ----------------------------------------------------

test('applyInterestOps: topic is a hard identity clamp; note is clamped tolerantly (both hard-cut here, a single long word)', () => {
  const items = applyInterestOps([], { add: [{ topic: 'x'.repeat(60), note: 'y'.repeat(200) }] }, opts({ topicChars: 5, noteChars: 8 }));
  assert.equal(items[0].topic.length, 5, 'identity fields never exceed their limit, tolerance or not');
  assert.equal(items[0].note.length, 10, '8 * the default tolerance 1.25');
});

test('applyInterestOps: an item with an empty topic (or whitespace-only) is rejected', () => {
  const items = applyInterestOps([], { add: [{ topic: '   ', note: 'orphan note' }, { topic: '', note: 'x' }] }, opts());
  assert.deepEqual(items, []);
});

test('applyInterestOps: a non-string topic/note is rejected/ignored gracefully', () => {
  const items = applyInterestOps([], { add: [{ topic: 42, note: {} }, { topic: 'OK', note: 7 }] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].topic, 'OK');
  assert.equal(items[0].note, '');
});

// ---- eviction: weight then age -----------------------------------------------

test('applyInterestOps: evicts the lowest weight first once over maxInterests', () => {
  const existing = stored([
    ['a', 5, '2026-01-01T00:00:00.000Z'],
    ['b', 1, '2026-01-02T00:00:00.000Z'],
    ['c', 3, '2026-01-03T00:00:00.000Z'],
  ]);
  const items = applyInterestOps(existing, { add: [{ topic: 'd', note: '' }] }, opts({ maxInterests: 3 }));
  assert.deepEqual(items.map((i) => i.topic).sort(), ['a', 'c', 'd']);
});

test('applyInterestOps: among equal weights, evicts the oldest lastSeen first', () => {
  const existing = stored([
    ['a', 3, '2026-01-01T00:00:00.000Z'],
    ['b', 3, '2026-01-05T00:00:00.000Z'],
    ['c', 3, '2026-01-03T00:00:00.000Z'],
  ]);
  const items = applyInterestOps(existing, {}, opts({ maxInterests: 2, seenAt: Date.parse('2026-01-05T00:00:00.000Z') }));
  assert.deepEqual(items.map((i) => i.topic).sort(), ['b', 'c']);
});

test('applyInterestOps: eviction runs even with no ops, self-healing an over-stuffed legacy profile', () => {
  const existing = stored([
    ['a', 1, '2026-01-01T00:00:00.000Z'],
    ['b', 1, '2026-01-02T00:00:00.000Z'],
    ['c', 1, '2026-01-03T00:00:00.000Z'],
  ]);
  const items = applyInterestOps(existing, undefined, opts({ maxInterests: 2 }));
  assert.equal(items.length, 2);
});

// ---- storage cap vs shown cap, and rank-driven eviction (the F27 defect) -----

test('applyInterestOps: the storage cap is max(maxInterestsStored, maxInterests) -- a smaller stored cap never wins', () => {
  const existing = stored([['a', 1, '2026-01-01T00:00:00.000Z'], ['b', 1, '2026-01-02T00:00:00.000Z']]);
  const items = applyInterestOps(existing, {}, opts({ maxInterests: 12, maxInterestsStored: 2 }));
  assert.equal(items.length, 2, 'stored cap floored at the shown cap (12), so 2 items are never touched');
});

test('applyInterestOps: with halfLifeDays, eviction drops the lowest RANK, not the lowest weight -- an ancient heavy item can be evicted before a light recent one', () => {
  const oldDate = '2021-01-01T00:00:00.000Z';
  const existing = stored([
    ['Ancient favorite', 10, oldDate], // heavy, but 5+ years cold
    ['b', 2, '2026-09-01T00:00:00.000Z'],
    ['c', 2, '2026-09-05T00:00:00.000Z'],
  ]);
  const items = applyInterestOps(
    existing,
    { add: [{ topic: 'New game', note: '' }] },
    opts({ maxInterests: 3, seenAt: Date.parse('2026-09-20T00:00:00.000Z'), halfLifeDays: 180 }),
  );
  assert.deepEqual(items.map((i) => i.topic).sort(), ['New game', 'b', 'c'], 'the ancient heavy item sinks below the recent ones and is evicted');
});

test('applyInterestOps: a newcomer survives in the unseen (stored-but-not-shown) tail instead of being evicted the moment it arrives', () => {
  // Twelve old, heavily confirmed interests -- exactly the shape of the reported
  // defect: with the OLD single-cap behaviour (maxInterests as the only, storage
  // cap) a 13th brand-new item at weight 1 would be the lightest item and would
  // be evicted in the very same call that added it, every time.
  const oldDate = '2021-01-01T00:00:00.000Z';
  const twelveOld = stored(Array.from({ length: 12 }, (_, i) => [`old-${i}`, 10, oldDate]));
  const items = applyInterestOps(
    twelveOld,
    { add: [{ topic: 'Brand new game', note: '' }] },
    opts({ maxInterests: 12, maxInterestsStored: 40, seenAt: Date.parse('2026-09-20T00:00:00.000Z'), halfLifeDays: 180 }),
  );
  assert.equal(items.length, 13, 'nothing is evicted: the storage cap (40) is far from full');
  const newcomer = items.find((i) => i.topic === 'Brand new game');
  assert.ok(newcomer, 'the newcomer survives even though it would be last by rank right now');
  assert.equal(newcomer.weight, 1);
});

test('applyInterestOps: repeated sightings let a stored-but-unseen item gather weight until it enters the shown top 12', () => {
  const oldDate = '2021-01-01T00:00:00.000Z';
  const twelveOld = stored(Array.from({ length: 12 }, (_, i) => [`old-${i}`, 10, oldDate]));
  const day1 = Date.parse('2026-09-01T00:00:00.000Z');
  const day2 = Date.parse('2026-09-06T00:00:00.000Z'); // past the 12h confirm gap
  const day3 = Date.parse('2026-09-11T00:00:00.000Z');

  let items = applyInterestOps(twelveOld, { add: [{ topic: 'Brand new game', note: '' }] }, opts({ maxInterests: 12, maxInterestsStored: 40, seenAt: day1, halfLifeDays: 180 }));
  items = applyInterestOps(items, { seen: ['Brand new game'] }, opts({ maxInterests: 12, maxInterestsStored: 40, seenAt: day2, halfLifeDays: 180 }));
  items = applyInterestOps(items, { seen: ['Brand new game'] }, opts({ maxInterests: 12, maxInterestsStored: 40, seenAt: day3, halfLifeDays: 180 }));

  const newcomer = items.find((i) => i.topic === 'Brand new game');
  assert.equal(newcomer.weight, 3, 'confirmed after enough well-spaced sightings');

  const shown = topByRank(items, 12, 180);
  assert.ok(
    shown.includes(newcomer),
    'a frequently and recently confirmed newcomer outranks the five-year-old heavy items and makes the shown top 12',
  );
});

test('applyInterestOps: no cap when maxInterests is not an integer', () => {
  const existing = stored([['a', 1, 'x'], ['b', 1, 'y']]);
  const items = applyInterestOps(existing, {}, { topicChars: 40, noteChars: 120, seenAt: NOW });
  assert.equal(items.length, 2);
});

// ---- garbage tolerance --------------------------------------------------------

test('applyInterestOps: garbage ops (null, a string, an array, wrong-shaped add/update/seen/remove) never throw and change nothing', () => {
  const existing = stored([['a', 1, 'x']]);
  for (const garbage of [
    null,
    undefined,
    'not an object',
    42,
    [1, 2, 3],
    { add: 'nope' },
    { add: [null, 42, 'x'] },
    { seen: [null, 42, {}] },
    { remove: [null, 42] },
  ]) {
    const items = applyInterestOps(existing, garbage, opts());
    assert.equal(items.length, 1, `garbage ${JSON.stringify(garbage)} must not throw or add anything`);
  }
});

test('applyInterestOps: existing undefined/non-array (a profile written before this feature existed) is tolerated', () => {
  const items = applyInterestOps(undefined, { add: [{ topic: 'first ever interest' }] }, opts());
  assert.equal(items.length, 1);
});

test('applyInterestOps: does not mutate the existing array or its items', () => {
  const existing = stored([['a', 1, 'x']]);
  const copy = existing.map((i) => ({ ...i }));
  applyInterestOps(existing, { add: [{ topic: 'a', note: 'new note' }] }, opts());
  assert.deepEqual(existing, copy);
});

// ---- isConfirmed / isStale ----------------------------------------------------

test('isConfirmed: weight at or above confirmAfter (default 2) is confirmed', () => {
  assert.equal(isConfirmed({ weight: 2 }), true);
  assert.equal(isConfirmed({ weight: 1 }), false);
  assert.equal(isConfirmed({ weight: 5 }, 3), true);
  assert.equal(isConfirmed({ weight: 2 }, 3), false);
});

test('isConfirmed: a missing weight counts as 0', () => {
  assert.equal(isConfirmed({}), false);
});

test('isStale: older than staleDays is stale, within it is not', () => {
  const item = { lastSeen: new Date(NOW - 100 * DAY).toISOString() };
  assert.equal(isStale(item, NOW, 90), true);
  assert.equal(isStale({ lastSeen: new Date(NOW - 10 * DAY).toISOString() }, NOW, 90), false);
});

test('isStale: an unknown lastSeen is never stale', () => {
  assert.equal(isStale({ lastSeen: null }, NOW, 90), false);
  assert.equal(isStale({}, NOW, 90), false);
});

test('isStale: staleDays not a positive number means never stale', () => {
  const item = { lastSeen: new Date(NOW - 1000 * DAY).toISOString() };
  assert.equal(isStale(item, NOW, 0), false);
  assert.equal(isStale(item, NOW, -5), false);
  assert.equal(isStale(item, NOW, undefined), false);
  assert.equal(isStale(item, NOW, NaN), false);
});

// ---- migrateInterests: legacy string ------------------------------------------

test('migrateInterests: a plain comma-separated string with no notes', () => {
  const items = migrateInterests('Chess, Anime, Cooking');
  assert.deepEqual(items.map((i) => i.topic), ['Chess', 'Anime', 'Cooking']);
  assert.ok(items.every((i) => i.note === '' && i.weight === 1));
});

test('migrateInterests: "topic (note)" segments', () => {
  const items = migrateInterests('Chess (weekly club), Anime (mostly shonen)');
  assert.deepEqual(items, [
    { topic: 'Chess', note: 'weekly club', weight: 1, firstSeen: null, lastSeen: null },
    { topic: 'Anime', note: 'mostly shonen', weight: 1, firstSeen: null, lastSeen: null },
  ]);
});

test('migrateInterests: a comma inside a note does not split the item (top-level commas only)', () => {
  const items = migrateInterests('Board games (Catan, Carcassonne, weekly), Chess');
  assert.deepEqual(items.map((i) => i.topic), ['Board games', 'Chess']);
  assert.equal(items[0].note, 'Catan, Carcassonne, weekly');
});

test('migrateInterests: nested parentheses inside a note are kept literally', () => {
  const items = migrateInterests('Fishing (caught a bass (a big one) last week)');
  assert.equal(items.length, 1);
  assert.equal(items[0].topic, 'Fishing');
  assert.equal(items[0].note, 'caught a bass (a big one) last week');
});

test('migrateInterests: the glued-dump shape (many comma-separated items, some with notes) splits cleanly', () => {
  const dump = 'Game A (a remark about game A), Game B, Cooking (likes pasta), Anime, Board games (Catan)';
  const items = migrateInterests(dump);
  assert.deepEqual(items.map((i) => i.topic), ['Game A', 'Game B', 'Cooking', 'Anime', 'Board games']);
  assert.equal(items[0].note, 'a remark about game A');
  assert.equal(items[1].note, '');
  assert.equal(items[2].note, 'likes pasta');
  assert.equal(items[4].note, 'Catan');
});

test('migrateInterests: blank/whitespace-only string yields []', () => {
  assert.deepEqual(migrateInterests(''), []);
  assert.deepEqual(migrateInterests('   '), []);
});

test('migrateInterests: a stray empty segment (double comma) is dropped', () => {
  const items = migrateInterests('Chess,, Anime');
  assert.deepEqual(items.map((i) => i.topic), ['Chess', 'Anime']);
});

// ---- migrateInterests: array pass-through -------------------------------------

test('migrateInterests: an array of well-formed items passes through validated', () => {
  const items = migrateInterests([{ topic: 'Chess', note: 'plays weekly', weight: 4, firstSeen: 'a', lastSeen: 'b' }]);
  assert.deepEqual(items, [{ topic: 'Chess', note: 'plays weekly', weight: 4, firstSeen: 'a', lastSeen: 'b' }]);
});

test('migrateInterests: array items missing optional fields get sane defaults', () => {
  const items = migrateInterests([{ topic: 'Chess' }]);
  assert.deepEqual(items, [{ topic: 'Chess', note: '', weight: 1, firstSeen: null, lastSeen: null }]);
});

test('migrateInterests: garbage entries inside an array are dropped, valid ones survive', () => {
  const items = migrateInterests([null, 42, 'garbage', { topic: '' }, { note: 'no topic at all' }, { topic: 'OK' }]);
  assert.deepEqual(items, [{ topic: 'OK', note: '', weight: 1, firstSeen: null, lastSeen: null }]);
});

// ---- migrateInterests: anything else -------------------------------------------

test('migrateInterests: null/undefined/number/object all yield []', () => {
  assert.deepEqual(migrateInterests(null), []);
  assert.deepEqual(migrateInterests(undefined), []);
  assert.deepEqual(migrateInterests(42), []);
  assert.deepEqual(migrateInterests({ not: 'an array or string' }), []);
});

// ---- F31 addendum: a trailing "(qualifier)" is stripped off the topic ---------

test('stripTrailingParenthetical: strips one trailing parenthetical, trimmed', () => {
  assert.deepEqual(stripTrailingParenthetical('anime (bleak/hopeless)'), { topic: 'anime', qualifier: 'bleak/hopeless' });
  assert.deepEqual(stripTrailingParenthetical('  anime   ( bleak )  '), { topic: 'anime', qualifier: 'bleak' });
});

test('stripTrailingParenthetical: a topic that is ONLY a parenthetical is left alone', () => {
  assert.deepEqual(stripTrailingParenthetical('(just this)'), { topic: '(just this)', qualifier: '' });
});

test('stripTrailingParenthetical: a non-trailing parenthesis (text follows the closing bracket) is left alone', () => {
  assert.deepEqual(stripTrailingParenthetical('anime (shonen) fan'), { topic: 'anime (shonen) fan', qualifier: '' });
});

test('stripTrailingParenthetical: unbalanced parentheses are left alone', () => {
  assert.deepEqual(stripTrailingParenthetical('anime (bleak'), { topic: 'anime (bleak', qualifier: '' });
  assert.deepEqual(stripTrailingParenthetical('anime bleak)'), { topic: 'anime bleak)', qualifier: '' });
});

test('stripTrailingParenthetical: an empty parenthetical is left alone', () => {
  assert.deepEqual(stripTrailingParenthetical('anime ()'), { topic: 'anime ()', qualifier: '' });
});

test('stripTrailingParenthetical: nested parentheses -- the outermost trailing group is stripped', () => {
  assert.deepEqual(stripTrailingParenthetical('anime (bleak (very))'), { topic: 'anime', qualifier: 'bleak (very)' });
});

test('stripTrailingParenthetical: text with no parenthesis at all is untouched', () => {
  assert.deepEqual(stripTrailingParenthetical('anime'), { topic: 'anime', qualifier: '' });
});

test('applyInterestOps: add strips a trailing parenthetical off the topic, moving it into an empty note', () => {
  const items = applyInterestOps([], { add: [{ topic: 'anime (bleak/hopeless)', note: '' }] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].topic, 'anime');
  assert.equal(items[0].note, 'bleak/hopeless');
});

test('applyInterestOps: add does not overwrite a non-empty incoming note with the stripped qualifier', () => {
  const items = applyInterestOps([], { add: [{ topic: 'anime (bleak/hopeless)', note: 'watches subbed only' }] }, opts());
  assert.equal(items[0].topic, 'anime');
  assert.equal(items[0].note, 'watches subbed only');
});

test('applyInterestOps: add leaves the topic whole when the parenthesis is not trailing or the topic is only a parenthetical', () => {
  const a = applyInterestOps([], { add: [{ topic: 'anime (shonen) fan', note: '' }] }, opts());
  assert.equal(a[0].topic, 'anime (shonen) fan');
  const b = applyInterestOps([], { add: [{ topic: '(just this)', note: '' }] }, opts());
  assert.equal(b[0].topic, '(just this)');
});

test('applyInterestOps: a sighting of "topic (qualifier)" is a sighting of the already-stored plain topic; the stripped qualifier never overwrites a real stored note', () => {
  const existing = [{ topic: 'anime', note: 'watches a lot', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { add: [{ topic: 'anime (bleak/hopeless)', note: '' }] }, opts());
  assert.equal(items.length, 1, 'no near-duplicate topic created');
  assert.equal(items[0].topic, 'anime');
  assert.equal(items[0].weight, 2);
  // the incoming note was empty, but the stored item already had a real note -- the qualifier
  // ("bleak/hopeless") is discarded, not written over it (lead review fix).
  assert.equal(items[0].note, 'watches a lot');
});

test('applyInterestOps: the stripped qualifier fills the note only when the stored item has none yet', () => {
  const existing = [{ topic: 'anime', note: '', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { add: [{ topic: 'anime (bleak/hopeless)', note: '' }] }, opts());
  assert.equal(items[0].note, 'bleak/hopeless');
});

test('applyInterestOps: a genuinely non-empty incoming note still replaces the stored one, qualifier or not', () => {
  const existing = [{ topic: 'anime', note: 'watches a lot', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { add: [{ topic: 'anime (bleak/hopeless)', note: 'now watches only dark shows' }] }, opts());
  assert.equal(items[0].note, 'now watches only dark shows');
});

test('applyInterestOps: seen strips the qualifier before matching', () => {
  const existing = [{ topic: 'anime', note: '', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { seen: ['anime (bleak/hopeless)'] }, opts());
  assert.equal(items.length, 1);
  assert.equal(items[0].weight, 2);
});

test('applyInterestOps: remove matches by the stripped plain topic', () => {
  const existing = [
    { topic: 'Anime', note: '', weight: 3, firstSeen: 'a', lastSeen: 'a' },
    { topic: 'Chess', note: '', weight: 1, firstSeen: 'a', lastSeen: 'a' },
  ];
  const items = applyInterestOps(existing, { remove: ['anime (bleak/hopeless)'] }, opts());
  assert.deepEqual(items.map((i) => i.topic), ['Chess']);
});

test('applyInterestOps: a legacy stored topic that still carries the qualifier is rewritten to plain when a matching op arrives, and sighted as the same item', () => {
  const existing = [{ topic: 'Anime (bleak/hopeless)', note: 'watches subbed', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { seen: ['anime'] }, opts());
  assert.equal(items.length, 1, 'still one item, not two');
  assert.equal(items[0].topic, 'Anime', 'rewritten to the plain form');
  assert.equal(items[0].weight, 2, 'treated as a sighting of the same item');
  assert.equal(items[0].note, 'watches subbed', 'the note carries over untouched');
});

test('applyInterestOps: an untargeted legacy parenthetical topic is left as stored', () => {
  const existing = [{ topic: 'Anime (bleak/hopeless)', note: '', weight: 1, firstSeen: 'a', lastSeen: null }];
  const items = applyInterestOps(existing, { add: [{ topic: 'Chess', note: '' }] }, opts());
  assert.ok(items.some((i) => i.topic === 'Anime (bleak/hopeless)'), 'no op targeted it, so it is left alone');
});

test('applyInterestOps: two stored variants (plain + parenthetical) collapse into one when an op targets the plain form', () => {
  const existing = [
    { topic: 'Anime', note: '', weight: 3, firstSeen: '2025-01-01T00:00:00.000Z', lastSeen: '2025-06-01T00:00:00.000Z' },
    { topic: 'Anime (bleak/hopeless)', note: 'likes dark stories', weight: 5, firstSeen: '2024-01-01T00:00:00.000Z', lastSeen: '2025-08-01T00:00:00.000Z' },
  ];
  const items = applyInterestOps(existing, { seen: ['anime'] }, opts({ seenAt: Date.parse('2026-01-01T00:00:00.000Z') }));
  assert.equal(items.length, 1, 'the two variants collapse into one');
  assert.equal(items[0].topic, 'Anime');
  assert.equal(items[0].weight, 6, 'the heavier stored weight (5), bumped once by this sighting');
  assert.equal(items[0].firstSeen, '2024-01-01T00:00:00.000Z', 'the earliest firstSeen of the two');
  assert.equal(items[0].note, 'likes dark stories', 'the note of the heavier stored variant survives the merge');
});

// ---- lead review fix: the stripped qualifier must never clobber a real stored note ----

test('F31 review fix: reproduced case -- collapsing two stored variants then adding "Topic (qualifier)" keeps the real note, drops the qualifier', () => {
  const existing = [
    { topic: 'anime', note: 'watches', weight: 2, firstSeen: 'a', lastSeen: '2025-01-01T00:00:00.000Z' },
    { topic: 'anime (bleak/hopeless)', note: 'looks for heavy shows', weight: 3, firstSeen: 'a', lastSeen: '2025-06-01T00:00:00.000Z' },
  ];
  const items = applyInterestOps(
    existing,
    { add: [{ topic: 'Anime (shonen)', note: '' }] },
    opts({ seenAt: Date.parse('2026-01-01T00:00:00.000Z') }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].topic, 'anime');
  assert.equal(items[0].note, 'looks for heavy shows', 'the heavier variant\'s note (from the collapse) is kept -- "shonen" is discarded');
});

test('applyInterestOps: collapsing two variants keeps the note of the HEAVIER one, regardless of storage order', () => {
  // the lighter item ('anime', weight 2) is stored first, has its own note -- the heavier one
  // ('anime (x)', weight 5) must still win, unlike a plain first-wins/order-based pick.
  const existing = [
    { topic: 'anime', note: 'a lighter note', weight: 2, firstSeen: 'a', lastSeen: '2025-01-01T00:00:00.000Z' },
    { topic: 'anime (x)', note: 'a heavier note', weight: 5, firstSeen: 'a', lastSeen: '2025-02-01T00:00:00.000Z' },
  ];
  const items = applyInterestOps(existing, { seen: ['anime'] }, opts());
  assert.equal(items[0].note, 'a heavier note');
});

test('applyInterestOps: collapsing two EQUAL-weight variants keeps the note of the one with the newer lastSeen', () => {
  const existing = [
    { topic: 'anime', note: 'older note', weight: 3, firstSeen: 'a', lastSeen: '2025-01-01T00:00:00.000Z' },
    { topic: 'anime (x)', note: 'newer note', weight: 3, firstSeen: 'a', lastSeen: '2025-06-01T00:00:00.000Z' },
  ];
  const items = applyInterestOps(existing, { seen: ['anime'] }, opts());
  assert.equal(items[0].note, 'newer note');
});

test('applyInterestOps: collapsing falls back to the other note when the heavier/newer variant has none', () => {
  const existing = [
    { topic: 'anime', note: 'the only note here', weight: 2, firstSeen: 'a', lastSeen: '2025-01-01T00:00:00.000Z' },
    { topic: 'anime (x)', note: '', weight: 5, firstSeen: 'a', lastSeen: '2025-06-01T00:00:00.000Z' },
  ];
  const items = applyInterestOps(existing, { seen: ['anime'] }, opts());
  assert.equal(items[0].note, 'the only note here', 'the heavier variant had no note, so the lighter one\'s note is kept');
});
