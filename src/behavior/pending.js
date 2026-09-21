// Pure queue of "pending" direct pings: a @mention or a reply to the persona
// that arrived while its one attention (see config.mention.oneAtATime) was
// busy running a turn somewhere else. At most one pending ping per channel
// (a newer one replaces an older one in the same channel) and at most
// mention.maxPending channels overall; the oldest is evicted when full.
// In-memory only, never persisted -- a restart forgetting every pending ping
// is fine.
//
// The orchestration (when to enqueue, when and how to drain the queue once a
// turn finishes, the actual ignore decision) lives in src/discord/events.js;
// this module only knows about the list itself.

/**
 * @typedef {object} PendingPing
 * @property {string} channelId
 * @property {*} channel        the discord.js channel object the ping arrived in
 * @property {object} trigger   the normalized message that called the persona
 * @property {'mention'|'reply'} kind
 * @property {number} arrivedAt
 */

/** Index of the entry with the smallest `arrivedAt` in a non-empty list, or -1 for an empty one. */
function oldestIndex(list) {
  if (list.length === 0) return -1;
  let index = 0;
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].arrivedAt < list[index].arrivedAt) index = i;
  }
  return index;
}

/**
 * Add `ping` to `list`, replacing any existing pending ping already queued
 * for the same channel, then evict the single oldest entry across all
 * channels if the result exceeds `maxPending`.
 * @param {PendingPing[]} list
 * @param {PendingPing} ping
 * @param {number} maxPending
 * @returns {{ list: PendingPing[], evicted: PendingPing|null }}
 */
export function addPending(list, ping, maxPending) {
  const next = [...list.filter((p) => p.channelId !== ping.channelId), ping];
  if (next.length <= maxPending) return { list: next, evicted: null };
  const index = oldestIndex(next);
  const evicted = next[index];
  return { list: next.filter((_, i) => i !== index), evicted };
}

/** Whether `ping` is past `pendingMinutes` from the time it arrived, at `now`. */
export function isExpired(ping, now, pendingMinutes) {
  return now - ping.arrivedAt >= pendingMinutes * 60_000;
}

/**
 * Remove and return the single oldest entry of `list` (by `arrivedAt`),
 * regardless of expiry -- the caller checks `isExpired` itself so it can log
 * an 'expired' line for every one discarded on the way to a live pick.
 * @param {PendingPing[]} list
 * @returns {{ ping: PendingPing|null, list: PendingPing[] }}
 */
export function popOldest(list) {
  const index = oldestIndex(list);
  if (index === -1) return { ping: null, list };
  return { ping: list[index], list: list.filter((_, i) => i !== index) };
}
