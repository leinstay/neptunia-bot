import test from 'node:test';
import assert from 'node:assert/strict';
import { SnowflakeUtil } from 'discord.js';
import {
  nextDelayMs,
  isActiveHour,
  msUntilActive,
  chooseMode,
  pickChannel,
  isChannelDead,
  createSpontaneous,
} from '../src/behavior/spontaneous.js';

function snowflake(ts) {
  return SnowflakeUtil.generate({ timestamp: ts }).toString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const SPONTANEOUS_CFG = {
  channels: [],
  minIntervalMinutes: 25,
  maxIntervalMinutes: 420,
  burstChance: 0.15,
  burstMinutes: [3, 15],
  activeHours: { from: 10, to: 3 },
  liveWindowMinutes: 15,
  liveMinMessages: 4,
  deadAfterMinutes: 90,
  initiateChance: 0.35,
  eavesdropChance: 0.02,
  eavesdropDelayMs: [5000, 40000],
  minGapMinutes: 12,
};

function scripted(values) {
  const queue = [...values];
  return () => {
    if (queue.length === 0) throw new Error('scripted rng ran out of values');
    return queue.shift();
  };
}

// ---------------------------------------------------------------------------
// nextDelayMs

test('nextDelayMs: burst branch returns ms inside cfg.burstMinutes', () => {
  const rng = scripted([0.1, 0]); // < burstChance (0.15), then min of the burst range
  const ms = nextDelayMs(SPONTANEOUS_CFG, rng);
  assert.equal(ms, SPONTANEOUS_CFG.burstMinutes[0] * MINUTE);
});

test('nextDelayMs: burst branch caps at the top of cfg.burstMinutes', () => {
  const rng = scripted([0.1, 1]);
  const ms = nextDelayMs(SPONTANEOUS_CFG, rng);
  assert.equal(ms, SPONTANEOUS_CFG.burstMinutes[1] * MINUTE);
});

test('nextDelayMs: non-burst branch is log-uniform between min and max minutes', () => {
  const minMs = SPONTANEOUS_CFG.minIntervalMinutes * MINUTE;
  const maxMs = SPONTANEOUS_CFG.maxIntervalMinutes * MINUTE;
  let sawShort = false;
  let sawLong = false;

  for (let i = 0; i < 2000; i++) {
    const rng = scripted([0.99, Math.random()]); // force past the burst check
    const ms = nextDelayMs(SPONTANEOUS_CFG, rng);
    assert.ok(ms >= minMs - 1e-6 && ms <= maxMs + 1e-6, `${ms} out of bounds`);
    if (ms < minMs * 5) sawShort = true; // short gaps should be common under log-uniform
    if (ms > maxMs / 5) sawLong = true; // and long gaps should still happen sometimes
  }
  assert.ok(sawShort, 'expected some short gaps under log-uniform sampling');
  assert.ok(sawLong, 'expected some long gaps under log-uniform sampling');
});

test('nextDelayMs: non-burst bounds hold at the extremes of rng', () => {
  const minMs = SPONTANEOUS_CFG.minIntervalMinutes * MINUTE;
  const maxMs = SPONTANEOUS_CFG.maxIntervalMinutes * MINUTE;
  assert.ok(Math.abs(nextDelayMs(SPONTANEOUS_CFG, scripted([0.99, 0])) - minMs) < 1e-6);
  assert.ok(Math.abs(nextDelayMs(SPONTANEOUS_CFG, scripted([0.99, 1])) - maxMs) < 1e-6);
});

// ---------------------------------------------------------------------------
// isActiveHour

test('isActiveHour: normal (non-wrapping) window', () => {
  const hours = { from: 9, to: 17 };
  assert.equal(isActiveHour(9, hours), true);
  assert.equal(isActiveHour(16, hours), true);
  assert.equal(isActiveHour(17, hours), false);
  assert.equal(isActiveHour(8, hours), false);
});

test('isActiveHour: window wraps over midnight', () => {
  const hours = { from: 10, to: 3 };
  assert.equal(isActiveHour(10, hours), true);
  assert.equal(isActiveHour(23, hours), true);
  assert.equal(isActiveHour(0, hours), true);
  assert.equal(isActiveHour(2, hours), true);
  assert.equal(isActiveHour(3, hours), false);
  assert.equal(isActiveHour(9, hours), false);
});

test('isActiveHour: from === to means always active', () => {
  const hours = { from: 5, to: 5 };
  for (let h = 0; h < 24; h++) assert.equal(isActiveHour(h, hours), true);
});

// ---------------------------------------------------------------------------
// msUntilActive

test('msUntilActive: 0 when already inside an active hour', () => {
  // 2026-01-05T12:00:00Z -> UTC hour 12, inside 10-20
  const now = Date.UTC(2026, 0, 5, 12, 0, 0);
  const ms = msUntilActive(now, 'UTC', { from: 10, to: 20 }, () => 0.5);
  assert.equal(ms, 0);
});

test('msUntilActive: lands inside the active window when currently asleep', () => {
  // 2026-01-05T05:00:00Z -> UTC hour 5, outside the wide 10-to-3 window used in config.json
  const now = Date.UTC(2026, 0, 5, 5, 0, 0);
  for (const rngValue of [0, 0.5, 1]) {
    const ms = msUntilActive(now, 'UTC', { from: 10, to: 3 }, () => rngValue);
    assert.ok(ms > 0, 'should be positive since the persona is asleep');
    const wakeHour = new Date(now + ms).getUTCHours();
    assert.equal(isActiveHour(wakeHour, { from: 10, to: 3 }), true, `hour ${wakeHour} should be active`);
  }
});

// ---------------------------------------------------------------------------
// chooseMode

function msg({ ts, self = false, bot = false, authorId = 'u1' }) {
  return { ts, self, bot, authorId };
}

test('chooseMode: empty history may initiate, chance-gated', () => {
  assert.equal(chooseMode([], 1000, SPONTANEOUS_CFG, () => 0), 'initiate');
  assert.equal(chooseMode([], 1000, SPONTANEOUS_CFG, () => 0.99), null);
});

test('chooseMode: never replies to its own last message', () => {
  const now = 1_000_000;
  const history = [msg({ ts: now - MINUTE, self: true })];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), null);
});

test('chooseMode: interjects when the channel is live', () => {
  const now = 1_000_000;
  const history = [
    msg({ ts: now - 10 * MINUTE, authorId: 'a' }),
    msg({ ts: now - 8 * MINUTE, authorId: 'b' }),
    msg({ ts: now - 5 * MINUTE, authorId: 'a' }),
    msg({ ts: now - 1 * MINUTE, authorId: 'c' }),
  ];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), 'interject');
});

test('chooseMode: bot messages within the live window do not count toward interjecting', () => {
  const now = 1_000_000;
  const history = [
    msg({ ts: now - 10 * MINUTE, bot: true }),
    msg({ ts: now - 8 * MINUTE, bot: true }),
    msg({ ts: now - 5 * MINUTE, bot: true }),
    msg({ ts: now - 1 * MINUTE, authorId: 'c' }),
  ];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), null);
});

test('chooseMode: initiates after a long silence, chance-gated', () => {
  const now = 1_000_000;
  const history = [msg({ ts: now - SPONTANEOUS_CFG.deadAfterMinutes * MINUTE - 1 })];
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), 'initiate');
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0.99), null);
});

test('chooseMode: quiet-but-not-dead, non-live channel does nothing', () => {
  const now = 1_000_000;
  const history = [msg({ ts: now - 20 * MINUTE })]; // not live (>15min window), not dead (<90min)
  assert.equal(chooseMode(history, now, SPONTANEOUS_CFG, () => 0), null);
});

// ---------------------------------------------------------------------------
// pickChannel

test('pickChannel: null for an empty list', () => {
  assert.equal(pickChannel([], 1000, () => 0), null);
});

test('pickChannel: with probability 0.7 picks the most recently active candidate', () => {
  const now = 1000;
  const candidates = [
    { channel: 'old', lastActivity: now - HOUR },
    { channel: 'newest', lastActivity: now - MINUTE },
    { channel: 'mid', lastActivity: now - 30 * MINUTE },
  ];
  assert.equal(pickChannel(candidates, now, scripted([0.1])), 'newest');
});

test('pickChannel: otherwise a uniformly random channel among those active in 24h', () => {
  const now = 1000;
  const candidates = [
    { channel: 'a', lastActivity: now - HOUR },
    { channel: 'b', lastActivity: now - 2 * HOUR },
  ];
  // rng[0] = 0.9 -> skip the 0.7 "most recent" branch; rng[1] picks the index
  assert.equal(pickChannel(candidates, now, scripted([0.9, 0])), 'a');
  assert.equal(pickChannel(candidates, now, scripted([0.9, 0.99])), 'b');
});

test('pickChannel: falls back to a uniformly random candidate when none were active in 24h', () => {
  const now = 1000;
  const candidates = [
    { channel: 'a', lastActivity: now - 2 * 24 * HOUR },
    { channel: 'b', lastActivity: now - 3 * 24 * HOUR },
  ];
  assert.equal(pickChannel(candidates, now, scripted([0])), 'a');
  assert.equal(pickChannel(candidates, now, scripted([0.99])), 'b');
});

// ---------------------------------------------------------------------------
// createSpontaneous / tick()

function fakeChannel(id, guild, overrides = {}) {
  return {
    id,
    name: `chan-${id}`,
    guild,
    isTextBased: () => true,
    isThread: () => false,
    viewable: true,
    lastMessageId: null,
    permissionsFor: () => ({ has: () => true }),
    ...overrides,
  };
}

function fakeGuild(id) {
  const guild = { id, members: { me: {} } };
  guild.channels = { cache: new Map() };
  return guild;
}

function baseConfig(spontaneousOverrides = {}, features = {}, mention) {
  return {
    bot: { timezone: 'UTC', channels: { allow: [], deny: [] } },
    features,
    spontaneous: { ...SPONTANEOUS_CFG, ...spontaneousOverrides },
    ...(mention ? { mention } : {}),
  };
}

function fakeStore(initialData = {}) {
  let dirtyCalls = 0;
  return {
    state: {
      data: initialData,
      markDirty: () => {
        dirtyCalls += 1;
      },
    },
    get dirtyCalls() {
      return dirtyCalls;
    },
  };
}

function fakeTurns({ runTurn, isBusy, isAnyBusy, lastPostAt } = {}) {
  return {
    runTurn: runTurn ?? (async () => ({ outcome: 'spoke' })),
    isBusy: isBusy ?? (() => false),
    isAnyBusy: isAnyBusy ?? (() => false),
    lastPostAt: lastPostAt ?? (() => 0),
  };
}

test('tick: schedules a first run for a guild with no entry yet, without firing', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore();
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  // Active hour (10 UTC is inside default 10-to-3 window) so a due entry would fire; here there's no entry at all.
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.5, now });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(typeof store.state.data.spontaneous.g1, 'number');
  assert.ok(store.state.data.spontaneous.g1 > now());
});

test('tick: fires a turn once it is due and inside active hours', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0); // hour 12, inside 10-to-3
  const store = fakeStore({ spontaneous: { g1: t } }); // already due
  let seenChannel = null;
  const turns = fakeTurns({
    runTurn: async ({ channel: ch }) => {
      seenChannel = ch;
      return { outcome: 'spoke' };
    },
  });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => t });
  await spontaneous.tick();

  assert.equal(seenChannel, channel);
  assert.ok(store.state.data.spontaneous.g1 > t, 'should have been rescheduled to the future');
});

test('tick: reschedules to a wake time when due but outside active hours', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 5, 0, 0); // hour 5, outside 10-to-3
  const store = fakeStore({ spontaneous: { g1: t } });
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.5, now: () => t });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.ok(store.state.data.spontaneous.g1 > t);
});

test('tick: does nothing when features.spontaneous is false', async () => {
  const guild = fakeGuild('g1');
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore();
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({}, { spontaneous: false }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: () => Date.UTC(2026, 0, 5, 12, 0, 0),
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous, undefined);
});

test('tick: runs normally when config.features is entirely absent (missing = on)', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ spontaneous: { g1: t } });
  let seenChannel = null;
  const turns = fakeTurns({
    runTurn: async ({ channel: ch }) => {
      seenChannel = ch;
      return { outcome: 'spoke' };
    },
  });

  const config = baseConfig();
  delete config.features;
  const spontaneous = createSpontaneous({ hot: { config }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => t });
  await spontaneous.tick();

  assert.equal(seenChannel, channel);
});

test('tick: never runs two spontaneous turns for the same guild concurrently', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ spontaneous: { g1: t } });

  let calls = 0;
  const resolvers = [];
  const turns = fakeTurns({
    runTurn: () =>
      new Promise((resolve) => {
        calls += 1;
        resolvers.push(resolve);
      }),
  });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => t });

  const both = Promise.all([spontaneous.tick(), spontaneous.tick()]);
  await Promise.resolve(); // let both ticks run up to their awaits
  await Promise.resolve();
  assert.equal(calls, 1, 'the second tick should see the guild already running and skip it');

  for (const resolve of resolvers) resolve({ outcome: 'spoke' });
  await both;
});

test('tick: pulls the next run in sooner when a turn found nothing to say', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ spontaneous: { g1: t } });
  const turns = fakeTurns({ runTurn: async () => ({ outcome: 'not-now' }) });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.5, now: () => t });
  await spontaneous.tick();

  const scheduled = store.state.data.spontaneous.g1;
  assert.ok(scheduled > t && scheduled <= t + 40 * MINUTE, `expected a 10-40min pull-in, got ${scheduled - t}ms`);
});

test('tick: does nothing while the served guild has not been resolved yet', async () => {
  const guild = fakeGuild('g1');
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore();
  const turns = fakeTurns();

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => null,
    rng: () => 0.5,
    now: () => Date.now(),
  });
  await spontaneous.tick();

  assert.deepEqual(store.state.data.spontaneous ?? {}, {}, 'an unresolved instance must not get a schedule entry');
});

test('tick: does nothing when the resolved guild is not (or no longer) in the client\'s cache', async () => {
  const client = { guilds: { cache: new Map() } };
  const store = fakeStore();
  const turns = fakeTurns();

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: () => Date.now(),
  });
  await spontaneous.tick();

  assert.deepEqual(store.state.data.spontaneous ?? {}, {});
});

// ---------------------------------------------------------------------------
// onMessage (eavesdrop)

function eagerEavesdropConfig(features = {}) {
  return baseConfig({ eavesdropChance: 1, eavesdropDelayMs: [0, 0] }, features);
}

async function flushTimers() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test('onMessage: eavesdrops when spontaneous and eavesdrop are both on (missing features block counts as on)', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'g1',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 1);
});

test('onMessage: ignores a message from a guild other than the one this instance serves', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'some-other-guild',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

test('onMessage: does nothing when features.eavesdrop is false', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig({ eavesdrop: false }) },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'g1',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

test('onMessage: does nothing when features.spontaneous is false, even with eavesdrop untouched', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig({ spontaneous: false }) },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'g1',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// status / stop / poke

test('status: returns a copy of the persisted schedule', () => {
  const store = fakeStore({ spontaneous: { g1: 123 } });
  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client: { guilds: { cache: new Map() } },
    turns: fakeTurns(),
  });
  const status = spontaneous.status();
  assert.deepEqual(status, { g1: 123 });
  status.g1 = 999;
  assert.equal(store.state.data.spontaneous.g1, 123, 'status() must not expose the live object');
});

test('poke: fires even when every feature switch is off (the owner\'s explicit command bypasses them)', async () => {
  let seen = null;
  const turns = fakeTurns({ runTurn: async (args) => { seen = args; return { outcome: 'spoke' }; } });
  const config = baseConfig({}, { spontaneous: false, eavesdrop: false });
  const spontaneous = createSpontaneous({
    hot: { config },
    store: fakeStore(),
    client: { guilds: { cache: new Map() } },
    turns,
  });
  const channel = { id: 'c1' };
  const result = await spontaneous.poke(channel, 'initiate');
  assert.equal(result.outcome, 'spoke');
  assert.equal(seen.channel, channel);
});

test('poke: forwards mode straight to turns.runTurn', async () => {
  let seen = null;
  const turns = fakeTurns({ runTurn: async (args) => { seen = args; return { outcome: 'spoke' }; } });
  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store: fakeStore(),
    client: { guilds: { cache: new Map() } },
    turns,
  });
  const channel = { id: 'c1' };
  const result = await spontaneous.poke(channel, 'interject');
  assert.equal(result.outcome, 'spoke');
  assert.equal(seen.channel, channel);
  assert.equal(seen.mode, 'interject');
});

test('stop: clears pending eavesdrop timers without throwing', () => {
  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store: fakeStore(),
    client: { guilds: { cache: new Map() } },
    turns: fakeTurns(),
  });
  assert.doesNotThrow(() => spontaneous.stop());
});

// ---------------------------------------------------------------------------
// F28: dead channels (spontaneous.maxChannelSilenceHours) never start a
// spontaneous turn on their own -- a direct ping there is unaffected (that
// path never goes through channelCandidates at all).

test('isChannelDead: silent longer than maxChannelSilenceHours is dead', () => {
  const now = 1_000_000_000;
  const channel = { lastMessageId: snowflake(now - 100 * HOUR) };
  assert.equal(isChannelDead(channel, { maxChannelSilenceHours: 72 }, now), true);
});

test('isChannelDead: within the window is not dead', () => {
  const now = 1_000_000_000;
  const channel = { lastMessageId: snowflake(now - 10 * HOUR) };
  assert.equal(isChannelDead(channel, { maxChannelSilenceHours: 72 }, now), false);
});

test('isChannelDead: a non-positive or missing value means no limit', () => {
  const now = 1_000_000_000;
  const ancientChannel = { lastMessageId: snowflake(now - 5000 * HOUR) };
  assert.equal(isChannelDead(ancientChannel, { maxChannelSilenceHours: 0 }, now), false);
  assert.equal(isChannelDead(ancientChannel, { maxChannelSilenceHours: -5 }, now), false);
  assert.equal(isChannelDead(ancientChannel, {}, now), false);
});

test('tick: a dead channel is never a candidate, a fresh one still is', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const dead = fakeChannel('dead', guild, { lastMessageId: snowflake(t - 100 * HOUR) });
  const fresh = fakeChannel('fresh', guild, { lastMessageId: snowflake(t - HOUR) });
  guild.channels.cache.set(dead.id, dead);
  guild.channels.cache.set(fresh.id, fresh);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let seenChannel = null;
  const turns = fakeTurns({ runTurn: async ({ channel }) => { seenChannel = channel; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({ maxChannelSilenceHours: 72 }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.1,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(seenChannel, fresh, 'the dead channel must never be picked');
});

test('tick: every channel dead means no candidates -- "not now" without breaking the schedule', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const dead = fakeChannel('dead', guild, { lastMessageId: snowflake(t - 200 * HOUR) });
  guild.channels.cache.set(dead.id, dead);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({ maxChannelSilenceHours: 72 }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.ok(store.state.data.spontaneous.g1 > t, 'rescheduled (the pull-in path), the periodic schedule is not broken');
});

test('tick: a non-positive maxChannelSilenceHours keeps today\'s behaviour (an old channel is still a candidate)', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const old = fakeChannel('old', guild, { lastMessageId: snowflake(t - 5000 * HOUR) });
  guild.channels.cache.set(old.id, old);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let seenChannel = null;
  const turns = fakeTurns({ runTurn: async ({ channel }) => { seenChannel = channel; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({ maxChannelSilenceHours: 0 }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.1,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(seenChannel, old);
});

test('tick: a hot change to maxChannelSilenceHours is picked up without recreating the scheduler', async () => {
  const guild = fakeGuild('g1');
  const t0 = Date.UTC(2026, 0, 5, 12, 0, 0);
  const old = fakeChannel('old', guild, { lastMessageId: snowflake(t0 - 100 * HOUR) });
  guild.channels.cache.set(old.id, old);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t0 } });
  const turns = fakeTurns();
  const hot = { config: baseConfig({ maxChannelSilenceHours: 0 }) };
  let now = t0;

  const spontaneous = createSpontaneous({ hot, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => now });

  let seenChannel = null;
  turns.runTurn = async ({ channel }) => {
    seenChannel = channel;
    return { outcome: 'spoke' };
  };
  await spontaneous.tick();
  assert.equal(seenChannel, old, 'no limit yet: the old channel is a candidate');

  hot.config = baseConfig({ maxChannelSilenceHours: 72 });
  store.state.data.spontaneous.g1 = now; // due again
  seenChannel = null;
  await spontaneous.tick();
  assert.equal(seenChannel, null, 'now limited: the same old channel is no longer a candidate');
});

// ---------------------------------------------------------------------------
// F28: one attention (mention.oneAtATime) -- while a turn is running
// anywhere, the spontaneous scheduler treats every channel as unavailable.

test('tick: turns.isAnyBusy() true blocks every channel when oneAtATime is on (default) -- "not now"', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const channel = fakeChannel('c1', guild, { lastMessageId: snowflake(t - MINUTE) });
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let calls = 0;
  const turns = fakeTurns({
    isAnyBusy: () => true,
    runTurn: async () => { calls += 1; return { outcome: 'spoke' }; },
  });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.5, now: () => t });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.ok(store.state.data.spontaneous.g1 > t, 'the periodic schedule keeps advancing');
});

test('tick: mention.oneAtATime=false lets a spontaneous tick proceed even while busy elsewhere', async () => {
  const guild = fakeGuild('g1');
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const channel = fakeChannel('c1', guild, { lastMessageId: snowflake(t - MINUTE) });
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ spontaneous: { g1: t } });
  let seenChannel = null;
  const turns = fakeTurns({
    isAnyBusy: () => true,
    runTurn: async ({ channel: ch }) => { seenChannel = ch; return { outcome: 'spoke' }; },
  });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig({}, {}, { oneAtATime: false }) },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(seenChannel, channel);
});

// ---------------------------------------------------------------------------
// F30: /nep pause -- no spontaneous activity, nothing may go dirty

test('tick: does nothing while store.state.data.paused is true, not even the first-schedule write', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore({ paused: true });
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    rng: () => 0.1,
    now: () => Date.UTC(2026, 0, 5, 12, 0, 0),
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous, undefined, 'must not even set up the schedule while paused');
  assert.equal(store.dirtyCalls, 0);
});

test('tick: does nothing while a run was already due, when store.state.data.paused flips true', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ paused: true, spontaneous: { g1: t } }); // already due
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => t });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous.g1, t, 'the schedule is left exactly as it was');
});

test('onMessage: does not schedule an eavesdrop while store.state.data.paused is true', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore({ paused: true }),
    client: {},
    turns,
    getGuildId: () => 'g1',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

test('onMessage (eavesdrop): does not schedule while busy elsewhere and oneAtATime is on', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ isAnyBusy: () => true, runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'g1',
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// F37: isBootstrapping -- the generic mute hook a memory bootstrap run (a
// later task) plugs into, replacing the mute the retired long warm-up used
// to apply. Same shape as the F30 paused tests above.

test('tick: does nothing while isBootstrapping() is true, not even the first-schedule write', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const store = fakeStore();
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    isBootstrapping: () => true,
    rng: () => 0.1,
    now: () => Date.UTC(2026, 0, 5, 12, 0, 0),
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous, undefined, 'must not even set up the schedule while bootstrapping');
  assert.equal(store.dirtyCalls, 0);
});

test('tick: does nothing while a run was already due, when isBootstrapping() is true', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ spontaneous: { g1: t } }); // already due
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({
    hot: { config: baseConfig() },
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    isBootstrapping: () => true,
    rng: () => 0.1,
    now: () => t,
  });
  await spontaneous.tick();

  assert.equal(calls, 0);
  assert.equal(store.state.data.spontaneous.g1, t, 'the schedule is left exactly as it was');
});

test('onMessage: does not schedule an eavesdrop while isBootstrapping() is true', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  let calls = 0;
  const turns = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const now = () => Date.UTC(2026, 0, 5, 12, 0, 0);

  const spontaneous = createSpontaneous({
    hot: { config: eagerEavesdropConfig() },
    store: fakeStore(),
    client: {},
    turns,
    getGuildId: () => 'g1',
    isBootstrapping: () => true,
    rng: () => 0,
    now,
  });
  spontaneous.onMessage(channel, { self: false, bot: false });
  await flushTimers();

  assert.equal(calls, 0);
});

test('tick / onMessage: isBootstrapping defaults to false when not provided (unmuted: normal)', async () => {
  const guild = fakeGuild('g1');
  const channel = fakeChannel('c1', guild);
  guild.channels.cache.set(channel.id, channel);
  const client = { guilds: { cache: new Map([[guild.id, guild]]) } };
  const t = Date.UTC(2026, 0, 5, 12, 0, 0);
  const store = fakeStore({ spontaneous: { g1: t } });
  let seenChannel = null;
  const turns = fakeTurns({ runTurn: async ({ channel: ch }) => { seenChannel = ch; return { outcome: 'spoke' }; } });

  const spontaneous = createSpontaneous({ hot: { config: baseConfig() }, store, client, turns, getGuildId: () => 'g1', rng: () => 0.1, now: () => t });
  await spontaneous.tick();

  assert.equal(seenChannel, channel);
});
