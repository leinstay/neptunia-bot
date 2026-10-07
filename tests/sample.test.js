import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSpreadSample } from '../src/memory/sample.js';
import { DAY_MS } from '../src/time.js';

const NOW = Date.UTC(2026, 9, 7, 12);
const msg = (daysAgo, i, authorId = 'a') => ({ ts: NOW - daysAgo * DAY_MS - i * 60_000, authorId, content: `m${daysAgo}-${i}` });

test('selectSpreadSample: one message per day per round, newest day first, chronological result', () => {
  const messages = [...Array(10).keys()].flatMap((d) => [msg(d, 0), msg(d, 1), msg(d, 2)]);
  const picked = selectSpreadSample(messages, { max: 12, maxAuthorShare: 1, nowMs: NOW });
  assert.equal(picked.length, 12);
  const days = new Set(picked.map((m) => new Date(m.ts).toISOString().slice(0, 10)));
  assert.equal(days.size, 10, 'every day represented before any day gets a second line');
  assert.deepEqual(picked.map((m) => m.ts), [...picked].map((m) => m.ts).sort((x, y) => x - y));
});

test('selectSpreadSample: the persona\'s own lines are dropped and an author is capped at the share', () => {
  const messages = [...Array(20).keys()].map((i) => msg(0, i, i % 10 === 0 ? 'bot' : i % 2 ? 'loud' : `q${i}`));
  const picked = selectSpreadSample(messages, { max: 10, maxAuthorShare: 0.3, excludeAuthorId: 'bot', nowMs: NOW });
  assert.equal(picked.some((m) => m.authorId === 'bot'), false);
  assert.ok(picked.filter((m) => m.authorId === 'loud').length <= 3);
  assert.equal(picked.length, 10);
});

test('selectSpreadSample: a dominant author never empties the sample', () => {
  const messages = [...Array(30).keys()].map((i) => msg(i % 5, i, i < 27 ? 'loud' : `q${i}`));
  const picked = selectSpreadSample(messages, { max: 20, maxAuthorShare: 0.35, nowMs: NOW });
  assert.equal(picked.length, 20, 'the cap is relaxed to fill the sample');
  assert.deepEqual(selectSpreadSample([], { max: 5, maxAuthorShare: 0.5, nowMs: NOW }), []);
});
