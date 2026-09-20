// Tests for src/discord/format.js: pure transcript/time formatting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatClock,
  formatDate,
  formatNow,
  formatDuration,
  localHour,
  formatTranscript,
  renderTranscript,
  computeTempo,
  renderTempo,
} from '../src/discord/format.js';

const TZ = 'Europe/Moscow'; // fixed UTC+3, no DST -- safe for exact arithmetic in tests
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function msg(id, ts, overrides = {}) {
  return { id, ts, authorId: 'u1', authorName: 'Nick', content: 'text', ...overrides };
}

// --- clock / date / now / localHour -------------------------------------

test('formatClock: renders the time converted into the given timezone', () => {
  const ts = Date.UTC(2026, 8, 20, 10, 30, 0); // 10:30 UTC -> 13:30 Moscow
  assert.equal(formatClock(ts, TZ), '13:30');
});

test('formatClock: crossing midnight in the target timezone', () => {
  const ts = Date.UTC(2026, 8, 19, 21, 5, 0); // 21:05 UTC Sep 19 -> 00:05 Moscow Sep 20
  assert.equal(formatClock(ts, TZ), '00:05');
});

test('formatDate: renders weekday-short, day, long month in the target timezone', () => {
  const ts = Date.UTC(2026, 8, 20, 10, 30, 0);
  assert.equal(formatDate(ts, TZ), 'вс, 20 сентября');
});

test('formatDate: uses the LOCAL date, not the UTC date', () => {
  const ts = Date.UTC(2026, 8, 19, 21, 5, 0); // UTC date is the 19th, Moscow date is the 20th
  assert.equal(formatDate(ts, TZ), 'вс, 20 сентября');
});

test('formatNow: combines full date, clock and the timezone name', () => {
  const ts = Date.UTC(2026, 8, 20, 10, 30, 0);
  assert.equal(formatNow(ts, TZ), 'воскресенье, 20 сентября 2026 г., 13:30 (Europe/Moscow)');
});

test('localHour: returns the local hour 0-23 for the given timezone', () => {
  assert.equal(localHour(Date.UTC(2026, 8, 20, 10, 30, 0), TZ), 13);
  assert.equal(localHour(Date.UTC(2026, 8, 19, 21, 5, 0), TZ), 0);
});

// --- formatDuration boundaries -------------------------------------------

test('formatDuration: under a minute', () => {
  assert.equal(formatDuration(59_999), 'меньше минуты');
});

test('formatDuration: exactly one minute', () => {
  assert.equal(formatDuration(MIN), '1 мин');
});

test('formatDuration: minutes under an hour', () => {
  assert.equal(formatDuration(5 * MIN), '5 мин');
});

test('formatDuration: exactly one hour, no leftover minutes', () => {
  assert.equal(formatDuration(HOUR), '1 ч');
});

test('formatDuration: hours with leftover minutes (contract example)', () => {
  assert.equal(formatDuration(3 * HOUR + 12 * MIN), '3 ч 12 мин');
});

test('formatDuration: exactly one day, no leftover hours', () => {
  assert.equal(formatDuration(DAY), '1 дн');
});

test('formatDuration: days with leftover hours (contract example)', () => {
  assert.equal(formatDuration(2 * DAY + 4 * HOUR), '2 дн 4 ч');
});

// --- formatTranscript: gap markers and date changes -----------------------

test('formatTranscript: no marker for a gap under the threshold, same day', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 5 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Непка' });
  assert.ok(!items[1].text.includes('прошло'));
  assert.ok(!items[1].text.includes('==='.slice(0, 1))); // sanity: no marker lines injected
});

test('formatTranscript: a gap at/over the threshold gets a "прошло" marker', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 25 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Непка' });
  assert.ok(items[1].text.startsWith('--- прошло 25 мин ---'));
});

test('formatTranscript: a gap exactly at the threshold also gets a marker (inclusive)', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 20 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Непка' });
  assert.ok(items[1].text.startsWith('--- прошло 20 мин ---'));
});

test('formatTranscript: a date change under the gap threshold gets a plain date marker', () => {
  // 23:55 Moscow Sep19 -> 00:04 Moscow Sep20, a 9 minute gap (below the 20 min threshold)
  const before = Date.UTC(2026, 8, 19, 20, 55, 0);
  const after = Date.UTC(2026, 8, 19, 21, 4, 0);
  const messages = [msg('a', before), msg('b', after)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Непка' });
  assert.ok(items[1].text.startsWith('--- вс, 20 сентября ---'));
});

test('formatTranscript: a gap over the threshold AND a date change combines both in one marker', () => {
  const before = Date.UTC(2026, 8, 19, 20, 0, 0); // 23:00 Moscow Sep 19
  const after = Date.UTC(2026, 8, 19, 23, 12, 0); // 02:12 Moscow Sep 20 -- gap 3h12m
  const messages = [msg('a', before), msg('b', after)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Непка' });
  assert.ok(items[1].text.startsWith('--- прошло 3 ч 12 мин · вс, 20 сентября ---'));
});

// --- formatTranscript: line shape ------------------------------------------

test('formatTranscript: own lines use "<name> (ты)"', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { self: true, content: 'hi' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Непка',
  });
  assert.ok(items[0].text.includes('Непка (ты): hi'));
});

test('formatTranscript: a reply to a message inside the window shows its index', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: 'first' }), msg('b', t0 + MIN, { content: 'second', replyToId: 'a' })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Непка' });
  assert.ok(items[1].text.includes('(в ответ на #1)'));
});

test('formatTranscript: a reply to a message outside the window is marked as an old message', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('b', t0, { content: 'second', replyToId: 'missing-old-id' })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Непка' });
  assert.ok(items[0].text.includes('(в ответ на старое сообщение)'));
});

test('formatTranscript: attachments and stickers get tagged', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      attachments: [{ kind: 'image' }, { kind: 'file', name: 'report.pdf' }],
      stickers: ['pepe'],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Непка' });
  assert.ok(items[0].text.includes('[картинка]'));
  assert.ok(items[0].text.includes('[файл: report.pdf]'));
  assert.ok(items[0].text.includes('[стикер: pepe]'));
});

test('formatTranscript: content longer than maxChars is truncated with an ellipsis', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { content: 'a'.repeat(10) })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 5,
    selfName: 'Непка',
  });
  assert.ok(items[0].text.includes('aaaaa…'));
  assert.ok(!items[0].text.includes('aaaaaa'));
});

test('formatTranscript: mode "memory" drops the #index and adds the user id, omits reply markers', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { authorName: 'Nick', authorId: '42', content: 'hello', replyToId: 'ghost' }),
  ];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Непка',
    mode: 'memory',
  });
  assert.ok(items[0].text.includes('Nick (id:42): hello'));
  assert.ok(!items[0].text.includes('#1'));
  assert.ok(!items[0].text.includes('в ответ'));
});

test('formatTranscript: mode "memory" for her own line omits the id', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { self: true, content: 'hi' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Непка',
    mode: 'memory',
  });
  assert.ok(items[0].text.includes('Непка (ты): hi'));
  assert.ok(!items[0].text.includes('(id:'));
});

// --- renderTranscript -------------------------------------------------------

test('renderTranscript: empty items render as "(пусто)"', () => {
  assert.equal(renderTranscript([], TZ), '(пусто)');
});

test('renderTranscript: prefixes a date header taken from the first item', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { content: 'hi' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Непка',
  });
  const rendered = renderTranscript(items, TZ);
  assert.ok(rendered.startsWith('=== вс, 20 сентября ===\n'));
});

// --- computeTempo ------------------------------------------------------------

test('computeTempo: with a trigger, the trigger message itself is excluded from counts', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const m1 = msg('a', now - 5 * MIN);
  const trigger = msg('t', now);
  const tempo = computeTempo([m1, trigger], now, trigger);
  assert.equal(tempo.last10min, 1); // only m1, trigger excluded
  assert.equal(tempo.hasTrigger, true);
});

test('computeTempo: silence before the trigger is measured to the trigger, not to "now"', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const m1 = msg('a', now - 30 * MIN);
  const trigger = msg('t', now - 5 * MIN); // trigger happened 5 min ago, processed just now
  const tempo = computeTempo([m1, trigger], now, trigger);
  assert.equal(tempo.silenceMs, 25 * MIN); // trigger.ts - m1.ts, not now - m1.ts
});

test('computeTempo: without a trigger, silence is measured up to "now"', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const m1 = msg('a', now - 15 * MIN);
  const tempo = computeTempo([m1], now, null);
  assert.equal(tempo.silenceMs, 15 * MIN);
  assert.equal(tempo.hasTrigger, false);
});

test('computeTempo: silenceMs is null for an empty channel', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const tempo = computeTempo([], now, null);
  assert.equal(tempo.silenceMs, null);
});

test('computeTempo: authorsLastHour counts distinct non-self authors only', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const messages = [
    msg('a', now - 10 * MIN, { authorId: 'u1' }),
    msg('b', now - 20 * MIN, { authorId: 'u1' }),
    msg('c', now - 30 * MIN, { authorId: 'u2' }),
    msg('d', now - 40 * MIN, { self: true, authorId: 'self' }),
  ];
  const tempo = computeTempo(messages, now, null);
  assert.equal(tempo.authorsLastHour, 2);
});

test('computeTempo: lastIsOwn reflects whether the very last message was hers', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const messages = [msg('a', now - 20 * MIN), msg('b', now - 5 * MIN, { self: true })];
  const tempo = computeTempo(messages, now, null);
  assert.equal(tempo.lastIsOwn, true);
});

test('computeTempo: sinceOwnMs is measured from "now", even in trigger mode', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const own = msg('a', now - 60 * MIN, { self: true });
  const trigger = msg('t', now - 5 * MIN);
  const tempo = computeTempo([own, trigger], now, trigger);
  assert.equal(tempo.sinceOwnMs, 60 * MIN);
});

test('computeTempo: sinceOwnMs is null when she has never posted', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const tempo = computeTempo([msg('a', now - MIN)], now, null);
  assert.equal(tempo.sinceOwnMs, null);
});

// --- renderTempo -------------------------------------------------------------

function baseTempo(overrides = {}) {
  return {
    last10min: 0,
    lastHour: 0,
    lastDay: 0,
    authorsLastHour: 0,
    silenceMs: 10 * MIN,
    lastIsOwn: false,
    sinceOwnMs: null,
    hasTrigger: false,
    ...overrides,
  };
}

test('renderTempo: >=4 messages in the last 10 min -> "живой разговор"', () => {
  const text = renderTempo(baseTempo({ last10min: 4 }));
  assert.ok(text.includes('итог: живой разговор идёт прямо сейчас'));
});

test('renderTempo: <4 in 10min but >=3 in the last hour -> "вялый разговор"', () => {
  const text = renderTempo(baseTempo({ last10min: 1, lastHour: 3 }));
  assert.ok(text.includes('итог: вялый разговор, пишут редко'));
});

test('renderTempo: below both thresholds -> "мёртвый чат"', () => {
  const text = renderTempo(baseTempo({ last10min: 0, lastHour: 1 }));
  assert.ok(text.includes('итог: мёртвый чат'));
});

test('renderTempo: null silenceMs describes an empty channel', () => {
  const text = renderTempo(baseTempo({ silenceMs: null }));
  assert.ok(text.includes('канал пустой, до этого никто ничего не писал'));
});

test('renderTempo: hasTrigger phrases silence as "перед сообщением, которым тебя позвали"', () => {
  const text = renderTempo(baseTempo({ hasTrigger: true, silenceMs: 5 * MIN }));
  assert.ok(text.includes('перед сообщением, которым тебя позвали, в канале молчали: 5 мин'));
});

test('renderTempo: without a trigger, silence is phrased as "последнее сообщение ... было"', () => {
  const text = renderTempo(baseTempo({ hasTrigger: false, silenceMs: 5 * MIN }));
  assert.ok(text.includes('последнее сообщение в канале было: 5 мин назад'));
});

test('renderTempo: mentions when her own last message went unanswered (no trigger)', () => {
  const text = renderTempo(baseTempo({ lastIsOwn: true, hasTrigger: false }));
  assert.ok(text.includes('последнее сообщение в канале твоё, на него никто не ответил'));
});

test('renderTempo: does not mention the unanswered line when there is a trigger', () => {
  const text = renderTempo(baseTempo({ lastIsOwn: true, hasTrigger: true }));
  assert.ok(!text.includes('на него никто не ответил'));
});
