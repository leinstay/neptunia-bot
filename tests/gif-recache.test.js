// The owner's GIF recache (src/memory/gif-recache.js): which library
// entries a run re-describes and in what order, which one-frame captions of
// the media cache it drops, the caption counts of `/nep gifs status`, and the
// run itself on a real store, a fake describer and a fake discord.js client:
// the per-run cap, watched entries skipped, one run at a time, pause and
// warmup respected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGifRecache, gifCaptionCounts, gifCaptionState, oneFrameGifKeys, recacheQueue } from '../src/memory/gif-recache.js';
import { createStore } from '../src/memory/store.js';

const T0 = Date.UTC(2026, 8, 1);
const TENOR = (n) => `https://tenor.com/view/danse-${n}`;

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-gif-recache-'));
  return Promise.resolve()
    .then(() => fn(createStore({ dataDir: dir })))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

/** A library entry for a tenor GIF `n`, last seen in message `m<n>` of channel c1. */
function linkEntry(n, overrides = {}) {
  return {
    id: `g${n}`,
    kind: 'link',
    url: TENOR(n),
    site: 'Tenor',
    itemId: `m${n}#e0`,
    messageId: `m${n}`,
    channelId: 'c1',
    count: 1,
    last: T0,
    firstSeen: T0,
    ...overrides,
  };
}

function library(entries) {
  return { nextId: entries.length + 1, entries: Object.fromEntries(entries.map((entry) => [entry.itemId, entry])), backfill: null };
}

// --- pure helpers ------------------------------------------------------------

test('gifCaptionState: watched, failed, one-frame or none', () => {
  assert.equal(gifCaptionState({ text: 'a man runs', ts: 1, watched: true }), 'watched');
  assert.equal(gifCaptionState({ text: 'a still', ts: 1, gif: true, watchFailed: 5 }), 'failed');
  assert.equal(gifCaptionState({ miss: true, ts: 1, watchFailed: 5 }), 'failed');
  assert.equal(gifCaptionState({ text: 'a still', ts: 1 }), 'one-frame');
  assert.equal(gifCaptionState({ miss: true, ts: 1 }), 'none');
  assert.equal(gifCaptionState(undefined), 'none');
});

test('gifCaptionCounts: counts the library entries by their caption state', () => {
  const gifs = library([linkEntry(1), linkEntry(2), linkEntry(3), linkEntry(4), linkEntry(5)]);
  const cache = {
    'm1#e0': { text: 'watched', ts: 1, watched: true },
    'm2#e0': { text: 'a still', ts: 1 },
    'm3#e0': { text: 'a still', ts: 1, watchFailed: 3 },
    'm4#e0': { miss: true, ts: 1 },
    'x#e0': { text: 'not in the library', ts: 1 },
  };
  assert.deepEqual(gifCaptionCounts(gifs, cache), { watched: 1, 'one-frame': 1, failed: 1, none: 2 });
});

test('recacheQueue: never-described first, then oldest-described; watched skipped; capped', () => {
  const gifs = library([linkEntry(1), linkEntry(2), linkEntry(3), linkEntry(4), linkEntry(5)]);
  const cache = {
    'm1#e0': { text: 'a still', ts: 300 },
    'm2#e0': { text: 'watched', ts: 1, watched: true },
    'm3#e0': { text: 'a still', ts: 100 },
    'm4#e0': { text: 'a still', ts: 50, watchFailed: 400 },
  };
  assert.deepEqual(recacheQueue(gifs, cache, 10).map((entry) => entry.id), ['g5', 'g3', 'g1', 'g4']);
  assert.deepEqual(recacheQueue(gifs, cache, 2).map((entry) => entry.id), ['g5', 'g3']);
  assert.deepEqual(recacheQueue(gifs, cache, 0), []);
  assert.equal(recacheQueue(gifs, cache, 1)[0].key, 'm5#e0');
});

test('oneFrameGifKeys: one-frame GIF captions outside the library; never pictures, videos, watched or library ones', () => {
  const gifs = library([linkEntry(1)]);
  const cache = {
    'm1#e0': { text: 'library still', ts: 1 },
    'm9#e0': { text: 'embed still', ts: 1 },
    'm9#e1': { text: 'embed watched', ts: 1, watched: true, gif: true },
    'm8#e0': { miss: true, ts: 1 },
    '555': { text: 'attached gif still', ts: 1, gif: true },
    '556': { text: 'a picture', ts: 1 },
    'link:abc': { text: 'a thumbnail', ts: 1 },
    'video:777': { text: 'a video', ts: 1, watched: true },
    'video:m7#e0': { text: 'never a gif caption', ts: 1 },
  };
  assert.deepEqual(oneFrameGifKeys(cache, gifs).sort(), ['555', 'm9#e0']);
});

// --- the run -------------------------------------------------------------------

/** A raw discord.js message carrying one tenor gifv embed `n`. */
function rawGifMessage(n) {
  return {
    id: `m${n}`,
    channelId: 'c1',
    author: { id: 'u1', bot: false, username: 'u1' },
    cleanContent: '',
    createdTimestamp: T0,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    messageSnapshots: new Map(),
    embeds: [
      {
        url: TENOR(n),
        provider: { name: 'Tenor' },
        thumbnail: { url: `${TENOR(n)}/still.png` },
        video: { url: `${TENOR(n)}/loop.mp4` },
      },
    ],
  };
}

/** A client whose channel c1 serves `messages` by id; any other id throws like a deleted message. */
function fakeClient(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const channel = {
    messages: {
      fetch: async (id) => {
        if (!byId.has(id)) throw new Error('Unknown Message');
        return byId.get(id);
      },
    },
  };
  return { user: { id: 'self' }, channels: { fetch: async (id) => (id === 'c1' ? channel : null) } };
}

/** A describer whose watchGif follows `outcome(item)` (watched by default) and writes the watched caption. */
function fakeDescriber(store, { outcome, blocker = null, gate } = {}) {
  const calls = [];
  return {
    calls,
    gifWatchBlocker: () => blocker,
    async watchGif(guildId, item, opts) {
      calls.push({ guildId, item, opts });
      if (gate) await gate();
      const result = outcome ? outcome(item) : { state: 'watched', text: `watched ${item.itemId}` };
      if (result.state === 'watched') store.getMediaCache(guildId)[item.itemId] = { text: result.text, ts: T0, watched: true, gif: true };
      return result;
    },
  };
}

function fakeHot(gifs = {}) {
  return { config: { media: { embedTextChars: 200 }, gifs: { recachePerRun: 50, ...gifs } } };
}

function silentLog() {
  const entries = [];
  const push = (level) => (message, fields) => entries.push({ level, message, fields });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

function seed(store, entries, cache = {}) {
  store.recordGifs('g1', []);
  const gifs = store.getGifs('g1');
  Object.assign(gifs, library(entries));
  Object.assign(store.getMediaCache('g1'), cache);
}

test('gif recache: drops one-frame captions at once, then watches at most recachePerRun entries, oldest first, from a fresh read', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1), linkEntry(2), linkEntry(3)], {
      'm1#e0': { text: 'a still', ts: 300 },
      'm2#e0': { text: 'a still', ts: 100 },
      'x9#e0': { text: 'a stray still', ts: 1, gif: true },
      '556': { text: 'a picture', ts: 1 },
    });
    const describer = fakeDescriber(store);
    const recache = createGifRecache({
      hot: fakeHot({ recachePerRun: 2 }),
      store,
      client: fakeClient([rawGifMessage(1), rawGifMessage(2), rawGifMessage(3)]),
      describer,
      log: silentLog(),
    });

    const started = recache.start('g1');
    assert.deepEqual(started, { ok: true, dropped: 1, queued: 2 });
    assert.equal(store.getMediaCache('g1')['x9#e0'], undefined, 'the stray one-frame caption is dropped, not re-described');
    assert.equal(store.getMediaCache('g1')['556'].text, 'a picture');
    assert.equal(recache.isRunning(), true);
    await recache.waitIdle();
    assert.equal(recache.isRunning(), false);

    assert.deepEqual(describer.calls.map((c) => c.item.itemId), ['m3#e0', 'm2#e0'], 'never described first, then the oldest');
    const [first] = describer.calls;
    assert.equal(first.item.kind, 'gif');
    assert.equal(first.item.animationUrl, `${TENOR(3)}/loop.mp4`, 'the animation comes from the message read again');
    assert.equal(first.opts, undefined, 'every describer request counts: no option to say so');
    assert.equal(store.getMediaCache('g1')['m1#e0'].text, 'a still', 'past the cap: left for the next run');
  });
});

test('gif recache: a second run skips what the first watched and continues with the rest', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1), linkEntry(2), linkEntry(3)]);
    const describer = fakeDescriber(store);
    const recache = createGifRecache({
      hot: fakeHot({ recachePerRun: 2 }),
      store,
      client: fakeClient([rawGifMessage(1), rawGifMessage(2), rawGifMessage(3)]),
      describer,
      log: silentLog(),
    });
    recache.start('g1');
    await recache.waitIdle();
    assert.deepEqual(recache.start('g1'), { ok: true, dropped: 0, queued: 1 });
    await recache.waitIdle();
    assert.deepEqual(describer.calls.map((c) => c.item.itemId), ['m1#e0', 'm2#e0', 'm3#e0']);
    assert.deepEqual(gifCaptionCounts(store.getGifs('g1'), store.getMediaCache('g1')), { watched: 3, 'one-frame': 0, failed: 0, none: 0 });
    assert.deepEqual(recache.start('g1'), { ok: true, dropped: 0, queued: 0 });
    await recache.waitIdle();
  });
});

test('gif recache: a GIF whose message is gone still goes to the describer, which fails it as source', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1)]);
    const describer = fakeDescriber(store, { outcome: (item) => (item.animationUrl ? { state: 'watched', text: 'x' } : { state: 'failed', reason: 'source' }) });
    const log = silentLog();
    const recache = createGifRecache({ hot: fakeHot(), store, client: fakeClient([]), describer, log });
    recache.start('g1');
    await recache.waitIdle();
    assert.deepEqual(describer.calls[0].item, { itemId: 'm1#e0', kind: 'gif' });
    const done = log.entries.find((e) => e.message === 'gif-recache: done');
    assert.deepEqual(done.fields, { watched: 0, failed: 1, queued: 1, stopped: null });
  });
});

test('gif recache: one run at a time', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1)]);
    let release;
    const gate = () => new Promise((resolve) => {
      release = resolve;
    });
    const recache = createGifRecache({
      hot: fakeHot(),
      store,
      client: fakeClient([rawGifMessage(1)]),
      describer: fakeDescriber(store, { gate }),
      log: silentLog(),
    });
    assert.equal(recache.start('g1').ok, true);
    assert.deepEqual(recache.start('g1'), { ok: false, reason: 'running' });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    release();
    await recache.waitIdle();
    assert.equal(recache.start('g1').ok, true);
    await recache.waitIdle();
  });
});

test('gif recache: refused while paused, during a warmup, without a describer or while GIFs are not watched -- nothing dropped', async () => {
  await withStore(async (store) => {
    seed(store, [linkEntry(1)], { 'x9#e0': { text: 'a stray still', ts: 1, gif: true } });
    const base = { hot: fakeHot(), store, client: fakeClient([]), log: silentLog() };

    assert.deepEqual(createGifRecache({ ...base, describer: fakeDescriber(store), isWarmingUp: () => true }).start('g1'), {
      ok: false,
      reason: 'warmup',
    });
    assert.deepEqual(createGifRecache({ ...base }).start('g1'), { ok: false, reason: 'unavailable' });
    for (const blocker of ['off', 'video-off', 'no-prompt']) {
      assert.deepEqual(createGifRecache({ ...base, describer: fakeDescriber(store, { blocker }) }).start('g1'), { ok: false, reason: blocker });
    }
    store.state.data.paused = true;
    assert.deepEqual(createGifRecache({ ...base, describer: fakeDescriber(store) }).start('g1'), { ok: false, reason: 'paused' });
    assert.equal(store.getMediaCache('g1')['x9#e0'].text, 'a stray still');
  });
});

test('gif recache: a run stops before the next GIF once paused, a warmup starts or a daily rail is spent', async () => {
  for (const stop of ['paused', 'warmup', 'daily']) {
    await withStore(async (store) => {
      seed(store, [linkEntry(1), linkEntry(2), linkEntry(3)]);
      let warming = false;
      const describer = fakeDescriber(store, {
        outcome: (item) => {
          if (stop === 'paused') store.state.data.paused = true;
          if (stop === 'warmup') warming = true;
          if (stop === 'daily') return { state: 'unavailable', reason: 'daily' };
          return { state: 'watched', text: `watched ${item.itemId}` };
        },
      });
      const log = silentLog();
      const recache = createGifRecache({
        hot: fakeHot(),
        store,
        client: fakeClient([rawGifMessage(1), rawGifMessage(2), rawGifMessage(3)]),
        describer,
        isWarmingUp: () => warming,
        log,
      });
      recache.start('g1');
      await recache.waitIdle();
      assert.equal(describer.calls.length, 1, `${stop}: only the GIF in flight`);
      assert.equal(log.entries.find((e) => e.message === 'gif-recache: done').fields.stopped, stop);
    });
  }
});
