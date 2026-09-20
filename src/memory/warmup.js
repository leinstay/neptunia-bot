// The memory warm-up: before the persona is allowed to speak, read the
// server's history backwards and feed it, oldest first, through the same
// analyzer as the live memory updater (src/memory/update.js#analyze) —
// building member profiles, attitudes, the channel map and in-jokes in
// advance. Gated by `config.warmup.enabled`; spends its own token budget
// (`config.warmup.maxTokens`), never the daily LLM request cap (analyze is
// called with `countAgainstDailyCap: false`).
//
// Pure helpers (planBatches, remainingBudget, spentTokens, orderChannels) are
// unit-tested directly. The factory below is the only place that touches
// discord.js and the persisted store; progress lives in
// `store.state.data.warmup` and is flushed after every batch, so a restart
// resumes exactly where it stopped and never re-analyzes a finished batch.

import { readableChannels, lastActivity, fetchHistoryWindow } from '../discord/collect.js';
import { touchMemory } from './update.js';
import { estimateTokens } from '../llm/tokens.js';
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
 */
export function createWarmup({ hot, store, client, memory, getGuildId, now = Date.now, sleep = realSleep }) {
  let runningPromise = null;

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

  /** True from process start while a warm-up is due or running. */
  function isBlocking() {
    const cfg = hot.config.warmup ?? {};
    if (!cfg.enabled) return false;
    const st = store.state.data.warmup;
    if (st?.done) return false;
    if (st?.aborted) return false;
    return true;
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
   * @returns {Promise<{ consecutiveFailures: number, stop: boolean }>}
   *   `stop: true` means the budget ran out or the run aborted — the caller
   *   must not advance `batchesDone` and must stop processing this channel.
   */
  async function analyzePiece(guildId, channelId, batchIndex, cfg, st, piece, consecutiveFailures) {
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
      let outcome = await memory.analyze(guildId, piece, { countAgainstDailyCap: false });
      chargeAttempt(st, outcome);
      persist();

      // A 'truncated'/'bad-json' failure is never retried on the same
      // input — see isUnrecoverableSize. Every other reason keeps the
      // original retry-once behaviour below.
      if (!outcome.ok && !isUnrecoverableSize(outcome.reason) && remainingBudget(st, cfg.maxTokens) >= estimate) {
        await sleep(RETRY_DELAY_MS);
        outcome = await memory.analyze(guildId, piece, { countAgainstDailyCap: false });
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
          const first = await analyzePiece(guildId, channelId, batchIndex, cfg, st, piece.slice(0, mid), consecutiveFailures);
          if (first.stop) return first;
          return analyzePiece(guildId, channelId, batchIndex, cfg, st, piece.slice(mid), first.consecutiveFailures);
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

  async function runChannel(guildId, cfg, channel, st, consecutiveFailures, channelsTotal) {
    const channelState = (st.channels[channel.id] ??= { anchorId: null, messages: 0, batchesDone: 0, done: false });
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
      persist();
    }
    if (!channelState.anchorId) {
      finishChannel();
      return consecutiveFailures;
    }

    const minTs = cfg.maxAgeDays > 0 ? now() - cfg.maxAgeDays * 24 * 60 * 60_000 : 0;
    const window = await fetchHistoryWindow(channel, {
      anchorId: channelState.anchorId,
      limit: cfg.messagesPerChannel,
      minTs,
      selfId: client.user.id,
    });

    const batches = planBatches(window, cfg.batchMessages);
    if (batches.length === 0) {
      finishChannel();
      return consecutiveFailures;
    }

    for (let i = channelState.batchesDone; i < batches.length; i += 1) {
      const batch = batches[i];
      const result = await analyzePiece(guildId, channel.id, i, cfg, st, batch, consecutiveFailures);
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
    }

    finishChannel();
    return consecutiveFailures;
  }

  async function doRun() {
    const cfg = hot.config.warmup ?? {};
    const st = state();
    if (st.done) return st;
    st.aborted = false; // an explicit run() call retries after an abort
    if (!st.startedAt) st.startedAt = now();
    persist();

    const guildId = getGuildId();
    const guild = guildId ? client.guilds.cache.get(guildId) : null;
    if (!guild) {
      log.warn('warmup: guild not resolved yet, cannot run');
      return st;
    }

    const allowed = readableChannels(guild, hot.config.bot);
    const filtered = cfg.channels?.length > 0 ? allowed.filter((c) => cfg.channels.includes(c.id)) : allowed;
    const candidates = filtered.map((channel) => ({ channel, lastActivity: lastActivity(channel) }));
    const ordered = orderChannels(candidates).map((c) => c.channel);

    let consecutiveFailures = 0;
    for (const channel of ordered) {
      if (st.done || st.aborted) break;
      consecutiveFailures = await runChannel(guildId, cfg, channel, st, consecutiveFailures, ordered.length);
      if (st.aborted) break;
    }

    if (!st.done && !st.aborted) {
      st.done = true;
      st.finishedAt = now();
      persist();
      log.info('warmup: finished, history exhausted', { tokensUsed: st.tokensUsed, requests: st.requests });
    }

    return st;
  }

  /** Start (or join) the warm-up run. Idempotent: a second call while running returns the same promise. */
  function run() {
    if (runningPromise) return runningPromise;
    runningPromise = doRun().finally(() => {
      runningPromise = null;
    });
    return runningPromise;
  }

  /** A plain status object for the admin `warmup` command. */
  function status() {
    const cfg = hot.config.warmup ?? {};
    const st = store.state.data.warmup ?? {};
    const channels = st.channels ?? {};
    const channelIds = Object.keys(channels);
    const channelsDone = channelIds.filter((id) => channels[id].done).length;
    const messages = channelIds.reduce((sum, id) => sum + (channels[id].messages ?? 0), 0);

    // Best-effort total: the live channel list when the guild is resolved
    // (accurate even before any channel has been touched yet), else however
    // many channel entries progress has recorded so far.
    let channelsTotal = channelIds.length;
    const guildId = getGuildId?.();
    const guild = guildId ? client.guilds?.cache?.get(guildId) : null;
    if (guild) {
      const allowed = readableChannels(guild, hot.config.bot);
      const filtered = cfg.channels?.length > 0 ? allowed.filter((c) => cfg.channels.includes(c.id)) : allowed;
      channelsTotal = filtered.length;
    }

    return {
      enabled: Boolean(cfg.enabled),
      done: Boolean(st.done),
      aborted: Boolean(st.aborted),
      running: runningPromise !== null,
      tokensUsed: st.tokensUsed ?? 0,
      maxTokens: cfg.maxTokens ?? 0,
      requests: st.requests ?? 0,
      channelsDone,
      channelsTotal,
      messagesAnalyzed: messages,
      skippedMessages: st.skippedMessages ?? 0,
    };
  }

  /** Clear ONLY the warm-up progress, never any memory. Refused while running. */
  function reset() {
    if (runningPromise) throw new Error('warmup: cannot reset while running');
    delete store.state.data.warmup;
    persist();
  }

  return { run, isBlocking, status, reset };
}
