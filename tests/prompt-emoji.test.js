// The `<emoji>` block and the `senses.customEmoji` line of buildRequest
// (src/behavior/prompt.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../src/behavior/prompt.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
const DAY = 86_400_000;

function fakeConfig(overrides = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500, ...overrides.caps },
      vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      customEmoji: { max: 30, ...overrides.customEmoji },
    },
    features: { vision: false, ...overrides.features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    lore: { scanMessages: 30 },
    memory: {},
  };
}

function baseInput(overrides = {}) {
  return {
    config: fakeConfig(),
    prompts: {
      'system-prompt': 'SYSTEM',
      'character-card': 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      reply: 'REPLY_TASK',
      labels,
    },
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history: [{ id: '1', ts: NOW - 60_000, authorId: 'a', authorName: 'Zoé', self: false, content: 'hi', attachments: [], stickers: [], replyToId: null }],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
}

const INDEX = [
  { id: '1', name: 'alpha', animated: false },
  { id: '2', name: 'beta', animated: true },
  { id: '3', name: 'gamma', animated: false },
  { id: '4', name: 'delta', animated: false },
];

function userText(request) {
  const content = request.messages[1].content;
  return Array.isArray(content) ? content.find((part) => part.type === 'text').text : content;
}

function emojiBlock(request) {
  const match = /<emoji>\n([\s\S]*?)\n<\/emoji>/.exec(userText(request));
  return match ? match[1].split('\n') : null;
}

function sensesOf(request) {
  const match = /<senses>\n([\s\S]*?)\n<\/senses>/.exec(userText(request));
  return match ? match[1] : '';
}

test('buildRequest: <emoji> lists the top-ranked emoji of the index, header first', () => {
  const guildMemory = {
    emojiUsage: {
      3: { name: 'gamma', count: 9, last: NOW - DAY },
      1: { name: 'alpha', count: 2, last: NOW - DAY },
      4: { name: 'delta', count: 5, last: NOW - DAY },
    },
  };
  const config = fakeConfig({ customEmoji: { max: 2 } });
  const lines = emojiBlock(buildRequest(baseInput({ config, guildMemory, customEmoji: INDEX })));
  assert.deepEqual(lines, [labels.emoji.header, ':gamma:', ':delta:']);
});

test('buildRequest: <emoji> skips a ranked emoji the server no longer has and uses its current name', () => {
  const guildMemory = {
    emojiUsage: {
      99: { name: 'gone', count: 50, last: NOW },
      2: { name: 'beta_old_name', count: 3, last: NOW },
    },
  };
  const lines = emojiBlock(buildRequest(baseInput({ guildMemory, customEmoji: INDEX })));
  assert.equal(lines[1], ':beta:');
  assert.ok(!lines.some((line) => line.includes('gone')));
});

test('buildRequest: <emoji> tops up a short ranking with the rest of the index, in index order', () => {
  const guildMemory = { emojiUsage: { 4: { name: 'delta', count: 1, last: NOW } } };
  const lines = emojiBlock(buildRequest(baseInput({ guildMemory, customEmoji: INDEX })));
  assert.deepEqual(lines, [labels.emoji.header, ':delta:', ':alpha:', ':beta:', ':gamma:']);
});

test('buildRequest: <emoji> falls back to the index order when nothing is ranked yet', () => {
  const config = fakeConfig({ customEmoji: { max: 3 } });
  const lines = emojiBlock(buildRequest(baseInput({ config, customEmoji: INDEX })));
  assert.deepEqual(lines, [labels.emoji.header, ':alpha:', ':beta:', ':gamma:']);
});

test('buildRequest: <emoji> attaches the helper caption from the media cache, entryNoText otherwise', () => {
  const mediaCache = {
    'emoji:1': { text: 'a smiling ὄρνις', ts: NOW },
    'emoji:2': { miss: 'error', ts: NOW },
  };
  const lines = emojiBlock(buildRequest(baseInput({ customEmoji: INDEX.slice(0, 3), mediaCache })));
  assert.deepEqual(lines, [labels.emoji.header, ':alpha: -- a smiling ὄρνις', ':beta:', ':gamma:']);
});

test('buildRequest: features.customEmoji off -> no <emoji> block and no senses line', () => {
  const config = fakeConfig({ features: { customEmoji: false } });
  const request = buildRequest(baseInput({ config, customEmoji: INDEX }));
  assert.equal(emojiBlock(request), null);
  assert.ok(!sensesOf(request).includes(labels.senses.customEmoji));
});

test('buildRequest: an empty index -> no <emoji> block and no senses line', () => {
  const request = buildRequest(baseInput({ customEmoji: [] }));
  assert.equal(emojiBlock(request), null);
  assert.ok(!sensesOf(request).includes(labels.senses.customEmoji));
  assert.equal(emojiBlock(buildRequest(baseInput())), null, 'no index passed at all');
});

test('buildRequest: a labels.json without the emoji keys renders nothing', () => {
  const older = { ...labels, emoji: undefined, senses: { ...labels.senses, customEmoji: undefined } };
  const request = buildRequest(baseInput({ customEmoji: INDEX, prompts: { ...baseInput().prompts, labels: older } }));
  assert.equal(emojiBlock(request), null);
  assert.ok(!userText(request).includes('undefined'));
});

test('buildRequest: context.caps.emoji trims entries from the bottom, a cap below the header drops the block', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1), name: `emoji_${i + 1}`, animated: false }));
  const full = buildRequest(baseInput({ customEmoji: many, config: fakeConfig({ customEmoji: { max: 40 } }) }));
  assert.equal(emojiBlock(full).length, 41);

  const tight = buildRequest(baseInput({ customEmoji: many, config: fakeConfig({ customEmoji: { max: 40 }, caps: { emoji: 40 } }) }));
  const lines = emojiBlock(tight);
  assert.ok(lines.length > 1 && lines.length < 41);
  assert.equal(lines[0], labels.emoji.header);
  assert.deepEqual(lines.slice(1), many.slice(0, lines.length - 1).map((e) => `:${e.name}:`));
  assert.ok(tight.stats.emoji.used <= 40);

  const none = buildRequest(baseInput({ customEmoji: many, config: fakeConfig({ caps: { emoji: 1 } }) }));
  assert.equal(emojiBlock(none), null);
});

test('buildRequest: <emoji> sits after <about_chat> and before <server>', () => {
  const guildMemory = { patterns: 'short lines' };
  const history = [{ ...baseInput().history[0], channelId: 'c1', channelName: 'general' }];
  const text = userText(buildRequest(baseInput({ customEmoji: INDEX, guildMemory, history, currentChannelId: 'c1' })));
  const aboutIdx = text.indexOf('<about_chat>');
  const emojiIdx = text.indexOf('<emoji>\n'); // the senses line names the block too
  const serverIdx = text.indexOf('<server>');
  assert.ok(aboutIdx !== -1 && emojiIdx !== -1 && serverIdx !== -1);
  assert.ok(aboutIdx < emojiIdx && emojiIdx < serverIdx);
});

test('buildRequest: senses.customEmoji follows the sticker lines', () => {
  const lines = sensesOf(buildRequest(baseInput({ customEmoji: INDEX }))).split('\n');
  assert.equal(lines[lines.indexOf(labels.senses.customEmoji) - 1], labels.senses.lottie);
});
