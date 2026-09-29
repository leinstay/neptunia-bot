// The mentor's two sandboxes. A sandbox run takes an invented chat excerpt (a
// "situation"), builds exactly the request a real turn or a real analyzer
// batch would build -- live prompts, live config, live stored memory -- asks
// the model, parses the answer, and stops there: nothing reaches Discord and
// nothing is written to memory. The reply sandbox reproduces the talk path
// (src/behavior/prompt.js#buildRequest, src/behavior/turn.js), the memory
// sandbox the analyzer (src/memory/update.js#buildMemoryRequest +
// applyMemoryUpdate) on a store that only records what it would have written.
//
// Every read of prompts, config and memory goes through a `view` (see
// `liveView`), never through `hot` or the store directly, so a caller can hand
// in an overlay of edited copies with the same shape. The private layer is out
// of bounds: a view has no accessor for it and no private chat is ever built.

import { buildRequest } from '../behavior/prompt.js';
import { pickOtherProfiles } from '../behavior/turn.js';
import { parseJsonObject, parseOutput } from '../llm/parse.js';
import {
  applyMemoryUpdate,
  batchAuthorNamesMap,
  batchContext,
  buildMemoryRequest,
  computeSeenAt,
  memorySwitches,
} from '../memory/update.js';

// Token estimates are taken as they are: a sandbox request never feeds the calibrator.
const CALIBRATOR = { ratio: 1, apply: (n) => n, observe: () => 1 };
// The captured store ignores guild ids (reads go to the view's one guild); this only fills the argument.
const SANDBOX_GUILD = 'sandbox';
const MINUTE_MS = 60_000;
// Same temperature as the live analyzer (src/memory/update.js#analyzeBatch).
const MEMORY_TEMPERATURE = 0.3;

/**
 * A view over the live state of one guild: prompts and config are getters
 * that read `hot` at call time, memory accessors read the store at call time.
 * Nothing is copied. An overlay passed instead must offer the same shape.
 * @param {{ hot: { prompts: object, config: object }, store: object, guildId: string }} deps
 * @returns {{ readonly prompts: object, readonly config: object, memory: {
 *   getGuild: () => object, getUser: (id: string) => (object|null), listUserProfiles: () => object[],
 *   listChannels: () => object[], getLore: () => object[] } }}
 */
export function liveView({ hot, store, guildId }) {
  return {
    get prompts() {
      return hot.prompts;
    },
    get config() {
      return hot.config;
    },
    memory: {
      getGuild: () => store.getGuild(guildId),
      getUser: (id) => store.getUser(guildId, id),
      listUserProfiles: () => store.listUserProfiles(guildId),
      listChannels: () => store.listChannels(guildId),
      getLore: () => store.getLore(guildId),
    },
  };
}

/**
 * A situation as normalized channel messages (the shape of
 * src/discord/collect.js#normalizeMessage), oldest first. Pure.
 *
 * Line n (0-based) gets id `sb-<n+1>`; `authorId: 'self'` is the persona
 * (`selfId`, `selfName`, `self: true`). `ts` is `now - minutesBefore` minutes;
 * a line without `minutesBefore` sits one minute per remaining line before
 * `now` (the last one a minute before it); a line that would go back in time
 * gets the previous line's ts + 1 second. `replyTo` (a 0-based index of an
 * earlier line) becomes that line's id in `replyToId`. The last line is the
 * trigger: `triggerKind` 'reply' when it replies to a line of the persona,
 * else 'mention' (and it then mentions `selfId`).
 * @param {{ title?: string, lines: { authorId: string, authorName?: string, text: string,
 *   replyTo?: number|null, minutesBefore?: number }[] }} situation
 * @param {{ selfId: string, selfName: string, now: number,
 *   channel: { id: string, name?: string|null, category?: string|null, topic?: string|null } }} options
 * @returns {{ history: object[], trigger: object, triggerKind: 'reply'|'mention' }}
 * @throws {Error} fewer than 2 lines, a last line by 'self', a replyTo that is not an earlier line.
 */
export function situationToHistory(situation, { selfId, selfName, now, channel }) {
  const lines = Array.isArray(situation?.lines) ? situation.lines : [];
  if (lines.length < 2) throw new Error('situation: at least 2 lines are needed');
  if (lines[lines.length - 1]?.authorId === 'self') throw new Error('situation: the last line must not be by self');

  const history = [];
  let previousTs = -Infinity;
  lines.forEach((line, n) => {
    const replyTo = line.replyTo ?? null;
    if (replyTo !== null && !(Number.isInteger(replyTo) && replyTo >= 0 && replyTo < n)) {
      throw new Error(`situation: line ${n} replies to ${replyTo}, which is not an earlier line`);
    }
    const minutes = Number.isFinite(line.minutesBefore) ? line.minutesBefore : lines.length - n;
    let ts = now - minutes * MINUTE_MS;
    if (ts < previousTs) ts = previousTs + 1000;
    previousTs = ts;
    const self = line.authorId === 'self';
    history.push({
      id: `sb-${n + 1}`,
      channelId: channel.id,
      channelName: channel.name ?? null,
      channelCategory: channel.category ?? null,
      channelTopic: channel.topic ?? null,
      authorId: self ? selfId : line.authorId,
      authorName: self ? selfName : line.authorName,
      self,
      bot: false,
      content: line.text,
      ts,
      mentionedUserIds: [],
      replyToId: replyTo === null ? null : `sb-${replyTo + 1}`,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    });
  });

  const trigger = history[history.length - 1];
  const lastReplyTo = lines[lines.length - 1].replyTo ?? null;
  const triggerKind = lastReplyTo !== null && lines[lastReplyTo].authorId === 'self' ? 'reply' : 'mention';
  if (triggerKind === 'mention') trigger.mentionedUserIds = [selfId];
  return { history, trigger, triggerKind };
}

/** The text of a message's content: a string as is, an array of parts as its text parts joined. */
function textOf(content) {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return String(content ?? '');
}

/** What one completion costs: `usage.total_tokens`, else the pre-flight estimate. */
function tokensOf(completion) {
  const total = completion?.usage?.total_tokens;
  return Number.isFinite(total) ? total : (completion?.estimated ?? 0);
}

/** How many samples to take: a positive integer, 1 when unusable. */
function sampleCount(samples) {
  const n = Math.floor(Number(samples));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * `samples` completions of `messages`, one after another. Before each one
 * `signal` is checked; an aborted signal (also one that aborts mid-request)
 * stops the loop and `stopped` is true. Any other llm error is thrown.
 * `onUsage(usage, estimated)` follows every completion.
 */
async function sample({ llm, messages, options, samples, signal, onUsage, read }) {
  const answers = [];
  let tokens = 0;
  let stopped = false;
  for (let i = 0; i < sampleCount(samples); i += 1) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    let completion;
    try {
      completion = await llm.complete(messages, options);
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      throw err;
    }
    tokens += tokensOf(completion);
    if (typeof onUsage === 'function') onUsage(completion.usage ?? null, completion.estimated ?? 0);
    answers.push(read(completion.text));
  }
  return { answers, tokens, stopped };
}

/**
 * The reply sandbox: the request a real reply turn would send for
 * `situation` (buildRequest, mode 'reply', memory through `view.memory` as in
 * a real turn -- `features.memory` off leaves it out), `samples` completions,
 * each parsed with parseOutput and trimmed by `features.reactions` /
 * `features.multiMessage` like a real turn. No neighbours, no media, no web
 * lookup, no drawing, no pictures, never a private chat; nothing is sent and
 * nothing is stored. Every completion passes `countAgainstDailyCap: false`
 * and `skipCalibration: true`; the per-request token cap stays in force.
 * `skip` is true when the model skipped or left nothing to do (as a real
 * turn treats it).
 * @param {object} input
 * @param {object} input.view        From `liveView` (or an overlay of the same shape).
 * @param {object} input.situation   See `situationToHistory`.
 * @param {string} input.selfId
 * @param {string} input.selfName
 * @param {{ id: string, name?: string, category?: string, topic?: string }} input.channel
 * @param {{ complete: Function }} input.llm
 * @param {number} input.samples
 * @param {number} input.now
 * @param {AbortSignal} [input.signal]
 * @param {(usage: object|null, estimated: number) => void} [input.onUsage]  Called after every completion.
 * @returns {Promise<{ request: { system: string, user: string },
 *   answers: { messages: { text: string, replyTo: number|null }[], reactions: { to: number, emoji: string }[],
 *     skip: boolean, think: string }[], tokens: number, stopped: boolean }>}
 */
export async function answerReply({ view, situation, selfId, selfName, channel, llm, samples, now, signal, onUsage }) {
  const config = view.config;
  const memory = view.memory;
  const memoryOn = config.features?.memory !== false;
  const { history, trigger, triggerKind } = situationToHistory(situation, { selfId, selfName, now, channel });
  // pickOtherProfiles reads a store-shaped object; this one reads the view.
  const viewAsStore = { getUser: (guildId, id) => memory.getUser(id) };

  const request = buildRequest({
    config,
    prompts: view.prompts,
    calibrator: CALIBRATOR,
    mode: 'reply',
    forced: false,
    now,
    selfName,
    history,
    neighbors: [],
    trigger,
    triggerKind,
    guildMemory: memoryOn ? memory.getGuild() : {},
    interlocutor: memoryOn ? memory.getUser(trigger.authorId) : null,
    privateChat: null,
    privateProfile: null,
    otherProfiles: memoryOn ? pickOtherProfiles(viewAsStore, SANDBOX_GUILD, history, trigger.authorId, config.context.otherProfiles) : [],
    candidateProfiles: memoryOn ? memory.listUserProfiles() : [],
    nameOf: memoryOn ? (id) => memory.getUser(id)?.names?.[0] ?? null : undefined,
    channels: memoryOn ? memory.listChannels() : [],
    loreEntries: memoryOn ? memory.getLore() : [],
    currentChannelId: channel.id,
    descriptions: new Map(),
    videos: new Map(),
    reads: new Map(),
    lookup: null,
    searchAvailable: false,
    drawQuota: undefined,
  });

  // No pictures: a user message with image parts is sent as its text-only re-render.
  const [systemMessage, userMessage] = request.messages;
  const userContent = Array.isArray(userMessage.content) ? request.textFallback : userMessage.content;
  const messages = [systemMessage, { ...userMessage, content: userContent }];

  const { answers, tokens, stopped } = await sample({
    llm,
    messages,
    options: { countAgainstDailyCap: false, skipCalibration: true, signal },
    samples,
    signal,
    onUsage,
    read: (text) => {
      const parsed = parseOutput(text);
      const features = view.config.features ?? {};
      const reactions = features.reactions === false ? [] : parsed.reactions;
      const replies = features.multiMessage === false ? parsed.messages.slice(0, 1) : parsed.messages;
      const nothingToDo = replies.length === 0 && reactions.length === 0;
      return { messages: replies, reactions, skip: parsed.skip || nothingToDo, think: parsed.think };
    },
  });

  return { request: { system: textOf(systemMessage.content), user: textOf(userContent) }, answers, tokens, stopped };
}

/** The stored channel entry `id` among the view's channels, or null (the store's getChannel, through the view). */
function channelFromView(view, id) {
  return view.memory.listChannels().find((channel) => String(channel?.id) === String(id)) ?? null;
}

/**
 * A store-shaped object for applyMemoryUpdate over `view`. Reads come from
 * `view.memory` (guild ids are ignored: the view serves one guild):
 * `getUser`, `getGuild`, `getLore`, `listChannels`, `listUserProfiles`,
 * `getChannel` (looked up in `listChannels`). Every write method --
 * `applyProfileOps`, `adjustAffinity`, `addEpisodes`, `setLore`,
 * `updateChannel`, `updateGuild`, `applyLearnedOps` (the ones
 * applyMemoryUpdate calls), plus `updateUser`, `touchUser`, `forgetUser`,
 * `removeLore`, `setChannelFacts`, `touchChannel`, `pushBuffer`,
 * `shiftBuffer`, `markMediaCacheDirty`, `flush` -- only records
 * `{ method, args }` in `writes` and changes nothing; its return value is
 * the unchanged current state (or 0 for a count). `state` is
 * `{ data: {}, markDirty() {} }`. There is no private-layer method.
 * @param {object} view  From `liveView` (or an overlay of the same shape).
 * @returns {{ store: object, writes: { method: string, args: unknown[] }[] }}
 */
export function captureStore(view) {
  const writes = [];
  const record =
    (method, result = () => undefined) =>
    (...args) => {
      writes.push({ method, args });
      return result(...args);
    };
  const store = {
    getUser: (guildId, id) => view.memory.getUser(id),
    getGuild: () => view.memory.getGuild(),
    getLore: () => view.memory.getLore(),
    listChannels: () => view.memory.listChannels(),
    listUserProfiles: () => view.memory.listUserProfiles(),
    getChannel: (guildId, id) => channelFromView(view, id),

    applyProfileOps: record('applyProfileOps', (guildId, id) => view.memory.getUser(id)),
    updateUser: record('updateUser', (guildId, id) => view.memory.getUser(id)),
    touchUser: record('touchUser'),
    forgetUser: record('forgetUser', () => false),
    adjustAffinity: record('adjustAffinity', (guildId, id) => view.memory.getUser(id)?.affinity ?? { score: 0, reason: '', history: [] }),
    addEpisodes: record('addEpisodes', () => 0),
    updateGuild: record('updateGuild', () => view.memory.getGuild()),
    applyLearnedOps: record('applyLearnedOps', () => view.memory.getGuild()?.learned ?? []),
    setLore: record('setLore', () => 0),
    removeLore: record('removeLore', () => false),
    updateChannel: record('updateChannel', (guildId, id) => channelFromView(view, id)),
    setChannelFacts: record('setChannelFacts', (guildId, id) => channelFromView(view, id)),
    touchChannel: record('touchChannel'),
    pushBuffer: record('pushBuffer'),
    shiftBuffer: record('shiftBuffer'),
    markMediaCacheDirty: record('markMediaCacheDirty'),
    flush: record('flush'),
    state: { data: {}, markDirty() {} },
  };
  return { store, writes };
}

// Keys whose strings are not prose: ids, dates, weights, names and aliases, lore
// identities, list ops by id or topic, and an episode's `quote` (a person's own words).
const NOT_PROSE_KEYS = new Set(['id', 'from', 'date', 'ts', 'url', 'names', 'aliases', 'title', 'keys', 'seen', 'remove', 'weight', 'sure', 'delta', 'source', 'quote']);
// A whole string that is only a member token, a number or a URL.
const NOT_PROSE_TEXT = /^(?:<@!?\d+>|\d+|https?:\/\/\S+)$/;

/** Every prose string under `value`, addressed from `path` (`.key` for a key, `[i]` for an index). */
function proseUnder(value, path, out) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && !NOT_PROSE_TEXT.test(trimmed)) out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => proseUnder(item, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!NOT_PROSE_KEYS.has(key)) proseUnder(item, `${path}.${key}`, out);
    }
  }
}

/** Where each recorded write lands: [path, payload] pairs. Other writes store no analyzer prose. */
const WRITE_TARGETS = {
  applyProfileOps: ([, userId, ops]) => [[`users.${userId}`, ops]],
  updateUser: ([, userId, fields]) => [[`users.${userId}`, fields]],
  adjustAffinity: ([, userId, , reason]) => [[`users.${userId}.affinity.reason`, reason]],
  addEpisodes: ([, userId, episodes]) => [[`users.${userId}.episodes`, episodes]],
  updateGuild: ([, fields]) => [['guild', fields]],
  applyLearnedOps: ([, ops]) => [['guild.learned', ops]],
  updateChannel: ([, channelId, fields]) => [[`channels.${channelId}`, fields]],
  setLore: ([, entries]) =>
    (Array.isArray(entries) ? entries : []).map((entry, i) => {
      const title = typeof entry?.title === 'string' && entry.title.trim() ? entry.title.trim() : String(i);
      return [`lore[${title}]`, entry];
    }),
};

/**
 * Every prose string the recorded writes would store, in write order, with
 * a readable address:
 * `users.<id>.character` / `.style` / `.relationship`,
 * `users.<id>.interests.add[i].topic` / `.note` (and `.update[i]...`),
 * `users.<id>.details.add[i]` (or `.add[i].text`),
 * `users.<id>.affinity.reason`, `users.<id>.episodes[i].what` / `.feeling`,
 * `guild.patterns`, `guild.starters`, `guild.injokes[i]`, `guild.self[i]`,
 * `guild.learned.add[i].text`, `lore[<title>].text` (`lore[<i>]` without a
 * title), `channels.<id>.purpose` / `.topics` / `.tone`.
 * Left out: ids, dates, numbers, URLs, names, aliases, lore titles and keys,
 * and an episode's `quote`. These are the strings handed to the store, before
 * the store's own clamping and de-duplication.
 * @param {{ method: string, args: unknown[] }[]} writes
 * @returns {{ path: string, text: string }[]}
 */
function textsOf(writes) {
  const out = [];
  for (const { method, args } of writes) {
    const targets = WRITE_TARGETS[method];
    if (!targets) continue;
    for (const [path, payload] of targets(args)) proseUnder(payload, path, out);
  }
  return out;
}

/**
 * The memory sandbox: the request the live analyzer would send for `batch`
 * (buildMemoryRequest over `view`: the batch authors' profiles, the batch
 * channels' entries, the guild memory and the lorebook; no media captions),
 * `samples` completions on `memory.model` (else `llm.model`) with
 * `memory.maxOutputTokens` / `memory.timeoutMs` and the analyzer's
 * temperature, `countAgainstDailyCap: false`, `skipCalibration: true`. Each
 * answer goes through parseJsonObject and applyMemoryUpdate with the
 * analyzer's own arguments (known ids from the batch, the feature switches,
 * the batch's timing and nicks) on a `captureStore`: nothing is stored.
 * `parseOk` is false when the answer is not a JSON object (or applying it
 * failed); its `texts` are then empty. See `textsOf` for the paths.
 * @param {object} input
 * @param {object} input.view         From `liveView` (or an overlay of the same shape).
 * @param {object[]} input.batch      Normalized messages, e.g. `situationToHistory(...).history`.
 * @param {string} input.selfName
 * @param {{ complete: Function }} input.llm
 * @param {number} input.samples
 * @param {number} [input.now]        The clock for the apply step's dates; defaults to the wall clock.
 * @param {AbortSignal} [input.signal]
 * @param {(usage: object|null, estimated: number) => void} [input.onUsage]  Called after every completion.
 * @returns {Promise<{ request: { system: string, user: string },
 *   answers: { texts: { path: string, text: string }[], parseOk: boolean }[], tokens: number, stopped: boolean }>}
 */
export async function answerMemory({ view, batch, selfName, llm, samples, now = Date.now(), signal, onUsage }) {
  const config = view.config;
  const memory = view.memory;
  // As the live analyzer: no memory prompt, no request (it would be sent without its instructions).
  if (!view.prompts.memory) throw new Error('answerMemory: no memory prompt configured');
  const context = batchContext(batch, (id) => memory.getUser(id), (id) => channelFromView(view, id));
  const knownUserIds = new Set(context.authorIds.map(String));
  const knownChannelIds = new Set(context.channelIds.map(String));

  const { messages } = buildMemoryRequest({
    prompts: view.prompts,
    config,
    calibrator: CALIBRATOR,
    profiles: context.profiles,
    channels: context.channels,
    guildMemory: memory.getGuild(),
    messages: batch,
    selfName,
    loreEntries: memory.getLore(),
    nameOf: (id) => memory.getUser(id)?.names?.[0] ?? null,
  });

  const memoryCfg = config.memory ?? {};
  const { answers, tokens, stopped } = await sample({
    llm,
    messages,
    options: {
      model: memoryCfg.model ?? config.llm?.model,
      maxOutputTokens: memoryCfg.maxOutputTokens,
      temperature: MEMORY_TEMPERATURE,
      timeoutMs: memoryCfg.timeoutMs ?? config.llm?.timeoutMs,
      countAgainstDailyCap: false,
      skipCalibration: true,
      signal,
    },
    samples,
    signal,
    onUsage,
    read: (text) => {
      try {
        const update = parseJsonObject(text);
        const liveConfig = view.config;
        const { relationships, episodes, lore } = memorySwitches(liveConfig, () => now);
        const { store, writes } = captureStore(view);
        applyMemoryUpdate(
          store,
          SANDBOX_GUILD,
          update,
          liveConfig.memory,
          knownUserIds,
          knownChannelIds,
          relationships,
          episodes,
          lore,
          computeSeenAt(batch),
          batchAuthorNamesMap(batch),
        );
        return { texts: textsOf(writes), parseOk: true };
      } catch {
        return { texts: [], parseOk: false };
      }
    },
  });

  return { request: { system: textOf(messages[0].content), user: textOf(messages[1].content) }, answers, tokens, stopped };
}
