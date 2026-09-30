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

const BY_SITUATION = [
  { n: 1, overall: 9, goal: 8 },
  { n: 2, overall: 3, goal: 4 },
  { n: 3, overall: 7, goal: 7 },
  { n: 5, overall: 6.5, goal: 7 },
];

test('renderCard: shows the overall median of every situation', () => {
  const card = renderCard(fakeRun({ situationMedians: BY_SITUATION }));
  assert.ok(card.length <= 1800);
  const lines = card.split('\n');
  const at = lines.findIndex((l) => l.startsWith('medians: '));
  // Situation 4 had no scored answer.
  assert.equal(lines[at + 1], 'by situation: 1: 9 · 2: 3 · 3: 7 · 4: - · 5: 6.5');
});

/** A run whose first two situations are real moments (anchors 1 and 3). */
function anchoredRun() {
  const run = fakeRun({ situationMedians: BY_SITUATION });
  run.situations = run.situations.map((s, i) => {
    if (i > 1) return s;
    const { lines: _lines, ...rest } = s;
    return { ...rest, title: '', anchor: i === 0 ? 1 : 3, original: [`original ${i + 1} ναι`, 'second line'] };
  });
  return run;
}

test('renderCard: marks the anchor situations and counts them', () => {
  const card = renderCard(anchoredRun());
  assert.ok(card.length <= 1800);
  assert.match(card, /^by situation: 1 \(anchor\): 9 · 2 \(anchor\): 3 · 3: 7 · 4: - · 5: 6\.5$/m);
  assert.match(card, /situations: 5 kept \(2 anchors\), 1 dropped$/m);
  // A run without anchors keeps its lines as they were.
  assert.match(renderCard(fakeRun()), /situations: 5 kept, 1 dropped$/m);
});

test('renderFile: an anchor situation names its anchor and shows the original answer', () => {
  const text = renderFile(anchoredRun()).text;
  assert.match(text, /^Situation 1 \(anchor 1\): $/m);
  assert.match(text, /^Situation 2 \(anchor 3\): $/m);
  assert.match(text, /^Situation 3: situation 3 /m);
  assert.match(text, /#2 Alice: what now\?\n\noriginal answer:\n {2}original 1 ναι\n {2}second line\n/);
  assert.equal(text.match(/^original answer:$/gm).length, 2);
});

test('renderCard: a run stored before the medians by situation has no such line', () => {
  const run = fakeRun();
  assert.equal('situationMedians' in run, false);
  assert.doesNotMatch(renderCard(run), /by situation/);
  assert.doesNotMatch(renderFile(run).text, /^medians: overall/m);
  assert.doesNotMatch(renderCard(fakeRun({ situationMedians: [] })), /by situation/);
});

const DIAGNOSIS = {
  summary: 'The persona explains the limit at length; the rules ask for an explanation of every refusal.',
  causes: [
    { layer: 'rules', excerpt: 'explain every refusal', why: 'The rule asks for an explanation.' },
    { layer: 'missing', excerpt: '', why: 'Nothing says a limit notice is short, café style.' },
  ],
  changes: [
    { layer: 'rules', target: 'rules.md', from: 'explain every refusal', to: 'say a refusal once', why: 'Shorter notices.' },
    { layer: 'learned', target: 'learned item 4', from: '', to: 'a limit is said in one line', why: 'An addition.' },
  ],
};

test('renderCard: shows the diagnosis summary', () => {
  const card = renderCard(fakeRun({ passed: false, situationMedians: BY_SITUATION, diagnosis: DIAGNOSIS }));
  const lines = card.split('\n');
  const at = lines.findIndex((l) => l.startsWith('by situation: '));
  assert.equal(lines[at + 1], `diagnosis: ${DIAGNOSIS.summary}`);
  // A long summary is clipped to 300 characters.
  const long = renderCard(fakeRun({ diagnosis: { ...DIAGNOSIS, summary: `ναι ${'x'.repeat(1400)}` } }));
  const line = long.split('\n').find((l) => l.startsWith('diagnosis: '));
  assert.equal(line.length, 'diagnosis: '.length + 300);
  assert.ok(line.endsWith('...'));
  // A crowded card clips the summary further and keeps its last line.
  const crowded = fakeRun({
    passed: false,
    reasons: Array(50).fill('overall 3 is under 7'),
    situations: Array.from({ length: 80 }, (_, i) => ({ n: i + 1, title: '', transcript: '', answers: [] })),
    situationMedians: Array.from({ length: 80 }, (_, i) => ({ n: i + 1, overall: 6.5, goal: 7 })),
    diagnosis: { ...DIAGNOSIS, summary: 'y'.repeat(1500) },
  });
  const full = renderCard(crowded);
  assert.ok(full.length <= 1800, `card is ${full.length} characters`);
  assert.match(full, /details: \/nep mentor show 3$/);
  const clipped = full.split('\n').find((l) => l.startsWith('diagnosis: '));
  assert.ok(clipped && clipped.length < 'diagnosis: '.length + 300, clipped);
  // No diagnosis, no line.
  assert.doesNotMatch(renderCard(fakeRun()), /diagnosis/);
  assert.doesNotMatch(renderCard(fakeRun({ diagnosis: null, diagnosisError: 'invalid answer' })), /^diagnosis:/m);
});

test('renderFile: prints causes and changes', () => {
  const text = renderFile(fakeRun({ passed: false, diagnosis: DIAGNOSIS })).text;
  const at = text.indexOf("Diagnosis (the mentor's opinion, not verified)");
  assert.ok(at >= 0, text);
  const section = text.slice(at);
  assert.ok(section.includes(DIAGNOSIS.summary));
  for (const cause of DIAGNOSIS.causes) {
    assert.ok(section.includes(cause.layer));
    assert.ok(section.includes(cause.why));
  }
  assert.ok(section.includes('"explain every refusal"'));
  for (const change of DIAGNOSIS.changes) {
    assert.ok(section.includes(change.target));
    assert.ok(section.includes(change.to));
    assert.ok(section.includes(change.why));
  }
  assert.match(section, /from: "explain every refusal"\n\s*to: "say a refusal once"/);
  // Without a diagnosis the section is left out; a failed diagnosis says why.
  assert.doesNotMatch(renderFile(fakeRun()).text, /Diagnosis/);
  assert.match(renderFile(fakeRun({ diagnosis: null, diagnosisError: 'invalid answer' })).text, /^diagnosis: not available \(invalid answer\)$/m);
});

test('renderFile: prints both medians in the header of every situation', () => {
  const text = renderFile(fakeRun({ situationMedians: BY_SITUATION })).text;
  const header = (n) => new RegExp(`^Situation ${n}: situation ${n} [^\\n]*\\n(medians: [^\\n]*)$`, 'm').exec(text)?.[1];
  assert.equal(header(1), 'medians: overall 9 · goal 8');
  assert.equal(header(2), 'medians: overall 3 · goal 4');
  assert.equal(header(4), 'medians: overall - · goal -');
  assert.equal(header(5), 'medians: overall 6.5 · goal 7');
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

// ---- the repair loop -------------------------------------------------------------

const FRESH = { passed: true, medians: { human: 8, character: 8, rules: 8, goal: 8, overall: 8.5 }, situations: [{ n: 1, overall: 8, goal: 8 }, { n: 2, overall: 9, goal: 8 }] };

const REPAIR = {
  attempts: [
    {
      n: 1,
      suspects: [
        { layer: 'rules', excerpt: 'explain every refusal', located: true, gain: 0.5, confirmed: false },
        { layer: 'card', excerpt: 'talks a lot', located: false, gain: null, confirmed: false },
      ],
      edit: null,
      refused: null,
      verify: null,
      accepted: false,
    },
    {
      n: 2,
      suspects: [{ layer: 'missing', excerpt: '', located: null, gain: null, confirmed: true }],
      edit: { layer: 'prompt', target: 'format', from: '', to: 'One idea per message.', why: 'Shorter, café style.' },
      refused: 'growth over the cap',
      verify: null,
      accepted: false,
    },
    {
      n: 3,
      suspects: [{ layer: 'rules', excerpt: 'say everything twice', located: true, gain: 2.5, confirmed: true }],
      edit: { layer: 'rules', target: 'rules', from: 'say everything twice', to: 'say it once', why: 'Repeats are noise.' },
      refused: null,
      verify: {
        fresh: FRESH,
        regression: [{ caseId: 5, held: true, situations: [{ n: 1, before: 8, after: 7 }, { n: 2, before: 9, after: 9 }] }],
        skipped: [6],
      },
      accepted: true,
    },
  ],
  applied: { changeId: 12, layer: 'rules', target: 'rules', summary: 'rules rules: say everything twice -> say it once' },
  reason: 'applied',
  tokens: 45678,
};

test('renderCard: shows the applied change and its undo', () => {
  const card = renderCard(fakeRun({ passed: false, situationMedians: BY_SITUATION, diagnosis: DIAGNOSIS, repair: REPAIR }));
  assert.ok(card.length <= 1800);
  const lines = card.split('\n');
  const at = lines.findIndex((l) => l.startsWith('diagnosis: '));
  assert.equal(lines[at + 1], 'repair: change 12 applied, rules rules, gain 2.5, fresh overall 8.5');
  assert.equal(lines[at + 2], 'undo: /nep mentor undo 12');
  // A change without a target (a learned item) and a cause without a gain (missing).
  const learned = structuredClone(REPAIR);
  learned.attempts[2].suspects[0] = { layer: 'missing', excerpt: '', located: null, gain: null, confirmed: true };
  learned.applied = { changeId: 13, layer: 'learned', target: null, summary: 'learned: a -> b' };
  assert.match(renderCard(fakeRun({ passed: false, repair: learned })), /^repair: change 13 applied, learned, gain -, fresh overall 8\.5$/m);
});

test('renderCard: says why nothing was applied', () => {
  const card = renderCard(fakeRun({ passed: false, diagnosis: DIAGNOSIS, repair: { ...REPAIR, applied: null, reason: 'max attempts' } }));
  assert.match(card, /^repair: nothing applied \(max attempts\)$/m);
  assert.doesNotMatch(card, /undo:/);
  // Without a diagnosis the line takes its place; without a repair there is no line.
  assert.match(renderCard(fakeRun({ passed: false, repair: { attempts: [], applied: null, reason: 'no diagnosis', tokens: 0 } })), /^repair: nothing applied \(no diagnosis\)$/m);
  assert.doesNotMatch(renderCard(fakeRun({ passed: false, diagnosis: DIAGNOSIS })), /repair/);
  // A crowded card keeps the repair lines and stays under the limit.
  const crowded = fakeRun({
    passed: false,
    reasons: Array(50).fill('overall 3 is under 7'),
    situations: Array.from({ length: 80 }, (_, i) => ({ n: i + 1, title: '', transcript: '', answers: [] })),
    situationMedians: Array.from({ length: 80 }, (_, i) => ({ n: i + 1, overall: 6.5, goal: 7 })),
    diagnosis: { ...DIAGNOSIS, summary: 'y'.repeat(1500) },
    repair: { ...REPAIR, applied: { ...REPAIR.applied, target: 't'.repeat(200) } },
  });
  const full = renderCard(crowded);
  assert.ok(full.length <= 1800, `card is ${full.length} characters`);
  assert.match(full, /^undo: \/nep mentor undo 12$/m);
  assert.match(full, /details: \/nep mentor show 3$/);
});

test('renderFile: prints the attempts', () => {
  const text = renderFile(fakeRun({ passed: false, diagnosis: DIAGNOSIS, repair: REPAIR })).text;
  const at = text.indexOf('\nRepair:');
  assert.ok(at >= 0, text);
  assert.ok(at > text.indexOf("Diagnosis (the mentor's opinion, not verified)"));
  const section = text.slice(at, text.indexOf('\nReference:'));
  assert.match(section, /applied: change 12, rules rules: say everything twice -> say it once/);
  assert.match(section, /ended: applied · tokens 45678/);
  for (const n of [1, 2, 3]) assert.match(section, new RegExp(`^Attempt ${n}:`, 'm'));
  assert.match(section, /- rules: "explain every refusal" -- gain 0\.5, not confirmed/);
  assert.match(section, /- card: "talks a lot" -- not located/);
  assert.match(section, /- missing -- confirmed without ablation/);
  assert.match(section, /- rules: "say everything twice" -- gain 2\.5, confirmed/);
  assert.match(section, /edit: prompt, format\n\s+from: \(an addition\)\n\s+to: "One idea per message\."\n\s+why: Shorter, café style\./);
  assert.match(section, /refused: growth over the cap/);
  assert.match(section, /from: "say everything twice"\n\s+to: "say it once"/);
  assert.match(section, /fresh: passed, overall 8\.5 · goal 8, by situation 1: 8 · 2: 9/);
  assert.match(section, /regression: case 5 held \(1: 8 -> 7 · 2: 9 -> 9\)/);
  assert.match(section, /regression skipped: case 6/);
  assert.match(section, /accepted: yes/);
  assert.match(section, /accepted: no/);
  // Nothing applied: the reason; no repair, no section.
  assert.match(renderFile(fakeRun({ repair: { attempts: [], applied: null, reason: 'no diagnosis', tokens: 0 } })).text, /^Repair:\nnothing applied \(no diagnosis\)$/m);
  assert.doesNotMatch(renderFile(fakeRun()).text, /^Repair:/m);
});
