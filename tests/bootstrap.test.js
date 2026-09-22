// Tests for src/memory/bootstrap.js: THE way memory starts. Pure helpers
// (pickPeople, memberStats, splitNewestOlder, sampleMember,
// selectChannelMessages, markOwnContext, buildProfileRequest,
// buildChannelRequest, clampProfileResult, clampChannelResult,
// clampServerResult, takeFittingPrefix, buildPersonWriteIterations) are
// tested directly; the factory is tested against a fake discord.js
// guild/channel, a fake LLM client and a real (temp-dir) store. No network,
// no real prompts/ or data/.
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
  buildProfileRequest,
  buildChannelRequest,
  clampProfileResult,
  clampChannelResult,
  clampServerResult,
  takeFittingPrefix,
  buildPersonWriteIterations,
  createBootstrap,
} from '../src/memory/bootstrap.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { labels } from './fixtures/labels.js';

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
// buildProfileRequest
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

function profilePrompts(overrides = {}) {
  return {
    profile: 'SYSTEM name={{name}} chars={{fieldChars}} maxI={{maxInterests}} maxD={{maxDetails}} topicChars={{interestTopicChars}} noteChars={{interestNoteChars}} maxEp={{maxNewEpisodes}}',
    'character-card': 'CARD for {{name}}',
    labels,
    ...overrides,
  };
}

test('buildProfileRequest: fills every profile.md placeholder from live config', () => {
  const sample = { messages: [msg(1, 1000, { authorId: 'a', authorName: 'Alice' })], ownIds: new Set(['1']) };
  const member = { id: 'a', name: 'Alice', messages: 1, firstTs: 1000, lastTs: 1000 };
  const { messages } = buildProfileRequest({
    prompts: profilePrompts(),
    config: baseConfig(),
    calibrator: createCalibrator(),
    member,
    sample,
    selfName: 'Nept',
  });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'SYSTEM name=Nept chars=400 maxI=12 maxD=15 topicChars=40 noteChars=120 maxEp=3');
});

test('buildProfileRequest: <character> and <member> blocks, marked <snippets>', () => {
  const sample = { messages: [msg(1, 1000, { authorId: 'a', authorName: 'Alice' })], ownIds: new Set(['1']) };
  const member = { id: 'a', name: 'Alice', messages: 1, firstTs: 1000, lastTs: 1000 };
  const { messages } = buildProfileRequest({
    prompts: profilePrompts(),
    config: baseConfig(),
    calibrator: createCalibrator(),
    member,
    sample,
    selfName: 'Nept',
  });
  const user = messages[1].content;
  assert.match(user, /<character>\nCARD for Nept\n<\/character>/);
  assert.match(user, /<member>\nAlice \(id:a\), 1 messages in the window, first .*, last .*\n<\/member>/);
  assert.match(user, /<snippets>[\s\S]*<\/snippets>/);
  assert.ok(user.includes('[own] '));
});

test('buildProfileRequest: fitting drops the OLDEST snippets only, never the fixed blocks', () => {
  const many = Array.from({ length: 40 }, (_, i) => msg(i, i * 60_000, { authorId: 'a', authorName: 'Alice', content: `content number ${i} with some padding text` }));
  const sample = { messages: many, ownIds: new Set(many.map((m) => m.id)) };
  const member = { id: 'a', name: 'Alice', messages: many.length, firstTs: many[0].ts, lastTs: many.at(-1).ts };
  const config = baseConfig({ llm: { maxRequestTokens: 260, safetyMargin: 1 } });
  const { messages, stats } = buildProfileRequest({
    prompts: profilePrompts(),
    config,
    calibrator: createCalibrator(),
    member,
    sample,
    selfName: 'Nept',
  });
  assert.ok(stats.snippetsDropped > 0, 'expected some snippets to be dropped under a tiny token cap');
  const user = messages[1].content;
  assert.ok(!user.includes('content number 0 '), 'the oldest snippet must be dropped first');
  assert.ok(user.includes(`content number ${many.length - 1} `), 'the newest snippet must survive');
  // The system message (never trimmed) still carries every placeholder value.
  assert.ok(messages[0].content.startsWith('SYSTEM name=Nept'));
});

// ---------------------------------------------------------------------------
// buildChannelRequest
// ---------------------------------------------------------------------------

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

test('clampProfileResult: episodes capped at memory.maxNewEpisodes, aliases hard-clamped to 40 chars', () => {
  const episodes = Array.from({ length: 5 }, (_, i) => ({ date: '2026-01-01', what: `event ${i}`, weight: 3 }));
  const result = clampProfileResult({ episodes, aliases: ['x'.repeat(60)] }, baseConfig());
  assert.equal(result.episodes.length, 3);
  assert.ok(result.aliases[0].length <= 40);
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
  assert.deepEqual(iterations[0].details, ['plays guitar']);
  assert.deepEqual(iterations[1].details, ['plays guitar']);
  assert.equal(iterations[2].details, undefined);
});

test('buildPersonWriteIterations: an empty answer yields no iterations', () => {
  assert.deepEqual(buildPersonWriteIterations({ character: '', style: '', interests: [], details: [], episodes: [], aliases: [] }), []);
});

// ---------------------------------------------------------------------------
// Factory: createBootstrap against a fake discord.js guild + fake LLM client
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
      bootstrap: {
        enabled: true,
        lookbackDays: 60,
        minMessages: 2,
        maxPeople: 40,
        messagesPerPerson: 10,
        contextBefore: 1,
        maxChannelShare: 1,
        minChannelMessages: 2,
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-bootstrap-store-'));
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

function okResult(payload, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return () => ({ text: JSON.stringify(payload), usage, estimated: 120, finishReason: 'stop' });
}

test('createBootstrap: peopleReport respects bot.channels.deny and reports totals', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' }), rawMessage(3000, { authorId: 'b' })]);
  const denied = fakeChannel('c2', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1, denied]);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { bot: { timezone: 'UTC', channels: { allow: [], deny: ['c2'] } } } });
  hot.config.bootstrap.minMessages = 2;
  const bootstrap = createBootstrap({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const report = await bootstrap.peopleReport('g1');
  assert.equal(report.ok, true);
  assert.equal(report.totals.channelsRead, 1); // c2 denied, never fetched
  assert.equal(report.totals.messagesRead, 3);
  assert.deepEqual(report.people.map((p) => p.id), ['a']); // b has only 1 message, below minMessages
  assert.equal(report.totals.belowThreshold, 1);
});

test('createBootstrap: fetched windows are cached for 15 minutes per guild', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  let nowMs = 1_000_000;
  const bootstrap = createBootstrap({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => nowMs });

  await bootstrap.peopleReport('g1');
  await bootstrap.peopleReport('g1');
  assert.equal(c1.messages.fetchCalls, 1, 'second call within the cache window must not refetch');

  nowMs += 16 * 60_000;
  await bootstrap.peopleReport('g1');
  assert.equal(c1.messages.fetchCalls, 2, 'a call after the cache expired must refetch');
});

test('createBootstrap: previewUser reports a missing profile.md instead of calling the model', async () => {
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { profile: undefined } });
  const llm = fakeLlm(() => ({ text: '{}', usage: null, estimated: 0 }));
  const bootstrap = createBootstrap({ hot, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.previewUser('g1', 'a');
  assert.equal(result.ok, false);
  assert.match(result.message, /profile\.md/);
  assert.equal(llm.calls.length, 0);
});

test('createBootstrap: previewUser reports nothing to sample when the member never wrote in the window', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'other' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const bootstrap = createBootstrap({ hot, client, llm: fakeLlm(() => ({})), calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.previewUser('g1', 'ghost');
  assert.equal(result.ok, false);
});

test('createBootstrap: previewUser calls the analyzer role, never the daily cap, and returns a clamped result', async () => {
  const history = Array.from({ length: 5 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `own message ${i}` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { memory: { model: 'analyzer/model', mainChannelIds: [] } } });
  hot.config.memory = { ...fakeHot().config.memory, model: 'analyzer/model' };
  hot.config.bootstrap.minMessages = 1;

  const llm = fakeLlm(okResult({ character: 'friendly', style: 'short messages', interests: [], details: [], episodes: [], aliases: [] }));
  const bootstrap = createBootstrap({ hot, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.previewUser('g1', 'a');
  assert.equal(result.ok, true);
  assert.equal(result.result.character, 'friendly');
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].opts.model, 'analyzer/model');
  assert.equal(llm.calls[0].opts.countAgainstDailyCap, false);
  assert.equal(llm.calls[0].opts.maxOutputTokens, hot.config.bootstrap.maxOutputTokens);
});

test('createBootstrap: previewUser falls back to llm.model when memory.model is unset', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.bootstrap.minMessages = 1;
  const llm = fakeLlm(okResult({}));
  const bootstrap = createBootstrap({ hot, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await bootstrap.previewUser('g1', 'a');
  assert.equal(llm.calls[0].opts.model, hot.config.llm.model);
});

test('createBootstrap: previewUser surfaces a model-call failure without throwing', async () => {
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.bootstrap.minMessages = 1;
  const llm = { complete: async () => { throw new Error('provider down'); } };
  const bootstrap = createBootstrap({ hot, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.previewUser('g1', 'a');
  assert.equal(result.ok, false);
  assert.match(result.message, /provider down/);
});

test('createBootstrap: previewChannel reports a missing channel.md instead of calling the model', async () => {
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { channel: undefined } });
  const llm = fakeLlm(() => ({}));
  const bootstrap = createBootstrap({ hot, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.previewChannel('g1', 'c1');
  assert.equal(result.ok, false);
  assert.match(result.message, /channel\.md/);
  assert.equal(llm.calls.length, 0);
});

test('createBootstrap: previewChannel reports an empty channel without calling the model', async () => {
  const c1 = fakeChannel('c1', []);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = fakeLlm(() => ({}));
  const bootstrap = createBootstrap({ hot, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.previewChannel('g1', 'c1');
  assert.equal(result.ok, false);
  assert.equal(llm.calls.length, 0);
});

test('createBootstrap: previewChannel succeeds and marks the main flag', async () => {
  const history = Array.from({ length: 3 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `msg ${i}` }));
  const c1 = fakeChannel('c1', history, { name: 'general', category: 'Chat', topic: 'chit-chat' });
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.memory.mainChannelIds = ['c1'];
  const llm = fakeLlm(okResult({ purpose: 'general chatter', topics: 'everything', tone: 'casual' }));
  const bootstrap = createBootstrap({ hot, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.previewChannel('g1', 'c1');
  assert.equal(result.ok, true);
  assert.equal(result.channel.isMain, true);
  assert.equal(result.result.purpose, 'general chatter');
});

test('createBootstrap: never writes anything under a real data/ directory', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-bootstrap-data-'));
  fs.writeFileSync(path.join(dataDir, 'marker.json'), '{}');
  const before = fs.readdirSync(dataDir).sort();

  try {
    const history = Array.from({ length: 3 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a' }));
    const c1 = fakeChannel('c1', history);
    const guild = fakeGuild('g1', [c1]);
    const client = fakeClient(guild);
    const hot = fakeHot();
    hot.config.bootstrap.minMessages = 1;
    const llm = fakeLlm(okResult({ character: 'x' }));
    const bootstrap = createBootstrap({ hot, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

    await bootstrap.peopleReport('g1');
    await bootstrap.previewUser('g1', 'a');

    assert.deepEqual(fs.readdirSync(dataDir).sort(), before);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Factory write path: run() / runXxx() / refreshPortrait() against a real
// (temp-dir) store.
// ---------------------------------------------------------------------------

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

test('createBootstrap: run() processes channels, then people, then the server, writing through the store', async () => {
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

  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const result = await bootstrap.run('g1');

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

  const bs = store.state.data.bootstrap;
  assert.deepEqual(bs.done.channels, ['c1']);
  assert.deepEqual(bs.done.people, ['a']);
  assert.equal(bs.done.server, true);
  assert.ok(bs.startedAt);
  assert.ok(bs.finishedAt);
  assert.equal(bs.aborted, null);
});

test('createBootstrap: run() is idempotent once finished -- a second call makes no further requests', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p', topics: 't', tone: 'x' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await bootstrap.run('g1');
  const callsAfterFirst = llm.calls.length;

  const failingLlm = { complete: async () => { throw new Error('must not be called again'); } };
  const bootstrap2 = createBootstrap({ hot, store, client, llm: failingLlm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const second = await bootstrap2.run('g1');

  assert.equal(second.ok, true);
  assert.equal(llm.calls.length, callsAfterFirst); // unchanged -- the second run made no new model calls
});

test('createBootstrap: run() resumes after a stop, never reprocessing a done item', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history1 = [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })];
  const history2 = [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })];
  const c1 = fakeChannel('c1', history1);
  const c2 = fakeChannel('c2', history2);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.bootstrap.maxTokens = 1; // stop immediately, before the very first request

  const llm1 = scriptedLlm([{ purpose: 'p' }]);
  const bootstrap1 = createBootstrap({ hot, store, client, llm: llm1, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const first = await bootstrap1.run('g1');
  assert.equal(first.ok, false);
  assert.equal(llm1.calls.length, 0);
  assert.equal(store.state.data.bootstrap.aborted, 'budget');
  assert.deepEqual(store.state.data.bootstrap.done.channels, []);

  hot.config.bootstrap.maxTokens = 6_000_000; // lift the rail, resume
  const llm2 = scriptedLlm([
    { purpose: 'p1' },
    { purpose: 'p2' },
    { character: 'ca', style: 'sa', interests: [], details: [], episodes: [], aliases: [] },
    { character: 'cb', style: 'sb', interests: [], details: [], episodes: [], aliases: [] },
    { patterns: '', starters: '', injokes: [], lore: [] },
  ]);
  const bootstrap2 = createBootstrap({ hot, store, client, llm: llm2, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });
  const second = await bootstrap2.run('g1');

  assert.equal(second.ok, true);
  assert.deepEqual(store.state.data.bootstrap.done.channels.sort(), ['c1', 'c2']);
  assert.deepEqual(store.state.data.bootstrap.done.people.sort(), ['a', 'b']);
  assert.equal(store.state.data.bootstrap.aborted, null);
});

test('createBootstrap: run() refuses while another run is already in flight', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();

  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });
  const llm = { complete: async () => { await gate; return { text: '{}', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const firstRun = bootstrap.run('g1');
  assert.equal(bootstrap.isBootstrapping(), true);
  const secondRun = await bootstrap.run('g1');
  assert.equal(secondRun.ok, false);
  assert.match(secondRun.message, /already in flight/);

  resolveFirst();
  await firstRun;
  assert.equal(bootstrap.isBootstrapping(), false);
});

test('createBootstrap: run() pauses after the request in flight, resumable', async () => {
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
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.run('g1');
  assert.equal(result.ok, false);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(store.state.data.bootstrap.done.channels, ['c1']);
});

test('createBootstrap: run() waits out a sustained rate limit then aborts (resumable)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.bootstrap.rateLimitMaxWaits = 2;

  const rateLimitError = new Error('rate limited');
  rateLimitError.statusCode = 429;
  const llm = { complete: async () => { throw rateLimitError; } };
  const sleep = fakeSleep();
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000, sleep });

  const result = await bootstrap.run('g1');
  assert.equal(result.ok, false);
  assert.equal(sleep.calls.length, 2); // 2 allowed waits, then a 3rd attempt that also fails -> abort without a 3rd wait
  assert.equal(store.state.data.bootstrap.aborted, 'rate-limit');
});

test('createBootstrap: run() aborts after three consecutive other failures (resumable)', async () => {
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
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.run('g1');
  assert.equal(result.ok, false);
  assert.equal(calls, 3);
  assert.equal(store.state.data.bootstrap.aborted, 'failures');
  assert.deepEqual(store.state.data.bootstrap.done.channels, []); // nothing ever succeeded
});

test('createBootstrap: run() reports a missing prompts.profile instead of throwing', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { profile: undefined } });
  const llm = scriptedLlm([{ purpose: 'p' }]);
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.run('g1');
  assert.equal(result.ok, false);
  assert.match(result.message, /profile\.md/);
});

test('createBootstrap: run() reports a missing prompts.server instead of throwing', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot({ prompts: { server: undefined } });
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }]);
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const result = await bootstrap.run('g1');
  assert.equal(result.ok, false);
  assert.match(result.message, /server\.md/);
});

test('createBootstrap: a person whose sample does not fit one request is chunked, each later chunk carrying a <draft>, the LAST answer wins', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = Array.from({ length: 12 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `padded message content number ${i} with extra words to make it long` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.bootstrap.minMessages = 1;
  hot.config.bootstrap.messagesPerPerson = 12;
  hot.config.bootstrap.contextBefore = 0;
  hot.config.bootstrap.maxRequestTokens = 90;
  hot.config.llm.safetyMargin = 1;

  const llm = scriptedLlm([
    (i) => ({ character: `chunk-${i}`, style: 's', interests: [], details: [], episodes: [], aliases: [] }),
  ]);
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await bootstrap.runPerson('g1', 'a');
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

test('createBootstrap: a bad-json person answer is retried once with half the sample, then skipped', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const history = Array.from({ length: 4 }, (_, i) => rawMessage(1000 + i * 1000, { authorId: 'a', content: `m${i}` }));
  const c1 = fakeChannel('c1', history);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.bootstrap.minMessages = 1;

  let calls = 0;
  const llm = { complete: async () => { calls += 1; return { text: 'not json at all', usage: {}, estimated: 0, finishReason: 'stop' }; } };
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const outcome = await bootstrap.runPerson('g1', 'a');
  assert.equal(outcome.ok, false);
  assert.equal(calls, 2); // one attempt, one retry with half the sample
  const store2 = store; // the person is marked done (skipped), not retried forever
  assert.deepEqual(store2.state.data.bootstrap.done.people, ['a']);
});

test('createBootstrap: resumeIfNeeded starts a run automatically when no profile exists at all', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const started = bootstrap.resumeIfNeeded('g1');
  assert.equal(started, true);
  // resumeIfNeeded fires the run without awaiting it -- wait for it to actually finish.
  while (bootstrap.isBootstrapping()) await new Promise((r) => setTimeout(r, 5));
  assert.ok(store.state.data.bootstrap.finishedAt);
});

test('createBootstrap: resumeIfNeeded does nothing once a profile already exists and no run is unfinished', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  store.touchUser('g1', 'a', 'Alice', 1000);
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal(bootstrap.resumeIfNeeded('g1'), false);
});

test('createBootstrap: resumeIfNeeded respects bootstrap.enabled: false', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const guild = fakeGuild('g1', []);
  const client = fakeClient(guild);
  const hot = fakeHot({ config: { bootstrap: { ...fakeHot().config.bootstrap, enabled: false } } });
  const llm = { complete: async () => { throw new Error('must not be called'); } };
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  assert.equal(bootstrap.resumeIfNeeded('g1'), false);
});

test('createBootstrap: reset() clears progress only, refused while running', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const guild = fakeGuild('g1', [c1]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  const llm = scriptedLlm([{ purpose: 'p' }, { character: 'c', style: 's', interests: [], details: [], episodes: [], aliases: [] }, { patterns: '', starters: '', injokes: [], lore: [] }]);
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await bootstrap.run('g1');
  assert.ok(store.state.data.bootstrap.finishedAt);

  const result = bootstrap.reset();
  assert.equal(result.ok, true);
  assert.equal(store.state.data.bootstrap, undefined);
  // The already-written profile/channel/guild data is untouched.
  assert.ok(store.getUser('g1', 'a'));
});

test('createBootstrap: status() reports phase, progress and the next target', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const c1 = fakeChannel('c1', [rawMessage(1000, { authorId: 'a' }), rawMessage(2000, { authorId: 'a' })]);
  const c2 = fakeChannel('c2', [rawMessage(1000, { authorId: 'b' }), rawMessage(2000, { authorId: 'b' })]);
  const guild = fakeGuild('g1', [c1, c2]);
  const client = fakeClient(guild);
  const hot = fakeHot();
  hot.config.bootstrap.maxTokens = 1; // stop immediately, before the first request
  const llm = scriptedLlm([{}]);
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  await bootstrap.run('g1');
  const s = await bootstrap.status('g1');
  assert.match(s.phase, /aborted/);
  assert.equal(s.channelsEligible, 2);
  assert.equal(s.doneChannels, 0);
  assert.match(s.nextTarget, /channel:/);
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
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 20_000_000 });

  const result = await bootstrap.refreshPortrait('g1', 'a', 'writes shorter than usual now');
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
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 + 3600_000 }); // 1h later, rail is 24h

  const skipped = await bootstrap.refreshPortrait('g1', 'a', 'reason');
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'too-soon');
  assert.equal(calls, 0);

  const forced = await bootstrap.refreshPortrait('g1', 'a', 'reason', { force: true });
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
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const first = await bootstrap.refreshPortrait('g1', 'a', 'r1', { force: true });
  assert.equal(first.ok, true);
  const second = await bootstrap.refreshPortrait('g1', 'a', 'r2', { force: true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'daily-cap');
  assert.equal(calls, 1);
});

test('refreshPortrait: queues nothing and just logs while a bootstrap run is in flight', async () => {
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
  const bootstrap = createBootstrap({ hot, store, client, llm, calibrator: createCalibrator(), getSelfName: () => 'Nept', now: () => 10_000_000 });

  const runPromise = bootstrap.run('g1');
  const refreshResult = await bootstrap.refreshPortrait('g1', 'a', 'reason');
  assert.equal(refreshResult.ok, false);
  assert.equal(refreshResult.reason, 'bootstrapping');

  resolveGate();
  await runPromise;
});
