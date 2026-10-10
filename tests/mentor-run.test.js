// Tests for src/mentor/mentor.js: one mentor run end to end against fakes --
// a fake llm that answers by looking at the request, a fake Discord client
// whose admin channel records what is sent, a fake memory store and a real
// case store in a temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMentor, MENTOR_STORE_READS, worstSituation } from '../src/mentor/mentor.js';
import { createCaseStore } from '../src/mentor/cases.js';
import { createMentorBudget } from '../src/mentor/budget.js';
import { TokenLimitError } from '../src/llm/openrouter.js';
import { estimateMessages } from '../src/llm/tokens.js';
import { fill } from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const GUILD = 'g1';
const SELF_ID = '900000000000000001';
const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';
const ADMIN = '700000000000000001';
const CHANNEL = { id: '500000000000000001', name: 'general', category: 'Talk', topic: null, messageCount: 40 };
const OTHER_CHANNEL = { id: '500000000000000002', name: 'games', category: 'Talk', topic: null, messageCount: 90 };
const CASE_TEXT = 'The persona says calmly that it has hit a daily limit.';
const USAGE = { prompt_tokens: 100, completion_tokens: 10 }; // weighted: 100 + 10 * 5 = 150

function fakeConfig({ features = { mentor: true }, mentor = {}, bot = {}, memory = {} } = {}) {
  return {
    bot: { timezone: 'UTC', dryRunChannelId: ADMIN, ...bot },
    context: {
      channelMessages: 100,
      maxMessageChars: 800,
      gapMarkerMinutes: 20,
      otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    llm: { model: 'x/voice', maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    memory: {
      model: 'x/memory',
      maxOutputTokens: 4000,
      timeoutMs: 9000,
      fieldChars: 400,
      maxDetails: 15,
      maxInjokes: 15,
      maxSelfFacts: 20,
      maxEpisodes: 20,
      maxNewEpisodes: 3,
      mainChannelIds: [CHANNEL.id],
      ...memory,
    },
    media: { embedTextChars: 300 },
    relationships: { maxDeltaPerUpdate: 15, historySize: 10 },
    lore: { maxEntries: 500 },
    features,
    mentor: {
      model: 'x/mentor',
      maxTokensPerDay: 400000,
      outputTokenWeight: 5,
      cachedTokenWeight: 0.1,
      maxOutputTokens: 6000,
      timeoutMs: 300000,
      situations: 2,
      situationLines: [2, 4],
      samples: 2,
      check: { samples: 1 },
      pass: { score: 7, floor: 5 },
      reference: { days: 7, samples: 5, maxMessages: 300 },
      feedbackExamples: 10,
      ...mentor,
      // A real moment is answered as often as an invented situation here, unless a test says otherwise.
      anchor: { samples: 2, ...mentor.anchor },
    },
  };
}

function fakePrompts(overrides = {}) {
  return {
    'system-prompt': 'You are a regular member of this chat.',
    'character-card': 'CARD: {{name}} is friendly and terse.',
    rules: 'RULES: never use semicolons.',
    format: 'Use <msg> and <react> tags.',
    reply: 'Someone called you: {{author}}.',
    memory: 'Summarize what happened.',
    'mentor-situations': 'SITUATIONS for {{name}}: {{count}} of {{minLines}}-{{maxLines}} lines. {{unknown}}',
    'mentor-score': 'SCORE for {{name}}',
    'mentor-signs': 'SIGNS FOR {{name}}',
    'mentor-diagnose': 'DIAGNOSE {{name}}',
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
    getGuild: () => ({
      patterns: '',
      starters: '',
      injokes: [],
      self: [],
      learned: [{ id: 1, text: 'answer in one line', weight: 3, firstSeen: '2026-09-01', lastSeen: '2026-09-20' }],
    }),
    getUser: (guildId, id) => profiles[id] ?? null,
    getPrivate: () => {
      throw new Error('the private layer is out of bounds for the mentor');
    },
    listUserProfiles: () => Object.values(profiles),
    listChannels: () => [CHANNEL, OTHER_CHANNEL],
    getLore: () => [],
  };
}

const SITUATIONS = {
  situations: [
    {
      title: 'limit question',
      lines: [
        { authorId: BRUNO, authorName: 'Bruno', text: 'καλημέρα σε όλους', replyTo: null },
        { authorId: ALICE, authorName: 'Alice', text: 'are you out of drawings today?', replyTo: null },
      ],
    },
    {
      title: 'second question',
      lines: [
        { authorId: 'self', authorName: 'self', text: 'ναι', replyTo: null },
        { authorId: BRUNO, authorName: 'Bruno', text: 'why so quiet, café closed?', replyTo: 0 },
      ],
    },
    {
      title: 'invalid: unknown author',
      lines: [
        { authorId: '333333333333333333', text: 'hello', replyTo: null },
        { authorId: ALICE, text: 'hi', replyTo: null },
      ],
    },
  ],
};

const DIAGNOSIS = {
  summary: 'The persona explains the limit at length; the rules ask for an explanation of every refusal.',
  causes: [{ layer: 'rules', excerpt: 'never use semicolons', why: 'The rule is read as a style of long answers.' }],
  changes: [{ layer: 'rules', target: 'rules.md', from: '', to: 'say a limit once, in one line', why: 'Shorter notices.' }],
};

/** The answer ids listed in the `<answers>` block of a score request. */
function idsIn(user) {
  const match = /<answers>\n([\s\S]*?)\n<\/answers>/.exec(user);
  return match ? JSON.parse(match[1]).map((a) => a.id) : [];
}

function score(overall = 8) {
  return { human: 8, character: 8, rules: 8, goal: 8, overall, comment: 'natural and short' };
}

/**
 * A fake llm that answers by looking at the request: the mentor model by its
 * system text (situations, diagnose or score), else the voice model. `hook` may return a result (or a promise) to answer a
 * call itself.
 */
function fakeLlm({
  situations = SITUATIONS,
  scoreFor = () => score(),
  talk = '<msg>ναι, the limit is reached</msg>',
  diagnosis = JSON.stringify(DIAGNOSIS),
  usage = USAGE,
  usageFor,
  hook,
} = {}) {
  const calls = [];
  return {
    calls,
    kinds: () => calls.map((c) => c.kind),
    async complete(messages, options = {}) {
      const system = messages[0].content;
      const user = messages[1].content;
      let kind = 'talk';
      if (options.model === 'x/mentor') kind = system.startsWith('SITUATIONS') ? 'situations' : system.startsWith('DIAGNOSE') ? 'diagnose' : 'score';
      const call = { kind, messages, options, system, user };
      calls.push(call);
      if (hook) {
        const result = await hook(call);
        if (result !== undefined) return result;
      }
      let text;
      if (kind === 'situations') text = JSON.stringify(situations);
      else if (kind === 'score') {
        const answers = idsIn(user)
          .map((id) => ({ id, value: scoreFor(id, calls) }))
          .filter((a) => a.value)
          .map(({ id, value }) => ({ id, ...value }));
        text = JSON.stringify({ answers });
      } else if (kind === 'diagnose') text = diagnosis;
      else text = talk;
      return { text, usage: usageFor ? usageFor(kind) : usage, estimated: 90 };
    },
  };
}

function reference() {
  const base = { channelId: CHANNEL.id, self: false, bot: false, replyToId: null };
  return [
    { ...base, id: 'r1', authorId: ALICE, content: 'ok i will check the café later tonight' },
    { ...base, id: 'r2', authorId: BRUNO, content: 'καλημέρα, anyone up for a game' },
    { ...base, id: 'r3', authorId: SELF_ID, self: true, content: 'THE PERSONA LINE that must be dropped' },
    { ...base, id: 'r4', authorId: '4', bot: true, content: 'A BOT LINE that must be dropped here' },
  ];
}

function setup({ config = {}, prompts = {}, llm = fakeLlm(), sendFails = false, fetchChannel, windowFor, fetchMoment, store = fakeMemoryStore(), calibrator, emoji, guilds, lookup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-mentor-run-'));
  let clock = NOW;
  const now = () => (clock += 1000);
  const hot = { config: fakeConfig(config), prompts: fakePrompts(prompts) };
  const cases = createCaseStore({ dataDir: dir, now });
  const state = { data: {}, markDirty() {} };
  const budget = createMentorBudget({ state, getConfig: () => hot.config, now });
  const sent = [];
  const admin = {
    id: ADMIN,
    send: async (payload) => {
      if (sendFails) throw new Error('missing access');
      sent.push(payload);
    },
  };
  const fetched = [];
  const client = {
    channels: {
      fetch: async (id) => {
        fetched.push(id);
        if (fetchChannel) return fetchChannel(id);
        if (id === ADMIN) return admin;
        if (id === CHANNEL.id || id === OTHER_CHANNEL.id) return { id };
        return null;
      },
    },
    // A client that holds guilds (the bot's gateway client) resolves the <senses> destination live.
    ...(guilds ? { guilds } : {}),
  };
  const windows = [];
  const fetchHistoryWindow = async (channel, options) => {
    windows.push({ channel, options });
    return windowFor ? windowFor(channel) : reference();
  };
  const mentor = createMentor({
    hot,
    store,
    llm,
    client,
    cases,
    budget,
    getGuildId: () => GUILD,
    getSelf: () => ({ id: SELF_ID, name: 'Zoë' }),
    fetchHistoryWindow,
    fetchMoment,
    calibrator,
    emoji,
    lookup,
    now,
    rng: () => 0,
  });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { mentor, cases, hot, llm, budget, state, sent, fetched, windows, store, dir, cleanup };
}

async function withSetup(options, fn) {
  const env = setup(options);
  try {
    await fn(env);
  } finally {
    env.cleanup();
  }
}

// ---- guards ------------------------------------------------------------------

test('run: refuses when features.mentor is not true', () =>
  withSetup({ config: { features: { mentor: 'yes' } } }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await assert.rejects(mentor.run(item.id), /not enabled/);
    assert.equal(llm.calls.length, 0);
    assert.equal(mentor.isRunning(), false);
  }));

test('run: refuses without mentor.model', () =>
  withSetup({ config: { mentor: { model: null } } }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await assert.rejects(mentor.run(item.id), /mentor\.model/);
    assert.equal(llm.calls.length, 0);
  }));

test('run: refuses an unknown case, a missing prompt and an exhausted budget', () =>
  withSetup({ prompts: { 'mentor-score': undefined } }, async ({ mentor, cases, llm, hot }) => {
    await assert.rejects(mentor.run(42), /case 42/);
    const replyCase = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await assert.rejects(mentor.run(replyCase.id), /mentor prompt missing: mentor-score/);
    hot.prompts['mentor-score'] = 'SCORE for {{name}}';
    hot.config.mentor.maxTokensPerDay = 0;
    await assert.rejects(mentor.run(replyCase.id), /budget/);
    assert.equal(llm.calls.length, 0);
    assert.equal(mentor.isRunning(), false);
  }));

test('run: refuses a second run in flight', () =>
  withSetup({}, async ({ mentor, cases }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const first = await mentor.run(item.id);
    assert.equal(first.started, true);
    assert.equal(mentor.isRunning(), true);
    await assert.rejects(mentor.run(item.id), /already/);
    await assert.rejects(mentor.check(), /already/);
    await first.done;
    assert.equal(mentor.isRunning(), false);
  }));

// ---- a full run --------------------------------------------------------------

test('run: posts a card with a file to the admin channel', () =>
  withSetup({}, async ({ mentor, cases, sent }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const { done } = await mentor.run(item.id);
    const run = await done;
    assert.equal(sent.length, 1);
    const [payload] = sent;
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.ok(payload.content.length <= 1800);
    assert.match(payload.content, new RegExp(`case ${item.id}`));
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0].name, `mentor-case-${item.id}-${run.id}.txt`);
    assert.ok(Buffer.isBuffer(payload.files[0].attachment));
    assert.match(payload.files[0].attachment.toString('utf8'), /natural and short/);
  }));

test('run: charges the budget for every request', () =>
  withSetup({}, async ({ mentor, cases, llm, budget }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    // 1 situations request + 2 situations x 2 samples, then 2 score requests (every answer before any score).
    assert.deepEqual(llm.kinds(), ['situations', 'talk', 'talk', 'talk', 'talk', 'score', 'score']);
    assert.equal(budget.used(), 7 * 150);
    assert.deepEqual(run.tokens, { spent: 7 * 150, left: 400000 - 7 * 150 });
  }));

test('run: the run object carries situations, answers, scores and the verdict', () =>
  withSetup({}, async ({ mentor, cases, windows }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.caseId, item.id);
    assert.equal(run.caseText, CASE_TEXT);
    assert.equal(run.target, 'reply');
    assert.equal(run.kind, 'run');
    assert.deepEqual(run.models, { mentor: 'x/mentor', voice: 'x/voice' });
    assert.equal(run.dropped, 1);
    assert.equal(run.situations.length, 2);
    assert.equal(run.reference.profile.messages, 2);
    assert.equal(run.reference.samples, 2);
    const [first, second] = run.situations;
    assert.equal(first.n, 1);
    assert.match(first.transcript, /are you out of drawings today\?/);
    assert.match(second.transcript, /Zoë \(you\)/);
    assert.deepEqual(first.answers.map((a) => a.id), ['s1a1', 's1a2']);
    assert.deepEqual(first.answers[0].messages, ['ναι, the limit is reached']);
    assert.deepEqual(first.answers[0].reactions, []);
    assert.equal(first.answers[0].silent, false);
    assert.equal(first.answers[0].facts.messages, 1);
    assert.deepEqual(first.answers[0].score, score());
    // The same answer in both situations: counted once per situation, not once per answer.
    assert.deepEqual(run.repeated.map((r) => r.count), [2]);
    assert.deepEqual(run.medians, { human: 8, character: 8, rules: 8, goal: 8, overall: 8 });
    assert.equal(run.passed, true);
    assert.equal(run.stopped, undefined);
    assert.equal(run.error, undefined);
    // The reference: the one main channel, the limit and the day floor from the config.
    assert.equal(windows.length, 1);
    assert.equal(windows[0].options.limit, 300);
    assert.equal(windows[0].options.selfId, SELF_ID);
    assert.equal(windows[0].options.embedTextChars, 300);
    assert.ok(windows[0].options.minTs < NOW - 6 * 86400000 && windows[0].options.minTs > NOW - 8 * 86400000);
  }));

test('run: a failing situation fails the run and is named in the reasons', () => {
  const [first, second] = SITUATIONS.situations;
  const situations = { situations: [first, second, { ...first, title: 'third question' }] };
  const low = { human: 8, character: 8, rules: 8, goal: 8, overall: 3, comment: 'misses the point' };
  const llm = fakeLlm({ situations, scoreFor: (id) => (id.startsWith('s2') ? low : score(9)) });
  return withSetup({ config: { mentor: { situations: 3 } }, llm }, async ({ mentor, cases }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.situations.length, 3);
    // Over all six answers the medians pass: only the situation fails.
    assert.equal(run.medians.overall, 9);
    assert.equal(run.passed, false);
    assert.deepEqual(run.reasons, ['situation 2: overall 3 is under the floor 5']);
    assert.equal(cases.get(GUILD, item.id).state, 'failing');
  });
});

test('run: the run stores the medians by situation', () =>
  withSetup(
    { llm: fakeLlm({ scoreFor: (id) => (id === 's2a1' ? null : id.startsWith('s1') ? score(9) : score(7)) }) },
    async ({ mentor, cases }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      const expected = [
        { n: 1, overall: 9, goal: 8 },
        { n: 2, overall: 7, goal: 8 },
      ];
      assert.deepEqual(run.situationMedians, expected);
      assert.equal(run.passed, true);
      assert.deepEqual(cases.lastRun(GUILD, item.id).situationMedians, expected);
    },
  ));

test('run: saves the run and the case state', () =>
  withSetup({}, async ({ mentor, cases }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    const stored = cases.lastRun(GUILD, item.id);
    assert.equal(stored.id, run.id);
    assert.equal(stored.situations.length, 2);
    const updated = cases.get(GUILD, item.id);
    assert.equal(updated.state, 'passing');
    assert.equal(updated.lastScore, 8);
    assert.equal(updated.lastRunId, run.id);
  }));

test('run: mentor requests use mentor.model and are not counted against the daily cap', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    const mentorCalls = llm.calls.filter((c) => c.kind === 'situations' || c.kind === 'score');
    assert.equal(mentorCalls.length, 3);
    for (const { options } of llm.calls) {
      assert.equal(options.countAgainstDailyCap, false);
      assert.equal(options.skipCalibration, true);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal('maxRequestTokens' in options, false);
      // Logged only: the usage line tells mentor traffic from live chat.
      assert.equal(options.origin, 'mentor');
    }
    for (const { options } of mentorCalls) {
      assert.equal(options.model, 'x/mentor');
      assert.equal(options.maxOutputTokens, 6000);
      assert.equal(options.timeoutMs, 300000);
    }
  }));

test('run: the situations and score requests carry their blocks', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    const situations = llm.calls.find((c) => c.kind === 'situations');
    assert.equal(situations.system, 'SITUATIONS for Zoë: 2 of 2-4 lines. {{unknown}}');
    assert.match(situations.user, new RegExp(`^<case>\\n${CASE_TEXT}\\n</case>`));
    assert.match(situations.user, new RegExp(`<members>\\nAlice \\(id:${ALICE}\\)\\nBruno \\(id:${BRUNO}\\)\\n</members>`));
    assert.match(situations.user, /<reference>\n\{/);
    assert.match(situations.user, /<samples>\n/);
    assert.doesNotMatch(situations.user, /PERSONA LINE|BOT LINE/);
    for (const tag of ['feedback', 'intended', 'character', 'rules', 'learned', 'situation', 'answers', 'facts']) {
      assert.doesNotMatch(situations.user, new RegExp(`<${tag}>`), tag);
    }

    const scoreCall = llm.calls.find((c) => c.kind === 'score');
    assert.equal(scoreCall.system, 'SCORE for Zoë');
    const order = ['case', 'reference', 'samples', 'intended', 'character', 'rules', 'learned', 'situation', 'answers', 'facts'];
    const positions = order.map((tag) => scoreCall.user.indexOf(`<${tag}>`));
    assert.ok(positions.every((p) => p >= 0), JSON.stringify(positions));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.match(scoreCall.user, /<intended>\na limit notice is a feature\n<\/intended>/);
    assert.match(scoreCall.user, /<character>\nCARD: Zoë is friendly and terse\.\n<\/character>/);
    assert.match(scoreCall.user, /<rules>\nRULES: never use semicolons\.\n<\/rules>/);
    assert.match(scoreCall.user, /<learned>\nThings people taught you: answer in one line/);
    assert.doesNotMatch(scoreCall.user, /<members>|<feedback>|<stored>/);
    const answers = JSON.parse(/<answers>\n([\s\S]*?)\n<\/answers>/.exec(scoreCall.user)[1]);
    assert.deepEqual(answers[0], { id: 's1a1', messages: ['ναι, the limit is reached'], reactions: [], silent: false });
    const facts = JSON.parse(/<facts>\n([\s\S]*?)\n<\/facts>/.exec(scoreCall.user)[1]);
    assert.deepEqual(Object.keys(facts), ['s1a1', 's1a2', 'repeated']);
    assert.equal(facts.repeated[0].count, 2);
  }));

test('run: the owner feedback reaches the requests, newest first', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    cases.addFeedback(GUILD, { caseId: item.id, reason: 'too strict on length' });
    cases.addFeedback(GUILD, { caseId: item.id, reason: 'the notice is fine' });
    llm.calls.length = 0;
    await (await mentor.run(item.id)).done;
    for (const call of llm.calls.filter((c) => c.kind === 'situations' || c.kind === 'score')) {
      const feedback = JSON.parse(/<feedback>\n([\s\S]*?)\n<\/feedback>/.exec(call.user)[1]);
      assert.deepEqual(feedback, [
        { case: CASE_TEXT, reason: 'the notice is fine' },
        { case: CASE_TEXT, reason: 'too strict on length' },
      ]);
    }
  }));

test('run: a missing score is asked for once more, then left unscored', () =>
  withSetup(
    { llm: fakeLlm({ scoreFor: (id) => (id === 's1a2' || id === 's2a1' ? null : score()) }) },
    async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      const scoreCalls = llm.calls.filter((c) => c.kind === 'score');
      assert.equal(scoreCalls.length, 4);
      assert.deepEqual(scoreCalls.map((c) => idsIn(c.user)), [['s1a1', 's1a2'], ['s1a2'], ['s2a1', 's2a2'], ['s2a1']]);
      const facts = JSON.parse(/<facts>\n([\s\S]*?)\n<\/facts>/.exec(scoreCalls[1].user)[1]);
      assert.deepEqual(Object.keys(facts), ['s1a2', 'repeated']);
      assert.equal(run.situations[0].answers[1].score, null);
      assert.deepEqual(run.situations[0].answers[0].score, score());
      assert.equal(run.passed, true);
    },
  ));

test('run: no answer scored ends the run as an error', () =>
  withSetup({ llm: fakeLlm({ scoreFor: () => null }) }, async ({ mentor, cases, sent }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, 'no answer was scored');
    assert.equal(run.passed, false);
    assert.equal(sent.length, 1);
    assert.equal(cases.get(GUILD, item.id).state, 'new');
  }));

test('run: no valid situation ends the run as an error', () =>
  withSetup({ llm: fakeLlm({ situations: { situations: [SITUATIONS.situations[2]] } }) }, async ({ mentor, cases, llm, sent }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, 'no valid situation');
    assert.equal(run.dropped, 1);
    assert.deepEqual(run.situations, []);
    assert.deepEqual(llm.kinds(), ['situations']);
    assert.equal(sent.length, 1);
    assert.equal(cases.lastRun(GUILD, item.id).error, 'no valid situation');
  }));

test('run: a request over the token cap ends the run as an error', () =>
  withSetup(
    {
      llm: fakeLlm({
        hook: (call) => {
          if (call.kind === 'talk') throw Object.assign(new TokenLimitError('too big'), { key: 'llm.maxRequestTokens' });
          return undefined;
        },
      }),
    },
    async ({ mentor, cases }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      assert.equal(run.error, 'request over the token cap');
      assert.equal(run.passed, false);
      assert.equal(mentor.isRunning(), false);
    },
  ));

test('run: no readable channel for the reference ends the run as an error', () =>
  withSetup(
    { fetchChannel: (id) => (id === ADMIN ? { send: async () => {} } : null) },
    async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      assert.equal(run.error, 'no readable channel for the reference');
      assert.equal(llm.calls.length, 0);
    },
  ));

test('run: an empty reference ends the run before any request', async () => {
  const onlyPersonaAndBots = () => reference().filter((m) => m.self || m.bot);
  // Windows with lines of the persona and of bots only: nothing of people was measured.
  await withSetup({ windowFor: onlyPersonaAndBots }, async ({ mentor, cases, llm, sent }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, 'the reference is empty');
    assert.equal(run.passed, false);
    assert.equal(llm.calls.length, 0);
    assert.equal(sent.length, 1);
    assert.equal(cases.lastRun(GUILD, item.id).error, 'the reference is empty');
  });
  // A window that came back empty (a quiet week, or a history the bot cannot read) is not a readable channel.
  await withSetup({ windowFor: () => [] }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, 'no readable channel for the reference');
    assert.equal(llm.calls.length, 0);
  });
  // One empty channel next to a readable one: the run goes ahead on the readable one.
  await withSetup(
    { config: { memory: { mainChannelIds: [CHANNEL.id, OTHER_CHANNEL.id] } }, windowFor: (channel) => (channel.id === CHANNEL.id ? [] : reference()) },
    async ({ mentor, cases }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      assert.equal(run.error, undefined);
      assert.equal(run.reference.profile.messages, 2);
    },
  );
});

test('run: without main channels the busiest stored channel is read', () =>
  withSetup({ config: { memory: { mainChannelIds: [] } } }, async ({ mentor, cases, windows, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    assert.deepEqual(windows.map((w) => w.channel.id), [OTHER_CHANNEL.id]);
    // The situation is set in that channel: the persona's server map marks it as the current one.
    const talk = llm.calls.find((c) => c.kind === 'talk');
    assert.match(talk.user, /# games ← you are here/);
    assert.doesNotMatch(talk.user, /# general ← you are here/);
  }));

test('run: the report is still saved when the admin channel fails', () =>
  withSetup({ sendFails: true }, async ({ mentor, cases }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(cases.lastRun(GUILD, item.id).id, run.id);
  }));

test('run: stops with what it has when the budget runs out', () =>
  withSetup(
    {
      // A small maxOutputTokens keeps the pre-flight check of the situations request under this budget.
      config: { mentor: { maxTokensPerDay: 12000, maxOutputTokens: 10 } },
      llm: fakeLlm({ usageFor: (kind) => (kind === 'talk' ? { prompt_tokens: 5000, completion_tokens: 10 } : USAGE) }),
    },
    async ({ mentor, cases, llm, sent, budget }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      // Situations (150), then situation 1's two answers (2 x 5050); situation 2 would need another 10100.
      assert.deepEqual(llm.kinds(), ['situations', 'talk', 'talk']);
      assert.equal(run.stopped, 'budget');
      assert.equal(run.passed, false);
      assert.equal(run.situations.length, 2);
      assert.equal(run.situations[0].answers.length, 2);
      assert.deepEqual(run.situations[1].answers, []);
      assert.deepEqual(run.medians, { human: null, character: null, rules: null, goal: null, overall: null });
      assert.equal(run.tokens.spent, 150 + 2 * 5050);
      assert.equal(run.tokens.left, budget.left());
      assert.equal(sent.length, 1);
      assert.match(sent[0].content, /budget/i);
      assert.equal(cases.lastRun(GUILD, item.id).stopped, 'budget');
      assert.equal(cases.get(GUILD, item.id).state, 'new');
    },
  ));

test('run: a mentor request is refused when its possible output does not fit the budget', () =>
  withSetup({ config: { mentor: { maxTokensPerDay: 20000 } } }, async ({ mentor, cases, llm, hot, sent }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    // The prompt fits, but 6000 output tokens at weight 5 (30000) do not.
    const refused = await (await mentor.run(item.id)).done;
    assert.equal(refused.stopped, 'budget');
    assert.equal(llm.calls.length, 0);
    assert.match(sent[0].content, /budget/i);

    // The live values are read at the moment of the request.
    hot.config.mentor.maxOutputTokens = 1000;
    hot.config.mentor.outputTokenWeight = 2;
    const ran = await (await mentor.run(item.id)).done;
    assert.equal(ran.stopped, undefined);
    assert.equal(ran.passed, true);
    assert.equal(llm.calls[0].kind, 'situations');
  }));

test('run: turning features.mentor off ends the run as stopped', () => {
  let hot;
  const llm = fakeLlm({
    hook: (call) => {
      if (call.kind === 'talk') hot.config.features.mentor = false;
      return undefined;
    },
  });
  return withSetup({ llm }, async (env) => {
    hot = env.hot;
    const item = env.cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await env.mentor.run(item.id)).done;
    // Situation 1 is answered (both samples were already under way); situation 2 never starts.
    assert.deepEqual(llm.kinds(), ['situations', 'talk', 'talk']);
    assert.equal(run.stopped, 'disabled');
    assert.equal(run.error, undefined);
    assert.equal(run.passed, false);
    assert.equal(run.situations[0].answers.length, 2);
    assert.deepEqual(run.situations[1].answers, []);
    assert.equal(env.sent.length, 1);
    assert.match(env.sent[0].content, /stopped: the mentor was disabled during the run/);
    assert.equal(env.cases.lastRun(GUILD, item.id).stopped, 'disabled');
    assert.equal(env.cases.get(GUILD, item.id).state, 'new');
    assert.equal(env.mentor.isRunning(), false);
  });
});

test('run: clearing mentor.model never sends a request to the voice model', () => {
  let hot;
  let talks = 0;
  const llm = fakeLlm({
    hook: (call) => {
      // The last answer of the last situation: the next request would be a score request.
      if (call.kind === 'talk' && (talks += 1) === 4) hot.config.mentor.model = null;
      return undefined;
    },
  });
  return withSetup({ llm }, async (env) => {
    hot = env.hot;
    const item = env.cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await env.mentor.run(item.id)).done;
    assert.deepEqual(llm.kinds(), ['situations', 'talk', 'talk', 'talk', 'talk']);
    // No request with the mentor's output size ever went out without the mentor model.
    for (const { options } of llm.calls) {
      if (options.maxOutputTokens === 6000) assert.equal(options.model, 'x/mentor');
    }
    assert.equal(run.stopped, 'disabled');
    assert.equal(run.passed, false);
  });
});

test('check: a run ended by the switches skips the remaining cases', () => {
  let hot;
  let armed = false;
  const llm = fakeLlm({
    hook: (call) => {
      if (armed && call.kind === 'talk') hot.config.features.mentor = false;
      return undefined;
    },
  });
  return withSetup({ llm }, async (env) => {
    hot = env.hot;
    const first = env.cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const second = env.cases.add(GUILD, { text: 'The persona never repeats itself.', target: 'reply' });
    await (await env.mentor.run(first.id)).done;
    await (await env.mentor.run(second.id)).done;
    llm.calls.length = 0;
    armed = true;
    const runs = await (await env.mentor.check()).done;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].stopped, 'disabled');
    assert.deepEqual(llm.kinds(), ['talk']);
    const card = env.sent.at(-1).content;
    assert.match(card, new RegExp(`case ${first.id}: stopped \\(disabled\\)`));
    assert.match(card, new RegExp(`case ${second.id}: skipped \\(stopped: the mentor was disabled during the run\\)`));
  });
});

// ---- the signs block -----------------------------------------------------------

/** The `<signs>` block as the fake prompts fill it, directly after `<samples>`. */
const SIGNS_AFTER_SAMPLES = '</samples>\n\n<signs>\nSIGNS FOR Zoë\n</signs>';

test('run: the situations request carries <signs> when the prompt exists', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    const situations = llm.calls.find((c) => c.kind === 'situations');
    assert.ok(situations.user.includes(SIGNS_AFTER_SAMPLES), situations.user);
    assert.equal(situations.user.split('<signs>').length, 2);
  }));

test('run: every score request carries <signs> after <samples>', () =>
  withSetup(
    { llm: fakeLlm({ scoreFor: (id) => (id === 's1a2' ? null : score()) }) },
    async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      await (await mentor.run(item.id)).done;
      const scoreCalls = llm.calls.filter((c) => c.kind === 'score');
      // The re-ask for the missing score is one of them.
      assert.deepEqual(scoreCalls.map((c) => idsIn(c.user)), [['s1a1', 's1a2'], ['s1a2'], ['s2a1', 's2a2']]);
      for (const call of scoreCalls) {
        assert.ok(call.user.includes(SIGNS_AFTER_SAMPLES), call.user);
        assert.ok(call.user.indexOf('<signs>') < call.user.indexOf('<intended>'));
      }
      // A check builds its score requests the same way.
      llm.calls.length = 0;
      await (await mentor.check()).done;
      const checkScores = llm.calls.filter((c) => c.kind === 'score');
      assert.ok(checkScores.length > 0);
      for (const call of checkScores) assert.ok(call.user.includes(SIGNS_AFTER_SAMPLES), call.user);
    },
  ));

test('run: a missing mentor-signs prompt omits the block and the run still completes', async () => {
  for (const signs of [undefined, '', '  \n  ']) {
    await withSetup({ prompts: { 'mentor-signs': signs } }, async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      assert.equal(run.error, undefined);
      assert.equal(run.passed, true);
      const mentorCalls = llm.calls.filter((c) => c.kind === 'situations' || c.kind === 'score');
      assert.equal(mentorCalls.length, 3);
      for (const call of mentorCalls) assert.doesNotMatch(call.user, /<signs>/);
      const checked = await (await mentor.check()).done;
      assert.equal(checked.length, 1);
      assert.equal(checked[0].error, undefined);
    });
  }
});

// ---- the diagnosis -------------------------------------------------------------

/** The body of the first `<tag>` block of `text`, or null. */
function blockBody(text, tag) {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return match ? match[1] : null;
}

/** A score function: situation n gets `overalls[n - 1]` on overall, every other axis 8. */
function overallBySituation(...overalls) {
  return (id) => score(overalls[Number(/^s(\d+)/.exec(id)[1]) - 1]);
}

const THREE = { situations: [SITUATIONS.situations[0], SITUATIONS.situations[1], { ...SITUATIONS.situations[0], title: 'third question' }] };

test('run: a failing run asks for a diagnosis and stores it', () => {
  let env;
  let phase;
  const llm = fakeLlm({
    scoreFor: overallBySituation(9, 3),
    hook: (call) => {
      if (call.kind === 'diagnose') phase = env.mentor.status().phase;
      return undefined;
    },
  });
  return withSetup({ llm }, async (e) => {
    env = e;
    const item = e.cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const { result: run, logs } = await withCapturedLogs(async () => (await e.mentor.run(item.id)).done);
    assert.deepEqual(llm.kinds(), ['situations', 'talk', 'talk', 'talk', 'talk', 'score', 'score', 'diagnose']);
    assert.equal(phase, 'diagnosis');
    assert.equal(run.passed, false);
    assert.equal(run.error, undefined);
    assert.equal(run.stopped, undefined);
    assert.deepEqual(run.diagnosis, DIAGNOSIS);
    assert.equal('diagnosisError' in run, false);

    const call = llm.calls.at(-1);
    assert.equal(call.system, 'DIAGNOSE Zoë');
    assert.equal(call.options.model, 'x/mentor');
    assert.equal(call.options.maxOutputTokens, 6000);
    assert.equal(call.options.countAgainstDailyCap, false);
    assert.equal(call.options.skipCalibration, true);
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal('maxRequestTokens' in call.options, false);
    // Charged like every other request, and counted in the run's tokens.
    assert.equal(e.budget.used(), 8 * 150);
    assert.equal(run.tokens.spent, 8 * 150);

    const stored = e.cases.lastRun(GUILD, item.id);
    assert.deepEqual(stored.diagnosis, DIAGNOSIS);
    // What the persona was given stays in memory: never in the saved run.
    assert.doesNotMatch(JSON.stringify(stored), /"request":/);
    assert.match(e.sent[0].content, /^diagnosis: The persona explains the limit at length/m);
    assert.ok(e.sent[0].files[0].attachment.toString('utf8').includes("Diagnosis (the mentor's opinion, not verified)"));

    const logged = logs.filter((l) => l.msg === 'mentor: diagnosis');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].caseId, item.id);
    assert.equal(logged[0].causes, 1);
    assert.equal(logged[0].changes, 1);
    assert.doesNotMatch(JSON.stringify(logs), /explains the limit|say a limit once/);
  });
});

test('run: a passing run with every situation at or above the pass score asks for none', () =>
  withSetup({ llm: fakeLlm({ scoreFor: overallBySituation(9, 7) }) }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.passed, true);
    assert.equal(llm.kinds().includes('diagnose'), false);
    assert.equal('diagnosis' in run, false);
    assert.equal('diagnosisError' in run, false);
  }));

test('run: a passing run with one weak situation asks for one', () =>
  withSetup({ llm: fakeLlm({ scoreFor: overallBySituation(9, 6) }) }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    // Over all answers the median overall is 7.5 and situation 2 is above the floor: the case passes.
    assert.equal(run.passed, true);
    assert.equal(llm.kinds().filter((k) => k === 'diagnose').length, 1);
    const worst = JSON.parse(blockBody(llm.calls.at(-1).user, 'worst'));
    assert.equal(worst.n, 2);
    assert.deepEqual(run.diagnosis, DIAGNOSIS);
  }));

test('run: <worst> is the situation with the lowest median and <seen> carries its system and user text', async () => {
  await withSetup(
    { config: { mentor: { situations: 3 } }, llm: fakeLlm({ situations: THREE, scoreFor: overallBySituation(9, 6, 4) }) },
    async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      await (await mentor.run(item.id)).done;
      cases.addFeedback(GUILD, { caseId: item.id, reason: 'too strict on length' });
      llm.calls.length = 0;
      const run = await (await mentor.run(item.id)).done;
      const { user } = llm.calls.at(-1);
      assert.equal(llm.calls.at(-1).kind, 'diagnose');

      const order = ['case', 'verdict', 'signs', 'feedback', 'worst', 'seen'];
      const positions = order.map((tag) => user.indexOf(`<${tag}>`));
      assert.ok(positions.every((p) => p >= 0), JSON.stringify(positions));
      assert.deepEqual([...positions].sort((a, b) => a - b), positions);
      assert.ok(user.startsWith(`<case>\n${CASE_TEXT}\n</case>`));
      assert.doesNotMatch(user, /<reference>|<samples>|<members>|<intended>|<answers>/);

      assert.deepEqual(JSON.parse(blockBody(user, 'verdict')), {
        passed: run.passed,
        medians: run.medians,
        situations: run.situationMedians,
        reasons: run.reasons,
      });
      assert.deepEqual(JSON.parse(blockBody(user, 'feedback')), [{ case: CASE_TEXT, reason: 'too strict on length' }]);

      const worst = JSON.parse(blockBody(user, 'worst'));
      const third = run.situations[2];
      assert.deepEqual(worst, { n: 3, title: 'third question', transcript: third.transcript, answers: third.answers });
      assert.deepEqual(Object.keys(worst.answers[0]), ['id', 'messages', 'reactions', 'silent', 'facts', 'score']);

      // The talk requests of situation 3 (both samples see the same request).
      const talk = llm.calls.filter((c) => c.kind === 'talk')[4];
      const seen = blockBody(user, 'seen');
      assert.ok(seen.startsWith(`<system>\n${talk.system}\n</system>`), seen.slice(0, 200));
      assert.ok(seen.endsWith(`<user>\n${talk.user}\n</user>`), seen.slice(-200));
      assert.ok(user.endsWith('</seen>'));
    },
  );
  // A tie goes to the lowest n.
  await withSetup(
    { config: { mentor: { situations: 3 } }, llm: fakeLlm({ situations: THREE, scoreFor: overallBySituation(9, 4, 4) }) },
    async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      await (await mentor.run(item.id)).done;
      assert.equal(JSON.parse(blockBody(llm.calls.at(-1).user, 'worst')).n, 2);
      const talk = llm.calls.filter((c) => c.kind === 'talk')[2];
      assert.ok(blockBody(llm.calls.at(-1).user, 'seen').includes(`<user>\n${talk.user}\n</user>`));
    },
  );
});

test('run: mentor.diagnose false skips the step', () =>
  withSetup({ config: { mentor: { diagnose: false } }, llm: fakeLlm({ scoreFor: overallBySituation(9, 3) }) }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.passed, false);
    assert.equal(llm.kinds().includes('diagnose'), false);
    assert.equal('diagnosis' in run, false);
    assert.equal('diagnosisError' in run, false);
  }));

test('run: a diagnosis request that fails leaves diagnosisError and the run is still saved', async () => {
  const failing = overallBySituation(9, 3);
  const variants = [
    {
      name: 'an HTTP error',
      options: {
        llm: fakeLlm({
          scoreFor: failing,
          hook: (call) => {
            if (call.kind === 'diagnose') throw Object.assign(new Error('upstream said something private'), { statusCode: 502 });
            return undefined;
          },
        }),
      },
      reason: 'request failed',
      asked: true,
    },
    { name: 'an answer that is not a diagnosis', options: { llm: fakeLlm({ scoreFor: failing, diagnosis: 'I think the rules are to blame.' }) }, reason: 'invalid answer', asked: true },
    { name: 'a missing prompt', options: { prompts: { 'mentor-diagnose': undefined }, llm: fakeLlm({ scoreFor: failing }) }, reason: 'prompt missing', asked: false },
  ];
  for (const { name, options, reason, asked } of variants) {
    await withSetup(options, async (env) => {
      const item = env.cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const { result: run, logs } = await withCapturedLogs(async () => (await env.mentor.run(item.id)).done);
      assert.equal(env.llm.kinds().includes('diagnose'), asked, name);
      assert.equal(run.diagnosis, null, name);
      assert.equal(run.diagnosisError, reason, name);
      assert.equal(run.error, undefined, name);
      assert.equal(run.stopped, undefined, name);
      assert.equal(run.passed, false, name);
      const stored = env.cases.lastRun(GUILD, item.id);
      assert.equal(stored.id, run.id, name);
      assert.equal(stored.diagnosisError, reason, name);
      assert.equal(env.cases.get(GUILD, item.id).state, 'failing', name);
      assert.equal(env.sent.length, 1, name);
      const failed = logs.filter((l) => l.msg === 'mentor: diagnosis failed');
      assert.equal(failed.length, 1, name);
      assert.equal(failed[0].reason, reason, name);
      assert.equal(failed[0].caseId, item.id, name);
      assert.doesNotMatch(JSON.stringify(logs), /something private|rules are to blame/, name);
      assert.equal(env.mentor.isRunning(), false, name);
    });
  }
});

test('run: the owner stopping the diagnosis leaves the measured run as it is', () => {
  let env;
  const llm = fakeLlm({
    scoreFor: overallBySituation(9, 3),
    hook: (call) => {
      if (call.kind !== 'diagnose') return undefined;
      env.mentor.stop();
      return Promise.reject(new Error('aborted'));
    },
  });
  return withSetup({ llm }, async (e) => {
    env = e;
    const item = e.cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await e.mentor.run(item.id)).done;
    assert.equal(run.stopped, undefined);
    assert.equal(run.diagnosis, null);
    assert.equal(run.diagnosisError, 'stopped by the owner');
    assert.equal(e.cases.get(GUILD, item.id).state, 'failing');
  });
});

test('run: a stopped or failed run asks for no diagnosis', async () => {
  // Nothing scored: an error.
  await withSetup({ llm: fakeLlm({ scoreFor: () => null }) }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, 'no answer was scored');
    assert.equal(llm.kinds().includes('diagnose'), false);
    assert.equal('diagnosis' in run, false);
    assert.equal('diagnosisError' in run, false);
  });
  // Stopped by the owner during scoring, with a failing situation already scored.
  let env;
  const stopping = fakeLlm({
    scoreFor: overallBySituation(3, 3),
    hook: (call) => {
      if (call.kind === 'score') env.mentor.stop();
      return undefined;
    },
  });
  await withSetup({ llm: stopping }, async (e) => {
    env = e;
    const item = e.cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await e.mentor.run(item.id)).done;
    assert.equal(run.stopped, 'owner');
    assert.ok(run.situations[0].answers[0].score);
    assert.equal(stopping.kinds().includes('diagnose'), false);
    assert.equal('diagnosis' in run, false);
    assert.equal('diagnosisError' in run, false);
  });
  // Out of budget during scoring.
  await withSetup(
    {
      config: { mentor: { maxTokensPerDay: 12000, maxOutputTokens: 10 } },
      llm: fakeLlm({ scoreFor: overallBySituation(3, 3), usageFor: (kind) => (kind === 'score' ? { prompt_tokens: 11000, completion_tokens: 0 } : USAGE) }),
    },
    async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      assert.equal(run.stopped, 'budget');
      assert.equal(llm.kinds().includes('diagnose'), false);
      assert.equal('diagnosisError' in run, false);
    },
  );
});

test('check: never asks for a diagnosis', () => {
  let failing = false;
  const llm = fakeLlm({ scoreFor: () => (failing ? score(3) : score(9)) });
  return withSetup({ llm }, async ({ mentor, cases }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    failing = true;
    llm.calls.length = 0;
    const runs = await (await mentor.check()).done;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].passed, false);
    assert.deepEqual(llm.kinds(), ['talk', 'talk', 'score', 'score']);
    assert.equal('diagnosis' in runs[0], false);
    assert.equal('diagnosisError' in runs[0], false);
  });
});

// ---- stop, status and check --------------------------------------------------

test('stop: aborts the request in flight', () => {
  let reached;
  const inFlight = new Promise((resolve) => (reached = resolve));
  const llm = fakeLlm({
    hook: (call) => {
      if (call.kind !== 'talk') return undefined;
      reached();
      return new Promise((resolve, reject) => {
        call.options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  });
  return withSetup({ llm }, async ({ mentor, cases, sent }) => {
    assert.deepEqual(mentor.stop(), { ok: false });
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const { done } = await mentor.run(item.id);
    await inFlight;
    assert.equal(mentor.status().running, true);
    assert.deepEqual(mentor.stop(), { ok: true });
    const run = await done;
    assert.equal(run.stopped, 'owner');
    assert.equal(run.passed, false);
    assert.deepEqual(llm.kinds(), ['situations', 'talk']);
    assert.equal(sent.length, 1);
    assert.equal(cases.lastRun(GUILD, item.id).stopped, 'owner');
    assert.equal(mentor.isRunning(), false);
    assert.equal(mentor.status().running, false);
  });
});

test('waitIdle: resolves when the run ends', () => {
  let reached;
  const inFlight = new Promise((resolve) => (reached = resolve));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const llm = fakeLlm({
    hook: async (call) => {
      if (call.kind !== 'talk') return undefined;
      reached();
      await held;
      return undefined;
    },
  });
  return withSetup({ llm }, async ({ mentor, cases }) => {
    // Nothing runs: resolves at once.
    await mentor.waitIdle();

    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const { done } = await mentor.run(item.id);
    await inFlight;
    let idle = false;
    const waiting = mentor.waitIdle().then(() => (idle = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idle, false, 'a run is still in flight');

    release();
    await waiting;
    assert.equal(mentor.isRunning(), false);
    const run = await done;
    assert.equal(run.passed, true);
  });
});

test('check: skips a case that has never been run', () =>
  withSetup({}, async ({ mentor, cases, llm, sent }) => {
    const ran = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(ran.id)).done;
    const never = cases.add(GUILD, { text: 'The persona never repeats itself.', target: 'reply' });
    llm.calls.length = 0;
    const started = await mentor.check();
    assert.equal(started.started, true);
    assert.equal(started.cases, 1);
    const runs = await started.done;
    assert.equal(runs.length, 1);
    // No situations request: the stored situations are reused, one sample each.
    assert.deepEqual(llm.kinds(), ['talk', 'talk', 'score', 'score']);
    const check = cases.lastRun(GUILD, ran.id);
    assert.equal(check.kind, 'check');
    assert.equal(check.situations.length, 2);
    assert.equal(cases.lastRun(GUILD, never.id), null);
    assert.equal(sent.length, 2);
    assert.match(sent[1].content, new RegExp(`case ${ran.id}: passed`));
    assert.match(sent[1].content, new RegExp(`case ${never.id}: skipped \\(never run\\)`));
    assert.equal(sent[1].files.length, 1);
  }));

test('check: refuses when no case has a run', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await assert.rejects(mentor.check(), /no case/);
    assert.equal(llm.calls.length, 0);
    assert.equal(mentor.isRunning(), false);
  }));

/** A case with `target: 'memory'` as an earlier version stored it, appended to cases.json. */
function addOldMemoryCase(dir) {
  const file = path.join(dir, 'guilds', GUILD, 'mentor', 'cases.json');
  let data = { nextId: 1, cases: [] };
  if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  const item = { id: data.nextId, text: 'Remember the pet named Héloïse.', target: 'memory', state: 'new', createdAt: new Date(NOW).toISOString(), lastRunId: null, lastScore: null };
  data.cases.push(item);
  data.nextId += 1;
  fs.writeFileSync(file, JSON.stringify(data));
  return item;
}

test('run / check: an old stored case with target memory is named unsupported, never measured, never a crash', () =>
  withSetup({}, async ({ mentor, cases, llm, sent, dir }) => {
    const old = addOldMemoryCase(dir);
    await assert.rejects(mentor.run(old.id), new RegExp(`case ${old.id} has an unsupported target: memory`));
    assert.equal(llm.calls.length, 0);
    assert.equal(mentor.isRunning(), false);
    // Alone, it leaves a check nothing to do.
    await assert.rejects(mentor.check(), /no case/);

    // Beside a reply case, the check measures the reply case and skips the old one by name.
    const reply = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(reply.id)).done;
    const started = await mentor.check();
    assert.equal(started.cases, 1);
    const runs = await started.done;
    assert.deepEqual(runs.map((r) => r.caseId), [reply.id]);
    assert.match(sent.at(-1).content, new RegExp(`case ${old.id}: skipped \\(unsupported target: memory\\)`));
    assert.equal(cases.lastRun(GUILD, old.id), null);
    assert.ok(cases.list(GUILD).some((c) => c.id === old.id && c.target === 'memory'));
  }));

test('run: labels without mentor.intended leave the intended block out', () => {
  const { mentor: _omit, ...plain } = labels;
  return withSetup({ prompts: { labels: plain } }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.passed, true);
    const scoreCall = llm.calls.find((c) => c.kind === 'score');
    assert.doesNotMatch(scoreCall.user, /<intended>/);
    assert.match(scoreCall.user, /<rules>/);
  });
});

// ---- no admin channel ----------------------------------------------------------

test('run: without an admin channel nothing is posted and no warning is logged', () =>
  withSetup({ config: { bot: { dryRunChannelId: '' } } }, async ({ mentor, cases, sent, fetched }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const { result: run, logs } = await withCapturedLogs(async () => (await mentor.run(item.id)).done);
    assert.equal(sent.length, 0);
    assert.equal(fetched.includes(ADMIN), false);
    assert.equal(cases.lastRun(GUILD, item.id).id, run.id);
    assert.deepEqual(logs.filter((l) => l.level === 'warn' || l.level === 'error'), []);
    const saved = logs.filter((l) => l.msg === 'mentor: report not posted');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].level, 'info');
    assert.equal(saved[0].caseId, item.id);

    // A check ends the same way: saved, nothing posted, no warning.
    const checked = await withCapturedLogs(async () => (await mentor.check()).done);
    assert.equal(checked.result.length, 1);
    assert.equal(sent.length, 0);
    assert.deepEqual(checked.logs.filter((l) => l.level === 'warn' || l.level === 'error'), []);
    const checkSaved = checked.logs.filter((l) => l.msg === 'mentor: report not posted');
    assert.equal(checkSaved.length, 1);
    assert.equal(checkSaved[0].level, 'info');
    assert.equal(checkSaved[0].cases, 1);
    assert.equal(checkSaved[0].skipped, 0);
  }));

test('run: a configured channel that cannot be fetched still logs a warning', () =>
  withSetup(
    { fetchChannel: (id) => (id === ADMIN ? null : id === CHANNEL.id || id === OTHER_CHANNEL.id ? { id } : null) },
    async ({ mentor, cases, sent, fetched }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const { result: run, logs } = await withCapturedLogs(async () => (await mentor.run(item.id)).done);
      assert.equal(sent.length, 0);
      assert.ok(fetched.includes(ADMIN));
      assert.equal(cases.lastRun(GUILD, item.id).id, run.id);
      const warned = logs.filter((l) => l.msg === 'mentor: the report could not be posted');
      assert.equal(warned.length, 1);
      assert.equal(warned[0].level, 'warn');
      assert.equal(warned[0].caseId, item.id);
      assert.equal(warned[0].name, 'Error');
      assert.equal('errorName' in warned[0], false);
      assert.equal(logs.some((l) => l.msg === 'mentor: report not posted'), false);
    },
  ));

// ---- anchors: real moments of the chat ---------------------------------------

const MOMENT_TS = Date.UTC(2026, 8, 29, 18, 0, 0);

/** The snowflake of a message sent at `ts`. */
function snowflakeAt(ts) {
  return ((BigInt(ts) - 1420070400000n) << 22n).toString();
}

/** A stored message of a moment, normalized as src/discord/collect.js#normalizeMessage gives it. */
function storedMessage(n, authorId, content, extra = {}) {
  const names = { [SELF_ID]: 'Zoë', [ALICE]: 'Alice', [BRUNO]: 'Bruno' };
  const ts = MOMENT_TS + n * 60_000;
  return {
    id: snowflakeAt(ts),
    channelId: OTHER_CHANNEL.id,
    channelName: 'games',
    channelCategory: 'Talk',
    channelTopic: null,
    authorId,
    authorName: names[authorId],
    self: authorId === SELF_ID,
    bot: false,
    content,
    ts,
    mentionedUserIds: [],
    replyToId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
    ...extra,
  };
}

let momentCount = 0;

/** A resolved moment: Bruno opens, the persona says something, Alice argues back at length (the trigger); `older` long messages before. */
function moment(marker, { older = 0 } = {}) {
  const filler = Array.from({ length: older }, (_, i) => storedMessage(i - older - 3, BRUNO, `${marker} OLD_${i} ${'x'.repeat(700)}`));
  const history = [
    ...filler,
    storedMessage(0, BRUNO, `${marker} opening`),
    storedMessage(1, SELF_ID, `${marker} her earlier line`),
    storedMessage(2, ALICE, `${marker} TRIGGER ${'é'.repeat(600)}`, { replyToId: snowflakeAt(MOMENT_TS + 60_000) }),
  ];
  return {
    channelId: OTHER_CHANNEL.id,
    // Each moment is its own message of the persona: never the same id twice.
    messageId: snowflakeAt(MOMENT_TS + 3 * 60_000 + (momentCount += 1) * 1000),
    triggerId: history.at(-1).id,
    history,
    original: [`${marker} you are right, but`, `${marker} no`],
  };
}

/** A reply case with the given moments. */
function anchoredCase(cases, markers, options) {
  const [first, ...rest] = markers;
  const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply', anchor: moment(first, options) });
  for (const marker of rest) cases.addAnchor(GUILD, item.id, moment(marker, options), { max: 5 });
  return cases.get(GUILD, item.id);
}

/** The score request whose `<answers>` belong to situation `n`. */
function scoreCallOf(llm, n) {
  return llm.calls.find((c) => c.kind === 'score' && idsIn(c.user)[0]?.startsWith(`s${n}a`));
}

test('run: every anchor is a situation of its own, numbered before the invented ones', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1', 'A2']);
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, undefined);
    assert.deepEqual(run.situations.map((s) => s.n), [1, 2, 3, 4]);
    assert.deepEqual(run.situations.map((s) => s.anchor), [1, 2, undefined, undefined]);
    assert.deepEqual(run.situations[0].original, ['A1 you are right, but', 'A1 no']);
    assert.equal(run.situations[0].lines, undefined);
    assert.ok(Array.isArray(run.situations[2].lines));
    assert.match(run.situations[0].transcript, /A1 TRIGGER/);
    assert.match(run.situations[0].transcript, /A1 her earlier line/);
    assert.deepEqual(run.situations[0].answers.map((a) => a.id), ['s1a1', 's1a2']);
    // 1 situations request, 4 situations x 2 samples, 4 score requests.
    assert.deepEqual(llm.kinds(), ['situations', ...Array(8).fill('talk'), 'score', 'score', 'score', 'score']);
    // The anchor is answered from its stored messages.
    const talk = llm.calls.filter((c) => c.kind === 'talk');
    assert.match(talk[0].user, /A1 TRIGGER/);
    assert.doesNotMatch(talk[0].user, /A2 TRIGGER|are you out of drawings/);
    assert.match(talk[2].user, /A2 TRIGGER/);
    assert.match(talk[4].user, /are you out of drawings today\?/);
    assert.equal(run.situationMedians.length, 4);
  }));

test('run: the situations request shows the anchors as <examples>, last', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1', 'A2']);
    await (await mentor.run(item.id)).done;
    const { user } = llm.calls.find((c) => c.kind === 'situations');
    assert.ok(user.endsWith('</examples>'));
    const examples = blockBody(user, 'examples');
    assert.ok(examples.startsWith(`${labels.mentor.examples}\n<example>\n`));
    assert.equal(examples.match(/<example>/g).length, 2);
    assert.match(examples, /<situation>\n[\s\S]*A1 TRIGGER[\s\S]*\n<\/situation>\n<original>\nA1 you are right, but\nA1 no\n<\/original>/);
    assert.match(examples, /A2 TRIGGER[\s\S]*<original>\nA2 you are right, but\nA2 no\n<\/original>\n<\/example>$/);
    // A case without anchors has no examples.
    llm.calls.length = 0;
    const plain = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(plain.id)).done;
    assert.doesNotMatch(llm.calls.find((c) => c.kind === 'situations').user, /<examples>|<example>/);
  }));

test('run: the score request of an anchor carries <original>, the invented ones do not', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1']);
    await (await mentor.run(item.id)).done;
    const anchored = scoreCallOf(llm, 1).user;
    assert.equal(blockBody(anchored, 'original'), `${labels.mentor.original}\nA1 you are right, but\nA1 no`);
    const order = ['case', 'rules', 'situation', 'original', 'answers', 'facts'];
    const positions = order.map((tag) => anchored.indexOf(`<${tag}>`));
    assert.ok(positions.every((p) => p >= 0), JSON.stringify(positions));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.match(blockBody(anchored, 'situation'), /A1 TRIGGER/);
    for (const n of [2, 3]) assert.doesNotMatch(scoreCallOf(llm, n).user, /<original>/, `situation ${n}`);
    assert.ok(!llm.calls.find((c) => c.kind === 'situations').user.includes(labels.mentor.original));
  }));

/** Scores with the `[overall, goal]` pair of the answer's situation. */
function pairsBySituation(...pairs) {
  return (id) => {
    const [overall, goal] = pairs[Number(/^s(\d+)/.exec(id)[1]) - 1];
    return { ...score(overall), goal };
  };
}

test('run: an anchor at 6/6 fails the run; an invented situation at 6/6 passes the floor', () =>
  withSetup(
    { config: { mentor: { situations: 3 } }, llm: fakeLlm({ situations: THREE, scoreFor: pairsBySituation([6, 6], [6, 6], [9, 9], [9, 9]) }) },
    async ({ mentor, cases }) => {
      const item = anchoredCase(cases, ['A1']);
      const run = await (await mentor.run(item.id)).done;
      assert.deepEqual(run.situations.map((s) => s.anchor), [1, undefined, undefined, undefined]);
      // Over all answers the medians pass: only the real moment fails the run.
      assert.equal(run.medians.overall, 7.5);
      assert.equal(run.medians.goal, 7.5);
      assert.deepEqual(run.situationMedians[1], { n: 2, overall: 6, goal: 6 });
      assert.equal(run.passed, false);
      assert.deepEqual(run.reasons, ['real moment 1: overall 6 is under the pass score 7', 'real moment 1: goal 6 is under the pass score 7']);
    },
  ));

test('run: mentor.pass.anchorScore overrides the pass score for anchors, read at the moment of use', () =>
  withSetup(
    { config: { mentor: { pass: { score: 7, floor: 5, anchorScore: 8 } } }, llm: fakeLlm({ scoreFor: pairsBySituation([7, 8], [9, 9], [9, 9]) }) },
    async ({ mentor, cases, hot }) => {
      const item = anchoredCase(cases, ['A1']);
      const strict = await (await mentor.run(item.id)).done;
      assert.equal(strict.passed, false);
      assert.deepEqual(strict.reasons, ['real moment 1: overall 7 is under the anchor score 8']);
      hot.config.mentor.pass.anchorScore = null;
      const same = await (await mentor.run(item.id)).done;
      assert.equal(same.passed, true);
      assert.deepEqual(same.reasons, []);
    },
  ));

test('run: an anchor is answered mentor.anchor.samples times, an invented situation mentor.samples times', () =>
  withSetup({ config: { mentor: { samples: 2, anchor: { samples: 3 } } } }, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1']);
    const run = await (await mentor.run(item.id)).done;
    assert.deepEqual(
      run.situations.map((s) => s.answers.map((a) => a.id)),
      [['s1a1', 's1a2', 's1a3'], ['s2a1', 's2a2'], ['s3a1', 's3a2']],
    );
    const talk = llm.calls.filter((c) => c.kind === 'talk');
    assert.equal(talk.length, 7);
    for (const call of talk.slice(0, 3)) assert.match(call.user, /A1 TRIGGER/);
    for (const call of talk.slice(3)) assert.doesNotMatch(call.user, /A1 TRIGGER/);
  }));

test('check: an anchor is answered mentor.anchor.samples times, an invented situation mentor.check.samples times', () =>
  withSetup({ config: { mentor: { check: { samples: 1 }, anchor: { samples: 3 } } } }, async ({ mentor, cases, hot }) => {
    const item = anchoredCase(cases, ['A1']);
    await (await mentor.run(item.id)).done;
    // Read at the moment of use.
    hot.config.mentor.anchor.samples = 4;
    const [checked] = await (await mentor.check()).done;
    assert.equal(checked.caseId, item.id);
    assert.deepEqual(checked.situations.map((s) => s.answers.length), [4, 1, 1]);
  }));

test('run: a case with anchors still runs when no invented situation is valid', () =>
  withSetup({ llm: fakeLlm({ situations: { situations: [] } }) }, async ({ mentor, cases }) => {
    const item = anchoredCase(cases, ['A1']);
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, undefined);
    assert.deepEqual(run.situations.map((s) => s.anchor), [1]);
    assert.equal(run.passed, true);
  }));

test('run: an anchor over the request budget loses its oldest messages, never the trigger', () =>
  withSetup({ config: { mentor: { situations: 1 } } }, async ({ mentor, cases, llm, hot }) => {
    const item = anchoredCase(cases, ['A1'], { older: 30 });
    hot.config.llm.maxRequestTokens = 4000;
    const { result: run, logs } = await withCapturedLogs(async () => (await mentor.run(item.id)).done);
    assert.equal(run.error, undefined);
    const situations = llm.calls.find((c) => c.kind === 'situations');
    const anchored = scoreCallOf(llm, 1);
    for (const call of [situations, anchored]) {
      assert.match(call.user, /A1 TRIGGER/);
      assert.match(call.user, /A1 OLD_29 /);
      assert.doesNotMatch(call.user, /A1 OLD_0 /);
      assert.ok(estimateMessages(call.messages) <= 4000, `${call.kind}: ${estimateMessages(call.messages)}`);
    }
    // The stored transcript keeps every message; the logs carry counts only.
    assert.match(run.situations[0].transcript, /A1 OLD_0 /);
    const trimmed = logs.filter((l) => /trimmed to the request budget/.test(l.msg));
    assert.ok(trimmed.length >= 2);
    assert.ok(trimmed.every((l) => Number.isInteger(l.dropped) && l.dropped > 0));
    assert.ok(!JSON.stringify(logs).includes('A1 OLD'), 'no message content in the logs');
  }));

test('check: replays the anchors of a case, then the invented situations of its last run', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const ran = anchoredCase(cases, ['A1']);
    await (await mentor.run(ran.id)).done;
    // A moment added after the run is replayed too; a case with a moment and no run is checked as well.
    cases.addAnchor(GUILD, ran.id, moment('A2'), { max: 5 });
    const fresh = anchoredCase(cases, ['B1']);
    llm.calls.length = 0;
    const started = await mentor.check();
    assert.equal(started.cases, 2);
    const runs = await started.done;
    assert.equal(llm.kinds().includes('situations'), false);
    const [first, second] = runs;
    assert.equal(first.kind, 'check');
    assert.deepEqual(first.situations.map((s) => s.anchor), [1, 2, undefined, undefined]);
    assert.match(first.situations[1].transcript, /A2 TRIGGER/);
    assert.equal(second.caseId, fresh.id);
    assert.deepEqual(second.situations.map((s) => s.anchor), [1]);
    assert.match(scoreCallOf(llm, 1).user, /<original>/);
  }));

test('run: <worst> is the lowest situation, even when a weak anchor scores higher', async () => {
  // The anchor is weak (5) but an invented situation is worse (2, goal 0): the invented one is diagnosed.
  const scoreFor = (id) => (id.startsWith('s2') ? { ...score(2), goal: 0 } : score(id.startsWith('s1') ? 5 : 9));
  await withSetup({ llm: fakeLlm({ scoreFor }) }, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1']);
    await (await mentor.run(item.id)).done;
    const diagnose = llm.calls.at(-1);
    assert.equal(diagnose.kind, 'diagnose');
    const worst = JSON.parse(blockBody(diagnose.user, 'worst'));
    assert.equal(worst.n, 2);
    assert.doesNotMatch(worst.transcript, /A1 TRIGGER/);
    const talk = llm.calls.filter((c) => c.kind === 'talk')[2];
    assert.ok(blockBody(diagnose.user, 'seen').includes(`<user>\n${talk.user}\n</user>`));
  });
  // The anchor is the lowest: it is diagnosed, from its stored messages.
  await withSetup({ llm: fakeLlm({ scoreFor: overallBySituation(3, 6, 9) }) }, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1']);
    await (await mentor.run(item.id)).done;
    const worst = JSON.parse(blockBody(llm.calls.at(-1).user, 'worst'));
    assert.equal(worst.n, 1);
    assert.match(worst.transcript, /A1 TRIGGER/);
  });
  // A tie on overall goes to the lower goal: here the invented situation, after the anchor.
  const tied = (id) => (id.startsWith('s1') ? { ...score(4), goal: 5 } : id.startsWith('s2') ? { ...score(4), goal: 2 } : score(9));
  await withSetup({ llm: fakeLlm({ scoreFor: tied }) }, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1']);
    await (await mentor.run(item.id)).done;
    assert.equal(JSON.parse(blockBody(llm.calls.at(-1).user, 'worst')).n, 2);
  });
});

test('worstSituation: the lowest median overall wins, whatever its kind', () => {
  const medians = [
    { n: 1, overall: 5, goal: 5 },
    { n: 2, overall: 2, goal: 0 },
    { n: 3, overall: 9, goal: 9 },
  ];
  assert.equal(worstSituation(medians, new Set([1])).n, 2);
  assert.equal(worstSituation(medians, new Set([3])).n, 2);
  assert.equal(worstSituation(medians).n, 2);
  assert.equal(worstSituation([]), null);
  assert.equal(worstSituation(undefined), null);
  assert.equal(worstSituation([{ n: 1, overall: null, goal: 3 }]), null);
});

test('worstSituation: ties go to the lower goal, then to an anchor, then to the lower n', () => {
  // The lower median goal first, whatever the kind and the order.
  assert.equal(worstSituation([{ n: 1, overall: 4, goal: 6 }, { n: 2, overall: 4, goal: 3 }], new Set([1])).n, 2);
  // A known goal is lower than a missing one.
  assert.equal(worstSituation([{ n: 1, overall: 4, goal: null }, { n: 2, overall: 4, goal: 6 }]).n, 2);
  // Same overall and goal: an anchor before an invented situation.
  assert.equal(worstSituation([{ n: 1, overall: 4, goal: 3 }, { n: 2, overall: 4, goal: 3 }], new Set([2])).n, 2);
  // Same overall, goal and kind: the lower n.
  assert.equal(worstSituation([{ n: 2, overall: 4, goal: 3 }, { n: 1, overall: 4, goal: 3 }]).n, 1);
  assert.equal(worstSituation([{ n: 3, overall: 4, goal: 3 }, { n: 2, overall: 4, goal: 3 }], new Set([2, 3])).n, 2);
});

test('readAnchor: reads mentor.anchor.contextMessages and the media settings at the moment of use', () => {
  const asked = [];
  const channel = { id: OTHER_CHANNEL.id, guild: { id: GUILD } };
  const fetchMoment = async (ch, messageId, options) => {
    asked.push({ ch, messageId, options });
    return { messageId, triggerId: 'x', history: moment('M').history, burst: [{ content: 'M you are right, but' }, { content: '' }] };
  };
  return withSetup(
    { config: { mentor: { anchor: { contextMessages: 12 } } }, fetchChannel: (id) => (id === OTHER_CHANNEL.id ? channel : null), fetchMoment },
    async ({ mentor, hot, llm }) => {
      // A bare id is looked up in the channel the command was typed in.
      const anchor = await mentor.readAnchor(snowflakeAt(MOMENT_TS), { channelId: OTHER_CHANNEL.id });
      assert.equal(anchor.channelId, OTHER_CHANNEL.id);
      assert.deepEqual(anchor.original, ['M you are right, but']);
      assert.equal(asked[0].ch, channel);
      assert.deepEqual(asked[0].options, { selfId: SELF_ID, limit: 12, embedTextChars: 300, videoSites: undefined });
      hot.config.mentor.anchor.contextMessages = 7;
      await mentor.readAnchor(snowflakeAt(MOMENT_TS), { channelId: OTHER_CHANNEL.id });
      assert.equal(asked[1].options.limit, 7);
      assert.equal(llm.calls.length, 0, 'reading a moment spends nothing');
      await assert.rejects(mentor.readAnchor(`https://discord.com/channels/@me/${OTHER_CHANNEL.id}/${snowflakeAt(MOMENT_TS)}`), /direct message/);
    },
  );
});

// ---- a real moment shows the media as the persona saw them -------------------------

const CLIP_ID = '810000000000000001';
const PICTURE_ID = '810000000000000002';
const CLIP_SUMMARY = 'a cat knocks a cup off the table';
const WATCHED_LINE = /\[video: clip\.mp4, 0:12, watched: a cat knocks a cup off the table\]/;

/**
 * A moment whose opening message carries a clip and a picture; `seen` stores the clip's
 * watched summary with it as resolveAnchor does, without it the anchor is an older one.
 */
function clipMoment(marker, { seen = true } = {}) {
  const base = moment(marker);
  const attachments = [
    { id: CLIP_ID, kind: 'video', name: 'clip.mp4', url: `https://cdn.discordapp.com/attachments/1/${CLIP_ID}/clip.mp4`, size: 1000, durationSec: 12 },
    { id: PICTURE_ID, kind: 'image', name: 'a.png', url: `https://cdn.discordapp.com/attachments/1/${PICTURE_ID}/a.png`, size: 1000, durationSec: null },
  ];
  const mediaSeen = seen ? { mediaSeen: { watched: { [CLIP_ID]: CLIP_SUMMARY } } } : {};
  const history = base.history.map((m, i) => (i === 0 ? { ...m, attachments, ...mediaSeen } : m));
  return { ...base, history };
}

/** The describer's cache as the live turn left it: the clip watched between the trigger and her answer. */
function clipCache() {
  return deepFreeze({ [`video:${CLIP_ID}`]: { text: CLIP_SUMMARY, ts: MOMENT_TS + 2 * 60_000 + 30_000, watched: true } });
}

/** The memory store with the describer's cache; any write to that cache throws. */
function storeWithCache(cache, asked = []) {
  return {
    ...fakeMemoryStore(),
    getMediaCache: (guildId) => {
      asked.push(guildId);
      return cache;
    },
    markMediaCacheDirty: () => {
      throw new Error('the mentor never writes the media cache');
    },
  };
}

test('run: a replayed moment shows the media as she saw them, in the live transcript format', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply', anchor: clipMoment('V1') });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, undefined);
    const talk = llm.calls.filter((c) => c.kind === 'talk');
    // The persona, the stored record, the mentor's examples and the judge all see the watched summary.
    assert.match(talk[0].user, WATCHED_LINE);
    assert.match(run.situations[0].transcript, WATCHED_LINE);
    assert.match(blockBody(llm.calls.find((c) => c.kind === 'situations').user, 'examples'), WATCHED_LINE);
    assert.match(blockBody(scoreCallOf(llm, 1).user, 'situation'), WATCHED_LINE);
    // The picture had no description: its plain label, as before.
    assert.match(talk[0].user, /\[image\]/);
    // An invented situation carries no media.
    assert.doesNotMatch(talk[2].user, /clip\.mp4/);
  }));

test("run: an anchor stored without descriptions finds them in the describer's cache at replay, read only", () => {
  const asked = [];
  const cache = clipCache();
  const before = structuredClone(cache);
  return withSetup({ store: storeWithCache(cache, asked) }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply', anchor: clipMoment('V2', { seen: false }) });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, undefined);
    assert.match(llm.calls.find((c) => c.kind === 'talk').user, WATCHED_LINE);
    assert.match(run.situations[0].transcript, WATCHED_LINE);
    assert.ok(asked.length > 0 && asked.every((g) => g === GUILD));
    assert.deepEqual(cache, before, 'the cache is read, never written');
    // No describer request: only the mentor's and the persona's.
    assert.ok(llm.kinds().every((kind) => ['situations', 'talk', 'score', 'diagnose'].includes(kind)));
  });
});

test('readAnchor: the moment keeps the cached media descriptions; the log counts them, never their text', () => {
  const channel = { id: OTHER_CHANNEL.id, guild: { id: GUILD } };
  const answered = snowflakeAt(MOMENT_TS + 3 * 60_000);
  const fetchMoment = async () => ({
    messageId: answered,
    triggerId: 'x',
    history: clipMoment('R1', { seen: false }).history,
    burst: [{ content: 'R1 you are right, but' }],
  });
  const cache = clipCache();
  const before = structuredClone(cache);
  return withSetup(
    { store: storeWithCache(cache), fetchChannel: (id) => (id === OTHER_CHANNEL.id ? channel : null), fetchMoment },
    async ({ mentor, cases, llm }) => {
      const { result: anchor, logs } = await withCapturedLogs(() => mentor.readAnchor(answered, { channelId: OTHER_CHANNEL.id }));
      assert.deepEqual(anchor.history[0].mediaSeen, { watched: { [CLIP_ID]: CLIP_SUMMARY } });
      assert.ok(anchor.history.slice(1).every((m) => !('mediaSeen' in m)));
      const read = logs.find((l) => l.msg === 'mentor: moment read');
      assert.equal(read.mediaDescribed, 1);
      assert.equal(read.mediaWithout, 1);
      assert.ok(!JSON.stringify(logs).includes(CLIP_SUMMARY), 'no description in the logs');
      assert.deepEqual(cache, before, 'the cache is read, never written');
      assert.equal(llm.calls.length, 0, 'reading a moment spends nothing');
      // Stored with the case as it was resolved.
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply', anchor });
      assert.deepEqual(cases.get(GUILD, item.id).anchors[0].history[0].mediaSeen, { watched: { [CLIP_ID]: CLIP_SUMMARY } });
    },
  );
});

// ---- a real moment sees the memory as it stood at its time -----------------------

const iso = (ms) => new Date(ms).toISOString();
/** The moment's trigger is at MOMENT_TS + 2 minutes; these fall on either side of it. */
const LONG_BEFORE = iso(MOMENT_TS - 86_400_000);
const LATER = iso(MOMENT_TS + 10 * 60_000);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * A read-only memory store holding items written before the moment
 * (`..._BEFORE`) and after it (`..._AFTER`): Alice's episodes, details,
 * interests, aliases and attitude, the learned items and an `always` lore entry.
 * Its data is deep-frozen and it has no write method: any write throws.
 */
function datedMemoryStore() {
  const data = deepFreeze({
    profiles: {
      [ALICE]: {
        id: ALICE,
        names: ['Alice'],
        character: 'CHARACTER_UNDATED',
        interests: [
          { topic: 'INT_BEFORE', note: '', weight: 3, firstSeen: LONG_BEFORE, lastSeen: LONG_BEFORE },
          { topic: 'INT_AFTER', note: '', weight: 3, firstSeen: LATER, lastSeen: LATER },
        ],
        details: [
          { id: 1, text: 'DET_BEFORE', weight: 3, firstSeen: LONG_BEFORE, lastSeen: LATER },
          { id: 2, text: 'DET_AFTER', weight: 3, firstSeen: LATER, lastSeen: LATER },
        ],
        aliases: [
          { name: 'ALIAS_BEFORE', weight: 3, firstSeen: LONG_BEFORE, lastSeen: LONG_BEFORE },
          { name: 'ALIAS_AFTER', weight: 3, firstSeen: LATER, lastSeen: LATER },
        ],
        episodes: [
          { date: '2026-09-20', what: 'EP_BEFORE', quote: '', feeling: 'fine', weight: 3, addedAt: LONG_BEFORE },
          { date: '2026-09-29', what: 'EP_AFTER', quote: '', feeling: 'won the argument', weight: 5, addedAt: LATER },
        ],
        affinity: {
          score: 30,
          reason: 'REASON_AFTER',
          history: [
            { ts: LONG_BEFORE, delta: 20, appliedDelta: 20, score: 20, reason: 'REASON_BEFORE' },
            { ts: LATER, delta: 10, appliedDelta: 10, score: 30, reason: 'REASON_AFTER' },
          ],
        },
      },
      [BRUNO]: { id: BRUNO, names: ['Bruno'], interests: [], details: [], aliases: [], episodes: [], affinity: { score: 0, reason: '', history: [] } },
    },
    guild: {
      patterns: '',
      starters: '',
      injokes: [],
      self: [],
      learned: [
        { id: 1, text: 'LEARNED_BEFORE', weight: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: LATER },
        { id: 2, text: 'LEARNED_AFTER', weight: 3, firstSeen: LATER, lastSeen: LATER },
      ],
    },
    lore: [{ id: 'l1', title: 'LORE_AFTER', keys: ['lorekey'], text: 'LORE_AFTER how it ended', always: true, source: 'owner', createdAt: LATER, updatedAt: LATER }],
  });
  return {
    data,
    getGuild: () => data.guild,
    getUser: (guildId, id) => data.profiles[id] ?? null,
    getPrivate: () => {
      throw new Error('the private layer is out of bounds for the mentor');
    },
    listUserProfiles: () => Object.values(data.profiles),
    listChannels: () => [CHANNEL, OTHER_CHANNEL],
    getLore: () => data.lore,
  };
}

const LATER_MARKS = ['EP_AFTER', 'DET_AFTER', 'INT_AFTER', 'ALIAS_AFTER', 'REASON_AFTER', 'LEARNED_AFTER', 'LORE_AFTER'];
/** Seen whatever the cutoff (the attitude's reason is not among them: only the current one is shown). */
const EARLIER_MARKS = ['EP_BEFORE', 'DET_BEFORE', 'INT_BEFORE', 'ALIAS_BEFORE', 'LEARNED_BEFORE', 'CHARACTER_UNDATED'];

/** The whole request of a talk call. */
function requestText(call) {
  return `${call.system}\n${call.user}`;
}

test('run: a real moment is answered without the memory written at or after its trigger; invented situations see it all', () =>
  withSetup({ store: datedMemoryStore() }, async ({ mentor, cases, llm, store }) => {
    const snapshot = JSON.stringify(store.data);
    const item = anchoredCase(cases, ['A1']);
    const { result: run, logs } = await withCapturedLogs(async () => (await mentor.run(item.id)).done);
    assert.equal(run.error, undefined);
    const talk = llm.calls.filter((c) => c.kind === 'talk');
    // Both samples of the moment (Alice's trigger): only what was stored before it.
    for (const call of talk.slice(0, 2)) {
      const text = requestText(call);
      assert.match(text, /A1 TRIGGER/);
      for (const mark of EARLIER_MARKS) assert.ok(text.includes(mark), mark);
      for (const mark of LATER_MARKS) assert.ok(!text.includes(mark), mark);
      // The attitude's reason falls back to the last change before the trigger.
      assert.ok(text.includes('REASON_BEFORE'));
    }
    // The first invented situation (Alice's trigger too) sees everything.
    const invented = requestText(talk[2]);
    assert.match(invented, /are you out of drawings/);
    for (const mark of [...EARLIER_MARKS, ...LATER_MARKS]) assert.ok(invented.includes(mark), mark);
    // The earlier move shows too: the profile lists the moves behind the attitude (relationships.shownMoves).
    assert.ok(invented.includes('REASON_BEFORE'));
    // The judge's <learned> follows what the persona saw.
    assert.equal(blockBody(scoreCallOf(llm, 1).user, 'learned').includes('LEARNED_AFTER'), false);
    assert.match(blockBody(scoreCallOf(llm, 1).user, 'learned'), /LEARNED_BEFORE/);
    assert.match(blockBody(scoreCallOf(llm, 2).user, 'learned'), /LEARNED_AFTER/);
    // Nothing was written: the store is frozen, has no write method, and its data is unchanged.
    assert.equal(JSON.stringify(store.data), snapshot);
    // One line with counts, no contents.
    const hidden = logs.filter((l) => l.msg === 'mentor: later memory hidden');
    assert.equal(hidden.length, 1);
    const { level, msg, time, ...counts } = hidden[0];
    assert.deepEqual(counts, {
      kind: 'run',
      caseId: item.id,
      situations: 1,
      episodes: 1,
      affinity: 1,
      reasons: 1,
      details: 1,
      interests: 1,
      aliases: 1,
      learned: 1,
      lore: 1,
    });
    assert.ok(!/_AFTER|_BEFORE/.test(JSON.stringify(logs)), 'no memory content in the logs');
  }));

test('run: mentor.anchor.hideLaterMemory false answers a real moment with the whole memory', () =>
  withSetup({ store: datedMemoryStore(), config: { mentor: { anchor: { hideLaterMemory: false } } } }, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1']);
    const { logs } = await withCapturedLogs(async () => (await mentor.run(item.id)).done);
    const text = requestText(llm.calls.find((c) => c.kind === 'talk'));
    assert.match(text, /A1 TRIGGER/);
    for (const mark of [...EARLIER_MARKS, ...LATER_MARKS]) assert.ok(text.includes(mark), mark);
    assert.match(blockBody(scoreCallOf(llm, 1).user, 'learned'), /LEARNED_AFTER/);
    assert.equal(logs.some((l) => l.msg === 'mentor: later memory hidden'), false);
  }));

test('run: the diagnosis of a real moment shows in <seen> the memory it was answered with', () =>
  withSetup({ store: datedMemoryStore(), llm: fakeLlm({ scoreFor: overallBySituation(2, 9, 9) }) }, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1']);
    await (await mentor.run(item.id)).done;
    const diagnose = llm.calls.at(-1);
    assert.equal(diagnose.kind, 'diagnose');
    assert.equal(JSON.parse(blockBody(diagnose.user, 'worst')).n, 1);
    const seen = blockBody(diagnose.user, 'seen');
    assert.match(seen, /A1 TRIGGER/);
    for (const mark of EARLIER_MARKS) assert.ok(seen.includes(mark), mark);
    for (const mark of LATER_MARKS) assert.ok(!seen.includes(mark), mark);
  }));

test('check: a real moment is replayed without the memory written after it', () =>
  withSetup({ store: datedMemoryStore() }, async ({ mentor, cases, llm }) => {
    const item = anchoredCase(cases, ['A1']);
    await (await mentor.run(item.id)).done;
    llm.calls.length = 0;
    const [checked] = await (await mentor.check()).done;
    assert.equal(checked.caseId, item.id);
    const talk = llm.calls.filter((c) => c.kind === 'talk');
    assert.match(requestText(talk[0]), /A1 TRIGGER/);
    for (const mark of LATER_MARKS) assert.ok(!requestText(talk[0]).includes(mark), mark);
    // The moment's two samples (mentor.anchor.samples), then the invented situation (mentor.check.samples 1).
    assert.match(requestText(talk[1]), /A1 TRIGGER/);
    assert.ok(requestText(talk[2]).includes('EP_AFTER'));
  }));

// ---- provider routing ----------------------------------------------------------

test('run: the mentor requests are routed as the mentor role, the sandbox persona answers as the reply (role voice)', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    const mentorCalls = llm.calls.filter((c) => c.kind === 'situations' || c.kind === 'score');
    const talkCalls = llm.calls.filter((c) => c.kind === 'talk');
    assert.ok(mentorCalls.length > 0 && talkCalls.length > 0);
    for (const { options } of mentorCalls) assert.equal(options.role, 'mentor');
    for (const { options } of talkCalls) assert.deepEqual([options.role, options.purpose], ['voice', 'reply']);
  }));

// ---- parity with a live turn: custom emoji and GIFs ---------------------------

const WAVE = { id: '600000000000000001', name: 'wave', animated: false };
const GIF_LIBRARY = {
  nextId: 2,
  entries: {
    k1: { id: 'g1', kind: 'link', url: 'https://tenor.com/view/dance-1', site: 'Tenor', name: 'Danse', itemId: 'k1', messageId: 'm1', channelId: CHANNEL.id, count: 3, last: NOW - 86_400_000, firstSeen: NOW - 86_400_000 },
  },
  backfill: null,
};

/** The memory store with the guild's GIF library and the describer cache a live turn reads. */
function storeWithLists() {
  const reads = [];
  return {
    reads,
    ...fakeMemoryStore(),
    getGifs: (guildId) => (reads.push(['getGifs', guildId]), GIF_LIBRARY),
    getMediaCache: (guildId) => (reads.push(['getMediaCache', guildId]), { 'emoji:600000000000000001': { text: 'a waving hand' }, k1: { text: 'a dancing cat' } }),
  };
}

test('run: a reply sandbox gets the custom emoji, the GIF library and their captions a live turn gets; a GIF answer is not silence', () => {
  const store = storeWithLists();
  return withSetup({ store, emoji: { list: () => [WAVE] }, llm: fakeLlm({ talk: '<gif reply="#2">g1</gif>' }) }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    const talks = llm.calls.filter((c) => c.kind === 'talk');
    assert.ok(talks.length > 0);
    for (const talk of talks) {
      assert.ok(talk.user.includes(':wave: -- a waving hand'), talk.user);
      assert.ok(talk.user.includes('g1 -- a dancing cat'), talk.user);
    }
    assert.ok(store.reads.every(([, guildId]) => guildId === GUILD));
    for (const situation of run.situations) for (const answer of situation.answers) assert.equal(answer.silent, false);
  });
});

test('run: features.gifs off and no emoji index -> no <gifs>, no <emoji>, and a GIF answer is silence', () => {
  const store = storeWithLists();
  return withSetup({ store, config: { features: { mentor: true, gifs: false } }, llm: fakeLlm({ talk: '<gif>g1</gif>' }) }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    for (const talk of llm.calls.filter((c) => c.kind === 'talk')) {
      assert.ok(!talk.user.includes('<gifs>'));
      assert.ok(!talk.user.includes('<emoji>'));
    }
    assert.equal(store.reads.some(([name]) => name === 'getGifs'), false);
    for (const situation of run.situations) for (const answer of situation.answers) assert.equal(answer.silent, true);
  });
});

// ---- small rules -----------------------------------------------------------------

test('run: the budget pre-check measures a request as the llm rail does, calibrated', () =>
  withSetup({ calibrator: { ratio: 10000, apply: (n) => n * 10000 } }, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.stopped, 'budget');
    assert.equal(llm.calls.length, 0, 'the raw estimate would have fitted; the calibrated one does not');
  }));

test('run: the situations prompt is filled with the numbers the parser uses, the config.json values when the keys are unusable', () =>
  withSetup({ config: { mentor: { situations: undefined, situationLines: 'many' } } }, async ({ mentor, cases, llm }) => {
    const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).mentor;
    const [minLines, maxLines] = shipped.situationLines;
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    assert.equal(llm.calls[0].kind, 'situations');
    assert.equal(llm.calls[0].system, `SITUATIONS for Zoë: ${shipped.situations} of ${minLines}-${maxLines} lines. {{unknown}}`);
  }));

test('run: a diagnosis the budget cannot pay for is named as the report names that stop', () =>
  withSetup(
    {
      config: { mentor: { maxTokensPerDay: 11000, maxOutputTokens: 10 } },
      llm: fakeLlm({ scoreFor: overallBySituation(9, 3), usageFor: (kind) => (kind === 'score' ? { prompt_tokens: 5000, completion_tokens: 0 } : USAGE) }),
    },
    async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const { result: run } = await withCapturedLogs(async () => (await mentor.run(item.id)).done);
      assert.equal(run.stopped, undefined);
      assert.equal(llm.kinds().includes('diagnose'), false);
      assert.equal(run.diagnosis, null);
      assert.equal(run.diagnosisError, 'stopped: the mentor daily token budget ran out');
    },
  ));

// ---- the store reads, GIFs and drawings, <senses>, the layers ------------------

/**
 * A store that has the mentor's reads and nothing else: any other name throws,
 * as a tool's read-only store refuses it.
 */
function onlyMentorReads(base) {
  const allowed = new Set(MENTOR_STORE_READS);
  const methods = Object.fromEntries(MENTOR_STORE_READS.filter((name) => typeof base[name] === 'function').map((name) => [name, base[name]]));
  return new Proxy(methods, {
    get(target, name) {
      if (typeof name === 'string' && !allowed.has(name)) throw new Error(`the memory store is read-only here (${name} refused)`);
      return target[name];
    },
  });
}

test('MENTOR_STORE_READS: a run over a store with only those methods completes with GIFs on', () => {
  const base = storeWithLists();
  const store = onlyMentorReads({ ...base, getRecent: () => null });
  return withSetup({ store, llm: fakeLlm({ talk: '<gif>g1</gif>' }) }, async ({ mentor, cases }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    assert.equal(run.error, undefined);
    assert.equal(run.passed, true);
    assert.ok(base.reads.some(([name]) => name === 'getGifs'), 'GIFs are on: the library is read');
    assert.ok(run.situations.every((s) => s.answers.every((a) => a.gif?.handle === 'g1')));
  });
});

test('run: a GIF-only answer reaches the judge, the record and the report with its handle and caption', () =>
  withSetup({ store: storeWithLists(), llm: fakeLlm({ talk: '<gif reply="#2">g1</gif>' }) }, async ({ mentor, cases, llm, sent }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    const run = await (await mentor.run(item.id)).done;
    const answer = run.situations[0].answers[0];
    assert.deepEqual(answer.messages, []);
    assert.equal(answer.silent, false);
    assert.deepEqual(answer.gif, { handle: 'g1', caption: 'a dancing cat' });
    const shown = JSON.parse(blockBody(llm.calls.find((c) => c.kind === 'score').user, 'answers'));
    assert.deepEqual(shown[0], { id: 's1a1', messages: [], reactions: [], silent: false, gif: { handle: 'g1', caption: 'a dancing cat' } });
    assert.match(sent[0].files[0].attachment.toString('utf8'), /^gif: g1 \(a dancing cat\)$/m);
  }));

test('run: a drawing reaches the judge as its text; an answer without GIF or drawing shows neither key', () =>
  withSetup(
    { config: { features: { mentor: true, imageGeneration: true } }, llm: fakeLlm({ talk: '<msg>look</msg><draw>a café at night</draw>' }) },
    async ({ mentor, cases, llm, sent }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      const run = await (await mentor.run(item.id)).done;
      assert.equal(run.situations[0].answers[0].draw, 'a café at night');
      assert.equal('gif' in run.situations[0].answers[0], false);
      const shown = JSON.parse(blockBody(llm.calls.find((c) => c.kind === 'score').user, 'answers'));
      assert.deepEqual(shown[0], { id: 's1a1', messages: ['look'], reactions: [], silent: false, draw: 'a café at night' });
      assert.match(sent[0].files[0].attachment.toString('utf8'), /^draw: a café at night$/m);
    },
  ));

test('run: a library GIF in a real moment carries its handle in the judge <situation>; with GIFs off it does not', async () => {
  const gifLink = { id: 'k1', kind: 'gif', url: 'https://tenor.com/view/dance-1', site: 'Tenor', title: 'Danse' };
  const withGif = (cases) => {
    const stored = moment('G1');
    stored.history[0] = { ...stored.history[0], links: [gifLink] };
    return cases.add(GUILD, { text: CASE_TEXT, target: 'reply', anchor: stored });
  };
  for (const gifs of [true, false]) {
    await withSetup({ store: storeWithLists(), config: { features: { mentor: true, gifs } } }, async ({ mentor, cases, llm }) => {
      const item = withGif(cases);
      await (await mentor.run(item.id)).done;
      const situation = blockBody(scoreCallOf(llm, 1).user, 'situation');
      assert.equal(/\[gif g1: /.test(situation), gifs, situation);
    });
  }
});

test('run: the sandbox request of a configured main channel names it in <senses>, from the stored channel without a guild', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
    await (await mentor.run(item.id)).done;
    const line = fill(labels.senses.elsewhere, { destination: CHANNEL.name });
    const talks = llm.calls.filter((c) => c.kind === 'talk');
    assert.ok(talks.length > 0);
    for (const talk of talks) assert.ok(talk.user.includes(line), talk.user);
  }));

/** The guild of this instance as the gateway client holds it, its main channel usable or not. */
function liveGuild({ canSend = true } = {}) {
  const channel = {
    id: CHANNEL.id,
    name: 'live-general',
    viewable: true,
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => canSend }),
  };
  const guild = { id: GUILD, members: { me: { id: SELF_ID } }, channels: { cache: new Map([[CHANNEL.id, channel]]) } };
  channel.guild = guild;
  return { cache: new Map([[GUILD, guild]]) };
}

test('run: with the guild at hand, <senses> names the destination a live turn resolves; none when it is not usable or elsewhere is off', async () => {
  const variants = [
    { guilds: liveGuild(), features: { mentor: true }, expected: 'live-general' },
    { guilds: liveGuild({ canSend: false }), features: { mentor: true }, expected: null },
    { guilds: undefined, features: { mentor: true, elsewhere: false }, expected: null },
  ];
  for (const { guilds, features, expected } of variants) {
    await withSetup({ guilds, config: { features } }, async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      await (await mentor.run(item.id)).done;
      const talk = llm.calls.find((c) => c.kind === 'talk');
      const prefix = labels.senses.elsewhere.split('{destination}')[0];
      if (expected) assert.ok(talk.user.includes(fill(labels.senses.elsewhere, { destination: expected })), talk.user);
      else assert.ok(!talk.user.includes(prefix), talk.user);
    });
  }
});

test('run: a wired lookup with a search key gives the sandbox the search line of <senses>; never a search', async () => {
  for (const { lookup, expected } of [
    { lookup: { hasSearch: () => true, search: () => assert.fail('no search in a sandbox') }, expected: true },
    { lookup: { hasSearch: () => false }, expected: false },
    { lookup: undefined, expected: false },
  ]) {
    await withSetup({ lookup, config: { features: { mentor: true, webLookup: true } } }, async ({ mentor, cases, llm }) => {
      const item = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
      await (await mentor.run(item.id)).done;
      const talk = llm.calls.find((c) => c.kind === 'talk');
      assert.equal(talk.user.includes(labels.senses.search), expected);
    });
  }
});

