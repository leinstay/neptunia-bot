// Pure logic for `features.relationships`: how much the persona likes or
// dislikes one member, on a -100 (can't stand them) .. 100 (adores them)
// scale, 0 = neutral. The memory-update analyzer is the only writer of a
// `delta`; this module clamps it, folds it into the stored score and keeps a
// short history of what moved it. Also used by `decideMention` to make the
// persona a little quicker to ignore someone it dislikes, a little slower to
// ignore someone it likes. See docs/prompt-contract.md, "The analyzer".

import { clampText } from './clamp.js';
import { DAY_MS } from '../time.js';

/** A member's attitude before anything has been observed about them. A stored affinity may also
 * carry `decayedAt` (ISO string, see `decayAffinity`); every function here keeps it. */
export function emptyAffinity() {
  return { score: 0, reason: '', history: [] };
}

/**
 * Which named band a score falls into. Thresholds are fixed in code (the
 * band NAMES are the writer's wording, via labels.affinity.bands.*):
 * <=-60 hostile · <=-25 dislike · <=-8 cool · <8 neutral · <25 warm · <60 fond · >=60 devoted.
 * @param {number} score
 * @returns {'hostile'|'dislike'|'cool'|'neutral'|'warm'|'fond'|'devoted'}
 */
export function affinityBand(score) {
  if (score <= -60) return 'hostile';
  if (score <= -25) return 'dislike';
  if (score <= -8) return 'cool';
  if (score < 8) return 'neutral';
  if (score < 25) return 'warm';
  if (score < 60) return 'fond';
  return 'devoted';
}

function normalizeAffinity(affinity) {
  const score = Number.isFinite(affinity?.score) ? affinity.score : 0;
  const reason = typeof affinity?.reason === 'string' ? affinity.reason : '';
  const history = Array.isArray(affinity?.history) ? affinity.history : [];
  return { score, reason, history };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to 2 decimal places -- the score's stored precision, see `applyDelta`. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

function sign(value) {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/**
 * `relationships.damping`: a delta is scaled by `(1 - |score| / 100) ** dampingPower` when it
 * pushes the score further from zero, applied in full otherwise. "Further from zero" is decided
 * by the sign of the score BEFORE this delta -- so a delta that starts at 0, moves toward 0, or
 * crosses 0 is never damped, only one that pushes an already one-sided score further the same
 * way. `dampingPower` (`relationships.dampingPower`) steepens (>1) or flattens (<1) the curve;
 * not a positive finite number falls back to `1`, the plain `(1 - |score| / 100)` curve.
 */
function dampedDelta(scoreBeforeDelta, delta, dampingPower) {
  if (delta === 0) return 0;
  const scoreSign = sign(scoreBeforeDelta);
  const movingAway = scoreSign !== 0 && scoreSign === sign(delta);
  if (!movingAway) return delta;
  const power = Number.isFinite(dampingPower) && dampingPower > 0 ? dampingPower : 1;
  return delta * (1 - Math.abs(scoreBeforeDelta) / 100) ** power;
}

/**
 * The stored score rounded to a whole number, for anything shown to the model or the owner --
 * the prompt's `{score}` label, `memory show`, `memory affinity`, the analyzer's view of
 * `<existing_profiles>`. `affinityBand` and `ignoreAdjustment` use the precise (unrounded) score
 * instead, so small movements keep telling members apart even once the integer display stalls.
 * @param {number} score
 * @returns {number}
 */
export function roundScore(score) {
  return Number.isFinite(score) ? Math.round(score) : 0;
}

/**
 * Fold one analyzer-provided delta into a stored affinity. Never throws, even
 * when `affinity` is undefined/malformed (a profile written before this
 * feature existed).
 *
 * @param {object} affinity           Current `{ score, reason, history }`, or malformed/undefined.
 * @param {number} delta              Raw delta from the model; coerced to an integer (unless `opts.truncate` is false).
 * @param {string} reason             One-line reason for this change.
 * @param {object} opts
 * @param {number} opts.maxDelta      `delta` is clamped to +-this BEFORE damping, and before it is applied.
 * @param {number} opts.historySize   History is trimmed to the last N entries.
 * @param {number} [opts.now]         Epoch ms for the history entry's timestamp.
 * @param {number} [opts.clampTolerance]  How far `reason` (free text) may run over its 200-char
 *   limit before being cut, at a clean boundary -- see src/memory/clamp.js.
 * @param {boolean} [opts.damping=false]  `relationships.damping`. When true, `dampedDelta` above
 *   decides how much of the (already clamped) delta actually lands; when false (or omitted), the
 *   whole clamped delta is applied, same as before this option existed.
 * @param {number} [opts.dampingPower=1]  `relationships.dampingPower`, only used when `damping`
 *   is true: raises the `(1 - |score| / 100)` factor to this power, steepening (>1) or flattening
 *   (<1) the curve. Not a positive finite number falls back to `1`.
 * @param {boolean} [opts.truncate=true]  Whether `delta` is truncated to an integer first -- the
 *   analyzer's contract is an integer delta. The owner's absolute `/nep memory affinity <user>
 *   <score>` needs the exact (possibly fractional, since a damped score itself carries two
 *   decimals) gap applied, so it passes `false`.
 * @returns {{ score: number, reason: string, history: object[] }} A NEW affinity object,
 *   or the (normalized) input unchanged when the score does not actually move.
 */
export function applyDelta(
  affinity,
  delta,
  reason,
  { maxDelta, historySize, now = Date.now(), clampTolerance, damping = false, dampingPower = 1, truncate = true } = {},
) {
  const base = normalizeAffinity(affinity);

  const numeric = Number(delta);
  let rawDelta = Number.isFinite(numeric) ? numeric : 0;
  if (truncate) rawDelta = Math.trunc(rawDelta);
  const cap = Number.isFinite(maxDelta) ? Math.abs(maxDelta) : Infinity;
  const clampedDelta = clamp(rawDelta, -cap, cap);

  const appliedRaw = damping ? dampedDelta(base.score, clampedDelta, dampingPower) : clampedDelta;
  const newScore = round2(clamp(base.score + appliedRaw, -100, 100));
  const appliedDelta = round2(newScore - base.score);
  if (appliedDelta === 0) return affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : base;

  const trimmedReason = typeof reason === 'string' ? clampText(reason, 200, { tolerance: clampTolerance }) : '';
  const finalReason = trimmedReason || base.reason;

  const entry = { ts: new Date(now).toISOString(), delta: clampedDelta, appliedDelta, score: newScore, reason: finalReason };
  const size = Number.isFinite(historySize) && historySize > 0 ? historySize : 0;
  const history = size > 0 ? [...base.history, entry].slice(-size) : [];

  // Any other stored field (`decayedAt`, see `decayAffinity`) rides along untouched.
  const extra = affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : {};
  return { ...extra, score: newScore, reason: finalReason, history };
}

/** Upper bound on the days one `decayAffinity` call applies; the rest waits for the next sweep. */
const MAX_DECAY_DAYS = 3650;

/**
 * `relationships.decayPerDay` / `decayPower`: the daily drift of a score toward zero, stronger the
 * further it is from zero. Per whole day elapsed since `affinity.decayedAt` the score loses
 * `decayPerDay * |score| * (|score| / 100) ** decayPower`, never crossing zero; the result is
 * rounded to 2 decimals (the stored precision, see `applyDelta`). `decayedAt` advances by exactly
 * the whole days applied, so the remainder carries over to the next call. No history entry is
 * written: history stays what the analyzer moved.
 *
 * A missing or malformed `decayedAt` is only stamped with `nowMs` (the first sweep sets the
 * baseline, nothing is applied retroactively). A score of 0 only moves the stamp.
 *
 * @param {object} affinity  Stored `{ score, reason, history, decayedAt? }`, or malformed/undefined.
 * @param {number} nowMs     Epoch milliseconds.
 * @param {{ decayPerDay?: number, decayPower?: number }} [cfg]  `config.relationships`.
 *   `decayPerDay` 0, missing or non-finite = off; `decayPower` not a positive finite number = 1.
 * @returns {{ affinity: object, days: number }}  `affinity` is the SAME object when nothing
 *   changes (off, less than a day elapsed, a stamp in the future); `days` = whole days applied.
 */
export function decayAffinity(affinity, nowMs, cfg = {}) {
  const rate = cfg?.decayPerDay;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(nowMs)) return { affinity, days: 0 };
  const power = Number.isFinite(cfg?.decayPower) && cfg.decayPower > 0 ? cfg.decayPower : 1;
  const extra = affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : {};
  const base = { ...extra, ...normalizeAffinity(affinity) };

  const since = typeof base.decayedAt === 'string' ? Date.parse(base.decayedAt) : NaN;
  if (!Number.isFinite(since)) {
    return { affinity: { ...base, decayedAt: new Date(nowMs).toISOString() }, days: 0 };
  }

  const days = Math.min(MAX_DECAY_DAYS, Math.floor((nowMs - since) / DAY_MS));
  if (days < 1) return { affinity, days: 0 };

  let score = base.score;
  for (let i = 0; i < days && score !== 0; i += 1) {
    const magnitude = Math.min(100, Math.abs(score));
    const loss = rate * magnitude * (magnitude / 100) ** power;
    score = score > 0 ? Math.max(0, score - loss) : Math.min(0, score + loss);
  }

  // `|| 0` turns a rounded -0 into 0.
  return { affinity: { ...base, score: round2(score) || 0, decayedAt: new Date(since + days * DAY_MS).toISOString() }, days };
}

/**
 * Extra chance to ignore a call, driven by how the persona feels about the
 * caller: a disliked person is ignored a bit more (up to `+affinityIgnoreBonus`
 * at score -100), a liked person a bit less (up to `-affinityLikeBonus` at
 * score +100). 0 or a non-finite score changes nothing.
 * @param {number} score
 * @param {{ affinityIgnoreBonus: number, affinityLikeBonus: number }} cfg  config.mention
 */
export function ignoreAdjustment(score, cfg) {
  if (!Number.isFinite(score) || score === 0) return 0;
  const magnitude = Math.min(100, Math.abs(score)) / 100;
  return score < 0 ? cfg.affinityIgnoreBonus * magnitude : -cfg.affinityLikeBonus * magnitude;
}
