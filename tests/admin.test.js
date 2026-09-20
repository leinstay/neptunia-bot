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
} from '../src/admin.js';
import { emptyAffinity, applyDelta } from '../src/memory/affinity.js';

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
  return {
    profiles,
    forgotten,
    state: { data: { llmCount: 5, llmDay: '2026-09-20' } },
    getUser(guildId, userId) {
      return profiles.get(`${guildId}:${userId}`) ?? null;
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
  };
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
        channelsDone: 1,
        channelsTotal: 3,
        messagesAnalyzed: 42,
        skippedMessages: 3,
        primaryChannelId: '55555',
        onlyListed: true,
        channels: [{ id: '111', name: 'general', limit: 500, messages: 120, batchesDone: 2, done: false }],
      },
    plan: async () => {
      calls.plan += 1;
      return (
        overrides.plan ?? {
          plan: [
            { id: '55555', name: 'general', depth: 500, role: 'primary' },
            { id: '222', name: 'lore', depth: 1000, role: 'listed' },
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
  assert.ok(body.includes('channels: 1 / 3'));
  assert.ok(body.includes('paused: false'));
  assert.ok(body.includes('skipped messages: 3'));
  assert.ok(body.includes('primary channel: 55555'));
  assert.ok(body.includes('only listed channels: true'));
  assert.ok(body.includes('#general (111)'));
});

test('run: warmup.plan reports the ordered plan, missing ids and budget line', async () => {
  const rootDir = makeRoot();
  const warmup = fakeWarmup();
  const { admin } = makeAdmin(rootDir, { warmup });

  const body = await admin.run('warmup.plan', {}, {});
  const lines = body.split('\n');
  assert.ok(lines.some((l) => l.includes('1. #general (55555) — 500, primary')));
  assert.ok(lines.some((l) => l.includes('2. #lore (222) — 1000, listed')));
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

test('run: warmup.primary sets the primary channel', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await admin.run('warmup.primary', { channelId: '777888' }, {});
  assert.deepEqual(readLocal(rootDir), { warmup: { primaryChannelId: '777888' } });
});

test('run: warmup.primary with no channel clears the primary channel', async () => {
  const rootDir = makeRoot();
  const { admin } = makeAdmin(rootDir, { warmup: fakeWarmup() });

  await admin.run('warmup.primary', { channelId: '777888' }, {});
  await admin.run('warmup.primary', {}, {});

  assert.deepEqual(readLocal(rootDir), { warmup: { primaryChannelId: '' } });
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
      requests: 0, channelsDone: 0, channelsTotal: 1, messagesAnalyzed: 0, skippedMessages: 0, primaryChannelId: '',
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
      requests: 0, channelsDone: 0, channelsTotal: 1, messagesAnalyzed: 0, skippedMessages: 0, primaryChannelId: '',
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
