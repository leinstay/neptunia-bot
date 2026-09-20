// Tests for src/behavior/prompt.js: buildRequest, the one-shot LLM request
// assembler. Uses fake prompts/config/labels only -- never reads prompts/ or
// data/. tests/fixtures/labels.js is an English fixture covering every key of
// the prompt contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, renderProfile } from '../src/behavior/prompt.js';
import { estimateTokens } from '../src/llm/tokens.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0); // Sun 20 Sep 2026, 13:00 Moscow
const MIN = 60_000;

function identityCalibrator() {
  return { ratio: 1, apply: (n) => n };
}

function fakePrompts(overrides = {}) {
  return {
    'system-prompt': 'SYSTEM_TEXT for {{name}}',
    'character-card': 'CARD_TEXT',
    rules: 'RULES_TEXT',
    format: 'FORMAT_TEXT',
    reply: 'Called by {{author}}, they {{trigger}}. Answer {{target}} as {{name}}. Target: {{target}}.',
    interject: 'INTERJECT_TASK for {{name}}',
    initiate: 'INITIATE_TASK for {{name}}',
    memory: 'MEMORY_TEXT for {{name}}',
    labels,
    ...overrides,
  };
}

function fakeConfig(overrides = {}) {
  return {
    bot: { timezone: 'Europe/Moscow' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500 },
      vision: { maxImages: 2, tokensPerImage: 1600 },
      ...overrides.context,
    },
    features: { vision: true, ...overrides.features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, ...overrides.llm },
  };
}

function makeMessage(id, ts, overrides = {}) {
  return {
    id,
    ts,
    authorId: `author-${id}`,
    authorName: `User${id}`,
    self: false,
    content: `content of message ${id}`,
    attachments: [],
    stickers: [],
    replyToId: null,
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  const history = overrides.history ?? [makeMessage(1, NOW - MIN)];
  return {
    config: fakeConfig(),
    prompts: fakePrompts(),
    calibrator: identityCalibrator(),
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history,
    neighbors: [],
    trigger: null,
    triggerKind: null,
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
}

test('buildRequest: system message is system-prompt + character-card + rules + format, joined', () => {
  const request = buildRequest(baseInput());
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[0].content, 'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nRULES_TEXT\n\nFORMAT_TEXT');
});

test('buildRequest: {{name}} is filled with selfName in every system part', () => {
  const request = buildRequest(
    baseInput({ prompts: fakePrompts({ 'system-prompt': 'Hi, I am {{name}}.', 'character-card': 'card of {{name}}' }) }),
  );
  assert.ok(request.messages[0].content.includes('Hi, I am Nept.'));
  assert.ok(request.messages[0].content.includes('card of Nept'));
});

test('buildRequest: fills {{author}}, {{trigger}}, {{target}} and {{name}} in the task template', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention' }));
  const user = request.messages[1].content;
  assert.ok(user.includes(`Called by Alice, they ${labels.triggers.mention}. Answer #1 as Nept. Target: #1.`));
});

test('buildRequest: target is the #index of the trigger message in the transcript', () => {
  const m1 = makeMessage(1, NOW - 3 * MIN);
  const m2 = makeMessage(2, NOW - 2 * MIN);
  const trigger = makeMessage(3, NOW - MIN, { authorName: 'Bob' });
  const request = buildRequest(baseInput({ history: [m1, m2, trigger], trigger, triggerKind: 'reply' }));
  const user = request.messages[1].content;
  assert.ok(user.includes('Answer #3 as Nept. Target: #3.'));
});

test('buildRequest: {{trigger}} resolves through labels.triggers, not config.mention', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'name' }));
  const user = request.messages[1].content;
  assert.ok(user.includes(labels.triggers.name));
});

test('buildRequest: blocks appear in the documented order', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(
    baseInput({
      history: [trigger],
      trigger,
      triggerKind: 'mention',
      guildMemory: { patterns: 'talks fast', self: ['likes games'] },
      otherProfiles: [{ id: 'p2', names: ['Carl'], character: 'calm' }],
      neighbors: [{ channelName: 'general', messages: [makeMessage(9, NOW - 5 * MIN)] }],
      channels: [{ id: 'c1', name: 'general', lastMessageAt: NOW, days: {} }],
      currentChannelId: 'c1',
    }),
  );
  const user = request.messages[1].content;
  const order = ['<now>', '<about_chat>', '<server>', '<self_facts>', '<people>', '<other_channels>', '<chat>', '<tempo>', '<task>'];
  const positions = order.map((tag) => user.indexOf(tag));
  assert.ok(positions.every((p) => p !== -1), `expected all tags present: ${JSON.stringify(positions)}`);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], `expected ${order[i - 1]} before ${order[i]}`);
  }
});

test('buildRequest: empty blocks (about_chat, server, self_facts, people, other_channels) are omitted', () => {
  const request = buildRequest(baseInput({ guildMemory: {}, otherProfiles: [], neighbors: [], trigger: null, channels: [] }));
  const user = request.messages[1].content;
  assert.ok(!user.includes('<about_chat>'));
  assert.ok(!user.includes('<server>'));
  assert.ok(!user.includes('<self_facts>'));
  assert.ok(!user.includes('<people>'));
  assert.ok(!user.includes('<other_channels>'));
  assert.ok(user.includes('<now>'));
  assert.ok(user.includes('<chat>'));
  assert.ok(user.includes('<tempo>'));
  assert.ok(user.includes('<task>'));
});

test('buildRequest: the interlocutor is marked with labels.profile.interlocutorMark and rendered before other profiles', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const interlocutor = { id: 'author-1', names: ['Alice'], character: 'talkative' };
  const other = { id: 'p2', names: ['Carl'], character: 'calm' };
  const request = buildRequest(
    baseInput({ history: [trigger], trigger, triggerKind: 'mention', interlocutor, otherProfiles: [other] }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes(labels.profile.interlocutorMark.trim()));
  const peopleBlockStart = user.indexOf('<people>');
  const aliceIdx = user.indexOf('## Alice', peopleBlockStart);
  const carlIdx = user.indexOf('## Carl', peopleBlockStart);
  assert.ok(aliceIdx !== -1 && carlIdx !== -1 && aliceIdx < carlIdx);
});

test('buildRequest: throws a clear error when prompts.labels is missing', () => {
  assert.throws(() => buildRequest(baseInput({ prompts: fakePrompts({ labels: undefined }) })), /labels/);
});

test('buildRequest: throws a clear error when prompts.labels has no transcript section', () => {
  const brokenLabels = { ...labels, transcript: undefined };
  assert.throws(() => buildRequest(baseInput({ prompts: fakePrompts({ labels: brokenLabels }) })), /labels/);
});

test('buildRequest: under a tiny token budget, neighbours and other profiles are dropped before chat', () => {
  const history = [];
  for (let i = 1; i <= 10; i += 1) {
    history.push(makeMessage(i, NOW - (11 - i) * MIN, { content: `message number ${i} with some text` }));
  }
  const otherProfiles = [
    { id: 'p2', names: ['Carl'], character: 'x'.repeat(200) },
    { id: 'p3', names: ['Dana'], character: 'y'.repeat(200) },
  ];
  const neighbors = [{ channelName: 'general', messages: [makeMessage(90, NOW - 5 * MIN, { content: 'z'.repeat(200) })] }];

  const request = buildRequest(
    baseInput({
      history,
      neighbors,
      otherProfiles,
      config: fakeConfig({ llm: { maxRequestTokens: 220, safetyMargin: 1 } }),
    }),
  );

  assert.deepEqual(request.stats.people.kept, 0);
  assert.deepEqual(request.stats.neighbors.kept, 0);
  assert.ok(request.stats.chat.kept > 0, 'expected at least some chat lines to survive');
  const user = request.messages[1].content;
  assert.ok(user.includes('message number 10'));
});

test('buildRequest: total token usage never exceeds maxRequestTokens * safetyMargin', () => {
  const history = [];
  for (let i = 1; i <= 30; i += 1) {
    history.push(makeMessage(i, NOW - (31 - i) * MIN, { content: 'word '.repeat(20) }));
  }
  const config = fakeConfig({ llm: { maxRequestTokens: 500, safetyMargin: 0.8 } });
  const request = buildRequest(baseInput({ history, config }));
  const cap = config.llm.maxRequestTokens * config.llm.safetyMargin;
  assert.ok(request.stats.used <= cap, `used ${request.stats.used} must be <= cap ${cap}`);
});

test('buildRequest: images are attached only when features.vision is enabled, capped by maxImages', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    attachments: [
      { kind: 'image', url: 'img1' },
      { kind: 'image', url: 'img2' },
      { kind: 'image', url: 'img3' },
      { kind: 'file', url: 'file1' },
    ],
  });
  const config = fakeConfig({ features: { vision: true }, context: { vision: { maxImages: 2, tokensPerImage: 1600 } } });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));
  const content = request.messages[1].content;
  assert.ok(Array.isArray(content));
  const imageParts = content.filter((part) => part.type === 'image_url');
  assert.equal(imageParts.length, 2);
  assert.equal(content[0].type, 'text');
});

test('buildRequest: vision disabled means plain string content, even with image attachments', () => {
  const trigger = makeMessage(1, NOW - MIN, { attachments: [{ kind: 'image', url: 'img1' }] });
  const config = fakeConfig({ features: { vision: false }, context: { vision: { maxImages: 2, tokensPerImage: 1600 } } });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));
  assert.equal(typeof request.messages[1].content, 'string');
});

test('buildRequest: idByIndex maps every transcript index to its message id', () => {
  const history = [makeMessage('a', NOW - 3 * MIN), makeMessage('b', NOW - 2 * MIN), makeMessage('c', NOW - MIN)];
  const request = buildRequest(baseInput({ history }));
  assert.equal(request.idByIndex.get(1), 'a');
  assert.equal(request.idByIndex.get(2), 'b');
  assert.equal(request.idByIndex.get(3), 'c');
});

test('buildRequest: idByIndex still covers messages later trimmed out of the rendered chat', () => {
  const history = [];
  for (let i = 1; i <= 10; i += 1) {
    history.push(makeMessage(i, NOW - (11 - i) * MIN, { content: 'word '.repeat(20) }));
  }
  const config = fakeConfig({ llm: { maxRequestTokens: 220, safetyMargin: 1 } });
  const request = buildRequest(baseInput({ history, config }));
  // idByIndex is built from the FULL transcript, before trimming.
  assert.equal(request.idByIndex.size, 10);
  assert.equal(request.idByIndex.get(1), 1);
});

test('buildRequest: sanity check on estimateTokens used for the cost function stays consistent', () => {
  // Not a behavioural assertion about buildRequest itself -- just confirms the
  // shared cost primitive it relies on has not silently changed shape.
  assert.equal(typeof estimateTokens('x'), 'number');
});

// --- tempo thresholds come from config, not hardcoded in the renderer -------

test('buildRequest: config.context.tempo reaches the tempo verdict rendered in <tempo>', () => {
  // 1 message 5 minutes ago: below the default live threshold (4) and well
  // under the default dead silence (45 min), so it renders as "slow" by
  // default but as "live" once config lowers liveMessages10min to 1.
  const history = [makeMessage(1, NOW - 5 * MIN)];

  const defaultRequest = buildRequest(baseInput({ history, trigger: null }));
  const defaultUser = defaultRequest.messages[1].content;
  assert.ok(defaultUser.includes(labels.tempo.verdictSlow));
  assert.ok(!defaultUser.includes(labels.tempo.verdictLive));

  const config = fakeConfig({ context: { tempo: { liveMessages10min: 1, deadSilenceMinutes: 45 } } });
  const tunedRequest = buildRequest(baseInput({ history, trigger: null, config }));
  const tunedUser = tunedRequest.messages[1].content;
  assert.ok(tunedUser.includes(labels.tempo.verdictLive));
});

// --- <server>: the channel map -----------------------------------------------

function fakeChannel(id, overrides = {}) {
  return { id, name: `chan-${id}`, category: null, topic: null, purpose: '', topics: '', tone: '', days: {}, lastMessageAt: null, ...overrides };
}

test('buildRequest: hides <server> entirely when channels is empty', () => {
  const request = buildRequest(baseInput({ channels: [], currentChannelId: 'c1' }));
  assert.ok(!request.messages[1].content.includes('<server>'));
});

test('buildRequest: the current channel is first and carries labels.server.currentMark', () => {
  const channels = [
    fakeChannel('c1', { name: 'general', lastMessageAt: NOW - 5 * MIN }),
    fakeChannel('c2', { name: 'random', lastMessageAt: NOW }), // more recent, but not the current channel
  ];
  const request = buildRequest(baseInput({ channels, currentChannelId: 'c1' }));
  const user = request.messages[1].content;
  const serverStart = user.indexOf('<server>');
  const generalIdx = user.indexOf('# general', serverStart);
  const randomIdx = user.indexOf('# random', serverStart);
  assert.ok(generalIdx !== -1 && randomIdx !== -1 && generalIdx < randomIdx, 'current channel renders first');
  assert.ok(user.includes(`# general${labels.server.currentMark}`));
});

test('buildRequest: channels other than the current one are ordered by lastMessageAt descending', () => {
  const channels = [
    fakeChannel('c1', { name: 'oldest', lastMessageAt: NOW - 3 * MIN }),
    fakeChannel('c2', { name: 'newest', lastMessageAt: NOW - 1 * MIN }),
    fakeChannel('c3', { name: 'never-active', lastMessageAt: null }),
  ];
  const request = buildRequest(baseInput({ channels, currentChannelId: 'other-channel' }));
  const user = request.messages[1].content;
  const serverStart = user.indexOf('<server>');
  const newestIdx = user.indexOf('# newest', serverStart);
  const oldestIdx = user.indexOf('# oldest', serverStart);
  const neverIdx = user.indexOf('# never-active', serverStart);
  assert.ok(newestIdx < oldestIdx && oldestIdx < neverIdx);
});

test('buildRequest: every channel is listed even with no purpose/topics/tone, name and activity survive', () => {
  const channels = [fakeChannel('c1', { name: 'quiet-room', lastMessageAt: null })];
  const request = buildRequest(baseInput({ channels, currentChannelId: 'c1' }));
  const user = request.messages[1].content;
  assert.ok(user.includes('# quiet-room'));
  assert.ok(user.includes(`activity: ${labels.server.activityDead}`));
});

test('buildRequest: under a tiny server cap, the map is trimmed but <chat> still survives', () => {
  const history = [];
  for (let i = 1; i <= 10; i += 1) {
    history.push(makeMessage(i, NOW - (11 - i) * MIN, { content: `message number ${i} with some text` }));
  }
  const channels = [
    fakeChannel('c1', { name: 'general', purpose: 'x'.repeat(200), lastMessageAt: NOW }),
    fakeChannel('c2', { name: 'random', purpose: 'y'.repeat(200), lastMessageAt: NOW - MIN }),
  ];
  const config = fakeConfig({ llm: { maxRequestTokens: 220, safetyMargin: 1 } });
  const request = buildRequest(baseInput({ history, channels, currentChannelId: 'c1', config }));

  assert.equal(request.stats.server.kept, 0);
  assert.ok(request.stats.chat.kept > 0, 'expected at least some chat lines to survive');
  const user = request.messages[1].content;
  assert.ok(user.includes('message number 10'));
});

// --- language independence --------------------------------------------------

// --- renderProfile: relationships / affinity ---------------------------------

test('renderProfile: relationships off never renders an attitude line, even with a non-zero score', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', affinity: { score: 80, reason: 'saved my day', history: [] } };
  const text = renderProfile(profile, labels, { relationships: false });
  assert.ok(!text.includes('attitude:'));
});

test('renderProfile: relationships on renders the attitude line right after the heading', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', affinity: { score: 80, reason: 'saved my day', history: [] } };
  const text = renderProfile(profile, labels, { relationships: true });
  const lines = text.split('\n');
  assert.equal(lines[0], '## Carl');
  assert.equal(lines[1], 'attitude: 80 (devoted) — saved my day');
});

test('renderProfile: the band label is chosen from labels.affinity.bands, thresholds fixed in code', () => {
  const profile = { id: 'p1', names: ['Carl'], affinity: { score: -70, reason: 'burned a bridge', history: [] } };
  const text = renderProfile(profile, labels, { relationships: true });
  assert.ok(text.includes('attitude: -70 (hostile) — burned a bridge'));
});

test('renderProfile: works with a non-English labels object for the attitude line', () => {
  const ruLabels = {
    ...labels,
    profile: { ...labels.profile, affinity: 'отношение: {score} ({band}) — {reason}' },
    affinity: { bands: { ...labels.affinity.bands, warm: 'тепло' } },
  };
  const profile = { id: 'p1', names: ['Карл'], affinity: { score: 10, reason: 'помог', history: [] } };
  const text = renderProfile(profile, ruLabels, { relationships: true });
  assert.ok(text.includes('отношение: 10 (тепло) — помог'));
});

test('renderProfile: a neutral score with no reason gets no attitude line', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', affinity: { score: 0, reason: '', history: [] } };
  const text = renderProfile(profile, labels, { relationships: true });
  assert.ok(!text.includes('attitude:'));
});

test('renderProfile: a zero score with a non-empty reason still gets an attitude line', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', affinity: { score: 0, reason: 'used to dislike them, now unsure', history: [] } };
  const text = renderProfile(profile, labels, { relationships: true });
  assert.ok(text.includes('attitude: 0 (neutral) — used to dislike them, now unsure'));
});

test('renderProfile: a profile whose only content is the attitude line is still rendered', () => {
  const profile = { id: 'p1', names: ['Carl'], affinity: { score: -30, reason: 'annoying', history: [] } };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: false });
  assert.equal(text, '## Carl\nattitude: -30 (dislike) — annoying');
  assert.ok(!text.includes(labels.profile.unknown));
});

test('renderProfile: a profile with no affinity at all (pre-relationships data) renders as before', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm' };
  const text = renderProfile(profile, labels, { relationships: true });
  assert.equal(text, '## Carl\ncharacter: calm');
});

test('buildRequest: relationships default to on (features.relationships missing counts as on)', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const interlocutor = { id: 'author-1', names: ['Alice'], affinity: { score: 40, reason: 'fun to talk to', history: [] } };
  const config = fakeConfig();
  delete config.features.relationships;
  const request = buildRequest(
    baseInput({ config, history: [trigger], trigger, triggerKind: 'mention', interlocutor }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('attitude: 40 (fond) — fun to talk to'));
});

test('buildRequest: features.relationships=false hides the attitude line entirely', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const interlocutor = { id: 'author-1', names: ['Alice'], affinity: { score: 40, reason: 'fun to talk to', history: [] } };
  const config = fakeConfig({ features: { relationships: false } });
  const request = buildRequest(
    baseInput({ config, history: [trigger], trigger, triggerKind: 'mention', interlocutor }),
  );
  const user = request.messages[1].content;
  assert.ok(!user.includes('attitude:'));
});

test('buildRequest: a non-English labels object drives the same blocks, proving nothing is language-bound', () => {
  const ruLabels = {
    ...labels,
    locale: 'ru-RU',
    self: '{name} (ты)',
    triggers: { mention: 'тегнул тебя', reply: 'ответил тебе', name: 'назвал по имени' },
  };
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(
    baseInput({ prompts: fakePrompts({ labels: ruLabels }), history: [trigger], trigger, triggerKind: 'mention' }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('тегнул тебя'));
  assert.ok(user.includes('<now>'));
  assert.ok(user.includes('<task>'));
});
