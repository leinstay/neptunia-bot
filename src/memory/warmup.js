// The memory warm-up: before the persona is allowed to speak, read the
// server's history backwards and feed it, oldest first, through the same
// analyzer as the live memory updater (src/memory/update.js#analyze) —
// building member profiles, attitudes, the channel map and in-jokes in
// advance. Gated by `config.warmup.enabled`; spends its own token budget
// (`config.warmup.maxTokens`), never the daily LLM request cap (analyze is
// called with `countAgainstDailyCap: false`).
//
// The owner can shape which channels are read and how deep, from Discord
// (see src/admin.js `warmup …` sub-commands): `warmup.channelDepths` sets a
// per-channel depth in messages counted from the newest backwards,
// `warmup.onlyListed` restricts the run to just those channels (plus the
// primary one), and `warmup.primaryChannelId` is read first so the very
// first picture of the server comes from it. `planWarmup` turns that
// configuration plus the readable channels into the ordered plan; it never
// throws on a stale id (deleted channel, lost access) — those come back
// separately as `missing`.
//
// Pure helpers (planBatches, remainingBudget, spentTokens, orderChannels,
// planWarmup) are unit-tested directly. The factory below is the only place
// that touches discord.js and the persisted store; progress lives in
// `store.state.data.warmup` and is flushed after every batch, so a restart
// resumes exactly where it stopped and never re-analyzes a finished batch.
// The depth used for a channel is frozen into its progress entry
// (`channels[id].limit`, alongside `anchorId`) the first time that channel is
// fetched, so a later config change never shifts an in-progress channel's
// window or its batch indexes; `warmup reset` is the only way to pick up a
// new depth for a channel that already has progress.

import { readableChannels, lastActivity, fetchHistoryWindow } from '../discord/collect.js';
import { touchMemory } from './update.js';
import { estimateTokens } from '../llm/tokens.js';
import { collectPictures, isDescribable } from '../discord/media.js';
import { log } from '../log.js';

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 5000;
const BATCH_OVERHEAD_TOKENS = 500; // a rough allowance for the prompt scaffolding around the transcript
const SPLIT_FLOOR = 20; // a piece this small or smaller that still fails a 'truncated'/'bad-json' analysis is skipped, not split further

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A batch this size produces an analyzer JSON longer than the model can
 * finish in one completion: retrying the exact same input can never
 * succeed. Splitting it (instead of the plain retry/abort path) is the only
 * way forward.
 */
function isUnrecoverableSize(reason) {
  return reason === 'truncated' || reason === 'bad-json';
}

/**
 * Split `messages` (oldest first) into oldest-first chunks of `batchSize`.
 * Other bots' messages are dropped before chunking; the persona's own
 * messages are kept (`normalizeMessage` already marks them `bot: false`).
 * @param {object[]} messages
 * @param {number} batchSize
 * @returns {object[][]}
 */
export function planBatches(messages, batchSize) {
  const filtered = messages.filter((m) => !m.bot);
  const batches = [];
  for (let i = 0; i < filtered.length; i += batchSize) {
    batches.push(filtered.slice(i, i + batchSize));
  }
  return batches;
}

/** How many tokens of `maxTokens` are left, given the warm-up state's `tokensUsed` so far. */
export function remainingBudget(state, maxTokens) {
  return Math.max(0, maxTokens - (state?.tokensUsed ?? 0));
}

/**
 * Tokens actually spent by one analyzer call: the provider's own count when
 * it reported one, otherwise the pre-flight estimate.
 * @param {{ prompt_tokens?: number, completion_tokens?: number }|null|undefined} usage
 * @param {number} estimated
 */
export function spentTokens(usage, estimated) {
  if (usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
    return usage.prompt_tokens + usage.completion_tokens;
  }
  return estimated;
}

/**
 * Order channel candidates most recently active first.
 * @param {{ lastActivity: number }[]} candidates
 */
export function orderChannels(candidates) {
  return [...candidates].sort((a, b) => b.lastActivity - a.lastActivity);
}

/**
 * Build the ordered warm-up plan for one guild's readable channels, from the
 * owner's custom warm-up configuration. Never throws on a stale id.
 *
 * - a channel's depth is `cfg.channelDepths[id]` when that is an integer
 *   >= 0, else `cfg.messagesPerChannel`; a depth of 0 drops the channel from
 *   the plan entirely; a non-integer/negative entry is treated as absent
 *   (falls back to `cfg.messagesPerChannel`, same as no entry at all);
 * - `cfg.onlyListed: true` keeps only the primary channel plus channels with
 *   a valid `channelDepths` entry — everything else is dropped;
 * - order: the primary channel first (when readable and its depth is not
 *   0), then the listed channels by depth descending (ties: most recently
 *   active first), then the rest by most recently active first.
 *
 * @param {{ id: string, name: string, lastActivity: number }[]} candidates  The readable channels.
 * @param {{
 *   channelDepths?: Record<string, number>,
 *   primaryChannelId?: string,
 *   onlyListed?: boolean,
 *   messagesPerChannel: number,
 * }} cfg
 * @returns {{
 *   plan: { id: string, name: string, depth: number, role: 'primary'|'listed'|'default' }[],
 *   missing: string[],
 * }}
 */
export function planWarmup(candidates, cfg) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const channelDepths = cfg?.channelDepths && typeof cfg.channelDepths === 'object' ? cfg.channelDepths : {};
  const primaryId = cfg?.primaryChannelId || null;
  const onlyListed = Boolean(cfg?.onlyListed);
  const defaultDepth =
    Number.isInteger(cfg?.messagesPerChannel) && cfg.messagesPerChannel >= 0 ? cfg.messagesPerChannel : 0;

  const validDepth = (raw) => (Number.isInteger(raw) && raw >= 0 ? raw : null);
  const depthFor = (id) => {
    const v = validDepth(channelDepths[id]);
    return v === null ? defaultDepth : v;
  };

  const missing = [];
  const seenMissing = new Set();
  const addMissing = (id) => {
    if (seenMissing.has(id)) return;
    seenMissing.add(id);
    missing.push(id);
  };
  for (const id of Object.keys(channelDepths)) {
    if (!byId.has(id)) addMissing(id);
  }
  if (primaryId && !byId.has(primaryId)) addMissing(primaryId);

  // A channel counts as "listed" only with a genuinely valid depth entry;
  // a garbage value (non-integer, negative) is treated as no entry at all.
  const listedIds = new Set();
  for (const id of Object.keys(channelDepths)) {
    if (id === primaryId) continue;
    if (!byId.has(id)) continue;
    if (validDepth(channelDepths[id]) === null) continue;
    listedIds.add(id);
  }

  const plan = [];

  if (primaryId && byId.has(primaryId)) {
    const depth = depthFor(primaryId);
    if (depth > 0) {
      const c = byId.get(primaryId);
      plan.push({ id: primaryId, name: c.name, depth, role: 'primary' });
    }
  }

  const listed = [...listedIds]
    .map((id) => {
      const c = byId.get(id);
      return { id, name: c.name, depth: depthFor(id), lastActivity: c.lastActivity };
    })
    .filter((c) => c.depth > 0)
    .sort((a, b) => b.depth - a.depth || b.lastActivity - a.lastActivity);
  for (const c of listed) plan.push({ id: c.id, name: c.name, depth: c.depth, role: 'listed' });

  if (!onlyListed) {
    const rest = candidates
      .filter((c) => c.id !== primaryId && !listedIds.has(c.id))
      .map((c) => ({ id: c.id, name: c.name, depth: depthFor(c.id), lastActivity: c.lastActivity }))
      .filter((c) => c.depth > 0)
      .sort((a, b) => b.lastActivity - a.lastActivity);
    for (const c of rest) plan.push({ id: c.id, name: c.name, depth: c.depth, role: 'default' });
  }

  return { plan, missing };
}

/**
 * A conservative, cheap estimate of what one batch's analyzer request will
 * cost, counting only message contents + a flat overhead. Kept only as the
 * fallback for `estimateBatch` below, for the rare case `memory.estimate`
 * itself throws — the real pre-batch check is the full request estimate.
 */
function estimateBatchCost(batch, memoryCfg) {
  const contentTokens = batch.reduce((sum, m) => sum + estimateTokens(m.content ?? ''), 0);
  return contentTokens + (memoryCfg?.maxOutputTokens ?? 0) + BATCH_OVERHEAD_TOKENS;
}

/**
 * What one batch's analyzer request will really cost: the calibrated
 * input-token estimate of the exact request (`memory.estimate`, which
 * mirrors what `analyze` builds — prompt, character card, existing
 * profiles/channels JSON, transcript) plus the output tokens it is allowed
 * to spend. Falls back to the cheap heuristic if `memory.estimate` itself
 * throws, so this check alone can never crash a warm-up run.
 */
function estimateBatch(guildId, batch, hot, memory) {
  try {
    return memory.estimate(guildId, batch) + (hot.config.memory?.maxOutputTokens ?? 0);
  } catch {
    return estimateBatchCost(batch, hot.config.memory);
  }
}

/**
 * Charge one analyzer attempt (first try or retry) against the warm-up
 * budget whenever it carries real usage or a non-zero estimate — i.e.
 * whenever the provider actually billed something, successful or not. A
 * genuinely free failure (no completion ever received: `usage: null,
 * estimated: 0`) charges nothing, matching `analyze`'s contract.
 */
function chargeAttempt(st, outcome) {
  if (outcome.usage == null && !(outcome.estimated > 0)) return;
  st.tokensUsed += spentTokens(outcome.usage, outcome.estimated);
  st.requests += 1;
}

function freshState() {
  return {
    done: false,
    aborted: false,
    paused: false,
    startedAt: null,
    finishedAt: null,
    tokensUsed: 0,
    requests: 0,
    skippedMessages: 0,
    channels: {},
  };
}

/**
 * @param {object} deps
 * @param {object} deps.hot       Live config; read at the moment of use.
 * @param {object} deps.store
 * @param {import('discord.js').Client} deps.client
 * @param {{ analyze: Function, estimate: Function }} deps.memory  From createMemoryUpdater().
 * @param {() => string | null} deps.getGuildId
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {object} [deps.describer]  From createDescriber() (src/memory/describe.js), optional:
 *   when absent, or features.mediaDescriptions is off, no description request is ever made.
 *   Unlike the memory analyzer, these requests are charged directly against the warm-up's own
 *   token budget (`st.tokensUsed`), the budget is checked before each one, and they always pass
 *   `countAgainstDailyCap: false` — same rationale as the analyzer calls (see the header comment).
 */
export function createWarmup({ hot, store, client, memory, getGuildId, now = Date.now, sleep = realSleep, describer }) {
  let runningPromise = null;
  // The in-progress run's stop flag, if any. Set fresh at the start of every
  // doRun() call and cleared once it settles, so stop() called with no run in
  // flight is simply a no-op.
  let currentControl = null;

  function state() {
    if (!store.state.data.warmup) {
      store.state.data.warmup = freshState();
    }
    return store.state.data.warmup;
  }

  function persist() {
    store.state.markDirty();
    store.flush();
  }

  /**
   * True from process start while a warm-up is due or running: either the
   * config says one is due (enabled, not done/aborted/paused) or a run is
   * actually in flight right now — including one the owner started by hand
   * with `warmup.enabled: false`, or one resuming after `stop()`.
   */
  function isBlocking() {
    if (runningPromise) return true;
    const cfg = hot.config.warmup ?? {};
    if (!cfg.enabled) return false;
    const st = store.state.data.warmup;
    if (st?.done) return false;
    if (st?.aborted) return false;
    if (st?.paused) return false;
    return true;
  }

  /** The ordered plan plus a lookup back to the live discord.js channel objects, for one guild. */
  function resolveChannels(guild) {
    const cfg = hot.config.warmup ?? {};
    const channels = readableChannels(guild, hot.config.bot);
    const byId = new Map(channels.map((c) => [c.id, c]));
    const candidates = channels.map((c) => ({ id: c.id, name: c.name, lastActivity: lastActivity(c) }));
    const { plan, missing } = planWarmup(candidates, cfg);
    return { plan, missing, byId };
  }

  /** A conservative flat estimate of what ONE describer request will cost: its system prompt plus the output cap. */
  function estimateDescribeCost() {
    const mediaCfg = hot.config.media ?? {};
    return estimateTokens(hot.prompts?.describe ?? '') + (mediaCfg.maxOutputTokens ?? 0) + 300;
  }

  /**
   * Describe up to `media.maxPerBatch` NEW pictures of `batch`, charging each
   * one directly against the warm-up's own token budget (checked before
   * every request, same accounting as `chargeAttempt`) — never the memory
   * analyzer's own request. Returns the resulting descriptions map, computed
   * ONCE per original batch and reused unchanged across any later split (see
   * analyzePiece): a picture only ever costs the budget once per batch.
   */
  async function describeBatchForWarmup(guildId, batch, cfg, st) {
    const descriptions = new Map();
    if (!describer || hot.config.features?.mediaDescriptions !== true) return descriptions;

    const candidates = [];
    for (const message of batch) {
      for (const item of collectPictures(message)) {
        if (isDescribable(item)) candidates.push(item);
      }
    }
    const maxPerBatch = hot.config.media?.maxPerBatch ?? Infinity;
    let newCount = 0;
    for (const item of candidates) {
      if (newCount >= maxPerBatch) break;
      const estimate = estimateDescribeCost();
      if (remainingBudget(st, cfg.maxTokens) < estimate) break;

      const result = await describer.describe(guildId, item, { countAgainstDailyCap: false });
      if (!result) continue;
      if (!result.cached) {
        newCount += 1;
        st.tokensUsed += spentTokens(result.usage, result.estimated || estimate);
        st.requests += 1;
        persist();
      }
      descriptions.set(item.itemId, result.text);
    }
    return descriptions;
  }

  /**
   * Analyze one piece of a batch (the whole batch on the first call, a half
   * of it once split). Never retries a 'truncated'/'bad-json' failure on the
   * same input: it halves the piece instead (oldest half first), recursing
   * down to `SPLIT_FLOOR` messages; a piece that size or smaller that still
   * fails that way is SKIPPED (counted in `st.skippedMessages`) so a single
   * poisonous piece can never stall or abort the whole warm-up. Every other
   * failure reason keeps the existing retry-once + 3-consecutive-cycles
   * abort behaviour, unchanged.
   *
   * @param {Map<string, string>} [descriptions]  Pre-computed describer captions for this batch
   *   (see describeBatchForWarmup), reused unchanged across a split.
   * @returns {Promise<{ consecutiveFailures: number, stop: boolean }>}
   *   `stop: true` means the budget ran out or the run aborted — the caller
   *   must not advance `batchesDone` and must stop processing this channel.
   */
  async function analyzePiece(guildId, channelId, batchIndex, cfg, st, piece, consecutiveFailures, descriptions) {
    for (;;) {
      const estimate = estimateBatch(guildId, piece, hot, memory);
      if (remainingBudget(st, cfg.maxTokens) < estimate) {
        st.done = true;
        st.finishedAt = now();
        persist();
        log.info('warmup: budget spent, stopping', { tokensUsed: st.tokensUsed, maxTokens: cfg.maxTokens });
        return { consecutiveFailures, stop: true };
      }

      // Every attempt that reached the provider is charged against the
      // budget as soon as it comes back, first try or retry, successful or
      // not — a failure after a completion was received is still billed.
      let outcome = await memory.analyze(guildId, piece, { countAgainstDailyCap: false, descriptions });
      chargeAttempt(st, outcome);
      persist();

      // A 'truncated'/'bad-json' failure is never retried on the same
      // input — see isUnrecoverableSize. Every other reason keeps the
      // original retry-once behaviour below.
      if (!outcome.ok && !isUnrecoverableSize(outcome.reason) && remainingBudget(st, cfg.maxTokens) >= estimate) {
        await sleep(RETRY_DELAY_MS);
        outcome = await memory.analyze(guildId, piece, { countAgainstDailyCap: false, descriptions });
        chargeAttempt(st, outcome);
        persist();
      }

      if (outcome.ok) {
        // Bookkeeping (touchUser/touchChannel) happens only once a piece is
        // actually applied — computed the same way `observe()` does it, via
        // the shared helper, so a resume never re-touches an already-counted
        // message and a mid-cycle retry never double-counts one either.
        for (const message of piece) touchMemory(store, guildId, message);
        return { consecutiveFailures: 0, stop: false };
      }

      if (isUnrecoverableSize(outcome.reason)) {
        if (piece.length > SPLIT_FLOOR) {
          const mid = Math.ceil(piece.length / 2);
          log.warn('warmup: batch failed, splitting', {
            guildId,
            channel: channelId,
            batchIndex,
            messages: piece.length,
            reason: outcome.reason,
            detail: outcome.detail,
          });
          const first = await analyzePiece(guildId, channelId, batchIndex, cfg, st, piece.slice(0, mid), consecutiveFailures, descriptions);
          if (first.stop) return first;
          return analyzePiece(guildId, channelId, batchIndex, cfg, st, piece.slice(mid), first.consecutiveFailures, descriptions);
        }

        st.skippedMessages = (st.skippedMessages ?? 0) + piece.length;
        persist();
        log.warn('warmup: batch failed at the floor, skipping', {
          guildId,
          channel: channelId,
          batchIndex,
          messages: piece.length,
          reason: outcome.reason,
          detail: outcome.detail,
        });
        return { consecutiveFailures, stop: false };
      }

      consecutiveFailures += 1;
      log.warn('warmup: batch failed, giving up on this attempt', {
        guildId,
        channel: channelId,
        batchIndex,
        messages: piece.length,
        reason: outcome.reason,
        detail: outcome.detail,
        consecutiveFailures,
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        st.aborted = true;
        persist();
        log.error('warmup: aborting after repeated failures', {
          guildId,
          tokensUsed: st.tokensUsed,
          requests: st.requests,
        });
        return { consecutiveFailures, stop: true };
      }
      // Retry the same piece — unless the billed failure(s) above already
      // ate the budget it needs, in which case the top of the loop stops the
      // run instead of looping on an attempt it cannot afford.
    }
  }

  function countChannelsDone(st) {
    return Object.values(st.channels).filter((c) => c.done).length;
  }

  async function runChannel(guildId, cfg, channel, depth, st, consecutiveFailures, channelsTotal, control) {
    const channelState = (st.channels[channel.id] ??= { anchorId: null, limit: null, messages: 0, batchesDone: 0, done: false });
    if (channelState.done) return consecutiveFailures;

    function finishChannel() {
      channelState.done = true;
      persist();
      log.info('warmup: channel done', {
        channel: channel.id,
        channelsDone: countChannelsDone(st),
        channelsTotal,
      });
    }

    if (!channelState.anchorId) {
      channelState.anchorId = channel.lastMessageId ?? null;
      if (channelState.anchorId) channelState.limit = depth;
      persist();
    }
    if (!channelState.anchorId) {
      finishChannel();
      return consecutiveFailures;
    }
    // A resume always re-fetches the SAME window it started with, even if
    // the configured depth for this channel changed meanwhile — otherwise
    // the already-recorded batch indexes could shift under it. `limit` is
    // only ever missing here for progress written before this field existed;
    // in that case the current plan's depth is the best available guess.
    if (channelState.limit == null) channelState.limit = depth;

    const minTs = cfg.maxAgeDays > 0 ? now() - cfg.maxAgeDays * 24 * 60 * 60_000 : 0;
    const window = await fetchHistoryWindow(channel, {
      anchorId: channelState.anchorId,
      limit: channelState.limit,
      minTs,
      selfId: client.user.id,
      embedTextChars: hot.config.media?.embedTextChars,
    });

    const batches = planBatches(window, cfg.batchMessages);
    if (batches.length === 0) {
      finishChannel();
      return consecutiveFailures;
    }

    for (let i = channelState.batchesDone; i < batches.length; i += 1) {
      const batch = batches[i];
      const descriptions = await describeBatchForWarmup(guildId, batch, cfg, st);
      const result = await analyzePiece(guildId, channel.id, i, cfg, st, batch, consecutiveFailures, descriptions);
      consecutiveFailures = result.consecutiveFailures;
      if (result.stop) return consecutiveFailures;

      // The batch's index-based progress advances only once every piece of
      // it (however it was split) has been analyzed or skipped.
      channelState.batchesDone = i + 1;
      channelState.messages += batch.length;
      persist();
      log.info('warmup: batch done', {
        channel: channel.id,
        batchIndex: i,
        batches: batches.length,
        messages: batch.length,
        tokensUsed: st.tokensUsed,
        maxTokens: cfg.maxTokens,
        requests: st.requests,
      });

      // A stop() requested while this batch was in flight takes effect now,
      // right after it: the run pauses instead of starting the next one.
      if (control?.stopRequested) {
        st.paused = true;
        persist();
        return consecutiveFailures;
      }
    }

    finishChannel();
    return consecutiveFailures;
  }

  async function doRun() {
    const cfg = hot.config.warmup ?? {};
    const st = state();
    if (st.done) return st;
    st.aborted = false; // an explicit run() call retries after an abort
    st.paused = false; // …and resumes after a stop()
    if (!st.startedAt) st.startedAt = now();
    persist();

    const guildId = getGuildId();
    const guild = guildId ? client.guilds.cache.get(guildId) : null;
    if (!guild) {
      log.warn('warmup: guild not resolved yet, cannot run');
      return st;
    }

    const control = { stopRequested: false };
    currentControl = control;

    const { plan, byId } = resolveChannels(guild);

    let consecutiveFailures = 0;
    for (const item of plan) {
      if (st.done || st.aborted || st.paused) break;
      const channel = byId.get(item.id);
      if (!channel) continue; // vanished between planning and fetching — extremely unlikely, never fatal
      consecutiveFailures = await runChannel(guildId, cfg, channel, item.depth, st, consecutiveFailures, plan.length, control);
      if (st.aborted || st.paused) break;
    }

    if (!st.done && !st.aborted && !st.paused) {
      st.done = true;
      st.finishedAt = now();
      persist();
      log.info('warmup: finished, history exhausted', { tokensUsed: st.tokensUsed, requests: st.requests });
    }

    return st;
  }

  /** Start (or resume) the warm-up run. Idempotent: a second call while running returns the same promise. */
  function run() {
    if (runningPromise) return runningPromise;
    runningPromise = doRun().finally(() => {
      runningPromise = null;
      currentControl = null;
    });
    return runningPromise;
  }

  /**
   * Ask the in-progress run to pause after the batch currently in flight —
   * a no-op when nothing is running. The paused state is persisted
   * (`paused: true`, neither `done` nor `aborted`); `isBlocking()` drops
   * immediately, and the next `run()` resumes from the saved progress.
   */
  function stop() {
    if (currentControl) currentControl.stopRequested = true;
  }

  /** A plain status object for the admin `warmup` command. */
  function status() {
    const cfg = hot.config.warmup ?? {};
    const st = store.state.data.warmup ?? {};
    const stChannels = st.channels ?? {};
    const channelIds = Object.keys(stChannels);
    const channelsDone = channelIds.filter((id) => stChannels[id].done).length;
    const messages = channelIds.reduce((sum, id) => sum + (stChannels[id].messages ?? 0), 0);

    // Best-effort total: the live plan when the guild is resolved (accurate
    // even before any channel has been touched yet), else however many
    // channel entries progress has recorded so far.
    let channelsTotal = channelIds.length;
    const guildId = getGuildId?.();
    const guild = guildId ? client.guilds?.cache?.get(guildId) : null;
    if (guild) {
      const { plan } = resolveChannels(guild);
      channelsTotal = plan.length;
    }

    const channels = channelIds.map((id) => {
      const c = stChannels[id];
      const row = { id, limit: c.limit ?? null, messages: c.messages ?? 0, batchesDone: c.batchesDone ?? 0, done: Boolean(c.done) };
      const name = guild?.channels?.cache?.get(id)?.name;
      if (name) row.name = name;
      return row;
    });

    return {
      enabled: Boolean(cfg.enabled),
      done: Boolean(st.done),
      paused: Boolean(st.paused),
      aborted: Boolean(st.aborted),
      running: runningPromise !== null,
      tokensUsed: st.tokensUsed ?? 0,
      maxTokens: cfg.maxTokens ?? 0,
      requests: st.requests ?? 0,
      channelsDone,
      channelsTotal,
      messagesAnalyzed: messages,
      skippedMessages: st.skippedMessages ?? 0,
      primaryChannelId: cfg.primaryChannelId || '',
      onlyListed: Boolean(cfg.onlyListed),
      channels,
    };
  }

  /**
   * The ordered warm-up plan as `run()` would resolve it right now, without
   * fetching a single message. Returns an empty plan (never throws) before
   * the guild has resolved.
   */
  async function plan() {
    const cfg = hot.config.warmup ?? {};
    const maxTokens = cfg.maxTokens ?? 0;
    const outputTokens = hot.config.memory?.maxOutputTokens ?? 0;
    const batchMessages = cfg.batchMessages ?? 0;

    const guildId = getGuildId?.();
    const guild = guildId ? client.guilds?.cache?.get(guildId) : null;
    if (!guild) return { plan: [], missing: [], maxTokens, outputTokens, batchMessages };

    const { plan: p, missing } = resolveChannels(guild);
    return { plan: p, missing, maxTokens, outputTokens, batchMessages };
  }

  /** Clear ONLY the warm-up progress, never any memory. Refused while running. */
  function reset() {
    if (runningPromise) throw new Error('warmup: cannot reset while running');
    delete store.state.data.warmup;
    persist();
  }

  return { run, stop, isBlocking, status, plan, reset };
}
