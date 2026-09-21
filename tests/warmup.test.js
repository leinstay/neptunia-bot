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
import { createWarmup, planBatches, remainingBudget, spentTokens, orderChannels, planWarmup } from '../src/memory/warmup.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-warmup-'));
}

function snowflake(ts) {
  return SnowflakeUtil.generate({ timestamp: ts }).toString();
}

/** Runs `fn`, capturing every `process.stdout.write` call (the log module's only sink) and
 * restoring the original afterwards even if `fn` throws. Returns the parsed JSON log entries
 * alongside `fn`'s resolved value; non-JSON stdout noise is silently skipped. */
async function withCapturedLogs(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = original;
  }
  const logs = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        logs.push(JSON.parse(line));
      } catch {
        // not one of our JSON log lines -- ignore
      }
    }
  }
  return { result, logs };
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
// planWarmup
// ---------------------------------------------------------------------------

function baseCfg(overrides = {}) {
  return { messagesPerChannel: 100, channelDepths: {}, primaryChannelId: '', onlyListed: false, ...overrides };
}

test('planWarmup: defaults every channel to messagesPerChannel, most recently active first', () => {
  const candidates = [
    { id: 'a', name: 'alpha', lastActivity: 100 },
    { id: 'b', name: 'beta', lastActivity: 300 },
    { id: 'c', name: 'gamma', lastActivity: 200 },
  ];
  const { plan, missing } = planWarmup(candidates, baseCfg());
  assert.deepEqual(missing, []);
  assert.deepEqual(plan, [
    { id: 'b', name: 'beta', depth: 100, role: 'default' },
    { id: 'c', name: 'gamma', depth: 100, role: 'default' },
    { id: 'a', name: 'alpha', depth: 100, role: 'default' },
  ]);
});

test('planWarmup: a per-channel depth overrides the default and marks the channel "listed"', () => {
  const candidates = [
    { id: 'a', name: 'alpha', lastActivity: 100 },
    { id: 'b', name: 'beta', lastActivity: 300 },
    { id: 'c', name: 'gamma', lastActivity: 200 },
  ];
  const { plan } = planWarmup(candidates, baseCfg({ channelDepths: { a: 5 } }));
  assert.deepEqual(plan, [
    { id: 'a', name: 'alpha', depth: 5, role: 'listed' },
    { id: 'b', name: 'beta', depth: 100, role: 'default' },
    { id: 'c', name: 'gamma', depth: 100, role: 'default' },
  ]);
});

test('planWarmup: a depth of 0 removes the channel from the plan entirely', () => {
  const candidates = [
    { id: 'a', name: 'alpha', lastActivity: 100 },
    { id: 'b', name: 'beta', lastActivity: 300 },
    { id: 'c', name: 'gamma', lastActivity: 200 },
  ];
  const { plan, missing } = planWarmup(candidates, baseCfg({ channelDepths: { b: 0 } }));
  assert.deepEqual(plan.map((c) => c.id), ['c', 'a']);
  assert.deepEqual(missing, [], 'a depth-0 channel is dropped, not reported as missing');
});

test('planWarmup: onlyListed keeps the primary (with an explicit depth) plus the listed channels only', () => {
  const candidates = [
    { id: 'a', name: 'alpha', lastActivity: 100 },
    { id: 'b', name: 'beta', lastActivity: 300 },
    { id: 'c', name: 'gamma', lastActivity: 200 },
  ];
  const { plan } = planWarmup(
    candidates,
    baseCfg({ onlyListed: true, primaryChannelId: 'b', channelDepths: { b: 10, c: 20 } }),
  );
  assert.deepEqual(plan, [
    { id: 'b', name: 'beta', depth: 10, role: 'primary' },
    { id: 'c', name: 'gamma', depth: 20, role: 'listed' },
  ]);
});

test('planWarmup: onlyListed still keeps the primary, at messagesPerChannel, when it has no depths entry', () => {
  const candidates = [
    { id: 'a', name: 'alpha', lastActivity: 100 },
    { id: 'b', name: 'beta', lastActivity: 300 },
    { id: 'c', name: 'gamma', lastActivity: 200 },
  ];
  const { plan } = planWarmup(
    candidates,
    baseCfg({ onlyListed: true, primaryChannelId: 'b', channelDepths: { c: 20 } }),
  );
  assert.deepEqual(plan, [
    { id: 'b', name: 'beta', depth: 100, role: 'primary' },
    { id: 'c', name: 'gamma', depth: 20, role: 'listed' },
  ]);
});

test('planWarmup: orders the primary first, then listed channels by depth (ties by recency), then the rest by recency', () => {
  const candidates = [
    { id: 'p', name: 'primary', lastActivity: 500 },
    { id: 'l1', name: 'l1', lastActivity: 10 },
    { id: 'l2', name: 'l2', lastActivity: 20 },
    { id: 'l3', name: 'l3', lastActivity: 5 },
    { id: 'r1', name: 'r1', lastActivity: 300 },
    { id: 'r2', name: 'r2', lastActivity: 400 },
  ];
  const cfg = baseCfg({ primaryChannelId: 'p', channelDepths: { l1: 50, l2: 50, l3: 80 } });
  const { plan } = planWarmup(candidates, cfg);
  assert.deepEqual(plan.map((c) => c.id), ['p', 'l3', 'l2', 'l1', 'r2', 'r1']);
  assert.deepEqual(plan.map((c) => c.role), ['primary', 'listed', 'listed', 'listed', 'default', 'default']);
});

test('planWarmup: ids with no matching candidate are reported as missing, never thrown', () => {
  const candidates = [{ id: 'a', name: 'alpha', lastActivity: 100 }];
  const cfg = baseCfg({ primaryChannelId: 'phantom', channelDepths: { a: 10, ghost: 5 } });
  assert.doesNotThrow(() => planWarmup(candidates, cfg));
  const { plan, missing } = planWarmup(candidates, cfg);
  assert.deepEqual(plan, [{ id: 'a', name: 'alpha', depth: 10, role: 'listed' }]);
  assert.deepEqual(missing, ['ghost', 'phantom']);
});

test('planWarmup: a garbage depth (non-integer or negative) is treated as absent, not as listed', () => {
  const candidates = [
    { id: 'a', name: 'alpha', lastActivity: 300 },
    { id: 'b', name: 'beta', lastActivity: 200 },
    { id: 'c', name: 'gamma', lastActivity: 100 },
  ];
  const cfg = baseCfg({ channelDepths: { a: -5, b: 1.5, c: 'abc' } });
  const { plan, missing } = planWarmup(candidates, cfg);
  assert.deepEqual(missing, []);
  assert.deepEqual(plan, [
    { id: 'a', name: 'alpha', depth: 100, role: 'default' },
    { id: 'b', name: 'beta', depth: 100, role: 'default' },
    { id: 'c', name: 'gamma', depth: 100, role: 'default' },
  ]);
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
function fakeChannel(id, historyAsc, name = id) {
  // normalizeMessage() reads channelId straight off the message, not off channel.id.
  for (const message of historyAsc) message.channelId = id;
  const desc = [...historyAsc].reverse(); // newest first, like a real fetch page
  return {
    id,
    name,
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
      memory: { maxOutputTokens: 100, ...overrides.memory },
      warmup: {
        enabled: true,
        maxTokens: 1_000_000,
        messagesPerChannel: 200,
        batchMessages: 2,
        maxAgeDays: 0,
        primaryChannelId: '',
        channelDepths: {},
        onlyListed: false,
        ...overrides.warmup,
      },
    },
  };
}

/**
 * A scripted memory.analyze: `script(callIndex, batch)` returns the outcome
 * for that call. `estimateFn(guildId, batch)` fakes the calibrated
 * full-request estimate `estimate()` would return; small by default so it
 * never gets in the way of tests that are not about the budget itself.
 */
function fakeMemory(script, estimateFn = () => 10) {
  const calls = [];
  const estimateCalls = [];
  return {
    calls,
    estimateCalls,
    analyze: async (guildId, batch, opts) => {
      const outcome = script(calls.length, batch, opts);
      calls.push({ guildId, batch, opts });
      return outcome;
    },
    estimate: (guildId, batch) => {
      estimateCalls.push({ guildId, batch });
      return estimateFn(guildId, batch);
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

test('run: the pre-batch check uses the full request estimate, not just message contents', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    // Tiny message contents: a content-only heuristic would judge this batch
    // dirt cheap. A fake memory.estimate reporting the true (large) cost of
    // the full request must still stop the run before any batch runs.
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, maxTokens: 1000 } });
    const memory = fakeMemory(alwaysOk(), () => 5000);

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(memory.calls.length, 0, 'the batch never runs: the full estimate already exceeds the budget');
    assert.equal(memory.estimateCalls.length, 1);
    assert.equal(result.done, true);
    assert.equal(result.tokensUsed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a failed-but-billed attempt still charges the budget and counts as a request', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    // A budget that affords exactly the try + the retry (each billed 120)
    // but not a third attempt, so the run stops for lack of budget right
    // after this one cycle instead of looping into the 3-consecutive-failure
    // abort — keeping this test about charging, not about the abort path.
    const hot = fakeHot({ warmup: { batchMessages: 10, maxTokens: 250 } });
    // Both attempts reach the provider and are billed, but parsing/applying
    // the reply keeps failing (ok: false) — the tokens were spent regardless.
    const memory = fakeMemory(() => ({
      ok: false,
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      estimated: 120,
      result: null,
    }));
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.equal(memory.calls.length, 2, 'try + retry, both billed');
    assert.equal(result.tokensUsed, 240, 'both billed attempts are charged, even though neither succeeded');
    assert.equal(store.state.data.warmup.requests, 2);
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 0, 'the batch itself never succeeded');
    assert.equal(result.done, true, 'stopped for lack of budget, not aborted');
    assert.equal(result.aborted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: billed failures can exhaust the budget and stop with done: true instead of looping', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    // The estimate (900) plus this batch's real, billed cost (1000) exactly
    // spends the whole budget on the very first attempt, so the retry is
    // skipped as unaffordable and the run stops on the next budget check
    // instead of ever reaching MAX_CONSECUTIVE_FAILURES.
    const hot = fakeHot({ warmup: { batchMessages: 10, maxTokens: 1000 }, memory: { maxOutputTokens: 0 } });
    const memory = fakeMemory(
      () => ({ ok: false, usage: { prompt_tokens: 900, completion_tokens: 100 }, estimated: 1000, result: null }),
      () => 900,
    );
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.equal(memory.calls.length, 1, 'the billed failure alone exhausts the budget: no retry, no second cycle');
    assert.equal(sleep.calls.length, 0, 'the retry is skipped, never slept on');
    assert.equal(result.done, true);
    assert.equal(result.aborted, false);
    assert.equal(result.tokensUsed, 1000);
    assert.equal(result.requests, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a retry is skipped once the remaining budget can no longer afford it', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, maxTokens: 1000 }, memory: { maxOutputTokens: 0 } });
    const memory = fakeMemory(
      () => ({ ok: false, usage: { prompt_tokens: 900, completion_tokens: 100 }, estimated: 1000, result: null }),
      () => 900,
    );
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    await warmup.run();

    assert.equal(memory.calls.length, 1, 'only the first attempt ran; the retry was unaffordable');
    assert.equal(sleep.calls.length, 0, 'no sleep(5000) before a retry that cannot be paid for');
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
// Split on a 'truncated'/'bad-json' failure, instead of retrying blindly
// ---------------------------------------------------------------------------

test('run: splits a batch that fails "truncated", oldest half first, and succeeds on both halves', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 40, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 40 } });

    let n = 0;
    const memory = fakeMemory(() => {
      n += 1;
      if (n === 1) {
        return { ok: false, usage: { prompt_tokens: 500, completion_tokens: 100 }, estimated: 600, result: null, reason: 'truncated', detail: 'cut mid-object' };
      }
      return { ok: true, usage: { prompt_tokens: 50, completion_tokens: 20 }, estimated: 70, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    assert.equal(memory.calls.length, 3, 'the whole batch, then its two halves');
    assert.deepEqual(memory.calls[0].batch.map((m) => m.content), Array.from({ length: 40 }, (_, i) => `msg ${i}`));
    assert.deepEqual(memory.calls[1].batch.map((m) => m.content), Array.from({ length: 20 }, (_, i) => `msg ${i}`), 'oldest half first');
    assert.deepEqual(memory.calls[2].batch.map((m) => m.content), Array.from({ length: 20 }, (_, i) => `msg ${20 + i}`));
    for (const call of memory.calls) assert.equal(call.opts.countAgainstDailyCap, false);
    assert.equal(sleep.calls.length, 0, 'a truncated failure is never retried on the same input, only split');

    assert.equal(store.getUser('g1', 'u1').messageCount, 40, 'bookkeeping happens once per message, not once per attempt');
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 1, 'the index advances once, after every piece is done');
    assert.equal(store.state.data.warmup.requests, 3, 'every attempt, including the failed whole-batch one, is charged');
    assert.equal(store.state.data.warmup.tokensUsed, 600 + 70 + 70);
    assert.equal(store.state.data.warmup.skippedMessages, 0);
    assert.equal(result.done, true);
    assert.equal(result.aborted, false);

    const splitLog = logs.find((l) => l.msg === 'warmup: batch failed, splitting');
    assert.ok(splitLog);
    assert.equal(splitLog.reason, 'truncated');
    assert.equal(splitLog.messages, 40);
    const dump = JSON.stringify(logs);
    for (let i = 0; i < 40; i += 1) assert.ok(!dump.includes(`"msg ${i}"`), 'no message contents in any log line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: recurses down to the floor, then skips a piece that still fails, and the run continues', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 42, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 21 } });

    let n = 0;
    const memory = fakeMemory(() => {
      n += 1;
      if (n === 1) return { ok: false, usage: { prompt_tokens: 10, completion_tokens: 10 }, estimated: 20, result: null, reason: 'truncated' };
      if (n === 2) return { ok: false, usage: { prompt_tokens: 10, completion_tokens: 10 }, estimated: 20, result: null, reason: 'bad-json' };
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 10 }, estimated: 20, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    // Batch 1 (21 msgs) fails truncated -> splits into 11 + 10 (both at/under
    // the floor of 20). The first half (11) fails bad-json at the floor and
    // is skipped; the second half (10) succeeds, proving 20 (the floor,
    // 10 clamped up) as the adaptive piece size. Batch 2 (21 msgs) is then
    // cut to that size up front -> 20 + 1, both succeeding outright: the run
    // is not stalled or aborted by the earlier skip.
    assert.equal(memory.calls.length, 5);
    assert.equal(memory.calls[0].batch.length, 21);
    assert.equal(memory.calls[1].batch.length, 11);
    assert.equal(memory.calls[2].batch.length, 10);
    assert.equal(memory.calls[3].batch.length, 20);
    assert.equal(memory.calls[4].batch.length, 1);
    assert.equal(sleep.calls.length, 0);

    assert.equal(store.state.data.warmup.skippedMessages, 11);
    assert.equal(store.getUser('g1', 'u1').messageCount, 31, '10 (second half) + 21 (batch 2), the skipped 11 are not counted');
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 2, 'both top-level batches finished (one via split+skip)');
    assert.equal(result.aborted, false);
    assert.equal(result.done, true);

    const skipLog = logs.find((l) => l.msg === 'warmup: batch failed at the floor, skipping');
    assert.ok(skipLog);
    assert.equal(skipLog.reason, 'bad-json');
    assert.equal(skipLog.messages, 11);

    const sizeLog = logs.find((l) => l.msg === 'warmup: piece size changed');
    assert.ok(sizeLog);
    assert.equal(sizeLog.from, 21);
    assert.equal(sizeLog.to, 20);
    assert.equal(sizeLog.reason, 'truncated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Adaptive piece size (in memory only, per process): once a split proves a
// smaller size is needed, later batches are cut to that size up front.
// ---------------------------------------------------------------------------

test('run: after a truncated split, the very next batch is sent in pieces up front, never attempted whole', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 100, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 50, messagesPerChannel: 200 } });

    let n = 0;
    const memory = fakeMemory(() => {
      n += 1;
      if (n === 1) return { ok: false, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: null, reason: 'truncated' };
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    // Batch 1 (50) fails truncated -> splits into 25 + 25, both succeeding,
    // proving 25 as the adaptive piece size. Batch 2 (50) is cut to 25 + 25
    // up front: no third call of length 50 is ever made for it.
    assert.equal(memory.calls.length, 5);
    assert.equal(memory.calls[0].batch.length, 50, 'batch 1 is still tried whole the first time');
    assert.equal(memory.calls[1].batch.length, 25);
    assert.equal(memory.calls[2].batch.length, 25);
    assert.equal(memory.calls[3].batch.length, 25, 'batch 2 goes straight to pieces');
    assert.equal(memory.calls[4].batch.length, 25);
    assert.ok(
      memory.calls.slice(1).every((c) => c.batch.length !== 50),
      'no full-size attempt after the first truncation',
    );
    assert.equal(sleep.calls.length, 0);

    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 2);
    assert.equal(result.aborted, false);
    assert.equal(result.done, true);

    const sizeLog = logs.find((l) => l.msg === 'warmup: piece size changed');
    assert.ok(sizeLog);
    assert.equal(sizeLog.from, 50);
    assert.equal(sizeLog.to, 25);
    assert.equal(sizeLog.reason, 'truncated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a split success below SPLIT_FLOOR clamps the adaptive size at the floor, never lower', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 60, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 30, messagesPerChannel: 200 } });

    let n = 0;
    const memory = fakeMemory(() => {
      n += 1;
      if (n === 1) return { ok: false, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: null, reason: 'truncated' };
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const { logs } = await withCapturedLogs(() => warmup.run());

    // Batch 1 (30) fails truncated -> splits into 15 + 15, both below the
    // floor of 20, both succeeding. The adaptive size is clamped to 20, not
    // 15: batch 2 (30) is cut into 20 + 10, not 15 + 15.
    assert.equal(memory.calls.length, 5);
    assert.equal(memory.calls[1].batch.length, 15);
    assert.equal(memory.calls[2].batch.length, 15);
    assert.equal(memory.calls[3].batch.length, 20, 'clamped to the floor, not the raw 15 that succeeded');
    assert.equal(memory.calls[4].batch.length, 10);

    const sizeLog = logs.find((l) => l.msg === 'warmup: piece size changed');
    assert.ok(sizeLog);
    assert.equal(sizeLog.to, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: the adaptive size doubles back up after 5 clean batches in a row, capped at the full batch', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 280, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 40, messagesPerChannel: 400 } });

    let n = 0;
    const memory = fakeMemory(() => {
      n += 1;
      if (n === 1) return { ok: false, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: null, reason: 'truncated' };
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    // Batch 1 (40) fails truncated -> splits into 20 + 20, proving 20 as the
    // adaptive size. Batches 2-6 (5 in a row) then each run cleanly as 20 +
    // 20 pieces; after the 5th clean batch the size doubles back to 40 (the
    // full batch), so batch 7 is attempted whole again.
    assert.equal(memory.calls.length, 14, '3 (batch1) + 5*2 (batches 2-6, cut to 20+20) + 1 (batch7, whole again)');
    assert.equal(memory.calls[13].batch.length, 40, 'recovered to the full batch size');
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 7);
    assert.equal(result.aborted, false);
    assert.equal(result.done, true);

    const sizeLogs = logs.filter((l) => l.msg === 'warmup: piece size changed');
    assert.equal(sizeLogs.length, 2);
    assert.equal(sizeLogs[0].reason, 'truncated');
    assert.equal(sizeLogs[0].from, 40);
    assert.equal(sizeLogs[0].to, 20);
    assert.equal(sizeLogs[1].reason, 'recovered');
    assert.equal(sizeLogs[1].from, 20);
    assert.equal(sizeLogs[1].to, 40);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: the adaptive shrink is in memory only — a restart tries the next unfinished batch whole again', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 80, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 40, messagesPerChannel: 200 } });

    // Batch 1 (40) fails truncated, splits into 20 + 20 (both succeed): the
    // adaptive size shrinks to 20. Batch 2 (40) is then cut to 20 + 20; its
    // first piece succeeds, but the second keeps failing a plain
    // 'llm-error' forever, aborting the run after 3 cycles with batch 2
    // still unfinished.
    let n = 0;
    const memory1 = fakeMemory(() => {
      n += 1;
      if (n === 1) return { ok: false, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: null, reason: 'truncated' };
      if (n === 2 || n === 3 || n === 4) return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
      return { ok: false, usage: null, estimated: 0, result: null, reason: 'llm-error' };
    });

    const warmup1 = createWarmup({ hot, store, client, memory: memory1, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result1 = await warmup1.run();

    assert.equal(result1.aborted, true);
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 1, 'batch 1 finished; batch 2 is still in flight');

    // Restart: a brand-new factory over the same store — the in-memory
    // adaptive size is gone, so the still-unfinished batch 2 is retried
    // WHOLE (40), not pre-split to 20 + 20.
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 1, 'batch 2 is re-analyzed in one whole piece, the shrink did not survive the restart');
    assert.equal(memory2.calls[0].batch.length, 40);
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: an "llm-error" failure keeps the retry-once + abort-after-three behaviour, never split', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(() => ({ ok: false, usage: null, estimated: 0, result: null, reason: 'llm-error', detail: 'network blip' }));
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.equal(result.aborted, true);
    assert.equal(memory.calls.length, 6, '3 cycles * (try + retry), same as an undefined reason');
    assert.equal(sleep.calls.length, 3);
    assert.equal(store.state.data.warmup.skippedMessages, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rate limits: waited out, not counted as three strikes
// ---------------------------------------------------------------------------

function rateLimited429(overrides = {}) {
  return {
    ok: false,
    usage: null,
    estimated: 0,
    result: null,
    reason: 'llm-error',
    status: 429,
    detail: 'OpenRouter HTTP 429: too many tokens per day',
    ...overrides,
  };
}

test('run: a 429 waits instead of striking, then retries the same batch and succeeds', async () => {
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
      if (call === 1) return rateLimited429();
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    assert.equal(memory.calls.length, 2, 'the batch is retried, not split or given up on');
    assert.equal(result.done, true);
    assert.equal(result.aborted, false);
    assert.deepEqual(sleep.calls, [10 * 60_000], 'waits warmup.rateLimitWaitMinutes (default 10), never the 5s retry delay');

    const waitLog = logs.find((l) => l.msg === 'warmup: rate limited, waiting');
    assert.ok(waitLog);
    assert.equal(waitLog.waitMinutes, 10);
    assert.equal(waitLog.waits, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a rate limit reported via the detail text (no status field) is recognised the same way', async () => {
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
      if (call === 1) {
        return { ok: false, usage: null, estimated: 0, result: null, reason: 'llm-error', detail: 'Too many requests, please slow down' };
      }
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.equal(memory.calls.length, 2);
    assert.equal(result.done, true);
    assert.deepEqual(sleep.calls, [10 * 60_000]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: logs the provider name on a rate-limit wait when the detail carries one, never message contents', async () => {
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
      if (call === 1) {
        return rateLimited429({
          detail: 'OpenRouter HTTP 429: {"error":{"metadata":{"raw":"{\\"message\\":\\"Too many tokens per day\\"}","provider_name":"Amazon Bedrock"}}}',
        });
      }
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const { logs } = await withCapturedLogs(() => warmup.run());

    const waitLog = logs.find((l) => l.msg === 'warmup: rate limited, waiting');
    assert.ok(waitLog);
    assert.equal(waitLog.provider, 'Amazon Bedrock');
    const dump = JSON.stringify(logs);
    assert.ok(!dump.includes('msg 0'), 'no message contents in any log line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a custom rateLimitWaitMinutes is honoured', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, rateLimitWaitMinutes: 1 } });
    let call = 0;
    const memory = fakeMemory(() => {
      call += 1;
      if (call === 1) return rateLimited429();
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    await warmup.run();

    assert.deepEqual(sleep.calls, [1 * 60_000]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: aborts after rateLimitMaxWaits consecutive rate-limited waits on the same batch', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, rateLimitMaxWaits: 2 } });
    const memory = fakeMemory(() => rateLimited429());
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    assert.equal(result.aborted, true);
    assert.equal(memory.calls.length, 3, '2 waited retries, then a 3rd rate-limited attempt gives up without waiting again');
    assert.equal(sleep.calls.length, 2, 'never sleeps for the attempt that finally aborts');
    assert.equal(warmup.isBlocking(), false, 'aborting must not mute the persona forever within this process');

    const abortLog = logs.find((l) => l.msg === 'warmup: aborting after repeated rate limits');
    assert.ok(abortLog);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a rate-limited abort is still resumable on the next process, like a plain 3-strikes abort', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, rateLimitMaxWaits: 1 } });
    const memory1 = fakeMemory(() => rateLimited429());

    const warmup1 = createWarmup({ hot, store, client, memory: memory1, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result1 = await warmup1.run();
    assert.equal(result1.aborted, true);

    // A fresh process, resolving isBlocking() the way src/index.js's start-up path does.
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    assert.equal(warmup2.isBlocking(), true, 'a fresh process must resume an aborted warm-up');
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(result2.aborted, false);
    assert.equal(memory2.calls.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: stop() interrupts a rate-limit wait promptly, pausing instead of retrying', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });

    let warmup;
    const memory = fakeMemory((callIndex) => {
      if (callIndex === 0) {
        warmup.stop(); // the owner pauses the run right as the rate-limit wait would begin
        return rateLimited429();
      }
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });
    const sleep = fakeSleep();

    warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.equal(result.paused, true);
    assert.equal(result.aborted, false);
    assert.equal(result.done, false);
    assert.equal(memory.calls.length, 1, 'the wait is interrupted before ever retrying the batch');
    assert.equal(warmup.isBlocking(), false, 'a paused run must not keep the persona mute forever');

    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();
    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 1, 'resumes the same, still-unfinished batch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a non-429, non-rate-limit-worded failure still counts toward the three-strikes abort', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(() => ({ ok: false, usage: null, estimated: 0, result: null, reason: 'llm-error', status: 500, detail: 'internal server error' }));
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.equal(result.aborted, true);
    assert.equal(memory.calls.length, 6, '3 cycles * (try + retry), the old three-strikes behaviour');
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

test('run: resume after a restart in the middle of a split batch re-does only that batch', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 40, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 40 } });

    // The whole 40-message batch fails 'truncated' and splits in half. The
    // first half (20) succeeds; the second half (20) fails with a plain
    // 'llm-error' on every attempt, aborting the run after 3 cycles — the
    // top-level batch never finishes, so batchesDone stays at 0.
    let n = 0;
    const memory1 = fakeMemory(() => {
      n += 1;
      if (n === 1) return { ok: false, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: null, reason: 'truncated' };
      if (n === 2) return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
      return { ok: false, usage: null, estimated: 0, result: null, reason: 'llm-error' };
    });

    const warmup1 = createWarmup({ hot, store, client, memory: memory1, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result1 = await warmup1.run();

    assert.equal(result1.aborted, true);
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 0, 'the whole top-level batch is still unfinished');

    // Simulate a process restart: a brand-new factory over the same store/dir.
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 1, 'the whole 40-message batch is re-analyzed in one piece, resume is index-based');
    assert.equal(memory2.calls[0].batch.length, 40);
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// onlyListed / channelDepths / primaryChannelId / maxAgeDays
// ---------------------------------------------------------------------------

test('run: onlyListed restricts which channels are read to the ones with a set depth', async () => {
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
    const hot = fakeHot({ warmup: { batchMessages: 10, onlyListed: true, channelDepths: { chanB: 50 } } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(store.getUser('g1', 'u1'), null, 'channel A is not listed and onlyListed is on');
    assert.equal(store.getUser('g1', 'u2').messageCount, 2);
    assert.equal(store.state.data.warmup.channels.chanA, undefined);
    assert.equal(store.state.data.warmup.channels.chanB.limit, 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a per-channel depth caps the fetch window below the default messagesPerChannel', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 6, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, messagesPerChannel: 200, channelDepths: { c1: 2 } } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(memory.calls.length, 1);
    // Only the 2 newest messages (the configured depth) are ever fetched,
    // not all 6 that a default 200-message window would have collected.
    assert.deepEqual(memory.calls[0].batch.map((m) => m.content), ['msg 4', 'msg 5']);
    assert.equal(store.state.data.warmup.channels.c1.limit, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: the primary channel is read first and depth-0 entries remove a channel from the plan', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    // chanA is the most recently active, but chanB is the primary and must go first.
    const historyA = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const historyB = makeHistory({ count: 2, startTs: now - 10 * 60_000, spacingMs: 1000, authorId: 'u2' });
    const historyC = makeHistory({ count: 2, startTs: now - 5 * 60_000, spacingMs: 1000, authorId: 'u3' });
    const channelA = fakeChannel('chanA', historyA);
    const channelB = fakeChannel('chanB', historyB);
    const channelC = fakeChannel('chanC', historyC);
    const guild = fakeGuild('g1', [channelA, channelB, channelC]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, primaryChannelId: 'chanB', channelDepths: { chanC: 0 } } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.deepEqual(memory.calls.map((c) => c.guildId && c.batch[0]?.authorId), ['u2', 'u1']);
    assert.equal(store.getUser('g1', 'u3'), null, 'chanC has depth 0, so it is skipped entirely');
    assert.equal(store.state.data.warmup.channels.chanC, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a channel\'s stored depth survives a later config change across a simulated restart', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 6, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 2, channelDepths: { c1: 4 } } });

    // The first batch succeeds; the second fails forever, aborting the run
    // after 3 cycles while the channel still has progress recorded.
    let call = 0;
    const memory1 = fakeMemory(() => {
      call += 1;
      if (call === 1) return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
      return { ok: false, usage: null, estimated: 0, result: null };
    });

    const warmup1 = createWarmup({ hot, store, client, memory: memory1, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result1 = await warmup1.run();
    assert.equal(result1.aborted, true);
    assert.equal(store.state.data.warmup.channels.c1.limit, 4);

    // "Restart": a brand-new factory, and the owner has since raised the
    // configured depth for this channel to 6. The resume must still use the
    // ORIGINAL stored limit (4), so batch indexes never shift.
    const hot2 = fakeHot({ warmup: { batchMessages: 2, channelDepths: { c1: 6 } } });
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot: hot2, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(store.state.data.warmup.channels.c1.limit, 4, 'the stored limit never changes after the first fetch');
    const analyzed = [...memory1.calls, ...memory2.calls].flatMap((c) => c.batch.map((m) => m.content));
    assert.ok(!analyzed.includes('msg 0'), 'outside the original 4-message window');
    assert.ok(!analyzed.includes('msg 1'), 'outside the original 4-message window');
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
// Progress logs
// ---------------------------------------------------------------------------

test('run: emits "warmup: batch done" and "warmup: channel done" with counts only, no message text', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 4, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const { logs } = await withCapturedLogs(() => warmup.run());

    const batchDone = logs.find((l) => l.msg === 'warmup: batch done');
    assert.ok(batchDone);
    assert.equal(batchDone.channel, 'c1');
    assert.equal(batchDone.batchIndex, 0);
    assert.equal(batchDone.batches, 1);
    assert.equal(batchDone.messages, 4);
    assert.equal(typeof batchDone.tokensUsed, 'number');
    assert.equal(typeof batchDone.maxTokens, 'number');
    assert.equal(typeof batchDone.requests, 'number');

    const channelDone = logs.find((l) => l.msg === 'warmup: channel done');
    assert.ok(channelDone);
    assert.equal(channelDone.channel, 'c1');
    assert.equal(channelDone.channelsDone, 1);
    assert.equal(channelDone.channelsTotal, 1);

    const dump = JSON.stringify(logs);
    for (let i = 0; i < 4; i += 1) assert.ok(!dump.includes(`"msg ${i}"`), 'no message contents in any log line');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

test('status: reports skippedMessages, 0 by default', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [])), memory: {}, getGuildId: () => 'g1' });

    assert.equal(warmup.status().skippedMessages, 0);

    store.state.data.warmup = { done: false, aborted: false, channels: {}, tokensUsed: 0, requests: 0, skippedMessages: 7 };
    assert.equal(warmup.status().skippedMessages, 7);
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

test('isBlocking: false once done', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });

    store.state.data.warmup = { done: true, aborted: false, channels: {}, tokensUsed: 0, requests: 0 };
    assert.equal(warmup.isBlocking(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A restart must resume an aborted warm-up (the whole point of this fix): a
// state found aborted at process start — before this factory's own run() has
// ever attempted (and possibly re-aborted) anything — counts as due, so
// src/index.js's existing start-up path (`if (warmup.isBlocking()) warmup.run()`)
// picks it back up instead of leaving the persona muted forever.
test('isBlocking: true for a persisted aborted state found at start-up, enabled and not done/paused', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });

    store.state.data.warmup = { done: false, aborted: true, paused: false, channels: {}, tokensUsed: 0, requests: 0 };
    assert.equal(warmup.isBlocking(), true, 'a restart must resume an aborted warm-up, not leave it stuck forever');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isBlocking: false for a persisted aborted state when warmup.enabled is false', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot({ warmup: { enabled: false } });
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });

    store.state.data.warmup = { done: false, aborted: true, paused: false, channels: {}, tokensUsed: 0, requests: 0 };
    assert.equal(warmup.isBlocking(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isBlocking: false when the stored state is paused, even though enabled is true and nothing is running', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot({ warmup: { enabled: true } });
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });

    store.state.data.warmup = { done: false, aborted: false, paused: true, channels: {}, tokensUsed: 0, requests: 0 };
    assert.equal(warmup.isBlocking(), false, 'a paused warm-up does not auto-block at process start');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isBlocking: true while an owner-started run is in progress, even with warmup.enabled: false', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 1, startTs: now, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { enabled: false } });
    const memory = { analyze: () => new Promise(() => {}) }; // never resolves: the run stays "running"

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    assert.equal(warmup.isBlocking(), false, 'not due on its own, warmup.enabled is false');

    warmup.run(); // owner-started, not awaited on purpose
    await Promise.resolve(); // let the run reach the pending analyze() call

    assert.equal(warmup.isBlocking(), true, 'a run in progress mutes the persona regardless of warmup.enabled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

test('stop: pauses after the batch in flight, drops isBlocking(), and a later run resumes', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 8, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 2 } });

    let warmup;
    const memory = fakeMemory((callIndex) => {
      // A stop() requested by "the owner" while the 2nd batch is in flight.
      if (callIndex === 1) warmup.stop();
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });

    warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(result.paused, true);
    assert.equal(result.done, false);
    assert.equal(result.aborted, false);
    assert.equal(memory.calls.length, 2, 'stops right after the batch that was already in flight');
    assert.equal(store.state.data.warmup.channels.c1.batchesDone, 2);
    assert.equal(store.state.data.warmup.channels.c1.done, false);
    assert.equal(warmup.isBlocking(), false, 'a paused run must not keep the persona mute forever');

    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(result2.paused, false);
    assert.equal(memory2.calls.length, 2, 'only the 2 remaining batches run');
    assert.equal(store.state.data.warmup.channels.c1.done, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stop: a no-op when nothing is running', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });
    assert.doesNotThrow(() => warmup.stop());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

test('plan: an empty plan before the guild has resolved, never throws', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot({ warmup: { maxTokens: 12345, batchMessages: 7 } });
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => null });

    const p = await warmup.plan();
    assert.deepEqual(p, { plan: [], missing: [], maxTokens: 12345, outputTokens: 100, batchMessages: 7 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan: resolves the same ordered plan run() would use, without fetching any message', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const historyA = makeHistory({ count: 2, startTs: Date.now() - 60_000, spacingMs: 1000, authorId: 'u1' });
    const historyB = makeHistory({ count: 2, startTs: Date.now() - 5 * 60_000, spacingMs: 1000, authorId: 'u2' });
    const channelA = fakeChannel('chanA', historyA, 'general');
    const channelB = fakeChannel('chanB', historyB, 'lore');
    const guild = fakeGuild('g1', [channelA, channelB]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { primaryChannelId: 'chanB', maxTokens: 999, batchMessages: 3 } });

    const warmup = createWarmup({ hot, store, client, memory: {}, getGuildId: () => 'g1' });
    const p = await warmup.plan();

    assert.deepEqual(p.plan.map((c) => c.id), ['chanB', 'chanA']);
    assert.equal(p.plan[0].role, 'primary');
    assert.equal(p.plan[0].name, 'lore');
    assert.equal(p.maxTokens, 999);
    assert.equal(p.batchMessages, 3);
    assert.equal(p.outputTokens, 100);
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

// ---------------------------------------------------------------------------
// The media describer (features.mediaDescriptions): warm-up charges its own
// budget for description requests, separate from the memory analyzer's.
// ---------------------------------------------------------------------------

function fakeDescriber(script) {
  const calls = [];
  return {
    calls,
    describe: async (guildId, item, opts) => {
      const result = script(calls.length, item, opts);
      calls.push({ guildId, item, opts });
      return result;
    },
  };
}

/** Attaches one image attachment (Discord-shaped, contentType-classified) to a raw fixture message. */
function withImage(message, itemId) {
  message.attachments = new Map([[itemId, { id: itemId, contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png' }]]);
  return message;
}

/** Attaches one picture-format sticker (Discord-shaped) to a raw fixture message. */
function withSticker(message, itemId, name = 'pepe') {
  message.stickers = new Map([[itemId, { id: itemId, name, format: 1 }]]);
  return message;
}

/** Puts one custom emoji in the raw fixture message's text. */
function withEmoji(message, id, name = 'pog') {
  message.cleanContent = `${message.cleanContent} <:${name}:${id}>`;
  return message;
}

function fakeHotWithMedia(overrides = {}) {
  const hot = fakeHot(overrides);
  hot.config.features = { mediaDescriptions: true, ...overrides.features };
  hot.config.media = { maxPerBatch: 20, maxOutputTokens: 50, imageSize: 512, ...overrides.media };
  hot.prompts = { describe: 'Describe this picture in one plain line.' };
  return hot;
}

test('warm-up: describes a batch\'s pictures and charges its own budget, threading them into analyze', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now, spacingMs: 1000, authorId: 'u1' });
    withImage(history[0], 'img1');
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHotWithMedia({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());
    const describer = fakeDescriber(() => ({ text: 'a cat', usage: { prompt_tokens: 100, completion_tokens: 20 }, estimated: 120 }));

    const warmup = createWarmup({ hot, store, client, memory, describer, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(describer.calls.length, 1);
    assert.equal(describer.calls[0].item.itemId, 'img1');
    assert.equal(describer.calls[0].opts.countAgainstDailyCap, false);
    assert.equal(memory.calls[0].opts.descriptions.get('img1'), 'a cat');

    const st = store.state.data.warmup;
    assert.equal(st.tokensUsed, 120 + 15, 'describe (120) + analyze (10+5, from alwaysOk)');
    assert.equal(st.requests, 2, 'one describe request + one analyze request');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('warm-up: describes a batch\'s stickers and custom emoji too, pictures before emoji, threading them into analyze', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now, spacingMs: 1000, authorId: 'u1' });
    withSticker(history[0], 'sticker1');
    withEmoji(history[1], '222');
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHotWithMedia({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());
    const describer = fakeDescriber(() => ({ text: 'described', usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15 }));

    const warmup = createWarmup({ hot, store, client, memory, describer, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(describer.calls.length, 2);
    assert.deepEqual(describer.calls.map((c) => c.item.itemId).sort(), ['emoji:222', 'sticker:sticker1']);
    assert.equal(memory.calls[0].opts.descriptions.get('sticker:sticker1'), 'described');
    assert.equal(memory.calls[0].opts.descriptions.get('emoji:222'), 'described');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('warm-up: a cached description costs nothing against the budget', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 1, startTs: now, spacingMs: 1000, authorId: 'u1' });
    withImage(history[0], 'img1');
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHotWithMedia({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());
    const describer = fakeDescriber(() => ({ text: 'a cat', cached: true }));

    const warmup = createWarmup({ hot, store, client, memory, describer, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    const st = store.state.data.warmup;
    assert.equal(st.tokensUsed, 15, 'only the analyze call is billed, the cached description is free');
    assert.equal(st.requests, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('warm-up: stops describing (but still analyzes) once the budget cannot afford one more description', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 1, startTs: now, spacingMs: 1000, authorId: 'u1' });
    withImage(history[0], 'img1');
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    // maxTokens is far smaller than any describe request could ever cost
    // (describe prompt + media.maxOutputTokens(50) + 300), but comfortably
    // covers the memory analyzer's own estimate (10 + memory.maxOutputTokens(100)).
    const hot = fakeHotWithMedia({ warmup: { batchMessages: 10, maxTokens: 200 } });
    const memory = fakeMemory(alwaysOk());
    const describer = fakeDescriber(() => ({ text: 'a cat' }));

    const warmup = createWarmup({ hot, store, client, memory, describer, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(describer.calls.length, 0, 'never affordable, never called');
    assert.equal(memory.calls[0].opts.descriptions.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('warm-up: caps NEW descriptions per batch at media.maxPerBatch', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now, spacingMs: 1000, authorId: 'u1' });
    withImage(history[0], 'img1');
    withImage(history[1], 'img2');
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHotWithMedia({ warmup: { batchMessages: 10 }, media: { maxPerBatch: 1 } });
    const memory = fakeMemory(alwaysOk());
    const describer = fakeDescriber(() => ({ text: 'a picture' }));

    const warmup = createWarmup({ hot, store, client, memory, describer, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(describer.calls.length, 1, 'maxPerBatch caps NEW descriptions at 1');
    assert.equal(memory.calls[0].opts.descriptions.size, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('warm-up: features.mediaDescriptions off never calls the describer, even when one is configured', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 1, startTs: now, spacingMs: 1000, authorId: 'u1' });
    withImage(history[0], 'img1');
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHotWithMedia({ warmup: { batchMessages: 10 }, features: { mediaDescriptions: false } });
    const memory = fakeMemory(alwaysOk());
    const describer = fakeDescriber(() => ({ text: 'a cat' }));

    const warmup = createWarmup({ hot, store, client, memory, describer, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(describer.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('warm-up: no describer configured is a plain no-op, never throws', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 1, startTs: now, spacingMs: 1000, authorId: 'u1' });
    withImage(history[0], 'img1');
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHotWithMedia({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(result.done, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
