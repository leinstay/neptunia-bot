// The mentor's sandbox. A sandbox run takes an invented chat excerpt (a
// "situation"; or a real moment of the chat stored with a case, replayed from
// its normalized messages), builds the request a real turn would build --
// live prompts, live config, live stored memory -- asks the model, parses the
// answer, and stops there: nothing reaches Discord and nothing is written to
// memory. It reproduces the talk path (src/behavior/prompt.js#buildRequest,
// src/behavior/turn.js) with the omissions listed at `answerReply`.
//
// Every read of prompts, config and memory goes through a `view` (see
// `liveView`), never through `hot` or the store directly, so a caller can hand
// in another view of the same shape (a real moment's, src/mentor/moment.js).
// The private layer is out of bounds: a view has no accessor for it and no
// private chat is ever built.

import { buildRequest } from '../behavior/prompt.js';
import { MINUTE_MS } from '../time.js';
import { pickOtherProfiles } from '../behavior/turn.js';
import { parseOutput } from '../llm/parse.js';
import { findGif } from '../memory/gifs.js';

// Token estimates taken as they are: the calibrator of a view built without a live one.
const IDENTITY_CALIBRATOR = Object.freeze({ ratio: 1, apply: (n) => n, observe: () => 1 });
// pickOtherProfiles takes a guild id; the view serves one guild, so this only fills the argument.
const SANDBOX_GUILD = 'sandbox';

/**
 * A read-only view of the live calibrator: `ratio` and `apply` read the live
 * one at the moment of use (its ratio moves while the bot runs), `observe`
 * feeds nothing and returns the live ratio. Without a live calibrator, the
 * identity one (ratio 1).
 */
function readOnlyCalibrator(live) {
  if (!live) return IDENTITY_CALIBRATOR;
  return {
    get ratio() {
      return live.ratio;
    },
    apply: (n) => live.apply(n),
    observe: () => live.ratio,
  };
}

/**
 * A view over the live state of one guild: prompts and config are getters
 * that read `hot` at call time, memory accessors read the store at call time.
 * Nothing is copied. `calibrator` measures tokens the way a real turn does
 * (the live ratio, read at call time) and never feeds the live calibrator;
 * without a live `calibrator` it is the identity one (ratio 1). A view
 * passed instead must offer the same shape (a missing `calibrator` counts as
 * the identity one).
 * @param {{ hot: { prompts: object, config: object }, store: object, guildId: string,
 *   calibrator?: { ratio: number, apply: (n: number) => number } }} deps
 * @returns {{ readonly prompts: object, readonly config: object,
 *   calibrator: { readonly ratio: number, apply: (n: number) => number, observe: () => number }, memory: {
 *   getGuild: () => object, getUser: (id: string) => (object|null), listUserProfiles: () => object[],
 *   listChannels: () => object[], getLore: () => object[] } }}
 */
export function liveView({ hot, store, guildId, calibrator }) {
  return {
    get prompts() {
      return hot.prompts;
    },
    get config() {
      return hot.config;
    },
    calibrator: readOnlyCalibrator(calibrator),
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
 * (`selfId`, `selfName`, `self: true`). `ts` is `at - minutesBefore` minutes
 * (`at`: the moment the situation is answered at, in ms);
 * a line without `minutesBefore` sits one minute per remaining line before
 * `at` (the last one a minute before it); a line that would go back in time
 * gets the previous line's ts + 1 second. `replyTo` (a 0-based index of an
 * earlier line) becomes that line's id in `replyToId`. The last line is the
 * trigger: `triggerKind` 'reply' when it replies to a line of the persona,
 * else 'mention' (and it then mentions `selfId`).
 * @param {{ title?: string, lines: { authorId: string, authorName?: string, text: string,
 *   replyTo?: number|null, minutesBefore?: number }[] }} situation
 * @param {{ selfId: string, selfName: string, at: number,
 *   channel: { id: string, name?: string|null, category?: string|null, topic?: string|null } }} options
 * @returns {{ history: object[], trigger: object, triggerKind: 'reply'|'mention' }}
 * @throws {Error} fewer than 2 lines, a last line by 'self', a replyTo that is not an earlier line.
 */
export function situationToHistory(situation, { selfId, selfName, at, channel }) {
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
    let ts = at - minutes * MINUTE_MS;
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

/**
 * The history a situation is answered from. A real moment of the chat (a
 * situation with `history`, see src/mentor/anchor.js) is replayed from its
 * stored normalized messages as they are, the last one the trigger:
 * `triggerKind` 'reply' when it replies to a message of the persona in that
 * history, else 'mention' (as an invented situation). Invented lines go
 * through `situationToHistory`. Pure.
 * @param {{ history?: object[], lines?: object[] }} situation
 * @param {{ selfId: string, selfName?: string, at?: number, channel?: object }} options
 * @returns {{ history: object[], trigger: object, triggerKind: 'reply'|'mention' }}
 * @throws {Error} an empty stored history or one whose last message is the persona's; see `situationToHistory`.
 */
export function situationHistory(situation, options) {
  if (!Array.isArray(situation?.history)) return situationToHistory(situation, options);
  const history = situation.history;
  if (history.length === 0) throw new Error('situation: the stored history is empty');
  const trigger = history[history.length - 1];
  if (!trigger || trigger.self === true) throw new Error('situation: the last stored message must not be by self');
  const target = trigger.replyToId ? history.find((message) => message?.id === trigger.replyToId) : null;
  return { history, trigger, triggerKind: target?.self === true ? 'reply' : 'mention' };
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

/** How many samples to take: a positive integer, 1 when unusable. */
function sampleCount(samples) {
  const n = Math.floor(Number(samples));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * `samples` completions of `messages`, one after another. Before each one
 * `signal` is checked; an aborted signal (also one that aborts mid-request)
 * stops the loop and `stopped` is true. Any other llm error is thrown.
 * `onUsage(usage, estimated)` follows every completion: what a completion
 * costs is the caller's (the mentor's budget) to weigh.
 */
async function sample({ llm, messages, options, samples, signal, onUsage, read }) {
  const answers = [];
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
    if (typeof onUsage === 'function') onUsage(completion.usage ?? null, completion.estimated ?? 0);
    answers.push(read(completion.text));
  }
  return { answers, stopped };
}

/**
 * The reply sandbox: the request a real reply turn would send for
 * `situation` (buildRequest, mode 'reply', memory through `view.memory` as in
 * a real turn -- `features.memory` off leaves it out -- and tokens measured
 * with `view.calibrator`, so the caps trim what a real turn trims), `samples` completions,
 * each parsed with parseOutput and trimmed by `features.reactions` /
 * `features.multiMessage` like a real turn. The server's custom emoji
 * (`<emoji>`) and GIF library (`<gifs>`, the transcript's GIF handles) render
 * as in a real turn when the caller hands in the same sources the turn uses
 * (`customEmoji`, `gifs`, `mediaCache`; buildRequest applies
 * `features.customEmoji` / `features.gifs`). Left out, unlike a real turn: no
 * neighbours, no web lookup, no drawing offered (no draw quota in `<senses>`),
 * no pictures, never a private chat, no daily GIF cap, and a custom-emoji
 * reaction is kept as written (not resolved through the emoji index); nothing
 * is sent and nothing is stored. Media render with their labels only, unless the caller hands in
 * what the persona saw of them (a real moment's `descriptions` / `videos`,
 * see src/mentor/anchor.js#replayMedia): nothing is described or watched
 * here. Every completion passes `countAgainstDailyCap: false`
 * and `skipCalibration: true`; the per-request token cap stays in force.
 * An answer's `gif` (a handle of the library, `features.gifs` on) and `draw`
 * (`features.imageGeneration` on) count as actions, as in a real turn; an
 * unknown handle or a switched-off kind is dropped (null). `skip` is true
 * when the model skipped or left nothing to do (as a real turn treats it).
 * @param {object} input
 * @param {object} input.view        From `liveView` (or a view of the same shape, e.g. src/mentor/moment.js#momentView).
 * @param {object} input.situation   Invented lines (see `situationToHistory`) or a stored moment (see `situationHistory`).
 * @param {string} input.selfId
 * @param {string} input.selfName
 * @param {{ id: string, name?: string, category?: string, topic?: string }} input.channel
 * @param {{ complete: Function }} input.llm
 * @param {number} input.samples
 * @param {number} input.at          The moment the situation is answered at (ms).
 * @param {AbortSignal} [input.signal]
 * @param {(usage: object|null, estimated: number) => void} [input.onUsage]  Called after every completion.
 * @param {Map<string, string>} [input.descriptions]  Item id -> caption, rendered as the live transcript does.
 * @param {Map<string, object>} [input.videos]  Item id -> video state (`{ state: 'watched', text }`), likewise.
 * @param {{ shape: string, examples: string[] }[]|null} [input.worn]  What the situation's variety pass
 *   named (src/mentor/mentor.js), rendered as `<worn>` exactly as in a live turn; omitted, no block.
 * @param {{ id: string, name: string, animated?: boolean }[]} [input.customEmoji]  The served guild's
 *   custom emoji (src/discord/emoji.js#createEmojiIndex `list()`); omitted, no `<emoji>`.
 * @param {object|null} [input.gifs]  The guild's GIF library (store.getGifs); omitted, no `<gifs>` and no `<gif>` kept.
 * @param {object|null} [input.mediaCache]  The describer cache (store.getMediaCache), read only, for both lists' captions.
 * @returns {Promise<{ request: { system: string, user: string },
 *   answers: { messages: { text: string, replyTo: number|null }[], reactions: { to: number, emoji: string }[],
 *     gif: { id: string, replyTo: number|null }|null, draw: { text: string, self: boolean, replyTo: number|null }|null,
 *     skip: boolean, think: string }[], stopped: boolean }>}
 */
export async function answerReply({
  view,
  situation,
  selfId,
  selfName,
  channel,
  llm,
  samples,
  at,
  signal,
  onUsage,
  descriptions,
  videos,
  worn = null,
  customEmoji,
  gifs = null,
  mediaCache = null,
}) {
  const config = view.config;
  const memory = view.memory;
  const memoryOn = config.features?.memory !== false;
  const { history, trigger, triggerKind } = situationHistory(situation, { selfId, selfName, at, channel });
  // pickOtherProfiles reads a store-shaped object; this one reads the view.
  const viewAsStore = { getUser: (guildId, id) => memory.getUser(id) };

  const request = buildRequest({
    config,
    prompts: view.prompts,
    calibrator: view.calibrator ?? IDENTITY_CALIBRATOR,
    mode: 'reply',
    forced: false,
    now: at,
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
    descriptions: descriptions instanceof Map ? descriptions : new Map(),
    videos: videos instanceof Map ? videos : new Map(),
    reads: new Map(),
    lookup: null,
    searchAvailable: false,
    drawQuota: undefined,
    customEmoji: Array.isArray(customEmoji) ? customEmoji : [],
    gifs,
    mediaCache,
    worn,
  });

  // No pictures: a user message with image parts is sent as its text-only re-render.
  const [systemMessage, userMessage] = request.messages;
  const userContent = Array.isArray(userMessage.content) ? request.textFallback : userMessage.content;
  const messages = [systemMessage, { ...userMessage, content: userContent }];

  const { answers, stopped } = await sample({
    llm,
    messages,
    options: { role: 'talk', countAgainstDailyCap: false, skipCalibration: true, signal },
    samples,
    signal,
    onUsage,
    read: (text) => {
      const parsed = parseOutput(text);
      const features = view.config.features ?? {};
      const reactions = features.reactions === false ? [] : parsed.reactions;
      const replies = features.multiMessage === false ? parsed.messages.slice(0, 1) : parsed.messages;
      // As src/behavior/turn.js: a GIF off the library or with the switch off, a drawing with drawing off, is dropped.
      const gif = parsed.gif && features.gifs !== false && findGif(gifs, parsed.gif.id) ? parsed.gif : null;
      const draw = features.imageGeneration === false ? null : parsed.draw;
      const nothingToDo = replies.length === 0 && reactions.length === 0 && gif === null && draw === null;
      return { messages: replies, reactions, gif, draw, skip: parsed.skip || nothingToDo, think: parsed.think };
    },
  });

  return { request: { system: textOf(systemMessage.content), user: textOf(userContent) }, answers, stopped };
}
