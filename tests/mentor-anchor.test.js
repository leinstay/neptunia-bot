// Tests for src/mentor/anchor.js and src/discord/collect.js#fetchMoment: a
// real moment of the chat resolved from a message of the persona -- the
// trigger it answered, her whole burst and the chat up to the trigger --
// and every refusal; and what the persona saw of the moment's media (the
// describer's cached captions and watched summaries), stored with it and
// replayed. Discord objects are plain fakes shaped just enough for
// normalizeMessage; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorSituations, parseMessageRef, replayMedia, resolveAnchor, snowflakeTime, withSeenMedia } from '../src/mentor/anchor.js';
import { fetchMoment } from '../src/discord/collect.js';
import { formatTranscript } from '../src/discord/format.js';
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

/** A readable guild channel over `raws` (oldest first); `readable: false` takes the history permission away. */
function fakeChannel(raws, { id = CHANNEL_ID, guildId = GUILD, readable = true, guild = true } = {}) {
  const byId = new Map(raws.map((m) => [m.id, m]));
  const fetches = [];
  return {
    id,
    fetches,
    guild: guild ? { id: guildId, members: { me: { id: SELF_ID } } } : null,
    viewable: true,
    permissionsFor: () => ({ has: () => readable }),
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
    fetchMoment,
    limit: extra.limit ?? 30,
    embedTextChars: 300,
    videoSites: extra.videoSites ?? [],
    mediaCache: extra.mediaCache,
  });
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
