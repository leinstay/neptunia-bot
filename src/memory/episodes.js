// Pure merge logic for a member's remembered episodes -- moments the persona
// recalls about the two of them, appended by the analyzer (never rewritten)
// and evicted by weight then age once the per-person cap is exceeded, the
// newest few (`memory.keepNewestEpisodes`) spared so a light moment of a busy
// member is not thrown out the moment it arrives. See
// docs/prompt-contract.md ("episodes" in "The analyzer") and
// src/memory/update.js#applyMemoryUpdate, which routes the model's
// `users.<id>.episodes` through this module via src/memory/store.js#addEpisodes.
// Plus the display order (`sortEpisodesForDisplay`, also behind the owner's
// view in src/admin.js) and the top-N choice for a member asked about
// (`topEpisodes`), both used by src/behavior/prompt.js.

import { clampText } from './clamp.js';
import { utcDay } from '../time.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
function sanitizeEpisode(raw, nowMs, clampTolerance) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const what = typeof raw.what === 'string' ? clampText(raw.what, 200, { tolerance: clampTolerance }) : '';
  if (!what) return null;
  const quote = typeof raw.quote === 'string' ? clampText(raw.quote, 120, { tolerance: 1 }) : '';
  const feeling = typeof raw.feeling === 'string' ? clampText(raw.feeling, 120, { tolerance: clampTolerance }) : '';
  const weight = clampWeight(raw.weight);
  const date = typeof raw.date === 'string' && DATE_RE.test(raw.date) ? raw.date : utcDay(nowMs);
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
 * How many of the newest entries eviction spares: `keepNewest` rounded down and clamped to
 * `[0, cap - 1]`, so one entry is always left to evict. Anything that is not a number counts as 0.
 */
function keptNewestCount(keepNewest, cap) {
  const count = typeof keepNewest === 'number' && !Number.isNaN(keepNewest) ? Math.floor(keepNewest) : 0;
  return Math.max(0, Math.min(count, cap - 1));
}

/**
 * Indices of the `count` most recently added entries of `list`, whose entries from `storedLength`
 * on are the ones this merge accepted: those first whatever their stamp (a caller's clock may be
 * behind the stored stamps), then the latest `addedAt` (an entry with none counts as the oldest),
 * a later position first among equals (one merge stamps all its entries alike, in the model's
 * order).
 */
function newestIndices(list, count, storedLength) {
  if (count <= 0) return new Set();
  const byRecency = list
    .map((ep, index) => ({ addedAt: String(ep?.addedAt ?? ''), index, arrived: Number(index >= storedLength) }))
    .sort((a, b) => b.arrived - a.arrived || b.addedAt.localeCompare(a.addedAt) || b.index - a.index);
  return new Set(byRecency.slice(0, count).map((o) => o.index));
}

/**
 * Merge freshly-extracted episodes into a member's stored list. Pure:
 * `existing` is never mutated, surviving entries keep their original fields
 * and relative order (eviction only ever removes entries, never reorders or
 * rewrites the ones that remain). Tolerates a profile written before this
 * feature existed (`existing` undefined/not an array).
 *
 * Over `maxEpisodes`, the `K` most recently added entries are exempt from
 * eviction, `K` = `keepNewest` clamped to `maxEpisodes - 1`: this call's own
 * entries first, then by `addedAt`, then position; the rest go lowest weight
 * first, then oldest. `keepNewest` 0 (the default) = eviction by weight then age
 * alone. With `K` above 0 a moment is never evicted on arrival (unless one call
 * brings more than `K`: then only its last `K` are spared), whatever the
 * caller's `now`. It then stays safe while fewer than `K` entries rank newer
 * (a later call's own, or a later `addedAt`); from then on it ranks by weight
 * then age with the rest. Its `addedAt` is the caller's `now`: the warmup's
 * person run stamps with the member's last sampled message, so its moments can
 * rank below stream moments stored after that message and live shorter than the
 * survival below once they have arrived. Expected survival: a light
 * moment of a member at the cap whose stored moments are all heavier lives for
 * exactly `K` later moments and goes in the merge that stores the `K`-th -- at
 * `memory.keepNewestEpisodes` 5 and `memory.maxNewEpisodes` 3, at least two
 * more batches that add moments for that member. The light end of the list
 * turns over at the same rate as before; what changes is that every moment is
 * stored and can be seen before it goes.
 *
 * @param {object[]|undefined} existing  Stored episodes, oldest-appended order.
 * @param {unknown} incoming             Untrusted, model-extracted episodes.
 * @param {{ maxEpisodes: number, maxNew: number, now?: number, clampTolerance?: number, keepNewest?: number }} opts
 *   `keepNewest`: `memory.keepNewestEpisodes` (see src/memory/update.js#episodeOptions);
 *   omitted, negative or not a number = 0.
 * @returns {{ episodes: object[], added: number }}  `added` counts every accepted entry, one
 *   evicted again by the same merge included.
 */
export function mergeEpisodes(
  existing,
  incoming,
  { maxEpisodes, maxNew = Infinity, now: nowMs = Date.now(), clampTolerance, keepNewest = 0 } = {},
) {
  const stored = Array.isArray(existing) ? existing : [];
  if (!Array.isArray(incoming) || incoming.length === 0) return { episodes: stored, added: 0 };

  const sanitized = incoming
    .map((raw) => sanitizeEpisode(raw, nowMs, clampTolerance))
    .filter(Boolean)
    .slice(0, maxNew);

  const accepted = [];
  for (const candidate of sanitized) {
    if (isDuplicate(candidate, stored)) continue;
    accepted.push({ ...candidate, addedAt: new Date(nowMs).toISOString() });
  }
  if (accepted.length === 0) return { episodes: stored, added: 0 };

  let merged = [...stored, ...accepted];
  const cap = Number.isInteger(maxEpisodes) ? maxEpisodes : Infinity;
  if (merged.length > cap) {
    const dropCount = merged.length - cap;
    const exempt = newestIndices(merged, keptNewestCount(keepNewest, cap), stored.length);
    const order = merged
      .map((ep, index) => ({ ep, index }))
      .filter((o) => !exempt.has(o.index))
      .sort(evictionOrder);
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

/**
 * The at most `max` episodes a member is shown by when the persona is asked
 * about them (`context.askedAboutEpisodes`): heaviest weight first, then
 * newest, as `sortEpisodesForDisplay` orders them. An upper bound, not what a
 * request shows: under a tight `<people>` budget src/behavior/prompt.js keeps
 * only a prefix of this list (the lightest dropped first), possibly none, so
 * a block that must not repeat the shown ones has to take them from what was
 * rendered, not from this list. Pure, does not mutate `episodes`.
 * @param {object[]|undefined} episodes
 * @param {number} max  Not a positive integer (0 = off) -> none.
 * @returns {object[]}
 */
export function topEpisodes(episodes, max) {
  if (!Array.isArray(episodes) || !Number.isInteger(max) || max < 1) return [];
  return sortEpisodesForDisplay(episodes).slice(0, max);
}
