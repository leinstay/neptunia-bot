import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageHandler } from '../src/discord/events.js';
import { createTagHistory } from '../src/behavior/mention.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepMerge } from '../src/config.js';
import { DailyCapError } from '../src/llm/openrouter.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The tracked defaults only -- never the deployment's config.local.json, so
// the suite passes the same on every machine.
const DEFAULT_CONFIG = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'),
);

function baseConfig(overrides = {}) {
  return deepMerge(structuredClone(DEFAULT_CONFIG), overrides);
}

function fakeGuild(id = 'g1', displayName = 'Ζωή') {
  return { id, members: { me: { displayName } } };
}

function fakeChannel(id, guild, overrides = {}) {
  return {
    id,
    guild,
    isThread: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    messages: { cache: new Map(), fetch: async () => null },
    ...overrides,
  };
}

function fakeMessage(overrides = {}) {
  const guild = 'guild' in overrides ? overrides.guild : fakeGuild();
  const channel = overrides.channel ?? fakeChannel('c1', guild);
  return {
    system: false,
    webhookId: null,
    author: { id: 'u1', bot: false, globalName: 'User', username: 'user' },
    member: { displayName: 'User' },
    guild,
    channel,
    channelId: channel?.id,
    cleanContent: 'hello there',
    createdTimestamp: Date.now(),
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
    ...overrides,
  };
}

function fakeClient() {
  return { user: { id: 'self1', username: 'Neptunia' } };
}

function recorder() {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
  };
  fn.calls = calls;
  return fn;
}

function fakeTurns({ runTurn, isBusy, isAnyBusy } = {}) {
  const notePost = recorder();
  return {
    notePost,
    runTurn: runTurn ?? (async () => ({ outcome: 'spoke' })),
    isBusy: isBusy ?? (() => false),
    isAnyBusy: isAnyBusy ?? (() => false),
    lastPostAt: () => 0,
    notePostCalls: notePost.calls,
  };
}

function fakeSpontaneous() {
  const onMessage = recorder();
  return { onMessage, onMessageCalls: onMessage.calls };
}

function fakeMemory({ observe } = {}) {
  const calls = [];
  return {
    observe:
      observe ??
      ((...args) => {
        calls.push(args);
      }),
    observeCalls: calls,
  };
}

function scripted(values) {
  const queue = [...values];
  return () => {
    if (queue.length === 0) throw new Error('scripted rng ran out of values');
    return queue.shift();
  };
}

/** An injectable `now()` whose value can be moved forward with `.set(ms)`. */
function mutableNow(start) {
  let t = start;
  const fn = () => t;
  fn.set = (v) => {
    t = v;
  };
  return fn;
}

/** A fakeChannel whose message `messageId` is already cached -- messageStillExists finds it without a fetch. */
function fakeChannelWithMessage(id, guild, messageId, overrides = {}) {
  return fakeChannel(id, guild, {
    messages: { cache: new Map([[messageId, {}]]), fetch: async () => ({}) },
    ...overrides,
  });
}

function fakeStore(profiles = {}) {
  const calls = [];
  return {
    getUser: (guildId, userId) => {
      calls.push([guildId, userId]);
      return profiles[userId] ?? null;
    },
    getUserCalls: calls,
  };
}

function fakeDescriber() {
  const calls = [];
  return {
    calls,
    describeMany: async (guildId, items) => {
      calls.push({ guildId, items });
      return { descriptions: new Map(), newCount: 0 };
    },
  };
}

function makeHandler({
  config,
  turns,
  spontaneous,
  memory,
  tagHistory,
  rng,
  now,
  sleep,
  client,
  store,
  getGuildId,
  isWarmingUp,
  describer,
  prompts,
  llm,
  lookup,
} = {}) {
  return createMessageHandler({
    hot: prompts !== undefined ? { config: config ?? baseConfig(), prompts } : { config: config ?? baseConfig() },
    store: store ?? fakeStore(),
    client: client ?? fakeClient(),
    turns: turns ?? fakeTurns(),
    spontaneous: spontaneous ?? fakeSpontaneous(),
    memory: memory ?? fakeMemory(),
    tagHistory: tagHistory ?? createTagHistory(),
    getGuildId: getGuildId ?? (() => 'g1'),
    isWarmingUp,
    describer,
    llm,
    lookup,
    rng: rng ?? Math.random,
    now,
    sleep,
  });
}

/** A discord.js attachments Map with one classifiable image entry. */
function pictureAttachments(count = 1) {
  const entries = [];
  for (let i = 1; i <= count; i += 1) {
    entries.push([`a${i}`, { id: `a${i}`, contentType: 'image/png', name: `${i}.png`, url: `https://cdn.discordapp.com/x/${i}.png` }]);
  }
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// The address classifier (features.followUp) -- fixtures.

/** A raw discord.js-shaped message, minimal enough for normalizeMessage / fetchHistory. */
function rawHistoryMessage({ id, authorId = 'u1', authorName = 'Alice', ts, content = 'hi', channelId = 'c1' }) {
  return {
    id,
    channelId,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** A fakeChannel whose messages.fetch({limit}) serves `historyMessages` (see fetchHistory). */
function fakeChannelWithHistory(id, guild, historyMessages = [], overrides = {}) {
  return fakeChannel(id, guild, {
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) {
          return new Map(historyMessages.map((m) => [m.id, m]));
        }
        return null;
      },
    },
    ...overrides,
  });
}

function fakeAddressPrompts() {
  return {
    'system-prompt': 'system',
    'character-card': 'card',
    format: 'format',
    reply: 'Someone called you: {{author}}.',
    interject: 'interject',
    initiate: 'initiate',
    memory: 'memory',
    address: 'You are {{name}}. Is the candidate message addressed to you? Answer yes or no.',
    labels,
  };
}

/** A controllable fake LLM client (src/llm/openrouter.js#createLlm shape): `respond(text)` resolves
 * every currently-queued call, `fail(err)` rejects it instead -- lets a test hold a call open to
 * probe single-flight behaviour before letting it settle. */
function fakeFollowUpLlm() {
  const calls = [];
  let resolvers = [];
  return {
    calls,
    complete: (messages, options) =>
      new Promise((resolve, reject) => {
        calls.push({ messages, options });
        resolvers.push({ resolve, reject });
      }),
    respond(text) {
      const pending = resolvers;
      resolvers = [];
      for (const { resolve } of pending) resolve({ text, usage: {}, estimated: 1 });
    },
    fail(err) {
      const pending = resolvers;
      resolvers = [];
      for (const { reject } of pending) reject(err);
    },
  };
}

/** Sends the persona's own message through the handler, opening/extending the follow-up window. */
async function openFollowUpWindow(handler, { guild, channel, ts }) {
  await handler({
    system: false,
    webhookId: null,
    author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
    member: { displayName: 'Neptunia' },
    guild,
    channel,
    channelId: channel.id,
    cleanContent: 'here you go',
    createdTimestamp: ts,
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Owner commands are a separate pipeline entirely now (slash commands via
// interactionCreate, src/discord/commands.js) — this createMessageHandler
// no longer takes an `admin` dependency at all.

test('events: a DM is ignored entirely, never reaches memory or the spontaneous scheduler', async () => {
  const turns = fakeTurns();
  const spontaneous = fakeSpontaneous();
  const memory = fakeMemory();
  const handler = makeHandler({ turns, spontaneous, memory });

  const message = fakeMessage({ guild: null, channel: null, channelId: undefined });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

// /nep pause: while paused, nothing here may observe, trigger, run a
// turn or eavesdrop -- a burst of otherwise-triggering messages is a no-op.
test('events: while paused, a burst of messages triggers no observe, no trigger, no turn, no eavesdrop', async () => {
  let runTurnCalls = 0;
  const turns = fakeTurns({ runTurn: async () => { runTurnCalls += 1; return { outcome: 'spoke' }; } });
  const spontaneous = fakeSpontaneous();
  const memory = fakeMemory();
  const store = { state: { data: { paused: true } }, getUser: () => null };
  const handler = makeHandler({ turns, spontaneous, memory, store });

  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild);
  await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'plain chat' }));
  await handler(fakeMessage({
    id: 'm2',
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  }));
  await handler(fakeMessage({ id: 'm3', guild, channel, channelId: 'c1', author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' } }));

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
  assert.equal(runTurnCalls, 0);
});

test('events: a DM whose content looks like an old-style owner command is still just ignored', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ memory, spontaneous });

  const message = fakeMessage({ guild: null, channel: null, channelId: undefined, cleanContent: '/nep status' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('events: its own message notes the post and is observed, never turned into a turn', async () => {
  const turns = fakeTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, memory, spontaneous });

  const message = fakeMessage({ author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' } });
  await handler(message);

  assert.equal(turns.notePostCalls.length, 1);
  assert.deepEqual(turns.notePostCalls[0], ['c1', message.createdTimestamp]);
  assert.equal(memory.observeCalls.length, 1);
  assert.equal(memory.observeCalls[0][0], 'g1');
  assert.equal(memory.observeCalls[0][1].self, true);
});

test('events: its own limit notice notes the post but never reaches memory or opens a follow-up window', async () => {
  const turns = fakeTurns();
  const memory = fakeMemory();
  const store = fakeStateStore({});
  const handler = makeHandler({ turns, memory, store, prompts: { labels } });

  const message = fakeMessage({
    author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
    cleanContent: 'limit reached (llm.maxRequestsPerDay, 800/800)',
  });
  await handler(message);

  assert.deepEqual(turns.notePostCalls, [['c1', message.createdTimestamp]]);
  assert.equal(memory.observeCalls.length, 0);
  assert.equal(store.state.data.followUpWindows, undefined, 'no follow-up window opened');

  // An ordinary message of its own still does both.
  await handler(fakeMessage({ author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' }, cleanContent: 'τι νέα;' }));
  assert.equal(memory.observeCalls.length, 1);
  assert.ok(store.state.data.followUpWindows?.c1, 'window opened by real speech');
});

test('events: another bot is ignored entirely', async () => {
  const turns = fakeTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, memory, spontaneous });

  const message = fakeMessage({ author: { id: 'otherbot', bot: true, globalName: 'Other', username: 'other' } });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test('events: a plain message is observed and handed to the spontaneous scheduler, no turn', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns();
  const handler = makeHandler({ memory, spontaneous, turns });

  const message = fakeMessage({ cleanContent: 'ένα μήνυμα χωρίς πρόκληση' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 1);
  assert.equal(spontaneous.onMessageCalls.length, 1);
  assert.equal(spontaneous.onMessageCalls[0][0], message.channel);
  assert.equal(spontaneous.onMessageCalls[0][1].content, 'ένα μήνυμα χωρίς πρόκληση');
});

test('events: a message that looks like an old-style owner command is now just an ordinary message', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  // bot.nameTriggers is cleared explicitly: a deployment's own name triggers
  // (config.local.json, not read here) must not turn the old prefix into one.
  const config = baseConfig({ bot: { nameTriggers: [] } });
  const handler = makeHandler({ config, memory, spontaneous });

  const message = fakeMessage({ cleanContent: 'hey, old bang-prefix status command, remember that?' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 1);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('events: a mention with rng above ignoreChance runs a reply turn', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const memory = fakeMemory();
  const handler = makeHandler({ turns, memory, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  // let the fire-and-forget runTurn promise settle
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(seenArgs, 'expected runTurn to be called');
  assert.equal(seenArgs.channel, message.channel);
  assert.equal(seenArgs.mode, 'reply');
  assert.equal(seenArgs.triggerKind, 'mention');
  assert.equal(seenArgs.trigger.content, 'γεια');
  assert.equal(memory.observeCalls.length, 1);
});

test('events: a mention with rng below ignoreChance is observed but not answered', async () => {
  let called = false;
  const config = baseConfig({ mention: { ignoreChance: 0.5 } });
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const memory = fakeMemory();
  const handler = makeHandler({ config, turns, memory, rng: scripted([0.0]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(memory.observeCalls.length, 1);
});

test('events: a reply to its own message is detected as kind "reply"', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
  });
  const handler = makeHandler({ turns, rng: scripted([0.99]) });

  const message = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'έχεις δίκιο',
    reference: { messageId: 'm100' },
  });
  await handler(message);
  await Promise.resolve();

  assert.ok(seenArgs);
  assert.equal(seenArgs.triggerKind, 'reply');
});

test('events: a name trigger respects config.mention.nameTriggerChance', async () => {
  let calls = 0;
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] }, mention: { nameTriggerChance: 0.5 } });
  const turnsRespond = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const handlerRespond = makeHandler({ config, turns: turnsRespond, rng: scripted([0.1]) });
  const message1 = fakeMessage({ cleanContent: 'γεια νεπτούνια όμορφη' });
  await handlerRespond(message1);
  await Promise.resolve();
  assert.equal(calls, 1, 'rng below nameTriggerChance should respond');

  const turnsIgnore = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const handlerIgnore = makeHandler({ config, turns: turnsIgnore, rng: scripted([0.99]) });
  const message2 = fakeMessage({ cleanContent: 'γεια νεπτούνια όμορφη' });
  await handlerIgnore(message2);
  await Promise.resolve();
  assert.equal(calls, 1, 'rng above nameTriggerChance should not respond');
});

test('events: a denied channel is ignored before anything else runs', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const config = baseConfig({ bot: { channels: { deny: ['c1'] } } });
  const handler = makeHandler({ config, memory, spontaneous });

  const message = fakeMessage({ cleanContent: 'just chatting' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('events: a message from a guild other than the one this instance serves is ignored entirely', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns();
  const handler = makeHandler({ memory, spontaneous, turns, getGuildId: () => 'the-served-guild' });

  const message = fakeMessage({ guild: fakeGuild('some-other-guild'), cleanContent: 'just chatting' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test('events: a foreign-guild message is ignored even when the instance has not resolved a guild yet', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ memory, spontaneous, getGuildId: () => null });

  const message = fakeMessage();
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('events: a throwing dependency does not escape the handler', async () => {
  const memory = fakeMemory({
    observe: () => {
      throw new Error('boom');
    },
  });
  const handler = makeHandler({ memory });

  const message = fakeMessage({ cleanContent: 'οτιδήποτε' });
  await assert.doesNotReject(() => handler(message));
});

// ---------------------------------------------------------------------------
// features.* switches — each masks one input of detectTrigger, or short-
// circuits a whole side effect, without detectTrigger itself changing.

test('features.mentions=false: a plain @mention is no longer a trigger', async () => {
  let called = false;
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const config = baseConfig({ features: { mentions: false } });
  const handler = makeHandler({ config, turns, spontaneous, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('features.mentions=true (default): a plain @mention still triggers', async () => {
  let called = false;
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const handler = makeHandler({ turns, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, true);
});

test('features.replies=false: a reply to its own message is no longer a trigger by itself', async () => {
  let called = false;
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
  });
  const config = baseConfig({ features: { replies: false } });
  const handler = makeHandler({ config, turns, spontaneous, rng: scripted([0.99]) });

  const message = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'έχεις δίκιο', reference: { messageId: 'm100' } });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('features.replies=false: a reply that also pings still counts as a mention', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
  });
  const config = baseConfig({ features: { replies: false } });
  const handler = makeHandler({ config, turns, rng: scripted([0.99]) });

  const message = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'έχεις δίκιο',
    reference: { messageId: 'm100' },
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.ok(seenArgs, 'expected runTurn to be called');
  assert.equal(seenArgs.triggerKind, 'mention');
});

test('features.nameTriggers=false: a name is never a trigger, even when configured', async () => {
  let called = false;
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] }, features: { nameTriggers: false } });
  const handler = makeHandler({ config, turns, spontaneous, rng: scripted([0.1]) });

  const message = fakeMessage({ cleanContent: 'γεια νεπτούνια όμορφη' });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('features.memory=false: a regular message is never observed', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const config = baseConfig({ features: { memory: false } });
  const handler = makeHandler({ config, memory, spontaneous });

  const message = fakeMessage({ cleanContent: 'ένα απλό μήνυμα' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('features.memory=false: its own message still notes the post, but is never observed', async () => {
  const turns = fakeTurns();
  const memory = fakeMemory();
  const config = baseConfig({ features: { memory: false } });
  const handler = makeHandler({ config, turns, memory });

  const message = fakeMessage({ author: { id: 'self1', bot: true, globalName: 'Bot', username: 'bot' } });
  await handler(message);

  assert.equal(turns.notePostCalls.length, 1);
  assert.equal(memory.observeCalls.length, 0);
});

test('a config with no "features" key at all behaves as if every switch were on', async () => {
  let called = false;
  const config = baseConfig();
  delete config.features;
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const handler = makeHandler({ config, turns, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, true);
});

// ---------------------------------------------------------------------------
// relationships: `direct` on observe, affinityScore into decideMention

test('events: a triggering message is observed with direct: true', async () => {
  const memory = fakeMemory();
  const handler = makeHandler({ memory, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(memory.observeCalls.length, 1);
  assert.deepEqual(memory.observeCalls[0][2], { direct: true });
});

test('events: a non-triggering message is observed with direct: false', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ memory, spontaneous });

  const message = fakeMessage({ cleanContent: 'ένα μήνυμα χωρίς πρόκληση' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 1);
  assert.deepEqual(memory.observeCalls[0][2], { direct: false });
});

test('events: affinityScore is read from the caller\'s stored profile and passed to decideMention', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const store = fakeStore({ u1: { affinity: { score: -42 } } });
  const handler = makeHandler({ turns, store, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.ok(seenArgs, 'expected the ignore-chance to allow the turn');
  assert.ok(store.getUserCalls.some(([guildId, userId]) => guildId === 'g1' && userId === 'u1'));
});

test('features.relationships=false: affinityScore is never looked up or passed', async () => {
  const store = fakeStore({ u1: { affinity: { score: -100 } } });
  const config = baseConfig({ features: { relationships: false } });
  const handler = makeHandler({ config, store, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(store.getUserCalls.length, 0, 'store.getUser must not be called when relationships is off');
});

// ---------------------------------------------------------------------------
// isWarmingUp: the persona is mute while a memory warmup run is in
// flight.

test('events: while warming up a plain message is observed but no turn or eavesdrop happens', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns();
  const handler = makeHandler({ memory, spontaneous, turns, isWarmingUp: () => true });

  const message = fakeMessage({ cleanContent: 'ένα απλό μήνυμα' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 1);
  assert.deepEqual(memory.observeCalls[0][2], { direct: false });
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('events: while warming up a mention never runs a turn, even though it would normally trigger', async () => {
  let called = false;
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, memory, spontaneous, isWarmingUp: () => true, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(memory.observeCalls.length, 1);
  assert.deepEqual(memory.observeCalls[0][2], { direct: false });
});

test('events: while warming up, a pending ping already queued is left for a later drain', async () => {
  let muted = false;
  let seenArgs = null;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, isWarmingUp: () => muted, rng: scripted([0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  const message = directPingMessage({ guild, channel, channelId: 'c1' });
  await handler(message);

  muted = true;
  await handler.drainPending();
  assert.equal(seenArgs, null, 'the queue is left untouched while warming up');

  muted = false;
  await handler.drainPending();
  assert.ok(seenArgs, 'and answered once warming up ends');
});

test('events: isWarmingUp defaults to false when not provided (unmuted: a trigger runs a turn normally)', async () => {
  let called = false;
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const handler = makeHandler({ turns, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, true);
});

// ---------------------------------------------------------------------------
// bot.dryRunChannelId: the dry-run mirror channel (src/behavior/turn.js)
// carries the persona's own rehearsal output and is the owner's private test
// room. It goes back to being ignored entirely: nothing there is observed or
// triggers anything, not even a message that looks like an owner command
// (owner commands live in interactionCreate now, not here at all).

test('events: any message in the dry-run mirror channel is ignored entirely', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns();
  const config = baseConfig({ bot: { dryRunChannelId: 'mirror1' } });
  const channel = fakeChannel('mirror1', fakeGuild());
  const handler = makeHandler({ config, memory, spontaneous, turns });

  const message = fakeMessage({ channel, channelId: 'mirror1', cleanContent: 'just chatting, no command' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test('events: a message that looks like an owner command in the dry-run mirror channel is still just ignored', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns();
  const config = baseConfig({ bot: { dryRunChannelId: 'mirror1' } });
  const channel = fakeChannel('mirror1', fakeGuild());
  const handler = makeHandler({ config, memory, spontaneous, turns });

  const message = fakeMessage({ channel, channelId: 'mirror1', cleanContent: 'old bang-prefix admin command' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test("events: the persona's own messages mirrored into the dry-run channel are never observed", async () => {
  const memory = fakeMemory();
  const turns = fakeTurns();
  const config = baseConfig({ bot: { dryRunChannelId: 'mirror1' } });
  const channel = fakeChannel('mirror1', fakeGuild());
  const handler = makeHandler({ config, memory, turns });

  const message = fakeMessage({
    channel,
    channelId: 'mirror1',
    author: { id: 'self1', bot: true, globalName: 'Bot', username: 'bot' },
  });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test('events: an empty bot.dryRunChannelId (default) does not affect any channel', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const config = baseConfig({ bot: { dryRunChannelId: '' } });
  const handler = makeHandler({ config, memory, spontaneous });

  const message = fakeMessage({ cleanContent: 'just a plain message, no trigger' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 1);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

// ---------------------------------------------------------------------------
// features.mediaDescriptions: fire-and-forget describer pre-fetch from the
// message path (src/memory/describe.js's cache), so the live memory analyzer
// (src/memory/update.js#analyze) finds a caption already cached.

// features.videoDescriptions + media.video.prefill: a posted video is watched
// fire-and-forget, at most one per message.

function fakeVideoDescriber() {
  const base = fakeDescriber();
  const videoCalls = [];
  return {
    ...base,
    videoCalls,
    describeVideos: async (guildId, items) => {
      videoCalls.push({ guildId, items });
      return { videos: new Map(), newCount: 0 };
    },
  };
}

/** A discord.js attachments Map with `count` video entries. */
function videoAttachments(count = 1) {
  const entries = [];
  for (let i = 1; i <= count; i += 1) {
    entries.push([`v${i}`, { id: `v${i}`, contentType: 'video/mp4', name: `${i}.mp4`, url: `https://cdn.discordapp.com/x/${i}.mp4`, duration: 10 }]);
  }
  return new Map(entries);
}

test('events: media.video.prefill on watches one video per message, fire-and-forget', async () => {
  const describer = fakeVideoDescriber();
  const config = baseConfig({ features: { videoDescriptions: true }, media: { video: { prefill: true } } });
  const handler = makeHandler({ config, describer });

  await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(2) }));

  assert.equal(describer.videoCalls.length, 1);
  assert.equal(describer.videoCalls[0].guildId, 'g1');
  assert.deepEqual(
    describer.videoCalls[0].items.map((item) => item.itemId),
    ['v1'],
  );
});

test('events: a typed video-site link is prefilled too (normalizeMessage got media.video.sites)', async () => {
  const describer = fakeVideoDescriber();
  const config = baseConfig({ features: { videoDescriptions: true }, media: { video: { prefill: true, sites: ['youtube.com'] } } });
  const handler = makeHandler({ config, describer });

  await handler(fakeMessage({ cleanContent: 'regarde https://www.youtube.com/watch?v=abc' }));

  assert.equal(describer.videoCalls.length, 1);
  assert.equal(describer.videoCalls[0].items[0].source, 'link');
});

test('events: no video prefill when media.video.prefill is off, videoDescriptions is off or mediaDescriptions is off', async () => {
  for (const overrides of [
    { features: { videoDescriptions: true }, media: { video: { prefill: false } } },
    { features: { videoDescriptions: false }, media: { video: { prefill: true } } },
    { features: { mediaDescriptions: false, videoDescriptions: true }, media: { video: { prefill: true } } },
  ]) {
    const describer = fakeVideoDescriber();
    const handler = makeHandler({ config: baseConfig(overrides), describer });

    await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(1) }));

    assert.equal(describer.videoCalls.length, 0);
  }
});

test('events: features.videoDescriptions missing counts as on (mediaDescriptions on) -- the video is prefilled', async () => {
  const describer = fakeVideoDescriber();
  const config = baseConfig({ media: { video: { prefill: true } } });
  config.features.mediaDescriptions = true;
  delete config.features.videoDescriptions;
  const handler = makeHandler({ config, describer });

  await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(1) }));

  assert.equal(describer.videoCalls.length, 1);
  assert.equal(describer.videoCalls[0].items[0].itemId, 'v1');
});

test('events: a message with no video never calls describeVideos', async () => {
  const describer = fakeVideoDescriber();
  const config = baseConfig({ features: { videoDescriptions: true }, media: { video: { prefill: true } } });
  const handler = makeHandler({ config, describer });

  await handler(fakeMessage({ cleanContent: 'just words' }));

  assert.equal(describer.videoCalls.length, 0);
});

test('events: features.mediaDescriptions off makes zero describer calls from the message path', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: false } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ cleanContent: 'look at this', attachments: pictureAttachments(1) });
  await handler(message);

  assert.equal(describer.calls.length, 0);
});

test('events: features.mediaDescriptions on fires a fire-and-forget describer call for an observed human message\'s pictures', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ cleanContent: 'look at this', attachments: pictureAttachments(1) });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'a1');
});

test('events: at most 2 pictures per message are handed to the describer', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ cleanContent: 'lots of pics', attachments: pictureAttachments(3) });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items.length, 2);
});

test('events: a picture-format sticker warms the describer cache too', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]) });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'sticker:s1');
});

test('events: a custom emoji in the text warms the describer cache too', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ cleanContent: 'nice <:pog:111>' });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'emoji:111');
});

test('events: pictures come before a message\'s emoji within the shared 2-per-message cap', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({
    cleanContent: 'look <:pog:111>',
    attachments: pictureAttachments(1),
    stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]),
  });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.deepEqual(
    describer.calls[0].items.map((i) => i.itemId),
    ['a1', 'sticker:s1'],
    'the attachment and the sticker (both pictures) fill the cap before the emoji is ever considered',
  );
});

test('events: no describer wired in never throws, even with mediaDescriptions on and a picture', async () => {
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config });

  const message = fakeMessage({ cleanContent: 'look', attachments: pictureAttachments(1) });
  await assert.doesNotReject(() => handler(message));
});

test('events: the dry-run mirror channel never triggers a describer call, even with a picture', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true }, bot: { dryRunChannelId: 'mirror1' } });
  const channel = fakeChannel('mirror1', fakeGuild());
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ channel, channelId: 'mirror1', cleanContent: 'look', attachments: pictureAttachments(1) });
  await handler(message);

  assert.equal(describer.calls.length, 0);
});

test('events: while warming up, an observed human message with a picture still warms the describer cache', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer, isWarmingUp: () => true });

  const message = fakeMessage({ cleanContent: 'look', attachments: pictureAttachments(1) });
  await handler(message);

  assert.equal(describer.calls.length, 1);
});

test('events: the persona\'s own message never triggers a describer call', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({
    author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
    attachments: pictureAttachments(1),
  });
  await handler(message);

  assert.equal(describer.calls.length, 0);
});

test('events: another bot\'s message never triggers a describer call', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({
    author: { id: 'otherbot', bot: true, globalName: 'Other', username: 'other' },
    attachments: pictureAttachments(1),
  });
  await handler(message);

  assert.equal(describer.calls.length, 0);
});

test('features.memory=false: affinityScore is never looked up even when relationships is on', async () => {
  const store = fakeStore({ u1: { affinity: { score: -100 } } });
  const config = baseConfig({ features: { memory: false } });
  const handler = makeHandler({ config, store, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(store.getUserCalls.length, 0);
});

// ---------------------------------------------------------------------------
// One attention (mention.oneAtATime) -- a direct ping (mention/reply)
// that arrives while a turn is running elsewhere is remembered as pending
// instead of dropped; drainPending() (called in production once a turn
// frees its channel, see src/behavior/turn.js's setOnIdle) answers the
// oldest one through the normal reply path after a human switch pause.

function directPingMessage(overrides = {}) {
  return fakeMessage({
    id: 'm1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
    ...overrides,
  });
}

test('events: a direct ping elsewhere becomes pending and is answered after the running turn plus the switch pause', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const sleepCalls = [];
  const sleep = async (ms) => {
    sleepCalls.push(ms);
  };
  const handler = makeHandler({ turns, sleep, rng: scripted([0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  const message = directPingMessage({ guild, channel, channelId: 'c1' });
  await handler(message);

  assert.equal(seenArgs, null, 'must not run immediately while busy elsewhere');

  await handler.drainPending();

  assert.ok(seenArgs, 'expected the deferred turn to run once drained');
  assert.equal(seenArgs.channel, channel);
  assert.equal(seenArgs.mode, 'reply');
  assert.equal(seenArgs.triggerKind, 'mention');
  assert.equal(seenArgs.trigger.content, 'γεια');
  assert.deepEqual(sleepCalls, [5500], 'between(switchDelayMs=[2000,9000], rng=0.5) -- the human switch pause');
});

test('events: a name trigger elsewhere while busy is dropped, not deferred', async () => {
  let called = false;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] } });
  // No rng value queued: a name trigger must never reach decideMention while busy elsewhere.
  const handler = makeHandler({ config, turns, rng: scripted([]) });

  const message = fakeMessage({ id: 'm1', cleanContent: 'γεια νεπτούνια όμορφη' });
  await handler(message);
  assert.equal(called, false);

  await handler.drainPending();
  assert.equal(called, false, 'nothing was queued for a name trigger');
});

/**
 * Turns whose channel `c1` is busy until `.finish()`: runTurn answers 'busy' while it is, records
 * every call, and `spokeAfterSeeing` reports the ids passed in `seen`.
 */
function busyChannelTurns({ seen = [] } = {}) {
  let busy = true;
  const calls = [];
  const turns = fakeTurns({
    isBusy: (id) => busy && id === 'c1',
    isAnyBusy: () => busy,
    runTurn: async (args) => {
      calls.push(args);
      return { outcome: busy && args.channel.id === 'c1' ? 'busy' : 'spoke' };
    },
  });
  turns.spokeAfterSeeing = (channelId, messageId) => channelId === 'c1' && seen.includes(messageId);
  turns.calls = calls;
  turns.finish = () => {
    busy = false;
  };
  return turns;
}

/** tagHistory that counts its hits, to prove a deferred ping is not counted on arrival. */
function countingTagHistory() {
  const inner = createTagHistory();
  const tags = { hits: 0, hit: (...args) => ((tags.hits += 1), inner.hit(...args)) };
  return tags;
}

for (const oneAtATime of [true, false]) {
  test(`events: a mention in the channel whose turn is running is deferred, answered after it (oneAtATime=${oneAtATime})`, async () => {
    const turns = busyChannelTurns();
    const tagHistory = countingTagHistory();
    const config = baseConfig({ mention: { oneAtATime } });
    // Exactly two values: the switch pause and decideMention at drain time -- none on arrival.
    const handler = makeHandler({ config, turns, tagHistory, sleep: async () => {}, rng: scripted([0.5, 0.99]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    const { logs } = await withCapturedLogs(() => handler(directPingMessage({ guild, channel, channelId: 'c1' })));

    assert.equal(turns.calls.length, 0, 'not run against the busy channel');
    assert.equal(tagHistory.hits, 0, 'counted at drain time, not on arrival');
    const deferred = logs.find((entry) => entry.msg === 'mention: deferred');
    assert.ok(deferred, 'logged as deferred');
    assert.equal(deferred.sameChannel, true);

    turns.finish();
    await handler.drainPending();

    assert.equal(turns.calls.length, 1);
    assert.equal(turns.calls[0].channel, channel);
    assert.equal(turns.calls[0].trigger.id, 'm1');
    assert.equal(turns.calls[0].triggerKind, 'mention');
    assert.equal(tagHistory.hits, 1);
  });
}

test('events: a reply to the persona in the channel whose turn is running is deferred and answered after it', async () => {
  const turns = busyChannelTurns();
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  channel.messages.cache.set('m0', { author: { id: 'self1' } });
  await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'γεια', reference: { messageId: 'm0' } }));
  assert.equal(turns.calls.length, 0);

  turns.finish();
  await handler.drainPending();

  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].trigger.id, 'm1');
  assert.equal(turns.calls[0].triggerKind, 'reply');
});

test('events: a name trigger in the channel whose turn is running is not queued; the busy drop is logged', async () => {
  const turns = busyChannelTurns();
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] } });
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  const { logs } = await withCapturedLogs(async () => {
    await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'γεια νεπτούνια' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(turns.calls.length, 1, 'falls through to runTurn, which answers busy');
  const dropped = logs.find((entry) => entry.msg === 'mention: dropped (busy)');
  assert.ok(dropped);
  assert.equal(dropped.channel, 'c1');
  assert.equal(dropped.kind, 'name');
  assert.equal(logs.some((entry) => entry.msg === 'mention: deferred'), false);

  turns.finish();
  await handler.drainPending();
  assert.equal(turns.calls.length, 1, 'nothing was queued');
});

test('events: mention.pendingSameChannel=false restores the busy drop for a same-channel mention, read hot', async () => {
  const turns = busyChannelTurns();
  const config = baseConfig({ mention: { pendingSameChannel: false } });
  // One value: decideMention on arrival (the old path); the drain must find nothing.
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  const { logs } = await withCapturedLogs(async () => {
    await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(turns.calls.length, 1, 'decided and handed to runTurn, which answers busy');
  assert.ok(logs.some((entry) => entry.msg === 'mention: dropped (busy)' && entry.kind === 'mention'));

  turns.finish();
  await handler.drainPending();
  assert.equal(turns.calls.length, 1, 'nothing was queued');
});

test('events: a deferred ping the last speaking turn already had in view is not answered again', async () => {
  const turns = busyChannelTurns({ seen: ['m1'] });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  turns.finish();
  const { logs } = await withCapturedLogs(() => handler.drainPending());

  assert.equal(turns.calls.length, 0, 'the running turn already answered it');
  assert.ok(logs.some((entry) => entry.msg === 'mention: already answered' && entry.channel === 'c1'));
});

test('events: a newer direct ping in the same channel replaces the older pending one', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm2');
  channel.messages.cache.set('m1', {});

  await handler(directPingMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'first' }));
  await handler(directPingMessage({ id: 'm2', guild, channel, channelId: 'c1', cleanContent: 'second' }));

  await handler.drainPending();

  assert.ok(seenArgs);
  assert.equal(seenArgs.trigger.id, 'm2', 'the newer ping replaces the older one in the same channel');
  assert.equal(seenArgs.trigger.content, 'second');
});

test('events: mention.maxPending caps distinct pending channels, dropping the oldest', async () => {
  const config = baseConfig({ mention: { maxPending: 2 } });
  const answeredChannels = [];
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      answeredChannels.push(args.channel.id);
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5, 0.99]) });

  const guild = fakeGuild();
  for (const id of ['c1', 'c2', 'c3']) {
    const channel = fakeChannelWithMessage(id, guild, `m-${id}`);
    await handler(directPingMessage({ id: `m-${id}`, guild, channel, channelId: id, cleanContent: id }));
  }

  await handler.drainPending();

  assert.deepEqual(answeredChannels.sort(), ['c2', 'c3'], 'c1 (the oldest) was evicted once maxPending=2 was exceeded');
});

// /nep pause: clearPending() drops every queued ping without answering any of them.
test('events: clearPending empties the pending queue -- drainPending afterwards answers nothing', async () => {
  let called = false;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ id: 'm1', guild, channel, channelId: 'c1' }));

  handler.clearPending();
  await handler.drainPending();

  assert.equal(called, false, 'the cleared ping must never be answered');
});

test('events: a pending ping past mention.pendingMinutes is discarded, not answered', async () => {
  let called = false;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const clock = mutableNow(0);
  // No rng queued: an expired ping must be discarded before ever reaching between()/decideMention.
  const handler = makeHandler({ turns, sleep: async () => {}, now: clock, rng: scripted([]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  clock.set(11 * 60_000); // past the default 10-minute mention.pendingMinutes
  await handler.drainPending();

  assert.equal(called, false);
});

test('events: the ignore decision is rolled at pick-up time, not when the ping arrived', async () => {
  let respondedArgs = null;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      respondedArgs = args;
      return { outcome: 'spoke' };
    },
  });
  // Exactly one value for the switch-delay sample, one for decideMention -- if
  // arrival wrongly rolled decideMention too, this queue would run out and throw.
  const config = baseConfig({ mention: { ignoreChance: 0.5 } });
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await assert.doesNotReject(() => handler(directPingMessage({ guild, channel, channelId: 'c1' })));

  await handler.drainPending();

  assert.equal(respondedArgs, null, 'rng=0 at pick-up time is below the configured ignoreChance (0.5): ignored');
});

test('events: a pending ping whose message no longer exists is dropped silently', async () => {
  let called = false;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5]) });

  const guild = fakeGuild();
  // Default fakeChannel: empty cache, fetch resolves null -- the message is gone.
  const channel = fakeChannel('c1', guild);
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  await handler.drainPending();

  assert.equal(called, false);
});

test('events: a pending ping whose channel lost send permission is dropped silently', async () => {
  let called = false;
  let canSendNow = true;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1', { permissionsFor: () => ({ has: () => canSendNow }) });
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  canSendNow = false; // permission lost while the ping was pending
  await handler.drainPending();

  assert.equal(called, false);
});

test('events: several pending pings drain oldest first, one at a time (never concurrently)', async () => {
  const order = [];
  let concurrent = 0;
  let sawConcurrency = false;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      concurrent += 1;
      if (concurrent > 1) sawConcurrency = true;
      order.push(args.channel.id);
      await Promise.resolve();
      concurrent -= 1;
      return { outcome: 'spoke' };
    },
  });
  let t = 1_000_000;
  const now = () => (t += 1);
  const handler = makeHandler({ turns, sleep: async () => {}, now, rng: scripted([0.5, 0.99, 0.5, 0.99, 0.5, 0.99]) });

  const guild = fakeGuild();
  for (const id of ['c1', 'c2', 'c3']) {
    const channel = fakeChannelWithMessage(id, guild, `m-${id}`);
    await handler(directPingMessage({ id: `m-${id}`, guild, channel, channelId: id, cleanContent: id }));
  }

  await handler.drainPending();

  assert.deepEqual(order, ['c1', 'c2', 'c3'], 'oldest arrival first');
  assert.equal(sawConcurrency, false, 'never more than one deferred turn in flight at once');
});

test('events: mention.oneAtATime=false runs the turn immediately even while busy elsewhere (today\'s behaviour)', async () => {
  let called = false;
  const config = baseConfig({ mention: { oneAtATime: false } });
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ config, turns, rng: scripted([0.99]) });

  await handler(directPingMessage());
  await Promise.resolve();

  assert.equal(called, true, 'oneAtATime=false: nothing is ever deferred');
});

test('events: a hot change to mention.oneAtATime is picked up without recreating the handler', async () => {
  const config = baseConfig();
  const answeredChannels = [];
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      answeredChannels.push(args.channel.id);
      return { outcome: 'spoke' };
    },
  });
  const sleepCalls = [];
  const sleep = async (ms) => {
    sleepCalls.push(ms);
  };
  // 1st value: channel "b"'s IMMEDIATE decideMention (oneAtATime off, no delay involved).
  // 2nd value: the switch-delay sample for "a" at drain time (irrelevant here, switchDelayMs is fixed).
  // 3rd value: "a"'s decideMention at drain time.
  const handler = makeHandler({ config, turns, sleep, rng: scripted([0.5, 0.5, 0.99]) });

  const guild = fakeGuild();
  const channelA = fakeChannelWithMessage('a', guild, 'm-a');
  await handler(directPingMessage({ id: 'm-a', guild, channel: channelA, channelId: 'a', cleanContent: 'a' }));
  assert.equal(answeredChannels.length, 0, 'oneAtATime true (default): deferred, not run immediately');

  config.mention.oneAtATime = false;
  const channelB = fakeChannelWithMessage('b', guild, 'm-b');
  await handler(directPingMessage({ id: 'm-b', guild, channel: channelB, channelId: 'b', cleanContent: 'b' }));
  await Promise.resolve();
  assert.deepEqual(answeredChannels, ['b'], 'oneAtATime=false: runs immediately, ignoring busy elsewhere');

  config.mention.oneAtATime = true;
  config.mention.switchDelayMs = [1234, 1234];
  await handler.drainPending();
  assert.deepEqual(sleepCalls, [1234], 'the new switchDelayMs is read fresh at drain time');
  assert.deepEqual(answeredChannels.sort(), ['a', 'b'], 'the earlier pending ping for "a" is still answered once re-enabled');
});

test('events: a hot change to mention.pendingMinutes is picked up (a shorter window expires sooner)', async () => {
  let called = false;
  const config = baseConfig();
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const clock = mutableNow(0);
  const handler = makeHandler({ config, turns, sleep: async () => {}, now: clock, rng: scripted([]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  config.mention.pendingMinutes = 1; // was 10
  clock.set(90_000); // 1.5 minutes later -- expired only under the new, shorter window
  await handler.drainPending();

  assert.equal(called, false);
});

test('events: a hot change to mention.maxPending is picked up', async () => {
  const config = baseConfig({ mention: { maxPending: 1 } });
  const answeredChannels = [];
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      answeredChannels.push(args.channel.id);
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5, 0.99]) });

  const guild = fakeGuild();
  const channelA = fakeChannelWithMessage('a', guild, 'm-a');
  await handler(directPingMessage({ id: 'm-a', guild, channel: channelA, channelId: 'a', cleanContent: 'a' }));

  config.mention.maxPending = 2; // raise the cap live, before "b" arrives
  const channelB = fakeChannelWithMessage('b', guild, 'm-b');
  await handler(directPingMessage({ id: 'm-b', guild, channel: channelB, channelId: 'b', cleanContent: 'b' }));

  await handler.drainPending();

  assert.deepEqual(answeredChannels.sort(), ['a', 'b'], 'both fit once the cap was raised live, so "a" was never evicted');
});

// A turn that starts during the drain's switch pause makes the drain's
// runTurn answer 'busy': the picked-up ping goes back into the queue (its
// original arrivedAt kept, its `respond` decision carried) and the pass stops
// until the running turn ends and calls drainPending again.

/**
 * Turns where another channel ('other') is running a turn while `busy` is set: runTurn answers
 * 'busy' then (one attention), records every call. `startDuringPause()` is meant for the
 * injected sleep: the first switch pause starts that other turn.
 */
function pauseRaceTurns() {
  const state = { busy: true };
  const calls = [];
  const turns = fakeTurns({
    isBusy: (id) => state.busy && id === 'other',
    isAnyBusy: () => state.busy,
    runTurn: async (args) => {
      calls.push(args);
      return { outcome: state.busy ? 'busy' : 'spoke' };
    },
  });
  turns.calls = calls;
  turns.state = state;
  return turns;
}

test('events: a drained ping whose turn finds another one running is re-queued and answered on the next drain, decided once', async () => {
  const turns = pauseRaceTurns();
  const tagHistory = countingTagHistory();
  let pauses = 0;
  const sleep = async () => {
    pauses += 1;
    if (pauses === 1) turns.state.busy = true; // a fresh turn starts during the first switch pause
  };
  // Exactly three values: switch pause, decideMention, switch pause on the retry -- a second roll would run out.
  const handler = makeHandler({ turns, tagHistory, sleep, rng: scripted([0.5, 0.99, 0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  assert.equal(turns.calls.length, 0, 'deferred');

  turns.state.busy = false;
  const first = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 1, 'one attempt, answered busy');
  const again = first.logs.find((entry) => entry.msg === 'mention: deferred again (busy)');
  assert.ok(again, 'the re-queue is logged');
  assert.equal(again.channel, 'c1');
  assert.equal(again.kind, 'mention');
  assert.equal(again.pending, 1);

  turns.state.busy = false; // the other turn ends; its onIdle drains again
  const second = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 2);
  assert.equal(turns.calls[1].trigger.id, 'm1');
  assert.equal(turns.calls[1].triggerKind, 'mention');
  assert.equal(tagHistory.hits, 1, 'counted toward spamThreshold once');
  const decided = [...first.logs, ...second.logs].filter((entry) => entry.msg === 'mention: decided');
  assert.equal(decided.length, 1, 'one decision for the ping');
  assert.equal(pauses, 2, 'the switch pause stays on the retry');
});

test('events: a re-queued ping keeps its original arrivedAt and expires mention.pendingMinutes after it', async () => {
  const turns = pauseRaceTurns();
  const clock = mutableNow(0);
  const sleep = async () => {
    turns.state.busy = true;
  };
  const handler = makeHandler({ turns, sleep, now: clock, rng: scripted([0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  turns.state.busy = false;
  clock.set(5 * 60_000);
  await handler.drainPending();
  assert.equal(turns.calls.length, 1, 'busy, re-queued');

  turns.state.busy = false;
  clock.set(10 * 60_000); // 10 minutes after the ORIGINAL arrival, 5 after the re-queue
  const { logs } = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 1, 'not answered');
  assert.ok(logs.some((entry) => entry.msg === 'mention: expired' && entry.channel === 'c1'));
});

test('events: a newer ping queued in the same channel during the switch pause wins over the re-queued one', async () => {
  const turns = pauseRaceTurns();
  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  channel.messages.cache.set('m2', {});
  let handler = null;
  let pauses = 0;
  const sleep = async () => {
    pauses += 1;
    if (pauses !== 1) return;
    turns.state.busy = true;
    await handler(directPingMessage({ id: 'm2', guild, channel, channelId: 'c1', cleanContent: 'second' }));
  };
  const tagHistory = countingTagHistory();
  handler = makeHandler({ turns, tagHistory, sleep, rng: scripted([0.5, 0.99, 0.5, 0.99]) });

  await handler(directPingMessage({ guild, channel, channelId: 'c1', cleanContent: 'first' }));
  turns.state.busy = false;
  const first = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 1);
  const dropped = first.logs.find((entry) => entry.msg === 'mention: dropped (newer)');
  assert.ok(dropped, 'the old ping is dropped with a log line');
  assert.equal(dropped.channel, 'c1');
  assert.equal(first.logs.some((entry) => entry.msg === 'mention: deferred again (busy)'), false);

  turns.state.busy = false;
  await handler.drainPending();
  assert.deepEqual(turns.calls.map((c) => c.trigger.id), ['m1', 'm2'], 'm1 tried once, then the newer m2 answered');
  assert.equal(tagHistory.hits, 2, 'm2 is a separate call, decided on its own');
});

test('events: one busy result is one runTurn attempt per drain pass (no tight loop)', async () => {
  const turns = pauseRaceTurns();
  const sleep = async () => {
    turns.state.busy = true; // another turn starts during every pause and never ends here
  };
  const handler = makeHandler({ turns, sleep, rng: () => 0.99 });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  turns.state.busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 1);
  turns.state.busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 2, 'still queued, one attempt per pass');
});

test('events: a busy result when nothing is busy any more continues the same pass', async () => {
  let attempts = 0;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => false, // the blocking turn already ended by the time the drain looks
    runTurn: async () => {
      attempts += 1;
      return { outcome: attempts === 1 ? 'busy' : 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  // Queue it: busy elsewhere on arrival.
  turns.isAnyBusy = () => true;
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  turns.isAnyBusy = () => false;

  await handler.drainPending();
  assert.equal(attempts, 2, 'retried in the same pass, answered');
});

test('events: an onIdle drain arriving while the busy drain is still finishing does not strand the re-queued ping', async () => {
  const state = { busy: false };
  const calls = [];
  let handler = null;
  let idleDrain = null;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => state.busy,
    runTurn: async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        // The blocking turn ends right away and fires onIdle before the drain sees the result.
        Promise.resolve().then(() => {
          state.busy = false;
          idleDrain = handler.drainPending();
        });
        return { outcome: 'busy' };
      }
      return { outcome: 'spoke' };
    },
  });
  handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  state.busy = true;
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  state.busy = true; // still busy while the drain's turn is refused

  await handler.drainPending();
  await idleDrain;
  assert.equal(calls.length, 2, 'the re-queued ping was answered');
});

// ---------------------------------------------------------------------------
// The address classifier (features.followUp) -- an untagged follow-up
// message inside a window the persona opened by answering is checked by
// address.md before it is (or is not) answered.

test('follow-up: the classifier request is address.md as system and a <candidate> block in the user message', async () => {
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const history = [rawHistoryMessage({ id: 'h1', authorId: 'u1', authorName: 'Alice', ts: t0, content: 'earlier message' })];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const msg = fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(llm.calls.length, 1);
  const [{ messages, options }] = llm.calls;
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('Neptunia'), 'the {{name}} placeholder is filled');
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.includes('<candidate>'));
  assert.ok(messages[1].content.includes('is this for you'));
  assert.ok(messages[1].content.includes('earlier message'), 'the channel context is included');
  assert.equal(options.maxOutputTokens, 8, 'mention.followUpMaxOutputTokens');
  assert.equal(options.model, 'anthropic/claude-sonnet-4.6', 'the shipped classifier.text');
  assert.equal(options.role, 'classifier.text', 'routed as the text classifier');
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.skipCalibration, true);

  llm.respond('no');
  await p;
});

test('follow-up: the address classifier uses classifier.text over the deprecated llm.classifierModel and mention.followUpModel', async () => {
  const llm = fakeFollowUpLlm();
  const config = baseConfig({ classifier: { text: 'x/classifier' }, llm: { classifierModel: 'x/old' }, mention: { followUpModel: 'x/older' } });
  const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const p = handler(fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.model, 'x/classifier');

  llm.respond('no');
  await p;
});

test('follow-up: the address classifier ignores a deprecated llm.classifierModel when classifier.text is null', async () => {
  const llm = fakeFollowUpLlm();
  const config = baseConfig({ classifier: { text: null }, llm: { classifierModel: 'x/old' }, mention: { followUpModel: 'x/older' } });
  const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const p = handler(fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.model, config.classifier.media, 'classifier.media, never the deprecated key');

  llm.respond('no');
  await p;
});

test('follow-up: the address classifier ignores a deprecated mention.followUpModel when classifier.text and llm.classifierModel are null', async () => {
  const llm = fakeFollowUpLlm();
  const config = baseConfig({ classifier: { text: null }, llm: { classifierModel: null }, mention: { followUpModel: 'x/older' } });
  const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const p = handler(fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.model, config.classifier.media, 'classifier.media, never the deprecated key');

  llm.respond('no');
  await p;
});

test('follow-up: classifier.text null falls back to classifier.media', async () => {
  const llm = fakeFollowUpLlm();
  const config = baseConfig({ classifier: { text: null } });
  const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const p = handler(fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.model, config.classifier.media, 'classifier.text=null falls back to classifier.media');

  llm.respond('no');
  await p;
});

test('follow-up: the classifier system prompt carries the bare display name, no braces around it', async () => {
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild('g1', 'Nepτune');
  const t0 = Date.now();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const msg = fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(llm.calls.length, 1);
  const system = llm.calls[0].messages[0].content;
  assert.ok(system.startsWith('You are Nepτune. '), 'the {{name}} placeholder is replaced whole');
  assert.ok(!system.includes('{') && !system.includes('}'), 'no brace is left around the name');

  llm.respond('no');
  await p;
});

test('follow-up: the window opens on send and expires after followUpMinutes', async () => {
  const clock = mutableNow(0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });

  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  const msg1 = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up', createdTimestamp: clock() });
  const p1 = handler(msg1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'inside the window, a plain message reaches the classifier');
  llm.respond('no');
  await p1;

  clock.set(16 * 60_000); // past the default followUpMinutes=15
  const msg2 = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'too late',
    createdTimestamp: clock(),
    author: { id: 'u2', bot: false, globalName: 'Bob', username: 'bob' },
  });
  await handler(msg2);

  assert.equal(llm.calls.length, 1, 'once the window expired, the classifier is not consulted again');
  assert.equal(spontaneous.onMessageCalls.length, 1, 'the expired-window message falls back to the spontaneous scheduler');
});

test('follow-up: a reply to another member reaches the classifier like plain text', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'replying to someone else',
    reference: { messageId: 'm-other' },
  });
  const pending = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'a reply to another member is asked about');
  llm.respond('no');
  await pending;
  assert.equal(spontaneous.onMessageCalls.length, 0, 'handled by the classifier, not handed to spontaneous');
});

test('follow-up: a reply carrying only the implicit reply ping reaches the classifier', async () => {
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    content: 'and what do you think',
    cleanContent: 'and what do you think',
    reference: { messageId: 'm-other' },
    mentions: { users: new Map([['u2', { id: 'u2' }]]), repliedUser: { id: 'u2' } },
  });
  const pending = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'the reply ping is not a mention of another member');
  llm.respond('no');
  await pending;
});

test('follow-up: a reply that also mentions a third member is "no" without consulting the model', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  await handler(fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    content: '<@u3> look at this',
    cleanContent: '@Carol look at this',
    reference: { messageId: 'm-other' },
    mentions: { users: new Map([['u2', { id: 'u2' }], ['u3', { id: 'u3' }]]), repliedUser: { id: 'u2' } },
  }));

  assert.equal(llm.calls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0, 'handled by the pre-filter, not handed to spontaneous');
});

test('follow-up: mention.followUpClassifyReplies=false pre-filters any reply, read hot', async () => {
  const config = baseConfig({ mention: { followUpClassifyReplies: false } });
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const reply = (id) =>
    fakeMessage({ id, guild, channel, channelId: 'c1', cleanContent: 'replying to someone else', reference: { messageId: 'm-other' } });
  await handler(reply('m1'));
  assert.equal(llm.calls.length, 0, 'switch off: a reply never reaches the model');
  assert.equal(spontaneous.onMessageCalls.length, 0);

  config.mention.followUpClassifyReplies = true;
  const pending = handler(reply('m2'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'switched back on without recreating the handler');
  llm.respond('no');
  await pending;
});

test('follow-up: a mention of another member is "no" without consulting the model', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: '@Bob check this out',
    mentions: { users: new Map([['u2', { id: 'u2' }]]) },
  });
  await handler(msg);

  assert.equal(llm.calls.length, 0, 'a mention of another member never reaches the model');
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: a "yes" verdict runs a reply turn with the candidate as the target', async () => {
  const llm = fakeFollowUpLlm();
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'so what do you think' });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.respond('yes');
  await p;

  assert.ok(seenArgs, 'expected the reply turn to run');
  assert.equal(seenArgs.mode, 'reply');
  assert.equal(seenArgs.triggerKind, 'followUp');
  assert.equal(seenArgs.trigger.id, 'm-candidate', 'the candidate is the target, so replyTo works');
  assert.equal(seenArgs.trigger.content, 'so what do you think');
  assert.equal(seenArgs.channel, channel);
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: three "no" verdicts in a row close the window (the default followUpNoStreak)', async () => {
  const clock = mutableNow(0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  for (let i = 0; i < 3; i += 1) {
    const msg = fakeMessage({ id: `m${i}`, guild, channel, channelId: 'c1', cleanContent: `plain ${i}`, createdTimestamp: clock() });
    const p = handler(msg);
    await new Promise((resolve) => setTimeout(resolve, 0));
    llm.respond('no');
    await p;
  }
  assert.equal(llm.calls.length, 3);
  assert.equal(spontaneous.onMessageCalls.length, 0, 'every one of the 3 was still handled by the classifier itself');

  const msg4 = fakeMessage({ id: 'm4', guild, channel, channelId: 'c1', cleanContent: 'plain 4', createdTimestamp: clock() });
  await handler(msg4);

  assert.equal(llm.calls.length, 3, 'the window is closed now, the classifier is not consulted a 4th time');
  assert.equal(spontaneous.onMessageCalls.length, 1, 'falls back to the spontaneous scheduler once the window is closed');
});

test('follow-up: a missing prompts.address is a "no" without calling the model', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const prompts = { ...fakeAddressPrompts(), address: undefined };
  const handler = makeHandler({ spontaneous, llm, prompts });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up' });
  await handler(msg);

  assert.equal(llm.calls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0, 'still handled (as a no), not handed to spontaneous');
});

test('follow-up: an LLM error is a "no", never thrown', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up' });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.fail(new Error('boom'));
  await assert.doesNotReject(() => p);

  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: a DailyCapError from the LLM is a "no" too (the request never actually left)', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up' });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.fail(new DailyCapError('daily LLM request cap reached (300)'));
  await assert.doesNotReject(() => p);

  assert.equal(spontaneous.onMessageCalls.length, 0, 'still handled as a "no", not handed to spontaneous');
});

test('features.followUp=false: an open window is never consulted, falls back to spontaneous', async () => {
  const config = baseConfig({ features: { followUp: false } });
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up' });
  await handler(msg);

  assert.equal(llm.calls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('follow-up: a message that carries a trigger is never sent to the classifier, even inside an open window', async () => {
  const llm = fakeFollowUpLlm();
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, llm, prompts: fakeAddressPrompts(), rng: scripted([0.99]) });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(msg);
  await Promise.resolve();

  assert.equal(llm.calls.length, 0, 'the normal trigger path never touches the classifier');
  assert.ok(seenArgs, 'the normal mention path still runs a turn');
  assert.equal(seenArgs.triggerKind, 'mention');
});

test('follow-up: at most one classifier call in flight per channel', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg1 = fakeMessage({
    id: 'm1',
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'first',
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
  });
  const p1 = handler(msg1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1);

  const msg2 = fakeMessage({
    id: 'm2',
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'second',
    author: { id: 'u2', bot: false, globalName: 'Bob', username: 'bob' },
  });
  await handler(msg2); // must not start a second classifier call while the first is in flight

  assert.equal(llm.calls.length, 1, 'the second message found a call already in flight for this channel');
  assert.equal(spontaneous.onMessageCalls.length, 0, 'left alone entirely, not handed to spontaneous either');

  llm.respond('no');
  await p1;
});

/** A plain untagged message in channel c1 from `authorId`. */
function plainFollowUpMessage({ id, guild, channel, content, authorId = 'u2', authorName = 'Bob', ts = Date.now() }) {
  return fakeMessage({
    id,
    guild,
    channel,
    channelId: channel.id,
    cleanContent: content,
    createdTimestamp: ts,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName.toLowerCase() },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('follow-up: a message arriving while a call is in flight is classified after a "no"', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const { logs } = await withCapturedLogs(async () => {
    const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'forwarded picture', authorId: 'u1', authorName: 'Alice' }));
    await tick();
    assert.equal(llm.calls.length, 1);

    const handled = await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'what do you make of this' }));
    assert.equal(handled, undefined, 'onMessage itself returns nothing');
    assert.equal(llm.calls.length, 1, 'no second call while the first is in flight');

    llm.respond('no');
    await p1;
    await tick();

    assert.equal(llm.calls.length, 2, 'the held message is classified once the "no" came back');
    const user = llm.calls[1].messages[1].content;
    assert.match(user, /<candidate>[\s\S]*what do you make of this[\s\S]*<\/candidate>/);

    llm.respond('no');
    await tick();
  });

  assert.equal(spontaneous.onMessageCalls.length, 0, 'neither message is handed to the spontaneous scheduler');
  const verdicts = logs.filter((e) => e.msg === 'follow-up: verdict');
  assert.deepEqual(
    verdicts.map((e) => e.author),
    ['u1', 'u2'],
    'each classified message logs its own verdict',
  );
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('what do you make of this'), 'no message content in the logs');
  assert.ok(!serialized.includes('forwarded picture'), 'no message content in the logs');
});

test('follow-up: a message held during the call is discarded after a "yes" (the turn reads it in the history)', async () => {
  const llm = fakeFollowUpLlm();
  const turnTargets = [];
  const turns = fakeTurns({
    runTurn: async (args) => {
      turnTargets.push(args.trigger.id);
      return { outcome: 'spoke' };
    },
  });
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));

  llm.respond('yes');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'the held message is not classified after a "yes"');
  assert.deepEqual(turnTargets, ['m1'], 'one turn, for the message that got the "yes"');
  assert.equal(spontaneous.onMessageCalls.length, 0);

  // The slot is free again: the next plain message is classified as usual.
  const p3 = handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'third' }));
  await tick();
  assert.equal(llm.calls.length, 2);
  llm.respond('no');
  await p3;
});

test('follow-up: only the latest of several messages held during one call is classified', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
  await handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'third', authorId: 'u3', authorName: 'Chloé' }));
  assert.equal(llm.calls.length, 1);

  llm.respond('no');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 2, 'one follow-up call, not one per held message');
  const user = llm.calls[1].messages[1].content;
  assert.match(user, /<candidate>[\s\S]*third[\s\S]*<\/candidate>/);
  assert.doesNotMatch(user, /<candidate>[\s\S]*second[\s\S]*<\/candidate>/);

  llm.respond('no');
  await tick();
  await tick();
  assert.equal(llm.calls.length, 2, 'the replaced message is never classified');
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: a held message is dropped when the window expired by the time the call ends', async () => {
  const clock = mutableNow(0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice', ts: clock() }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second', ts: clock() }));

  clock.set(16 * 60_000); // past the default followUpMinutes=15
  llm.respond('no');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'the window closed meanwhile: the held message is not classified');
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: a held message is dropped when a "no" streak closed the window', async () => {
  const config = baseConfig({ mention: { followUpNoStreak: 1 } });
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
  llm.respond('no');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'the one "no" closed the window, nothing left to classify');
});

test('follow-up: a held message is dropped when the channel is busy by the time the call ends', async () => {
  let busy = false;
  const turns = fakeTurns({ isBusy: () => busy });
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));

  busy = true;
  llm.respond('no');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'a turn is running in the channel: the held message is not classified');
  assert.equal(spontaneous.onMessageCalls.length, 0);

  // Nothing stays held: once the channel is free, a new message is classified on its own.
  busy = false;
  const p3 = handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'third' }));
  await tick();
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].messages[1].content, /<candidate>[\s\S]*third/);
  llm.respond('no');
  await p3;
  await tick();
  assert.equal(llm.calls.length, 2);
});

test('follow-up: a held message is dropped when the bot was paused meanwhile, nothing marked dirty', async () => {
  const store = fakeStateStore();
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ store, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
  llm.respond('no');
  store.state.data.paused = true;
  const dirtyBefore = store.dirtyCount;
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'paused: the held message is not classified');
  assert.equal(store.dirtyCount - dirtyBefore, 1, 'only the in-flight "no" bumped the streak, the held one did not');
});

test('follow-up: a hot change to mention.followUpMinutes is picked up without recreating the handler', async () => {
  const clock = mutableNow(0);
  const config = baseConfig();
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  config.mention.followUpMinutes = 1; // was 15

  clock.set(90_000); // 1.5 min: inside the old default, past the new shorter one
  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up' });
  await handler(msg);

  assert.equal(llm.calls.length, 0, 'the shorter window (read live) had already expired');
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Follow-up windows survive a restart: mirrored into store.state.data.followUpWindows.

/** A fakeStore with a real-shaped `state` ({ data, markDirty }) that counts markDirty calls. */
function fakeStateStore(data = {}) {
  const store = fakeStore();
  store.dirtyCount = 0;
  store.state = {
    data,
    markDirty() {
      store.dirtyCount += 1;
    },
  };
  return store;
}

test('follow-up persistence: an open window survives a re-created handler with the same state', async () => {
  const clock = mutableNow(10_000);
  const store = fakeStateStore();
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  const first = makeHandler({ store, now: clock, llm: fakeFollowUpLlm(), prompts: fakeAddressPrompts() });
  await openFollowUpWindow(first, { guild, channel, ts: clock() });

  assert.deepEqual(store.state.data.followUpWindows, { c1: { openedAt: 10_000, lastAnswerAt: 10_000, noStreak: 0 } });
  assert.ok(store.dirtyCount > 0, 'opening a window marks the state dirty');

  clock.set(40_000); // "restart" half a minute later, well inside followUpMinutes=15
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const second = makeHandler({ store, spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up', createdTimestamp: clock() });
  const p = second(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'the restored window sends the untagged message to the classifier');
  llm.respond('no');
  await p;

  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(store.state.data.followUpWindows.c1.noStreak, 1, 'the streak change is mirrored too');
});

test('follow-up persistence: an expired window is dropped on load', async () => {
  const store = fakeStateStore({
    followUpWindows: {
      old: { openedAt: 0, lastAnswerAt: 0, noStreak: 0 },
      fresh: { openedAt: 950_000, lastAnswerAt: 950_000, noStreak: 1 },
    },
  });
  const clock = mutableNow(960_000); // 16 min: past followUpMinutes=15 for "old", 10 s for "fresh"
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ store, spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });

  assert.deepEqual(Object.keys(store.state.data.followUpWindows), ['fresh'], 'the expired key is deleted from state');
  assert.ok(store.dirtyCount > 0);

  const guild = fakeGuild();
  const oldChannel = fakeChannelWithHistory('old', guild, []);
  await handler(fakeMessage({ guild, channel: oldChannel, channelId: 'old', cleanContent: 'plain', createdTimestamp: clock() }));
  assert.equal(llm.calls.length, 0, 'the dropped window is not consulted');
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('follow-up persistence: closing the window by the "no" streak removes its key from state', async () => {
  const clock = mutableNow(0);
  const store = fakeStateStore();
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ store, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  for (let i = 0; i < 3; i += 1) {
    const p = handler(fakeMessage({ id: `m${i}`, guild, channel, channelId: 'c1', cleanContent: `plain ${i}`, createdTimestamp: clock() }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    llm.respond('no');
    await p;
  }

  assert.equal(Object.hasOwn(store.state.data.followUpWindows, 'c1'), false, 'the closed window is gone from state');
});

test('follow-up persistence: an expired window is removed from state when next consulted', async () => {
  const clock = mutableNow(0);
  const store = fakeStateStore();
  const handler = makeHandler({ store, now: clock, llm: fakeFollowUpLlm(), prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  clock.set(16 * 60_000); // past the default followUpMinutes=15
  await handler(fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'too late', createdTimestamp: clock() }));

  assert.equal(Object.hasOwn(store.state.data.followUpWindows, 'c1'), false);
});

test('follow-up persistence: no message text ever reaches the state', async () => {
  const clock = mutableNow(0);
  const store = fakeStateStore();
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ store, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });
  const p = handler(fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'ένα μυστικό μήνυμα', createdTimestamp: clock() }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.respond('no');
  await p;

  const saved = store.state.data.followUpWindows.c1;
  assert.deepEqual(Object.keys(saved).sort(), ['lastAnswerAt', 'noStreak', 'openedAt']);
  for (const value of Object.values(saved)) assert.equal(typeof value, 'number');
  const json = JSON.stringify(store.state.data);
  assert.ok(!json.includes('μυστικό') && !json.includes('here you go'), 'neither the member\'s nor the persona\'s text is stored');
});

// ---------------------------------------------------------------------------
// features.webLookup + web.links.prefill: a posted link is read
// fire-and-forget, at most one per message, never a video-site or gif link.

function fakeLookup() {
  const readCalls = [];
  return {
    readCalls,
    readLinks: async (guildId, links, options) => {
      readCalls.push({ guildId, links, options });
      return { reads: new Map(), newCount: 0 };
    },
  };
}

const LINK_EMBEDS = [
  { url: 'https://www.youtube.com/watch?v=abc', title: 'v', provider: { name: 'YouTube' } },
  { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } },
  { url: 'https://example.org/a', title: 'Crêpes' },
  { url: 'https://example.org/b', title: 'Galettes' },
];

function webConfig(overrides = {}) {
  return baseConfig(deepMerge({ features: { webLookup: true }, web: { links: { enabled: true, prefill: true } } }, overrides));
}

test('events: web.links.prefill on reads the first readable link of a message, fire-and-forget', async () => {
  const lookup = fakeLookup();
  const handler = makeHandler({ config: webConfig(), lookup });

  await handler(fakeMessage({ id: 'm1', cleanContent: 'κοίτα', embeds: LINK_EMBEDS }));

  assert.equal(lookup.readCalls.length, 1);
  assert.equal(lookup.readCalls[0].guildId, 'g1');
  assert.deepEqual(
    lookup.readCalls[0].links.map((link) => link.url),
    ['https://example.org/a'],
    'the video-site and gif embeds are skipped, one link only',
  );
});

test('events: no link prefill when webLookup is off or missing, links are disabled or prefill is off', async () => {
  const missing = webConfig();
  delete missing.features.webLookup;
  for (const config of [
    webConfig({ features: { webLookup: false } }),
    missing,
    webConfig({ web: { links: { enabled: false } } }),
    webConfig({ web: { links: { prefill: false } } }),
    baseConfig(),
  ]) {
    const lookup = fakeLookup();
    const handler = makeHandler({ config, lookup });
    await handler(fakeMessage({ id: 'm1', cleanContent: 'κοίτα', embeds: LINK_EMBEDS }));
    assert.equal(lookup.readCalls.length, 0);
  }
});

/** A lookup whose every prefill read is a new fetch attempt (newCount = the links it was allowed). */
function attemptingLookup({ attempted = true } = {}) {
  const readCalls = [];
  return {
    readCalls,
    readLinks: async (guildId, links, options) => {
      readCalls.push({ guildId, links, options });
      return { reads: new Map(), newCount: attempted ? Math.min(links.length, options?.maxNew ?? Infinity) : 0 };
    },
  };
}

/** A message from `authorId` carrying one readable link of its own. */
function linkMessage(id, authorId) {
  return fakeMessage({
    id,
    cleanContent: 'κοίτα',
    author: { id: authorId, bot: false, globalName: authorId, username: authorId },
    embeds: [{ url: `https://example.org/${id}`, title: 'Crêpes' }],
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('events: link prefill is capped per member per day by web.links.prefillPerUserPerDay; others are unaffected', async () => {
  const lookup = attemptingLookup();
  const handler = makeHandler({ config: webConfig({ web: { links: { prefillPerUserPerDay: 2 } } }), lookup, now: () => Date.UTC(2026, 8, 20, 10) });
  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    await handler(linkMessage(id, 'u1'));
    await settle();
  }
  assert.deepEqual(lookup.readCalls.map((c) => c.links[0].url), ['https://example.org/m1', 'https://example.org/m2']);
  assert.ok(lookup.readCalls.every((c) => c.options.maxNew === 1));

  await handler(linkMessage('m5', 'u2'));
  await settle();
  assert.equal(lookup.readCalls.length, 3, 'another member still gets a prefill');
  assert.equal(lookup.readCalls[2].links[0].url, 'https://example.org/m5');
});

test('events: the per-member prefill count resets on a new UTC day', async () => {
  let now = Date.UTC(2026, 8, 20, 23, 59);
  const lookup = attemptingLookup();
  const handler = makeHandler({ config: webConfig({ web: { links: { prefillPerUserPerDay: 1 } } }), lookup, now: () => now });
  await handler(linkMessage('m1', 'u1'));
  await settle();
  await handler(linkMessage('m2', 'u1'));
  await settle();
  assert.equal(lookup.readCalls.length, 1);
  now = Date.UTC(2026, 8, 21, 0, 1);
  await handler(linkMessage('m3', 'u1'));
  await settle();
  assert.equal(lookup.readCalls.length, 2);
});

test('events: a prefill that fetched nothing new (a cache hit) does not count toward the member limit', async () => {
  const lookup = attemptingLookup({ attempted: false });
  const handler = makeHandler({ config: webConfig({ web: { links: { prefillPerUserPerDay: 1 } } }), lookup });
  for (const id of ['m1', 'm2', 'm3']) {
    await handler(linkMessage(id, 'u1'));
    await settle();
  }
  assert.equal(lookup.readCalls.length, 3);
});

test('events: prefillPerUserPerDay 0 turns the link prefill off; a missing key means 10', async () => {
  const off = attemptingLookup();
  const offHandler = makeHandler({ config: webConfig({ web: { links: { prefillPerUserPerDay: 0 } } }), lookup: off });
  await offHandler(linkMessage('m1', 'u1'));
  await settle();
  assert.equal(off.readCalls.length, 0);

  const config = webConfig();
  delete config.web.links.prefillPerUserPerDay;
  const byDefault = attemptingLookup();
  const handler = makeHandler({ config, lookup: byDefault });
  for (let i = 0; i < 12; i += 1) {
    await handler(linkMessage(`n${i}`, 'u1'));
    await settle();
  }
  assert.equal(byDefault.readCalls.length, 10);
});

test('events: config.json ships web.links.prefillPerUserPerDay = 10', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.web.links.prefillPerUserPerDay, 10);
});

test('events: a message with no readable link never calls readLinks; a lookup failure is swallowed', async () => {
  const lookup = fakeLookup();
  await makeHandler({ config: webConfig(), lookup })(fakeMessage({ id: 'm1', cleanContent: 'just words' }));
  assert.equal(lookup.readCalls.length, 0);

  const failing = { readLinks: async () => { throw new Error('boom'); } };
  await makeHandler({ config: webConfig(), lookup: failing })(fakeMessage({ id: 'm2', cleanContent: 'κοίτα', embeds: LINK_EMBEDS }));
  await new Promise((resolve) => setImmediate(resolve));
});

// ---------------------------------------------------------------------------
// Private chat (features.privateMessages): a DM from a member of the served
// guild runs through privateGate (src/behavior/private.js) and, when it
// passes, a reply turn with the pinned guildId. Limit notices: a triggered
// turn refused by a rail gets one plain line naming the limit.

const TODAY = '2026-09-29';
const TODAY_MS = Date.parse(`${TODAY}T12:00:00Z`);

function privateConfig(overrides = {}) {
  return baseConfig(deepMerge({ features: { privateMessages: true }, bot: { owners: ['owner1'] } }, overrides));
}

function fakeDmChannel(id = 'dm1', recipientId = 'u1', overrides = {}) {
  const sent = [];
  return {
    id,
    type: 'DM',
    guild: null,
    recipientId,
    sent,
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent${sent.length}` };
    },
    messages: { cache: new Map([['dm-m1', {}]]), fetch: async () => ({}) },
    ...overrides,
  };
}

function fakeDmMessage(overrides = {}) {
  const channel = overrides.channel ?? fakeDmChannel();
  return fakeMessage({ id: 'dm-m1', guild: null, member: null, channel, channelId: channel.id, cleanContent: 'γεια σου', ...overrides });
}

/** A client whose served guild knows `members` (cache) and can fetch `fetchable` ones. */
function fakeDmClient({ members = ['u1', 'owner1'], fetchable = [] } = {}) {
  const fetchCalls = [];
  const guild = {
    id: 'g1',
    members: {
      me: { displayName: 'Ζωή' },
      cache: new Map(members.map((id) => [id, { id }])),
      fetch: async (id) => {
        fetchCalls.push(id);
        if (fetchable.includes(id)) return { id };
        throw new Error('Unknown Member');
      },
    },
  };
  return { user: { id: 'self1', username: 'Neptunia' }, guilds: { cache: new Map([['g1', guild]]) }, fetchCalls };
}

/** A store with public profiles and private files; records the private bookkeeping calls. */
function fakePrivateStore({ profiles = { u1: { affinity: { score: 10 } }, owner1: { affinity: { score: -50 } } }, privates = {} } = {}) {
  const bumps = [];
  const noticed = [];
  return {
    state: { data: {} },
    getUser: (guildId, userId) => profiles[userId] ?? null,
    getPrivate: (guildId, userId) => privates[userId] ?? null,
    bumpPrivateReplies: (guildId, userId, today) => {
      bumps.push([guildId, userId, today]);
    },
    markPrivateNoticed: (guildId, userId, today) => {
      noticed.push([guildId, userId, today]);
      privates[userId] = { ...(privates[userId] ?? {}), replies: { ...(privates[userId]?.replies ?? {}), noticedDay: today } };
    },
    bumps,
    noticed,
  };
}

function recordingTurns(result = { outcome: 'spoke' }, extra = {}) {
  const calls = [];
  const turns = fakeTurns({
    runTurn: async (args) => {
      calls.push(args);
      return result;
    },
    ...extra,
  });
  turns.calls = calls;
  return turns;
}

function makeDmHandler({ config, store, client, turns, memory, ...rest } = {}) {
  return makeHandler({
    config: config ?? privateConfig(),
    store: store ?? fakePrivateStore(),
    client: client ?? fakeDmClient(),
    turns: turns ?? recordingTurns(),
    memory: memory ?? fakeMemory(),
    prompts: { labels },
    now: () => TODAY_MS,
    ...rest,
  });
}

test('private: every gate reason drops the DM without a turn or an observe', async () => {
  const cases = [
    { reason: 'off', config: baseConfig({ bot: { owners: ['owner1'] } }) },
    { reason: 'notMember', client: fakeDmClient({ members: [] }) },
    { reason: 'unknown', store: fakePrivateStore({ profiles: {} }) },
    { reason: 'affinity', store: fakePrivateStore({ profiles: { u1: { affinity: { score: 4 } } } }) },
    {
      reason: 'cap',
      store: fakePrivateStore({ privates: { u1: { replies: { day: TODAY, count: 100, noticedDay: TODAY } } } }),
    },
  ];
  for (const { reason, ...deps } of cases) {
    const turns = recordingTurns();
    const memory = fakeMemory();
    const spontaneous = fakeSpontaneous();
    const handler = makeDmHandler({ turns, memory, spontaneous, ...deps });
    const message = fakeDmMessage();
    await handler(message);
    await settle();
    assert.equal(turns.calls.length, 0, `${reason}: no turn`);
    assert.equal(memory.observeCalls.length, 0, `${reason}: no observe`);
    assert.equal(spontaneous.onMessageCalls.length, 0, `${reason}: no eavesdrop`);
    assert.equal(message.channel.sent.length, 0, `${reason}: nothing sent`);
  }
});

test('private: a member missing from the cache is fetched; a fetched member passes', async () => {
  const client = fakeDmClient({ members: [], fetchable: ['u1'] });
  const turns = recordingTurns();
  const handler = makeDmHandler({ client, turns });
  await handler(fakeDmMessage());
  await settle();
  assert.deepEqual(client.fetchCalls, ['u1']);
  assert.equal(turns.calls.length, 1);
});

test('private: an unknown author or one below minAffinity never triggers a member fetch', async () => {
  const cases = [
    { reason: 'unknown', store: fakePrivateStore({ profiles: {} }) },
    { reason: 'affinity', store: fakePrivateStore({ profiles: { u1: { affinity: { score: 4 } } } }) },
  ];
  for (const { reason, store } of cases) {
    const client = fakeDmClient({ members: [], fetchable: ['u1'] });
    const turns = recordingTurns();
    const handler = makeDmHandler({ client, turns, store });
    const { logs } = await withCapturedLogs(async () => {
      await handler(fakeDmMessage());
      await settle();
    });
    assert.deepEqual(client.fetchCalls, [], `${reason}: no REST call`);
    assert.equal(turns.calls.length, 0, `${reason}: no turn`);
    assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, reason);
  }
});

test('private: a non-member missing from the cache is fetched, then dropped as notMember', async () => {
  const client = fakeDmClient({ members: [] });
  const turns = recordingTurns();
  const handler = makeDmHandler({ client, turns });
  const { logs } = await withCapturedLogs(async () => {
    await handler(fakeDmMessage());
    await settle();
  });
  assert.deepEqual(client.fetchCalls, ['u1']);
  assert.equal(turns.calls.length, 0);
  assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, 'notMember');
});

test('private: an owner below minAffinity is still answered (owners bypass the threshold)', async () => {
  const turns = recordingTurns();
  const handler = makeDmHandler({ turns });
  await handler(fakeDmMessage({ author: { id: 'owner1', bot: false, globalName: 'Owner', username: 'owner' } }));
  await settle();
  assert.equal(turns.calls.length, 1);
});

test('private: the daily cap posts the limit notice once a day and marks it noticed', async () => {
  const store = fakePrivateStore({ privates: { u1: { replies: { day: TODAY, count: 100, noticedDay: '2026-09-28' } } } });
  const turns = recordingTurns();
  const memory = fakeMemory();
  const channel = fakeDmChannel();
  const handler = makeDmHandler({ store, turns, memory });

  await handler(fakeDmMessage({ channel }));
  await settle();
  await handler(fakeDmMessage({ channel, id: 'dm-m2' }));
  await settle();

  assert.equal(channel.sent.length, 1, 'one notice, not one per message');
  assert.equal(channel.sent[0].content, 'limit reached (private.maxPerUserPerDay, 100/100)');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
  assert.equal(channel.sent[0].reply.messageReference, 'dm-m1');
  assert.deepEqual(store.noticed, [['g1', 'u1', TODAY]]);
  assert.equal(turns.calls.length, 0);
  assert.equal(memory.observeCalls.length, 0);
});

test("private: an owner's cap notice names private.maxPerOwnerPerDay", async () => {
  const store = fakePrivateStore({ privates: { owner1: { replies: { day: TODAY, count: 200, noticedDay: '' } } } });
  const channel = fakeDmChannel('dm2', 'owner1');
  const handler = makeDmHandler({ store });
  await handler(fakeDmMessage({ channel, author: { id: 'owner1', bot: false, globalName: 'Owner', username: 'owner' } }));
  await settle();
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (private.maxPerOwnerPerDay, 200/200)');
});

test('private: a DM that passes is observed privately, answered with the pinned guildId, then counted', async () => {
  const store = fakePrivateStore();
  const turns = recordingTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const channel = fakeDmChannel();
  const handler = makeDmHandler({ store, turns, memory, spontaneous });

  await handler(fakeDmMessage({ channel }));
  await settle();

  assert.equal(memory.observeCalls.length, 1);
  assert.equal(memory.observeCalls[0][0], 'g1');
  assert.equal(memory.observeCalls[0][1].content, 'γεια σου');
  assert.deepEqual(memory.observeCalls[0][2], { direct: true, private: 'u1' });
  assert.equal(turns.calls.length, 1);
  const args = turns.calls[0];
  assert.equal(args.channel, channel);
  assert.equal(args.guildId, 'g1');
  assert.equal(args.mode, 'reply');
  assert.equal(args.triggerKind, 'private');
  assert.equal(args.trigger.id, 'dm-m1');
  assert.deepEqual(store.bumps, [['g1', 'u1', TODAY]]);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(channel.sent.length, 0);
});

test('private: a turn that never reached the model is not counted against the daily cap', async () => {
  for (const outcome of ['refused', 'busy', 'paused', 'error', 'not-now']) {
    const store = fakePrivateStore();
    const handler = makeDmHandler({ store, turns: recordingTurns({ outcome }) });
    await handler(fakeDmMessage());
    await settle();
    assert.deepEqual(store.bumps, [], outcome);
  }
});

test('private: a turn that reached the model and chose silence (skip) counts against the daily cap', async () => {
  const store = fakePrivateStore();
  const handler = makeDmHandler({ store, turns: recordingTurns({ outcome: 'skip' }) });
  await handler(fakeDmMessage());
  await settle();
  assert.deepEqual(store.bumps, [['g1', 'u1', TODAY]]);
});

test('private: a DM refused by a rail posts the limit notice', async () => {
  const channel = fakeDmChannel();
  const turns = recordingTurns({ outcome: 'refused', limit: { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 } });
  const store = fakePrivateStore();
  const handler = makeDmHandler({ turns, store });
  await handler(fakeDmMessage({ channel }));
  await settle();
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (llm.maxRequestsPerDay, 800/800)');
  assert.deepEqual(store.bumps, []);
});

test('private: while busy elsewhere the DM is pending as "private"; the drain passes guildId and counts the reply', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const store = fakePrivateStore();
  const memory = fakeMemory();
  const channel = fakeDmChannel();
  // A private ping is never rolled for the ignore chance: an rng that would ignore any ping.
  const handler = makeDmHandler({ turns, store, memory, sleep: async () => {}, rng: () => 0 });

  const { logs } = await withCapturedLogs(async () => {
    await handler(fakeDmMessage({ channel }));
    await settle();
  });
  const deferred = logs.find((l) => l.msg === 'mention: deferred');
  assert.ok(deferred);
  assert.equal(deferred.kind, 'private');
  assert.equal(turns.calls.length, 0);
  assert.equal(memory.observeCalls.length, 1, 'observed on arrival');

  busy = false;
  await handler.drainPending();

  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].guildId, 'g1');
  assert.equal(turns.calls[0].triggerKind, 'private');
  assert.equal(turns.calls[0].channel, channel);
  assert.deepEqual(store.bumps, [['g1', 'u1', TODAY]]);
});

test('private: a drained DM whose turn finds another one running is re-queued and answered on the next drain', async () => {
  const state = { busy: true };
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => state.busy });
  const runOriginal = turns.runTurn;
  turns.runTurn = async (args) => (state.busy ? (turns.calls.push(args), { outcome: 'busy' }) : runOriginal(args));
  const store = fakePrivateStore();
  const channel = fakeDmChannel();
  let pauses = 0;
  const sleep = async () => {
    pauses += 1;
    if (pauses === 1) state.busy = true;
  };
  const handler = makeDmHandler({ turns, store, sleep, rng: () => 0 });

  await handler(fakeDmMessage({ channel }));
  await settle();
  state.busy = false;
  const { logs } = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 1);
  assert.deepEqual(store.bumps, [], 'a busy turn is not counted');
  const again = logs.find((l) => l.msg === 'mention: deferred again (busy)');
  assert.ok(again);
  assert.equal(again.kind, 'private');
  assert.equal(again.channel, 'dm1');

  state.busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 2);
  assert.equal(turns.calls[1].trigger.id, 'dm-m1');
  assert.equal(turns.calls[1].guildId, 'g1');
  assert.deepEqual(store.bumps, [['g1', 'u1', TODAY]]);
});

test('private: a newer DM queued during the switch pause wins over the re-queued one', async () => {
  const state = { busy: true };
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => state.busy });
  const runOriginal = turns.runTurn;
  turns.runTurn = async (args) => (state.busy ? (turns.calls.push(args), { outcome: 'busy' }) : runOriginal(args));
  const channel = fakeDmChannel();
  channel.messages.cache.set('dm-m2', {});
  let handler = null;
  let pauses = 0;
  const sleep = async () => {
    pauses += 1;
    if (pauses !== 1) return;
    state.busy = true;
    await handler(fakeDmMessage({ channel, id: 'dm-m2', cleanContent: 'δεύτερο' }));
  };
  handler = makeDmHandler({ turns, sleep, rng: () => 0 });

  await handler(fakeDmMessage({ channel }));
  await settle();
  state.busy = false;
  const { logs } = await withCapturedLogs(() => handler.drainPending());
  assert.ok(logs.some((l) => l.msg === 'mention: dropped (newer)' && l.channel === 'dm1' && l.kind === 'private'));

  state.busy = false;
  await handler.drainPending();
  assert.deepEqual(turns.calls.map((c) => c.trigger.id), ['dm-m1', 'dm-m2']);
});

/** A DM queued while busy elsewhere; `change` runs before the drain. Returns what the drain did. */
async function drainAfter(change, { privates = {} } = {}) {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const profiles = { u1: { affinity: { score: 10 } } };
  const store = fakePrivateStore({ profiles, privates });
  const config = privateConfig();
  const channel = fakeDmChannel();
  const handler = makeDmHandler({ turns, store, config, sleep: async () => {} });
  await handler(fakeDmMessage({ channel }));
  await settle();
  assert.equal(turns.calls.length, 0, 'queued, not answered');

  change({ profiles, privates, config });
  busy = false;
  const { logs } = await withCapturedLogs(() => handler.drainPending());
  return { turns, store, channel, logs };
}

test('private: a queued DM whose author was forgotten meanwhile is dropped at drain time', async () => {
  const { turns, store, channel, logs } = await drainAfter(({ profiles }) => {
    delete profiles.u1; // /nep memory forget
  });
  assert.equal(turns.calls.length, 0);
  assert.deepEqual(store.bumps, []);
  assert.equal(channel.sent.length, 0);
  assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, 'unknown');
});

test('private: a queued DM is dropped at drain time once the previous turn hit the cap, with the once-a-day notice', async () => {
  const { turns, store, channel, logs } = await drainAfter(({ privates }) => {
    privates.u1 = { replies: { day: TODAY, count: 100, noticedDay: '' } };
  });
  assert.equal(turns.calls.length, 0);
  assert.deepEqual(store.bumps, []);
  assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, 'cap');
  assert.deepEqual(store.noticed, [['g1', 'u1', TODAY]]);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (private.maxPerUserPerDay, 100/100)');
  assert.equal(channel.sent[0].reply.messageReference, 'dm-m1');
});

test('private: a queued DM past the cap already noticed today is dropped without a second notice', async () => {
  const { turns, store, channel } = await drainAfter(({ privates }) => {
    privates.u1 = { replies: { day: TODAY, count: 100, noticedDay: TODAY } };
  });
  assert.equal(turns.calls.length, 0);
  assert.deepEqual(store.noticed, []);
  assert.equal(channel.sent.length, 0);
});

test('private: a queued DM is dropped at drain time when features.privateMessages was switched off', async () => {
  const { turns, store, channel, logs } = await drainAfter(({ config }) => {
    config.features.privateMessages = false;
  });
  assert.equal(turns.calls.length, 0);
  assert.deepEqual(store.bumps, []);
  assert.equal(channel.sent.length, 0);
  assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, 'off');
});

test("private: the persona's own DM message is noted and observed privately under the partner's id", async () => {
  const turns = recordingTurns();
  const memory = fakeMemory();
  const channel = fakeDmChannel('dm1', 'u1');
  const handler = makeDmHandler({ turns, memory });
  const message = fakeDmMessage({ channel, author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' } });
  await handler(message);
  await settle();

  assert.deepEqual(turns.notePostCalls, [['dm1', message.createdTimestamp]]);
  assert.equal(memory.observeCalls.length, 1);
  assert.equal(memory.observeCalls[0][0], 'g1');
  assert.equal(memory.observeCalls[0][1].self, true);
  assert.deepEqual(memory.observeCalls[0][2], { private: 'u1' });
  assert.equal(turns.calls.length, 0);
});

test("private: the persona's own DM message without a usable partner id is only noted", async () => {
  for (const [label, channel] of [
    ['missing', fakeDmChannel('dm1', 'u1', { recipientId: undefined })],
    ['self', fakeDmChannel('dm1', 'self1')],
  ]) {
    const turns = recordingTurns();
    const memory = fakeMemory();
    const handler = makeDmHandler({ turns, memory });
    const message = fakeDmMessage({ channel, author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' } });
    await handler(message);
    await settle();
    assert.deepEqual(turns.notePostCalls, [['dm1', message.createdTimestamp]], label);
    assert.equal(memory.observeCalls.length, 0, label);
  }
});

test("private: the persona's own limit notice in a DM is noted but never observed", async () => {
  const turns = recordingTurns();
  const memory = fakeMemory();
  const channel = fakeDmChannel('dm1', 'u1');
  const handler = makeDmHandler({ turns, memory });
  const message = fakeDmMessage({
    channel,
    author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
    cleanContent: 'limit reached (private.maxPerUserPerDay, 100/100)',
  });
  await handler(message);
  await settle();
  assert.deepEqual(turns.notePostCalls, [['dm1', message.createdTimestamp]]);
  assert.equal(memory.observeCalls.length, 0);
});

test('private: another bot in a DM is ignored', async () => {
  const turns = recordingTurns();
  const memory = fakeMemory();
  const handler = makeDmHandler({ turns, memory });
  await handler(fakeDmMessage({ author: { id: 'otherbot', bot: true, globalName: 'Other', username: 'other' } }));
  await settle();
  assert.equal(turns.calls.length, 0);
  assert.equal(memory.observeCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test('private: while warming up a DM is observed privately but never answered', async () => {
  const turns = recordingTurns();
  const memory = fakeMemory();
  const handler = makeDmHandler({ turns, memory, isWarmingUp: () => true });
  await handler(fakeDmMessage());
  await settle();
  assert.equal(turns.calls.length, 0);
  assert.equal(memory.observeCalls.length, 1);
  assert.deepEqual(memory.observeCalls[0][2], { direct: true, private: 'u1' });
});

test('private: while paused a DM does nothing at all', async () => {
  const turns = recordingTurns();
  const memory = fakeMemory();
  const store = fakePrivateStore();
  store.state.data.paused = true;
  const handler = makeDmHandler({ turns, memory, store });
  await handler(fakeDmMessage());
  await settle();
  assert.equal(turns.calls.length, 0);
  assert.equal(memory.observeCalls.length, 0);
});

// --- Limit notices on triggered guild turns ---------------------------------

function refusedTurns() {
  return recordingTurns({ outcome: 'refused', limit: { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 } });
}

function sendingChannel(id = 'c1', guild = fakeGuild()) {
  const sent = [];
  const channel = fakeChannelWithMessage(id, guild, 'm1', {
    send: async (payload) => {
      sent.push(payload);
      return { id: 'notice1' };
    },
  });
  channel.sent = sent;
  return channel;
}

test('limits: a mention refused by a rail posts the notice as a plain reply to the trigger', async () => {
  const turns = refusedTurns();
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const handler = makeHandler({ turns, rng: scripted([0.99]), prompts: { labels } });
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  await settle();

  assert.equal(turns.calls.length, 1);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (llm.maxRequestsPerDay, 800/800)');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
  assert.equal(channel.sent[0].reply.messageReference, 'm1');
});

test('limits: a pending mention refused at drain time posts the notice', async () => {
  let busy = true;
  const turns = recordingTurns(
    { outcome: 'refused', limit: { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 } },
    { isAnyBusy: () => busy },
  );
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const handler = makeHandler({ turns, rng: scripted([0.5, 0.99]), sleep: async () => {}, prompts: { labels } });
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  busy = false;
  await handler.drainPending();

  assert.equal(turns.calls.length, 1);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (llm.maxRequestTokens, 51000/50000)');
});

test('limits: a refusal with no limit, or another outcome, posts nothing', async () => {
  for (const result of [{ outcome: 'refused', limit: null }, { outcome: 'error' }, { outcome: 'skip' }]) {
    const guild = fakeGuild();
    const channel = sendingChannel('c1', guild);
    const handler = makeHandler({ turns: recordingTurns(result), rng: scripted([0.99]), prompts: { labels } });
    await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await settle();
    assert.equal(channel.sent.length, 0, JSON.stringify(result));
  }
});

test('limits: a missing limits.notice label sends nothing', async () => {
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const handler = makeHandler({ turns: refusedTurns(), rng: scripted([0.99]), prompts: { labels: {} } });
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  await settle();
  assert.equal(channel.sent.length, 0);
});

test('limits: in dry-run the notice is logged and mirrored, never sent to the channel', async () => {
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const mirrored = [];
  const client = { ...fakeClient(), channels: { fetch: async () => ({ send: async (payload) => mirrored.push(payload) }) } };
  const config = baseConfig({ features: { dryRun: true }, bot: { dryRunChannelId: 'mirror1' } });
  const handler = makeHandler({ config, client, turns: refusedTurns(), rng: scripted([0.99]), prompts: { labels } });
  const { logs } = await withCapturedLogs(async () => {
    await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await settle();
  });
  assert.equal(channel.sent.length, 0);
  const line = logs.find((l) => l.msg === 'dry-run: would notify limit');
  assert.ok(line);
  assert.equal(line.key, 'llm.maxRequestsPerDay');
  assert.equal(line.used, 800);
  assert.equal(line.cap, 800);
  assert.equal(mirrored.length, 1);
  assert.deepEqual(mirrored[0].allowedMentions, { parse: [] });
});

test('limits: a failing notice send never escapes the handler', async () => {
  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1', {
    send: async () => {
      throw new Error('Missing Permissions');
    },
  });
  const handler = makeHandler({ turns: refusedTurns(), rng: scripted([0.99]), prompts: { labels } });
  const { logs } = await withCapturedLogs(async () => {
    await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await settle();
  });
  assert.ok(logs.some((l) => l.msg === 'events: limit notice failed'));
});

test('limits: a follow-up turn refused by a rail posts the notice', async () => {
  const llm = fakeFollowUpLlm();
  const turns = refusedTurns();
  const guild = fakeGuild();
  const sent = [];
  const channel = fakeChannelWithHistory('c1', guild, [], {
    send: async (payload) => {
      sent.push(payload);
      return { id: 'notice1' };
    },
  });
  const handler = makeHandler({ turns, llm, prompts: fakeAddressPrompts() });
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'so what do you think' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.respond('yes');
  await p;
  await settle();

  assert.equal(turns.calls.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'limit reached (llm.maxRequestsPerDay, 800/800)');
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test('limits: a message without a trigger runs no turn here, so nothing is ever announced', async () => {
  const turns = refusedTurns();
  const spontaneous = fakeSpontaneous();
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const config = baseConfig({ bot: { nameTriggers: [] } });
  const handler = makeHandler({ config, turns, spontaneous, prompts: { labels } });
  await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'ένα απλό μήνυμα' }));
  await settle();

  assert.equal(spontaneous.onMessageCalls.length, 1, 'handed to the spontaneous scheduler, whose refusals stay silent');
  assert.equal(turns.calls.length, 0);
  assert.equal(channel.sent.length, 0);
});

// ---------------------------------------------------------------------------
// The address classifier sees media captions the describer already cached:
// a sticker- or picture-only answer is not a bare `[sticker: name]`.

/** A describer fake with the cache-only accessor; `describeMany` (the prefill) waits on `gate` when given. */
function fakeCachingDescriber(cached = new Map(), { gate } = {}) {
  const calls = [];
  const cachedCalls = [];
  return {
    calls,
    cachedCalls,
    describeMany: async (guildId, items) => {
      calls.push({ guildId, items });
      if (gate) await gate;
      return { descriptions: new Map(), newCount: 0 };
    },
    cachedDescriptions: (guildId, items) => {
      cachedCalls.push({ guildId, items });
      return new Map(items.filter((item) => cached.has(item.itemId)).map((item) => [item.itemId, cached.get(item.itemId)]));
    },
  };
}

function stickerOnlyMessage({ guild, channel, id = 'm-sticker' }) {
  return fakeMessage({
    id,
    guild,
    channel,
    channelId: channel.id,
    cleanContent: '',
    stickers: new Map([['s1', { id: 's1', name: 'pingo', format: 1 }]]),
  });
}

test('follow-up: a sticker-only candidate with a cached caption reaches the classifier with the caption', async () => {
  const llm = fakeFollowUpLlm();
  const describer = fakeCachingDescriber(new Map([['sticker:s1', 'a penguin waving hello']]));
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, llm, describer, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(stickerOnlyMessage({ guild, channel }));
  await tick();

  assert.equal(llm.calls.length, 1, 'only the classifier call; the cache read makes none');
  assert.match(llm.calls[0].messages[1].content, /<candidate>\n[^\n]*\[sticker: pingo: a penguin waving hello\]\n<\/candidate>/);
  assert.equal(describer.cachedCalls.length, 1);
  assert.equal(describer.cachedCalls[0].guildId, 'g1');
  assert.ok(describer.cachedCalls[0].items.some((item) => item.itemId === 'sticker:s1'));

  llm.respond('no');
  await p;
});

test('follow-up: a sticker-only candidate with no cached caption renders as a bare sticker, as before', async () => {
  const llm = fakeFollowUpLlm();
  const describer = fakeCachingDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, llm, describer, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(stickerOnlyMessage({ guild, channel }));
  await tick();

  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].messages[1].content, /<candidate>\n[^\n]*\[sticker: pingo\]\n<\/candidate>/);

  llm.respond('no');
  await p;
});

test("follow-up: the classifier waits for the candidate's own picture prefill, with no second describe request", async () => {
  const llm = fakeFollowUpLlm();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const cached = new Map();
  const describer = fakeCachingDescriber(cached, { gate });
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, llm, describer, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(stickerOnlyMessage({ guild, channel }));
  await tick();
  assert.equal(describer.calls.length, 1, 'the prefill started');
  assert.equal(llm.calls.length, 0, 'the classifier is not asked while the prefill is in flight');

  cached.set('sticker:s1', 'a penguin waving hello');
  release();
  await tick();

  assert.equal(describer.calls.length, 1, 'the prefill is awaited, never repeated');
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].messages[1].content, /\[sticker: pingo: a penguin waving hello\]/);

  llm.respond('no');
  await p;
});

test('follow-up: with mediaDescriptions off the describer is never consulted and the sticker stays bare', async () => {
  const llm = fakeFollowUpLlm();
  const describer = fakeCachingDescriber(new Map([['sticker:s1', 'a penguin waving hello']]));
  const config = baseConfig({ features: { mediaDescriptions: false } });
  const handler = makeHandler({ config, llm, describer, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(stickerOnlyMessage({ guild, channel }));
  await tick();

  assert.equal(describer.calls.length, 0);
  assert.equal(describer.cachedCalls.length, 0);
  assert.match(llm.calls[0].messages[1].content, /\[sticker: pingo\]\n<\/candidate>/);

  llm.respond('no');
  await p;
});

// ---------------------------------------------------------------------------
// The address classifier -- the <author> block: who the candidate's author is
// known as (stored aliases, ranked, capped by mention.followUpAliases), so the
// classifier can connect a nickname in the persona's line to the member.

/** A stored profile whose aliases rank in the listed order (equal dates: rank follows weight). */
function profileWithAliases(id, names) {
  const seen = '2026-01-01T00:00:00.000Z';
  return {
    id,
    names: ['Ελένη'],
    aliases: names.map((name, i) => ({ name, weight: names.length - i, firstSeen: seen, lastSeen: seen })),
  };
}

/** The `<author>` line as `labels.address.author` renders it. */
function authorLine(name, aliases) {
  return labels.address.author.replace('{name}', name).replace('{aliases}', aliases);
}

/** Runs one candidate from `authorId` through an open window; resolves to the classifier's user message. */
async function classifierUserMessage({ store, config, prompts = fakeAddressPrompts(), authorId = 'u7', authorName = 'Ελένη' }) {
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, prompts, store, config });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const history = [rawHistoryMessage({ id: 'h1', authorId: 'u1', authorName: 'Alice', ts: t0, content: 'earlier message' })];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });
  const msg = fakeMessage({
    id: 'm-candidate',
    guild,
    channel,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: 'el' },
    member: { displayName: authorName },
    cleanContent: 'and you too',
    createdTimestamp: t0 + 2000,
  });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'the classifier was asked');
  const user = llm.calls[0].messages[1].content;
  llm.respond('no');
  await p;
  return user;
}

test('follow-up author: the request carries an <author> block with the top-ranked aliases, capped at mention.followUpAliases', async () => {
  const aliases = ['Λένα', 'Ελενάκι', 'Nélé', 'Lèna', 'Hélène', 'Éli', 'Nènè'];
  const store = fakeStore({ u7: profileWithAliases('u7', aliases) });
  const user = await classifierUserMessage({ store });

  const line = authorLine('Ελένη', 'Λένα, Ελενάκι, Nélé, Lèna, Hélène');
  assert.ok(user.includes(`<author>\n${line}\n</author>`), 'the default followUpAliases (5), best rank first');
  assert.ok(!user.includes('Éli') && !user.includes('Nènè'), 'aliases past the cap are left out');
  const authorAt = user.indexOf('<author>');
  assert.ok(authorAt > user.indexOf('earlier message'), 'after the transcript');
  assert.ok(authorAt < user.indexOf('<candidate>'), 'before the candidate');
  assert.deepEqual(store.getUserCalls, [['g1', 'u7']], 'the candidate author profile, read once');
});

test('follow-up author: mention.followUpAliases is read live and caps the list', async () => {
  const store = fakeStore({ u7: profileWithAliases('u7', ['Λένα', 'Ελενάκι', 'Nélé']) });
  const user = await classifierUserMessage({ store, config: baseConfig({ mention: { followUpAliases: 2 } }) });
  assert.ok(user.includes(`<author>\n${authorLine('Ελένη', 'Λένα, Ελενάκι')}\n</author>`));
  assert.ok(!user.includes('Nélé'));
});

test('follow-up author: ranking decays with memory.aliasHalfLifeDays, like the persona request', async () => {
  const profile = {
    id: 'u7',
    names: ['Ελένη'],
    aliases: [
      { name: 'Λένα', weight: 2, firstSeen: '2020-01-01T00:00:00.000Z', lastSeen: '2020-01-01T00:00:00.000Z' },
      { name: 'Nélé', weight: 1, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
    ],
  };
  const user = await classifierUserMessage({ store: fakeStore({ u7: profile }) });
  assert.ok(user.includes(authorLine('Ελένη', 'Nélé, Λένα')),'the recent alias outranks the old heavier one');
});

test('follow-up author: a profile without aliases adds no <author> block', async () => {
  const store = fakeStore({ u7: { id: 'u7', names: ['Ελένη'], aliases: [] } });
  const user = await classifierUserMessage({ store });
  assert.ok(!user.includes('<author>'));
  assert.ok(user.includes('<candidate>') && user.includes('and you too'));
});

test('follow-up author: no stored profile adds no <author> block', async () => {
  const store = fakeStore({});
  const user = await classifierUserMessage({ store });
  assert.ok(!user.includes('<author>'));
  assert.deepEqual(store.getUserCalls, [['g1', 'u7']]);
});

test('follow-up author: followUpAliases 0 adds no <author> block', async () => {
  const store = fakeStore({ u7: profileWithAliases('u7', ['Λένα']) });
  const user = await classifierUserMessage({ store, config: baseConfig({ mention: { followUpAliases: 0 } }) });
  assert.ok(!user.includes('<author>'));
});

test('follow-up author: without labels.address.author the block is omitted', async () => {
  const store = fakeStore({ u7: profileWithAliases('u7', ['Λένα']) });
  const prompts = { ...fakeAddressPrompts(), labels: { ...labels, address: undefined } };
  const user = await classifierUserMessage({ store, prompts });
  assert.ok(!user.includes('<author>'));
  assert.ok(!user.includes('Λένα'));
});

test('follow-up author: reading the profile writes nothing', async () => {
  const profile = profileWithAliases('u7', ['Λένα', 'Ελενάκι']);
  const before = structuredClone(profile);
  const touched = [];
  const base = fakeStore({ u7: profile });
  const store = new Proxy(base, {
    get(target, key) {
      if (key !== 'getUser' && key !== 'getUserCalls' && typeof key === 'string') touched.push(key);
      return target[key];
    },
  });
  const user = await classifierUserMessage({ store });
  assert.ok(user.includes('<author>'));
  assert.deepEqual(profile, before, 'the stored profile is unchanged');
  assert.deepEqual(touched.filter((key) => key !== 'state' && key !== 'then'), [], 'no store method other than getUser');
});
