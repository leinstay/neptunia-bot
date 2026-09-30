// Real moments of the chat as mentor situations ("anchors"). The owner points
// at one message of the persona he did not like; the moment is the chat that
// led to it -- up to and including the message that called for the answer,
// the trigger -- and her whole answer as she gave it. The chat is fetched once
// and stored with the case, so it is replayed as it was even after the
// channel moves on or a message is deleted; names and reactions stay as they
// were at fetch time. In a run each anchor is a situation of its own,
// answered from its stored history with today's prompts and memory.
//
// Parsing a message reference and shaping stored anchors is pure; the one
// fetch goes through an injected client and src/discord/collect.js#fetchMoment.
//
// The persona saw more of the chat's media than its labels: the describer's
// captions and watched summaries (src/memory/describe.js, cached in
// data/guilds/<id>/media.json). When a moment is resolved, the ones cached
// by the time she answered are stored with their message (`mediaSeen`), and
// a replay renders them the way the live transcript did. The cache is only
// read: nothing is downloaded, described or written.

import { collectEmojiItems, collectPictures, collectVideos, isDescribable } from '../discord/media.js';

const LINK = /^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)\/?>?$/i;
const SNOWFLAKE = /^\d{15,22}$/;
const DISCORD_EPOCH = 1420070400000n;
/** How long after the trigger an anchor is replayed when her message's time is unknown. */
const FALLBACK_DELAY_MS = 60_000;

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
 * cannot be fetched or read, and whatever `fetchMoment` refuses (a message
 * that is not the persona's among them).
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
 *   `withSeenMedia`); without it the history carries no `mediaSeen`.
 * @returns {Promise<{ channelId: string, messageId: string, triggerId: string, history: object[], original: string[],
 *   media: { described: number, none: number } }>}  `media` counts the media items of the history
 *   with and without a stored description, for the log.
 */
export async function resolveAnchor({ ref, guildId, contextChannelId, selfId, client, fetchMoment, limit, embedTextChars, videoSites, mediaCache }) {
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
  const moment = await fetchMoment(channel, parsed.messageId, { selfId, limit, embedTextChars, videoSites });
  const seen = withSeenMedia(moment.history, mediaCache ?? null, { sites: videoSites, before: snowflakeTime(moment.messageId) });
  return {
    channelId: String(channel.id),
    messageId: moment.messageId,
    triggerId: moment.triggerId,
    history: seen.history,
    original: moment.burst.map((message) => message.content).filter((text) => typeof text === 'string' && text.trim()),
    media: { described: seen.described, none: seen.none },
  };
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
  const videos = collectVideos(message, { sites: Array.isArray(sites) ? sites : [] }).map((item) => item.itemId);
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
 * @param {object|null} cache  The describer's cache (`store.getMediaCache(guildId)`), or null.
 * @param {{ sites?: string[], before?: number|null }} [options]
 * @returns {{ history: object[], described: number, none: number }}
 */
export function withSeenMedia(history, cache, { sites = [], before = null } = {}) {
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

/** Whether a stored anchor can be replayed: a history that ends with a message not by the persona. */
export function isUsableAnchor(anchor) {
  const history = anchor?.history;
  return Array.isArray(history) && history.length > 0 && Boolean(history[history.length - 1]) && history[history.length - 1].self !== true;
}

/**
 * The anchors of a case as situations, in stored order: `{ title: '',
 * anchor: <id>, history, original, at }`, where `at` is when she answered
 * (the time of her message's snowflake, at least a second after the trigger;
 * a minute after the trigger when that time is unknown), so the moment is
 * replayed at its own time. An anchor that cannot be replayed is left out. Pure.
 * @param {{ anchors?: object[] }} item  A case.
 * @returns {{ title: string, anchor: number, history: object[], original: string[], at: number }[]}
 */
export function anchorSituations(item) {
  return (Array.isArray(item?.anchors) ? item.anchors : []).filter(isUsableAnchor).map((anchor) => anchorSituation(anchor));
}

/** One stored anchor as a situation (see `anchorSituations`). */
export function anchorSituation(anchor) {
  const trigger = anchor.history[anchor.history.length - 1];
  const triggerTs = Number.isFinite(trigger?.ts) ? trigger.ts : 0;
  const answered = snowflakeTime(anchor.messageId);
  const at = answered !== null && answered > triggerTs ? Math.max(answered, triggerTs + 1000) : triggerTs + FALLBACK_DELAY_MS;
  return {
    title: '',
    anchor: anchor.id,
    history: anchor.history,
    original: Array.isArray(anchor.original) ? anchor.original.filter((text) => typeof text === 'string') : [],
    at,
  };
}

/** The creation time (ms) carried by a Discord snowflake, or null for a value that is not one. */
export function snowflakeTime(id) {
  if (typeof id !== 'string' || !SNOWFLAKE.test(id)) return null;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}
