// Tests for src/behavior/turn.js: the pure helpers (between, typingMs,
// resolveMentions) plus one integration-style suite for createTurnRunner
// itself, driven with fake discord.js-shaped objects, a fake LLM and a fake
// store -- proving the feature switches (reactions, multiMessage,
// typingSimulation, memory) are applied where this module is responsible for
// them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { between, typingMs, resolveMentions, createTurnRunner } from '../src/behavior/turn.js';
import { labels } from './fixtures/labels.js';

function rngReturning(value) {
  return () => value;
}

test('between: rng=0 returns the minimum', () => {
  assert.equal(between([10, 20], rngReturning(0)), 10);
});

test('between: rng=1 returns the maximum', () => {
  assert.equal(between([10, 20], rngReturning(1)), 20);
});

test('between: rng=0.5 returns the midpoint', () => {
  assert.equal(between([10, 20], rngReturning(0.5)), 15);
});

test('typingMs: clamps below minMs for very short text', () => {
  const cfg = { msPerChar: [1, 1], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a', cfg, rngReturning(0)); // 1 char * 1ms/char = 1ms, way under minMs
  assert.equal(ms, 900);
});

test('typingMs: clamps above maxMs for very long text', () => {
  const cfg = { msPerChar: [100, 100], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a'.repeat(1000), cfg, rngReturning(0)); // 100,000ms, way over maxMs
  assert.equal(ms, 12000);
});

test('typingMs: within range uses length * msPerChar (rounded)', () => {
  const cfg = { msPerChar: [10, 10], minMs: 0, maxMs: 100000 };
  const ms = typingMs('a'.repeat(20), cfg, rngReturning(0));
  assert.equal(ms, 200);
});

test('typingMs: msPerChar is itself sampled via rng between its [min, max]', () => {
  const cfg = { msPerChar: [10, 20], minMs: 0, maxMs: 100000 };
  const ms = typingMs('a'.repeat(10), cfg, rngReturning(1)); // picks msPerChar=20
  assert.equal(ms, 200);
});

function historyMsg(authorName, authorId, overrides = {}) {
  return { authorName, authorId, self: false, bot: false, ...overrides };
}

test('resolveMentions: replaces a known @name with a real Discord mention', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Alice πώς είσαι', history);
  assert.equal(result.text, 'γεια <@u1> πώς είσαι');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: an unknown name is left untouched', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Ghost', history);
  assert.equal(result.text, 'γεια @Ghost');
  assert.deepEqual(result.userIds, []);
});

test('resolveMentions: excludes its own lines and bot lines from candidates', () => {
  const history = [
    historyMsg('Zoë', 'self-id', { self: true }),
    historyMsg('SomeBot', 'bot-id', { bot: true }),
    historyMsg('Alice', 'u1'),
  ];
  const result = resolveMentions('@Zoë @SomeBot @Alice', history);
  assert.equal(result.text, '@Zoë @SomeBot <@u1>');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: longer names are matched before their shorter prefixes', () => {
  const history = [historyMsg('Anna', 'short-id'), historyMsg('AnnaMaria', 'long-id')];
  const result = resolveMentions('γεια @AnnaMaria', history);
  // Must not first match "@Anna" inside "@AnnaMaria" and leave "Maria" dangling.
  assert.equal(result.text, 'γεια <@long-id>');
  assert.deepEqual(result.userIds, ['long-id']);
});

test('resolveMentions: replaces every occurrence of the same name', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Alice γεια @Alice', history);
  assert.equal(result.text, '<@u1> γεια <@u1>');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: deduplicates authors that appear more than once in history', () => {
  const history = [historyMsg('Alice', 'u1'), historyMsg('Alice', 'u1', { content: 'again' })];
  const result = resolveMentions('@Alice', history);
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: text with no mentions is returned unchanged with empty userIds', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('απλό κείμενο', history);
  assert.equal(result.text, 'απλό κείμενο');
  assert.deepEqual(result.userIds, []);
});

// ---------------------------------------------------------------------------
// createTurnRunner — integration-style, fake channel/llm/store/hot.

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

/** A discord.js-shaped raw message, just enough for normalizeMessage. */
function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = NOW - 1000, content = 'hey bot' }) {
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
  const typingCalls = [];
  const reactCalls = [];
  const channel = {
    id,
    name,
    guild,
    sendTyping: async () => {
      typingCalls.push(Date.now());
    },
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent-${sent.length}` };
    },
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) {
          return new Map(historyMessages.map((m) => [m.id, m]));
        }
        const target = historyMessages.find((m) => m.id === arg);
        if (!target) throw new Error(`fixture message not found: ${arg}`);
        return { react: async (emoji) => reactCalls.push({ id: arg, emoji }) };
      },
    },
    sent,
    typingCalls,
    reactCalls,
  };
  return channel;
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

function fakeStore({ guildMemory = {}, userProfiles = {}, channels = [] } = {}) {
  return {
    getGuild: () => guildMemory,
    getUser: (guildId, userId) => userProfiles[userId] ?? null,
    listChannels: () => channels,
    state: { data: {}, markDirty() {} },
  };
}

function identityCalibrator() {
  return { ratio: 1, apply: (n) => n, observe: () => {} };
}

function fakeHot(featureOverrides = {}, botOverrides = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '', ...botOverrides },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 1600 },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: featureOverrides,
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

function fakeClient(overrides = {}) {
  return { user: { id: 'self-id', username: 'Bot' }, ...overrides };
}

/** Runs `fn`, capturing every `process.stdout.write` call (the log module's only sink) and
 * restoring the original afterwards even if `fn` throws. Returns the parsed JSON log entries
 * alongside `fn`'s resolved value; non-JSON stdout noise (e.g. the test runner's own output
 * interleaving) is silently skipped rather than failing the capture. */
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

test('createTurnRunner: features.reactions=false drops reactions; nothing else to do means outcome "skip"', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<react to="#1">💀</react>');
  const store = fakeStore();
  const hot = fakeHot({ reactions: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'skip');
  assert.equal(channel.sent.length, 0);
  assert.equal(channel.reactCalls.length, 0);
});

test('createTurnRunner: features.multiMessage=false keeps only the first <msg>', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>First</msg><msg>Second</msg>');
  const store = fakeStore();
  const hot = fakeHot({ multiMessage: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'First');
});

test('createTurnRunner: features.typingSimulation=false skips sendTyping and every artificial delay', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>Hello there</msg>');
  const store = fakeStore();
  const hot = fakeHot({ typingSimulation: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const started = Date.now();
  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.typingCalls.length, 0);
  assert.equal(channel.sent.length, 1);
  assert.ok(elapsed < 200, `expected no artificial delay, took ${elapsed}ms`);
});

test('createTurnRunner: features.memory=true (default) renders <people> and <about_chat>', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    guildMemory: { patterns: 'lots of emoji' },
    userProfiles: { u1: { id: 'u1', names: ['Alice'], character: 'friendly' } },
  });
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = llm.calls[0][1].content;
  assert.ok(userMessage.includes('<people>'));
  assert.ok(userMessage.includes('<about_chat>'));
});

test('createTurnRunner: features.memory=false sends no <people> or <about_chat> block', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    guildMemory: { patterns: 'lots of emoji' },
    userProfiles: { u1: { id: 'u1', names: ['Alice'], character: 'friendly' } },
  });
  const hot = fakeHot({ memory: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  const userMessage = llm.calls[0][1].content;
  assert.equal(typeof userMessage, 'string');
  assert.ok(!userMessage.includes('<people>'));
  assert.ok(!userMessage.includes('<about_chat>'));
});

test('createTurnRunner: features.memory=true (default) renders the <server> channel map', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    channels: [{ id: 'c1', name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '', days: {}, lastMessageAt: null }],
  });
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = llm.calls[0][1].content;
  assert.ok(userMessage.includes('<server>'));
  assert.ok(userMessage.includes(`# general${labels.server.currentMark}`));
});

test('createTurnRunner: features.memory=false sends no <server> block, even with channels on record', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    channels: [{ id: 'c1', name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '', days: {}, lastMessageAt: null }],
  });
  const hot = fakeHot({ memory: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = llm.calls[0][1].content;
  assert.ok(!userMessage.includes('<server>'));
});

// ---------------------------------------------------------------------------
// features.dryRun -- the persona thinks and decides for real, but never
// touches the target channel; instead it logs, and optionally mirrors, what
// it would have done.

test('createTurnRunner: features.dryRun=true sends and reacts nowhere, only logs, and paces itself as if it had spoken', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">Hello there</msg><react to="#1">\u{1F389}</react>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const before = turns.lastPostAt('c1');
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, true);
  assert.equal(channel.sent.length, 0);
  assert.equal(channel.typingCalls.length, 0);
  assert.equal(channel.reactCalls.length, 0);
  assert.ok(turns.lastPostAt('c1') > before, 'lastPostAt must advance as if the persona had actually spoken');

  const sendLine = logs.find((l) => l.msg === 'dry-run: would send');
  const reactLine = logs.find((l) => l.msg === 'dry-run: would react');
  assert.ok(sendLine, 'expected a "dry-run: would send" log line');
  assert.equal(sendLine.channel, 'c1');
  assert.equal(sendLine.channelName, 'general');
  assert.equal(sendLine.mode, 'reply');
  assert.equal(sendLine.replyTo, 'm1');
  assert.equal(sendLine.text, 'Hello there');
  assert.ok(reactLine, 'expected a "dry-run: would react" log line');
  assert.equal(reactLine.channel, 'c1');
  assert.equal(reactLine.channelName, 'general');
  assert.equal(reactLine.to, 'm1');
  assert.equal(reactLine.emoji, '\u{1F389}');
});

test('createTurnRunner: features.dryRun=true mirrors each action into bot.dryRunChannelId, without real mentions', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">hi @Alice</msg>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' });
  const mirrorSent = [];
  const client = fakeClient({
    channels: {
      fetch: async (id) => {
        assert.equal(id, 'mirror1');
        return {
          send: async (payload) => {
            mirrorSent.push(payload);
            return { id: 'mirror-msg-1' };
          },
        };
      },
    },
  });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(mirrorSent.length, 1);
  assert.deepEqual(mirrorSent[0].allowedMentions, { parse: [] });
  const [header, ...bodyLines] = mirrorSent[0].content.split('\n');
  assert.equal(header, '[dry-run] #general · reply · reply to Alice');
  assert.equal(bodyLines.join('\n'), 'hi @Alice');
  assert.ok(!mirrorSent[0].content.includes('<@'), 'a mirrored @name must never resolve to a real mention');
});

test('createTurnRunner: features.dryRun=true with no bot.dryRunChannelId configured mirrors nothing', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>hello</msg>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true });
  let fetchCalled = false;
  const client = fakeClient({ channels: { fetch: async () => { fetchCalled = true; return null; } } });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(fetchCalled, false, 'an empty dryRunChannelId must never be fetched');
});

test('createTurnRunner: features.dryRun=true swallows a mirror channel failure and still finishes the turn', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>hello</msg>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' });
  const client = fakeClient({
    channels: {
      fetch: async () => {
        throw new Error('missing access');
      },
    },
  });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 0);
  assert.ok(logs.some((l) => l.msg === 'turn: dry-run mirror failed'));
});

test('createTurnRunner: features.dryRun=false (default) sends for real even when bot.dryRunChannelId is set', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>hello</msg>');
  const store = fakeStore();
  const hot = fakeHot({}, { dryRunChannelId: 'mirror1' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, undefined);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'hello');
});
