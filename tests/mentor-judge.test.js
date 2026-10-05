// Tests for src/mentor/judge.js: validation of the mentor model's JSON
// (situations, scores and the diagnosis) and the pass rule over the medians.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiagnosis, parseSituations, parseScores, verdict } from '../src/mentor/judge.js';

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
      situation([line(ALICE, 'é'.repeat(2001)), line(BRUNO)]),
      situation([line(ALICE), line(BRUNO, 'ok', { replyTo: 1 })]),
      situation([line(ALICE, 'é'.repeat(2000)), line(BRUNO)]),
    ]),
    OPTS,
  );
  assert.equal(dropped, 3);
  assert.equal(situations.length, 1);
});

test('parseSituations: a line of a real dispute length (up to 2000 characters) is kept', () => {
  const { situations, dropped } = parseSituations(raw([situation([line(ALICE, 'é'.repeat(1932)), line(BRUNO, 'ô'.repeat(1580))])]), OPTS);
  assert.equal(dropped, 0);
  assert.equal(situations[0].lines[0].text.length, 1932);
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

test('verdict: returns the pass score it resolved, the config.json value when unusable', () => {
  assert.equal(verdict([score()], PASS).passScore, 7);
  assert.equal(verdict([score()], { score: 8, floor: 5 }).passScore, 8);
  assert.equal(verdict([], { score: 9, floor: 5 }).passScore, 9, 'also when nothing was scored');
  for (const passCfg of [undefined, null, {}, { score: '8' }, { score: Number.NaN }]) {
    assert.equal(verdict([score()], passCfg).passScore, 7, JSON.stringify(passCfg));
  }
});

// ---- verdict by situation ----------------------------------------------------

/** Five situations of three scored answers; `n` (1-based) gets `low` instead of the default. */
function groupsWith(n, low) {
  return Array.from({ length: 5 }, (_, i) => (i + 1 === n ? low : [score({ overall: 9 }), score({ overall: 8 }), score({ overall: 9 })]));
}

test('verdict: a situation whose median is under the floor on overall or on goal fails the case', () => {
  for (const [axis, n, low, median, reason] of [
    ['overall', 2, [score({ overall: 3 }), score({ overall: 4 }), score({ overall: 3 })], 9, 'situation 2: overall 3 is under the floor 5'],
    ['goal', 4, [score({ goal: 4 }), score({ goal: 2 }), score({ goal: 9 })], 7, 'situation 4: goal 4 is under the floor 5'],
  ]) {
    const groups = groupsWith(n, low);
    const result = verdict(groups.flat(), PASS, groups);
    // The medians over all fifteen answers pass on their own.
    assert.equal(result.medians[axis], median, `${axis}: the median over all answers`);
    assert.equal(result.passed, false, `${axis}: the case fails`);
    assert.deepEqual(result.reasons, [reason], `${axis}: the reason`);
  }
});

test('verdict: without groups the rule is unchanged', () => {
  const groups = groupsWith(2, [score({ overall: 3 }), score({ overall: 4 }), score({ overall: 3 })]);
  const result = verdict(groups.flat(), PASS);
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.situations, []);
  assert.deepEqual(verdict([], PASS).situations, []);
});

test('verdict: a situation with no scored answer is left out', () => {
  const groups = [[score({ overall: 9 })], [], [null], [score({ overall: 7 })]];
  const result = verdict([score({ overall: 9 }), score({ overall: 7 })], PASS, groups);
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.situations, [
    { n: 1, overall: 9, goal: 7 },
    { n: 4, overall: 7, goal: 7 },
  ]);
});

test('verdict: reports the medians of every situation', () => {
  const groups = [
    [score({ overall: 9, goal: 8 }), score({ overall: 6, goal: 8 })],
    [score({ overall: 4, goal: 3 }), score({ overall: 2, goal: 6 }), score({ overall: 9, goal: 2 })],
  ];
  const result = verdict(groups.flat(), PASS, groups);
  assert.deepEqual(result.situations, [
    { n: 1, overall: 7.5, goal: 8 },
    { n: 2, overall: 4, goal: 3 },
  ]);
  assert.deepEqual(result.reasons.slice(-2), ['situation 2: overall 4 is under the floor 5', 'situation 2: goal 3 is under the floor 5']);
  assert.equal(result.passed, false);
});

// ---- verdict: real moments are held to the pass score --------------------------

/** Three situations: 1 and 2 at 6/6 (over the floor, under the pass score), 3 well over. */
function sixes() {
  const six = () => [score({ overall: 6, goal: 6 }), score({ overall: 6, goal: 6 }), score({ overall: 6, goal: 6 })];
  const high = [score({ overall: 9, goal: 9 }), score({ overall: 9, goal: 9 }), score({ overall: 9, goal: 9 })];
  return [six(), six(), high];
}

test('verdict: a real moment under the pass score fails the case, an invented one at the same score passes the floor', () => {
  const groups = sixes();
  // Medians over all answers held at 9 so that only the per-situation rule can fail.
  const lifted = [...groups.flat(), ...Array.from({ length: 9 }, () => score({ overall: 9, goal: 9 }))];
  const plain = verdict(lifted, PASS, groups);
  assert.equal(plain.passed, true);
  assert.deepEqual(plain.reasons, []);
  const anchored = verdict(lifted, PASS, groups, new Set([1]));
  assert.equal(anchored.passed, false);
  assert.deepEqual(anchored.reasons, ['real moment 1: overall 6 is under the pass score 7', 'real moment 1: goal 6 is under the pass score 7']);
  // The situations are reported the same way whatever their kind.
  assert.deepEqual(anchored.situations, plain.situations);
});

test('verdict: a real moment at the pass score passes; one under it on goal alone fails on goal', () => {
  const at = [[score({ overall: 7, goal: 7 })], [score({ overall: 9, goal: 9 })]];
  assert.equal(verdict(at.flat(), PASS, at, new Set([1])).passed, true);
  const goal = [[score({ overall: 8, goal: 6 })], [score({ overall: 9, goal: 9 })], [score({ overall: 9, goal: 9 })]];
  const result = verdict(goal.flat(), PASS, goal, new Set([1]));
  assert.deepEqual(result.reasons, ['real moment 1: goal 6 is under the pass score 7']);
});

test('verdict: mentor.pass.anchorScore overrides the pass score for real moments; null means the pass score', () => {
  const groups = [[score({ overall: 7, goal: 8 })], [score({ overall: 9, goal: 9 })], [score({ overall: 9, goal: 9 })]];
  const higher = verdict(groups.flat(), { ...PASS, anchorScore: 8 }, groups, new Set([1]));
  assert.equal(higher.passed, false);
  assert.deepEqual(higher.reasons, ['real moment 1: overall 7 is under the anchor score 8']);
  const lower = verdict(groups.flat(), { ...PASS, anchorScore: 6 }, [[score({ overall: 6, goal: 6 })], ...groups.slice(1)], new Set([1]));
  assert.equal(lower.passed, true);
  const same = verdict(groups.flat(), { ...PASS, anchorScore: null }, groups, new Set([1]));
  assert.equal(same.passed, true);
  const unusable = verdict(groups.flat(), { ...PASS, anchorScore: '9' }, groups, new Set([1]));
  assert.equal(unusable.passed, true, 'a value that is not a number is the pass score');
});

test('verdict: the real moments are named by their place in groups; without groups nothing is held per situation', () => {
  const groups = sixes();
  const lifted = [...groups.flat(), ...Array.from({ length: 9 }, () => score({ overall: 9, goal: 9 }))];
  const second = verdict(lifted, PASS, groups, new Set([2]));
  assert.deepEqual(second.reasons, ['real moment 2: overall 6 is under the pass score 7', 'real moment 2: goal 6 is under the pass score 7']);
  const none = verdict(lifted, PASS, undefined, new Set([1]));
  assert.equal(none.passed, true);
  assert.deepEqual(none.situations, []);
});

test('verdict: a real moment under the floor is reported once, against the pass score', () => {
  const groups = [[score({ overall: 3, goal: 9 })], [score({ overall: 9, goal: 9 })], [score({ overall: 9, goal: 9 })]];
  const result = verdict(groups.flat(), PASS, groups, [1]);
  assert.deepEqual(result.reasons, ['real moment 1: overall 3 is under the pass score 7']);
});

// ---- parseDiagnosis ----------------------------------------------------------

function diagnosis(overrides = {}) {
  return {
    summary: 'The persona explains the limit at length instead of saying it once.',
    causes: [
      { layer: 'rules', excerpt: 'explain every refusal', why: 'The rule asks for an explanation.' },
      { layer: 'missing', excerpt: '', why: 'Nothing says a limit notice is short.' },
    ],
    changes: [{ layer: 'rules', target: 'rules.md', from: 'explain every refusal', to: 'say a refusal once', why: 'Shorter notices.' }],
    ...overrides,
  };
}

test('parseDiagnosis: keeps a valid diagnosis', () => {
  const value = diagnosis();
  const parsed = parseDiagnosis(`Here it is:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``);
  assert.deepEqual(parsed, value);
  // Missing optional strings become empty.
  const bare = parseDiagnosis(JSON.stringify(diagnosis({ causes: [{ layer: 'card', why: 'too formal' }], changes: [{ layer: 'self', why: 'café talk' }] })));
  assert.deepEqual(bare.causes, [{ layer: 'card', excerpt: '', why: 'too formal' }]);
  assert.deepEqual(bare.changes, [{ layer: 'self', target: '', from: '', to: '', why: 'café talk' }]);
});

test('parseDiagnosis: a missing summary or a reply that is not the shape gives null', () => {
  assert.equal(parseDiagnosis(JSON.stringify(diagnosis({ summary: undefined }))), null);
  assert.equal(parseDiagnosis(JSON.stringify(diagnosis({ summary: '   ' }))), null);
  assert.equal(parseDiagnosis(JSON.stringify(diagnosis({ summary: 42 }))), null);
  assert.equal(parseDiagnosis(JSON.stringify(diagnosis({ causes: 'none' }))), null);
  assert.equal(parseDiagnosis(JSON.stringify(diagnosis({ changes: undefined }))), null);
  assert.equal(parseDiagnosis('I think the rules are to blame.'), null);
  assert.equal(parseDiagnosis(''), null);
  assert.equal(parseDiagnosis(null), null);
});

test('parseDiagnosis: an item with an unknown layer or without why is dropped', () => {
  const parsed = parseDiagnosis(
    JSON.stringify(
      diagnosis({
        causes: [
          { layer: 'weather', excerpt: 'x', why: 'no such layer' },
          { layer: 'guild', excerpt: 'x' },
          { layer: 'profile', excerpt: 'x', why: '  ' },
          'rules',
          { layer: 'learned', excerpt: 'answer in one line', why: 'kept' },
        ],
        changes: [
          { layer: 'missing', target: 'x', to: 'y', why: 'missing is not a change layer' },
          { layer: 'prompt', target: 'reply.md', to: 'y' },
          { layer: 'guild', target: 'patterns', from: '', to: 'short greetings', why: 'kept' },
        ],
      }),
    ),
  );
  assert.deepEqual(parsed.causes, [{ layer: 'learned', excerpt: 'answer in one line', why: 'kept' }]);
  assert.deepEqual(parsed.changes, [{ layer: 'guild', target: 'patterns', from: '', to: 'short greetings', why: 'kept' }]);
});

test('parseDiagnosis: at most five causes and five changes', () => {
  const causes = Array.from({ length: 8 }, (_, i) => ({ layer: 'rules', excerpt: `rule ${i}`, why: `why ${i}` }));
  const changes = Array.from({ length: 7 }, (_, i) => ({ layer: 'card', target: 'card', from: '', to: `line ${i}`, why: `why ${i}` }));
  const parsed = parseDiagnosis(JSON.stringify(diagnosis({ causes, changes })));
  assert.deepEqual(parsed.causes.map((c) => c.excerpt), ['rule 0', 'rule 1', 'rule 2', 'rule 3', 'rule 4']);
  assert.deepEqual(parsed.changes.map((c) => c.to), ['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
});

test('parseDiagnosis: long strings are clipped', () => {
  const parsed = parseDiagnosis(
    JSON.stringify({
      summary: 's'.repeat(2000),
      causes: [{ layer: 'prompt', excerpt: 'e'.repeat(400), why: 'w'.repeat(600) }],
      changes: [{ layer: 'profile', target: 't'.repeat(300), from: 'f'.repeat(1200), to: 'τ'.repeat(1200), why: 'y'.repeat(600) }],
    }),
  );
  assert.equal(parsed.summary.length, 1500);
  assert.equal(parsed.causes[0].excerpt.length, 300);
  assert.equal(parsed.causes[0].why.length, 500);
  const [change] = parsed.changes;
  assert.equal(change.target.length, 200);
  assert.equal(change.from.length, 1000);
  assert.equal([...change.to].length, 1000);
  assert.equal(change.why.length, 500);
});
