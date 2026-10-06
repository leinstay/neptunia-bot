// The filler list: the persona's filler words, kept as data and shown to the
// persona as advice BEFORE it writes, never used to rewrite a reply after it
// was written. The guild keeps a short ranked list of fillers -- a PREFIX
// entry (`honest*`) catches every word starting with it, an EXACT entry
// (`well`, `to be fair`) the word or phrase as a whole. The owner pins
// entries (`/nep filler add`); the variety passes feed it by themselves: a
// word-type habit they name (`word` on a pattern) is added or bumped, the
// weakest unpinned entry evicted past `variety.fillers.max`, rank = weight
// with recency decay (src/memory/ranking.js). A filler the persona used rests
// for a while -- until `variety.fillers.cooldownHours` passed OR
// `variety.fillers.cooldownMessages` of its own messages were posted since
// the last use, whichever comes first -- and the resting ones are listed in
// the turn's `<worn>` block next to the worn patterns
// (src/behavior/variety.js#renderWorn). This module is the pure side: the
// settings, the entry syntax, the match, the cooldown, the use stamp, the
// ranked list, the learning from patterns and the running count of the
// persona's own messages. The bookkeeping after posting lives in
// src/behavior/turn.js, the learning's wiring in src/behavior/variety-pass.js,
// the stored state (`fillers`, `ownMessageCount` on guild.json) in
// src/memory/store.js.

import { isPlainObject } from '../config.js';
import { isWordChar, occursAsWholeWord } from '../memory/mentions.js';
import { sortByRank, topByRank } from '../memory/ranking.js';
import { HOUR_MS } from '../time.js';

/** The `variety.fillers` group when a key is missing or unusable: config.json's values. */
export const FILLERS_DEFAULTS = Object.freeze({
  cooldownHours: 36,
  cooldownMessages: 300,
  max: 12,
  halfLifeDays: 14,
});

/** The fewest letters a prefix entry carries before its `*`. */
export const MIN_PREFIX_LETTERS = 3;
/** A word the passes learn becomes a prefix entry from this many letters on, else an exact one. */
const LEARNED_PREFIX_LETTERS = 4;
/** The longest entry text, in code points: a filler is a word or a short phrase. */
export const FILLER_MAX_CHARS = 40;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * The `variety.fillers` settings of the live config, key by key:
 * `cooldownHours` (a finite number >= 0), `cooldownMessages` (>= 0, floored),
 * `max` (the list's capacity, >= 0, floored)
 * and `halfLifeDays` (the rank's decay, >= 0; 0 = no decay); a missing or
 * unusable key takes config.json's value (FILLERS_DEFAULTS). A cooldown of 0
 * releases every filler at once.
 * @param {object} config  The whole live config.
 * @returns {{ cooldownHours: number, cooldownMessages: number, max: number, halfLifeDays: number }}
 */
export function fillersSettings(config) {
  const group = isPlainObject(config?.variety?.fillers) ? config.variety.fillers : {};
  const atLeast = (key, min, floor) => {
    const value = group[key];
    if (!finite(value) || value < min) return FILLERS_DEFAULTS[key];
    return floor ? Math.floor(value) : value;
  };
  return {
    cooldownHours: atLeast('cooldownHours', 0, false),
    cooldownMessages: atLeast('cooldownMessages', 0, true),
    max: atLeast('max', 0, true),
    halfLifeDays: atLeast('halfLifeDays', 0, false),
  };
}

// ---- the entry ------------------------------------------------------------------

/** `text` as the list compares it: composed (NFC), lowercase, trimmed, inner whitespace collapsed. */
function folded(text) {
  return String(text).normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

/** How many letters `text` holds, in any script. */
function letters(text) {
  return [...text].filter((ch) => /\p{L}/u.test(ch)).length;
}

/**
 * One filler as the owner types it: a trailing `*` makes a PREFIX entry
 * (`honest*`: at least MIN_PREFIX_LETTERS letters before it), anything else an
 * EXACT one (a word or a phrase). Folded (lowercase, composed, spaces
 * collapsed). `entry` is null with the `reason`: `empty` (nothing a word
 * holds), `star-inside` (a `*` anywhere but the end), `short-prefix`,
 * `too-long` (over FILLER_MAX_CHARS code points).
 * @param {unknown} input
 * @returns {{ entry: { text: string, prefix: boolean }|null, reason?: string }}
 */
export function parseFiller(input) {
  const raw = typeof input === 'string' ? folded(input) : '';
  const prefix = raw.endsWith('*');
  const text = prefix ? raw.replace(/\*+$/u, '').trim() : raw;
  if (!/[\p{L}\p{N}_]/u.test(text)) return { entry: null, reason: 'empty' };
  if (text.includes('*')) return { entry: null, reason: 'star-inside' };
  if (prefix && letters(text) < MIN_PREFIX_LETTERS) return { entry: null, reason: 'short-prefix' };
  if ([...text].length > FILLER_MAX_CHARS) return { entry: null, reason: 'too-long' };
  return { entry: { text, prefix } };
}

/**
 * The entry a variety pass's `word` (a word-type habit's base form or phrase)
 * stands for: a single word of at least four letters a PREFIX entry, a shorter
 * word or a phrase an EXACT one; null when it holds no word or is too long.
 * @param {unknown} word
 * @returns {{ text: string, prefix: boolean }|null}
 */
export function fillerFromWord(word) {
  const entry = exactFromWord(word);
  if (!entry) return null;
  return { text: entry.text, prefix: !entry.text.includes(' ') && letters(entry.text) >= LEARNED_PREFIX_LETTERS };
}

/** The EXACT entry `word` stands for, any `*` dropped; null when it holds no word or is too long. */
function exactFromWord(word) {
  return parseFiller(typeof word === 'string' ? word.replace(/\*/gu, '') : '').entry;
}

/**
 * An entry's identity and its display form: the text, with `*` for a prefix entry.
 * @param {{ text: string, prefix: boolean }} entry
 * @returns {string}
 */
export function fillerKey(entry) {
  return entry.prefix ? `${entry.text}*` : entry.text;
}

/** A stored ISO stamp as it is when it reads as a time, else null. */
function isoOrNull(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** One entry before it was ever seen in a pass or used. */
function freshEntry({ text, prefix }, { pinned, weight, lastSeen }) {
  return { text, prefix, pinned, weight, lastSeen, lastUsedAt: null, lastUsedAtMessage: null, uses: 0 };
}

/**
 * A stored `fillers` list as it is read: entries `{ text, prefix,
 * pinned, weight, lastSeen, lastUsedAt, lastUsedAtMessage, uses }`, the text
 * re-parsed (a hand-written `honest*` text becomes a prefix entry; one that no
 * longer parses is dropped), `pinned` only when true, `weight` a finite number
 * >= 0 else 0, `lastSeen` an ISO stamp else null, `lastUsedAt` a finite number
 * else null, `lastUsedAtMessage` and `uses` integers >= 0 (else null and 0).
 * A second entry with the same key is dropped. Not an array -> []. Never
 * evicts: the capacity applies when the list is written.
 * @param {unknown} value
 * @returns {object[]}
 */
export function normalizeFillers(value) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!isPlainObject(raw) || typeof raw.text !== 'string') continue;
    const { entry } = parseFiller(raw.prefix === true && !raw.text.trim().endsWith('*') ? `${raw.text}*` : raw.text);
    if (!entry || seen.has(fillerKey(entry))) continue;
    seen.add(fillerKey(entry));
    out.push({
      text: entry.text,
      prefix: entry.prefix,
      pinned: raw.pinned === true,
      weight: finite(raw.weight) && raw.weight >= 0 ? raw.weight : 0,
      lastSeen: isoOrNull(raw.lastSeen),
      lastUsedAt: finite(raw.lastUsedAt) ? raw.lastUsedAt : null,
      lastUsedAtMessage: Number.isInteger(raw.lastUsedAtMessage) && raw.lastUsedAtMessage >= 0 ? raw.lastUsedAtMessage : null,
      uses: Number.isInteger(raw.uses) && raw.uses >= 0 ? raw.uses : 0,
    });
  }
  return out;
}

// ---- the match ------------------------------------------------------------------

/** Whether `needle` starts a word in `haystack` (both folded): the character before it is no word character. */
function startsAWord(haystack, needle) {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (!isWordChar(haystack[at - 1])) return true;
    from = at + 1;
  }
}

/** Whether one entry occurs in `haystack` (folded): a prefix at a word start, an exact text as a whole word or phrase. */
function occurs(haystack, entry) {
  return entry.prefix ? startsAWord(haystack, entry.text) : occursAsWholeWord(haystack, entry.text);
}

/**
 * The entries of `list` that occur in `text`: a prefix entry where a word
 * starts with it, an exact entry as a whole word or phrase -- word boundaries
 * Unicode-aware (src/memory/mentions.js#isWordChar), case- and
 * accent-composition-insensitive. In list order.
 * @param {unknown} text
 * @param {object[]} list
 * @returns {object[]}
 */
export function findFillers(text, list) {
  if (typeof text !== 'string' || text === '' || !Array.isArray(list)) return [];
  const haystack = String(text).normalize('NFC').toLowerCase();
  return list.filter((entry) => isPlainObject(entry) && typeof entry.text === 'string' && entry.text !== '' && occurs(haystack, entry));
}

/**
 * The entries of `entries` still resting: their last use is closer than
 * `cooldownHours` to `now` AND closer than `cooldownMessages` own messages to
 * `ownMessages`; reaching either one releases the entry. An entry without
 * both stamps (never used) is free.
 * @param {object[]} entries
 * @param {{ now: number, ownMessages: number, cooldownHours: number, cooldownMessages: number }} opts
 * @returns {object[]}
 */
export function fillersOnCooldown(entries, { now, ownMessages, cooldownHours, cooldownMessages }) {
  const restMs = cooldownHours * HOUR_MS;
  return (Array.isArray(entries) ? entries : []).filter(
    (entry) =>
      finite(entry?.lastUsedAt) &&
      finite(entry?.lastUsedAtMessage) &&
      now - entry.lastUsedAt < restMs &&
      ownMessages - entry.lastUsedAtMessage < cooldownMessages,
  );
}

/**
 * A new list where every entry whose key is in `keys` was used now: both
 * stamps moved (`lastUsedAt` = `now`, `lastUsedAtMessage` = `ownMessages`)
 * and `uses` counted. A key the list does not hold changes nothing. Never
 * mutates `list`.
 * @param {object[]} list
 * @param {string[]} keys  fillerKey of each used entry.
 * @param {{ now: number, ownMessages: number }} opts
 * @returns {object[]}
 */
export function markUsed(list, keys, { now, ownMessages }) {
  const used = new Set(Array.isArray(keys) ? keys : []);
  return (Array.isArray(list) ? list : []).map((entry) =>
    used.has(fillerKey(entry)) ? { ...entry, lastUsedAt: now, lastUsedAtMessage: ownMessages, uses: entry.uses + 1 } : entry,
  );
}

// ---- the ranked list ------------------------------------------------------------

/**
 * `list` within `max` entries: pinned entries always stay; of the others the
 * lowest-ranked go first (src/memory/ranking.js#topByRank: weight with
 * `halfLifeDays` of decay). Storage order is kept among the survivors.
 * @param {object[]} list
 * @param {number} max
 * @param {number} halfLifeDays
 * @returns {object[]}
 */
export function evictFillers(list, max, halfLifeDays) {
  if (list.length <= max) return list;
  const pinned = list.filter((entry) => entry.pinned).length;
  const keep = new Set(topByRank(list.filter((entry) => !entry.pinned), Math.max(0, max - pinned), halfLifeDays));
  return list.filter((entry) => entry.pinned || keep.has(entry));
}

/**
 * `list` in display order: the pinned entries first, then the others best
 * ranked first (sortByRank, `halfLifeDays`), each part in its rank order.
 * @param {object[]} list
 * @param {number} halfLifeDays
 * @returns {object[]}
 */
export function rankFillers(list, halfLifeDays) {
  const entries = Array.isArray(list) ? list : [];
  return [...sortByRank(entries.filter((entry) => entry.pinned), halfLifeDays), ...sortByRank(entries.filter((entry) => !entry.pinned), halfLifeDays)];
}

/**
 * The owner's add: the entry pinned (never evicted, never dropped by
 * decay). An entry already stored with that key is pinned in place, its
 * stamps kept; a new one starts at weight 1, seen `now`, never used, and may
 * evict the weakest unpinned entry past `max`. A list already holding `max`
 * pinned entries takes no new one (`full`).
 * @param {object[]} list
 * @param {{ text: string, prefix: boolean }} parsed  parseFiller's entry.
 * @param {{ now: number, max: number, halfLifeDays: number }} opts
 * @returns {{ list: object[], entry: object|null, added: boolean, full: boolean }}
 */
export function pinFiller(list, parsed, { now, max, halfLifeDays }) {
  const key = fillerKey(parsed);
  const existing = list.find((entry) => fillerKey(entry) === key);
  if (existing) {
    const entry = { ...existing, pinned: true };
    return { list: list.map((item) => (item === existing ? entry : item)), entry, added: false, full: false };
  }
  if (list.filter((entry) => entry.pinned).length >= max) return { list, entry: null, added: false, full: true };
  const entry = freshEntry(parsed, { pinned: true, weight: 1, lastSeen: new Date(now).toISOString() });
  return { list: evictFillers([...list, entry], max, halfLifeDays), entry, added: true, full: false };
}

/**
 * `list` without the entry of `key` (pinned or not).
 * @param {object[]} list
 * @param {string} key
 * @returns {{ list: object[], removed: object|null }}
 */
export function removeFiller(list, key) {
  const removed = list.find((entry) => fillerKey(entry) === key) ?? null;
  return { list: removed ? list.filter((entry) => entry !== removed) : list, removed };
}

/**
 * The list after a variety pass named `patterns`: each pattern with a `word`
 * (fillerFromWord; with `exact: true` always an EXACT entry, as the
 * sticky-phrase detector's phrases are, src/behavior/sticky.js) bumps the
 * entry that already covers it -- the same key,
 * else an entry that matches the word itself (a stored `honest*` covers a
 * learned `honestly`) -- by the pattern's `count` (`weight += count`,
 * `lastSeen` = `now`), or is added unpinned with that weight. Past `max` the
 * weakest unpinned entries are evicted (evictFillers), a newcomer included.
 * Never mutates `list`.
 * @param {object[]} list
 * @param {{ word?: string, count?: number, exact?: boolean }[]} patterns
 * @param {{ now: number, max: number, halfLifeDays: number }} opts
 * @returns {{ list: object[], added: number, bumped: number }}
 */
export function learnFillers(list, patterns, { now, max, halfLifeDays }) {
  let next = Array.isArray(list) ? [...list] : [];
  const lastSeen = new Date(now).toISOString();
  const addedKeys = new Set();
  const bumpedKeys = new Set();
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    const learned = pattern?.exact === true ? exactFromWord(pattern.word) : fillerFromWord(pattern?.word);
    if (!learned) continue;
    const count = Number.isInteger(pattern.count) && pattern.count > 0 ? pattern.count : 1;
    const key = fillerKey(learned);
    const covering = next.find((entry) => fillerKey(entry) === key) ?? findFillers(learned.text, next)[0];
    if (covering) {
      const bumped = { ...covering, weight: covering.weight + count, lastSeen };
      next = next.map((entry) => (entry === covering ? bumped : entry));
      if (!addedKeys.has(fillerKey(bumped))) bumpedKeys.add(fillerKey(bumped));
    } else {
      next.push(freshEntry(learned, { pinned: false, weight: count, lastSeen }));
      addedKeys.add(key);
    }
  }
  next = evictFillers(next, max, halfLifeDays);
  const present = new Set(next.map(fillerKey));
  return {
    list: next,
    added: [...addedKeys].filter((key) => present.has(key)).length,
    bumped: [...bumpedKeys].filter((key) => present.has(key)).length,
  };
}

// ---- the own-message count --------------------------------------------------------

/**
 * A stored own-message count as it is when it reads as one (an integer >= 0), else 0.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeOwnMessageCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The running count of the persona's own messages after `posted` more were
 * posted: it only ever grows; a broken stored count starts again at 0, a
 * `posted` that is no positive integer adds nothing.
 * @param {unknown} count
 * @param {unknown} posted
 * @returns {number}
 */
export function ownMessageCounter(count, posted) {
  return normalizeOwnMessageCount(count) + (Number.isInteger(posted) && posted > 0 ? posted : 0);
}
