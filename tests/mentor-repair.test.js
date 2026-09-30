// Tests for src/mentor/repair.js: the repair loop at the end of a failed
// mentor run -- a suspect proven by removing it and measuring again, one edit
// asked of the mentor, the edit verified on fresh situations and against the
// other cases, then applied through the change store. Driven end to end
// through createMentor with a fake llm that answers by looking at the request
// (the model and the system text, the persona's rules), a fake memory store,
// a real case store in a temp directory and a fake change store that records
// what it is asked to apply (one test uses the real one on temp directories).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMentor } from '../src/mentor/mentor.js';
import { createCaseStore } from '../src/mentor/cases.js';
import { createChangeStore } from '../src/mentor/changes.js';
import { createMentorBudget } from '../src/mentor/budget.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const GUILD = 'g1';
const SELF_ID = '900000000000000001';
const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';
const ADMIN = '700000000000000001';
const CHANNEL = { id: '500000000000000001', name: 'general', category: 'Talk', topic: null, messageCount: 40 };
const CASE_TEXT = 'The persona says a limit once, in one line.';
const OTHER_TEXT = 'The persona greets people by their name.';
const USAGE = { prompt_tokens: 100, completion_tokens: 10 }; // weighted: 150

/** The rule the fake persona obeys too well: with it in the system prompt every answer is bad. */
const BAD_RULE = 'explain every limit at length';
const RULES = `# Rules\n\n## Live rules\n\n- ${BAD_RULE}\n- never use semicolons\n`;
const FIXED_RULE = 'say a limit once, in one line';

function fakeConfig({ features = {}, mentor = {} } = {}) {
  return {
    bot: { timezone: 'UTC', dryRunChannelId: ADMIN },
    context: {
      channelMessages: 100,
      maxMessageChars: 800,
      gapMarkerMinutes: 20,
      otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    llm: { model: 'x/talk', maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    memory: { model: 'x/memory', fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20, maxEpisodes: 20, learnedChars: 160, mainChannelIds: [CHANNEL.id] },
    media: { embedTextChars: 300 },
    relationships: { maxDeltaPerUpdate: 15, historySize: 10 },
    lore: { maxEntries: 500 },
    features: { mentor: true, mentorAutoFix: true, ...features },
    mentor: {
      model: 'x/mentor',
      maxTokensPerDay: 400000,
      outputTokenWeight: 5,
      maxOutputTokens: 6000,
      timeoutMs: 300000,
      situations: 2,
      situationLines: [2, 4],
      samples: 2,
      check: { samples: 1 },
      pass: { score: 7, floor: 5 },
      reference: { days: 7, samples: 5, maxMessages: 300 },
      feedbackExamples: 10,
      suspects: 2,
      ablationGain: 1,
      ablationSamples: 2,
      fix: {
        maxAttempts: 3,
        maxGrowthChars: 300,
        layers: ['rules', 'prompt', 'self', 'learned', 'guild', 'profile'],
        files: ['rules', 'system-prompt', 'format', 'reply'],
      },
      regression: { situations: 2, tolerance: 1 },
      verify: { situations: 3, samples: 2 },
      ...mentor,
    },
  };
}

function fakePrompts(overrides = {}) {
  return {
    'system-prompt': 'You are a regular member of this chat.',
    'character-card': 'CARD: {{name}} is friendly and talks a lot.',
    rules: RULES,
    format: 'Use <msg> and <react> tags.',
    reply: 'Someone called you: {{author}}.',
    memory: 'Summarize what happened.',
    'mentor-situations': 'SITUATIONS for {{name}}: {{count}} of {{minLines}}-{{maxLines}} lines.',
    'mentor-situations-memory': 'SITUATIONS-MEMORY for {{name}}: {{count}}',
    'mentor-score': 'SCORE for {{name}}',
    'mentor-score-memory': 'SCORE-MEMORY for {{name}}',
    'mentor-signs': 'SIGNS FOR {{name}}',
    'mentor-diagnose': 'DIAGNOSE {{name}}',
    'mentor-fix': 'FIX {{name}}',
    labels,
    ...overrides,
  };
}

function fakeMemoryStore() {
  const profiles = {
    [ALICE]: { id: ALICE, names: ['Alice'], interests: [], details: [], aliases: [], episodes: [], affinity: { score: 0, reason: '', history: [] } },
    [BRUNO]: { id: BRUNO, names: ['Bruno'], interests: [], details: [], aliases: [], episodes: [], affinity: { score: 0, reason: '', history: [] } },
  };
  return {
    getGuild: () => ({ patterns: '', starters: '', injokes: [], self: [], learned: [] }),
    getUser: (guildId, id) => profiles[id] ?? null,
    getPrivate: () => {
      throw new Error('the private layer is out of bounds for the mentor');
    },
    listUserProfiles: () => Object.values(profiles),
    listChannels: () => [CHANNEL],
    getLore: () => [],
  };
}

function situation(title, texts) {
  return {
    title,
    lines: [
      { authorId: BRUNO, authorName: 'Bruno', text: texts[0], replyTo: null },
      { authorId: ALICE, authorName: 'Alice', text: texts[1], replyTo: null },
    ],
  };
}

const SITUATIONS = { situations: [situation('limit question', ['καλημέρα σε όλους', 'are you out of drawings today?']), situation('second question', ['café closed?', 'why so quiet?'])] };
const FRESH = { situations: [situation('fresh one', ['FRESH hello', 'FRESH are you busy?']), situation('fresh two', ['FRESH hi', 'FRESH out of drawings?'])] };

const DIAGNOSIS = {
  summary: 'The persona explains every limit at length because a rule asks for it.',
  causes: [{ layer: 'rules', excerpt: BAD_RULE, why: 'The rule asks for long explanations.' }],
  changes: [{ layer: 'rules', target: 'rules.md', from: BAD_RULE, to: FIXED_RULE, why: 'Shorter notices.' }],
};

const FIX = { layer: 'rules', target: 'rules', from: BAD_RULE, to: FIXED_RULE, why: 'Shorter notices.' };

function score(overall) {
  return { human: 8, character: 8, rules: 8, goal: overall, overall, comment: 'judged' };
}

/** The answers listed in the `<answers>` block (a memory case: `<stored>`) of a score request. */
function answersIn(user) {
  const match = /<(answers|stored)>\n([\s\S]*?)\n<\/\1>/.exec(user);
  return match ? JSON.parse(match[2]) : [];
}

/** The body of the first `<tag>` block of `text`, or null. */
function blockBody(text, tag) {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return match ? match[1] : null;
}

/**
 * A fake llm that answers by looking at the request. The mentor model (by
 * its model) is told apart by its system text: situations, diagnosis, fix,
 * else a score request. The persona answers BAD while its system prompt
 * carries BAD_RULE, else GOOD; the judge gives a BAD answer 3 and a GOOD one
 * 9. Every call records the mentor's phase at that moment.
 */
function fakeLlm({ situationsFor, diagnosis = JSON.stringify(DIAGNOSIS), fix = JSON.stringify(FIX), talkFor, scoreFor, usageFor, hook } = {}) {
  const calls = [];
  const llm = {
    calls,
    phaseOf: () => null,
    kinds: () => calls.map((c) => c.kind),
    ofKind: (kind) => calls.filter((c) => c.kind === kind),
    inPhase: (phase) => calls.filter((c) => c.phase === phase),
    async complete(messages, options = {}) {
      const system = messages[0].content;
      const user = messages[1].content;
      let kind = 'talk';
      if (options.model === 'x/mentor') {
        if (system.startsWith('SITUATIONS')) kind = 'situations';
        else if (system.startsWith('DIAGNOSE')) kind = 'diagnose';
        else if (system.startsWith('FIX')) kind = 'fix';
        else kind = 'score';
      }
      const call = { kind, messages, options, system, user, phase: llm.phaseOf() };
      calls.push(call);
      if (hook) {
        const result = await hook(call);
        if (result !== undefined) return result;
      }
      let text;
      if (kind === 'situations') text = JSON.stringify(situationsFor ? situationsFor(call) : SITUATIONS);
      else if (kind === 'diagnose') text = diagnosis;
      else if (kind === 'fix') text = typeof fix === 'function' ? fix(call) : fix;
      else if (kind === 'score') {
        const answers = answersIn(user).map((a) => {
          const value = scoreFor ? scoreFor(a, call) : (a.messages ?? []).join(' ').includes('BAD') ? 3 : 9;
          return { id: a.id, ...score(value) };
        });
        text = JSON.stringify({ answers });
      } else text = talkFor ? talkFor(call) : system.includes(BAD_RULE) ? '<msg>BAD a long explanation</msg>' : '<msg>GOOD short</msg>';
      return { text, usage: usageFor ? usageFor(kind) : USAGE, estimated: 90 };
    },
  };
  return llm;
}

/** A change store that records `apply` and answers with `result` (a function of the call, or a value). */
function fakeChanges(result) {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    apply(guildId, edit, meta) {
      calls.push({ guildId, edit, meta });
      if (result) return typeof result === 'function' ? result(edit) : result;
      const id = nextId++;
      return { ok: true, change: { id, layer: edit.layer, target: edit.layer === 'rules' ? 'rules' : edit.target, summary: `${edit.layer}: changed`, before: 'b', after: 'a' } };
    },
  };
}

function reference() {
  const base = { channelId: CHANNEL.id, self: false, bot: false, replyToId: null };
  return [
    { ...base, id: 'r1', authorId: ALICE, content: 'ok i will check the café later tonight' },
    { ...base, id: 'r2', authorId: BRUNO, content: 'καλημέρα, anyone up for a game' },
  ];
}

function setup({ config = {}, prompts = {}, llm = fakeLlm(), changes = fakeChanges(), withChanges = true, dir: givenDir } = {}) {
  const dir = givenDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nep-mentor-repair-'));
  let clock = NOW;
  const now = () => (clock += 1000);
  const hot = { config: fakeConfig(config), prompts: fakePrompts(prompts) };
  const cases = createCaseStore({ dataDir: dir, now });
  const budget = createMentorBudget({ state: { data: {}, markDirty() {} }, getConfig: () => hot.config, now });
  const sent = [];
  const client = {
    channels: {
      fetch: async (id) => {
        if (id === ADMIN) return { id, send: async (payload) => sent.push(payload) };
        if (id === CHANNEL.id) return { id };
        return null;
      },
    },
  };
  const mentor = createMentor({
    hot,
    store: fakeMemoryStore(),
    llm,
    client,
    cases,
    budget,
    changes: withChanges ? (typeof changes === 'function' ? changes(hot) : changes) : undefined,
    getGuildId: () => GUILD,
    getSelf: () => ({ id: SELF_ID, name: 'Zoë' }),
    fetchHistoryWindow: async () => reference(),
    now,
    rng: () => 0,
  });
  llm.phaseOf = () => mentor.status().phase ?? null;
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { mentor, cases, hot, llm, budget, sent, changes, dir, cleanup };
}

async function withSetup(options, fn) {
  const env = setup(options);
  try {
    await fn(env);
  } finally {
    env.cleanup();
  }
}

/** Runs a new case to the end and returns the saved run. */
async function runCase(env, text = CASE_TEXT, target = 'reply') {
  const item = env.cases.add(GUILD, { text, target });
  const run = await (await env.mentor.run(item.id)).done;
  return { item, run };
}

/** Another case with a stored run: its situations carry `markers`, its medians by situation `medians`. */
function storedCase(env, { markers = ['REG-ONE', 'REG-TWO', 'REG-THREE'], medians = [8, 9, 9], withMedians = true } = {}) {
  const item = env.cases.add(GUILD, { text: OTHER_TEXT, target: 'reply' });
  const situations = markers.map((marker, i) => ({ n: i + 1, ...situation(`stored ${i + 1}`, [`${marker} hello`, `${marker} how are you?`]), transcript: '', answers: [] }));
  const run = {
    caseId: item.id,
    caseText: OTHER_TEXT,
    target: 'reply',
    kind: 'run',
    situations,
    medians: { human: 8, character: 8, rules: 8, goal: 8, overall: 8 },
    passed: true,
    reasons: [],
  };
  if (withMedians) run.situationMedians = medians.map((overall, i) => ({ n: i + 1, overall, goal: 8 }));
  env.cases.saveRun(GUILD, run);
  return item;
}

// ---- when the loop runs ----------------------------------------------------------

test('run: the loop runs only with features.mentorAutoFix', async () => {
  for (const autoFix of [undefined, false, 'yes', 1]) {
    await withSetup({ config: { features: { mentorAutoFix: autoFix } } }, async (env) => {
      const { run } = await runCase(env);
      assert.equal(run.passed, false, String(autoFix));
      assert.ok(run.diagnosis, String(autoFix));
      assert.equal('repair' in run, false, String(autoFix));
      assert.equal(env.llm.ofKind('fix').length, 0, String(autoFix));
      assert.equal(env.changes.calls.length, 0, String(autoFix));
      // Nothing beyond the run and its diagnosis was asked.
      assert.deepEqual(env.llm.kinds(), ['situations', 'talk', 'talk', 'talk', 'talk', 'score', 'score', 'diagnose'], String(autoFix));
    });
  }
  // Without a change store the mentor works as before, whatever the switch.
  await withSetup({ withChanges: false }, async (env) => {
    const { run } = await runCase(env);
    assert.equal('repair' in run, false);
    assert.equal(env.llm.ofKind('fix').length, 0);
  });
  // Switched on: the loop runs and is saved with the run.
  await withSetup({}, async (env) => {
    const { item, run } = await runCase(env);
    assert.ok(run.repair);
    assert.deepEqual(env.cases.lastRun(GUILD, item.id).repair, run.repair);
  });
});

test('run: a check never repairs', () =>
  withSetup({ config: { features: { mentorAutoFix: false } } }, async (env) => {
    await runCase(env);
    env.hot.config.features.mentorAutoFix = true;
    env.llm.calls.length = 0;
    const runs = await (await env.mentor.check()).done;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].passed, false);
    assert.equal('repair' in runs[0], false);
    assert.deepEqual(env.llm.kinds(), ['talk', 'talk', 'score', 'score']);
    assert.equal(env.changes.calls.length, 0);
  }));

test('run: a passing run never repairs', () =>
  // Situation 2 is weak (6) but the run passes: a diagnosis, no repair.
  withSetup({ llm: fakeLlm({ scoreFor: (a) => (a.id.startsWith('s2') ? 6 : 9) }) }, async (env) => {
    const { run } = await runCase(env);
    assert.equal(run.passed, true);
    assert.ok(run.diagnosis);
    assert.equal('repair' in run, false);
    assert.equal(env.llm.ofKind('fix').length, 0);
    assert.equal(env.changes.calls.length, 0);
  }));

test('run: without a diagnosis the loop records why and spends nothing', async () => {
  for (const options of [{ llm: fakeLlm({ diagnosis: 'no idea' }) }, { llm: fakeLlm({ diagnosis: JSON.stringify({ ...DIAGNOSIS, causes: [] }) }) }, { config: { mentor: { diagnose: false } } }]) {
    await withSetup(options, async (env) => {
      const { run } = await runCase(env);
      assert.deepEqual(run.repair, { attempts: [], applied: null, reason: 'no diagnosis', tokens: 0 });
      assert.equal(env.llm.ofKind('fix').length, 0);
      assert.equal(env.llm.calls.filter((c) => String(c.phase).startsWith('repair')).length, 0);
    });
  }
});

test('run: a missing mentor-fix prompt ends the loop before anything is spent', () =>
  withSetup({ prompts: { 'mentor-fix': undefined } }, async (env) => {
    const { run } = await runCase(env);
    assert.equal(run.repair.reason, 'prompt missing');
    assert.deepEqual(run.repair.attempts, []);
    assert.equal(run.repair.tokens, 0);
    assert.equal(env.llm.calls.filter((c) => String(c.phase).startsWith('repair')).length, 0);
  }));

// ---- one attempt -----------------------------------------------------------------

test('attempt: an ablation under the gain is not confirmed', () =>
  // The persona answers badly whatever its rules say: removing the rule gains nothing.
  withSetup({ llm: fakeLlm({ talkFor: () => '<msg>BAD always</msg>' }) }, async (env) => {
    const { run } = await runCase(env);
    const [attempt] = run.repair.attempts;
    assert.deepEqual(attempt.suspects, [{ layer: 'rules', excerpt: BAD_RULE, located: true, gain: 0, confirmed: false }]);
    assert.equal(attempt.edit, null);
    assert.equal(attempt.accepted, false);
    assert.equal(run.repair.reason, 'no suspect left');
    assert.equal(run.repair.applied, null);
    // Both weak situations re-answered with ablationSamples samples, without the rule, then scored.
    const ablation = env.llm.inPhase('repair 1: ablation');
    assert.deepEqual(ablation.map((c) => c.kind), ['talk', 'talk', 'talk', 'talk', 'score', 'score']);
    for (const call of ablation.filter((c) => c.kind === 'talk')) {
      assert.equal(call.system.includes(BAD_RULE), false);
      assert.ok(call.system.includes('never use semicolons'));
    }
    assert.equal(env.llm.ofKind('fix').length, 0);
  }));

test('attempt: ablation replays only the situations under the pass score', () =>
  withSetup(
    { llm: fakeLlm({ scoreFor: (a, call) => (a.messages.join(' ').includes('GOOD') ? 9 : call.user.includes('café closed?') ? 3 : 8) }) },
    async (env) => {
      const { run } = await runCase(env);
      // Situation 1 scores 8, situation 2 scores 3: only situation 2 is replayed; before 3, after 9.
      const talks = env.llm.inPhase('repair 1: ablation').filter((c) => c.kind === 'talk');
      assert.equal(talks.length, 2);
      for (const call of talks) assert.ok(call.user.includes('café closed?'));
      assert.equal(run.repair.attempts[0].suspects[0].gain, 6);
      assert.equal(run.repair.attempts[0].suspects[0].confirmed, true);
    },
  ));

test('attempt: an excerpt that cannot be located is not confirmed', () => {
  const diagnosis = JSON.stringify({ ...DIAGNOSIS, causes: [{ layer: 'rules', excerpt: 'a rule nobody wrote', why: 'x' }] });
  return withSetup({ llm: fakeLlm({ diagnosis }) }, async (env) => {
    const { run } = await runCase(env);
    assert.deepEqual(run.repair.attempts[0].suspects, [{ layer: 'rules', excerpt: 'a rule nobody wrote', located: false, gain: null, confirmed: false }]);
    assert.equal(run.repair.reason, 'no suspect left');
    assert.equal(env.llm.calls.filter((c) => String(c.phase).startsWith('repair')).length, 0);
  });
});

test('attempt: a missing cause is confirmed without ablation', () => {
  const diagnosis = JSON.stringify({ ...DIAGNOSIS, causes: [{ layer: 'missing', excerpt: '', why: 'Nothing says a limit is short.' }] });
  const fix = JSON.stringify({ layer: 'prompt', target: 'format.md', from: '', to: 'One idea per message.', why: 'An addition.' });
  // The addition to the format prompt is what makes the persona short.
  const talkFor = (call) => (call.system.includes('One idea per message.') ? '<msg>GOOD short</msg>' : '<msg>BAD long</msg>');
  return withSetup({ llm: fakeLlm({ diagnosis, fix, talkFor }) }, async (env) => {
    const { run } = await runCase(env);
    const [attempt] = run.repair.attempts;
    assert.deepEqual(attempt.suspects, [{ layer: 'missing', excerpt: '', located: null, gain: null, confirmed: true }]);
    assert.equal(env.llm.inPhase('repair 1: ablation').length, 0);
    const cause = JSON.parse(blockBody(env.llm.ofKind('fix')[0].user, 'cause'));
    assert.deepEqual(cause, { layer: 'missing', excerpt: '', why: 'Nothing says a limit is short.', gain: null });
    // The prompt target is used without its .md.
    assert.deepEqual(attempt.edit, { layer: 'prompt', target: 'format', from: '', to: 'One idea per message.', why: 'An addition.' });
    assert.equal(attempt.accepted, true);
    assert.equal(env.changes.calls[0].edit.target, 'format');
    assert.equal(run.repair.reason, 'applied');
  });
});

test('attempt: a confirmed suspect gets one edit request', () =>
  withSetup({ config: { features: { mentorAutoFix: false } } }, async (env) => {
    // A first run for the owner's feedback, then the run under test.
    const first = await runCase(env);
    env.cases.addFeedback(GUILD, { caseId: first.item.id, reason: 'too long, café style' });
    env.hot.config.features.mentorAutoFix = true;
    env.llm.calls.length = 0;
    const run = await (await env.mentor.run(first.item.id)).done;

    const fixes = env.llm.ofKind('fix');
    assert.equal(fixes.length, 1);
    const [call] = fixes;
    assert.equal(call.phase, 'repair 1: edit');
    assert.equal(call.system, 'FIX Zoë');
    assert.equal(call.options.model, 'x/mentor');
    assert.equal(call.options.maxOutputTokens, 6000);
    assert.equal(call.options.countAgainstDailyCap, false);
    assert.equal(call.options.skipCalibration, true);
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal('maxRequestTokens' in call.options, false);

    const order = ['case', 'verdict', 'signs', 'feedback', 'cause', 'seen', 'allowed'];
    const positions = order.map((tag) => call.user.indexOf(`<${tag}>`));
    assert.ok(positions.every((p) => p >= 0), JSON.stringify(positions));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.ok(call.user.startsWith(`<case>\n${CASE_TEXT}\n</case>`));
    assert.ok(call.user.endsWith('</allowed>'));
    assert.doesNotMatch(call.user, /<reference>|<samples>|<worst>|<answers>/);
    assert.deepEqual(JSON.parse(blockBody(call.user, 'verdict')), { passed: false, medians: run.medians, situations: run.situationMedians, reasons: run.reasons });
    assert.deepEqual(JSON.parse(blockBody(call.user, 'feedback')), [{ case: CASE_TEXT, reason: 'too long, café style' }]);
    assert.deepEqual(JSON.parse(blockBody(call.user, 'cause')), { layer: 'rules', excerpt: BAD_RULE, why: 'The rule asks for long explanations.', gain: 6 });
    // <seen> is the very text the diagnosis request carried.
    const diagnose = env.llm.ofKind('diagnose')[0];
    const seenStart = (text) => text.indexOf('<seen>');
    const seenOf = (text) => text.slice(seenStart(text), text.indexOf('</seen>') + '</seen>'.length);
    assert.equal(seenOf(call.user), seenOf(diagnose.user));
    assert.deepEqual(JSON.parse(blockBody(call.user, 'allowed')), {
      layers: ['rules', 'prompt', 'self', 'learned', 'guild', 'profile'],
      files: ['rules', 'system-prompt', 'format', 'reply'],
      maxGrowthChars: 300,
    });
    assert.equal(run.repair.reason, 'applied');
  }));

test('attempt: the card is never an allowed layer, even when the config lists it', () =>
  withSetup({ config: { mentor: { fix: { layers: ['card', 'rules'], files: ['format'] } } } }, async (env) => {
    await runCase(env);
    assert.deepEqual(JSON.parse(blockBody(env.llm.ofKind('fix')[0].user, 'allowed')).layers, ['rules']);
  }));

test('attempt: an edit to the card is refused', () => {
  const fix = JSON.stringify({ layer: 'card', target: 'character-card', from: 'talks a lot', to: 'talks little', why: 'x' });
  return withSetup({ llm: fakeLlm({ fix }) }, async (env) => {
    const { run } = await runCase(env);
    const [attempt] = run.repair.attempts;
    assert.deepEqual(attempt.edit, { layer: 'card', target: 'character-card', from: 'talks a lot', to: 'talks little', why: 'x' });
    assert.equal(attempt.refused, 'layer not allowed');
    assert.equal(attempt.verify, null);
    assert.equal(attempt.accepted, false);
    assert.equal(env.llm.inPhase('repair 1: verify').length, 0);
    assert.equal(env.changes.calls.length, 0);
    assert.equal(run.repair.applied, null);
  });
});

test('attempt: the other refusals end the attempt with their reason', async () => {
  const variants = [
    { name: 'a layer the config closed', config: { mentor: { fix: { layers: ['prompt'], files: ['format'] } } }, fix: FIX, reason: 'layer not allowed' },
    { name: 'a prompt outside the files', fix: { layer: 'prompt', target: 'interject', from: 'x', to: 'y', why: 'x' }, reason: 'file not allowed' },
    { name: 'a rule deleted', fix: { ...FIX, to: '' }, reason: 'deletion not allowed' },
    { name: 'a learned text over learnedChars', fix: { layer: 'learned', target: '', from: 'x', to: 'λ'.repeat(161), why: 'x' }, reason: 'text too long' },
    { name: 'a self item over 200 characters', fix: { layer: 'self', target: '', from: 'x', to: 'é'.repeat(201), why: 'x' }, reason: 'text too long' },
    { name: 'text not in the piece', fix: { ...FIX, from: 'a rule nobody wrote' }, reason: 'text not found' },
    { name: 'an answer that is no edit', fix: 'I would shorten the rule.', reason: 'invalid answer' },
  ];
  for (const { name, config, fix, reason } of variants) {
    await withSetup({ config, llm: fakeLlm({ fix: typeof fix === 'string' ? fix : JSON.stringify(fix) }) }, async (env) => {
      const { run } = await runCase(env);
      const [attempt] = run.repair.attempts;
      assert.equal(attempt.refused, reason, name);
      assert.equal(attempt.verify, null, name);
      assert.equal(env.changes.calls.length, 0, name);
      assert.equal(run.repair.reason, 'no suspect left', name);
    });
  }
});

/** The memory writer's prompts, and a config that lists them with the persona's own. */
const WRITER_FILES = ['memory', 'profile', 'server', 'channel'];
const ALL_FILES = { mentor: { fix: { files: ['rules', 'system-prompt', 'format', 'reply', ...WRITER_FILES] } } };
const MISSING = JSON.stringify({ ...DIAGNOSIS, causes: [{ layer: 'missing', excerpt: '', why: 'Nothing says it.' }] });
const MEMORY_CASE = 'The persona remembers the pet named Héloïse.';

test("attempt: a reply case may not edit the memory writer's prompts", async () => {
  for (const target of WRITER_FILES) {
    const fix = JSON.stringify({ layer: 'prompt', target, from: '', to: 'Keep the notes short.', why: 'x' });
    await withSetup({ config: ALL_FILES, llm: fakeLlm({ diagnosis: MISSING, fix }) }, async (env) => {
      const { run } = await runCase(env);
      const [attempt] = run.repair.attempts;
      assert.equal(attempt.refused, 'file not allowed', target);
      assert.equal(attempt.verify, null, target);
      assert.equal(env.changes.calls.length, 0, target);
    });
  }
  // A prompt of the persona itself is still open to a reply case.
  const fix = JSON.stringify({ layer: 'prompt', target: 'format', from: '', to: 'One idea per message.', why: 'x' });
  await withSetup({ config: ALL_FILES, llm: fakeLlm({ diagnosis: MISSING, fix }) }, async (env) => {
    const { run } = await runCase(env);
    assert.equal(run.repair.attempts[0].refused, null);
  });
});

test("attempt: a memory case may edit only the memory writer's prompts", async () => {
  const variants = [
    { fix: { layer: 'prompt', target: 'format', from: '', to: 'One idea per message.', why: 'x' }, reason: 'file not allowed' },
    { fix: { layer: 'prompt', target: 'system-prompt', from: '', to: 'One idea per message.', why: 'x' }, reason: 'file not allowed' },
    { fix: FIX, reason: 'layer not allowed' },
    { fix: { layer: 'learned', target: '', from: 'x', to: 'y', why: 'x' }, reason: 'layer not allowed' },
    { fix: { layer: 'profile', target: `${ALICE}.character`, from: 'x', to: 'y', why: 'x' }, reason: 'layer not allowed' },
    { fix: { layer: 'prompt', target: 'memory', from: '', to: 'Keep the notes short.', why: 'x' }, reason: null },
  ];
  for (const { fix, reason } of variants) {
    const llm = fakeLlm({ diagnosis: MISSING, fix: JSON.stringify(fix), scoreFor: () => 3 });
    await withSetup({ config: ALL_FILES, llm }, async (env) => {
      const { run } = await runCase(env, MEMORY_CASE, 'memory');
      assert.equal(run.target, 'memory');
      const [attempt] = run.repair.attempts;
      assert.equal(attempt.refused, reason, `${fix.layer} ${fix.target}`);
      if (reason) assert.equal(attempt.verify, null);
      else assert.ok(attempt.verify, 'an allowed edit is verified');
    });
  }
});

test("attempt: the allowed block carries the files of the case's target", async () => {
  await withSetup({ config: ALL_FILES, llm: fakeLlm({ diagnosis: MISSING }) }, async (env) => {
    await runCase(env);
    assert.deepEqual(JSON.parse(blockBody(env.llm.ofKind('fix')[0].user, 'allowed')), {
      layers: ['rules', 'prompt', 'self', 'learned', 'guild', 'profile'],
      files: ['rules', 'system-prompt', 'format', 'reply'],
      maxGrowthChars: 300,
    });
  });
  await withSetup({ config: ALL_FILES, llm: fakeLlm({ diagnosis: MISSING, scoreFor: () => 3 }) }, async (env) => {
    await runCase(env, MEMORY_CASE, 'memory');
    assert.deepEqual(JSON.parse(blockBody(env.llm.ofKind('fix')[0].user, 'allowed')), {
      layers: ['prompt'],
      files: WRITER_FILES,
      maxGrowthChars: 300,
    });
  });
  // A config that closes the prompt layer leaves a memory case no layer at all.
  const closed = { mentor: { fix: { layers: ['rules', 'self'], files: ALL_FILES.mentor.fix.files } } };
  await withSetup({ config: closed, llm: fakeLlm({ diagnosis: MISSING, scoreFor: () => 3 }) }, async (env) => {
    await runCase(env, MEMORY_CASE, 'memory');
    assert.deepEqual(JSON.parse(blockBody(env.llm.ofKind('fix')[0].user, 'allowed')).layers, []);
  });
});

test('attempt: a prompt that grows past the cap is refused', () => {
  // 'Use' (3 characters) becomes 304 characters: the prompt grows by 301.
  const fix = JSON.stringify({ layer: 'prompt', target: 'format', from: 'Use', to: `Use ${'x'.repeat(300)}`, why: 'x' });
  return withSetup({ llm: fakeLlm({ fix }) }, async (env) => {
    const { run } = await runCase(env);
    assert.equal(run.repair.attempts[0].refused, 'growth over the cap');
    assert.equal(env.llm.inPhase('repair 1: verify').length, 0);
    assert.equal(env.changes.calls.length, 0);
    // Exactly at the cap is allowed.
    env.hot.config.mentor.fix.maxGrowthChars = 301;
    const again = await (await env.mentor.run(run.caseId)).done;
    assert.equal(again.repair.attempts[0].refused, null);
  });
});

test('attempt: fresh situations that fail end the attempt', () => {
  // The fresh situations (asked for with the verify count) stay bad even without the rule.
  const situationsFor = (call) => (call.system.includes(': 3 of') ? FRESH : SITUATIONS);
  const talkFor = (call) => (call.system.includes(BAD_RULE) || call.user.includes('FRESH') ? '<msg>BAD long</msg>' : '<msg>GOOD short</msg>');
  return withSetup({ llm: fakeLlm({ situationsFor, talkFor }) }, async (env) => {
    storedCase(env);
    const { run } = await runCase(env);
    const [attempt] = run.repair.attempts;
    const verifyCalls = env.llm.inPhase('repair 1: verify');
    assert.deepEqual(verifyCalls.map((c) => c.kind), ['situations', 'talk', 'talk', 'talk', 'talk', 'score', 'score']);
    assert.equal(verifyCalls[0].system, 'SITUATIONS for Zoë: 3 of 2-4 lines.');
    // The fresh situations are answered on the edited rules.
    for (const call of verifyCalls.filter((c) => c.kind === 'talk')) {
      assert.ok(call.system.includes(FIXED_RULE));
      assert.equal(call.system.includes(BAD_RULE), false);
    }
    assert.deepEqual(attempt.verify.fresh, {
      passed: false,
      medians: { human: 8, character: 8, rules: 8, goal: 3, overall: 3 },
      situations: [{ n: 1, overall: 3, goal: 3 }, { n: 2, overall: 3, goal: 3 }],
    });
    assert.deepEqual(attempt.verify.regression, []);
    assert.equal(env.llm.inPhase('repair 1: regression').length, 0);
    assert.equal(attempt.accepted, false);
    assert.equal(env.changes.calls.length, 0);
  });
});

test('attempt: regression compares with the stored medians and tolerates one point', () => {
  // Situation 1 of the other case drops from 8 to 7 (within the tolerance), situation 2 holds at 9.
  const scoreFor = (a, call) => (call.user.includes('REG-ONE') ? 7 : a.messages.join(' ').includes('BAD') ? 3 : 9);
  return withSetup({ llm: fakeLlm({ scoreFor }) }, async (env) => {
    const other = storedCase(env);
    const retired = storedCase(env, { medians: [10, 10, 10] });
    env.cases.retire(GUILD, retired.id);
    const { run } = await runCase(env);
    const [attempt] = run.repair.attempts;
    assert.deepEqual(attempt.verify.regression, [{ caseId: other.id, held: true, situations: [{ n: 1, before: 8, after: 7 }, { n: 2, before: 9, after: 9 }] }]);
    assert.deepEqual(attempt.verify.skipped, []);
    // Two of its three stored situations, one sample each, on the edited rules.
    const regression = env.llm.inPhase('repair 1: regression');
    assert.deepEqual(regression.map((c) => c.kind), ['talk', 'talk', 'score', 'score']);
    assert.ok(regression[0].user.includes('REG-ONE') && regression[1].user.includes('REG-TWO'));
    assert.ok(regression.every((c) => c.kind !== 'talk' || c.system.includes(FIXED_RULE)));
    assert.equal(regression.some((c) => c.user.includes('REG-THREE')), false);
    assert.equal(attempt.accepted, true);
    assert.equal(env.changes.calls.length, 1);
  });
});

test('attempt: a regression failure ends the attempt', () => {
  const scoreFor = (a, call) => (call.user.includes('REG-ONE') ? 6 : a.messages.join(' ').includes('BAD') ? 3 : 9);
  return withSetup({ llm: fakeLlm({ scoreFor }) }, async (env) => {
    const other = storedCase(env);
    const { run } = await runCase(env);
    const [attempt] = run.repair.attempts;
    assert.equal(attempt.verify.fresh.passed, true);
    assert.deepEqual(attempt.verify.regression, [{ caseId: other.id, held: false, situations: [{ n: 1, before: 8, after: 6 }, { n: 2, before: 9, after: 9 }] }]);
    assert.equal(attempt.accepted, false);
    assert.equal(env.changes.calls.length, 0);
    assert.equal(run.repair.applied, null);
    assert.equal(run.repair.reason, 'no suspect left');
  });
});

test('attempt: a case without stored medians is skipped', () =>
  withSetup({}, async (env) => {
    const old = storedCase(env, { withMedians: false });
    const { run } = await runCase(env);
    const [attempt] = run.repair.attempts;
    assert.deepEqual(attempt.verify.regression, []);
    assert.deepEqual(attempt.verify.skipped, [old.id]);
    assert.equal(env.llm.inPhase('repair 1: regression').length, 0);
    assert.equal(attempt.accepted, true);
  }));

test('attempt: an accepted edit is applied once', () =>
  withSetup({}, async (env) => {
    const { result, logs } = await withCapturedLogs(() => runCase(env));
    const { item, run } = result;
    assert.equal(env.changes.calls.length, 1);
    assert.deepEqual(env.changes.calls[0], { guildId: GUILD, edit: FIX, meta: { caseId: item.id } });
    assert.deepEqual(run.repair.applied, { changeId: 1, layer: 'rules', target: 'rules', summary: 'rules: changed' });
    assert.equal(run.repair.reason, 'applied');
    assert.equal(run.repair.attempts.length, 1);
    const [attempt] = run.repair.attempts;
    assert.deepEqual(attempt.suspects, [{ layer: 'rules', excerpt: BAD_RULE, located: true, gain: 6, confirmed: true }]);
    assert.deepEqual(attempt.edit, FIX);
    assert.equal(attempt.refused, null);
    assert.equal(attempt.verify.fresh.passed, true);
    assert.equal(attempt.accepted, true);
    // The measured run is left as it was.
    assert.equal(run.passed, false);
    assert.equal(run.stopped, undefined);
    assert.equal(run.medians.overall, 3);
    assert.equal(env.cases.get(GUILD, item.id).state, 'failing');
    // The loop's tokens are counted in the run's and in its own.
    const repairCalls = env.llm.calls.filter((c) => String(c.phase).startsWith('repair'));
    assert.equal(run.repair.tokens, repairCalls.length * 150);
    assert.equal(run.tokens.spent, env.llm.calls.length * 150);
    assert.deepEqual(env.cases.lastRun(GUILD, item.id).repair, run.repair);
    // The card names the change and how to undo it.
    assert.match(env.sent[0].content, /^repair: change 1 applied, rules rules, gain 6, fresh overall 9$/m);
    assert.match(env.sent[0].content, /^undo: \/nep mentor undo 1$/m);
    // Counts only in the logs.
    assert.deepEqual(logs.filter((l) => l.msg === 'mentor: repair attempt').map(({ caseId, n, confirmed, accepted }) => ({ caseId, n, confirmed, accepted })), [
      { caseId: item.id, n: 1, confirmed: 1, accepted: true },
    ]);
    const applied = logs.filter((l) => l.msg === 'mentor: repair applied');
    assert.deepEqual(applied.map(({ caseId, changeId, layer }) => ({ caseId, changeId, layer })), [{ caseId: item.id, changeId: 1, layer: 'rules' }]);
    const ended = logs.filter((l) => l.msg === 'mentor: repair ended');
    assert.deepEqual(ended.map(({ caseId, reason, attempts }) => ({ caseId, reason, attempts })), [{ caseId: item.id, reason: 'applied', attempts: 1 }]);
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(`${BAD_RULE}|${FIXED_RULE}`));
  }));

test('attempt: a refusal of the change store leaves the attempt not accepted and the loop goes on', () => {
  const diagnosis = JSON.stringify({
    ...DIAGNOSIS,
    causes: [
      { layer: 'rules', excerpt: 'explain every limit', why: 'first' },
      { layer: 'rules', excerpt: 'every limit at length', why: 'second' },
    ],
  });
  // The store refuses the first write and takes the second.
  let writes = 0;
  const refusing = fakeChanges((edit) =>
    (writes += 1) === 1 ? { ok: false, reason: 'changed since' } : { ok: true, change: { id: 7, layer: edit.layer, target: 'rules', summary: 'rules: changed' } },
  );
  return withSetup({ llm: fakeLlm({ diagnosis }), changes: refusing }, async (env) => {
    const { result, logs } = await withCapturedLogs(() => runCase(env));
    const { item, run } = result;
    const [first, second] = run.repair.attempts;
    // The verification passed, the write was refused: not accepted, the store's reason kept.
    assert.equal(first.verify.fresh.passed, true);
    assert.equal(first.accepted, false);
    assert.equal(first.refused, 'changed since');
    // The loop went on to the next attempt, which was applied.
    assert.equal(second.accepted, true);
    assert.equal(second.refused, null);
    assert.equal(env.changes.calls.length, 2);
    assert.equal(run.repair.applied.changeId, 7);
    assert.equal(run.repair.reason, 'applied');
    // Each attempt is logged once, after the write's outcome.
    const attempts = logs.filter((l) => l.msg === 'mentor: repair attempt').map(({ caseId, n, accepted }) => ({ caseId, n, accepted }));
    assert.deepEqual(attempts, [
      { caseId: item.id, n: 1, accepted: false },
      { caseId: item.id, n: 2, accepted: true },
    ]);
  });
});

test('attempt: the phases of the loop show in the status', () =>
  withSetup({}, async (env) => {
    storedCase(env);
    await runCase(env);
    const phases = [...new Set(env.llm.calls.map((c) => c.phase).filter((p) => String(p).startsWith('repair')))];
    assert.deepEqual(phases, ['repair 1: ablation', 'repair 1: edit', 'repair 1: verify', 'repair 1: regression']);
  }));

// ---- several attempts and the end of the loop -------------------------------------

test('attempt: maxAttempts is respected', () => {
  const causes = [1, 2, 3].map((n) => ({ layer: 'missing', excerpt: '', why: `gap ${n}` }));
  const fix = JSON.stringify({ layer: 'card', target: 'character-card', from: 'talks a lot', to: 'talks little', why: 'x' });
  return withSetup({ config: { mentor: { fix: { maxAttempts: 2 } } }, llm: fakeLlm({ diagnosis: JSON.stringify({ ...DIAGNOSIS, causes }), fix }) }, async (env) => {
    const { run } = await runCase(env);
    assert.equal(run.repair.attempts.length, 2);
    assert.equal(env.llm.ofKind('fix').length, 2);
    assert.deepEqual(run.repair.attempts.map((a) => a.suspects.map((s) => s.confirmed)), [[true, true], [true, true]]);
    // Attempt 1 repairs the first cause; the second, also confirmed, waits for attempt 2.
    assert.deepEqual(env.llm.ofKind('fix').map((c) => JSON.parse(blockBody(c.user, 'cause')).why), ['gap 1', 'gap 2']);
    assert.equal(run.repair.reason, 'max attempts');
  });
});

test('attempt: a suspect confirmed earlier is not measured again', () => {
  const diagnosis = JSON.stringify({
    ...DIAGNOSIS,
    causes: [
      { layer: 'rules', excerpt: 'explain every limit', why: 'first' },
      { layer: 'rules', excerpt: 'every limit at length', why: 'second' },
    ],
  });
  let fixes = 0;
  // The first edit is refused, the second accepted.
  const fix = () => JSON.stringify((fixes += 1) === 1 ? { ...FIX, to: '' } : FIX);
  return withSetup({ llm: fakeLlm({ diagnosis, fix }) }, async (env) => {
    const { run } = await runCase(env);
    assert.equal(run.repair.attempts.length, 2);
    assert.equal(run.repair.attempts[0].refused, 'deletion not allowed');
    // Both were measured in attempt 1; the second, confirmed there, is repaired in attempt 2 without a new measure.
    assert.deepEqual(run.repair.attempts[0].suspects.map((s) => [s.excerpt, s.confirmed]), [['explain every limit', true], ['every limit at length', true]]);
    assert.deepEqual(run.repair.attempts[1].suspects.map((s) => s.excerpt), ['every limit at length']);
    assert.equal(run.repair.attempts[1].suspects[0].confirmed, true);
    assert.equal(env.llm.inPhase('repair 2: ablation').length, 0);
    assert.equal(JSON.parse(blockBody(env.llm.ofKind('fix')[1].user, 'cause')).why, 'second');
    assert.equal(run.repair.reason, 'applied');
  });
});

test('attempt: the budget stops the loop', () =>
  withSetup(
    {
      config: { mentor: { maxTokensPerDay: 50000, maxOutputTokens: 10 } },
      // The diagnosis spends what is left: the loop cannot send its first request.
      llm: fakeLlm({ usageFor: (kind) => (kind === 'diagnose' ? { prompt_tokens: 50000, completion_tokens: 0 } : USAGE) }),
    },
    async (env) => {
      const { item, run } = await runCase(env);
      assert.equal(run.repair.reason, 'budget');
      assert.equal(run.repair.tokens, 0);
      assert.equal(run.repair.applied, null);
      assert.equal(env.llm.calls.filter((c) => String(c.phase).startsWith('repair')).length, 0);
      assert.equal(run.stopped, undefined);
      assert.equal(run.passed, false);
      assert.equal(env.cases.get(GUILD, item.id).state, 'failing');
      assert.match(env.sent[0].content, /^repair: nothing applied \(budget\)$/m);
    },
  ));

test('attempt: the owner stopping the loop leaves the measured run as it is', () => {
  let env;
  const llm = fakeLlm({
    hook: (call) => {
      if (call.kind !== 'fix') return undefined;
      env.mentor.stop();
      return Promise.reject(new Error('aborted'));
    },
  });
  return withSetup({ llm }, async (e) => {
    env = e;
    const { item, run } = await runCase(e);
    assert.equal(run.repair.reason, 'stopped by the owner');
    assert.equal(run.stopped, undefined);
    assert.equal(run.passed, false);
    assert.equal(e.changes.calls.length, 0);
    assert.equal(e.cases.get(GUILD, item.id).state, 'failing');
    assert.equal(e.mentor.isRunning(), false);
  });
});

test('attempt: turning features.mentorAutoFix off during the loop writes nothing', () => {
  let hot;
  const llm = fakeLlm({
    hook: (call) => {
      if (call.phase === 'repair 1: verify') hot.config.features.mentorAutoFix = false;
      return undefined;
    },
  });
  return withSetup({ llm }, async (env) => {
    hot = env.hot;
    const { run } = await runCase(env);
    assert.equal(run.repair.reason, 'disabled');
    assert.equal(env.changes.calls.length, 0);
    assert.equal(run.repair.applied, null);
  });
});

// ---- the real change store ---------------------------------------------------------

test('attempt: an accepted rules edit lands in the local rules file through the change store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-mentor-repair-e2e-'));
  const promptsDir = path.join(root, 'prompts');
  const localPromptsDir = path.join(root, 'prompts.local');
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.writeFileSync(path.join(promptsDir, 'rules.md'), RULES);
  const dataDir = path.join(root, 'data');
  const memory = fakeMemoryStore();
  const changes = (hot) => createChangeStore({ dataDir, promptsDir, localPromptsDir, store: memory, getConfig: () => hot.config, now: () => NOW });
  return withSetup({ changes, dir: dataDir }, async (env) => {
    const { item, run } = await runCase(env);
    assert.equal(run.repair.reason, 'applied');
    assert.equal(run.repair.applied.changeId, 1);
    assert.equal(fs.readFileSync(path.join(localPromptsDir, 'rules.md'), 'utf8'), RULES.replace(BAD_RULE, FIXED_RULE));
    assert.equal(fs.readFileSync(path.join(promptsDir, 'rules.md'), 'utf8'), RULES);
    const store = createChangeStore({ dataDir, promptsDir, localPromptsDir, store: memory, getConfig: () => env.hot.config });
    const [change] = store.list(GUILD);
    assert.equal(change.id, 1);
    assert.equal(change.caseId, item.id);
    assert.equal(change.layer, 'rules');
    assert.equal(run.repair.applied.summary, change.summary);
  }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
});
