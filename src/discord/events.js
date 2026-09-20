// The message pipeline: turns a raw discord.js `messageCreate` event into one
// of a handful of outcomes (ignore, hand to admin, observe into memory, let
// the spontaneous scheduler eavesdrop, or run a turn) without ever throwing
// into discord.js. Kept free of discord.js-specific assumptions beyond the
// shape already used by src/discord/collect.js, so it can be driven with
// plain fake objects in tests.

import { normalizeMessage, channelAllowed, canSend } from './collect.js';
import { detectTrigger, strippedLength, decideMention, repeatWindowMs } from '../behavior/mention.js';
import { log } from '../log.js';

/**
 * @param {object} deps
 * @param {import('../hot.js').createHot extends (...args: any) => infer R ? R : never} deps.hot
 * @param {ReturnType<import('../memory/store.js').createStore>} deps.store
 * @param {import('discord.js').Client} deps.client
 * @param {ReturnType<import('../behavior/turn.js').createTurnRunner>} deps.turns
 * @param {ReturnType<import('../behavior/spontaneous.js').createSpontaneous>} deps.spontaneous
 * @param {ReturnType<import('../memory/update.js').createMemoryUpdater>} deps.memory
 * @param {ReturnType<import('../admin.js').createAdmin>} deps.admin
 * @param {ReturnType<import('../behavior/mention.js').createTagHistory>} deps.tagHistory
 * @param {() => number} [deps.rng]
 * @param {() => number} [deps.now]
 * @returns {(message: import('discord.js').Message) => Promise<void>}
 */
export function createMessageHandler({
  hot,
  store,
  client,
  turns,
  spontaneous,
  memory,
  admin,
  tagHistory,
  rng = Math.random,
  now = Date.now,
}) {
  async function resolveReference(message, selfId, replyToBotCounts) {
    const refId = message.reference?.messageId;
    if (!refId || !replyToBotCounts) return false;
    const cached = message.channel.messages.cache.get(refId);
    const ref = cached ?? (await message.channel.messages.fetch(refId).catch(() => null));
    return ref?.author?.id === selfId;
  }

  async function onMessage(message) {
    try {
      // 1. System / webhook messages are not conversation.
      if (message.system || message.webhookId) return;

      // 2. DMs: only the owner admin console lives there, she never chats in DMs.
      if (!message.guild) {
        await admin.handle(message);
        return;
      }

      const config = hot.config;

      // 3. Guild allowlist, channel allowlist/denylist, no threads.
      const allowedGuilds = config.bot.guilds ?? [];
      if (allowedGuilds.length > 0 && !allowedGuilds.includes(message.guild.id)) return;
      if (message.channel.isThread?.()) return;
      if (!channelAllowed(message.channel, config.bot)) return;

      // 4. Normalize.
      const selfId = client.user.id;
      const normalized = normalizeMessage(message, selfId);
      const guildId = message.guild.id;

      // 5. Her own message: only bookkeeping.
      if (normalized.self) {
        turns.notePost(normalized.channelId, normalized.ts);
        memory.observe(guildId, normalized);
        return;
      }

      // 6. Other bots are never answered, never memorised.
      if (message.author.bot) return;

      // 7. Owner commands short-circuit before anything is observed.
      if (await admin.handle(message)) return;

      // 8. Everyone else feeds memory.
      memory.observe(guildId, normalized);

      // 9. Detect how (if at all) she was called.
      const mentionsSelf = message.mentions.users.has(selfId);
      const repliesToSelf = await resolveReference(message, selfId, config.mention.replyToBotCounts);
      const kind = detectTrigger({
        mentionsSelf,
        repliesToSelf,
        content: normalized.content,
        nameTriggers: config.bot.nameTriggers,
      });

      // 10. No trigger: let the spontaneous scheduler eavesdrop, nothing more.
      if (!kind) {
        spontaneous.onMessage(message.channel, normalized);
        return;
      }

      // 11. She was called: decide whether to actually answer.
      if (!canSend(message.channel)) return;

      const recentCalls = tagHistory.hit(normalized.authorId, now(), repeatWindowMs(config.mention));
      const selfName = message.guild.members.me?.displayName ?? client.user.username;
      const decision = decideMention({
        kind,
        textLength: strippedLength(normalized.content, selfName),
        recentCalls,
        neverIgnore: config.mention.neverIgnore.includes(normalized.authorId),
        cfg: config.mention,
        rng,
      });

      log.info('mention: decided', {
        kind,
        reason: decision.reason,
        ignoreChance: decision.ignoreChance,
        author: normalized.authorId,
        channel: message.channel.id,
      });

      if (decision.respond) {
        turns
          .runTurn({ channel: message.channel, mode: 'reply', trigger: normalized, triggerKind: kind })
          .catch((err) => log.error('events: reply turn failed', { channel: message.channel.id, error: err }));
      }
    } catch (err) {
      log.error('events: message handler failed', { error: err });
    }
  }

  return onMessage;
}
