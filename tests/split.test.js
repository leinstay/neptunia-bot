// Tests for src/behavior/split.js: the cheap pre-filter in front of the splitter, its settings and
// the strict parse of its answer. Every behaviour test sets its own settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT_DEFAULTS, mayHaveParts, parseSplitAnswer, splitCandidate, splitSettings } from '../src/behavior/split.js';

const SETTINGS = { minChars: 40, maxTasks: 3, contextMessages: 2, maxOutputTokens: 100 };
const config = (split = SETTINGS, features = { splitTasks: true }) => ({ features, split });
const LONG = 'πρώτα πες μου ποιος είναι ο Νίκος, μετά κοίτα το κανάλι της Ελένης; και το μιμίδιο είναι αστείο.';

test('mayHaveParts: long text with two separators passes', () => {
  assert.equal(mayHaveParts(LONG, 40), true);
});

test('mayHaveParts: text under minChars never passes', () => {
  assert.equal(mayHaveParts('ποιος, τι; πού.', 40), false);
});

test('mayHaveParts: long text with fewer than two separators does not pass', () => {
  assert.equal(mayHaveParts('a'.repeat(60), 40), false);
  assert.equal(mayHaveParts(`${'b'.repeat(60)}?`, 40), false);
});

test('mayHaveParts: a run of separators counts once', () => {
  assert.equal(mayHaveParts(`${'c'.repeat(60)}?!...`, 40), false);
  assert.equal(mayHaveParts(`${'c'.repeat(30)}?! ${'d'.repeat(30)}.`, 40), true);
});

test('mayHaveParts: line breaks and semicolons are separators', () => {
  assert.equal(mayHaveParts(`${'e'.repeat(30)}\n${'f'.repeat(30)}; g`, 40), true);
});

test('mayHaveParts: links and Discord tokens neither count toward length nor bring separators', () => {
  const linkOnly = 'https://www.example.com/a.b.c?d=1,2;3 <@123456789012345678> <#123456789012345679>';
  assert.equal(mayHaveParts(linkOnly, 40), false);
});

test('splitCandidate: a direct call of every kind with structured text is a candidate', () => {
  for (const kind of ['mention', 'reply', 'name', 'followUp', 'private']) {
    assert.equal(splitCandidate({ content: LONG }, kind, config()), true, kind);
  }
});

test('splitCandidate: an overheard line, an unprompted turn and a drawFailed turn never are', () => {
  assert.equal(splitCandidate({ content: LONG }, 'overheard', config()), false);
  assert.equal(splitCandidate({ content: LONG }, 'drawFailed', config()), false);
  assert.equal(splitCandidate(null, null, config()), false);
});

test('splitCandidate: features.splitTasks false turns it off; a missing key counts as on', () => {
  assert.equal(splitCandidate({ content: LONG }, 'mention', config(SETTINGS, { splitTasks: false })), false);
  assert.equal(splitCandidate({ content: LONG }, 'mention', config(SETTINGS, {})), true);
});

test('splitCandidate: maxTasks below 2 can split nothing', () => {
  assert.equal(splitCandidate({ content: LONG }, 'mention', config({ ...SETTINGS, maxTasks: 1 })), false);
});

test('splitCandidate: minChars is read from the settings', () => {
  assert.equal(splitCandidate({ content: LONG }, 'mention', config({ ...SETTINGS, minChars: [...LONG].length + 1 })), false);
});

test('parseSplitAnswer: the word one is one request', () => {
  assert.deepEqual(parseSplitAnswer('one', 3), { parts: null, reason: 'one' });
  assert.deepEqual(parseSplitAnswer('  One \n', 3), { parts: null, reason: 'one' });
});

test('parseSplitAnswer: dash lines are the parts, whitespace collapsed', () => {
  assert.deepEqual(parseSplitAnswer('- ποιος είναι ο Νίκος\n\n-   κοίτα  το κανάλι\n', 3), {
    parts: ['ποιος είναι ο Νίκος', 'κοίτα το κανάλι'],
    reason: 'parts',
  });
});

test('parseSplitAnswer: more parts than maxTasks are cut', () => {
  assert.deepEqual(parseSplitAnswer('- a\n- b\n- c\n- d', 3).parts, ['a', 'b', 'c']);
});

test('parseSplitAnswer: anything else is one request, unparsed', () => {
  for (const text of ['- only one part', 'two\n- a\n- b', '- a\nmore text\n- b', '1. a\n2. b', '-a\n-b', '- a\n- ', 'yes']) {
    assert.deepEqual(parseSplitAnswer(text, 3), { parts: null, reason: 'unparsed' }, JSON.stringify(text));
  }
});

test('parseSplitAnswer: an empty or missing answer is empty', () => {
  assert.deepEqual(parseSplitAnswer('  \n', 3), { parts: null, reason: 'empty' });
  assert.deepEqual(parseSplitAnswer(undefined, 3), { parts: null, reason: 'empty' });
});

test('splitSettings: an unusable value takes the default, a usable one is floored', () => {
  assert.deepEqual(splitSettings({ split: { minChars: -1, maxTasks: 'x', contextMessages: 2.7, maxOutputTokens: 0 } }), {
    minChars: SPLIT_DEFAULTS.minChars,
    maxTasks: SPLIT_DEFAULTS.maxTasks,
    contextMessages: 2,
    maxOutputTokens: SPLIT_DEFAULTS.maxOutputTokens,
  });
});
