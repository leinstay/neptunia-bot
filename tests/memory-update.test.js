// Tests for src/memory/update.js: buffering, the memory-update request
// builder and applying the model's JSON reply. tests/fixtures/labels.js is
// an English fixture covering every key of the prompt contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/memory/store.js';
import { isDue, buildMemoryRequest, applyMemoryUpdate, createMemoryUpdater, touchMemory } from '../src/memory/update.js';
import { createCalibrator, estimateTokens, estimateMessages } from '../src/llm/tokens.js';
import { formatTranscript } from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-'));
}

function withStore(fn) {
  const dir = tempDir();
  try {
    return fn(createStore({ dataDir: dir }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withStoreAsync(fn) {
  const dir = tempDir();
  try {
    return await fn(createStore({ dataDir: dir }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeConfig(overrides = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
    llm: {
      model: 'x/y',
      temperature: 1,
      maxOutputTokens: 700,
      maxRequestTokens: 50000,
      safetyMargin: 0.9,
      timeoutMs: 1000,
      retries: 0,
      maxRequestsPerDay: 100,
    },
    memory: {
      model: null,
      batchMessages: 60,
      minBatchMessages: 15,
      maxBatchAgeMinutes: 180,
      maxOutputTokens: 4000,
      fieldChars: 400,
      maxDetails: 15,
      maxInjokes: 15,
      maxSelfFacts: 20,
    },
    ...overrides,
  };
}

function slimMessage(overrides) {
  return {
    id: 'm1',
    channelId: 'c1',
    channelName: 'general',
    authorId: '1',
    authorName: 'nick',
    self: false,
    bot: false,
    content: 'hello',
    ts: Date.now(),
    replyToId: null,
    attachments: [],
    stickers: [],
    ...overrides,
  };
}

// ---- isDue ----------------------------------------------------------------

test('isDue: false when the buffer is short and fresh', () => {
  const cfg = { batchMessages: 10, minBatchMessages: 3, maxBatchAgeMinutes: 60 };
  const buffer = [{ ts: 1000 }, { ts: 1000 }];
  assert.equal(isDue(buffer, 2000, cfg), false);
});

test('isDue: true once the buffer reaches batchMessages, regardless of age', () => {
  const cfg = { batchMessages: 3, minBatchMessages: 10, maxBatchAgeMinutes: 999 };
  const buffer = [{ ts: 1000 }, { ts: 1000 }, { ts: 1000 }];
  assert.equal(isDue(buffer, 1001, cfg), true);
});

test('isDue: true when minBatchMessages is met and the oldest message aged out', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 2, maxBatchAgeMinutes: 10 };
  const buffer = [{ ts: 0 }, { ts: 5000 }];
  assert.equal(isDue(buffer, 10 * 60_000 + 1, cfg), true);
});

test('isDue: false when minBatchMessages is met but the oldest message is still fresh', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 2, maxBatchAgeMinutes: 10 };
  const buffer = [{ ts: 0 }, { ts: 5000 }];
  assert.equal(isDue(buffer, 5 * 60_000, cfg), false);
});

test('isDue: a pile-up of direct messages triggers early, before the regular batch fills', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 100, maxBatchAgeMinutes: 999 };
  const relationshipsCfg = { directTriggerCount: 3 };
  const buffer = [{ ts: 0, direct: true }, { ts: 0, direct: false }, { ts: 0, direct: true }, { ts: 0, direct: true }];
  assert.equal(isDue(buffer, 1, cfg, relationshipsCfg), true);
});

test('isDue: direct messages below directTriggerCount do not trigger', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 100, maxBatchAgeMinutes: 999 };
  const relationshipsCfg = { directTriggerCount: 3 };
  const buffer = [{ ts: 0, direct: true }, { ts: 0, direct: true }];
  assert.equal(isDue(buffer, 1, cfg, relationshipsCfg), false);
});

test('isDue: relationshipsCfg absent or directTriggerCount 0 never triggers on direct messages alone', () => {
  const cfg = { batchMessages: 100, minBatchMessages: 100, maxBatchAgeMinutes: 999 };
  const buffer = [{ ts: 0, direct: true }, { ts: 0, direct: true }, { ts: 0, direct: true }];
  assert.equal(isDue(buffer, 1, cfg, undefined), false);
  assert.equal(isDue(buffer, 1, cfg, { directTriggerCount: 0 }), false);
});

// ---- buildMemoryRequest -----------------------------------------------------

test('buildMemoryRequest: carries the memory prompt and both JSON blocks', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages, consumed } = buildMemoryRequest({
    prompts: { memory: 'memory system prompt', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: 'cheerful', interests: '', style: '', details: [], relationship: '' } },
    guildMemory: { patterns: 'chats all day', starters: '', injokes: [], self: [] },
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].role, 'system');
  assert.equal(llmMessages[0].content, 'memory system prompt');
  assert.equal(llmMessages[1].role, 'user');
  const user = llmMessages[1].content;
  assert.match(user, /<existing_profiles>[\s\S]*<\/existing_profiles>/);
  assert.match(user, /<existing_guild>[\s\S]*<\/existing_guild>/);
  assert.match(user, /<new_messages>[\s\S]*<\/new_messages>/);
  assert.ok(user.includes('cheerful'));
  assert.ok(user.includes('chats all day'));
  // Only the whitelisted profile fields travel, never messageCount/id/firstSeen etc.
  assert.ok(!user.includes('messageCount'));
  assert.equal(consumed, 1);
});

test('buildMemoryRequest: fills {{name}} in the memory system prompt', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'You are {{name}}, summarize the chat.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, 'You are Nept, summarize the chat.');
});

test('buildMemoryRequest: throws a clear error when prompts.labels is missing', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  assert.throws(
    () =>
      buildMemoryRequest({
        prompts: { memory: 'sys' },
        config,
        calibrator,
        profiles: {},
        guildMemory: {},
        messages: [slimMessage()],
        selfName: 'Nept',
      }),
    /labels/,
  );
});

test('buildMemoryRequest: throws a clear error when prompts.labels has no transcript section', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const brokenLabels = { ...labels, transcript: undefined };
  assert.throws(
    () =>
      buildMemoryRequest({
        prompts: { memory: 'sys', labels: brokenLabels },
        config,
        calibrator,
        profiles: {},
        guildMemory: {},
        messages: [slimMessage()],
        selfName: 'Nept',
      }),
    /labels/,
  );
});

test('buildMemoryRequest: memory transcript lines use "[hh:mm] nick (id:1): text"', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick', content: 'text', ts: Date.UTC(2026, 0, 1, 14, 32, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.match(llmMessages[1].content, /\[14:32\] nick \(id:1\): text/);
});

test('buildMemoryRequest: works with a non-English labels object, proving nothing is language-bound', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const grLabels = { ...labels, locale: 'el-GR', self: '{name} (εσύ)' };
  const messages = [slimMessage({ id: 'm1', self: true, authorName: 'Nept', content: 'privet', ts: Date.UTC(2026, 0, 1, 14, 32, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels: grLabels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.ok(llmMessages[1].content.includes('Nept (εσύ): privet'));
});

test('buildMemoryRequest: a tiny token limit still consumes everything but keeps only the newest lines', () => {
  const calibrator = createCalibrator();
  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const timezone = 'UTC';
  const selfName = 'Nept';
  const system = 'S';
  const profilesJson = JSON.stringify({});
  const guildJson = JSON.stringify({ patterns: '', starters: '', injokes: [], self: [] });
  const channelsJson = JSON.stringify({});
  const profilesBlock = `<existing_profiles>\n${profilesJson}\n</existing_profiles>`;
  const guildBlock = `<existing_guild>\n${guildJson}\n</existing_guild>`;
  const channelsBlock = `<existing_channels>\n${channelsJson}\n</existing_channels>`;
  const fixedCost = cost(system) + cost(profilesBlock) + cost(guildBlock) + cost(channelsBlock);

  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  const messages = [0, 1, 2, 3, 4].map((i) =>
    slimMessage({ id: `m${i}`, content: `message number ${i}`, ts: base + i * 60_000 }),
  );
  const lineTexts = formatTranscript(messages, { timezone, gapMinutes: 20, maxChars: 800, selfName, mode: 'memory', labels }).map(
    (item) => item.text,
  );
  const lineCost = cost(lineTexts.at(-1));

  const config = makeConfig({
    bot: { timezone },
    llm: { ...makeConfig().llm, maxRequestTokens: fixedCost + lineCost, safetyMargin: 1 },
  });

  const { messages: llmMessages, consumed } = buildMemoryRequest({
    prompts: { memory: system, labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName,
  });

  const user = llmMessages[1].content;
  assert.equal(consumed, 5, 'every buffered message is consumed even when trimmed from the request');
  assert.ok(user.includes('message number 4'), 'newest line survives');
  assert.ok(!user.includes('message number 0'), 'oldest line is dropped first');
});

// ---- relationships: <character> block + affinity in existing profiles ------

test('buildMemoryRequest: relationships on prepends a <character> block with {{name}} filled', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', 'character-card': 'Card of {{name}}, a cheerful person.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  assert.match(user, /<character>[\s\S]*Card of Nept, a cheerful person\.[\s\S]*<\/character>/);
});

test('buildMemoryRequest: relationships off never renders a <character> block', () => {
  const config = makeConfig({ features: { relationships: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', 'character-card': 'Card of {{name}}.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.ok(!llmMessages[1].content.includes('<character>'));
  assert.ok(!llmMessages[1].content.includes('Card of Nept'));
});

test('buildMemoryRequest: relationships on adds affinity: { score, reason } to each existing profile', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: '', style: '', details: [], relationship: '', affinity: { score: 42, reason: 'helped once', history: [] } } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].affinity, { score: 42, reason: 'helped once' });
});

test('buildMemoryRequest: relationships off never adds affinity to existing profiles', () => {
  const config = makeConfig({ features: { relationships: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: '', style: '', details: [], relationship: '', affinity: { score: 42, reason: 'helped once', history: [] } } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.equal(profiles['1'].affinity, undefined);
});

test('buildMemoryRequest: a direct message gets the arrow marker in the transcript', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick', content: 'hey you', direct: true, ts: Date.UTC(2026, 0, 1, 14, 32, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.match(llmMessages[1].content, /→ \[14:32\] nick \(id:1\): hey you/);
});

// ---- buildMemoryRequest: <existing_channels> + channel grouping -----------

test('buildMemoryRequest: always renders an <existing_channels> block, keyed by channel id', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: { c1: { name: 'general', category: 'Text', topic: 'chat', purpose: 'chatter', topics: 'games', tone: 'casual' } },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.deepEqual(channels, {
    c1: { name: 'general', category: 'Text', topic: 'chat', purpose: 'chatter', topics: 'games', tone: 'casual' },
  });
});

test('buildMemoryRequest: an empty/absent channels map still renders an empty <existing_channels> block', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.match(llmMessages[1].content, /<existing_channels>\n\{\}\n<\/existing_channels>/);
});

test('buildMemoryRequest: <new_messages> groups messages by channel with a heading on every switch', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  const messages = [
    slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', content: 'first', ts: base }),
    slimMessage({ id: 'm2', channelId: 'c2', channelName: 'random', content: 'second', ts: base + 60_000 }),
  ];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const generalIdx = user.indexOf('## #general (id:c1)');
  const randomIdx = user.indexOf('## #random (id:c2)');
  assert.ok(generalIdx !== -1 && randomIdx !== -1 && generalIdx < randomIdx);
});

// ---- applyMemoryUpdate: channels --------------------------------------------

test('applyMemoryUpdate: merges purpose/topics/tone for a known channel id, clamped to fieldChars', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchChannel(guildId, 'c1', { name: 'general', category: null, topic: null }, Date.now());
    const cfg = { fieldChars: 5, maxDetails: 2, maxInjokes: 2, maxSelfFacts: 2 };

    const update = { channels: { c1: { purpose: 'a long purpose text', topics: 'games', tone: 'chill' } } };
    const result = applyMemoryUpdate(store, guildId, update, cfg, new Set(), new Set(['c1']));

    assert.equal(result.channels, 1);
    const channel = store.getChannel(guildId, 'c1');
    assert.equal(channel.purpose, 'a lon');
    assert.equal(channel.topics, 'games');
    assert.equal(channel.tone, 'chill');
  });
});

test('applyMemoryUpdate: rejects a channel id outside knownChannelIds', () => {
  withStore((store) => {
    const guildId = 'g1';
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

    const result = applyMemoryUpdate(store, guildId, { channels: { c999: { purpose: 'x' } } }, cfg, new Set(), new Set(['c1']));

    assert.equal(result.channels, 0);
    assert.equal(store.getChannel(guildId, 'c999'), null);
  });
});

test('applyMemoryUpdate: a channel field absent from the update leaves the stored value untouched', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchChannel(guildId, 'c1', { name: 'general', category: null, topic: null }, Date.now());
    store.updateChannel(guildId, 'c1', { purpose: 'old purpose', tone: 'calm' });
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

    const result = applyMemoryUpdate(store, guildId, { channels: { c1: { tone: 'excited' } } }, cfg, new Set(), new Set(['c1']));

    assert.equal(result.channels, 1);
    const channel = store.getChannel(guildId, 'c1');
    assert.equal(channel.tone, 'excited');
    assert.equal(channel.purpose, 'old purpose');
  });
});

// ---- applyMemoryUpdate ------------------------------------------------------

test('applyMemoryUpdate: clamps string and detail fields to the configured limits', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const cfg = { fieldChars: 5, maxDetails: 2, maxInjokes: 2, maxSelfFacts: 2 };
    const longDetail = 'x'.repeat(250);
    const update = {
      users: { 1: { character: '0123456789', details: [longDetail, 'b', 'c'] } },
    };

    const result = applyMemoryUpdate(store, guildId, update, cfg, new Set(['1']));

    assert.equal(result.users, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.character, '01234');
    assert.deepEqual(profile.details, [longDetail.slice(0, 200), 'b']);
  });
});

test('applyMemoryUpdate: rejects user ids outside knownUserIds', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

    const result = applyMemoryUpdate(store, guildId, { users: { 999: { character: 'x' } } }, cfg, new Set(['1']));

    assert.equal(result.users, 0);
    assert.equal(store.getUser(guildId, '999'), null);
  });
});

test('applyMemoryUpdate: a field absent from the update leaves the stored value untouched', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.updateUser(guildId, '1', { interests: 'old', style: 'calm' });
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

    const result = applyMemoryUpdate(store, guildId, { users: { 1: { style: 'new' } } }, cfg, new Set(['1']));

    assert.equal(result.users, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.style, 'new');
    assert.equal(profile.interests, 'old');
  });
});

test('applyMemoryUpdate: empty guild and self updates are no-ops', () => {
  withStore((store) => {
    const guildId = 'g1';
    const before = { ...store.getGuild(guildId) };
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

    const result = applyMemoryUpdate(
      store,
      guildId,
      { guild: { patterns: '', starters: '', injokes: [] }, self: [] },
      cfg,
      new Set(),
    );

    assert.equal(result.guild, false);
    assert.equal(result.self, false);
    assert.deepEqual(store.getGuild(guildId), before);
  });
});

test('applyMemoryUpdate: garbage input changes nothing and never throws', () => {
  withStore((store) => {
    const guildId = 'g1';
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };
    const before = { ...store.getGuild(guildId) };

    for (const garbage of [null, undefined, 'not an object', 42, [1, 2, 3]]) {
      const result = applyMemoryUpdate(store, guildId, garbage, cfg, new Set(['1']));
      assert.deepEqual(result, { users: 0, guild: false, self: false, affinity: 0, channels: 0 });
    }
    assert.deepEqual(store.getGuild(guildId), before);
  });
});

// ---- applyMemoryUpdate: relationships -------------------------------------

const RELATIONSHIPS_CFG = { enabled: true, maxDeltaPerUpdate: 15, historySize: 10, now: Date.UTC(2026, 0, 1) };
const MEMORY_CFG = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 };

test('applyMemoryUpdate: relationships enabled applies and clamps the affinity delta, counts changed scores', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { interests: 'anime', affinity: { delta: 999, reason: 'was really kind' } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), RELATIONSHIPS_CFG);

    assert.equal(result.users, 1);
    assert.equal(result.affinity, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.affinity.score, 15, 'delta is clamped to maxDeltaPerUpdate');
    assert.equal(profile.affinity.reason, 'was really kind');
  });
});

test('applyMemoryUpdate: a zero/absent affinity delta does not count as a change', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { interests: 'anime', affinity: { delta: 0, reason: 'no change' } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), RELATIONSHIPS_CFG);
    assert.equal(result.affinity, 0);

    const noAffinityField = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { interests: 'anime again' } } },
      MEMORY_CFG,
      new Set(['1']),
      new Set(),
      RELATIONSHIPS_CFG,
    );
    assert.equal(noAffinityField.affinity, 0);
  });
});

test('applyMemoryUpdate: an affinity delta for an unknown user id is ignored entirely', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 999: { affinity: { delta: 20, reason: 'x' } } } },
      MEMORY_CFG,
      new Set(['1']),
      new Set(),
      RELATIONSHIPS_CFG,
    );

    assert.equal(result.users, 0);
    assert.equal(result.affinity, 0);
    assert.equal(store.getUser(guildId, '999'), null);
  });
});

test('applyMemoryUpdate: relationships disabled (or absent) ignores affinity entirely', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { affinity: { delta: 50, reason: 'should be ignored' } } } };
    const resultDisabled = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), { enabled: false });
    assert.equal(resultDisabled.affinity, 0);
    assert.equal(store.getUser(guildId, '1').affinity.score, 0);

    const resultAbsent = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));
    assert.equal(resultAbsent.affinity, 0);
    assert.equal(store.getUser(guildId, '1').affinity.score, 0);
  });
});

test('applyMemoryUpdate: a malformed affinity value is ignored, other fields still apply', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { interests: 'games', affinity: 'not an object' } } },
      MEMORY_CFG,
      new Set(['1']),
      new Set(),
      RELATIONSHIPS_CFG,
    );

    assert.equal(result.users, 1);
    assert.equal(result.affinity, 0);
    assert.equal(store.getUser(guildId, '1').interests, 'games');
  });
});

test('applyMemoryUpdate: a non-empty self array replaces guild.self wholesale', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.updateGuild(guildId, { self: ['old fact'] });
    const cfg = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 2 };

    const result = applyMemoryUpdate(store, guildId, { self: ['new fact 1', 'new fact 2', 'new fact 3'] }, cfg, new Set());

    assert.equal(result.self, true);
    assert.deepEqual(store.getGuild(guildId).self, ['new fact 1', 'new fact 2']);
  });
});

// ---- observe -----------------------------------------------------------------

test('observe: ignores other bots entirely', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ authorId: 'b1', authorName: 'SomeBot', bot: true, content: 'spam' }));

    assert.equal(store.getBuffer('g1').length, 0);
    assert.equal(store.getUser('g1', 'b1'), null);
  });
});

test('observe: strips attachment urls before buffering', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe(
      'g1',
      slimMessage({
        content: 'look',
        attachments: [{ kind: 'image', name: 'a.png', url: 'https://cdn.example/secret' }],
        stickers: ['wow'],
      }),
    );

    const [buffered] = store.getBuffer('g1');
    assert.deepEqual(buffered.attachments, [{ kind: 'image', name: 'a.png' }]);
    assert.equal('url' in buffered.attachments[0], false);
    assert.deepEqual(buffered.stickers, ['wow']);
  });
});

test('observe: touches the channel entry for both human and the persona\'s own messages', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', authorId: '1', self: false }));
    updater.observe('g1', slimMessage({ id: 'm2', channelId: 'c1', channelName: 'general', authorId: 'self1', self: true, bot: false }));

    const channel = store.getChannel('g1', 'c1');
    assert.ok(channel);
    assert.equal(channel.name, 'general');
    assert.equal(channel.messageCount, 2);
  });
});

test('observe: never touches a channel for another bot\'s message', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ channelId: 'c1', channelName: 'general', authorId: 'b1', bot: true }));

    assert.equal(store.getChannel('g1', 'c1'), null);
  });
});

test('observe: touches the user profile for a human message but not for the persona\'s own', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ authorId: '1', authorName: 'nick', self: false }));
    updater.observe('g1', slimMessage({ id: 'm2', authorId: 'self1', authorName: 'Nept', self: true, bot: false }));

    const profile = store.getUser('g1', '1');
    assert.ok(profile);
    assert.equal(profile.messageCount, 1);
    assert.deepEqual(profile.names, ['nick']);
    assert.equal(store.getUser('g1', 'self1'), null);
    assert.equal(store.getBuffer('g1').length, 2, 'both messages, including the persona\'s own, are buffered');
  });
});

test('observe: marks a message as direct only when told to', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ id: 'm1' }), { direct: true });
    updater.observe('g1', slimMessage({ id: 'm2' }));

    const [first, second] = store.getBuffer('g1');
    assert.equal(first.direct, true);
    assert.equal(second.direct, false);
  });
});

// ---- run -----------------------------------------------------------------

test('run: happy path applies the update, shifts the buffer and flushes to disk', async () => {
  await withStoreAsync(async (store, dir) => {
    const guildId = 'g1';
    const base = Date.now() - 60_000;
    for (let i = 0; i < 4; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 100);
    }
    store.touchUser(guildId, '1', 'nick', base);

    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 4, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = {
      complete: async (messages, options) => {
        seenOptions = options;
        return { text: JSON.stringify({ users: { 1: { interests: 'anime' } }, guild: { patterns: 'friendly' }, self: [] }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId);

    assert.equal(store.getBuffer(guildId).length, 0);
    assert.equal(store.getUser(guildId, '1').interests, 'anime');
    assert.equal(store.getGuild(guildId).patterns, 'friendly');
    assert.equal(seenOptions.maxOutputTokens, hot.config.memory.maxOutputTokens);
    assert.equal(seenOptions.temperature, 0.3);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', guildId, 'users', '1.json'), 'utf8'));
    assert.equal(onDisk.interests, 'anime');
  });
});

test('run: a failure keeps the buffer untouched and backs the guild off for 15 minutes', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now();
    for (let i = 0; i < 3; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 100);
    }

    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 3, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    let calls = 0;
    const llm = {
      complete: async () => {
        calls += 1;
        throw new Error('boom');
      },
    };
    let nowValue = 1_000_000;
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept', now: () => nowValue });

    await updater.run(guildId);
    assert.equal(calls, 1);
    assert.equal(store.getBuffer(guildId).length, 3, 'buffer is untouched after a failed run');

    await updater.tick();
    assert.equal(calls, 1, 'still backed off: tick must not retry immediately');

    nowValue += 16 * 60_000;
    await updater.tick();
    assert.equal(calls, 2, 'backoff expired: tick retries');
  });
});

// ---- touchMemory -----------------------------------------------------------

test('touchMemory: touches the user profile and the channel for a human message', () => {
  withStore((store) => {
    touchMemory(store, 'g1', slimMessage({ channelId: 'c1', channelName: 'general', authorId: '1', authorName: 'nick', self: false }));

    const profile = store.getUser('g1', '1');
    assert.ok(profile);
    assert.equal(profile.messageCount, 1);
    const channel = store.getChannel('g1', 'c1');
    assert.ok(channel);
    assert.equal(channel.messageCount, 1);
  });
});

test('touchMemory: never touches the user profile for the persona\'s own message, still touches the channel', () => {
  withStore((store) => {
    touchMemory(store, 'g1', slimMessage({ channelId: 'c1', channelName: 'general', authorId: 'self1', self: true }));

    assert.equal(store.getUser('g1', 'self1'), null);
    const channel = store.getChannel('g1', 'c1');
    assert.ok(channel);
    assert.equal(channel.messageCount, 1);
  });
});

// ---- analyze -----------------------------------------------------------------

test('analyze: never touches the buffer, returns usage/estimated/result on success', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.pushBuffer(guildId, slimMessage({ id: 'm1' }), 100);
    store.touchUser(guildId, '1', 'nick', Date.now());

    const hot = {
      config: makeConfig(),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        text: JSON.stringify({ users: { 1: { interests: 'anime' } } }),
        usage: { prompt_tokens: 111, completion_tokens: 22 },
        estimated: 130,
      }),
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const messages = [slimMessage({ id: 'mA', authorId: '1', content: 'hi' })];
    const outcome = await updater.analyze(guildId, messages);

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.usage, { prompt_tokens: 111, completion_tokens: 22 });
    assert.equal(outcome.estimated, 130);
    assert.equal(outcome.result.users, 1);
    assert.equal(store.getUser(guildId, '1').interests, 'anime');
    // The buffer, which analyze() never received, is untouched.
    assert.equal(store.getBuffer(guildId).length, 1);
  });
});

test('analyze: swallows a thrown error and returns { ok: false, error }', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => { throw new Error('boom'); } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.usage, null);
    assert.ok(outcome.error instanceof Error);
    assert.equal(outcome.error.message, 'boom');
  });
});

test('analyze: a completion that fails to parse still reports the real usage/estimated — it was billed', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        text: 'not a JSON object at all',
        usage: { prompt_tokens: 80, completion_tokens: 10 },
        estimated: 90,
      }),
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.usage, { prompt_tokens: 80, completion_tokens: 10 });
    assert.equal(outcome.estimated, 90);
    assert.equal(outcome.result, null);
    assert.ok(outcome.error instanceof Error);
  });
});

test('analyze: a request that fails to build (e.g. missing labels) reports usage: null, nothing was billed', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys' } }; // no labels: buildMemoryRequest throws
    const calibrator = createCalibrator();
    let calls = 0;
    const llm = { complete: async () => { calls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.usage, null);
    assert.equal(outcome.estimated, 0);
    assert.equal(calls, 0, 'the LLM is never called when the request cannot be built');
  });
});

test('analyze: forwards countAgainstDailyCap to llm.complete, default true', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);
    assert.equal(seenOptions.countAgainstDailyCap, true);

    await updater.analyze(guildId, [slimMessage({ id: 'm2' })], { countAgainstDailyCap: false });
    assert.equal(seenOptions.countAgainstDailyCap, false);
  });
});

test('analyze: no memory prompt configured returns { ok: false } without calling the LLM', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: {} };
    const calibrator = createCalibrator();
    let calls = 0;
    const llm = { complete: async () => { calls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(calls, 0);
  });
});

test('run: does nothing when prompts.memory is missing', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.pushBuffer(guildId, slimMessage(), 100);
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 1, minBatchMessages: 1 } }), prompts: {} };
    const calibrator = createCalibrator();
    let calls = 0;
    const llm = { complete: async () => { calls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId);

    assert.equal(calls, 0);
    assert.equal(store.getBuffer(guildId).length, 1);
  });
});

// ---- estimate ---------------------------------------------------------------

test('estimate: matches the calibrated cost of the exact request analyze would build', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.updateUser(guildId, '1', { character: 'cheerful, talks a lot about anime and games' });
    const hot = { config: makeConfig(), prompts: { memory: 'memory system prompt', labels } };
    const calibrator = createCalibrator();
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator, getSelfName: () => 'Nept' });

    const messages = [
      slimMessage({ id: 'm1', authorId: '1', channelId: 'c1', channelName: 'general', content: 'hello there', ts: Date.UTC(2026, 0, 1, 12, 0, 0) }),
    ];

    const got = updater.estimate(guildId, messages);

    const { messages: llmMessages } = buildMemoryRequest({
      prompts: hot.prompts,
      config: hot.config,
      calibrator,
      profiles: { 1: store.getUser(guildId, '1') },
      guildMemory: store.getGuild(guildId),
      channels: {},
      messages,
      selfName: 'Nept',
    });
    const expected = calibrator.apply(estimateMessages(llmMessages));

    assert.equal(got, expected);
    assert.ok(got > 0);
  });
});

test('estimate: never touches the buffer or the store beyond reading it', () => {
  withStore((store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator, getSelfName: () => 'Nept' });
    store.pushBuffer(guildId, slimMessage({ id: 'buffered' }), 100);

    updater.estimate(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(store.getBuffer(guildId).length, 1, 'the live buffer is untouched');
  });
});

test('estimate: falls back to a content-only heuristic when the request cannot be built', () => {
  withStore((store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: {} }; // no labels: buildMemoryRequest throws
    const calibrator = createCalibrator();
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator, getSelfName: () => 'Nept' });

    const messages = [slimMessage({ content: 'hello world' }), slimMessage({ id: 'm2', content: 'second one' })];
    const got = updater.estimate(guildId, messages);

    const expected = estimateTokens('hello world') + estimateTokens('second one');
    assert.equal(got, expected);
  });
});
