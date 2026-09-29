// The mentor's judge: what the mentor model says is data, never trusted as
// is. Its invented situations and its points come back as JSON; this module
// keeps only what has the shape the rest of the run relies on (a situation
// the sandboxes can replay, a score on every axis within 0..10) and applies
// the pass rule to what survives. Pure: text in, values out.

import { parseJsonObject } from '../llm/parse.js';

const MAX_LINE_CHARS = 500;
const MAX_TITLE_CHARS = 200;
const SELF = 'self';
/** The axes of a score, in report order. */
export const AXES = ['human', 'character', 'rules', 'goal', 'overall'];
/** Axes that must carry a number: a score without them says nothing. */
const REQUIRED_AXES = new Set(['goal', 'overall']);

/** The JSON object in a model reply, or null when there is none. */
function jsonOf(raw) {
  try {
    const value = parseJsonObject(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A plain object, or null. */
function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * One line of a situation, cleaned, or null when it is unusable.
 * `n` is its 0-based position (a `replyTo` must point at an earlier line).
 */
function cleanLine(value, n, known) {
  const line = objectOf(value);
  if (!line) return null;
  const authorId = typeof line.authorId === 'number' ? String(line.authorId) : line.authorId;
  if (typeof authorId !== 'string' || (authorId !== SELF && !known.has(authorId))) return null;
  if (typeof line.text !== 'string') return null;
  const text = line.text.trim();
  if (!text || [...text].length > MAX_LINE_CHARS) return null;
  const replyTo = line.replyTo ?? null;
  if (replyTo !== null && !(Number.isInteger(replyTo) && replyTo >= 0 && replyTo < n)) return null;
  const out = { authorId, authorName: typeof line.authorName === 'string' ? line.authorName.trim() : '', text, replyTo };
  if (Number.isFinite(line.minutesBefore) && line.minutesBefore >= 0) out.minutesBefore = line.minutesBefore;
  return out;
}

/** One situation, cleaned, or null when any part of it is unusable. */
function cleanSituation(value, known, min, max) {
  const situation = objectOf(value);
  if (!situation || !Array.isArray(situation.lines)) return null;
  const { lines } = situation;
  if (lines.length < min || lines.length > max) return null;
  const clean = [];
  for (let n = 0; n < lines.length; n += 1) {
    const line = cleanLine(lines[n], n, known);
    if (!line) return null;
    clean.push(line);
  }
  if (clean[clean.length - 1].authorId === SELF) return null;
  const title = typeof situation.title === 'string' ? situation.title.trim().slice(0, MAX_TITLE_CHARS) : '';
  return { title, lines: clean };
}

/**
 * The situations the mentor model invented, validated. A line's `authorId` is
 * 'self' (the persona) or one of `knownIds`; its text is non-empty and at most
 * 500 characters; `replyTo` is null or the index of an earlier line;
 * `minutesBefore` is kept when it is a non-negative number. A situation has
 * `min..max` lines and its last line is not by 'self'. A situation failing any
 * of this is dropped whole and counted; at most `count` valid ones are kept,
 * in the order given. A reply that is not a JSON object with a `situations`
 * array gives `{ situations: [], dropped: 0 }`.
 * @param {string} raw  The mentor model's text.
 * @param {{ knownIds: Iterable<string>, lines: [number, number], count: number }} options
 * @returns {{ situations: { title: string, lines: { authorId: string, authorName: string, text: string,
 *   replyTo: number|null, minutesBefore?: number }[] }[], dropped: number }}
 */
export function parseSituations(raw, { knownIds, lines, count }) {
  const list = jsonOf(raw)?.situations;
  if (!Array.isArray(list)) return { situations: [], dropped: 0 };
  const known = new Set([...(knownIds ?? [])].map(String));
  const [min, max] = Array.isArray(lines) ? lines : [2, Infinity];
  const limit = Math.max(0, Math.floor(Number(count) || 0));
  const situations = [];
  let dropped = 0;
  for (const item of list) {
    const situation = cleanSituation(item, known, min, max);
    if (!situation) {
      dropped += 1;
      continue;
    }
    if (situations.length < limit) situations.push(situation);
  }
  return { situations, dropped };
}

/** A point on one axis: an integer 0..10, null, or undefined when invalid. */
function point(value) {
  if (value === null) return null;
  return Number.isInteger(value) && value >= 0 && value <= 10 ? value : undefined;
}

/** One answer's score, or null when it is unusable. */
function cleanScore(item) {
  const score = {};
  for (const axis of AXES) {
    const value = point(item[axis] === undefined ? null : item[axis]);
    if (value === undefined) return null;
    if (value === null && REQUIRED_AXES.has(axis)) return null;
    score[axis] = value;
  }
  score.comment = typeof item.comment === 'string' ? item.comment.trim() : '';
  return score;
}

/**
 * The mentor model's points for the answers `answerIds`. Each axis is an
 * integer 0..10 or null; `goal` and `overall` must be numbers. An answer whose
 * score breaks this, that is absent, or whose id is unknown, is not taken; the
 * first usable score of an id wins.
 * @param {string} raw  The mentor model's text: `{ answers: [{ id, human, character, rules, goal, overall, comment }] }`.
 * @param {string[]} answerIds  The ids asked for.
 * @returns {{ scores: Map<string, { human: number|null, character: number|null, rules: number|null,
 *   goal: number, overall: number, comment: string }>, missing: string[] }}  `missing` in the order of `answerIds`.
 */
export function parseScores(raw, answerIds) {
  const wanted = new Set(answerIds);
  const scores = new Map();
  const list = jsonOf(raw)?.answers;
  for (const value of Array.isArray(list) ? list : []) {
    const item = objectOf(value);
    const id = typeof item?.id === 'string' ? item.id.trim() : null;
    if (!id || !wanted.has(id) || scores.has(id)) continue;
    const score = cleanScore(item);
    if (score) scores.set(id, score);
  }
  return { scores, missing: answerIds.filter((id) => !scores.has(id)) };
}

/** The median of the numbers in `values` (nulls ignored), or null when there is none. */
function median(values) {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The pass rule over the scored answers: the median of each axis (nulls
 * ignored; an axis with only nulls has a null median and is not checked). The
 * case passes when the median `overall` and the median `goal` are at least
 * `passCfg.score` and no median is under `passCfg.floor`. `reasons` says, in
 * operator English, what failed.
 * @param {{ human: number|null, character: number|null, rules: number|null, goal: number, overall: number }[]} scores
 * @param {{ score: number, floor: number }} passCfg  The `mentor.pass` config section.
 * @returns {{ passed: boolean, medians: { human: number|null, character: number|null, rules: number|null,
 *   goal: number|null, overall: number|null }, reasons: string[] }}
 */
export function verdict(scores, passCfg) {
  const list = (scores ?? []).filter(Boolean);
  const medians = {};
  for (const axis of AXES) medians[axis] = median(list.map((s) => s[axis]));
  // The config.json defaults when a value is missing: a missing number must never pass everything.
  const passScore = Number.isFinite(passCfg?.score) ? passCfg.score : 7;
  const floor = Number.isFinite(passCfg?.floor) ? passCfg.floor : 5;
  const reasons = [];
  if (medians.overall === null || medians.goal === null) {
    reasons.push('no answer was scored');
    return { passed: false, medians, reasons };
  }
  for (const axis of ['overall', 'goal']) {
    if (medians[axis] < passScore) reasons.push(`${axis} ${medians[axis]} is under the pass score ${passScore}`);
  }
  for (const axis of AXES) {
    const value = medians[axis];
    if (value === null || value >= floor) continue;
    // Already reported as under the (higher) pass score.
    if ((axis === 'overall' || axis === 'goal') && value < passScore) continue;
    reasons.push(`${axis} ${value} is under the floor ${floor}`);
  }
  return { passed: reasons.length === 0, medians, reasons };
}
