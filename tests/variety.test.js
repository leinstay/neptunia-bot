// Tests for src/behavior/variety.js (the pure core of the variety pass) and
// src/behavior/variety-pass.js (the live pass before a turn), with the store's
// variety fields on a real store in a temp directory. Fakes only: no network,
// no real prompts/ or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VARIETY_DEFAULTS,
  appendOwnLine,
  appendWornHistory,
  buildVarietyRequest,
  linesKey,
  normalizeOwnLines,
  normalizeWorn,
  parseVariety,
  renderVarietyReport,
  renderWorn,
  selectOwnLines,
  varietyOn,
  varietySettings,
  varietyStatusLine,
} from '../src/behavior/variety.js';
import { createVarietyPass } from '../src/behavior/variety-pass.js';
import { buildRequest } from '../src/behavior/prompt.js';
import { createStore } from '../src/memory/store.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const PROMPT = 'VARIETY for {{name}}, at most {{maxPatterns}} patterns of {{shapeChars}} characters.';

/** A normalized message of the persona (`self`) or of someone else in channel `c1`. */
function msg(id, minutesAgo, content, { self = false, channelId = 'c1', replyToId = null } = {}) {
  return { id, ts: NOW - minutesAgo * MIN, channelId, authorId: self ? 'self-id' : `u-${id}`, authorName: self ? 'Nept' : `User${id}`, self, bot: false, content, replyToId };
}

function own(id, minutesAgo, content, extra = {}) {
  return msg(id, minutesAgo, content, { self: true, ...extra });
}

// ---- settings -------------------------------------------------------------------

test('varietySettings: defaults for a missing block, live values otherwise, garbage falls back', () => {
  assert.deepEqual(varietySettings({}), { ...VARIETY_DEFAULTS });
  assert.deepEqual(VARIETY_DEFAULTS, { window: 12, recentMinutes: 45, minLines: 3, contextChars: 120, maxPatterns: 4, shapeChars: 140, maxOutputTokens: 500, timeoutMs: 8000, history: 20 });
  const live = varietySettings({ variety: { window: 5, recentMinutes: 10, minLines: 2, contextChars: 0, maxPatterns: 1, history: 0 } });
  assert.equal(live.window, 5);
  assert.equal(live.recentMinutes, 10);
  assert.equal(live.minLines, 2);
  assert.equal(live.contextChars, 0);
  assert.equal(live.maxPatterns, 1);
  assert.equal(live.history, 0);
  const broken = varietySettings({ variety: { window: 'many', minLines: -1, timeoutMs: null, shapeChars: 1 } });
  assert.equal(broken.window, 12);
  assert.equal(broken.minLines, 3);
  assert.equal(broken.timeoutMs, 8000);
  assert.equal(broken.shapeChars, 140);
});

test('varietyOn: a missing switch counts as on, false turns it off', () => {
  assert.equal(varietyOn({}), true);
  assert.equal(varietyOn({ features: { variety: true } }), true);
  assert.equal(varietyOn({ features: { variety: false } }), false);
});

// ---- which own lines --------------------------------------------------------------

test('selectOwnLines: the channel of the turn first, then other channels from the ring, oldest first in the result', () => {
  const history = [own('a1', 30, 'ένα'), msg('x', 29, 'hi'), own('a2', 5, 'δύο')];
  const ring = [
    { id: 'b1', ts: NOW - 2 * MIN, channelId: 'c2', text: 'τρία' },
    { id: 'b2', ts: NOW - 40 * MIN, channelId: 'c2', text: 'τέσσερα' },
    { id: 'a2', ts: NOW - 5 * MIN, channelId: 'c1', text: 'δύο' },
  ];
  const lines = selectOwnLines({ history, ring, channelId: 'c1', now: NOW, window: 3, recentMinutes: 45 });
  // Two of the turn's channel, then the newest of the other channel; 'b2' does not fit the window.
  assert.deepEqual(lines.map((l) => l.id), ['a1', 'a2', 'b1']);
});

test('selectOwnLines: the turn channel fills the window before any other channel is read', () => {
  const history = [own('a1', 9, 'one'), own('a2', 8, 'two'), own('a3', 7, 'three')];
  const ring = [{ id: 'b1', ts: NOW - MIN, channelId: 'c2', text: 'newest elsewhere' }];
  const lines = selectOwnLines({ history, ring, channelId: 'c1', now: NOW, window: 2, recentMinutes: 45 });
  assert.deepEqual(lines.map((l) => l.id), ['a2', 'a3']);
});

test('selectOwnLines: lines older than recentMinutes are left out; without it every line may be taken', () => {
  const history = [own('a1', 60, 'old'), own('a2', 10, 'new')];
  const ring = [{ id: 'b1', ts: NOW - 50 * MIN, channelId: 'c2', text: 'old elsewhere' }];
  assert.deepEqual(selectOwnLines({ history, ring, channelId: 'c1', now: NOW, window: 12, recentMinutes: 45 }).map((l) => l.id), ['a2']);
  assert.deepEqual(selectOwnLines({ history, window: 12 }).map((l) => l.id), ['a1', 'a2']);
});

test('selectOwnLines: a reply carries the message it answered; empty and other people\'s lines are skipped', () => {
  const history = [msg('q', 6, 'is the café open?'), own('a1', 5, 'ναι', { replyToId: 'q' }), own('a2', 4, '   '), msg('y', 3, 'ok')];
  const lines = selectOwnLines({ history, window: 12 });
  assert.deepEqual(lines, [{ id: 'a1', ts: NOW - 5 * MIN, channelId: 'c1', text: 'ναι', to: 'is the café open?' }]);
});

test('linesKey: the same lines give the same key, another set another one', () => {
  const a = [{ id: '1' }, { id: '2' }];
  assert.equal(linesKey(a), linesKey([{ id: '1' }, { id: '2' }]));
  assert.notEqual(linesKey(a), linesKey([{ id: '1' }, { id: '3' }]));
  assert.match(linesKey(a), /^[0-9a-f]{16}$/);
});

// ---- the request -------------------------------------------------------------------

test('buildVarietyRequest: system fills name and maxPatterns; one <lines> block, numbered, with the answered line clipped', () => {
  const lines = [
    { id: '1', ts: 1, text: 'first\nline', to: 'ζ'.repeat(200) },
    { id: '2', ts: 2, text: 'second' },
  ];
  const request = buildVarietyRequest({ prompt: PROMPT, selfName: 'Nept', lines, config: { variety: { contextChars: 10, maxPatterns: 3 } } });
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[0].content, 'VARIETY for Nept, at most 3 patterns of 140 characters.');
  assert.equal(request.messages[1].content, `<lines>\n#1 first line (to: ${'ζ'.repeat(10)})\n#2 second\n</lines>`);
  assert.deepEqual(request.texts, ['first line', 'second']);
  assert.equal(request.count, 2);
});

test('buildVarietyRequest: contextChars 0 leaves out what a line answered', () => {
  const request = buildVarietyRequest({ prompt: PROMPT, selfName: 'Nept', lines: [{ id: '1', ts: 1, text: 'a', to: 'b' }], config: { variety: { contextChars: 0 } } });
  assert.equal(request.messages[1].content, '<lines>\n#1 a\n</lines>');
});

// ---- the validator -------------------------------------------------------------------

const TEXTS = ['I will promise to behave (no)', 'Sure I will fix it (no)', 'Crêpes again, what a surprise', 'what a surprise, another meeting'];

function answer(patterns) {
  return JSON.stringify({ patterns });
}

test('parseVariety: a valid answer keeps shape, examples and count', () => {
  const result = parseVariety(answer([{ shape: 'mock promise ending in (no)', examples: ['promise to behave (no)', 'fix it (no)'], count: 2 }]), TEXTS, {});
  assert.deepEqual(result, { ok: true, patterns: [{ shape: 'mock promise ending in (no)', examples: ['promise to behave (no)', 'fix it (no)'], count: 2 }], dropped: 0 });
});

test('parseVariety: no JSON object, or no patterns array, is a parse failure', () => {
  assert.deepEqual(parseVariety('nothing here', TEXTS, {}), { ok: false, patterns: [], dropped: 0 });
  assert.deepEqual(parseVariety('{"items": []}', TEXTS, {}), { ok: false, patterns: [], dropped: 0 });
  assert.deepEqual(parseVariety('{"patterns": "x"}', TEXTS, {}), { ok: false, patterns: [], dropped: 0 });
});

test('parseVariety: an empty list is a valid answer; fences and chatter around the JSON are tolerated', () => {
  assert.deepEqual(parseVariety('```json\n{"patterns": []}\n```', TEXTS, {}), { ok: true, patterns: [], dropped: 0 });
});

test('parseVariety: at most maxPatterns are kept, the rest counted as dropped', () => {
  const item = { shape: 'ends on (no)', examples: ['(no)'] };
  const result = parseVariety(answer([item, item, item]), TEXTS, { variety: { maxPatterns: 2 } });
  assert.equal(result.patterns.length, 2);
  assert.equal(result.dropped, 1);
});

test('parseVariety: a shape must be 3..shapeChars characters after trimming, whitespace collapsed', () => {
  const ex = ['(no)'];
  const result = parseVariety(
    answer([{ shape: ' ab ', examples: ex }, { shape: '  abc  ', examples: ex }, { shape: 'x'.repeat(21), examples: ex }, { shape: 'two\nlines', examples: ex }, { examples: ex }]),
    TEXTS,
    { variety: { shapeChars: 20 } },
  );
  assert.deepEqual(result.patterns.map((p) => p.shape), ['abc', 'two lines']);
  assert.equal(result.dropped, 3);
});

test('parseVariety: an example must occur in the lines sent (case ignored); a pattern left without one is dropped', () => {
  const result = parseVariety(
    answer([
      { shape: 'names the thing', examples: ['WHAT A SURPRISE', 'never said this'] },
      { shape: 'invented quote', examples: ['not in any line'] },
    ]),
    TEXTS,
    {},
  );
  assert.deepEqual(result.patterns, [{ shape: 'names the thing', examples: ['WHAT A SURPRISE'], count: 2 }]);
  assert.equal(result.dropped, 1);
});

test('parseVariety: a piece of what a line answered is not the persona\'s line and does not count', () => {
  const request = buildVarietyRequest({ prompt: PROMPT, selfName: 'N', lines: [{ id: '1', ts: 1, text: 'ναι', to: 'is the café open?' }, { id: '2', ts: 2, text: 'ναι ναι' }], config: {} });
  const result = parseVariety(answer([{ shape: 'quotes the question', examples: ['café open'] }]), request.texts, {});
  assert.deepEqual(result.patterns, []);
});

test('parseVariety: examples are clipped to 80 characters, at most 3, duplicates and non-strings dropped', () => {
  const long = 'λ'.repeat(100);
  const texts = [long, 'alpha', 'beta', 'gamma'];
  const result = parseVariety(answer([{ shape: 'repeats', examples: [long, 'alpha', 'ALPHA', 7, 'beta', 'gamma'] }]), texts, {});
  assert.deepEqual(result.patterns[0].examples, ['λ'.repeat(80), 'alpha', 'beta']);
});

test('parseVariety: count is an integer of at least 2 -- missing means 2, anything else drops the pattern, above the lines it is cut', () => {
  const ex = ['(no)'];
  const result = parseVariety(
    answer([
      { shape: 'missing count', examples: ex },
      { shape: 'count one', examples: ex, count: 1 },
      { shape: 'fraction', examples: ex, count: 2.5 },
      { shape: 'string', examples: ex, count: '3' },
      { shape: 'too many', examples: ex, count: 40 },
      { shape: 'three', examples: ex, count: 3 },
    ]),
    TEXTS,
    { variety: { maxPatterns: 6 } },
  );
  assert.deepEqual(result.patterns.map((p) => [p.shape, p.count]), [['missing count', 2], ['too many', 4], ['three', 3]]);
  assert.equal(result.dropped, 3);
});

test('parseVariety: a non-object item is dropped', () => {
  const result = parseVariety(answer(['mock promise', null, [1]]), TEXTS, {});
  assert.deepEqual(result, { ok: true, patterns: [], dropped: 3 });
});

// ---- the block ----------------------------------------------------------------------------

const PATTERNS = [
  { shape: 'mock promise ending in (no)', examples: ['promise to behave (no)', 'fix it (no)'], count: 2 },
  { shape: 'names what was said', examples: ['what a surprise'], count: 3 },
];

test('renderWorn: the intro label, then one line per pattern with its examples quoted', () => {
  assert.equal(
    renderWorn(PATTERNS, labels, {}),
    [labels.variety.intro, '- mock promise ending in (no) ("promise to behave (no)", "fix it (no)")', '- names what was said ("what a surprise")'].join('\n'),
  );
});

test('renderWorn: nothing for no patterns, the switch off, or labels without variety.intro', () => {
  assert.equal(renderWorn([], labels, {}), '');
  assert.equal(renderWorn(null, labels, {}), '');
  assert.equal(renderWorn(PATTERNS, labels, { features: { variety: false } }), '');
  const { variety: _omit, ...older } = labels;
  assert.equal(renderWorn(PATTERNS, older, {}), '');
});

test('renderWorn: at most variety.maxPatterns lines, read now', () => {
  assert.equal(renderWorn(PATTERNS, labels, { variety: { maxPatterns: 1 } }).split('\n').length, 2);
});

// ---- storage --------------------------------------------------------------------------------

test('appendOwnLine: appended, capped at three windows, broken lines ignored', () => {
  let ring = [];
  for (let i = 0; i < 10; i += 1) ring = appendOwnLine(ring, { id: String(i), ts: i, channelId: 'c', text: `t${i}` }, 2);
  assert.deepEqual(ring.map((l) => l.id), ['4', '5', '6', '7', '8', '9']);
  assert.equal(appendOwnLine(ring, { ts: 1, text: '' }, 2).length, 6);
  assert.deepEqual(normalizeOwnLines([null, { text: 'x' }, { ts: 1, text: 'ok' }]), [{ id: null, ts: 1, channelId: null, text: 'ok' }]);
});

test('appendWornHistory: shapes and counts only, the oldest dropped past max, 0 keeps none', () => {
  let history = [];
  for (let i = 1; i <= 4; i += 1) history = appendWornHistory(history, { at: i, channelId: 'c1', lines: 5, patterns: PATTERNS }, 3);
  assert.deepEqual(history.map((h) => h.at), [2, 3, 4]);
  assert.deepEqual(history[2].patterns, [{ shape: 'mock promise ending in (no)', count: 2 }, { shape: 'names what was said', count: 3 }]);
  assert.deepEqual(appendWornHistory(history, { at: 9, lines: 1, patterns: [] }, 0), []);
});

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-variety-'));
}

test('store: pushOwnLine, setWorn and appendWornHistory persist across a restart without stamping updatedAt', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  assert.equal(store.pushOwnLine('g1', { id: 'm1', ts: NOW, channelId: 'c1', text: 'γεια', to: 'hi' }, 12), true);
  assert.equal(store.pushOwnLine('g1', { id: 'm2', ts: NOW, channelId: 'c1', text: '' }, 12), false);
  store.setWorn('g1', { at: NOW, key: 'k1', channelId: 'c1', lines: 3, patterns: PATTERNS });
  store.appendWornHistory('g1', { at: NOW, channelId: 'c1', lines: 3, patterns: PATTERNS }, 20);
  store.flush();

  const again = createStore({ dataDir: dir }).getGuild('g1');
  assert.deepEqual(again.ownLines, [{ id: 'm1', ts: NOW, channelId: 'c1', text: 'γεια', to: 'hi' }]);
  assert.deepEqual(again.worn, { at: NOW, key: 'k1', channelId: 'c1', lines: 3, patterns: PATTERNS });
  assert.equal(again.wornHistory.length, 1);
  assert.equal(again.updatedAt, null);
});

test('store: updateGuild never overwrites the variety fields; hand-broken ones load as empty', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.setWorn('g1', { at: NOW, key: 'k1', lines: 3, patterns: PATTERNS });
  store.updateGuild('g1', { patterns: 'p', worn: null, ownLines: 'x', wornHistory: 5 });
  assert.equal(store.getGuild('g1').worn.key, 'k1');

  const file = path.join(dir, 'guilds', 'g2', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ worn: 'broken', ownLines: {}, wornHistory: [null, { at: 'x' }] }));
  const g2 = createStore({ dataDir: dir }).getGuild('g2');
  assert.deepEqual([g2.worn, g2.ownLines, g2.wornHistory], [null, [], []]);
  assert.equal(normalizeWorn({ at: 1, patterns: [{ shape: 's', examples: [] }] }).patterns.length, 0, 'a stored pattern without examples is dropped');
});

// ---- the owner's view -------------------------------------------------------------------------

test('varietyStatusLine: switch, pattern and line counts and the age of the latest pass', () => {
  assert.equal(varietyStatusLine(null, { features: { variety: false } }, NOW), 'variety: off');
  assert.equal(varietyStatusLine(null, {}, NOW), 'variety: on · no pass yet');
  assert.equal(varietyStatusLine({ at: NOW - 3 * 3_600_000, key: 'k', lines: 7, patterns: PATTERNS }, {}, NOW), 'variety: on · 2 patterns from 7 lines · 3h old');
});

test('renderVarietyReport: the latest list with examples, then the history newest first, shapes with counts', () => {
  const worn = { at: NOW, key: 'k', lines: 5, patterns: PATTERNS };
  const history = [
    { at: NOW - 60 * MIN, channelId: 'c1', lines: 4, patterns: [{ shape: 'old device', count: 2 }] },
    { at: NOW, channelId: 'c1', lines: 5, patterns: [{ shape: 'mock promise ending in (no)', count: 2 }] },
  ];
  const text = renderVarietyReport(worn, history, {}, NOW);
  const lines = text.split('\n');
  assert.equal(lines[0], 'variety: on · 2 patterns from 5 lines · 0m old');
  assert.equal(lines[1], 'latest (2026-10-01 12:00 UTC):');
  assert.equal(lines[2], '  - mock promise ending in (no) x2: "promise to behave (no)", "fix it (no)"');
  assert.equal(lines[4], 'history (2, newest first):');
  assert.equal(lines[5], '  2026-10-01 12:00 · 5 lines · mock promise ending in (no) x2');
  assert.equal(lines[6], '  2026-10-01 11:00 · 4 lines · old device x2');
  assert.ok(renderVarietyReport(null, [], {}, NOW).endsWith('history: none'));
});

// ---- the <worn> block in a persona request --------------------------------------------------------

function requestInput(overrides = {}) {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { gapMarkerMinutes: 20, maxMessageChars: 800, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 }, vision: {} },
      features: {},
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      memory: {},
      ...overrides.config,
    },
    prompts: { 'system-prompt': 'S', 'character-card': 'C', format: 'F', reply: 'R', interject: 'I', initiate: 'N', labels, ...overrides.prompts },
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'interject',
    now: NOW,
    selfName: 'Nept',
    history: overrides.history ?? [msg('1', 1, 'hello there')],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    worn: PATTERNS,
    ...overrides.input,
  };
}

function wornOf(request) {
  const user = request.messages[1].content;
  const match = /<worn>\n([\s\S]*?)\n<\/worn>/.exec(user);
  return match ? match[1] : null;
}

test('buildRequest: the <worn> block renders the patterns, right before the chat', () => {
  const request = buildRequest(requestInput());
  assert.equal(wornOf(request), renderWorn(PATTERNS, labels, {}));
  const user = request.messages[1].content;
  assert.ok(user.indexOf('</worn>') < user.indexOf('<chat>'));
  assert.equal(request.stats.worn.kept, 1);
});

test('buildRequest: no <worn> block for no patterns, the switch off, or labels without variety.intro', () => {
  assert.equal(wornOf(buildRequest(requestInput({ input: { worn: null } }))), null);
  assert.equal(wornOf(buildRequest(requestInput({ input: { worn: [] } }))), null);
  assert.equal(wornOf(buildRequest(requestInput({ config: { features: { variety: false } } }))), null);
  const { variety: _omit, ...older } = labels;
  assert.equal(wornOf(buildRequest(requestInput({ prompts: { labels: older } }))), null);
});

test('buildRequest: <worn> is trimmed after the chat and the people, before the neighbours, emoji and gifs', () => {
  const order = Object.keys(buildRequest(requestInput()).stats);
  assert.ok(order.indexOf('chat') < order.indexOf('worn'));
  assert.ok(order.indexOf('people') < order.indexOf('worn'));
  assert.ok(order.indexOf('worn') < order.indexOf('neighbors'));
  assert.ok(order.indexOf('worn') < order.indexOf('emoji'));
});

test('buildRequest: in a tight budget the chat keeps its room first; <worn> goes whole when nothing is left', () => {
  // Many short chat lines and a long list: the chat takes the room, the list does not fit and goes whole.
  const history = Array.from({ length: 400 }, (_, i) => msg(String(i + 1), 400 - i, 'λόγια'));
  const big = Array.from({ length: 4 }, (_, i) => ({ shape: `device ${i} ${'ξ'.repeat(120)}`, examples: ['ψ'.repeat(80), 'ω'.repeat(80)], count: 2 }));
  const config = { llm: { maxRequestTokens: 3000, safetyMargin: 0.9 }, variety: { maxPatterns: 4 } };
  const request = buildRequest(requestInput({ history, config, input: { worn: big } }));
  assert.ok(request.stats.chat.dropped > 0, 'the chat is trimmed');
  assert.deepEqual([request.stats.worn.kept, request.stats.worn.dropped], [0, 1]);
  assert.equal(wornOf(request), null);
});

// ---- the live pass ---------------------------------------------------------------------------------

function liveHot({ features = {}, variety = {}, prompts = {} } = {}) {
  return {
    config: { features, variety, classifier: { text: 'x/classifier' }, llm: {} },
    prompts: { variety: PROMPT, labels, ...prompts },
  };
}

function fakeLlm(respond = () => answer([{ shape: 'names what was said', examples: ['what a surprise'], count: 2 }])) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      const text = await respond(messages, options);
      return { text, usage: {}, estimated: 10 };
    },
  };
}

function ownHistory() {
  return [
    own('a1', 20, 'Crêpes again, what a surprise'),
    msg('q', 15, 'meeting at five'),
    own('a2', 14, 'what a surprise, another meeting', { replyToId: 'q' }),
    own('a3', 3, 'I will promise to behave (no)'),
  ];
}

function liveSetup({ hot = liveHot(), llm = fakeLlm(), store = createStore({ dataDir: tmpDataDir() }) } = {}) {
  let clock = NOW;
  const pass = createVarietyPass({ hot, store, llm, now: () => clock });
  return { pass, hot, llm, store, advance: (ms) => (clock += ms) };
}

const TURN = { guildId: 'g1', channelId: 'c1', selfName: 'Nept' };

test('forTurn: runs the pass on the classifier.text model with the rails, stores the list and one history entry', async () => {
  const { pass, llm, store } = liveSetup();
  const patterns = await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.deepEqual(patterns, [{ shape: 'names what was said', examples: ['what a surprise'], count: 2 }]);
  assert.equal(llm.calls.length, 1);
  const { messages, options } = llm.calls[0];
  assert.equal(messages[0].content, 'VARIETY for Nept, at most 4 patterns of 140 characters.');
  assert.equal(messages[1].content, '<lines>\n#1 Crêpes again, what a surprise\n#2 what a surprise, another meeting (to: meeting at five)\n#3 I will promise to behave (no)\n</lines>');
  assert.equal(options.model, 'x/classifier');
  assert.equal(options.role, 'classifier.text');
  assert.equal(options.maxOutputTokens, 500);
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.skipCalibration, true);
  assert.ok(options.signal instanceof AbortSignal);
  const guild = store.getGuild('g1');
  assert.equal(guild.worn.lines, 3);
  assert.deepEqual(guild.worn.patterns, patterns);
  assert.equal(guild.wornHistory.length, 1);
  assert.deepEqual(guild.wornHistory[0].patterns, [{ shape: 'names what was said', count: 2 }]);
});

test('forTurn: the same lines again reuse the answer without a request; a new line asks again', async () => {
  const { pass, llm, store } = liveSetup();
  await pass.forTurn({ ...TURN, history: ownHistory() });
  const { result, logs } = await withCapturedLogs(() => pass.forTurn({ ...TURN, history: ownHistory() }));
  assert.equal(llm.calls.length, 1, 'a cache hit makes no request');
  assert.equal(result.length, 1);
  const line = logs.find((l) => l.msg === 'variety: turn');
  assert.equal(line.cached, true);
  assert.equal(store.getGuild('g1').wornHistory.length, 1, 'a cache hit adds no history entry');

  await pass.forTurn({ ...TURN, history: [...ownHistory(), own('a4', 1, 'what a surprise indeed')] });
  assert.equal(llm.calls.length, 2);
});

test('forTurn: after a restart the stored list serves the same lines without a request', async () => {
  const dir = tmpDataDir();
  const first = liveSetup({ store: createStore({ dataDir: dir }) });
  await first.pass.forTurn({ ...TURN, history: ownHistory() });
  first.store.flush();

  const second = liveSetup({ store: createStore({ dataDir: dir }) });
  const patterns = await second.pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(second.llm.calls.length, 0);
  assert.equal(patterns[0].shape, 'names what was said');
});

test('forTurn: fewer than minLines own lines -> no pass, no block', async () => {
  const { pass, llm } = liveSetup();
  const { result, logs } = await withCapturedLogs(() => pass.forTurn({ ...TURN, history: ownHistory().slice(0, 2) }));
  assert.equal(result, null);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(
    logs.filter((l) => l.msg === 'variety: skipped').map((l) => [l.reason, l.lines]),
    [['few-lines', 1]],
  );
});

test('forTurn: lines older than recentMinutes do not count; other channels from the ring fill in', async () => {
  const { pass, llm, store } = liveSetup({ hot: liveHot({ variety: { recentMinutes: 10 } }) });
  assert.equal(await pass.forTurn({ ...TURN, history: ownHistory() }), null, 'only one line of the channel is recent');
  store.pushOwnLine('g1', { id: 'b1', ts: NOW - 2 * MIN, channelId: 'c2', text: 'what a surprise twice' }, 12);
  store.pushOwnLine('g1', { id: 'b2', ts: NOW - MIN, channelId: 'c2', text: 'Crêpes forever' }, 12);
  await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].messages[1].content, '<lines>\n#1 I will promise to behave (no)\n#2 what a surprise twice\n#3 Crêpes forever\n</lines>');
});

test('forTurn: the switch off -> nothing, and record stores nothing', async () => {
  const { pass, llm, store } = liveSetup({ hot: liveHot({ features: { variety: false } }) });
  assert.equal(await pass.forTurn({ ...TURN, history: ownHistory() }), null);
  assert.equal(pass.record('g1', { id: 'm', ts: NOW, channelId: 'c1', text: 'x' }), false);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(store.getGuild('g1').ownLines, []);
});

test('forTurn: a missing prompt is logged once and nothing is asked', async () => {
  const { pass, llm } = liveSetup({ hot: liveHot({ prompts: { variety: undefined } }) });
  const { logs } = await withCapturedLogs(async () => {
    await pass.forTurn({ ...TURN, history: ownHistory() });
    await pass.forTurn({ ...TURN, history: ownHistory() });
  });
  assert.equal(llm.calls.length, 0);
  assert.equal(logs.filter((l) => l.msg === 'variety: skipped' && l.reason === 'no-prompt').length, 1);
});

test('forTurn: a pass slower than variety.timeoutMs is cut off; the turn gets null in time', async () => {
  const llm = fakeLlm(
    (messages, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  );
  const { pass, store } = liveSetup({ hot: liveHot({ variety: { timeoutMs: 30 } }), llm });
  const started = Date.now();
  const { result, logs } = await withCapturedLogs(() => pass.forTurn({ ...TURN, history: ownHistory() }));
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2000);
  assert.equal(logs.find((l) => l.msg === 'variety: pass failed').reason, 'timeout');
  assert.equal(store.getGuild('g1').worn, null);
});

test('forTurn: a failed request or an answer that is not JSON -> null, the latest list stays', async () => {
  let mode = 'ok';
  const llm = fakeLlm(() => {
    if (mode === 'fail') throw Object.assign(new Error('boom'), { statusCode: 502 });
    if (mode === 'junk') return 'no json at all';
    return answer([{ shape: 'names what was said', examples: ['what a surprise'] }]);
  });
  const { pass, store } = liveSetup({ llm });
  await pass.forTurn({ ...TURN, history: ownHistory() });
  const before = store.getGuild('g1').worn;
  mode = 'fail';
  assert.equal(await pass.forTurn({ ...TURN, history: [...ownHistory(), own('a5', 1, 'new one')] }), null);
  mode = 'junk';
  assert.equal(await pass.forTurn({ ...TURN, history: [...ownHistory(), own('a6', 1, 'newer one')] }), null);
  assert.deepEqual(store.getGuild('g1').worn, before);
  assert.equal(store.getGuild('g1').wornHistory.length, 1);
});

test('forTurn: a private chat\'s pass is used for the turn but never stored', async () => {
  const { pass, store } = liveSetup();
  const patterns = await pass.forTurn({ ...TURN, history: ownHistory(), privateChat: true });
  assert.equal(patterns.length, 1);
  assert.equal(store.getGuild('g1').worn, null);
  assert.deepEqual(store.getGuild('g1').wornHistory, []);
});

test("forTurn: a private chat's pass never displaces the guild's cached pass, and keeps one of its own", async () => {
  const { pass, llm } = liveSetup();
  await pass.forTurn({ ...TURN, history: ownHistory() });
  const dm = ['only here, what a surprise', 'and again (no)', 'still just us'].map((text, i) =>
    own(`d${i}`, 5 - i, text, { channelId: 'dm1' }),
  );
  const privateTurn = { guildId: 'g1', channelId: 'dm1', selfName: 'Nept', history: dm, privateChat: true };
  await pass.forTurn(privateTurn);
  assert.equal(llm.calls.length, 2);

  await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(llm.calls.length, 2, 'the public lines are still a cache hit');
  await pass.forTurn(privateTurn);
  assert.equal(llm.calls.length, 2, 'the private lines too, under their own key');
});

test('forTurn: logs carry counts, never the lines, the examples or the shapes', async () => {
  const { pass } = liveSetup();
  const { logs } = await withCapturedLogs(() => pass.forTurn({ ...TURN, history: ownHistory() }));
  const line = logs.find((l) => l.msg === 'variety: turn');
  assert.deepEqual(
    { lines: line.lines, cached: line.cached, parse: line.parse, kept: line.kept, dropped: line.dropped },
    { lines: 3, cached: false, parse: 'ok', kept: 1, dropped: 0 },
  );
  const all = JSON.stringify(logs);
  for (const secret of ['surprise', 'Crêpes', 'promise', 'names what was said', 'meeting']) assert.ok(!all.includes(secret), secret);
});

test('record: a line joins the ring (server channels only), never while paused', () => {
  const { pass, store } = liveSetup();
  assert.equal(pass.record('g1', { id: 'm1', ts: NOW, channelId: 'c1', text: 'γεια', to: 'hi' }), true);
  assert.equal(pass.record(null, { id: 'm2', ts: NOW, channelId: 'dm', text: 'private' }), false);
  store.state.data.paused = true;
  assert.equal(pass.record('g1', { id: 'm3', ts: NOW, channelId: 'c1', text: 'later' }), false);
  assert.deepEqual(store.getGuild('g1').ownLines.map((l) => l.id), ['m1']);
});

test('forTurn: a pass that finishes while paused is used for the turn but nothing is written', async () => {
  const { pass, store } = liveSetup();
  store.state.data.paused = true;
  const patterns = await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(patterns.length, 1);
  assert.equal(store.getGuild('g1').worn, null);
});

test('forTurn: a limit notice the bot posted is not one of the persona\'s lines', async () => {
  const { pass, llm } = liveSetup();
  const notice = labels.limits.notice.replace('{limit}', 'llm.maxRequestsPerDay').replace('{used}', '300').replace('{cap}', '300');
  const history = [...ownHistory().slice(0, 3), own('n1', 2, notice)];
  assert.equal(await pass.forTurn({ ...TURN, history }), null, 'two real lines and a notice are fewer than minLines');
  assert.equal(llm.calls.length, 0);
});
