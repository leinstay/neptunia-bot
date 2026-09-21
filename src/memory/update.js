// Turns the raw stream of Discord messages into long-term memory. Every
// message the persona sees is buffered (`observe`); once enough have piled up
// (`isDue`), a periodic tick (`tick`, called by index.js every 60s) asks the
// LLM to merge what happened into per-user profiles, server-wide patterns and
// facts the persona has claimed about itself (`run`, via `buildMemoryRequest`
// + `applyMemoryUpdate`). Memory is persistent: nothing here ever wipes it —
// a failed update just leaves the buffer alone and backs off for a while.

import { fitSections } from '../llm/budget.js';
import { estimateTokens, estimateMessages } from '../llm/tokens.js';
import { formatTranscript, renderTranscript } from '../discord/format.js';
import { parseJsonObject } from '../llm/parse.js';
import { TokenLimitError } from '../llm/openrouter.js';
import { isDescribable, stickerUrl } from '../discord/media.js';
import { log } from '../log.js';
import { emptyAffinity } from './affinity.js';
import { keywordMatches } from './lore.js';
import { migrateInterests } from './interests.js';
import { migrateDetails } from './details.js';
import { topByRank } from './ranking.js';
import { toTokens, fromTokens } from './mentions.js';

const BACKOFF_MS = 15 * 60_000;
const MIN_LIVE_BATCH = 20; // the live analyzer never shrinks below this many messages

// Fallbacks for the memory-prompt placeholders below, equal to config.json's
// own defaults -- used only when a deployment's config is missing the key.
const MEMORY_LIMIT_DEFAULTS = {
  fieldChars: 400,
  maxDetails: 15,
  maxInjokes: 15,
  maxSelfFacts: 20,
  maxNewEpisodes: 3,
  maxEpisodes: 20,
  maxDeltaPerUpdate: 15,
  maxInterests: 12,
  interestTopicChars: 40,
  interestNoteChars: 120,
};

/** `error?.message`, trimmed to 200 chars — never message contents. */
function detailOf(err) {
  return err?.message ? String(err.message).slice(0, 200) : undefined;
}

/**
 * Whether a completion looks cut off by the output token cap: the provider
 * said so (`finish_reason: 'length'`), or the text has no closing `}` for
 * its first `{` (the same condition `parseJsonObject` fails on).
 * @param {string} text
 * @param {string|undefined} finishReason
 */
function looksTruncated(text, finishReason) {
  if (finishReason === 'length') return true;
  const start = String(text ?? '').indexOf('{');
  if (start === -1) return false;
  const end = String(text ?? '').lastIndexOf('}');
  return end <= start;
}

/**
 * Whether the buffered messages of one guild are ready for a memory update.
 * @param {object[]} buffer  Buffered slim messages, oldest first.
 * @param {number} now
 * @param {object} cfg       `config.memory`.
 * @param {object} [relationshipsCfg]  `config.relationships`, only when the feature is on. A
 *   pile-up of messages addressed to the persona (`direct: true`) triggers an update early,
 *   so reactions to how people talk TO it do not wait for a full batch.
 */
export function isDue(buffer, now, cfg, relationshipsCfg) {
  if (buffer.length >= cfg.batchMessages) return true;
  if (buffer.length >= cfg.minBatchMessages) {
    const oldest = buffer[0];
    if (oldest && now - oldest.ts >= cfg.maxBatchAgeMinutes * 60_000) return true;
  }
  if (relationshipsCfg?.directTriggerCount > 0) {
    const directCount = buffer.reduce((count, message) => count + (message.direct ? 1 : 0), 0);
    if (directCount >= relationshipsCfg.directTriggerCount) return true;
  }
  return false;
}

function block(tag, body) {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

function fillTemplate(template, values) {
  return (template ?? '').replace(/\{\{(\w+)\}\}/g, (all, key) => values[key] ?? all);
}

/**
 * The `{{fieldChars}}`/`{{maxDetails}}`/... placeholders `prompts.memory` may use, filled from
 * the live config so a prompt states the same limits the code actually clamps to. Missing config
 * keys fall back to MEMORY_LIMIT_DEFAULTS (config.json's own defaults); an unknown placeholder in
 * the prompt is left untouched by fillTemplate regardless.
 * @param {object} config  Live config (`config.memory`, `config.relationships`).
 * @param {string} selfName
 */
function memoryTemplateValues(config, selfName) {
  const memoryCfg = config.memory ?? {};
  const fieldChars = memoryCfg.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars;
  return {
    name: selfName,
    fieldChars,
    guildFieldChars: fieldChars * 2,
    maxDetails: memoryCfg.maxDetails ?? MEMORY_LIMIT_DEFAULTS.maxDetails,
    maxInjokes: memoryCfg.maxInjokes ?? MEMORY_LIMIT_DEFAULTS.maxInjokes,
    maxSelfFacts: memoryCfg.maxSelfFacts ?? MEMORY_LIMIT_DEFAULTS.maxSelfFacts,
    maxNewEpisodes: memoryCfg.maxNewEpisodes ?? MEMORY_LIMIT_DEFAULTS.maxNewEpisodes,
    maxEpisodes: memoryCfg.maxEpisodes ?? MEMORY_LIMIT_DEFAULTS.maxEpisodes,
    maxDeltaPerUpdate: config.relationships?.maxDeltaPerUpdate ?? MEMORY_LIMIT_DEFAULTS.maxDeltaPerUpdate,
    maxInterests: memoryCfg.maxInterests ?? MEMORY_LIMIT_DEFAULTS.maxInterests,
    interestTopicChars: memoryCfg.interestTopicChars ?? MEMORY_LIMIT_DEFAULTS.interestTopicChars,
    interestNoteChars: memoryCfg.interestNoteChars ?? MEMORY_LIMIT_DEFAULTS.interestNoteChars,
  };
}

/** A deployment with no/broken labels.json must fail loudly, not send a broken prompt. */
function requireLabels(prompts) {
  const labels = prompts?.labels;
  if (!labels || !labels.transcript) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  return labels;
}

/** Only the fields the memory prompt is allowed to see/update for a user profile.
 * `interests`/`details` are upgraded via migrateInterests/migrateDetails when
 * the profile still carries the old shape (defensive; store.getUser already
 * migrates on read). */
function pickProfileFields(profile) {
  const { names = [], character = '', style = '', relationship = '' } = profile ?? {};
  const interests = Array.isArray(profile?.interests) ? profile.interests : migrateInterests(profile?.interests);
  const detailsRaw = profile?.details;
  const details =
    Array.isArray(detailsRaw) && detailsRaw.every((d) => d && typeof d === 'object')
      ? detailsRaw
      : migrateDetails(detailsRaw).items;
  return { names, character, interests, style, details, relationship };
}

/** `YYYY-MM-DD` of an ISO timestamp, or `undefined` (so JSON.stringify omits
 * the key entirely) when the date is unknown -- see
 * .claude/docs/prompt-contract.md, "The input view of a stored item". */
function dateOnly(iso) {
  return typeof iso === 'string' && iso ? iso.slice(0, 10) : undefined;
}

/** `fromTokens(text, nameOf, 'analyzer')`, tolerating a non-string `text` (returned as-is). */
function resolveText(text, nameOf) {
  return typeof text === 'string' ? fromTokens(text, nameOf, 'analyzer') : text;
}

/** `resolveText` mapped over an array; non-arrays pass through untouched. */
function resolveTextArray(values, nameOf) {
  return Array.isArray(values) ? values.map((value) => resolveText(value, nameOf)) : values;
}

/** The `<existing_profiles>` view of one person's interests: only the top
 * `maxInterests` by rank (src/memory/ranking.js#topByRank, decayed with
 * `halfLifeDays`), in rank order -- `{ topic, note, seen, last }` (`seen` =
 * weight, `last` = the date-only lastSeen, omitted when unknown). `note` is
 * resolved (`<@id>` tokens -> `name (id:...)`) via `nameOf` -- see
 * .claude/docs/prompt-contract.md, "Members are referred to by id, never by
 * nickname". `maxInterests` not an integer -> every stored interest
 * (unlimited, matching the behaviour before this feature); `halfLifeDays` not
 * a positive number -> no decay, ranked by weight alone. See
 * .claude/docs/prompt-contract.md, "The analyzer" and "More is stored than
 * shown, and rank decays with age". */
function existingInterestsView(interests, maxInterests, halfLifeDays, nameOf) {
  const list = Array.isArray(interests) ? interests : [];
  return topByRank(list, maxInterests, halfLifeDays).map(({ topic, note, weight, lastSeen }) => ({
    topic,
    note: resolveText(note, nameOf),
    seen: weight,
    last: dateOnly(lastSeen),
  }));
}

/** The `<existing_profiles>` view of one person's details: only the top
 * `maxDetails` by rank, in rank order -- `{ id, text, seen, last }` (`seen` =
 * weight, `last` = the date-only lastSeen, omitted when unknown). `text` is
 * resolved via `nameOf`, same as `existingInterestsView` above. */
function existingDetailsView(details, maxDetails, halfLifeDays, nameOf) {
  const list = Array.isArray(details) ? details : [];
  return topByRank(list, maxDetails, halfLifeDays).map(({ id, text, weight, lastSeen }) => ({
    id,
    text: resolveText(text, nameOf),
    seen: weight,
    last: dateOnly(lastSeen),
  }));
}

/** The `<existing_profiles>` view of one person's aliases: a plain list of
 * names, top `maxAliases` by rank -- see .claude/docs/prompt-contract.md,
 * "Aliases". Alias names are never token-resolved: they are literal
 * nicknames, not free text that could name a member by id. */
function existingAliasesView(aliases, maxAliases, halfLifeDays) {
  const list = Array.isArray(aliases) ? aliases : [];
  return topByRank(list, maxAliases, halfLifeDays).map((item) => item.name);
}

/** Only the fields the memory prompt is allowed to see/update for guild
 * memory, with every free-text field resolved (`<@id>` -> `name (id:...)`)
 * via `nameOf`. */
function pickGuildFields(guildMemory, nameOf) {
  const { patterns = '', starters = '', injokes = [], self = [] } = guildMemory ?? {};
  return {
    patterns: resolveText(patterns, nameOf),
    starters: resolveText(starters, nameOf),
    injokes: resolveTextArray(injokes, nameOf),
    self: resolveTextArray(self, nameOf),
  };
}

/** Only the fields the memory prompt is allowed to see/update for a channel
 * entry, with `purpose`/`topics`/`tone` resolved via `nameOf`. */
function pickChannelFields(channel, nameOf) {
  const { name = '', category = null, topic = null, purpose = '', topics = '', tone = '' } = channel ?? {};
  return {
    name,
    category,
    topic,
    purpose: resolveText(purpose, nameOf),
    topics: resolveText(topics, nameOf),
    tone: resolveText(tone, nameOf),
  };
}

/**
 * Normalized set of `config.memory.mainChannelIds`, compared as strings --
 * see .claude/docs/prompt-contract.md, "Main channels are the source of the
 * portrait". Garbage config (not an array, non-string entries) never throws:
 * a non-array collapses to an empty set, every entry is coerced with String().
 * @param {unknown} mainChannelIds
 * @returns {Set<string>}
 */
function mainChannelSet(mainChannelIds) {
  return new Set((Array.isArray(mainChannelIds) ? mainChannelIds : []).map((id) => String(id)));
}

/**
 * The `<existing_lore>` input: ALL stored titles with their keys (titles+keys
 * only, capped to the 200 most recently updated -- so the analyzer never
 * creates a duplicate title it just cannot see), plus the full text of
 * entries the batch's own messages touch (so those can be updated with
 * context). '' when the lorebook is empty. See .claude/docs/prompt-contract.md,
 * "The analyzer".
 * @param {object[]} loreEntries   Every stored entry for the guild.
 * @param {string[]} batchTexts    Plain message contents of this batch.
 * @param {(id: string) => (string|null)} nameOf  Resolves `text`'s `<@id>` tokens
 *   to `name (id:...)`; `title`/`keys` are never token content, left untouched.
 */
function existingLoreBlock(loreEntries, batchTexts, nameOf) {
  const entries = Array.isArray(loreEntries) ? loreEntries : [];
  if (entries.length === 0) return '';
  const titles = [...entries]
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, 200)
    .map((entry) => ({ title: entry.title, keys: entry.keys }));
  const matched = keywordMatches(entries, batchTexts).map((entry) => ({
    title: entry.title,
    keys: entry.keys,
    text: resolveText(entry.text, nameOf),
  }));
  return block('existing_lore', JSON.stringify({ titles, matched }));
}

/**
 * Build one memory-update LLM request. Pure: no I/O, no clock reads besides
 * what is already baked into `messages`.
 *
 * @param {object} input
 * @param {object} input.prompts      Live prompts; `prompts.memory` is the system message.
 * @param {object} input.config       Live config.
 * @param {object} input.calibrator   From createCalibrator().
 * @param {object} input.profiles     Stored profiles of the batch's distinct non-self authors, keyed by user id.
 * @param {object} input.guildMemory  Stored guild memory.
 * @param {object} [input.channels]   Stored channel entries of the batch's distinct channels, keyed by channel id.
 * @param {object[]} input.messages   Slim buffered messages (oldest first) to summarize.
 * @param {string} input.selfName     The persona's display name in this guild.
 * @param {object[]} [input.loreEntries]  Every stored lorebook entry of the guild (store.getLore),
 *   for the `<existing_lore>` input; omitted or `features.lore: false` -> no block at all.
 * @param {Map<string, string>} [input.descriptions]  Item id -> describer caption
 *   (src/memory/describe.js), for pictures the analyzer cannot see itself.
 * @param {(id: string) => (string|null)} [input.nameOf]  Resolves a member id to their
 *   current stored name (`profile.names[0]`), for turning every `<@id>` token this
 *   request's views carry into `name (id:...)` -- see
 *   .claude/docs/prompt-contract.md, "Members are referred to by id, never by
 *   nickname". Omitted -> every token is left exactly as stored (no I/O of its own;
 *   the caller, src/memory/update.js#analyze, injects a store-backed lookup).
 * @returns {{ messages: object[], consumed: number }}
 */
export function buildMemoryRequest({ prompts, config, calibrator, profiles, guildMemory, channels, messages, selfName, loreEntries, descriptions, nameOf }) {
  const { timezone } = config.bot;
  const labels = requireLabels(prompts);
  const relationships = config.features?.relationships !== false;
  const episodesOn = config.features?.episodes !== false;
  const loreOn = config.features?.lore !== false;
  const resolveName = typeof nameOf === 'function' ? nameOf : () => null;
  const system = fillTemplate(prompts.memory, memoryTemplateValues(config, selfName));
  const characterBlock = relationships ? block('character', fillTemplate(prompts['character-card'], { name: selfName })) : '';

  const existingProfiles = {};
  for (const [id, profile] of Object.entries(profiles ?? {})) {
    const fields = pickProfileFields(profile);
    fields.character = resolveText(fields.character, resolveName);
    fields.style = resolveText(fields.style, resolveName);
    fields.relationship = resolveText(fields.relationship, resolveName);
    fields.interests = existingInterestsView(fields.interests, config.memory?.maxInterests, config.memory?.interestHalfLifeDays, resolveName);
    fields.details = existingDetailsView(fields.details, config.memory?.maxDetails, config.memory?.detailHalfLifeDays, resolveName);
    if (Array.isArray(profile?.aliases) && profile.aliases.length > 0) {
      const aliases = existingAliasesView(profile.aliases, config.memory?.maxAliases, config.memory?.aliasHalfLifeDays);
      if (aliases.length > 0) fields.aliases = aliases;
    }
    if (relationships) {
      const affinity = profile?.affinity ?? emptyAffinity();
      fields.affinity = { score: affinity.score, reason: resolveText(affinity.reason, resolveName) };
    }
    if (episodesOn && Array.isArray(profile?.episodes) && profile.episodes.length > 0) {
      fields.episodes = profile.episodes.map(({ date, what, quote, weight }) => ({ date, what: resolveText(what, resolveName), quote, weight }));
    }
    existingProfiles[id] = fields;
  }
  const profilesBlock = block('existing_profiles', JSON.stringify(existingProfiles));
  const loreBlock = loreOn ? existingLoreBlock(loreEntries, messages.map((m) => m.content).filter(Boolean), resolveName) : '';
  const guildBlock = block('existing_guild', JSON.stringify(pickGuildFields(guildMemory, resolveName)));

  const mainChannels = mainChannelSet(config.memory?.mainChannelIds);
  const existingChannels = {};
  for (const [id, channel] of Object.entries(channels ?? {})) {
    const fields = pickChannelFields(channel, resolveName);
    if (mainChannels.has(String(id))) fields.main = true;
    existingChannels[id] = fields;
  }
  const channelsBlock = block('existing_channels', JSON.stringify(existingChannels));

  const formatOptions = {
    timezone,
    gapMinutes: config.context.gapMarkerMinutes,
    maxChars: config.context.maxMessageChars,
    selfName,
    mode: 'memory',
    labels,
    descriptions,
  };
  const transcriptItems = formatTranscript(messages, formatOptions);
  const transcriptTexts = transcriptItems.map((item) => item.text);

  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const limit = Math.floor(config.llm.maxRequestTokens * config.llm.safetyMargin);

  const { kept } = fitSections(
    [
      {
        name: 'fixed',
        required: true,
        items: [system, characterBlock, profilesBlock, loreBlock, guildBlock, channelsBlock].filter(Boolean),
      },
      { name: 'transcript', keep: 'newest', items: transcriptTexts },
    ],
    limit,
    cost,
  );

  const keptTranscriptItems = transcriptItems.slice(transcriptItems.length - kept.transcript.length);
  const newMessagesBlock = block('new_messages', renderTranscript(keptTranscriptItems, timezone, labels));

  const user = [characterBlock, profilesBlock, loreBlock, guildBlock, channelsBlock, newMessagesBlock].filter(Boolean).join('\n\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // Every buffered message handed in is consumed once this request is sent,
    // even the oldest ones that did not fit in the transcript block — they
    // are gone either way and must not be re-sent on the next update.
    consumed: messages.length,
  };
}

function clampString(value, maxChars) {
  return value.trim().slice(0, maxChars);
}

function clampStringArray(value, maxChars, maxItems) {
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => clampString(item, maxChars))
    .slice(0, maxItems);
}

/**
 * Per-user sighting time for one analyzer batch, for dating `interests`/
 * `details` by the MESSAGE, not the wall clock the analyzer happens to run
 * at (see .claude/docs/prompt-contract.md, "Dates come from the messages").
 * `seenAtByUser` holds, for each non-self author, the timestamp of THAT
 * user's newest message in the batch; `seenAt` is the batch's own newest
 * message overall, the fallback used when a particular user is somehow
 * missing from the map. Shared by the live analyzer and the warm-up, which
 * feeds old history through the exact same `analyze()` path -- so an
 * old-history batch dates its sightings with the old timestamps, not
 * whenever the warm-up happened to process it.
 * @param {object[]} messages  Slim buffered messages (any order); `ts`/`authorId`/`self` read.
 * @returns {{ seenAtByUser: Map<string, number>, seenAt: number }}
 */
export function computeSeenAt(messages) {
  const seenAtByUser = new Map();
  let batchNewest = 0;
  for (const m of messages ?? []) {
    if (!Number.isFinite(m?.ts)) continue;
    batchNewest = Math.max(batchNewest, m.ts);
    if (m.self) continue; // the persona's own line is never a profile
    const id = String(m.authorId);
    const current = seenAtByUser.get(id);
    if (current === undefined || m.ts > current) seenAtByUser.set(id, m.ts);
  }
  return { seenAtByUser, seenAt: batchNewest || Date.now() };
}

/**
 * Author id -> the nick THIS batch's transcript used for them (their latest
 * message wins when it changed mid-batch) -- feeds `applyMemoryUpdate`'s
 * name-aware `Name (id:...)` normalization (see src/memory/mentions.js#toTokens)
 * so a member is recognised even before their stored profile has caught up
 * to a brand-new display name.
 * @param {object[]} messages  Slim buffered messages (oldest first); `authorId`/`authorName`/`self` read.
 * @returns {Map<string, string>}
 */
export function batchAuthorNamesMap(messages) {
  const names = new Map();
  for (const m of messages ?? []) {
    if (m?.self || !m?.authorName) continue;
    names.set(String(m.authorId), m.authorName);
  }
  return names;
}

/**
 * Validate and store the model's memory-update JSON. Never throws on garbage
 * input, never accepts a user id outside `knownUserIds`, never drops a field
 * that was not part of the update.
 *
 * @param {object} store
 * @param {string} guildId
 * @param {unknown} update         Parsed model output; treated as untrusted.
 * @param {object} cfg             `config.memory`.
 * @param {Set<string>} knownUserIds
 * @param {Set<string>} [knownChannelIds]  Channel ids present in the batch; a channel outside
 *   this set is rejected, mirroring `knownUserIds`.
 * @param {{ enabled: boolean, maxDeltaPerUpdate: number, historySize: number, now?: number }} [relationships]
 *   Only when `enabled`, `raw.affinity` (a `{ delta, reason }` change) is folded into the
 *   stored score via `store.adjustAffinity`. Absent/disabled -> affinity is ignored entirely.
 * @param {{ enabled: boolean, maxEpisodes: number, maxNew: number, now?: number }} [episodes]
 *   Only when `enabled`, each user's `raw.episodes` (a new-moments array) is folded in via
 *   `store.addEpisodes` (src/memory/episodes.js#mergeEpisodes). Absent/disabled -> ignored entirely.
 * @param {{ enabled: boolean, maxEntries: number, now?: number }} [lore]
 *   Only when `enabled`, `update.lore` (the server's lorebook) is folded in via `store.setLore`
 *   (src/memory/lore.js#upsertLore, source: 'analyzer'). Absent/disabled -> ignored entirely.
 * @param {{ seenAtByUser?: Map<string, number>, seenAt?: number }} [timing]  From `computeSeenAt`
 *   above; missing/absent falls back to `relationships.now`/`episodes.now`/the wall clock, same
 *   as before this option existed.
 * @param {Map<string, string>} [batchAuthorNames]  Author id -> the nick this batch's transcript
 *   used for them (see `batchAuthorNamesMap` below), so the `Name (id:...)` normalization below
 *   recognises a name even for someone whose stored profile has not caught up yet. Omitted ->
 *   only the stored profile's own `names` are known.
 * @returns {{ users: number, guild: boolean, self: boolean, affinity: number, channels: number, episodes: number, lore: number, interestsChanged: number }}
 */
export function applyMemoryUpdate(store, guildId, update, cfg, knownUserIds, knownChannelIds = new Set(), relationships, episodes, lore, timing, batchAuthorNames) {
  const result = { users: 0, guild: false, self: false, affinity: 0, channels: 0, episodes: 0, lore: 0, interestsChanged: 0 };
  if (!update || typeof update !== 'object' || Array.isArray(update)) return result;

  // A member is written as `<@id>` in every free-text field the analyzer
  // returns (see .claude/docs/prompt-contract.md, "Members are referred to
  // by id, never by nickname"); this normalizes the fallback shape the model
  // sometimes writes instead, `Name (id:123...)`, into the token -- but only
  // for an id this guild actually knows (an author of the batch, or an
  // existing stored profile), an unrecognised id is left exactly as written.
  const isKnownId = (id) => {
    const key = String(id);
    return knownUserIds.has(key) || store.getUser(guildId, key) != null;
  };
  // The known names for one id, stored profile names first, the batch's own
  // nick for them appended -- see toTokens' name-aware matching, which needs
  // the FULL name (however many words) to convert e.g. "Al Sus (id:...)"
  // correctly instead of guessing a word count.
  const namesOf = (id) => {
    const key = String(id);
    const stored = store.getUser(guildId, key)?.names ?? [];
    const batchNick = batchAuthorNames?.get?.(key);
    return batchNick ? [...stored, batchNick] : stored;
  };
  const tokenize = (text) => (typeof text === 'string' ? toTokens(text, isKnownId, namesOf) : text);
  const tokenizeArray = (values) => (Array.isArray(values) ? values.map(tokenize) : values);
  /** `ops.add`/`ops.update` items' `note` field, tokenized in place. */
  const tokenizeNoted = (items) =>
    Array.isArray(items)
      ? items.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? { ...item, note: tokenize(item.note) } : item))
      : items;
  /** A `details.add` entry, a bare string or `{ text, sure? }`, `text` tokenized. */
  const tokenizeDetail = (item) => {
    if (typeof item === 'string') return tokenize(item);
    if (item && typeof item === 'object' && !Array.isArray(item)) return { ...item, text: tokenize(item.text) };
    return item;
  };

  if (update.users && typeof update.users === 'object' && !Array.isArray(update.users)) {
    for (const [userId, raw] of Object.entries(update.users)) {
      if (!knownUserIds.has(String(userId))) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      // Incremental profile ops (see .claude/docs/prompt-contract.md, "The
      // analyzer"): prose fields pass through as-is, store.applyProfileOps
      // decides whether they are non-empty and clamps them. `interests`/
      // `details` are ops objects; one release of backward tolerance accepts
      // the OLD shapes too (a string interests blob, an array of details).
      const ops = {};
      for (const key of ['character', 'style', 'relationship']) {
        if (typeof raw[key] === 'string') ops[key] = tokenize(raw[key]);
      }

      if (typeof raw.interests === 'string') {
        const migrated = migrateInterests(raw.interests);
        if (migrated.length > 0) ops.interests = { add: migrated.map(({ topic, note }) => ({ topic, note: tokenize(note) })) };
      } else if (raw.interests && typeof raw.interests === 'object' && !Array.isArray(raw.interests)) {
        ops.interests = {
          ...raw.interests,
          add: tokenizeNoted(raw.interests.add),
          update: tokenizeNoted(raw.interests.update),
        };
      }

      if (Array.isArray(raw.details)) {
        ops.details = { add: raw.details.map(tokenizeDetail) };
      } else if (raw.details && typeof raw.details === 'object' && !Array.isArray(raw.details)) {
        ops.details = { ...raw.details, add: Array.isArray(raw.details.add) ? raw.details.add.map(tokenizeDetail) : raw.details.add };
      }

      // Aliases are literal nicknames, never a `<@id>` reference to someone
      // else -- passed through untouched, see .claude/docs/prompt-contract.md,
      // "Aliases".
      if (raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases)) {
        ops.aliases = raw.aliases;
      }

      const profileOpsNow = relationships?.now ?? episodes?.now ?? Date.now();
      const seenAt = timing?.seenAtByUser?.get(String(userId)) ?? timing?.seenAt ?? profileOpsNow;
      const beforeInterests = JSON.stringify(store.getUser(guildId, userId)?.interests ?? []);

      store.applyProfileOps(guildId, userId, ops, {
        fieldChars: cfg.fieldChars,
        maxInterests: cfg.maxInterests,
        maxInterestsStored: cfg.maxInterestsStored,
        topicChars: cfg.interestTopicChars,
        noteChars: cfg.interestNoteChars,
        interestHalfLifeDays: cfg.interestHalfLifeDays,
        maxDetails: cfg.maxDetails,
        maxDetailsStored: cfg.maxDetailsStored,
        detailHalfLifeDays: cfg.detailHalfLifeDays,
        maxAliases: cfg.maxAliases,
        maxAliasesStored: cfg.maxAliasesStored,
        aliasHalfLifeDays: cfg.aliasHalfLifeDays,
        confirmGapHours: cfg.confirmGapHours,
        now: profileOpsNow,
        seenAt,
      });
      result.users += 1;

      const afterInterests = JSON.stringify(store.getUser(guildId, userId)?.interests ?? []);
      if (afterInterests !== beforeInterests) result.interestsChanged += 1;

      if (relationships?.enabled && raw.affinity && typeof raw.affinity === 'object' && !Array.isArray(raw.affinity)) {
        const before = store.getUser(guildId, userId)?.affinity?.score ?? 0;
        const after = store.adjustAffinity(guildId, userId, raw.affinity.delta, tokenize(raw.affinity.reason), {
          // The model's verdict is never applied unclamped, even if the config block is missing.
          maxDelta: relationships.maxDeltaPerUpdate ?? 15,
          historySize: relationships.historySize ?? 10,
          now: relationships.now,
        });
        if (after.score !== before) result.affinity += 1;
      }

      if (episodes?.enabled && Array.isArray(raw.episodes) && raw.episodes.length > 0) {
        // `quote` is the person's own words verbatim -- never tokenized.
        const tokenizedEpisodes = raw.episodes.map((ep) =>
          ep && typeof ep === 'object' && !Array.isArray(ep) ? { ...ep, what: tokenize(ep.what), feeling: tokenize(ep.feeling) } : ep,
        );
        const added = store.addEpisodes(guildId, userId, tokenizedEpisodes, {
          maxEpisodes: episodes.maxEpisodes,
          maxNew: episodes.maxNew,
          now: episodes.now,
        });
        result.episodes += added;
      }
    }
  }

  if (lore?.enabled && Array.isArray(update.lore) && update.lore.length > 0) {
    // `title`/`keys` are the identity a person actually types, never tokenized.
    const tokenizedLore = update.lore.map((entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry, text: tokenize(entry.text) } : entry,
    );
    result.lore = store.setLore(guildId, tokenizedLore, { source: 'analyzer', now: lore.now, maxEntries: lore.maxEntries });
  }

  if (update.channels && typeof update.channels === 'object' && !Array.isArray(update.channels)) {
    for (const [channelId, raw] of Object.entries(update.channels)) {
      if (!knownChannelIds.has(String(channelId))) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      const fields = {};
      for (const key of ['purpose', 'topics', 'tone']) {
        if (typeof raw[key] === 'string') fields[key] = clampString(tokenize(raw[key]), cfg.fieldChars);
      }

      store.updateChannel(guildId, channelId, fields);
      result.channels += 1;
    }
  }

  const guildFields = {};
  if (update.guild && typeof update.guild === 'object' && !Array.isArray(update.guild)) {
    const g = update.guild;
    if (typeof g.patterns === 'string' && g.patterns.trim()) {
      guildFields.patterns = clampString(tokenize(g.patterns), cfg.fieldChars * 2);
    }
    if (typeof g.starters === 'string' && g.starters.trim()) {
      guildFields.starters = clampString(tokenize(g.starters), cfg.fieldChars * 2);
    }
    if (Array.isArray(g.injokes) && g.injokes.length) {
      const injokes = clampStringArray(tokenizeArray(g.injokes), 200, cfg.maxInjokes);
      if (injokes.length) guildFields.injokes = injokes;
    }
  }
  if (Object.keys(guildFields).length > 0) {
    store.updateGuild(guildId, guildFields);
    result.guild = true;
  }

  if (Array.isArray(update.self) && update.self.length > 0) {
    const self = clampStringArray(tokenizeArray(update.self), 200, cfg.maxSelfFacts);
    if (self.length > 0) {
      store.updateGuild(guildId, { self });
      result.self = true;
    }
  }

  return result;
}

/**
 * Record that a normalized message happened, for the counters kept on a
 * user's profile and a channel's map entry: `touchUser` (skipped for the
 * persona's own messages) and `touchChannel`. Shared by `observe()` (the live
 * pipeline) and the memory warm-up (src/memory/warmup.js), which walks
 * history instead of the live stream — both must compute the same counters
 * the same way, so this is the one place that does it.
 * @param {object} store
 * @param {string} guildId
 * @param {object} normalized  A normalized message (see src/discord/collect.js);
 *   callers are expected to have already dropped other bots' messages.
 */
export function touchMemory(store, guildId, normalized) {
  if (!normalized.self) {
    store.touchUser(guildId, normalized.authorId, normalized.authorName, normalized.ts);
  }
  store.touchChannel(
    guildId,
    normalized.channelId,
    { name: normalized.channelName, category: normalized.channelCategory, topic: normalized.channelTopic },
    normalized.ts,
  );
}

/**
 * @param {object} deps
 * @param {object} deps.hot          Live config + prompts; read at the moment of use.
 * @param {object} deps.store
 * @param {object} deps.llm          From createLlm().
 * @param {object} deps.calibrator   From createCalibrator().
 * @param {(guildId: string) => string} deps.getSelfName
 * @param {() => number} [deps.now]
 */
/** `nameOf` for buildMemoryRequest's token resolution: a member's current
 * stored name, or null when the guild has no profile for that id -- see
 * .claude/docs/prompt-contract.md, "Members are referred to by id, never by
 * nickname". The one place `analyze()`/`estimate()` touch the store for this. */
function storeNameOf(store, guildId) {
  return (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
}

export function createMemoryUpdater({ hot, store, llm, calibrator, getSelfName, now = Date.now }) {
  const running = new Set();
  const backoffUntil = new Map();
  // Per-guild in-memory factor on the live batch size (1 = normal). Halved on
  // a 'truncated'/'bad-json' failure so the next attempt for that guild asks
  // for less, floored at MIN_LIVE_BATCH messages; deleted (back to 1) on the
  // next success. Never persisted: a restart always starts at normal size.
  const sizeFactors = new Map();

  /**
   * Called for every guild message the persona sees, including its own.
   * `direct` marks a message addressed to the persona (a trigger), so the
   * analyzer can tell how people talk TO it apart from general chatter.
   */
  function observe(guildId, normalized, { direct = false } = {}) {
    if (normalized.bot) return;
    touchMemory(store, guildId, normalized);

    const slim = {
      id: normalized.id,
      channelId: normalized.channelId,
      channelName: normalized.channelName,
      authorId: normalized.authorId,
      authorName: normalized.authorName,
      self: normalized.self,
      bot: normalized.bot,
      content: normalized.content,
      ts: normalized.ts,
      replyToId: normalized.replyToId,
      // No URL ever survives into the buffer -- but the item `id` does, so
      // the live analyzer can look up a describer caption already warmed
      // into the cache by src/discord/events.js (see analyze() below). A
      // sticker keeps `id`/`name`/`format` (its URL is rebuilt from those via
      // stickerUrl when needed); a custom emoji keeps only `id`/`name` (its
      // URL is rebuilt via emojiUrl).
      attachments: (normalized.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, id: a.id, durationSec: a.durationSec ?? null })),
      links: (normalized.links ?? []).map((l) => ({ kind: l.kind, name: l.title || l.site || '', id: l.id, durationSec: null })),
      stickers: (normalized.stickers ?? []).map((s) => ({ id: s.id, name: s.name, format: s.format })),
      emojis: (normalized.emojis ?? []).map((e) => ({ id: e.id, name: e.name })),
      direct: Boolean(direct),
    };
    const cfg = hot.config.memory;
    store.pushBuffer(guildId, slim, cfg.batchMessages * 3);
  }

  /**
   * The stored profiles/channels `analyze()` and `estimate()` both need for
   * `messages`, plus the distinct author/channel ids they were built from
   * (kept as strings-to-be via `knownUserIds`/`knownChannelIds` downstream).
   */
  function collectContext(guildId, messages) {
    const authorIds = [...new Set(messages.filter((m) => !m.self).map((m) => m.authorId))];
    const profiles = {};
    for (const id of authorIds) {
      const profile = store.getUser(guildId, id);
      if (profile) profiles[id] = profile;
    }

    const channelIds = [...new Set(messages.map((m) => m.channelId).filter((id) => id != null))];
    const channels = {};
    for (const id of channelIds) {
      const channel = store.getChannel(guildId, id);
      if (channel) channels[id] = channel;
    }

    return { authorIds, profiles, channelIds, channels };
  }

  /**
   * The one analyzer code path: build the memory-update request from
   * `messages`, send it to the LLM, parse the reply and apply it to the
   * store. Used both by `run()` (a batch shifted off the live buffer) and by
   * the memory warm-up (history batches, see src/memory/warmup.js). Never
   * touches the live buffer and never throws — a failure is reported in the
   * returned `error`, not raised.
   *
   * `usage`/`estimated` reflect a completion whenever one was actually
   * received from the provider — including when `ok: false` because parsing
   * or applying the answer failed afterwards, since those tokens were billed
   * regardless. Only a failure before/without a completion (a build error,
   * `TokenLimitError`, a network/provider error, a missing prompt) reports
   * `usage: null, estimated: 0`: nothing was spent.
   *
   * @param {string} guildId
   * @param {object[]} messages  Slim messages (oldest first) to summarize; NOT read from or removed off any buffer.
   * @param {object} [opts]
   * @param {boolean} [opts.countAgainstDailyCap]  Forwarded to llm.complete(); the warm-up passes `false`
   *   because it has its own rail (a token budget), not the daily request cap.
   * @param {Map<string, string>} [opts.descriptions]  Pre-computed describer captions (see
   *   src/memory/warmup.js, which budgets and charges these itself). When omitted, cached
   *   captions are looked up by item id instead -- see below.
   * @returns {Promise<{ ok: boolean, usage: object|null, estimated: number, result: object|null, error?: Error }>}
   */
  async function analyze(guildId, messages, { countAgainstDailyCap = true, descriptions } = {}) {
    const cfg = hot.config.memory;
    const promptText = hot.prompts.memory;
    if (!promptText) {
      log.warn('memory: no memory prompt configured, skipping', { guildId });
      return { ok: false, usage: null, estimated: 0, result: null, reason: 'no-prompt' };
    }

    const { authorIds, profiles, channelIds, channels } = collectContext(guildId, messages);

    // The live analyzer never triggers a NEW description request itself --
    // the buffered messages carry no URL to describe from anyway (see
    // observe() above). It only reads whatever src/discord/events.js has
    // already warmed into the cache for these item ids, fire-and-forget, as
    // the messages came in; a cache miss just renders blind.
    let effectiveDescriptions = descriptions;
    if (!effectiveDescriptions && hot.config.features?.mediaDescriptions === true) {
      const cache = store.getMediaCache(guildId);
      effectiveDescriptions = new Map();
      for (const message of messages) {
        for (const item of [...(message.attachments ?? []), ...(message.links ?? [])]) {
          if (item.id == null || !isDescribable(item)) continue;
          const cached = cache[item.id];
          if (cached && !cached.miss) effectiveDescriptions.set(item.id, cached.text);
        }
        // Stickers/emoji keep no URL in the buffer (see observe() above) --
        // stickerUrl rebuilds it from id/format only to tell a Lottie
        // sticker (never describable) apart, the cache is still looked up by
        // the stable `sticker:<id>` / `emoji:<id>` key alone.
        for (const sticker of message.stickers ?? []) {
          if (!stickerUrl(sticker.id, sticker.format)) continue;
          const itemId = `sticker:${sticker.id}`;
          const cached = cache[itemId];
          if (cached && !cached.miss) effectiveDescriptions.set(itemId, cached.text);
        }
        for (const emoji of message.emojis ?? []) {
          const itemId = `emoji:${emoji.id}`;
          const cached = cache[itemId];
          if (cached && !cached.miss) effectiveDescriptions.set(itemId, cached.text);
        }
      }
    }

    let completion;
    try {
      const { messages: llmMessages } = buildMemoryRequest({
        prompts: hot.prompts,
        config: hot.config,
        calibrator,
        profiles,
        guildMemory: store.getGuild(guildId),
        channels,
        messages,
        selfName: getSelfName(guildId),
        loreEntries: store.getLore(guildId),
        descriptions: effectiveDescriptions,
        nameOf: storeNameOf(store, guildId),
      });

      completion = await llm.complete(llmMessages, {
        model: cfg.model ?? undefined,
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: 0.3,
        countAgainstDailyCap,
        // A 150-message batch with an 8000-token answer on a large model can
        // take longer than the chat timeout -- the analyzer gets its own,
        // much larger budget (see .claude/docs/prompt-contract.md, "The analyzer").
        timeoutMs: cfg.timeoutMs ?? hot.config.llm.timeoutMs,
      });
    } catch (err) {
      // Nothing was billed: the request never left this process, or the
      // provider never returned a completion. `status` (the HTTP status when
      // the error carries one, e.g. 429) lets a caller -- the warm-up -- tell
      // a rate limit apart from a genuine failure without parsing `detail`.
      const reason = err instanceof TokenLimitError ? 'token-limit' : 'llm-error';
      return { ok: false, usage: null, estimated: 0, result: null, error: err, reason, detail: detailOf(err), status: err?.statusCode };
    }

    try {
      const update = parseJsonObject(completion.text);
      const knownUserIds = new Set(authorIds.map(String));
      const knownChannelIds = new Set(channelIds.map(String));
      const relationshipsOn = hot.config.features?.relationships !== false;
      const relationships = relationshipsOn
        ? { enabled: true, ...hot.config.relationships, now: now() }
        : undefined;
      const episodesOn = hot.config.features?.episodes !== false;
      const episodes = episodesOn
        ? { enabled: true, maxEpisodes: cfg.maxEpisodes, maxNew: cfg.maxNewEpisodes, now: now() }
        : undefined;
      const loreOn = hot.config.features?.lore !== false;
      const lore = loreOn
        ? { enabled: true, maxEntries: hot.config.lore?.maxEntries ?? Infinity, now: now() }
        : undefined;
      const timing = computeSeenAt(messages);
      const result = applyMemoryUpdate(
        store,
        guildId,
        update,
        cfg,
        knownUserIds,
        knownChannelIds,
        relationships,
        episodes,
        lore,
        timing,
        batchAuthorNamesMap(messages),
      );

      return { ok: true, usage: completion.usage ?? null, estimated: completion.estimated ?? 0, result };
    } catch (err) {
      // The completion arrived (and was billed) but its answer was garbage:
      // report the real usage/estimated so a caller charging a budget still
      // charges it. `reason` tells a cut-off completion (never going to
      // parse, no matter how many times it is retried) from plain bad JSON.
      const reason = looksTruncated(completion.text, completion.finishReason) ? 'truncated' : 'bad-json';
      return {
        ok: false,
        usage: completion.usage ?? null,
        estimated: completion.estimated ?? 0,
        result: null,
        error: err,
        reason,
        detail: detailOf(err),
      };
    }
  }

  /**
   * Calibrated input-token estimate of the exact memory-update request
   * `analyze` would send for `messages`, built through the same
   * `buildMemoryRequest` path — so it carries the memory prompt, the
   * character card and the stored profiles/channels JSON, not just the raw
   * message contents. Used by the warm-up (src/memory/warmup.js) to judge
   * whether a batch is affordable before spending a real request on it.
   * Never throws: if the request cannot even be built (e.g. broken prompts),
   * falls back to a cheap content-only heuristic so that check alone cannot
   * crash a warm-up run.
   * @param {string} guildId
   * @param {object[]} messages  Slim messages (oldest first), same shape `analyze` expects.
   * @returns {number}
   */
  function estimate(guildId, messages) {
    try {
      const { profiles, channels } = collectContext(guildId, messages);
      const { messages: llmMessages } = buildMemoryRequest({
        prompts: hot.prompts,
        config: hot.config,
        calibrator,
        profiles,
        guildMemory: store.getGuild(guildId),
        channels,
        messages,
        selfName: getSelfName(guildId),
        loreEntries: store.getLore(guildId),
        nameOf: storeNameOf(store, guildId),
      });
      return calibrator.apply(estimateMessages(llmMessages));
    } catch {
      return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
    }
  }

  /** Run a memory update for one guild if its buffer is due and it is not busy/backed off. */
  async function run(guildId) {
    running.add(guildId);
    try {
      const cfg = hot.config.memory;
      const buffer = store.getBuffer(guildId);
      const factor = sizeFactors.get(guildId) ?? 1;
      const normalTake = cfg.batchMessages * 2;
      // Only the degraded (factor < 1) path is floored at MIN_LIVE_BATCH; the
      // normal size is left exactly as configured either way.
      const desired = factor === 1 ? normalTake : Math.max(MIN_LIVE_BATCH, Math.floor(normalTake * factor));
      const take = Math.min(buffer.length, desired);
      const messages = buffer.slice(0, take);

      const outcome = await analyze(guildId, messages);
      if (outcome.ok) {
        sizeFactors.delete(guildId); // back to normal size after a success
        store.shiftBuffer(guildId, messages.length);
        store.flush();
        log.info('memory: update applied', { guildId, consumed: messages.length, ...outcome.result });
        return;
      }

      if (outcome.reason === 'truncated' || outcome.reason === 'bad-json') {
        // Retrying the same-size batch can never succeed: the completion is
        // being cut by the output token cap, not by transient bad luck.
        // Halve the batch size for next time instead of the usual back-off.
        sizeFactors.set(guildId, factor / 2);
        log.warn('memory: update failed, halving the batch size for next time', {
          guildId,
          reason: outcome.reason,
          detail: outcome.detail,
        });
      } else {
        backoffUntil.set(guildId, now() + BACKOFF_MS);
        log.warn('memory: update failed, backing off', {
          guildId,
          reason: outcome.reason,
          detail: outcome.detail,
          error: outcome.error,
        });
      }
    } finally {
      running.delete(guildId);
    }
  }

  /** Check every guild and kick off a memory update for the ones that are due. */
  async function tick() {
    const nowMs = now();
    const cfg = hot.config.memory;
    const relationshipsCfg = hot.config.features?.relationships !== false ? hot.config.relationships : undefined;
    const jobs = [];
    for (const guildId of store.listGuilds()) {
      if (running.has(guildId)) continue;
      if (nowMs < (backoffUntil.get(guildId) ?? 0)) continue;
      if (!isDue(store.getBuffer(guildId), nowMs, cfg, relationshipsCfg)) continue;
      jobs.push(run(guildId));
    }
    await Promise.all(jobs);
  }

  return { observe, tick, run, analyze, estimate };
}
