// Tests for src/memory/affinity.js: pure attitude scoring for
// features.relationships (.claude/docs/prompt-contract.md, "Relationships").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyAffinity, affinityBand, applyDelta, ignoreAdjustment, roundScore } from '../src/memory/affinity.js';

// --- emptyAffinity -----------------------------------------------------

test('emptyAffinity: score 0, empty reason, empty history', () => {
  assert.deepEqual(emptyAffinity(), { score: 0, reason: '', history: [] });
});

// --- affinityBand: every boundary from the contract ---------------------

const BAND_CASES = [
  [-100, 'hostile'],
  [-60, 'hostile'],
  [-59, 'dislike'],
  [-25, 'dislike'],
  [-24, 'cool'],
  [-8, 'cool'],
  [-7, 'neutral'],
  [0, 'neutral'],
  [7, 'neutral'],
  [8, 'warm'],
  [24, 'warm'],
  [25, 'fond'],
  [59, 'fond'],
  [60, 'devoted'],
  [100, 'devoted'],
];

for (const [score, band] of BAND_CASES) {
  test(`affinityBand: ${score} -> ${band}`, () => {
    assert.equal(affinityBand(score), band);
  });
}

// --- applyDelta ----------------------------------------------------------

const OPTS = { maxDelta: 15, historySize: 10, now: Date.UTC(2026, 0, 1, 12, 0, 0) };

test('applyDelta: a plain positive delta is added to the score', () => {
  const result = applyDelta(emptyAffinity(), 5, 'was nice', OPTS);
  assert.equal(result.score, 5);
  assert.equal(result.reason, 'was nice');
  assert.equal(result.history.length, 1);
  assert.deepEqual(result.history[0], {
    ts: new Date(OPTS.now).toISOString(),
    delta: 5,
    appliedDelta: 5,
    score: 5,
    reason: 'was nice',
  });
});

test('applyDelta: delta is clamped to +-maxDeltaPerUpdate before being applied', () => {
  const result = applyDelta(emptyAffinity(), 999, 'x', OPTS);
  assert.equal(result.score, 15);
  const negative = applyDelta(emptyAffinity(), -999, 'x', OPTS);
  assert.equal(negative.score, -15);
});

test('applyDelta: the resulting score is clamped to [-100, 100]', () => {
  const near = { score: 95, reason: 'r', history: [] };
  const result = applyDelta(near, 15, 'x', OPTS);
  assert.equal(result.score, 100);
});

test('applyDelta: a non-integer delta is truncated', () => {
  const result = applyDelta(emptyAffinity(), 3.9, 'x', OPTS);
  assert.equal(result.score, 3);
});

test('applyDelta: a NaN delta is treated as 0 (no-op)', () => {
  const start = emptyAffinity();
  const result = applyDelta(start, NaN, 'x', OPTS);
  assert.equal(result, start);
});

test('applyDelta: a string delta is coerced numerically', () => {
  const result = applyDelta(emptyAffinity(), '7', 'x', OPTS);
  assert.equal(result.score, 7);
});

test('applyDelta: a non-numeric string delta is treated as 0 (no-op)', () => {
  const start = emptyAffinity();
  const result = applyDelta(start, 'not a number', 'x', OPTS);
  assert.equal(result, start);
});

test('applyDelta: a zero delta is a no-op, returning the input unchanged', () => {
  const start = { score: 10, reason: 'old reason', history: [{ ts: 'x', delta: 10, score: 10, reason: 'old reason' }] };
  const result = applyDelta(start, 0, 'new reason should not apply', OPTS);
  assert.deepEqual(result, start);
});

test('applyDelta: a delta that clamps to zero net change at the score boundary is also a no-op', () => {
  const atCap = { score: 100, reason: 'r', history: [] };
  const result = applyDelta(atCap, 15, 'x', OPTS);
  assert.deepEqual(result, atCap);
});

test('applyDelta: reason within the default tolerance (200*1.25) is kept whole', () => {
  const result = applyDelta(emptyAffinity(), 1, `  ${'x'.repeat(250)}  `, OPTS);
  assert.equal(result.reason.length, 250);
  assert.equal(result.reason, 'x'.repeat(250));
});

test('applyDelta: reason past the tolerance is hard-cut at the tolerance ceiling (a single long word)', () => {
  const result = applyDelta(emptyAffinity(), 1, 'x'.repeat(400), OPTS);
  assert.equal(result.reason.length, 250);
});

test('applyDelta: an empty/whitespace reason keeps the previous reason', () => {
  const start = { score: 5, reason: 'kept reason', history: [] };
  const result = applyDelta(start, 1, '   ', OPTS);
  assert.equal(result.reason, 'kept reason');
});

test('applyDelta: history is trimmed to the last historySize entries', () => {
  let affinity = emptyAffinity();
  for (let i = 0; i < 15; i += 1) {
    affinity = applyDelta(affinity, 1, `step ${i}`, { maxDelta: 15, historySize: 3, now: OPTS.now + i });
  }
  assert.equal(affinity.history.length, 3);
  assert.equal(affinity.history.at(-1).reason, 'step 14');
  assert.equal(affinity.score, 15);
});

test('applyDelta: tolerates a malformed/undefined affinity (a profile written before this feature)', () => {
  assert.equal(applyDelta(undefined, 5, 'x', OPTS).score, 5);
  assert.equal(applyDelta(null, 5, 'x', OPTS).score, 5);
  assert.equal(applyDelta({}, 5, 'x', OPTS).score, 5);
  assert.equal(applyDelta({ score: 'not a number' }, 5, 'x', OPTS).score, 5);
  assert.equal(applyDelta('garbage', 5, 'x', OPTS).score, 5);
});

// --- ignoreAdjustment ------------------------------------------------------

const MENTION_CFG = { affinityIgnoreBonus: 0.3, affinityLikeBonus: 0.08 };

test('ignoreAdjustment: 0 changes nothing', () => {
  assert.equal(ignoreAdjustment(0, MENTION_CFG), 0);
});

test('ignoreAdjustment: a non-finite score changes nothing', () => {
  assert.equal(ignoreAdjustment(NaN, MENTION_CFG), 0);
  assert.equal(ignoreAdjustment(undefined, MENTION_CFG), 0);
});

test('ignoreAdjustment: score -100 adds the full affinityIgnoreBonus', () => {
  assert.equal(ignoreAdjustment(-100, MENTION_CFG), MENTION_CFG.affinityIgnoreBonus);
});

test('ignoreAdjustment: score -50 adds half the affinityIgnoreBonus (linear)', () => {
  assert.equal(ignoreAdjustment(-50, MENTION_CFG), MENTION_CFG.affinityIgnoreBonus * 0.5);
});

test('ignoreAdjustment: score 100 subtracts the full affinityLikeBonus', () => {
  assert.equal(ignoreAdjustment(100, MENTION_CFG), -MENTION_CFG.affinityLikeBonus);
});

test('ignoreAdjustment: score 50 subtracts half the affinityLikeBonus (linear)', () => {
  assert.equal(ignoreAdjustment(50, MENTION_CFG), -MENTION_CFG.affinityLikeBonus * 0.5);
});

// --- applyDelta: relationships.damping --------------------------------------
// F33: undamped growth saturates every active member at +-100 well before a
// server's history runs out. `opts.damping` (config `relationships.damping`,
// default true) scales a delta that pushes the score further from zero by
// `(1 - |score| / 100)`; a delta that moves toward zero, starts at zero, or
// crosses zero is applied in full -- the direction is decided by the score's
// sign BEFORE the delta (the simpler of the two alternatives the task allows).

test('applyDelta: damping off (the default) reproduces the old undamped numbers', () => {
  const near = { score: 60, reason: 'r', history: [] };
  const result = applyDelta(near, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now });
  assert.equal(result.score, 61, 'no damping opt at all behaves exactly like before this feature');

  const explicitlyOff = applyDelta(near, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: false });
  assert.equal(explicitlyOff.score, 61);
});

test('applyDelta: damping on, a delta moving away from zero is scaled by (1 - |score| / 100)', () => {
  const start = { score: 50, reason: 'r', history: [] };
  const result = applyDelta(start, 10, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  // factor = 1 - 50/100 = 0.5 -> applied delta = 5
  assert.equal(result.score, 55);
});

test('applyDelta: damping on, a delta moving toward zero is applied in full', () => {
  const start = { score: 50, reason: 'r', history: [] };
  const result = applyDelta(start, -10, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  assert.equal(result.score, 40);
});

test('applyDelta: damping on, a delta that crosses zero is applied in full (sign decided before the delta)', () => {
  const start = { score: 5, reason: 'r', history: [] };
  const result = applyDelta(start, -20, 'x', { maxDelta: 30, historySize: 10, now: OPTS.now, damping: true });
  assert.equal(result.score, -15, 'moving away from the score before the delta (positive) is not what happened here');
});

test('applyDelta: damping is symmetric for negative scores', () => {
  const positive = applyDelta({ score: 50, reason: 'r', history: [] }, 10, 'x', {
    maxDelta: 15,
    historySize: 10,
    now: OPTS.now,
    damping: true,
  });
  const negative = applyDelta({ score: -50, reason: 'r', history: [] }, -10, 'x', {
    maxDelta: 15,
    historySize: 10,
    now: OPTS.now,
    damping: true,
  });
  assert.equal(positive.score, 55);
  assert.equal(negative.score, -55);
});

test('applyDelta: damping never lets the score exceed +-100, even for a huge delta', () => {
  const near = { score: 99, reason: 'r', history: [] };
  const result = applyDelta(near, 1_000_000, 'x', { maxDelta: Infinity, historySize: 10, now: OPTS.now, damping: true });
  assert.equal(result.score, 100);

  const atCap = { score: 100, reason: 'r', history: [] };
  const noOp = applyDelta(atCap, 1_000_000, 'x', { maxDelta: Infinity, historySize: 10, now: OPTS.now, damping: true });
  assert.deepEqual(noOp, atCap, 'the damping factor is exactly 0 at the cap, so this is a no-op');
});

test('applyDelta: relationships.maxDeltaPerUpdate clamps the model delta BEFORE damping, not after', () => {
  const start = { score: 50, reason: 'r', history: [] };
  const result = applyDelta(start, 999, 'x', { maxDelta: 10, historySize: 10, now: OPTS.now, damping: true });
  // clamp(999, +-10) = 10 first, THEN factor 0.5 -> applied delta = 5 -> score 55.
  // Damping the raw 999 first (factor 0.5 -> 499.5) and clamping to 10 afterwards would give 60.
  assert.equal(result.score, 55);
});

test('applyDelta: tiny steps accumulate instead of rounding to zero forever', () => {
  const start = { score: 60, reason: 'r', history: [] };
  const step1 = applyDelta(start, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  // factor = 1 - 60/100 = 0.4 -> a plain integer round would floor this to 0 and never move again.
  assert.equal(step1.score, 60.4);
  assert.notDeepEqual(step1, start);
});

test('applyDelta: one hundred +1 steps from 50 land where the damping formula says, not at 50 or 150', () => {
  let affinity = { score: 50, reason: 'r', history: [] };
  for (let i = 0; i < 100; i += 1) {
    affinity = applyDelta(affinity, 1, `step ${i}`, { maxDelta: 15, historySize: 1, now: OPTS.now + i, damping: true });
  }
  // Reference: iterating `newScore = round2(clamp(score + 1 * (1 - |score| / 100), -100, 100))`
  // one hundred times from 50 converges to 81.69 -- well short of the 100-step undamped result (100).
  assert.equal(affinity.score, 81.69);
});

test('applyDelta: history keeps the model\'s original (clamped) delta and, separately, the applied delta', () => {
  const start = { score: 50, reason: 'r', history: [] };
  const result = applyDelta(start, 10, 'kind gesture', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  assert.deepEqual(result.history[0], {
    ts: new Date(OPTS.now).toISOString(),
    delta: 10,
    appliedDelta: 5,
    score: 55,
    reason: 'kind gesture',
  });
});

test('applyDelta: damping is read fresh from opts every call, a "hot" toggle takes effect immediately', () => {
  let affinity = { score: 50, reason: 'r', history: [] };
  affinity = applyDelta(affinity, 10, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  assert.equal(affinity.score, 55, 'damped: factor 0.5 on this call');
  affinity = applyDelta(affinity, 10, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: false });
  assert.equal(affinity.score, 65, 'undamped: the next call is unaffected by the previous one\'s setting');
});

test('applyDelta: truncate:false applies an exact (possibly fractional) delta -- the owner\'s absolute set', () => {
  // A score that carries two decimals (from a previous damped update), set to an exact target via
  // `delta = target - current`: truncating that delta first would strand the result off-target.
  const start = { score: 60.4, reason: 'r', history: [] };
  const result = applyDelta(start, 70 - 60.4, 'set by owner', {
    maxDelta: Infinity,
    historySize: 10,
    now: OPTS.now,
    damping: false,
    truncate: false,
  });
  assert.equal(result.score, 70);
});

// --- applyDelta: relationships.dampingPower ---------------------------------
// Tunable curve steepness: the damping factor becomes (1 - |score| / 100) ** dampingPower.
// dampingPower 1 is exactly the plain curve above; missing/garbage falls back to 1 too.

test('applyDelta: dampingPower 1 (the default) matches the plain damping curve', () => {
  const start = { score: 60, reason: 'r', history: [] };
  const withExplicitPower = applyDelta(start, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true, dampingPower: 1 });
  const withoutPower = applyDelta(start, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  assert.equal(withExplicitPower.score, 60.4);
  assert.equal(withoutPower.score, 60.4);
});

test('applyDelta: dampingPower > 1 flattens the curve less near zero, steepens it near the cap', () => {
  const start = { score: 60, reason: 'r', history: [] };
  // factor = (1 - 60/100) ** 2 = 0.16 -> applied delta = 0.16, smaller than power 1's 0.4.
  const result = applyDelta(start, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true, dampingPower: 2 });
  assert.equal(result.score, 60.16);
});

test('applyDelta: dampingPower run of small steps lands where the formula says (power 2, +3 x 100 from 0)', () => {
  let affinity = { score: 0, reason: 'r', history: [] };
  for (let i = 0; i < 100; i += 1) {
    affinity = applyDelta(affinity, 3, `step ${i}`, { maxDelta: 15, historySize: 1, now: OPTS.now + i, damping: true, dampingPower: 2 });
  }
  // Reference: iterating `newScore = round2(clamp(score + 3 * (1 - |score| / 100) ** 2, -100, 100))`
  // one hundred times from 0 converges to 75.27 -- a flatter curve than power 1 would give.
  assert.equal(affinity.score, 75.27);
});

test('applyDelta: dampingPower falls back to 1 for a non-positive, non-finite or garbage value', () => {
  const start = { score: 60, reason: 'r', history: [] };
  const cases = [0, -2, NaN, Infinity, 'not a number', null, undefined];
  for (const dampingPower of cases) {
    const result = applyDelta(start, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true, dampingPower });
    assert.equal(result.score, 60.4, `dampingPower ${dampingPower} should fall back to 1`);
  }
});

test('applyDelta: dampingPower is read fresh from opts every call, a "hot" change takes effect immediately', () => {
  const start = { score: 60, reason: 'r', history: [] };
  const power1 = applyDelta(start, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true, dampingPower: 1 });
  const power2 = applyDelta(start, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true, dampingPower: 2 });
  assert.equal(power1.score, 60.4);
  assert.equal(power2.score, 60.16, 'the same starting affinity, only the opts passed to this call changed');
});

// --- roundScore --------------------------------------------------------------
// Everything shown to the model or the owner (the prompt's {score}, `memory show`,
// `memory affinity`, the analyzer's <existing_profiles>) rounds through this.

test('roundScore: rounds a fractional score to the nearest integer', () => {
  assert.equal(roundScore(60.4), 60);
  assert.equal(roundScore(60.6), 61);
  assert.equal(roundScore(-60.6), -61);
});

test('roundScore: a non-finite score displays as 0', () => {
  assert.equal(roundScore(NaN), 0);
  assert.equal(roundScore(undefined), 0);
});
