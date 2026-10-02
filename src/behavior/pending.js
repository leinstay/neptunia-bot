// Pure queue of "pending" direct pings: a @mention or a reply to the persona
// that arrived while a turn was running in its own channel
// (config.mention.pendingSameChannel) or, with one attention
// (config.mention.oneAtATime), somewhere else; a private message waiting for
// the same reason. At most one pending ping per channel
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
 * @property {'mention'|'reply'|'private'} kind
 * @property {number} arrivedAt
 * @property {boolean} [decided] set on a re-queued server ping whose ignore roll already said respond
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

/**
 * Put back a ping the drain picked up but could not answer (its turn found
 * another one running), keeping its original `arrivedAt`. Unlike
 * `addPending`, it never replaces a NEWER ping queued for the same channel
 * meanwhile: that one wins and `ping` comes back as `dropped`. Otherwise it
 * is added like `addPending`, `maxPending` included (the evicted entry may be
 * `ping` itself, being the oldest).
 * @param {PendingPing[]} list
 * @param {PendingPing} ping
 * @param {number} maxPending
 * @returns {{ list: PendingPing[], dropped: PendingPing|null, evicted: PendingPing|null }}
 */
export function requeuePending(list, ping, maxPending) {
  const newer = list.some((p) => p.channelId === ping.channelId && p.arrivedAt >= ping.arrivedAt);
  if (newer) return { list, dropped: ping, evicted: null };
  const { list: next, evicted } = addPending(list, ping, maxPending);
  return { list: next, dropped: null, evicted };
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
