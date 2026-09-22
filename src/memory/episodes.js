// Pure merge logic for a member's remembered episodes -- moments the persona
// recalls about the two of them, appended by the analyzer (never rewritten)
// and evicted by weight then age once the per-person cap is exceeded. See
// docs/prompt-contract.md ("episodes" in "The analyzer") and
// src/memory/update.js#applyMemoryUpdate, which routes the model's
// `users.<id>.episodes` through this module via src/memory/store.js#addEpisodes.

import { clampText } from './clamp.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in UTC, `YYYY-MM-DD` -- the fallback for an invalid/missing `date`. */
function todayUtc(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function clampWeight(raw) {
  const n = Number.isInteger(raw) ? raw : 3;
  return Math.min(5, Math.max(1, n));
}

/** Lowercased, trimmed, whitespace-collapsed -- for duplicate comparison only, never stored. */
function normalizeWhat(what) {
  return what.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Validate and clamp one raw episode from the model. Returns null when it has
 * no usable `what` (the one required field). `what`/`feeling` are free prose,
 * clamped tolerantly via src/memory/clamp.js; `quote` is the person's own
 * words verbatim, so it gets a hard cut (`tolerance: 1`) at a clean boundary
 * instead -- see docs/prompt-contract.md, "Limits are soft for the
 * model, clean in code".
 */
function sanitizeEpisode(raw, now, clampTolerance) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const what = typeof raw.what === 'string' ? clampText(raw.what, 200, { tolerance: clampTolerance }) : '';
  if (!what) return null;
  const quote = typeof raw.quote === 'string' ? clampText(raw.quote, 120, { tolerance: 1 }) : '';
  const feeling = typeof raw.feeling === 'string' ? clampText(raw.feeling, 120, { tolerance: clampTolerance }) : '';
  const weight = clampWeight(raw.weight);
  const date = typeof raw.date === 'string' && DATE_RE.test(raw.date) ? raw.date : todayUtc(now);
  return { date, what, quote, feeling, weight };
}

/**
 * Whether `candidate` duplicates one of `stored`: same date AND the same
 * `what` once normalized, or an identical non-empty `quote`.
 */
function isDuplicate(candidate, stored) {
  const normWhat = normalizeWhat(candidate.what);
  return stored.some((s) => {
    if (s.date === candidate.date && normalizeWhat(String(s.what ?? '')) === normWhat) return true;
    if (candidate.quote && s.quote && s.quote === candidate.quote) return true;
    return false;
  });
}

/** Ascending sort key for eviction: lowest weight first, then oldest first among equals. */
function evictionOrder(a, b) {
  return (
    a.ep.weight - b.ep.weight ||
    (a.ep.date < b.ep.date ? -1 : a.ep.date > b.ep.date ? 1 : 0) ||
    String(a.ep.addedAt ?? '').localeCompare(String(b.ep.addedAt ?? '')) ||
    a.index - b.index
  );
}

/**
 * Merge freshly-extracted episodes into a member's stored list. Pure:
 * `existing` is never mutated, surviving entries keep their original fields
 * and relative order (eviction only ever removes entries, never reorders or
 * rewrites the ones that remain). Tolerates a profile written before this
 * feature existed (`existing` undefined/not an array).
 *
 * @param {object[]|undefined} existing  Stored episodes, oldest-appended order.
 * @param {unknown} incoming             Untrusted, model-extracted episodes.
 * @param {{ maxEpisodes: number, maxNew: number, now?: number, clampTolerance?: number }} opts
 * @returns {{ episodes: object[], added: number }}
 */
export function mergeEpisodes(existing, incoming, { maxEpisodes, maxNew = Infinity, now = Date.now(), clampTolerance } = {}) {
  const stored = Array.isArray(existing) ? existing : [];
  if (!Array.isArray(incoming) || incoming.length === 0) return { episodes: stored, added: 0 };

  const sanitized = incoming
    .map((raw) => sanitizeEpisode(raw, now, clampTolerance))
    .filter(Boolean)
    .slice(0, maxNew);

  const accepted = [];
  for (const candidate of sanitized) {
    if (isDuplicate(candidate, stored)) continue;
    accepted.push({ ...candidate, addedAt: new Date(now).toISOString() });
  }
  if (accepted.length === 0) return { episodes: stored, added: 0 };

  let merged = [...stored, ...accepted];
  const cap = Number.isInteger(maxEpisodes) ? maxEpisodes : Infinity;
  if (merged.length > cap) {
    const dropCount = merged.length - cap;
    const order = merged.map((ep, index) => ({ ep, index })).sort(evictionOrder);
    const dropIndices = new Set(order.slice(0, dropCount).map((o) => o.index));
    merged = merged.filter((_, index) => !dropIndices.has(index));
  }

  return { episodes: merged, added: accepted.length };
}

/**
 * Order episodes for rendering: heaviest weight first, then newest (by
 * `date`, `addedAt` as a tiebreaker) -- see docs/prompt-contract.md,
 * `<people>` and `profile.episode(s)`. Pure, does not mutate `episodes`.
 * @param {object[]} episodes
 */
export function sortEpisodesForDisplay(episodes) {
  return [...(episodes ?? [])].sort(
    (a, b) =>
      b.weight - a.weight ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      String(b.addedAt ?? '').localeCompare(String(a.addedAt ?? '')),
  );
}
