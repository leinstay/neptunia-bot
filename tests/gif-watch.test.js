import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIF_MAX_PER_DAY_FALLBACK, gifWatchBlocker, gifWatchCap, gifWatchPrompt, gifWatchesToday } from '../src/memory/gif-watch.js';

const ON = { features: { mediaDescriptions: true }, media: { gif: { watch: true } } };
const VIDEO = { 'describe-video': 'video {{maxChars}}' };
const GIF = { 'describe-gif': 'gif {{maxChars}} {{seconds}}' };

test('gifWatchBlocker: null when the describer, video vision and a watch prompt are all there', () => {
  assert.equal(gifWatchBlocker(ON, VIDEO), null);
  assert.equal(gifWatchBlocker(ON, GIF), null, 'describe-gif alone is enough');
  assert.equal(gifWatchBlocker({ features: { mediaDescriptions: true } }, VIDEO), null, 'a missing media.gif.watch counts as on');
});

test('gifWatchBlocker: off, video-off and prompt in that order', () => {
  assert.equal(gifWatchBlocker({ features: {} }, VIDEO), 'off');
  assert.equal(gifWatchBlocker({ ...ON, media: { gif: { watch: false } } }, VIDEO), 'off');
  assert.equal(gifWatchBlocker({ ...ON, features: { mediaDescriptions: true, videoDescriptions: false } }, VIDEO), 'video-off');
  assert.equal(gifWatchBlocker(ON, {}), 'prompt');
  assert.equal(gifWatchBlocker(ON, { 'describe-video': '', 'describe-gif': '' }), 'prompt');
  assert.equal(gifWatchBlocker(ON, undefined), 'prompt');
  assert.equal(gifWatchBlocker(undefined, VIDEO), 'off');
});

test('gifWatchPrompt: describe-gif when present, else describe-video', () => {
  assert.deepEqual(gifWatchPrompt({ ...VIDEO, ...GIF }), { name: 'describe-gif', text: GIF['describe-gif'] });
  assert.deepEqual(gifWatchPrompt(VIDEO), { name: 'describe-video', text: VIDEO['describe-video'] });
  assert.deepEqual(gifWatchPrompt({ ...VIDEO, 'describe-gif': '' }), { name: 'describe-video', text: VIDEO['describe-video'] });
  assert.equal(gifWatchPrompt({}), null);
});

test('gifWatchCap: media.gif.maxPerDay, a missing or invalid value means the fallback', () => {
  assert.equal(GIF_MAX_PER_DAY_FALLBACK, 200);
  assert.equal(gifWatchCap({ media: { gif: { maxPerDay: 12 } } }), 12);
  assert.equal(gifWatchCap({ media: { gif: { maxPerDay: 0 } } }), 0, 'zero is a valid cap: no watches');
  assert.equal(gifWatchCap({ media: { gif: {} } }), 200);
  assert.equal(gifWatchCap({ media: { gif: { maxPerDay: -1 } } }), 200);
  assert.equal(gifWatchCap({ media: { gif: { maxPerDay: 'many' } } }), 200);
  assert.equal(gifWatchCap(undefined), 200);
});

test('gifWatchesToday: today\'s count against the cap; another day counts as zero', () => {
  const config = { media: { gif: { maxPerDay: 50 } } };
  assert.deepEqual(gifWatchesToday({ gifWatchDay: '2026-10-01', gifWatchCount: 7 }, config, '2026-10-01'), { used: 7, cap: 50 });
  assert.deepEqual(gifWatchesToday({ gifWatchDay: '2026-09-30', gifWatchCount: 7 }, config, '2026-10-01'), { used: 0, cap: 50 });
  assert.deepEqual(gifWatchesToday({}, config, '2026-10-01'), { used: 0, cap: 50 });
  assert.deepEqual(gifWatchesToday(undefined, undefined, '2026-10-01'), { used: 0, cap: 200 });
  // The video counter is a different one.
  assert.deepEqual(gifWatchesToday({ videoDay: '2026-10-01', videoCount: 40 }, config, '2026-10-01'), { used: 0, cap: 50 });
});
