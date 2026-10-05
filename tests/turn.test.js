// Tests for src/behavior/turn.js: the pure helpers (between, typingMs,
// resolveMentions) plus one integration-style suite for createTurnRunner
// itself, driven with fake discord.js-shaped objects, a fake LLM and a fake
// store -- proving the feature switches (reactions, multiMessage,
// typingSimulation, memory) are applied where this module is responsible for
// them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import {
  resolveMentions,
  createTurnRunner,
  parseRewatchPickDetailed,
  parseLookupQuery,
  usableDestination,
  pickOtherProfiles,
  postLedgerSize,
  appendPostLedger,
} from '../src/behavior/turn.js';
import { between, typingMs } from '../src/behavior/random.js';
import { fill, formatClock, formatDate } from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { ImageCapError, ImageGenError } from '../src/llm/images.js';
import { DailyCapError, TokenLimitError } from '../src/llm/openrouter.js';
import { createVarietyPass } from '../src/behavior/variety-pass.js';
import { pingStatus } from '../src/behavior/elsewhere.js';
import { PAGE, fetchHistory, fetchNeighbors } from '../src/discord/collect.js';
import { buildRequest } from '../src/behavior/prompt.js';

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
  const optionCalls = [];
  return {
    calls,
    optionCalls,
    complete: async (messages, options) => {
      calls.push(messages);
      optionCalls.push(options);
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

function fakeStore({ guildMemory = {}, userProfiles = {}, channels = [], loreEntries = [], privateProfiles = {}, mediaCache = {} } = {}) {
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
    getMediaCache: () => mediaCache,
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
  assert.deepEqual(options, { maxNew: 1 }, 'every describer request counts: no daily-cap option is passed');
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

// Pictures in a neighbour channel's lines: the captions the describer's cache already holds, never a request.

/**
 * A reply turn in c1 whose guild has one neighbour channel, c2, with a recent message carrying two
 * pictures: np1 (its caption is in the cache) and np2 (not cached). The fake describer's
 * cachedDescriptions answers from `cached` alone; describeMany records every call.
 */
function neighborPictureTurn(features) {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const posted = {
    ...rawMessage({
      id: 'n1',
      authorId: 'u2',
      authorName: 'Bob',
      ts: NOW - 2000,
      content: 'look',
      attachments: new Map([
        ['np1', { id: 'np1', contentType: 'image/png', name: 'cat.png', url: 'https://cdn.discordapp.com/x/cat.png' }],
        ['np2', { id: 'np2', contentType: 'image/png', name: 'dog.png', url: 'https://cdn.discordapp.com/x/dog.png' }],
      ]),
    }),
    channelId: 'c2',
  };
  const neighbor = {
    ...fakeTurnChannel({ id: 'c2', name: 'random', historyMessages: [posted] }),
    guild: channel.guild,
    isTextBased: () => true,
    isThread: () => false,
    lastMessageId: SnowflakeUtil.generate({ timestamp: NOW - 2000 }).toString(),
  };
  channel.guild.channels.cache.set(neighbor.id, neighbor);
  const cached = { np1: 'a sleeping cat' };
  const describer = {
    calls: [],
    cachedCalls: [],
    describeMany: async (guildId, items, options) => {
      describer.calls.push({ guildId, items, options });
      return { descriptions: new Map(), newCount: 0 };
    },
    cachedDescriptions: (guildId, items) => {
      describer.cachedCalls.push({ guildId, items });
      return new Map(items.filter((item) => cached[item.itemId]).map((item) => [item.itemId, cached[item.itemId]]));
    },
  };
  const llm = fakeLlm('<msg>ok</msg>');
  const turns = createTurnRunner({
    hot: fakeHot(features),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    now: () => NOW,
  });
  return { channel, llm, describer, turns, trigger: normalizedTrigger(raw) };
}

/** The `<other_channels>` body of the first request the fake LLM received. */
function otherChannelsSent(llm) {
  return userText(llm).split('<other_channels>\n')[1].split('\n</other_channels>')[0];
}

test('runTurn: a neighbour picture already in the describer cache renders with its caption; an uncached one stays blind', async () => {
  const { channel, llm, describer, turns, trigger } = neighborPictureTurn({ mediaDescriptions: true });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.cachedCalls.length, 1);
  assert.equal(describer.cachedCalls[0].guildId, 'g1');
  assert.deepEqual(describer.cachedCalls[0].items.map((item) => item.itemId).sort(), ['np1', 'np2']);
  const others = otherChannelsSent(llm);
  assert.ok(others.includes('# random'), others);
  assert.ok(others.includes(fill(labels.transcript.imageDescribed, { text: 'a sleeping cat' })), others);
  assert.ok(others.includes(labels.transcript.image), 'the uncached picture keeps its blind form');
});

test('runTurn: no describe request is made for a neighbour picture', async () => {
  const { channel, describer, turns, trigger } = neighborPictureTurn({ mediaDescriptions: true });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  const requested = describer.calls.flatMap((call) => call.items.map((item) => item.itemId));
  assert.ok(!requested.includes('np1') && !requested.includes('np2'), JSON.stringify(requested));
});

test('runTurn: features.mediaDescriptions off leaves a neighbour picture blind and never reads the cache', async () => {
  for (const features of [{}, { mediaDescriptions: false }]) {
    const { channel, llm, describer, turns, trigger } = neighborPictureTurn(features);

    await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

    assert.equal(describer.cachedCalls.length, 0);
    assert.equal(describer.calls.length, 0);
    const others = otherChannelsSent(llm);
    assert.ok(!others.includes('a sleeping cat'), others);
    assert.ok(others.includes(labels.transcript.image));
  }
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
  const optionCalls = [];
  let first = true;
  return {
    calls,
    optionCalls,
    complete: async (messages, options) => {
      calls.push(messages);
      optionCalls.push(options);
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

test('createTurnRunner: a 400 with pictures attached -- the text-only resend happens and its answer is the one posted', async () => {
  const raw = videoRaw();
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlmRejectingImagesOnce(400, '<msg>from the resend</msg>');
  const turns = createTurnRunner({
    hot: fakeHot({}),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    imageFetcher: fakeImageFetcher(),
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 2, 'the picture attempt and the text-only resend');
  assert.equal(typeof llm.calls[1][1].content, 'string', 'the resend carries no image_url parts');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'from the resend');
});

// A rate limit / quota (429) or a request timeout (408) says nothing about the
// pictures: the client already retried it, so a text-only resend would only
// double a doomed request while the persona's one attention waits.
for (const status of [429, 408]) {
  test(`createTurnRunner: a ${status} with pictures attached -- no text-only resend, the turn ends in error`, async () => {
    const raw = videoRaw();
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const llm = fakeLlmRejectingImagesOnce(status, '<msg>never posted</msg>');
    const turns = createTurnRunner({
      hot: fakeHot({}),
      store: fakeStore(),
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      imageFetcher: fakeImageFetcher(),
    });

    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' }),
    );

    assert.equal(result.outcome, 'error');
    assert.equal(llm.calls.length, 1, 'the model is called once, never resent text-only');
    assert.ok(Array.isArray(llm.calls[0][1].content), 'the one call carried the pictures');
    assert.equal(channel.sent.length, 0);
    assert.ok(logs.some((l) => l.msg === 'turn: failed'));
  });
}

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
  assert.equal(header, '[dry-run] #general · reply · mention · to Alice');
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
  assert.ok(logs.some((l) => l.msg === 'dry-run: mirror failed'));
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

/** The pick alone, as maybeRewatch reads it. */
const parseRewatchPick = (raw, count) => parseRewatchPickDetailed(raw, count).pick;

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
  assert.deepEqual(parseRewatchPickDetailed('1 | retry', 2), { pick: { n: 1, question: 'retry', retry: true }, reason: 'ok' });
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
  hot.config.llm.helperTimeoutMs = 25_000;
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
  assert.equal(options.timeoutMs, 25_000, 'a helper: llm.helperTimeoutMs, not the talk timeout');
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.purpose, 'rewatch');

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

test('createTurnRunner: rewatch -- the classifier answer cap is media.video.rewatch.classifierMaxOutputTokens, 120 when missing (config.json and the code fallback)', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.media.video.rewatch.classifierMaxOutputTokens, 120);

  const missing = await runRewatch({ hot: rewatchHot({}, { rewatch: {} }) });
  assert.equal(missing.llm.classifierCalls[0].options.maxOutputTokens, 120);
  const set = await runRewatch({ hot: rewatchHot({}, { rewatch: { classifierMaxOutputTokens: 90 } }) });
  assert.equal(set.llm.classifierCalls[0].options.maxOutputTokens, 90);
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
  hot.config.llm.helperTimeoutMs = 25_000;
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
  assert.equal(options.timeoutMs, 25_000, 'a helper: llm.helperTimeoutMs, not the talk timeout');
  assert.equal(options.skipCalibration, true);
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.purpose, 'lookup');

  assert.deepEqual(lookup.searchCalls, [{ guildId: 'g1', query: 'champions final winner 2026' }]);
  const turnUser = llm.turnCalls[0].messages[1].content;
  const block = [
    fill(labels.lookup.header, { query: 'champions final winner 2026' }),
    'ευρήματα',
    fill(labels.lookup.sources, { list: 'example.com' }),
  ].join('\n');
  assert.ok(turnUser.includes(`<lookup>\n${block}\n</lookup>`), turnUser);
});

test('createTurnRunner: lookup -- the classifier answer cap is web.search.classifierMaxOutputTokens, 60 when missing (config.json and the code fallback)', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.web.search.classifierMaxOutputTokens, 60);

  const missing = await runLookupTurn({ llm: lookupLlm('none') });
  assert.equal(missing.llm.classifierCalls[0].options.maxOutputTokens, 60);
  const set = await runLookupTurn({ hot: lookupHot({}, { search: { classifierMaxOutputTokens: 45 } }), llm: lookupLlm('none') });
  assert.equal(set.llm.classifierCalls[0].options.maxOutputTokens, 45);
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

test('createTurnRunner: lookup -- an empty or blank classifier answer is logged as a failure with its model and gives no query', async () => {
  for (const answer of ['', ' \n  \t']) {
    const lookup = fakeLookup();
    const hot = lookupHot({}, {}, { classifier: { text: 'x/text' } });
    const { logs, result: run } = await withCapturedLogs(() => runLookupTurn({ hot, llm: lookupLlm(answer), lookup }));
    const failed = logs.find((l) => l.msg === 'lookup: classifier failed');
    assert.ok(failed, JSON.stringify(answer));
    assert.equal(failed.level, 'warn');
    assert.equal(failed.channel, 'c1');
    assert.equal(failed.reason, 'empty');
    assert.equal(failed.model, 'x/text');
    assert.equal(logs.some((l) => l.msg === 'lookup: classified'), false, 'a failure, not a parsed answer');
    assert.equal(lookup.searchCalls.length, 0);
    assert.equal(run.result.outcome, 'spoke');
    assert.ok(!run.llm.turnCalls[0].messages[1].content.includes('\n<lookup>\n'));
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

async function runDrawTurn({ answers, hot = drawHot(), images = fakeImages(), client = fakeClient(), imageFetcher = fakeImageFetcher(), withTrigger = true, attachFiles = true, triggerKind = 'mention' } = {}) {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'draw me a cat' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw], attachFiles });
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client, images, imageFetcher });
  const params = withTrigger
    ? { channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind }
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
  assert.equal(mirrorSent[0].content, `[dry-run] #general \u00b7 reply \u00b7 mention \u00b7 draw (self)\n${line.prompt}`);
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
    assert.equal(header, `[dry-run] #general \u00b7 reply \u00b7 mention \u00b7 draw (${i + 1}/${mirrorSent.length})`);
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

test('runTurn: the drawFailed turn reruns neither the re-watch nor the search classifier, nor the variety pass', async () => {
  const hot = rewatchHot({ webLookup: true }, {}, {
    image: { ...DRAW_IMAGE_CFG },
    web: { maxPerDay: 60, links: { enabled: true, maxPerTurn: 2 }, search: { enabled: true, maxPerTurn: 1, contextMessages: 50 } },
  });
  hot.prompts.lookup = LOOKUP_SYSTEM;
  hot.prompts.draw = 'Drawing for {{name}}.\n\n{{request}}';
  const classifierCalls = { rewatch: 0, lookup: 0 };
  const turnAnswers = ['<msg>on it</msg><draw>a red car</draw>', '<msg>it did not work</msg>'];
  let turnCount = 0;
  const llm = {
    complete: async (messages) => {
      const system = messages[0].content;
      if (system.startsWith('Pick the video')) {
        classifierCalls.rewatch += 1;
        return { text: 'none', usage: {}, estimated: 5 };
      }
      if (system.startsWith('Decide whether')) {
        classifierCalls.lookup += 1;
        return { text: 'none', usage: {}, estimated: 5 };
      }
      const text = turnAnswers[Math.min(turnCount, turnAnswers.length - 1)];
      turnCount += 1;
      return { text, usage: {}, estimated: 10 };
    },
  };
  const scene = rewatchScene();
  const variety = fakeVariety();
  const turns = createTurnRunner({
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer: fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } }),
    lookup: fakeLookup(),
    images: fakeImages({ error: new ImageGenError('moderation') }),
    imageFetcher: fakeImageFetcher(),
    variety,
  });
  const result = await turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.trigger), triggerKind: 'mention' });

  assert.equal(result.drawFailed, 'moderation');
  assert.equal(turnCount, 2, 'the drawFailed turn ran');
  assert.deepEqual(classifierCalls, { rewatch: 1, lookup: 1 }, 'each classifier once, for the first turn only');
  assert.equal(variety.turnCalls.length, 1, 'one variety pass, for the first turn only');
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

test('runTurn: the injected clock stamps lastPostAt and the turn\'s own time', async () => {
  const raw = rawMessage({ id: 'm1', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(channel.sent.length, 1);
  assert.equal(turns.lastPostAt('c1'), NOW);
  assert.equal(logs.find((l) => l.msg === 'turn: sent').secondsSinceTrigger, 0);
  assert.equal(logs.find((l) => l.msg === 'turn: model answered').secondsToAnswer, 0);
});

test('runTurn: a failing typing indicator is logged with its channel and the message still goes out', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  channel.sendTyping = async () => {
    throw new Error('Missing Permissions');
  };
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: fakeLlm('<msg>hi</msg>'), calibrator: identityCalibrator(), client: fakeClient() });
  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(channel.sent.length, 1);
  const line = logs.find((l) => l.msg === 'turn: typing failed');
  assert.equal(line?.channel, 'c1');
});

test('runTurn: an injected getSelfName names the persona, keyed by the served guild', async () => {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = sequenceLlm(['<msg>hi</msg>']);
  const asked = [];
  const getSelfName = (guildId) => {
    asked.push(guildId);
    return 'Ζωή';
  };
  const turns = createTurnRunner({ hot: privateHot(), store: privateStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), getSelfName });
  await turns.runTurn({ channel, guildId: 'g1', mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' });
  assert.deepEqual(asked, ['g1']);
  assert.ok(userTextOf(llm.calls[0]).includes('You are Ζωή.'));
});

test('runTurn: a dry-run private turn mirrors under "private", never "#null"', async () => {
  const mirrored = [];
  const client = { ...guildClient(), channels: { fetch: async () => ({ send: async (payload) => mirrored.push(payload) }) } };
  const hot = privateHot({ dryRun: true });
  hot.config.bot.dryRunChannelId = 'mirror1';
  const { channel } = await runPrivateTurn({ hot, client });
  assert.equal(channel.sent.length, 0);
  assert.equal(mirrored.length, 1);
  assert.ok(mirrored[0].content.split('\n')[0].startsWith('[dry-run] private · reply · private'), mirrored[0].content);
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
    assert.equal(line.asked, true, 'someone asked: the notice above follows');
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
  assert.equal(line.asked, false);
  assert.equal(logs.some((l) => l.msg === 'dry-run: would notify limit'), false);
});

// The server's custom emoji (features.customEmoji, src/discord/emoji.js).
function fakeEmojiIndex() {
  const emojis = [
    { id: '111111111111111111', name: 'pepe_cry', animated: false },
    { id: '222222222222222222', name: 'dance', animated: true },
  ];
  return { byName: (name) => emojis.find((e) => e.name === name) ?? null, list: () => emojis.map((e) => ({ ...e })) };
}

test('createTurnRunner: the request carries <emoji> ranked by guild.emojiUsage, with cached captions', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore({
    guildMemory: { emojiUsage: { '222222222222222222': { name: 'dance', count: 4, last: Date.now() } } },
    mediaCache: { 'emoji:222222222222222222': { text: 'a spinning figure', ts: 1 } },
  });
  const turns = createTurnRunner({
    hot: fakeHot(),
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const user = llm.calls[0][1].content;
  const text = Array.isArray(user) ? user.find((part) => part.type === 'text').text : user;
  const block = /<emoji>\n([\s\S]*?)\n<\/emoji>/.exec(text);
  assert.ok(block, 'an <emoji> block is sent');
  assert.deepEqual(block[1].split('\n'), [labels.emoji.header, ':dance: -- a spinning figure', ':pepe_cry:']);
  assert.ok(text.includes(labels.senses.customEmoji));
});

test('createTurnRunner: an outgoing :name: becomes the custom emoji, next to a resolved mention', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Zoé' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>@Zoé :dance: ok :unknown:</msg><react to="#1">:pepe_cry:</react>');
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent[0].content, '<@u1> <a:dance:222222222222222222> ok :unknown:');
  assert.deepEqual(channel.sent[0].allowedMentions.users, ['u1']);
  assert.deepEqual(channel.reactCalls, [{ id: 'm1', emoji: '<:pepe_cry:111111111111111111>' }]);
});

test('createTurnRunner: an unknown custom emoji reaction is dropped, a unicode one still goes through', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<react to="#1">:nope:</react><react to="#1">🔥</react>');
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.deepEqual(channel.reactCalls, [{ id: 'm1', emoji: '🔥' }]);
});

test('createTurnRunner: features.customEmoji=false leaves :name: as text and drops a custom reaction', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok :dance:</msg><react to="#1">:pepe_cry:</react>');
  const turns = createTurnRunner({
    hot: fakeHot({ customEmoji: false }),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent[0].content, 'ok :dance:');
  assert.equal(channel.reactCalls.length, 0);
});

test('createTurnRunner: only a custom reaction the index does not know means outcome "skip"', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm: fakeLlm('<react to="#1">:nope:</react>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'skip');
  assert.equal(channel.reactCalls.length, 0);
});

test('createTurnRunner: in dry-run the logged text carries the rendered custom emoji', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    hot: fakeHot({ dryRun: true }),
    store: fakeStore(),
    llm: fakeLlm('<msg>ok :dance:</msg>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }),
  );

  assert.equal(result.dryRun, true);
  assert.equal(channel.sent.length, 0);
  const line = logs.find((l) => l.msg === 'dry-run: would send');
  assert.equal(line.text, 'ok <a:dance:222222222222222222>');
});

// ---------------------------------------------------------------------------
// Provider routing: every request says which role makes it (llm.providerByModel
// keys of the form "<prefix>@<role>").

test('createTurnRunner: the persona turn is requested as the talk role', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient() });
  await turns.runTurn({ channel, mode: 'interject' });
  assert.equal(llm.optionCalls.length, 1);
  assert.deepEqual(llm.optionCalls[0], { role: 'talk' }, 'only the role: the talk model and every other setting stay the defaults');
});

test('createTurnRunner: the text-only retry after a 4xx image error is requested as the talk role too', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['v1', { id: 'v1', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', duration: 34 }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlmRejectingImagesOnce(400, '<msg>ok</msg>');
  const turns = createTurnRunner({ hot: fakeHot({}), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher: fakeImageFetcher() });
  await turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' });
  assert.equal(llm.optionCalls.length, 2);
  assert.deepEqual(llm.optionCalls.map((o) => o?.role), ['talk', 'talk']);
});

test('createTurnRunner: the rewatch and lookup classifiers are requested as classifier.text, the turn as talk', async () => {
  const rewatch = await runRewatch();
  assert.equal(rewatch.llm.classifierCalls[0].options.role, 'classifier.text');
  assert.equal(rewatch.llm.turnCalls[0].options.role, 'talk');
  const lookup = await runLookupTurn();
  assert.equal(lookup.llm.classifierCalls[0].options.role, 'classifier.text');
  assert.equal(lookup.llm.turnCalls[0].options.role, 'talk');
});

// ---------------------------------------------------------------------------
// The variety pass (src/behavior/variety-pass.js): started before the turn's
// other preparation, its answer rendered as <worn>, posted lines recorded, and
// the next turn's pass started ahead once the persona's text is out.

const WORN = [{ shape: 'mock promise ending in (no)', examples: ['(no)'], count: 2 }];

/**
 * A fake createVarietyPass(): `forTurn` answers through `answer(input)`, `ahead`
 * through `onAhead(input)`; `forTurn`, `ahead` and `record` keep their calls.
 */
function fakeVariety(answer = async () => WORN, onAhead = async () => {}) {
  const turnCalls = [];
  const aheadCalls = [];
  const records = [];
  return {
    turnCalls,
    aheadCalls,
    records,
    forTurn: (input) => {
      turnCalls.push(input);
      return answer(input);
    },
    ahead: (input) => {
      aheadCalls.push(input);
      return onAhead(input);
    },
    record: (guildId, line) => {
      records.push({ guildId, line });
      return true;
    },
  };
}

function wornBlockOf(llm) {
  const user = llm.calls[0][1].content;
  const text = typeof user === 'string' ? user : user.find((p) => p.type === 'text').text;
  const match = /<worn>\n([\s\S]*?)\n<\/worn>/.exec(text);
  return match ? match[1] : null;
}

test('runTurn: the variety pass gets the turn\'s history and channel; its answer becomes the <worn> block', async () => {
  const mine = rawMessage({ id: 'm0', authorId: 'self-id', authorName: 'Bot', ts: NOW - 5000, content: 'I will behave (no)' });
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [mine, raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const variety = fakeVariety();
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), variety });
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(variety.turnCalls.length, 1);
  const input = variety.turnCalls[0];
  assert.equal(input.guildId, 'g1');
  assert.equal(input.channelId, 'c1');
  assert.equal(input.privateChat, false);
  assert.equal(input.selfName, 'Bot');
  assert.deepEqual(input.history.filter((m) => m.self).map((m) => m.id), ['m0']);
  assert.equal(wornBlockOf(llm), [labels.variety.intro, '- mock promise ending in (no) ("(no)")'].join('\n'));
});

test('runTurn: no variety pass, a null answer or a rejecting one -> the turn speaks without <worn>', async () => {
  for (const variety of [undefined, fakeVariety(async () => null), fakeVariety(async () => { throw new Error('boom'); })]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const llm = fakeLlm('<msg>hi</msg>');
    const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), variety });
    const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    assert.equal(result.outcome, 'spoke');
    assert.equal(wornBlockOf(llm), null);
  }
});

test('runTurn: the variety pass runs alongside the rest of the preparation, not before it', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  let described;
  const describedOnce = new Promise((resolve) => {
    described = resolve;
  });
  // The pass answers only once the describer has been asked: a turn that awaited the pass first would hang.
  const variety = fakeVariety(async () => {
    await describedOnce;
    return WORN;
  });
  const describer = {
    describeMany: async () => {
      described();
      return { descriptions: new Map() };
    },
  };
  const turns = createTurnRunner({ hot: fakeHot({ mediaDescriptions: true }), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), variety, describer });
  const result = await Promise.race([
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }),
    new Promise((resolve) => setTimeout(() => resolve({ outcome: 'hung' }), 2000)),
  ]);
  assert.equal(result.outcome, 'spoke');
  assert.notEqual(wornBlockOf(llm), null);
});

test('runTurn: every message posted in a server channel joins the ring with its id and what it answered', async () => {
  const raw = rawMessage({ id: 'm1', content: 'is the café open?' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">ναι</msg><msg>until nine</msg>');
  const variety = fakeVariety();
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), variety, now: () => NOW });
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.deepEqual(variety.records, [
    { guildId: 'g1', line: { id: 'sent-1', ts: NOW, channelId: 'c1', text: 'ναι', to: 'is the café open?' } },
    { guildId: 'g1', line: { id: 'sent-2', ts: NOW, channelId: 'c1', text: 'until nine', to: 'is the café open?' } },
  ]);
});

test('runTurn: a dry run records nothing; a private chat runs its pass as private and records nothing', async () => {
  const raw = rawMessage({ id: 'm1' });
  const dry = fakeVariety();
  const turns = createTurnRunner({ hot: fakeHot({ dryRun: true }), store: fakeStore(), llm: fakeLlm('<msg>hi</msg>'), calibrator: identityCalibrator(), client: fakeClient(), variety: dry });
  await turns.runTurn({ channel: fakeTurnChannel({ historyMessages: [raw] }), mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.equal(dry.turnCalls.length, 1, 'the request of a dry run carries the block too');
  assert.deepEqual(dry.records, []);

  const variety = fakeVariety();
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const privateTurns = createTurnRunner({ hot: privateHot(), store: privateStore(), llm: sequenceLlm(['<msg>hi</msg>']), calibrator: identityCalibrator(), client: guildClient(), variety });
  const result = await privateTurns.runTurn({ channel, guildId: 'g1', mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' });
  assert.equal(result.outcome, 'spoke');
  assert.equal(variety.turnCalls[0].privateChat, true);
  assert.equal(variety.turnCalls[0].guildId, 'g1');
  assert.deepEqual(variety.records, []);
});

/** A store with one link GIF `g1` in the library (no other GIF state). */
function gifStore() {
  return { ...fakeStore(), findGif: (guildId, id) => (id === 'g1' ? { id: 'g1', kind: 'link', url: 'https://tenor.com/view/chat-qui-danse-1' } : null) };
}

test('runTurn: after the persona posts, the pass ahead gets the history plus the posted lines, once, after the last text message', async () => {
  const raw = rawMessage({ id: 'm1', content: 'is the café open?' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">ναι</msg><msg>until nine</msg>');
  let sentAtAhead = null;
  const variety = fakeVariety(undefined, async () => {
    sentAtAhead = channel.sent.length;
  });
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), variety, now: () => NOW });
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(variety.aheadCalls.length, 1, 'once per turn');
  assert.equal(sentAtAhead, 2, 'after the last text message');
  const input = variety.aheadCalls[0];
  assert.deepEqual([input.guildId, input.channelId, input.selfName, input.privateChat], ['g1', 'c1', 'Bot', false]);
  assert.deepEqual(input.history.map((m) => m.id), ['m1', 'sent-1', 'sent-2']);
  assert.deepEqual(input.history.slice(1), [
    { id: 'sent-1', ts: NOW, channelId: 'c1', self: true, content: 'ναι', replyToId: 'm1' },
    { id: 'sent-2', ts: NOW, channelId: 'c1', self: true, content: 'until nine', replyToId: null },
  ]);
});

test('runTurn: a posted line carries the sent message id and time and the text as the persona wrote it', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Zoé' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  channel.send = async (payload) => {
    channel.sent.push(payload);
    return { id: `sent-${channel.sent.length}`, createdTimestamp: NOW + channel.sent.length };
  };
  const variety = fakeVariety();
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: fakeLlm('<msg>@Zoé έλα</msg>'), calibrator: identityCalibrator(), client: fakeClient(), variety, now: () => NOW });
  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(channel.sent[0].content, '<@u1> έλα');
  assert.deepEqual(variety.aheadCalls[0].history.at(-1), { id: 'sent-1', ts: NOW + 1, channelId: 'c1', self: true, content: '@Zoé έλα', replyToId: null });
});

test('runTurn: a dry run, a silent turn, a reactions-only and a GIF-only turn start nothing ahead', async () => {
  const cases = [
    { name: 'dry run', hot: fakeHot({ dryRun: true }), output: '<msg>hi</msg>', outcome: 'spoke', sent: 0 },
    { name: 'silent', hot: fakeHot(), output: '<skip/>', outcome: 'skip', sent: 0 },
    { name: 'reactions only', hot: fakeHot(), output: '<react to="#1">🔥</react>', outcome: 'spoke', sent: 0 },
    { name: 'gif only', hot: fakeHot(), output: '<gif>g1</gif>', outcome: 'spoke', sent: 1, store: gifStore() },
  ];
  for (const c of cases) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const variety = fakeVariety();
    const turns = createTurnRunner({ hot: c.hot, store: c.store ?? fakeStore(), llm: fakeLlm(c.output), calibrator: identityCalibrator(), client: fakeClient(), variety, now: () => NOW });
    const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
    assert.equal(result.outcome, c.outcome, c.name);
    assert.equal(channel.sent.length, c.sent, c.name);
    assert.equal(variety.turnCalls.length, 1, c.name);
    assert.deepEqual(variety.aheadCalls, [], c.name);
  }
});

test('runTurn: the pass ahead starts before the GIF and the drawing, not after them', async () => {
  const raw = rawMessage({ id: 'm1', content: 'draw me a cat' });
  const drawChannel = fakeTurnChannel({ historyMessages: [raw] });
  const images = fakeImages();
  const seen = [];
  const drawVariety = fakeVariety(undefined, async () => {
    seen.push({ sent: drawChannel.sent.length, generated: images.generateCalls.length });
  });
  const drawTurns = createTurnRunner({ hot: drawHot(), store: fakeStore(), llm: sequenceLlm(['<msg>one sec</msg><draw>a cat</draw>']), calibrator: identityCalibrator(), client: fakeClient(), images, imageFetcher: fakeImageFetcher(), variety: drawVariety });
  await drawTurns.runTurn({ channel: drawChannel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.equal(drawChannel.sent.length, 2, 'the text, then the picture');
  assert.deepEqual(seen, [{ sent: 1, generated: 0 }]);

  const gifChannel = fakeTurnChannel({ historyMessages: [raw] });
  let sentAtAhead = null;
  const gifVariety = fakeVariety(undefined, async () => {
    sentAtAhead = gifChannel.sent.length;
  });
  const gifTurns = createTurnRunner({ hot: fakeHot({ typingSimulation: false }), store: gifStore(), llm: fakeLlm('<msg>ha</msg><gif>g1</gif>'), calibrator: identityCalibrator(), client: fakeClient(), variety: gifVariety, now: () => NOW });
  await withCapturedLogs(() => gifTurns.runTurn({ channel: gifChannel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(gifChannel.sent.length, 2, 'the text, then the GIF');
  assert.equal(sentAtAhead, 1);
  assert.equal(gifVariety.aheadCalls[0].history.at(-1).content, 'ha', 'the GIF is no line of the pass');
});

test('runTurn: a private chat starts its pass ahead as private with the served guild', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const variety = fakeVariety();
  const turns = createTurnRunner({ hot: privateHot(), store: privateStore(), llm: sequenceLlm(['<msg>hi</msg>']), calibrator: identityCalibrator(), client: guildClient(), variety });
  await turns.runTurn({ channel, guildId: 'g1', mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' });
  assert.equal(variety.aheadCalls.length, 1);
  const input = variety.aheadCalls[0];
  assert.deepEqual([input.guildId, input.channelId, input.privateChat, input.selfName], ['g1', 'dm1', true, 'GuildBot']);
  assert.deepEqual(input.history.map((m) => m.id), ['m1', 'sent-1']);
  assert.deepEqual(variety.records, []);
});

test('runTurn: a pass ahead that throws or rejects never fails the turn; a pass without ahead is fine', async () => {
  const throwing = fakeVariety(undefined, () => {
    throw new Error('boom');
  });
  const rejecting = fakeVariety(undefined, async () => {
    throw new Error('boom');
  });
  const { ahead: _omit, ...withoutAhead } = fakeVariety();
  for (const variety of [throwing, rejecting, withoutAhead]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: fakeLlm('<msg>hi</msg>'), calibrator: identityCalibrator(), client: fakeClient(), variety });
    const { result } = await withCapturedLogs(async () => {
      const outcome = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
      await new Promise((resolve) => setImmediate(resolve));
      return outcome;
    });
    assert.equal(result.outcome, 'spoke');
    assert.equal(channel.sent.length, 1);
  }
});

test('runTurn: the drawFailed turn that posts text starts its own pass ahead, like any turn', async () => {
  const raw = rawMessage({ id: 'm1', content: 'draw me a cat' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const variety = fakeVariety();
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm: sequenceLlm(['<msg>on it</msg><draw>a cat</draw>', '<msg>it did not work</msg>']),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('moderation') }),
    imageFetcher: fakeImageFetcher(),
    variety,
  });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(result.drawFailed, 'moderation');
  assert.equal(variety.turnCalls.length, 1, 'the at-turn pass is not paid twice');
  assert.deepEqual(variety.aheadCalls.map((input) => input.history.at(-1).content), ['on it', 'it did not work']);
});

test('runTurn: the history given ahead is cut to what the next fetch returns: context.channelMessages, at most one page', async () => {
  const page = Array.from({ length: PAGE }, (_, i) => rawMessage({ id: `h${i}`, ts: NOW - (PAGE - i) * 1000, content: `μήνυμα ${i}` }));
  for (const [channelMessages, first, length] of [
    [2, `h${PAGE - 1}`, 2],
    [PAGE + 50, 'h1', PAGE],
  ]) {
    const channel = fakeTurnChannel({ historyMessages: page });
    const variety = fakeVariety();
    const hot = fakeHot({ typingSimulation: false });
    hot.config.context.channelMessages = channelMessages;
    const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<msg>ναι</msg>'), calibrator: identityCalibrator(), client: fakeClient(), variety, now: () => NOW });
    await turns.runTurn({ channel, mode: 'interject' });
    const { history } = variety.aheadCalls[0];
    assert.deepEqual([history.length, history[0].id, history.at(-1).id], [length, first, 'sent-1'], String(channelMessages));
  }
});

test('runTurn: the pass ahead is keyed on the lines the next turn fetches, so that turn finds it ready', async () => {
  // A full page of history with the persona's own lines spread through it, the oldest at the very start:
  // posting two lines pushes it out of the next fetch, so the pass ahead must leave it out too.
  const ownAt = new Set([0, 50, 60, 70]);
  const page = Array.from({ length: PAGE }, (_, i) =>
    rawMessage({
      id: `h${i}`,
      ts: NOW - (PAGE - i) * 1000,
      ...(ownAt.has(i) ? { authorId: 'self-id', authorName: 'Bot', content: `λόγος ${i}` } : { content: `μήνυμα ${i}` }),
    }),
  );
  const hot = fakeHot({ typingSimulation: false });
  hot.config.context.channelMessages = PAGE + 50;
  hot.config.classifier = { text: 'x/classifier' };
  hot.prompts.variety = 'VARIETY for {{name}}';
  const talk = ['<msg>πρώτο</msg><msg>δεύτερο</msg>', '<skip/>'];
  let talkCalls = 0;
  const classifierCalls = [];
  const llm = {
    complete: async (messages, options) => {
      if (options?.role === 'classifier.text') {
        classifierCalls.push(messages);
        return { text: '{"patterns": []}', usage: {}, estimated: 5 };
      }
      const text = talk[Math.min(talkCalls, talk.length - 1)];
      talkCalls += 1;
      return { text, usage: {}, estimated: 10 };
    },
  };
  const guild = {};
  const passStore = {
    getGuild: () => guild,
    pushOwnLine: () => true,
    setWorn: (guildId, worn) => {
      guild.worn = worn;
    },
    appendWornHistory: () => {},
    state: { data: {} },
  };
  const real = createVarietyPass({ hot, store: passStore, llm, now: () => NOW });
  const aheads = [];
  const variety = {
    ...real,
    ahead: (input) => {
      const pending = real.ahead(input);
      aheads.push(pending);
      return pending;
    },
  };
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), variety, now: () => NOW });

  const first = fakeTurnChannel({ historyMessages: page });
  first.send = async (payload) => {
    first.sent.push(payload);
    return { id: `sent-${first.sent.length}`, createdTimestamp: NOW + first.sent.length };
  };
  await withCapturedLogs(async () => {
    await turns.runTurn({ channel: first, mode: 'interject' });
    await Promise.all(aheads);
  });
  assert.equal(aheads.length, 1);
  assert.equal(classifierCalls.length, 2, 'the turn asked for its own lines, then the pass ahead for the next ones');

  // The next fetch: one page, the two posted lines at its end.
  const posted = ['πρώτο', 'δεύτερο'].map((content, i) =>
    rawMessage({ id: `sent-${i + 1}`, authorId: 'self-id', authorName: 'Bot', ts: NOW + i + 1, content }),
  );
  const second = fakeTurnChannel({ historyMessages: [...page, ...posted].slice(-PAGE) });
  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel: second, mode: 'interject' }));
  assert.equal(classifierCalls.length, 2, 'the next turn makes no variety request');
  const turn = logs.find((l) => l.msg === 'variety: turn');
  assert.deepEqual([turn.source, turn.cached, turn.lines], ['cache', true, 5]);
});

// ---------------------------------------------------------------------------
// An overheard turn (triggerKind 'overheard'): a line about the persona, said
// to someone else or to the room. It posts plain like a follow-up, runs no
// trigger-only helper, and nobody asked for its drawing.

test('runTurn: an overheard turn ignores reply="#n" and sends plain; turn: sent carries overheard, a follow-up keeps followUp', async () => {
  const cases = [
    { triggerKind: 'overheard', reply: undefined, overheard: true, followUp: undefined },
    { triggerKind: 'followUp', reply: undefined, overheard: undefined, followUp: true },
    { triggerKind: 'mention', reply: { messageReference: 'm1', failIfNotExists: false }, overheard: undefined, followUp: undefined },
  ];
  for (const c of cases) {
    const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: fakeLlm('<msg reply="#1">ναι, εγώ</msg>'), calibrator: identityCalibrator(), client: fakeClient() });
    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: c.triggerKind }),
    );
    assert.equal(result.outcome, 'spoke', c.triggerKind);
    assert.equal(channel.sent.length, 1, c.triggerKind);
    assert.deepEqual(channel.sent[0].reply, c.reply, c.triggerKind);
    const sent = logs.find((l) => l.msg === 'turn: sent');
    assert.equal(sent.overheard, c.overheard, c.triggerKind);
    assert.equal(sent.followUp, c.followUp, c.triggerKind);
  }
});

test('runTurn: a dry-run overheard or follow-up turn logs no reply target, carries its kind, and names it in the mirror header', async () => {
  for (const triggerKind of ['overheard', 'followUp']) {
    const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
    const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
    const mirrorSent = [];
    const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
    const hot = fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' });
    const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<msg reply="#1">hi</msg>'), calibrator: identityCalibrator(), client });
    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind }),
    );

    assert.equal(result.dryRun, true, triggerKind);
    assert.equal(channel.sent.length, 0, triggerKind);
    const line = logs.find((l) => l.msg === 'dry-run: would send');
    assert.equal(line.replyTo, null, triggerKind);
    assert.equal(line.trigger, triggerKind);
    assert.equal(mirrorSent.length, 1, triggerKind);
    assert.equal(mirrorSent[0].content.split('\n')[0], `[dry-run] #general · reply · ${triggerKind}`);
  }
});

test('runTurn: dry-run: would send carries the trigger kind of a call, null on a spontaneous turn', async () => {
  for (const triggerKind of ['mention', undefined]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot({ dryRun: true }), store: fakeStore(), llm: fakeLlm('<msg>hi</msg>'), calibrator: identityCalibrator(), client: fakeClient() });
    const params = triggerKind ? { channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind } : { channel, mode: 'interject' };
    const { logs } = await withCapturedLogs(() => turns.runTurn(params));
    assert.equal(logs.find((l) => l.msg === 'dry-run: would send').trigger, triggerKind ?? null);
  }
});

test('runTurn: the dry-run mirror header names the trigger kind of every triggered turn, none on a spontaneous turn', async () => {
  for (const [triggerKind, header] of [
    ['name', '[dry-run] #general · reply · name'],
    ['reply', '[dry-run] #general · reply · reply'],
    [undefined, '[dry-run] #general · interject'],
  ]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
    const mirrorSent = [];
    const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
    const hot = fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' });
    const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<msg>hi</msg>'), calibrator: identityCalibrator(), client });
    const params = triggerKind ? { channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind } : { channel, mode: 'interject' };
    await withCapturedLogs(() => turns.runTurn(params));
    assert.equal(mirrorSent.length, 1, String(triggerKind));
    assert.equal(mirrorSent[0].content.split('\n')[0], header);
  }
});

test('runTurn: an overheard turn posts its GIF plain', async () => {
  for (const [triggerKind, reply] of [['overheard', undefined], ['mention', { messageReference: 'm1', failIfNotExists: false }]]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot(), store: gifStore(), llm: fakeLlm('<gif reply="#1">g1</gif>'), calibrator: identityCalibrator(), client: fakeClient() });
    await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind }));
    assert.equal(channel.sent.length, 1, triggerKind);
    assert.equal(channel.sent[0].content, 'https://tenor.com/view/chat-qui-danse-1', triggerKind);
    assert.deepEqual(channel.sent[0].reply, reply, triggerKind);
  }
});

test('runTurn: an overheard turn draws unasked: a plain post, no member charged, the quota read without a member', async () => {
  const { result, channel, images } = await runDrawTurn({ answers: ['<draw reply="#1">a cat</draw>'], triggerKind: 'overheard' });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(images.quotaCalls, [{ userId: null }]);
  assert.equal(images.generateCalls.length, 1);
  assert.equal(images.generateCalls[0].userId, null);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].files.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

test('runTurn: an image cap on an overheard turn posts no notice and runs no second turn', async () => {
  const { result, llm, channel, logs } = await runDrawTurn({
    answers: ['<msg>κοίτα</msg><draw reply="#1">a cat</draw>', '<msg>should never be asked</msg>'],
    images: fakeImages({ error: imageCap('daily', 'image.maxPerDay', 5, 5) }),
    triggerKind: 'overheard',
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 1, 'no drawFailed turn');
  assert.deepEqual(channel.sent.map((p) => p.content), ['κοίτα'], 'nobody asked: no notice');
  const line = logs.find((l) => l.msg === 'turn: draw refused by a limit');
  assert.ok(line);
  // A trigger exists (not spontaneous), yet nobody asked: the line says why no notice followed.
  assert.equal(line.spontaneous, false);
  assert.equal(line.asked, false);
});

test('runTurn: a failed drawing on an overheard turn starts no drawFailed turn and fires onIdle once, right away', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = sequenceLlm(['<msg>on it</msg><draw>a cat</draw>', '<msg>should never be asked</msg>']);
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('timeout') }),
  });
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'overheard' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.drawFailed, 'timeout');
  assert.equal(llm.calls.length, 1, 'no drawFailed turn');
  assert.deepEqual(channel.sent.map((p) => p.content), ['on it']);
  assert.equal(idle, 1, 'the pending queue is drained after this turn');
  assert.equal(turns.isAnyBusy(), false);
  assert.ok(logs.find((l) => l.msg === 'turn: draw failed'));
  assert.equal(logs.some((l) => l.msg === 'turn: draw failure answered'), false);
});

test('runTurn: an overheard turn runs neither the re-watch nor the search classifier; a mention in the same scene runs both', async () => {
  for (const [triggerKind, expected] of [['mention', { rewatch: 1, lookup: 1 }], ['overheard', { rewatch: 0, lookup: 0 }]]) {
    const hot = rewatchHot({ webLookup: true }, {}, {
      web: { maxPerDay: 60, links: { enabled: true, maxPerTurn: 2 }, search: { enabled: true, maxPerTurn: 1, contextMessages: 50 } },
    });
    hot.prompts.lookup = LOOKUP_SYSTEM;
    const classifierCalls = { rewatch: 0, lookup: 0 };
    const llm = {
      complete: async (messages) => {
        const system = messages[0].content;
        if (system.startsWith('Pick the video')) classifierCalls.rewatch += 1;
        else if (system.startsWith('Decide whether')) classifierCalls.lookup += 1;
        else return { text: '<msg>ok</msg>', usage: {}, estimated: 10 };
        return { text: 'none', usage: {}, estimated: 5 };
      },
    };
    const scene = rewatchScene();
    const lookup = fakeLookup();
    const turns = createTurnRunner({
      hot,
      store: fakeStore(),
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      describer: fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } }),
      lookup,
      imageFetcher: fakeImageFetcher(),
    });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.trigger), triggerKind }),
    );

    assert.equal(result.outcome, 'spoke', triggerKind);
    assert.deepEqual(classifierCalls, expected, triggerKind);
    assert.equal(lookup.searchCalls.length, 0, triggerKind);
  }
});

test('runTurn: turn: model answered carries the trigger kind, null on a spontaneous turn', async () => {
  for (const triggerKind of ['mention', 'followUp', 'overheard', undefined]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: fakeLlm('<skip/>'), calibrator: identityCalibrator(), client: fakeClient() });
    const params = triggerKind ? { channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind } : { channel, mode: 'interject' };
    const { logs } = await withCapturedLogs(() => turns.runTurn(params));
    assert.equal(logs.find((l) => l.msg === 'turn: model answered').trigger, triggerKind ?? null, String(triggerKind));
  }
});

// --- another channel pulled into a turn (<channel_view>): the inputs ----------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Other channels of the guild, snowflake-shaped: a `<#id>` mention is only read for such ids.
const DIARY = '100000000000000002';
const NOTES = '100000000000000003';

/** A raw message of channel `channelId`; `raw` is Discord's own text (`<#id>` tokens), `content` the clean one. */
function lineIn(channelId, { raw, ...fields }) {
  const message = { ...rawMessage(fields), channelId };
  if (raw !== undefined) message.content = raw;
  return message;
}

/**
 * Another text channel of `turnChannel`'s guild the bot may read, holding `messages`; its newest
 * message is at `lastTs` (a neighbour when within the last hour of NOW). `readOnly`: the bot
 * cannot send there. `fetchFails`: every history fetch throws. Records every fetch in `fetches`.
 */
function addChannel(turnChannel, { id, name, messages = [], lastTs = messages.at(-1)?.createdTimestamp ?? NOW - 3 * HOUR, readOnly = false, fetchFails = false }) {
  const base = fakeTurnChannel({ id, name, historyMessages: messages });
  const fetches = [];
  const other = {
    ...base,
    guild: turnChannel.guild,
    isTextBased: () => true,
    isThread: () => false,
    lastMessageId: SnowflakeUtil.generate({ timestamp: lastTs }).toString(),
    permissionsFor: () => ({ has: (flag) => !readOnly || flag !== PermissionFlagsBits.SendMessages }),
    fetches,
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        fetches.push(arg);
        if (fetchFails) throw new Error('fixture: fetch failed');
        return base.messages.fetch(arg);
      },
    },
  };
  turnChannel.guild.channels.cache.set(id, other);
  return other;
}

/** The diary channel's lines: two by Éloïse, `ago` before NOW, the second one with a picture. */
function diaryLines(ago = 3 * HOUR) {
  const wall = { id: 'dp1', contentType: 'image/png', name: 'wall.png', url: 'https://cdn.discordapp.com/x/wall.png' };
  return [
    lineIn(DIARY, { id: 'd1', authorId: 'u3', authorName: 'Éloïse', ts: NOW - ago, content: 'σήμερα έβαψα τον τοίχο μπλε' }),
    lineIn(DIARY, { id: 'd2', authorId: 'u3', authorName: 'Éloïse', ts: NOW - ago + MINUTE, content: 'και μετά κοιμήθηκα', attachments: new Map([['dp1', wall]]) }),
  ];
}

/**
 * A turn in #general (c1) whose history holds Bob's line naming #diary (DIARY) -- a real `<#id>`
 * token unless `mention` is false -- and Alice's call after it. The guild holds the diary channel.
 */
function pullScene({ features = {}, context = {}, config = {}, bot = {}, mention = true, diary = {}, between = [], routeChannels, describer, images, store = fakeStore(), llm = fakeLlm('<msg>ok</msg>') } = {}) {
  const asked = lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'είδες το #diary;', raw: mention ? `είδες το <#${DIARY}>;` : 'είδες το #diary;' });
  const call = lineIn('c1', { id: 'm9', ts: NOW - 1000, content: 'λοιπόν;' });
  const channel = fakeTurnChannel({ historyMessages: [asked, ...between, call] });
  const other = addChannel(channel, { id: DIARY, name: 'diary', messages: diaryLines(), ...diary });
  const hot = fakeHot(features, bot, config);
  hot.config.context = { ...hot.config.context, ...context };
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer, routeChannels, images, imageFetcher: fakeImageFetcher(), now: () => NOW });
  return { channel, other, hot, llm, store, turns, trigger: normalizedTrigger(call) };
}

/** Makes the fixture channel `channel` a text channel listed in its own guild, as a main channel must be. */
function registerTextChannel(channel) {
  channel.isTextBased = () => true;
  channel.isThread = () => false;
  channel.guild.channels.cache.set(channel.id, channel);
  return channel;
}

/** A describer like pullDescriber whose cache read throws (a corrupt media cache). */
function throwingCacheDescriber() {
  return {
    ...pullDescriber(),
    cachedDescriptions: () => {
      throw new Error('fixture: corrupt media cache');
    },
  };
}

/** A store like fakeStore whose ring of calls (`state.json` `elsewherePings`) cannot be read. */
function unreadableRingStore() {
  const store = fakeStore();
  Object.defineProperty(store.state.data, 'elsewherePings', {
    get() {
      throw new Error('fixture: unreadable state');
    },
  });
  return store;
}

/** The `<channel_view>` body of the first request, or null when the request has none. */
function channelViewOf(llm) {
  const text = userText(llm);
  return text.includes('<channel_view>') ? text.split('<channel_view>\n')[1].split('\n</channel_view>')[0] : null;
}

/** A describer with an empty cache whose describeMany captions every item, recording each call in `calls` and `events`. */
function pullDescriber(events = []) {
  const calls = [];
  return {
    calls,
    events,
    cachedDescriptions: () => new Map(),
    describeMany: async (guildId, items, options) => {
      const ids = items.map((item) => item.itemId);
      calls.push({ ids, options });
      events.push(`describe:${ids.join(',')}`);
      return { descriptions: new Map(items.map((item) => [item.itemId, `caption of ${item.itemId}`])), newCount: items.length };
    },
  };
}

/** The describeMany calls that asked for item `itemId`. */
function callsFor(describer, itemId) {
  return describer.calls.filter((call) => call.ids.includes(itemId));
}

test('runTurn: an explicit channel mention in the last scanMessages pulls that channel', async () => {
  const { turns, channel, other, llm, trigger } = pullScene();

  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(llm);
  assert.ok(view, 'the request carries <channel_view>');
  assert.ok(view.includes('channel #diary'), view);
  assert.ok(view.includes('σήμερα έβαψα τον τοίχο μπλε') && view.includes('και μετά κοιμήθηκα'), view);
  assert.ok(view.includes('#3 ') && view.includes('#4 '), 'the pulled lines are numbered on after the chat');
  assert.equal(other.fetches.length, 1, 'one page of the pulled channel');

  // A mention older than the scanned span pulls nothing.
  const filler = lineIn('c1', { id: 'm5', authorId: 'u2', authorName: 'Bob', ts: NOW - 4 * MINUTE, content: 'τέλος πάντων' });
  const older = pullScene({ context: { pull: { scanMessages: 1 } }, between: [filler] });
  await withCapturedLogs(() => older.turns.runTurn({ channel: older.channel, mode: 'reply', trigger: older.trigger, triggerKind: 'mention' }));
  assert.equal(channelViewOf(older.llm), null);
  assert.equal(older.other.fetches.length, 0);
});

test('runTurn: a channel mention in the trigger itself pulls that channel', async () => {
  const { turns, channel, llm, trigger } = pullScene({ mention: false });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: { ...trigger, mentionedChannelIds: [DIARY] }, triggerKind: 'mention' }));

  assert.ok(channelViewOf(llm)?.includes('σήμερα έβαψα τον τοίχο μπλε'));
});

test('runTurn: a spontaneous turn pulls a channel mentioned in its history', async () => {
  const describer = pullDescriber();
  const { turns, channel, llm } = pullScene({ features: { mediaDescriptions: true }, describer });
  const seen = [];

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'auto',
      chooseMode: (history, now, context) => {
        seen.push({ pulled: context.pulled, describeCalls: describer.calls.length });
        return 'interject';
      },
    }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.ok(channelViewOf(llm)?.includes('και μετά κοιμήθηκα'));
  // The mention is pulled before the mode is chosen, and the chooser sees it.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].pulled.map((entry) => [entry.channelId, entry.reason]), [[DIARY, 'mention']]);
  assert.equal(seen[0].describeCalls, 0, 'no caption was asked before the chooser chose');
});

test('runTurn: features.channelPull off pulls nothing for a mention and builds the request as without the channel', async () => {
  const off = pullScene({ features: { channelPull: false } });
  const { logs } = await withCapturedLogs(() => off.turns.runTurn({ channel: off.channel, mode: 'reply', trigger: off.trigger, triggerKind: 'mention' }));

  assert.equal(off.other.fetches.length, 0, 'the mentioned channel is never fetched');
  assert.equal(channelViewOf(off.llm), null);
  assert.equal(logs.some((l) => l.msg.startsWith('pull: ')), false);

  // The same scene with no mention at all: byte for byte the same request.
  const plain = pullScene({ features: { channelPull: false }, mention: false });
  await withCapturedLogs(() => plain.turns.runTurn({ channel: plain.channel, mode: 'reply', trigger: plain.trigger, triggerKind: 'mention' }));
  assert.deepEqual(off.llm.calls[0], plain.llm.calls[0]);
});

test('runTurn: with nothing to pull the request is the one built without the pull machinery', async () => {
  const hook = [];
  const none = pullScene({ mention: false, routeChannels: async (args) => (hook.push(args), []) });
  const off = pullScene({ mention: false, features: { channelPull: false } });

  const { logs } = await withCapturedLogs(() => none.turns.runTurn({ channel: none.channel, mode: 'reply', trigger: none.trigger, triggerKind: 'mention' }));
  await withCapturedLogs(() => off.turns.runTurn({ channel: off.channel, mode: 'reply', trigger: off.trigger, triggerKind: 'mention' }));

  assert.equal(hook.length, 1, 'the hook was asked');
  assert.deepEqual(none.llm.calls[0], off.llm.calls[0]);
  assert.equal(logs.some((l) => l.msg.startsWith('pull: ')), false);
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.equal('source' in answered || 'pulled' in answered || 'focus' in answered, false, 'no pull fields on an ordinary turn');
});

test('runTurn: route hook ids are pulled after explicit mentions', async () => {
  const hookCalls = [];
  const scene = pullScene({
    context: { pull: { maxChannels: 2 } },
    routeChannels: async (args) => {
      hookCalls.push(args);
      return [NOTES, DIARY];
    },
  });
  addChannel(scene.channel, {
    id: NOTES,
    name: 'notes',
    messages: [lineIn(NOTES, { id: 'n1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 2 * HOUR, content: 'σημειώσεις για αύριο' })],
  });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(hookCalls.length, 1);
  const args = hookCalls[0];
  assert.equal(args.guildId, 'g1');
  assert.equal(args.channel, scene.channel);
  assert.equal(args.trigger, scene.trigger);
  assert.equal(args.selfName, 'Bot');
  assert.equal(args.config, scene.hot.config);
  assert.equal(args.triggerKind, 'mention');
  assert.deepEqual(args.history.map((m) => m.id), ['m1', 'm9']);
  const view = channelViewOf(scene.llm);
  assert.ok(view.indexOf('channel #diary') < view.indexOf('channel #notes'), view);
  assert.ok(view.includes('σημειώσεις για αύριο'));
});

test('runTurn: the route hook is told the turn\'s trigger kind, null on a turn without a trigger', async () => {
  const kinds = [];
  const hook = async (args) => (kinds.push(args.triggerKind), []);
  const followUp = pullScene({ mention: false, routeChannels: hook });
  await withCapturedLogs(() => followUp.turns.runTurn({ channel: followUp.channel, mode: 'reply', trigger: followUp.trigger, triggerKind: 'followUp' }));
  const spontaneous = pullScene({ mention: false, routeChannels: hook });
  await withCapturedLogs(() => spontaneous.turns.runTurn({ channel: spontaneous.channel, mode: 'interject' }));
  assert.deepEqual(kinds, ['followUp', null]);
});

test('runTurn: the route hook is not asked once the mentions fill every slot, nor while features.channelPull is off', async () => {
  for (const features of [{}, { channelPull: false }]) {
    let asked = 0;
    const scene = pullScene({
      features,
      routeChannels: async () => {
        asked += 1;
        return [];
      },
    });
    await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    assert.equal(asked, 0, JSON.stringify(features));
  }
});

test('runTurn: context.pull.maxChannels caps the pulled channels, the newest mention first', async () => {
  const newer = lineIn('c1', { id: 'm5', authorId: 'u2', authorName: 'Bob', ts: NOW - 4 * MINUTE, content: 'και το #notes', raw: `και το <#${NOTES}>` });
  const scene = pullScene({ between: [newer] });
  const notes = addChannel(scene.channel, {
    id: NOTES,
    name: 'notes',
    messages: [lineIn(NOTES, { id: 'n1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 2 * HOUR, content: 'σημειώσεις για αύριο' })],
  });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('channel #notes') && !view.includes('channel #diary'), view);
  assert.equal(scene.other.fetches.length, 0);
  assert.equal(notes.fetches.length, 1);
});

test('runTurn: a pulled channel is left out of the neighbours', async () => {
  const diary = { messages: diaryLines(10 * MINUTE) };
  const pulled = pullScene({ diary });
  await withCapturedLogs(() => pulled.turns.runTurn({ channel: pulled.channel, mode: 'reply', trigger: pulled.trigger, triggerKind: 'mention' }));

  assert.ok(channelViewOf(pulled.llm)?.includes('σήμερα έβαψα τον τοίχο μπλε'));
  assert.equal(userText(pulled.llm).includes('# diary'), false, 'not shown again among the neighbours');

  // Not pulled, the same channel is an ordinary neighbour.
  const neighbour = pullScene({ diary, features: { channelPull: false } });
  await withCapturedLogs(() => neighbour.turns.runTurn({ channel: neighbour.channel, mode: 'reply', trigger: neighbour.trigger, triggerKind: 'mention' }));
  assert.ok(otherChannelsSent(neighbour.llm).includes('# diary'));
});

test('runTurn: a noticed turn passes the pulled source to chooseMode', async () => {
  const seen = [];
  const { turns, channel, llm } = pullScene({ mention: false });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'auto',
      source: { channelId: DIARY, reason: 'noticed' },
      chooseMode: (history, now, context) => {
        seen.push({ history, now, context });
        return null;
      },
    }),
  );

  assert.equal(result.outcome, 'not-now');
  assert.equal(llm.calls.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].now, NOW);
  assert.deepEqual(seen[0].history.map((m) => m.id), ['m1', 'm9'], "the chooser still gets the turn channel's history");
  const [source] = seen[0].context.pulled;
  assert.equal(seen[0].context.pulled.length, 1);
  assert.equal(source.channelId, DIARY);
  assert.equal(source.reason, 'noticed');
  assert.deepEqual(source.messages.map((m) => m.id), ['d1', 'd2']);
});

test('runTurn: a routed turn whose source cannot be pulled ends in error, a noticed one in not-now', async () => {
  for (const [reason, outcome] of [['routed', 'error'], ['noticed', 'not-now']]) {
    const { turns, channel, llm } = pullScene({ mention: false });
    let chosen = 0;
    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({
        channel,
        mode: reason === 'routed' ? 'reply' : 'auto',
        source: { channelId: 'c9', reason },
        chooseMode: () => {
          chosen += 1;
          return 'elsewhere';
        },
      }),
    );

    assert.equal(result.outcome, outcome, reason);
    assert.equal(llm.calls.length, 0, reason);
    assert.equal(chosen, 0, `${reason}: no chooser without the source`);
    assert.equal(turns.isBusy('c1'), false);
    assert.ok(logs.some((l) => l.msg === 'pull: skipped' && l.source === 'c9' && l.reason === 'not-found'), reason);
    const unavailable = logs.find((l) => l.msg === 'turn: source unavailable');
    if (reason === 'routed') assert.deepEqual([unavailable.channel, unavailable.source, unavailable.reason], ['c1', 'c9', 'not-found']);
    else assert.equal(unavailable, undefined);
  }
});

test('runTurn: fresh captions for a pulled channel are asked only once the turn is certain to run', async () => {
  // A chooser that says not-now: nothing is asked, the cache alone was read.
  const quiet = pullDescriber();
  const notNow = pullScene({ features: { mediaDescriptions: true }, describer: quiet });
  const { result } = await withCapturedLogs(() => notNow.turns.runTurn({ channel: notNow.channel, mode: 'auto', chooseMode: () => null }));
  assert.equal(result.outcome, 'not-now');
  assert.equal(quiet.calls.length, 0);

  // A chooser that picks a mode: the caption is asked after it chose, and reaches the block.
  const events = [];
  const chosen = pullDescriber(events);
  const live = pullScene({ features: { mediaDescriptions: true }, describer: chosen });
  await withCapturedLogs(() =>
    live.turns.runTurn({
      channel: live.channel,
      mode: 'auto',
      chooseMode: () => {
        events.push('chooser');
        return 'interject';
      },
    }),
  );
  assert.deepEqual(callsFor(chosen, 'dp1').map((call) => call.options), [{ maxNew: 1 }]);
  assert.ok(events.indexOf('chooser') < events.indexOf('describe:dp1'), events.join(' '));
  assert.ok(channelViewOf(live.llm).includes('caption of dp1'));

  // No chooser at all: asked with the fetch, once.
  const direct = pullDescriber();
  const reply = pullScene({ features: { mediaDescriptions: true }, describer: direct });
  await withCapturedLogs(() => reply.turns.runTurn({ channel: reply.channel, mode: 'reply', trigger: reply.trigger, triggerKind: 'mention' }));
  assert.equal(callsFor(direct, 'dp1').length, 1);
  assert.ok(channelViewOf(reply.llm).includes('caption of dp1'));
});

test('runTurn: a failed, refused or throwing pull never fails the turn', async () => {
  const failing = pullScene({ diary: { fetchFails: true } });
  const failed = await withCapturedLogs(() => failing.turns.runTurn({ channel: failing.channel, mode: 'reply', trigger: failing.trigger, triggerKind: 'mention' }));
  assert.equal(failed.result.outcome, 'spoke');
  assert.equal(channelViewOf(failing.llm), null);
  assert.ok(failed.logs.some((l) => l.msg === 'pull: skipped' && l.source === DIARY && l.reason === 'fetch-failed'));

  const denied = pullScene({ bot: { channels: { deny: [DIARY] } } });
  const refused = await withCapturedLogs(() => denied.turns.runTurn({ channel: denied.channel, mode: 'reply', trigger: denied.trigger, triggerKind: 'mention' }));
  assert.equal(refused.result.outcome, 'spoke');
  assert.equal(denied.other.fetches.length, 0, 'a refused channel is never fetched');
  const skipped = refused.logs.find((l) => l.msg === 'pull: skipped');
  assert.deepEqual([skipped.channel, skipped.source, skipped.reason, skipped.pullReason], ['c1', DIARY, 'denied', 'mention']);

  const throwing = pullScene({
    mention: false,
    routeChannels: async () => {
      throw new Error('fixture: route classifier down');
    },
  });
  const thrown = await withCapturedLogs(() => throwing.turns.runTurn({ channel: throwing.channel, mode: 'reply', trigger: throwing.trigger, triggerKind: 'mention' }));
  assert.equal(thrown.result.outcome, 'spoke');
  assert.ok(thrown.logs.some((l) => l.msg === 'pull: route failed' && l.channel === 'c1'));
});

test('runTurn: a private chat never pulls a channel', async () => {
  let asked = 0;
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = sequenceLlm(['<msg>hi</msg>']);
  const turns = createTurnRunner({
    hot: privateHot(),
    store: privateStore(),
    llm,
    calibrator: identityCalibrator(),
    client: guildClient(),
    images: fakeImages(),
    routeChannels: async () => {
      asked += 1;
      return [DIARY];
    },
  });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, guildId: 'g1', mode: 'reply', trigger: { ...normalizedTrigger(raw), mentionedChannelIds: [DIARY] }, triggerKind: 'private' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(asked, 0);
  assert.equal(userTextOf(llm.calls[0]).includes('<channel_view>'), false);
  assert.equal(logs.some((l) => l.msg.startsWith('pull: ')), false);
});

/**
 * A call to the persona in the read-only #diary (c2), answered in #general (c1): the source holds
 * the diary lines, `before`, Alice's call and `after`; #general holds one line by Bob.
 */
function routedScene({
  features = {},
  hot = fakeHot(features),
  describer,
  llm = fakeLlm('<msg>ok</msg>'),
  lookup,
  callAttachments,
  chat = [lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'καλημέρα σε όλους' })],
  callTs = NOW - 2 * MINUTE,
  before = [],
  after = [],
  routeChannels,
  store = fakeStore(),
  client = fakeClient(),
  images,
  variety,
} = {}) {
  const channel = fakeTurnChannel({ historyMessages: chat });
  const call = lineIn(DIARY, { id: 'd3', ts: callTs, content: '@Bot τι λες για τον τοίχο;', attachments: callAttachments });
  const other = addChannel(channel, { id: DIARY, name: 'diary', messages: [...diaryLines(), ...before, call, ...after], readOnly: true });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client, describer, lookup, routeChannels, images, variety, imageFetcher: fakeImageFetcher(), now: () => NOW });
  const trigger = { ...normalizedTrigger(call), mentionedUserIds: ['self-id'] };
  const params = { channel, mode: 'reply', trigger, triggerKind: 'mention', source: { channelId: DIARY, reason: 'routed' } };
  return { channel, other, hot, llm, store, turns, trigger, params };
}

/** Makes #general (c1) the scene's main channel: `memory.mainChannelIds` and a usable text channel. */
function asMainChannel(scene) {
  registerTextChannel(scene.channel);
  scene.hot.config.memory = { ...scene.hot.config.memory, mainChannelIds: ['c1'] };
  return scene;
}

test('runTurn: a routed turn pulls its source with the call and builds the request in the destination', async () => {
  const scene = asMainChannel(routedScene());

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('@Bot τι λες για τον τοίχο;') && view.includes('σήμερα έβαψα τον τοίχο μπλε'), view);
  assert.ok(view.includes(labels.server.readOnly), 'the source is marked read-only');
  // The request knows the turn's source: the task says where the call came from and where the words go.
  assert.ok(userText(scene.llm).includes(fill(labels.elsewhere.called, { channel: 'diary', destination: 'general' })));
  const pulled = logs.find((l) => l.msg === 'pull: channel');
  assert.deepEqual([pulled.channel, pulled.source, pulled.pullReason], ['c1', DIARY, 'routed']);
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.deepEqual([answered.channel, answered.source, answered.pulled], ['c1', DIARY, 1]);
  assert.equal(answered.budget.pulled.kept, 1, 'the pulled block is in the budget');
  assert.equal('focus' in answered, false);
});

test('runTurn: a routed call older than the window is still shown with its source', async () => {
  // Five newer lines fill the window; the call, three hours old, is outside it.
  const after = [0, 1, 2, 3, 4].map((i) =>
    lineIn(DIARY, { id: `d${4 + i}`, authorId: 'u4', authorName: 'Zoë', ts: NOW - 30 * MINUTE + i * MINUTE, content: `γραμμή ${i + 1} για τον κήπο` }),
  );
  const scene = routedScene({ callTs: NOW - 3 * HOUR + 2 * MINUTE, after });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('γραμμή 5 για τον κήπο'), view);
  assert.ok(view.includes('@Bot τι λες για τον τοίχο;'), 'the call is shown although the window left it out');
  assert.equal(view.includes('σήμερα έβαψα τον τοίχο μπλε'), false, 'the older lines stay out of the window');
});

test("runTurn: a pulled channel shows the ring's earlier unanswered call with its mark", async () => {
  const earlier = lineIn(DIARY, { id: 'd0', authorId: 'u4', authorName: 'Zoë', ts: NOW - 5 * HOUR, content: '@Bot είσαι εδώ;' });
  const diary = { messages: [earlier, ...diaryLines()] };
  const context = { pull: { minMessages: 1 } };
  const earlierHeader = labels.pull.earlierPings.split('{date}')[0];

  const store = fakeStore();
  store.state.data.elsewherePings = [{ messageId: 'd0', channelId: DIARY, ts: NOW - 5 * HOUR, answeredAt: null, skippedAt: null }];
  const ringed = pullScene({ store, context, diary });
  await withCapturedLogs(() => ringed.turns.runTurn({ channel: ringed.channel, mode: 'reply', trigger: ringed.trigger, triggerKind: 'mention' }));
  const view = channelViewOf(ringed.llm);
  assert.ok(view.includes('@Bot είσαι εδώ;'), view);
  assert.ok(view.includes(earlierHeader), view);
  assert.ok(view.includes(labels.pull.pingUnanswered), view);

  // Without the ring entry the old line is outside the window and nothing is marked.
  const plain = pullScene({ context, diary });
  await withCapturedLogs(() => plain.turns.runTurn({ channel: plain.channel, mode: 'reply', trigger: plain.trigger, triggerKind: 'mention' }));
  const plainView = channelViewOf(plain.llm);
  assert.equal(plainView.includes('@Bot είσαι εδώ;') || plainView.includes(earlierHeader) || plainView.includes(labels.pull.pingUnanswered), false, plainView);
});

test("runTurn: on a routed turn the search classifier reads the source channel's lines", async () => {
  const llm = lookupLlm('none');
  const scene = routedScene({ hot: lookupHot(), llm, lookup: fakeLookup() });

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(llm.classifierCalls.length, 1);
  const user = llm.classifierCalls[0].messages[1].content;
  assert.ok(user.includes('σήμερα έβαψα τον τοίχο μπλε'), user);
  assert.ok(!user.includes('καλημέρα σε όλους'), "the destination's chat is not the call's context");
  assert.ok(user.includes('<candidate>\nAlice: @Bot τι λες για τον τοίχο;'), user);
});

test("runTurn: a routed call's pictures are captioned through the pull, never as the chat's attached pictures", async () => {
  const photo = { id: 'cp1', contentType: 'image/png', name: 'photo.png', url: 'https://cdn.discordapp.com/x/photo.png' };
  const describer = pullDescriber();
  const scene = routedScene({ features: { mediaDescriptions: true }, describer, callAttachments: new Map([['cp1', photo]]) });
  scene.params.trigger = { ...scene.params.trigger, attachments: [{ id: 'cp1', kind: 'image', url: photo.url, name: 'photo.png' }] };

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.deepEqual(callsFor(describer, 'cp1').map((call) => call.options), [{ maxNew: 1 }]);
  assert.equal(Array.isArray(scene.llm.calls[0][1].content), false, 'nothing is attached for vision');
  assert.ok(channelViewOf(scene.llm).includes('caption of cp1'));
});

test('runTurn: a focus line reaches the task and the log', async () => {
  const { turns, channel, llm } = pullScene({ mention: false });
  const focus = normalizedTrigger(lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'είδες το #diary;' }));

  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'interject', focus }));

  assert.ok(userText(llm).includes(fill(labels.room.focus, { author: 'Bob', target: '#1' })));
  assert.equal(logs.find((l) => l.msg === 'turn: model answered').focus, true);
});

test('runTurn: a read-only neighbour is marked in the server map', async () => {
  const store = fakeStore({ channels: [{ id: DIARY, name: 'diary', lastMessageAt: NOW - 10 * MINUTE, days: {} }] });
  for (const readOnly of [true, false]) {
    const scene = pullScene({ features: { channelPull: false }, diary: { messages: diaryLines(10 * MINUTE), readOnly }, store });
    await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    const server = userText(scene.llm).split('<server>\n')[1].split('\n</server>')[0];
    assert.ok(server.includes('diary'), server);
    assert.equal(server.includes(labels.server.readOnly), readOnly, server);
  }
});

test('runTurn: senses name the main channel where calls from read-only channels are answered', async () => {
  for (const [features, expected] of [[{}, true], [{ elsewhere: false }, false]]) {
    const scene = pullScene({ mention: false, features, config: { memory: { mainChannelIds: ['c1'] } } });
    registerTextChannel(scene.channel);
    await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    assert.equal(userText(scene.llm).includes(fill(labels.senses.elsewhere, { destination: 'general' })), expected, JSON.stringify(features));
  }
});

test('runTurn: senses name only a usable main channel, the first one in list order', async () => {
  const sensesPrefix = labels.senses.elsewhere.split('{destination}')[0];
  const cases = [
    { name: 'cannot send', main: ['c5'], add: (scene) => addChannel(scene.channel, { id: 'c5', name: 'lounge', readOnly: true }), expected: null },
    { name: 'thread', main: ['c5'], add: (scene) => Object.assign(addChannel(scene.channel, { id: 'c5', name: 'lounge' }), { isThread: () => true }), expected: null },
    { name: 'denied', main: ['c5'], bot: { channels: { deny: ['c5'] } }, add: (scene) => addChannel(scene.channel, { id: 'c5', name: 'lounge' }), expected: null },
    {
      name: 'first usable',
      main: ['c5', 'c6'],
      add: (scene) => {
        addChannel(scene.channel, { id: 'c5', name: 'lounge', readOnly: true });
        addChannel(scene.channel, { id: 'c6', name: 'hall' });
      },
      expected: 'hall',
    },
  ];
  for (const { name, main, bot = {}, add, expected } of cases) {
    const scene = pullScene({ mention: false, bot, config: { memory: { mainChannelIds: main } } });
    add(scene);
    await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    const text = userText(scene.llm);
    if (expected) assert.ok(text.includes(fill(labels.senses.elsewhere, { destination: expected })), name);
    else assert.equal(text.includes(sensesPrefix), false, name);
  }
});

test('usableDestination: the first usable main channel, never the excepted one; off and none carry their codes', () => {
  const general = registerTextChannel(fakeTurnChannel());
  const hall = addChannel(general, { id: 'c6', name: 'hall' });
  const config = { bot: {}, features: {}, memory: { mainChannelIds: ['c1', 'c6'] } };

  assert.deepEqual(usableDestination(general.guild, config), { channel: general, reason: null });
  assert.deepEqual(usableDestination(general.guild, config, { exceptId: 'c1' }), { channel: hall, reason: null });
  assert.deepEqual(usableDestination(general.guild, { ...config, features: { elsewhere: false } }), { channel: null, reason: 'off' });
  assert.deepEqual(usableDestination(general.guild, { ...config, memory: { mainChannelIds: [] } }), { channel: null, reason: 'no-destination' });
  assert.deepEqual(usableDestination(null, config), { channel: null, reason: 'no-destination' }, 'a private chat has none');
});

test("runTurn: on a routed turn the re-watch classifier is not asked about the destination's videos", async () => {
  // #general holds a watched clip and one that did not load; the call in #diary asks to try again.
  const chat = () => [videoAttachmentRaw('m1', NOW - 10 * MINUTE, 'va', 'clip.mp4'), videoAttachmentRaw('m2', NOW - 8 * MINUTE, 'vb', 'other.mp4')];
  const scene = (llm, describer) => routedScene({ hot: rewatchHot(), llm, describer, chat: chat() });
  const states = { va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' }, vb: { state: 'error' } };

  const llm = rewatchLlm('1 | retry');
  const describer = fakeRetryDescriber(states);
  const routed = scene(llm, describer);
  const { result, logs } = await withCapturedLogs(() => routed.turns.runTurn(routed.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.classifierCalls.length, 0, 'no re-watch classifier request');
  assert.equal(describer.retryCalls.length + describer.rewatchCalls.length, 0, 'nothing watched again');
  const skipped = logs.find((l) => l.msg === 'rewatch: skipped');
  assert.deepEqual([skipped.channel, skipped.reason], ['c1', 'routed']);

  // The same call without its source (an ordinary turn here) is offered the videos.
  const controlLlm = rewatchLlm('1 | retry');
  const control = scene(controlLlm, fakeRetryDescriber(states));
  await withCapturedLogs(() => control.turns.runTurn({ ...control.params, source: null }));
  assert.equal(controlLlm.classifierCalls.length, 1);
});

test("runTurn: on a routed turn the route hook reads the source channel's lines", async () => {
  const hookCalls = [];
  const scene = routedScene({
    routeChannels: async (args) => {
      hookCalls.push(args);
      return [];
    },
  });
  scene.hot.config.context.pull = { maxChannels: 2 };

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].channel, scene.channel, 'asked for the destination');
  assert.deepEqual(hookCalls[0].history.map((m) => m.id), ['d1', 'd2', 'd3'], "the call's channel, not the destination's chat");
});

test('runTurn: a route hook id that is refused logs its pull reason', async () => {
  const scene = pullScene({ mention: false, bot: { channels: { deny: [DIARY] } }, routeChannels: async () => [DIARY] });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  assert.equal(scene.other.fetches.length, 0);
  const skipped = logs.find((l) => l.msg === 'pull: skipped');
  assert.deepEqual([skipped.channel, skipped.source, skipped.reason, skipped.pullReason], ['c1', DIARY, 'denied', 'route']);
});

test('runTurn: the drawFailed turn after a pull asks neither the route hook nor a fresh caption again', async () => {
  let asked = 0;
  const describer = pullDescriber();
  const scene = pullScene({
    features: { mediaDescriptions: true, typingSimulation: false },
    context: { pull: { maxChannels: 2 } },
    config: { image: { ...DRAW_IMAGE_CFG } },
    describer,
    images: fakeImages({ error: new ImageGenError('moderation') }),
    llm: sequenceLlm(['<msg>on it</msg><draw>a blue wall</draw>', '<msg>it did not work</msg>']),
    routeChannels: async () => {
      asked += 1;
      return [];
    },
  });
  scene.hot.prompts.draw = 'Drawing for {{name}}.\n\n{{request}}';

  const { result } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.drawFailed, 'moderation');
  assert.equal(scene.llm.calls.length, 2, 'the drawFailed turn ran');
  assert.equal(asked, 1, 'the hook is asked for the first turn only');
  assert.equal(callsFor(describer, 'dp1').length, 1, 'the pulled picture is described once');
  assert.equal(describer.calls.filter((call) => call.options?.maxNew === 1).length, 1, 'no other fresh caption request');
  assert.ok(userTextOf(scene.llm.calls[1]).includes('σήμερα έβαψα τον τοίχο μπλε'), 'the second turn still shows the channel');
});

test('runTurn: a pull that throws never fails an ordinary turn; a routed one ends in error, a noticed one in not-now', async () => {
  // A corrupt media cache throws inside fetchPull; an unreadable ring throws before any fetch.
  // `perChannel`: the failure is caught for its channel alone (the log names it and why it was pulled).
  const scenes = [
    ['fetchPull throws', (options) => ({ ...options, features: { mediaDescriptions: true }, describer: throwingCacheDescriber() }), true],
    ['the pull itself throws', (options) => ({ ...options, store: unreadableRingStore() }), false],
  ];
  const failedLine = (logs, pullReason, perChannel) =>
    logs.find((l) => l.msg === 'pull: failed' && l.channel === 'c1' && (perChannel ? l.source === DIARY && l.pullReason === pullReason : l.source === undefined));
  for (const [name, withFailure, perChannel] of scenes) {
    const ordinary = pullScene(withFailure({}));
    const plain = await withCapturedLogs(() => ordinary.turns.runTurn({ channel: ordinary.channel, mode: 'reply', trigger: ordinary.trigger, triggerKind: 'mention' }));
    assert.equal(plain.result.outcome, 'spoke', name);
    assert.equal(channelViewOf(ordinary.llm), null, name);
    assert.ok(failedLine(plain.logs, 'mention', perChannel), name);

    const routed = routedScene(withFailure({}));
    const call = await withCapturedLogs(() => routed.turns.runTurn(routed.params));
    assert.equal(call.result.outcome, 'error', name);
    assert.equal(routed.llm.calls.length, 0, name);
    assert.ok(failedLine(call.logs, 'routed', perChannel), name);
    const unavailable = call.logs.find((l) => l.msg === 'turn: source unavailable');
    assert.deepEqual([unavailable.channel, unavailable.source, unavailable.reason], ['c1', DIARY, 'error'], name);

    const noticed = pullScene(withFailure({ mention: false }));
    let chosen = 0;
    const comment = await withCapturedLogs(() =>
      noticed.turns.runTurn({
        channel: noticed.channel,
        mode: 'auto',
        source: { channelId: DIARY, reason: 'noticed' },
        chooseMode: () => {
          chosen += 1;
          return 'interject';
        },
      }),
    );
    assert.equal(comment.result.outcome, 'not-now', name);
    assert.equal(chosen, 0, name);
    assert.ok(failedLine(comment.logs, 'noticed', perChannel), name);
    assert.equal(comment.logs.some((l) => l.msg === 'turn: source unavailable'), false, name);
  }
});

test('runTurn: a pulled channel whose fetch throws costs only that channel', async () => {
  // #diary has a picture and the cache read throws for it; #notes has none and is pulled.
  const newer = lineIn('c1', { id: 'm5', authorId: 'u2', authorName: 'Bob', ts: NOW - 4 * MINUTE, content: 'και το #notes', raw: `και το <#${NOTES}>` });
  const describer = {
    ...pullDescriber(),
    cachedDescriptions: (guildId, items) => {
      if (items.some((item) => item.itemId === 'dp1')) throw new Error('fixture: corrupt media cache');
      return new Map();
    },
  };
  const scene = pullScene({ features: { mediaDescriptions: true }, describer, context: { pull: { maxChannels: 2 } }, between: [newer] });
  addChannel(scene.channel, { id: NOTES, name: 'notes', messages: [lineIn(NOTES, { id: 'n1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 2 * HOUR, content: 'σημειώσεις για αύριο' })] });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('σημειώσεις για αύριο') && !view.includes('σήμερα έβαψα τον τοίχο μπλε'), view);
  const failed = logs.find((l) => l.msg === 'pull: failed');
  assert.deepEqual([failed.channel, failed.source, failed.pullReason], ['c1', DIARY, 'mention']);
});

test('runTurn: fresh captions that fail after a chooser leave the cached ones', async () => {
  const door = { id: 'dp2', contentType: 'image/png', name: 'door.png', url: 'https://cdn.discordapp.com/x/door.png' };
  const [first, second] = diaryLines();
  const messages = [{ ...first, attachments: new Map([['dp2', door]]) }, second];
  let reads = 0;
  const describer = {
    ...pullDescriber(),
    // The fetch finds one caption in the cache; the second read, for the fresh captions, throws.
    cachedDescriptions: () => {
      reads += 1;
      if (reads > 1) throw new Error('fixture: corrupt media cache');
      return new Map([['dp1', 'cached caption of dp1']]);
    },
  };
  const scene = pullScene({ features: { mediaDescriptions: true }, describer, diary: { messages } });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'auto', chooseMode: () => 'interject' }));

  assert.equal(result.outcome, 'spoke');
  assert.equal(reads, 2);
  const failed = logs.find((l) => l.msg === 'pull: captions failed');
  assert.deepEqual([failed.channel, failed.source], ['c1', DIARY]);
  assert.ok(channelViewOf(scene.llm).includes('cached caption of dp1'));
  assert.equal(callsFor(describer, 'dp2').length, 0, 'no fresh caption was asked');
});

test('runTurn: a pull candidate whose check throws is left out, and a routed turn keeps its source', async () => {
  const named = lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'και το #notes', raw: `και το <#${NOTES}>` });
  const scene = routedScene({ chat: [named] });
  scene.hot.config.context.pull = { maxChannels: 2 };
  const notes = addChannel(scene.channel, { id: NOTES, name: 'notes', messages: [lineIn(NOTES, { id: 'n1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 2 * HOUR, content: 'σημειώσεις για αύριο' })] });
  Object.defineProperty(notes, 'permissionOverwrites', {
    get() {
      throw new Error('fixture: broken channel');
    },
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('@Bot τι λες για τον τοίχο;') && !view.includes('σημειώσεις για αύριο'), view);
  assert.equal(notes.fetches.length, 0);
  const failed = logs.find((l) => l.msg === 'pull: failed');
  assert.deepEqual([failed.channel, failed.source, failed.pullReason], ['c1', NOTES, 'mention']);
  assert.equal(logs.some((l) => l.msg === 'pull: skipped' && l.source === NOTES), false, 'logged once, as a failure');
  assert.equal(logs.some((l) => l.msg === 'turn: source unavailable'), false);
});

test('runTurn: without labels.pull.header only the source is pulled, with cached captions only', async () => {
  const { pull, ...unlabelled } = labels;
  assert.ok(pull.header, 'the fixture has the label the live layer lacks here');

  // A mention and a route hook: nothing is fetched or asked, one no-label line.
  let asked = 0;
  const describer = pullDescriber();
  const mention = pullScene({
    features: { mediaDescriptions: true },
    context: { pull: { maxChannels: 2 } },
    describer,
    routeChannels: async () => {
      asked += 1;
      return [NOTES];
    },
  });
  mention.hot.prompts.labels = unlabelled;
  const plain = await withCapturedLogs(() => mention.turns.runTurn({ channel: mention.channel, mode: 'reply', trigger: mention.trigger, triggerKind: 'mention' }));
  assert.equal(plain.result.outcome, 'spoke');
  assert.equal(mention.other.fetches.length, 0);
  assert.equal(asked, 0);
  assert.equal(callsFor(describer, 'dp1').length, 0);
  assert.deepEqual(plain.logs.filter((l) => l.msg.startsWith('pull: ')).map((l) => [l.msg, l.channel, l.reason]), [['pull: skipped', 'c1', 'no-label']]);

  // A routed turn: its source is pulled, no fresh caption is asked.
  const routedDescriber = pullDescriber();
  const routed = routedScene({ features: { mediaDescriptions: true }, describer: routedDescriber });
  routed.hot.prompts.labels = unlabelled;
  const call = await withCapturedLogs(() => routed.turns.runTurn(routed.params));
  assert.equal(call.result.outcome, 'spoke');
  assert.ok(call.logs.some((l) => l.msg === 'pull: channel' && l.source === DIARY));
  assert.equal(callsFor(routedDescriber, 'dp1').length, 0);

  // A noticed turn whose chooser picks a mode: no fresh caption after it either.
  const noticedDescriber = pullDescriber();
  const noticed = pullScene({ mention: false, features: { mediaDescriptions: true }, describer: noticedDescriber });
  noticed.hot.prompts.labels = unlabelled;
  const comment = await withCapturedLogs(() =>
    noticed.turns.runTurn({ channel: noticed.channel, mode: 'auto', source: { channelId: DIARY, reason: 'noticed' }, chooseMode: () => 'interject' }),
  );
  assert.equal(comment.result.outcome, 'spoke');
  assert.equal(callsFor(noticedDescriber, 'dp1').length, 0);
  assert.equal(comment.logs.some((l) => l.msg === 'pull: captions'), false);

  // Nothing to pull: no line at all.
  const quiet = pullScene({ mention: false });
  quiet.hot.prompts.labels = unlabelled;
  const none = await withCapturedLogs(() => quiet.turns.runTurn({ channel: quiet.channel, mode: 'reply', trigger: quiet.trigger, triggerKind: 'mention' }));
  assert.equal(none.logs.some((l) => l.msg.startsWith('pull: ')), false);
});

// --- another channel pulled into a turn (<channel_view>): the outputs ---------------------------
// In pullScene the chat is #1 m1 (Bob), #2 m9 (Alice, the trigger) and the diary #3 d1, #4 d2;
// in routedScene the chat is #1 m1 (Bob) and the diary #2 d1, #3 d2, #4 d3 (the call).

/** Discord's jump link to a diary line of the fixture guild g1. */
function diaryLink(messageId) {
  return `https://discord.com/channels/g1/${DIARY}/${messageId}`;
}

/** `text` with the jump link to diary line `messageId`, joined through the fixture's labels.elsewhere.link. */
function linked(text, messageId) {
  return fill(labels.elsewhere.link, { text, link: diaryLink(messageId) });
}

/** A client whose dry-run mirror channel records every post in `mirrored`. */
function mirrorClient(mirrored) {
  return fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrored.push(payload) }) } });
}

/** Lets the bot read `channel` but not put a reaction there. */
function denyReactions(channel) {
  channel.permissionsFor = () => ({ has: (flag) => flag !== PermissionFlagsBits.AddReactions });
}

test('runTurn: a reaction to a pulled line reacts in the source channel, one to a chat line stays here', async () => {
  const scene = pullScene({ features: { typingSimulation: false }, llm: fakeLlm('<react to="#3">🎉</react><react to="#2">👍</react>') });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.other.reactCalls, [{ id: 'd1', emoji: '🎉' }]);
  assert.deepEqual(scene.channel.reactCalls, [{ id: 'm9', emoji: '👍' }]);
  assert.equal(logs.some((l) => l.msg === 'turn: reaction dropped'), false);
});

test('runTurn: a reaction to a pulled line is dropped where the bot cannot react', async () => {
  const scene = pullScene({ features: { typingSimulation: false }, llm: fakeLlm('<react to="#3">🎉</react><react to="#2">👍</react>') });
  denyReactions(scene.other);

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  assert.ok(channelViewOf(scene.llm), 'the channel is still shown');
  assert.deepEqual(scene.other.reactCalls, []);
  assert.deepEqual(scene.channel.reactCalls, [{ id: 'm9', emoji: '👍' }], 'a reaction on a chat line is unchanged');
  const dropped = logs.filter((l) => l.msg === 'turn: reaction dropped');
  assert.deepEqual(dropped.map((l) => [l.channel, l.source, l.reason]), [['c1', DIARY, 'cannot-react']]);
});

test('runTurn: a reply to a pulled line posts plain here with one jump link to that line', async () => {
  const scene = pullScene({
    features: { typingSimulation: false },
    llm: fakeLlm('<msg reply="#3">ωραίο μπλε</msg><msg reply="#3">πολύ ωραίο</msg><msg reply="#2">ναι, το είδα</msg>'),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  const [first, second, third] = scene.channel.sent;
  assert.equal(first.content, linked('ωραίο μπλε', 'd1'));
  assert.equal(first.reply, undefined, 'never a Discord reply across channels');
  assert.equal(second.content, 'πολύ ωραίο', 'a second reply to the same line adds no second link');
  assert.equal(second.reply, undefined);
  assert.equal(third.content, 'ναι, το είδα');
  assert.equal(third.reply.messageReference, 'm9', 'a reply to a chat line is unchanged');
  assert.equal(scene.other.sent.length, 0, 'nothing is posted in the pulled channel');
  const sent = logs.filter((l) => l.msg === 'turn: sent');
  assert.deepEqual(sent.map((l) => l.link ?? false), [true, false, false]);
  assert.equal(sent.some((l) => 'source' in l), false, 'a turn without a source logs none');
});

test('runTurn: a routed turn posts in the destination with the link to the call on its first message', async () => {
  const scene = routedScene({
    features: { typingSimulation: false },
    llm: fakeLlm('<msg>καλημέρα</msg><msg reply="#4">ναι, μπλε</msg><msg reply="#2">κι αυτό ωραίο</msg>'),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    scene.channel.sent.map((post) => post.content),
    [linked('καλημέρα', 'd3'), 'ναι, μπλε', linked('κι αυτό ωραίο', 'd1')],
    'the call once, on the first message; another pulled line it answers gets its own',
  );
  assert.ok(scene.channel.sent.every((post) => post.reply === undefined), 'never a Discord reply to the call');
  assert.equal(scene.other.sent.length, 0, 'nothing is posted in the source');
  const sent = logs.filter((l) => l.msg === 'turn: sent');
  assert.deepEqual(sent.map((l) => [l.channel, l.source, l.link ?? false]), [['c1', DIARY, true], ['c1', DIARY, false], ['c1', DIARY, true]]);
});

test('runTurn: a noticed turn links its first message to the newest line of its source shown', async () => {
  const scene = pullScene({ mention: false, features: { typingSimulation: false }, llm: fakeLlm('<msg>τι ωραίο χρώμα</msg>') });

  const { result } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'auto', source: { channelId: DIARY, reason: 'noticed' }, chooseMode: () => 'interject' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.channel.sent.map((post) => [post.content, post.reply]), [[linked('τι ωραίο χρώμα', 'd2'), undefined]]);
});

test('runTurn: @name of a pulled author resolves to a mention', async () => {
  const scene = routedScene({ features: { typingSimulation: false }, llm: fakeLlm('<msg>@Éloïse ωραίος τοίχος</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  const [post] = scene.channel.sent;
  assert.equal(post.content, linked('<@u3> ωραίος τοίχος', 'd3'));
  assert.deepEqual(post.allowedMentions.users, ['u3']);
});

test('runTurn: a picture or a GIF answering a pulled line posts plain with its jump link', async () => {
  const scene = routedScene({ hot: drawHot(), images: fakeImages(), store: gifStore(), llm: fakeLlm('<gif reply="#4">g1</gif><draw reply="#2">a blue wall</draw>') });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const [gif, picture] = scene.channel.sent;
  assert.deepEqual([gif.content, gif.reply], [linked('https://tenor.com/view/chat-qui-danse-1', 'd3'), undefined], 'the media URL first, so it still embeds');
  assert.equal(picture.files.length, 1);
  assert.equal(picture.reply, undefined);
  assert.equal(picture.content, diaryLink('d1'), 'the picture carries the link to the line it answers');
  assert.equal(scene.other.sent.length, 0);
  assert.equal(logs.find((l) => l.msg === 'turn: gif sent').link, true);
  assert.equal(logs.find((l) => l.msg === 'turn: drew').link, true);
});

test('runTurn: a GIF alone answering a routed call links the call; after a message it carries none', async () => {
  const alone = routedScene({ features: { typingSimulation: false }, store: gifStore(), llm: fakeLlm('<gif>g1</gif>') });
  await withCapturedLogs(() => alone.turns.runTurn(alone.params));
  assert.deepEqual(alone.channel.sent.map((post) => [post.content, post.reply]), [[linked('https://tenor.com/view/chat-qui-danse-1', 'd3'), undefined]]);

  const after = routedScene({ features: { typingSimulation: false }, store: gifStore(), llm: fakeLlm('<msg>κοίτα</msg><gif>g1</gif>') });
  const { logs } = await withCapturedLogs(() => after.turns.runTurn(after.params));
  assert.deepEqual(after.channel.sent.map((post) => post.content), [linked('κοίτα', 'd3'), 'https://tenor.com/view/chat-qui-danse-1'], 'one link per turn, on its first post');
  assert.equal('link' in logs.find((l) => l.msg === 'turn: gif sent'), false);
});

test('runTurn: dry-run gives the GIF and the picture the links a real turn posts', async () => {
  const scene = routedScene({ hot: drawHot({ dryRun: true }), images: fakeImages(), store: gifStore(), llm: fakeLlm('<gif reply="#4">g1</gif><draw reply="#2">a blue wall</draw>') });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.deepEqual([result.outcome, result.dryRun], ['spoke', true]);
  assert.deepEqual([scene.channel.sent, scene.other.sent], [[], []]);
  assert.equal(logs.find((l) => l.msg === 'dry-run: would send gif').link, diaryLink('d3'));
  assert.equal(logs.find((l) => l.msg === 'dry-run: would draw').link, diaryLink('d1'));
});

test('runTurn: a follow-up reply to a pulled line posts plain with its jump link', async () => {
  const scene = pullScene({ features: { typingSimulation: false }, llm: fakeLlm('<msg reply="#3">ωραίο μπλε</msg><msg reply="#2">ναι</msg>') });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'followUp' }));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    scene.channel.sent.map((post) => [post.content, post.reply]),
    [
      [linked('ωραίο μπλε', 'd1'), undefined],
      ['ναι', undefined],
    ],
    'a follow-up quotes nothing, yet links the pulled line it answers',
  );
  assert.deepEqual(logs.filter((l) => l.msg === 'turn: sent').map((l) => l.link ?? false), [true, false]);
});

test('runTurn: a chat author wins @name over a pulled author with the same display name', async () => {
  const namesake = lineIn(DIARY, { id: 'd5', authorId: 'u7', authorName: 'Bob', ts: NOW - 3 * HOUR + 2 * MINUTE, content: 'κι εγώ' });
  const scene = pullScene({ features: { typingSimulation: false }, diary: { messages: [...diaryLines(), namesake] }, llm: fakeLlm('<msg>@Bob ναι</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.ok(channelViewOf(scene.llm).includes('κι εγώ'), 'the namesake is shown');
  const [post] = scene.channel.sent;
  assert.equal(post.content, '<@u2> ναι');
  assert.deepEqual(post.allowedMentions.users, ['u2']);
});

test('runTurn: @name of an author whose pulled block the budget dropped stays text', async () => {
  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const scene = pullScene({ features: { typingSimulation: false }, context: { caps }, llm: fakeLlm('<msg>@Éloïse γεια</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(channelViewOf(scene.llm), null, 'the block was cut');
  const [post] = scene.channel.sent;
  assert.equal(post.content, '@Éloïse γεια');
  assert.deepEqual(post.allowedMentions.users, []);
});

test('runTurn: a noticed turn whose source block the budget dropped posts no link', async () => {
  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const scene = pullScene({ mention: false, context: { caps }, features: { typingSimulation: false }, llm: fakeLlm('<msg>τι ωραίο χρώμα</msg>') });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'auto', source: { channelId: DIARY, reason: 'noticed' }, chooseMode: () => 'interject' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(channelViewOf(scene.llm), null, 'nothing of the source was shown');
  assert.deepEqual(scene.channel.sent.map((post) => post.content), ['τι ωραίο χρώμα']);
  assert.equal('link' in logs.find((l) => l.msg === 'turn: sent'), false);
});

test('runTurn: a reply to a pulled line records that line as what the persona answered', async () => {
  const variety = fakeVariety();
  const scene = routedScene({ features: { typingSimulation: false }, variety, llm: fakeLlm('<msg reply="#2">ωραίο μπλε</msg><msg>λοιπόν</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.deepEqual(
    variety.records.map((record) => record.line.to),
    ['σήμερα έβαψα τον τοίχο μπλε', '@Bot τι λες για τον τοίχο;'],
    'the pulled line answered, else the trigger',
  );
});

test('runTurn: a reaction on a pulled line whose channel is gone is dropped as not-found', async () => {
  for (const dryRun of [false, true]) {
    let guild = null;
    const calls = [];
    // The pulled channel leaves the guild's cache while the model answers.
    const llm = {
      calls,
      complete: async (messages) => {
        calls.push(messages);
        guild.channels.cache.delete(DIARY);
        return { text: '<react to="#3">🎉</react>', usage: {}, estimated: 10 };
      },
    };
    const scene = pullScene({ features: { typingSimulation: false, dryRun }, llm });
    guild = scene.channel.guild;

    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

    assert.equal(result.outcome, 'spoke', `dryRun ${dryRun}`);
    assert.ok(channelViewOf(scene.llm), 'the channel was shown');
    assert.deepEqual([scene.other.reactCalls, scene.channel.reactCalls], [[], []], `dryRun ${dryRun}`);
    const dropped = logs.filter((l) => l.msg === 'turn: reaction dropped');
    assert.deepEqual(dropped.map((l) => [l.channel, l.source, l.reason]), [['c1', DIARY, 'not-found']], `dryRun ${dryRun}`);
    assert.equal(logs.some((l) => l.msg === 'dry-run: would react' || l.msg === 'turn: reaction failed'), false, `dryRun ${dryRun}`);
  }
});

test('runTurn: labels.elsewhere.link is read at the moment of use; without it the link follows a newline', async () => {
  const scene = routedScene({ features: { typingSimulation: false }, llm: fakeLlm('<msg>ναι</msg>') });
  const run = () => withCapturedLogs(() => scene.turns.runTurn(scene.params));

  await run();
  scene.hot.prompts.labels = { ...labels, elsewhere: { ...labels.elsewhere, link: '{text} -> {link}' } };
  await run();
  const { elsewhere, ...withoutElsewhere } = labels;
  scene.hot.prompts.labels = { ...withoutElsewhere, elsewhere: { called: elsewhere.called } };
  await run();

  assert.deepEqual(scene.channel.sent.map((post) => post.content), [
    `ναι [from ${diaryLink('d3')}]`,
    `ναι -> ${diaryLink('d3')}`,
    `ναι\n${diaryLink('d3')}`,
  ]);
});

test('runTurn: a message near the length limit is cut so its link still fits one Discord message', async () => {
  const long = `${'a'.repeat(1850)}${' :dance:'.repeat(5)}`;
  const scene = routedScene({ features: { typingSimulation: false }, llm: fakeLlm(`<msg>${long}</msg>`) });
  const turns = createTurnRunner({ hot: scene.hot, store: fakeStore(), llm: scene.llm, calibrator: identityCalibrator(), client: fakeClient(), emoji: fakeEmojiIndex(), imageFetcher: fakeImageFetcher(), now: () => NOW });

  const { result } = await withCapturedLogs(() => turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const [post] = scene.channel.sent;
  const tail = ` [from ${diaryLink('d3')}]`;
  assert.ok(post.content.endsWith(tail), 'the link is kept');
  assert.ok([...post.content].length <= 2000, `${[...post.content].length} characters`);
  assert.ok(post.content.startsWith('a'.repeat(1850)), 'the text is cut at its end');
  assert.equal(/<[^>]*$/.test(post.content.slice(0, -tail.length)), false, 'no custom emoji token is cut in half');
});

test('runTurn: a pulled channel gets its seen mark and its spokeSaw ids', async () => {
  const scene = routedScene({ features: { typingSimulation: false } });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.store.state.data.elsewhereSeen, { [DIARY]: NOW - 2 * MINUTE }, 'the newest line shown');
  for (const id of ['d1', 'd2', 'd3']) assert.equal(scene.turns.spokeAfterSeeing(DIARY, id), true, id);
  assert.equal(scene.turns.spokeAfterSeeing(DIARY, 'm1'), false);
  assert.equal(scene.turns.spokeAfterSeeing('c1', 'm1'), true, "the destination's own history as before");
});

test('runTurn: a pulled channel the bot can write in gets a seen mark but no spokeSaw ids', async () => {
  const scene = pullScene({ features: { typingSimulation: false } });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.deepEqual(scene.store.state.data.elsewhereSeen, { [DIARY]: NOW - 3 * HOUR + MINUTE });
  assert.equal(scene.turns.spokeAfterSeeing(DIARY, 'd1'), false, 'a call written there is answered there');
  assert.equal(scene.turns.spokeAfterSeeing('c1', 'm9'), true);
});

test('runTurn: the seen mark follows the request sent: set on a skip, never for a block the budget dropped', async () => {
  const skipped = routedScene({ llm: fakeLlm('<skip/>') });
  const skip = await withCapturedLogs(() => skipped.turns.runTurn(skipped.params));
  assert.equal(skip.result.outcome, 'skip');
  assert.deepEqual(skipped.store.state.data.elsewhereSeen, { [DIARY]: NOW - 2 * MINUTE }, 'a skip saw the block');
  assert.equal(skipped.turns.spokeAfterSeeing(DIARY, 'd3'), false, 'no spokeSaw without speaking');

  // A channel the bot cannot write in, the one kind that gets spokeSaw ids: shown -> its ids,
  // cut by the budget -> none.
  const kept = pullScene({ diary: { readOnly: true } });
  const shown = await withCapturedLogs(() => kept.turns.runTurn({ channel: kept.channel, mode: 'reply', trigger: kept.trigger, triggerKind: 'mention' }));
  assert.equal(shown.result.outcome, 'spoke');
  assert.ok(channelViewOf(kept.llm), 'the control shows the block');
  assert.equal(kept.turns.spokeAfterSeeing(DIARY, 'd1'), true, 'the control records what it showed');

  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const dropped = pullScene({ diary: { readOnly: true }, context: { caps } });
  const cut = await withCapturedLogs(() => dropped.turns.runTurn({ channel: dropped.channel, mode: 'reply', trigger: dropped.trigger, triggerKind: 'mention' }));
  assert.equal(cut.result.outcome, 'spoke');
  assert.equal(dropped.other.fetches.length, 1, 'the channel was pulled');
  assert.equal(channelViewOf(dropped.llm), null, 'and its block cut by the budget');
  assert.equal(dropped.store.state.data.elsewhereSeen, undefined);
  assert.equal(dropped.turns.spokeAfterSeeing(DIARY, 'd1'), false);
});

test('runTurn: dry-run logs the source reaction and the link, and acts nowhere', async () => {
  const answer = '<react to="#2">🎉</react><react to="#1">👍</react><msg reply="#4">ναι, μπλε</msg>';
  const mirrored = [];
  const scene = routedScene({ hot: fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' }), client: mirrorClient(mirrored), llm: fakeLlm(answer) });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.deepEqual([result.outcome, result.dryRun], ['spoke', true]);
  assert.deepEqual([scene.other.reactCalls, scene.channel.reactCalls, scene.channel.sent, scene.other.sent], [[], [], [], []]);
  const reacts = logs.filter((l) => l.msg === 'dry-run: would react');
  assert.deepEqual(reacts.map((l) => [l.channel, l.source, l.to]), [['c1', DIARY, 'd1'], ['c1', null, 'm1']]);
  const send = logs.find((l) => l.msg === 'dry-run: would send');
  assert.deepEqual([send.replyTo, send.link, send.text], [null, diaryLink('d3'), linked('ναι, μπλε', 'd3')]);
  assert.ok(mirrored.some((post) => post.content.endsWith(`\n${linked('ναι, μπλε', 'd3')}`)), 'the mirror shows the post with its link');
  assert.ok(mirrored.some((post) => post.content.includes('#diary')), 'the mirror names where the reaction goes');
  assert.deepEqual(scene.store.state.data.elsewhereSeen, { [DIARY]: NOW - 2 * MINUTE }, 'dry-run included');
  assert.equal(scene.turns.spokeAfterSeeing(DIARY, 'd3'), true);

  // Where the bot may not react, the rehearsal drops the reaction exactly as a real turn would.
  const denied = routedScene({ hot: fakeHot({ dryRun: true }), llm: fakeLlm(answer) });
  denyReactions(denied.other);
  const rehearsal = await withCapturedLogs(() => denied.turns.runTurn(denied.params));
  assert.deepEqual(
    rehearsal.logs.filter((l) => l.msg === 'dry-run: would react' || l.msg === 'turn: reaction dropped').map((l) => [l.msg, l.source, l.reason ?? null]),
    [
      ['turn: reaction dropped', DIARY, 'cannot-react'],
      ['dry-run: would react', null, null],
    ],
  );
});

test('runTurn: an image cap on a routed turn posts the notice in the destination, never as a reply to the call', async () => {
  const scene = routedScene({
    hot: drawHot(),
    images: fakeImages({ error: imageCap('userDaily', 'image.maxPerUserPerDay', 3, 3) }),
    llm: fakeLlm('<msg reply="#4">μισό λεπτό</msg><draw reply="#4">a blue wall</draw>'),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(scene.llm.calls.length, 1, 'no drawFailed turn');
  assert.deepEqual(scene.channel.sent, [
    { content: linked('μισό λεπτό', 'd3'), reply: undefined, allowedMentions: { parse: [], users: [], repliedUser: true } },
    { content: fill(labels.limits.notice, { limit: 'image.maxPerUserPerDay', used: 3, cap: 3 }), reply: undefined, allowedMentions: { parse: [] } },
  ]);
  assert.equal(scene.other.sent.length, 0, 'nothing in the source');
  assert.equal(logs.find((l) => l.msg === 'turn: draw refused by a limit').asked, true, 'the caller asked: the notice follows');
});

test('runTurn: a routed turn that only reacts on its call counts as spoke', async () => {
  const scene = routedScene({ features: { typingSimulation: false }, llm: fakeLlm('<react to="#4">👍</react>') });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke', 'the caller of a routed turn marks the call answered on spoke');
  assert.equal(result.delivered, true, 'the reaction was put');
  assert.deepEqual(scene.other.reactCalls, [{ id: 'd3', emoji: '👍' }]);
  assert.deepEqual(scene.channel.sent, []);
});

test('runTurn: a turn whose output never reached the chat reports delivered false', async () => {
  const quiet = { typingSimulation: false };
  // The bot may not react in the source: the one reaction, on the call, is dropped.
  const denied = routedScene({ features: quiet, llm: fakeLlm('<react to="#4">👍</react>') });
  denyReactions(denied.other);
  const dropped = await withCapturedLogs(() => denied.turns.runTurn(denied.params));
  assert.deepEqual([dropped.result.outcome, dropped.result.delivered], ['spoke', false]);
  assert.deepEqual([denied.other.reactCalls, denied.channel.sent], [[], []]);
  assert.ok(dropped.logs.some((l) => l.msg === 'turn: reaction dropped' && l.reason === 'cannot-react'));

  // Discord refuses the reaction on a chat line.
  const refusing = routedScene({ features: quiet, llm: fakeLlm('<react to="#1">👍</react>') });
  const fetchMessages = refusing.channel.messages.fetch;
  refusing.channel.messages.fetch = async (arg) =>
    arg && typeof arg === 'object'
      ? fetchMessages(arg)
      : {
          react: async () => {
            throw new Error('fixture: reaction refused');
          },
        };
  const failed = await withCapturedLogs(() => refusing.turns.runTurn(refusing.params));
  assert.deepEqual([failed.result.outcome, failed.result.delivered], ['spoke', false]);
  assert.ok(failed.logs.some((l) => l.msg === 'turn: reaction failed'));

  // A picture an image cap refused: the limit notice is not an answer.
  const capped = routedScene({ hot: drawHot(), images: fakeImages({ error: imageCap('userDaily', 'image.maxPerUserPerDay', 3, 3) }), llm: fakeLlm('<draw reply="#4">a blue wall</draw>') });
  const refused = await withCapturedLogs(() => capped.turns.runTurn(capped.params));
  assert.deepEqual([refused.result.outcome, refused.result.delivered], ['spoke', false]);
  assert.equal(capped.channel.sent.length, 1, 'only the notice');

  // A message, a picture, or the drawFailed turn's message reached the chat.
  const said = routedScene({ features: quiet });
  assert.equal((await withCapturedLogs(() => said.turns.runTurn(said.params))).result.delivered, true);
  const drawn = routedScene({ hot: drawHot(), images: fakeImages(), llm: fakeLlm('<draw reply="#4">a blue wall</draw>') });
  assert.equal((await withCapturedLogs(() => drawn.turns.runTurn(drawn.params))).result.delivered, true);
  const failedDraw = routedScene({
    hot: drawHot(),
    images: fakeImages({ error: new ImageGenError('moderation') }),
    llm: sequenceLlm(['<draw reply="#4">a blue wall</draw>', '<msg>δεν βγήκε</msg>']),
  });
  const explained = await withCapturedLogs(() => failedDraw.turns.runTurn(failedDraw.params));
  assert.deepEqual([explained.result.drawFailed, explained.result.delivered], ['moderation', true], 'the failure was answered in the chat');
});

// --- the ring of calls after a turn that showed some (state.json `elsewherePings`) --------------

/** A ring entry for the diary line `line`, unanswered and unskipped. */
function ringEntry(line) {
  return { messageId: line.id, channelId: DIARY, ts: line.createdTimestamp, answeredAt: null, skippedAt: null };
}

/** The state of each ring entry of `store` by message id: `answered`, `skipped` or `unanswered`. */
function ringStates(store) {
  return Object.fromEntries(store.state.data.elsewherePings.map((entry) => [entry.messageId, pingStatus(entry)]));
}

/** The `elsewhere: marked` lines of `logs` as [source, message, status], sorted by message id. */
function markedLines(logs) {
  return logs
    .filter((l) => l.msg === 'elsewhere: marked')
    .map(({ source, message, status }) => [source, message, status])
    .sort((a, b) => a[1].localeCompare(b[1]));
}

/**
 * pullScene options whose read-only #diary holds two calls to the persona before its lines (e1 by
 * Zoë, e2 by Chloé, both in the ring): in the request #3 e1, #4 e2, #5 d1, #6 d2.
 */
function ringedDiary(options = {}) {
  const calls = [
    lineIn(DIARY, { id: 'e1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 3 * HOUR - 10 * MINUTE, content: '@Bot είσαι εδώ;' }),
    lineIn(DIARY, { id: 'e2', authorId: 'u5', authorName: 'Chloé', ts: NOW - 3 * HOUR - 5 * MINUTE, content: '@Bot καλημέρα' }),
  ];
  const store = fakeStore();
  store.state.data.elsewherePings = calls.map(ringEntry);
  const { diary = {}, ...rest } = options;
  return { store, ...rest, diary: { messages: [...calls, ...diaryLines()], readOnly: true, ...diary } };
}

test('runTurn: a turn that showed calls of a read-only channel stamps them: answered when its output answered them, skipped otherwise', async () => {
  const quiet = { typingSimulation: false };
  for (const [label, answer, states] of [
    ['a reply to e1', '<msg reply="#3">ναι, εδώ είμαι</msg>', { e1: 'answered', e2: 'skipped' }],
    ['a reaction on e2', '<react to="#4">👍</react>', { e1: 'skipped', e2: 'answered' }],
    ['a GIF answering e2', '<msg>χα</msg><gif reply="#4">g1</gif>', { e1: 'skipped', e2: 'answered' }],
    ['a picture answering e1', '<draw reply="#3">a blue wall</draw>', { e1: 'answered', e2: 'skipped' }],
    ['a reply to a diary line that is no call', '<msg reply="#5">ωραίο</msg>', { e1: 'skipped', e2: 'skipped' }],
    ['a message answering no pulled line', '<msg>καλημέρα</msg>', { e1: 'skipped', e2: 'skipped' }],
  ]) {
    const drawing = answer.includes('<draw');
    const scene = pullScene(
      ringedDiary({
        features: quiet,
        llm: fakeLlm(answer),
        ...(drawing ? { config: { image: { ...DRAW_IMAGE_CFG } }, images: fakeImages() } : {}),
      }),
    );
    if (drawing) scene.hot.prompts.draw = 'Drawing for {{name}}.\n\n{{request}}';
    scene.store.findGif = gifStore().findGif;

    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

    assert.equal(result.outcome, 'spoke', label);
    assert.ok(channelViewOf(scene.llm).includes('@Bot είσαι εδώ;'), label);
    assert.deepEqual(ringStates(scene.store), states, label);
    assert.deepEqual(markedLines(logs), Object.entries(states).map(([id, status]) => [DIARY, id, status]), label);
    for (const entry of scene.store.state.data.elsewherePings) {
      assert.equal(entry.answeredAt ?? entry.skippedAt, NOW, `${label}: stamped at the turn's clock`);
    }
  }

  // The reply to e1 posts in the chat with its jump link, never as a Discord reply across channels.
  const replied = pullScene(ringedDiary({ features: quiet, llm: fakeLlm('<msg reply="#3">ναι, εδώ είμαι</msg>') }));
  await withCapturedLogs(() => replied.turns.runTurn({ channel: replied.channel, mode: 'reply', trigger: replied.trigger, triggerKind: 'mention' }));
  assert.deepEqual(replied.channel.sent.map((post) => [post.content, post.reply]), [[linked('ναι, εδώ είμαι', 'e1'), undefined]]);
});

test('runTurn: a turn that chose silence stamps the calls it showed skipped; a rehearsal, a dropped block or a writable channel stamps none', async () => {
  const silent = pullScene(ringedDiary({ llm: fakeLlm('<skip/>') }));
  const skip = await withCapturedLogs(() => silent.turns.runTurn({ channel: silent.channel, mode: 'reply', trigger: silent.trigger, triggerKind: 'mention' }));
  assert.equal(skip.result.outcome, 'skip');
  assert.deepEqual(ringStates(silent.store), { e1: 'skipped', e2: 'skipped' }, 'she had them in view and chose silence');
  assert.deepEqual(markedLines(skip.logs), [[DIARY, 'e1', 'skipped'], [DIARY, 'e2', 'skipped']]);

  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const cases = [
    // A rehearsal reached nobody: nothing answered, nothing let pass.
    ['dry run', ringedDiary({ features: { dryRun: true }, llm: fakeLlm('<msg reply="#3">ναι</msg>') }), 'spoke'],
    ['the block cut by the budget', ringedDiary({ context: { caps } }), 'spoke'],
    ['a skip whose block was cut', ringedDiary({ context: { caps }, llm: fakeLlm('<skip/>') }), 'skip'],
    // A call written where the bot can write is answered there, not by being shown here.
    ['a writable channel', ringedDiary({ diary: { readOnly: false }, llm: fakeLlm('<msg reply="#3">ναι</msg>') }), 'spoke'],
  ];
  for (const [label, options, outcome] of cases) {
    const scene = pullScene(options);
    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    assert.equal(result.outcome, outcome, label);
    assert.deepEqual(ringStates(scene.store), { e1: 'unanswered', e2: 'unanswered' }, label);
    assert.deepEqual(markedLines(logs), [], label);
  }

  // Paused while the turn ran (the owner may be editing data/): the ring is left as it was.
  const paused = pullScene(ringedDiary());
  paused.llm.complete = async () => {
    paused.store.state.data.paused = true;
    return { text: '<msg reply="#3">ναι</msg>', usage: {}, estimated: 10 };
  };
  const late = await withCapturedLogs(() => paused.turns.runTurn({ channel: paused.channel, mode: 'reply', trigger: paused.trigger, triggerKind: 'mention' }));
  assert.equal(late.result.outcome, 'spoke');
  assert.deepEqual(ringStates(paused.store), { e1: 'unanswered', e2: 'unanswered' });
});

test('runTurn: a routed turn stamps the other calls it showed and leaves its own call to its caller', async () => {
  // The diary in the request: #2 d1, #3 d2, #4 e1 (an earlier call by Zoë), #5 d3 (the routed call).
  const earlier = lineIn(DIARY, { id: 'e1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 4 * MINUTE, content: '@Bot είσαι εδώ;' });
  for (const [label, answer, outcome, states] of [
    ['a reply to the earlier call', '<msg reply="#4">ναι, Zoë</msg>', 'spoke', { e1: 'answered', d3: 'unanswered' }],
    ['a reply to its own call', '<msg reply="#5">ναι</msg>', 'spoke', { e1: 'skipped', d3: 'unanswered' }],
    ['silence', '<skip/>', 'skip', { e1: 'skipped', d3: 'unanswered' }],
  ]) {
    const scene = routedScene({ features: { typingSimulation: false }, before: [earlier], llm: fakeLlm(answer) });
    scene.store.state.data.elsewherePings = [ringEntry(earlier), ringEntry({ id: 'd3', createdTimestamp: NOW - 2 * MINUTE })];

    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

    assert.equal(result.outcome, outcome, label);
    assert.deepEqual(ringStates(scene.store), states, `${label}: the routed call is stamped by its caller (src/discord/events.js)`);
    assert.deepEqual(markedLines(logs), [[DIARY, 'e1', states.e1]], label);
    assert.equal('sourceShownIds' in result, false, label);
  }
});

test('runTurn: a drawFailed turn after a routed one keeps the source', async () => {
  const scene = routedScene({
    hot: drawHot(),
    images: fakeImages({ error: new ImageGenError('moderation') }),
    llm: sequenceLlm(['<msg reply="#4">μισό λεπτό</msg><draw reply="#4">a blue wall</draw>', '<msg>δεν βγήκε</msg>']),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.drawFailed, 'moderation');
  assert.equal(scene.llm.calls.length, 2, 'the drawFailed turn ran');
  const second = userTextOf(scene.llm.calls[1]);
  assert.ok(second.includes('<channel_view>') && second.includes('@Bot τι λες για τον τοίχο;'), 'the second turn still shows the call');
  assert.deepEqual(scene.channel.sent.map((post) => [post.content, post.reply]), [
    [linked('μισό λεπτό', 'd3'), undefined],
    [linked('δεν βγήκε', 'd3'), undefined],
  ]);
  const answered = logs.filter((l) => l.msg === 'turn: model answered');
  assert.deepEqual(answered.map((l) => [l.trigger, l.source]), [['mention', DIARY], ['drawFailed', DIARY]]);
});

// --- <recent>: the recent lines a turn may show -------------------------------------------------

const OPEN_ROOM = '100000000000000011';
const STAFF_ROOM = '100000000000000012';
const STAFF_ROLE = '100000000000000099';

/**
 * Gives `guild` its roles -- @everyone (the guild's id) and a staff role -- and two more text
 * channels the bot reads (quiet: never a neighbour): #open, which every role can view, and
 * #staff, which only the staff role can. A fakeTurnChannel grants every permission, so the
 * turn's own channel is viewable by every role.
 */
function audienceGuild(guild) {
  const everyone = { id: guild.id };
  const staff = { id: STAFF_ROLE };
  guild.roles = { everyone, cache: new Map([[everyone.id, everyone], [staff.id, staff]]) };
  const room = (id, name, viewers) =>
    guild.channels.cache.set(id, {
      id,
      name,
      guild,
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor: (target) =>
        target === guild.members.me ? { has: () => true } : { has: (flag) => flag === PermissionFlagsBits.ViewChannel && viewers.includes(target?.id) },
    });
  room(OPEN_ROOM, 'open', [everyone.id, staff.id]);
  room(STAFF_ROOM, 'staff', [staff.id]);
  return guild;
}

/** Three live lines: one of #general (c1), one of #open, one of #staff. */
function threeRooms() {
  return [
    { id: 1, at: NOW - 3 * HOUR, addedAt: null, channelId: 'c1', text: 'εδώ το πρωί', who: [], weight: 2 },
    { id: 2, at: NOW - 2 * HOUR, addedAt: null, channelId: OPEN_ROOM, text: 'στην αυλή', who: [], weight: 2 },
    { id: 3, at: NOW - HOUR, addedAt: null, channelId: STAFF_ROOM, text: 'στο γραφείο', who: [], weight: 2 },
  ];
}

/** A store like fakeStore that also holds `lines` as the guild's recent lines; `recentReads` counts the reads. */
function recentStore(lines, base) {
  const store = fakeStore(base);
  store.recentReads = 0;
  store.getRecent = () => {
    store.recentReads += 1;
    return { nextId: lines.length + 1, lines: structuredClone(lines) };
  };
  return store;
}

/** The `recent: shown` entries of `logs`, without the logger's own fields. */
function recentShownLogs(logs) {
  return logs.filter((entry) => entry.msg === 'recent: shown').map(({ level, time, msg, ...fields }) => fields);
}

test("turn: <recent> shows this channel's lines and those of channels everyone here can read, never a narrower channel's", async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  audienceGuild(channel.guild);
  const store = recentStore(threeRooms(), { channels: [{ id: OPEN_ROOM, name: 'open' }] });
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({ hot: fakeHot(), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });

  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

  assert.equal(result.outcome, 'skip');
  const text = userText(llm);
  const recent = text.split('<recent>\n')[1].split('\n</recent>')[0];
  assert.ok(recent.includes('εδώ το πρωί'), "this channel's line");
  const at = NOW - 2 * HOUR;
  const openLine = fill(labels.recent.lineIn, { date: formatDate(at, 'UTC', labels.locale), time: formatClock(at, 'UTC', labels.locale), channel: 'open', text: 'στην αυλή' });
  assert.ok(recent.includes(openLine), 'named by its channel');
  assert.ok(!text.includes('στο γραφείο'), 'a channel only the staff can read never reaches #general');
  assert.deepEqual(recentShownLogs(logs), [{ channel: 'c1', lines: 2, episodes: 0, cut: 0, hidden: 1, repeated: 0, unnamed: 0 }], 'counts only');
  const answered = logs.find((entry) => entry.msg === 'turn: model answered');
  assert.equal(answered.budget.recent.kept, 2);

  // In #staff, whose readers can all read #general and #open, all three are shown.
  const staffChannel = { ...fakeTurnChannel({ id: STAFF_ROOM, historyMessages: [{ ...raw, channelId: STAFF_ROOM }] }), guild: channel.guild };
  staffChannel.permissionsFor = channel.guild.channels.cache.get(STAFF_ROOM).permissionsFor;
  const staffLlm = fakeLlm('<skip/>');
  const staffTurns = createTurnRunner({ hot: fakeHot(), store, llm: staffLlm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  registerTextChannel(channel);
  const { logs: staffLogs } = await withCapturedLogs(() =>
    staffTurns.runTurn({ channel: staffChannel, mode: 'reply', trigger: { ...normalizedTrigger(raw), channelId: STAFF_ROOM }, triggerKind: 'mention' }),
  );
  assert.ok(userText(staffLlm).includes('στο γραφείο') && userText(staffLlm).includes('στην αυλή') && userText(staffLlm).includes('εδώ το πρωί'));
  assert.deepEqual(recentShownLogs(staffLogs), [{ channel: STAFF_ROOM, lines: 3, episodes: 0, cut: 0, hidden: 0, repeated: 0, unnamed: 0 }]);
});

test('turn: a private chat shows only the recent lines of channels everyone on the server can read', async () => {
  const general = fakeTurnChannel({ id: 'c1' });
  const guild = audienceGuild(general.guild);
  registerTextChannel(general);
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const dm = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const store = recentStore(threeRooms());
  const llm = fakeLlm('<skip/>');
  const client = fakeClient({ guilds: { cache: new Map([[guild.id, guild]]) } });
  const turns = createTurnRunner({ hot: fakeHot(), store, llm, calibrator: identityCalibrator(), client, now: () => NOW });

  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel: dm, guildId: guild.id, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }));

  const text = userText(llm);
  assert.ok(text.includes('εδώ το πρωί') && text.includes('στην αυλή'), 'channels every member can read');
  assert.ok(!text.includes('στο γραφείο'));
  assert.deepEqual(recentShownLogs(logs), [{ channel: 'dm1', lines: 2, episodes: 0, cut: 0, hidden: 1, repeated: 0, unnamed: 0 }]);

  // A role denied on #open hides it from some members: it is no longer every member's.
  guild.channels.cache.get(OPEN_ROOM).permissionOverwrites = {
    cache: new Map([[STAFF_ROLE, { id: STAFF_ROLE, type: 0, allow: { has: () => false }, deny: { has: (flag) => flag === PermissionFlagsBits.ViewChannel } }]]),
  };
  const deniedLlm = fakeLlm('<skip/>');
  const denied = createTurnRunner({ hot: fakeHot(), store, llm: deniedLlm, calibrator: identityCalibrator(), client, now: () => NOW });
  await withCapturedLogs(() => denied.runTurn({ channel: dm, guildId: guild.id, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }));
  assert.ok(userText(deniedLlm).includes('εδώ το πρωί') && !userText(deniedLlm).includes('στην αυλή'));
});

test('turn: with no live line <recent> still shows the moments of the last hours, and a line hidden here changes nothing', async () => {
  const nikos = {
    id: 'u9',
    names: ['Nikos'],
    episodes: [{ date: '2026-09-19', what: 'η στιγμή του Nikos', quote: '', feeling: '', weight: 3, addedAt: new Date(NOW - 20 * HOUR).toISOString() }],
  };
  const run = async (lines) => {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    audienceGuild(channel.guild);
    const llm = fakeLlm('<skip/>');
    const store = recentStore(lines, { userProfiles: { u9: nikos } });
    const turns = createTurnRunner({ hot: fakeHot(), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
    const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
    return { text: userText(llm), logs };
  };
  const quiet = await run([]);
  const moment = fill(labels.recent.episode, { date: formatDate(Date.parse('2026-09-19T12:00:00Z'), 'UTC', labels.locale), name: 'Nikos', what: 'η στιγμή του Nikos' });
  assert.ok(quiet.text.includes(`<recent>\n${fill(labels.recent.header, { hours: 72 })}\n${moment}\n</recent>`), 'an empty store still shows the moments');
  assert.deepEqual(recentShownLogs(quiet.logs), [{ channel: 'c1', lines: 0, episodes: 1, cut: 0, hidden: 0, repeated: 0, unnamed: 0 }]);

  const staffOnly = await run([threeRooms()[2]]);
  assert.equal(staffOnly.text, quiet.text, 'a line only #staff can read neither switches the moments on nor off');
  assert.deepEqual(recentShownLogs(staffOnly.logs), [{ channel: 'c1', lines: 0, episodes: 1, cut: 0, hidden: 1, repeated: 0, unnamed: 0 }]);
});

test('turn: features.recent false, memory off or a store without the recent store read nothing and change nothing', async () => {
  const run = async ({ store, features = {} }) => {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    audienceGuild(channel.guild);
    const llm = fakeLlm('<skip/>');
    const turns = createTurnRunner({ hot: fakeHot(features), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
    const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
    return { result, logs, sent: llm.calls[0] };
  };
  const before = await run({ store: fakeStore() });
  assert.equal(before.result.outcome, 'skip', 'a store without getRecent never breaks a turn');
  assert.ok(!userTextOf(before.sent).includes('<recent>'));

  for (const [label, features] of [['recent off', { recent: false }], ['memory off', { memory: false }]]) {
    const store = recentStore(threeRooms());
    const { result, logs, sent } = await run({ store, features });
    assert.equal(result.outcome, 'skip', label);
    assert.equal(store.recentReads, 0, label);
    assert.ok(!userTextOf(sent).includes('<recent>'), label);
    assert.deepEqual(recentShownLogs(logs), [], label);
  }
  const offBefore = await run({ store: fakeStore(), features: { recent: false } });
  const off = await run({ store: recentStore(threeRooms()), features: { recent: false } });
  assert.deepEqual(off.sent, offBefore.sent, 'the request is the one built without the store');

  const empty = await run({ store: recentStore([]) });
  assert.deepEqual(empty.sent, before.sent, 'an empty store and no moment in the window: the request as before');
  assert.deepEqual(recentShownLogs(empty.logs), []);

  // A store whose read throws: logged, no block, the turn goes on.
  const broken = fakeStore();
  broken.getRecent = () => {
    throw new Error('fixture: unreadable recent store');
  };
  const failed = await run({ store: broken });
  assert.equal(failed.result.outcome, 'skip');
  assert.deepEqual(failed.sent, before.sent);
  assert.ok(failed.logs.some((entry) => entry.msg === 'recent: failed' && entry.channel === 'c1'));
});

// --- the request input, named in full (src/behavior/turn-input.js) ----------------------------

/** Makes #open and #staff of audienceGuild active neighbours (a fresh line each), recording their fetches. */
function activeRooms(guild) {
  const fetched = [];
  for (const [id, text] of [[OPEN_ROOM, 'στην αυλή τώρα'], [STAFF_ROOM, 'στο γραφείο τώρα']]) {
    const room = guild.channels.cache.get(id);
    const line = lineIn(id, { id: `${id}-1`, authorId: 'u5', authorName: 'Inès', ts: NOW - 2 * MINUTE, content: text });
    Object.assign(room, {
      viewable: true,
      lastMessageId: SnowflakeUtil.generate({ timestamp: NOW - 2 * MINUTE }).toString(),
      messages: {
        cache: new Map(),
        fetch: async () => {
          fetched.push(id);
          return new Map([[line.id, line]]);
        },
      },
    });
  }
  return fetched;
}

test('runTurn: the request is the one buildRequest makes from the turn input, absent inputs as before', async () => {
  const raw = rawMessage({ id: 'm1', content: 'γεια σου' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  audienceGuild(channel.guild);
  activeRooms(channel.guild);
  const store = fakeStore({
    guildMemory: { patterns: 'πολλά emoji' },
    userProfiles: { u1: { id: 'u1', names: ['Alice'], character: 'φιλική' } },
    channels: [{ id: 'c1', name: 'general', days: {} }],
  });
  const hot = fakeHot({}, {}, { context: { ...fakeHot().config.context, pull: { sameAudience: false } } });
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  const trigger = normalizedTrigger(raw);

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));

  const history = await fetchHistory(channel, { limit: 100, selfId: 'self-id' });
  const neighbors = await fetchNeighbors(channel, hot.config, 'self-id', NOW);
  assert.equal(neighbors.length, 2, 'both rooms are neighbours with the rail off');
  const expected = buildRequest({
    config: hot.config,
    prompts: hot.prompts,
    calibrator: identityCalibrator(),
    mode: 'reply',
    forced: false,
    now: NOW,
    selfName: 'Bot',
    history,
    neighbors,
    trigger,
    triggerKind: 'mention',
    guildMemory: store.getGuild('g1'),
    interlocutor: store.getUser('g1', 'u1'),
    privateChat: null,
    privateProfile: null,
    otherProfiles: pickOtherProfiles(store, 'g1', history, 'u1', 6),
    candidateProfiles: store.listUserProfiles('g1'),
    nameOf: (id) => store.getUser('g1', id)?.names?.[0] ?? null,
    channels: store.listChannels('g1'),
    loreEntries: [],
    currentChannelId: 'c1',
    descriptions: undefined,
    neighborDescriptions: undefined,
    videos: undefined,
    reads: undefined,
    lookup: null,
    searchAvailable: false,
    drawQuota: undefined,
    drawReason: null,
    customEmoji: [],
    gifs: null,
    mediaCache: null,
    worn: null,
    pulled: [],
    source: null,
    focus: null,
    elsewhereDestination: null,
    readOnlyIds: new Set(),
    recentLines: undefined,
    recentAudience: undefined,
  });
  assert.deepEqual(llm.calls[0], expected.messages);
});

test('runTurn: a neighbour whose audience the channel does not cover is left out of <other_channels> and <server>, unfetched', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  audienceGuild(channel.guild);
  const fetched = activeRooms(channel.guild);
  const store = fakeStore({
    channels: [
      { id: 'c1', name: 'general', days: {} },
      { id: OPEN_ROOM, name: 'open', note: 'η αυλή του σπιτιού', days: {} },
      { id: STAFF_ROOM, name: 'staff', note: 'το γραφείο της ομάδας', days: {} },
    ],
  });
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({ hot: fakeHot(), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });

  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

  const text = userText(llm);
  assert.ok(text.includes('στην αυλή τώρα'), 'the covered neighbour is shown');
  assert.ok(!text.includes('στο γραφείο τώρα'), "the staff room's lines stay out");
  assert.ok(!text.includes('το γραφείο της ομάδας'), "the staff room's note stays out of <server>");
  assert.deepEqual(fetched, [OPEN_ROOM], 'the refused neighbour costs no history fetch');
  assert.equal(logs.find((l) => l.msg === 'turn: model answered').neighborsHidden, 1);
});

// --- I-7: destinations, the post ledger, send failures, the drawFailed turn, dry-run, caps -------

test('usableDestination: the dry-run mirror or a channel the bot cannot read is never the destination', () => {
  const general = registerTextChannel(fakeTurnChannel());
  const hall = addChannel(general, { id: 'c6', name: 'hall' });
  const config = { bot: { dryRunChannelId: 'c1' }, features: {}, memory: { mainChannelIds: ['c1', 'c6'] } };
  assert.equal(usableDestination(general.guild, config).channel, hall, 'the mirror is passed over');
  hall.permissionsFor = () => ({ has: (flag) => flag !== PermissionFlagsBits.ReadMessageHistory });
  assert.deepEqual(usableDestination(general.guild, config), { channel: null, reason: 'no-destination' }, 'unreadable: not usable');
});

/**
 * A follow-up turn in #general (c1) answering Alice's line m1 after Bob's m0. `answer` is the
 * model's text, or a `complete` function; `configure` sees the channel, store and hot first.
 */
async function ledgerTurn({ features = {}, answer = '<msg>ένα</msg><msg>δύο</msg>', mentor, configure } = {}) {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Bob' }), raw] });
  const store = fakeStore();
  const hot = fakeHot({ typingSimulation: false, ...features }, {}, mentor ? { mentor } : {});
  const llm = typeof answer === 'function' ? { complete: answer } : fakeLlm(answer);
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  configure?.({ channel, store, hot });
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' }));
  return { result, logs, channel, store, turns };
}

test('runTurn: with features.mentor on, every posted message leaves a ledger entry naming its turn', async () => {
  const { result, store } = await ledgerTurn({ features: { mentor: true } });
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(store.state.data.postLedger, [
    { messageId: 'sent-1', channelId: 'c1', mode: 'reply', triggerKind: 'followUp', triggerId: 'm1', newestHistoryId: 'm1', sourceChannelId: null, at: NOW },
    { messageId: 'sent-2', channelId: 'c1', mode: 'reply', triggerKind: 'followUp', triggerId: 'm1', newestHistoryId: 'm1', sourceChannelId: null, at: NOW },
  ]);
});

test('runTurn: the ledger keeps the newest mentor.anchor.ledgerSize entries', async () => {
  const older = [{ messageId: 'x1' }, { messageId: 'x2' }];
  const { store } = await ledgerTurn({
    features: { mentor: true },
    mentor: { anchor: { ledgerSize: 3 } },
    configure: ({ store: s }) => {
      s.state.data.postLedger = older;
    },
  });
  assert.deepEqual(store.state.data.postLedger.map((entry) => entry.messageId), ['x2', 'sent-1', 'sent-2']);
  assert.deepEqual(older.map((entry) => entry.messageId), ['x1', 'x2'], 'the stored list is not changed in place');
});

test('runTurn: no ledger entry with the mentor off, while paused, or in a dry run', async () => {
  for (const features of [{}, { mentor: false }, { mentor: true, dryRun: true }]) {
    const { result, store } = await ledgerTurn({ features });
    assert.equal(result.outcome, 'spoke', JSON.stringify(features));
    assert.equal('postLedger' in store.state.data, false, JSON.stringify(features));
  }
  // Paused while the turn was already running (a pause waits for it): nothing is written.
  let state;
  const { result, store } = await ledgerTurn({
    features: { mentor: true },
    configure: ({ store: s }) => {
      state = s.state.data;
    },
    answer: async () => {
      state.paused = true;
      return { text: '<msg>ένα</msg>', usage: {}, estimated: 1 };
    },
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal('postLedger' in store.state.data, false);
});

test("postLedgerSize: the code fallback is config.json's mentor.anchor.ledgerSize", () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(postLedgerSize({}), shipped.mentor.anchor.ledgerSize);
  assert.equal(postLedgerSize({ mentor: { anchor: { ledgerSize: 7.9 } } }), 7);
  assert.equal(postLedgerSize({ mentor: { anchor: { ledgerSize: 0 } } }), 0);
  assert.equal(postLedgerSize({ mentor: { anchor: { ledgerSize: -1 } } }), postLedgerSize({}));
});

test('appendPostLedger: appends, keeps the newest size entries, a non-list is empty, 0 keeps none', () => {
  const entry = (id) => ({ messageId: id });
  assert.deepEqual(appendPostLedger([entry('a'), entry('b')], entry('c'), 2), [entry('b'), entry('c')]);
  assert.deepEqual(appendPostLedger(undefined, entry('a'), 5), [entry('a')]);
  assert.deepEqual(appendPostLedger({ length: 1 }, entry('a'), 5), [entry('a')]);
  assert.deepEqual(appendPostLedger([entry('a')], entry('b'), 0), []);
});

test('runTurn: a second message that fails to send ends the turn as spoke with what reached the chat', async () => {
  const { result, logs, channel, turns } = await ledgerTurn({
    answer: '<msg>ένα</msg><msg>δύο</msg><msg>τρία</msg>',
    configure: ({ channel: c }) => {
      const send = c.send;
      c.send = async (payload) => {
        if (payload.content === 'δύο') throw new Error('fixture: Missing Permissions');
        return send(payload);
      };
    },
  });
  assert.deepEqual({ outcome: result.outcome, delivered: result.delivered }, { outcome: 'spoke', delivered: true });
  assert.deepEqual(channel.sent.map((payload) => payload.content), ['ένα'], 'nothing after the failed message');
  const failed = logs.find((entry) => entry.msg === 'turn: send failed');
  assert.deepEqual([failed.level, failed.channel, failed.index], ['warn', 'c1', 1]);
  assert.equal(turns.spokeAfterSeeing('c1', 'm1'), true, 'the turn noted what it had in view');
});

test('runTurn: a first message that fails to send ends spoke with nothing delivered', async () => {
  const { result, channel } = await ledgerTurn({
    configure: ({ channel: c }) => {
      c.send = async () => {
        throw new Error('fixture: Missing Permissions');
      };
    },
  });
  assert.deepEqual({ outcome: result.outcome, delivered: result.delivered }, { outcome: 'spoke', delivered: false });
  assert.equal(channel.sent.length, 0);
});

test('runTurn: a post that grew past 2000 characters once its mentions expanded is cut to fit, never inside a mention', async () => {
  const { channel } = await ledgerTurn({ answer: `<msg>${'α'.repeat(1880)} @Bob @Bob @Bob @Bob</msg>` });
  const [payload] = channel.sent;
  assert.ok([...payload.content].length <= 2000, String([...payload.content].length));
  assert.ok(payload.content.lastIndexOf('<') <= payload.content.lastIndexOf('>'), 'no half mention at the end');
  assert.ok(payload.content.includes('<@u2>'), 'the mentions that fit stay');
});

test('runTurn: the drawFailed turn after a follow-up posts plain, after a mention as a reply', async () => {
  for (const [triggerKind, reply] of [['followUp', undefined], ['mention', { messageReference: 'm1', failIfNotExists: false }]]) {
    const { channel, llm } = await runDrawTurn({
      triggerKind,
      answers: ['<draw>a cat</draw>', '<msg reply="#1">δεν βγήκε</msg>'],
      images: fakeImages({ error: new ImageGenError('moderation') }),
    });
    assert.equal(llm.calls.length, 2, triggerKind);
    assert.deepEqual(channel.sent.map((payload) => payload.reply), [reply], triggerKind);
  }
});

test('runTurn: a dry-run reaction reads "react to <name>" and stamps no lastPostAt, as a real one', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const mirrorSent = [];
  const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
  const hot = fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<react to="#1">👍</react>'), calibrator: identityCalibrator(), client, now: () => NOW });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(mirrorSent[0].content.split('\n')[0], '[dry-run] #general · reply · mention · react to Élodie');
  assert.equal(turns.lastPostAt('c1'), 0);

  const real = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const live = createTurnRunner({ hot: fakeHot({ typingSimulation: false }), store: fakeStore(), llm: fakeLlm('<react to="#1">👍</react>'), calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  await withCapturedLogs(() => live.runTurn({ channel: real, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(real.reactCalls.length, 1);
  assert.equal(live.lastPostAt('c1'), 0);
});

test('runTurn: the search classifier is not asked when no web slot is left today', async () => {
  for (const [left, asked] of [[0, 0], [3, 1]]) {
    const llm = lookupLlm('champions final winner 2026');
    const lookup = { ...fakeLookup(), webCapLeft: () => left };
    const { logs } = await withCapturedLogs(() => runLookupTurn({ llm, lookup }));
    assert.equal(llm.classifierCalls.length, asked, String(left));
    assert.equal(lookup.searchCalls.length, asked, String(left));
    assert.equal(logs.some((entry) => entry.msg === 'lookup: skipped' && entry.reason === 'cap'), !asked, String(left));
  }
});

test('runTurn: the re-watch classifier is not asked when no video slot is left; with only re-watches spent, failed videos alone are offered', async () => {
  const spent = fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } });
  spent.videoCapsLeft = () => ({ video: 0, rewatch: 5 });
  const capped = await withCapturedLogs(() => runRewatch({ describer: spent }));
  assert.equal(capped.result.llm.classifierCalls.length, 0);
  assert.ok(capped.logs.some((entry) => entry.msg === 'rewatch: skipped' && entry.reason === 'cap'));

  const noQuestions = fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } });
  noQuestions.videoCapsLeft = () => ({ video: 5, rewatch: 0 });
  const quiet = await withCapturedLogs(() => runRewatch({ describer: noQuestions }));
  assert.equal(quiet.result.llm.classifierCalls.length, 0, 'no retry possible, no question allowed');

  const retry = fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' }, vb: { state: 'error', reason: 'fetch' } });
  retry.describeVideo = async () => null;
  retry.videoCapsLeft = () => ({ video: 5, rewatch: 0 });
  const scene = rewatchScene();
  const broken = videoAttachmentRaw('m0', NOW - 9000, 'vb', 'broken.mp4');
  scene.channel = fakeTurnChannel({ historyMessages: [broken, scene.video, scene.trigger] });
  const offered = await withCapturedLogs(() => runRewatch({ describer: retry, scene, llm: rewatchLlm('none') }));
  const [call] = offered.result.llm.classifierCalls;
  const videos = call.messages[1].content.split('<videos>\n')[1].split('\n</videos>')[0];
  assert.deepEqual(videos.split('\n').map((line) => line.split(' | ')[1]), ['broken.mp4'], 'only the video that did not load');
});

test('runTurn: the GIF and the picture a turn posts get their ledger entries too', async () => {
  const { store } = await ledgerTurn({
    features: { mentor: true },
    answer: '<msg>ένα</msg><gif>g1</gif>',
    configure: ({ store: s }) => {
      s.findGif = gifStore().findGif;
    },
  });
  assert.deepEqual(store.state.data.postLedger.map((entry) => entry.messageId), ['sent-1', 'sent-2']);

  const hot = drawHot({ mentor: true });
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const drawStore = fakeStore();
  const turns = createTurnRunner({ hot, store: drawStore, llm: fakeLlm('<draw>a cat</draw>'), calibrator: identityCalibrator(), client: fakeClient(), images: fakeImages(), imageFetcher: fakeImageFetcher(), now: () => NOW });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.deepEqual(drawStore.state.data.postLedger, [
    { messageId: 'sent-1', channelId: 'c1', mode: 'reply', triggerKind: 'mention', triggerId: 'm1', newestHistoryId: 'm1', sourceChannelId: null, at: NOW },
  ]);
});

test('runTurn: a routed answer records the call it answered and its source channel', async () => {
  const scene = asMainChannel(routedScene({ features: { mentor: true } }));
  await withCapturedLogs(() => scene.turns.runTurn(scene.params));
  assert.deepEqual(scene.store.state.data.postLedger, [
    { messageId: 'sent-1', channelId: 'c1', mode: 'reply', triggerKind: 'mention', triggerId: 'd3', newestHistoryId: 'm1', sourceChannelId: DIARY, at: NOW },
  ]);
});
