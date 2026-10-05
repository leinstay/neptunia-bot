// Tests for src/behavior/variety.js (the pure core of the variety pass) and
// src/behavior/variety-pass.js (the live pass: at a turn, and ahead right after
// the persona posts), with the store's variety fields on a real store in a temp
// directory. Fakes only: no network, no real prompts/ or data/. A fake request
// that waits for the test is always settled before the test ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  VARIETY_DEFAULTS,
  appendOwnLine,
  appendWornHistory,
  buildVarietyRequest,
  linesKey,
  longPassDue,
  mergeWorn,
  normalizeOwnLines,
  normalizeWorn,
  normalizeWornLong,
  parseVariety,
  renderVarietyReport,
  renderWorn,
  selectLongLines,
  selectOwnLines,
  varietySettings,
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

test('varietySettings: live values are read, garbage falls back to the defaults', () => {
  const live = varietySettings({ variety: { window: 5, recentMinutes: 10, minLines: 2, contextChars: 0, maxPatterns: 1, history: 0 } });
  assert.equal(live.window, 5);
  assert.equal(live.recentMinutes, 10);
  assert.equal(live.minLines, 2);
  assert.equal(live.contextChars, 0);
  assert.equal(live.maxPatterns, 1);
  assert.equal(live.history, 0);
  const broken = varietySettings({ variety: { window: 'many', minLines: -1, timeoutMs: null, shapeChars: 1 } });
  assert.equal(broken.window, VARIETY_DEFAULTS.window);
  assert.equal(broken.minLines, VARIETY_DEFAULTS.minLines);
  assert.equal(broken.timeoutMs, VARIETY_DEFAULTS.timeoutMs);
  assert.equal(broken.shapeChars, VARIETY_DEFAULTS.shapeChars);
});

test('config.json: the variety block and features.varietyPrecompute equal the code defaults', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.variety, { ...VARIETY_DEFAULTS });
  assert.equal(config.features.varietyPrecompute, true);
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

test('selectOwnLines: a turn-channel line that slid out of the history comes from the ring, after the history and before other channels', () => {
  const ring = [
    { id: 'a0', ts: NOW - 40 * MIN, channelId: 'c1', text: 'slid out' },
    { id: 'a1', ts: NOW - 30 * MIN, channelId: 'c1', text: 'ένα' },
    { ts: NOW - 20 * MIN, channelId: 'c1', text: 'no id, cannot be told from its history copy' },
    { id: 'b1', ts: NOW - 2 * MIN, channelId: 'c2', text: 'τρία' },
    { id: 'old', ts: NOW - 90 * MIN, channelId: 'c1', text: 'too old' },
  ];
  const history = [own('a1', 30, 'ένα'), msg('x', 29, 'hi'), own('a2', 5, 'δύο')];
  const lines = selectOwnLines({ history, ring, channelId: 'c1', now: NOW, window: 3, recentMinutes: 45 });
  assert.deepEqual(lines.map((l) => l.id), ['a0', 'a1', 'a2'], 'the slid line fills the window before another channel');
  const wider = selectOwnLines({ history, ring, channelId: 'c1', now: NOW, window: 8, recentMinutes: 45 });
  assert.deepEqual(wider.map((l) => l.id), ['a0', 'a1', 'a2', 'b1'], 'each line once, the stale one left out');
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

// ---- the request -------------------------------------------------------------------

test('buildVarietyRequest: system fills name and maxPatterns; one <lines> block, numbered, with the answered line clipped', () => {
  const lines = [
    { id: '1', ts: 1, text: 'first\nline', to: 'ζ'.repeat(200) },
    { id: '2', ts: 2, text: 'second' },
  ];
  const request = buildVarietyRequest({ prompt: PROMPT, selfName: 'Nept', lines, config: { variety: { contextChars: 10, maxPatterns: 3, shapeChars: 140 } } });
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

test('renderWorn: at most variety.maxPatterns + variety.longMaxPatterns lines, read now', () => {
  assert.equal(renderWorn(PATTERNS, labels, { variety: { maxPatterns: 1, longMaxPatterns: 0 } }).split('\n').length, 2);
  assert.equal(renderWorn(PATTERNS, labels, { variety: { maxPatterns: 0, longMaxPatterns: 1 } }).split('\n').length, 2);
  assert.equal(renderWorn(PATTERNS, labels, { variety: { maxPatterns: 1, longMaxPatterns: 1 } }).split('\n').length, 3);
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

// The variety settings the live tests rely on, pinned here instead of read from the shipped defaults.
const BASE_VARIETY = { window: 16, recentMinutes: 180, minLines: 3, contextChars: 120, maxPatterns: 4, shapeChars: 140, maxOutputTokens: 500, timeoutMs: 8000, requestTimeoutMs: 30000 };

function liveHot({ features = {}, variety = {}, prompts = {} } = {}) {
  return {
    config: { features, variety: { ...BASE_VARIETY, ...variety }, classifier: { text: 'x/classifier' }, llm: {} },
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

/**
 * A fake llm whose requests wait for the test: `calls[i].answer(text)` or
 * `calls[i].fail(err)` settles one; an abort of its signal rejects it the way
 * the real client does.
 */
function deferredLlm() {
  const calls = [];
  return {
    calls,
    complete: (messages, options) =>
      new Promise((resolve, reject) => {
        calls.push({
          messages,
          options,
          answer: (text) => resolve({ text, usage: {}, estimated: 10 }),
          fail: (err) => reject(err),
        });
        options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  };
}

/** Lets every promise chain that is already free to run finish (a fake answer lands within microtasks). */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ANSWER = answer([{ shape: 'names what was said', examples: ['what a surprise'], count: 2 }]);

function ownHistory() {
  return [
    own('a1', 20, 'Crêpes again, what a surprise'),
    msg('q', 15, 'meeting at five'),
    own('a2', 14, 'what a surprise, another meeting', { replyToId: 'q' }),
    own('a3', 3, 'I will promise to behave (no)'),
  ];
}

/** ownHistory() and one more own line `id`: another set of lines, so another key. */
function historyPlus(id) {
  return [...ownHistory(), own(id, 1, `what a surprise, ${id}`)];
}

/** The key of the pass a turn in `c1` would run on `history` with an empty ring and the pinned settings. */
function keyOf(history) {
  const { window, recentMinutes } = BASE_VARIETY;
  return linesKey(selectOwnLines({ history, ring: [], channelId: 'c1', now: NOW, window, recentMinutes }));
}

/** The log fields of one entry without the logger's own (`level`, `time`, `msg`), keys sorted. */
function fieldsOf(entry) {
  return Object.keys(entry).filter((k) => !['level', 'time', 'msg'].includes(k)).sort();
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
  assert.equal(options.timeoutMs, 30000, 'each attempt is cut at variety.requestTimeoutMs');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.purpose, 'variety', 'named on the usage line');
  assert.equal(options.long, true, 'a list of patterns: the long hedge limit');
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
  assert.equal(line.source, 'cache');
  assert.equal(store.getGuild('g1').wornHistory.length, 1, 'a cache hit adds no history entry');

  await pass.forTurn({ ...TURN, history: [...ownHistory(), own('a4', 1, 'what a surprise indeed')] });
  assert.equal(llm.calls.length, 2);
});

test('forTurn: after a restart the stored list serves the same lines without a request; a pass landing later replaces it', async () => {
  const dir = tmpDataDir();
  const first = liveSetup({ store: createStore({ dataDir: dir }) });
  await first.pass.forTurn({ ...TURN, history: ownHistory() });
  first.store.flush();

  const second = liveSetup({ store: createStore({ dataDir: dir }) });
  const patterns = await second.pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(second.llm.calls.length, 0);
  assert.equal(patterns[0].shape, 'names what was said');

  // The list kept from before the restart counts as started before any pass of this process.
  const storedKey = second.store.getGuild('g1').worn.key;
  await second.pass.forTurn({ ...TURN, history: historyPlus('a9') });
  assert.equal(second.llm.calls.length, 1);
  const guild = second.store.getGuild('g1');
  assert.notEqual(guild.worn.key, storedKey);
  assert.equal(guild.worn.key, keyOf(historyPlus('a9')));
  assert.equal(guild.wornHistory.length, 2);
  const { logs } = await withCapturedLogs(() => second.pass.forTurn({ ...TURN, history: historyPlus('a9') }));
  assert.equal(second.llm.calls.length, 1, 'the new lines are served from the cache');
  assert.equal(logs.find((l) => l.msg === 'variety: turn').source, 'cache');
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
  const skipped = logs.filter((l) => l.msg === 'variety: skipped' && l.reason === 'no-prompt');
  assert.deepEqual(skipped.map((l) => l.cause), ['turn']);
});

test('forTurn: a pass slower than variety.timeoutMs leaves the turn without a block in time; the request is not cut, lands and serves the next turn', async () => {
  const llm = deferredLlm();
  const { pass, store } = liveSetup({ hot: liveHot({ variety: { timeoutMs: 30 } }), llm });
  const started = Date.now();
  const { result, logs } = await withCapturedLogs(() => pass.forTurn({ ...TURN, history: ownHistory() }));
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2000, 'the turn stops waiting at variety.timeoutMs');
  const turn = logs.find((l) => l.msg === 'variety: turn');
  assert.deepEqual([turn.source, turn.cached, turn.late, turn.kept], ['request', false, true, 0]);
  assert.equal(typeof turn.waitedMs, 'number');
  assert.equal(logs.find((l) => l.msg === 'variety: pass failed'), undefined);
  assert.equal(llm.calls[0].options.signal.aborted, false, 'the request keeps running');
  assert.equal(llm.calls[0].options.timeoutMs, 30000, 'its own cut is variety.requestTimeoutMs');

  const landing = await withCapturedLogs(async () => {
    llm.calls[0].answer(ANSWER);
    await settle();
  });
  const passLine = landing.logs.find((l) => l.msg === 'variety: pass');
  assert.deepEqual([passLine.cause, passLine.parse, passLine.landed, passLine.stored], ['turn', 'ok', true, true]);
  assert.equal(store.getGuild('g1').worn.lines, 3, 'the late answer is stored');
  assert.equal(store.getGuild('g1').wornHistory.length, 1);

  const next = await withCapturedLogs(() => pass.forTurn({ ...TURN, history: ownHistory() }));
  assert.equal(llm.calls.length, 1, 'the next turn makes no request');
  assert.equal(next.result.length, 1);
  assert.equal(next.logs.find((l) => l.msg === 'variety: turn').source, 'cache');
});

test('forTurn: a pass slower than variety.requestTimeoutMs is cut there and nothing is stored', async () => {
  const llm = deferredLlm();
  const { pass, store } = liveSetup({ hot: liveHot({ variety: { timeoutMs: 5000, requestTimeoutMs: 30 } }), llm });
  const started = Date.now();
  const { result, logs } = await withCapturedLogs(() => pass.forTurn({ ...TURN, history: ownHistory() }));
  assert.equal(result, null);
  assert.ok(Date.now() - started < 2000, 'a cut request ends the wait');
  assert.equal(llm.calls[0].options.timeoutMs, 30);
  assert.equal(llm.calls[0].options.signal.aborted, true);
  const failed = logs.find((l) => l.msg === 'variety: pass failed');
  assert.deepEqual([failed.reason, failed.cause], ['timeout', 'turn']);
  const turn = logs.find((l) => l.msg === 'variety: turn');
  assert.deepEqual([turn.source, turn.kept, turn.late], ['request', 0, undefined]);
  assert.equal(store.getGuild('g1').worn, null);
  assert.deepEqual(store.getGuild('g1').wornHistory, []);
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

test('forTurn: logs carry counts and codes, never the lines, the examples or the shapes', async () => {
  const { pass } = liveSetup();
  const { logs } = await withCapturedLogs(async () => {
    await pass.forTurn({ ...TURN, history: ownHistory() });
    await pass.ahead({ ...TURN, history: ownHistory().slice(0, 2) });
  });
  const line = logs.find((l) => l.msg === 'variety: turn');
  assert.deepEqual(
    { lines: line.lines, source: line.source, cached: line.cached, parse: line.parse, kept: line.kept, dropped: line.dropped, stored: line.stored },
    { lines: 3, source: 'request', cached: false, parse: 'ok', kept: 1, dropped: 0, stored: true },
  );
  assert.equal(typeof line.waitedMs, 'number');
  assert.equal(line.late, undefined, 'only a turn whose wait ran out says late');
  const passLine = logs.find((l) => l.msg === 'variety: pass');
  assert.deepEqual(fieldsOf(passLine), ['cause', 'channel', 'dropped', 'kept', 'landed', 'lines', 'ms', 'parse', 'stored']);
  assert.deepEqual(
    [passLine.channel, passLine.cause, passLine.lines, passLine.parse, passLine.kept, passLine.dropped, passLine.stored, passLine.landed],
    ['c1', 'turn', 3, 'ok', 1, 0, true, true],
  );
  assert.equal(typeof passLine.ms, 'number');
  const skipped = logs.find((l) => l.msg === 'variety: skipped');
  assert.deepEqual([skipped.reason, skipped.cause, skipped.lines], ['few-lines', 'ahead', 1]);
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
  const { pass, store, llm } = liveSetup();
  store.state.data.paused = true;
  const patterns = await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(patterns.length, 1);
  assert.equal(store.getGuild('g1').worn, null);
  store.state.data.paused = false;
  await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(llm.calls.length, 2, 'no cache entry was kept while paused either');
});

test('forTurn: a limit notice the bot posted is not one of the persona\'s lines', async () => {
  const { pass, llm } = liveSetup();
  const notice = labels.limits.notice.replace('{limit}', 'llm.maxRequestsPerDay').replace('{used}', '300').replace('{cap}', '300');
  const history = [...ownHistory().slice(0, 3), own('n1', 2, notice)];
  assert.equal(await pass.forTurn({ ...TURN, history }), null, 'two real lines and a notice are fewer than minLines');
  assert.equal(llm.calls.length, 0);
});

// ---- the pass ahead, joins and late landings -------------------------------------------------------

test('ahead: one request on the lines the next turn will see; that turn uses it without a request', async () => {
  const { pass, llm, store } = liveSetup();
  const { result, logs } = await withCapturedLogs(async () => {
    await pass.ahead({ ...TURN, history: ownHistory() });
    return pass.forTurn({ ...TURN, history: ownHistory() });
  });
  assert.equal(llm.calls.length, 1, 'one request, made ahead');
  assert.deepEqual(result, [{ shape: 'names what was said', examples: ['what a surprise'], count: 2 }]);
  const passLine = logs.find((l) => l.msg === 'variety: pass');
  assert.deepEqual([passLine.cause, passLine.landed, passLine.stored], ['ahead', true, true]);
  const turn = logs.find((l) => l.msg === 'variety: turn');
  assert.deepEqual([turn.source, turn.cached, turn.kept], ['cache', true, 1]);
  assert.equal(store.getGuild('g1').worn.lines, 3);
  assert.equal(store.getGuild('g1').wornHistory.length, 1);
});

test('ahead: an own line that slid out of the next turn\'s history keeps the key, so the pass ahead serves that turn', async () => {
  const { pass, llm } = liveSetup();
  const history = ownHistory();
  for (const line of history.filter((m) => m.self)) pass.record('g1', { id: line.id, ts: line.ts, channelId: 'c1', text: line.content });
  await pass.ahead({ ...TURN, history });
  assert.equal(llm.calls.length, 1);

  // Others wrote; the next fetch no longer reaches the oldest own line.
  const slid = [...history.filter((m) => m.id !== 'a1'), msg('y1', 2, 'and then'), msg('y2', 1, 'καλά')];
  const { result, logs } = await withCapturedLogs(() => pass.forTurn({ ...TURN, history: slid }));
  assert.equal(llm.calls.length, 1, 'no second request');
  assert.equal(result.length, 1);
  assert.equal(logs.find((l) => l.msg === 'variety: turn').source, 'cache');
});

test('ahead: lines already answered or in flight start no second request', async () => {
  const llm = deferredLlm();
  const { pass } = liveSetup({ llm });
  const first = pass.ahead({ ...TURN, history: ownHistory() });
  const second = pass.ahead({ ...TURN, history: ownHistory() });
  assert.equal(llm.calls.length, 1, 'the same lines in flight');
  llm.calls[0].answer(ANSWER);
  await Promise.all([first, second]);
  await pass.ahead({ ...TURN, history: ownHistory() });
  assert.equal(llm.calls.length, 1, 'the same lines answered');
  const third = pass.ahead({ ...TURN, history: historyPlus('a9') });
  assert.equal(llm.calls.length, 2, 'a new line asks again');
  llm.calls[1].answer(ANSWER);
  await third;
});

test('ahead: nothing with features.varietyPrecompute off, features.variety off, or while paused', async () => {
  for (const features of [{ varietyPrecompute: false }, { variety: false }]) {
    const { pass, llm } = liveSetup({ hot: liveHot({ features }) });
    assert.equal(await pass.ahead({ ...TURN, history: ownHistory() }), undefined);
    assert.equal(llm.calls.length, 0, JSON.stringify(features));
  }
  const paused = liveSetup();
  paused.store.state.data.paused = true;
  await paused.pass.ahead({ ...TURN, history: ownHistory() });
  assert.equal(paused.llm.calls.length, 0, 'paused');

  // Precompute off: the turn still asks for itself and its answer serves the next turn.
  const atTurn = liveSetup({ hot: liveHot({ features: { varietyPrecompute: false } }) });
  await atTurn.pass.forTurn({ ...TURN, history: ownHistory() });
  await atTurn.pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(atTurn.llm.calls.length, 1);
  assert.equal(atTurn.store.getGuild('g1').worn.lines, 3);
});

test('forTurn: a turn joins the pass in flight on the same lines and waits at most variety.timeoutMs from its own call', async () => {
  const llm = deferredLlm();
  const { pass, advance } = liveSetup({ hot: liveHot({ variety: { timeoutMs: 150 } }), llm });
  const { logs } = await withCapturedLogs(async () => {
    const ahead = pass.ahead({ ...TURN, history: ownHistory() });
    const started = Date.now();
    assert.equal(await pass.forTurn({ ...TURN, history: ownHistory() }), null, 'the wait ran out');
    assert.ok(Date.now() - started < 2000);
    assert.equal(llm.calls[0].options.signal.aborted, false, 'the pass keeps running');
    // The pass is now older than variety.timeoutMs, in real time and on the injected clock. A turn
    // joining it still waits variety.timeoutMs from its own call, so an answer some time later
    // serves it; measured from the pass's start, its wait would already be over.
    await delay(30);
    advance(200);
    const joined = pass.forTurn({ ...TURN, history: ownHistory() });
    await delay(25);
    advance(25);
    llm.calls[0].answer(ANSWER);
    assert.equal((await joined)?.length, 1, 'the joined pass answers the turn');
    await ahead;
  });
  assert.equal(llm.calls.length, 1, 'no second request');
  const turns = logs.filter((l) => l.msg === 'variety: turn');
  assert.deepEqual(
    turns.map((l) => [l.source, l.cached, l.late ?? false, l.kept]),
    [
      ['joined', true, true, 0],
      ['joined', true, false, 1],
    ],
  );
  assert.equal(turns[1].late, undefined);
  assert.equal(turns[1].waitedMs, 25, "waitedMs counts from the turn's own call");
  const passes = logs.filter((l) => l.msg === 'variety: pass');
  assert.deepEqual(passes.map((l) => [l.cause, l.landed]), [['ahead', true]]);
});

test('forTurn: a turn that joined a pass which then fails gets no block and starts no request of its own', async () => {
  const llm = deferredLlm();
  const { pass, store } = liveSetup({ llm });
  const { result, logs } = await withCapturedLogs(async () => {
    const ahead = pass.ahead({ ...TURN, history: ownHistory() });
    const joined = pass.forTurn({ ...TURN, history: ownHistory() });
    llm.calls[0].fail(Object.assign(new Error('boom'), { statusCode: 502 }));
    await ahead;
    return joined;
  });
  assert.equal(result, null);
  assert.equal(llm.calls.length, 1);
  const failed = logs.find((l) => l.msg === 'variety: pass failed');
  assert.deepEqual([failed.cause, failed.reason, failed.status], ['ahead', 'error', 502]);
  const turn = logs.find((l) => l.msg === 'variety: turn');
  assert.deepEqual([turn.source, turn.cached, turn.kept], ['joined', true, 0]);
  assert.equal(store.getGuild('g1').worn, null);
});

test('ahead: a pass landing while paused or after features.variety was turned off stores nothing', async () => {
  const turnOffs = [
    (setup) => {
      setup.store.state.data.paused = true;
    },
    (setup) => {
      setup.hot.config.features.variety = false;
    },
  ];
  for (const turnOff of turnOffs) {
    const llm = deferredLlm();
    const setup = liveSetup({ llm });
    const { logs } = await withCapturedLogs(async () => {
      const ahead = setup.pass.ahead({ ...TURN, history: ownHistory() });
      turnOff(setup);
      llm.calls[0].answer(ANSWER);
      await ahead;
    });
    const line = logs.find((l) => l.msg === 'variety: pass');
    assert.deepEqual([line.parse, line.landed, line.stored], ['ok', false, false]);
    const guild = setup.store.getGuild('g1');
    assert.equal(guild.worn, null);
    assert.deepEqual(guild.wornHistory, []);
    // Back on: no cache entry was kept, so the same lines ask again.
    setup.store.state.data.paused = false;
    setup.hot.config.features.variety = true;
    const again = setup.pass.forTurn({ ...TURN, history: ownHistory() });
    assert.equal(llm.calls.length, 2, 'no cache entry');
    llm.calls[1].answer(ANSWER);
    await again;
  }
});

test('forTurn: an older pass that lands after a newer one never replaces it', async () => {
  const llm = deferredLlm();
  const { pass, store } = liveSetup({ llm });
  const older = pass.ahead({ ...TURN, history: ownHistory() });
  const newer = pass.ahead({ ...TURN, history: historyPlus('a9') });
  llm.calls[1].answer(answer([{ shape: 'newer device', examples: ['a9'] }]));
  await newer;
  const newerKey = store.getGuild('g1').worn.key;
  const { logs } = await withCapturedLogs(async () => {
    llm.calls[0].answer(ANSWER);
    await older;
  });
  const line = logs.find((l) => l.msg === 'variety: pass');
  assert.deepEqual([line.parse, line.landed, line.stored], ['ok', false, false]);
  assert.equal(store.getGuild('g1').worn.key, newerKey);
  assert.equal(store.getGuild('g1').wornHistory.length, 1);
  const patterns = await pass.forTurn({ ...TURN, history: historyPlus('a9') });
  assert.equal(llm.calls.length, 2, 'the newer lines are still served from the cache');
  assert.equal(patterns[0].shape, 'newer device');
});

test('forTurn: passes in flight are kept per key, at most four per slot; an evicted one keeps running, is not joined, and still lands', async () => {
  const llm = deferredLlm();
  const { pass, store } = liveSetup({ hot: liveHot({ variety: { timeoutMs: 20 } }), llm });
  const aheads = ['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => pass.ahead({ ...TURN, history: historyPlus(id) }));
  assert.equal(llm.calls.length, 5);
  await pass.forTurn({ ...TURN, history: historyPlus('b2') });
  assert.equal(llm.calls.length, 5, 'an older pass still in flight is joined, not asked again');
  await pass.forTurn({ ...TURN, history: historyPlus('b1') });
  assert.equal(llm.calls.length, 6, 'the evicted key asks again');
  assert.equal(llm.calls[0].options.signal.aborted, false, 'evicting never cancels a request');

  // The evicted pass (b1, the oldest started) answers first: it lands and is stored all the same.
  const { logs } = await withCapturedLogs(async () => {
    llm.calls[0].answer(ANSWER);
    await settle();
  });
  const line = logs.find((l) => l.msg === 'variety: pass');
  assert.deepEqual([line.cause, line.parse, line.landed, line.stored], ['ahead', 'ok', true, true]);
  assert.equal(store.getGuild('g1').worn.key, keyOf(historyPlus('b1')));
  for (const call of llm.calls.slice(1)) call.answer(ANSWER);
  await Promise.all(aheads);
  await settle();
});

test("ahead: a private chat's pass lands under that chat's own slot and is never stored", async () => {
  const { pass, llm, store } = liveSetup();
  const dm = ['only here, what a surprise', 'and again (no)', 'still just us'].map((text, i) =>
    own(`d${i}`, 5 - i, text, { channelId: 'dm1' }),
  );
  const privateTurn = { guildId: 'g1', channelId: 'dm1', selfName: 'Nept', history: dm, privateChat: true };
  await pass.ahead(privateTurn);
  assert.equal(llm.calls.length, 1);
  assert.equal(store.getGuild('g1').worn, null);
  assert.deepEqual(store.getGuild('g1').wornHistory, []);
  await pass.forTurn(privateTurn);
  assert.equal(llm.calls.length, 1, 'the private turn finds it ready');
  await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(llm.calls.length, 2, 'the guild slot is apart');
});

test('ahead: a failed or unparsable pass stores nothing; the next turn asks again', async () => {
  let mode = 'fail';
  const llm = fakeLlm(() => {
    if (mode === 'fail') throw Object.assign(new Error('boom'), { statusCode: 502 });
    if (mode === 'junk') return 'no json at all';
    return ANSWER;
  });
  const { pass, store } = liveSetup({ llm });
  const { logs } = await withCapturedLogs(async () => {
    await pass.ahead({ ...TURN, history: ownHistory() });
    mode = 'junk';
    await pass.ahead({ ...TURN, history: ownHistory() });
  });
  assert.equal(llm.calls.length, 2, 'a failure is never kept as an answer');
  const failed = logs.find((l) => l.msg === 'variety: pass failed');
  assert.deepEqual([failed.cause, failed.reason], ['ahead', 'error']);
  const junk = logs.find((l) => l.msg === 'variety: pass');
  assert.deepEqual([junk.cause, junk.parse, junk.landed, junk.stored], ['ahead', 'error', false, false]);
  assert.equal(store.getGuild('g1').worn, null);
  mode = 'ok';
  await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.equal(llm.calls.length, 3);
});

// ---- the long pass: pure parts -----------------------------------------------------------------------

test('varietySettings: the long keys are read live, garbage falls back, longLines 0 and longModel null are allowed', () => {
  const live = varietySettings({ variety: { longLines: 0, longEveryHours: 0.5, longMinLines: 7, longMaxPatterns: 0, longModel: ' x/long ' } });
  assert.deepEqual(
    [live.longLines, live.longEveryHours, live.longMinLines, live.longMaxPatterns, live.longModel],
    [0, 0.5, 7, 0, 'x/long'],
  );
  const broken = varietySettings({ variety: { longLines: -1, longEveryHours: 0, longMinLines: 0, longMaxPatterns: 'x', longModel: '  ' } });
  assert.deepEqual(
    [broken.longLines, broken.longEveryHours, broken.longMinLines, broken.longMaxPatterns, broken.longModel],
    [VARIETY_DEFAULTS.longLines, VARIETY_DEFAULTS.longEveryHours, VARIETY_DEFAULTS.longMinLines, VARIETY_DEFAULTS.longMaxPatterns, null],
  );
});

test('appendOwnLine: the ring keeps longLines; only the newest three windows keep what a line answered', () => {
  let ring = [];
  for (let i = 0; i < 30; i += 1) ring = appendOwnLine(ring, { id: String(i), ts: i, channelId: 'c', text: `t${i}`, to: `q${i}` }, 2, 20);
  assert.equal(ring.length, 20);
  assert.deepEqual([ring[0].id, ring[19].id], ['10', '29']);
  assert.deepEqual(ring.map((l) => 'to' in l), [...Array(14).fill(false), ...Array(6).fill(true)]);
  assert.deepEqual(ring[0], { id: '10', ts: 10, channelId: 'c', text: 't10' }, 'an older line keeps its own text, time and channel');
  // longLines below three windows: the short pass's ring wins.
  let short = [];
  for (let i = 0; i < 10; i += 1) short = appendOwnLine(short, { id: String(i), ts: i, text: `t${i}` }, 2, 3);
  assert.equal(short.length, 6);
});

test('selectOwnLines: a long ring still gives the short pass at most its window of recent lines', () => {
  let ring = [];
  for (let i = 0; i < 120; i += 1) ring = appendOwnLine(ring, { id: `r${i}`, ts: NOW - (120 - i) * MIN, channelId: 'c2', text: `λόγος ${i}` }, 16, 300);
  assert.equal(ring.length, 120);
  const lines = selectOwnLines({ ring, channelId: 'c1', now: NOW, window: 16, recentMinutes: 180 });
  assert.equal(lines.length, 16);
  assert.equal(lines[15].id, 'r119');
  assert.equal(selectOwnLines({ ring, channelId: 'c1', now: NOW, window: 16, recentMinutes: 10 }).length, 10, 'and only inside recentMinutes');
});

test('selectLongLines: the newest longLines of the ring, every channel, oldest first, without what they answered', () => {
  const ring = [
    { id: 'b', ts: 20, channelId: 'c2', text: 'two', to: 'x' },
    { id: 'a', ts: 10, channelId: 'c1', text: 'one' },
    { id: 'c', ts: 30, channelId: 'c1', text: 'three', to: 'y' },
    { ts: 40, text: '' },
  ];
  assert.deepEqual(selectLongLines(ring, 2), [
    { id: 'b', ts: 20, channelId: 'c2', text: 'two' },
    { id: 'c', ts: 30, channelId: 'c1', text: 'three' },
  ]);
  assert.equal(selectLongLines(ring, 10).length, 3);
  assert.deepEqual(selectLongLines(ring, 0), []);
});

test('longPassDue: never run is due; then only after longEveryHours since the later of the stored list and the last try', () => {
  const settings = varietySettings({ variety: { longEveryHours: 6 } });
  const hour = 60 * MIN;
  assert.equal(longPassDue({ wornLong: null, now: NOW, settings }), true);
  const wornLong = { at: NOW, lines: 70, patterns: [] };
  assert.equal(longPassDue({ wornLong, now: NOW + 6 * hour - 1, settings }), false);
  assert.equal(longPassDue({ wornLong, now: NOW + 6 * hour, settings }), true);
  assert.equal(longPassDue({ wornLong, triedAt: NOW + 2 * hour, now: NOW + 7 * hour, settings }), false, 'a failed try counts');
  assert.equal(longPassDue({ wornLong: null, triedAt: NOW, now: NOW + hour, settings }), false);
  assert.equal(longPassDue({ wornLong: null, now: NOW, settings: varietySettings({ variety: { longLines: 0 } }) }), false, 'longLines 0: never');
});

test('mergeWorn: the long patterns first, then the short ones, the same shape once (case and spaces ignored), capped', () => {
  const long = [
    { shape: 'ends a line on a word', examples: ['honestly'], count: 5 },
    { shape: 'Names  What Was Said', examples: ['what a surprise'], count: 3 },
  ];
  const short = [
    { shape: 'names what was said', examples: ['what a surprise'], count: 2 },
    { shape: 'mock promise ending in (no)', examples: ['fix it (no)'], count: 2 },
  ];
  assert.deepEqual(
    mergeWorn(long, short, {}).map((p) => p.shape),
    ['ends a line on a word', 'Names  What Was Said', 'mock promise ending in (no)'],
  );
  assert.deepEqual(mergeWorn(long, short, { variety: { maxPatterns: 1, longMaxPatterns: 1 } }).map((p) => p.shape), ['ends a line on a word', 'Names  What Was Said']);
  assert.deepEqual(mergeWorn(null, short, {}).map((p) => p.shape), ['names what was said', 'mock promise ending in (no)']);
  assert.equal(mergeWorn(long, null, {}).length, 2);
});

test('buildVarietyRequest / parseVariety: the long pass passes its own prompt and maxPatterns', () => {
  const lines = TEXTS.map((text, i) => ({ id: String(i), ts: i, channelId: 'c1', text }));
  const request = buildVarietyRequest({ prompt: 'LONG {{name}} {{maxPatterns}} {{shapeChars}}', selfName: 'Nept', lines, config: {}, maxPatterns: 2 });
  assert.equal(request.messages[0].content, 'LONG Nept 2 140');
  const three = answer([
    { shape: 'names what was said', examples: ['what a surprise'] },
    { shape: 'mock promise ending in (no)', examples: ['(no)'] },
    { shape: 'food first', examples: ['Crêpes'] },
  ]);
  const parsed = parseVariety(three, request.texts, {}, { maxPatterns: 2 });
  assert.deepEqual([parsed.patterns.length, parsed.dropped], [2, 1]);
  assert.equal(parseVariety(three, request.texts, { variety: { maxPatterns: 1 } }).patterns.length, 1, 'without it: variety.maxPatterns');
});

test('normalizeWornLong: { at, lines, patterns } or null', () => {
  assert.equal(normalizeWornLong(null), null);
  assert.equal(normalizeWornLong('x'), null);
  assert.deepEqual(normalizeWornLong({ at: 'x', lines: -1, patterns: [{ shape: 's', examples: [] }, { shape: 'ok', examples: ['e'] }] }), {
    at: null,
    lines: 0,
    patterns: [{ shape: 'ok', count: 2, examples: ['e'] }],
  });
});

test('renderVarietyReport: the long list shows under its own mark, with its examples; nothing when none ran', () => {
  const worn = { at: NOW - 5 * MIN, key: 'k', lines: 3, patterns: PATTERNS };
  const wornLong = { at: NOW - 60 * MIN, lines: 70, patterns: [{ shape: 'ends a line on a word', examples: ['honestly'], count: 5 }] };
  const report = renderVarietyReport(worn, [], {}, NOW, wornLong).split('\n');
  const at = report.indexOf('long (2026-10-01 11:00 UTC, 70 lines):');
  assert.ok(at > report.indexOf('latest (2026-10-01 11:55 UTC):'), report.join('\n'));
  assert.equal(report[at + 1], '  - ends a line on a word x5: "honestly"');
  assert.equal(renderVarietyReport(worn, [], {}, NOW, { at: NOW, lines: 70, patterns: [] }).split('\n').includes('  (nothing named)'), true);
  assert.ok(!renderVarietyReport(worn, [], {}, NOW).includes('long ('));
});

test('store: setWornLong persists across a restart without stamping updatedAt; updateGuild never overwrites it; broken loads as null; a wipe clears it', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const long = { at: NOW, lines: 70, patterns: PATTERNS };
  assert.deepEqual(store.setWornLong('g1', long), normalizeWornLong(long));
  assert.equal(store.getGuild('g1').updatedAt, null);
  store.updateGuild('g1', { patterns: 'p', wornLong: null });
  assert.equal(store.getGuild('g1').wornLong.lines, 70);
  store.flush();
  const again = createStore({ dataDir: dir });
  assert.deepEqual(again.getGuild('g1').wornLong, normalizeWornLong(long));
  assert.equal(again.getGuild('g1').patterns, 'p');

  const file = path.join(dir, 'guilds', 'g2', 'guild.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ wornLong: [1, 2] }));
  assert.equal(createStore({ dataDir: dir }).getGuild('g2').wornLong, null);

  again.wipeGuild('g1');
  assert.equal(again.getGuild('g1').wornLong, null);
  assert.equal(createStore({ dataDir: dir }).getGuild('g1').wornLong, null);
});

// ---- the long pass: live ---------------------------------------------------------------------------

const HOUR = 60 * MIN;
const LONG_PROMPT = 'LONG for {{name}}, at most {{maxPatterns}} patterns of {{shapeChars}} characters.';
const LONG_VARIETY = { longLines: 80, longEveryHours: 6, longMinLines: 60, longMaxPatterns: 3 };
const LONG_ANSWER = answer([
  { shape: 'ends a line on honestly', examples: ['honestly'], count: 5 },
  { shape: 'Names What Was Said', examples: ['what a surprise'], count: 9 },
]);

function longHot({ features = {}, variety = {}, prompts = {} } = {}) {
  return liveHot({ features, variety: { ...LONG_VARIETY, ...variety }, prompts: { 'variety-long': LONG_PROMPT, ...prompts } });
}

/** A fake llm answering the long pass with `long()` and the short pass with `short()`. */
function bothLlm({ long = () => LONG_ANSWER, short = () => ANSWER } = {}) {
  return fakeLlm((messages, options) => (options.purpose === 'variety-long' ? long() : short()));
}

function longCalls(llm) {
  return llm.calls.filter((c) => c.options.purpose === 'variety-long');
}

/** `n` own lines of the persona in channel `c2`, a day old (outside the short pass's recentMinutes), each answering someone. */
function fillRing(store, n, longLines = LONG_VARIETY.longLines) {
  for (let i = 0; i < n; i += 1) {
    const text = i % 5 === 0 ? `that was fine, honestly ${i}` : `what a surprise number ${i}`;
    store.pushOwnLine('g1', { id: `r${i}`, ts: NOW - 24 * HOUR + i * MIN, channelId: 'c2', text, to: `question ${i}` }, 16, longLines);
  }
}

test('long pass: runs after a post when due and enough lines exist; the request carries the helper options with the long mark', async () => {
  const { pass, llm, store } = liveSetup({ hot: longHot(), llm: bothLlm() });
  fillRing(store, 70);
  await pass.ahead({ ...TURN, history: ownHistory() });
  const calls = longCalls(llm);
  assert.equal(calls.length, 1);
  const { messages, options } = calls[0];
  assert.equal(messages[0].content, 'LONG for Nept, at most 3 patterns of 140 characters.');
  const rows = messages[1].content.split('\n');
  assert.deepEqual([rows[0], rows[1], rows.at(-1)], ['<lines>', '#1 that was fine, honestly 0', '</lines>']);
  assert.equal(rows.length, 72, 'every ring line, oldest first');
  assert.ok(!messages[1].content.includes('(to:'), "the long look carries no other member's words");
  assert.equal(options.model, 'x/classifier');
  assert.equal(options.role, 'classifier.text');
  assert.equal(options.purpose, 'variety-long');
  assert.equal(options.long, true);
  assert.equal(options.helper, true);
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.maxOutputTokens, 500);
  assert.equal(options.timeoutMs, 30000);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(store.getGuild('g1').wornLong, {
    at: NOW,
    lines: 70,
    patterns: [
      { shape: 'ends a line on honestly', examples: ['honestly'], count: 5 },
      { shape: 'Names What Was Said', examples: ['what a surprise'], count: 9 },
    ],
  });
  assert.equal(store.getGuild('g1').wornHistory.length, 1, 'the history holds the short pass only');

  const own = liveSetup({ hot: longHot({ variety: { longModel: 'x/long' } }), llm: bothLlm() });
  fillRing(own.store, 70);
  await own.pass.ahead({ ...TURN, history: ownHistory() });
  assert.equal(longCalls(own.llm)[0].options.model, 'x/long', 'variety.longModel when set');
});

test('long pass: not before longEveryHours, not without its prompt, below longMinLines, in a private chat or while paused', async () => {
  const { pass, llm, store, advance } = liveSetup({ hot: longHot(), llm: bothLlm() });
  fillRing(store, 70);
  await pass.ahead({ ...TURN, history: ownHistory() });
  advance(6 * HOUR - 1);
  await pass.ahead({ ...TURN, history: historyPlus('a7') });
  assert.equal(longCalls(llm).length, 1, 'not yet');
  advance(1);
  await pass.ahead({ ...TURN, history: historyPlus('a8') });
  assert.equal(longCalls(llm).length, 2, 'due again');

  for (const [why, setup, lines, input] of [
    ['no prompt', liveSetup({ hot: longHot({ prompts: { 'variety-long': undefined } }), llm: bothLlm() }), 70, TURN],
    ['too few lines', liveSetup({ hot: longHot(), llm: bothLlm() }), 59, TURN],
    ['private chat', liveSetup({ hot: longHot(), llm: bothLlm() }), 70, { ...TURN, privateChat: true }],
    ['switched off', liveSetup({ hot: longHot({ variety: { longLines: 0 } }), llm: bothLlm() }), 70, TURN],
  ]) {
    fillRing(setup.store, lines);
    await setup.pass.ahead({ ...input, history: ownHistory() });
    assert.equal(longCalls(setup.llm).length, 0, why);
    assert.equal(setup.store.getGuild('g1').wornLong, null, why);
  }
  const paused = liveSetup({ hot: longHot(), llm: bothLlm() });
  fillRing(paused.store, 70);
  paused.store.state.data.paused = true;
  await paused.pass.ahead({ ...TURN, history: ownHistory() });
  assert.equal(longCalls(paused.llm).length, 0, 'paused');

  // The long pass is not a precompute: it runs with features.varietyPrecompute off.
  const noAhead = liveSetup({ hot: longHot({ features: { varietyPrecompute: false } }), llm: bothLlm() });
  fillRing(noAhead.store, 70);
  await noAhead.pass.ahead({ ...TURN, history: ownHistory() });
  assert.deepEqual([longCalls(noAhead.llm).length, noAhead.llm.calls.length], [1, 1]);
});

test('long pass: one in flight per guild; a turn never waits for it', async () => {
  const llm = deferredLlm();
  const { pass, store } = liveSetup({ hot: longHot({ features: { varietyPrecompute: false } }), llm });
  fillRing(store, 70);
  const first = pass.ahead({ ...TURN, history: ownHistory() });
  const second = pass.ahead({ ...TURN, history: historyPlus('a7') });
  assert.equal(longCalls(llm).length, 1);
  // A turn meanwhile: its own short request answers, the long one is still out.
  const turn = pass.forTurn({ ...TURN, history: ownHistory() });
  await settle();
  llm.calls.find((c) => c.options.purpose === 'variety').answer(ANSWER);
  assert.equal((await turn).length, 1);
  longCalls(llm)[0].answer(LONG_ANSWER);
  await Promise.all([first, second]);
  assert.equal(store.getGuild('g1').wornLong.patterns.length, 2);
});

test("long pass: its patterns reach a later turn's worn ahead of the short ones, de-duplicated and capped", async () => {
  const { pass, store, hot } = liveSetup({ hot: longHot({ features: { varietyPrecompute: false } }), llm: bothLlm() });
  fillRing(store, 70);
  await pass.ahead({ ...TURN, history: ownHistory() });
  const worn = await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.deepEqual(
    worn.map((p) => p.shape),
    ['ends a line on honestly', 'Names What Was Said'],
    'the short pass named "names what was said" too: kept once, the long one first',
  );
  hot.config.variety.maxPatterns = 0;
  hot.config.variety.longMaxPatterns = 1;
  assert.deepEqual((await pass.forTurn({ ...TURN, history: ownHistory() })).map((p) => p.shape), ['ends a line on honestly']);
});

test('long pass: its list survives short passes that find nothing and turns with no short pass; off means none', async () => {
  const llm = bothLlm({ short: () => answer([]) });
  const { pass, store, hot } = liveSetup({ hot: longHot({ features: { varietyPrecompute: false } }), llm });
  fillRing(store, 70);
  await pass.ahead({ ...TURN, history: ownHistory() });
  const empty = await pass.forTurn({ ...TURN, history: ownHistory() });
  assert.deepEqual(empty.map((p) => p.shape), ['ends a line on honestly', 'Names What Was Said']);
  assert.deepEqual(store.getGuild('g1').worn.patterns, [], 'the short pass did land, with nothing');
  const few = await pass.forTurn({ ...TURN, history: [own('z1', 1, 'μόνο')] });
  assert.equal(few.length, 2, 'too few lines for a short pass: the long list still comes');
  hot.config.features.variety = false;
  assert.equal(await pass.forTurn({ ...TURN, history: ownHistory() }), null);
});

test('long pass: a new one replaces the list; a failed or unparsable one keeps the previous and waits the interval', async () => {
  let mode = 'first';
  const second = answer([{ shape: 'a question tag at the end', examples: ['number 3'], count: 3 }]);
  const llm = bothLlm({
    long: () => {
      if (mode === 'fail') throw Object.assign(new Error('boom'), { statusCode: 502 });
      if (mode === 'junk') return 'no json';
      return mode === 'first' ? LONG_ANSWER : second;
    },
  });
  const { pass, store, advance } = liveSetup({ hot: longHot({ features: { varietyPrecompute: false } }), llm });
  fillRing(store, 70);
  await pass.ahead({ ...TURN, history: ownHistory() });
  const before = store.getGuild('g1').wornLong;
  assert.equal(before.patterns.length, 2);

  advance(6 * HOUR);
  mode = 'fail';
  const failing = await withCapturedLogs(() => pass.ahead({ ...TURN, history: ownHistory() }));
  const failed = failing.logs.find((l) => l.msg === 'variety: pass failed');
  assert.deepEqual([failed.cause, failed.reason, failed.status, failed.lines], ['long', 'error', 502, 70]);
  assert.deepEqual(store.getGuild('g1').wornLong, before);
  await pass.ahead({ ...TURN, history: ownHistory() });
  assert.equal(longCalls(llm).length, 2, 'a failed try waits the interval too');

  advance(6 * HOUR);
  mode = 'junk';
  const junk = await withCapturedLogs(() => pass.ahead({ ...TURN, history: ownHistory() }));
  const line = junk.logs.find((l) => l.msg === 'variety: long');
  assert.deepEqual([line.level, line.parse, line.stored], ['warn', 'error', false]);
  assert.deepEqual(store.getGuild('g1').wornLong, before);

  advance(6 * HOUR);
  mode = 'second';
  await pass.ahead({ ...TURN, history: ownHistory() });
  const after = store.getGuild('g1').wornLong;
  assert.equal(after.at, NOW + 18 * HOUR);
  assert.deepEqual(after.patterns.map((p) => p.shape), ['a question tag at the end']);
  assert.equal((await pass.forTurn({ ...TURN, history: ownHistory() }))[0].shape, 'a question tag at the end');
});

test('long pass: after a restart the stored list serves turns and the interval still holds', async () => {
  const dir = tmpDataDir();
  const first = liveSetup({ hot: longHot(), llm: bothLlm(), store: createStore({ dataDir: dir }) });
  fillRing(first.store, 70);
  await first.pass.ahead({ ...TURN, history: ownHistory() });
  first.store.flush();

  const again = liveSetup({ hot: longHot(), llm: bothLlm(), store: createStore({ dataDir: dir }) });
  again.advance(HOUR);
  await again.pass.ahead({ ...TURN, history: historyPlus('a7') });
  assert.equal(longCalls(again.llm).length, 0);
  assert.equal((await again.pass.forTurn({ ...TURN, history: historyPlus('a7') }))[0].shape, 'ends a line on honestly');
});

test('long pass: logs carry counts and codes, never the lines, the examples or the shapes', async () => {
  const { pass, store } = liveSetup({ hot: longHot(), llm: bothLlm() });
  fillRing(store, 70);
  const { logs } = await withCapturedLogs(async () => {
    await pass.ahead({ ...TURN, history: ownHistory() });
    await pass.forTurn({ ...TURN, history: ownHistory() });
  });
  const line = logs.find((l) => l.msg === 'variety: long');
  assert.deepEqual(fieldsOf(line), ['dropped', 'kept', 'lines', 'ms', 'parse', 'stored']);
  assert.deepEqual([line.lines, line.kept, line.dropped, line.parse, line.stored], [70, 2, 0, 'ok', true]);
  assert.equal(typeof line.ms, 'number');
  assert.equal(logs.find((l) => l.msg === 'variety: turn').long, 2);
  const all = JSON.stringify(logs);
  for (const secret of ['honestly', 'surprise', 'question', 'Names What', 'ends a line']) assert.ok(!all.includes(secret), secret);
});
