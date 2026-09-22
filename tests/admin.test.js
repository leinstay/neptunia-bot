import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  listRules,
  appendRule,
  removeRule,
  setPath,
  unsetPath,
  createAdmin,
  buildProfileSummary,
} from '../src/admin.js';
import { emptyAffinity, applyDelta } from '../src/memory/affinity.js';
import { upsertLore } from '../src/memory/lore.js';
import { createStore } from '../src/memory/store.js';
import { createMemoryUpdater } from '../src/memory/update.js';
import { createSpontaneous } from '../src/behavior/spontaneous.js';
import { labels } from './fixtures/labels.js';

// ---------------------------------------------------------------------------
// listRules / appendRule / removeRule
// ---------------------------------------------------------------------------

test('listRules: reads the bullets under an English ## heading', () => {
  const text = '# Rules file\n\nSome intro.\n\n## Rules\n\n- Rule one\n- Rule two\n';
  assert.deepEqual(listRules(text), ['Rule one', 'Rule two']);
});

test('listRules: reads the bullets under a non-Latin ## heading', () => {
  const text = '# Rules file\n\nSome intro.\n\n## Κανόνες\n\n- Rule one\n- Rule two\n';
  assert.deepEqual(listRules(text), ['Rule one', 'Rule two']);
});

test('listRules: stops at the next heading (any level) so unrelated bullets are excluded', () => {
  const text = '## Rules\n\n- Rule one\n\n### Other section\n\n- not a rule\n';
  assert.deepEqual(listRules(text), ['Rule one']);
});

test('listRules: with two ## headings, only the bullets under the last one count', () => {
  const text = '## Old section\n\n- not a rule\n\n## Rules\n\n- Rule one\n- Rule two\n';
  assert.deepEqual(listRules(text), ['Rule one', 'Rule two']);
});

test('listRules: falls back to every top-level bullet when there is no ## heading', () => {
  const text = 'Intro\n- first\n- second\n';
  assert.deepEqual(listRules(text), ['first', 'second']);
});

test('listRules: an empty or heading-only file has no rules', () => {
  assert.deepEqual(listRules(''), []);
  assert.deepEqual(listRules('## Rules\n'), []);
});

test('appendRule: appends the bullet as the last line', () => {
  const text = '## Rules\n\n- existing\n';
  assert.equal(appendRule(text, 'new one'), '## Rules\n\n- existing\n- new one\n');
});

test('appendRule: collapses newlines inside the rule into single spaces', () => {
  const result = appendRule('## Rules\n', 'first line\nsecond line');
  assert.equal(listRules(result).at(-1), 'first line second line');
});

test('appendRule: creates a ## heading when the file has none at all', () => {
  const result = appendRule('Some preamble.', 'be nice');
  assert.match(result, /^## /m);
  assert.deepEqual(listRules(result), ['be nice']);
});

test('appendRule: normalizes trailing whitespace to exactly one final newline', () => {
  const result = appendRule('## Rules\n\n\n\n', 'one rule');
  assert.equal(result, '## Rules\n- one rule\n');
  assert.ok(result.endsWith('\n') && !result.endsWith('\n\n'));
});

test('appendRule: keeps non-Latin rule text intact and the file ends with the bullet list', () => {
  const result = appendRule('## Κανόνες\n\n- παλιός κανόνας\n', 'ποτέ μην μιλάς αγγλικά');
  assert.equal(result, '## Κανόνες\n\n- παλιός κανόνας\n- ποτέ μην μιλάς αγγλικά\n');
  assert.deepEqual(listRules(result), ['παλιός κανόνας', 'ποτέ μην μιλάς αγγλικά']);
});

test('appendRule: appends under the last of two ## headings', () => {
  const result = appendRule('## Old\n\n- stale\n\n## Rules\n\n- existing\n', 'new one');
  assert.equal(result, '## Old\n\n- stale\n\n## Rules\n\n- existing\n- new one\n');
  assert.deepEqual(listRules(result), ['existing', 'new one']);
});

test('removeRule: removes the nth bullet in listRules order and reports it', () => {
  const text = '## Rules\n\n- one\n- two\n- three\n';
  const result = removeRule(text, 2);
  assert.equal(result.removed, 'two');
  assert.deepEqual(listRules(result.text), ['one', 'three']);
});

test('removeRule: returns null for n out of range', () => {
  const text = '## Rules\n\n- only one\n';
  assert.equal(removeRule(text, 0), null);
  assert.equal(removeRule(text, 2), null);
});

// ---------------------------------------------------------------------------
// setPath / unsetPath
// ---------------------------------------------------------------------------

test('setPath: sets a nested value, creating intermediate objects', () => {
  const result = setPath({}, 'spontaneous.minIntervalMinutes', 10);
  assert.deepEqual(result, { spontaneous: { minIntervalMinutes: 10 } });
});

test('setPath: overwrites an existing value without touching its siblings', () => {
  const result = setPath({ a: { b: 1, c: 2 } }, 'a.b', 99);
  assert.deepEqual(result, { a: { b: 99, c: 2 } });
});

test('setPath: does not mutate its input object', () => {
  const input = { a: { b: 1 } };
  const snapshot = JSON.parse(JSON.stringify(input));
  setPath(input, 'a.c', 2);
  assert.deepEqual(input, snapshot);
});

test('setPath: rejects paths containing __proto__, constructor or prototype', () => {
  assert.throws(() => setPath({}, 'a.__proto__.polluted', 1));
  assert.throws(() => setPath({}, 'constructor.prototype.polluted', 1));
  assert.throws(() => setPath({}, 'a.prototype.b', 1));
});

test('unsetPath: removes a key and prunes an emptied parent object', () => {
  const result = unsetPath({ a: { b: 1 } }, 'a.b');
  assert.deepEqual(result, {});
});

test('unsetPath: removes a key but keeps siblings on the parent', () => {
  const result = unsetPath({ a: { b: 1, c: 2 } }, 'a.b');
  assert.deepEqual(result, { a: { c: 2 } });
});

test('unsetPath: does not mutate its input and is a no-op for a missing path', () => {
  const input = { a: { b: 1 } };
  const result = unsetPath(input, 'a.x.y');
  assert.deepEqual(input, { a: { b: 1 } });
  assert.deepEqual(result, { a: { b: 1 } });
});

test('unsetPath: rejects prototype-pollution paths', () => {
  assert.throws(() => unsetPath({}, '__proto__.polluted'));
});

// ---------------------------------------------------------------------------
// buildProfileSummary (F32, pure)
// ---------------------------------------------------------------------------

test('buildProfileSummary: a minimal profile renders the expected fields', () => {
  const profile = { id: '123', names: ['Bob'], messageCount: 3 };
  const text = buildProfileSummary(profile, {});
  assert.ok(text.includes('name: Bob'));
  assert.ok(text.includes('former names: none'));
  assert.ok(text.includes('aliases: none'));
  assert.ok(text.includes('messages: 3'));
  assert.ok(text.includes('character: (empty)'));
});

test('buildProfileSummary: never exceeds 2000 chars, even for a huge profile, and points to the full sections', () => {
  const profile = {
    id: '123',
    names: Array.from({ length: 10 }, (_, i) => `VeryLongDisplayNameNumber${i}`),
    messageCount: 999999,
    firstSeen: '2020-01-01T00:00:00.000Z',
    lastSeen: '2026-09-20T00:00:00.000Z',
    affinity: { score: 99, reason: 'x'.repeat(500) },
    character: 'c'.repeat(5000),
    style: 's'.repeat(5000),
    relationship: 'r'.repeat(5000),
    interests: Array.from({ length: 40 }, (_, i) => ({ topic: `Topic number ${i} is quite long`, weight: i })),
    details: Array.from({ length: 40 }, (_, i) => ({ id: i, text: 'd'.repeat(200), weight: i })),
    episodes: Array.from({ length: 20 }, () => ({})),
    aliases: Array.from({ length: 15 }, (_, i) => ({ name: `AliasNumber${i}longenough`, weight: i })),
  };

  const text = buildProfileSummary(profile, {});

  assert.ok(text.length <= 2000, `expected <= 2000 chars, got ${text.length}`);
  assert.ok(text.includes('(full text: section character)'));
  assert.ok(text.includes('(full text: section style)'));
  assert.ok(text.includes('(full text: section relationship)'));
  assert.ok(text.includes('(full text: section aliases)'));
  assert.ok(text.includes('interests: 40 stored'), 'the top-5 interest topics stay short by construction, so this is not truncated');
});

test('buildProfileSummary: resolves <@id> tokens in free-text fields via nameOf', () => {
  const otherId = '999999999999999999';
  const profile = { id: '123', names: ['Bob'], character: `trusts <@${otherId}>` };
  const nameOf = (id) => (id === otherId ? 'Zoe' : null);

  const text = buildProfileSummary(profile, {}, nameOf);
  assert.ok(text.includes(`character: trusts Zoe (id:${otherId})`));
});

// ---------------------------------------------------------------------------
// createAdmin().run — fakes on a temp dir
// ---------------------------------------------------------------------------

function makeRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-'));
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  fs.writeFileSync(path.join(rootDir, 'prompts', 'rules.md'), '## Rules\n\n- be kind\n');
  return rootDir;
}

function makeHot(rootDir) {
  return {
    config: {
      bot: { owners: ['42'] },
      llm: { model: 'anthropic/claude-opus-4.6', maxRequestsPerDay: 300 },
    },
    prompts: { persona: 'who she is', labels: { locale: 'en-US' } },
    promptSources: { persona: 'base', labels: 'base' },
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfigCalls: 0,
    reloadPromptsCalls: 0,
    reloadConfig() {
      this.reloadConfigCalls += 1;
      return true;
    },
    reloadPrompts() {
      this.reloadPromptsCalls += 1;
      return true;
    },
  };
}

function makeStore() {
  const profiles = new Map();
  const forgotten = [];
  const lore = new Map(); // guildId -> entries[]
  const channels = new Map(); // `${guildId}:${channelId}` -> channel entry
  const guilds = new Map(); // guildId -> guild notes
  const store = {
    profiles,
    forgotten,
    lore,
    channels,
    guilds,
    getChannel(guildId, channelId) {
      return channels.get(`${guildId}:${channelId}`) ?? null;
    },
    listChannels(guildId) {
      const prefix = `${guildId}:`;
      return [...channels.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    },
    getGuild(guildId) {
      return guilds.get(guildId) ?? { patterns: '', starters: '', injokes: [], self: [], updatedAt: null };
    },
    state: { data: { llmCount: 5, llmDay: '2026-09-20' }, markDirty() {} },
    flushCalls: 0,
    flush() {
      this.flushCalls += 1;
    },
    dropCachesCalls: 0,
    dropCaches() {
      this.dropCachesCalls += 1;
      return 0;
    },
    reloadStateCalls: 0,
    reloadState() {
      this.reloadStateCalls += 1;
    },
    validateResult: [],
    validate() {
      return this.validateResult;
    },
    getUser(guildId, userId) {
      return profiles.get(`${guildId}:${userId}`) ?? null;
    },
    getLore(guildId) {
      return lore.get(guildId) ?? [];
    },
    setLore(guildId, incoming, opts) {
      const { entries, upserted } = upsertLore(lore.get(guildId) ?? [], incoming, opts);
      lore.set(guildId, entries);
      return upserted;
    },
    removeLore(guildId, id) {
      const current = lore.get(guildId) ?? [];
      const next = current.filter((e) => e.id !== id);
      lore.set(guildId, next);
      return next.length !== current.length;
    },
    adjustAffinity(guildId, userId, delta, reason, opts) {
      const key = `${guildId}:${userId}`;
      const profile = profiles.get(key) ?? { id: String(userId), affinity: emptyAffinity() };
      profile.affinity = applyDelta(profile.affinity ?? emptyAffinity(), delta, reason, opts);
      profiles.set(key, profile);
      return profile.affinity;
    },
    forgetUser(guildId, userId) {
      forgotten.push([String(guildId), String(userId)]);
      profiles.delete(`${guildId}:${userId}`);
    },
    countUsers() {
      return profiles.size;
    },
    getBuffer() {
      return [];
    },
    listGuilds() {
      return [];
    },
    wipeCalls: [],
    wipeGuild(guildId, opts) {
      this.wipeCalls.push([String(guildId), opts]);
      return { users: 2, channels: 1, loreRemoved: 3, loreKept: 1, bufferMessages: 5 };
    },
  };
  return store;
}

function makeAdmin(rootDir, extra = {}) {
  const hot = extra.hot ?? makeHot(rootDir);
  const store = extra.store ?? makeStore();
  const admin = createAdmin({
    hot,
    store,
    client: extra.client ?? {},
    spontaneous: extra.spontaneous ?? {},
    calibrator: extra.calibrator ?? { ratio: 1 },
    getGuildId: extra.getGuildId ?? (() => 'g1'),
    isBootstrapping: extra.isBootstrapping,
    turns: extra.turns,
    memory: extra.memory,
    pending: extra.pending,
    llm: extra.llm,
    bootstrap: extra.bootstrap,
  });
  return { admin, hot, store };
}

function readLocal(rootDir) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8'));
}

function hasLocal(rootDir) {
  return fs.existsSync(path.join(rootDir, 'config.local.json'));
}

// ---------------------------------------------------------------------------
// isOwner
// ---------------------------------------------------------------------------

test('isOwner: true for a listed owner id, false otherwise', () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  assert.equal(admin.isOwner('42'), true);
  assert.equal(admin.isOwner('999'), false);
});

// ---------------------------------------------------------------------------
// run: unknown command
// ---------------------------------------------------------------------------

test('run: throws on an unknown command key', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('nonsense', {}, {}), /unknown command/);
});

// ---------------------------------------------------------------------------
// rule.add / rule.list / rule.remove
// ---------------------------------------------------------------------------

test('run: rule.add seeds prompts.local/rules.md from the base file, leaving prompts/rules.md untouched', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);

  const baseBefore = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'));
  const result = await admin.run('rule.add', { text: 'Never spoil the ending' }, { guildId: 'g1' });

  const localFile = path.join(rootDir, 'prompts.local', 'rules.md');
  assert.ok(fs.existsSync(localFile));
  const rulesText = fs.readFileSync(localFile, 'utf8');
  assert.deepEqual(listRules(rulesText), ['be kind', 'Never spoil the ending']);
  // the tracked base file is byte-identical to before
  assert.deepEqual(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md')), baseBefore);
  assert.equal(hot.reloadPromptsCalls, 1);
  assert.ok(result.includes('Rule added'));
});

test('run: rule.add creates the prompts.local directory when it does not exist yet', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  assert.equal(fs.existsSync(path.join(rootDir, 'prompts.local')), false);
  await admin.run('rule.add', { text: 'be nice' }, {});
  assert.ok(fs.statSync(path.join(rootDir, 'prompts.local')).isDirectory());
});

test('run: rule.add rejects empty text', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('rule.add', { text: '   ' }, {}));
});

test('run: rule.list lists the numbered rules; rule.remove removes one from the local layer, leaving the base file untouched', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  const baseBefore = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'));
  await admin.run('rule.add', { text: 'second rule' }, {});
  const listed = await admin.run('rule.list', {}, {});
  assert.ok(listed.includes('1. be kind'));
  assert.ok(listed.includes('2. second rule'));

  await admin.run('rule.remove', { number: 1 }, {});
  const rulesText = fs.readFileSync(path.join(rootDir, 'prompts.local', 'rules.md'), 'utf8');
  assert.deepEqual(listRules(rulesText), ['second rule']);
  assert.deepEqual(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md')), baseBefore);
});

test('run: rule.remove rejects an out-of-range number', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('rule.remove', { number: 5 }, {}), /no rule #5/);
});

test('run: rule.add seeds from an empty text when the base rules.md is missing', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-'));
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const { admin } = makeAdmin(rootDir);

  const result = await admin.run('rule.add', { text: 'only rule' }, {});

  const rulesText = fs.readFileSync(path.join(rootDir, 'prompts.local', 'rules.md'), 'utf8');
  assert.deepEqual(listRules(rulesText), ['only rule']);
  assert.ok(result.includes('Rule added'));
});

// ---------------------------------------------------------------------------
// set / unset
// ---------------------------------------------------------------------------

test('run: set writes an override to config.local.json and reloads config', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);

  const result = await admin.run('set', { path: 'llm.model', value: '"openrouter/test-model"' }, {});

  assert.deepEqual(readLocal(rootDir), { llm: { model: 'openrouter/test-model' } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok(result.includes('Set llm.model'));
});

test('run: set falls back to the raw string when the value is not valid JSON', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('set', { path: 'llm.model', value: 'plain-text-model' }, {});
  assert.deepEqual(readLocal(rootDir), { llm: { model: 'plain-text-model' } });
});

test('run: set rejects an unknown config path and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(
    () => admin.run('set', { path: 'llm.doesNotExist', value: '1' }, {}),
    /unknown config path/,
  );
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: unset removes a previously set override', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);

  await admin.run('set', { path: 'llm.model', value: '"temp-model"' }, {});
  await admin.run('unset', { path: 'llm.model' }, {});

  assert.deepEqual(readLocal(rootDir), {});
  assert.equal(hot.reloadConfigCalls, 2);
});

// ---------------------------------------------------------------------------
// model.show / model.set
// ---------------------------------------------------------------------------

function makeHotWithMedia(rootDir) {
  const hot = makeHot(rootDir);
  hot.config.memory = { model: null };
  hot.config.media = { model: 'anthropic/claude-haiku-4.5' };
  hot.config.features = { mediaDescriptions: false };
  return hot;
}

test('run: model.show reports talk/analyzer/media models and whether mediaDescriptions is on', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  const result = await admin.run('model.show', {}, {});

  assert.ok(result.includes('talk: anthropic/claude-opus-4.6'));
  assert.ok(result.includes('media: anthropic/claude-haiku-4.5'));
  assert.ok(result.includes('mediaDescriptions: off'));
});

test('run: model.show falls back to the talk model for the analyzer when memory.model is unset', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  const result = await admin.run('model.show', {}, {});
  assert.ok(result.includes('analyzer: anthropic/claude-opus-4.6'));
});

test('run: model.show reports memory.model when it is explicitly set, and mediaDescriptions on', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  hot.config.memory.model = 'openrouter/analyzer-model';
  hot.config.features.mediaDescriptions = true;
  const { admin } = makeAdmin(rootDir, { hot });

  const result = await admin.run('model.show', {}, {});
  assert.ok(result.includes('analyzer: openrouter/analyzer-model'));
  assert.ok(result.includes('mediaDescriptions: on'));
});

test('run: model.set writes the right config path for each role', async () => {
  const rootDir = makeRoot();
  const hot = makeHotWithMedia(rootDir);
  const { admin } = makeAdmin(rootDir, { hot });

  await admin.run('model.set', { role: 'talk', id: 'anthropic/claude-opus-4.6' }, {});
  assert.deepEqual(readLocal(rootDir), { llm: { model: 'anthropic/claude-opus-4.6' } });

  await admin.run('model.set', { role: 'analyzer', id: 'openrouter/cheap-model' }, {});
  await admin.run('model.set', { role: 'media', id: 'anthropic/claude-haiku-4.5' }, {});
  assert.deepEqual(readLocal(rootDir), {
    llm: { model: 'anthropic/claude-opus-4.6' },
    memory: { model: 'openrouter/cheap-model' },
    media: { model: 'anthropic/claude-haiku-4.5' },
  });
  assert.equal(hot.reloadConfigCalls, 3);
});

test('run: model.set rejects an unknown role and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await assert.rejects(() => admin.run('model.set', { role: 'bogus', id: 'x/y' }, {}), /unknown role/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: model.set rejects an id that does not look like a model id', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await assert.rejects(() => admin.run('model.set', { role: 'talk', id: 'x' }, {}), /model id/);
  await assert.rejects(() => admin.run('model.set', { role: 'talk', id: 'has spaces here' }, {}), /model id/);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
});

test('run: model.set accepts a loosely-valid id (letters, digits, dot, colon, slash, dash, underscore)', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: makeHotWithMedia(rootDir) });

  await admin.run('model.set', { role: 'media', id: 'anthropic/claude-haiku-4.5:beta' }, {});
  assert.deepEqual(readLocal(rootDir), { media: { model: 'anthropic/claude-haiku-4.5:beta' } });
});

// ---------------------------------------------------------------------------
// ping (F35): reach each role's model directly, in parallel
// ---------------------------------------------------------------------------

function fakeLlm(script) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      return script(options, calls.length - 1);
    },
  };
}

function hotForPing(rootDir, { label = true } = {}) {
  const hot = makeHotWithMedia(rootDir);
  hot.prompts = {
    ...hot.prompts,
    labels: { ...hot.prompts.labels, ...(label ? { ping: { prompt: 'Reply with one word: pong' } } : {}) },
  };
  return hot;
}

test('run: ping pings talk/analyzer/media in parallel and reports latency, provider and tokens', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.memory.model = 'openrouter/analyzer-model'; // distinct from talk, so every role gets its own call
  const llm = fakeLlm((options) => ({
    text: 'pong',
    usage: { prompt_tokens: 5, completion_tokens: 1 },
    estimated: 6,
    finishReason: 'stop',
    provider: `provider-for-${options.model}`,
  }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});
  const lines = body.split('\n');

  assert.equal(llm.calls.length, 3, 'talk, analyzer and media are three distinct models here');
  assert.ok(lines.some((l) => l.startsWith('talk: anthropic/claude-opus-4.6 — ok,') && l.includes('provider=provider-for-anthropic/claude-opus-4.6') && l.includes('tokens 5/1')));
  assert.ok(lines.some((l) => l.startsWith('analyzer: openrouter/analyzer-model — ok,')));
  assert.ok(lines.some((l) => l.startsWith('media: anthropic/claude-haiku-4.5 — ok,')));
});

test('run: ping calls llm.complete with the ping prompt, 16 max tokens, no daily cap and no calibration', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.llm.pingTimeoutMs = 12345;
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  await admin.run('ping', { role: 'talk' }, {});

  assert.equal(llm.calls.length, 1);
  const [{ messages, options }] = llm.calls;
  assert.deepEqual(messages, [{ role: 'user', content: 'Reply with one word: pong' }]);
  assert.equal(options.model, 'anthropic/claude-opus-4.6');
  assert.equal(options.maxOutputTokens, 16);
  assert.equal(options.countAgainstDailyCap, false);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.timeoutMs, 12345);
});

test('run: ping falls back to the default pingTimeoutMs when unset', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  await admin.run('ping', { role: 'talk' }, {});
  assert.equal(llm.calls[0].options.timeoutMs, 30000);
});

test('run: ping single-role form only pings that one role', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', { role: 'media' }, {});

  assert.equal(llm.calls.length, 1);
  assert.equal(body.split('\n').length, 1);
  assert.ok(body.startsWith('media: anthropic/claude-haiku-4.5 — ok,'));
});

test('run: ping de-duplicates identical models: one call, reported for every role that uses it', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  // memory.model is null in makeHotWithMedia -> analyzer falls back to the same model as talk.
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});
  const lines = body.split('\n');

  assert.equal(llm.calls.length, 2, 'talk+analyzer share one model, media is distinct: two calls');
  assert.equal(lines.length, 3, 'still one line per requested role');
  assert.ok(lines.some((l) => l.startsWith('talk: anthropic/claude-opus-4.6 — ok,')));
  assert.ok(lines.some((l) => l.startsWith('analyzer: anthropic/claude-opus-4.6 — ok,')));
});

// A real "wrong provider keys" 404 body captured from OpenRouter, verbatim -- see the
// module header's WHY. `error.metadata.routing_funnel` is the real location; `step` is the
// real step-name key; `endpoint_count` (snake_case) is the real count key.
const REAL_NO_ENDPOINTS_BODY =
  '{"error":{"message":"No endpoints found for anthropic/claude-opus-4.6.","code":404,"metadata":{"routing_funnel":[' +
  '{"step":"Initial Endpoints","endpoint_count":6},' +
  '{"step":"Filter by Regional Surcharge","endpoint_count":5},' +
  '{"step":"Filter by Allowed Providers","endpoint_count":2},' +
  '{"step":"Apply Manual Order","endpoint_count":2},' +
  '{"step":"Add BYOK Endpoints","endpoint_count":0}]}}}';

function throwHttpError(statusCode, bodyText) {
  const err = new Error(`OpenRouter HTTP ${statusCode}: ${bodyText}`);
  err.statusCode = statusCode;
  err.body = bodyText;
  throw err;
}

test('run: ping reports a role that returns an HTTP error with its status, a trimmed message and the real routing funnel shape', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  hot.config.memory.model = 'openrouter/analyzer-model';
  const llm = fakeLlm((options) => {
    if (options.model === 'anthropic/claude-opus-4.6') throwHttpError(404, REAL_NO_ENDPOINTS_BODY);
    return { text: 'pong', usage: {}, estimated: 1 };
  });
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});
  const lines = body.split('\n');

  const talkLine = lines.find((l) => l.startsWith('talk:'));
  assert.ok(talkLine.includes('FAIL'));
  assert.ok(talkLine.includes('404'));
  // The last step is also the first one that hit 0 here, so only one is shown.
  assert.ok(talkLine.includes('funnel: Add BYOK Endpoints -> 0 endpoints'));
  assert.ok(!talkLine.includes('first hit 0 at'));
  assert.ok(lines.some((l) => l.startsWith('analyzer: openrouter/analyzer-model — ok,')));
  assert.ok(lines.some((l) => l.startsWith('media: anthropic/claude-haiku-4.5 — ok,')));
});

test('run: ping shows both the last step and the first step that hit 0 endpoints, when they differ', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const bodyText = JSON.stringify({
    error: {
      message: 'No endpoints found.',
      code: 404,
      metadata: {
        routing_funnel: [
          { step: 'Initial Endpoints', endpoint_count: 6 },
          { step: 'Filter by Regional Surcharge', endpoint_count: 0 },
          { step: 'Filter by Allowed Providers', endpoint_count: 0 },
          { step: 'Add BYOK Endpoints', endpoint_count: 0 },
        ],
      },
    },
  });
  const llm = fakeLlm(() => throwHttpError(404, bodyText));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', { role: 'talk' }, {});

  assert.ok(body.includes('funnel: Add BYOK Endpoints -> 0 endpoints'));
  assert.ok(body.includes('(first hit 0 at Filter by Regional Surcharge -> 0 endpoints)'));
});

test('run: ping reports a timeout distinctly, without an HTTP status', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const llm = fakeLlm(() => {
    throw new DOMException('This operation was aborted due to timeout', 'TimeoutError');
  });
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', { role: 'talk' }, {});
  assert.ok(body.includes('FAIL'));
  assert.match(body, /timeout/i);
});

test('run: ping reports every role skipped when labels.ping.prompt is missing, without calling llm.complete', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir, { label: false });
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});

  assert.equal(llm.calls.length, 0);
  const lines = body.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.includes('skipped: label missing')));
});

test('run: ping reports it is not available when no llm dependency was injected', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { hot: hotForPing(rootDir) });

  await assert.rejects(() => admin.run('ping', {}, {}), /not available/);
});

test('run: ping never leaks a secret (e.g. an API key) into its output', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin } = makeAdmin(rootDir, { hot, llm });

  const body = await admin.run('ping', {}, {});
  assert.ok(!body.includes('Bearer'));
  assert.ok(!/sk-or-[a-z0-9]/i.test(body));
});

test('run: ping works while paused', async () => {
  const rootDir = makeRoot();
  const hot = hotForPing(rootDir);
  const llm = fakeLlm(() => ({ text: 'pong', usage: {}, estimated: 1 }));
  const { admin, store } = makeAdmin(rootDir, { hot, llm });
  store.state.data.paused = true;

  await assert.doesNotReject(() => admin.run('ping', {}, {}));
});

// ---------------------------------------------------------------------------
// memory.forget / memory.show / memory.affinity
// ---------------------------------------------------------------------------

test('run: memory.forget calls store.forgetUser and clears the profile', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });

  const result = await admin.run('memory.forget', { userId: '123' }, { guildId: 'g1' });

  assert.deepEqual(store.forgotten, [['g1', '123']]);
  assert.equal(store.getUser('g1', '123'), null);
  assert.ok(result.includes('Forgot 123'));
});

test('run: memory.show reports an unknown profile as an error', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await assert.rejects(() => admin.run('memory.show', { userId: '555' }, { guildId: 'g1' }), /no profile/);
});

test('run: memory.affinity shows the current score, band, reason and recent history', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    affinity: { score: 42, reason: 'helped once', history: [{ ts: 't1', delta: 42, score: 42, reason: 'helped once' }] },
  });

  const result = await admin.run('memory.affinity', { userId: '123' }, { guildId: 'g1' });

  assert.ok(result.includes('score: 42'));
  assert.ok(result.includes('band: fond'));
  assert.ok(result.includes('reason: helped once'));
  assert.ok(result.includes('helped once'));
});

test('run: memory.affinity show reports an error for an unknown profile', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('memory.affinity', { userId: '999' }, { guildId: 'g1' }), /no profile/);
});

test('run: memory.affinity with a score sets it exactly, bypassing maxDeltaPerUpdate', async () => {
  const rootDir = makeRoot();
  const { admin, hot, store } = makeAdmin(rootDir);
  hot.config.relationships = { maxDeltaPerUpdate: 15, historySize: 10 };

  const result = await admin.run(
    'memory.affinity',
    { userId: '123', score: 77, reason: 'owner really likes them' },
    { guildId: 'g1' },
  );

  const affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, 77, 'the score is set exactly, well beyond maxDeltaPerUpdate of 15');
  assert.equal(affinity.reason, 'owner really likes them');
  assert.ok(result.includes('77'));
});

test('run: memory.affinity shows a damped (fractional) score rounded to an integer', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', affinity: { score: 60.4, reason: 'helped once', history: [] } });

  const result = await admin.run('memory.affinity', { userId: '123' }, { guildId: 'g1' });
  assert.ok(result.includes('score: 60'));
  assert.ok(!result.includes('60.4'));
});

test('run: memory.affinity with a score sets it exactly even from a fractional (damped) current score, with no damping', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', affinity: { score: 60.4, reason: 'was doing fine', history: [] } });

  const result = await admin.run('memory.affinity', { userId: '123', score: 70, reason: 'owner override' }, { guildId: 'g1' });

  const affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, 70, 'truncating the gap to 70 - 60.4 = 9.6 -> 9 would have stranded this at 69.4');
  assert.equal(affinity.reason, 'owner override');
  assert.ok(result.includes('70'));
});

test('run: memory.affinity with a score but no reason defaults to "set by owner"', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  await admin.run('memory.affinity', { userId: '123', score: -30 }, { guildId: 'g1' });

  const affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, -30);
  assert.equal(affinity.reason, 'set by owner');
});

test('run: memory.affinity rejects an out-of-range score and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  await assert.rejects(
    () => admin.run('memory.affinity', { userId: '123', score: 150 }, { guildId: 'g1' }),
    /-100 and 100/,
  );
  assert.equal(store.getUser('g1', '123'), null);
});

test('run: memory.affinity rejects a non-integer score', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('memory.affinity', { userId: '123', score: 4.5 }, { guildId: 'g1' }));
});

test('run: memory.affinity falls back to the single served guild when context.guildId is absent', async () => {
  const rootDir = makeRoot();
  const client = { guilds: { cache: new Map([['g1', { id: 'g1', name: 'The Server' }]]) } };
  const { admin, store } = makeAdmin(rootDir, { client, getGuildId: () => 'g1' });
  store.profiles.set('g1:123', { id: '123', affinity: { score: 5, reason: 'ok so far', history: [] } });

  const result = await admin.run('memory.affinity', { userId: '123' }, {});
  assert.ok(result.includes('score: 5'));
});

test('run: memory.show/memory.forget report an error before the guild has been resolved', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { getGuildId: () => null });

  await assert.rejects(() => admin.run('memory.show', { userId: '123' }, {}), /no guild resolved yet/);
});

// ---------------------------------------------------------------------------
// memory.wipe
// ---------------------------------------------------------------------------

function clientWithGuild(guildId, name) {
  return { guilds: { cache: new Map([[guildId, { id: guildId, name }]]) } };
}

test('run: memory.wipe with the wrong confirmation text changes nothing and says what to type', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });

  const result = await admin.run('memory.wipe', { confirm: 'nope' }, { guildId: 'g1' });

  assert.equal(store.wipeCalls.length, 0);
  assert.ok(result.includes('confirm: The Server'));
});

test('run: memory.wipe with a missing confirmation changes nothing', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });

  const result = await admin.run('memory.wipe', {}, { guildId: 'g1' });

  assert.equal(store.wipeCalls.length, 0);
  assert.ok(result.includes('The Server'));
});

test('run: memory.wipe with the exact guild name wipes the guild and reports the counts', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });

  const result = await admin.run('memory.wipe', { confirm: 'The Server' }, { guildId: 'g1' });

  assert.deepEqual(store.wipeCalls, [['g1', undefined]]);
  assert.ok(result.includes('users removed: 2'));
  assert.ok(result.includes('channels removed: 1'));
  assert.ok(result.includes('lore removed: 3 (kept: 1)'));
  assert.ok(result.includes('buffer messages cleared: 5'));
});

test('run: memory.wipe trims the confirmation text but stays case-sensitive', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });

  await admin.run('memory.wipe', { confirm: '  The Server  ' }, { guildId: 'g1' });
  assert.equal(store.wipeCalls.length, 1);

  await admin.run('memory.wipe', { confirm: 'the server' }, { guildId: 'g1' });
  assert.equal(store.wipeCalls.length, 1, 'a case mismatch must not run the wipe');
});

test('run: memory.wipe requires a resolved guild', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { getGuildId: () => null });
  await assert.rejects(() => admin.run('memory.wipe', { confirm: 'anything' }, {}), /no guild resolved yet/);
});

// The following memory.show tests exercise `section: 'raw'` -- the exact
// output the command produced before F32 added the sectioned view (see
// src/admin.js#legacyMemoryShowView). F32's own sections are covered further
// below.

test('run: memory.show section:raw also prints the stored episodes (date, weight, what, quote)', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    episodes: [{ date: '2026-01-01', what: 'promised to help', quote: 'I got you', feeling: 'touched', weight: 4, addedAt: 'x' }],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(result.includes('episodes:'));
  assert.ok(result.includes('2026-01-01'));
  assert.ok(result.includes('weight 4'));
  assert.ok(result.includes('promised to help'));
  assert.ok(result.includes('I got you'));
});

test('run: memory.show section:raw without stored episodes prints no episodes section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(!result.includes('episodes:'));
});

test('run: memory.show section:raw also prints interests one per line with weight and last-seen date', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    interests: [
      { topic: 'Chess', note: 'plays weekly', weight: 3, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
      { topic: 'Anime', note: '', weight: 1, firstSeen: 'a', lastSeen: null },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(result.includes('interests:'));
  assert.ok(result.includes('[weight 3, last 2026-01-05] Chess: plays weekly'));
  assert.ok(result.includes('[weight 1] Anime'), 'a null lastSeen omits the last-date suffix');
});

test('run: memory.show section:raw without stored interests prints no interests section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty', interests: [] });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(!result.includes('interests:'));
});

test('run: memory.show section:raw also prints details one per line with id, weight and last-seen date', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    details: [
      { id: 3, text: 'Owns a cat', weight: 2, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
      { id: 4, text: 'Plays guitar', weight: 1, firstSeen: 'a', lastSeen: null },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(result.includes('details:'));
  assert.ok(result.includes('#3 [weight 2, last 2026-01-05] Owns a cat'));
  assert.ok(result.includes('#4 [weight 1] Plays guitar'));
});

test('run: memory.show section:raw without stored details prints no details section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty', details: [] });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(!result.includes('details:'));
});

test('run: memory.show section:raw also prints aliases one per line with weight and last-seen date', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    aliases: [
      { name: 'Ari', weight: 3, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
      { name: 'A', weight: 1, firstSeen: 'a', lastSeen: null },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(result.includes('aliases:'));
  assert.ok(result.includes('[weight 3, last 2026-01-05] Ari'));
  assert.ok(result.includes('[weight 1] A'), 'a null lastSeen omits the last-date suffix');
});

test('run: memory.show section:raw without stored aliases prints no aliases section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty', aliases: [] });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(!result.includes('aliases:'));
});

test('run: memory.show section:raw lists every stored interest in rank order and marks the divider between shown and hidden', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { maxInterests: 1, interestHalfLifeDays: 180 };
  const { admin, store } = makeAdmin(rootDir, { hot });
  store.profiles.set('g1:123', {
    id: '123',
    interests: [
      { topic: 'Ancient favorite', note: '', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
      { topic: 'Fresh interest', note: '', weight: 1, firstSeen: 'a', lastSeen: '2026-09-20T00:00:00.000Z' },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(result.includes('Fresh interest'), 'both stored interests are listed');
  assert.ok(result.includes('Ancient favorite'));
  const lines = result.split('\n');
  const freshLine = lines.findIndex((l) => l.trim().startsWith('[weight') && l.includes('Fresh interest'));
  const dividerLine = lines.findIndex((l) => l.includes('not shown'));
  const ancientLine = lines.findIndex((l) => l.trim().startsWith('[weight') && l.includes('Ancient favorite'));
  assert.ok(freshLine >= 0 && dividerLine > freshLine && ancientLine > dividerLine, 'the freshest ranks first, above the divider; the ancient heavy one sits below it');
});

test('run: memory.show section:raw lists every stored detail in rank order and marks the divider between shown and hidden', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { maxDetails: 1, detailHalfLifeDays: 30 };
  const { admin, store } = makeAdmin(rootDir, { hot });
  store.profiles.set('g1:123', {
    id: '123',
    details: [
      { id: 1, text: 'Ancient favorite fact', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
      { id: 2, text: 'Fresh detail', weight: 1, firstSeen: 'a', lastSeen: '2026-09-20T00:00:00.000Z' },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  const lines = result.split('\n');
  const freshLine = lines.findIndex((l) => l.trim().startsWith('#') && l.includes('Fresh detail'));
  const dividerLine = lines.findIndex((l) => l.includes('not shown'));
  const ancientLine = lines.findIndex((l) => l.trim().startsWith('#') && l.includes('Ancient favorite fact'));
  assert.ok(freshLine >= 0 && dividerLine > freshLine && ancientLine > dividerLine, 'the freshest ranks first, above the divider; the ancient heavy one sits below it');
});

test('run: memory.show section:raw with no more stored items than the shown cap prints no divider', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { maxInterests: 5 };
  const { admin, store } = makeAdmin(rootDir, { hot });
  store.profiles.set('g1:123', { id: '123', interests: [{ topic: 'Chess', note: '', weight: 1, firstSeen: 'a', lastSeen: 'a' }] });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });

  assert.ok(!result.includes('not shown'));
});

// ---------------------------------------------------------------------------
// memory.show (F32) -- sectioned view: summary (default), character/style/
// relationship, affinity, aliases/interests/details/episodes with order/limit
// ---------------------------------------------------------------------------

test('run: memory.show defaults to the summary section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    names: ['Bob', 'Bobby'],
    messageCount: 12,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-09-20T00:00:00.000Z',
    affinity: { score: 30, reason: 'helped once', history: [] },
    character: 'chatty',
    style: 'short messages',
    relationship: 'friendly',
    interests: [{ topic: 'Chess', note: '', weight: 3, firstSeen: 'a', lastSeen: 'a' }],
    details: [{ id: 1, text: 'owns a cat', weight: 1, firstSeen: 'a', lastSeen: 'a' }],
    episodes: [],
    aliases: [{ name: 'Ari', weight: 3, firstSeen: 'a', lastSeen: 'a' }],
  });

  const result = await admin.run('memory.show', { userId: '123' }, { guildId: 'g1' });

  assert.ok(result.includes('name: Bob'));
  assert.ok(result.includes('former names: Bobby'));
  assert.ok(result.includes('aliases: Ari'));
  assert.ok(result.includes('messages: 12'));
  assert.ok(result.includes('first seen: 2026-01-01'));
  assert.ok(result.includes('last seen: 2026-09-20'));
  assert.ok(result.includes('attitude: 30'));
  assert.ok(result.includes('helped once'));
  assert.ok(result.includes('character: chatty'));
  assert.ok(result.includes('style: short messages'));
  assert.ok(result.includes('relationship: friendly'));
  assert.ok(result.includes('interests: 1 stored'));
  assert.ok(result.includes('Chess'));
  assert.ok(result.includes('details: 1 stored'));
  assert.ok(result.includes('episodes: 0 stored'));
  assert.ok(result.length <= 2000);
  // never the raw JSON dump
  assert.ok(!result.trim().startsWith('{'));
});

test('run: memory.show summary rounds a damped (fractional) score for display', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', names: ['Bob'], affinity: { score: 60.4, reason: 'helped once', history: [] } });

  const result = await admin.run('memory.show', { userId: '123' }, { guildId: 'g1' });
  assert.ok(result.includes('attitude: 60'));
  assert.ok(!result.includes('60.4'));
});

test('run: memory.show section:summary always fits one Discord message, even for a huge profile', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    names: Array.from({ length: 5 }, (_, i) => `VeryLongDisplayNameNumber${i}`),
    messageCount: 999999,
    firstSeen: '2020-01-01T00:00:00.000Z',
    lastSeen: '2026-09-20T00:00:00.000Z',
    affinity: { score: 99, reason: 'x'.repeat(400), history: [] },
    character: 'c'.repeat(4000),
    style: 's'.repeat(4000),
    relationship: 'r'.repeat(4000),
    interests: Array.from({ length: 40 }, (_, i) => ({ topic: `Topic number ${i} is quite long indeed`, note: 'n'.repeat(200), weight: i, firstSeen: 'a', lastSeen: 'a' })),
    details: Array.from({ length: 40 }, (_, i) => ({ id: i, text: 'd'.repeat(200), weight: i, firstSeen: 'a', lastSeen: 'a' })),
    episodes: Array.from({ length: 20 }, (_, i) => ({ date: '2026-01-01', what: 'e'.repeat(200), weight: 3 })),
    aliases: Array.from({ length: 15 }, (_, i) => ({ name: `AliasNumber${i}longenough`, weight: i, firstSeen: 'a', lastSeen: 'a' })),
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'summary' }, { guildId: 'g1' });

  assert.ok(result.length <= 2000, `expected <= 2000 chars, got ${result.length}`);
  assert.ok(result.includes('character:'));
});

test('run: memory.show section:character/style/relationship show the full field alone', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty and warm', style: 'short bursts', relationship: 'close friends' });

  assert.equal(await admin.run('memory.show', { userId: '123', section: 'character' }, { guildId: 'g1' }), 'chatty and warm');
  assert.equal(await admin.run('memory.show', { userId: '123', section: 'style' }, { guildId: 'g1' }), 'short bursts');
  assert.equal(await admin.run('memory.show', { userId: '123', section: 'relationship' }, { guildId: 'g1' }), 'close friends');
});

test('run: memory.show section:character reports "(empty)" when nothing is stored', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123' });

  const result = await admin.run('memory.show', { userId: '123', section: 'character' }, { guildId: 'g1' });
  assert.equal(result, '(empty)');
});

test('run: memory.show section:character/relationship/interests/details/episodes resolve <@id> tokens to "name (id:...)"', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  const otherId = '999999999999999999'; // 18-digit snowflake, matches src/memory/mentions.js#TOKEN_RE
  store.profiles.set(`g1:${otherId}`, { id: otherId, names: ['Zoe'] });
  store.profiles.set('g1:123', {
    id: '123',
    character: `trusts <@${otherId}> a lot`,
    interests: [{ topic: 'Chess', note: `plays with <@${otherId}>`, weight: 2, firstSeen: 'a', lastSeen: 'a' }],
    details: [{ id: 1, text: `lives near <@${otherId}>`, weight: 1, firstSeen: 'a', lastSeen: 'a' }],
    episodes: [{ date: '2026-01-01', what: `helped <@${otherId}> move`, weight: 3 }],
  });

  assert.equal(await admin.run('memory.show', { userId: '123', section: 'character' }, { guildId: 'g1' }), `trusts Zoe (id:${otherId}) a lot`);
  assert.ok((await admin.run('memory.show', { userId: '123', section: 'interests' }, { guildId: 'g1' })).includes(`plays with Zoe (id:${otherId})`));
  assert.ok((await admin.run('memory.show', { userId: '123', section: 'details' }, { guildId: 'g1' })).includes(`lives near Zoe (id:${otherId})`));
  assert.ok((await admin.run('memory.show', { userId: '123', section: 'episodes' }, { guildId: 'g1' })).includes(`helped Zoe (id:${otherId}) move`));
});

test('run: memory.show section:raw leaves <@id> tokens unresolved', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  const otherId = '999999999999999999';
  store.profiles.set('g1:123', { id: '123', character: `trusts <@${otherId}> a lot` });

  const result = await admin.run('memory.show', { userId: '123', section: 'raw' }, { guildId: 'g1' });
  assert.ok(result.includes(`trusts <@${otherId}> a lot`));
});

test('run: memory.show section:affinity shows score, band, reason and recent history', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    affinity: { score: 42, reason: 'helped once', history: [{ ts: 't1', delta: 42, score: 42, reason: 'helped once' }] },
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'affinity' }, { guildId: 'g1' });
  assert.ok(result.includes('score: 42'));
  assert.ok(result.includes('band: fond'));
  assert.ok(result.includes('reason: helped once'));
});

test('run: memory.show section:affinity rounds a damped (fractional) score for display', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    affinity: { score: 60.4, reason: 'helped once', history: [{ ts: 't1', delta: 1, appliedDelta: 0.4, score: 60.4, reason: 'helped once' }] },
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'affinity' }, { guildId: 'g1' });
  assert.ok(result.includes('score: 60'));
  assert.ok(!result.includes('60.4'));
});

test('run: memory.show section:interests renders "topic — note [seen N, last DATE]"', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    interests: [
      { topic: 'Chess', note: 'plays weekly', weight: 3, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' },
      { topic: 'Anime', note: '', weight: 1, firstSeen: 'a', lastSeen: null },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'interests' }, { guildId: 'g1' });
  assert.ok(result.includes('Chess — plays weekly [seen 3, last 2026-01-05]'));
  assert.ok(result.includes('Anime [seen 1]'));
});

test('run: memory.show section:interests reports "No interests stored." when empty', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', interests: [] });

  assert.equal(await admin.run('memory.show', { userId: '123', section: 'interests' }, { guildId: 'g1' }), 'No interests stored.');
});

test('run: memory.show section:details renders "#id text [seen N, last DATE]"', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    details: [{ id: 7, text: 'owns a cat', weight: 2, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' }],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'details' }, { guildId: 'g1' });
  assert.equal(result, '#7 owns a cat [seen 2, last 2026-01-05]');
});

test('run: memory.show section:episodes keeps the existing date/weight/what/quote line format', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    episodes: [{ date: '2026-01-01', what: 'promised to help', quote: 'I got you', weight: 4 }],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'episodes' }, { guildId: 'g1' });
  assert.equal(result, '2026-01-01 [weight 4] promised to help "I got you"');
});

test('run: memory.show section:aliases keeps the existing "[weight N, last DATE] name" line format', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', aliases: [{ name: 'Ari', weight: 3, firstSeen: 'a', lastSeen: '2026-01-05T00:00:00.000Z' }] });

  const result = await admin.run('memory.show', { userId: '123', section: 'aliases' }, { guildId: 'g1' });
  assert.equal(result, '[weight 3, last 2026-01-05] Ari');
});

test('run: memory.show order:recent sorts a list section newest lastSeen first, no divider', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    interests: [
      { topic: 'Old', note: '', weight: 5, firstSeen: 'a', lastSeen: '2020-01-01T00:00:00.000Z' },
      { topic: 'New', note: '', weight: 1, firstSeen: 'a', lastSeen: '2026-09-01T00:00:00.000Z' },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'interests', order: 'recent' }, { guildId: 'g1' });
  const lines = result.split('\n');
  assert.ok(lines[0].startsWith('New'), 'the newer lastSeen sorts first under order:recent');
  assert.ok(lines[1].startsWith('Old'));
  assert.ok(!result.includes('not shown'), 'order:recent never shows the shown/stored divider');
});

test('run: memory.show respects a custom limit, capping a list section', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    interests: Array.from({ length: 5 }, (_, i) => ({ topic: `T${i}`, note: '', weight: 1, firstSeen: 'a', lastSeen: 'a' })),
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'interests', limit: 2 }, { guildId: 'g1' });
  assert.equal(result.split('\n').length, 2);
});

test('run: memory.show falls back to the default limit (25) for an out-of-range value', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', {
    id: '123',
    interests: Array.from({ length: 30 }, (_, i) => ({ topic: `T${i}`, note: '', weight: 1, firstSeen: 'a', lastSeen: 'a' })),
  });

  const tooBig = await admin.run('memory.show', { userId: '123', section: 'interests', limit: 500 }, { guildId: 'g1' });
  assert.equal(tooBig.split('\n').length, 25);

  const tooSmall = await admin.run('memory.show', { userId: '123', section: 'interests', limit: 0 }, { guildId: 'g1' });
  assert.equal(tooSmall.split('\n').length, 25);
});

test('run: memory.show section:interests order:rank (default) marks the divider between shown and hidden', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { maxInterests: 1, interestHalfLifeDays: 180 };
  const { admin, store } = makeAdmin(rootDir, { hot });
  store.profiles.set('g1:123', {
    id: '123',
    interests: [
      { topic: 'Ancient favorite', note: '', weight: 10, firstSeen: 'a', lastSeen: '2021-01-01T00:00:00.000Z' },
      { topic: 'Fresh interest', note: '', weight: 1, firstSeen: 'a', lastSeen: '2026-09-20T00:00:00.000Z' },
    ],
  });

  const result = await admin.run('memory.show', { userId: '123', section: 'interests' }, { guildId: 'g1' });
  const lines = result.split('\n');
  assert.ok(lines[0].startsWith('Fresh interest'));
  assert.ok(lines[1].includes('not shown'));
  assert.ok(lines[2].startsWith('Ancient favorite'));
});

// ---------------------------------------------------------------------------
// memory.channel (F45) -- the channel-note inspector: one channel's full
// stored note, or a compact table of every stored channel.
// ---------------------------------------------------------------------------

test('run: memory.channel with no channels stored reports "No channels stored."', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  assert.equal(await admin.run('memory.channel', {}, { guildId: 'g1' }), 'No channels stored.');
});

test('run: memory.channel reports an unknown channel as an error', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(
    () => admin.run('memory.channel', { channelId: '999' }, { guildId: 'g1' }),
    /no channel entry for 999/,
  );
});

test('run: memory.channel/memory.server report an error before the guild has been resolved', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { getGuildId: () => null });
  await assert.rejects(() => admin.run('memory.channel', {}, {}), /no guild resolved yet/);
  await assert.rejects(() => admin.run('memory.server', {}, {}), /no guild resolved yet/);
});

test('run: memory.channel with a channel shows the full stored note, resolves <@id> tokens, and marks main channels', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { mainChannelIds: ['c1'] };
  hot.config.context = { channelActivity: { liveMessagesPerDay: 20, deadAfterDays: 7 } };
  const { admin, store } = makeAdmin(rootDir, { hot });
  const zoeId = '999999999999999942'; // 18-digit snowflake, matches src/memory/mentions.js#TOKEN_RE
  const strangerId = '888888888888888888';
  store.profiles.set(`g1:${zoeId}`, { id: zoeId, names: ['Zoe'] });
  store.channels.set('g1:c1', {
    id: 'c1',
    name: 'general',
    category: 'Text Channels',
    topic: 'general chat',
    purpose: `hanging out with <@${zoeId}>`,
    topics: 'games, memes',
    tone: 'casual',
    messageCount: 340,
    firstMessageAt: Date.parse('2026-01-01T00:00:00.000Z'),
    lastMessageAt: Date.parse('2026-09-20T00:00:00.000Z'),
    topWriters: [{ id: zoeId, count: 12 }, { id: strangerId, count: 3 }],
    updatedAt: '2026-09-20T12:00:00.000Z',
  });

  const result = await admin.run('memory.channel', { channelId: 'c1' }, { guildId: 'g1' });

  assert.ok(result.includes('name: general'));
  assert.ok(result.includes('category: Text Channels'));
  assert.ok(result.includes('topic: general chat'));
  assert.ok(result.includes('main: true'));
  assert.ok(result.includes(`purpose: hanging out with Zoe (id:${zoeId})`));
  assert.ok(result.includes('topics: games, memes'));
  assert.ok(result.includes('tone: casual'));
  assert.ok(result.includes('messages: 340'));
  assert.ok(result.includes('first message: 2026-01-01'));
  assert.ok(result.includes('last message: 2026-09-20'));
  assert.ok(result.includes('activity:'));
  assert.ok(result.includes('top writers: Zoe (12)'), 'the unknown id (a stranger with no profile) is skipped, not rendered bare');
  assert.ok(!result.includes(strangerId));
  assert.ok(result.includes('updatedAt: 2026-09-20T12:00:00.000Z'));
});

test('run: memory.channel with a channel reports "(empty)"/none/false for a bare, never-annotated entry', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.channels.set('g1:c1', { id: 'c1', name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '', messageCount: 0, firstMessageAt: null, lastMessageAt: null, topWriters: [], updatedAt: null });

  const result = await admin.run('memory.channel', { channelId: 'c1' }, { guildId: 'g1' });

  assert.ok(result.includes('category: -'));
  assert.ok(result.includes('topic: -'));
  assert.ok(result.includes('main: false'));
  assert.ok(result.includes('purpose: (empty)'));
  assert.ok(result.includes('topics: (empty)'));
  assert.ok(result.includes('tone: (empty)'));
  assert.ok(result.includes('first message: -'));
  assert.ok(result.includes('last message: -'));
  assert.ok(result.includes('top writers: none'));
  assert.ok(result.includes('updatedAt: -'));
});

test('run: memory.channel without a channel lists every stored channel, one line each, sorted by last message desc', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.channels.set('g1:old', {
    id: 'old', name: 'archive', messageCount: 5, lastMessageAt: Date.parse('2025-01-01T00:00:00.000Z'), days: {}, purpose: '',
  });
  store.channels.set('g1:new', {
    id: 'new', name: 'general', messageCount: 500, lastMessageAt: Date.parse('2026-09-20T00:00:00.000Z'), days: {}, purpose: 'chat',
  });

  const result = await admin.run('memory.channel', {}, { guildId: 'g1' });
  const lines = result.split('\n');

  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('general'), 'the more recently active channel comes first');
  assert.match(lines[0], /messages=500/);
  assert.match(lines[0], /last=2026-09-20/);
  assert.match(lines[0], /note=yes/);
  assert.ok(lines[1].startsWith('archive'));
  assert.match(lines[1], /note=no/);
});

test('run: memory.channel drops caches first while paused, so a hand-edit is always seen', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.channels.set('g1:c1', { id: 'c1', name: 'general', purpose: '', days: {} });

  await admin.run('pause', {}, {});
  const dropsAfterPause = store.dropCachesCalls;

  await admin.run('memory.channel', {}, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 1);

  await admin.run('memory.channel', { channelId: 'c1' }, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 2);
});

// ---------------------------------------------------------------------------
// memory.server (F45) -- the stored guild-wide notes plus counts.
// ---------------------------------------------------------------------------

test('run: memory.server on an empty guild reports "(empty)"/none and zero counts', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  const result = await admin.run('memory.server', {}, { guildId: 'g1' });

  assert.ok(result.includes('patterns: (empty)'));
  assert.ok(result.includes('starters: (empty)'));
  assert.ok(result.includes('in-jokes:\nnone'));
  assert.ok(result.includes('self facts:\nnone'));
  assert.ok(result.includes('profiles stored: 0'));
  assert.ok(result.includes('channel notes stored: 0'));
  assert.ok(result.includes('lore entries: 0'));
  assert.ok(result.includes('updatedAt: -'));
});

test('run: memory.server numbers in-jokes and self facts, resolves <@id> tokens, and counts stored profiles/channels/lore', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  const zoeId = '999999999999999942'; // 18-digit snowflake, matches src/memory/mentions.js#TOKEN_RE
  store.profiles.set(`g1:${zoeId}`, { id: zoeId, names: ['Zoe'] });
  store.profiles.set('g1:43', { id: '43', names: ['Al'] });
  store.channels.set('g1:c1', { id: 'c1', name: 'general' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  store.guilds.set('g1', {
    patterns: 'talks a lot about games',
    starters: 'good morning',
    injokes: [`the great <@${zoeId}> incident`, 'pineapple pizza'],
    self: ['loves puns'],
    updatedAt: '2026-09-20T12:00:00.000Z',
  });

  const result = await admin.run('memory.server', {}, { guildId: 'g1' });

  assert.ok(result.includes('patterns: talks a lot about games'));
  assert.ok(result.includes('starters: good morning'));
  assert.ok(result.includes(`in-jokes:\n1. the great Zoe (id:${zoeId}) incident\n2. pineapple pizza`));
  assert.ok(result.includes('self facts:\n1. loves puns'));
  assert.ok(result.includes('profiles stored: 2'));
  assert.ok(result.includes('channel notes stored: 1'));
  assert.ok(result.includes('lore entries: 1'));
  assert.ok(result.includes('updatedAt: 2026-09-20T12:00:00.000Z'));
});

test('run: memory.server drops caches first while paused, so a hand-edit is always seen', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.guilds.set('g1', { patterns: 'x', starters: '', injokes: [], self: [], updatedAt: null });

  await admin.run('pause', {}, {});
  const dropsAfterPause = store.dropCachesCalls;

  await admin.run('memory.server', {}, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 1);
});

// ---------------------------------------------------------------------------
// memory.alias-add / memory.alias-remove (F32) -- real store.js/aliases.js,
// so these prove the actual store integration, not a re-implementation.
// ---------------------------------------------------------------------------

function makeRealStoreAdmin(rootDir, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-alias-'));
  const realStore = createStore({ dataDir });
  const hot = extra.hot ?? makeHot(rootDir);
  const { admin } = makeAdmin(rootDir, { ...extra, hot, store: realStore });
  return { admin, store: realStore, hot, dataDir };
}

test('run: memory.alias-add creates a new alias already confirmed, firstSeen == lastSeen == now', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    const before = Date.now();
    const result = await admin.run('memory.alias-add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const after = Date.now();

    const alias = store.getUser('g1', '123').aliases.find((a) => a.name === 'Ari');
    assert.ok(alias, 'the alias was stored');
    assert.ok(alias.weight >= 2, 'confirmed at once (default memory.confirmAfter is 2)');
    assert.equal(alias.firstSeen, alias.lastSeen, 'firstSeen and lastSeen land on the same instant');
    const seenMs = Date.parse(alias.lastSeen);
    assert.ok(seenMs >= before && seenMs <= after, 'that instant is "now"');
    assert.ok(result.includes('Ari'));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: memory.alias-add reads memory.confirmAfter and gives at least that weight', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { confirmAfter: 4 };
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir, { hot });
  try {
    await admin.run('memory.alias-add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const alias = store.getUser('g1', '123').aliases.find((a) => a.name === 'Ari');
    assert.ok(alias.weight >= 4);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: memory.alias-add is idempotent -- a second call does not keep bumping the weight', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    await admin.run('memory.alias-add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const weightAfterFirst = store.getUser('g1', '123').aliases.find((a) => a.name === 'Ari').weight;

    await admin.run('memory.alias-add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const weightAfterSecond = store.getUser('g1', '123').aliases.find((a) => a.name === 'Ari').weight;

    assert.equal(weightAfterSecond, weightAfterFirst, 'already-confirmed alias is left alone by a repeat add');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: memory.alias-add clamps to 40 characters', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    const longName = 'x'.repeat(60);
    await admin.run('memory.alias-add', { userId: '123', name: longName }, { guildId: 'g1' });
    const [alias] = store.getUser('g1', '123').aliases;
    assert.equal(alias.name.length, 40);
    assert.equal(alias.name, 'x'.repeat(40));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: memory.alias-add ignores a name equal, case-insensitively, to one of the member\'s display names', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    store.touchUser('g1', '123', 'Bob', Date.now());
    const result = await admin.run('memory.alias-add', { userId: '123', name: 'bob' }, { guildId: 'g1' });
    assert.deepEqual(store.getUser('g1', '123').aliases, []);
    assert.equal(result, 'No aliases stored.');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: memory.alias-add rejects an empty name', async () => {
  const rootDir = makeRoot();
  const { admin, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    await assert.rejects(() => admin.run('memory.alias-add', { userId: '123', name: '   ' }, { guildId: 'g1' }));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: memory.alias-remove removes an alias case-insensitively and reports the resulting list', async () => {
  const rootDir = makeRoot();
  const { admin, store, dataDir } = makeRealStoreAdmin(rootDir);
  try {
    await admin.run('memory.alias-add', { userId: '123', name: 'Ari' }, { guildId: 'g1' });
    const result = await admin.run('memory.alias-remove', { userId: '123', name: 'ARI' }, { guildId: 'g1' });

    assert.deepEqual(store.getUser('g1', '123').aliases, []);
    assert.equal(result, 'No aliases stored.');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: memory.alias-add/memory.alias-remove are refused while paused', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  await admin.run('pause', {}, {});

  await assert.rejects(
    () => admin.run('memory.alias-add', { userId: '123', name: 'Ari' }, { guildId: 'g1' }),
    /paused.*resume/i,
  );
  await assert.rejects(
    () => admin.run('memory.alias-remove', { userId: '123', name: 'Ari' }, { guildId: 'g1' }),
    /paused.*resume/i,
  );
});

// ---------------------------------------------------------------------------
// lore: add / list / show / remove
// ---------------------------------------------------------------------------

test('run: lore.add saves an owner entry, splitting comma-separated keys', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  const result = await admin.run('lore.add', { title: 'Founders Day', keys: ' founders , founding day ', text: 'The server was founded then.' }, { guildId: 'g1' });

  assert.ok(result.includes('Founders Day'));
  const [entry] = store.getLore('g1');
  assert.equal(entry.title, 'Founders Day');
  assert.deepEqual(entry.keys, ['founders', 'founding day']);
  assert.equal(entry.source, 'owner');
});

test('run: lore.add rejects an entry with no valid key or empty text', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('lore.add', { title: 'X', keys: 'a', text: 'text' }, { guildId: 'g1' }), /invalid lore entry/);
});

test('run: lore.add overwrites an existing analyzer entry and it becomes an owner entry', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer text' }], { source: 'analyzer', now: 1000 });

  await admin.run('lore.add', { title: 'Founders Day', keys: 'founders', text: 'owner text', always: true }, { guildId: 'g1' });

  const [entry] = store.getLore('g1');
  assert.equal(entry.text, 'owner text');
  assert.equal(entry.source, 'owner');
  assert.equal(entry.always, true);
});

test('run: lore.list lists id, title, keys, source and always, filtered by a query', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [
    { title: 'The Flood', keys: ['flood'], text: 'It flooded.' },
    { title: 'Founders Day', keys: ['founders'], text: 'Founded then.' },
  ], { source: 'analyzer', now: 1000 });

  const all = await admin.run('lore.list', {}, { guildId: 'g1' });
  assert.ok(all.includes('The Flood'));
  assert.ok(all.includes('Founders Day'));

  const filtered = await admin.run('lore.list', { query: 'flood' }, { guildId: 'g1' });
  assert.ok(filtered.includes('The Flood'));
  assert.ok(!filtered.includes('Founders Day'));
});

test('run: lore.list reports when there is nothing stored', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const result = await admin.run('lore.list', {}, { guildId: 'g1' });
  assert.ok(result.includes('No lore entries'));
});

test('run: lore.show returns the full entry by id', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'The Flood', keys: ['flood'], text: 'It flooded.' }], { source: 'analyzer', now: 1000 });
  const [{ id }] = store.getLore('g1');

  const result = await admin.run('lore.show', { id }, { guildId: 'g1' });
  assert.ok(result.includes('The Flood'));
  assert.ok(result.includes('It flooded.'));
});

test('run: lore.show rejects an unknown id', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('lore.show', { id: 'nope' }, { guildId: 'g1' }), /no lore entry/);
});

test('run: lore.remove deletes an entry by id and reports its title', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.setLore('g1', [{ title: 'The Flood', keys: ['flood'], text: 'It flooded.' }], { source: 'analyzer', now: 1000 });
  const [{ id }] = store.getLore('g1');

  const result = await admin.run('lore.remove', { id }, { guildId: 'g1' });
  assert.ok(result.includes('The Flood'));
  assert.deepEqual(store.getLore('g1'), []);
});

test('run: lore.remove rejects an unknown id', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  await assert.rejects(() => admin.run('lore.remove', { id: 'nope' }, { guildId: 'g1' }), /no lore entry/);
});

// ---------------------------------------------------------------------------
// status / reload
// ---------------------------------------------------------------------------

test('run: status reports model, calibration ratio and the daily request count', async () => {
  const rootDir = makeRoot();
  const client = { guilds: { cache: new Map([['g1', { id: 'g1', name: 'The Server' }]]) } };
  const { admin } = makeAdmin(rootDir, { client, calibrator: { ratio: 1.2 } });

  const body = await admin.run('status', {}, {});

  assert.match(body, /anthropic\/claude-opus-4\.6/);
  assert.match(body, /1\.200/);
  assert.match(body, /5 \/ 300/);
  assert.match(body, /guild: The Server \(g1\)/);
});

test('run: status reports "bootstrapping: false" by default and "true" when the hook says so', async () => {
  const rootDir = makeRoot();
  const { admin: idleAdmin } = makeAdmin(rootDir);
  assert.ok((await idleAdmin.run('status', {}, {})).includes('bootstrapping: false'));

  const { admin: busyAdmin } = makeAdmin(rootDir, { isBootstrapping: () => true });
  assert.ok((await busyAdmin.run('status', {}, {})).includes('bootstrapping: true'));
});

test('run: status reports dry-run off by default, as its first line', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  const body = await admin.run('status', {}, {});
  assert.equal(body.split('\n')[0], 'dry-run: off');
});

test('run: status reports dry-run ON, logging only, when no mirror channel is configured', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  hot.config.features = { dryRun: true };
  hot.config.bot.dryRunChannelId = '';

  const body = await admin.run('status', {}, {});
  assert.equal(body.split('\n')[0], 'dry-run: ON → log');
});

test('run: status reports dry-run ON with the mirror channel id when one is configured', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir);
  hot.config.features = { dryRun: true };
  hot.config.bot.dryRunChannelId = '999888777';

  const body = await admin.run('status', {}, {});
  assert.equal(body.split('\n')[0], 'dry-run: ON → log + #999888777');
});

test('run: status reports the guild as not resolved yet before startup finishes', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { getGuildId: () => null });

  const body = await admin.run('status', {}, {});
  assert.match(body, /guild: not resolved yet/);
});

test('run: reload reports both config and prompts reload outcomes', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  const body = await admin.run('reload', {}, {});
  assert.match(body, /config reload: ok/);
  assert.match(body, /prompts reload: ok/);
});

// ---------------------------------------------------------------------------
// poke
// ---------------------------------------------------------------------------

function fakeSpontaneous(pokeResult) {
  const calls = [];
  return {
    calls,
    poke: async (channel, mode) => {
      calls.push([channel.id, mode]);
      return pokeResult ?? { ok: true };
    },
  };
}

test('run: poke uses the context channel when no channel argument is given', async () => {
  const rootDir = makeRoot();
  const spontaneous = fakeSpontaneous();
  const client = { channels: { fetch: async (id) => ({ id }) } };
  const { admin } = makeAdmin(rootDir, { spontaneous, client });

  const result = await admin.run('poke', {}, { channelId: 'c1' });

  assert.deepEqual(spontaneous.calls, [['c1', 'interject']]);
  assert.ok(result.includes('poke interject on c1'));
});

test('run: poke uses the mode and channel arguments when given', async () => {
  const rootDir = makeRoot();
  const spontaneous = fakeSpontaneous();
  const client = { channels: { fetch: async (id) => ({ id }) } };
  const { admin } = makeAdmin(rootDir, { spontaneous, client });

  await admin.run('poke', { mode: 'initiate', channelId: 'other' }, { channelId: 'c1' });

  assert.deepEqual(spontaneous.calls, [['other', 'initiate']]);
});

test('run: poke throws when no channel is available at all', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { spontaneous: fakeSpontaneous() });
  await assert.rejects(() => admin.run('poke', {}, {}), /channel/);
});

// ---------------------------------------------------------------------------
// pause / resume — F30
// ---------------------------------------------------------------------------

test('run: pause sets paused/pausedAt first, flushes, and drops caches', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  const result = await admin.run('pause', {}, {});

  assert.equal(store.state.data.paused, true);
  assert.ok(store.state.data.pausedAt);
  assert.ok(store.flushCalls >= 1);
  assert.equal(store.dropCachesCalls, 1);
  assert.match(result, /paused/i);
  assert.match(result, /resume/i);
});

test('run: pause is idempotent -- a second call just reports the state without dropping caches again', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  await admin.run('pause', {}, {});
  const pausedAt = store.state.data.pausedAt;
  const dropsAfterFirst = store.dropCachesCalls;

  const result = await admin.run('pause', {}, {});

  assert.equal(store.state.data.pausedAt, pausedAt, 'pausedAt is not bumped by a repeat pause');
  assert.equal(store.dropCachesCalls, dropsAfterFirst, 'nothing is dropped again');
  assert.match(result, /already paused/i);
});

test('run: pause clears the pending-ping queue', async () => {
  const rootDir = makeRoot();
  let clearCalls = 0;
  const pending = { clear: () => { clearCalls += 1; } };
  const { admin } = makeAdmin(rootDir, { pending });

  await admin.run('pause', {}, {});

  assert.equal(clearCalls, 1);
});

test('run: pause waits for a turn already in flight before dropping caches', async () => {
  const rootDir = makeRoot();
  let resolveIdle;
  const idlePromise = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const turns = { waitIdle: () => idlePromise };
  const { admin, store } = makeAdmin(rootDir, { turns });

  const pausePromise = admin.run('pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the in-flight turn finished');

  resolveIdle();
  await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
});

test('run: pause waits for an in-flight live-analyzer run before dropping caches', async () => {
  const rootDir = makeRoot();
  let resolveIdle;
  const idlePromise = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const memory = { waitIdle: () => idlePromise };
  const { admin, store } = makeAdmin(rootDir, { memory });

  const pausePromise = admin.run('pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the in-flight analyzer run finished');

  resolveIdle();
  await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
});

test('run: pause waits for an in-flight bootstrap run before dropping caches', async () => {
  const rootDir = makeRoot();
  let resolveIdle;
  const idlePromise = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const bootstrap = { waitIdle: () => idlePromise };
  const { admin, store } = makeAdmin(rootDir, { bootstrap });

  const pausePromise = admin.run('pause', {}, {});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(store.dropCachesCalls, 0, 'must not drop caches before the in-flight bootstrap run finished');

  resolveIdle();
  await pausePromise;
  assert.equal(store.dropCachesCalls, 1);
});

// F30 review fix: a live-analyzer run() already in flight when /nep pause
// arrives (an LLM call can take 30-90s) must be allowed to finish and apply
// normally -- its result must land on disk BEFORE the flush + dropCaches, or
// the eventual applyMemoryUpdate would re-read a profile from disk, mutate it
// and mark it dirty AFTER the owner started editing files under data/ --
// exactly the overwrite this feature exists to prevent. Real store + real
// createMemoryUpdater, only the LLM is faked, so this exercises the actual
// buffer-shift + flush + running.delete() sequence run() performs internally.
function minimalMemoryHot() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      memory: { batchMessages: 10, minBatchMessages: 1, maxBatchAgeMinutes: 180, maxOutputTokens: 700, fieldChars: 400 },
      features: {},
    },
    prompts: { memory: 'memory system prompt', labels },
  };
}

function slimBufferMessage(overrides = {}) {
  return {
    id: 'm1',
    channelId: 'c1',
    channelName: 'general',
    authorId: 'u2',
    authorName: 'Bob',
    self: false,
    bot: false,
    content: 'hi',
    ts: Date.now(),
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    direct: false,
    ...overrides,
  };
}

test('run: pause waits for an in-flight live-analyzer run to finish -- its result is on disk before pause completes, nothing is written after', async () => {
  const rootDir = makeRoot();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-data-'));
  try {
    const realStore = createStore({ dataDir });
    const guildId = 'g1';
    realStore.pushBuffer(guildId, slimBufferMessage(), 100);

    let resolveLlm;
    const llm = {
      complete: () =>
        new Promise((resolve) => {
          resolveLlm = () => resolve({ text: JSON.stringify({ guild: { patterns: 'set by the in-flight run' } }), usage: {}, estimated: 1 });
        }),
    };
    const calibrator = { ratio: 1, apply: (n) => n, observe: () => {} };
    const memory = createMemoryUpdater({ hot: minimalMemoryHot(), store: realStore, llm, calibrator, getSelfName: () => 'Nept' });

    const runPromise = memory.run(guildId); // in flight: the fake LLM has not resolved yet
    await new Promise((resolve) => setTimeout(resolve, 0)); // let run() reach the pending llm.complete() call

    const { admin } = makeAdmin(rootDir, { store: realStore, memory });
    let pauseResolved = false;
    const pausePromise = admin.run('pause', {}, {}).then((r) => {
      pauseResolved = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(pauseResolved, false, 'pause must wait for the in-flight analyzer run, not race ahead of it');

    resolveLlm(); // the LLM resolves late, after pause was already requested
    await runPromise;
    await pausePromise;

    assert.equal(pauseResolved, true);
    assert.equal(realStore.getGuild(guildId).patterns, 'set by the in-flight run', 'the analyzer result was applied');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', guildId, 'guild.json'), 'utf8'));
    assert.equal(onDisk.patterns, 'set by the in-flight run', 'and flushed to disk before pause completed');
    assert.deepEqual(realStore.getBuffer(guildId), [], 'the buffer was shifted by the completed run, not left for a later write');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('F30: no timer-driven writer (spontaneous.tick, memory.tick, store.flush) touches data/ while paused', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-timers-'));
  try {
    const realStore = createStore({ dataDir });
    const guildId = 'g1';
    realStore.touchUser(guildId, 'u1', 'Alice', 1000);
    realStore.updateGuild(guildId, { patterns: 'x' });
    realStore.pushBuffer(guildId, slimBufferMessage(), 100);
    realStore.flush();

    const userFile = path.join(dataDir, 'guilds', guildId, 'users', 'u1.json');
    const guildFile = path.join(dataDir, 'guilds', guildId, 'guild.json');
    const bufferFile = path.join(dataDir, 'guilds', guildId, 'buffer.json');
    const before = {
      user: fs.statSync(userFile).mtimeMs,
      guild: fs.statSync(guildFile).mtimeMs,
      buffer: fs.statSync(bufferFile).mtimeMs,
    };

    realStore.state.data.paused = true;

    const spontaneous = createSpontaneous({
      hot: { config: {} },
      store: realStore,
      client: { guilds: { cache: new Map() } },
      turns: { runTurn: async () => ({ outcome: 'spoke' }), isBusy: () => false, isAnyBusy: () => false, lastPostAt: () => 0 },
      getGuildId: () => guildId,
    });
    const memory = createMemoryUpdater({
      hot: { config: {} },
      store: realStore,
      llm: { complete: async () => { throw new Error('the analyzer must never be called while paused'); } },
      calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
      getSelfName: () => 'Nept',
    });

    // Mirrors index.js's three periodic timers firing once, back to back.
    await spontaneous.tick();
    await memory.tick();
    realStore.flush();

    assert.equal(fs.statSync(userFile).mtimeMs, before.user);
    assert.equal(fs.statSync(guildFile).mtimeMs, before.guild);
    assert.equal(fs.statSync(bufferFile).mtimeMs, before.buffer);
    assert.equal(JSON.parse(fs.readFileSync(bufferFile, 'utf8')).length, 1, 'the buffered message is left exactly as it was');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('run: resume refuses when data/ has an invalid file, naming the path, and leaves paused untouched', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  await admin.run('pause', {}, {});
  store.validateResult = ['guilds/g1/users/u1.json'];

  const result = await admin.run('resume', {}, {});

  assert.match(result, /invalid json/i);
  assert.ok(result.includes('guilds/g1/users/u1.json'));
  assert.equal(store.state.data.paused, true, 'stays paused');
});

test('run: resume clears the flags and reports plain confirmation', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  await admin.run('pause', {}, {});

  const result = await admin.run('resume', {}, {});

  assert.equal(store.state.data.paused, undefined);
  assert.equal(store.state.data.pausedAt, undefined);
  assert.equal(store.reloadStateCalls, 1);
  assert.equal(result, 'Resumed.');
});

test('run: resume is idempotent -- reports "Not paused." when not paused', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  const result = await admin.run('resume', {}, {});

  assert.equal(result, 'Not paused.');
});

test('run: status reports "paused: false" by default and "paused: true (since ...)" once paused', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);

  const before = await admin.run('status', {}, {});
  assert.ok(before.includes('paused: false'));

  await admin.run('pause', {}, {});
  const after = await admin.run('status', {}, {});
  assert.ok(after.includes(`paused: true (since ${store.state.data.pausedAt})`));
});

test('run: every command that writes data/ is refused while paused, with a hint to resume', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  const [{ id: loreId }] = store.getLore('g1');

  await admin.run('pause', {}, {});

  const attempts = [
    ['memory.forget', { userId: '123' }],
    ['memory.affinity', { userId: '123', score: 5 }],
    ['memory.wipe', { confirm: 'The Server' }],
    ['lore.add', { title: 'Y', keys: 'y', text: 'z' }],
    ['lore.remove', { id: loreId }],
    ['poke', {}],
  ];
  for (const [key, args] of attempts) {
    await assert.rejects(
      () => admin.run(key, args, { guildId: 'g1', channelId: 'c1' }),
      /paused.*resume/i,
      `${key} must be refused while paused`,
    );
  }

  assert.equal(store.forgotten.length, 0);
  assert.equal(store.wipeCalls.length, 0);
});

test('run: read-only and config commands keep working while paused', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const { admin, store } = makeAdmin(rootDir, { client });
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });

  await admin.run('pause', {}, {});

  await assert.doesNotReject(() => admin.run('status', {}, {}));
  await assert.doesNotReject(() => admin.run('memory.show', { userId: '123' }, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('memory.affinity', { userId: '123' }, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('lore.list', {}, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('model.show', {}, {}));
  await assert.doesNotReject(() => admin.run('rule.list', {}, {}));
  await assert.doesNotReject(() => admin.run('reload', {}, {}));
  await assert.doesNotReject(() => admin.run('set', { path: 'llm.model', value: '"x/y"' }, {}));
  await assert.doesNotReject(() => admin.run('unset', { path: 'llm.model' }, {}));
  await assert.doesNotReject(() => admin.run('model.set', { role: 'talk', id: 'x/y' }, {}));
});

test('run: memory.show/lore.list/lore.show drop caches first while paused, so a hand-edit is always seen', async () => {
  const rootDir = makeRoot();
  const { admin, store } = makeAdmin(rootDir);
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });
  const [{ id: loreId }] = store.getLore('g1');

  await admin.run('pause', {}, {});
  const dropsAfterPause = store.dropCachesCalls;

  await admin.run('memory.show', { userId: '123' }, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 1);

  await admin.run('lore.list', {}, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 2);

  await admin.run('lore.show', { id: loreId }, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 3);

  await admin.run('memory.affinity', { userId: '123' }, { guildId: 'g1' });
  assert.equal(store.dropCachesCalls, dropsAfterPause + 4);
});

// ---------------------------------------------------------------------------
// bootstrap -- people stays read-only; run/user/users/channel/channels/server
// write under data/ and are guarded by assertNotPaused().
// ---------------------------------------------------------------------------

function fakeBootstrap(overrides = {}) {
  const calls = {
    peopleReport: 0,
    run: 0,
    stop: 0,
    runPerson: 0,
    runChannel: 0,
    runServer: 0,
    runUsers: 0,
    runChannels: 0,
    status: 0,
    reset: 0,
    refreshPortrait: 0,
  };
  return {
    calls,
    run: async (guildId) => {
      calls.run += 1;
      calls.lastRunGuildId = guildId;
      return overrides.run ?? { ok: true };
    },
    stop: () => {
      calls.stop += 1;
      return overrides.stop ?? { ok: true };
    },
    runPerson: async (guildId, userId) => {
      calls.runPerson += 1;
      calls.lastRunPersonId = userId;
      return (
        overrides.runPerson ?? {
          ok: true,
          outcome: {
            ok: true,
            member: { id: userId, name: 'Alice', messages: 40, firstTs: 1000, lastTs: 5000 },
            answer: {
              character: 'friendly and curious',
              style: 'short',
              interests: [{ topic: 'games', note: 'plays a lot', times: 3 }],
              details: [{ text: 'lives nearby', times: 1 }],
              episodes: [],
              aliases: ['Al'],
            },
            sample: { ownCount: 10, contextCount: 5 },
            tokensUsed: 1234,
            chunks: 1,
          },
        }
      );
    },
    runChannel: async (guildId, channelId) => {
      calls.runChannel += 1;
      calls.lastRunChannelId = channelId;
      return (
        overrides.runChannel ?? {
          ok: true,
          outcome: {
            ok: true,
            channel: { id: channelId, name: 'general' },
            result: { purpose: 'general chat', topics: 'everything', tone: 'casual' },
          },
        }
      );
    },
    runServer: async (guildId) => {
      calls.runServer += 1;
      calls.lastRunServerGuildId = guildId;
      return (
        overrides.runServer ?? {
          ok: true,
          outcome: { ok: true, counts: { patternsChars: 120, startersChars: 40, injokes: 3, lore: 2 } },
        }
      );
    },
    runUsers: async (guildId) => {
      calls.runUsers += 1;
      calls.lastRunUsersGuildId = guildId;
      return overrides.runUsers ?? { ok: true, count: 5 };
    },
    runChannels: async (guildId) => {
      calls.runChannels += 1;
      calls.lastRunChannelsGuildId = guildId;
      return overrides.runChannels ?? { ok: true, count: 8 };
    },
    status: async () => {
      calls.status += 1;
      return (
        overrides.status ?? {
          phase: 'running',
          doneChannels: 1,
          channelsEligible: 2,
          donePeople: 3,
          peopleEligible: 5,
          doneServer: false,
          tokensUsed: 1000,
          requests: 4,
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: null,
          aborted: null,
          nextTarget: 'person: Bob (id:2)',
        }
      );
    },
    reset: () => {
      calls.reset += 1;
      return overrides.reset ?? { ok: true };
    },
    refreshPortrait: async (guildId, userId, reason, opts) => {
      calls.refreshPortrait += 1;
      calls.lastRefreshUserId = userId;
      calls.lastRefreshOpts = opts;
      return overrides.refreshPortrait ?? { ok: true, userId };
    },
    peopleReport: async () => {
      calls.peopleReport += 1;
      return (
        overrides.peopleReport ?? {
          ok: true,
          people: [{ id: '1', name: 'Alice', messages: 40, firstTs: 1000, lastTs: 5000, byChannel: { c1: 40 } }],
          totals: { channelsRead: 3, messagesRead: 500, belowThreshold: 2 },
        }
      );
    },
  };
}

test('run: bootstrap.people reports "not available" when the dependency is absent', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  assert.equal(await admin.run('warmup.people', {}, { guildId: 'g1' }), 'bootstrap is not available');
});

test('run: bootstrap.people formats the people list and totals', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.people', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.peopleReport, 1);
  assert.ok(body.includes('Alice (id:1)'));
  assert.ok(body.includes('channels read: 3'));
  assert.ok(body.includes('messages read: 500'));
  assert.ok(body.includes('people below the threshold: 2'));
});

test('run: bootstrap.people keeps working while paused', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});

  await assert.doesNotReject(() => admin.run('warmup.people', {}, { guildId: 'g1' }));
  assert.equal(bootstrap.calls.peopleReport, 1);
});

// ---------------------------------------------------------------------------
// bootstrap.run / users / channels / server / status / reset / memory.refresh
// -- the write path
// ---------------------------------------------------------------------------

test('run: bootstrap.run/users/channels/server/status/reset and memory.refresh report "not available" when the dependency is absent', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  assert.equal(await admin.run('warmup.run', {}, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('warmup.stop', {}, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('warmup.users', { userId: '1' }, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('warmup.users', {}, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('warmup.channels', { channelId: 'c1' }, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('warmup.channels', {}, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('warmup.server', {}, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('warmup.status', {}, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('warmup.reset', {}, { guildId: 'g1' }), 'bootstrap is not available');
  await assert.rejects(() => admin.run('memory.refresh', { userId: '1' }, { guildId: 'g1' }), /bootstrap is not available/);
});

test('run: warmup.run starts the whole run in the background and replies at once', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.run', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.run, 1);
  assert.equal(bootstrap.calls.lastRunGuildId, 'g1');
  assert.match(body, /warmup started/);
  assert.match(body, /warmup status/);
});

test('run: warmup.run is refused while a warmup is already in flight', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  bootstrap.isBootstrapping = () => true;
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.run', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.run, 0);
  assert.match(body, /already in flight/);
});

test('run: bootstrap.run is refused while paused', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.run', {}, { guildId: 'g1' }), /paused/);
  assert.equal(bootstrap.calls.run, 0);
});

test('run: warmup.stop replies "warmup stopped" when a run is in flight', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ stop: { ok: true } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.stop', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.stop, 1);
  assert.equal(body, 'warmup stopped');
});

test('run: warmup.stop replies "no warmup in flight" when nothing is running', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ stop: { ok: false } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.stop', {}, { guildId: 'g1' });
  assert.equal(body, 'no warmup in flight');
});

test('run: warmup.stop keeps working while paused (touches no data/)', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ stop: { ok: true } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});
  await assert.doesNotReject(() => admin.run('warmup.stop', {}, { guildId: 'g1' }));
  assert.equal(bootstrap.calls.stop, 1);
});

test('run: warmup.users with a member profiles exactly that member now, synchronously, and summarizes what was written', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.users', { userId: '1' }, { guildId: 'g1' });
  assert.equal(bootstrap.calls.runPerson, 1);
  assert.equal(bootstrap.calls.lastRunPersonId, '1');
  assert.equal(bootstrap.calls.runUsers, 0, 'a member given must not also start the background bulk redo');
  assert.match(body, /profiled Alice \(id:1\)/);
  assert.match(body, /sample: 10 own \/ 5 context lines/);
  assert.match(body, /tokens used: 1234/);
  assert.match(body, /interests: 1, details: 1, episodes: 0, aliases: 1/);
  assert.match(body, /character: friendly and curious/);
});

test('run: warmup.users with a member relays "no messages in the window" unchanged', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ runPerson: { ok: false, message: 'no messages in the window' } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.users', { userId: '1' }, { guildId: 'g1' });
  assert.equal(body, 'no messages in the window');
});

test('run: warmup.users with a member is refused while paused', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.users', { userId: '1' }, { guildId: 'g1' }), /paused/);
  assert.equal(bootstrap.calls.runPerson, 0);
});

test('run: warmup.users with no member starts a background redo of every qualifying member', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.users', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.runUsers, 1);
  assert.equal(bootstrap.calls.lastRunUsersGuildId, 'g1');
  assert.equal(bootstrap.calls.runPerson, 0, 'no member given must not also profile one synchronously');
  assert.equal(body, 'started 5 members');
});

test('run: warmup.users with no member relays a refusal (e.g. a run already in flight)', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ runUsers: { ok: false, message: 'a bootstrap run is already in flight' } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.users', {}, { guildId: 'g1' });
  assert.equal(body, 'a bootstrap run is already in flight');
});

test('run: warmup.users with no member is refused while paused', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.users', {}, { guildId: 'g1' }), /paused/);
  assert.equal(bootstrap.calls.runUsers, 0);
});

test('run: warmup.channels with a channel describes exactly that channel now, synchronously, and reports the note written', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.channels', { channelId: 'c1' }, { guildId: 'g1' });
  assert.equal(bootstrap.calls.runChannel, 1);
  assert.equal(bootstrap.calls.lastRunChannelId, 'c1');
  assert.equal(bootstrap.calls.runChannels, 0, 'a channel given must not also start the background bulk redo');
  assert.match(body, /described #general \(id:c1\)/);
  assert.match(body, /purpose: general chat/);
  assert.match(body, /topics: everything/);
  assert.match(body, /tone: casual/);
});

test('run: warmup.channels with a channel reports counters and top writers when the outcome carries facts (F42)', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({
    runChannel: {
      ok: true,
      outcome: {
        ok: true,
        channel: { id: 'c1', name: 'general' },
        result: { purpose: 'general chat', topics: 'everything', tone: 'casual' },
        facts: {
          messageCount: 42,
          firstMessageAt: 1000,
          lastMessageAt: Date.now() - 5 * 60_000,
          days: {},
          topWriters: [{ id: 'u1', count: 10 }, { id: 'ghost', count: 2 }], // 'ghost' has no stored profile
        },
      },
    },
  });
  const { admin, store } = makeAdmin(rootDir, { bootstrap });
  store.profiles.set('g1:u1', { id: 'u1', names: ['Alice'] });

  const body = await admin.run('warmup.channels', { channelId: 'c1' }, { guildId: 'g1' });
  assert.match(body, /messages seen: 42/);
  assert.match(body, /last message: \d+ min ago/);
  assert.match(body, /top writers: Alice/);
  assert.ok(!body.includes('ghost'), 'an id with no stored profile must be skipped, not shown raw');
});

test('run: warmup.channels with a channel relays a failure message unchanged', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ runChannel: { ok: false, message: 'channel not found, not readable, or not in this guild' } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.channels', { channelId: 'c1' }, { guildId: 'g1' });
  assert.equal(body, 'channel not found, not readable, or not in this guild');
});

test('run: warmup.channels with a channel is refused while paused', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.channels', { channelId: 'c1' }, { guildId: 'g1' }), /paused/);
  assert.equal(bootstrap.calls.runChannel, 0);
});

test('run: warmup.channels with no channel starts a background redo of every readable channel', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.channels', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.runChannels, 1);
  assert.equal(bootstrap.calls.runChannel, 0, 'no channel given must not also describe one synchronously');
  assert.equal(body, 'started 8 channels');
});

test('run: warmup.channels with no channel is refused while paused', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.channels', {}, { guildId: 'g1' }), /paused/);
  assert.equal(bootstrap.calls.runChannels, 0);
});

test('run: bootstrap.server (re)builds the server-wide notes and reports counts', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.server', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.runServer, 1);
  assert.match(body, /patterns 120 chars/);
  assert.match(body, /starters 40 chars/);
  assert.match(body, /injokes 3/);
  assert.match(body, /lore entries 2/);
});

test('run: bootstrap.server relays a failure message unchanged', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ runServer: { ok: false, message: 'prompt file missing: prompts/server.md is not configured yet' } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.server', {}, { guildId: 'g1' });
  assert.equal(body, 'prompt file missing: prompts/server.md is not configured yet');
});

test('run: bootstrap.server is refused while paused', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('warmup.server', {}, { guildId: 'g1' }), /paused/);
  assert.equal(bootstrap.calls.runServer, 0);
});

test('run: bootstrap.status formats phase, progress, tokens and the next target', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.status', {}, { guildId: 'g1' });
  assert.match(body, /phase: running/);
  assert.match(body, /channels: 1\/2/);
  assert.match(body, /people: 3\/5/);
  assert.match(body, /tokens used: 1000/);
  assert.match(body, /next target: person: Bob \(id:2\)/);
});

test('run: bootstrap.status falls back to the coarse phase and "never" when activity is absent', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.status', {}, { guildId: 'g1' });
  assert.match(body, /phase: running/);
  assert.match(body, /last activity: never/);
});

// ---------------------------------------------------------------------------
// bootstrap.status: the F40 activity-driven phase line and "last activity: …ago"
// ---------------------------------------------------------------------------

function withActivity(activity, overrides = {}) {
  return fakeBootstrap({
    status: {
      phase: 'running',
      doneChannels: 0,
      channelsEligible: null,
      donePeople: 0,
      peopleEligible: null,
      doneServer: false,
      tokensUsed: 0,
      requests: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      aborted: null,
      nextTarget: null,
      activity,
      ...overrides,
    },
  });
}

test('run: bootstrap.status shows the fetching phase with channel counts', async () => {
  const rootDir = makeRoot();
  const bootstrap = withActivity({ phase: 'fetching', detail: { channelsFetched: 12, channelsTotal: 29 }, lastActivityAt: Date.now() - 3000 });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.status', {}, { guildId: 'g1' });
  assert.match(body, /phase: fetching history, 12\/29 channels/);
  assert.match(body, /last activity: 3 s ago/);
});

test('run: bootstrap.status shows the channel phase with its name and position', async () => {
  const rootDir = makeRoot();
  const bootstrap = withActivity({ phase: 'channel', detail: { id: 'c1', name: 'general', index: 3, total: 21 }, lastActivityAt: Date.now() });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.status', {}, { guildId: 'g1' });
  assert.match(body, /phase: describing channel #general \(3 of 21\)/);
});

test('run: bootstrap.status shows the person phase with its name, position and chunk count', async () => {
  const rootDir = makeRoot();
  const bootstrap = withActivity({
    phase: 'person',
    detail: { id: '42', name: 'Alice', index: 7, total: 38, chunk: { k: 2, n: 3 } },
    lastActivityAt: Date.now(),
  });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.status', {}, { guildId: 'g1' });
  assert.match(body, /phase: profiling Alice \(id:42\) \(7 of 38\), chunk 2\/3/);
});

test('run: bootstrap.status shows the server phase', async () => {
  const rootDir = makeRoot();
  const bootstrap = withActivity({ phase: 'server', detail: null, lastActivityAt: Date.now() });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.status', {}, { guildId: 'g1' });
  assert.match(body, /phase: building the server notes/);
});

test('run: bootstrap.status shows the waiting-rate-limit phase with "until" and the wait count', async () => {
  const rootDir = makeRoot();
  const until = Date.UTC(2026, 0, 1, 14, 30);
  const bootstrap = withActivity({ phase: 'waiting-rate-limit', detail: { until, waits: 2 }, lastActivityAt: Date.now() });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.status', {}, { guildId: 'g1' });
  assert.match(body, /phase: waiting for the provider rate limit until 14:30 UTC \(wait 2\)/);
});

test('run: bootstrap.status shows the paused/finished/aborted phases', async () => {
  const rootDir = makeRoot();

  const paused = withActivity({ phase: 'paused', detail: null, lastActivityAt: Date.now() });
  const { admin: adminPaused } = makeAdmin(rootDir, { bootstrap: paused });
  assert.match(await adminPaused.run('warmup.status', {}, { guildId: 'g1' }), /phase: paused/);

  const stopped = withActivity({ phase: 'stopped', detail: null, lastActivityAt: Date.now() });
  const { admin: adminStopped } = makeAdmin(rootDir, { bootstrap: stopped });
  assert.match(await adminStopped.run('warmup.status', {}, { guildId: 'g1' }), /phase: stopped/);

  const finished = withActivity({ phase: 'finished', detail: null, lastActivityAt: Date.now() });
  const { admin: adminFinished } = makeAdmin(rootDir, { bootstrap: finished });
  assert.match(await adminFinished.run('warmup.status', {}, { guildId: 'g1' }), /phase: finished/);

  const aborted = withActivity({ phase: 'aborted', detail: { reason: 'rate-limit' }, lastActivityAt: Date.now() });
  const { admin: adminAborted } = makeAdmin(rootDir, { bootstrap: aborted });
  assert.match(await adminAborted.run('warmup.status', {}, { guildId: 'g1' }), /phase: aborted \(rate-limit\)/);
});

test('run: bootstrap.reset clears progress and is not guarded by assertNotPaused (the factory itself refuses while running)', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.reset', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.reset, 1);
  assert.match(body, /reset/);
});

test('run: bootstrap.reset relays a refusal message from the factory (e.g. a run in flight)', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ reset: { ok: false, message: 'a bootstrap run is in flight -- pause or wait for it first' } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('warmup.reset', {}, { guildId: 'g1' });
  assert.equal(body, 'a bootstrap run is in flight -- pause or wait for it first');
});

test('run: memory.refresh forces a portrait refresh, ignoring the hours rail', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('memory.refresh', { userId: '1' }, { guildId: 'g1' });
  assert.equal(bootstrap.calls.refreshPortrait, 1);
  assert.equal(bootstrap.calls.lastRefreshUserId, '1');
  assert.deepEqual(bootstrap.calls.lastRefreshOpts, { force: true });
  assert.match(body, /refreshed/);
});

test('run: memory.refresh reports the reason when the refresh is not performed', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({ refreshPortrait: { ok: false, reason: 'daily-cap' } });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('memory.refresh', { userId: '1' }, { guildId: 'g1' });
  assert.match(body, /daily-cap/);
});

test('run: memory.refresh is refused while paused', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});
  await assert.rejects(() => admin.run('memory.refresh', { userId: '1' }, { guildId: 'g1' }), /paused/);
  assert.equal(bootstrap.calls.refreshPortrait, 0);
});

test('run: status includes a bootstrap progress line when the dependency is available', async () => {
  const rootDir = makeRoot();
  const bootstrap = {
    summary: () => ({ doneChannels: 2, donePeople: 4, doneServer: true, tokensUsed: 500, requests: 6, aborted: null }),
  };
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('status', {}, {});
  assert.match(body, /bootstrap: channels=2 people=4 server=done tokens=500 requests=6 aborted=no/);
});

test('run: memory.wipe is refused while a warmup is in flight', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { isBootstrapping: () => true });
  await assert.rejects(
    () => admin.run('memory.wipe', { confirm: 'Guild' }, { guildId: 'g1' }),
    /warmup is running/,
  );
});
