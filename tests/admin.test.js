import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseCommand,
  listRules,
  appendRule,
  removeRule,
  setPath,
  unsetPath,
  createAdmin,
} from '../src/admin.js';
import { emptyAffinity, applyDelta } from '../src/memory/affinity.js';

// ---------------------------------------------------------------------------
// parseCommand
// ---------------------------------------------------------------------------

test('parseCommand: splits a prefixed command into a lowercased name and trimmed args', () => {
  assert.deepEqual(parseCommand('!nep rule Never spoil the ending', '!nep'), {
    name: 'rule',
    args: 'Never spoil the ending',
  });
});

test('parseCommand: lowercases the command name but keeps args in their original case', () => {
  assert.deepEqual(parseCommand('!nep SET llm.Model "Foo"', '!nep'), {
    name: 'set',
    args: 'llm.Model "Foo"',
  });
});

test('parseCommand: a bare prefix parses as help', () => {
  assert.deepEqual(parseCommand('!nep', '!nep'), { name: 'help', args: '' });
});

test('parseCommand: a prefix followed only by whitespace parses as help', () => {
  assert.deepEqual(parseCommand('!nep   ', '!nep'), { name: 'help', args: '' });
});

test('parseCommand: rejects content that does not start with the prefix', () => {
  assert.equal(parseCommand('hello !nep rule x', '!nep'), null);
});

test('parseCommand: rejects the prefix glued to more text with no separating whitespace', () => {
  assert.equal(parseCommand('!nephelp', '!nep'), null);
});

test('parseCommand: rejects non-string content or an empty prefix', () => {
  assert.equal(parseCommand(null, '!nep'), null);
  assert.equal(parseCommand('!nep help', ''), null);
});

// ---------------------------------------------------------------------------
// listRules / appendRule / removeRule
// ---------------------------------------------------------------------------

test('listRules: reads the bullets under an English ## heading', () => {
  const text = '# Rules file\n\nSome intro.\n\n## Rules\n\n- Rule one\n- Rule two\n';
  assert.deepEqual(listRules(text), ['Rule one', 'Rule two']);
});

test('listRules: reads the bullets under a Cyrillic ## heading', () => {
  const text = '# Rules file\n\nSome intro.\n\n## Правила\n\n- Rule one\n- Rule two\n';
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

test('appendRule: keeps Cyrillic rule text intact and the file ends with the bullet list', () => {
  const result = appendRule('## Правила\n\n- старое правило\n', 'никогда не говори по-английски');
  assert.equal(result, '## Правила\n\n- старое правило\n- никогда не говори по-английски\n');
  assert.deepEqual(listRules(result), ['старое правило', 'никогда не говори по-английски']);
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
// createAdmin().handle — fakes on a temp dir
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
      bot: { owners: ['42'], commandPrefix: '!nep' },
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

function makeMessage({ authorId = '42', content, guild = null, channel = null }) {
  const sent = [];
  const reactions = [];
  return {
    content,
    guild,
    channel,
    author: {
      id: authorId,
      async send(text) {
        sent.push(text);
      },
    },
    async react(emoji) {
      reactions.push(emoji);
    },
    sent,
    reactions,
  };
}

test('handle: ignores a command from a non-owner and writes nothing', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const before = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'), 'utf8');
  const message = makeMessage({ authorId: '999', content: '!nep rule sneaky rule' });
  const handled = await admin.handle(message);

  assert.equal(handled, false);
  assert.equal(message.sent.length, 0);
  assert.equal(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(rootDir, 'prompts.local')), false);
});

test('handle: ignores a message that is not a command', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: 'just chatting' });
  assert.equal(await admin.handle(message), false);
});

test('handle: rule seeds prompts.local/rules.md from the base file, leaving prompts/rules.md untouched', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const baseBefore = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'));
  const message = makeMessage({ content: '!nep rule Never spoil the ending', guild: { id: 'g1' } });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  const localFile = path.join(rootDir, 'prompts.local', 'rules.md');
  assert.ok(fs.existsSync(localFile));
  const rulesText = fs.readFileSync(localFile, 'utf8');
  assert.deepEqual(listRules(rulesText), ['be kind', 'Never spoil the ending']);
  // the tracked base file is byte-identical to before
  assert.deepEqual(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md')), baseBefore);
  assert.equal(hot.reloadPromptsCalls, 1);
  assert.ok(message.sent[0].includes('Rule added'));
  assert.deepEqual(message.reactions, ['✅']);
});

test('handle: rule creates the prompts.local directory when it does not exist yet', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  assert.equal(fs.existsSync(path.join(rootDir, 'prompts.local')), false);
  await admin.handle(makeMessage({ content: '!nep rule be nice' }));
  assert.ok(fs.statSync(path.join(rootDir, 'prompts.local')).isDirectory());
});

test('handle: rules lists the numbered rules; unrule removes one from the local layer, leaving the base file untouched', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const baseBefore = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'));
  await admin.handle(makeMessage({ content: '!nep rule second rule' }));
  const listed = makeMessage({ content: '!nep rules' });
  await admin.handle(listed);
  assert.ok(listed.sent[0].includes('1. be kind'));
  assert.ok(listed.sent[0].includes('2. second rule'));

  await admin.handle(makeMessage({ content: '!nep unrule 1' }));
  const rulesText = fs.readFileSync(path.join(rootDir, 'prompts.local', 'rules.md'), 'utf8');
  assert.deepEqual(listRules(rulesText), ['second rule']);
  assert.deepEqual(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md')), baseBefore);
});

test('handle: rule seeds from an empty text when the base rules.md is missing', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-admin-'));
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep rule only rule' });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  const rulesText = fs.readFileSync(path.join(rootDir, 'prompts.local', 'rules.md'), 'utf8');
  assert.deepEqual(listRules(rulesText), ['only rule']);
});

test('handle: set writes an override to config.local.json and reloads config', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep set llm.model "openrouter/test-model"' });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  const local = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8'));
  assert.deepEqual(local, { llm: { model: 'openrouter/test-model' } });
  assert.equal(hot.reloadConfigCalls, 1);
  assert.ok(message.sent[0].includes('Set llm.model'));
});

test('handle: set rejects an unknown config path and writes nothing', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep set llm.doesNotExist 1', guild: { id: 'g1' } });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  assert.equal(fs.existsSync(path.join(rootDir, 'config.local.json')), false);
  assert.ok(message.sent[0].includes('Error'));
  assert.ok(message.sent[0].includes('unknown config path'));
  assert.deepEqual(message.reactions, ['❌']);
});

test('handle: unset removes a previously set override', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  await admin.handle(makeMessage({ content: '!nep set llm.model "temp-model"' }));
  await admin.handle(makeMessage({ content: '!nep unset llm.model' }));

  const local = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.local.json'), 'utf8'));
  assert.deepEqual(local, {});
  assert.equal(hot.reloadConfigCalls, 2);
});

test('handle: forget calls store.forgetUser and clears the profile', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  store.profiles.set('g1:123', { id: '123', character: 'chatty' });
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep forget <@123>', guild: { id: 'g1' } });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  assert.deepEqual(store.forgotten, [['g1', '123']]);
  assert.equal(store.getUser('g1', '123'), null);
  assert.ok(message.sent[0].includes('Forgot 123'));
});

test('handle: memory reports an unknown profile as an error, reacting with the cross mark', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep memory 555', guild: { id: 'g1' } });
  await admin.handle(message);

  assert.ok(message.sent[0].includes('Error'));
  assert.deepEqual(message.reactions, ['❌']);
});

test('handle: affinity shows the current score, band, reason and recent history', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  store.profiles.set('g1:123', { id: '123', affinity: { score: 42, reason: 'helped once', history: [{ ts: 't1', delta: 42, score: 42, reason: 'helped once' }] } });
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep affinity 123', guild: { id: 'g1' } });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  assert.ok(message.sent[0].includes('score: 42'));
  assert.ok(message.sent[0].includes('band: fond'));
  assert.ok(message.sent[0].includes('reason: helped once'));
  assert.ok(message.sent[0].includes('helped once'));
  assert.deepEqual(message.reactions, ['✅']);
});

test('handle: affinity show reports an error for an unknown profile', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep affinity 999', guild: { id: 'g1' } });
  await admin.handle(message);

  assert.ok(message.sent[0].includes('Error'));
  assert.deepEqual(message.reactions, ['❌']);
});

test('handle: affinity with a score sets it exactly, bypassing maxDeltaPerUpdate', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  hot.config.relationships = { maxDeltaPerUpdate: 15, historySize: 10 };
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep affinity 123 77 owner really likes them', guild: { id: 'g1' } });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  const affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, 77, 'the score is set exactly, well beyond maxDeltaPerUpdate of 15');
  assert.equal(affinity.reason, 'owner really likes them');
  assert.deepEqual(message.reactions, ['✅']);
});

test('handle: affinity with a score but no reason defaults to "set by owner"', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  await admin.handle(makeMessage({ content: '!nep affinity 123 -30', guild: { id: 'g1' } }));

  const affinity = store.getUser('g1', '123').affinity;
  assert.equal(affinity.score, -30);
  assert.equal(affinity.reason, 'set by owner');
});

test('handle: affinity rejects an out-of-range score and writes nothing', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep affinity 123 150', guild: { id: 'g1' } });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  assert.ok(message.sent[0].includes('Error'));
  assert.deepEqual(message.reactions, ['❌']);
  assert.equal(store.getUser('g1', '123'), null);
});

test('handle: affinity rejects a non-integer score', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep affinity 123 4.5', guild: { id: 'g1' } });
  await admin.handle(message);

  assert.ok(message.sent[0].includes('Error'));
  assert.deepEqual(message.reactions, ['❌']);
});

test('handle: affinity is ignored entirely for a non-owner', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ authorId: '999', content: '!nep affinity 123 80', guild: { id: 'g1' } });
  const handled = await admin.handle(message);

  assert.equal(handled, false);
  assert.equal(message.sent.length, 0);
  assert.equal(store.getUser('g1', '123'), null);
});

test('handle: affinity in a DM uses the single served guild, not a search across guilds', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  store.profiles.set('g1:123', { id: '123', affinity: { score: 5, reason: 'ok so far', history: [] } });
  const client = { guilds: { cache: new Map([['g1', { id: 'g1', name: 'The Server' }]]) } };
  const admin = createAdmin({ hot, store, client, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep affinity 123' });
  await admin.handle(message);

  assert.ok(message.sent[0].includes('score: 5'));
});

test('handle: affinity/memory/forget in a DM report an error before the guild has been resolved', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => null });

  const message = makeMessage({ content: '!nep memory 123' });
  await admin.handle(message);

  assert.ok(message.sent[0].includes('Error'));
  assert.match(message.sent[0], /no guild resolved yet/);
});

test('handle: status reports model, calibration ratio and the daily request count', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const client = { guilds: { cache: new Map([['g1', { id: 'g1', name: 'The Server' }]]) } };
  const admin = createAdmin({ hot, store, client, spontaneous: {}, calibrator: { ratio: 1.2 }, getGuildId: () => 'g1' });

  const message = makeMessage({ content: '!nep status' });
  await admin.handle(message);

  const body = message.sent[0];
  assert.match(body, /anthropic\/claude-opus-4\.6/);
  assert.match(body, /1\.200/);
  assert.match(body, /5 \/ 300/);
  assert.match(body, /guild: The Server \(g1\)/);
});

test('handle: status reports the guild as not resolved yet before startup finishes', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 }, getGuildId: () => null });

  const message = makeMessage({ content: '!nep status' });
  await admin.handle(message);

  assert.match(message.sent[0], /guild: not resolved yet/);
});
