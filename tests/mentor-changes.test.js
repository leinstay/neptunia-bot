// Tests for src/mentor/changes.js: the mentor's applied edits to the private
// layer (local prompt files and stored memory), their before/after records,
// undo with conflict detection, and the rebase of local prompt overrides.
// Temp directories for data and both prompt layers; a fake memory store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChangeStore, profileGuard } from '../src/mentor/changes.js';
import { applyDetailOps } from '../src/memory/details.js';

const RULES = '# Rules\n\n- Keep replies short.\n- Never use lists.\n';
const FORMAT = 'Write plain text.\n\nOne message per line.\n';
const MEMORY_CONFIG = { maxLearned: 20, maxLearnedStored: 60, learnedChars: 160, learnedHalfLifeDays: 720, confirmGapHours: 12, clampTolerance: 1.25 };

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function allFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(allFiles(full));
    else out.push(full);
  }
  return out.sort();
}

/** Every file under `dir` with its bytes, for byte-identity checks. */
function snapshot(dir) {
  return allFiles(dir).map((file) => [path.relative(dir, file), fs.readFileSync(file).toString('base64')]);
}

/** A fake memory store: holds one guild and some profiles, records every call. */
function fakeStore({ guild = {}, users = {} } = {}) {
  const calls = [];
  const guilds = {};
  const profiles = {};
  const ensureGuild = (id) => (guilds[id] ??= {
    patterns: '', starters: '', injokes: [], self: [], learned: [], learnedNextId: 1, updatedAt: null, ...structuredClone(guild),
  });
  return {
    calls,
    getGuild(guildId) {
      calls.push(['getGuild', guildId]);
      return ensureGuild(guildId);
    },
    updateGuild(guildId, fields) {
      calls.push(['updateGuild', guildId, structuredClone(fields)]);
      const { learned, learnedNextId, ...safe } = fields ?? {};
      return Object.assign(ensureGuild(guildId), safe);
    },
    applyLearnedOps(guildId, ops, opts = {}) {
      calls.push(['applyLearnedOps', guildId, structuredClone(ops), { ...opts }]);
      const g = ensureGuild(guildId);
      const { items, nextId } = applyDetailOps(g.learned, ops, {
        maxDetails: opts.maxLearned,
        maxDetailsStored: opts.maxLearnedStored,
        fieldChars: opts.learnedChars,
        halfLifeDays: opts.learnedHalfLifeDays,
        confirmGapHours: opts.confirmGapHours,
        clampTolerance: opts.clampTolerance,
        seenAt: opts.seenAt,
        nextId: g.learnedNextId,
      });
      g.learned = items;
      g.learnedNextId = nextId;
      return g.learned;
    },
    rewriteLearned(guildId, id, text) {
      calls.push(['rewriteLearned', guildId, id, text]);
      const g = ensureGuild(guildId);
      const clean = typeof text === 'string' ? text.trim() : '';
      const item = g.learned.find((i) => i.id === id);
      if (!clean || !item || g.learned.some((i) => i !== item && i.text === clean)) return null;
      item.text = clean;
      return item;
    },
    getUser(guildId, userId) {
      calls.push(['getUser', guildId, userId]);
      return profiles[`${guildId}/${userId}`] ?? (users[userId] ? (profiles[`${guildId}/${userId}`] = structuredClone(users[userId])) : null);
    },
    updateUser(guildId, userId, fields) {
      calls.push(['updateUser', guildId, userId, structuredClone(fields)]);
      const key = `${guildId}/${userId}`;
      profiles[key] ??= structuredClone(users[userId] ?? { id: userId });
      return Object.assign(profiles[key], fields);
    },
  };
}

/** Temp directories and a change store over them; `tracked` seeds the tracked prompts. */
function setup({ tracked = { 'rules.md': RULES, 'format.md': FORMAT }, local = {}, store = fakeStore(), now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-changes-'));
  const dataDir = path.join(root, 'data');
  const promptsDir = path.join(root, 'prompts');
  const localPromptsDir = path.join(root, 'prompts.local');
  fs.mkdirSync(promptsDir, { recursive: true });
  for (const [name, text] of Object.entries(tracked)) fs.writeFileSync(path.join(promptsDir, name), text);
  if (Object.keys(local).length) {
    fs.mkdirSync(localPromptsDir, { recursive: true });
    for (const [name, text] of Object.entries(local)) fs.writeFileSync(path.join(localPromptsDir, name), text);
  }
  let t = 1000;
  const changes = createChangeStore({
    dataDir, promptsDir, localPromptsDir, store,
    getConfig: () => ({ memory: MEMORY_CONFIG }),
    now: now ?? (() => (t += 1000)),
  });
  const trackedBefore = snapshot(promptsDir);
  return {
    root, dataDir, promptsDir, localPromptsDir, store, changes,
    local: (name) => fs.readFileSync(path.join(localPromptsDir, name), 'utf8'),
    hasLocal: (name) => fs.existsSync(path.join(localPromptsDir, name)),
    overrides: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'mentor', 'overrides.json'), 'utf8')),
    assertTrackedUntouched: () => assert.deepEqual(snapshot(promptsDir), trackedBefore),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const META = { caseId: 3, runId: '1700' };

test('apply rules: creates the local file from the tracked one, replaces the text and records the change', () => {
  const env = setup();
  try {
    const result = env.changes.apply('g1', { layer: 'rules', target: 'rules', from: 'Never use lists.', to: 'Avoid lists.', why: 'x' }, META);
    assert.equal(result.ok, true);
    assert.equal(env.local('rules.md'), '# Rules\n\n- Keep replies short.\n- Avoid lists.\n');
    env.assertTrackedUntouched();
    // Atomic write: nothing but the final file is left in the local directory.
    assert.deepEqual(fs.readdirSync(env.localPromptsDir), ['rules.md']);
    const change = result.change;
    assert.equal(change.id, 1);
    assert.equal(change.caseId, 3);
    assert.equal(change.runId, '1700');
    assert.equal(change.layer, 'rules');
    assert.equal(change.at, new Date(2000).toISOString());
    assert.equal(change.before, RULES);
    assert.equal(change.after, env.local('rules.md'));
    assert.equal(change.summary, 'rules rules: Never use lists. -> Avoid lists.');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    const listed = env.changes.list('g1');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 1);
    const mentorDir = path.join(env.dataDir, 'guilds', 'g1', 'mentor');
    assert.equal(JSON.parse(fs.readFileSync(path.join(mentorDir, 'changes', '1', 'before.json'), 'utf8')), RULES);
    assert.equal(JSON.parse(fs.readFileSync(path.join(mentorDir, 'changes', '1', 'after.json'), 'utf8')), change.after);
    assert.equal(JSON.parse(fs.readFileSync(path.join(mentorDir, 'changes.json'), 'utf8')).nextId, 2);
  } finally {
    env.cleanup();
  }
});

test('apply rules: edits the existing local file, not the tracked one', () => {
  const env = setup({ local: { 'rules.md': '- Local rule one.\n' } });
  try {
    const result = env.changes.apply('g1', { layer: 'rules', from: 'one', to: 'two' }, META);
    assert.equal(result.ok, true);
    assert.equal(env.local('rules.md'), '- Local rule two.\n');
    assert.equal(result.change.before, '- Local rule one.\n');
    env.assertTrackedUntouched();
  } finally {
    env.cleanup();
  }
});

test('apply: refuses text that is not found, writes and records nothing', () => {
  const env = setup();
  try {
    const result = env.changes.apply('g1', { layer: 'rules', from: 'Absent sentence.', to: 'x' }, META);
    assert.deepEqual(result, { ok: false, reason: 'text not found' });
    assert.equal(env.hasLocal('rules.md'), false);
    assert.deepEqual(env.changes.list('g1'), []);
    env.assertTrackedUntouched();
  } finally {
    env.cleanup();
  }
});

test('apply: refuses the card and missing layers, unknown layers and unsafe prompt names', () => {
  const env = setup({ tracked: { 'rules.md': RULES, 'format.md': FORMAT, 'character-card.md': 'A card.\n' } });
  try {
    for (const edit of [
      { layer: 'card', from: 'A card.', to: 'B' },
      { layer: 'missing', from: 'x', to: 'y' },
      { layer: 'weird', from: 'x', to: 'y' },
      { layer: 'prompt', target: 'character-card', from: 'A card.', to: 'B' },
      { layer: 'prompt', target: '../prompts/format', from: 'Write', to: 'B' },
      { layer: 'prompt', target: 'no-such-prompt', from: 'Write', to: 'B' },
    ]) {
      const result = env.changes.apply('g1', edit, META);
      assert.equal(result.ok, false, JSON.stringify(edit));
      assert.equal(typeof result.reason, 'string');
    }
    assert.deepEqual(env.changes.list('g1'), []);
    assert.equal(fs.existsSync(env.localPromptsDir), false);
    env.assertTrackedUntouched();
  } finally {
    env.cleanup();
  }
});

test('apply prompt: creates the override from the tracked file with its base hash and records the patch', () => {
  const env = setup();
  try {
    const result = env.changes.apply('g1', { layer: 'prompt', target: 'format', from: 'plain text', to: 'lowercase text' }, META);
    assert.equal(result.ok, true);
    assert.equal(env.local('format.md'), 'Write lowercase text.\n\nOne message per line.\n');
    assert.equal(result.change.baseHash, sha256(FORMAT));
    assert.equal(result.change.target, 'format');
    assert.deepEqual(env.overrides(), {
      format: { baseHash: sha256(FORMAT), patches: [{ changeId: 1, from: 'plain text', to: 'lowercase text' }] },
    });
    env.assertTrackedUntouched();
    assert.deepEqual(fs.readdirSync(env.localPromptsDir), ['format.md']);
  } finally {
    env.cleanup();
  }
});

test('apply prompt: an empty from appends the text as a new paragraph', () => {
  const env = setup();
  try {
    const result = env.changes.apply('g1', { layer: 'prompt', target: 'format', from: '', to: 'Keep it brief.' }, META);
    assert.equal(result.ok, true);
    assert.equal(env.local('format.md'), 'Write plain text.\n\nOne message per line.\n\nKeep it brief.\n');
  } finally {
    env.cleanup();
  }
});

test('undo: restores a prompt the change created by removing the override', () => {
  const env = setup();
  try {
    env.changes.apply('g1', { layer: 'prompt', target: 'format', from: 'plain text', to: 'lowercase text' }, META);
    const result = env.changes.undo('g1', 1);
    assert.equal(result.ok, true);
    assert.equal(env.hasLocal('format.md'), false);
    assert.deepEqual(env.overrides(), {});
    assert.equal(env.changes.list('g1')[0].undoneAt, new Date(3000).toISOString());
    assert.deepEqual(env.changes.undo('g1', 1), { ok: false, reason: 'already undone' });
    assert.deepEqual(env.changes.undo('g1', 99), { ok: false, reason: 'unknown change' });
    env.assertTrackedUntouched();
  } finally {
    env.cleanup();
  }
});

test('undo: restores the rules text that was there before', () => {
  const env = setup({ local: { 'rules.md': '- Local rule one.\n' } });
  try {
    env.changes.apply('g1', { layer: 'rules', from: 'one', to: 'two' }, META);
    assert.equal(env.changes.undo('g1', 1).ok, true);
    assert.equal(env.local('rules.md'), '- Local rule one.\n');
  } finally {
    env.cleanup();
  }
});

test('undo: refuses after a later change to the same piece, then works newest first', () => {
  const env = setup();
  try {
    env.changes.apply('g1', { layer: 'prompt', target: 'format', from: 'plain text', to: 'lowercase text' }, META);
    env.changes.apply('g1', { layer: 'prompt', target: 'format', from: 'One message', to: 'A message' }, META);
    assert.deepEqual(env.changes.undo('g1', 1), { ok: false, reason: 'changed since' });
    assert.equal(env.local('format.md'), 'Write lowercase text.\n\nA message per line.\n');
    assert.equal(env.changes.undo('g1', 2).ok, true);
    assert.equal(env.local('format.md'), 'Write lowercase text.\n\nOne message per line.\n');
    assert.deepEqual(env.overrides().format.patches.map((p) => p.changeId), [1]);
    assert.equal(env.changes.undo('g1', 1).ok, true);
    assert.equal(env.hasLocal('format.md'), false);
  } finally {
    env.cleanup();
  }
});

test('undo: refuses when the file was edited by hand since', () => {
  const env = setup();
  try {
    env.changes.apply('g1', { layer: 'rules', from: 'Never use lists.', to: 'Avoid lists.' }, META);
    fs.writeFileSync(path.join(env.localPromptsDir, 'rules.md'), '- Hand edit.\n');
    assert.deepEqual(env.changes.undo('g1', 1), { ok: false, reason: 'changed since' });
    assert.equal(env.local('rules.md'), '- Hand edit.\n');
  } finally {
    env.cleanup();
  }
});

test('list: newest first, get returns the pieces', () => {
  const env = setup();
  try {
    env.changes.apply('g1', { layer: 'rules', from: 'Never use lists.', to: 'Avoid lists.' }, META);
    env.changes.apply('g1', { layer: 'prompt', target: 'format', from: 'plain', to: 'simple' }, { caseId: 4, runId: '1800' });
    assert.deepEqual(env.changes.list('g1').map((c) => c.id), [2, 1]);
    assert.equal(env.changes.list('g1')[0].before, undefined);
    const got = env.changes.get('g1', 2);
    assert.equal(got.before, FORMAT);
    assert.equal(got.after, 'Write simple text.\n\nOne message per line.\n');
    assert.equal(env.changes.get('g1', 7), null);
  } finally {
    env.cleanup();
  }
});

test('changes.json: broken JSON throws instead of starting over', () => {
  const env = setup();
  try {
    const file = path.join(env.dataDir, 'guilds', 'g1', 'mentor', 'changes.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ broken');
    assert.throws(() => env.changes.list('g1'), /broken JSON/);
    assert.throws(() => env.changes.apply('g1', { layer: 'rules', from: 'Never use lists.', to: 'x' }, META), /broken JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  } finally {
    env.cleanup();
  }
});

test('apply self: rewrites one item through updateGuild, deletes on an empty to, undo restores in place', () => {
  const store = fakeStore({ guild: { self: ['Likes rainy days.', 'Speaks fast.', 'Hates mornings.'] } });
  const env = setup({ store });
  try {
    const first = env.changes.apply('g1', { layer: 'self', target: 'whatever', from: '  Speaks fast. ', to: 'Speaks slowly.' }, META);
    assert.equal(first.ok, true);
    assert.deepEqual(store.getGuild('g1').self, ['Likes rainy days.', 'Speaks slowly.', 'Hates mornings.']);
    assert.equal(first.change.before, 'Speaks fast.');
    assert.equal(first.change.after, 'Speaks slowly.');
    assert.equal(first.change.summary, 'self: Speaks fast. -> Speaks slowly.');
    const second = env.changes.apply('g1', { layer: 'self', from: 'Likes rainy days.', to: '' }, META);
    assert.equal(second.ok, true);
    assert.equal(second.change.after, null);
    assert.deepEqual(store.getGuild('g1').self, ['Speaks slowly.', 'Hates mornings.']);
    assert.ok(store.calls.some((c) => c[0] === 'updateGuild' && Array.isArray(c[2].self)));
    assert.equal(env.changes.undo('g1', 2).ok, true);
    assert.deepEqual(store.getGuild('g1').self, ['Likes rainy days.', 'Speaks slowly.', 'Hates mornings.']);
    assert.equal(env.changes.undo('g1', 1).ok, true);
    assert.deepEqual(store.getGuild('g1').self, ['Likes rainy days.', 'Speaks fast.', 'Hates mornings.']);
    assert.deepEqual(env.changes.apply('g1', { layer: 'self', from: 'Not there.', to: 'x' }, META), { ok: false, reason: 'text not found' });
    env.assertTrackedUntouched();
  } finally {
    env.cleanup();
  }
});

test('undo self: refuses when the item changed since', () => {
  const store = fakeStore({ guild: { self: ['Speaks fast.'] } });
  const env = setup({ store });
  try {
    env.changes.apply('g1', { layer: 'self', from: 'Speaks fast.', to: 'Speaks slowly.' }, META);
    store.updateGuild('g1', { self: ['Speaks in rhymes.'] });
    assert.deepEqual(env.changes.undo('g1', 1), { ok: false, reason: 'changed since' });
    assert.deepEqual(store.getGuild('g1').self, ['Speaks in rhymes.']);
  } finally {
    env.cleanup();
  }
});

test('apply learned: rewrites in place through rewriteLearned, keeping id, teacher, weight and dates', () => {
  const learned = [
    { id: 1, text: 'The server cat is called Zoé.', weight: 3, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-02-01T00:00:00.000Z', from: '<@111>' },
    { id: 2, text: 'Fridays are movie nights.', weight: 1, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
  ];
  const store = fakeStore({ guild: { learned, learnedNextId: 3 } });
  const env = setup({ store });
  try {
    const result = env.changes.apply('g1', { layer: 'learned', from: 'The server cat is called Zoé.', to: 'The server cat is called Zoé, a tabby.' }, META);
    assert.equal(result.ok, true);
    assert.deepEqual(store.getGuild('g1').learned[0], { ...learned[0], text: 'The server cat is called Zoé, a tabby.' });
    assert.equal(store.getGuild('g1').learnedNextId, 3);
    assert.ok(!store.calls.some((c) => c[0] === 'updateGuild' || c[0] === 'applyLearnedOps'));
    assert.ok(store.calls.some((c) => c[0] === 'rewriteLearned' && c[2] === 1));
    assert.equal(result.change.itemId, 1);
    assert.equal(result.change.before, 'The server cat is called Zoé.');
    assert.equal(result.change.after, 'The server cat is called Zoé, a tabby.');
    assert.equal(env.changes.undo('g1', 1).ok, true);
    assert.deepEqual(store.getGuild('g1').learned, learned);
    assert.equal(env.changes.list('g1')[0].readded, undefined);
  } finally {
    env.cleanup();
  }
});

test('apply learned: refuses a rewrite onto another item\'s text; undo refuses once the item changed', () => {
  const learned = [
    { id: 1, text: 'a fact', weight: 2, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
    { id: 2, text: 'b fact', weight: 1, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
  ];
  const store = fakeStore({ guild: { learned, learnedNextId: 3 } });
  const env = setup({ store });
  try {
    assert.deepEqual(env.changes.apply('g1', { layer: 'learned', from: 'a fact', to: 'b fact' }, META), { ok: false, reason: 'duplicate item' });
    assert.deepEqual(store.getGuild('g1').learned, learned);
    assert.equal(env.changes.apply('g1', { layer: 'learned', from: 'a fact', to: 'c fact' }, META).ok, true);
    store.rewriteLearned('g1', 1, 'd fact');
    assert.deepEqual(env.changes.undo('g1', 1), { ok: false, reason: 'changed since' });
    assert.equal(store.getGuild('g1').learned[0].text, 'd fact');
  } finally {
    env.cleanup();
  }
});

test('apply learned: a rewrite differing only in case keeps the item; an empty to removes it and undo re-adds it', () => {
  const learned = [{ id: 1, text: 'fridays are movie nights.', weight: 3, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', from: '<@111>' }];
  const store = fakeStore({ guild: { learned, learnedNextId: 2 } });
  const env = setup({ store });
  try {
    assert.equal(env.changes.apply('g1', { layer: 'learned', from: 'fridays are movie nights.', to: 'Fridays are movie nights.' }, META).ok, true);
    assert.deepEqual(store.getGuild('g1').learned.map((i) => [i.id, i.text, i.weight]), [[1, 'Fridays are movie nights.', 3]]);
    const removed = env.changes.apply('g1', { layer: 'learned', from: 'Fridays are movie nights.', to: '' }, META);
    assert.equal(removed.ok, true);
    assert.equal(removed.change.after, null);
    assert.deepEqual(store.getGuild('g1').learned, []);
    const removeCall = store.calls.find((c) => c[0] === 'applyLearnedOps');
    assert.deepEqual(removeCall[2], { remove: [1] });
    assert.equal(removeCall[3].learnedChars, 160);
    assert.equal(env.changes.undo('g1', 2).ok, true);
    const [back] = store.getGuild('g1').learned;
    assert.equal(back.text, 'Fridays are movie nights.');
    assert.equal(back.from, '<@111>');
    assert.equal(back.id, 2);
    assert.equal(env.changes.list('g1').find((c) => c.id === 2).readded, true);
  } finally {
    env.cleanup();
  }
});

test('apply guild: patterns and starters are strings, injokes are items, other targets refused', () => {
  const store = fakeStore({ guild: { patterns: 'People post memes at night.', starters: 'Someone asks about games.', injokes: ['The broken chair.', 'Tuesday soup.'] } });
  const env = setup({ store });
  try {
    assert.equal(env.changes.apply('g1', { layer: 'guild', target: 'patterns', from: 'at night', to: 'after midnight' }, META).ok, true);
    assert.equal(store.getGuild('g1').patterns, 'People post memes after midnight.');
    const inj = env.changes.apply('g1', { layer: 'guild', target: 'injokes', from: 'Tuesday soup.', to: '' }, META);
    assert.equal(inj.ok, true);
    assert.deepEqual(store.getGuild('g1').injokes, ['The broken chair.']);
    assert.equal(env.changes.apply('g1', { layer: 'guild', target: 'learned', from: 'x', to: 'y' }, META).ok, false);
    assert.equal(env.changes.undo('g1', 1).ok, true);
    assert.equal(store.getGuild('g1').patterns, 'People post memes at night.');
    assert.equal(env.changes.undo('g1', 2).ok, true);
    assert.deepEqual(store.getGuild('g1').injokes, ['The broken chair.', 'Tuesday soup.']);
  } finally {
    env.cleanup();
  }
});

test('apply profile: replaces inside the field through updateUser, guarded', () => {
  const store = fakeStore({ users: { 42: { id: '42', character: 'Calm. Plays chess with Andrés on Sundays since 2019.', style: 'Short lines.', relationship: '' } } });
  const env = setup({ store });
  try {
    const ok = env.changes.apply('g1', { layer: 'profile', target: '42.character', from: 'Calm.', to: 'Calm and patient.' }, META);
    assert.equal(ok.ok, true);
    assert.equal(store.getUser('g1', '42').character, 'Calm and patient. Plays chess with Andrés on Sundays since 2019.');
    assert.ok(store.calls.some((c) => c[0] === 'updateUser' && c[2] === '42' && Object.keys(c[3]).join() === 'character'));
    assert.equal(ok.change.before, 'Calm. Plays chess with Andrés on Sundays since 2019.');
    const guarded = env.changes.apply('g1', { layer: 'profile', target: '42.character', from: 'since 2019', to: 'for years' }, META);
    assert.equal(guarded.ok, false);
    assert.equal(store.getUser('g1', '42').character, 'Calm and patient. Plays chess with Andrés on Sundays since 2019.');
    assert.equal(env.changes.apply('g1', { layer: 'profile', target: '42.names', from: 'x', to: 'y' }, META).ok, false);
    assert.equal(env.changes.apply('g1', { layer: 'profile', target: '77.character', from: 'x', to: 'y' }, META).ok, false);
    assert.equal(env.changes.list('g1').length, 1);
    assert.equal(env.changes.undo('g1', 1).ok, true);
    assert.equal(store.getUser('g1', '42').character, 'Calm. Plays chess with Andrés on Sundays since 2019.');
  } finally {
    env.cleanup();
  }
});

test('profileGuard: accepts a rewording that keeps the facts', () => {
  assert.deepEqual(profileGuard('Friends with Éloïse, met on 2025-03-04, owes <@12> 20 coins.', 'Friends with Éloïse since 2025-03-04; owes <@12> 20 coins. Kind.'), { ok: true });
  assert.deepEqual(profileGuard('Likes Νίκος.', 'Likes Νίκος and Ζωή a lot.'), { ok: true });
});

test('profileGuard: refuses an emptied field, changed numbers, mentions, dates and lost names', () => {
  const refused = (before, after) => {
    const result = profileGuard(before, after);
    assert.equal(result.ok, false, `${before} -> ${after}`);
    assert.equal(typeof result.reason, 'string');
  };
  refused('Calm.', '   ');
  refused('Calm.', '');
  refused('Owns 3 cats.', 'Owns 4 cats.');
  refused('Owns 3 cats and 3 dogs.', 'Owns 3 cats and dogs.');
  refused('Friends with <@12>.', 'Friends with <@13>.');
  refused('Friends with <@12>.', 'Has friends.');
  refused('Birthday 12.05.1999.', 'Birthday 12.05.99.');
  refused('Joined 2024-01-02.', 'Joined 2024-02-01.');
  refused('Plays with Νίκος.', 'Plays with a friend.');
  refused('Plays with Andrés.', 'Plays with andrés.');
});

test('rebaseStatus: current until the tracked file changes, then stale', () => {
  const env = setup();
  try {
    assert.deepEqual(env.changes.rebaseStatus('g1'), []);
    env.changes.apply('g1', { layer: 'prompt', target: 'format', from: 'plain text', to: 'lowercase text' }, META);
    assert.deepEqual(env.changes.rebaseStatus('g1'), [{ name: 'format', status: 'current', baseHash: sha256(FORMAT), trackedHash: sha256(FORMAT), patches: 1 }]);
    fs.writeFileSync(path.join(env.promptsDir, 'format.md'), 'Write plain text always.\n');
    const [status] = env.changes.rebaseStatus('g1');
    assert.equal(status.status, 'stale');
    assert.equal(status.trackedHash, sha256('Write plain text always.\n'));
  } finally {
    env.cleanup();
  }
});

test('rebase: rebuilds from the tracked file, re-applies the patches found and drops the rest', () => {
  const env = setup();
  try {
    env.changes.apply('g1', { layer: 'prompt', target: 'format', from: 'plain text', to: 'lowercase text' }, META);
    env.changes.apply('g1', { layer: 'prompt', target: 'format', from: 'One message', to: 'A message' }, META);
    env.changes.apply('g1', { layer: 'prompt', target: 'format', from: '', to: 'Keep it brief.' }, META);
    const newTracked = 'Write plain text, always.\n\nNo emoji.\n';
    fs.writeFileSync(path.join(env.promptsDir, 'format.md'), newTracked);
    const trackedNow = snapshot(env.promptsDir);
    const result = env.changes.rebase('g1', 'format');
    assert.deepEqual(result, {
      ok: true,
      applied: [1, 3],
      dropped: [{ changeId: 2, from: 'One message', to: 'A message' }],
    });
    assert.equal(env.local('format.md'), 'Write lowercase text, always.\n\nNo emoji.\n\nKeep it brief.\n');
    assert.deepEqual(env.overrides().format, {
      baseHash: sha256(newTracked),
      patches: [{ changeId: 1, from: 'plain text', to: 'lowercase text' }, { changeId: 3, from: '', to: 'Keep it brief.' }],
    });
    assert.equal(env.changes.rebaseStatus('g1')[0].status, 'current');
    assert.deepEqual(snapshot(env.promptsDir), trackedNow);
    assert.deepEqual(fs.readdirSync(env.localPromptsDir), ['format.md']);
    assert.deepEqual(env.changes.rebase('g1', 'reply'), { ok: false, reason: 'no override' });
  } finally {
    env.cleanup();
  }
});
