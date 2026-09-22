// THE way memory starts (docs/prompt-contract.md, "The bootstrap").
// Sampling: up to `bootstrap.messagesPerPerson` of a member's own messages
// (newest-heavy but spread over `bootstrap.lookbackDays`, one channel capped
// at `bootstrap.maxChannelShare` unless it is a main channel), a little
// conversational context around each, asked of `prompts/profile.md` one
// person at a time; `prompts/channel.md` does the same for a channel's newest
// `bootstrap.messagesPerChannel` messages; `prompts/server.md` closes a run
// with one request over every channel's notes, a line per profiled member and
// the newest `bootstrap.serverSampleMessages` messages of the main channels.
// All three are read the same way the stream analyzer's `memory.md` is
// (formatTranscript's 'memory' mode, the same character card, the same
// clampText/toTokens/fromTokens helpers).
//
// `peopleReport` stays read-only (never touches the store) for `/nep
// warmup people`. `createBootstrap().run()` is the write path: channels →
// people → server, in order, resumable (progress in `state.bootstrap`,
// flushed after every request), muting the persona for as long as it is in
// flight (`isBootstrapping()`, wired into src/discord/events.js,
// src/behavior/spontaneous.js and src/admin.js). `runPerson`/`runChannel`/
// `runServer` (re)do exactly one target now, synchronously, for `/nep
// warmup users user:<member>` / `channels channel:<channel>` / `server`;
// `runUsers`/`runChannels` (re)do EVERY qualifying member/every readable
// channel now, sharing `running` and every rail with `run()`, for `/nep
// warmup users`/`channels` given with no member/channel -- a redo always
// re-processes its targets regardless of `state.bootstrap.done`, then marks
// them done, so `/nep warmup status` reports the same progress either way.
// `refreshPortrait()` is the stream analyzer's "the stored portrait misses
// something" cue (src/memory/update.js's `onPortraitRequest`), rewriting only
// `character`/`style` from a fresh sample. A missing `prompts.profile` /
// `prompts.channel` / `prompts.server` is reported (and logged), never thrown
// through to discord.js. An in-memory-only `activity` snapshot (`{ phase,
// detail, lastActivityAt }`, never persisted) tracks what a run is doing
// right now -- fetching history, describing a channel, profiling a person
// (with a chunk count when its sample does not fit one request), building
// the server notes, waiting out a provider rate limit, paused, finished or
// aborted -- exposed through `status()` for `/nep warmup status`.

import { readableChannels, fetchHistoryWindow } from '../discord/collect.js';
import { formatTranscript, renderTranscript } from '../discord/format.js';
import { fitSections, SectionsTooLargeError } from '../llm/budget.js';
import { estimateTokens, estimateMessages } from '../llm/tokens.js';
import { parseJsonObject } from '../llm/parse.js';
import { applyMemoryUpdate, characterText } from './update.js';
import { topByRank } from './ranking.js';
import { clampText } from './clamp.js';
import { normalizeTopic } from './interests.js';
import { toTokens, fromTokens } from './mentions.js';
import { log } from '../log.js';

const CACHE_TTL_MS = 15 * 60_000;

/** `err?.statusCode === 429` — the one rate-limit signal src/llm/openrouter.js#complete surfaces
 * (it already retries a 429 a couple of times itself; this is for the SUSTAINED case where the
 * provider keeps refusing across the retries too). */
function isRateLimited(err) {
  return err?.statusCode === 429;
}

/** `error?.message`, trimmed to 200 chars — never message contents. */
function detailOf(err) {
  return err?.message ? String(err.message).slice(0, 200) : undefined;
}

/**
 * Whether a completion looks cut off by the output token cap: the provider
 * said so (`finish_reason: 'length'`), or the text has no closing `}` for
 * its first `{`. Mirrors src/memory/update.js#looksTruncated (kept local:
 * this module's helpers are deliberately not shared with the stream
 * analyzer's, only the small validated surface it needs is imported).
 */
function looksTruncated(text, finishReason) {
  if (finishReason === 'length') return true;
  const start = String(text ?? '').indexOf('{');
  if (start === -1) return false;
  const end = String(text ?? '').lastIndexOf('}');
  return end <= start;
}

// Fallbacks for the profile-prompt placeholders, mirroring config.json's own
// defaults -- used only when a deployment's config is missing the key. Kept
// separate from src/memory/update.js's own MEMORY_LIMIT_DEFAULTS so this
// module never has to import from it (its shape is not otherwise shared).
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
// src/memory/update.js, whose internals are off-limits to this task, except
// `characterText` -- the one helper the two modules deliberately share, so a
// `/nep rule add` reaches every `<character>` block the same way it reaches
// the chat prompt).
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
 * nothing in `windows` at all. Used by `/nep warmup users user:<member>` to report on exactly the
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
 * Build one `channel.md` request. Pure, mirrors the per-chunk request `processPerson` builds for
 * `profile.md` inline (see its own header comment).
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

/**
 * The `{{fieldChars}}`/`{{maxInjokes}}`/`{{loreTextChars}}` placeholders `prompts.server` may use.
 * @param {object} config  Live config.
 * @param {string} selfName
 */
function serverTemplateValues(config, selfName) {
  const memoryCfg = config?.memory ?? {};
  return {
    name: selfName,
    fieldChars: memoryCfg.fieldChars ?? BOOTSTRAP_LIMIT_DEFAULTS.fieldChars,
    maxInjokes: memoryCfg.maxInjokes ?? 15,
    loreTextChars: config?.lore?.textChars ?? 400,
  };
}

/** Validate and clamp the model's `server.md` JSON. Never `null` -- an empty/garbage answer just
 * yields empty fields, since a server-level write only ever ADDS what is non-empty (see
 * store.updateGuild/store.setLore). */
export function clampServerResult(raw, config, nameOf = () => null) {
  const memoryCfg = config?.memory ?? {};
  const tolerance = memoryCfg.clampTolerance;
  const fieldChars = memoryCfg.fieldChars ?? BOOTSTRAP_LIMIT_DEFAULTS.fieldChars;
  const maxInjokes = memoryCfg.maxInjokes ?? 15;
  const loreTextChars = config?.lore?.textChars ?? 400;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { patterns: '', starters: '', injokes: [], lore: [] };

  const tokenize = makeTokenizer(nameOf);
  const resolve = (text, limit) => clampResolvedField(text, limit, tolerance, tokenize, nameOf);

  const patterns = resolve(raw.patterns, fieldChars * 2);
  const starters = resolve(raw.starters, fieldChars * 2);
  const injokes = (Array.isArray(raw.injokes) ? raw.injokes : [])
    .map((s) => (typeof s === 'string' ? clampText(tokenize(s), 200, { tolerance }) : ''))
    .filter(Boolean)
    .slice(0, maxInjokes);

  const lore = (Array.isArray(raw.lore) ? raw.lore : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 80) : '';
      if (!title) return null;
      const keys = Array.isArray(entry.keys) ? entry.keys.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()) : [];
      const text = resolve(entry.text, loreTextChars);
      return { title, keys, text };
    })
    .filter(Boolean);

  return { patterns, starters, injokes, lore };
}

/**
 * Greedily take the longest PREFIX of `items` (already in the order they must be sent, typically
 * chronological) whose costs sum to at most `budget` -- the opposite of `fitNewest` above, which
 * drops the oldest to fit ONE request; this instead leaves the rest for a FOLLOWING request, so a
 * member's sample that does not fit in one request is cut into the fewest chronological chunks
 * that do (docs/prompt-contract.md, "The bootstrap"). Always takes at least one item when
 * `items` is non-empty, even if that single item alone exceeds `budget` -- progress must be made;
 * the resulting request may then exceed the cap for that one oversized item, an edge case rather
 * than the common path. Pure.
 * @param {object[]} items
 * @param {number} budget
 * @param {(item: object) => number} cost
 * @returns {{ taken: object[], rest: object[] }}
 */
export function takeFittingPrefix(items, budget, cost) {
  if (!Array.isArray(items) || items.length === 0) return { taken: [], rest: [] };
  let used = 0;
  let count = 0;
  for (; count < items.length; count += 1) {
    const c = cost(items[count]);
    if (count > 0 && used + c > budget) break;
    used += c;
  }
  if (count === 0) count = 1;
  return { taken: items.slice(0, count), rest: items.slice(count) };
}

/** How many `takeFittingPrefix` calls it takes to exhaust `items` under `budget` -- a display-only
 * estimate for the bootstrap's own progress reporting (a person's `activity.detail.chunk`), using
 * the SAME budget for every future chunk even though a later chunk's fixed blocks (the `<draft>`)
 * may shrink it slightly; harmless since it is recomputed fresh on every chunk. Pure. */
function countChunks(items, budget, cost) {
  let rest = items;
  let count = 0;
  while (rest.length > 0) {
    ({ rest } = takeFittingPrefix(rest, budget, cost));
    count += 1;
  }
  return count;
}

/**
 * The per-iteration `users.<id>` op payloads that write one `profile.md` answer through
 * src/memory/update.js#applyMemoryUpdate -- reused so every existing clamp/token/eviction/
 * confirmation rule applies for free (docs/prompt-contract.md, "The bootstrap").
 *
 * `character`/`style`/`aliases`/`episodes` are written once, on the first iteration. `interests`/
 * `details` need their stored WEIGHT to land exactly on the answer's `times` (1..5) -- since one
 * `applyMemoryUpdate` call only ever bumps an item's weight by 1 (one sighting per call, see
 * src/memory/interests.js), this returns `max(times)` iterations; an item with `times: T` is
 * included in the first `T` of them, so after all iterations run (each a fresh "sighting" of the
 * SAME item) its stored weight is exactly `T`. Pure: returns iteration payloads, touches nothing.
 * @param {{ character?: string, style?: string, interests?: {topic:string,note:string,times:number}[],
 *   details?: {text:string,times:number}[], episodes?: object[], aliases?: string[] }} answer  From
 *   `clampProfileResult`.
 * @returns {object[]} `ops` objects, each suitable as `update.users.<id>` for `applyMemoryUpdate`.
 */
export function buildPersonWriteIterations(answer) {
  const interests = Array.isArray(answer?.interests) ? answer.interests : [];
  const details = Array.isArray(answer?.details) ? answer.details : [];
  const times = [1, ...interests.map((it) => it.times ?? 1), ...details.map((d) => d.times ?? 1)];
  const maxTimes = Math.max(...times);

  const iterations = [];
  for (let i = 1; i <= maxTimes; i += 1) {
    const ops = {};
    const interestAdd = interests.filter((it) => (it.times ?? 1) >= i).map((it) => ({ topic: it.topic, note: it.note }));
    if (interestAdd.length > 0) ops.interests = { add: interestAdd };
    const detailAdd = details.filter((d) => (d.times ?? 1) >= i).map((d) => d.text);
    if (detailAdd.length > 0) ops.details = detailAdd;
    if (i === 1) {
      if (typeof answer?.character === 'string' && answer.character) ops.character = answer.character;
      if (typeof answer?.style === 'string' && answer.style) ops.style = answer.style;
      if (Array.isArray(answer?.aliases) && answer.aliases.length > 0) ops.aliases = { add: answer.aliases };
      if (Array.isArray(answer?.episodes) && answer.episodes.length > 0) ops.episodes = answer.episodes;
    }
    if (Object.keys(ops).length > 0) iterations.push(ops);
  }
  return iterations;
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

/** The state.json shape this module owns (see docs/prompt-contract.md, "The bootstrap"),
 * created and self-healed in place -- garbage left by an old shape never crashes a read. */
function bootstrapState(store) {
  const data = store.state.data;
  if (!data.bootstrap || typeof data.bootstrap !== 'object' || Array.isArray(data.bootstrap)) {
    data.bootstrap = {};
  }
  const bs = data.bootstrap;
  if (typeof bs.startedAt !== 'string') bs.startedAt = null;
  if (typeof bs.finishedAt !== 'string') bs.finishedAt = null;
  if (!Number.isFinite(bs.tokensUsed)) bs.tokensUsed = 0;
  if (!Number.isFinite(bs.requests)) bs.requests = 0;
  if (!bs.done || typeof bs.done !== 'object' || Array.isArray(bs.done)) bs.done = {};
  if (!Array.isArray(bs.done.channels)) bs.done.channels = [];
  if (!Array.isArray(bs.done.people)) bs.done.people = [];
  if (typeof bs.done.server !== 'boolean') bs.done.server = false;
  if (bs.aborted !== null && typeof bs.aborted !== 'string') bs.aborted = null;
  if (typeof bs.refreshDay !== 'string') bs.refreshDay = null;
  if (!Number.isFinite(bs.refreshCount)) bs.refreshCount = 0;
  return bs;
}

/**
 * @param {object} deps
 * @param {object} deps.hot       Live config + prompts; read at the moment of use.
 * @param {object} deps.store     From createStore() (src/memory/store.js).
 * @param {import('discord.js').Client} deps.client
 * @param {object} deps.llm       From createLlm() (src/llm/openrouter.js).
 * @param {object} deps.calibrator  From createCalibrator().
 * @param {(guildId: string) => string} deps.getSelfName
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]  Used only for a sustained-rate-limit wait
 *   (`bootstrap.rateLimitWaitMinutes`) -- injectable so tests never actually sleep.
 */
export function createBootstrap({ hot, store, client, llm, calibrator, getSelfName, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const cache = new Map(); // guildId -> { fetchedAt, windows }
  let running = false; // a full run() or one-off runXxx() in flight -- see isBootstrapping()
  let idleWaiters = []; // resolvers for waitIdle(), notified once running goes back to false
  let consecutiveFailures = 0; // resets on any successful request; 3 in a row aborts the run (resumable)
  let stopRequested = false; // /nep warmup stop -- see `stop()` and run()'s own checkpoints
  let currentAbort = null; // the AbortController for whichever model call is in flight right now
  // (callWithRails), or null between calls -- `stop()` aborts it so the request itself is cancelled,
  // not just the loop stopped after it finishes.

  // In-memory-only run activity: exposed via status() as `activity` so `/nep warmup
  // status` can show WHICH phase a run is actually in right now (fetching history, describing a
  // channel, profiling a person, building the server notes, waiting out a provider rate limit,
  // paused, finished, aborted) instead of just "running" for minutes at a time, and progress
  // fields staying "?"/"-" while the windows cache is still being filled. Never persisted, never
  // read back, never affects the run itself -- a fresh factory always starts at `idle`.
  function freshActivity() {
    return { phase: 'idle', detail: null, lastActivityAt: null };
  }
  let activity = freshActivity();

  /** Replace the activity snapshot with `phase`/`detail` plus a fresh `lastActivityAt`. */
  function touchActivity(phase, detail = null) {
    activity = { phase, detail, lastActivityAt: now() };
  }

  /** Bump `lastActivityAt` without changing the current phase/detail (a completed request). */
  function bumpActivity() {
    activity = { ...activity, lastActivityAt: now() };
  }

  /** (Re-)fetch every readable channel's window, sequentially -- see the module header;
   * `bootstrap.lookbackDays`/`fetchLimitPerChannel` are read fresh, never cached. */
  async function fetchGuildWindows(guild, cfg) {
    const channels = readableChannels(guild, hot.config.bot);
    const minTs = now() - (cfg.lookbackDays ?? 60) * 24 * 60 * 60_000;
    const selfId = client.user?.id;
    const windows = [];
    touchActivity('fetching', { channelsFetched: 0, channelsTotal: channels.length });
    for (let i = 0; i < channels.length; i += 1) {
      const channel = channels[i];
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
      windows.push({ id: channel.id, name: channel.name, category: channel.parent?.name ?? null, topic: channel.topic ?? null, messages, channel });
      touchActivity('fetching', { channelsFetched: i + 1, channelsTotal: channels.length });
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

  /** `/nep warmup people`: who currently qualifies, plus totals. Never calls the model. */
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

  // -------------------------------------------------------------------
  // Write path: run() / runXxx() / refreshPortrait() -- see the module header.
  // -------------------------------------------------------------------

  function notifyIdle() {
    if (running) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves once no run()/runXxx() is in flight -- immediately if that is already true. Used by
   * `/nep pause` (src/admin.js), the same shape as src/memory/update.js#createMemoryUpdater's own
   * `waitIdle`. */
  function waitIdle() {
    return running ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
  }

  function isBootstrapping() {
    return running;
  }

  /** `/nep warmup stop`: ENDS any warmup work for good, not just after the request in
   * flight -- sets `stopRequested`, which the same checkpoints in `run()`/`startBulk()` that
   * already honour `store.state.data.paused` also check before starting a new target, AND aborts
   * the model call for the target actually in flight right now (`currentAbort`, see
   * `callWithRails`), so no further tokens are spent past this moment and nothing partial is
   * written for that target (activity ends up `stopped`, progress kept, nothing marks
   * `state.bootstrap` aborted). Every entry point (`run()`, `runOneTarget()`, `startBulk()`) clears
   * the flag again on its own next start. A no-op, reported as such, when no run is in flight. */
  function stop() {
    if (!running) return { ok: false };
    stopRequested = true;
    currentAbort?.abort();
    return { ok: true };
  }

  function markDone(kind, id) {
    const bs = bootstrapState(store);
    if (kind === 'server') {
      bs.done.server = true;
    } else if (!bs.done[kind].includes(id)) {
      bs.done[kind].push(id);
    }
    store.state.markDirty();
    store.flush();
  }

  /** `config` with `llm.maxRequestTokens` overridden to `cfg.maxRequestTokens` (the bootstrap's own,
   * much larger, cap) -- so buildChannelRequest fits under IT, not the global
   * per-request rail (docs/prompt-contract.md, "The bootstrap"). */
  function requestConfigFor(cfg) {
    return { ...hot.config, llm: { ...hot.config.llm, maxRequestTokens: cfg.maxRequestTokens ?? hot.config.llm?.maxRequestTokens } };
  }

  function bootstrapRequestCap(cfg) {
    return Math.floor((cfg.maxRequestTokens ?? 120000) * (hot.config.llm?.safetyMargin ?? 0.9));
  }

  /**
   * One analyzer-role call, with every bootstrap rail applied: the token budget
   * (`bootstrap.maxTokens`, a "stop here, resumable" outcome, never a throw), the per-request cap
   * override, a sustained-429 wait (`rateLimitWaitMinutes` × up to `rateLimitMaxWaits`, then abort,
   * resumable), and the 3-consecutive-other-failures abort. Progress (`tokensUsed`/`requests`) is
   * persisted after every completed request. Never throws: every outcome is reported.
   * @returns {Promise<{ ok: true, completion: object } | { ok: false, stop?: boolean, reason: string, error?: Error }>}
   */
  async function callWithRails(messages, cfg) {
    const bs = bootstrapState(store);
    const estimate = calibrator.apply(estimateMessages(messages));
    const maxTokens = Number.isFinite(cfg.maxTokens) ? cfg.maxTokens : Infinity;
    if (bs.tokensUsed + estimate > maxTokens) {
      log.info('bootstrap: token budget reached, stopping the run (resumable)', { tokensUsed: bs.tokensUsed, estimate, maxTokens });
      bs.aborted = 'budget';
      store.state.markDirty();
      store.flush();
      touchActivity('aborted', { reason: 'budget' });
      return { ok: false, stop: true, reason: 'budget' };
    }

    let waits = 0;
    for (;;) {
      // Honour a stop requested while this target was queued (e.g. between rate-limit waits,
      // or a fresh chunk of the same person's sample) before spending a request on it at all.
      if (stopRequested) {
        touchActivity('stopped');
        return { ok: false, stop: true, reason: 'stopped' };
      }

      let completion;
      const controller = new AbortController();
      currentAbort = controller;
      try {
        completion = await llm.complete(messages, {
          model: hot.config.memory?.model ?? hot.config.llm?.model,
          maxOutputTokens: cfg.maxOutputTokens ?? 6000,
          maxRequestTokens: bootstrapRequestCap(cfg),
          countAgainstDailyCap: false,
          timeoutMs: hot.config.memory?.timeoutMs ?? hot.config.llm?.timeoutMs,
          signal: controller.signal,
        });
      } catch (err) {
        currentAbort = null;
        // /nep warmup stop aborted THIS call -- report it as a clean stop, never a failure
        // (never retried, never counted towards the 3-consecutive-failures abort).
        if (stopRequested) {
          log.info('bootstrap: the in-flight request was cancelled by /nep warmup stop', {});
          touchActivity('stopped');
          return { ok: false, stop: true, reason: 'stopped' };
        }
        if (isRateLimited(err)) {
          waits += 1;
          const maxWaits = Number.isFinite(cfg.rateLimitMaxWaits) ? cfg.rateLimitMaxWaits : 36;
          if (waits > maxWaits) {
            log.warn('bootstrap: rate limit outlasted the wait budget, aborting the run (resumable)', { waits });
            bs.aborted = 'rate-limit';
            store.state.markDirty();
            store.flush();
            touchActivity('aborted', { reason: 'rate-limit' });
            return { ok: false, stop: true, reason: 'rate-limit' };
          }
          log.warn('bootstrap: rate limited, waiting before retrying', { attempt: waits, waitMinutes: cfg.rateLimitWaitMinutes ?? 10 });
          const waitMs = (cfg.rateLimitWaitMinutes ?? 10) * 60_000;
          touchActivity('waiting-rate-limit', { until: now() + waitMs, waits });
          await sleep(waitMs);
          continue;
        }

        consecutiveFailures += 1;
        log.warn('bootstrap: request failed', { detail: detailOf(err), consecutiveFailures });
        if (consecutiveFailures >= 3) {
          log.warn('bootstrap: three consecutive failures, aborting the run (resumable)');
          bs.aborted = 'failures';
          store.state.markDirty();
          store.flush();
          touchActivity('aborted', { reason: 'failures' });
          return { ok: false, stop: true, reason: 'failures', error: err };
        }
        return { ok: false, stop: false, reason: 'llm-error', error: err };
      }

      currentAbort = null;
      consecutiveFailures = 0;
      bs.tokensUsed += completion.usage?.total_tokens ?? completion.estimated ?? estimate;
      bs.requests += 1;
      store.state.markDirty();
      store.flush();
      bumpActivity();
      return { ok: true, completion };
    }
  }

  /** A fresh 30-newest-UTC-date histogram of `messages` -- mirrors src/memory/store.js's own
   * (private) `trimDays`, computed once from the whole window instead of accumulated incrementally;
   * the highest date key present is always the newest message's date, so trimming to the newest 30
   * KEYS is the same as trimming "relative to the newest message". Pure. */
  function dayHistogram(messages) {
    const days = {};
    for (const message of messages ?? []) {
      if (!Number.isFinite(message?.ts)) continue;
      const key = new Date(message.ts).toISOString().slice(0, 10);
      days[key] = (days[key] ?? 0) + 1;
    }
    const keys = Object.keys(days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - 30))) delete days[key];
    return days;
  }

  /** Up to 5 `{ id, count }` of who wrote most in `messages`, most active first -- bots and the
   * persona's own messages excluded, same as `collectAuthorStats` above. Pure. */
  function topWritersOf(messages) {
    const counts = new Map();
    for (const message of messages ?? []) {
      if (message?.bot || message?.self) continue;
      const id = String(message.authorId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
      .slice(0, 5);
  }

  /** The `store.setChannelFacts` payload for one channel, from the messages it actually had
   * (`messages` -- the deeper-fetched set when `processChannel` used one): count, min/max ts, a
   * fresh 30-day histogram and the top 5 writers. Zeros and empty lists when the channel had no
   * messages at all. Pure. */
  function channelFactsFromMessages(window, messages) {
    const list = messages ?? [];
    const timestamps = list.map((m) => m.ts).filter(Number.isFinite);
    return {
      name: window.name,
      category: window.category,
      topic: window.topic,
      messageCount: list.length,
      firstMessageAt: timestamps.length ? Math.min(...timestamps) : null,
      lastMessageAt: timestamps.length ? Math.max(...timestamps) : null,
      days: dayHistogram(list),
      topWriters: topWritersOf(list),
    };
  }

  /** Sets `messageCount`/`firstSeen`/`lastSeen`/`names` on the stored profile FROM the fetched
   * window (`member`, see pickPeople/memberStats: `messages` = count in the window, `firstTs`/
   * `lastTs` = min/max, `name` = the newest nick) -- SET, never added, so a redo (`/nep warmup
   * users`, with or without `user:<member>`, reprocessing an already-profiled member) lands on the
   * same counters as a first write instead of doubling them (unlike src/memory/store.js#touchUser,
   * built for the live pipeline's one-message-at-a-time calls, which this deliberately does NOT use
   * here). */
  function touchUserFromWindows(guildId, member) {
    const existing = store.getUser(guildId, member.id);
    const names = existing?.names?.length
      ? [member.name, ...existing.names.filter((n) => n !== member.name)].slice(0, 5)
      : [member.name];
    store.updateUser(guildId, member.id, {
      names,
      firstSeen: new Date(member.firstTs).toISOString(),
      lastSeen: new Date(member.lastTs).toISOString(),
      messageCount: member.messages,
    });
  }

  /** Writes one `profile.md` answer for `member` through applyMemoryUpdate (see
   * `buildPersonWriteIterations`) -- attitude/relationship untouched. */
  function writePersonAnswer(guildId, member, answer) {
    touchUserFromWindows(guildId, member);

    const knownUserIds = new Set([String(member.id)]);
    const batchAuthorNames = new Map([[String(member.id), member.name]]);
    const seenAt = Number.isFinite(member.lastTs) ? member.lastTs : now();
    const timing = { seenAtByUser: new Map([[String(member.id), seenAt]]), seenAt };
    const cfgForOps = { ...hot.config.memory, confirmGapHours: 0 };
    const episodesCfg = { enabled: true, maxEpisodes: hot.config.memory?.maxEpisodes, maxNew: Infinity, now: seenAt };

    const iterations = buildPersonWriteIterations(answer);
    for (const ops of iterations) {
      applyMemoryUpdate(
        store,
        guildId,
        { users: { [member.id]: ops } },
        cfgForOps,
        knownUserIds,
        new Set(),
        undefined, // relationships/affinity: untouched by the bootstrap
        episodesCfg,
        undefined, // lore: not a per-person field
        timing,
        batchAuthorNames,
      );
    }
    store.flush();
    return { iterations: iterations.length };
  }

  /** One channel → `channel.md` → `store.updateChannel`. See `callWithRails` for the stop/failure
   * contract; `{ ok: true }` on a clean write, marks the channel done either way it succeeds.
   * `progress` (`{ index, total }`, both 1-based/count, optional) is this channel's position among
   * the run's eligible channels -- purely for `activity.detail`, a one-off `/nep warmup channels
   * channel:` call omits it. */
  async function processChannel(guildId, window, cfg, mainChannelIds, progress) {
    touchActivity('channel', { id: window.id, name: window.name, index: progress?.index ?? null, total: progress?.total ?? null });
    if (!hot.prompts?.channel) {
      return { ok: false, stop: true, reason: 'missing-prompt', message: 'prompt file missing: prompts/channel.md (or prompts.local/channel.md) is not configured yet' };
    }
    const isMain = mainChannelIds.has(String(window.id));
    // A channel quiet in the lookback window is described from its newest messages regardless of
    // age (a diary or a topical channel must be on the map before it wakes up); a channel with no
    // history at all is described from its name, category and topic alone.
    let source = window.messages;
    const wanted = cfg.messagesPerChannel ?? 200;
    if (source.length < wanted && window.channel) {
      try {
        source = await fetchHistoryWindow(window.channel, { limit: wanted, minTs: 0, selfId: client.user?.id, embedTextChars: hot.config.media?.embedTextChars });
        log.info('bootstrap: quiet channel fetched deeper', { channel: window.id, messages: source.length });
      } catch (err) {
        log.warn('bootstrap: deeper fetch failed, describing from the window', { channel: window.id, error: err });
      }
    }
    const selected = selectChannelMessages(source, cfg.messagesPerChannel);
    const selfName = getSelfName(guildId);

    let built;
    try {
      built = buildChannelRequest({ prompts: hot.prompts, config: requestConfigFor(cfg), calibrator, channel: window, messages: selected, isMain, selfName });
    } catch (err) {
      if (err instanceof SectionsTooLargeError) {
        log.warn('bootstrap: channel request does not fit even the minimum, skipping this round', { channel: window.id });
        return { ok: false };
      }
      throw err;
    }

    const result = await callWithRails(built.messages, cfg);
    if (!result.ok) return result;

    let parsed;
    try {
      parsed = parseJsonObject(result.completion.text);
    } catch (err) {
      log.warn('bootstrap: channel answer could not be parsed, will retry next run', { channel: window.id, detail: detailOf(err) });
      return { ok: false };
    }

    const clamped = clampChannelResult(parsed, hot.config) ?? { purpose: '', topics: '', tone: '' };
    store.updateChannel(guildId, window.id, clamped);
    // A channel note without its counters/top writers looks dead and
    // anonymous until live traffic slowly fills them in (see the module
    // header and docs/prompt-contract.md) -- fill them now from the
    // same messages the note itself was written from.
    const facts = channelFactsFromMessages(window, source);
    store.setChannelFacts(guildId, window.id, facts);
    markDone('channels', window.id);
    return { ok: true, channel: { id: window.id, name: window.name }, result: clamped, facts };
  }

  /** One person → `profile.md`, chunked chronologically when the sample does not fit one request
   * (each chunk after the first carries the previous answer as `<draft>`) → the store, via
   * `writePersonAnswer`. See `callWithRails` for the stop/failure contract. A bad-json/truncated
   * answer is retried once with half the sample; a second failure skips (and marks done) this
   * person. `progress` (`{ index, total }`, optional) is this person's position among the run's
   * eligible people, carried through the half-sample retry -- purely for `activity.detail`, a
   * one-off `/nep warmup users user:` call omits it. */
  async function processPerson(guildId, windows, member, cfg, mainChannelIds, sampleCfgOverride, progress) {
    touchActivity('person', { id: member.id, name: member.name, index: progress?.index ?? null, total: progress?.total ?? null, chunk: null });
    if (!hot.prompts?.profile) {
      return { ok: false, stop: true, reason: 'missing-prompt', message: 'prompt file missing: prompts/profile.md (or prompts.local/profile.md) is not configured yet' };
    }
    const sampleCfg = sampleCfgOverride ?? cfg;
    const sample = sampleMember(windows, member.id, sampleCfg, mainChannelIds);
    if (sample.messages.length === 0) {
      markDone('people', member.id);
      return { ok: false, skipped: true, reason: 'nothing-to-sample' };
    }

    const selfName = getSelfName(guildId);
    const labels = hot.prompts.labels ?? {};
    const timezone = hot.config.bot?.timezone ?? 'UTC';
    const formatOptions = {
      timezone,
      gapMinutes: hot.config.context?.gapMarkerMinutes ?? 20,
      maxChars: hot.config.context?.maxMessageChars ?? 800,
      selfName,
      mode: 'memory',
      labels,
    };
    const items = markOwnContext(formatTranscript(sample.messages, formatOptions), sample.ownIds, labels);

    const limit = bootstrapRequestCap(cfg);
    const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
    const system = fillTemplate(hot.prompts.profile, profileTemplateValues(hot.config, selfName));
    const characterBlock = block('character', characterText(hot.prompts, selfName));
    const memberLine = `${member.name} (id:${member.id}), ${member.messages} messages in the window, first ${isoDateOrDash(member.firstTs)}, last ${isoDateOrDash(member.lastTs)}`;
    const memberBlock = block('member', memberLine);
    const nameOf = buildNameIndex(windows);

    let remaining = items;
    let draft = null;
    let answer = null;
    let chunksDone = 0; // completed chunks so far -- feeds the "chunk k/n" detail below
    let tokensUsed = 0; // summed across every chunk -- surfaced to `/nep warmup users user:<member>`'s reply

    while (remaining.length > 0) {
      if (store.state.data.paused) {
        touchActivity('paused');
        return { ok: false, stop: true, reason: 'paused' };
      }

      const draftBlock = draft ? block('draft', JSON.stringify(draft)) : '';
      const fixedTexts = [system, characterBlock, memberBlock, draftBlock].filter(Boolean);
      const fixedCost = fixedTexts.reduce((sum, text) => sum + cost(text), 0);
      const budget = limit - fixedCost;
      if (budget <= 0) {
        log.warn('bootstrap: the fixed profile blocks alone exceed the request cap, skipping this person', { member: member.id });
        return { ok: false, skipped: true };
      }

      const itemCost = (item) => cost(item.text);
      // Display-only: how many chunks THIS person's sample takes in total, estimated fresh on every
      // chunk (see countChunks) -- only shown once it is actually more than one.
      const chunksEstimate = chunksDone + countChunks(remaining, budget, itemCost);
      const chunk = chunksEstimate > 1 ? { k: chunksDone + 1, n: chunksEstimate } : null;
      touchActivity('person', { id: member.id, name: member.name, index: progress?.index ?? null, total: progress?.total ?? null, chunk });

      const { taken, rest } = takeFittingPrefix(remaining, budget, itemCost);
      remaining = rest;
      chunksDone += 1;
      const snippetsBlock = block('snippets', renderTranscript(taken, timezone, labels));
      const user = [characterBlock, memberBlock, draftBlock, snippetsBlock].filter(Boolean).join('\n\n');
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      const result = await callWithRails(messages, cfg);
      if (!result.ok) {
        if (result.stop) return result;
        return { ok: false }; // llm-error, not (yet) a run-aborting streak -- retry this person next run
      }
      tokensUsed += result.completion.usage?.total_tokens ?? result.completion.estimated ?? 0;

      let parsed;
      try {
        parsed = parseJsonObject(result.completion.text);
      } catch (err) {
        if (!sampleCfgOverride) {
          const truncated = looksTruncated(result.completion.text, result.completion.finishReason);
          const halved = { ...cfg, messagesPerPerson: Math.max(1, Math.floor((sampleCfg.messagesPerPerson ?? sample.messages.length) / 2)) };
          log.warn('bootstrap: person answer could not be parsed, retrying with half the sample', { member: member.id, truncated, detail: detailOf(err) });
          return processPerson(guildId, windows, member, halved, mainChannelIds, halved, progress);
        }
        log.warn('bootstrap: person answer still bad after a retry, skipping this person', { member: member.id, detail: detailOf(err) });
        markDone('people', member.id);
        return { ok: false, skipped: true };
      }

      const clamped = clampProfileResult(parsed, hot.config, nameOf);
      draft = clamped;
      answer = clamped;
    }

    writePersonAnswer(guildId, member, answer ?? { character: '', style: '', interests: [], details: [], episodes: [], aliases: [] });
    markDone('people', member.id);
    return {
      ok: true,
      member,
      answer,
      sample: { ownCount: sample.ownCount, contextCount: sample.contextCount },
      tokensUsed,
      chunks: chunksDone,
    };
  }

  /** The server-wide `server.md` request: `<channels>` = stored channel notes, `<members>` = one
   * line per profiled member, `<messages>` = newest `serverSampleMessages` of the main channels (or
   * the single busiest channel when none is marked main) → `store.updateGuild`/`store.setLore`. */
  async function processServer(guildId, windows, cfg, mainChannelIds, people) {
    touchActivity('server');
    if (!hot.prompts?.server) {
      return { ok: false, stop: true, reason: 'missing-prompt', message: 'prompt file missing: prompts/server.md (or prompts.local/server.md) is not configured yet' };
    }
    const selfName = getSelfName(guildId);
    const labels = hot.prompts.labels ?? {};
    const timezone = hot.config.bot?.timezone ?? 'UTC';

    const system = fillTemplate(hot.prompts.server, serverTemplateValues(hot.config, selfName));
    const characterBlock = block('character', characterText(hot.prompts, selfName));

    const channelsView = {};
    for (const window of windows) {
      const stored = store.getChannel(guildId, window.id);
      channelsView[window.id] = {
        name: stored?.name || window.name,
        category: stored?.category ?? window.category,
        topic: stored?.topic ?? window.topic,
        purpose: stored?.purpose ?? '',
        topics: stored?.topics ?? '',
        tone: stored?.tone ?? '',
      };
    }
    const channelsBlock = block('channels', JSON.stringify(channelsView));

    const memberLines = people.map((person) => {
      const profile = store.getUser(guildId, person.id);
      const character = String(profile?.character ?? '').slice(0, 150);
      const topInterests = topByRank(profile?.interests ?? [], 5).map((it) => it.topic);
      const interestsPart = topInterests.length > 0 ? ` | interests: ${topInterests.join(', ')}` : '';
      return `${person.name} (id:${person.id}): ${character}${interestsPart}`;
    });
    const membersBlock = block('members', memberLines.join('\n'));

    const mainWindows = windows.filter((window) => mainChannelIds.has(String(window.id)));
    const sourceWindows = mainWindows.length > 0 ? mainWindows : [...windows].sort((a, b) => b.messages.length - a.messages.length).slice(0, 1);
    const pooled = sourceWindows.flatMap((window) => window.messages).sort((a, b) => a.ts - b.ts);
    const newest = selectChannelMessages(pooled, cfg.serverSampleMessages);
    const formatOptions = {
      timezone,
      gapMinutes: hot.config.context?.gapMarkerMinutes ?? 20,
      maxChars: hot.config.context?.maxMessageChars ?? 800,
      selfName,
      mode: 'memory',
      labels,
    };
    const items = formatTranscript(newest, formatOptions);
    const messagesBlock = block('messages', renderTranscript(items, timezone, labels));

    const user = [characterBlock, channelsBlock, membersBlock, messagesBlock].filter(Boolean).join('\n\n');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    const result = await callWithRails(messages, cfg);
    if (!result.ok) return result;

    let parsed;
    try {
      parsed = parseJsonObject(result.completion.text);
    } catch (err) {
      log.warn('bootstrap: server answer could not be parsed, will retry next run', { detail: detailOf(err) });
      return { ok: false };
    }

    const nameOf = buildNameIndex(windows);
    const clamped = clampServerResult(parsed, hot.config, nameOf);
    store.updateGuild(guildId, { patterns: clamped.patterns, starters: clamped.starters, injokes: clamped.injokes });
    if (clamped.lore.length > 0) {
      store.setLore(guildId, clamped.lore, {
        source: 'analyzer',
        now: now(),
        maxEntries: hot.config.lore?.maxEntries,
        textChars: hot.config.lore?.textChars,
        clampTolerance: hot.config.memory?.clampTolerance,
      });
    }
    markDone('server');
    return {
      ok: true,
      counts: {
        patternsChars: clamped.patterns.length,
        startersChars: clamped.starters.length,
        injokes: clamped.injokes.length,
        lore: clamped.lore.length,
      },
    };
  }

  /** The whole run, in order (channels → people → server), resuming whatever `state.bootstrap.done`
   * already covers. Stops (never throws) on: pause, a missing prompt file, the token budget, a
   * sustained rate limit, or three consecutive other failures -- all resumable by calling `run`
   * again. Refuses while another run/one-off target is already in flight. */
  async function run(guildId) {
    if (running) return { ok: false, message: 'a bootstrap run is already in flight' };
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    running = true;
    consecutiveFailures = 0;
    stopRequested = false;
    const bs = bootstrapState(store);
    if (!bs.startedAt) bs.startedAt = new Date(now()).toISOString();
    bs.finishedAt = null;
    bs.aborted = null;
    store.state.markDirty();
    store.flush();
    log.info('bootstrap: run starting', { guildId });

    try {
      const cfg = hot.config.bootstrap ?? {};
      const windows = await getWindows(guildId, guild, cfg);
      const mainChannelIds = new Set((hot.config.memory?.mainChannelIds ?? []).map(String));

      const eligibleChannels = windows; // every readable channel gets a note: the map must cover channels that may wake up later
      for (let i = 0; i < eligibleChannels.length; i += 1) {
        const window = eligibleChannels[i];
        if (store.state.data.paused) {
          touchActivity('paused');
          return { ok: false, message: 'paused' };
        }
        if (stopRequested) {
          touchActivity('stopped');
          return { ok: false, message: 'stopped' };
        }
        if (bs.done.channels.includes(window.id)) continue;
        const outcome = await processChannel(guildId, window, cfg, mainChannelIds, { index: i + 1, total: eligibleChannels.length });
        if (outcome.stop) return { ok: false, message: outcome.message ?? outcome.reason };
      }

      const people = pickPeople(windows, cfg);
      for (let i = 0; i < people.length; i += 1) {
        const person = people[i];
        if (store.state.data.paused) {
          touchActivity('paused');
          return { ok: false, message: 'paused' };
        }
        if (stopRequested) {
          touchActivity('stopped');
          return { ok: false, message: 'stopped' };
        }
        if (bs.done.people.includes(person.id)) continue;
        const outcome = await processPerson(guildId, windows, person, cfg, mainChannelIds, undefined, { index: i + 1, total: people.length });
        if (outcome.stop) return { ok: false, message: outcome.message ?? outcome.reason };
      }

      if (!bs.done.server) {
        if (store.state.data.paused) {
          touchActivity('paused');
          return { ok: false, message: 'paused' };
        }
        if (stopRequested) {
          touchActivity('stopped');
          return { ok: false, message: 'stopped' };
        }
        const outcome = await processServer(guildId, windows, cfg, mainChannelIds, people);
        if (outcome.stop) return { ok: false, message: outcome.message ?? outcome.reason };
      }

      bs.finishedAt = new Date(now()).toISOString();
      store.state.markDirty();
      store.flush();
      touchActivity('finished');
      log.info('bootstrap: run finished', { guildId, tokensUsed: bs.tokensUsed, requests: bs.requests });
      return { ok: true };
    } finally {
      running = false;
      notifyIdle();
    }
  }

  /** `/nep warmup users user:<member>` / `channels channel:<channel>` / `server`: (re)do exactly
   * one target right now, synchronously.
   * Refused while a run (full, another one-off, or a `users`/`channels` bulk redo) is already in
   * flight, or while paused. */
  async function runOneTarget(guildId, kind, id) {
    if (running) return { ok: false, message: 'a bootstrap run is already in flight' };
    if (store.state.data.paused) return { ok: false, message: 'paused -- run /nep resume first' };
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    running = true;
    consecutiveFailures = 0;
    stopRequested = false;
    try {
      const cfg = hot.config.bootstrap ?? {};
      const windows = await getWindows(guildId, guild, cfg);
      const mainChannelIds = new Set((hot.config.memory?.mainChannelIds ?? []).map(String));

      if (kind === 'channel') {
        const window = windows.find((w) => w.id === String(id));
        if (!window) return { ok: false, message: 'channel not found, not readable, or not in this guild' };
        const outcome = await processChannel(guildId, window, cfg, mainChannelIds);
        return outcome.ok ? { ok: true, outcome } : { ok: false, message: outcome.message ?? outcome.reason ?? 'failed', outcome };
      }
      if (kind === 'person') {
        const member = memberStats(windows, id);
        if (!member) return { ok: false, message: 'no messages in the window' };
        const outcome = await processPerson(guildId, windows, member, cfg, mainChannelIds);
        return outcome.ok ? { ok: true, outcome } : { ok: false, message: outcome.message ?? outcome.reason ?? 'failed', outcome };
      }
      if (kind === 'server') {
        const people = pickPeople(windows, cfg);
        const outcome = await processServer(guildId, windows, cfg, mainChannelIds, people);
        return outcome.ok ? { ok: true, outcome } : { ok: false, message: outcome.message ?? outcome.reason ?? 'failed', outcome };
      }
      return { ok: false, message: `unknown target: ${kind}` };
    } finally {
      running = false;
      notifyIdle();
    }
  }

  /**
   * `/nep warmup users`/`/nep warmup channels`: (re)do EVERY qualifying member (`pickPeople`)
   * or every readable channel now, sharing `running` (and so every rail: mute, pause/resume,
   * `state.bootstrap.done`) with `run()` -- a redo re-processes every target regardless of `done`,
   * then marks it done either way (processChannel/processPerson already do, idempotently). Resolves
   * once the target COUNT is known and the background loop has been started, NOT once the loop
   * itself finishes, so the caller can report "started N …" at once; progress from then on is
   * `/nep warmup status`'s job. Refused (before starting anything) while a run/one-off target is
   * already in flight, or while paused.
   * @param {string} guildId
   * @param {'people'|'channels'} kind
   */
  async function startBulk(guildId, kind) {
    if (running) return { ok: false, message: 'a bootstrap run is already in flight' };
    if (store.state.data.paused) return { ok: false, message: 'paused -- run /nep resume first' };
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    const cfg = hot.config.bootstrap ?? {};
    const windows = await getWindows(guildId, guild, cfg);
    const mainChannelIds = new Set((hot.config.memory?.mainChannelIds ?? []).map(String));
    const targets = kind === 'channels' ? windows : pickPeople(windows, cfg);
    if (targets.length === 0) return { ok: true, count: 0 };

    running = true;
    consecutiveFailures = 0;
    stopRequested = false;

    (async () => {
      try {
        for (let i = 0; i < targets.length; i += 1) {
          if (store.state.data.paused) {
            touchActivity('paused');
            return;
          }
          if (stopRequested) {
            touchActivity('stopped');
            return;
          }
          const outcome =
            kind === 'channels'
              ? await processChannel(guildId, targets[i], cfg, mainChannelIds, { index: i + 1, total: targets.length })
              : await processPerson(guildId, windows, targets[i], cfg, mainChannelIds, undefined, { index: i + 1, total: targets.length });
          if (outcome.stop) return;
        }
        touchActivity('finished');
      } catch (err) {
        log.error(`bootstrap: ${kind} redo failed`, { error: err });
      } finally {
        running = false;
        notifyIdle();
      }
    })();

    return { ok: true, count: targets.length };
  }

  /**
   * Start (nothing stored anywhere yet) or resume (a previous run began but never finished) a run,
   * automatically -- called once at startup (src/index.js) and safe to call again on every tick, a
   * no-op otherwise. Never awaited by the caller: fire-and-forget, errors logged.
   * @returns {boolean} true when a run was (re)started
   */
  function resumeIfNeeded(guildId) {
    if (hot.config.bootstrap?.enabled === false) return false;
    if (running || store.state.data.paused) return false;
    const bs = bootstrapState(store);
    const hasProgress = bs.done.channels.length > 0 || bs.done.people.length > 0 || bs.done.server;
    const unfinished = !bs.finishedAt && (Boolean(bs.startedAt) || hasProgress);
    const neverStarted = !bs.startedAt && store.listUserProfiles(guildId).length === 0;
    if (!unfinished && !neverStarted) return false;

    log.info('bootstrap: starting/resuming a run automatically', { guildId, unfinished, neverStarted });
    run(guildId).catch((err) => log.error('bootstrap: automatic run failed', { error: err }));
    return true;
  }

  /** Cheap, synchronous summary for `/nep status` -- never fetches Discord history. */
  function summary() {
    const bs = bootstrapState(store);
    return {
      running,
      startedAt: bs.startedAt,
      finishedAt: bs.finishedAt,
      tokensUsed: bs.tokensUsed,
      requests: bs.requests,
      doneChannels: bs.done.channels.length,
      donePeople: bs.done.people.length,
      doneServer: bs.done.server,
      aborted: bs.aborted,
    };
  }

  /** `/nep warmup status`: `summary()` plus totals, the next target and `activity` (this
   * module's own in-memory "what is it doing right now" snapshot -- see `touchActivity` above).
   * Synchronous, side-effect free, never fetches: the totals come from the windows cache when a
   * run or a recent command filled it, otherwise they are reported as unknown (null) -- `activity`
   * explains what is happening meanwhile (fetching history, and so on) so the command still answers
   * at once and still means something while the cache is still empty. */
  function status(guildId) {
    const bs = bootstrapState(store);
    const base = summary();
    let channelsEligible = null;
    let peopleEligible = null;
    let nextTarget = null;

    // Totals come from whatever windows were fetched last, however old: a run keeps working from
    // them long after the 15-minute refetch window, and a stale count beats a "?".
    const cached = cache.get(guildId);
    if (cached) {
      const cfg = hot.config.bootstrap ?? {};
      const windows = cached.windows;
      const eligibleChannels = windows; // every readable channel gets a note: the map must cover channels that may wake up later
      const people = pickPeople(windows, cfg);
      channelsEligible = eligibleChannels.length;
      peopleEligible = people.length;
      // "Next" means after the target in flight: the one being worked on is shown by the phase line.
      const inFlightId = activity.phase === 'channel' || activity.phase === 'person' ? String(activity.detail?.id ?? '') : '';
      const nextChannel = eligibleChannels.find((window) => !bs.done.channels.includes(window.id) && String(window.id) !== inFlightId);
      const nextPerson = people.find((person) => !bs.done.people.includes(person.id) && String(person.id) !== inFlightId);
      if (nextChannel) nextTarget = `channel: ${nextChannel.name} (id:${nextChannel.id})`;
      else if (nextPerson) nextTarget = `person: ${nextPerson.name} (id:${nextPerson.id})`;
      else if (!bs.done.server) nextTarget = 'server';
    }

    const phase = running ? 'running' : !base.startedAt ? 'not started' : base.finishedAt ? 'finished' : base.aborted ? `aborted (${base.aborted})` : 'idle';
    return { ...base, phase, channelsEligible, peopleEligible, nextTarget, activity: { ...activity }, stopRequested };
  }

  /** `/nep warmup reset`: clears `state.bootstrap` (progress only, never any profile/channel/
   * guild/lore data already written). Refused while a run is in flight. */
  function reset() {
    if (running) return { ok: false, message: 'a bootstrap run is in flight -- pause or wait for it first' };
    delete store.state.data.bootstrap;
    store.state.markDirty();
    store.flush();
    activity = freshActivity();
    return { ok: true };
  }

  /**
   * The stream analyzer's cue that a member's stored portrait misses or contradicts something
   * (src/memory/update.js's `onPortraitRequest`, docs/prompt-contract.md, "Data model"):
   * samples their newest `bootstrap.refreshMessages` own messages exactly like the bootstrap, calls
   * `profile.md` with `<draft>` = the stored character+style and `<hint>` = `reason`, and replaces
   * ONLY `character`/`style` from the answer -- interests/details/episodes/aliases of that answer
   * are ignored, they keep flowing through the stream analyzer's own ops. Rails: at most one refresh
   * per member per `memory.portraitRefreshHours` (skipped when `force` is false), at most
   * `memory.portraitRefreshPerDay` per server, never while a bootstrap run is in flight (queues
   * nothing, just logs and returns). Counts against the daily LLM request cap -- this is live
   * behaviour, not seeding.
   * @param {string} guildId
   * @param {string} userId
   * @param {string} [reason]  The analyzer's one-line cue, used as `<hint>`.
   * @param {{ force?: boolean }} [opts]  `force: true` (owner's `/nep memory refresh`) ignores the
   *   hours rail, never the daily cap.
   */
  async function refreshPortrait(guildId, userId, reason, { force = false } = {}) {
    if (running) {
      log.info('bootstrap: portrait refresh skipped, a bootstrap run is in flight', { userId });
      return { ok: false, reason: 'bootstrapping' };
    }
    if (store.state.data.paused) return { ok: false, reason: 'paused' };

    const memoryCfg = hot.config.memory ?? {};
    const profile = store.getUser(guildId, userId);
    if (!force && profile?.portraitRefreshedAt) {
      const lastMs = Date.parse(profile.portraitRefreshedAt);
      const hoursMs = (memoryCfg.portraitRefreshHours ?? 24) * 3_600_000;
      if (Number.isFinite(lastMs) && now() - lastMs < hoursMs) {
        log.info('bootstrap: portrait refresh skipped, refreshed too recently', { userId });
        return { ok: false, reason: 'too-soon' };
      }
    }

    const bs = bootstrapState(store);
    const today = new Date(now()).toISOString().slice(0, 10);
    if (bs.refreshDay !== today) {
      bs.refreshDay = today;
      bs.refreshCount = 0;
    }
    const perDay = Number.isFinite(memoryCfg.portraitRefreshPerDay) ? memoryCfg.portraitRefreshPerDay : 20;
    if (bs.refreshCount >= perDay) {
      log.info('bootstrap: portrait refresh skipped, daily refresh cap reached', { userId, perDay });
      return { ok: false, reason: 'daily-cap' };
    }

    if (!hot.prompts?.profile) {
      return { ok: false, reason: 'missing-prompt', message: 'prompt file missing: prompts/profile.md (or prompts.local/profile.md) is not configured yet' };
    }
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, reason: 'no-guild' };

    const cfg = hot.config.bootstrap ?? {};
    const windows = await getWindows(guildId, guild, cfg);
    const mainChannelIds = new Set((memoryCfg.mainChannelIds ?? []).map(String));
    const member = memberStats(windows, userId) ?? {
      id: String(userId),
      name: profile?.names?.[0] ?? String(userId),
      messages: 0,
      firstTs: null,
      lastTs: now(),
    };
    const sample = sampleMember(windows, userId, { ...cfg, messagesPerPerson: cfg.refreshMessages ?? 400 }, mainChannelIds);
    if (sample.messages.length === 0) {
      log.info('bootstrap: portrait refresh: nothing to sample for this member', { userId });
      return { ok: false, reason: 'nothing-to-sample' };
    }

    const selfName = getSelfName(guildId);
    const labels = hot.prompts.labels ?? {};
    const timezone = hot.config.bot?.timezone ?? 'UTC';
    const formatOptions = {
      timezone,
      gapMinutes: hot.config.context?.gapMarkerMinutes ?? 20,
      maxChars: hot.config.context?.maxMessageChars ?? 800,
      selfName,
      mode: 'memory',
      labels,
    };
    const items = markOwnContext(formatTranscript(sample.messages, formatOptions), sample.ownIds, labels);

    const system = fillTemplate(hot.prompts.profile, profileTemplateValues(hot.config, selfName));
    const characterBlock = block('character', characterText(hot.prompts, selfName));
    const memberLine = `${member.name} (id:${member.id}), ${member.messages} messages in the window, first ${isoDateOrDash(member.firstTs)}, last ${isoDateOrDash(member.lastTs)}`;
    const memberBlock = block('member', memberLine);
    const draftBlock = block('draft', JSON.stringify({ character: profile?.character ?? '', style: profile?.style ?? '' }));
    const hintBlock = reason ? block('hint', reason) : '';
    const snippetsBlock = block('snippets', renderTranscript(items, timezone, labels));
    const user = [characterBlock, memberBlock, draftBlock, hintBlock, snippetsBlock].filter(Boolean).join('\n\n');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    let completion;
    try {
      completion = await llm.complete(messages, {
        model: memoryCfg.model ?? hot.config.llm?.model,
        maxOutputTokens: cfg.maxOutputTokens ?? 6000,
        maxRequestTokens: bootstrapRequestCap(cfg),
      });
    } catch (err) {
      log.warn('bootstrap: portrait refresh call failed', { userId, detail: detailOf(err) });
      return { ok: false, reason: 'llm-error' };
    }

    let parsed;
    try {
      parsed = parseJsonObject(completion.text);
    } catch (err) {
      log.warn('bootstrap: portrait refresh answer could not be parsed', { userId, detail: detailOf(err) });
      return { ok: false, reason: 'bad-json' };
    }

    const nameOf = buildNameIndex(windows);
    const clamped = clampProfileResult(parsed, hot.config, nameOf);
    const ops = {};
    if (clamped?.character) ops.character = clamped.character;
    if (clamped?.style) ops.style = clamped.style;

    const knownUserIds = new Set([String(userId)]);
    const batchAuthorNames = new Map([[String(userId), member.name]]);
    const seenAt = Number.isFinite(member.lastTs) ? member.lastTs : now();
    const timing = { seenAtByUser: new Map([[String(userId), seenAt]]), seenAt };
    applyMemoryUpdate(store, guildId, { users: { [userId]: ops } }, memoryCfg, knownUserIds, new Set(), undefined, undefined, undefined, timing, batchAuthorNames);

    store.updateUser(guildId, userId, { portraitRefreshedAt: new Date(now()).toISOString() });
    bs.refreshCount += 1;
    store.state.markDirty();
    store.flush();

    log.info('bootstrap: portrait refreshed', { userId, reason: reason ?? null });
    return { ok: true, userId };
  }

  return {
    peopleReport,
    run,
    stop,
    runPerson: (guildId, userId) => runOneTarget(guildId, 'person', userId),
    runChannel: (guildId, channelId) => runOneTarget(guildId, 'channel', channelId),
    runServer: (guildId) => runOneTarget(guildId, 'server', null),
    runUsers: (guildId) => startBulk(guildId, 'people'),
    runChannels: (guildId) => startBulk(guildId, 'channels'),
    resumeIfNeeded,
    summary,
    status,
    reset,
    refreshPortrait,
    isBootstrapping,
    waitIdle,
  };
}
