// Tests for src/mentor/mentor.js: one mentor run end to end against fakes --
// a fake llm that answers by looking at the request, a fake Discord client
// whose admin channel records what is sent, a fake memory store and a real
// case store in a temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMentor } from '../src/mentor/mentor.js';
import { createCaseStore } from '../src/mentor/cases.js';
import { createMentorBudget } from '../src/mentor/budget.js';
import { TokenLimitError } from '../src/llm/openrouter.js';
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
    llm: { model: 'x/talk', maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
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
    'mentor-situations-memory': 'SITUATIONS-MEMORY for {{name}}: {{count}}',
    'mentor-score': 'SCORE for {{name}}',
    'mentor-score-memory': 'SCORE-MEMORY for {{name}}',
    'mentor-signs': 'SIGNS FOR {{name}}',
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

const MEMORY_ANSWER = JSON.stringify({ users: { [ALICE]: { character: 'Asks about limits.' } }, guild: { patterns: 'Short greetings.' } });

/** The answer ids listed in the `<answers>` or `<stored>` block of a score request. */
function idsIn(user) {
  const match = /<(answers|stored)>\n([\s\S]*?)\n<\/\1>/.exec(user);
  return match ? JSON.parse(match[2]).map((a) => a.id) : [];
}

function score(overall = 8) {
  return { human: 8, character: 8, rules: 8, goal: 8, overall, comment: 'natural and short' };
}

/**
 * A fake llm that answers by looking at the request: the mentor model by its
 * system text (situations or score), the analyzer by its model, else the talk
 * model. `hook` may return a result (or a promise) to answer a call itself.
 */
function fakeLlm({ situations = SITUATIONS, scoreFor = () => score(), talk = '<msg>ναι, the limit is reached</msg>', usage = USAGE, usageFor, hook } = {}) {
  const calls = [];
  return {
    calls,
    kinds: () => calls.map((c) => c.kind),
    async complete(messages, options = {}) {
      const system = messages[0].content;
      const user = messages[1].content;
      let kind = 'talk';
      if (options.model === 'x/mentor') kind = system.startsWith('SITUATIONS') ? 'situations' : 'score';
      else if (options.model === 'x/memory') kind = 'memory';
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
      } else if (kind === 'memory') text = MEMORY_ANSWER;
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

function setup({ config = {}, prompts = {}, llm = fakeLlm(), sendFails = false, fetchChannel, windowFor } = {}) {
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
  };
  const windows = [];
  const fetchHistoryWindow = async (channel, options) => {
    windows.push({ channel, options });
    return windowFor ? windowFor(channel) : reference();
  };
  const mentor = createMentor({
    hot,
    store: fakeMemoryStore(),
    llm,
    client,
    cases,
    budget,
    getGuildId: () => GUILD,
    getSelf: () => ({ id: SELF_ID, name: 'Zoë' }),
    fetchHistoryWindow,
    now,
    rng: () => 0,
  });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { mentor, cases, hot, llm, budget, state, sent, fetched, windows, cleanup };
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
  withSetup({ prompts: { 'mentor-score-memory': undefined } }, async ({ mentor, cases, llm, hot }) => {
    await assert.rejects(mentor.run(42), /case 42/);
    const memoryCase = cases.add(GUILD, { text: CASE_TEXT, target: 'memory' });
    await assert.rejects(mentor.run(memoryCase.id), /mentor prompt missing: mentor-score-memory/);
    const replyCase = cases.add(GUILD, { text: CASE_TEXT, target: 'reply' });
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
    assert.deepEqual(run.models, { mentor: 'x/mentor', talk: 'x/talk', analyzer: 'x/memory' });
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

test('run: clearing mentor.model never sends a request to the talk model', () => {
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
    assert.match(card, new RegExp(`case ${second.id}: skipped \\(the mentor was disabled\\)`));
  });
});

test('run: a memory case goes through answerMemory', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'memory' });
    const run = await (await mentor.run(item.id)).done;
    assert.deepEqual(llm.kinds(), ['situations', 'memory', 'memory', 'memory', 'memory', 'score', 'score']);
    assert.match(llm.calls[0].system, /^SITUATIONS-MEMORY for Zoë: 2/);
    const scoreCall = llm.calls.find((c) => c.kind === 'score');
    assert.equal(scoreCall.system, 'SCORE-MEMORY for Zoë');
    assert.doesNotMatch(scoreCall.user, /<character>|<answers>/);
    const stored = JSON.parse(/<stored>\n([\s\S]*?)\n<\/stored>/.exec(scoreCall.user)[1]);
    assert.equal(stored[0].id, 's1a1');
    assert.ok(stored[0].texts.some((t) => t.text === 'Asks about limits.'));
    const answer = run.situations[0].answers[0];
    assert.equal(answer.parseOk, true);
    assert.ok(answer.texts.some((t) => t.path === 'guild.patterns'));
    assert.equal(answer.messages, undefined);
    assert.deepEqual(run.repeated, []);
    assert.equal(run.passed, true);
  }));

test('run: <stored> tells the judge when an analyzer answer did not parse', () => {
  let memoryCalls = 0;
  const llm = fakeLlm({
    hook: (call) => {
      if (call.kind === 'memory' && (memoryCalls += 1) === 1) return { text: 'I would store nothing here.', usage: USAGE, estimated: 90 };
      return undefined;
    },
  });
  return withSetup({ llm }, async ({ mentor, cases }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'memory' });
    await (await mentor.run(item.id)).done;
    const scoreCall = llm.calls.find((c) => c.kind === 'score');
    const stored = JSON.parse(/<stored>\n([\s\S]*?)\n<\/stored>/.exec(scoreCall.user)[1]);
    assert.deepEqual(stored[0], { id: 's1a1', texts: [], parseOk: false });
    assert.equal(stored[1].id, 's1a2');
    assert.equal(stored[1].parseOk, true);
    assert.ok(stored[1].texts.length > 0);
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

test('run: a memory case carries <signs> in both of its requests', () =>
  withSetup({}, async ({ mentor, cases, llm }) => {
    const item = cases.add(GUILD, { text: CASE_TEXT, target: 'memory' });
    await (await mentor.run(item.id)).done;
    const situations = llm.calls.find((c) => c.kind === 'situations');
    const scoreCall = llm.calls.find((c) => c.kind === 'score');
    assert.ok(situations.user.includes(SIGNS_AFTER_SAMPLES), situations.user);
    assert.ok(scoreCall.user.includes(SIGNS_AFTER_SAMPLES), scoreCall.user);
  }));

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
    const saved = logs.filter((l) => l.msg === 'mentor: report saved');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].level, 'info');
    assert.equal(saved[0].caseId, item.id);

    // A check ends the same way: saved, nothing posted, no warning.
    const checked = await withCapturedLogs(async () => (await mentor.check()).done);
    assert.equal(checked.result.length, 1);
    assert.equal(sent.length, 0);
    assert.deepEqual(checked.logs.filter((l) => l.level === 'warn' || l.level === 'error'), []);
    const checkSaved = checked.logs.filter((l) => l.msg === 'mentor: report saved');
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
      assert.equal(logs.some((l) => l.msg === 'mentor: report saved'), false);
    },
  ));
