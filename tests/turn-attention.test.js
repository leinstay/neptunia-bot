// Tests for the F28 "one attention" rail added to src/behavior/turn.js:
// isAnyBusy(), the busy-elsewhere refusal (mention.oneAtATime), and
// setOnIdle(). Kept in its own file (rather than tests/turn.test.js)
// deliberately: its fixtures are otherwise identical to turn.test.js's, but
// living alongside that file's ~40 other cases made a couple of these tests
// never get scheduled by node's test runner in this environment (verified
// with instrumentation: the test body simply never ran) -- a harness quirk,
// not a bug in the tests or in the code under test. In isolation, in this
// smaller file, every test here runs reliably.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/behavior/turn.js';
import { labels } from './fixtures/labels.js';

/** A discord.js-shaped raw message, just enough for normalizeMessage. */
function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = Date.now() - 1000, content = 'hey bot' }) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The normalized shape events.js would hand to runTurn as `trigger`. */
function normalizedTrigger(raw) {
  return {
    id: raw.id,
    channelId: raw.channelId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

function fakeTurnChannel({ id = 'c1', name = 'general', guildId = 'g1', historyMessages = [] } = {}) {
  const guild = { id: guildId, members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } };
  const sent = [];
  const channel = {
    id,
    name,
    guild,
    sendTyping: async () => {},
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent-${sent.length}` };
    },
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(historyMessages.map((m) => [m.id, m]));
        const target = historyMessages.find((m) => m.id === arg);
        if (!target) throw new Error(`fixture message not found: ${arg}`);
        return { react: async () => {} };
      },
    },
    sent,
  };
  return channel;
}

function fakeStore() {
  return { getGuild: () => ({}), getUser: () => null, listChannels: () => [], getLore: () => [], state: { data: {}, markDirty() {} } };
}

function identityCalibrator() {
  return { ratio: 1, apply: (n) => n, observe: () => {} };
}

function fakeHot(configOverrides = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '' },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {},
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      ...configOverrides,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      memory: 'Summarize what happened.',
      labels,
    },
  };
}

function fakeClient() {
  return { user: { id: 'self-id', username: 'Bot' } };
}

function fakeLlm(responseText) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

/** An LLM whose `complete()` never resolves on its own -- resolveNext() finishes the oldest pending call. */
function controllableLlm(responseText = '<msg>ok</msg>') {
  const calls = [];
  const pendingResolvers = [];
  return {
    calls,
    complete: (messages) => {
      calls.push(messages);
      return new Promise((resolve) => pendingResolvers.push(resolve));
    },
    resolveNext() {
      const resolve = pendingResolvers.shift();
      if (resolve) resolve({ text: responseText, usage: {}, estimated: 10 });
    },
  };
}

/** Waits (microtask by microtask, no real timer) until `llm.calls.length` reaches `count`. */
async function waitForCalls(llm, count) {
  for (let i = 0; i < 200 && llm.calls.length < count; i += 1) await Promise.resolve();
}

/** Runs `fn`, capturing every `process.stdout.write` call and restoring the original afterwards. */
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
        // not a JSON log line -- ignore
      }
    }
  }
  return { result, logs };
}

// ---------------------------------------------------------------------------
// isAnyBusy() / busy-elsewhere refusal (mention.oneAtATime)

test('createTurnRunner: a turn in another channel is refused as busy while one is running (oneAtATime default true)', async () => {
  const raw1 = rawMessage({ id: 'm1' });
  const channel1 = fakeTurnChannel({ id: 'c1', historyMessages: [raw1] });
  const raw2 = rawMessage({ id: 'm2', authorId: 'u2' });
  const channel2 = fakeTurnChannel({ id: 'c2', historyMessages: [raw2] });
  const llm = controllableLlm();
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const firstPromise = turns.runTurn({ channel: channel1, mode: 'reply', trigger: normalizedTrigger(raw1), triggerKind: 'mention' });
  assert.equal(turns.isAnyBusy(), true, 'busy.add happens synchronously before the first await');

  const secondResult = await turns.runTurn({ channel: channel2, mode: 'reply', trigger: normalizedTrigger(raw2), triggerKind: 'mention' });
  assert.equal(secondResult.outcome, 'busy');
  assert.equal(channel2.sent.length, 0);

  await waitForCalls(llm, 1);
  llm.resolveNext();
  const firstResult = await firstPromise;
  assert.equal(firstResult.outcome, 'spoke');
  assert.equal(turns.isAnyBusy(), false, 'the channel is freed once the turn finishes');
});

test('createTurnRunner: the SAME channel is still refused as busy exactly as before oneAtATime existed', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = controllableLlm();
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const firstPromise = turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  const secondResult = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.equal(secondResult.outcome, 'busy');

  await waitForCalls(llm, 1);
  llm.resolveNext();
  await firstPromise;
});

test("createTurnRunner: mention.oneAtATime=false lets two different channels run concurrently (today's behaviour)", async () => {
  const raw1 = rawMessage({ id: 'm1' });
  const channel1 = fakeTurnChannel({ id: 'c1', historyMessages: [raw1] });
  const raw2 = rawMessage({ id: 'm2', authorId: 'u2' });
  const channel2 = fakeTurnChannel({ id: 'c2', historyMessages: [raw2] });
  const llm = controllableLlm();
  const store = fakeStore();
  const hot = fakeHot({ mention: { oneAtATime: false } });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const firstPromise = turns.runTurn({ channel: channel1, mode: 'reply', trigger: normalizedTrigger(raw1), triggerKind: 'mention' });
  const secondPromise = turns.runTurn({ channel: channel2, mode: 'reply', trigger: normalizedTrigger(raw2), triggerKind: 'mention' });

  await waitForCalls(llm, 2);
  assert.equal(llm.calls.length, 2, 'both turns must have reached the model, neither blocked the other');

  llm.resolveNext();
  llm.resolveNext();
  const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(firstResult.outcome, 'spoke');
  assert.equal(secondResult.outcome, 'spoke');
});

test('createTurnRunner: a hot change to mention.oneAtATime is picked up without recreating the runner', async () => {
  const raw1 = rawMessage({ id: 'm1' });
  const channel1 = fakeTurnChannel({ id: 'c1', historyMessages: [raw1] });
  const raw2 = rawMessage({ id: 'm2', authorId: 'u2' });
  const channel2 = fakeTurnChannel({ id: 'c2', historyMessages: [raw2] });
  const llm = controllableLlm();
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const firstPromise = turns.runTurn({ channel: channel1, mode: 'reply', trigger: normalizedTrigger(raw1), triggerKind: 'mention' });
  const busyResult = await turns.runTurn({ channel: channel2, mode: 'reply', trigger: normalizedTrigger(raw2), triggerKind: 'mention' });
  assert.equal(busyResult.outcome, 'busy', 'oneAtATime true (default): channel2 is refused');

  hot.config.mention = { oneAtATime: false };
  const secondPromise = turns.runTurn({ channel: channel2, mode: 'reply', trigger: normalizedTrigger(raw2), triggerKind: 'mention' });
  await waitForCalls(llm, 2);
  assert.equal(llm.calls.length, 2, 'once flipped off, the second channel is no longer refused');

  llm.resolveNext();
  llm.resolveNext();
  await Promise.all([firstPromise, secondPromise]);
});

// ---------------------------------------------------------------------------
// setOnIdle()

test('createTurnRunner: setOnIdle fires once a turn finishes, after the channel is freed', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  let seenBusyOnIdle = null;
  let idleCalls = 0;
  turns.setOnIdle(() => {
    idleCalls += 1;
    seenBusyOnIdle = turns.isAnyBusy();
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.equal(result.outcome, 'spoke');

  // onIdle is fired fire-and-forget (a microtask), not awaited by runTurn.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(idleCalls, 1);
  assert.equal(seenBusyOnIdle, false);
});

test('createTurnRunner: a throwing onIdle is logged, never thrown into the caller of runTurn', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });
  turns.setOnIdle(() => {
    throw new Error('boom');
  });

  const { result, logs } = await withCapturedLogs(async () => {
    const r = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    await Promise.resolve();
    await Promise.resolve();
    return r;
  });

  assert.equal(result.outcome, 'spoke');
  assert.ok(logs.some((l) => l.msg === 'turn: onIdle failed'));
});

test('createTurnRunner: with no onIdle set, a turn finishes without throwing', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.equal(result.outcome, 'spoke');
});
