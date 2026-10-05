// The live side of the variety pass (src/behavior/variety.js): the persona's
// own most recent lines go to a small model pass that names the devices they
// keep reusing, and the turn's request carries the answer as `<worn>`. The
// pass is computed ahead: right after a turn posts text (`ahead`), on the
// lines the next turn will see, so that turn finds the answer ready. A turn
// (`forTurn`) uses a ready answer for its exact lines, else joins a pass
// already in flight on them, else asks itself; it waits at most
// `variety.timeoutMs` and otherwise goes without the block, but never fails.
// A request is cut only at `variety.requestTimeoutMs`: one that outlives a
// turn's wait keeps running and its answer serves the next turn. A failure is
// never kept, so the same lines are asked again by the next turn. Each landed
// pass is kept per guild in a cache (seeded from guild memory after a
// restart) and in guild memory: the latest list (`worn`) and a short history
// of shapes (`wornHistory`) for the owner. A private chat's pass is kept in
// memory only, under that chat's own cache slot, never on disk, so nothing
// said in private reaches the owner's view or another conversation, and it
// never displaces the guild's latest pass. Nothing lands while paused or with
// `features.variety` off. The persona's own lines of other channels come from
// a small ring in guild memory (`ownLines`), written here whenever a turn
// posts a message in a server channel. Logs carry counts and codes, never text.

import { classifierTextModel } from './mention.js';
import { isLimitNotice } from './limits.js';
import { helperRequestOptions } from '../llm/openrouter.js';
import {
  buildVarietyRequest,
  linesKey,
  normalizeWorn,
  parseVariety,
  selectOwnLines,
  varietyAheadOn,
  varietyOn,
  varietySettings,
} from './variety.js';
import { log } from '../log.js';

// Passes in flight kept joinable per cache slot; an older one past this is
// forgotten (its request still runs and may still land), never cancelled.
const IN_FLIGHT_PER_SLOT = 4;
// What a turn's wait resolves to when `variety.timeoutMs` ran out first.
const LATE = Symbol('late');

/**
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot
 * @param {object} deps.store   src/memory/store.js: `getGuild`, `pushOwnLine`, `setWorn`, `appendWornHistory`, `state`.
 * @param {{ complete: Function }} deps.llm
 * @param {() => number} [deps.now]
 * @returns {{ record: (guildId: string|null, line: object) => boolean,
 *   forTurn: (input: object) => Promise<{ shape: string, examples: string[], count: number }[]|null>,
 *   ahead: (input: object) => Promise<void> }}
 */
export function createVarietyPass({ hot, store, llm, now = Date.now }) {
  // cacheKeyFor() -> { key, patterns, seq }: the latest landed pass of a guild, or of one private chat
  const cache = new Map();
  // cacheKeyFor() -> Map(key -> { seq, promise }): the passes in flight, oldest first
  const inflight = new Map();
  // Every started pass takes the next number: a landed pass never replaces one started later.
  let counter = 0;
  let warnedNoPrompt = false;

  /** The cache slot of a pass: the guild's own, or a private chat's apart from it. */
  function cacheKeyFor(guildId, channelId, privateChat) {
    return privateChat ? `private:${channelId}` : guildId;
  }

  /** Whether a landing may be kept now: `features.variety` on and not paused (read at the moment of use). */
  function mayStore() {
    return varietyOn(hot.config) && !store.state?.data?.paused;
  }

  /**
   * Remember one message the persona posted in a server channel (the ring of
   * own lines, capped from `variety.window`). Nothing for a private chat (no
   * `guildId`), with `features.variety` off or while paused. Never throws.
   * @param {string|null|undefined} guildId
   * @param {{ id?: string, ts: number, channelId: string, text: string, to?: string }} line
   * @returns {boolean} whether the line was stored
   */
  function record(guildId, line) {
    try {
      if (!guildId || store.state?.data?.paused) return false;
      const config = hot.config;
      if (!varietyOn(config) || typeof store.pushOwnLine !== 'function') return false;
      return store.pushOwnLine(guildId, line, varietySettings(config).window);
    } catch (err) {
      log.warn('variety: own line not stored', { error: err });
      return false;
    }
  }

  /**
   * The latest landed pass under `slot` (cacheKeyFor): the cache, else -- for
   * the guild's own slot -- what guild memory kept (after a restart; it counts
   * as started before any pass of this process). A private chat's pass is
   * never stored, so its slot only ever lives in the cache.
   */
  function latest(guildId, slot) {
    if (cache.has(slot)) return cache.get(slot);
    if (slot !== guildId) return null;
    const stored = normalizeWorn(store.getGuild(guildId)?.worn);
    if (!stored?.key) return null;
    const entry = { key: stored.key, patterns: stored.patterns, seq: 0 };
    cache.set(slot, entry);
    return entry;
  }

  /**
   * One request on `request`, cut at `variety.requestTimeoutMs` (each attempt
   * and the whole, retries included); resolves the completion or throws (a cut
   * says `timedOut`).
   */
  async function ask(request, config, settings) {
    const controller = new AbortController();
    // Cleared as soon as the request settles. Unref'd: it only bounds a request
    // and must never keep a process alive on its own (the bot's client does).
    const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
    timer.unref?.();
    try {
      return await llm.complete(request.messages, {
        model: classifierTextModel(config),
        // The shared helper fields; the pass keeps its own clock (variety.requestTimeoutMs) and abort.
        ...helperRequestOptions(config, {
          role: 'classifier.text',
          maxOutputTokens: settings.maxOutputTokens,
          purpose: 'variety',
          timeoutMs: settings.requestTimeoutMs,
          signal: controller.signal,
          long: true,
        }),
      });
    } catch (err) {
      const failure = err instanceof Error ? err : new Error('variety pass failed');
      failure.timedOut = controller.signal.aborted;
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * What a pass on `input` would look at, or null when no pass is due:
   * `features.variety` off, no `prompts.variety` (logged once), or fewer than
   * `variety.minLines` own lines (src/behavior/variety.js#selectOwnLines:
   * `variety.window` lines younger than `variety.recentMinutes`, the turn's
   * channel first, then the ring; a limit notice is never one of them).
   */
  function plan({ guildId, channelId, history, selfName, privateChat = false }, cause) {
    const config = hot.config;
    if (!varietyOn(config)) return null;
    const prompt = hot.prompts?.variety;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      if (!warnedNoPrompt) log.warn('variety: skipped', { reason: 'no-prompt', cause });
      warnedNoPrompt = true;
      return null;
    }
    warnedNoPrompt = false;
    const settings = varietySettings(config);
    // A limit notice is the bot's, not the persona's speech: never a line of its own.
    const labels = hot.prompts?.labels;
    const lines = selectOwnLines({
      history: (Array.isArray(history) ? history : []).filter((m) => !(m?.self && isLimitNotice(labels, m.content))),
      ring: store.getGuild(guildId)?.ownLines,
      channelId,
      now: now(),
      window: settings.window,
      recentMinutes: settings.recentMinutes,
    });
    if (lines.length < settings.minLines) {
      log.info('variety: skipped', { channel: channelId, cause, reason: 'few-lines', lines: lines.length, minLines: settings.minLines });
      return null;
    }
    return {
      config,
      settings,
      prompt,
      lines,
      key: linesKey(lines),
      slot: cacheKeyFor(guildId, channelId, privateChat),
      guildId,
      channelId,
      privateChat,
      selfName,
    };
  }

  /**
   * Keep a valid answer as the slot's latest pass -- unless a pass started
   * later already landed there -- and, outside a private chat, in guild
   * memory with one more history entry. Nothing at all while paused or with
   * `features.variety` off (read now, as `record` does).
   */
  function land(p, seq, patterns) {
    if (!mayStore()) return { landed: false, stored: false };
    const current = cache.get(p.slot);
    if (current && current.seq > seq) return { landed: false, stored: false };
    cache.set(p.slot, { key: p.key, patterns, seq });
    if (p.privateChat) return { landed: true, stored: false };
    const at = now();
    store.setWorn(p.guildId, { at, key: p.key, channelId: p.channelId, lines: p.lines.length, patterns });
    store.appendWornHistory(p.guildId, { at, channelId: p.channelId, lines: p.lines.length, patterns }, varietySettings(hot.config).history);
    return { landed: true, stored: true };
  }

  /**
   * One request for plan `p` to its end: asked, validated, landed. Resolves
   * `{ patterns, parse, dropped, stored }` (`patterns` null on a failure or
   * an answer that is not the expected JSON); never rejects.
   */
  async function run(p, seq, cause) {
    const startedAt = now();
    const failed = { patterns: null, parse: null, dropped: 0, stored: false };
    try {
      const request = buildVarietyRequest({ prompt: p.prompt, selfName: p.selfName, lines: p.lines, config: p.config });
      let completion;
      try {
        completion = await ask(request, p.config, p.settings);
      } catch (err) {
        log.warn('variety: pass failed', {
          channel: p.channelId,
          cause,
          lines: p.lines.length,
          reason: err?.timedOut ? 'timeout' : 'error',
          status: err?.statusCode ?? null,
          name: err?.name ?? null,
        });
        return failed;
      }
      const parsed = parseVariety(completion?.text, request.texts, p.config);
      const { landed, stored } = parsed.ok ? land(p, seq, parsed.patterns) : { landed: false, stored: false };
      log[parsed.ok ? 'info' : 'warn']('variety: pass', {
        channel: p.channelId,
        cause,
        lines: p.lines.length,
        parse: parsed.ok ? 'ok' : 'error',
        kept: parsed.patterns.length,
        dropped: parsed.dropped,
        stored,
        landed,
        ms: now() - startedAt,
      });
      if (!parsed.ok) return { ...failed, parse: 'error' };
      return { patterns: parsed.patterns, parse: 'ok', dropped: parsed.dropped, stored };
    } catch (err) {
      log.warn('variety: failed', { channel: p.channelId, cause, error: err });
      return failed;
    }
  }

  /**
   * Start one request for plan `p` and keep it joinable under its key (at
   * most IN_FLIGHT_PER_SLOT per slot, the oldest forgotten first) until it
   * settles.
   */
  function start(p, cause) {
    const seq = ++counter;
    const entry = { seq, promise: null };
    entry.promise = run(p, seq, cause).finally(() => {
      const keys = inflight.get(p.slot);
      if (keys?.get(p.key) !== entry) return;
      keys.delete(p.key);
      if (keys.size === 0) inflight.delete(p.slot);
    });
    let keys = inflight.get(p.slot);
    if (!keys) inflight.set(p.slot, (keys = new Map()));
    keys.set(p.key, entry);
    while (keys.size > IN_FLIGHT_PER_SLOT) keys.delete(keys.keys().next().value);
    return entry;
  }

  /** `promise`'s value, or LATE once `ms` ran out first; the timer goes as soon as either happens. */
  function waitAtMost(promise, ms) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(LATE), ms);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }

  /**
   * The `<worn>` patterns for one turn, or null for no block (see `plan` for
   * when no pass is due). The same lines as the slot's latest landed pass (the
   * guild's, or in a private chat that chat's own) reuse its answer; else a
   * pass in flight on the same lines is joined; else one request starts on the
   * `classifier.text` model (counted against `llm.maxRequestsPerDay`). The turn
   * waits at most `variety.timeoutMs` from this call: past it, or when the
   * pass failed or answered something that is not the expected JSON, null --
   * a joined pass that failed is not asked again for this turn. A request
   * outliving the wait keeps running to `variety.requestTimeoutMs` and lands
   * for the next turn. Never rejects.
   * @param {{ guildId: string, channelId: string, history: object[], selfName: string, privateChat?: boolean }} input
   * @returns {Promise<{ shape: string, examples: string[], count: number }[]|null>}
   */
  async function forTurn(input) {
    const calledAt = now();
    try {
      const p = plan(input, 'turn');
      if (!p) return null;
      const base = { channel: p.channelId, lines: p.lines.length };
      const previous = latest(p.guildId, p.slot);
      if (previous?.key === p.key) {
        log.info('variety: turn', { ...base, source: 'cache', cached: true, kept: previous.patterns.length, waitedMs: now() - calledAt });
        return previous.patterns;
      }
      const running = inflight.get(p.slot)?.get(p.key);
      const source = running ? 'joined' : 'request';
      const entry = running ?? start(p, 'turn');
      const outcome = await waitAtMost(entry.promise, p.settings.timeoutMs);
      const fields = { ...base, source, cached: source !== 'request', waitedMs: now() - calledAt };
      if (outcome === LATE) {
        log.info('variety: turn', { ...fields, kept: 0, late: true });
        return null;
      }
      const patterns = outcome.patterns;
      // The turn's own request answered in time: what it answered stays on the turn's line.
      const own = source === 'request' && outcome.parse ? { parse: outcome.parse, dropped: outcome.dropped, stored: outcome.stored } : {};
      log[own.parse === 'error' ? 'warn' : 'info']('variety: turn', { ...fields, kept: patterns?.length ?? 0, ...own });
      return patterns;
    } catch (err) {
      log.warn('variety: failed', { channel: input?.channelId ?? null, cause: 'turn', error: err });
      return null;
    }
  }

  /**
   * Start the pass for the next turn without waiting, right after a turn
   * posted text: `input` is that turn's history with the posted lines, as the
   * next turn will fetch it. Nothing with `features.variety` or
   * `features.varietyPrecompute` off, while paused, when no pass is due (see
   * `plan`), or when the same lines are already answered or in flight.
   * Resolves once the pass is over (for tests; callers do not wait); never
   * rejects.
   * @param {{ guildId: string, channelId: string, history: object[], selfName: string, privateChat?: boolean }} input
   * @returns {Promise<void>}
   */
  async function ahead(input) {
    try {
      const config = hot.config;
      if (!varietyOn(config) || !varietyAheadOn(config) || store.state?.data?.paused) return;
      const p = plan(input, 'ahead');
      if (!p) return;
      if (latest(p.guildId, p.slot)?.key === p.key || inflight.get(p.slot)?.has(p.key)) return;
      await start(p, 'ahead').promise;
    } catch (err) {
      log.warn('variety: failed', { channel: input?.channelId ?? null, cause: 'ahead', error: err });
    }
  }

  return { record, forTurn, ahead };
}
