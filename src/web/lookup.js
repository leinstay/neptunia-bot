// The web lookup (features.webLookup, OFF unless set -- it costs money and the
// search needs a key): the persona reads a link posted in the chat, and, when
// asked something that needs facts from outside, runs one web search. Two
// halves, both modelled on the video describer (src/memory/describe.js):
//
// - readLink: a normal page link (never a video-site link -- the video
//   describer owns those -- never an embed classified as anything but a link
//   (a gif), never a `web.links.skipSites` host, never a URL whose path ends
//   with a picture/video/audio/archive/pdf extension) is fetched through the
//   SSRF-guarded page fetcher
//   (src/web/fetch-page.js) and condensed by the text classifier model through
//   prompts/read-link.md into one excerpt of at most `web.links.summaryChars`.
// - search: one Brave Search request (src/web/brave.js) whose numbered
//   results are condensed through prompts/search-summary.md, sources kept.
//
// Both share the media cache (data/guilds/<id>/media.json, LRU-trimmed to
// `media.cacheEntries`): `read:<link id>` holds an excerpt `{ text, ts }` or a
// miss `{ miss, ts, reason }` skipped for 6 hours; `search:<sha1 prefix of the
// normalised query>` holds `{ query, text, sources, ts }`, served while younger
// than `web.search.cacheHours`. Both share one daily counter
// (`state.data.webDay` / `webCount`, `web.maxPerDay`), reserved before the
// fetch or the search request and kept when either fails. Every model call
// goes through llm.complete (its token cap and daily request cap apply).
// Logs carry reason codes, counts and `host/path` -- never page text, an
// excerpt, a query or the key.

import { createHash } from 'node:crypto';
import { videoSiteFor, safeLocation } from '../discord/video-sites.js';
import { classifierTextModel } from '../behavior/mention.js';
import { TokenLimitError, DailyCapError } from '../llm/openrouter.js';
import { clampText } from '../memory/clamp.js';
import { log } from '../log.js';

const READ_MISS_TTL_MS = 6 * 60 * 60_000;
// An answer this short is the read-link prompt's "no real content" signal.
const UNREADABLE_MAX_WORDS = 4;
// Only when a web.* number is missing (config.json always has them).
const LINK_SUMMARY_CHARS_FALLBACK = 700;
const SEARCH_SUMMARY_CHARS_FALLBACK = 900;
const SEARCH_CACHE_HOURS_FALLBACK = 24;
const QUERY_MAX_CHARS = 200;
// Tab, line feed, vertical tab, form feed, carriage return, NEL, line and paragraph separators.
const QUERY_LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const QUERY_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// A link to a file, not a page: the reader would only spend an attempt on it.
const BINARY_PATH = /\.(?:png|jpe?g|gif|webp|avif|svg|mp4|webm|mov|mkv|mp3|ogg|wav|zip|rar|7z|pdf)$/i;

/**
 * Whether the web lookup is on. Unlike the other `features.*` switches a
 * missing key counts as OFF: it costs money and needs a key.
 */
function webOn(config) {
  return config?.features?.webLookup === true;
}

/** A positive number from the config, else `fallback`. */
function positiveOr(value, fallback) {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Fill `{{key}}` placeholders of a prompt file; an unknown key is left as it is. */
function fillTemplate(template, values) {
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (all, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : all,
  );
}

/** Collapse whitespace, then cap at `maxChars` on a clean boundary. */
function cleanText(raw, maxChars) {
  const collapsed = String(raw ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  return clampText(collapsed, maxChars, { tolerance: 1 });
}

/** Hostname without a leading `www.`, or '' for an unparsable URL. */
function siteOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** Whether `url`'s path (query and fragment aside) ends with a file extension the reader skips. */
function isBinaryPath(url) {
  try {
    return BINARY_PATH.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
}

/** Move `key` to the end of `cache` (most-recently-used), inserting it if new. */
function touchKey(cache, key, value) {
  delete cache[key];
  cache[key] = value;
}

/** Drop the oldest entries once `cache` holds more than `maxEntries`. */
function trimCache(cache, maxEntries) {
  const keys = Object.keys(cache);
  const overflow = keys.length - Math.max(0, maxEntries);
  for (let i = 0; i < overflow; i += 1) delete cache[keys[i]];
}

/** A stand-in for the persistent state when none is wired (tests, tools). */
function memoryState() {
  return { data: {}, markDirty() {} };
}

/**
 * A query as the search cache sees it: lower-cased, whitespace-collapsed, trimmed.
 * @param {string} query
 * @returns {string}
 */
export function normaliseQuery(query) {
  return String(query ?? '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A search query made safe to fill into the search-summary prompt (and to
 * render in the `<lookup>` header): one line (line breaks and tabs become a
 * space), no `<` or `>`, no control characters, trimmed, at most 200
 * UTF-16 units without splitting a surrogate pair. Inner spaces are kept.
 * @param {string} query
 * @returns {string}
 */
export function cleanQuery(query) {
  const flat = String(query ?? '')
    .replace(QUERY_LINE_BREAKS, ' ')
    .replace(QUERY_CONTROLS, '')
    .replace(/[<>]/g, '')
    .trim();
  let out = '';
  for (const point of flat) {
    if (out.length + point.length > QUERY_MAX_CHARS) break;
    out += point;
  }
  return out.trim();
}

/** The cache key of one search. */
function searchKey(query) {
  return `search:${createHash('sha1').update(normaliseQuery(query)).digest('hex').slice(0, 16)}`;
}

/** The numbered result list the search-summary prompt reads (data, not wording). */
function renderResults(results) {
  return results
    .map((result, index) =>
      [`${index + 1}. ${result.title ?? ''}`, result.url ?? '', result.snippet ?? '', result.age ?? '']
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

/**
 * @param {object} deps
 * @param {object} deps.hot     Live config + prompts; read at the moment of use.
 * @param {object} deps.store   getMediaCache / markMediaCacheDirty (src/memory/store.js).
 * @param {object} deps.llm     From createLlm().
 * @param {{ data: object, markDirty: () => void }} [deps.state]  The persistent state holding the
 *   daily web counter; without it the counter lives in memory only.
 * @param {object} deps.pageFetcher  From createPageFetcher() (src/web/fetch-page.js).
 * @param {object} deps.braveSearch  From createBraveSearch() (src/web/brave.js).
 * @param {string|null} [deps.braveApiKey]  BRAVE_SEARCH_API_KEY; never logged.
 * @param {() => number} [deps.now]
 */
export function createLookup({ hot, store, llm, state = memoryState(), pageFetcher, braveSearch, braveApiKey = null, now = Date.now }) {
  // One in-flight read per guild + link: a message prefill and a turn that
  // reach the same new link at once share one request.
  const inFlight = new Map();

  function putEntry(guildId, key, value) {
    const cache = store.getMediaCache(guildId);
    touchKey(cache, key, value);
    trimCache(cache, hot.config.media?.cacheEntries ?? Infinity);
    store.markMediaCacheDirty(guildId);
  }

  /** Reserve one slot of the shared daily web counter; false when `web.maxPerDay` is spent. */
  function reserveDaily() {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (state.data.webDay !== today) {
      state.data.webDay = today;
      state.data.webCount = 0;
    }
    const count = state.data.webCount ?? 0;
    if (count >= (hot.config.web?.maxPerDay ?? Infinity)) {
      state.markDirty();
      return false;
    }
    state.data.webCount = count + 1;
    state.markDirty();
    return true;
  }

  /** Whether `link` may be read under the live config at all (switches, prompt, kind, sites, file path). */
  function readable(link) {
    const config = hot.config;
    if (!webOn(config)) return false;
    const linksCfg = config.web?.links ?? {};
    if (linksCfg.enabled === false) return false;
    if (!hot.prompts?.['read-link']) return false;
    if (!link?.id || !link.url) return false;
    if (link.kind !== undefined && link.kind !== 'link') return false;
    if (videoSiteFor(link.url, linksCfg.skipSites ?? [])) return false;
    if (videoSiteFor(link.url, config.media?.video?.sites ?? [])) return false;
    if (isBinaryPath(link.url)) return false;
    return true;
  }

  /** The cached state of a link: `{ text }` (LRU-touched), `'miss'` (still fresh) or null. */
  function cachedRead(guildId, key) {
    const cache = store.getMediaCache(guildId);
    const entry = cache[key];
    if (!entry) return null;
    if (entry.miss) return now() - entry.ts < READ_MISS_TTL_MS ? 'miss' : null;
    if (typeof entry.text !== 'string') return null;
    touchKey(cache, key, entry);
    store.markMediaCacheDirty(guildId);
    return { text: entry.text };
  }

  /** The uncached part of a read: resolves `{ result, attempted }`. */
  async function fetchAndRead(guildId, link, key) {
    const config = hot.config;
    const linksCfg = config.web?.links ?? {};
    const summaryChars = positiveOr(linksCfg.summaryChars, LINK_SUMMARY_CHARS_FALLBACK);
    const location = safeLocation(link.url);
    const report = (state, reason = null, extra = {}) =>
      log.info('lookup: link', { state, reason, cached: false, location, ...extra });
    const miss = (reason, extra) => {
      putEntry(guildId, key, { miss: true, ts: now(), reason });
      report('miss', reason, extra);
      return { result: null, attempted: true };
    };

    if (!reserveDaily()) {
      report('limit', 'daily');
      return { result: null, attempted: false };
    }

    const page = await pageFetcher.fetchText(link.url, {
      maxBytes: linksCfg.maxBytes,
      timeoutMs: linksCfg.fetchTimeoutMs,
      maxChars: linksCfg.textChars,
    });
    if (!page?.ok) return miss(page?.reason ?? 'network', page?.status !== undefined ? { status: page.status } : {});

    const title = String(page.title || link.title || '').trim();
    const body = String(page.text ?? '').trim();
    if (!body) return miss('empty');

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillTemplate(hot.prompts['read-link'], { maxChars: summaryChars }) },
          { role: 'user', content: title ? `${title}\n\n${body}` : body },
        ],
        {
          model: classifierTextModel(config),
          maxOutputTokens: linksCfg.maxOutputTokens,
          timeoutMs: config.llm?.timeoutMs,
          countAgainstDailyCap: true,
          skipCalibration: true,
        },
      );
    } catch (err) {
      // A safety-rail refusal is cached as a miss like any other (skipped for
      // the same 6 hours), so the page is not re-fetched and re-charged on
      // every turn that sees the link.
      if (err instanceof TokenLimitError) return miss('tokenLimit');
      if (err instanceof DailyCapError) return miss('dailyCap');
      return miss('llm', err?.statusCode !== undefined ? { status: err.statusCode } : {});
    }

    const text = cleanText(completion.text, summaryChars);
    if (!text) return miss('empty');
    if (text.split(' ').length <= UNREADABLE_MAX_WORDS) return miss('unreadable');

    putEntry(guildId, key, { text, ts: now() });
    report('read', null, { chars: text.length });
    return { result: { text }, attempted: true };
  }

  /** readLink plus readLinks' accounting: `attempted` = a fetch was tried (or awaited in flight). */
  async function readLinkCharged(guildId, link, { cacheOnly = false } = {}) {
    if (!readable(link)) return { result: null, attempted: false };
    const key = `read:${link.id}`;
    const cached = cachedRead(guildId, key);
    if (cached === 'miss') return { result: null, attempted: false };
    if (cached) return { result: { ...cached, cached: true }, attempted: false };
    if (cacheOnly) return { result: null, attempted: false };

    const flightKey = `${guildId}:${key}`;
    const running = inFlight.get(flightKey);
    if (running) {
      const { result } = await running;
      return { result, attempted: true };
    }
    const promise = fetchAndRead(guildId, link, key).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
    return promise;
  }

  /**
   * Read one link and condense it into an excerpt, through the shared cache.
   * @param {string} guildId
   * @param {{ id: string, url: string, site?: string, title?: string, kind?: string }} link
   *   A normalized link item (src/discord/media.js#collectReadableLinks).
   * @returns {Promise<{ text: string, cached?: true }|null>}  null when the feature is off, the
   *   link is not readable, a fresh miss is cached, the daily cap is spent or the read failed.
   */
  async function readLink(guildId, link) {
    const { result } = await readLinkCharged(guildId, link);
    return result;
  }

  /**
   * Read up to `maxNew` NEW links of `links`, in the order given. Every fetch
   * ATTEMPT counts toward `maxNew` (a failure included); cache hits and the
   * daily cap are free; past `maxNew` the rest are only looked up in the cache.
   * A link listed twice is read once.
   * @param {string} guildId
   * @param {object[]} links
   * @param {{ maxNew?: number }} [options]
   * @returns {Promise<{ reads: Map<string, string>, newCount: number }>}
   */
  async function readLinks(guildId, links, { maxNew = Infinity } = {}) {
    const reads = new Map();
    const seen = new Set();
    let newCount = 0;
    for (const link of links ?? []) {
      if (!link?.id || seen.has(link.id)) continue;
      seen.add(link.id);
      const { result, attempted } = await readLinkCharged(guildId, link, { cacheOnly: newCount >= maxNew });
      if (attempted) newCount += 1;
      if (result) reads.set(link.id, result.text);
    }
    return { reads, newCount };
  }

  /**
   * One web search on `query`, condensed with its sources, through the shared
   * cache. Needs the feature, `web.search.enabled`, the search-summary prompt,
   * a key and a non-blank query. No results -> an empty `text` (the caller
   * renders labels.lookup.none). A failure is never cached.
   * @param {string} guildId
   * @param {string} query
   * @returns {Promise<{ query: string, text: string, sources: { title: string, url: string, site: string }[],
   *   cached?: true }|null>}
   */
  async function search(guildId, query) {
    const config = hot.config;
    if (!webOn(config)) return null;
    const searchCfg = config.web?.search ?? {};
    if (searchCfg.enabled === false) return null;
    const promptText = hot.prompts?.['search-summary'];
    const asked = cleanQuery(query);
    if (!promptText || !asked) return null;
    if (!hasSearch()) return null;

    const report = (state, reason = null, extra = {}) => log.info('lookup: search', { state, reason, ...extra });
    const cache = store.getMediaCache(guildId);
    const key = searchKey(asked);
    const hit = cache[key];
    if (hit && typeof hit.text === 'string') {
      const maxAgeMs = positiveOr(searchCfg.cacheHours, SEARCH_CACHE_HOURS_FALLBACK) * 60 * 60_000;
      if (now() - hit.ts < maxAgeMs) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(guildId);
        report('found', null, { cached: true, results: hit.sources?.length ?? 0 });
        return { query: hit.query ?? asked, text: hit.text, sources: hit.sources ?? [], cached: true };
      }
      delete cache[key];
      store.markMediaCacheDirty(guildId);
    }

    if (!reserveDaily()) {
      report('limit', 'daily');
      return null;
    }

    const found = await braveSearch.search(asked, { apiKey: braveApiKey, count: searchCfg.results, timeoutMs: searchCfg.timeoutMs });
    let result;
    if (!found?.ok) {
      if (found?.reason !== 'empty') {
        report('error', found?.reason ?? 'network', found?.status !== undefined ? { status: found.status } : {});
        return null;
      }
      result = { query: asked, text: '', sources: [] };
    } else {
      const summaryChars = positiveOr(searchCfg.summaryChars, SEARCH_SUMMARY_CHARS_FALLBACK);
      let completion;
      try {
        completion = await llm.complete(
          [
            { role: 'system', content: fillTemplate(promptText, { query: asked, maxChars: summaryChars }) },
            { role: 'user', content: renderResults(found.results) },
          ],
          {
            model: classifierTextModel(config),
            maxOutputTokens: searchCfg.maxOutputTokens,
            timeoutMs: config.llm?.timeoutMs,
            countAgainstDailyCap: true,
            skipCalibration: true,
          },
        );
      } catch (err) {
        const reason = err instanceof TokenLimitError ? 'tokenLimit' : err instanceof DailyCapError ? 'dailyCap' : 'llm';
        report('error', reason, err?.statusCode !== undefined ? { status: err.statusCode } : {});
        return null;
      }
      const text = cleanText(completion.text, summaryChars);
      if (!text) {
        report('error', 'empty');
        return null;
      }
      const sources = found.results.map((r) => ({ title: r.title ?? '', url: r.url, site: siteOf(r.url) }));
      result = { query: asked, text, sources };
    }

    putEntry(guildId, key, { ...result, ts: now() });
    report(result.text ? 'found' : 'nothing', null, { cached: false, results: result.sources.length });
    return result;
  }

  /** Whether a search key is configured (BRAVE_SEARCH_API_KEY); `/nep ping` reports it. */
  function hasSearch() {
    return typeof braveApiKey === 'string' && braveApiKey.trim().length > 0;
  }

  return { readLink, readLinks, search, hasSearch };
}
