// Tests for src/llm/tokens.js: token estimation and the usage calibrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateMessages, createCalibrator } from '../src/llm/tokens.js';

test('estimateTokens: Cyrillic costs more tokens than the same length of ASCII', () => {
  const ascii = estimateTokens('a'.repeat(20));
  const cyrillic = estimateTokens('я'.repeat(20));
  assert.ok(cyrillic > ascii, `expected cyrillic (${cyrillic}) > ascii (${ascii})`);
});

test('estimateTokens: empty input costs 0 tokens', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(null), 0);
});

test('estimateTokens: mixed ASCII + Cyrillic charges each char at its own rate', () => {
  // 7 ascii chars -> ceil(7/3.5) = 2; 4 cyrillic chars -> ceil(4/2) = 2; total 4.
  assert.equal(estimateTokens('abcdefg' + 'привет'.slice(0, 4)), 4);
});

test('estimateMessages: string content costs overhead + text tokens', () => {
  const total = estimateMessages([{ role: 'user', content: 'a'.repeat(7) }]);
  // overhead 6 + ceil(7/3.5)=2
  assert.equal(total, 8);
});

test('estimateMessages: sums overhead across multiple messages', () => {
  const total = estimateMessages([
    { role: 'system', content: 'a'.repeat(7) },
    { role: 'user', content: 'a'.repeat(7) },
  ]);
  assert.equal(total, 16);
});

test('estimateMessages: array content charges text parts by length and image parts flat', () => {
  const total = estimateMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'a'.repeat(7) },
        { type: 'image_url', image_url: { url: 'x' } },
      ],
    },
  ]);
  // overhead 6 + text 2 + default tokensPerImage 1600
  assert.equal(total, 6 + 2 + 1600);
});

test('estimateMessages: custom tokensPerImage is honoured', () => {
  const total = estimateMessages(
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    100,
  );
  assert.equal(total, 6 + 100);
});

test('estimateMessages: an empty messages array costs 0', () => {
  assert.equal(estimateMessages([]), 0);
});

test('createCalibrator: clamps an out-of-range initial ratio to RATIO_MIN/RATIO_MAX', () => {
  assert.equal(createCalibrator(0.1).ratio, 0.6);
  assert.equal(createCalibrator(5).ratio, 1.6);
});

test('createCalibrator: a non-finite initial ratio falls back to 1', () => {
  assert.equal(createCalibrator(NaN).ratio, 1);
  assert.equal(createCalibrator(undefined).ratio, 1);
});

test('createCalibrator: apply() multiplies and rounds up', () => {
  const cal = createCalibrator(1.5);
  assert.equal(cal.apply(10), 15);
  assert.equal(cal.apply(1), 2); // ceil(1.5)
});

test('createCalibrator: observe() ignores samples with a tiny raw estimate', () => {
  const cal = createCalibrator(1);
  cal.observe(200, 1000); // rawEstimate must be > 200, 200 is not enough
  assert.equal(cal.ratio, 1);
});

test('createCalibrator: observe() ignores samples with non-positive actual tokens', () => {
  const cal = createCalibrator(1);
  cal.observe(1000, 0);
  assert.equal(cal.ratio, 1);
});

test('createCalibrator: observe() moves the ratio toward the observed ratio (EMA)', () => {
  const cal = createCalibrator(1);
  const before = cal.ratio;
  const next = cal.observe(1000, 1200); // observed ratio 1.2
  assert.ok(next > before && next < 1.2, `expected ${before} < ${next} < 1.2`);
});

test('createCalibrator: observe() converges toward the observed ratio over repeated samples', () => {
  const cal = createCalibrator(1);
  for (let i = 0; i < 200; i += 1) cal.observe(1000, 1300);
  assert.ok(Math.abs(cal.ratio - 1.3) < 0.01, `expected ratio close to 1.3, got ${cal.ratio}`);
});

test('createCalibrator: observe() clamps the observed sample before averaging', () => {
  const cal = createCalibrator(1);
  for (let i = 0; i < 500; i += 1) cal.observe(1000, 100000); // sample ratio 100, clamped to 1.6
  // The EMA blend of ratio and a clamped sample is not itself re-clamped, so tiny
  // floating-point drift above RATIO_MAX is expected; only gross drift is a bug.
  assert.ok(cal.ratio <= 1.6 + 1e-9, `ratio must stay within float noise of RATIO_MAX, got ${cal.ratio}`);
  assert.ok(Math.abs(cal.ratio - 1.6) < 0.001);
});
