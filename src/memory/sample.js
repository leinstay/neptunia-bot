// Why this module exists: a notes refresh (channel purpose/topics, server
// habits) must represent a period, not the last N lines. Taking the tail of a
// channel shows only the latest conversation and would overwrite a long-run
// description with it, so the sample is spread over the days the history
// covers, newest day first, one line per day per round. And one author must
// not define a channel: a single loud member is capped at a share of the
// sample, though the cap only shapes the sample and never leaves it short.
// Pure and deterministic: no rng, no clock reads.

import { utcDay } from '../time.js';

/**
 * A time-spread, author-capped sample of history messages.
 * Drops `excludeAuthorId`, buckets by UTC day, then takes rounds over the days
 * newest-first (within a day newest first), one message per day per round,
 * until `max`. An author holds at most `ceil(max * maxAuthorShare)` picks; at
 * the cap their message is skipped and the next in that day is tried. If the
 * cap leaves the sample under `max`, a second pass fills the rest ignoring it.
 * @param {Array<{ ts: number, authorId?: string }>} messages
 * @param {{ max: number, maxAuthorShare?: number, excludeAuthorId?: string, nowMs?: number }} opts
 * @returns {object[]} The picked messages in chronological order.
 */
export function selectSpreadSample(messages, { max, maxAuthorShare = 1, excludeAuthorId } = {}) {
  const limit = Math.floor(max);
  if (!Array.isArray(messages) || !(limit > 0)) return [];
  const days = new Map();
  for (const m of messages) {
    if (!m || !Number.isFinite(m.ts)) continue;
    if (excludeAuthorId != null && m.authorId === excludeAuthorId) continue;
    const key = utcDay(m.ts);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(m);
  }
  const buckets = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([, list]) => list.sort((a, b) => b.ts - a.ts));

  const cap = Math.max(1, Math.ceil(limit * maxAuthorShare));
  const picked = new Set();
  const perAuthor = new Map();

  const pass = (capped) => {
    let progress = true;
    while (picked.size < limit && progress) {
      progress = false;
      for (const list of buckets) {
        if (picked.size >= limit) break;
        const next = list.find((m) => !picked.has(m) && (!capped || (perAuthor.get(m.authorId) ?? 0) < cap));
        if (!next) continue;
        picked.add(next);
        perAuthor.set(next.authorId, (perAuthor.get(next.authorId) ?? 0) + 1);
        progress = true;
      }
    }
  };
  pass(true);
  if (picked.size < limit) pass(false);

  return [...picked].sort((a, b) => a.ts - b.ts);
}
