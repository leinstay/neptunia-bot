// Tests for src/behavior/prompt.js: buildRequest, the one-shot LLM request
// assembler. Uses fake prompts/config/labels only -- never reads prompts/ or
// data/. tests/fixtures/labels.js is an English fixture covering every key of
// the prompt contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { block, buildDrawPrompt, buildRequest, hasRequiredLabels, renderProfile, fillPromptTemplate } from '../src/behavior/prompt.js';
import { estimateTokens } from '../src/llm/tokens.js';
import { fill, formatClock, formatDate, formatDuration } from '../src/discord/format.js';
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
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      ...overrides.context,
    },
    features: { vision: true, ...overrides.features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, ...overrides.llm },
    lore: { scanMessages: 30, maxMatches: 8, ...overrides.lore },
    memory: { ...overrides.memory },
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

// A follow-up turn is its own trigger kind.
test('buildRequest: triggerKind "followUp" fills {{trigger}} from labels.triggers.followUp', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'followUp' }));
  const user = request.messages[1].content;
  assert.ok(user.includes(labels.triggers.followUp));
});

test('buildRequest: triggerKind "followUp" falls back to labels.triggers.reply when labels.triggers.followUp is missing (an older labels.json)', () => {
  const olderLabels = { ...labels, triggers: { mention: labels.triggers.mention, reply: labels.triggers.reply, name: labels.triggers.name } };
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(
    baseInput({ prompts: fakePrompts({ labels: olderLabels }), history: [trigger], trigger, triggerKind: 'followUp' }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes(labels.triggers.reply));
});

// An overheard turn: a line about the persona, said to someone else or to the room.
const OVERHEARD_TASK = 'OVERHEARD_TASK: {{author}} {{trigger}} at {{target}}; you are {{name}}.';

test('buildRequest: triggerKind "overheard" takes prompts.overheard as its task, every placeholder filled, no reply.md text', () => {
  const m1 = makeMessage(1, NOW - 2 * MIN);
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({ prompts: fakePrompts({ overheard: OVERHEARD_TASK }), history: [m1, trigger], trigger, triggerKind: 'overheard' }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes(`OVERHEARD_TASK: Élodie ${labels.triggers.overheard} at #2; you are Nept.`));
  assert.ok(!user.includes('Called by'), 'reply.md is not used on an overheard turn');
});

test('buildRequest: triggerKind "overheard" without prompts.overheard (missing or blank) uses the mode prompt with the overheard label', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  for (const overheard of [undefined, '', '   ']) {
    const request = buildRequest(
      baseInput({ prompts: fakePrompts({ overheard }), history: [trigger], trigger, triggerKind: 'overheard' }),
    );
    const user = request.messages[1].content;
    assert.ok(user.includes(`Called by Élodie, they ${labels.triggers.overheard}. Answer #1 as Nept.`), JSON.stringify(overheard));
  }
});

test('buildRequest: the overheard trigger label falls back to labels.triggers.followUp, then labels.triggers.reply', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  const run = (triggers) =>
    buildRequest(
      baseInput({ prompts: fakePrompts({ overheard: OVERHEARD_TASK, labels: { ...labels, triggers } }), history: [trigger], trigger, triggerKind: 'overheard' }),
    ).messages[1].content;
  const { overheard, ...withoutOverheard } = labels.triggers;
  assert.ok(overheard);
  assert.ok(run(withoutOverheard).includes(`Élodie ${labels.triggers.followUp} at #1`));
  const { followUp, ...withoutEither } = withoutOverheard;
  assert.ok(followUp);
  assert.ok(run(withoutEither).includes(`Élodie ${labels.triggers.reply} at #1`));
  assert.ok(run({}).includes('OVERHEARD_TASK: Élodie  at #1'), 'no trigger label at all leaves it empty');
});

test('buildRequest: the author heads <people> without the interlocutor mark on an overheard turn; a followUp turn keeps it', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  const interlocutor = { id: 'author-1', names: ['Élodie'], character: 'curious' };
  const other = { id: 'p2', names: ['Carl'], character: 'calm' };
  const run = (triggerKind) =>
    buildRequest(
      baseInput({ prompts: fakePrompts({ overheard: OVERHEARD_TASK }), history: [trigger], trigger, triggerKind, interlocutor, otherProfiles: [other] }),
    ).messages[1].content;

  const overheard = run('overheard');
  assert.ok(!overheard.includes(labels.profile.interlocutorMark.trim()), 'no "talking to you" mark');
  const peopleStart = overheard.indexOf('<people>');
  const elodie = overheard.indexOf('## Élodie\n', peopleStart);
  assert.ok(elodie !== -1, 'the author still heads <people>, heading bare');
  assert.ok(elodie < overheard.indexOf('## Carl', peopleStart));
  assert.ok(overheard.includes(fill(labels.profile.character, { text: 'curious' })), 'the full profile still renders');

  const followUp = run('followUp');
  assert.ok(followUp.includes(`## Élodie${labels.profile.interlocutorMark}`));
});

// /nep interject, /nep initiate: an owner-forced turn appends prompts.forced
// (when present) to the task text, filled with the same placeholders as the
// mode's own task template.
test('buildRequest: forced=true appends the filled prompts.forced to the task text', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(
    baseInput({
      mode: 'interject',
      forced: true,
      history: [trigger],
      trigger,
      triggerKind: 'mention',
      prompts: fakePrompts({ forced: 'FORCED_TASK for {{name}}, target {{target}}' }),
    }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('INTERJECT_TASK for Nept'));
  assert.ok(user.includes('FORCED_TASK for Nept, target #1'));
  assert.ok(user.indexOf('INTERJECT_TASK for Nept') < user.indexOf('FORCED_TASK for Nept, target #1'));
});

test('buildRequest: forced=true with no prompts.forced leaves the task text unchanged', () => {
  const request = buildRequest(baseInput({ mode: 'interject', forced: true }));
  const user = request.messages[1].content;
  assert.ok(user.includes('INTERJECT_TASK for Nept'));
  assert.equal(request.messages[1].content, buildRequest(baseInput({ mode: 'interject', forced: false })).messages[1].content);
});

test('buildRequest: forced=false never appends prompts.forced even when it is set', () => {
  const request = buildRequest(
    baseInput({ mode: 'interject', forced: false, prompts: fakePrompts({ forced: 'FORCED_TASK' }) }),
  );
  const user = request.messages[1].content;
  assert.ok(!user.includes('FORCED_TASK'));
});

test('buildRequest: forced defaults to false when omitted', () => {
  const request = buildRequest(
    baseInput({ mode: 'interject', prompts: fakePrompts({ forced: 'FORCED_TASK' }) }),
  );
  const user = request.messages[1].content;
  assert.ok(!user.includes('FORCED_TASK'));
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

test('hasRequiredLabels: an object with transcript passes; anything else fails', () => {
  assert.equal(hasRequiredLabels(labels), true);
  for (const bad of [undefined, null, {}, { transcript: '' }, 'labels', 42]) {
    assert.equal(hasRequiredLabels(bad), false, JSON.stringify(bad));
  }
});

test('buildRequest: a neighbour message is cut at context.neighborMessageChars (300 when missing)', () => {
  const long = 'λ'.repeat(400);
  const neighbors = [{ channelName: 'general', messages: [makeMessage(9, NOW - 5 * MIN, { content: long })] }];
  const otherChannels = (config) => {
    const user = buildRequest(baseInput({ config, neighbors })).messages[1].content;
    return user.split('<other_channels>\n')[1].split('\n</other_channels>')[0];
  };
  const cut = otherChannels(fakeConfig({ context: { neighborMessageChars: 20 } }));
  assert.ok(cut.includes('λ'.repeat(20)) && !cut.includes('λ'.repeat(21)), cut);
  const fallback = otherChannels(fakeConfig());
  assert.ok(fallback.includes('λ'.repeat(300)) && !fallback.includes('λ'.repeat(301)));
});

/** The `<other_channels>` body of a request built from `overrides`. */
function otherChannelsOf(overrides) {
  const user = buildRequest(baseInput(overrides)).messages[1].content;
  return user.split('<other_channels>\n')[1].split('\n</other_channels>')[0];
}

test('buildRequest: a neighbour picture with a caption in neighborDescriptions renders described; one without stays blind', () => {
  const pictures = [
    { id: 'np1', kind: 'image', url: 'https://cdn/np1.png', name: 'np1.png' },
    { id: 'np2', kind: 'image', url: 'https://cdn/np2.png', name: 'np2.png' },
  ];
  const neighbors = [{ channelName: 'random', messages: [makeMessage(9, NOW - 5 * MIN, { attachments: pictures })] }];
  const described = otherChannelsOf({ neighbors, neighborDescriptions: new Map([['np1', 'a sleeping cat']]) });
  assert.ok(described.includes(fill(labels.transcript.imageDescribed, { text: 'a sleeping cat' })), described);
  assert.ok(described.includes(labels.transcript.image), 'the uncaptioned picture keeps its blind form');

  const blind = otherChannelsOf({ neighbors });
  assert.ok(!blind.includes('a sleeping cat'), blind);
  assert.ok(blind.includes(labels.transcript.image));
});

test('buildRequest: neighborDescriptions never reach the chat lines; the chat captions still reach the neighbour lines', () => {
  const chatPicture = { id: 'cp1', kind: 'image', url: 'https://cdn/cp1.png', name: 'cp1.png' };
  const neighbourPicture = { id: 'np1', kind: 'image', url: 'https://cdn/np1.png', name: 'np1.png' };
  const history = [makeMessage(1, NOW - MIN, { attachments: [chatPicture] })];
  const neighbors = [{ channelName: 'random', messages: [makeMessage(9, NOW - 5 * MIN, { attachments: [neighbourPicture] })] }];
  const input = baseInput({
    history,
    neighbors,
    descriptions: new Map([['np1', 'a red fox']]),
    neighborDescriptions: new Map([['cp1', 'a sleeping cat']]),
  });
  const user = buildRequest(input).messages[1].content;
  const chat = user.split('<chat>\n')[1].split('\n</chat>')[0];
  assert.ok(!chat.includes('a sleeping cat'), chat);
  assert.ok(chat.includes(labels.transcript.image));
  const others = user.split('<other_channels>\n')[1].split('\n</other_channels>')[0];
  assert.ok(others.includes(fill(labels.transcript.imageDescribed, { text: 'a red fox' })), others);
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
      // 340 was tight enough before the <senses> block grew a few lines
      // (stickers/lottie, part of the always-kept "fixed" section) so the
      // budget needs a little more headroom to still leave room for chat.
      config: fakeConfig({ llm: { maxRequestTokens: 400, safetyMargin: 1 } }),
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
      { id: 'i1', kind: 'image', url: 'img1' },
      { id: 'i2', kind: 'image', url: 'img2' },
      { id: 'i3', kind: 'image', url: 'img3' },
      { id: 'i4', kind: 'file', url: 'file1' },
    ],
  });
  const config = fakeConfig({
    features: { vision: true },
    context: { vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 } },
  });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));
  const content = request.messages[1].content;
  assert.ok(Array.isArray(content));
  const imageParts = content.filter((part) => part.type === 'image_url');
  assert.equal(imageParts.length, 2);
  assert.equal(content[0].type, 'text');
});

test('buildRequest: vision disabled means plain string content, even with image attachments', () => {
  const trigger = makeMessage(1, NOW - MIN, { attachments: [{ id: 'i1', kind: 'image', url: 'img1' }] });
  const config = fakeConfig({
    features: { vision: false },
    context: { vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 } },
  });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));
  assert.equal(typeof request.messages[1].content, 'string');
});

test('buildRequest: an image attached to the request renders transcript.imageAttached numbered in transcript order', () => {
  const trigger = makeMessage(1, NOW - MIN, { attachments: [{ id: 'i1', kind: 'image', url: 'img1' }] });
  const config = fakeConfig({
    features: { vision: true },
    context: { vision: { maxImages: 4, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 } },
  });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));
  const user = request.messages[1].content.find((part) => part.type === 'text').text;
  assert.ok(user.includes(labels.transcript.imageAttached.replace('{n}', '1')));
});

test('buildRequest: textFallback re-renders the same chat with attachedIndex dropped -- blind/described, frameAttached gone', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    attachments: [{ id: 'v1', kind: 'video', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', name: 'clip.mp4', durationSec: 34 }],
  });
  const config = fakeConfig({
    features: { vision: true },
    context: { vision: { maxImages: 4, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 } },
  });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));

  const primaryText = request.messages[1].content.find((part) => part.type === 'text').text;
  assert.ok(primaryText.includes(labels.transcript.frameAttached.replace('{n}', '1')));
  assert.ok(primaryText.includes('[video: clip.mp4, 0:34]'));

  assert.equal(typeof request.textFallback, 'string');
  assert.ok(request.textFallback.includes('[video: clip.mp4, 0:34]'));
  assert.ok(!request.textFallback.includes('still frame'), 'frameAttached must be dropped in the fallback');
  assert.ok(!request.textFallback.includes(labels.transcript.imageAttached.replace('{n}', '1')));
});

test('buildRequest: videos reach the transcript, and the textFallback keeps them', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    attachments: [{ id: 'v1', kind: 'video', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', name: 'clip.mp4', durationSec: 34 }],
  });
  const videos = new Map([['v1', { state: 'watched', text: 'κάποιος χορεύει' }]]);
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', videos }));

  const watched = fill(labels.transcript.videoWatched, { name: 'clip.mp4', duration: '0:34', text: 'κάποιος χορεύει' });
  const primaryText = request.messages[1].content.find((part) => part.type === 'text').text;
  assert.ok(primaryText.includes(watched));
  assert.ok(request.textFallback.includes(watched));
});

test('buildRequest: textFallback is null when nothing is attached (no pictures selected)', () => {
  const request = buildRequest(baseInput());
  assert.equal(request.textFallback, null);
});

test('buildRequest: the media proxy resizes a Discord CDN picture to context.vision.imageSize', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    attachments: [{ id: 'i1', kind: 'image', url: 'https://cdn.discordapp.com/attachments/1/2/pic.png' }],
  });
  const config = fakeConfig({
    features: { vision: true },
    context: { vision: { maxImages: 4, tokensPerImage: 400, imageSize: 256, recentImages: 0, recentImageMinutes: 0 } },
  });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));
  const imagePart = request.messages[1].content.find((part) => part.type === 'image_url');
  const url = new URL(imagePart.image_url.url);
  assert.equal(url.searchParams.get('width'), '256');
  assert.equal(url.searchParams.get('format'), 'webp');
});

// --- vision: the trigger's own sticker --------------------------------------

test('buildRequest: the trigger\'s picture-format sticker is attached, rendered as the sticker tag + frameAttached', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    stickers: [{ id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' }],
  });
  const config = fakeConfig({
    features: { vision: true },
    context: { vision: { maxImages: 4, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 } },
  });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', config }));

  const content = request.messages[1].content;
  assert.ok(Array.isArray(content));
  const imagePart = content.find((part) => part.type === 'image_url');
  // A sticker's URL is already fully sized (see stickerUrl) -- the media
  // proxy must never touch it, unlike a plain attachment/embed picture.
  assert.equal(imagePart.image_url.url, 'https://media.discordapp.net/stickers/s1.png?size=160');

  const user = content.find((part) => part.type === 'text').text;
  assert.ok(user.includes('[sticker: pepe] [its still frame is attached image 1]'));
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
  // 340 was tight enough before <senses> gained the channels line (part of
  // the always-kept "fixed" section); 400 still trims the chat.
  const config = fakeConfig({ llm: { maxRequestTokens: 400, safetyMargin: 1 } });
  const request = buildRequest(baseInput({ history, config }));
  assert.ok(request.stats.chat.dropped > 0, 'the chat is trimmed');
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

test('buildRequest: the current channel is first and carries labels.server.currentMark, a contributing neighbour follows', () => {
  const channels = [
    fakeChannel('c1', { name: 'general', lastMessageAt: NOW - 5 * MIN }),
    fakeChannel('c2', { name: 'random', lastMessageAt: NOW }), // more recent, but not the current channel
  ];
  const neighbors = [{ channelId: 'c2', channelName: 'random', messages: [makeMessage(9, NOW - 5 * MIN)] }];
  const request = buildRequest(baseInput({ channels, currentChannelId: 'c1', neighbors }));
  const user = request.messages[1].content;
  const serverStart = user.indexOf('<server>');
  const generalIdx = user.indexOf('# general', serverStart);
  const randomIdx = user.indexOf('# random', serverStart);
  assert.ok(generalIdx !== -1 && randomIdx !== -1 && generalIdx < randomIdx, 'current channel renders first');
  assert.ok(user.includes(`# general${labels.server.currentMark}`));
});

test('buildRequest: <server> shows only the current channel and the neighbours that contributed to <other_channels>, nothing else', () => {
  const channels = [
    fakeChannel('c1', { name: 'general' }),
    fakeChannel('c2', { name: 'random' }),
    fakeChannel('c3', { name: 'off-topic' }), // never a neighbour this turn -- must not appear
  ];
  const neighbors = [
    { channelId: 'c2', channelName: 'random', messages: [makeMessage(9, NOW - 5 * MIN)] },
  ];
  const request = buildRequest(baseInput({ channels, currentChannelId: 'c1', neighbors }));
  const user = request.messages[1].content;
  assert.ok(user.includes('# general'));
  assert.ok(user.includes('# random'));
  assert.ok(!user.includes('# off-topic'));
});

test('buildRequest: several contributing neighbours render in the order given by `neighbors`, by id not by name', () => {
  const channels = [
    fakeChannel('c1', { name: 'general' }),
    fakeChannel('c2', { name: 'zzz-last-by-name' }),
    fakeChannel('c3', { name: 'aaa-first-by-name' }),
  ];
  const neighbors = [
    { channelId: 'c2', channelName: 'zzz-last-by-name', messages: [makeMessage(9, NOW - 5 * MIN)] },
    { channelId: 'c3', channelName: 'aaa-first-by-name', messages: [makeMessage(10, NOW - 4 * MIN)] },
  ];
  const request = buildRequest(baseInput({ channels, currentChannelId: 'c1', neighbors }));
  const user = request.messages[1].content;
  const serverStart = user.indexOf('<server>');
  const c2Idx = user.indexOf('# zzz-last-by-name', serverStart);
  const c3Idx = user.indexOf('# aaa-first-by-name', serverStart);
  assert.ok(c2Idx !== -1 && c3Idx !== -1 && c2Idx < c3Idx, 'neighbours keep the order of the `neighbors` input');
});

test('buildRequest: a neighbour with no stored channel note is skipped, not synthesized', () => {
  const channels = [fakeChannel('c1', { name: 'general' })];
  const neighbors = [{ channelId: 'never-touched', channelName: 'never-touched', messages: [makeMessage(9, NOW - 5 * MIN)] }];
  const request = buildRequest(baseInput({ channels, currentChannelId: 'c1', neighbors }));
  const user = request.messages[1].content;
  const serverBlock = user.slice(user.indexOf('<server>'), user.indexOf('</server>'));
  assert.ok(serverBlock.includes('# general'));
  assert.ok(!serverBlock.includes('# never-touched'), 'a neighbour with no note must not appear in <server>');
  // It still contributes its messages to <other_channels>, unaffected by this feature.
  assert.ok(user.includes('<other_channels>'));
});

test('buildRequest: with no stored note for the current channel, its Discord facts and activity still render from history', () => {
  const history = [
    makeMessage(1, NOW - MIN, {
      channelId: 'c1',
      channelName: 'brand-new-channel',
      channelCategory: 'General',
      channelTopic: 'say hi',
    }),
  ];
  const request = buildRequest(baseInput({ history, channels: [], currentChannelId: 'c1' }));
  const user = request.messages[1].content;
  assert.ok(user.includes(`# brand-new-channel${labels.server.currentMark}`));
  assert.ok(user.includes(fill(labels.server.category, { text: 'General' })));
  assert.ok(user.includes(fill(labels.server.topic, { text: 'say hi' })));
  assert.ok(user.includes(`activity: ${labels.server.activityDead}`));
});

test('buildRequest: with no stored note and no channel facts anywhere in history, <server> stays empty', () => {
  const history = [makeMessage(1, NOW - MIN)];
  const request = buildRequest(baseInput({ history, channels: [], currentChannelId: 'c1' }));
  assert.ok(!request.messages[1].content.includes('<server>'));
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
  const neighbors = [{ channelId: 'c2', channelName: 'random', messages: [makeMessage(20, NOW - MIN)] }];
  // 340 was tight enough before the <senses> block grew a few lines
  // (stickers/lottie, part of the always-kept "fixed" section) so the
  // budget needs a little more headroom to still leave room for chat.
  const config = fakeConfig({ llm: { maxRequestTokens: 400, safetyMargin: 1 } });
  const request = buildRequest(baseInput({ history, channels, neighbors, currentChannelId: 'c1', config }));

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
  const grLabels = {
    ...labels,
    profile: { ...labels.profile, affinity: 'στάση: {score} ({band}) — {reason}' },
    affinity: { bands: { ...labels.affinity.bands, warm: 'ζεστή' } },
  };
  const profile = { id: 'p1', names: ['Κάρολος'], affinity: { score: 10, reason: 'βοήθησε', history: [] } };
  const text = renderProfile(profile, grLabels, { relationships: true });
  assert.ok(text.includes('στάση: 10 (ζεστή) — βοήθησε'));
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

test('renderProfile: a damped (fractional) score is rounded to an integer, the band still uses the precise value', () => {
  // 24.6 rounds to 25 for display, while the band itself is computed on the precise 24.6, which
  // is still "warm" (the "fond" threshold is 25 and up) -- see src/memory/affinity.js#affinityBand.
  const profile = { id: 'p1', names: ['Carl'], affinity: { score: 24.6, reason: 'saved my day', history: [] } };
  const text = renderProfile(profile, labels, { relationships: true });
  assert.ok(text.includes('attitude: 25 (warm) — saved my day'));
});

test('renderProfile: a profile with no affinity at all (pre-relationships data) renders as before', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm' };
  const text = renderProfile(profile, labels, { relationships: true });
  assert.equal(text, '## Carl\ncharacter: calm');
});

// --- renderProfile: episodes --------------------------------------------------

function episodeFixture(overrides = {}) {
  return { date: '2026-01-01', what: 'said something memorable', quote: 'never forget this', feeling: 'touched', weight: 3, addedAt: 'a', ...overrides };
}

test('renderProfile: episodes render only for the interlocutor, right after the attitude line', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    affinity: { score: 10, reason: 'nice', history: [] },
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: true, episodes: { enabled: true } });
  const lines = text.split('\n');
  assert.equal(lines[0], '## Carl -- INTERLOCUTOR, they are the one who called you');
  assert.equal(lines[1], 'attitude: 10 (warm) — nice');
  assert.equal(lines[2], labels.profile.episodes);
  assert.equal(lines[3], '2026-01-01: said something memorable — "never forget this" (touched)');
});

test('renderProfile: mark false keeps the full interlocutor rendering, episodes included, with a bare heading', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    affinity: { score: 10, reason: 'nice', history: [] },
    episodes: [episodeFixture()],
  };
  const options = { relationships: true, interlocutor: true, episodes: { enabled: true } };
  const marked = renderProfile(profile, labels, options).split('\n');
  const bare = renderProfile(profile, labels, { ...options, mark: false }).split('\n');
  assert.equal(bare[0], '## Carl');
  assert.deepEqual(bare.slice(1), marked.slice(1), 'only the heading changes');
  assert.equal(renderProfile(profile, labels, { ...options, mark: true }).split('\n')[0], marked[0], 'true is the default');
});

test('renderProfile: episodes are never rendered for a non-interlocutor profile without episodes.max', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', episodes: [episodeFixture()] };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: false, episodes: { enabled: true } });
  assert.ok(!text.includes(labels.profile.episodes));
});

test('renderProfile: episodes.max renders the top episodes of a non-interlocutor right after the attitude line', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    affinity: { score: 10, reason: 'nice', history: [] },
    episodes: [
      episodeFixture({ what: 'léger', weight: 1, quote: '' }),
      episodeFixture({ what: 'lourd', weight: 5, quote: '' }),
      episodeFixture({ what: 'moyen', weight: 3, quote: '' }),
    ],
  };
  const lines = renderProfile(profile, labels, { relationships: true, episodes: { enabled: true, max: 2 } }).split('\n');
  assert.deepEqual(lines, [
    '## Carl',
    'attitude: 10 (warm) — nice',
    labels.profile.episodes,
    fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'lourd', feeling: 'touched' }),
    fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'moyen', feeling: 'touched' }),
    'character: calm',
  ]);
  for (const max of [0, -2, 1.5, undefined]) {
    const text = renderProfile(profile, labels, { relationships: true, episodes: { enabled: true, max } });
    assert.ok(!text.includes(labels.profile.episodes), String(max));
  }
  assert.ok(!renderProfile(profile, labels, { relationships: true, episodes: { enabled: false, max: 2 } }).includes('lourd'));
  assert.ok(!renderProfile(profile, labels, { compact: true, relationships: true, episodes: { enabled: true, max: 2 } }).includes('lourd'));
});

test('renderProfile: a non-interlocutor capped below one episode shows no episodes heading', () => {
  const cost = (text) => estimateTokens(text) + 2;
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', episodes: [episodeFixture({ what: 'lourd', weight: 5 }), episodeFixture({ what: 'léger', weight: 1 })] };
  const bare = renderProfile(profile, labels, {});
  const headingOnly = cost(bare) + cost(labels.profile.episodes);
  assert.equal(renderProfile(profile, labels, { episodes: { enabled: true, max: 2, cap: headingOnly, cost } }), bare);
  const one = renderProfile(profile, labels, { episodes: { enabled: true, max: 2, cap: headingOnly + 1000, cost } });
  assert.ok(one.includes(labels.profile.episodes) && one.includes('lourd'));
  // Nothing else learned and not one episode fits: no profile at all.
  assert.equal(renderProfile({ ...profile, character: undefined }, labels, { episodes: { enabled: true, max: 2, cap: headingOnly, cost } }), '');
});

test('renderProfile: episodes.max never caps the interlocutor', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture({ what: 'un' }), episodeFixture({ what: 'deux' }), episodeFixture({ what: 'trois' })] };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, max: 1 } });
  for (const what of ['un', 'deux', 'trois']) assert.ok(text.includes(`: ${what} —`), what);
});

test('renderProfile: episodes are never rendered when episodes.enabled is false/absent', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture()] };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: true });
  assert.ok(!text.includes(labels.profile.episodes));
});

test('renderProfile: an episode with no quote uses profile.episodeNoQuote', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture({ quote: '' })] };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true } });
  assert.ok(text.includes('2026-01-01: said something memorable (touched)'));
  assert.ok(!text.includes('"'));
});

test('renderProfile: episodes render heaviest weight first, then newest', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    episodes: [
      episodeFixture({ what: 'light-old', weight: 1, date: '2026-01-01' }),
      episodeFixture({ what: 'heavy', weight: 5, date: '2026-01-01' }),
      episodeFixture({ what: 'light-new', weight: 1, date: '2026-02-01' }),
    ],
  };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true } });
  const order = ['heavy', 'light-new', 'light-old'].map((w) => text.indexOf(w));
  assert.ok(order[0] < order[1] && order[1] < order[2]);
});

test('renderProfile: episodes are not rendered when labels lack episode/episodeNoQuote/episodes keys', () => {
  const brokenLabels = { ...labels, profile: { ...labels.profile, episodes: undefined } };
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture()] };
  const text = renderProfile(profile, brokenLabels, { interlocutor: true, episodes: { enabled: true } });
  assert.ok(!text.includes('said something memorable'));
});

test('renderProfile: a tight episodes cap drops the lightest episodes first', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    episodes: [
      episodeFixture({ what: 'heaviest', weight: 5, quote: '' }),
      episodeFixture({ what: 'lightest', weight: 1, quote: '' }),
    ],
  };
  const cost = (text) => text.length; // a simple, deterministic stand-in for the real token cost
  const restText = renderProfile({ ...profile, episodes: [] }, labels, { interlocutor: true, episodes: { enabled: true } });
  const heading = labels.profile.episodes;
  const heavyLine = fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'heaviest', feeling: 'touched' });
  // Room for the rest of the profile plus exactly the heading and one episode line.
  const cap = cost(restText) + cost(heading) + cost(heavyLine);

  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, cap, cost } });
  assert.ok(text.includes('heaviest'));
  assert.ok(!text.includes('lightest'));
});

test('renderProfile: an episodes cap too small even for the heading renders no episodes at all', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture()] };
  const cost = (text) => text.length;
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, cap: 1, cost } });
  assert.ok(!text.includes(labels.profile.episodes));
});

// --- renderProfile: interests --------------------------------------------------

function interestFixture(overrides = {}) {
  return { topic: 'Chess', note: '', weight: 1, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders interests as "topic (note); topic", heaviest weight first', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Anime', note: 'watches shonen', weight: 2 }), interestFixture({ topic: 'Chess', note: '', weight: 5 })],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('interests: Chess; Anime (watches shonen)'));
});

test('renderProfile: a profile with no interests omits the line entirely', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', interests: [] };
  const text = renderProfile(profile, labels);
  assert.ok(!text.includes('interests:'));
});

test('renderProfile: interests render capped at maxInterests, the heaviest kept', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'A', weight: 1 }), interestFixture({ topic: 'B', weight: 3 }), interestFixture({ topic: 'C', weight: 2 })],
  };
  const text = renderProfile(profile, labels, { maxInterests: 2 });
  assert.ok(text.includes('interests: B; C'));
  assert.ok(!text.includes('interests: B; C; A'));
});

test('renderProfile: falls back to the built-in "topic (note)" / bare topic form when the item labels are missing', () => {
  const brokenLabels = { ...labels, profile: { ...labels.profile } };
  delete brokenLabels.profile.interestItem;
  delete brokenLabels.profile.interestItemNoNote;
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Chess', note: 'weekly club', weight: 2 }), interestFixture({ topic: 'Anime', note: '', weight: 1 })],
  };
  const text = renderProfile(profile, brokenLabels);
  assert.ok(text.includes('interests: Chess (weekly club); Anime'));
});

test('renderProfile: uses labels.profile.interestItem/interestItemNoNote when present', () => {
  const customLabels = { ...labels, profile: { ...labels.profile, interestItem: '[{topic}: {note}]', interestItemNoNote: '<{topic}>' } };
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Chess', note: 'weekly club', weight: 2 }), interestFixture({ topic: 'Anime', note: '', weight: 1 })],
  };
  const text = renderProfile(profile, customLabels);
  assert.ok(text.includes('interests: [Chess: weekly club]; <Anime>'));
});

test('buildRequest: interests render through renderProfile for both the interlocutor and other profiles', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const interlocutor = { id: 'author-1', names: ['Alice'], interests: [interestFixture({ topic: 'Chess', note: 'weekly club' })] };
  const request = buildRequest(
    baseInput({ history: [trigger], trigger, triggerKind: 'mention', interlocutor, otherProfiles: [] }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('interests: Chess (weekly club)'));
});

test('buildRequest: config.memory.maxInterests caps how many interests render', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const interlocutor = {
    id: 'author-1',
    names: ['Alice'],
    interests: [interestFixture({ topic: 'A', weight: 1 }), interestFixture({ topic: 'B', weight: 2 })],
  };
  const config = fakeConfig({ memory: { maxInterests: 1 } });
  const request = buildRequest(
    baseInput({ config, history: [trigger], trigger, triggerKind: 'mention', interlocutor, otherProfiles: [] }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('interests: B'));
  assert.ok(!user.includes('interests: B; A'));
});

// --- renderProfile: unsure/stale marks (opt-in via confirmAfter/staleDays) ----

test('renderProfile: without confirmAfter/staleDays, nothing is ever marked (back-compat)', () => {
  const profile = { id: 'p1', names: ['Carl'], interests: [interestFixture({ topic: 'Chess', weight: 1 })] };
  const text = renderProfile(profile, labels);
  assert.ok(!text.includes(labels.profile.unsureMark));
  assert.ok(!text.includes(labels.profile.staleMark));
});

test('renderProfile: an interest below confirmAfter renders with unsureMark, at/above it does not', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Chess', weight: 1 }), interestFixture({ topic: 'Anime', weight: 2 })],
  };
  const text = renderProfile(profile, labels, { confirmAfter: 2 });
  assert.ok(text.includes(`Chess${labels.profile.unsureMark}`));
  assert.ok(!text.includes(`Anime${labels.profile.unsureMark}`));
});

test('renderProfile: with interestHalfLifeDays, a much fresher interest outranks an older heavier one and sorts first; the older one still carries staleMark', () => {
  const now = Date.UTC(2026, 8, 21);
  const stale = interestFixture({ topic: 'Old', weight: 5, lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString() });
  const fresh = interestFixture({ topic: 'New', weight: 1, lastSeen: new Date(now - 1 * 24 * 3_600_000).toISOString() });
  const profile = { id: 'p1', names: ['Carl'], interests: [stale, fresh] };
  // A 90-day half-life makes the ~199-day recency gap (about 2.2 half-lives, +2.2
  // rank) outweigh the weight gap (log2(5.5) - log2(1.5) =~ 1.88 rank) between
  // the two -- see docs/prompt-contract.md, "More is stored than shown,
  // and rank decays with age". This REPLACES the old "fresh first, then weight
  // desc" sort with pure rank order.
  const text = renderProfile(profile, labels, { staleDays: 90, interestHalfLifeDays: 90, now });
  const interestsLine = text.split('\n').find((l) => l.startsWith('interests:'));
  assert.ok(interestsLine.includes(`New; Old${labels.profile.staleMark}`), `decay ranks the fresher one first, the older one still gets staleMark: ${interestsLine}`);
});

test('renderProfile: an interest can be both unsure and stale, unsureMark before staleMark', () => {
  const now = Date.UTC(2026, 8, 21);
  const item = interestFixture({ topic: 'Chess', weight: 1, lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString() });
  const profile = { id: 'p1', names: ['Carl'], interests: [item] };
  const text = renderProfile(profile, labels, { confirmAfter: 2, staleDays: 90, now });
  assert.ok(text.includes(`Chess${labels.profile.unsureMark}${labels.profile.staleMark}`));
});

test('renderProfile: a missing unsureMark/staleMark label appends nothing, never throws', () => {
  const now = Date.UTC(2026, 8, 21);
  const brokenLabels = { ...labels, profile: { ...labels.profile } };
  delete brokenLabels.profile.unsureMark;
  delete brokenLabels.profile.staleMark;
  const item = interestFixture({ topic: 'Chess', weight: 1, lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString() });
  const profile = { id: 'p1', names: ['Carl'], interests: [item] };
  const text = renderProfile(profile, brokenLabels, { confirmAfter: 2, staleDays: 90, now });
  assert.ok(text.includes('interests: Chess'));
  assert.ok(!text.includes('undefined'));
});

// --- renderProfile: details ----------------------------------------------------

function detailFixture(overrides = {}) {
  return { id: 1, text: 'Owns a cat', weight: 2, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders detail items joined by "; "', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    details: [detailFixture({ text: 'Owns a cat', weight: 3 }), detailFixture({ id: 2, text: 'Plays guitar', weight: 1 })],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('details: Owns a cat; Plays guitar'));
});

test('renderProfile: a profile with no details omits the line entirely', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', details: [] };
  const text = renderProfile(profile, labels);
  assert.ok(!text.includes('details:'));
});

test('renderProfile: details render capped at maxDetails, the top-ranked kept', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    details: [detailFixture({ id: 1, text: 'A', weight: 1 }), detailFixture({ id: 2, text: 'B', weight: 3 }), detailFixture({ id: 3, text: 'C', weight: 2 })],
  };
  const text = renderProfile(profile, labels, { maxDetails: 2 });
  assert.ok(text.includes('details: B; C'));
  assert.ok(!text.includes('details: B; C; A'));
});

test('renderProfile: with detailHalfLifeDays, a fresher detail outranks an older heavier one', () => {
  const now = Date.UTC(2026, 8, 21);
  const heavyOld = detailFixture({ id: 1, text: 'Ancient favorite fact', weight: 10, lastSeen: new Date(now - 5 * 365 * 24 * 3_600_000).toISOString() });
  const lightFresh = detailFixture({ id: 2, text: 'Fresh detail', weight: 1, lastSeen: new Date(now).toISOString() });
  const profile = { id: 'p1', names: ['Carl'], details: [heavyOld, lightFresh] };
  const text = renderProfile(profile, labels, { maxDetails: 1, detailHalfLifeDays: 180 });
  assert.ok(text.includes('details: Fresh detail'));
  assert.ok(!text.includes('Ancient favorite fact'));
});

test('buildRequest: config.memory.maxDetails caps how many details render', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const interlocutor = {
    id: 'author-1',
    names: ['Alice'],
    details: [detailFixture({ id: 1, text: 'A', weight: 1 }), detailFixture({ id: 2, text: 'B', weight: 2 })],
  };
  const config = fakeConfig({ memory: { maxDetails: 1 } });
  const request = buildRequest(
    baseInput({ config, history: [trigger], trigger, triggerKind: 'mention', interlocutor, otherProfiles: [] }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('details: B'));
  assert.ok(!user.includes('details: B; A'));
});

test('renderProfile: an unconfirmed detail renders with unsureMark, details never get the stale mark', () => {
  const now = Date.UTC(2026, 8, 21);
  const unsure = detailFixture({ id: 1, text: 'Owns a cat', weight: 1, lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString() });
  const confirmed = detailFixture({ id: 2, text: 'Plays guitar', weight: 2 });
  const profile = { id: 'p1', names: ['Carl'], details: [unsure, confirmed] };
  const text = renderProfile(profile, labels, { confirmAfter: 2, staleDays: 90, now });
  assert.ok(text.includes(`Owns a cat${labels.profile.unsureMark}`));
  assert.ok(!text.includes(`Owns a cat${labels.profile.unsureMark}${labels.profile.staleMark}`), 'no stale mark for details');
  assert.ok(text.includes('Plays guitar'));
  assert.ok(!text.includes(`Plays guitar${labels.profile.unsureMark}`));
});

test('buildRequest: interlocutor/other-profile marks read memory.confirmAfter/interestStaleDays from the live config', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const interlocutor = { id: 'author-1', names: ['Alice'], interests: [interestFixture({ topic: 'Chess', weight: 1 })] };
  const config = fakeConfig({ memory: { confirmAfter: 2 } });
  const request = buildRequest(baseInput({ config, history: [trigger], trigger, triggerKind: 'mention', interlocutor, otherProfiles: [] }));
  const user = request.messages[1].content;
  assert.ok(user.includes(`Chess${labels.profile.unsureMark}`));
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
  const grLabels = {
    ...labels,
    locale: 'el-GR',
    self: '{name} (εσύ)',
    triggers: { mention: 'σε ετικέτησε', reply: 'σου απάντησε', name: 'σε φώναξε με τ\' όνομα' },
  };
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(
    baseInput({ prompts: fakePrompts({ labels: grLabels }), history: [trigger], trigger, triggerKind: 'mention' }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('σε ετικέτησε'));
  assert.ok(user.includes('<now>'));
  assert.ok(user.includes('<task>'));
});

// --- <senses> ------------------------------------------------------------

function sensesOf(request) {
  const user = request.messages[1].content;
  const text = Array.isArray(user) ? user.find((part) => part.type === 'text').text : user;
  const match = /<senses>\n([\s\S]*?)\n<\/senses>/.exec(text);
  return match ? match[1] : null;
}

test('buildRequest: <senses> sits right after <now>', () => {
  const request = buildRequest(baseInput());
  const user = request.messages[1].content;
  const nowIdx = user.indexOf('<now>');
  const sensesIdx = user.indexOf('<senses>');
  assert.ok(sensesIdx !== -1 && sensesIdx > nowIdx);
  assert.ok(sensesIdx < user.indexOf('</now>') + 20); // right after, not somewhere far down
});

test('buildRequest: vision on, mediaDescriptions off -> imageSee + blind forms', () => {
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: false } });
  const request = buildRequest(baseInput({ config }));
  const senses = sensesOf(request);
  assert.ok(senses.includes(labels.senses.imageSee));
  assert.ok(senses.includes(labels.senses.imageBlind));
  assert.ok(!senses.includes(labels.senses.imageDescribed));
  assert.ok(senses.includes(labels.senses.gifBlind));
  assert.ok(senses.includes(labels.senses.videoBlind));
  assert.ok(senses.includes(labels.senses.voice));
  assert.ok(senses.includes(labels.senses.links));
  assert.ok(senses.includes(labels.senses.files));
});

test('buildRequest: vision off -> no imageSee line, blind forms still shown', () => {
  const config = fakeConfig({ features: { vision: false } });
  const request = buildRequest(baseInput({ config }));
  const senses = sensesOf(request);
  assert.ok(!senses.includes(labels.senses.imageSee));
  assert.ok(senses.includes(labels.senses.imageBlind));
});

test('buildRequest: mediaDescriptions on -> described forms replace the blind ones', () => {
  // videoDescriptions off pins the still-frame video line (with it on, the
  // video line becomes videoWatch -- see the video-watching tests below).
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true, videoDescriptions: false } });
  const request = buildRequest(baseInput({ config }));
  const senses = sensesOf(request);
  assert.ok(senses.includes(labels.senses.imageDescribed));
  assert.ok(senses.includes(labels.senses.gifDescribed));
  assert.ok(senses.includes(labels.senses.videoDescribed));
  assert.ok(!senses.includes(labels.senses.imageBlind));
  assert.ok(!senses.includes(labels.senses.gifBlind));
  assert.ok(!senses.includes(labels.senses.videoBlind));
});

// --- <senses>: GIF watching -------------------------------------------------------

/** The GIF line of a request's <senses> block under `config` and `prompts` overrides. */
function gifSenses({ features = {}, media, prompts = {}, labelsOverride } = {}) {
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true, ...features } });
  if (media) config.media = media;
  const promptSet = fakePrompts({ ...(labelsOverride ? { labels: labelsOverride } : {}), ...prompts });
  return sensesOf(buildRequest(baseInput({ config, prompts: promptSet }))).split('\n');
}

test('buildRequest: GIFs watched (video vision on, a watch prompt) -> senses.gifWatched, never gifDescribed', () => {
  for (const prompts of [{ 'describe-video': 'V' }, { 'describe-gif': 'G' }, { 'describe-video': 'V', 'describe-gif': 'G' }]) {
    const lines = gifSenses({ prompts });
    assert.ok(lines.includes(labels.senses.gifWatched), JSON.stringify(Object.keys(prompts)));
    assert.ok(!lines.includes(labels.senses.gifDescribed));
    assert.ok(!lines.includes(labels.senses.gifBlind));
  }
  // media.gif.watch true or missing both count as on.
  assert.ok(gifSenses({ prompts: { 'describe-video': 'V' }, media: { gif: { watch: true } } }).includes(labels.senses.gifWatched));
});

test('buildRequest: GIFs not watched -> senses.gifDescribed', () => {
  const states = [
    { prompts: {} },
    { prompts: { 'describe-video': '' } },
    { prompts: { 'describe-video': 'V' }, media: { gif: { watch: false } } },
    { prompts: { 'describe-video': 'V' }, features: { videoDescriptions: false } },
  ];
  for (const state of states) {
    const lines = gifSenses(state);
    assert.ok(lines.includes(labels.senses.gifDescribed), JSON.stringify(state));
    assert.ok(!lines.includes(labels.senses.gifWatched));
  }
});

test('buildRequest: mediaDescriptions off -> senses.gifBlind even with GIF watching configured', () => {
  const lines = gifSenses({ features: { mediaDescriptions: false }, prompts: { 'describe-video': 'V', 'describe-gif': 'G' } });
  assert.ok(lines.includes(labels.senses.gifBlind));
  assert.ok(!lines.includes(labels.senses.gifWatched));
  assert.ok(!lines.includes(labels.senses.gifDescribed));
});

test('buildRequest: an older labels.json without senses.gifWatched keeps senses.gifDescribed while GIFs are watched', () => {
  const { gifWatched, ...olderSenses } = labels.senses;
  assert.ok(gifWatched);
  const lines = gifSenses({ prompts: { 'describe-video': 'V' }, labelsOverride: { ...labels, senses: olderSenses } });
  assert.ok(lines.includes(labels.senses.gifDescribed));
});

// --- <senses>: video watching ---------------------------------------------------

test('buildRequest: mediaDescriptions on, videoDescriptions missing (counts as on) -> videoWatch and linksWatch', () => {
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true } });
  const senses = sensesOf(buildRequest(baseInput({ config })));
  assert.ok(senses.includes(labels.senses.videoWatch));
  assert.ok(senses.includes(labels.senses.linksWatch));
  assert.ok(!senses.includes(labels.senses.videoDescribed));
  assert.ok(!senses.includes(labels.senses.videoBlind));
  assert.ok(!senses.split('\n').includes(labels.senses.links));
});

test('buildRequest: videoDescriptions false -> the still-frame video line and the plain links line', () => {
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true, videoDescriptions: false } });
  const senses = sensesOf(buildRequest(baseInput({ config })));
  assert.ok(senses.includes(labels.senses.videoDescribed));
  assert.ok(senses.split('\n').includes(labels.senses.links));
  assert.ok(!senses.includes(labels.senses.videoWatch));
  assert.ok(!senses.includes(labels.senses.linksWatch));
});

test('buildRequest: mediaDescriptions off -> no video watching even with videoDescriptions on', () => {
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: false, videoDescriptions: true } });
  const senses = sensesOf(buildRequest(baseInput({ config })));
  assert.ok(senses.includes(labels.senses.videoBlind));
  assert.ok(senses.split('\n').includes(labels.senses.links));
  assert.ok(!senses.includes(labels.senses.videoWatch));
  assert.ok(!senses.includes(labels.senses.linksWatch));
});

test('buildRequest: an older labels set without videoWatch/linksWatch falls back to videoDescribed/links', () => {
  const oldLabels = { ...labels, senses: { ...labels.senses, videoWatch: undefined, linksWatch: undefined } };
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true } });
  const senses = sensesOf(buildRequest(baseInput({ config, prompts: fakePrompts({ labels: oldLabels }) })));
  assert.ok(senses.includes(labels.senses.videoDescribed));
  assert.ok(senses.split('\n').includes(labels.senses.links));
});

test('buildRequest: <senses> is omitted entirely when labels has no senses section', () => {
  const brokenLabels = { ...labels, senses: undefined };
  const request = buildRequest(baseInput({ prompts: fakePrompts({ labels: brokenLabels }) }));
  const user = request.messages[1].content;
  assert.ok(!user.includes('<senses>'));
});

// --- <senses>: stickers/Lottie -----------------------------------------------

test('buildRequest: vision on, mediaDescriptions off -> stickerSee + stickerBlind + lottie', () => {
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: false } });
  const request = buildRequest(baseInput({ config }));
  const senses = sensesOf(request);
  assert.ok(senses.includes(labels.senses.stickerSee));
  assert.ok(senses.includes(labels.senses.stickerBlind));
  assert.ok(!senses.includes(labels.senses.stickerDescribed));
  assert.ok(senses.includes(labels.senses.lottie));
});

test('buildRequest: vision off -> no stickerSee line, stickerBlind and lottie still shown', () => {
  const config = fakeConfig({ features: { vision: false } });
  const request = buildRequest(baseInput({ config }));
  const senses = sensesOf(request);
  assert.ok(!senses.includes(labels.senses.stickerSee));
  assert.ok(senses.includes(labels.senses.stickerBlind));
  assert.ok(senses.includes(labels.senses.lottie));
});

test('buildRequest: mediaDescriptions on -> stickerDescribed replaces stickerBlind, lottie still shown', () => {
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true } });
  const request = buildRequest(baseInput({ config }));
  const senses = sensesOf(request);
  assert.ok(senses.includes(labels.senses.stickerDescribed));
  assert.ok(!senses.includes(labels.senses.stickerBlind));
  assert.ok(senses.includes(labels.senses.lottie));
});

test('buildRequest: an older labels.json with no sticker senses keys omits them (and lottie) without breaking the rest', () => {
  const oldLabels = { ...labels, senses: { ...labels.senses, stickerSee: undefined, stickerDescribed: undefined, stickerBlind: undefined } };
  const request = buildRequest(baseInput({ prompts: fakePrompts({ labels: oldLabels }) }));
  const senses = sensesOf(request);
  assert.ok(!senses.includes(labels.senses.lottie));
  assert.ok(senses.includes(labels.senses.imageSee));
});

// --- <lore> ------------------------------------------------------------------

function loreEntry(overrides = {}) {
  return { id: 'l1', title: 'The Great Flood', keys: ['flood'], text: 'It flooded once.', always: false, source: 'analyzer', weight: 3, ...overrides };
}

test('buildRequest: <lore> sits after <server> and before <self_facts>', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'remember the flood?' })];
  const request = buildRequest(
    baseInput({
      history,
      guildMemory: { self: ['likes tea'] },
      channels: [{ id: 'c1', name: 'general', lastMessageAt: NOW, days: {} }],
      currentChannelId: 'c1',
      loreEntries: [loreEntry()],
    }),
  );
  const user = request.messages[1].content;
  const serverIdx = user.indexOf('<server>');
  const loreIdx = user.indexOf('<lore>');
  const selfIdx = user.indexOf('<self_facts>');
  assert.ok(serverIdx !== -1 && loreIdx !== -1 && selfIdx !== -1);
  assert.ok(serverIdx < loreIdx && loreIdx < selfIdx);
  assert.ok(user.includes(labels.lore.entry.replace('{title}', 'The Great Flood').replace('{text}', 'It flooded once.')));
});

test('buildRequest: no <lore> block when nothing matches the recent chat', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'completely unrelated chatter' })];
  const request = buildRequest(baseInput({ history, loreEntries: [loreEntry()] }));
  assert.ok(!request.messages[1].content.includes('<lore>'));
});

test('buildRequest: no <lore> block when there is no stored lore at all', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'the flood happened' })];
  const request = buildRequest(baseInput({ history, loreEntries: [] }));
  assert.ok(!request.messages[1].content.includes('<lore>'));
});

test('buildRequest: an "always" lore entry appears even without a textual match', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'nothing relevant here' })];
  const request = buildRequest(baseInput({ history, loreEntries: [loreEntry({ always: true, keys: ['never-said'] })] }));
  assert.ok(request.messages[1].content.includes('<lore>'));
});

test('buildRequest: features.lore=false never renders <lore>, even with a match', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'the flood happened' })];
  const config = fakeConfig({ features: { lore: false } });
  const request = buildRequest(baseInput({ history, config, loreEntries: [loreEntry()] }));
  assert.ok(!request.messages[1].content.includes('<lore>'));
});

test('buildRequest: <lore> is omitted when labels.lore.entry is missing (older labels.json)', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'the flood happened' })];
  const brokenLabels = { ...labels, lore: undefined };
  const request = buildRequest(
    baseInput({ history, prompts: fakePrompts({ labels: brokenLabels }), loreEntries: [loreEntry()] }),
  );
  assert.ok(!request.messages[1].content.includes('<lore>'));
});

test('buildRequest: the trigger message also counts toward the lore scan window', () => {
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Alice', content: 'the flood story again' });
  const history = [makeMessage(1, NOW - 2 * MIN, { content: 'unrelated' }), trigger];
  const request = buildRequest(baseInput({ history, trigger, triggerKind: 'mention', loreEntries: [loreEntry()] }));
  assert.ok(request.messages[1].content.includes('<lore>'));
});

test('buildRequest: under a tiny lore cap, only the entries that fit survive', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'flood and fire, the two old stories' })];
  const config = fakeConfig({ context: { caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1 } } });
  const request = buildRequest(
    baseInput({
      history,
      config,
      loreEntries: [loreEntry({ id: 'l1', title: 'Flood', keys: ['flood'], text: 'x'.repeat(200) }), loreEntry({ id: 'l2', title: 'Fire', keys: ['fire'], text: 'y'.repeat(200) })],
    }),
  );
  assert.equal(request.stats.lore.kept, 0);
});

// --- renderProfile: aliases -----------------------------------------------------

function aliasFixture(overrides = {}) {
  return { name: 'Ari', weight: 2, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders aliases through labels.profile.aliases, comma-separated, top-ranked first', () => {
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ar', weight: 1 }), aliasFixture({ name: 'Ari', weight: 5 })],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('Called: Ari, Ar'));
});

test('renderProfile: an unranked-cap maxAliases shows only the top N', () => {
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ar', weight: 1 }), aliasFixture({ name: 'Ari', weight: 5 })],
  };
  const text = renderProfile(profile, labels, { maxAliases: 1 });
  assert.ok(text.includes('Called: Ari'));
  assert.ok(!text.includes('Called: Ari, Ar'));
});

test('renderProfile: no aliases line when the profile has none, or when labels.profile.aliases is missing', () => {
  const profile = { id: 'p1', names: ['Aria'], character: 'calm' };
  assert.ok(!renderProfile(profile, labels).includes('Called:'));

  const withAliases = { id: 'p1', names: ['Aria'], aliases: [aliasFixture()] };
  const brokenLabels = { ...labels, profile: { ...labels.profile, aliases: undefined } };
  assert.ok(!renderProfile(withAliases, brokenLabels).includes('Called:'));
});

// --- renderProfile: <@id> tokens resolved for the chat model -------------------

test('renderProfile: character/style/relationship resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'gets along with <@223456789012345678>',
    style: 'quotes <@223456789012345678> a lot',
    relationship: 'trusts <@223456789012345678>',
  };
  const text = renderProfile(profile, labels, { nameOf: (id) => (id === '223456789012345678' ? 'Dana' : null) });
  assert.ok(text.includes('character: gets along with Dana'));
  assert.ok(text.includes('style: quotes Dana a lot'));
  assert.ok(text.includes('relationship with you: trusts Dana'));
});

test('renderProfile: an id nameOf cannot resolve renders the bare token', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'knows <@223456789012345678>' };
  const text = renderProfile(profile, labels, { nameOf: () => null });
  assert.ok(text.includes('character: knows <@223456789012345678>'));
});

test('renderProfile: without nameOf, a stored token renders exactly as-is (no crash)', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'knows <@223456789012345678>' };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('character: knows <@223456789012345678>'));
});

test('renderProfile: interest note and detail text resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Chess', note: 'plays with <@223456789012345678>' })],
    details: [detailFixture({ text: 'a gift from <@223456789012345678>' })],
  };
  const text = renderProfile(profile, labels, { nameOf: (id) => (id === '223456789012345678' ? 'Dana' : null) });
  assert.ok(text.includes('Chess (plays with Dana)'));
  assert.ok(text.includes('a gift from Dana'));
});

test('renderProfile: episode "what"/"feeling" resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    episodes: [episodeFixture({ what: 'argued with <@223456789012345678>', feeling: 'annoyed at <@223456789012345678>', quote: '' })],
  };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true }, nameOf: (id) => (id === '223456789012345678' ? 'Dana' : null) });
  assert.ok(text.includes('argued with Dana'));
  assert.ok(text.includes('annoyed at Dana'));
});

test('renderProfile: the affinity reason resolves <@id> tokens via nameOf', () => {
  const profile = { id: 'p1', names: ['Carl'], affinity: { score: 10, reason: 'stood up for <@223456789012345678>', history: [] } };
  const text = renderProfile(profile, labels, { relationships: true, nameOf: (id) => (id === '223456789012345678' ? 'Dana' : null) });
  assert.ok(text.includes('stood up for Dana'));
});

// --- buildRequest: <@id> tokens resolved for the chat model, wired through ------

test('buildRequest: about_chat/self_facts/lore/server resolve <@id> tokens via input.nameOf', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'the incident again' })];
  const guildMemory = { patterns: 'people quote <@223456789012345678>', starters: '<@223456789012345678> starts it', injokes: ['<@223456789012345678> did it'], self: ['met <@223456789012345678> once'] };
  const channels = [{ id: 'c1', name: 'general', purpose: '<@223456789012345678> posts here', topics: 'stuff', tone: 'calm' }];
  const request = buildRequest(
    baseInput({
      history,
      guildMemory,
      channels,
      currentChannelId: 'c1',
      loreEntries: [loreEntry({ id: 'l1', title: 'incident', keys: ['incident'], text: '<@223456789012345678> caused it' })],
      nameOf: (id) => (id === '223456789012345678' ? 'Dana' : null),
    }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('people quote Dana'));
  assert.ok(user.includes('Dana starts it'));
  assert.ok(user.includes('Dana did it'));
  assert.ok(user.includes('met Dana once'));
  assert.ok(user.includes('Dana posts here'));
  assert.ok(user.includes('Dana caused it'));
});

// --- buildRequest: silent members pulled into <people> by name/alias -----------

test('buildRequest: a silent member whose current name occurs in the transcript is pulled into <people>', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'Dana would love this joke' })];
  const candidateProfiles = [{ id: 'p9', names: ['Dana'], character: 'sarcastic' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const user = request.messages[1].content;
  assert.ok(user.includes('## Dana'));
  assert.ok(user.includes('character: sarcastic'));
});

test('buildRequest: a silent member is pulled in by a shown alias, not just their display name', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'ask Vertex about it' })];
  const candidateProfiles = [
    { id: 'p9', names: ['LongOfficialName'], character: 'helpful', aliases: [aliasFixture({ name: 'Vertex', weight: 5 })] },
  ];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const user = request.messages[1].content;
  assert.ok(user.includes('## LongOfficialName'));
  assert.ok(user.includes('character: helpful'));
});

test('buildRequest: names/aliases shorter than 3 characters never trigger a pull-in', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'oh no, an ox ran off' })];
  const candidateProfiles = [{ id: 'p9', names: ['Ox'], character: 'stubborn' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  assert.ok(!request.messages[1].content.includes('character: stubborn'));
});

test('buildRequest: a candidate never mentioned in the transcript is not pulled in', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'nothing about anyone else here' })];
  const candidateProfiles = [{ id: 'p9', names: ['Dana'], character: 'sarcastic' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  assert.ok(!request.messages[1].content.includes('## Dana'));
});

test('buildRequest: a candidate already covered as the interlocutor or an active participant is not duplicated', () => {
  const trigger = makeMessage(2, NOW - MIN, { authorId: 'p9', authorName: 'Dana', content: 'Dana here, hi' });
  const history = [trigger];
  const interlocutor = { id: 'p9', names: ['Dana'], character: 'sarcastic' };
  const candidateProfiles = [interlocutor];
  const request = buildRequest(baseInput({ history, trigger, triggerKind: 'mention', interlocutor, candidateProfiles }));
  const user = request.messages[1].content;
  assert.equal((user.match(/## Dana/g) ?? []).length, 1, 'Dana appears once, as the interlocutor, not twice');
});

test('buildRequest: a silent member named in the trigger/recent messages (asked-about) is rendered BEFORE a plain active participant', () => {
  const history = [makeMessage(1, NOW - MIN, { authorName: 'Carl', content: 'Dana would find this funny' })];
  const otherProfiles = [{ id: 'p2', names: ['Carl'], character: 'talkative' }];
  const candidateProfiles = [{ id: 'p9', names: ['Dana'], character: 'sarcastic' }];
  const request = buildRequest(baseInput({ history, otherProfiles, candidateProfiles }));
  const user = request.messages[1].content;
  const carlIdx = user.indexOf('## Carl');
  const danaIdx = user.indexOf('## Dana');
  // Dana is named in the trigger/recent-messages window -- priority (b), rendered FULL and first.
  // Carl only spoke -- priority (c), rendered COMPACT and after: the budget trims (c) before (b).
  assert.ok(danaIdx !== -1 && carlIdx !== -1 && danaIdx < carlIdx);
  assert.ok(user.includes('character: sarcastic'), 'Dana (asked-about) is rendered in full');
});

test('buildRequest: no candidateProfiles at all pulls nobody in and never throws', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'Dana would love this joke' })];
  const request = buildRequest(baseInput({ history }));
  assert.ok(!request.messages[1].content.includes('## Dana'));
});

// --- renderProfile: compact -------------------------------------------------------

test('renderProfile: compact renders current name, aliases, character, attitude and up to 5 bare-topic interests -- nothing else', () => {
  const profile = {
    id: 'p1',
    names: ['Carl', 'OldCarl'],
    aliases: [aliasFixture({ name: 'Carlito', weight: 5 })],
    character: 'calm',
    style: 'terse',
    relationship: 'friendly rival',
    messageCount: 42,
    affinity: { score: 10, reason: 'helped once', history: [] },
    interests: [
      interestFixture({ topic: 'Chess', note: 'weekly club', weight: 6 }),
      interestFixture({ topic: 'Anime', note: '', weight: 5 }),
      interestFixture({ topic: 'Coffee', note: '', weight: 4 }),
      interestFixture({ topic: 'Hiking', note: '', weight: 3 }),
      interestFixture({ topic: 'Chess variants', note: '', weight: 2 }),
      interestFixture({ topic: 'Bonsai', note: '', weight: 1 }),
    ],
    details: [{ id: 'd1', text: 'lives nearby', weight: 3 }],
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { compact: true, relationships: true });
  assert.equal(
    text,
    [
      '## Carl',
      'attitude: 10 (warm) — helped once',
      'Called: Carlito',
      'character: calm',
      'interests: Chess; Anime; Coffee; Hiking; Chess variants',
    ].join('\n'),
  );
});

test('renderProfile: compact omits former names, style, details, relationship, message count and episodes', () => {
  const profile = {
    id: 'p1',
    names: ['Carl', 'OldCarl'],
    character: 'calm',
    style: 'terse',
    relationship: 'friendly rival',
    messageCount: 42,
    interests: [interestFixture({ topic: 'Chess', note: 'weekly club', weight: 6 })],
    details: [{ id: 'd1', text: 'lives nearby', weight: 3 }],
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { compact: true, interlocutor: true, episodes: { enabled: true } });
  assert.ok(!text.includes('formerly known as'));
  assert.ok(!text.includes('style:'));
  assert.ok(!text.includes('details:'));
  assert.ok(!text.includes('relationship with you:'));
  assert.ok(!text.includes('messages you have seen'));
  assert.ok(!text.includes(labels.profile.episodes));
  assert.ok(!text.includes('(weekly club)'), 'compact interests drop the note');
});

test('renderProfile: compact interests cap at 5 regardless of maxInterests', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'A', weight: 6 }),
      interestFixture({ topic: 'B', weight: 5 }),
      interestFixture({ topic: 'C', weight: 4 }),
      interestFixture({ topic: 'D', weight: 3 }),
      interestFixture({ topic: 'E', weight: 2 }),
      interestFixture({ topic: 'F', weight: 1 }),
    ],
  };
  const text = renderProfile(profile, labels, { compact: true, maxInterests: 100 });
  assert.ok(text.includes('interests: A; B; C; D; E'));
  assert.ok(!text.includes('F'));
});

// --- buildRequest: <people> priority (a)/(b)/(c) --------------------------------

test('buildRequest: a name of 4+ characters also matches as the START of a longer word in the transcript', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'ask Vertexia about it' })];
  const candidateProfiles = [{ id: 'p9', names: ['Vertex'], character: 'helpful' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const user = request.messages[1].content;
  assert.ok(user.includes('## Vertex'));
});

test('buildRequest: a name of exactly 3 characters must match a WHOLE word, never as a prefix', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'the maximum output is high' })];
  const candidateProfiles = [{ id: 'p9', names: ['Max'], character: 'brief' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const user = request.messages[1].content;
  assert.ok(!user.includes('## Max'), '"maximum" must not match the 3-character name "Max" as a prefix');
});

test('buildRequest: a name of exactly 3 characters still matches a whole word', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'ask Max about it' })];
  const candidateProfiles = [{ id: 'p9', names: ['Max'], character: 'brief' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const user = request.messages[1].content;
  assert.ok(user.includes('## Max'));
});

test('buildRequest: a real @mention (mentionedUserIds) pulls a silent member in even when their name is never written out', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'hey what do you think of them', mentionedUserIds: ['p9'] })];
  const candidateProfiles = [{ id: 'p9', names: ['Quinn'], character: 'quiet' }];
  const request = buildRequest(baseInput({ history, candidateProfiles }));
  const user = request.messages[1].content;
  assert.ok(user.includes('## Quinn'));
});

test('buildRequest: an active participant explicitly @mentioned in the trigger is promoted to FULL, ahead of plain compact participants', () => {
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Asker', content: 'what does Carl think', mentionedUserIds: ['p2'] });
  const history = [makeMessage(1, NOW - 2 * MIN, { authorName: 'Dana', content: 'nothing interesting' }), trigger];
  const otherProfiles = [
    { id: 'p3', names: ['Dana'], character: 'x'.repeat(50) },
    { id: 'p2', names: ['Carl'], character: 'talkative', style: 'blunt', relationship: 'ally' },
  ];
  const request = buildRequest(baseInput({ history, trigger, triggerKind: 'mention', otherProfiles }));
  const user = request.messages[1].content;
  const carlIdx = user.indexOf('## Carl');
  const danaIdx = user.indexOf('## Dana');
  assert.ok(carlIdx !== -1 && danaIdx !== -1 && carlIdx < danaIdx, 'Carl (asked-about) is rendered before Dana (plain participant)');
  assert.ok(user.includes('style: blunt'), 'Carl is rendered in full, not compact');
});

test('context.askedAboutProfiles caps how many members priority (b) may hold; the rest fall back to compact participants', () => {
  const trigger = makeMessage(3, NOW - MIN, { authorName: 'Asker', content: 'Ann, Bob and Cid, what do you all think' });
  const otherProfiles = [
    { id: 'p1', names: ['Ann'], character: 'a' },
    { id: 'p2', names: ['Bob'], character: 'b' },
    { id: 'p3', names: ['Cid'], character: 'c' },
  ];
  const config = fakeConfig({ context: { caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 }, askedAboutProfiles: 2 } });
  const request = buildRequest(baseInput({ config, history: [trigger], trigger, triggerKind: 'mention', otherProfiles }));
  const user = request.messages[1].content;
  // Ann and Bob (the first two participants checked, in order) are promoted to priority (b);
  // Cid, matched too but past the cap, stays a plain compact participant (priority (c)).
  const annIdx = user.indexOf('## Ann');
  const bobIdx = user.indexOf('## Bob');
  const cidIdx = user.indexOf('## Cid');
  assert.ok(annIdx !== -1 && bobIdx !== -1 && cidIdx !== -1);
  assert.ok(cidIdx > annIdx && cidIdx > bobIdx, 'the member past the cap renders after the promoted ones');
});

test('buildRequest: under a tight caps.people, the member asked about survives while active participants are trimmed', () => {
  // Reproduces the measured regression: six active participants blowing a 4k
  // cap dropped the one member the caller was actually asking about.
  const trigger = makeMessage(7, NOW - MIN, { authorName: 'Asker', content: 'what is Wanda up to lately' });
  const otherProfiles = Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`,
    names: [`Member${i}`],
    character: 'x'.repeat(1000),
  }));
  const candidateProfiles = [{ id: 'target', names: ['Wanda'], character: 'brief and sharp' }];
  const config = fakeConfig({ context: { caps: { interlocutor: 2500, aboutChat: 2500, people: 900, neighbors: 3000, server: 2500, lore: 1500 } } });
  const request = buildRequest(
    baseInput({ config, history: [trigger], trigger, triggerKind: 'mention', otherProfiles, candidateProfiles }),
  );
  const user = request.messages[1].content;
  assert.ok(user.includes('## Wanda'), 'the member asked about must survive the tight cap');
  assert.ok(request.stats.people.dropped > 0, 'at least one active participant is trimmed under the tight cap');
});

// --- <people>: episodes of the members asked about (context.askedAboutEpisodes) -----

/** Five moments of one member: heaviest-then-newest order is ε5, ε4, ε3, ε2, ε1. */
function askedEpisodes() {
  return [
    episodeFixture({ what: 'ε1 στιγμή', weight: 1, date: '2026-09-01', quote: '' }),
    episodeFixture({ what: 'ε4 στιγμή', weight: 4, date: '2026-08-01', quote: '' }),
    episodeFixture({ what: 'ε5 στιγμή', weight: 4, date: '2026-09-10', quote: 'ποτέ ξανά' }),
    episodeFixture({ what: 'ε2 στιγμή', weight: 2, date: '2026-09-15', quote: '' }),
    episodeFixture({ what: 'ε3 στιγμή', weight: 3, date: '2026-07-01', quote: '' }),
  ];
}

/** A turn whose trigger asks about Zoé, a silent member with five episodes; `people` is the `<people>` body. */
function askedAboutScene({ context = {}, zoe = {}, ...overrides } = {}) {
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Ana', content: 'τι έκανε η Zoé χθες;' });
  const input = baseInput({
    config: fakeConfig({ context }),
    history: [trigger],
    trigger,
    triggerKind: 'mention',
    candidateProfiles: [{ id: 'z1', names: ['Zoé'], character: 'rêveuse', episodes: askedEpisodes(), ...zoe }],
    ...overrides,
  });
  const request = buildRequest(input);
  return { request, people: bodyOf(userText(request), 'people') ?? '' };
}

test('people: an asked-about member renders up to askedAboutEpisodes episodes, heaviest first', () => {
  const { people } = askedAboutScene();
  const lines = people.split('\n');
  assert.equal(lines[0], '## Zoé');
  assert.equal(lines[1], labels.profile.episodes, 'right after the heading, where the interlocutor has them');
  assert.equal(lines[2], fill(labels.profile.episode, { date: '2026-09-10', what: 'ε5 στιγμή', quote: 'ποτέ ξανά', feeling: 'touched' }));
  assert.equal(lines[3], fill(labels.profile.episodeNoQuote, { date: '2026-08-01', what: 'ε4 στιγμή', feeling: 'touched' }));
  assert.equal(lines[4], fill(labels.profile.episodeNoQuote, { date: '2026-07-01', what: 'ε3 στιγμή', feeling: 'touched' }));
  assert.equal(lines[5], 'character: rêveuse');
  assert.ok(!people.includes('ε2') && !people.includes('ε1'), 'the code default is 3, as in config.json');

  const two = askedAboutScene({ context: { askedAboutEpisodes: 2 } }).people;
  assert.ok(two.includes('ε5') && two.includes('ε4') && !two.includes('ε3'));
});

test('people: askedAboutEpisodes 0 renders none', () => {
  for (const askedAboutEpisodes of [0, -1, 1.5, '3']) {
    const { people } = askedAboutScene({ context: { askedAboutEpisodes } });
    assert.ok(people.includes('## Zoé') && people.includes('character: rêveuse'), 'the profile itself stays');
    assert.ok(!people.includes(labels.profile.episodes) && !people.includes('στιγμή'), String(askedAboutEpisodes));
  }
  const off = askedAboutScene({ config: fakeConfig({ features: { episodes: false } }) }).people;
  assert.ok(off.includes('## Zoé') && !off.includes('στιγμή'), 'features.episodes false renders none either');
});

test('people: a compact participant still renders no episodes', () => {
  const carl = { id: 'p2', names: ['Carl'], character: 'calm', episodes: askedEpisodes() };
  const history = [makeMessage(2, NOW - 2 * MIN, { authorId: 'p2', authorName: 'Carl', content: 'καλημέρα' })];
  const { people } = askedAboutScene({ history: [...history, makeMessage(1, NOW - MIN, { authorId: 'u1', content: 'τι νέα;' })], trigger: null, otherProfiles: [carl] });
  assert.ok(people.startsWith('## Carl'), people);
  assert.ok(!people.includes(labels.profile.episodes) && !people.includes('στιγμή'));
});

test('people: the interlocutor still renders every episode within caps.interlocutor', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Ana', content: 'γεια' });
  const interlocutor = { id: 'u1', names: ['Ana'], character: 'vive', episodes: askedEpisodes() };
  const own = (context) =>
    bodyOf(userText(buildRequest(baseInput({ config: fakeConfig({ context }), history: [trigger], trigger, triggerKind: 'mention', interlocutor }))), 'people');
  const shown = own({ askedAboutEpisodes: 1 });
  for (const what of ['ε1', 'ε2', 'ε3', 'ε4', 'ε5']) assert.ok(shown.includes(what), `${what}: askedAboutEpisodes never caps the interlocutor`);
  assert.equal(own({ askedAboutEpisodes: 0 }), shown);
  assert.equal(own({}), shown);

  // A tight caps.interlocutor still drops the interlocutor's lightest episodes first, as before.
  const cost = (text) => estimateTokens(text) + 2;
  const rest = renderProfile({ ...interlocutor, episodes: [] }, labels, { interlocutor: true, relationships: true, episodes: { enabled: true } });
  const heavy = [
    fill(labels.profile.episode, { date: '2026-09-10', what: 'ε5 στιγμή', quote: 'ποτέ ξανά', feeling: 'touched' }),
    fill(labels.profile.episodeNoQuote, { date: '2026-08-01', what: 'ε4 στιγμή', feeling: 'touched' }),
  ];
  const cap = cost(rest) + cost(labels.profile.episodes) + heavy.reduce((sum, line) => sum + cost(line), 0);
  const tight = own({ askedAboutEpisodes: 3, caps: { interlocutor: cap, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 } });
  assert.ok(tight.includes('ε5') && tight.includes('ε4'));
  assert.ok(!tight.includes('ε3') && !tight.includes('ε2') && !tight.includes('ε1'));
});

test('people: a request whose asked-about members have no episodes is the same whatever askedAboutEpisodes says', () => {
  // The interlocutor and a compact participant have episodes, the member asked about has none.
  const carl = { id: 'p2', names: ['Carl'], character: 'calm', episodes: askedEpisodes() };
  const interlocutor = { id: 'u1', names: ['Ana'], character: 'vive', episodes: askedEpisodes() };
  const scene = (askedAboutEpisodes) =>
    askedAboutScene({
      context: askedAboutEpisodes === undefined ? {} : { askedAboutEpisodes },
      zoe: { episodes: [] },
      history: [makeMessage(2, NOW - 2 * MIN, { authorId: 'p2', authorName: 'Carl' }), makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Ana', content: 'τι έκανε η Zoé χθες;' })],
      otherProfiles: [carl],
      interlocutor,
    }).request;
  const before = scene(0);
  assert.ok(bodyOf(userText(before), 'people').includes('## Zoé'));
  for (const value of [undefined, 3, 10]) {
    const after = scene(value);
    assert.deepEqual(after.messages, before.messages, String(value));
    assert.deepEqual(after.stats, before.stats, String(value));
  }
});

test('people: an asked-about member known only by episodes still shows them', () => {
  const { people } = askedAboutScene({ zoe: { character: undefined } });
  const lines = people.split('\n');
  assert.equal(lines[0], '## Zoé');
  assert.equal(lines[1], labels.profile.episodes);
  assert.equal(lines.length, 5, 'the heading, the episodes heading and three episodes, nothing claiming she is unknown');
  assert.ok(!people.includes(labels.profile.unknown));
  const none = askedAboutScene({ zoe: { character: undefined }, context: { askedAboutEpisodes: 0 } }).people;
  assert.equal(none, '', 'no episodes shown and nothing else known: no profile, as before');
});

test('people: under a tight caps.people the lightest episodes of an asked-about member go first and the member stays', () => {
  const cost = (text) => estimateTokens(text) + 2;
  const rest = renderProfile({ id: 'z1', names: ['Zoé'], character: 'rêveuse' }, labels, { relationships: true });
  const heaviest = fill(labels.profile.episode, { date: '2026-09-10', what: 'ε5 στιγμή', quote: 'ποτέ ξανά', feeling: 'touched' });
  const people = cost(rest) + cost(labels.profile.episodes) + cost(heaviest);
  const caps = { interlocutor: 2500, aboutChat: 2500, people, neighbors: 3000, server: 2500, lore: 1500 };
  const { request, people: body } = askedAboutScene({ context: { caps } });
  assert.ok(body.includes('## Zoé') && body.includes('character: rêveuse'), 'the member asked about is never lost to her episodes');
  assert.ok(body.includes('ε5') && !body.includes('ε4') && !body.includes('ε3'));
  assert.ok(request.stats.people.used <= people, 'the block stays inside caps.people');

  // Too small even for the profile: the block is trimmed, the request never fails.
  const tiny = askedAboutScene({ context: { caps: { ...caps, people: 5 } } });
  assert.equal(tiny.people, '');
  assert.equal(tiny.request.stats.people.dropped, 1);
});

test('people: near the request limit an asked-about member keeps her place and loses her lightest episodes first', () => {
  const cost = (text) => estimateTokens(text) + 2;
  // Carl, a compact participant, would fit where Zoé with all her episodes does not.
  const carl = { id: 'p2', names: ['Carl'], character: 'calm' };
  const history = [
    makeMessage(2, NOW - 2 * MIN, { authorId: 'p2', authorName: 'Carl', content: 'καλημέρα' }),
    makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Ana', content: 'τι έκανε η Zoé χθες;' }),
  ];
  const scene = (llm, askedAboutEpisodes) =>
    askedAboutScene({ config: fakeConfig({ context: { askedAboutEpisodes }, llm }), history, trigger: history[1], otherProfiles: [carl] });
  // What the sections ahead of <people> take: nothing after it is offered in this scene.
  const loose = scene({}, 0).request.stats;
  const ahead = loose.used - loose.people.used;
  // A limit leaving <people> exactly `room` tokens (safetyMargin 1, no picture, 60 for the tags).
  const tight = (room, askedAboutEpisodes) => scene({ maxRequestTokens: ahead + room + 60, safetyMargin: 1 }, askedAboutEpisodes);

  const rest = renderProfile({ id: 'z1', names: ['Zoé'], character: 'rêveuse' }, labels, { relationships: true });
  const heaviest = fill(labels.profile.episode, { date: '2026-09-10', what: 'ε5 στιγμή', quote: 'ποτέ ξανά', feeling: 'touched' });
  const room = cost(rest) + cost(labels.profile.episodes) + cost(heaviest);
  assert.ok(room < fakeConfig().context.caps.people, 'the request limit binds, not caps.people');
  assert.ok(tight(room, 0).people.startsWith(rest), 'without episodes she is shown');

  const { request, people } = tight(room, 3);
  assert.ok(people.startsWith('## Zoé\n'), `the member asked about is never lost to her episodes: ${people}`);
  assert.ok(people.includes('ε5') && !people.includes('ε4') && !people.includes('ε3'), 'the lightest go first');
  assert.ok(request.stats.used <= request.stats.limit);

  // Room for her profile and the episodes heading, none for an episode: no heading without an episode under it.
  const headingOnly = tight(cost(rest) + cost(labels.profile.episodes), 3).people;
  assert.equal(headingOnly.split('\n\n')[0], rest);
  assert.ok(!headingOnly.includes(labels.profile.episodes));
});

test('people: room for the episodes heading but not for one episode shows no heading, and an episodes-only member not at all', () => {
  const cost = (text) => estimateTokens(text) + 2;
  const capsWith = (people) => ({ interlocutor: 2500, aboutChat: 2500, people, neighbors: 3000, server: 2500, lore: 1500 });
  const rest = renderProfile({ id: 'z1', names: ['Zoé'], character: 'rêveuse' }, labels, { relationships: true });
  const { people } = askedAboutScene({ context: { caps: capsWith(cost(rest) + cost(labels.profile.episodes) + 1) } });
  assert.equal(people, rest, 'the profile without an empty episodes heading');

  const bare = askedAboutScene({ zoe: { character: undefined }, context: { caps: capsWith(cost('## Zoé') + cost(labels.profile.episodes) + 1) } });
  assert.equal(bare.people, '', 'nothing learned and no episode shown: no profile');
  assert.equal(bare.request.stats.people.kept, 0);

  // The interlocutor's rendering is unchanged by this rule.
  const interlocutor = { id: 'u1', names: ['Ana'], episodes: askedEpisodes() };
  const own = renderProfile(interlocutor, labels, { interlocutor: true, episodes: { enabled: true, cap: 1000, cost } });
  assert.ok(own.includes(labels.profile.episodes) && own.includes('ε5'));
});

test('people: under a tight caps.people a second asked-about member loses episodes before being lost', () => {
  const cost = (text) => estimateTokens(text) + 2;
  const zoe = { id: 'z1', names: ['Zoé'], character: 'rêveuse', episodes: askedEpisodes() };
  const maxime = { id: 'm1', names: ['Maxime'], character: 'têtu', episodes: askedEpisodes() };
  const full = renderProfile(zoe, labels, { relationships: true, episodes: { enabled: true, max: 3 } });
  const bare = renderProfile({ ...maxime, episodes: [] }, labels, { relationships: true });
  const caps = { interlocutor: 2500, aboutChat: 2500, people: cost(full) + cost(bare) + 1, neighbors: 3000, server: 2500, lore: 1500 };
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Ana', content: 'τι έκαναν η Zoé και ο Maxime χθες;' });
  const request = buildRequest(
    baseInput({ config: fakeConfig({ context: { caps } }), history: [trigger], trigger, triggerKind: 'mention', candidateProfiles: [zoe, maxime] }),
  );
  const people = bodyOf(userText(request), 'people');
  assert.equal(people, `${full}\n\n${bare}`, 'the first shows her three, the second keeps his place without his');
  assert.deepEqual([request.stats.people.kept, request.stats.people.dropped], [2, 0]);
});

test("people: the first asked-about member's episodes never cost a later member asked about their place", () => {
  const cost = (text) => estimateTokens(text) + 2;
  const zoe = { id: 'z1', names: ['Zoé'], character: 'rêveuse', episodes: askedEpisodes() };
  const maxime = { id: 'm1', names: ['Maxime'], character: 'têtu' };
  const zoeWith = (max) => renderProfile(zoe, labels, { relationships: true, episodes: { enabled: true, max } });
  const bareMaxime = renderProfile(maxime, labels, { relationships: true });
  // One token short of Zoé with her three episodes and Maxime: her lightest one has to go.
  const people = cost(zoeWith(3)) + cost(bareMaxime) - 1;
  const caps = { interlocutor: 2500, aboutChat: 2500, people, neighbors: 3000, server: 2500, lore: 1500 };
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Ana', content: 'τι έκαναν η Zoé και ο Maxime χθες;' });
  const scene = (askedAboutEpisodes) =>
    buildRequest(
      baseInput({
        config: fakeConfig({ context: { caps, askedAboutEpisodes } }),
        history: [trigger],
        trigger,
        triggerKind: 'mention',
        candidateProfiles: [zoe, maxime],
      }),
    );
  const before = scene(0);
  assert.deepEqual([before.stats.people.kept, before.stats.people.dropped], [2, 0], 'without episodes both are shown');

  const request = scene(3);
  const body = bodyOf(userText(request), 'people');
  assert.equal(body, `${zoeWith(2)}\n\n${bareMaxime}`, 'Zoé loses her lightest episode, Maxime keeps his place');
  assert.deepEqual([request.stats.people.kept, request.stats.people.dropped], [2, 0]);
  assert.ok(request.stats.people.used <= people, 'the block stays inside caps.people');
});

test('people: next to a pulled block near the request limit an asked-about member keeps her place with fewer episodes', () => {
  const cost = (text) => estimateTokens(text) + 2;
  const zoe = { id: 'z1', names: ['Zoé'], character: 'rêveuse', episodes: askedEpisodes() };
  const zoeWith = (max) => renderProfile(zoe, labels, { relationships: true, episodes: { enabled: true, max } });
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Ana', content: 'τι έκανε η Zoé χθες;' });
  // Lines by someone with no profile: the block only takes room ahead of <people>.
  const messages = [1, 2, 3, 4, 5, 6].map((i) =>
    makeMessage(`q${i}`, NOW - (30 - i) * MIN, { channelId: 'src', channelName: 'journal', authorId: 'x9', authorName: 'Léa', content: `σελίδα ${i}: une longue page du journal, écrite avec soin` }),
  );
  const scene = (llm, askedAboutEpisodes) =>
    buildRequest(
      baseInput({
        config: fakeConfig({ context: { askedAboutEpisodes }, llm }),
        history: [trigger],
        trigger,
        triggerKind: 'mention',
        pulled: [{ channelId: 'src', channelName: 'journal', messages }],
        candidateProfiles: [zoe],
      }),
    );
  // What the sections ahead of <people> take, the pulled block included: nothing after it is offered.
  const loose = scene({}, 0);
  assert.equal(loose.stats.pulled.kept, 1);
  const ahead = loose.stats.used - loose.stats.people.used;
  assert.ok(loose.stats.pulled.used > cost(zoeWith(3)) - cost(zoeWith(1)), 'the block is larger than the two episodes left out');

  // A limit leaving <people> exactly her profile with her heaviest episode (safetyMargin 1, no picture, 60 for the tags).
  const request = scene({ maxRequestTokens: ahead + cost(zoeWith(1)) + 60, safetyMargin: 1 }, 3);
  assert.deepEqual([request.stats.pulled.kept, request.stats.pulled.linesCut], [1, 0], 'the pulled block is shown whole');
  assert.equal(bodyOf(userText(request), 'people'), zoeWith(1), 'she stays, with her heaviest episode only');
  assert.deepEqual([request.stats.people.kept, request.stats.people.dropped], [1, 0]);
  assert.ok(request.stats.used <= request.stats.limit);
});

test('people: a private chat renders no episodes for an asked-about member', () => {
  const zoe = { id: 'z1', names: ['Zoé'], character: 'rêveuse', episodes: askedEpisodes() };
  const history = [makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Alice', content: 'τι έκανε η Zoé χθες;' })];
  const user = userText(buildRequest(privateScene({ history, trigger: history[0], candidateProfiles: [zoe] })));
  const people = bodyOf(user, 'people');
  assert.ok(people.includes('## Zoé') && people.includes('character: rêveuse'));
  assert.ok(!people.includes('στιγμή'), "another member's episodes never reach a private chat");
  const server = bodyOf(userText(buildRequest(privateScene({ history, trigger: history[0], candidateProfiles: [zoe], privateChat: null }))), 'people');
  assert.ok(server.includes('ε5'), 'the same member on the server shows them');
});

test('people: an author of a pulled line asked about through the pulled block shows episodes too', () => {
  const messages = [makeMessage('q1', NOW - 20 * MIN, { channelId: 'src', channelName: 'journal', authorId: 'z1', authorName: 'Zoé', content: 'σελίδα' })];
  const pulled = [{ channelId: 'src', channelName: 'journal', messages }];
  const zoe = { id: 'z1', names: ['Zoé'], character: 'rêveuse', episodes: askedEpisodes() };
  const people = bodyOf(userText(buildRequest(baseInput({ pulled, candidateProfiles: [zoe] }))), 'people');
  assert.ok(people.includes('## Zoé') && people.includes('ε5') && !people.includes('ε2'));
});

// --- <senses>: the second look on a question (videoRewatch) --------------------------

test('buildRequest: video watching on and videoRewatch missing (counts as on) -> the videoRewatch line right after the video line', () => {
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true } });
  const lines = sensesOf(buildRequest(baseInput({ config }))).split('\n');
  const at = lines.indexOf(labels.senses.videoWatch);
  assert.ok(at !== -1);
  assert.equal(lines[at + 1], labels.senses.videoRewatch);
});

test('buildRequest: videoRewatch false, video watching off, or no videoRewatch label -> no videoRewatch line', () => {
  const cases = [
    { features: { vision: true, mediaDescriptions: true, videoRewatch: false } },
    { features: { vision: true, mediaDescriptions: true, videoDescriptions: false } },
    { features: { vision: true, mediaDescriptions: false } },
  ];
  for (const overrides of cases) {
    const senses = sensesOf(buildRequest(baseInput({ config: fakeConfig(overrides) })));
    assert.ok(!senses.includes(labels.senses.videoRewatch), JSON.stringify(overrides));
  }
  const oldLabels = { ...labels, senses: { ...labels.senses, videoRewatch: undefined } };
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true } });
  const senses = sensesOf(buildRequest(baseInput({ config, prompts: fakePrompts({ labels: oldLabels }) })));
  assert.ok(senses.includes(labels.senses.videoWatch));
  assert.ok(!senses.includes(labels.senses.videoRewatch));
});

// --- the web lookup: <lookup>, read links, senses -----------------------------------

function webConfig(features = {}, web = {}) {
  const config = fakeConfig({ features: { webLookup: true, ...features } });
  config.web = { links: { enabled: true, ...web.links }, search: { enabled: true, ...web.search } };
  return config;
}

function lookupOf(request) {
  const text = typeof request.messages[1].content === 'string' ? request.messages[1].content : request.messages[1].content[0].text;
  const match = /<lookup>\n([\s\S]*?)\n<\/lookup>/.exec(text);
  return match ? match[1] : null;
}

const LOOKUP = {
  query: 'qui a gagné la finale',
  text: 'Deux sources le confirment (example.com).',
  sources: [
    { title: 'Un', url: 'https://www.example.com/1', site: 'example.com' },
    { title: 'Deux', url: 'https://news.example.org/2', site: 'news.example.org' },
  ],
};

test('buildRequest: a lookup renders <lookup> -- the header with the query, the text, the sources line', () => {
  const request = buildRequest(baseInput({ config: webConfig(), lookup: LOOKUP }));
  assert.equal(
    lookupOf(request),
    [
      fill(labels.lookup.header, { query: LOOKUP.query }),
      LOOKUP.text,
      fill(labels.lookup.sources, { list: 'example.com, news.example.org' }),
    ].join('\n'),
  );
  assert.equal(request.stats.lookup.kept, 1);
});

test('buildRequest: <lookup> sits right before <chat>, after the reference blocks', () => {
  const request = buildRequest(baseInput({ config: webConfig(), lookup: LOOKUP }));
  const user = request.messages[1].content;
  const at = user.indexOf('\n<lookup>\n');
  assert.ok(at > user.indexOf('</senses>'));
  assert.ok(at < user.indexOf('<chat>'));
  assert.ok(user.indexOf('</lookup>\n\n<chat>') !== -1);
});

test('buildRequest: an empty lookup text renders the none line, without a sources line', () => {
  const request = buildRequest(baseInput({ config: webConfig(), lookup: { query: 'ζζζ', text: '', sources: [] } }));
  assert.equal(lookupOf(request), [fill(labels.lookup.header, { query: 'ζζζ' }), labels.lookup.none].join('\n'));
});

test('buildRequest: a missing site is derived from the url without www.; duplicate sites are listed once', () => {
  const lookup = { query: 'q', text: 't', sources: [{ url: 'https://www.exemple.fr/a' }, { url: 'https://exemple.fr/b', site: 'exemple.fr' }] };
  const request = buildRequest(baseInput({ config: webConfig(), lookup }));
  assert.ok(lookupOf(request).endsWith(fill(labels.lookup.sources, { list: 'exemple.fr' })));
});

test('buildRequest: no lookup, or an older labels.json without labels.lookup -> no <lookup> block', () => {
  assert.equal(lookupOf(buildRequest(baseInput({ config: webConfig() }))), null);
  const { lookup: _omit, ...older } = labels;
  const request = buildRequest(baseInput({ config: webConfig(), lookup: LOOKUP, prompts: fakePrompts({ labels: older }) }));
  assert.equal(lookupOf(request), null);
});

test('buildRequest: the <lookup> block is kept whole, ahead of the chat, when the budget is tight', () => {
  const history = Array.from({ length: 60 }, (_, i) => makeMessage(i + 1, NOW - (60 - i) * MIN, { content: 'λόγια '.repeat(30) }));
  const config = webConfig();
  config.llm.maxRequestTokens = 2500;
  const request = buildRequest(baseInput({ config, history, lookup: LOOKUP }));
  assert.ok(request.stats.chat.dropped > 0, 'the chat is trimmed');
  assert.equal(request.stats.lookup.kept, 1);
  assert.ok(lookupOf(request).includes(LOOKUP.text));
});

test('buildRequest: reads reach the <chat> transcript as linkRead', () => {
  const history = [
    makeMessage(1, NOW - MIN, { links: [{ id: '1#e0', kind: 'link', site: 'example.org', title: 'Crêpes', url: 'https://example.org/c' }] }),
  ];
  const request = buildRequest(baseInput({ config: webConfig(), history, reads: new Map([['1#e0', 'trois œufs']]) }));
  assert.ok(request.messages[1].content.includes('[link: example.org — Crêpes] [page read: trois œufs]'));
});

test('buildRequest: webLookup on with links -> the links line stays and linksRead follows it; a search key -> the search line after that', () => {
  const senses = sensesOf(buildRequest(baseInput({ config: webConfig({ mediaDescriptions: true }), searchAvailable: true }))).split('\n');
  const at = senses.indexOf(labels.senses.linksWatch);
  assert.ok(at !== -1, 'the links line is the same as without the lookup');
  assert.equal(senses[at + 1], labels.senses.linksRead);
  assert.equal(senses[at + 2], labels.senses.search);
  assert.equal(senses[at + 3], labels.senses.files);

  const plain = sensesOf(buildRequest(baseInput({ config: webConfig(), searchAvailable: true }))).split('\n');
  const plainAt = plain.indexOf(labels.senses.links);
  assert.ok(plainAt !== -1, 'video watching off -> the plain links line');
  assert.equal(plain[plainAt + 1], labels.senses.linksRead);
});

test('buildRequest: the search line needs searchAvailable -- no key, or searchAvailable omitted, shows no search line', () => {
  for (const searchAvailable of [false, undefined]) {
    const senses = sensesOf(buildRequest(baseInput({ config: webConfig(), searchAvailable }))).split('\n');
    assert.ok(!senses.includes(labels.senses.search));
    assert.ok(senses.includes(labels.senses.linksRead), 'reading links needs no search key');
  }
});

test('buildRequest: links disabled -> no linksRead; search disabled -> no search line even with a key', () => {
  const noLinks = sensesOf(
    buildRequest(baseInput({ config: webConfig({ mediaDescriptions: true }, { links: { enabled: false } }), searchAvailable: true })),
  ).split('\n');
  assert.ok(noLinks.includes(labels.senses.linksWatch));
  assert.ok(!noLinks.includes(labels.senses.linksRead));
  assert.ok(noLinks.includes(labels.senses.search));
  const noSearch = sensesOf(buildRequest(baseInput({ config: webConfig({}, { search: { enabled: false } }), searchAvailable: true }))).split('\n');
  assert.ok(noSearch.includes(labels.senses.linksRead));
  assert.ok(!noSearch.includes(labels.senses.search));
});

test('buildRequest: webLookup off or missing -> no linksRead and no search line, even with a key', () => {
  for (const features of [{ webLookup: false }, {}]) {
    const config = fakeConfig({ features });
    config.web = { links: { enabled: true }, search: { enabled: true } };
    const senses = sensesOf(buildRequest(baseInput({ config, searchAvailable: true }))).split('\n');
    assert.ok(senses.includes(labels.senses.links));
    assert.ok(!senses.includes(labels.senses.linksRead));
    assert.ok(!senses.includes(labels.senses.search));
  }
});

test('buildRequest: an older labels set without linksRead/search keeps only the links line', () => {
  const older = { ...labels, senses: { ...labels.senses, linksRead: undefined, search: undefined } };
  const withLabels = sensesOf(buildRequest(baseInput({ config: webConfig({ mediaDescriptions: true }), searchAvailable: true }))).split('\n');
  const senses = sensesOf(
    buildRequest(baseInput({ config: webConfig({ mediaDescriptions: true }), searchAvailable: true, prompts: fakePrompts({ labels: older }) })),
  ).split('\n');
  assert.ok(senses.includes(labels.senses.linksWatch));
  assert.equal(senses.length, withLabels.length - 2);
});

// --- <about_chat>: what people taught the persona (guild.learned) ------------------

const TEACHER_A = '311111111111111111';
const TEACHER_B = '322222222222222222';
const STRANGER = '399999999999999999';

function learnedItem(id, text, weight, lastSeen, from) {
  const item = { id, text, weight, firstSeen: lastSeen, lastSeen };
  if (from !== undefined) item.from = from;
  return item;
}

function aboutChatOf(request) {
  const match = request.messages[1].content.match(/<about_chat>\n([\s\S]*?)\n<\/about_chat>/);
  return match ? match[1] : null;
}

const learnedNameOf = (id) => ({ [TEACHER_A]: 'Aurélie', [TEACHER_B]: 'Björn' })[id] ?? null;

test('buildRequest: learned renders after the injokes, ranked, capped, with teachers and unsure marks', () => {
  const guildMemory = {
    patterns: 'short lines',
    injokes: ['the lamp'],
    learned: [
      learnedItem('l5', 'forgotten one', 1, '2026-01-01T00:00:00.000Z'),
      learnedItem('l3', 'café closes at nine', 2, '2026-09-10T00:00:00.000Z', `<@${STRANGER}>`),
      learnedItem('l1', 'the kettle is called Ὠκεανός', 5, '2026-09-10T00:00:00.000Z', `<@${TEACHER_A}>`),
      learnedItem('l4', 'Friday is τυρόπιτα day', 1, '2026-09-15T00:00:00.000Z', `<@${TEACHER_B}>`),
      learnedItem('l2', 'pizza with <@322222222222222222> on Fridays', 3, '2026-09-10T00:00:00.000Z'),
    ],
  };
  const config = fakeConfig({ memory: { maxLearned: 4, learnedHalfLifeDays: 720, confirmAfter: 2 } });
  const lines = aboutChatOf(buildRequest(baseInput({ config, guildMemory, nameOf: learnedNameOf }))).split('\n');
  assert.deepEqual(lines, [
    fill(labels.aboutChat.patterns, { text: 'short lines' }),
    fill(labels.aboutChat.injokes, { text: 'the lamp' }),
    fill(labels.aboutChat.learned, {
      text: [
        fill(labels.aboutChat.learnedItem, { text: 'the kettle is called Ὠκεανός', who: 'Aurélie' }),
        fill(labels.aboutChat.learnedItemNoFrom, { text: 'pizza with Björn on Fridays' }),
        fill(labels.aboutChat.learnedItemNoFrom, { text: 'café closes at nine' }),
        fill(labels.aboutChat.learnedItem, { text: 'Friday is τυρόπιτα day', who: 'Björn' }) + labels.aboutChat.unsureMark,
      ].join('; '),
    }),
  ]);
});

test('buildRequest: learned uses memory.maxLearned 20 and learnedHalfLifeDays 720 when config lacks them', () => {
  const many = Array.from({ length: 25 }, (_, i) =>
    learnedItem(`m${i}`, `fact ${i}`, 2, `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`),
  );
  const oldHeavy = learnedItem('old', 'ancient heavy fact', 3, '2020-01-01T00:00:00.000Z');
  const recentLight = learnedItem('new', 'recent light fact', 1, '2026-09-01T00:00:00.000Z');
  const capped = aboutChatOf(buildRequest(baseInput({ guildMemory: { learned: many } })));
  assert.equal(capped.split('; ').length, 20);
  const decayed = aboutChatOf(buildRequest(baseInput({ guildMemory: { learned: [oldHeavy, recentLight] } })));
  assert.ok(decayed.indexOf('recent light fact') < decayed.indexOf('ancient heavy fact'));
  const noDecay = aboutChatOf(
    buildRequest(baseInput({ config: fakeConfig({ memory: { learnedHalfLifeDays: 1e9 } }), guildMemory: { learned: [oldHeavy, recentLight] } })),
  );
  assert.ok(noDecay.indexOf('ancient heavy fact') < noDecay.indexOf('recent light fact'));
});

test('buildRequest: learned without nameOf falls back to the no-teacher form', () => {
  const guildMemory = { learned: [learnedItem('l1', 'Ἑρμῆς is the cat', 4, '2026-09-10T00:00:00.000Z', `<@${TEACHER_A}>`)] };
  const text = aboutChatOf(buildRequest(baseInput({ config: fakeConfig({ memory: { confirmAfter: 2 } }), guildMemory })));
  assert.equal(text, fill(labels.aboutChat.learned, { text: fill(labels.aboutChat.learnedItemNoFrom, { text: 'Ἑρμῆς is the cat' }) }));
});

test('buildRequest: no learned / an empty learned leaves about_chat unchanged', () => {
  const base = { patterns: 'short lines', injokes: ['the lamp'] };
  const without = aboutChatOf(buildRequest(baseInput({ guildMemory: base })));
  const empty = aboutChatOf(buildRequest(baseInput({ guildMemory: { ...base, learned: [] } })));
  assert.equal(empty, without);
  assert.equal(aboutChatOf(buildRequest(baseInput({ guildMemory: { learned: [] } }))), null);
});

test('buildRequest: an older labels.json without the learned keys renders nothing for it, never throws', () => {
  const { learned, learnedItem: li, learnedItemNoFrom, unsureMark, ...olderAboutChat } = labels.aboutChat;
  const older = { ...labels, aboutChat: olderAboutChat };
  const guildMemory = {
    patterns: 'short lines',
    learned: [learnedItem('l1', 'café closes at nine', 1, '2026-09-10T00:00:00.000Z', `<@${TEACHER_A}>`)],
  };
  const text = aboutChatOf(buildRequest(baseInput({ prompts: fakePrompts({ labels: older }), guildMemory, nameOf: learnedNameOf })));
  assert.equal(text, fill(labels.aboutChat.patterns, { text: 'short lines' }));
});

test('buildRequest: learned without the unsureMark label appends no mark', () => {
  const { unsureMark, ...noMark } = labels.aboutChat;
  const guildMemory = { learned: [learnedItem('l1', 'café closes at nine', 1, '2026-09-10T00:00:00.000Z')] };
  const text = aboutChatOf(
    buildRequest(baseInput({ config: fakeConfig({ memory: { confirmAfter: 2 } }), prompts: fakePrompts({ labels: { ...labels, aboutChat: noMark } }), guildMemory })),
  );
  assert.equal(text, fill(labels.aboutChat.learned, { text: 'café closes at nine' }));
});

// --- drawing ----------------------------------------------------------------

const DRAW_PROMPTS = {
  draw: 'Drawing for {{name}}.\n\n## Look\n\n{{appearance}}\n\n## Request\n\n{{request}}\n',
  appearance: '{{name}}: short hair, green scarf.',
};

test('block: wraps a body in its tag on lines of their own; an empty body is no block', () => {
  assert.equal(block('rules', 'one\ntwo'), '<rules>\none\ntwo\n</rules>');
  assert.equal(block('rules', ''), '');
  assert.equal(block('rules', undefined), '');
});

test('fillPromptTemplate: a present non-null value fills its placeholder as a string', () => {
  assert.equal(fillPromptTemplate('{{name}} has {{n}} of {{max}} ({{off}}, {{empty}})', { name: 'Éla', n: 3, max: 0, off: false, empty: '' }), 'Éla has 3 of 0 (false, )');
});

test('fillPromptTemplate: an absent, null or undefined key leaves its placeholder untouched', () => {
  assert.equal(fillPromptTemplate('{{a}} {{b}} {{c}} {{d}}', { a: null, b: undefined, d: 'x' }), '{{a}} {{b}} {{c}} x');
});

test('fillPromptTemplate: inherited object keys are not values', () => {
  assert.equal(fillPromptTemplate('{{constructor}} {{toString}}', {}), '{{constructor}} {{toString}}');
});

test('fillPromptTemplate: a missing template reads as empty; every occurrence is filled', () => {
  assert.equal(fillPromptTemplate(undefined, { a: 1 }), '');
  assert.equal(fillPromptTemplate(null, { a: 1 }), '');
  assert.equal(fillPromptTemplate('{{a}}-{{a}}', { a: 'λ' }), 'λ-λ');
  assert.equal(fillPromptTemplate('{ a } {{ a }} {a}', { a: 1 }), '{ a } {{ a }} {a}');
});

test('buildDrawPrompt: fills name and request and blanks appearance for a non-self picture', () => {
  const text = buildDrawPrompt({ prompts: DRAW_PROMPTS, selfName: 'Nept', request: 'a cat on a roof', self: false });
  assert.ok(text.startsWith('Drawing for Nept.'));
  assert.ok(text.endsWith('a cat on a roof'));
  assert.ok(!text.includes('{{appearance}}'));
  assert.ok(!text.includes('green scarf'));
  assert.ok(!text.includes('\n\n\n'), 'the blanked appearance leaves no double blank line');
});

test('buildDrawPrompt: includes the rendered appearance for a self picture', () => {
  const text = buildDrawPrompt({ prompts: DRAW_PROMPTS, selfName: 'Nept', request: 'waving at the café', self: true });
  assert.ok(text.includes('## Look\n\nNept: short hair, green scarf.\n\n## Request'));
  assert.ok(text.endsWith('waving at the café'));
});

const DRAW_OPEN = { spent: false, userSpent: false };

test('renderSenses: draw line shows when the feature is on', () => {
  for (const features of [{ imageGeneration: true }, {}]) {
    const senses = sensesOf(buildRequest(baseInput({ config: fakeConfig({ features }), drawQuota: DRAW_OPEN }))).split('\n');
    const at = senses.indexOf(labels.senses.draw);
    assert.ok(at !== -1, 'a missing imageGeneration key counts as on');
    assert.equal(senses[at + 1], labels.senses.files, 'the draw line sits right before the files line');
    assert.ok(!senses.includes(labels.senses.drawSpent));
    assert.ok(!senses.includes(labels.senses.drawSpentUser));
  }
});

test('renderSenses: draw line is absent when features.imageGeneration is false', () => {
  const senses = sensesOf(buildRequest(baseInput({ config: fakeConfig({ features: { imageGeneration: false } }), drawQuota: { spent: true, userSpent: true } })));
  for (const line of [labels.senses.draw, labels.senses.drawSpent, labels.senses.drawSpentUser]) assert.ok(!senses.includes(line));
});

test('renderSenses: draw line is absent without a drawQuota (no image client wired)', () => {
  const senses = sensesOf(buildRequest(baseInput()));
  for (const line of [labels.senses.draw, labels.senses.drawSpent, labels.senses.drawSpentUser]) assert.ok(!senses.includes(line));
});

test('renderSenses: shows drawSpent when the daily quota is spent', () => {
  const senses = sensesOf(buildRequest(baseInput({ drawQuota: { spent: true, userSpent: true } }))).split('\n');
  assert.ok(senses.includes(labels.senses.drawSpent));
  assert.ok(!senses.includes(labels.senses.draw));
  assert.ok(!senses.includes(labels.senses.drawSpentUser));
});

test('renderSenses: shows drawSpentUser when the member\'s quota is spent', () => {
  const senses = sensesOf(buildRequest(baseInput({ drawQuota: { spent: false, userSpent: true } }))).split('\n');
  assert.ok(senses.includes(labels.senses.drawSpentUser));
  assert.ok(!senses.includes(labels.senses.draw));
  assert.ok(!senses.includes(labels.senses.drawSpent));
});

test('renderSenses: an older labels set without senses.draw shows no draw line', () => {
  // An older set has no channel lines either (they follow the files line).
  const older = {
    ...labels,
    senses: { ...labels.senses, draw: undefined, drawSpent: undefined, drawSpentUser: undefined, channels: undefined, elsewhere: undefined },
  };
  const senses = sensesOf(buildRequest(baseInput({ prompts: fakePrompts({ labels: older }), drawQuota: DRAW_OPEN }))).split('\n');
  assert.equal(senses[senses.length - 1], labels.senses.files);
});

test('buildRequest: a drawFailed turn fills triggers.drawFailed with the reason label', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'drawFailed', drawReason: 'moderation' }));
  const user = request.messages[1].content;
  assert.ok(user.includes(`they ${fill(labels.triggers.drawFailed, { reason: labels.draw.reasons.moderation })}.`));
  assert.ok(!user.includes('{reason}'));
});

test('buildRequest: a drawFailed reason without a label is passed through as is', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'drawFailed', drawReason: 'quux' }));
  assert.ok(request.messages[1].content.includes(fill(labels.triggers.drawFailed, { reason: 'quux' })));
});

// --- private chat (privateChat) ------------------------------------------------

function privateScene(overrides = {}) {
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Alice' });
  return baseInput({
    history: [trigger],
    trigger,
    triggerKind: 'private',
    prompts: fakePrompts({ private: 'PRIVATE_TASK for {{name}} with {{author}}' }),
    privateChat: { userId: 'u1' },
    interlocutor: {
      id: 'u1',
      names: ['Alice'],
      relationship: 'PUBLIC_REL',
      details: [{ id: 1, text: 'PUBLIC_DETAIL', weight: 1 }],
      affinity: { score: 10, reason: 'public reason', history: [] },
    },
    privateProfile: {
      relationship: 'PRIVATE_REL',
      details: [{ id: 1, text: 'PRIVATE_DETAIL', weight: 1 }],
      affinity: { score: 5, reason: 'private reason', history: [] },
    },
    channels: [{ id: 'c1', name: 'general', lastMessageAt: NOW, days: {} }],
    currentChannelId: 'c1',
    neighbors: [{ channelId: 'c1', channelName: 'general', messages: [makeMessage(9, NOW - 5 * MIN)] }],
    ...overrides,
  });
}

test('buildRequest: privateChat omits <server> and <other_channels>, even with channels and neighbours given', () => {
  const user = buildRequest(privateScene()).messages[1].content;
  assert.ok(!user.includes('<server>'));
  assert.ok(!user.includes('<other_channels>'));
  // The same input without privateChat renders both.
  const publicUser = buildRequest(privateScene({ privateChat: null })).messages[1].content;
  assert.ok(publicUser.includes('<server>'));
  assert.ok(publicUser.includes('<other_channels>'));
});

test('buildRequest: privateChat appends the filled prompts.private after the mode prompt', () => {
  const user = buildRequest(privateScene()).messages[1].content;
  const task = user.slice(user.indexOf('<task>'));
  assert.ok(task.includes(`Called by Alice, they ${labels.triggers.private}.`), '{{trigger}} comes from labels.triggers.private');
  assert.ok(task.includes('PRIVATE_TASK for Nept with Alice'));
  assert.ok(task.indexOf('Called by Alice') < task.indexOf('PRIVATE_TASK'));
});

test('buildRequest: without privateChat prompts.private is never appended', () => {
  const user = buildRequest(privateScene({ privateChat: null })).messages[1].content;
  assert.ok(!user.includes('PRIVATE_TASK'));
});

test('buildRequest: privateChat with no prompts.private leaves the task as the mode prompt alone', () => {
  const prompts = fakePrompts();
  const user = buildRequest(privateScene({ prompts })).messages[1].content;
  const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(user)[1];
  assert.equal(task, `Called by Alice, they ${labels.triggers.private}. Answer #1 as Nept. Target: #1.`);
});

test('buildRequest: privateChat renders the interlocutor as the public and private profiles merged', () => {
  const user = buildRequest(privateScene()).messages[1].content;
  const people = user.slice(user.indexOf('<people>'), user.indexOf('</people>'));
  assert.ok(people.includes('PUBLIC_REL'));
  assert.ok(people.includes('PRIVATE_REL'));
  assert.ok(people.includes('PUBLIC_DETAIL'));
  assert.ok(people.includes('PRIVATE_DETAIL'), 'colliding detail ids of the two layers both render');
  assert.ok(people.includes('attitude: 15 '), 'the attitude is the public and private scores added');
  assert.ok(people.includes('private reason'));
});

test('buildRequest: without privateChat a passed privateProfile is ignored -- the interlocutor stays public', () => {
  const user = buildRequest(privateScene({ privateChat: null })).messages[1].content;
  assert.ok(user.includes('PUBLIC_REL'));
  assert.ok(!user.includes('PRIVATE_REL'));
  assert.ok(!user.includes('PRIVATE_DETAIL'));
  assert.ok(user.includes('attitude: 10 '));
});

test('buildRequest: privateChat keeps other profiles public-only', () => {
  // Carl is named in the trigger (rendered in full), Bob only took part (rendered compact).
  const bob = { id: 'u2', names: ['Bob'], character: 'BOB_CHARACTER', relationship: 'BOB_REL' };
  const carl = { id: 'u3', names: ['Carl'], character: 'CARL_CHARACTER', relationship: 'CARL_REL', details: [{ id: 1, text: 'CARL_DETAIL', weight: 1 }] };
  const history = [
    makeMessage(2, NOW - 2 * MIN, { authorId: 'u2', authorName: 'Bob' }),
    makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Alice', content: 'what does Carl think' }),
  ];
  const privateProfile = {
    relationship: 'PRIVATE_MARKER_REL',
    details: [{ id: 1, text: 'PRIVATE_MARKER_DETAIL', weight: 1 }],
    affinity: { score: 5, reason: 'PRIVATE_MARKER_REASON', history: [] },
  };
  const user = buildRequest(
    privateScene({ history, trigger: history[1], otherProfiles: [bob], candidateProfiles: [bob, carl], privateProfile }),
  ).messages[1].content;
  const people = /<people>\n([\s\S]*?)\n<\/people>/.exec(user)[1];
  // The merged relationship holds a blank line itself: split on the headings only.
  const sections = people.split(/\n\n(?=## )/);
  const own = sections.filter((s) => s.startsWith('## Alice'));
  const others = sections.filter((s) => !s.startsWith('## Alice'));
  assert.equal(own.length, 1);
  assert.ok(others.some((s) => s.startsWith('## Bob') && s.includes('BOB_CHARACTER')));
  assert.ok(others.some((s) => s.startsWith('## Carl') && s.includes('CARL_DETAIL')));
  for (const marker of ['PRIVATE_MARKER_REL', 'PRIVATE_MARKER_DETAIL', 'PRIVATE_MARKER_REASON']) {
    assert.ok(own[0].includes(marker), `${marker} is in the interlocutor's section`);
    for (const section of others) assert.ok(!section.includes(marker), `${marker} never reaches another profile`);
    assert.equal(user.split(marker).length - 1, 1, `${marker} appears exactly once in the request`);
  }
});

test('buildRequest: <senses> carries senses.privateChat in a private chat, never senses.privateAware', () => {
  for (const privateMessages of [true, false, undefined]) {
    const config = fakeConfig({ features: { privateMessages } });
    const senses = sensesOf(buildRequest(privateScene({ config })));
    assert.ok(senses.includes(labels.senses.privateChat));
    assert.ok(!senses.includes(labels.senses.privateAware));
  }
});

test('buildRequest: <senses> carries senses.privateAware outside a private chat only when features.privateMessages is true', () => {
  const on = sensesOf(buildRequest(baseInput({ config: fakeConfig({ features: { privateMessages: true } }) })));
  assert.ok(on.includes(labels.senses.privateAware));
  assert.ok(!on.includes(labels.senses.privateChat));
  for (const privateMessages of [false, undefined, 'yes']) {
    const senses = sensesOf(buildRequest(baseInput({ config: fakeConfig({ features: { privateMessages } }) })));
    assert.ok(!senses.includes(labels.senses.privateAware));
    assert.ok(!senses.includes(labels.senses.privateChat));
  }
});

test('buildRequest: an older labels.json without the private senses keys renders no extra line', () => {
  // Older than the channel lines too, which only a server turn would show.
  const olderLabels = {
    ...labels,
    senses: { ...labels.senses, privateChat: undefined, privateAware: undefined, channels: undefined, elsewhere: undefined },
  };
  const senses = sensesOf(buildRequest(privateScene({ prompts: fakePrompts({ labels: olderLabels, private: 'P' }) })));
  assert.ok(!senses.includes('undefined'));
  assert.equal(senses, sensesOf(buildRequest(baseInput({ prompts: fakePrompts({ labels: olderLabels }) }))));
});

// --- <channel_view>: another channel pulled into the turn ---------------------------

const SRC = 'src';
const DEST = 'dest';
const HOUR = 60 * MIN;
const TZ = 'Europe/Moscow';

/** A line of the pulled channel (written by Zoé unless overridden). */
function pulledMessage(id, ts, overrides = {}) {
  return makeMessage(id, ts, { channelId: SRC, channelName: 'journal-de-zoé', authorId: 'w1', authorName: 'Zoé', ...overrides });
}

/** A line of the channel the turn posts in. */
function destMessage(id, ts, overrides = {}) {
  return makeMessage(id, ts, { channelId: DEST, channelName: 'général', ...overrides });
}

/** A pulled channel record, the shape src/discord/pull-fetch.js#fetchPull hands to buildRequest. */
function pulledChannel(overrides = {}) {
  const messages = overrides.messages ?? [
    pulledMessage('p1', NOW - 130 * MIN, { content: 'πρώτη σελίδα' }),
    pulledMessage('p2', NOW - 120 * MIN, { content: 'δεύτερη σελίδα' }),
  ];
  return {
    channelId: SRC,
    channelName: 'journal-de-zoé',
    readOnly: false,
    canReact: true,
    reason: 'mention',
    earlierPingIds: new Set(),
    olderNotShown: false,
    descriptions: new Map(),
    picturesNotSeen: 0,
    pingState: new Map(),
    newestId: messages.at(-1).id,
    newestTs: messages.at(-1).ts,
    ...overrides,
    messages,
  };
}

/** The text part of a request's user message. */
function userText(request) {
  const content = request.messages[1].content;
  return Array.isArray(content) ? content.find((part) => part.type === 'text').text : content;
}

/** The body of `<tag>` in `text`, or null when the block is absent. */
function bodyOf(text, tag) {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return match ? match[1] : null;
}

/** `{from}` / `{to}` of a pulled header: the date and the clock of `ts`. */
function moment(ts) {
  return `${formatDate(ts, TZ, labels.locale)}, ${formatClock(ts, TZ, labels.locale)}`;
}

/** A routed turn: a call in the pulled channel, answered in the destination. */
function routedInput(overrides = {}) {
  const trigger = pulledMessage('p3', NOW - 2 * MIN, { authorId: 'u7', authorName: 'Ana', content: 'tu as vu ça ?', mentionedUserIds: ['self'] });
  const pulled = pulledChannel({
    readOnly: true,
    reason: 'routed',
    messages: [pulledMessage('p1', NOW - 30 * MIN, { content: 'πρώτη σελίδα' }), pulledMessage('p2', NOW - 20 * MIN, { content: 'δεύτερη σελίδα' }), trigger],
    pingState: new Map([['p3', 'unanswered']]),
  });
  return baseInput({
    history: [destMessage(1, NOW - 15 * MIN), destMessage(2, NOW - 10 * MIN)],
    trigger,
    triggerKind: 'mention',
    pulled: [pulled],
    source: { channelId: SRC, reason: 'routed' },
    currentChannelId: DEST,
    ...overrides,
  });
}

test('buildRequest: a pulled channel renders as channel_view after other_channels', () => {
  const history = [destMessage(1, NOW - 5 * MIN), destMessage(2, NOW - MIN)];
  const neighbors = [{ channelId: 'n1', channelName: 'random', messages: [makeMessage(9, NOW - 5 * MIN)] }];
  const worn = [{ shape: 'a closing question', examples: ['ça va ?'] }];
  const text = userText(buildRequest(baseInput({ history, neighbors, worn, pulled: [pulledChannel()], currentChannelId: DEST })));
  const order = ['<other_channels>', '<channel_view>', '<worn>', '<chat>', '<task>'];
  const positions = order.map((tag) => text.indexOf(tag));
  assert.ok(positions.every((p) => p !== -1), JSON.stringify(positions));
  for (let i = 1; i < positions.length; i += 1) assert.ok(positions[i - 1] < positions[i], `${order[i - 1]} before ${order[i]}`);
  assert.deepEqual(bodyOf(text, 'channel_view').split('\n'), [
    fill(labels.pull.header, { channel: 'journal-de-zoé', from: moment(NOW - 130 * MIN), to: moment(NOW - 120 * MIN), ago: formatDuration(120 * MIN, labels.units) }),
    `#3 [${formatClock(NOW - 130 * MIN, TZ)}] Zoé: πρώτη σελίδα`,
    `#4 [${formatClock(NOW - 120 * MIN, TZ)}] Zoé: δεύτερη σελίδα`,
  ]);
});

test('buildRequest: the pulled header carries the read-only mark, older messages not shown and pictures not seen, in that order', () => {
  const pulled = pulledChannel({ readOnly: true, olderNotShown: true, picturesNotSeen: 3 });
  const view = bodyOf(userText(buildRequest(baseInput({ pulled: [pulled] }))), 'channel_view').split('\n');
  assert.deepEqual(view.slice(1, 4), [labels.server.readOnly, labels.pull.olderNotShown, fill(labels.pull.picturesNotSeen, { count: 3 })]);
  const plain = bodyOf(userText(buildRequest(baseInput({ pulled: [pulledChannel()] }))), 'channel_view');
  for (const line of [labels.server.readOnly, labels.pull.olderNotShown, 'pictures not looked at']) assert.ok(!plain.includes(line), line);
});

test('buildRequest: pulled lines continue the chat\'s numbering and map back through idByIndex and pulledIds', () => {
  const history = [destMessage('d1', NOW - 5 * MIN), destMessage('d2', NOW - MIN)];
  const first = pulledChannel({
    messages: [pulledMessage('p1', NOW - 30 * MIN), pulledMessage('p2', NOW - 25 * MIN, { replyToId: 'p1' })],
  });
  const second = pulledChannel({
    channelId: 'other',
    channelName: 'carnet-de-björn',
    messages: [makeMessage('q1', NOW - 50 * MIN, { channelId: 'other', authorName: 'Björn' })],
  });
  const request = buildRequest(baseInput({ history, pulled: [first, second], currentChannelId: DEST }));
  assert.deepEqual([...request.idByIndex], [[1, 'd1'], [2, 'd2'], [3, 'p1'], [4, 'p2'], [5, 'q1']]);
  assert.deepEqual([...request.pulledIds], [['p1', SRC], ['p2', SRC], ['q1', 'other']]);
  const view = bodyOf(userText(request), 'channel_view');
  assert.ok(view.includes(`#4 [${formatClock(NOW - 25 * MIN, TZ)}] Zoé: content of message p2 ${fill(labels.transcript.replyTo, { index: 3 })}`), view);
  assert.ok(view.includes('#5 ['));
  assert.ok(view.indexOf('#journal-de-zoé') < view.indexOf('#carnet-de-björn'), 'channels in the order given');
});

test('buildRequest: no pulled input changes nothing', () => {
  const trigger = destMessage(2, NOW - MIN, { authorName: 'Ana' });
  const scene = {
    history: [destMessage(1, NOW - 5 * MIN), trigger],
    trigger,
    triggerKind: 'mention',
    currentChannelId: DEST,
    channels: [fakeChannel(DEST, { name: 'général' })],
    neighbors: [{ channelId: 'n1', channelName: 'random', messages: [makeMessage(9, NOW - 5 * MIN)] }],
  };
  const absent = buildRequest(baseInput(scene));
  const empty = buildRequest(baseInput({ ...scene, pulled: [], source: null, focus: null, elsewhereDestination: null, readOnlyIds: new Set() }));
  assert.deepEqual(empty.messages, absent.messages);
  assert.deepEqual(empty.idByIndex, absent.idByIndex);
  assert.deepEqual(absent.pulledIds, new Map());
  assert.deepEqual(absent.pulledKept, []);
  assert.deepEqual(absent.stats.pulled, { used: 0, kept: 0, dropped: 0, lines: 0, linesCut: 0 });

  // Without the new label keys the request is the one built before pulled channels existed;
  // with them, the only addition on a turn without a pull is the senses.channels line.
  const { channels, elsewhere: elsewhereSense, ...olderSenses } = labels.senses;
  assert.ok(channels && elsewhereSense);
  const { pull, elsewhere, room, ...rest } = labels;
  const older = { ...rest, senses: olderSenses };
  const before = userText(buildRequest(baseInput({ ...scene, prompts: fakePrompts({ labels: older }) })));
  assert.equal(userText(absent).replace(`\n${labels.senses.channels}`, ''), before);
});

test('buildRequest: a routed trigger targets its pulled index and appends labels.elsewhere.called', () => {
  const request = buildRequest(routedInput());
  const task = bodyOf(userText(request), 'task');
  assert.equal(
    task,
    [
      `Called by Ana, they ${labels.triggers.mention}. Answer #5 as Nept. Target: #5.`,
      fill(labels.elsewhere.called, { channel: 'journal-de-zoé', destination: 'général' }),
    ].join('\n\n'),
  );
  assert.equal(request.idByIndex.get(5), 'p3');
  const view = bodyOf(userText(request), 'channel_view');
  assert.ok(view.includes('Ana: tu as vu ça ?'));
  assert.ok(!view.includes(labels.pull.pingUnanswered), 'the routed trigger itself carries no ping mark');
});

test('buildRequest: a routed turn without the called label, or whose source is not pulled, keeps the mode text alone', () => {
  const { elsewhere, ...noCalled } = labels;
  const plain = bodyOf(userText(buildRequest(routedInput({ prompts: fakePrompts({ labels: noCalled }) }))), 'task');
  assert.equal(plain, `Called by Ana, they ${labels.triggers.mention}. Answer #5 as Nept. Target: #5.`);
  const noSource = bodyOf(userText(buildRequest(routedInput({ pulled: [] }))), 'task');
  assert.equal(noSource, `Called by Ana, they ${labels.triggers.mention}. Answer  as Nept. Target: .`);
});

test('buildRequest: the destination is named by the chat, then elsewhereDestination, then the channel map; nameless, no called text follows', () => {
  const nameless = [destMessage(1, NOW - 15 * MIN, { channelName: undefined }), destMessage(2, NOW - 10 * MIN, { channelName: undefined })];
  const prompts = fakePrompts({ reply: 'REPLY {{target}} to {{destination}}' });
  const task = (overrides) => bodyOf(userText(buildRequest(routedInput({ prompts, ...overrides }))), 'task');
  const called = (destination) => fill(labels.elsewhere.called, { channel: 'journal-de-zoé', destination });
  const map = [fakeChannel(DEST, { name: 'carte-générale' })];
  const given = { name: 'principal' };

  assert.equal(task({ elsewhereDestination: given, channels: map }), ['REPLY #5 to général', called('général')].join('\n\n'), 'the name the chat\'s lines carry');
  assert.equal(task({ history: nameless, elsewhereDestination: given, channels: map }), ['REPLY #5 to principal', called('principal')].join('\n\n'));
  assert.equal(task({ history: nameless, elsewhereDestination: { name: '' }, channels: map }), ['REPLY #5 to carte-générale', called('carte-générale')].join('\n\n'));
  assert.equal(task({ history: nameless }), 'REPLY #5 to ', 'no name anywhere: an empty destination and no called text');
});

test('buildRequest: a pulled record of the turn\'s own channel is ignored', () => {
  const history = [destMessage('d1', NOW - 5 * MIN), destMessage('d2', NOW - MIN)];
  const own = pulledChannel({ channelId: DEST, channelName: 'général', messages: history });
  const request = buildRequest(baseInput({ history, pulled: [own], currentChannelId: DEST }));
  assert.equal(bodyOf(userText(request), 'channel_view'), null);
  assert.deepEqual(request.pulledIds, new Map());
  assert.deepEqual([...request.idByIndex], [[1, 'd1'], [2, 'd2']]);
  assert.deepEqual(request.pulledKept, []);
  assert.deepEqual(request.stats.pulled, { used: 0, kept: 0, dropped: 0, lines: 0, linesCut: 0 });
});

test('buildRequest: tempo on a routed turn is measured to now and never says nobody answered the persona', () => {
  const history = [destMessage(1, NOW - 15 * MIN), destMessage(2, NOW - 10 * MIN, { self: true })];
  const request = buildRequest(routedInput({ history }));
  assert.equal(request.tempo.hasTrigger, false);
  assert.equal(request.tempo.silenceMs, 10 * MIN);
  const tempo = bodyOf(userText(request), 'tempo');
  assert.ok(tempo.includes(fill(labels.tempo.lastMessageAgo, { duration: formatDuration(10 * MIN, labels.units) })), tempo);
  assert.ok(!tempo.includes(labels.tempo.ownUnanswered));
  assert.ok(!tempo.includes('before the message that called you'));
  // The same chat on a spontaneous turn does say it: the routed turn alone leaves it out.
  const spontaneous = bodyOf(userText(buildRequest(baseInput({ history, mode: 'interject' }))), 'tempo');
  assert.ok(spontaneous.includes(labels.tempo.ownUnanswered));
});

test('buildRequest: mode elsewhere uses prompts.elsewhere with channel and destination', () => {
  const prompts = fakePrompts({ elsewhere: 'ELSEWHERE_TASK {{name}} read {{channel}} and may speak in {{destination}}' });
  const request = buildRequest(
    baseInput({
      prompts,
      mode: 'elsewhere',
      history: [destMessage(1, NOW - 50 * MIN)],
      currentChannelId: DEST,
      pulled: [pulledChannel({ reason: 'noticed', readOnly: true })],
      source: { channelId: SRC, reason: 'noticed' },
      elsewhereDestination: { name: 'général' },
    }),
  );
  assert.equal(bodyOf(userText(request), 'task'), 'ELSEWHERE_TASK Nept read journal-de-zoé and may speak in général');
});

test('buildRequest: a focus line appends labels.room.focus with its index', () => {
  const history = [destMessage(1, NOW - 3 * MIN), destMessage(2, NOW - 2 * MIN, { authorName: 'Léa', content: 'qui vient ce soir ?' }), destMessage(3, NOW - MIN)];
  const task = (overrides) => bodyOf(userText(buildRequest(baseInput({ history, mode: 'interject', ...overrides }))), 'task');
  assert.equal(task({ focus: history[1] }), ['INTERJECT_TASK for Nept', fill(labels.room.focus, { author: 'Léa', target: '#2' })].join('\n\n'));
  assert.equal(task({ focus: destMessage(99, NOW - 90 * MIN) }), 'INTERJECT_TASK for Nept', 'a focus outside the chat adds nothing');
  const { room, ...noRoom } = labels;
  assert.equal(task({ focus: history[1], prompts: fakePrompts({ labels: noRoom }) }), 'INTERJECT_TASK for Nept');
});

test('buildRequest: server lists the pulled channel and marks read-only channels', () => {
  const channels = [
    fakeChannel(DEST, { name: 'général' }),
    fakeChannel('n1', { name: 'random' }),
    fakeChannel('n2', { name: 'annonces' }),
    fakeChannel(SRC, { name: 'journal-de-zoé' }),
  ];
  const neighbors = [
    { channelId: 'n1', channelName: 'random', messages: [makeMessage(8, NOW - 5 * MIN)] },
    { channelId: 'n2', channelName: 'annonces', messages: [makeMessage(9, NOW - 4 * MIN)] },
  ];
  const request = buildRequest(
    baseInput({
      history: [destMessage(1, NOW - MIN)],
      channels,
      neighbors,
      currentChannelId: DEST,
      pulled: [pulledChannel({ readOnly: true })],
      readOnlyIds: new Set(['n2', DEST]),
    }),
  );
  const entries = bodyOf(userText(request), 'server').split('\n\n');
  assert.deepEqual(
    entries.map((entry) => entry.split('\n')[0]),
    [`# général${labels.server.currentMark}`, '# journal-de-zoé', '# random', '# annonces'],
    'the current channel, then the pulled one, then the neighbours',
  );
  const marked = entries.filter((entry) => entry.includes(labels.server.readOnly)).map((entry) => entry.split('\n')[0]);
  assert.deepEqual(marked, ['# journal-de-zoé', '# annonces'], 'never the current channel');
});

test('buildRequest: a pulled channel is left out of other_channels', () => {
  const neighbors = [
    { channelId: SRC, channelName: 'journal-de-zoé', messages: [pulledMessage('p2', NOW - 120 * MIN)] },
    { channelId: 'n1', channelName: 'random', messages: [makeMessage(9, NOW - 5 * MIN)] },
  ];
  const text = userText(buildRequest(baseInput({ neighbors, pulled: [pulledChannel()] })));
  const others = bodyOf(text, 'other_channels');
  assert.ok(others.startsWith('# random'), others);
  assert.ok(!others.includes('journal-de-zoé'));
});

test('buildRequest: senses carry the channels line on server turns and the elsewhere line only with a destination', () => {
  const lines = (overrides) => sensesOf(buildRequest(baseInput(overrides))).split('\n');
  const plain = lines({});
  assert.equal(plain[plain.indexOf(labels.senses.files) + 1], labels.senses.channels, 'right after the files line');
  assert.ok(!plain.some((line) => line.startsWith('read-only channels')));

  const withDestination = lines({ elsewhereDestination: { name: 'général' }, config: fakeConfig({ features: { privateMessages: true } }) });
  const at = withDestination.indexOf(labels.senses.channels);
  assert.deepEqual(withDestination.slice(at, at + 3), [
    labels.senses.channels,
    fill(labels.senses.elsewhere, { destination: 'général' }),
    labels.senses.privateAware,
  ]);

  const privateLines = sensesOf(buildRequest(privateScene({ elsewhereDestination: { name: 'général' } }))).split('\n');
  assert.ok(!privateLines.includes(labels.senses.channels));
  assert.ok(!privateLines.some((line) => line.startsWith('read-only channels')));

  const { channels, elsewhere, ...olderSenses } = labels.senses;
  const older = lines({ elsewhereDestination: { name: 'général' }, prompts: fakePrompts({ labels: { ...labels, senses: olderSenses } }) });
  assert.equal(older.at(-1), labels.senses.files, 'an older labels.json adds no line');
});

test('buildRequest: a private chat ignores pulled input', () => {
  const extra = {
    pulled: [pulledChannel()],
    source: { channelId: SRC, reason: 'routed' },
    focus: makeMessage(1, NOW - MIN),
    readOnlyIds: new Set([SRC]),
  };
  const plain = buildRequest(privateScene());
  const pulled = buildRequest(privateScene(extra));
  assert.deepEqual(pulled.messages, plain.messages);
  assert.deepEqual(pulled.idByIndex, plain.idByIndex);
  assert.deepEqual(pulled.pulledIds, new Map());
  assert.ok(!userText(pulled).includes('<channel_view>'));
});

test('buildRequest: textFallback re-renders pulled lines without attachment markers', () => {
  // The same sticker in the chat's trigger and in a pulled line: one item id (`sticker:s1`),
  // attached for the chat, never marked attached on the pulled line.
  const sticker = { id: 's1', name: 'gâteau', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' };
  const trigger = destMessage(1, NOW - MIN, { attachments: [{ id: 'i1', kind: 'image', url: 'https://cdn/i1.png', name: 'i1.png' }], stickers: [sticker] });
  const pulled = pulledChannel({
    messages: [
      pulledMessage('p1', NOW - 30 * MIN, { attachments: [{ id: 'pi1', kind: 'image', url: 'https://cdn/pi1.png', name: 'pi1.png' }] }),
      pulledMessage('p2', NOW - 20 * MIN, { attachments: [{ id: 'pi2', kind: 'image', url: 'https://cdn/pi2.png', name: 'pi2.png' }], stickers: [sticker] }),
    ],
    descriptions: new Map([['pi1', 'un chat endormi']]),
  });
  const config = fakeConfig({ context: { vision: { maxImages: 4, tokensPerImage: 400, imageSize: 512, recentImages: 3, recentImageMinutes: 60 } } });
  const request = buildRequest(baseInput({ config, history: [trigger], trigger, triggerKind: 'mention', pulled: [pulled], currentChannelId: DEST }));
  assert.deepEqual(request.pictures.map((picture) => picture.itemId), ['i1', 'sticker:s1'], 'only the chat\'s pictures are attached');
  const stickerTag = fill(labels.transcript.sticker, { name: 'gâteau' });
  const chat = bodyOf(userText(request), 'chat');
  assert.ok(chat.includes(fill(labels.transcript.imageAttached, { n: 1 })), chat);
  assert.ok(chat.includes(`${stickerTag} ${fill(labels.transcript.frameAttached, { n: 2 })}`), chat);
  const view = bodyOf(userText(request), 'channel_view');
  assert.ok(view.includes(fill(labels.transcript.imageDescribed, { text: 'un chat endormi' })), view);
  assert.ok(view.split('\n').at(-1).endsWith(`Zoé: content of message p2 ${labels.transcript.image} ${stickerTag}`), view);
  assert.ok(!view.includes('attached'), view);
  assert.equal(bodyOf(request.textFallback, 'channel_view'), view);
  assert.ok(!bodyOf(request.textFallback, 'chat').includes('attached'));
});

test('buildRequest: a routed trigger\'s pictures are not attached, nor any pulled picture', () => {
  const picture = { id: 'tp1', kind: 'image', url: 'https://cdn/tp1.png', name: 'tp1.png' };
  const config = fakeConfig({ context: { vision: { maxImages: 4, tokensPerImage: 400, imageSize: 512, recentImages: 3, recentImageMinutes: 60 } } });
  const base = routedInput();
  const trigger = { ...base.trigger, attachments: [picture] };
  const pulled = { ...base.pulled[0], messages: [...base.pulled[0].messages.slice(0, -1), trigger], descriptions: new Map([['tp1', 'une affiche']]) };
  const request = buildRequest({ ...base, config, trigger, pulled: [pulled] });
  assert.equal(typeof request.messages[1].content, 'string', 'no image part at all');
  assert.deepEqual(request.pictures, []);
  assert.equal(request.stats.images, 0);
  assert.ok(bodyOf(userText(request), 'channel_view').includes(fill(labels.transcript.imageDescribed, { text: 'une affiche' })));
});

test('buildRequest: ping marks come from pingState', () => {
  const messages = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, i) => pulledMessage(id, NOW - (50 - i) * MIN, { content: `ligne ${id}` }));
  const pingState = new Map([['p1', 'answered'], ['p2', 'unanswered'], ['p3', 'skipped'], ['p5', 'unanswered']]);
  const trigger = messages[4];
  const lineOf = (view, id) => view.split('\n').find((line) => line.includes(`ligne ${id}`));
  const view = bodyOf(
    userText(buildRequest(baseInput({ pulled: [pulledChannel({ messages, pingState })], trigger, triggerKind: 'mention', source: { channelId: SRC, reason: 'routed' } }))),
    'channel_view',
  );
  assert.ok(lineOf(view, 'p1').endsWith(`ligne p1 ${labels.pull.pingAnswered}`));
  assert.ok(lineOf(view, 'p2').endsWith(`ligne p2 ${labels.pull.pingUnanswered}`));
  assert.ok(lineOf(view, 'p3').endsWith(`ligne p3 ${labels.pull.pingSkipped}`));
  assert.ok(lineOf(view, 'p4').endsWith('ligne p4'));
  assert.ok(lineOf(view, 'p5').endsWith('ligne p5'), 'never on the trigger');

  const { pingSkipped, ...noSkipped } = labels.pull;
  const older = bodyOf(userText(buildRequest(baseInput({ pulled: [pulledChannel({ messages, pingState })], prompts: fakePrompts({ labels: { ...labels, pull: noSkipped } }) }))), 'channel_view');
  assert.ok(lineOf(older, 'p3').endsWith('ligne p3'), 'a skipped call without its label is never shown as unanswered');

  // Only a Map is read (what src/discord/pull-fetch.js builds).
  const plainObject = bodyOf(userText(buildRequest(baseInput({ pulled: [pulledChannel({ messages, pingState: Object.fromEntries(pingState) })] }))), 'channel_view');
  for (const mark of [labels.pull.pingAnswered, labels.pull.pingUnanswered, labels.pull.pingSkipped]) assert.ok(!plainObject.includes(mark), mark);
});

test('buildRequest: earlier calls render under labels.pull.earlierPings ahead of the window, the header spanning the window', () => {
  const earlier = pulledMessage('e1', NOW - 3 * 24 * HOUR, { authorId: 'u7', authorName: 'Ana', content: 'tu es là ?' });
  const messages = [earlier, pulledMessage('p1', NOW - 30 * MIN), pulledMessage('p2', NOW - 20 * MIN)];
  const pulled = pulledChannel({ messages, earlierPingIds: new Set(['e1']), pingState: new Map([['e1', 'unanswered']]) });
  const request = buildRequest(baseInput({ pulled: [pulled] }));
  const view = bodyOf(userText(request), 'channel_view').split('\n');
  assert.equal(view[0], fill(labels.pull.header, { channel: 'journal-de-zoé', from: moment(NOW - 30 * MIN), to: moment(NOW - 20 * MIN), ago: formatDuration(20 * MIN, labels.units) }));
  assert.equal(view[1], fill(labels.pull.earlierPings, { date: formatDate(NOW - 3 * 24 * HOUR, TZ, labels.locale) }));
  assert.ok(view[2].startsWith('#2 [') && view[2].endsWith(`Ana: tu es là ? ${labels.pull.pingUnanswered}`), view[2]);
  assert.ok(view.slice(3).join('\n').includes('#3 ['), 'the window follows, numbered on');
  assert.deepEqual(request.pulledKept, [{ channelId: SRC, ids: ['e1', 'p1', 'p2'], newestId: 'p2', newestTs: NOW - 20 * MIN }]);
});

test('buildRequest: authors of pulled lines join <people> as asked-about profiles under context.askedAboutProfiles', () => {
  const messages = [
    pulledMessage('p1', NOW - 40 * MIN, { authorId: 'w1', authorName: 'Zoé' }),
    pulledMessage('p2', NOW - 35 * MIN, { authorId: 'bot1', authorName: 'Robot', bot: true }),
    pulledMessage('p3', NOW - 30 * MIN, { authorId: 'me', authorName: 'Nept', self: true }),
    pulledMessage('p4', NOW - 20 * MIN, { authorId: 'w2', authorName: 'Björn' }),
  ];
  const zoe = { id: 'w1', names: ['Zoé'], character: 'rêveuse', style: 'ZOE_STYLE' };
  const bjorn = { id: 'w2', names: ['Björn'], character: 'calme', style: 'BJORN_STYLE' };
  const robot = { id: 'bot1', names: ['Robot'], character: 'ROBOT' };
  const self = { id: 'me', names: ['Nept'], character: 'SELF' };
  const people = (overrides) =>
    bodyOf(
      userText(buildRequest(baseInput({ pulled: [pulledChannel({ messages })], candidateProfiles: [zoe, bjorn, robot, self], ...overrides }))),
      'people',
    ) ?? '';

  const shown = people({});
  assert.ok(shown.includes('ZOE_STYLE') && shown.includes('BJORN_STYLE'), 'rendered in full');
  assert.ok(shown.indexOf('## Björn') < shown.indexOf('## Zoé'), 'the newest line\'s author first');
  assert.ok(!shown.includes('ROBOT') && !shown.includes('SELF'));

  const capped = people({ config: fakeConfig({ context: { askedAboutProfiles: 1 } }) });
  assert.ok(capped.includes('## Björn') && !capped.includes('## Zoé'));
  assert.equal(people({ config: fakeConfig({ context: { askedAboutProfiles: 0 } }) }), '');

  // A participant of the chat who also wrote there is promoted to a full profile; the interlocutor is never repeated.
  const trigger = destMessage(1, NOW - MIN, { authorId: 'w1', authorName: 'Zoé' });
  const promoted = people({ history: [destMessage(2, NOW - 2 * MIN, { authorId: 'w2' }), trigger], trigger, triggerKind: 'mention', interlocutor: zoe, otherProfiles: [bjorn] });
  assert.equal((promoted.match(/## Zoé/g) ?? []).length, 1);
  assert.ok(promoted.includes('BJORN_STYLE'));
});

test('buildRequest: missing pull labels degrade without throwing', () => {
  const pulled = pulledChannel({ readOnly: true, olderNotShown: true, picturesNotSeen: 2, earlierPingIds: new Set(['p1']), pingState: new Map([['p2', 'answered']]) });
  const { pull, ...noPull } = labels;
  const none = buildRequest(baseInput({ pulled: [pulled], prompts: fakePrompts({ labels: noPull }) }));
  assert.ok(!userText(none).includes('<channel_view>'));
  assert.deepEqual(none.pulledIds, new Map());
  assert.equal(none.idByIndex.size, 1);

  const headerOnly = { ...labels, pull: { header: labels.pull.header }, server: { ...labels.server, readOnly: undefined } };
  const view = bodyOf(userText(buildRequest(baseInput({ pulled: [pulled], prompts: fakePrompts({ labels: headerOnly }) }))), 'channel_view').split('\n');
  assert.equal(view.length, 3, view.join('\n'));
  assert.ok(view[0].startsWith('channel #journal-de-zoé'));
  assert.ok(view[1].endsWith('Zoé: πρώτη σελίδα'), 'an earlier call without its heading');
  assert.ok(view[2].endsWith('Zoé: δεύτερη σελίδα'), 'an answered call without its mark');
  assert.ok(!view.join('\n').includes('undefined'));
});
