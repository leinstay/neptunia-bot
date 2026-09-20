// Tests for src/discord/collect.js: normalizeMessage's media handling (voice
// flag, embed classification, raw-URL de-duplication, forwarded snapshots)
// and the lazy text-attachment preview fetch. Discord objects are plain
// fixtures shaped just enough for normalizeMessage to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, fetchTextPreview, withTextPreviews, fetchHistory } from '../src/discord/collect.js';
import { MessageReferenceType } from 'discord.js';

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
