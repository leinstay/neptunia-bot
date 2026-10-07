// Channel and server notes refreshed on a schedule. A channel's `purpose`/`topics`/`tone` and the
// server's `patterns`/`starters`/`injokes` are written by the warmup; afterwards the stream
// analyzer only sees one batch of live lines at a time and rarely has the evidence to rewrite a
// description of weeks of conversation, so without this module the notes stay at their warmup
// text however much the place changes. Here code decides when a target is overdue and asks
// src/memory/warmup.js to re-describe it from a sample spread over recent days
// (`refreshChannelNotes` / `refreshServerNotes`). A channel is due when `memory.notesRefreshDaysMain`
// (a channel in `memory.mainChannelIds`) or `memory.notesRefreshDays` (any other) passed since its
// notes were last written or sample-reviewed, at least `memory.notesMinMessages` messages were
// counted there since then (its per-day tally), it had a message within `warmup.lookbackDays`, and
// no failed attempt happened within `memory.notesRetryHours`. The server is due by the same rule
// with `memory.notesServerRefreshDays` and `memory.notesGuildMinMessages` summed over every
// channel. A target the warmup never described is left to the warmup. The scheduler guarantees:
// at most one look every `memory.notesCheckMinutes` (the last look kept in state.json, so a restart
// does not look again at once), at most `memory.notesRefreshPerDay` successful channel refreshes a
// UTC day (`NOTES_SLOTS`; the server has its own cadence and stays outside that cap), nothing
// started while paused, warming up, or once the LLM's own daily request cap is used up, and a
// cycle that ends at the first failure saying the next request would fail too.

import { log } from '../log.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, bumpDaily, dailyCounter } from '../time.js';
import { messagesSince } from './channels.js';
import { hasText, llmCapReached, stampMs } from './portrait.js';
import { errorNameOf } from './update.js';

/** The notes refresh's daily counter in state.json (`state.notesRefreshDay` / `notesRefreshCount`):
 * every channel refresh that came back `ok` takes one slot; the server refresh takes none. */
export const NOTES_SLOTS = { dayKey: 'notesRefreshDay', countKey: 'notesRefreshCount' };

/** The refresh outcomes that end a cycle: the next request would fail the same way. */
const CYCLE_ENDERS = new Set(['llm-error', 'daily-cap', 'paused', 'running', 'token-limit']);

/** The guild's target id in a `pickDueNotes` entry. */
const GUILD_TARGET = 'guild';

/**
 * The notes refresh settings, read from the live config at the moment of use. Every fallback
 * equals config.json; a daily cap that is not a number counts as config.json's value.
 * @param {object} [config]  The live config.
 * @returns {{ refreshDaysMain: number, refreshDays: number, serverRefreshDays: number, perDay: number,
 *   checkMinutes: number, minMessages: number, guildMinMessages: number, retryHours: number,
 *   mainChannelIds: string[], lookbackDays: number }}
 *   From `memory.notesRefreshDaysMain`, `notesRefreshDays`, `notesServerRefreshDays`,
 *   `notesRefreshPerDay`, `notesCheckMinutes`, `notesMinMessages`, `notesGuildMinMessages`,
 *   `notesRetryHours`, `mainChannelIds` and `warmup.lookbackDays`.
 */
export function notesSettings(config) {
  const memory = config?.memory ?? {};
  const warmup = config?.warmup ?? {};
  return {
    refreshDaysMain: memory.notesRefreshDaysMain ?? 7,
    refreshDays: memory.notesRefreshDays ?? 21,
    serverRefreshDays: memory.notesServerRefreshDays ?? 7,
    perDay: Number.isFinite(memory.notesRefreshPerDay) ? memory.notesRefreshPerDay : 4,
    checkMinutes: memory.notesCheckMinutes ?? 60,
    minMessages: memory.notesMinMessages ?? 30,
    guildMinMessages: memory.notesGuildMinMessages ?? 100,
    retryHours: memory.notesRetryHours ?? 24,
    mainChannelIds: Array.isArray(memory.mainChannelIds) ? memory.mainChannelIds.map(String) : [],
    lookbackDays: warmup.lookbackDays ?? 60,
  };
}

/** The later of two ISO stamps in epoch ms; null when neither reads as a time. */
function latestStamp(a, b) {
  const x = stampMs(a);
  const y = stampMs(b);
  if (x === null) return y;
  if (y === null) return x;
  return Math.max(x, y);
}

/** Whether `id` is listed in `mainChannelIds` (an array or a Set of ids). */
function isMain(id, mainChannelIds) {
  if (mainChannelIds instanceof Set) return mainChannelIds.has(String(id));
  return Array.isArray(mainChannelIds) && mainChannelIds.map(String).includes(String(id));
}

/**
 * The shared tail of both due rules: fresh by days, then too few messages, then a recent failed
 * attempt. `reference` null (never stamped) counts as written at the epoch: overdue and every
 * tallied message new.
 */
function dueByAge({ reference, days, newMessages, minMessages, attemptAt, retryHours, nowMs, quiet }) {
  const overdueMs = nowMs - ((reference ?? 0) + days * DAY_MS);
  const verdict = (due, reason) => ({ due, reason, overdueMs, newMessages });
  if (overdueMs < 0) return verdict(false, 'fresh');
  if (quiet) return verdict(false, 'quiet');
  if (!(newMessages >= minMessages)) return verdict(false, 'few');
  if (attemptAt !== null && nowMs - attemptAt < retryHours * HOUR_MS) return verdict(false, 'retry-wait');
  return verdict(true, 'due');
}

/**
 * Whether one channel's notes are due for a sample refresh. Pure; garbage never throws and is
 * never due. The reference time is the later of `notesSampleReviewedAt` and `updatedAt` (ISO
 * stamps); `lastMessageAt` is epoch milliseconds, as store.touchChannel stores it.
 * @param {object} channel  A stored channel (`id`, `purpose`, `topics`, `tone`, `updatedAt`,
 *   `notesSampleReviewedAt`, `notesAttemptAt`, `lastMessageAt`, `days`).
 * @param {number} nowMs
 * @param {object} cfg  From `notesSettings`.
 * @returns {{ due: boolean, reason: 'due'|'fresh'|'few'|'quiet'|'retry-wait'|'never-written',
 *   overdueMs: number, newMessages: number }}
 *   `overdueMs`: how long past the day threshold (negative while fresh); `newMessages`: messages
 *   tallied since the reference day (src/memory/channels.js#messagesSince). `never-written`: no
 *   notes text at all, the warmup's job; `fresh`: younger than `refreshDaysMain` (a main channel)
 *   or `refreshDays`; `quiet`: no message within `lookbackDays`; `few`: fewer than `minMessages`
 *   new messages; `retry-wait`: a failed attempt less than `retryHours` ago.
 */
export function channelNotesDue(channel, nowMs, cfg) {
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return { due: false, reason: 'never-written', overdueMs: 0, newMessages: 0 };
  const reference = latestStamp(channel.notesSampleReviewedAt, channel.updatedAt);
  const newMessages = messagesSince(channel, reference, nowMs).count;
  if (!hasText(channel.purpose) && !hasText(channel.topics) && !hasText(channel.tone)) {
    return { due: false, reason: 'never-written', overdueMs: 0, newMessages };
  }
  const lastMessageAt = Number.isFinite(channel.lastMessageAt) ? channel.lastMessageAt : null;
  return dueByAge({
    reference,
    days: isMain(channel.id, cfg.mainChannelIds) ? cfg.refreshDaysMain : cfg.refreshDays,
    newMessages,
    minMessages: cfg.minMessages,
    attemptAt: stampMs(channel.notesAttemptAt),
    retryHours: cfg.retryHours,
    nowMs,
    quiet: lastMessageAt !== null && cfg.lookbackDays > 0 && nowMs - lastMessageAt > cfg.lookbackDays * DAY_MS,
  });
}

/**
 * Whether the server notes are due for a sample refresh: the shape and order of
 * `channelNotesDue`, with the reference the later of `notesSampleReviewedAt` and `notesUpdatedAt`,
 * `newMessages` summed over `channels`, the threshold `guildMinMessages` and the days
 * `serverRefreshDays`. `never-written` when `patterns` and `starters` are both empty. No `quiet`:
 * a silent server is already `few`. Pure.
 * @param {object} guild  `store.getGuild(guildId)`.
 * @param {object[]} channels  `store.listChannels(guildId)`.
 * @param {number} nowMs
 * @param {object} cfg  From `notesSettings`.
 * @returns {{ due: boolean, reason: 'due'|'fresh'|'few'|'retry-wait'|'never-written', overdueMs: number, newMessages: number }}
 */
export function serverNotesDue(guild, channels, nowMs, cfg) {
  if (!guild || typeof guild !== 'object' || Array.isArray(guild)) return { due: false, reason: 'never-written', overdueMs: 0, newMessages: 0 };
  const reference = latestStamp(guild.notesSampleReviewedAt, guild.notesUpdatedAt);
  let newMessages = 0;
  for (const channel of Array.isArray(channels) ? channels : []) newMessages += messagesSince(channel, reference, nowMs).count;
  if (!hasText(guild.patterns) && !hasText(guild.starters)) return { due: false, reason: 'never-written', overdueMs: 0, newMessages };
  return dueByAge({
    reference,
    days: cfg.serverRefreshDays,
    newMessages,
    minMessages: cfg.guildMinMessages,
    attemptAt: stampMs(guild.notesAttemptAt),
    retryHours: cfg.retryHours,
    nowMs,
    quiet: false,
  });
}

/**
 * The targets due for a notes refresh: channels longest overdue first, then most new messages,
 * then by id, at most `limit` of them; the server (`target: 'guild'`) after them when due, not
 * counted against `limit` (its own day threshold is its limit). Pure; channels without an id are
 * skipped.
 * @param {object[]} channels  `store.listChannels(guildId)`.
 * @param {object|null} guild  `store.getGuild(guildId)`; null leaves the server out.
 * @param {number} nowMs
 * @param {object} cfg  From `notesSettings`.
 * @param {number} limit  A non-finite limit means no limit.
 * @returns {{ target: string, overdueMs: number, newMessages: number, reason: string }[]}
 */
export function pickDueNotes(channels, guild, nowMs, cfg, limit) {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
  const list = Array.isArray(channels) ? channels : [];
  const due = [];
  for (const channel of list) {
    if (!channel || typeof channel !== 'object' || channel.id === undefined || channel.id === null || channel.id === '') continue;
    const verdict = channelNotesDue(channel, nowMs, cfg);
    if (!verdict.due) continue;
    due.push({ target: String(channel.id), overdueMs: verdict.overdueMs, newMessages: verdict.newMessages, reason: verdict.reason });
  }
  due.sort((a, b) => b.overdueMs - a.overdueMs || b.newMessages - a.newMessages || a.target.localeCompare(b.target));
  const picked = due.slice(0, max);
  if (guild) {
    const verdict = serverNotesDue(guild, list, nowMs, cfg);
    if (verdict.due) picked.push({ target: GUILD_TARGET, overdueMs: verdict.overdueMs, newMessages: verdict.newMessages, reason: verdict.reason });
  }
  return picked;
}

/** The coverage counts over every channel: how many sit in each due state, and how many with
 * notes were never sample-reviewed. */
function bucketsOf(channels, nowMs, cfg) {
  const buckets = { neverReviewed: 0, fresh: 0, due: 0, few: 0, quiet: 0, retryWait: 0 };
  const key = { fresh: 'fresh', due: 'due', few: 'few', quiet: 'quiet', 'retry-wait': 'retryWait' };
  for (const channel of channels) {
    const verdict = channelNotesDue(channel, nowMs, cfg);
    if (verdict.reason === 'never-written') continue;
    if (key[verdict.reason]) buckets[key[verdict.reason]] += 1;
    if (stampMs(channel.notesSampleReviewedAt) === null) buckets.neverReviewed += 1;
  }
  return buckets;
}

/**
 * The scheduler that starts notes refreshes by the rules above. `tick()` is cheap and meant for a
 * one-minute timer: it returns at once with the switch off (`features.memory` or
 * `features.notesRefresh` false), while paused or warming up, without a guild, while its own
 * cycle is in flight (`busy`), before `memory.notesCheckMinutes` passed since its last look
 * (`state.notesRefreshLookAt`, epoch ms, kept across restarts), or when today's LLM requests
 * reached `llm.maxRequestsPerDay` (`daily-cap`). Otherwise it refreshes the channels of
 * `pickDueNotes` up to today's free slots (`memory.notesRefreshPerDay`, `NOTES_SLOTS`, one slot per
 * `ok` channel refresh), then the server when due, one at a time. Nothing due is `none-due`; due
 * channels with no free slot and no server due is `daily-cap`. A cycle ends at a thrown refresh
 * or an outcome in `llm-error`, `daily-cap`, `paused`, `running`, `token-limit`; `too-few`,
 * `conflict`, `gone`, `bad-json` move on to the next target. Logs `notes refresh: look` (counts
 * and buckets only) on every look that read the store.
 * @param {object} deps
 * @param {object} deps.hot  Live config; read at the moment of use.
 * @param {object} deps.store  `state.data`, `state.markDirty()`, `listChannels(guildId)`, `getGuild(guildId)`.
 * @param {(guildId: string, channelId: string) => Promise<{ ok: boolean, changed?: boolean, reason?: string }>} deps.refreshChannelNotes
 *   src/memory/warmup.js#createWarmup's `refreshChannelNotes`.
 * @param {(guildId: string) => Promise<{ ok: boolean, changed?: boolean, reason?: string }>} deps.refreshServerNotes
 *   src/memory/warmup.js#createWarmup's `refreshServerNotes`.
 * @param {() => boolean} [deps.isWarmingUp]
 * @param {() => (string|null)} deps.getGuildId
 * @param {() => number} [deps.now]
 * @returns {{ tick: () => Promise<{ ran: false, reason: string } | { ran: true, due: number, started: number,
 *   refreshed: number, changed: number, skipped: number, buckets: object }> }}
 *   `due`: every due target (uncut by the slots); `skipped`: picked targets that did not end
 *   refreshed (failed, or left when the cycle ended).
 */
export function createNotesScheduler({ hot, store, refreshChannelNotes, refreshServerNotes, isWarmingUp = () => false, getGuildId, now = Date.now }) {
  let cycling = false;

  const switchedOff = (config) => config?.features?.memory === false || config?.features?.notesRefresh === false;

  /** Today's free channel slots, rolling the counter over (and marking state dirty) on a new day. */
  function freeSlots(nowMs) {
    const { count, rolled } = dailyCounter(store.state.data, NOTES_SLOTS, nowMs);
    if (rolled) store.state.markDirty();
    return notesSettings(hot.config).perDay - count;
  }

  async function tick() {
    if (switchedOff(hot.config)) return { ran: false, reason: 'off' };
    if (store.state.data.paused) return { ran: false, reason: 'paused' };
    if (isWarmingUp()) return { ran: false, reason: 'warming-up' };
    const guildId = getGuildId?.();
    if (!guildId) return { ran: false, reason: 'no-guild' };
    if (cycling) return { ran: false, reason: 'busy' };

    const nowMs = now();
    const settings = notesSettings(hot.config);
    const lookAt = store.state.data.notesRefreshLookAt;
    if (Number.isFinite(lookAt) && nowMs - lookAt < settings.checkMinutes * MINUTE_MS) return { ran: false, reason: 'too-soon' };
    store.state.data.notesRefreshLookAt = nowMs;
    store.state.markDirty();
    if (llmCapReached(store.state.data, hot.config, nowMs)) return { ran: false, reason: 'daily-cap' };

    let channels;
    let guild;
    try {
      channels = (store.listChannels(guildId) ?? []).filter((channel) => channel && typeof channel === 'object');
      guild = store.getGuild(guildId) ?? null;
    } catch (err) {
      log.warn('notes refresh: look failed', { guildId, reason: 'store-error', error: errorNameOf(err) });
      return { ran: false, reason: 'store-error' };
    }
    const buckets = bucketsOf(channels, nowMs, settings);
    const due = pickDueNotes(channels, guild, nowMs, settings, Infinity).length;
    const picked = pickDueNotes(channels, guild, nowMs, settings, Math.max(0, freeSlots(nowMs)));
    const counts = { due, started: 0, refreshed: 0, changed: 0, skipped: 0 };
    if (picked.length === 0) {
      const reason = due > 0 ? 'daily-cap' : 'none-due';
      log.info('notes refresh: look', { guildId, reason, ...counts, ...buckets });
      return { ran: false, reason };
    }

    cycling = true;
    try {
      for (const { target } of picked) {
        const isGuild = target === GUILD_TARGET;
        if (switchedOff(hot.config) || store.state.data.paused) break;
        if (!isGuild && freeSlots(now()) <= 0) continue;
        counts.started += 1;
        let outcome;
        try {
          outcome = isGuild ? await refreshServerNotes(guildId) : await refreshChannelNotes(guildId, target);
        } catch (err) {
          log.warn('notes refresh: refresh failed', { guildId, target: isGuild ? 'server' : 'channel', channelId: isGuild ? undefined : target, error: errorNameOf(err) });
          break;
        }
        if (outcome?.ok) {
          counts.refreshed += 1;
          if (outcome.changed) counts.changed += 1;
          if (!isGuild) {
            bumpDaily(store.state.data, NOTES_SLOTS, now());
            store.state.markDirty();
          }
          continue;
        }
        if (CYCLE_ENDERS.has(outcome?.reason)) break;
      }
    } finally {
      cycling = false;
    }
    counts.skipped = picked.length - counts.refreshed;
    log.info('notes refresh: look', { guildId, ...counts, ...buckets });
    return { ran: true, ...counts, buckets };
  }

  return { tick };
}
