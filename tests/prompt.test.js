// Tests for src/behavior/prompt.js: buildRequest, the one-shot LLM request
// assembler. Uses fake prompts/config only -- never reads prompts/ or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../src/behavior/prompt.js';
import { estimateTokens } from '../src/llm/tokens.js';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0); // Sun 20 Sep 2026, 13:00 Moscow
const MIN = 60_000;

function identityCalibrator() {
  return { ratio: 1, apply: (n) => n };
}

function fakePrompts(overrides = {}) {
  return {
    persona: 'PERSONA_TEXT',
    rules: 'RULES_TEXT',
    format: 'FORMAT_TEXT',
    reply: 'Тебя позвал {{author}}, он {{trigger}}. Ответь на {{target}}.',
    interject: 'INTERJECT_TASK',
    initiate: 'INITIATE_TASK',
    ...overrides,
  };
}

function fakeConfig(overrides = {}) {
  return {
    bot: { timezone: 'Europe/Moscow' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { enabled: true, maxImages: 2, tokensPerImage: 1600 },
      ...overrides.context,
    },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, ...overrides.llm },
    mention: {
      triggerPhrases: {
        mention: 'тегнул(а) тебя',
        reply: 'ответил(а) на твоё сообщение',
        name: 'упомянул(а) тебя по имени, без тега',
      },
      ...overrides.mention,
    },
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
    selfName: 'Непка',
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

test('buildRequest: system message is persona + rules + format, joined', () => {
  const request = buildRequest(baseInput());
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[0].content, 'PERSONA_TEXT\n\nRULES_TEXT\n\nFORMAT_TEXT');
});

test('buildRequest: fills {{author}}, {{trigger}} and {{target}} in the task template', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention' }));
  const user = request.messages[1].content;
  assert.ok(user.includes('Тебя позвал Alice, он тегнул(а) тебя. Ответь на #1.'));
});

test('buildRequest: target is the #index of the trigger message in the transcript', () => {
  const m1 = makeMessage(1, NOW - 3 * MIN);
  const m2 = makeMessage(2, NOW - 2 * MIN);
  const trigger = makeMessage(3, NOW - MIN, { authorName: 'Bob' });
  const request = buildRequest(baseInput({ history: [m1, m2, trigger], trigger, triggerKind: 'reply' }));
  const user = request.messages[1].content;
  assert.ok(user.includes('Ответь на #3.'));
});

test('buildRequest: blocks appear in the documented order', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(
    baseInput({
      history: [trigger],
      trigger,
      triggerKind: 'mention',
      guildMemory: { patterns: 'как тут говорят', self: ['она любит игры'] },
      otherProfiles: [{ id: 'p2', names: ['Carl'], character: 'спокойный' }],
      neighbors: [{ channelName: 'general', messages: [makeMessage(9, NOW - 5 * MIN)] }],
    }),
  );
  const user = request.messages[1].content;
  const order = ['<now>', '<about_chat>', '<self_facts>', '<people>', '<other_channels>', '<chat>', '<tempo>', '<task>'];
  const positions = order.map((tag) => user.indexOf(tag));
  assert.ok(positions.every((p) => p !== -1), `expected all tags present: ${JSON.stringify(positions)}`);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] < positions[i], `expected ${order[i - 1]} before ${order[i]}`);
  }
});

test('buildRequest: empty blocks (about_chat, self_facts, people, other_channels) are omitted', () => {
  const request = buildRequest(baseInput({ guildMemory: {}, otherProfiles: [], neighbors: [], trigger: null }));
  const user = request.messages[1].content;
  assert.ok(!user.includes('<about_chat>'));
  assert.ok(!user.includes('<self_facts>'));
  assert.ok(!user.includes('<people>'));
  assert.ok(!user.includes('<other_channels>'));
  assert.ok(user.includes('<now>'));
  assert.ok(user.includes('<chat>'));
  assert.ok(user.includes('<tempo>'));
  assert.ok(user.includes('<task>'));
});

test('buildRequest: the interlocutor is marked СОБЕСЕДНИК and rendered before other profiles', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const interlocutor = { id: 'author-1', names: ['Alice'], character: 'болтливая' };
  const other = { id: 'p2', names: ['Carl'], character: 'спокойный' };
  const request = buildRequest(
    baseInput({ history: [trigger], trigger, triggerKind: 'mention', interlocutor, otherProfiles: [other] }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('СОБЕСЕДНИК'));
  const peopleBlockStart = user.indexOf('<people>');
  const aliceIdx = user.indexOf('## Alice', peopleBlockStart);
  const carlIdx = user.indexOf('## Carl', peopleBlockStart);
  assert.ok(aliceIdx !== -1 && carlIdx !== -1 && aliceIdx < carlIdx);
});

test('buildRequest: under a tiny token budget, neighbours and other profiles are dropped before chat', () => {
  const history = [];
  for (let i = 1; i <= 10; i += 1) {
    history.push(makeMessage(i, NOW - (11 - i) * MIN, { content: `сообщение номер ${i} с некоторым текстом` }));
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
  // The newest message must be among the survivors.
  const user = request.messages[1].content;
  assert.ok(user.includes('сообщение номер 10'));
});

test('buildRequest: total token usage never exceeds maxRequestTokens * safetyMargin', () => {
  const history = [];
  for (let i = 1; i <= 30; i += 1) {
    history.push(makeMessage(i, NOW - (31 - i) * MIN, { content: 'слово '.repeat(20) }));
  }
  const config = fakeConfig({ llm: { maxRequestTokens: 500, safetyMargin: 0.8 } });
  const request = buildRequest(baseInput({ history, config }));
  const cap = config.llm.maxRequestTokens * config.llm.safetyMargin;
  assert.ok(request.stats.used <= cap, `used ${request.stats.used} must be <= cap ${cap}`);
});

test('buildRequest: images are attached only when vision is enabled, capped by maxImages', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    attachments: [
      { kind: 'image', url: 'img1' },
      { kind: 'image', url: 'img2' },
      { kind: 'image', url: 'img3' },
      { kind: 'file', url: 'file1' },
    ],
  });
  const config = fakeConfig({ context: { vision: { enabled: true, maxImages: 2, tokensPerImage: 1600 } } });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));
  const content = request.messages[1].content;
  assert.ok(Array.isArray(content));
  const imageParts = content.filter((part) => part.type === 'image_url');
  assert.equal(imageParts.length, 2);
  assert.equal(content[0].type, 'text');
});

test('buildRequest: vision disabled means plain string content, even with image attachments', () => {
  const trigger = makeMessage(1, NOW - MIN, { attachments: [{ kind: 'image', url: 'img1' }] });
  const config = fakeConfig({ context: { vision: { enabled: false, maxImages: 2, tokensPerImage: 1600 } } });
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
    history.push(makeMessage(i, NOW - (11 - i) * MIN, { content: 'слово '.repeat(20) }));
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
