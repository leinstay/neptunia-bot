// Tests for src/llm/budget.js: fitSections, the priority-ordered token trimmer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitSections, SectionsTooLargeError } from '../src/llm/budget.js';

// Every item costs its own string length in "tokens" -- makes the arithmetic
// in assertions trivial and readable.
const cost = (text) => text.length;

test('fitSections: required sections are kept in full even when it leaves nothing for others', () => {
  const sections = [
    { name: 'fixed', required: true, items: ['aaaaaaaaaa'] }, // 10 tokens, fits exactly
    { name: 'optional', items: ['bb'] },
  ];
  const { kept, stats } = fitSections(sections, 10, cost);
  assert.deepEqual(kept.fixed, ['aaaaaaaaaa']);
  assert.equal(stats.fixed.used, 10);
  assert.equal(stats.fixed.dropped, 0);
  assert.deepEqual(kept.optional, []); // nothing left over for the non-required section
});

test('fitSections: throws when required sections alone exceed the limit', () => {
  const sections = [{ name: 'fixed', required: true, items: ['aaaaaaaaaa'] }]; // 10 tokens
  assert.throws(() => fitSections(sections, 5, cost), /required prompt sections exceed the token limit by 5/);
});

test('fitSections: the too-large error is a dedicated class, not just a matching message', () => {
  const sections = [{ name: 'fixed', required: true, items: ['aaaaaaaaaa'] }]; // 10 tokens
  assert.throws(() => fitSections(sections, 5, cost), SectionsTooLargeError);
});

test('fitSections: priority order -- earlier sections get first claim on the remaining budget', () => {
  const sections = [
    { name: 'high', items: ['aaaaa', 'bbbbb'] }, // 5 + 5 = 10
    { name: 'low', items: ['ccccc', 'dd'] }, // 5 + 2 = 7, only 4 tokens remain for it
  ];
  // Only 14 tokens total: "high" (earlier) should be fully kept, "low" partially.
  const { kept, stats } = fitSections(sections, 14, cost);
  assert.deepEqual(kept.high, ['aaaaa', 'bbbbb']);
  assert.equal(kept.low.length, 1);
  assert.equal(stats.high.dropped, 0);
  assert.equal(stats.low.dropped, 1);
});

test('fitSections: cap limits a section even when more budget remains', () => {
  const sections = [{ name: 'capped', cap: 5, items: ['aaaaa', 'bbbbb', 'ccccc'] }];
  const { kept, stats } = fitSections(sections, 1000, cost);
  assert.deepEqual(kept.capped, ['aaaaa']);
  assert.equal(stats.capped.used, 5);
  assert.equal(stats.capped.dropped, 2);
});

test("fitSections: keep 'newest' keeps a contiguous tail in original order", () => {
  // Reversed processing order is [d, c, b, a]; b is oversized so processing
  // stops there entirely (contiguous tail), even though 'a' would fit alone.
  const sections = [{ name: 'chat', keep: 'newest', items: ['a', 'b'.repeat(50), 'c', 'd'] }];
  const { kept, stats } = fitSections(sections, 10, cost);
  assert.deepEqual(kept.chat, ['c', 'd']);
  assert.equal(stats.chat.dropped, 2);
});

test("fitSections: keep 'newest' preserves original (oldest-first) order among survivors", () => {
  const sections = [{ name: 'chat', keep: 'newest', items: ['m1', 'm2', 'm3', 'm4'] }];
  const { kept } = fitSections(sections, 5, cost);
  assert.deepEqual(kept.chat, ['m3', 'm4']);
});

test("fitSections: keep 'first' skips an oversized item but keeps later smaller ones", () => {
  const sections = [{ name: 'ranked', keep: 'first', items: ['aa', 'b'.repeat(50), 'cc'] }];
  const { kept, stats } = fitSections(sections, 4, cost);
  assert.deepEqual(kept.ranked, ['aa', 'cc']);
  assert.equal(stats.ranked.used, 4);
  assert.equal(stats.ranked.dropped, 1);
});

test('fitSections: default (no keep) behaves like "first" -- skips oversized, keeps later smaller items', () => {
  const sections = [{ name: 'plain', items: ['aa', 'b'.repeat(50), 'cc'] }];
  const { kept } = fitSections(sections, 4, cost);
  assert.deepEqual(kept.plain, ['aa', 'cc']);
});

test('fitSections: stats reflect used/kept/dropped counts precisely', () => {
  const sections = [{ name: 's', items: ['aa', 'bb', 'cc', 'dd'] }];
  const { kept, stats } = fitSections(sections, 5, cost);
  assert.equal(kept.s.length, stats.s.kept);
  assert.equal(stats.s.kept + stats.s.dropped, 4);
  assert.equal(stats.s.used, kept.s.reduce((sum, i) => sum + cost(i), 0));
});

test('fitSections: overall "used" equals limit minus what remained', () => {
  const sections = [
    { name: 'fixed', required: true, items: ['aaa'] }, // 3
    { name: 'chat', keep: 'newest', items: ['bb', 'cc'] }, // up to 4
  ];
  const { stats, used } = fitSections(sections, 10, cost);
  const total = Object.values(stats).reduce((sum, s) => sum + s.used, 0);
  assert.equal(used, total);
});

test('fitSections: an empty sections list returns empty kept/stats and used=0', () => {
  const { kept, stats, used } = fitSections([], 100, cost);
  assert.deepEqual(kept, {});
  assert.deepEqual(stats, {});
  assert.equal(used, 0);
});

test('fitSections: a section with no items keeps nothing and drops nothing', () => {
  const sections = [{ name: 'empty', items: [] }];
  const { kept, stats } = fitSections(sections, 100, cost);
  assert.deepEqual(kept.empty, []);
  assert.equal(stats.empty.dropped, 0);
});

test('fitSections: multiple required sections all fit before non-required sections are considered', () => {
  const sections = [
    { name: 'r1', required: true, items: ['aaa'] },
    { name: 'r2', required: true, items: ['bb'] },
    { name: 'optional', items: ['ccccccccccc'] }, // 11, only 5 left after required (10-5)
  ];
  const { kept } = fitSections(sections, 10, cost);
  assert.deepEqual(kept.r1, ['aaa']);
  assert.deepEqual(kept.r2, ['bb']);
  assert.deepEqual(kept.optional, []);
});
