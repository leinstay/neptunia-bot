// Time units, the UTC day key and the per-day counter, in one place. Every
// daily rail kept in state.json (LLM requests, pictures, web reads, posted
// GIFs, video watches, the mentor's tokens) is a pair of fields -- the UTC
// day it counts for and the count -- that starts again from zero when the
// day turns; this module owns that rollover so the rails cannot drift apart:
// dailyCounter / bumpDaily for the owner that counts, countToday for every
// reader, which must never write the pair.
// Pure: the caller passes the clock reading and marks its state dirty.

/** One minute in milliseconds. */
export const MINUTE_MS = 60_000;
/** One hour in milliseconds. */
export const HOUR_MS = 60 * MINUTE_MS;
/** One day in milliseconds. */
export const DAY_MS = 24 * HOUR_MS;

/**
 * The UTC date key (`YYYY-MM-DD`) of an epoch timestamp.
 * @param {number} ms
 * @returns {string}
 */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A finite, non-negative count, or 0. */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Today's value of one daily counter kept as `state[dayKey]` / `state[countKey]`.
 * When the stored day is not the UTC day of `nowMs` the pair rolls over
 * (`state[dayKey] = day`, `state[countKey] = 0`) and `rolled` is true, so a
 * caller that persists the rollover knows to mark its state dirty. A missing
 * or invalid count reads as 0.
 * @param {object} state                                 Mutated on a rollover only.
 * @param {{ dayKey: string, countKey: string }} keys
 * @param {number} nowMs
 * @returns {{ day: string, count: number, rolled: boolean }}
 */
export function dailyCounter(state, { dayKey, countKey }, nowMs) {
  const day = utcDay(nowMs);
  let rolled = false;
  if (state[dayKey] !== day) {
    state[dayKey] = day;
    state[countKey] = 0;
    rolled = true;
  }
  return { day, count: countOf(state[countKey]), rolled };
}

/**
 * Today's value of one daily counter, read only: `state[countKey]` when
 * `state[dayKey]` is the UTC day of `nowMs`, 0 when the pair was stamped for
 * another day (yesterday's count reads as 0 from 00:00 UTC on) or carries no
 * stamp. Never writes: the pair is rolled over by dailyCounter / bumpDaily,
 * when its owner counts. For everything that only looks at a rail -- a
 * status line, a check before the work a refusal would waste. A missing or
 * invalid count reads as 0, by dailyCounter's rule; so does a `state` that
 * is not an object, and a `nowMs` that is neither a time nor a day key.
 * @param {object|null|undefined} state                  Never mutated.
 * @param {{ dayKey: string, countKey: string }} keys    The same pair dailyCounter takes.
 * @param {number|string} nowMs  The clock in epoch ms; a caller that already holds the
 *   UTC day key (`YYYY-MM-DD`, from utcDay) passes the key itself.
 * @returns {number}
 */
export function countToday(state, { dayKey, countKey }, nowMs) {
  if (state === null || typeof state !== 'object') return 0;
  let day = null;
  if (typeof nowMs === 'string') day = nowMs;
  else if (Number.isFinite(nowMs)) day = utcDay(nowMs);
  if (!day || state[dayKey] !== day) return 0;
  return countOf(state[countKey]);
}

/**
 * Add `by` to today's value of one daily counter (rolling it over first, see
 * dailyCounter) and return the new value.
 * @param {object} state
 * @param {{ dayKey: string, countKey: string }} keys
 * @param {number} nowMs
 * @param {number} [by]
 * @returns {{ day: string, count: number }}
 */
export function bumpDaily(state, keys, nowMs, by = 1) {
  const { day, count } = dailyCounter(state, keys, nowMs);
  const next = count + by;
  state[keys.countKey] = next;
  return { day, count: next };
}
