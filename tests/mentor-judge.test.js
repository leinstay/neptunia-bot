// Tests for src/mentor/judge.js: validation of the mentor model's JSON
// (situations and scores) and the pass rule over the medians.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSituations, parseScores, verdict } from '../src/mentor/judge.js';

const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';
const KNOWN = new Set([ALICE, BRUNO]);
const OPTS = { knownIds: KNOWN, lines: [2, 4], count: 5 };

function line(authorId, text = 'καλημέρα σε όλους', extra = {}) {
  return { authorId, authorName: authorId === 'self' ? 'self' : 'someone', text, ...extra };
}

function situation(lines, title = 'a small talk') {
  return { title, lines };
}

function raw(situations) {
  return `Here you go:\n\`\`\`json\n${JSON.stringify({ situations })}\n\`\`\``;
}

function score(overrides = {}) {
  return { human: 7, character: 7, rules: 7, goal: 7, overall: 7, comment: 'fine', ...overrides };
}

// ---- parseSituations ---------------------------------------------------------

test('parseSituations: keeps a valid situation with its lines', () => {
  const { situations, dropped } = parseSituations(
    raw([situation([line(BRUNO), line('self', 'ναι'), line(ALICE, 'what now?', { replyTo: 1, minutesBefore: 1 })])]),
    OPTS,
  );
  assert.equal(dropped, 0);
  assert.equal(situations.length, 1);
  assert.equal(situations[0].title, 'a small talk');
  assert.deepEqual(situations[0].lines[2], { authorId: ALICE, authorName: 'someone', text: 'what now?', replyTo: 1, minutesBefore: 1 });
  assert.equal(situations[0].lines[0].replyTo, null);
});

test('parseSituations: drops a situation with an unknown author', () => {
  const { situations, dropped } = parseSituations(
    raw([
      situation([line(BRUNO), line('333333333333333333')]),
      situation([line(BRUNO), line(ALICE)]),
    ]),
    OPTS,
  );
  assert.equal(dropped, 1);
  assert.equal(situations.length, 1);
  assert.equal(situations[0].lines[1].authorId, ALICE);
});

test('parseSituations: drops a situation whose last line is by self', () => {
  const { situations, dropped } = parseSituations(raw([situation([line(ALICE), line('self')])]), OPTS);
  assert.equal(dropped, 1);
  assert.deepEqual(situations, []);
});

test('parseSituations: drops a situation with too few or too many lines', () => {
  const { situations, dropped } = parseSituations(
    raw([situation([line(ALICE)]), situation([line(ALICE), line(BRUNO), line(ALICE), line(BRUNO), line(ALICE)])]),
    OPTS,
  );
  assert.equal(dropped, 2);
  assert.deepEqual(situations, []);
});

test('parseSituations: drops empty, overlong text and a replyTo that is not an earlier line', () => {
  const { situations, dropped } = parseSituations(
    raw([
      situation([line(ALICE, '   '), line(BRUNO)]),
      situation([line(ALICE, 'é'.repeat(501)), line(BRUNO)]),
      situation([line(ALICE), line(BRUNO, 'ok', { replyTo: 1 })]),
      situation([line(ALICE, 'é'.repeat(500)), line(BRUNO)]),
    ]),
    OPTS,
  );
  assert.equal(dropped, 3);
  assert.equal(situations.length, 1);
});

test('parseSituations: keeps at most count', () => {
  const many = Array.from({ length: 4 }, (_, i) => situation([line(ALICE), line(BRUNO)], `s${i}`));
  const { situations, dropped } = parseSituations(raw(many), { ...OPTS, count: 2 });
  assert.equal(dropped, 0);
  assert.deepEqual(situations.map((s) => s.title), ['s0', 's1']);
});

test('parseSituations: text that is not JSON gives nothing', () => {
  assert.deepEqual(parseSituations('no json here', OPTS), { situations: [], dropped: 0 });
  assert.deepEqual(parseSituations('{"situations": 3}', OPTS), { situations: [], dropped: 0 });
});

// ---- parseScores -------------------------------------------------------------

test('parseScores: reads each listed answer', () => {
  const text = JSON.stringify({ answers: [{ id: 's1a1', ...score({ comment: 'ça va' }) }, { id: 's1a2', ...score({ overall: 3 }) }] });
  const { scores, missing } = parseScores(text, ['s1a1', 's1a2']);
  assert.deepEqual(missing, []);
  assert.deepEqual(scores.get('s1a1'), score({ comment: 'ça va' }));
  assert.equal(scores.get('s1a2').overall, 3);
});

test('parseScores: a score outside 0..10 becomes missing', () => {
  const text = JSON.stringify({
    answers: [
      { id: 's1a1', ...score({ human: 11 }) },
      { id: 's1a2', ...score({ rules: -1 }) },
      { id: 's1a3', ...score({ goal: 6.5 }) },
      { id: 's1a4', ...score() },
    ],
  });
  const { scores, missing } = parseScores(text, ['s1a1', 's1a2', 's1a3', 's1a4']);
  assert.deepEqual(missing, ['s1a1', 's1a2', 's1a3']);
  assert.deepEqual([...scores.keys()], ['s1a4']);
});

test('parseScores: null is allowed except for overall and goal', () => {
  const text = JSON.stringify({
    answers: [
      { id: 's1a1', ...score({ character: null, human: null, rules: null }) },
      { id: 's1a2', ...score({ overall: null }) },
      { id: 's1a3', ...score({ goal: null }) },
    ],
  });
  const { scores, missing } = parseScores(text, ['s1a1', 's1a2', 's1a3']);
  assert.deepEqual(missing, ['s1a2', 's1a3']);
  assert.deepEqual(scores.get('s1a1'), score({ character: null, human: null, rules: null }));
});

test('parseScores: an answer absent from the reply or unknown ids are handled', () => {
  const text = JSON.stringify({ answers: [{ id: 'zz', ...score() }, { id: 's2a1', ...score() }] });
  const { scores, missing } = parseScores(text, ['s2a1', 's2a2']);
  assert.deepEqual(missing, ['s2a2']);
  assert.deepEqual([...scores.keys()], ['s2a1']);
});

test('parseScores: text that is not JSON leaves every answer missing', () => {
  const { scores, missing } = parseScores('sorry', ['s1a1', 's1a2']);
  assert.equal(scores.size, 0);
  assert.deepEqual(missing, ['s1a1', 's1a2']);
});

// ---- verdict -----------------------------------------------------------------

const PASS = { score: 7, floor: 5 };

test('verdict: passes on medians', () => {
  const result = verdict([score({ overall: 9, goal: 8 }), score({ overall: 7, goal: 7 }), score({ overall: 2, goal: 3 })], PASS);
  assert.equal(result.passed, true);
  assert.deepEqual(result.medians, { human: 7, character: 7, rules: 7, goal: 7, overall: 7 });
  assert.deepEqual(result.reasons, []);
});

test('verdict: median of an even count is the mean of the middle two', () => {
  const result = verdict([score({ overall: 6 }), score({ overall: 9 })], PASS);
  assert.equal(result.medians.overall, 7.5);
  assert.equal(result.passed, true);
});

test('verdict: overall or goal under the pass score fails', () => {
  const low = verdict([score({ overall: 6 })], PASS);
  assert.equal(low.passed, false);
  assert.equal(low.reasons.length, 1);
  assert.match(low.reasons[0], /overall/);
  const goal = verdict([score({ goal: 6 })], PASS);
  assert.equal(goal.passed, false);
  assert.match(goal.reasons[0], /goal/);
});

test('verdict: one axis under the floor fails', () => {
  const result = verdict([score({ human: 4 }), score({ human: 4 }), score({ human: 9 })], PASS);
  assert.equal(result.passed, false);
  assert.equal(result.medians.human, 4);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /human/);
});

test('verdict: an axis of nulls is not checked', () => {
  const result = verdict([score({ character: null }), score({ character: null })], PASS);
  assert.equal(result.medians.character, null);
  assert.equal(result.passed, true);
});

test('verdict: nothing scored does not pass', () => {
  const result = verdict([], PASS);
  assert.equal(result.passed, false);
  assert.deepEqual(result.medians, { human: null, character: null, rules: null, goal: null, overall: null });
  assert.equal(result.reasons.length, 1);
});
