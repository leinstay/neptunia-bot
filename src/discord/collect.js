// Everything that reads from Discord: turning discord.js messages into plain
// normalized objects and fetching the context of a turn — the last N messages
// of the current channel plus a few fresh messages from neighbouring channels.

import { PermissionFlagsBits, SnowflakeUtil, MessageReferenceType } from 'discord.js';
import { log } from '../log.js';
import { classifyAttachment, classifyEmbed, stickerUrl, emojiUrl, linkThumbnailCacheKey } from './media.js';

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
 * existing per-message-index id, unchanged.
 */
function normalizeLinks(idPrefix, embeds, embedTextChars) {
  return [...(embeds ?? [])]
    .filter((embed) => embed?.url)
    .map((embed, index) => {
      const classified = classifyEmbed(embed, { embedTextChars });
      const id =
        classified.kind === 'link' && classified.thumbnailUrl
          ? linkThumbnailCacheKey(classified.thumbnailUrl)
          : `${idPrefix}#e${index}`;
      return { id, ...classified };
    });
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

/** A forwarded message (message snapshot): its own content, media and stickers, no id/channel/author. */
function normalizeSnapshot(snapshot, embedTextChars) {
  const isVoice = isVoiceMessageFlag(snapshot);
  const attachments = normalizeAttachments(snapshot.attachments, isVoice);
  const links = normalizeLinks(snapshot.id ?? 'fwd', snapshot.embeds, embedTextChars);
  const cleanContent = snapshot.cleanContent ?? snapshot.content ?? '';
  const emojis = extractEmojis(cleanContent);
  const rawContent = cleanEmoji(cleanContent).trim();
  return {
    content: stripEmbedUrls(rawContent, links),
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
 */
export function normalizeMessage(message, selfId, options = {}) {
  const embedTextChars = options.embedTextChars ?? 200;
  const isVoice = isVoiceMessageFlag(message);
  const attachments = normalizeAttachments(message.attachments, isVoice);
  const links = normalizeLinks(message.id, message.embeds, embedTextChars);
  const cleanContent = message.cleanContent ?? '';
  const emojis = extractEmojis(cleanContent);
  const rawContent = cleanEmoji(cleanContent).trim();
  const forwarded = [...(message.messageSnapshots?.values?.() ?? [])].map((snapshot) => normalizeSnapshot(snapshot, embedTextChars));

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
    content: stripEmbedUrls(rawContent, links),
    ts: message.createdTimestamp,
    replyToId: isForward ? null : (message.reference?.messageId ?? null),
    // The forwarded snapshot's source channel name, when it resolves in the
    // same guild -- see src/discord/format.js's `forwardedFrom` rendering.
    forwardedFrom: sourceChannel?.name ?? null,
    attachments,
    links,
    forwarded,
    stickers: normalizeStickers(message.stickers),
    emojis,
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

export function canSend(channel) {
  const me = channel.guild.members.me;
  if (!me || !channel.viewable) return false;
  return channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) ?? false;
}

/**
 * Last `limit` messages of a channel, oldest first, normalized.
 * @param {number} [embedTextChars]  Caps link/gif embed title+description (config.media.embedTextChars).
 */
export async function fetchHistory(channel, limit, selfId, embedTextChars) {
  const fetched = await channel.messages.fetch({ limit: Math.min(100, limit) });
  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => normalizeMessage(message, selfId, { embedTextChars }));
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
 * @param {{ anchorId?: string|null, limit: number, minTs?: number, selfId: string, embedTextChars?: number }} options
 * @returns {Promise<object[]>}
 */
export async function fetchHistoryWindow(channel, { anchorId, limit, minTs = 0, selfId, embedTextChars }) {
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
      collected.push(normalizeMessage(message, selfId, { embedTextChars }));
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
 * snowflake of their last message, so quiet channels cost no API calls.
 * @returns {Promise<{ channelName: string, messages: object[] }[]>}
 */
export async function fetchNeighbors(channel, config, selfId, now = Date.now()) {
  const { neighborMessages, neighborMaxAgeMinutes, neighborMaxChannels } = config.context;
  const minTs = now - neighborMaxAgeMinutes * 60_000;

  const candidates = readableChannels(channel.guild, config.bot, channel.id)
    .filter((other) => lastActivity(other) >= minTs)
    .sort((a, b) => lastActivity(b) - lastActivity(a))
    .slice(0, neighborMaxChannels);

  const results = await Promise.all(
    candidates.map(async (other) => {
      try {
        const messages = (await fetchHistory(other, neighborMessages, selfId, config.media?.embedTextChars)).filter(
          (m) => m.ts >= minTs,
        );
        return { channelName: other.name, messages };
      } catch (err) {
        log.warn('collect: neighbour channel fetch failed', { channel: other.id, error: err });
        return { channelName: other.name, messages: [] };
      }
    }),
  );
  return results.filter((result) => result.messages.length > 0);
}
