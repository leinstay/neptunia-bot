// Tests for src/mentor/anchor.js and src/discord/collect.js#fetchMoment: a
// real moment of the chat resolved from a message of the persona -- the
// trigger it answered, her whole burst and the chat up to the trigger --
// and every refusal; and what the persona saw of the moment's media (the
// describer's cached captions and watched summaries), stored with it and
// replayed. Discord objects are plain fakes shaped just enough for
// normalizeMessage; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import {
  anchorSituations,
  ledgerEntryFor,
  parseMessageRef,
  pulledFromStored,
  replayMedia,
  resolveAnchor,
  snowflakeTime,
  withoutJumpLink,
  withSeenMedia,
} from '../src/mentor/anchor.js';
import { answerReply, liveView } from '../src/mentor/sandbox.js';
import { fetchHistoryWindow, fetchMoment } from '../src/discord/collect.js';
import { fill, formatTranscript } from '../src/discord/format.js';
import { videoUrlCacheKey } from '../src/discord/video-sites.js';
import { labels } from './fixtures/labels.js';

const GUILD = '600000000000000001';
const OTHER_GUILD = '600000000000000009';
const SELF_ID = '900000000000000001';
const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';
const CHANNEL_ID = '500000000000000001';
const START = Date.UTC(2026, 8, 29, 18, 0, 0);

/** A snowflake for the n-th message, a minute apart from START. */
function sf(n) {
  return ((BigInt(START + n * 60_000) - 1420070400000n) << 22n).toString();
}

function raw(n, authorId, text, extra = {}) {
  const names = { [SELF_ID]: 'Zoë', [ALICE]: 'Alice', [BRUNO]: 'Bruno' };
  return {
    id: sf(n),
    channelId: CHANNEL_ID,
    channel: { name: 'general' },
    author: { id: authorId, bot: authorId === SELF_ID, globalName: names[authorId], username: names[authorId] },
    member: { displayName: names[authorId] },
    cleanContent: text,
    createdTimestamp: START + n * 60_000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    reactions: { cache: new Map() },
    ...extra,
  };
}

const replyTo = (n) => ({ reference: { messageId: sf(n), channelId: CHANNEL_ID, type: 0 } });

/**
 * A readable guild channel over `raws` (oldest first); `readable: false` takes the history permission away,
 * `sendable: false` the send permission. `server` is a shared guild (see fakeServer) the channel joins.
 */
function fakeChannel(raws, { id = CHANNEL_ID, guildId = GUILD, readable = true, sendable = true, guild = true, name = 'general', server = null } = {}) {
  const byId = new Map(raws.map((m) => [m.id, m]));
  const fetches = [];
  const channel = {
    id,
    name,
    fetches,
    guild: server ?? (guild ? { id: guildId, members: { me: { id: SELF_ID } } } : null),
    viewable: true,
    isTextBased: () => true,
    isThread: () => false,
    get lastMessageId() {
      return raws.at(-1)?.id ?? null;
    },
    permissionsFor: () => ({ has: (flag) => (flag === PermissionFlagsBits.SendMessages ? sendable : readable) }),
    messages: {
      async fetch(arg) {
        fetches.push(arg);
        if (typeof arg === 'string') {
          const found = byId.get(arg);
          if (!found) throw new Error('Unknown Message');
          return found;
        }
        let list = [...raws];
        if (arg.before) list = list.filter((m) => BigInt(m.id) < BigInt(arg.before)).slice(-arg.limit);
        else if (arg.after) list = list.filter((m) => BigInt(m.id) > BigInt(arg.after)).slice(0, arg.limit);
        else list = list.slice(-arg.limit);
        return new Map(list.map((m) => [m.id, m]));
      },
    },
  };
  if (server) server.channels.cache.set(id, channel);
  return channel;
}

/** One guild for several channels, its channel cache filled by fakeChannel's `server` option (what the pull rails read). */
function fakeServer() {
  return { id: GUILD, members: { me: { id: SELF_ID } }, roles: { everyone: null, cache: new Map() }, channels: { cache: new Map() } };
}

function fakeClient(channels) {
  return { channels: { fetch: async (id) => channels[id] ?? null } };
}

/** A dispute: Bruno asks, Alice argues at length, she answers in a burst of two, Bruno goes on. */
function dispute() {
  return [
    raw(0, BRUNO, 'καλημέρα'),
    raw(1, ALICE, 'the café opens late today'),
    raw(2, SELF_ID, 'no, it opens at nine'),
    raw(3, ALICE, 'é'.repeat(1580), { reactions: { cache: new Map([['r', { emoji: { name: '👍' }, count: 2, me: false }]]) } }),
    raw(4, SELF_ID, 'you are right, but', replyTo(3)),
    raw(5, SELF_ID, 'it still opens at nine'),
    raw(6, BRUNO, 'ok then'),
    raw(7, SELF_ID, 'see?'),
  ];
}

function resolve(channel, ref, extra = {}) {
  return resolveAnchor({
    ref,
    guildId: GUILD,
    contextChannelId: CHANNEL_ID,
    selfId: SELF_ID,
    client: fakeClient({ [CHANNEL_ID]: channel, ...extra.channels }),
    fetchMoment: extra.fetchMoment ?? fetchMoment,
    limit: extra.limit ?? 30,
    embedTextChars: 300,
    videoSites: extra.videoSites ?? [],
    mediaCache: extra.mediaCache,
    ledger: extra.ledger,
    fetchHistoryWindow: extra.fetchHistoryWindow,
    config: extra.config,
    labels: extra.labels,
  });
}

/**
 * collect.js#fetchMoment as it is today, recording the ledger entry it is handed: the tests of the
 * ledger's read side hold whatever fetchMoment makes of the entry.
 */
function recordingFetchMoment(seen) {
  return (channel, messageId, { ledgerEntry, ...options }) => {
    seen.push(ledgerEntry);
    return fetchMoment(channel, messageId, options);
  };
}

// ---- parseMessageRef -----------------------------------------------------------

test('parseMessageRef: a message link names its guild, channel and message', () => {
  assert.deepEqual(parseMessageRef(`https://discord.com/channels/${GUILD}/700000000000000002/${sf(4)}`), {
    guildId: GUILD,
    channelId: '700000000000000002',
    messageId: sf(4),
    dm: false,
  });
  assert.equal(parseMessageRef(`<https://ptb.discord.com/channels/${GUILD}/700000000000000002/${sf(4)}>`).messageId, sf(4));
});

test('parseMessageRef: a bare id means the channel the command was typed in', () => {
  assert.deepEqual(parseMessageRef(` ${sf(4)} `, { channelId: CHANNEL_ID }), { guildId: null, channelId: CHANNEL_ID, messageId: sf(4), dm: false });
  assert.throws(() => parseMessageRef(sf(4), {}), /link/);
});

test('parseMessageRef: a direct-message link is marked, anything else is refused', () => {
  assert.equal(parseMessageRef(`https://discord.com/channels/@me/700000000000000002/${sf(4)}`).dm, true);
  assert.throws(() => parseMessageRef('the message about the café', { channelId: CHANNEL_ID }), /message link or a message id/);
  assert.throws(() => parseMessageRef('', { channelId: CHANNEL_ID }), /message link or a message id/);
});

// ---- resolving a moment -------------------------------------------------------

test('resolveAnchor: a reply takes the message it replies to as the trigger', async () => {
  const anchor = await resolve(fakeChannel(dispute()), `https://discord.com/channels/${GUILD}/${CHANNEL_ID}/${sf(4)}`);
  assert.equal(anchor.channelId, CHANNEL_ID);
  assert.equal(anchor.messageId, sf(4));
  assert.equal(anchor.triggerId, sf(3));
  // The chat up to and including the trigger, oldest first, normalized.
  assert.deepEqual(anchor.history.map((m) => m.id), [sf(0), sf(1), sf(2), sf(3)]);
  const trigger = anchor.history.at(-1);
  assert.equal(trigger.authorName, 'Alice');
  assert.equal(trigger.content.length, 1580);
  assert.deepEqual(trigger.reactions, [{ emoji: '👍', count: 2, mine: false }]);
  assert.equal(anchor.history[2].self, true);
  // Her whole burst, starting at the linked message.
  assert.deepEqual(anchor.original, ['you are right, but', 'it still opens at nine']);
});

test('resolveAnchor: without a reply the trigger is the last earlier message that is not hers', async () => {
  const anchor = await resolve(fakeChannel(dispute()), sf(7));
  assert.equal(anchor.triggerId, sf(6));
  assert.deepEqual(anchor.original, ['see?']);
  assert.equal(anchor.history.at(-1).content, 'ok then');
});

test('resolveAnchor: a message in the middle of her burst skips her earlier messages to find the trigger', async () => {
  const anchor = await resolve(fakeChannel(dispute()), sf(5));
  assert.equal(anchor.triggerId, sf(3));
  assert.deepEqual(anchor.original, ['it still opens at nine']);
});

test('resolveAnchor: a reply to her own message falls back to the last message that is not hers', async () => {
  const raws = [raw(0, ALICE, 'who is there'), raw(1, SELF_ID, 'me'), raw(2, SELF_ID, 'still me', replyTo(1))];
  const anchor = await resolve(fakeChannel(raws), sf(2));
  assert.equal(anchor.triggerId, sf(0));
});

test('resolveAnchor: the history holds at most contextMessages messages, the trigger last', async () => {
  const raws = Array.from({ length: 12 }, (_, n) => raw(n, n % 2 ? ALICE : BRUNO, `line ${n}`));
  raws.push(raw(12, SELF_ID, 'my answer'));
  const anchor = await resolve(fakeChannel(raws), sf(12), { limit: 5 });
  assert.deepEqual(anchor.history.map((m) => m.content), ['line 7', 'line 8', 'line 9', 'line 10', 'line 11']);
});

test('resolveAnchor: refuses a message that is not the persona\'s', async () => {
  await assert.rejects(resolve(fakeChannel(dispute()), sf(3)), /not the persona's/);
});

test('resolveAnchor: refuses a message that does not exist', async () => {
  await assert.rejects(resolve(fakeChannel(dispute()), sf(40)), /not found/);
});

test('resolveAnchor: refuses a channel the bot cannot read', async () => {
  const channel = fakeChannel(dispute(), { readable: false });
  await assert.rejects(resolve(channel, sf(4)), /cannot read that channel/);
  assert.deepEqual(channel.fetches, [], 'nothing was fetched');
  await assert.rejects(resolve(channel, `https://discord.com/channels/${GUILD}/500000000000000077/${sf(4)}`), /cannot read that channel/);
});

test('resolveAnchor: refuses a direct message', async () => {
  await assert.rejects(resolve(fakeChannel(dispute()), `https://discord.com/channels/@me/${CHANNEL_ID}/${sf(4)}`), /direct message/);
  await assert.rejects(resolve(fakeChannel(dispute(), { guild: false }), sf(4)), /direct message/);
});

test('resolveAnchor: refuses another guild, by the link or by the channel', async () => {
  await assert.rejects(resolve(fakeChannel(dispute()), `https://discord.com/channels/${OTHER_GUILD}/${CHANNEL_ID}/${sf(4)}`), /another server/);
  await assert.rejects(resolve(fakeChannel(dispute(), { guildId: OTHER_GUILD }), sf(4)), /another server/);
});

test('resolveAnchor: refuses when nobody else wrote before her message', async () => {
  await assert.rejects(resolve(fakeChannel([raw(0, SELF_ID, 'hello?')]), sf(0)), /no message of anyone else/);
});

test('resolveAnchor: refuses when the message she replied to is gone', async () => {
  const raws = [raw(0, ALICE, 'hi'), raw(2, SELF_ID, 'hello', replyTo(1))];
  await assert.rejects(resolve(fakeChannel(raws), sf(2)), /replies to is gone/);
});

// ---- stored anchors as situations -------------------------------------------------

test('anchorSituations: replays each usable anchor at the time she answered', async () => {
  const anchor = await resolve(fakeChannel(dispute()), sf(4));
  const item = { anchors: [{ id: 1, ...anchor }, { id: 2, ...anchor, history: [] }, { id: 3, ...anchor, messageId: 'x' }] };
  const [first, third, ...rest] = anchorSituations(item);
  assert.equal(rest.length, 0);
  assert.equal(first.anchor, 1);
  assert.equal(first.at, START + 4 * 60_000);
  assert.equal(snowflakeTime(sf(4)), START + 4 * 60_000);
  assert.deepEqual(first.original, anchor.original);
  // Without a usable message id: a minute after the trigger.
  assert.equal(third.anchor, 3);
  assert.equal(third.at, START + 3 * 60_000 + 60_000);
  assert.deepEqual(anchorSituations({}), []);
});

// ---- what the persona saw of the moment's media ------------------------------------

const VIDEO_ID = '810000000000000001';
const IMAGE_ID = '810000000000000002';
const BLANK_ID = '810000000000000003';
const EMOJI_ID = '810000000000000004';
const FORWARDED_ID = '810000000000000005';
const SITES = ['youtube.com'];
const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
/** Written by the describer before her answer (sf(4)), and after it. */
const SEEN_TS = START + 3 * 60_000 + 30_000;
const LATER_TS = START + 10 * 60_000;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function attachmentsOf(...list) {
  return new Map(list.map((a) => [a.id, { url: `https://cdn.discordapp.com/attachments/1/${a.id}/${a.name}`, size: 1000, ...a }]));
}

/** A chat with media: a clip, two pictures, a typed video-site link, a custom emoji in the trigger; her answer last. */
function mediaChat() {
  return [
    raw(0, BRUNO, 'look', { attachments: attachmentsOf({ id: VIDEO_ID, contentType: 'video/mp4', name: 'clip.mp4', duration: 12 }) }),
    raw(1, ALICE, 'and these', {
      attachments: attachmentsOf({ id: IMAGE_ID, contentType: 'image/png', name: 'a.png' }, { id: BLANK_ID, contentType: 'image/png', name: 'b.png' }),
    }),
    raw(2, BRUNO, `this one too ${YOUTUBE}`),
    raw(3, ALICE, 'what do you think :wave:', { content: `what do you think <:wave:${EMOJI_ID}>` }),
    raw(4, SELF_ID, 'ha, the cup', replyTo(3)),
  ];
}

/** The describer's cache (data/guilds/<id>/media.json) as the live turns left it; frozen, so a write throws. */
function mediaCache(extra = {}) {
  return deepFreeze({
    [VIDEO_ID]: { text: 'a still of a cat', ts: SEEN_TS },
    [`video:${VIDEO_ID}`]: { text: 'a cat knocks a cup off the table', ts: SEEN_TS, watched: true },
    [IMAGE_ID]: { text: 'a café terrace at night', ts: SEEN_TS },
    [BLANK_ID]: { miss: true, ts: SEEN_TS },
    [`video:${videoUrlCacheKey(YOUTUBE)}`]: { text: 'a music video from the eighties', ts: SEEN_TS, watched: true },
    // Described only after she answered: she never saw it.
    [`emoji:${EMOJI_ID}`]: { text: 'a waving hand', ts: LATER_TS },
    ...extra,
  });
}

/** The chat transcript of `history` as a live turn renders it, with the given caption and video maps. */
function rendered(history, { descriptions, videos } = {}) {
  return formatTranscript(history, { timezone: 'UTC', gapMinutes: 60, maxChars: 2000, selfName: 'Zoë', labels, descriptions, videos })
    .map((item) => item.text)
    .join('\n');
}

/** The maps a live turn builds from the same cache: captions by item id, watched videos by item id. */
function liveMaps() {
  return {
    descriptions: new Map([
      [VIDEO_ID, 'a still of a cat'],
      [IMAGE_ID, 'a café terrace at night'],
    ]),
    videos: new Map([
      [VIDEO_ID, { state: 'watched', text: 'a cat knocks a cup off the table' }],
      [videoUrlCacheKey(YOUTUBE), { state: 'watched', text: 'a music video from the eighties' }],
    ]),
  };
}

test('resolveAnchor: each message keeps the cached captions and watched summaries of its media; the rest keep none', async () => {
  const cache = mediaCache();
  const before = structuredClone(cache);
  const anchor = await resolve(fakeChannel(mediaChat()), sf(4), { mediaCache: cache, videoSites: SITES });
  assert.deepEqual(anchor.media, { described: 3, none: 2 });
  const [clip, pictures, link, trigger] = anchor.history;
  assert.deepEqual(clip.mediaSeen, {
    captions: { [VIDEO_ID]: 'a still of a cat' },
    watched: { [VIDEO_ID]: 'a cat knocks a cup off the table' },
  });
  // A cached miss is no description.
  assert.deepEqual(pictures.mediaSeen, { captions: { [IMAGE_ID]: 'a café terrace at night' } });
  assert.deepEqual(link.mediaSeen, { watched: { [videoUrlCacheKey(YOUTUBE)]: 'a music video from the eighties' } });
  // Described after her answer: not what she saw.
  assert.equal(trigger.mediaSeen, undefined);
  assert.deepEqual(cache, before, 'the cache is read, never written');
});

test('resolveAnchor: without a cache the moment is stored as before', async () => {
  const anchor = await resolve(fakeChannel(mediaChat()), sf(4), { videoSites: SITES });
  assert.ok(anchor.history.every((message) => !('mediaSeen' in message)));
  assert.deepEqual(anchor.media, { described: 0, none: 5 });
});

test('withSeenMedia: a forwarded picture counts for the outer message; the history is never changed', () => {
  const message = {
    id: 'm1',
    content: '',
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    forwarded: [{ content: '', attachments: [{ id: FORWARDED_ID, kind: 'image', name: 'f.png', url: 'u' }], links: [], stickers: [], emojis: [] }],
  };
  const history = deepFreeze([message, { id: 'm2', content: 'plain', attachments: [], links: [], forwarded: [], stickers: [], emojis: [] }]);
  // An entry without a time is taken; one with an empty text is not a description.
  const cache = deepFreeze({ [FORWARDED_ID]: { text: 'a map of the old town' }, other: { text: '  ', ts: 1 } });
  const result = withSeenMedia(history, { cache, before: SEEN_TS });
  assert.deepEqual(result.history[0].mediaSeen, { captions: { [FORWARDED_ID]: 'a map of the old town' } });
  assert.equal(result.history[1], history[1]);
  assert.deepEqual({ described: result.described, none: result.none }, { described: 1, none: 0 });

  // Without a cache (the options omitted, or a null one) nothing is described and the history is returned as is.
  for (const bare of [withSeenMedia(history), withSeenMedia(history, { cache: null })]) {
    assert.equal(bare.history[0], history[0]);
    assert.deepEqual({ described: bare.described, none: bare.none }, { described: 0, none: 1 });
  }
});

test('replayMedia: the stored descriptions render exactly as the live transcript rendered the cache', async () => {
  const anchor = await resolve(fakeChannel(mediaChat()), sf(4), { mediaCache: mediaCache(), videoSites: SITES });
  const media = replayMedia(anchor.history, { sites: SITES, before: snowflakeTime(sf(4)) });
  const live = liveMaps();
  assert.deepEqual(media.descriptions, live.descriptions);
  assert.deepEqual(media.videos, live.videos);
  const text = rendered(anchor.history, media);
  assert.equal(text, rendered(anchor.history, live));
  assert.match(text, /\[video: clip\.mp4, 0:12, watched: a cat knocks a cup off the table\]/);
  assert.match(text, /\[image: a café terrace at night\] \[image\]/);
  assert.match(text, /\[watched: a music video from the eighties\]/);
  assert.doesNotMatch(text, /a waving hand/);
});

test('replayMedia: an anchor stored without descriptions finds them in the cache, as they stood when she answered', async () => {
  const anchor = await resolve(fakeChannel(mediaChat()), sf(4), { videoSites: SITES });
  const cache = mediaCache();
  const before = structuredClone(cache);
  const media = replayMedia(anchor.history, { cache, sites: SITES, before: snowflakeTime(sf(4)) });
  const live = liveMaps();
  assert.deepEqual(media.descriptions, live.descriptions);
  assert.deepEqual(media.videos, live.videos);
  assert.deepEqual(cache, before, 'the cache is read, never written');
  // A stored description wins over the cache; nothing written after her answer is taken.
  const stored = structuredClone(anchor.history);
  stored[1].mediaSeen = { captions: { [IMAGE_ID]: 'the stored caption' } };
  const later = mediaCache({ [BLANK_ID]: { text: 'described a day later', ts: LATER_TS } });
  const mixed = replayMedia(stored, { cache: later, sites: SITES, before: snowflakeTime(sf(4)) });
  assert.equal(mixed.descriptions.get(IMAGE_ID), 'the stored caption');
  assert.equal(mixed.descriptions.has(BLANK_ID), false);
});

test('replayMedia: an anchor without descriptions and nothing cached replays unchanged', async () => {
  const anchor = await resolve(fakeChannel(mediaChat()), sf(4), { videoSites: SITES });
  const media = replayMedia(anchor.history, { cache: null, sites: SITES, before: snowflakeTime(sf(4)) });
  assert.equal(media.descriptions.size, 0);
  assert.equal(media.videos.size, 0);
  assert.equal(rendered(anchor.history, media), rendered(anchor.history));
  assert.match(rendered(anchor.history, media), /\[video: clip\.mp4, 0:12\]/);
  assert.equal(replayMedia(anchor.history, { cache: {}, sites: SITES }).descriptions.size, 0);
});

// ---- what the post answered: the ledger, the routed call, the pulled channels ------------

const SOURCE_ID = '500000000000000002';
const KITCHEN_ID = '500000000000000003';
const STAFF_ID = '500000000000000004';

/** A post ledger entry (state.json `postLedger`) for her message `n`. */
function entry(n, fields = {}) {
  return { messageId: sf(n), channelId: CHANNEL_ID, mode: 'reply', triggerKind: 'mention', triggerId: sf(n - 1), newestHistoryId: sf(n - 1), sourceChannelId: null, at: START, ...fields };
}

const at = (channelId, name) => ({ channelId, channel: { name } });

test('ledgerEntryFor: the entry of her message in its channel, the newest first; nothing without a list', () => {
  const first = entry(7, { triggerKind: 'name' });
  const second = entry(7, { triggerKind: 'overheard' });
  const ledger = [entry(4), first, null, 'junk', second, entry(7, { channelId: SOURCE_ID })];
  assert.equal(ledgerEntryFor(ledger, { channelId: CHANNEL_ID, messageId: sf(7) }), second);
  assert.equal(ledgerEntryFor(ledger, { channelId: CHANNEL_ID, messageId: sf(5) }), null);
  assert.equal(ledgerEntryFor(undefined, { channelId: CHANNEL_ID, messageId: sf(7) }), null);
  assert.equal(ledgerEntryFor({ length: 1 }, { channelId: CHANNEL_ID, messageId: sf(7) }), null);
});

test('resolveAnchor: a ledger entry goes to fetchMoment and the turn it names is stored; without one the trigger is guessed', async () => {
  const seen = [];
  const posted = entry(7, { triggerKind: 'overheard', triggerId: sf(6) });
  const anchor = await resolve(fakeChannel(dispute()), sf(7), { ledger: [entry(4), posted], fetchMoment: recordingFetchMoment(seen) });
  assert.deepEqual(seen, [posted]);
  assert.equal(anchor.triggerId, sf(6));
  assert.equal(anchor.mode, 'reply');
  assert.equal(anchor.triggerKind, 'overheard');
  assert.equal(anchor.sourceChannelId, null);
  assert.equal('triggerGuessed' in anchor, false);
  assert.equal('pulled' in anchor, false);
  // Replayed as what it was: an overheard line, answered in a reply turn.
  const [situation] = anchorSituations({ anchors: [{ id: 1, ...anchor }] });
  assert.deepEqual({ mode: situation.mode, kind: situation.kind, triggerId: situation.triggerId }, { mode: 'reply', kind: 'overheard', triggerId: sf(6) });

  // No ledger, or one that does not hold her message: fetchMoment gets no entry, the trigger is guessed.
  for (const ledger of [undefined, [entry(4)]]) {
    const asked = [];
    const guessed = await resolve(fakeChannel(dispute()), sf(7), { ledger, fetchMoment: recordingFetchMoment(asked) });
    assert.deepEqual(asked, [undefined]);
    assert.equal(guessed.triggerGuessed, true);
    for (const key of ['mode', 'triggerKind', 'sourceChannelId']) assert.equal(key in guessed, false, key);
  }
});

test('resolveAnchor: an entry whose trigger fetchMoment did not take keeps the turn but marks the trigger guessed', async () => {
  // The ledger says she answered message 3; today's fetchMoment takes the newest earlier line, message 6.
  const anchor = await resolve(fakeChannel(dispute()), sf(7), { ledger: [entry(7, { triggerKind: 'followUp', triggerId: sf(3) })], fetchMoment: recordingFetchMoment([]) });
  assert.equal(anchor.triggerId, sf(6));
  assert.equal(anchor.triggerKind, 'followUp');
  assert.equal(anchor.triggerGuessed, true);
  // A mode or kind the turn does not know is stored as none.
  const odd = await resolve(fakeChannel(dispute()), sf(7), { ledger: [entry(7, { mode: 'auto', triggerKind: 'shouted', triggerId: sf(6) })], fetchMoment: recordingFetchMoment([]) });
  assert.equal(odd.mode, null);
  assert.equal(odd.triggerKind, null);
});

/**
 * A routed answer: Bruno calls her in the read-only #announcements; she answers in #general with the
 * jump link; Alice writes there after the call. The ledger names the call.
 */
function routedServer({ joinLink = (text, link) => fill(labels.elsewhere.link, { text, link }) } = {}) {
  const server = fakeServer();
  const link = `https://discord.com/channels/${GUILD}/${SOURCE_ID}/${sf(5)}`;
  const main = fakeChannel(
    [raw(0, BRUNO, 'καλημέρα'), raw(1, ALICE, 'the café opens late today'), raw(6, SELF_ID, joinLink('ANSWER yes, I am here', link)), raw(7, SELF_ID, 'and the café opens at nine')],
    { server },
  );
  const source = fakeChannel(
    [
      raw(2, ALICE, 'ANNOUNCEMENT the market moves to Friday', at(SOURCE_ID, 'announcements')),
      raw(5, BRUNO, 'CALL are you there?', at(SOURCE_ID, 'announcements')),
      raw(8, ALICE, 'AFTER the call, unseen', at(SOURCE_ID, 'announcements')),
    ],
    { id: SOURCE_ID, name: 'announcements', sendable: false, server },
  );
  const ledger = [entry(6, { triggerId: sf(5), newestHistoryId: sf(1), sourceChannelId: SOURCE_ID })];
  return { main, source, ledger, channels: { [SOURCE_ID]: source } };
}

test('resolveAnchor: a routed answer stores its source window ending at the call, and its original loses the link', async () => {
  const { main, ledger, channels } = routedServer();
  const anchor = await resolve(main, sf(6), { ledger, channels, fetchHistoryWindow, fetchMoment: recordingFetchMoment([]), labels });
  assert.equal(anchor.triggerId, sf(5));
  assert.equal(anchor.sourceChannelId, SOURCE_ID);
  assert.equal(anchor.triggerKind, 'mention');
  assert.equal('triggerGuessed' in anchor, false, 'the call comes from the ledger');
  assert.deepEqual(anchor.original, ['ANSWER yes, I am here', 'and the café opens at nine']);
  assert.equal(anchor.pulled.length, 1);
  const [window] = anchor.pulled;
  assert.deepEqual(
    { channelId: window.channelId, channelName: window.channelName, readOnly: window.readOnly, reason: window.reason, olderNotShown: window.olderNotShown },
    { channelId: SOURCE_ID, channelName: 'announcements', readOnly: true, reason: 'routed', olderNotShown: false },
  );
  assert.deepEqual(window.messages.map((m) => m.content), ['ANNOUNCEMENT the market moves to Friday', 'CALL are you there?']);

  // Without the label the link was joined on its own line; it goes all the same.
  const plain = routedServer({ joinLink: (text, link) => `${text}\n${link}` });
  const bare = await resolve(plain.main, sf(6), { ledger: plain.ledger, channels: plain.channels, fetchHistoryWindow, fetchMoment: recordingFetchMoment([]) });
  assert.deepEqual(bare.original, ['ANSWER yes, I am here', 'and the café opens at nine']);
});

test('resolveAnchor: a routed answer whose call cannot be read is refused', async () => {
  const { main, ledger } = routedServer();
  const unreadable = fakeChannel([], { id: SOURCE_ID, readable: false, sendable: false });
  for (const channels of [{}, { [SOURCE_ID]: unreadable }]) {
    await assert.rejects(resolve(main, sf(6), { ledger, channels, fetchHistoryWindow, fetchMoment: recordingFetchMoment([]) }), /call it answered/);
  }
  // Nor without a way to read another channel.
  const { channels } = routedServer();
  await assert.rejects(resolve(main, sf(6), { ledger, channels, fetchMoment: recordingFetchMoment([]) }), /call it answered/);
});

test('anchorSituations: a routed anchor replays with a <channel_view> holding the call, answered where she spoke', async () => {
  const { main, ledger, channels } = routedServer();
  const anchor = await resolve(main, sf(6), { ledger, channels, fetchHistoryWindow, fetchMoment: recordingFetchMoment([]), labels });
  const [situation] = anchorSituations({ anchors: [{ id: 1, ...anchor }] });
  assert.deepEqual(situation.source, { channelId: SOURCE_ID, reason: 'routed' });
  assert.equal(situation.kind, 'mention');
  assert.equal(situation.at, START + 6 * 60_000);
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      context: { maxMessageChars: 800, gapMarkerMinutes: 20, otherProfiles: 6, caps: {}, vision: {} },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      features: { memory: false },
    },
    prompts: { 'system-prompt': 'SYSTEM', reply: 'REPLY_TASK {{author}}: {{trigger}} {{target}}', labels },
  };
  const llm = { calls: [], complete: async (messages) => (llm.calls.push(messages), { text: '<skip/>', usage: null, estimated: 1 }) };
  const view = liveView({ hot, store: {}, guildId: GUILD });
  const result = await answerReply({ view, situation, selfId: SELF_ID, selfName: 'Zoë', channel: { id: CHANNEL_ID, name: 'general' }, llm, samples: 1, at: situation.at });
  assert.match(result.request.user, /<channel_view>\n[^]*CALL are you there\?[^]*\n<\/channel_view>/);
  assert.ok(!result.request.user.includes('AFTER the call'));
  assert.ok(result.request.user.includes(fill(labels.elsewhere.called, { channel: 'announcements', destination: 'general' })));
  assert.ok(result.request.user.includes(`REPLY_TASK Bruno: ${labels.triggers.mention}`));
});

test('resolveAnchor: a channel named with <#id> in the moment keeps its window, ending before her answer; a refused one keeps none', async () => {
  const server = fakeServer();
  const config = { bot: { channels: { allow: [], deny: [STAFF_ID] }, dryRunChannelId: '' }, context: { pull: { sameAudience: false } } };
  const main = fakeChannel(
    [
      raw(0, BRUNO, 'look at #kitchen', { content: `look at <#${KITCHEN_ID}>` }),
      raw(1, ALICE, 'and #staff', { content: `and <#${STAFF_ID}>` }),
      raw(4, SELF_ID, 'the oven again'),
    ],
    { server },
  );
  const kitchen = fakeChannel(
    [raw(2, ALICE, 'KITCHEN the oven is on', at(KITCHEN_ID, 'kitchen')), raw(3, BRUNO, 'KITCHEN who left it on', at(KITCHEN_ID, 'kitchen')), raw(9, ALICE, 'KITCHEN after her answer', at(KITCHEN_ID, 'kitchen'))],
    { id: KITCHEN_ID, name: 'kitchen', server },
  );
  fakeChannel([raw(2, ALICE, 'STAFF only', at(STAFF_ID, 'staff'))], { id: STAFF_ID, name: 'staff', server });
  const anchor = await resolve(main, sf(4), { fetchHistoryWindow, config });
  assert.equal(anchor.pulled.length, 1, 'the denied channel takes no slot');
  const [window] = anchor.pulled;
  assert.equal(window.channelId, KITCHEN_ID);
  assert.equal(window.reason, 'mention');
  assert.equal(window.readOnly, false);
  assert.deepEqual(window.messages.map((m) => m.content), ['KITCHEN the oven is on', 'KITCHEN who left it on']);
  assert.ok(kitchen.fetches.length > 0);

  // features.channelPull off: no channel is kept.
  const off = await resolve(main, sf(4), { fetchHistoryWindow, config: { ...config, features: { channelPull: false } } });
  assert.equal('pulled' in off, false);
});

test('withoutJumpLink: the link a post carried goes, in the label\'s form or the plain one; anything else stays', () => {
  const link = `https://discord.com/channels/${GUILD}/${SOURCE_ID}/${sf(5)}`;
  assert.equal(withoutJumpLink(`ναι, εδώ [from ${link}]`, { form: labels.elsewhere.link, guildId: GUILD }), 'ναι, εδώ');
  assert.equal(withoutJumpLink(`ναι, εδώ\n${link}`, { guildId: GUILD }), 'ναι, εδώ');
  // A post that was only the link (Discord trims the separator away).
  assert.equal(withoutJumpLink(link, { guildId: GUILD }), '');
  // Another server's link, or a link inside the text, stays as written.
  const other = `see\nhttps://discord.com/channels/${OTHER_GUILD}/${SOURCE_ID}/${sf(5)}`;
  assert.equal(withoutJumpLink(other, { guildId: GUILD }), other);
  assert.equal(withoutJumpLink(`${link}\nis where it was said`, { guildId: GUILD }), `${link}\nis where it was said`);
  assert.equal(withoutJumpLink('no link at all', { form: labels.elsewhere.link, guildId: GUILD }), 'no link at all');
});

test('anchorSituations: a stored moment carries its mode, kind, source and windows; an older one replays as before', () => {
  const history = [
    { id: sf(1), authorId: ALICE, self: false, content: 'a', ts: START + 60_000 },
    { id: sf(3), authorId: SELF_ID, self: true, content: 'mine, after the call', ts: START + 3 * 60_000 },
  ];
  const window = { channelId: SOURCE_ID, channelName: 'announcements', readOnly: true, reason: 'routed', olderNotShown: false, messages: [{ id: sf(4), authorId: BRUNO, self: false, content: 'call', ts: START + 4 * 60_000 }] };
  const routed = { id: 1, channelId: CHANNEL_ID, messageId: sf(6), triggerId: sf(4), history, original: ['x'], mode: 'reply', triggerKind: 'mention', sourceChannelId: SOURCE_ID, pulled: [window] };
  const older = { id: 2, channelId: CHANNEL_ID, messageId: 'x', triggerId: sf(1), history: history.slice(0, 1), original: ['y'] };
  const [first, second, ...rest] = anchorSituations({ anchors: [routed, older] });
  assert.equal(rest.length, 0);
  assert.deepEqual(
    { mode: first.mode, kind: first.kind, triggerId: first.triggerId, source: first.source, pulled: first.pulled },
    { mode: 'reply', kind: 'mention', triggerId: sf(4), source: { channelId: SOURCE_ID, reason: 'routed' }, pulled: [window] },
  );
  // The chat ends with her own line, but the call she answered is newer and not hers: usable, answered after the call.
  assert.equal(first.at, START + 6 * 60_000);
  assert.deepEqual({ mode: second.mode, kind: second.kind, source: second.source, pulled: second.pulled }, { mode: null, kind: null, source: null, pulled: [] });
  assert.equal(second.at, START + 60_000 + 60_000);
  // A call that is her own line makes the moment unusable.
  assert.deepEqual(anchorSituations({ anchors: [{ ...routed, triggerId: sf(3) }] }).length, 0);
});

test('pulledFromStored: rebuilds the channel records a turn shows, captions from what was stored, no ring marks', () => {
  const pictures = [{ id: '810000000000000011', kind: 'image', name: 'a.png', url: 'u1' }, { id: '810000000000000012', kind: 'image', name: 'b.png', url: 'u2' }];
  const message = { id: sf(4), channelId: SOURCE_ID, authorId: BRUNO, self: false, content: 'look', ts: START + 4 * 60_000, attachments: pictures, links: [], forwarded: [], stickers: [], emojis: [], mediaSeen: { captions: { '810000000000000011': 'a café at night' } } };
  const window = { channelId: SOURCE_ID, channelName: 'announcements', readOnly: true, reason: 'routed', olderNotShown: true, messages: [message] };
  const { pulled, source, readOnlyIds } = pulledFromStored({ pulled: [window], source: { channelId: SOURCE_ID, reason: 'routed' } });
  assert.equal(pulled.length, 1);
  const [record] = pulled;
  assert.deepEqual(
    { channelId: record.channelId, channelName: record.channelName, readOnly: record.readOnly, reason: record.reason, olderNotShown: record.olderNotShown, picturesNotSeen: record.picturesNotSeen },
    { channelId: SOURCE_ID, channelName: 'announcements', readOnly: true, reason: 'routed', olderNotShown: true, picturesNotSeen: 1 },
  );
  assert.deepEqual(record.messages, window.messages);
  assert.deepEqual(record.descriptions, new Map([['810000000000000011', 'a café at night']]));
  assert.deepEqual(record.earlierPingIds, new Set());
  assert.deepEqual(record.pingState, new Map());
  assert.deepEqual(source, { channelId: SOURCE_ID, reason: 'routed' });
  assert.deepEqual(readOnlyIds, new Set([SOURCE_ID]));

  // A source whose window is not stored is no source; nothing stored, nothing shown.
  for (const situation of [{ pulled: [], source: { channelId: SOURCE_ID, reason: 'routed' } }, undefined, { lines: [] }]) {
    const none = pulledFromStored(situation);
    assert.deepEqual(none.pulled, []);
    assert.equal(none.source, null);
    assert.deepEqual(none.readOnlyIds, new Set());
  }
});
