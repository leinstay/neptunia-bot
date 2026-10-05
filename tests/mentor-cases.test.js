// Tests for src/mentor/cases.js: the owner's mentor cases, the runs made from
// them and the owner's feedback on those runs, as JSON files under a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCaseStore } from '../src/mentor/cases.js';

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-mentor-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A clock that returns the given values in turn, then keeps the last one. */
function clock(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function allFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(allFiles(full));
    else out.push(full);
  }
  return out;
}

const TEXT_A = 'Answer a greeting with a short greeting.';
const TEXT_B = 'Remember the name of a pet, Éloïse the cat.';

/**
 * Append a case to cases.json as an earlier version stored it (e.g. with
 * `target: 'memory'`, which `add` no longer takes); returns the stored case.
 */
function addLegacyCase(dir, guildId, fields) {
  const file = path.join(dir, 'guilds', guildId, 'mentor', 'cases.json');
  let data = { nextId: 1, cases: [] };
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const item = { id: data.nextId, state: 'new', createdAt: new Date(0).toISOString(), lastRunId: null, lastScore: null, ...fields };
  data.cases.push(item);
  data.nextId += 1;
  fs.writeFileSync(file, JSON.stringify(data));
  return item;
}

test('add: stores the case and returns increasing ids', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: () => 5000 });
    const a = store.add('g1', { text: `  ${TEXT_A}  `, target: 'reply' });
    const b = store.add('g1', { text: TEXT_B, target: 'reply' });
    assert.deepEqual(a, {
      id: 1, text: TEXT_A, target: 'reply', state: 'new',
      createdAt: new Date(5000).toISOString(), lastRunId: null, lastScore: null,
    });
    assert.equal(b.id, 2);
    assert.equal(b.target, 'reply');
    const file = path.join(dir, 'guilds', 'g1', 'mentor', 'cases.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.nextId, 3);
    assert.deepEqual(onDisk.cases.map((c) => c.id), [1, 2]);
    // A fresh store over the same directory sees the same cases.
    const again = createCaseStore({ dataDir: dir });
    assert.deepEqual(again.list('g1'), [a, b]);
    assert.deepEqual(again.get('g1', 2), b);
    assert.equal(again.get('g1', 99), null);
    // Ids are never reused, even after a retire.
    again.retire('g1', 2);
    assert.equal(again.add('g1', { text: TEXT_A, target: 'reply' }).id, 3);
    // Another guild counts from 1.
    assert.equal(again.add('g2', { text: TEXT_A, target: 'reply' }).id, 1);
  } finally {
    cleanup(dir);
  }
});

test('add: refuses an unknown target', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir });
    assert.throws(() => store.add('g1', { text: TEXT_A, target: 'draw' }), /target/);
    assert.throws(() => store.add('g1', { text: TEXT_A }), /target/);
    // The memory target is retired: a new case is always a reply case.
    assert.throws(() => store.add('g1', { text: TEXT_A, target: 'memory' }), /target must be reply/);
    assert.deepEqual(store.list('g1'), []);
  } finally {
    cleanup(dir);
  }
});

test('add: refuses a text shorter than 10 characters', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir });
    assert.throws(() => store.add('g1', { text: '   short   ', target: 'reply' }), /10/);
    assert.throws(() => store.add('g1', { text: 'x'.repeat(1001), target: 'reply' }), /1000/);
    assert.throws(() => store.add('g1', { target: 'reply' }), /10/);
    assert.equal(store.add('g1', { text: 'αβγδεζηθικ', target: 'reply' }).id, 1);
    assert.equal(store.add('g1', { text: 'x'.repeat(1000), target: 'reply' }).id, 2);
  } finally {
    cleanup(dir);
  }
});

/** A resolved moment as src/mentor/anchor.js#resolveAnchor returns it. */
function moment(messageId = '800000000000000004') {
  return {
    channelId: '500000000000000001',
    messageId,
    triggerId: '800000000000000003',
    history: [
      { id: '800000000000000002', authorId: 'self-id', self: true, content: 'ναι' },
      { id: '800000000000000003', authorId: '111', self: false, content: 'é'.repeat(1580) },
    ],
    original: ['you are right, but', 'no'],
  };
}

test('add: a case may start with a moment, stored as its first anchor', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: () => 5000 });
    const item = store.add('g1', { text: TEXT_A, target: 'reply', anchor: moment() });
    assert.deepEqual(item.anchors, [{ id: 1, ...moment(), addedAt: new Date(5000).toISOString() }]);
    assert.deepEqual(createCaseStore({ dataDir: dir }).get('g1', item.id).anchors, item.anchors);
    // A moment whose history ends with the persona, or has no history, is refused and nothing is stored.
    const bad = { ...moment(), history: [moment().history[0]] };
    assert.throws(() => store.add('g1', { text: TEXT_A, target: 'reply', anchor: bad }), /moment/);
    assert.throws(() => store.add('g1', { text: TEXT_A, target: 'reply', anchor: { ...moment(), history: [] } }), /moment/);
    assert.equal(store.list('g1').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('add: a moment whose trigger was guessed keeps the mark and is reported as a warning; nothing else is', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: () => 5000 });
    const item = store.add('g1', { text: TEXT_A, target: 'reply', anchor: { ...moment(), triggerGuessed: true } });
    assert.deepEqual(item.warnings, ['trigger-guessed']);
    const stored = store.get('g1', item.id);
    assert.equal(stored.anchors[0].triggerGuessed, true);
    assert.equal('warnings' in stored, false, 'a warning is a reply, never stored');
    // A moment the ledger named, and a case without a moment, carry no warning.
    const named = store.add('g1', { text: TEXT_A, target: 'reply', anchor: { ...moment('800000000000000005'), triggerGuessed: false } });
    assert.deepEqual(named.warnings, []);
    assert.equal('triggerGuessed' in store.get('g1', named.id).anchors[0], false);
    assert.equal('warnings' in store.add('g1', { text: TEXT_B, target: 'reply' }), false);
    // addAnchor reports the same.
    const added = store.addAnchor('g1', named.id, { ...moment('800000000000000006'), triggerGuessed: true }, { max: 5 });
    assert.deepEqual(added.warnings, ['trigger-guessed']);
    assert.equal(added.anchor.triggerGuessed, true);
    assert.deepEqual(store.addAnchor('g1', named.id, moment('800000000000000007'), { max: 5 }).warnings, []);
  } finally {
    cleanup(dir);
  }
});

/** A channel window as src/mentor/anchor.js#resolveAnchor stores it. */
function window(channelId, messages, fields = {}) {
  return { channelId, channelName: 'announcements', readOnly: true, reason: 'routed', messages, olderNotShown: false, ...fields };
}

test('add: the turn a moment was is kept -- mode, kind, source and the windows it was shown; anything malformed goes', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: () => 5000 });
    const source = window('500000000000000002', [{ id: '800000000000000009', authorId: '222', self: false, content: 'are you there?' }]);
    const anchor = {
      ...moment(),
      mode: 'reply',
      triggerKind: 'overheard',
      sourceChannelId: '500000000000000002',
      pulled: [source, window('', [{ id: 'a' }]), window('500000000000000003', []), window('500000000000000004', [{ id: 'b' }], { reason: 'noticed' }), 'junk'],
      media: { described: 0, none: 0 },
    };
    const item = store.add('g1', { text: TEXT_A, target: 'reply', anchor });
    const [stored] = store.get('g1', item.id).anchors;
    assert.deepEqual(stored, { id: 1, ...moment(), mode: 'reply', triggerKind: 'overheard', sourceChannelId: '500000000000000002', pulled: [source], addedAt: new Date(5000).toISOString() });
    // A mode or kind a turn does not have is stored as none.
    const odd = store.add('g1', { text: TEXT_A, target: 'reply', anchor: { ...moment('800000000000000005'), mode: 'auto', triggerKind: 'shouted', sourceChannelId: '' } });
    const [oddStored] = store.get('g1', odd.id).anchors;
    assert.deepEqual({ mode: oddStored.mode, triggerKind: oddStored.triggerKind, sourceChannelId: oddStored.sourceChannelId }, { mode: null, triggerKind: null, sourceChannelId: null });
  } finally {
    cleanup(dir);
  }
});

test('add: a routed moment is replayable by its call, though its chat ends with the persona; a spontaneous one needs no trigger', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir });
    const own = { id: '800000000000000002', authorId: 'self-id', self: true, content: 'ναι' };
    const call = { id: '800000000000000009', authorId: '222', self: false, content: 'are you there?' };
    const routed = { ...moment(), triggerId: call.id, history: [own], sourceChannelId: '500000000000000002', pulled: [window('500000000000000002', [call])] };
    assert.equal(store.add('g1', { text: TEXT_A, target: 'reply', anchor: routed }).anchors[0].triggerId, call.id);
    // The call is her own line: refused.
    const ownCall = { ...routed, pulled: [window('500000000000000002', [{ ...call, self: true }])] };
    assert.throws(() => store.add('g1', { text: TEXT_A, target: 'reply', anchor: ownCall }), /moment/);
    // An unasked turn has no trigger: none needed, whoever wrote last.
    const unasked = { ...moment('800000000000000005'), mode: 'interject', triggerKind: null, triggerId: null, history: [own] };
    assert.equal(store.add('g1', { text: TEXT_A, target: 'reply', anchor: unasked }).anchors[0].triggerId, null);
    // A reply turn still needs one.
    assert.throws(() => store.add('g1', { text: TEXT_A, target: 'reply', anchor: { ...moment('800000000000000006'), triggerId: null } }), /moment/);
  } finally {
    cleanup(dir);
  }
});

test('addAnchor: adds moments up to the max, never twice the same message', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: clock(1000, 2000, 3000) });
    const item = store.add('g1', { text: TEXT_A, target: 'reply', anchor: moment('800000000000000004') });
    const { anchor, item: updated } = store.addAnchor('g1', item.id, moment('800000000000000005'), { max: 2 });
    assert.equal(anchor.id, 2);
    assert.equal(anchor.addedAt, new Date(2000).toISOString());
    assert.deepEqual(updated.anchors.map((a) => a.id), [1, 2]);
    assert.throws(() => store.addAnchor('g1', item.id, moment('800000000000000006'), { max: 2 }), /at most 2/);
    assert.throws(() => store.addAnchor('g1', item.id, moment('800000000000000005'), { max: 5 }), /already/);
    assert.throws(() => store.addAnchor('g1', 42, moment('800000000000000006'), { max: 5 }), /unknown case/);
    assert.deepEqual(store.get('g1', item.id).anchors.map((a) => a.messageId), ['800000000000000004', '800000000000000005']);
  } finally {
    cleanup(dir);
  }
});

test('addAnchor: a retired case or an old memory case takes no moment', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir });
    const retired = store.add('g1', { text: TEXT_A, target: 'reply' });
    store.retire('g1', retired.id);
    const memory = addLegacyCase(dir, 'g1', { text: TEXT_B, target: 'memory' });
    assert.throws(() => store.addAnchor('g1', retired.id, moment(), { max: 5 }), /retired/);
    assert.throws(() => store.addAnchor('g1', memory.id, moment(), { max: 5 }), /reply/);
    assert.throws(() => store.add('g1', { text: TEXT_B, target: 'memory', anchor: moment() }), /target/);
    // A case stored before anchors existed takes its first one.
    const old = store.add('g1', { text: TEXT_A, target: 'reply' });
    assert.equal(store.addAnchor('g1', old.id, moment(), { max: 5 }).anchor.id, 1);
  } finally {
    cleanup(dir);
  }
});

test('retire: hides the case from list, keeps its runs', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: clock(1000, 2000, 3000) });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    store.add('g1', { text: TEXT_B, target: 'reply' });
    const run = store.saveRun('g1', { caseId: 1, passed: true, medians: { overall: 8 } });
    const retired = store.retire('g1', 1);
    assert.equal(retired.state, 'retired');
    assert.deepEqual(store.list('g1').map((c) => c.id), [2]);
    assert.deepEqual(store.list('g1', { includeRetired: true }).map((c) => c.id), [1, 2]);
    assert.equal(store.get('g1', 1).state, 'retired');
    assert.deepEqual(store.lastRun('g1', 1), run);
    assert.ok(fs.existsSync(path.join(dir, 'guilds', 'g1', 'mentor', 'runs', '1', `${run.id}.json`)));
    assert.throws(() => store.retire('g1', 42), /unknown case: 42/);
  } finally {
    cleanup(dir);
  }
});

test('cases: an old stored case with target memory stays readable, listed, retirable and takes feedback', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: clock(1000, 2000, 3000) });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    const old = addLegacyCase(dir, 'g1', { text: TEXT_B, target: 'memory' });
    assert.deepEqual(store.list('g1').map((c) => [c.id, c.target]), [[1, 'reply'], [2, 'memory']]);
    assert.deepEqual(store.get('g1', old.id), old);
    // New ids continue after it.
    assert.equal(store.add('g1', { text: TEXT_A, target: 'reply' }).id, 3);
    const run = store.saveRun('g1', { caseId: old.id, passed: false, medians: { overall: 2 } });
    assert.equal(store.lastRun('g1', old.id).id, run.id);
    assert.equal(store.addFeedback('g1', { caseId: old.id, reason: 'judged too harshly' }).caseId, old.id);
    assert.equal(store.retire('g1', old.id).state, 'retired');
    assert.deepEqual(store.list('g1').map((c) => c.id), [1, 3]);
  } finally {
    cleanup(dir);
  }
});

test('saveRun: sets lastScore and the state from run.passed', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: clock(1000, 2000, 3000, 4000, 5000) });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    const first = store.saveRun('g1', { caseId: 1, passed: true, medians: { overall: 7.5 }, situations: [{ n: 1 }] });
    assert.equal(first.id, '2000');
    assert.deepEqual(first.situations, [{ n: 1 }]);
    let c = store.get('g1', 1);
    assert.equal(c.state, 'passing');
    assert.equal(c.lastScore, 7.5);
    assert.equal(c.lastRunId, '2000');

    const second = store.saveRun('g1', { caseId: 1, passed: false, medians: { overall: null } });
    c = store.get('g1', 1);
    assert.equal(c.state, 'failing');
    assert.equal(c.lastScore, null);
    assert.equal(c.lastRunId, second.id);

    // A run that errored or was stopped is kept but judges nothing.
    const broken = store.saveRun('g1', { caseId: 1, passed: true, medians: { overall: 9 }, error: 'timeout' });
    const stopped = store.saveRun('g1', { caseId: 1, passed: true, stopped: true });
    c = store.get('g1', 1);
    assert.equal(c.state, 'failing');
    assert.equal(c.lastScore, null);
    assert.equal(c.lastRunId, stopped.id);
    assert.equal(store.lastRun('g1', 1).id, stopped.id);
    assert.ok(fs.existsSync(path.join(dir, 'guilds', 'g1', 'mentor', 'runs', '1', `${broken.id}.json`)));

    assert.throws(() => store.saveRun('g1', { caseId: 9, passed: true }), /unknown case: 9/);
  } finally {
    cleanup(dir);
  }
});

test('saveRun: two runs in the same millisecond get different ids', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: () => 7000 });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    const a = store.saveRun('g1', { caseId: 1, passed: true, medians: { overall: 1 } });
    const b = store.saveRun('g1', { caseId: 1, passed: false, medians: { overall: 2 } });
    assert.notEqual(a.id, b.id);
    assert.equal(store.lastRun('g1', 1).id, b.id);
    assert.equal(fs.readdirSync(path.join(dir, 'guilds', 'g1', 'mentor', 'runs', '1')).length, 2);
  } finally {
    cleanup(dir);
  }
});

test('lastRun: returns the newest run of that case', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: clock(100, 200, 300, 9000, 10000, 11000) });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    store.add('g1', { text: TEXT_B, target: 'reply' });
    assert.equal(store.lastRun('g1', 1), null);
    store.saveRun('g1', { caseId: 1, passed: true, medians: { overall: 1 } });
    store.saveRun('g1', { caseId: 1, passed: true, medians: { overall: 2 } });
    store.saveRun('g1', { caseId: 2, passed: true, medians: { overall: 3 } });
    const newest = store.saveRun('g1', { caseId: 1, passed: false, medians: { overall: 4 } });
    // Case 1 holds runs 300, 9000 and 11000: as strings 9000 would win; the newest must.
    assert.deepEqual(store.lastRun('g1', 1), newest);
    assert.equal(store.lastRun('g1', 1).medians.overall, 4);
    assert.equal(store.lastRun('g1', 2).medians.overall, 3);
    assert.equal(store.lastRun('g1', 99), null);
  } finally {
    cleanup(dir);
  }
});

test('addFeedback: needs a case that has a run', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: clock(1000, 2000, 3000) });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    assert.throws(() => store.addFeedback('g1', { caseId: 1, reason: 'too harsh' }), /no run/);
    assert.throws(() => store.addFeedback('g1', { caseId: 5, reason: 'too harsh' }), /unknown case: 5/);
    const run = store.saveRun('g1', { caseId: 1, passed: false, medians: { overall: 3 } });
    assert.throws(() => store.addFeedback('g1', { caseId: 1, reason: ' x ' }), /3/);
    assert.throws(() => store.addFeedback('g1', { caseId: 1, reason: 'y'.repeat(501) }), /500/);
    const fb = store.addFeedback('g1', { caseId: 1, reason: '  too harsh  ' });
    assert.deepEqual(fb, { caseId: 1, runId: run.id, reason: 'too harsh', at: new Date(3000).toISOString() });
    const file = path.join(dir, 'guilds', 'g1', 'mentor', 'feedback.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [fb]);
  } finally {
    cleanup(dir);
  }
});

test('recentFeedback: newest first, capped', () => {
  const dir = tmpDataDir();
  try {
    let t = 0;
    const store = createCaseStore({ dataDir: dir, now: () => (t += 1000) });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    store.add('g1', { text: TEXT_B, target: 'reply' });
    store.saveRun('g1', { caseId: 1, passed: true, medians: { overall: 8 } });
    const run2 = store.saveRun('g1', { caseId: 2, passed: false, medians: { overall: 2 } });
    store.addFeedback('g1', { caseId: 1, reason: 'first note' });
    store.addFeedback('g1', { caseId: 2, reason: 'second note' });
    store.addFeedback('g1', { caseId: 1, reason: 'third note' });
    assert.deepEqual(store.recentFeedback('g1', 10).map((f) => f.reason), ['third note', 'second note', 'first note']);
    const two = store.recentFeedback('g1', 2);
    assert.equal(two.length, 2);
    assert.deepEqual(two[1], {
      caseId: 2, runId: run2.id, reason: 'second note', at: two[1].at, caseText: TEXT_B,
    });
    assert.equal(two[0].caseText, TEXT_A);
    assert.deepEqual(store.recentFeedback('g1', 0), []);
    assert.deepEqual(store.recentFeedback('g2', 5), []);
  } finally {
    cleanup(dir);
  }
});

test('files: a crash between two writes never leaves a half file', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: clock(1000, 2000, 3000, 4000) });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    const mentorDir = path.join(dir, 'guilds', 'g1', 'mentor');
    const casesFile = path.join(mentorDir, 'cases.json');
    const whole = fs.readFileSync(casesFile, 'utf8');
    // A crash after the temp file was written, before the rename: the temp file is half written.
    const stale = `${casesFile}.${process.pid}.tmp`;
    fs.writeFileSync(stale, whole.slice(0, 20));
    // The real file is still whole and is what the store reads.
    assert.equal(store.get('g1', 1).text, TEXT_A);
    // The next writes go through the atomic writer and consume the temp file.
    store.saveRun('g1', { caseId: 1, passed: true, medians: { overall: 6 } });
    store.addFeedback('g1', { caseId: 1, reason: 'judged too kindly' });
    store.retire('g1', 1);
    const files = allFiles(mentorDir);
    assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
    for (const file of files) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), file);
    assert.equal(store.get('g1', 1).state, 'retired');
  } finally {
    cleanup(dir);
  }
});

test('files: broken JSON throws instead of starting over', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    const casesFile = path.join(dir, 'guilds', 'g1', 'mentor', 'cases.json');
    fs.writeFileSync(casesFile, '{ "nextId": 2, "cases": [');
    assert.throws(() => store.list('g1'), /cases\.json/);
    assert.throws(() => store.add('g1', { text: TEXT_B, target: 'reply' }), /cases\.json/);
    assert.equal(fs.readFileSync(casesFile, 'utf8'), '{ "nextId": 2, "cases": [');
    const feedbackFile = path.join(dir, 'guilds', 'g1', 'mentor', 'feedback.json');
    fs.writeFileSync(feedbackFile, 'not json');
    assert.throws(() => store.recentFeedback('g1', 3), /feedback\.json/);
  } finally {
    cleanup(dir);
  }
});
