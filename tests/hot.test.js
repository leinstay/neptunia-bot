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
    prompts: { persona: 'Είσαι η Ζωή.', rules: '## Κανόνες\n- να είσαι ο εαυτός σου' },
  });
  const hot = createHot({ rootDir: dir });
  try {
    assert.deepEqual(hot.config, { bot: { timezone: 'Europe/Moscow' } });
    assert.equal(hot.prompts.persona, 'Είσαι η Ζωή.');
    assert.ok(hot.prompts.rules.includes('## Κανόνες'));
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

// ---------------------------------------------------------------------------
// Two prompt layers: prompts/ (base, tracked) + prompts.local/ (untracked)
// ---------------------------------------------------------------------------

function writeLocalPrompt(dir, name, text) {
  const localDir = path.join(dir, 'prompts.local');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, `${name}.md`), text);
}

function writeLabels(dir, layer, value) {
  const target = layer === 'base' ? path.join(dir, 'prompts') : path.join(dir, 'prompts.local');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'labels.json'), value);
}

test('createHot: exposes promptsDir and localPromptsDir', () => {
  const dir = makeRoot();
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.promptsDir, path.join(dir, 'prompts'));
    assert.equal(hot.localPromptsDir, path.join(dir, 'prompts.local'));
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a prompts.local file replaces the base file of the same name', () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  writeLocalPrompt(dir, 'rules', 'local text');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.rules, 'local text');
    assert.equal(hot.promptSources.rules, 'local');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: an empty local file falls back to the base text', () => {
  const dir = makeRoot({ prompts: { persona: 'base text' } });
  writeLocalPrompt(dir, 'persona', '   \n  ');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.persona, 'base text');
    assert.equal(hot.promptSources.persona, 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: a base-only file is reported with source "base"', () => {
  const dir = makeRoot({ prompts: { persona: 'base text' } });
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.promptSources.persona, 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: deleting a local file falls back to the base text', () => {
  const dir = makeRoot({ prompts: { rules: 'base text' } });
  writeLocalPrompt(dir, 'rules', 'local text');
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.rules, 'local text');
    fs.rmSync(path.join(dir, 'prompts.local', 'rules.md'));
    const ok = hot.reloadPrompts();
    assert.equal(ok, true);
    assert.equal(hot.prompts.rules, 'base text');
    assert.equal(hot.promptSources.rules, 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: deleting a base file with no local counterpart drops the key', () => {
  const dir = makeRoot({ prompts: { persona: 'a', rules: 'b' } });
  const hot = createHot({ rootDir: dir });
  try {
    fs.rmSync(path.join(dir, 'prompts', 'persona.md'));
    hot.reloadPrompts();
    assert.equal(hot.prompts.persona, undefined);
    assert.equal(hot.promptSources.persona, undefined);
    assert.equal(hot.prompts.rules, 'b');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: labels.json deep-merges the local layer over the base one, source "merged"', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', JSON.stringify({ locale: 'en-US', self: '{name} (you)' }));
  writeLabels(dir, 'local', JSON.stringify({ locale: 'ru-RU' }));
  const hot = createHot({ rootDir: dir });
  try {
    assert.equal(hot.prompts.labels.locale, 'ru-RU');
    assert.equal(hot.prompts.labels.self, '{name} (you)');
    assert.equal(hot.promptSources.labels, 'merged');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: missing base labels default to {} with source "base" when there is no local file', () => {
  const dir = makeRoot();
  const hot = createHot({ rootDir: dir });
  try {
    assert.deepEqual(hot.prompts.labels, {});
    assert.equal(hot.promptSources.labels, 'base');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: invalid base labels.json throws on the initial load', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', '{ not valid json');
  try {
    assert.throws(() => createHot({ rootDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createHot: invalid local labels.json throws on the initial load too', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', JSON.stringify({ locale: 'en-US' }));
  writeLabels(dir, 'local', '{ not valid json');
  try {
    assert.throws(() => createHot({ rootDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: invalid local labels.json on reload keeps the previous labels and still returns true', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', JSON.stringify({ locale: 'en-US' }));
  const hot = createHot({ rootDir: dir });
  try {
    writeLabels(dir, 'local', '{ not valid json');
    fs.writeFileSync(path.join(dir, 'prompts', 'persona.md'), 'unrelated update'); // rest of the reload still applies
    const ok = hot.reloadPrompts();
    assert.equal(ok, true);
    assert.deepEqual(hot.prompts.labels, { locale: 'en-US' });
    assert.equal(hot.promptSources.labels, 'base');
    assert.equal(hot.prompts.persona, 'unrelated update');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadPrompts: invalid base labels.json on reload keeps the previous merged labels', () => {
  const dir = makeRoot();
  writeLabels(dir, 'base', JSON.stringify({ locale: 'en-US' }));
  writeLabels(dir, 'local', JSON.stringify({ locale: 'ru-RU' }));
  const hot = createHot({ rootDir: dir });
  try {
    writeLabels(dir, 'base', '{ broken');
    const ok = hot.reloadPrompts();
    assert.equal(ok, true);
    assert.deepEqual(hot.prompts.labels, { locale: 'ru-RU' });
    assert.equal(hot.promptSources.labels, 'merged');
  } finally {
    hot.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
