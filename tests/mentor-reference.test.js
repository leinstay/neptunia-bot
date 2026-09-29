// Tests for src/mentor/reference.js: the code-measured reference of how the
// people in the chat write (punctuation rates, lengths, habits), random
// sample lines, the facts of one sandbox answer against that reference, and
// phrases repeated across answers. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleProfile, sampleLines, answerFacts, repeatedPhrases } from '../src/mentor/reference.js';

let nextId = 1;

/** A normalized message of a person, as src/discord/collect.js builds it. */
function msg(content, extra = {}) {
  const id = String(nextId++);
  return {
    id,
    authorId: 'a1',
    content,
    replyToId: null,
    emojis: [],
    links: [],
    self: false,
    bot: false,
    ...extra,
  };
}

/** `text` padded with a letter cycle (never three equal letters in a row) to exactly `total` code points. */
function pad(text, total) {
  const missing = total - [...text].length;
  return text + 'αβγ'.repeat(Math.ceil(missing / 3)).slice(0, missing);
}

/** A fixed sequence of rng values, cycled. */
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

const ALL_MARKS = [
  'comma', 'period', 'colon', 'semicolon', 'dash', 'spacedHyphen',
  'quote', 'guillemet', 'exclamation', 'question', 'ellipsis',
];

// ---- styleProfile ----------------------------------------------------------

test('styleProfile: per1000 counts every mark per 1000 characters of measured text', () => {
  const marks = 'a, b. c: d; e— f - g "h" «i» j! k? l... m… ';
  const profile = styleProfile([
    msg(pad(marks, 200)),
    // Quotes, a URL and custom emoji only: nothing left to measure.
    msg('> quoted, text!\n<:pog:123> https://example.com/a,b.c'),
    msg(':pog: <@123> <@!45> <#67> <a:dance:89>'),
  ]);
  assert.equal(profile.messages, 1);
  assert.equal(profile.chars, 200);
  assert.deepEqual(profile.per1000, {
    comma: 5,
    period: 5,
    colon: 5,
    semicolon: 5,
    dash: 5,
    spacedHyphen: 5,
    quote: 10,
    guillemet: 10,
    exclamation: 5,
    question: 5,
    ellipsis: 10,
  });
});

test('styleProfile: per1000 is rounded to one decimal', () => {
  // 1 comma in 3 characters -> 333.33... -> 333.3
  const profile = styleProfile([msg('ά,β')]);
  assert.equal(profile.per1000.comma, 333.3);
});

test('styleProfile: unused lists the marks nobody in the reference uses', () => {
  const profile = styleProfile([
    msg('Καλημέρα, τι κάνεις?'),
    msg('Très bien, merci'),
  ]);
  assert.deepEqual(
    profile.unused,
    ALL_MARKS.filter((mark) => mark !== 'comma' && mark !== 'question'),
  );
});

test('styleProfile: length gives the nearest-rank median and 75th percentile', () => {
  const profile = styleProfile([
    msg(pad('', 40)),
    msg(pad('', 10)),
    msg(pad('', 30)),
    msg(pad('', 20)),
  ]);
  assert.deepEqual(profile.length, { median: 20, p75: 30 });
});

test('styleProfile: shares count replies, questions, emoji, stretched words and long lines without a comma', () => {
  const profile = styleProfile([
    msg('Γειά σου, τι κάνεις?', { replyToId: '99' }),
    msg('Ωραίααα \u{1F600}'),
    msg(pad('Χωρίς κόμμα εδώ ', 70)),
    msg(pad('Με κόμμα, εδώ ', 70)),
    msg(pad('Encore une, phrase ', 65)),
    msg('ναι'),
  ]);
  assert.deepEqual(profile.shares, {
    replyQuote: 0.17,
    question: 0.17,
    unicodeEmoji: 0.17,
    stretched: 0.17,
    noCommaLong: 0.33,
  });
});

test('styleProfile: clock times and emoji names are not colons', () => {
  const clocks = styleProfile([msg('Στις 12:30 ή 9:05 :smile: ναι :party_time:')]);
  assert.equal(clocks.per1000.colon, 0);
  assert.ok(clocks.unused.includes('colon'));
  const real = styleProfile([msg('Σημείωση: εδώ στις 12:30')]);
  assert.ok(real.per1000.colon > 0);
  assert.ok(!real.unused.includes('colon'));
});

test('styleProfile: no messages gives zeros and no division by zero', () => {
  const profile = styleProfile([]);
  assert.equal(profile.messages, 0);
  assert.equal(profile.chars, 0);
  for (const mark of ALL_MARKS) assert.equal(profile.per1000[mark], 0, mark);
  assert.deepEqual(profile.unused, []);
  assert.deepEqual(profile.length, { median: 0, p75: 0 });
  assert.deepEqual(profile.shares, {
    replyQuote: 0,
    question: 0,
    unicodeEmoji: 0,
    stretched: 0,
    noCommaLong: 0,
  });
});

// ---- sampleLines -----------------------------------------------------------

function sampleSource() {
  return [
    msg('Πρώτη γραμμή από τον Α', { authorId: 'A' }),
    msg('Δεύτερη γραμμή από τον Α', { authorId: 'A' }),
    msg('Une ligne écrite par B', { authorId: 'B' }),
    msg('Une ligne écrite par C', { authorId: 'C' }),
    msg('κοντό', { authorId: 'B' }),
    msg(pad('Πολύ μεγάλο ', 201), { authorId: 'C' }),
  ];
}

test('sampleLines: is deterministic for a fixed rng', () => {
  const source = sampleSource();
  const first = sampleLines(source, 3, seq([0]));
  const second = sampleLines(source, 3, seq([0]));
  assert.deepEqual(first, second);
  assert.deepEqual(first, [
    'Πρώτη γραμμή από τον Α',
    'Une ligne écrite par B',
    'Δεύτερη γραμμή από τον Α',
  ]);
});

test('sampleLines: keeps lines of 15..200 characters, no author twice in a row, no line twice', () => {
  const source = sampleSource();
  const lines = sampleLines(source, 10, seq([0.9, 0.1, 0.5, 0.3]));
  assert.equal(lines.length, 4);
  assert.equal(new Set(lines).size, 4);
  const authorOf = new Map(source.map((m) => [m.content, m.authorId]));
  for (let i = 0; i < lines.length; i++) {
    const length = [...lines[i]].length;
    assert.ok(length >= 15 && length <= 200, lines[i]);
    if (i > 0) assert.notEqual(authorOf.get(lines[i]), authorOf.get(lines[i - 1]));
  }
});

test('sampleLines: one author left still gives lines, and n caps the count', () => {
  const source = [
    msg('Μόνο ένας συγγραφέας εδώ', { authorId: 'A' }),
    msg('Και πάλι ο ίδιος συγγραφέας', { authorId: 'A' }),
  ];
  assert.equal(sampleLines(source, 5, seq([0])).length, 2);
  assert.equal(sampleLines(source, 1, seq([0])).length, 1);
  assert.deepEqual(sampleLines(source, 0, seq([0])), []);
  assert.deepEqual(sampleLines([], 3, seq([0])), []);
});

// ---- answerFacts -----------------------------------------------------------

test('answerFacts: counts the marks people never use', () => {
  const profile = { unused: ['dash', 'exclamation', 'semicolon'], length: { median: 8, p75: 12 } };
  const answer = {
    messages: [
      { text: 'Ναι — φυσικά!', replyTo: null },
      { text: 'Ωραία, πάμε!! \u{1F600}', replyTo: 'm1' },
    ],
  };
  const facts = answerFacts(answer, profile);
  assert.deepEqual(facts.unusedMarks, { dash: 1, exclamation: 3 });
  assert.equal(facts.messages, 2);
  // 13 + newline + 15 code points
  assert.equal(facts.chars, 29);
  assert.equal(facts.commaPer1000, 34.5);
  assert.equal(facts.lengthOverP75, true);
  assert.equal(facts.replyQuoted, true);
});

test('answerFacts: no reply, short lines and an empty reference p75 are all false', () => {
  const answer = { messages: [{ text: 'Ναι, ναι' }, { text: 'Δεν ξέρω' }] };
  const short = answerFacts(answer, { unused: [], length: { median: 10, p75: 40 } });
  assert.equal(short.lengthOverP75, false);
  assert.equal(short.replyQuoted, false);
  assert.deepEqual(short.unusedMarks, {});
  const empty = answerFacts(answer, { unused: [], length: { median: 0, p75: 0 } });
  assert.equal(empty.lengthOverP75, false);
});

// ---- repeatedPhrases -------------------------------------------------------

function answerOf(...texts) {
  return { messages: texts.map((text) => ({ text })) };
}

test('repeatedPhrases: finds a phrase shared by two answers', () => {
  const found = repeatedPhrases([
    answerOf('Λοιπόν, όπως πάντα είμαι εδώ για σένα.'),
    answerOf('Ξέρεις; Όπως Πάντα είμαι εδώ.'),
    answerOf('Τίποτα νέο, όπως πάντα είμαι κουρασμένος.'),
    answerOf('ένα δύο τρία ένα δύο τρία'),
  ]);
  assert.deepEqual(found, [
    { phrase: 'όπως πάντα είμαι εδώ', count: 2 },
    { phrase: 'όπως πάντα είμαι', count: 3 },
  ]);
});

test('repeatedPhrases: respects minWords and returns at most 10', () => {
  const pairs = [];
  for (let i = 0; i < 12; i++) {
    const phrase = `λέξη${i} ακόμα${i}`;
    pairs.push(answerOf(`${phrase} πρώτη`), answerOf(`δεύτερη ${phrase}`));
  }
  assert.deepEqual(repeatedPhrases(pairs), []);
  const found = repeatedPhrases(pairs, 2);
  assert.equal(found.length, 10);
  for (const item of found) assert.equal(item.count, 2);
});
