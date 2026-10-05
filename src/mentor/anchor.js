// Real moments of the chat as mentor situations ("anchors"). The owner points
// at one message of the persona he did not like; the moment is the chat that
// led to it -- up to and including the message that called for the answer,
// the trigger -- and her whole answer as she gave it. The chat is fetched once
// and stored with the case, so it is replayed as it was even after the
// channel moves on or a message is deleted; names and reactions stay as they
// were at fetch time. In a run each anchor is a situation of its own,
// answered from its stored history with today's prompts and memory.
//
// A moment is replayed as the turn it was. The post ledger (`state.json`
// `postLedger`, written by the turn after each post while the mentor is on)
// says what a post answered: the turn's mode, its trigger kind (an overheard
// line, a follow-up, a name call...), the trigger and, for a call from a
// channel the persona cannot write in, that source channel. The anchor
// stores them; without a ledger entry the trigger is the guess
// src/discord/collect.js#fetchMoment makes, and the anchor says so
// (`triggerGuessed`). The other channels the turn was shown are stored with
// it as windows: the source of a routed call, ending at the call, and every
// channel named with an explicit `<#id>` that the pull rails let in, ending
// before her answer (`pulledFromStored` turns them back into the records
// `<channel_view>` renders). The jump link a post carried to another channel
// is not part of what she said and is cut from `original`.
//
// Parsing a message reference and shaping stored anchors is pure; the
// fetches go through an injected client, src/discord/collect.js#fetchMoment
// and #fetchHistoryWindow.
//
// The persona saw more of the chat's media than its labels: the describer's
// captions and watched summaries (src/memory/describe.js, cached in
// data/guilds/<id>/media.json). When a moment is resolved, the ones cached
// by the time she answered are stored with their message (`mediaSeen`), and
// a replay renders them the way the live transcript did. The cache is only
// read: nothing is downloaded, described or written.

import { canSend, PAGE } from '../discord/collect.js';
import { collectEmojiItems, collectPictures, collectVideos, isDescribable } from '../discord/media.js';
import { checkPull } from '../discord/pull-fetch.js';
import { channelPullOn, pullPictures, pullSettings, pullTargets, pullWindow } from '../behavior/pull.js';
import { ID_DIGITS } from '../memory/mentions.js';

const LINK = /^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)\/?>?$/i;
const SNOWFLAKE = new RegExp(`^${ID_DIGITS}$`);
const DISCORD_EPOCH = 1420070400000n;
/** How long after the trigger an anchor is replayed when her message's time is unknown. */
const FALLBACK_DELAY_MS = 60_000;

/** The modes a stored moment's turn can have (src/behavior/turn.js#runTurn after `auto` is chosen). */
const MODES = new Set(['reply', 'interject', 'initiate']);
/** The modes of a turn nobody asked for: no trigger. */
const SPONTANEOUS = new Set(['interject', 'initiate']);
/** src/behavior/turn.js#TriggerKind without `private`: a private chat is never a moment. */
const KINDS = new Set(['mention', 'reply', 'name', 'followUp', 'overheard', 'drawFailed']);
/** Why a stored window was shown: the source of a routed call, an explicit `<#id>`. */
const WINDOW_REASONS = new Set(['routed', 'mention']);
/** How withLink (src/behavior/turn.js) joins a post and its jump link without `labels.elsewhere.link`. */
const PLAIN_LINK_FORM = '{text}\n{link}';
/** The refusal of a routed answer whose call cannot be fetched again. */
const CALL_UNREADABLE = 'the call it answered, in another channel, cannot be read';

/** A non-empty string id. */
function isId(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * A stored moment's turn mode: `reply`, `interject` or `initiate`; null for
 * anything else (an anchor stored before modes were kept). Pure.
 * @param {unknown} value
 * @returns {'reply'|'interject'|'initiate'|null}
 */
export function anchorMode(value) {
  return MODES.has(value) ? value : null;
}

/**
 * A stored moment's trigger kind (src/behavior/turn.js#TriggerKind, never
 * `private`); null for anything else. Pure.
 * @param {unknown} value
 * @returns {string|null}
 */
export function anchorKind(value) {
  return KINDS.has(value) ? value : null;
}

/** Whether `mode` is a turn nobody asked for (`interject`, `initiate`): it has no trigger. Pure. */
export function isSpontaneous(mode) {
  return SPONTANEOUS.has(mode);
}

/**
 * The channel windows a moment stores, cleaned: each `{ channelId,
 * channelName, readOnly, reason, messages, olderNotShown }` with a channel id,
 * a reason (`routed` | `mention`) and at least one message object; one per
 * channel, the first wins. Anything else is left out. Pure; `[]` for a value
 * that is not a list.
 * @param {unknown} value
 * @returns {{ channelId: string, channelName: string|null, readOnly: boolean, reason: 'routed'|'mention',
 *   messages: object[], olderNotShown: boolean }[]}
 */
export function storedWindows(value) {
  const out = [];
  const seen = new Set();
  for (const window of Array.isArray(value) ? value : []) {
    if (!window || typeof window !== 'object' || !isId(window.channelId) || seen.has(window.channelId)) continue;
    if (!WINDOW_REASONS.has(window.reason)) continue;
    const messages = Array.isArray(window.messages) ? window.messages.filter((m) => m !== null && typeof m === 'object') : [];
    if (messages.length === 0) continue;
    seen.add(window.channelId);
    out.push({
      channelId: window.channelId,
      channelName: isId(window.channelName) ? window.channelName : null,
      readOnly: window.readOnly === true,
      reason: window.reason,
      messages,
      olderNotShown: window.olderNotShown === true,
    });
  }
  return out;
}

/**
 * The message a stored moment answers: the one its `triggerId` names, in its
 * history or in one of its stored windows (a routed call lives in its
 * source); else the last message of its history (an anchor stored before
 * triggers were looked up by id). Null for a spontaneous turn (`mode`
 * `interject` / `initiate`) and for an empty history. Pure.
 * @param {{ history?: object[], triggerId?: string|null, pulled?: object[], mode?: string|null }} moment
 * @returns {object|null}
 */
export function storedTrigger(moment) {
  const history = Array.isArray(moment?.history) ? moment.history : [];
  if (history.length === 0 || isSpontaneous(moment?.mode)) return null;
  const id = moment.triggerId;
  if (isId(id)) {
    const found =
      history.find((message) => message?.id === id) ??
      storedWindows(moment.pulled)
        .flatMap((window) => window.messages)
        .find((message) => message.id === id);
    if (found) return found;
  }
  return history[history.length - 1] ?? null;
}

/**
 * The time (ms) of the newest line a stored moment showed the persona: the
 * last message of its history, or its trigger when that is newer (a call in
 * another channel). Null when neither carries a time. Pure.
 * @param {{ history?: object[], triggerId?: string|null, pulled?: object[], mode?: string|null }} moment
 * @returns {number|null}
 */
export function newestSeenTs(moment) {
  const history = Array.isArray(moment?.history) ? moment.history : [];
  const times = [history[history.length - 1]?.ts, storedTrigger(moment)?.ts].filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * The post ledger's entry (`state.json` `postLedger`, src/behavior/turn.js)
 * for one message of the persona: the newest entry whose `messageId` is that
 * message and whose `channelId`, when it has one, is that channel. Null
 * without a list or an entry. Pure.
 * @param {unknown} ledger
 * @param {{ channelId: string, messageId: string }} message
 * @returns {object|null}
 */
export function ledgerEntryFor(ledger, { channelId, messageId }) {
  if (!Array.isArray(ledger)) return null;
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    const entry = ledger[i];
    if (!entry || typeof entry !== 'object' || entry.messageId !== messageId) continue;
    if (entry.channelId !== undefined && entry.channelId !== null && String(entry.channelId) !== String(channelId)) continue;
    return entry;
  }
  return null;
}

/** A regular expression source matching `text` literally, any run of whitespace in it as optional whitespace. */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
}

/**
 * `text` without the jump link a post of the persona carried to a message of
 * guild `guildId`: when the whole text is `form` (`labels.elsewhere.link`, its
 * `{text}` and `{link}`; without it the plain join, the post and the link on
 * their own lines) around such a link, what stood for `{text}`, trimmed (''
 * for a post that was only the link). Any other text comes back as it is.
 * Pure.
 * @param {string} text
 * @param {{ form?: string|null, guildId: string }} options
 * @returns {string}
 */
export function withoutJumpLink(text, { form = null, guildId }) {
  if (typeof text !== 'string') return text;
  const template = typeof form === 'string' && form ? form : PLAIN_LINK_FORM;
  const parts = template.split(/(\{text\}|\{link\})/);
  if (parts.filter((part) => part === '{text}').length !== 1 || parts.filter((part) => part === '{link}').length !== 1) return text;
  const link = `https://discord\\.com/channels/${literal(String(guildId))}/${ID_DIGITS}/${ID_DIGITS}`;
  const pattern = parts.map((part) => (part === '{text}' ? '([\\s\\S]*?)' : part === '{link}' ? link : literal(part))).join('');
  const match = new RegExp(`^\\s*${pattern}\\s*$`, 'u').exec(text);
  return match ? match[1].trim() : text;
}

/**
 * A message link (`https://discord.com/channels/<guild>/<channel>/<message>`,
 * also the ptb/canary/discordapp hosts, optionally in `<...>`) or a bare
 * message id, which means the channel the command was typed in. Pure.
 * @param {string} value
 * @param {{ channelId?: string|null }} context
 * @returns {{ guildId: string|null, channelId: string, messageId: string, dm: boolean }}
 *   `guildId` null for a bare id; `dm` true for a `@me` link.
 * @throws {Error} neither a link nor an id, or a bare id without a channel.
 */
export function parseMessageRef(value, { channelId } = {}) {
  const text = String(value ?? '').trim();
  const link = LINK.exec(text);
  if (link) {
    const dm = link[1].toLowerCase() === '@me';
    return { guildId: dm ? null : link[1], channelId: link[2], messageId: link[3], dm };
  }
  if (SNOWFLAKE.test(text)) {
    if (!channelId) throw new Error('a bare message id needs the channel it was typed in; give a link');
    return { guildId: null, channelId: String(channelId), messageId: text, dm: false };
  }
  throw new Error('give a message link or a message id');
}

/**
 * Fetch the moment of one message of the persona, for a case. Refused, with
 * an operator-facing Error: a `@me` link or a channel without a guild (a
 * direct message), a link or a channel of another guild, a channel that
 * cannot be fetched or read, whatever `fetchMoment` refuses (a message that
 * is not the persona's among them), and a routed answer whose call cannot be
 * fetched again.
 *
 * The post ledger's entry for the message (`ledgerEntryFor`) goes to
 * `fetchMoment` as `ledgerEntry`, and the anchor stores the turn it names:
 * `mode`, `triggerKind` (null for a value a turn does not have) and
 * `sourceChannelId` (a routed call's source, else null). Without an entry
 * none of the three is stored and the anchor carries `triggerGuessed: true`,
 * as it does when `fetchMoment` answered another trigger than the entry's.
 *
 * With `fetchHistoryWindow`, the other channels the turn was shown are
 * stored as `pulled` windows (see `storedWindows`), cut as a live pull cuts
 * them (src/behavior/pull.js#pullWindow, `context.pull` from `config`), each
 * message with what the persona saw of its media: a routed call's source,
 * its window ending at the call (the anchor's `triggerId`); then the
 * channels named with an explicit `<#id>` in the history or the trigger
 * (src/behavior/pull.js#pullTargets, the slots the source leaves, each
 * passing src/discord/pull-fetch.js#checkPull's rails toward this channel,
 * `features.channelPull` on), their windows ending before her answer. A
 * channel whose window cannot be read is left out; a routed source whose
 * call is not in its window is refused.
 *
 * `original` is her burst's text, each message without the jump link it
 * carried (`withoutJumpLink`, `labels.elsewhere.link`).
 * @param {object} input
 * @param {string} input.ref                A message link or id (see `parseMessageRef`).
 * @param {string} input.guildId            The guild this instance serves.
 * @param {string|null} [input.contextChannelId]  Where the command was typed (for a bare id).
 * @param {string} input.selfId
 * @param {{ channels: { fetch: (id: string) => Promise<object|null> } }} input.client
 * @param {Function} input.fetchMoment      src/discord/collect.js#fetchMoment.
 * @param {number} input.limit              `mentor.anchor.contextMessages`.
 * @param {number} [input.embedTextChars]
 * @param {string[]} [input.videoSites]
 * @param {object|null} [input.mediaCache]  The describer's cache of the guild, read only (see
 *   `withSeenMedia`'s `cache`); without it the history carries no `mediaSeen`.
 * @param {object[]|null} [input.ledger]   The post ledger (`state.json` `postLedger`), read only.
 * @param {Function|null} [input.fetchHistoryWindow]  src/discord/collect.js#fetchHistoryWindow; without
 *   it no other channel is stored (and a routed answer is refused).
 * @param {object|null} [input.config]      The live config (`context.pull`, `features.channelPull`, `bot`).
 * @param {object|null} [input.labels]      The live labels (`elsewhere.link`).
 * @returns {Promise<{ channelId: string, messageId: string, triggerId: string, history: object[], original: string[],
 *   media: { described: number, none: number }, mode?: string|null, triggerKind?: string|null,
 *   sourceChannelId?: string|null, triggerGuessed?: true, pulled?: object[] }>}  `media` counts the media
 *   items of the history with and without a stored description, for the log.
 */
export async function resolveAnchor({
  ref,
  guildId,
  contextChannelId,
  selfId,
  client,
  fetchMoment,
  limit,
  embedTextChars,
  videoSites,
  mediaCache,
  ledger = null,
  fetchHistoryWindow = null,
  config = null,
  labels = null,
}) {
  const parsed = parseMessageRef(ref, { channelId: contextChannelId });
  if (parsed.dm) throw new Error('a direct message cannot be used');
  if (parsed.guildId && parsed.guildId !== String(guildId)) throw new Error('that message is in another server');
  let channel = null;
  try {
    channel = await client.channels.fetch(parsed.channelId);
  } catch {
    channel = null;
  }
  if (!channel) throw new Error('the bot cannot read that channel');
  if (!channel.guild) throw new Error('a direct message cannot be used');
  if (String(channel.guild.id) !== String(guildId)) throw new Error('that message is in another server');
  const entry = ledgerEntryFor(ledger, { channelId: String(channel.id), messageId: parsed.messageId });
  const moment = await fetchMoment(channel, parsed.messageId, { selfId, limit, embedTextChars, videoSites, ...(entry ? { ledgerEntry: entry } : {}) });
  const answeredAt = snowflakeTime(moment.messageId);
  const reading = { fetchHistoryWindow, selfId, embedTextChars, videoSites, config, cache: mediaCache ?? null, before: answeredAt };
  const seen = withSeenMedia(moment.history, { cache: reading.cache, sites: videoSites, before: answeredAt });

  // A call from a channel she cannot write in: the ledger names it and its source.
  const routedId = entry && isId(entry.sourceChannelId) && isId(entry.triggerId) ? entry.sourceChannelId : null;
  const source = routedId ? await routedWindow(client, { guildId, channelId: routedId, callId: entry.triggerId, reading }) : null;
  const triggerId = routedId ? entry.triggerId : moment.triggerId;
  const spontaneous = isSpontaneous(anchorMode(entry?.mode));
  const trigger = spontaneous ? null : source ? source.messages.find((m) => m.id === triggerId) : (seen.history.find((m) => m.id === triggerId) ?? null);
  const named = await namedWindows(channel, { history: seen.history, trigger, sourceId: routedId, answerId: moment.messageId, reading });

  const anchor = {
    channelId: String(channel.id),
    messageId: moment.messageId,
    triggerId,
    history: seen.history,
    original: moment.burst
      .map((message) => message.content)
      .filter((text) => typeof text === 'string')
      .map((text) => withoutJumpLink(text, { form: labels?.elsewhere?.link, guildId }))
      .filter((text) => text.trim()),
    media: { described: seen.described, none: seen.none },
  };
  if (entry) {
    anchor.mode = anchorMode(entry.mode);
    anchor.triggerKind = anchorKind(entry.triggerKind);
    anchor.sourceChannelId = routedId;
  }
  // The trigger is the ledger's only when fetchMoment took it (a routed call is the ledger's own).
  const guessed = !entry || (!routedId && (moment.triggerGuessed === true || (moment.triggerId ?? null) !== (entry.triggerId ?? null)));
  if (guessed) anchor.triggerGuessed = true;
  const pulled = [source, ...named].filter(Boolean);
  if (pulled.length > 0) anchor.pulled = pulled;
  return anchor;
}

/**
 * One other channel's window as an anchor stores it (see `storedWindows`):
 * the page of `fetchHistoryWindow` ending at `anchorId` (inclusive; a
 * message of another channel means "before it"), cut by pullWindow under
 * `context.pull` as a live pull cuts a page, each message with what the
 * persona saw of its media by `before`. Null without a fetcher, when the page
 * cannot be read or nothing is left.
 */
async function channelWindow(channel, { anchorId, reason, reading }) {
  const { fetchHistoryWindow, selfId, embedTextChars, videoSites, config, cache, before } = reading;
  if (!channel || typeof fetchHistoryWindow !== 'function') return null;
  const settings = pullSettings(config);
  const limit = Math.min(PAGE, Math.max(settings.maxMessages, settings.minMessages) + 1);
  let page;
  try {
    page = await fetchHistoryWindow(channel, { anchorId, limit, selfId, embedTextChars, videoSites });
  } catch {
    return null;
  }
  const window = pullWindow(page, {
    windowMinutes: settings.windowMinutes,
    minMessages: settings.minMessages,
    maxMessages: settings.maxMessages,
    pageFull: page.length >= limit,
  });
  if (window.skip) return null;
  return {
    channelId: String(channel.id),
    channelName: channel.name ?? null,
    readOnly: !canSend(channel),
    reason,
    messages: withSeenMedia(window.messages, { cache, sites: videoSites, before }).history,
    olderNotShown: window.olderNotShown,
  };
}

/**
 * The source window of a routed answer: channel `channelId` of the served
 * guild, its window ending at the call `callId`. Refused (CALL_UNREADABLE)
 * when the channel cannot be fetched or is another guild's, or its window
 * does not hold the call.
 */
async function routedWindow(client, { guildId, channelId, callId, reading }) {
  let source = null;
  try {
    source = await client.channels.fetch(channelId);
  } catch {
    source = null;
  }
  const ours = source?.guild && String(source.guild.id) === String(guildId);
  const window = ours ? await channelWindow(source, { anchorId: callId, reason: 'routed', reading }) : null;
  if (!window || !window.messages.some((message) => message.id === callId)) throw new Error(CALL_UNREADABLE);
  return window;
}

/**
 * The windows of the channels a turn in `channel` pulled for an explicit
 * `<#id>` (src/behavior/pull.js#pullTargets over the history and the
 * trigger, in the slots a routed source `sourceId` leaves), each judged by
 * src/discord/pull-fetch.js#checkPull toward `channel` as the channels and
 * the config stand now (only its age rail is measured at the time she
 * answered), each ending before her answer `answerId`. None with
 * `features.channelPull` off or without a fetcher.
 */
async function namedWindows(channel, { history, trigger, sourceId, answerId, reading }) {
  const { config } = reading;
  if (typeof reading.fetchHistoryWindow !== 'function' || !channelPullOn(config)) return [];
  const settings = pullSettings(config);
  const now = snowflakeTime(answerId) ?? undefined;
  const passed = new Map();
  const isPullable = (id) => {
    let checked = null;
    try {
      checked = checkPull({ guild: channel.guild, channelId: id, destination: channel, config, now });
    } catch {
      checked = null;
    }
    if (checked?.channel) passed.set(id, checked.channel);
    return Boolean(checked?.channel);
  };
  const targets = pullTargets({
    source: sourceId ? { channelId: sourceId, reason: 'routed' } : null,
    history,
    trigger,
    currentChannelId: String(channel.id),
    scanMessages: settings.scanMessages,
    maxChannels: settings.maxChannels,
    isPullable,
    channelPull: true,
  }).filter((target) => target.reason === 'mention');
  const windows = await Promise.all(targets.map((target) => channelWindow(passed.get(target.channelId), { anchorId: answerId, reason: 'mention', reading })));
  return windows.filter(Boolean);
}

/** `cache[key]` when it is the cache's own entry (never an inherited property), else undefined. */
function entryOf(cache, key) {
  return cache && typeof cache === 'object' && Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : undefined;
}

/**
 * The text of a describer cache entry the persona could have seen: not a
 * miss, a non-empty `text`, a watched video (`watched`) or a caption as asked,
 * and written no later than `before` (an entry without a time is taken; a
 * null `before` takes any time). Else null.
 */
function seenText(entry, { watched, before }) {
  if (!entry || typeof entry !== 'object' || entry.miss) return null;
  if ((entry.watched === true) !== watched) return null;
  if (typeof entry.text !== 'string' || !entry.text.trim()) return null;
  if (before !== null && Number.isFinite(entry.ts) && entry.ts > before) return null;
  return entry.text;
}

/**
 * The media items of one normalized message a live turn could have had
 * described (its forwarded snapshots included), as the live turn collects
 * them: `pictures` (src/discord/media.js#collectPictures and
 * #collectEmojiItems, describable ones) and `videos` (#collectVideos over
 * `sites`), each a list of distinct item ids.
 */
function mediaItemsOf(message, sites) {
  const pictures = [...collectPictures(message), ...collectEmojiItems(message)].filter(isDescribable).map((item) => item.itemId);
  const videos = collectVideos(message, { videoSites: Array.isArray(sites) ? sites : [] }).map((item) => item.itemId);
  return { pictures: [...new Set(pictures)], videos: [...new Set(videos)] };
}

/** A plain `{ id: text }` object of the string values of a stored map; {} for anything else. */
function storedTexts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, text]) => typeof text === 'string' && text.trim()));
}

/**
 * What the describer's cache held for one message's media by `before`:
 * `{ captions, watched }` (item id -> text) and its media item ids.
 */
function lookupSeen(message, cache, { sites, before }) {
  const { pictures, videos } = mediaItemsOf(message, sites);
  const captions = {};
  const watched = {};
  for (const id of pictures) {
    const text = seenText(entryOf(cache, id), { watched: false, before });
    if (text !== null) captions[id] = text;
  }
  for (const id of videos) {
    const text = seenText(entryOf(cache, `video:${id}`), { watched: true, before });
    if (text !== null) watched[id] = text;
  }
  return { captions, watched, ids: new Set([...pictures, ...videos]) };
}

/**
 * The history of a resolved moment with what the persona saw of its media:
 * each message whose media had a caption (a picture, a gif, a video's frame,
 * a link's thumbnail, a sticker, a custom emoji) or a watched summary (an
 * attached video, a video-site link over `sites`) in the describer's `cache`
 * by `before` (her answer's time) gets `mediaSeen: { captions?: { <item id>:
 * text }, watched?: { <item id>: text } }`, as a new object; every other
 * message is returned as it is. A cached miss, a limit or error state and an
 * entry written after `before` are no description. The cache and the history
 * are never changed. `described` / `none` count the media items (per
 * message) with and without one. Pure.
 * @param {object[]} history  Normalized messages (src/discord/collect.js#normalizeMessage).
 * @param {{ cache?: object|null, sites?: string[], before?: number|null }} [options]  `cache`: the
 *   describer's cache (`store.getMediaCache(guildId)`), or null -- the same options `replayMedia` takes.
 * @returns {{ history: object[], described: number, none: number }}
 */
export function withSeenMedia(history, { cache = null, sites = [], before = null } = {}) {
  let described = 0;
  let none = 0;
  const out = (Array.isArray(history) ? history : []).map((message) => {
    if (!message || typeof message !== 'object') return message;
    const { captions, watched, ids } = lookupSeen(message, cache, { sites, before });
    for (const id of ids) {
      if (Object.hasOwn(captions, id) || Object.hasOwn(watched, id)) described += 1;
      else none += 1;
    }
    const mediaSeen = {};
    if (Object.keys(captions).length > 0) mediaSeen.captions = captions;
    if (Object.keys(watched).length > 0) mediaSeen.watched = watched;
    return Object.keys(mediaSeen).length > 0 ? { ...message, mediaSeen } : message;
  });
  return { history: out, described, none };
}

/**
 * The caption and video maps a replayed moment's transcript is rendered
 * with (src/discord/format.js#formatTranscript's `descriptions` and
 * `videos`, the same the live turn passes): every message's stored
 * `mediaSeen` (see `withSeenMedia`), then, for a media item with none stored
 * (an anchor stored before descriptions were kept, among others), the
 * describer's `cache` as it stood by `before`, read only. A watched summary
 * is the video state `{ state: 'watched', text }`. Without either, empty maps:
 * the transcript renders as it always did. Pure.
 * @param {object[]} history
 * @param {{ cache?: object|null, sites?: string[], before?: number|null }} [options]
 * @returns {{ descriptions: Map<string, string>, videos: Map<string, { state: 'watched', text: string }> }}
 */
export function replayMedia(history, { cache = null, sites = [], before = null } = {}) {
  const descriptions = new Map();
  const videos = new Map();
  for (const message of Array.isArray(history) ? history : []) {
    if (!message || typeof message !== 'object') continue;
    const stored = message.mediaSeen && typeof message.mediaSeen === 'object' ? message.mediaSeen : {};
    const captions = storedTexts(stored.captions);
    const watched = storedTexts(stored.watched);
    const found = cache ? lookupSeen(message, cache, { sites, before }) : { captions: {}, watched: {} };
    for (const [id, text] of Object.entries({ ...found.captions, ...captions })) if (!descriptions.has(id)) descriptions.set(id, text);
    for (const [id, text] of Object.entries({ ...found.watched, ...watched })) if (!videos.has(id)) videos.set(id, { state: 'watched', text });
  }
  return { descriptions, videos };
}

/**
 * Whether a stored anchor can be replayed: a non-empty history and a trigger
 * (`storedTrigger`: the message its `triggerId` names, else the last one of
 * its history) that is not the persona's; a spontaneous turn (`mode`
 * `interject` / `initiate`) needs only the history. The one copy of the rule:
 * src/mentor/cases.js checks a moment with it before storing it.
 * @param {unknown} anchor
 * @returns {boolean}
 */
export function isUsableAnchor(anchor) {
  const history = anchor?.history;
  if (!Array.isArray(history) || history.length === 0 || !history[history.length - 1]) return false;
  if (isSpontaneous(anchor.mode)) return true;
  const trigger = storedTrigger(anchor);
  return Boolean(trigger) && trigger.self !== true;
}

/**
 * The anchors of a case as situations, in stored order: `{ title: '',
 * anchor: <id>, history, original, at, mode, kind, triggerId, source,
 * pulled }`, where `at` is when she answered (the time of her message's
 * snowflake, at least a second after the newest line she saw -- see
 * `newestSeenTs`; a minute after it when that time is unknown), so the
 * moment is replayed at its own time; `mode` and `kind` are the stored turn's
 * (`anchorMode`, `anchorKind`: null for an anchor stored without them, which
 * replays as a reply or a mention); `source` is `{ channelId, reason:
 * 'routed' }` for a routed call, else null; `pulled` its stored windows (see
 * `storedWindows`, `pulledFromStored`). An anchor that cannot be replayed is
 * left out. Pure.
 * @param {{ anchors?: object[] }} item  A case.
 * @returns {{ title: string, anchor: number, history: object[], original: string[], at: number,
 *   mode: string|null, kind: string|null, triggerId: string|null,
 *   source: { channelId: string, reason: 'routed' }|null, pulled: object[] }[]}
 */
export function anchorSituations(item) {
  return (Array.isArray(item?.anchors) ? item.anchors : []).filter(isUsableAnchor).map((anchor) => anchorSituation(anchor));
}

/** One stored anchor as a situation (see `anchorSituations`). */
function anchorSituation(anchor) {
  const seenTs = newestSeenTs(anchor) ?? 0;
  const answered = snowflakeTime(anchor.messageId);
  const at = answered !== null && answered > seenTs ? Math.max(answered, seenTs + 1000) : seenTs + FALLBACK_DELAY_MS;
  return {
    title: '',
    anchor: anchor.id,
    history: anchor.history,
    original: Array.isArray(anchor.original) ? anchor.original.filter((text) => typeof text === 'string') : [],
    at,
    mode: anchorMode(anchor.mode),
    kind: anchorKind(anchor.triggerKind),
    triggerId: isId(anchor.triggerId) ? anchor.triggerId : null,
    source: isId(anchor.sourceChannelId) ? { channelId: anchor.sourceChannelId, reason: 'routed' } : null,
    pulled: storedWindows(anchor.pulled),
  };
}

/**
 * The other channels a replayed moment shows, as a live turn hands them to
 * src/behavior/prompt.js#buildRequest: one PulledChannel record
 * (src/discord/pull-fetch.js) per stored window (`storedWindows`) -- its
 * captions the descriptions stored with its messages (`replayMedia`, no
 * cache), `picturesNotSeen` its pictures without one, no earlier calls and no
 * ring marks (the ring is not stored); `source`, the routed call's source
 * when its window is among them, else null; `readOnlyIds`, the windows of
 * channels the persona could not write in. An invented situation (no stored
 * windows) has none of them. Pure.
 * @param {{ pulled?: object[], source?: { channelId: string, reason: string }|null }|null|undefined} situation
 * @returns {{ pulled: object[], source: { channelId: string, reason: 'routed' }|null, readOnlyIds: Set<string> }}
 */
export function pulledFromStored(situation) {
  const pulled = storedWindows(situation?.pulled).map((window) => {
    const { descriptions } = replayMedia(window.messages);
    const { items, rest } = pullPictures(window.messages);
    const captioned = [...items, ...rest].filter((picture) => descriptions.has(picture.itemId)).length;
    return {
      channelId: window.channelId,
      channelName: window.channelName,
      readOnly: window.readOnly,
      reason: window.reason,
      messages: window.messages,
      earlierPingIds: new Set(),
      olderNotShown: window.olderNotShown,
      descriptions,
      picturesNotSeen: items.length + rest.length - captioned,
      pingState: new Map(),
    };
  });
  const sourceId = situation?.source?.reason === 'routed' ? situation.source.channelId : null;
  const source = isId(sourceId) && pulled.some((entry) => entry.channelId === sourceId) ? { channelId: sourceId, reason: 'routed' } : null;
  return { pulled, source, readOnlyIds: new Set(pulled.filter((entry) => entry.readOnly).map((entry) => entry.channelId)) };
}

/** The creation time (ms) carried by a Discord snowflake, or null for a value that is not one. */
export function snowflakeTime(id) {
  if (typeof id !== 'string' || !SNOWFLAKE.test(id)) return null;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}
