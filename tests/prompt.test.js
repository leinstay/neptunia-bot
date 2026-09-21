// Tests for src/behavior/prompt.js: buildRequest, the one-shot LLM request
// assembler. Uses fake prompts/config/labels only -- never reads prompts/ or
// data/. tests/fixtures/labels.js is an English fixture covering every key of
// the prompt contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, renderProfile } from '../src/behavior/prompt.js';
import { estimateTokens } from '../src/llm/tokens.js';
import { fill } from '../src/discord/format.js';
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
      // 340 was tight enough pre-F17; the <senses> block grew a few lines
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

// --- vision: the trigger's own sticker (F17) --------------------------------

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
  const config = fakeConfig({ llm: { maxRequestTokens: 340, safetyMargin: 1 } });
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
  // 340 was tight enough pre-F17; the <senses> block grew a few lines
  // (stickers/lottie, part of the always-kept "fixed" section) so the
  // budget needs a little more headroom to still leave room for chat.
  const config = fakeConfig({ llm: { maxRequestTokens: 400, safetyMargin: 1 } });
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

test('renderProfile: episodes are never rendered for a non-interlocutor profile', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', episodes: [episodeFixture()] };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: false, episodes: { enabled: true } });
  assert.ok(!text.includes(labels.profile.episodes));
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
  // the two -- see .claude/docs/prompt-contract.md, "More is stored than shown,
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
  const config = fakeConfig({ features: { vision: true, mediaDescriptions: true } });
  const request = buildRequest(baseInput({ config }));
  const senses = sensesOf(request);
  assert.ok(senses.includes(labels.senses.imageDescribed));
  assert.ok(senses.includes(labels.senses.gifDescribed));
  assert.ok(senses.includes(labels.senses.videoDescribed));
  assert.ok(!senses.includes(labels.senses.imageBlind));
  assert.ok(!senses.includes(labels.senses.gifBlind));
  assert.ok(!senses.includes(labels.senses.videoBlind));
});

test('buildRequest: <senses> is omitted entirely when labels has no senses section', () => {
  const brokenLabels = { ...labels, senses: undefined };
  const request = buildRequest(baseInput({ prompts: fakePrompts({ labels: brokenLabels }) }));
  const user = request.messages[1].content;
  assert.ok(!user.includes('<senses>'));
});

// --- <senses>: stickers/Lottie (F17) ---------------------------------------

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

// --- renderProfile: aliases (F29) ----------------------------------------------

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

// --- renderProfile: <@id> tokens resolved for the chat model (F29) -------------

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

// --- buildRequest: <@id> tokens resolved for the chat model, wired through (F29) --

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

// --- buildRequest: silent members pulled into <people> by name/alias (F29) -----

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

test('buildRequest: silent members pulled in by name are rendered AFTER the actual participants', () => {
  const history = [makeMessage(1, NOW - MIN, { authorName: 'Carl', content: 'Dana would find this funny' })];
  const otherProfiles = [{ id: 'p2', names: ['Carl'], character: 'talkative' }];
  const candidateProfiles = [{ id: 'p9', names: ['Dana'], character: 'sarcastic' }];
  const request = buildRequest(baseInput({ history, otherProfiles, candidateProfiles }));
  const user = request.messages[1].content;
  const carlIdx = user.indexOf('## Carl');
  const danaIdx = user.indexOf('## Dana');
  assert.ok(carlIdx !== -1 && danaIdx !== -1 && carlIdx < danaIdx);
});

test('buildRequest: no candidateProfiles at all pulls nobody in and never throws', () => {
  const history = [makeMessage(1, NOW - MIN, { content: 'Dana would love this joke' })];
  const request = buildRequest(baseInput({ history }));
  assert.ok(!request.messages[1].content.includes('## Dana'));
});
