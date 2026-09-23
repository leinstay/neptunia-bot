// The message pipeline: turns a raw discord.js `messageCreate` event into one
// of a handful of outcomes (ignore, observe into memory, let the spontaneous
// scheduler eavesdrop, or run a turn) without ever throwing into discord.js.
// Owner commands are a separate pipeline entirely (src/discord/commands.js,
// driven by `interactionCreate`, not `messageCreate`). Kept free of
// discord.js-specific assumptions beyond the shape already used by
// src/discord/collect.js, so it can be driven with plain fake objects in
// tests.

import { normalizeMessage, channelAllowed, canSend, fetchHistory } from './collect.js';
import { collectPictures, collectEmojiItems, collectVideos, collectReadableLinks, isDescribable } from './media.js';
import {
  detectTrigger,
  strippedLength,
  decideMention,
  repeatWindowMs,
  isFollowUpOpen,
  followUpPreFilter,
  parseFollowUpVerdict,
  classifierTextModel,
} from '../behavior/mention.js';
import { formatTranscript, renderTranscript } from './format.js';
import { addPending, isExpired, popOldest } from '../behavior/pending.js';
import { between } from '../behavior/turn.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { log } from '../log.js';

// The most pictures one observed message warms the describer cache for --
// this runs per real-time message, not per batch, so it stays cheap.
const MAX_WARM_PICTURES_PER_MESSAGE = 2;
// The most videos one observed message has watched ahead of time
// (media.video.prefill): watching is far dearer than a picture caption.
const MAX_WARM_VIDEOS_PER_MESSAGE = 1;
// The most links one observed message has read ahead of time (web.links.prefill).
const MAX_WARM_LINKS_PER_MESSAGE = 1;
// Only when web.links.prefillPerUserPerDay is missing (config.json always has it).
const PREFILL_PER_USER_PER_DAY_FALLBACK = 10;

/**
 * @param {object} deps
 * @param {import('../hot.js').createHot extends (...args: any) => infer R ? R : never} deps.hot
 * @param {ReturnType<import('../memory/store.js').createStore>} deps.store
 * @param {import('discord.js').Client} deps.client
 * @param {ReturnType<import('../behavior/turn.js').createTurnRunner>} deps.turns
 * @param {ReturnType<import('../behavior/spontaneous.js').createSpontaneous>} deps.spontaneous
 * @param {ReturnType<import('../memory/update.js').createMemoryUpdater>} deps.memory
 * @param {ReturnType<import('../behavior/mention.js').createTagHistory>} deps.tagHistory
 * @param {object} [deps.llm]  From createLlm() (src/llm/openrouter.js), used ONLY for the address
 *   classifier (`features.followUp`): a message with no trigger, arriving while a
 *   conversation window this instance opened by answering is still open, is checked here before
 *   ever running a turn. Absent -- an older/direct caller, or a test that never opens a window --
 *   simply means `features.followUp` cannot ever fire (nothing reaches this dependency otherwise).
 * @param {() => string | null} deps.getGuildId  the single guild this instance serves, or null before it resolves
 * @param {() => boolean} [deps.isWarmingUp]  true while the memory warmup runner
 *   (src/memory/warmup.js) is in flight: messages are still observed, but no
 *   trigger, turn, eavesdrop or pending-ping drain happens. Default: never warming up.
 * @param {object} [deps.describer]  From createDescriber() (src/memory/describe.js), optional: when
 *   absent, or features.mediaDescriptions is off, no description request is ever made from this
 *   pipeline. When present, every observed human message's pictures (up to
 *   MAX_WARM_PICTURES_PER_MESSAGE) are handed to it fire-and-forget -- never awaited here, errors
 *   swallowed -- so the cache is already warm by the time the live memory analyzer
 *   (src/memory/update.js#analyze) wants a caption for one of them; the analyzer itself never
 *   triggers a new request. With features.mediaDescriptions, features.videoDescriptions (a missing
 *   key counts as on) and media.video.prefill all on, the message's first video
 *   (MAX_WARM_VIDEOS_PER_MESSAGE) is handed to `describer.describeVideos` the same way.
 * @param {object} [deps.lookup]  From createLookup() (src/web/lookup.js), optional: with
 *   features.webLookup, web.links.enabled and web.links.prefill on, the message's first readable
 *   link (MAX_WARM_LINKS_PER_MESSAGE) is handed to `lookup.readLinks` the same way. Absent -> no
 *   link is ever read from this pipeline.
 * @param {() => number} [deps.rng]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]  Used only for the "human switch pause"
 *   before answering a deferred pending ping (mention.switchDelayMs) -- see drainPending below.
 * @returns {(message: import('discord.js').Message) => Promise<void>} Also carries a
 *   `.drainPending()` method: called once a turn finishes anywhere (src/index.js wires it to
 *   src/behavior/turn.js's `setOnIdle`, in the same `finally` that frees the channel) to answer
 *   the oldest non-expired pending direct ping, one at a time, after a human switch pause. And a
 *   `.clearPending()` method (`/nep pause`, wired from src/admin.js via src/index.js) that
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
  llm,
  lookup,
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
    warmLinkCache(guildId, normalized);
    if (!describer) return;
    warmVideoCache(guildId, normalized);
    if (hot.config.features?.mediaDescriptions !== true) return;
    // Pictures (attachments/embeds/stickers) before the message's custom
    // emoji, both filtered to what the describer can actually caption.
    const candidates = [...collectPictures(normalized), ...collectEmojiItems(normalized)]
      .filter(isDescribable)
      .slice(0, MAX_WARM_PICTURES_PER_MESSAGE);
    if (candidates.length === 0) return;
    describer.describeMany(guildId, candidates).catch((err) => log.warn('events: media cache prefill failed', { error: err }));
  }

  /** Fire-and-forget like warmMediaCache: watch the message's first video now, not when a turn needs it. */
  function warmVideoCache(guildId, normalized) {
    const config = hot.config;
    const features = config.features ?? {};
    // Both switches, like the senses line (src/behavior/prompt.js#renderSenses); a missing
    // videoDescriptions counts as on.
    if (features.mediaDescriptions !== true || features.videoDescriptions === false) return;
    if (config.media?.video?.prefill !== true) return;
    if (typeof describer.describeVideos !== 'function') return;
    const candidates = collectVideos(normalized, { sites: config.media.video.sites }).slice(0, MAX_WARM_VIDEOS_PER_MESSAGE);
    if (candidates.length === 0) return;
    describer
      .describeVideos(guildId, candidates)
      .catch((err) => log.warn('events: video cache prefill failed', { error: err }));
  }

  /**
   * Fire-and-forget like warmMediaCache: read the message's first readable
   * link now (src/web/lookup.js), not when a turn needs it. Needs
   * features.webLookup (a missing key counts as OFF: it costs money),
   * web.links.enabled (a missing key counts as on) and web.links.prefill.
   * One member gets at most `web.links.prefillPerUserPerDay` new fetches a
   * UTC day this way (in memory; cache hits are free), so posting links
   * cannot spend `web.maxPerDay` for everyone. The turn path is not limited.
   */
  function warmLinkCache(guildId, normalized) {
    if (typeof lookup?.readLinks !== 'function') return;
    const config = hot.config;
    if (config.features?.webLookup !== true) return;
    const linksCfg = config.web?.links ?? {};
    if (linksCfg.enabled === false || linksCfg.prefill !== true) return;
    const links = collectReadableLinks(normalized, { sites: config.media?.video?.sites ?? [] }).slice(0, MAX_WARM_LINKS_PER_MESSAGE);
    if (links.length === 0) return;
    const perUser = Number.isFinite(linksCfg.prefillPerUserPerDay)
      ? Math.max(0, Math.floor(linksCfg.prefillPerUserPerDay))
      : PREFILL_PER_USER_PER_DAY_FALLBACK;
    const slot = reservePrefill(`${guildId}:${normalized.authorId ?? ''}`, links.length, perUser);
    if (slot.granted === 0) return;
    Promise.resolve()
      .then(() => lookup.readLinks(guildId, links, { maxNew: slot.granted }))
      .then((result) => refundPrefill(slot, slot.granted - (result?.newCount ?? 0)))
      .catch((err) => log.warn('events: link prefill failed', { error: err }));
  }

  // Per-(guild, author) prefill counts for the current UTC day; cleared when the day turns.
  const prefillCounts = new Map();
  let prefillDay = null;

  /** Take up to `wanted` of the member's remaining daily prefill slots: `{ key, day, granted }`. */
  function reservePrefill(key, wanted, perUser) {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (day !== prefillDay) {
      prefillDay = day;
      prefillCounts.clear();
    }
    const used = prefillCounts.get(key) ?? 0;
    const granted = Math.max(0, Math.min(wanted, perUser - used));
    if (granted > 0) prefillCounts.set(key, used + granted);
    return { key, day, granted };
  }

  /** Give back the slots a prefill did not spend on a new fetch (a cache hit, a fresh miss, the daily cap). */
  function refundPrefill(slot, unused) {
    if (unused <= 0 || slot.day !== prefillDay) return;
    const used = prefillCounts.get(slot.key) ?? 0;
    prefillCounts.set(slot.key, Math.max(0, used - unused));
  }

  // --- The address classifier (mention.followUp*) ---------------------------
  // A conversation window per channel: (re)opened and extended to `now`
  // whenever the persona sends a message there -- hooked in the self-message
  // branch of onMessage below (the same place turns.notePost() is called),
  // never here. An untagged message that arrives while the window is open is
  // not answered blindly: it goes through address.md first (see
  // docs/prompt-contract.md, "The address classifier").
  //
  // The Map is mirrored into `store.state.data.followUpWindows` (timestamps
  // and a counter only, never message text) so a restart does not close
  // every open window; the saved entries are loaded back just below.
  let missingAddressPromptLogged = false;
  const followUpWindows = new Map(); // channelId -> { openedAt, lastAnswerAt, noStreak }
  const followUpInFlight = new Set(); // channelIds with a classifier call running right now

  /** Mirror one window into state.json (a fresh copy, numbers only). */
  function persistFollowUpWindow(channelId, window) {
    const state = store?.state;
    if (!state?.data) return;
    if (!state.data.followUpWindows || typeof state.data.followUpWindows !== 'object') state.data.followUpWindows = {};
    state.data.followUpWindows[channelId] = {
      openedAt: window.openedAt,
      lastAnswerAt: window.lastAnswerAt,
      noStreak: window.noStreak,
    };
    state.markDirty?.();
  }

  /** Close a window: drop it from the Map and delete its key from state.json. */
  function closeFollowUpWindow(channelId) {
    followUpWindows.delete(channelId);
    const saved = store?.state?.data?.followUpWindows;
    if (saved && typeof saved === 'object' && Object.hasOwn(saved, channelId)) {
      delete saved[channelId];
      store.state.markDirty?.();
    }
  }

  /**
   * Startup: load the saved windows back, dropping (and deleting from state)
   * any whose last answer is already older than `mention.followUpMinutes`
   * (read now) or that is malformed.
   */
  function loadFollowUpWindows() {
    const saved = store?.state?.data?.followUpWindows;
    if (!saved || typeof saved !== 'object') return;
    const minutes = hot.config.mention?.followUpMinutes ?? 15;
    const t = now();
    let dropped = 0;
    for (const [channelId, entry] of Object.entries(saved)) {
      const valid =
        entry &&
        Number.isFinite(entry.openedAt) &&
        Number.isFinite(entry.lastAnswerAt) &&
        Number.isFinite(entry.noStreak);
      if (valid && t - entry.lastAnswerAt < minutes * 60_000) {
        followUpWindows.set(channelId, { openedAt: entry.openedAt, lastAnswerAt: entry.lastAnswerAt, noStreak: entry.noStreak });
      } else {
        delete saved[channelId];
        dropped += 1;
      }
    }
    if (dropped > 0) store.state.markDirty?.();
    if (followUpWindows.size > 0 || dropped > 0) log.info('follow-up: windows restored', { restored: followUpWindows.size, dropped });
  }
  loadFollowUpWindows();

  /** (Re)opens/extends the window -- called wherever the persona's own message is observed. */
  function noteFollowUpSend(channelId, ts) {
    const window = { openedAt: ts, lastAnswerAt: ts, noStreak: 0 };
    followUpWindows.set(channelId, window);
    persistFollowUpWindow(channelId, window);
  }

  /** One "no" verdict (pre-filter or model): bump the streak, close the window once the streak reaches the limit. */
  function bumpFollowUpNoStreak(channelId, state, mentionCfg) {
    state.noStreak += 1;
    // A window replaced meanwhile (the persona spoke again while a classifier
    // call was in flight) is not the live one: nothing to mirror or close.
    if (followUpWindows.get(channelId) !== state) return;
    if (state.noStreak >= (mentionCfg.followUpNoStreak ?? 3)) {
      log.info('follow-up: window closed', { channel: channelId });
      closeFollowUpWindow(channelId);
    } else {
      persistFollowUpWindow(channelId, state);
    }
  }

  /**
   * The classifier's request: system = address.md (`{{name}}` filled), user =
   * the last `mention.followUpContext` lines of the channel plus the new
   * message wrapped in a `<candidate>` block (structural, not model-facing
   * wording). `null` when `prompts.address` is missing -- the caller treats
   * that the same as a "no".
   */
  async function buildFollowUpRequest({ config, prompts, channel, selfId, selfName, normalized }) {
    const addressPrompt = prompts?.address;
    if (!addressPrompt) return null;
    const labels = prompts.labels;
    const contextLines = Math.max(0, config.mention.followUpContext ?? 15);
    const raw = contextLines > 0 ? await fetchHistory(channel, contextLines, selfId, config.media?.embedTextChars, config.media?.video?.sites) : [];
    const history = raw.filter((m) => m.id !== normalized.id);
    const items = formatTranscript([...history, normalized], {
      timezone: config.bot.timezone,
      gapMinutes: config.context.gapMarkerMinutes,
      maxChars: config.context.maxMessageChars,
      selfName,
      labels,
    });
    const candidateItem = items[items.length - 1];
    const transcript = renderTranscript(items.slice(0, -1), config.bot.timezone, labels);
    return {
      system: fillPromptTemplate(addressPrompt, { name: selfName }),
      user: `${transcript}\n<candidate>\n${candidateItem.text}\n</candidate>`,
    };
  }

  /**
   * Whether an untagged `normalized` message was fully handled by the address
   * classifier (pre-filter or a real model verdict, "yes" or "no" alike) --
   * the caller must then NOT also hand it to the spontaneous scheduler. Never
   * throws: an LLM/context-building error is treated as a "no" per the
   * contract. `false` means none of this applied (feature off, no open
   * window, busy in this channel, or a classifier call already in flight for
   * it) and the caller falls back to its usual handling.
   */
  async function maybeFollowUp(message, normalized, selfId) {
    const config = hot.config;
    const features = config.features ?? {};
    if (features.followUp === false || features.mentions === false) return false;

    const channel = message.channel;
    const channelId = channel.id;
    const mentionCfg = config.mention;
    const state = followUpWindows.get(channelId);
    if (!isFollowUpOpen(state, now(), mentionCfg)) {
      if (state) closeFollowUpWindow(channelId); // expired: forget it here and in state.json
      return false;
    }
    if (turns.isBusy(channelId)) return false;
    if (!canSend(channel)) return false;

    const startedAt = now();
    if (followUpPreFilter(normalized, selfId)) {
      log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict: 'no', ms: now() - startedAt });
      bumpFollowUpNoStreak(channelId, state, mentionCfg);
      return true;
    }

    // At most one classifier call in flight per channel: a message landing
    // while one is already running is left alone entirely -- no verdict, no
    // streak change, nothing logged, exactly as if the window were closed.
    if (followUpInFlight.has(channelId)) return true;

    followUpInFlight.add(channelId);
    try {
      const selfName = channel.guild.members.me?.displayName ?? client.user.username;
      let request = null;
      try {
        request = await buildFollowUpRequest({ config, prompts: hot.prompts, channel, selfId, selfName, normalized });
      } catch (err) {
        log.warn('follow-up: building the classifier request failed', { channel: channelId, error: err });
      }

      if (!request) {
        if (!missingAddressPromptLogged) {
          missingAddressPromptLogged = true;
          log.warn('follow-up: prompts.address is missing, every follow-up is treated as "no"', {});
        }
        log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict: 'no', ms: now() - startedAt });
        bumpFollowUpNoStreak(channelId, state, mentionCfg);
        return true;
      }

      let verdict = 'no';
      if (llm) {
        try {
          // A classifier call skipped by the daily cap (DailyCapError, thrown
          // synchronously before any fetch) lands here exactly like any other
          // error -- "no", logged, no request ever left the process.
          const completion = await llm.complete(
            [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            {
              model: classifierTextModel(config),
              maxOutputTokens: mentionCfg.followUpMaxOutputTokens,
              countAgainstDailyCap: true,
              skipCalibration: true,
            },
          );
          verdict = parseFollowUpVerdict(completion.text);
        } catch {
          verdict = 'no';
        }
      }

      log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict, ms: now() - startedAt });

      if (verdict === 'yes') {
        // Still counted for spam (mention.spamThreshold, future explicit
        // pings), just never rolled for the ignore chance -- a follow-up is a
        // continuation, not a ping (see docs/prompt-contract.md).
        tagHistory.hit(normalized.authorId, now(), repeatWindowMs(mentionCfg));
        turns
          .runTurn({ channel, mode: 'reply', trigger: normalized, triggerKind: 'followUp' })
          .catch((err) => log.error('events: follow-up reply turn failed', { channel: channelId, error: err }));
      } else {
        bumpFollowUpNoStreak(channelId, state, mentionCfg);
      }
      return true;
    } finally {
      followUpInFlight.delete(channelId);
    }
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
   * which would otherwise start a second overlapping drain. A no-op while
   * `isWarmingUp()` is true -- the queue is left untouched for a later
   * call once the warmup run ends.
   */
  async function drainPending() {
    if (draining || isWarmingUp()) return;
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
          roll: decision.roll === undefined ? undefined : Math.round(decision.roll * 100) / 100,
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

      // 1b. Paused (owner editing data/ by hand, /nep pause): the
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
      const normalized = normalizeMessage(message, selfId, { videoSites: config.media?.video?.sites });
      const guildId = message.guild.id;

      // 5. Its own message: only bookkeeping. Also (re)opens/extends the
      // follow-up window for this channel -- see noteFollowUpSend above.
      if (normalized.self) {
        turns.notePost(normalized.channelId, normalized.ts);
        noteFollowUpSend(normalized.channelId, normalized.ts);
        if (memoryOn) memory.observe(guildId, normalized);
        return;
      }

      // 6. Other bots are never answered, never memorised.
      if (message.author.bot) return;

      // 7. A memory warmup run is in flight: the persona stays mute (no
      // trigger, no turn, no eavesdrop), but the message still feeds the
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

      // 10. No trigger: maybe a follow-up (features.followUp) inside a
      // window the persona itself opened by answering -- fully handled by
      // maybeFollowUp either way (a computed verdict or a deliberate no-op,
      // see its own header comment); otherwise let the spontaneous scheduler
      // eavesdrop, nothing more.
      if (!kind) {
        const followedUp = await maybeFollowUp(message, normalized, selfId);
        if (!followedUp) spontaneous.onMessage(message.channel, normalized);
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
        roll: decision.roll === undefined ? undefined : Math.round(decision.roll * 100) / 100,
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
  /** Drop every pending direct ping without answering any of them (`/nep pause`). */
  onMessage.clearPending = () => {
    pendingList = [];
  };
  return onMessage;
}
