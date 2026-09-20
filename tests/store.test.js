// Tests for src/memory/store.js: JSON-file persistence for profiles, guild
// memory, the observation buffer and scheduler state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/memory/store.js';
import { emptyAffinity } from '../src/memory/affinity.js';

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
  const profile = store.updateUser('g1', 'u1', { character: 'τολμηρή', interests: 'παιχνίδια' });
  assert.equal(profile.character, 'τολμηρή');
  assert.equal(profile.interests, 'παιχνίδια');
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
  const guild = store.updateGuild('g1', { patterns: 'μιμίδια για γάτες' });
  assert.equal(guild.patterns, 'μιμίδια για γάτες');
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

test('wipeGuild: removes profiles, guild memory, channels, buffer and analyzer lore; keeps owner lore, media cache and non-warm-up state', () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  seedGuild(storeA);
  storeA.flush();

  const counts = storeA.wipeGuild('g1');
  assert.deepEqual(counts, { users: 2, channels: 2, loreRemoved: 1, loreKept: 1, bufferMessages: 2 });

  // cache is immediately usable
  assert.equal(storeA.getUser('g1', 'u1'), null);
  assert.equal(storeA.getUser('g1', 'u2'), null);
  assert.deepEqual(storeA.getGuild('g1'), { patterns: '', starters: '', injokes: [], self: [], updatedAt: null });
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
  assert.deepEqual(storeB.getGuild('g1'), { patterns: '', starters: '', injokes: [], self: [], updatedAt: null });
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
