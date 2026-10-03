// The message pipeline: turns a raw discord.js `messageCreate` event into one
// of a handful of outcomes (ignore, observe into memory, let the spontaneous
// scheduler eavesdrop, or run a turn) without ever throwing into discord.js.
// A direct message goes through the private-chat gate instead
// (features.privateMessages, src/behavior/private.js). A triggered turn
// refused by a rail gets one plain limit notice (src/behavior/limits.js).
// Owner commands are a separate pipeline entirely (src/discord/commands.js,
// driven by `interactionCreate`, not `messageCreate`). Kept free of
// discord.js-specific assumptions beyond the shape already used by
// src/discord/collect.js, so it can be driven with plain fake objects in
// tests.

import { normalizeMessage, channelAllowed, canSend, fetchHistory } from './collect.js';
import { isOwnerId } from './access.js';
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
import { fill, formatTranscript, renderTranscript } from './format.js';
import { topByRank } from '../memory/ranking.js';
import { addPending, isExpired, popOldest, requeuePending } from '../behavior/pending.js';
import { between } from '../behavior/random.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { privateGate } from '../behavior/private.js';
import { isLimitNotice, postLimitNotice } from '../behavior/limits.js';
import { log } from '../log.js';
import { MINUTE_MS, utcDay } from '../time.js';

/** @typedef {import('../behavior/turn.js').TurnOutcome} TurnOutcome */
/** @typedef {import('../behavior/turn.js').TriggerKind} TriggerKind */

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
 * @param {(guildId: string) => string} [deps.getSelfName]  The persona's display name in a guild
 *   (src/index.js). Default: the client's cached guild member, else the bot user's name.
 * @param {() => boolean} [deps.isWarmingUp]  true while the memory warmup runner
 *   (src/memory/warmup.js) is in flight: messages are still observed, but no
 *   trigger, turn, eavesdrop or pending-ping drain happens. Default: never warming up.
 * @param {object} [deps.describer]  From createDescriber() (src/memory/describe.js), optional: when
 *   absent, or features.mediaDescriptions is off, no description request is ever made from this
 *   pipeline. When present, every observed human message's pictures (up to
 *   MAX_WARM_PICTURES_PER_MESSAGE) are handed to it fire-and-forget -- errors swallowed -- so the
 *   cache is already warm by the time the live memory analyzer (src/memory/update.js#analyze)
 *   wants a caption for one of them; the analyzer itself never triggers a new request. Only the
 *   address classifier awaits a message's own prefill, then reads captions from the cache alone
 *   (`describer.cachedDescriptions` / `cachedVideos`), never a new request. With
 *   features.mediaDescriptions, features.videoDescriptions (a missing key counts as on) and
 *   media.video.prefill all on, the message's first video
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
  getSelfName = (guildId) => client.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client.user?.username ?? 'bot',
  isWarmingUp = () => false,
  describer,
  llm,
  lookup,
  rng = Math.random,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  /**
   * Whether the message `replyToId` (normalizeMessage's: a forward has none)
   * is one of the persona's own: the channel's cache first, then a fetch.
   */
  async function resolveReference(channel, replyToId, selfId) {
    if (!replyToId) return false;
    const cached = channel.messages.cache.get(replyToId);
    const ref = cached ?? (await channel.messages.fetch(replyToId).catch(() => null));
    return ref?.author?.id === selfId;
  }

  /**
   * Whether a turn blocks a new one in `channelId` (config read by the caller
   * now): with one attention (mention.oneAtATime, default on) a turn running
   * anywhere, otherwise one running in this channel -- the rule runTurn applies.
   */
  function turnBlocked(channelId, config) {
    return config.mention?.oneAtATime !== false ? turns.isAnyBusy() : turns.isBusy(channelId);
  }

  /**
   * Fire-and-forget: the message path never waits on it (see
   * createMessageHandler). A no-op when the feature is off or no describer was wired in, so
   * this pipeline makes zero describer calls in that case. Returns the
   * picture prefill's promise (it never rejects), or null when none started:
   * only the address classifier awaits it, so a sticker- or picture-only
   * follow-up reaches it with its caption (see cachedFollowUpMedia).
   * @returns {Promise<void>|null}
   */
  function warmMediaCache(guildId, normalized) {
    warmLinkCache(guildId, normalized);
    if (!describer) return null;
    warmVideoCache(guildId, normalized);
    if (hot.config.features?.mediaDescriptions !== true) return null;
    const candidates = describableItems([normalized]).slice(0, MAX_WARM_PICTURES_PER_MESSAGE);
    if (candidates.length === 0) return null;
    return describer
      .describeMany(guildId, candidates)
      .then(() => {})
      .catch((err) => log.warn('events: media cache prefill failed', { error: err }));
  }

  /**
   * The describable items of `messages`, in order: each message's pictures
   * (attachments/embeds/stickers) before its custom emoji, both filtered to
   * what the describer can actually caption.
   */
  function describableItems(messages) {
    return messages.flatMap((m) => [...collectPictures(m), ...collectEmojiItems(m)].filter(isDescribable));
  }

  /**
   * What the address classifier's transcript shows of `messages`' media:
   * `{ descriptions, videos }` read from the describer's cache only -- no
   * new request, nothing counted. `ownPrefill` (the candidate's own picture
   * prefill from warmMediaCache, already running) is awaited first, so the
   * candidate's caption is in the cache when it can be; it is never started
   * again here. Empty without a describer or with features.mediaDescriptions
   * off (read now).
   */
  async function cachedFollowUpMedia(guildId, messages, config, ownPrefill) {
    if (!describer || config.features?.mediaDescriptions !== true) return {};
    if (ownPrefill) await ownPrefill;
    const media = {};
    if (typeof describer.cachedDescriptions === 'function') {
      media.descriptions = describer.cachedDescriptions(guildId, describableItems(messages));
    }
    if (typeof describer.cachedVideos === 'function') {
      const sites = config.media?.video?.sites;
      const items = messages.flatMap((m) => collectVideos(m, { videoSites: sites }));
      if (items.length > 0) media.videos = await describer.cachedVideos(guildId, items);
    }
    return media;
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
    const candidates = collectVideos(normalized, { videoSites: config.media.video.sites }).slice(0, MAX_WARM_VIDEOS_PER_MESSAGE);
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
    const links = collectReadableLinks(normalized, { videoSites: config.media?.video?.sites ?? [] }).slice(0, MAX_WARM_LINKS_PER_MESSAGE);
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
    const day = utcDay(now());
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
  const followUpHeld = new Map(); // channelId -> { message, normalized, selfId, ownPrefill }: the latest message that arrived in flight

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
   * (read now) or that is malformed. Started paused (`/nep pause`), the
   * dropped ones are only left out of the Map: state.json is not touched.
   */
  function loadFollowUpWindows() {
    const saved = store?.state?.data?.followUpWindows;
    if (!saved || typeof saved !== 'object') return;
    const paused = Boolean(store.state.data.paused);
    const minutes = hot.config.mention?.followUpMinutes ?? 15;
    const t = now();
    let dropped = 0;
    for (const [channelId, entry] of Object.entries(saved)) {
      const valid =
        entry &&
        Number.isFinite(entry.openedAt) &&
        Number.isFinite(entry.lastAnswerAt) &&
        Number.isFinite(entry.noStreak);
      if (valid && t - entry.lastAnswerAt < minutes * MINUTE_MS) {
        followUpWindows.set(channelId, { openedAt: entry.openedAt, lastAnswerAt: entry.lastAnswerAt, noStreak: entry.noStreak });
      } else {
        if (!paused) delete saved[channelId];
        dropped += 1;
      }
    }
    if (dropped > 0 && !paused) store.state.markDirty?.();
    if (followUpWindows.size > 0 || dropped > 0) {
      log.info('follow-up: windows restored', { restored: followUpWindows.size, dropped, ...(paused ? { paused: true } : {}) });
    }
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
   * the last `mention.followUpContext` lines of the channel, then an
   * `<author>` block when the new message's author has stored aliases
   * (followUpAuthorLine), then the new message wrapped in a `<candidate>`
   * block (tags structural, not model-facing wording). Pictures, stickers, emoji and videos carry the captions the
   * describer already cached (cachedFollowUpMedia). `null` when
   * `prompts.address` is missing -- the caller treats that the same as a "no".
   */
  async function buildFollowUpRequest({ config, prompts, channel, selfId, selfName, normalized, ownPrefill }) {
    const addressPrompt = prompts?.address;
    if (!addressPrompt) return null;
    const labels = prompts.labels;
    const contextLines = Math.max(0, config.mention.followUpContext ?? 15);
    const raw = contextLines > 0 ? await fetchHistory(channel, { limit: contextLines, selfId, embedTextChars: config.media?.embedTextChars, videoSites: config.media?.video?.sites }) : [];
    const history = raw.filter((m) => m.id !== normalized.id);
    const messages = [...history, normalized];
    const { descriptions, videos } = await cachedFollowUpMedia(channel.guild.id, messages, config, ownPrefill);
    const items = formatTranscript(messages, {
      timezone: config.bot.timezone,
      gapMinutes: config.context.gapMarkerMinutes,
      maxChars: config.context.maxMessageChars,
      selfName,
      labels,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context.reactionsPerMessage,
      descriptions,
      videos,
    });
    const candidateItem = items[items.length - 1];
    const transcript = renderTranscript(items.slice(0, -1), config.bot.timezone, labels);
    const author = followUpAuthorLine(channel.guild.id, normalized, config, labels);
    const authorBlock = author ? `\n<author>\n${author}\n</author>` : '';
    return {
      system: fillPromptTemplate(addressPrompt, { name: selfName }),
      user: `${transcript}${authorBlock}\n<candidate>\n${candidateItem.text}\n</candidate>`,
    };
  }

  /**
   * The `<author>` block's one line: the candidate author's display name and
   * the top `mention.followUpAliases` stored aliases by rank (decayed with
   * `memory.aliasHalfLifeDays`, the same order the persona's own request
   * shows), filled into `labels.address.author` (`{name}`, `{aliases}`) --
   * so the classifier can tie a nickname in the persona's line to this
   * member. Read-only (`store.getUser`). `''` (no block) with no profile, no
   * aliases, a cap of 0 or no `labels.address.author`.
   */
  function followUpAuthorLine(guildId, normalized, config, labels) {
    const template = labels?.address?.author;
    if (!template) return '';
    const cap = Math.max(0, Math.floor(config.mention?.followUpAliases ?? 5));
    if (!(cap > 0)) return '';
    const profile = store?.getUser?.(guildId, normalized.authorId);
    const aliases = Array.isArray(profile?.aliases) ? profile.aliases : [];
    const names = topByRank(aliases, cap, config.memory?.aliasHalfLifeDays).map((item) => item.name);
    if (names.length === 0) return '';
    return fill(template, { name: normalized.authorName, aliases: names.join(', ') });
  }

  /**
   * The checks in front of the classifier, read from the hot config now:
   * `{ kind: 'skip', reason }` when the classifier does not apply (feature
   * off, no open window, a turn that would refuse this one -- see
   * turnBlocked -- cannot send), `{ kind: 'handled' }` when the pre-filter
   * already gave a "no" (logged, streak bumped), `{ kind: 'classify', config,
   * state }` when the model must be asked.
   */
  function followUpGate(message, normalized, selfId) {
    const config = hot.config;
    const features = config.features ?? {};
    if (features.followUp === false || features.mentions === false) return { kind: 'skip', reason: 'off' };

    const channel = message.channel;
    const channelId = channel.id;
    const mentionCfg = config.mention;
    const state = followUpWindows.get(channelId);
    if (!isFollowUpOpen(state, now(), mentionCfg)) {
      if (state) closeFollowUpWindow(channelId); // expired: forget it here and in state.json
      return { kind: 'skip', reason: 'closed' };
    }
    // The paid classifier is not asked for a "yes" runTurn would refuse anyway.
    if (turnBlocked(channelId, config)) return { kind: 'skip', reason: 'busy' };
    if (!canSend(channel)) return { kind: 'skip', reason: 'cannot-send' };

    const startedAt = now();
    if (followUpPreFilter(normalized, selfId, mentionCfg)) {
      log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict: 'no', ms: now() - startedAt });
      bumpFollowUpNoStreak(channelId, state, mentionCfg);
      return { kind: 'handled' };
    }
    return { kind: 'classify', config, state };
  }

  /**
   * Whether an untagged `normalized` message was fully handled by the address
   * classifier (pre-filter or a real model verdict, "yes" or "no" alike, or
   * held for a classifier call already in flight in its channel) -- the
   * caller must then NOT also hand it to the spontaneous scheduler. Never
   * throws: an LLM/context-building error is treated as a "no" per the
   * contract. `false` means none of this applied (feature off, no open
   * window, a turn running that blocks this one) and the caller falls back to its usual
   * handling. `ownPrefill` is the message's picture prefill from
   * warmMediaCache (or null), awaited before its classifier request is built.
   */
  async function maybeFollowUp(message, normalized, selfId, ownPrefill = null) {
    const gate = followUpGate(message, normalized, selfId);
    if (gate.kind === 'skip') return false;
    if (gate.kind === 'handled') return true;

    // At most one classifier call in flight per channel. A message landing
    // while one is already running is held (only the latest per channel; an
    // earlier held one is replaced) and returned as handled. When the call in
    // flight ends without starting a turn, the held message goes through the
    // gate and the classifier as if it had just arrived; after a "yes" it is
    // dropped, since the turn reads it in the channel history anyway. The
    // slot stays taken until the held messages are worked off, one at a time.
    const channelId = message.channel.id;
    if (followUpInFlight.has(channelId)) {
      const replaced = followUpHeld.has(channelId);
      followUpHeld.set(channelId, { message, normalized, selfId, ownPrefill });
      log.info('follow-up: held while a classifier call is in flight', { channel: channelId, message: normalized.id, replaced });
      return true;
    }

    followUpInFlight.add(channelId);
    let startedTurn;
    try {
      startedTurn = await classifyFollowUp(message, normalized, selfId, gate, ownPrefill);
    } catch (err) {
      followUpHeld.delete(channelId);
      followUpInFlight.delete(channelId);
      throw err;
    }
    // Not awaited: this message is answered; a held one is classified in the
    // background, still holding the slot. With nothing held the slot is
    // released synchronously, before this returns.
    classifyHeldFollowUps(channelId, startedTurn).catch((err) =>
      log.error('follow-up: classifying a held message failed', { channel: channelId, error: err }),
    );
    return true;
  }

  /**
   * Works off the messages held for `channelId` while its classifier slot was
   * taken, one at a time, then frees the slot. `startedTurn` is the outcome
   * of the call that just ended.
   */
  async function classifyHeldFollowUps(channelId, startedTurn) {
    try {
      let turnStarted = startedTurn;
      for (;;) {
        const held = followUpHeld.get(channelId);
        if (!held) return;
        followUpHeld.delete(channelId);
        if (turnStarted) {
          log.info('follow-up: held message dropped', { channel: channelId, message: held.normalized.id, reason: 'turn' });
          return;
        }
        // As if it had just arrived: paused or warming up, onMessage would
        // never reach the classifier (and pause forbids marking the store dirty).
        const muted = store?.state?.data?.paused ? 'paused' : isWarmingUp() ? 'warmup' : null;
        const gate = muted ? { kind: 'skip', reason: muted } : followUpGate(held.message, held.normalized, held.selfId);
        if (gate.kind === 'skip') {
          log.info('follow-up: held message dropped', { channel: channelId, message: held.normalized.id, reason: gate.reason });
          return;
        }
        if (gate.kind === 'handled') return;
        turnStarted = await classifyFollowUp(held.message, held.normalized, held.selfId, gate, held.ownPrefill);
      }
    } finally {
      followUpHeld.delete(channelId);
      followUpInFlight.delete(channelId);
    }
  }

  /**
   * One classifier call for `normalized` (the gate already passed): logs the
   * verdict, starts a reply turn on "yes", bumps the no-streak otherwise.
   * Resolves to whether a turn was started: a "yes" that finds a turn
   * running which would refuse this one (turnBlocked, read now) starts none
   * and is logged as `follow-up: dropped`. The caller owns the in-flight slot.
   */
  async function classifyFollowUp(message, normalized, selfId, { config, state }, ownPrefill = null) {
    const channel = message.channel;
    const channelId = channel.id;
    const mentionCfg = config.mention;
    const startedAt = now();
    const selfName = getSelfName(channel.guild.id);
    let request = null;
    let buildFailed = false;
    try {
      request = await buildFollowUpRequest({ config, prompts: hot.prompts, channel, selfId, selfName, normalized, ownPrefill });
    } catch (err) {
      buildFailed = true;
      log.warn('follow-up: building the classifier request failed', { channel: channelId, error: err });
    }

    if (!request) {
      // Only a really missing prompt latches its one warning; a failed build was logged above.
      if (!buildFailed && !missingAddressPromptLogged) {
        missingAddressPromptLogged = true;
        log.warn('follow-up: prompts.address is missing, every follow-up is treated as "no"', {});
      }
      log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict: 'no', ms: now() - startedAt });
      bumpFollowUpNoStreak(channelId, state, mentionCfg);
      return false;
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
            role: 'classifier.text',
            maxOutputTokens: mentionCfg.followUpMaxOutputTokens,
            countAgainstDailyCap: true,
            skipCalibration: true,
          },
        );
        verdict = parseFollowUpVerdict(completion.text);
      } catch (err) {
        verdict = 'no';
        log.warn('follow-up: classifier failed', { channel: channelId, error: err });
      }
    }

    log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict, ms: now() - startedAt });

    if (verdict !== 'yes') {
      bumpFollowUpNoStreak(channelId, state, mentionCfg);
      return false;
    }
    // A turn started elsewhere while the classifier was thinking: runTurn
    // would answer 'busy', so none is started (and a held message is not
    // dropped as already answered).
    if (turnBlocked(channelId, hot.config)) {
      log.info('follow-up: dropped', { channel: channelId, message: normalized.id, reason: 'busy' });
      return false;
    }
    // Still counted for spam (mention.spamThreshold, future explicit
    // pings), just never rolled for the ignore chance -- a follow-up is a
    // continuation, not a ping (see docs/prompt-contract.md).
    tagHistory.hit(normalized.authorId, now(), repeatWindowMs(mentionCfg));
    turns
      .runTurn({ channel, mode: 'reply', trigger: normalized, triggerKind: 'followUp' })
      .then((result) => {
        if (result?.outcome === 'busy') {
          log.info('follow-up: dropped', { channel: channelId, message: normalized.id, reason: 'busy' });
        }
        return announceRefusal(channel, normalized, result, 'followUp');
      })
      .catch((err) => log.error('follow-up: reply turn failed', { channel: channelId, error: err }));
    return true;
  }

  // --- Limit notices ----------------------------------------------------------
  // A turn someone asked for (a mention, reply, name, follow-up or private
  // message) that a rail refused gets one plain line naming the limit and the
  // numbers (labels.limits.notice), so the requester knows it was a limit and
  // not silence in character. Spontaneous turns never come through here.

  /**
   * Post the limit notice (src/behavior/limits.js#postLimitNotice: labels,
   * dry-run and the mirror read now). A follow-up's notice is never a
   * Discord reply, like the follow-up turn itself. Never throws.
   * @param {TriggerKind} triggerKind
   */
  async function notifyLimit(channel, trigger, limit, triggerKind) {
    await postLimitNotice({
      channel,
      trigger,
      limit,
      asReply: triggerKind !== 'followUp',
      labels: hot.prompts?.labels,
      config: hot.config,
      client,
    });
  }

  /**
   * After a triggered turn: a rail refusal that carries its limit gets the notice.
   * @param {{ outcome: TurnOutcome, limit?: object|null }|undefined} result
   * @param {TriggerKind} triggerKind
   */
  async function announceRefusal(channel, trigger, result, triggerKind) {
    if (result?.outcome !== 'refused' || !result.limit) return;
    await notifyLimit(channel, trigger, result.limit, triggerKind);
  }

  /**
   * After a private turn: every turn that reached the model (it spoke, or it
   * chose to stay silent -- `skip`) counts toward today's cap; a refusal is
   * announced. A refused, busy, paused, error or not-now turn is not counted.
   */
  async function afterPrivateTurn(channel, guildId, trigger, result) {
    if (result?.outcome === 'spoke' || result?.outcome === 'skip') {
      store.bumpPrivateReplies(guildId, trigger.authorId, utcDay(now()));
    }
    await announceRefusal(channel, trigger, result, 'private');
  }

  /**
   * The private-chat gate for one DM author (src/behavior/private.js#privateGate),
   * shared by a live DM and a queued one at drain time. The free checks (a
   * stored profile, the owner flag, the attitude threshold) run before any
   * REST call: the served guild's member cache is read first, and
   * `members.fetch` is only reached when those checks would let the author
   * through. `config` is the caller's `hot.config`, read at the moment of use.
   * @returns {Promise<{ gate: object, isOwner: boolean, replies: object|null, today: string }>}
   */
  async function checkPrivateGate(config, guildId, authorId) {
    const profile = store.getUser(guildId, authorId);
    const isOwner = isOwnerId(config, authorId);
    const replies = store.getPrivate(guildId, authorId)?.replies ?? null;
    const today = utcDay(now());
    const input = { config, profile, isOwner, replies, today };

    const guild = client.guilds?.cache?.get(guildId);
    let isMember = Boolean(guild?.members?.cache?.get(authorId));
    if (guild && !isMember) {
      const free = privateGate({ ...input, isMember: true });
      if (!free.ok && free.reason !== 'cap') return { gate: free, isOwner, replies, today };
      isMember = Boolean(await guild.members.fetch(authorId).catch(() => null));
    }
    return { gate: privateGate({ ...input, isMember }), isOwner, replies, today };
  }

  /**
   * A DM the gate refused: dropped silently (the reason is logged), except
   * the daily-cap notice, posted at most once a day per person.
   */
  async function dropPrivate(channel, guildId, authorId, trigger, { gate, isOwner, replies, today }) {
    log.info('private: dropped', { reason: gate.reason });
    if (gate.reason === 'cap' && replies?.noticedDay !== today) {
      store.markPrivateNoticed(guildId, authorId, today);
      const key = isOwner ? 'private.maxPerOwnerPerDay' : 'private.maxPerUserPerDay';
      await notifyLimit(channel, trigger, { key, used: gate.used, cap: gate.cap }, 'private');
    }
  }

  // --- Pending direct pings ---------------------------------------------------
  // A @mention or a reply to the persona that arrives while a turn is running
  // in its own channel (mention.pendingSameChannel) or, with one attention
  // (mention.oneAtATime), in another channel is remembered here instead of
  // dropped, and answered once the turn frees up -- unless the turn that
  // spoke there already had it in view (turns.spokeAfterSeeing). See
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
   * Remember a direct ping (mention/reply/private message) that arrived while
   * a turn is running in its own channel or, with one attention, elsewhere.
   * At most one per channel -- a newer ping replaces an older one already
   * queued for the same channel -- and at most mention.maxPending channels;
   * the oldest is evicted when full.
   */
  function enqueuePending(channel, trigger, kind) {
    const maxPending = hot.config.mention.maxPending ?? 3;
    const ping = { channelId: channel.id, channel, trigger, kind, arrivedAt: now() };
    const { list, evicted } = addPending(pendingList, ping, maxPending);
    pendingList = list;
    log.info('mention: deferred', { channel: channel.id, kind, sameChannel: turns.isBusy(channel.id), pending: pendingList.length });
    if (evicted) log.info('mention: dropped', { channel: evicted.channelId, kind: evicted.kind, reason: 'full' });
  }

  /**
   * The drain's runTurn answered 'busy': another turn started during the
   * switch pause. The ping goes back into the queue with its original
   * arrivedAt (a newer ping queued for the same channel meanwhile wins and
   * this one is dropped; mention.maxPending still applies). Synchronous on
   * purpose -- see drainPending. Returns whether a turn that blocks this ping
   * is still running (its end calls drainPending again through onIdle).
   */
  function requeueBusy(ping) {
    const mentionCfg = hot.config.mention;
    const { list, dropped, evicted } = requeuePending(pendingList, ping, mentionCfg.maxPending ?? 3);
    pendingList = list;
    if (dropped) {
      log.info('mention: dropped', { channel: dropped.channelId, kind: dropped.kind, reason: 'newer' });
    } else {
      log.info('mention: deferred again', { channel: ping.channelId, kind: ping.kind, reason: 'busy', pending: pendingList.length });
    }
    if (evicted) log.info('mention: dropped', { channel: evicted.channelId, kind: evicted.kind, reason: 'full' });
    return turnBlocked(ping.channelId, hot.config);
  }

  /**
   * Count the call, roll the ignore decision (decideMention) and log it, for
   * a server ping of `kind` -- the live path and the drain alike. `config` is
   * the caller's `hot.config`, read at the moment of use; `deferred` marks a
   * ping answered from the pending queue.
   * @returns {{ respond: boolean, reason: string, ignoreChance: number, roll?: number }}
   */
  function decideAndLog(channel, trigger, kind, config, { deferred = false } = {}) {
    const features = config.features ?? {};
    const guildId = channel.guild.id;
    const recentCalls = tagHistory.hit(trigger.authorId, now(), repeatWindowMs(config.mention));
    const affinityScore =
      features.memory !== false && features.relationships !== false
        ? store?.getUser?.(guildId, trigger.authorId)?.affinity?.score
        : undefined;
    const decision = decideMention({
      kind,
      textLength: strippedLength(trigger.content, getSelfName(guildId)),
      recentCalls,
      neverIgnore: config.mention.neverIgnore.includes(trigger.authorId),
      affinityScore,
      cfg: config.mention,
      rng,
    });
    log.info('mention: decided', {
      kind,
      reason: decision.reason,
      ignoreChance: decision.ignoreChance,
      roll: decision.roll === undefined ? undefined : Math.round(decision.roll * 100) / 100,
      author: trigger.authorId,
      channel: channel.id,
      ...(deferred ? { deferred: true } : {}),
    });
    return decision;
  }

  /**
   * Answers pending direct pings, oldest first, one at a time, each after a
   * human "switch" pause (mention.switchDelayMs) -- called once a turn
   * finishes anywhere (src/index.js wires this to src/behavior/turn.js's
   * `setOnIdle`, in the same `finally` that frees the channel). The ignore
   * decision (decideMention) is rolled HERE, not when the ping arrived. A
   * message deleted meanwhile, or a channel that lost send permission, is
   * dropped silently; a ping the last turn that spoke in its channel already
   * had in its history (turns.spokeAfterSeeing) is dropped with a log line.
   * A ping queued in a channel whose own turn was running is picked up the
   * same way once that turn frees the channel. Guarded against re-entrancy:
   * the turn this function itself starts also frees the channel through the very same `onIdle`,
   * which would otherwise start a second overlapping drain. A no-op while
   * `isWarmingUp()` is true -- the queue is left untouched for a later
   * call once the warmup run ends -- and while paused (`/nep pause` clears
   * the queue itself); a pause that lands during the switch pause drops the
   * ping in hand and ends the pass. A server ping is also dropped when its
   * channel is no longer allowed (bot.channels) or its switch
   * (features.mentions / features.replies) was turned off while it waited.
   *
   * A turn that started during the switch pause makes runTurn answer 'busy':
   * the ping is re-queued (requeueBusy; a server ping keeps its `respond`
   * decision, so the retry neither counts it again toward spamThreshold nor
   * re-rolls the ignore chance) and the pass stops -- the running turn calls
   * drainPending again when it ends. From the busy result to `draining =
   * false` nothing is awaited, so that onIdle call either finds `draining`
   * already cleared, or the blocking turn had already ended when requeueBusy
   * looked and the pass goes on instead of stopping.
   */
  async function drainPending() {
    if (draining || isWarmingUp() || store?.state?.data?.paused) return;
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

        // Paused meanwhile: nothing may run or mark the store dirty; the
        // queue's other pings are cleared by the pause itself.
        if (store?.state?.data?.paused) {
          log.info('mention: dropped', { channel: ping.channelId, kind: ping.kind, reason: 'paused' });
          break;
        }
        if (!canSend(ping.channel)) continue;
        if (!(await messageStillExists(ping.channel, ping.trigger.id))) continue;
        // The turn that ran meanwhile fetched its history after this ping
        // landed and spoke with it in view: not answered a second time.
        if (turns.spokeAfterSeeing?.(ping.channelId, ping.trigger.id)) {
          log.info('mention: already answered', { channel: ping.channelId, kind: ping.kind });
          continue;
        }

        const config = hot.config;
        const features = config.features ?? {};
        let stop = false; // set by requeueBusy while the turn that blocked this ping still runs

        // A private message is answered like a direct ping, without the
        // ignore roll; the channel has no guild, so the pinned one is passed.
        // The gate is checked again here: the switch, the profile or today's
        // cap may have changed while the ping waited.
        if (ping.kind === 'private') {
          const privateGuildId = getGuildId();
          if (!privateGuildId) continue;
          try {
            const authorId = ping.trigger.authorId;
            const check = await checkPrivateGate(config, privateGuildId, authorId);
            if (!check.gate.ok) {
              await dropPrivate(ping.channel, privateGuildId, authorId, ping.trigger, check);
              continue;
            }
            const result = await turns.runTurn({
              channel: ping.channel,
              guildId: privateGuildId,
              mode: 'reply',
              trigger: ping.trigger,
              triggerKind: 'private',
            });
            if (result?.outcome === 'busy') stop = requeueBusy(ping);
            else await afterPrivateTurn(ping.channel, privateGuildId, ping.trigger, result);
          } catch (err) {
            log.error('private: deferred turn failed', { channel: ping.channelId, error: err });
          }
          if (stop) break;
          continue;
        }

        // The channel list and the ping's own switch are hot: either may have
        // changed while the ping waited.
        const switchOff = ping.kind === 'reply' ? features.replies === false : features.mentions === false;
        if (!channelAllowed(ping.channel, config.bot) || switchOff) {
          log.info('mention: dropped', { channel: ping.channelId, kind: ping.kind, reason: switchOff ? 'off' : 'channel' });
          continue;
        }

        // A re-queued ping was already counted and decided `respond` on the
        // pass whose turn found another one running: not counted or rolled again.
        if (!ping.decided) {
          const decision = decideAndLog(ping.channel, ping.trigger, ping.kind, config, { deferred: true });
          if (!decision.respond) continue;
        }

        try {
          const result = await turns.runTurn({ channel: ping.channel, mode: 'reply', trigger: ping.trigger, triggerKind: ping.kind });
          if (result?.outcome === 'busy') stop = requeueBusy({ ...ping, decided: true });
          else await announceRefusal(ping.channel, ping.trigger, result, ping.kind);
        } catch (err) {
          log.error('mention: deferred turn failed', { channel: ping.channelId, error: err });
        }
        if (stop) break;
      }
    } finally {
      draining = false;
    }
  }

  /**
   * A direct message (private chat). Checked locally with zero tokens: the
   * switch, other bots, the served guild, membership, a stored profile, the
   * public attitude and today's reply cap (privateGate). A refused DM is
   * dropped silently, except the daily-cap notice once a day per person. No
   * ignore roll, follow-up window, eavesdrop or address classifier here.
   */
  async function onPrivateMessage(message, config) {
    const features = config.features ?? {};
    if (features.privateMessages !== true) return;
    const selfId = client.user.id;
    if (message.author.bot && message.author.id !== selfId) return;

    const guildId = getGuildId();
    if (!guildId) return;
    const memoryOn = features.memory !== false;
    const channel = message.channel;
    const normalized = normalizeMessage(message, selfId, {
      embedTextChars: config.media?.embedTextChars,
      videoSites: config.media?.video?.sites,
    });

    // The persona's own DM message: bookkeeping, remembered under the
    // partner's id. Without a usable partner id, or for a limit notice (not
    // the persona's speech), only the post is noted.
    if (normalized.self) {
      turns.notePost(normalized.channelId, normalized.ts);
      const partnerId = channel.recipientId ?? channel.recipient?.id;
      if (!partnerId || String(partnerId) === String(selfId)) return;
      if (isLimitNotice(hot.prompts?.labels, normalized.content)) return;
      if (memoryOn) memory.observe(guildId, normalized, { private: partnerId });
      return;
    }

    const authorId = message.author.id;
    const check = await checkPrivateGate(config, guildId, authorId);
    if (!check.gate.ok) {
      await dropPrivate(channel, guildId, authorId, normalized, check);
      return;
    }

    // Observed like a direct call; during a memory warmup run, never answered.
    if (memoryOn) memory.observe(guildId, normalized, { direct: true, private: authorId });
    if (isWarmingUp()) return;

    // One attention: busy anywhere (or, with oneAtATime off, in this very
    // chat) -> pending, answered by drainPending once the turn frees up.
    if (turnBlocked(channel.id, config)) {
      enqueuePending(channel, normalized, 'private');
      return;
    }

    turns
      .runTurn({ channel, guildId, mode: 'reply', trigger: normalized, triggerKind: 'private' })
      .then((result) => afterPrivateTurn(channel, guildId, normalized, result))
      .catch((err) => log.error('private: turn failed', { channel: channel.id, error: err }));
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

      // 2. DMs: private chat (features.privateMessages, off by default) --
      // see onPrivateMessage. Owner commands are slash commands
      // (src/discord/commands.js, interactionCreate), never DMs.
      if (!message.guild) {
        await onPrivateMessage(message, config);
        return;
      }

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
      const normalized = normalizeMessage(message, selfId, {
        embedTextChars: config.media?.embedTextChars,
        videoSites: config.media?.video?.sites,
      });
      const guildId = message.guild.id;

      // 5. Its own message: only bookkeeping. Also (re)opens/extends the
      // follow-up window for this channel -- see noteFollowUpSend above. A
      // limit notice is not the persona's speech: the post is noted, but it
      // never opens a window or reaches memory.
      if (normalized.self) {
        turns.notePost(normalized.channelId, normalized.ts);
        if (isLimitNotice(hot.prompts?.labels, normalized.content)) return;
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
      // BEFORE memory observes the message, so the buffer can mark it. A
      // forward of the persona's own message has no replyToId: not a reply.
      const mentionsSelf = features.mentions !== false && message.mentions.users.has(selfId);
      const repliesToSelf = features.replies !== false && (await resolveReference(message.channel, normalized.replyToId, selfId));
      const nameTriggers = features.nameTriggers !== false ? config.bot.nameTriggers : [];
      const kind = detectTrigger({
        mentionsSelf,
        repliesToSelf,
        content: normalized.content,
        nameTriggers,
      });

      // 9. Everyone else feeds memory; a message addressed to the persona is
      // marked `direct` so the analyzer can weigh it separately.
      const ownPrefill = warmMediaCache(guildId, normalized);
      if (memoryOn) memory.observe(guildId, normalized, { direct: Boolean(kind) });

      // 10. No trigger: maybe a follow-up (features.followUp) inside a
      // window the persona itself opened by answering -- fully handled by
      // maybeFollowUp either way (a computed verdict or a deliberate no-op,
      // see its own header comment); otherwise let the spontaneous scheduler
      // eavesdrop, nothing more.
      if (!kind) {
        const followedUp = await maybeFollowUp(message, normalized, selfId, ownPrefill);
        if (!followedUp) spontaneous.onMessage(message.channel, normalized);
        return;
      }

      // 11. The persona was called: decide whether to actually answer.
      if (!canSend(message.channel)) return;

      // 11b. A direct call (mention/reply) that cannot be answered now is
      // remembered as pending instead of dropped, and answered by
      // drainPending once the turn frees up (the tag count and the ignore
      // roll happen there):
      //  - a turn is running in THIS channel (mention.pendingSameChannel,
      //    default on, regardless of mention.oneAtATime) -- that turn may
      //    already have fetched its history without this message;
      //  - one attention (mention.oneAtATime, default on): a turn is running
      //    in ANOTHER channel.
      // A name trigger is never queued: busy elsewhere it is skipped here;
      // busy in this channel (or with pendingSameChannel off, any direct
      // call) it falls through and runTurn itself returns 'busy', logged as
      // a drop below.
      const direct = kind === 'mention' || kind === 'reply';
      const oneAtATime = config.mention.oneAtATime !== false;
      const sameChannelBusy = turns.isBusy(message.channel.id);
      if (sameChannelBusy && direct && config.mention.pendingSameChannel !== false) {
        enqueuePending(message.channel, normalized, kind);
        return;
      }
      const busyElsewhere = oneAtATime && !sameChannelBusy && turns.isAnyBusy();
      if (busyElsewhere) {
        if (direct) {
          enqueuePending(message.channel, normalized, kind);
        } else {
          log.info('mention: dropped', { channel: message.channel.id, kind, reason: 'busy' });
        }
        return;
      }

      const decision = decideAndLog(message.channel, normalized, kind, config);
      if (decision.respond) {
        turns
          .runTurn({ channel: message.channel, mode: 'reply', trigger: normalized, triggerKind: kind })
          .then((result) => {
            if (result?.outcome === 'busy') log.info('mention: dropped', { channel: message.channel.id, kind, reason: 'busy' });
            return announceRefusal(message.channel, normalized, result, kind);
          })
          .catch((err) => log.error('mention: reply turn failed', { channel: message.channel.id, error: err }));
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
