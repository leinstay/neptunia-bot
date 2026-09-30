// Tests for src/behavior/turn.js: the pure helpers (between, typingMs,
// resolveMentions) plus one integration-style suite for createTurnRunner
// itself, driven with fake discord.js-shaped objects, a fake LLM and a fake
// store -- proving the feature switches (reactions, multiMessage,
// typingSimulation, memory) are applied where this module is responsible for
// them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PermissionFlagsBits } from 'discord.js';
import { between, typingMs, resolveMentions, createTurnRunner, parseRewatchPick, parseRewatchPickDetailed, parseLookupQuery } from '../src/behavior/turn.js';
import { fill } from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { ImageCapError, ImageGenError } from '../src/llm/images.js';
import { DailyCapError, TokenLimitError } from '../src/llm/openrouter.js';

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

/** `dm: true` is a private (DM) channel: no guild, no name, no member permissions. */
function fakeTurnChannel({ id = 'c1', name = 'general', guildId = 'g1', historyMessages = [], attachFiles = true, dm = false } = {}) {
  const guild = dm ? null : { id: guildId, members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } };
  const sent = [];
  const typingCalls = [];
  const reactCalls = [];
  const channel = {
    id,
    name: dm ? null : name,
    guild,
    viewable: true,
    // Every permission is granted, Attach Files only when `attachFiles`; a DM has no permissions to resolve.
    permissionsFor: dm
      ? () => {
          throw new Error('a DM channel has no member permissions');
        }
      : () => ({ has: (flag) => attachFiles || flag !== PermissionFlagsBits.AttachFiles }),
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

function fakeStore({ guildMemory = {}, userProfiles = {}, channels = [], loreEntries = [], privateProfiles = {} } = {}) {
  const guildCalls = [];
  const privateCalls = [];
  return {
    guildCalls,
    privateCalls,
    getGuild: (guildId) => {
      guildCalls.push(guildId);
      return guildMemory;
    },
    getUser: (guildId, userId) => userProfiles[userId] ?? null,
    getPrivate: (guildId, userId) => {
      privateCalls.push({ guildId, userId });
      return privateProfiles[userId] ?? null;
    },
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

// features.attachedDescriptions -- a picture attached as image_url also gets the helper's caption.

function attachedPictureTurn({ features, media, newer = false }) {
  const pic = { id: 'i1', contentType: 'image/png', name: 'one.png', url: 'https://cdn.discordapp.com/x/one.png' };
  const raw = rawMessage({ id: 'm2', attachments: new Map([['i1', pic]]) });
  const history = [raw];
  if (newer) {
    // A picture posted right after the trigger: newer, but not attached (recentImages is 0).
    const other = { id: 'o1', contentType: 'image/png', name: 'other.png', url: 'https://cdn.discordapp.com/x/other.png' };
    history.push(rawMessage({ id: 'm3', ts: NOW - 500, attachments: new Map([['o1', other]]) }));
  }
  const channel = fakeTurnChannel({ historyMessages: history });
  const llm = fakeLlm('<msg>ok</msg>');
  const hot = fakeHot(features, {}, media ? { media } : {});
  // Like fakeDescriber, but honours maxNew the way describeMany does (every caption here is new).
  const captions = { i1: 'a grey cat', o1: 'a red fox' };
  const describer = {
    calls: [],
    describeMany: async (guildId, items, options) => {
      describer.calls.push({ guildId, items, options });
      const descriptions = new Map();
      for (const item of items) {
        if (descriptions.size >= (options?.maxNew ?? Infinity)) break;
        if (captions[item.itemId]) descriptions.set(item.itemId, captions[item.itemId]);
      }
      return { descriptions, newCount: descriptions.size };
    },
  };
  const turns = createTurnRunner({
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    imageFetcher: fakeImageFetcher(),
  });
  const trigger = {
    ...normalizedTrigger(raw),
    attachments: [{ id: 'i1', kind: 'image', url: pic.url, name: 'one.png' }],
  };
  return { channel, llm, describer, turns, trigger };
}

function userText(llm) {
  const content = llm.calls[0][1].content;
  return Array.isArray(content) ? content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : content;
}

test('createTurnRunner: features.attachedDescriptions on -- an attached picture is described and its caption sits with the marker', async () => {
  const { channel, llm, describer, turns, trigger } = attachedPictureTurn({ features: { mediaDescriptions: true, attachedDescriptions: true } });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.deepEqual(describer.calls[0].items.map((item) => item.itemId), ['i1']);
  assert.ok(Array.isArray(llm.calls[0][1].content), 'the picture is still attached as an image_url part');
  const text = userText(llm);
  assert.ok(text.includes(labels.transcript.imageAttachedDescribed.replace('{n}', '1').replace('{text}', 'a grey cat')));
});

test('createTurnRunner: features.attachedDescriptions missing counts as on', async () => {
  const { channel, llm, describer, turns, trigger } = attachedPictureTurn({ features: { mediaDescriptions: true } });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.deepEqual(describer.calls[0].items.map((item) => item.itemId), ['i1']);
  assert.ok(userText(llm).includes(labels.transcript.imageAttachedDescribed.replace('{n}', '1').replace('{text}', 'a grey cat')));
});

test('createTurnRunner: features.attachedDescriptions false -- the attached picture is never sent to the describer, today\'s line', async () => {
  const { channel, llm, describer, turns, trigger } = attachedPictureTurn({ features: { mediaDescriptions: true, attachedDescriptions: false } });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  const described = describer.calls.flatMap((call) => call.items.map((item) => item.itemId));
  assert.ok(!described.includes('i1'));
  const text = userText(llm);
  assert.ok(text.includes(labels.transcript.imageAttached.replace('{n}', '1')));
  assert.ok(!text.includes('a grey cat'));
});

test('createTurnRunner: features.attachedDescriptions on -- attached pictures come first, media.maxPerTurn still caps new captions', async () => {
  const { channel, llm, describer, turns, trigger } = attachedPictureTurn({
    features: { mediaDescriptions: true, attachedDescriptions: true },
    media: { maxPerTurn: 1, filePreviewChars: 500 },
    newer: true,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.deepEqual(describer.calls[0].items.map((item) => item.itemId), ['i1', 'o1'], 'the attached picture first, even ahead of a newer un-attached one');
  assert.equal(describer.calls[0].options.maxNew, 1);
  const text = userText(llm);
  assert.ok(text.includes(labels.transcript.imageAttachedDescribed.replace('{n}', '1').replace('{text}', 'a grey cat')));
  assert.ok(!text.includes('a red fox'), 'the one new caption of this turn went to the attached picture');
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
      classifier: { media: 'x/haiku' },
      media: { maxPerTurn: 6, filePreviewChars: 500, video: { maxPerTurn: 1, sites: ['youtube.com'], ...video } },
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
  assert.equal(options.model, 'x/haiku', 'no text classifier model -> the media model');
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

test('createTurnRunner: rewatch -- the classifier model is classifierTextModel (classifier.text, then classifier.media); the deprecated keys and a stale rewatch.model are ignored', async () => {
  const withText = rewatchHot({}, { rewatch: { model: 'x/pick' } }, { classifier: { text: 'x/text' }, mention: { followUpModel: 'x/older' } });
  withText.config.llm.classifierModel = 'x/old';
  assert.equal((await runRewatch({ hot: withText })).llm.classifierCalls[0].options.model, 'x/text');
  const withOld = rewatchHot({}, { rewatch: { model: 'x/pick' } }, { mention: { followUpModel: 'x/older' } });
  withOld.config.llm.classifierModel = 'x/old';
  assert.equal((await runRewatch({ hot: withOld })).llm.classifierCalls[0].options.model, 'x/haiku', 'classifier.media, never a deprecated key');
  const withMedia = await runRewatch({ hot: rewatchHot({}, { rewatch: { model: 'x/pick' } }, { classifier: { media: 'x/vision' } }) });
  assert.equal(withMedia.llm.classifierCalls[0].options.model, 'x/vision');
  const staleMedia = rewatchHot({}, { rewatch: { model: 'x/pick' } }, { classifier: {} });
  staleMedia.config.media.model = 'x/old-media';
  const withNone = await runRewatch({ hot: staleMedia });
  assert.equal(withNone.llm.classifierCalls[0].options.model, undefined, 'the deprecated media.model is no fallback');
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

test('createTurnRunner: rewatch -- contextMessages defaults to 50 (config.json and the code fallback)', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.media.video.rewatch.contextMessages, 50);

  // recentMessages widened so the video 62 messages back is still a candidate;
  // contextMessages stays unset, so the code fallback applies.
  const { llm } = await runRewatch({
    hot: rewatchHot({}, { rewatch: { recentMessages: 100 } }),
    scene: rewatchContextScene(61),
    llm: rewatchLlm('none'),
  });
  const lines = rewatchTranscriptLines(llm.classifierCalls[0].messages[1].content);
  assert.equal(lines[0], fill(labels.transcript.header, { date: lines[0].slice(4, -4) }), 'opens with the transcript header');
  const items = lines.slice(1);
  assert.equal(items.length, 50);
  assert.ok(items[0].endsWith('Zoë: ligne 11'), 'the fifty messages before the trigger, oldest first');
  assert.ok(items[49].endsWith('Zoë: ligne 60'));
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

// ---------------------------------------------------------------------------
// The web lookup: read links and the search on a question.

test('parseLookupQuery: none (any case, a trailing dot), empty or blank -> no query; else the first line, cut to 200', () => {
  assert.deepEqual(parseLookupQuery('none'), { query: null, reason: 'none' });
  assert.deepEqual(parseLookupQuery('  NONE.\nextra'), { query: null, reason: 'none' });
  assert.deepEqual(parseLookupQuery(''), { query: null, reason: 'empty' });
  assert.deepEqual(parseLookupQuery(' \n \n'), { query: null, reason: 'empty' });
  assert.deepEqual(parseLookupQuery(null), { query: null, reason: 'empty' });
  assert.deepEqual(parseLookupQuery('\n  qui a gagné la finale  \nsecond'), { query: 'qui a gagné la finale', reason: 'ok' });
  assert.equal([...parseLookupQuery('λ'.repeat(300)).query].length, 200);
});

test('parseLookupQuery: any first line starting with the word none is none, quotes and trailing punctuation aside', () => {
  for (const raw of ['None needed.', '"none"', '`none`', "'None.'", 'none!', 'NONE -- nothing to look up', '\u201cnone\u201d', '``none``']) {
    assert.deepEqual(parseLookupQuery(raw), { query: null, reason: 'none' }, raw);
  }
  assert.deepEqual(parseLookupQuery('nonexistent planets list'), { query: 'nonexistent planets list', reason: 'ok' });
  assert.deepEqual(parseLookupQuery('nonetheless the score'), { query: 'nonetheless the score', reason: 'ok' });
});

test('parseLookupQuery: surrounding quotes/backticks and trailing punctuation are stripped from the query', () => {
  assert.deepEqual(parseLookupQuery('"qui a gagné la finale ?"'), { query: 'qui a gagné la finale', reason: 'ok' });
  assert.deepEqual(parseLookupQuery('`ώρα στην Αθήνα`.'), { query: 'ώρα στην Αθήνα', reason: 'ok' });
  assert.deepEqual(parseLookupQuery("'C++ release date'"), { query: 'C++ release date', reason: 'ok' });
  assert.deepEqual(parseLookupQuery('"..."'), { query: null, reason: 'empty' });
});

/** A raw message carrying link embeds. */
function linkRaw(id, ts, embeds, content = 'κοίτα αυτό') {
  return { ...rawMessage({ id, ts, content }), embeds };
}

const PAGE_EMBED = { url: 'https://example.org/a', title: 'Crêpes', description: null, provider: null, thumbnail: null };

/** A fake createLookup()-shaped dependency. */
function fakeLookup({ reads = {}, searchResult = { query: 'q', text: 'ευρήματα', sources: [{ title: 'Un', url: 'https://www.example.com/1', site: 'example.com' }] }, hasKey = true } = {}) {
  const readCalls = [];
  const searchCalls = [];
  return {
    readCalls,
    searchCalls,
    readLinks: async (guildId, links, options) => {
      readCalls.push({ guildId, links, options });
      const map = new Map();
      for (const link of links) if (reads[link.id]) map.set(link.id, reads[link.id]);
      return { reads: map, newCount: map.size };
    },
    search: async (guildId, query) => {
      searchCalls.push({ guildId, query });
      return searchResult ? { ...searchResult, query } : null;
    },
    hasSearch: () => hasKey,
  };
}

const LOOKUP_SYSTEM = 'Decide whether {{name}} needs to look something up.';
/** An llm fake routing the search classifier (system starts with "Decide whether") apart from the turn. */
function lookupLlm(classifierText = 'none', turnText = '<msg>ok</msg>') {
  const classifierCalls = [];
  const turnCalls = [];
  return {
    classifierCalls,
    turnCalls,
    complete: async (messages, options) => {
      if (messages[0].content.startsWith('Decide whether')) {
        classifierCalls.push({ messages, options });
        if (classifierText instanceof Error) throw classifierText;
        return { text: classifierText, usage: {}, estimated: 5 };
      }
      turnCalls.push({ messages, options });
      return { text: turnText, usage: {}, estimated: 10 };
    },
  };
}

function lookupHot(features = {}, web = {}, config = {}) {
  const hot = fakeHot(
    { webLookup: true, vision: false, ...features },
    {},
    {
      classifier: { text: 'x/text' },
      media: { maxPerTurn: 6, filePreviewChars: 500, video: { sites: ['youtube.com'] } },
      web: {
        maxPerDay: 60,
        links: { enabled: true, maxPerTurn: 2, ...web.links },
        search: { enabled: true, maxPerTurn: 1, contextMessages: 50, ...web.search },
      },
      ...config,
    },
  );
  hot.config.llm.timeoutMs = 300_000;
  hot.prompts.lookup = LOOKUP_SYSTEM;
  return hot;
}

async function runLookupTurn({ hot = lookupHot(), llm = lookupLlm(), lookup = fakeLookup(), history, trigger = true, now } = {}) {
  const messages = history ?? [
    linkRaw('m1', NOW - 5000, [
      PAGE_EMBED,
      { url: 'https://www.youtube.com/watch?v=abc', title: 'v', provider: { name: 'YouTube' } },
      { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } },
    ]),
    rawMessage({ id: 'm2', ts: NOW - 1000, authorName: 'Zoë', content: 'ποιος κέρδισε τον τελικό;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: messages });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), lookup, ...(now ? { now } : {}) });
  const last = messages[messages.length - 1];
  const turn = trigger
    ? { channel, mode: 'reply', trigger: normalizedTrigger(last), triggerKind: 'mention' }
    : { channel, mode: 'interject' };
  const result = await turns.runTurn(turn);
  return { result, llm, lookup };
}

test('createTurnRunner: lookup -- readable links (no video site, no gif) go to readLinks newest first; reads reach the transcript', async () => {
  const lookup = fakeLookup({ reads: { 'm1#e0': 'une recette, trois œufs' } });
  const { llm } = await runLookupTurn({ lookup });

  assert.equal(lookup.readCalls.length, 1);
  const { guildId, links, options } = lookup.readCalls[0];
  assert.equal(guildId, 'g1');
  assert.deepEqual(links.map((l) => l.id), ['m1#e0']);
  assert.equal(links[0].url, 'https://example.org/a');
  assert.equal(options.maxNew, 2);
  const userMessage = llm.turnCalls[0].messages[1].content;
  assert.ok(userMessage.includes('[link: example.org — Crêpes] [page read: une recette, trois œufs]'), userMessage);
});

test('createTurnRunner: lookup -- links are offered newest message first', async () => {
  const lookup = fakeLookup();
  const history = [
    linkRaw('m1', NOW - 9000, [PAGE_EMBED]),
    linkRaw('m2', NOW - 5000, [{ ...PAGE_EMBED, url: 'https://example.org/b', title: 'B' }]),
    rawMessage({ id: 'm3', ts: NOW - 1000, content: 'λοιπόν;' }),
  ];
  await runLookupTurn({ lookup, history });
  assert.deepEqual(lookup.readCalls[0].links.map((l) => l.id), ['m2#e0', 'm1#e0']);
});

test('createTurnRunner: lookup -- the classifier gets the transcript and the candidate; a query becomes a <lookup> block', async () => {
  const llm = lookupLlm('champions final winner 2026');
  const lookup = fakeLookup({ reads: { 'm1#e0': 'une recette' } });
  await runLookupTurn({ llm, lookup });

  assert.equal(llm.classifierCalls.length, 1);
  const { messages, options } = llm.classifierCalls[0];
  assert.equal(messages[0].content, 'Decide whether Bot needs to look something up.');
  const user = messages[1].content;
  assert.ok(user.startsWith('<transcript>\n'));
  assert.ok(user.includes('[page read: une recette]'), 'the classifier transcript carries the reads');
  assert.ok(user.endsWith('</transcript>\n<candidate>\nZoë: ποιος κέρδισε τον τελικό;\n</candidate>'), user);
  assert.ok(!user.split('<candidate>')[0].includes('ποιος κέρδισε'), 'the trigger only in <candidate>');
  assert.equal(options.model, 'x/text');
  assert.equal(options.maxOutputTokens, 60);
  assert.equal(options.timeoutMs, 300_000);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.countAgainstDailyCap, true);

  assert.deepEqual(lookup.searchCalls, [{ guildId: 'g1', query: 'champions final winner 2026' }]);
  const turnUser = llm.turnCalls[0].messages[1].content;
  const block = [
    fill(labels.lookup.header, { query: 'champions final winner 2026' }),
    'ευρήματα',
    fill(labels.lookup.sources, { list: 'example.com' }),
  ].join('\n');
  assert.ok(turnUser.includes(`<lookup>\n${block}\n</lookup>`), turnUser);
});

test('createTurnRunner: lookup -- {{today}} in the classifier prompt is the injected clock\'s UTC date, {{name}} still filled', async () => {
  const hot = lookupHot();
  hot.prompts.lookup = 'Decide whether {{name}} needs to look something up. Today is {{today}}; {{name}} again.';
  const llm = lookupLlm('none');
  // 23:30 UTC on the last day of the year: the UTC date, not a local one.
  await runLookupTurn({ hot, llm, now: () => Date.UTC(2031, 11, 31, 23, 30, 0) });
  assert.equal(llm.classifierCalls[0].messages[0].content, 'Decide whether Bot needs to look something up. Today is 2031-12-31; Bot again.');
});

test('createTurnRunner: lookup -- a classifier prompt without {{today}} passes through unchanged apart from {{name}}', async () => {
  const hot = lookupHot();
  hot.prompts.lookup = 'Decide whether {{name}} should search; keep {{other}} as it is.';
  const llm = lookupLlm('none');
  await runLookupTurn({ hot, llm, now: () => Date.UTC(2031, 0, 2, 3, 4, 5) });
  assert.equal(llm.classifierCalls[0].messages[0].content, 'Decide whether Bot should search; keep {{other}} as it is.');
});

test('createTurnRunner: lookup -- contextMessages 0 omits the <transcript> block', async () => {
  const llm = lookupLlm('none');
  await runLookupTurn({ llm, hot: lookupHot({}, { search: { contextMessages: 0 } }) });
  assert.equal(llm.classifierCalls[0].messages[1].content, '<candidate>\nZoë: ποιος κέρδισε τον τελικό;\n</candidate>');
});

test('createTurnRunner: lookup -- none, an empty answer or a classifier error -> no search, no <lookup> block', async () => {
  for (const answer of ['none', '', new Error('boom')]) {
    const lookup = fakeLookup();
    const { llm, result } = await runLookupTurn({ llm: lookupLlm(answer), lookup });
    assert.equal(result.outcome, 'spoke');
    assert.equal(lookup.searchCalls.length, 0);
    assert.ok(!llm.turnCalls[0].messages[1].content.includes('\n<lookup>\n'));
  }
});

test('createTurnRunner: lookup -- a search returning null leaves no <lookup> block', async () => {
  const lookup = fakeLookup({ searchResult: null });
  const { llm } = await runLookupTurn({ llm: lookupLlm('x y'), lookup });
  assert.equal(lookup.searchCalls.length, 1);
  assert.ok(!llm.turnCalls[0].messages[1].content.includes('\n<lookup>\n'));
});

test('createTurnRunner: lookup -- only on a direct address: a spontaneous turn reads links but never classifies', async () => {
  const lookup = fakeLookup();
  const { llm } = await runLookupTurn({ lookup, llm: lookupLlm('x y'), trigger: false });
  assert.equal(lookup.readCalls.length, 1);
  assert.equal(llm.classifierCalls.length, 0);
  assert.equal(lookup.searchCalls.length, 0);
});

test('createTurnRunner: lookup -- one classifier call and at most one search per turn', async () => {
  const lookup = fakeLookup();
  const { llm } = await runLookupTurn({ lookup, llm: lookupLlm('first query\nsecond query') });
  assert.equal(llm.classifierCalls.length, 1);
  assert.deepEqual(lookup.searchCalls.map((c) => c.query), ['first query']);
});

test('createTurnRunner: lookup -- no key, no prompt, search disabled or maxPerTurn 0 -> no classifier call', async () => {
  const noPrompt = lookupHot();
  delete noPrompt.prompts.lookup;
  const cases = [
    { hot: lookupHot(), lookup: fakeLookup({ hasKey: false }) },
    { hot: noPrompt, lookup: fakeLookup() },
    { hot: lookupHot({}, { search: { enabled: false } }), lookup: fakeLookup() },
    { hot: lookupHot({}, { search: { maxPerTurn: 0 } }), lookup: fakeLookup() },
  ];
  for (const { hot, lookup } of cases) {
    const { llm } = await runLookupTurn({ hot, lookup, llm: lookupLlm('x y') });
    assert.equal(llm.classifierCalls.length, 0);
    assert.equal(lookup.searchCalls.length, 0);
  }
});

test('createTurnRunner: lookup -- links disabled -> no readLinks, the search still runs', async () => {
  const lookup = fakeLookup();
  await runLookupTurn({ hot: lookupHot({}, { links: { enabled: false } }), lookup, llm: lookupLlm('x y') });
  assert.equal(lookup.readCalls.length, 0);
  assert.equal(lookup.searchCalls.length, 1);
});

test('createTurnRunner: lookup -- features.webLookup off or missing -> zero lookup calls and no classifier call', async () => {
  for (const features of [{ webLookup: false }, { webLookup: undefined }]) {
    const lookup = fakeLookup();
    const { llm } = await runLookupTurn({ hot: lookupHot(features), lookup, llm: lookupLlm('x y') });
    assert.equal(lookup.readCalls.length, 0);
    assert.equal(lookup.searchCalls.length, 0);
    assert.equal(llm.classifierCalls.length, 0);
    assert.equal(llm.turnCalls.length, 1);
  }
});

test('createTurnRunner: lookup -- logs lookup: classified with codes only, never the query or the transcript', async () => {
  const { logs } = await withCapturedLogs(() => runLookupTurn({ llm: lookupLlm('requête très secrète') }));
  const line = logs.find((l) => l.msg === 'lookup: classified');
  assert.ok(line);
  assert.equal(line.picked, true);
  assert.equal(line.parse, 'ok');
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('secrète'));
  assert.ok(!all.includes('κέρδισε'));
});

test('createTurnRunner: lookup -- senses.search reaches the request only when lookup.hasSearch() is true', async () => {
  for (const hasKey of [true, false]) {
    const { llm } = await runLookupTurn({ lookup: fakeLookup({ hasKey }) });
    const user = llm.turnCalls[0].messages[1].content;
    assert.equal(user.includes(labels.senses.search), hasKey);
    assert.ok(user.includes(labels.senses.linksRead), 'reading links needs no search key');
  }
});

// ---------------------------------------------------------------------------
// Drawing: the persona's <draw> goes to the image client after its messages;
// a failed generation gets its own follow-up turn.

const DRAW_IMAGE_CFG = { maxPromptChars: 800, reference: 'avatar', referenceMaxBytes: 4_000_000 };

/** A fake createImageGen()-shaped dependency (see src/llm/images.js). */
function fakeImages({ error = null, mediaType = 'image/png', quota = { used: 0, cap: 5, userUsed: 0, userCap: 3, spent: false, userSpent: false } } = {}) {
  const generateCalls = [];
  const quotaCalls = [];
  return {
    generateCalls,
    quotaCalls,
    generate: async (args) => {
      generateCalls.push(args);
      if (error) throw error;
      return { buffer: Buffer.from('fake picture'), mediaType, cost: 0.02, usage: {}, model: 'fake/model', seconds: 1.5 };
    },
    quota: (args) => {
      quotaCalls.push(args);
      return quota;
    },
  };
}

/** A fake LLM answering each call with the next text of `answers` (the last one repeats). */
function sequenceLlm(answers) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      return { text: answers[Math.min(calls.length - 1, answers.length - 1)], usage: {}, estimated: 10 };
    },
  };
}

function drawHot(features = {}, image = {}, bot = {}) {
  const hot = fakeHot({ typingSimulation: false, ...features }, bot, { image: { ...DRAW_IMAGE_CFG, ...image } });
  hot.prompts.draw = 'Drawing for {{name}}.\n\n{{appearance}}\n\n{{request}}';
  hot.prompts.appearance = '{{name}} wears a green scarf.';
  hot.prompts.reply = 'Someone called you: {{author}}, they {{trigger}}.';
  return hot;
}

async function runDrawTurn({ answers, hot = drawHot(), images = fakeImages(), client = fakeClient(), imageFetcher = fakeImageFetcher(), withTrigger = true, attachFiles = true } = {}) {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'draw me a cat' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw], attachFiles });
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client, images, imageFetcher });
  const params = withTrigger
    ? { channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }
    : { channel, mode: 'interject' };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn(params));
  return { result, logs, channel, llm, images, imageFetcher, turns };
}

function userTextOf(messages) {
  const content = messages[1].content;
  return Array.isArray(content) ? content.find((part) => part.type === 'text').text : content;
}

test('runTurn: a <draw> after <msg> posts the messages then a file', async () => {
  const { result, channel, images } = await runDrawTurn({ answers: ['<msg>one sec</msg><msg>here</msg><draw reply="#1">a cat on a roof</draw>'] });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(channel.sent.length, 3);
  assert.equal(channel.sent[0].content, 'one sec');
  assert.equal(channel.sent[1].content, 'here');
  const file = channel.sent[2];
  assert.equal(file.content, undefined);
  assert.equal(file.files.length, 1);
  assert.ok(file.files[0].name.endsWith('.png'));
  assert.ok(Buffer.isBuffer(file.files[0].attachment));
  assert.deepEqual(file.reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(file.allowedMentions, { parse: [] });

  assert.equal(images.generateCalls.length, 1);
  const call = images.generateCalls[0];
  assert.equal(call.userId, 'u1');
  assert.equal(call.reference, null, 'a non-self picture never carries the avatar');
  assert.equal(call.prompt, 'Drawing for Bot.\n\na cat on a roof');
});

test('runTurn: the file name follows the media type (image/jpeg -> .jpg)', async () => {
  const { channel } = await runDrawTurn({ answers: ['<draw>a cat</draw>'], images: fakeImages({ mediaType: 'image/jpeg' }) });
  assert.equal(channel.sent[0].files[0].name, 'image.jpg');
});

test('runTurn: the draw request is clamped to image.maxPromptChars', async () => {
  const { images } = await runDrawTurn({ answers: ['<draw>abcdefghij</draw>'], hot: drawHot({}, { maxPromptChars: 4 }) });
  assert.ok(images.generateCalls[0].prompt.endsWith('\n\nabcd'));
});

test('runTurn: a self <draw> passes the avatar as reference', async () => {
  const avatarCalls = [];
  const client = fakeClient();
  client.user.displayAvatarURL = (options) => {
    avatarCalls.push(options);
    return 'https://cdn.example.com/avatar.png';
  };
  const imageFetcher = fakeImageFetcher({ dataUrl: 'data:image/png;base64,YXZhdGFy', bytes: 6, contentType: 'image/png' });
  const { images } = await runDrawTurn({ answers: ['<draw self="yes">me waving</draw>'], client, imageFetcher });

  assert.deepEqual(avatarCalls, [{ extension: 'png', size: 1024, forceStatic: true }]);
  assert.equal(imageFetcher.calls.length, 1);
  assert.equal(imageFetcher.calls[0].url, 'https://cdn.example.com/avatar.png');
  assert.equal(imageFetcher.calls[0].options.maxBytes, DRAW_IMAGE_CFG.referenceMaxBytes);
  assert.equal(imageFetcher.calls[0].options.timeoutMs, 10_000);
  assert.equal(images.generateCalls[0].reference, 'data:image/png;base64,YXZhdGFy');
  assert.ok(images.generateCalls[0].prompt.includes('Bot wears a green scarf.'), 'a self picture carries the appearance');
});

test('runTurn: reference none skips the avatar', async () => {
  let avatarAsked = false;
  const client = fakeClient();
  client.user.displayAvatarURL = () => {
    avatarAsked = true;
    return 'https://cdn.example.com/avatar.png';
  };
  const { images, imageFetcher } = await runDrawTurn({ answers: ['<draw self="yes">me waving</draw>'], hot: drawHot({}, { reference: 'none' }), client });

  assert.equal(avatarAsked, false);
  assert.equal(imageFetcher.calls.length, 0);
  assert.equal(images.generateCalls[0].reference, null);
});

test('runTurn: an avatar that cannot be fetched is logged and the picture is drawn without it', async () => {
  const client = fakeClient();
  client.user.displayAvatarURL = () => 'https://cdn.example.com/avatar.png';
  const { images, channel, logs } = await runDrawTurn({ answers: ['<draw self="yes">me</draw>'], client, imageFetcher: fakeImageFetcher(null) });

  assert.ok(logs.some((l) => l.msg === 'turn: avatar reference unavailable'));
  assert.equal(images.generateCalls[0].reference, null);
  assert.equal(channel.sent.length, 1);
});

test('runTurn: dry-run logs the draw prompt and never calls generate', async () => {
  const mirrorSent = [];
  const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
  const { result, logs, channel, images } = await runDrawTurn({
    answers: ['<draw self="yes">me on a bicycle</draw>'],
    hot: drawHot({ dryRun: true }, {}, { dryRunChannelId: 'mirror1' }),
    client,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, true);
  assert.equal(result.drawFailed, undefined);
  assert.equal(images.generateCalls.length, 0);
  assert.equal(channel.sent.length, 0);
  const line = logs.find((l) => l.msg === 'dry-run: would draw');
  assert.ok(line);
  assert.equal(line.channel, 'c1');
  assert.equal(line.channelName, 'general');
  assert.equal(line.mode, 'reply');
  assert.equal(line.self, true);
  // The full image prompt: the fixture's draw prompt, the appearance (a self picture) and the request.
  assert.ok(line.prompt.includes('Drawing for Bot.'), 'the draw prompt file is in the logged prompt');
  assert.ok(line.prompt.includes('Bot wears a green scarf.'), 'the appearance is in the logged prompt');
  assert.ok(line.prompt.endsWith('me on a bicycle'), 'the request is in the logged prompt');
  assert.equal(line.prompt, 'Drawing for Bot.\n\nBot wears a green scarf.\n\nme on a bicycle');
  assert.equal(mirrorSent.length, 1);
  assert.equal(mirrorSent[0].content, `[dry-run] #general \u00b7 reply \u00b7 draw (self)\n${line.prompt}`);
});

test('runTurn: dry-run mirrors a long draw prompt in numbered parts that each fit a Discord message', async () => {
  const mirrorSent = [];
  const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
  const hot = drawHot({ dryRun: true }, {}, { dryRunChannelId: 'mirror1' });
  hot.prompts.draw = `${'style line é\n'.repeat(300)}{{request}}`;
  const { logs } = await runDrawTurn({ answers: ['<draw>a cat</draw>'], hot, client });

  const prompt = logs.find((l) => l.msg === 'dry-run: would draw').prompt;
  assert.ok(prompt.length > 2000);
  assert.ok(mirrorSent.length >= 2);
  const bodies = mirrorSent.map((payload, i) => {
    const [header, ...body] = payload.content.split('\n');
    assert.ok([...payload.content].length <= 2000, 'every part fits one Discord message');
    assert.equal(header, `[dry-run] #general \u00b7 reply \u00b7 draw (${i + 1}/${mirrorSent.length})`);
    return body.join('\n');
  });
  assert.equal(bodies.join('\n'), prompt, 'the parts put together are the whole prompt');
});

test('runTurn: a failed generation runs a second turn with triggerKind drawFailed', async () => {
  const { result, llm, channel, images, logs } = await runDrawTurn({
    answers: ['<msg>on it</msg><draw>a cat</draw>', '<msg>it did not work</msg><draw>a cat again</draw>'],
    images: fakeImages({ error: new ImageGenError('moderation') }),
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, 'moderation');
  assert.equal(llm.calls.length, 2, 'exactly one extra turn');
  assert.ok(userTextOf(llm.calls[0]).includes(labels.senses.draw), 'the first turn offers drawing');
  const second = userTextOf(llm.calls[1]);
  assert.ok(second.includes(fill(labels.triggers.drawFailed, { reason: labels.draw.reasons.moderation })));
  for (const line of [labels.senses.draw, labels.senses.drawSpent, labels.senses.drawSpentUser]) {
    assert.ok(!second.includes(line), 'the drawFailed turn offers no drawing');
  }
  assert.equal(images.generateCalls.length, 1, 'the <draw> of the second answer is dropped');
  assert.deepEqual(channel.sent.map((p) => p.content), ['on it', 'it did not work']);
  const answered = logs.find((l) => l.msg === 'turn: draw failure answered');
  assert.ok(answered);
  assert.equal(answered.channel, 'c1');
  assert.equal(answered.outcome, 'spoke');
});

// A cap refusal no longer reaches a second turn: it posts the limit notice (see the limit tests below).
test('runTurn: an empty picture reaches the second turn as the error reason label', async () => {
  const { result, llm } = await runDrawTurn({ answers: ['<draw>a cat</draw>', '<msg>no</msg>'], images: fakeImages({ error: new ImageGenError('empty') }) });
  assert.equal(result.drawFailed, 'error');
  assert.ok(userTextOf(llm.calls[1]).includes(fill(labels.triggers.drawFailed, { reason: labels.draw.reasons.error })));
});

test('runTurn: an upload failure counts as a failed drawing', async () => {
  const hot = drawHot();
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const send = channel.send;
  channel.send = async (payload) => {
    if (payload.files) throw new Error('upload rejected');
    return send(payload);
  };
  const llm = sequenceLlm(['<draw>a cat</draw>', '<msg>no</msg>']);
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), images: fakeImages() });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

  assert.equal(result.drawFailed, 'error');
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(channel.sent.map((p) => p.content), ['no']);
  assert.equal(turns.isAnyBusy(), false);
});

test('runTurn: a failed generation without a trigger runs no second turn', async () => {
  const { result, llm, logs, images } = await runDrawTurn({
    answers: ['<draw>a sunset</draw>'],
    images: fakeImages({ error: new ImageGenError('timeout') }),
    withTrigger: false,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, 'timeout');
  assert.equal(llm.calls.length, 1);
  assert.equal(images.generateCalls[0].userId, null);
  const line = logs.find((l) => l.msg === 'turn: draw failed');
  assert.ok(line);
  assert.equal(line.reason, 'timeout');
});

test('runTurn: features.imageGeneration false drops the tag', async () => {
  const { result, channel, images, llm } = await runDrawTurn({
    answers: ['<msg>hi</msg><draw>a cat</draw>'],
    hot: drawHot({ imageGeneration: false }),
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(images.generateCalls.length, 0);
  assert.equal(images.quotaCalls.length, 0, 'no quota lookup without the feature');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].files, undefined);
  assert.ok(!userTextOf(llm.calls[0]).includes(labels.senses.draw));
});

test('runTurn: a channel without Attach Files offers no drawing and never generates', async () => {
  const { result, channel, images, llm } = await runDrawTurn({
    answers: ['<msg>hi</msg><draw>a cat</draw>'],
    attachFiles: false,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(images.generateCalls.length, 0, 'nothing is generated (or paid for)');
  assert.equal(images.quotaCalls.length, 0, 'no quota lookup where no file can be posted');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].files, undefined);
  assert.ok(!userTextOf(llm.calls[0]).includes(labels.senses.draw), 'no drawing line in the senses');
  assert.equal(llm.calls.length, 1, 'no drawFailed turn');
});

test('runTurn: a <draw> alone with the feature off, or without an image client, is a skip', async () => {
  const off = await runDrawTurn({ answers: ['<draw>a cat</draw>'], hot: drawHot({ imageGeneration: false }) });
  assert.equal(off.result.outcome, 'skip');
  assert.equal(off.channel.sent.length, 0);

  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({ hot: drawHot(), store: fakeStore(), llm: sequenceLlm(['<draw>a cat</draw>']), calibrator: identityCalibrator(), client: fakeClient() });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(result.outcome, 'skip');
  assert.equal(channel.sent.length, 0);
});

test('runTurn: a <draw> alone is a spoken turn', async () => {
  const { result, channel, llm, images, logs } = await runDrawTurn({ answers: ['<draw>a cat</draw>'] });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, undefined);
  assert.equal(channel.sent[0].files.length, 1);
  assert.equal(channel.typingCalls.length, 0);
  assert.deepEqual(images.quotaCalls, [{ userId: 'u1' }]);
  assert.ok(userTextOf(llm.calls[0]).includes(labels.senses.draw), 'the draw sense reaches the request');
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.equal(answered.draw, true);
  const drew = logs.find((l) => l.msg === 'turn: drew');
  assert.ok(drew);
  assert.equal(drew.channel, 'c1');
  assert.equal(drew.self, false);
  assert.equal(drew.bytes, Buffer.byteLength('fake picture'));
  assert.ok(!JSON.stringify(logs).includes('a cat'), 'the draw prompt is never logged outside dry-run');
});

test('runTurn: a follow-up turn posts the picture without a Discord reply', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({ hot: drawHot(), store: fakeStore(), llm: sequenceLlm(['<draw reply="#1">a cat</draw>']), calibrator: identityCalibrator(), client: fakeClient(), images: fakeImages() });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' }));
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

test('runTurn: a failed drawing fires onIdle once, only after the drawFailed turn has sent', async () => {
  const order = [];
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const send = channel.send;
  channel.send = async (payload) => {
    order.push(`send:${payload.content}`);
    return send(payload);
  };
  const llm = sequenceLlm(['<msg>on it</msg><draw>a cat</draw>', '<msg>it did not work</msg>']);
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('timeout') }),
  });
  turns.setOnIdle(() => order.push('idle'));

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(order, ['send:on it', 'send:it did not work', 'idle']);
});

test('runTurn: waitIdle() during a failed drawing resolves only after the drawFailed turn', async () => {
  const order = [];
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const send = channel.send;
  channel.send = async (payload) => {
    order.push(`send:${payload.content}`);
    return send(payload);
  };
  const llm = sequenceLlm(['<draw>a cat</draw>', '<msg>it did not work</msg>']);
  let turns;
  const images = {
    quota: () => ({ spent: false, userSpent: false }),
    generate: async () => {
      // Asked while the first turn is still in flight, like /nep pause would.
      turns.waitIdle().then(() => order.push('idle'));
      throw new ImageGenError('moderation');
    },
  };
  turns = createTurnRunner({ hot: drawHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), images });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(order, ['send:it did not work', 'idle']);
});

test('runTurn: a drawFailed turn that fails itself still fires onIdle once', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      if (calls > 1) throw new Error('provider down');
      return { text: '<draw>a cat</draw>', usage: {}, estimated: 1 };
    },
  };
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('error') }),
  });
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 2);
  assert.equal(idle, 1);
  assert.equal(turns.isAnyBusy(), false);
});

test('runTurn: a failed drawing without a trigger fires onIdle once, right away', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm: sequenceLlm(['<draw>a sunset</draw>']),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('timeout') }),
  });
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'interject' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(idle, 1);
});

// --- private (DM) turns --------------------------------------------------------

function privateHot(features = {}) {
  const hot = drawHot(features);
  hot.prompts.reply = 'Someone called you: {{author}}, they {{trigger}}. You are {{name}}.';
  hot.prompts.private = 'PRIVATE_TASK with {{author}} as {{name}}';
  return hot;
}

function privateStore() {
  return fakeStore({
    userProfiles: { u1: { id: 'u1', names: ['Alice'], relationship: 'PUBLIC_REL', affinity: { score: 10, reason: 'public reason', history: [] } } },
    privateProfiles: { u1: { relationship: 'PRIVATE_REL', details: [{ id: 1, text: 'PRIVATE_DETAIL', weight: 1 }], affinity: { score: 5, reason: '', history: [] } } },
    channels: [{ id: 'dm1', name: 'dm', lastMessageAt: NOW, days: {} }],
  });
}

/** The client of a bot serving guild g1, where its display name is `GuildBot`. */
function guildClient() {
  return fakeClient({ guilds: { cache: new Map([['g1', { id: 'g1', members: { me: { displayName: 'GuildBot' } } }]]) } });
}

async function runPrivateTurn({ answers = ['<msg reply="#1">hi</msg>'], hot = privateHot(), store = privateStore(), images = fakeImages(), client = guildClient(), guildId = 'g1' } = {}) {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client, images });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, guildId, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }),
  );
  return { result, logs, channel, llm, store, images, turns };
}

test('runTurn: a private turn takes guildId from params and reads the private layer of the trigger author', async () => {
  const { result, channel, store } = await runPrivateTurn();

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(store.guildCalls, ['g1']);
  assert.deepEqual(store.privateCalls, [{ guildId: 'g1', userId: 'u1' }]);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'hi');
  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false }, 'a private reply may quote the trigger');
});

test('runTurn: a private request carries the private prompt, the private trigger label and the merged profile, no server or neighbours', async () => {
  const { llm } = await runPrivateTurn();
  const user = userTextOf(llm.calls[0]);

  assert.ok(user.includes(`Someone called you: Alice, they ${labels.triggers.private}. You are GuildBot.`), 'selfName comes from the served guild');
  assert.ok(user.includes('PRIVATE_TASK with Alice as GuildBot'));
  assert.ok(user.includes('PUBLIC_REL') && user.includes('PRIVATE_REL') && user.includes('PRIVATE_DETAIL'));
  assert.ok(user.includes('attitude: 15 '), 'the attitude is the public and private scores added');
  assert.ok(user.includes(labels.senses.privateChat));
  assert.ok(!user.includes('<server>'));
  assert.ok(!user.includes('<other_channels>'));
});

test('runTurn: a private turn falls back to the bot user name when the served guild is not cached', async () => {
  const { llm } = await runPrivateTurn({ client: fakeClient({ guilds: { cache: new Map() } }) });
  assert.ok(userTextOf(llm.calls[0]).includes('You are Bot.'));
});

test('runTurn: a private turn may draw (no Attach Files check in a DM), counted for the DM partner', async () => {
  const { result, channel, images } = await runPrivateTurn({ answers: ['<msg>sure</msg><draw>a cat</draw>'] });

  assert.equal(result.outcome, 'spoke');
  assert.equal(images.generateCalls.length, 1);
  assert.equal(images.generateCalls[0].userId, 'u1');
  assert.equal(images.generateCalls[0].prompt, 'Drawing for GuildBot.\n\na cat');
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[1].files.length, 1);
});

test('runTurn: a guild channel keeps its own guild id even when a guildId param is passed', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ guildId: 'g1', historyMessages: [raw] });
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.private = 'PRIVATE_TASK';
  const turns = createTurnRunner({ hot, store, llm: fakeLlm('<skip/>'), calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, guildId: 'other', mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.deepEqual(store.guildCalls, ['g1']);
  assert.equal(store.privateCalls.length, 0, 'a guild turn never reads the private layer');
});

test('runTurn: a guild turn never carries the private prompt or the private senses line', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const hot = fakeHot({ privateMessages: true });
  hot.prompts.private = 'PRIVATE_TASK';
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const user = llm.calls[0][1].content;
  assert.ok(!user.includes('PRIVATE_TASK'));
  assert.ok(!user.includes(labels.senses.privateChat));
  assert.ok(user.includes(labels.senses.privateAware));
});

test('runTurn: a channel without a guild and no guildId param throws a clear error and leaves nothing busy', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient() });

  await assert.rejects(
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }),
    /guildId/,
  );
  assert.equal(llm.calls.length, 0);
  assert.equal(turns.isAnyBusy(), false);
});

// --- limits --------------------------------------------------------------------

function throwingLlm(error) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      throw error;
    },
  };
}

test('runTurn: a daily request cap or a token cap refusal returns outcome refused with the limit', async () => {
  for (const [error, limit] of [
    [Object.assign(new DailyCapError('cap'), { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 }), { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 }],
    [Object.assign(new TokenLimitError('tokens'), { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 }), { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 }],
  ]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: throwingLlm(error), calibrator: identityCalibrator(), client: fakeClient() });
    const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

    assert.deepEqual(result, { outcome: 'refused', limit });
    assert.equal(channel.sent.length, 0, 'the turn itself posts nothing; the caller decides on the notice');
  }
});

test('runTurn: a rail error without limit fields still returns refused, with a null limit', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: throwingLlm(new DailyCapError('cap')), calibrator: identityCalibrator(), client: fakeClient() });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

  assert.deepEqual(result, { outcome: 'refused', limit: null });
});

function imageCap(reason, key, used, cap) {
  return Object.assign(new ImageCapError(reason), { key, used, cap });
}

test('runTurn: a drawing refused by an image cap posts the limit notice as a plain reply and runs no second turn', async () => {
  for (const [reason, key] of [['daily', 'image.maxPerDay'], ['userDaily', 'image.maxPerUserPerDay']]) {
    const { result, llm, channel, logs } = await runDrawTurn({
      answers: ['<msg>on it</msg><draw reply="#1">a cat</draw>', '<msg>should never be asked</msg>'],
      images: fakeImages({ error: imageCap(reason, key, 3, 3) }),
    });

    assert.equal(result.outcome, 'spoke');
    assert.equal(result.drawFailed, undefined);
    assert.equal(llm.calls.length, 1, 'no drawFailed turn');
    assert.equal(channel.sent.length, 2);
    assert.equal(channel.sent[0].content, 'on it');
    assert.deepEqual(channel.sent[1], {
      content: fill(labels.limits.notice, { limit: key, used: 3, cap: 3 }),
      reply: { messageReference: 'm1', failIfNotExists: false },
      allowedMentions: { parse: [] },
    });
    const line = logs.find((l) => l.msg === 'turn: draw refused by a limit');
    assert.ok(line);
    assert.equal(line.key, key);
    assert.equal(logs.some((l) => l.msg === 'turn: draw failed'), false);
  }
});

test('runTurn: an image cap notice in a private chat replies to the trigger too', async () => {
  const { result, llm, channel } = await runPrivateTurn({
    answers: ['<draw>a cat</draw>'],
    images: fakeImages({ error: imageCap('userDaily', 'image.maxPerUserPerDay', 2, 2) }),
  });

  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 1);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, fill(labels.limits.notice, { limit: 'image.maxPerUserPerDay', used: 2, cap: 2 }));
  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
});

test('runTurn: an image cap with no limits.notice label posts nothing and still runs no second turn', async () => {
  const hot = drawHot();
  hot.prompts.labels = { ...labels, limits: undefined };
  const { result, llm, channel } = await runDrawTurn({
    answers: ['<msg>on it</msg><draw>a cat</draw>', '<msg>no</msg>'],
    hot,
    images: fakeImages({ error: imageCap('daily', 'image.maxPerDay', 5, 5) }),
  });

  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(channel.sent.map((p) => p.content), ['on it']);
});

test('runTurn: an image cap on a follow-up turn posts the notice without quoting the trigger', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm: sequenceLlm(['<draw reply="#1">a cat</draw>']),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: imageCap('daily', 'image.maxPerDay', 5, 5) }),
  });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' }));

  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

test('runTurn: an image cap notice while dry-run is on is logged and mirrored, never sent', async () => {
  const mirrorSent = [];
  const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
  const hot = drawHot({}, {}, { dryRunChannelId: 'mirror1' });
  const images = fakeImages();
  // The owner switches dry-run on while the picture is being made: read at the moment of use.
  images.generate = async () => {
    hot.config.features.dryRun = true;
    throw imageCap('daily', 'image.maxPerDay', 5, 5);
  };
  const { result, channel, logs } = await runDrawTurn({ answers: ['<msg>on it</msg><draw>a cat</draw>'], hot, images, client });

  assert.equal(result.drawFailed, undefined);
  assert.deepEqual(channel.sent.map((p) => p.content), ['on it'], 'the notice is never sent to the channel');
  const line = logs.find((l) => l.msg === 'dry-run: would notify limit');
  assert.ok(line);
  assert.equal(line.key, 'image.maxPerDay');
  assert.equal(line.used, 5);
  assert.equal(line.cap, 5);
  assert.equal(mirrorSent.length, 1);
  assert.ok(mirrorSent[0].content.endsWith(fill(labels.limits.notice, { limit: 'image.maxPerDay', used: 5, cap: 5 })));
  assert.deepEqual(mirrorSent[0].allowedMentions, { parse: [] });
});

test('runTurn: a generation failure (not a cap) still hands off to the drawFailed turn', async () => {
  const { result, llm, channel } = await runDrawTurn({
    answers: ['<draw>a cat</draw>', '<msg>it failed</msg>'],
    images: fakeImages({ error: new ImageGenError('timeout') }),
  });

  assert.equal(result.drawFailed, 'timeout');
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(channel.sent.map((p) => p.content), ['it failed']);
});

test('runTurn: the drawFailed turn of a private chat keeps the guildId', async () => {
  const { result, llm, store } = await runPrivateTurn({
    answers: ['<draw>a cat</draw>', '<msg>it failed</msg>'],
    images: fakeImages({ error: new ImageGenError('moderation') }),
  });

  assert.equal(result.drawFailed, 'moderation');
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(store.guildCalls, ['g1', 'g1']);
  assert.ok(userTextOf(llm.calls[1]).includes(fill(labels.triggers.drawFailed, { reason: labels.draw.reasons.moderation })));
});

test('runTurn: an image cap on a spontaneous turn stays silent -- no notice, no file, only a log line', async () => {
  const { result, llm, channel, logs } = await runDrawTurn({
    answers: ['<msg>look at this sunset</msg><draw>a sunset</draw>', '<msg>should never be asked</msg>'],
    images: fakeImages({ error: imageCap('daily', 'image.maxPerDay', 5, 5) }),
    withTrigger: false,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 1, 'no drawFailed turn');
  assert.deepEqual(channel.sent.map((p) => p.content), ['look at this sunset'], 'nobody asked: no notice');
  assert.ok(channel.sent.every((p) => p.files === undefined), 'no file');
  const line = logs.find((l) => l.msg === 'turn: draw refused by a limit');
  assert.ok(line);
  assert.equal(line.key, 'image.maxPerDay');
  assert.equal(line.used, 5);
  assert.equal(line.cap, 5);
  assert.equal(line.spontaneous, true);
  assert.equal(logs.some((l) => l.msg === 'dry-run: would notify limit'), false);
});
