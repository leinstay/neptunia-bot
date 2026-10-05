// Tests for src/behavior/recall.js: the pure core of recall (the lookup
// answer parser, the search plan, clustering, window rendering, the summary
// request and its answer). No I/O, no real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIT_MARK,
  RECALL_DEFAULTS,
  buildRecallRequest,
  clusterHits,
  cutStretch,
  mergeWindows,
  parseLookupAnswer,
  parseRecallAnswer,
  recallSettings,
  renderRecallWindows,
  sampleOffsets,
  searchPlan,
  snowflakeAt,
} from '../src/behavior/recall.js';
import { labels } from './fixtures/labels.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const BERLIN = 'Europe/Berlin';

/** The snowflake's timestamp back in ms. */
const tsOf = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

// ---- settings ------------------------------------------------------------------------------

test('recallSettings: a missing switch counts as on, false turns it off, unusable numbers fall back', () => {
  assert.equal(recallSettings({ features: { recall: false } }), null);
  assert.deepEqual(recallSettings({}), { ...RECALL_DEFAULTS });
  const s = recallSettings({ recall: { maxForms: 3.9, maxPeople: 0, dateSamples: 0, windowMessages: 500, timeoutMs: 'x', stretchChars: -1 } });
  assert.equal(s.maxForms, 3);
  assert.equal(s.maxPeople, 0, '0 people is a usable value');
  assert.equal(s.dateSamples, RECALL_DEFAULTS.dateSamples, 'below 1 falls back');
  assert.equal(s.windowMessages, 100, 'one page at most');
  assert.equal(s.timeoutMs, RECALL_DEFAULTS.timeoutMs);
  assert.equal(s.stretchChars, RECALL_DEFAULTS.stretchChars);
});

// ---- the lookup answer -----------------------------------------------------------------------

test('parseLookupAnswer: the old single-line answer is still a web query, none is none', () => {
  assert.deepEqual(parseLookupAnswer('"Café Müller opening hours".'), { web: 'Café Müller opening hours', server: null, reason: 'ok' });
  assert.deepEqual(parseLookupAnswer('None needed.'), { web: null, server: null, reason: 'none' });
  assert.deepEqual(parseLookupAnswer('`none`'), { web: null, server: null, reason: 'none' });
  assert.deepEqual(parseLookupAnswer('  \n '), { web: null, server: null, reason: 'empty' });
  assert.deepEqual(parseLookupAnswer(null), { web: null, server: null, reason: 'empty' });
  assert.equal(parseLookupAnswer('first line\nsecond line').web, 'first line', 'only the first line of the old shape');
  assert.equal([...parseLookupAnswer('x'.repeat(300)).web].length, 200);
});

test('parseLookupAnswer: labelled lines in any order and case; unlabelled lines are ignored', () => {
  const answer = ['Here you go:', 'WHO: Ἀλέξανδρος, alexandros', 'Server: "κουνέλι", κουνελιού, κουνέλι', '- **web:** rabbit hunting season', 'When: none'].join('\n');
  const parsed = parseLookupAnswer(answer, { timezone: 'UTC', now: NOW });
  assert.equal(parsed.reason, 'ok');
  assert.equal(parsed.web, 'rabbit hunting season');
  assert.deepEqual(parsed.server, { forms: ['κουνέλι', 'κουνελιού'], who: ['ἀλέξανδρος', 'alexandros'], from: null, to: null });
});

test('parseLookupAnswer: forms are cleaned, bounded in length and words, capped at maxForms', () => {
  const parsed = parseLookupAnswer('server: a, "Νέο Έτος", one two three four, ' + 'x'.repeat(41) + ', ÉTÉ., été, b2, c3, d4', { maxForms: 4 });
  assert.deepEqual(parsed.server.forms, ['νέο έτος', 'été', 'b2', 'c3']);
  assert.equal(parsed.web, null);
});

test('parseLookupAnswer: labelled lines that all say none are none; unusable ones are unparsed', () => {
  assert.deepEqual(parseLookupAnswer('web: none\nserver: none'), { web: null, server: null, reason: 'none' });
  assert.deepEqual(parseLookupAnswer('when: last tuesday', { now: NOW }), { web: null, server: null, reason: 'unparsed' });
  assert.deepEqual(parseLookupAnswer('server: x', { now: NOW }), { web: null, server: null, reason: 'unparsed' });
});

test('parseLookupAnswer: a range alone makes a server search; one date is that whole local day', () => {
  const parsed = parseLookupAnswer('when: 2025-12-18', { timezone: BERLIN, now: NOW });
  assert.deepEqual(parsed.server, { forms: [], who: [], from: Date.UTC(2025, 11, 17, 23, 0), to: Date.UTC(2025, 11, 18, 23, 0) - 1 });
});

test('parseLookupAnswer: a range across a daylight saving change keeps local wall times', () => {
  const parsed = parseLookupAnswer('when: 2026-03-28 18:00 .. 2026-03-29 06:00', { timezone: BERLIN, now: NOW });
  assert.equal(parsed.server.from, Date.UTC(2026, 2, 28, 17, 0), 'before the change: +01:00');
  assert.equal(parsed.server.to, Date.UTC(2026, 2, 29, 4, 0), 'after the change: +02:00');
  const days = parseLookupAnswer('when: 2025-10-26..2025-10-26', { timezone: BERLIN, now: NOW });
  assert.equal(days.server.to + 1 - days.server.from, 25 * HOUR, 'a fall-back day lasts 25 hours');
});

test('parseLookupAnswer: reversed bounds are swapped, a future end is clamped, a future start drops the range', () => {
  const reversed = parseLookupAnswer('when: 2026-01-01 .. 2025-12-31', { timezone: 'UTC', now: NOW });
  assert.equal(reversed.server.from, Date.UTC(2025, 11, 31));
  assert.equal(reversed.server.to, Date.UTC(2026, 0, 2) - 1);
  const today = parseLookupAnswer('when: 2026-10-05', { timezone: 'UTC', now: NOW });
  assert.equal(today.server.to, NOW);
  assert.equal(parseLookupAnswer('when: 2026-12-01', { timezone: 'UTC', now: NOW }).server, null);
});

test('parseLookupAnswer: an open side is allowed; an unparsable side gives no range', () => {
  const open = parseLookupAnswer('when: 2025-12-31 18:00 ..', { timezone: 'UTC', now: NOW });
  assert.deepEqual([open.server.from, open.server.to], [Date.UTC(2025, 11, 31, 18, 0), null]);
  const bad = parseLookupAnswer('server: κουνέλι\nwhen: 2025-12-31 .. soon', { timezone: 'UTC', now: NOW });
  assert.deepEqual(bad.server, { forms: ['κουνέλι'], who: [], from: null, to: null });
  assert.equal(parseLookupAnswer('when: 2025-02-30', { now: NOW }).server, null, 'a date that does not exist');
});

// ---- the plan ------------------------------------------------------------------------------

test('snowflakeAt: a time maps to the first snowflake of its millisecond', () => {
  const at = Date.UTC(2026, 9, 1, 18, 44, 0, 123);
  assert.equal(tsOf(snowflakeAt(at)), at);
  assert.equal(snowflakeAt(0), '0');
  assert.equal(snowflakeAt(NaN), '0');
});

test('searchPlan: content forms round-robin server and who forms up to maxForms, then authors', () => {
  const plan = searchPlan({ forms: ['α', 'β', 'γ'], who: ['δ', 'α'], memberIds: ['u1', 'u1', 'u2'], maxForms: 4 });
  assert.deepEqual(
    plan.map((q) => q.content ?? q.authorId),
    ['α', 'δ', 'β', 'γ', 'u1', 'u2'],
  );
  assert.deepEqual(plan.map((q) => q.kind), ['content', 'content', 'content', 'content', 'author', 'author']);
  assert.ok(plan.every((q) => q.minId === null && q.maxId === null));
});

test('searchPlan: the range bounds every query; the turn\'s own chat caps the end', () => {
  const from = Date.UTC(2025, 11, 31, 18);
  const to = Date.UTC(2026, 0, 1, 6);
  const [query] = searchPlan({ forms: ['α'], from, to, maxForms: 8 });
  assert.equal(tsOf(query.minId), from);
  assert.equal(tsOf(query.maxId), to + 1);
  const before = Date.UTC(2026, 9, 5, 11);
  const [capped] = searchPlan({ forms: ['α'], maxForms: 8, before });
  assert.equal(capped.minId, null);
  assert.equal(tsOf(capped.maxId), before);
  assert.deepEqual(searchPlan({ forms: ['α'], from: before + HOUR, maxForms: 8, before }), [], 'a range inside the visible chat');
});

test('searchPlan: a range and nothing else is one range query; nothing at all is no query', () => {
  const plan = searchPlan({ from: Date.UTC(2025, 11, 18), to: Date.UTC(2025, 11, 19) - 1, maxForms: 8 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, 'range');
  assert.deepEqual(searchPlan({ maxForms: 8 }), []);
  assert.deepEqual(searchPlan({ forms: ['α'], maxForms: 0 }), []);
});

test('sampleOffsets: evenly spaced over the total, one page when it fits', () => {
  assert.deepEqual(sampleOffsets(2115, 4), [0, 528, 1057, 1586]);
  assert.deepEqual(sampleOffsets(20, 4), [0]);
  assert.deepEqual(sampleOffsets(100000, 2), [0, 9975]);
});

// ---- clusters and windows ------------------------------------------------------------------

test('clusterHits: hits of one channel closer than the gap join; the newest clusters are kept', () => {
  const t = Date.UTC(2026, 9, 1, 15, 19);
  const hits = [
    { id: 'a1', channelId: 'c1', ts: t },
    { id: 'a2', channelId: 'c1', ts: t + 20 * MINUTE },
    { id: 'a3', channelId: 'c1', ts: t + 27 * MINUTE },
    { id: 'b1', channelId: 'c1', ts: t + 34 * HOUR },
    { id: 'x1', channelId: 'c2', ts: t + 21 * MINUTE },
    { id: 'old', channelId: 'c1', ts: t - 40 * HOUR },
    { id: 'a2', channelId: 'c1', ts: t + 20 * MINUTE },
  ];
  const clusters = clusterHits(hits, { gapMinutes: 30, maxClusters: 3 });
  assert.deepEqual(
    clusters.map((c) => [c.channelId, c.ids, c.middleId]),
    [
      ['c1', ['b1'], 'b1'],
      ['c1', ['a1', 'a2', 'a3'], 'a2'],
      ['c2', ['x1'], 'x1'],
    ],
  );
  assert.equal(clusters[1].startTs, t);
  assert.equal(clusters[1].endTs, t + 27 * MINUTE);
});

/** A normalized message. */
function msg(id, ts, extra = {}) {
  return { id, channelId: 'c1', authorId: 'u1', authorName: 'Ana', self: false, bot: false, content: `line ${id}`, ts, attachments: [], links: [], stickers: [], emojis: [], forwarded: [], reactions: [], replyToId: null, ...extra };
}

test('mergeWindows: windows of one channel sharing a message become one', () => {
  const t = Date.UTC(2026, 9, 1, 15);
  const merged = mergeWindows([
    { channelId: 'c1', channelName: 'general', messages: [msg('m1', t), msg('m2', t + 1)], hitIds: ['m1'] },
    { channelId: 'c2', channelName: 'garden', messages: [msg('n1', t)], hitIds: ['n1'] },
    { channelId: 'c1', channelName: 'general', messages: [msg('m2', t + 1), msg('m3', t + 2)], hitIds: ['m3'] },
    { channelId: 'c1', channelName: 'general', messages: [], hitIds: [] },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].messages.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.deepEqual([...merged[0].hitIds].sort(), ['m1', 'm3']);
});

test('renderRecallWindows: hit lines carry the mark; captions render; unindexed lines drop the index and reply markers', () => {
  const t = Date.UTC(2026, 9, 1, 18, 40);
  const window = {
    channelId: 'c1',
    channelName: 'general',
    messages: [
      msg('m1', t, { attachments: [{ id: 'p1', kind: 'image', name: 'x.png', url: 'https://cdn.example/x.png' }] }),
      msg('m2', t + 4 * MINUTE, { authorName: 'Βασίλης', content: 'τον πυροβόλησες', replyToId: 'm1' }),
    ],
    hitIds: ['m2'],
    descriptions: new Map([['p1', 'a rabbit in the grass']]),
  };
  const [indexed] = renderRecallWindows([window], { labels, timezone: 'UTC', selfName: 'Zoë', indexed: true });
  assert.equal(indexed.lines[0].text, '#1 [18:40] Ana: line m1 [image: a rabbit in the grass]');
  assert.equal(indexed.lines[1].text, `${HIT_MARK}#2 [18:44] Βασίλης: τον πυροβόλησες (replying to #1)`);
  assert.deepEqual(indexed.lines.map((l) => l.hit), [false, true]);
  const [plain] = renderRecallWindows([window], { labels, timezone: 'UTC', indexed: false });
  assert.equal(plain.lines[1].text, `${HIT_MARK}[18:44] Βασίλης: τον πυροβόλησες`);
});

// ---- the summary request and answer --------------------------------------------------------

test('buildRecallRequest: system prompt filled; people, numbered found sections, the question', () => {
  const t = Date.UTC(2026, 9, 1, 18, 40);
  const windows = [
    { channelId: 'c1', channelName: 'general', messages: [msg('m1', t), msg('m2', t + MINUTE)], hitIds: ['m2'] },
    { channelId: 'c2', channelName: 'garden', messages: [msg('n1', t - 30 * HOUR, { channelId: 'c2' })], hitIds: ['n1'] },
  ];
  const messages = buildRecallRequest({
    prompt: 'You are {{name}}. At most {{answerChars}} characters. Today {{today}}.',
    selfName: 'Zoë',
    question: { authorName: 'Nikos', content: 'ποιος σκότωσε το κουνέλι;' },
    people: [{ name: 'Kitezu', username: 'kitezu.', count: 23, newestTs: Date.UTC(2024, 8, 30, 12) }],
    windows,
    labels,
    timezone: 'UTC',
    answerChars: 900,
    now: NOW,
  });
  assert.equal(messages[0].content, 'You are Zoë. At most 900 characters. Today 2026-10-05.');
  assert.equal(
    messages[1].content,
    [
      '<people>',
      'Kitezu | kitezu. | 23 | 2024-09-30',
      '</people>',
      '<found>',
      '## 1 | 2026-10-01 | #general',
      '#1 [18:40] Ana: line m1',
      `${HIT_MARK}#2 [18:41] Ana: line m2`,
      '',
      '## 2 | 2026-09-30 | #garden',
      `${HIT_MARK}#3 [12:40] Ana: line n1`,
      '</found>',
      '<question>',
      'Nikos: ποιος σκότωσε το κουνέλι;',
      '</question>',
    ].join('\n'),
  );
});

test('buildRecallRequest: no prompt or no window line gives null; no people leaves the block out', () => {
  const base = { selfName: 'Zoë', question: { authorName: 'A', content: 'q' }, labels, answerChars: 100 };
  const windows = [{ channelId: 'c1', channelName: 'general', messages: [msg('m1', NOW)], hitIds: [] }];
  assert.equal(buildRecallRequest({ ...base, prompt: ' ', windows }), null);
  assert.equal(buildRecallRequest({ ...base, prompt: 'p', windows: [] }), null);
  const user = buildRecallRequest({ ...base, prompt: 'p', windows })[1].content;
  assert.ok(user.startsWith('<found>\n') && !user.includes('<people>'));
});

test('parseRecallAnswer: a stretch line names a section; out of range or none names nothing', () => {
  assert.deepEqual(parseRecallAnswer('stretch: 2\nAna did it on October 1.', { answerChars: 500, count: 3 }), { text: 'Ana did it on October 1.', stretch: 2 });
  assert.deepEqual(parseRecallAnswer('Stretch: #1\nΗ Άννα.', { answerChars: 500, count: 1 }), { text: 'Η Άννα.', stretch: 1 });
  assert.deepEqual(parseRecallAnswer('stretch: 4\nAna.', { answerChars: 500, count: 3 }), { text: 'Ana.', stretch: null });
  assert.deepEqual(parseRecallAnswer('stretch: none\nAna.', { answerChars: 500, count: 3 }), { text: 'Ana.', stretch: null });
  assert.deepEqual(parseRecallAnswer('Ana did it.\nstretch: 1', { answerChars: 500, count: 3 }), { text: 'Ana did it.\nstretch: 1', stretch: null }, 'only a first line names one');
});

test('parseRecallAnswer: nothing or an empty answer gives no text and no stretch; the text is clamped', () => {
  for (const raw of ['nothing', 'Nothing.', '"nothing"', 'stretch: 1\nnothing', '', '  ', 'stretch: 2', null]) {
    assert.deepEqual(parseRecallAnswer(raw, { answerChars: 500, count: 3 }), { text: null, stretch: null }, String(raw));
  }
  const long = 'Ana did it. '.repeat(40).trim();
  const { text } = parseRecallAnswer(long, { answerChars: 100, count: 0 });
  assert.ok(text.length <= 125 && text.endsWith('.'), text);
});

test('cutStretch: whole lines go from the far ends, matched lines stay', () => {
  const lines = ['aaaa', 'bbbb', 'cccc', 'HHHH', 'dddd'].map((text) => ({ text, hit: text === 'HHHH' }));
  assert.deepEqual(cutStretch(lines, 14).map((l) => l.text), ['cccc', 'HHHH', 'dddd']);
  assert.deepEqual(cutStretch(lines, 9).map((l) => l.text), ['HHHH', 'dddd']);
  assert.deepEqual(cutStretch(lines, 1).map((l) => l.text), ['HHHH'], 'a matched line is never dropped');
  assert.deepEqual(cutStretch(lines, 1000).map((l) => l.text), lines.map((l) => l.text));
});
