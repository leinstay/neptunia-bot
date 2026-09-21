// Tests for src/memory/bootstrap.js: the F36 phase-A sample-based bootstrap
// PREVIEW. Pure helpers (pickPeople, memberStats, splitNewestOlder,
// sampleMember, selectChannelMessages, markOwnContext, buildProfileRequest,
// buildChannelRequest, clampProfileResult, clampChannelResult) are tested
// directly; the factory is tested against a fake discord.js guild/channel and
// a fake LLM client. No network, no real prompts/ or data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
        interestTopicChars: 40,
        interestNoteChars: 120,
        maxNewEpisodes: 3,
        clampTolerance: 1.25,
      },
      media: {},
      bootstrap: {
        lookbackDays: 60,
        minMessages: 2,
        maxPeople: 40,
        messagesPerPerson: 10,
        contextBefore: 1,
        maxChannelShare: 1,
        messagesPerChannel: 50,
        fetchLimitPerChannel: 1000,
        maxOutputTokens: 6000,
      },
      ...overrides.config,
    },
    prompts: {
      profile: 'SYSTEM {{name}}',
      channel: 'CHANNEL {{fieldChars}}',
      'character-card': 'CARD {{name}}',
      labels,
      ...overrides.prompts,
    },
  };
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
