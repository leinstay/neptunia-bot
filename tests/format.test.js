// Tests for src/discord/format.js: pure transcript/time formatting. Every
// word comes from `labels` (tests/fixtures/labels.js is an English fixture
// covering the full prompt-contract key list); a second, non-English labels
// object proves nothing in the code is language-bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fill,
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
import { labels } from './fixtures/labels.js';

const TZ = 'Europe/Moscow'; // fixed UTC+3, no DST -- safe for exact arithmetic in tests
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// A handful of Cyrillic values proves the code never assumes English/labels
// language; only the values differ, the code path is identical.
const ruLabels = {
  ...labels,
  locale: 'ru-RU',
  self: '{name} (ты)',
  units: { lessThanMinute: 'меньше минуты', minute: 'мин', hour: 'ч', day: 'дн' },
  transcript: {
    ...labels.transcript,
    gap: '--- прошло {duration} ---',
    empty: '(пусто)',
  },
};

function msg(id, ts, overrides = {}) {
  return { id, ts, authorId: 'u1', authorName: 'Nick', content: 'text', ...overrides };
}

// --- fill --------------------------------------------------------------

test('fill: replaces {key} with the given value', () => {
  assert.equal(fill('{duration} passed', { duration: '5 min' }), '5 min passed');
});

test('fill: leaves unknown keys untouched', () => {
  assert.equal(fill('{duration} passed', {}), '{duration} passed');
});

test('fill: a missing/empty template returns an empty string', () => {
  assert.equal(fill(undefined, { duration: '5 min' }), '');
  assert.equal(fill('', { duration: '5 min' }), '');
  assert.equal(fill(null, {}), '');
});

// --- clock / date / now / localHour -------------------------------------

test('formatClock: renders the time converted into the given timezone and locale', () => {
  const ts = Date.UTC(2026, 8, 20, 10, 30, 0); // 10:30 UTC -> 13:30 Moscow
  assert.equal(formatClock(ts, TZ, 'en-US'), '13:30');
});

test('formatClock: crossing midnight in the target timezone', () => {
  const ts = Date.UTC(2026, 8, 19, 21, 5, 0); // 21:05 UTC Sep 19 -> 00:05 Moscow Sep 20
  assert.equal(formatClock(ts, TZ, 'en-US'), '00:05');
});

test('formatDate: uses the LOCAL date, not the UTC date', () => {
  const ts = Date.UTC(2026, 8, 19, 21, 5, 0); // UTC date is the 19th, Moscow date is the 20th
  assert.equal(formatDate(ts, TZ, 'en-US'), formatDate(Date.UTC(2026, 8, 20, 0, 5, 0), TZ, 'en-US'));
});

test('formatDate: locale changes the rendered wording', () => {
  const ts = Date.UTC(2026, 8, 20, 10, 30, 0);
  const en = formatDate(ts, TZ, 'en-US');
  const ru = formatDate(ts, TZ, 'ru-RU');
  assert.notEqual(en, ru);
});

test('formatNow: combines full date, clock and the timezone name', () => {
  const ts = Date.UTC(2026, 8, 20, 10, 30, 0);
  const now = formatNow(ts, TZ, 'en-US');
  assert.ok(now.includes('13:30'));
  assert.ok(now.includes('(Europe/Moscow)'));
});

test('localHour: returns the local hour 0-23 for the given timezone, locale-independent', () => {
  assert.equal(localHour(Date.UTC(2026, 8, 20, 10, 30, 0), TZ), 13);
  assert.equal(localHour(Date.UTC(2026, 8, 19, 21, 5, 0), TZ), 0);
});

// --- formatDuration boundaries -------------------------------------------

test('formatDuration: under a minute', () => {
  assert.equal(formatDuration(59_999, labels.units), 'less than a minute');
});

test('formatDuration: exactly one minute', () => {
  assert.equal(formatDuration(MIN, labels.units), '1 min');
});

test('formatDuration: minutes under an hour', () => {
  assert.equal(formatDuration(5 * MIN, labels.units), '5 min');
});

test('formatDuration: exactly one hour, no leftover minutes', () => {
  assert.equal(formatDuration(HOUR, labels.units), '1 h');
});

test('formatDuration: hours with leftover minutes (contract example)', () => {
  assert.equal(formatDuration(3 * HOUR + 12 * MIN, labels.units), '3 h 12 min');
});

test('formatDuration: exactly one day, no leftover hours', () => {
  assert.equal(formatDuration(DAY, labels.units), '1 d');
});

test('formatDuration: days with leftover hours (contract example)', () => {
  assert.equal(formatDuration(2 * DAY + 4 * HOUR, labels.units), '2 d 4 h');
});

test('formatDuration: rounding at 59 min 30s+ rolls over to the hour form, not "60 min"', () => {
  const text = formatDuration(59 * MIN + 30_000, labels.units);
  assert.equal(text, '1 h');
  assert.ok(!text.includes('60'));
});

test('formatDuration: rounding at 23 h 59.5 min rolls over to the day form, not "24 h"', () => {
  const text = formatDuration(23 * HOUR + 59 * MIN + 30_000, labels.units);
  assert.equal(text, '1 d');
  assert.ok(!text.includes('24'));
});

test('formatDuration: works with a non-English units object', () => {
  assert.equal(formatDuration(3 * HOUR + 12 * MIN, ruLabels.units), '3 ч 12 мин');
});

// --- formatTranscript: gap markers and date changes -----------------------

test('formatTranscript: no marker for a gap under the threshold, same day', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 5 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(!items[1].text.includes('passed'));
});

test('formatTranscript: a gap at/over the threshold gets a "passed" marker', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 25 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[1].text.startsWith('--- 25 min passed ---'));
});

test('formatTranscript: a gap exactly at the threshold also gets a marker (inclusive)', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 20 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[1].text.startsWith('--- 20 min passed ---'));
});

test('formatTranscript: a date change under the gap threshold gets a plain date marker', () => {
  const before = Date.UTC(2026, 8, 19, 20, 55, 0);
  const after = Date.UTC(2026, 8, 19, 21, 4, 0);
  const messages = [msg('a', before), msg('b', after)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  const expectedDate = formatDate(after, TZ, labels.locale);
  assert.ok(items[1].text.startsWith(`--- ${expectedDate} ---`));
});

test('formatTranscript: a gap over the threshold AND a date change combines both in one marker', () => {
  const before = Date.UTC(2026, 8, 19, 20, 0, 0);
  const after = Date.UTC(2026, 8, 19, 23, 12, 0); // gap 3h12m, day changes
  const messages = [msg('a', before), msg('b', after)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  const expectedDate = formatDate(after, TZ, labels.locale);
  assert.ok(items[1].text.startsWith(`--- 3 h 12 min passed · ${expectedDate} ---`));
});

test('formatTranscript: labels drive the wording even for non-English deployments', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0), msg('b', t0 + 25 * MIN)];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: ruLabels });
  assert.ok(items[1].text.startsWith('--- прошло 25 мин ---'));
});

// --- formatTranscript: line shape ------------------------------------------

test('formatTranscript: own lines use labels.self with {{name}} filled by selfName', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { self: true, content: 'hi' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
  });
  assert.ok(items[0].text.includes('Nept (you): hi'));
});

test('formatTranscript: a reply to a message inside the window shows its index', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: 'first' }), msg('b', t0 + MIN, { content: 'second', replyToId: 'a' })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[1].text.includes('(replying to #1)'));
});

test('formatTranscript: a reply to a message outside the window is marked as an old message', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('b', t0, { content: 'second', replyToId: 'missing-old-id' })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('(replying to an older message)'));
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
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[image]'));
  assert.ok(items[0].text.includes('[file: report.pdf]'));
  assert.ok(items[0].text.includes('[sticker: pepe]'));
});

test('formatTranscript: content longer than maxChars is truncated with an ellipsis', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { content: 'a'.repeat(10) })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 5,
    selfName: 'Nept',
    labels,
  });
  assert.ok(items[0].text.includes('aaaaa…'));
  assert.ok(!items[0].text.includes('aaaaaa'));
});

test('formatTranscript: mode "memory" drops the #index and adds the user id, omits reply markers', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { authorName: 'Nick', authorId: '42', content: 'hello', replyToId: 'ghost' })];
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  assert.ok(items[0].text.includes('Nick (id:42): hello'));
  assert.ok(!items[0].text.includes('#1'));
  assert.ok(!items[0].text.includes('replying'));
});

test('formatTranscript: mode "memory" for the persona\'s own line omits the id', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { self: true, content: 'hi' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  assert.ok(items[0].text.includes('Nept (you): hi'));
  assert.ok(!items[0].text.includes('(id:'));
});

// --- renderTranscript -------------------------------------------------------

test('renderTranscript: empty items render as labels.transcript.empty', () => {
  assert.equal(renderTranscript([], TZ, labels), '(empty)');
  assert.equal(renderTranscript([], TZ, ruLabels), '(пусто)');
});

test('renderTranscript: prefixes a date header taken from the first item', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { content: 'hi' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
  });
  const rendered = renderTranscript(items, TZ, labels);
  const expectedDate = formatDate(t0, TZ, labels.locale);
  assert.ok(rendered.startsWith(`=== ${expectedDate} ===\n`));
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

test('computeTempo: lastIsOwn reflects whether the very last message was the persona\'s', () => {
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

test('computeTempo: sinceOwnMs is null when the persona has never posted', () => {
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

test('renderTempo: >=4 messages in the last 10 min -> the "live" verdict', () => {
  const text = renderTempo(baseTempo({ last10min: 4 }), labels);
  assert.ok(text.includes(labels.tempo.verdictLive));
});

test('renderTempo: <4 in 10min but >=3 in the last hour -> the "slow" verdict', () => {
  const text = renderTempo(baseTempo({ last10min: 1, lastHour: 3 }), labels);
  assert.ok(text.includes(labels.tempo.verdictSlow));
});

test('renderTempo: below both thresholds -> the "dead" verdict', () => {
  const text = renderTempo(baseTempo({ last10min: 0, lastHour: 1 }), labels);
  assert.ok(text.includes(labels.tempo.verdictDead));
});

test('renderTempo: null silenceMs describes an empty channel', () => {
  const text = renderTempo(baseTempo({ silenceMs: null }), labels);
  assert.ok(text.includes(labels.tempo.emptyChannel));
});

test('renderTempo: hasTrigger phrases silence via silenceBeforeTrigger', () => {
  const text = renderTempo(baseTempo({ hasTrigger: true, silenceMs: 5 * MIN }), labels);
  assert.ok(text.includes('before the message that called you, the channel was silent for: 5 min'));
});

test('renderTempo: without a trigger, silence is phrased via lastMessageAgo', () => {
  const text = renderTempo(baseTempo({ hasTrigger: false, silenceMs: 5 * MIN }), labels);
  assert.ok(text.includes('the last message in the channel was: 5 min ago'));
});

test('renderTempo: mentions when the last own message went unanswered (no trigger)', () => {
  const text = renderTempo(baseTempo({ lastIsOwn: true, hasTrigger: false }), labels);
  assert.ok(text.includes(labels.tempo.ownUnanswered));
});

test('renderTempo: does not mention the unanswered line when there is a trigger', () => {
  const text = renderTempo(baseTempo({ lastIsOwn: true, hasTrigger: true }), labels);
  assert.ok(!text.includes(labels.tempo.ownUnanswered));
});

test('renderTempo: works with a non-English labels object', () => {
  const text = renderTempo(baseTempo({ last10min: 4 }), ruLabels);
  assert.ok(text.includes(ruLabels.tempo.verdictLive));
});
