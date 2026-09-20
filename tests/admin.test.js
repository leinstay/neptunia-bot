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

test('listRules: reads the bullets under the ## Правила heading', () => {
  const text = '# Rules file\n\nSome intro.\n\n## Правила\n\n- Rule one\n- Rule two\n';
  assert.deepEqual(listRules(text), ['Rule one', 'Rule two']);
});

test('listRules: stops at the next heading so unrelated bullets are excluded', () => {
  const text = '## Правила\n\n- Rule one\n\n## Other section\n\n- not a rule\n';
  assert.deepEqual(listRules(text), ['Rule one']);
});

test('listRules: falls back to every top-level bullet when the heading is missing', () => {
  const text = 'Intro\n- first\n- second\n';
  assert.deepEqual(listRules(text), ['first', 'second']);
});

test('listRules: an empty or heading-only file has no rules', () => {
  assert.deepEqual(listRules(''), []);
  assert.deepEqual(listRules('## Правила\n'), []);
});

test('appendRule: appends the bullet as the last line', () => {
  const text = '## Правила\n\n- existing\n';
  assert.equal(appendRule(text, 'new one'), '## Правила\n\n- existing\n- new one\n');
});

test('appendRule: collapses newlines inside the rule into single spaces', () => {
  const result = appendRule('## Правила\n', 'first line\nsecond line');
  assert.equal(listRules(result).at(-1), 'first line second line');
});

test('appendRule: creates the ## Правила heading when it is missing', () => {
  const result = appendRule('Some preamble.', 'be nice');
  assert.match(result, /## Правила/);
  assert.deepEqual(listRules(result), ['be nice']);
});

test('appendRule: normalizes trailing whitespace to exactly one final newline', () => {
  const result = appendRule('## Правила\n\n\n\n', 'one rule');
  assert.equal(result, '## Правила\n- one rule\n');
  assert.ok(result.endsWith('\n') && !result.endsWith('\n\n'));
});

test('appendRule: keeps Cyrillic rule text intact and the file ends with the bullet list', () => {
  const result = appendRule('## Правила\n\n- старое правило\n', 'никогда не говори по-английски');
  assert.equal(result, '## Правила\n\n- старое правило\n- никогда не говори по-английски\n');
  assert.deepEqual(listRules(result), ['старое правило', 'никогда не говори по-английски']);
});

test('removeRule: removes the nth bullet in listRules order and reports it', () => {
  const text = '## Правила\n\n- one\n- two\n- three\n';
  const result = removeRule(text, 2);
  assert.equal(result.removed, 'two');
  assert.deepEqual(listRules(result.text), ['one', 'three']);
});

test('removeRule: returns null for n out of range', () => {
  const text = '## Правила\n\n- only one\n';
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
  fs.writeFileSync(path.join(rootDir, 'prompts', 'rules.md'), '## Правила\n\n- be kind\n');
  return rootDir;
}

function makeHot(rootDir) {
  return {
    config: {
      bot: { owners: ['42'], commandPrefix: '!nep' },
      llm: { model: 'anthropic/claude-opus-4.6', maxRequestsPerDay: 300 },
    },
    prompts: { persona: 'who she is' },
    promptsDir: path.join(rootDir, 'prompts'),
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
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

  const before = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'), 'utf8');
  const message = makeMessage({ authorId: '999', content: '!nep rule sneaky rule' });
  const handled = await admin.handle(message);

  assert.equal(handled, false);
  assert.equal(message.sent.length, 0);
  assert.equal(fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'), 'utf8'), before);
});

test('handle: ignores a message that is not a command', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

  const message = makeMessage({ content: 'just chatting' });
  assert.equal(await admin.handle(message), false);
});

test('handle: rule appends the bullet to prompts/rules.md and reloads prompts', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

  const message = makeMessage({ content: '!nep rule Никогда не спойлерь финал', guild: { id: 'g1' } });
  const handled = await admin.handle(message);

  assert.equal(handled, true);
  const rulesText = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'), 'utf8');
  assert.deepEqual(listRules(rulesText), ['be kind', 'Никогда не спойлерь финал']);
  assert.equal(hot.reloadPromptsCalls, 1);
  assert.ok(message.sent[0].includes('Rule added'));
  assert.deepEqual(message.reactions, ['✅']);
});

test('handle: rules lists the numbered rules; unrule removes one', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

  await admin.handle(makeMessage({ content: '!nep rule second rule' }));
  const listed = makeMessage({ content: '!nep rules' });
  await admin.handle(listed);
  assert.ok(listed.sent[0].includes('1. be kind'));
  assert.ok(listed.sent[0].includes('2. second rule'));

  await admin.handle(makeMessage({ content: '!nep unrule 1' }));
  const rulesText = fs.readFileSync(path.join(rootDir, 'prompts', 'rules.md'), 'utf8');
  assert.deepEqual(listRules(rulesText), ['second rule']);
});

test('handle: set writes an override to config.local.json and reloads config', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

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
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

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
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

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
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

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
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1 } });

  const message = makeMessage({ content: '!nep memory 555', guild: { id: 'g1' } });
  await admin.handle(message);

  assert.ok(message.sent[0].includes('Error'));
  assert.deepEqual(message.reactions, ['❌']);
});

test('handle: status reports model, calibration ratio and the daily request count', async () => {
  const rootDir = makeRoot();
  const hot = makeHot(rootDir);
  const store = makeStore();
  const admin = createAdmin({ hot, store, client: {}, spontaneous: {}, calibrator: { ratio: 1.2 } });

  const message = makeMessage({ content: '!nep status' });
  await admin.handle(message);

  const body = message.sent[0];
  assert.match(body, /anthropic\/claude-opus-4\.6/);
  assert.match(body, /1\.200/);
  assert.match(body, /5 \/ 300/);
});
