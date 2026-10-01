// Persistent memory on plain JSON files under data/ — survives restarts, hot
// reloads and prompt edits; nothing in the codebase ever wipes it implicitly.
//
//   data/state.json                          scheduler times, token calibration, daily LLM counter
//   data/guilds/<guildId>/guild.json         how this server talks, in-jokes, what the persona said about itself,
//                                            what people taught it (`learned`), the persona's own recent lines and
//                                            the variety pass's latest list and history (src/behavior/variety.js)
//   data/guilds/<guildId>/buffer.json        messages observed since the last memory update
//   data/guilds/<guildId>/users/<userId>.json  one profile per active member
//   data/guilds/<guildId>/private/<userId>.json  what the persona learned from one member in direct
//                                            messages: never shown anywhere but that member's DM
//   data/guilds/<guildId>/channels/<channelId>.json  one entry per channel the persona has seen (the server map)
//   data/guilds/<guildId>/lore.json           the guild's lorebook
//   data/guilds/<guildId>/media.json          the media description cache
//   data/guilds/<guildId>/gifs.json           the GIF library the persona posts from (src/memory/gifs.js)
//
// Everything is cached in memory, marked dirty on change and flushed on a
// timer and on shutdown. Writes are atomic (temp file + rename) so a crash
// mid-write never corrupts a profile.
//
// `forgetUser`, `forgetPrivate` and `wipeGuild` are the only functions in the
// whole project allowed to delete stored memory (see src/admin.js, the
// owner-only `/nep memory forget`, `/nep private forget` and `/nep memory wipe`
// commands).

import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { emptyAffinity, applyDelta } from './affinity.js';
import { mergeEpisodes } from './episodes.js';
import { upsertLore } from './lore.js';
import { applyInterestOps, normalizeInterests } from './interests.js';
import { applyDetailOps, normalizeDetails } from './details.js';
import { applyAliasOps } from './aliases.js';
import { clampText } from './clamp.js';
import { mergeEmojiUsage, normalizeEmojiUsage } from './emoji-usage.js';
import { emptyGifs, findGif, mergeGifs, normalizeGifs, resetGifCounts } from './gifs.js';
import { appendOwnLine, appendWornHistory, normalizeOwnLines, normalizeWorn, normalizeWornHistory } from '../behavior/variety.js';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn('store: unreadable file, using fallback', { file, error: err });
    return fallback;
  }
}

/** Every `.json` file under `dir`, recursively; never throws on a missing directory. */
function walkJsonFiles(dir) {
  let out = [];
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirEntry of dirEntries) {
    const full = path.join(dir, dirEntry.name);
    if (dirEntry.isDirectory()) {
      out = out.concat(walkJsonFiles(full));
    } else if (dirEntry.isFile() && dirEntry.name.endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `*.json` file under `dataDir` that fails to parse as JSON -- used by
 * `/nep resume` (see src/admin.js) to refuse coming back from a pause if
 * a hand-edit broke a file, without touching any cache. Paths are relative to
 * `dataDir`, forward-slash separated (stable across platforms), never file
 * contents.
 * @param {string} dataDir
 * @returns {string[]}
 */
export function findInvalidJsonFiles(dataDir) {
  const bad = [];
  for (const file of walkJsonFiles(dataDir)) {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      bad.push(path.relative(dataDir, file).split(path.sep).join('/'));
    }
  }
  return bad;
}

/**
 * Write `value` as pretty JSON to `file` through a temp file and a rename, so a
 * crash mid-write never leaves a half-written file; creates missing directories.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonAtomic(file, value) {
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
    aliases: [], // ranked items { name, weight, firstSeen, lastSeen } -- see src/memory/aliases.js
    relationship: '',
    affinity: emptyAffinity(),
    episodes: [],
    updatedAt: null,
  };
}

export function emptyGuild() {
  return {
    patterns: '',
    starters: '',
    injokes: [],
    self: [],
    learned: [], // things people taught the persona: detail-shaped items plus an optional `from` -- see applyLearnedOps
    learnedNextId: 1, // the next id a learned item gets -- never reused, even after a remove
    emojiUsage: {}, // { [emojiId]: { name, count, last } } -- members' custom emoji uses, see recordEmojiUsage
    emojiBackfill: null, // { at, channels, messages } once src/memory/emoji-backfill.js has read the history
    ownLines: [], // the persona's own recent lines in server channels, a ring -- see pushOwnLine
    worn: null, // { at, key, channelId, lines, patterns } -- the variety pass's latest list, see setWorn
    wornHistory: [], // { at, channelId, lines, patterns: [{ shape, count }] } per pass -- see appendWornHistory
    updatedAt: null,
  };
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
    firstMessageAt: null,
    lastMessageAt: null,
    topWriters: [],
    updatedAt: null,
  };
}

/** Normalize a profile's `interests`/`details`/`aliases` fields in place:
 * stored JSON is untrusted (possibly hand-edited while paused) -- `interests`
 * is validated via src/memory/interests.js#normalizeInterests, `details` via
 * src/memory/details.js#normalizeDetails (assigning fresh ids off the
 * profile's own `detailsSeq` counter when needed), `aliases` becomes `[]`
 * when it is not already an array. Never marks anything dirty -- the caller
 * (`getUser`/`applyProfileOps`) decides whether this is persisted. */
function normalizeProfile(profile) {
  profile.interests = normalizeInterests(profile.interests);

  if (!Number.isInteger(profile.detailsSeq) || profile.detailsSeq < 1) profile.detailsSeq = 1;
  const { items, nextId } = normalizeDetails(profile.details, profile.detailsSeq);
  profile.details = items;
  profile.detailsSeq = nextId;

  if (!Array.isArray(profile.aliases)) profile.aliases = [];
}

/**
 * A member's private layer before anything was said in a direct message:
 * no id or names (those live in the public profile), its own affinity
 * starting at 0, the daily DM reply counter and its own observation buffer.
 * @returns {object}
 */
export function emptyPrivate() {
  return {
    relationship: '',
    interests: [],
    details: [],
    detailsSeq: 1,
    episodes: [],
    affinity: emptyAffinity(),
    firstSeen: '',
    lastSeen: '',
    replies: { day: '', count: 0, noticedDay: '' },
    buffer: [],
  };
}

/** Normalize a private file in place: `interests`/`details`/`detailsSeq`
 * exactly as `normalizeProfile`, plus the defaults of `emptyPrivate` for
 * every field that is missing or of the wrong type (the file is untrusted,
 * possibly hand-edited while paused). Never marks anything dirty -- same
 * contract as `normalizeProfile`. */
function normalizePrivate(priv) {
  priv.interests = normalizeInterests(priv.interests);

  if (!Number.isInteger(priv.detailsSeq) || priv.detailsSeq < 1) priv.detailsSeq = 1;
  const { items, nextId } = normalizeDetails(priv.details, priv.detailsSeq);
  priv.details = items;
  priv.detailsSeq = nextId;

  if (typeof priv.relationship !== 'string') priv.relationship = '';
  if (!Array.isArray(priv.episodes)) priv.episodes = [];

  const affinity = priv.affinity && typeof priv.affinity === 'object' && !Array.isArray(priv.affinity) ? priv.affinity : {};
  priv.affinity = {
    ...affinity,
    score: Number.isFinite(affinity.score) ? affinity.score : 0,
    reason: typeof affinity.reason === 'string' ? affinity.reason : '',
    history: Array.isArray(affinity.history) ? affinity.history : [],
  };

  for (const key of ['firstSeen', 'lastSeen']) {
    if (typeof priv[key] !== 'string') priv[key] = '';
  }

  const replies = priv.replies && typeof priv.replies === 'object' && !Array.isArray(priv.replies) ? priv.replies : {};
  priv.replies = {
    day: typeof replies.day === 'string' ? replies.day : '',
    count: Number.isInteger(replies.count) && replies.count >= 0 ? replies.count : 0,
    noticedDay: typeof replies.noticedDay === 'string' ? replies.noticedDay : '',
  };

  if (!Array.isArray(priv.buffer)) priv.buffer = [];
}

/** A stored `emojiBackfill` stamp made safe to read: `{ at, channels, messages }` with
 * `at` a non-empty string and the counts non-negative integers (floored, a bad one
 * becomes 0); anything without a string `at` becomes null (never backfilled). */
function normalizeEmojiBackfill(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.at !== 'string' || !value.at) return null;
  const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return { at: value.at, channels: count(value.channels), messages: count(value.messages) };
}

/** Normalize a guild's `learned`/`learnedNextId`/`emojiUsage`/`emojiBackfill`/`ownLines`/`worn`/`wornHistory` fields in place: a
 * guild.json written before this list existed loads it as empty, a
 * hand-edited one is validated via src/memory/details.js#normalizeDetails
 * (fresh ids off `learnedNextId` when needed). Every other field is left
 * exactly as stored; a non-object value is left alone entirely. Never marks
 * anything dirty -- same contract as `normalizeProfile`. */
function normalizeGuild(guild) {
  if (!guild || typeof guild !== 'object' || Array.isArray(guild)) return;
  if (!Number.isInteger(guild.learnedNextId) || guild.learnedNextId < 1) guild.learnedNextId = 1;
  const { items, nextId } = normalizeDetails(guild.learned, guild.learnedNextId);
  guild.learned = items;
  guild.learnedNextId = nextId;
  // Missing or hand-broken -> {} (src/memory/emoji-usage.js#normalizeEmojiUsage).
  guild.emojiUsage = normalizeEmojiUsage(guild.emojiUsage);
  // Missing or hand-broken -> null: the history backfill has not run.
  guild.emojiBackfill = normalizeEmojiBackfill(guild.emojiBackfill);
  // The variety pass's fields (src/behavior/variety.js): missing or hand-broken -> empty.
  guild.ownLines = normalizeOwnLines(guild.ownLines);
  guild.worn = normalizeWorn(guild.worn);
  guild.wornHistory = normalizeWornHistory(guild.wornHistory);
}

/** Keep only the newest `max` UTC-date keys of a `days` counter map. */
function trimDays(days, max) {
  const keys = Object.keys(days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete days[key];
}

/** Bump one author's count in a channel's `topWriters` list (`{ id, count }[]`), keeping only the
 * top 5 by count -- used by `touchChannel` (live traffic, one message at a time); ids compared as
 * strings. A writer who falls out of the top 5 loses their tally (this is a best-effort ranking,
 * not an exact per-author ledger -- `setChannelFacts` below computes an exact top 5 from a fetched
 * window instead). */
function bumpTopWriters(topWriters, authorId) {
  const id = String(authorId);
  const list = (Array.isArray(topWriters) ? topWriters : []).map((w) => ({ ...w }));
  const existing = list.find((w) => w.id === id);
  if (existing) existing.count += 1;
  else list.push({ id, count: 1 });
  list.sort((a, b) => b.count - a.count);
  return list.slice(0, 5);
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
  const gifsFile = (guildId) => path.join(guildDir(guildId), 'gifs.json');
  const privateDir = (guildId) => path.join(guildDir(guildId), 'private');
  const privateFile = (guildId, userId) => path.join(privateDir(guildId), `${userId}.json`);
  const stateFile = path.join(dataDir, 'state.json');

  const stateEntry = entry(stateFile, () => ({}));

  /** The cache entry of a member's private file, created empty when missing, normalised. A file
   * that parses to something other than an object (null, an array, a string -- a hand edit gone
   * wrong) is replaced by the empty shape in the cache, so the private pass never stalls on it;
   * the disk copy is only rewritten by the next change, like any other entry. */
  function privateEntry(guildId, userId) {
    const item = entry(privateFile(guildId, userId), emptyPrivate);
    if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value)) {
      log.warn('store: private file replaced', { guildId, reason: 'malformed' });
      item.value = emptyPrivate();
    }
    normalizePrivate(item.value);
    return item;
  }

  /** The cache entry of a guild's GIF library, created empty when missing, normalised in place of
   * the cached value (src/memory/gifs.js#normalizeGifs); never marked dirty by reading. */
  function gifsEntry(guildId) {
    const item = entry(gifsFile(guildId), emptyGifs);
    item.value = normalizeGifs(item.value);
    return item;
  }

  /** Whether a member has a private file, cached or on disk (no side effects on the cache). */
  function hasPrivate(guildId, userId) {
    const file = privateFile(guildId, userId);
    return entries.has(file) || fs.existsSync(file);
  }

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
     * Profile of a member, or null when the persona has never seen them.
     * Stored JSON is normalised on read here (see `normalizeProfile` above,
     * which tolerates a hand-edited file) -- persisted the next time
     * anything writes this profile, never wiped implicitly.
     */
    getUser(guildId, userId) {
      const file = userFile(guildId, userId);
      if (!entries.has(file) && !fs.existsSync(file)) return null;
      const item = entry(file, () => emptyProfile(String(userId)));
      normalizeProfile(item.value);
      return item.value;
    },

    /**
     * Record that a member spoke: names, counters, timestamps. Creates the
     * profile. Messages do not always arrive in chronological order (the
     * memory warmup, src/memory/warmup.js, can feed months of history
     * after the live pipeline already touched a profile today) -- `firstSeen`/`lastSeen` are therefore
     * min/max'd against `at`, never just overwritten, so a late/backdated
     * touch can only widen the known range, never regress `lastSeen` to an
     * older message. `names`' order is meant to read "most recent display
     * name first": a name is moved to the front only when `at` is at least as
     * new as the CURRENT `lastSeen` (before this touch updates it) -- an
     * older/backdated touch never displaces the current name from index 0; an
     * unseen name from such a touch is appended at the end instead.
     */
    touchUser(guildId, userId, name, at = Date.now()) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const profile = item.value;

      const priorFirstSeenMs = profile.firstSeen ? Date.parse(profile.firstSeen) : NaN;
      const priorLastSeenMs = profile.lastSeen ? Date.parse(profile.lastSeen) : NaN;
      const isNewest = !Number.isFinite(priorLastSeenMs) || at >= priorLastSeenMs;

      if (name) {
        if (isNewest) {
          profile.names = [name, ...profile.names.filter((n) => n !== name)].slice(0, 5);
        } else if (!profile.names.includes(name)) {
          profile.names = [...profile.names, name].slice(0, 5);
        }
      }

      if (!Number.isFinite(priorFirstSeenMs) || at < priorFirstSeenMs) {
        profile.firstSeen = new Date(at).toISOString();
      }
      if (!Number.isFinite(priorLastSeenMs) || at > priorLastSeenMs) {
        profile.lastSeen = new Date(at).toISOString();
      }
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
     * docs/prompt-contract.md, "The analyzer"): `character`/`style`/
     * `relationship` replace the stored text only when given as a non-empty
     * string, clamped to `opts.fieldChars` -- an absent or empty field never
     * blanks what is already stored. `ops.interests` (`{ add, update, seen,
     * remove }`) merges via src/memory/interests.js#applyInterestOps;
     * `ops.details` (`{ add, seen, remove }`) merges via
     * src/memory/details.js#applyDetailOps, which also advances the
     * profile's own `detailsSeq` id counter. `opts.seenAt` is the time of the
     * PERSON'S message that produced this sighting (falls back to `opts.now`,
     * then the wall clock) -- see the two modules' header comments for the
     * confirmation/date rules `opts.confirmGapHours` feeds. Stored JSON is
     * normalised first (see `normalizeProfile`). Tolerates garbage `ops`, never throws.
     * @param {string} guildId
     * @param {string} userId
     * @param {{ character?: string, style?: string, relationship?: string,
     *   interests?: { add?: object[], update?: object[], seen?: string[], remove?: string[] },
     *   details?: { add?: unknown[], seen?: unknown[], remove?: unknown[] },
     *   aliases?: { add?: string[], remove?: string[] } }} ops
     * @param {{ fieldChars?: number, maxInterests?: number, maxInterestsStored?: number, topicChars?: number,
     *   noteChars?: number, interestHalfLifeDays?: number, maxDetails?: number, maxDetailsStored?: number,
     *   detailHalfLifeDays?: number, maxAliases?: number, maxAliasesStored?: number, aliasHalfLifeDays?: number,
     *   confirmGapHours?: number, seenAt?: number, now?: number, clampTolerance?: number }} [opts]
     *   `maxInterestsStored`/`maxDetailsStored`/`interestHalfLifeDays`/`detailHalfLifeDays` drive the
     *   storage-cap-vs-shown-cap split and the rank decay -- see
     *   docs/prompt-contract.md, "More is stored than shown, and rank decays with age".
     *   `clampTolerance` (see src/memory/clamp.js) governs how far prose text may run over
     *   `fieldChars`/`noteChars`/etc. before it is cut, at a clean boundary, never mid-token.
     * @returns {object} The updated profile.
     */
    applyProfileOps(guildId, userId, ops, opts = {}) {
      const item = entry(userFile(guildId, userId), () => emptyProfile(String(userId)));
      const profile = item.value;
      normalizeProfile(profile);

      const seenAt = Number.isFinite(opts.seenAt) ? opts.seenAt : Number.isFinite(opts.now) ? opts.now : Date.now();

      for (const key of ['character', 'style', 'relationship']) {
        const value = ops?.[key];
        if (typeof value === 'string' && value.trim()) {
          profile[key] = clampText(value, opts.fieldChars, { tolerance: opts.clampTolerance });
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
          clampTolerance: opts.clampTolerance,
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
          clampTolerance: opts.clampTolerance,
          seenAt,
          nextId: profile.detailsSeq,
        });
        profile.details = items;
        profile.detailsSeq = nextId;
      }

      if (ops?.aliases && typeof ops.aliases === 'object' && !Array.isArray(ops.aliases)) {
        profile.aliases = applyAliasOps(profile.aliases, ops.aliases, profile.names, {
          maxAliases: opts.maxAliases,
          maxAliasesStored: opts.maxAliasesStored,
          confirmGapHours: opts.confirmGapHours,
          halfLifeDays: opts.aliasHalfLifeDays,
          seenAt,
        });
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

    /**
     * Delete one member's profile AND their private layer (`forgetPrivate`),
     * cache and disk alike: removing a person removes all of them. See also
     * `wipeGuild` below.
     */
    forgetUser(guildId, userId) {
      const file = userFile(guildId, userId);
      entries.delete(file);
      fs.rmSync(file, { force: true });
      store.forgetPrivate(guildId, userId);
    },

    // ---- the private layer: what one member said to the persona in direct messages ----

    /**
     * A member's private layer (data/guilds/<id>/private/<userId>.json), or
     * null when there is none. Normalised on read (see `normalizePrivate`),
     * persisted the next time anything writes the file.
     * @param {string} guildId
     * @param {string} userId
     * @returns {object|null}
     */
    getPrivate(guildId, userId) {
      if (!hasPrivate(guildId, userId)) return null;
      return privateEntry(guildId, userId).value;
    },

    /**
     * A member's private layer, created with the empty shape (see
     * `emptyPrivate`) and marked dirty when it did not exist yet; an existing
     * one is returned untouched.
     * @param {string} guildId
     * @param {string} userId
     * @returns {object}
     */
    ensurePrivate(guildId, userId) {
      const existed = hasPrivate(guildId, userId);
      const item = privateEntry(guildId, userId);
      if (!existed) item.dirty = true;
      return item.value;
    },

    /**
     * Apply one private analyzer batch to a member's private layer: the same
     * `relationship`/`interests`/`details` op shapes and `opts` as
     * `applyProfileOps` (an absent or empty `relationship` never blanks the
     * stored one). `character`, `style`, `aliases` and `portrait` are public
     * only and ignored here. Creates the file. Tolerates garbage `ops`, never throws.
     * @param {string} guildId
     * @param {string} userId
     * @param {{ relationship?: string,
     *   interests?: { add?: object[], update?: object[], seen?: string[], remove?: string[] },
     *   details?: { add?: unknown[], seen?: unknown[], remove?: unknown[] } }} ops
     * @param {object} [opts]  As for `applyProfileOps`.
     * @returns {object} The updated private layer.
     */
    applyPrivateOps(guildId, userId, ops, opts = {}) {
      const item = privateEntry(guildId, userId);
      const priv = item.value;

      const seenAt = Number.isFinite(opts.seenAt) ? opts.seenAt : Number.isFinite(opts.now) ? opts.now : Date.now();

      const relationship = ops?.relationship;
      if (typeof relationship === 'string' && relationship.trim()) {
        priv.relationship = clampText(relationship, opts.fieldChars, { tolerance: opts.clampTolerance });
      }

      if (ops?.interests && typeof ops.interests === 'object' && !Array.isArray(ops.interests)) {
        priv.interests = applyInterestOps(priv.interests, ops.interests, {
          maxInterests: opts.maxInterests,
          maxInterestsStored: opts.maxInterestsStored,
          topicChars: opts.topicChars,
          noteChars: opts.noteChars,
          confirmGapHours: opts.confirmGapHours,
          halfLifeDays: opts.interestHalfLifeDays,
          clampTolerance: opts.clampTolerance,
          seenAt,
        });
      }

      if (ops?.details && typeof ops.details === 'object' && !Array.isArray(ops.details)) {
        const { items, nextId } = applyDetailOps(priv.details, ops.details, {
          maxDetails: opts.maxDetails,
          maxDetailsStored: opts.maxDetailsStored,
          fieldChars: opts.fieldChars,
          confirmGapHours: opts.confirmGapHours,
          halfLifeDays: opts.detailHalfLifeDays,
          clampTolerance: opts.clampTolerance,
          seenAt,
          nextId: priv.detailsSeq,
        });
        priv.details = items;
        priv.detailsSeq = nextId;
      }

      item.dirty = true;
      return priv;
    },

    /**
     * Fold one delta into a member's PRIVATE affinity (see
     * src/memory/affinity.js#applyDelta; same `opts` as `adjustAffinity`).
     * The public affinity is never touched. Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {number} delta
     * @param {string} reason
     * @param {object} [opts]
     * @returns {{ score: number, reason: string, history: object[] }}
     */
    adjustPrivateAffinity(guildId, userId, delta, reason, opts) {
      const item = privateEntry(guildId, userId);
      const next = applyDelta(item.value.affinity, delta, reason, opts);
      item.value.affinity = next;
      item.dirty = true;
      return next;
    },

    /**
     * Append episodes to a member's private layer via
     * src/memory/episodes.js#mergeEpisodes (same `opts` as `addEpisodes`).
     * Creates the file. Returns how many were added.
     * @param {string} guildId
     * @param {string} userId
     * @param {unknown} incoming
     * @param {object} [opts]
     * @returns {number}
     */
    addPrivateEpisodes(guildId, userId, incoming, opts) {
      const item = privateEntry(guildId, userId);
      const { episodes, added } = mergeEpisodes(item.value.episodes, incoming, opts);
      if (added > 0) {
        item.value.episodes = episodes;
        item.dirty = true;
      }
      return added;
    },

    /**
     * Count one direct-message reply of the persona to a member for `today`
     * (a UTC date key): the counter restarts at 0 when the stored day is
     * another one. Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {string} today
     * @returns {{ day: string, count: number }}
     */
    bumpPrivateReplies(guildId, userId, today) {
      const item = privateEntry(guildId, userId);
      const replies = item.value.replies;
      if (replies.day !== today) {
        replies.day = today;
        replies.count = 0;
      }
      replies.count += 1;
      item.dirty = true;
      return { day: replies.day, count: replies.count };
    },

    /**
     * Remember that the daily-cap notice was posted to a member on `today`,
     * so it is posted at most once a day. Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {string} today
     */
    markPrivateNoticed(guildId, userId, today) {
      const item = privateEntry(guildId, userId);
      item.value.replies.noticedDay = today;
      item.dirty = true;
    },

    /**
     * Buffer one observed direct message for the next private analyzer
     * batch; an optional `maxLength` drops the oldest entries past it (as
     * `pushBuffer`). Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {object} message
     * @param {number} [maxLength]
     */
    pushPrivateBuffer(guildId, userId, message, maxLength = Infinity) {
      const item = privateEntry(guildId, userId);
      const buffer = item.value.buffer;
      buffer.push(message);
      if (buffer.length > maxLength) buffer.splice(0, buffer.length - maxLength);
      item.dirty = true;
    },

    /**
     * Every buffered direct message of a member, oldest first, leaving the
     * buffer empty. `[]` (and no file created) when there is no private layer.
     * @param {string} guildId
     * @param {string} userId
     * @returns {object[]}
     */
    takePrivateBuffer(guildId, userId) {
      if (!hasPrivate(guildId, userId)) return [];
      const item = privateEntry(guildId, userId);
      const taken = item.value.buffer;
      if (taken.length === 0) return [];
      item.value.buffer = [];
      item.dirty = true;
      return taken;
    },

    /**
     * How many direct messages are buffered for a member and the `ts` of the
     * oldest (null when the buffer is empty or there is no private layer).
     * Creates nothing.
     * @param {string} guildId
     * @param {string} userId
     * @returns {{ size: number, oldestTs: number|null }}
     */
    privateBufferInfo(guildId, userId) {
      if (!hasPrivate(guildId, userId)) return { size: 0, oldestTs: null };
      const buffer = privateEntry(guildId, userId).value.buffer;
      const oldestTs = Number.isFinite(buffer[0]?.ts) ? buffer[0].ts : null;
      return { size: buffer.length, oldestTs };
    },

    /**
     * A copy of a member's buffered direct messages, oldest first, leaving
     * the buffer as it is (the analyzer shifts it only after a successful
     * update, see `shiftPrivateBuffer`). `[]` (and no file created) when
     * there is no private layer.
     * @param {string} guildId
     * @param {string} userId
     * @returns {object[]}
     */
    getPrivateBuffer(guildId, userId) {
      if (!hasPrivate(guildId, userId)) return [];
      return [...privateEntry(guildId, userId).value.buffer];
    },

    /**
     * Drop the first `count` buffered direct messages of a member (the ones a
     * private update consumed). Nothing happens, and no file is created,
     * when there is no private layer.
     * @param {string} guildId
     * @param {string} userId
     * @param {number} count
     */
    shiftPrivateBuffer(guildId, userId, count) {
      if (!hasPrivate(guildId, userId)) return;
      const item = privateEntry(guildId, userId);
      item.value.buffer.splice(0, count);
      item.dirty = true;
    },

    /**
     * Stamp a successful private update on a member's private layer:
     * `lastSeen` always, `firstSeen` only while it is empty (ISO strings,
     * like a public profile's). The public profile is never touched.
     * Creates the file.
     * @param {string} guildId
     * @param {string} userId
     * @param {number} now  Epoch milliseconds.
     */
    touchPrivateSeen(guildId, userId, now) {
      const item = privateEntry(guildId, userId);
      const iso = new Date(now).toISOString();
      if (!item.value.firstSeen) item.value.firstSeen = iso;
      item.value.lastSeen = iso;
      item.dirty = true;
    },

    /**
     * Ids of every member with a private layer in a guild, cached or on disk.
     * @param {string} guildId
     * @returns {string[]}
     */
    listPrivate(guildId) {
      return idsUnder(privateDir(guildId));
    },

    /**
     * Delete one member's private layer, cache and disk alike; the public
     * profile stays. Safe when there is none.
     * @param {string} guildId
     * @param {string} userId
     */
    forgetPrivate(guildId, userId) {
      const file = privateFile(guildId, userId);
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

    /**
     * Every member profile stored for a guild, cached or on disk -- the pool
     * a turn scans to pull a silent member into `<people>` by name/alias (see
     * src/behavior/prompt.js and docs/prompt-contract.md, "Aliases").
     * Same normalize-on-read guarantee as `getUser`.
     */
    listUserProfiles(guildId) {
      return idsUnder(path.join(guildDir(guildId), 'users')).map((id) => store.getUser(guildId, id)).filter(Boolean);
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

    /**
     * The guild's memory (data/guilds/<id>/guild.json), the empty default
     * when nothing is stored. `learned` is normalised on read (see
     * `normalizeGuild` above) -- persisted the next time anything writes the
     * guild, never wiped implicitly.
     */
    getGuild(guildId) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      return item.value;
    },

    /**
     * Merge fields into the guild's memory and stamp `updatedAt`. `learned`/
     * `learnedNextId` are never taken from here -- they only ever change
     * through `applyLearnedOps`, which merges incrementally instead of
     * overwriting wholesale (mirrors `updateUser`); `emojiUsage` likewise
     * only through `recordEmojiUsage`/`clearEmojiUsage`, `emojiBackfill` only
     * through `setEmojiBackfill`, `ownLines`/`worn`/`wornHistory` only through
     * `pushOwnLine`/`setWorn`/`appendWornHistory`.
     */
    updateGuild(guildId, fields) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      const { learned, learnedNextId, emojiUsage, emojiBackfill, ownLines, worn, wornHistory, ...safeFields } = fields ?? {};
      Object.assign(item.value, safeFields, { updatedAt: new Date().toISOString() });
      item.dirty = true;
      return item.value;
    },

    /**
     * Add the members' custom emoji uses of one consumed analyzer batch to
     * the guild's `emojiUsage` (src/memory/emoji-usage.js#mergeEmojiUsage:
     * counts accumulate, the lowest-ranked entries past `opts.storeMax` are
     * evicted). Marks the guild dirty only when something was counted; never
     * stamps `updatedAt` (a counter, like `touchUser`).
     * @param {string} guildId
     * @param {object[]} messages  Slim buffered messages; `self`/`bot`/`ts`/`emojis` read.
     * @param {{ storeMax?: number, halfLifeDays?: number }} [opts]
     * @returns {number} How many uses were counted.
     */
    recordEmojiUsage(guildId, messages, opts = {}) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      const { usage, counted } = mergeEmojiUsage(item.value.emojiUsage, messages, opts);
      if (counted > 0) {
        item.value.emojiUsage = usage;
        item.dirty = true;
      }
      return counted;
    },

    /**
     * Empty the guild's `emojiUsage` -- only for the emoji history backfill
     * (src/memory/emoji-backfill.js: its one first run, or the owner's
     * `/nep emoji rescan`), which recounts it from history right after.
     * Nothing else is touched; never stamps `updatedAt`.
     * @param {string} guildId
     */
    clearEmojiUsage(guildId) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      item.value.emojiUsage = {};
      item.dirty = true;
    },

    /**
     * Stamp the guild's `emojiBackfill` (`{ at, channels, messages }`,
     * normalised like on read) after a history backfill. Never stamps `updatedAt`.
     * @param {string} guildId
     * @param {{ at: string, channels: number, messages: number }} stamp
     * @returns {{ at: string, channels: number, messages: number } | null} The stored stamp.
     */
    setEmojiBackfill(guildId, stamp) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      item.value.emojiBackfill = normalizeEmojiBackfill(stamp);
      item.dirty = true;
      return item.value.emojiBackfill;
    },

    /**
     * Remember one message the persona posted in a server channel: appended
     * to the guild's `ownLines` ring (src/behavior/variety.js#appendOwnLine,
     * capped from `window`, `variety.window`). A line without text or time
     * changes nothing. Never stamps `updatedAt` (a counter, like `touchUser`).
     * @param {string} guildId
     * @param {{ id?: string, ts: number, channelId?: string, text: string, to?: string }} line
     * @param {number} window
     * @returns {boolean} whether the line was stored
     */
    pushOwnLine(guildId, line, window) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      const usable = typeof line?.text === 'string' && line.text.trim() !== '' && Number.isFinite(line?.ts);
      if (!usable) return false;
      item.value.ownLines = appendOwnLine(item.value.ownLines, line, window);
      item.dirty = true;
      return true;
    },

    /**
     * Store the variety pass's latest list (`worn`: `{ at, key, channelId,
     * lines, patterns }`, normalised like on read). Never stamps `updatedAt`.
     * @param {string} guildId
     * @param {object} worn
     * @returns {object|null} The stored value.
     */
    setWorn(guildId, worn) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      item.value.worn = normalizeWorn(worn);
      item.dirty = true;
      return item.value.worn;
    },

    /**
     * Append one pass to the guild's `wornHistory` (shapes and counts only,
     * src/behavior/variety.js#appendWornHistory), the oldest dropped past
     * `max` (`variety.history`). Never stamps `updatedAt`.
     * @param {string} guildId
     * @param {{ at: number, channelId?: string|null, lines: number, patterns: object[] }} pass
     * @param {number} max
     * @returns {object[]} The stored history.
     */
    appendWornHistory(guildId, pass, max) {
      const item = entry(guildFile(guildId), emptyGuild);
      normalizeGuild(item.value);
      item.value.wornHistory = appendWornHistory(item.value.wornHistory, pass, max);
      item.dirty = true;
      return item.value.wornHistory;
    },

    /**
     * Apply one batch of `learned` ops (`{ add, seen, remove }`, add items a
     * bare string or `{ text, from?, sure? }`) to the guild's list of things
     * people taught the persona, via src/memory/details.js#applyDetailOps --
     * the same confirmation/ranking/eviction mechanics as a member's
     * details, with the guild's own `learnedNextId` id counter. Used by the
     * analyzer (src/memory/update.js#applyMemoryUpdate) and the owner
     * commands. The limits are the `config.memory` keys of the same name, so
     * a caller can pass `{ ...config.memory, seenAt }` as-is; `seenAt` falls
     * back to the wall clock. Garbage `ops` change nothing and never throw.
     * The guild is marked dirty (and `updatedAt` stamped) only when the list
     * or the counter actually changed.
     * @param {string} guildId
     * @param {{ add?: unknown[], seen?: unknown[], remove?: unknown[] }} ops
     * @param {{ seenAt?: number, maxLearned?: number, maxLearnedStored?: number, learnedChars?: number,
     *   learnedHalfLifeDays?: number, confirmGapHours?: number, clampTolerance?: number }} [opts]
     * @returns {object[]} The guild's `learned` list after the ops.
     */
    applyLearnedOps(guildId, ops, opts = {}) {
      const item = entry(guildFile(guildId), emptyGuild);
      const guild = item.value;
      normalizeGuild(guild);
      if (!ops || typeof ops !== 'object' || Array.isArray(ops)) return guild.learned;

      const before = JSON.stringify([guild.learned, guild.learnedNextId]);
      const { items, nextId } = applyDetailOps(guild.learned, ops, {
        maxDetails: opts.maxLearned,
        maxDetailsStored: opts.maxLearnedStored,
        fieldChars: opts.learnedChars,
        halfLifeDays: opts.learnedHalfLifeDays,
        confirmGapHours: opts.confirmGapHours,
        clampTolerance: opts.clampTolerance,
        seenAt: Number.isFinite(opts.seenAt) ? opts.seenAt : Date.now(),
        nextId: guild.learnedNextId,
      });
      if (JSON.stringify([items, nextId]) !== before) {
        guild.learned = items;
        guild.learnedNextId = nextId;
        guild.updatedAt = new Date().toISOString();
        item.dirty = true;
      }
      return guild.learned;
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
     * `authorId` (the message's author, omitted for the persona's own
     * messages and other bots -- see src/memory/update.js#touchMemory) bumps
     * that author's tally in `topWriters` (see `bumpTopWriters` above); `null`
     * (the default) leaves `topWriters` untouched.
     */
    touchChannel(guildId, channelId, facts, ts = Date.now(), authorId = null) {
      const item = entry(channelFile(guildId, channelId), () => emptyChannel(String(channelId)));
      const channel = item.value;
      const { name, category = null, topic = null } = facts ?? {};
      if (name) channel.name = name;
      channel.category = category;
      channel.topic = topic;
      channel.messageCount += 1;
      channel.firstMessageAt = channel.firstMessageAt === null ? ts : Math.min(channel.firstMessageAt, ts);
      channel.lastMessageAt = channel.lastMessageAt === null ? ts : Math.max(channel.lastMessageAt, ts);
      const dateKey = new Date(ts).toISOString().slice(0, 10);
      channel.days[dateKey] = (channel.days[dateKey] ?? 0) + 1;
      trimDays(channel.days, 30);
      if (authorId !== null && authorId !== undefined) channel.topWriters = bumpTopWriters(channel.topWriters, authorId);
      item.dirty = true;
      return channel;
    },

    /**
     * SET (never add) a channel entry's Discord facts and counters from a
     * fetched history window (the warmup, src/memory/warmup.js#processChannel):
     * unlike `touchChannel` (the live pipeline's one-message-at-a-time
     * increments), a redo of the same window lands on the same numbers
     * instead of doubling them -- mirrors `touchUserFromWindows`' SET-not-ADD
     * pattern for user profiles. `topWriters` (`{ id, count }[]`, already
     * computed by the caller from the same window) is stored as-is, ids
     * coerced to strings and capped to 5. Creates the entry.
     * @param {string} guildId
     * @param {string} channelId
     * @param {{ name?: string, category?: string|null, topic?: string|null, messageCount?: number,
     *   firstMessageAt?: number|null, lastMessageAt?: number|null, days?: Record<string, number>,
     *   topWriters?: {id: string, count: number}[] }} facts
     */
    setChannelFacts(guildId, channelId, facts) {
      const item = entry(channelFile(guildId, channelId), () => emptyChannel(String(channelId)));
      const channel = item.value;
      const {
        name,
        category = null,
        topic = null,
        messageCount = 0,
        firstMessageAt = null,
        lastMessageAt = null,
        days = {},
        topWriters = [],
      } = facts ?? {};
      if (name) channel.name = name;
      channel.category = category;
      channel.topic = topic;
      channel.messageCount = messageCount;
      channel.firstMessageAt = firstMessageAt;
      channel.lastMessageAt = lastMessageAt;
      channel.days = { ...days };
      channel.topWriters = Array.isArray(topWriters)
        ? topWriters.slice(0, 5).map(({ id, count }) => ({ id: String(id), count }))
        : [];
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

    /**
     * The guild's GIF library (data/guilds/<id>/gifs.json, see
     * src/memory/gifs.js): `{ nextId, entries, backfill }`, the empty library
     * when nothing is stored. Normalised on read, persisted the next time
     * anything writes it, never reset implicitly.
     * @param {string} guildId
     * @returns {{ nextId: number, entries: Record<string, object>, backfill: object|null }}
     */
    getGifs(guildId) {
      return gifsEntry(guildId).value;
    },

    /**
     * The library entry whose handle is `handle` (`g12`), as `{ key, ...entry }`,
     * or null (src/memory/gifs.js#findGif). Creates nothing on disk.
     * @param {string} guildId
     * @param {string} handle
     * @returns {object|null}
     */
    findGif(guildId, handle) {
      return findGif(gifsEntry(guildId).value, handle);
    },

    /**
     * Add the members' GIFs of `messages` to the guild's library
     * (src/memory/gifs.js#mergeGifs: counts accumulate, new GIFs get the next
     * handle, the lowest-ranked entries past `opts.storeMax` are evicted).
     * Marks the file dirty only when something was counted.
     * @param {string} guildId
     * @param {object[]} messages  Normalized messages (URLs present); `self`/`bot`/`ts` read.
     * @param {{ storeMax?: number, halfLifeDays?: number }} [opts]
     * @returns {number} How many uses were counted.
     */
    recordGifs(guildId, messages, opts = {}) {
      const item = gifsEntry(guildId);
      const { gifs, counted } = mergeGifs(item.value, messages, opts);
      if (counted > 0) {
        item.value = gifs;
        item.dirty = true;
      }
      return counted;
    },

    /**
     * Set every GIF library entry's count to 0 (src/memory/gifs.js#resetGifCounts)
     * -- only for the GIF history backfill (src/memory/gif-backfill.js: its one
     * first run, or the owner's `/nep gifs rescan`), which recounts from
     * history right after. Entries, handles, `nextId` and the backfill stamp
     * are kept, so a recounted GIF keeps its handle.
     * @param {string} guildId
     */
    resetGifCounts(guildId) {
      const item = gifsEntry(guildId);
      item.value = resetGifCounts(item.value);
      item.dirty = true;
    },

    /**
     * Stamp the guild's GIF library `backfill` (`{ at, channels, messages }`,
     * normalised like on read) after a history backfill.
     * @param {string} guildId
     * @param {{ at: string, channels: number, messages: number }} stamp
     * @returns {{ at: string, channels: number, messages: number } | null} The stored stamp.
     */
    setGifBackfill(guildId, stamp) {
      const item = gifsEntry(guildId);
      item.value = { ...item.value, backfill: normalizeGifs({ ...item.value, backfill: stamp }).backfill };
      item.dirty = true;
      return item.value.backfill;
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
     * src/admin.js `/nep memory wipe`). Together with `forgetUser` and
     * `forgetPrivate` above, this is the ONLY other place in the project allowed to delete stored
     * memory. Removes, from both the cache and disk: every user profile
     * (affinity and episodes included), the whole `private/` directory (every
     * member's private layer), `guild.json`, every channel entry,
     * the live observation buffer, and lorebook entries whose `source` is
     * `'analyzer'` (every entry, owner included, when `keepOwnerLore` is
     * false). Keeps, by default, owner lore (`source: 'owner'`) and the
     * media description cache. Drops `state.warmup` (the warmup's own
     * progress, see src/memory/warmup.js) so the next run starts clean;
     * everything else in `state.json` — token calibration, the daily LLM
     * counter and the spontaneous schedule — survives untouched. Safe when
     * some files never existed; the store stays fully usable afterwards (a following
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

      {
        const dir = privateDir(guildId);
        const prefix = dir + path.sep;
        for (const file of [...entries.keys()]) {
          if (file.startsWith(prefix)) entries.delete(file);
        }
        fs.rmSync(dir, { recursive: true, force: true });
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

      for (const key of ['warmup']) {
        if (stateEntry.value[key] !== undefined) {
          delete stateEntry.value[key];
          stateEntry.dirty = true;
        }
      }

      flushAll();

      return { users: userIds.length, channels: channelIds.length, loreRemoved, loreKept, bufferMessages };
    },

    flush() {
      flushAll();
    },

    /**
     * Drop every cached file EXCEPT `state.json` (`/nep pause`): called
     * right after a flush, so nothing stale can be written from memory while
     * the owner hand-edits files under `data/` -- the next read of any
     * profile/guild/channel/lore/media/buffer lazily re-populates from disk,
     * exactly like a fresh process. `state.json` itself is left cached (it
     * carries the `paused` flag this feature relies on); see `reloadState`
     * below for forcing a fresh read of it too, used by `/nep resume`.
     * @returns {number} how many cache entries were dropped
     */
    dropCaches() {
      let dropped = 0;
      for (const [file, item] of entries) {
        if (file === stateFile) continue;
        if (item.dirty) log.warn('store: dropping a cache entry with unflushed changes', { file });
      }
      for (const file of [...entries.keys()]) {
        if (file === stateFile) continue;
        entries.delete(file);
        dropped += 1;
      }
      return dropped;
    },

    /**
     * Force `state.json` to be re-read from disk right now, discarding
     * whatever was cached (`/nep resume`): the owner may have
     * hand-edited it (e.g. warmup progress) while paused. Any unflushed
     * in-memory change is lost, the same guarantee every other cached file
     * already has once dropped.
     */
    reloadState() {
      stateEntry.value = readJson(stateFile, {});
      stateEntry.dirty = false;
    },

    /**
     * Every `*.json` file under this store's `dataDir` that fails to parse
     * (`/nep resume`) -- see `findInvalidJsonFiles` above.
     * @returns {string[]}
     */
    validate() {
      return findInvalidJsonFiles(dataDir);
    },
  };

  return store;
}
