// Tests for src/mentor/report.js: the short card posted to the admin channel
// and the full text file attached to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCard, renderFile, renderCheckCard, renderCheckFile, renderLastRun } from '../src/mentor/report.js';

const ALICE = '111111111111111111';

function score(overall, comment = 'a comment') {
  return { human: 6, character: null, rules: 8, goal: 7, overall, comment };
}

function replyAnswer(n, s, overrides = {}) {
  return {
    id: `s${n}a${s}`,
    messages: [`answer ${n}.${s} ναι`],
    reactions: s === 2 ? ['👍'] : [],
    silent: false,
    facts: { chars: 12, messages: 1, unusedMarks: { semicolon: 1 }, commaPer1000: 0, lengthOverP75: false, replyQuoted: false },
    score: score(5 + s, `comment ${n}.${s}`),
    ...overrides,
  };
}

function fakeRun(overrides = {}) {
  const situations = Array.from({ length: 5 }, (_, i) => ({
    n: i + 1,
    title: `situation ${i + 1} ${'long title '.repeat(20)}`,
    lines: [
      { authorId: ALICE, authorName: 'Alice', text: 'καλημέρα', replyTo: null },
      { authorId: ALICE, authorName: 'Alice', text: 'what now?', replyTo: null },
    ],
    transcript: '=== date ===\n#1 Alice: καλημέρα\n#2 Alice: what now?',
    answers: [1, 2, 3].map((s) => replyAnswer(i + 1, s)),
  }));
  return {
    id: '1790000000000',
    caseId: 3,
    caseText: 'The persona answers a question about its limits calmly. '.repeat(20),
    target: 'reply',
    kind: 'run',
    startedAt: '2026-09-30T10:00:00.000Z',
    finishedAt: '2026-09-30T10:05:00.000Z',
    models: { mentor: 'x/mentor', talk: 'x/talk', analyzer: 'x/memory' },
    reference: { profile: { messages: 100 }, samples: 40 },
    situations,
    dropped: 1,
    repeated: [{ phrase: 'as i said before', count: 3 }],
    medians: { human: 6, character: null, rules: 8, goal: 7, overall: 7 },
    passed: true,
    reasons: [],
    tokens: { spent: 123456, left: 276544 },
    ...overrides,
  };
}

test('renderCard: stays under 1800 characters with 5 situations', () => {
  const card = renderCard(fakeRun());
  assert.ok(card.length <= 1800, `card is ${card.length} characters`);
  assert.match(card, /case 3/);
  assert.match(card, /reply/);
  assert.match(card, /passed/i);
  assert.match(card, /15 of 15/);
  assert.match(card, /123456/);
  assert.match(card, /276544/);
  assert.match(card, /\/nep mentor show 3/);
  // The case text is clipped.
  assert.ok(!card.includes(fakeRun().caseText));
});

test('renderCard: stays under 1800 characters whatever the error length', () => {
  const card = renderCard(fakeRun({ passed: false, error: 'x'.repeat(5000), reasons: Array(50).fill('overall 3 is under 7') }));
  assert.ok(card.length <= 1800);
});

test('renderCard: says when the budget stopped the run', () => {
  const card = renderCard(fakeRun({ passed: false, stopped: 'budget' }));
  assert.match(card, /budget/i);
  assert.match(card, /stopped/i);
  assert.doesNotMatch(card, /\bpassed\b/i);
});

test('renderCard: says when the mentor was disabled during the run', () => {
  const run = fakeRun({ passed: false, stopped: 'disabled' });
  assert.match(renderCard(run), /stopped: the mentor was disabled during the run/);
  assert.match(renderFile(run).text, /outcome: stopped: the mentor was disabled during the run/);
});

test('renderCard: says when the owner stopped the run or it failed', () => {
  assert.match(renderCard(fakeRun({ passed: false, stopped: 'owner' })), /owner/i);
  assert.match(renderCard(fakeRun({ passed: false, error: 'no valid situation' })), /no valid situation/);
});

test('renderCard: shows unscored answers and null medians', () => {
  const run = fakeRun({ passed: false, medians: { human: null, character: null, rules: null, goal: null, overall: null } });
  run.situations[0].answers[0].score = null;
  const card = renderCard(run);
  assert.match(card, /14 of 15/);
  assert.match(card, /overall -/);
});

test('renderFile: lists every answer with its points', () => {
  const run = fakeRun();
  const file = renderFile(run);
  assert.equal(file.name, 'mentor-case-3-1790000000000.txt');
  for (const situation of run.situations) {
    assert.ok(file.text.includes(situation.transcript));
    for (const answer of situation.answers) {
      assert.ok(file.text.includes(answer.id), answer.id);
      assert.ok(file.text.includes(answer.messages[0]));
      assert.ok(file.text.includes(answer.score.comment));
    }
  }
  assert.match(file.text, /human 6 · character - · rules 8 · goal 7 · overall 6/);
  assert.match(file.text, /👍/);
  assert.match(file.text, /semicolon/);
  assert.match(file.text, /as i said before/);
  assert.ok(file.text.includes(run.caseText));
});

test('renderFile: a memory answer shows its stored texts', () => {
  const run = fakeRun({ target: 'memory', repeated: [] });
  run.situations = [
    {
      n: 1,
      title: 't',
      lines: [],
      transcript: 'tr',
      answers: [
        { id: 's1a1', texts: [{ path: 'users.1.character', text: 'likes chess, café au lait' }], parseOk: true, facts: {}, score: null },
        { id: 's1a2', texts: [], parseOk: false, facts: {}, score: null },
      ],
    },
  ];
  const file = renderFile(run);
  assert.match(file.text, /users\.1\.character: likes chess, café au lait/);
  assert.match(file.text, /not scored/);
  assert.match(file.text, /not parsed/i);
});

test('renderCheckCard: lists checked and skipped cases under 1800 characters', () => {
  const runs = Array.from({ length: 40 }, (_, i) => fakeRun({ caseId: i + 1, passed: i % 2 === 0 }));
  const skipped = [{ caseId: 99, reason: 'never run' }];
  const card = renderCheckCard(runs, skipped);
  assert.ok(card.length <= 1800);
  assert.match(card, /case 1: passed/);
  assert.match(card, /case 2: failed/);
  const small = renderCheckCard(runs.slice(0, 2), skipped);
  assert.match(small, /case 99: skipped \(never run\)/);
});

test('renderCheckFile: holds every run of the check', () => {
  const runs = [fakeRun({ caseId: 1 }), fakeRun({ caseId: 2 })];
  const file = renderCheckFile(runs, 1790000000000);
  assert.equal(file.name, 'mentor-check-1790000000000.txt');
  assert.match(file.text, /case 1/);
  assert.match(file.text, /case 2/);
});

test('renderLastRun: a passed run', () => {
  assert.equal(
    renderLastRun(fakeRun()),
    'last: case 3, passed, overall 7, 15 of 15 answers scored, 123456 tokens, finished 2026-09-30 10:05 UTC',
  );
});

test('renderLastRun: a failed run, with an unscored answer and no median', () => {
  const run = fakeRun({ passed: false, medians: { human: null, character: null, rules: null, goal: null, overall: null } });
  run.situations[0].answers[0].score = null;
  assert.equal(renderLastRun(run), 'last: case 3, failed, overall -, 14 of 15 answers scored, 123456 tokens, finished 2026-09-30 10:05 UTC');
});

test('renderLastRun: a run stopped by the budget', () => {
  const run = fakeRun({ passed: false, stopped: 'budget', situations: [], tokens: { spent: 900, left: 0 } });
  assert.equal(renderLastRun(run), 'last: case 3, stopped (budget), overall 7, 0 of 0 answers scored, 900 tokens, finished 2026-09-30 10:05 UTC');
});

test('renderLastRun: a run stopped by the owner', () => {
  assert.match(renderLastRun(fakeRun({ passed: false, stopped: 'owner' })), /^last: case 3, stopped \(owner\), overall 7, /);
});

test('renderLastRun: a run stopped because the mentor was disabled', () => {
  assert.match(renderLastRun(fakeRun({ passed: false, stopped: 'disabled' })), /^last: case 3, stopped \(disabled\), overall 7, /);
});

test('renderLastRun: an error, its reason clipped to 60 characters', () => {
  const reason = `a model request failed ${'ναι '.repeat(40)}`;
  const line = renderLastRun(fakeRun({ passed: false, error: reason, finishedAt: '2026-01-05T08:09:59.999Z' }));
  const shown = /^last: case 3, error \((.*)\), overall 7, 15 of 15 answers scored, 123456 tokens, finished 2026-01-05 08:09 UTC$/.exec(line);
  assert.ok(shown, line);
  assert.equal(shown[1].length, 60);
  assert.ok(shown[1].startsWith('a model request failed ναι'));
  assert.ok(shown[1].endsWith('...'));
  assert.match(renderLastRun(fakeRun({ passed: false, error: 'no valid situation' })), /, error \(no valid situation\), /);
});

test('renderLastRun: no run yet', () => {
  assert.equal(renderLastRun(null), 'last: no run yet');
  assert.equal(renderLastRun(undefined), 'last: no run yet');
});
