// Pure server lorebook logic: which entries the analyzer's batch touches (so
// they can be updated), which entries a live turn's recent chat surfaces (so
// only the relevant few of possibly hundreds are shown). Storage itself
// (data/guilds/<id>/lore.json) lives behind src/memory/store.js, same
// cache/dirty/atomic pattern as everything else; this module never touches
// disk. See .claude/docs/prompt-contract.md ("<lore>" and "lore" in "The
// analyzer").

import { clampText } from './clamp.js';

const MAX_TITLE = 80;
const DEFAULT_MAX_TEXT = 400; // fallback only -- a deployment sets its own via config.lore.textChars
const MIN_KEY = 2;
const MAX_KEY = 40;
const MAX_KEYS = 8;
const DEFAULT_WEIGHT = 3;

const isLetterOrDigit = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

function normalizeTitle(title) {
  return String(title ?? '').trim().toLowerCase();
}

/** Lowercase, trim, drop too-short/duplicate keys, clamp an over-long one to
 * MAX_KEY at a word boundary (never dropped for being too long -- see the
 * F31 addendum), keep at most MAX_KEYS. */
function normalizeKeys(rawKeys) {
  if (!Array.isArray(rawKeys)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawKeys) {
    if (typeof raw !== 'string') continue;
    const key = clampText(raw.trim().toLowerCase(), MAX_KEY, { tolerance: 1 });
    if (key.length < MIN_KEY) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

/** A short, stable, deterministic id from the title, creation time and an in-call salt. */
function makeId(title, now, salt) {
  const base = `${title}|${now}|${salt}`;
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) {
    hash = (Math.imul(hash, 31) + base.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Evict the oldest `source: 'analyzer'` entries that are not `always`, until
 * `entries` is back at `maxEntries` or no more evictable entries remain
 * (an `owner` entry, or one marked `always`, is never evicted implicitly).
 */
function evictOverflow(entries, maxEntries) {
  if (!Number.isFinite(maxEntries) || entries.length <= maxEntries) return entries;
  const overflow = entries.length - maxEntries;
  const candidates = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.source === 'analyzer' && !entry.always)
    .sort((a, b) => {
      const byCreated = String(a.entry.createdAt ?? '').localeCompare(String(b.entry.createdAt ?? ''));
      return byCreated || a.index - b.index;
    });
  const drop = new Set(candidates.slice(0, overflow).map((c) => c.index));
  return entries.filter((_, index) => !drop.has(index));
}

/**
 * Insert or update lorebook entries from one analyzer batch or an owner
 * command. Pure: `entries` is never mutated. Identity is the case-insensitive,
 * trimmed `title`. An `analyzer` update may only replace the keys/text of an
 * entry whose OWN stored `source` is `'analyzer'`; an existing `owner` entry
 * is left completely untouched by an analyzer update (silently dropped). An
 * `owner` update always wins -- it overwrites any entry under that title
 * (analyzer or owner alike) and the entry becomes/stays an owner entry, the
 * one way a title becomes protected from the analyzer.
 *
 * @param {object[]|undefined} entries  Stored entries.
 * @param {unknown} incoming            Untrusted `{ title, keys, text, always? }[]`.
 * @param {{ source: 'analyzer'|'owner', now?: number, maxEntries?: number, textChars?: number,
 *   clampTolerance?: number }} opts
 *   `title` is a hard identity clamp at MAX_TITLE; `text` is free prose, clamped tolerantly (see
 *   src/memory/clamp.js) to `textChars` (config.lore.textChars; DEFAULT_MAX_TEXT when absent).
 * @returns {{ entries: object[], upserted: number }}
 */
export function upsertLore(entries, incoming, { source, now = Date.now(), maxEntries = Infinity, textChars, clampTolerance } = {}) {
  const stored = Array.isArray(entries) ? [...entries] : [];
  if (!Array.isArray(incoming) || incoming.length === 0) return { entries: stored, upserted: 0 };

  const byTitle = new Map(stored.map((entry, index) => [normalizeTitle(entry.title), index]));
  const nowIso = new Date(now).toISOString();
  const effectiveTextChars = Number.isFinite(textChars) && textChars > 0 ? textChars : DEFAULT_MAX_TEXT;
  let upserted = 0;
  let salt = 0;

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const title = typeof raw.title === 'string' ? clampText(raw.title, MAX_TITLE, { tolerance: 1 }) : '';
    const keys = normalizeKeys(raw.keys);
    const text = typeof raw.text === 'string' ? clampText(raw.text, effectiveTextChars, { tolerance: clampTolerance }) : '';
    if (!title || keys.length === 0 || !text) continue;

    const normalized = normalizeTitle(title);
    const existingIndex = byTitle.get(normalized);

    if (existingIndex === undefined) {
      salt += 1;
      const entry = {
        id: makeId(title, now, salt),
        title,
        keys,
        text,
        always: source === 'owner' && Boolean(raw.always),
        source,
        weight: DEFAULT_WEIGHT,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      stored.push(entry);
      byTitle.set(normalized, stored.length - 1);
      upserted += 1;
      continue;
    }

    const existing = stored[existingIndex];
    if (existing.source === 'owner' && source !== 'owner') continue; // never touched by the analyzer

    const updated = { ...existing, title, keys, text, source, updatedAt: nowIso };
    if (source === 'owner') updated.always = Boolean(raw.always);
    stored[existingIndex] = updated;
    upserted += 1;
  }

  return { entries: evictOverflow(stored, maxEntries), upserted };
}

/** Whether `key` occurs in `haystackLower` as a whole word/phrase (Unicode-aware boundaries). */
function occursAsWord(haystackLower, key) {
  let from = 0;
  for (;;) {
    const at = haystackLower.indexOf(key, from);
    if (at === -1) return false;
    const before = haystackLower[at - 1];
    const after = haystackLower[at + key.length];
    if (!isLetterOrDigit(before) && !isLetterOrDigit(after)) return true;
    from = at + 1;
  }
}

/**
 * Entries (any `always` status) whose keys literally occur, whole word/phrase
 * and case-insensitive, in `recentTexts` -- used for the analyzer's
 * `<existing_lore>` input, which cares about textual mentions, not about
 * `always`. Sorted most-matched first (distinct keys matched, then most
 * recent match position, then weight), for determinism only.
 * @param {object[]} entries
 * @param {string[]} recentTexts
 */
export function keywordMatches(entries, recentTexts) {
  const list = Array.isArray(entries) ? entries : [];
  const texts = (Array.isArray(recentTexts) ? recentTexts : []).map((t) => String(t ?? '').toLowerCase());

  const scored = [];
  for (const entry of list) {
    const keys = Array.isArray(entry.keys) ? entry.keys : [];
    let matchedKeys = 0;
    let lastIndex = -1;
    for (const key of keys) {
      const lowered = String(key).toLowerCase();
      let found = false;
      for (let i = 0; i < texts.length; i += 1) {
        if (occursAsWord(texts[i], lowered)) {
          found = true;
          if (i > lastIndex) lastIndex = i;
        }
      }
      if (found) matchedKeys += 1;
    }
    if (matchedKeys > 0) scored.push({ entry, matchedKeys, lastIndex, weight: entry.weight ?? 0 });
  }

  scored.sort((a, b) => b.matchedKeys - a.matchedKeys || b.lastIndex - a.lastIndex || b.weight - a.weight);
  return scored.map((s) => s.entry);
}

/**
 * Entries to show in one turn's `<lore>` block: every entry marked `always`
 * (first, never counted against `maxMatches`), plus up to `maxMatches` of the
 * remaining entries whose keys occur in `recentTexts`, most relevant first.
 * See .claude/docs/prompt-contract.md, "<lore>".
 * @param {object[]} entries
 * @param {string[]} recentTexts  Recent plain message texts, oldest first.
 * @param {{ maxMatches?: number }} [opts]
 */
export function matchLore(entries, recentTexts, { maxMatches = Infinity } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const always = list.filter((entry) => entry.always);
  const rest = list.filter((entry) => !entry.always);
  const matched = keywordMatches(rest, recentTexts).slice(0, maxMatches);
  return [...always, ...matched];
}
