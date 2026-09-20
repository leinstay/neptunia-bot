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

test('mergeEpisodes: trims and clamps what/quote/feeling to their max lengths', () => {
  const result = mergeEpisodes([], [{ what: 'x'.repeat(300), quote: 'y'.repeat(200), feeling: 'z'.repeat(200) }], opts());
  assert.equal(result.episodes[0].what.length, 200);
  assert.equal(result.episodes[0].quote.length, 120);
  assert.equal(result.episodes[0].feeling.length, 120);
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
