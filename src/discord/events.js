// The message pipeline: turns a raw discord.js `messageCreate` event into one
// of a handful of outcomes (ignore, observe into memory, let the spontaneous
// scheduler eavesdrop, or run a turn) without ever throwing into discord.js.
// Owner commands are a separate pipeline entirely (src/discord/commands.js,
// driven by `interactionCreate`, not `messageCreate`). Kept free of
// discord.js-specific assumptions beyond the shape already used by
// src/discord/collect.js, so it can be driven with plain fake objects in
// tests.

import { normalizeMessage, channelAllowed, canSend } from './collect.js';
import { collectPictures, collectEmojiItems, isDescribable } from './media.js';
import { detectTrigger, strippedLength, decideMention, repeatWindowMs } from '../behavior/mention.js';
import { addPending, isExpired, popOldest } from '../behavior/pending.js';
import { between } from '../behavior/turn.js';
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
 * @param {(ms: number) => Promise<void>} [deps.sleep]  Used only for the "human switch pause"
 *   before answering a deferred pending ping (mention.switchDelayMs) -- see drainPending below.
 * @returns {(message: import('discord.js').Message) => Promise<void>} Also carries a
 *   `.drainPending()` method: called once a turn finishes anywhere (src/index.js wires it to
 *   src/behavior/turn.js's `setOnIdle`, in the same `finally` that frees the channel) to answer
 *   the oldest non-expired pending direct ping, one at a time, after a human switch pause. And a
 *   `.clearPending()` method (F30, `/nep pause`, wired from src/admin.js via src/index.js) that
 *   drops every queued ping without answering any of them.
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
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    // Pictures (attachments/embeds/stickers) before the message's custom
    // emoji, both filtered to what the describer can actually caption.
    const candidates = [...collectPictures(normalized), ...collectEmojiItems(normalized)]
      .filter(isDescribable)
      .slice(0, MAX_WARM_PICTURES_PER_MESSAGE);
    if (candidates.length === 0) return;
    describer.describeMany(guildId, candidates).catch((err) => log.warn('events: media cache warm-up failed', { error: err }));
  }

  // --- One attention (mention.oneAtATime): pending direct pings ------------
  // A @mention or a reply to the persona that arrives while a turn is
  // running in another channel is remembered here instead of dropped; see
  // src/behavior/pending.js for the plain queue operations. Never persisted.
  let pendingList = [];
  let draining = false; // guards against a re-entrant drainPending() call (see below)

  /** Same cached-then-fetch existence check `resolveReference` uses, generalised to any message id. */
  async function messageStillExists(channel, messageId) {
    const cached = channel.messages.cache.get(messageId);
    if (cached) return true;
    const fetched = await channel.messages.fetch(messageId).catch(() => null);
    return Boolean(fetched);
  }

  /**
   * Remember a direct ping (mention/reply) that arrived while the persona's
   * one attention is busy elsewhere. At most one per channel -- a newer ping
   * replaces an older one already queued for the same channel -- and at most
   * mention.maxPending channels; the oldest is evicted when full.
   */
  function enqueuePending(channel, trigger, kind) {
    const maxPending = hot.config.mention.maxPending ?? 3;
    const ping = { channelId: channel.id, channel, trigger, kind, arrivedAt: now() };
    const { list, evicted } = addPending(pendingList, ping, maxPending);
    pendingList = list;
    log.info('mention: deferred', { channel: channel.id, kind, pending: pendingList.length });
    if (evicted) log.info('mention: dropped (full)', { channel: evicted.channelId, kind: evicted.kind });
  }

  /**
   * Answers pending direct pings, oldest first, one at a time, each after a
   * human "switch" pause (mention.switchDelayMs) -- called once a turn
   * finishes anywhere (src/index.js wires this to src/behavior/turn.js's
   * `setOnIdle`, in the same `finally` that frees the channel). The ignore
   * decision (decideMention) is rolled HERE, not when the ping arrived. A
   * message deleted meanwhile, or a channel that lost send permission, is
   * dropped silently. Guarded against re-entrancy: the turn this function
   * itself starts also frees the channel through the very same `onIdle`,
   * which would otherwise start a second overlapping drain.
   */
  async function drainPending() {
    if (draining) return;
    draining = true;
    try {
      while (pendingList.length > 0) {
        const { ping, list } = popOldest(pendingList);
        pendingList = list;
        if (!ping) break;

        const mentionCfg = hot.config.mention;
        if (isExpired(ping, now(), mentionCfg.pendingMinutes ?? 10)) {
          log.info('mention: expired', { channel: ping.channelId, kind: ping.kind });
          continue;
        }

        log.info('mention: picked up', { channel: ping.channelId, kind: ping.kind });
        await sleep(between(mentionCfg.switchDelayMs ?? [2000, 9000], rng));

        if (!canSend(ping.channel)) continue;
        if (!(await messageStillExists(ping.channel, ping.trigger.id))) continue;

        const config = hot.config;
        const features = config.features ?? {};
        const memoryOn = features.memory !== false;
        const relationshipsOn = features.relationships !== false;
        const guildId = ping.channel.guild.id;
        const recentCalls = tagHistory.hit(ping.trigger.authorId, now(), repeatWindowMs(config.mention));
        const selfName = ping.channel.guild.members.me?.displayName ?? client.user.username;
        const affinityScore =
          memoryOn && relationshipsOn ? store?.getUser?.(guildId, ping.trigger.authorId)?.affinity?.score : undefined;
        const decision = decideMention({
          kind: ping.kind,
          textLength: strippedLength(ping.trigger.content, selfName),
          recentCalls,
          neverIgnore: config.mention.neverIgnore.includes(ping.trigger.authorId),
          affinityScore,
          cfg: config.mention,
          rng,
        });

        log.info('mention: decided', {
          kind: ping.kind,
          reason: decision.reason,
          ignoreChance: decision.ignoreChance,
          author: ping.trigger.authorId,
          channel: ping.channelId,
          deferred: true,
        });

        if (decision.respond) {
          try {
            await turns.runTurn({ channel: ping.channel, mode: 'reply', trigger: ping.trigger, triggerKind: ping.kind });
          } catch (err) {
            log.error('events: deferred reply turn failed', { channel: ping.channelId, error: err });
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  async function onMessage(message) {
    try {
      // 1. System / webhook messages are not conversation.
      if (message.system || message.webhookId) return;

      // 1b. Paused (owner editing data/ by hand, /nep pause, F30): the
      // persona does nothing at all -- no observe, no trigger, no turn, no
      // eavesdrop -- and nothing below may mark the store dirty.
      if (store?.state?.data?.paused) return;

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

      // 11b. One attention (mention.oneAtATime, default on): while a turn is
      // running in ANOTHER channel, a direct call (mention/reply) is worth
      // remembering as pending instead of dropping -- everything else (a
      // name trigger) is simply skipped, same as the same-channel busy drop
      // further below (unchanged: runTurn itself returns 'busy' for it).
      const oneAtATime = config.mention.oneAtATime !== false;
      const sameChannelBusy = turns.isBusy(message.channel.id);
      const busyElsewhere = oneAtATime && !sameChannelBusy && turns.isAnyBusy();
      if (busyElsewhere) {
        if (kind === 'mention' || kind === 'reply') {
          enqueuePending(message.channel, normalized, kind);
        } else {
          log.info('mention: dropped (busy)', { channel: message.channel.id, kind });
        }
        return;
      }

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

  onMessage.drainPending = drainPending;
  /** Drop every pending direct ping without answering any of them (F30, `/nep pause`). */
  onMessage.clearPending = () => {
    pendingList = [];
  };
  return onMessage;
}
