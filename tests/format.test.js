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

// A handful of non-Latin (Greek) values proves the code never assumes
// English/labels language; only the values differ, the code path is identical.
const grLabels = {
  ...labels,
  locale: 'el-GR',
  self: '{name} (εσύ)',
  units: { lessThanMinute: 'λιγότερο από ένα λεπτό', minute: 'λεπτό', hour: 'ώρα', day: 'μέρα' },
  transcript: {
    ...labels.transcript,
    gap: '--- πέρασαν {duration} ---',
    empty: '(κενό)',
  },
};

function msg(id, ts, overrides = {}) {
  return { id, ts, authorId: 'u1', authorName: 'Nick', content: 'text', channelId: 'c1', channelName: 'general', ...overrides };
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
  assert.equal(formatDuration(3 * HOUR + 12 * MIN, grLabels.units), '3 ώρα 12 λεπτό');
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
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: grLabels });
  assert.ok(items[1].text.startsWith('--- πέρασαν 25 λεπτό ---'));
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

test('formatTranscript: a media tag rendering empty (missing label key) never leaves a double space', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const noImageLabel = { ...labels, transcript: { ...labels.transcript, image: undefined } };
  const messages = [
    msg('a', t0, {
      content: 'text before',
      attachments: [{ kind: 'image' }],
      stickers: ['pepe'],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: noImageLabel });
  assert.ok(!items[0].text.includes('  '), `expected no double space, got: ${JSON.stringify(items[0].text)}`);
  assert.ok(items[0].text.includes('text before [sticker: pepe]'));
});

test('formatTranscript: a forward with an empty-rendering media tag never leaves a double space', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const noImageLabel = { ...labels, transcript: { ...labels.transcript, image: undefined } };
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: null,
      forwarded: [{ content: 'the news', attachments: [{ kind: 'image' }], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: noImageLabel });
  assert.ok(!items[0].text.includes('  '), `expected no double space, got: ${JSON.stringify(items[0].text)}`);
  assert.ok(items[0].text.includes('[forwarded: the news]'));
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

test('formatTranscript: mode "memory" marks a message addressed to the persona with a leading arrow', () => {
  const t0 = Date.UTC(2026, 8, 20, 14, 32, 0);
  const items = formatTranscript([msg('a', t0, { authorName: 'nick', authorId: '1', content: 'text', direct: true })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  const lines = items[0].text.split('\n');
  assert.equal(lines.at(-1), '→ [17:32] nick (id:1): text');
});

test('formatTranscript: mode "memory" leaves a non-direct message unmarked', () => {
  const t0 = Date.UTC(2026, 8, 20, 14, 32, 0);
  const items = formatTranscript([msg('a', t0, { authorName: 'nick', authorId: '1', content: 'text', direct: false })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  const lines = items[0].text.split('\n');
  assert.equal(lines.at(-1), '[17:32] nick (id:1): text');
  assert.ok(!items[0].text.includes('→'));
});

test('formatTranscript: "direct" has no effect in chat mode', () => {
  const t0 = Date.UTC(2026, 8, 20, 14, 32, 0);
  const items = formatTranscript([msg('a', t0, { content: 'text', direct: true })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
  });
  assert.ok(!items[0].text.includes('→'));
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
  const messageLine = items[0].text.split('\n').at(-1);
  assert.ok(!messageLine.includes('(id:'));
});

// --- formatTranscript: mode "memory" groups by channel ----------------------

test('formatTranscript: mode "memory" opens with a channel heading before the very first message', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const items = formatTranscript([msg('a', t0, { channelId: 'c1', channelName: 'general' })], {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    mode: 'memory',
  });
  assert.ok(items[0].text.startsWith('## #general (id:c1)\n'));
});

test('formatTranscript: mode "memory" does not repeat the heading while the channel stays the same', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    msg('b', t0 + MIN, { channelId: 'c1', channelName: 'general' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(!items[1].text.includes('##'));
});

test('formatTranscript: mode "memory" opens a new heading when the channel changes', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    msg('b', t0 + MIN, { channelId: 'c2', channelName: 'random' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(items[0].text.startsWith('## #general (id:c1)\n'));
  assert.ok(items[1].text.startsWith('## #random (id:c2)\n'));
});

test('formatTranscript: mode "memory" re-opens a heading when returning to a previously-seen channel', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    msg('b', t0 + MIN, { channelId: 'c2', channelName: 'random' }),
    msg('c', t0 + 2 * MIN, { channelId: 'c1', channelName: 'general' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(items[2].text.startsWith('## #general (id:c1)\n'));
});

test('formatTranscript: mode "memory" gap markers are computed within a channel run, not across a switch', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    // Big gap AND a channel switch: must show only the heading, no "passed" marker.
    msg('b', t0 + 5 * HOUR, { channelId: 'c2', channelName: 'random' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(!items[1].text.includes('passed'));
  assert.ok(items[1].text.startsWith('## #random (id:c2)\n'));
});

test('formatTranscript: mode "memory" still marks a gap within the same channel run', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, { channelId: 'c1', channelName: 'general' }),
    msg('b', t0 + 25 * MIN, { channelId: 'c1', channelName: 'general' }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, mode: 'memory' });
  assert.ok(items[1].text.includes('25 min passed'));
});

test('formatTranscript: chat mode never adds a channel heading, even across a channelId change', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { channelId: 'c1' }), msg('b', t0 + MIN, { channelId: 'c2' })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(!items[0].text.includes('##'));
  assert.ok(!items[1].text.includes('##'));
});

// --- formatTranscript: new media forms (images, gifs, video, voice, audio,
// links, forwarded, imageAttached) ------------------------------------------

test('formatTranscript: an image attached to this request renders imageAttached with its index', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'att1', kind: 'image', name: 'pic.png' }] })];
  const attachedIndex = new Map([['att1', 2]]);
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, attachedIndex });
  assert.ok(items[0].text.includes('[picture #2, attached]'));
});

test('formatTranscript: a described image (not attached) renders imageDescribed', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'att1', kind: 'image', name: 'pic.png' }] })];
  const descriptions = new Map([['att1', 'a grey cat sleeping']]);
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, descriptions });
  assert.ok(items[0].text.includes('[image: a grey cat sleeping]'));
});

test('formatTranscript: a plain image with neither attachment nor description renders the blind form', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'att1', kind: 'image', name: 'pic.png' }] })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[image]'));
});

test('formatTranscript: a gif attachment renders blind by name, described by caption', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const blindMessages = [msg('a', t0, { content: '', attachments: [{ id: 'g1', kind: 'gif', name: 'cat.gif' }] })];
  const blind = formatTranscript(blindMessages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(blind[0].text.includes('[gif: cat.gif]'));

  const described = formatTranscript(blindMessages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    descriptions: new Map([['g1', 'a cat dances']]),
  });
  assert.ok(described[0].text.includes('[gif: a cat dances]'));
});

test('formatTranscript: a video attachment renders name+duration blind, adds a caption when described', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'v1', kind: 'video', name: 'clip.mp4', durationSec: 65 }] })];
  const blind = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(blind[0].text.includes('[video: clip.mp4, 1:05]'));

  const described = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    descriptions: new Map([['v1', 'a dog runs across a field']]),
  });
  assert.ok(described[0].text.includes('[video: clip.mp4, 1:05: a dog runs across a field]'));
});

test('formatTranscript: a voice message renders only its duration', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'voice1', kind: 'voice', durationSec: 42 }] })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[voice message, 0:42]'));
});

test('formatTranscript: an audio attachment renders name+duration', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'a1', kind: 'audio', name: 'song.mp3', durationSec: 130 }] })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[audio: song.mp3, 2:10]'));
});

test('formatTranscript: a text attachment with a fetched preview renders filePreview, else the plain file form', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const noPreview = [msg('a', t0, { content: '', attachments: [{ id: 't1', kind: 'text', name: 'notes.txt' }] })];
  const blind = formatTranscript(noPreview, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(blind[0].text.includes('[file: notes.txt]'));

  const withPreview = [msg('a', t0, { content: '', attachments: [{ id: 't1', kind: 'text', name: 'notes.txt', previewText: 'line one' }] })];
  const previewed = formatTranscript(withPreview, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(previewed[0].text.includes('[file: notes.txt: line one]'));
});

test('formatTranscript: a link embed renders link/linkText depending on whether it has description text', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const noText = [msg('a', t0, { content: '', links: [{ id: 'a#e0', kind: 'link', site: 'example.com', title: 'Cool page' }] })];
  const items1 = formatTranscript(noText, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items1[0].text.includes('[link: example.com — Cool page]'));

  const withText = [
    msg('a', t0, { content: '', links: [{ id: 'a#e0', kind: 'link', site: 'example.com', title: 'Cool page', text: 'a snippet' }] }),
  ];
  const items2 = formatTranscript(withText, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items2[0].text.includes('[link: example.com — Cool page: a snippet]'));
});

test('formatTranscript: a tenor/giphy embed (kind gif) keeps its gif form and adds frameAttached when its frame is attached', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const gifLink = [msg('a', t0, { content: '', links: [{ id: 'a#e0', kind: 'gif', site: 'Tenor', title: 'cat', thumbnailUrl: 'https://x' }] })];
  const blind = formatTranscript(gifLink, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(blind[0].text.includes('[gif: cat]'));

  const attached = formatTranscript(gifLink, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    attachedIndex: new Map([['a#e0', 1]]),
  });
  assert.ok(attached[0].text.includes('[gif: cat] [its still frame is attached image 1]'));
  assert.ok(!attached[0].text.includes('[picture #1, attached]'), 'the site/title must survive, not collapse into bare imageAttached');
});

test('formatTranscript: a forwarded message-snapshot wraps its content and media in labels.transcript.forwarded', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      forwarded: [{ content: 'look at this', attachments: [{ id: 'f1', kind: 'image', name: 'x.png' }], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[forwarded: look at this [image]]'));
});

test('formatTranscript: a forward with a resolved source channel name uses labels.transcript.forwardedFrom', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: 'announcements',
      forwarded: [{ content: 'big news', attachments: [], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[forwarded from #announcements: big news]'));
  assert.ok(!items[0].text.includes('[forwarded: big news]'));
});

test('formatTranscript: a forward whose source channel is unresolved (forwardedFrom null) falls back to plain forwarded', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: null,
      forwarded: [{ content: 'big news', attachments: [], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[forwarded: big news]'));
});

test('formatTranscript: an older labels.json with no forwardedFrom key falls back to plain forwarded, even with a resolved channel', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const oldLabels = { ...labels, transcript: { ...labels.transcript, forwardedFrom: undefined } };
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: 'announcements',
      forwarded: [{ content: 'big news', attachments: [], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels: oldLabels });
  assert.ok(items[0].text.includes('[forwarded: big news]'));
});

test('formatTranscript: a media-only forwarded snapshot (no text) still renders its media inside the wrapper', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [
    msg('a', t0, {
      content: '',
      forwardedFrom: 'media-dump',
      forwarded: [{ content: '', attachments: [{ id: 'f1', kind: 'image', name: 'x.png' }], links: [], stickers: [] }],
    }),
  ];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[forwarded from #media-dump: [image]]'));
});

test('formatTranscript: an attached video frame keeps its blind/described form and adds frameAttached, numbered', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'v1', kind: 'video', name: 'clip.mp4', durationSec: 34 }] })];
  const attachedIndex = new Map([['v1', 1]]);
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, attachedIndex });
  assert.ok(items[0].text.includes('[video: clip.mp4, 0:34] [its still frame is attached image 1]'));
});

test('formatTranscript: an attached gif frame keeps its blind/described form and adds frameAttached', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'g1', kind: 'gif', name: 'cat.gif' }] })];
  const attachedIndex = new Map([['g1', 2]]);
  const descriptions = new Map([['g1', 'a cat dances']]);
  const items = formatTranscript(messages, {
    timezone: TZ,
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
    attachedIndex,
    descriptions,
  });
  assert.ok(items[0].text.includes('[gif: a cat dances] [its still frame is attached image 2]'));
});

test('formatTranscript: an attached plain image still renders the bare imageAttached form, unaffected by the frameAttached change', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'att1', kind: 'image', name: 'pic.png' }] })];
  const attachedIndex = new Map([['att1', 1]]);
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels, attachedIndex });
  assert.ok(items[0].text.includes('[picture #1, attached]'));
  assert.ok(!items[0].text.includes('still frame'));
});

test('formatTranscript: a video with an unknown duration renders labels.transcript.unknownDuration, never "0:00"', () => {
  const t0 = Date.UTC(2026, 8, 20, 10, 0, 0);
  const messages = [msg('a', t0, { content: '', attachments: [{ id: 'v1', kind: 'video', name: 'clip.mp4', durationSec: null }] })];
  const items = formatTranscript(messages, { timezone: TZ, gapMinutes: 20, maxChars: 100, selfName: 'Nept', labels });
  assert.ok(items[0].text.includes('[video: clip.mp4, unknown length]'));
  assert.ok(!items[0].text.includes('0:00'));
});

// --- renderTranscript -------------------------------------------------------

test('renderTranscript: empty items render as labels.transcript.empty', () => {
  assert.equal(renderTranscript([], TZ, labels), '(empty)');
  assert.equal(renderTranscript([], TZ, grLabels), '(κενό)');
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

// The verdict must look at silence, not only at message counts (a channel
// with 2 messages 4 minutes ago is live, not dead -- see the dry-run case
// below). Default thresholds: liveMessages10min: 4, deadSilenceMinutes: 45.

test('renderTempo: 3 messages in the last 10 min is below the live threshold', () => {
  const text = renderTempo(baseTempo({ last10min: 3, silenceMs: 10 * MIN }), labels);
  assert.ok(!text.includes(labels.tempo.verdictLive));
});

test('renderTempo: 4 messages in the last 10 min -> the "live" verdict, even with long silence', () => {
  const text = renderTempo(baseTempo({ last10min: 4, silenceMs: 50 * MIN }), labels);
  assert.ok(text.includes(labels.tempo.verdictLive));
});

test('renderTempo: silence just under 45 min -> the "slow" verdict, not dead', () => {
  const text = renderTempo(baseTempo({ last10min: 0, silenceMs: 44 * MIN + 59_000 }), labels);
  assert.ok(text.includes(labels.tempo.verdictSlow));
});

test('renderTempo: silence at exactly 45 min -> the "dead" verdict (inclusive)', () => {
  const text = renderTempo(baseTempo({ last10min: 0, silenceMs: 45 * MIN }), labels);
  assert.ok(text.includes(labels.tempo.verdictDead));
});

test('renderTempo: an empty channel (silenceMs null) -> the "dead" verdict', () => {
  const text = renderTempo(baseTempo({ last10min: 0, silenceMs: null }), labels);
  assert.ok(text.includes(labels.tempo.verdictDead));
});

test('renderTempo: dry-run case -- 2 messages in the last 10 min, 4 min of silence -> "slow", not "dead"', () => {
  const text = renderTempo(baseTempo({ last10min: 2, silenceMs: 4 * MIN }), labels);
  assert.ok(text.includes(labels.tempo.verdictSlow));
  assert.ok(!text.includes(labels.tempo.verdictDead));
  assert.ok(!text.includes(labels.tempo.verdictLive));
});

test('renderTempo: custom thresholds are honoured', () => {
  const thresholds = { liveMessages10min: 2, deadSilenceMinutes: 5 };
  const live = renderTempo(baseTempo({ last10min: 2, silenceMs: 0 }), labels, thresholds);
  assert.ok(live.includes(labels.tempo.verdictLive));
  const dead = renderTempo(baseTempo({ last10min: 0, silenceMs: 5 * MIN }), labels, thresholds);
  assert.ok(dead.includes(labels.tempo.verdictDead));
  const slow = renderTempo(baseTempo({ last10min: 0, silenceMs: 4 * MIN }), labels, thresholds);
  assert.ok(slow.includes(labels.tempo.verdictSlow));
});

test('renderTempo: a missing thresholds argument falls back to the defaults (4 / 45 min)', () => {
  const notYetLive = renderTempo(baseTempo({ last10min: 3, silenceMs: 0 }), labels);
  assert.ok(!notYetLive.includes(labels.tempo.verdictLive));
  const notYetDead = renderTempo(baseTempo({ last10min: 0, silenceMs: 44 * MIN }), labels);
  assert.ok(!notYetDead.includes(labels.tempo.verdictDead));
});

test('renderTempo: a thresholds object missing one key falls back to the default for that key only', () => {
  const text = renderTempo(baseTempo({ last10min: 0, silenceMs: 45 * MIN }), labels, { liveMessages10min: 10 });
  assert.ok(text.includes(labels.tempo.verdictDead)); // deadSilenceMinutes still defaults to 45
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
  const text = renderTempo(baseTempo({ last10min: 4 }), grLabels);
  assert.ok(text.includes(grLabels.tempo.verdictLive));
});
