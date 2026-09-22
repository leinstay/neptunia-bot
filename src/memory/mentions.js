// A member is stored and passed to the model as an id token, never as a
// nickname -- Discord display names change daily, so free text that names
// someone by nickname rots the moment they rename (see
// docs/prompt-contract.md, "Members are referred to by id, never by
// nickname"). This module is the one place that converts between the two
// representations:
//
//   toTokens     the analyzer's free text -> tokens, on the way IN (a model
//                that writes `Name (id:123...)` instead of the bare token is
//                normalized rather than rejected)
//   fromTokens   tokens -> display text, on the way OUT: the member's current
//                name for the chat model, `name (id:123...)` for the analyzer
//
// Pure, no discord.js dependency: `isKnownId`/`nameOf`/`namesOf` are injected
// so the caller decides what "known" means (an author of the batch, an
// existing stored profile, ...) and where a display name comes from.

const TOKEN_RE = /<@(\d{17,20})>/g;
const ID_MARKER_RE = /\(id:(\d{17,20})\)/g;

/**
 * How much of `before` (the text immediately preceding an `(id:...)` marker)
 * is "the name" when no known name matched: the single name-like word
 * (letters, digits, apostrophes, hyphens -- deliberately no spaces or
 * sentence punctuation) directly touching the marker, plus one optional
 * space. A name is rarely more than one word in the wild, and guessing
 * several words would as often as not swallow an unrelated preceding word
 * instead (a verb or preposition ending right before the marker, e.g.
 * "trusts NAME (id:...)" or "argued with NAME (id:...)" -- both extremely
 * common, and only the single trailing word is ever the actual name).
 * Returns 0 when `before` does not end in a name-like word at all (nothing
 * to convert -- the marker is then left exactly as written).
 * @param {string} before
 * @returns {number}
 */
function fallbackNameLength(before) {
  const hasSpace = before.endsWith(' ');
  const stripped = hasSpace ? before.slice(0, -1) : before;
  const match = /[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u.exec(stripped);
  return match ? match[0].length + (hasSpace ? 1 : 0) : 0;
}

/**
 * How much of `before` is "the name" when `names` (the member's known
 * names, longest first) are given: the longest name that `before`, with at
 * most one trailing space ignored, ends with -- exact, case-sensitive. `-1`
 * when none of them match (the caller then falls back to `fallbackNameLength`).
 * @param {string} before
 * @param {string[]} names  Already sorted longest-first.
 * @returns {number}
 */
function knownNameLength(before, names) {
  const hasSpace = before.endsWith(' ');
  const stripped = hasSpace ? before.slice(0, -1) : before;
  for (const name of names) {
    if (name && stripped.endsWith(name)) return name.length + (hasSpace ? 1 : 0);
  }
  return -1;
}

/**
 * Turn `Name (id:123456789012345678)` written by the model into the token
 * `<@123456789012345678>`, but only when `isKnownId(id)` is true -- an
 * unrecognised id, and everything else in `text`, is left untouched.
 *
 * `namesOf(id)` (optional), when it returns a non-empty array, makes the
 * match NAME-AWARE instead of guessing a word count: the longest of the
 * member's known names (case-sensitive, exact) that the text immediately
 * before the marker ends with (ignoring one trailing space) is consumed as
 * the name, however many words it has -- so "Al Sus (id:...)" round-trips
 * correctly even though "Al Sus" is two words. Without a match among the
 * known names, or without `namesOf` at all, this falls back to consuming
 * the single name-like word touching the marker (see `fallbackNameLength`);
 * a marker with no name-like word before it at all is left untouched.
 * Already idempotent: a token contains no `(id:...)` for the pattern to
 * match again.
 * @param {string} text
 * @param {(id: string) => boolean} isKnownId
 * @param {(id: string) => (string[]|null|undefined)} [namesOf]
 * @returns {string}
 */
export function toTokens(text, isKnownId, namesOf) {
  if (typeof text !== 'string' || !text) return text;

  let result = '';
  let lastIndex = 0;
  for (const match of text.matchAll(ID_MARKER_RE)) {
    const id = match[1];
    const markerStart = match.index;
    const markerEnd = markerStart + match[0].length;
    const before = text.slice(lastIndex, markerStart);

    if (!isKnownId(id)) {
      result += before + match[0];
      lastIndex = markerEnd;
      continue;
    }

    const rawNames = typeof namesOf === 'function' ? namesOf(id) : null;
    const names = Array.isArray(rawNames)
      ? [...new Set(rawNames.filter((n) => typeof n === 'string' && n))].sort((a, b) => b.length - a.length)
      : [];

    let consumed = names.length > 0 ? knownNameLength(before, names) : -1;
    if (consumed === -1) consumed = fallbackNameLength(before);

    if (consumed === 0) {
      // Nothing name-like precedes the marker -- leave it exactly as written.
      result += before + match[0];
      lastIndex = markerEnd;
      continue;
    }

    result += before.slice(0, before.length - consumed);
    result += `<@${id}>`;
    lastIndex = markerEnd;
  }
  result += text.slice(lastIndex);
  return result;
}

/**
 * Resolve every `<@id>` token in `text` back to display text.
 * `mode: 'chat'` -> the member's current name alone (so `@name` mention
 * resolution downstream still works); `mode: 'analyzer'` -> `name (id:123...)`.
 * `nameOf(id)` returning anything other than a non-empty string leaves that
 * token exactly as written (an id the caller cannot currently resolve).
 * @param {string} text
 * @param {(id: string) => (string|null|undefined)} nameOf
 * @param {'chat'|'analyzer'} mode
 * @returns {string}
 */
export function fromTokens(text, nameOf, mode) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(TOKEN_RE, (whole, id) => {
    const name = typeof nameOf === 'function' ? nameOf(id) : null;
    if (typeof name !== 'string' || !name) return whole;
    return mode === 'analyzer' ? `${name} (id:${id})` : name;
  });
}

/** Whether `needleLower` occurs in `haystackLower` as a whole word/phrase (Unicode-aware boundaries). */
export function occursAsWholeWord(haystackLower, needleLower) {
  if (!needleLower) return false;
  const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  let from = 0;
  for (;;) {
    const at = haystackLower.indexOf(needleLower, from);
    if (at === -1) return false;
    const before = haystackLower[at - 1];
    const after = haystackLower[at + needleLower.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}
