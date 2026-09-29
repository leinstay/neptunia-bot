import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { weightedTokens, createMentorBudget, MentorBudgetError } from '../src/mentor/budget.js';

const WEIGHTS = { outputTokenWeight: 5, cachedTokenWeight: 0.1 };

function fakeState() {
  return { data: {}, markDirty() { this.dirty = (this.dirty ?? 0) + 1; } };
}

function makeBudget({ state = fakeState(), mentor = {}, at = Date.UTC(2026, 8, 30, 12) } = {}) {
  const clock = { at };
  const config = { mentor: { maxTokensPerDay: 10000, ...WEIGHTS, ...mentor } };
  const budget = createMentorBudget({ state, getConfig: () => config, now: () => clock.at });
  return { budget, state, clock, config };
}

test('weightedTokens: prompt, cached and completion are weighted', () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } };
  assert.equal(weightedTokens(usage, WEIGHTS), 600 + 40 + 500);
});

test('weightedTokens: missing fields count as zero', () => {
  assert.equal(weightedTokens({}, WEIGHTS), 0);
  assert.equal(weightedTokens(undefined, WEIGHTS), 0);
  assert.equal(weightedTokens({ prompt_tokens: 300 }, WEIGHTS), 300);
  assert.equal(weightedTokens({ completion_tokens: 10 }, WEIGHTS), 50);
  assert.equal(weightedTokens({ prompt_tokens: 100, prompt_tokens_details: null }, WEIGHTS), 100);
});

test('weightedTokens: a fractional total is rounded up', () => {
  const usage = { prompt_tokens: 3, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 3 } };
  assert.equal(weightedTokens(usage, WEIGHTS), 1);
});

test('createMentorBudget: a new UTC day starts from zero', () => {
  const state = fakeState();
  state.data.mentorDay = '2026-09-29';
  state.data.mentorTokens = 9000;
  const { budget, clock } = makeBudget({ state, at: Date.UTC(2026, 8, 29, 23, 59) });

  assert.equal(budget.used(), 9000);
  assert.equal(budget.left(), 1000);

  clock.at = Date.UTC(2026, 8, 30, 0, 1);
  assert.equal(budget.used(), 0);
  assert.equal(budget.left(), 10000);
  assert.equal(state.data.mentorDay, '2026-09-30');
  assert.equal(state.data.mentorTokens, 0);
});

test('createMentorBudget: canSpend refuses past the cap', () => {
  const { budget } = makeBudget({ mentor: { maxTokensPerDay: 1000 } });
  assert.equal(budget.canSpend(1000), true);
  budget.charge(null, 600);
  assert.equal(budget.canSpend(400), true);
  assert.equal(budget.canSpend(401), false);
});

test('createMentorBudget: the cap is read from the live config at each call', () => {
  const { budget, config } = makeBudget({ mentor: { maxTokensPerDay: 1000 } });
  budget.charge(null, 800);
  assert.equal(budget.canSpend(500), false);
  config.mentor.maxTokensPerDay = 2000;
  assert.equal(budget.canSpend(500), true);
  assert.equal(budget.left(), 1200);
});

test('createMentorBudget: charge without usage adds the fallback estimate', () => {
  const { budget, state } = makeBudget();
  assert.equal(budget.charge(undefined, 750), 750);
  assert.equal(budget.used(), 750);
  assert.equal(state.data.mentorTokens, 750);

  const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } };
  assert.equal(budget.charge(usage, 99999), 1140);
  assert.equal(budget.used(), 1890);
});

test('createMentorBudget: every charge marks the state dirty', () => {
  const { budget, state } = makeBudget();
  budget.used(); // opens the day
  const before = state.dirty ?? 0;
  budget.charge(null, 10);
  budget.charge({ prompt_tokens: 5 }, 0);
  budget.charge(null, 0);
  assert.equal(state.dirty - before, 3);
});

test('createMentorBudget: snapshot reports the day, the use and the cap', () => {
  const { budget } = makeBudget({ mentor: { maxTokensPerDay: 1000 } });
  budget.charge(null, 250);
  assert.deepEqual(budget.snapshot(), { day: '2026-09-30', used: 250, cap: 1000, left: 750 });
});

test('MentorBudgetError: carries the config key, the use and the cap', () => {
  const err = new MentorBudgetError('mentor budget reached', { used: 10, cap: 5 });
  assert.ok(err instanceof Error);
  assert.equal(err.key, 'mentor.maxTokensPerDay');
  assert.equal(err.used, 10);
  assert.equal(err.cap, 5);
});

test('config.json: ships the mentor off, without a model, under a daily token cap', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.features.mentor, false);
  assert.equal(shipped.mentor.model, null);
  assert.equal(shipped.mentor.maxTokensPerDay, 400000);
  assert.equal(shipped.mentor.outputTokenWeight, 5);
  assert.equal(shipped.mentor.cachedTokenWeight, 0.1);
});
