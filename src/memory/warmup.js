// The memory warm-up: before the persona is allowed to speak, read the
// server's history and feed it through the same analyzer as the live memory
// updater (src/memory/update.js#analyze) — building member profiles,
// attitudes, the channel map and in-jokes in advance. Gated by
// `config.warmup.enabled`; spends its own token budget (`config.warmup.maxTokens`),
// never the daily LLM request cap (analyze is called with `countAgainstDailyCap: false`).
//
// Unlike the live updater, which sees one channel's messages at a time, the
// warm-up reads ONE chronological timeline stitched together across every
// planned channel: the analyzer's "a later batch refines an earlier one" rule
// only holds when batches move forward in time, and a channel read start-to
// -finish before the next one began would mix a 2024 conversation processed
// after a 2026 one, overwriting fresh prose with stale prose. The owner can
// shape which channels are read and how deep, from Discord (see src/admin.js
// `warmup …` sub-commands): `warmup.channelDepths` sets a per-channel depth in
// messages counted from the newest backwards, and `warmup.onlyListed`
// restricts the run to just those channels. `planWarmup` turns that
// configuration plus the readable channels into the ordered plan (for display
// only — the actual run order is chronological, not plan order); it never
// throws on a stale id (deleted channel, lost access) — those come back
// separately as `missing`.
//
// The run:
//  1. Every planned channel's window is (re-)fetched with fetchHistoryWindow,
//     from a frozen `{ anchorId, limit }` recorded the first time that
//     channel is touched (so a later config change never shifts an
//     in-progress channel's window) — a channel whose fetch fails is logged
//     and skipped for this round, never fatal.
//  2. All the fetched windows are merged into one timeline (mergeTimeline),
//     sorted by message id as BigInt (Discord snowflakes are globally
//     chronological), with everything already covered by `cursorId` dropped.
//  3. The timeline is cut into windows sized `batchMessages * windowBatches`
//     (cutWindow), preferring to cut at a pause in the conversation over a
//     hard cut mid-scene.
//  4. Each window is packed into batches (packWindow): messages are grouped
//     by channel into contiguous slices, and slices are greedily packed
//     together (small scraps of quiet channels share one call) or chunked
//     (a slice bigger than one batch) — but never interleaved within a batch.
//  5. Batches are analyzed in order, exactly like the live updater's calls,
//     just batched together. Progress persists `cursorId` (the last message
//     id of the last fully completed window) and `windowBatchesDone` (batches
//     done inside the CURRENT window), so a restart rebuilds the same window
//     after `cursorId` and skips only the batches already done in it.
//
// Pure helpers (planBatches, remainingBudget, spentTokens, orderChannels,
// planWarmup, mergeTimeline, cutWindow, packWindow) are unit-tested directly.
// The factory below is the only place that touches discord.js and the
// persisted store; progress lives in `store.state.data.warmup` and is flushed
// after every batch, so a restart resumes exactly where it stopped and never
// re-analyzes a finished batch. The depth used for a channel, and the
// batching parameters (`batchMessages`, `windowBatches`, `cutAtGapMinutes`)
// themselves, are frozen into progress the first time a run actually starts,
// so a later config change never shifts an in-progress run's batch indexes;
// `warmup reset` is the only way to pick up new values.
//
// Adaptive piece size: once a dense stretch of chat makes a full-size batch
// come back 'truncated'/'bad-json' (see isUnrecoverableSize) and a split
// succeeds, this run remembers the size that worked and cuts every following
// batch to at most that size up front, instead of always paying for one
// doomed full-size attempt before splitting again. It only ever shrinks to
// the size an actual split proved necessary (never below SPLIT_FLOOR), and
// climbs back up (doubling, capped at the configured batch size) after
// CLEAN_STREAK_TARGET batches in a row needed no split at all. This lives in
// a plain closure variable — in memory only, never persisted — so a restart
// always tries the next batch at full size again; the persisted resume
// bookkeeping below (`windowBatchesDone`, per-channel `limit`/`anchorId`) is
// completely unaffected by it.

import { readableChannels, lastActivity, fetchHistoryWindow } from '../discord/collect.js';
import { touchMemory } from './update.js';
import { estimateTokens } from '../llm/tokens.js';
import { collectPictures, collectEmojiItems, isDescribable } from '../discord/media.js';
import { log } from '../log.js';

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 5000;
const BATCH_OVERHEAD_TOKENS = 500; // a rough allowance for the prompt scaffolding around the transcript
const SPLIT_FLOOR = 20; // a piece this small or smaller that still fails a 'truncated'/'bad-json' analysis is skipped, not split further
const CLEAN_STREAK_TARGET = 5; // consecutive split-free batches before the adaptive piece size is allowed to grow again
const DEFAULT_RATE_LIMIT_WAIT_MINUTES = 10;
const DEFAULT_RATE_LIMIT_MAX_WAITS = 36;
const RATE_LIMIT_DETAIL_RE = /rate.?limit|too many (tokens|requests)/i;

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed analyzer outcome is a provider rate limit rather than a
 * genuine failure: an HTTP 429, or a detail message that reads like one
 * (some providers report it inside a 200/500 wrapper instead of a plain
 * 429 -- see the header comment of src/llm/openrouter.js's callers).
 * @param {{ ok: boolean, status?: number, detail?: string }|null|undefined} outcome
 */
function isRateLimited(outcome) {
  if (!outcome || outcome.ok) return false;
  if (outcome.status === 429) return true;
  return RATE_LIMIT_DETAIL_RE.test(outcome.detail ?? '');
}

/** Best-effort provider name out of an OpenRouter error detail, for the rate-limit wait log only. */
function extractProvider(detail) {
  const match = /"provider_name"\s*:\s*"([^"]+)"/.exec(detail ?? '');
  return match ? match[1] : undefined;
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

/**
 * Cut an already-filtered batch (oldest first) into consecutive chunks of at
 * most `size` messages, no bot-filtering (that already happened upstream).
 * Used to pre-split a batch to the adaptive piece size before ever attempting
 * it whole — see the module header comment.
 * @param {object[]} messages
 * @param {number} size
 * @returns {object[][]}
 */
function chunkPieces(messages, size) {
  const chunks = [];
  for (let i = 0; i < messages.length; i += size) {
    chunks.push(messages.slice(i, i + size));
  }
  return chunks;
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
 * owner's custom warm-up configuration. Never throws on a stale id. This
 * plan is used for display (`warmup plan`) and to decide WHICH channels and
 * how deep each is read; the run itself then reads them as one merged
 * chronological timeline, not in this plan's order — see the module header
 * comment.
 *
 * - a channel's depth is `cfg.channelDepths[id]` when that is an integer
 *   >= 0, else `cfg.messagesPerChannel`; a depth of 0 drops the channel from
 *   the plan entirely; a non-integer/negative entry is treated as absent
 *   (falls back to `cfg.messagesPerChannel`, same as no entry at all);
 * - `cfg.onlyListed: true` keeps only channels with a valid `channelDepths`
 *   entry — everything else is dropped;
 * - display order: depth descending, ties broken by most recently active
 *   first.
 *
 * @param {{ id: string, name: string, lastActivity: number }[]} candidates  The readable channels.
 * @param {{
 *   channelDepths?: Record<string, number>,
 *   onlyListed?: boolean,
 *   messagesPerChannel: number,
 * }} cfg
 * @returns {{
 *   plan: { id: string, name: string, depth: number, role: 'listed'|'default' }[],
 *   missing: string[],
 * }}
 */
export function planWarmup(candidates, cfg) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const channelDepths = cfg?.channelDepths && typeof cfg.channelDepths === 'object' ? cfg.channelDepths : {};
  const onlyListed = Boolean(cfg?.onlyListed);
  const defaultDepth =
    Number.isInteger(cfg?.messagesPerChannel) && cfg.messagesPerChannel >= 0 ? cfg.messagesPerChannel : 0;

  const validDepth = (raw) => (Number.isInteger(raw) && raw >= 0 ? raw : null);
  const depthFor = (id) => {
    const v = validDepth(channelDepths[id]);
    return v === null ? defaultDepth : v;
  };

  const missing = [];
  for (const id of Object.keys(channelDepths)) {
    if (!byId.has(id)) missing.push(id);
  }

  // A channel counts as "listed" only with a genuinely valid depth entry;
  // a garbage value (non-integer, negative) is treated as no entry at all.
  const listedIds = new Set();
  for (const id of Object.keys(channelDepths)) {
    if (!byId.has(id)) continue;
    if (validDepth(channelDepths[id]) === null) continue;
    listedIds.add(id);
  }

  const included = onlyListed ? candidates.filter((c) => listedIds.has(c.id)) : candidates;

  const plan = included
    .map((c) => ({
      id: c.id,
      name: c.name,
      depth: depthFor(c.id),
      lastActivity: c.lastActivity,
      role: listedIds.has(c.id) ? 'listed' : 'default',
    }))
    .filter((c) => c.depth > 0)
    .sort((a, b) => b.depth - a.depth || b.lastActivity - a.lastActivity)
    .map(({ lastActivity: _lastActivity, ...rest }) => rest);

  return { plan, missing };
}

/**
 * Merge already-fetched, per-channel windows (each oldest first) into one
 * globally chronological timeline: Discord message ids (snowflakes) are
 * compared as BigInt, which sorts them exactly the same as their creation
 * time. Everything with an id <= `cursorId` (already fully analyzed by an
 * earlier window) is dropped.
 * @param {object[][]} windows
 * @param {string|null} [cursorId]
 * @returns {object[]}
 */
export function mergeTimeline(windows, cursorId = null) {
  const merged = windows.flat();
  merged.sort((a, b) => {
    const ai = BigInt(a.id);
    const bi = BigInt(b.id);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  });
  if (cursorId == null) return merged;
  const cursor = BigInt(cursorId);
  return merged.filter((m) => BigInt(m.id) > cursor);
}

/**
 * Cut the front of `timeline` into one window of roughly `targetSize`
 * messages, preferring to cut at a pause in the conversation: within the
 * last third of the target span, the largest gap between two consecutive
 * timeline messages that is at least `cutAtGapMinutes` long is cut right
 * before the message after it. With no such gap, the window is cut exactly
 * at `targetSize`. When the whole timeline already fits in `targetSize`, the
 * window is everything that is left (the run's final window).
 * @param {object[]} timeline  Chronological, as from mergeTimeline.
 * @param {number} targetSize
 * @param {number} cutAtGapMinutes
 * @returns {{ window: object[], rest: object[] }}
 */
export function cutWindow(timeline, targetSize, cutAtGapMinutes) {
  if (timeline.length <= targetSize) {
    return { window: timeline, rest: [] };
  }

  const gapMs = cutAtGapMinutes * 60_000;
  const searchStart = Math.max(1, Math.ceil((targetSize * 2) / 3));
  let bestGap = -1;
  let bestIndex = -1;
  for (let i = searchStart; i <= targetSize; i += 1) {
    const gap = timeline[i].ts - timeline[i - 1].ts;
    if (gap >= gapMs && gap > bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }
  const cutIndex = bestIndex !== -1 ? bestIndex : targetSize;
  return { window: timeline.slice(0, cutIndex), rest: timeline.slice(cutIndex) };
}

/**
 * Pack one timeline window into analyzer batches of at most `batchMessages`
 * each, grouped by channel: the window's messages are split into contiguous
 * per-channel slices (ordered by each slice's first message, i.e.
 * chronologically), then walked greedily — a slice that fits in the room
 * left in the current batch joins it, one that does not fit flushes the
 * current batch first, and a slice bigger than `batchMessages` is cut into
 * `batchMessages`-sized chunks (via planBatches) whose last, partial chunk
 * stays open so the next small slice can still share it. Messages never
 * interleave across channels within one batch. Other bots' messages are
 * dropped up front, same as planBatches.
 * @param {object[]} window  Chronological, as from cutWindow.
 * @param {number} batchMessages
 * @returns {object[][]}
 */
export function packWindow(window, batchMessages) {
  const filtered = window.filter((m) => !m.bot);
  if (filtered.length === 0) return [];

  const slicesByChannel = new Map();
  for (const message of filtered) {
    if (!slicesByChannel.has(message.channelId)) slicesByChannel.set(message.channelId, []);
    slicesByChannel.get(message.channelId).push(message);
  }
  // Map insertion order already matches "first appearance" order, since
  // `filtered` is chronological -- no separate sort needed.
  const slices = [...slicesByChannel.values()];

  const batches = [];
  let current = [];
  for (const slice of slices) {
    const room = batchMessages - current.length;
    if (slice.length <= room) {
      current = current.concat(slice);
      continue;
    }
    if (current.length > 0) {
      batches.push(current);
      current = [];
    }
    if (slice.length <= batchMessages) {
      current = slice.slice();
    } else {
      const chunks = planBatches(slice, batchMessages);
      for (let i = 0; i < chunks.length - 1; i += 1) batches.push(chunks[i]);
      current = chunks[chunks.length - 1] ?? [];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
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

/**
 * One run's stop signal: a plain `stopRequested` flag for the post-batch
 * check, plus a `stopped` promise a rate-limit wait can race against so
 * `stop()` interrupts it immediately instead of only taking effect after the
 * wait finishes on its own.
 */
function makeControl() {
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  return {
    stopRequested: false,
    stopped,
    requestStop() {
      if (this.stopRequested) return;
      this.stopRequested = true;
      resolveStopped();
    },
  };
}

function freshState() {
  return {
    version: 2,
    done: false,
    aborted: false,
    paused: false,
    startedAt: null,
    finishedAt: null,
    tokensUsed: 0,
    requests: 0,
    skippedMessages: 0,
    cursorId: null,
    windowBatchesDone: 0,
    reachedTs: 0,
    messagesTotal: 0,
    batchMessages: null,
    windowBatches: null,
    cutAtGapMinutes: null,
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
  // Whether THIS process instance has itself aborted a run (three strikes, or
  // too many consecutive rate-limit waits) — as opposed to an `aborted: true`
  // found already persisted at process start, e.g. from a run the previous
  // process gave up on. Distinguishing the two is the whole point of the
  // start-up resume fix below: an abort inherited from disk must still let
  // the next process try again once, but an abort THIS process produced
  // itself must not be retried forever within its own lifetime (or the
  // persona would spin on the same failing provider indefinitely).
  let hasAbortedInProcess = false;

  // Adaptive piece size for this run: `null` means uncapped (attempt a batch
  // whole, at cfg.batchMessages, as before). In memory only — see the module
  // header comment — so a fresh process/factory always starts here again.
  let pieceCap = null;
  // Consecutive top-level batches, at the current pieceCap, that needed no
  // truncated/bad-json split at all. Reaching CLEAN_STREAK_TARGET doubles
  // pieceCap (capped at cfg.batchMessages) and resets to 0; any split resets
  // it to 0 immediately, regardless of how many batches it had reached.
  let cleanStreak = 0;

  /**
   * Called once a top-level batch has fully resolved (every one of its
   * pieces analyzed or skipped, none of them still in flight): applies
   * whatever `sizeTracker` observed to the adaptive piece size and logs the
   * change, if any. `sizeTracker` is `{ truncated, shrinkTo }`, mutated by
   * analyzePiece while processing that one top-level batch's pieces (see
   * below).
   */
  function noteBatchOutcome(cfg, sizeTracker) {
    const fullSize = cfg.batchMessages;
    if (sizeTracker.truncated) {
      cleanStreak = 0;
      if (sizeTracker.shrinkTo !== null) {
        const from = pieceCap ?? fullSize;
        const to = sizeTracker.shrinkTo;
        pieceCap = to;
        if (to !== from) {
          log.info('warmup: piece size changed', { from, to, reason: 'truncated' });
        }
      }
      return;
    }
    if (pieceCap === null) return; // already uncapped, nothing to grow back to
    cleanStreak += 1;
    if (cleanStreak < CLEAN_STREAK_TARGET) return;
    cleanStreak = 0;
    const from = pieceCap;
    const doubled = pieceCap * 2;
    const recovered = Number.isFinite(fullSize) && doubled >= fullSize;
    const to = recovered ? fullSize : doubled;
    pieceCap = recovered ? null : doubled;
    log.info('warmup: piece size changed', { from, to, reason: 'recovered' });
  }

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
   * config says one is due (enabled, not done/paused, and either never
   * aborted or aborted only in a PREVIOUS process — see `hasAbortedInProcess`
   * above, which makes a fresh abort within this process's own run() stop
   * blocking for the rest of this process's lifetime) or a run is actually in
   * flight right now — including one the owner started by hand with
   * `warmup.enabled: false`, or one resuming after `stop()`.
   */
  function isBlocking() {
    if (runningPromise) return true;
    // F30 (/nep pause): the owner is editing data/ by hand -- the warm-up
    // must not auto-start (or count as due) until /nep resume, even if it
    // would otherwise be enabled and not yet done.
    if (store.state.data.paused) return false;
    const cfg = hot.config.warmup ?? {};
    if (!cfg.enabled) return false;
    const st = store.state.data.warmup;
    if (st?.done) return false;
    if (st?.paused) return false;
    if (st?.aborted) return !hasAbortedInProcess;
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
      for (const item of [...collectPictures(message), ...collectEmojiItems(message)]) {
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
   * Wait out one rate-limited attempt: sleeps `warmup.rateLimitWaitMinutes`
   * (default 10) and reports whether the run should keep going. Interrupted
   * promptly by `stop()` — the wait races the injected `sleep` against
   * `control.stopped`, which `stop()` resolves immediately — in which case
   * the caller pauses instead of retrying. After
   * `warmup.rateLimitMaxWaits` (default 36, i.e. six hours at the default
   * wait) consecutive waits for the SAME piece, the caller aborts instead of
   * waiting again.
   * @param {object} cfg  `hot.config.warmup`.
   * @param {number} waits  Waits already spent on this piece before this call.
   * @param {{ detail?: string }} outcome  The rate-limited outcome, for the provider name in the log line.
   * @param {{ stopped: Promise<void> }|null} control
   * @returns {Promise<{ waits: number, giveUp: 'abort'|'pause'|null }>}
   */
  async function waitOutRateLimit(cfg, waits, outcome, control) {
    const waitMinutes = cfg.rateLimitWaitMinutes ?? DEFAULT_RATE_LIMIT_WAIT_MINUTES;
    const maxWaits = cfg.rateLimitMaxWaits ?? DEFAULT_RATE_LIMIT_MAX_WAITS;
    const waitsSoFar = waits + 1;
    if (waitsSoFar > maxWaits) return { waits: waitsSoFar, giveUp: 'abort' };

    const fields = { waitMinutes, waits: waitsSoFar };
    const provider = extractProvider(outcome?.detail);
    if (provider) fields.provider = provider;
    log.warn('warmup: rate limited, waiting', fields);

    const ms = waitMinutes * 60_000;
    let interrupted = false;
    if (control) {
      // control.stopped listed FIRST: when stop() already resolved it before
      // this wait even started (as in an owner-triggered pause caught mid-attempt),
      // both promises settle within the same microtask flush against a fake/instant
      // `sleep` in tests -- listing the already-settled one first makes Promise.race
      // resolve to it deterministically, matching a real, much-later `sleep` where
      // `stopped` would win on actual timing regardless of list order.
      const winner = await Promise.race([control.stopped.then(() => 'stopped'), sleep(ms).then(() => 'slept')]);
      interrupted = winner === 'stopped';
    } else {
      await sleep(ms);
    }
    return { waits: waitsSoFar, giveUp: interrupted ? 'pause' : null };
  }

  /**
   * Analyze one piece of a batch (the whole batch on the first call, a half
   * of it once split). Never retries a 'truncated'/'bad-json' failure on the
   * same input: it halves the piece instead (oldest half first), recursing
   * down to `SPLIT_FLOOR` messages; a piece that size or smaller that still
   * fails that way is SKIPPED (counted in `st.skippedMessages`) so a single
   * poisonous piece can never stall or abort the whole warm-up. A rate-limited
   * failure (see isRateLimited) is neither a strike nor a plain retry: it
   * waits out via waitOutRateLimit and then retries the SAME piece, without
   * touching `consecutiveFailures`. Every other failure reason keeps the
   * existing retry-once + 3-consecutive-cycles abort behaviour, unchanged.
   *
   * @param {string[]} channelIds  Every channel this piece's messages belong to (log field only).
   * @param {Map<string, string>} [descriptions]  Pre-computed describer captions for this batch
   *   (see describeBatchForWarmup), reused unchanged across a split.
   * @param {{ stopRequested: boolean, stopped: Promise<void> }} [control]
   * @param {boolean} [fromSplit]  True for a piece produced by splitting a
   *   'truncated'/'bad-json' failure (at any recursion depth) — as opposed to
   *   a piece the caller pre-cut to the current adaptive size. Only a piece
   *   that succeeds AND carries this flag can shrink the adaptive size: it is
   *   proof that this smaller size was actually necessary, not just a piece
   *   that happened to already fit.
   * @param {{ truncated: boolean, shrinkTo: number|null }} [sizeTracker]  Shared across every
   *   piece of one top-level batch (see runWindow): set truncated=true on any
   *   'truncated'/'bad-json' failure, and shrinkTo to the smallest successful
   *   fromSplit piece size seen. Read once the whole top-level batch settles.
   * @returns {Promise<{ consecutiveFailures: number, stop: boolean }>}
   *   `stop: true` means the budget ran out, the run aborted, or a rate-limit
   *   wait was interrupted by stop() — the caller must not advance
   *   `windowBatchesDone` and must stop processing this window.
   */
  async function analyzePiece(guildId, channelIds, batchIndex, cfg, st, piece, consecutiveFailures, descriptions, control, fromSplit = false, sizeTracker = null) {
    let rateLimitWaits = 0;

    /** Handles a rate-limited `outcome`: waits, then either signals `continue` or returns the piece's final result. */
    async function handleRateLimit(outcome) {
      const wait = await waitOutRateLimit(cfg, rateLimitWaits, outcome, control);
      rateLimitWaits = wait.waits;
      if (wait.giveUp === 'abort') {
        st.aborted = true;
        hasAbortedInProcess = true;
        persist();
        log.error('warmup: aborting after repeated rate limits', {
          guildId,
          tokensUsed: st.tokensUsed,
          requests: st.requests,
        });
        return { consecutiveFailures, stop: true };
      }
      if (wait.giveUp === 'pause') {
        st.paused = true;
        persist();
        return { consecutiveFailures, stop: true };
      }
      return null; // keep going: retry the same piece
    }

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

      if (isRateLimited(outcome)) {
        const settled = await handleRateLimit(outcome);
        if (settled) return settled;
        continue;
      }

      // A 'truncated'/'bad-json' failure is never retried on the same
      // input — see isUnrecoverableSize. Every other reason keeps the
      // original retry-once behaviour below.
      if (!outcome.ok && !isUnrecoverableSize(outcome.reason) && remainingBudget(st, cfg.maxTokens) >= estimate) {
        await sleep(RETRY_DELAY_MS);
        outcome = await memory.analyze(guildId, piece, { countAgainstDailyCap: false, descriptions });
        chargeAttempt(st, outcome);
        persist();

        if (isRateLimited(outcome)) {
          const settled = await handleRateLimit(outcome);
          if (settled) return settled;
          continue;
        }
      }

      if (outcome.ok) {
        // Bookkeeping (touchUser/touchChannel) happens only once a piece is
        // actually applied — computed the same way `observe()` does it, via
        // the shared helper, so a resume never re-touches an already-counted
        // message and a mid-cycle retry never double-counts one either.
        for (const message of piece) touchMemory(store, guildId, message);
        if (fromSplit && sizeTracker) {
          const provenSize = Math.max(SPLIT_FLOOR, piece.length);
          if (sizeTracker.shrinkTo === null || provenSize < sizeTracker.shrinkTo) sizeTracker.shrinkTo = provenSize;
        }
        return { consecutiveFailures: 0, stop: false };
      }

      if (isUnrecoverableSize(outcome.reason)) {
        if (sizeTracker) sizeTracker.truncated = true;
        if (piece.length > SPLIT_FLOOR) {
          const mid = Math.ceil(piece.length / 2);
          log.warn('warmup: batch failed, splitting', {
            guildId,
            channels: channelIds,
            batchIndex,
            messages: piece.length,
            reason: outcome.reason,
            detail: outcome.detail,
          });
          const first = await analyzePiece(guildId, channelIds, batchIndex, cfg, st, piece.slice(0, mid), consecutiveFailures, descriptions, control, true, sizeTracker);
          if (first.stop) return first;
          return analyzePiece(guildId, channelIds, batchIndex, cfg, st, piece.slice(mid), first.consecutiveFailures, descriptions, control, true, sizeTracker);
        }

        st.skippedMessages = (st.skippedMessages ?? 0) + piece.length;
        persist();
        log.warn('warmup: batch failed at the floor, skipping', {
          guildId,
          channels: channelIds,
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
        channels: channelIds,
        batchIndex,
        messages: piece.length,
        reason: outcome.reason,
        detail: outcome.detail,
        consecutiveFailures,
      });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        st.aborted = true;
        hasAbortedInProcess = true;
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

  /**
   * (Re-)fetch every planned channel's window, freezing `{ anchorId, limit }`
   * into `st.channels[id]` the first time a channel is touched (so a later
   * config change never shifts its window). A channel with nothing to read
   * yet (no `lastMessageId`) or whose fetch throws is logged and skipped for
   * this round — never fatal to the run.
   * @returns {Promise<object[][]>}  One array per successfully fetched channel.
   */
  async function fetchAllWindows(guildId, cfg, plan, byId, st) {
    const minTs = cfg.maxAgeDays > 0 ? now() - cfg.maxAgeDays * 24 * 60 * 60_000 : 0;
    const windows = [];
    for (const item of plan) {
      const channel = byId.get(item.id);
      if (!channel) continue; // vanished between planning and fetching — extremely unlikely, never fatal

      const channelState = (st.channels[item.id] ??= { anchorId: null, limit: null, messages: 0 });
      if (!channelState.anchorId) {
        channelState.anchorId = channel.lastMessageId ?? null;
        if (channelState.anchorId) channelState.limit = item.depth;
        persist();
      }
      // A resume always re-fetches the SAME window it started with, even if
      // the configured depth for this channel changed meanwhile.
      if (channelState.limit == null && channelState.anchorId) channelState.limit = item.depth;
      if (!channelState.anchorId) continue; // an empty channel: nothing to fetch, ever

      try {
        const window = await fetchHistoryWindow(channel, {
          anchorId: channelState.anchorId,
          limit: channelState.limit,
          minTs,
          selfId: client.user.id,
          embedTextChars: hot.config.media?.embedTextChars,
        });
        log.info('warmup: channel fetched', { channel: item.id, messages: window.length });
        if (window.length > 0) windows.push(window);
      } catch (err) {
        log.warn('warmup: channel fetch failed, skipping it for this round', { channel: item.id, error: err });
      }
    }
    return windows;
  }

  /** Run every batch of one timeline window, resuming at `st.windowBatchesDone`. Returns `true` if the whole window finished. */
  async function runWindow(guildId, cfg, window, st, consecutiveFailuresRef) {
    const batches = packWindow(window, st.batchMessages);

    for (let i = st.windowBatchesDone; i < batches.length; i += 1) {
      const batch = batches[i];
      const descriptions = await describeBatchForWarmup(guildId, batch, cfg, st);
      const channelIds = [...new Set(batch.map((m) => m.channelId))];

      const pieces = pieceCap !== null && pieceCap < batch.length ? chunkPieces(batch, pieceCap) : [batch];
      const sizeTracker = { truncated: false, shrinkTo: null };
      let stoppedMidBatch = false;
      for (const piece of pieces) {
        const result = await analyzePiece(guildId, channelIds, i, cfg, st, piece, consecutiveFailuresRef.value, descriptions, currentControl, false, sizeTracker);
        consecutiveFailuresRef.value = result.consecutiveFailures;
        if (result.stop) {
          stoppedMidBatch = true;
          break;
        }
      }
      if (stoppedMidBatch) return false;
      noteBatchOutcome(cfg, sizeTracker);

      // The batch's index-based progress advances only once every piece of
      // it (however it was split) has been analyzed or skipped.
      st.windowBatchesDone = i + 1;
      for (const message of batch) {
        const channelState = st.channels[message.channelId];
        if (channelState) channelState.messages = (channelState.messages ?? 0) + 1;
      }
      persist();
      log.info('warmup: batch done', {
        channels: channelIds,
        batchIndex: i,
        batches: batches.length,
        messages: batch.length,
        tokensUsed: st.tokensUsed,
        maxTokens: cfg.maxTokens,
        requests: st.requests,
      });

      // A stop() requested while this batch was in flight takes effect now,
      // right after it: the run pauses instead of starting the next one.
      if (currentControl?.stopRequested) {
        st.paused = true;
        persist();
        return false;
      }
    }

    return true;
  }

  async function doRun() {
    const cfg = hot.config.warmup ?? {};

    // Progress written by the old, channel-after-channel scheme: a finished
    // run stays finished (nothing else to do); an unfinished one is
    // discarded — never any memory, only this progress record — and the
    // timeline starts from the beginning.
    const existing = store.state.data.warmup;
    if (existing && existing.version !== 2 && !existing.done) {
      log.warn('warmup: discarding progress written by an older version, memory is untouched');
      delete store.state.data.warmup;
    }

    const st = state();
    if (st.done) return st;
    st.aborted = false; // an explicit run() call retries after an abort
    st.paused = false; // …and resumes after a stop()
    if (!st.startedAt) st.startedAt = now();
    // The batching parameters are frozen the first time a run actually
    // starts, so a config change mid-run never shifts batch indexes —
    // `warmup reset` is what picks up new values.
    if (st.batchMessages == null) st.batchMessages = cfg.batchMessages;
    if (st.windowBatches == null) st.windowBatches = cfg.windowBatches;
    if (st.cutAtGapMinutes == null) st.cutAtGapMinutes = cfg.cutAtGapMinutes;
    persist();

    const guildId = getGuildId();
    const guild = guildId ? client.guilds.cache.get(guildId) : null;
    if (!guild) {
      log.warn('warmup: guild not resolved yet, cannot run');
      return st;
    }

    const control = makeControl();
    currentControl = control;

    const { plan, byId } = resolveChannels(guild);
    const windows = await fetchAllWindows(guildId, cfg, plan, byId, st);

    let timeline = mergeTimeline(windows, st.cursorId);
    if (st.cursorId == null && !st.messagesTotal) {
      st.messagesTotal = timeline.length;
      persist();
    }

    const targetSize = st.batchMessages * st.windowBatches;
    const consecutiveFailuresRef = { value: 0 };

    while (timeline.length > 0) {
      if (st.done || st.aborted || st.paused) break;

      const { window, rest } = cutWindow(timeline, targetSize, st.cutAtGapMinutes);
      const finished = await runWindow(guildId, cfg, window, st, consecutiveFailuresRef);
      if (!finished) return st;

      const last = window[window.length - 1];
      st.cursorId = last.id;
      st.windowBatchesDone = 0;
      st.reachedTs = last.ts;
      persist();
      log.info('warmup: window done', { messages: window.length, reachedTs: st.reachedTs });

      timeline = rest;
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
   * immediately, and the next `run()` resumes from the saved progress. Also
   * interrupts a rate-limit wait in progress (see waitOutRateLimit) promptly,
   * rather than waiting out the full `warmup.rateLimitWaitMinutes`.
   */
  function stop() {
    currentControl?.requestStop();
  }

  /** A plain status object for the admin `warmup` command. */
  function status() {
    const cfg = hot.config.warmup ?? {};
    const st = store.state.data.warmup ?? {};
    const stChannels = st.channels ?? {};
    const channelIds = Object.keys(stChannels);
    const messages = channelIds.reduce((sum, id) => sum + (stChannels[id].messages ?? 0), 0);

    const guildId = getGuildId?.();
    const guild = guildId ? client.guilds?.cache?.get(guildId) : null;

    const channels = channelIds.map((id) => {
      const c = stChannels[id];
      const row = { id, limit: c.limit ?? null, messages: c.messages ?? 0 };
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
      messagesAnalyzed: messages,
      messagesTotal: st.messagesTotal ?? 0,
      reachedTs: st.reachedTs ?? 0,
      skippedMessages: st.skippedMessages ?? 0,
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
