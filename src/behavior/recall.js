// The pure core of recall: the server's own history searched beside the web.
// The lookup classifier (prompts/lookup.md) answers `none` or up to four
// labelled lines -- `web:` a web query, `server:` word forms to look for in
// the server's messages, `who:` forms of a person's name, `when:` a date
// range in the bot's time zone -- and the old single unlabelled line still
// reads as a web query. Discord's message search does not stem and matches
// one form per query, so the server part becomes an ordered list of queries
// (content forms round-robin, then authors, or a date range sampled when
// nothing else is given); the hits are grouped into clusters by channel and
// time, a window of messages around each is fetched, and one helper request
// (prompts/recall-summary.md) reads the windows and says what the history
// answers, optionally singling out one stretch the persona then gets
// verbatim. This module holds those decisions with no I/O; the Discord side
// is src/discord/search.js and the runner src/behavior/recall-run.js. No
// wording of ours goes into the request: tags and structural marks only.

import { block, fillPromptTemplate } from './prompt.js';
import { formatTranscript } from '../discord/format.js';
import { clampText, oneLine } from '../memory/clamp.js';
import { DAY_MS, MINUTE_MS, utcDay, zonedDay, zonedEpoch } from '../time.js';

/** Defaults of the `recall` config group (config.json carries the same values). */
export const RECALL_DEFAULTS = Object.freeze({
  maxForms: 5,
  maxPeople: 2,
  dateSamples: 4,
  clusterGapMinutes: 30,
  maxClusters: 5,
  windowMessages: 16,
  answerChars: 1200,
  stretchChars: 1500,
  maxPerDay: 100,
  timeoutMs: 10000,
  minSummaryMs: 2500,
  maxOutputTokens: 500,
});

/** How many of the newest windows the fallback stretch is chosen among (fallbackWindow). */
export const FALLBACK_AMONG = 3;

/** Discord's epoch (2015-01-01T00:00:00Z) in ms: a snowflake counts from it. */
export const DISCORD_EPOCH_MS = 1420070400000;
/** Hits per search request (the API's maximum). */
export const SEARCH_PAGE = 25;
/** The largest `offset` the message search accepts. */
export const MAX_SEARCH_OFFSET = 9975;
/** The structural mark that opens a line the search matched, in `<found>` and in the stretch. */
export const HIT_MARK = '>> ';

/** The most messages one window may ask for (one page of a channel's history). */
const MAX_WINDOW_MESSAGES = 100;
/** A web query is cut to this many characters (as the old single-line answer was). */
const WEB_QUERY_CHARS = 200;
/** A search form: 2..40 characters and at most 3 words. */
const FORM_MIN_CHARS = 2;
const FORM_MAX_CHARS = 40;
const FORM_MAX_WORDS = 3;

// Protocol tokens of the lookup classifier (prompts/lookup.md), not wording.
const NONE_RE = /^none\b/i;
const LABEL_RE = /^(?:[-*•>]\s*)*\**\s*(web|server|who|when)\s*\**\s*:\s*\**\s*(.*)$/i;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/;
const RANGE_SPLIT_RE = /\s*\.{2,}\s*/;
const FORM_SPLIT_RE = /[,;，、]/;
// Protocol tokens of the summary helper (prompts/recall-summary.md).
const STRETCH_RE = /^\**\s*stretch\s*\**\s*:\s*\**\s*(.*)$/i;
const NOTHING_RE = /^nothing$/i;
// Quotes and backticks a model may wrap a line in (straight, curly, guillemets).
const QUOTES = new Set(['"', "'", '`', '“', '”', '‘', '’', '«', '»']);
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '…']);
// The `#n ` index that opens a chat transcript line.
const LINE_INDEX_RE = /^#\d+ (?=\[)/;

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/** A finite `value` of at least `min`, else `fallback`. */
function numberAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * The `recall` settings read from the live config, or null when
 * `features.recall` is false (a missing key counts as on). Each number falls
 * back to RECALL_DEFAULTS when missing or unusable; counts are floored.
 * `maxForms`, `maxPeople`, `maxPerDay`, `stretchChars` and `minSummaryMs`
 * may be 0 (no content query, no member lookup, no recall today, no
 * stretch, the summary asked whatever time is left); `windowMessages` is at
 * most 100.
 * @param {object} config  The live config.
 * @returns {{ maxForms: number, maxPeople: number, dateSamples: number, clusterGapMinutes: number,
 *   maxClusters: number, windowMessages: number, answerChars: number, stretchChars: number, maxPerDay: number,
 *   timeoutMs: number, minSummaryMs: number, maxOutputTokens: number }|null}
 */
export function recallSettings(config) {
  if (config?.features?.recall === false) return null;
  const r = config?.recall ?? {};
  const d = RECALL_DEFAULTS;
  return {
    maxForms: intAtLeast(r.maxForms, d.maxForms, 0),
    maxPeople: intAtLeast(r.maxPeople, d.maxPeople, 0),
    dateSamples: intAtLeast(r.dateSamples, d.dateSamples, 1),
    clusterGapMinutes: numberAtLeast(r.clusterGapMinutes, d.clusterGapMinutes, 0),
    maxClusters: intAtLeast(r.maxClusters, d.maxClusters, 1),
    windowMessages: Math.min(MAX_WINDOW_MESSAGES, intAtLeast(r.windowMessages, d.windowMessages, 1)),
    answerChars: intAtLeast(r.answerChars, d.answerChars, 1),
    stretchChars: intAtLeast(r.stretchChars, d.stretchChars, 0),
    maxPerDay: intAtLeast(r.maxPerDay, d.maxPerDay, 0),
    timeoutMs: intAtLeast(r.timeoutMs, d.timeoutMs, 1),
    minSummaryMs: intAtLeast(r.minSummaryMs, d.minSummaryMs, 0),
    maxOutputTokens: intAtLeast(r.maxOutputTokens, d.maxOutputTokens, 1),
  };
}

/** `line` without surrounding quotes/backticks/whitespace and trailing punctuation (one pass each way). */
function stripLine(line) {
  const points = [...String(line ?? '')];
  let start = 0;
  let end = points.length;
  const isSpace = (c) => c.trim() === '';
  while (start < end && (QUOTES.has(points[start]) || isSpace(points[start]))) start += 1;
  while (end > start && (QUOTES.has(points[end - 1]) || TRAILING_PUNCTUATION.has(points[end - 1]) || isSpace(points[end - 1]))) end -= 1;
  return points.slice(start, end).join('');
}

/** A web query from one answer value: stripped, `none` -> null, cut to WEB_QUERY_CHARS. */
function webQuery(value) {
  const stripped = stripLine(value);
  if (!stripped || NONE_RE.test(stripped)) return null;
  const query = [...stripped].slice(0, WEB_QUERY_CHARS).join('').trim();
  return query || null;
}

/** The forms of one `server:` / `who:` value, cleaned (see parseLookupAnswer), appended to `into` up to `cap`. */
function addForms(into, value, cap) {
  for (const part of String(value ?? '').split(FORM_SPLIT_RE)) {
    if (into.length >= cap) return;
    const form = oneLine(stripLine(part)).toLowerCase();
    const chars = [...form].length;
    if (chars < FORM_MIN_CHARS || chars > FORM_MAX_CHARS) continue;
    if (form.split(' ').length > FORM_MAX_WORDS || NONE_RE.test(form) || into.includes(form)) continue;
    into.push(form);
  }
}

/** One side of a `when:` value: `{ day, hour, minute, timed }` or null when it is not a date. */
function dateSide(text) {
  const match = DATE_RE.exec(text.trim());
  if (!match) return null;
  if (match[2] === undefined) return { day: match[1], hour: 0, minute: 0, timed: false };
  return { day: match[1], hour: Number(match[2]), minute: Number(match[3]), timed: true };
}

/** The start of a side (its minute, or the start of its local day). */
function sideStart(side, timezone) {
  return zonedEpoch(side.day, side.hour, side.minute, timezone);
}

/** The inclusive end of a side (its minute, or the last ms of its local day). */
function sideEnd(side, timezone) {
  if (side.timed) return zonedEpoch(side.day, side.hour, side.minute, timezone);
  const next = utcDay(Date.parse(`${side.day}T00:00:00Z`) + DAY_MS);
  return zonedEpoch(next, 0, 0, timezone) - 1;
}

/**
 * A `when:` value as `{ from, to }` in epoch ms (both inclusive, either may
 * be null for an open side), or null when it is not a usable range.
 */
function parseRange(value, timezone, now) {
  // Quotes go, but not the `..` of an open end: only a lone trailing period does.
  let text = [...String(value ?? '')].filter((c, i, all) => !(QUOTES.has(c) && (i === 0 || i === all.length - 1))).join('').trim();
  if (/[^.]\.$/.test(text)) text = text.slice(0, -1).trim();
  if (!text || NONE_RE.test(text)) return null;
  const sides = text.split(RANGE_SPLIT_RE);
  let from = null;
  let to = null;
  if (sides.length === 1) {
    const side = dateSide(sides[0]);
    if (!side) return null;
    from = sideStart({ ...side, hour: 0, minute: 0 }, timezone);
    to = sideEnd({ ...side, timed: false }, timezone);
  } else if (sides.length === 2) {
    const [left, right] = sides.map((s) => s.trim());
    if (!left && !right) return null;
    const a = left ? dateSide(left) : null;
    const b = right ? dateSide(right) : null;
    if ((left && !a) || (right && !b)) return null;
    from = a ? sideStart(a, timezone) : null;
    to = b ? sideEnd(b, timezone) : null;
  } else {
    return null;
  }
  if ((from !== null && !Number.isFinite(from)) || (to !== null && !Number.isFinite(to))) return null;
  if (from !== null && to !== null && from > to) {
    // Reversed bounds are swapped: the start of the later side's day, the end of the earlier's.
    const [x, y] = sides.map((s) => dateSide(s.trim()));
    from = sideStart(y, timezone);
    to = sideEnd(x, timezone);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  }
  if (Number.isFinite(now)) {
    if (from !== null && from > now) return null;
    if (to !== null && to > now) to = now;
  }
  return { from, to };
}

/**
 * The lookup classifier's answer (prompts/lookup.md). Labelled lines `web:`,
 * `server:`, `who:`, `when:` in any order and any letter case (a leading
 * list bullet or bold marks around the label are tolerated); a line without
 * a label is ignored once any line has one. Without any labelled line the
 * first non-empty line is the old answer: `none` (its first word, any case,
 * quotes stripped) or a web query.
 * - `web`: the first one; quotes and trailing punctuation stripped, a value
 *   starting with `none` is no query, cut to 200 characters.
 * - `server` / `who`: comma-separated forms, each trimmed, wrapping quotes
 *   and trailing punctuation stripped, whitespace collapsed, lower-cased,
 *   kept when 2..40 characters and at most 3 words, de-duplicated in order,
 *   at most `maxForms` per label (a missing or unusable value: RECALL_DEFAULTS.maxForms).
 * - `when`: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` on each side of `..`, in
 *   `timezone`; one date alone means that whole local day; a side may be
 *   left open; reversed bounds are swapped; an end after `now` is clamped
 *   to `now`, a start after it drops the range; anything unparsable gives
 *   no range. The first usable one counts.
 * `server` is an object when there is a form, a name form or a range, else
 * null. `reason`: `empty` (no text), `none` (an explicit none, or labelled
 * lines that all say none or nothing), `unparsed` (labelled lines with
 * content none of which is usable), `ok`.
 * @param {unknown} raw
 * @param {{ timezone?: string, now?: number, maxForms?: number }} [options]
 * @returns {{ web: string|null, server: { forms: string[], who: string[], from: number|null, to: number|null }|null,
 *   reason: 'empty'|'none'|'unparsed'|'ok' }}
 */
export function parseLookupAnswer(raw, { timezone = 'UTC', now, maxForms } = {}) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { web: null, server: null, reason: 'empty' };
  const labelled = lines.map((line) => LABEL_RE.exec(line)).filter(Boolean);
  if (labelled.length === 0) {
    const stripped = stripLine(lines[0]);
    if (NONE_RE.test(stripped)) return { web: null, server: null, reason: 'none' };
    const web = webQuery(lines[0]);
    return web ? { web, server: null, reason: 'ok' } : { web: null, server: null, reason: 'empty' };
  }

  const cap = intAtLeast(maxForms, RECALL_DEFAULTS.maxForms, 1);
  let web = null;
  const forms = [];
  const who = [];
  let range = null;
  let content = false;
  for (const [, label, value] of labelled) {
    const stripped = stripLine(value);
    if (stripped && !NONE_RE.test(stripped)) content = true;
    switch (label.toLowerCase()) {
      case 'web':
        web ??= webQuery(value);
        break;
      case 'server':
        addForms(forms, value, cap);
        break;
      case 'who':
        addForms(who, value, cap);
        break;
      default:
        range ??= parseRange(value, timezone ?? 'UTC', now);
    }
  }
  const server = forms.length > 0 || who.length > 0 || range ? { forms, who, from: range?.from ?? null, to: range?.to ?? null } : null;
  if (web || server) return { web, server, reason: 'ok' };
  return { web: null, server: null, reason: content ? 'unparsed' : 'none' };
}

/**
 * The snowflake of the first possible message at `ms` (worker and sequence
 * bits 0), as a decimal string for `min_id` / `max_id`; '0' before Discord's
 * epoch or for a time that is not finite.
 * @param {number} ms
 * @returns {string}
 */
export function snowflakeAt(ms) {
  if (!Number.isFinite(ms) || ms <= DISCORD_EPOCH_MS) return '0';
  return ((BigInt(Math.floor(ms)) - BigInt(DISCORD_EPOCH_MS)) << 22n).toString();
}

/**
 * The ordered search queries of one server search, newest first each:
 * - content queries: the `forms` and the `who` forms taken round-robin
 *   (form 1, name 1, form 2, name 2, ...), de-duplicated, at most `maxForms`;
 * - one author query per id of `memberIds`;
 * - with none of those and a range: one query over the range alone
 *   (`kind: 'range'`), which the runner samples (sampleOffsets).
 * The range: `minId` from `from`; `maxId` from the earlier of `to`
 * (inclusive) and `before` (exclusive: the oldest line of the turn's own
 * chat, so the ongoing conversation never takes the result slots). An empty
 * list when nothing is asked, or when the range ends before it starts.
 * @param {{ forms?: string[], who?: string[], memberIds?: string[], from?: number|null, to?: number|null,
 *   maxForms?: number, before?: number|null }} params
 * @returns {{ kind: 'content'|'author'|'range', content?: string, authorId?: string, minId: string|null,
 *   maxId: string|null }[]}
 */
export function searchPlan({ forms = [], who = [], memberIds = [], from = null, to = null, maxForms, before = null } = {}) {
  const limit = intAtLeast(maxForms, RECALL_DEFAULTS.maxForms, 0);
  const upper = Math.min(Number.isFinite(to) ? to + 1 : Infinity, Number.isFinite(before) ? before : Infinity);
  const lower = Number.isFinite(from) ? from : null;
  if (lower !== null && upper <= lower) return [];
  const range = { minId: lower !== null ? snowflakeAt(lower) : null, maxId: Number.isFinite(upper) ? snowflakeAt(upper) : null };

  const contents = [];
  const a = Array.isArray(forms) ? forms : [];
  const b = Array.isArray(who) ? who : [];
  for (let i = 0; contents.length < limit && (i < a.length || i < b.length); i += 1) {
    for (const form of [a[i], b[i]]) {
      if (typeof form === 'string' && form && !contents.includes(form) && contents.length < limit) contents.push(form);
    }
  }
  const authors = [...new Set((Array.isArray(memberIds) ? memberIds : []).filter((id) => typeof id === 'string' && id))];
  const plan = [
    ...contents.map((content) => ({ kind: 'content', content, ...range })),
    ...authors.map((authorId) => ({ kind: 'author', authorId, ...range })),
  ];
  if (plan.length === 0 && (Number.isFinite(from) || Number.isFinite(to))) plan.push({ kind: 'range', ...range });
  return plan;
}

/**
 * The offsets at which a date-only range of `total` messages is read:
 * `samples` evenly spaced offsets from 0 (the newest page), floored,
 * de-duplicated, at most MAX_SEARCH_OFFSET; just [0] when one page holds
 * everything.
 * @param {number} total
 * @param {number} samples
 * @returns {number[]}
 */
export function sampleOffsets(total, samples) {
  const count = intAtLeast(samples, RECALL_DEFAULTS.dateSamples, 1);
  if (!Number.isFinite(total) || total <= SEARCH_PAGE) return [0];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const offset = Math.min(MAX_SEARCH_OFFSET, Math.floor((i * total) / count));
    if (!out.includes(offset)) out.push(offset);
  }
  return out;
}

/**
 * Hits grouped into clusters: per channel, hits sorted by time; a hit less
 * than `gapMinutes` after the previous one joins its cluster. A one-hit
 * cluster counts like any other. Each cluster: `{ channelId, ids (oldest
 * first), startTs, endTs, middleId }`, `middleId` the hit at the middle of
 * its list. The newest `maxClusters` by `endTs` are kept, newest first. Hits
 * without an id, a channel or a finite `ts` are ignored; a repeated id counts
 * once.
 * @param {{ id: string, channelId: string, ts: number }[]} hits
 * @param {{ gapMinutes?: number, maxClusters?: number }} [options]
 * @returns {{ channelId: string, ids: string[], startTs: number, endTs: number, middleId: string }[]}
 */
export function clusterHits(hits, { gapMinutes, maxClusters } = {}) {
  const gapMs = numberAtLeast(gapMinutes, RECALL_DEFAULTS.clusterGapMinutes, 0) * MINUTE_MS;
  const keep = intAtLeast(maxClusters, RECALL_DEFAULTS.maxClusters, 1);
  const byChannel = new Map();
  const seen = new Set();
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit?.id || !hit.channelId || !Number.isFinite(hit.ts) || seen.has(hit.id)) continue;
    seen.add(hit.id);
    if (!byChannel.has(hit.channelId)) byChannel.set(hit.channelId, []);
    byChannel.get(hit.channelId).push(hit);
  }
  const clusters = [];
  for (const [channelId, list] of byChannel) {
    list.sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    let current = null;
    for (const hit of list) {
      if (current && hit.ts - current.endTs < gapMs) {
        current.ids.push(hit.id);
        current.endTs = hit.ts;
        continue;
      }
      current = { channelId, ids: [hit.id], startTs: hit.ts, endTs: hit.ts };
      clusters.push(current);
    }
  }
  return clusters
    .sort((x, y) => y.endTs - x.endTs || (x.channelId < y.channelId ? -1 : 1))
    .slice(0, keep)
    .map((cluster) => ({ ...cluster, middleId: cluster.ids[Math.floor(cluster.ids.length / 2)] }));
}

/**
 * Windows of one channel that share a message merged into the first of
 * them (messages united by id, oldest first; hit ids united); the order of
 * first appearance is kept and a window without messages is dropped.
 * @param {{ channelId: string, channelName?: string|null, messages: object[], hitIds: Iterable<string> }[]} windows
 * @returns {{ channelId: string, channelName: string|null, messages: object[], hitIds: Set<string> }[]}
 */
export function mergeWindows(windows) {
  const out = [];
  for (const window of Array.isArray(windows) ? windows : []) {
    const messages = (window?.messages ?? []).filter((m) => m?.id);
    if (messages.length === 0) continue;
    const ids = new Set(messages.map((m) => m.id));
    const into = out.find((w) => w.channelId === window.channelId && w.messages.some((m) => ids.has(m.id)));
    if (!into) {
      out.push({ channelId: window.channelId, channelName: window.channelName ?? null, messages: [...messages], hitIds: new Set(window.hitIds ?? []) });
      continue;
    }
    const known = new Set(into.messages.map((m) => m.id));
    for (const message of messages) if (!known.has(message.id)) into.messages.push(message);
    into.messages.sort((x, y) => x.ts - y.ts);
    for (const id of window.hitIds ?? []) into.hitIds.add(id);
  }
  for (const window of out) window.messages.sort((x, y) => x.ts - y.ts);
  return out;
}

/**
 * The window the verbatim fallback shows when the summary gives no answer
 * (failed, timed out or skipped): among the first `among` windows -- the
 * newest, as the runner keeps them in clusterHits' order -- the one with the
 * most matched lines (its messages whose id is in its `hitIds`), the newer
 * one on a tie. Null when there is no window.
 * @param {{ messages?: object[], hitIds?: Iterable<string> }[]} windows  Newest first.
 * @param {number} [among]  FALLBACK_AMONG when missing or below 1.
 * @returns {object|null}
 */
export function fallbackWindow(windows, among = FALLBACK_AMONG) {
  const list = (Array.isArray(windows) ? windows : []).filter(Boolean).slice(0, intAtLeast(among, FALLBACK_AMONG, 1));
  let best = null;
  let bestCount = -1;
  for (const window of list) {
    const hits = new Set(window.hitIds ?? []);
    const count = (window.messages ?? []).filter((m) => m?.id && hits.has(m.id)).length;
    if (count > bestCount) {
      best = window;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The windows rendered as transcript lines with the transcript helpers of
 * src/discord/format.js (the chat form: gap and date markers, media tags
 * with the `descriptions` captions, reactions; wording from `labels`). A
 * line whose message is in the window's `hitIds` opens with HIT_MARK.
 * `indexed` true keeps the `#n` index of each line, numbered across all
 * windows so a reply marker points inside its own window; false (the
 * stretch handed to the persona, which must not mistake them for chat
 * indices) drops the index and the reply markers with it.
 * @param {{ channelId: string, channelName?: string|null, messages: object[], hitIds?: Iterable<string>,
 *   descriptions?: Map<string, string> }[]} windows
 * @param {{ labels: object, timezone?: string, selfName?: string, gapMinutes?: number, maxChars?: number,
 *   seeReactions?: boolean, reactionsPerMessage?: number, indexed?: boolean }} options
 * @returns {{ channelId: string, channelName: string|null, startTs: number,
 *   lines: { id: string, ts: number, text: string, hit: boolean }[] }[]}
 */
export function renderRecallWindows(windows, { labels, timezone = 'UTC', selfName = '', gapMinutes = 20, maxChars = 800, seeReactions = true, reactionsPerMessage, indexed = true } = {}) {
  const out = [];
  let offset = 0;
  for (const window of Array.isArray(windows) ? windows : []) {
    const messages = (window?.messages ?? []).filter(Boolean);
    if (messages.length === 0) continue;
    const hits = new Set(window.hitIds ?? []);
    const items = formatTranscript(indexed ? messages : messages.map((m) => ({ ...m, replyToId: null })), {
      timezone,
      gapMinutes,
      maxChars,
      selfName,
      labels,
      descriptions: window.descriptions,
      seeReactions,
      reactionsPerMessage,
      indexOffset: offset,
    });
    if (indexed) offset += messages.length;
    const lines = items.map((item) => {
      const parts = item.text.split('\n');
      let last = parts.pop();
      if (!indexed) last = last.replace(LINE_INDEX_RE, '');
      const hit = hits.has(item.id);
      parts.push(hit ? `${HIT_MARK}${last}` : last);
      return { id: item.id, ts: item.ts, text: parts.join('\n'), hit };
    });
    out.push({ channelId: window.channelId, channelName: window.channelName ?? null, startTs: messages[0].ts, lines });
  }
  return out;
}

/** The `<people>` line of one found member: `name | username | count | newest date` (structural fields). */
function personLine(person, timezone) {
  const newest = Number.isFinite(person?.newestTs) ? zonedDay(person.newestTs, timezone) : '';
  const count = Number.isFinite(person?.count) ? person.count : 0;
  return `${oneLine(person?.name)} | ${oneLine(person?.username)} | ${count} | ${newest}`.trimEnd();
}

/**
 * The summary helper's request: the system message is `prompt` with
 * `{{name}}` (the persona's display name), `{{answerChars}}` and, given
 * `now`, `{{today}}` (the local date key in `timezone`) filled; the user
 * message holds `<people>` (one line per found member, see personLine; left
 * out when none), `<found>` (one section per window, numbered from 1 in the
 * order given: a header `## n | YYYY-MM-DD | #channel` with the local date
 * of its first line, then its lines, renderRecallWindows with indices) and
 * `<question>` (the candidate's author and text cut to `maxChars`). Null
 * when the prompt is blank or no window has a line.
 * @param {{ prompt: string|null|undefined, selfName: string, question: { authorName?: string, content?: string },
 *   people?: { name: string, username?: string, count?: number, newestTs?: number|null }[], windows: object[],
 *   labels: object, timezone?: string, answerChars: number, now?: number, maxChars?: number, gapMinutes?: number,
 *   seeReactions?: boolean, reactionsPerMessage?: number }} params
 * @returns {{ role: string, content: string }[]|null}
 */
export function buildRecallRequest({
  prompt,
  selfName,
  question,
  people = [],
  windows,
  labels,
  timezone = 'UTC',
  answerChars,
  now,
  maxChars = 800,
  gapMinutes = 20,
  seeReactions = true,
  reactionsPerMessage,
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  const rendered = renderRecallWindows(windows, { labels, timezone, selfName, gapMinutes, maxChars, seeReactions, reactionsPerMessage, indexed: true });
  if (rendered.length === 0) return null;
  const sections = rendered.map((window, i) =>
    [`## ${i + 1} | ${zonedDay(window.startTs, timezone)} | #${oneLine(window.channelName)}`, ...window.lines.map((line) => line.text)].join('\n'),
  );
  const text = [...String(question?.content ?? '')].slice(0, maxChars).join('');
  const user = [
    block('people', (Array.isArray(people) ? people : []).map((p) => personLine(p, timezone)).join('\n')),
    block('found', sections.join('\n\n')),
    block('question', `${oneLine(question?.authorName)}: ${text}`),
  ]
    .filter(Boolean)
    .join('\n');
  const values = { name: selfName ?? '', answerChars };
  if (Number.isFinite(now)) values.today = zonedDay(now, timezone);
  return [
    { role: 'system', content: fillPromptTemplate(prompt, values) },
    { role: 'user', content: user },
  ];
}

/**
 * The summary helper's answer. A first non-empty line `stretch: <n>` (any
 * case) names the `<found>` section that answers the question: `n` within
 * `1..count` (a `#` before it tolerated) -> `stretch` n, `none` or anything
 * else -> null; that line is not part of the text. The rest, trimmed and
 * clamped with clampText to `answerChars` (soft, the prompt names the
 * limit), is the text; empty or the single word `nothing` (quotes and
 * trailing punctuation aside) gives text null and no stretch.
 * @param {unknown} raw
 * @param {{ answerChars?: number, count?: number }} [options]
 * @returns {{ text: string|null, stretch: number|null }}
 */
export function parseRecallAnswer(raw, { answerChars, count = 0 } = {}) {
  const lines = String(raw ?? '').split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (first === -1) return { text: null, stretch: null };
  let stretch = null;
  let rest = lines.slice(first);
  const named = STRETCH_RE.exec(rest[0].trim());
  if (named) {
    const number = /^#?(\d+)$/.exec(stripLine(named[1]));
    const n = number ? Number(number[1]) : NaN;
    if (Number.isSafeInteger(n) && n >= 1 && n <= count) stretch = n;
    rest = rest.slice(1);
  }
  const body = rest.join('\n').trim();
  if (!body || NOTHING_RE.test(stripLine(body))) return { text: null, stretch: null };
  const text = clampText(body, intAtLeast(answerChars, RECALL_DEFAULTS.answerChars, 1));
  return text ? { text, stretch } : { text: null, stretch: null };
}

/**
 * The lines of a stretch cut to `maxChars` (their texts joined by line
 * breaks, counted in code points) by dropping whole lines from its far ends:
 * each time from the end with more lines outside the matched ones, the
 * older end on a tie. A matched line (`hit`) is never dropped, so the result
 * may stay longer than `maxChars`. A `maxChars` that is not a finite number
 * of at least 0 keeps every line.
 * @param {{ text: string, hit: boolean }[]} lines
 * @param {number} maxChars
 * @returns {{ text: string, hit: boolean }[]}
 */
export function cutStretch(lines, maxChars) {
  const list = Array.isArray(lines) ? [...lines] : [];
  if (!Number.isFinite(maxChars) || maxChars < 0) return list;
  const size = (from, to) => list.slice(from, to).reduce((sum, line, i) => sum + (i > 0 ? 1 : 0) + [...line.text].length, 0);
  let start = 0;
  let end = list.length;
  const firstHit = list.findIndex((line) => line.hit);
  const lastHit = list.findLastIndex((line) => line.hit);
  while (end > start && size(start, end) > maxChars) {
    const before = firstHit === -1 ? end - start : firstHit - start;
    const after = lastHit === -1 ? 0 : end - 1 - lastHit;
    if (before <= 0 && after <= 0) break;
    if (before >= after) start += 1;
    else end -= 1;
  }
  return list.slice(start, end);
}
