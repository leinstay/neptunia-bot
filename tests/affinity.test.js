// Tests for src/memory/affinity.js: pure attitude scoring for
// features.relationships (.claude/docs/prompt-contract.md, "Relationships").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyAffinity, affinityBand, applyDelta, ignoreAdjustment } from '../src/memory/affinity.js';

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
  assert.deepEqual(result.history[0], { ts: new Date(OPTS.now).toISOString(), delta: 5, score: 5, reason: 'was nice' });
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
