// The mentor's reference: how the real people in the chat write, measured by
// code, never by a model. A model judging "does this read human" drifts
// toward its own taste; counting what the people around the persona actually
// do (how often they put a comma, a colon, a dash, how long their lines are,
// whether they stretch words or drop emoji) gives the mentor a fixed,
// checkable baseline to hold the persona's answers against.
//
// Everything here is pure: messages in, numbers out. Randomness comes in as
// an injected `rng` returning a number in [0, 1). Reading the channels that
// feed it is the caller's job.
//
// "Measured text" is a message's content with the quoted lines (`> ...`),
// Discord tokens (mentions, channel links, custom emoji), URLs and `:name:`
// custom-emoji names taken out, then trimmed; a message with nothing left is
// not counted at all. Lengths are in Unicode code points.
//
// Two kinds of marks stand out against an answer: `unused` ones nobody in the
// reference ever writes, and `rare` ones that do occur but seldom (under a
// rate per 1000 characters) or only from too few people (one member's habit
// is not the chat's). Sample lines go down to two characters, because the
// people's short lines are exactly what the persona needs to see.

/** The punctuation marks the reference counts, in report order. */
const MARKS = [
  'comma', 'period', 'colon', 'semicolon', 'dash', 'spacedHyphen',
  'quote', 'guillemet', 'exclamation', 'question', 'ellipsis',
];

const CLOCK_RE = /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g;

/** One counter per mark: occurrences of that mark in a measured text. */
const COUNTERS = {
  comma: (text) => countOf(text, /,/g),
  period: (text) => countOf(text, /(?<!\.)\.(?!\.)/g),
  colon: (text) => countOf(text.replace(CLOCK_RE, ''), /:/g),
  semicolon: (text) => countOf(text, /;/g),
  dash: (text) => countOf(text, /[‒-―]/g),
  spacedHyphen: (text) => countOf(text, / - /g),
  quote: (text) => countOf(text, /"/g),
  guillemet: (text) => countOf(text, /[«»]/g),
  exclamation: (text) => countOf(text, /!/g),
  question: (text) => countOf(text, /\?/g),
  ellipsis: (text) => countOf(text, /\.{3,}|…/g),
};

const LONG_LINE_CHARS = 60;
const SAMPLE_MIN_CHARS = 2;
const RARE_PER_1000 = 0.5;
const RARE_MIN_AUTHORS = 2;
const SAMPLE_MAX_CHARS = 200;
const MAX_PHRASES = 10;
/** Under this many measured characters an answer's comma rate is not reported. */
const DENSITY_MIN_CHARS = 150;

function countOf(text, re) {
  return (text.match(re) ?? []).length;
}

function charCount(text) {
  return [...text].length;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function share(part, whole) {
  return whole > 0 ? round(part / whole, 2) : 0;
}

/** Nearest-rank percentile of an ascending array; 0 for an empty one. */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

/** A message text as the reference measures it (see the header comment). */
function measure(content) {
  return String(content ?? '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .map((line) => line
      .replace(/<a?:\w+:\d+>/g, '')
      .replace(/<(?:@[!&]?|#)\d+>/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/:\w*[A-Za-z_]\w*:/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** Every mark's count in one measured text. */
function markCounts(text) {
  const counts = {};
  for (const mark of MARKS) counts[mark] = COUNTERS[mark](text);
  return counts;
}

/**
 * How the people in the chat write, measured over their messages.
 * @param {object[]} messages  Normalized messages of people (the persona and bots already removed).
 * @param {{ rarePer1000?: number, rareMinAuthors?: number }} [options]  Thresholds for `rare`
 *   (defaults 0.5 and 2); a value that is not a finite number falls back to its default.
 * @returns {{
 *   messages: number, chars: number, authors: number,
 *   per1000: Record<string, number>,
 *   markAuthors: Record<string, number>,
 *   unused: string[],
 *   rare: string[],
 *   length: { median: number, p75: number },
 *   shares: { replyQuote: number, question: number, unicodeEmoji: number, stretched: number, noCommaLong: number },
 * }}
 *   `authors`: distinct `authorId` values among the counted messages (a message without one counts toward
 *   no author). `per1000`: occurrences of each mark per 1000 characters, one decimal. `markAuthors`: how
 *   many distinct authors used each mark at least once. `unused`: marks with zero occurrences (empty when
 *   there are no messages -- no evidence is not evidence of absence). `rare`: marks not in `unused` whose
 *   unrounded rate is under `rarePer1000` or that fewer than `rareMinAuthors` authors used (empty when there
 *   are no messages). `shares`: fractions of the counted messages, two decimals; `noCommaLong` is among
 *   lines of 60+ characters.
 */
export function styleProfile(messages, options = {}) {
  const rarePer1000 = Number.isFinite(options?.rarePer1000) ? options.rarePer1000 : RARE_PER_1000;
  const rareMinAuthors = Number.isFinite(options?.rareMinAuthors) ? options.rareMinAuthors : RARE_MIN_AUTHORS;
  const totals = Object.fromEntries(MARKS.map((mark) => [mark, 0]));
  const users = Object.fromEntries(MARKS.map((mark) => [mark, new Set()]));
  const authors = new Set();
  const lengths = [];
  let chars = 0;
  let replyQuote = 0;
  let question = 0;
  let unicodeEmoji = 0;
  let stretched = 0;
  let long = 0;
  let longNoComma = 0;

  for (const message of messages ?? []) {
    const text = measure(message?.content);
    if (text === '') continue;
    const length = charCount(text);
    const counts = markCounts(text);
    for (const mark of MARKS) totals[mark] += counts[mark];
    const authorId = message.authorId;
    if (authorId != null && authorId !== '') {
      authors.add(authorId);
      for (const mark of MARKS) if (counts[mark] > 0) users[mark].add(authorId);
    }
    lengths.push(length);
    chars += length;
    if (message.replyToId) replyQuote++;
    if (text.includes('?')) question++;
    if (/\p{Extended_Pictographic}/u.test(text)) unicodeEmoji++;
    if (/(\p{L})\1{2,}/iu.test(text)) stretched++;
    if (length >= LONG_LINE_CHARS) {
      long++;
      if (!text.includes(',')) longNoComma++;
    }
  }

  const count = lengths.length;
  const per1000 = {};
  for (const mark of MARKS) per1000[mark] = chars > 0 ? round((totals[mark] * 1000) / chars, 1) : 0;
  lengths.sort((a, b) => a - b);
  const markAuthors = Object.fromEntries(MARKS.map((mark) => [mark, users[mark].size]));
  const rare = count > 0
    ? MARKS.filter((mark) => totals[mark] > 0
      && ((totals[mark] * 1000) / chars < rarePer1000 || markAuthors[mark] < rareMinAuthors))
    : [];

  return {
    messages: count,
    chars,
    authors: authors.size,
    per1000,
    markAuthors,
    unused: count > 0 ? MARKS.filter((mark) => totals[mark] === 0) : [],
    rare,
    length: { median: percentile(lengths, 0.5), p75: percentile(lengths, 0.75) },
    shares: {
      replyQuote: share(replyQuote, count),
      question: share(question, count),
      unicodeEmoji: share(unicodeEmoji, count),
      stretched: share(stretched, count),
      noCommaLong: share(longNoComma, long),
    },
  };
}

/**
 * Up to `n` real lines from the chat for the mentor to read as examples: measured texts of 2..200
 * characters, drawn with `rng`, never the same message twice and never the same author twice in a row
 * while another author is still available.
 * @param {object[]} messages  Normalized messages of people.
 * @param {number} n
 * @param {() => number} rng  Returns a number in [0, 1).
 * @returns {string[]}
 */
export function sampleLines(messages, n, rng) {
  const remaining = [];
  for (const message of messages ?? []) {
    const text = measure(message?.content);
    const length = charCount(text);
    if (length < SAMPLE_MIN_CHARS || length > SAMPLE_MAX_CHARS) continue;
    remaining.push({ text, authorId: message.authorId });
  }
  const want = Math.max(0, Math.floor(Number(n) || 0));
  const picked = [];
  let lastAuthor;
  while (picked.length < want && remaining.length > 0) {
    // Drawing only among the other authors when there are any is the same
    // as skipping a same-author draw, but always terminates.
    const others = picked.length > 0 ? remaining.filter((c) => c.authorId !== lastAuthor) : remaining;
    const pool = others.length > 0 ? others : remaining;
    const choice = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
    remaining.splice(remaining.indexOf(choice), 1);
    picked.push(choice.text);
    lastAuthor = choice.authorId;
  }
  return picked;
}

/**
 * The code-measured facts of one sandbox answer against the chat's reference.
 * @param {{ messages: { text: string, replyTo?: string|null }[] }} answer
 * @param {{ unused: string[], rare?: string[], length: { p75: number } }} profile  A styleProfile result.
 * @returns {{ chars: number, messages: number, unusedMarks: Record<string, number>,
 *   rareMarks: Record<string, number>, commas: number,
 *   commaPer1000: number|null, lengthOverP75: boolean, replyQuoted: boolean }}
 *   `commas`: how many commas the measured text has. `commaPer1000`: commas per 1000 characters, one
 *   decimal, only when the measured text has at least 150 characters; null for a shorter one, where one
 *   comma more or less swings the rate too far to mean anything.
 *   `unusedMarks`: the marks people never use that the answer contains, with their counts.
 *   `rareMarks`: the marks listed in the profile's `rare` that the answer contains, with their counts
 *   (empty for a profile without `rare`).
 *   `lengthOverP75`: the answer's longest message is longer than the people's 75th percentile.
 */
export function answerFacts(answer, profile) {
  const lines = (answer?.messages ?? []).map((message) => measure(message?.text));
  const text = lines.filter((line) => line !== '').join('\n');
  const chars = charCount(text);
  const counts = markCounts(text);
  const unusedMarks = {};
  for (const mark of profile?.unused ?? []) {
    if (counts[mark] > 0) unusedMarks[mark] = counts[mark];
  }
  const rareMarks = {};
  for (const mark of profile?.rare ?? []) {
    if (counts[mark] > 0) rareMarks[mark] = counts[mark];
  }
  const p75 = profile?.length?.p75 ?? 0;
  const longest = lines.reduce((max, line) => Math.max(max, charCount(line)), 0);
  return {
    chars,
    messages: answer?.messages?.length ?? 0,
    unusedMarks,
    rareMarks,
    commas: counts.comma,
    commaPer1000: chars >= DENSITY_MIN_CHARS ? round((counts.comma * 1000) / chars, 1) : null,
    lengthOverP75: p75 > 0 && longest > p75,
    replyQuoted: (answer?.messages ?? []).some((message) => message?.replyTo != null),
  };
}

/**
 * Word phrases the persona repeats across answers -- a verbal tic the chat would notice.
 * Words are runs of letters/digits, lowercased; a phrase never spans two messages. A phrase inside a
 * longer reported phrase with the same count is left out.
 *
 * Several answers to the same situation naturally share words, which says nothing about a habit; a
 * habit comes back in different situations. So when at least one answer carries a `situation` (any
 * value usable as a Map key), a phrase counts once per situation, and an answer without one counts as
 * a situation of its own. When no answer carries one, a phrase counts once per answer.
 * @param {{ situation?: *, messages: { text: string }[] }[]} answers
 * @param {number} [minWords]
 * @returns {{ phrase: string, count: number }[]}  Phrases of minWords+ words found in 2+ situations
 *   (or 2+ answers when no answer carries a situation), longest first, at most 10. `count` is the
 *   number of distinct situations the phrase occurs in, or of answers when no answer carries a situation.
 */
export function repeatedPhrases(answers, minWords = 3) {
  const min = Math.max(1, Math.floor(Number(minWords) || 1));
  const counts = new Map();
  const extensions = new Map();
  // The phrases already counted for each situation; an answer without one is a key of its own.
  const seenBy = new Map();

  for (const answer of answers ?? []) {
    const key = answer?.situation !== undefined ? answer.situation : Symbol('answer');
    if (!seenBy.has(key)) seenBy.set(key, new Set());
    const seen = seenBy.get(key);
    for (const message of answer?.messages ?? []) {
      const words = (String(message?.text ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)) ?? [];
      for (let size = min; size <= words.length; size++) {
        for (let start = 0; start + size <= words.length; start++) {
          const phrase = words.slice(start, start + size).join(' ');
          if (!extensions.has(phrase)) extensions.set(phrase, new Set());
          const ext = extensions.get(phrase);
          if (start > 0) ext.add(words.slice(start - 1, start + size).join(' '));
          if (start + size < words.length) ext.add(words.slice(start, start + size + 1).join(' '));
          if (seen.has(phrase)) continue;
          seen.add(phrase);
          counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
        }
      }
    }
  }

  // A phrase sits inside a longer one with the same count exactly when a
  // one-word extension of it has that count (counts only fall as a phrase grows).
  const found = [];
  for (const [phrase, count] of counts) {
    if (count < 2) continue;
    const absorbed = [...extensions.get(phrase)].some((longer) => counts.get(longer) === count);
    if (!absorbed) found.push({ phrase, count, words: phrase.split(' ').length });
  }
  found.sort((a, b) => b.words - a.words || b.count - a.count || (a.phrase < b.phrase ? -1 : a.phrase > b.phrase ? 1 : 0));
  return found.slice(0, MAX_PHRASES).map(({ phrase, count }) => ({ phrase, count }));
}
