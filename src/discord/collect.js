// Everything that reads from Discord: turning discord.js messages into plain
// normalized objects and fetching the context of a turn — the last N messages
// of the current channel plus a few fresh messages from neighbouring channels.

import { PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import { log } from '../log.js';

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/i;

/** Custom emoji markup `<:name:id>` / `<a:name:id>` reads better as `:name:`. */
function cleanEmoji(text) {
  return text.replace(/<a?:(\w+):\d+>/g, ':$1:');
}

/** Reduce a discord.js Message to the plain shape the rest of the code works with. */
export function normalizeMessage(message, selfId) {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    self: message.author.id === selfId,
    bot: message.author.bot && message.author.id !== selfId,
    content: cleanEmoji(message.cleanContent ?? '').trim(),
    ts: message.createdTimestamp,
    replyToId: message.reference?.messageId ?? null,
    attachments: [...message.attachments.values()].map((attachment) => ({
      kind: IMAGE_TYPES.test(attachment.contentType ?? '') ? 'image' : 'file',
      name: attachment.name,
      url: attachment.url,
    })),
    stickers: [...message.stickers.values()].map((sticker) => sticker.name),
  };
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

/** Last `limit` messages of a channel, oldest first, normalized. */
export async function fetchHistory(channel, limit, selfId) {
  const fetched = await channel.messages.fetch({ limit: Math.min(100, limit) });
  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => normalizeMessage(message, selfId));
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
        const messages = (await fetchHistory(other, neighborMessages, selfId)).filter((m) => m.ts >= minTs);
        return { channelName: other.name, messages };
      } catch (err) {
        log.warn('collect: neighbour channel fetch failed', { channel: other.id, error: err });
        return { channelName: other.name, messages: [] };
      }
    }),
  );
  return results.filter((result) => result.messages.length > 0);
}
