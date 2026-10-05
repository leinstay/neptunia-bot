// The recall runner: the server part of a lookup. When the lookup classifier
// names word forms, name forms or a date range (src/behavior/recall.js
// parseLookupAnswer), this module searches the server's own history through
// Discord's search (src/discord/search.js) and has one helper request
// (prompts/recall-summary.md) say what that history answers, optionally
// singling out one stretch the persona gets verbatim. Steps: the people the
// name forms point at (stored profiles, Discord's member search for a Latin
// form), the queries one after another (discord.js's REST client runs the
// requests of one guild's search route strictly one at a time -- a
// SequentialHandler per route bucket and guild in @discordjs/rest -- so
// sending them together would only queue them there), the hits filtered
// (other bots, channels the pull rail refuses for this destination, the
// turn's own chat), clustered, the windows around the clusters fetched
// together (channel routes, queued per channel), captioned from the media
// cache only, then the summary. Rails: `features.recall`, server turns only,
// the daily request cap (`llm.capLeft`), `recall.maxPerDay` runs a day
// (state.json `recallDay`/`recallCount`), and `recall.timeoutMs` for the
// whole run, after which it is abandoned. Inside that budget: no search is
// sent once half of it is gone, a search still out at 60 % is cut (what the
// earlier ones found is kept), and the summary is asked only when at least
// `recall.minSummaryMs` is left. A summary that fails, times out or is
// skipped never costs the result: the verbatim stretch of the first-ranked
// window (recall.js fallbackWindow) is returned without a text.
// Logs carry counts, ids and codes only: never a form, a name or a message.

import { log } from '../log.js';
import { checkPull } from '../discord/pull-fetch.js';
import { fetchAround, searchMembers, searchMessages } from '../discord/search.js';
import { helperRequestOptions, railReason } from '../llm/openrouter.js';
import { oneLine } from '../memory/clamp.js';
import { bumpDaily, countToday } from '../time.js';
import { classifierTextModel } from './mention.js';
import { pullPictures } from './pull.js';
import {
  buildRecallRequest,
  clusterHits,
  cutStretch,
  fallbackWindow,
  mergeWindows,
  parseRecallAnswer,
  recallSettings,
  renderRecallWindows,
  sampleOffsets,
  searchPlan,
} from './recall.js';

/** The state.json fields of the daily recall counter. */
const RECALL_DAILY = Object.freeze({ dayKey: 'recallDay', countKey: 'recallCount' });
/** The share of `recall.timeoutMs` after which no further search is sent. */
const SEARCH_SHARE = 0.5;
/** The share of `recall.timeoutMs` at which a search still out is cut: the windows and the summary need the rest. */
const PREPARE_SHARE = 0.6;
const TIMEOUT = Symbol('timeout');
const DEFAULT_TIMERS = Object.freeze({
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer),
});
// A name form Discord's member search can match: Latin letters (at least one), digits, `.`, `_`, `'`, `-`, spaces.
const LATIN_FORM_RE = /^[\p{Script=Latin}\p{N} ._'-]+$/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/u;

/** Whether the parsed server part asks anything. */
function asksServer(server) {
  if (!server || typeof server !== 'object') return false;
  const some = (list) => Array.isArray(list) && list.length > 0;
  return some(server.forms) || some(server.who) || Number.isFinite(server.from) || Number.isFinite(server.to);
}

/** A raw search hit (src/discord/search.js) as the clustering reads it. */
function hitFrom(raw) {
  return {
    id: raw.id,
    channelId: raw.channel_id,
    ts: Date.parse(raw.timestamp),
    authorId: raw.author?.id ?? null,
    bot: raw.author?.bot === true,
    username: raw.author?.username ?? null,
  };
}

/** A fresh stats record of one run. */
function emptyStats() {
  return { planned: 0, queries: 0, failed: 0, hits: 0, kept: 0, clusters: 0, windows: 0, summary: null, ms: 0 };
}

/** The kind of a failed summary request: `timeout` for a request cut at its limit, else `failed`. */
function summaryFailure(err) {
  return err?.name === 'TimeoutError' ? 'timeout' : 'failed';
}

/**
 * @typedef {object} RecallStretch
 * @property {string} channelId
 * @property {string|null} channelName
 * @property {number} startTs   The time of its first kept line.
 * @property {string} lines     The window rendered without `#n` indices (captions included, matched lines marked),
 *                              cut to `recall.stretchChars` by whole lines from its far ends, never a matched one.
 */

/**
 * The recall runner for the turn (task R2 wires it beside the web search).
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot  Live config + prompts; read at the moment of use.
 * @param {object} deps.store      `state` (`data`, `markDirty`) and `listUserProfiles` (src/memory/store.js).
 * @param {object} deps.llm        From createLlm(): `complete`, `capLeft`.
 * @param {object|null} [deps.describer]  From createDescriber (src/memory/describe.js): only its
 *   `cachedDescriptions` is used, never a fresh caption.
 * @param {() => number} [deps.now]
 * @param {{ set: Function, clear: Function }} [deps.timers]  setTimeout / clearTimeout (tests inject fakes).
 * @returns {{ run: (args: { guild: object, guildId?: string, channel: object, selfId: string, selfName: string,
 *   history?: object[], candidate: { authorName?: string, content?: string }, server: { forms: string[], who: string[],
 *   from: number|null, to: number|null }|null }) => Promise<{ text: string|null, stretch: RecallStretch|null,
 *   people: { id: string, name: string, username: string, count: number, newestTs: number|null }[], stats: object }>,
 *   available: () => boolean }}
 */
export function createRecall({ hot, store, llm, describer = null, now = Date.now, timers = DEFAULT_TIMERS }) {
  /** Whether `llm.maxRequestsPerDay` is spent today: the summary would be refused. */
  function capSpent() {
    return typeof llm?.capLeft === 'function' && llm.capLeft() <= 0;
  }

  /** The summary prompt, or null when it is missing or blank. */
  function summaryPrompt() {
    const prompt = hot.prompts?.['recall-summary'];
    return typeof prompt === 'string' && prompt.trim() ? prompt : null;
  }

  /** Whether `recall.maxPerDay` runs are spent today (read only). */
  function dailySpent(settings) {
    return countToday(store.state.data, RECALL_DAILY, now()) >= settings.maxPerDay;
  }

  /**
   * Whether a run could search now: the switch on, the summary prompt
   * present, the daily request cap and `recall.maxPerDay` not spent. Read
   * only; for a caller deciding whether to ask for the server part at all.
   * @returns {boolean}
   */
  function available() {
    try {
      const settings = recallSettings(hot.config);
      return Boolean(settings) && summaryPrompt() !== null && !capSpent() && !dailySpent(settings);
    } catch {
      return false;
    }
  }

  /**
   * The people the `who` forms point at, at most `maxPeople`: per form, the
   * stored profiles with that name or alias (exact, any case), then -- for a
   * Latin form no profile matched -- Discord's member search (prefix match),
   * other bots left out. A member search is not sent once `searchUntil` is
   * past; `beforeRequest` runs before each one.
   */
  async function findPeople({ guild, guildId, who, maxPeople, selfId, signal, searchUntil, beforeRequest }) {
    const found = new Map();
    if (maxPeople <= 0 || !Array.isArray(who) || who.length === 0) return [];
    let profiles = null;
    for (const form of who) {
      if (found.size >= maxPeople || signal.aborted) break;
      profiles ??= store.listUserProfiles?.(guildId) ?? [];
      let matched = false;
      for (const profile of profiles) {
        if (!profile?.id) continue;
        const names = [...(Array.isArray(profile.names) ? profile.names : []), ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((a) => a?.name)];
        if (!names.some((name) => typeof name === 'string' && oneLine(name).toLowerCase() === form)) continue;
        matched = true;
        if (found.has(profile.id) || found.size >= maxPeople) continue;
        found.set(profile.id, { id: profile.id, name: oneLine(profile.names?.[0]) || form, username: '' });
      }
      if (matched || found.size >= maxPeople || !LATIN_FORM_RE.test(form) || !LATIN_LETTER_RE.test(form) || now() >= searchUntil) continue;
      beforeRequest();
      const members = await searchMembers(guild, form, maxPeople, { signal });
      for (const member of members ?? []) {
        if (member.bot && member.id !== selfId) continue;
        const known = found.get(member.id);
        if (known) {
          known.username ||= member.username ?? '';
          continue;
        }
        if (found.size >= maxPeople) break;
        found.set(member.id, { id: member.id, name: member.nick ?? member.globalName ?? member.username ?? '', username: member.username ?? '' });
      }
    }
    return [...found.values()];
  }

  /** The cached captions of the windows' pictures and custom emoji, or undefined (cache only, never a request). */
  function cachedCaptions(config, guildId, windows) {
    if (config.features?.mediaDescriptions !== true || typeof describer?.cachedDescriptions !== 'function') return undefined;
    const { items, rest, emoji } = pullPictures(windows.flatMap((w) => w.messages), 0);
    const wanted = [...items, ...rest, ...emoji];
    if (wanted.length === 0) return undefined;
    try {
      return describer.cachedDescriptions(guildId, wanted) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The search, the windows and the summary; null once `signal` is aborted
   * (the run was abandoned). The Discord searches carry `searchSignal`
   * (aborted with `signal`, or at the PREPARE_SHARE mark: a search cut there
   * counts as failed and ends the searching). Once the windows are read,
   * `progress.fallback(kind)` gives the answer without a summary.
   */
  async function recallWith({ config, settings, prompt, guild, guildId, channel, selfId, selfName, history, candidate, server, signal, searchSignal, progress, started, stats }) {
    const channelId = channel.id;
    const searchUntil = started + settings.timeoutMs * SEARCH_SHARE;
    let counted = false;
    const beforeRequest = () => {
      if (counted) return;
      counted = true;
      bumpDaily(store.state.data, RECALL_DAILY, now());
      store.state.markDirty();
    };
    const result = (extra = {}) => ({ text: null, stretch: null, people: [], stats: { ...stats, ms: now() - started }, ...extra });

    // 1. People.
    const people = await findPeople({ guild, guildId, who: server.who ?? [], maxPeople: settings.maxPeople, selfId, signal: searchSignal, searchUntil, beforeRequest });
    if (signal.aborted) return null;

    // 2. The queries: never past the oldest line of the turn's own chat.
    const own = (Array.isArray(history) ? history : []).filter((m) => m?.id);
    const ownIds = new Set(own.map((m) => m.id));
    const oldest = own.reduce((min, m) => (Number.isFinite(m.ts) && m.ts < min ? m.ts : min), Infinity);
    const plan = searchPlan({
      forms: server.forms ?? [],
      who: server.who ?? [],
      memberIds: people.map((p) => p.id),
      from: server.from ?? null,
      to: server.to ?? null,
      maxForms: settings.maxForms,
      before: Number.isFinite(oldest) ? oldest : null,
    });
    const peopleOut = () => people.map((p) => ({ count: 0, newestTs: null, ...p }));
    if (plan.length === 0) {
      log.info('recall: skipped', { channel: channelId, reason: Number.isFinite(server.from) ? 'visible' : 'no-query' });
      return result({ people: peopleOut() });
    }

    // 3. One query after another, newest first; a range alone is sampled across its total.
    const hits = new Map();
    const queue = [...plan];
    stats.planned = plan.length;
    while (queue.length > 0) {
      if (signal.aborted) return null;
      if (searchSignal.aborted || (stats.queries > 0 && now() >= searchUntil)) break;
      const query = queue.shift();
      beforeRequest();
      const page = await searchMessages(guild, query, { signal: searchSignal });
      stats.queries += 1;
      if (signal.aborted) return null;
      if (!page) {
        stats.failed += 1;
        continue;
      }
      for (const raw of page.hits) if (!hits.has(raw.id)) hits.set(raw.id, hitFrom(raw));
      if (query.kind === 'range' && !query.offset) {
        const more = sampleOffsets(page.total, settings.dateSamples)
          .filter((offset) => offset > 0)
          .map((offset) => ({ ...query, offset }));
        queue.push(...more);
        stats.planned += more.length;
      }
    }
    stats.hits = hits.size;

    // 4. Dropped: other bots, the turn's own chat, channels the pull rail refuses here (judged once each).
    const judged = new Map();
    const sourceOf = (id) => {
      if (!judged.has(id)) {
        let source = null;
        try {
          const verdict = checkPull({ guild, channelId: id, destination: channel, config, now: now() });
          source = verdict.skip === null ? verdict.channel : null;
        } catch {
          source = null;
        }
        judged.set(id, source);
      }
      return judged.get(id);
    };
    const kept = [...hits.values()].filter(
      (hit) => Number.isFinite(hit.ts) && !(hit.bot && hit.authorId !== selfId) && !ownIds.has(hit.id) && sourceOf(hit.channelId) !== null,
    );
    stats.kept = kept.length;
    for (const person of people) {
      const theirs = kept.filter((hit) => hit.authorId === person.id);
      person.count = theirs.length;
      person.newestTs = theirs.length > 0 ? Math.max(...theirs.map((hit) => hit.ts)) : null;
      person.username ||= theirs.find((hit) => hit.username)?.username ?? '';
    }

    // 5. Clusters, 6. a window around each (other bots and the turn's own chat left out).
    const clusters = clusterHits(kept, { gapMinutes: settings.clusterGapMinutes, maxClusters: settings.maxClusters });
    stats.clusters = clusters.length;
    const normalizeOptions = { selfId, embedTextChars: config.media?.embedTextChars, videoSites: config.media?.video?.sites };
    const fetched = await Promise.all(
      clusters.map(async (cluster) => {
        const source = judged.get(cluster.channelId);
        const messages = await fetchAround(source, cluster.middleId, settings.windowMessages, normalizeOptions);
        if (!messages) return null;
        return {
          channelId: cluster.channelId,
          channelName: source.name ?? null,
          messages: messages.filter((m) => !m.bot && !ownIds.has(m.id)),
          hitIds: cluster.ids,
        };
      }),
    );
    if (signal.aborted) return null;
    const windows = mergeWindows(fetched.filter(Boolean));
    stats.windows = windows.length;
    const descriptions = cachedCaptions(config, guildId, windows);
    for (const window of windows) window.descriptions = descriptions;
    log.info('recall: searched', {
      channel: channelId,
      planned: stats.planned,
      queries: stats.queries,
      failed: stats.failed,
      hits: stats.hits,
      kept: stats.kept,
      clusters: stats.clusters,
      windows: stats.windows,
      people: people.length,
      ms: now() - started,
    });

    // 7. The summary.
    const render = {
      labels: hot.prompts.labels,
      timezone: config.bot?.timezone,
      selfName,
      gapMinutes: config.context?.gapMarkerMinutes,
      maxChars: config.context?.maxMessageChars ?? 800,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context?.reactionsPerMessage,
    };
    /** One window as a stretch (no indices, cut to `recall.stretchChars`), or null. */
    const stretchOf = (window) => {
      if (!window || settings.stretchChars <= 0) return null;
      const [shown] = renderRecallWindows([window], { ...render, indexed: false });
      const lines = cutStretch(shown?.lines ?? [], settings.stretchChars);
      if (lines.length === 0) return null;
      return { channelId: window.channelId, channelName: window.channelName, startTs: lines[0].ts, lines: lines.map((line) => line.text).join('\n') };
    };
    const messages =
      windows.length > 0
        ? buildRecallRequest({ prompt, selfName, question: candidate ?? {}, people, windows, answerChars: settings.answerChars, now: now(), ...render })
        : null;
    if (!messages) {
      log.info('recall: skipped', { channel: channelId, reason: 'no-hits' });
      return result({ people: peopleOut() });
    }
    // Without a summary the search still answers: the first-ranked window verbatim, no text.
    let asked = null;
    const fallback = (kind) => {
      stats.summary = kind;
      const stretch = stretchOf(fallbackWindow(windows));
      log.info('recall: summary', { channel: channelId, ms: asked === null ? 0 : now() - asked, answer: 'fallback', stretch: stretch !== null, summary: kind });
      return result({ stretch, people: peopleOut() });
    };
    progress.fallback = fallback;
    if (started + settings.timeoutMs - now() < settings.minSummaryMs) return fallback('skipped');
    asked = now();
    let completion;
    try {
      completion = await llm.complete(messages, {
        model: classifierTextModel(config),
        ...helperRequestOptions(config, {
          role: 'classifier.text',
          maxOutputTokens: settings.maxOutputTokens,
          purpose: 'recall-summary',
          signal,
          timeoutMs: Math.max(1, started + settings.timeoutMs - asked),
          long: true,
        }),
      });
    } catch (err) {
      if (signal.aborted) return null;
      log.warn('recall: failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null, name: err?.name ?? null });
      return fallback(summaryFailure(err));
    }
    if (signal.aborted) return null;
    stats.summary = 'answered';
    const answer = parseRecallAnswer(completion?.text, { answerChars: settings.answerChars, count: windows.length });
    const stretch = answer.stretch !== null ? stretchOf(windows[answer.stretch - 1]) : null;
    log.info('recall: summary', { channel: channelId, ms: now() - asked, answer: answer.text ? 'text' : 'nothing', stretch: stretch !== null });
    return result({ text: answer.text, stretch, people: peopleOut() });
  }

  /**
   * One server search for a turn. Per call, with `hot.config` / `hot.prompts`
   * read at that moment: nothing (no log) with `features.recall` off; `recall:
   * skipped` with `reason` `private-chat` (a channel without a guild),
   * `no-query` (no form, name form or range), `no-prompt` (no
   * `prompts['recall-summary']`), `daily-cap` (`llm.capLeft()` spent) or
   * `daily` (`recall.maxPerDay` runs today), each before any request; later
   * `visible` (the range lies inside the turn's own chat) or `no-hits`
   * (nothing left to read). The first Discord request of a run bumps
   * `recallDay`/`recallCount` once. Never rejects: a failure logs `recall:
   * failed` (`reason`: the rail code of a failed summary request, `timeout`
   * when `recall.timeoutMs` ran out -- the run is abandoned, its requests
   * aborted -- or `error`). Once the windows are read the result is never
   * lost: when the summary request fails, times out (its own limit or the
   * run's) or is skipped (less than `recall.minSummaryMs` left), the run
   * resolves `text` null with `stretch` the first-ranked window
   * (fallbackWindow), `stats.summary` `failed` | `timeout` | `skipped`, and
   * logs `recall: summary` with `answer: 'fallback'`; an answered summary
   * sets `stats.summary` `answered`. Resolves `text` null when nothing was
   * found or the helper answered `nothing`; `stretch` is the window the
   * helper named, else null; `people` the members the name forms found,
   * with how many of their messages were kept and the newest one's time.
   */
  async function run({ guild, guildId = guild?.id ?? null, channel, selfId, selfName, history = [], candidate = null, server = null } = {}) {
    const started = now();
    const channelId = channel?.id ?? null;
    const stats = emptyStats();
    const empty = () => ({ text: null, stretch: null, people: [], stats: { ...stats, ms: now() - started } });
    const skip = (reason) => {
      log.info('recall: skipped', { channel: channelId, reason });
      return empty();
    };
    let controller = null;
    let timer = null;
    let cut = null;
    try {
      const config = hot.config;
      const settings = recallSettings(config);
      if (!settings) return empty();
      if (!channel?.guild || !guild) return skip('private-chat');
      if (!asksServer(server)) return skip('no-query');
      const prompt = summaryPrompt();
      if (!prompt) return skip('no-prompt');
      if (capSpent()) return skip('daily-cap');
      if (dailySpent(settings)) return skip('daily');

      controller = new AbortController();
      const searching = new AbortController();
      controller.signal.addEventListener('abort', () => searching.abort(), { once: true });
      const deadline = new Promise((resolve) => {
        timer = timers.set(() => resolve(TIMEOUT), settings.timeoutMs);
        timer?.unref?.();
      });
      cut = timers.set(() => searching.abort(), Math.floor(settings.timeoutMs * PREPARE_SHARE));
      cut?.unref?.();
      const progress = { fallback: null };
      const work = recallWith({ config, settings, prompt, guild, guildId, channel, selfId, selfName, history, candidate, server, signal: controller.signal, searchSignal: searching.signal, progress, started, stats });
      work.catch(() => {});
      const outcome = await Promise.race([work, deadline]);
      if (outcome === TIMEOUT) {
        controller.abort();
        log.warn('recall: failed', { channel: channelId, reason: 'timeout', status: null, name: null });
        return progress.fallback ? progress.fallback('timeout') : empty();
      }
      return outcome ?? empty();
    } catch (err) {
      controller?.abort();
      log.warn('recall: failed', { channel: channelId, reason: 'error', status: null, name: err?.name ?? null });
      return empty();
    } finally {
      if (timer !== null) timers.clear(timer);
      if (cut !== null) timers.clear(cut);
    }
  }

  return { run, available };
}
