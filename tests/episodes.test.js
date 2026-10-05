// Tests for src/memory/episodes.js: mergeEpisodes (validation, deduplication,
// eviction) and sortEpisodesForDisplay (rendering order). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEpisodes, sortEpisodesForDisplay } from '../src/memory/episodes.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21

function opts(overrides = {}) {
  return { maxEpisodes: 20, maxNew: 3, now: NOW, ...overrides };
}

// ---- validation / clamping -------------------------------------------------

test('mergeEpisodes: rejects an episode with no usable "what"', () => {
  const result = mergeEpisodes([], [{ what: '   ' }, { quote: 'no what at all' }], opts());
  assert.equal(result.added, 0);
  assert.deepEqual(result.episodes, []);
});

test('mergeEpisodes: trims and clamps what/feeling tolerantly, quote as a hard verbatim cut', () => {
  const result = mergeEpisodes([], [{ what: 'x'.repeat(300), quote: 'y'.repeat(200), feeling: 'z'.repeat(200) }], opts());
  assert.equal(result.episodes[0].what.length, 250, '200 * the default tolerance 1.25');
  assert.equal(result.episodes[0].quote.length, 120, 'quote is always a hard cut, tolerance or not');
  assert.equal(result.episodes[0].feeling.length, 150, '120 * the default tolerance 1.25');
});

test('mergeEpisodes: quote may be empty', () => {
  const result = mergeEpisodes([], [{ what: 'said hello' }], opts());
  assert.equal(result.episodes[0].quote, '');
});

test('mergeEpisodes: weight is an integer clamped 1-5, default 3', () => {
  const result = mergeEpisodes(
    [],
    [
      { what: 'a', weight: 0 },
      { what: 'b', weight: 99 },
      { what: 'c', weight: 2.5 },
      { what: 'd' },
      { what: 'e', weight: 4 },
    ],
    opts({ maxNew: 10 }),
  );
  const byWhat = Object.fromEntries(result.episodes.map((e) => [e.what, e.weight]));
  assert.equal(byWhat.a, 1);
  assert.equal(byWhat.b, 5);
  assert.equal(byWhat.c, 3, 'a non-integer weight falls back to the default');
  assert.equal(byWhat.d, 3);
  assert.equal(byWhat.e, 4);
});

test('mergeEpisodes: an invalid or missing date falls back to today (UTC)', () => {
  const result = mergeEpisodes(
    [],
    [
      { what: 'a', date: '2025-01-01' },
      { what: 'b', date: 'not-a-date' },
      { what: 'c', date: '2025/01/01' },
      { what: 'd' },
    ],
    opts({ maxNew: 10 }),
  );
  const byWhat = Object.fromEntries(result.episodes.map((e) => [e.what, e.date]));
  assert.equal(byWhat.a, '2025-01-01');
  assert.equal(byWhat.b, '2026-09-21');
  assert.equal(byWhat.c, '2026-09-21');
  assert.equal(byWhat.d, '2026-09-21');
});

test('mergeEpisodes: every accepted episode gets addedAt from `now`', () => {
  const result = mergeEpisodes([], [{ what: 'a' }], opts());
  assert.equal(result.episodes[0].addedAt, new Date(NOW).toISOString());
});

test('mergeEpisodes: non-array or empty incoming is a no-op', () => {
  const existing = [{ date: '2026-01-01', what: 'x', quote: '', feeling: '', weight: 3, addedAt: 'a' }];
  assert.deepEqual(mergeEpisodes(existing, null, opts()).episodes, existing);
  assert.deepEqual(mergeEpisodes(existing, [], opts()).episodes, existing);
  assert.deepEqual(mergeEpisodes(existing, 'garbage', opts()).episodes, existing);
});

test('mergeEpisodes: tolerates a legacy profile with no episodes field at all', () => {
  const result = mergeEpisodes(undefined, [{ what: 'first ever episode' }], opts());
  assert.equal(result.added, 1);
  assert.equal(result.episodes.length, 1);
});

// ---- maxNew -----------------------------------------------------------------

test('mergeEpisodes: takes at most maxNew per call, even with more valid incoming', () => {
  const incoming = [{ what: 'a' }, { what: 'b' }, { what: 'c' }, { what: 'd' }];
  const result = mergeEpisodes([], incoming, opts({ maxNew: 2 }));
  assert.equal(result.added, 2);
  assert.deepEqual(result.episodes.map((e) => e.what), ['a', 'b']);
});

// ---- duplicate rules ----------------------------------------------------------

test('mergeEpisodes: drops a duplicate with the same date and normalized "what"', () => {
  const existing = [{ date: '2026-01-01', what: 'Said Hello  loudly', quote: '', feeling: '', weight: 3, addedAt: 'a' }];
  const result = mergeEpisodes(existing, [{ date: '2026-01-01', what: 'said hello loudly' }], opts());
  assert.equal(result.added, 0);
  assert.equal(result.episodes.length, 1);
});

test('mergeEpisodes: same "what" on a different date is not a duplicate', () => {
  const existing = [{ date: '2026-01-01', what: 'said hello', quote: '', feeling: '', weight: 3, addedAt: 'a' }];
  const result = mergeEpisodes(existing, [{ date: '2026-01-02', what: 'said hello' }], opts());
  assert.equal(result.added, 1);
});

test('mergeEpisodes: drops a duplicate with an identical non-empty quote, even on another date/what', () => {
  const existing = [{ date: '2026-01-01', what: 'promised something', quote: 'I will never leave', feeling: '', weight: 3, addedAt: 'a' }];
  const result = mergeEpisodes(existing, [{ date: '2026-05-05', what: 'a different framing', quote: 'I will never leave' }], opts());
  assert.equal(result.added, 0);
});

test('mergeEpisodes: two empty quotes never count as a duplicate by themselves', () => {
  const existing = [{ date: '2026-01-01', what: 'first thing', quote: '', feeling: '', weight: 3, addedAt: 'a' }];
  const result = mergeEpisodes(existing, [{ date: '2026-02-02', what: 'second thing', quote: '' }], opts());
  assert.equal(result.added, 1);
});

// ---- eviction order: weight then age ----------------------------------------

function stored(list) {
  return list.map(([date, what, weight, addedAt]) => ({ date, what, quote: '', feeling: '', weight, addedAt }));
}

test('mergeEpisodes: evicts the lowest weight first once over maxEpisodes', () => {
  const existing = stored([
    ['2026-01-01', 'a', 5, '2026-01-01T00:00:00.000Z'],
    ['2026-01-02', 'b', 1, '2026-01-02T00:00:00.000Z'],
    ['2026-01-03', 'c', 3, '2026-01-03T00:00:00.000Z'],
  ]);
  const result = mergeEpisodes(existing, [{ what: 'd', weight: 4 }], opts({ maxEpisodes: 3 }));
  assert.deepEqual(result.episodes.map((e) => e.what), ['a', 'c', 'd']);
});

test('mergeEpisodes: among equal weights, evicts the oldest first', () => {
  const existing = stored([
    ['2026-01-01', 'a', 3, '2026-01-01T00:00:00.000Z'],
    ['2026-01-05', 'b', 3, '2026-01-05T00:00:00.000Z'],
    ['2026-01-03', 'c', 3, '2026-01-03T00:00:00.000Z'],
  ]);
  const result = mergeEpisodes(existing, [{ what: 'd', weight: 3 }], opts({ maxEpisodes: 3 }));
  // 'a' (2026-01-01) is the oldest of the tied weight-3 entries -> evicted first.
  assert.deepEqual(result.episodes.map((e) => e.what), ['b', 'c', 'd']);
});

test('mergeEpisodes: eviction never reorders or rewrites the surviving entries', () => {
  const existing = stored([
    ['2026-01-01', 'a', 5, '2026-01-01T00:00:00.000Z'],
    ['2026-01-02', 'b', 1, '2026-01-02T00:00:00.000Z'],
  ]);
  const result = mergeEpisodes(existing, [{ what: 'c', weight: 5 }], opts({ maxEpisodes: 2 }));
  assert.deepEqual(result.episodes, [existing[0], { date: '2026-09-21', what: 'c', quote: '', feeling: '', weight: 5, addedAt: new Date(NOW).toISOString() }]);
});

test('mergeEpisodes: eviction can drop several at once to get back under the cap', () => {
  const existing = stored([
    ['2026-01-01', 'a', 1, '2026-01-01T00:00:00.000Z'],
    ['2026-01-02', 'b', 1, '2026-01-02T00:00:00.000Z'],
    ['2026-01-03', 'c', 5, '2026-01-03T00:00:00.000Z'],
  ]);
  const result = mergeEpisodes(existing, [{ what: 'd', weight: 1 }, { what: 'e', weight: 1 }], opts({ maxEpisodes: 3, maxNew: 2 }));
  assert.equal(result.episodes.length, 3);
  assert.ok(result.episodes.some((e) => e.what === 'c'), 'the heaviest entry always survives');
});

// ---- keepNewest: the newest K are never evicted on arrival --------------------

/** `count` stored weight-`weight` moments, one per day of 2026-01, added on their own day. */
function heavyList(count, weight = 5) {
  return stored(
    Array.from({ length: count }, (_, i) => {
      const day = `2026-01-${String(i + 1).padStart(2, '0')}`;
      return [day, `στιγμή ${i + 1}`, weight, `${day}T00:00:00.000Z`];
    }),
  );
}

test('mergeEpisodes: a light new moment survives a full list of heavier old ones', () => {
  const existing = heavyList(20, 4);
  const result = mergeEpisodes(existing, [{ what: 'ένα μικρό αστείο', weight: 1 }], opts({ keepNewest: 5 }));
  assert.equal(result.added, 1);
  assert.equal(result.episodes.length, 20);
  assert.equal(result.episodes.at(-1).what, 'ένα μικρό αστείο', 'the light newcomer is kept, appended last');
  assert.ok(!result.episodes.some((e) => e.what === 'στιγμή 1'), 'the oldest of the heavier rest goes instead');
  assert.deepEqual(
    result.episodes.slice(0, 19).map((e) => e.what),
    existing.slice(1).map((e) => e.what),
    'survivors keep their order',
  );
});

test('mergeEpisodes: a light moment is safe until keepNewest newer ones are stored, then goes by weight', () => {
  const day = 24 * 60 * 60 * 1000;
  let list = mergeEpisodes(heavyList(20), [{ what: 'ελαφριά στιγμή', weight: 1 }], opts({ keepNewest: 5 })).episodes;
  for (let n = 1; n <= 4; n += 1) {
    list = mergeEpisodes(list, [{ what: `νεότερη ${n}`, weight: 5 }], opts({ keepNewest: 5, now: NOW + n * day })).episodes;
    assert.ok(list.some((e) => e.what === 'ελαφριά στιγμή'), `still kept with ${n} newer moment(s) stored`);
    assert.equal(list.length, 20);
  }
  list = mergeEpisodes(list, [{ what: 'νεότερη 5', weight: 5 }], opts({ keepNewest: 5, now: NOW + 5 * day })).episodes;
  assert.ok(!list.some((e) => e.what === 'ελαφριά στιγμή'), 'the fifth newer moment ends the exemption: the lightest goes');
  assert.equal(list.length, 20);
});

test('mergeEpisodes: the newest K are exempt, the lightest and oldest of the rest go', () => {
  const existing = stored([
    ['2026-01-01', 'a', 2, '2026-01-01T00:00:00.000Z'],
    ['2026-01-02', 'b', 1, '2026-01-02T00:00:00.000Z'],
    ['2026-01-03', 'c', 2, '2026-01-03T00:00:00.000Z'],
    ['2026-01-04', 'd', 3, '2026-01-04T00:00:00.000Z'],
    ['2026-01-05', 'e', 1, '2026-01-05T00:00:00.000Z'],
  ]);
  const result = mergeEpisodes(existing, [{ what: 'f', weight: 1 }, { what: 'g', weight: 2 }], opts({ maxEpisodes: 5, keepNewest: 3 }));
  // Exempt: g, f (this call) and e (the newest stored), light as they are. Of a, b, c, d:
  // b goes as the lightest, then a as the older of the two weight-2 entries.
  assert.deepEqual(result.episodes.map((e) => e.what), ['c', 'd', 'e', 'f', 'g']);
});

test('mergeEpisodes: with keepNewest, a later position in one call counts as newer', () => {
  const existing = stored([
    ['2026-01-01', 'old 1', 5, '2026-01-01T00:00:00.000Z'],
    ['2026-01-02', 'old 2', 5, '2026-01-02T00:00:00.000Z'],
  ]);
  const incoming = [
    { what: 'w', weight: 2 },
    { what: 'x', weight: 2 },
    { what: 'y', weight: 1 },
    { what: 'z', weight: 1 },
  ];
  const result = mergeEpisodes(existing, incoming, opts({ maxEpisodes: 4, maxNew: 4, keepNewest: 2 }));
  // One stamp for the whole call: y and z, the last two, are the newest and stay although lighter.
  assert.deepEqual(result.episodes.map((e) => e.what), ['old 1', 'old 2', 'y', 'z']);
});

test("mergeEpisodes: a call's own moments are the newest even when stored stamps are later than now", () => {
  // A caller whose clock is behind the store (the warmup's person run stamps with the member's
  // last sampled message): 17 heavy moments from weeks ago, 3 stored at 10:10, the call at 10:00.
  const existing = [
    ...heavyList(17),
    ...stored([
      ['2026-09-21', 'ροή 1', 4, '2026-09-21T10:10:00.000Z'],
      ['2026-09-21', 'ροή 2', 4, '2026-09-21T10:10:00.000Z'],
      ['2026-09-21', 'ροή 3', 4, '2026-09-21T10:10:00.000Z'],
    ]),
  ];
  const incoming = [
    { what: 'Α', weight: 1 },
    { what: 'Β', weight: 3 },
    { what: 'Γ', weight: 3 },
  ];
  const result = mergeEpisodes(existing, incoming, opts({ keepNewest: 5, now: Date.UTC(2026, 8, 21, 10, 0, 0) }));
  assert.equal(result.added, 3);
  const whats = result.episodes.map((e) => e.what);
  assert.equal(whats.length, 20);
  assert.deepEqual(whats.slice(-3), ['Α', 'Β', 'Γ'], 'all three arrivals stay, the light one included');
  // Exempt: the three arrivals, then the two latest stamps stored (ροή 3, ροή 2). Of the rest,
  // ροή 1 goes as the lightest, then the two oldest heavy moments.
  assert.ok(!whats.includes('ροή 1'));
  assert.ok(!whats.includes('στιγμή 1') && !whats.includes('στιγμή 2'));
  assert.equal(result.episodes.at(-1).addedAt, '2026-09-21T10:00:00.000Z', "arrivals keep the caller's stamp");
});

test('mergeEpisodes: with keepNewest, an entry with no addedAt counts as the oldest added', () => {
  const existing = [
    { date: '2026-01-05', what: 'legacy', quote: '', feeling: '', weight: 1 },
    ...stored([
      ['2026-01-01', 'dated', 1, '2026-02-01T00:00:00.000Z'],
      ['2026-01-02', 'heavy', 5, '2026-01-02T00:00:00.000Z'],
    ]),
  ];
  const result = mergeEpisodes(existing, [{ what: 'new', weight: 5 }], opts({ maxEpisodes: 3, keepNewest: 2 }));
  // Exempt: 'new' and 'dated' (the latest addedAt stored); 'legacy' has none and goes.
  assert.deepEqual(result.episodes.map((e) => e.what), ['dated', 'heavy', 'new']);
  const plain = mergeEpisodes(existing, [{ what: 'new', weight: 5 }], opts({ maxEpisodes: 3 }));
  // Without keepNewest, 'dated' is the older of the two weight-1 entries by date and goes.
  assert.deepEqual(plain.episodes.map((e) => e.what), ['legacy', 'heavy', 'new']);
});

test('mergeEpisodes: keepNewest 0 keeps eviction by weight then age', () => {
  const existing = heavyList(20);
  for (const keep of [0, undefined]) {
    const result = mergeEpisodes(existing, [{ what: 'ελαφριά στιγμή', weight: 1 }], opts({ keepNewest: keep }));
    assert.deepEqual(result.episodes, existing, `keepNewest ${keep}: the light newcomer is evicted on arrival`);
    assert.equal(result.added, 1);
  }
  const tied = mergeEpisodes(heavyList(20, 3), [{ what: 'ίδιο βάρος', weight: 3 }], opts({ keepNewest: 0 }));
  assert.ok(!tied.episodes.some((e) => e.what === 'στιγμή 1'), 'among equal weights the oldest goes');
});

test('mergeEpisodes: keepNewest at or above maxEpisodes is clamped to maxEpisodes - 1', () => {
  const existing = stored([
    ['2026-01-01', 'a', 5, '2026-01-01T00:00:00.000Z'],
    ['2026-01-02', 'b', 1, '2026-01-02T00:00:00.000Z'],
    ['2026-01-03', 'c', 5, '2026-01-03T00:00:00.000Z'],
  ]);
  for (const keep of [2, 3, 99, Infinity]) {
    const result = mergeEpisodes(existing, [{ what: 'd', weight: 5 }], opts({ maxEpisodes: 3, keepNewest: keep }));
    // K = 2: d and c are exempt; of a and b the lighter one (b) goes, never the cap overrun.
    assert.deepEqual(result.episodes.map((e) => e.what), ['a', 'c', 'd'], `keepNewest ${keep}`);
  }
});

test('mergeEpisodes: a negative or non-numeric keepNewest counts as 0', () => {
  const existing = heavyList(20);
  for (const keep of [-3, Number.NaN, '5', null, {}]) {
    const result = mergeEpisodes(existing, [{ what: 'ελαφριά στιγμή', weight: 1 }], opts({ keepNewest: keep }));
    assert.deepEqual(result.episodes, existing, `keepNewest ${String(keep)}`);
  }
});

test('mergeEpisodes: keepNewest under the cap changes nothing', () => {
  const existing = heavyList(3);
  const result = mergeEpisodes(existing, [{ what: 'νέα', weight: 1 }], opts({ keepNewest: 5 }));
  assert.deepEqual(result.episodes.map((e) => e.what), ['στιγμή 1', 'στιγμή 2', 'στιγμή 3', 'νέα']);
});

// ---- sortEpisodesForDisplay ---------------------------------------------------

test('sortEpisodesForDisplay: heaviest weight first', () => {
  const episodes = stored([
    ['2026-01-01', 'light', 1, 'a'],
    ['2026-01-01', 'heavy', 5, 'b'],
  ]);
  assert.deepEqual(sortEpisodesForDisplay(episodes).map((e) => e.what), ['heavy', 'light']);
});

test('sortEpisodesForDisplay: among equal weights, newest (by date) first', () => {
  const episodes = stored([
    ['2026-01-01', 'older', 3, 'a'],
    ['2026-03-01', 'newer', 3, 'b'],
  ]);
  assert.deepEqual(sortEpisodesForDisplay(episodes).map((e) => e.what), ['newer', 'older']);
});

test('sortEpisodesForDisplay: does not mutate its input', () => {
  const episodes = stored([
    ['2026-01-01', 'a', 1, 'x'],
    ['2026-01-02', 'b', 5, 'y'],
  ]);
  const copy = episodes.map((e) => ({ ...e }));
  sortEpisodesForDisplay(episodes);
  assert.deepEqual(episodes, copy);
});
