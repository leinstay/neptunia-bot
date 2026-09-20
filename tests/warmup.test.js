// Tests for src/memory/warmup.js: the pure helpers directly, and the factory
// against a fake guild/channels (scripted `messages.fetch` pages) and a fake
// memory.analyze. No network, no real timers: `sleep` is always injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SnowflakeUtil } from 'discord.js';

import { createStore } from '../src/memory/store.js';
import { createWarmup, planBatches, remainingBudget, spentTokens, orderChannels } from '../src/memory/warmup.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-warmup-'));
}

function snowflake(ts) {
  return SnowflakeUtil.generate({ timestamp: ts }).toString();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('planBatches: drops other bots before chunking, keeps the persona\'s own messages, oldest-first chunks', () => {
  const messages = [
    { id: '1', bot: false },
    { id: '2', bot: true }, // another bot: dropped
    { id: '3', bot: false, self: true }, // the persona's own message: kept
    { id: '4', bot: false },
    { id: '5', bot: false },
  ];
  const batches = planBatches(messages, 2);
  assert.deepEqual(
    batches.map((b) => b.map((m) => m.id)),
    [['1', '3'], ['4', '5']],
  );
});

test('planBatches: an empty or all-bot input yields no batches', () => {
  assert.deepEqual(planBatches([], 10), []);
  assert.deepEqual(planBatches([{ id: '1', bot: true }], 10), []);
});

test('remainingBudget: maxTokens minus tokensUsed, floored at 0', () => {
  assert.equal(remainingBudget({ tokensUsed: 300 }, 1000), 700);
  assert.equal(remainingBudget({ tokensUsed: 1500 }, 1000), 0);
  assert.equal(remainingBudget(undefined, 1000), 1000);
});

test('spentTokens: prefers the provider\'s own prompt+completion count', () => {
  assert.equal(spentTokens({ prompt_tokens: 100, completion_tokens: 50 }, 999), 150);
});

test('spentTokens: falls back to the estimate when usage is absent or incomplete', () => {
  assert.equal(spentTokens(null, 500), 500);
  assert.equal(spentTokens(undefined, 500), 500);
  assert.equal(spentTokens({}, 500), 500);
  assert.equal(spentTokens({ prompt_tokens: 100 }, 500), 500);
});

test('orderChannels: most recently active first', () => {
  const candidates = [
    { channel: 'a', lastActivity: 100 },
    { channel: 'b', lastActivity: 300 },
    { channel: 'c', lastActivity: 200 },
  ];
  assert.deepEqual(orderChannels(candidates).map((c) => c.channel), ['b', 'c', 'a']);
});

test('orderChannels: does not mutate its input', () => {
  const candidates = [{ channel: 'a', lastActivity: 1 }, { channel: 'b', lastActivity: 2 }];
  const snapshot = [...candidates];
  orderChannels(candidates);
  assert.deepEqual(candidates, snapshot);
});

// ---------------------------------------------------------------------------
// Factory fakes
// ---------------------------------------------------------------------------

/** Oldest-first fake history for one channel. */
function makeHistory({ count, startTs, spacingMs, authorId, botEveryIndex = -1, selfEveryIndex = -1, selfId = 'selfUser' }) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const ts = startTs + i * spacingMs;
    let author = { id: authorId, bot: false };
    if (i === botEveryIndex) author = { id: 'otherBot', bot: true };
    if (i === selfEveryIndex) author = { id: selfId, bot: false };
    list.push({
      id: snowflake(ts),
      author,
      cleanContent: `msg ${i}`,
      createdTimestamp: ts,
      reference: null,
      attachments: new Map(),
      stickers: new Map(),
    });
  }
  return list;
}

/** A fake discord.js text channel backed by an oldest-first history array. */
function fakeChannel(id, historyAsc) {
  // normalizeMessage() reads channelId straight off the message, not off channel.id.
  for (const message of historyAsc) message.channelId = id;
  const desc = [...historyAsc].reverse(); // newest first, like a real fetch page
  return {
    id,
    lastMessageId: historyAsc.length ? historyAsc[historyAsc.length - 1].id : null,
    guild: null,
    isTextBased: () => true,
    isThread: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async (opts = {}) => {
        const limit = opts.limit ?? 50;
        let pool = desc;
        if (opts.before) {
          const beforeNum = BigInt(opts.before);
          pool = pool.filter((m) => BigInt(m.id) < beforeNum);
        }
        return new Map(pool.slice(0, limit).map((m) => [m.id, m]));
      },
    },
  };
}

function fakeGuild(id, channels) {
  const guild = { id, channels: { cache: new Map(channels.map((c) => [c.id, c])) }, members: { me: { displayName: 'Bot' } } };
  for (const c of channels) c.guild = guild;
  return guild;
}

function fakeClient(guild) {
  return { user: { id: 'selfUser' }, guilds: { cache: new Map([[guild.id, guild]]) } };
}

function fakeHot(overrides = {}) {
  return {
    config: {
      bot: { channels: { allow: [], deny: [] } },
      memory: { maxOutputTokens: 100 },
      warmup: {
        enabled: true,
        maxTokens: 1_000_000,
        messagesPerChannel: 200,
        batchMessages: 2,
        maxAgeDays: 0,
        channels: [],
        ...overrides.warmup,
      },
    },
  };
}

/** A scripted memory.analyze: `script(callIndex, batch)` returns the outcome for that call. */
function fakeMemory(script) {
  const calls = [];
  return {
    calls,
    analyze: async (guildId, batch, opts) => {
      const outcome = script(calls.length, batch, opts);
      calls.push({ guildId, batch, opts });
      return outcome;
    },
  };
}

function alwaysOk(usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return () => ({ ok: true, usage, estimated: usage.prompt_tokens + usage.completion_tokens, result: {} });
}

function fakeSleep() {
  const calls = [];
  const fn = async (ms) => {
    calls.push(ms);
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// run(): happy path, ordering, bots dropped
// ---------------------------------------------------------------------------

test('run: analyzes every batch oldest-first, most recently active channel first, drops other bots', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();

    // channel B is older activity, channel A is the most recent -> A goes first.
    const historyB = makeHistory({ count: 4, startTs: now - 10 * 60_000, spacingMs: 1000, authorId: 'u2' });
    const historyA = makeHistory({ count: 4, startTs: now - 1 * 60_000, spacingMs: 1000, authorId: 'u1', botEveryIndex: 1 });
    const channelA = fakeChannel('chanA', historyA);
    const channelB = fakeChannel('chanB', historyB);
    const guild = fakeGuild('g1', [channelA, channelB]);
    const client = fakeClient(guild);
    const hot = fakeHot();
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(result.done, true);
    assert.equal(result.aborted, false);

    // channel A (3 non-bot messages after dropping the bot one) is processed
    // before channel B, and every batch is oldest-first.
    const contents = memory.calls.map((c) => c.batch.map((m) => m.content));
    assert.deepEqual(contents, [['msg 0', 'msg 2'], ['msg 3'], ['msg 0', 'msg 1'], ['msg 2', 'msg 3']]);
    for (const call of memory.calls) assert.equal(call.opts.countAgainstDailyCap, false);

    assert.equal(store.getUser('g1', 'otherBot'), null, 'the other bot is never profiled');
    assert.equal(store.getUser('g1', 'u1').messageCount, 3);
    assert.equal(store.getUser('g1', 'u2').messageCount, 4);
    assert.equal(store.getChannel('g1', 'chanA').messageCount, 3);
    assert.equal(store.getChannel('g1', 'chanB').messageCount, 4);

    const st = store.state.data.warmup;
    assert.equal(st.channels.chanA.done, true);
    assert.equal(st.channels.chanB.done, true);
    assert.equal(st.channels.chanA.batchesDone, 2);
    assert.equal(st.tokensUsed, 4 * 15); // 4 batches total, 15 tokens each
    assert.equal(st.requests, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: keeps the persona\'s own historical messages in the batches', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 3, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1', selfEveryIndex: 1 });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(memory.calls.length, 1);
    assert.equal(memory.calls[0].batch.length, 3, 'the self message is kept, not dropped like another bot\'s');
    assert.equal(store.getUser('g1', 'selfUser'), null, 'but it never gets its own profile');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test('run: stops once the budget is spent, never starting a batch it cannot afford', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 4, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    // A budget exactly the size of one batch's real cost, comfortably above
    // its conservative pre-flight estimate: batch 1 fits, batch 2 does not
    // (remainingBudget drops to exactly 0, which is below any positive
    // estimate, regardless of the estimate's precise formula).
    const hot = fakeHot({ warmup: { maxTokens: 5000 } });
    const memory = fakeMemory(alwaysOk({ prompt_tokens: 4000, completion_tokens: 1000 }));

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(memory.calls.length, 1, 'only the affordable batch runs');
    assert.equal(result.done, true);
    assert.equal(result.tokensUsed, 5000);
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 1);
    assert.equal(store.state.data.warmup.channels.c1.done, false, 'the channel itself is not finished, just the budget');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Retry / abort
// ---------------------------------------------------------------------------

test('run: a batch that fails once is retried after sleep(5000) and then succeeds', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    let call = 0;
    const memory = fakeMemory(() => {
      call += 1;
      if (call === 1) return { ok: false, usage: null, estimated: 0, result: null };
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.deepEqual(sleep.calls, [5000]);
    assert.equal(memory.calls.length, 2);
    assert.equal(result.done, true);
    assert.equal(result.aborted, false);
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: three consecutive failed batches abort the run; isBlocking() drops, resumable', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(() => ({ ok: false, usage: null, estimated: 0, result: null }));
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.equal(result.aborted, true);
    assert.equal(memory.calls.length, 6); // 3 cycles * (try + retry)
    assert.equal(sleep.calls.length, 3);
    assert.equal(warmup.isBlocking(), false, 'aborting must not mute the persona forever');
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 0, 'nothing succeeded, so nothing is skipped later');

    // Resumable: a fresh factory over the same store, now with a working analyzer.
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.aborted, false);
    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Resume after a restart
// ---------------------------------------------------------------------------

test('run: resume after a restart skips finished batches and channels, no double bookkeeping', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    // channel A more recent, processed first; each has 2 batches of 2.
    const historyA = makeHistory({ count: 4, startTs: now - 1 * 60_000, spacingMs: 1000, authorId: 'u1' });
    const historyB = makeHistory({ count: 4, startTs: now - 10 * 60_000, spacingMs: 1000, authorId: 'u2' });
    const channelA = fakeChannel('chanA', historyA);
    const channelB = fakeChannel('chanB', historyB);
    const guild = fakeGuild('g1', [channelA, channelB]);
    const client = fakeClient(guild);
    const hot = fakeHot();

    // Channel A's two batches succeed; channel B's first batch then fails
    // forever, aborting the run after 3 cycles.
    let call = 0;
    const memory1 = fakeMemory(() => {
      call += 1;
      if (call <= 2) return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
      return { ok: false, usage: null, estimated: 0, result: null };
    });

    const warmup1 = createWarmup({ hot, store, client, memory: memory1, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result1 = await warmup1.run();

    assert.equal(result1.aborted, true);
    assert.equal(store.getUser('g1', 'u1').messageCount, 4);
    assert.equal(store.getChannel('g1', 'chanA').messageCount, 4);
    assert.equal(store.state.data.warmup.channels.chanA.done, true);
    assert.equal(store.state.data.warmup.channels.chanB.batchesDone, 0);

    // Simulate a process restart: a brand-new factory over the same store/dir.
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 2, 'only channel B\'s two batches run, channel A is skipped entirely');
    assert.equal(store.getUser('g1', 'u1').messageCount, 4, 'channel A\'s messages were never re-counted');
    assert.equal(store.getChannel('g1', 'chanA').messageCount, 4);
    assert.equal(store.getUser('g1', 'u2').messageCount, 4);
    assert.equal(store.getChannel('g1', 'chanB').messageCount, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// channels allowlist / maxAgeDays
// ---------------------------------------------------------------------------

test('run: warmup.channels restricts which channels are read', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const historyA = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const historyB = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u2' });
    const channelA = fakeChannel('chanA', historyA);
    const channelB = fakeChannel('chanB', historyB);
    const guild = fakeGuild('g1', [channelA, channelB]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, channels: ['chanB'] } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(store.getUser('g1', 'u1'), null, 'channel A is outside the allowlist');
    assert.equal(store.getUser('g1', 'u2').messageCount, 2);
    assert.equal(store.state.data.warmup.channels.chanA, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: maxAgeDays drops messages older than the cutoff', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    const history = [
      { ts: now - 3 * day }, // too old
      { ts: now - 2 * day }, // too old
      { ts: now - 36 * 60 * 60_000 }, // too old (1.5 days)
      { ts: now - 20 * 60 * 60_000 }, // within 1 day
      { ts: now - 10 * 60 * 60_000 },
      { ts: now - 1 * 60 * 60_000 },
    ].map(({ ts }, i) => ({
      id: snowflake(ts),
      author: { id: 'u1', bot: false },
      cleanContent: `msg ${i}`,
      createdTimestamp: ts,
      reference: null,
      attachments: new Map(),
      stickers: new Map(),
    }));
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, maxAgeDays: 1 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(memory.calls.length, 1);
    assert.equal(memory.calls[0].batch.length, 3, 'only the 3 messages within maxAgeDays survive');
    assert.equal(store.getUser('g1', 'u1').messageCount, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// isBlocking()
// ---------------------------------------------------------------------------

test('isBlocking: true while enabled and neither done nor aborted', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });
    assert.equal(warmup.isBlocking(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isBlocking: false when warmup.enabled is false, regardless of state', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot({ warmup: { enabled: false } });
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });
    assert.equal(warmup.isBlocking(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isBlocking: false once done, false once aborted', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });

    store.state.data.warmup = { done: true, aborted: false, channels: {}, tokensUsed: 0, requests: 0 };
    assert.equal(warmup.isBlocking(), false);

    store.state.data.warmup = { done: false, aborted: true, channels: {}, tokensUsed: 0, requests: 0 };
    assert.equal(warmup.isBlocking(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

test('reset: clears only warm-up progress, never any memory', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    store.touchUser('g1', 'u1', 'nick', Date.now());
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });
    store.state.data.warmup = { done: true, aborted: false, channels: { c1: { done: true } }, tokensUsed: 500, requests: 3 };

    warmup.reset();

    assert.equal(store.state.data.warmup, undefined);
    assert.ok(store.getUser('g1', 'u1'), 'profiles survive a warm-up reset');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reset: refused while a run is in progress', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 1, startTs: now, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot();
    const memory = { analyze: () => new Promise(() => {}) }; // never resolves: the run stays "running"

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    warmup.run(); // not awaited on purpose

    await Promise.resolve(); // let the run reach the pending analyze() call
    assert.throws(() => warmup.reset(), /running/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('run: concurrent calls share one run', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const p1 = warmup.run();
    const p2 = warmup.run();

    assert.equal(p1, p2);
    await p1;
    assert.equal(memory.calls.length, 1, 'the history was only analyzed once, not twice');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
