// Tests for src/mentor/sandbox.js: the invented chat excerpt turned into
// normalized messages, the reply sandbox (the talk path's request, sampled,
// nothing sent) and the memory sandbox (the analyzer's request, parsed and
// applied to a store that only records), all against fakes or a temp store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveView, situationToHistory, situationHistory, answerReply, captureStore, answerMemory } from '../src/mentor/sandbox.js';
import { createStore } from '../src/memory/store.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const SELF_ID = '900000000000000001';
const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';
const CHANNEL = { id: '500000000000000001', name: 'general', category: 'Talk', topic: null };

function situation(lines, title = 'a small talk') {
  return { title, lines };
}

function twoLines() {
  return situation([
    { authorId: BRUNO, authorName: 'Bruno', text: 'καλημέρα', replyTo: null, minutesBefore: 5 },
    { authorId: ALICE, authorName: 'Alice', text: 'what do you think about chess?', replyTo: null, minutesBefore: 1 },
  ]);
}

function fakeConfig(featureOverrides = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      channelMessages: 100,
      maxMessageChars: 800,
      gapMarkerMinutes: 20,
      otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    llm: { model: 'x/chat', maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
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
    },
    relationships: { maxDeltaPerUpdate: 15, historySize: 10 },
    lore: { maxEntries: 500 },
    features: featureOverrides,
  };
}

function fakeHot(featureOverrides = {}) {
  return {
    config: fakeConfig(featureOverrides),
    prompts: {
      'system-prompt': 'SYSTEM_MARKER: you are a regular member of this chat.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      memory: 'Summarize what happened.',
      labels,
    },
  };
}

function fakeStore({ guildMemory = {}, userProfiles = {}, channels = [], loreEntries = [] } = {}) {
  const writes = [];
  const writer = (name) => () => writes.push(name);
  return {
    writes,
    getGuild: () => guildMemory,
    getUser: (guildId, userId) => userProfiles[userId] ?? null,
    getPrivate: () => {
      throw new Error('the private layer is out of bounds for the sandbox');
    },
    listChannels: () => channels,
    listUserProfiles: () => Object.values(userProfiles),
    getLore: () => loreEntries,
    applyProfileOps: writer('applyProfileOps'),
    updateGuild: writer('updateGuild'),
    state: { data: {}, markDirty: writer('markDirty') },
  };
}

function fakeLlm(texts, { usage = { total_tokens: 120 }, estimated = 100, onCall } = {}) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      if (onCall) onCall(calls.length);
      const text = Array.isArray(texts) ? texts[(calls.length - 1) % texts.length] : texts;
      return { text, usage, estimated };
    },
  };
}

function tempStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-sandbox-'));
  return Promise.resolve()
    .then(() => fn(createStore({ dataDir: dir }), dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  }
  return out.sort().map((file) => [file, fs.readFileSync(file, 'utf8')]);
}

// ---- situationToHistory ------------------------------------------------------

test('situationToHistory: the last line is the trigger', () => {
  const { history, trigger, triggerKind } = situationToHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  assert.equal(history.length, 2);
  assert.equal(trigger, history[1]);
  assert.equal(triggerKind, 'mention');
  assert.deepEqual(history.map((m) => m.id), ['sb-1', 'sb-2']);
  assert.deepEqual(trigger.mentionedUserIds, [SELF_ID]);
  assert.deepEqual(history[0].mentionedUserIds, []);
  assert.deepEqual(trigger, {
    id: 'sb-2',
    channelId: CHANNEL.id,
    channelName: 'general',
    channelCategory: 'Talk',
    channelTopic: null,
    authorId: ALICE,
    authorName: 'Alice',
    self: false,
    bot: false,
    content: 'what do you think about chess?',
    ts: NOW - 60000,
    mentionedUserIds: [SELF_ID],
    replyToId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  });
});

test('situationToHistory: a reply to her own line is triggerKind reply', () => {
  const s = situation([
    { authorId: 'self', text: 'I prefer draughts', replyTo: null, minutesBefore: 3 },
    { authorId: ALICE, authorName: 'Alice', text: 'why?', replyTo: 0, minutesBefore: 1 },
  ]);
  const { history, triggerKind, trigger } = situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  assert.equal(triggerKind, 'reply');
  assert.equal(history[0].authorId, SELF_ID);
  assert.equal(history[0].authorName, 'Zoë');
  assert.equal(history[0].self, true);
  assert.equal(trigger.replyToId, 'sb-1');
  assert.deepEqual(trigger.mentionedUserIds, []);
});

test('situationToHistory: a reply to a member line is still a mention', () => {
  const s = situation([
    { authorId: BRUNO, authorName: 'Bruno', text: 'chess is dull', replyTo: null, minutesBefore: 3 },
    { authorId: ALICE, authorName: 'Alice', text: 'agree?', replyTo: 0, minutesBefore: 1 },
  ]);
  const { triggerKind, trigger } = situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  assert.equal(triggerKind, 'mention');
  assert.equal(trigger.replyToId, 'sb-1');
});

test('situationToHistory: timestamps go back by minutesBefore', () => {
  const s = situation([
    { authorId: BRUNO, authorName: 'Bruno', text: 'a', replyTo: null, minutesBefore: 30 },
    { authorId: ALICE, authorName: 'Alice', text: 'b', replyTo: null, minutesBefore: 2 },
    { authorId: BRUNO, authorName: 'Bruno', text: 'c', replyTo: null, minutesBefore: 0 },
  ]);
  const { history } = situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  assert.deepEqual(history.map((m) => m.ts), [NOW - 30 * 60000, NOW - 2 * 60000, NOW]);
});

test('situationToHistory: missing minutesBefore spaces lines a minute apart, ending a minute before now', () => {
  const s = situation([
    { authorId: BRUNO, authorName: 'Bruno', text: 'a', replyTo: null },
    { authorId: ALICE, authorName: 'Alice', text: 'b', replyTo: null },
    { authorId: BRUNO, authorName: 'Bruno', text: 'c', replyTo: null },
  ]);
  const { history } = situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  assert.deepEqual(history.map((m) => m.ts), [NOW - 3 * 60000, NOW - 2 * 60000, NOW - 60000]);
});

test('situationToHistory: a line that would go back in time follows the previous one', () => {
  const s = situation([
    { authorId: BRUNO, authorName: 'Bruno', text: 'a', replyTo: null, minutesBefore: 2 },
    { authorId: ALICE, authorName: 'Alice', text: 'b', replyTo: null, minutesBefore: 10 },
  ]);
  const { history } = situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  assert.deepEqual(history.map((m) => m.ts), [NOW - 2 * 60000, NOW - 2 * 60000 + 1000]);
});

test('situationToHistory: missing channel fields are null', () => {
  const { trigger } = situationToHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: { id: 'c1' } });
  assert.equal(trigger.channelId, 'c1');
  assert.equal(trigger.channelName, null);
  assert.equal(trigger.channelCategory, null);
  assert.equal(trigger.channelTopic, null);
});

test('situationToHistory: refuses a last line by self', () => {
  const s = situation([
    { authorId: ALICE, authorName: 'Alice', text: 'hi', replyTo: null },
    { authorId: 'self', text: 'hello', replyTo: null },
  ]);
  assert.throws(() => situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL }));
});

test('situationToHistory: refuses fewer than 2 lines', () => {
  const s = situation([{ authorId: ALICE, authorName: 'Alice', text: 'hi', replyTo: null }]);
  assert.throws(() => situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL }));
});

test('situationToHistory: refuses a replyTo that points forward', () => {
  const s = situation([
    { authorId: BRUNO, authorName: 'Bruno', text: 'a', replyTo: 1 },
    { authorId: ALICE, authorName: 'Alice', text: 'b', replyTo: null },
  ]);
  assert.throws(() => situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL }));
});

// ---- liveView ----------------------------------------------------------------

test('liveView: reads prompts at call time', () => {
  const hot = fakeHot();
  const view = liveView({ hot, store: fakeStore(), guildId: 'g1' });
  assert.equal(view.prompts.reply, 'Someone called you: {{author}}.');
  hot.prompts = { ...hot.prompts, reply: 'EDITED' };
  hot.config = { ...hot.config, marker: 1 };
  assert.equal(view.prompts.reply, 'EDITED');
  assert.equal(view.config.marker, 1);
});

test('liveView: memory reads go to the store for the one guild', () => {
  const seen = [];
  const store = {
    getGuild: (g) => (seen.push(['getGuild', g]), { patterns: 'p' }),
    getUser: (g, id) => (seen.push(['getUser', g, id]), { id }),
    listUserProfiles: (g) => (seen.push(['listUserProfiles', g]), []),
    listChannels: (g) => (seen.push(['listChannels', g]), []),
    getLore: (g) => (seen.push(['getLore', g]), []),
  };
  const view = liveView({ hot: fakeHot(), store, guildId: 'g1' });
  view.memory.getGuild();
  view.memory.getUser('u9');
  view.memory.listUserProfiles();
  view.memory.listChannels();
  view.memory.getLore();
  assert.deepEqual(seen, [
    ['getGuild', 'g1'],
    ['getUser', 'g1', 'u9'],
    ['listUserProfiles', 'g1'],
    ['listChannels', 'g1'],
    ['getLore', 'g1'],
  ]);
  assert.equal('getPrivate' in view.memory, false);
});

test('liveView: the calibrator follows the live ratio and never feeds it', () => {
  const live = createCalibrator(0.8);
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1', calibrator: live });
  assert.equal(view.calibrator.ratio, 0.8);
  assert.equal(view.calibrator.apply(1000), live.apply(1000));

  // The sandbox observes nothing: the live ratio stays where it was.
  assert.equal(view.calibrator.observe(1000, 1500), 0.8);
  assert.equal(live.ratio, 0.8);

  // A real turn moves the live ratio; the view reads it at the moment of use.
  live.observe(1000, 1500);
  assert.notEqual(live.ratio, 0.8);
  assert.equal(view.calibrator.ratio, live.ratio);
  assert.equal(view.calibrator.apply(1000), live.apply(1000));

  // Without a live calibrator the view measures tokens as they are.
  const plain = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  assert.equal(plain.calibrator.ratio, 1);
  assert.equal(plain.calibrator.apply(123), 123);
  assert.equal(plain.calibrator.observe(1000, 1500), 1);
});

// ---- answerReply -------------------------------------------------------------

test('answerReply: sends the live system prompt and renders the member\'s profile', async () => {
  const hot = fakeHot();
  const store = fakeStore({ userProfiles: { [ALICE]: { id: ALICE, names: ['Alice'], character: 'CHARACTER_MARKER solves chess problems' } } });
  const view = liveView({ hot, store, guildId: 'g1' });
  const llm = fakeLlm('<msg reply="#2">δεν ξέρω</msg><react to="#1">👍</react>');
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });

  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('SYSTEM_MARKER'));
  assert.equal(result.request.system, system.content);
  assert.equal(typeof result.request.user, 'string');
  assert.equal(result.request.user, user.content);
  assert.ok(result.request.user.includes('CHARACTER_MARKER'));
  assert.ok(result.request.user.includes('what do you think about chess?'));
  assert.deepEqual(result.answers, [
    { messages: [{ text: 'δεν ξέρω', replyTo: 2 }], reactions: [{ to: 1, emoji: '👍' }], gif: null, draw: null, skip: false, think: '' },
  ]);
  assert.equal(result.stopped, false);
  assert.deepEqual(store.writes, [], 'nothing is written to memory');
});

/** A real moment as stored with a case: normalized messages, the trigger last. */
function storedMoment({ replyToSelf = false, mentions = [] } = {}) {
  const base = { channelId: CHANNEL.id, channelName: 'general', channelCategory: 'Talk', channelTopic: null, bot: false, mentionedUserIds: [], replyToId: null, forwardedFrom: null, attachments: [], links: [], forwarded: [], stickers: [], emojis: [], reactions: [] };
  return {
    title: '',
    anchor: 1,
    history: [
      { ...base, id: '800000000000000001', authorId: SELF_ID, authorName: 'Zoë', self: true, content: 'it opens at nine', ts: NOW - 120000 },
      {
        ...base,
        id: '800000000000000002',
        authorId: ALICE,
        authorName: 'Alice',
        self: false,
        content: `REAL_MOMENT ${'é'.repeat(1500)}`,
        ts: NOW - 60000,
        replyToId: replyToSelf ? '800000000000000001' : null,
        mentionedUserIds: mentions,
        reactions: [{ emoji: '👍', count: 2, mine: false }],
      },
    ],
    original: ['you are right, but'],
  };
}

test('situationHistory: a stored moment is replayed as stored, the last message the trigger', () => {
  const moment = storedMoment();
  const { history, trigger, triggerKind } = situationHistory(moment, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  assert.equal(history, moment.history);
  assert.equal(trigger, moment.history[1]);
  assert.equal(triggerKind, 'mention');
  assert.equal(situationHistory(storedMoment({ replyToSelf: true }), { selfId: SELF_ID }).triggerKind, 'reply');
  assert.throws(() => situationHistory({ history: [] }, { selfId: SELF_ID }), /stored/);
  assert.throws(() => situationHistory({ history: [moment.history[0]] }, { selfId: SELF_ID }), /self/);
  // Invented lines still go through situationToHistory.
  assert.equal(situationHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL }).history[0].id, 'sb-1');
});

test('answerReply: a stored moment is answered from its own messages, reactions included', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({ view, situation: storedMoment({ replyToSelf: true }), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.ok(result.request.user.includes('REAL_MOMENT'));
  assert.ok(result.request.user.includes('it opens at nine'));
  assert.ok(result.request.user.includes('[reactions: '));
  assert.equal(llm.calls[0].options.countAgainstDailyCap, false);
  assert.equal(llm.calls[0].options.skipCalibration, true);
});

test('answerReply: a stored moment over the request budget loses its oldest messages, never the trigger', async () => {
  const hot = fakeHot();
  hot.config.llm.maxRequestTokens = 2500;
  const moment = storedMoment();
  const filler = Array.from({ length: 30 }, (_, i) => ({ ...moment.history[0], id: `70000000000000${1000 + i}`, self: false, authorId: BRUNO, authorName: 'Bruno', content: `OLD_${i} ${'x'.repeat(700)}`, ts: NOW - 3_600_000 + i * 1000 }));
  const view = liveView({ hot, store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({ view, situation: { ...moment, history: [...filler, ...moment.history] }, selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.ok(result.request.user.includes('REAL_MOMENT'));
  assert.ok(!result.request.user.includes('OLD_0 '));
});

test('answerReply: makes samples requests, none counted against the daily cap', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm(['<msg>a</msg>', '<msg>b</msg>', '<skip/>']);
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 3, at: NOW });

  assert.equal(llm.calls.length, 3);
  for (const { options } of llm.calls) {
    assert.equal(options.countAgainstDailyCap, false);
    assert.equal(options.skipCalibration, true);
    assert.equal('maxRequestTokens' in options, false);
  }
  assert.deepEqual(result.answers.map((a) => a.messages.map((m) => m.text)), [['a'], ['b'], []]);
  assert.equal(result.answers[2].skip, true);
});

test('answerReply: a ratio under 1 lets a capped section keep more', async () => {
  // Enough self notes to go well past a small aboutChat cap.
  const self = Array.from({ length: 80 }, (_, i) => `note ${i + 1}: the persona likes the café on the corner and tea with honey`);
  const userTextAt = async (ratio) => {
    const hot = fakeHot();
    hot.config.context.caps.aboutChat = 300;
    const view = liveView({ hot, store: fakeStore({ guildMemory: { self } }), guildId: 'g1', calibrator: createCalibrator(ratio) });
    const llm = fakeLlm('<skip/>');
    const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
    return result.request.user;
  };
  const atOne = await userTextAt(1);
  const atLow = await userTextAt(0.7);
  assert.ok(atOne.includes('note 1:'), 'the cap keeps some notes');
  assert.equal(atOne.includes('note 80:'), false, 'the cap is reached at ratio 1');
  assert.ok(atLow.length > atOne.length, `${atLow.length} > ${atOne.length}`);
});

test('answerReply: the feature switches trim the answer as in a real turn', async () => {
  const view = liveView({ hot: fakeHot({ reactions: false, multiMessage: false }), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>one</msg><msg>two</msg><react to="#1">👍</react>');
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.deepEqual(result.answers[0].messages, [{ text: 'one', replyTo: null }]);
  assert.deepEqual(result.answers[0].reactions, []);
});

test('answerReply: reports usage through onUsage; the result carries no token count of its own', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { usage: { total_tokens: 120 }, estimated: 100 });
  const seen = [];
  const result = await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 2, at: NOW,
    onUsage: (usage, estimated) => seen.push([usage, estimated]),
  });
  assert.deepEqual(seen, [[{ total_tokens: 120 }, 100], [{ total_tokens: 120 }, 100]]);
  assert.deepEqual(Object.keys(result).sort(), ['answers', 'request', 'stopped']);
});

test('answerReply: without usage, onUsage gets null and the estimate (what the budget then charges)', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { usage: null, estimated: 70 });
  const seen = [];
  await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 2, at: NOW,
    onUsage: (usage, estimated) => seen.push([usage, estimated]),
  });
  assert.deepEqual(seen, [[null, 70], [null, 70]]);
});

const EMOJI = [{ id: '600000000000000001', name: 'wave', animated: false }];
const GIF_LIBRARY = {
  nextId: 2,
  entries: {
    k1: { id: 'g1', kind: 'link', url: 'https://tenor.com/view/dance-1', site: 'Tenor', name: 'Danse', itemId: 'k1', messageId: 'm1', channelId: CHANNEL.id, count: 3, last: NOW - 86_400_000, firstSeen: NOW - 86_400_000 },
  },
  backfill: null,
};
const MEDIA_CACHE = {
  'emoji:600000000000000001': { text: 'a waving hand', ts: NOW - 1000 },
  k1: { text: 'a dancing cat', ts: NOW - 1000 },
};

test('answerReply: the server\'s custom emoji and GIF library render as in a live turn, with their cached captions', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const result = await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW,
    customEmoji: EMOJI, gifs: GIF_LIBRARY, mediaCache: MEDIA_CACHE,
  });
  assert.ok(result.request.user.includes(`<emoji>\n${labels.emoji.header}\n:wave: -- a waving hand\n</emoji>`), result.request.user);
  assert.ok(result.request.user.includes(`<gifs>\n${labels.gifs.header}\ng1 -- a dancing cat\n</gifs>`), result.request.user);
  assert.ok(result.request.user.includes(labels.senses.customEmoji));
  assert.ok(result.request.user.includes(labels.senses.gifs));

  // The switches drop them as in a live turn; nothing handed in, nothing rendered.
  const off = liveView({ hot: fakeHot({ customEmoji: false, gifs: false }), store: fakeStore(), guildId: 'g1' });
  const without = await answerReply({
    view: off, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW,
    customEmoji: EMOJI, gifs: GIF_LIBRARY, mediaCache: MEDIA_CACHE,
  });
  const bare = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW });
  for (const { request } of [without, bare]) {
    assert.ok(!request.user.includes('<emoji>'));
    assert.ok(!request.user.includes('<gifs>'));
  }
});

test('answerReply: a GIF or a drawing alone is an action, not silence; switched off or unknown, nothing is left to do', async () => {
  const answer = async (text, { features = {}, gifs = GIF_LIBRARY } = {}) => {
    const view = liveView({ hot: fakeHot(features), store: fakeStore(), guildId: 'g1' });
    const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm(text), samples: 1, at: NOW, gifs });
    return result.answers[0];
  };
  const gif = await answer('<gif reply="#2">g1</gif>');
  assert.equal(gif.skip, false);
  assert.deepEqual(gif.gif, { id: 'g1', replyTo: 2 });
  const draw = await answer('<draw self="yes">a cat on a chessboard</draw>');
  assert.equal(draw.skip, false);
  assert.deepEqual(draw.draw, { text: 'a cat on a chessboard', self: true, replyTo: null });

  for (const [text, options] of [
    ['<gif>g9</gif>', {}],
    ['<gif>g1</gif>', { gifs: null }],
    ['<gif>g1</gif>', { features: { gifs: false } }],
    ['<draw>a cat</draw>', { features: { imageGeneration: false } }],
  ]) {
    const dropped = await answer(text, options);
    assert.equal(dropped.skip, true, `${text} ${JSON.stringify(options)}`);
    assert.equal(dropped.gif, null);
    assert.equal(dropped.draw, null);
  }
});

test('answerReply: an aborted signal stops before the next sample', async () => {
  const controller = new AbortController();
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>a</msg>', { onCall: () => controller.abort() });
  const result = await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 3, at: NOW, signal: controller.signal,
  });
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].options.signal, controller.signal);
  assert.equal(result.answers.length, 1);
  assert.equal(result.stopped, true);
});

test('answerReply: an abort during a request returns what was collected', async () => {
  const controller = new AbortController();
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      if (calls === 2) {
        controller.abort();
        throw new Error('aborted');
      }
      return { text: '<msg>a</msg>', usage: null, estimated: 5 };
    },
  };
  const result = await answerReply({
    view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 3, at: NOW, signal: controller.signal,
  });
  assert.equal(result.answers.length, 1);
  assert.equal(result.stopped, true);
});

test('answerReply: an llm error other than an abort is thrown to the caller', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = { complete: async () => { throw new Error('provider down'); } };
  await assert.rejects(
    answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW }),
    /provider down/,
  );
});

// ---- captureStore ------------------------------------------------------------

test('captureStore: a write is recorded and the real store is untouched', () =>
  tempStore(async (store, dir) => {
    store.applyProfileOps('g1', ALICE, { character: 'plays chess' }, { fieldChars: 400 });
    store.flush();
    const before = filesUnder(dir);
    const profileBefore = JSON.stringify(store.getUser('g1', ALICE));

    const view = liveView({ hot: fakeHot(), store, guildId: 'g1' });
    const { store: captured, writes } = captureStore(view);
    assert.equal(captured.getUser('ignored', ALICE).character, 'plays chess');
    captured.applyProfileOps('g1', ALICE, { character: 'plays go' }, {});
    captured.updateGuild('g1', { patterns: 'short lines' });
    captured.state.markDirty();

    assert.deepEqual(writes, [
      { method: 'applyProfileOps', args: ['g1', ALICE, { character: 'plays go' }, {}] },
      { method: 'updateGuild', args: ['g1', { patterns: 'short lines' }] },
    ]);
    assert.equal(JSON.stringify(store.getUser('g1', ALICE)), profileBefore);
    store.flush();
    assert.deepEqual(filesUnder(dir), before);
  }));

// ---- answerMemory ------------------------------------------------------------

const MEMORY_ANSWER = JSON.stringify({
  users: {
    [ALICE]: {
      character: 'Curious and quick.',
      relationship: 'Asks the persona about games.',
      aliases: { add: ['Ali'] },
      affinity: { delta: 2, reason: 'Friendly question.' },
      episodes: [{ what: 'Asked about chess.', quote: 'what do you think about chess?', feeling: 'amused', weight: 2 }],
    },
    '999999999999999999': { character: 'Not in the batch.' },
  },
  guild: { patterns: 'Short greetings in the morning.' },
  self: ['Prefers draughts.'],
  lore: [{ title: 'Chess club', keys: ['chess'], text: 'A weekly game night.' }],
  channels: { [CHANNEL.id]: { purpose: 'Everyday talk.' } },
});

test('answerMemory: returns the texts that would be stored and applies nothing', () =>
  tempStore(async (store, dir) => {
    store.touchUser('g1', ALICE, 'Alice', NOW - 86400000);
    store.applyProfileOps('g1', ALICE, { character: 'plays chess' }, { fieldChars: 400 });
    store.flush();
    const before = filesUnder(dir);

    const hot = fakeHot();
    const view = liveView({ hot, store, guildId: 'g1' });
    const { history } = situationToHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
    const llm = fakeLlm([MEMORY_ANSWER, MEMORY_ANSWER], { usage: { total_tokens: 300 }, estimated: 250 });
    const usages = [];
    const result = await answerMemory({
      view, batch: history, selfName: 'Zoë', llm, samples: 2, at: NOW, onUsage: (u, e) => usages.push([u, e]),
    });

    assert.equal(llm.calls.length, 2);
    for (const { options } of llm.calls) {
      assert.equal(options.model, 'x/memory');
      assert.equal(options.maxOutputTokens, 4000);
      assert.equal(options.timeoutMs, 9000);
      assert.equal(options.countAgainstDailyCap, false);
      assert.equal(options.skipCalibration, true);
      assert.equal('maxRequestTokens' in options, false);
    }
    assert.equal(result.request.system, 'Summarize what happened.');
    assert.ok(result.request.user.includes('what do you think about chess?'));
    assert.deepEqual(usages, [[{ total_tokens: 300 }, 250], [{ total_tokens: 300 }, 250]]);
    assert.deepEqual(Object.keys(result).sort(), ['answers', 'request', 'stopped']);
    assert.equal(result.answers.length, 2);

    const [answer] = result.answers;
    assert.equal(answer.parseOk, true);
    assert.equal(answer.applyOk, true);
    const byPath = new Map(answer.texts.map((t) => [t.path, t.text]));
    assert.equal(byPath.get(`users.${ALICE}.character`), 'Curious and quick.');
    assert.equal(byPath.get(`users.${ALICE}.relationship`), 'Asks the persona about games.');
    assert.equal(byPath.get(`users.${ALICE}.affinity.reason`), 'Friendly question.');
    assert.equal(byPath.get(`users.${ALICE}.episodes[0].what`), 'Asked about chess.');
    assert.equal(byPath.get(`users.${ALICE}.episodes[0].feeling`), 'amused');
    assert.equal(byPath.get('guild.patterns'), 'Short greetings in the morning.');
    assert.equal(byPath.get('guild.self[0]'), 'Prefers draughts.');
    assert.equal(byPath.get('lore[Chess club].text'), 'A weekly game night.');
    assert.equal(byPath.get(`channels.${CHANNEL.id}.purpose`), 'Everyday talk.');
    const all = answer.texts.map((t) => t.text);
    assert.equal(all.includes('what do you think about chess?'), false, 'an episode quote is a person\'s own words');
    assert.equal(all.includes('Ali'), false, 'aliases are names');
    assert.equal(all.includes('Not in the batch.'), false, 'an unknown member is refused as in the analyzer');
    assert.equal(all.includes('Chess club'), false, 'a lore title is a name');

    store.flush();
    assert.deepEqual(filesUnder(dir), before, 'the real store is untouched');
  }));

test('answerMemory: a non-JSON answer gives parseOk false', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const { history } = situationToHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  const llm = fakeLlm('I would store nothing here.', { usage: null, estimated: 40 });
  const result = await answerMemory({ view, batch: history, selfName: 'Zoë', llm, samples: 1, at: NOW });
  assert.deepEqual(result.answers, [{ texts: [], parseOk: false, applyOk: false }]);
});

test('answerMemory: an answer that parses but cannot be applied is applyOk false, logged with counts and the error only', async () => {
  const hot = fakeHot();
  let broken = false;
  // A store-shape mismatch that shows only once the answer is applied (the request is built first).
  const view = {
    prompts: hot.prompts,
    config: hot.config,
    memory: {
      getGuild: () => {
        if (broken) throw new TypeError('the guild memory has an unexpected shape');
        return {};
      },
      getUser: () => null,
      listUserProfiles: () => [],
      listChannels: () => [],
      getLore: () => [],
    },
  };
  const { history } = situationToHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  const llm = fakeLlm(JSON.stringify({ guild: { patterns: 'PATTERN_MARKER short greetings.' } }), { onCall: () => (broken = true) });
  const { result, logs } = await withCapturedLogs(() => answerMemory({ view, batch: history, selfName: 'Zoë', llm, samples: 1, at: NOW }));
  assert.deepEqual(result.answers, [{ texts: [], parseOk: true, applyOk: false }]);
  const failed = logs.filter((l) => l.msg === 'mentor: memory apply failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'warn');
  assert.equal(failed[0].error.name, 'TypeError');
  assert.equal(typeof failed[0].writes, 'number');
  assert.ok(!JSON.stringify(logs).includes('PATTERN_MARKER'), 'no stored text in the log');
});

test('answerMemory: the model falls back to the chat model when memory.model is null or empty', async () => {
  for (const model of [null, '']) {
    const hot = fakeHot();
    hot.config.memory.model = model;
    const view = liveView({ hot, store: fakeStore(), guildId: 'g1' });
    const { history } = situationToHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
    const llm = fakeLlm('{}');
    await answerMemory({ view, batch: history, selfName: 'Zoë', llm, samples: 1, at: NOW });
    assert.equal(llm.calls[0].options.model, 'x/chat', JSON.stringify(model));
  }
});

test('answerReply: reads everything through the view, so another view of the same shape needs no hot or store', async () => {
  const hot = fakeHot();
  const overlay = {
    prompts: { ...hot.prompts, 'system-prompt': 'OVERLAY_SYSTEM' },
    config: hot.config,
    memory: {
      getGuild: () => ({}),
      getUser: (id) => (id === ALICE ? { id: ALICE, names: ['Alice'], character: 'OVERLAY_CHARACTER' } : null),
      listUserProfiles: () => [],
      listChannels: () => [],
      getLore: () => [],
    },
  };
  const llm = fakeLlm('<skip/>');
  const result = await answerReply({ view: overlay, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW });
  assert.ok(result.request.system.includes('OVERLAY_SYSTEM'));
  assert.ok(result.request.user.includes('OVERLAY_CHARACTER'));
});

// Provider routing: the sandbox answers route as the roles they stand in for.

test('answerReply: the persona answer is routed as the talk role', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 2, at: NOW });
  assert.deepEqual(llm.calls.map((call) => call.options.role), ['talk', 'talk']);
});

test('answerMemory: the analyzer answer is routed as the analyzer role', async () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const { history } = situationToHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL });
  const llm = fakeLlm('{}');
  await answerMemory({ view, batch: history, selfName: 'Zoë', llm, samples: 1, at: NOW });
  assert.equal(llm.calls[0].options.role, 'analyzer');
});

test('answerReply: a situation\'s variety patterns render as <worn> as in a live turn; none, no block', async () => {
  const worn = [{ shape: 'mock promise ending in (no)', examples: ['fix it (no)'], count: 2 }];
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const withBlock = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW, worn });
  assert.ok(withBlock.request.user.includes(`<worn>\n${labels.variety.intro}\n- mock promise ending in (no) ("fix it (no)")\n</worn>`));
  const without = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW });
  assert.ok(!without.request.user.includes('<worn>'));
});
