// Tests for src/memory/text-limits.js: the memory limits' one home. The fallbacks equal
// config.json, and the self-fact and in-joke limits are the ones the analyzer clamps to. Pure,
// no I/O: config.json and the module's own source are read only to compare with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_LIMIT_DEFAULTS, SELF_CHARS, INJOKE_CHARS } from '../src/memory/text-limits.js';
import { applyMemoryUpdate } from '../src/memory/update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readTracked = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// Where each fallback lives in config.json. A new key of the table names its path here.
const CONFIG_PATHS = {
  fieldChars: ['memory', 'fieldChars'],
  maxDetails: ['memory', 'maxDetails'],
  maxInjokes: ['memory', 'maxInjokes'],
  maxSelfFacts: ['memory', 'maxSelfFacts'],
  maxNewEpisodes: ['memory', 'maxNewEpisodes'],
  maxEpisodes: ['memory', 'maxEpisodes'],
  maxDeltaPerUpdate: ['relationships', 'maxDeltaPerUpdate'],
  historySize: ['relationships', 'historySize'],
  maxInterests: ['memory', 'maxInterests'],
  interestTopicChars: ['memory', 'interestTopicChars'],
  interestNoteChars: ['memory', 'interestNoteChars'],
  loreTextChars: ['lore', 'textChars'],
  maxLearned: ['memory', 'maxLearned'],
  maxLearnedStored: ['memory', 'maxLearnedStored'],
  learnedChars: ['memory', 'learnedChars'],
  learnedHalfLifeDays: ['memory', 'learnedHalfLifeDays'],
  relationshipChars: ['relationships', 'textChars'],
  clampTolerance: ['memory', 'clampTolerance'],
};

test('MEMORY_LIMIT_DEFAULTS: every fallback equals its config.json value', () => {
  const tracked = readTracked();
  assert.deepEqual(Object.keys(MEMORY_LIMIT_DEFAULTS).sort(), Object.keys(CONFIG_PATHS).sort());
  for (const [key, [section, name]] of Object.entries(CONFIG_PATHS)) {
    assert.equal(typeof tracked[section]?.[name], 'number', `config.json has ${section}.${name}`);
    assert.equal(MEMORY_LIMIT_DEFAULTS[key], tracked[section][name], key);
  }
});

test('MEMORY_LIMIT_DEFAULTS: carries the relationship text limit, the delta cap and the clamp tolerance', () => {
  assert.equal(MEMORY_LIMIT_DEFAULTS.relationshipChars, 600);
  assert.equal(MEMORY_LIMIT_DEFAULTS.maxDeltaPerUpdate, 15);
  assert.equal(MEMORY_LIMIT_DEFAULTS.clampTolerance, 1.25);
});

test('MEMORY_LIMIT_DEFAULTS: frozen, so no caller can move a fallback for everyone', () => {
  assert.equal(Object.isFrozen(MEMORY_LIMIT_DEFAULTS), true);
});

test('SELF_CHARS and INJOKE_CHARS: 200 each, the limits the analyzer clamps a self fact and an in-joke to', () => {
  assert.equal(SELF_CHARS, 200);
  assert.equal(INJOKE_CHARS, 200);

  // Measured on the analyzer's own apply, with no tolerance, on texts far over the limit.
  const long = 'é'.repeat(1000);
  const written = {};
  const store = { getUser: () => null, getGuild: () => ({}), updateGuild: (_guildId, fields) => (Object.assign(written, fields), fields) };
  applyMemoryUpdate(store, 'g', { guild: { injokes: [long] }, self: [long] }, { clampTolerance: 1 }, new Set());
  assert.equal([...written.injokes[0]].length, INJOKE_CHARS);
  assert.equal([...written.self[0]].length, SELF_CHARS);
});

// Every way a module loads another one: a static import (with bindings or bare), a dynamic
// import() and a re-export with a source (`export ... from`), which is an import edge too. The
// re-export pattern stops at a `;`, so a declaration followed by a comment that says "from" is
// not one.
const LOADS_A_MODULE = [/^\s*import\b/m, /\bimport\s*\(/, /^\s*export\b[^'";]*?\bfrom\s*['"]/m];

test('text-limits: a leaf module, it imports nothing and re-exports nothing', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'memory', 'text-limits.js'), 'utf8');
  for (const pattern of LOADS_A_MODULE) assert.equal(pattern.test(source), false, String(pattern));
});

test('text-limits: the leaf check sees every form of loading another module', () => {
  const own = 'export const SELF_CHARS = 200;\n';
  const forms = [
    "import { REASON_CHARS } from './affinity.js';",
    "import './update.js';",
    "const voice = await import('./voice.js');",
    "export { REASON_CHARS } from './affinity.js';",
    'export { EPISODE_CHARS } from "./episodes.js";',
    "export * from './update.js';",
    "export * as voice from './voice.js';",
    "export {\n  REASON_CHARS,\n  deltaCapOf,\n} from './affinity.js';",
  ];
  for (const form of forms) {
    assert.equal(LOADS_A_MODULE.some((pattern) => pattern.test(`${own}${form}\n${own}`)), true, form);
  }
  // Its own exports and a comment that says "from" are no import edge.
  const plain = [
    '// taken from the table in config.json',
    own.trim(),
    '// the limit comes from "config.json"',
    'export function from() {}',
    'export const LIMITS = Object.freeze({ from: 1 });',
    '',
  ].join('\n');
  assert.equal(LOADS_A_MODULE.some((pattern) => pattern.test(plain)), false);
});
