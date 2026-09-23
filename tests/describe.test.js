// Tests for src/memory/describe.js: the media describer — caching, LRU
// trimming, persistence, per-batch caps, the feature switch, and the
// download-first flow: a picture is downloaded and sent to the model
// as a data: URL, never as a bare Discord URL a provider might refuse to
// fetch itself; a failed download is cached as a miss exactly like a failed
// LLM request, and every failure path logs one `describe: failed` line.
// The video half (describeVideo / describeVideos) runs on a fake video
// fetcher, a fake llm and a fake persistent state: watch paths, cache
// states, the daily video rail and the per-batch cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/memory/store.js';
import { createDescriber } from '../src/memory/describe.js';
import { createLlm, TokenLimitError, DailyCapError } from '../src/llm/openrouter.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-describe-'));
}

function fakeHot(overrides = {}) {
  return {
    config: {
      features: { mediaDescriptions: true },
      media: { model: 'x/haiku', maxOutputTokens: 120, imageSize: 512, cacheEntries: 5000, maxPerTurn: 6 },
      context: { vision: { maxBytes: 1_500_000, fetchTimeoutMs: 10_000 } },
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

const SUCCESSFUL_DOWNLOAD = { dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' };

/** A fake createImageFetcher()-shaped dependency. `result` may be `null` (every download fails), a fixed
 * success object, or a function `(url, options) => result|null` for per-call behaviour. */
function fakeImageFetcher(result = SUCCESSFUL_DOWNLOAD) {
  const calls = [];
  return {
    calls,
    fetchAsDataUrl: async (url, options) => {
      calls.push({ url, options });
      return typeof result === 'function' ? result(url, options) : result;
    },
  };
}

test('describe: feature off returns null without any request', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: false } } });
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result, null);
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0, 'the feature switch must short-circuit before any download');
});

test('describe: missing prompts.describe returns null without any request', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ prompts: { describe: undefined } });
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result, null);
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0);
});

test('describe: a successful call downloads the picture, sends it as a data: URL, returns the trimmed text and caches it', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: '  A grey cat sleeping on a couch.\nsome extra line ignored  ', usage: { prompt_tokens: 200 }, estimated: 210 });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result.text, 'A grey cat sleeping on a couch.');
  assert.equal(result.cached, undefined);
  assert.deepEqual(result.usage, { prompt_tokens: 200 });

  const sentUrl = llm.calls[0].messages[1].content[0].image_url.url;
  assert.equal(sentUrl, SUCCESSFUL_DOWNLOAD.dataUrl, 'the model must receive the downloaded data: URL, never the bare Discord URL');

  const cache = store.getMediaCache('g1');
  assert.equal(cache.a1.text, 'A grey cat sleeping on a couch.');
});

test('describe: the caption is trimmed to at most 200 characters', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'x'.repeat(500) });
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result.text.length, 200);
});

test('describe: a cache hit is free -- no download, no LLM request, marked cached', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  await describer.describe('g1', pictureItem('a1'));
  const second = await describer.describe('g1', pictureItem('a1'));

  assert.equal(llm.calls.length, 1, 'only the first call reached the LLM');
  assert.equal(imageFetcher.calls.length, 1, 'only the first call downloaded anything');
  assert.equal(second.cached, true);
  assert.equal(second.text, 'a cat');
});

// --- download-first, download failure, LLM failure --------------------

test('describe: a failed download is cached as a miss, costs no LLM request, and logs reason "download"', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'should never be reached' });
  const imageFetcher = fakeImageFetcher(null); // every download fails
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { result, logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1', { kind: 'gif' })));

  assert.equal(result, null);
  assert.equal(llm.calls.length, 0, 'a failed download must cost nothing');
  assert.equal(store.getMediaCache('g1').a1.miss, true);

  const line = logs.find((l) => l.msg === 'describe: failed');
  assert.ok(line, 'expected a "describe: failed" log line');
  assert.equal(line.kind, 'gif');
  assert.equal(line.reason, 'download');
});

test('describe: passes context.vision.maxBytes/fetchTimeoutMs to the image fetcher', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { context: { vision: { maxBytes: 999, fetchTimeoutMs: 4321 } } } });
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  await describer.describe('g1', pictureItem('a1'));

  assert.deepEqual(imageFetcher.calls[0].options, { maxBytes: 999, timeoutMs: 4321 });
});

test('describe: a downloaded-but-failed-LLM-request is cached as a miss and logs reason "llm" with the status', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const err = new Error('OpenRouter HTTP 400: bad request');
  err.statusCode = 400;
  const llm = fakeLlm(err);
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { result, logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1', { kind: 'video' })));

  assert.equal(result, null);
  assert.equal(store.getMediaCache('g1').a1.miss, true);

  const line = logs.find((l) => l.msg === 'describe: failed');
  assert.ok(line);
  assert.equal(line.kind, 'video');
  assert.equal(line.reason, 'llm');
  assert.equal(line.status, 400);
  assert.ok(!JSON.stringify(line).includes('description'), 'never logs the description text');
});

test('describe: a failure log never leaks the description text or a signed URL', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const err = new Error('failed fetching https://media.discordapp.net/x.png?ex=deadbeef&is=cafef00d something secret text');
  const llm = fakeLlm(err);
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1')));

  const line = logs.find((l) => l.msg === 'describe: failed');
  assert.ok(line);
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes('ex=deadbeef'));
  assert.ok(!serialized.includes('cafef00d'));
  assert.ok(line.detail.length <= 200);
});

test('describe: a failure is cached as a miss and not retried within the hour (download succeeds, LLM fails)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  let nowValue = 1_000_000;
  const llm = fakeLlm(new Error('provider down'));
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher, now: () => nowValue });

  const first = await describer.describe('g1', pictureItem('a1'));
  assert.equal(first, null);
  assert.equal(llm.calls.length, 1);

  const second = await describer.describe('g1', pictureItem('a1'));
  assert.equal(second, null);
  assert.equal(llm.calls.length, 1, 'still within the miss TTL: no retry');

  nowValue += 61 * 60_000; // past the 1-hour miss TTL
  const llm2 = fakeLlm({ text: 'a cat now visible' });
  const describer2 = createDescriber({ hot, store, llm: llm2, imageFetcher: fakeImageFetcher(), now: () => nowValue });
  const third = await describer2.describe('g1', pictureItem('a1'));
  assert.equal(third.text, 'a cat now visible', 'the miss expired: retried and succeeded');
});

test('describe: an empty caption is treated as a miss, not cached as a success, and logs reason "empty"', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: '   ' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { result, logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1')));
  assert.equal(result, null);
  assert.equal(store.getMediaCache('g1').a1.miss, true);
  const line = logs.find((l) => l.msg === 'describe: failed');
  assert.ok(line);
  assert.equal(line.reason, 'empty');
});

test('describe: LRU-trims the cache to media.cacheEntries, evicting the least recently used', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { cacheEntries: 2 } } });
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

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
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

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
  const describerA = createDescriber({ hot, store: storeA, llm, imageFetcher: fakeImageFetcher() });
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
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  await describer.describe('g1', pictureItem('v1', { kind: 'video', url: 'https://cdn.discordapp.com/x/clip.mp4' }));
  const fetchedUrl = imageFetcher.calls[0].url;
  const parsed = new URL(fetchedUrl);
  assert.equal(parsed.searchParams.get('format'), 'webp');
  assert.equal(parsed.searchParams.get('width'), null);
  // The model only ever sees the downloaded data: URL, never the CDN one.
  assert.equal(llm.calls[0].messages[1].content[0].image_url.url, SUCCESSFUL_DOWNLOAD.dataUrl);
});

test('describe: an image request resizes through the media proxy at media.imageSize', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { imageSize: 256 } } });
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  await describer.describe('g1', pictureItem('a1'));
  const fetchedUrl = imageFetcher.calls[0].url;
  assert.equal(new URL(fetchedUrl).searchParams.get('width'), '256');
});

// --- stickers, custom emoji, link thumbnails -------------------------

test('describe: a sticker item is downloaded as-is, never through the media proxy (already sized via ?size=)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a frog gives a thumbs up' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const stickerPicture = pictureItem('sticker:s1', { kind: 'sticker', url: 'https://media.discordapp.net/stickers/s1.png?size=160' });
  await describer.describe('g1', stickerPicture);
  assert.equal(imageFetcher.calls[0].url, 'https://media.discordapp.net/stickers/s1.png?size=160');
});

test('describe: an emoji item is downloaded as-is, never through the media proxy (cdn.discordapp.com host must survive)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a surprised cat face' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const emojiPicture = pictureItem('emoji:e1', { kind: 'emoji', url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' });
  await describer.describe('g1', emojiPicture);
  assert.equal(imageFetcher.calls[0].url, 'https://cdn.discordapp.com/emojis/e1.webp?size=96');
});

test('describe: a link-thumbnail item resizes through the media proxy exactly like an image', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { imageSize: 256 } } });
  const llm = fakeLlm({ text: 'a cat plays piano' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const linkPicture = pictureItem('link:abcd1234', { kind: 'link', url: 'https://cdn.discordapp.com/x/thumb.jpg' });
  await describer.describe('g1', linkPicture);
  const fetchedUrl = imageFetcher.calls[0].url;
  assert.equal(new URL(fetchedUrl).searchParams.get('width'), '256');
});

test('describe: a link-thumbnail item on a non-Discord host (e.g. i.ytimg.com) is passed through untouched', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a cat plays piano' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const linkPicture = pictureItem('link:abcd1234', { kind: 'link', url: 'https://i.ytimg.com/vi/xyz/hq.jpg' });
  await describer.describe('g1', linkPicture);
  assert.equal(imageFetcher.calls[0].url, 'https://i.ytimg.com/vi/xyz/hq.jpg');
});

test('describe: a cache HIT refreshes the entry\'s recency (sticker/emoji/link keys are ordinary LRU entries)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { cacheEntries: 2 } } });
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

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
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

  await describer.describe('g1', pictureItem('a1'), { countAgainstDailyCap: false });
  assert.equal(llm.calls[0].options.countAgainstDailyCap, false);
});

test('describe: passes llm.timeoutMs (the chat timeout, not the analyzer\'s) as options.timeoutMs', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { llm: { timeoutMs: 90000 } } });
  const llm = fakeLlm({ text: 'a cat' });
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

  await describer.describe('g1', pictureItem('a1'));
  assert.equal(llm.calls[0].options.timeoutMs, 90000);
});

// --- describeMany --------------------------------------------------------

test('describeMany: caps NEW descriptions at maxNew, cache hits are free', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

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
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });
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
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { descriptions, newCount } = await describer.describeMany('g1', [pictureItem('a1')]);
  assert.equal(newCount, 0);
  assert.equal(descriptions.size, 0);
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0);
});

// --- describeVideo -------------------------------------------------------

const VIDEO_PROMPT = 'Watch this clip and say what happens.';
const VIDEO_CFG = {
  model: 'x/video-model',
  provider: { order: ['pinned'], allow_fallbacks: false },
  maxOutputTokens: 400,
  maxRequestTokens: 60_000,
  maxSeconds: 60,
  directUrlMaxSeconds: 180,
  maxBytes: 8_000_000,
  maxPerTurn: 1,
  maxPerDay: 40,
  timeoutMs: 90_000,
  toolTimeoutMs: 60_000,
  sites: ['youtube.com', 'youtu.be', 'tiktok.com'],
  directUrlSites: ['youtube.com', 'youtu.be'],
  ytdlpPath: 'yt-dlp-test',
  ffmpegPath: 'ffmpeg-test',
};

function videoHot({ features = {}, video = {}, prompts = {} } = {}) {
  return {
    config: {
      features: { mediaDescriptions: true, videoDescriptions: true, ...features },
      media: { model: 'x/haiku', maxOutputTokens: 120, cacheEntries: 5000, video: { ...VIDEO_CFG, ...video } },
      context: { vision: { maxBytes: 1_500_000, fetchTimeoutMs: 10_000 } },
    },
    prompts: { describe: 'Describe this picture.', 'describe-video': VIDEO_PROMPT, ...prompts },
  };
}

function fakeState(data = {}) {
  let dirty = 0;
  return {
    data,
    markDirty() {
      dirty += 1;
    },
    get dirtyCount() {
      return dirty;
    },
  };
}

const CLIP_DATA_URL = 'data:video/mp4;base64,Y2xpcA==';

/** A fake createVideoFetcher()-shaped dependency; every method records its call and returns the given result. */
function fakeVideoFetcher({
  attachment = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4 },
  probe = { ok: true, durationSec: 30, title: 'Ελληνικό' },
  clip = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 60, bytes: 4 },
  youtube = { ok: false, reason: 'download' },
} = {}) {
  const calls = [];
  return {
    calls,
    fetchAttachment: async (url, options) => {
      calls.push({ fn: 'fetchAttachment', url, options });
      return attachment;
    },
    probeSite: async (url, options) => {
      calls.push({ fn: 'probeSite', url, options });
      return probe;
    },
    fetchSiteClip: async (url, options) => {
      calls.push({ fn: 'fetchSiteClip', url, options });
      return clip;
    },
    probeYoutube: async (url, options) => {
      calls.push({ fn: 'probeYoutube', url, options });
      return youtube;
    },
  };
}

function videoAttachment(itemId = 'v1', overrides = {}) {
  return {
    source: 'attachment',
    messageId: 'm1',
    itemId,
    kind: 'video',
    url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=secret',
    name: 'clip.mp4',
    durationSec: 12,
    bytes: 1000,
    ...overrides,
  };
}

function videoLink(itemId = 'video:url:0123456789abcdef', overrides = {}) {
  return {
    source: 'link',
    messageId: 'm1',
    itemId,
    kind: 'link',
    url: 'https://www.youtube.com/watch?v=abc',
    site: 'youtube.com',
    name: 'A title',
    durationSec: null,
    ...overrides,
  };
}

function videoDescriber({
  hot = videoHot(),
  llm = fakeLlm({ text: 'someone dances' }),
  videoFetcher = fakeVideoFetcher(),
  state = fakeState(),
  now,
  youtubeApiKey,
} = {}) {
  const store = createStore({ dataDir: tmpDataDir() });
  const describer = createDescriber({
    hot,
    store,
    llm,
    imageFetcher: fakeImageFetcher(),
    videoFetcher,
    state,
    ...(now ? { now } : {}),
    ...(youtubeApiKey !== undefined ? { youtubeApiKey } : {}),
  });
  return { describer, store, llm, videoFetcher, state, hot };
}

test('describeVideo: attachment is watched through a data URL with the video settings', async () => {
  const { describer, llm, videoFetcher, state } = videoDescriber();
  const result = await describer.describeVideo('g1', videoAttachment());

  assert.equal(result.state, 'watched');
  assert.equal(result.text, 'someone dances');
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(videoFetcher.calls[0].fn, 'fetchAttachment');
  assert.deepEqual(videoFetcher.calls[0].options, {
    durationSec: 12,
    maxSeconds: 60,
    maxBytes: 8_000_000,
    toolTimeoutMs: 60_000,
    ffmpegPath: 'ffmpeg-test',
    fetchTimeoutMs: 10_000,
  });
  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.deepEqual(system, { role: 'system', content: VIDEO_PROMPT });
  assert.deepEqual(user.content, [{ type: 'video_url', video_url: { url: CLIP_DATA_URL } }]);
  const options = llm.calls[0].options;
  assert.equal(options.model, 'x/video-model');
  assert.equal(options.maxOutputTokens, 400);
  assert.equal(options.timeoutMs, 90_000);
  assert.equal(options.videoSeconds, 12);
  assert.equal(options.provider, undefined, 'a downloaded clip does not pin the provider');
  assert.equal(options.skipCalibration, true, 'a video request must never feed the text calibration');
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(state.data.videoCount, 1);
});

test('describeVideo: a direct-URL site within maxSeconds sends the public URL with the pinned provider', async () => {
  const { describer, llm, videoFetcher } = videoDescriber();
  const result = await describer.describeVideo('g1', videoLink());

  assert.equal(result.state, 'watched');
  assert.deepEqual(
    videoFetcher.calls.map((c) => c.fn),
    ['probeSite'],
  );
  assert.deepEqual(videoFetcher.calls[0].options, { ytdlpPath: 'yt-dlp-test', toolTimeoutMs: 60_000 });
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 30);
});

test('describeVideo: a non-direct site downloads a clip; the raw URL never reaches the request', async () => {
  const { describer, llm, videoFetcher } = videoDescriber();
  const item = videoLink('video:url:aaaaaaaaaaaaaaaa', { url: 'https://www.tiktok.com/@someone/video/123', site: 'tiktok.com' });
  const result = await describer.describeVideo('g1', item);

  assert.equal(result.state, 'watched');
  assert.deepEqual(
    videoFetcher.calls.map((c) => c.fn),
    ['probeSite', 'fetchSiteClip'],
  );
  assert.deepEqual(videoFetcher.calls[1].options, {
    ytdlpPath: 'yt-dlp-test',
    ffmpegPath: 'ffmpeg-test',
    maxSeconds: 60,
    maxBytes: 8_000_000,
    toolTimeoutMs: 60_000,
    durationSec: 30,
  });
  const body = JSON.stringify(llm.calls[0].messages);
  assert.ok(!body.includes('tiktok.com'), 'only the data URL is sent');
  assert.ok(body.includes(CLIP_DATA_URL));
  assert.equal(llm.calls[0].options.provider, undefined);
  assert.equal(llm.calls[0].options.videoSeconds, 60);
});

test('describeVideo: a direct-URL site longer than maxSeconds (or of unknown length) is clipped instead', async () => {
  for (const durationSec of [600, null]) {
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec, title: null } });
    const { describer, llm } = videoDescriber({ videoFetcher });
    const result = await describer.describeVideo('g1', videoLink());
    assert.equal(result.state, 'watched');
    assert.deepEqual(
      videoFetcher.calls.map((c) => c.fn),
      ['probeSite', 'fetchSiteClip'],
    );
    assert.ok(!JSON.stringify(llm.calls[0].messages).includes('youtube.com'));
    assert.equal(llm.calls[0].options.provider, undefined);
  }
});

test('describeVideo: a cache hit is free and marked cached', async () => {
  const { describer, llm, videoFetcher, state } = videoDescriber();
  await describer.describeVideo('g1', videoAttachment());
  const again = await describer.describeVideo('g1', videoAttachment());

  assert.deepEqual(again, { state: 'watched', text: 'someone dances', usage: null, estimated: 0, cached: true });
  assert.equal(llm.calls.length, 1);
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(state.data.videoCount, 1);
});

test('describeVideo: shares the media cache under video:<itemId>, LRU-trimmed to media.cacheEntries', async () => {
  const hot = videoHot();
  hot.config.media.cacheEntries = 2;
  const { describer, store } = videoDescriber({ hot });
  await describer.describeVideo('g1', videoAttachment('v1'));
  await describer.describeVideo('g1', videoAttachment('v2'));
  await describer.describeVideo('g1', videoAttachment('v3'));

  const cache = store.getMediaCache('g1');
  assert.deepEqual(Object.keys(cache), ['video:v2', 'video:v3']);
  assert.equal(cache['video:v3'].watched, true);
  assert.equal(cache['video:v3'].text, 'someone dances');
});

test('describeVideo: a length or size failure is a permanent limit, never retried', async () => {
  for (const reason of ['length', 'size']) {
    let t = 1_000_000;
    // A length miss stays a limit only with a known duration over the cap.
    const attachment = reason === 'length' ? { ok: false, reason, durationSec: 600 } : { ok: false, reason };
    const videoFetcher = fakeVideoFetcher({ attachment });
    const { describer, llm, store, state } = videoDescriber({ videoFetcher, now: () => t });

    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'limit', reason });
    t += 30 * 24 * 60 * 60_000;
    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'limit', reason });

    assert.equal(videoFetcher.calls.length, 1, 'the permanent miss is served from the cache');
    assert.equal(llm.calls.length, 0);
    assert.equal(store.getMediaCache('g1')['video:v1'].reason, reason);
    assert.equal(state.data.videoCount, 1, 'the attempt reserved its daily slot, which it keeps');
  }
});

test('describeVideo: a download/tool/timeout failure is an error miss, retried after an hour', async () => {
  for (const reason of ['download', 'tool', 'timeout']) {
    let t = 1_000_000;
    const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason } });
    const { describer } = videoDescriber({ videoFetcher, now: () => t });

    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
    t += 30 * 60_000;
    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
    assert.equal(videoFetcher.calls.length, 1, 'inside the hour the miss is served from the cache');
    t += 31 * 60_000;
    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
    assert.equal(videoFetcher.calls.length, 2, 'after the hour it is retried');
  }
});

test('describeVideo: media.video.errorRetryMinutes sets the error-miss TTL, read at the moment of use', async () => {
  let t = 1_000_000;
  const hot = videoHot();
  hot.config.media.video.errorRetryMinutes = 30;
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } });
  const { describer } = videoDescriber({ hot, videoFetcher, now: () => t });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  t += 29 * 60_000;
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  assert.equal(videoFetcher.calls.length, 1, 'inside 30 minutes the miss is served from the cache');
  t += 2 * 60_000;
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  assert.equal(videoFetcher.calls.length, 2, 'after 31 minutes it is retried');

  hot.config.media.video.errorRetryMinutes = 120;
  t += 61 * 60_000;
  await describer.describeVideo('g1', videoAttachment());
  assert.equal(videoFetcher.calls.length, 2, 'a live change applies to the next lookup');
});

test('describeVideo: errorRetryMinutes defaults to 60 in config.json', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.media.video.errorRetryMinutes, 60);
});

test('describeVideo: force retries an error miss at once and logs forced: true', async () => {
  let t = 1_000_000;
  let attachment = { ok: false, reason: 'download' };
  const videoFetcher = fakeVideoFetcher();
  const fetchAttachment = videoFetcher.fetchAttachment;
  videoFetcher.fetchAttachment = async (url, options) => {
    await fetchAttachment(url, options);
    return attachment;
  };
  const { describer, llm, state } = videoDescriber({ videoFetcher, now: () => t });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  t += 60_000;
  attachment = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4 };
  const { result, logs } = await withCapturedLogs(() => describer.describeVideo('g1', videoAttachment(), { force: true }));

  assert.equal(result.state, 'watched');
  assert.equal(result.text, 'someone dances');
  assert.equal(videoFetcher.calls.length, 2);
  assert.equal(llm.calls.length, 1);
  assert.equal(state.data.videoCount, 2, 'the forced attempt takes a daily slot like any other');
  const line = logs.find((l) => l.msg === 'describe: video');
  assert.equal(line.forced, true);
  assert.equal(line.cached, false);
  assert.ok(!JSON.stringify(logs).includes('someone dances'));
  assert.ok(!JSON.stringify(logs).includes('ex=secret'));
});

test('describeVideo: force still honours a limit miss and a watched entry', async () => {
  const limited = videoDescriber({ videoFetcher: fakeVideoFetcher({ attachment: { ok: false, reason: 'size' } }) });
  await limited.describer.describeVideo('g1', videoAttachment());
  assert.deepEqual(await limited.describer.describeVideo('g1', videoAttachment(), { force: true }), { state: 'limit', reason: 'size' });
  assert.equal(limited.videoFetcher.calls.length, 1, 'a limit stays a limit');

  const watched = videoDescriber();
  await watched.describer.describeVideo('g1', videoAttachment());
  const again = await watched.describer.describeVideo('g1', videoAttachment(), { force: true });
  assert.equal(again.cached, true);
  assert.equal(watched.videoFetcher.calls.length, 1, 'a watched video is never re-fetched');
  assert.equal(watched.llm.calls.length, 1);
});

test('describeVideo: force keeps the daily cap', async () => {
  const hot = videoHot();
  hot.config.media.video.maxPerDay = 1;
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } });
  const { describer } = videoDescriber({ hot, videoFetcher });
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment(), { force: true }), { state: 'limit', reason: 'daily' });
  assert.equal(videoFetcher.calls.length, 1);
});

test('describeVideo: a public-URL part carries media.video.urlProcessing; a data: URL part never does', async () => {
  const pinned = videoDescriber();
  await pinned.describer.describeVideo('g1', videoLink());
  assert.deepEqual(pinned.llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);

  const clipped = videoDescriber();
  await clipped.describer.describeVideo('g1', videoLink('video:url:aaaaaaaaaaaaaaaa', { url: 'https://www.tiktok.com/@someone/video/123', site: 'tiktok.com' }));
  assert.deepEqual(clipped.llm.calls[0].messages[1].content, [{ type: 'video_url', video_url: { url: CLIP_DATA_URL } }]);

  const custom = videoDescriber({ hot: videoHot({ video: { urlProcessing: 'frames' } }) });
  await custom.describer.describeVideo('g1', videoLink());
  assert.equal(custom.llm.calls[0].messages[1].content[0].video_url.processing, 'frames');

  const hot = videoHot({ video: { urlProcessing: null } });
  const off = videoDescriber({ hot });
  await off.describer.describeVideo('g1', videoLink());
  assert.equal('processing' in off.llm.calls[0].messages[1].content[0].video_url, false, 'null omits the field');
});

test('describeVideo: config.json ships urlProcessing agentic and reasoning effort low', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(shipped.media.video.urlProcessing, 'agentic');
  assert.deepEqual(shipped.media.video.reasoning, { effort: 'low' });
});

test('describeVideo: the request body carries media.video.reasoning (shipped default) through the real client; a non-object omits it', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const run = async (reasoning) => {
    const hot = videoHot({ video: { reasoning } });
    hot.config.llm = {
      baseUrl: 'https://openrouter.test/api/v1',
      model: 'x/chat',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 50_000,
      maxRequestsPerDay: 300,
      timeoutMs: 5_000,
      retries: 0,
    };
    const bodies = [];
    const llm = createLlm({
      apiKey: 'k',
      getConfig: () => hot.config,
      calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
      state: { data: {}, markDirty() {} },
      fetchImpl: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'someone dances' } }], usage: {} }) };
      },
    });
    const { describer } = videoDescriber({ hot, llm });
    assert.equal((await describer.describeVideo('g1', videoAttachment())).state, 'watched');
    return bodies[0];
  };
  assert.deepEqual((await run(shipped.media.video.reasoning)).reasoning, { effort: 'low' });
  assert.equal('reasoning' in (await run(null)), false);
  assert.equal('reasoning' in (await run('off')), false);
});

test('describeVideo: a forced retry and a re-watch pass media.video.reasoning too', async () => {
  let t = 1_000_000;
  let attachment = { ok: false, reason: 'download' };
  const videoFetcher = fakeVideoFetcher();
  videoFetcher.fetchAttachment = async () => attachment;
  const hot = videoHot({ video: { reasoning: { effort: 'low' } } });
  hot.prompts['rewatch-answer'] = 'Answer {{question}} in {{maxChars}}.';
  const { describer, llm } = videoDescriber({ hot, videoFetcher, now: () => t });
  await describer.describeVideo('g1', videoAttachment());
  attachment = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4 };
  t += 60_000;
  await describer.describeVideo('g1', videoAttachment(), { force: true });
  await describer.rewatchVideo('g1', videoAttachment(), 'τι χρώμα;');
  assert.equal(llm.calls.length, 2);
  for (const call of llm.calls) assert.deepEqual(call.options.reasoning, { effort: 'low' });
});

test('describeVideo: a failed probe maps its reason like a fetch failure', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: false, reason: 'tool' } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'error' });
  assert.equal(llm.calls.length, 0);
});

test('describeVideo: an LLM error (rails included) is an error miss', async () => {
  for (const error of [new Error('boom'), new TokenLimitError('cap'), new DailyCapError('day')]) {
    const { describer, store } = videoDescriber({ llm: fakeLlm(error) });
    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
    assert.equal(store.getMediaCache('g1')['video:v1'].reason, 'error');
  }
});

test('describeVideo: the daily cap returns daily without a request and without caching', async () => {
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 40 });
  const { describer, llm, videoFetcher, store } = videoDescriber({ state, now });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'limit', reason: 'daily' });
  assert.equal(llm.calls.length, 0);
  assert.equal(videoFetcher.calls.length, 0);
  assert.equal(store.getMediaCache('g1')['video:v1'], undefined);
  assert.equal(state.data.videoCount, 40);
});

test('describeVideo: the daily counter resets on a new day and counts only sent requests', async () => {
  const now = () => Date.parse('2026-09-24T00:30:00Z');
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 40 });
  const { describer } = videoDescriber({ state, now });

  assert.equal((await describer.describeVideo('g1', videoAttachment())).state, 'watched');
  assert.equal(state.data.videoDay, '2026-09-24');
  assert.equal(state.data.videoCount, 1);
  assert.ok(state.dirtyCount > 0);
});

test('describeVideo: feature off, missing prompt or a non-video item -> null without any request', async () => {
  const cases = [
    { hot: videoHot({ features: { videoDescriptions: false } }), item: videoAttachment() },
    { hot: videoHot({ prompts: { 'describe-video': undefined } }), item: videoAttachment() },
    { hot: videoHot(), item: pictureItem('a1') },
  ];
  for (const { hot, item } of cases) {
    const { describer, llm, videoFetcher } = videoDescriber({ hot });
    assert.equal(await describer.describeVideo('g1', item), null);
    assert.equal(llm.calls.length, 0);
    assert.equal(videoFetcher.calls.length, 0);
  }
});

test('describeVideo: the text is collapsed to one line and capped at 600 chars on a word boundary', async () => {
  const long = `  Première   scène\n\nκάποιος χορεύει\t${'mot '.repeat(300)}`;
  const { describer } = videoDescriber({ llm: fakeLlm({ text: long }) });
  const { text } = await describer.describeVideo('g1', videoAttachment());

  assert.ok(text.startsWith('Première scène κάποιος χορεύει mot'));
  assert.ok(!/\s{2,}|[\n\t]/.test(text));
  assert.ok([...text].length <= 600);
  assert.ok(text.endsWith('mot'), 'cut at a word boundary');
});

test('describeVideo: an empty answer is an error miss', async () => {
  const { describer, store } = videoDescriber({ llm: fakeLlm({ text: '  \n ' }) });
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  assert.equal(store.getMediaCache('g1')['video:v1'].reason, 'error');
});

test('describeVideo: logs codes only -- never the text or a full URL', async () => {
  const { describer } = videoDescriber({ llm: fakeLlm({ text: 'a secret caption' }) });
  const { logs } = await withCapturedLogs(() => describer.describeVideo('g1', videoAttachment()));
  assert.ok(logs.some((line) => JSON.stringify(line).includes('describe: video')), 'one describe: video line');
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('a secret caption'));
  assert.ok(!all.includes('ex=secret'));
});

test('describeVideo: two concurrent calls for one video send one request', async () => {
  const { describer, llm, videoFetcher } = videoDescriber();
  const [a, b] = await Promise.all([
    describer.describeVideo('g1', videoAttachment()),
    describer.describeVideo('g1', videoAttachment()),
  ]);
  assert.equal(a.state, 'watched');
  assert.equal(b.state, 'watched');
  assert.equal(llm.calls.length, 1);
  assert.equal(videoFetcher.calls.length, 1);
});

// --- describeVideos ------------------------------------------------------

test('describeVideos: caps NEW requests at maxNew; cache hits and limit states are free', async () => {
  const { describer, llm, store } = videoDescriber({ llm: fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]) });
  await describer.describeVideo('g1', videoAttachment('v1'));
  store.getMediaCache('g1')['video:v0'] = { miss: true, ts: Date.now(), reason: 'length', durationSec: 600 };

  const items = [videoAttachment('v0'), videoAttachment('v1'), videoAttachment('v2'), videoAttachment('v3')];
  const { videos, newCount } = await describer.describeVideos('g1', items, { maxNew: 1 });

  assert.equal(newCount, 1);
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(videos.get('v0'), { state: 'limit', reason: 'length' });
  assert.equal(videos.get('v1').text, 'one');
  assert.equal(videos.get('v2').text, 'two');
  assert.ok(!videos.has('v3'), 'maxNew reached: v3 is neither watched nor cached');
});

test('describeVideos: past maxNew an already-watched video still comes from the cache', async () => {
  const { describer, llm } = videoDescriber({ llm: fakeLlm([{ text: 'old' }, { text: 'new' }]) });
  await describer.describeVideo('g1', videoAttachment('old'));

  const { videos, newCount } = await describer.describeVideos('g1', [videoAttachment('new'), videoAttachment('old')], {
    maxNew: 1,
  });
  assert.equal(newCount, 1);
  assert.equal(llm.calls.length, 2);
  assert.equal(videos.get('new').text, 'new');
  assert.equal(videos.get('old').text, 'old');
});

test('describeVideos: onCharge fires once per sent request, never for a cache hit or a failed fetch (which still counts as an attempt)', async () => {
  let n = 0;
  const videoFetcher = fakeVideoFetcher();
  videoFetcher.fetchAttachment = async (url) => {
    n += 1;
    return url.includes('broken')
      ? { ok: false, reason: 'download' }
      : { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 5, bytes: 4 };
  };
  const { describer } = videoDescriber({
    llm: fakeLlm([
      { text: 'one', usage: { prompt_tokens: 9 } },
      { text: 'two', usage: { prompt_tokens: 11 } },
    ]),
    videoFetcher,
  });
  await describer.describeVideo('g1', videoAttachment('v1'));

  const charges = [];
  const items = [
    videoAttachment('v1'),
    videoAttachment('vb', { url: 'https://cdn.discordapp.com/broken.mp4' }),
    videoAttachment('v2'),
  ];
  const { videos, newCount } = await describer.describeVideos('g1', items, { onCharge: (r) => charges.push(r) });

  assert.equal(newCount, 2, 'the failed fetch and the sent request are both attempts; the cache hit is not');
  assert.equal(charges.length, 1);
  assert.equal(charges[0].usage.prompt_tokens, 11);
  assert.deepEqual(videos.get('vb'), { state: 'error' });
  assert.equal(n, 3);
});

test('describeVideos: a failed fetch counts toward maxNew -- with maxNew 1 the next uncached item is never attempted', async () => {
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'timeout' } });
  const { describer, llm } = videoDescriber({ videoFetcher });

  const { videos, newCount } = await describer.describeVideos('g1', [videoAttachment('v1'), videoAttachment('v2')], {
    maxNew: 1,
  });

  assert.equal(newCount, 1);
  assert.equal(videoFetcher.calls.length, 1, 'v2 is never fetched');
  assert.equal(videoFetcher.calls[0].url, videoAttachment('v1').url);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(videos.get('v1'), { state: 'error' });
  assert.ok(!videos.has('v2'));
});

test('describeVideo: mediaDescriptions off with videoDescriptions on -> null and no fetcher call', async () => {
  const hot = videoHot({ features: { mediaDescriptions: false, videoDescriptions: true } });
  const { describer, llm, videoFetcher } = videoDescriber({ hot });

  assert.equal(await describer.describeVideo('g1', videoAttachment()), null);
  assert.equal(videoFetcher.calls.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('describeVideo: features.videoDescriptions absent counts as on (mediaDescriptions on) -> the video is watched', async () => {
  const hot = videoHot();
  delete hot.config.features.videoDescriptions;
  const { describer, llm, videoFetcher } = videoDescriber({ hot });

  assert.equal((await describer.describeVideo('g1', videoAttachment())).state, 'watched');
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(llm.calls.length, 1);
});

test('describeVideo: the daily slot is reserved before the fetch -- two concurrent new videos at cap-1 fetch once', async () => {
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 39 });
  const { describer, llm, videoFetcher } = videoDescriber({ state, now });

  const [a, b] = await Promise.all([
    describer.describeVideo('g1', videoAttachment('v1')),
    describer.describeVideo('g1', videoAttachment('v2')),
  ]);

  assert.equal(a.state, 'watched');
  assert.deepEqual(b, { state: 'limit', reason: 'daily' });
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.equal(state.data.videoCount, 40);
});

test('describeVideo: a fetch that fails after the reservation keeps its daily slot', async () => {
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 39 });
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } });
  const { describer, llm } = videoDescriber({ state, now, videoFetcher });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment('v1')), { state: 'error' });
  assert.equal(state.data.videoCount, 40);
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment('v2')), { state: 'limit', reason: 'daily' });
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(llm.calls.length, 0);
});

test('describeVideo: without a usable provider object a direct-URL site is downloaded, never sent by public URL', async () => {
  for (const provider of [null, undefined, 'google-ai-studio', ['pinned']]) {
    const { describer, llm, videoFetcher } = videoDescriber({ hot: videoHot({ video: { provider } }) });
    const result = await describer.describeVideo('g1', videoLink());

    assert.equal(result.state, 'watched');
    assert.deepEqual(
      videoFetcher.calls.map((c) => c.fn),
      ['probeSite', 'fetchSiteClip'],
      `provider ${JSON.stringify(provider)}`,
    );
    const body = JSON.stringify(llm.calls[0].messages);
    assert.ok(!body.includes('youtube.com'), 'only the data URL is sent');
    assert.ok(body.includes(CLIP_DATA_URL));
    assert.equal(llm.calls[0].options.provider, undefined);
  }
});

// --- the link chain: yt-dlp, then the YouTube probe, then the unknown-duration switch ---

const TIKTOK = { url: 'https://www.tiktok.com/@someone/video/123', site: 'tiktok.com' };
const PROBE_FAILED = { ok: false, reason: 'download' };
const LINK_KEY = 'video:video:url:0123456789abcdef';

test('describeVideo: yt-dlp fails on YouTube -> the page probe gives the duration -> the URL goes out pinned', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: PROBE_FAILED, youtube: { ok: true, durationSec: 42 } });
  const { describer, llm } = videoDescriber({ videoFetcher, youtubeApiKey: 'test-key' });

  const result = await describer.describeVideo('g1', videoLink());

  assert.equal(result.state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'probeYoutube']);
  assert.equal(videoFetcher.calls[1].url, 'https://www.youtube.com/watch?v=abc');
  assert.deepEqual(videoFetcher.calls[1].options, { fetchTimeoutMs: 10_000, apiKey: 'test-key' });
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 42);
});

test('describeVideo: the YouTube probe runs only when yt-dlp failed and only for a YouTube URL', async () => {
  const ok = fakeVideoFetcher({ youtube: { ok: true, durationSec: 42 } });
  await videoDescriber({ videoFetcher: ok }).describer.describeVideo('g1', videoLink());
  assert.deepEqual(ok.calls.map((c) => c.fn), ['probeSite']);

  const tiktok = fakeVideoFetcher({ probe: PROBE_FAILED, youtube: { ok: true, durationSec: 42 } });
  const { describer, llm } = videoDescriber({ videoFetcher: tiktok });
  assert.deepEqual(await describer.describeVideo('g1', videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK)), { state: 'error' });
  assert.deepEqual(tiktok.calls.map((c) => c.fn), ['probeSite']);
  assert.equal(llm.calls.length, 0);
});

test('describeVideo: without a YouTube key the probe gets apiKey null', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: PROBE_FAILED, youtube: { ok: true, durationSec: 42 } });
  await videoDescriber({ videoFetcher }).describer.describeVideo('g1', videoLink());
  assert.equal(videoFetcher.calls[1].options.apiKey, null);
});

test('describeVideo: every probe failed and directUrlUnknownDuration off (or not exactly true) -> error miss, no request', async () => {
  for (const directUrlUnknownDuration of [false, undefined, 'true', 1]) {
    const videoFetcher = fakeVideoFetcher({ probe: PROBE_FAILED });
    const { describer, llm, store } = videoDescriber({ videoFetcher, hot: videoHot({ video: { directUrlUnknownDuration } }) });

    assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'error' }, String(directUrlUnknownDuration));
    assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'probeYoutube']);
    assert.equal(llm.calls.length, 0);
    assert.equal(store.getMediaCache('g1')[LINK_KEY].reason, 'error');
  }
});

test('describeVideo: every probe failed and directUrlUnknownDuration on -> the URL goes out pinned with videoSeconds = maxSeconds', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: PROBE_FAILED });
  const { describer, llm } = videoDescriber({ videoFetcher, hot: videoHot({ video: { directUrlUnknownDuration: true } }) });

  const result = await describer.describeVideo('g1', videoLink());

  assert.equal(result.state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'probeYoutube']);
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 60);
});

test('describeVideo: directUrlUnknownDuration never sends a non-direct site or an unpinned URL', async () => {
  const on = videoHot({ video: { directUrlUnknownDuration: true } });
  const first = videoDescriber({ videoFetcher: fakeVideoFetcher({ probe: PROBE_FAILED }), hot: on });
  assert.deepEqual(await first.describer.describeVideo('g1', videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK)), { state: 'error' });
  assert.equal(first.llm.calls.length, 0);

  const second = videoDescriber({
    videoFetcher: fakeVideoFetcher({ probe: PROBE_FAILED }),
    hot: videoHot({ video: { directUrlUnknownDuration: true, provider: null } }),
  });
  assert.deepEqual(await second.describer.describeVideo('g1', videoLink()), { state: 'error' });
  assert.equal(second.llm.calls.length, 0);
});

test('describeVideo: longer than maxSeconds and the clip fails -> a permanent length limit, never retried', async () => {
  const setups = [
    { probe: { ok: true, durationSec: 600, title: null } },
    { probe: PROBE_FAILED, youtube: { ok: true, durationSec: 600 } },
  ];
  for (const setup of setups) {
    for (const reason of ['download', 'tool', 'timeout', 'size']) {
      let t = 1_000_000;
      const videoFetcher = fakeVideoFetcher({ ...setup, clip: { ok: false, reason } });
      const { describer, llm, store } = videoDescriber({ videoFetcher, now: () => t });

      assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'limit', reason: 'length' });
      assert.equal(store.getMediaCache('g1')[LINK_KEY].reason, 'length');
      const fetches = videoFetcher.calls.length;
      t += 30 * 24 * 60 * 60_000;
      assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'limit', reason: 'length' });
      assert.equal(videoFetcher.calls.length, fetches, 'the permanent miss is served from the cache');
      assert.equal(llm.calls.length, 0);
    }
  }
});

test('describeVideo: a clip failure of a video within maxSeconds (or of unknown length) stays an error miss', async () => {
  for (const durationSec of [30, null]) {
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec, title: null }, clip: { ok: false, reason: 'download' } });
    const { describer } = videoDescriber({ videoFetcher });
    assert.deepEqual(await describer.describeVideo('g1', videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK)), { state: 'error' });
  }
});

test('checkYoutube: the describer probes the configured canary through its own video fetcher and key', async () => {
  const hot = videoHot();
  hot.config.media.video.canaryUrl = 'https://www.youtube.com/watch?v=canary00001';
  const videoFetcher = fakeVideoFetcher({ probe: { ok: false, reason: 'download' }, youtube: { ok: true, durationSec: 19 } });
  const { describer, llm } = videoDescriber({ hot, videoFetcher, youtubeApiKey: 'AIzaSecretTestKey' });

  const result = await describer.checkYoutube();

  assert.equal(result.status, 'api');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'probeYoutube']);
  assert.equal(videoFetcher.calls[1].url, 'https://www.youtube.com/watch?v=canary00001');
  assert.equal(videoFetcher.calls[1].options.apiKey, 'AIzaSecretTestKey');
  assert.equal(llm.calls.length, 0, 'no LLM call');
});

// --- directUrlMaxSeconds and re-evaluated length misses ------------------

test('describeVideo: a direct-URL link of 120 s (within directUrlMaxSeconds) goes out pinned with videoSeconds 120', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite']);
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 120);
});

test('describeVideo: a direct-URL link of 200 s (over directUrlMaxSeconds) takes the clip route capped at maxSeconds', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 200, title: null } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'fetchSiteClip']);
  assert.equal(videoFetcher.calls[1].options.maxSeconds, 60);
  assert.equal(videoFetcher.calls[1].options.durationSec, 200);
  assert.equal(llm.calls[0].options.provider, undefined);
});

test('describeVideo: a 200 s direct-URL link whose clip fails is a length limit storing durationSec', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 200, title: null }, clip: { ok: false, reason: 'tool' } });
  const { describer, store } = videoDescriber({ videoFetcher, now: () => 5_000 });
  assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'limit', reason: 'length' });
  assert.deepEqual(store.getMediaCache('g1')[LINK_KEY], { miss: true, ts: 5_000, reason: 'length', durationSec: 200 });
});

test('describeVideo: a 120 s link on a non-direct site still takes the clip route', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  assert.equal((await describer.describeVideo('g1', videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK))).state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'fetchSiteClip']);
  assert.equal(videoFetcher.calls[1].options.maxSeconds, 60);
  assert.equal(llm.calls[0].options.provider, undefined);
});

test('describeVideo: a 120 s non-direct link whose clip fails stores a length miss with durationSec 120', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null }, clip: { ok: false, reason: 'download' } });
  const { describer, store } = videoDescriber({ videoFetcher, now: () => 7_000 });
  const item = videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK);
  assert.deepEqual(await describer.describeVideo('g1', item), { state: 'limit', reason: 'length' });
  assert.deepEqual(store.getMediaCache('g1')['video:video:url:bbbbbbbbbbbbbbbb'], {
    miss: true,
    ts: 7_000,
    reason: 'length',
    durationSec: 120,
  });
  // Still over maxSeconds for a non-direct site: served from the cache, no new fetch.
  assert.deepEqual(await describer.describeVideo('g1', item), { state: 'limit', reason: 'length' });
  assert.equal(videoFetcher.calls.length, 2);
});

test('describeVideo: a cached length miss with durationSec 120 is retried once the direct-URL cap allows it', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } });
  const { describer, store, llm } = videoDescriber({ videoFetcher });
  store.getMediaCache('g1')[LINK_KEY] = { miss: true, ts: 1, reason: 'length', durationSec: 120 };
  const result = await describer.describeVideo('g1', videoLink());
  assert.equal(result.state, 'watched');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.videoSeconds, 120);
  assert.equal(store.getMediaCache('g1')[LINK_KEY].watched, true);
});

test('describeVideo: a cached length miss is re-read against the live caps (maxSeconds raised for a non-direct site)', async () => {
  const hot = videoHot();
  const { describer, store, videoFetcher } = videoDescriber({ hot });
  const item = videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK);
  store.getMediaCache('g1')['video:video:url:bbbbbbbbbbbbbbbb'] = { miss: true, ts: 1, reason: 'length', durationSec: 120 };
  assert.deepEqual(await describer.describeVideo('g1', item), { state: 'limit', reason: 'length' });
  assert.equal(videoFetcher.calls.length, 0);
  hot.config.media.video.maxSeconds = 120;
  assert.equal((await describer.describeVideo('g1', item)).state, 'watched');
  assert.equal(videoFetcher.calls.length, 2);
});

test('describeVideo: a cached length miss with durationSec 200 stays a limit', async () => {
  for (const extra of [{ durationSec: 200 }]) {
    const { describer, store, videoFetcher, llm } = videoDescriber();
    store.getMediaCache('g1')[LINK_KEY] = { miss: true, ts: 1, reason: 'length', ...extra };
    assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'limit', reason: 'length' }, JSON.stringify(extra));
    assert.equal(videoFetcher.calls.length, 0);
    assert.equal(llm.calls.length, 0);
  }
});

test('describeVideo: a cached size miss stays permanent whatever its duration', async () => {
  const { describer, store, videoFetcher } = videoDescriber();
  store.getMediaCache('g1')[LINK_KEY] = { miss: true, ts: 1, reason: 'size', durationSec: 30 };
  assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'limit', reason: 'size' });
  assert.equal(videoFetcher.calls.length, 0);
});

test('describeVideo: a size miss is stored without durationSec', async () => {
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'size' } });
  const { describer, store } = videoDescriber({ videoFetcher, now: () => 9_000 });
  await describer.describeVideo('g1', videoAttachment());
  assert.deepEqual(store.getMediaCache('g1')['video:v1'], { miss: true, ts: 9_000, reason: 'size' });
});

test('describeVideo: every video request carries media.video.maxRequestTokens as its own pre-flight cap', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 180, title: null } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  assert.equal(llm.calls[0].options.videoSeconds, 180, '180 s is within directUrlMaxSeconds: sent pinned');
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.maxRequestTokens, 60_000);

  const clip = videoDescriber();
  await clip.describer.describeVideo('g1', videoAttachment());
  assert.equal(clip.llm.calls[0].options.maxRequestTokens, 60_000, 'a downloaded clip too');
});

test('describeVideo: a 180 s direct-URL video passes the video cap through the real client, while the 50 000 global cap alone would refuse it', async () => {
  const hot = videoHot();
  hot.config.media.video.tokensPerSecond = 300;
  hot.config.llm = {
    baseUrl: 'https://openrouter.test/api/v1',
    model: 'x/chat',
    temperature: 1,
    maxOutputTokens: 100,
    maxRequestTokens: 50_000,
    maxRequestsPerDay: 300,
    timeoutMs: 5_000,
    retries: 0,
  };
  const bodies = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => hot.config,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    state: { data: {}, markDirty() {} },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'someone dances' } }], usage: {} }) };
    },
  });
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 180, title: null } });
  const { describer } = videoDescriber({ hot, llm, videoFetcher });

  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  assert.equal(bodies.length, 1);

  const messages = [
    { role: 'system', content: VIDEO_PROMPT },
    { role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc' } }] },
  ];
  await assert.rejects(
    llm.complete(messages, { videoSeconds: 180, skipCalibration: true }),
    (err) => err instanceof TokenLimitError,
  );
  assert.equal(bodies.length, 1, 'the refused request never left the process');
});

test('describeVideo: a cached length miss with durationSec null or absent (an older entry) is retried', async () => {
  for (const extra of [{ durationSec: null }, {}]) {
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } });
    const { describer, store, llm } = videoDescriber({ videoFetcher });
    store.getMediaCache('g1')[LINK_KEY] = { miss: true, ts: 1, reason: 'length', ...extra };
    assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched', JSON.stringify(extra));
    assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite']);
    assert.equal(llm.calls.length, 1);
    assert.equal(store.getMediaCache('g1')[LINK_KEY].watched, true);
  }
});

// --- account length: media.video.summaryChars ------------------------------

test('describeVideo: the account is capped at media.video.summaryChars and {{maxChars}} is filled with it', async () => {
  const hot = videoHot({ video: { summaryChars: 40 }, prompts: { 'describe-video': 'Summarise in at most {{maxChars}} characters.' } });
  const { describer, llm } = videoDescriber({ hot, llm: fakeLlm({ text: `Première scène ${'mot '.repeat(50)}` }) });
  const { text } = await describer.describeVideo('g1', videoAttachment());

  assert.ok([...text].length <= 40, text);
  assert.ok(text.startsWith('Première scène mot'));
  assert.equal(llm.calls[0].messages[0].content, 'Summarise in at most 40 characters.');
});

test('describeVideo: a larger summaryChars keeps a longer account than the old 600-char cap', async () => {
  const long = 'mot '.repeat(300).trim();
  const { describer } = videoDescriber({ hot: videoHot({ video: { summaryChars: 1500 } }), llm: fakeLlm({ text: long }) });
  const { text } = await describer.describeVideo('g1', videoAttachment());
  assert.equal(text, long);
});

// --- rewatchVideo: the second look on a question ---------------------------------

const REWATCH_PROMPT = 'Question: {{question}}. At most {{maxChars}} characters.';
const REWATCH_CFG = { model: null, maxPerDay: 20, maxOutputTokens: 600, answerChars: 1200, recentMessages: 15 };

function rewatchHot({ features = {}, video = {}, rewatch = {}, prompts = {} } = {}) {
  return videoHot({
    features,
    video: { rewatch: { ...REWATCH_CFG, ...rewatch }, ...video },
    prompts: { 'rewatch-answer': REWATCH_PROMPT, ...prompts },
  });
}

function clock(start = Date.parse('2026-09-23T12:00:00Z')) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test('rewatchVideo: one fetch and one video request with the question and answerChars filled', async () => {
  const now = clock();
  const state = fakeState();
  const { describer, llm, videoFetcher, store } = videoDescriber({
    hot: rewatchHot(),
    llm: fakeLlm({ text: '  la voiture   est rouge ' }),
    state,
    now,
  });

  const result = await describer.rewatchVideo('g1', videoAttachment(), 'De quelle couleur est la voiture ?');

  assert.deepEqual(result, { question: 'De quelle couleur est la voiture ?', text: 'la voiture est rouge' });
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(videoFetcher.calls[0].fn, 'fetchAttachment');
  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.equal(system.content, 'Question: De quelle couleur est la voiture ?. At most 1200 characters.');
  assert.deepEqual(user.content, [{ type: 'video_url', video_url: { url: CLIP_DATA_URL } }]);
  const options = llm.calls[0].options;
  assert.equal(options.model, 'x/video-model', 'the second look uses media.video.model');
  assert.equal(options.maxOutputTokens, 600);
  assert.equal(options.maxRequestTokens, 60_000);
  assert.equal(options.videoSeconds, 12);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(state.data.rewatchCount, 1);
  assert.equal(state.data.videoCount, 1);
  const keys = Object.keys(store.getMediaCache('g1')).filter((k) => k.startsWith('video:v1:q:'));
  assert.equal(keys.length, 1);
  assert.equal(store.getMediaCache('g1')[keys[0]].answer, 'la voiture est rouge');
});

test('rewatchVideo: a pinnable link goes out by URL with the pinned provider, like a watch', async () => {
  const { describer, llm } = videoDescriber({ hot: rewatchHot() });
  await describer.rewatchVideo('g1', videoLink(), 'τι λέει στο τέλος;');
  assert.equal(llm.calls[0].messages[1].content[0].video_url.url, 'https://www.youtube.com/watch?v=abc');
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 30);
});

test('rewatchVideo: the answer is capped at rewatch.answerChars', async () => {
  const { describer } = videoDescriber({ hot: rewatchHot({ rewatch: { answerChars: 30 } }), llm: fakeLlm({ text: 'mot '.repeat(40) }) });
  const { text } = await describer.rewatchVideo('g1', videoAttachment(), 'q?');
  assert.ok([...text].length <= 30);
  assert.ok(text.endsWith('mot'));
});

test('rewatchVideo: the same question within an hour is free; after an hour it is asked again', async () => {
  const now = clock();
  const { describer, llm, videoFetcher, state } = videoDescriber({ hot: rewatchHot(), llm: fakeLlm({ text: 'rouge' }), now });

  await describer.rewatchVideo('g1', videoAttachment(), 'Quelle couleur ?');
  now.advance(59 * 60_000);
  const again = await describer.rewatchVideo('g1', videoAttachment(), '  quelle   COULEUR ? ');
  assert.equal(again.text, 'rouge');
  assert.equal(videoFetcher.calls.length, 1, 'a cached answer costs no fetch');
  assert.equal(llm.calls.length, 1);
  assert.equal(state.data.rewatchCount, 1);

  now.advance(2 * 60_000);
  await describer.rewatchVideo('g1', videoAttachment(), 'Quelle couleur ?');
  assert.equal(videoFetcher.calls.length, 2, 'past an hour the answer is stale');
  assert.equal(llm.calls.length, 2);
});

test('rewatchVideo: a failure is not cached -- the next call fetches again', async () => {
  const llm = fakeLlm([new Error('boom'), { text: 'rouge' }]);
  const { describer, videoFetcher, store } = videoDescriber({ hot: rewatchHot(), llm });

  assert.equal(await describer.rewatchVideo('g1', videoAttachment(), 'Quelle couleur ?'), null);
  assert.equal(Object.keys(store.getMediaCache('g1')).filter((k) => k.includes(':q:')).length, 0);
  assert.deepEqual(await describer.rewatchVideo('g1', videoAttachment(), 'Quelle couleur ?'), { question: 'Quelle couleur ?', text: 'rouge' });
  assert.equal(videoFetcher.calls.length, 2);
});

test('rewatchVideo: a full re-watch counter or a full video counter refuses without a fetch', async () => {
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const cases = [
    fakeState({ rewatchDay: '2026-09-23', rewatchCount: 20, videoDay: '2026-09-23', videoCount: 0 }),
    fakeState({ rewatchDay: '2026-09-23', rewatchCount: 0, videoDay: '2026-09-23', videoCount: 40 }),
  ];
  for (const state of cases) {
    const before = { ...state.data };
    const { describer, llm, videoFetcher } = videoDescriber({ hot: rewatchHot(), state, now });
    assert.equal(await describer.rewatchVideo('g1', videoAttachment(), 'q?'), null);
    assert.equal(videoFetcher.calls.length, 0);
    assert.equal(llm.calls.length, 0);
    assert.equal(state.data.rewatchCount, before.rewatchCount);
    assert.equal(state.data.videoCount, before.videoCount);
  }
});

test('rewatchVideo: the re-watch counter resets on a new day; a failed fetch keeps both slots', async () => {
  const now = () => Date.parse('2026-09-24T00:10:00Z');
  const state = fakeState({ rewatchDay: '2026-09-23', rewatchCount: 20 });
  const { describer } = videoDescriber({
    hot: rewatchHot(),
    state,
    now,
    videoFetcher: fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } }),
  });
  assert.equal(await describer.rewatchVideo('g1', videoAttachment(), 'q?'), null);
  assert.equal(state.data.rewatchDay, '2026-09-24');
  assert.equal(state.data.rewatchCount, 1);
  assert.equal(state.data.videoCount, 1);
});

test('rewatchVideo: feature off, video vision off, missing prompt, a non-video item or an empty question -> null, no fetch', async () => {
  const cases = [
    { hot: rewatchHot({ features: { videoRewatch: false } }), item: videoAttachment(), question: 'q?' },
    { hot: rewatchHot({ features: { videoDescriptions: false } }), item: videoAttachment(), question: 'q?' },
    { hot: rewatchHot({ prompts: { 'rewatch-answer': undefined } }), item: videoAttachment(), question: 'q?' },
    { hot: rewatchHot(), item: pictureItem('a1'), question: 'q?' },
    { hot: rewatchHot(), item: videoAttachment(), question: '   ' },
  ];
  for (const { hot, item, question } of cases) {
    const { describer, llm, videoFetcher } = videoDescriber({ hot });
    assert.equal(await describer.rewatchVideo('g1', item, question), null);
    assert.equal(videoFetcher.calls.length, 0);
    assert.equal(llm.calls.length, 0);
  }
});

test('rewatchVideo: logs one describe: rewatch line -- never the question, the answer or a full URL', async () => {
  const { describer } = videoDescriber({ hot: rewatchHot(), llm: fakeLlm({ text: 'a secret answer' }) });
  const { logs } = await withCapturedLogs(() => describer.rewatchVideo('g1', videoAttachment(), 'a secret question'));
  const line = logs.find((entry) => JSON.stringify(entry).includes('describe: rewatch'));
  assert.ok(line);
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('a secret answer'));
  assert.ok(!all.includes('a secret question'));
  assert.ok(!all.includes('ex=secret'));
});
