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
import {
  createWarmup,
  planBatches,
  remainingBudget,
  spentTokens,
  orderChannels,
  planWarmup,
  mergeTimeline,
  cutWindow,
  packWindow,
} from '../src/memory/warmup.js';

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
// Pure helpers: planBatches, remainingBudget, spentTokens, orderChannels
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
// planWarmup: three modes only (defaults / channelDepths / onlyListed), no
// primary channel concept -- a stale `primaryChannelId` is simply ignored.
// ---------------------------------------------------------------------------

function baseCfg(overrides = {}) {
  return { messagesPerChannel: 100, channelDepths: {}, onlyListed: false, ...overrides };
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
    { id: 'b', name: 'beta', depth: 100, role: 'default' },
    { id: 'c', name: 'gamma', depth: 100, role: 'default' },
    { id: 'a', name: 'alpha', depth: 5, role: 'listed' },
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

test('planWarmup: onlyListed keeps just the channels with a valid depths entry', () => {
  const candidates = [
    { id: 'a', name: 'alpha', lastActivity: 100 },
    { id: 'b', name: 'beta', lastActivity: 300 },
    { id: 'c', name: 'gamma', lastActivity: 200 },
  ];
  const { plan } = planWarmup(candidates, baseCfg({ onlyListed: true, channelDepths: { b: 10, c: 20 } }));
  assert.deepEqual(plan, [
    { id: 'c', name: 'gamma', depth: 20, role: 'listed' },
    { id: 'b', name: 'beta', depth: 10, role: 'listed' },
  ]);
});

test('planWarmup: orders by depth descending, ties broken by most recently active first', () => {
  const candidates = [
    { id: 'p', name: 'p', lastActivity: 500 },
    { id: 'l1', name: 'l1', lastActivity: 10 },
    { id: 'l2', name: 'l2', lastActivity: 20 },
    { id: 'l3', name: 'l3', lastActivity: 5 },
    { id: 'r1', name: 'r1', lastActivity: 300 },
    { id: 'r2', name: 'r2', lastActivity: 400 },
  ];
  const cfg = baseCfg({ channelDepths: { l1: 50, l2: 50, l3: 80 } });
  const { plan } = planWarmup(candidates, cfg);
  // Depth 100 (the default): p, r2, r1 -- most recently active first.
  // Depth 80: l3. Depth 50: l2 before l1 (both tied, l2 more recently active).
  assert.deepEqual(plan.map((c) => c.id), ['p', 'r2', 'r1', 'l3', 'l2', 'l1']);
  assert.deepEqual(plan.map((c) => c.role), ['default', 'default', 'default', 'listed', 'listed', 'listed']);
});

test('planWarmup: ids with no matching candidate are reported as missing, never thrown', () => {
  const candidates = [{ id: 'a', name: 'alpha', lastActivity: 100 }];
  const cfg = baseCfg({ channelDepths: { a: 10, ghost: 5 } });
  assert.doesNotThrow(() => planWarmup(candidates, cfg));
  const { plan, missing } = planWarmup(candidates, cfg);
  assert.deepEqual(plan, [{ id: 'a', name: 'alpha', depth: 10, role: 'listed' }]);
  assert.deepEqual(missing, ['ghost']);
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

test('planWarmup: a stale primaryChannelId is ignored entirely, never given special treatment', () => {
  const candidates = [
    { id: 'a', name: 'alpha', lastActivity: 100 },
    { id: 'b', name: 'beta', lastActivity: 300 },
  ];
  const withPrimary = planWarmup(candidates, { ...baseCfg(), primaryChannelId: 'a' });
  const withoutPrimary = planWarmup(candidates, baseCfg());
  assert.deepEqual(withPrimary, withoutPrimary);
  assert.ok(withPrimary.plan.every((c) => c.role !== 'primary'));
});

// ---------------------------------------------------------------------------
// mergeTimeline: one chronological timeline across every fetched channel
// ---------------------------------------------------------------------------

test('mergeTimeline: sorts messages from every channel by snowflake id, not by channel', () => {
  const now = Date.now();
  const a0 = { id: snowflake(now), ts: now };
  const a1 = { id: snowflake(now + 2000), ts: now + 2000 };
  const b0 = { id: snowflake(now + 1000), ts: now + 1000 };
  const merged = mergeTimeline([[b0], [a0, a1]]);
  assert.deepEqual(merged.map((m) => m.id), [a0.id, b0.id, a1.id]);
});

test('mergeTimeline: drops everything at or before cursorId', () => {
  const now = Date.now();
  const m1 = { id: snowflake(now), ts: now };
  const m2 = { id: snowflake(now + 1000), ts: now + 1000 };
  const m3 = { id: snowflake(now + 2000), ts: now + 2000 };
  const merged = mergeTimeline([[m1, m2, m3]], m2.id);
  assert.deepEqual(merged.map((m) => m.id), [m3.id]);
});

test('mergeTimeline: returns everything, in order, when there is no cursor yet', () => {
  const now = Date.now();
  const m1 = { id: snowflake(now), ts: now };
  const m2 = { id: snowflake(now + 1000), ts: now + 1000 };
  const merged = mergeTimeline([[m2], [m1]], null);
  assert.deepEqual(merged.map((m) => m.id), [m1.id, m2.id]);
});

// ---------------------------------------------------------------------------
// cutWindow: cut at a pause when one exists in the last third of the target
// span, otherwise cut exactly at the target; the final window is whatever
// is left over.
// ---------------------------------------------------------------------------

function buildTimeline(n, { spacingMs = 60_000, gapAtIndex = -1, gapMs = 0, startTs = Date.now() } = {}) {
  const list = [];
  let ts = startTs;
  for (let i = 0; i < n; i += 1) {
    if (i > 0) ts += i === gapAtIndex ? gapMs : spacingMs;
    list.push({ id: snowflake(ts), ts, channelId: 'c' });
  }
  return list;
}

test('cutWindow: the whole timeline is the final window once it already fits the target', () => {
  const timeline = buildTimeline(5);
  const { window, rest } = cutWindow(timeline, 10, 30);
  assert.equal(window.length, 5);
  assert.deepEqual(rest, []);
});

test('cutWindow: cuts exactly at the target when no gap in the last third qualifies', () => {
  const timeline = buildTimeline(15); // uniform 1-minute spacing, no gap
  const { window, rest } = cutWindow(timeline, 9, 30);
  assert.equal(window.length, 9);
  assert.equal(rest.length, 6);
  assert.equal(rest[0].id, timeline[9].id);
});

test('cutWindow: cuts at the largest qualifying gap within the last third of the target span', () => {
  const timeline = buildTimeline(15, { gapAtIndex: 7, gapMs: 40 * 60_000 });
  const { window, rest } = cutWindow(timeline, 9, 30);
  assert.equal(window.length, 7);
  assert.equal(window[window.length - 1].id, timeline[6].id);
  assert.equal(rest[0].id, timeline[7].id);
});

test('cutWindow: a qualifying gap outside the last third of the target span is ignored', () => {
  const timeline = buildTimeline(15, { gapAtIndex: 3, gapMs: 40 * 60_000 });
  const { window } = cutWindow(timeline, 9, 30);
  assert.equal(window.length, 9, 'falls back to the plain target cut, the early gap does not count');
});

// ---------------------------------------------------------------------------
// packWindow: group by channel into contiguous slices, pack greedily, chunk
// an oversize slice, never interleave channels inside one batch.
// ---------------------------------------------------------------------------

function m(channelId, id, bot = false) {
  return { id: String(id), channelId, bot, content: `msg${id}` };
}

test('packWindow: a busy channel that fits whole stays in a single batch', () => {
  const window = [m('a', 1), m('a', 2), m('a', 3), m('a', 4), m('a', 5)];
  const batches = packWindow(window, 10);
  assert.deepEqual(batches, [window]);
});

test('packWindow: small scraps of quiet channels are packed together, grouped, not interleaved', () => {
  const window = [m('a', 1), m('a', 2), m('b', 3), m('b', 4), m('c', 5), m('c', 6)];
  const batches = packWindow(window, 6);
  assert.equal(batches.length, 1, 'all three small slices fit in one batch');
  assert.deepEqual(batches[0].map((msg) => msg.id), ['1', '2', '3', '4', '5', '6'], 'grouped slice after slice, never interleaved');
});

test('packWindow: a slice that would overflow the current batch flushes it first', () => {
  const window = [m('a', 1), m('a', 2), m('a', 3), m('b', 4), m('b', 5), m('b', 6)];
  const batches = packWindow(window, 4);
  assert.deepEqual(
    batches.map((b) => b.map((msg) => msg.id)),
    [['1', '2', '3'], ['4', '5', '6']],
  );
});

test('packWindow: an oversize slice is cut into batchMessages-sized chunks, the last partial chunk left open', () => {
  const window = [m('a', 1), m('a', 2), m('a', 3), m('a', 4), m('a', 5), m('a', 6), m('a', 7), m('b', 8), m('b', 9)];
  const batches = packWindow(window, 3);
  assert.deepEqual(
    batches.map((b) => b.map((msg) => msg.id)),
    [
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'], // the open partial chunk (msg 7) plus the following small slice
    ],
  );
});

test('packWindow: drops other bots before grouping into slices', () => {
  const window = [m('a', 1), m('a', 2, true), m('a', 3)];
  const batches = packWindow(window, 10);
  assert.deepEqual(batches, [[m('a', 1), m('a', 3)]]);
});

test('packWindow: an all-bot window yields no batches', () => {
  assert.deepEqual(packWindow([m('a', 1, true), m('a', 2, true)], 10), []);
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
function fakeChannel(id, historyAsc, name = id, { failFetch = false } = {}) {
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
        if (failFetch) throw new Error('channel unavailable');
        const limit = opts.limit ?? 50;
        let pool = desc;
        if (opts.before) {
          const beforeNum = BigInt(opts.before);
          pool = pool.filter((mm) => BigInt(mm.id) < beforeNum);
        }
        return new Map(pool.slice(0, limit).map((mm) => [mm.id, mm]));
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
        // Large enough by default that every test's timeline fits in a
        // single window unless a test overrides these to exercise cutting.
        windowBatches: 1000,
        cutAtGapMinutes: 30,
        maxAgeDays: 0,
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
// run(): one chronological timeline across every channel, bots dropped
// ---------------------------------------------------------------------------

test('run: merges channels into one chronological timeline instead of channel after channel', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();

    // channel B has an OLDER burst of activity; channel A (more recently
    // active overall) has a NEWER burst. Ranking channels by recency (the
    // old scheme) would read A before B; the merged timeline must still
    // read B's older messages first.
    const historyB = makeHistory({ count: 3, startTs: now - 60 * 60_000, spacingMs: 1000, authorId: 'u2' });
    const historyA = makeHistory({ count: 4, startTs: now - 1 * 60_000, spacingMs: 1000, authorId: 'u1', botEveryIndex: 1 });
    const channelA = fakeChannel('chanA', historyA);
    const channelB = fakeChannel('chanB', historyB);
    const guild = fakeGuild('g1', [channelA, channelB]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 3 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(result.done, true);
    assert.equal(result.aborted, false);

    // channel B's whole burst is analyzed before channel A's (chronological
    // order), and the other bot's message inside A's burst is dropped.
    const contents = memory.calls.map((c) => c.batch.map((mm) => mm.content));
    assert.deepEqual(contents, [['msg 0', 'msg 1', 'msg 2'], ['msg 0', 'msg 2', 'msg 3']]);

    assert.equal(store.getUser('g1', 'otherBot'), null, 'the other bot is never profiled');
    assert.equal(store.getUser('g1', 'u1').messageCount, 3);
    assert.equal(store.getUser('g1', 'u2').messageCount, 3);
    assert.equal(store.getChannel('g1', 'chanA').messageCount, 3);
    assert.equal(store.getChannel('g1', 'chanB').messageCount, 3);

    const st = store.state.data.warmup;
    assert.equal(st.channels.chanA.messages, 3);
    assert.equal(st.channels.chanB.messages, 3);
    assert.equal(st.cursorId, historyA[3].id, 'the cursor lands on the newest message overall');
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
    assert.equal(store.state.data.warmup.windowBatchesDone, 1);
    assert.equal(store.state.data.warmup.cursorId, null, 'the window itself is not finished, just the budget');
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
    assert.equal(store.state.data.warmup.windowBatchesDone, 0, 'the batch itself never succeeded');
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
    assert.equal(store.state.data.warmup.channels.c1.messages, 2);
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
    assert.equal(store.state.data.warmup.windowBatchesDone, 0, 'nothing succeeded, so nothing is skipped later');

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
    assert.deepEqual(memory.calls[0].batch.map((mm) => mm.content), Array.from({ length: 40 }, (_, i) => `msg ${i}`));
    assert.deepEqual(memory.calls[1].batch.map((mm) => mm.content), Array.from({ length: 20 }, (_, i) => `msg ${i}`), 'oldest half first');
    assert.deepEqual(memory.calls[2].batch.map((mm) => mm.content), Array.from({ length: 20 }, (_, i) => `msg ${20 + i}`));
    for (const call of memory.calls) assert.equal(call.opts.countAgainstDailyCap, false);
    assert.equal(sleep.calls.length, 0, 'a truncated failure is never retried on the same input, only split');

    assert.equal(store.getUser('g1', 'u1').messageCount, 40, 'bookkeeping happens once per message, not once per attempt');
    assert.equal(store.state.data.warmup.cursorId, history[39].id, 'the whole batch counts as one unit: the window (and run) completed');
    assert.equal(store.state.data.warmup.requests, 3, 'every attempt, including the failed whole-batch one, is charged');
    assert.equal(store.state.data.warmup.tokensUsed, 600 + 70 + 70);
    assert.equal(store.state.data.warmup.skippedMessages, 0);
    assert.equal(result.done, true);
    assert.equal(result.aborted, false);

    const splitLog = logs.find((l) => l.msg === 'warmup: batch failed, splitting');
    assert.ok(splitLog);
    assert.equal(splitLog.reason, 'truncated');
    assert.equal(splitLog.messages, 40);
    assert.deepEqual(splitLog.channels, ['c1']);
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
    assert.equal(store.state.data.warmup.cursorId, history[41].id, 'both top-level batches finished (one via split+skip)');
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
// Split on a 'token-limit' failure (F34): the required prompt sections do not
// fit the per-request cap (e.g. the batch's authors carry huge stored
// profiles) — treated exactly like 'truncated'/'bad-json', never as a plain
// abort-after-three failure.
// ---------------------------------------------------------------------------

test('run: splits a batch that fails "token-limit", oldest half first, and succeeds on both halves', async () => {
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
        // A 'token-limit' failure never reaches the provider -- nothing is
        // ever billed for it (see src/memory/update.js#analyze).
        return { ok: false, usage: null, estimated: 0, result: null, reason: 'token-limit', detail: 'required prompt sections exceed the token limit by 4792' };
      }
      return { ok: true, usage: { prompt_tokens: 50, completion_tokens: 20 }, estimated: 70, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    assert.equal(memory.calls.length, 3, 'the whole batch, then its two halves');
    assert.equal(memory.calls[0].batch.length, 40);
    assert.deepEqual(memory.calls[1].batch.map((mm) => mm.content), Array.from({ length: 20 }, (_, i) => `msg ${i}`), 'oldest half first');
    assert.deepEqual(memory.calls[2].batch.map((mm) => mm.content), Array.from({ length: 20 }, (_, i) => `msg ${20 + i}`));
    for (const call of memory.calls) assert.equal(call.opts.countAgainstDailyCap, false);
    assert.equal(sleep.calls.length, 0, 'a token-limit failure is never retried on the same input, only split');

    assert.equal(store.getUser('g1', 'u1').messageCount, 40, 'bookkeeping happens once per message, not once per attempt');
    assert.equal(store.state.data.warmup.cursorId, history[39].id, 'the whole batch counts as one unit: the window (and run) completed');
    assert.equal(store.state.data.warmup.requests, 2, 'the failed, oversized whole-batch attempt never reached the provider, so it is never counted');
    assert.equal(store.state.data.warmup.tokensUsed, 70 + 70, 'nothing was charged for the failed attempt: nothing was ever sent');
    assert.equal(store.state.data.warmup.skippedMessages, 0);
    assert.equal(result.done, true);
    assert.equal(result.aborted, false);

    const splitLog = logs.find((l) => l.msg === 'warmup: batch failed, splitting');
    assert.ok(splitLog);
    assert.equal(splitLog.reason, 'token-limit');
    assert.equal(splitLog.messages, 40);

    const sizeLog = logs.find((l) => l.msg === 'warmup: piece size changed');
    assert.ok(sizeLog, 'a token-limit split feeds the adaptive piece size exactly like a truncation');
    assert.equal(sizeLog.to, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: "token-limit" recurses down to the floor then skips a piece that still fails, and the run continues', async () => {
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
      if (n === 1) return { ok: false, usage: null, estimated: 0, result: null, reason: 'token-limit', detail: 'required prompt sections exceed the token limit by 500' };
      if (n === 2) return { ok: false, usage: null, estimated: 0, result: null, reason: 'token-limit', detail: 'required prompt sections exceed the token limit by 300' };
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 10 }, estimated: 20, result: {} };
    });
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    // Batch 1 (21 msgs) fails token-limit -> splits into 11 + 10 (both
    // at/under the floor of 20). The first half (11) fails token-limit again
    // at the floor and is skipped, never split further; the second half (10)
    // succeeds, proving 20 (the floor) as the adaptive piece size. Batch 2
    // (21 msgs) is then cut to that size up front.
    assert.equal(memory.calls.length, 5);
    assert.equal(memory.calls[0].batch.length, 21);
    assert.equal(memory.calls[1].batch.length, 11);
    assert.equal(memory.calls[2].batch.length, 10);
    assert.equal(memory.calls[3].batch.length, 20);
    assert.equal(memory.calls[4].batch.length, 1);
    assert.equal(sleep.calls.length, 0, 'never retried at the same size');

    assert.equal(store.state.data.warmup.skippedMessages, 11);
    assert.equal(store.state.data.warmup.requests, 3, 'only the three successful, billed attempts are ever counted');
    assert.equal(store.getUser('g1', 'u1').messageCount, 31, '10 (second half) + 21 (batch 2); the skipped 11 are not counted');
    assert.equal(store.state.data.warmup.cursorId, history[41].id, 'both top-level batches finished (one via split+skip)');
    assert.equal(result.aborted, false, 'a token-limit skip never counts toward the consecutive-failure abort');
    assert.equal(result.done, true);

    const skipLog = logs.find((l) => l.msg === 'warmup: batch failed at the floor, skipping');
    assert.ok(skipLog);
    assert.equal(skipLog.reason, 'token-limit');
    assert.equal(skipLog.messages, 11);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: many consecutive "token-limit" batches are all skipped outright, never aborting like a plain failure would', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 80, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    // batchMessages == SPLIT_FLOOR: an unrecoverable-size failure at this size
    // is skipped outright, never split further -- four top-level batches, all
    // failing 'token-limit', would abort after 3 under the old classification.
    const hot = fakeHot({ warmup: { batchMessages: 20 } });
    const memory = fakeMemory(() => ({ ok: false, usage: null, estimated: 0, result: null, reason: 'token-limit', detail: 'required prompt sections exceed the token limit by 4792' }));
    const sleep = fakeSleep();

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    const result = await warmup.run();

    assert.equal(memory.calls.length, 4, 'one attempt per top-level batch (80 / 20), each skipped outright, never retried');
    assert.equal(sleep.calls.length, 0);
    assert.equal(result.aborted, false, 'repeated token-limit outcomes never trip the 3-strikes abort');
    assert.equal(result.done, true);
    assert.equal(store.state.data.warmup.skippedMessages, 80);
    assert.equal(store.state.data.warmup.tokensUsed, 0, 'nothing was ever billed');
    assert.equal(store.state.data.warmup.requests, 0, 'nothing ever reached the provider');
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

    assert.equal(store.state.data.warmup.cursorId, history[99].id, 'both top-level batches finished, the window (and run) completed');
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
    assert.equal(store.state.data.warmup.cursorId, history[279].id, 'all 7 top-level batches finished, the window (and run) completed');
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
    assert.equal(store.state.data.warmup.windowBatchesDone, 1, 'batch 1 finished; batch 2 is still in flight');

    // Restart: a brand-new factory over the same store — the in-memory
    // adaptive size is gone, so the still-unfinished batch 2 is retried
    // WHOLE (40), not pre-split to 20 + 20.
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 1, 'batch 2 is re-analyzed in one whole piece, the shrink did not survive the restart');
    assert.equal(memory2.calls[0].batch.length, 40);
    assert.equal(store.state.data.warmup.cursorId, history[79].id, 'both top-level batches finished, the window (and run) completed');
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

test('run: resume mid-window skips only the batches already done, never re-analyzes, never skips one', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    // Channel A has the OLDER burst, channel B the newer one; both are 2
    // messages, exactly one packWindow batch each with batchMessages: 2.
    const historyA = makeHistory({ count: 2, startTs: now - 60 * 60_000, spacingMs: 1000, authorId: 'u1' });
    const historyB = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u2' });
    const channelA = fakeChannel('chanA', historyA);
    const channelB = fakeChannel('chanB', historyB);
    const guild = fakeGuild('g1', [channelA, channelB]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 2 } });

    // Channel A's batch succeeds; channel B's batch then fails forever,
    // aborting the run mid-window (windowBatchesDone stays at 1, cursorId
    // never advances because the window itself never fully completes).
    let call = 0;
    const memory1 = fakeMemory(() => {
      call += 1;
      if (call === 1) return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
      return { ok: false, usage: null, estimated: 0, result: null };
    });

    const warmup1 = createWarmup({ hot, store, client, memory: memory1, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result1 = await warmup1.run();

    assert.equal(result1.aborted, true);
    assert.equal(store.state.data.warmup.windowBatchesDone, 1);
    assert.equal(store.state.data.warmup.cursorId, null, 'the window is still unfinished');
    assert.equal(store.getUser('g1', 'u1').messageCount, 2);

    // Restart: a brand-new factory over the same store/dir, with a working analyzer.
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 1, 'only channel B\'s batch runs, channel A\'s is skipped, never re-analyzed');
    assert.equal(memory2.calls[0].batch[0].authorId, 'u2');
    assert.equal(store.getUser('g1', 'u1').messageCount, 2, 'channel A\'s messages were never re-counted');
    assert.equal(store.getUser('g1', 'u2').messageCount, 2);
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
    // top-level batch never finishes, so windowBatchesDone stays at 0.
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
    assert.equal(store.state.data.warmup.windowBatchesDone, 0, 'the whole top-level batch is still unfinished');

    // Simulate a process restart: a brand-new factory over the same store/dir.
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 1, 'the whole 40-message batch is re-analyzed in one piece, resume is index-based');
    assert.equal(memory2.calls[0].batch.length, 40);
    assert.equal(store.state.data.warmup.cursorId, history[39].id, 'the single batch finished, the window (and run) completed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: frozen batching parameters survive a config change across a resume', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 8, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    // batchMessages: 2, windowBatches: 1 -> target window size 2. The first
    // window (msg 0-1) succeeds and completes; the second window's batch
    // (msg 2-3) fails forever, aborting mid-window.
    const hot = fakeHot({ warmup: { batchMessages: 2, windowBatches: 1 } });

    let call = 0;
    const memory1 = fakeMemory(() => {
      call += 1;
      if (call === 1) return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
      return { ok: false, usage: null, estimated: 0, result: null };
    });

    const warmup1 = createWarmup({ hot, store, client, memory: memory1, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result1 = await warmup1.run();
    assert.equal(result1.aborted, true);
    assert.equal(store.state.data.warmup.cursorId, history[1].id, 'the first 2-message window completed');
    assert.equal(store.state.data.warmup.batchMessages, 2);
    assert.equal(store.state.data.warmup.windowBatches, 1);

    // "Restart" with a much bigger batchMessages/windowBatches — if these
    // were re-read live, the remaining 6 messages would land in one single
    // 6-message batch. The frozen values must keep cutting them into
    // 2-message windows/batches instead.
    const hot2 = fakeHot({ warmup: { batchMessages: 6, windowBatches: 2 } });
    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot: hot2, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(memory2.calls.length, 3, 'still 2-message batches, not one 6-message batch');
    for (const call2 of memory2.calls) assert.equal(call2.batch.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// channelDepths / onlyListed / maxAgeDays
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
    assert.deepEqual(memory.calls[0].batch.map((mm) => mm.content), ['msg 4', 'msg 5']);
    assert.equal(store.state.data.warmup.channels.c1.limit, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: a depth of 0 removes a channel from the plan, its history is never touched', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const historyA = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const historyC = makeHistory({ count: 2, startTs: now - 5 * 60_000, spacingMs: 1000, authorId: 'u3' });
    const channelA = fakeChannel('chanA', historyA);
    const channelC = fakeChannel('chanC', historyC);
    const guild = fakeGuild('g1', [channelA, channelC]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10, channelDepths: { chanC: 0 } } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(store.getUser('g1', 'u3'), null, 'chanC has depth 0, so it is skipped entirely');
    assert.equal(store.state.data.warmup.channels.chanC, undefined);
    assert.equal(store.getUser('g1', 'u1').messageCount, 2);
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
    const analyzed = [...memory1.calls, ...memory2.calls].flatMap((c) => c.batch.map((mm) => mm.content));
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

test('run: a channel that fails to fetch is logged and skipped for the round, never fatal', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const historyA = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    // A malformed message (no author) makes normalizeMessage() throw while
    // fetchHistoryWindow walks the page -- a realistic "this channel is
    // broken" failure that reaches the caller uncaught (a plain page-fetch
    // error is already swallowed inside fetchHistoryWindow itself).
    const brokenTs = now - 30_000;
    const historyB = [
      { id: snowflake(brokenTs), author: null, cleanContent: 'broken', createdTimestamp: brokenTs, reference: null, attachments: new Map(), stickers: new Map() },
    ];
    const channelA = fakeChannel('chanA', historyA);
    const channelB = fakeChannel('chanB', historyB);
    const guild = fakeGuild('g1', [channelA, channelB]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    assert.equal(result.aborted, false);
    assert.equal(result.done, true);
    assert.equal(store.getUser('g1', 'u1').messageCount, 2, 'channel A is still fully analyzed');
    assert.equal(store.getChannel('g1', 'chanB'), null, 'channel B never contributed any message this round');

    const warnLog = logs.find((l) => l.msg === 'warmup: channel fetch failed, skipping it for this round');
    assert.ok(warnLog);
    assert.equal(warnLog.channel, 'chanB');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Old-scheme progress: a finished run stays finished; an unfinished one is
// discarded (memory untouched) and the timeline starts over.
// ---------------------------------------------------------------------------

test('run: old-scheme progress marked done is kept done, never re-run', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot();
    const memory = fakeMemory(alwaysOk());

    store.state.data.warmup = {
      done: true,
      aborted: false,
      channels: { c1: { anchorId: 'x', limit: 100, messages: 12, batchesDone: 3, done: true } },
      tokensUsed: 500,
      requests: 3,
    };

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(result.done, true);
    assert.equal(memory.calls.length, 0, 'a done run is never re-run');
    assert.equal(store.state.data.warmup.tokensUsed, 500, 'the old record is left exactly as it was');
    assert.equal(warmup.isBlocking(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run: old-scheme progress not yet done is discarded (never any memory), and the timeline starts over', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    store.touchUser('g1', 'preexisting', 'Someone', Date.now());
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    store.state.data.warmup = {
      done: false,
      aborted: false,
      channels: { c1: { anchorId: 'old-anchor', limit: 50, messages: 5, batchesDone: 1, done: false } },
      tokensUsed: 999,
      requests: 9,
    };

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const { result, logs } = await withCapturedLogs(() => warmup.run());

    assert.equal(result.done, true);
    assert.equal(result.tokensUsed, 15, 'the old bookkeeping (999 tokens) is gone, this run starts from zero');
    assert.equal(memory.calls.length, 1);
    assert.ok(store.getUser('g1', 'preexisting'), 'memory itself is never touched by discarding progress');
    assert.equal(store.getUser('g1', 'u1').messageCount, 2);

    const warnLog = logs.find((l) => l.msg === 'warmup: discarding progress written by an older version, memory is untouched');
    assert.ok(warnLog);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Progress logs
// ---------------------------------------------------------------------------

test('run: emits "warmup: channel fetched", "warmup: batch done" and "warmup: window done" with counts only', async () => {
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

    const fetched = logs.find((l) => l.msg === 'warmup: channel fetched');
    assert.ok(fetched);
    assert.equal(fetched.channel, 'c1');
    assert.equal(fetched.messages, 4);

    const batchDone = logs.find((l) => l.msg === 'warmup: batch done');
    assert.ok(batchDone);
    assert.deepEqual(batchDone.channels, ['c1']);
    assert.equal(batchDone.batchIndex, 0);
    assert.equal(batchDone.batches, 1);
    assert.equal(batchDone.messages, 4);
    assert.equal(typeof batchDone.tokensUsed, 'number');
    assert.equal(typeof batchDone.maxTokens, 'number');
    assert.equal(typeof batchDone.requests, 'number');

    const windowDone = logs.find((l) => l.msg === 'warmup: window done');
    assert.ok(windowDone);
    assert.equal(windowDone.messages, 4);
    assert.equal(typeof windowDone.reachedTs, 'number');

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

test('status: shape after a run — messagesAnalyzed, messagesTotal, reachedTs, no primaryChannelId or channelsDone/Total', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 3, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history, 'general');
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();
    const s = warmup.status();

    assert.equal(s.messagesAnalyzed, 3);
    assert.equal(s.messagesTotal, 3);
    assert.ok(s.reachedTs > 0);
    assert.equal('primaryChannelId' in s, false);
    assert.equal('channelsDone' in s, false);
    assert.equal('channelsTotal' in s, false);
    assert.deepEqual(s.channels, [{ id: 'c1', name: 'general', limit: 200, messages: 3 }]);
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

// F30: /nep pause's bot-wide `store.state.data.paused` flag is a different
// thing entirely from the warm-up's OWN nested `store.state.data.warmup.paused`
// (set when stop() interrupts a run) -- either one must stop isBlocking() from
// auto-starting/counting the warm-up as due, but this one takes effect
// immediately at process start, even with a warm-up otherwise clearly due.
test('isBlocking: false when the bot-wide pause flag is set (F30), even though the warm-up itself would otherwise be due', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot({ warmup: { enabled: true } });
    const warmup = createWarmup({ hot, store, client: {}, memory: {}, getGuildId: () => 'g1' });

    store.state.data.paused = true;
    assert.equal(warmup.isBlocking(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// F30: a pause persisted before a restart must come back paused, and the
// warm-up must stay quiet across that restart too -- exactly the check
// src/index.js's own start-up path (`if (warmup.isBlocking()) warmup.run()`) relies on.
test('isBlocking: a pause survives a simulated restart (flush + a fresh store instance), the warm-up does not auto-start', () => {
  const dir = tempDir();
  try {
    const storeA = createStore({ dataDir: dir });
    storeA.state.data.paused = true;
    storeA.state.data.pausedAt = '2026-01-01T00:00:00.000Z';
    storeA.state.markDirty();
    storeA.flush();

    // A fresh process reading the same data/ -- otherwise clearly due (enabled, nothing done/aborted).
    const storeB = createStore({ dataDir: dir });
    const hot = fakeHot({ warmup: { enabled: true } });
    const warmup = createWarmup({ hot, store: storeB, client: {}, memory: {}, getGuildId: () => 'g1' });

    assert.equal(storeB.state.data.paused, true, 'the pause itself survives the restart');
    assert.equal(warmup.isBlocking(), false, 'the warm-up must not auto-start while the restart comes back paused');
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
    assert.equal(store.state.data.warmup.windowBatchesDone, 2);
    assert.equal(store.state.data.warmup.cursorId, null);
    assert.equal(warmup.isBlocking(), false, 'a paused run must not keep the persona mute forever');

    const memory2 = fakeMemory(alwaysOk());
    const warmup2 = createWarmup({ hot, store, client, memory: memory2, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result2 = await warmup2.run();

    assert.equal(result2.done, true);
    assert.equal(result2.paused, false);
    assert.equal(memory2.calls.length, 2, 'only the 2 remaining batches run');
    assert.ok(store.state.data.warmup.cursorId, 'the window finished this time');
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
    const hot = fakeHot({ warmup: { channelDepths: { chanB: 999 }, maxTokens: 999, batchMessages: 3 } });

    const warmup = createWarmup({ hot, store, client, memory: {}, getGuildId: () => 'g1' });
    const p = await warmup.plan();

    assert.deepEqual(p.plan.map((c) => c.id), ['chanB', 'chanA']);
    assert.equal(p.plan[0].role, 'listed');
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

// ---------------------------------------------------------------------------
// status().activity — in-memory run phase (F35 addendum), never persisted
// ---------------------------------------------------------------------------

test('activity: idle by default, before any run', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [])), memory: {}, getGuildId: () => 'g1' });

    assert.deepEqual(warmup.status().activity, { phase: 'idle', lastActivityAt: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: reports fetching progress with channel counts while fetching history', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const historyA = makeHistory({ count: 1, startTs: now - 5000, spacingMs: 1000, authorId: 'u1' });
    const historyB = makeHistory({ count: 1, startTs: now - 1000, spacingMs: 1000, authorId: 'u2' });
    const channelA = fakeChannel('chanA', historyA);
    const channelB = fakeChannel('chanB', historyB);
    const guild = fakeGuild('g1', [channelA, channelB]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    let warmup;
    const seen = [];
    for (const channel of [channelA, channelB]) {
      const originalFetch = channel.messages.fetch;
      channel.messages.fetch = async (opts) => {
        seen.push(warmup.status().activity);
        return originalFetch(opts);
      };
    }

    warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.ok(seen.length >= 1);
    assert.equal(seen[0].phase, 'fetching');
    assert.equal(seen[0].channelsFetched, 0, 'no channel has finished fetching yet at the very first call');
    assert.equal(seen[0].channelsTotal, 2);

    assert.equal(warmup.status().activity.phase, 'done', 'the run finishes (history exhausted) once fetching/analysing are done');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: reports the analysing phase with the window batch index and message count', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    // One channel, 4 messages, batchMessages: 2 -> packWindow yields exactly 2 batches of 2.
    const history = makeHistory({ count: 4, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 2 } });

    let warmup;
    const seen = [];
    const memory = fakeMemory((callIndex, batch) => {
      seen.push({ activity: warmup.status().activity, batchLen: batch.length });
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });

    warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(seen.length, 2, 'two batches of 2 messages each');
    assert.equal(seen[0].activity.phase, 'analysing');
    assert.equal(seen[0].activity.windowBatch, 1);
    assert.equal(seen[0].activity.windowBatches, 2);
    assert.equal(seen[0].activity.messages, 2);
    assert.equal(seen[1].activity.windowBatch, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: reports a distinct describing phase before analysing, when media descriptions are on', async () => {
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

    let warmup;
    let seenDuringDescribe;
    const describer = fakeDescriber(() => {
      seenDuringDescribe = warmup.status().activity;
      return { text: 'a cat', usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15 };
    });

    warmup = createWarmup({ hot, store, client, memory, describer, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.ok(seenDuringDescribe);
    assert.equal(seenDuringDescribe.phase, 'describing');
    assert.equal(seenDuringDescribe.windowBatch, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: waiting-rate-limit phase carries "until" and the wait count', async () => {
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

    let warmup;
    let seenDuringWait;
    const beforeWait = Date.now();
    const sleep = async () => {
      seenDuringWait = warmup.status().activity;
    };

    warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep });
    await warmup.run();

    assert.ok(seenDuringWait);
    assert.equal(seenDuringWait.phase, 'waiting-rate-limit');
    assert.equal(seenDuringWait.waits, 1);
    assert.ok(Number.isFinite(seenDuringWait.until));
    assert.ok(seenDuringWait.until >= beforeWait, 'until must be roughly "now + the wait", not stale');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: paused phase after stop() interrupts a rate-limit wait', async () => {
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
        warmup.stop();
        return rateLimited429();
      }
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });

    warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();

    assert.equal(warmup.status().activity.phase, 'paused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: aborted phase carries "rate-limit" as the reason after repeated rate limits', async () => {
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

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(result.aborted, true);
    const activity = warmup.status().activity;
    assert.equal(activity.phase, 'aborted');
    assert.equal(activity.reason, 'rate-limit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: aborted phase carries the analyzer\'s own reason after three strikes', async () => {
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

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    const result = await warmup.run();

    assert.equal(result.aborted, true);
    const activity = warmup.status().activity;
    assert.equal(activity.phase, 'aborted');
    assert.equal(activity.reason, 'llm-error');
    assert.equal(activity.detail, 'internal server error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: lastActivityAt strictly advances as the run moves from fetching to analysing', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now0 = Date.now();
    const history = makeHistory({ count: 2, startTs: now0 - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });

    let warmup;
    let duringFetch;
    const originalFetch = channel.messages.fetch;
    channel.messages.fetch = async (opts) => {
      duringFetch = warmup.status().activity.lastActivityAt;
      return originalFetch(opts);
    };

    let duringAnalyse;
    const memory = fakeMemory(() => {
      duringAnalyse = warmup.status().activity.lastActivityAt;
      return { ok: true, usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, result: {} };
    });

    let t = 1000;
    const now = () => {
      t += 1;
      return t;
    };

    warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep(), now });
    await warmup.run();

    assert.ok(Number.isFinite(duringFetch));
    assert.ok(Number.isFinite(duringAnalyse));
    assert.ok(duringAnalyse > duringFetch, 'lastActivityAt must move forward as the run progresses');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: never written to state.json (in-memory only)', async () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const now = Date.now();
    const history = makeHistory({ count: 2, startTs: now - 60_000, spacingMs: 1000, authorId: 'u1' });
    const channel = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [channel]);
    const client = fakeClient(guild);
    const hot = fakeHot({ warmup: { batchMessages: 10 } });
    const memory = fakeMemory(alwaysOk());

    const warmup = createWarmup({ hot, store, client, memory, getGuildId: () => 'g1', sleep: fakeSleep() });
    await warmup.run();
    store.flush();

    const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    assert.ok(!raw.includes('"activity"'), 'the run activity must never be persisted');
    assert.ok(!raw.includes('lastActivityAt'), 'the run activity must never be persisted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activity: status() stays cheap and side-effect free (repeated calls never change progress)', () => {
  const dir = tempDir();
  try {
    const store = createStore({ dataDir: dir });
    const hot = fakeHot();
    const warmup = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [])), memory: {}, getGuildId: () => 'g1' });

    const first = warmup.status();
    const second = warmup.status();
    assert.deepEqual(first, second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
