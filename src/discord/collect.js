// Everything that reads from Discord: turning discord.js messages into plain
// normalized objects and fetching the context of a turn — the last N messages
// of the current channel plus a few fresh messages from neighbouring channels.

import { PermissionFlagsBits, SnowflakeUtil, MessageReferenceType } from 'discord.js';
import { log } from '../log.js';
import {
  classifyAttachment,
  classifyEmbed,
  stickerUrl,
  emojiUrl,
  linkThumbnailCacheKey,
  discordCdnVideo,
  DISCORD_CDN_SITES,
} from './media.js';
import { extractVideoUrls, videoSiteFor, videoUrlCacheKey } from './video-sites.js';

const TEXT_PREVIEW_SIZE_GUARD = 256 * 1024; // 256 KB — never fetch a bigger "text" attachment
const MAX_EMOJIS_PER_MESSAGE = 5;
const CUSTOM_EMOJI_RE = /<(a)?:(\w+):(\d+)>/g;

/** Custom emoji markup `<:name:id>` / `<a:name:id>` reads better as `:name:`. */
function cleanEmoji(text) {
  return text.replace(/<a?:(\w+):\d+>/g, ':$1:');
}

/**
 * Custom emoji `<:name:id>` / `<a:name:id>` written in a message's text (the
 * text itself keeps reading as `:name:`, see cleanEmoji above): de-duplicated
 * by id, in first-appearance order, capped at MAX_EMOJIS_PER_MESSAGE.
 * @param {string} text  The same raw (pre-cleanEmoji) content cleanEmoji reads.
 * @returns {{ id: string, name: string, animated: boolean, url: string }[]}
 */
function extractEmojis(text) {
  const seen = new Map();
  CUSTOM_EMOJI_RE.lastIndex = 0;
  let match;
  while ((match = CUSTOM_EMOJI_RE.exec(String(text ?? '')))) {
    const [, animatedFlag, name, id] = match;
    if (seen.has(id)) continue;
    seen.set(id, { id, name, animated: Boolean(animatedFlag), url: emojiUrl(id) });
    if (seen.size >= MAX_EMOJIS_PER_MESSAGE) break;
  }
  return [...seen.values()];
}

/** Classified stickers of a message/snapshot: `{ id, name, format, url }` (see stickerUrl). */
function normalizeStickers(stickers) {
  return [...(stickers?.values?.() ?? [])].map((sticker) => ({
    id: sticker.id,
    name: sticker.name,
    format: sticker.format,
    url: stickerUrl(sticker.id, sticker.format),
  }));
}

/**
 * The reactions on a message: a custom emoji reads as `:name:`, a unicode one
 * as itself; `mine` is the bot's own. Sorted by count descending, ties keep
 * the collection's order; a count that is not a positive integer is skipped.
 * @returns {{ emoji: string, count: number, mine: boolean }[]}
 */
function normalizeReactions(reactions) {
  return [...(reactions?.cache?.values?.() ?? [])]
    .filter((reaction) => Number.isInteger(reaction?.count) && reaction.count > 0 && reaction.emoji?.name)
    .map((reaction) => ({
      emoji: reaction.emoji.id ? `:${reaction.emoji.name}:` : reaction.emoji.name,
      count: reaction.count,
      mine: Boolean(reaction.me),
    }))
    .sort((a, b) => b.count - a.count);
}

/** Whether the message carries Discord's voice-message flag (the whole message is flagged, not the attachment). */
function isVoiceMessageFlag(message) {
  try {
    return Boolean(message.flags?.has?.('IsVoiceMessage'));
  } catch {
    return false;
  }
}

/** Classified attachments of a message/snapshot, in Discord's own order. */
function normalizeAttachments(attachments, isVoice) {
  return [...(attachments?.values?.() ?? [])].map((attachment) => ({
    id: attachment.id,
    kind: classifyAttachment({ contentType: attachment.contentType, name: attachment.name, isVoice }),
    name: attachment.name,
    url: attachment.url,
    size: attachment.size ?? null,
    durationSec: attachment.duration ?? null,
  }));
}

/**
 * Classified embeds (only the ones with a URL: nothing to de-dupe or describe
 * otherwise). A `kind: 'link'` embed carrying a thumbnail (the newly
 * describable video-site preview, e.g. YouTube) gets a STABLE id
 * (`linkThumbnailCacheKey`, derived from the thumbnail URL, not the message)
 * instead of the usual per-message-index one, so a repost of the same video
 * shares one description-cache entry and the slim memory buffer never has to
 * store the URL to look it up again later (see src/memory/update.js
 * `observe()`/`analyze()`). A `kind: 'gif'` embed (tenor/giphy) keeps the
 * existing per-message-index id, unchanged. A `kind: 'link'` embed whose URL
 * is on one of `videoSites` takes `videoUrlCacheKey(url)` instead -- the same
 * id a typed link of that video gets (see normalizeLinks), so one video has
 * one id (and one video/still-frame cache entry) whether Discord embedded it
 * or not.
 */
function normalizeEmbedLinks(idPrefix, embeds, embedTextChars, videoSites) {
  const watchSites = Array.isArray(videoSites) && videoSites.length > 0;
  return [...(embeds ?? [])]
    .filter((embed) => embed?.url)
    .map((embed, index) => {
      const classified = classifyEmbed(embed, { embedTextChars });
      let id;
      if (classified.kind === 'link' && watchSites && videoSiteFor(classified.url, videoSites) !== null) {
        id = videoUrlCacheKey(classified.url);
      } else if (classified.kind === 'link' && classified.thumbnailUrl) {
        id = linkThumbnailCacheKey(classified.thumbnailUrl);
      } else {
        id = `${idPrefix}#e${index}`;
      }
      return { id, ...classified };
    });
}

/** Hostname without a leading `www.`, or '' for an unparsable URL. */
function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * The embed links (see normalizeEmbedLinks) followed by one synthetic link per
 * video-site URL typed in the text (`videoSites`, see
 * src/discord/video-sites.js) that no embed already carries -- compared by the
 * exact URL and by its canonical `videoUrlCacheKey`, so a video Discord did
 * embed is never listed twice. A synthetic link's id IS that cache key.
 * `embedLinks` is returned apart because only those URLs are stripped from
 * the message text: a typed video link stays readable where the person put it.
 */
function normalizeLinks(idPrefix, embeds, embedTextChars, rawContent, videoSites) {
  const embedLinks = normalizeEmbedLinks(idPrefix, embeds, embedTextChars, videoSites);
  const links = [...embedLinks];
  if (Array.isArray(videoSites) && videoSites.length > 0) {
    const seenUrls = new Set(embedLinks.map((link) => link.url));
    const seenKeys = new Set(embedLinks.map((link) => videoUrlCacheKey(link.url)));
    for (const url of extractVideoUrls(rawContent, videoSites)) {
      const key = videoUrlCacheKey(url);
      if (seenUrls.has(url) || seenKeys.has(key)) continue;
      seenUrls.add(url);
      seenKeys.add(key);
      links.push({ id: key, kind: 'link', site: siteOf(url), title: '', text: '', thumbnailUrl: null, url });
    }
  }
  return { embedLinks, links };
}

/**
 * Video attachments that arrive as a LINK to a Discord CDN attachment (see
 * discordCdnVideo) instead of an upload: taken from the embeds whose `url` is
 * one, then from such URLs typed in the text (found by extractVideoUrls over
 * the CDN hosts, the same extraction as a video-site link). Each becomes a
 * normal attachment entry `{ id, kind: 'video', name, url, size: null,
 * durationSec: null }`, the embed's URL preferred over a typed one of the same
 * id, de-duplicated by id against `attachments` (the real ones) and each
 * other. `embedUrls` are the embeds to drop from the links; `urls` every
 * matched URL, to strip from the text like a rendered embed's.
 * @returns {{ videos: object[], embedUrls: Set<string>, urls: string[] }}
 */
function cdnVideoAttachments(embeds, rawContent, attachments) {
  const known = new Set(attachments.map((attachment) => attachment.id));
  const byId = new Map();
  const embedUrls = new Set();
  const urls = [];
  const take = (url) => {
    const video = discordCdnVideo(url);
    if (!video) return false;
    urls.push(url);
    if (!known.has(video.id) && !byId.has(video.id)) {
      byId.set(video.id, { id: video.id, kind: 'video', name: video.name, url, size: null, durationSec: null });
    }
    return true;
  };
  for (const embed of embeds ?? []) {
    if (embed?.url && take(embed.url)) embedUrls.add(embed.url);
  }
  for (const url of extractVideoUrls(rawContent, DISCORD_CDN_SITES)) take(url);
  return { videos: [...byId.values()], embedUrls, urls };
}

/**
 * The media of a message or a snapshot: its real attachments followed by the
 * Discord CDN video links (see cdnVideoAttachments), the links without the
 * embeds of those videos, and the text with every rendered embed URL and
 * every CDN video URL stripped (an `<url>` form included).
 */
function normalizeMedia(idPrefix, source, isVoice, rawContent, embedTextChars, videoSites) {
  const real = normalizeAttachments(source.attachments, isVoice);
  const { embedLinks, links } = normalizeLinks(idPrefix, source.embeds, embedTextChars, rawContent, videoSites);
  const cdn = cdnVideoAttachments(source.embeds, rawContent, real);
  const stripped = cdn.urls.flatMap((url) => [{ url: `<${url}>` }, { url }]);
  return {
    attachments: [...real, ...cdn.videos],
    links: links.filter((link) => !cdn.embedUrls.has(link.url)),
    content: stripEmbedUrls(rawContent, [...stripped, ...embedLinks]),
  };
}

/** Remove the raw URL of every rendered link/gif embed from the message text, so it never appears twice. */
function stripEmbedUrls(content, links) {
  let result = content;
  for (const link of links) {
    if (!link.url) continue;
    result = result.split(link.url).join('');
  }
  return result.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * A forwarded message (message snapshot): its own content, media and stickers,
 * no id/channel/author. A Discord CDN video link in it becomes a video
 * attachment, as in the message itself (see normalizeMedia).
 */
function normalizeSnapshot(snapshot, embedTextChars, videoSites) {
  const isVoice = isVoiceMessageFlag(snapshot);
  const cleanContent = snapshot.cleanContent ?? snapshot.content ?? '';
  const emojis = extractEmojis(cleanContent);
  const rawContent = cleanEmoji(cleanContent).trim();
  const { attachments, links, content } = normalizeMedia(
    snapshot.id ?? 'fwd', snapshot, isVoice, rawContent, embedTextChars, videoSites,
  );
  return {
    content,
    attachments,
    links,
    stickers: normalizeStickers(snapshot.stickers),
    emojis,
  };
}

/**
 * Reduce a discord.js Message to the plain shape the rest of the code works
 * with. `options.embedTextChars` caps link/gif title+description text
 * (default `config.media.embedTextChars`, see config.json).
 * `options.videoSites` (default `[]`) lists the video-site hosts whose URLs
 * typed in the text become synthetic `link` items (see normalizeLinks), in
 * the message and its forwarded snapshots alike. A link to a Discord CDN
 * video attachment (embedded or typed) becomes a `video` attachment after the
 * real ones, not a link, with its URL stripped from `content` (see
 * cdnVideoAttachments), so it is labelled, watched and cached like an upload.
 * `reactions` lists the message's reactions (see normalizeReactions), `[]`
 * when it has none.
 * @param {object} message  A discord.js Message.
 * @param {string} selfId
 * @param {{ embedTextChars?: number, videoSites?: string[] }} [options]
 */
export function normalizeMessage(message, selfId, options = {}) {
  const embedTextChars = options.embedTextChars ?? 200;
  const videoSites = options.videoSites ?? [];
  const isVoice = isVoiceMessageFlag(message);
  const cleanContent = message.cleanContent ?? '';
  const emojis = extractEmojis(cleanContent);
  const rawContent = cleanEmoji(cleanContent).trim();
  const { attachments, links, content } = normalizeMedia(
    message.id, message, isVoice, rawContent, embedTextChars, videoSites,
  );
  const forwarded = [...(message.messageSnapshots?.values?.() ?? [])].map((snapshot) =>
    normalizeSnapshot(snapshot, embedTextChars, videoSites),
  );

  // A forward's `message.reference.messageId` is the ORIGINAL message, not
  // something this message replies to -- treating it as `replyToId` would
  // wrongly render a "replying to" marker. A reference with no `type` at all
  // (an older/plain payload) is a normal reply, never a forward.
  const isForward = message.reference?.type === MessageReferenceType.Forward;
  const sourceChannelId = isForward ? message.reference?.channelId : null;
  const sourceChannel = sourceChannelId ? message.guild?.channels?.cache?.get(sourceChannelId) : null;

  return {
    id: message.id,
    channelId: message.channelId,
    channelName: message.channel?.name ?? null,
    channelCategory: message.channel?.parent?.name ?? null,
    channelTopic: message.channel?.topic ?? null,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    self: message.author.id === selfId,
    bot: message.author.bot && message.author.id !== selfId,
    content,
    ts: message.createdTimestamp,
    // Real mentions -- the strongest signal for who this message names, see
    // src/behavior/prompt.js's <people> "asked about" window. `content`
    // above is `cleanContent`-derived and already reads "@DisplayName", so
    // this is the only place a stable member id survives normalization.
    mentionedUserIds: [...(message.mentions?.users?.keys?.() ?? [])],
    replyToId: isForward ? null : (message.reference?.messageId ?? null),
    // The forwarded snapshot's source channel name, when it resolves in the
    // same guild -- see src/discord/format.js's `forwardedFrom` rendering.
    forwardedFrom: sourceChannel?.name ?? null,
    attachments,
    links,
    forwarded,
    stickers: normalizeStickers(message.stickers),
    emojis,
    // Fresh on every history fetch (a REST call); a message straight from
    // messageCreate has none yet. Forwarded snapshots carry none.
    reactions: normalizeReactions(message.reactions),
  };
}

/**
 * The first `maxChars` characters of a text attachment's content, fetched
 * lazily — only ever called for a message that ends up inside a real
 * request (see src/behavior/prompt.js, src/memory/update.js), never during
 * plain normalization. A response bigger than 256 KB, or any fetch failure,
 * returns `null` so the caller falls back to the plain `file` form.
 * @param {string} url
 * @param {number} maxChars
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string|null>}
 */
export async function fetchTextPreview(url, maxChars, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > TEXT_PREVIEW_SIZE_GUARD) return null;
    const text = await response.text();
    if (!Number.isFinite(declaredSize) && Buffer.byteLength(text, 'utf8') > TEXT_PREVIEW_SIZE_GUARD) return null;
    return text.slice(0, maxChars);
  } catch (err) {
    log.warn('collect: text attachment preview fetch failed', { error: err });
    return null;
  }
}

/**
 * Return a shallow-cloned copy of `messages` with `previewText` filled in on
 * every `kind: 'text'` attachment that does not have one yet (best effort,
 * in parallel, never mutates the input). Meant to run once, right before the
 * messages are handed to buildRequest/buildMemoryRequest — see the header
 * comment of fetchTextPreview.
 * @param {object[]} messages
 * @param {number} maxChars
 * @param {typeof fetch} [fetchImpl]
 */
export async function withTextPreviews(messages, maxChars, fetchImpl = fetch) {
  return Promise.all(
    messages.map(async (message) => {
      const textAttachments = (message.attachments ?? []).filter((a) => a.kind === 'text' && !a.previewText);
      if (textAttachments.length === 0) return message;
      const previews = await Promise.all(textAttachments.map((a) => fetchTextPreview(a.url, maxChars, fetchImpl)));
      const byId = new Map(textAttachments.map((a, i) => [a.id, previews[i]]));
      return {
        ...message,
        attachments: message.attachments.map((a) =>
          byId.has(a.id) && byId.get(a.id) != null ? { ...a, previewText: byId.get(a.id) } : a,
        ),
      };
    }),
  );
}

/** Whether the config lets the persona read/act in this channel at all. */
export function channelAllowed(channel, botConfig) {
  const { allow = [], deny = [] } = botConfig.channels ?? {};
  if (deny.includes(channel.id)) return false;
  return allow.length === 0 || allow.includes(channel.id);
}

function canRead(channel) {
  const me = channel.guild.members.me;
  if (!me || !channel.viewable) return false;
  return channel.permissionsFor(me)?.has(PermissionFlagsBits.ReadMessageHistory) ?? false;
}

/**
 * Whether the bot may send messages in `channel`. A channel without a guild
 * (a private chat) has no member permissions: always yes.
 * @returns {boolean}
 */
export function canSend(channel) {
  if (!channel.guild) return true;
  const me = channel.guild.members.me;
  if (!me || !channel.viewable) return false;
  return channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) ?? false;
}

/**
 * Whether the bot may attach files in `channel` (a drawing is posted as one).
 * Resolved like canSend: no bot member, an unviewable channel or no
 * permissions for the member count as no; a channel without a guild (a
 * private chat) is always yes.
 * @returns {boolean}
 */
export function canAttach(channel) {
  if (!channel.guild) return true;
  const me = channel.guild.members.me;
  if (!me || !channel.viewable) return false;
  return channel.permissionsFor(me)?.has(PermissionFlagsBits.AttachFiles) ?? false;
}

/**
 * Last `limit` messages of a channel, oldest first, normalized.
 * @param {number} [embedTextChars]  Caps link/gif embed title+description (config.media.embedTextChars).
 * @param {string[]} [videoSites]  Video-site hosts whose typed URLs become link items (config.media.video.sites).
 */
export async function fetchHistory(channel, limit, selfId, embedTextChars, videoSites) {
  const fetched = await channel.messages.fetch({ limit: Math.min(100, limit) });
  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => normalizeMessage(message, selfId, { embedTextChars, videoSites }));
}

/** A Discord snowflake string one greater than `id`, so `before: bump(id)` includes `id` itself. */
function bumpSnowflake(id) {
  return (BigInt(id) + 1n).toString();
}

/**
 * Fetch a window of a channel's history, OLDEST first, for a memory history
 * backfill. Pages backwards 100 messages at a time, starting at `anchorId`
 * inclusive (or the channel's most recent message when `anchorId` is
 * absent), until `limit` messages are collected, the channel start is
 * reached (a page comes back short), or a message older than `minTs` is met
 * (only when `minTs > 0`). A page fetch error ends the window with whatever
 * was collected so far; it is logged, never thrown.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{ anchorId?: string|null, limit: number, minTs?: number, selfId: string, embedTextChars?: number,
 *   videoSites?: string[] }} options
 * @returns {Promise<object[]>}
 */
export async function fetchHistoryWindow(channel, { anchorId, limit, minTs = 0, selfId, embedTextChars, videoSites }) {
  const collected = []; // newest first while accumulating; reversed at the end
  let before = anchorId ? bumpSnowflake(anchorId) : undefined;

  while (collected.length < limit) {
    let page;
    try {
      page = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
    } catch (err) {
      log.warn('collect: history window fetch failed', { channel: channel.id, error: err });
      break;
    }
    const batch = [...page.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    if (batch.length === 0) break;

    let hitFloor = false;
    for (const message of batch) {
      if (minTs > 0 && message.createdTimestamp < minTs) {
        hitFloor = true;
        break;
      }
      collected.push(normalizeMessage(message, selfId, { embedTextChars, videoSites }));
      if (collected.length >= limit) break;
    }

    before = batch[batch.length - 1].id;
    if (hitFloor || batch.length < 100 || collected.length >= limit) break;
  }

  return collected.reverse();
}

/** Plain text channels of a guild the persona may read, excluding threads and `exceptId`. */
export function readableChannels(guild, botConfig, exceptId = null) {
  return [...guild.channels.cache.values()].filter(
    (channel) =>
      channel.id !== exceptId &&
      channel.isTextBased() &&
      !channel.isThread() &&
      channelAllowed(channel, botConfig) &&
      canRead(channel),
  );
}

/** Timestamp of the newest message in a channel, from its snowflake — no API call. */
export function lastActivity(channel) {
  return channel.lastMessageId ? SnowflakeUtil.timestampFrom(channel.lastMessageId) : 0;
}

/**
 * Up to `neighborMessages` recent messages from each neighbouring channel that
 * saw activity within `neighborMaxAgeMinutes`. Channels are pre-filtered by the
 * snowflake of their last message, so quiet channels cost no API calls. A
 * channel without a guild (a private chat) has no neighbours.
 * @returns {Promise<{ channelId: string, channelName: string, messages: object[] }[]>}
 */
export async function fetchNeighbors(channel, config, selfId, now = Date.now()) {
  if (!channel.guild) return [];
  const { neighborMessages, neighborMaxAgeMinutes, neighborMaxChannels } = config.context;
  const minTs = now - neighborMaxAgeMinutes * 60_000;

  const candidates = readableChannels(channel.guild, config.bot, channel.id)
    .filter((other) => lastActivity(other) >= minTs)
    .sort((a, b) => lastActivity(b) - lastActivity(a))
    .slice(0, neighborMaxChannels);

  const results = await Promise.all(
    candidates.map(async (other) => {
      try {
        const messages = (
          await fetchHistory(other, neighborMessages, selfId, config.media?.embedTextChars, config.media?.video?.sites)
        ).filter((m) => m.ts >= minTs);
        return { channelId: other.id, channelName: other.name, messages };
      } catch (err) {
        log.warn('collect: neighbour channel fetch failed', { channel: other.id, error: err });
        return { channelId: other.id, channelName: other.name, messages: [] };
      }
    }),
  );
  return results.filter((result) => result.messages.length > 0);
}
