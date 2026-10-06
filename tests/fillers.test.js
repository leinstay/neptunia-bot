// Tests for src/behavior/fillers.js: the filler guard's pure side -- the entry
// syntax, which fillers a text holds, which still rest, the use stamp, the
// ranked list with pinned entries, the learning from variety patterns, the
// pattern judge's block and answer, the parse of the rewrite and the
// persona's own message counter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FILLERS_DEFAULTS,
  PATTERN_CHECK_DEFAULTS,
  applyReword,
  evictFillers,
  fillerFromWord,
  fillerKey,
  fillersOnCooldown,
  fillersSettings,
  findFillers,
  learnFillers,
  markUsed,
  normalizeFillers,
  normalizeOwnMessageCount,
  ownMessageCounter,
  parseFiller,
  parsePatternCheck,
  patternCheckBody,
  patternCheckSettings,
  pinFiller,
  rankFillers,
  removeFiller,
} from '../src/behavior/fillers.js';
import { DAY_MS, HOUR_MS } from '../src/time.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

/** A stored entry with the given fields over a never-used, unpinned one. */
function entry(text, fields = {}) {
  const { entry: parsed } = parseFiller(text);
  return { ...parsed, pinned: false, weight: 1, lastSeen: iso(NOW), lastUsedAt: null, lastUsedAtMessage: null, uses: 0, ...fields };
}

const keys = (list) => list.map(fillerKey);

// ---- the entry syntax -------------------------------------------------------------

test('parseFiller: a trailing * makes a prefix of at least three letters; anything else is exact; folded', () => {
  assert.deepEqual(parseFiller('  ΕιΛικΡ* '), { entry: { text: 'ειλικρ', prefix: true } });
  assert.deepEqual(parseFiller('ναι'), { entry: { text: 'ναι', prefix: false } });
  assert.deepEqual(parseFiller('Très   Bien'), { entry: { text: 'très bien', prefix: false } });
  assert.deepEqual(parseFiller('café'), { entry: { text: 'café', prefix: false } });
  assert.deepEqual(parseFiller('να*'), { entry: null, reason: 'short-prefix' });
  assert.deepEqual(parseFiller('ν*αι'), { entry: null, reason: 'star-inside' });
  assert.deepEqual(parseFiller(' -- '), { entry: null, reason: 'empty' });
  assert.deepEqual(parseFiller('*'), { entry: null, reason: 'empty' });
  assert.deepEqual(parseFiller(null), { entry: null, reason: 'empty' });
  assert.deepEqual(parseFiller('α'.repeat(41)), { entry: null, reason: 'too-long' });
});

test('fillerFromWord: one word of four letters or more is a prefix, a shorter word or a phrase is exact', () => {
  assert.deepEqual(fillerFromWord('Ειλικρινά'), { text: 'ειλικρινά', prefix: true });
  assert.deepEqual(fillerFromWord('ναι'), { text: 'ναι', prefix: false });
  assert.deepEqual(fillerFromWord('à vrai dire'), { text: 'à vrai dire', prefix: false });
  assert.equal(fillerFromWord(''), null);
  assert.equal(fillerFromWord(undefined), null);
  assert.equal(fillerKey({ text: 'ειλικρ', prefix: true }), 'ειλικρ*');
  assert.equal(fillerKey({ text: 'ναι', prefix: false }), 'ναι');
});

test('normalizeFillers: hand-broken entries repaired, unparsable and duplicate ones dropped, a non-array is empty', () => {
  const out = normalizeFillers([
    { text: ' ΕΙΛΙΚΡ* ', pinned: true, weight: 3, lastSeen: iso(NOW), lastUsedAt: 5, lastUsedAtMessage: 2, uses: 1 },
    { text: 'ναι', prefix: false, weight: 'x', lastSeen: 'yesterday', lastUsedAt: 'x', lastUsedAtMessage: -1, uses: 2.5 },
    { text: 'ειλικρ', prefix: true },
    { text: 'να*' },
    { text: 42 },
    'garbage',
  ]);
  assert.deepEqual(out, [
    { text: 'ειλικρ', prefix: true, pinned: true, weight: 3, lastSeen: iso(NOW), lastUsedAt: 5, lastUsedAtMessage: 2, uses: 1 },
    { text: 'ναι', prefix: false, pinned: false, weight: 0, lastSeen: null, lastUsedAt: null, lastUsedAtMessage: null, uses: 0 },
  ]);
  assert.deepEqual(normalizeFillers(null), []);
  assert.deepEqual(normalizeFillers({ text: 'ναι' }), []);
});

// ---- the match ----------------------------------------------------------------------

test('findFillers: a prefix entry matches a word starting with it, not inside one', () => {
  const list = [entry('ειλικρ*')];
  assert.deepEqual(keys(findFillers('αυτό είναι ειλικρινές', list)), ['ειλικρ*']);
  assert.deepEqual(keys(findFillers('μη-ειλικρινής', list)), ['ειλικρ*'], 'a hyphen is a boundary');
  assert.deepEqual(keys(findFillers('ανειλικρινής', list)), [], 'inside a longer word');
  assert.deepEqual(keys(findFillers('x_ειλικρινής', list)), [], 'an underscore is a word character');
  assert.deepEqual(keys(findFillers('ανειλικρινής και ειλικρινής', list)), ['ειλικρ*'], 'a later word start is found');
});

test('findFillers: an exact entry matches the whole word or phrase only', () => {
  const list = [entry('ναι'), entry('à vrai dire')];
  assert.deepEqual(keys(findFillers('ΝΑΙ, σωστά', list)), ['ναι']);
  assert.deepEqual(keys(findFillers('ναιναι', list)), []);
  assert.deepEqual(keys(findFillers('Bon, À vrai dire, non', list)), ['à vrai dire']);
  assert.deepEqual(keys(findFillers('à vrai direct', list)), [], 'the phrase must end on a boundary');
});

test('findFillers: case- and composition-insensitive; list order; nothing for empty input', () => {
  const list = [entry('café'), entry('équit*')];
  assert.deepEqual(keys(findFillers('Très Équitable au CAFÉ', list)), ['café', 'équit*']);
  assert.deepEqual(findFillers('', list), []);
  assert.deepEqual(findFillers(null, list), []);
  assert.deepEqual(findFillers('café', null), []);
});

// ---- the cooldown ----------------------------------------------------------------------

const SETTINGS = { cooldownHours: 36, cooldownMessages: 300 };

test('fillersOnCooldown: used recently by both clocks rests; enough hours or enough own messages release it', () => {
  const used = entry('ειλικρ*', { lastUsedAt: NOW - HOUR_MS, lastUsedAtMessage: 100 });
  assert.deepEqual(keys(fillersOnCooldown([used], { now: NOW, ownMessages: 110, ...SETTINGS })), ['ειλικρ*']);
  const old = { ...used, lastUsedAt: NOW - 36 * HOUR_MS };
  assert.deepEqual(fillersOnCooldown([old], { now: NOW, ownMessages: 101, ...SETTINGS }), []);
  assert.equal(fillersOnCooldown([old], { now: NOW - 1, ownMessages: 101, ...SETTINGS }).length, 1, 'one millisecond short');
  assert.deepEqual(fillersOnCooldown([used], { now: NOW, ownMessages: 400, ...SETTINGS }), []);
  assert.equal(fillersOnCooldown([used], { now: NOW, ownMessages: 399, ...SETTINGS }).length, 1);
});

test('fillersOnCooldown: never used or a missing stamp is free; a cooldown of 0 blocks nothing', () => {
  const never = entry('ναι');
  const noCount = entry('όχι', { lastUsedAt: NOW - 1000 });
  assert.deepEqual(fillersOnCooldown([never, noCount], { now: NOW, ownMessages: 5, ...SETTINGS }), []);
  const used = entry('ναι', { lastUsedAt: NOW, lastUsedAtMessage: 10 });
  assert.deepEqual(fillersOnCooldown([used], { now: NOW, ownMessages: 10, cooldownHours: 0, cooldownMessages: 300 }), []);
  assert.deepEqual(fillersOnCooldown([used], { now: NOW, ownMessages: 10, cooldownHours: 36, cooldownMessages: 0 }), []);
});

test('markUsed: stamps both clocks and counts the use; other entries and the input stay as they were', () => {
  const list = [entry('ειλικρ*'), entry('όχι', { lastUsedAt: 5, lastUsedAtMessage: 2, uses: 3 })];
  const frozen = structuredClone(list);
  const next = markUsed(list, ['ειλικρ*', 'missing'], { now: NOW, ownMessages: 42 });
  assert.deepEqual([next[0].lastUsedAt, next[0].lastUsedAtMessage, next[0].uses], [NOW, 42, 1]);
  assert.deepEqual(next[1], frozen[1]);
  assert.deepEqual(list, frozen, 'never mutates its input');
  assert.equal(markUsed(next, ['ειλικρ*'], { now: NOW + 1, ownMessages: 43 })[0].uses, 2);
});

// ---- the ranked list --------------------------------------------------------------------

const RANK = { max: 3, halfLifeDays: 14 };

test('evictFillers: past max the lowest-ranked unpinned entries go, pinned ones always stay, storage order kept', () => {
  const list = [
    entry('ένα', { pinned: true, weight: 0, lastSeen: iso(NOW - 400 * DAY_MS) }),
    entry('δύο', { weight: 9, lastSeen: iso(NOW) }),
    entry('τρία', { weight: 1, lastSeen: iso(NOW - 60 * DAY_MS) }),
    entry('τέσσερα', { weight: 2, lastSeen: iso(NOW) }),
  ];
  assert.deepEqual(keys(evictFillers(list, 3, 14)), ['ένα', 'δύο', 'τέσσερα']);
  assert.deepEqual(keys(evictFillers(list, 1, 14)), ['ένα'], 'pinned entries take the room first');
  assert.equal(evictFillers(list, 4, 14), list, 'within max: the same list');
});

test('evictFillers: recency decay can outrank weight', () => {
  const heavyOld = entry('παλιό', { weight: 8, lastSeen: iso(NOW - 70 * DAY_MS) });
  const lightNew = entry('νέο', { weight: 2, lastSeen: iso(NOW) });
  assert.deepEqual(keys(evictFillers([heavyOld, lightNew], 1, 14)), ['νέο'], 'five half-lives cost more than four doublings of weight');
  assert.deepEqual(keys(evictFillers([heavyOld, lightNew], 1, 0)), ['παλιό'], 'no decay: weight decides');
});

test('rankFillers: pinned first, then the rest best ranked first', () => {
  const list = [entry('ένα', { weight: 1 }), entry('δύο', { pinned: true, weight: 0 }), entry('τρία', { weight: 5 })];
  assert.deepEqual(keys(rankFillers(list, 14)), ['δύο', 'τρία', 'ένα']);
});

test('pinFiller: a new entry is pinned at weight 1 and may evict; an existing one is pinned in place; a list full of pins refuses', () => {
  const list = [entry('ένα', { weight: 1, lastSeen: iso(NOW - 30 * DAY_MS) }), entry('δύο', { weight: 4 }), entry('τρία', { weight: 4, lastUsedAt: 7, uses: 2 })];
  const added = pinFiller(list, { text: 'ειλικρ', prefix: true }, { now: NOW, ...RANK });
  assert.equal(added.added, true);
  assert.deepEqual(added.entry, { text: 'ειλικρ', prefix: true, pinned: true, weight: 1, lastSeen: iso(NOW), lastUsedAt: null, lastUsedAtMessage: null, uses: 0 });
  assert.deepEqual(keys(added.list), ['δύο', 'τρία', 'ειλικρ*'], 'the weakest unpinned entry made room');

  const again = pinFiller(added.list, { text: 'τρία', prefix: false }, { now: NOW, ...RANK });
  assert.equal(again.added, false);
  assert.deepEqual([again.entry.pinned, again.entry.uses, again.entry.lastUsedAt], [true, 2, 7], 'pinned with its stamps kept');

  const allPinned = [entry('α1', { pinned: true }), entry('α2', { pinned: true }), entry('α3', { pinned: true })];
  const full = pinFiller(allPinned, { text: 'νέο', prefix: false }, { now: NOW, ...RANK });
  assert.deepEqual([full.full, full.entry, full.list], [true, null, allPinned]);
});

test('removeFiller: removes by key, pinned or not', () => {
  const list = [entry('ειλικρ*', { pinned: true }), entry('ναι')];
  assert.deepEqual(keys(removeFiller(list, 'ειλικρ*').list), ['ναι']);
  assert.equal(removeFiller(list, 'ειλικρ').removed, null, 'the exact key is another entry');
});

// ---- learning from the variety passes -------------------------------------------------------

test('learnFillers: a pattern word adds an unpinned entry weighted by its count; patterns without a word are ignored', () => {
  const { list, added, bumped } = learnFillers(
    [],
    [
      { shape: 'tags replies with honestly', count: 3, word: 'Ειλικρινά' },
      { shape: 'opens with a sigh', count: 2, word: 'αχ' },
      { shape: 'a frame', count: 4 },
      { shape: 'empty word', count: 2, word: '  ' },
    ],
    { now: NOW, ...RANK },
  );
  assert.deepEqual([added, bumped], [2, 0]);
  assert.deepEqual(list, [
    { text: 'ειλικρινά', prefix: true, pinned: false, weight: 3, lastSeen: iso(NOW), lastUsedAt: null, lastUsedAtMessage: null, uses: 0 },
    { text: 'αχ', prefix: false, pinned: false, weight: 2, lastSeen: iso(NOW), lastUsedAt: null, lastUsedAtMessage: null, uses: 0 },
  ]);
});

test('learnFillers: a word an entry already covers bumps it -- the same key or a stored prefix -- keeping its pin and use stamps', () => {
  const list = [entry('ειλικρ*', { pinned: true, weight: 1, lastSeen: iso(NOW - DAY_MS), uses: 4, lastUsedAt: 9 }), entry('αχ', { weight: 2 })];
  const out = learnFillers(list, [{ count: 2, word: 'ειλικρινά' }, { count: 3, word: 'Αχ' }], { now: NOW, ...RANK });
  assert.deepEqual([out.added, out.bumped], [0, 2]);
  assert.deepEqual(out.list.map((e) => [fillerKey(e), e.weight, e.lastSeen, e.pinned, e.uses]), [
    ['ειλικρ*', 3, iso(NOW), true, 4],
    ['αχ', 5, iso(NOW), false, 0],
  ]);
  assert.deepEqual(list[0].weight, 1, 'never mutates its input');
});

test('learnFillers: past max the weakest unpinned entry is evicted, a newcomer too when it is the weakest', () => {
  const list = [entry('ένα', { pinned: true }), entry('δύο', { weight: 6 }), entry('τρία', { weight: 1, lastSeen: iso(NOW - 90 * DAY_MS) })];
  const out = learnFillers(list, [{ count: 2, word: 'νέο' }], { now: NOW, ...RANK });
  assert.deepEqual(keys(out.list), ['ένα', 'δύο', 'νέο']);
  assert.equal(out.added, 1);
  const crowded = [entry('ένα', { pinned: true }), entry('δύο', { pinned: true }), entry('τρία', { pinned: true })];
  const none = learnFillers(crowded, [{ count: 2, word: 'νέο' }], { now: NOW, ...RANK });
  assert.deepEqual([keys(none.list), none.added], [['ένα', 'δύο', 'τρία'], 0], 'no room beside the pins');
});

test('learnFillers: an exact pattern adds an exact entry even for a long single word, and is covered like any other', () => {
  const out = learnFillers([], [{ count: 4, word: 'Φεγγάρι', exact: true }, { count: 3, word: '551 κομμάτια', exact: true }], { now: NOW, ...RANK });
  assert.deepEqual(out.list.map(fillerKey), ['φεγγάρι', '551 κομμάτια']);
  assert.deepEqual(out.list.map((e) => e.weight), [4, 3]);
  const covered = learnFillers([entry('φεγγ*', { weight: 1 })], [{ count: 2, word: 'φεγγάρι', exact: true }], { now: NOW, ...RANK });
  assert.deepEqual([covered.added, covered.bumped, keys(covered.list), covered.list[0].weight], [0, 1, ['φεγγ*'], 3]);
});

// ---- the rewrite --------------------------------------------------------------------

const MESSAGES = [
  { text: 'ειλικρινά ωραίο', replyTo: 2 },
  { text: 'και τέλος', replyTo: null },
];

test('applyReword: the same number of blank-line separated messages replaces the texts, keeping replyTo', () => {
  const out = applyReword(MESSAGES, '  πολύ ωραίο \n   \n και τέλος\n');
  assert.deepEqual(out, [
    { text: 'πολύ ωραίο', replyTo: 2 },
    { text: 'και τέλος', replyTo: null },
  ]);
  assert.notEqual(out, MESSAGES);
});

test('applyReword: keep, an empty answer, a count mismatch or no text give the originals', () => {
  for (const answer of ['keep', ' Keep. ', '`keep`', '"keep"', '', '   ', 'μόνο ένα', 'ένα\n\nδύο\n\nτρία', null, undefined, 42]) {
    assert.equal(applyReword(MESSAGES, answer), MESSAGES, JSON.stringify(answer));
  }
});

test('applyReword: one message keeps its inner single line breaks', () => {
  assert.deepEqual(applyReword([{ text: 'α\nβ', replyTo: null }], 'γ\nδ'), [{ text: 'γ\nδ', replyTo: null }]);
});

// ---- the own-message count -----------------------------------------------------------

test('ownMessageCounter: adds the posted count; a broken count starts at 0, a broken bump adds nothing', () => {
  assert.equal(ownMessageCounter(10, 2), 12);
  assert.equal(ownMessageCounter(undefined, 3), 3);
  assert.equal(ownMessageCounter(-4, 1), 1);
  assert.equal(ownMessageCounter(7, 0), 7);
  assert.equal(ownMessageCounter(7, 1.5), 7);
  assert.equal(normalizeOwnMessageCount('9'), 0);
  assert.equal(normalizeOwnMessageCount(9), 9);
});

// ---- the pattern post-check ---------------------------------------------------------

test('patternCheckBody: one numbered line per pattern, its examples quoted after a dash', () => {
  const body = patternCheckBody([
    { shape: 'ends on a rhetorical question', examples: ['έτσι δεν είναι;', 'σωστά;'] },
    { shape: 'opens with a sigh', examples: [] },
  ]);
  assert.equal(body, '1. ends on a rhetorical question — "έτσι δεν είναι;", "σωστά;"\n2. opens with a sigh');
  assert.equal(patternCheckBody(null), '');
});

test('parsePatternCheck: listed numbers become 0-based indices, deduplicated, out-of-range ones dropped', () => {
  assert.deepEqual(parsePatternCheck('2', 3), { matched: [1], parsed: true });
  assert.deepEqual(parsePatternCheck('`3, 3, 1.`', 3), { matched: [2, 0], parsed: true });
  assert.deepEqual(parsePatternCheck('1, 7, 0', 3), { matched: [0], parsed: true });
  assert.deepEqual(parsePatternCheck('2\nbecause it repeats', 3), { matched: [1], parsed: true }, 'the first line is the answer');
});

test('parsePatternCheck: none is no match; prose, an empty answer or no string is unparsed', () => {
  assert.deepEqual(parsePatternCheck(' None. ', 2), { matched: [], parsed: true });
  for (const answer of ['pattern 2 matches', 'two', '', '   ', null, undefined, 3]) {
    assert.deepEqual(parsePatternCheck(answer, 2), { matched: [], parsed: false }, JSON.stringify(answer));
  }
});

// ---- settings -----------------------------------------------------------------------

test('fillersSettings / patternCheckSettings: live values are read, garbage falls back to the defaults', () => {
  assert.deepEqual(
    fillersSettings({ variety: { fillers: { cooldownHours: 1.5, cooldownMessages: 0, maxOutputTokens: 80.9, max: 5, halfLifeDays: 0 } } }),
    { cooldownHours: 1.5, cooldownMessages: 0, maxOutputTokens: 80, max: 5, halfLifeDays: 0 },
  );
  assert.deepEqual(
    fillersSettings({ variety: { fillers: { cooldownHours: -1, cooldownMessages: 'x', maxOutputTokens: 0, max: -2, halfLifeDays: null } } }),
    { ...FILLERS_DEFAULTS },
  );
  assert.deepEqual(patternCheckSettings({ variety: { patternCheck: { minChars: 0, maxOutputTokens: 9.7 } } }), { minChars: 0, maxOutputTokens: 9 });
  assert.deepEqual(patternCheckSettings({ variety: { patternCheck: { minChars: -1, maxOutputTokens: 0 } } }), { ...PATTERN_CHECK_DEFAULTS });
});

test('config.json: the fillers and patternCheck groups equal the code defaults; both guards ship on', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.variety.fillers, { ...FILLERS_DEFAULTS });
  assert.deepEqual(fillersSettings({}), { ...FILLERS_DEFAULTS });
  assert.deepEqual(config.variety.patternCheck, { ...PATTERN_CHECK_DEFAULTS });
  assert.equal(config.features.fillerGuard, true);
  assert.equal(config.features.patternGuard, true);
  assert.equal(Object.hasOwn(config.features, 'rootGuard'), false);
  assert.equal(Object.hasOwn(config.variety, 'roots'), false);
});
