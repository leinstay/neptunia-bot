// Tests for src/memory/portrait.js: the pure due rule (portraitDue), the pick order
// (pickDuePortraits), the members whose character text waits for the voice model
// (waitingPortraits), the refresh mode (portraitMode), the settings and their fallbacks
// (portraitSettings), and the scheduler (createPortraitScheduler) against a fake store and a fake
// refreshPortrait. The scheduler's work with the real src/memory/warmup.js#refreshPortrait (one
// history crawl per check) is tested in tests/warmup.test.js. No network, no real prompts.local/
// or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PORTRAIT_SLOTS,
  portraitDue,
  pickDuePortraits,
  portraitSettings,
  createPortraitScheduler,
  llmCapReached,
  isQueuedPortrait,
  waitingPortraits,
  portraitMode,
} from '../src/memory/portrait.js';
import { bumpDaily, utcDay } from '../src/time.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 5, 12);
const CFG = { messages: 300, days: 3, retryHours: 24, firstMessages: 30, lookbackDays: 60 };
const iso = (ms) => new Date(ms).toISOString();
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A stored profile with a portrait, seen an hour ago, no stamps unless given. */
function profile(overrides = {}) {
  return {
    id: '1',
    names: ['Ἀλκμήνη'],
    character: 'μιλάει πολύ',
    style: 'σύντομα, χωρίς τελείες',
    messageCount: 0,
    lastSeen: iso(NOW - HOUR),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// portraitDue
// ---------------------------------------------------------------------------

test('portraitDue: due at 300 own messages since the stamp and 3 days since the last refresh', () => {
  const verdict = portraitDue(
    profile({ messageCount: 1300, portraitMessageCount: 1000, portraitRefreshedAt: iso(NOW - 3 * DAY) }),
    NOW,
    CFG,
  );
  assert.deepEqual(verdict, { due: true, reason: 'due', own: 300 });
});

test('portraitDue: 299 messages after 3 days, or 300 messages after 2 days, is not due', () => {
  const fewMessages = portraitDue(profile({ messageCount: 1299, portraitMessageCount: 1000, portraitRefreshedAt: iso(NOW - 3 * DAY) }), NOW, CFG);
  assert.deepEqual(fewMessages, { due: false, reason: 'few', own: 299 });

  const tooRecent = portraitDue(profile({ messageCount: 1300, portraitMessageCount: 1000, portraitRefreshedAt: iso(NOW - 2 * DAY) }), NOW, CFG);
  assert.deepEqual(tooRecent, { due: false, reason: 'recent', own: 300 });
});

test('portraitDue: a profile with no stamps counts every message', () => {
  assert.deepEqual(portraitDue(profile({ messageCount: 450 }), NOW, CFG), { due: true, reason: 'due', own: 450 });
  assert.deepEqual(portraitDue(profile({ messageCount: 120 }), NOW, CFG), { due: false, reason: 'few', own: 120 });
});

test('portraitDue: an empty portrait is due at warmup.minMessages, with no day rule', () => {
  const empty = { character: '', style: '  ', portraitRefreshedAt: iso(NOW - HOUR), portraitMessageCount: 30 };
  assert.deepEqual(portraitDue(profile({ ...empty, messageCount: 30 }), NOW, CFG), { due: true, reason: 'first', own: 0 });
  assert.deepEqual(portraitDue(profile({ ...empty, messageCount: 29 }), NOW, CFG), { due: false, reason: 'few', own: 0 });
  // One of the two fields stored is a portrait: the counters apply.
  assert.equal(portraitDue(profile({ character: '', messageCount: 30 }), NOW, CFG).reason, 'few');
});

test('portraitDue: a failed attempt waits memory.portraitRetryHours', () => {
  const base = { messageCount: 500 };
  assert.deepEqual(portraitDue(profile({ ...base, portraitAttemptAt: iso(NOW - 23 * HOUR) }), NOW, CFG), { due: false, reason: 'retry-wait', own: 500 });
  assert.equal(portraitDue(profile({ ...base, portraitAttemptAt: iso(NOW - 24 * HOUR) }), NOW, CFG).due, true);
  assert.equal(portraitDue(profile({ ...base, portraitAttemptAt: null }), NOW, CFG).due, true, 'a cleared stamp is no stamp');
});

test('portraitDue: an empty portrait whose attempt failed waits memory.portraitRetryHours too', () => {
  const first = profile({ character: '', style: '', messageCount: 40, portraitAttemptAt: iso(NOW - HOUR) });
  assert.deepEqual(portraitDue(first, NOW, CFG), { due: false, reason: 'retry-wait', own: 40 });
});

test('portraitDue: a message count below the stamp gives 0 own messages', () => {
  // A warmup person run SETS messageCount from its window, which can land below an older stamp.
  assert.deepEqual(portraitDue(profile({ messageCount: 100, portraitMessageCount: 400 }), NOW, CFG), { due: false, reason: 'few', own: 0 });
});

test('portraitDue: a member silent for longer than warmup.lookbackDays is not due', () => {
  const quiet = profile({ messageCount: 900, lastSeen: iso(NOW - 61 * DAY) });
  assert.deepEqual(portraitDue(quiet, NOW, CFG), { due: false, reason: 'quiet', own: 900 });
  assert.equal(portraitDue(profile({ messageCount: 900, lastSeen: iso(NOW - 59 * DAY) }), NOW, CFG).due, true);
});

test('portraitDue: garbage in a profile or the settings never throws and is never due', () => {
  for (const garbage of [null, 'Ἀλκμήνη']) {
    assert.deepEqual(portraitDue(garbage, NOW, CFG), { due: false, reason: 'none', own: 0 });
  }
  assert.equal(portraitDue(profile({ messageCount: 'πολλά' }), NOW, CFG).due, false);
  assert.equal(portraitDue(profile({ messageCount: 900, portraitRefreshedAt: 'χθες' }), NOW, CFG).due, true, 'an unreadable stamp is no stamp');
  assert.equal(portraitDue(profile({ messageCount: 900 }), NOW, { ...CFG, messages: Number.NaN }).due, false);
  assert.equal(portraitDue(profile({ messageCount: 900, portraitRefreshedAt: iso(NOW - 9 * DAY) }), NOW, { ...CFG, days: 'three' }).due, false);
});

// ---------------------------------------------------------------------------
// waitingPortraits / isQueuedPortrait
// ---------------------------------------------------------------------------

test('waitingPortraits: the members with a public character item in the voice queue; other kinds, a private layer and garbage are not', () => {
  const queue = [
    { kind: 'character', userId: 'a', brief: { add: ['γράφει τη νύχτα'] }, createdAt: NOW },
    { kind: 'relationship', userId: 'b', brief: ['φίλοι'], createdAt: NOW },
    { kind: 'character', userId: 'c', layer: 'private', brief: { add: ['κρυφό'] }, createdAt: NOW },
    { kind: 'character', userId: '', brief: { add: ['κανείς'] }, createdAt: NOW },
    { kind: 'self', brief: ['μου αρέσει ο καφές'], createdAt: NOW },
    null,
    'character',
  ];
  assert.deepEqual([...waitingPortraits(queue)], ['a']);
  assert.deepEqual(queue.map((item) => isQueuedPortrait(item)), [true, false, false, false, false, false, false]);
  for (const garbage of [undefined, 'a']) assert.deepEqual([...waitingPortraits(garbage)], []);
});

// ---------------------------------------------------------------------------
// portraitMode
// ---------------------------------------------------------------------------

test('portraitMode: two only with the switch on and both the portrait and the voice prompt present; otherwise the single request, on the voice model while the switch is on', () => {
  const prompts = { profile: 'P', portrait: 'A', 'memory-voice': 'V' };
  assert.deepEqual(portraitMode({}, prompts), { stage: 'single', voice: false, missing: [] });
  assert.deepEqual(portraitMode({ features: { memoryTwoStage: true } }, prompts), { stage: 'two', voice: false, missing: [] });
  assert.deepEqual(portraitMode({ features: { memoryTwoStage: true } }, { ...prompts, portrait: '  ' }), { stage: 'single', voice: true, missing: ['portrait'] });
  assert.deepEqual(portraitMode({ features: { memoryTwoStage: true } }, { profile: 'P' }), { stage: 'single', voice: true, missing: ['portrait', 'memory-voice'] });
});

// ---------------------------------------------------------------------------
// llmCapReached
// ---------------------------------------------------------------------------

test('llmCapReached: today\'s LLM requests at llm.maxRequestsPerDay; another day\'s count is 0; never writes', () => {
  const config = { llm: { maxRequestsPerDay: 300 } };
  const today = { llmDay: utcDay(NOW), llmCount: 300 };
  assert.equal(llmCapReached(today, config, NOW), true);
  assert.equal(llmCapReached({ ...today, llmCount: 299 }, config, NOW), false);
  assert.equal(llmCapReached({ ...today, llmCount: 310 }, { llm: { maxRequestsPerDay: 400 } }, NOW), false, 'a live raise counts');

  const yesterday = { llmDay: utcDay(NOW - DAY), llmCount: 300 };
  assert.equal(llmCapReached(yesterday, config, NOW), false);
  assert.deepEqual(yesterday, { llmDay: utcDay(NOW - DAY), llmCount: 300 }, 'no rollover written into the LLM counter');
  assert.equal(llmCapReached({}, config, NOW), false);
});

test('llmCapReached: a cap that is not a number is left to the LLM client\'s own rail', () => {
  const today = { llmDay: utcDay(NOW), llmCount: 9999 };
  for (const cap of [undefined, 'πολλά']) {
    assert.equal(llmCapReached(today, { llm: { maxRequestsPerDay: cap } }, NOW), false);
  }
  assert.equal(llmCapReached(today, {}, NOW), false);
  assert.equal(llmCapReached(undefined, { llm: { maxRequestsPerDay: 0 } }, NOW), true, 'a cap of 0 refuses everything');
});

// ---------------------------------------------------------------------------
// pickDuePortraits
// ---------------------------------------------------------------------------

test('pickDuePortraits: most own messages first, then lastSeen; never more than the limit', () => {
  const profiles = [
    profile({ id: 'a', messageCount: 400 }),
    profile({ id: 'b', messageCount: 900 }),
    profile({ id: 'c', messageCount: 400, lastSeen: iso(NOW - 10 * 60_000) }),
    profile({ id: 'd', messageCount: 100 }), // not due
    profile({ id: 'e', character: '', style: '', messageCount: 35 }), // a first portrait
    profile({ id: 'f', messageCount: 400 }), // ties with a on own and lastSeen: by id
  ];

  assert.deepEqual(pickDuePortraits(profiles, NOW, CFG, 10), [
    { userId: 'b', own: 900, reason: 'due' },
    { userId: 'c', own: 400, reason: 'due' },
    { userId: 'a', own: 400, reason: 'due' },
    { userId: 'f', own: 400, reason: 'due' },
    { userId: 'e', own: 35, reason: 'first' },
  ]);
  assert.deepEqual(pickDuePortraits(profiles, NOW, CFG, 2).map((p) => p.userId), ['b', 'c']);
  assert.deepEqual(pickDuePortraits(profiles, NOW, CFG, 0), []);
  assert.equal(pickDuePortraits(profiles, NOW, CFG, Infinity).length, 5);
});

test('pickDuePortraits: garbage entries and entries without an id are skipped', () => {
  const profiles = [null, 'x', profile({ id: undefined, messageCount: 900 }), profile({ id: 'g', messageCount: 900 })];
  assert.deepEqual(pickDuePortraits(profiles, NOW, CFG, 5), [{ userId: 'g', own: 900, reason: 'due' }]);
  assert.deepEqual(pickDuePortraits(null, NOW, CFG, 5), []);
});

test('pickDuePortraits: a member whose character text waits for the voice model is not picked', () => {
  const profiles = [profile({ id: 'a', messageCount: 900 }), profile({ id: 'b', messageCount: 400 }), profile({ id: 'c', character: '', style: '', messageCount: 35 })];
  assert.deepEqual(pickDuePortraits(profiles, NOW, CFG, 10, { waiting: new Set(['a', 'c']) }), [{ userId: 'b', own: 400, reason: 'due' }]);
  assert.deepEqual(pickDuePortraits(profiles, NOW, CFG, 1, { waiting: new Set(['a']) }), [{ userId: 'b', own: 400, reason: 'due' }], 'the limit counts the members picked');
  assert.equal(pickDuePortraits(profiles, NOW, CFG, 10, { waiting: new Set() }).length, 3);
  assert.equal(pickDuePortraits(profiles, NOW, CFG, 10).length, 3, 'nothing waiting');
});

// ---------------------------------------------------------------------------
// portraitSettings
// ---------------------------------------------------------------------------

test('portraitSettings: every fallback equals config.json', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8'));
  assert.deepEqual(portraitSettings({}), {
    messages: config.memory.portraitRefreshMessages,
    days: config.memory.portraitRefreshDays,
    perDay: config.memory.portraitRefreshPerDay,
    retryHours: config.memory.portraitRetryHours,
    checkMinutes: config.memory.portraitCheckMinutes,
    firstMessages: config.warmup.minMessages,
    lookbackDays: config.warmup.lookbackDays,
  });
  assert.deepEqual(portraitSettings(config), portraitSettings({}));
});

test('portraitSettings: a daily cap that is not a number falls back, 0 is kept', () => {
  assert.equal(portraitSettings({ memory: { portraitRefreshPerDay: 'many' } }).perDay, portraitSettings({}).perDay);
  assert.equal(portraitSettings({ memory: { portraitRefreshPerDay: 0 } }).perDay, 0);
});

// ---------------------------------------------------------------------------
// createPortraitScheduler
// ---------------------------------------------------------------------------

function fakeStore(profiles, data = {}) {
  return {
    state: {
      data,
      dirty: 0,
      markDirty() {
        this.dirty += 1;
      },
    },
    listCalls: 0,
    listUserProfiles(guildId) {
      this.listCalls += 1;
      return guildId === 'g1' ? profiles : [];
    },
    getUser(guildId, userId) {
      return guildId === 'g1' ? profiles.find((p) => p?.id === userId) ?? null : null;
    },
  };
}

function schedulerHot(memory = {}) {
  return {
    config: {
      features: {},
      memory: { portraitRefreshPerDay: 3, portraitCheckMinutes: 60, ...memory },
      warmup: { minMessages: 30, lookbackDays: 60 },
    },
  };
}

/** A fake refreshPortrait: `script(userId, call)` gives the outcome; an `ok` outcome takes a
 * daily slot the way the real one does, so the scheduler's free-slot count moves. */
function fakeRefresh(store, clock, script = () => ({ ok: true })) {
  const calls = [];
  const refresh = async (guildId, userId, hint, opts) => {
    calls.push({ guildId, userId, hint, opts });
    const outcome = script(userId, calls.length - 1);
    if (outcome.ok) bumpDaily(store.state.data, PORTRAIT_SLOTS, clock.now);
    return outcome;
  };
  refresh.calls = calls;
  return refresh;
}

function dueProfiles() {
  return [
    profile({ id: 'a', messageCount: 400 }),
    profile({ id: 'b', messageCount: 900 }),
    profile({ id: 'c', messageCount: 600 }),
    profile({ id: 'd', messageCount: 350 }),
  ];
}

function makeScheduler({ profiles = dueProfiles(), data = {}, memory, script, warming = false, guildId = 'g1' } = {}) {
  const store = fakeStore(profiles, data);
  const clock = { now: NOW };
  const hot = schedulerHot(memory);
  const refreshPortrait = fakeRefresh(store, clock, script);
  const state = { warming };
  const scheduler = createPortraitScheduler({
    hot,
    store,
    refreshPortrait,
    isWarmingUp: () => state.warming,
    getGuildId: () => guildId,
    now: () => clock.now,
  });
  return { scheduler, store, clock, hot, refreshPortrait, state };
}

test('portrait scheduler: tick refreshes at most today\'s free slots, in order, and stops at daily-cap', async () => {
  // One slot of today's three is already taken (a cue or the owner's command).
  const { scheduler, refreshPortrait, store } = makeScheduler({ data: { portraitDay: utcDay(NOW), portraitCount: 1 } });
  const outcome = await scheduler.tick();
  assert.deepEqual(refreshPortrait.calls.map((c) => c.userId), ['b', 'c'], 'most own messages first, two free slots');
  assert.deepEqual(refreshPortrait.calls.map((c) => c.hint), ['', '']);
  assert.equal(store.state.data.portraitCount, 3);
  assert.deepEqual(outcome, { ran: true, due: 4, started: 2, refreshed: 2, skipped: 0 });

  const capped = makeScheduler({ script: (userId) => (userId === 'c' ? { ok: false, reason: 'daily-cap', cap: 'portrait' } : { ok: true }) });
  await capped.scheduler.tick();
  assert.deepEqual(capped.refreshPortrait.calls.map((c) => c.userId), ['b', 'c'], 'the first daily-cap ends the cycle');
});

test('portrait scheduler: in two-stage mode a member whose character text waits for the voice model is not picked and costs no request; in single mode it is', async () => {
  const queue = [
    { kind: 'character', userId: 'b', brief: { add: ['γράφει τη νύχτα'] }, createdAt: NOW - DAY },
    { kind: 'relationship', userId: 'c', brief: ['φίλοι'], createdAt: NOW - DAY },
  ];
  const twoStagePrompts = { profile: 'P', portrait: 'A', 'memory-voice': 'V' };
  const withQueue = (ctx, { switchOn, prompts }) => {
    ctx.hot.config.features.memoryTwoStage = switchOn;
    ctx.hot.prompts = prompts;
    ctx.store.queueReads = 0;
    ctx.store.getVoiceQueue = (guildId) => {
      ctx.store.queueReads += 1;
      return guildId === 'g1' ? structuredClone(queue) : [];
    };
    return ctx;
  };

  const two = withQueue(makeScheduler({ memory: { portraitRefreshPerDay: 10 } }), { switchOn: true, prompts: twoStagePrompts });
  const outcome = await two.scheduler.tick();
  assert.deepEqual(two.refreshPortrait.calls.map((c) => c.userId), ['c', 'a', 'd'], 'b waits for the voice model: never started');
  assert.deepEqual(outcome, { ran: true, due: 3, started: 3, refreshed: 3, skipped: 0 });
  assert.equal(two.store.queueReads, 1, 'the queue is read once per look');

  // The switch rolled back, or a two-stage prompt missing: the refresh sends the single request,
  // which writes the portrait itself and settles the waiting item, so the member is picked.
  for (const [switchOn, prompts] of [[false, twoStagePrompts], [true, { profile: 'P', portrait: 'A' }]]) {
    const single = withQueue(makeScheduler({ memory: { portraitRefreshPerDay: 10 } }), { switchOn, prompts });
    await single.scheduler.tick();
    assert.deepEqual(single.refreshPortrait.calls.map((c) => c.userId), ['b', 'c', 'a', 'd'], `switch ${switchOn}`);
    assert.equal(single.store.queueReads, 0, 'the queue is not even read');
  }
});

test('portrait scheduler: a member whose refresh sent nothing leaves its slot to the next one', async () => {
  const { scheduler, refreshPortrait } = makeScheduler({
    script: (userId) => (userId === 'b' ? { ok: false, reason: 'nothing-to-sample' } : { ok: true }),
  });
  const outcome = await scheduler.tick();
  assert.deepEqual(refreshPortrait.calls.map((c) => c.userId), ['b', 'c', 'a', 'd']);
  assert.deepEqual(outcome, { ran: true, due: 4, started: 4, refreshed: 3, skipped: 1 });
});

test('portrait scheduler: a candidate no longer due at its turn is skipped, never refreshed', async () => {
  const profiles = dueProfiles();
  const { scheduler, refreshPortrait } = makeScheduler({
    profiles,
    memory: { portraitRefreshPerDay: 10 },
    script: (userId) => {
      if (userId === 'b') {
        // While b's request is in flight: the cue refreshes c, the owner forgets d, and a new
        // message re-creates d as a fresh profile.
        Object.assign(profiles.find((p) => p.id === 'c'), { portraitRefreshedAt: iso(NOW), portraitMessageCount: 600 });
        profiles.splice(profiles.findIndex((p) => p.id === 'd'), 1, { id: 'd', names: ['d'], character: '', style: '', messageCount: 1, lastSeen: iso(NOW) });
      }
      return { ok: true };
    },
  });

  const outcome = await scheduler.tick();

  assert.deepEqual(refreshPortrait.calls.map((c) => c.userId), ['b', 'a'], 'c and d were picked at the look but are due no more');
  assert.deepEqual(outcome, { ran: true, due: 4, started: 2, refreshed: 2, skipped: 2 });
});

test('portrait scheduler: a candidate gone from the store at its turn is skipped', async () => {
  const profiles = dueProfiles();
  const { scheduler, refreshPortrait } = makeScheduler({
    profiles,
    memory: { portraitRefreshPerDay: 10 },
    script: (userId) => {
      if (userId === 'b') profiles.splice(profiles.findIndex((p) => p.id === 'c'), 1); // forgotten
      return { ok: true };
    },
  });

  const outcome = await scheduler.tick();

  assert.deepEqual(refreshPortrait.calls.map((c) => c.userId), ['b', 'a', 'd']);
  assert.deepEqual(outcome, { ran: true, due: 4, started: 3, refreshed: 3, skipped: 1 });
});

test('portrait scheduler: every refresh of one cycle shares one crawl, the next cycle gets a fresh one', async () => {
  const { scheduler, refreshPortrait, clock, store } = makeScheduler({ memory: { portraitRefreshPerDay: 10 } });
  await scheduler.tick();
  const crawls = new Set(refreshPortrait.calls.map((c) => c.opts.crawl));
  assert.equal(crawls.size, 1);
  assert.ok([...crawls][0] && typeof [...crawls][0] === 'object');

  store.state.data.portraitCount = 0;
  clock.now += 61 * 60_000;
  await scheduler.tick();
  assert.notEqual(refreshPortrait.calls.at(-1).opts.crawl, [...crawls][0]);
});

test('portrait scheduler: tick does nothing while paused, during a warmup, with the switch off, or before memory.portraitCheckMinutes', async () => {
  const paused = makeScheduler({ data: { paused: true } });
  assert.equal((await paused.scheduler.tick()).reason, 'paused');

  const warming = makeScheduler({ warming: true });
  assert.equal((await warming.scheduler.tick()).reason, 'warming-up');

  const off = makeScheduler();
  off.hot.config.features.portraitRefresh = false;
  assert.equal((await off.scheduler.tick()).reason, 'off');
  off.hot.config.features = { memory: false };
  assert.equal((await off.scheduler.tick()).reason, 'off');

  const noGuild = makeScheduler({ guildId: null });
  assert.equal((await noGuild.scheduler.tick()).reason, 'no-guild');

  for (const run of [paused, warming, off, noGuild]) assert.equal(run.refreshPortrait.calls.length, 0);
  for (const run of [paused, warming, off, noGuild]) assert.equal(run.store.listCalls, 0, 'not even a look at the profiles');

  const early = makeScheduler({ memory: { portraitRefreshPerDay: 1 } });
  await early.scheduler.tick();
  assert.equal(early.refreshPortrait.calls.length, 1);
  early.store.state.data.portraitCount = 0;
  early.clock.now += 59 * 60_000;
  assert.equal((await early.scheduler.tick()).reason, 'not-yet');
  early.clock.now += 60_000;
  await early.scheduler.tick();
  assert.equal(early.refreshPortrait.calls.length, 2, 'memory.portraitCheckMinutes later it looks again');
});

test('portrait scheduler: a live switch-off or pause stops a cycle before its next refresh', async () => {
  let ctx = null;
  ctx = makeScheduler({
    memory: { portraitRefreshPerDay: 10 },
    script: (userId) => {
      if (userId === 'b') ctx.hot.config.features.portraitRefresh = false;
      return { ok: true };
    },
  });
  await ctx.scheduler.tick();
  assert.deepEqual(ctx.refreshPortrait.calls.map((c) => c.userId), ['b']);

  const paused = makeScheduler({ memory: { portraitRefreshPerDay: 10 }, script: () => ({ ok: false, reason: 'paused' }) });
  await paused.scheduler.tick();
  assert.equal(paused.refreshPortrait.calls.length, 1, 'a paused outcome ends the cycle');
});

test('portrait scheduler: a tick while a cycle is in flight does nothing', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = fakeStore(dueProfiles());
  const clock = { now: NOW };
  const calls = [];
  const scheduler = createPortraitScheduler({
    hot: schedulerHot(),
    store,
    refreshPortrait: async (guildId, userId) => {
      calls.push(userId);
      await gate;
      return { ok: false, reason: 'thin-sample' };
    },
    isWarmingUp: () => false,
    getGuildId: () => 'g1',
    now: () => clock.now,
  });

  const first = scheduler.tick();
  await Promise.resolve();
  clock.now += 2 * HOUR;
  assert.equal((await scheduler.tick()).reason, 'busy');
  release();
  await first;
  assert.equal(calls.length, 4);
});

test('portrait scheduler: no free slot today means no look at the profiles and no refresh', async () => {
  const { scheduler, refreshPortrait, store } = makeScheduler({ data: { portraitDay: utcDay(NOW), portraitCount: 3 } });
  assert.equal((await scheduler.tick()).reason, 'daily-cap');
  assert.equal(refreshPortrait.calls.length, 0);
  assert.equal(store.listCalls, 0);
});

test('portrait scheduler: an LLM daily cap ends the cycle and the rest of the UTC day', async () => {
  const { scheduler, refreshPortrait, clock } = makeScheduler({ script: () => ({ ok: false, reason: 'daily-cap', cap: 'llm' }) });
  await scheduler.tick();
  assert.equal(refreshPortrait.calls.length, 1);

  clock.now += 2 * HOUR; // same UTC day
  assert.equal((await scheduler.tick()).reason, 'daily-cap');
  assert.equal(refreshPortrait.calls.length, 1, 'no history crawl again while the LLM cap holds');

  clock.now = Date.UTC(2026, 9, 6, 0, 30);
  await scheduler.tick();
  assert.equal(refreshPortrait.calls.length, 2, 'the next UTC day tries again');
});

test('portrait scheduler: today\'s LLM requests at llm.maxRequestsPerDay skip the look before any profile is read', async () => {
  const { scheduler, refreshPortrait, store, hot, clock } = makeScheduler({ data: { llmDay: utcDay(NOW), llmCount: 300 } });
  hot.config.llm = { maxRequestsPerDay: 300 };
  assert.equal((await scheduler.tick()).reason, 'daily-cap');
  assert.equal(store.listCalls, 0, 'not even a look at the profiles');
  assert.equal(refreshPortrait.calls.length, 0);
  assert.equal(store.state.data.llmCount, 300, 'the LLM counter is only read');

  hot.config.llm.maxRequestsPerDay = 400; // a live raise the same day
  clock.now += 61 * 60_000;
  await scheduler.tick();
  assert.equal(refreshPortrait.calls.length, 3);
});

test('portrait scheduler: a raised llm.maxRequestsPerDay lets the next look run after a refusal the same day', async () => {
  let refused = true;
  const { scheduler, refreshPortrait, clock, hot } = makeScheduler({
    script: () => (refused ? { ok: false, reason: 'daily-cap', cap: 'llm' } : { ok: true }),
  });
  hot.config.llm = { maxRequestsPerDay: 300 };
  await scheduler.tick();
  assert.equal(refreshPortrait.calls.length, 1);

  clock.now += 61 * 60_000;
  assert.equal((await scheduler.tick()).reason, 'daily-cap', 'the same cap: still refused');
  assert.equal(refreshPortrait.calls.length, 1);

  refused = false;
  hot.config.llm.maxRequestsPerDay = 500;
  clock.now += 61 * 60_000;
  await scheduler.tick();
  assert.equal(refreshPortrait.calls.length, 4, 'the raise reaches the next look');
});

test('portrait scheduler: a failed request ends the cycle, so one provider outage costs one slot per look', async () => {
  const { scheduler, refreshPortrait, store } = makeScheduler({ script: () => ({ ok: false, reason: 'llm-error' }) });
  const outcome = await scheduler.tick();
  assert.equal(refreshPortrait.calls.length, 1);
  assert.deepEqual(outcome, { ran: true, due: 4, started: 1, refreshed: 0, skipped: 1 });
  assert.equal(store.listCalls, 1);
});

test('portrait scheduler: nobody due is no cycle and no log line', async () => {
  const { scheduler, refreshPortrait } = makeScheduler({ profiles: [profile({ messageCount: 10 })] });
  const { result, logs } = await withCapturedLogs(() => scheduler.tick());
  assert.deepEqual(result, { ran: false, reason: 'none-due' });
  assert.equal(refreshPortrait.calls.length, 0);
  assert.equal(logs.filter((entry) => entry.msg === 'portrait: cycle').length, 0);
});

test('portrait scheduler: the cycle log carries ids and counts only', async () => {
  const { scheduler } = makeScheduler();
  const { logs } = await withCapturedLogs(() => scheduler.tick());
  const cycle = logs.find((entry) => entry.msg === 'portrait: cycle');
  assert.ok(cycle);
  assert.deepEqual(
    { guildId: cycle.guildId, due: cycle.due, started: cycle.started, refreshed: cycle.refreshed, skipped: cycle.skipped },
    { guildId: 'g1', due: 4, started: 3, refreshed: 3, skipped: 0 },
  );
  assert.ok(!JSON.stringify(logs).includes('Ἀλκμήνη'), 'never a name');
});

test('portrait scheduler: a refresh that throws ends the cycle, the next look starts a new one', async () => {
  let failing = true;
  const { scheduler, refreshPortrait, clock } = makeScheduler({
    script: () => {
      if (failing) throw new Error('history read failed');
      return { ok: true };
    },
  });
  const { logs } = await withCapturedLogs(() => scheduler.tick());
  assert.equal(refreshPortrait.calls.length, 1);
  assert.ok(logs.find((entry) => entry.msg === 'portrait: refresh failed'));

  failing = false;
  clock.now += 61 * 60_000;
  await scheduler.tick();
  assert.equal(refreshPortrait.calls.length, 4, 'the cycle flag was released');
});

test('portrait scheduler: an unreadable profile list costs the look, never the process', async () => {
  const { scheduler, store, refreshPortrait } = makeScheduler();
  store.listUserProfiles = () => {
    throw new TypeError("Cannot read properties of null (reading 'id')");
  };
  const { result, logs } = await withCapturedLogs(() => scheduler.tick());
  assert.deepEqual(result, { ran: false, reason: 'store-error' });
  assert.equal(refreshPortrait.calls.length, 0);
  const line = logs.find((entry) => entry.msg === 'portrait: look failed');
  assert.equal(line.reason, 'store-error');
  assert.equal(line.error, 'TypeError');
});
