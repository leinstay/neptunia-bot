// The token limit buildRequest (src/behavior/prompt.js) fits a request under: `llm.safetyMargin`
// read with the same validated fallback the mentor uses (0.9), and `context.vision.tokensPerImage`
// with the same default the llm rail charges (400, src/llm/tokens.js#estimateMessages).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest } from '../src/behavior/prompt.js';
import { estimateMessages } from '../src/llm/tokens.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
// prompt.js keeps this many tokens for the tags around the blocks.
const TAG_OVERHEAD = 60;

function input({ llm = {}, vision = {}, picture = false } = {}) {
  const trigger = {
    id: '1',
    ts: NOW - 60_000,
    authorId: 'a',
    authorName: 'Zoé',
    self: false,
    content: 'regarde',
    attachments: picture ? [{ id: 'p1', kind: 'image', name: 'photo.png', url: 'https://cdn.example/photo.png' }] : [],
    stickers: [],
    replyToId: null,
  };
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        gapMarkerMinutes: 20,
        maxMessageChars: 800,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
        vision: { maxImages: 2, imageSize: 512, recentImages: 0, recentImageMinutes: 0, ...vision },
      },
      features: {},
      llm: { maxRequestTokens: 50000, ...llm },
      lore: { scanMessages: 30 },
      memory: {},
    },
    prompts: { 'system-prompt': 'SYSTEM', 'character-card': 'CARD', rules: 'RULES', format: 'FORMAT', reply: 'REPLY_TASK', labels },
    calibrator: { ratio: 1, apply: (n) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
  };
}

test('buildRequest: a missing or unusable llm.safetyMargin is read as 0.9, a usable one as given', () => {
  for (const safetyMargin of [undefined, null, 0, -0.5, 1.5, '0.5', Number.NaN]) {
    const { stats } = buildRequest(input({ llm: { safetyMargin } }));
    assert.equal(stats.limit, Math.floor(50000 * 0.9) - TAG_OVERHEAD, String(safetyMargin));
  }
  assert.equal(buildRequest(input({ llm: { safetyMargin: 0.5 } })).stats.limit, 25000 - TAG_OVERHEAD);
  assert.equal(buildRequest(input({ llm: { safetyMargin: 1 } })).stats.limit, 50000 - TAG_OVERHEAD);
});

test('buildRequest: a picture reserves context.vision.tokensPerImage, 400 when unset -- what the llm rail charges for it', () => {
  const unset = buildRequest(input({ llm: { safetyMargin: 0.9 }, picture: true }));
  assert.equal(unset.stats.images, 1);
  assert.equal(unset.stats.limit, Math.floor(50000 * 0.9) - 400 - TAG_OVERHEAD);
  const pictureCost = estimateMessages([{ content: [{ type: 'image_url', image_url: { url: 'x' } }] }]) - estimateMessages([{ content: [] }]);
  assert.equal(pictureCost, 400, 'the rail charges the same default');

  const set = buildRequest(input({ llm: { safetyMargin: 0.9 }, vision: { tokensPerImage: 1000 }, picture: true }));
  assert.equal(set.stats.limit, Math.floor(50000 * 0.9) - 1000 - TAG_OVERHEAD);
});
