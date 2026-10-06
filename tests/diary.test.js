// Tests for src/behavior/diary.js (the diary scheduler's pure core: the day
// plan, due slots, kind choice, plan validation, the <diary> / <kinds> /
// <seeds> renderings, URL stripping, gists) and the store's diary file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  localDayKey,
  planDay,
  dueSlot,
  pickKind,
  validatePlan,
  renderDiaryBlock,
  renderKindsBlock,
  parseSeedFamilies,
  pickSeeds,
  renderSeedsBlock,
  stripUrls,
  gistOf,
} from '../src/behavior/diary.js';
import { localHour } from '../src/discord/format.js';
import { MINUTE_MS, HOUR_MS } from '../src/time.js';
import { labels } from './fixtures/labels.js';
import { createStore } from '../src/memory/store.js';

const seq = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const base = { quietDayChance: 0, minGapMinutes: 0, maxPerDay: 10 };

test('localDayKey: the local date of the zone, not the UTC one', () => {
  const t = Date.parse('2026-03-10T23:30:00Z');
  assert.equal(localDayKey(t, 'UTC'), '2026-03-10');
  assert.equal(localDayKey(t, 'Europe/Athens'), '2026-03-11');
});

test('planDay: a window crossing midnight stays inside it in Europe/Athens', () => {
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  const cfg = { ...base, windows: [{ from: 18, to: 1, posts: [2, 2] }] };
  for (const values of [[0.5, 0.5, 0, 0.999], [0.5, 0.5, 0.95, 0.99], [0.5, 0.5, 0.1, 0.6]]) {
    const plan = planDay(cfg, nowMs, 'Europe/Athens', seq(values));
    assert.equal(plan.day, '2026-03-10');
    assert.equal(plan.quiet, false);
    assert.deepEqual(plan.done, []);
    assert.equal(plan.slots.length, 2);
    for (const slot of plan.slots) {
      const hour = localHour(slot, 'Europe/Athens');
      assert.ok(hour >= 18 || hour < 1, `local hour ${hour}`);
      if (hour >= 18) assert.equal(localDayKey(slot, 'Europe/Athens'), '2026-03-10');
      else assert.equal(localDayKey(slot, 'Europe/Athens'), '2026-03-11');
    }
    assert.ok(plan.slots[0] <= plan.slots[1]);
  }
});

test('planDay: posts count is drawn per window and capped by maxPerDay', () => {
  const cfg = {
    ...base,
    maxPerDay: 2,
    windows: [
      { from: 7, to: 9, posts: [1, 1] },
      { from: 12, to: 14, posts: [1, 1] },
      { from: 18, to: 20, posts: [1, 1] },
    ],
  };
  const plan = planDay(cfg, Date.parse('2026-03-10T05:00:00Z'), 'UTC', seq([0.5]));
  assert.equal(plan.slots.length, 2);
});

test('planDay: the count is drawn inside the window range', () => {
  const cfg = { ...base, windows: [{ from: 12, to: 16, posts: [0, 2] }] };
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  assert.equal(planDay(cfg, nowMs, 'UTC', seq([0.5, 0, 0.5])).slots.length, 0);
  assert.equal(planDay(cfg, nowMs, 'UTC', seq([0.5, 0.99, 0.2, 0.8])).slots.length, 2);
});

test('planDay: minGapMinutes drops a slot too close to another', () => {
  const cfg = { ...base, minGapMinutes: 90, windows: [{ from: 12, to: 16, posts: [2, 2] }] };
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  // quiet roll, count roll, then two placements 10 minutes apart in a 240-minute window
  const plan = planDay(cfg, nowMs, 'UTC', seq([0.5, 0.5, 0.5, 0.5 + 10 / 240]));
  assert.equal(plan.slots.length, 1);
  const spread = planDay(cfg, nowMs, 'UTC', seq([0.5, 0.5, 0.1, 0.9]));
  assert.equal(spread.slots.length, 2);
});

test('planDay: a quiet day has no slots', () => {
  const cfg = { ...base, quietDayChance: 0.3, windows: [{ from: 12, to: 16, posts: [1, 1] }] };
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  const quiet = planDay(cfg, nowMs, 'UTC', seq([0.1, 0.5]));
  assert.equal(quiet.quiet, true);
  assert.deepEqual(quiet.slots, []);
  assert.equal(quiet.day, '2026-03-10');
  const busy = planDay(cfg, nowMs, 'UTC', seq([0.9, 0.5]));
  assert.equal(busy.quiet, false);
  assert.equal(busy.slots.length, 1);
});

test('planDay: [0, 0] windows produce nothing', () => {
  const cfg = { ...base, windows: [{ from: 7, to: 11, posts: [0, 0] }, { from: 12, to: 16, posts: [0, 0] }] };
  const plan = planDay(cfg, Date.parse('2026-03-10T05:00:00Z'), 'UTC', seq([0.5, 0.99]));
  assert.deepEqual(plan.slots, []);
  assert.equal(plan.quiet, false);
});

test('planDay: no windows produce nothing', () => {
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  assert.deepEqual(planDay({ ...base, windows: [] }, nowMs, 'UTC', seq([0.5])).slots, []);
  assert.deepEqual(planDay({ ...base }, nowMs, 'UTC', seq([0.5])).slots, []);
});

test('planDay: a slot already past at planning time is kept', () => {
  const cfg = { ...base, windows: [{ from: 7, to: 9, posts: [1, 1] }] };
  const nowMs = Date.parse('2026-03-10T15:00:00Z');
  const plan = planDay(cfg, nowMs, 'UTC', seq([0.5, 0.5, 0.5]));
  assert.deepEqual(plan.slots, [Date.parse('2026-03-10T08:00:00Z')]);
});

test('dueSlot: returns the first not-done slot within the grace', () => {
  const t = Date.parse('2026-03-10T15:00:00Z');
  const plan = { slots: [t - 20 * MINUTE_MS, t - 5 * MINUTE_MS, t + 10 * MINUTE_MS], done: [t - 20 * MINUTE_MS] };
  assert.deepEqual(dueSlot(plan, t, 30), { slot: t - 5 * MINUTE_MS, dropped: [] });
  assert.equal(dueSlot({ slots: [t + MINUTE_MS], done: [] }, t, 30), null);
  assert.equal(dueSlot({ slots: [t - MINUTE_MS], done: [t - MINUTE_MS] }, t, 30), null);
});

test('dueSlot: a slot older than the grace is dropped, not fired', () => {
  const t = Date.parse('2026-03-10T15:00:00Z');
  const plan = { slots: [t - 60 * MINUTE_MS, t - 5 * MINUTE_MS, t + 10 * MINUTE_MS], done: [] };
  assert.deepEqual(dueSlot(plan, t, 30), { slot: t - 5 * MINUTE_MS, dropped: [t - 60 * MINUTE_MS] });
  const missed = { slots: [t - 3 * HOUR_MS, t - 2 * HOUR_MS], done: [] };
  assert.deepEqual(dueSlot(missed, t, 30), { slot: null, dropped: [t - 3 * HOUR_MS, t - 2 * HOUR_MS] });
});

test('pickKind: weights zero are never chosen', () => {
  const kinds = { a: 0, b: 1, c: 0, d: 3 };
  for (const r of [0, 0.1, 0.24, 0.25, 0.5, 0.999]) {
    const kind = pickKind(kinds, () => r);
    assert.ok(kind === 'b' || kind === 'd', `${r} -> ${kind}`);
  }
  assert.equal(pickKind(kinds, () => 0.1), 'b');
  assert.equal(pickKind(kinds, () => 0.9), 'd');
});

test('pickKind: null when all weights are zero', () => {
  assert.equal(pickKind({ a: 0, b: 0 }, () => 0.5), null);
  assert.equal(pickKind({}, () => 0.5), null);
  assert.equal(pickKind(null, () => 0.5), null);
});

const kinds = { selfPicture: 3, thought: 2, news: 2, meme: 0 };
const opts = { pictureAllowed: true, searchKinds: ['news', 'facts'] };

test('validatePlan: accepts a well-formed answer', () => {
  const plan = validatePlan({ kind: 'news', brief: 'a find about trains', search: 'night trains', picture: false }, kinds, opts, () => 0.5);
  assert.deepEqual(plan, { kind: 'news', brief: 'a find about trains', search: 'night trains', picture: false, fallback: false });
  const drawn = validatePlan({ kind: 'selfPicture', brief: 'Ελένη on a pier', picture: true }, kinds, opts, () => 0.5);
  assert.deepEqual(drawn, { kind: 'selfPicture', brief: 'Ελένη on a pier', search: '', picture: true, fallback: false });
});

test('validatePlan: falls back to a weighted kind', () => {
  for (const parsed of [null, 'garbage', { kind: 'nope', brief: 'x' }, { kind: 'meme', brief: 'x', search: 'y' }]) {
    const plan = validatePlan(parsed, kinds, opts, () => 0);
    assert.equal(plan.fallback, true);
    assert.equal(plan.kind, 'selfPicture');
    assert.equal(plan.brief, '');
    assert.equal(plan.search, '');
  }
  assert.equal(validatePlan(null, { a: 0 }, opts, () => 0).kind, null);
});

test('validatePlan: search is cleared for a kind outside searchKinds', () => {
  const plan = validatePlan({ kind: 'thought', brief: 'b', search: 'q', picture: false }, kinds, opts, () => 0.5);
  assert.equal(plan.search, '');
  assert.equal(plan.fallback, false);
});

test('validatePlan: picture forced false when not allowed', () => {
  const plan = validatePlan({ kind: 'selfPicture', brief: 'b', picture: true }, kinds, { ...opts, pictureAllowed: false }, () => 0.5);
  assert.equal(plan.picture, false);
  assert.equal(validatePlan({ kind: 'thought', picture: 'yes' }, kinds, opts, () => 0.5).picture, false);
});

test('validatePlan: a long brief is cut to one line', () => {
  const plan = validatePlan({ kind: 'thought', brief: `line one\nline two ${'word '.repeat(100)}` }, kinds, opts, () => 0.5);
  assert.ok(!plan.brief.includes('\n'));
  assert.ok([...plan.brief].length <= 300);
});

test('renderDiaryBlock: oldest first, at most max lines, picture suffix when present', () => {
  const posts = [
    { at: Date.parse('2026-03-01T10:00:00Z'), kind: 'status', gist: 'oldest', picture: null },
    { at: Date.parse('2026-03-02T10:00:00Z'), kind: null, gist: 'from the backfill', picture: true },
    { at: Date.parse('2026-03-03T22:30:00Z'), kind: 'selfPicture', gist: 'on the pier', picture: 'a pier at dusk' },
    { at: Date.parse('2026-03-04T10:00:00Z'), kind: 'thought', gist: 'café thoughts', picture: null },
  ];
  const text = renderDiaryBlock(posts, labels, { timezone: 'Europe/Athens', max: 3 });
  assert.equal(text, [
    'Your latest diary posts, oldest first:',
    '- 2026-03-02 post: from the backfill [picture: not recorded]',
    '- 2026-03-04 selfPicture: on the pier [picture: a pier at dusk]',
    '- 2026-03-04 thought: café thoughts',
  ].join('\n'));
  assert.equal(renderDiaryBlock([], labels, { timezone: 'UTC', max: 3 }), '');
});

test('renderKindsBlock: counts uses among the last window posts', () => {
  const posts = [{ kind: 'thought' }, { kind: 'thought' }, { kind: 'news' }, { kind: 'thought' }, { kind: null }];
  const text = renderKindsBlock({ thought: 2, news: 1, meme: 0 }, posts, labels, { window: 3 });
  assert.equal(text, [
    'Post kinds and their recent use:',
    'thought weight 2, used 1 of the last 3',
    'news weight 1, used 1 of the last 3',
  ].join('\n'));
  assert.equal(
    renderKindsBlock({ thought: 2 }, [], labels, { window: 150 }),
    'Post kinds and their recent use:\nthought weight 2, used 0 of the last 0',
  );
  assert.equal(renderKindsBlock({ meme: 0 }, posts, labels, { window: 3 }), '');
});

test('parseSeedFamilies: splits by # headers and ignores blanks', () => {
  const text = 'loose line\n\n# place\na pier\n\n  an alley  \n# mood\n\n# twist\nrain\n';
  assert.deepEqual(parseSeedFamilies(text), { seed: ['loose line'], place: ['a pier', 'an alley'], mood: [], twist: ['rain'] });
  assert.deepEqual(parseSeedFamilies(''), {});
  assert.deepEqual(parseSeedFamilies(null), {});
});

test('pickSeeds: one line per family per set, in header order', () => {
  const families = { place: ['a pier', 'an alley'], twist: ['rain', 'fog', 'snow'] };
  assert.deepEqual(pickSeeds(families, 2, seq([0, 0.99, 0.6, 0.1])), [['a pier', 'snow'], ['an alley', 'rain']]);
});

test('pickSeeds: empty families are skipped', () => {
  assert.deepEqual(pickSeeds({ place: [], twist: ['rain'] }, 1, () => 0.5), [['rain']]);
  assert.deepEqual(pickSeeds({ place: [] }, 2, () => 0.5), []);
  assert.deepEqual(pickSeeds({ place: ['a pier'] }, 0, () => 0.5), []);
});

test('renderSeedsBlock: one line per set', () => {
  assert.equal(
    renderSeedsBlock([['a pier', 'rain'], ['an alley', 'fog']], labels),
    'Random seeds (place; setting; detail; activity; subject; twist):\n- a pier; rain\n- an alley; fog',
  );
  assert.equal(renderSeedsBlock([], labels), '');
});

test('stripUrls: removes links and keeps the words around them', () => {
  assert.equal(stripUrls('see https://a.b/c now'), 'see now');
  assert.equal(stripUrls('http://x.y at the start'), 'at the start');
  assert.equal(stripUrls('line one <https://a.b>\nline two'), 'line one\nline two');
  assert.equal(stripUrls('no links, señor'), 'no links, señor');
});

test('gistOf: one line cut at a word boundary', () => {
  assert.equal(gistOf('short\n\npost', 200), 'short post');
  const gist = gistOf('alpha beta gamma delta', 13);
  assert.equal(gist, 'alpha beta');
});

// ---- store: the diary file (data/guilds/<id>/diary.json) ----

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-diary-'));
}

const post = (n) => ({ at: n * 1000, kind: 'status', gist: `post ${n}`, picture: null, messageIds: [`m${n}`], search: '' });

test('store: getDiary returns the empty default', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  assert.deepEqual(store.getDiary('g1'), { posts: [], updatedAt: 0 });
});

test('store: appendDiaryPost keeps the newest max posts and stamps updatedAt', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  for (let n = 1; n <= 4; n += 1) store.appendDiaryPost('g1', post(n), { max: 3, now: 5000 + n });
  const diary = store.getDiary('g1');
  assert.deepEqual(diary.posts.map((p) => p.gist), ['post 2', 'post 3', 'post 4']);
  assert.equal(diary.updatedAt, 5004);
  diary.posts.length = 0; // a copy: changing it changes nothing stored
  assert.equal(store.getDiary('g1').posts.length, 3);
});

test('store: setDiaryPosts replaces the list and keeps the newest max', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.appendDiaryPost('g1', post(1), { max: 10, now: 1 });
  store.setDiaryPosts('g1', [post(5), post(6), post(7)], { max: 2, now: 9 });
  const diary = store.getDiary('g1');
  assert.deepEqual(diary.posts.map((p) => p.gist), ['post 6', 'post 7']);
  assert.equal(diary.updatedAt, 9);
});

test('store: diary survives flush and reload', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.appendDiaryPost('g1', { ...post(1), gist: 'Ελένη at the café' }, { max: 150, now: 42 });
  store.flush();
  assert.ok(fs.existsSync(path.join(dir, 'guilds', 'g1', 'diary.json')));
  const again = createStore({ dataDir: dir });
  assert.deepEqual(again.getDiary('g1'), { posts: [{ ...post(1), gist: 'Ελένη at the café' }], updatedAt: 42 });
});

test('store: a malformed diary file reads as the empty default', () => {
  const dir = tmpDataDir();
  fs.mkdirSync(path.join(dir, 'guilds', 'g1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'guilds', 'g1', 'diary.json'), '[1, 2]');
  assert.deepEqual(createStore({ dataDir: dir }).getDiary('g1'), { posts: [], updatedAt: 0 });
});
