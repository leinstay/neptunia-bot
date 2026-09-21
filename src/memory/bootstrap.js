// Phase A of the sample-based bootstrap (.claude/docs/prompt-contract.md,
// "The bootstrap") — a read-only PREVIEW of what a fresh, sample-based memory
// seed would look like, without writing anything under data/. Take up to
// `bootstrap.messagesPerPerson` of a member's own messages (newest-heavy but
// spread over `bootstrap.lookbackDays`, one channel capped at
// `bootstrap.maxChannelShare` unless it is a main channel), a little
// conversational context around each, and ask `prompts/profile.md` for one
// person at a time; `prompts/channel.md` does the same for a channel's newest
// `bootstrap.messagesPerChannel` messages. Both prompts are read the same way
// the stream analyzer's `memory.md` is (formatTranscript's 'memory' mode, the
// same character card, the same clampText/toTokens/fromTokens helpers) so a
// preview and the live analyzer's own portraits are directly comparable.
//
// Nothing here ever touches the store: `analyze` output is parsed and
// clamped only to render a preview, never applied to a profile. The stream
// analyzer, the warm-up and every existing command are untouched — this is a
// parallel, read-only path the owner can compare against them before the
// long warm-up is retired.

import { readableChannels, fetchHistoryWindow } from '../discord/collect.js';
import { formatTranscript, renderTranscript } from '../discord/format.js';
import { fitSections, SectionsTooLargeError } from '../llm/budget.js';
import { estimateTokens, estimateMessages } from '../llm/tokens.js';
import { parseJsonObject } from '../llm/parse.js';
import { clampText } from './clamp.js';
import { normalizeTopic } from './interests.js';
import { toTokens, fromTokens } from './mentions.js';
import { log } from '../log.js';

const CACHE_TTL_MS = 15 * 60_000;

// Fallbacks for the profile-prompt placeholders, mirroring config.json's own
// defaults -- used only when a deployment's config is missing the key. Kept
// separate from src/memory/update.js's own MEMORY_LIMIT_DEFAULTS so this
// module never has to import from it (see the task's "MUST NOT touch"
// list -- update.js's logic is off-limits, its shape is not otherwise shared).
const BOOTSTRAP_LIMIT_DEFAULTS = {
  fieldChars: 400,
  maxInterests: 12,
  maxDetails: 15,
  interestTopicChars: 40,
  interestNoteChars: 120,
  maxNewEpisodes: 3,
};

// ---------------------------------------------------------------------------
// Small pure helpers local to this module (deliberately not imported from
// src/memory/update.js, whose internals are off-limits to this task).
// ---------------------------------------------------------------------------

function block(tag, body) {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

function fillTemplate(template, values) {
  return (template ?? '').replace(/\{\{(\w+)\}\}/g, (all, key) => (values[key] !== undefined ? values[key] : all));
}

function isoDateOrDash(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '-';
}

function profileTemplateValues(config, selfName) {
  const memoryCfg = config?.memory ?? {};
  return {
    name: selfName,
    fieldChars: memoryCfg.fieldChars ?? BOOTSTRAP_LIMIT_DEFAULTS.fieldChars,
    maxInterests: memoryCfg.maxInterests ?? BOOTSTRAP_LIMIT_DEFAULTS.maxInterests,
    maxDetails: memoryCfg.maxDetails ?? BOOTSTRAP_LIMIT_DEFAULTS.maxDetails,
    interestTopicChars: memoryCfg.interestTopicChars ?? BOOTSTRAP_LIMIT_DEFAULTS.interestTopicChars,
    interestNoteChars: memoryCfg.interestNoteChars ?? BOOTSTRAP_LIMIT_DEFAULTS.interestNoteChars,
    maxNewEpisodes: memoryCfg.maxNewEpisodes ?? BOOTSTRAP_LIMIT_DEFAULTS.maxNewEpisodes,
  };
}

// ---------------------------------------------------------------------------
// pickPeople / memberStats -- who qualifies right now
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, name: string, category: string|null, topic: string|null, messages: object[] }} ChannelWindow
 *   `messages` are normalized (src/discord/collect.js#normalizeMessage), oldest first.
 */

/** Per-author counters over every window's own (non-bot, non-self) messages, keyed by author id. */
function collectAuthorStats(windows) {
  const authors = new Map();
  for (const window of windows ?? []) {
    for (const message of window.messages ?? []) {
      if (message.bot || message.self) continue;
      const id = String(message.authorId);
      let entry = authors.get(id);
      if (!entry) {
        entry = { id, name: message.authorName, nameTs: message.ts, messages: 0, firstTs: message.ts, lastTs: message.ts, byChannel: {} };
        authors.set(id, entry);
      }
      entry.messages += 1;
      entry.firstTs = Math.min(entry.firstTs, message.ts);
      entry.lastTs = Math.max(entry.lastTs, message.ts);
      entry.byChannel[window.id] = (entry.byChannel[window.id] ?? 0) + 1;
      // The most recent nick seen for this author wins -- display names drift.
      if (message.ts >= entry.nameTs) {
        entry.nameTs = message.ts;
        entry.name = message.authorName;
      }
    }
  }
  return authors;
}

/**
 * Members who qualify for the bootstrap sample right now: at least
 * `cfg.minMessages` own messages across `windows`, most active first, top
 * `cfg.maxPeople`. Bots and the persona's own messages are excluded (see
 * collectAuthorStats). Pure.
 * @param {ChannelWindow[]} windows
 * @param {{ minMessages?: number, maxPeople?: number }} cfg
 * @returns {{ id: string, name: string, messages: number, firstTs: number, lastTs: number, byChannel: Record<string, number> }[]}
 */
export function pickPeople(windows, cfg = {}) {
  const authors = collectAuthorStats(windows);
  const minMessages = Number.isFinite(cfg.minMessages) && cfg.minMessages > 0 ? cfg.minMessages : 0;
  const maxPeople = Number.isInteger(cfg.maxPeople) && cfg.maxPeople >= 0 ? cfg.maxPeople : Infinity;
  return [...authors.values()]
    .filter((a) => a.messages >= minMessages)
    .sort((a, b) => b.messages - a.messages || a.id.localeCompare(b.id))
    .slice(0, maxPeople)
    .map(({ nameTs: _nameTs, ...rest }) => rest);
}

/** One member's stats (see pickPeople), with no threshold/cap applied -- `null` when they wrote
 * nothing in `windows` at all. Used by `/nep bootstrap preview user:` to report on exactly the
 * member asked for, regardless of `bootstrap.minMessages`. */
export function memberStats(windows, memberId) {
  const entry = collectAuthorStats(windows).get(String(memberId));
  if (!entry) return null;
  const { nameTs: _nameTs, ...rest } = entry;
  return rest;
}

// ---------------------------------------------------------------------------
// sampleMember -- newest-heavy but spread, channel-share capped, with context
// ---------------------------------------------------------------------------

/** `count` items spread evenly over `pool` (chronological), deterministic: no rng. */
function evenlySpread(pool, count) {
  if (count <= 0 || pool.length === 0) return [];
  if (count >= pool.length) return pool.slice();
  const used = new Set();
  const step = pool.length / count;
  const result = [];
  for (let i = 0; i < count; i += 1) {
    let idx = Math.floor(i * step);
    while (used.has(idx) && idx < pool.length - 1) idx += 1;
    used.add(idx);
    result.push(pool[idx]);
  }
  return result;
}

/**
 * Up to `total` of `sortedAsc` (one author's own messages, chronological),
 * newest-heavy but spread over the whole window: half from the newest third,
 * the rest evenly spread over the older two-thirds -- falling back to
 * whichever pool actually has enough messages when one of the two is short.
 * Deterministic (no rng), oldest-first on return. Pure.
 * @param {object[]} sortedAsc
 * @param {number} total
 * @returns {object[]}
 */
export function splitNewestOlder(sortedAsc, total) {
  const wantTotal = Math.min(Math.max(0, total), sortedAsc.length);
  if (wantTotal <= 0) return [];

  const thirdStart = Math.floor((sortedAsc.length * 2) / 3);
  const newestPool = sortedAsc.slice(thirdStart);
  const olderPool = sortedAsc.slice(0, thirdStart);

  let newestWant = Math.ceil(wantTotal / 2);
  let olderWant = wantTotal - newestWant;
  if (newestWant > newestPool.length) {
    olderWant += newestWant - newestPool.length;
    newestWant = newestPool.length;
  }
  if (olderWant > olderPool.length) {
    newestWant = Math.min(newestPool.length, newestWant + (olderWant - olderPool.length));
    olderWant = olderPool.length;
  }

  const chosenNewest = newestPool.slice(newestPool.length - newestWant);
  const chosenOlder = evenlySpread(olderPool, olderWant);
  return [...chosenOlder, ...chosenNewest];
}

/**
 * Sample one member's own messages for `profile.md`, plus a little
 * conversational context around each: up to `cfg.messagesPerPerson`, spread
 * per `splitNewestOlder`, at most `cfg.maxChannelShare` of them from one
 * channel UNLESS that channel is listed in `mainChannelIds` (main channels
 * are quota-filled first, uncapped). Every chosen message brings its
 * `cfg.contextBefore` immediately preceding channel messages (any author) and
 * its reply target when that is inside the fetched window; overlapping
 * context is merged (a `Set` per channel). The returned messages are grouped
 * by channel (main channels first, each by activity), chronological within a
 * channel. Pure.
 * @param {ChannelWindow[]} windows
 * @param {string} memberId
 * @param {{ messagesPerPerson?: number, contextBefore?: number, maxChannelShare?: number }} cfg
 * @param {Set<string>|string[]} [mainChannelIds]
 * @returns {{ messages: object[], ownIds: Set<string>, channels: string[], ownCount: number, contextCount: number }}
 */
export function sampleMember(windows, memberId, cfg = {}, mainChannelIds) {
  const mainIds = mainChannelIds instanceof Set ? mainChannelIds : new Set((mainChannelIds ?? []).map(String));
  const messagesPerPerson = Number.isInteger(cfg.messagesPerPerson) && cfg.messagesPerPerson > 0 ? cfg.messagesPerPerson : 0;
  const contextBefore = Number.isInteger(cfg.contextBefore) && cfg.contextBefore >= 0 ? cfg.contextBefore : 0;
  const maxChannelShare = Number.isFinite(cfg.maxChannelShare) && cfg.maxChannelShare > 0 && cfg.maxChannelShare <= 1 ? cfg.maxChannelShare : 1;

  const id = String(memberId);
  const channelPools = new Map(); // channelId -> this member's own messages, chronological
  const indexById = new Map(); // channelId -> Map(messageId -> index in that window)
  const windowById = new Map(); // channelId -> the ChannelWindow

  for (const window of windows ?? []) {
    windowById.set(window.id, window);
    const idx = new Map();
    (window.messages ?? []).forEach((m, i) => idx.set(m.id, i));
    indexById.set(window.id, idx);
    const own = (window.messages ?? []).filter((m) => String(m.authorId) === id && !m.bot && !m.self);
    if (own.length > 0) channelPools.set(window.id, own);
  }

  if (channelPools.size === 0 || messagesPerPerson === 0) {
    return { messages: [], ownIds: new Set(), channels: [], ownCount: 0, contextCount: 0 };
  }

  const shareCap = Math.max(1, Math.floor(messagesPerPerson * maxChannelShare));
  const byActivityDesc = (a, b) => channelPools.get(b).length - channelPools.get(a).length || a.localeCompare(b);
  const mainOrder = [...channelPools.keys()].filter((cid) => mainIds.has(cid)).sort(byActivityDesc);
  const otherOrder = [...channelPools.keys()].filter((cid) => !mainIds.has(cid)).sort(byActivityDesc);

  const quotas = new Map();
  let remaining = messagesPerPerson;
  for (const cid of mainOrder) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, channelPools.get(cid).length);
    if (take > 0) quotas.set(cid, take);
    remaining -= take;
  }
  for (const cid of otherOrder) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, shareCap, channelPools.get(cid).length);
    if (take > 0) quotas.set(cid, take);
    remaining -= take;
  }

  const orderedChannels = [...mainOrder, ...otherOrder].filter((cid) => quotas.has(cid));

  const ownIdsByChannel = new Map();
  const ownIds = new Set();
  for (const cid of orderedChannels) {
    const chosen = splitNewestOlder(channelPools.get(cid), quotas.get(cid));
    const own = new Set(chosen.map((m) => m.id));
    ownIdsByChannel.set(cid, own);
    for (const oid of own) ownIds.add(oid);
  }

  const messages = [];
  let contextCount = 0;
  for (const cid of orderedChannels) {
    const own = ownIdsByChannel.get(cid);
    const idx = indexById.get(cid);
    const windowMessages = windowById.get(cid).messages;

    const included = new Set(own);
    for (const oid of own) {
      const i = idx.get(oid);
      for (let k = Math.max(0, i - contextBefore); k < i; k += 1) {
        included.add(windowMessages[k].id);
      }
      const replyToId = windowMessages[i].replyToId;
      if (replyToId && idx.has(replyToId)) included.add(replyToId);
    }

    const orderedIndexes = [...included].map((mid) => idx.get(mid)).sort((a, b) => a - b);
    for (const i of orderedIndexes) {
      const message = windowMessages[i];
      messages.push(message);
      if (!own.has(message.id)) contextCount += 1;
    }
  }

  return { messages, ownIds, channels: orderedChannels, ownCount: ownIds.size, contextCount };
}

/** The newest `messagesPerChannel` of `messages` (chronological, oldest first) -- everything when
 * `messagesPerChannel` is not a positive integer. Pure. */
export function selectChannelMessages(messages, messagesPerChannel) {
  const list = messages ?? [];
  const n = Number.isInteger(messagesPerChannel) && messagesPerChannel > 0 ? messagesPerChannel : list.length;
  return list.length > n ? list.slice(list.length - n) : list.slice();
}

// ---------------------------------------------------------------------------
// Transcript marking -- own vs context lines (labels.bootstrap.ownMark / .contextMark)
// ---------------------------------------------------------------------------

/**
 * Prefix each formatTranscript item's last line (the actual `[hh:mm] nick:
 * text` line, as opposed to a `## #channel` heading or a gap/date marker
 * pushed before it) with `labels.bootstrap.ownMark` when its message id is in
 * `ownIds`, else `labels.bootstrap.contextMark`. Either label missing ->
 * `''`, i.e. no prefix at all for that side -- every item is still returned
 * (nothing is ever skipped for lack of a marker). Pure.
 * @param {{ id: string, text: string }[]} items  formatTranscript's output.
 * @param {Set<string>} ownIds
 * @param {object} labels
 */
export function markOwnContext(items, ownIds, labels) {
  const ownMark = labels?.bootstrap?.ownMark ?? '';
  const contextMark = labels?.bootstrap?.contextMark ?? '';
  if (!ownMark && !contextMark) return items;
  return items.map((item) => {
    const mark = ownIds.has(item.id) ? ownMark : contextMark;
    if (!mark) return item;
    const lines = item.text.split('\n');
    lines[lines.length - 1] = `${mark}${lines[lines.length - 1]}`;
    return { ...item, text: lines.join('\n') };
  });
}

// ---------------------------------------------------------------------------
// Request building -- profile.md / channel.md, fitted under the token cap
// ---------------------------------------------------------------------------

/** Drop the OLDEST items of `items` until `[...fixedItems, ...items]` fits `limit` under `cost` --
 * never trims `fixedItems` (throws SectionsTooLargeError if those alone do not fit). Returns the
 * surviving suffix of `items`, in their original order. */
function fitNewest(fixedItems, items, limit, cost) {
  const { kept } = fitSections(
    [
      { name: 'fixed', required: true, items: fixedItems.filter(Boolean) },
      { name: 'rest', keep: 'newest', items },
    ],
    limit,
    cost,
  );
  return items.slice(items.length - kept.rest.length);
}

/**
 * Build one `profile.md` request for `member` (see pickPeople/memberStats),
 * from `sample` (see sampleMember). Pure: no I/O, no clock reads. Mirrors
 * src/memory/update.js#buildMemoryRequest's shape (system + one user message
 * with `<character>`/`<member>`/`<snippets>` blocks, fitted under
 * `llm.maxRequestTokens * llm.safetyMargin`, oldest snippets dropped first)
 * without importing anything from it.
 * @param {object} input
 * @param {object} input.prompts   `prompts.profile` is the system message; `prompts['character-card']`
 *   is the same source src/memory/update.js#buildMemoryRequest uses for `<character>`.
 * @param {object} input.config    Live config.
 * @param {object} input.calibrator  From createCalibrator().
 * @param {{ id: string, name: string, messages: number, firstTs: number, lastTs: number }} input.member
 * @param {{ messages: object[], ownIds: Set<string> }} input.sample
 * @param {string} input.selfName
 * @returns {{ messages: {role: string, content: string}[], stats: { ownKept: number, contextKept: number,
 *   snippetsDropped: number, estimatedTokens: number } }}
 */
export function buildProfileRequest({ prompts, config, calibrator, member, sample, selfName }) {
  const labels = prompts?.labels ?? {};
  const timezone = config?.bot?.timezone ?? 'UTC';
  const system = fillTemplate(prompts?.profile, profileTemplateValues(config, selfName));
  const characterBlock = block('character', fillTemplate(prompts?.['character-card'], { name: selfName }));
  const memberLine = `${member.name} (id:${member.id}), ${member.messages} messages in the window, first ${isoDateOrDash(member.firstTs)}, last ${isoDateOrDash(member.lastTs)}`;
  const memberBlock = block('member', memberLine);

  const formatOptions = {
    timezone,
    gapMinutes: config?.context?.gapMarkerMinutes ?? 20,
    maxChars: config?.context?.maxMessageChars ?? 800,
    selfName,
    mode: 'memory',
    labels,
  };
  const items = markOwnContext(formatTranscript(sample.messages, formatOptions), sample.ownIds, labels);
  const transcriptTexts = items.map((item) => item.text);

  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const limit = Math.floor((config?.llm?.maxRequestTokens ?? 50000) * (config?.llm?.safetyMargin ?? 0.9));
  const keptTexts = fitNewest([system, characterBlock, memberBlock], transcriptTexts, limit, cost);
  const keptItems = items.slice(items.length - keptTexts.length);

  const snippetsBlock = block('snippets', renderTranscript(keptItems, timezone, labels));
  const user = [characterBlock, memberBlock, snippetsBlock].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const ownKept = keptItems.filter((item) => sample.ownIds.has(item.id)).length;
  return {
    messages,
    stats: {
      ownKept,
      contextKept: keptItems.length - ownKept,
      snippetsDropped: items.length - keptItems.length,
      estimatedTokens: calibrator.apply(estimateMessages(messages)),
    },
  };
}

/**
 * Build one `channel.md` request. Pure, mirrors buildProfileRequest above.
 * @param {object} input
 * @param {object} input.prompts   `prompts.channel` is the system message.
 * @param {object} input.config    Live config.
 * @param {object} input.calibrator
 * @param {{ id: string, name: string, category: string|null, topic: string|null }} input.channel
 * @param {object[]} input.messages  Already selected (see selectChannelMessages), chronological.
 * @param {boolean} input.isMain
 * @param {string} [input.selfName]
 * @returns {{ messages: {role: string, content: string}[], stats: { kept: number, dropped: number, estimatedTokens: number } }}
 */
export function buildChannelRequest({ prompts, config, calibrator, channel, messages: channelMessages, isMain, selfName = '' }) {
  const labels = prompts?.labels ?? {};
  const timezone = config?.bot?.timezone ?? 'UTC';
  const memoryCfg = config?.memory ?? {};
  const system = fillTemplate(prompts?.channel, { fieldChars: memoryCfg.fieldChars ?? BOOTSTRAP_LIMIT_DEFAULTS.fieldChars });
  const channelLine = [
    `${channel.name} (id:${channel.id})`,
    channel.category ? `category: ${channel.category}` : null,
    channel.topic ? `topic: ${channel.topic}` : null,
    isMain ? 'main: true' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const channelBlock = block('channel', channelLine);

  const formatOptions = {
    timezone,
    gapMinutes: config?.context?.gapMarkerMinutes ?? 20,
    maxChars: config?.context?.maxMessageChars ?? 800,
    selfName,
    mode: 'memory',
    labels,
  };
  const items = formatTranscript(channelMessages, formatOptions);
  const transcriptTexts = items.map((item) => item.text);

  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const limit = Math.floor((config?.llm?.maxRequestTokens ?? 50000) * (config?.llm?.safetyMargin ?? 0.9));
  const keptTexts = fitNewest([system, channelBlock], transcriptTexts, limit, cost);
  const keptItems = items.slice(items.length - keptTexts.length);

  const messagesBlock = block('messages', renderTranscript(keptItems, timezone, labels));
  const user = [channelBlock, messagesBlock].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  return {
    messages,
    stats: {
      kept: keptItems.length,
      dropped: items.length - keptItems.length,
      estimatedTokens: calibrator.apply(estimateMessages(messages)),
    },
  };
}

// ---------------------------------------------------------------------------
// Result clamping -- same helpers the stream analyzer uses, never stored
// ---------------------------------------------------------------------------

function makeTokenizer(nameOf) {
  const isKnownId = (id) => typeof nameOf(id) === 'string' && nameOf(id).length > 0;
  const namesOf = (id) => {
    const name = nameOf(id);
    return name ? [name] : [];
  };
  return (text) => (typeof text === 'string' ? toTokens(text, isKnownId, namesOf) : text);
}

/** Tokenize a stray `Name (id:123)` form the model wrote, clamp, then resolve back to
 * `name (id:123)` display text -- same order src/memory/update.js#applyMemoryUpdate uses. */
function clampResolvedField(raw, limit, tolerance, tokenize, nameOf) {
  if (typeof raw !== 'string') return '';
  return fromTokens(clampText(tokenize(raw), limit, { tolerance }), nameOf, 'analyzer');
}

function clampedTimes(value) {
  return Number.isInteger(value) ? Math.min(5, Math.max(1, value)) : 1;
}

/** Merge interest-shaped items (`{ topic, note, times }`) sharing the same normalized topic:
 * the first note wins unless it is empty, `times` is the max seen. */
function dedupeByIdentity(items, identityField) {
  const byKey = new Map();
  for (const item of items) {
    const key = normalizeTopic(item[identityField]);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, {
      ...existing,
      note: existing.note || item.note,
      times: Math.max(existing.times, item.times),
    });
  }
  return [...byKey.values()];
}

/**
 * Validate and clamp the model's `profile.md` JSON with the same helpers the
 * stream analyzer uses (clampText, normalizeTopic, toTokens/fromTokens) --
 * for DISPLAY only, nothing here is ever stored. `null` on garbage input.
 * @param {unknown} raw
 * @param {object} config  Live config (`config.memory`).
 * @param {(id: string) => (string|null)} nameOf
 */
export function clampProfileResult(raw, config, nameOf = () => null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const memoryCfg = config?.memory ?? {};
  const tolerance = memoryCfg.clampTolerance;
  const fieldChars = memoryCfg.fieldChars ?? BOOTSTRAP_LIMIT_DEFAULTS.fieldChars;
  const topicChars = memoryCfg.interestTopicChars ?? BOOTSTRAP_LIMIT_DEFAULTS.interestTopicChars;
  const noteChars = memoryCfg.interestNoteChars ?? BOOTSTRAP_LIMIT_DEFAULTS.interestNoteChars;
  const maxNewEpisodes = memoryCfg.maxNewEpisodes ?? BOOTSTRAP_LIMIT_DEFAULTS.maxNewEpisodes;
  const tokenize = makeTokenizer(nameOf);
  const resolve = (text, limit) => clampResolvedField(text, limit, tolerance, tokenize, nameOf);

  const character = resolve(raw.character, fieldChars);
  const style = resolve(raw.style, fieldChars);

  const interests = dedupeByIdentity(
    (Array.isArray(raw.interests) ? raw.interests : [])
      .map((it) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
        const topic = typeof it.topic === 'string' ? clampText(it.topic, topicChars, { tolerance: 1 }) : '';
        if (!topic) return null;
        return { topic, note: resolve(it.note, noteChars), times: clampedTimes(it.times) };
      })
      .filter(Boolean),
    'topic',
  );

  const details = dedupeByIdentity(
    (Array.isArray(raw.details) ? raw.details : [])
      .map((d) => {
        if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
        const text = resolve(d.text, fieldChars);
        if (!text) return null;
        return { topic: text, text, times: clampedTimes(d.times) };
      })
      .filter(Boolean),
    'topic',
  ).map(({ text, times }) => ({ text, times }));

  const episodes = (Array.isArray(raw.episodes) ? raw.episodes : [])
    .slice(0, maxNewEpisodes)
    .map((ep) => {
      if (!ep || typeof ep !== 'object' || Array.isArray(ep)) return null;
      const what = resolve(ep.what, fieldChars);
      if (!what) return null;
      const quote = typeof ep.quote === 'string' ? clampText(ep.quote, 120, { tolerance: 1 }) : '';
      const feeling = resolve(ep.feeling, fieldChars);
      const weight = Number.isInteger(ep.weight) ? Math.min(5, Math.max(1, ep.weight)) : 3;
      const date = typeof ep.date === 'string' ? ep.date.slice(0, 10) : '';
      return { date, what, quote, feeling, weight };
    })
    .filter(Boolean);

  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
    .map((a) => (typeof a === 'string' ? clampText(a, 40, { tolerance: 1 }) : ''))
    .filter(Boolean);

  return { character, style, interests, details, episodes, aliases };
}

/** Validate and clamp the model's `channel.md` JSON. `null` on garbage input; nothing stored. */
export function clampChannelResult(raw, config) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const memoryCfg = config?.memory ?? {};
  const tolerance = memoryCfg.clampTolerance;
  const fieldChars = memoryCfg.fieldChars ?? BOOTSTRAP_LIMIT_DEFAULTS.fieldChars;
  return {
    purpose: typeof raw.purpose === 'string' ? clampText(raw.purpose, fieldChars, { tolerance }) : '',
    topics: typeof raw.topics === 'string' ? clampText(raw.topics, fieldChars, { tolerance }) : '',
    tone: typeof raw.tone === 'string' ? clampText(raw.tone, fieldChars, { tolerance }) : '',
  };
}

// ---------------------------------------------------------------------------
// Factory -- the only place that touches discord.js and the LLM client
// ---------------------------------------------------------------------------

/** The latest author name seen for each id across `windows`, for `fromTokens`/`toTokens` -- never
 * touches the store (see the module header). */
function buildNameIndex(windows) {
  const latest = new Map();
  for (const window of windows ?? []) {
    for (const message of window.messages ?? []) {
      const id = String(message.authorId);
      const current = latest.get(id);
      if (!current || message.ts >= current.ts) latest.set(id, { name: message.authorName, ts: message.ts });
    }
  }
  return (id) => latest.get(String(id))?.name ?? null;
}

/**
 * @param {object} deps
 * @param {object} deps.hot       Live config + prompts; read at the moment of use.
 * @param {import('discord.js').Client} deps.client
 * @param {object} deps.llm       From createLlm() (src/llm/openrouter.js).
 * @param {object} deps.calibrator  From createCalibrator().
 * @param {(guildId: string) => string} deps.getSelfName
 * @param {() => number} [deps.now]
 */
export function createBootstrap({ hot, client, llm, calibrator, getSelfName, now = Date.now }) {
  const cache = new Map(); // guildId -> { fetchedAt, windows }

  /** (Re-)fetch every readable channel's window, sequentially -- see the module header;
   * `bootstrap.lookbackDays`/`fetchLimitPerChannel` are read fresh, never cached. */
  async function fetchGuildWindows(guild, cfg) {
    const channels = readableChannels(guild, hot.config.bot);
    const minTs = now() - (cfg.lookbackDays ?? 60) * 24 * 60 * 60_000;
    const selfId = client.user?.id;
    const windows = [];
    for (const channel of channels) {
      let messages = [];
      try {
        messages = await fetchHistoryWindow(channel, {
          limit: cfg.fetchLimitPerChannel ?? 15000,
          minTs,
          selfId,
          embedTextChars: hot.config.media?.embedTextChars,
        });
      } catch (err) {
        log.warn('bootstrap: channel fetch failed, skipping it for this round', { channel: channel.id, error: err });
      }
      log.info('bootstrap: channel fetched', { channel: channel.id, messages: messages.length });
      windows.push({ id: channel.id, name: channel.name, category: channel.parent?.name ?? null, topic: channel.topic ?? null, messages });
    }
    return windows;
  }

  /** Cached windows for `guildId`, refetched once the 15-minute cache entry has gone stale. */
  async function getWindows(guildId, guild, cfg) {
    const cached = cache.get(guildId);
    if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return cached.windows;
    const windows = await fetchGuildWindows(guild, cfg);
    cache.set(guildId, { fetchedAt: now(), windows });
    return windows;
  }

  function resolvedGuild(guildId) {
    return client.guilds?.cache?.get(guildId) ?? null;
  }

  /** `/nep bootstrap people`: who currently qualifies, plus totals. Never calls the model. */
  async function peopleReport(guildId) {
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    const cfg = hot.config.bootstrap ?? {};
    const windows = await getWindows(guildId, guild, cfg);
    const everyone = pickPeople(windows, { minMessages: 0, maxPeople: Infinity });
    const qualifyingUncapped = pickPeople(windows, { minMessages: cfg.minMessages, maxPeople: Infinity });
    const people = pickPeople(windows, cfg);

    return {
      ok: true,
      people,
      totals: {
        channelsRead: windows.length,
        messagesRead: windows.reduce((sum, w) => sum + w.messages.length, 0),
        belowThreshold: everyone.length - qualifyingUncapped.length,
      },
    };
  }

  /** Shared by previewUser/previewChannel: the analyzer-role model, called with the warm-up's own
   * rail (never the daily request cap) and the bootstrap output budget. */
  async function callModel(messages, cfg) {
    const model = hot.config.memory?.model ?? hot.config.llm?.model;
    const completion = await llm.complete(messages, {
      model,
      maxOutputTokens: cfg.maxOutputTokens ?? 6000,
      countAgainstDailyCap: false,
    });
    return { model, completion };
  }

  /** `/nep bootstrap preview user:<member>`. Never writes anything; a missing `prompts.profile`
   * (the writer may land after the code) is reported instead of calling the model. */
  async function previewUser(guildId, userId) {
    if (!hot.prompts?.profile) {
      return { ok: false, message: 'prompt file missing: prompts/profile.md (or prompts.local/profile.md) is not configured yet' };
    }
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    const cfg = hot.config.bootstrap ?? {};
    const windows = await getWindows(guildId, guild, cfg);
    const member = memberStats(windows, userId);
    if (!member) return { ok: false, message: `no messages from this member in the last ${cfg.lookbackDays ?? 60} days` };

    const mainChannelIds = new Set((hot.config.memory?.mainChannelIds ?? []).map(String));
    const sample = sampleMember(windows, userId, cfg, mainChannelIds);
    if (sample.messages.length === 0) return { ok: false, message: 'nothing to sample for this member' };

    const nameOf = buildNameIndex(windows);
    const selfName = getSelfName(guildId);

    let built;
    try {
      built = buildProfileRequest({ prompts: hot.prompts, config: hot.config, calibrator, member, sample, selfName });
    } catch (err) {
      if (err instanceof SectionsTooLargeError) return { ok: false, message: `request does not fit the token cap: ${err.message}` };
      throw err;
    }

    let completion;
    try {
      ({ completion } = await callModel(built.messages, cfg));
    } catch (err) {
      return { ok: false, message: `model call failed: ${err?.message ?? err}` };
    }

    let parsed;
    try {
      parsed = parseJsonObject(completion.text);
    } catch (err) {
      return { ok: false, message: `could not parse the model's answer: ${err?.message ?? err}` };
    }

    return {
      ok: true,
      member,
      sample: { ownCount: sample.ownCount, contextCount: sample.contextCount, channels: sample.channels },
      estimatedTokens: built.stats.estimatedTokens,
      usage: completion.usage ?? null,
      result: clampProfileResult(parsed, hot.config, nameOf),
    };
  }

  /** `/nep bootstrap preview channel:<channel>`. Never writes anything; a missing
   * `prompts.channel` is reported instead of calling the model. */
  async function previewChannel(guildId, channelId) {
    if (!hot.prompts?.channel) {
      return { ok: false, message: 'prompt file missing: prompts/channel.md (or prompts.local/channel.md) is not configured yet' };
    }
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    const cfg = hot.config.bootstrap ?? {};
    const windows = await getWindows(guildId, guild, cfg);
    const window = windows.find((w) => w.id === String(channelId));
    if (!window) return { ok: false, message: 'channel not found, not readable, or not in this guild' };
    if (window.messages.length === 0) return { ok: false, message: `channel has no messages in the last ${cfg.lookbackDays ?? 60} days` };

    const mainChannelIds = new Set((hot.config.memory?.mainChannelIds ?? []).map(String));
    const isMain = mainChannelIds.has(String(channelId));
    const selected = selectChannelMessages(window.messages, cfg.messagesPerChannel);
    const selfName = getSelfName(guildId);

    let built;
    try {
      built = buildChannelRequest({ prompts: hot.prompts, config: hot.config, calibrator, channel: window, messages: selected, isMain, selfName });
    } catch (err) {
      if (err instanceof SectionsTooLargeError) return { ok: false, message: `request does not fit the token cap: ${err.message}` };
      throw err;
    }

    let completion;
    try {
      ({ completion } = await callModel(built.messages, cfg));
    } catch (err) {
      return { ok: false, message: `model call failed: ${err?.message ?? err}` };
    }

    let parsed;
    try {
      parsed = parseJsonObject(completion.text);
    } catch (err) {
      return { ok: false, message: `could not parse the model's answer: ${err?.message ?? err}` };
    }

    return {
      ok: true,
      channel: { id: window.id, name: window.name, category: window.category, topic: window.topic, isMain },
      sample: { kept: built.stats.kept, dropped: built.stats.dropped, total: window.messages.length },
      estimatedTokens: built.stats.estimatedTokens,
      usage: completion.usage ?? null,
      result: clampChannelResult(parsed, hot.config),
    };
  }

  return { peopleReport, previewUser, previewChannel };
}
