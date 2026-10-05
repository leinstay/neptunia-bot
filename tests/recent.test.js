// Tests for src/memory/recent.js: the recent store's pure logic (merge with
// expiry, dedupe, caps and remove; the live view; the purge of a member; the
// fold) and src/memory/mentions.js#tokenIds, plus the store's read path where a
// rule is about "on read" versus "at the next write".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECENT_DEFAULTS,
  emptyRecent,
  foldText,
  liveRecent,
  mergeRecent,
  normalizeRecent,
  purgeRecentFor,
  recentSettings,
} from '../src/memory/recent.js';
import { tokenIds } from '../src/memory/mentions.js';
import { createStore } from '../src/memory/store.js';
import { HOUR_MS } from '../src/time.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const ELENI = '111111111111111111';
const NIKOS = '222222222222222222';
const AGORA = '900000000000000001';
const KIPOS = '900000000000000002';

/** A stored line as the store holds it. */
function line(id, fields = {}) {
  const text = fields.text ?? `γραμμή ${id}`;
  return { id, at: NOW - HOUR_MS, addedAt: NOW_ISO, channelId: AGORA, text, who: tokenIds(text), weight: 2, ...fields };
}

function stored(lines, nextId) {
  return { nextId: nextId ?? Math.max(0, ...lines.map((l) => l.id)) + 1, lines };
}

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-recent-'));
}

function recentFileOf(dir, guildId) {
  return path.join(dir, 'guilds', guildId, 'recent.json');
}

function writeRaw(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Every count `mergeRecent` returns, without the value. */
function countsOf(result) {
  const { value, ...counts } = result;
  return counts;
}

/** `mergeRecent`'s counts for a call that dropped nothing for the given reasons; `fields` override. */
function counts(fields = {}) {
  const base = { added: 0, removed: 0, expired: 0, evicted: 0, invalid: 0, noChannel: 0, stale: 0, duplicate: 0, overCap: 0, ...fields };
  return { ...base, dropped: base.invalid + base.noChannel + base.stale + base.duplicate + base.overCap };
}

// --- tokenIds ----------------------------------------------------------------

test('mentions: tokenIds lists each member id of the tokens once, in order of appearance', () => {
  assert.deepEqual(tokenIds(`<@${NIKOS}> και <@${ELENI}>, ξανά <@${NIKOS}> και <@123> και (id:${ELENI})`), [NIKOS, ELENI]);
  assert.deepEqual(tokenIds('καμία αναφορά'), []);
  assert.deepEqual(tokenIds(null), []);
  assert.deepEqual(tokenIds(42), []);
});

// --- foldText ------------------------------------------------------------------

test('recent: foldText strips accents (an accented e folds to e) and case', () => {
  assert.equal(foldText('Café  ÉTÉ\n'), 'cafe ete');
  assert.equal(foldText('é'), 'e');
  assert.equal(foldText('  Η Ελένη   ΈΦΕΡΕ\tκαφέ '), 'η ελενη εφερε καφε');
  assert.equal(foldText('Ἀθήνα'), 'αθηνα');
  assert.equal(foldText(`<@${ELENI}> Ñandú`), `<@${ELENI}> nandu`);
  assert.equal(foldText(undefined), '');
  assert.equal(foldText(7), '7');
});

// --- mergeRecent ---------------------------------------------------------------

test('recent: a new line gets the next id and the member ids of its tokens', () => {
  const before = stored([line(6)], 7);
  const snapshot = structuredClone(before);
  const text = `<@${ELENI}> χάρισε έναν βάτραχο, <@${NIKOS}> γέλασε και <@${ELENI}> τον ονόμασε`;

  const result = mergeRecent(before, [{ text, at: NOW - 2 * HOUR_MS, channelId: KIPOS, weight: 3 }], { now: NOW });

  assert.deepEqual(countsOf(result), counts({ added: 1 }));
  assert.equal(result.value.nextId, 8);
  assert.deepEqual(result.value.lines, [
    line(6),
    { id: 7, at: NOW - 2 * HOUR_MS, addedAt: NOW_ISO, channelId: KIPOS, text, who: [ELENI, NIKOS], weight: 3 },
  ]);
  assert.deepEqual(before, snapshot, 'what was stored is never mutated');

  // `who` comes from the text alone: an incoming `who` (or `id`, `addedAt`) is never taken
  const told = mergeRecent(before, [{ text: `<@${ELENI}> ήρθε`, at: NOW, channelId: KIPOS, who: [NIKOS], id: 99, addedAt: 'χθες' }], { now: NOW });
  assert.deepEqual(told.value.lines[1], { id: 7, at: NOW, addedAt: NOW_ISO, channelId: KIPOS, text: `<@${ELENI}> ήρθε`, who: [ELENI], weight: 2 });
});

test('recent: every stored line records its text, time, channel, weight and member ids', () => {
  const { value } = mergeRecent(
    emptyRecent(),
    [
      { text: '  μια   γραμμή\nσε δύο σειρές ', at: NOW - HOUR_MS, channelId: ` ${AGORA} ` },
      { text: 'βαριά', at: NOW - HOUR_MS, channelId: AGORA, weight: 9 },
      { text: 'ελαφριά', at: NOW - HOUR_MS, channelId: AGORA, weight: -4 },
      { text: 'μισή', at: NOW - HOUR_MS, channelId: AGORA, weight: 2.5 },
      { text: 'χωρίς ώρα', at: 'χθες', channelId: AGORA },
    ],
    { now: NOW, maxNew: 10 },
  );
  assert.deepEqual(
    value.lines.map((l) => [l.text, l.at, l.channelId, l.weight, l.who]),
    [
      ['μια γραμμή σε δύο σειρές', NOW - HOUR_MS, AGORA, 2, []],
      ['βαριά', NOW - HOUR_MS, AGORA, 3, []],
      ['ελαφριά', NOW - HOUR_MS, AGORA, 1, []],
      ['μισή', NOW - HOUR_MS, AGORA, 2, []],
      ['χωρίς ώρα', NOW, AGORA, 2, []],
    ],
  );
  for (const stored of value.lines) assert.equal(stored.addedAt, NOW_ISO);
});

test('recent: an add without a source channel, without text or already past the window is not stored, each counted by its reason', () => {
  const result = mergeRecent(
    emptyRecent(),
    [
      { text: 'χωρίς κανάλι', at: NOW - HOUR_MS },
      { text: 'κενό κανάλι', at: NOW - HOUR_MS, channelId: '  ' },
      { text: 'αριθμός', at: NOW - HOUR_MS, channelId: 900000000000000000 },
      { text: 'κανάλι null', at: NOW - HOUR_MS, channelId: null },
      { text: '   ', at: NOW - HOUR_MS, channelId: AGORA },
      { at: NOW - HOUR_MS, channelId: AGORA },
      { text: '', channelId: null },
      { text: 'παλιό', at: NOW - 73 * HOUR_MS, channelId: AGORA },
      'σκέτο κείμενο',
      null,
      { text: 'μένει', at: NOW - HOUR_MS, channelId: AGORA },
    ],
    { now: NOW, maxNew: 10 },
  );
  assert.deepEqual(countsOf(result), counts({ added: 1, invalid: 5, noChannel: 4, stale: 1 }));
  assert.equal(result.dropped, 10, 'dropped is the sum of the reasons');
  assert.deepEqual(result.value.lines.map((l) => l.text), ['μένει']);
});

test('recent: a long text is cut at a clean boundary to chars, never inside a token', () => {
  const text = `<@${ELENI}> ${'λέξη '.repeat(60)}`;
  const { value } = mergeRecent(emptyRecent(), [{ text, at: NOW, channelId: AGORA }], { now: NOW, chars: 40, clampTolerance: 1 });
  const kept = value.lines[0].text;
  assert.ok([...kept].length <= 40, kept);
  assert.ok(kept.startsWith(`<@${ELENI}> λέξη`));
  assert.ok(kept.endsWith('λέξη'));
  assert.deepEqual(value.lines[0].who, [ELENI]);
});

test('recent: a line with the same folded text as a live one is not stored twice', () => {
  const before = stored([line(1, { text: 'Η Ελένη έφερε καφέ' })]);
  const result = mergeRecent(
    before,
    [
      { text: 'η ελενη   ΕΦΕΡΕ καφε', at: NOW, channelId: KIPOS },
      { text: 'Ο Νίκος έχασε το κλειδί', at: NOW, channelId: AGORA },
      { text: 'ο νικος εχασε το κλειδι', at: NOW, channelId: KIPOS },
    ],
    { now: NOW },
  );
  assert.deepEqual(countsOf(result), counts({ added: 1, duplicate: 2 }), 'one equal to a stored line, one to an earlier add');
  assert.deepEqual(result.value.lines.map((l) => l.text), ['Η Ελένη έφερε καφέ', 'Ο Νίκος έχασε το κλειδί']);
});

test('recent: lines older than recentHours go at the next write, never on read', () => {
  const old = line(1, { at: NOW - 73 * HOUR_MS, text: 'παλιά' });
  const edge = line(2, { at: NOW - 72 * HOUR_MS, text: 'στο όριο' });
  const fresh = line(3, { at: NOW - HOUR_MS, text: 'φρέσκια' });

  // pure: the write drops what is past the window, counted
  const result = mergeRecent(stored([old, edge, fresh]), [], { now: NOW, hours: 72 });
  assert.equal(result.expired, 1);
  assert.deepEqual(result.value.lines.map((l) => l.id), [2, 3]);
  assert.equal(result.value.nextId, 4, 'an expired id is never reused');

  // an expired line's text can come back as a new line
  const again = mergeRecent(stored([old, fresh]), [{ text: 'παλιά', at: NOW, channelId: AGORA }], { now: NOW, hours: 72 });
  assert.deepEqual([again.expired, again.added], [1, 1]);
  assert.deepEqual(again.value.lines.map((l) => [l.id, l.text]), [[3, 'φρέσκια'], [4, 'παλιά']]);

  // the store: reading keeps every line, the next write drops the old one
  const dir = tmpDataDir();
  const file = recentFileOf(dir, 'g1');
  writeRaw(file, stored([old, edge, fresh]));
  const raw = fs.readFileSync(file, 'utf8');
  const store = createStore({ dataDir: dir });
  assert.deepEqual(store.getRecent('g1').lines.map((l) => l.id), [1, 2, 3]);
  assert.deepEqual(liveRecent(store.getRecent('g1').lines, { now: NOW, hours: 24 }).map((l) => l.id), [3]);
  store.flush();
  assert.equal(fs.readFileSync(file, 'utf8'), raw, 'a read rewrites nothing');

  const counts = store.applyRecentOps('g1', [], { now: NOW, hours: 72 });
  assert.equal(counts.expired, 1);
  store.flush();
  assert.deepEqual(createStore({ dataDir: dir }).getRecent('g1').lines.map((l) => l.id), [2, 3]);
});

test('recent: past maxStored the lightest, then the oldest lines go first', () => {
  const before = stored([
    line(1, { weight: 2, at: NOW - 10 * HOUR_MS }),
    line(2, { weight: 1, at: NOW - 5 * HOUR_MS }),
    line(3, { weight: 1, at: NOW - 8 * HOUR_MS }),
    line(4, { weight: 3, at: NOW - 20 * HOUR_MS }),
  ]);
  const result = mergeRecent(before, [{ text: 'νέα', at: NOW - HOUR_MS, channelId: AGORA, weight: 2 }], { now: NOW, maxStored: 3 });
  assert.deepEqual(countsOf(result), counts({ added: 1, evicted: 2 }));
  assert.deepEqual(result.value.lines.map((l) => l.id), [1, 4, 5], 'the survivors keep their order');

  // equal weight and time: the lower id goes first
  const tie = stored([line(1, { at: NOW - HOUR_MS }), line(2, { at: NOW - HOUR_MS })]);
  const tied = mergeRecent(tie, [{ text: 'τρίτη', at: NOW - HOUR_MS, channelId: AGORA }], { now: NOW, maxStored: 2 });
  assert.deepEqual(tied.value.lines.map((l) => l.id), [2, 3]);

  // a full store of heavier lines: a new light line is the one the cap takes, at once -- not
  // added, counted over the cap, no stored line evicted, and its id is not used up
  const full = stored([line(1, { weight: 3 }), line(2, { weight: 2, at: NOW - 2 * HOUR_MS })]);
  const bounced = mergeRecent(
    full,
    [
      { text: 'ελαφριά', at: NOW - 3 * HOUR_MS, channelId: AGORA, weight: 1 },
      { text: 'βαριά', at: NOW - HOUR_MS, channelId: AGORA, weight: 3 },
    ],
    { now: NOW, maxStored: 2 },
  );
  assert.deepEqual(countsOf(bounced), counts({ added: 1, evicted: 1, overCap: 1 }));
  assert.deepEqual(bounced.value.lines.map((l) => [l.id, l.text]), [[1, 'γραμμή 1'], [3, 'βαριά']]);
  assert.equal(bounced.value.nextId, 4);
  const only = mergeRecent(full, [{ text: 'ελαφριά', at: NOW - 3 * HOUR_MS, channelId: AGORA, weight: 1 }], { now: NOW, maxStored: 2 });
  assert.deepEqual(countsOf(only), counts({ overCap: 1 }));
  assert.deepEqual(only.value, full, 'nothing changed, nextId included');

  // a lowered cap cuts nothing until a line is added
  const many = stored([line(1), line(2), line(3)]);
  const quiet = mergeRecent(many, [], { now: NOW, maxStored: 1 });
  assert.deepEqual(countsOf(quiet), counts());
  assert.equal(quiet.value.lines.length, 3);

  // ... and when one comes, the cap holds again, even if the new line is among those it takes
  const lowered = mergeRecent(many, [{ text: 'ελαφριά', at: NOW - 2 * HOUR_MS, channelId: AGORA, weight: 1 }], { now: NOW, maxStored: 1 });
  assert.deepEqual(countsOf(lowered), counts({ evicted: 2, overCap: 1 }));
  assert.deepEqual(lowered.value.lines.map((l) => l.id), [3]);
});

test('recent: at most maxNew lines are taken from one batch', () => {
  const result = mergeRecent(
    stored([line(1, { text: 'υπάρχει' })]),
    [
      { text: 'χωρίς κανάλι', at: NOW },
      { text: 'Υπάρχει', at: NOW, channelId: AGORA },
      { text: 'α', at: NOW, channelId: AGORA },
      { text: 'β', at: NOW, channelId: AGORA },
      { text: 'γ', at: NOW, channelId: AGORA },
      { text: 'δ', at: NOW, channelId: AGORA },
      { text: 'Α', at: NOW, channelId: AGORA },
    ],
    { now: NOW, maxNew: 3 },
  );
  assert.deepEqual(
    countsOf(result),
    counts({ added: 3, noChannel: 1, duplicate: 2, overCap: 1 }),
    'a duplicate past the cap still counts as a duplicate',
  );
  assert.deepEqual(result.value.lines.map((l) => l.text), ['υπάρχει', 'α', 'β', 'γ']);

  const none = mergeRecent(emptyRecent(), [{ text: 'α', at: NOW, channelId: AGORA }], { now: NOW, maxNew: 0 });
  assert.deepEqual(countsOf(none), counts({ overCap: 1 }));
  assert.equal(none.value.lines.length, 0);
});

test('recent: remove takes stored ids only', () => {
  const before = stored([line(1), line(2), line(3)]);
  const result = mergeRecent(before, [{ text: 'καινούργια', at: NOW, channelId: AGORA }], {
    now: NOW,
    removeIds: [2, '3', 9, 4, 'x', 1.5, null, { id: 1 }, -1],
  });
  assert.equal(result.removed, 2);
  assert.equal(result.added, 1);
  assert.deepEqual(result.value.lines.map((l) => l.id), [1, 4], 'the id given to the new line in the same call is not removed');
  assert.equal(result.value.nextId, 5);

  const nothing = mergeRecent(before, [], { now: NOW, removeIds: 'όλα' });
  assert.equal(nothing.removed, 0);
  assert.equal(nothing.value.lines.length, 3);
});

test('recent: missing options fall back to config.json\'s values', () => {
  const lines = Array.from({ length: RECENT_DEFAULTS.maxStored }, (_, i) => line(i + 1, { at: NOW - 71 * HOUR_MS, text: `γραμμή ${i + 1}` }));
  lines.push(line(151, { at: NOW - 73 * HOUR_MS, text: 'έληξε' }));
  const incoming = ['α', 'β', 'γ', 'δ'].map((text) => ({ text, at: NOW, channelId: AGORA }));
  incoming.push({ text: 'ε'.repeat(400), at: NOW, channelId: AGORA });
  const result = mergeRecent(stored(lines), incoming, { now: NOW });
  assert.equal(result.expired, 1, 'recentHours 72');
  assert.equal(result.added, RECENT_DEFAULTS.maxNew, 'maxNewRecent 3');
  assert.equal(result.value.lines.length, RECENT_DEFAULTS.maxStored, 'maxRecentStored 150');

  const long = mergeRecent(emptyRecent(), [{ text: 'ε'.repeat(400), at: NOW, channelId: AGORA }], { now: NOW, clampTolerance: 1 });
  assert.equal([...long.value.lines[0].text].length, RECENT_DEFAULTS.chars, 'recentChars 160');
});

test('recent: settings follow config.json and features.recent missing counts as on', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  assert.deepEqual(
    { ...RECENT_DEFAULTS },
    {
      hours: config.memory.recentHours,
      maxStored: config.memory.maxRecentStored,
      maxNew: config.memory.maxNewRecent,
      chars: config.memory.recentChars,
      shown: config.memory.recentShown,
    },
  );
  assert.deepEqual({ ...RECENT_DEFAULTS }, { hours: 72, maxStored: 150, maxNew: 3, chars: 160, shown: 12 });

  assert.deepEqual(recentSettings({}), { ...RECENT_DEFAULTS, clampTolerance: undefined });
  assert.deepEqual(recentSettings({ features: {} }), { ...RECENT_DEFAULTS, clampTolerance: undefined });
  assert.equal(recentSettings({ features: { recent: false } }), null);
  assert.deepEqual(recentSettings({ features: { recent: true }, memory: { recentHours: 48, maxNewRecent: 0, clampTolerance: 1.1 } }), {
    ...RECENT_DEFAULTS,
    hours: 48,
    maxNew: 0,
    clampTolerance: 1.1,
  });
  assert.deepEqual(recentSettings(config), { ...RECENT_DEFAULTS, clampTolerance: config.memory.clampTolerance });
});

// --- normalizeRecent -------------------------------------------------------------

test('recent: a hand-edited file with a broken line is healed on read and not rewritten', () => {
  const dir = tmpDataDir();
  const file = recentFileOf(dir, 'g1');
  writeRaw(file, {
    nextId: 2,
    lines: [
      { id: 1, at: NOW - HOUR_MS, addedAt: NOW_ISO, channelId: AGORA, text: `<@${ELENI}> έφερε γλυκά`, who: [NIKOS], weight: 9 },
      { id: 2, at: 'χθες', channelId: AGORA, text: 'χωρίς ώρα', weight: 2 },
      { id: 3, at: NOW, channelId: AGORA, text: '   ', weight: 2 },
      { id: 'τέσσερα', at: NOW, channelId: AGORA, text: 'χωρίς αριθμό', weight: 2 },
      { id: 5, at: NOW, text: 'χωρίς κανάλι', weight: 2 },
      { id: 7, at: NOW, channelId: KIPOS, text: 'κανονική\nσε δύο', weight: 1.5 },
      { id: 7, at: NOW, channelId: KIPOS, text: 'ίδιο αριθμό', weight: 0 },
      'σκουπίδι',
    ],
  });
  const raw = fs.readFileSync(file, 'utf8');

  const store = createStore({ dataDir: dir });
  const value = store.getRecent('g1');
  assert.deepEqual(value, {
    nextId: 9,
    lines: [
      { id: 1, at: NOW - HOUR_MS, addedAt: NOW_ISO, channelId: AGORA, text: `<@${ELENI}> έφερε γλυκά`, who: [ELENI], weight: 3 },
      { id: 7, at: NOW, addedAt: null, channelId: KIPOS, text: 'κανονική σε δύο', who: [], weight: 2 },
      { id: 8, at: NOW, addedAt: null, channelId: KIPOS, text: 'ίδιο αριθμό', who: [], weight: 1 },
    ],
  });
  store.flush();
  assert.equal(fs.readFileSync(file, 'utf8'), raw, 'healed in memory, the file is left as written');

  // pure: garbage reads as empty, a healed value heals to itself
  for (const garbage of [null, undefined, 'x', [], 42, { lines: 'x' }]) assert.deepEqual(normalizeRecent(garbage), emptyRecent());
  assert.deepEqual(normalizeRecent(value), value);
  assert.deepEqual(normalizeRecent({ nextId: 50, lines: [] }), { nextId: 50, lines: [] });

  // a repeated id is healed from the stored nextId on, never with an id a gone line once held
  const healed = normalizeRecent({ nextId: 50, lines: [line(7, { text: 'πρώτη' }), line(7, { text: 'δεύτερη' }), line(7, { text: 'τρίτη' })] });
  assert.deepEqual(healed.lines.map((l) => [l.id, l.text]), [[7, 'πρώτη'], [50, 'δεύτερη'], [51, 'τρίτη']]);
  assert.equal(healed.nextId, 52);
  assert.deepEqual(normalizeRecent(healed), healed);
});

test('store: lines a hand edit broke are logged once as a count on load, never by content; a value that is not a store too', async () => {
  const dir = tmpDataDir();
  writeRaw(recentFileOf(dir, 'g1'), {
    nextId: 4,
    lines: [
      line(1, { text: 'μένει' }),
      { ...line(2, { text: 'ώρα σε λέξεις' }), at: '2026-10-04T10:00:00Z' },
      { ...line(3, { text: 'χωρίς κανάλι' }), channelId: undefined },
    ],
  });
  writeRaw(recentFileOf(dir, 'g2'), [line(1)]);
  writeRaw(recentFileOf(dir, 'g3'), { nextId: 2, lines: 'καμία' });
  writeRaw(recentFileOf(dir, 'g4'), stored([line(1), line(1, { text: 'ίδιο αριθμό' })]));
  const store = createStore({ dataDir: dir });

  const { result, logs } = await withCapturedLogs(() => [store.getRecent('g1'), store.getRecent('g1'), store.applyRecentOps('g1', [], { now: NOW })]);
  assert.deepEqual(result[0].lines.map((l) => l.text), ['μένει']);
  const dropped = logs.filter((entry) => entry.msg === 'store: recent lines dropped');
  assert.equal(dropped.length, 1, 'logged on the read that loads the file only');
  assert.equal(dropped[0].level, 'warn');
  assert.equal(dropped[0].guildId, 'g1');
  assert.equal(dropped[0].dropped, 2);
  assert.ok(!JSON.stringify(logs).includes('λέξεις') && !JSON.stringify(logs).includes('μένει'), 'counts only');

  const { logs: more } = await withCapturedLogs(() => ['g2', 'g3', 'g4', 'g5'].map((guildId) => store.getRecent(guildId)));
  assert.deepEqual(
    more.filter((entry) => entry.msg.startsWith('store: recent')).map((entry) => [entry.msg, entry.guildId, entry.reason ?? entry.dropped]),
    [
      ['store: recent store replaced', 'g2', 'malformed'],
      ['store: recent store replaced', 'g3', 'malformed'],
    ],
    'a healed id and a missing file log nothing',
  );
});

// --- liveRecent ------------------------------------------------------------------

test('recent: liveRecent shows only the lines inside the window', () => {
  const lines = [
    line(1, { at: NOW - 73 * HOUR_MS }),
    line(2, { at: NOW - HOUR_MS }),
    line(3, { at: NOW - 72 * HOUR_MS }),
    line(4, { at: NOW - 30 * HOUR_MS }),
  ];
  assert.deepEqual(liveRecent(lines, { now: NOW, hours: 72 }).map((l) => l.id), [2, 3, 4], 'stored order, the edge included');
  assert.deepEqual(liveRecent(lines, { now: NOW, hours: 24 }).map((l) => l.id), [2]);
  assert.deepEqual(liveRecent(lines, { now: NOW }).map((l) => l.id), [2, 3, 4], 'recentHours 72 by default');
  assert.deepEqual(liveRecent(undefined, { now: NOW, hours: 72 }), []);
  assert.equal(lines.length, 4, 'never mutated');
});

// --- purgeRecentFor --------------------------------------------------------------

test('recent: purge removes lines with the member\'s token or a whole-word stored name', () => {
  const before = stored([
    line(1, { text: `<@${ELENI}> χάρισε έναν βάτραχο` }),
    line(2, { text: 'η Ελένη ήρθε αργά' }),
    line(3, { text: 'η ελενη ξανά' }),
    line(4, { text: 'οι Ελένηδες της γειτονιάς' }),
    line(5, { text: `<@${NIKOS}> τραγούδησε` }),
    line(6, { text: 'ο Βάτος έφυγε νωρίς' }),
    line(7, { text: 'λι και λα' }),
    line(8, { text: `μίλησε με <@${ELENI}>`, who: [] }), // a stored `who` is not trusted: recomputed from the text
  ]);
  const snapshot = structuredClone(before);

  const { value, removed } = purgeRecentFor(before, ELENI, ['Ελένη', 'Βάτος', 'Λι', '', null, 42]);
  assert.equal(removed, 5);
  assert.deepEqual(value.lines.map((l) => l.id), [4, 5, 7], 'a name inside a longer word and a name under 3 letters remove nothing');
  assert.equal(value.nextId, before.nextId);
  assert.deepEqual(before, snapshot, 'never mutated');

  assert.equal(purgeRecentFor(before, '333333333333333333', []).removed, 0);

  // an id outside the snowflake range forms no token `who` holds: the text is searched for it
  const odd = stored([line(1, { text: 'μίλησε με <@u1>' }), line(2, { text: 'μίλησε με <@u10>' })]);
  assert.deepEqual(odd.lines[0].who, []);
  assert.deepEqual(purgeRecentFor(odd, 'u1', []).value.lines.map((l) => l.id), [2]);
});

test('recent: purge counts only letters and digits toward a name\'s minimum, so a symbol-only name removes nothing', () => {
  const before = stored([
    line(1, { text: 'ήσυχο βράδυ -_- για όλους' }),
    line(2, { text: 'τι έγινε ???' }),
    line(3, { text: 'καλημέρα *** σε όλους' }),
    line(4, { text: 'ο x_x πάλι εδώ' }),
    line(5, { text: 'πάλι ο Ζωή-3 κέρδισε' }),
    line(6, { text: 'το ___ έμεινε κενό' }),
  ]);
  const { value, removed } = purgeRecentFor(before, '333333333333333333', ['-_-', '???', '***', 'x_x', '___', '  ']);
  assert.equal(removed, 0, 'no name with three letters or digits');
  assert.equal(value.lines.length, 6);

  assert.deepEqual(purgeRecentFor(before, '333333333333333333', ['-_-', 'Ζωή-3']).value.lines.map((l) => l.id), [1, 2, 3, 4, 6]);
});
