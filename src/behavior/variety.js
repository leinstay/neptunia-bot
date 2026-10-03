// Variety: the persona latches onto a turn of phrase that worked and reuses
// it in its next few messages, because it sees its own earlier lines in the
// transcript and continues its own pattern. Regexes cannot tell a device from
// a string, so before a turn a small model pass names the devices worn out in
// the persona's own most recent lines, and the turn's request carries them as
// a `<worn>` block. This module is the pure core of that pass: which of the
// persona's own lines are looked at, the request, the validation of the
// model's answer (the answer is data), the cache key, the block and the
// stored shapes (the current list in guild memory, a short history of
// passes). No I/O: the clock is passed in. The wiring lives in
// src/behavior/variety-pass.js (live turns) and src/mentor/mentor.js (the
// sandbox). Every model-facing word comes from the prompt file
// (`prompts.variety`) and `labels.variety`.

import { createHash } from 'node:crypto';
import { parseJsonObject } from '../llm/parse.js';
import { fillPromptTemplate } from './prompt.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { MINUTE_MS } from '../time.js';

/** Defaults of the `variety` config block (config.json carries the same values). */
export const VARIETY_DEFAULTS = Object.freeze({
  window: 12,
  recentMinutes: 45,
  minLines: 3,
  contextChars: 120,
  maxPatterns: 4,
  shapeChars: 140,
  maxOutputTokens: 500,
  timeoutMs: 8000,
  history: 20,
});

// Fixed by the prompt contract, not by config: an example is a short verbatim
// piece, at most three per pattern; a shape shorter than this names nothing.
const EXAMPLE_CHARS = 80;
const MAX_EXAMPLES = 3;
const MIN_SHAPE_CHARS = 3;
// What one stored own line keeps of the message it answered; `contextChars` cuts it again when sent.
const STORED_CONTEXT_CHARS = 1000;
// The ring of own lines keeps this many windows, so another channel's lines survive a busy one.
const RING_WINDOWS = 3;

/** A non-negative integer from `value`, else `fallback`; `min` is the smallest accepted. */
function intAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/**
 * The `variety` settings read from the live config, each falling back to its
 * default when missing or unusable.
 * @param {object} config  The live config.
 * @returns {{ window: number, recentMinutes: number, minLines: number, contextChars: number,
 *   maxPatterns: number, shapeChars: number, maxOutputTokens: number, timeoutMs: number, history: number }}
 */
export function varietySettings(config) {
  const v = config?.variety ?? {};
  const d = VARIETY_DEFAULTS;
  return {
    window: intAtLeast(v.window, d.window, 1),
    recentMinutes: Number.isFinite(v.recentMinutes) && v.recentMinutes > 0 ? v.recentMinutes : d.recentMinutes,
    minLines: intAtLeast(v.minLines, d.minLines, 1),
    contextChars: intAtLeast(v.contextChars, d.contextChars, 0),
    maxPatterns: intAtLeast(v.maxPatterns, d.maxPatterns, 0),
    shapeChars: intAtLeast(v.shapeChars, d.shapeChars, MIN_SHAPE_CHARS),
    maxOutputTokens: intAtLeast(v.maxOutputTokens, d.maxOutputTokens, 1),
    timeoutMs: intAtLeast(v.timeoutMs, d.timeoutMs, 1),
    history: intAtLeast(v.history, d.history, 0),
  };
}

/** `features.variety` (a missing key counts as on). */
export function varietyOn(config) {
  return config?.features?.variety !== false;
}

/** A finite number, else null. */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

// ---- the persona's own lines ------------------------------------------------

/**
 * One stored own line made safe to read: `{ id, ts, channelId, text, to? }`,
 * or null when it has no text or no time.
 * @param {unknown} value
 * @returns {{ id: string|null, ts: number, channelId: string|null, text: string, to?: string }|null}
 */
function normalizeOwnLine(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (!text || !Number.isFinite(value.ts)) return null;
  const line = {
    id: value.id === undefined || value.id === null ? null : String(value.id),
    ts: value.ts,
    channelId: value.channelId === undefined || value.channelId === null ? null : String(value.channelId),
    text,
  };
  if (typeof value.to === 'string' && value.to.trim()) line.to = clampChars(value.to.trim(), STORED_CONTEXT_CHARS);
  return line;
}

/**
 * A stored ring of the persona's own lines (guild memory `ownLines`) made safe
 * to read: every entry normalised, the broken ones dropped, order kept.
 * @param {unknown} value
 * @returns {object[]}
 */
export function normalizeOwnLines(value) {
  return (Array.isArray(value) ? value : []).map(normalizeOwnLine).filter(Boolean);
}

/**
 * The ring after one more own line: appended, the oldest dropped past
 * `RING_WINDOWS` windows (`window` from `variety.window`). A line without
 * text or time leaves the ring as it was.
 * @param {unknown} lines  The stored ring.
 * @param {object} line    `{ id, ts, channelId, text, to? }`.
 * @param {number} window  `variety.window`.
 * @returns {object[]}
 */
export function appendOwnLine(lines, line, window) {
  const ring = normalizeOwnLines(lines);
  const entry = normalizeOwnLine(line);
  if (!entry) return ring;
  const cap = Math.max(1, Math.floor(window) || 1) * RING_WINDOWS;
  return [...ring, entry].slice(-cap);
}

/** The persona's own line of a normalized message, with what it replied to (when that is in `history`). */
function lineOfMessage(message, history) {
  const text = typeof message?.content === 'string' ? message.content.trim() : '';
  if (!text) return null;
  const target = message.replyToId ? history.find((m) => m?.id === message.replyToId) : null;
  const to = typeof target?.content === 'string' ? target.content.trim() : '';
  return {
    id: message.id === undefined || message.id === null ? null : String(message.id),
    ts: message.ts,
    channelId: message.channelId === undefined || message.channelId === null ? null : String(message.channelId),
    text,
    ...(to ? { to } : {}),
  };
}

/**
 * The persona's own lines a pass looks at, oldest first: up to `window` of
 * them, taken first from the channel of the turn (its `history`, newest
 * first), then from the other channels (`ring`, the stored own lines of the
 * guild, newest first; a line of the turn's channel or one already taken is
 * skipped there). With `recentMinutes` (a live turn) a line older than that
 * is left out; without it (a sandbox situation, whose own timeline is what
 * counts) every line of the history may be taken. A line answers the message
 * it replied to (`to`) when that message is in the history; a ring line
 * carries its own.
 * @param {{ history?: object[], ring?: unknown, channelId?: string|null, now?: number,
 *   window: number, recentMinutes?: number|null }} input
 * @returns {{ id: string|null, ts: number, channelId: string|null, text: string, to?: string }[]}
 */
export function selectOwnLines({ history = [], ring = [], channelId = null, now, window, recentMinutes = null }) {
  const messages = Array.isArray(history) ? history : [];
  const since = Number.isFinite(recentMinutes) && Number.isFinite(now) ? now - recentMinutes * MINUTE_MS : -Infinity;
  const fresh = (line) => Number.isFinite(line?.ts) && line.ts >= since;
  const cap = Math.max(0, Math.floor(window) || 0);
  const taken = [];
  const ids = new Set();
  const take = (line) => {
    if (taken.length >= cap || !line || !fresh(line)) return;
    if (line.id && ids.has(line.id)) return;
    if (line.id) ids.add(line.id);
    taken.push(line);
  };
  for (let i = messages.length - 1; i >= 0 && taken.length < cap; i -= 1) {
    if (messages[i]?.self === true) take(lineOfMessage(messages[i], messages));
  }
  const current = channelId === null || channelId === undefined ? null : String(channelId);
  const others = normalizeOwnLines(ring)
    .filter((line) => current === null || line.channelId !== current)
    .sort((a, b) => b.ts - a.ts);
  for (const line of others) take(line);
  return taken.sort((a, b) => a.ts - b.ts);
}

/**
 * The cache key of a set of lines: the first 16 hex digits of the SHA-1 of
 * their ids in order (a line without an id counts by its time and text).
 * @param {{ id?: string|null, ts?: number, text?: string }[]} lines
 * @returns {string}
 */
export function linesKey(lines) {
  const parts = (Array.isArray(lines) ? lines : []).map((line) => (line?.id ? `id:${line.id}` : `ts:${line?.ts}:${line?.text ?? ''}`));
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

// ---- the request ------------------------------------------------------------

/**
 * The pass request: system = `prompt` (prompts.variety) with `{{name}}`,
 * `{{maxPatterns}}` and `{{shapeChars}}` filled, user = one `<lines>` block, the lines oldest first,
 * numbered `#1..`, each on one line, followed, when it answered something, by
 * ` (to: <that message clipped to variety.contextChars>)` (0 leaves it out).
 * `texts` are the persona's lines exactly as sent (what an example must occur
 * in); `count` how many there are.
 * @param {{ prompt: string, selfName: string, lines: object[], config: object }} input
 * @returns {{ messages: { role: string, content: string }[], texts: string[], count: number }}
 */
export function buildVarietyRequest({ prompt, selfName, lines, config }) {
  const settings = varietySettings(config);
  const list = Array.isArray(lines) ? lines : [];
  const texts = list.map((line) => oneLine(line.text));
  const rows = list.map((line, i) => {
    const to = settings.contextChars > 0 && line.to ? oneLine(clampChars(oneLine(line.to), settings.contextChars)) : '';
    return `#${i + 1} ${texts[i]}${to ? ` (to: ${to})` : ''}`;
  });
  const system = fillPromptTemplate(prompt, { name: selfName ?? '', maxPatterns: settings.maxPatterns, shapeChars: settings.shapeChars });
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `<lines>\n${rows.join('\n')}\n</lines>` },
    ],
    texts,
    count: list.length,
  };
}

// ---- the answer -------------------------------------------------------------

/**
 * One pattern of the answer validated against the lines that were sent, or
 * null: `shape` 3..`shapeChars` characters after trimming (whitespace
 * collapsed), `examples` 1..3 strings, each trimmed and clipped to 80
 * characters and kept only when it occurs in one of `haystacks` (the sent
 * lines, lower-cased; the match ignores case), duplicates dropped, `count` an
 * integer of at least 2 (2 when missing; more than the lines sent is cut to
 * their number).
 */
function validPattern(item, haystacks, settings) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const shape = typeof item.shape === 'string' ? oneLine(item.shape) : '';
  const shapeLength = [...shape].length;
  if (shapeLength < MIN_SHAPE_CHARS || shapeLength > settings.shapeChars) return null;
  let count = 2;
  if (item.count !== undefined && item.count !== null) {
    if (!Number.isInteger(item.count) || item.count < 2) return null;
    count = Math.min(item.count, Math.max(2, haystacks.length));
  }
  const examples = [];
  const seen = new Set();
  for (const raw of Array.isArray(item.examples) ? item.examples : []) {
    if (examples.length >= MAX_EXAMPLES) break;
    if (typeof raw !== 'string') continue;
    const example = clampChars(oneLine(raw), EXAMPLE_CHARS).trim();
    const lower = example.toLowerCase();
    if (!example || seen.has(lower)) continue;
    if (!haystacks.some((text) => text.includes(lower))) continue;
    seen.add(lower);
    examples.push(example);
  }
  if (examples.length === 0) return null;
  return { shape, examples, count };
}

/**
 * The pass's answer, validated (the model's output is data): a JSON object
 * `{ "patterns": [ { "shape", "examples", "count" } ] }` found with
 * src/llm/parse.js#parseJsonObject. At most `variety.maxPatterns` valid
 * patterns are kept, in the model's order; see `validPattern` for each one.
 * `ok` is false when no JSON object with a `patterns` array came back (the
 * caller then keeps what it had); `dropped` counts the items left out.
 * @param {string} raw    The model's answer.
 * @param {string[]} texts  The persona's lines as sent (`buildVarietyRequest().texts`).
 * @param {object} config   The live config.
 * @returns {{ ok: boolean, patterns: { shape: string, examples: string[], count: number }[], dropped: number }}
 */
export function parseVariety(raw, texts, config) {
  let parsed;
  try {
    parsed = parseJsonObject(raw);
  } catch {
    return { ok: false, patterns: [], dropped: 0 };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.patterns)) return { ok: false, patterns: [], dropped: 0 };
  const settings = varietySettings(config);
  const haystacks = (Array.isArray(texts) ? texts : []).map((text) => oneLine(text).toLowerCase());
  const patterns = [];
  for (const item of parsed.patterns) {
    if (patterns.length >= settings.maxPatterns) break;
    const pattern = validPattern(item, haystacks, settings);
    if (pattern) patterns.push(pattern);
  }
  return { ok: true, patterns, dropped: parsed.patterns.length - patterns.length };
}

// ---- storage ----------------------------------------------------------------

/** Stored patterns made safe to read: shape and count as stored, examples strings, broken ones dropped. */
function normalizePatterns(value, { examples = true } = {}) {
  return (Array.isArray(value) ? value : [])
    .filter((p) => p && typeof p === 'object' && typeof p.shape === 'string' && p.shape.trim())
    .map((p) => {
      const out = { shape: p.shape.trim(), count: Number.isInteger(p.count) && p.count >= 2 ? p.count : 2 };
      if (examples) out.examples = (Array.isArray(p.examples) ? p.examples : []).filter((e) => typeof e === 'string' && e.trim());
      return out;
    })
    .filter((p) => !examples || p.examples.length > 0);
}

/**
 * The stored current list (guild memory `worn`) made safe to read:
 * `{ at, key, channelId, lines, patterns }`, or null when nothing usable is stored.
 * @param {unknown} value
 * @returns {{ at: number|null, key: string|null, channelId: string|null, lines: number, patterns: object[] }|null}
 */
export function normalizeWorn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    at: finiteOrNull(value.at),
    key: typeof value.key === 'string' && value.key ? value.key : null,
    channelId: value.channelId === undefined || value.channelId === null ? null : String(value.channelId),
    lines: Number.isInteger(value.lines) && value.lines >= 0 ? value.lines : 0,
    patterns: normalizePatterns(value.patterns),
  };
}

/**
 * The stored history of passes (guild memory `wornHistory`) made safe to
 * read: `{ at, channelId, lines, patterns: [{ shape, count }] }` (shapes only,
 * never examples), oldest first, broken entries dropped.
 * @param {unknown} value
 * @returns {object[]}
 */
export function normalizeWornHistory(value) {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === 'object' && Number.isFinite(entry.at))
    .map((entry) => ({
      at: entry.at,
      channelId: entry.channelId === undefined || entry.channelId === null ? null : String(entry.channelId),
      lines: Number.isInteger(entry.lines) && entry.lines >= 0 ? entry.lines : 0,
      patterns: normalizePatterns(entry.patterns, { examples: false }),
    }));
}

/**
 * The history after one more pass: `{ at, channelId, lines, patterns }` with
 * the patterns reduced to their shapes and counts, appended; the oldest
 * dropped past `max` (`variety.history`; 0 keeps none).
 * @param {unknown} history
 * @param {{ at: number, channelId?: string|null, lines: number, patterns: object[] }} pass
 * @param {number} max
 * @returns {object[]}
 */
export function appendWornHistory(history, pass, max) {
  const list = normalizeWornHistory(history);
  const cap = Math.max(0, Math.floor(max) || 0);
  const entry = normalizeWornHistory([
    { at: pass?.at, channelId: pass?.channelId ?? null, lines: pass?.lines, patterns: (pass?.patterns ?? []).map(({ shape, count }) => ({ shape, count })) },
  ])[0];
  if (cap === 0) return [];
  return (entry ? [...list, entry] : list).slice(-cap);
}

// ---- the block --------------------------------------------------------------

/**
 * The `<worn>` block's body: `labels.variety.intro`, then one line per pattern,
 * `- <shape> ("<example>", "<example>")`, at most `variety.maxPatterns` (read
 * now). '' when there is no pattern, the switch is off, or the labels have
 * no `variety.intro` (an older labels.json renders nothing).
 * @param {{ shape: string, examples: string[] }[]|null|undefined} patterns
 * @param {object} labels
 * @param {object} config  The live config.
 * @returns {string}
 */
export function renderWorn(patterns, labels, config) {
  const intro = labels?.variety?.intro;
  if (!varietyOn(config) || typeof intro !== 'string' || !intro.trim()) return '';
  const list = normalizePatterns(patterns).slice(0, varietySettings(config).maxPatterns);
  if (list.length === 0) return '';
  const lines = list.map((p) => `- ${p.shape} (${p.examples.map((e) => `"${e}"`).join(', ')})`);
  return [intro, ...lines].join('\n');
}

// ---- the owner's view -------------------------------------------------------

/** `12m`, `3h`, `2d` -- an age for a status line; `-` for an unknown one. */
function age(ms) {
  if (!Number.isFinite(ms)) return '-';
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** An epoch time as `YYYY-MM-DD HH:MM` UTC. */
function minuteUtc(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * The one `/nep status` line: the switch, how many patterns the latest pass
 * named and how old it is; counts only.
 * @param {unknown} worn  Guild memory `worn`.
 * @param {object} config
 * @param {number} now
 * @returns {string}
 */
export function varietyStatusLine(worn, config, now) {
  if (!varietyOn(config)) return 'variety: off';
  const current = normalizeWorn(worn);
  if (!current?.at) return 'variety: on · no pass yet';
  return `variety: on · ${current.patterns.length} patterns from ${current.lines} lines · ${age(now - current.at)} old`;
}

/**
 * `/nep variety`: the latest list with its examples, then the history of
 * passes newest first, one line each (time UTC, lines, shapes with counts).
 * Operator-facing English.
 * @param {unknown} worn     Guild memory `worn`.
 * @param {unknown} history  Guild memory `wornHistory`.
 * @param {object} config
 * @param {number} now
 * @returns {string}
 */
export function renderVarietyReport(worn, history, config, now) {
  const lines = [varietyStatusLine(worn, config, now)];
  const current = normalizeWorn(worn);
  if (current?.at) {
    lines.push(`latest (${minuteUtc(current.at)} UTC):`);
    if (current.patterns.length === 0) lines.push('  (nothing named)');
    for (const p of current.patterns) lines.push(`  - ${p.shape} x${p.count}: ${p.examples.map((e) => `"${e}"`).join(', ')}`);
  }
  const passes = normalizeWornHistory(history).reverse();
  lines.push(passes.length ? `history (${passes.length}, newest first):` : 'history: none');
  for (const pass of passes) {
    const shapes = pass.patterns.length ? pass.patterns.map((p) => `${p.shape} x${p.count}`).join('; ') : '(nothing named)';
    lines.push(`  ${minuteUtc(pass.at)} · ${pass.lines} lines · ${shapes}`);
  }
  return lines.join('\n');
}
