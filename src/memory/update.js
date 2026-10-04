// Turns the raw stream of Discord messages into long-term memory. Every
// message the persona sees is buffered (`observe`); once enough have piled up
// (`isDue`), a periodic tick (`tick`, called by index.js every 60s) asks the
// LLM to merge what happened into per-user profiles, server-wide patterns and
// facts the persona has claimed about itself (`run`, via `buildMemoryRequest`
// + `applyMemoryUpdate`). A batch writes to its own authors; members who did
// not write in it are listed in a roster only so that an alias stated about
// one of them can still be stored (aliases only, never another field).
// Direct messages (private chat) go to a per-member
// private buffer instead and are analyzed into that member's private layer
// only (`runPrivate`/`analyzePrivate`, via `applyPrivateUpdate`): nothing said
// in private ever reaches the public profile, the server notes or the lore.
// Memory is persistent: nothing here ever wipes it — a failed update just
// leaves the buffer alone and backs off for a while.

import { isPlainObject } from '../config.js';
import { fitSections, SectionsTooLargeError } from '../llm/budget.js';
import { estimateTokens } from '../llm/tokens.js';
import { formatTranscript, renderTranscript } from '../discord/format.js';
import { parseJsonObject } from '../llm/parse.js';
import { TokenLimitError } from '../llm/openrouter.js';
import { isDescribable, mediaParts, stickerUrl } from '../discord/media.js';
import { log } from '../log.js';
import { MINUTE_MS } from '../time.js';
import { emptyAffinity, roundScore, affinityBand, applyDelta } from './affinity.js';
import { emptyChannel } from './store.js';
import { keywordMatches } from './lore.js';
import { normalizeInterests, normalizeTopic } from './interests.js';
import { normalizeDetails } from './details.js';
import { applyAliasOps } from './aliases.js';
import { emojiUsageOpts } from './emoji-usage.js';
import { gifOpts } from './gifs.js';
import { topByRank } from './ranking.js';
import { ID_DIGITS, toTokens, fromTokens } from './mentions.js';
import { clampText } from './clamp.js';
import { videoStateFromCache } from './describe.js';
import { isVideoVisionOn } from './youtube-check.js';
import { block, fillPromptTemplate, renderProfile } from '../behavior/prompt.js';
import { effectiveAffinity } from '../behavior/private.js';

const BACKOFF_MS = 15 * 60_000;
const MIN_LIVE_BATCH = 20; // the live analyzer never shrinks below this many messages
const CHANNEL_FIELDS = ['purpose', 'topics', 'tone']; // the analyzer's own fields of a channel entry

/**
 * The temperature of every analyzer-role request: the stream analyzer here, and the warmup's
 * channel/profile/server requests and the portrait refresh (src/memory/warmup.js). The one
 * reader of `memory.temperature`; called at each request, so a live edit reaches the next one.
 * @param {object} [config]  The live config.
 * @returns {number}  `memory.temperature` when it is a finite number, else 0.3 (config.json's value).
 */
export function analyzerTemperature(config) {
  const temperature = config?.memory?.temperature;
  return Number.isFinite(temperature) ? temperature : 0.3;
}

// Fallbacks for the memory-prompt placeholders below (and for the guild
// `learned` limits and the affinity rails), equal to config.json's own
// defaults -- used only when a deployment's config is missing the key.
export const MEMORY_LIMIT_DEFAULTS = {
  fieldChars: 1000,
  maxDetails: 15,
  maxInjokes: 15,
  maxSelfFacts: 20,
  maxNewEpisodes: 3,
  maxEpisodes: 20,
  maxDeltaPerUpdate: 15,
  historySize: 10,
  maxInterests: 12,
  interestTopicChars: 40,
  interestNoteChars: 120,
  loreTextChars: 600,
  maxLearned: 20,
  maxLearnedStored: 60,
  learnedChars: 160,
  learnedHalfLifeDays: 720,
};

/**
 * The log/outcome `detail` of a failed request: `error?.message`, trimmed to
 * 200 chars. Only for errors raised before an answer exists (the provider,
 * the network, the request budget), never for an answer that failed to parse
 * -- see `errorNameOf`. Shared with src/memory/warmup.js.
 * @param {unknown} err
 * @returns {string|undefined}
 */
export function detailOf(err) {
  return err?.message ? String(err.message).slice(0, 200) : undefined;
}

/**
 * The log/outcome `detail` of an answer that failed to parse or to apply: the
 * error's name only (`SyntaxError`, `TypeError`, `Error`). A JSON.parse
 * message quotes the model's text, which is message contents. Shared with
 * src/memory/warmup.js.
 * @param {unknown} err
 * @returns {string}
 */
export function errorNameOf(err) {
  return typeof err?.name === 'string' && err.name ? err.name : 'Error';
}

/**
 * Whether a completion looks cut off by the output token cap: the provider
 * said so (`finish_reason: 'length'`), or the text has no closing `}` for
 * its first `{` (the same condition `parseJsonObject` fails on). Shared with
 * src/memory/warmup.js.
 * @param {string} text
 * @param {string|undefined} finishReason
 * @returns {boolean}
 */
export function looksTruncated(text, finishReason) {
  if (finishReason === 'length') return true;
  const start = String(text ?? '').indexOf('{');
  if (start === -1) return false;
  const end = String(text ?? '').lastIndexOf('}');
  return end <= start;
}

/**
 * Whether the buffered messages of one guild are ready for a memory update.
 * @param {object[]} buffer  Buffered slim messages, oldest first.
 * @param {number} nowMs
 * @param {object} cfg       `config.memory`.
 * @param {object} [relationshipsCfg]  `config.relationships`, only when the feature is on. A
 *   pile-up of messages addressed to the persona (`direct: true`) triggers an update early,
 *   so reactions to how people talk TO it do not wait for a full batch.
 */
export function isDue(buffer, nowMs, cfg, relationshipsCfg) {
  if (buffer.length >= cfg.batchMessages) return true;
  if (buffer.length >= cfg.minBatchMessages) {
    const oldest = buffer[0];
    if (oldest && nowMs - oldest.ts >= cfg.maxBatchAgeMinutes * MINUTE_MS) return true;
  }
  if (relationshipsCfg?.directTriggerCount > 0) {
    const directCount = buffer.reduce((count, message) => count + (message.direct ? 1 : 0), 0);
    if (directCount >= relationshipsCfg.directTriggerCount) return true;
  }
  return false;
}

/**
 * The `{{fieldChars}}`/`{{maxDetails}}`/... placeholders `prompts.memory` may use, filled from
 * the live config so a prompt states the same limits the code actually clamps to. Missing config
 * keys fall back to MEMORY_LIMIT_DEFAULTS (config.json's own defaults); an unknown placeholder in
 * the prompt is left untouched by fillPromptTemplate regardless.
 * @param {object} config  Live config (`config.memory`, `config.relationships`, `config.lore`).
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
    loreTextChars: config.lore?.textChars ?? MEMORY_LIMIT_DEFAULTS.loreTextChars,
    maxLearned: memoryCfg.maxLearned ?? MEMORY_LIMIT_DEFAULTS.maxLearned,
    learnedChars: memoryCfg.learnedChars ?? MEMORY_LIMIT_DEFAULTS.learnedChars,
  };
}

/**
 * `prompts.labels`, or a throw: a deployment with no/broken labels.json must fail loudly, not
 * send a broken prompt. Shared with every warmup request builder (src/memory/warmup.js).
 * @param {object} prompts
 * @returns {object}
 */
export function requireLabels(prompts) {
  const labels = prompts?.labels;
  if (!labels || !labels.transcript) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  return labels;
}

/** Only the fields the memory prompt is allowed to see/update for a user profile.
 * `interests`/`details` are validated via normalizeInterests/normalizeDetails
 * (defensive; store.getUser already normalises on read). */
function pickProfileFields(profile) {
  const { names = [], character = '', style = '', relationship = '' } = profile ?? {};
  const interests = normalizeInterests(profile?.interests);
  const details = normalizeDetails(profile?.details).items;
  return { names, character, interests, style, details, relationship };
}

/** `YYYY-MM-DD` of an ISO timestamp, or `undefined` (so JSON.stringify omits
 * the key entirely) when the date is unknown -- see
 * docs/prompt-contract.md, "The input view of a stored item". */
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
 * docs/prompt-contract.md, "Members are referred to by id, never by
 * nickname". `maxInterests` not an integer -> every stored interest
 * (unlimited, matching the behaviour before this feature); `halfLifeDays` not
 * a positive number -> no decay, ranked by weight alone. See
 * docs/prompt-contract.md, "The analyzer" and "More is stored than
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
 * names, top `maxAliases` by rank -- see docs/prompt-contract.md,
 * "Aliases". Alias names are never token-resolved: they are literal
 * nicknames, not free text that could name a member by id. Stored JSON is
 * hand-editable: an item without a string `name` is skipped, never thrown on
 * (it would otherwise fail every batch whose roster or authors include its member). */
function existingAliasesView(aliases, maxAliases, halfLifeDays) {
  const list = Array.isArray(aliases) ? aliases.filter((item) => typeof item?.name === 'string') : [];
  return topByRank(list, maxAliases, halfLifeDays).map((item) => item.name);
}

/**
 * `memory.aliasRosterSize`: how many members the analyzer's `<known_members>` roster lists at
 * most; 0 = no roster. Missing or not a non-negative integer -> 40, config.json's value. Read
 * at each request (buildMemoryRequest, and analyze() before it lists the stored profiles).
 * @param {object} [config]  The live config.
 * @returns {number}
 */
function aliasRosterSize(config) {
  const size = config?.memory?.aliasRosterSize;
  return Number.isInteger(size) && size >= 0 ? size : 40;
}

/** The distinct non-self author ids of `messages`, as strings, in first-seen order. */
function batchAuthorIds(messages) {
  return [...new Set((messages ?? []).filter((m) => !m?.self).map((m) => String(m.authorId)))];
}

/**
 * The `<known_members>` roster: stored members who are NOT among `authorIds`, most recently
 * seen (`lastSeen`) first, at most `size` of them. Each entry is the member's id plus one
 * `"<id>":{"names":[...],"aliases":[...]}` fragment holding exactly what `<existing_profiles>`
 * shows for names and aliases -- every stored display name, newest first, and the
 * `existingAliasesView` list (key omitted when empty) -- and nothing else. A profile with
 * neither a name nor an alias gives the analyzer nothing to match and is left out.
 * @param {object[]} [pool]  Stored profiles (store.listUserProfiles): `id`, `names`, `aliases`, `lastSeen` read.
 * @param {Set<string>} authorIds
 * @param {number} size
 * @param {object} memoryCfg  `config.memory` (`maxAliases`, `aliasHalfLifeDays`).
 * @returns {{ id: string, text: string }[]}
 */
function aliasRoster(pool, authorIds, size, memoryCfg) {
  if (size <= 0 || !Array.isArray(pool)) return [];
  const listed = new Set();
  const members = [];
  for (const profile of pool) {
    const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
    if (!id || authorIds.has(id) || listed.has(id)) continue;
    listed.add(id);
    const usable = (name) => typeof name === 'string' && name.trim() !== '';
    const names = (Array.isArray(profile.names) ? profile.names : []).filter(usable);
    const aliases = existingAliasesView(profile.aliases, memoryCfg.maxAliases, memoryCfg.aliasHalfLifeDays).filter(usable);
    if (names.length === 0 && aliases.length === 0) continue;
    const lastSeenMs = Date.parse(profile.lastSeen ?? '');
    members.push({ id, names, aliases, lastSeenMs: Number.isFinite(lastSeenMs) ? lastSeenMs : -Infinity });
  }
  // Newest first; an unknown lastSeen last; ties by id, so the order never depends on the pool's.
  members.sort((a, b) => b.lastSeenMs - a.lastSeenMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return members.slice(0, size).map(({ id, names, aliases }) => {
    const view = aliases.length > 0 ? { names, aliases } : { names };
    return { id, text: `${JSON.stringify(id)}:${JSON.stringify(view)}` };
  });
}

/** The `<existing_guild>` view of the things people taught the persona: only
 * the top `maxLearned` by rank (decayed with `halfLifeDays`), in rank order
 * -- `{ id, text, from, seen, last }` (`seen` = weight, `last` = the
 * date-only lastSeen, omitted when unknown; `from` omitted when the item has
 * no teacher). `text` and `from` are resolved via `nameOf`, same as
 * `existingDetailsView` above. Stored JSON is validated first (defensive;
 * store.getGuild already normalises on read). */
function existingLearnedView(guildMemory, maxLearned, halfLifeDays, nameOf) {
  const learned = normalizeDetails(guildMemory?.learned, guildMemory?.learnedNextId).items;
  return topByRank(learned, maxLearned, halfLifeDays).map(({ id, text, from, weight, lastSeen }) => {
    const view = { id, text: resolveText(text, nameOf) };
    if (from) view.from = resolveText(from, nameOf);
    view.seen = weight;
    view.last = dateOnly(lastSeen);
    return view;
  });
}

/** Only the fields the memory prompt is allowed to see/update for guild
 * memory, with every free-text field resolved (`<@id>` -> `name (id:...)`)
 * via `nameOf`. `memoryCfg` (`config.memory`) sizes the `learned` view
 * (`maxLearned`, `learnedHalfLifeDays`, config.json's defaults when absent). */
function pickGuildFields(guildMemory, nameOf, memoryCfg = {}) {
  const { patterns = '', starters = '', injokes = [], self = [] } = guildMemory ?? {};
  return {
    patterns: resolveText(patterns, nameOf),
    starters: resolveText(starters, nameOf),
    injokes: resolveTextArray(injokes, nameOf),
    self: resolveTextArray(self, nameOf),
    learned: existingLearnedView(
      guildMemory,
      memoryCfg.maxLearned ?? MEMORY_LIMIT_DEFAULTS.maxLearned,
      memoryCfg.learnedHalfLifeDays ?? MEMORY_LIMIT_DEFAULTS.learnedHalfLifeDays,
      nameOf,
    ),
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
 * see docs/prompt-contract.md, "Main channels are the source of the
 * portrait". Garbage config (not an array, non-string entries) never throws:
 * a non-array collapses to an empty set, every entry is coerced with String().
 * Shared with src/memory/warmup.js.
 * @param {unknown} mainChannelIds
 * @returns {Set<string>}
 */
export function mainChannelSet(mainChannelIds) {
  return new Set((Array.isArray(mainChannelIds) ? mainChannelIds : []).map((id) => String(id)));
}

/**
 * The `<existing_lore>` input: ALL stored titles with their keys (titles+keys
 * only, capped to the 200 most recently updated -- so the analyzer never
 * creates a duplicate title it just cannot see), plus the full text of
 * entries the batch's own messages touch (so those can be updated with
 * context). '' when the lorebook is empty. See docs/prompt-contract.md,
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
 * The character card followed by the owner's live rules (`prompts.rules`) -- exactly how the chat
 * system prompt composes the same two files (src/behavior/prompt.js#buildRequest): both
 * placeholders filled the same way, joined by a blank line; rules absent/empty -> the card alone.
 * Shared by this module's own `<character>` block and every request src/memory/warmup.js sends
 * that carries one, so a `/nep rule add` reaches memory work the same turn it reaches the chat
 * prompt, not just the live persona.
 * @param {object} prompts  Live prompts (`hot.prompts`, or a fixture with the same shape).
 * @param {string} selfName
 * @returns {string}
 */
export function characterText(prompts, selfName) {
  const nameFill = (text) => fillPromptTemplate(text, { name: selfName });
  return [prompts['character-card'], prompts.rules].map(nameFill).filter(Boolean).join('\n\n');
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
 * @param {Map<string, object>} [input.videos]  Item id -> video state read from the video
 *   describer's cache (src/memory/describe.js#describeVideo), for videos it cannot watch itself.
 * @param {Map<string, string>} [input.reads]  Link id -> the excerpt the web lookup read from that
 *   page (src/web/lookup.js), read from the same cache.
 * @param {(id: string) => (string|null)} [input.nameOf]  Resolves a member id to their
 *   current stored name (`profile.names[0]`), for turning every `<@id>` token this
 *   request's views carry into `name (id:...)` -- see
 *   docs/prompt-contract.md, "Members are referred to by id, never by
 *   nickname". Omitted -> every token is left exactly as stored (no I/O of its own;
 *   the caller, src/memory/update.js#analyze, injects a store-backed lookup).
 * @param {{ publicProfile: object|null, now?: number }} [input.privateChat]  A private-chat
 *   batch (see `analyzePrivate`): `profiles` then holds ONLY the partner's private layer (its
 *   `affinity` already the effective view), rendered without names/character/style/aliases;
 *   `labels.memory.privateNote` goes in a `<private>` block, `publicProfile` is rendered
 *   read-only into `<public_profile>` (src/behavior/prompt.js#renderProfile, `now` drives its
 *   unsure/stale marks), `<existing_channels>` is left out and every transcript line sits under
 *   `labels.memory.privateChannel` instead of a channel name. Omitted -> the guild request.
 * @param {object[]} [input.rosterProfiles]  Every stored member profile of the guild
 *   (store.listUserProfiles): the pool of the `<known_members>` roster, the members who did NOT
 *   write in this batch (see `aliasRoster`), so the analyzer can give one of them an alias.
 *   Omitted, a private batch, or `memory.aliasRosterSize` 0 -> no roster. The roster is its own
 *   section, ranked before the transcript; never required, so it can never make the request
 *   fail. Entries that do not fit are skipped in newest-first order (budget.js, `keep: 'first'`):
 *   a long entry can be skipped while a shorter, older one still fits, so the roster sent may
 *   have gaps anywhere, not only a cut tail.
 * @returns {{ messages: object[], consumed: number, shown: number, trimmed: number, rosterIds: string[],
 *   rosterCandidates: number, rosterTokens: number }}
 *   `consumed` is always the whole batch; `shown` of it made it into `<new_messages>` (the newest
 *   lines), the other `trimmed` did not fit the token cap (`shown + trimmed === consumed`).
 *   `rosterIds`: the members the request's `<known_members>` actually carries, in the order
 *   sent -- the only non-authors an answer may give an alias (applyMemoryUpdate's `aliasOnlyIds`).
 *   `rosterCandidates`: the roster entries offered to the budget (after `memory.aliasRosterSize`),
 *   sent or not; `rosterTokens`: the estimated tokens the sent entries took from the request.
 */
export function buildMemoryRequest({ prompts, config, calibrator, profiles, guildMemory, channels, messages, selfName, loreEntries, descriptions, videos, reads, nameOf, privateChat, rosterProfiles }) {
  const { timezone } = config.bot;
  const labels = requireLabels(prompts);
  if (privateChat && (!labels.memory?.privateNote || !labels.memory?.privateChannel)) {
    throw new Error('prompts.labels is incomplete: memory.privateNote and memory.privateChannel are required for a private batch');
  }
  const relationships = config.features?.relationships !== false;
  // relationships.rewriteOnBandChange: a missing key counts as on, like features.*.
  const rewriteOnBandChange = config.relationships?.rewriteOnBandChange !== false;
  const episodesOn = config.features?.episodes !== false;
  const loreOn = config.features?.lore !== false;
  const resolveName = typeof nameOf === 'function' ? nameOf : () => null;
  const system = fillPromptTemplate(prompts.memory, memoryTemplateValues(config, selfName));
  const characterBlock = relationships ? block('character', characterText(prompts, selfName)) : '';

  const existingProfiles = {};
  for (const [id, profile] of Object.entries(profiles ?? {})) {
    const fields = pickProfileFields(profile);
    if (privateChat) {
      // The private layer has no names or portrait of its own (they live in the public
      // profile, shown read-only in <public_profile>): nothing to offer for editing here.
      delete fields.names;
      delete fields.character;
      delete fields.style;
    } else {
      fields.character = resolveText(fields.character, resolveName);
      fields.style = resolveText(fields.style, resolveName);
    }
    fields.relationship = resolveText(fields.relationship, resolveName);
    fields.interests = existingInterestsView(fields.interests, config.memory?.maxInterests, config.memory?.interestHalfLifeDays, resolveName);
    fields.details = existingDetailsView(fields.details, config.memory?.maxDetails, config.memory?.detailHalfLifeDays, resolveName);
    if (!privateChat && Array.isArray(profile?.aliases) && profile.aliases.length > 0) {
      const aliases = existingAliasesView(profile.aliases, config.memory?.maxAliases, config.memory?.aliasHalfLifeDays);
      if (aliases.length > 0) fields.aliases = aliases;
    }
    if (relationships) {
      const affinity = profile?.affinity ?? emptyAffinity();
      const score = Number.isFinite(affinity.score) ? affinity.score : 0;
      // The analyzer sees the integer score, same as the owner (see roundScore); band thresholds
      // and the ignore-chance maths, not the analyzer, are what need the precise value.
      const band = affinityBand(score);
      fields.affinity = { score: roundScore(score), band, reason: resolveText(affinity.reason, resolveName) };
      // The stored relationship text was written in another band than the one the score sits in
      // now (`relationshipScore`, missing = 0): flag it so the analyzer rewrites it -- a slow drift
      // never looks like a shift from inside one batch. An EMPTY text is flagged with
      // `writtenAt: 'none'` once the profile has something a first version could be written from:
      // a non-zero score, a non-empty reason, or stored episodes (the "dealing with each other in
      // this batch" trigger is left to the model).
      if (rewriteOnBandChange) {
        const text = typeof fields.relationship === 'string' ? fields.relationship.trim() : '';
        if (text) {
          const writtenAt = affinityBand(Number.isFinite(profile?.relationshipScore) ? profile.relationshipScore : 0);
          if (writtenAt !== band) fields.relationshipStale = { writtenAt, now: band };
        } else {
          const hasReason = typeof affinity.reason === 'string' && affinity.reason.trim() !== '';
          const hasEpisodes = Array.isArray(profile?.episodes) && profile.episodes.length > 0;
          if (score !== 0 || hasReason || hasEpisodes) fields.relationshipStale = { writtenAt: 'none', now: band };
        }
      }
    }
    if (episodesOn && Array.isArray(profile?.episodes) && profile.episodes.length > 0) {
      fields.episodes = profile.episodes.map(({ date, what, quote, weight }) => ({ date, what: resolveText(what, resolveName), quote, weight }));
    }
    existingProfiles[id] = fields;
  }
  const profilesBlock = block('existing_profiles', JSON.stringify(existingProfiles));
  const loreBlock = loreOn ? existingLoreBlock(loreEntries, messages.map((m) => m.content).filter(Boolean), resolveName) : '';
  const guildBlock = block('existing_guild', JSON.stringify(pickGuildFields(guildMemory, resolveName, config.memory ?? {})));

  const mainChannels = mainChannelSet(config.memory?.mainChannelIds);
  const existingChannels = {};
  for (const [id, channel] of Object.entries(channels ?? {})) {
    const fields = pickChannelFields(channel, resolveName);
    if (mainChannels.has(String(id))) fields.main = true;
    existingChannels[id] = fields;
  }
  const channelsBlock = privateChat ? '' : block('existing_channels', JSON.stringify(existingChannels));

  const privateBlock = privateChat ? block('private', labels.memory.privateNote) : '';
  const publicProfileBlock = privateChat
    ? block(
        'public_profile',
        renderProfile(privateChat.publicProfile, labels, {
          interlocutor: true,
          episodes: { enabled: episodesOn },
          maxInterests: config.memory?.maxInterests,
          maxDetails: config.memory?.maxDetails,
          maxAliases: config.memory?.maxAliases,
          aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
          interestHalfLifeDays: config.memory?.interestHalfLifeDays,
          detailHalfLifeDays: config.memory?.detailHalfLifeDays,
          confirmAfter: config.memory?.confirmAfter,
          staleDays: config.memory?.interestStaleDays,
          now: privateChat.now,
          nameOf: resolveName,
        }),
      )
    : '';
  const fixedBlocks = [privateBlock, characterBlock, profilesBlock, publicProfileBlock, loreBlock, guildBlock, channelsBlock].filter(Boolean);

  const formatOptions = {
    timezone,
    gapMinutes: config.context.gapMarkerMinutes,
    maxChars: config.context.maxMessageChars,
    selfName,
    mode: 'memory',
    labels,
    seeReactions: config.features?.seeReactions !== false,
    reactionsPerMessage: config.context.reactionsPerMessage,
    descriptions,
    videos,
    reads,
  };
  // A direct-message channel has no name worth showing: the whole private batch sits under
  // one `labels.memory.privateChannel` heading, same line format as a guild channel.
  const transcriptMessages = privateChat ? messages.map((m) => ({ ...m, channelName: labels.memory.privateChannel })) : messages;
  const transcriptItems = formatTranscript(transcriptMessages, formatOptions);
  const transcriptTexts = transcriptItems.map((item) => item.text);

  // The `<known_members>` roster, guild batches only: stored members who did not write in this
  // batch, so an alias stated about one of them has an id to land on.
  const rosterEntries = privateChat
    ? []
    : aliasRoster(rosterProfiles, new Set([...batchAuthorIds(messages), ...Object.keys(profiles ?? {})]), aliasRosterSize(config), config.memory ?? {});

  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const limit = Math.floor(config.llm.maxRequestTokens * config.llm.safetyMargin);

  const { kept, stats } = fitSections(
    [
      {
        name: 'fixed',
        required: true,
        items: [system, ...fixedBlocks].filter(Boolean),
      },
      // Ranked before the transcript, so a heavy batch cannot starve it; not required, so it
      // never raises a token-limit failure: an entry that does not fit is skipped and the next,
      // older one is still tried, so what is sent may have gaps.
      { name: 'roster', keep: 'first', items: rosterEntries.map((entry) => entry.text) },
      { name: 'transcript', keep: 'newest', items: transcriptTexts },
    ],
    limit,
    cost,
  );

  const keptRosterTexts = new Set(kept.roster);
  const keptRoster = rosterEntries.filter((entry) => keptRosterTexts.has(entry.text));
  const rosterBlock = keptRoster.length > 0 ? block('known_members', `{${keptRoster.map((entry) => entry.text).join(',')}}`) : '';

  const keptTranscriptItems = transcriptItems.slice(transcriptItems.length - kept.transcript.length);
  const newMessagesBlock = block('new_messages', renderTranscript(keptTranscriptItems, timezone, labels));

  const user = [...fixedBlocks, rosterBlock, newMessagesBlock].filter(Boolean).join('\n\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // Every buffered message handed in is consumed once this request is sent,
    // even the oldest ones that did not fit in the transcript block — they
    // are gone either way and must not be re-sent on the next update.
    consumed: messages.length,
    // One transcript item per message: how many of the consumed the model
    // actually saw, and how many the cap cut off the old end unseen.
    shown: keptTranscriptItems.length,
    trimmed: messages.length - keptTranscriptItems.length,
    rosterIds: keptRoster.map((entry) => entry.id),
    // How many the roster offered and what the sent ones cost: whether `trimmed` grew because
    // of the roster, and how often the roster itself was cut.
    rosterCandidates: rosterEntries.length,
    rosterTokens: stats.roster?.used ?? 0,
  };
}

/** `clampText` mapped over an array of analyzer-written strings (guild `injokes`/`self`):
 * non-strings and results left empty by clamping (e.g. a lone token dropped whole) are filtered out. */
function clampStringArray(value, maxChars, maxItems, tolerance) {
  return value
    .map((item) => (typeof item === 'string' ? clampText(item, maxChars, { tolerance }) : ''))
    .filter(Boolean)
    .slice(0, maxItems);
}

const TEACHER_TOKEN_RE = new RegExp(`^<@(${ID_DIGITS})>$`);
const TEACHER_REF_RE = new RegExp(`^[^()<>]*\\(id:(${ID_DIGITS})\\)$`);

/**
 * The analyzer's `guild.learned` ops (`{ add, seen, remove }`), validated for
 * src/memory/store.js#applyLearnedOps. `add` items are a bare string or
 * `{ text, from?, sure? }`: `text` is tokenized and clamped to `learnedChars`
 * (an empty result drops the item); `from` is kept only when it is exactly one
 * `<@id>` token or one `name (id:123)` reference whose id `isKnownId` accepts,
 * normalised to the token -- anything else is dropped, never guessed from the
 * text or the batch; `sure: false` travels on. `seen`/`remove` keep positive
 * integer ids only. Untrusted input: any shape -> `null` or a valid subset,
 * never a throw.
 * @param {unknown} raw
 * @param {{ tokenize: (text: string) => string, isKnownId: (id: string) => boolean,
 *   learnedChars: number, clampTolerance?: number }} deps
 * @returns {{ ops: { add: object[], seen: number[], remove: number[] }, added: number }|null}
 */
function parseLearnedOps(raw, { tokenize, isKnownId, learnedChars, clampTolerance }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const teacher = (from) => {
    if (typeof from !== 'string') return undefined;
    const trimmed = from.trim();
    const id = TEACHER_TOKEN_RE.exec(trimmed)?.[1] ?? TEACHER_REF_RE.exec(trimmed)?.[1];
    return id && isKnownId(id) ? `<@${id}>` : undefined;
  };

  const add = [];
  for (const item of Array.isArray(raw.add) ? raw.add : []) {
    const isObj = item && typeof item === 'object' && !Array.isArray(item);
    const rawText = isObj ? item.text : item;
    if (typeof rawText !== 'string') continue;
    const text = clampText(tokenize(rawText), learnedChars, { tolerance: clampTolerance });
    if (!text) continue;
    const op = { text };
    const from = isObj ? teacher(item.from) : undefined;
    if (from) op.from = from;
    if (isObj && item.sure === false) op.sure = false;
    add.push(op);
  }
  const ids = (value) => (Array.isArray(value) ? value.filter((id) => Number.isInteger(id) && id >= 1) : []);
  const seen = ids(raw.seen);
  const remove = ids(raw.remove);

  if (add.length === 0 && seen.length === 0 && remove.length === 0) return null;
  return { ops: { add, seen, remove }, added: add.length };
}

/**
 * Per-user sighting time for one analyzer batch, for dating `interests`/
 * `details` by the MESSAGE, not the wall clock the analyzer happens to run
 * at (see docs/prompt-contract.md, "Dates come from the messages").
 * `seenAtByUser` holds, for each non-self author, the timestamp of THAT
 * user's newest message in the batch; `seenAt` is the batch's own newest
 * message overall, the fallback used when a particular user is somehow
 * missing from the map. Used by the live analyzer.
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
 * The token helpers every analyzer answer goes through before it is stored.
 * A member is written as `<@id>` in every free-text field the analyzer
 * returns (see docs/prompt-contract.md, "Members are referred to by id, never
 * by nickname"); `tokenize` normalizes the fallback shape the model sometimes
 * writes instead, `Name (id:123...)`, into the token -- but only for an id
 * this guild actually knows (one of `knownUserIds`, or an existing stored
 * profile), an unrecognised id is left exactly as written.
 * @param {object} store
 * @param {string} guildId
 * @param {Set<string>} knownUserIds
 * @param {Map<string, string>} [batchAuthorNames]  See `batchAuthorNamesMap`.
 */
function makeTokenizers(store, guildId, knownUserIds, batchAuthorNames) {
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
  /** `raw.interests`/`raw.details` (ops objects, the only shape accepted) into store ops, tokenized. */
  const tokenizeItemOps = (raw, ops) => {
    if (raw.interests && typeof raw.interests === 'object' && !Array.isArray(raw.interests)) {
      ops.interests = {
        ...raw.interests,
        add: tokenizeNoted(raw.interests.add),
        update: tokenizeNoted(raw.interests.update),
      };
    }
    if (raw.details && typeof raw.details === 'object' && !Array.isArray(raw.details)) {
      ops.details = { ...raw.details, add: Array.isArray(raw.details.add) ? raw.details.add.map(tokenizeDetail) : raw.details.add };
    }
  };
  /** `raw.episodes` with `what`/`feeling` tokenized; `quote` is the person's own words verbatim, never. */
  const tokenizeEpisodes = (episodes) =>
    episodes.map((ep) => (ep && typeof ep === 'object' && !Array.isArray(ep) ? { ...ep, what: tokenize(ep.what), feeling: tokenize(ep.feeling) } : ep));
  return { isKnownId, tokenize, tokenizeArray, tokenizeNoted, tokenizeDetail, tokenizeItemOps, tokenizeEpisodes };
}

/** `applyProfileOps` / `applyPrivateOps` options from `config.memory`. */
function profileOpsOptions(cfg, nowMs, seenAt) {
  return {
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
    clampTolerance: cfg.clampTolerance,
    now: nowMs,
    seenAt,
  };
}

/** `adjustAffinity` / `adjustPrivateAffinity` options from the `relationships` argument. */
function affinityOptions(relationships, cfg) {
  return {
    // The model's verdict is never applied unclamped, even if the config block is missing.
    maxDelta: relationships.maxDeltaPerUpdate ?? MEMORY_LIMIT_DEFAULTS.maxDeltaPerUpdate,
    historySize: relationships.historySize ?? MEMORY_LIMIT_DEFAULTS.historySize,
    now: relationships.now,
    clampTolerance: cfg.clampTolerance,
    // relationships.damping: a missing key counts as on, like features.*.
    damping: relationships.damping !== false,
    // relationships.dampingPower: garbage/absent falls back to 1 inside applyDelta itself.
    dampingPower: relationships.dampingPower,
  };
}

/** The affinity score after this batch's own `raw.affinity` delta, without storing anything: the
 * same `applyDelta` call `adjustAffinity` / `adjustPrivateAffinity` make, or the stored score when
 * relationships are off or the batch carries no delta. Missing/malformed = 0. */
function scoreAfterBatch(affinity, raw, relationships, cfg) {
  if (relationships?.enabled && isPlainObject(raw?.affinity)) {
    return applyDelta(affinity, raw.affinity.delta, '', affinityOptions(relationships, cfg)).score;
  }
  return Number.isFinite(affinity?.score) ? affinity.score : 0;
}

/** `addEpisodes` / `addPrivateEpisodes` options from the `episodes` argument. */
function episodeOptions(episodes, cfg) {
  return {
    maxEpisodes: episodes.maxEpisodes,
    maxNew: episodes.maxNew,
    now: episodes.now,
    clampTolerance: cfg.clampTolerance,
  };
}

// An alias that names a member by id instead of being a nickname: a `<@id>` token or the
// `Name (id:...)` reference form (see src/memory/mentions.js).
const ALIAS_REF_RE = /<@|\(id:/;

/** `name` lower-cased, with spaces and punctuation gone (letters, their marks and digits stay):
 * how a proposed alias is compared with the member's own display names, so `nick 42` matches
 * the display name `Nick-42%`. */
function looseNameKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/** The identity the store keeps `name` under as an alias, for comparison only: clamped the
 * store's own way (worked out through applyAliasOps, as `/nep alias add` does, so the clamp is
 * never copied here) and case-insensitive. '' for a name the store would not take. */
function aliasIdentity(name) {
  return typeof name === 'string' ? normalizeTopic(applyAliasOps([], { add: [name] }, [])[0]?.name ?? '') : '';
}

/**
 * One member's `users.<id>.aliases` answer as store ops, guarded for every member: an alias
 * that is not a string, holds a `<@` token or an `(id:` marker is dropped, and so is one equal
 * to any of the member's stored display names once case, spaces and punctuation are ignored.
 * The ops object (`{ add, remove }`) passes on with both of its creating lists (`add`,
 * `update`) filtered. A bare list -- the shape of the input view -- is read as an add of the
 * names NOT stored yet (compared by the identity the store keeps, clamp included): echoing the
 * stored list back is never a sighting. Untrusted input: any shape -> a result, never a throw.
 * @param {unknown} raw
 * @param {object|null} profile  The member's stored profile (`names`, `aliases` read).
 * @returns {{ ops: object|null, dropped: number }}  `ops` for store.applyProfileOps, null when
 *   there is nothing to hand over; `dropped`: the proposed items the guards held back (in a bare
 *   list also a name already stored or listed twice).
 */
function guardedAliasOps(raw, profile) {
  const ownNames = new Set((Array.isArray(profile?.names) ? profile.names : []).map(looseNameKey).filter(Boolean));
  const acceptable = (name) => typeof name === 'string' && !ALIAS_REF_RE.test(name) && !ownNames.has(looseNameKey(name));
  if (Array.isArray(raw)) {
    const known = new Set((Array.isArray(profile?.aliases) ? profile.aliases : []).map((item) => aliasIdentity(item?.name)));
    const add = [];
    for (const name of raw) {
      const key = acceptable(name) ? aliasIdentity(name) : '';
      if (!key || known.has(key)) continue;
      known.add(key);
      add.push(name);
    }
    return { ops: add.length > 0 ? { add } : null, dropped: raw.length - add.length };
  }
  if (!isPlainObject(raw)) return { ops: null, dropped: 0 };
  const ops = { ...raw };
  let dropped = 0;
  for (const key of ['add', 'update']) {
    if (!Array.isArray(ops[key])) continue;
    const kept = ops[key].filter(acceptable);
    dropped += ops[key].length - kept.length;
    ops[key] = kept;
  }
  return { ops, dropped };
}

/**
 * Validate and store the model's memory-update JSON. Never throws on garbage
 * input, never drops a field that was not part of the update. A user id is
 * taken in full only when it is in `knownUserIds` (the batch's authors); one
 * in `options.aliasOnlyIds` instead gets its `aliases` and nothing else, and
 * only when it already has a stored profile. Every other id is dropped.
 *
 * @param {object} store
 * @param {string} guildId
 * @param {unknown} update         Parsed model output; treated as untrusted.
 * @param {object} cfg             `config.memory`.
 * @param {Set<string>} knownUserIds
 * @param {object} [options]  Everything else, each optional:
 * @param {Set<string>} [options.knownChannelIds]  Channel ids present in the batch; a channel outside
 *   this set is rejected, mirroring `knownUserIds`. Omitted -> no channel is accepted.
 * @param {Set<string>} [options.aliasOnlyIds]  The `<known_members>` roster ids the request carried
 *   (buildMemoryRequest's `rosterIds`): members who wrote nothing in the batch. For such an id
 *   (not an author) with a stored profile, ONLY `aliases` is applied (dated like any member with
 *   no line in the batch: `timing.seenAt`); every other key is dropped and counted in
 *   `droppedFields`; a profile is never created for it. Omitted (the warmup and the portrait
 *   refresh) -> only `knownUserIds` are written, as before.
 * @param {{ enabled: boolean, maxDeltaPerUpdate: number, historySize: number, damping?: boolean, dampingPower?: number, now?: number }} [options.relationships]
 *   Only when `enabled`, `raw.affinity` (a `{ delta, reason }` change) is folded into the
 *   stored score via `store.adjustAffinity`. Absent/disabled -> affinity is ignored entirely.
 *   `damping` missing counts as on, `dampingPower` missing/garbage falls back to `1` (see
 *   src/memory/affinity.js#applyDelta).
 * @param {{ enabled: boolean, maxEpisodes: number, maxNew: number, now?: number }} [options.episodes]
 *   Only when `enabled`, each user's `raw.episodes` (a new-moments array) is folded in via
 *   `store.addEpisodes` (src/memory/episodes.js#mergeEpisodes). Absent/disabled -> ignored entirely.
 * @param {{ enabled: boolean, maxEntries: number, now?: number }} [options.lore]
 *   Only when `enabled`, `update.lore` (the server's lorebook) is folded in via `store.setLore`
 *   (src/memory/lore.js#upsertLore, source: 'analyzer'). Absent/disabled -> ignored entirely.
 * @param {{ seenAtByUser?: Map<string, number>, seenAt?: number }} [options.timing]  From `computeSeenAt`
 *   above; missing/absent falls back to `relationships.now`/`episodes.now`/the wall clock, same
 *   as before this option existed.
 * @param {Map<string, string>} [options.batchAuthorNames]  Author id -> the nick this batch's transcript
 *   used for them (see `batchAuthorNamesMap` below), so the `Name (id:...)` normalization below
 *   recognises a name even for someone whose stored profile has not caught up yet. Omitted ->
 *   only the stored profile's own `names` are known.
 * @returns {{ users: number, guild: boolean, self: boolean, affinity: number, relationships: number, channels: number, episodes: number, lore: number,
 *   learned: number, interestsChanged: number, aliasesChanged: number, aliasOnly: number, aliasesDropped: number,
 *   droppedUsers: number, droppedFields: number, portraitRequests: { userId: string, reason: string }[] }}
 *   `users`: authors written. `guild`: patterns/starters/injokes changed. `channels`/`lore`: entries whose stored values changed
 *   (an identical re-send, compared after clamping, counts 0). `learned`: how many valid `guild.learned` add ops were
 *   handed to `store.applyLearnedOps` (a re-add of a stored item counts too -- it is a sighting).
 *   `aliasesChanged`: members (authors and roster) whose stored alias list really changed; `aliasOnly`: roster
 *   members among them. `aliasesDropped`: proposed aliases the guards held back (a member reference, the member's
 *   own display name, a non-string; in a bare list also a name already stored), authors and roster members alike --
 *   a proposal that was dropped, told apart from none. `droppedUsers`: entries for an id that is neither an author
 *   nor a roster member with a stored profile. `droppedFields`: non-empty keys other than `aliases` dropped from
 *   roster members' entries.
 */
export function applyMemoryUpdate(
  store,
  guildId,
  update,
  cfg,
  knownUserIds,
  { knownChannelIds = new Set(), aliasOnlyIds = new Set(), relationships, episodes, lore, timing, batchAuthorNames } = {},
) {
  const result = {
    users: 0,
    guild: false,
    self: false,
    affinity: 0,
    relationships: 0,
    channels: 0,
    episodes: 0,
    lore: 0,
    learned: 0,
    interestsChanged: 0,
    aliasesChanged: 0,
    aliasOnly: 0,
    aliasesDropped: 0,
    droppedUsers: 0,
    droppedFields: 0,
    portraitRequests: [],
  };
  if (!update || typeof update !== 'object' || Array.isArray(update)) return result;

  const { isKnownId, tokenize, tokenizeArray, tokenizeItemOps, tokenizeEpisodes } = makeTokenizers(store, guildId, knownUserIds, batchAuthorNames);

  if (update.users && typeof update.users === 'object' && !Array.isArray(update.users)) {
    for (const [userId, raw] of Object.entries(update.users)) {
      const id = String(userId);
      const author = knownUserIds.has(id);
      // A member the request showed only in its `<known_members>` roster: aliases only, and
      // only onto a profile that already exists -- never a new one.
      const aliasOnly = !author && aliasOnlyIds.has(id) && store.getUser(guildId, id) != null;
      if (!author && !aliasOnly) {
        result.droppedUsers += 1;
        continue;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      const profileOpsNow = relationships?.now ?? episodes?.now ?? Date.now();
      const seenAt = timing?.seenAtByUser?.get(id) ?? timing?.seenAt ?? profileOpsNow;
      const beforeAliases = JSON.stringify(store.getUser(guildId, id)?.aliases ?? []);
      const { ops: aliasOps, dropped: aliasesDropped } = guardedAliasOps(raw.aliases, store.getUser(guildId, id));
      result.aliasesDropped += aliasesDropped;

      if (aliasOnly) {
        result.droppedFields += Object.entries(raw).filter(([key, value]) => key !== 'aliases' && hasContent(value)).length;
        if (!hasContent(aliasOps)) continue;
        store.applyProfileOps(guildId, id, { aliases: aliasOps }, profileOpsOptions(cfg, profileOpsNow, seenAt));
        if (JSON.stringify(store.getUser(guildId, id)?.aliases ?? []) !== beforeAliases) {
          result.aliasesChanged += 1;
          result.aliasOnly += 1;
        }
        continue;
      }

      // Incremental profile ops (see docs/prompt-contract.md, "The
      // analyzer"): prose fields pass through as-is, store.applyProfileOps
      // decides whether they are non-empty and clamps them. `interests`/
      // `details` are ops objects, the only shape accepted.
      // `character`/`style` stay plain prose (see docs/prompt-contract.md,
      // "Data model"): the stream analyzer never edits them directly -- they
      // are written only by profile.md (the warmup and a portrait refresh,
      // see `raw.portrait` below). The whole-string form is kept here for
      // that writer, not for the stream analyzer's own JSON.
      const ops = {};
      for (const key of ['character', 'style', 'relationship']) {
        if (typeof raw[key] === 'string') ops[key] = tokenize(raw[key]);
      }

      // `portrait`: the stream analyzer's cue that this member's stored
      // character/style misses or contradicts something the batch showed --
      // never stored here, just collected for the caller (analyze()) to hand
      // to an injected refresh callback; see docs/prompt-contract.md,
      // "Data model".
      if (typeof raw.portrait === 'string') {
        const reason = clampText(tokenize(raw.portrait), 200, { tolerance: cfg.clampTolerance });
        if (reason) result.portraitRequests.push({ userId: String(userId), reason });
      }

      tokenizeItemOps(raw, ops);

      // Aliases are literal nicknames, never a `<@id>` reference to someone
      // else -- never tokenized, only guarded (`guardedAliasOps`), see
      // docs/prompt-contract.md, "Aliases".
      if (aliasOps) ops.aliases = aliasOps;

      const beforeInterests = JSON.stringify(store.getUser(guildId, userId)?.interests ?? []);
      const beforeRelationship = store.getUser(guildId, userId)?.relationship ?? '';

      // A written relationship text is stamped with the score this batch lands on, after its own
      // delta (computed with the same pure maths adjustAffinity runs below).
      const relationshipWritten = typeof ops.relationship === 'string' && ops.relationship.trim() !== '';
      const profileOpts = profileOpsOptions(cfg, profileOpsNow, seenAt);
      if (relationshipWritten) profileOpts.relationshipScore = scoreAfterBatch(store.getUser(guildId, userId)?.affinity, raw, relationships, cfg);
      store.applyProfileOps(guildId, userId, ops, profileOpts);
      result.users += 1;

      const afterInterests = JSON.stringify(store.getUser(guildId, userId)?.interests ?? []);
      if (afterInterests !== beforeInterests) result.interestsChanged += 1;
      if (JSON.stringify(store.getUser(guildId, userId)?.aliases ?? []) !== beforeAliases) result.aliasesChanged += 1;
      // Diagnostic: how many members had their stored relationship text rewritten.
      if ((store.getUser(guildId, userId)?.relationship ?? '') !== beforeRelationship) result.relationships += 1;

      if (relationships?.enabled && raw.affinity && typeof raw.affinity === 'object' && !Array.isArray(raw.affinity)) {
        const before = store.getUser(guildId, userId)?.affinity?.score ?? 0;
        const after = store.adjustAffinity(guildId, userId, raw.affinity.delta, tokenize(raw.affinity.reason), affinityOptions(relationships, cfg));
        if (after.score !== before) result.affinity += 1;
      }

      if (episodes?.enabled && Array.isArray(raw.episodes) && raw.episodes.length > 0) {
        const added = store.addEpisodes(guildId, userId, tokenizeEpisodes(raw.episodes), episodeOptions(episodes, cfg));
        result.episodes += added;
      }
    }
  }

  if (lore?.enabled && Array.isArray(update.lore) && update.lore.length > 0) {
    // `title`/`keys` are the identity a person actually types, never tokenized.
    const tokenizedLore = update.lore.map((entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry, text: tokenize(entry.text) } : entry,
    );
    result.lore = store.setLore(guildId, tokenizedLore, {
      source: 'analyzer',
      now: lore.now,
      maxEntries: lore.maxEntries,
      textChars: lore.textChars,
      clampTolerance: cfg.clampTolerance,
    });
  }

  if (update.channels && typeof update.channels === 'object' && !Array.isArray(update.channels)) {
    for (const [channelId, raw] of Object.entries(update.channels)) {
      if (!knownChannelIds.has(String(channelId))) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      const fields = {};
      for (const key of CHANNEL_FIELDS) {
        if (typeof raw[key] === 'string') fields[key] = clampText(tokenize(raw[key]), cfg.fieldChars, { tolerance: cfg.clampTolerance });
      }

      // Counted only when the stored text moves: an identical re-send is no change (and unstamped).
      const before = fieldsSnapshot(store.getChannel(guildId, channelId) ?? emptyChannel(String(channelId)), CHANNEL_FIELDS);
      if (fieldsSnapshot(store.updateChannel(guildId, channelId, fields), CHANNEL_FIELDS) !== before) result.channels += 1;
    }
  }

  const guildFields = {};
  if (update.guild && typeof update.guild === 'object' && !Array.isArray(update.guild)) {
    const g = update.guild;
    if (typeof g.patterns === 'string' && g.patterns.trim()) {
      guildFields.patterns = clampText(tokenize(g.patterns), cfg.fieldChars * 2, { tolerance: cfg.clampTolerance });
    }
    if (typeof g.starters === 'string' && g.starters.trim()) {
      guildFields.starters = clampText(tokenize(g.starters), cfg.fieldChars * 2, { tolerance: cfg.clampTolerance });
    }
    if (Array.isArray(g.injokes) && g.injokes.length) {
      const injokes = clampStringArray(tokenizeArray(g.injokes), 200, cfg.maxInjokes, cfg.clampTolerance);
      if (injokes.length) guildFields.injokes = injokes;
    }
  }
  if (Object.keys(guildFields).length > 0) {
    const keys = Object.keys(guildFields);
    const before = fieldsSnapshot(store.getGuild(guildId), keys);
    result.guild = fieldsSnapshot(store.updateGuild(guildId, guildFields), keys) !== before;
  }

  // Things people taught the persona: incremental ops, same mechanics as a
  // member's details (see src/memory/store.js#applyLearnedOps), dated by the
  // batch's newest message.
  const guildRaw = update.guild && typeof update.guild === 'object' && !Array.isArray(update.guild) ? update.guild : null;
  const learned = parseLearnedOps(guildRaw?.learned, {
    tokenize,
    isKnownId,
    learnedChars: cfg.learnedChars ?? MEMORY_LIMIT_DEFAULTS.learnedChars,
    clampTolerance: cfg.clampTolerance,
  });
  if (learned) {
    store.applyLearnedOps(guildId, learned.ops, {
      maxLearned: cfg.maxLearned ?? MEMORY_LIMIT_DEFAULTS.maxLearned,
      maxLearnedStored: cfg.maxLearnedStored ?? MEMORY_LIMIT_DEFAULTS.maxLearnedStored,
      learnedChars: cfg.learnedChars ?? MEMORY_LIMIT_DEFAULTS.learnedChars,
      learnedHalfLifeDays: cfg.learnedHalfLifeDays ?? MEMORY_LIMIT_DEFAULTS.learnedHalfLifeDays,
      confirmGapHours: cfg.confirmGapHours,
      clampTolerance: cfg.clampTolerance,
      seenAt: timing?.seenAt ?? relationships?.now ?? episodes?.now ?? Date.now(),
    });
    result.learned = learned.added;
  }

  if (Array.isArray(update.self) && update.self.length > 0) {
    const self = clampStringArray(tokenizeArray(update.self), 200, cfg.maxSelfFacts, cfg.clampTolerance);
    if (self.length > 0) {
      store.updateGuild(guildId, { self });
      result.self = true;
    }
  }

  return result;
}

/** The listed fields of a stored entry as one comparable string, taken before and after a store
 * write: equal means the write changed nothing (the store compares the same JSON form). */
function fieldsSnapshot(value, keys) {
  return JSON.stringify(keys.map((key) => value?.[key]));
}

/** Whether an analyzer value says anything: a non-blank string, a non-empty array or object. */
function hasContent(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.values(value).some(hasContent);
  return value != null && value !== false;
}

/**
 * Validate and store a PRIVATE batch's answer (see `analyzePrivate`): only
 * `update.users[userId]` is applied, and only to that member's private layer
 * -- `relationship`/`interests`/`details` via `store.applyPrivateOps`,
 * `affinity` via `store.adjustPrivateAffinity`, `episodes` via
 * `store.addPrivateEpisodes`, with the same options `applyMemoryUpdate` uses.
 * `character`, `style`, `aliases` and `portrait` are public-only and ignored.
 * Every other user, `guild`, `channels`, `lore` and `self` is dropped and
 * only counted in `dropped` (never an id). Never throws on garbage input.
 * @param {object} store
 * @param {string} guildId
 * @param {string} userId       The DM partner.
 * @param {unknown} update      Parsed model output; untrusted.
 * @param {object} cfg          `config.memory`.
 * @param {{ relationships?: object, episodes?: object, timing?: object, batchAuthorNames?: Map<string, string> }} [options]
 *   As for `applyMemoryUpdate` (`timing` from `computeSeenAt`, `batchAuthorNames` from
 *   `batchAuthorNamesMap`); there is no channel, lore or guild here.
 * @returns {{ users: number, affinity: number, relationships: number, episodes: number, interestsChanged: number,
 *   dropped: { users: number, guild: boolean, channels: number, lore: number, self: number } }}
 */
export function applyPrivateUpdate(store, guildId, userId, update, cfg, { relationships, episodes, timing, batchAuthorNames } = {}) {
  const id = String(userId);
  const result = {
    users: 0,
    affinity: 0,
    relationships: 0,
    episodes: 0,
    interestsChanged: 0,
    dropped: { users: 0, guild: false, channels: 0, lore: 0, self: 0 },
  };
  if (!isPlainObject(update)) return result;

  const users = isPlainObject(update.users) ? update.users : {};
  result.dropped.users = Object.keys(users).filter((key) => key !== id).length;
  result.dropped.guild = hasContent(update.guild);
  result.dropped.channels = isPlainObject(update.channels) ? Object.keys(update.channels).length : 0;
  result.dropped.lore = Array.isArray(update.lore) ? update.lore.length : 0;
  result.dropped.self = Array.isArray(update.self) ? update.self.length : 0;

  const raw = users[id];
  if (!isPlainObject(raw)) return result;

  const { tokenize, tokenizeItemOps, tokenizeEpisodes } = makeTokenizers(store, guildId, new Set([id]), batchAuthorNames);
  const ops = {};
  if (typeof raw.relationship === 'string') ops.relationship = tokenize(raw.relationship);
  tokenizeItemOps(raw, ops);

  const opsNow = relationships?.now ?? episodes?.now ?? Date.now();
  const seenAt = timing?.seenAtByUser?.get(id) ?? timing?.seenAt ?? opsNow;
  const before = store.getPrivate(guildId, id);
  const beforeInterests = JSON.stringify(before?.interests ?? []);
  const beforeRelationship = before?.relationship ?? '';

  // The private analyzer sees the EFFECTIVE affinity (public + private), so a written private
  // relationship is stamped with the effective score this batch lands on.
  const relationshipWritten = typeof ops.relationship === 'string' && ops.relationship.trim() !== '';
  const privateOpts = profileOpsOptions(cfg, opsNow, seenAt);
  if (relationshipWritten) {
    const privateScore = scoreAfterBatch(before?.affinity, raw, relationships, cfg);
    privateOpts.relationshipScore = effectiveAffinity(store.getUser?.(guildId, id)?.affinity, { score: privateScore }).score;
  }
  const after = store.applyPrivateOps(guildId, id, ops, privateOpts);
  result.users = 1;
  if (JSON.stringify(after.interests) !== beforeInterests) result.interestsChanged = 1;
  if (after.relationship !== beforeRelationship) result.relationships = 1;

  if (relationships?.enabled && isPlainObject(raw.affinity)) {
    const scoreBefore = store.getPrivate(guildId, id)?.affinity?.score ?? 0;
    const next = store.adjustPrivateAffinity(guildId, id, raw.affinity.delta, tokenize(raw.affinity.reason), affinityOptions(relationships, cfg));
    if (next.score !== scoreBefore) result.affinity = 1;
  }

  if (episodes?.enabled && Array.isArray(raw.episodes) && raw.episodes.length > 0) {
    result.episodes = store.addPrivateEpisodes(guildId, id, tokenizeEpisodes(raw.episodes), episodeOptions(episodes, cfg));
  }

  return result;
}

/**
 * Record that a normalized message happened, for the counters kept on a
 * user's profile and a channel's map entry: `touchUser` (skipped for the
 * persona's own messages) and `touchChannel`, whose `topWriters` tally also
 * skips the persona's own messages and other bots. Used by `observe()`, the
 * live pipeline; the memory warmup (src/memory/warmup.js) computes a
 * profiled member's counters, and a channel's own counters/top writers, the
 * same way but from the fetched history window directly (via
 * `store.setChannelFacts`), rather than through this shared helper.
 * @param {object} store
 * @param {string} guildId
 * @param {object} normalized  A normalized message (see src/discord/collect.js);
 *   callers are expected to have already dropped other bots' messages.
 */
export function touchMemory(store, guildId, normalized) {
  if (!normalized.self) {
    store.touchUser(guildId, normalized.authorId, normalized.authorName, normalized.ts);
  }
  // The persona's own messages and other bots never count toward a channel's
  // top writers -- see src/memory/store.js#touchChannel.
  const writerId = !normalized.self && !normalized.bot ? normalized.authorId : null;
  store.touchChannel(
    guildId,
    normalized.channelId,
    { name: normalized.channelName, category: normalized.channelCategory, topic: normalized.channelTopic },
    normalized.ts,
    writerId,
  );
}

/**
 * The media of one normalized message part (the message itself or one
 * forwarded snapshot) as the memory buffer keeps it. No URL ever survives
 * into the buffer -- but the item `id` does, so the live analyzer can look up
 * a describer caption already warmed into the cache by src/discord/events.js
 * (see analyze() below). A sticker keeps `id`/`name`/`format` (its URL is
 * rebuilt from those via stickerUrl when needed); a custom emoji keeps only
 * `id`/`name` (its URL is rebuilt via emojiUrl).
 */
function slimMedia(part) {
  return {
    attachments: (part.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, id: a.id, durationSec: a.durationSec ?? null })),
    links: (part.links ?? []).map((l) => ({ kind: l.kind, name: l.title || l.site || '', id: l.id, durationSec: null })),
    stickers: (part.stickers ?? []).map((s) => ({ id: s.id, name: s.name, format: s.format })),
    emojis: (part.emojis ?? []).map((e) => ({ id: e.id, name: e.name })),
  };
}

/**
 * The stored profiles/channels an analyzer batch needs, plus the distinct
 * non-self author ids and channel ids of `messages` (the `knownUserIds` /
 * `knownChannelIds` of `applyMemoryUpdate`). The lookups are passed in, so
 * the caller decides where profiles and channels are read from.
 * @param {object[]} messages  Slim or normalized messages; `self`/`authorId`/`channelId` read.
 * @param {(id: string) => (object|null)} getUser     A stored profile, null when none.
 * @param {(id: string) => (object|null)} getChannel  A stored channel entry, null when none.
 * @returns {{ authorIds: string[], profiles: object, channelIds: string[], channels: object }}
 */
export function batchContext(messages, getUser, getChannel) {
  const authorIds = batchAuthorIds(messages);
  const profiles = {};
  for (const id of authorIds) {
    const profile = getUser(id);
    if (profile) profiles[id] = profile;
  }

  const channelIds = [...new Set(messages.map((m) => m.channelId).filter((id) => id != null))];
  const channels = {};
  for (const id of channelIds) {
    const channel = getChannel(id);
    if (channel) channels[id] = channel;
  }

  return { authorIds, profiles, channelIds, channels };
}

/**
 * The `relationships`/`episodes`/`lore` arguments of the apply functions,
 * from `config` (read by the caller at the moment of use). `now` is the clock
 * (a function), read once per enabled switch.
 * @param {object} config
 * @param {() => number} now
 * @returns {{ relationships?: object, episodes?: object, lore?: object }}
 */
export function memorySwitches(config, now) {
  const cfg = config.memory;
  const relationshipsOn = config.features?.relationships !== false;
  const relationships = relationshipsOn ? { enabled: true, ...config.relationships, now: now() } : undefined;
  const episodesOn = config.features?.episodes !== false;
  const episodes = episodesOn ? { enabled: true, maxEpisodes: cfg.maxEpisodes, maxNew: cfg.maxNewEpisodes, now: now() } : undefined;
  const loreOn = config.features?.lore !== false;
  const lore = loreOn
    ? { enabled: true, maxEntries: config.lore?.maxEntries ?? Infinity, textChars: config.lore?.textChars, now: now() }
    : undefined;
  return { relationships, episodes, lore };
}

/** `nameOf` for buildMemoryRequest's token resolution: a member's current
 * stored name, or null when the guild has no profile for that id -- see
 * docs/prompt-contract.md, "Members are referred to by id, never by
 * nickname". The one place `analyze()` touches the store for this. */
function storeNameOf(store, guildId) {
  return (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
}

/**
 * @param {object} deps
 * @param {object} deps.hot          Live config + prompts; read at the moment of use.
 * @param {object} deps.store
 * @param {object} deps.llm          From createLlm().
 * @param {object} deps.calibrator   From createCalibrator().
 * @param {(guildId: string) => string} deps.getSelfName
 * @param {() => number} [deps.now]
 * @param {(guildId: string, userId: string, reason: string) => void} [deps.onPortraitRequest]
 *   Called once per user for every `raw.portrait` cue a successful `analyze()` collected (see
 *   docs/prompt-contract.md, "Data model") -- src/index.js wires this to
 *   src/memory/warmup.js#createWarmup's `refreshPortrait`, which does the actual rewrite
 *   (`profile.md`, `<draft>`/`<hint>`); this module only reports the cue, never awaits the result.
 *   Omitted -> no-op.
 */
export function createMemoryUpdater({ hot, store, llm, calibrator, getSelfName, now = Date.now, onPortraitRequest }) {
  const running = new Set();
  let idleWaiters = []; // resolvers for waitIdle() (/nep pause), notified once running.size hits 0
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
   * `private` (the DM partner's id, also for the persona's own DM lines)
   * routes the message into that member's private buffer instead: no public
   * counters, no channel map entry, no guild buffer.
   */
  function observe(guildId, normalized, { direct = false, private: privateUserId = null } = {}) {
    // /nep pause: nothing may make the store dirty while paused.
    if (store.state.data.paused) return;
    if (normalized.bot) return;
    if (!privateUserId) touchMemory(store, guildId, normalized);
    // The GIF library (src/memory/gifs.js) is fed here, not after the batch:
    // it needs the GIF's URL, and no URL survives into the buffer below. A
    // private chat never feeds it; the persona's own GIFs are skipped there.
    if (!privateUserId && hot.config.features?.gifs !== false) {
      const gifs = store.recordGifs(guildId, [normalized], gifOpts(hot.config));
      if (gifs > 0) log.info('memory: gifs recorded', { guildId, gifs });
    }

    const forwarded = (normalized.forwarded ?? []).map((snapshot) => ({
      content: snapshot.content ?? '',
      ...slimMedia(snapshot),
    }));
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
      ...slimMedia(normalized),
      // A forwarded message's snapshots (src/discord/collect.js
      // #normalizeSnapshot), stripped the same way, so the analyzer's
      // transcript renders a forward like the live one. Absent for a message
      // with no forward: the buffer entry stays as it was.
      ...(forwarded.length > 0 ? { forwardedFrom: normalized.forwardedFrom ?? null, forwarded } : {}),
      direct: Boolean(direct),
    };
    const cfg = hot.config.memory;
    // The cap drops the oldest buffered messages before any analyzer saw them (the analyzer
    // is failing or backed off): say so, with the count only. A private line never names the member.
    if (privateUserId) {
      const dropped = store.pushPrivateBuffer(guildId, String(privateUserId), slim, cfg.batchMessages * 3);
      if (dropped > 0) log.info('memory: private buffer trimmed', { guildId, dropped });
    } else {
      const dropped = store.pushBuffer(guildId, slim, cfg.batchMessages * 3);
      if (dropped > 0) log.info('memory: buffer trimmed', { guildId, dropped });
    }
  }

  /**
   * The stored profiles/channels `analyze()` needs for `messages`, plus the
   * distinct author/channel ids they were built from (kept as
   * strings-to-be via `knownUserIds`/`knownChannelIds` downstream).
   */
  function collectContext(guildId, messages) {
    return batchContext(
      messages,
      (id) => store.getUser(guildId, id),
      (id) => store.getChannel(guildId, id),
    );
  }

  /**
   * The one analyzer code path: build the memory-update request from
   * `messages`, send it to the LLM, parse the reply and apply it to the
   * store. Used by `run()` (a batch shifted off the live buffer); the memory
   * warmup (src/memory/warmup.js) does not go through this path at all
   * — it calls `profile.md`/`channel.md`/`server.md` and applyMemoryUpdate
   * directly. Never touches the live buffer and never throws — a failure is
   * reported in the returned `error`, not raised.
   *
   * `usage`/`estimated` reflect a completion whenever one was actually
   * received from the provider — including when `ok: false` because parsing
   * or applying the answer failed afterwards, since those tokens were billed
   * regardless. Only a failure before/without a completion (a build error,
   * `TokenLimitError`, a network/provider error, a missing prompt) reports
   * `usage: null, estimated: 0`: nothing was spent.
   *
   * A success also carries `shown`/`trimmed`: how many of `messages` the
   * request's transcript held and how many the token cap cut, and `roster`:
   * how many members the request's `<known_members>` carried, i.e. members
   * who did not write in the batch (see `buildMemoryRequest`), of
   * `rosterCandidates` offered, taking `rosterTokens`. Of the non-authors,
   * only those sent may get anything from the answer: an alias.
   *
   * @param {string} guildId
   * @param {object[]} messages  Slim messages (oldest first) to summarize; NOT read from or removed off any buffer.
   * @returns {Promise<{ ok: boolean, usage: object|null, estimated: number, result: object|null, shown?: number, trimmed?: number,
   *   roster?: number, rosterCandidates?: number, rosterTokens?: number, error?: Error }>}
   */
  async function analyze(guildId, messages) {
    let context;
    return analyzeBatch(
      guildId,
      messages,
      () => {
        context = collectContext(guildId, messages);
        // The roster's pool: every stored profile, listed only while the roster is on. A stored
        // profile that cannot be read (hand-edited while paused) costs this batch its roster,
        // never the batch: this runs outside analyzeBatch's try.
        let rosterProfiles = [];
        if (aliasRosterSize(hot.config) > 0) {
          try {
            rosterProfiles = store.listUserProfiles(guildId);
          } catch (err) {
            log.warn('memory: alias roster left out', { guildId, reason: 'store-error', error: errorNameOf(err) });
          }
        }
        return { profiles: context.profiles, channels: context.channels, rosterProfiles };
      },
      (update, { relationships, episodes, lore }, { rosterIds }) => {
        const cfg = hot.config.memory;
        const knownUserIds = new Set(context.authorIds.map(String));
        const knownChannelIds = new Set(context.channelIds.map(String));
        const result = applyMemoryUpdate(
          store,
          guildId,
          update,
          cfg,
          knownUserIds,
          {
            knownChannelIds,
            aliasOnlyIds: new Set(rosterIds),
            relationships,
            episodes,
            lore,
            timing: computeSeenAt(messages),
            batchAuthorNames: batchAuthorNamesMap(messages),
          },
        );

        if (typeof onPortraitRequest === 'function') {
          for (const { userId, reason } of result.portraitRequests) onPortraitRequest(guildId, userId, reason);
        }
        return result;
      },
    );
  }

  /**
   * The private-chat analyzer path, same shape and same guarantees as
   * `analyze()` (never throws, never touches a buffer, same LLM options):
   * `messages` are one member's direct messages with the persona. The request
   * (see `buildMemoryRequest`'s `privateChat`) carries ONLY that member's
   * private layer, with the effective affinity (src/behavior/private.js
   * #effectiveAffinity), plus their public profile as read-only prose and the
   * usual read-only guild/lore context; only `users[userId]` of the answer is
   * applied, to the private layer (`applyPrivateUpdate`). A success stamps the
   * private layer's `lastSeen` (and `firstSeen` the first time).
   * @param {string} guildId
   * @param {string} userId  The DM partner.
   * @param {object[]} messages  Slim buffered direct messages, oldest first.
   * @returns {Promise<{ ok: boolean, usage: object|null, estimated: number, result: object|null, shown?: number, trimmed?: number,
   *   roster?: number, rosterCandidates?: number, rosterTokens?: number, error?: Error }>}
   *   The `roster*` counts are always 0 here: a private batch carries no `<known_members>`.
   */
  async function analyzePrivate(guildId, userId, messages) {
    const id = String(userId);
    return analyzeBatch(
      guildId,
      messages,
      () => {
        const publicProfile = store.getUser(guildId, id);
        const privateProfile = store.getPrivate(guildId, id) ?? {};
        const view = { ...privateProfile, affinity: effectiveAffinity(publicProfile?.affinity, privateProfile.affinity) };
        return { profiles: { [id]: view }, channels: {}, privateChat: { publicProfile, now: now() } };
      },
      (update, { relationships, episodes }) => {
        const result = applyPrivateUpdate(
          store,
          guildId,
          id,
          update,
          hot.config.memory,
          { relationships, episodes, timing: computeSeenAt(messages), batchAuthorNames: batchAuthorNamesMap(messages) },
        );
        store.touchPrivateSeen(guildId, id, now());
        return result;
      },
    );
  }

  /**
   * The picture/video/page captions the media cache already holds for the
   * items of `messages` (see `analyze()`), each `null` when its switch is off.
   */
  function cachedMedia(guildId, messages) {
    // The live analyzer never triggers a NEW description request itself --
    // the buffered messages carry no URL to describe from anyway (see
    // observe() above). It only reads whatever src/discord/events.js has
    // already warmed into the cache for these item ids, fire-and-forget, as
    // the messages came in; a cache miss just renders blind.
    let descriptions = null;
    if (hot.config.features?.mediaDescriptions === true) {
      const cache = store.getMediaCache(guildId);
      descriptions = new Map();
      // A forwarded snapshot's items are looked up exactly like the
      // message's own (see mediaParts).
      for (const part of messages.flatMap(mediaParts)) {
        for (const item of [...(part.attachments ?? []), ...(part.links ?? [])]) {
          if (item.id == null || !isDescribable(item)) continue;
          const cached = cache[item.id];
          if (cached && !cached.miss) descriptions.set(item.id, cached.text);
        }
        // Stickers/emoji keep no URL in the buffer (see observe() above) --
        // stickerUrl rebuilds it from id/format only to tell a Lottie
        // sticker (never describable) apart, the cache is still looked up by
        // the stable `sticker:<id>` / `emoji:<id>` key alone.
        for (const sticker of part.stickers ?? []) {
          if (!stickerUrl(sticker.id, sticker.format)) continue;
          const itemId = `sticker:${sticker.id}`;
          const cached = cache[itemId];
          if (cached && !cached.miss) descriptions.set(itemId, cached.text);
        }
        for (const emoji of part.emojis ?? []) {
          const itemId = `emoji:${emoji.id}`;
          const cached = cache[itemId];
          if (cached && !cached.miss) descriptions.set(itemId, cached.text);
        }
      }
    }

    // Videos the video describer already watched (or refused for good) are
    // read from the same cache under `video:<item id>`, by the describer's own
    // rules (videoStateFromCache); an error miss or no entry at all renders the
    // plain form. Never a request from here. Video vision must be on, like the
    // senses line (isVideoVisionOn).
    let videos = null;
    if (isVideoVisionOn(hot.config)) {
      const cache = store.getMediaCache(guildId);
      videos = new Map();
      for (const part of messages.flatMap(mediaParts)) {
        const items = [...(part.attachments ?? []).filter((a) => a.kind === 'video'), ...(part.links ?? [])];
        for (const item of items) {
          if (item.id == null) continue;
          const state = videoStateFromCache(cache[`video:${item.id}`], hot.config, item);
          if (state) videos.set(item.id, state);
        }
      }
    }

    // Pages the web lookup already read (src/web/lookup.js) are read from the
    // same cache under `read:<link id>`; a miss or no entry renders the plain
    // link. Never a request from here. features.webLookup: unlike the other
    // switches a missing key counts as OFF.
    let reads = null;
    if (hot.config.features?.webLookup === true && hot.config.web?.links?.enabled !== false) {
      const cache = store.getMediaCache(guildId);
      reads = new Map();
      for (const part of messages.flatMap(mediaParts)) {
        for (const link of part.links ?? []) {
          if (link.id == null) continue;
          const cached = cache[`read:${link.id}`];
          if (cached && !cached.miss && typeof cached.text === 'string') reads.set(link.id, cached.text);
        }
      }
    }
    return { descriptions, videos, reads };
  }

  /** The `relationships`/`episodes`/`lore` arguments of the apply functions, from the live config. */
  function applySwitches() {
    return memorySwitches(hot.config, now);
  }

  /**
   * Build, send, parse, apply: the body shared by `analyze()` and
   * `analyzePrivate()`. `requestInput()` (called only once a memory prompt is
   * configured) returns the mode-specific `buildMemoryRequest` fields;
   * `applyUpdate(update, switches, { rosterIds })` stores the parsed answer and
   * returns the result to report (`rosterIds`: the roster members the request
   * carried, see `buildMemoryRequest`). A failure's `reason`: 'no-prompt', 'token-limit',
   * 'llm-error' (nothing billed), 'truncated', 'bad-json' (the answer did not
   * parse) or 'apply-error' (it parsed, the store refused it).
   */
  async function analyzeBatch(guildId, messages, requestInput, applyUpdate) {
    const cfg = hot.config.memory;
    const promptText = hot.prompts.memory;
    if (!promptText) {
      log.warn('memory: no memory prompt configured, skipping', { guildId });
      return { ok: false, usage: null, estimated: 0, result: null, reason: 'no-prompt' };
    }

    const input = requestInput();
    const { descriptions, videos, reads } = cachedMedia(guildId, messages);

    let completion;
    let fit; // the request's { shown, trimmed, roster, rosterCandidates, rosterTokens }, reported with a success
    let rosterIds = []; // the roster members the request carried: the only non-authors an answer may give an alias
    try {
      const { messages: llmMessages, shown, trimmed, rosterIds: sentRoster, rosterCandidates, rosterTokens } = buildMemoryRequest({
        prompts: hot.prompts,
        config: hot.config,
        calibrator,
        guildMemory: store.getGuild(guildId),
        messages,
        selfName: getSelfName(guildId),
        loreEntries: store.getLore(guildId),
        descriptions,
        videos,
        reads,
        nameOf: storeNameOf(store, guildId),
        ...input,
      });
      fit = { shown, trimmed, roster: sentRoster.length, rosterCandidates, rosterTokens };
      rosterIds = sentRoster;

      completion = await llm.complete(llmMessages, {
        model: cfg.model || undefined,
        role: 'analyzer',
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: analyzerTemperature(hot.config),
        // A 150-message batch with an 8000-token answer on a large model can
        // take longer than the chat timeout -- the analyzer gets its own,
        // much larger budget (see docs/prompt-contract.md, "The analyzer").
        timeoutMs: cfg.timeoutMs ?? hot.config.llm.timeoutMs,
      });
    } catch (err) {
      // Nothing was billed: the request never left this process, or the
      // provider never returned a completion. `status` (the HTTP status when
      // the error carries one, e.g. 429) lets a caller tell a rate limit apart
      // from a genuine failure without parsing `detail`.
      // A `SectionsTooLargeError` (buildMemoryRequest's fitSections could not
      // even fit the required sections -- profiles alone over the cap, no
      // room left to trim) is the same kind of failure as a `TokenLimitError`
      // from the provider call itself: the request does not fit the per-request
      // token cap, full stop. Both surface as 'token-limit' so a caller can
      // split the batch instead of retrying it unchanged.
      const reason = err instanceof TokenLimitError || err instanceof SectionsTooLargeError ? 'token-limit' : 'llm-error';
      return { ok: false, usage: null, estimated: 0, result: null, error: err, reason, detail: detailOf(err), status: err?.statusCode };
    }

    const usage = completion.usage ?? null;
    const estimated = completion.estimated ?? 0;
    let update;
    try {
      update = parseJsonObject(completion.text);
    } catch (err) {
      // The completion arrived (and was billed) but its answer was garbage:
      // report the real usage/estimated so a caller charging a budget still
      // charges it. `reason` tells a cut-off completion (never going to
      // parse, no matter how many times it is retried) from plain bad JSON.
      const reason = looksTruncated(completion.text, completion.finishReason) ? 'truncated' : 'bad-json';
      return { ok: false, usage, estimated, result: null, error: err, reason, detail: errorNameOf(err) };
    }

    try {
      const result = applyUpdate(update, applySwitches(), { rosterIds });
      return { ok: true, usage, estimated, result, ...fit };
    } catch (err) {
      // A parsed answer the store failed to take: not the answer's size, so the batch is not
      // halved (see recordFailure). Logged by the error's name only.
      log.warn('memory: the analyzer answer could not be applied', { guildId, reason: 'apply-error', error: errorNameOf(err) });
      return { ok: false, usage, estimated, result: null, error: err, reason: 'apply-error', detail: errorNameOf(err) };
    }
  }

  /**
   * Resolve the waiters of `waitIdle()` once nothing is in flight any more.
   * @param {string} key  A guild id, or a `privateKey`.
   */
  function settle(key) {
    running.delete(key);
    if (running.size === 0 && idleWaiters.length > 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** How many buffered messages the next batch for `key` takes (see `sizeFactors`). */
  function batchTake(key, bufferLength) {
    const cfg = hot.config.memory;
    const factor = sizeFactors.get(key) ?? 1;
    const normalTake = cfg.batchMessages * 2;
    // Only the degraded (factor < 1) path is floored at MIN_LIVE_BATCH; the
    // normal size is left exactly as configured either way.
    const desired = factor === 1 ? normalTake : Math.max(MIN_LIVE_BATCH, Math.floor(normalTake * factor));
    return Math.min(bufferLength, desired);
  }

  /**
   * A failed batch for `key`: halve the next batch or back off, and log it.
   * @param {string} key
   * @param {object} outcome  From `analyze()` / `analyzePrivate()`.
   * @param {string} what     The log message prefix.
   * @param {object} fields   Extra log fields (counts and the guild id only).
   */
  function recordFailure(key, outcome, what, fields) {
    if (outcome.reason === 'truncated' || outcome.reason === 'bad-json' || outcome.reason === 'token-limit') {
      // Retrying the same-size batch can never succeed: 'truncated'/'bad-json'
      // means the completion is being cut by the output cap, and 'token-limit'
      // means the request itself (stored profiles included) does not fit the
      // per-request cap -- neither is transient bad luck. A plain back-off
      // would just retry the exact same buffer forever: halve the
      // batch size for next time instead, same as the output-cap case, so
      // the following attempt asks for fewer messages and pulls in fewer
      // distinct authors' profiles.
      sizeFactors.set(key, (sizeFactors.get(key) ?? 1) / 2);
      log.warn(`${what} failed, halving the batch size for next time`, {
        ...fields,
        reason: outcome.reason,
        detail: outcome.detail,
      });
    } else {
      backoffUntil.set(key, now() + BACKOFF_MS);
      log.warn(`${what} failed, backing off`, {
        ...fields,
        reason: outcome.reason,
        detail: outcome.detail,
        // An apply error is reported by name only (see analyzeBatch).
        error: outcome.reason === 'apply-error' ? undefined : outcome.error,
      });
    }
  }

  /** Run a memory update for one guild if its buffer is due and it is not busy/backed off. */
  async function run(guildId) {
    running.add(guildId);
    try {
      const buffer = store.getBuffer(guildId);
      const messages = buffer.slice(0, batchTake(guildId, buffer.length));

      const outcome = await analyze(guildId, messages);
      if (outcome.ok) {
        sizeFactors.delete(guildId); // back to normal size after a success
        // Counted only once the batch is consumed: a failed batch stays in the buffer and is retried.
        const emojiUsage = store.recordEmojiUsage(guildId, messages, emojiUsageOpts(hot.config));
        store.shiftBuffer(guildId, messages);
        store.flush();
        // Counts only: a portrait cue's text is the analyzer's prose about a member.
        const { portraitRequests, ...counts } = outcome.result;
        log.info('memory: update applied', {
          guildId,
          consumed: messages.length,
          shown: outcome.shown,
          trimmed: outcome.trimmed,
          roster: outcome.roster,
          rosterCandidates: outcome.rosterCandidates,
          rosterTokens: outcome.rosterTokens,
          ...counts,
          portraitRequests: portraitRequests.length,
          emojiUsage,
        });
        return;
      }
      recordFailure(guildId, outcome, 'memory: update', { guildId });
    } finally {
      settle(guildId);
    }
  }

  /** The `running`/`backoffUntil`/`sizeFactors` key of one member's private buffer. */
  const privateKey = (guildId, userId) => `private:${guildId}:${userId}`;

  /**
   * Run a private update for one member's buffered direct messages. The
   * buffer is shifted only after a success; a failure keeps it and backs off
   * or halves the next batch, exactly like `run()`. Never runs twice at once
   * for the same member. Logs carry counts only, never a member id.
   * @param {string} guildId
   * @param {string} userId
   */
  async function runPrivate(guildId, userId) {
    const key = privateKey(guildId, userId);
    if (running.has(key)) return;
    running.add(key);
    try {
      const buffer = store.getPrivateBuffer(guildId, userId);
      const messages = buffer.slice(0, batchTake(key, buffer.length));
      if (messages.length === 0) return;

      const outcome = await analyzePrivate(guildId, userId, messages);
      if (outcome.ok) {
        sizeFactors.delete(key);
        store.shiftPrivateBuffer(guildId, userId, messages);
        store.flush();
        log.info('memory: private update applied', { guildId, consumed: messages.length, shown: outcome.shown, trimmed: outcome.trimmed, ...outcome.result });
        return;
      }
      recordFailure(key, outcome, 'memory: private update', { guildId });
    } finally {
      settle(key);
    }
  }

  let privatePass = false; // true while a tick is working through the private buffers

  /**
   * Every due private buffer of every guild, one at a time (a DM batch is
   * small; the private pass never runs concurrently with itself, even across
   * ticks). Stops as soon as the persona is paused.
   */
  async function runDuePrivate() {
    if (privatePass) return;
    privatePass = true;
    try {
      for (const guildId of store.listGuilds()) {
        for (const userId of store.listPrivate(guildId)) {
          if (store.state.data.paused) return;
          const key = privateKey(guildId, userId);
          if (running.has(key)) continue;
          const nowMs = now();
          if (nowMs < (backoffUntil.get(key) ?? 0)) continue;
          if (store.privateBufferInfo(guildId, userId).size === 0) continue;
          const relationshipsCfg = hot.config.features?.relationships !== false ? hot.config.relationships : undefined;
          if (!isDue(store.getPrivateBuffer(guildId, userId), nowMs, hot.config.memory, relationshipsCfg)) continue;
          await runPrivate(guildId, userId);
        }
      }
    } finally {
      privatePass = false;
    }
  }

  /** Check every guild and every private buffer, and kick off a memory update for the ones that are due. */
  async function tick() {
    // /nep pause: the live analyzer never runs while paused.
    if (store.state.data.paused) return;
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
    jobs.push(runDuePrivate());
    await Promise.all(jobs);
  }

  /**
   * Resolves once no `run()` / `runPrivate()` is in flight -- immediately if
   * that is already true. Never starts a new run itself. Used by admin.js's
   * `/nep pause` to wait out a live-analyzer run that was already in
   * flight when the pause was requested (an LLM call can take 30-90s): its
   * result must land on disk BEFORE the pause flushes and drops the store's
   * caches, or the eventual `applyMemoryUpdate` would re-read a profile from
   * disk, mutate it and mark it dirty after the owner started editing files
   * under data/ -- exactly the overwrite this feature exists to prevent.
   * @returns {Promise<void>}
   */
  function waitIdle() {
    return running.size === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve));
  }

  return { observe, tick, run, runPrivate, analyze, analyzePrivate, waitIdle };
}
