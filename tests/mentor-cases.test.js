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

test('add: stores the case and returns increasing ids', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: () => 5000 });
    const a = store.add('g1', { text: `  ${TEXT_A}  `, target: 'reply' });
    const b = store.add('g1', { text: TEXT_B, target: 'memory' });
    assert.deepEqual(a, {
      id: 1, text: TEXT_A, target: 'reply', state: 'new',
      createdAt: new Date(5000).toISOString(), lastRunId: null, lastScore: null,
    });
    assert.equal(b.id, 2);
    assert.equal(b.target, 'memory');
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

test('retire: hides the case from list, keeps its runs', () => {
  const dir = tmpDataDir();
  try {
    const store = createCaseStore({ dataDir: dir, now: clock(1000, 2000, 3000) });
    store.add('g1', { text: TEXT_A, target: 'reply' });
    store.add('g1', { text: TEXT_B, target: 'memory' });
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
    store.add('g1', { text: TEXT_B, target: 'memory' });
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
    store.add('g1', { text: TEXT_B, target: 'memory' });
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
    assert.throws(() => store.add('g1', { text: TEXT_B, target: 'memory' }), /cases\.json/);
    assert.equal(fs.readFileSync(casesFile, 'utf8'), '{ "nextId": 2, "cases": [');
    const feedbackFile = path.join(dir, 'guilds', 'g1', 'mentor', 'feedback.json');
    fs.writeFileSync(feedbackFile, 'not json');
    assert.throws(() => store.recentFeedback('g1', 3), /feedback\.json/);
  } finally {
    cleanup(dir);
  }
});
