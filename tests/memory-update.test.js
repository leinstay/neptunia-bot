// Tests for src/memory/update.js: buffering, the memory-update request
// builder and applying the model's JSON reply. tests/fixtures/labels.js is
// an English fixture covering every key of the prompt contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/memory/store.js';
import { isDue, buildMemoryRequest, applyMemoryUpdate, createMemoryUpdater, touchMemory, computeSeenAt, batchAuthorNamesMap, characterText } from '../src/memory/update.js';
import { createCalibrator, estimateTokens } from '../src/llm/tokens.js';
import { formatTranscript } from '../src/discord/format.js';
import { TokenLimitError } from '../src/llm/openrouter.js';
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
    profiles: { 1: { names: ['nick'], character: 'cheerful', interests: [], style: '', details: [], relationship: '' } },
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

// ---- buildMemoryRequest: limit placeholders --------------------------------

test('buildMemoryRequest: fills every limit placeholder from config.memory / config.relationships', () => {
  const config = makeConfig({
    memory: {
      ...makeConfig().memory,
      fieldChars: 1000,
      maxDetails: 7,
      maxInjokes: 8,
      maxSelfFacts: 9,
      maxNewEpisodes: 2,
      maxEpisodes: 30,
      maxInterests: 20,
    },
    relationships: { maxDeltaPerUpdate: 25 },
  });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const template =
    '{{fieldChars}} {{guildFieldChars}} {{maxDetails}} {{maxInjokes}} {{maxSelfFacts}} {{maxNewEpisodes}} {{maxEpisodes}} {{maxDeltaPerUpdate}} {{maxInterests}}';

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: template, labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, '1000 2000 7 8 9 2 30 25 20');
});

test('buildMemoryRequest: absent config keys fall back to the config.json defaults', () => {
  const config = makeConfig({ memory: {} }); // no relationships block either
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const template =
    '{{fieldChars}} {{guildFieldChars}} {{maxDetails}} {{maxInjokes}} {{maxSelfFacts}} {{maxNewEpisodes}} {{maxEpisodes}} {{maxDeltaPerUpdate}} {{maxInterests}}';

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: template, labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, '400 800 15 15 20 3 20 15 12');
});

test('buildMemoryRequest: fills {{loreTextChars}} from config.lore.textChars', () => {
  const config = makeConfig({ lore: { textChars: 600 } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'Lore text stays under {{loreTextChars}} chars.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, 'Lore text stays under 600 chars.');
});

test('buildMemoryRequest: {{loreTextChars}} falls back to 400 when config.lore is absent', () => {
  const config = makeConfig(); // no lore block at all
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'Lore text stays under {{loreTextChars}} chars.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, 'Lore text stays under 400 chars.');
});

test('buildMemoryRequest: an unknown {{placeholder}} is left untouched', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'Hello {{name}}, the {{unknownThing}} stays as-is.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, 'Hello Nept, the {{unknownThing}} stays as-is.');
});

test('buildMemoryRequest: a prompt with no placeholders at all is left unchanged', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'Plain memory prompt, no placeholders at all.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, 'Plain memory prompt, no placeholders at all.');
});

test('analyze: the completion sent to the LLM carries the filled number, not the braces', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, fieldChars: 1000 } }),
      prompts: { memory: 'Keep every field under {{fieldChars}} characters.', labels },
    };
    const calibrator = createCalibrator();
    let seenSystem = null;
    const llm = { complete: async (messages) => { seenSystem = messages[0].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(seenSystem, 'Keep every field under 1000 characters.');
  });
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

// ---- <character> = card + the owner's live rules, same as the chat prompt ----

test('characterText: joins the card and the rules with a blank line, both {{name}} filled', () => {
  const text = characterText({ 'character-card': 'Card of {{name}}.', rules: 'Never mention {{name}} twice.' }, 'Nept');
  assert.equal(text, 'Card of Nept.\n\nNever mention Nept twice.');
});

test('characterText: no rules -> the card alone', () => {
  const text = characterText({ 'character-card': 'Card of {{name}}.' }, 'Nept');
  assert.equal(text, 'Card of Nept.');
});

test('characterText: empty rules -> the card alone', () => {
  const text = characterText({ 'character-card': 'Card of {{name}}.', rules: '' }, 'Nept');
  assert.equal(text, 'Card of Nept.');
});

test('buildMemoryRequest: relationships on appends prompts.rules after the card in the <character> block', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', 'character-card': 'Card of {{name}}.', rules: 'Never say {{name}} twice.', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  assert.match(user, /<character>\nCard of Nept\.\n\nNever say Nept twice\.\n<\/character>/);
});

test('buildMemoryRequest: relationships on with no rules configured renders the card alone', () => {
  const config = makeConfig({ features: { relationships: true } });
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

  const user = llmMessages[1].content;
  assert.match(user, /<character>\nCard of Nept\.\n<\/character>/);
});

test('buildMemoryRequest: relationships on adds affinity: { score, reason } to each existing profile', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], relationship: '', affinity: { score: 42, reason: 'helped once', history: [] } } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].affinity, { score: 42, reason: 'helped once' });
});

test('buildMemoryRequest: a damped (fractional) stored score is rounded to an integer for the analyzer', () => {
  const config = makeConfig({ features: { relationships: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], relationship: '', affinity: { score: 60.4, reason: 'helped once', history: [] } } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].affinity, { score: 60, reason: 'helped once' });
});

test('buildMemoryRequest: relationships off never adds affinity to existing profiles', () => {
  const config = makeConfig({ features: { relationships: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], relationship: '', affinity: { score: 42, reason: 'helped once', history: [] } } },
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

// ---- buildMemoryRequest: <existing_channels> "main" flag -------------------

test('buildMemoryRequest: a channel listed in memory.mainChannelIds carries "main": true, others omit the key', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, mainChannelIds: ['c1'] } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: {
      c1: { name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' },
      c2: { name: 'diary', category: null, topic: null, purpose: '', topics: '', tone: '' },
    },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal(channels.c1.main, true);
  assert.equal('main' in channels.c2, false);
});

test('buildMemoryRequest: memory.mainChannelIds compares ids as strings, numbers-in-strings included', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, mainChannelIds: [123] } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: '123', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: { 123: { name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' } },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal(channels['123'].main, true);
});

test('buildMemoryRequest: a non-array memory.mainChannelIds is treated as empty, never throws', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, mainChannelIds: 'c1' } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: { c1: { name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' } },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal('main' in channels.c1, false);
});

test('buildMemoryRequest: non-string/garbage entries in memory.mainChannelIds are coerced, never throw', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, mainChannelIds: [null, {}, ['x'], 'c1'] } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: { c1: { name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' } },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal(channels.c1.main, true);
});

test('buildMemoryRequest: an absent memory.mainChannelIds omits "main" from every channel', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    channels: { c1: { name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' } },
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const channels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal('main' in channels.c1, false);
});

test('analyze: a hot change to memory.mainChannelIds between two requests is picked up', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.touchChannel(guildId, 'c1', { name: 'general' }, Date.now());
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, mainChannelIds: [] } }), prompts: { memory: 'sys', labels } };
    const seenUsers = [];
    const llm = { complete: async (messages) => { seenUsers.push(messages[1].content); return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general' })]);
    hot.config.memory.mainChannelIds = ['c1'];
    await updater.analyze(guildId, [slimMessage({ id: 'm2', channelId: 'c1', channelName: 'general' })]);

    const firstChannels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(seenUsers[0])[1]);
    const secondChannels = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(seenUsers[1])[1]);
    assert.equal('main' in firstChannels.c1, false);
    assert.equal(secondChannels.c1.main, true);
  });
});

test('analyze: a hot change to lore.textChars between two updates is picked up', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const longText = 'x'.repeat(200);
    const hot = { config: makeConfig({ lore: { textChars: 50 } }), prompts: { memory: 'sys', labels } };
    const llm = { complete: async () => ({ text: JSON.stringify({ lore: [{ title: 'Event', keys: ['event'], text: longText }] }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);
    assert.equal(store.getLore(guildId)[0].text.length, Math.floor(50 * 1.25));

    hot.config.lore.textChars = 150;
    await updater.analyze(guildId, [slimMessage({ id: 'm2' })]);
    assert.equal(store.getLore(guildId)[0].text.length, Math.floor(150 * 1.25));
  });
});

test('analyze: a hot change to memory.clampTolerance between two updates is picked up', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const longText = 'x'.repeat(600);
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, fieldChars: 100, clampTolerance: 1 } }),
      prompts: { memory: 'sys', labels },
    };
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { 1: { character: longText } } }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick' })]);
    assert.equal(store.getUser(guildId, '1').character.length, 100, 'tolerance 1 -- a hard limit');

    hot.config.memory.clampTolerance = 2;
    await updater.analyze(guildId, [slimMessage({ id: 'm2', authorId: '1', authorName: 'nick' })]);
    assert.equal(store.getUser(guildId, '1').character.length, 200, 'tolerance 2, read fresh on this call');
  });
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

test('buildMemoryRequest: a described picture renders imageDescribed via the descriptions map', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [
    slimMessage({
      id: 'm1',
      content: '',
      attachments: [{ id: 'a1', kind: 'image', name: 'pic.png' }],
      ts: Date.UTC(2026, 0, 1, 12, 0, 0),
    }),
  ];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
    descriptions: new Map([['a1', 'a grey cat']]),
  });

  assert.ok(llmMessages[1].content.includes(labels.transcript.imageDescribed.replace('{text}', 'a grey cat')));
});

// ---- analyze: description wiring --------------------------------------------
// The live analyzer never triggers a new describer request itself (there is
// no describer dependency left on createMemoryUpdater at all): it only reads
// whatever src/discord/events.js already warmed into the shared media cache,
// keyed by item id -- see src/memory/describe.js's cache shape.

test('analyze: features.mediaDescriptions off never renders a cached description, even when one exists', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId).a1 = { text: 'a cat', ts: Date.now() };

    const messages = [
      slimMessage({ id: 'm1', content: '', attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', durationSec: null }] }),
    ];
    await updater.analyze(guildId, messages);

    assert.ok(!seenUser.includes('a cat'));
    assert.ok(seenUser.includes(labels.transcript.image));
  });
});

test('analyze: features.mediaDescriptions on renders a cached description via imageDescribed, no separate request', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ features: { mediaDescriptions: true } }),
      prompts: { memory: 'sys', labels },
    };
    const calibrator = createCalibrator();
    let seenUser = null;
    let llmCalls = 0;
    const llm = { complete: async (messages) => { llmCalls += 1; seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId).a1 = { text: 'a grey cat', ts: Date.now() };

    const messages = [
      slimMessage({ id: 'm1', content: '', attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', durationSec: null }] }),
    ];
    await updater.analyze(guildId, messages);

    assert.equal(llmCalls, 1, 'only the one memory-update completion, no description request from analyze()');
    assert.ok(seenUser.includes(labels.transcript.imageDescribed.replace('{text}', 'a grey cat')));
  });
});

test('analyze: a cache miss (or nothing cached yet) renders the blind form, never a request', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ features: { mediaDescriptions: true } }),
      prompts: { memory: 'sys', labels },
    };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId).a1 = { miss: true, ts: Date.now() };

    const messages = [
      slimMessage({ id: 'm1', content: '', attachments: [{ id: 'a1', kind: 'image', name: 'pic.png', durationSec: null }] }),
    ];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.image));
  });
});

test('analyze: a cached sticker description renders via stickerDescribed, keyed sticker:<id> -- no URL ever needed', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features: { mediaDescriptions: true } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId)['sticker:s1'] = { text: 'a frog gives a thumbs up', ts: Date.now() };

    const messages = [slimMessage({ id: 'm1', content: '', stickers: [{ id: 's1', name: 'pepe', format: 1 }] })];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.stickerDescribed.replace('{name}', 'pepe').replace('{text}', 'a frog gives a thumbs up')));
  });
});

test('analyze: a Lottie sticker never looks up a cache entry, always the plain name form', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features: { mediaDescriptions: true } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    // Even if a cache entry somehow existed under this key, a Lottie sticker must never use it.
    store.getMediaCache(guildId)['sticker:s1'] = { text: 'should never show', ts: Date.now() };

    const messages = [slimMessage({ id: 'm1', content: '', stickers: [{ id: 's1', name: 'wiggle', format: 3 }] })];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.sticker.replace('{name}', 'wiggle')));
    assert.ok(!seenUser.includes('should never show'));
  });
});

test('analyze: a cached emoji description renders via emojiDescribed, keyed emoji:<id>', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features: { mediaDescriptions: true } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId)['emoji:e1'] = { text: 'a surprised cat face', ts: Date.now() };

    const messages = [slimMessage({ id: 'm1', content: 'nice :pog:', emojis: [{ id: 'e1', name: 'pog' }] })];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.emojiDescribed.replace('{name}', 'pog').replace('{text}', 'a surprised cat face')));
  });
});

test('analyze: a described link thumbnail renders via thumbnailDescribed, keyed by the id already stored (the stable hash)', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features: { mediaDescriptions: true } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenUser = null;
    const llm = { complete: async (messages) => { seenUser = messages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });
    store.getMediaCache(guildId)['link:abcd1234'] = { text: 'a cat plays piano', ts: Date.now() };

    const messages = [
      slimMessage({
        id: 'm1',
        content: '',
        links: [{ id: 'link:abcd1234', kind: 'link', name: 'Cool video', durationSec: null }],
      }),
    ];
    await updater.analyze(guildId, messages);

    assert.ok(seenUser.includes(labels.transcript.thumbnailDescribed.replace('{text}', 'a cat plays piano')));
  });
});

// ---- analyze: video states from the shared media cache ----------------------

/** Run analyze() over `messages` with `cacheEntries` preset; returns the user text the analyzer saw. */
async function analyzerTranscriptWithCache(cacheEntries, messages, features = { mediaDescriptions: true, videoDescriptions: true }) {
  let seenUser = null;
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ features }), prompts: { memory: 'sys', labels } };
    const llm = { complete: async (llmMessages) => { seenUser = llmMessages[1].content; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });
    Object.assign(store.getMediaCache(guildId), cacheEntries);
    await updater.analyze(guildId, messages);
  });
  return seenUser;
}

const VIDEO_SLIM = slimMessage({
  id: 'm1',
  content: '',
  attachments: [{ id: 'v1', kind: 'video', name: 'clip.mp4', durationSec: 20 }],
});
const VIDEO_LINK_SLIM = slimMessage({
  id: 'm1',
  content: '',
  links: [{ id: 'video:url:0123456789abcdef', kind: 'link', name: 'A title', durationSec: null }],
});

test('analyze: a watched video in the cache renders videoWatched in the analyzer transcript', async () => {
  const seen = await analyzerTranscriptWithCache({ 'video:v1': { text: 'κάποιος χορεύει', ts: Date.now(), watched: true } }, [VIDEO_SLIM]);
  const watched = labels.transcript.videoWatched
    .replace('{name}', 'clip.mp4')
    .replace('{duration}', '0:20')
    .replace('{text}', 'κάποιος χορεύει');
  assert.ok(seen.includes(watched));
});

test('analyze: a watched video-site link renders linkWatched, keyed video:<link id>', async () => {
  const seen = await analyzerTranscriptWithCache(
    { 'video:video:url:0123456789abcdef': { text: 'un chat joue du piano', ts: Date.now(), watched: true } },
    [VIDEO_LINK_SLIM],
  );
  assert.ok(seen.includes(labels.transcript.linkWatched.replace('{text}', 'un chat joue du piano')));
});

test('analyze: a permanent limit renders as not watched with its reason', async () => {
  const seen = await analyzerTranscriptWithCache({ 'video:v1': { miss: true, ts: Date.now(), reason: 'length' } }, [VIDEO_SLIM]);
  const notWatched = labels.transcript.videoNotWatched
    .replace('{name}', 'clip.mp4')
    .replace('{duration}', '0:20')
    .replace('{reason}', labels.transcript.videoReason.length);
  assert.ok(seen.includes(notWatched));
});

test('analyze: an error miss or no entry renders the plain video form', async () => {
  for (const cache of [{ 'video:v1': { miss: true, ts: Date.now(), reason: 'error' } }, {}]) {
    const seen = await analyzerTranscriptWithCache(cache, [VIDEO_SLIM]);
    assert.ok(seen.includes(labels.transcript.video.replace('{name}', 'clip.mp4').replace('{duration}', '0:20')));
    assert.ok(!seen.includes('not watched'));
  }
});

test('analyze: videoDescriptions off, or mediaDescriptions off, never renders a cached video state', async () => {
  for (const features of [
    { mediaDescriptions: true, videoDescriptions: false },
    { mediaDescriptions: false, videoDescriptions: true },
  ]) {
    const seen = await analyzerTranscriptWithCache(
      { 'video:v1': { text: 'should never show', ts: Date.now(), watched: true } },
      [VIDEO_SLIM],
      features,
    );
    assert.ok(!seen.includes('should never show'));
  }
});

// ---- applyMemoryUpdate: channels --------------------------------------------

test('applyMemoryUpdate: merges purpose/topics/tone for a known channel id, clamped tolerantly to fieldChars', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchChannel(guildId, 'c1', { name: 'general', category: null, topic: null }, Date.now());
    const cfg = { fieldChars: 5, maxDetails: 2, maxInjokes: 2, maxSelfFacts: 2 };

    const update = { channels: { c1: { purpose: 'a long purpose text', topics: 'games', tone: 'chill' } } };
    const result = applyMemoryUpdate(store, guildId, update, cfg, new Set(), new Set(['c1']));

    assert.equal(result.channels, 1);
    const channel = store.getChannel(guildId, 'c1');
    // fieldChars 5 * the default tolerance 1.25 = 6, which lands exactly on the word
    // boundary right after "long" -- so the whole word is kept, not cut mid-word.
    assert.equal(channel.purpose, 'a long');
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
      users: { 1: { character: '0123456789', details: { add: [longDetail, 'b', 'c'] } } },
    };

    const result = applyMemoryUpdate(store, guildId, update, cfg, new Set(['1']));

    assert.equal(result.users, 1);
    const profile = store.getUser(guildId, '1');
    // fieldChars 5 * the default tolerance 1.25 = 6, hard-cut (a single long word, no boundary).
    assert.equal(profile.character, '012345');
    assert.deepEqual(
      profile.details.map((d) => d.text),
      ['b', 'c'],
      'over maxDetails: same weight/lastSeen, so the earliest-added (the long one) is evicted first',
    );
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
    applyMemoryUpdate(store, guildId, { users: { 1: { relationship: 'old', style: 'calm' } } }, MEMORY_CFG, new Set(['1']));

    const result = applyMemoryUpdate(store, guildId, { users: { 1: { style: 'new' } } }, MEMORY_CFG, new Set(['1']));

    assert.equal(result.users, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.style, 'new');
    assert.equal(profile.relationship, 'old');
  });
});

test('applyMemoryUpdate: an empty-string prose field never blanks the stored value', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { character: 'chatty' } } }, MEMORY_CFG, new Set(['1']));

    applyMemoryUpdate(store, guildId, { users: { 1: { character: '' } } }, MEMORY_CFG, new Set(['1']));

    assert.equal(store.getUser(guildId, '1').character, 'chatty');
  });
});

// ---- applyMemoryUpdate: portrait refresh cues --------------------------------
// See docs/prompt-contract.md, "Data model": `character`/`style` stay
// plain prose, written only by profile.md (the warmup / a portrait
// refresh). The stream analyzer's `users.<id>.portrait` is a CUE, not an
// edit: never stored, only collected into `result.portraitRequests` for the
// caller (analyze()) to hand to an injected refresh callback.

test('applyMemoryUpdate: a portrait cue for a known user is collected, never stored', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { portrait: 'now argues a lot, the stored portrait never mentions it' } } },
      MEMORY_CFG,
      new Set(['1']),
    );

    assert.deepEqual(result.portraitRequests, [{ userId: '1', reason: 'now argues a lot, the stored portrait never mentions it' }]);
    assert.equal(store.getUser(guildId, '1').character, '', 'never written to the profile');
  });
});

test('applyMemoryUpdate: a portrait cue for an unknown user is ignored', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const result = applyMemoryUpdate(store, guildId, { users: { 999: { portrait: 'x'.repeat(20) } } }, MEMORY_CFG, new Set(['1']));

    assert.deepEqual(result.portraitRequests, []);
  });
});

test('applyMemoryUpdate: a portrait cue is clamped to 200 characters', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    const cfg = { ...MEMORY_CFG, clampTolerance: 1 };

    const result = applyMemoryUpdate(store, guildId, { users: { 1: { portrait: 'x'.repeat(250) } } }, cfg, new Set(['1']));

    assert.equal(result.portraitRequests[0].reason.length, 200);
  });
});

test('applyMemoryUpdate: a portrait cue is tokenized like other prose', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { portrait: 'now argues with Bran (id:223456789012345678) a lot' } } },
      MEMORY_CFG,
      new Set(['1']),
    );

    assert.equal(result.portraitRequests[0].reason, 'now argues with <@223456789012345678> a lot');
  });
});

test('applyMemoryUpdate: an empty/whitespace-only or non-string portrait cue is dropped, not collected', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    for (const garbage of ['', '   ', null, 42, {}, []]) {
      const result = applyMemoryUpdate(store, guildId, { users: { 1: { portrait: garbage } } }, MEMORY_CFG, new Set(['1']));
      assert.deepEqual(result.portraitRequests, [], `garbage ${JSON.stringify(garbage)} must not be collected`);
    }
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
      assert.deepEqual(result, {
        users: 0,
        guild: false,
        self: false,
        affinity: 0,
        channels: 0,
        episodes: 0,
        lore: 0,
        interestsChanged: 0,
        portraitRequests: [],
      });
    }
    assert.deepEqual(store.getGuild(guildId), before);
  });
});

// ---- applyMemoryUpdate: relationships -------------------------------------

const RELATIONSHIPS_CFG = { enabled: true, maxDeltaPerUpdate: 15, historySize: 10, now: Date.UTC(2026, 0, 1) };
const MEMORY_CFG = {
  fieldChars: 400,
  maxDetails: 15,
  maxInjokes: 15,
  maxSelfFacts: 20,
  maxInterests: 12,
  interestTopicChars: 40,
  interestNoteChars: 120,
};

test('applyMemoryUpdate: relationships enabled applies and clamps the affinity delta, counts changed scores', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { affinity: { delta: 999, reason: 'was really kind' } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), RELATIONSHIPS_CFG);

    assert.equal(result.users, 1);
    assert.equal(result.affinity, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.affinity.score, 15, 'delta is clamped to maxDeltaPerUpdate');
    assert.equal(profile.affinity.reason, 'was really kind');
  });
});

test('applyMemoryUpdate: relationships.damping missing counts as on, damping an already one-sided score', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 50, 'a good start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { affinity: { delta: 10, reason: 'kind again' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), RELATIONSHIPS_CFG);

    // factor = 1 - 50/100 = 0.5 -> applied delta = 5, not the full 10.
    assert.equal(store.getUser(guildId, '1').affinity.score, 55);
  });
});

test('applyMemoryUpdate: relationships.dampingPower steepens/flattens the damping curve', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 60, 'a good start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { affinity: { delta: 1, reason: 'kind again' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), { ...RELATIONSHIPS_CFG, dampingPower: 2 });

    // factor = (1 - 60/100) ** 2 = 0.16, not the plain power-1 factor of 0.4.
    assert.equal(store.getUser(guildId, '1').affinity.score, 60.16);
  });
});

test('applyMemoryUpdate: relationships.dampingPower garbage falls back to 1', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 60, 'a good start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { affinity: { delta: 1, reason: 'kind again' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), { ...RELATIONSHIPS_CFG, dampingPower: 'not a number' });

    assert.equal(store.getUser(guildId, '1').affinity.score, 60.4);
  });
});

test('applyMemoryUpdate: relationships.damping: false applies the delta undamped', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.adjustAffinity(guildId, '1', 50, 'a good start', { maxDelta: Infinity, historySize: 10, now: Date.now() });

    const update = { users: { 1: { affinity: { delta: 10, reason: 'kind again' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), { ...RELATIONSHIPS_CFG, damping: false });

    assert.equal(store.getUser(guildId, '1').affinity.score, 60);
  });
});

test('applyMemoryUpdate: a zero/absent affinity delta does not count as a change', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { affinity: { delta: 0, reason: 'no change' } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), RELATIONSHIPS_CFG);
    assert.equal(result.affinity, 0);

    const noAffinityField = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { style: 'still chatty' } } },
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
      { users: { 1: { interests: { add: [{ topic: 'games', note: '' }] }, affinity: 'not an object' } } },
      MEMORY_CFG,
      new Set(['1']),
      new Set(),
      RELATIONSHIPS_CFG,
    );

    assert.equal(result.users, 1);
    assert.equal(result.affinity, 0);
    assert.equal(store.getUser(guildId, '1').interests[0].topic, 'games');
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

// ---- applyMemoryUpdate: episodes ----------------------------------------------

const EPISODES_CFG = { enabled: true, maxEpisodes: 20, maxNew: 3, now: Date.UTC(2026, 0, 1) };

test('applyMemoryUpdate: routes raw.episodes through store.addEpisodes, result gains the added count', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { episodes: [{ what: 'promised to help with the move' }] } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), undefined, EPISODES_CFG);

    assert.equal(result.episodes, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.episodes.length, 1);
    assert.equal(profile.episodes[0].what, 'promised to help with the move');
  });
});

test('applyMemoryUpdate: features.episodes off (episodes cfg absent) ignores raw.episodes entirely', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { episodes: [{ what: 'should be ignored' }] } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    assert.equal(result.episodes, 0);
    assert.deepEqual(store.getUser(guildId, '1').episodes, []);
  });
});

test('applyMemoryUpdate: updateUser can never overwrite episodes via a normal profile field', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.addEpisodes(guildId, '1', [{ what: 'a real episode' }], { maxEpisodes: 20, maxNew: 3, now: 1000 });

    const update = { users: { 1: { character: 'nice', episodes: 'this is not routed through this key' } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.character, 'nice');
    assert.equal(profile.episodes.length, 1);
    assert.equal(profile.episodes[0].what, 'a real episode');
  });
});

// ---- applyMemoryUpdate: lore ---------------------------------------------------

const LORE_CFG = { enabled: true, maxEntries: 500, now: Date.UTC(2026, 0, 1) };

test('applyMemoryUpdate: routes update.lore through store.setLore, result gains the upserted count', () => {
  withStore((store) => {
    const guildId = 'g1';
    const update = { lore: [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }] };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(), new Set(), undefined, undefined, LORE_CFG);

    assert.equal(result.lore, 1);
    assert.equal(store.getLore(guildId).length, 1);
    assert.equal(store.getLore(guildId)[0].source, 'analyzer');
  });
});

test('applyMemoryUpdate: features.lore off (lore cfg absent) ignores update.lore entirely', () => {
  withStore((store) => {
    const guildId = 'g1';
    const update = { lore: [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }] };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set());

    assert.equal(result.lore, 0);
    assert.deepEqual(store.getLore(guildId), []);
  });
});

test('applyMemoryUpdate: lore never overwrites an existing owner entry', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.setLore(guildId, [{ title: 'Founders Day', keys: ['founders'], text: 'owner text', always: true }], {
      source: 'owner',
      now: 1000,
    });

    const update = { lore: [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer overwrite attempt' }] };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(), new Set(), undefined, undefined, LORE_CFG);

    assert.equal(store.getLore(guildId)[0].text, 'owner text');
  });
});

// ---- buildMemoryRequest: episodes in <existing_profiles> ----------------------

test('buildMemoryRequest: relationships/episodes on adds episodes {date, what, quote, weight} to existing profiles', () => {
  const config = makeConfig({ features: { episodes: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        interests: [],
        style: '',
        details: [],
        relationship: '',
        episodes: [{ date: '2026-01-01', what: 'said hi', quote: 'hi there', feeling: 'pleased', weight: 3, addedAt: 'x' }],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].episodes, [{ date: '2026-01-01', what: 'said hi', quote: 'hi there', weight: 3 }]);
});

test('buildMemoryRequest: features.episodes=false never adds episodes to existing profiles', () => {
  const config = makeConfig({ features: { episodes: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', interests: [], style: '', details: [], relationship: '', episodes: [{ date: '2026-01-01', what: 'x' }] } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.equal(profiles['1'].episodes, undefined);
});

// ---- buildMemoryRequest: <existing_lore> ---------------------------------------

test('buildMemoryRequest: <existing_lore> lists all stored titles+keys and the full text of matched entries', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', content: 'remember the great flood', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const loreEntries = [
    { id: 'a', title: 'The Flood', keys: ['flood'], text: 'It flooded once.', always: false, source: 'analyzer', weight: 3, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b', title: 'Unrelated Thing', keys: ['banana'], text: 'A banana story.', always: false, source: 'analyzer', weight: 3, updatedAt: '2026-01-02T00:00:00.000Z' },
  ];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
    loreEntries,
  });

  const user = llmMessages[1].content;
  const lore = JSON.parse(/<existing_lore>\n([\s\S]*?)\n<\/existing_lore>/.exec(user)[1]);
  assert.deepEqual(
    lore.titles.map((t) => t.title).sort(),
    ['The Flood', 'Unrelated Thing'],
  );
  assert.deepEqual(lore.matched, [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }]);
});

test('buildMemoryRequest: <existing_lore> titles are capped to the 200 most recently updated', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', content: 'nothing relevant', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const loreEntries = Array.from({ length: 205 }, (_, i) => ({
    id: `e${i}`,
    title: `Entry ${i}`,
    keys: ['x'.repeat(3)],
    text: 'text',
    always: false,
    source: 'analyzer',
    weight: 3,
    updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
  }));

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
    loreEntries,
  });

  const user = llmMessages[1].content;
  const lore = JSON.parse(/<existing_lore>\n([\s\S]*?)\n<\/existing_lore>/.exec(user)[1]);
  assert.equal(lore.titles.length, 200);
  assert.ok(lore.titles.some((t) => t.title === 'Entry 204'), 'the most recently updated entry survives the cap');
  assert.ok(!lore.titles.some((t) => t.title === 'Entry 0'), 'the oldest updated entry is cut');
});

test('buildMemoryRequest: no <existing_lore> block when there is no stored lore', () => {
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
    loreEntries: [],
  });

  assert.ok(!llmMessages[1].content.includes('<existing_lore>'));
});

test('buildMemoryRequest: features.lore=false never renders <existing_lore>, even with stored entries', () => {
  const config = makeConfig({ features: { lore: false } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
  const loreEntries = [{ id: 'a', title: 'X', keys: ['x'], text: 'text', always: false, source: 'analyzer', weight: 3, updatedAt: 'now' }];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
    loreEntries,
  });

  assert.ok(!llmMessages[1].content.includes('<existing_lore>'));
});

// ---- analyze: timeoutMs ---------------------------------------------------------

test('analyze: passes memory.timeoutMs (falling back to llm.timeoutMs) as options.timeoutMs', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, timeoutMs: 300000 } }),
      prompts: { memory: 'sys', labels },
    };
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);
    assert.equal(seenOptions.timeoutMs, 300000);
  });
});

test('analyze: falls back to llm.timeoutMs when memory.timeoutMs is unset', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } }; // makeConfig's memory has no timeoutMs
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);
    assert.equal(seenOptions.timeoutMs, hot.config.llm.timeoutMs);
  });
});

// ---- buildMemoryRequest: existing_profiles interests shape -----------------

test('buildMemoryRequest: existing_profiles interests are [{topic, note, seen, last}] ordered by weight, heaviest first', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        details: [],
        relationship: '',
        interests: [
          { topic: 'Anime', note: 'watches shonen', weight: 2, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
          { topic: 'Chess', note: '', weight: 5, firstSeen: 'a', lastSeen: null },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].interests, [
    { topic: 'Chess', note: '', seen: 5 },
    { topic: 'Anime', note: 'watches shonen', seen: 2, last: '2026-01-05' },
  ]);
});

test('buildMemoryRequest: a profile with no interests yet renders an empty interests array', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['nick'], character: '', style: '', details: [], relationship: '' } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].interests, []);
});

test('buildMemoryRequest: existing_profiles details are [{id, text, seen, last}]', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        relationship: '',
        interests: [],
        details: [
          { id: 3, text: 'Owns a cat', weight: 2, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
          { id: 4, text: 'Plays guitar', weight: 1, firstSeen: 'a', lastSeen: null },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].details, [
    { id: 3, text: 'Owns a cat', seen: 2, last: '2026-01-05' },
    { id: 4, text: 'Plays guitar', seen: 1 },
  ]);
});

// ---- buildMemoryRequest: existing_profiles interests/details, top N by rank ---

test('buildMemoryRequest: existing_profiles interests show only the top memory.maxInterests by rank, in rank order', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, maxInterests: 2, interestHalfLifeDays: 180 } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        details: [],
        relationship: '',
        interests: [
          { topic: 'Ancient favorite', note: '', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
          { topic: 'Recent A', note: '', weight: 2, firstSeen: 'a', lastSeen: '2026-09-01T00:00:00.000Z' },
          { topic: 'Recent B', note: '', weight: 2, firstSeen: 'a', lastSeen: '2026-09-05T00:00:00.000Z' },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(
    profiles['1'].interests.map((i) => i.topic),
    ['Recent B', 'Recent A'],
    'the two most recent outrank the ancient heavy one and appear in rank order',
  );
});

test('buildMemoryRequest: existing_profiles details show only the top memory.maxDetails by rank, in rank order', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, maxDetails: 1, detailHalfLifeDays: 30 } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        relationship: '',
        interests: [],
        details: [
          { id: 1, text: 'Ancient favorite fact', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
          { id: 2, text: 'Fresh detail', weight: 1, firstSeen: 'a', lastSeen: '2026-09-20T00:00:00.000Z' },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].details.map((d) => d.id), [2], 'a short half-life lets the fresh detail outrank the ancient heavier one');
});

test('buildMemoryRequest: without memory.maxInterests/interestHalfLifeDays, the existing_profiles view is unlimited and unchanged from before (weight order)', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'sys', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['nick'],
        character: '',
        style: '',
        details: [],
        relationship: '',
        interests: [
          { topic: 'Anime', note: 'watches shonen', weight: 2, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
          { topic: 'Chess', note: '', weight: 5, firstSeen: 'a', lastSeen: null },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const user = llmMessages[1].content;
  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(user)[1]);
  assert.deepEqual(profiles['1'].interests, [
    { topic: 'Chess', note: '', seen: 5 },
    { topic: 'Anime', note: 'watches shonen', seen: 2, last: '2026-01-05' },
  ]);
});

// ---- applyMemoryUpdate: interests / details, incremental shape --------------

test('applyMemoryUpdate: routes users.<id>.interests {add, update, remove} through store.applyProfileOps', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { interests: { add: [{ topic: 'Chess', note: 'plays weekly' }] } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    assert.equal(result.users, 1);
    assert.equal(result.interestsChanged, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.interests.length, 1);
    assert.equal(profile.interests[0].topic, 'Chess');
    assert.equal(profile.interests[0].note, 'plays weekly');
  });
});

test('applyMemoryUpdate: threads maxInterestsStored/interestHalfLifeDays/maxDetailsStored/detailHalfLifeDays through to store.applyProfileOps', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const ancientMs = Date.parse('2021-01-01T00:00:00.000Z');
    const cfgAncient = { ...MEMORY_CFG, maxInterests: 1, maxInterestsStored: 1, maxDetails: 1, maxDetailsStored: 1 };
    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { interests: { add: [{ topic: 'Ancient favorite' }] }, details: { add: ['Ancient favorite fact'] } } } },
      cfgAncient,
      new Set(['1']),
      undefined,
      undefined,
      undefined,
      undefined,
      { seenAt: ancientMs },
    );

    const recentMs = Date.parse('2026-09-20T00:00:00.000Z');
    const cfgDecay = {
      ...MEMORY_CFG,
      maxInterests: 1,
      maxInterestsStored: 1,
      interestHalfLifeDays: 30,
      maxDetails: 1,
      maxDetailsStored: 1,
      detailHalfLifeDays: 30,
    };
    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { interests: { add: [{ topic: 'Fresh interest' }] }, details: { add: ['Fresh detail'] } } } },
      cfgDecay,
      new Set(['1']),
      undefined,
      undefined,
      undefined,
      undefined,
      { seenAt: recentMs },
    );

    const profile = store.getUser(guildId, '1');
    assert.deepEqual(profile.interests.map((i) => i.topic), ['Fresh interest'], 'the storage cap (1) evicted the ancient interest by rank, not raw weight');
    assert.deepEqual(profile.details.map((d) => d.text), ['Fresh detail'], 'the storage cap (1) evicted the ancient detail by rank, not raw weight');
  });
});

test('applyMemoryUpdate: interestsChanged only counts users whose interests actually changed', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    store.touchUser(guildId, '2', 'other', Date.now());

    const update = {
      users: {
        1: { interests: { add: [{ topic: 'chess', note: '' }] } },
        2: { character: 'friendly' },
      },
    };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1', '2']));

    assert.equal(result.users, 2);
    assert.equal(result.interestsChanged, 1);
  });
});

test('applyMemoryUpdate: a no-op interests update (garbage ops, nothing to change) does not count as changed', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { interests: { add: [{ topic: '   ' }] } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    assert.equal(result.interestsChanged, 0);
  });
});

test('applyMemoryUpdate: raw.details as {add, remove} is applied directly', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { details: { add: ['old fact'] } } } }, MEMORY_CFG, new Set(['1']));

    const result = applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { details: { add: ['new fact'], remove: ['old fact'] } } } },
      MEMORY_CFG,
      new Set(['1']),
    );

    assert.equal(result.users, 1);
    assert.deepEqual(store.getUser(guildId, '1').details.map((d) => d.text), ['new fact']);
  });
});

test('applyMemoryUpdate: an absent prose field never blanks the stored value', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());
    applyMemoryUpdate(store, guildId, { users: { 1: { character: 'chatty', relationship: 'trusts you' } } }, MEMORY_CFG, new Set(['1']));

    applyMemoryUpdate(store, guildId, { users: { 1: { character: 'still chatty' } } }, MEMORY_CFG, new Set(['1']));

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.character, 'still chatty');
    assert.equal(profile.relationship, 'trusts you');
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

test('observe: strips attachment/link urls before buffering, keeps the item id for description-cache lookups', () => {
  withStore((store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe(
      'g1',
      slimMessage({
        content: 'look',
        attachments: [{ id: 'a1', kind: 'image', name: 'a.png', url: 'https://cdn.example/secret', durationSec: null }],
        links: [{ id: 'm1#e0', kind: 'gif', site: 'Tenor', title: 'cat', thumbnailUrl: 'https://t.tenor.com/x.png' }],
        stickers: [{ id: 's1', name: 'wow', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' }],
        emojis: [{ id: 'e1', name: 'pog', animated: false, url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' }],
      }),
    );

    const [buffered] = store.getBuffer('g1');
    assert.deepEqual(buffered.attachments, [{ kind: 'image', name: 'a.png', id: 'a1', durationSec: null }]);
    assert.equal('url' in buffered.attachments[0], false);
    assert.deepEqual(buffered.links, [{ kind: 'gif', name: 'cat', id: 'm1#e0', durationSec: null }]);
    assert.equal('url' in buffered.links[0], false);
    assert.equal('thumbnailUrl' in buffered.links[0], false);
    assert.deepEqual(buffered.stickers, [{ id: 's1', name: 'wow', format: 1 }]);
    assert.equal('url' in buffered.stickers[0], false);
    assert.deepEqual(buffered.emojis, [{ id: 'e1', name: 'pog' }]);
    assert.equal('url' in buffered.emojis[0], false);
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

// /nep pause: observe() must make the store dirty in NO way while paused.
test('observe: does nothing while store.state.data.paused is true -- no buffer, no user, no channel', () => {
  withStore((store) => {
    store.state.data.paused = true;
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    updater.observe('g1', slimMessage({ id: 'm1', channelId: 'c1', channelName: 'general', authorId: '1', authorName: 'nick' }));

    assert.deepEqual(store.getBuffer('g1'), []);
    assert.equal(store.getUser('g1', '1'), null);
    assert.equal(store.getChannel('g1', 'c1'), null);
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
        return { text: JSON.stringify({ users: { 1: { interests: { add: [{ topic: 'anime', note: '' }] } } }, guild: { patterns: 'friendly' }, self: [] }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId);

    assert.equal(store.getBuffer(guildId).length, 0);
    assert.equal(store.getUser(guildId, '1').interests[0].topic, 'anime');
    assert.equal(store.getGuild(guildId).patterns, 'friendly');
    assert.equal(seenOptions.maxOutputTokens, hot.config.memory.maxOutputTokens);
    assert.equal(seenOptions.temperature, 0.3);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', guildId, 'users', '1.json'), 'utf8'));
    assert.equal(onDisk.interests[0].topic, 'anime');
  });
});

// /nep pause: waitIdle() lets /nep pause wait out a live-analyzer run()
// already in flight (an LLM call can take 30-90s) before it flushes and
// drops the store's caches -- see src/admin.js#cmdPause.
test('waitIdle: resolves immediately when no run() is in flight', async () => {
  await withStoreAsync(async (store) => {
    const hot = { config: makeConfig() };
    const updater = createMemoryUpdater({ hot, store, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    let resolved = false;
    updater.waitIdle().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resolved, true);
  });
});

test('waitIdle: resolves only once the in-flight run() has finished, never starting a new one itself', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.pushBuffer(guildId, slimMessage({ id: 'm1' }), 100);

    let resolveLlm;
    const llm = {
      complete: () =>
        new Promise((resolve) => {
          resolveLlm = () => resolve({ text: JSON.stringify({ guild: { patterns: 'ok' } }) });
        }),
    };
    const hot = { config: makeConfig(), prompts: { memory: 'memory system prompt', labels } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    const runPromise = updater.run(guildId);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let run() reach the pending llm.complete() call

    let idleResolved = false;
    const idlePromise = updater.waitIdle().then(() => {
      idleResolved = true;
    });
    assert.equal(idleResolved, false, 'must not resolve while the run is still in flight');

    resolveLlm();
    await runPromise;
    await idlePromise;
    assert.equal(idleResolved, true);
    assert.equal(store.getGuild(guildId).patterns, 'ok', 'the in-flight run applied its result before waitIdle resolved');
  });
});

// /nep pause: the live analyzer must never run while paused, even with a fully due buffer.
test('tick: does nothing while store.state.data.paused is true, even with a due buffer', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    store.state.data.paused = true;
    const base = Date.now();
    for (let i = 0; i < 4; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 100);
    }

    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 4, minBatchMessages: 1 } }) };
    let calls = 0;
    const llm = { complete: async () => { calls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

    await updater.tick();

    assert.equal(calls, 0, 'the analyzer must never be called while paused');
    assert.equal(store.getBuffer(guildId).length, 4, 'the buffer is left exactly as it was');
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

test('run: a truncated failure halves the next batch size for that guild; a success restores it', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now();
    for (let i = 0; i < 90; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 200);
    }

    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 15, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    let call = 0;
    const llm = {
      complete: async () => {
        call += 1;
        if (call === 1) {
          // Cut mid-JSON by the output token cap: never going to parse.
          return {
            text: '{"users": {"1": {"interests": "cut off here',
            usage: { prompt_tokens: 1000, completion_tokens: 1000 },
            estimated: 2000,
            finishReason: 'length',
          };
        }
        return { text: JSON.stringify({ guild: { patterns: 'ok' } }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId); // fails 'truncated': halves the factor for next time
    assert.equal(store.getBuffer(guildId).length, 90, 'a failed run never shifts the buffer');

    await updater.run(guildId); // succeeds, but only at the halved size
    assert.equal(store.getBuffer(guildId).length, 70, 'only 20 (half of 30, floored at 20) were consumed, not 30');

    await updater.run(guildId); // succeeds again, size restored to normal
    assert.equal(store.getBuffer(guildId).length, 40, 'back to normal: 30 consumed this time, not another 20');
  });
});

test('run: a "token-limit" failure halves the next batch size too, instead of looping on the same buffer forever', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const base = Date.now();
    for (let i = 0; i < 90; i += 1) {
      store.pushBuffer(guildId, slimMessage({ id: `m${i}`, content: `hi ${i}`, ts: base + i * 1000 }), 200);
    }

    const hot = {
      config: makeConfig({ memory: { ...makeConfig().memory, batchMessages: 15, minBatchMessages: 1 } }),
      prompts: { memory: 'memory system prompt', labels },
    };
    const calibrator = createCalibrator();
    let call = 0;
    const llm = {
      complete: async () => {
        call += 1;
        // Stored profiles pushed the request over the per-request cap: with the
        // buffer untouched, a plain back-off would retry this exact same batch
        // forever. Halving the batch size (same as 'truncated'/'bad-json')
        // actually makes progress instead.
        if (call === 1) throw new TokenLimitError('request estimated at 90000 tokens, cap is 50000');
        return { text: JSON.stringify({ guild: { patterns: 'ok' } }) };
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.run(guildId); // fails 'token-limit': halves the factor for next time
    assert.equal(store.getBuffer(guildId).length, 90, 'a failed run never shifts the buffer');

    await updater.run(guildId); // succeeds, but only at the halved size
    assert.equal(store.getBuffer(guildId).length, 70, 'only 20 (half of 30, floored at 20) were consumed, not 30');

    await updater.run(guildId); // succeeds again, size restored to normal
    assert.equal(store.getBuffer(guildId).length, 40, 'back to normal: 30 consumed this time, not another 20');
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

test('touchMemory: bumps a human author into the channel\'s topWriters', () => {
  withStore((store) => {
    touchMemory(store, 'g1', slimMessage({ channelId: 'c1', channelName: 'general', authorId: '1', authorName: 'nick', self: false }));
    const channel = store.getChannel('g1', 'c1');
    assert.deepEqual(channel.topWriters, [{ id: '1', count: 1 }]);
  });
});

test('touchMemory: the persona\'s own message never counts toward topWriters', () => {
  withStore((store) => {
    touchMemory(store, 'g1', slimMessage({ channelId: 'c1', channelName: 'general', authorId: 'self1', self: true }));
    const channel = store.getChannel('g1', 'c1');
    assert.deepEqual(channel.topWriters, []);
  });
});

test('touchMemory: another bot\'s message never counts toward topWriters', () => {
  withStore((store) => {
    touchMemory(store, 'g1', slimMessage({ channelId: 'c1', channelName: 'general', authorId: 'bot1', bot: true, self: false }));
    const channel = store.getChannel('g1', 'c1');
    assert.deepEqual(channel.topWriters, []);
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
        text: JSON.stringify({ users: { 1: { interests: { add: [{ topic: 'anime', note: '' }] } } } }),
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
    assert.equal(store.getUser(guildId, '1').interests[0].topic, 'anime');
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
    assert.equal(outcome.reason, 'llm-error');
    assert.equal(outcome.detail, 'boom');
  });
});

test('analyze: a TokenLimitError from llm.complete reports reason "token-limit"', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => { throw new TokenLimitError('request estimated at 90000 tokens, cap is 50000'); } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.usage, null);
    assert.equal(outcome.reason, 'token-limit');
    assert.equal(outcome.detail, 'request estimated at 90000 tokens, cap is 50000');
  });
});

test('analyze: a SectionsTooLargeError from buildMemoryRequest (required sections do not fit) also reports "token-limit", and never reaches the provider', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    // A huge memory prompt against a tiny per-request cap: buildMemoryRequest's
    // fitSections cannot fit even the required sections, and throws a
    // SectionsTooLargeError before llm.complete is ever called (this must
    // surface as its own reason, not a plain 'llm-error', so a caller can tell
    // it apart from a genuine, retryable failure).
    const hot = {
      config: makeConfig({ llm: { ...makeConfig().llm, maxRequestTokens: 50, safetyMargin: 1 } }),
      prompts: { memory: 'x'.repeat(2000), labels },
    };
    const calibrator = createCalibrator();
    let completeCalls = 0;
    const llm = { complete: async () => { completeCalls += 1; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.usage, null);
    assert.equal(outcome.estimated, 0);
    assert.equal(outcome.reason, 'token-limit');
    assert.match(outcome.detail, /required prompt sections exceed the token limit by \d+/);
    assert.equal(completeCalls, 0, 'the oversized request never reaches the provider — nothing was billed');
  });
});

test('analyze: a network/provider error message is trimmed to 200 chars in detail', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const longMessage = 'x'.repeat(300);
    const llm = { complete: async () => { throw new Error(longMessage); } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.reason, 'llm-error');
    assert.equal(outcome.detail, longMessage.slice(0, 200));
    assert.equal(outcome.detail.length, 200);
  });
});

test('analyze: an error with an HTTP status (e.g. a 429 from the provider) surfaces it as outcome.status', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => {
        const err = new Error('OpenRouter HTTP 429: too many tokens per day');
        err.statusCode = 429;
        throw err;
      },
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'llm-error');
    assert.equal(outcome.status, 429);
  });
});

test('analyze: an error with no HTTP status leaves outcome.status undefined', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => { throw new Error('network blip'); } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.status, undefined);
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
    assert.equal(outcome.reason, 'bad-json', 'no "{" at all is not a truncation, just garbage');
  });
});

test('analyze: a completion with no closing "}" for its first "{" reports reason "truncated"', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        text: '{"users": {"1": {"interests": "a lot of anime and video games and',
        usage: { prompt_tokens: 4000, completion_tokens: 4000 },
        estimated: 8000,
        // finishReason omitted on purpose: the missing "}" alone must be enough
      }),
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'truncated');
    assert.deepEqual(outcome.usage, { prompt_tokens: 4000, completion_tokens: 4000 });
    assert.equal(outcome.estimated, 8000);
  });
});

test('analyze: finishReason "length" alone reports reason "truncated", even with a closing brace', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        // A closing "}" is present, but it belongs to a nested object cut
        // mid-string by max_tokens -- JSON.parse still fails on it.
        text: '{"users": {"1": {"interests": "anime"}',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        estimated: 150,
        finishReason: 'length',
      }),
    };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'truncated');
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

test('analyze: never opts out of the daily request cap, relying on llm.complete\'s own default (true)', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    let seenOptions = null;
    const llm = { complete: async (messages, options) => { seenOptions = options; return { text: '{}' }; } };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    await updater.analyze(guildId, [slimMessage({ id: 'm1' })]);

    assert.notEqual(seenOptions.countAgainstDailyCap, false);
  });
});

// ---- analyze: onPortraitRequest ----------------------------------------------
// See docs/prompt-contract.md, "Data model": a successful analyze()
// hands every collected `users.<id>.portrait` cue to the injected
// onPortraitRequest(guildId, userId, reason) callback; a later task wires the
// actual refresh. Never a store write on its own.

test('analyze: a portrait cue in the completion calls onPortraitRequest once for that user', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { 1: { portrait: 'now argues a lot' } } }) }) };
    const calls = [];
    const updater = createMemoryUpdater({
      hot,
      store,
      llm,
      calibrator,
      getSelfName: () => 'Nept',
      onPortraitRequest: (gid, userId, reason) => calls.push({ gid, userId, reason }),
    });

    await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick' })]);

    assert.deepEqual(calls, [{ gid: guildId, userId: '1', reason: 'now argues a lot' }]);
    assert.equal(store.getUser(guildId, '1').character, '', 'the cue is never written to the profile');
  });
});

test('analyze: no portrait cue in the completion never calls onPortraitRequest', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => ({ text: '{}' }) };
    let called = false;
    const updater = createMemoryUpdater({
      hot,
      store,
      llm,
      calibrator,
      getSelfName: () => 'Nept',
      onPortraitRequest: () => {
        called = true;
      },
    });

    await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick' })]);

    assert.equal(called, false);
  });
});

test('analyze: an absent onPortraitRequest is fine, no throw, even with a portrait cue in the completion', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig(), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = { complete: async () => ({ text: JSON.stringify({ users: { 1: { portrait: 'now argues a lot' } } }) }) };
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept' });

    const outcome = await updater.analyze(guildId, [slimMessage({ id: 'm1', authorId: '1', authorName: 'nick' })]);

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result.portraitRequests, [{ userId: '1', reason: 'now argues a lot' }]);
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
    assert.equal(outcome.reason, 'no-prompt');
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

// ---- computeSeenAt -----------------------------------------------------------

test('computeSeenAt: per user, the newest timestamp of THAT user\'s own messages in the batch', () => {
  const messages = [
    slimMessage({ id: 'm1', authorId: '1', ts: 1000 }),
    slimMessage({ id: 'm2', authorId: '1', ts: 3000 }),
    slimMessage({ id: 'm3', authorId: '2', ts: 2000 }),
  ];
  const { seenAtByUser, seenAt } = computeSeenAt(messages);
  assert.equal(seenAtByUser.get('1'), 3000);
  assert.equal(seenAtByUser.get('2'), 2000);
  assert.equal(seenAt, 3000, 'the batch-wide fallback is the overall newest message');
});

test('computeSeenAt: the persona\'s own messages never contribute a per-user entry, but do count for the batch fallback', () => {
  const messages = [
    slimMessage({ id: 'm1', authorId: '1', ts: 1000 }),
    slimMessage({ id: 'm2', authorId: 'self1', self: true, ts: 9000 }),
  ];
  const { seenAtByUser, seenAt } = computeSeenAt(messages);
  assert.equal(seenAtByUser.has('self1'), false);
  assert.equal(seenAt, 9000);
});

test('computeSeenAt: an empty/garbage-ts batch falls back to the wall clock', () => {
  const before = Date.now();
  const { seenAtByUser, seenAt } = computeSeenAt([]);
  assert.equal(seenAtByUser.size, 0);
  assert.ok(seenAt >= before);
});

// ---- applyMemoryUpdate: per-user seenAt (timing) -----------------------------

test('applyMemoryUpdate: timing.seenAtByUser dates a user\'s interest by their own message, not the wall clock', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const oldTs = Date.UTC(2020, 0, 1);
    const timing = { seenAtByUser: new Map([['1', oldTs]]), seenAt: oldTs };
    const update = { users: { 1: { interests: { add: [{ topic: 'Chess', note: '' }] } } } };
    const result = applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), undefined, undefined, undefined, timing);

    assert.equal(result.users, 1);
    const profile = store.getUser(guildId, '1');
    assert.equal(profile.interests[0].firstSeen, new Date(oldTs).toISOString());
    assert.equal(profile.interests[0].lastSeen, new Date(oldTs).toISOString());
  });
});

test('applyMemoryUpdate: without timing, seenAt falls back to relationships.now/episodes.now/the wall clock, unchanged from before', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'nick', Date.now());

    const update = { users: { 1: { interests: { add: [{ topic: 'Chess', note: '' }] } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), RELATIONSHIPS_CFG);

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.interests[0].firstSeen, new Date(RELATIONSHIPS_CFG.now).toISOString());
  });
});

// ---- analyze: dates interests/details by the message, not the wall clock ----
// analyze() accepts a batch of any age (a caller replaying old history feeds
// it through this exact same path) -- proving this here proves old messages
// get old dates too, without needing to script a full channel fetch.

test('analyze: dates a new interest/detail by the message\'s own (old) timestamp, not the wall clock "now"', async () => {
  await withStoreAsync(async (store) => {
    const guildId = 'g1';
    const hot = { config: makeConfig({ memory: { ...makeConfig().memory, confirmGapHours: 12 } }), prompts: { memory: 'sys', labels } };
    const calibrator = createCalibrator();
    const llm = {
      complete: async () => ({
        text: JSON.stringify({
          users: { 1: { interests: { add: [{ topic: 'Chess', note: '' }] }, details: { add: ['Owns a cat'] } } },
        }),
      }),
    };
    // The wall clock this run happens to execute at is far in the future of the history being replayed.
    const wallClockNow = Date.UTC(2026, 8, 21);
    const updater = createMemoryUpdater({ hot, store, llm, calibrator, getSelfName: () => 'Nept', now: () => wallClockNow });

    const oldTs = Date.UTC(2020, 0, 1, 12, 0, 0); // years-old history, as a replayed batch would feed it
    const messages = [slimMessage({ id: 'old1', authorId: '1', authorName: 'nick', content: 'i love chess', ts: oldTs })];

    const outcome = await updater.analyze(guildId, messages);
    assert.equal(outcome.ok, true);

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.interests[0].firstSeen, new Date(oldTs).toISOString(), 'dated by the message, not wallClockNow');
    assert.equal(profile.interests[0].lastSeen, new Date(oldTs).toISOString());
    assert.equal(profile.details[0].firstSeen, new Date(oldTs).toISOString());
    assert.notEqual(profile.interests[0].firstSeen, new Date(wallClockNow).toISOString());
  });
});

// ---- buildMemoryRequest: {{interestTopicChars}} / {{interestNoteChars}} -----
// Addendum: two more analyzer prompt placeholders, filled the same way as the
// other memory.* limits (see memoryTemplateValues/MEMORY_LIMIT_DEFAULTS).

test('buildMemoryRequest: fills {{interestTopicChars}} and {{interestNoteChars}} from config.memory', () => {
  const config = makeConfig({ memory: { ...makeConfig().memory, interestTopicChars: 25, interestNoteChars: 90 } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: '{{interestTopicChars}} {{interestNoteChars}}', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, '25 90');
});

test('buildMemoryRequest: {{interestTopicChars}}/{{interestNoteChars}} fall back to the config.json defaults (40/120) when unset', () => {
  const config = makeConfig({ memory: {} });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: '{{interestTopicChars}} {{interestNoteChars}}', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  assert.equal(llmMessages[0].content, '40 120');
});

// ---- applyMemoryUpdate: id tokens on the way IN ---------------------------------
// See docs/prompt-contract.md, "Members are referred to by id, never
// by nickname" -- a `Name (id:123...)` the model writes in a free-text field
// becomes `<@id>` when the id is known (an author of the batch, or an
// existing stored profile); an unknown id is left exactly as written.

test('applyMemoryUpdate: character/style/relationship "Name (id:...)" becomes a token for a known id', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = {
      users: {
        1: {
          character: 'gets along with Bran (id:223456789012345678)',
          style: 'quotes Bran (id:223456789012345678) a lot',
          relationship: 'trusts Bran (id:223456789012345678)',
        },
      },
    };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    const profile = store.getUser(guildId, '1');
    assert.equal(profile.character, 'gets along with <@223456789012345678>');
    assert.equal(profile.style, 'quotes <@223456789012345678> a lot');
    assert.equal(profile.relationship, 'trusts <@223456789012345678>');
  });
});

test('applyMemoryUpdate: an unknown id in "Name (id:...)" is left exactly as written', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());

    const update = { users: { 1: { character: 'mentions Ghost (id:99999999999999999)' } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    assert.equal(store.getUser(guildId, '1').character, 'mentions Ghost (id:99999999999999999)');
  });
});

test('applyMemoryUpdate: an interest note "Name (id:...)" is tokenized, the topic is not touched', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = { users: { 1: { interests: { add: [{ topic: 'Chess', note: 'plays with Bran (id:223456789012345678)' }] } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']));

    const [item] = store.getUser(guildId, '1').interests;
    assert.equal(item.topic, 'Chess');
    assert.equal(item.note, 'plays with <@223456789012345678>');
  });
});

test('applyMemoryUpdate: a detail text "Name (id:...)" is tokenized (both a bare-string and an object add item)', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { details: { add: ['a gift from Bran (id:223456789012345678)'] } } } },
      MEMORY_CFG,
      new Set(['1']),
    );
    assert.equal(store.getUser(guildId, '1').details[0].text, 'a gift from <@223456789012345678>');

    applyMemoryUpdate(
      store,
      guildId,
      { users: { 1: { details: { add: [{ text: 'borrowed from Bran (id:223456789012345678) too' }] } } } },
      MEMORY_CFG,
      new Set(['1']),
    );
    const texts = store.getUser(guildId, '1').details.map((d) => d.text);
    assert.ok(texts.includes('borrowed from <@223456789012345678> too'));
  });
});

test('applyMemoryUpdate: episode what/feeling are tokenized, quote is left verbatim', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = {
      users: {
        1: {
          episodes: [
            {
              date: '2026-01-01',
              what: 'argued with Bran (id:223456789012345678)',
              quote: 'Bran (id:223456789012345678) is wrong',
              feeling: 'annoyed at Bran (id:223456789012345678)',
              weight: 3,
            },
          ],
        },
      },
    };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), undefined, EPISODES_CFG);

    const [episode] = store.getUser(guildId, '1').episodes;
    assert.equal(episode.what, 'argued with <@223456789012345678>');
    assert.equal(episode.feeling, 'annoyed at <@223456789012345678>');
    assert.equal(episode.quote, 'Bran (id:223456789012345678) is wrong', 'quote is verbatim, never tokenized');
  });
});

test('applyMemoryUpdate: an affinity reason "Name (id:...)" is tokenized', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = { users: { 1: { affinity: { delta: 5, reason: 'stood up for Bran (id:223456789012345678)' } } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(['1']), new Set(), RELATIONSHIPS_CFG);

    assert.equal(store.getUser(guildId, '1').affinity.reason, 'stood up for <@223456789012345678>');
  });
});

test('applyMemoryUpdate: guild patterns/starters/injokes are tokenized', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = {
      guild: {
        patterns: 'people quote Bran (id:223456789012345678) constantly',
        starters: 'usually Bran (id:223456789012345678) starts it',
        injokes: ['"Bran (id:223456789012345678) did it again"'],
      },
    };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set());

    const guild = store.getGuild(guildId);
    assert.equal(guild.patterns, 'people quote <@223456789012345678> constantly');
    assert.equal(guild.starters, 'usually <@223456789012345678> starts it');
    assert.equal(guild.injokes[0], '"<@223456789012345678> did it again"');
  });
});

test('applyMemoryUpdate: channel purpose/topics/tone are tokenized', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = { channels: { c1: { purpose: 'Bran (id:223456789012345678) posts art here', topics: 'art by Bran (id:223456789012345678)', tone: 'calm, thanks to Bran (id:223456789012345678)' } } };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(), new Set(['c1']));

    const channel = store.getChannel(guildId, 'c1');
    assert.equal(channel.purpose, '<@223456789012345678> posts art here');
    assert.equal(channel.topics, 'art by <@223456789012345678>');
    assert.equal(channel.tone, 'calm, thanks to <@223456789012345678>');
  });
});

test('applyMemoryUpdate: lore text is tokenized, title and keys are never touched', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    const update = {
      lore: [{ title: 'The Bran (id:223456789012345678) Incident', keys: ['bran (id:223456789012345678)'], text: 'Bran (id:223456789012345678) broke the server once' }],
    };
    applyMemoryUpdate(store, guildId, update, MEMORY_CFG, new Set(), new Set(), undefined, undefined, LORE_CFG);

    const [entry] = store.getLore(guildId);
    assert.equal(entry.title, 'The Bran (id:223456789012345678) Incident', 'title is the identity, never tokenized');
    assert.deepEqual(entry.keys, ['bran (id:223456789012345678)'], 'keys are what people literally type, never tokenized');
    assert.equal(entry.text, '<@223456789012345678> broke the server once');
  });
});

test('applyMemoryUpdate: self facts are tokenized', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '223456789012345678', 'Bran', Date.now());

    applyMemoryUpdate(store, guildId, { self: ['once argued with Bran (id:223456789012345678)'] }, MEMORY_CFG, new Set());
    assert.equal(store.getGuild(guildId).self[0], 'once argued with <@223456789012345678>');
  });
});

// ---- applyMemoryUpdate: aliases -------------------------------------------------

test('applyMemoryUpdate: routes users.<id>.aliases {add, remove} through store.applyProfileOps', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());

    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { add: ['Ari'] } } } }, MEMORY_CFG, new Set(['1']));
    let profile = store.getUser(guildId, '1');
    assert.deepEqual(profile.aliases.map((a) => a.name), ['Ari']);

    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { remove: ['Ari'] } } } }, MEMORY_CFG, new Set(['1']));
    profile = store.getUser(guildId, '1');
    assert.deepEqual(profile.aliases, []);
  });
});

test('applyMemoryUpdate: an alias equal to the member\'s own display name is never stored', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());

    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { add: ['aria'] } } } }, MEMORY_CFG, new Set(['1']));
    assert.deepEqual(store.getUser(guildId, '1').aliases, []);
  });
});

test('applyMemoryUpdate: threads maxAliases/maxAliasesStored/aliasHalfLifeDays into store.applyProfileOps', () => {
  withStore((store) => {
    const guildId = 'g1';
    store.touchUser(guildId, '1', 'Aria', Date.now());
    const cfg = { ...MEMORY_CFG, maxAliases: 1, maxAliasesStored: 1 };

    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { add: ['Ari'] } } } }, cfg, new Set(['1']));
    applyMemoryUpdate(store, guildId, { users: { 1: { aliases: { add: ['Ary'] } } } }, cfg, new Set(['1']));

    assert.equal(store.getUser(guildId, '1').aliases.length, 1, 'the storage cap (1) was applied');
  });
});

// ---- buildMemoryRequest: id tokens resolved on the way OUT (analyzer mode) ------

function baseNameOf(names) {
  return (id) => names[id] ?? null;
}

test('buildMemoryRequest: existing_profiles character/style/relationship resolve <@id> to "name (id:...)"', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['Aria'],
        character: 'gets along with <@223456789012345678>',
        style: 'quotes <@223456789012345678> a lot',
        relationship: 'trusts <@223456789012345678>',
        interests: [],
        details: [],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
    nameOf: baseNameOf({ '223456789012345678': 'Bran' }),
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.equal(profiles['1'].character, 'gets along with Bran (id:223456789012345678)');
  assert.equal(profiles['1'].style, 'quotes Bran (id:223456789012345678) a lot');
  assert.equal(profiles['1'].relationship, 'trusts Bran (id:223456789012345678)');
});

test('buildMemoryRequest: an id nameOf cannot resolve is left as the bare token', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['Aria'], character: 'knows <@223456789012345678>', interests: [], details: [] } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
    nameOf: () => null,
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.equal(profiles['1'].character, 'knows <@223456789012345678>');
});

test('buildMemoryRequest: a member renamed between write and read shows the NEW name in existing_profiles', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const requestFor = (name) =>
    buildMemoryRequest({
      prompts: { memory: 'x', labels },
      config,
      calibrator,
      profiles: { 1: { names: ['Aria'], character: 'knows <@223456789012345678>', interests: [], details: [] } },
      guildMemory: {},
      messages,
      selfName: 'Nept',
      nameOf: baseNameOf({ '223456789012345678': name }),
    });

  const before = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(requestFor('OldName').messages[1].content)[1]);
  assert.equal(before['1'].character, 'knows OldName (id:223456789012345678)');

  const after = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(requestFor('NewName').messages[1].content)[1]);
  assert.equal(after['1'].character, 'knows NewName (id:223456789012345678)');
});

test('buildMemoryRequest: existing_profiles interest note / detail text resolve <@id> tokens', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['Aria'],
        interests: [{ topic: 'Chess', note: 'plays with <@223456789012345678>', weight: 2, firstSeen: 'a', lastSeen: 'a' }],
        details: [{ id: 1, text: 'gift from <@223456789012345678>', weight: 1, firstSeen: 'a', lastSeen: 'a' }],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
    nameOf: baseNameOf({ '223456789012345678': 'Bran' }),
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.equal(profiles['1'].interests[0].note, 'plays with Bran (id:223456789012345678)');
  assert.equal(profiles['1'].details[0].text, 'gift from Bran (id:223456789012345678)');
});

test('buildMemoryRequest: existing_profiles episode "what" resolves <@id> tokens, affinity reason too', () => {
  const config = makeConfig({ features: { relationships: true, episodes: true } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['Aria'],
        interests: [],
        details: [],
        affinity: { score: 5, reason: 'stood up for <@223456789012345678>' },
        episodes: [{ date: '2026-01-01', what: 'argued with <@223456789012345678>', quote: 'q', weight: 3 }],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
    nameOf: baseNameOf({ '223456789012345678': 'Bran' }),
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.equal(profiles['1'].affinity.reason, 'stood up for Bran (id:223456789012345678)');
  assert.equal(profiles['1'].episodes[0].what, 'argued with Bran (id:223456789012345678)');
});

test('buildMemoryRequest: existing_guild/existing_channels/existing_lore resolve <@id> tokens, lore titles/keys untouched', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0), content: 'bran incident' })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: {},
    guildMemory: { patterns: 'people quote <@223456789012345678>', starters: '<@223456789012345678> usually starts it', injokes: ['<@223456789012345678> did it again'], self: ['met <@223456789012345678> once'] },
    channels: { c1: { name: 'general', purpose: '<@223456789012345678> posts here', topics: 'stuff by <@223456789012345678>', tone: 'chill, <@223456789012345678> keeps it light' } },
    loreEntries: [{ id: 'l1', title: 'bran incident', keys: ['bran incident'], text: '<@223456789012345678> broke the server', updatedAt: 'x' }],
    messages,
    selfName: 'Nept',
    nameOf: baseNameOf({ '223456789012345678': 'Bran' }),
  });

  const user = llmMessages[1].content;
  const guildJson = JSON.parse(/<existing_guild>\n([\s\S]*?)\n<\/existing_guild>/.exec(user)[1]);
  assert.equal(guildJson.patterns, 'people quote Bran (id:223456789012345678)');
  assert.equal(guildJson.starters, 'Bran (id:223456789012345678) usually starts it');
  assert.equal(guildJson.injokes[0], 'Bran (id:223456789012345678) did it again');
  assert.equal(guildJson.self[0], 'met Bran (id:223456789012345678) once');

  const channelsJson = JSON.parse(/<existing_channels>\n([\s\S]*?)\n<\/existing_channels>/.exec(user)[1]);
  assert.equal(channelsJson.c1.purpose, 'Bran (id:223456789012345678) posts here');
  assert.equal(channelsJson.c1.topics, 'stuff by Bran (id:223456789012345678)');
  assert.equal(channelsJson.c1.tone, 'chill, Bran (id:223456789012345678) keeps it light');

  const loreJson = JSON.parse(/<existing_lore>\n([\s\S]*?)\n<\/existing_lore>/.exec(user)[1]);
  assert.equal(loreJson.matched[0].text, 'Bran (id:223456789012345678) broke the server');
  assert.equal(loreJson.matched[0].title, 'bran incident', 'title is never tokenized');
  assert.deepEqual(loreJson.matched[0].keys, ['bran incident'], 'keys are never tokenized');
});

test('buildMemoryRequest: existing_profiles shows aliases as a plain top-ranked list', () => {
  const config = makeConfig({ memory: { maxAliases: 1 } });
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: {
      1: {
        names: ['Aria'],
        interests: [],
        details: [],
        aliases: [
          { name: 'Ar', weight: 5, firstSeen: 'a', lastSeen: '2026-01-01T00:00:00.000Z' },
          { name: 'Ari', weight: 1, firstSeen: 'a', lastSeen: '2020-01-01T00:00:00.000Z' },
        ],
      },
    },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.deepEqual(profiles['1'].aliases, ['Ar'], 'only the top maxAliases (1) by rank');
});

test('buildMemoryRequest: no aliases field in existing_profiles when the profile has none', () => {
  const config = makeConfig();
  const calibrator = createCalibrator();
  const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];

  const { messages: llmMessages } = buildMemoryRequest({
    prompts: { memory: 'x', labels },
    config,
    calibrator,
    profiles: { 1: { names: ['Aria'], interests: [], details: [] } },
    guildMemory: {},
    messages,
    selfName: 'Nept',
  });

  const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
  assert.ok(!('aliases' in profiles['1']));
});

// ---- toTokens name-aware round trip through the real pipeline ------------------
// Reproduces the reported defect: a multi-word display name in the model's
// "Name (id:...)" fallback form must round-trip through
// applyMemoryUpdate -> buildMemoryRequest's analyzer view -> the model
// echoing that exact form back -> applyMemoryUpdate again, without growing
// or duplicating the name across several cycles.

test('applyMemoryUpdate + buildMemoryRequest: a multi-word display name round-trips stably across several analyzer cycles', () => {
  withStore((store) => {
    const guildId = 'g1';
    const authorId = '1';
    const otherId = '223456789012345678'; // "Al Sus"
    store.touchUser(guildId, authorId, 'Aria', Date.now());
    store.touchUser(guildId, otherId, 'Al Sus', Date.now());

    const batchAuthorNames = new Map([[otherId, 'Al Sus']]);
    const knownUserIds = new Set([authorId]);

    // Round 1: the model writes the fallback "Name (id:...)" form directly.
    applyMemoryUpdate(
      store,
      guildId,
      { users: { [authorId]: { character: `Al Sus (id:${otherId}) plays it` } } },
      MEMORY_CFG,
      knownUserIds,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      batchAuthorNames,
    );
    assert.equal(store.getUser(guildId, authorId).character, `<@${otherId}> plays it`);

    const config = makeConfig();
    const calibrator = createCalibrator();
    const messages = [slimMessage({ id: 'm1', ts: Date.UTC(2026, 0, 1, 12, 0, 0) })];
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;

    function analyzerView() {
      const { messages: llmMessages } = buildMemoryRequest({
        prompts: { memory: 'x', labels },
        config,
        calibrator,
        profiles: { [authorId]: store.getUser(guildId, authorId) },
        guildMemory: {},
        messages,
        selfName: 'Nept',
        nameOf,
      });
      const profiles = JSON.parse(/<existing_profiles>\n([\s\S]*?)\n<\/existing_profiles>/.exec(llmMessages[1].content)[1]);
      return profiles[authorId].character;
    }

    const view1 = analyzerView();
    assert.equal(view1, `Al Sus (id:${otherId}) plays it`, 'the analyzer sees the full two-word name back, not "Al <@id> plays it"');

    // Round 2: the model echoes back EXACTLY what it was shown.
    applyMemoryUpdate(
      store,
      guildId,
      { users: { [authorId]: { character: view1 } } },
      MEMORY_CFG,
      knownUserIds,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      batchAuthorNames,
    );
    assert.equal(store.getUser(guildId, authorId).character, `<@${otherId}> plays it`, 'no growth, no duplication after round 2');

    const view2 = analyzerView();
    assert.equal(view2, view1, 'the analyzer view is stable across cycles');

    // Round 3, for good measure.
    applyMemoryUpdate(
      store,
      guildId,
      { users: { [authorId]: { character: view2 } } },
      MEMORY_CFG,
      knownUserIds,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      batchAuthorNames,
    );
    assert.equal(store.getUser(guildId, authorId).character, `<@${otherId}> plays it`, 'still stable after round 3');
    assert.equal(analyzerView(), view1);
  });
});

test('applyMemoryUpdate: namesOf recognises a batch author\'s current nick even before their stored profile has caught up', () => {
  withStore((store) => {
    const guildId = 'g1';
    const authorId = '1';
    const otherId = '223456789012345678';
    store.touchUser(guildId, authorId, 'Aria', Date.now());
    // The referenced member exists (known id) but their STORED name is still
    // the old one -- only the batch transcript saw the new nick.
    store.touchUser(guildId, otherId, 'OldNick', Date.now());

    const batchAuthorNames = new Map([[otherId, 'Al Sus']]);
    applyMemoryUpdate(
      store,
      guildId,
      { users: { [authorId]: { character: `Al Sus (id:${otherId}) plays it` } } },
      MEMORY_CFG,
      new Set([authorId]),
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      batchAuthorNames,
    );

    assert.equal(store.getUser(guildId, authorId).character, `<@${otherId}> plays it`, 'the batch nick, not just the stale stored name, is recognised');
  });
});

test('batchAuthorNamesMap: the author\'s latest message in the batch wins when their nick changed mid-batch', () => {
  const messages = [
    slimMessage({ id: 'm1', authorId: '1', authorName: 'OldNick', ts: 1000 }),
    slimMessage({ id: 'm2', authorId: '1', authorName: 'NewNick', ts: 2000 }),
    slimMessage({ id: 'm3', authorId: '2', authorName: 'Other', self: true, ts: 3000 }),
  ];
  const names = batchAuthorNamesMap(messages);
  assert.equal(names.get('1'), 'NewNick');
  assert.ok(!names.has('2'), 'the persona\'s own line never contributes a name');
});
