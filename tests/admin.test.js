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
  const store = {
    profiles,
    forgotten,
    lore,
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
    warmup: extra.warmup,
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

test('run: memory.wipe is refused while a warm-up is running', async () => {
  const rootDir = makeRoot();
  const client = clientWithGuild('g1', 'The Server');
  const warmup = fakeWarmup({
    status: {
      enabled: true, done: false, paused: false, aborted: false, running: true, tokensUsed: 0, maxTokens: 1000,
      requests: 0, messagesAnalyzed: 0, messagesTotal: 0, reachedTs: 0, skippedMessages: 0,
      onlyListed: false, channels: [],
    },
  });
  const { admin, store } = makeAdmin(rootDir, { client, warmup });

  await assert.rejects(
    () => admin.run('memory.wipe', { confirm: 'The Server' }, { guildId: 'g1' }),
    /warm-up is running.*\/nep warmup stop/,
  );
  assert.equal(store.wipeCalls.length, 0);
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
  assert.ok(result.includes('/nep warmup run'));
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
// warmup
// ---------------------------------------------------------------------------

function fakeWarmup(overrides = {}) {
  const calls = { run: 0, stop: 0, reset: 0, plan: 0 };
  return {
    calls,
    status: () =>
      overrides.status ?? {
        enabled: true,
        done: false,
        paused: false,
        aborted: false,
        running: false,
        tokensUsed: 100,
        maxTokens: 1000,
        requests: 2,
        messagesAnalyzed: 42,
        messagesTotal: 500,
        reachedTs: 1700000000000,
        skippedMessages: 3,
        onlyListed: true,
        channels: [{ id: '111', name: 'general', limit: 500, messages: 120 }],
      },
    plan: async () => {
      calls.plan += 1;
      return (
        overrides.plan ?? {
          plan: [
            { id: '55555', name: 'general', depth: 1000, role: 'listed' },
            { id: '222', name: 'lore', depth: 500, role: 'default' },
          ],
          missing: ['999999'],
          maxTokens: 1_000_000,
          outputTokens: 8000,
          batchMessages: 150,
        }
      );
    },
    run: async () => {
      calls.run += 1;
      if (overrides.runThrows) throw overrides.runThrows;
      return {};
    },
    stop: () => {
      calls.stop += 1;
      if (overrides.stopThrows) throw overrides.stopThrows;
    },
    reset: () => {
      calls.reset += 1;
      if (overrides.resetThrows) throw overrides.resetThrows;
    },
  };
}

test('run: warmup.status reports the extended status', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.status', {}, {});

  assert.ok(body.includes('tokens: 100 / 1000'));
  assert.ok(body.includes('paused: false'));
  assert.ok(body.includes('analysed 42 of 500 messages'));
  assert.ok(body.includes('timeline reached:'));
  assert.ok(body.includes('skipped messages: 3'));
  assert.ok(body.includes('only listed channels: true'));
  assert.ok(body.includes('#general (111)'));
});

// ---------------------------------------------------------------------------
// warmup.status: phase / last activity / analyzer model (F35 addendum)
// ---------------------------------------------------------------------------

test('run: warmup.status shows phase: idle, last activity: never and the analyzer model when no activity is reported', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup(); // the default status() carries no `activity` field at all
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.status', {}, {});

  assert.ok(body.includes('phase: idle'));
  assert.ok(body.includes('last activity: never'));
  assert.ok(body.includes('analyzer model: anthropic/claude-opus-4.6'));
});

test('run: warmup.status prefers memory.model for the analyzer model line, falling back to llm.model', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.memory = { model: 'anthropic/claude-haiku-4.5' };
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { hot, warmup });

  const body = await admin.run('warmup.status', {}, {});
  assert.ok(body.includes('analyzer model: anthropic/claude-haiku-4.5'));
});

test('run: warmup.status renders each phase from the reported activity', async () => {
  const rootDir = makeRoot();
  const cases = [
    [{ phase: 'fetching', channelsFetched: 3, channelsTotal: 10 }, 'phase: fetching history, 3/10 channels'],
    [{ phase: 'analysing', windowBatch: 2, windowBatches: 4, messages: 150 }, 'phase: analysing, batch 2 of 4 in the window (150 messages)'],
    [{ phase: 'describing', windowBatch: 1, windowBatches: 2, messages: 10 }, 'phase: describing media, batch 1 of 2 in the window (10 messages)'],
    [{ phase: 'paused' }, 'phase: paused'],
    [{ phase: 'done' }, 'phase: done'],
  ];

  for (const [activity, expectedLine] of cases) {
    const base = fakeWarmup().status();
    const warmup = fakeWarmup({ status: { ...base, activity: { ...activity, lastActivityAt: Date.now() } } });
    const { admin } = makeAdmin(rootDir, { warmup });
    const body = await admin.run('warmup.status', {}, {});
    assert.ok(body.includes(expectedLine), `expected "${expectedLine}" in:\n${body}`);
  }
});

test('run: warmup.status renders the waiting-rate-limit phase with a UTC time and the wait count', async () => {
  const rootDir = makeRoot();
  const until = Date.UTC(2026, 0, 1, 20, 24, 0);
  const base = fakeWarmup().status();
  const warmup = fakeWarmup({ status: { ...base, activity: { phase: 'waiting-rate-limit', until, waits: 2, lastActivityAt: Date.now() } } });
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.status', {}, {});
  assert.ok(body.includes('phase: waiting for the provider rate limit until 20:24 UTC (wait 2)'));
});

test('run: warmup.status renders the aborted phase with its reason and detail', async () => {
  const rootDir = makeRoot();
  const base = fakeWarmup().status();
  const warmup = fakeWarmup({
    status: { ...base, activity: { phase: 'aborted', reason: 'token-limit', detail: 'request too large', lastActivityAt: Date.now() } },
  });
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.status', {}, {});
  assert.ok(body.includes('phase: aborted (token-limit: request too large)'));
});

test('run: warmup.status shows a humanised "last activity" line', async () => {
  const rootDir = makeRoot();
  const thirtySecondsAgo = Date.now() - 30_000;
  const base = fakeWarmup().status();
  const warmup = fakeWarmup({ status: { ...base, activity: { phase: 'done', lastActivityAt: thirtySecondsAgo } } });
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.status', {}, {});
  assert.match(body, /last activity: 3\d s ago/);
});

test('run: warmup.plan reports the ordered plan, missing ids and budget line', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.plan', {}, {});
  const lines = body.split('\n');
  assert.ok(lines.some((l) => l.includes('1. #general (55555) — 1000, listed')));
  assert.ok(lines.some((l) => l.includes('2. #lore (222) — 500, default')));
  assert.ok(lines.some((l) => l.includes('missing: 999999')));
  assert.ok(lines.some((l) => l.includes('budget: 1000000 tokens') && l.includes('output limit: 8000') && l.includes('batch size: 150')));
});

test('run: warmup.channel sets a numeric depth override', async () => {
  const rootDir = makeRoot();
  const { admin, hot } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  const result = await admin.run('warmup.channel', { channelId: '123456', depth: 500 }, {});

  assert.deepEqual(readLocal(rootDir), { warmup: { channelDepths: { '123456': 500 } } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok(result.includes('depth set to 500'));
});

test('run: warmup.channel with depth 0 skips the channel', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  const result = await admin.run('warmup.channel', { channelId: '123456', depth: 0 }, {});

  assert.deepEqual(readLocal(rootDir), { warmup: { channelDepths: { '123456': 0 } } });
  assert.ok(result.includes('skipped'));
});

test('run: warmup.channel-default removes a previously set override', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await admin.run('warmup.channel', { channelId: '123456', depth: 500 }, {});
  await admin.run('warmup.channel-default', { channelId: '123456' }, {});

  assert.deepEqual(readLocal(rootDir), {});
});

test('run: warmup.channel rejects an out-of-range depth and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await assert.rejects(() => admin.run('warmup.channel', { channelId: '123456', depth: -1 }, {}));
  assert.equal(hasLocal(rootDir), false);
});

test('run: warmup.channel requires a channel', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });
  await assert.rejects(() => admin.run('warmup.channel', { depth: 500 }, {}));
});

test('run: warmup.only toggles onlyListed', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await admin.run('warmup.only', { enabled: true }, {});
  assert.deepEqual(readLocal(rootDir), { warmup: { onlyListed: true } });

  await admin.run('warmup.only', { enabled: false }, {});
  assert.deepEqual(readLocal(rootDir), { warmup: { onlyListed: false } });
});

test('run: warmup.depth sets the default read depth', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await admin.run('warmup.depth', { messages: 5000 }, {});
  assert.deepEqual(readLocal(rootDir), { warmup: { messagesPerChannel: 5000 } });
});

test('run: warmup.depth rejects 0 and values above 1000000', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await assert.rejects(() => admin.run('warmup.depth', { messages: 0 }, {}));
  await assert.rejects(() => admin.run('warmup.depth', { messages: 2_000_000 }, {}));
  assert.equal(hasLocal(rootDir), false);
});

test('run: warmup.budget parses plain integers and the k/m suffixes', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await admin.run('warmup.budget', { tokens: '500k' }, {});
  assert.deepEqual(readLocal(rootDir), { warmup: { maxTokens: 500_000 } });

  await admin.run('warmup.budget', { tokens: '10m' }, {});
  assert.deepEqual(readLocal(rootDir), { warmup: { maxTokens: 10_000_000 } });

  await admin.run('warmup.budget', { tokens: '42' }, {});
  assert.deepEqual(readLocal(rootDir), { warmup: { maxTokens: 42 } });
});

test('run: warmup.budget rejects garbage and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await assert.rejects(() => admin.run('warmup.budget', { tokens: 'lots' }, {}));
  assert.equal(hasLocal(rootDir), false);
});

test('run: warmup.output sets memory.maxOutputTokens within 256..32000', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await admin.run('warmup.output', { tokens: 4000 }, {});
  assert.deepEqual(readLocal(rootDir), { memory: { maxOutputTokens: 4000 } });
});

test('run: warmup.output rejects a value outside 256..32000 and writes nothing', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await assert.rejects(() => admin.run('warmup.output', { tokens: 100 }, {}));
  await assert.rejects(() => admin.run('warmup.output', { tokens: 40_000 }, {}));
  assert.equal(hasLocal(rootDir), false);
});

test('run: warmup.run starts the warm-up when it is neither running nor done', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const result = await admin.run('warmup.run', {}, {});

  assert.equal(warmup.calls.run, 1);
  assert.ok(result.includes('started'));
});

test('run: warmup.run reports it is already running instead of starting a second one', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup({
    status: {
      enabled: true, done: false, paused: false, aborted: false, running: true, tokensUsed: 0, maxTokens: 1000,
      requests: 0, messagesAnalyzed: 0, messagesTotal: 0, reachedTs: 0, skippedMessages: 0,
      onlyListed: false, channels: [],
    },
  });
  const { admin } = makeAdmin(rootDir, { warmup });

  const result = await admin.run('warmup.run', {}, {});
  assert.equal(warmup.calls.run, 0);
  assert.ok(result.includes('already running'));
});

test('run: warmup.stop requests a pause while running', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup({
    status: {
      enabled: true, done: false, paused: false, aborted: false, running: true, tokensUsed: 0, maxTokens: 1000,
      requests: 0, messagesAnalyzed: 0, messagesTotal: 0, reachedTs: 0, skippedMessages: 0,
      onlyListed: false, channels: [],
    },
  });
  const { admin } = makeAdmin(rootDir, { warmup });

  const result = await admin.run('warmup.stop', {}, {});
  assert.equal(warmup.calls.stop, 1);
  assert.ok(result.includes('pause'));
});

test('run: warmup.stop reports it is not running instead of stopping nothing', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const result = await admin.run('warmup.stop', {}, {});
  assert.equal(warmup.calls.stop, 0);
  assert.ok(result.includes('not running'));
});

test('run: warmup.reset clears progress and reports success', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const result = await admin.run('warmup.reset', {}, {});
  assert.equal(warmup.calls.reset, 1);
  assert.ok(result.includes('reset'));
});

test('run: warmup.reset while running surfaces the error', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup({ resetThrows: new Error('warmup: cannot reset while running') });
  const { admin } = makeAdmin(rootDir, { warmup });

  await assert.rejects(() => admin.run('warmup.reset', {}, {}), /cannot reset while running/);
});

test('run: every warmup.* command reports unavailable when no warmup dependency was injected', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);

  const result = await admin.run('warmup.status', {}, {});
  assert.ok(result.includes('not available'));

  const result2 = await admin.run('warmup.run', {}, {});
  assert.ok(result2.includes('not available'));
});

// ---------------------------------------------------------------------------
// pause / resume — F30
// ---------------------------------------------------------------------------

/** A warm-up whose status().running flips false once stop() is called, and whose
 * run() resolves that SAME in-flight promise when called again while running --
 * mirrors createWarmup()'s real idempotent-while-running contract closely enough
 * for admin.js's pause handler to be tested without the real warm-up module. */
function fakeInterruptibleWarmup() {
  let running = true;
  const calls = { stop: 0, run: 0 };
  let resolveRun;
  const runPromise = new Promise((resolve) => {
    resolveRun = resolve;
  });
  return {
    calls,
    status: () => ({
      running,
      done: false,
      paused: false,
      aborted: false,
      enabled: true,
      tokensUsed: 0,
      maxTokens: 0,
      requests: 0,
      messagesAnalyzed: 0,
      messagesTotal: 0,
      reachedTs: 0,
      skippedMessages: 0,
      onlyListed: false,
      channels: [],
    }),
    stop: () => {
      calls.stop += 1;
      running = false;
      resolveRun({ paused: true });
    },
    run: () => {
      calls.run += 1;
      return runPromise;
    },
  };
}

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

test('run: pause interrupts a running warm-up, waits for it, and remembers resumeWarmup', async () => {
  const rootDir = makeRoot();
  const warmup = fakeInterruptibleWarmup();
  const { admin, store } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});

  assert.equal(warmup.calls.stop, 1);
  assert.equal(warmup.calls.run, 1, 'joins the same in-flight run instead of starting a new one');
  assert.equal(store.state.data.resumeWarmup, true);
});

test('run: pause does not touch resumeWarmup when no warm-up is running', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup(); // status().running === false by default
  const { admin, store } = makeAdmin(rootDir, { warmup });

  await admin.run('pause', {}, {});

  assert.equal(warmup.calls.run, 0);
  assert.equal(store.state.data.resumeWarmup, undefined);
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

test('run: resume clears the flags and reports plain confirmation when no warm-up needs resuming', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin, store } = makeAdmin(rootDir, { warmup });
  await admin.run('pause', {}, {});

  const result = await admin.run('resume', {}, {});

  assert.equal(store.state.data.paused, undefined);
  assert.equal(store.state.data.pausedAt, undefined);
  assert.equal(store.state.data.resumeWarmup, undefined);
  assert.equal(store.reloadStateCalls, 1);
  assert.equal(warmup.calls.run, 0);
  assert.equal(result, 'Resumed.');
});

test('run: resume restarts the warm-up (not awaited) when resumeWarmup was set', async () => {
  const rootDir = makeRoot();
  const warmup = fakeInterruptibleWarmup();
  const { admin, store } = makeAdmin(rootDir, { warmup });
  await admin.run('pause', {}, {});
  assert.equal(store.state.data.resumeWarmup, true);

  const result = await admin.run('resume', {}, {});

  assert.equal(warmup.calls.run, 2, 'once to join the interrupted run during pause, once more to resume it');
  assert.match(result, /continue/i);
});

test('run: resume is idempotent -- reports "Not paused." when not paused', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const result = await admin.run('resume', {}, {});

  assert.equal(result, 'Not paused.');
  assert.equal(warmup.calls.run, 0);
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
  const warmup = fakeWarmup();
  const { admin, store } = makeAdmin(rootDir, { client, warmup });
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
    ['warmup.run', {}],
    ['warmup.reset', {}],
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
  const warmup = fakeWarmup();
  const { admin, store } = makeAdmin(rootDir, { client, warmup });
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });
  store.setLore('g1', [{ title: 'X', keys: ['xx'], text: 'y' }], { source: 'owner', now: 1 });

  await admin.run('pause', {}, {});

  await assert.doesNotReject(() => admin.run('status', {}, {}));
  await assert.doesNotReject(() => admin.run('memory.show', { userId: '123' }, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('memory.affinity', { userId: '123' }, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('lore.list', {}, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('warmup.status', {}, {}));
  await assert.doesNotReject(() => admin.run('warmup.plan', {}, {}));
  await assert.doesNotReject(() => admin.run('model.show', {}, {}));
  await assert.doesNotReject(() => admin.run('rule.list', {}, {}));
  await assert.doesNotReject(() => admin.run('reload', {}, {}));
  await assert.doesNotReject(() => admin.run('set', { path: 'llm.model', value: '"x/y"' }, {}));
  await assert.doesNotReject(() => admin.run('unset', { path: 'llm.model' }, {}));
  await assert.doesNotReject(() => admin.run('model.set', { role: 'talk', id: 'x/y' }, {}));
  await assert.doesNotReject(() => admin.run('warmup.only', { enabled: true }, {}));
  await assert.doesNotReject(() => admin.run('warmup.depth', { messages: 100 }, {}));
  await assert.doesNotReject(() => admin.run('warmup.budget', { tokens: '1k' }, {}));
  await assert.doesNotReject(() => admin.run('warmup.output', { tokens: 1000 }, {}));
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
// bootstrap (F36 phase A) -- a read-only preview, never guarded by assertNotPaused()
// ---------------------------------------------------------------------------

function fakeBootstrap(overrides = {}) {
  const calls = { peopleReport: 0, previewUser: 0, previewChannel: 0 };
  return {
    calls,
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
    previewUser: async (guildId, userId) => {
      calls.previewUser += 1;
      calls.lastUserId = userId;
      return (
        overrides.previewUser ?? {
          ok: true,
          member: { id: userId, name: 'Alice', messages: 40, firstTs: 1000, lastTs: 5000 },
          sample: { ownCount: 10, contextCount: 5, channels: ['c1'] },
          estimatedTokens: 1234,
          usage: { prompt_tokens: 1000, completion_tokens: 200 },
          result: {
            character: 'friendly',
            style: 'short',
            interests: [{ topic: 'games', note: 'plays a lot', times: 3 }],
            details: [],
            episodes: [],
            aliases: ['Al'],
          },
        }
      );
    },
    previewChannel: async (guildId, channelId) => {
      calls.previewChannel += 1;
      calls.lastChannelId = channelId;
      return (
        overrides.previewChannel ?? {
          ok: true,
          channel: { id: channelId, name: 'general', category: 'Chat', topic: 'chit chat', isMain: false },
          sample: { kept: 100, dropped: 0, total: 100 },
          estimatedTokens: 500,
          usage: { prompt_tokens: 400, completion_tokens: 50 },
          result: { purpose: 'general chat', topics: 'everything', tone: 'casual' },
        }
      );
    },
  };
}

test('run: bootstrap.people/preview report "not available" when the dependency is absent', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir);
  assert.equal(await admin.run('bootstrap.people', {}, { guildId: 'g1' }), 'bootstrap is not available');
  assert.equal(await admin.run('bootstrap.preview', { userId: '1' }, { guildId: 'g1' }), 'bootstrap is not available');
});

test('run: bootstrap.people formats the people list and totals', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('bootstrap.people', {}, { guildId: 'g1' });
  assert.equal(bootstrap.calls.peopleReport, 1);
  assert.ok(body.includes('Alice (id:1)'));
  assert.ok(body.includes('channels read: 3'));
  assert.ok(body.includes('messages read: 500'));
  assert.ok(body.includes('people below the threshold: 2'));
});

test('run: bootstrap.preview requires exactly one of user/channel', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await assert.rejects(() => admin.run('bootstrap.preview', {}, { guildId: 'g1' }), /exactly one/);
  await assert.rejects(() => admin.run('bootstrap.preview', { userId: '1', channelId: 'c1' }, { guildId: 'g1' }), /exactly one/);
  assert.equal(bootstrap.calls.previewUser, 0);
  assert.equal(bootstrap.calls.previewChannel, 0);
});

test('run: bootstrap.preview user: calls previewUser and formats the profile result', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('bootstrap.preview', { userId: '1' }, { guildId: 'g1' });
  assert.equal(bootstrap.calls.previewUser, 1);
  assert.equal(bootstrap.calls.lastUserId, '1');
  assert.ok(body.includes('character: friendly'));
  assert.ok(body.includes('games'));
  assert.ok(body.includes('Al'));
});

test('run: bootstrap.preview channel: calls previewChannel and formats the channel result', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('bootstrap.preview', { channelId: 'c1' }, { guildId: 'g1' });
  assert.equal(bootstrap.calls.previewChannel, 1);
  assert.equal(bootstrap.calls.lastChannelId, 'c1');
  assert.ok(body.includes('purpose: general chat'));
});

test('run: bootstrap.preview passes through a missing-prompt-file message unchanged', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap({
    previewUser: { ok: false, message: 'prompt file missing: prompts/profile.md is not configured yet' },
  });
  const { admin } = makeAdmin(rootDir, { bootstrap });

  const body = await admin.run('bootstrap.preview', { userId: '1' }, { guildId: 'g1' });
  assert.equal(body, 'prompt file missing: prompts/profile.md is not configured yet');
});

test('run: bootstrap.people/preview keep working while paused -- a read-only preview writes nothing under data/', async () => {
  const rootDir = makeRoot();
  const bootstrap = fakeBootstrap();
  const { admin } = makeAdmin(rootDir, { bootstrap });

  await admin.run('pause', {}, {});

  await assert.doesNotReject(() => admin.run('bootstrap.people', {}, { guildId: 'g1' }));
  await assert.doesNotReject(() => admin.run('bootstrap.preview', { userId: '1' }, { guildId: 'g1' }));
  assert.equal(bootstrap.calls.peopleReport, 1);
  assert.equal(bootstrap.calls.previewUser, 1);
});
