// The memory as it stood at a real moment of the chat. A mentor anchor
// (src/mentor/anchor.js) is replayed with today's memory, and today's memory
// already holds what the analyzer wrote AFTER that exchange: moments about the
// very argument being replayed, the attitude change it caused, what was
// learned from it. Answering the moment with that memory would let the
// persona "remember" how it ended. This module wraps a sandbox view
// (src/mentor/sandbox.js#liveView, or another view of the same shape) in one
// whose memory reads leave out every dated item written at or after the
// moment's cutoff (the newest line she saw: the trigger's time, or a later
// line her request held). Only the items listed at `momentView` are filtered;
// everything else passes through as it is today: a profile's names and
// counters, the guild's `patterns`, `starters`, `injokes` and `self`, the
// channel entries, the current text of a lore entry or an interest updated
// later -- and a profile's `relationship` text and its portrait (`character`,
// `style`), although both now carry the time they were written
// (`relationshipWrittenAt`, `portraitRefreshedAt`): a replay shows the ones
// written after the moment (whether to hide or flag them is the owner's open
// decision). Everything here is pure: the base view is read at call time and
// never changed, nothing is cached.

import { utcDay } from '../time.js';
import { newestSeenTs } from './anchor.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The kinds of hidden items, in the order the counts are reported. */
const KINDS = ['episodes', 'affinity', 'reasons', 'details', 'interests', 'aliases', 'learned', 'lore'];

function zeroCounts() {
  return Object.fromEntries(KINDS.map((kind) => [kind, 0]));
}

/** The time (ms) of an ISO string or an epoch number; null when there is none. */
function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether a dated value is at or after `cutoff`; an undated one never is. */
function isLater(value, cutoff) {
  const ms = timeOf(value);
  return ms !== null && ms >= cutoff;
}

/**
 * Whether an episode was written at or after `cutoff`: by its `addedAt` (when
 * the analyzer stored it); without one, by its `date`, day by day -- an
 * episode dated the cutoff's day or later is hidden, as that day may hold the
 * moment itself. An episode with neither is kept.
 */
function isLaterEpisode(episode, cutoff) {
  if (timeOf(episode?.addedAt) !== null) return isLater(episode.addedAt, cutoff);
  if (typeof episode?.date === 'string' && DAY_RE.test(episode.date)) return episode.date >= utcDay(cutoff);
  return false;
}

/** `list` without the items `later` flags, and how many were left out; a non-array passes through. */
function keepBefore(list, later) {
  if (!Array.isArray(list)) return { list, hidden: 0 };
  const kept = list.filter((item) => !later(item));
  return { list: kept, hidden: list.length - kept.length };
}

/**
 * An affinity without the history entries at or after `cutoff`. When the
 * newest stored entry is one of them, the current `reason` came from it (or
 * from a later one): it falls back to the reason of the newest entry kept that
 * has one -- an entry may carry an empty reason (a two-stage move not worded
 * yet, see src/memory/affinity.js#applyDelta), and the stored reason then
 * stayed the earlier one -- or to none. The score is left as stored.
 */
function affinityBefore(affinity, cutoff) {
  if (!affinity || typeof affinity !== 'object' || !Array.isArray(affinity.history)) return { affinity, hidden: 0, reasons: 0 };
  const { list: history, hidden } = keepBefore(affinity.history, (entry) => isLater(entry?.ts, cutoff));
  if (hidden === 0) return { affinity, hidden: 0, reasons: 0 };
  const newest = affinity.history[affinity.history.length - 1];
  if (!isLater(newest?.ts, cutoff)) return { affinity: { ...affinity, history }, hidden, reasons: 0 };
  const worded = history.findLast((entry) => typeof entry?.reason === 'string' && entry.reason !== '');
  return { affinity: { ...affinity, history, reason: worded ? worded.reason : '' }, hidden, reasons: 1 };
}

/**
 * A member's profile as it stood before `cutoff`: episodes, affinity history
 * (and the reason it produced), details, interests and aliases first recorded
 * at or after the cutoff left out. A new object when anything was hidden, the
 * stored profile itself otherwise; null for null.
 * @returns {{ profile: object|null, hidden: object }}
 */
function profileBefore(profile, cutoff) {
  const hidden = zeroCounts();
  if (!profile || typeof profile !== 'object') return { profile, hidden };
  const firstSeenLater = (item) => isLater(item?.firstSeen, cutoff);
  const episodes = keepBefore(profile.episodes, (episode) => isLaterEpisode(episode, cutoff));
  const details = keepBefore(profile.details, firstSeenLater);
  const interests = keepBefore(profile.interests, firstSeenLater);
  const aliases = keepBefore(profile.aliases, firstSeenLater);
  const affinity = affinityBefore(profile.affinity, cutoff);
  hidden.episodes = episodes.hidden;
  hidden.details = details.hidden;
  hidden.interests = interests.hidden;
  hidden.aliases = aliases.hidden;
  hidden.affinity = affinity.hidden;
  hidden.reasons = affinity.reasons;
  if (KINDS.every((kind) => hidden[kind] === 0)) return { profile, hidden };
  const out = { ...profile };
  if (episodes.hidden) out.episodes = episodes.list;
  if (details.hidden) out.details = details.list;
  if (interests.hidden) out.interests = interests.list;
  if (aliases.hidden) out.aliases = aliases.list;
  if (affinity.hidden) out.affinity = affinity.affinity;
  return { profile: out, hidden };
}

/** The guild memory before `cutoff`: learned items first recorded at or after it left out. */
function guildBefore(guild, cutoff) {
  if (!guild || typeof guild !== 'object') return { guild, hidden: 0 };
  const learned = keepBefore(guild.learned, (item) => isLater(item?.firstSeen, cutoff));
  return learned.hidden ? { guild: { ...guild, learned: learned.list }, hidden: learned.hidden } : { guild, hidden: 0 };
}

/** The lorebook before `cutoff`: entries created at or after it left out. */
function loreBefore(entries, cutoff) {
  return keepBefore(entries, (entry) => isLater(entry?.createdAt, cutoff));
}

/**
 * The recent store (src/memory/store.js#getRecent) before `cutoff`: the lines
 * the analyzer added at or after it left out (by `addedAt`; a line without
 * one, by the time of the moment it is about, `at`). A new object when a line
 * was hidden, the given one otherwise; a value without `lines` (a view
 * without a recent store reads null) passes through.
 */
function recentBefore(recent, cutoff) {
  if (!recent || typeof recent !== 'object' || !Array.isArray(recent.lines)) return recent;
  const { list, hidden } = keepBefore(recent.lines, (line) => isLater(timeOf(line?.addedAt) !== null ? line.addedAt : line?.at, cutoff));
  return hidden ? { ...recent, lines: list } : recent;
}

/**
 * When a replayed moment's memory stops: the time of the newest line the
 * persona saw (src/mentor/anchor.js#newestSeenTs: the last message of its
 * stored `history`, or its trigger when that is newer -- a call in another
 * channel, found by `triggerId` in its stored windows), else its `at` (when
 * the persona answered); null when neither is known (nothing is then
 * hidden). Pure.
 * @param {{ history?: object[], triggerId?: string|null, pulled?: object[], mode?: string|null, at?: number }} situation
 * @returns {number|null}
 */
export function momentCutoff(situation) {
  const seen = newestSeenTs(situation);
  if (seen !== null) return seen;
  return Array.isArray(situation?.history) && Number.isFinite(situation?.at) ? situation.at : null;
}

/**
 * A view of the same shape as `base` (src/mentor/sandbox.js#liveView)
 * whose memory is the base memory as it
 * stood before `cutoff`: every dated item written at or after it is left out
 * -- a member's episodes (by `addedAt`; without one, those dated the cutoff's
 * day or later), affinity history entries (by `ts`; when the newest one goes,
 * `reason` falls back to that of the newest kept entry that has one, or to '';
 * the score stays),
 * details, interests and aliases (by `firstSeen`), the guild's learned items
 * (by `firstSeen`), lore entries (by `createdAt`) and the recent store's
 * lines (by `addedAt`, else by their moment `at`; null for a base without
 * `getRecent`). Undated items and every other field pass through; `prompts`,
 * `config`, `calibrator` and `listChannels` are the base's, read at call
 * time. The base is never written and nothing is cached. Pure.
 * @param {object} base
 * @param {number} cutoff  Epoch ms.
 * @returns {object}
 */
export function momentView(base, cutoff) {
  return {
    get prompts() {
      return base.prompts;
    },
    get config() {
      return base.config;
    },
    get calibrator() {
      return base.calibrator;
    },
    memory: {
      getGuild: () => guildBefore(base.memory.getGuild(), cutoff).guild,
      getUser: (id) => profileBefore(base.memory.getUser(id), cutoff).profile,
      listUserProfiles: () => (base.memory.listUserProfiles() ?? []).map((profile) => profileBefore(profile, cutoff).profile),
      listChannels: () => base.memory.listChannels(),
      getLore: () => loreBefore(base.memory.getLore(), cutoff).list,
      getRecent: () => recentBefore(typeof base.memory.getRecent === 'function' ? base.memory.getRecent() : null, cutoff),
    },
  };
}

/**
 * How many items `momentView(base, cutoff)` leaves out over the whole memory,
 * by kind: `episodes`, `affinity` (history entries), `reasons` (attitudes
 * whose reason fell back), `details`, `interests`, `aliases`, `learned`,
 * `lore`. The recent lines it leaves out are not counted. Counts only, for
 * the log. Pure.
 * @param {object} base
 * @param {number} cutoff
 * @returns {{ episodes: number, affinity: number, reasons: number, details: number, interests: number,
 *   aliases: number, learned: number, lore: number }}
 */
export function hiddenLater(base, cutoff) {
  const counts = zeroCounts();
  for (const profile of base.memory.listUserProfiles() ?? []) {
    const { hidden } = profileBefore(profile, cutoff);
    for (const kind of KINDS) counts[kind] += hidden[kind];
  }
  counts.learned += guildBefore(base.memory.getGuild(), cutoff).hidden;
  counts.lore += loreBefore(base.memory.getLore(), cutoff).hidden;
  return counts;
}
