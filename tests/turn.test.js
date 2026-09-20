// Tests for the pure helpers in src/behavior/turn.js: between, typingMs and
// resolveMentions. createTurnRunner itself drives discord.js and the LLM and
// is out of scope for a pure-function unit test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { between, typingMs, resolveMentions } from '../src/behavior/turn.js';

function rngReturning(value) {
  return () => value;
}

test('between: rng=0 returns the minimum', () => {
  assert.equal(between([10, 20], rngReturning(0)), 10);
});

test('between: rng=1 returns the maximum', () => {
  assert.equal(between([10, 20], rngReturning(1)), 20);
});

test('between: rng=0.5 returns the midpoint', () => {
  assert.equal(between([10, 20], rngReturning(0.5)), 15);
});

test('typingMs: clamps below minMs for very short text', () => {
  const cfg = { msPerChar: [1, 1], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a', cfg, rngReturning(0)); // 1 char * 1ms/char = 1ms, way under minMs
  assert.equal(ms, 900);
});

test('typingMs: clamps above maxMs for very long text', () => {
  const cfg = { msPerChar: [100, 100], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a'.repeat(1000), cfg, rngReturning(0)); // 100,000ms, way over maxMs
  assert.equal(ms, 12000);
});

test('typingMs: within range uses length * msPerChar (rounded)', () => {
  const cfg = { msPerChar: [10, 10], minMs: 0, maxMs: 100000 };
  const ms = typingMs('a'.repeat(20), cfg, rngReturning(0));
  assert.equal(ms, 200);
});

test('typingMs: msPerChar is itself sampled via rng between its [min, max]', () => {
  const cfg = { msPerChar: [10, 20], minMs: 0, maxMs: 100000 };
  const ms = typingMs('a'.repeat(10), cfg, rngReturning(1)); // picks msPerChar=20
  assert.equal(ms, 200);
});

function historyMsg(authorName, authorId, overrides = {}) {
  return { authorName, authorId, self: false, bot: false, ...overrides };
}

test('resolveMentions: replaces a known @name with a real Discord mention', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('привет @Alice как дела', history);
  assert.equal(result.text, 'привет <@u1> как дела');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: an unknown name is left untouched', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('привет @Ghost', history);
  assert.equal(result.text, 'привет @Ghost');
  assert.deepEqual(result.userIds, []);
});

test('resolveMentions: excludes her own lines and bot lines from candidates', () => {
  const history = [
    historyMsg('Непка', 'self-id', { self: true }),
    historyMsg('SomeBot', 'bot-id', { bot: true }),
    historyMsg('Alice', 'u1'),
  ];
  const result = resolveMentions('@Непка @SomeBot @Alice', history);
  assert.equal(result.text, '@Непка @SomeBot <@u1>');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: longer names are matched before their shorter prefixes', () => {
  const history = [historyMsg('Anna', 'short-id'), historyMsg('AnnaMaria', 'long-id')];
  const result = resolveMentions('привет @AnnaMaria', history);
  // Must not first match "@Anna" inside "@AnnaMaria" and leave "Maria" dangling.
  assert.equal(result.text, 'привет <@long-id>');
  assert.deepEqual(result.userIds, ['long-id']);
});

test('resolveMentions: replaces every occurrence of the same name', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Alice привет @Alice', history);
  assert.equal(result.text, '<@u1> привет <@u1>');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: deduplicates authors that appear more than once in history', () => {
  const history = [historyMsg('Alice', 'u1'), historyMsg('Alice', 'u1', { content: 'again' })];
  const result = resolveMentions('@Alice', history);
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: text with no mentions is returned unchanged with empty userIds', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('просто текст', history);
  assert.equal(result.text, 'просто текст');
  assert.deepEqual(result.userIds, []);
});
