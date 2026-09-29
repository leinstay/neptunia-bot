// Tests for src/behavior/limits.js: the one plain line that says a rail
// refused a directly requested action, and reading the limit off an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitNotice, limitOf, isLimitNotice } from '../src/behavior/limits.js';

const labels = { limits: { notice: 'limit hit: {limit} {used}/{cap}' } };

// --- limitNotice ---------------------------------------------------------------

test('limitNotice: fills {limit}, {used} and {cap}', () => {
  const text = limitNotice(labels, { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 });
  assert.equal(text, 'limit hit: llm.maxRequestsPerDay 300/300');
});

test('limitNotice: an empty string when the label is missing', () => {
  const limit = { key: 'image.maxPerDay', used: 50, cap: 50 };
  assert.equal(limitNotice({}, limit), '');
  assert.equal(limitNotice({ limits: {} }, limit), '');
  assert.equal(limitNotice({ limits: { notice: '' } }, limit), '');
  assert.equal(limitNotice(undefined, limit), '');
  assert.equal(limitNotice({ limits: { notice: 42 } }, limit), '');
});

test('limitNotice: a template may leave some placeholders out', () => {
  const custom = { limits: { notice: 'δεν ήρθε κανείς ({cap})' } };
  assert.equal(limitNotice(custom, { key: 'private.maxPerUserPerDay', used: 100, cap: 100 }), 'δεν ήρθε κανείς (100)');
});

// --- limitOf ---------------------------------------------------------------------

test('limitOf: reads { key, used, cap } off an error carrying them', () => {
  const err = Object.assign(new Error('cap'), { key: 'llm.maxRequestTokens', used: 60000, cap: 50000 });
  assert.deepEqual(limitOf(err), { key: 'llm.maxRequestTokens', used: 60000, cap: 50000 });
});

test('limitOf: null for an error without the fields, or with malformed ones', () => {
  assert.equal(limitOf(new Error('boom')), null);
  assert.equal(limitOf(null), null);
  assert.equal(limitOf(undefined), null);
  assert.equal(limitOf(Object.assign(new Error('x'), { key: '', used: 1, cap: 1 })), null);
  assert.equal(limitOf(Object.assign(new Error('x'), { key: 'llm.maxRequestsPerDay', cap: 1 })), null);
  assert.equal(limitOf(Object.assign(new Error('x'), { key: 'llm.maxRequestsPerDay', used: 1, cap: '1' })), null);
});

// --- isLimitNotice -----------------------------------------------------------------

test('isLimitNotice: true for a line the notice template produced', () => {
  const text = limitNotice(labels, { key: 'private.maxPerUserPerDay', used: 100, cap: 100 });
  assert.equal(isLimitNotice(labels, text), true);
  assert.equal(isLimitNotice(labels, 'limit hit: image.maxPerDay 50/50'), true);
});

test('isLimitNotice: false for ordinary text, a partial match or a notice inside a longer line', () => {
  assert.equal(isLimitNotice(labels, 'καλημέρα'), false);
  assert.equal(isLimitNotice(labels, 'limit hit: '), false);
  assert.equal(isLimitNotice(labels, 'so, limit hit: llm.maxRequestsPerDay 300/300'), false);
  const bracketed = { limits: { notice: '({limit} {used}/{cap})' } };
  assert.equal(isLimitNotice(bracketed, '(llm.maxRequestsPerDay 300/300) and more'), false);
  assert.equal(isLimitNotice(labels, ''), false);
  assert.equal(isLimitNotice(labels, undefined), false);
});

test('isLimitNotice: false when the label is missing or empty', () => {
  const text = 'limit hit: llm.maxRequestsPerDay 300/300';
  assert.equal(isLimitNotice({}, text), false);
  assert.equal(isLimitNotice(undefined, text), false);
  assert.equal(isLimitNotice({ limits: { notice: '' } }, text), false);
  assert.equal(isLimitNotice({ limits: { notice: 42 } }, text), false);
});

test('isLimitNotice: regex metacharacters in the label are matched literally', () => {
  const custom = { limits: { notice: '...but nobody came ({limit}, {used}/{cap}) [*+?^$|\\]' } };
  const text = limitNotice(custom, { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 });
  assert.equal(text, '...but nobody came (llm.maxRequestsPerDay, 800/800) [*+?^$|\\]');
  assert.equal(isLimitNotice(custom, text), true);
  assert.equal(isLimitNotice(custom, 'abcbut nobody came (llm.maxRequestsPerDay, 800/800) [*+?^$|\\]'), false, 'dots are literal');
  assert.equal(isLimitNotice(custom, '...but nobody came llm.maxRequestsPerDay, 800/800 [*+?^$|\\]'), false, 'parentheses are literal');
  assert.equal(isLimitNotice(custom, '...but nobody came (llm.maxRequestsPerDay, 800/800) [*+?^$|]'), false, 'the backslash is literal');
});
