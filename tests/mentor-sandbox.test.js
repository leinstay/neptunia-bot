// Tests for src/mentor/sandbox.js: the invented chat excerpt turned into
// normalized messages and the reply sandbox (the talk path's request, sampled,
// nothing sent), all against fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { liveView, situationToHistory, situationHistory, answerReply, sandboxRequestInput, SANDBOX_OMITS } from '../src/mentor/sandbox.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { fill } from '../src/discord/format.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { labels } from './fixtures/labels.js';

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

test('situationToHistory: refuses a last line by self', () => {
  const s = situation([
    { authorId: ALICE, authorName: 'Alice', text: 'hi', replyTo: null },
    { authorId: 'self', text: 'hello', replyTo: null },
  ]);
  assert.throws(() => situationToHistory(s, { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL }));
});

test('situationToHistory: a named kind is the trigger kind; only a mention tags her', () => {
  const at = { selfId: SELF_ID, selfName: 'Zoë', at: NOW, channel: CHANNEL };
  for (const kind of ['overheard', 'followUp', 'name']) {
    const { trigger, triggerKind } = situationToHistory({ ...twoLines(), kind }, at);
    assert.equal(triggerKind, kind);
    assert.deepEqual(trigger.mentionedUserIds, [], kind);
  }
  assert.deepEqual(situationToHistory({ ...twoLines(), kind: 'mention' }, at).trigger.mentionedUserIds, [SELF_ID]);
  // `reply` needs a last line that replies to hers; an unknown kind is no kind: the guess.
  assert.equal(situationToHistory({ ...twoLines(), kind: 'reply' }, at).triggerKind, 'mention');
  assert.equal(situationToHistory({ ...twoLines(), kind: 'drawFailed' }, at).triggerKind, 'mention');
  assert.equal(situationToHistory({ ...twoLines(), kind: 'shouted' }, at).triggerKind, 'mention');
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

test('answerReply: a situation\'s variety patterns render as <worn> as in a live turn; none, no block', async () => {
  const worn = [{ shape: 'mock promise ending in (no)', examples: ['fix it (no)'], count: 2 }];
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const withBlock = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW, worn });
  assert.ok(withBlock.request.user.includes(`<worn>\n${labels.variety.intro}\n- mock promise ending in (no)\n</worn>`));
  const without = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<msg>ok</msg>'), samples: 1, at: NOW });
  assert.ok(!without.request.user.includes('<worn>'));
});

// ---- a stored moment replayed as the turn it was ----------------------------

/** The task texts of the reply, overheard and interject prompts, each naming itself. */
function kindHot(featureOverrides = {}) {
  const hot = fakeHot(featureOverrides);
  hot.prompts = {
    ...hot.prompts,
    reply: 'REPLY_TASK {{author}}: {{trigger}}',
    overheard: 'OVERHEARD_TASK {{author}}: {{trigger}}',
    interject: 'INTERJECT_TASK',
  };
  return hot;
}

const TRIGGER_ID = '800000000000000002';
const SOURCE = { id: '500000000000000002', name: 'announcements' };
const KITCHEN = { id: '500000000000000003', name: 'kitchen' };

/** A channel window as src/mentor/anchor.js#resolveAnchor stores it: lines `[id, authorId, authorName, text]`. */
function storedWindow(channel, lines, { reason = 'mention', readOnly = false } = {}) {
  const base = { channelId: channel.id, channelName: channel.name, channelCategory: null, channelTopic: null, self: false, bot: false, mentionedUserIds: [], replyToId: null, forwardedFrom: null, attachments: [], links: [], forwarded: [], stickers: [], emojis: [], reactions: [] };
  const messages = lines.map(([id, authorId, authorName, content], i) => ({ ...base, id, authorId, authorName, content, ts: NOW - (lines.length - i) * 90_000 }));
  return { channelId: channel.id, channelName: channel.name, readOnly, reason, messages, olderNotShown: false };
}

function aliceStore() {
  return fakeStore({
    userProfiles: {
      [ALICE]: { id: ALICE, names: ['Alice'], character: 'ALICE_PORTRAIT' },
      [BRUNO]: { id: BRUNO, names: ['Bruno'], character: 'BRUNO_PORTRAIT' },
    },
  });
}

async function replay(situation, { hot = kindHot(), samples = 1, ...extra } = {}) {
  const view = liveView({ hot, store: aliceStore(), guildId: 'g1' });
  const llm = fakeLlm('<skip/>');
  const result = await answerReply({ view, situation, selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples, at: NOW, ...extra });
  return { ...result, llm };
}

test('situationHistory: a stored kind replaces the guess; the trigger is found by its id', () => {
  const moment = { ...storedMoment(), kind: 'overheard', triggerId: TRIGGER_ID };
  const { trigger, triggerKind } = situationHistory(moment, { selfId: SELF_ID });
  assert.equal(triggerKind, 'overheard');
  assert.equal(trigger.id, TRIGGER_ID);
  // A kind a turn does not know is no kind: the guess.
  assert.equal(situationHistory({ ...storedMoment(), kind: 'shouted' }, { selfId: SELF_ID }).triggerKind, 'mention');
  // A line of hers after the trigger (her request held it) does not make the moment unusable.
  const later = { ...moment.history[0], id: '800000000000000003', content: 'a later line of hers', ts: NOW - 30_000 };
  const extended = situationHistory({ ...moment, history: [...moment.history, later] }, { selfId: SELF_ID });
  assert.equal(extended.trigger.id, TRIGGER_ID);
  assert.equal(extended.history.length, 3);
  // A trigger id that points at her own line is refused.
  assert.throws(() => situationHistory({ ...moment, triggerId: '800000000000000001' }, { selfId: SELF_ID }), /self/);
});

test('situationHistory: a spontaneous moment has no trigger, whoever wrote last', () => {
  for (const mode of ['interject', 'initiate']) {
    const own = { ...storedMoment(), mode, history: storedMoment().history.slice(0, 1) };
    const { history, trigger, triggerKind } = situationHistory(own, { selfId: SELF_ID });
    assert.equal(history.length, 1);
    assert.equal(trigger, null);
    assert.equal(triggerKind, null);
  }
});

test('answerReply: a moment stored as overheard is replayed with the overheard task and its trigger label', async () => {
  const overheard = await replay({ ...storedMoment(), mode: 'reply', kind: 'overheard', triggerId: TRIGGER_ID });
  assert.ok(overheard.request.user.includes(`OVERHEARD_TASK Alice: ${labels.triggers.overheard}`), overheard.request.user);
  assert.ok(!overheard.request.user.includes('REPLY_TASK'));
  // Its author is not the one who called her.
  assert.ok(overheard.request.user.includes('ALICE_PORTRAIT'));
  assert.ok(!overheard.request.user.includes(labels.profile.interlocutorMark));
  // The same moment without its kind is the old guess: a mention under the reply task.
  const guessed = await replay(storedMoment());
  assert.ok(guessed.request.user.includes(`REPLY_TASK Alice: ${labels.triggers.mention}`));
  assert.ok(guessed.request.user.includes(labels.profile.interlocutorMark));
});

test('answerReply: a follow-up and a name call keep their trigger labels; a spontaneous moment takes its mode\'s task', async () => {
  for (const kind of ['followUp', 'name']) {
    const result = await replay({ ...storedMoment(), mode: 'reply', kind, triggerId: TRIGGER_ID });
    assert.ok(result.request.user.includes(`REPLY_TASK Alice: ${labels.triggers[kind]}`), kind);
  }
  const unasked = await replay({ ...storedMoment(), mode: 'interject', kind: null, triggerId: null });
  assert.ok(unasked.request.user.includes('INTERJECT_TASK'));
  assert.ok(!unasked.request.user.includes('REPLY_TASK'));
  assert.ok(!unasked.request.user.includes(labels.profile.interlocutorMark), 'nobody called her');
  // An unknown mode is a reply.
  const odd = await replay({ ...storedMoment(), mode: 'auto' });
  assert.ok(odd.request.user.includes('REPLY_TASK'));
});

test('answerReply: a follow-up and an untagged reply are replayed with the follow-up task; a tagged reply keeps reply.md', async () => {
  const hot = kindHot();
  hot.prompts = { ...hot.prompts, 'follow-up': 'FOLLOW_UP_TASK {{author}}: {{trigger}}' };
  const followUp = await replay({ ...storedMoment(), mode: 'reply', kind: 'followUp', triggerId: TRIGGER_ID }, { hot });
  assert.ok(followUp.request.user.includes(`FOLLOW_UP_TASK Alice: ${labels.triggers.followUp}`), followUp.request.user);
  assert.ok(!followUp.request.user.includes('REPLY_TASK'));
  const untagged = await replay({ ...storedMoment({ replyToSelf: true }), mode: 'reply', kind: 'reply', triggerId: TRIGGER_ID }, { hot });
  assert.ok(untagged.request.user.includes(`FOLLOW_UP_TASK Alice: ${labels.triggers.reply}`), untagged.request.user);
  const tagged = await replay({ ...storedMoment({ replyToSelf: true, mentions: [SELF_ID] }), mode: 'reply', kind: 'reply', triggerId: TRIGGER_ID }, { hot });
  assert.ok(tagged.request.user.includes(`REPLY_TASK Alice: ${labels.triggers.reply}`), tagged.request.user);
  assert.ok(!tagged.request.user.includes('FOLLOW_UP_TASK'));
});

test('answerReply: a moment with a pulled channel is replayed with its <channel_view>', async () => {
  const kitchen = storedWindow(KITCHEN, [['800000000000000101', BRUNO, 'Bruno', 'PULLED_LINE the oven is on']]);
  const result = await replay({ ...storedMoment(), pulled: [kitchen] });
  assert.match(result.request.user, /<channel_view>\n[^]*PULLED_LINE the oven is on[^]*\n<\/channel_view>/);
  assert.ok(result.request.user.includes('channel #kitchen'));
  // An invented situation is shown no other channel.
  const invented = await replay({ ...twoLines(), pulled: [kitchen] });
  assert.ok(!invented.request.user.includes('<channel_view>'));
});

test('answerReply: a routed moment answers the call in its source channel, with the called text', async () => {
  const call = '800000000000000202';
  const source = storedWindow(SOURCE, [['800000000000000201', ALICE, 'Alice', 'an earlier note'], [call, BRUNO, 'Bruno', 'CALL_LINE are you there?']], { reason: 'routed', readOnly: true });
  const situation = { ...storedMoment(), mode: 'reply', kind: 'mention', triggerId: call, source: { channelId: SOURCE.id, reason: 'routed' }, pulled: [source] };
  const called = fill(labels.elsewhere.called, { channel: SOURCE.name, destination: CHANNEL.name });
  const result = await replay(situation);
  assert.match(result.request.user, /<channel_view>\n[^]*CALL_LINE are you there\?[^]*\n<\/channel_view>/);
  assert.ok(result.request.user.includes(called), result.request.user);
  assert.ok(result.request.user.includes(`REPLY_TASK Bruno: ${labels.triggers.mention}`));
  assert.ok(result.request.user.includes('BRUNO_PORTRAIT'));
  // Without its source the same lines are a pulled channel and no called text.
  const plain = await replay({ ...situation, source: null, triggerId: TRIGGER_ID });
  assert.ok(!plain.request.user.includes(called));
});

test('answerReply: the destination of a read-only call and the search flag reach <senses>', async () => {
  const destination = fill(labels.senses.elsewhere, { destination: 'general' });
  const withBoth = await replay(storedMoment(), { hot: kindHot({ webLookup: true }), elsewhereDestination: { name: 'general' }, searchAvailable: true });
  assert.ok(withBoth.request.user.includes(destination));
  assert.ok(withBoth.request.user.includes(labels.senses.search));
  const without = await replay(storedMoment(), { hot: kindHot({ webLookup: true }) });
  assert.ok(!without.request.user.includes(destination));
  assert.ok(!without.request.user.includes(labels.senses.search));
});

test('answerReply: the sandbox never runs the server search, so <senses> never offers it', async () => {
  assert.ok(Object.hasOwn(SANDBOX_OMITS, 'recallAvailable'));
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const input = sandboxRequestInput({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW, recallAvailable: true });
  assert.equal(input.recallAvailable, null);
  const result = await replay(storedMoment(), { hot: kindHot({ webLookup: true }), searchAvailable: true });
  assert.ok(result.request.user.includes(labels.senses.search));
  assert.ok(!result.request.user.includes(labels.senses.recall));
});

test('answerReply: with the prompt cache on, samples 1 and 2 carry the same marked user part', async () => {
  const cachedHot = () => {
    const hot = fakeHot({ promptCache: true });
    hot.config.llm.model = 'anthropic/claude-test';
    return hot;
  };
  const view = liveView({ hot: cachedHot(), store: fakeStore(), guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 2, at: NOW });
  const [first, second] = llm.calls.map((call) => call.messages[1].content);
  assert.deepEqual(first, second);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'text');
  assert.equal(first[0].text, result.request.user);
  assert.ok(first[0].cache_control, 'the part carries the cache marker');

  // One sample, or a request the client does not cache: the plain text as before.
  const single = fakeLlm('<msg>ok</msg>');
  await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: single, samples: 1, at: NOW });
  assert.equal(typeof single.calls[0].messages[1].content, 'string');
  const off = fakeLlm('<msg>ok</msg>');
  const offHot = cachedHot();
  offHot.config.features.promptCache = false;
  await answerReply({ view: liveView({ hot: offHot, store: fakeStore(), guildId: 'g1' }), situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: off, samples: 2, at: NOW });
  assert.ok(off.calls.every((call) => typeof call.messages[1].content === 'string'));
});

test('answerReply: every sample is sent as the mentor\'s', async () => {
  const { llm } = await replay(storedMoment(), { samples: 2 });
  assert.equal(llm.calls.length, 2);
  assert.ok(llm.calls.every((call) => call.options.origin === 'mentor' && call.options.role === 'voice' && call.options.purpose === 'reply'));
});

// ---- the last hours: <recent> -------------------------------------------------

const HOUR = 3_600_000;

/** A recent line the way the store hands it over (src/memory/store.js#getRecent). */
function recentLine(id, text, { at = NOW - HOUR, channelId = CHANNEL.id } = {}) {
  return { id, at, addedAt: new Date(at + 60_000).toISOString(), channelId, text, who: [], weight: 2 };
}

/** A store that keeps a recent store too, counting its reads. */
function recentStore(lines) {
  const reads = [];
  return { ...fakeStore(), reads, getRecent: (guildId) => (reads.push(guildId), { nextId: lines.length + 1, lines }) };
}

test('liveView: the recent store is read for the one guild; a store without one reads as none', () => {
  const store = recentStore([recentLine(1, 'η αγορά άνοιξε')]);
  const view = liveView({ hot: fakeHot(), store, guildId: 'g1' });
  assert.deepEqual(view.memory.getRecent().lines.map((line) => line.text), ['η αγορά άνοιξε']);
  assert.deepEqual(store.reads, ['g1']);
  assert.equal(liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' }).memory.getRecent(), null);
});

test('answerReply: the channel\'s recent lines inside the window render as <recent>, as they stood at the turn\'s time', async () => {
  const lines = [
    recentLine(1, 'RECENT_HERE the café closed early'),
    recentLine(2, 'RECENT_ELSEWHERE a kitchen rumour', { channelId: KITCHEN.id }),
    recentLine(3, 'RECENT_OLD the market moved', { at: NOW - 80 * HOUR }),
  ];
  const ask = async (store, featureOverrides = {}, at = NOW) => {
    const view = liveView({ hot: fakeHot(featureOverrides), store, guildId: 'g1' });
    const result = await answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm: fakeLlm('<skip/>'), samples: 1, at });
    return result.request.user;
  };
  const user = await ask(recentStore(lines));
  const block = /<recent>\n([^]*?)\n<\/recent>/.exec(user)?.[1] ?? '';
  assert.ok(block.startsWith(fill(labels.recent.header, { hours: 72 })), user);
  assert.ok(block.includes('RECENT_HERE the café closed early'));
  // Another channel's audience cannot be checked without the guild: its line stays out.
  assert.ok(!user.includes('RECENT_ELSEWHERE'));
  // A line older than memory.recentHours at the turn's time is no longer live.
  assert.ok(!user.includes('RECENT_OLD'));
  // The window is measured at the turn's time, not at today's.
  assert.ok((await ask(recentStore(lines), {}, NOW - 70 * HOUR)).includes('RECENT_OLD the market moved'));

  // No block: the switch off, memory off, a store without a recent store.
  for (const without of [await ask(recentStore(lines), { recent: false }), await ask(recentStore(lines), { memory: false }), await ask(fakeStore())]) {
    assert.ok(!without.includes('<recent>'));
  }
});

test('answerReply: a recent store that cannot be read costs the block, never the answer', async () => {
  const store = { ...fakeStore(), getRecent: () => { throw new Error('the memory store is read-only here'); } };
  const view = liveView({ hot: fakeHot(), store, guildId: 'g1' });
  const llm = fakeLlm('<msg>ok</msg>');
  const { result, logs } = await withCapturedLogs(() =>
    answerReply({ view, situation: twoLines(), selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, llm, samples: 1, at: NOW }),
  );
  assert.equal(result.answers.length, 1);
  assert.ok(!result.request.user.includes('<recent>'));
  assert.deepEqual(logs.map((entry) => [entry.level, entry.msg]), [['warn', 'mentor: recent failed']]);
});

/** Every input buildRequest reads: the keys it destructures from `input` and each `input.<key>` of its body. */
function buildRequestInputs() {
  const source = fs.readFileSync(new URL('../src/behavior/prompt.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function buildRequest(input) {');
  assert.ok(start >= 0, 'buildRequest is where this test reads it');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const destructured = /const \{([^}]*)\} = input;/.exec(body);
  assert.ok(destructured, 'buildRequest destructures its input');
  const keys = destructured[1].split(',').map((part) => part.trim().split(/[\s=:]/)[0]).filter(Boolean);
  for (const match of body.matchAll(/\binput\.(\w+)/g)) keys.push(match[1]);
  return new Set(keys);
}

test('sandboxRequestInput: names every input buildRequest reads; what it leaves out is SANDBOX_OMITS, passed as absent', () => {
  const view = liveView({ hot: fakeHot(), store: fakeStore(), guildId: 'g1' });
  const wanted = buildRequestInputs();
  assert.ok(wanted.has('history') && wanted.has('pulled') && wanted.has('worn'), 'the reader finds both kinds of key');
  for (const situation of [twoLines(), { ...storedMoment(), mode: 'interject' }]) {
    const input = sandboxRequestInput({ view, situation, selfId: SELF_ID, selfName: 'Zoë', channel: CHANNEL, at: NOW });
    assert.deepEqual(Object.keys(input).sort(), [...wanted].sort());
    const passed = Object.keys(input).filter((key) => !Object.hasOwn(SANDBOX_OMITS, key));
    assert.deepEqual(new Set([...passed, ...Object.keys(SANDBOX_OMITS)]), wanted);
    for (const key of passed) assert.notEqual(input[key], undefined, `${key} is named`);
    for (const [key, reason] of Object.entries(SANDBOX_OMITS)) {
      assert.ok(typeof reason === 'string' && reason.trim(), `${key} says why`);
      const absent = input[key] === null || (Array.isArray(input[key]) && input[key].length === 0);
      assert.ok(absent, `${key} is left out`);
    }
  }
});
