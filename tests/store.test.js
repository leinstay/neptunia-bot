// Tests for src/memory/store.js: JSON-file persistence for profiles, guild
// memory, the observation buffer and scheduler state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/memory/store.js';

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
  const profile = store.updateUser('g1', 'u1', { character: 'дерзкая', interests: 'игры' });
  assert.equal(profile.character, 'дерзкая');
  assert.equal(profile.interests, 'игры');
  assert.ok(profile.updatedAt);
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
  assert.deepEqual(guild, { patterns: '', starters: '', injokes: [], self: [], updatedAt: null });
});

test('updateGuild: merges fields and stamps updatedAt', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = store.updateGuild('g1', { patterns: 'мемы про котов' });
  assert.equal(guild.patterns, 'мемы про котов');
  assert.ok(guild.updatedAt);
});

test('pushBuffer: caps the buffer length, dropping the oldest entries', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  for (let i = 0; i < 5; i += 1) store.pushBuffer('g1', { i }, 3);
  const buffer = store.getBuffer('g1');
  assert.deepEqual(buffer.map((m) => m.i), [2, 3, 4]);
});

test('shiftBuffer: drops the first N buffered messages', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  for (let i = 0; i < 5; i += 1) store.pushBuffer('g1', { i }, 100);
  store.shiftBuffer('g1', 2);
  const buffer = store.getBuffer('g1');
  assert.deepEqual(buffer.map((m) => m.i), [2, 3, 4]);
});

test('flush + a new store instance: profiles, guild memory and buffer survive a "restart"', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  storeA.touchUser('g1', 'u1', 'Alice', 1000);
  storeA.updateUser('g1', 'u1', { character: 'дерзкая' });
  storeA.updateGuild('g1', { patterns: 'мемы' });
  storeA.pushBuffer('g1', { text: 'hi' }, 100);
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  const profile = storeB.getUser('g1', 'u1');
  assert.equal(profile.character, 'дерзкая');
  assert.deepEqual(profile.names, ['Alice']);
  assert.equal(storeB.getGuild('g1').patterns, 'мемы');
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

test('countUsers: returns 0 when the guild has no users directory yet', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.equal(store.countUsers('unknown-guild'), 0);
});
