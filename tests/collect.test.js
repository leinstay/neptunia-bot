// Tests for src/discord/collect.js: normalizeMessage's media handling (voice
// flag, embed classification, raw-URL de-duplication, forwarded snapshots)
// and the lazy text-attachment preview fetch. Discord objects are plain
// fixtures shaped just enough for normalizeMessage to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, fetchTextPreview, withTextPreviews, fetchHistory, fetchHistoryWindow } from '../src/discord/collect.js';
import { MessageReferenceType } from 'discord.js';
import { videoUrlCacheKey } from '../src/discord/video-sites.js';

function flagsWith(names) {
  const set = new Set(names);
  return { has: (name) => set.has(name) };
}

function rawMessage(overrides = {}) {
  return {
    id: 'm1',
    channelId: 'c1',
    channel: { name: 'general' },
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
    member: { displayName: 'Alice' },
    cleanContent: 'hello',
    createdTimestamp: 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: flagsWith([]),
    ...overrides,
  };
}

test('normalizeMessage: classifies attachments through media.js, keeping url/size/duration', () => {
  const raw = rawMessage({
    attachments: new Map([
      ['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png', size: 123 }],
      ['a2', { id: 'a2', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn/clip.mp4', size: 456, duration: null }],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.attachments[0], { id: 'a1', kind: 'image', name: 'pic.png', url: 'https://cdn/pic.png', size: 123, durationSec: null });
  assert.equal(m.attachments[1].kind, 'video');
});

test('normalizeMessage: a voice-message flag reclassifies the attachment as voice', () => {
  const raw = rawMessage({
    flags: flagsWith(['IsVoiceMessage']),
    attachments: new Map([['a1', { id: 'a1', contentType: 'audio/ogg', name: 'voice-message.ogg', url: 'https://cdn/v.ogg', duration: 12 }]]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.attachments[0].kind, 'voice');
  assert.equal(m.attachments[0].durationSec, 12);
});

test('normalizeMessage: no voice flag leaves the same attachment as audio', () => {
  const raw = rawMessage({
    attachments: new Map([['a1', { id: 'a1', contentType: 'audio/ogg', name: 'song.ogg', url: 'https://cdn/v.ogg' }]]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.attachments[0].kind, 'audio');
});

test('normalizeMessage: an embed becomes a link item and its raw URL is removed from the content', () => {
  const raw = rawMessage({
    cleanContent: 'check this out https://example.com/page cool right',
    embeds: [{ url: 'https://example.com/page', title: 'A page', description: 'desc', provider: null }],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].kind, 'link');
  assert.equal(m.links[0].site, 'example.com');
  assert.ok(!m.content.includes('https://example.com/page'));
  assert.equal(m.content, 'check this out cool right');
});

test('normalizeMessage: a tenor embed becomes a gif link item, its URL also removed', () => {
  const raw = rawMessage({
    cleanContent: 'lol https://tenor.com/view/x',
    embeds: [{ url: 'https://tenor.com/view/x', provider: { name: 'Tenor' }, thumbnail: { url: 'https://t.tenor.com/x.png' } }],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].kind, 'gif');
  assert.equal(m.links[0].thumbnailUrl, 'https://t.tenor.com/x.png');
  assert.equal(m.content, 'lol');
});

test('normalizeMessage: an embed with no URL is skipped entirely (nothing to de-dupe or render)', () => {
  const raw = rawMessage({ embeds: [{ url: null, title: 'no url' }] });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.links, []);
});

test('normalizeMessage: link ids are stable and unique per embed index on the message', () => {
  const raw = rawMessage({
    embeds: [
      { url: 'https://a.example', title: 'a' },
      { url: 'https://b.example', title: 'b' },
    ],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].id, 'm1#e0');
  assert.equal(m.links[1].id, 'm1#e1');
});

test('normalizeMessage: a forwarded message (snapshot) is captured with its own content and media', () => {
  const raw = rawMessage({
    cleanContent: '',
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: 'forwarded text',
          attachments: new Map([['f1', { id: 'f1', contentType: 'image/png', name: 'f.png', url: 'https://cdn/f.png' }]]),
          embeds: [],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwarded.length, 1);
  assert.equal(m.forwarded[0].content, 'forwarded text');
  assert.equal(m.forwarded[0].attachments[0].kind, 'image');
});

test('normalizeMessage: no messageSnapshots means an empty forwarded array', () => {
  const raw = rawMessage();
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.forwarded, []);
});

// --- normalizeMessage: stickers ----------------------------------------

function sticker(id, name, format) {
  return { id, name, format };
}

test('normalizeMessage: stickers become { id, name, format, url }, PNG/APNG/GIF sized via media.discordapp.net', () => {
  const raw = rawMessage({
    stickers: new Map([
      ['s1', sticker('s1', 'pepe', 1)],
      ['s2', sticker('s2', 'wave', 2)],
      ['s3', sticker('s3', 'dance', 4)],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.stickers[0], { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' });
  assert.deepEqual(m.stickers[1], { id: 's2', name: 'wave', format: 2, url: 'https://media.discordapp.net/stickers/s2.png?size=160' });
  assert.deepEqual(m.stickers[2], { id: 's3', name: 'dance', format: 4, url: 'https://media.discordapp.net/stickers/s3.gif?size=160' });
});

test('normalizeMessage: a Lottie sticker (format 3) has a null url, name only', () => {
  const raw = rawMessage({ stickers: new Map([['s1', sticker('s1', 'wiggle', 3)]]) });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.stickers[0], { id: 's1', name: 'wiggle', format: 3, url: null });
});

// --- normalizeMessage: custom emoji extraction -------------------------

test('normalizeMessage: a static custom emoji is extracted, text keeps reading as :name:', () => {
  const raw = rawMessage({ cleanContent: 'nice <:pog:111> job' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, 'nice :pog: job');
  assert.deepEqual(m.emojis, [{ id: '111', name: 'pog', animated: false, url: 'https://cdn.discordapp.com/emojis/111.webp?size=96' }]);
});

test('normalizeMessage: an animated custom emoji is marked animated, same webp URL pattern', () => {
  const raw = rawMessage({ cleanContent: 'lol <a:kekw:222>' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, 'lol :kekw:');
  assert.deepEqual(m.emojis, [{ id: '222', name: 'kekw', animated: true, url: 'https://cdn.discordapp.com/emojis/222.webp?size=96' }]);
});

test('normalizeMessage: the same custom emoji repeated in one message is de-duplicated', () => {
  const raw = rawMessage({ cleanContent: '<:pog:111> <:pog:111> <:pog:111>' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.emojis.length, 1);
});

test('normalizeMessage: distinct custom emoji are capped at 5 per message, first-appearance order', () => {
  const ids = Array.from({ length: 8 }, (_, i) => i + 1);
  const content = ids.map((id) => `<:e${id}:${id}>`).join(' ');
  const raw = rawMessage({ cleanContent: content });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.emojis.length, 5);
  assert.deepEqual(m.emojis.map((e) => e.id), ['1', '2', '3', '4', '5']);
});

test('normalizeMessage: no custom emoji means an empty emojis array', () => {
  const raw = rawMessage({ cleanContent: 'plain text, no emoji' });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.emojis, []);
});

test('normalizeMessage: a forwarded snapshot also carries its own stickers and emoji', () => {
  const raw = rawMessage({
    cleanContent: '',
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: 'look <:pog:111>',
          attachments: new Map(),
          embeds: [],
          stickers: new Map([['s1', sticker('s1', 'pepe', 1)]]),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwarded[0].content, 'look :pog:');
  assert.deepEqual(m.forwarded[0].emojis, [{ id: '111', name: 'pog', animated: false, url: 'https://cdn.discordapp.com/emojis/111.webp?size=96' }]);
  assert.deepEqual(m.forwarded[0].stickers, [{ id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' }]);
});

// --- normalizeMessage: describable link thumbnails get a stable id ----

test('normalizeMessage: a link embed with a thumbnail (e.g. YouTube) gets a stable hash id, not the per-message index', () => {
  const raw = rawMessage({
    embeds: [
      {
        url: 'https://www.youtube.com/watch?v=xyz',
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg' },
      },
    ],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].kind, 'link');
  assert.ok(m.links[0].id.startsWith('link:'));
  assert.notEqual(m.links[0].id, 'm1#e0');
});

test('normalizeMessage: the same link thumbnail on two different messages gets the same stable id', () => {
  const embed = () => ({
    url: 'https://www.youtube.com/watch?v=xyz',
    provider: { name: 'YouTube' },
    title: 'Cool video',
    thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg?ex=1&hm=aaa' },
  });
  const m1 = normalizeMessage(rawMessage({ id: 'm1', embeds: [embed()] }), 'self');
  const m2 = normalizeMessage(
    rawMessage({ id: 'm2', embeds: [{ ...embed(), thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg?ex=9&hm=zzz' } }] }),
    'self',
  );
  assert.equal(m1.links[0].id, m2.links[0].id);
});

test('normalizeMessage: an embed thumbnail prefers proxyURL over url when discord.js exposes one', () => {
  const raw = rawMessage({
    embeds: [
      {
        url: 'https://www.youtube.com/watch?v=xyz',
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg', proxyURL: 'https://media.discordapp.net/external/abc/hq.jpg' },
      },
    ],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].thumbnailUrl, 'https://media.discordapp.net/external/abc/hq.jpg');
});

// --- normalizeMessage: video-site URLs typed in the text ----------------------

const VIDEO_SITES = ['youtube.com', 'youtu.be'];

test('normalizeMessage: a typed video-site URL becomes a synthetic link, its URL stays in the text', () => {
  const raw = rawMessage({ cleanContent: 'mira esto https://www.youtube.com/watch?v=abc&t=5 qué risa' });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.deepEqual(m.links[0], {
    id: videoUrlCacheKey('https://www.youtube.com/watch?v=abc&t=5'),
    kind: 'link',
    site: 'youtube.com',
    title: '',
    text: '',
    thumbnailUrl: null,
    url: 'https://www.youtube.com/watch?v=abc&t=5',
  });
  assert.ok(m.links[0].id.startsWith('video:url:'));
  assert.equal(m.content, 'mira esto https://www.youtube.com/watch?v=abc&t=5 qué risa');
});

test('normalizeMessage: without videoSites (the default) a typed video URL adds no link', () => {
  const raw = rawMessage({ cleanContent: 'https://youtu.be/xyz' });
  assert.deepEqual(normalizeMessage(raw, 'self').links, []);
  assert.deepEqual(normalizeMessage(raw, 'self', { videoSites: [] }).links, []);
});

test('normalizeMessage: a URL on a site outside videoSites adds no link', () => {
  const raw = rawMessage({ cleanContent: 'https://example.com/clip' });
  assert.deepEqual(normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES }).links, []);
});

test('normalizeMessage: a typed URL that an embed already carries is added once (the embed), id = the video cache key', () => {
  const url = 'https://www.youtube.com/watch?v=xyz';
  const raw = rawMessage({
    cleanContent: `look ${url}`,
    embeds: [{ url, provider: { name: 'YouTube' }, title: 'Cool video', thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg' } }],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].id, videoUrlCacheKey(url));
  assert.equal(m.links[0].title, 'Cool video');
  assert.equal(m.content, 'look');
});

test('normalizeMessage: a typed URL whose canonical key matches an embed URL is not added again', () => {
  const raw = rawMessage({
    cleanContent: 'look https://youtube.com/watch?v=xyz&si=tracking',
    embeds: [{ url: 'https://www.youtube.com/watch?v=xyz', provider: { name: 'YouTube' }, title: 'Cool video' }],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].id, videoUrlCacheKey('https://www.youtube.com/watch?v=xyz'));
});

test('normalizeMessage: a typed youtu.be link and a watch?v= embed of one video are one link with the canonical key', () => {
  const raw = rawMessage({
    cleanContent: 'δες https://youtu.be/ID42',
    embeds: [
      {
        url: 'https://www.youtube.com/watch?v=ID42',
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: { url: 'https://i.ytimg.com/vi/ID42/hq.jpg' },
      },
    ],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].id, videoUrlCacheKey('https://youtube.com/watch?v=ID42'));
  assert.equal(m.links[0].id, videoUrlCacheKey('https://youtu.be/ID42'));
  assert.equal(m.links[0].title, 'Cool video');
  assert.equal(m.links[0].thumbnailUrl, 'https://i.ytimg.com/vi/ID42/hq.jpg');
});

test('normalizeMessage: with videoSites set, a non-video embed keeps its existing id', () => {
  const raw = rawMessage({
    embeds: [
      { url: 'https://example.com/page', title: 'A page', thumbnail: { url: 'https://example.com/t.jpg' } },
      { url: 'https://example.com/other', title: 'Other' },
    ],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.ok(m.links[0].id.startsWith('link:'));
  assert.equal(m.links[1].id, 'm1#e1');
});

test('normalizeMessage: the same typed video URL twice becomes one synthetic link', () => {
  const raw = rawMessage({ cleanContent: 'https://youtu.be/xyz and again https://youtu.be/xyz' });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].site, 'youtu.be');
});

test('normalizeMessage: synthetic video links follow the embed links', () => {
  const raw = rawMessage({
    cleanContent: 'https://example.com/page https://youtu.be/xyz',
    embeds: [{ url: 'https://example.com/page', title: 'A page' }],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.deepEqual(m.links.map((link) => link.url), ['https://example.com/page', 'https://youtu.be/xyz']);
  assert.equal(m.content, 'https://youtu.be/xyz');
});

test('normalizeMessage: a forwarded snapshot also turns a typed video URL into a synthetic link', () => {
  const raw = rawMessage({
    cleanContent: '',
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: 'δες αυτό https://youtu.be/xyz',
          attachments: new Map(),
          embeds: [],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.forwarded[0].links.length, 1);
  assert.equal(m.forwarded[0].links[0].id, videoUrlCacheKey('https://youtu.be/xyz'));
  assert.equal(m.forwarded[0].content, 'δες αυτό https://youtu.be/xyz');
});

// --- normalizeMessage: forward vs. plain reply -------------------------------
// A real forwarded message's own content is empty; `message.reference` is
// `{ type: MessageReferenceType.Forward, channel_id: <source>, guild_id,
// message_id: <the ORIGINAL message> }`; `message.messageSnapshots` carries
// the forwarded content/media/embeds and has no `author`.

function guildWithChannel(id, name) {
  return { channels: { cache: new Map(id ? [[id, { id, name }]] : []) } };
}

test('normalizeMessage: a plain reply keeps replyToId, forwardedFrom stays null', () => {
  const raw = rawMessage({
    guild: guildWithChannel('c1', 'general'),
    reference: { messageId: 'm0', channelId: 'c1' }, // no `type`: an older/plain reply payload
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.replyToId, 'm0');
  assert.equal(m.forwardedFrom, null);
});

test('normalizeMessage: a reply explicitly typed Default behaves the same as an untyped one', () => {
  const raw = rawMessage({
    guild: guildWithChannel('c1', 'general'),
    reference: { messageId: 'm0', channelId: 'c1', type: MessageReferenceType.Default },
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.replyToId, 'm0');
  assert.equal(m.forwardedFrom, null);
});

test('normalizeMessage: a forward\'s replyToId is null even though message_reference carries the original message id', () => {
  const raw = rawMessage({
    guild: guildWithChannel('c2', 'announcements'),
    reference: { messageId: 'original-msg-id', channelId: 'c2', type: MessageReferenceType.Forward },
    messageSnapshots: new Map([
      ['snap1', { id: 'snap1', cleanContent: 'forwarded text', attachments: new Map(), embeds: [], stickers: new Map(), flags: flagsWith([]) }],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.replyToId, null);
});

test('normalizeMessage: a forward whose source channel resolves in the same guild sets forwardedFrom to its name', () => {
  const raw = rawMessage({
    guild: guildWithChannel('c2', 'announcements'),
    reference: { messageId: 'original-msg-id', channelId: 'c2', type: MessageReferenceType.Forward },
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwardedFrom, 'announcements');
});

test('normalizeMessage: a forward whose source channel does not resolve leaves forwardedFrom null', () => {
  const raw = rawMessage({
    guild: guildWithChannel(null, null),
    reference: { messageId: 'original-msg-id', channelId: 'gone-channel', type: MessageReferenceType.Forward },
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwardedFrom, null);
});

test('normalizeMessage: a forward with no guild on the message never throws, forwardedFrom stays null', () => {
  const raw = rawMessage({
    guild: undefined,
    reference: { messageId: 'original-msg-id', channelId: 'c2', type: MessageReferenceType.Forward },
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwardedFrom, null);
  assert.equal(m.replyToId, null);
});

// --- normalizeMessage: mentionedUserIds ---------------------------------

test('normalizeMessage: mentionedUserIds carries the real mention ids, in order', () => {
  const raw = rawMessage({ mentions: { users: new Map([['u2', {}], ['u3', {}]]) } });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.mentionedUserIds, ['u2', 'u3']);
});

test('normalizeMessage: no mentions at all means an empty mentionedUserIds array', () => {
  const m = normalizeMessage(rawMessage(), 'self');
  assert.deepEqual(m.mentionedUserIds, []);
});

// --- fetchHistory: embedTextChars reaches normalizeMessage -------------------

test('fetchHistory: threads embedTextChars through to the embed classification', async () => {
  const raw = rawMessage({
    embeds: [{ url: 'https://example.com', title: 'x'.repeat(50), description: 'y'.repeat(50) }],
  });
  const channel = { messages: { fetch: async () => new Map([[raw.id, raw]]) } };
  const [message] = await fetchHistory(channel, 10, 'self', 10);
  assert.equal(message.links[0].title, `${'x'.repeat(10)}…`);
});

test('fetchHistory: defaults to 200 chars when embedTextChars is not given', async () => {
  const raw = rawMessage({
    embeds: [{ url: 'https://example.com', title: 'x'.repeat(50) }],
  });
  const channel = { messages: { fetch: async () => new Map([[raw.id, raw]]) } };
  const [message] = await fetchHistory(channel, 10, 'self');
  assert.equal(message.links[0].title, 'x'.repeat(50));
});

test('fetchHistory: threads videoSites through, a typed video-site URL becomes a link item', async () => {
  const raw = rawMessage({ cleanContent: 'regarde https://www.youtube.com/watch?v=abc' });
  const channel = { messages: { fetch: async () => new Map([[raw.id, raw]]) } };

  const [withSites] = await fetchHistory(channel, 10, 'self', 200, ['youtube.com']);
  assert.equal(withSites.links.length, 1);
  assert.equal(withSites.links[0].url, 'https://www.youtube.com/watch?v=abc');

  const [withoutSites] = await fetchHistory(channel, 10, 'self', 200);
  assert.equal(withoutSites.links.length, 0);
});

test('fetchHistoryWindow: threads videoSites through to normalizeMessage', async () => {
  const raw = rawMessage({ cleanContent: 'regarde https://www.youtube.com/watch?v=abc' });
  const channel = { id: 'c1', messages: { fetch: async () => new Map([[raw.id, raw]]) } };

  const [message] = await fetchHistoryWindow(channel, { limit: 10, selfId: 'self', videoSites: ['youtube.com'] });
  assert.equal(message.links.length, 1);
});

// --- fetchTextPreview / withTextPreviews ------------------------------------

function fakeFetch(body, { ok = true, headers = {} } = {}) {
  return async () => ({
    ok,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  });
}

test('fetchTextPreview: returns the first maxChars characters', async () => {
  const text = await fetchTextPreview('https://x/notes.txt', 5, fakeFetch('hello world'));
  assert.equal(text, 'hello');
});

test('fetchTextPreview: a declared content-length over the 256 KB guard is never fetched fully', async () => {
  const text = await fetchTextPreview('https://x/big.txt', 100, fakeFetch('x'.repeat(10), { headers: { 'content-length': String(300 * 1024) } }));
  assert.equal(text, null);
});

test('fetchTextPreview: a non-ok response returns null', async () => {
  const text = await fetchTextPreview('https://x/missing.txt', 100, fakeFetch('', { ok: false }));
  assert.equal(text, null);
});

test('fetchTextPreview: a thrown fetch error falls back to null instead of throwing', async () => {
  const text = await fetchTextPreview('https://x', 100, async () => {
    throw new Error('network down');
  });
  assert.equal(text, null);
});

test('withTextPreviews: fills previewText on text attachments only, leaves other messages untouched', async () => {
  const messages = [
    { id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] },
    { id: 'm2', attachments: [{ id: 'i1', kind: 'image', name: 'b.png', url: 'https://x/b.png' }] },
  ];
  const result = await withTextPreviews(messages, 20, fakeFetch('line one\nline two'));
  assert.equal(result[0].attachments[0].previewText, 'line one\nline two'.slice(0, 20));
  assert.equal(result[1].attachments[0].previewText, undefined);
  // the input array/objects are never mutated
  assert.equal(messages[0].attachments[0].previewText, undefined);
});

test('withTextPreviews: a fetch failure leaves the attachment without previewText (plain file form fallback)', async () => {
  const messages = [{ id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] }];
  const result = await withTextPreviews(messages, 20, async () => {
    throw new Error('boom');
  });
  assert.equal(result[0].attachments[0].previewText, undefined);
});

test('withTextPreviews: a message with no text attachments is returned as the same reference', async () => {
  const messages = [{ id: 'm1', attachments: [] }];
  const result = await withTextPreviews(messages, 20, fakeFetch(''));
  assert.equal(result[0], messages[0]);
});
