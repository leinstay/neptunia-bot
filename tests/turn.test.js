// Tests for src/behavior/turn.js: the pure helpers (between, typingMs,
// resolveMentions) plus one integration-style suite for createTurnRunner
// itself, driven with fake discord.js-shaped objects, a fake LLM and a fake
// store -- proving the feature switches (reactions, multiMessage,
// typingSimulation, memory) are applied where this module is responsible for
// them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { between, typingMs, resolveMentions, createTurnRunner, parseRewatchPick, parseRewatchPickDetailed } from '../src/behavior/turn.js';
import { fill } from '../src/discord/format.js';
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
function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = NOW - 1000,
  content = 'hey bot',
  attachments = new Map(),
  stickers = new Map(),
}) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments,
    stickers,
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

function fakeStore({ guildMemory = {}, userProfiles = {}, channels = [], loreEntries = [] } = {}) {
  return {
    getGuild: () => guildMemory,
    getUser: (guildId, userId) => userProfiles[userId] ?? null,
    listChannels: () => channels,
    listUserProfiles: () => Object.values(userProfiles),
    getLore: () => loreEntries,
    state: { data: {}, markDirty() {} },
  };
}

function identityCalibrator() {
  return { ratio: 1, apply: (n) => n, observe: () => {} };
}

function fakeHot(featureOverrides = {}, botOverrides = {}, configOverrides = {}) {
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
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: featureOverrides,
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

function fakeClient(overrides = {}) {
  return { user: { id: 'self-id', username: 'Bot' }, ...overrides };
}

/** A fake createImageFetcher()-shaped dependency (see src/discord/fetch-image.js). `result` may be
 * `null` (every download fails), a fixed success object, or `(url, options) => result|null`. */
function fakeImageFetcher(result = { dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' }) {
  const calls = [];
  return {
    calls,
    fetchAsDataUrl: async (url, options) => {
      calls.push({ url, options });
      return typeof result === 'function' ? result(url, options) : result;
    },
  };
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

// /nep pause: no new turn may start while paused -- a reply, an
// interject, an initiate, an eavesdrop or a forced turn alike, whatever the mode.
test('runTurn: refuses with outcome "paused" while store.state.data.paused is true, before touching the LLM or busy', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const store = fakeStore();
  store.state.data.paused = true;
  const hot = fakeHot();
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'paused');
  assert.equal(llm.calls.length, 0, 'the LLM must never be called while paused');
  assert.equal(turns.isBusy(channel.id), false, 'the channel is never marked busy for a refused turn');
});

// /nep interject, /nep initiate: forced is passed straight through to
// buildRequest, which appends prompts.forced (when present) to the task text.
test('runTurn: forced=true appends prompts.forced to the task text sent to the LLM', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.forced = 'FORCED_TASK_TEXT';
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'interject', forced: true });

  assert.equal(llm.calls.length, 1);
  const userText = llm.calls[0][1].content;
  assert.ok(userText.includes('FORCED_TASK_TEXT'));
});

test('runTurn: forced defaults to false -- prompts.forced is never appended for an ordinary spontaneous turn', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.forced = 'FORCED_TASK_TEXT';
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'interject' });

  assert.equal(llm.calls.length, 1);
  const userText = llm.calls[0][1].content;
  assert.ok(!userText.includes('FORCED_TASK_TEXT'));
});

test('waitIdle: resolves immediately when no turn is in flight', async () => {
  const store = fakeStore();
  const hot = fakeHot();
  const turns = createTurnRunner({ hot, store, llm: fakeLlm('<msg>hi</msg>'), calibrator: identityCalibrator(), client: fakeClient() });

  let resolved = false;
  turns.waitIdle().then(() => { resolved = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, true);
});

test('waitIdle: resolves only once every in-flight turn has finished', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const store = fakeStore();
  const hot = fakeHot();
  let releaseLlm;
  const llm = { complete: () => new Promise((resolve) => { releaseLlm = () => resolve({ text: '<msg>hi</msg>', usage: {}, estimated: 1 }); }) };
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const turnPromise = turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  // Let runTurn's own awaits (fetchHistory, withTextPreviews, fetchNeighbors,
  // buildRequest...) settle before it reaches the still-pending LLM call.
  await new Promise((resolve) => setTimeout(resolve, 0));

  let idleResolved = false;
  const idlePromise = turns.waitIdle().then(() => { idleResolved = true; });
  assert.equal(idleResolved, false, 'must not resolve while the turn is still in flight');

  releaseLlm();
  await turnPromise;
  await idlePromise;
  assert.equal(idleResolved, true);
});

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

test('createTurnRunner: features.memory=true (default) renders <lore> from the guild lorebook', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const loreEntries = [{ id: 'l1', title: 'The Great Flood', keys: ['never-mentioned'], text: 'It flooded once.', always: true, source: 'analyzer', weight: 3 }];
  const store = fakeStore({ loreEntries });
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = llm.calls[0][1].content;
  assert.ok(userMessage.includes('<lore>'));
  assert.ok(userMessage.includes('The Great Flood'));
});

test('createTurnRunner: features.memory=false sends no <lore> block, even with lore on record', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const loreEntries = [{ id: 'l1', title: 'The Great Flood', keys: ['never-mentioned'], text: 'It flooded once.', always: true, source: 'analyzer', weight: 3 }];
  const store = fakeStore({ loreEntries });
  const hot = fakeHot({ memory: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = llm.calls[0][1].content;
  assert.ok(!userMessage.includes('<lore>'));
});

// ---------------------------------------------------------------------------
// features.mediaDescriptions -- describing pictures that are not attached.

function fakeDescriber(descriptionsById) {
  const calls = [];
  return {
    calls,
    describeMany: async (guildId, items, options) => {
      calls.push({ guildId, items, options });
      const descriptions = new Map();
      for (const item of items) {
        if (descriptionsById[item.itemId]) descriptions.set(item.itemId, descriptionsById[item.itemId]);
      }
      return { descriptions, newCount: descriptions.size };
    },
  };
}

/** fakeDescriber plus describeVideos: every candidate in `statesById` gets that state. */
function fakeVideoDescriber(statesById, descriptionsById = {}) {
  const base = fakeDescriber(descriptionsById);
  const videoCalls = [];
  return {
    ...base,
    videoCalls,
    describeVideos: async (guildId, items, options) => {
      videoCalls.push({ guildId, items, options });
      const videos = new Map();
      for (const item of items) {
        if (statesById[item.itemId]) videos.set(item.itemId, statesById[item.itemId]);
      }
      return { videos, newCount: videos.size };
    },
  };
}

function videoAttachmentRaw(id, ts, attachmentId, name) {
  return rawMessage({
    id,
    ts,
    attachments: new Map([
      [attachmentId, { id: attachmentId, contentType: 'video/mp4', name, url: `https://cdn.discordapp.com/attachments/1/2/${name}`, duration: 20 }],
    ]),
  });
}

const VIDEO_TURN_CONFIG = {
  media: { maxPerTurn: 6, filePreviewChars: 500, video: { maxPerTurn: 1, sites: ['youtube.com'] } },
};

test('createTurnRunner: features.videoDescriptions on -- videos newest first, capped at media.video.maxPerTurn, rendered watched', async () => {
  const older = videoAttachmentRaw('m1', NOW - 5000, 'va', 'older.mp4');
  const newer = rawMessage({ id: 'm2', ts: NOW - 1000, content: 'look https://www.youtube.com/watch?v=abc' });
  const channel = fakeTurnChannel({ historyMessages: [older, newer] });
  const llm = fakeLlm('<msg>ok</msg>');
  const hot = fakeHot({ mediaDescriptions: true, videoDescriptions: true, vision: false }, {}, VIDEO_TURN_CONFIG);
  const describer = fakeVideoDescriber({ va: { state: 'watched', text: 'κάποιος χορεύει' } });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(newer), triggerKind: 'mention' });

  assert.equal(describer.videoCalls.length, 1);
  const { guildId, items, options } = describer.videoCalls[0];
  assert.equal(guildId, 'g1');
  assert.deepEqual(
    items.map((item) => item.source),
    ['link', 'attachment'],
    'the newest message first; the typed video link is found because fetchHistory got media.video.sites',
  );
  assert.equal(items[1].itemId, 'va');
  assert.equal(options.maxNew, 1);
  assert.equal(options.countAgainstDailyCap, true);
  const userMessage = llm.calls[0][1].content;
  const watched = labels.transcript.videoWatched
    .replace('{name}', 'older.mp4')
    .replace('{duration}', '0:20')
    .replace('{text}', 'κάποιος χορεύει');
  assert.ok(userMessage.includes(watched));
});

test('createTurnRunner: media.video.maxPerTurn missing -> at most one new video per turn', async () => {
  const raw = videoAttachmentRaw('m1', NOW - 1000, 'va', 'clip.mp4');
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const hot = fakeHot({ mediaDescriptions: true, videoDescriptions: true }, {}, { media: { maxPerTurn: 6, filePreviewChars: 500 } });
  const describer = fakeVideoDescriber({});
  const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<msg>ok</msg>'), calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.videoCalls[0].options.maxNew, 1);
});

test('createTurnRunner: features.videoDescriptions missing counts as on (mediaDescriptions on) -- videos are watched', async () => {
  const raw = videoAttachmentRaw('m1', NOW - 1000, 'va', 'clip.mp4');
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const hot = fakeHot({ mediaDescriptions: true }, {}, VIDEO_TURN_CONFIG);
  const describer = fakeVideoDescriber({ va: { state: 'watched', text: 'x' } });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<msg>ok</msg>'), calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.videoCalls.length, 1);
  assert.equal(describer.videoCalls[0].items[0].itemId, 'va');
});

test('createTurnRunner: videoDescriptions off, or mediaDescriptions off, never calls describeVideos', async () => {
  for (const features of [
    { mediaDescriptions: true, videoDescriptions: false },
    { mediaDescriptions: false, videoDescriptions: true },
  ]) {
    const raw = videoAttachmentRaw('m1', NOW - 1000, 'va', 'clip.mp4');
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const hot = fakeHot(features, {}, VIDEO_TURN_CONFIG);
    const describer = fakeVideoDescriber({ va: { state: 'watched', text: 'x' } });
    const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<msg>ok</msg>'), calibrator: identityCalibrator(), client: fakeClient(), describer });

    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

    assert.equal(describer.videoCalls.length, 0);
  }
});

test('createTurnRunner: features.mediaDescriptions off (default) never calls the describer', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([['img1', { id: 'img1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png' }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const describer = fakeDescriber({ img1: 'a cat' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 0);
});

test('createTurnRunner: features.mediaDescriptions on describes an un-attached picture and it renders imageDescribed', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([['img1', { id: 'img1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png' }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({ mediaDescriptions: true });
  const describer = fakeDescriber({ img1: 'a grey cat' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'img1');
  assert.equal(describer.calls[0].options.maxNew, 6);
  const userMessage = llm.calls[0][1].content;
  assert.ok(userMessage.includes(labels.transcript.imageDescribed.replace('{text}', 'a grey cat')));
});

test('createTurnRunner: features.mediaDescriptions on describes a picture-format sticker via the same describer/cache path', async () => {
  const raw = rawMessage({
    id: 'm1',
    stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({ mediaDescriptions: true });
  const describer = fakeDescriber({ 'sticker:s1': 'a frog gives a thumbs up' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'sticker:s1');
  const userMessage = llm.calls[0][1].content;
  assert.ok(
    userMessage.includes(labels.transcript.stickerDescribed.replace('{name}', 'pepe').replace('{text}', 'a frog gives a thumbs up')),
  );
});

test('createTurnRunner: features.mediaDescriptions on describes a custom emoji in the text, appended as an extra tag', async () => {
  const raw = rawMessage({ id: 'm1', content: 'nice <:pog:111> job' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({ mediaDescriptions: true });
  const describer = fakeDescriber({ 'emoji:111': 'a surprised cat face' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'emoji:111');
  const userMessage = llm.calls[0][1].content;
  assert.ok(userMessage.includes('nice :pog: job'));
  assert.ok(userMessage.includes(labels.transcript.emojiDescribed.replace('{name}', 'pog').replace('{text}', 'a surprised cat face')));
});

test('createTurnRunner: a text attachment is fetched lazily and rendered via filePreview', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([['t1', { id: 't1', contentType: 'text/plain', name: 'notes.txt', url: 'https://cdn/notes.txt' }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  let fetchedUrl = null;
  const fetchImpl = async (url) => {
    fetchedUrl = url;
    return { ok: true, headers: { get: () => null }, text: async () => 'the file says hello' };
  };
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), fetchImpl });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(fetchedUrl, 'https://cdn/notes.txt');
  const userMessage = llm.calls[0][1].content;
  assert.ok(userMessage.includes(labels.transcript.filePreview.replace('{name}', 'notes.txt').replace('{text}', 'the file says hello')));
});

test('createTurnRunner: a text-attachment fetch failure falls back to the plain file form', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([['t1', { id: 't1', contentType: 'text/plain', name: 'notes.txt', url: 'https://cdn/notes.txt' }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), fetchImpl });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = llm.calls[0][1].content;
  assert.ok(userMessage.includes(labels.transcript.file.replace('{name}', 'notes.txt')));
});

// ---------------------------------------------------------------------------
// A provider that rejects the images (4xx) retries text-only -- the retry
// must never resend text still claiming a picture is attached.

function fakeLlmRejectingImagesOnce(statusCode, responseText) {
  const calls = [];
  let first = true;
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      if (first) {
        first = false;
        const err = new Error('bad request');
        err.statusCode = statusCode;
        throw err;
      }
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

function videoTrigger(raw) {
  return {
    ...normalizedTrigger(raw),
    attachments: [
      { id: 'v1', kind: 'video', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', name: 'clip.mp4', durationSec: 34 },
    ],
  };
}

test('createTurnRunner: a 4xx image error (download succeeded, the provider itself still rejects) retries text-only, rendering the video blind (frameAttached dropped)', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['v1', { id: 'v1', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', duration: 34 }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlmRejectingImagesOnce(400, '<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const imageFetcher = fakeImageFetcher();
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const trigger = videoTrigger(raw);

  const result = await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 2, 'the first (image) attempt and the text-only retry');

  const firstUser = llm.calls[0][1].content;
  assert.ok(Array.isArray(firstUser), 'the first attempt carries image_url parts');
  const firstText = firstUser.find((p) => p.type === 'text').text;
  assert.ok(firstText.includes(labels.transcript.frameAttached.replace('{n}', '1')));
  const firstImage = firstUser.find((p) => p.type === 'image_url');
  assert.ok(firstImage.image_url.url.startsWith('data:'), 'the downloaded picture is sent as a data: URL, never the bare CDN URL');

  const secondUser = llm.calls[1][1].content;
  assert.equal(typeof secondUser, 'string', 'the retry sends plain text, no image_url parts');
  assert.ok(secondUser.includes('[video: clip.mp4, 0:34]'), 'the video still renders in its blind form');
  assert.ok(!secondUser.includes('still frame'), 'frameAttached must not survive into the text-only retry');
});

// ---------------------------------------------------------------------------
// The picture is downloaded and inlined as a data: URL BEFORE the model
// ever sees the request -- the provider's own fetcher gets a 403 from
// Discord on some CDN hosts even though our server fetches the same URL
// fine. A failed download drops EVERY picture of the turn (never a partial,
// mis-numbered set) and falls back to plain text.

function videoRaw(id = 'm1') {
  return rawMessage({
    id,
    attachments: new Map([
      ['v1', { id: 'v1', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', duration: 34 }],
    ]),
  });
}

test('createTurnRunner: a picture is downloaded and sent as a data: URL, never the bare Discord CDN URL', async () => {
  const raw = videoRaw();
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const imageFetcher = fakeImageFetcher();
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(imageFetcher.calls.length, 1);
  assert.equal(imageFetcher.calls[0].url.includes('clip.mp4'), true);
  assert.deepEqual(imageFetcher.calls[0].options, { maxBytes: 1_500_000, timeoutMs: 10_000 });
  const userContent = llm.calls[0][1].content;
  const imagePart = userContent.find((p) => p.type === 'image_url');
  assert.equal(imagePart.image_url.url, 'data:image/webp;base64,ZmFrZQ==');
});

test('createTurnRunner: a failed download drops EVERY picture of the turn -- sent as plain text, rendering blind, not attached', async () => {
  const raw = videoRaw();
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const imageFetcher = fakeImageFetcher(null); // every download fails
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  const userContent = llm.calls[0][1].content;
  assert.equal(typeof userContent, 'string', 'no image_url parts must be sent once any download failed');
  assert.ok(userContent.includes('[video: clip.mp4, 0:34]'), 'the video renders in its blind form');
  assert.ok(!userContent.includes('still frame'), 'frameAttached must not survive a dropped picture');
});

test('createTurnRunner: with two pictures, one failed download drops BOTH -- never a partial, mis-numbered set', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['i1', { id: 'i1', contentType: 'image/png', name: 'one.png', url: 'https://cdn.discordapp.com/x/one.png' }],
      ['i2', { id: 'i2', contentType: 'image/png', name: 'two.png', url: 'https://cdn.discordapp.com/x/two.png' }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  // one.png succeeds, two.png fails.
  const imageFetcher = fakeImageFetcher((url) =>
    url.includes('one.png') ? { dataUrl: 'data:image/png;base64,b25l', bytes: 3, contentType: 'image/png' } : null,
  );
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const trigger = {
    ...normalizedTrigger(raw),
    attachments: [
      { id: 'i1', kind: 'image', url: 'https://cdn.discordapp.com/x/one.png', name: 'one.png' },
      { id: 'i2', kind: 'image', url: 'https://cdn.discordapp.com/x/two.png', name: 'two.png' },
    ],
  };

  const result = await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  const userContent = llm.calls[0][1].content;
  assert.equal(typeof userContent, 'string', 'both pictures must be dropped, not just the failed one');
  assert.ok(
    !userContent.includes(labels.transcript.imageAttached.replace('{n}', '1')) &&
      !userContent.includes(labels.transcript.imageAttached.replace('{n}', '2')),
    'neither picture is claimed as attached once one download failed',
  );
  assert.ok(userContent.includes(labels.transcript.image), 'both pictures render in their plain blind form');
});

test('createTurnRunner: when every picture downloads fine, all are kept as data: URLs in transcript order', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['i1', { id: 'i1', contentType: 'image/png', name: 'one.png', url: 'https://cdn.discordapp.com/x/one.png' }],
      ['i2', { id: 'i2', contentType: 'image/png', name: 'two.png', url: 'https://cdn.discordapp.com/x/two.png' }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const imageFetcher = fakeImageFetcher((url) => ({
    dataUrl: url.includes('one.png') ? 'data:image/png;base64,ONE' : 'data:image/png;base64,TWO',
    bytes: 3,
    contentType: 'image/png',
  }));
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const trigger = {
    ...normalizedTrigger(raw),
    attachments: [
      { id: 'i1', kind: 'image', url: 'https://cdn.discordapp.com/x/one.png', name: 'one.png' },
      { id: 'i2', kind: 'image', url: 'https://cdn.discordapp.com/x/two.png', name: 'two.png' },
    ],
  };

  const result = await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  const userContent = llm.calls[0][1].content;
  const imageParts = userContent.filter((p) => p.type === 'image_url');
  assert.equal(imageParts.length, 2);
  assert.deepEqual(
    imageParts.map((p) => p.image_url.url),
    ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
    'pictures are kept in the order they appear in the transcript',
  );
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

// ---------------------------------------------------------------------------
// A follow-up turn is its own trigger kind and never posts as a Discord
// reply, whatever reply="#n" the model wrote.

test('createTurnRunner: a normal reply turn keeps reply="#n" as a real Discord reply', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">hi</msg>');
  const store = fakeStore();
  const hot = fakeHot();
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false });
  const sentLine = logs.find((l) => l.msg === 'turn: sent');
  assert.ok(sentLine);
  assert.equal(sentLine.followUp, undefined);
});

test('createTurnRunner: a follow-up turn (triggerKind "followUp") ignores reply="#n" and sends a plain message', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">hi</msg>');
  const store = fakeStore();
  const hot = fakeHot();
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].reply, undefined, 'a follow-up turn never posts as a Discord reply');
  assert.equal(channel.sent[0].content, 'hi');
  const sentLine = logs.find((l) => l.msg === 'turn: sent');
  assert.ok(sentLine);
  assert.equal(sentLine.followUp, true);
});

test('createTurnRunner: features.dryRun=true on a follow-up turn logs replyTo=null and never mirrors "reply to X"', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">hi</msg>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, true);
  const sendLine = logs.find((l) => l.msg === 'dry-run: would send');
  assert.ok(sendLine);
  assert.equal(sendLine.replyTo, null, 'a follow-up turn never carries a reply target, even in the dry-run log');
  assert.equal(sendLine.text, 'hi');
});

// ---------------------------------------------------------------------------
// The re-watch on a question (features.videoRewatch).

test('parseRewatchPick: none (any case), garbage, an ordinal out of range or an empty question -> null', () => {
  for (const raw of ['none', 'NONE', '  None  ', '', '1', 'maybe the first one', '3 | what colour?', '0 | what?', '1 |   ', ' | what?', 'va | what?', '1.5 | what?', '-1 | what?', null]) {
    assert.equal(parseRewatchPick(raw, 2), null, String(raw));
  }
});

test('parseRewatchPick: <n> | <question> picks that ordinal; only the first line counts; the question is cut to 300 chars', () => {
  assert.deepEqual(parseRewatchPick('  2 |  τι χρώμα έχει;  \n1 | other', 2), {
    n: 2,
    question: 'τι χρώμα έχει;',
    retry: false,
  });
  const long = parseRewatchPick(`1 | ${'é'.repeat(400)}`, 2);
  assert.equal([...long.question].length, 300);
});

test('parseRewatchPick: #n and n. prefixes are tolerated', () => {
  for (const raw of ['#2 | τι χρώμα;', '2. | τι χρώμα;', '# 2 | τι χρώμα;', '#2. | τι χρώμα;']) {
    assert.deepEqual(parseRewatchPick(raw, 2), { n: 2, question: 'τι χρώμα;', retry: false }, raw);
  }
  assert.equal(parseRewatchPick('#3 | τι χρώμα;', 2), null);
});

test('parseRewatchPick: <n> | retry (any case) sets retry; anything longer is a question', () => {
  assert.deepEqual(parseRewatchPick('1 | retry', 1), { n: 1, question: 'retry', retry: true });
  assert.equal(parseRewatchPick('1 |  RETRY  ', 1).retry, true);
  assert.equal(parseRewatchPick('1 | Retry', 1).retry, true);
  assert.equal(parseRewatchPick('1 | retry it please', 1).retry, false);
  assert.equal(parseRewatchPick('1 | retry?', 1).retry, false);
});

test('parseRewatchPickDetailed: each null answer carries its reason code; a pick carries ok', () => {
  const cases = [
    ['none', 'none'],
    ['  NONE  \n1 | x', 'none'],
    ['', 'empty'],
    ['  \n \n', 'empty'],
    [null, 'empty'],
    ['maybe the first one', 'no-bar'],
    ['1', 'no-bar'],
    ['3 | what colour?', 'unknown-id'],
    ['0 | what colour?', 'unknown-id'],
    ['va | what colour?', 'unknown-id'],
    ['1234567890123456789 | what colour?', 'unknown-id'],
    [' | what?', 'unknown-id'],
    ['1 |   ', 'no-question'],
  ];
  for (const [raw, reason] of cases) {
    assert.deepEqual(parseRewatchPickDetailed(raw, 2), { pick: null, reason }, String(raw));
  }
  assert.deepEqual(parseRewatchPickDetailed('1 | τι χρώμα;', 2), {
    pick: { n: 1, question: 'τι χρώμα;', retry: false },
    reason: 'ok',
  });
  assert.deepEqual(parseRewatchPickDetailed('1 | retry', 2).pick, parseRewatchPick('1 | retry', 2));
  assert.deepEqual(parseRewatchPickDetailed('1 | x', 0), { pick: null, reason: 'unknown-id' }, 'no candidates');
});

/** fakeVideoDescriber plus rewatchVideo, answering every call with `answer`. */
function fakeRewatchDescriber(statesById, answer = { question: 'q', text: 'κόκκινο' }) {
  const base = fakeVideoDescriber(statesById);
  const rewatchCalls = [];
  return {
    ...base,
    rewatchCalls,
    rewatchVideo: async (guildId, item, question) => {
      rewatchCalls.push({ guildId, item, question });
      return answer ? { ...answer, question } : null;
    },
  };
}

/** An llm fake routing the re-watch classifier (system = REWATCH_SYSTEM) apart from the turn itself. */
const REWATCH_SYSTEM = 'Pick the video the message to {{name}} asks about; {{name}} saw them.';
function rewatchLlm(classifierText, turnText = '<msg>ok</msg>') {
  const classifierCalls = [];
  const turnCalls = [];
  return {
    classifierCalls,
    turnCalls,
    complete: async (messages, options) => {
      if (messages[0].content.startsWith('Pick the video')) {
        classifierCalls.push({ messages, options });
        if (classifierText instanceof Error) throw classifierText;
        return { text: classifierText, usage: {}, estimated: 5 };
      }
      turnCalls.push({ messages, options });
      return { text: turnText, usage: {}, estimated: 10 };
    },
  };
}

function rewatchHot(features = {}, video = {}, config = {}) {
  const hot = fakeHot(
    { mediaDescriptions: true, videoDescriptions: true, vision: false, ...features },
    {},
    {
      media: { model: 'x/haiku', maxPerTurn: 6, filePreviewChars: 500, video: { maxPerTurn: 1, sites: ['youtube.com'], ...video } },
      mention: { followUpModel: null },
      ...config,
    },
  );
  hot.config.llm.timeoutMs = 300_000;
  hot.prompts.rewatch = REWATCH_SYSTEM;
  return hot;
}

/** A watched video message, then the trigger asking about it. */
function rewatchScene(triggerContent = 'τι χρώμα είναι το αυτοκίνητο;') {
  const video = videoAttachmentRaw('m1', NOW - 5000, 'va', 'clip.mp4');
  const trigger = rawMessage({ id: 'm2', ts: NOW - 1000, authorName: 'Zoë', content: triggerContent });
  return { video, trigger, channel: fakeTurnChannel({ historyMessages: [video, trigger] }) };
}

async function runRewatch({ hot = rewatchHot(), llm = rewatchLlm('1 | τι χρώμα;'), describer, scene = rewatchScene(), turn } = {}) {
  const d = describer ?? fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer: d });
  await turns.runTurn(turn ?? { channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.trigger), triggerKind: 'mention' });
  return { describer: d, llm };
}

test('createTurnRunner: rewatch -- the classifier gets the watched videos and the trigger, then one second look fills videoAnswered', async () => {
  const { describer, llm } = await runRewatch();

  assert.equal(llm.classifierCalls.length, 1);
  const { messages, options } = llm.classifierCalls[0];
  assert.equal(messages[0].content, 'Pick the video the message to Bot asks about; Bot saw them.', '{{name}} is the persona\'s display name');
  const [transcriptPart, videosPart] = messages[1].content.split('\n<videos>\n');
  assert.ok(transcriptPart.startsWith('<transcript>\n') && transcriptPart.endsWith('\n</transcript>'), 'the transcript comes first');
  assert.equal(
    `<videos>\n${videosPart}`,
    '<videos>\n1 | clip.mp4 | watched | ένα αυτοκίνητο περνά\n</videos>\n<candidate>\nZoë: τι χρώμα είναι το αυτοκίνητο;\n</candidate>',
  );
  assert.equal(options.model, 'x/haiku', 'rewatch.model and mention.followUpModel unset -> media.model');
  assert.equal(options.maxOutputTokens, 120);
  assert.equal(options.timeoutMs, 300_000);
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.skipCalibration, true);

  assert.equal(describer.rewatchCalls.length, 1);
  assert.equal(describer.rewatchCalls[0].item.itemId, 'va');
  assert.equal(describer.rewatchCalls[0].question, 'τι χρώμα;');
  const userMessage = llm.turnCalls[0].messages[1].content;
  const watched = fill(labels.transcript.videoWatched, { name: 'clip.mp4', duration: '0:20', text: 'ένα αυτοκίνητο περνά' });
  const answered = fill(labels.transcript.videoAnswered, { question: 'τι χρώμα;', text: 'κόκκινο' });
  assert.ok(userMessage.includes(`${watched} ${answered}`), 'the answer follows the watched tag');
});

test('createTurnRunner: rewatch -- the classifier model is rewatch.model, else mention.followUpModel, else media.model', async () => {
  const withRewatch = await runRewatch({ hot: rewatchHot({}, { rewatch: { model: 'x/pick' } }, { mention: { followUpModel: 'x/follow' } }) });
  assert.equal(withRewatch.llm.classifierCalls[0].options.model, 'x/pick');
  const withFollowUp = await runRewatch({ hot: rewatchHot({}, {}, { mention: { followUpModel: 'x/follow' } }) });
  assert.equal(withFollowUp.llm.classifierCalls[0].options.model, 'x/follow');
});

test('createTurnRunner: rewatch -- none, garbage, an unknown id or a classifier error stop without a second look', async () => {
  for (const reply of ['none', 'I think the first video', '2 | τι χρώμα;', new Error('boom')]) {
    const { describer, llm } = await runRewatch({ llm: rewatchLlm(reply) });
    assert.equal(llm.classifierCalls.length, 1);
    assert.equal(describer.rewatchCalls.length, 0, String(reply));
    assert.equal(llm.turnCalls.length, 1, 'the turn itself still runs');
    assert.ok(!llm.turnCalls[0].messages[1].content.includes('looked again'));
  }
});

test('createTurnRunner: rewatch -- never on a spontaneous turn (no trigger)', async () => {
  const scene = rewatchScene();
  const { describer, llm } = await runRewatch({ scene, turn: { channel: scene.channel, mode: 'interject' } });
  assert.equal(describer.videoCalls.length, 1, 'videos are still watched');
  assert.equal(llm.classifierCalls.length, 0);
  assert.equal(describer.rewatchCalls.length, 0);
});

test('createTurnRunner: rewatch -- no watched video in the last rewatch.recentMessages messages -> no classifier call', async () => {
  const outOfWindow = await runRewatch({ hot: rewatchHot({}, { rewatch: { recentMessages: 1 } }) });
  assert.equal(outOfWindow.llm.classifierCalls.length, 0);
  const notWatched = await runRewatch({ describer: fakeRewatchDescriber({ va: { state: 'limit', reason: 'length' } }) });
  assert.equal(notWatched.llm.classifierCalls.length, 0);
  assert.equal(notWatched.describer.rewatchCalls.length, 0);
});

test('createTurnRunner: rewatch -- features.videoRewatch false, video vision off, or no prompts.rewatch -> no classifier call', async () => {
  const noPrompt = rewatchHot();
  delete noPrompt.prompts.rewatch;
  for (const hot of [rewatchHot({ videoRewatch: false }), rewatchHot({ videoDescriptions: false }), noPrompt]) {
    const { describer, llm } = await runRewatch({ hot });
    assert.equal(llm.classifierCalls.length, 0);
    assert.equal(describer.rewatchCalls.length, 0);
  }
});

test('createTurnRunner: rewatch -- a second look that returns null leaves the video watched, without an answer', async () => {
  const describer = fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } }, null);
  const { llm } = await runRewatch({ describer });
  assert.equal(describer.rewatchCalls.length, 1);
  const userMessage = llm.turnCalls[0].messages[1].content;
  assert.ok(userMessage.includes(fill(labels.transcript.videoWatched, { name: 'clip.mp4', duration: '0:20', text: 'ένα αυτοκίνητο περνά' })));
  assert.ok(!userMessage.includes('looked again'));
});

test('createTurnRunner: rewatch -- logs rewatch: classified with counts only, never the question', async () => {
  const { logs } = await withCapturedLogs(() => runRewatch());
  const line = logs.find((entry) => entry.msg === 'rewatch: classified' || JSON.stringify(entry).includes('rewatch: classified'));
  assert.ok(line);
  const all = JSON.stringify(logs);
  assert.ok(all.includes('"picked":true'));
  assert.ok(all.includes('"candidates":1'));
  assert.ok(!all.includes('τι χρώμα'));
});

test('createTurnRunner: rewatch -- rewatch: classified carries offered counts, retryAllowed, the parse code and the kind, never text', async () => {
  const cases = [
    { reply: '1 | τι χρώμα;', parse: 'ok', kind: 'question', picked: true, level: 'info' },
    { reply: 'none', parse: 'none', kind: null, picked: false, level: 'info' },
    { reply: '   ', parse: 'empty', kind: null, picked: false, level: 'info' },
    { reply: 'the first video please', parse: 'no-bar', kind: null, picked: false, level: 'warn' },
    { reply: '2 | τι χρώμα;', parse: 'unknown-id', kind: null, picked: false, level: 'warn' },
    { reply: '1 |  ', parse: 'no-question', kind: null, picked: false, level: 'info' },
    { reply: '1 | retry', parse: 'ok', kind: 'retry', picked: false, level: 'info' },
  ];
  for (const { reply, parse, kind, picked, level } of cases) {
    const { logs } = await withCapturedLogs(() => runRewatch({ llm: rewatchLlm(reply) }));
    const line = logs.find((entry) => entry.msg === 'rewatch: classified');
    assert.ok(line, reply);
    assert.equal(line.level, level, reply);
    assert.equal(line.parse, parse, reply);
    assert.equal(line.kind, kind, reply);
    assert.equal(line.picked, picked, reply);
    assert.deepEqual(line.offered, { watched: 1, notLoaded: 0 }, reply);
    assert.equal(line.retryAllowed, false, 'the default describer has no describeVideo');
    assert.ok(!JSON.stringify(logs).includes('χρώμα;'), reply);
    assert.ok(!JSON.stringify(logs).includes('first video'), reply);
  }
});

test('createTurnRunner: rewatch -- rewatch: classified counts watched and not-loaded offers apart, retryAllowed true with a describeVideo', async () => {
  const messages = [];
  const states = {};
  for (let i = 1; i <= 3; i += 1) {
    messages.push(videoAttachmentRaw(`m${i}`, NOW - 100_000 + i * 1000, `v${i}`, `clip${i}.mp4`));
    states[`v${i}`] = i === 2 ? { state: 'error' } : { state: 'watched', text: `scène ${i}` };
  }
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'και τώρα;' });
  const scene = { trigger, channel: fakeTurnChannel({ historyMessages: [...messages, trigger] }) };
  const describer = fakeRetryDescriber(states);
  const { logs } = await withCapturedLogs(() => runRewatch({ scene, llm: rewatchLlm('2 | retry'), describer }));
  assert.equal(describer.retryCalls[0].item.itemId, 'v2', 'ordinal 2 is the second newest');
  const line = logs.find((entry) => entry.msg === 'rewatch: classified');
  assert.deepEqual(line.offered, { watched: 2, notLoaded: 1 });
  assert.equal(line.candidates, 3);
  assert.equal(line.retryAllowed, true);
  assert.equal(line.parse, 'ok');
  assert.equal(line.kind, 'retry');
  assert.equal(line.picked, true);
  assert.equal(line.level, 'info');
});

test('createTurnRunner: rewatch -- the ordinal maps back to the candidate, 1 for the newest', async () => {
  const messages = [];
  const states = {};
  for (let i = 1; i <= 3; i += 1) {
    messages.push(videoAttachmentRaw(`m${i}`, NOW - 100_000 + i * 1000, `v${i}`, `clip${i}.mp4`));
    states[`v${i}`] = { state: 'watched', text: `scène ${i}` };
  }
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'τι χρώμα;' });
  const scene = { trigger, channel: fakeTurnChannel({ historyMessages: [...messages, trigger] }) };
  for (const [reply, itemId] of [['1 | τι χρώμα;', 'v3'], ['#2 | τι χρώμα;', 'v2'], ['3. | τι χρώμα;', 'v1']]) {
    const describer = fakeRewatchDescriber(states);
    await runRewatch({ scene, llm: rewatchLlm(reply), describer });
    assert.equal(describer.rewatchCalls.length, 1, reply);
    assert.equal(describer.rewatchCalls[0].item.itemId, itemId, reply);
  }
  const describer = fakeRewatchDescriber(states);
  const { logs } = await withCapturedLogs(() => runRewatch({ scene, llm: rewatchLlm('4 | τι χρώμα;'), describer }));
  assert.equal(describer.rewatchCalls.length, 0, 'an ordinal past the list picks nothing');
  assert.equal(logs.find((entry) => entry.msg === 'rewatch: classified').parse, 'unknown-id');
});

test('createTurnRunner: rewatch -- recentMessages defaults to 60 (config.json and the code fallback)', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.media.video.rewatch.recentMessages, 60);
  assert.equal(shipped.media.video.rewatch.maxCandidates, 6);

  const sceneWith = (fillers) => {
    const video = videoAttachmentRaw('m0', NOW - 500_000, 'va', 'clip.mp4');
    const between = Array.from({ length: fillers }, (_, i) => rawMessage({ id: `f${i}`, ts: NOW - 400_000 + i * 1000, content: `réponse ${i}` }));
    const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'τι χρώμα;' });
    return { video, trigger, channel: fakeTurnChannel({ historyMessages: [video, ...between, trigger] }) };
  };
  const inside = await runRewatch({ scene: sceneWith(58) });
  assert.equal(inside.llm.classifierCalls.length, 1, 'the video is the 60th message from the end');
  const outside = await runRewatch({ scene: sceneWith(59) });
  assert.equal(outside.llm.classifierCalls.length, 0, 'the video is the 61st message from the end');
});

test('createTurnRunner: rewatch -- the <videos> block lists at most maxCandidates watched videos, newest first', async () => {
  const messages = [];
  const states = {};
  for (let i = 1; i <= 7; i += 1) {
    messages.push(videoAttachmentRaw(`m${i}`, NOW - 100_000 + i * 1000, `v${i}`, `clip${i}.mp4`));
    states[`v${i}`] = { state: 'watched', text: `scène ${i}` };
  }
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'τι χρώμα;' });
  const scene = { trigger, channel: fakeTurnChannel({ historyMessages: [...messages, trigger] }) };
  const run = (hot) => runRewatch({ hot, scene, llm: rewatchLlm('none'), describer: fakeRewatchDescriber(states) });

  const { llm } = await run(rewatchHot());
  const block = llm.classifierCalls[0].messages[1].content.split('<videos>\n')[1].split('\n</videos>')[0].split('\n');
  assert.deepEqual(block, [7, 6, 5, 4, 3, 2].map((i, k) => `${k + 1} | clip${i}.mp4 | watched | scène ${i}`));

  const capped = await run(rewatchHot({}, { rewatch: { maxCandidates: 2 } }));
  const cappedBlock = capped.llm.classifierCalls[0].messages[1].content.split('<videos>\n')[1].split('\n</videos>')[0].split('\n');
  assert.deepEqual(cappedBlock, ['1 | clip7.mp4 | watched | scène 7', '2 | clip6.mp4 | watched | scène 6']);
});

/**
 * fakeRewatchDescriber whose describeVideos reports `newCount` fetch attempts
 * this turn (default none: every state came from the cache) and whose
 * describeVideo answers a forced retry with `retried`.
 */
function fakeRetryDescriber(statesById, retried = { state: 'watched', text: 'τώρα φορτώνει' }, { newCount = 0 } = {}) {
  const base = fakeRewatchDescriber(statesById);
  const retryCalls = [];
  return {
    ...base,
    retryCalls,
    describeVideos: async (guildId, items, options) => {
      const { videos } = await base.describeVideos(guildId, items, options);
      return { videos, newCount };
    },
    describeVideo: async (guildId, item, options) => {
      retryCalls.push({ guildId, item, options });
      return retried;
    },
  };
}

test('createTurnRunner: rewatch -- a video that did not load is offered as not loaded, with an empty account', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } });
  const { llm } = await runRewatch({ describer, llm: rewatchLlm('none') });
  assert.equal(llm.classifierCalls.length, 1);
  assert.ok(llm.classifierCalls[0].messages[1].content.startsWith('<transcript>\n'));
  assert.ok(
    llm.classifierCalls[0].messages[1].content.endsWith(
      '\n</transcript>\n<videos>\n1 | clip.mp4 | not loaded |\n</videos>\n<candidate>\nZoë: τι χρώμα είναι το αυτοκίνητο;\n</candidate>',
    ),
  );
  assert.equal(describer.retryCalls.length, 0);
});

test('createTurnRunner: rewatch -- <id> | retry on a video that did not load tries it once more, forced, and the transcript shows it watched', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } });
  const { result, logs } = await withCapturedLogs(() => runRewatch({ describer, llm: rewatchLlm('1 | retry') }));

  assert.equal(describer.retryCalls.length, 1);
  assert.equal(describer.retryCalls[0].item.itemId, 'va');
  assert.equal(describer.retryCalls[0].options.force, true);
  assert.equal(describer.rewatchCalls.length, 0, 'the retry is the one re-watch of this turn');
  const userMessage = result.llm.turnCalls[0].messages[1].content;
  assert.ok(userMessage.includes(fill(labels.transcript.videoWatched, { name: 'clip.mp4', duration: '0:20', text: 'τώρα φορτώνει' })));
  assert.ok(!userMessage.includes('not watched'));
  const line = logs.find((entry) => entry.msg === 'rewatch: classified');
  assert.equal(line.picked, true);
  assert.ok(!JSON.stringify(logs).includes('τώρα φορτώνει'));
});

test('createTurnRunner: rewatch -- a retry that fails again replaces the state with the new one', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } }, { state: 'limit', reason: 'size' });
  const { llm } = await runRewatch({ describer, llm: rewatchLlm('1 | retry') });
  assert.equal(describer.retryCalls.length, 1);
  const userMessage = llm.turnCalls[0].messages[1].content;
  const reason = labels.transcript.videoReason.size;
  assert.ok(userMessage.includes(fill(labels.transcript.videoNotWatched, { name: 'clip.mp4', duration: '0:20', reason })));
});

test('createTurnRunner: rewatch -- retry on a watched video, or a question on one that did not load, does nothing', async () => {
  const cases = [
    { states: { va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } }, reply: '1 | retry' },
    { states: { va: { state: 'error' } }, reply: '1 | τι χρώμα;' },
  ];
  for (const { states, reply } of cases) {
    const describer = fakeRetryDescriber(states);
    const { logs } = await withCapturedLogs(() => runRewatch({ describer, llm: rewatchLlm(reply) }));
    assert.equal(describer.retryCalls.length, 0, reply);
    assert.equal(describer.rewatchCalls.length, 0, reply);
    const line = logs.find((entry) => entry.msg === 'rewatch: classified');
    assert.equal(line.picked, false, reply);
  }
});

test('createTurnRunner: rewatch -- maxCandidates counts watched and not-loaded videos together, newest first', async () => {
  const messages = [];
  const states = {};
  for (let i = 1; i <= 4; i += 1) {
    messages.push(videoAttachmentRaw(`m${i}`, NOW - 100_000 + i * 1000, `v${i}`, `clip${i}.mp4`));
    states[`v${i}`] = i % 2 === 0 ? { state: 'error' } : { state: 'watched', text: `scène ${i}` };
  }
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'και τώρα;' });
  const scene = { trigger, channel: fakeTurnChannel({ historyMessages: [...messages, trigger] }) };
  const { llm } = await runRewatch({
    hot: rewatchHot({}, { rewatch: { maxCandidates: 3 } }),
    scene,
    llm: rewatchLlm('none'),
    describer: fakeRetryDescriber(states),
  });
  const block = llm.classifierCalls[0].messages[1].content.split('<videos>\n')[1].split('\n</videos>')[0].split('\n');
  assert.deepEqual(block, ['1 | clip4.mp4 | not loaded |', '2 | clip3.mp4 | watched | scène 3', '3 | clip2.mp4 | not loaded |']);
});

test('createTurnRunner: rewatch -- a video that did not load is still offered and retried after this turn spent media.video.maxPerTurn attempts', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } }, undefined, { newCount: 1 });
  const { result, logs } = await withCapturedLogs(() => runRewatch({ describer, llm: rewatchLlm('1 | retry') }));
  assert.ok(result.llm.classifierCalls[0].messages[1].content.includes('1 | clip.mp4 | not loaded |'), 'still offered');
  assert.equal(describer.retryCalls.length, 1);
  assert.equal(describer.retryCalls[0].options.force, true);
  assert.ok(!logs.some((entry) => entry.msg === 'rewatch: skipped'));
  const line = logs.find((entry) => entry.msg === 'rewatch: classified');
  assert.equal(line.retryAllowed, true);
  assert.equal(line.picked, true);
});

test('createTurnRunner: rewatch -- every early stop logs rewatch: skipped with its reason, never text', async () => {
  const skipped = async (hot, describer) => {
    const { logs } = await withCapturedLogs(() => runRewatch({ hot, describer }));
    const line = logs.find((entry) => JSON.stringify(entry).includes('rewatch: skipped'));
    assert.ok(line, 'one rewatch: skipped line');
    const all = JSON.stringify(logs);
    assert.ok(!all.includes('τι χρώμα'), 'never the trigger text');
    assert.ok(!all.includes('ένα αυτοκίνητο'), 'never the video summary');
    return line;
  };

  const noPrompt = rewatchHot();
  delete noPrompt.prompts.rewatch;
  const a = await skipped(noPrompt);
  assert.equal(a.reason, 'no-prompt');
  assert.equal(a.channel, 'c1');

  const b = await skipped(rewatchHot({}, { rewatch: { recentMessages: 0 } }));
  assert.equal(b.reason, 'no-window');

  const c = await skipped(rewatchHot(), fakeRewatchDescriber({ va: { state: 'limit', reason: 'length' } }));
  assert.equal(c.reason, 'no-watched');
  assert.equal(c.watched, 0);
  assert.equal(c.recent, 60);
});

/** A video, `fillers` chat lines (every third one the persona's own), then the trigger. */
function rewatchContextScene(fillers) {
  const video = videoAttachmentRaw('m0', NOW - 100_000, 'va', 'clip.mp4');
  const between = Array.from({ length: fillers }, (_, i) =>
    i % 3 === 1
      ? rawMessage({ id: `f${i}`, ts: NOW - 90_000 + i * 1000, authorId: 'self-id', authorName: 'Bot', content: `ligne ${i}` })
      : rawMessage({ id: `f${i}`, ts: NOW - 90_000 + i * 1000, authorName: 'Zoë', content: `ligne ${i}` }),
  );
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'τι χρώμα έχει;' });
  return { trigger, channel: fakeTurnChannel({ historyMessages: [video, ...between, trigger] }) };
}

/** The lines between <transcript> and </transcript>, or null when the block is absent. */
function rewatchTranscriptLines(content) {
  if (!content.startsWith('<transcript>\n')) return null;
  return content.slice('<transcript>\n'.length, content.indexOf('\n</transcript>\n<videos>\n')).split('\n');
}

test('createTurnRunner: rewatch -- contextMessages defaults to 8 (config.json and the code fallback)', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.media.video.rewatch.contextMessages, 8);

  const { llm } = await runRewatch({ scene: rewatchContextScene(10), llm: rewatchLlm('none') });
  const lines = rewatchTranscriptLines(llm.classifierCalls[0].messages[1].content);
  assert.equal(lines[0], fill(labels.transcript.header, { date: lines[0].slice(4, -4) }), 'opens with the transcript header');
  const items = lines.slice(1);
  assert.equal(items.length, 8);
  assert.ok(items[0].endsWith('Zoë: ligne 2'), 'the eight messages before the trigger, oldest first');
  assert.ok(items[7].endsWith('Zoë: ligne 9'));
});

test('createTurnRunner: rewatch -- the <transcript> block holds the last contextMessages before the trigger, the persona marked, the trigger only in <candidate>', async () => {
  const { llm } = await runRewatch({
    hot: rewatchHot({}, { rewatch: { contextMessages: 3 } }),
    scene: rewatchContextScene(10),
    llm: rewatchLlm('none'),
  });
  const content = llm.classifierCalls[0].messages[1].content;
  const items = rewatchTranscriptLines(content).slice(1);
  assert.equal(items.length, 3);
  const self = fill(labels.self, { name: 'Bot' });
  assert.match(items[0], /^#1 \[\d\d:\d\d\] /);
  assert.ok(items[0].endsWith(`] ${self}: ligne 7`), 'the persona\'s own line is marked');
  assert.match(items[1], /^#2 \[\d\d:\d\d\] Zoë: ligne 8$/);
  assert.match(items[2], /^#3 \[\d\d:\d\d\] Zoë: ligne 9$/);
  assert.equal(content.split('τι χρώμα έχει;').length, 2, 'the trigger appears once');
  assert.ok(content.endsWith('<candidate>\nZoë: τι χρώμα έχει;\n</candidate>'));
});

test('createTurnRunner: rewatch -- contextMessages 0 omits the <transcript> block', async () => {
  const { llm } = await runRewatch({
    hot: rewatchHot({}, { rewatch: { contextMessages: 0 } }),
    scene: rewatchContextScene(4),
    llm: rewatchLlm('none'),
  });
  const content = llm.classifierCalls[0].messages[1].content;
  assert.ok(!content.includes('<transcript>'));
  assert.ok(content.startsWith('<videos>\n1 | clip.mp4 | watched |'));
});

test('createTurnRunner: rewatch -- the transcript lines are never logged', async () => {
  const { logs } = await withCapturedLogs(() => runRewatch({ scene: rewatchContextScene(6), llm: rewatchLlm('1 | τι χρώμα;') }));
  assert.ok(logs.some((entry) => entry.msg === 'rewatch: classified'));
  assert.ok(!JSON.stringify(logs).includes('ligne'));
});

test('createTurnRunner: rewatch -- a video that did not load renders its not-watched tag inside the <transcript> block', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } });
  const { llm } = await runRewatch({ describer, llm: rewatchLlm('none') });
  const items = rewatchTranscriptLines(llm.classifierCalls[0].messages[1].content).slice(1);
  assert.equal(items.length, 1, 'the video message only; the trigger stays in <candidate>');
  const tag = fill(labels.transcript.videoNotWatched, { name: 'clip.mp4', duration: '0:20', reason: labels.transcript.videoReason.error });
  assert.ok(items[0].endsWith(`Alice: hey bot ${tag}`), items[0]);
});
