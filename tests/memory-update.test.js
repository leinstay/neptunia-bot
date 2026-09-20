// Tests for src/memory/update.js: buffering, the memory-update request
// builder and applying the model's JSON reply. tests/fixtures/labels.js is
// an English fixture covering every key of the prompt contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/memory/store.js';
import { isDue, buildMemoryRequest, applyMemoryUpdate, createMemoryUpdater } from '../src/memory/update.js';
import { createCalibrator, estimateTokens } from '../src/llm/tokens.js';
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
  const ruLabels = { ...labels, locale: 'ru-RU', self: '{name} (ты)' };
  const messages = [slimMessage({ id: 'm1', self: true, authorName: 'Nept', content: 'privet', ts: Date.UTC(2026, 0, 1, 14, 32, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels: ruLabels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.ok(llmMessages[1].content.includes('Nept (ты): privet'));
});

test('buildMemoryRequest: a tiny token limit still consumes everything but keeps only the newest lines', () => {
  const calibrator = createCalibrator();
  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const timezone = 'UTC';
  const selfName = 'Nept';
  const system = 'S';
  const profilesJson = JSON.stringify({});
  const guildJson = JSON.stringify({ patterns: '', starters: '', injokes: [], self: [] });
  const profilesBlock = `<existing_profiles>\n${profilesJson}\n</existing_profiles>`;
  const guildBlock = `<existing_guild>\n${guildJson}\n</existing_guild>`;
  const fixedCost = cost(system) + cost(profilesBlock) + cost(guildBlock);

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
      assert.deepEqual(result, { users: 0, guild: false, self: false });
    }
    assert.deepEqual(store.getGuild(guildId), before);
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
