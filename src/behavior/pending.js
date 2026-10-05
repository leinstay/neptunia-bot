// Pure queue of "pending" direct pings: a @mention or a reply to the persona
// that arrived while a turn was running in its own channel
// (config.mention.pendingSameChannel) or, with one attention
// (config.mention.oneAtATime), somewhere else; a private message waiting for
// the same reason; a call from a channel the persona cannot write in, routed
// to the main channel (its `destination`), whose turn found the attention
// taken. At most one pending ping per channel the call was written in
// (a newer one replaces an older one in the same channel; a routed call keeps
// its source's slot, so it never replaces a ping written in its destination)
// and at most mention.maxPending entries overall; the single oldest entry,
// of any channel, is evicted when full. A routed call that takes the slot of
// an older one of its source carries that call along (`superseded`), so
// whatever ends the newer one -- the ignore roll letting it pass -- can end
// the older one too. In-memory only, never persisted -- a restart forgetting
// every pending ping is fine.
//
// The orchestration (when to enqueue, when and how to drain the queue once a
// turn finishes, the actual ignore decision) lives in src/discord/events.js;
// this module only knows about the list itself.

/**
 * @typedef {object} PendingPing
 * @property {string} channelId   the channel the ping arrived in: the queue's slot key
 * @property {*} channel        the discord.js channel object the ping arrived in
 * @property {object} trigger   the normalized message that called the persona
 * @property {'mention'|'reply'|'private'} kind
 * @property {number} arrivedAt
 * @property {boolean} [decided] set on a re-queued server ping whose ignore roll already said respond
 * @property {*} [destination]  a routed call only: the discord.js channel its turn posts in (the
 *                              main channel), while `channelId` / `channel` stay its source
 * @property {string[]} [superseded]  a routed call only: the message ids of the calls of its source
 *                              it took the place of (in the settle wait or in this queue), each once
 */

/**
 * `ping` carrying the call `older` was waiting with, and every call `older`
 * itself carried, in `superseded` (each id once) -- a new object, neither
 * input mutated. Only a routed ping (one with a `destination`) carries them;
 * any other comes back as it is.
 */
function takingOver(ping, older) {
  if (!ping.destination || !older) return ping;
  const ids = [...(ping.superseded ?? []), ...(older.superseded ?? []), older.trigger?.id];
  return { ...ping, superseded: [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))] };
}

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
 * for the same channel (`channelId`: a routed call's source, never its
 * destination), then evict the single oldest entry across all channels if
 * the result exceeds `maxPending` -- a routed call may push out a ping of its
 * destination. The caller logs whatever comes back as `replaced` (the entry
 * of the same channel `ping` took the place of) or `evicted`. A routed `ping`
 * that replaces one is queued as a copy carrying the replaced call in
 * `superseded` (takingOver); any other is queued as it is.
 * @param {PendingPing[]} list
 * @param {PendingPing} ping
 * @param {number} maxPending
 * @returns {{ list: PendingPing[], evicted: PendingPing|null, replaced: PendingPing|null }}
 */
export function addPending(list, ping, maxPending) {
  const replaced = list.find((p) => p.channelId === ping.channelId) ?? null;
  const next = [...list.filter((p) => p.channelId !== ping.channelId), takingOver(ping, replaced)];
  if (next.length <= maxPending) return { list: next, evicted: null, replaced };
  const index = oldestIndex(next);
  const evicted = next[index];
  return { list: next.filter((_, i) => i !== index), evicted, replaced };
}

/**
 * Put back a ping the drain picked up but could not answer (its turn found
 * another one running), keeping its original `arrivedAt`. Unlike
 * `addPending`, it never replaces a NEWER ping queued for the same channel
 * meanwhile: that one wins and `ping` comes back as `dropped` (a routed
 * winner is replaced by a copy carrying `ping`'s call in `superseded`, as if
 * it had taken the slot from it). Otherwise it is added like `addPending`,
 * `maxPending`, `replaced` and `superseded` included (the evicted entry may
 * be `ping` itself, being the oldest).
 * @param {PendingPing[]} list
 * @param {PendingPing} ping
 * @param {number} maxPending
 * @returns {{ list: PendingPing[], dropped: PendingPing|null, evicted: PendingPing|null, replaced: PendingPing|null }}
 */
export function requeuePending(list, ping, maxPending) {
  const newer = list.find((p) => p.channelId === ping.channelId && p.arrivedAt >= ping.arrivedAt);
  if (newer) return { list: list.map((p) => (p === newer ? takingOver(p, ping) : p)), dropped: ping, evicted: null, replaced: null };
  const { list: next, evicted, replaced } = addPending(list, ping, maxPending);
  return { list: next, dropped: null, evicted, replaced };
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
