// Persistent memory on plain JSON files under data/ — survives restarts, hot
// reloads and prompt edits; nothing in the codebase ever wipes it implicitly.
//
//   data/state.json                          scheduler times, token calibration, daily LLM counter
//   data/guilds/<guildId>/guild.json         how this server talks, in-jokes, what the persona said about itself
//   data/guilds/<guildId>/buffer.json        messages observed since the last memory update
//   data/guilds/<guildId>/users/<userId>.json  one profile per active member
//   data/guilds/<guildId>/channels/<channelId>.json  one entry per channel the persona has seen (the server map)
//
// Everything is cached in memory, marked dirty on change and flushed on a
// timer and on shutdown. Writes are atomic (temp file + rename) so a crash
// mid-write never corrupts a profile.

import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { emptyAffinity, applyDelta } from './affinity.js';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('store: unreadable file, using fallback', { file, error: err });
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse to rename over a file an antivirus holds open.
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
    fs.rmSync(tmp, { force: true });
  }
}

export function emptyProfile(id) {
  return {
    id,
    names: [],
    firstSeen: null,
    lastSeen: null,
    messageCount: 0,
    character: '',
    interests: '',
    style: '',
    details: [],
    relationship: '',
    affinity: emptyAffinity(),
    updatedAt: null,
  };
}

export function emptyGuild() {
  return { patterns: '', starters: '', injokes: [], self: [], updatedAt: null };
}

export function emptyChannel(id) {
  return {
    id,
    name: '',
    category: null,
    topic: null,
    purpose: '',
    topics: '',
    tone: '',
    days: {},
    messageCount: 0,
    lastMessageAt: null,
    updatedAt: null,
  };
}

/** Keep only the newest `max` UTC-date keys of a `days` counter map. */
function trimDays(days, max) {
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete days[key];
}

export function createStore({ dataDir }) {
  const entries = new Map(); // file path -> { value, dirty }

  function entry(file, fallback) {
    let item = entries.get(file);
    if (!item) {
      item = { value: readJson(file, fallback()), dirty: false };
      entries.set(file, item);
    }
    return item;
  }

  const guildDir = (guildId) => path.join(dataDir, 'guilds', String(guildId));
  const userFile = (guildId, userId) => path.join(guildDir(guildId), 'users', `${userId}.json`);
  const guildFile = (guildId) => path.join(guildDir(guildId), 'guild.json');
  const bufferFile = (guildId) => path.join(guildDir(guildId), 'buffer.json');
  const channelsDir = (guildId) => path.join(guildDir(guildId), 'channels');
  const channelFile = (guildId, channelId) => path.join(channelsDir(guildId), `${channelId}.json`);
  const mediaCacheFile = (guildId) => path.join(guildDir(guildId), 'media.json');
  const stateFile = path.join(dataDir, 'state.json');

  const stateEntry = entry(stateFile, () => ({}));

  const store = {
    state: {
      get data() {
        return stateEntry.value;
      },
      markDirty() {
        stateEntry.dirty = true;
      },
    },

    /** Profile of a member, or null when the persona has never seen them. */
    getUser(guildId, userId) {
      const file = userFile(guildId, userId);
      if (!entries.has(file) && !fs.existsSync(file)) return null;
      return entry(file, () => emptyProfile(String(userId))).value;
    },

    /** Record that a member spoke: names, counters, timestamps. Creates the profile. */
    touchUser(guildId, userId, name, at = Date.now()) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const profile = item.value;
      // Current display name first, a few previous ones after it.
      if (name) profile.names = [name, ...profile.names.filter((n) => n !== name)].slice(0, 5);
      profile.firstSeen ??= new Date(at).toISOString();
      profile.lastSeen = new Date(at).toISOString();
      profile.messageCount += 1;
      item.dirty = true;
      return profile;
    },

    /**
     * Merge LLM-extracted fields into a profile. `affinity` is never taken
     * from here — it only ever changes through `adjustAffinity`, which keeps
     * its clamping and history bookkeeping in one place.
     */
    updateUser(guildId, userId, fields) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const { affinity, ...safeFields } = fields ?? {};
      Object.assign(item.value, safeFields, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /** Fold one delta into a member's stored affinity (see src/memory/affinity.js). */
    adjustAffinity(guildId, userId, delta, reason, opts) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const current = item.value.affinity ?? emptyAffinity();
      const next = applyDelta(current, delta, reason, opts);
      item.value.affinity = next;
      item.dirty = true;
      return next;
    },

    forgetUser(guildId, userId) {
      const file = userFile(guildId, userId);
      entries.delete(file);
      fs.rmSync(file, { force: true });
    },

    countUsers(guildId) {
      try {
        return fs.readdirSync(path.join(guildDir(guildId), 'users')).filter((f) => f.endsWith('.json')).length;
      } catch {
        return 0;
      }
    },

    /** Ids of every guild that has anything stored on disk or in the cache. */
    listGuilds() {
      const ids = new Set();
      try {
        for (const name of fs.readdirSync(path.join(dataDir, 'guilds'))) ids.add(name);
      } catch {
        // no guilds directory yet
      }
      const prefix = path.join(dataDir, 'guilds') + path.sep;
      for (const file of entries.keys()) {
        if (file.startsWith(prefix)) ids.add(file.slice(prefix.length).split(path.sep)[0]);
      }
      return [...ids];
    },

    getGuild(guildId) {
      return entry(guildFile(guildId), emptyGuild).value;
    },

    updateGuild(guildId, fields) {
      const item = entry(guildFile(guildId), emptyGuild);
      Object.assign(item.value, fields, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /** One channel's stored entry (the server map), or null when never seen. */
    getChannel(guildId, channelId) {
      const file = channelFile(guildId, channelId);
      if (!entries.has(file) && !fs.existsSync(file)) return null;
      return entry(file, () => emptyChannel(String(channelId))).value;
    },

    /** Every channel entry stored for a guild, cached or on disk. */
    listChannels(guildId) {
      const ids = new Set();
      try {
        for (const name of fs.readdirSync(channelsDir(guildId))) {
          if (name.endsWith('.json')) ids.add(name.slice(0, -5));
        }
      } catch {
        // no channels directory yet
      }
      const prefix = channelsDir(guildId) + path.sep;
      for (const file of entries.keys()) {
        if (file.startsWith(prefix)) ids.add(path.basename(file, '.json'));
      }
      return [...ids].map((id) => entry(channelFile(guildId, id), () => emptyChannel(String(id))).value);
    },

    /**
     * Record one observed message in a channel: Discord facts (name, category,
     * topic), counters and the per-day activity histogram. Creates the entry.
     */
    touchChannel(guildId, channelId, facts, ts = Date.now()) {
      const item = entry(channelFile(guildId, channelId), () => emptyChannel(String(channelId)));
      const channel = item.value;
      const { name, category = null, topic = null } = facts ?? {};
      if (name) channel.name = name;
      channel.category = category;
      channel.topic = topic;
      channel.messageCount += 1;
      channel.lastMessageAt = channel.lastMessageAt === null ? ts : Math.max(channel.lastMessageAt, ts);
      const dateKey = new Date(ts).toISOString().slice(0, 10);
      channel.days[dateKey] = (channel.days[dateKey] ?? 0) + 1;
      trimDays(channel.days, 30);
      item.dirty = true;
      return channel;
    },

    /**
     * Merge analyzer-extracted fields into a channel entry. Only `purpose`,
     * `topics`, `tone` travel through here — everything else (counters,
     * Discord facts) is stripped, mirroring `updateUser`.
     */
    updateChannel(guildId, channelId, fields) {
      const item = entry(channelFile(guildId, channelId), () => emptyChannel(String(channelId)));
      const patch = {};
      for (const key of ['purpose', 'topics', 'tone']) {
        if (typeof fields?.[key] === 'string') patch[key] = fields[key];
      }
      Object.assign(item.value, patch, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /**
     * The describer's cache for one guild (src/memory/describe.js): a plain
     * object map keyed by attachment/embed id, insertion order doubling as
     * LRU recency order. Callers mutate the returned object directly (same
     * pattern as `state.data`) and call `markMediaCacheDirty` afterwards.
     */
    getMediaCache(guildId) {
      return entry(mediaCacheFile(guildId), () => ({})).value;
    },

    markMediaCacheDirty(guildId) {
      const item = entries.get(mediaCacheFile(guildId));
      if (item) item.dirty = true;
    },

    getBuffer(guildId) {
      return entry(bufferFile(guildId), () => []).value;
    },

    pushBuffer(guildId, message, maxLength) {
      const item = entry(bufferFile(guildId), () => []);
      item.value.push(message);
      if (item.value.length > maxLength) item.value.splice(0, item.value.length - maxLength);
      item.dirty = true;
    },

    /** Drop the first `count` buffered messages (the ones a memory update consumed). */
    shiftBuffer(guildId, count) {
      const item = entry(bufferFile(guildId), () => []);
      item.value.splice(0, count);
      item.dirty = true;
    },

    flush() {
      for (const [file, item] of entries) {
        if (!item.dirty) continue;
        try {
          writeJsonAtomic(file, item.value);
          item.dirty = false;
        } catch (err) {
          log.error('store: flush failed', { file, error: err });
        }
      }
    },
  };

  return store;
}
