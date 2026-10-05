// Tests for src/memory/clamp.js: clampText -- the boundary-aware, tolerant,
// token-safe replacement for a blind `.slice(0, limit)`. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampChars, clampText, oneLine } from '../src/memory/clamp.js';

// ---- non-string / empty --------------------------------------------------

test('clampText: a non-string returns an empty string', () => {
  assert.equal(clampText(undefined, 10), '');
  assert.equal(clampText(null, 10), '');
  assert.equal(clampText(42, 10), '');
  assert.equal(clampText({}, 10), '');
});

test('clampText: an empty/whitespace-only string returns an empty string', () => {
  assert.equal(clampText('', 10), '');
  assert.equal(clampText('   ', 10), '');
});

// ---- under / at / over the tolerance -------------------------------------

test('clampText: text under the limit is returned trimmed, unchanged', () => {
  assert.equal(clampText('  hello world  ', 20), 'hello world');
});

test('clampText: text within tolerance (limit < length <= limit*tolerance) is kept whole', () => {
  // limit 8, default tolerance 1.25 -> allowed up to 10.
  const text = 'x'.repeat(10);
  assert.equal(clampText(text, 8), text);
});

test('clampText: text exactly at the tolerance ceiling is kept whole', () => {
  const text = 'a'.repeat(10);
  assert.equal(clampText(text, 8, { tolerance: 1.25 }), text);
});

test('clampText: text past the tolerance ceiling is cut down to it', () => {
  const text = 'x'.repeat(11); // limit 8 * 1.25 = 10
  const result = clampText(text, 8);
  assert.ok(result.length <= 10);
  assert.equal(result, 'x'.repeat(10));
});

// ---- sentence boundary preferred ------------------------------------------

test('clampText: prefers the end of the last complete sentence when it keeps >= 60% of the allowed length', () => {
  const text = 'Alpha bravo charlie delta echo. Foxtrot golf hotel india juliet kilo lima mike november oscar.';
  const result = clampText(text, 40, { tolerance: 1 });
  assert.equal(result, 'Alpha bravo charlie delta echo.');
});

test('clampText: a sentence end followed by a closing quote/bracket is kept with it', () => {
  const text = 'He said "stop now." Then he left the room entirely for good this time around.';
  const result = clampText(text, 25, { tolerance: 1 });
  assert.equal(result, 'He said "stop now."');
});

test('clampText: a sentence boundary kept only when it retains at least 60% of the allowed length', () => {
  // "Hi." ends at index 3; allowed length 20; 3 is well under 60% of 20 (12) -> word boundary used instead.
  const text = 'Hi. And then a very long continuation that keeps going for a while yet.';
  const result = clampText(text, 20, { tolerance: 1 });
  assert.equal(result, 'Hi. And then a very');
});

// ---- word boundary fallback ------------------------------------------------

test('clampText: falls back to the last whitespace when no usable sentence boundary exists', () => {
  const text = 'alpha bravo charlie delta echo foxtrot golf';
  const result = clampText(text, 20, { tolerance: 1 });
  assert.equal(result, 'alpha bravo charlie');
});

// ---- single very long word: hard cut allowed only then --------------------

test('clampText: a single very long word with no boundary at all is hard-cut at the tolerance ceiling', () => {
  const text = 'x'.repeat(100);
  const result = clampText(text, 20, { tolerance: 1 });
  assert.equal(result, 'x'.repeat(20));
});

test('clampText: a hard cut is only used when there really is no earlier boundary', () => {
  const text = `${'a'.repeat(5)} ${'b'.repeat(100)}`;
  const result = clampText(text, 20, { tolerance: 1 });
  // the last whitespace (right after the first word) is preferred over cutting mid-word.
  assert.equal(result, 'aaaaa');
});

// ---- token safety: never split a <@digits> mention ------------------------

test('clampText: a token that fits entirely before the cut, right at the boundary, is kept whole', () => {
  const text = 'ping <@123456789012345678> please respond soon about the thing we discussed yesterday';
  const result = clampText(text, 26, { tolerance: 1 }); // "ping <@123456789012345678>" is exactly 26 chars
  assert.equal(result, 'ping <@123456789012345678>');
});

test('clampText: a token that would be split is dropped entirely, leaving no partial marker', () => {
  // No whitespace before the token, so the only cut left is the hard one at 10 code points,
  // which lands inside the token (code points 3 to 23).
  const text = 'abc<@999999999999999999> and more words after it';
  const result = clampText(text, 10, { tolerance: 1 });
  assert.equal(result, 'abc', 'the straddling token is dropped whole, not chopped');
  assert.ok(!result.includes('<@'));
});

// ---- dangling opening bracket / trailing separator -------------------------

test('clampText: a dangling opening bracket left at the cut is stripped', () => {
  // The word cut lands on the space right after the bracket, so the bracket is the last thing kept.
  for (const open of ['(', '[']) {
    const text = `plays chess ${open} mostly on weekends with friends`;
    assert.equal(clampText(text, 16, { tolerance: 1 }), 'plays chess', `word cut after ${open}`);
  }
  // A hard cut (no whitespace at all) leaves it glued to the word before it.
  assert.equal(clampText('abc(defghijklmnop', 4, { tolerance: 1 }), 'abc', 'hard cut after (');
});

test('clampText: a trailing comma left at the cut is stripped', () => {
  const text = 'likes cats, dogs, and other animals of many different kinds and sizes';
  const result = clampText(text, 11, { tolerance: 1 });
  assert.ok(!result.endsWith(','));
});

// ---- surrogate pairs / emoji never split -----------------------------------

test('clampText: length is counted in code points, not UTF-16 units', () => {
  const emoji = '🎉'; // 1 code point, 2 UTF-16 units
  const text = emoji.repeat(5); // 5 code points, 10 UTF-16 units
  assert.equal(clampText(text, 5, { tolerance: 1 }), text, 'fits exactly in 5 code points, not cut');
  assert.equal(clampText(text, 4, { tolerance: 1 }), emoji.repeat(4));
});

// ---- tolerance sanitization -------------------------------------------------

test('clampText: a non-number tolerance is treated as a hard limit (1)', () => {
  const text = 'x'.repeat(10);
  assert.equal(clampText(text, 8, { tolerance: 'garbage' }), 'x'.repeat(8));
  assert.equal(clampText(text, 8, { tolerance: NaN }), 'x'.repeat(8));
  assert.equal(clampText(text, 8, { tolerance: null }), 'x'.repeat(8));
});

test('clampText: a tolerance below 1 is treated as a hard limit (1)', () => {
  const text = 'x'.repeat(10);
  assert.equal(clampText(text, 8, { tolerance: 0.5 }), 'x'.repeat(8));
  assert.equal(clampText(text, 8, { tolerance: 0 }), 'x'.repeat(8));
  assert.equal(clampText(text, 8, { tolerance: -3 }), 'x'.repeat(8));
});

test('clampText: tolerance >= 1 is used as given', () => {
  const text = 'x'.repeat(20);
  assert.equal(clampText(text, 8, { tolerance: 2 }), 'x'.repeat(16));
});

// ---- non-finite / missing limit --------------------------------------------

test('clampText: a non-finite or non-positive limit means no clamp at all', () => {
  const text = 'hello world';
  assert.equal(clampText(text, undefined), text);
  assert.equal(clampText(text, NaN), text);
  assert.equal(clampText(text, 0), text);
  assert.equal(clampText(text, -5), text);
  assert.equal(clampText(text, Infinity), text);
});

// ---- never exceeds limit * tolerance ---------------------------------------

test('clampText: never returns a string longer than limit * tolerance, across many shapes', () => {
  const limit = 15;
  const tolerance = 1.25;
  const maxAllowed = Math.floor(limit * tolerance);
  const samples = [
    'x'.repeat(200),
    'word '.repeat(50),
    'One sentence here. Another one follows right after it without delay.',
    `prefix <@111111111111111111> ${'y'.repeat(100)}`,
    'πολλές λέξεις εδώ που ξεπερνούν σίγουρα το όριο που έχουμε ορίσει',
  ];
  for (const sample of samples) {
    const result = clampText(sample, limit, { tolerance });
    assert.ok(Array.from(result).length <= maxAllowed, `"${sample}" -> "${result}" exceeds ${maxAllowed}`);
  }
});

// ---- non-ASCII (Greek / accented Latin) ------------------------------------

test('clampText: cuts a Greek sentence at a word boundary, not mid-word', () => {
  const text = 'Αυτή είναι μια πολύ μεγάλη πρόταση που σίγουρα ξεπερνά το όριο που έχει οριστεί εδώ';
  const result = clampText(text, 20, { tolerance: 1 });
  assert.equal(result, 'Αυτή είναι μια πολύ');
});

test('clampText: an accented Latin word is never split mid-word', () => {
  const text = 'café au lait très agréable pendant longtemps encore aujourd’hui';
  const result = clampText(text, 12, { tolerance: 1 });
  assert.equal(result, 'café au lait');
});

// ---- oneLine / clampChars ----------------------------------------------------

test('oneLine: collapses every whitespace run to one space and trims', () => {
  assert.equal(oneLine('  καλή\n\tμέρα \r\n  φίλε  '), 'καλή μέρα φίλε');
  assert.equal(oneLine(null), '');
  assert.equal(oneLine(undefined), '');
  assert.equal(oneLine(42), '42');
});

test('clampChars: cuts at most max code points, never inside a surrogate pair', () => {
  assert.equal(clampChars('café', 3), 'caf');
  assert.equal(clampChars('a😀b', 2), 'a😀');
  assert.equal(clampChars('abc', 2.9), 'ab');
  assert.equal(clampChars('abc', 0), '');
  assert.equal(clampChars('abc', 10), 'abc');
});

test('clampChars: a max that is not a finite non-negative number leaves the text whole', () => {
  for (const max of [undefined, null, NaN, Infinity, -1, '2']) {
    assert.equal(clampChars('abc', max), 'abc', `max ${String(max)}`);
  }
  assert.equal(clampChars(null, 5), '');
});
