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
//
// `forgetUser` and `wipeGuild` are the only two functions in the whole
// project allowed to delete stored memory (see src/admin.js, the owner-only
// `/nep memory forget` and `/nep memory wipe` commands).

import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { emptyAffinity, applyDelta } from './affinity.js';
import { mergeEpisodes } from './episodes.js';
import { upsertLore } from './lore.js';
import { applyInterestOps, migrateInterests } from './interests.js';
import { applyDetailOps, migrateDetails } from './details.js';

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
    interests: [],
    style: '',
    details: [],
    detailsSeq: 1, // the next id an atomic detail item gets -- never reused, even after a remove
    relationship: '',
    affinity: emptyAffinity(),
    episodes: [],
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

/** Upgrade a profile's `interests` field in place: a legacy prose string
 * becomes the atomic-item array (see src/memory/interests.js#migrateInterests);
 * anything not already an array becomes `[]`. Never marks anything dirty --
 * the caller (`getUser`/`applyProfileOps`) decides whether this is persisted. */
function migrateProfileInterests(profile) {
  if (typeof profile.interests === 'string') {
    profile.interests = migrateInterests(profile.interests);
  } else if (!Array.isArray(profile.interests)) {
    profile.interests = [];
  }
}

/** Upgrade a profile's `details` field in place: a legacy array of bare
 * strings becomes the atomic-item array (see
 * src/memory/details.js#migrateDetails), assigning fresh ids off the
 * profile's own `detailsSeq` counter; anything not already an array becomes
 * `[]`. A no-op once `details` is already item-shaped. Never marks anything
 * dirty -- the caller (`getUser`/`applyProfileOps`) decides whether this is
 * persisted. */
function migrateProfileDetails(profile) {
  if (!Number.isInteger(profile.detailsSeq) || profile.detailsSeq < 1) profile.detailsSeq = 1;
  if (!Array.isArray(profile.details)) {
    profile.details = [];
    return;
  }
  if (profile.details.some((d) => typeof d === 'string')) {
    const { items, nextId } = migrateDetails(profile.details, profile.detailsSeq);
    profile.details = items;
    profile.detailsSeq = nextId;
  }
}

function clampString(value, maxChars) {
  const cap = Number.isInteger(maxChars) ? maxChars : Infinity;
  return String(value ?? '').trim().slice(0, cap);
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

  /** Every id found under `dir`'s `.json` files, on disk or only cached (no side effects on the cache). */
  function idsUnder(dir) {
    const ids = new Set();
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.json')) ids.add(name.slice(0, -5));
      }
    } catch {
      // the directory does not exist yet
    }
    const prefix = dir + path.sep;
    for (const file of entries.keys()) {
      if (file.startsWith(prefix)) ids.add(path.basename(file, '.json'));
    }
    return [...ids];
  }

  function flushAll() {
    for (const [file, item] of entries) {
      if (!item.dirty) continue;
      try {
        writeJsonAtomic(file, item.value);
        item.dirty = false;
      } catch (err) {
        log.error('store: flush failed', { file, error: err });
      }
    }
  }

  const guildDir = (guildId) => path.join(dataDir, 'guilds', String(guildId));
  const userFile = (guildId, userId) => path.join(guildDir(guildId), 'users', `${userId}.json`);
  const guildFile = (guildId) => path.join(guildDir(guildId), 'guild.json');
  const bufferFile = (guildId) => path.join(guildDir(guildId), 'buffer.json');
  const channelsDir = (guildId) => path.join(guildDir(guildId), 'channels');
  const channelFile = (guildId, channelId) => path.join(channelsDir(guildId), `${channelId}.json`);
  const mediaCacheFile = (guildId) => path.join(guildDir(guildId), 'media.json');
  const loreFile = (guildId) => path.join(guildDir(guildId), 'lore.json');
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

    /**
     * Profile of a member, or null when the persona has never seen them. A
     * legacy profile whose `interests` is still the old prose string, or
     * whose `details` is still a bare array of strings, is migrated to the
     * atomic-item array in memory here (see
     * src/memory/interests.js#migrateInterests and
     * src/memory/details.js#migrateDetails) -- persisted the next time
     * anything writes this profile, never wiped implicitly.
     */
    getUser(guildId, userId) {
      const file = userFile(guildId, userId);
      if (!entries.has(file) && !fs.existsSync(file)) return null;
      const item = entry(file, () => emptyProfile(String(userId)));
      migrateProfileInterests(item.value);
      migrateProfileDetails(item.value);
      return item.value;
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
     * its clamping and history bookkeeping in one place. `episodes` likewise
     * only ever changes through `addEpisodes` (src/memory/episodes.js), which
     * appends and evicts instead of overwriting. `interests`/`details`
     * likewise only ever change through `applyProfileOps` below, which merges
     * incrementally instead of overwriting wholesale.
     */
    updateUser(guildId, userId, fields) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const { affinity, episodes, interests, details, detailsSeq, ...safeFields } = fields ?? {};
      Object.assign(item.value, safeFields, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /**
     * Apply one analyzer batch's INCREMENTAL profile update (see
     * .claude/docs/prompt-contract.md, "The analyzer"): `character`/`style`/
     * `relationship` replace the stored text only when given as a non-empty
     * string, clamped to `opts.fieldChars` -- an absent or empty field never
     * blanks what is already stored. `ops.interests` (`{ add, update, seen,
     * remove }`) merges via src/memory/interests.js#applyInterestOps;
     * `ops.details` (`{ add, seen, remove }`) merges via
     * src/memory/details.js#applyDetailOps, which also advances the
     * profile's own `detailsSeq` id counter. `opts.seenAt` is the time of the
     * PERSON'S message that produced this sighting (falls back to `opts.now`,
     * then the wall clock) -- see the two modules' header comments for the
     * confirmation/date rules `opts.confirmGapHours` feeds. A legacy profile
     * whose `interests`/`details` is still the old shape is migrated first.
     * Tolerates garbage `ops`, never throws.
     * @param {string} guildId
     * @param {string} userId
     * @param {{ character?: string, style?: string, relationship?: string,
     *   interests?: { add?: object[], update?: object[], seen?: string[], remove?: string[] },
     *   details?: { add?: unknown[], seen?: unknown[], remove?: unknown[] } }} ops
     * @param {{ fieldChars?: number, maxInterests?: number, maxInterestsStored?: number, topicChars?: number,
     *   noteChars?: number, interestHalfLifeDays?: number, maxDetails?: number, maxDetailsStored?: number,
     *   detailHalfLifeDays?: number, confirmGapHours?: number, seenAt?: number, now?: number }} [opts]
     *   `maxInterestsStored`/`maxDetailsStored`/`interestHalfLifeDays`/`detailHalfLifeDays` drive the
     *   storage-cap-vs-shown-cap split and the rank decay -- see
     *   .claude/docs/prompt-contract.md, "More is stored than shown, and rank decays with age".
     * @returns {object} The updated profile.
     */
    applyProfileOps(guildId, userId, ops, opts = {}) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const profile = item.value;
      migrateProfileInterests(profile);
      migrateProfileDetails(profile);

      const seenAt = Number.isFinite(opts.seenAt) ? opts.seenAt : Number.isFinite(opts.now) ? opts.now : Date.now();

      for (const key of ['character', 'style', 'relationship']) {
        const value = ops?.[key];
        if (typeof value === 'string' && value.trim()) {
          profile[key] = clampString(value, opts.fieldChars);
        }
      }

      if (ops?.interests && typeof ops.interests === 'object' && !Array.isArray(ops.interests)) {
        profile.interests = applyInterestOps(profile.interests, ops.interests, {
          maxInterests: opts.maxInterests,
          maxInterestsStored: opts.maxInterestsStored,
          topicChars: opts.topicChars,
          noteChars: opts.noteChars,
          confirmGapHours: opts.confirmGapHours,
          halfLifeDays: opts.interestHalfLifeDays,
          seenAt,
        });
      }

      if (ops?.details && typeof ops.details === 'object' && !Array.isArray(ops.details)) {
        const { items, nextId } = applyDetailOps(profile.details, ops.details, {
          maxDetails: opts.maxDetails,
          maxDetailsStored: opts.maxDetailsStored,
          fieldChars: opts.fieldChars,
          confirmGapHours: opts.confirmGapHours,
          halfLifeDays: opts.detailHalfLifeDays,
          seenAt,
          nextId: profile.detailsSeq,
        });
        profile.details = items;
        profile.detailsSeq = nextId;
      }

      profile.updatedAt = new Date(opts.now ?? Date.now()).toISOString();
      item.dirty = true;
      return profile;
    },

    /**
     * Append freshly-extracted episodes to a member's profile via
     * src/memory/episodes.js#mergeEpisodes: validated, deduplicated against
     * what is already stored, then evicted back down to `opts.maxEpisodes`
     * (lowest weight, oldest first) if needed. Returns how many were added.
     */
    addEpisodes(guildId, userId, incoming, opts) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const { episodes, added } = mergeEpisodes(item.value.episodes, incoming, opts);
      if (added > 0) {
        item.value.episodes = episodes;
        item.dirty = true;
      }
      return added;
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

    /** Delete one member's profile, cache and disk alike. See also `wipeGuild` below. */
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

    /** Every stored lorebook entry of a guild (data/guilds/<id>/lore.json). Never auto-created empty on disk. */
    getLore(guildId) {
      return entry(loreFile(guildId), () => []).value;
    },

    /**
     * Merge `incoming` entries into the guild's lorebook via
     * src/memory/lore.js#upsertLore: an analyzer update never touches an
     * owner entry, an owner write always wins. Returns how many were
     * inserted or updated.
     */
    setLore(guildId, incoming, opts) {
      const item = entry(loreFile(guildId), () => []);
      const { entries: nextEntries, upserted } = upsertLore(item.value, incoming, opts);
      if (upserted > 0) {
        item.value = nextEntries;
        item.dirty = true;
      }
      return upserted;
    },

    /** Delete one lorebook entry by id. Returns whether anything was removed. */
    removeLore(guildId, id) {
      const item = entry(loreFile(guildId), () => []);
      const before = item.value.length;
      item.value = item.value.filter((lore) => lore.id !== id);
      const removed = item.value.length !== before;
      if (removed) item.dirty = true;
      return removed;
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

    /**
     * A deliberate, owner-only clean start for one guild's memory (see
     * src/admin.js `/nep memory wipe`). Together with `forgetUser` above,
     * this is the ONLY other place in the project allowed to delete stored
     * memory. Removes, from both the cache and disk: every user profile
     * (affinity and episodes included), `guild.json`, every channel entry,
     * the live observation buffer, and lorebook entries whose `source` is
     * `'analyzer'` (every entry, owner included, when `keepOwnerLore` is
     * false). Keeps, by default, owner lore (`source: 'owner'`) and the
     * media description cache, and always keeps everything in `state.json`
     * except `state.warmup`, which is cleared so the next warm-up run
     * starts from the top — token calibration, the daily LLM counter and
     * the spontaneous schedule survive untouched. Safe when some files
     * never existed; the store stays fully usable afterwards (a following
     * `touchUser`/`getGuild` works and persists), no restart required.
     * @param {string} guildId
     * @param {{ keepOwnerLore?: boolean, keepMediaCache?: boolean }} [opts]
     * @returns {{ users: number, channels: number, loreRemoved: number, loreKept: number, bufferMessages: number }}
     */
    wipeGuild(guildId, { keepOwnerLore = true, keepMediaCache = true } = {}) {
      const userIds = idsUnder(path.join(guildDir(guildId), 'users'));
      for (const id of userIds) {
        const file = userFile(guildId, id);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      const channelIds = idsUnder(channelsDir(guildId));
      for (const id of channelIds) {
        const file = channelFile(guildId, id);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      {
        const file = guildFile(guildId);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      const bufferFileName = bufferFile(guildId);
      const bufferMessages = entry(bufferFileName, () => []).value.length;
      entries.delete(bufferFileName);
      fs.rmSync(bufferFileName, { force: true });

      const loreItem = entry(loreFile(guildId), () => []);
      const storedLore = loreItem.value;
      const keptLore = keepOwnerLore ? storedLore.filter((e) => e.source === 'owner') : [];
      const loreRemoved = storedLore.length - keptLore.length;
      const loreKept = keptLore.length;
      if (loreRemoved > 0) {
        loreItem.value = keptLore;
        loreItem.dirty = true;
      }

      if (!keepMediaCache) {
        const file = mediaCacheFile(guildId);
        entries.delete(file);
        fs.rmSync(file, { force: true });
      }

      if (stateEntry.value.warmup !== undefined) {
        delete stateEntry.value.warmup;
        stateEntry.dirty = true;
      }

      flushAll();

      return { users: userIds.length, channels: channelIds.length, loreRemoved, loreKept, bufferMessages };
    },

    flush() {
      flushAll();
    },
  };

  return store;
}
