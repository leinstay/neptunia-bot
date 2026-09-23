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

test('follow-up: the address classifier still honours a deprecated llm.classifierModel when classifier.text is null', async () => {
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
  assert.equal(llm.calls[0].options.model, 'x/old');

  llm.respond('no');
  await p;
});

test('follow-up: the address classifier still honours a deprecated mention.followUpModel when classifier.text and llm.classifierModel are null', async () => {
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
  assert.equal(llm.calls[0].options.model, 'x/older');

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

test('follow-up: a reply to another member is "no" without consulting the model', async () => {
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
  await handler(msg);

  assert.equal(llm.calls.length, 0, 'a reply to another member never reaches the model');
  assert.equal(spontaneous.onMessageCalls.length, 0, 'handled by the pre-filter, not handed to spontaneous');
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
