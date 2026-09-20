// The message pipeline: turns a raw discord.js `messageCreate` event into one
// of a handful of outcomes (ignore, observe into memory, let the spontaneous
// scheduler eavesdrop, or run a turn) without ever throwing into discord.js.
// Owner commands are a separate pipeline entirely (src/discord/commands.js,
// driven by `interactionCreate`, not `messageCreate`). Kept free of
// discord.js-specific assumptions beyond the shape already used by
// src/discord/collect.js, so it can be driven with plain fake objects in
// tests.

import { normalizeMessage, channelAllowed, canSend } from './collect.js';
import { collectPictures, isDescribable } from './media.js';
import { detectTrigger, strippedLength, decideMention, repeatWindowMs } from '../behavior/mention.js';
import { log } from '../log.js';

// The most pictures one observed message warms the describer cache for --
// this runs per real-time message, not per batch, so it stays cheap.
const MAX_WARM_PICTURES_PER_MESSAGE = 2;

/**
 * @param {object} deps
 * @param {import('../hot.js').createHot extends (...args: any) => infer R ? R : never} deps.hot
 * @param {ReturnType<import('../memory/store.js').createStore>} deps.store
 * @param {import('discord.js').Client} deps.client
 * @param {ReturnType<import('../behavior/turn.js').createTurnRunner>} deps.turns
 * @param {ReturnType<import('../behavior/spontaneous.js').createSpontaneous>} deps.spontaneous
 * @param {ReturnType<import('../memory/update.js').createMemoryUpdater>} deps.memory
 * @param {ReturnType<import('../behavior/mention.js').createTagHistory>} deps.tagHistory
 * @param {() => string | null} deps.getGuildId  the single guild this instance serves, or null before it resolves
 * @param {() => boolean} [deps.isWarmingUp]  true while the memory warm-up (src/memory/warmup.js) is still due or
 *   running: messages are still observed, but no trigger, turn or eavesdrop happens.
 * @param {object} [deps.describer]  From createDescriber() (src/memory/describe.js), optional: when
 *   absent, or features.mediaDescriptions is off, no description request is ever made from this
 *   pipeline. When present, every observed human message's pictures (up to
 *   MAX_WARM_PICTURES_PER_MESSAGE) are handed to it fire-and-forget -- never awaited here, errors
 *   swallowed -- so the cache is already warm by the time the live memory analyzer
 *   (src/memory/update.js#analyze) wants a caption for one of them; the analyzer itself never
 *   triggers a new request.
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
  tagHistory,
  getGuildId,
  isWarmingUp = () => false,
  describer,
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

  /**
   * Fire-and-forget: never awaited from the message path (see the class
   * doc). A no-op when the feature is off or no describer was wired in, so
   * this pipeline makes zero describer calls in that case.
   */
  function warmMediaCache(guildId, normalized) {
    if (!describer || hot.config.features?.mediaDescriptions !== true) return;
    const candidates = collectPictures(normalized).filter(isDescribable).slice(0, MAX_WARM_PICTURES_PER_MESSAGE);
    if (candidates.length === 0) return;
    describer.describeMany(guildId, candidates).catch((err) => log.warn('events: media cache warm-up failed', { error: err }));
  }

  async function onMessage(message) {
    try {
      // 1. System / webhook messages are not conversation.
      if (message.system || message.webhookId) return;

      const config = hot.config;
      const features = config.features ?? {};
      const memoryOn = features.memory !== false;

      // 2. DMs: the persona never chats in DMs, and owner commands are slash
      // commands now (src/discord/commands.js, interactionCreate) — a DM
      // carries nothing this pipeline needs to see.
      if (!message.guild) return;

      // 3. This instance serves exactly one guild; channel allowlist/denylist, no threads.
      if (message.guild.id !== getGuildId()) return;
      if (message.channel.isThread?.()) return;
      if (!channelAllowed(message.channel, config.bot)) return;

      // 3b. The dry-run mirror channel is the owner's private test room: it
      // carries the persona's own rehearsal output (src/behavior/turn.js),
      // never real conversation. Nothing posted here is ever observed into
      // memory, no trigger is detected, no turn runs, no eavesdrop.
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

      // 7. The memory warm-up is still running/due: the persona stays mute
      // (no trigger, no turn, no eavesdrop), but the message still feeds the
      // memory buffer like any other observed message.
      if (isWarmingUp()) {
        warmMediaCache(guildId, normalized);
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
      warmMediaCache(guildId, normalized);
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
