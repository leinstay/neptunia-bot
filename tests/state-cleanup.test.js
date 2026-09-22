import test from 'node:test';
import assert from 'node:assert/strict';

import { dropStaleWarmupProgress } from '../src/memory/state-cleanup.js';

function fakeStore(data) {
  let dirty = false;
  return {
    state: {
      data,
      markDirty: () => {
        dirty = true;
      },
    },
    get dirty() {
      return dirty;
    },
  };
}

test('dropStaleWarmupProgress: removes stale warm-up progress and marks the store dirty', () => {
  const store = fakeStore({ warmup: { done: false, channels: { c1: { messages: 5 } } }, llmCount: 3 });

  const result = dropStaleWarmupProgress(store);

  assert.equal(result, true);
  assert.equal(store.state.data.warmup, undefined);
  assert.equal(store.state.data.llmCount, 3, 'unrelated state is left untouched');
  assert.equal(store.dirty, true);
});

test('dropStaleWarmupProgress: a no-op, never throws, when there is nothing to drop', () => {
  const store = fakeStore({ llmCount: 3 });

  const result = dropStaleWarmupProgress(store);

  assert.equal(result, false);
  assert.equal(store.dirty, false);
  assert.deepEqual(store.state.data, { llmCount: 3 });
});

test('dropStaleWarmupProgress: never throws on a missing store/state/data', () => {
  assert.doesNotThrow(() => dropStaleWarmupProgress(undefined));
  assert.doesNotThrow(() => dropStaleWarmupProgress({}));
  assert.doesNotThrow(() => dropStaleWarmupProgress({ state: {} }));
});
