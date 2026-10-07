// Tests for src/memory/notes-refresh.js: the pure due rules for one channel's notes
// (channelNotesDue) and the server notes (serverNotesDue), the pick order (pickDueNotes), and the
// scheduler (createNotesScheduler) against a fake store and fake refresh functions. The refresh
// functions themselves (src/memory/warmup.js) are tested in tests/warmup.test.js. No network, no
// real prompts.local/ or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTES_SLOTS,
  channelNotesDue,
  serverNotesDue,
  pickDueNotes,
  notesSettings,
  createNotesScheduler,
} from '../src/memory/notes-refresh.js';
import { utcDay } from '../src/time.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 7, 12);

const iso = (ms) => new Date(ms).toISOString();

/** A per-day tally of `perDay` messages on each of the `count` days before NOW (today included). */
function tally(count, perDay) {
  const days = {};
  for (let i = 0; i < count; i += 1) days[utcDay(NOW - i * DAY)] = perDay;
  return days;
}

/** The settings every pure test states itself (not config.json's values). */
function settings(extra = {}) {
  return {
    refreshDaysMain: 7,
    refreshDays: 21,
    serverRefreshDays: 7,
    perDay: 4,
    checkMinutes: 60,
    minMessages: 30,
    guildMinMessages: 100,
    retryHours: 24,
    mainChannelIds: ['main1', 'main2'],
    lookbackDays: 60,
    ...extra,
  };
}

test('channelNotesDue: main channels after notesRefreshDaysMain, others after notesRefreshDays, only with new messages and recent activity', () => {
  const cfg = settings();
  const mainFresh = { id: 'main1', purpose: 'α', topics: 'β', tone: 'γ', updatedAt: iso(NOW - 5 * DAY), notesSampleReviewedAt: null, notesAttemptAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 10) };
  // Written 20 days ago but sample-reviewed 8 days ago: the review is the reference.
  const mainDue = { id: 'main2', purpose: 'α', topics: 'β', tone: 'γ', updatedAt: iso(NOW - 20 * DAY), notesSampleReviewedAt: iso(NOW - 8 * DAY), notesAttemptAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 10) };
  const otherFresh = { id: 'o1', purpose: 'α', topics: 'β', tone: 'γ', updatedAt: iso(NOW - 10 * DAY), notesSampleReviewedAt: null, notesAttemptAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 10) };
  const otherDue = { id: 'o2', purpose: 'α', topics: 'β', tone: 'γ', updatedAt: iso(NOW - 22 * DAY), notesSampleReviewedAt: null, notesAttemptAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 10) };
  const dueButFew = { id: 'o3', purpose: 'α', topics: 'β', tone: 'γ', updatedAt: iso(NOW - 22 * DAY), notesSampleReviewedAt: null, notesAttemptAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 2) };
  // lastMessageAt is epoch milliseconds (store.touchChannel stores a message's createdTimestamp):
  // 61 days ago is quiet; the tally still holds those old days, so it is not merely few.
  const dueButQuiet = { id: 'o4', purpose: 'α', topics: 'β', tone: 'γ', updatedAt: iso(NOW - 90 * DAY), notesSampleReviewedAt: null, notesAttemptAt: null, lastMessageAt: NOW - 61 * DAY, days: { [utcDay(NOW - 62 * DAY)]: 50, [utcDay(NOW - 61 * DAY)]: 50 } };

  assert.deepEqual(channelNotesDue(mainFresh, NOW, cfg), { due: false, reason: 'fresh', overdueMs: -2 * DAY, newMessages: 60 });
  assert.deepEqual(channelNotesDue(mainDue, NOW, cfg), { due: true, reason: 'due', overdueMs: 1 * DAY, newMessages: 90 });
  assert.deepEqual(channelNotesDue(otherFresh, NOW, cfg), { due: false, reason: 'fresh', overdueMs: -11 * DAY, newMessages: 100 });
  assert.deepEqual(channelNotesDue(otherDue, NOW, cfg), { due: true, reason: 'due', overdueMs: 1 * DAY, newMessages: 100 });
  assert.deepEqual(channelNotesDue(dueButFew, NOW, cfg), { due: false, reason: 'few', overdueMs: 1 * DAY, newMessages: 20 });
  assert.equal(channelNotesDue(dueButQuiet, NOW, cfg).reason, 'quiet');

  // The unit of lastMessageAt: a message 10 days ago in epoch ms is recent; the same moment in
  // epoch seconds reads as a 1970 time and is quiet.
  assert.equal(channelNotesDue({ ...otherDue, lastMessageAt: NOW - 10 * DAY }, NOW, cfg).reason, 'due');
  assert.equal(channelNotesDue({ ...otherDue, lastMessageAt: Math.floor((NOW - 10 * DAY) / 1000) }, NOW, cfg).reason, 'quiet');

  // Main by the configured ids only: the same channel under another id waits the longer days.
  assert.equal(channelNotesDue({ ...mainDue, id: 'o9' }, NOW, cfg).reason, 'fresh');
});

test('channelNotesDue: a channel without any notes text is never due for a refresh (never-written), an attempt within notesRetryHours waits', () => {
  const cfg = settings();
  const blank = { id: 'o1', purpose: '', topics: '  ', tone: '', updatedAt: null, notesSampleReviewedAt: null, notesAttemptAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 50) };
  assert.equal(channelNotesDue(blank, NOW, cfg).due, false);
  assert.equal(channelNotesDue(blank, NOW, cfg).reason, 'never-written');

  const base = { id: 'o2', purpose: 'α', topics: '', tone: '', updatedAt: iso(NOW - 30 * DAY), notesSampleReviewedAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 10) };
  assert.deepEqual(channelNotesDue({ ...base, notesAttemptAt: iso(NOW - 23 * HOUR) }, NOW, cfg), { due: false, reason: 'retry-wait', overdueMs: 9 * DAY, newMessages: 100 });
  assert.equal(channelNotesDue({ ...base, notesAttemptAt: iso(NOW - 25 * HOUR) }, NOW, cfg).reason, 'due');

  // Garbage never throws and is never due.
  assert.equal(channelNotesDue(null, NOW, cfg).due, false);
  assert.equal(channelNotesDue('x', NOW, cfg).due, false);
});

test('serverNotesDue: due after notesServerRefreshDays with notesGuildMinMessages summed over channels', () => {
  const cfg = settings();
  const channels = [
    { id: 'c1', days: tally(10, 6) },
    { id: 'c2', days: tally(10, 5) },
  ];
  const guild = { patterns: 'α', starters: '', injokes: [], notesUpdatedAt: iso(NOW - 9 * DAY), notesSampleReviewedAt: null, notesAttemptAt: null };
  // Ten days of 11 messages; the reference day and every day after it count.
  assert.deepEqual(serverNotesDue(guild, channels, NOW, cfg), { due: true, reason: 'due', overdueMs: 2 * DAY, newMessages: 110 });

  assert.equal(serverNotesDue({ ...guild, notesSampleReviewedAt: iso(NOW - 3 * DAY) }, channels, NOW, cfg).reason, 'fresh');
  assert.deepEqual(serverNotesDue(guild, channels, NOW, settings({ guildMinMessages: 111 })), { due: false, reason: 'few', overdueMs: 2 * DAY, newMessages: 110 });
  assert.equal(serverNotesDue({ ...guild, notesAttemptAt: iso(NOW - HOUR) }, channels, NOW, cfg).reason, 'retry-wait');

  // Patterns and starters both empty: never written, injokes alone do not count.
  assert.equal(serverNotesDue({ ...guild, patterns: '', starters: ' ', injokes: ['ε'] }, channels, NOW, cfg).reason, 'never-written');
  assert.equal(serverNotesDue(null, channels, NOW, cfg).due, false);
});

test('pickDueNotes: longest overdue first, then most new messages; the server comes after the channels and outside the limit', () => {
  const cfg = settings();
  const ch = (id, ageDays, perDay) => ({ id, purpose: 'α', topics: 'β', tone: 'γ', updatedAt: iso(NOW - ageDays * DAY), notesSampleReviewedAt: null, notesAttemptAt: null, lastMessageAt: NOW - HOUR, days: tally(10, perDay) });
  const channels = [
    ch('b', 25, 10), // overdue 4 days, 100 new
    ch('a', 25, 10), // the same as b: the id breaks the tie
    ch('c', 30, 5), // overdue 9 days, 50 new
    ch('d', 25, 20), // overdue 4 days, 200 new
    ch('e', 10, 50), // fresh
    { id: 'f', purpose: '', topics: '', tone: '', updatedAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 50) }, // never written
  ];
  const guild = { patterns: 'α', starters: 'β', injokes: [], notesUpdatedAt: iso(NOW - 8 * DAY), notesSampleReviewedAt: null, notesAttemptAt: null };

  const all = pickDueNotes(channels, guild, NOW, cfg, Infinity);
  assert.deepEqual(all.map((entry) => entry.target), ['c', 'd', 'a', 'b', 'guild']);
  assert.deepEqual(all[0], { target: 'c', overdueMs: 9 * DAY, newMessages: 50, reason: 'due' });
  assert.deepEqual(all[4], { target: 'guild', overdueMs: 1 * DAY, newMessages: 1305, reason: 'due' });

  assert.deepEqual(pickDueNotes(channels, guild, NOW, cfg, 2).map((entry) => entry.target), ['c', 'd', 'guild'], 'the limit cuts channels only');
  assert.deepEqual(pickDueNotes(channels, guild, NOW, cfg, 0).map((entry) => entry.target), ['guild']);
  assert.deepEqual(pickDueNotes(channels, null, NOW, cfg, 1).map((entry) => entry.target), ['c']);
});

// ---------------------------------------------------------------------------
// createNotesScheduler
// ---------------------------------------------------------------------------

function fakeStore(channels, guild, data = {}) {
  return {
    state: {
      data,
      dirty: 0,
      markDirty() {
        this.dirty += 1;
      },
    },
    listChannels(guildId) {
      return guildId === 'g1' ? channels : [];
    },
    getGuild(guildId) {
      return guildId === 'g1' ? guild : null;
    },
  };
}

function schedulerHot(extra = {}) {
  return {
    config: {
      features: {},
      llm: { maxRequestsPerDay: 500 },
      memory: {
        notesRefreshDaysMain: 7,
        notesRefreshDays: 21,
        notesServerRefreshDays: 7,
        notesRefreshPerDay: 4,
        notesCheckMinutes: 60,
        notesMinMessages: 30,
        notesGuildMinMessages: 100,
        notesRetryHours: 24,
        mainChannelIds: [],
      },
      warmup: { lookbackDays: 60 },
      ...extra,
    },
  };
}

/** A fake refresh: `script(target, call)` gives the outcome; calls are recorded. */
function fakeRefresh(script = () => ({ ok: true, changed: false })) {
  const calls = [];
  const refresh = async (guildId, channelId) => {
    calls.push({ guildId, channelId });
    return script(channelId ?? 'guild', calls.length - 1);
  };
  refresh.calls = calls;
  return refresh;
}

function schedulerChannels() {
  const ch = (id, ageDays, extra = {}) => ({ id, purpose: 'α', topics: 'β', tone: 'γ', updatedAt: iso(NOW - ageDays * DAY), notesSampleReviewedAt: null, notesAttemptAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 10), ...extra });
  return [
    ch('c1', 40), // due, overdue 19 days
    ch('c2', 30), // due, overdue 9 days
    ch('c3', 25), // due, overdue 4 days
    ch('c4', 25, { notesSampleReviewedAt: iso(NOW - 5 * DAY) }), // fresh, reviewed
    ch('c5', 30, { days: tally(10, 1) }), // few
    ch('c6', 90, { lastMessageAt: NOW - 70 * DAY, days: { [utcDay(NOW - 70 * DAY)]: 100 } }), // quiet
    ch('c7', 30, { notesAttemptAt: iso(NOW - HOUR) }), // retry-wait
    { id: 'c8', purpose: '', topics: '', tone: '', updatedAt: null, notesSampleReviewedAt: null, lastMessageAt: NOW - HOUR, days: tally(10, 10) }, // never written
  ];
}

function freshGuild() {
  return { patterns: 'α', starters: 'β', injokes: [], notesUpdatedAt: iso(NOW - 2 * DAY), notesSampleReviewedAt: null, notesAttemptAt: null };
}

function makeScheduler({ channels = schedulerChannels(), guild = freshGuild(), data = {}, extra, channelScript, serverScript, warming = false } = {}) {
  const store = fakeStore(channels, guild, data);
  const clock = { now: NOW };
  const hot = schedulerHot(extra);
  const refreshChannelNotes = fakeRefresh(channelScript);
  const refreshServerNotes = fakeRefresh(serverScript);
  const state = { warming };
  const scheduler = createNotesScheduler({
    hot,
    store,
    refreshChannelNotes,
    refreshServerNotes,
    isWarmingUp: () => state.warming,
    getGuildId: () => 'g1',
    now: () => clock.now,
  });
  return { scheduler, store, clock, hot, refreshChannelNotes, refreshServerNotes, state };
}

test('notes scheduler: tick refreshes up to the free slots, counts only successes, ends the cycle on llm-error and reports buckets', async () => {
  // One of today's four slots is already taken: three free.
  const ctx = makeScheduler({
    data: { notesRefreshDay: utcDay(NOW), notesRefreshCount: 1 },
    channelScript: (id) => (id === 'c2' ? { ok: false, reason: 'llm-error', detail: 'http-500' } : { ok: true, changed: true }),
  });
  const outcome = await ctx.scheduler.tick();
  assert.deepEqual(ctx.refreshChannelNotes.calls.map((c) => c.channelId), ['c1', 'c2'], 'the llm-error ends the cycle');
  assert.equal(ctx.refreshServerNotes.calls.length, 0);
  assert.equal(ctx.store.state.data.notesRefreshCount, 2, 'only the success took a slot');
  assert.deepEqual(outcome, {
    ran: true,
    due: 3,
    started: 2,
    refreshed: 1,
    changed: 1,
    skipped: 2,
    buckets: { neverReviewed: 6, fresh: 1, due: 3, few: 1, quiet: 1, retryWait: 1 },
  });
  assert.equal(ctx.store.state.data.notesRefreshLookAt, NOW);

  // Within notesCheckMinutes: too soon, nothing asked.
  ctx.clock.now = NOW + 30 * MINUTE;
  assert.deepEqual(await ctx.scheduler.tick(), { ran: false, reason: 'too-soon' });
  assert.equal(ctx.refreshChannelNotes.calls.length, 2);

  // One free slot: one channel, then the server (outside the cap); too-few moves on.
  const tight = makeScheduler({
    data: { notesRefreshDay: utcDay(NOW), notesRefreshCount: 3 },
    guild: { ...freshGuild(), notesUpdatedAt: iso(NOW - 10 * DAY) },
    channelScript: () => ({ ok: false, reason: 'too-few' }),
  });
  const tightOutcome = await tight.scheduler.tick();
  assert.deepEqual(tight.refreshChannelNotes.calls.map((c) => c.channelId), ['c1']);
  assert.equal(tight.refreshServerNotes.calls.length, 1, 'too-few moves on to the server');
  assert.equal(tight.store.state.data.notesRefreshCount, 3, 'neither a failure nor the server takes a slot');
  assert.equal(tightOutcome.started, 2);
  assert.equal(tightOutcome.refreshed, 1);

  // No free slot and the server fresh: daily-cap, nothing asked.
  const exhausted = makeScheduler({ data: { notesRefreshDay: utcDay(NOW), notesRefreshCount: 4 } });
  assert.deepEqual(await exhausted.scheduler.tick(), { ran: false, reason: 'daily-cap' });
  assert.equal(exhausted.refreshChannelNotes.calls.length, 0);

  const none = makeScheduler({ channels: [schedulerChannels()[3]] });
  assert.deepEqual(await none.scheduler.tick(), { ran: false, reason: 'none-due' });
});

test('notes scheduler: features.notesRefresh false is off; a warmup in flight is warming-up; the llm daily cap stops before any request', async () => {
  const off = makeScheduler({ extra: { features: { notesRefresh: false } } });
  assert.deepEqual(await off.scheduler.tick(), { ran: false, reason: 'off' });
  const memoryOff = makeScheduler({ extra: { features: { memory: false } } });
  assert.deepEqual(await memoryOff.scheduler.tick(), { ran: false, reason: 'off' });

  const paused = makeScheduler({ data: { paused: true } });
  assert.deepEqual(await paused.scheduler.tick(), { ran: false, reason: 'paused' });

  const warming = makeScheduler({ warming: true });
  assert.deepEqual(await warming.scheduler.tick(), { ran: false, reason: 'warming-up' });
  assert.equal(warming.refreshChannelNotes.calls.length, 0);
  warming.state.warming = false;
  assert.equal((await warming.scheduler.tick()).ran, true, 'the warmup ended: the next tick looks');

  const capped = makeScheduler({ extra: { llm: { maxRequestsPerDay: 10 } }, data: { llmDay: utcDay(NOW), llmCount: 10 } });
  assert.deepEqual(await capped.scheduler.tick(), { ran: false, reason: 'daily-cap' });
  assert.equal(capped.refreshChannelNotes.calls.length + capped.refreshServerNotes.calls.length, 0);

  // A daily-cap answer mid-cycle ends it too.
  const refused = makeScheduler({ channelScript: () => ({ ok: false, reason: 'daily-cap' }) });
  await refused.scheduler.tick();
  assert.equal(refused.refreshChannelNotes.calls.length, 1);

  // The settings' fallbacks are config.json's values.
  assert.deepEqual(notesSettings({}), {
    refreshDaysMain: 7,
    refreshDays: 21,
    serverRefreshDays: 7,
    perDay: 4,
    checkMinutes: 60,
    minMessages: 30,
    guildMinMessages: 100,
    retryHours: 24,
    mainChannelIds: [],
    lookbackDays: 60,
  });
  assert.deepEqual(NOTES_SLOTS, { dayKey: 'notesRefreshDay', countKey: 'notesRefreshCount' });
});
