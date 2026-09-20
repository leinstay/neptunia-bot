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
import { isDescribable } from '../discord/media.js';
import { log } from '../log.js';
import { emptyAffinity } from './affinity.js';

const BACKOFF_MS = 15 * 60_000;
const MIN_LIVE_BATCH = 20; // the live analyzer never shrinks below this many messages

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

/** A deployment with no/broken labels.json must fail loudly, not send a broken prompt. */
function requireLabels(prompts) {
  const labels = prompts?.labels;
  if (!labels || !labels.transcript) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  return labels;
}

/** Only the fields the memory prompt is allowed to see/update for a user profile. */
function pickProfileFields(profile) {
  const { names = [], character = '', interests = '', style = '', details = [], relationship = '' } = profile ?? {};
  return { names, character, interests, style, details, relationship };
}

/** Only the fields the memory prompt is allowed to see/update for guild memory. */
function pickGuildFields(guildMemory) {
  const { patterns = '', starters = '', injokes = [], self = [] } = guildMemory ?? {};
  return { patterns, starters, injokes, self };
}

/** Only the fields the memory prompt is allowed to see/update for a channel entry. */
function pickChannelFields(channel) {
  const { name = '', category = null, topic = null, purpose = '', topics = '', tone = '' } = channel ?? {};
  return { name, category, topic, purpose, topics, tone };
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
 * @param {Map<string, string>} [input.descriptions]  Item id -> describer caption
 *   (src/memory/describe.js), for pictures the analyzer cannot see itself.
 * @returns {{ messages: object[], consumed: number }}
 */
export function buildMemoryRequest({ prompts, config, calibrator, profiles, guildMemory, channels, messages, selfName, descriptions }) {
  const { timezone } = config.bot;
  const labels = requireLabels(prompts);
  const relationships = config.features?.relationships !== false;
  const system = fillTemplate(prompts.memory, { name: selfName });
  const characterBlock = relationships ? block('character', fillTemplate(prompts['character-card'], { name: selfName })) : '';

  const existingProfiles = {};
  for (const [id, profile] of Object.entries(profiles ?? {})) {
    const fields = pickProfileFields(profile);
    if (relationships) {
      const affinity = profile?.affinity ?? emptyAffinity();
      fields.affinity = { score: affinity.score, reason: affinity.reason };
    }
    existingProfiles[id] = fields;
  }
  const profilesBlock = block('existing_profiles', JSON.stringify(existingProfiles));
  const guildBlock = block('existing_guild', JSON.stringify(pickGuildFields(guildMemory)));

  const existingChannels = {};
  for (const [id, channel] of Object.entries(channels ?? {})) {
    existingChannels[id] = pickChannelFields(channel);
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
      { name: 'fixed', required: true, items: [system, characterBlock, profilesBlock, guildBlock, channelsBlock].filter(Boolean) },
      { name: 'transcript', keep: 'newest', items: transcriptTexts },
    ],
    limit,
    cost,
  );

  const keptTranscriptItems = transcriptItems.slice(transcriptItems.length - kept.transcript.length);
  const newMessagesBlock = block('new_messages', renderTranscript(keptTranscriptItems, timezone, labels));

  const user = [characterBlock, profilesBlock, guildBlock, channelsBlock, newMessagesBlock].filter(Boolean).join('\n\n');

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
 * @returns {{ users: number, guild: boolean, self: boolean, affinity: number, channels: number }}
 */
export function applyMemoryUpdate(store, guildId, update, cfg, knownUserIds, knownChannelIds = new Set(), relationships) {
  const result = { users: 0, guild: false, self: false, affinity: 0, channels: 0 };
  if (!update || typeof update !== 'object' || Array.isArray(update)) return result;

  if (update.users && typeof update.users === 'object' && !Array.isArray(update.users)) {
    for (const [userId, raw] of Object.entries(update.users)) {
      if (!knownUserIds.has(String(userId))) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      const fields = {};
      for (const key of ['character', 'interests', 'style', 'relationship']) {
        if (typeof raw[key] === 'string') fields[key] = clampString(raw[key], cfg.fieldChars);
      }
      if (Array.isArray(raw.details)) {
        fields.details = clampStringArray(raw.details, 200, cfg.maxDetails);
      }

      store.updateUser(guildId, userId, fields);
      result.users += 1;

      if (relationships?.enabled && raw.affinity && typeof raw.affinity === 'object' && !Array.isArray(raw.affinity)) {
        const before = store.getUser(guildId, userId)?.affinity?.score ?? 0;
        const after = store.adjustAffinity(guildId, userId, raw.affinity.delta, raw.affinity.reason, {
          // The model's verdict is never applied unclamped, even if the config block is missing.
          maxDelta: relationships.maxDeltaPerUpdate ?? 15,
          historySize: relationships.historySize ?? 10,
          now: relationships.now,
        });
        if (after.score !== before) result.affinity += 1;
      }
    }
  }

  if (update.channels && typeof update.channels === 'object' && !Array.isArray(update.channels)) {
    for (const [channelId, raw] of Object.entries(update.channels)) {
      if (!knownChannelIds.has(String(channelId))) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      const fields = {};
      for (const key of ['purpose', 'topics', 'tone']) {
        if (typeof raw[key] === 'string') fields[key] = clampString(raw[key], cfg.fieldChars);
      }

      store.updateChannel(guildId, channelId, fields);
      result.channels += 1;
    }
  }

  const guildFields = {};
  if (update.guild && typeof update.guild === 'object' && !Array.isArray(update.guild)) {
    const g = update.guild;
    if (typeof g.patterns === 'string' && g.patterns.trim()) {
      guildFields.patterns = clampString(g.patterns, cfg.fieldChars * 2);
    }
    if (typeof g.starters === 'string' && g.starters.trim()) {
      guildFields.starters = clampString(g.starters, cfg.fieldChars * 2);
    }
    if (Array.isArray(g.injokes) && g.injokes.length) {
      const injokes = clampStringArray(g.injokes, 200, cfg.maxInjokes);
      if (injokes.length) guildFields.injokes = injokes;
    }
  }
  if (Object.keys(guildFields).length > 0) {
    store.updateGuild(guildId, guildFields);
    result.guild = true;
  }

  if (Array.isArray(update.self) && update.self.length > 0) {
    const self = clampStringArray(update.self, 200, cfg.maxSelfFacts);
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
      // into the cache by src/discord/events.js (see analyze() below).
      attachments: (normalized.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, id: a.id, durationSec: a.durationSec ?? null })),
      links: (normalized.links ?? []).map((l) => ({ kind: l.kind, name: l.title || l.site || '', id: l.id, durationSec: null })),
      stickers: normalized.stickers,
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
        descriptions: effectiveDescriptions,
      });

      completion = await llm.complete(llmMessages, {
        model: cfg.model ?? undefined,
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: 0.3,
        countAgainstDailyCap,
      });
    } catch (err) {
      // Nothing was billed: the request never left this process, or the
      // provider never returned a completion.
      const reason = err instanceof TokenLimitError ? 'token-limit' : 'llm-error';
      return { ok: false, usage: null, estimated: 0, result: null, error: err, reason, detail: detailOf(err) };
    }

    try {
      const update = parseJsonObject(completion.text);
      const knownUserIds = new Set(authorIds.map(String));
      const knownChannelIds = new Set(channelIds.map(String));
      const relationshipsOn = hot.config.features?.relationships !== false;
      const relationships = relationshipsOn
        ? { enabled: true, ...hot.config.relationships, now: now() }
        : undefined;
      const result = applyMemoryUpdate(store, guildId, update, cfg, knownUserIds, knownChannelIds, relationships);

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
