// Tests for src/config.js: the .env parser, config reader and deepMerge helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, applyEnv, deepMerge, readConfig, need, isPlainObject } from '../src/config.js';
import { roomQuestionChance } from '../src/behavior/spontaneous.js';
import { RECALL_DEFAULTS, recallSettings } from '../src/behavior/recall.js';
import { paceSettings } from '../src/behavior/turn.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-'));
}

test('parseEnv: skips blank lines and full-line comments', () => {
  const parsed = parseEnv('\n# a comment\n\nFOO=bar\n');
  assert.deepEqual(parsed, { FOO: 'bar' });
});

test('parseEnv: unquoted value with a trailing " #" comment is trimmed', () => {
  const parsed = parseEnv('FOO=bar   # trailing comment');
  assert.equal(parsed.FOO, 'bar');
});

test('parseEnv: "#" without a leading space is NOT treated as a comment', () => {
  const parsed = parseEnv('FOO=bar#not-a-comment');
  assert.equal(parsed.FOO, 'bar#not-a-comment');
});

test('parseEnv: only the first "=" splits key from value, so values may contain "="', () => {
  const parsed = parseEnv('FOO=a=b=c');
  assert.equal(parsed.FOO, 'a=b=c');
});

test('parseEnv: double-quoted values decode \\n, \\r and \\"', () => {
  const parsed = parseEnv('FOO="line1\\nline2\\r\\"quoted\\""');
  assert.equal(parsed.FOO, 'line1\nline2\r"quoted"');
});

test('parseEnv: single-quoted values are taken literally (no escape decoding)', () => {
  const parsed = parseEnv("FOO='a\\nb'");
  assert.equal(parsed.FOO, 'a\\nb');
});

test('parseEnv: invalid keys (leading digit, dash, dot) are ignored', () => {
  const parsed = parseEnv('9FOO=bar\nFOO-BAR=baz\nFOO.BAR=qux\nOK_1=fine');
  assert.deepEqual(parsed, { OK_1: 'fine' });
});

test('parseEnv: key and value are trimmed of surrounding whitespace', () => {
  const parsed = parseEnv('  FOO  =  bar  ');
  assert.equal(parsed.FOO, 'bar');
});

test('applyEnv: real environment variables always win over parsed ones', () => {
  const target = { FOO: 'real' };
  applyEnv({ FOO: 'from-dotenv', BAR: 'from-dotenv' }, target);
  assert.equal(target.FOO, 'real');
  assert.equal(target.BAR, 'from-dotenv');
});

test('isPlainObject: true for objects, false for null, arrays, scalars and functions', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(undefined), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject('x'), false);
  assert.equal(isPlainObject(0), false);
  assert.equal(isPlainObject(() => {}), false);
});

test('deepMerge: arrays in override fully replace arrays in base', () => {
  const merged = deepMerge({ list: [1, 2, 3] }, { list: [9] });
  assert.deepEqual(merged.list, [9]);
});

test('deepMerge: nested objects merge key by key, recursively', () => {
  const base = { a: { x: 1, y: 2 }, b: 1 };
  const override = { a: { y: 20, z: 3 } };
  const merged = deepMerge(base, override);
  assert.deepEqual(merged, { a: { x: 1, y: 20, z: 3 }, b: 1 });
});

test('deepMerge: an explicit undefined in override keeps the base value', () => {
  const merged = deepMerge({ a: 1 }, { a: undefined });
  assert.equal(merged.a, 1);
});

test('deepMerge: scalar override replaces a nested object outright', () => {
  const merged = deepMerge({ a: { x: 1 } }, { a: 5 });
  assert.equal(merged.a, 5);
});

test('deepMerge: does not mutate the base object', () => {
  const base = { a: { x: 1 } };
  deepMerge(base, { a: { x: 2 } });
  assert.equal(base.a.x, 1);
});

test('readConfig: an empty config.local.json is treated as no override', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ bot: { timezone: 'UTC' } }));
    fs.writeFileSync(path.join(dir, 'config.local.json'), '   \n  ');
    const cfg = readConfig(dir);
    assert.deepEqual(cfg, { bot: { timezone: 'UTC' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: config.local.json is deep-merged over config.json', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ bot: { timezone: 'UTC', owners: [] }, llm: { model: 'a' } }),
    );
    fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ bot: { owners: ['1'] } }));
    const cfg = readConfig(dir);
    assert.deepEqual(cfg, { bot: { timezone: 'UTC', owners: ['1'] }, llm: { model: 'a' } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readConfig: invalid JSON in config.json throws', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
    assert.throws(() => readConfig(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('need: throws an Error whose message is exactly the key when unset', () => {
  delete process.env.NEP_TEST_MISSING;
  assert.throws(() => need('NEP_TEST_MISSING'), (err) => err instanceof Error && err.message === 'NEP_TEST_MISSING');
});

test('need: throws when the value is an empty string', () => {
  process.env.NEP_TEST_EMPTY = '';
  try {
    assert.throws(() => need('NEP_TEST_EMPTY'), (err) => err.message === 'NEP_TEST_EMPTY');
  } finally {
    delete process.env.NEP_TEST_EMPTY;
  }
});

test('config.json: the code fallback of spontaneous.roomQuestionChance is the shipped value', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shipped = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(roomQuestionChance({}), shipped.spontaneous.roomQuestionChance);
});

test('config.json: the code fallbacks of the recall group are the shipped values', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shipped = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.deepEqual(recallSettings({}), shipped.recall);
  assert.deepEqual({ ...RECALL_DEFAULTS }, shipped.recall);
});

test('config.json: the code fallbacks of the pace group are the shipped values', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shipped = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.deepEqual(paceSettings({}), shipped.pace);
});

test('config.json: the pause notice fallbacks are the shipped values', async () => {
  const { pauseNoticeMinutes } = await import('../src/behavior/limits.js');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shipped = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(pauseNoticeMinutes({}), shipped.mention.pauseNoticeMinutes);
  assert.equal(shipped.features.pauseNotice, true, 'a missing features.pauseNotice counts as on, like the shipped value');
});

test('config.json: the recall budget fallbacks (forms, clusters, run limit, summary minimum) are the shipped values', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shipped = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  for (const key of ['maxForms', 'maxClusters', 'timeoutMs', 'minSummaryMs']) {
    assert.equal(recallSettings({ recall: {} })[key], shipped.recall[key], key);
  }
});
