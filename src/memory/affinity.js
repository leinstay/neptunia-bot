// Pure logic for `features.relationships`: how much the persona likes or
// dislikes one member, on a -100 (can't stand them) .. 100 (adores them)
// scale, 0 = neutral. The memory-update analyzer is the only writer of a
// `delta`; this module clamps it, folds it into the stored score and keeps a
// short history of what moved it. Also used by `decideMention` to make the
// persona a little quicker to ignore someone it dislikes, a little slower to
// ignore someone it likes. See .claude/docs/prompt-contract.md, "Relationships".

/** A member's attitude before anything has been observed about them. */
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

/**
 * Fold one analyzer-provided delta into a stored affinity. Never throws, even
 * when `affinity` is undefined/malformed (a profile written before this
 * feature existed).
 *
 * @param {object} affinity           Current `{ score, reason, history }`, or malformed/undefined.
 * @param {number} delta              Raw delta from the model; coerced to an integer.
 * @param {string} reason             One-line reason for this change.
 * @param {object} opts
 * @param {number} opts.maxDelta      `delta` is clamped to +-this before it is applied.
 * @param {number} opts.historySize   History is trimmed to the last N entries.
 * @param {number} [opts.now]         Epoch ms for the history entry's timestamp.
 * @returns {{ score: number, reason: string, history: object[] }} A NEW affinity object,
 *   or the (normalized) input unchanged when the effective delta is zero.
 */
export function applyDelta(affinity, delta, reason, { maxDelta, historySize, now = Date.now() } = {}) {
  const base = normalizeAffinity(affinity);

  const numeric = Number(delta);
  let intDelta = Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  const cap = Number.isFinite(maxDelta) ? Math.abs(maxDelta) : Infinity;
  intDelta = clamp(intDelta, -cap, cap);

  const newScore = clamp(base.score + intDelta, -100, 100);
  const effectiveDelta = newScore - base.score;
  if (effectiveDelta === 0) return affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : base;

  const trimmedReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  const finalReason = trimmedReason || base.reason;

  const entry = { ts: new Date(now).toISOString(), delta: effectiveDelta, score: newScore, reason: finalReason };
  const size = Number.isFinite(historySize) && historySize > 0 ? historySize : 0;
  const history = size > 0 ? [...base.history, entry].slice(-size) : [];

  return { score: newScore, reason: finalReason, history };
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
