// Tests for src/memory/describe.js: the media describer — caching, LRU
// trimming, persistence, per-batch caps and the feature switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/memory/store.js';
import { createDescriber } from '../src/memory/describe.js';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-describe-'));
}

function fakeHot(overrides = {}) {
  return {
    config: {
      features: { mediaDescriptions: true },
      media: { model: 'x/haiku', maxOutputTokens: 120, imageSize: 512, cacheEntries: 5000, maxPerTurn: 6, maxPerBatch: 20 },
      ...overrides.config,
    },
    prompts: { describe: 'Describe this picture in one plain line.', ...overrides.prompts },
  };
}

function pictureItem(itemId, overrides = {}) {
  return { itemId, kind: 'image', url: 'https://cdn.discordapp.com/x/pic.png', ...overrides };
}

function fakeLlm(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      const response = Array.isArray(responses) ? responses[call] : responses;
      call += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test('describe: feature off returns null without any request', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: false } } });
  const llm = fakeLlm({ text: 'a cat' });
  const describer = createDescriber({ hot, store, llm });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result, null);
  assert.equal(llm.calls.length, 0);
});

test('describe: missing prompts.describe returns null without any request', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ prompts: { describe: undefined } });
  const llm = fakeLlm({ text: 'a cat' });
  const describer = createDescriber({ hot, store, llm });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result, null);
  assert.equal(llm.calls.length, 0);
});

test('describe: a successful call returns the trimmed one-line text and caches it', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: '  A grey cat sleeping on a couch.\nsome extra line ignored  ', usage: { prompt_tokens: 200 }, estimated: 210 });
  const describer = createDescriber({ hot, store, llm });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result.text, 'A grey cat sleeping on a couch.');
  assert.equal(result.cached, undefined);
  assert.deepEqual(result.usage, { prompt_tokens: 200 });

  const cache = store.getMediaCache('g1');
  assert.equal(cache.a1.text, 'A grey cat sleeping on a couch.');
});

test('describe: the caption is trimmed to at most 200 characters', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'x'.repeat(500) });
  const describer = createDescriber({ hot, store, llm });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result.text.length, 200);
});

test('describe: a cache hit is free -- no LLM request, marked cached', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a cat' });
  const describer = createDescriber({ hot, store, llm });

  await describer.describe('g1', pictureItem('a1'));
  const second = await describer.describe('g1', pictureItem('a1'));

  assert.equal(llm.calls.length, 1, 'only the first call reached the LLM');
  assert.equal(second.cached, true);
  assert.equal(second.text, 'a cat');
});

test('describe: a failure is cached as a miss and not retried within the hour', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  let nowValue = 1_000_000;
  const llm = fakeLlm(new Error('provider down'));
  const describer = createDescriber({ hot, store, llm, now: () => nowValue });

  const first = await describer.describe('g1', pictureItem('a1'));
  assert.equal(first, null);
  assert.equal(llm.calls.length, 1);

  const second = await describer.describe('g1', pictureItem('a1'));
  assert.equal(second, null);
  assert.equal(llm.calls.length, 1, 'still within the miss TTL: no retry');

  nowValue += 61 * 60_000; // past the 1-hour miss TTL
  const llm2 = fakeLlm({ text: 'a cat now visible' });
  const describer2 = createDescriber({ hot, store, llm: llm2, now: () => nowValue });
  const third = await describer2.describe('g1', pictureItem('a1'));
  assert.equal(third.text, 'a cat now visible', 'the miss expired: retried and succeeded');
});

test('describe: an empty caption is treated as a miss, not cached as a success', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: '   ' });
  const describer = createDescriber({ hot, store, llm });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result, null);
  assert.equal(store.getMediaCache('g1').a1.miss, true);
});

test('describe: LRU-trims the cache to media.cacheEntries, evicting the least recently used', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { cacheEntries: 2 } } });
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm });

  await describer.describe('g1', pictureItem('a1'));
  await describer.describe('g1', pictureItem('a2'));
  await describer.describe('g1', pictureItem('a3')); // evicts a1 (oldest)

  const cache = store.getMediaCache('g1');
  assert.deepEqual(Object.keys(cache).sort(), ['a2', 'a3']);
});

test('describe: LRU access order -- re-describing (cache hit) bumps recency, protecting it from eviction', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { cacheEntries: 2 } } });
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm });

  await describer.describe('g1', pictureItem('a1'));
  await describer.describe('g1', pictureItem('a2'));
  await describer.describe('g1', pictureItem('a1')); // cache hit: a1 becomes most-recent
  await describer.describe('g1', pictureItem('a3')); // must evict a2, not a1

  const cache = store.getMediaCache('g1');
  assert.deepEqual(Object.keys(cache).sort(), ['a1', 'a3']);
});

test('describe: the media cache is persisted across store instances', async () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a cat' });
  const describerA = createDescriber({ hot, store: storeA, llm });
  await describerA.describe('g1', pictureItem('a1'));
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.getMediaCache('g1').a1.text, 'a cat');
});

test('describe: video items request a webp poster frame via the media proxy, without width/height', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a dog runs' });
  const describer = createDescriber({ hot, store, llm });

  await describer.describe('g1', pictureItem('v1', { kind: 'video', url: 'https://cdn.discordapp.com/x/clip.mp4' }));
  const sentUrl = llm.calls[0].messages[1].content[0].image_url.url;
  const parsed = new URL(sentUrl);
  assert.equal(parsed.searchParams.get('format'), 'webp');
  assert.equal(parsed.searchParams.get('width'), null);
});

test('describe: an image request resizes through the media proxy at media.imageSize', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { imageSize: 256 } } });
  const llm = fakeLlm({ text: 'a cat' });
  const describer = createDescriber({ hot, store, llm });

  await describer.describe('g1', pictureItem('a1'));
  const sentUrl = llm.calls[0].messages[1].content[0].image_url.url;
  assert.equal(new URL(sentUrl).searchParams.get('width'), '256');
});

// --- F17: stickers, custom emoji, link thumbnails -------------------------

test('describe: a sticker item is sent as-is, never through the media proxy (already sized via ?size=)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a frog gives a thumbs up' });
  const describer = createDescriber({ hot, store, llm });

  const stickerPicture = pictureItem('sticker:s1', { kind: 'sticker', url: 'https://media.discordapp.net/stickers/s1.png?size=160' });
  await describer.describe('g1', stickerPicture);
  const sentUrl = llm.calls[0].messages[1].content[0].image_url.url;
  assert.equal(sentUrl, 'https://media.discordapp.net/stickers/s1.png?size=160');
});

test('describe: an emoji item is sent as-is, never through the media proxy (cdn.discordapp.com host must survive)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a surprised cat face' });
  const describer = createDescriber({ hot, store, llm });

  const emojiPicture = pictureItem('emoji:e1', { kind: 'emoji', url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' });
  await describer.describe('g1', emojiPicture);
  const sentUrl = llm.calls[0].messages[1].content[0].image_url.url;
  assert.equal(sentUrl, 'https://cdn.discordapp.com/emojis/e1.webp?size=96');
});

test('describe: a link-thumbnail item resizes through the media proxy exactly like an image', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { imageSize: 256 } } });
  const llm = fakeLlm({ text: 'a cat plays piano' });
  const describer = createDescriber({ hot, store, llm });

  const linkPicture = pictureItem('link:abcd1234', { kind: 'link', url: 'https://cdn.discordapp.com/x/thumb.jpg' });
  await describer.describe('g1', linkPicture);
  const sentUrl = llm.calls[0].messages[1].content[0].image_url.url;
  assert.equal(new URL(sentUrl).searchParams.get('width'), '256');
});

test('describe: a link-thumbnail item on a non-Discord host (e.g. i.ytimg.com) is passed through untouched', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a cat plays piano' });
  const describer = createDescriber({ hot, store, llm });

  const linkPicture = pictureItem('link:abcd1234', { kind: 'link', url: 'https://i.ytimg.com/vi/xyz/hq.jpg' });
  await describer.describe('g1', linkPicture);
  const sentUrl = llm.calls[0].messages[1].content[0].image_url.url;
  assert.equal(sentUrl, 'https://i.ytimg.com/vi/xyz/hq.jpg');
});

test('describe: a cache HIT refreshes the entry\'s recency (sticker/emoji/link keys are ordinary LRU entries)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { cacheEntries: 2 } } });
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm });

  await describer.describe('g1', pictureItem('sticker:s1', { kind: 'sticker', url: 'https://media.discordapp.net/stickers/s1.png?size=160' }));
  await describer.describe('g1', pictureItem('emoji:e1', { kind: 'emoji', url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' }));
  // Re-describe the sticker (cache hit): it becomes the most-recently-used.
  const hit = await describer.describe('g1', pictureItem('sticker:s1', { kind: 'sticker', url: 'https://media.discordapp.net/stickers/s1.png?size=160' }));
  assert.equal(hit.cached, true);
  assert.equal(llm.calls.length, 2, 'the re-describe was a cache hit, no third LLM call yet');

  // A third distinct item must evict emoji:e1 (now the least-recently-used), not sticker:s1.
  await describer.describe('g1', pictureItem('link:abcd1234', { kind: 'link', url: 'https://cdn.discordapp.com/x/thumb.jpg' }));
  const cache = store.getMediaCache('g1');
  assert.deepEqual(Object.keys(cache).sort(), ['link:abcd1234', 'sticker:s1']);
});

test('describe: forwards countAgainstDailyCap to llm.complete', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a cat' });
  const describer = createDescriber({ hot, store, llm });

  await describer.describe('g1', pictureItem('a1'), { countAgainstDailyCap: false });
  assert.equal(llm.calls[0].options.countAgainstDailyCap, false);
});

test('describe: passes llm.timeoutMs (the chat timeout, not the analyzer\'s) as options.timeoutMs', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { llm: { timeoutMs: 90000 } } });
  const llm = fakeLlm({ text: 'a cat' });
  const describer = createDescriber({ hot, store, llm });

  await describer.describe('g1', pictureItem('a1'));
  assert.equal(llm.calls[0].options.timeoutMs, 90000);
});

// --- describeMany --------------------------------------------------------

test('describeMany: caps NEW descriptions at maxNew, cache hits are free', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm });

  // Pre-cache "a1" so its lookup is free and does not count toward maxNew.
  await describer.describe('g1', pictureItem('a1'));

  const items = [pictureItem('a1'), pictureItem('a2'), pictureItem('a3'), pictureItem('a4')];
  const { descriptions, newCount } = await describer.describeMany('g1', items, { maxNew: 2 });

  assert.equal(newCount, 2);
  assert.equal(descriptions.size, 3, 'a1 (cached) + 2 new ones');
  assert.ok(descriptions.has('a1'));
  assert.ok(descriptions.has('a2'));
  assert.ok(descriptions.has('a3'));
  assert.ok(!descriptions.has('a4'), 'maxNew reached before a4');
});

test('describeMany: calls onCharge once per NEW request, never for a cache hit', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm([{ text: 'one', usage: { prompt_tokens: 10 } }, { text: 'two', usage: { prompt_tokens: 20 } }]);
  const describer = createDescriber({ hot, store, llm });
  await describer.describe('g1', pictureItem('a1'));

  const charges = [];
  await describer.describeMany('g1', [pictureItem('a1'), pictureItem('a2')], { onCharge: (r) => charges.push(r) });

  assert.equal(charges.length, 1);
  assert.equal(charges[0].usage.prompt_tokens, 20);
});

test('describeMany: feature off -- every describe() call is a no-op, empty result', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: false } } });
  const llm = fakeLlm({ text: 'x' });
  const describer = createDescriber({ hot, store, llm });

  const { descriptions, newCount } = await describer.describeMany('g1', [pictureItem('a1')]);
  assert.equal(newCount, 0);
  assert.equal(descriptions.size, 0);
  assert.equal(llm.calls.length, 0);
});
