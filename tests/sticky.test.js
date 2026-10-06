// Tests for src/behavior/sticky.js: the mechanical sticky-phrase detector over
// the persona's own recent lines -- which phrases repeat across too many
// lines, the length and digit rules, the longest overlapping phrase, the
// settings and their fallbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STICKY_DEFAULTS, stickyPhrases, stickySettings } from '../src/behavior/sticky.js';

const SETTINGS = { minRepeats: 3, lines: 40, maxWords: 3, minChars: 4, ignore: [] };
const LETTERS = 'αβγδεζηθικλμνξοπρστυφχψω';

/** A filler line no other line repeats: short shared words (skipped) and one word of its own. */
function plain(i) {
  return `το να σε κ${LETTERS[i % 24]}${LETTERS[Math.floor(i / 24) % 24]}ος`;
}

/** 40 own lines, newest last, with `extra` set at the given indices. */
function ring(extra = {}) {
  return Array.from({ length: 40 }, (_, i) => (i in extra ? `${plain(i)} ${extra[i]}` : plain(i)));
}

const texts = (found) => found.map((phrase) => phrase.text);

test('stickyPhrases: a phrase in 4 of 40 lines is found with its line count, its parts dropped', () => {
  const found = stickyPhrases(ring({ 2: '551 κομμάτια σήμερα', 10: 'ήδη 551 κομμάτια', 25: '551 κομμάτια!', 39: 'πάλι 551 κομμάτια' }), SETTINGS);
  assert.deepEqual(found, [{ text: '551 κομμάτια', count: 4 }]);
});

test('stickyPhrases: a phrase in 2 of 40 lines is not sticky', () => {
  assert.deepEqual(stickyPhrases(ring({ 5: 'φεγγάρι ψηλά', 30: 'φεγγάρι ψηλά' }), SETTINGS), []);
});

test('stickyPhrases: minRepeats comes from the settings', () => {
  const lines = ring({ 5: 'φεγγάρι ψηλά', 30: 'φεγγάρι ψηλά' });
  assert.deepEqual(stickyPhrases(lines, { ...SETTINGS, minRepeats: 2 }), [{ text: 'φεγγάρι ψηλά', count: 2 }]);
});

test('stickyPhrases: the longest overlapping phrase wins; a part also used alone stays', () => {
  const lines = ring({ 1: '551 κομμάτια', 2: '551 κομμάτια', 3: '551 κομμάτια', 4: 'μόνο 551' });
  assert.deepEqual(stickyPhrases(lines, SETTINGS), [
    { text: '551', count: 4 },
    { text: '551 κομμάτια', count: 3 },
  ]);
});

test('stickyPhrases: a word under minChars letters is skipped, a digit keeps it', () => {
  const lines = ring({ 1: 'ένα 42', 2: 'δύο 42', 3: 'τρία 42' });
  assert.deepEqual(texts(stickyPhrases(lines, SETTINGS)), ['42'], '"το", "να", "σε" repeat everywhere and are skipped');
  assert.deepEqual(texts(stickyPhrases(ring({ 1: 'ναι', 2: 'ναι', 3: 'ναι' }), SETTINGS)), []);
  assert.deepEqual(texts(stickyPhrases(ring({ 1: 'ναι', 2: 'ναι', 3: 'ναι' }), { ...SETTINGS, minChars: 3 })), ['ναι']);
});

test('stickyPhrases: a phrase counts once per line, folded to lowercase', () => {
  assert.deepEqual(stickyPhrases(ring({ 7: 'Φεγγάρι φεγγάρι ΦΕΓΓΑΡΙ' }), SETTINGS), []);
  const found = stickyPhrases(ring({ 1: 'Φεγγάρι', 2: 'φεγγάρι', 3: 'ΦΕΓΓΆΡΙ' }), SETTINGS);
  assert.deepEqual(found, [{ text: 'φεγγάρι', count: 3 }]);
});

test('stickyPhrases: only the newest `lines` lines are read', () => {
  const lines = ring({ 0: 'φεγγάρι', 20: 'φεγγάρι', 39: 'φεγγάρι' });
  assert.equal(stickyPhrases(lines, SETTINGS).length, 1);
  assert.deepEqual(stickyPhrases(lines, { ...SETTINGS, lines: 39 }), []);
});

test('stickyPhrases: a phrase never spans punctuation, and maxWords caps its length', () => {
  const comma = stickyPhrases(ring({ 1: 'ψηλό, φεγγάρι', 2: 'ψηλό, φεγγάρι', 3: 'ψηλό, φεγγάρι' }), SETTINGS);
  assert.deepEqual(texts(comma).sort(), ['φεγγάρι', 'ψηλό']);
  const one = stickyPhrases(ring({ 1: 'ψηλό φεγγάρι', 2: 'ψηλό φεγγάρι', 3: 'ψηλό φεγγάρι' }), { ...SETTINGS, maxWords: 1 });
  assert.deepEqual(texts(one).sort(), ['φεγγάρι', 'ψηλό']);
});

test('stickyPhrases: a phrase made only of ignored or short words is skipped', () => {
  const lines = ring({ 1: 'λοιπόν καλά', 2: 'λοιπόν καλά', 3: 'λοιπόν καλά' });
  assert.deepEqual(texts(stickyPhrases(lines, SETTINGS)), ['λοιπόν καλά']);
  assert.deepEqual(texts(stickyPhrases(lines, { ...SETTINGS, ignore: ['Λοιπόν'] })), ['λοιπόν καλά'], 'one word still counts');
  assert.deepEqual(stickyPhrases(lines, { ...SETTINGS, ignore: ['λοιπόν', 'καλά'] }), []);
});

test('stickyPhrases: strongest first; ring entries with a text are read like strings', () => {
  const lines = ring({ 2: 'φεγγάρι', 3: 'φεγγάρι', 4: 'φεγγάρι', 5: 'θάλασσα', 6: 'θάλασσα', 7: 'θάλασσα', 8: 'θάλασσα' }).map((text) => ({ text }));
  assert.deepEqual(stickyPhrases([...lines, null, { text: 7 }], SETTINGS), [
    { text: 'θάλασσα', count: 4 },
    { text: 'φεγγάρι', count: 3 },
  ]);
  assert.deepEqual(stickyPhrases(null, SETTINGS), []);
});

test('stickySettings: live values are read, garbage falls back to the defaults', () => {
  const live = stickySettings({ variety: { sticky: { minRepeats: 5, lines: 10, maxWords: 2, minChars: 0, ignore: [' Και ', 7, '', 'και'] } } });
  assert.deepEqual(live, { minRepeats: 5, lines: 10, maxWords: 2, minChars: 0, ignore: ['και'] });
  const broken = stickySettings({ variety: { sticky: { minRepeats: 1, lines: 0, maxWords: 'x', minChars: -1, ignore: 'και' } } });
  assert.deepEqual(broken, { ...STICKY_DEFAULTS, ignore: [] });
});

test('stickySettings: the code fallback is config.json\'s variety.sticky, and stickyGuard ships on', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(stickySettings({}), shipped.variety.sticky);
  assert.deepEqual({ ...STICKY_DEFAULTS, ignore: [...STICKY_DEFAULTS.ignore] }, shipped.variety.sticky);
  assert.equal(shipped.features.stickyGuard, true, 'a missing features.stickyGuard counts as on, like the shipped value');
});
