// The Brave Search API client for web lookup: when the persona is asked
// something that needs facts outside her head, the bot runs ONE search and a
// cheap model condenses the results. This module only sends the request and
// turns the answer into `{ title, url, snippet, age? }` items -- titles and
// snippets come back with `<strong>` highlights and entities, which are
// cleaned with the same readable.js the page reader uses.
//
// Every call resolves to a result object and never rejects. One warn line per
// failure, carrying the reason and an HTTP status only -- never the query
// (it is chat content), never the API key, never the request URL.

import { log } from '../log.js';
import { htmlToText } from './readable.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const LANG_CODE = /^[a-z]{2,3}(-[a-z]{2,4})?$/i;

/** HTML fragment -> one line of plain text. */
function inlineText(value) {
  return htmlToText(typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim();
}

/** Whether `value` is an absolute http(s) URL. */
function isWebUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** `count` as an integer in 1..10, 5 when it is not a number. */
function clampCount(count) {
  const n = Math.floor(Number(count));
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(1, n));
}

/** The cleaned result items of a Brave response payload (entries without an http(s) url dropped). */
function parseResults(payload, count) {
  const raw = Array.isArray(payload?.web?.results) ? payload.web.results : [];
  const results = [];
  for (const entry of raw) {
    if (results.length >= count) break;
    if (!entry || !isWebUrl(entry.url)) continue;
    const item = { title: inlineText(entry.title), url: entry.url, snippet: inlineText(entry.description) };
    if (typeof entry.age === 'string' && entry.age.trim()) item.age = entry.age.trim();
    results.push(item);
  }
  return results;
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createBraveSearch({ fetchImpl = fetch } = {}) {
  /** One warn line (reason, status), then the failure object. */
  function fail(reason, status) {
    const meta = { reason };
    if (status !== undefined) meta.status = status;
    log.warn('brave: search failed', meta);
    return status === undefined ? { ok: false, reason } : { ok: false, reason, status };
  }

  /**
   * One Brave web search. `count` is capped at 10; `lang`, when it looks like
   * a language code (`en`, `el`, `pt-br`), is sent as `search_lang`. An empty
   * key fails with `no-key` and a blank query with `empty`, both without a
   * request. Never rejects.
   * @param {string} query
   * @param {{ apiKey?: string, count?: number, timeoutMs?: number, lang?: string }} [options]
   * @returns {Promise<{ ok: true, results: Array<{ title: string, url: string, snippet: string, age?: string }> }
   *   | { ok: false, reason: 'no-key'|'http'|'timeout'|'network'|'empty', status?: number }>}
   */
  async function search(query, { apiKey, count = DEFAULT_COUNT, timeoutMs, lang } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) return fail('no-key');
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return fail('empty');

    const n = clampCount(count);
    let url = `${ENDPOINT}?q=${encodeURIComponent(q)}&count=${n}`;
    if (typeof lang === 'string' && LANG_CODE.test(lang)) url += `&search_lang=${lang.toLowerCase()}`;

    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, waitMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey.trim(),
        },
        signal: controller.signal,
      });
      if (!response || typeof response !== 'object') return fail('network');
      if (!response.ok) return fail('http', response.status);
      const body = await response.text();
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return fail('http', response.status);
      }
      const results = parseResults(payload, n);
      if (!results.length) return fail('empty');
      return { ok: true, results };
    } catch {
      return fail(timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  return { search };
}
