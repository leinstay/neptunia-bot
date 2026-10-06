// The sticky-phrase detector: a mechanical rail beside the variety pass. The
// persona sometimes latches onto one token -- a number someone mentioned, a
// word of an old joke -- and drops it into reply after reply, off topic. The
// variety pass reads too short a stretch and is told to leave a topic one
// conversation keeps returning to, so it never names such a token. This
// module counts instead: every phrase of one to `variety.sticky.maxWords`
// words that occurs in at least `variety.sticky.minRepeats` of the persona's
// last `variety.sticky.lines` own lines is sticky. The wiring
// (src/behavior/turn.js#notePosted) adds each one to the filler list as an
// exact entry already on its cooldown, so the filler guard rewrites its next
// use (src/behavior/fillers.js). Pure: no I/O, no clock, no model, no wording.

import { isPlainObject } from '../config.js';
import { FILLER_MAX_CHARS } from './fillers.js';

/** The `variety.sticky` group when a key is missing or unusable: config.json's values. */
export const STICKY_DEFAULTS = Object.freeze({
  minRepeats: 3,
  lines: 40,
  maxWords: 3,
  minChars: 4,
  ignore: Object.freeze([]),
});

/** A word: a run of the characters src/memory/mentions.js#isWordChar counts as word characters. */
const WORD = /[\p{L}\p{N}_]+/gu;

/** `text` composed (NFC), lowercase and trimmed, as the filler guard compares words. */
function folded(text) {
  return String(text).normalize('NFC').toLowerCase().trim();
}

/** An integer of `value` (floored) when it is a finite number >= `min`, else `fallback`. */
function intAtLeast(value, min, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/** The `ignore` words: folded, non-empty strings, each once; anything but an array -> []. */
function ignoreList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((word) => typeof word === 'string').map(folded).filter((word) => word !== ''))];
}

/** One group (`variety.sticky`, or the detector's own settings) read key by key. */
function readGroup(group) {
  const d = STICKY_DEFAULTS;
  return {
    minRepeats: intAtLeast(group.minRepeats, 2, d.minRepeats),
    lines: intAtLeast(group.lines, 1, d.lines),
    maxWords: intAtLeast(group.maxWords, 1, d.maxWords),
    minChars: intAtLeast(group.minChars, 0, d.minChars),
    ignore: ignoreList(group.ignore),
  };
}

/**
 * The `variety.sticky` settings of the live config, key by key: `minRepeats`
 * (in how many distinct lines a phrase must occur; an integer >= 2),
 * `lines` (how many of the persona's newest own lines are read; >= 1),
 * `maxWords` (the longest phrase, in words; >= 1), `minChars` (a word with
 * fewer letters and no digit is weak; >= 0) and `ignore` (words that are
 * always weak, folded; not an array -> []). A missing or unusable key takes
 * config.json's value (STICKY_DEFAULTS).
 * @param {object} config  The whole live config.
 * @returns {{ minRepeats: number, lines: number, maxWords: number, minChars: number, ignore: string[] }}
 */
export function stickySettings(config) {
  return readGroup(isPlainObject(config?.variety?.sticky) ? config.variety.sticky : {});
}

/** `features.stickyGuard` (a missing key counts as on). */
export function stickyOn(config) {
  return config?.features?.stickyGuard !== false;
}

/** How many letters `word` holds, in any script. */
function letters(word) {
  return [...word].filter((ch) => /\p{L}/u.test(ch)).length;
}

/**
 * Every phrase of one line: Map(text -> spans `[from, to)` in word indices).
 * A phrase is 1..maxWords consecutive words separated by whitespace only, so
 * its text (the words joined by one space) is what the line says; one made
 * only of weak words, or longer than a filler may be, is left out.
 */
function phrasesOf(line, { maxWords, minChars }, ignore) {
  const text = folded(line);
  const words = [...text.matchAll(WORD)].map((match) => ({ word: match[0], start: match.index, end: match.index + match[0].length }));
  const weak = words.map(({ word }) => ignore.has(word) || (letters(word) < minChars && !/\p{N}/u.test(word)));
  const out = new Map();
  for (let from = 0; from < words.length; from += 1) {
    for (let to = from + 1; to <= Math.min(words.length, from + maxWords); to += 1) {
      if (to - from > 1 && !/^\s+$/u.test(text.slice(words[to - 2].end, words[to - 1].start))) break;
      if (weak.slice(from, to).every(Boolean)) continue;
      const phrase = words.slice(from, to).map(({ word }) => word).join(' ');
      if ([...phrase].length > FILLER_MAX_CHARS) continue;
      if (!out.has(phrase)) out.set(phrase, []);
      out.get(phrase).push([from, to]);
    }
  }
  return out;
}

/**
 * The phrases the persona keeps reusing in its own recent lines. `lines`
 * (newest last; strings or ring entries with a `text`) is cut to its newest
 * `settings.lines`; each line is folded (NFC, lowercase) and split on Unicode
 * word boundaries; a phrase is 1..`maxWords` consecutive words with only
 * whitespace between them. A phrase counts once per line and is sticky in at
 * least `minRepeats` distinct lines. A word is weak when it is in `ignore`, or
 * has fewer than `minChars` letters and no digit (`551` is never weak); a
 * phrase of weak words only never counts. Among overlapping sticky phrases
 * the longest wins: a shorter one is dropped when every occurrence of it is
 * inside a longer sticky phrase (`551` goes when it only ever appears as `551
 * commits`, stays when it also appears alone). Strongest first (line count,
 * then more words); `count` is the number of lines.
 * @param {unknown[]} lines
 * @param {object} settings  stickySettings' shape; a missing or unusable key takes its default.
 * @returns {{ text: string, count: number }[]}
 */
export function stickyPhrases(lines, settings) {
  const s = readGroup(isPlainObject(settings) ? settings : {});
  const ignore = new Set(s.ignore);
  const recent = (Array.isArray(lines) ? lines : []).slice(-s.lines);
  const perLine = recent.map((line) => {
    const text = typeof line === 'string' ? line : line?.text;
    return typeof text === 'string' ? phrasesOf(text, s, ignore) : new Map();
  });
  const counts = new Map();
  for (const phrases of perLine) {
    for (const [phrase, spans] of phrases) {
      const seen = counts.get(phrase) ?? { count: 0, words: spans[0][1] - spans[0][0] };
      seen.count += 1;
      counts.set(phrase, seen);
    }
  }
  const candidates = [...counts]
    .filter(([, { count }]) => count >= s.minRepeats)
    .map(([text, { count, words }]) => ({ text, count, words }))
    .sort((a, b) => b.words - a.words);
  const kept = [];
  // Longer phrases are decided first, so a shorter one meets every longer phrase that may cover it.
  for (const candidate of candidates) {
    const inside = ([from, to], phrases) =>
      kept.some(({ text }) => (phrases.get(text) ?? []).some(([a, b]) => a <= from && to <= b && b - a > to - from));
    const covered = perLine.every((phrases) => (phrases.get(candidate.text) ?? []).every((span) => inside(span, phrases)));
    if (!covered) kept.push(candidate);
  }
  return kept.sort((a, b) => b.count - a.count || b.words - a.words).map(({ text, count }) => ({ text, count }));
}
