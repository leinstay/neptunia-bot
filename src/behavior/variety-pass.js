// The live side of the variety pass (src/behavior/variety.js): before a turn,
// the persona's own most recent lines go to a small model pass that names the
// devices they keep reusing, and the turn's request carries the answer as
// `<worn>`. The pass runs alongside the other pre-turn work and is bounded by
// `variety.timeoutMs`: a slow or failed pass never delays the turn past that
// or fails it, the turn simply goes without the block. The same set of lines
// is never asked about twice in a row (a per-guild cache, seeded from guild
// memory after a restart). Each pass that ran is kept in guild memory: the
// latest list (`worn`) and a short history of shapes (`wornHistory`) for the
// owner; a private chat's pass is kept in memory only, never on disk, so
// nothing said in private reaches the owner's view or another conversation.
// The persona's own lines of other channels come from a small ring in guild
// memory (`ownLines`), written here whenever a turn posts a message in a
// server channel. Logs carry counts, never text.

import { classifierTextModel } from './mention.js';
import { isLimitNotice } from './limits.js';
import { buildVarietyRequest, linesKey, normalizeWorn, parseVariety, selectOwnLines, varietyOn, varietySettings } from './variety.js';
import { log } from '../log.js';

/**
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot
 * @param {object} deps.store   src/memory/store.js: `getGuild`, `pushOwnLine`, `setWorn`, `appendWornHistory`, `state`.
 * @param {{ complete: Function }} deps.llm
 * @param {() => number} [deps.now]
 * @returns {{ record: (guildId: string|null, line: object) => boolean,
 *   forTurn: (input: object) => Promise<{ shape: string, examples: string[], count: number }[]|null> }}
 */
export function createVarietyPass({ hot, store, llm, now = Date.now }) {
  const cache = new Map(); // guildId -> { key, patterns }: the latest pass of that guild
  let warnedNoPrompt = false;

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

  /** The guild's latest pass: the cache, else what guild memory kept (after a restart). */
  function latest(guildId) {
    if (cache.has(guildId)) return cache.get(guildId);
    const stored = normalizeWorn(store.getGuild(guildId)?.worn);
    if (!stored?.key) return null;
    const entry = { key: stored.key, patterns: stored.patterns };
    cache.set(guildId, entry);
    return entry;
  }

  /** One pass on `request`, cut at `timeoutMs`; resolves the completion or throws (an abort says `timedOut`). */
  async function ask(request, config, settings) {
    const controller = new AbortController();
    // Not unref'd: the timer is cleared as soon as the request settles, and it must fire to cut a hung one.
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      return await llm.complete(request.messages, {
        model: classifierTextModel(config),
        role: 'classifier.text',
        maxOutputTokens: settings.maxOutputTokens,
        timeoutMs: settings.timeoutMs,
        countAgainstDailyCap: true,
        skipCalibration: true,
        signal: controller.signal,
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
   * The `<worn>` patterns for one turn, or null for no block. With
   * `features.variety` on and `prompts.variety` present (missing: logged
   * once), the persona's own lines are chosen (src/behavior/variety.js
   * #selectOwnLines: `variety.window` lines younger than
   * `variety.recentMinutes`, the turn's channel first, then the ring); fewer
   * than `variety.minLines` -> null. The same lines as the guild's latest
   * pass reuse its answer without a request; otherwise one request on the
   * `classifier.text` model (counted against `llm.maxRequestsPerDay`), cut at
   * `variety.timeoutMs`. A failure, a timeout or an answer that is not the
   * expected JSON -> null (and the latest pass stays as it was). A valid
   * answer (even an empty one) becomes the guild's latest pass and, outside a
   * private chat and while not paused, is stored in guild memory with one
   * more history entry. Never rejects.
   * @param {{ guildId: string, channelId: string, history: object[], selfName: string, privateChat?: boolean }} input
   * @returns {Promise<{ shape: string, examples: string[], count: number }[]|null>}
   */
  async function forTurn({ guildId, channelId, history, selfName, privateChat = false }) {
    try {
      const config = hot.config;
      if (!varietyOn(config)) return null;
      const prompt = hot.prompts?.variety;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        if (!warnedNoPrompt) log.warn('variety: skipped', { reason: 'no-prompt' });
        warnedNoPrompt = true;
        return null;
      }
      warnedNoPrompt = false;
      const settings = varietySettings(config);
      const startedAt = now();
      // A limit notice is the bot's, not the persona's speech: never a line of its own.
      const labels = hot.prompts?.labels;
      const lines = selectOwnLines({
        history: (Array.isArray(history) ? history : []).filter((m) => !(m?.self && isLimitNotice(labels, m.content))),
        ring: store.getGuild(guildId)?.ownLines,
        channelId,
        now: startedAt,
        window: settings.window,
        recentMinutes: settings.recentMinutes,
      });
      if (lines.length < settings.minLines) {
        log.info('variety: skipped', { channel: channelId, reason: 'few-lines', lines: lines.length, minLines: settings.minLines });
        return null;
      }

      const key = linesKey(lines);
      const previous = latest(guildId);
      if (previous?.key === key) {
        log.info('variety: turn', { channel: channelId, lines: lines.length, cached: true, kept: previous.patterns.length });
        return previous.patterns;
      }

      const request = buildVarietyRequest({ prompt, selfName, lines, config });
      let completion;
      try {
        completion = await ask(request, config, settings);
      } catch (err) {
        log.warn('variety: pass failed', {
          channel: channelId,
          lines: lines.length,
          reason: err?.timedOut ? 'timeout' : 'error',
          status: err?.statusCode ?? null,
          name: err?.name ?? null,
        });
        return null;
      }
      const parsed = parseVariety(completion?.text, request.texts, hot.config);
      if (!parsed.ok) {
        log.warn('variety: turn', { channel: channelId, lines: lines.length, cached: false, parse: 'error' });
        return null;
      }
      cache.set(guildId, { key, patterns: parsed.patterns });
      const stored = !privateChat && !store.state?.data?.paused;
      if (stored) {
        const at = now();
        store.setWorn(guildId, { at, key, channelId, lines: lines.length, patterns: parsed.patterns });
        store.appendWornHistory(guildId, { at, channelId, lines: lines.length, patterns: parsed.patterns }, settings.history);
      }
      log.info('variety: turn', {
        channel: channelId,
        lines: lines.length,
        cached: false,
        parse: 'ok',
        kept: parsed.patterns.length,
        dropped: parsed.dropped,
        stored,
      });
      return parsed.patterns;
    } catch (err) {
      log.warn('variety: failed', { channel: channelId ?? null, error: err });
      return null;
    }
  }

  return { record, forTurn };
}
