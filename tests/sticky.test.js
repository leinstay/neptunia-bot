// Tests for src/behavior/sticky.js: the mechanical sticky-phrase detector over
// the persona's own ring of lines -- a burst in the recent window against the
// older baseline, the higher bar for a plain single word, the stricter rule
// for a young ring, the length and digit rules, the longest overlapping
// phrase, the settings and their fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STICKY_DEFAULTS, stickyPhrases, stickySettings } from '../src/behavior/sticky.js';

const SETTINGS = { minRepeats: 3, minRepeatsWord: 4, lines: 40, maxWords: 3, minChars: 4, baselineMax: 1, baselineMin: 100, ignore: [] };
const LETTERS = 'αβγδεζηθικλμνξοπρστυφχψω';

/** A filler line no other line repeats: short shared words (weak) and one word of its own. */
function plain(i) {
  return `το να σε κ${LETTERS[i % 24]}${LETTERS[Math.floor(i / 24) % 24]}ος`;
}

/**
 * A grown ring, newest last: 100 older lines (the baseline) then 40 recent
 * ones; `recent` and `older` add text to the line at an index of their part.
 */
function ring(recent = {}, older = {}) {
  const part = (count, offset, extra) => Array.from({ length: count }, (_, i) => (i in extra ? `${plain(offset + i)} ${extra[i]}` : plain(offset + i)));
  return [...part(100, 0, older), ...part(40, 100, recent)];
}

/** A young ring: the 40 recent lines alone, no baseline. */
function youngRing(recent = {}) {
  return ring(recent).slice(100);
}

/** `text` at each of `indices`, as ring() takes it. */
function at(indices, text) {
  return Object.fromEntries(indices.map((i) => [i, text]));
}

const texts = (found) => found.map((phrase) => phrase.text);

test('stickyPhrases: a plain word needs minRepeatsWord recent lines; a phrase and a digit token need minRepeats', () => {
  assert.deepEqual(stickyPhrases(ring(at([2, 10, 25], 'φεγγάρι')), SETTINGS), [], 'a plain word in 3 recent lines');
  assert.deepEqual(stickyPhrases(ring(at([2, 10, 25, 39], 'φεγγάρι')), SETTINGS), [{ text: 'φεγγάρι', count: 4 }]);
  assert.deepEqual(stickyPhrases(ring(at([2, 10, 25], 'φεγγάρι ψηλά')), SETTINGS), [{ text: 'φεγγάρι ψηλά', count: 3 }]);
  assert.deepEqual(stickyPhrases(ring({ 2: 'ένα 551', 10: 'δύο 551', 25: 'τρία 551' }), SETTINGS), [{ text: '551', count: 3 }]);
  assert.deepEqual(texts(stickyPhrases(ring(at([2, 10, 25], 'φεγγάρι')), { ...SETTINGS, minRepeatsWord: 3 })), ['φεγγάρι'], 'from the settings');
});

test('stickyPhrases: a word in 4 recent and 8 older lines is ordinary vocabulary, not sticky', () => {
  const older = at([3, 12, 25, 40, 51, 66, 80, 97], 'φεγγάρι');
  assert.deepEqual(stickyPhrases(ring(at([1, 2, 3, 4], 'φεγγάρι'), older), SETTINGS), []);
});

test('stickyPhrases: baselineMax comes from the settings', () => {
  const lines = ring(at([1, 2, 3, 4], 'φεγγάρι'), at([10, 20], 'φεγγάρι'));
  assert.deepEqual(stickyPhrases(lines, SETTINGS), [], 'two older lines, one allowed');
  assert.deepEqual(texts(stickyPhrases(lines, { ...SETTINGS, baselineMax: 2 })), ['φεγγάρι']);
});

test('stickyPhrases: a phrase in 4 of 40 recent lines is found with its line count, its parts dropped', () => {
  const found = stickyPhrases(ring({ 2: '551 κομμάτια σήμερα', 10: 'ήδη 551 κομμάτια', 25: '551 κομμάτια!', 39: 'πάλι 551 κομμάτια' }), SETTINGS);
  assert.deepEqual(found, [{ text: '551 κομμάτια', count: 4 }]);
});

test('stickyPhrases: a phrase in 2 recent lines is not sticky; minRepeats comes from the settings', () => {
  const lines = ring(at([5, 30], 'φεγγάρι ψηλά'));
  assert.deepEqual(stickyPhrases(lines, SETTINGS), []);
  assert.deepEqual(stickyPhrases(lines, { ...SETTINGS, minRepeats: 2 }), [{ text: 'φεγγάρι ψηλά', count: 2 }]);
});

test('stickyPhrases: a young ring keeps a phrase and a word with a digit, drops a plain word', () => {
  const recent = { ...at([1, 2, 3], '551 κομμάτια'), 4: 'μόνο 551', ...at([5, 6, 7, 8], 'φεγγάρι') };
  assert.deepEqual(stickyPhrases(youngRing(recent), SETTINGS), [
    { text: '551', count: 4 },
    { text: '551 κομμάτια', count: 3 },
  ]);
  assert.deepEqual(texts(stickyPhrases(ring(recent), SETTINGS)), ['551', 'φεγγάρι', '551 κομμάτια'], 'grown: the burst rule alone');
  assert.deepEqual(texts(stickyPhrases(ring(recent), { ...SETTINGS, baselineMin: 101 })), ['551', '551 κομμάτια'], 'baselineMin from the settings');
});

test('stickyPhrases: a word under minChars letters is weak; a digit keeps a token of two characters or more', () => {
  assert.deepEqual(texts(stickyPhrases(ring({ 1: 'ένα 42', 2: 'δύο 42', 3: 'τρία 42' }), SETTINGS)), ['42'], '"το", "να", "σε" repeat everywhere and are weak');
  assert.deepEqual(stickyPhrases(ring({ 1: 'ένα 2', 2: 'δύο 2', 3: 'τρία 2' }), SETTINGS), [], 'one digit alone is weak');
  assert.deepEqual(stickyPhrases(ring(at([1, 2, 3, 4], 'ναι')), SETTINGS), []);
  assert.deepEqual(texts(stickyPhrases(ring(at([1, 2, 3, 4], 'ναι')), { ...SETTINGS, minChars: 3 })), ['ναι']);
});

test('stickyPhrases: a phrase counts once per line, folded to lowercase', () => {
  assert.deepEqual(stickyPhrases(ring({ 7: 'Φεγγάρι φεγγάρι ΦΕΓΓΆΡΙ φΕγγάρι' }), SETTINGS), []);
  assert.deepEqual(stickyPhrases(ring({ 1: 'Φεγγάρι', 2: 'φεγγάρι', 3: 'ΦΕΓΓΆΡΙ', 4: 'φΕγγάρι' }), SETTINGS), [{ text: 'φεγγάρι', count: 4 }]);
});

test('stickyPhrases: the newest `lines` lines are the recent window, the older ones the baseline', () => {
  const lines = ring(at([0, 10, 20, 39], 'φεγγάρι'));
  assert.equal(stickyPhrases(lines, SETTINGS).length, 1);
  assert.deepEqual(stickyPhrases(lines, { ...SETTINGS, lines: 39 }), [], 'one use slides into the baseline');
});

test('stickyPhrases: a phrase never spans punctuation, and maxWords caps its length', () => {
  const comma = stickyPhrases(ring(at([1, 2, 3, 4], 'ψηλό, φεγγάρι')), SETTINGS);
  assert.deepEqual(texts(comma).sort(), ['φεγγάρι', 'ψηλό']);
  const one = stickyPhrases(ring(at([1, 2, 3, 4], 'ψηλό φεγγάρι')), { ...SETTINGS, maxWords: 1 });
  assert.deepEqual(texts(one).sort(), ['φεγγάρι', 'ψηλό']);
});

test('stickyPhrases: a phrase made only of ignored or short words is skipped', () => {
  const lines = ring(at([1, 2, 3], 'λοιπόν καλά'));
  assert.deepEqual(texts(stickyPhrases(lines, SETTINGS)), ['λοιπόν καλά']);
  assert.deepEqual(texts(stickyPhrases(lines, { ...SETTINGS, ignore: ['Λοιπόν'] })), ['λοιπόν καλά'], 'one word still counts');
  assert.deepEqual(stickyPhrases(lines, { ...SETTINGS, ignore: ['λοιπόν', 'καλά'] }), []);
});

test('stickyPhrases: strongest first; ring entries with a text are read like strings', () => {
  const lines = ring({ ...at([2, 3, 4, 5], 'φεγγάρι'), ...at([6, 7, 8, 9, 10], 'θάλασσα') }).map((text) => ({ text }));
  assert.deepEqual(stickyPhrases([...lines, null, { text: 7 }], SETTINGS), [
    { text: 'θάλασσα', count: 5 },
    { text: 'φεγγάρι', count: 4 },
  ]);
  assert.deepEqual(stickyPhrases(null, SETTINGS), []);
});

test('stickySettings: live values are read, garbage falls back to the defaults', () => {
  const live = stickySettings({
    variety: { sticky: { minRepeats: 5, minRepeatsWord: 6, lines: 10, maxWords: 2, minChars: 0, baselineMax: 0, baselineMin: 0, ignore: [' Και ', 7, '', 'και'] } },
  });
  assert.deepEqual(live, { minRepeats: 5, minRepeatsWord: 6, lines: 10, maxWords: 2, minChars: 0, baselineMax: 0, baselineMin: 0, ignore: ['και'] });
  const broken = stickySettings({
    variety: { sticky: { minRepeats: 1, minRepeatsWord: 1, lines: 0, maxWords: 'x', minChars: -1, baselineMax: -1, baselineMin: null, ignore: 'και' } },
  });
  assert.deepEqual(broken, { ...STICKY_DEFAULTS, ignore: [] });
});

test('stickySettings: the code fallback is config.json\'s variety.sticky, and stickyGuard ships on', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(stickySettings({}), shipped.variety.sticky);
  assert.deepEqual({ ...STICKY_DEFAULTS, ignore: [...STICKY_DEFAULTS.ignore] }, shipped.variety.sticky);
  assert.equal(shipped.features.stickyGuard, true, 'a missing features.stickyGuard counts as on, like the shipped value');
});
