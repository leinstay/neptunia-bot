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
 * @param {() => string | null} deps.getGuildId  the single guild this instance serves, or null before it resolves
 * @param {() => boolean} [deps.isWarmingUp]  true while the memory warm-up (src/memory/warmup.js) is still due or
 *   running: messages are still observed and owner commands still work, but no trigger, turn or eavesdrop happens.
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
  getGuildId,
  isWarmingUp = () => false,
  rng = Math.random,
  now = Date.now,
}) {
  async function resolveReference(message, selfId) {
    const refId = message.reference?.messageId;
    if (!refId) return false;
    const cached = message.channel.messages.cache.get(refId);
    const ref = cached ?? (await message.channel.messages.fetch(refId).catch(() => null));
    return ref?.author?.id === selfId;
  }

  async function onMessage(message) {
    try {
      // 1. System / webhook messages are not conversation.
      if (message.system || message.webhookId) return;

      const config = hot.config;
      const features = config.features ?? {};
      const adminCommandsOn = features.adminCommands !== false;
      const memoryOn = features.memory !== false;

      // 2. DMs: only the owner admin console lives there, the persona never chats in DMs.
      if (!message.guild) {
        if (adminCommandsOn) await admin.handle(message);
        return;
      }

      // 3. This instance serves exactly one guild; channel allowlist/denylist, no threads.
      if (message.guild.id !== getGuildId()) return;
      if (message.channel.isThread?.()) return;
      if (!channelAllowed(message.channel, config.bot)) return;

      // 3b. The dry-run mirror channel carries the persona's own rehearsal
      // output (src/behavior/turn.js), never real conversation: everything
      // posted there is ignored entirely, so it can never feed back into
      // memory, a trigger or the spontaneous scheduler.
      const dryRunChannelId = config.bot.dryRunChannelId;
      if (dryRunChannelId && message.channel.id === dryRunChannelId) return;

      // 4. Normalize.
      const selfId = client.user.id;
      const normalized = normalizeMessage(message, selfId);
      const guildId = message.guild.id;

      // 5. Its own message: only bookkeeping.
      if (normalized.self) {
        turns.notePost(normalized.channelId, normalized.ts);
        if (memoryOn) memory.observe(guildId, normalized);
        return;
      }

      // 6. Other bots are never answered, never memorised.
      if (message.author.bot) return;

      // 7. Owner commands short-circuit before anything is observed.
      if (adminCommandsOn && (await admin.handle(message))) return;

      // 7b. The memory warm-up is still running/due: the persona stays mute
      // (no trigger, no turn, no eavesdrop), but the message still feeds the
      // memory buffer like any other observed message.
      if (isWarmingUp()) {
        if (memoryOn) memory.observe(guildId, normalized, { direct: false });
        return;
      }

      // 8. Detect how (if at all) the persona was called, masking each input
      // by its own feature switch so detectTrigger itself stays pure. Done
      // BEFORE memory observes the message, so the buffer can mark it.
      const mentionsSelf = features.mentions !== false && message.mentions.users.has(selfId);
      const repliesToSelf = features.replies !== false && (await resolveReference(message, selfId));
      const nameTriggers = features.nameTriggers !== false ? config.bot.nameTriggers : [];
      const kind = detectTrigger({
        mentionsSelf,
        repliesToSelf,
        content: normalized.content,
        nameTriggers,
      });

      // 9. Everyone else feeds memory; a message addressed to the persona is
      // marked `direct` so the analyzer can weigh it separately.
      if (memoryOn) memory.observe(guildId, normalized, { direct: Boolean(kind) });

      // 10. No trigger: let the spontaneous scheduler eavesdrop, nothing more.
      if (!kind) {
        spontaneous.onMessage(message.channel, normalized);
        return;
      }

      // 11. The persona was called: decide whether to actually answer.
      if (!canSend(message.channel)) return;

      const recentCalls = tagHistory.hit(normalized.authorId, now(), repeatWindowMs(config.mention));
      const selfName = message.guild.members.me?.displayName ?? client.user.username;
      const relationshipsOn = features.relationships !== false;
      const affinityScore =
        memoryOn && relationshipsOn ? store?.getUser?.(guildId, normalized.authorId)?.affinity?.score : undefined;
      const decision = decideMention({
        kind,
        textLength: strippedLength(normalized.content, selfName),
        recentCalls,
        neverIgnore: config.mention.neverIgnore.includes(normalized.authorId),
        affinityScore,
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
