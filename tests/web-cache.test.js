// Tests for src/web/cache.js: the media cache helpers of the web lookup (LRU order, trimming,
// hashed keys). Pure: plain objects in, plain objects out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashedKey, touchKey, trimCache } from '../src/web/cache.js';

test('touchKey: a new key is appended; an existing one moves to the end with its new value', () => {
  const cache = { a: 1, b: 2, c: 3 };
  touchKey(cache, 'a', 10);
  assert.deepEqual(Object.keys(cache), ['b', 'c', 'a']);
  assert.equal(cache.a, 10);
  touchKey(cache, 'd', 4);
  assert.deepEqual(Object.keys(cache), ['b', 'c', 'a', 'd']);
});

test('trimCache: drops the oldest entries past maxEntries; a negative max empties it', () => {
  const cache = { a: 1, b: 2, c: 3, d: 4 };
  trimCache(cache, 2);
  assert.deepEqual(cache, { c: 3, d: 4 });
  trimCache(cache, 5);
  assert.deepEqual(cache, { c: 3, d: 4 });
  trimCache(cache, Infinity);
  assert.deepEqual(cache, { c: 3, d: 4 });
  trimCache(cache, -1);
  assert.deepEqual(cache, {});
});

test('hashedKey: `<prefix>:` and the first 16 hex characters of the text\'s sha1, the text taken as given', () => {
  const digest = createHash('sha1').update('qui a gagné ?').digest('hex').slice(0, 16);
  assert.equal(hashedKey('search', 'qui a gagné ?'), `search:${digest}`);
  assert.notEqual(hashedKey('search', 'Qui a gagné ?'), hashedKey('search', 'qui a gagné ?'), 'no normalisation of its own');
  assert.equal(hashedKey('video:x1:q', ''), `video:x1:q:${createHash('sha1').update('').digest('hex').slice(0, 16)}`);
});
