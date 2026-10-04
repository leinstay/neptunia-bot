// Tests for src/memory/store.js: JSON-file persistence for profiles, guild
// memory, the observation buffer and scheduler state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, writeJsonAtomic } from '../src/memory/store.js';
import { emptyAffinity } from '../src/memory/affinity.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-store-'));
}

test('getUser: returns null for a user that has never been seen', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.equal(store.getUser('g1', 'nouser'), null);
});

test('touchUser: creates a profile with names, counters and timestamps', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const profile = store.touchUser('g1', 'u1', 'Alice', 1000);
  assert.equal(profile.id, 'u1');
  assert.deepEqual(profile.names, ['Alice']);
  assert.equal(profile.messageCount, 1);
  assert.equal(profile.firstSeen, new Date(1000).toISOString());
  assert.equal(profile.lastSeen, new Date(1000).toISOString());
});

test('touchUser: puts the current name first, keeps previous names after, deduplicated', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.touchUser('g1', 'u1', 'Bob', 2000); // renamed
  const profile = store.touchUser('g1', 'u1', 'Alice', 3000); // renamed back
  assert.deepEqual(profile.names, ['Alice', 'Bob']); // no duplicate 'Alice'
});

test('touchUser: names list is capped at 5 entries', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const names = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
  let profile;
  for (const [i, name] of names.entries()) profile = store.touchUser('g1', 'u1', name, i);
  assert.equal(profile.names.length, 5);
  assert.equal(profile.names[0], 'n6'); // most recent first
});

test('touchUser: firstSeen is set only once, lastSeen keeps advancing', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.touchUser('g1', 'u1', 'Alice', 5000);
  assert.equal(profile.firstSeen, new Date(1000).toISOString());
  assert.equal(profile.lastSeen, new Date(5000).toISOString());
  assert.equal(profile.messageCount, 2);
});

test('touchUser: an empty/falsy name does not touch the names list', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.touchUser('g1', 'u1', '', 2000);
  assert.deepEqual(profile.names, ['Alice']);
});

// ---- out-of-order touches (the memory warmup feeding old history after a live touch today) ----

test('touchUser: firstSeen is min(existing, at) and lastSeen is max(existing, at), regardless of arrival order', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  // Live touch today...
  store.touchUser('g1', 'u1', 'Alice', 5_000_000);
  // ...then the warmup feeds four years of older history.
  const profile = store.touchUser('g1', 'u1', 'Alice', 1000);
  assert.equal(profile.firstSeen, new Date(1000).toISOString(), 'firstSeen widens to the older message');
  assert.equal(profile.lastSeen, new Date(5_000_000).toISOString(), 'lastSeen does NOT regress to the older message');
  assert.equal(profile.messageCount, 2);
});

test('touchUser: an older/backdated touch never moves a name to the front', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 5_000_000); // live, current display name
  const profile = store.touchUser('g1', 'u1', 'OldNick', 1000); // backdated history, an older name
  assert.deepEqual(profile.names, ['Alice', 'OldNick'], 'the current name stays first; the old one is appended');
});

test('touchUser: a backdated touch of an already-known name leaves the names order untouched', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 5_000_000);
  store.touchUser('g1', 'u1', 'Bob', 6_000_000); // renamed, now current
  const profile = store.touchUser('g1', 'u1', 'Alice', 1000); // backdated history mentioning the old name
  assert.deepEqual(profile.names, ['Bob', 'Alice'], 'Alice is not moved back to the front by an older touch');
});

test('touchUser: a touch at exactly the stored lastSeen still counts as newest (moves the name to the front)', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.touchUser('g1', 'u1', 'Bob', 1000);
  assert.deepEqual(profile.names, ['Bob', 'Alice']);
});

test('touchUser: in-order touches behave exactly as before (regression check)', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.touchUser('g1', 'u1', 'Bob', 2000);
  assert.deepEqual(profile.names, ['Bob', 'Alice']);
  assert.equal(profile.firstSeen, new Date(1000).toISOString());
  assert.equal(profile.lastSeen, new Date(2000).toISOString());
});

test('getUser: returns the same profile touchUser created', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.getUser('g1', 'u1');
  assert.equal(profile.id, 'u1');
});

test('updateUser: merges fields and stamps updatedAt', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.updateUser('g1', 'u1', { character: 'τολμηρή', style: 'παιχνίδια' });
  assert.equal(profile.character, 'τολμηρή');
  assert.equal(profile.style, 'παιχνίδια');
  assert.ok(profile.updatedAt);
});

test('updateUser: cannot set interests or details via raw LLM fields', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'chess', note: '' }] }, details: { add: ['likes tea'] } }, {
    maxInterests: 12,
    topicChars: 40,
    noteChars: 120,
    maxDetails: 15,
    now: 1000,
  });

  store.updateUser('g1', 'u1', {
    character: 'chatty',
    interests: [{ topic: 'sneaky', note: '', weight: 99, firstSeen: 'x', lastSeen: 'x' }],
    details: ['sneaky overwrite'],
  });

  const profile = store.getUser('g1', 'u1');
  assert.equal(profile.character, 'chatty');
  assert.equal(profile.interests.length, 1);
  assert.equal(profile.interests[0].topic, 'chess');
  assert.equal(profile.details.length, 1);
  assert.equal(profile.details[0].text, 'likes tea');
});

test('updateUser: creates the profile if it did not already exist', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const profile = store.updateUser('g1', 'newuser', { character: 'x' });
  assert.equal(profile.id, 'newuser');
  assert.equal(profile.character, 'x');
});

test('forgetUser: removes the profile from cache and disk', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.flush();
  store.forgetUser('g1', 'u1');
  assert.equal(store.getUser('g1', 'u1'), null);
  const file = path.join(dir, 'guilds', 'g1', 'users', 'u1.json');
  assert.equal(fs.existsSync(file), false);
});

test('getGuild: returns the default empty guild memory when nothing is stored', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = store.getGuild('g1');
  assert.deepEqual(guild, { patterns: '', starters: '', injokes: [], self: [], learned: [], learnedNextId: 1, emojiUsage: {}, emojiBackfill: null, ownLines: [], worn: null, wornHistory: [], updatedAt: null });
});

// ---- guild.learned: things people taught the persona --------------------------

const LEARNED_CFG = { maxLearned: 20, maxLearnedStored: 60, learnedChars: 160, learnedHalfLifeDays: 720, confirmGapHours: 12 };
const TEACH_AT = Date.UTC(2026, 8, 21, 12, 0, 0);

test('getGuild: an old guild.json without learned loads it as empty, every other field and the file untouched', () => {
  const dir = tmpDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = { patterns: 'μιμίδια', starters: 'καλημέρα', injokes: ['ο βράχος'], self: ['likes tea'], custom: 7, updatedAt: '2026-01-01T00:00:00.000Z' };
  const raw = JSON.stringify(old, null, 2);
  fs.writeFileSync(file, raw);

  const store = createStore({ dataDir: dir });
  const guild = store.getGuild('g1');
  assert.deepEqual(guild, { ...old, learned: [], learnedNextId: 1, emojiUsage: {}, emojiBackfill: null, ownLines: [], worn: null, wornHistory: [] });
  store.flush();
  assert.equal(fs.readFileSync(file, 'utf8'), raw, 'reading alone never rewrites the file');
});

test('getGuild: a hand-edited learned list is validated, ids assigned off learnedNextId', () => {
  const dir = tmpDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ patterns: '', learned: [{ id: 4, text: 'Café closes at nine', weight: 2, from: '<@322222222222222222>' }, { text: 'Friday is τυρόπιτα day' }, 'garbage', { text: '' }], learnedNextId: 3 }),
  );
  const guild = createStore({ dataDir: dir }).getGuild('g1');
  assert.deepEqual(guild.learned.map((i) => [i.id, i.text, i.from]), [
    [4, 'Café closes at nine', '<@322222222222222222>'],
    [5, 'Friday is τυρόπιτα day', undefined],
  ]);
  assert.equal(guild.learnedNextId, 6);
});

test('getGuild: learned that is not an array or a garbage learnedNextId never throws', () => {
  const dir = tmpDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ patterns: 'x', learned: 'nope', learnedNextId: -3 }));
  const guild = createStore({ dataDir: dir }).getGuild('g1');
  assert.deepEqual(guild.learned, []);
  assert.equal(guild.learnedNextId, 1);
  assert.equal(guild.patterns, 'x');
});

test('applyLearnedOps: adds items with per-guild ids, from kept, returns the new list, persists across a restart', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const learned = store.applyLearnedOps(
    'g1',
    { add: [{ text: 'Café closes at nine', from: '<@322222222222222222>' }, 'Friday is τυρόπιτα day'] },
    { ...LEARNED_CFG, seenAt: TEACH_AT },
  );
  assert.deepEqual(learned, [
    { id: 1, text: 'Café closes at nine', weight: 1, firstSeen: new Date(TEACH_AT).toISOString(), lastSeen: new Date(TEACH_AT).toISOString(), from: '<@322222222222222222>' },
    { id: 2, text: 'Friday is τυρόπιτα day', weight: 1, firstSeen: new Date(TEACH_AT).toISOString(), lastSeen: new Date(TEACH_AT).toISOString() },
  ]);
  assert.equal(store.getGuild('g1').learnedNextId, 3);
  store.flush();

  const again = createStore({ dataDir: dir }).getGuild('g1');
  assert.deepEqual(again.learned, learned);
  assert.equal(again.learnedNextId, 3);
});

test('applyLearnedOps: ids are never reused after a remove; seen bumps past the gap; sure:false starts at 0', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.applyLearnedOps('g1', { add: ['a fact', 'b fact'] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  store.applyLearnedOps('g1', { remove: [2], seen: [1] }, { ...LEARNED_CFG, seenAt: TEACH_AT + 24 * 3_600_000 });
  const learned = store.applyLearnedOps('g1', { add: [{ text: 'c fact', sure: false }] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  assert.deepEqual(learned.map((i) => [i.id, i.text, i.weight]), [
    [1, 'a fact', 2],
    [3, 'c fact', 0],
  ]);
});

test('applyLearnedOps: text is clamped to learnedChars, storage capped at max(maxLearnedStored, maxLearned)', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const long = 'ω'.repeat(400);
  const cfg = { ...LEARNED_CFG, learnedChars: 10, clampTolerance: 1, maxLearned: 2, maxLearnedStored: 3 };
  const learned = store.applyLearnedOps('g1', { add: [long, 'f1', 'f2', 'f3', 'f4'] }, { ...cfg, seenAt: TEACH_AT });
  assert.equal(learned.length, 3);
  assert.ok(learned.every((i) => Array.from(i.text).length <= 10));
});

test('applyLearnedOps: garbage ops never throw and change nothing', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.applyLearnedOps('g1', { add: ['kept fact'] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  for (const garbage of [null, undefined, 'nope', 42, [1], { add: 'x' }, { add: [null, 42, {}] }, { seen: [{}] }, { remove: [{}] }]) {
    const learned = store.applyLearnedOps('g1', garbage, { ...LEARNED_CFG, seenAt: TEACH_AT });
    assert.deepEqual(learned.map((i) => i.text), ['kept fact'], `garbage ${JSON.stringify(garbage)}`);
  }
});

test('applyLearnedOps: leaves every other guild field alone', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.updateGuild('g1', { patterns: 'μιμίδια', injokes: ['ο βράχος'] });
  store.applyLearnedOps('g1', { add: ['a fact'] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  const guild = store.getGuild('g1');
  assert.equal(guild.patterns, 'μιμίδια');
  assert.deepEqual(guild.injokes, ['ο βράχος']);
});

test('updateGuild: can never overwrite learned or learnedNextId wholesale', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.applyLearnedOps('g1', { add: ['a fact'] }, { ...LEARNED_CFG, seenAt: TEACH_AT });
  store.updateGuild('g1', { patterns: 'p', learned: [], learnedNextId: 99 });
  const guild = store.getGuild('g1');
  assert.deepEqual(guild.learned.map((i) => i.text), ['a fact']);
  assert.equal(guild.learnedNextId, 2);
  assert.equal(guild.patterns, 'p');
});

test('updateGuild: merges fields and stamps updatedAt', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = store.updateGuild('g1', { patterns: 'μιμίδια για γάτες' });
  assert.equal(guild.patterns, 'μιμίδια για γάτες');
  assert.ok(guild.updatedAt);
});

test('writeJsonAtomic: a refused rename falls back to an in-place write, and says so in the log', async () => {
  const dir = tmpDataDir();
  const file = path.join(dir, 'guilds', 'g1', 'guild.json');
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EPERM: operation not permitted');
    err.code = 'EPERM';
    throw err;
  };
  let logs;
  try {
    ({ logs } = await withCapturedLogs(() => writeJsonAtomic(file, { patterns: 'μιμίδια' })));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { patterns: 'μιμίδια' });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['guild.json'], 'no temp file left behind');
  const warning = logs.find((entry) => entry.msg === 'store: rename failed, writing in place');
  assert.ok(warning);
  assert.equal(warning.file, file);
  assert.equal(warning.error.code, 'EPERM');
});

test('pushBuffer: caps the buffer length, dropping the oldest entries', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  for (let i = 0; i < 5; i += 1) store.pushBuffer('g1', { i }, 3);
  const buffer = store.getBuffer('g1');
  assert.deepEqual(buffer.map((m) => m.i), [2, 3, 4]);
});

test('pushBuffer: returns how many oldest entries the cap dropped, 0 while under it', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const dropped = [];
  for (let i = 0; i < 5; i += 1) dropped.push(store.pushBuffer('g1', { i }, 3));
  assert.deepEqual(dropped, [0, 0, 0, 1, 1]);
  // A cap lowered by a hot config edit drops several at once.
  assert.equal(store.pushBuffer('g1', { i: 5 }, 1), 3);
  assert.deepEqual(store.getBuffer('g1').map((m) => m.i), [5]);
});

test('shiftBuffer: drops exactly the consumed messages, by id; later arrivals and untaken ones stay', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  for (let i = 0; i < 5; i += 1) store.pushBuffer('g1', { id: `m${i}`, i }, 100);
  const consumed = store.getBuffer('g1').slice(0, 2);
  store.pushBuffer('g1', { id: 'm5', i: 5 }, 100); // arrived while the batch was in flight
  store.shiftBuffer('g1', consumed);
  assert.deepEqual(store.getBuffer('g1').map((m) => m.id), ['m2', 'm3', 'm4', 'm5']);
});

test('shiftBuffer: consumed messages already trimmed off the front never cost a newer message its place', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  for (let i = 0; i < 5; i += 1) store.pushBuffer('g1', { id: `m${i}` }, 5);
  const consumed = store.getBuffer('g1').slice(0, 3);
  // Two arrivals during the call push m0 and m1 out of the capped buffer.
  store.pushBuffer('g1', { id: 'm5' }, 5);
  store.pushBuffer('g1', { id: 'm6' }, 5);
  store.shiftBuffer('g1', consumed);
  assert.deepEqual(store.getBuffer('g1').map((m) => m.id), ['m3', 'm4', 'm5', 'm6']);
});

test('shiftBuffer: an entry without an id goes only up to and including the last consumed entry', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const fill = () => {
    for (const m of [{ i: 0 }, { id: 'm1', i: 1 }, { i: 2 }, { id: 'm3', i: 3 }]) store.pushBuffer('g1', m, 100);
  };
  fill();
  store.shiftBuffer('g1', store.getBuffer('g1').slice(0, 2));
  assert.deepEqual(store.getBuffer('g1').map((m) => m.i), [2, 3]);

  store.wipeGuild('g1');
  fill();
  const consumed = store.getBuffer('g1').slice(0, 3); // the last consumed entry has no id
  store.pushBuffer('g1', { i: 4 }, 100); // arrived while the batch was in flight, no id either
  store.shiftBuffer('g1', consumed);
  assert.deepEqual(store.getBuffer('g1').map((m) => m.i), [3, 4]);
});

test('flush + a new store instance: profiles, guild memory and buffer survive a "restart"', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.touchUser('g1', 'u1', 'Alice', 1000);
  storeA.updateUser('g1', 'u1', { character: 'τολμηρή' });
  storeA.updateGuild('g1', { patterns: 'μιμίδια' });
  storeA.pushBuffer('g1', { text: 'hi' }, 100);
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  const profile = storeB.getUser('g1', 'u1');
  assert.equal(profile.character, 'τολμηρή');
  assert.deepEqual(profile.names, ['Alice']);
  assert.equal(storeB.getGuild('g1').patterns, 'μιμίδια');
  assert.deepEqual(storeB.getBuffer('g1'), [{ text: 'hi' }]);
});

test('flush: only writes files that are dirty', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.flush();
  const file = path.join(dir, 'guilds', 'g1', 'users', 'u1.json');
  const mtimeBefore = fs.statSync(file).mtimeMs;
  store.flush(); // nothing changed since -> should be a no-op
  const mtimeAfter = fs.statSync(file).mtimeMs;
  assert.equal(mtimeBefore, mtimeAfter);
});

test('listGuilds: lists guild ids that exist on disk after a flush', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.touchUser('g1', 'u1', 'Alice', 1000);
  storeA.updateGuild('g2', { patterns: 'x' });
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  const guilds = storeB.listGuilds().sort();
  assert.deepEqual(guilds, ['g1', 'g2']);
});

test('listGuilds: also includes a guild that is only cached, not yet flushed', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g3', 'u1', 'Alice', 1000); // not flushed yet
  assert.ok(store.listGuilds().includes('g3'));
});

test('state: data persists across restarts via flush + markDirty', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.state.data.llmDay = '2026-09-20';
  storeA.state.data.llmCount = 5;
  storeA.state.markDirty();
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.state.data.llmDay, '2026-09-20');
  assert.equal(storeB.state.data.llmCount, 5);
});

test('state: an unflushed change is lost if a new store instance reads before flush', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.state.data.llmCount = 99;
  storeA.state.markDirty();
  // no flush()

  const storeB = createStore({ dataDir: dir });
  assert.notEqual(storeB.state.data.llmCount, 99);
});

test('countUsers: counts profile files on disk for a guild', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.touchUser('g1', 'u1', 'Alice', 1000);
  storeA.touchUser('g1', 'u2', 'Bob', 1000);
  storeA.flush();
  assert.equal(storeA.countUsers('g1'), 2);
});

test('countUsers: counts a profile not flushed yet, like every other lister', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.flush();
  store.touchUser('g1', 'u2', 'Zoé', 1000); // only cached
  assert.equal(store.countUsers('g1'), 2);
  assert.equal(store.countUsers('g1'), store.listUserProfiles('g1').length);
});

test('countUsers: returns 0 when the guild has no users directory yet', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.equal(store.countUsers('unknown-guild'), 0);
});

// --- affinity ---------------------------------------------------------------

test('emptyProfile: a fresh profile starts with a neutral affinity', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const profile = store.touchUser('g1', 'u1', 'Alice', 1000);
  assert.deepEqual(profile.affinity, emptyAffinity());
});

test('adjustAffinity: applies a delta to a fresh profile and returns the new affinity', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const affinity = store.adjustAffinity('g1', 'u1', 10, 'was kind', { maxDelta: 15, historySize: 10, now: 1000 });
  assert.equal(affinity.score, 10);
  assert.equal(affinity.reason, 'was kind');
  assert.equal(store.getUser('g1', 'u1').affinity.score, 10);
});

test('adjustAffinity: creates the affinity object for a profile written before this feature existed', () => {
  const dir = tmpDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  // A pre-relationships profile on disk: no `affinity` key at all.
  fs.writeFileSync(path.join(guildDir, 'u1.json'), JSON.stringify({ id: 'u1', names: ['Alice'], messageCount: 3 }));

  const store = createStore({ dataDir: dir });
  const before = store.getUser('g1', 'u1');
  assert.equal(before.affinity, undefined);

  const affinity = store.adjustAffinity('g1', 'u1', 5, 'welcomed back', { maxDelta: 15, historySize: 10, now: 1000 });
  assert.equal(affinity.score, 5);
  assert.equal(store.getUser('g1', 'u1').affinity.score, 5);
  assert.equal(store.getUser('g1', 'u1').names[0], 'Alice', 'the rest of the old profile survives untouched');
});

test('updateUser: cannot overwrite affinity via LLM-extracted fields', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.adjustAffinity('g1', 'u1', 20, 'liked', { maxDelta: 30, historySize: 10, now: 1000 });

  store.updateUser('g1', 'u1', { character: 'chatty', affinity: { score: -100, reason: 'hostile takeover attempt' } });

  const profile = store.getUser('g1', 'u1');
  assert.equal(profile.character, 'chatty');
  assert.equal(profile.affinity.score, 20, 'affinity must survive an updateUser call untouched');
  assert.equal(profile.affinity.reason, 'liked');
});

// --- channels (the server map) ----------------------------------------------

test('getChannel: returns null for a channel that has never been seen', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.equal(store.getChannel('g1', 'nochannel'), null);
});

test('touchChannel: creates a channel entry with Discord facts, counters and the day histogram', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const channel = store.touchChannel('g1', 'c1', { name: 'general', category: 'Text', topic: 'chat' }, Date.UTC(2026, 8, 20, 10, 0, 0));
  assert.equal(channel.id, 'c1');
  assert.equal(channel.name, 'general');
  assert.equal(channel.category, 'Text');
  assert.equal(channel.topic, 'chat');
  assert.equal(channel.messageCount, 1);
  assert.equal(channel.lastMessageAt, Date.UTC(2026, 8, 20, 10, 0, 0));
  assert.deepEqual(channel.days, { '2026-09-20': 1 });
});

test('touchChannel: repeated calls the same UTC day increment the same bucket', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const facts = { name: 'general', category: null, topic: null };
  store.touchChannel('g1', 'c1', facts, Date.UTC(2026, 8, 20, 1, 0, 0));
  const channel = store.touchChannel('g1', 'c1', facts, Date.UTC(2026, 8, 20, 23, 0, 0));
  assert.equal(channel.messageCount, 2);
  assert.deepEqual(channel.days, { '2026-09-20': 2 });
});

test('touchChannel: lastMessageAt keeps the maximum timestamp seen, even out of order', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const facts = { name: 'general', category: null, topic: null };
  store.touchChannel('g1', 'c1', facts, 5000);
  const channel = store.touchChannel('g1', 'c1', facts, 1000); // arrives "late", out of order
  assert.equal(channel.lastMessageAt, 5000);
});

test('touchChannel: Discord facts (name/category/topic) refresh on every call', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchChannel('g1', 'c1', { name: 'general', category: 'Text', topic: 'old topic' }, 1000);
  const channel = store.touchChannel('g1', 'c1', { name: 'general-renamed', category: null, topic: null }, 2000);
  assert.equal(channel.name, 'general-renamed');
  assert.equal(channel.category, null);
  assert.equal(channel.topic, null);
});

test('touchChannel: trims the day histogram to the newest 30 dates', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const facts = { name: 'general', category: null, topic: null };
  let channel;
  for (let day = 0; day < 35; day += 1) {
    channel = store.touchChannel('g1', 'c1', facts, Date.UTC(2026, 0, 1 + day, 12, 0, 0));
  }
  const keys = Object.keys(channel.days).sort();
  assert.equal(keys.length, 30);
  assert.equal(keys[0], '2026-01-06'); // the oldest 5 days were trimmed
  assert.equal(keys.at(-1), '2026-02-04');
});

test('touchChannel: sets firstMessageAt on first touch, then keeps the minimum', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const facts = { name: 'general', category: null, topic: null };
  store.touchChannel('g1', 'c1', facts, 5000);
  const channel = store.touchChannel('g1', 'c1', facts, 1000); // arrives "late", out of order
  assert.equal(channel.firstMessageAt, 1000);
});

test('touchChannel: bumps the author into topWriters and adds up repeated visits', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const facts = { name: 'general', category: null, topic: null };
  store.touchChannel('g1', 'c1', facts, 1000, 'alice');
  store.touchChannel('g1', 'c1', facts, 2000, 'alice');
  const channel = store.touchChannel('g1', 'c1', facts, 3000, 'bob');
  assert.deepEqual(channel.topWriters, [
    { id: 'alice', count: 2 },
    { id: 'bob', count: 1 },
  ]);
});

test('touchChannel: a null authorId (the persona/other bots) never touches topWriters', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const facts = { name: 'general', category: null, topic: null };
  const channel = store.touchChannel('g1', 'c1', facts, 1000);
  assert.deepEqual(channel.topWriters, []);
});

test('touchChannel: topWriters never grows past the top 5 by count', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const facts = { name: 'general', category: null, topic: null };
  let channel;
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    channel = store.touchChannel('g1', 'c1', facts, 1000, id);
  }
  // every author wrote exactly once here -- 6 candidates, only 5 kept.
  assert.equal(channel.topWriters.length, 5);
});

test('setChannelFacts: SETs counters, never adds, so a redo lands on the same numbers', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const facts = {
    name: 'general',
    category: 'Text',
    topic: 'chat',
    messageCount: 12,
    firstMessageAt: 1000,
    lastMessageAt: 9000,
    days: { '2026-09-20': 12 },
    topWriters: [{ id: 'a', count: 8 }, { id: 'b', count: 4 }],
  };
  store.setChannelFacts('g1', 'c1', facts);
  const channel = store.setChannelFacts('g1', 'c1', facts); // redo, same window
  assert.equal(channel.messageCount, 12);
  assert.equal(channel.firstMessageAt, 1000);
  assert.equal(channel.lastMessageAt, 9000);
  assert.deepEqual(channel.days, { '2026-09-20': 12 });
  assert.deepEqual(channel.topWriters, [{ id: 'a', count: 8 }, { id: 'b', count: 4 }]);
});

test('setChannelFacts: caps topWriters to 5 and coerces ids to strings', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const topWriters = [1, 2, 3, 4, 5, 6].map((id) => ({ id, count: id }));
  const channel = store.setChannelFacts('g1', 'c1', { messageCount: 21, days: {}, topWriters });
  assert.equal(channel.topWriters.length, 5);
  assert.ok(channel.topWriters.every((w) => typeof w.id === 'string'));
});

test('setChannelFacts: zeros and empty lists for a channel with no messages at all', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const channel = store.setChannelFacts('g1', 'c1', { name: 'quiet-room', category: null, topic: null, messageCount: 0, firstMessageAt: null, lastMessageAt: null, days: {}, topWriters: [] });
  assert.equal(channel.messageCount, 0);
  assert.equal(channel.firstMessageAt, null);
  assert.equal(channel.lastMessageAt, null);
  assert.deepEqual(channel.days, {});
  assert.deepEqual(channel.topWriters, []);
});

test('setChannelFacts: leaves purpose/topics/tone (the analyzer\'s own fields) untouched', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.updateChannel('g1', 'c1', { purpose: 'general chatter' });
  const channel = store.setChannelFacts('g1', 'c1', { messageCount: 3, days: {} });
  assert.equal(channel.purpose, 'general chatter');
});

test('setChannelFacts: creates the channel if it did not already exist', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const channel = store.setChannelFacts('g1', 'newchannel', { messageCount: 1, days: {} });
  assert.equal(channel.id, 'newchannel');
  assert.equal(channel.messageCount, 1);
});

test('updateChannel: merges purpose/topics/tone and stamps updatedAt', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchChannel('g1', 'c1', { name: 'general', category: null, topic: null }, 1000);
  const channel = store.updateChannel('g1', 'c1', { purpose: 'chatter', topics: 'games', tone: 'casual' });
  assert.equal(channel.purpose, 'chatter');
  assert.equal(channel.topics, 'games');
  assert.equal(channel.tone, 'casual');
  assert.ok(channel.updatedAt);
});

test('updateChannel: the analyzer cannot overwrite counters or Discord facts', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchChannel('g1', 'c1', { name: 'general', category: 'Text', topic: 'chat' }, 1000);
  store.updateChannel('g1', 'c1', {
    purpose: 'chatter',
    name: 'hacked-name',
    messageCount: 999,
    lastMessageAt: 1,
    days: { '2000-01-01': 999 },
  });
  const channel = store.getChannel('g1', 'c1');
  assert.equal(channel.purpose, 'chatter');
  assert.equal(channel.name, 'general', 'name must survive an updateChannel call untouched');
  assert.equal(channel.messageCount, 1, 'messageCount must survive an updateChannel call untouched');
  assert.equal(channel.lastMessageAt, 1000, 'lastMessageAt must survive an updateChannel call untouched');
  assert.deepEqual(channel.days, { '1970-01-01': 1 }, 'days must survive an updateChannel call untouched');
});

test('updateChannel: creates the channel if it did not already exist', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const channel = store.updateChannel('g1', 'newchannel', { purpose: 'x' });
  assert.equal(channel.id, 'newchannel');
  assert.equal(channel.purpose, 'x');
});

test('listChannels: lists every channel entry of a guild', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchChannel('g1', 'c1', { name: 'general', category: null, topic: null }, 1000);
  store.touchChannel('g1', 'c2', { name: 'random', category: null, topic: null }, 1000);
  const channels = store.listChannels('g1').map((c) => c.id).sort();
  assert.deepEqual(channels, ['c1', 'c2']);
});

test('listChannels: returns an empty array for a guild with no channels yet', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.listChannels('unknown-guild'), []);
});

test('listChannels: includes a channel that is only cached, not yet flushed', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchChannel('g1', 'c1', { name: 'general', category: null, topic: null }, 1000);
  assert.deepEqual(store.listChannels('g1').map((c) => c.id), ['c1']);
});

test('flush + a new store instance: channels survive a "restart"', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.touchChannel('g1', 'c1', { name: 'general', category: 'Text', topic: 'chat' }, 1000);
  storeA.updateChannel('g1', 'c1', { purpose: 'chatter' });
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  const channel = storeB.getChannel('g1', 'c1');
  assert.equal(channel.name, 'general');
  assert.equal(channel.purpose, 'chatter');
  assert.deepEqual(channel.days, { '1970-01-01': 1 });
});

// --- media cache (src/memory/describe.js's storage) --------------------------

test('getMediaCache: starts empty for a guild never seen', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.getMediaCache('g1'), {});
});

test('getMediaCache: the same live object is returned on every call, mutation-friendly', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const cache = store.getMediaCache('g1');
  cache.a1 = { text: 'a cat', ts: 1000 };
  assert.deepEqual(store.getMediaCache('g1'), { a1: { text: 'a cat', ts: 1000 } });
});

test('markMediaCacheDirty + flush: persists the media cache to guilds/<id>/media.json', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const cache = store.getMediaCache('g1');
  cache.a1 = { text: 'a cat', ts: 1000 };
  store.markMediaCacheDirty('g1');
  store.flush();

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'guilds', 'g1', 'media.json'), 'utf8'));
  assert.deepEqual(onDisk, { a1: { text: 'a cat', ts: 1000 } });
});

test('markMediaCacheDirty: a no-op before getMediaCache has ever been called for that guild', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.doesNotThrow(() => store.markMediaCacheDirty('never-touched'));
});

test('media cache: persists across store instances', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  const cache = storeA.getMediaCache('g1');
  cache.a1 = { text: 'a dog', ts: 2000 };
  storeA.markMediaCacheDirty('g1');
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  assert.deepEqual(storeB.getMediaCache('g1'), { a1: { text: 'a dog', ts: 2000 } });
});

test('adjustAffinity: persists across store instances', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.touchUser('g1', 'u1', 'Alice', 1000);
  storeA.adjustAffinity('g1', 'u1', 12, 'nice chat', { maxDelta: 15, historySize: 10, now: 1000 });
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  const affinity = storeB.getUser('g1', 'u1').affinity;
  assert.equal(affinity.score, 12);
  assert.equal(affinity.reason, 'nice chat');
  assert.equal(affinity.history.length, 1);
});

// --- episodes -----------------------------------------------------------------

test('emptyProfile: a fresh profile starts with no episodes', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const profile = store.touchUser('g1', 'u1', 'Alice', 1000);
  assert.deepEqual(profile.episodes, []);
});

test('addEpisodes: appends via mergeEpisodes and marks the profile dirty', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);

  const added = store.addEpisodes('g1', 'u1', [{ what: 'promised to help' }], { maxEpisodes: 20, maxNew: 3, now: 1000 });

  assert.equal(added, 1);
  const profile = store.getUser('g1', 'u1');
  assert.equal(profile.episodes.length, 1);
  assert.equal(profile.episodes[0].what, 'promised to help');
});

test('addEpisodes: tolerates a profile written before this feature existed', () => {
  const dir = tmpDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'u1.json'), JSON.stringify({ id: 'u1', names: ['Alice'], messageCount: 3 }));

  const store = createStore({ dataDir: dir });
  const added = store.addEpisodes('g1', 'u1', [{ what: 'first ever episode' }], { maxEpisodes: 20, maxNew: 3, now: 1000 });

  assert.equal(added, 1);
  assert.equal(store.getUser('g1', 'u1').episodes.length, 1);
});

test('addEpisodes: an empty/rejected batch changes nothing', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);

  const added = store.addEpisodes('g1', 'u1', [], { maxEpisodes: 20, maxNew: 3, now: 1000 });
  assert.equal(added, 0);
  assert.deepEqual(store.getUser('g1', 'u1').episodes, []);
});

test('addEpisodes: persists across store instances', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.touchUser('g1', 'u1', 'Alice', 1000);
  storeA.addEpisodes('g1', 'u1', [{ what: 'shared a secret', quote: 'do not tell anyone' }], { maxEpisodes: 20, maxNew: 3, now: 1000 });
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  const episodes = storeB.getUser('g1', 'u1').episodes;
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].quote, 'do not tell anyone');
});

test('updateUser: never overwrites episodes even if the field is present in fields', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.addEpisodes('g1', 'u1', [{ what: 'a real episode' }], { maxEpisodes: 20, maxNew: 3, now: 1000 });

  store.updateUser('g1', 'u1', { character: 'nice', episodes: [{ what: 'sneaky overwrite attempt' }] });

  const profile = store.getUser('g1', 'u1');
  assert.equal(profile.character, 'nice');
  assert.equal(profile.episodes.length, 1);
  assert.equal(profile.episodes[0].what, 'a real episode');
});

// --- interests / details (applyProfileOps) ----------------------------------

test('emptyProfile: a fresh profile starts with no interests', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const profile = store.touchUser('g1', 'u1', 'Alice', 1000);
  assert.deepEqual(profile.interests, []);
});

test('getUser: a hand-edited details array missing valid ids gets fresh ones assigned, advancing detailsSeq', () => {
  const dir = tmpDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  fs.writeFileSync(
    path.join(guildDir, 'u1.json'),
    JSON.stringify({ id: 'u1', names: ['Alice'], details: [{ text: 'Owns a cat' }, { text: 'Plays guitar' }] }),
  );

  const store = createStore({ dataDir: dir });
  const profile = store.getUser('g1', 'u1');
  assert.deepEqual(profile.details, [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: null, lastSeen: null },
  ]);
  assert.equal(profile.detailsSeq, 3);
});

test('applyProfileOps: a fresh detail is assigned a per-profile id that keeps incrementing across calls', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyProfileOps('g1', 'u1', { details: { add: ['Owns a cat'] } }, { maxDetails: 15, now: 1000 });
  const profile = store.applyProfileOps('g1', 'u1', { details: { add: ['Plays guitar'] } }, { maxDetails: 15, now: 2000 });
  assert.deepEqual(profile.details.map((d) => d.id), [1, 2]);
});

test('applyProfileOps: a detail id is never reused after a remove', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyProfileOps('g1', 'u1', { details: { add: ['a', 'b'] } }, { maxDetails: 15, now: 1000 });
  store.applyProfileOps('g1', 'u1', { details: { remove: [1] } }, { maxDetails: 15, now: 2000 });
  const profile = store.applyProfileOps('g1', 'u1', { details: { add: ['c'] } }, { maxDetails: 15, now: 3000 });
  assert.deepEqual(profile.details.map((d) => d.id), [2, 3]);
});

test('applyProfileOps: opts.seenAt (not opts.now) dates interests/details, and drives the confirmGapHours bump', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const seenAt1 = Date.UTC(2020, 0, 1);
  store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'Chess', note: '' }] } }, {
    maxInterests: 12,
    topicChars: 40,
    noteChars: 120,
    confirmGapHours: 12,
    now: 999_999_999_999, // a very different wall-clock "now"
    seenAt: seenAt1,
  });
  let profile = store.getUser('g1', 'u1');
  assert.equal(profile.interests[0].firstSeen, new Date(seenAt1).toISOString(), 'dated by seenAt, not now');

  const seenAt2 = seenAt1 + 13 * 3_600_000; // past the 12h gap
  profile = store.applyProfileOps('g1', 'u1', { interests: { seen: ['Chess'] } }, {
    maxInterests: 12,
    topicChars: 40,
    noteChars: 120,
    confirmGapHours: 12,
    now: 1,
    seenAt: seenAt2,
  });
  assert.equal(profile.interests[0].weight, 2);
  assert.equal(profile.interests[0].lastSeen, new Date(seenAt2).toISOString());
});

test('applyProfileOps: sets character/style/relationship only when given as non-empty strings', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyProfileOps('g1', 'u1', { character: 'chatty', style: 'blunt' }, { fieldChars: 400, now: 1000 });

  const profile = store.applyProfileOps('g1', 'u1', { style: '', relationship: 'trusts you' }, { fieldChars: 400, now: 2000 });
  assert.equal(profile.character, 'chatty', 'untouched: absent from this call');
  assert.equal(profile.style, 'blunt', 'untouched: empty string never blanks it');
  assert.equal(profile.relationship, 'trusts you');
});

test('applyProfileOps: prose fields are clamped tolerantly to opts.fieldChars (a single long word hard-cuts at the tolerance ceiling)', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.applyProfileOps('g1', 'u1', { character: '0123456789' }, { fieldChars: 5, now: 1000 });
  assert.equal(profile.character, '012345', '5 * the default tolerance 1.25, floored');
});

test('applyProfileOps: prose fields respect an explicit clampTolerance', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.applyProfileOps('g1', 'u1', { character: '0123456789' }, { fieldChars: 5, clampTolerance: 1, now: 1000 });
  assert.equal(profile.character, '01234');
});

test('applyProfileOps: routes interests ops through applyInterestOps', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'Chess', note: 'plays weekly' }] } }, {
    maxInterests: 12,
    topicChars: 40,
    noteChars: 120,
    now: 1000,
  });
  const muchLater = 1000 + 13 * 3_600_000; // past the default 12h confirmGapHours
  const profile = store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'chess', note: '' }] } }, {
    maxInterests: 12,
    topicChars: 40,
    noteChars: 120,
    now: muchLater,
  });
  assert.equal(profile.interests.length, 1);
  assert.equal(profile.interests[0].weight, 2, 're-mentioning the same topic, well past the gap, bumps its weight');
  assert.equal(profile.interests[0].note, 'plays weekly');
});

test('applyProfileOps: normalizes a hand-edited interests array before applying ops', () => {
  const dir = tmpDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  fs.writeFileSync(
    path.join(guildDir, 'u1.json'),
    JSON.stringify({ id: 'u1', names: ['Alice'], interests: [{ topic: 'Chess' }, { topic: 'Anime' }] }),
  );

  const store = createStore({ dataDir: dir });
  const profile = store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'Cooking', note: '' }] } }, {
    maxInterests: 12,
    topicChars: 40,
    noteChars: 120,
    now: 1000,
  });
  assert.deepEqual(profile.interests.map((i) => i.topic), ['Chess', 'Anime', 'Cooking']);
});

test('applyProfileOps: details add is de-duplicated case-insensitively (a sighting on the existing item), remove is exact-text', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyProfileOps('g1', 'u1', { details: { add: ['Owns a cat', 'Plays guitar'] } }, { maxDetails: 15, now: 1000 });
  const profile = store.applyProfileOps('g1', 'u1', { details: { add: ['owns a cat', 'Reads sci-fi'], remove: ['Plays guitar'] } }, {
    maxDetails: 15,
    now: 2000,
  });
  assert.deepEqual(profile.details.map((d) => d.text), ['Owns a cat', 'Reads sci-fi']);
  assert.equal(profile.details[0].weight, 1, 'the re-add landed inside the default confirmGapHours, no bump');
});

test('applyProfileOps: details are capped at maxDetails, evicting the lowest weight (then oldest) first', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const profile = store.applyProfileOps('g1', 'u1', { details: { add: ['a', 'b', 'c'] } }, { maxDetails: 2, now: 1000 });
  assert.deepEqual(profile.details.map((d) => d.text), ['b', 'c']);
});

test('applyProfileOps: threads maxInterestsStored into applyInterestOps -- a smaller stored cap never evicts below the shown cap', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'a' }, { topic: 'b' }] } }, {
    maxInterests: 12,
    maxInterestsStored: 12,
    topicChars: 40,
    noteChars: 120,
    now: 1000,
  });
  const profile = store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'c' }] } }, {
    maxInterests: 12,
    maxInterestsStored: 1, // deliberately smaller than the shown cap
    topicChars: 40,
    noteChars: 120,
    now: 2000,
  });
  assert.equal(profile.interests.length, 3, 'the stored cap is floored at maxInterests (12), so nothing is evicted yet');
});

test('applyProfileOps: threads interestHalfLifeDays into applyInterestOps -- decay lets a recent light interest survive eviction over an ancient heavier one', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const ancientMs = Date.parse('2021-01-01T00:00:00.000Z');
  store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'Ancient favorite' }] } }, {
    maxInterests: 5,
    maxInterestsStored: 5,
    topicChars: 40,
    noteChars: 120,
    seenAt: ancientMs,
    now: ancientMs,
  });
  store.applyProfileOps('g1', 'u1', { interests: { seen: ['Ancient favorite'] } }, {
    maxInterests: 5,
    maxInterestsStored: 5,
    topicChars: 40,
    noteChars: 120,
    seenAt: ancientMs + 13 * 3_600_000,
    now: ancientMs,
  });

  const recentMs = Date.parse('2026-09-20T00:00:00.000Z');
  const profile = store.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'Fresh interest' }] } }, {
    maxInterests: 1,
    maxInterestsStored: 1, // force an eviction down to a single stored interest
    topicChars: 40,
    noteChars: 120,
    interestHalfLifeDays: 30,
    seenAt: recentMs,
    now: recentMs,
  });
  assert.deepEqual(profile.interests.map((i) => i.topic), ['Fresh interest'], 'years of silence outrank the ancient item, higher weight or not');
});

test('applyProfileOps: threads detailHalfLifeDays into applyDetailOps -- decay lets a recent light detail survive eviction over an ancient heavier one', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const ancientMs = Date.parse('2021-01-01T00:00:00.000Z');
  store.applyProfileOps('g1', 'u1', { details: { add: [{ text: 'Ancient favorite fact' }] } }, { maxDetails: 5, maxDetailsStored: 5, seenAt: ancientMs, now: ancientMs });
  // Bump the ancient detail's weight a bit, well past confirmGapHours, so it
  // starts heavier than the newcomer added below.
  store.applyProfileOps('g1', 'u1', { details: { seen: ['Ancient favorite fact'] } }, { maxDetails: 5, maxDetailsStored: 5, seenAt: ancientMs + 13 * 3_600_000, now: ancientMs });

  const recentMs = Date.parse('2026-09-20T00:00:00.000Z');
  const profile = store.applyProfileOps('g1', 'u1', { details: { add: [{ text: 'Fresh detail' }] } }, {
    maxDetails: 1,
    maxDetailsStored: 1, // force an eviction down to a single stored detail
    detailHalfLifeDays: 30,
    seenAt: recentMs,
    now: recentMs,
  });
  assert.deepEqual(profile.details.map((d) => d.text), ['Fresh detail'], 'years of silence outrank the ancient item, higher weight or not');
});

test('applyProfileOps: tolerates garbage ops without throwing, leaves the profile unchanged', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  for (const garbage of [null, undefined, 'not an object', 42, { interests: 'nope', details: 5 }]) {
    assert.doesNotThrow(() => store.applyProfileOps('g1', 'u1', garbage, { now: 1000 }));
  }
  const profile = store.getUser('g1', 'u1');
  assert.deepEqual(profile.interests, []);
  assert.deepEqual(profile.details, []);
});

test('applyProfileOps: persists across store instances', () => {
  const dir = tmpDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  fs.writeFileSync(
    path.join(guildDir, 'u1.json'),
    JSON.stringify({ id: 'u1', names: ['Alice'], interests: [{ topic: 'Chess', note: 'weekly club', weight: 1, firstSeen: null, lastSeen: null }] }),
  );

  const storeA = createStore({ dataDir: dir });
  storeA.applyProfileOps('g1', 'u1', { interests: { add: [{ topic: 'Anime', note: '' }] }, details: { add: ['owns a cat'] } }, {
    maxInterests: 12,
    topicChars: 40,
    noteChars: 120,
    maxDetails: 15,
    now: 1000,
  });
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  const profile = storeB.getUser('g1', 'u1');
  assert.deepEqual(profile.interests.map((i) => i.topic), ['Chess', 'Anime']);
  assert.deepEqual(profile.details.map((d) => d.text), ['owns a cat']);
});

// --- lore -----------------------------------------------------------------

test('getLore: an empty array for a guild with no lorebook yet', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.getLore('g1'), []);
});

test('setLore: inserts entries via upsertLore and marks the guild lorebook dirty', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });

  const upserted = store.setLore('g1', [{ title: 'The Flood', keys: ['flood', 'the water'], text: 'It flooded once.' }], {
    source: 'analyzer',
    now: 1000,
  });

  assert.equal(upserted, 1);
  const entries = store.getLore('g1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'The Flood');
  assert.equal(entries[0].source, 'analyzer');
});

test('setLore: an owner entry is never overwritten by a later analyzer update', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.setLore('g1', [{ title: 'Founders Day', keys: ['founders'], text: 'owner text', always: true }], { source: 'owner', now: 1000 });

  store.setLore('g1', [{ title: 'Founders Day', keys: ['founders'], text: 'analyzer tries to change this' }], {
    source: 'analyzer',
    now: 2000,
  });

  const entries = store.getLore('g1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'owner text');
  assert.equal(entries[0].source, 'owner');
});

test('removeLore: deletes by id and reports whether anything was removed', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.setLore('g1', [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }], { source: 'analyzer', now: 1000 });
  const [{ id }] = store.getLore('g1');

  assert.equal(store.removeLore('g1', id), true);
  assert.deepEqual(store.getLore('g1'), []);
  assert.equal(store.removeLore('g1', id), false, 'already gone');
});

test('lore: persists across store instances', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.setLore('g1', [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }], { source: 'analyzer', now: 1000 });
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  const entries = storeB.getLore('g1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'The Flood');
});

// --- wipeGuild --------------------------------------------------------------

function seedGuild(store) {
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.touchUser('g1', 'u2', 'Bob', 1000);
  store.updateGuild('g1', { patterns: 'μιμίδια' });
  store.applyLearnedOps('g1', { add: ['Café closes at nine'] }, { seenAt: 1000 });
  store.touchChannel('g1', 'c1', { name: 'general', category: null, topic: null }, 1000);
  store.touchChannel('g1', 'c2', { name: 'random', category: null, topic: null }, 1000);
  store.pushBuffer('g1', { text: 'hi' }, 100);
  store.pushBuffer('g1', { text: 'there' }, 100);
  store.setLore('g1', [{ title: 'The Flood', keys: ['flood'], text: 'It flooded once.' }], { source: 'analyzer', now: 1000 });
  store.setLore('g1', [{ title: 'Founders Day', keys: ['founders'], text: 'Owner text.', always: true }], {
    source: 'owner',
    now: 1000,
  });
  const cache = store.getMediaCache('g1');
  cache.a1 = { text: 'a cat', ts: 1000 };
  store.markMediaCacheDirty('g1');
  store.state.data.warmup = { done: false, channels: { c1: { batchesDone: 2 } } };
  store.state.data.llmDay = '2026-09-20';
  store.state.data.llmCount = 7;
  store.state.markDirty();
}

test('wipeGuild: removes profiles, guild memory, channels, buffer and analyzer lore; keeps owner lore, media cache and other state.json keys', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  seedGuild(storeA);
  storeA.flush();

  const counts = storeA.wipeGuild('g1');
  assert.deepEqual(counts, { users: 2, channels: 2, loreRemoved: 1, loreKept: 1, bufferMessages: 2 });

  // cache is immediately usable
  assert.equal(storeA.getUser('g1', 'u1'), null);
  assert.equal(storeA.getUser('g1', 'u2'), null);
  assert.deepEqual(storeA.getGuild('g1'), { patterns: '', starters: '', injokes: [], self: [], learned: [], learnedNextId: 1, emojiUsage: {}, emojiBackfill: null, ownLines: [], worn: null, wornHistory: [], updatedAt: null });
  assert.deepEqual(storeA.listChannels('g1'), []);
  assert.deepEqual(storeA.getBuffer('g1'), []);
  const lore = storeA.getLore('g1');
  assert.equal(lore.length, 1);
  assert.equal(lore[0].title, 'Founders Day');
  assert.equal(lore[0].source, 'owner');
  assert.deepEqual(storeA.getMediaCache('g1'), { a1: { text: 'a cat', ts: 1000 } });
  assert.equal(storeA.state.data.warmup, undefined);
  assert.equal(storeA.state.data.llmDay, '2026-09-20');
  assert.equal(storeA.state.data.llmCount, 7);

  // disk agrees, verified with a fresh store instance on the same temp dir
  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.getUser('g1', 'u1'), null);
  assert.equal(storeB.getUser('g1', 'u2'), null);
  assert.deepEqual(storeB.getGuild('g1'), { patterns: '', starters: '', injokes: [], self: [], learned: [], learnedNextId: 1, emojiUsage: {}, emojiBackfill: null, ownLines: [], worn: null, wornHistory: [], updatedAt: null });
  assert.deepEqual(storeB.listChannels('g1'), []);
  assert.deepEqual(storeB.getBuffer('g1'), []);
  const loreB = storeB.getLore('g1');
  assert.equal(loreB.length, 1);
  assert.equal(loreB[0].title, 'Founders Day');
  assert.deepEqual(storeB.getMediaCache('g1'), { a1: { text: 'a cat', ts: 1000 } });
  assert.equal(storeB.state.data.warmup, undefined);
  assert.equal(storeB.state.data.llmDay, '2026-09-20');
  assert.equal(storeB.state.data.llmCount, 7);
});

test('wipeGuild: the store stays fully usable afterwards without a restart', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  seedGuild(store);
  store.flush();
  store.wipeGuild('g1');

  const profile = store.touchUser('g1', 'u3', 'Carol', 2000);
  assert.equal(profile.messageCount, 1);
  const guild = store.getGuild('g1');
  assert.equal(guild.patterns, '');
  store.flush();

  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.getUser('g1', 'u3').names[0], 'Carol');
});

test('wipeGuild: safe when nothing was ever stored for the guild', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const counts = store.wipeGuild('never-seen');
  assert.deepEqual(counts, { users: 0, channels: 0, loreRemoved: 0, loreKept: 0, bufferMessages: 0 });
  assert.doesNotThrow(() => store.touchUser('never-seen', 'u1', 'Dee', 1000));
});

test('wipeGuild: keepOwnerLore false also removes owner lore', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  seedGuild(store);
  store.flush();

  const counts = store.wipeGuild('g1', { keepOwnerLore: false });
  assert.equal(counts.loreRemoved, 2);
  assert.equal(counts.loreKept, 0);
  assert.deepEqual(store.getLore('g1'), []);
});

test('wipeGuild: keepMediaCache false also clears the media cache, on disk too', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  seedGuild(store);
  store.flush();

  store.wipeGuild('g1', { keepMediaCache: false });
  assert.deepEqual(store.getMediaCache('g1'), {});

  const storeB = createStore({ dataDir: dir });
  assert.deepEqual(storeB.getMediaCache('g1'), {});
});

test('wipeGuild: does not touch another guild\'s memory', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  seedGuild(store);
  store.touchUser('g2', 'u9', 'Eve', 1000);
  store.flush();

  store.wipeGuild('g1');

  assert.ok(store.getUser('g2', 'u9'));
  const storeB = createStore({ dataDir: dir });
  assert.ok(storeB.getUser('g2', 'u9'));
});

// --- aliases (applyProfileOps) ------------------------------------------------

test('emptyProfile: a fresh profile starts with no aliases', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const profile = store.touchUser('g1', 'u1', 'Alice', 1000);
  assert.deepEqual(profile.aliases, []);
});

test('getUser: a profile with no aliases key at all is tolerated, gets []', () => {
  const dir = tmpDataDir();
  const guildDir = path.join(dir, 'guilds', 'g1', 'users');
  fs.mkdirSync(guildDir, { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'u1.json'), JSON.stringify({ id: 'u1', names: ['Alice'] }));

  const store = createStore({ dataDir: dir });
  const profile = store.getUser('g1', 'u1');
  assert.deepEqual(profile.aliases, []);
});

test('applyProfileOps: routes users.aliases ops through applyAliasOps, threading maxAliases/maxAliasesStored/aliasHalfLifeDays', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);

  const profile = store.applyProfileOps(
    'g1',
    'u1',
    { aliases: { add: ['Ali'] } },
    { maxAliases: 5, maxAliasesStored: 15, aliasHalfLifeDays: 365, now: 1000 },
  );
  assert.equal(profile.aliases.length, 1);
  assert.equal(profile.aliases[0].name, 'Ali');
  assert.equal(profile.aliases[0].weight, 1);
});

test('applyProfileOps: an alias equal (case-insensitively) to the member\'s OWN stored display name is never added', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);

  const profile = store.applyProfileOps('g1', 'u1', { aliases: { add: ['alice'] } }, { now: 1000 });
  assert.deepEqual(profile.aliases, []);
});

test('applyProfileOps: a repeated alias add is a sighting (weight bump, subject to confirmGapHours)', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);

  store.applyProfileOps('g1', 'u1', { aliases: { add: ['Ali'] } }, { confirmGapHours: 12, now: 0, seenAt: 0 });
  const profile = store.applyProfileOps(
    'g1',
    'u1',
    { aliases: { add: ['ali'] } },
    { confirmGapHours: 12, now: 13 * 3_600_000, seenAt: 13 * 3_600_000 },
  );
  assert.equal(profile.aliases[0].weight, 2);
  assert.equal(profile.aliases[0].name, 'Ali', 'original casing kept');
});

test('applyProfileOps: aliases.remove deletes the alias', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);

  store.applyProfileOps('g1', 'u1', { aliases: { add: ['Ali'] } }, { now: 1000 });
  const profile = store.applyProfileOps('g1', 'u1', { aliases: { remove: ['Ali'] } }, { now: 2000 });
  assert.deepEqual(profile.aliases, []);
});

test('applyProfileOps: aliases are capped at max(maxAliasesStored, maxAliases)', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);

  store.applyProfileOps('g1', 'u1', { aliases: { add: ['One'] } }, { maxAliases: 1, maxAliasesStored: 1, now: 1000 });
  const profile = store.applyProfileOps('g1', 'u1', { aliases: { add: ['Two'] } }, { maxAliases: 1, maxAliasesStored: 1, now: 2000 });
  assert.equal(profile.aliases.length, 1);
});

test('applyProfileOps: garbage aliases ops never throw and change nothing', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);

  for (const garbage of [null, 'nope', 42, [1, 2], { add: 'nope' }]) {
    const profile = store.applyProfileOps('g1', 'u1', { aliases: garbage }, { now: 1000 });
    assert.deepEqual(profile.aliases, []);
  }
});

// --- listUserProfiles -----------------------------------------------------------

test('listUserProfiles: every stored profile of a guild, cached or on disk', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.touchUser('g1', 'u2', 'Bob', 1000);
  store.flush();

  const storeB = createStore({ dataDir: dir });
  storeB.touchUser('g1', 'u3', 'Carl', 1000); // cached only, not yet flushed

  const profiles = storeB.listUserProfiles('g1');
  assert.deepEqual(profiles.map((p) => p.id).sort(), ['u1', 'u2', 'u3']);
});

test('listUserProfiles: an empty/never-seen guild returns []', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.listUserProfiles('g1'), []);
});

// --- dropCaches / reloadState / validate (/nep pause, /nep resume) ------------

test('dropCaches: forgets every cached file except state.json, so the next read is a fresh disk read', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.updateGuild('g1', { patterns: 'x' });
  store.state.data.llmCount = 3;
  store.state.markDirty();
  store.flush();

  const dropped = store.dropCaches();
  assert.ok(dropped >= 2, 'dropped the user profile and the guild memory, at least');

  // A hand-edit made right after the drop is picked up on the very next read.
  fs.writeFileSync(
    path.join(dir, 'guilds', 'g1', 'users', 'u1.json'),
    JSON.stringify({ id: 'u1', names: ['Edited'], firstSeen: null, lastSeen: null, messageCount: 0 }),
  );
  const profile = store.getUser('g1', 'u1');
  assert.equal(profile.names[0], 'Edited');

  // state.json itself was NOT dropped -- still the in-memory value.
  assert.equal(store.state.data.llmCount, 3);
});

test('dropCaches: a no-op on an empty store, returns 0', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.equal(store.dropCaches(), 0);
});

test('reloadState: re-reads state.json from disk, discarding the cached in-memory value', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.state.data.llmCount = 1;
  store.state.markDirty();
  store.flush();

  // A hand-edit to state.json itself, e.g. warmup progress, made while paused.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ llmCount: 99, warmup: { done: false } }));

  assert.equal(store.state.data.llmCount, 1, 'still the stale cached value before reloadState');
  store.reloadState();
  assert.equal(store.state.data.llmCount, 99);
  assert.deepEqual(store.state.data.warmup, { done: false });
});

test('reloadState: falls back to {} when state.json does not exist', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.reloadState();
  assert.deepEqual(store.state.data, {});
});

test('validate: an empty array when every *.json file under dataDir parses (including when nothing exists yet)', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.validate(), []);

  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.flush();
  assert.deepEqual(store.validate(), []);
});

test('validate: names every unparsable *.json file, path relative to dataDir and forward-slash separated', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.touchUser('g1', 'u2', 'Bob', 1000);
  store.flush();

  fs.writeFileSync(path.join(dir, 'guilds', 'g1', 'users', 'u1.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'state.json'), '{ also not json');

  const bad = store.validate();
  assert.deepEqual(bad.sort(), ['guilds/g1/users/u1.json', 'state.json'].sort());
});

test('validate: a non-json file under dataDir is never checked', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not json at all, but not a .json file either');
  assert.deepEqual(store.validate(), []);
});

// --- private memory layer (data/guilds/<id>/private/<userId>.json) -----------

const EMPTY_PRIVATE = {
  relationship: '',
  interests: [],
  details: [],
  detailsSeq: 1,
  episodes: [],
  affinity: { score: 0, reason: '', history: [] },
  firstSeen: '',
  lastSeen: '',
  replies: { day: '', count: 0, noticedDay: '' },
  buffer: [],
};

function privateFile(dir, guildId, userId) {
  return path.join(dir, 'guilds', guildId, 'private', `${userId}.json`);
}

test('getPrivate: null when no private file exists, and nothing is created', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.equal(store.getPrivate('g1', 'u1'), null);
  store.flush();
  assert.equal(fs.existsSync(privateFile(dir, 'g1', 'u1')), false);
  assert.deepEqual(store.listPrivate('g1'), []);
});

test('applyPrivateOps: a first private write creates the empty shape, persists it on flush and survives a restart', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.applyPrivateOps('g1', 'u1', {}), EMPTY_PRIVATE);
  store.flush();
  assert.equal(fs.existsSync(privateFile(dir, 'g1', 'u1')), true);

  const storeB = createStore({ dataDir: dir });
  assert.deepEqual(storeB.getPrivate('g1', 'u1'), EMPTY_PRIVATE);
  assert.deepEqual(storeB.listPrivate('g1'), ['u1']);
});

test('applyPrivateOps: a later write with nothing to say leaves the existing file untouched', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.applyPrivateOps('g1', 'u1', { relationship: 'Trusts the persona' }, { fieldChars: 300 });
  assert.equal(store.applyPrivateOps('g1', 'u1', {}).relationship, 'Trusts the persona');
});

test('getPrivate: a hand-edited file is normalised on read: defaults filled, detail ids assigned', () => {
  const dir = tmpDataDir();
  const file = privateFile(dir, 'g1', 'u1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      relationship: 'Κάτι μυστικό',
      interests: 'not a list',
      details: [{ text: 'Owns a cat' }, { text: 'Plays guitar' }],
      affinity: { score: 12 },
      replies: { day: '2026-09-29' },
      buffer: 'garbage',
      episodes: null,
    }),
  );

  const store = createStore({ dataDir: dir });
  const priv = store.getPrivate('g1', 'u1');
  assert.equal(priv.relationship, 'Κάτι μυστικό');
  assert.deepEqual(priv.interests, []);
  assert.deepEqual(priv.details, [
    { id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null },
    { id: 2, text: 'Plays guitar', weight: 1, firstSeen: null, lastSeen: null },
  ]);
  assert.equal(priv.detailsSeq, 3);
  assert.deepEqual(priv.affinity, { score: 12, reason: '', history: [] });
  assert.deepEqual(priv.replies, { day: '2026-09-29', count: 0, noticedDay: '' });
  assert.deepEqual(priv.buffer, []);
  assert.deepEqual(priv.episodes, []);
  assert.equal(priv.firstSeen, '');
  assert.equal(priv.lastSeen, '');
});

test('getPrivate: a private file that parses to a non-object is replaced by the empty shape, with a count-only warning', async () => {
  for (const [label, raw] of [
    ['null', 'null'],
    ['array', '[1, 2]'],
    ['string', '"ψίθυρος"'],
    ['number', '42'],
  ]) {
    const dir = tmpDataDir();
    const file = privateFile(dir, 'g1', 'u1');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);

    const store = createStore({ dataDir: dir });
    const { result, logs } = await withCapturedLogs(() => {
      const priv = structuredClone(store.getPrivate('g1', 'u1'));
      // every private operation works on the replacement, none throws
      store.bumpPrivateReplies('g1', 'u1', '2026-09-29');
      store.pushPrivateBuffer('g1', 'u1', { id: 'm1', content: 'γεια' });
      return priv;
    });
    assert.deepEqual(result, EMPTY_PRIVATE, label);
    assert.deepEqual(store.getPrivateBuffer('g1', 'u1').map((m) => m.id), ['m1'], label);

    const warnings = logs.filter((l) => l.msg === 'store: private file replaced');
    assert.equal(warnings.length, 1, `${label}: warned once`);
    assert.equal(warnings[0].guildId, 'g1');
    assert.equal(warnings[0].reason, 'malformed');
    assert.equal(warnings[0].userId, undefined, `${label}: no member id in the log`);
    assert.deepEqual(store.validate(), [], `${label}: still valid JSON, validate() unchanged`);
  }
});

test('applyPrivateOps: relationship, interests and details land in the private file; character/style/aliases/portrait are ignored', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const priv = store.applyPrivateOps(
    'g1',
    'u1',
    {
      relationship: 'Confides in the persona',
      character: 'should not land',
      style: 'should not land',
      aliases: { add: ['Ally'] },
      portrait: 'should not land',
      interests: { add: [{ topic: 'Chess', note: 'plays weekly' }] },
      details: { add: ['Owns a cat', 'Plays guitar'] },
    },
    { fieldChars: 300, maxInterests: 12, topicChars: 40, noteChars: 120, maxDetails: 15, now: 1000 },
  );

  assert.equal(priv.relationship, 'Confides in the persona');
  assert.equal(priv.interests.length, 1);
  assert.equal(priv.interests[0].topic, 'Chess');
  assert.deepEqual(priv.details.map((d) => d.id), [1, 2]);
  assert.equal(priv.detailsSeq, 3);
  for (const key of ['character', 'style', 'aliases', 'portrait']) assert.equal(key in priv, false, key);

  // the public profile is never touched by private ops
  const pub = store.getUser('g1', 'u1');
  assert.equal(pub.relationship, '');
  assert.deepEqual(pub.interests, []);
  assert.deepEqual(pub.details, []);
  assert.deepEqual(pub.aliases, []);

  store.flush();
  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.getPrivate('g1', 'u1').relationship, 'Confides in the persona');
});

test('applyPrivateOps: an empty relationship never blanks the stored one; garbage ops never throw', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.applyPrivateOps('g1', 'u1', { relationship: 'Old friend' }, { fieldChars: 300 });
  store.applyPrivateOps('g1', 'u1', { relationship: '   ' }, { fieldChars: 300 });
  assert.doesNotThrow(() => store.applyPrivateOps('g1', 'u1', null, {}));
  assert.doesNotThrow(() => store.applyPrivateOps('g1', 'u1', { interests: [], details: 'x' }));
  assert.equal(store.getPrivate('g1', 'u1').relationship, 'Old friend');
});

test('adjustPrivateAffinity: starts at 0, clamps the delta and the score, never touches the public affinity', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.adjustAffinity('g1', 'u1', 4, 'public reason', { maxDelta: 5, historySize: 5, now: 1000 });

  const first = store.adjustPrivateAffinity('g1', 'u1', 50, 'shared a secret', { maxDelta: 5, historySize: 5, now: 2000 });
  assert.equal(first.score, 5);
  assert.equal(first.reason, 'shared a secret');
  assert.equal(first.history.length, 1);

  let last;
  for (let i = 0; i < 30; i += 1) {
    last = store.adjustPrivateAffinity('g1', 'u1', 5, 'again', { maxDelta: 5, historySize: 5, now: 3000 + i });
  }
  assert.equal(last.score, 100);
  assert.equal(last.history.length, 5);
  assert.deepEqual(store.getPrivate('g1', 'u1').affinity, last);

  assert.equal(store.getUser('g1', 'u1').affinity.score, 4);
});

test('addPrivateEpisodes: appends via mergeEpisodes to the private file only', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  const added = store.addPrivateEpisodes('g1', 'u1', [{ what: 'told the persona a secret' }], {
    maxEpisodes: 20,
    maxNew: 3,
    now: 1000,
  });
  assert.equal(added, 1);
  assert.equal(store.getPrivate('g1', 'u1').episodes[0].what, 'told the persona a secret');
  assert.deepEqual(store.getUser('g1', 'u1').episodes, []);
  assert.equal(store.addPrivateEpisodes('g1', 'u1', [], { maxEpisodes: 20, now: 2000 }), 0);
});

test('bumpPrivateReplies: counts within a day, rolls over on a new day, persists', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.bumpPrivateReplies('g1', 'u1', '2026-09-29'), { day: '2026-09-29', count: 1 });
  assert.deepEqual(store.bumpPrivateReplies('g1', 'u1', '2026-09-29'), { day: '2026-09-29', count: 2 });
  assert.deepEqual(store.bumpPrivateReplies('g1', 'u1', '2026-09-30'), { day: '2026-09-30', count: 1 });
  store.flush();
  const storeB = createStore({ dataDir: dir });
  assert.deepEqual(storeB.getPrivate('g1', 'u1').replies, { day: '2026-09-30', count: 1, noticedDay: '' });
});

test('markPrivateNoticed: records the day the cap notice was posted, keeps the reply count', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.bumpPrivateReplies('g1', 'u1', '2026-09-29');
  store.markPrivateNoticed('g1', 'u1', '2026-09-29');
  assert.deepEqual(store.getPrivate('g1', 'u1').replies, { day: '2026-09-29', count: 1, noticedDay: '2026-09-29' });
  store.flush();
  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.getPrivate('g1', 'u1').replies.noticedDay, '2026-09-29');
});

test('private buffer: push, info, consume empties it; info on a missing file creates nothing', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.privateBufferInfo('g1', 'u1'), { size: 0 });
  assert.deepEqual(store.getPrivateBuffer('g1', 'u1'), []);
  assert.equal(store.getPrivate('g1', 'u1'), null);

  store.pushPrivateBuffer('g1', 'u1', { id: 'm1', content: 'γεια', ts: 1000 });
  store.pushPrivateBuffer('g1', 'u1', { id: 'm2', content: 'hello', ts: 2000 });
  assert.deepEqual(store.privateBufferInfo('g1', 'u1'), { size: 2 });

  store.flush();
  const storeB = createStore({ dataDir: dir });
  const taken = storeB.getPrivateBuffer('g1', 'u1');
  assert.deepEqual(taken.map((m) => m.id), ['m1', 'm2']);
  storeB.shiftPrivateBuffer('g1', 'u1', taken);
  assert.deepEqual(storeB.privateBufferInfo('g1', 'u1'), { size: 0 });
  storeB.flush();
  assert.deepEqual(createStore({ dataDir: dir }).getPrivate('g1', 'u1').buffer, []);
});

test('pushPrivateBuffer: an optional maxLength drops the oldest entries', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  for (let i = 1; i <= 5; i += 1) store.pushPrivateBuffer('g1', 'u1', { id: `m${i}`, ts: i }, 3);
  assert.deepEqual(store.getPrivate('g1', 'u1').buffer.map((m) => m.id), ['m3', 'm4', 'm5']);
});

test('pushPrivateBuffer: returns how many oldest entries the cap dropped, 0 under it or without one', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const dropped = [];
  for (let i = 1; i <= 5; i += 1) dropped.push(store.pushPrivateBuffer('g1', 'u1', { id: `m${i}`, ts: i }, 3));
  assert.deepEqual(dropped, [0, 0, 0, 1, 1]);
  assert.equal(store.pushPrivateBuffer('g1', 'u2', { id: 'm1', ts: 1 }), 0);
});

test('listPrivate: ids with a private file, on disk or only cached', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.applyPrivateOps('g1', 'u1', {});
  store.flush();
  store.applyPrivateOps('g1', 'u2', {});
  assert.deepEqual(store.listPrivate('g1').sort(), ['u1', 'u2']);
  assert.deepEqual(store.listPrivate('g2'), []);
});

test('forgetPrivate: deletes the private file from cache and disk, the public profile stays', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyPrivateOps('g1', 'u1', { relationship: 'secret' }, { fieldChars: 300 });
  store.flush();
  store.forgetPrivate('g1', 'u1');
  assert.equal(store.getPrivate('g1', 'u1'), null);
  assert.equal(fs.existsSync(privateFile(dir, 'g1', 'u1')), false);
  assert.notEqual(store.getUser('g1', 'u1'), null);
  assert.doesNotThrow(() => store.forgetPrivate('g1', 'never'));
});

test('forgetUser: also deletes the private file', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Alice', 1000);
  store.applyPrivateOps('g1', 'u1', { relationship: 'secret' }, { fieldChars: 300 });
  store.applyPrivateOps('g1', 'u2', {});
  store.flush();
  store.forgetUser('g1', 'u1');
  assert.equal(store.getUser('g1', 'u1'), null);
  assert.equal(store.getPrivate('g1', 'u1'), null);
  assert.equal(fs.existsSync(privateFile(dir, 'g1', 'u1')), false);
  assert.deepEqual(store.listPrivate('g1'), ['u2']);
});

test('wipeGuild: removes the private directory, cache and disk, leaves other guilds alone', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  seedGuild(store);
  store.applyPrivateOps('g1', 'u1', { relationship: 'secret' }, { fieldChars: 300 });
  store.flush();
  store.pushPrivateBuffer('g1', 'u2', { id: 'm1', ts: 1000 }); // only cached, never flushed
  store.applyPrivateOps('g2', 'u9', {});

  const counts = store.wipeGuild('g1');
  assert.deepEqual(counts, { users: 2, channels: 2, loreRemoved: 1, loreKept: 1, bufferMessages: 2 });
  assert.equal(fs.existsSync(path.join(dir, 'guilds', 'g1', 'private')), false);
  assert.equal(store.getPrivate('g1', 'u1'), null);
  assert.equal(store.getPrivate('g1', 'u2'), null);
  assert.deepEqual(store.listPrivate('g1'), []);
  assert.notEqual(store.getPrivate('g2', 'u9'), null);

  store.flush();
  assert.equal(fs.existsSync(path.join(dir, 'guilds', 'g1', 'private')), false);
  assert.deepEqual(createStore({ dataDir: dir }).listPrivate('g1'), []);
  assert.deepEqual(createStore({ dataDir: dir }).listPrivate('g2'), ['u9']);
});

test('validate: reports an unparsable private file like a broken profile', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.applyPrivateOps('g1', 'u1', {});
  store.flush();
  fs.writeFileSync(privateFile(dir, 'g1', 'u1'), '{ not json');
  assert.deepEqual(store.validate(), ['guilds/g1/private/u1.json']);
});

test('getPrivateBuffer: a copy of the buffer, oldest first; [] and no file when there is no private layer', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.getPrivateBuffer('g1', 'u1'), []);
  assert.equal(store.getPrivate('g1', 'u1'), null);

  store.pushPrivateBuffer('g1', 'u1', { id: 'm1', ts: 1000 });
  store.pushPrivateBuffer('g1', 'u1', { id: 'm2', ts: 2000 });
  const copy = store.getPrivateBuffer('g1', 'u1');
  assert.deepEqual(copy.map((m) => m.id), ['m1', 'm2']);
  copy.pop();
  assert.equal(store.privateBufferInfo('g1', 'u1').size, 2, 'mutating the copy never touches the stored buffer');
});

test('shiftPrivateBuffer: drops the consumed entries by id and persists; a missing layer is left alone', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.shiftPrivateBuffer('g1', 'nobody', [{ id: 'm1' }]);
  assert.equal(store.getPrivate('g1', 'nobody'), null, 'no file is created');

  for (let i = 1; i <= 4; i += 1) store.pushPrivateBuffer('g1', 'u1', { id: `m${i}`, ts: i });
  store.flush();
  const consumed = store.getPrivateBuffer('g1', 'u1').slice(0, 3);
  store.pushPrivateBuffer('g1', 'u1', { id: 'm5', ts: 5 }, 4); // an arrival trims m1 off the front
  store.shiftPrivateBuffer('g1', 'u1', consumed);
  store.flush();
  assert.deepEqual(createStore({ dataDir: dir }).getPrivateBuffer('g1', 'u1').map((m) => m.id), ['m4', 'm5']);
});

test('touchPrivateSeen: stamps lastSeen every time, firstSeen only while empty; never touches the public profile', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Zoé', 500);
  store.touchPrivateSeen('g1', 'u1', Date.UTC(2026, 0, 1));
  store.touchPrivateSeen('g1', 'u1', Date.UTC(2026, 0, 5));
  store.flush();
  const priv = createStore({ dataDir: dir }).getPrivate('g1', 'u1');
  assert.equal(priv.firstSeen, new Date(Date.UTC(2026, 0, 1)).toISOString());
  assert.equal(priv.lastSeen, new Date(Date.UTC(2026, 0, 5)).toISOString());
  assert.equal(store.getUser('g1', 'u1').lastSeen, new Date(500).toISOString());
});

// --- affinity decay sweep and relationshipScore -------------------------------

const DECAY_DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DECAY_CFG = { decayPerDay: 0.04, decayPower: 1 };

function writeRaw(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value)); // compact: a flush would rewrite it pretty-printed
}

function userFileOf(dir, guildId, userId) {
  return path.join(dir, 'guilds', guildId, 'users', `${userId}.json`);
}

test('decayAffinities: decays public and private profiles, marks only the changed ones dirty', () => {
  const dir = tmpDataDir();
  const dayAgo = new Date(DECAY_NOW - DECAY_DAY_MS).toISOString();
  const hourAgo = new Date(DECAY_NOW - 3600_000).toISOString();
  writeRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', names: ['Zoé'], affinity: { score: 100, reason: 'r', history: [], decayedAt: dayAgo } });
  writeRaw(userFileOf(dir, 'g1', 'u2'), { id: 'u2', names: ['Ἄννα'], affinity: { score: 50, reason: '', history: [], decayedAt: hourAgo } });
  writeRaw(privateFile(dir, 'g1', 'u1'), { relationship: '', affinity: { score: -64, reason: '', history: [], decayedAt: dayAgo } });
  const untouchedRaw = fs.readFileSync(userFileOf(dir, 'g1', 'u2'), 'utf8');

  const store = createStore({ dataDir: dir });
  const counts = store.decayAffinities('g1', DECAY_NOW, DECAY_CFG);
  assert.deepEqual(counts, { profiles: 3, decayed: 2 });
  assert.equal(store.getUser('g1', 'u1').affinity.score, 96);
  assert.equal(store.getUser('g1', 'u1').affinity.decayedAt, new Date(DECAY_NOW).toISOString());
  assert.equal(store.getPrivate('g1', 'u1').affinity.score, -62.36);
  assert.equal(store.getUser('g1', 'u2').affinity.score, 50);

  store.flush();
  assert.equal(fs.readFileSync(userFileOf(dir, 'g1', 'u2'), 'utf8'), untouchedRaw, 'an unchanged profile is not rewritten');
  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.getUser('g1', 'u1').affinity.score, 96, 'the decayed public score was flushed');
  assert.equal(storeB.getPrivate('g1', 'u1').affinity.score, -62.36, 'the decayed private score was flushed');
});

test('decayAffinities: the first sweep only stamps the baseline -- persisted, but nothing counts as decayed', () => {
  const dir = tmpDataDir();
  writeRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', names: ['Zoé'], affinity: { score: 80, reason: '', history: [] } });
  writeRaw(privateFile(dir, 'g1', 'u1'), { relationship: '', affinity: { score: 20, reason: '', history: [] } });

  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.decayAffinities('g1', DECAY_NOW, DECAY_CFG), { profiles: 2, decayed: 0 });
  store.flush();

  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.getUser('g1', 'u1').affinity.score, 80);
  assert.equal(storeB.getUser('g1', 'u1').affinity.decayedAt, new Date(DECAY_NOW).toISOString());
  assert.equal(storeB.getPrivate('g1', 'u1').affinity.decayedAt, new Date(DECAY_NOW).toISOString());
  assert.deepEqual(storeB.decayAffinities('g1', DECAY_NOW + DECAY_DAY_MS, DECAY_CFG), { profiles: 2, decayed: 2 });
});

test('decayAffinities: decay off writes nothing; no profiles -> zero counts', () => {
  const dir = tmpDataDir();
  writeRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', affinity: { score: 80, reason: '', history: [] } });
  const raw = fs.readFileSync(userFileOf(dir, 'g1', 'u1'), 'utf8');
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.decayAffinities('g1', DECAY_NOW, { decayPerDay: 0 }), { profiles: 1, decayed: 0 });
  store.flush();
  assert.equal(fs.readFileSync(userFileOf(dir, 'g1', 'u1'), 'utf8'), raw);
  assert.deepEqual(store.decayAffinities('empty-guild', DECAY_NOW, DECAY_CFG), { profiles: 0, decayed: 0 });
});

test('adjustAffinity / adjustPrivateAffinity: keep decayedAt when they fold a delta', () => {
  const dir = tmpDataDir();
  const stamp = new Date(DECAY_NOW).toISOString();
  writeRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', affinity: { score: 10, reason: '', history: [], decayedAt: stamp } });
  writeRaw(privateFile(dir, 'g1', 'u1'), { affinity: { score: 10, reason: '', history: [], decayedAt: stamp } });
  const store = createStore({ dataDir: dir });
  assert.equal(store.adjustAffinity('g1', 'u1', 5, 'x', { maxDelta: 15, historySize: 10, now: DECAY_NOW }).decayedAt, stamp);
  assert.equal(store.adjustPrivateAffinity('g1', 'u1', 5, 'x', { maxDelta: 15, historySize: 10, now: DECAY_NOW }).decayedAt, stamp);
  assert.equal(store.getUser('g1', 'u1').affinity.decayedAt, stamp);
  assert.equal(store.getPrivate('g1', 'u1').affinity.decayedAt, stamp);
});

test('normalisation on read keeps decayedAt and relationshipScore, public and private', () => {
  const dir = tmpDataDir();
  const stamp = new Date(DECAY_NOW).toISOString();
  writeRaw(userFileOf(dir, 'g1', 'u1'), { id: 'u1', relationship: 'x', relationshipScore: 42, affinity: { score: 10, reason: '', history: [], decayedAt: stamp } });
  writeRaw(privateFile(dir, 'g1', 'u1'), { relationship: 'y', relationshipScore: -9, affinity: { score: 10, decayedAt: stamp } });
  const store = createStore({ dataDir: dir });
  assert.equal(store.getUser('g1', 'u1').relationshipScore, 42);
  assert.equal(store.getUser('g1', 'u1').affinity.decayedAt, stamp);
  assert.equal(store.getPrivate('g1', 'u1').relationshipScore, -9);
  assert.equal(store.getPrivate('g1', 'u1').affinity.decayedAt, stamp);
});

test('applyProfileOps: stamps relationshipScore when the relationship text is written, not otherwise', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'u1', 'Zoé', 1000);
  store.adjustAffinity('g1', 'u1', 30, 'x', { maxDelta: 30, historySize: 10, now: 1000 });

  store.applyProfileOps('g1', 'u1', { character: 'calm', relationship: '  ' }, { fieldChars: 400 });
  assert.equal(store.getUser('g1', 'u1').relationshipScore, undefined, 'a blank relationship writes nothing');

  store.applyProfileOps('g1', 'u1', { relationship: 'Close friends' }, { fieldChars: 400 });
  assert.equal(store.getUser('g1', 'u1').relationshipScore, 30, 'falls back to the stored score');

  store.applyProfileOps('g1', 'u1', { relationship: 'Closer still' }, { fieldChars: 400, relationshipScore: 44.5 });
  assert.equal(store.getUser('g1', 'u1').relationshipScore, 44.5, 'opts.relationshipScore wins');

  store.applyProfileOps('g1', 'u1', { details: { add: ['owns a cat'] } }, { fieldChars: 400, relationshipScore: 99 });
  assert.equal(store.getUser('g1', 'u1').relationshipScore, 44.5, 'no relationship text -> untouched');
});

test('applyPrivateOps: stamps relationshipScore when the private relationship text is written, not otherwise', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.adjustPrivateAffinity('g1', 'u1', 12, 'x', { maxDelta: 15, historySize: 10, now: 1000 });

  store.applyPrivateOps('g1', 'u1', { details: { add: ['a secret'] } }, { fieldChars: 400, relationshipScore: 50 });
  assert.equal(store.getPrivate('g1', 'u1').relationshipScore, undefined);

  store.applyPrivateOps('g1', 'u1', { relationship: 'Trusts the persona' }, { fieldChars: 400 });
  assert.equal(store.getPrivate('g1', 'u1').relationshipScore, 12, 'falls back to the private score');

  store.applyPrivateOps('g1', 'u1', { relationship: 'Trusts the persona more' }, { fieldChars: 400, relationshipScore: 61 });
  assert.equal(store.getPrivate('g1', 'u1').relationshipScore, 61);
});
