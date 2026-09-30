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
 * @returns {Promise<{ channelId: string, messageId: string, triggerId: string, history: object[], original: string[] }>}
 */
export async function resolveAnchor({ ref, guildId, contextChannelId, selfId, client, fetchMoment, limit, embedTextChars, videoSites }) {
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
  return {
    channelId: String(channel.id),
    messageId: moment.messageId,
    triggerId: moment.triggerId,
    history: moment.history,
    original: moment.burst.map((message) => message.content).filter((text) => typeof text === 'string' && text.trim()),
  };
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
