import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageHandler } from '../src/discord/events.js';
import { createTagHistory } from '../src/behavior/mention.js';
import { readConfig, deepMerge } from '../src/config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseConfig(overrides = {}) {
  return deepMerge(structuredClone(readConfig()), overrides);
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

function fakeTurns({ runTurn } = {}) {
  const notePost = recorder();
  return {
    notePost,
    runTurn: runTurn ?? (async () => ({ outcome: 'spoke' })),
    isBusy: () => false,
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

function makeHandler({ config, turns, spontaneous, memory, tagHistory, rng, client, store, getGuildId, isWarmingUp, describer } = {}) {
  return createMessageHandler({
    hot: { config: config ?? baseConfig() },
    store: store ?? fakeStore(),
    client: client ?? fakeClient(),
    turns: turns ?? fakeTurns(),
    spontaneous: spontaneous ?? fakeSpontaneous(),
    memory: memory ?? fakeMemory(),
    tagHistory: tagHistory ?? createTagHistory(),
    getGuildId: getGuildId ?? (() => 'g1'),
    isWarmingUp,
    describer,
    rng: rng ?? Math.random,
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
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const memory = fakeMemory();
  const handler = makeHandler({ turns, memory, rng: scripted([0.0]) });

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
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] } });
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
// isWarmingUp: the persona is mute while the memory warm-up is due/running

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

test('events: isWarmingUp defaults to false when not provided', async () => {
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

  const message = fakeMessage({ channel, channelId: 'mirror1', cleanContent: 'old bang-prefix warmup command' });
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
// features.mediaDescriptions: fire-and-forget describer warm-up from the
// message path (src/memory/describe.js's cache), so the live memory analyzer
// (src/memory/update.js#analyze) finds a caption already cached.

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
