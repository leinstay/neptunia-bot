// Turns the raw stream of Discord messages into long-term memory. Every
// message the persona sees is buffered (`observe`); once enough have piled up
// (`isDue`), a periodic tick (`tick`, called by index.js every 60s) asks the
// LLM to merge what happened into per-user profiles, server-wide patterns and
// facts the persona has claimed about itself (`run`, via `buildMemoryRequest`
// + `applyMemoryUpdate`). Memory is persistent: nothing here ever wipes it —
// a failed update just leaves the buffer alone and backs off for a while.

import { fitSections } from '../llm/budget.js';
import { estimateTokens } from '../llm/tokens.js';
import { formatTranscript, renderTranscript } from '../discord/format.js';
import { parseJsonObject } from '../llm/parse.js';
import { log } from '../log.js';

const BACKOFF_MS = 15 * 60_000;

/**
 * Whether the buffered messages of one guild are ready for a memory update.
 * @param {object[]} buffer  Buffered slim messages, oldest first.
 * @param {number} now
 * @param {object} cfg       `config.memory`.
 */
export function isDue(buffer, now, cfg) {
  if (buffer.length >= cfg.batchMessages) return true;
  if (buffer.length >= cfg.minBatchMessages) {
    const oldest = buffer[0];
    if (oldest && now - oldest.ts >= cfg.maxBatchAgeMinutes * 60_000) return true;
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
 * @param {object[]} input.messages   Slim buffered messages (oldest first) to summarize.
 * @param {string} input.selfName     The persona's display name in this guild.
 * @returns {{ messages: object[], consumed: number }}
 */
export function buildMemoryRequest({ prompts, config, calibrator, profiles, guildMemory, messages, selfName }) {
  const { timezone } = config.bot;
  const labels = requireLabels(prompts);
  const system = fillTemplate(prompts.memory, { name: selfName });

  const existingProfiles = {};
  for (const [id, profile] of Object.entries(profiles ?? {})) {
    existingProfiles[id] = pickProfileFields(profile);
  }
  const profilesBlock = block('existing_profiles', JSON.stringify(existingProfiles));
  const guildBlock = block('existing_guild', JSON.stringify(pickGuildFields(guildMemory)));

  const formatOptions = {
    timezone,
    gapMinutes: config.context.gapMarkerMinutes,
    maxChars: config.context.maxMessageChars,
    selfName,
    mode: 'memory',
    labels,
  };
  const transcriptItems = formatTranscript(messages, formatOptions);
  const transcriptTexts = transcriptItems.map((item) => item.text);

  const cost = (text) => calibrator.apply(estimateTokens(text)) + 2;
  const limit = Math.floor(config.llm.maxRequestTokens * config.llm.safetyMargin);

  const { kept } = fitSections(
    [
      { name: 'fixed', required: true, items: [system, profilesBlock, guildBlock] },
      { name: 'transcript', keep: 'newest', items: transcriptTexts },
    ],
    limit,
    cost,
  );

  const keptTranscriptItems = transcriptItems.slice(transcriptItems.length - kept.transcript.length);
  const newMessagesBlock = block('new_messages', renderTranscript(keptTranscriptItems, timezone, labels));

  const user = [profilesBlock, guildBlock, newMessagesBlock].filter(Boolean).join('\n\n');

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
 * @returns {{ users: number, guild: boolean, self: boolean }}
 */
export function applyMemoryUpdate(store, guildId, update, cfg, knownUserIds) {
  const result = { users: 0, guild: false, self: false };
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

  /** Called for every guild message the persona sees, including its own. */
  function observe(guildId, normalized) {
    if (normalized.bot) return;
    if (!normalized.self) {
      store.touchUser(guildId, normalized.authorId, normalized.authorName, normalized.ts);
    }

    const slim = {
      id: normalized.id,
      authorId: normalized.authorId,
      authorName: normalized.authorName,
      self: normalized.self,
      bot: normalized.bot,
      content: normalized.content,
      ts: normalized.ts,
      replyToId: normalized.replyToId,
      attachments: (normalized.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name })),
      stickers: normalized.stickers,
    };
    const cfg = hot.config.memory;
    store.pushBuffer(guildId, slim, cfg.batchMessages * 3);
  }

  /** Run a memory update for one guild if its buffer is due and it is not busy/backed off. */
  async function run(guildId) {
    running.add(guildId);
    try {
      const cfg = hot.config.memory;
      const promptText = hot.prompts.memory;
      if (!promptText) {
        log.warn('memory: no memory prompt configured, skipping', { guildId });
        return;
      }

      const buffer = store.getBuffer(guildId);
      const take = Math.min(buffer.length, cfg.batchMessages * 2);
      const messages = buffer.slice(0, take);

      const authorIds = [...new Set(messages.filter((m) => !m.self).map((m) => m.authorId))];
      const profiles = {};
      for (const id of authorIds) {
        const profile = store.getUser(guildId, id);
        if (profile) profiles[id] = profile;
      }

      const { messages: llmMessages, consumed } = buildMemoryRequest({
        prompts: hot.prompts,
        config: hot.config,
        calibrator,
        profiles,
        guildMemory: store.getGuild(guildId),
        messages,
        selfName: getSelfName(guildId),
      });

      const completion = await llm.complete(llmMessages, {
        model: cfg.model ?? undefined,
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: 0.3,
      });
      const update = parseJsonObject(completion.text);
      const knownUserIds = new Set(authorIds.map(String));
      const result = applyMemoryUpdate(store, guildId, update, cfg, knownUserIds);

      store.shiftBuffer(guildId, consumed);
      store.flush();
      log.info('memory: update applied', { guildId, consumed, ...result });
    } catch (err) {
      backoffUntil.set(guildId, now() + BACKOFF_MS);
      log.warn('memory: update failed, backing off', { guildId, error: err });
    } finally {
      running.delete(guildId);
    }
  }

  /** Check every guild and kick off a memory update for the ones that are due. */
  async function tick() {
    const nowMs = now();
    const cfg = hot.config.memory;
    const jobs = [];
    for (const guildId of store.listGuilds()) {
      if (running.has(guildId)) continue;
      if (nowMs < (backoffUntil.get(guildId) ?? 0)) continue;
      if (!isDue(store.getBuffer(guildId), nowMs, cfg)) continue;
      jobs.push(run(guildId));
    }
    await Promise.all(jobs);
  }

  return { observe, tick, run };
}
