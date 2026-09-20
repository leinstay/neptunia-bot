// Tests for src/hot.js: the live config/prompts view. Never depends on
// fs.watch timing -- reload methods are called directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHot } from '../src/hot.js';

function makeRoot({ config = { bot: { timezone: 'UTC' } }, prompts = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-hot-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(dir, 'prompts'));
  for (const [name, text] of Object.entries(prompts)) {
    fs.writeFileSync(path.join(dir, 'prompts', `${name}.md`), text);
  }
  return dir;
}

test('createHot: loads config and prompts from the given root at creation', () => {
  const dir = makeRoot({
    config: { bot: { timezone: 'Europe/Moscow' } },
    prompts: { persona: 'Ты Непка.', rules: '## Правила\n- будь собой' },
  });
  const hot = createHot({ rootDir: dir });
  try {
    assert.deepEqual(hot.config, { bot: { timezone: 'Europe/Moscow' } });
    assert.equal(hot.prompts.persona, 'Ты Непка.');
    assert.ok(hot.prompts.rules.includes('## Правила'));
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadConfig: picks up a valid change', () => {
  const dir = makeRoot({ config: { a: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: 2 }));
    const ok = hot.reloadConfig();
    assert.equal(ok, true);
    assert.deepEqual(hot.config, { a: 2 });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadConfig: keeps the previous config on invalid JSON and returns false', () => {
  const dir = makeRoot({ config: { a: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
    const ok = hot.reloadConfig();
    assert.equal(ok, false);
    assert.deepEqual(hot.config, { a: 1 });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadConfig: config.local.json is merged in on reload too', () => {
  const dir = makeRoot({ config: { a: 1, b: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ b: 2 }));
    hot.reloadConfig();
    assert.deepEqual(hot.config, { a: 1, b: 2 });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: picks up new content', () => {
  const dir = makeRoot({ prompts: { persona: 'old text' } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'new text');
    const ok = hot.reloadPrompts();
    assert.equal(ok, true);
    assert.equal(hot.prompts.persona, 'new text');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: keeps the previous text when a file becomes empty', () => {
  const dir = makeRoot({ prompts: { persona: 'important text', rules: 'other text' } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), ''); // editor truncated it mid-save
    fs.writeFileSync(path.join(dir, 'prompts', 'rules.md'), 'updated other text');
    hot.reloadPrompts();
    assert.equal(hot.prompts.persona, 'important text'); // kept
    assert.equal(hot.prompts.rules, 'updated other text'); // still updates normally
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: emits "change" with what:"config" after reloadConfig', () => {
  const dir = makeRoot({ config: { a: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    let seen = null;
    hot.on('change', (payload) => { seen = payload; });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ a: 2 }));
    hot.reloadConfig();
    assert.deepEqual(seen, { what: 'config' });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: emits "change" with what:"prompts" after reloadPrompts', () => {
  const dir = makeRoot({ prompts: { persona: 'a' } });
  const hot = createHot({ rootDir: dir });
  try {
    let seen = null;
    hot.on('change', (payload) => { seen = payload; });
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'b');
    hot.reloadPrompts();
    assert.deepEqual(seen, { what: 'prompts' });
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: does not emit "change" when reloadConfig fails', () => {
  const dir = makeRoot({ config: { a: 1 } });
  const hot = createHot({ rootDir: dir });
  try {
    let emitted = false;
    hot.on('change', () => { emitted = true; });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ bad json');
    hot.reloadConfig();
    assert.equal(emitted, false);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readPrompts: strips a UTF-8 BOM and normalizes CRLF to LF, trimming edges', () => {
  const dir = makeRoot();
  fs.writeFileSync(path.join(dir, 'prompts', 'format.md'), '﻿  line one\r\nline two  \r\n');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.format, 'line one\nline two');
    assert.ok(!hot.prompts.format.includes('﻿'));
    assert.ok(!hot.prompts.format.includes('\r'));
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: non-.md files in prompts/ are ignored', () => {
  const dir = makeRoot({ prompts: { persona: 'a' } });
  fs.writeFileSync(path.join(dir, 'prompts', 'README.txt'), 'not a prompt');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.README, undefined);
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hot.watch() and hot.close() do not throw and close() is idempotent', () => {
  const dir = makeRoot({ prompts: { persona: 'a' } });
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.watch(), hot);
    hot.close();
    assert.doesNotThrow(() => hot.close());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
