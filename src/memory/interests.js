// Pure logic for a member's remembered interests: atomic `{ topic, note,
// weight, firstSeen, lastSeen }` items, incrementally updated by the analyzer
// (add/update/seen/remove) instead of a prose blob rewritten batch after
// batch -- see .claude/docs/prompt-contract.md ("Interests are atomic items",
// "Confirmation (the "(?)" mechanism)" and "Dates come from the messages", in
// "The analyzer") and src/memory/update.js#applyMemoryUpdate, which routes
// the model's `users.<id>.interests` through this module via
// src/memory/store.js#applyProfileOps. `migrateInterests` upgrades an old
// profile whose `interests` field is still the legacy comma-separated prose
// string.
//
// Confirmation: `weight` counts the separate OCCASIONS a topic was observed,
// not how many ops mentioned it. A brand new item starts at weight 1, or 0
// when the op carries `sure: false`. `add`/`update` of an already-known topic
// and `seen` are each a SIGHTING; a sighting raises the weight by 1 only when
// the person's messages that produced it (`opts.seenAt`) are at least
// `opts.confirmGapHours` away from the item's stored `lastSeen` (a null
// `lastSeen` counts as far away) -- so one conversation split across several
// analyzer batches counts once. At most one bump per item per call,
// regardless of how many ops in that call target it. `sure: false` on an
// EXISTING item changes nothing at all, not even the note or the dates.
// `firstSeen`/`lastSeen` are min/max'd against `opts.seenAt` (the time of the
// person's message, not the wall clock the analyzer happened to run at), so
// history fed out of order (the warm-up) still ends up with correct dates.

const DEFAULT_CONFIRM_GAP_HOURS = 12;
const HOUR_MS = 3_600_000;

/** Trim, collapse internal whitespace, and clamp to `maxChars`. */
function clampString(value, maxChars) {
  const cap = Number.isInteger(maxChars) ? maxChars : Infinity;
  return String(value ?? '').trim().slice(0, cap);
}

/**
 * The identity a topic is compared by: trimmed, whitespace-collapsed,
 * lowercased (case-insensitive, Unicode-aware via the JS locale-agnostic
 * `toLowerCase`, the same approach src/memory/lore.js#normalizeTitle uses for
 * lorebook titles). Never stored -- comparison only. Reused as-is by
 * src/memory/details.js for a detail's text identity.
 * @param {string} topic
 */
export function normalizeTopic(topic) {
  return String(topic ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Ascending sort key for eviction: lowest weight first, then oldest `lastSeen` first among equals. */
function evictionOrder(a, b) {
  return (
    a.item.weight - b.item.weight ||
    String(a.item.lastSeen ?? '').localeCompare(String(b.item.lastSeen ?? '')) ||
    a.index - b.index
  );
}

/** Earlier of two ISO date strings; a missing one never wins. */
function minIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

/** Later of two ISO date strings; a missing one never wins. */
function maxIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Whether a sighting at `seenAt` (ms) is far enough from `priorLastSeenIso`
 * to count as a NEW occasion rather than the same conversation continuing: a
 * missing or unparsable stored date counts as far away (nothing to compare
 * against, so it can only heal an item stuck at its starting weight).
 */
function isFarEnough(seenAt, priorLastSeenIso, gapMs) {
  if (!priorLastSeenIso) return true;
  const priorMs = Date.parse(priorLastSeenIso);
  if (!Number.isFinite(priorMs)) return true;
  return Math.abs(seenAt - priorMs) >= gapMs;
}

/**
 * Whether a stored item (interest or detail; anything with a `weight`) counts
 * as CONFIRMED for the chat model -- see .claude/docs/prompt-contract.md,
 * "Confirmation". Below this, the chat model sees it with `labels.profile.unsureMark`.
 * @param {{ weight?: number }} item
 * @param {number} [confirmAfter]
 */
export function isConfirmed(item, confirmAfter = 2) {
  return (item?.weight ?? 0) >= confirmAfter;
}

/**
 * Whether a stored item's `lastSeen` is old enough to render with
 * `labels.profile.staleMark` -- see .claude/docs/prompt-contract.md, "Dates
 * come from the messages". An unknown `lastSeen`, or a `staleDays` that is
 * not a positive number (feature off / not configured), is never stale.
 * @param {{ lastSeen?: string|null }} item
 * @param {number} nowMs
 * @param {number} [staleDays]
 */
export function isStale(item, nowMs, staleDays) {
  if (!Number.isFinite(staleDays) || staleDays <= 0) return false;
  const lastSeen = item?.lastSeen;
  if (!lastSeen) return false;
  const lastSeenMs = Date.parse(lastSeen);
  if (!Number.isFinite(lastSeenMs)) return false;
  return (nowMs - lastSeenMs) / (24 * HOUR_MS) > staleDays;
}

/**
 * Merge one analyzer batch's interest ops into a member's stored list. Pure:
 * `existing` is never mutated. Garbage in `ops` (wrong types, malformed
 * items) is silently skipped, never thrown on.
 *
 * - `add` of an unknown topic inserts it with weight 1, or 0 when the op
 *   carries `sure: false`.
 * - `add`/`update` of a known topic (case-insensitive identity via
 *   `normalizeTopic`), and `seen` of a known topic, are each a sighting: see
 *   the module header comment for the weight-bump/gap rule. The note is
 *   replaced whenever the incoming one is non-empty, regardless of the gap (a
 *   re-mention with nothing new to say never erases what was already known).
 * - `update` of an unknown topic behaves exactly like `add`.
 * - `seen` never creates a new item -- a bare topic string with no note
 *   cannot introduce one.
 * - An op (`add`/`update`) with `sure: false` on an EXISTING item changes
 *   nothing at all, not even the note or the dates.
 * - `remove` deletes the item matching that topic, if any.
 * - `topic` is clamped to `topicChars`, `note` to `noteChars`; an item whose
 *   topic is empty after trimming is rejected outright.
 * - Once over `maxInterests`, the lowest-weight items are evicted first,
 *   then the ones with the oldest `lastSeen` among equal weights -- this
 *   runs on every call, even one with no ops, so an over-stuffed legacy
 *   profile self-heals on its first update.
 *
 * @param {object[]|undefined} existing  Stored interests.
 * @param {{ add?: unknown, update?: unknown, seen?: unknown, remove?: unknown }} ops  Untrusted, model-extracted.
 * @param {{ maxInterests?: number, topicChars?: number, noteChars?: number,
 *   confirmGapHours?: number, seenAt?: number }} [opts]
 * @returns {object[]}
 */
export function applyInterestOps(existing, ops, { maxInterests, topicChars, noteChars, confirmGapHours, seenAt = Date.now() } = {}) {
  let items = Array.isArray(existing) ? existing.map((item) => ({ ...item })) : [];
  const priorLastSeen = items.map((item) => item.lastSeen ?? null);
  const seenAtIso = new Date(seenAt).toISOString();
  const gapMs = (Number.isFinite(confirmGapHours) ? confirmGapHours : DEFAULT_CONFIRM_GAP_HOURS) * HOUR_MS;
  const bumped = new Set();

  function findIndex(topic) {
    const norm = normalizeTopic(topic);
    return items.findIndex((item) => normalizeTopic(item.topic) === norm);
  }

  function sight(raw, { allowCreate }) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const topic = typeof raw.topic === 'string' ? clampString(raw.topic, topicChars) : '';
    if (!topic) return;
    const note = typeof raw.note === 'string' ? clampString(raw.note, noteChars) : '';
    const sure = raw.sure !== false;
    const index = findIndex(topic);

    if (index === -1) {
      if (!allowCreate) return;
      items.push({ topic, note, weight: sure ? 1 : 0, firstSeen: seenAtIso, lastSeen: seenAtIso });
      return;
    }

    if (!sure) return; // sure: false on an existing item changes nothing at all

    const item = items[index];
    if (note) item.note = note;
    item.firstSeen = minIso(item.firstSeen, seenAtIso);
    item.lastSeen = maxIso(item.lastSeen, seenAtIso);
    if (!bumped.has(index)) {
      bumped.add(index);
      if (isFarEnough(seenAt, priorLastSeen[index], gapMs)) item.weight += 1;
    }
  }

  if (ops && typeof ops === 'object' && !Array.isArray(ops)) {
    for (const raw of Array.isArray(ops.add) ? ops.add : []) sight(raw, { allowCreate: true });
    for (const raw of Array.isArray(ops.update) ? ops.update : []) sight(raw, { allowCreate: true });
    for (const raw of Array.isArray(ops.seen) ? ops.seen : []) {
      if (typeof raw === 'string') sight({ topic: raw }, { allowCreate: false });
    }
    for (const raw of Array.isArray(ops.remove) ? ops.remove : []) {
      if (typeof raw !== 'string') continue;
      const index = findIndex(raw);
      if (index !== -1) items.splice(index, 1);
    }
  }

  const cap = Number.isInteger(maxInterests) ? maxInterests : Infinity;
  if (Number.isFinite(cap) && items.length > cap) {
    const dropCount = items.length - cap;
    const order = items.map((item, index) => ({ item, index })).sort(evictionOrder);
    const dropIndices = new Set(order.slice(0, dropCount).map((o) => o.index));
    items = items.filter((_, index) => !dropIndices.has(index));
  }

  return items;
}

/** One legacy comma-separated segment split into `{ topic, note }`. `note` is
 * whatever sits between the segment's FIRST `(` and its LAST `)` (so a
 * parenthesis nested inside the note is kept literally); no parenthesis at
 * all means the whole segment is the topic and the note is empty.
 */
function parseLegacySegment(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const open = trimmed.indexOf('(');
  const close = trimmed.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) {
    return trimmed ? { topic: trimmed, note: '' } : null;
  }
  const topic = trimmed.slice(0, open).trim();
  const note = trimmed.slice(open + 1, close).trim();
  return topic ? { topic, note } : null;
}

/** Split on commas that are not nested inside parentheses (so a note's own commas never break the item). */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Upgrade whatever a profile's `interests` field currently holds to the
 * atomic-item array shape: a legacy STRING (the old prose format, one
 * comma-separated dump -- possibly a "Game A (a remark that was about game
 * B), Game B, ..." glued dump of many items) is split into `{ topic, note,
 * weight: 1, firstSeen: null, lastSeen: null }` items; an ARRAY is validated
 * and passed through (unknown/garbage entries dropped); anything else -> `[]`.
 * @param {unknown} value
 * @returns {object[]}
 */
export function migrateInterests(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const raw of value) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
      if (!topic) continue;
      const note = typeof raw.note === 'string' ? raw.note.trim() : '';
      const weight = Number.isInteger(raw.weight) ? raw.weight : 1;
      const firstSeen = typeof raw.firstSeen === 'string' ? raw.firstSeen : null;
      const lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : null;
      out.push({ topic, note, weight, firstSeen, lastSeen });
    }
    return out;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    return splitTopLevelCommas(trimmed)
      .map(parseLegacySegment)
      .filter(Boolean)
      .map(({ topic, note }) => ({ topic, note, weight: 1, firstSeen: null, lastSeen: null }));
  }
  return [];
}
