// Pure logic for a member's remembered "details" -- short atomic facts, each
// item `{ id, text, weight, firstSeen, lastSeen }`, incrementally updated by
// the analyzer (add/seen/remove) with the same confirmation/date mechanics as
// src/memory/interests.js#applyInterestOps -- see
// .claude/docs/prompt-contract.md, "Details are atomic items too" and
// "Confirmation (the "(?)" mechanism), same for interests and details". A
// detail's `id` is a per-profile incrementing integer (`opts.nextId` in,
// `nextId` out -- the caller, src/memory/store.js#applyProfileOps, persists
// it on the profile) that is never reused, even for a removed item.
// `migrateDetails` upgrades a legacy profile whose `details` field is still a
// bare array of strings.

import { normalizeTopic } from './interests.js';

const DEFAULT_CONFIRM_GAP_HOURS = 12;
const HOUR_MS = 3_600_000;

function clampString(value, maxChars) {
  const cap = Number.isInteger(maxChars) ? maxChars : Infinity;
  return String(value ?? '').trim().slice(0, cap);
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

/** Whether a sighting at `seenAt` (ms) is far enough from `priorLastSeenIso` to count as a new occasion. */
function isFarEnough(seenAt, priorLastSeenIso, gapMs) {
  if (!priorLastSeenIso) return true;
  const priorMs = Date.parse(priorLastSeenIso);
  if (!Number.isFinite(priorMs)) return true;
  return Math.abs(seenAt - priorMs) >= gapMs;
}

/** Ascending sort key for eviction: lowest weight first, then oldest `lastSeen` first among equals. */
function evictionOrder(a, b) {
  return (
    a.item.weight - b.item.weight ||
    String(a.item.lastSeen ?? '').localeCompare(String(b.item.lastSeen ?? '')) ||
    a.index - b.index
  );
}

function normalizedNextId(startId) {
  return Number.isInteger(startId) && startId >= 1 ? startId : 1;
}

/**
 * Merge one analyzer batch's detail ops into a member's stored list. Pure:
 * `existing` is never mutated.
 *
 * - `add` of text with no matching stored item (identity: trimmed,
 *   whitespace-collapsed, lowercased -- see `normalizeTopic`) inserts it with
 *   a fresh id, weight 1, or 0 when the op carries `sure: false`.
 * - `add` of already-known text, and `seen` (by numeric id or by exact stored
 *   text), are each a sighting: see src/memory/interests.js's header comment
 *   for the weight-bump/gap rule, identical here. `sure: false` on an
 *   EXISTING item changes nothing at all.
 * - `remove` (by id or by exact stored text) deletes the matching item.
 * - `text` is clamped to `fieldChars`; an item whose text is empty after
 *   trimming is rejected outright.
 * - Once over `maxDetails`, the lowest-weight items are evicted first, then
 *   the ones with the oldest `lastSeen` among equal weights.
 *
 * @param {object[]|undefined} existing  Stored details.
 * @param {{ add?: unknown, seen?: unknown, remove?: unknown }} ops  Untrusted, model-extracted.
 * @param {{ maxDetails?: number, fieldChars?: number, confirmGapHours?: number,
 *   seenAt?: number, nextId?: number }} [opts]
 * @returns {{ items: object[], nextId: number }}
 */
export function applyDetailOps(existing, ops, { maxDetails, fieldChars, confirmGapHours, seenAt = Date.now(), nextId } = {}) {
  let items = Array.isArray(existing) ? existing.map((item) => ({ ...item })) : [];
  const priorLastSeen = items.map((item) => item.lastSeen ?? null);
  const seenAtIso = new Date(seenAt).toISOString();
  const gapMs = (Number.isFinite(confirmGapHours) ? confirmGapHours : DEFAULT_CONFIRM_GAP_HOURS) * HOUR_MS;
  const bumped = new Set();
  let id = normalizedNextId(nextId);

  function findIndex(identifier) {
    if (typeof identifier === 'number') return items.findIndex((item) => item.id === identifier);
    if (typeof identifier === 'string') {
      const norm = normalizeTopic(identifier);
      return items.findIndex((item) => normalizeTopic(item.text) === norm);
    }
    return -1;
  }

  function sightExisting(index) {
    const item = items[index];
    item.firstSeen = minIso(item.firstSeen, seenAtIso);
    item.lastSeen = maxIso(item.lastSeen, seenAtIso);
    if (!bumped.has(index)) {
      bumped.add(index);
      if (isFarEnough(seenAt, priorLastSeen[index], gapMs)) item.weight += 1;
    }
  }

  function add(raw) {
    const isObj = raw && typeof raw === 'object' && !Array.isArray(raw);
    if (!isObj && typeof raw !== 'string') return;
    const text = clampString(isObj ? raw.text : raw, fieldChars);
    if (!text) return;
    const sure = isObj ? raw.sure !== false : true;
    const index = findIndex(text);
    if (index === -1) {
      if (!sure) {
        items.push({ id, text, weight: 0, firstSeen: seenAtIso, lastSeen: seenAtIso });
        id += 1;
        return;
      }
      items.push({ id, text, weight: 1, firstSeen: seenAtIso, lastSeen: seenAtIso });
      id += 1;
      return;
    }
    if (!sure) return; // sure: false on an existing item changes nothing at all
    sightExisting(index);
  }

  function seen(raw) {
    if (typeof raw !== 'number' && typeof raw !== 'string') return;
    const index = findIndex(raw);
    if (index === -1) return;
    sightExisting(index);
  }

  function remove(raw) {
    if (typeof raw !== 'number' && typeof raw !== 'string') return;
    const index = findIndex(raw);
    if (index !== -1) items.splice(index, 1);
  }

  if (ops && typeof ops === 'object' && !Array.isArray(ops)) {
    for (const raw of Array.isArray(ops.add) ? ops.add : []) add(raw);
    for (const raw of Array.isArray(ops.seen) ? ops.seen : []) seen(raw);
    for (const raw of Array.isArray(ops.remove) ? ops.remove : []) remove(raw);
  }

  const cap = Number.isInteger(maxDetails) ? maxDetails : Infinity;
  if (Number.isFinite(cap) && items.length > cap) {
    const dropCount = items.length - cap;
    const order = items.map((item, index) => ({ item, index })).sort(evictionOrder);
    const dropIndices = new Set(order.slice(0, dropCount).map((o) => o.index));
    items = items.filter((_, index) => !dropIndices.has(index));
  }

  return { items, nextId: id };
}

/**
 * Upgrade whatever a profile's `details` field currently holds to the atomic
 * item array shape: a legacy array of bare strings (`profile.details` before
 * this feature) becomes `{ id, text, weight: 1, firstSeen: null, lastSeen:
 * null }` items with fresh sequential ids starting at `startId`; an array
 * already in the item shape is validated and passed through (a valid integer
 * `id` is kept, otherwise one is assigned fresh so the sequence never
 * collides); anything else -> `{ items: [], nextId: startId }`. Never throws
 * on garbage.
 * @param {unknown} value
 * @param {number} [startId]
 * @returns {{ items: object[], nextId: number }}
 */
export function migrateDetails(value, startId = 1) {
  let id = normalizedNextId(startId);
  const items = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (typeof raw === 'string') {
        const text = raw.trim();
        if (!text) continue;
        items.push({ id, text, weight: 1, firstSeen: null, lastSeen: null });
        id += 1;
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.text === 'string') {
        const text = raw.text.trim();
        if (!text) continue;
        const weight = Number.isInteger(raw.weight) ? raw.weight : 1;
        const firstSeen = typeof raw.firstSeen === 'string' ? raw.firstSeen : null;
        const lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : null;
        const itemId = Number.isInteger(raw.id) && raw.id >= 1 ? raw.id : id;
        if (itemId >= id) id = itemId + 1;
        items.push({ id: itemId, text, weight, firstSeen, lastSeen });
      }
    }
  }
  return { items, nextId: id };
}
