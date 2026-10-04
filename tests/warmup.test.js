// Tests for src/memory/warmup.js: THE way memory starts. Pure helpers
// (pickPeople, memberStats, splitNewestOlder, sampleMember,
// selectChannelMessages, markOwnContext, buildChannelRequest,
// clampProfileResult, clampChannelResult, clampServerResult,
// takeFittingPrefix, buildPersonWriteIterations) are tested directly; the
// factory is tested against a fake discord.js guild/channel, a fake LLM
// client and a real (temp-dir) store. No network, no real prompts/ or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/memory/store.js';

import {
  pickPeople,
  memberStats,
  splitNewestOlder,
  sampleMember,
  selectChannelMessages,
  markOwnContext,
  buildChannelRequest,
  clampProfileResult,
  clampChannelResult,
  clampServerResult,
  takeFittingPrefix,
  buildPersonWriteIterations,
  createWarmup,
} from '../src/memory/warmup.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A normalized-message-shaped fixture, just enough for the pure helpers and formatTranscript. */
function msg(id, ts, overrides = {}) {
  return {
    id: String(id),
    ts,
    authorId: 'other',
    authorName: 'Other',
    content: `m${id}`,
    channelId: 'c1',
    channelName: 'general',
    self: false,
    bot: false,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    forwarded: [],
    ...overrides,
  };
}

/** A ChannelWindow fixture. */
function win(id, messages, overrides = {}) {
  return { id, name: id, category: null, topic: null, messages, ...overrides };
}

// ---------------------------------------------------------------------------
// pickPeople / memberStats
// ---------------------------------------------------------------------------

test('pickPeople: counts own messages, excludes bots and the persona itself, sorts most active first', () => {
  const windows = [
    win('c1', [
      msg(1, 1000, { authorId: 'a', authorName: 'Alice' }),
      msg(2, 2000, { authorId: 'a', authorName: 'Alice' }),
      msg(3, 3000, { authorId: 'bot1', bot: true }),
      msg(4, 4000, { self: true }),
      msg(5, 5000, { authorId: 'b', authorName: 'Bob' }),
    ]),
  ];
  const people = pickPeople(windows, { minMessages: 1, maxPeople: 10 });
  assert.deepEqual(people.map((p) => p.id), ['a', 'b']);
  assert.equal(people[0].messages, 2);
  assert.equal(people[1].messages, 1);
});

test('pickPeople: minMessages drops people below the threshold', () => {
  const windows = [
    win('c1', [
      msg(1, 1000, { authorId: 'a' }),
      msg(2, 2000, { authorId: 'a' }),
      msg(3, 3000, { authorId: 'a' }),
      msg(4, 4000, { authorId: 'b' }),
    ]),
  ];
  const people = pickPeople(windows, { minMessages: 2, maxPeople: 10 });
  assert.deepEqual(people.map((p) => p.id), ['a']);
});

test('pickPeople: maxPeople caps the ranked list', () => {
  const windows = [
    win('c1', [
      msg(1, 1000, { authorId: 'a' }),
      msg(2, 2000, { authorId: 'a' }),
      msg(3, 3000, { authorId: 'b' }),
      msg(4, 4000, { authorId: 'c' }),
    ]),
  ];
  const people = pickPeople(windows, { minMessages: 1, maxPeople: 2 });
  assert.equal(people.length, 2);
  assert.deepEqual(people.map((p) => p.id), ['a', 'b']);
});

test('pickPeople: byChannel counts and first/last timestamps, across channels', () => {
  const windows = [
    win('c1', [msg(1, 1000, { authorId: 'a', channelId: 'c1' }), msg(2, 5000, { authorId: 'a', channelId: 'c1' })]),
    win('c2', [msg(3, 3000, { authorId: 'a', channelId: 'c2' })]),
  ];
  const [alice] = pickPeople(windows, { minMessages: 1, maxPeople: 10 });
  assert.deepEqual(alice.byChannel, { c1: 2, c2: 1 });
  assert.equal(alice.firstTs, 1000);
  assert.equal(alice.lastTs, 5000);
});

test('memberStats: full stats regardless of any threshold', () => {
  const windows = [win('c1', [msg(1, 1000, { authorId: 'a' })])];
  const alice = memberStats(windows, 'a');
  assert.equal(alice.messages, 1);
});

test('memberStats: null for a member who wrote nothing', () => {
  const windows = [win('c1', [msg(1, 1000, { authorId: 'a' })])];
  assert.equal(memberStats(windows, 'ghost'), null);
});

// ---------------------------------------------------------------------------
// splitNewestOlder
// ---------------------------------------------------------------------------

test('splitNewestOlder: total <= 0 returns nothing', () => {
  const pool = [{ id: 0 }, { id: 1 }];
  assert.deepEqual(splitNewestOlder(pool, 0), []);
  assert.deepEqual(splitNewestOlder(pool, -3), []);
});

test('splitNewestOlder: total >= length reconstructs the original chronological order', () => {
  const pool = Array.from({ length: 5 }, (_, i) => ({ id: i }));
  assert.deepEqual(splitNewestOlder(pool, 5), pool);
  assert.deepEqual(splitNewestOlder(pool, 99), pool);
});

test('splitNewestOlder: half from the newest third, the rest evenly spread over the older part', () => {
  const pool = Array.from({ length: 9 }, (_, i) => ({ id: i }));
  const chosen = splitNewestOlder(pool, 6);
  // newest third = ids 6,7,8 (all kept); older two-thirds = ids 0..5, 3 spread evenly -> 0,2,4
  assert.deepEqual(chosen.map((m) => m.id), [0, 2, 4, 6, 7, 8]);
});

test('splitNewestOlder: deterministic across repeated calls', () => {
  const pool = Array.from({ length: 9 }, (_, i) => ({ id: i }));
  assert.deepEqual(splitNewestOlder(pool, 6), splitNewestOlder(pool, 6));
});

// ---------------------------------------------------------------------------
// sampleMember
// ---------------------------------------------------------------------------

test('sampleMember: context before + reply target attached, chronological order preserved', () => {
  const messages = [
    msg(0, 0, { authorId: 'other' }),
    msg(1, 1000, { authorId: 'a' }), // own
    msg(2, 2000, { authorId: 'other' }),
    msg(3, 3000, { authorId: 'a' }), // own
    msg(4, 4000, { authorId: 'other' }),
    msg(5, 5000, { authorId: 'a', replyToId: '2' }), // own, replies to msg 2
  ];
  const windows = [win('c1', messages)];
  const cfg = { messagesPerPerson: 3, contextBefore: 1, maxChannelShare: 1 };
  const sample = sampleMember(windows, 'a', cfg, new Set());

  assert.equal(sample.ownCount, 3);
  assert.deepEqual([...sample.ownIds].sort(), ['1', '3', '5']);
  // context: msg0 (before msg1), msg2 (before msg3, and also the reply target of msg5), msg4 (before msg5)
  assert.equal(sample.contextCount, 3);
  assert.deepEqual(sample.messages.map((m) => m.id), ['0', '1', '2', '3', '4', '5']);
});

test('sampleMember: overlapping context windows are merged, never double-counted', () => {
  const messages = [
    msg(0, 0, { authorId: 'other' }),
    msg(1, 1000, { authorId: 'other' }),
    msg(2, 2000, { authorId: 'a' }), // own
    msg(3, 3000, { authorId: 'a' }), // own, right after msg 2
    msg(4, 4000, { authorId: 'other' }),
  ];
  const windows = [win('c1', messages)];
  const cfg = { messagesPerPerson: 2, contextBefore: 2, maxChannelShare: 1 };
  const sample = sampleMember(windows, 'a', cfg, new Set());

  // msg2's context wants {0,1}; msg3's context wants {1,2} (2 is own already) -- msg1 must appear once.
  assert.equal(sample.ownCount, 2);
  assert.equal(sample.contextCount, 2); // msg0, msg1 -- msg4 is never pulled in
  assert.deepEqual(sample.messages.map((m) => m.id), ['0', '1', '2', '3']);
});

test('sampleMember: a non-main channel is capped at maxChannelShare of the total sample', () => {
  const c1 = Array.from({ length: 10 }, (_, i) => msg(`c1-${i}`, i * 1000, { authorId: 'a', channelId: 'c1', channelName: 'c1' }));
  const c2 = Array.from({ length: 10 }, (_, i) => msg(`c2-${i}`, i * 1000, { authorId: 'a', channelId: 'c2', channelName: 'c2' }));
  const windows = [win('c1', c1), win('c2', c2)];
  const cfg = { messagesPerPerson: 6, contextBefore: 0, maxChannelShare: 0.5 };
  const sample = sampleMember(windows, 'a', cfg, new Set());

  assert.equal(sample.ownCount, 6);
  const perChannel = { c1: 0, c2: 0 };
  for (const id of sample.ownIds) perChannel[id.startsWith('c1') ? 'c1' : 'c2'] += 1;
  assert.equal(perChannel.c1, 3);
  assert.equal(perChannel.c2, 3);
});

test('sampleMember: a main channel is exempt from the share cap and filled first', () => {
  const main = Array.from({ length: 5 }, (_, i) => msg(`m-${i}`, i * 1000, { authorId: 'a', channelId: 'main', channelName: 'main' }));
  const other = Array.from({ length: 10 }, (_, i) => msg(`o-${i}`, i * 1000, { authorId: 'a', channelId: 'other', channelName: 'other' }));
  const windows = [win('main', main), win('other', other)];
  // Non-main share cap would be floor(6 * 0.3) = 1 -- the main channel must ignore it entirely.
  const cfg = { messagesPerPerson: 6, contextBefore: 0, maxChannelShare: 0.3 };
  const sample = sampleMember(windows, 'a', cfg, new Set(['main']));

  const fromMain = [...sample.ownIds].filter((id) => id.startsWith('m-')).length;
  const fromOther = [...sample.ownIds].filter((id) => id.startsWith('o-')).length;
  assert.equal(fromMain, 5); // all of the main channel's own messages, uncapped
  assert.equal(fromOther, 1); // the remaining budget, capped at the non-main share
});

test('sampleMember: deterministic across repeated calls', () => {
  const messages = Array.from({ length: 20 }, (_, i) => msg(i, i * 1000, { authorId: i % 3 === 0 ? 'a' : 'other' }));
  const windows = [win('c1', messages)];
  const cfg = { messagesPerPerson: 4, contextBefore: 1, maxChannelShare: 1 };
  const a = sampleMember(windows, 'a', cfg, new Set());
  const b = sampleMember(windows, 'a', cfg, new Set());
  assert.deepEqual(a.messages, b.messages);
  assert.deepEqual([...a.ownIds].sort(), [...b.ownIds].sort());
});

test('sampleMember: nothing to sample for a member with no own messages, or messagesPerPerson 0', () => {
  const windows = [win('c1', [msg(1, 1000, { authorId: 'other' })])];
  assert.deepEqual(sampleMember(windows, 'a', { messagesPerPerson: 10 }, new Set()).messages, []);
  assert.deepEqual(sampleMember(windows, 'other', { messagesPerPerson: 0 }, new Set()).messages, []);
});

// ---------------------------------------------------------------------------
// selectChannelMessages
// ---------------------------------------------------------------------------

test('selectChannelMessages: keeps the newest N, chronological order preserved', () => {
  const messages = Array.from({ length: 5 }, (_, i) => msg(i, i * 1000));
  assert.deepEqual(selectChannelMessages(messages, 2).map((m) => m.id), ['3', '4']);
});

test('selectChannelMessages: an invalid/absent N keeps everything', () => {
  const messages = Array.from({ length: 3 }, (_, i) => msg(i, i * 1000));
  assert.deepEqual(selectChannelMessages(messages, 0), messages);
  assert.deepEqual(selectChannelMessages(messages, undefined), messages);
});

// ---------------------------------------------------------------------------
// markOwnContext
// ---------------------------------------------------------------------------

test('markOwnContext: marks only the message line, not a channel heading or gap marker', () => {
  const items = [
    { id: '1', text: '## #general (id:c1)\n[00:00] Nick (id:a): hi' },
    { id: '2', text: '--- 5 min passed ---\n[00:05] Nick (id:a): again' },
  ];
  const marked = markOwnContext(items, new Set(['1']), labels);
  assert.equal(marked[0].text, '## #general (id:c1)\n[own] [00:00] Nick (id:a): hi');
  assert.equal(marked[1].text, '--- 5 min passed ---\n[ctx] [00:05] Nick (id:a): again');
});

test('markOwnContext: missing labels leaves every item untouched, nothing skipped', () => {
  const items = [{ id: '1', text: 'line one' }, { id: '2', text: 'line two' }];
  const marked = markOwnContext(items, new Set(['1']), {});
  assert.deepEqual(marked, items);
});

// ---------------------------------------------------------------------------
// buildChannelRequest
// ---------------------------------------------------------------------------

function baseConfig(overrides = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    memory: {
      fieldChars: 400,
      maxInterests: 12,
      maxDetails: 15,
      interestTopicChars: 40,
      interestNoteChars: 120,
      maxNewEpisodes: 3,
      clampTolerance: 1.25,
    },
    ...overrides,
  };
}

test('buildChannelRequest: fills {{fieldChars}} and the <channel>/<messages> blocks', () => {
  const messages = [msg(1, 1000, { authorId: 'a', authorName: 'Alice', channelId: 'general', channelName: 'general' })];
  const { messages: llmMessages } = buildChannelRequest({
    prompts: { channel: 'CHANNEL fields={{fieldChars}}', labels },
    config: baseConfig(),
    calibrator: createCalibrator(),
    channel: { id: 'general', name: 'general', category: 'Chat', topic: 'general chatter' },
    messages,
    isMain: true,
  });
  assert.equal(llmMessages[0].content, 'CHANNEL fields=400');
  const user = llmMessages[1].content;
  assert.match(user, /<channel>\ngeneral \(id:general\), category: Chat, topic: general chatter, main: true\n<\/channel>/);
  assert.match(user, /<messages>[\s\S]*<\/messages>/);
});

test('buildChannelRequest: a missing memory.fieldChars falls back to config.json\'s 1000', () => {
  const { messages: llmMessages } = buildChannelRequest({
    prompts: { channel: 'CHANNEL fields={{fieldChars}}', labels },
    config: baseConfig({ memory: {} }),
    calibrator: createCalibrator(),
    channel: { id: 'general', name: 'general', category: null, topic: null },
    messages: [msg(1, 1000)],
    isMain: false,
  });
  assert.equal(llmMessages[0].content, 'CHANNEL fields=1000');
});

test('clampServerResult: missing memory.fieldChars and lore.textChars fall back to config.json\'s 1000 and 600', () => {
  const config = { memory: { clampTolerance: 1 } };
  const clamped = clampServerResult({ patterns: 'p'.repeat(2500), lore: [{ title: 'T', keys: ['k1'], text: 'l'.repeat(700) }] }, config);
  assert.equal(clamped.patterns.length, 2000, 'guild fields get twice fieldChars');
  assert.equal(clamped.lore[0].text.length, 600);
});

test('buildChannelRequest: missing labels fail loudly, like the stream analyzer, never a request without them', () => {
  assert.throws(
    () =>
      buildChannelRequest({
        prompts: { channel: 'CHANNEL' },
        config: baseConfig(),
        calibrator: createCalibrator(),
        channel: { id: 'general', name: 'general', category: null, topic: null },
        messages: [msg(1, 1000)],
        isMain: false,
      }),
    /labels/,
  );
});

test('createWarmup: a person or server request without labels fails loudly, nothing sent', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])]));
  const hot = fakeHot({ prompts: { labels: undefined } });
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{}]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await assert.rejects(warmup.runPerson('g1', 'a'), /labels/);
  await assert.rejects(warmup.runServer('g1'), /labels/);
  assert.equal(llm.calls.length, 0);
});

test('buildChannelRequest: fitting drops the OLDEST messages only', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    msg(i, i * 60_000, { authorId: 'a', authorName: 'Alice', channelId: 'general', channelName: 'general', content: `content number ${i} padded out` }),
  );
  const config = baseConfig({ llm: { maxRequestTokens: 220, safetyMargin: 1 } });
  const { messages, stats } = buildChannelRequest({
    prompts: { channel: 'CHANNEL', labels },
    config,
    calibrator: createCalibrator(),
    channel: { id: 'general', name: 'general', category: null, topic: null },
    messages: many,
    isMain: false,
  });
  assert.ok(stats.dropped > 0);
  const user = messages[1].content;
  assert.ok(!user.includes('content number 0 '));
  assert.ok(user.includes(`content number ${many.length - 1} `));
});

// ---------------------------------------------------------------------------
// clampProfileResult / clampChannelResult
// ---------------------------------------------------------------------------

test('clampProfileResult: null on garbage input', () => {
  assert.equal(clampProfileResult(null, baseConfig()), null);
  assert.equal(clampProfileResult([1, 2], baseConfig()), null);
});

test('clampProfileResult: resolves a stale "Name (id:x)" form to the member\'s current name', () => {
  const bigId = '111111111111111111'; // toTokens' ID_MARKER_RE requires a 17-20 digit id
  const nameOf = (id) => (id === bigId ? 'Alice' : null);
  const result = clampProfileResult({ character: `often teases OldNick (id:${bigId}) about it` }, baseConfig(), nameOf);
  assert.equal(result.character, `often teases Alice (id:${bigId}) about it`);
});

test('clampProfileResult: dedupes interests/details case-insensitively, keeping the max "times"', () => {
  const result = clampProfileResult(
    {
      interests: [
        { topic: 'Anime', note: '', times: 1 },
        { topic: 'anime', note: 'watches subs', times: 2 },
      ],
      details: [
        { text: 'plays guitar', times: 1 },
        { text: 'Plays Guitar', times: 3 },
      ],
    },
    baseConfig(),
  );
  assert.equal(result.interests.length, 1);
  assert.equal(result.interests[0].topic, 'Anime');
  assert.equal(result.interests[0].note, 'watches subs');
  assert.equal(result.interests[0].times, 2);
  assert.equal(result.details.length, 1);
  assert.equal(result.details[0].times, 3);
});

test('clampProfileResult: episodes capped at memory.maxNewEpisodes; an alias is left for the store to clamp', () => {
  const episodes = Array.from({ length: 5 }, (_, i) => ({ date: '2026-01-01', what: `event ${i}`, weight: 3 }));
  const result = clampProfileResult({ episodes, aliases: ['x'.repeat(60), 42, ''] }, baseConfig());
  assert.equal(result.episodes.length, 3);
  assert.deepEqual(result.aliases, ['x'.repeat(60)]);
});

test('createWarmup: an alias, an episode weight and a lore title are clamped where they are stored', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([
    { character: 'c', style: 's', aliases: ['Αλέξανδρος '.repeat(6)], episodes: [{ date: '2026-01-01', what: 'won a game', weight: 9 }] },
    { patterns: 'p', lore: [{ title: 'Τίτλος '.repeat(20), keys: ['k1'], text: 'x' }] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal((await warmup.runPerson('g1', 'a')).ok, true);
  assert.equal((await warmup.runServer('g1')).ok, true);

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.aliases.length, 1);
  assert.ok(profile.aliases[0].name.length <= 40);
  assert.equal(profile.episodes[0].weight, 5);
  assert.ok(store.getLore('g1')[0].title.length <= 80);
});

test('clampChannelResult: clamps purpose/topics/tone, null on garbage', () => {
  assert.equal(clampChannelResult('nope', baseConfig()), null);
  const result = clampChannelResult({ purpose: 'p'.repeat(1000), topics: 'chat', tone: 'casual' }, baseConfig());
  assert.ok(result.purpose.length <= 500); // 400 * clampTolerance 1.25
  assert.equal(result.topics, 'chat');
  assert.equal(result.tone, 'casual');
});

// ---------------------------------------------------------------------------
// clampServerResult
// ---------------------------------------------------------------------------

test('clampServerResult: empty fields on garbage input, never throws', () => {
  const result = clampServerResult('nope', baseConfig());
  assert.deepEqual(result, { patterns: '', starters: '', injokes: [], lore: [] });
});

test('clampServerResult: clamps patterns/starters/injokes and validates lore entries', () => {
  const result = clampServerResult(
    {
      patterns: 'people banter a lot',
      starters: 'someone posts a link',
      injokes: ['the eternal bug', 42, ''],
      lore: [{ title: 'The Great Outage', keys: ['outage', 'the incident'], text: 'server went down for a day' }, { title: '' }, 'nope'],
    },
    baseConfig(),
  );
  assert.equal(result.patterns, 'people banter a lot');
  assert.equal(result.starters, 'someone posts a link');
  assert.deepEqual(result.injokes, ['the eternal bug']);
  assert.equal(result.lore.length, 1);
  assert.equal(result.lore[0].title, 'The Great Outage');
  assert.deepEqual(result.lore[0].keys, ['outage', 'the incident']);
});

// ---------------------------------------------------------------------------
// takeFittingPrefix
// ---------------------------------------------------------------------------

test('takeFittingPrefix: greedily fills the prefix under budget, leaves the rest', () => {
  const items = [1, 2, 3, 4, 5];
  const { taken, rest } = takeFittingPrefix(items, 6, (n) => n);
  assert.deepEqual(taken, [1, 2, 3]); // 1+2+3=6 <= 6, +4 would overflow
  assert.deepEqual(rest, [4, 5]);
});

test('takeFittingPrefix: always takes at least one item, even an oversized one', () => {
  const items = [10, 1, 1];
  const { taken, rest } = takeFittingPrefix(items, 1, (n) => n);
  assert.deepEqual(taken, [10]);
  assert.deepEqual(rest, [1, 1]);
});

test('takeFittingPrefix: empty input yields empty output', () => {
  assert.deepEqual(takeFittingPrefix([], 10, () => 1), { taken: [], rest: [] });
});

// ---------------------------------------------------------------------------
// buildPersonWriteIterations
// ---------------------------------------------------------------------------

test('buildPersonWriteIterations: character/style/aliases/episodes land only on the first iteration', () => {
  const answer = { character: 'friendly', style: 'short', interests: [], details: [], episodes: [{ date: '2026-01-01', what: 'x', weight: 3 }], aliases: ['Al'] };
  const iterations = buildPersonWriteIterations(answer);
  assert.equal(iterations.length, 1);
  assert.equal(iterations[0].character, 'friendly');
  assert.equal(iterations[0].style, 'short');
  assert.deepEqual(iterations[0].aliases, { add: ['Al'] });
  assert.deepEqual(iterations[0].episodes, answer.episodes);
});

test('buildPersonWriteIterations: an interest/detail with times: N appears in exactly the first N iterations', () => {
  const answer = {
    interests: [{ topic: 'anime', note: '', times: 3 }, { topic: 'chess', note: '', times: 1 }],
    details: [{ text: 'plays guitar', times: 2 }],
  };
  const iterations = buildPersonWriteIterations(answer);
  assert.equal(iterations.length, 3);
  assert.deepEqual(iterations[0].interests.add.map((i) => i.topic), ['anime', 'chess']);
  assert.deepEqual(iterations[1].interests.add.map((i) => i.topic), ['anime']);
  assert.deepEqual(iterations[2].interests.add.map((i) => i.topic), ['anime']);
  // The ops-object shape (`{ add }`), the only one applyMemoryUpdate / store.applyProfileOps accept.
  assert.deepEqual(iterations[0].details, { add: ['plays guitar'] });
  assert.deepEqual(iterations[1].details, { add: ['plays guitar'] });
  assert.equal(iterations[2].details, undefined);
});

test('buildPersonWriteIterations: an empty answer yields no iterations', () => {
  assert.deepEqual(buildPersonWriteIterations({ character: '', style: '', interests: [], details: [], episodes: [], aliases: [] }), []);
});

// ---------------------------------------------------------------------------
// Factory: createWarmup against a fake discord.js guild + fake LLM client
// ---------------------------------------------------------------------------

function fakeChannel(id, historyAsc, { name = id, category = null, topic = null, deny = false } = {}) {
  for (const m of historyAsc) m.channelId = id;
  const desc = [...historyAsc].reverse();
  return {
    id,
    name,
    parent: category ? { name: category } : null,
    topic,
    guild: null,
    isTextBased: () => true,
    isThread: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetchCalls: 0,
      fetch(opts = {}) {
        this.fetchCalls += 1;
        const limit = opts.limit ?? 50;
        let pool = desc;
        if (opts.before) {
          const beforeNum = BigInt(opts.before);
          pool = pool.filter((m) => BigInt(m.id) < beforeNum);
        }
        return Promise.resolve(new Map(pool.slice(0, limit).map((m) => [m.id, m])));
      },
    },
    _deny: deny,
  };
}

function fakeGuild(id, channels) {
  const guild = { id, channels: { cache: new Map(channels.map((c) => [c.id, c])) }, members: { me: { displayName: 'Bot' } } };
  for (const c of channels) c.guild = guild;
  return guild;
}

function fakeClient(guild) {
  return { user: { id: 'selfUser' }, guilds: { cache: new Map([[guild.id, guild]]) } };
}

/** A raw discord.js-shaped message for fakeChannel's history array. */
function rawMessage(ts, { authorId = 'a', bot = false, content = 'hi', replyToId = null } = {}) {
  return {
    id: String(ts),
    author: { id: authorId, bot, globalName: authorId, username: authorId },
    member: { displayName: authorId },
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyToId ? { messageId: replyToId } : null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
  };
}

function fakeHot(overrides = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', channels: { allow: [], deny: [] } },
      context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
      llm: { model: 'talk/model', maxRequestTokens: 50000, safetyMargin: 0.9 },
      memory: {
        model: null,
        mainChannelIds: [],
        fieldChars: 400,
        maxInterests: 12,
        maxDetails: 15,
        maxEpisodes: 20,
        maxInjokes: 15,
        interestTopicChars: 40,
        interestNoteChars: 120,
        maxNewEpisodes: 3,
        clampTolerance: 1.25,
        confirmGapHours: 12,
        portraitRefreshHours: 24,
        portraitRefreshPerDay: 20,
      },
      lore: { maxEntries: 500, textChars: 400 },
      media: {},
      warmup: {
        enabled: true,
        lookbackDays: 60,
        minMessages: 2,
        maxPeople: 40,
        messagesPerPerson: 10,
        contextBefore: 1,
        maxChannelShare: 1,

        messagesPerChannel: 50,
        serverSampleMessages: 50,
        fetchLimitPerChannel: 1000,
        maxRequestTokens: 50000,
        maxOutputTokens: 6000,
        maxTokens: 6_000_000,
        rateLimitWaitMinutes: 10,
        rateLimitMaxWaits: 36,
        refreshMessages: 20,
      },
      ...overrides.config,
    },
    prompts: {
      profile: 'SYSTEM {{name}}',
      channel: 'CHANNEL {{fieldChars}}',
      server: 'SERVER {{fieldChars}}',
      'character-card': 'CARD {{name}}',
      labels,
      ...overrides.prompts,
    },
  };
}

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-warmup-store-'));
}

/** A fake sleep that resolves immediately but records every requested duration. */
function fakeSleep() {
  const calls = [];
  const sleep = (ms) => {
    calls.push(ms);
    return Promise.resolve();
  };
  sleep.calls = calls;
  return sleep;
}

function fakeLlm(script) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      calls.push({ messages, opts });
      return script(calls.length - 1, messages, opts);
    },
  };
}

test('createWarmup: peopleReport respects bot.channels.deny and reports totals', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'b' })]);
  const denied = fakeChannel('c2', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1, denied]);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { bot: { timezone: 'UTC', channels: { allow: [], deny: ['c2'] } } } });
  hot.config.warmup.minMessages = 2;
  const warmup = createWarmup({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const report = await warmup.peopleReport('g1');
  assert.equal(report.ok, true);
  assert.equal(report.totals.channelsRead, 1); // c2 denied, never fetched
  assert.equal(report.totals.messagesRead, 3);
  assert.deepEqual(report.people.map((p) => p.id), ['a']); // b has only 1 message, below minMessages
  assert.equal(report.totals.belowThreshold, 1);
});

test('createWarmup: fetched windows are cached for 15 minutes per guild', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  let nowMs = 1_000_000;
  const warmup = createWarmup({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });

  await warmup.peopleReport('g1');
  await warmup.peopleReport('g1');
  assert.equal(c1.messages.fetchCalls, 1, 'second call within the cache window must not refetch');

  nowMs += 16 * 60_000;
  await warmup.peopleReport('g1');
  assert.equal(c1.messages.fetchCalls, 2, 'a call after the cache expired must refetch');
});

test('createWarmup: peopleReport never writes anything under a real data/ directory', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-warmup-data-'));
  fs.writeFileSync(path.join(dataDir, 'marker.json'), '{}');
  const before = fs.readdirSync(dataDir).sort();

  try {
    const history = Array.from({ length: 3 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a' }));
    const c1 = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [c1]);
    const client = fakeClient(guild);
    const hot = fakeHot();
    hot.config.warmup.minMessages = 1;
    const warmup = createWarmup({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

    await warmup.peopleReport('g1');
    await warmup.peopleReport('g1');

    assert.deepEqual(fs.readdirSync(dataDir).sort(), before);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Factory write path: run() / runXxx() / refreshPortrait() against a real
// (temp-dir) store.
// ---------------------------------------------------------------------------

/** Polls `predicate` on the microtask queue (no real timer) until it is true, or throws after
 * `tries` empty polls -- used only to observe a fake async dependency (fetch, `llm.complete`) has
 * actually been reached mid-flight, without hardcoding how many awaits its callers take to get
 * there. */
async function waitFor(predicate, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('waitFor: condition not met in time');
}

/** A fake `llm.complete` whose promise never settles on its own -- it only rejects once
 * `opts.signal` (the AbortController `callWithRails` now attaches to every call) actually fires,
 * exactly as a real cancelled `fetch` would. Simulates the model call a `/nep warmup stop` catches
 * mid-flight. */
function abortAwareLlm() {
  const calls = [];
  return {
    calls,
    complete: (messages, opts) => {
      calls.push({ messages, opts });
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  };
}

function scriptedLlm(results) {
  const calls = [];
  return {
    calls,
    complete: async (messages, opts) => {
      const i = calls.length;
      calls.push({ messages, opts });
      const entry = results[Math.min(i, results.length - 1)];
      const payload = typeof entry === 'function' ? entry(i, messages, opts) : entry;
      if (payload instanceof Error) throw payload;
      return { text: JSON.stringify(payload), usage: { prompt_tokens: 100, completion_tokens: 20 }, estimated: 120, finishReason: 'stop' };
    },
  };
}

test('createWarmup: run() processes channels, then people, then the server, writing through the store', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [
    rawMessage(1000, { authorId: 'a', content: 'hi one' }),
    rawMessage(2000, { authorId: 'a', content: 'hi two' }),
    rawMessage(3000, { authorId: 'a', content: 'hi three' }),
  ];
  const c1 = fakeChannel('c1', history, { name: 'general', category: 'Chat', topic: 'chit-chat' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([
    { purpose: 'general chatter', topics: 'everything', tone: 'casual' }, // channel c1
    { character: 'friendly and curious', style: 'short messages', interests: [{ topic: 'anime', note: 'watches subs', times: 2 }], details: [], episodes: [], aliases: [] }, // person a
    { patterns: 'lots of banter', starters: 'someone posts a link', injokes: ['the eternal bug'], lore: [{ title: 'The Outage', keys: ['outage'], text: 'the server went down once' }] }, // server
  ]);

  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const result = await warmup.run('g1');

  assert.equal(result.ok, true);
  assert.equal(llm.calls.length, 3);

  const channel = store.getChannel('g1', 'c1');
  assert.equal(channel.purpose, 'general chatter');

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'friendly and curious');
  assert.equal(profile.messageCount, 3);
  assert.equal(profile.interests.length, 1);
  assert.equal(profile.interests[0].weight, 2); // times: 2 -> weight 2, via two sightings

  const guildMemory = store.getGuild('g1');
  assert.equal(guildMemory.patterns, 'lots of banter');
  assert.deepEqual(guildMemory.injokes, ['the eternal bug']);
  assert.equal(store.getLore('g1').length, 1);

  const bs = store.state.data.warmup;
  assert.deepEqual(bs.done.channels, ['c1']);
  assert.deepEqual(bs.done.people, ['a']);
  assert.equal(bs.done.server, true);
  assert.ok(bs.startedAt);
  assert.ok(bs.finishedAt);
  assert.equal(bs.aborted, null);
});

test('createWarmup: run() is idempotent once finished -- a second call makes no further requests', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p', topics: 't', tone: 'x' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  const callsAfterFirst = llm.calls.length;

  const failingLlm = { complete: async () => { throw new Error('must not be called again'); } };
  const warmup2 = createWarmup({ hot, store, client, llm: failingLlm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const second = await warmup2.run('g1');

  assert.equal(second.ok, true);
  assert.equal(llm.calls.length, callsAfterFirst); // unchanged -- the second run made no new model calls
});

test('createWarmup: run() resumes after a stop, never reprocessing a done item', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history1 = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const history2 = [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })];
  const c1 = fakeChannel('c1', history1);
  const c2 = fakeChannel('c2', history2);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.maxTokens = 1; // stop immediately, before the very first request

  const llm1 = scriptedLlm([{ purpose: 'p' }]);
  const warmup1 = createWarmup({ hot, store, client, llm: llm1, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const first = await warmup1.run('g1');
  assert.equal(first.ok, false);
  assert.equal(llm1.calls.length, 0);
  assert.equal(store.state.data.warmup.aborted, 'budget');
  assert.deepEqual(store.state.data.warmup.done.channels, []);

  hot.config.warmup.maxTokens = 6_000_000; // lift the rail, resume
  const llm2 = scriptedLlm([
    { purpose: 'p1' },
    { purpose: 'p2' },
    { character: 'ca', style: 'sa', interests: [], details: [], episodes: [], aliases: [] },
    { character: 'cb', style: 'sb', interests: [], details: [], episodes: [], aliases: [] },
    { patterns: '', starters: '', injokes: [], lore: [] },
  ]);
  const warmup2 = createWarmup({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const second = await warmup2.run('g1');

  assert.equal(second.ok, true);
  assert.deepEqual(store.state.data.warmup.done.channels.sort(), ['c1', 'c2']);
  assert.deepEqual(store.state.data.warmup.done.people.sort(), ['a', 'b']);
  assert.equal(store.state.data.warmup.aborted, null);
});

test('createWarmup: run() refuses while another run is already in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });
  const llm = { complete: async () => { await gate; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const firstRun = warmup.run('g1');
  assert.equal(warmup.isWarmingUp(), true);
  const secondRun = await warmup.run('g1');
  assert.equal(secondRun.ok, false);
  assert.match(secondRun.message, /already in flight/);

  resolveFirst();
  await firstRun;
  assert.equal(warmup.isWarmingUp(), false);
});

test('createWarmup: run() pauses after the request in flight, resumable', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([
    (i) => {
      store.state.data.paused = true; // simulate /nep pause landing while call #1 was in flight
      return { purpose: 'p1' };
    },
    { purpose: 'p2' }, // must never be reached
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(store.state.data.warmup.done.channels, ['c1']);
});

// ---------------------------------------------------------------------------
// /nep warmup stop -- stopRequested, honoured at the same checkpoints as
// store.state.data.paused, cleared at the start of every run().
// ---------------------------------------------------------------------------

test('createWarmup: stop() ends the run after the request in flight, activity stopped, progress kept, nothing marked aborted', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([
    () => {
      const result = warmup.stop(); // simulate /nep warmup stop landing while call #1 was in flight
      assert.equal(result.ok, true);
      return { purpose: 'p1' };
    },
    { purpose: 'p2' }, // must never be reached
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(result.message, 'stopped');
  assert.equal(llm.calls.length, 1); // c2 never reached
  assert.deepEqual(store.state.data.warmup.done.channels, ['c1']); // progress kept
  assert.equal(store.state.data.warmup.aborted, null); // nothing marks it aborted

  const status = warmup.status('g1');
  assert.equal(status.activity.phase, 'stopped');
  assert.equal(status.stopRequested, true);
});

test('createWarmup: stop() before any run is in flight is a no-op', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const warmup = createWarmup({ hot, store, client, llm: { complete: async () => { throw new Error('must not be called'); } }, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = warmup.stop();
  assert.equal(result.ok, false);
  assert.equal(warmup.status('g1').stopRequested, false);
});

test('createWarmup: run() clears stopRequested at the start of the next run', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;

  let sawStopRequestedDuringSecondRun = null;
  const llm = scriptedLlm([
    () => { warmup.stop(); return { purpose: 'p1' }; }, // channel call: request a stop mid-run
    () => {
      sawStopRequestedDuringSecondRun = warmup.status('g1').stopRequested;
      return { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] };
    },
    { patterns: '', starters: '', injokes: [], lore: [] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const first = await warmup.run('g1');
  assert.equal(first.message, 'stopped');
  assert.equal(warmup.status('g1').stopRequested, true);

  const second = await warmup.run('g1');
  assert.equal(sawStopRequestedDuringSecondRun, false); // cleared before the person request that follows
  assert.equal(second.ok, true);
  assert.equal(warmup.status('g1').stopRequested, false);
});

// ---------------------------------------------------------------------------
// /nep warmup stop cancels the model call ACTUALLY in flight (an
// AbortController threaded through llm.complete's `signal`), not just the
// loop after it finishes -- see src/memory/warmup.js#callWithRails/`stop`.
// ---------------------------------------------------------------------------

test('createWarmup: stop() aborts the model call in flight during a bulk users run; nothing written for that target, resumable', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;

  const llm = abortAwareLlm();
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = await warmup.runUsers('g1');
  assert.equal(started.ok, true);
  assert.equal(started.count, 1);
  assert.equal(llm.calls.length, 1, 'the person request must already be in flight');
  assert.equal(llm.calls[0].opts.signal.aborted, false);

  const stopResult = warmup.stop();
  assert.equal(stopResult.ok, true);
  assert.equal(llm.calls[0].opts.signal.aborted, true, '/nep warmup stop must cancel the in-flight call');

  await warmup.waitIdle();

  assert.equal(llm.calls.length, 1, 'no retry after a deliberate abort');
  assert.deepEqual(store.state.data.warmup.done.people, []); // not marked done
  assert.equal(store.getUser('g1', 'a'), null); // nothing partial written
  assert.equal(store.state.data.warmup.aborted, null); // a deliberate stop, never a failure

  const status = warmup.status('g1');
  assert.equal(status.running, false);
  assert.equal(status.activity.phase, 'stopped');

  // Later: a fresh warmup users run resumes and actually profiles the member.
  const llm2 = scriptedLlm([{ character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup2 = createWarmup({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const resumed = await warmup2.runUsers('g1');
  assert.equal(resumed.ok, true);
  await warmup2.waitIdle();
  assert.deepEqual(store.state.data.warmup.done.people, ['a']);
});

test('createWarmup: stop() aborts the model call in flight during a synchronous warmup users one-off (a single member)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = abortAwareLlm();
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const runPromise = warmup.runPerson('g1', 'a');
  // Let the synchronous one-off actually reach its (hanging) model call before stopping it.
  await waitFor(() => llm.calls.length === 1);

  const stopResult = warmup.stop();
  assert.equal(stopResult.ok, true);
  assert.equal(llm.calls[0].opts.signal.aborted, true);

  const result = await runPromise;
  assert.equal(result.ok, false);
  assert.equal(result.message, 'stopped');
  assert.equal(store.getUser('g1', 'a'), null);
  assert.deepEqual(store.state.data.warmup.done.people, []);
});

test('createWarmup: run() waits out a sustained rate limit then aborts (resumable)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.rateLimitMaxWaits = 2;

  const rateLimitError = new Error('rate limited');
  rateLimitError.statusCode = 429;
  const llm = { complete: async () => { throw rateLimitError; } };
  const sleep = fakeSleep();
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000, sleep });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(sleep.calls.length, 2); // 2 allowed waits, then a 3rd attempt that also fails -> abort without a 3rd wait
  assert.equal(store.state.data.warmup.aborted, 'rate-limit');
});

test('createWarmup: run() aborts after three consecutive other failures (resumable)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const c3 = fakeChannel('c3', [rawMessage(1000, { authorId: 'c' }), rawMessage(2000, { authorId: 'c' })]);
  const guild = fakeGuild('g1', [c1, c2, c3]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let calls = 0;
  const llm = { complete: async () => { calls += 1; throw new Error(`boom ${calls}`); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  assert.equal(store.state.data.warmup.aborted, 'failures');
  assert.deepEqual(store.state.data.warmup.done.channels, []); // nothing ever succeeded
});

test('createWarmup: run() reports a missing prompts.profile instead of throwing', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { profile: undefined } });
  const llm = scriptedLlm([{ purpose: 'p' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.match(result.message, /profile\.md/);
});

test('createWarmup: run() reports a missing prompts.server instead of throwing', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { server: undefined } });
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.match(result.message, /server\.md/);
});

test('createWarmup: a person whose sample does not fit one request is chunked, each later chunk carrying a <draft>, the LAST answer wins', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = Array.from({ length: 12 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `padded message content number ${i} with extra words to make it long` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  hot.config.warmup.messagesPerPerson = 12;
  hot.config.warmup.contextBefore = 0;
  hot.config.warmup.maxRequestTokens = 90;
  hot.config.llm.safetyMargin = 1;

  const llm = scriptedLlm([
    (i) => ({ character: `chunk-${i}`, style: 's', interests: [], details: [], episodes: [], aliases: [] }),
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'a');
  assert.equal(outcome.ok, true);
  assert.ok(llm.calls.length > 1, 'expected the sample to be split into more than one request');

  const firstUser = llm.calls[0].messages[1].content;
  assert.ok(!firstUser.includes('<draft>'));
  const secondUser = llm.calls[1].messages[1].content;
  assert.ok(secondUser.includes('<draft>'));
  assert.ok(secondUser.includes('chunk-0'));

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, `chunk-${llm.calls.length - 1}`); // the LAST answer wins
});

test('createWarmup: a bad-json person answer is retried once with half the sample, then skipped', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = Array.from({ length: 4 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `m${i}` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;

  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: 'not json at all', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'a');
  assert.equal(outcome.ok, false);
  assert.equal(calls, 2); // one attempt, one retry with half the sample
  const store2 = store; // the person is marked done (skipped), not retried forever
  assert.deepEqual(store2.state.data.warmup.done.people, ['a']);
});

test('createWarmup: every failed target carries a reason; only a final skip is marked done', async () => {
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const setup = (llm, tweak = () => {}) => {
    const store = createStore({ dataDir: tmpDataDir() });
    const hot = fakeHot();
    hot.config.warmup.minMessages = 1;
    tweak(hot);
    const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history.map((m) => ({ ...m })))]));
    return { store, warmup: createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 }) };
  };
  const garbage = { complete: async () => ({ text: 'not json', usage: {}, estimated: 0, finishReason: 'stop' }) };
  const failing = { complete: async () => { throw new Error('provider down'); } };
  const tinyCap = (hot) => {
    hot.config.warmup.maxRequestTokens = 3;
    hot.config.llm.safetyMargin = 1;
  };

  let run = setup(garbage);
  assert.equal((await run.warmup.runChannel('g1', 'c1')).message, 'bad-json');
  assert.deepEqual(run.store.state.data.warmup.done.channels, [], 'retried next run');
  assert.equal((await run.warmup.runServer('g1')).message, 'bad-json');
  assert.equal(run.store.state.data.warmup.done.server, false, 'retried next run');
  const unparsable = await run.warmup.runPerson('g1', 'a');
  assert.equal(unparsable.message, 'unparsable');
  assert.equal(unparsable.outcome.skipped, true);
  assert.deepEqual(run.store.state.data.warmup.done.people, ['a'], 'a final skip: marked done');

  run = setup(failing);
  assert.equal((await run.warmup.runPerson('g1', 'a')).message, 'llm-error');
  assert.deepEqual(run.store.state.data.warmup.done.people, [], 'retried next run');

  run = setup(garbage, tinyCap);
  assert.equal((await run.warmup.runChannel('g1', 'c1')).message, 'over-cap');
  const overCap = await run.warmup.runPerson('g1', 'a');
  assert.equal(overCap.message, 'over-cap');
  assert.equal(overCap.outcome.skipped, undefined, 'not a final skip: a larger cap fixes it');
  assert.deepEqual(run.store.state.data.warmup?.done?.people ?? [], []);
});

// ---------------------------------------------------------------------------
// /nep warmup users user:<member> / channels channel:<channel> / server
// (runPerson/runChannel/runServer's richer outcome) and /nep warmup
// users/channels with no member/channel (runUsers/runChannels, the
// background bulk redo sharing `running` with run()).
// ---------------------------------------------------------------------------

test('createWarmup: runPerson reports "no messages in the window" when the member never wrote at all', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'other' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'ghost');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.message, 'no messages in the window');
});

test('createWarmup: runPerson returns sample size, tokens used and the written answer on success', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a', content: 'hi one' }), rawMessage(2000, { authorId: 'a', content: 'hi two' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'friendly', style: 'short', interests: [{ topic: 'anime', note: '', times: 1 }], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'a');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.outcome.member.id, 'a');
  assert.equal(outcome.outcome.sample.ownCount, 2);
  assert.ok(outcome.outcome.tokensUsed > 0);
  assert.equal(outcome.outcome.chunks, 1);
  assert.equal(outcome.outcome.answer.character, 'friendly');
  assert.equal(outcome.outcome.answer.interests.length, 1);
});

test('createWarmup: runPerson stores the answer\'s details, each at the weight of its "times"', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a', content: 'hi one' }), rawMessage(2000, { authorId: 'a', content: 'hi two' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([
    { character: 'friendly', style: 'short', interests: [], details: [{ text: 'plays guitar', times: 2 }, { text: 'owns a cat', times: 1 }], episodes: [], aliases: [] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'a');
  assert.equal(outcome.ok, true);

  const details = store.getUser('g1', 'a').details;
  assert.deepEqual(
    details.map(({ text, weight }) => ({ text, weight })),
    [
      { text: 'plays guitar', weight: 2 },
      { text: 'owns a cat', weight: 1 },
    ],
  );
});

test('createWarmup: runPerson appends prompts.rules after the card in the <character> block', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a', content: 'hi one' }), rawMessage(2000, { authorId: 'a', content: 'hi two' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { rules: 'Never repeat yourself.' } });
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'friendly', style: 'short', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.runPerson('g1', 'a');

  const user = llm.calls[0].messages[1].content;
  assert.match(user, /<character>\nCARD Nept\n\nNever repeat yourself\.\n<\/character>/);
});

test('createWarmup: runPerson renders the card alone when prompts.rules is absent', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a', content: 'hi one' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot(); // no prompts.rules configured
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'friendly', style: 'short', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.runPerson('g1', 'a');

  const user = llm.calls[0].messages[1].content;
  assert.match(user, /<character>\nCARD Nept\n<\/character>/);
});

test('createWarmup: runChannel returns the channel and the written note on success', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })], { name: 'general', category: 'Chat', topic: 'chit-chat' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'general chatter', topics: 'everything', tone: 'casual' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.outcome.channel, { id: 'c1', name: 'general' });
  assert.equal(outcome.outcome.result.purpose, 'general chatter');
  assert.equal(outcome.outcome.facts.messageCount, 1);
  assert.deepEqual(outcome.outcome.facts.topWriters, [{ id: 'a', count: 1 }]);
});

test('createWarmup: processChannel fills the channel\'s counters and top writers from the messages it actually had', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [
    rawMessage(1000, { authorId: 'a' }),
    rawMessage(2000, { authorId: 'a' }),
    rawMessage(3000, { authorId: 'b' }),
    rawMessage(4000, { authorId: 'a' }),
    rawMessage(5000, { authorId: 'bot1', bot: true }),
  ];
  const c1 = fakeChannel('c1', history, { name: 'general', category: 'Chat', topic: 'chit-chat' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'general chatter', topics: 'everything', tone: 'casual' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);

  const channel = store.getChannel('g1', 'c1');
  assert.equal(channel.messageCount, 5); // the channel's own traffic counts a bot's message too
  assert.equal(channel.firstMessageAt, 1000);
  assert.equal(channel.lastMessageAt, 5000);
  assert.deepEqual(channel.days, { [new Date(1000).toISOString().slice(0, 10)]: 5 });
  assert.deepEqual(channel.topWriters, [{ id: 'a', count: 3 }, { id: 'b', count: 1 }]); // the bot never counts as a writer
});

test('createWarmup: processChannel redone (runChannel again) SETS the counters, never adding to a previous run', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const c1 = fakeChannel('c1', history, { name: 'general' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm1 = scriptedLlm([{ purpose: 'p1' }]);
  const warmup1 = createWarmup({ hot, store, client, llm: llm1, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  await warmup1.runChannel('g1', 'c1');
  assert.equal(store.getChannel('g1', 'c1').messageCount, 2);

  const llm2 = scriptedLlm([{ purpose: 'p2' }]);
  const warmup2 = createWarmup({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  await warmup2.runChannel('g1', 'c1');
  assert.equal(store.getChannel('g1', 'c1').messageCount, 2); // SET, not added -- a redo must not double the count
});

test('createWarmup: processChannel sets zeros and empty lists for a channel with no messages at all', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [], { name: 'empty-room' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: '', topics: '', tone: '' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);

  const channel = store.getChannel('g1', 'c1');
  assert.equal(channel.messageCount, 0);
  assert.equal(channel.firstMessageAt, null);
  assert.equal(channel.lastMessageAt, null);
  assert.deepEqual(channel.days, {});
  assert.deepEqual(channel.topWriters, []);
});

test('createWarmup: runServer returns counts of what was written on success', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([
    { patterns: 'lots of banter', starters: 'someone posts a link', injokes: ['the eternal bug'], lore: [{ title: 'The Outage', keys: ['outage'], text: 'the server went down once' }] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runServer('g1');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.outcome.counts.injokes, 1);
  assert.equal(outcome.outcome.counts.lore, 1);
  assert.ok(outcome.outcome.counts.patternsChars > 0);
  assert.ok(outcome.outcome.counts.startersChars > 0);
});

test('createWarmup: a server answer that omits a field leaves the stored value as it was', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.updateGuild('g1', { patterns: 'old patterns', starters: 'old starters', injokes: ['old joke'] });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ starters: 'new starters', patterns: '', lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runServer('g1');
  assert.equal(outcome.ok, true);

  const stored = store.getGuild('g1');
  assert.equal(stored.patterns, 'old patterns', 'an empty patterns never blanks the stored one');
  assert.equal(stored.starters, 'new starters');
  assert.deepEqual(stored.injokes, ['old joke'], 'a missing injokes list never empties the stored one');
});

test('createWarmup: a channel answer that omits a field leaves the stored value as it was', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.updateChannel('g1', 'c1', { purpose: 'old purpose', topics: 'old topics', tone: 'old tone' });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })], { name: 'general' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'new purpose', tone: '' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);

  const stored = store.getChannel('g1', 'c1');
  assert.equal(stored.purpose, 'new purpose');
  assert.equal(stored.topics, 'old topics', 'a missing field never blanks the stored one');
  assert.equal(stored.tone, 'old tone', 'an empty field never blanks the stored one');
});

test('createWarmup: an unparsable channel, person or server answer is logged by its error name, never quoting it', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = { complete: async () => ({ text: '{"purpose": she quit her job}', usage: {}, estimated: 0, finishReason: 'stop' }) };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const { logs } = await withCapturedLogs(async () => {
    await warmup.runChannel('g1', 'c1');
    await warmup.runPerson('g1', 'a');
    await warmup.runServer('g1');
  });

  const parseWarnings = logs.filter((entry) => /could not be parsed|still bad/.test(entry.msg));
  assert.ok(parseWarnings.length >= 3);
  for (const entry of parseWarnings) assert.equal(entry.detail, 'SyntaxError', entry.msg);
  assert.ok(!JSON.stringify(logs).includes('she quit'), 'the answer text never reaches a log line');
});

test('createWarmup: runServer appends prompts.rules after the card in the <character> block', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { rules: 'Stay in character.' } });
  const llm = scriptedLlm([{ patterns: 'p', starters: 's', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.runServer('g1');

  const user = llm.calls[0].messages[1].content;
  assert.match(user, /<character>\nCARD Nept\n\nStay in character\.\n<\/character>/);
});

test('createWarmup: a redo (runPerson called again) SETS messageCount/firstSeen/lastSeen from the window instead of adding', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [
    rawMessage(1000, { authorId: 'a', content: 'hi one' }),
    rawMessage(2000, { authorId: 'a', content: 'hi two' }),
    rawMessage(3000, { authorId: 'a', content: 'hi three' }),
  ];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'friendly', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.runPerson('g1', 'a');
  const first = store.getUser('g1', 'a');
  assert.equal(first.messageCount, 3);

  await warmup.runPerson('g1', 'a');
  const second = store.getUser('g1', 'a');
  assert.equal(second.messageCount, 3); // SET, not added -- a redo must not double the count
  assert.equal(second.firstSeen, first.firstSeen);
  assert.equal(second.lastSeen, first.lastSeen);
});

test('createWarmup: runUsers starts a background redo of every qualifying member, resolving once the count is known', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [
    rawMessage(1000, { authorId: 'a' }),
    rawMessage(2000, { authorId: 'a' }),
    rawMessage(3000, { authorId: 'b' }),
    rawMessage(4000, { authorId: 'b' }),
  ];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = await warmup.runUsers('g1');
  assert.equal(started.ok, true);
  assert.equal(started.count, 2);
  assert.equal(warmup.isWarmingUp(), true); // shares `running` with run()

  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(store.state.data.warmup.done.people.sort(), ['a', 'b']);
});

test('createWarmup: runUsers redoes an already-done member, overwriting its previous answer', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm1 = scriptedLlm([{ character: 'first', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup1 = createWarmup({ hot, store, client, llm: llm1, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup1.runPerson('g1', 'a');
  assert.deepEqual(store.state.data.warmup.done.people, ['a']);

  const llm2 = scriptedLlm([{ character: 'second', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup2 = createWarmup({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = await warmup2.runUsers('g1');
  assert.equal(started.ok, true);
  assert.equal(started.count, 1); // "a" is redone even though already marked done
  while (warmup2.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'second');
});

test('createWarmup: runUsers is refused while a run/one-off target is already in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });
  const llm = { complete: async () => { await gate; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const firstRun = warmup.run('g1');
  assert.equal(warmup.isWarmingUp(), true);
  const usersResult = await warmup.runUsers('g1');
  assert.equal(usersResult.ok, false);
  assert.match(usersResult.message, /already in flight/);

  resolveFirst();
  await firstRun;
});

test('createWarmup: runUsers claims the run before its history fetch -- a redo started meanwhile is refused', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const client = fakeClient(fakeGuild('g1', [c1]));
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  const llm = scriptedLlm([{ character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const first = warmup.runUsers('g1');
  assert.equal(warmup.isWarmingUp(), true, 'the persona is muted from the start, the history fetch included');
  const second = await warmup.runChannels('g1');
  assert.equal(second.ok, false);
  assert.match(second.message, /already in flight/);

  assert.equal((await first).count, 1);
  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.equal(c1.messages.fetchCalls, 1, 'one history fetch, not two');
  assert.equal(llm.calls.length, 1, 'one redo loop, not two');
});

test('createWarmup: runUsers with nothing to redo, or a failed history fetch, releases the run at once', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  hot.config.warmup.minMessages = 100;
  const quiet = createWarmup({
    hot,
    store,
    client: fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])])),
    llm: scriptedLlm([{}]),
    calibrator: createCalibrator(),
    getSelfName: () => 'Nept',
    now: () => 10_000_000,
  });
  assert.deepEqual(await quiet.runUsers('g1'), { ok: true, count: 0 });
  assert.equal(quiet.isWarmingUp(), false);
  await quiet.waitIdle(); // resolves: nothing left in flight

  const broken = fakeChannel('c1', []);
  broken.isTextBased = () => {
    throw new Error('channel cache unavailable');
  };
  const failing = createWarmup({ hot, store, client: fakeClient(fakeGuild('g1', [broken])), llm: scriptedLlm([{}]), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  await assert.rejects(failing.runChannels('g1'), /channel cache unavailable/);
  assert.equal(failing.isWarmingUp(), false);
  await failing.waitIdle();
});

test('createWarmup: runChannels starts a background redo of every readable channel', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })], { name: 'general' });
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' })], { name: 'random' });
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = await warmup.runChannels('g1');
  assert.equal(started.ok, true);
  assert.equal(started.count, 2);

  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(store.state.data.warmup.done.channels.sort(), ['c1', 'c2']);
});

test('createWarmup: resumeIfNeeded starts a run automatically when no profile exists at all', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = warmup.resumeIfNeeded('g1');
  assert.equal(started, true);
  // resumeIfNeeded fires the run without awaiting it -- wait for it to actually finish.
  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.ok(store.state.data.warmup.finishedAt);
});

test('createWarmup: resumeIfNeeded does nothing once a profile already exists and no run is unfinished', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal(warmup.resumeIfNeeded('g1'), false);
});

test('createWarmup: resumeIfNeeded respects warmup.enabled: false', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { warmup: { ...fakeHot().config.warmup, enabled: false } } });
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal(warmup.resumeIfNeeded('g1'), false);
});

test('createWarmup: reset() clears progress only, refused while running', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  assert.ok(store.state.data.warmup.finishedAt);

  const result = warmup.reset();
  assert.equal(result.ok, true);
  assert.equal(store.state.data.warmup, undefined);
  // The already-written profile/channel/guild data is untouched.
  assert.ok(store.getUser('g1', 'a'));
});

test('createWarmup: status() reports phase, progress and the next target', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.maxTokens = 1; // stop immediately, before the first request
  const llm = scriptedLlm([{}]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  const s = warmup.status('g1');
  assert.match(s.phase, /aborted/);
  assert.equal(s.channelsEligible, 2);
  assert.equal(s.doneChannels, 0);
  assert.match(s.nextTarget, /channel:/);
});

// ---------------------------------------------------------------------------
// status().activity -- in-memory run phase, never persisted
// ---------------------------------------------------------------------------

test('activity: idle by default, before any run', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const warmup = createWarmup({ hot, store, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.deepEqual(warmup.status('g1').activity, { phase: 'idle', detail: null, lastActivityAt: null });
});

test('activity: reports the fetching phase with channel counts, mid-fetch', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let warmup;
  let seenDuringFirst;
  let seenDuringSecond;
  const wrap = (channel, onFetch) => {
    const original = channel.messages.fetch.bind(channel.messages);
    channel.messages.fetch = async (opts) => {
      onFetch();
      return original(opts);
    };
  };
  wrap(c1, () => { if (!seenDuringFirst) seenDuringFirst = warmup.status('g1').activity; });
  wrap(c2, () => { if (!seenDuringSecond) seenDuringSecond = warmup.status('g1').activity; });

  warmup = createWarmup({ hot, store, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  await warmup.peopleReport('g1');

  assert.equal(seenDuringFirst.phase, 'fetching');
  assert.equal(seenDuringFirst.detail.channelsFetched, 0, 'no channel finished yet at the very first fetch call');
  assert.equal(seenDuringFirst.detail.channelsTotal, 2);
  assert.ok(Number.isFinite(seenDuringFirst.lastActivityAt));

  assert.equal(seenDuringSecond.detail.channelsFetched, 1, 'the first channel is done by the time the second is fetched');
});

test('activity: reports the channel phase with its position among the run\'s eligible channels', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })], { name: 'general' });
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })], { name: 'random' });
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 100; // nobody qualifies as a person -- channels then straight to the server

  let warmup;
  const seen = [];
  const results = [{ purpose: 'p1' }, { purpose: 'p2' }, { patterns: '', starters: '', injokes: [], lore: [] }];
  let i = 0;
  const llm = {
    complete: async () => {
      seen.push(warmup.status('g1').activity);
      const payload = results[Math.min(i, results.length - 1)];
      i += 1;
      return { text: JSON.stringify(payload), usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, finishReason: 'stop' };
    },
  };
  warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, true);
  assert.equal(seen.length, 3);

  assert.equal(seen[0].phase, 'channel');
  assert.equal(seen[0].detail.id, 'c1');
  assert.equal(seen[0].detail.name, 'general');
  assert.equal(seen[0].detail.index, 1);
  assert.equal(seen[0].detail.total, 2);

  assert.equal(seen[1].detail.id, 'c2');
  assert.equal(seen[1].detail.index, 2);
  assert.equal(seen[1].detail.total, 2);

  assert.equal(seen[2].phase, 'server');
  assert.equal(seen[2].detail, null);
});

test('activity: reports the person phase with its position and a chunk count while a sample is chunked', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = Array.from({ length: 12 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `padded message content number ${i} with extra words to make it long` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 1;
  hot.config.warmup.messagesPerPerson = 12;
  hot.config.warmup.contextBefore = 0;
  hot.config.warmup.maxRequestTokens = 90;
  hot.config.llm.safetyMargin = 1;

  let warmup;
  const seen = [];
  let i = 0;
  const llm = {
    complete: async () => {
      seen.push(warmup.status('g1').activity);
      const payload = { character: `chunk-${i}`, style: 's', interests: [], details: [], episodes: [], aliases: [] };
      i += 1;
      return { text: JSON.stringify(payload), usage: { prompt_tokens: 10, completion_tokens: 5 }, estimated: 15, finishReason: 'stop' };
    },
  };
  warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runPerson('g1', 'a');
  assert.equal(outcome.ok, true);
  assert.ok(seen.length > 1, 'expected the sample to be split into more than one chunk');

  assert.equal(seen[0].phase, 'person');
  assert.equal(seen[0].detail.id, 'a');
  assert.equal(seen[0].detail.chunk.k, 1);
  assert.ok(seen[0].detail.chunk.n >= 2);

  assert.equal(seen[1].detail.chunk.k, 2);
});

test('activity: waiting-rate-limit phase carries "until" and the wait count', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.rateLimitMaxWaits = 2;

  const rateLimitError = new Error('rate limited');
  rateLimitError.statusCode = 429;
  const llm = { complete: async () => { throw rateLimitError; } };

  let warmup;
  let seenDuringWait;
  const nowMs = 10_000_000;
  const sleep = async () => {
    if (!seenDuringWait) seenDuringWait = warmup.status('g1').activity;
  };
  warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs, sleep });

  await warmup.run('g1');

  assert.ok(seenDuringWait);
  assert.equal(seenDuringWait.phase, 'waiting-rate-limit');
  assert.equal(seenDuringWait.detail.waits, 1);
  assert.equal(seenDuringWait.detail.until, nowMs + (hot.config.warmup.rateLimitWaitMinutes ?? 10) * 60_000);
});

test('activity: paused phase after a pause is noticed mid-run', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([
    () => {
      store.state.data.paused = true; // simulate /nep pause landing while call #1 was in flight
      return { purpose: 'p1' };
    },
    { purpose: 'p2' }, // must never be reached
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  assert.equal(warmup.status('g1').activity.phase, 'paused');
});

test('activity: aborted phase carries the reason', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.maxTokens = 1; // stop immediately, before the first request

  const warmup = createWarmup({ hot, store, client, llm: scriptedLlm([{}]), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  const activity = warmup.status('g1').activity;
  assert.equal(activity.phase, 'aborted');
  assert.equal(activity.detail.reason, 'budget');
});

test('activity: reports the finished phase once the whole run completes', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, true);
  assert.equal(warmup.status('g1').activity.phase, 'finished');
});

test('activity: lastActivityAt strictly advances as a run moves from fetching to later phases', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.minMessages = 100; // nobody qualifies -- keep the script to channel + server
  let t = 1000;
  const stepNow = () => { t += 1; return t; };
  const llm = scriptedLlm([{ purpose: 'p' }, { patterns: '', starters: '', injokes: [], lore: [] }]);

  let warmup;
  let seenDuringFetch;
  const originalFetch = c1.messages.fetch.bind(c1.messages);
  c1.messages.fetch = async (opts) => {
    if (!seenDuringFetch) seenDuringFetch = warmup.status('g1').activity.lastActivityAt;
    return originalFetch(opts);
  };

  warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: stepNow });
  const result = await warmup.run('g1');
  assert.equal(result.ok, true);

  assert.ok(Number.isFinite(seenDuringFetch));
  const finalActivity = warmup.status('g1').activity;
  assert.ok(finalActivity.lastActivityAt > seenDuringFetch, 'lastActivityAt must move forward as the run progresses');
});

test('activity: never written to state.json (in-memory only)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  store.flush();

  const raw = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  assert.ok(!raw.includes('"activity"'), 'the run activity must never be persisted');
  assert.ok(!raw.includes('lastActivityAt'), 'the run activity must never be persisted');
});

test('activity: status() stays cheap and side-effect free (repeated calls never change progress)', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const warmup = createWarmup({ hot, store, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const first = warmup.status('g1');
  const second = warmup.status('g1');
  assert.deepEqual(first, second);
});

test('activity: reset() also clears the in-memory activity back to idle', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  assert.equal(warmup.status('g1').activity.phase, 'finished');

  warmup.reset();
  assert.deepEqual(warmup.status('g1').activity, { phase: 'idle', detail: null, lastActivityAt: null });
});

// ---------------------------------------------------------------------------
// Factory write path: refreshPortrait()
// ---------------------------------------------------------------------------

test('refreshPortrait: samples the member and replaces only character/style, with <draft> and <hint> blocks', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  store.applyProfileOps('g1', 'a', { character: 'old character', style: 'old style', interests: { add: [{ topic: 'chess', note: '' }] } }, { fieldChars: 400, seenAt: 1000 });

  const history = Array.from({ length: 5 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `m${i}` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  const llm = scriptedLlm([{ character: 'new character', style: 'new style', interests: [{ topic: 'poker', note: '', times: 5 }], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 20_000_000 });

  const result = await warmup.refreshPortrait('g1', 'a', 'writes shorter than usual now');
  assert.equal(result.ok, true);

  const user = llm.calls[0].messages[1].content;
  assert.ok(user.includes('<draft>'));
  assert.ok(user.includes('old character'));
  assert.ok(user.includes('<hint>'));
  assert.ok(user.includes('writes shorter than usual now'));

  const profile = store.getUser('g1', 'a');
  assert.equal(profile.character, 'new character');
  assert.equal(profile.style, 'new style');
  assert.equal(profile.interests.length, 1);
  assert.equal(profile.interests[0].topic, 'chess'); // interests from the refresh answer are IGNORED
  assert.ok(profile.portraitRefreshedAt);
});

test('refreshPortrait: the "portrait refreshed" log says whether a hint was given, never its text', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const history = Array.from({ length: 3 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `m${i}` }));
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  const llm = scriptedLlm([{ character: 'new character', style: 'new style', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 20_000_000 });

  const { result, logs } = await withCapturedLogs(() => warmup.refreshPortrait('g1', 'a', 'γράφει πιο σύντομα τώρα'));
  assert.equal(result.ok, true);

  const refreshed = logs.find((entry) => entry.msg === 'warmup: portrait refreshed');
  assert.ok(refreshed);
  assert.equal(refreshed.hinted, true);
  assert.ok(!JSON.stringify(logs).includes('σύντομα'), 'the hint text never reaches a log line');
});

test('refreshPortrait: appends prompts.rules after the card in the <character> block', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const history = Array.from({ length: 3 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `m${i}` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { rules: 'No spoilers.' } });

  const llm = scriptedLlm([{ character: 'new character', style: 'new style', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 20_000_000 });

  await warmup.refreshPortrait('g1', 'a', 'reason');

  const user = llm.calls[0].messages[1].content;
  assert.match(user, /<character>\nCARD Nept\n\nNo spoilers\.\n<\/character>/);
});

test('refreshPortrait: skips a member refreshed less than memory.portraitRefreshHours ago, unless forced', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  store.updateUser('g1', 'a', { portraitRefreshedAt: new Date(10_000_000).toISOString() });

  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 + 3600_000 }); // 1h later, rail is 24h

  const skipped = await warmup.refreshPortrait('g1', 'a', 'reason');
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'too-soon');
  assert.equal(calls, 0);

  const forced = await warmup.refreshPortrait('g1', 'a', 'reason', { force: true });
  assert.equal(forced.ok, true);
  assert.equal(calls, 1);
});

test('refreshPortrait: skips once the daily refresh cap is reached', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.memory.portraitRefreshPerDay = 1;
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const first = await warmup.refreshPortrait('g1', 'a', 'r1', { force: true });
  assert.equal(first.ok, true);
  const second = await warmup.refreshPortrait('g1', 'a', 'r2', { force: true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'daily-cap');
  assert.equal(calls, 1);
});

test('refreshPortrait: concurrent cues never overshoot the daily cap -- the slot is taken before the history fetch', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  store.touchUser('g1', 'b', 'Bob', 1000);
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'b' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.memory.portraitRefreshPerDay = 1;
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: '{"character":"c","style":"s"}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const [first, second] = await Promise.all([warmup.refreshPortrait('g1', 'a', 'r1'), warmup.refreshPortrait('g1', 'b', 'r2')]);

  assert.deepEqual([first.ok, second.ok], [true, false]);
  assert.equal(second.reason, 'daily-cap');
  assert.equal(calls, 1);
});

test('refreshPortrait: the daily count lives outside the warmup progress, so /nep warmup reset never zeroes it', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])]));
  const hot = fakeHot();
  hot.config.memory.portraitRefreshPerDay = 1;
  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: '{"character":"c","style":"s"}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal((await warmup.refreshPortrait('g1', 'a', 'r1', { force: true })).ok, true);
  assert.equal(store.state.data.portraitDay, new Date(10_000_000).toISOString().slice(0, 10));
  assert.equal(store.state.data.portraitCount, 1);

  assert.equal(warmup.reset().ok, true);
  const again = await warmup.refreshPortrait('g1', 'a', 'r2', { force: true });
  assert.equal(again.reason, 'daily-cap');
  assert.equal(calls, 1);
});

test('refreshPortrait: a missing prompts.profile is reason "no-prompt", no slot taken, no request', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })])]));
  const hot = fakeHot({ prompts: { profile: undefined } });
  const llm = scriptedLlm([{}]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.refreshPortrait('g1', 'a', 'r1', { force: true });
  assert.equal(outcome.reason, 'no-prompt');
  assert.equal(llm.calls.length, 0);
  assert.equal(store.state.data.portraitCount, undefined);
});

test('refreshPortrait: a refresh with nothing to sample gives its daily slot back', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', [rawMessage(1000, { authorId: 'other' })])]));
  const hot = fakeHot();
  const warmup = createWarmup({ hot, store, client, llm: scriptedLlm([{}]), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.refreshPortrait('g1', 'a', 'r1', { force: true });
  assert.equal(outcome.reason, 'nothing-to-sample');
  assert.equal(store.state.data.portraitCount, 0);
});

test('refreshPortrait: concurrent cues share one history fetch', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  store.touchUser('g1', 'b', 'Bob', 1000);
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'b' })]);
  const client = fakeClient(fakeGuild('g1', [c1]));
  const hot = fakeHot();
  const llm = scriptedLlm([{ character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const results = await Promise.all([warmup.refreshPortrait('g1', 'a', 'r1'), warmup.refreshPortrait('g1', 'b', 'r2')]);

  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.equal(c1.messages.fetchCalls, 1, 'the second cue waits for the fetch already in flight');
});

test('refreshPortrait: queues nothing and just logs while a warmup run is in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let resolveGate;
  const gate = new Promise((resolve) => { resolveGate = resolve; });
  const llm = { complete: async () => { await gate; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const runPromise = warmup.run('g1');
  const refreshResult = await warmup.refreshPortrait('g1', 'a', 'reason');
  assert.equal(refreshResult.ok, false);
  assert.equal(refreshResult.reason, 'warming-up');

  resolveGate();
  await runPromise;
});

test('createWarmup: resumeIfNeeded resumes a run that has progress but no start stamp, even when profiles exist', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  store.touchUser('g1', 'a', 'alpha');
  store.state.data.warmup = { version: 3, startedAt: null, finishedAt: null, done: { channels: [], people: ['someone'], server: false } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  warmup.resumeIfNeeded('g1');
  await new Promise((r) => setTimeout(r, 20));
  while (warmup.isWarmingUp()) await new Promise((r) => setTimeout(r, 5));
  assert.ok(store.state.data.warmup.finishedAt, 'the run should have resumed and finished');
});

test('warmupState: a stored state.warmup from an older version is discarded wholesale by a write, never healed field by field', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.maxTokens = 0; // the run stops on its very first request: only the reset is observed
  const stored = {
    version: 2,
    done: false,
    aborted: false,
    startedAt: '2026-01-01T00:00:00.000Z',
    tokensUsed: 5000,
    requests: 7,
    channels: {},
  };
  store.state.data.warmup = structuredClone(stored);
  const warmup = createWarmup({ hot, store, client, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const summary = warmup.summary(); // a read: reports the fresh view, writes nothing
  assert.equal(summary.tokensUsed, 0);
  assert.equal(summary.startedAt, null);
  assert.deepEqual(store.state.data.warmup, stored);

  await warmup.run('g1');

  const progress = store.state.data.warmup;
  assert.equal(progress.version, 3);
  assert.equal(progress.tokensUsed, 0);
  assert.equal(progress.requests, 0);
  assert.equal(progress.startedAt, new Date(10_000_000).toISOString(), 'the old start stamp is gone, the run stamped its own');
  assert.equal('channels' in progress, false);
  assert.deepEqual(progress.done, { channels: [], people: [], server: false });
});

test('warmupState: a stored state.warmup already at the current version is healed field by field, not replaced', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.warmup.maxTokens = 0;
  store.state.data.warmup = { version: 3, tokensUsed: 42, done: { channels: ['c1'], people: [], server: false } };
  const warmup = createWarmup({ hot, store, client, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept' });

  assert.equal(warmup.summary().tokensUsed, 42);
  assert.equal(warmup.summary().doneChannels, 1);

  await warmup.run('g1');

  const progress = store.state.data.warmup;
  assert.equal(progress.version, 3);
  assert.equal(progress.tokensUsed, 42, 'a version-3 object keeps its own field values');
  assert.deepEqual(progress.done.channels, ['c1']);
  assert.equal(progress.requests, 0, 'a missing field is filled in');
});

test('warmupState: status() and summary() are read-only -- they never write or dirty state.json', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const client = fakeClient(fakeGuild('g1', []));
  const hot = fakeHot();
  const stored = { version: 1, done: 'garbage' };
  store.state.data.warmup = structuredClone(stored);
  let dirtied = 0;
  store.state.markDirty = () => {
    dirtied += 1;
  };
  const warmup = createWarmup({ hot, store, client, llm: {}, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const status = warmup.status('g1');
  const summary = warmup.summary();
  assert.equal(status.phase, 'not started');
  assert.equal(summary.doneChannels, 0);
  assert.deepEqual(store.state.data.warmup, stored, 'the stored object is left exactly as it was');
  assert.equal(dirtied, 0);
});

test('status: next target skips the target currently in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  let release;
  const gate = new Promise((r) => { release = r; });
  const llm = { complete: async () => { await gate; return { content: JSON.stringify({ purpose: 'p', topics: 't', tone: 'n' }), usage: { prompt_tokens: 1, completion_tokens: 1 } }; } };
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const running = warmup.run('g1');
  while (warmup.status('g1').activity.phase !== 'channel') await new Promise((r) => setTimeout(r, 5));
  const s = warmup.status('g1');
  assert.equal(s.activity.detail.id, 'c1');
  assert.match(s.nextTarget, /c2/);
  release();
  await running;
});

test('createWarmup: every warmup and portrait request runs at the analyzer temperature with memory.timeoutMs', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.memory.timeoutMs = 900_000;
  hot.config.llm.timeoutMs = 300_000;
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's' }, { patterns: 'x' }, { character: 'c2', style: 's2' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  await warmup.refreshPortrait('g1', 'a', '');

  assert.equal(llm.calls.length, 4);
  for (const call of llm.calls) {
    assert.equal(call.opts.temperature, 0.3, 'memory.temperature missing -> 0.3');
    assert.equal(call.opts.timeoutMs, 900_000);
  }
});

test('createWarmup: memory.temperature is read at each call, for the warmup and the portrait refresh alike', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  hot.config.memory.temperature = 0.55;
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's' }, { patterns: 'x' }, { character: 'c2', style: 's2' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  hot.config.memory.temperature = 0.1; // a live edit reaches the next request
  await warmup.refreshPortrait('g1', 'a', '');

  assert.deepEqual(llm.calls.map((call) => call.opts.temperature), [0.55, 0.55, 0.55, 0.1]);
});

test('createWarmup: a missing warmup.maxRequestTokens is 120000 for fitting and for the request cap alike', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = Array.from({ length: 6 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `line number ${i} with a few words` }));
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  delete hot.config.warmup.maxRequestTokens;
  hot.config.llm.maxRequestTokens = 40; // the chat cap: far too small for this channel
  hot.config.llm.safetyMargin = 1;
  const llm = scriptedLlm([{ purpose: 'p' }]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await warmup.runChannel('g1', 'c1');
  assert.equal(outcome.ok, true);
  assert.equal(llm.calls[0].opts.maxRequestTokens, 120000);
  assert.ok(llm.calls[0].messages[1].content.includes('line number 0 '), 'fitted to the warmup cap, nothing dropped');
});

test('createWarmup: warmup rails are read at the call -- a lowered warmup.maxTokens stops a run already in flight', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(2000, { authorId: 'b' })]);
  const client = fakeClient(fakeGuild('g1', [c1, c2]));
  const hot = fakeHot();
  const llm = scriptedLlm([
    () => {
      // A hot reload replaces the config objects, as src/hot.js does.
      hot.config = { ...hot.config, warmup: { ...hot.config.warmup, maxTokens: 1, maxOutputTokens: 1234 } };
      return { purpose: 'p1' };
    },
    { purpose: 'p2' },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await warmup.run('g1');
  assert.equal(result.ok, false);
  assert.equal(result.message, 'budget');
  assert.equal(llm.calls.length, 1);
  assert.equal(store.state.data.warmup.aborted, 'budget');
});

// Provider routing: every warmup request is routed as the analyzer role.

test('createWarmup: run() and refreshPortrait() route every request as the analyzer role', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'a' })];
  const client = fakeClient(fakeGuild('g1', [fakeChannel('c1', history)]));
  const hot = fakeHot();
  const llm = scriptedLlm([
    { purpose: 'p', topics: 't', tone: 'x' },
    { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] },
    { patterns: '', starters: '', injokes: [], lore: [] },
    { character: 'c2', style: 's2', interests: [], details: [], episodes: [], aliases: [] },
  ]);
  const warmup = createWarmup({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await warmup.run('g1');
  const refreshed = await warmup.refreshPortrait('g1', 'a', '');

  assert.equal(refreshed.ok, true);
  assert.equal(llm.calls.length, 4);
  assert.deepEqual(llm.calls.map((call) => call.opts.role), ['analyzer', 'analyzer', 'analyzer', 'analyzer']);
});
