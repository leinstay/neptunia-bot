// Tests for src/discord/media.js: pure media classification, label choice,
// media-proxy URL rewriting and vision picture selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAttachment,
  classifyEmbed,
  formatDurationShort,
  mediaProxyUrl,
  mediaLabelFor,
  stickerLabelFor,
  stickerUrl,
  emojiUrl,
  linkThumbnailCacheKey,
  collectPictures,
  collectEmojiItems,
  isDescribable,
  selectPictures,
} from '../src/discord/media.js';

// --- classifyAttachment ------------------------------------------------------

test('classifyAttachment: content types map to their kind', () => {
  assert.equal(classifyAttachment({ contentType: 'image/png', name: 'a.png' }), 'image');
  assert.equal(classifyAttachment({ contentType: 'image/jpeg', name: 'a.jpg' }), 'image');
  assert.equal(classifyAttachment({ contentType: 'image/gif', name: 'a.gif' }), 'gif');
  assert.equal(classifyAttachment({ contentType: 'video/mp4', name: 'a.mp4' }), 'video');
  assert.equal(classifyAttachment({ contentType: 'audio/mpeg', name: 'a.mp3' }), 'audio');
  assert.equal(classifyAttachment({ contentType: 'text/plain', name: 'a.txt' }), 'text');
  assert.equal(classifyAttachment({ contentType: 'application/pdf', name: 'a.pdf' }), 'file');
});

test('classifyAttachment: falls back to the file extension when contentType is missing', () => {
  assert.equal(classifyAttachment({ name: 'clip.gif' }), 'gif');
  assert.equal(classifyAttachment({ name: 'photo.PNG' }), 'image');
  assert.equal(classifyAttachment({ name: 'movie.webm' }), 'video');
  assert.equal(classifyAttachment({ name: 'notes.md' }), 'text');
  assert.equal(classifyAttachment({ name: 'archive.zip' }), 'file');
  assert.equal(classifyAttachment({ name: null }), 'file');
});

test('classifyAttachment: a voice-message flag wins over content type', () => {
  assert.equal(classifyAttachment({ contentType: 'audio/ogg', name: 'voice.ogg', isVoice: true }), 'voice');
});

test('classifyAttachment: no voice flag keeps audio as audio', () => {
  assert.equal(classifyAttachment({ contentType: 'audio/ogg', name: 'voice.ogg', isVoice: false }), 'audio');
});

// --- classifyEmbed -----------------------------------------------------------

test('classifyEmbed: a tenor embed classifies as gif via its provider name', () => {
  const embed = { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' }, title: 'cat', thumbnail: { url: 'https://t.tenor.com/x.png' } };
  const item = classifyEmbed(embed);
  assert.equal(item.kind, 'gif');
  assert.equal(item.site, 'Tenor');
  assert.equal(item.thumbnailUrl, 'https://t.tenor.com/x.png');
});

test('classifyEmbed: a giphy host without a provider name still classifies as gif', () => {
  const embed = { url: 'https://giphy.com/gifs/x', thumbnail: { url: 'https://media.giphy.com/x.gif' } };
  const item = classifyEmbed(embed);
  assert.equal(item.kind, 'gif');
  assert.equal(item.site, 'giphy.com');
});

test('classifyEmbed: a video-site embed keeps kind "link" but carries the thumbnail', () => {
  const embed = {
    url: 'https://www.youtube.com/watch?v=xyz',
    provider: { name: 'YouTube' },
    title: 'Cool video',
    description: 'a description',
    thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg' },
  };
  const item = classifyEmbed(embed);
  assert.equal(item.kind, 'link');
  assert.equal(item.site, 'YouTube');
  assert.equal(item.thumbnailUrl, 'https://i.ytimg.com/vi/xyz/hq.jpg');
});

test('classifyEmbed: falls back to the hostname when there is no provider name', () => {
  const embed = { url: 'https://example.com/article', title: 't' };
  const item = classifyEmbed(embed);
  assert.equal(item.site, 'example.com');
  assert.equal(item.kind, 'link');
});

test('classifyEmbed: title/description are truncated to embedTextChars', () => {
  const embed = { url: 'https://example.com', title: 'x'.repeat(50), description: 'y'.repeat(50) };
  const item = classifyEmbed(embed, { embedTextChars: 10 });
  assert.equal(item.title, `${'x'.repeat(10)}…`);
  assert.equal(item.text, `${'y'.repeat(10)}…`);
});

// --- formatDurationShort ------------------------------------------------------

test('formatDurationShort: renders m:ss, zero-padded seconds', () => {
  assert.equal(formatDurationShort(5), '0:05');
  assert.equal(formatDurationShort(65), '1:05');
  assert.equal(formatDurationShort(600), '10:00');
});

test('formatDurationShort: negative/garbage input never goes negative', () => {
  assert.equal(formatDurationShort(-5), '0:00');
  assert.equal(formatDurationShort(NaN), '0:00');
  assert.equal(formatDurationShort(undefined), '0:00');
});

// --- mediaProxyUrl -------------------------------------------------------------

// cdn.discordapp.com measurably ignores width/height/format and serves the
// original file (a full-size image, or for a video the whole file) --
// media.discordapp.net is the host that actually resizes/reformats. A
// realistic signed URL (ex/is/hm) is used throughout so the fix is proven
// against the real shape, not a simplified fixture.
const SIGNED_QUERY = 'ex=671f1a00&is=671dc880&hm=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890&';

test('mediaProxyUrl: a cdn.discordapp.com attachment URL is rewritten to media.discordapp.net, signed params survive', () => {
  const url = mediaProxyUrl(`https://cdn.discordapp.com/attachments/111/222/pic.png?${SIGNED_QUERY}`, {
    width: 512,
    height: 512,
    format: 'webp',
  });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'media.discordapp.net');
  assert.equal(parsed.pathname, '/attachments/111/222/pic.png');
  assert.equal(parsed.searchParams.get('width'), '512');
  assert.equal(parsed.searchParams.get('height'), '512');
  assert.equal(parsed.searchParams.get('format'), 'webp');
  assert.equal(parsed.searchParams.get('ex'), '671f1a00');
  assert.equal(parsed.searchParams.get('is'), '671dc880');
  assert.equal(parsed.searchParams.get('hm'), 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
});

test('mediaProxyUrl: a video attachment URL also moves to media.discordapp.net -- never left on cdn.discordapp.com, which would return the whole file', () => {
  const url = mediaProxyUrl(`https://cdn.discordapp.com/attachments/111/222/clip.mp4?${SIGNED_QUERY}`, { format: 'webp' });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'media.discordapp.net');
  assert.equal(parsed.searchParams.get('format'), 'webp');
  assert.equal(parsed.searchParams.get('hm')?.length, 64, 'the signed hm survives the host swap');
});

test('mediaProxyUrl: an already-media.discordapp.net URL keeps that host, params still set', () => {
  const url = mediaProxyUrl(`https://media.discordapp.net/attachments/1/2/pic.png?${SIGNED_QUERY}`, { width: 256 });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'media.discordapp.net');
  assert.equal(parsed.searchParams.get('width'), '256');
  assert.equal(parsed.searchParams.get('ex'), '671f1a00');
});

test('mediaProxyUrl: replaces existing width/height/format instead of duplicating them, on either host', () => {
  const url = mediaProxyUrl(`https://cdn.discordapp.com/x/pic.png?width=100&height=100&format=jpeg&${SIGNED_QUERY}`, {
    width: 512,
    height: 512,
    format: 'webp',
  });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'media.discordapp.net');
  assert.equal(parsed.searchParams.get('width'), '512');
  assert.equal(parsed.searchParams.get('height'), '512');
  assert.equal(parsed.searchParams.get('format'), 'webp');
  assert.equal(parsed.searchParams.get('ex'), '671f1a00', 'unrelated existing query params survive');
  assert.equal([...parsed.searchParams.keys()].filter((k) => k === 'width').length, 1, 'no duplicate keys');
});

test('mediaProxyUrl: a non-Discord host is returned untouched', () => {
  const url = 'https://example.com/pic.png?foo=bar';
  assert.equal(mediaProxyUrl(url, { width: 512, height: 512, format: 'webp' }), url);
});

test('mediaProxyUrl: an unparsable URL is returned as-is instead of throwing', () => {
  assert.equal(mediaProxyUrl('not a url', { width: 10 }), 'not a url');
});

// --- mediaLabelFor -------------------------------------------------------------

test('mediaLabelFor: an attached plain image renders imageAttached with its 1-based index', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { attachedIndex: 1 }), { key: 'imageAttached', values: { n: 1 } });
});

test('mediaLabelFor: an attached video/gif still frame keeps its normal (blind) form, plus an extra frameAttached tag', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'cat.gif' }, { attachedIndex: 2 }), {
    key: 'gif',
    values: { name: 'cat.gif' },
    extra: { key: 'frameAttached', values: { n: 2 } },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4', durationSec: 65 }, { attachedIndex: 3 }), {
    key: 'video',
    values: { name: 'clip.mp4', duration: '1:05' },
    extra: { key: 'frameAttached', values: { n: 3 } },
  });
});

test('mediaLabelFor: an attached video/gif still frame with a description uses the described form, plus frameAttached', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'gif' }, { attachedIndex: 1, description: 'a cat dances' }), {
    key: 'gifDescribed',
    values: { text: 'a cat dances' },
    extra: { key: 'frameAttached', values: { n: 1 } },
  });
  assert.deepEqual(
    mediaLabelFor({ kind: 'video', name: 'clip.mp4', durationSec: 65 }, { attachedIndex: 1, description: 'a dog runs' }),
    {
      key: 'videoDescribed',
      values: { name: 'clip.mp4', duration: '1:05', text: 'a dog runs' },
      extra: { key: 'frameAttached', values: { n: 1 } },
    },
  );
});

test('mediaLabelFor: an attached link-embed thumbnail keeps the link tag and adds frameAttached (never bare imageAttached)', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item, { attachedIndex: 1 }), {
    key: 'link',
    values: { site: 's', title: 't' },
    extra: { key: 'frameAttached', values: { n: 1 } },
  });
});

test('mediaLabelFor: an attached link-embed thumbnail with a description still prefers frameAttached over thumbnailDescribed', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  const result = mediaLabelFor(item, { attachedIndex: 1, description: 'a video preview' });
  assert.equal(result.extra.key, 'frameAttached');
});

test('mediaLabelFor: a link without a thumbnail is never attachable, even with an index passed by mistake', () => {
  const item = { kind: 'link', site: 's', title: 't' };
  const result = mediaLabelFor(item, { attachedIndex: 1 });
  assert.notEqual(result.key, 'imageAttached');
  assert.equal(result.extra, undefined);
});

test('mediaLabelFor: a link thumbnail description appends thumbnailDescribed, the link tag itself never swaps', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item, { description: 'a video preview' }), {
    key: 'link',
    values: { site: 's', title: 't' },
    extra: { key: 'thumbnailDescribed', values: { text: 'a video preview' } },
  });
});

test('mediaLabelFor: a link thumbnail with no description and no attachment renders the plain link tag, no extra', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item), { key: 'link', values: { site: 's', title: 't' } });
});

test('mediaLabelFor: image blind vs described', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'image' }), { key: 'image', values: {} });
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { description: 'a cat' }), { key: 'imageDescribed', values: { text: 'a cat' } });
});

test('mediaLabelFor: gif blind uses the name, described uses only the text', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'cat.gif' }), { key: 'gif', values: { name: 'cat.gif' } });
  assert.deepEqual(mediaLabelFor({ kind: 'gif' }, { description: 'a cat dancing' }), {
    key: 'gifDescribed',
    values: { text: 'a cat dancing' },
  });
});

test('mediaLabelFor: video blind/described carry name + duration, described adds text', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4', durationSec: 65 }), {
    key: 'video',
    values: { name: 'clip.mp4', duration: '1:05' },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4', durationSec: 65 }, { description: 'a dog runs' }), {
    key: 'videoDescribed',
    values: { name: 'clip.mp4', duration: '1:05', text: 'a dog runs' },
  });
});

test('mediaLabelFor: voice/audio render their duration', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'voice', durationSec: 5 }), { key: 'voice', values: { duration: '0:05' } });
  assert.deepEqual(mediaLabelFor({ kind: 'audio', name: 'song.mp3', durationSec: 130 }), {
    key: 'audio',
    values: { name: 'song.mp3', duration: '2:10' },
  });
});

test('mediaLabelFor: a missing duration never renders "0:00" -- falls back to unknownDuration (default "?")', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4' }), { key: 'video', values: { name: 'clip.mp4', duration: '?' } });
  assert.deepEqual(mediaLabelFor({ kind: 'voice' }), { key: 'voice', values: { duration: '?' } });
  assert.deepEqual(mediaLabelFor({ kind: 'audio', name: 'song.mp3' }), { key: 'audio', values: { name: 'song.mp3', duration: '?' } });
});

test('mediaLabelFor: a missing duration uses the caller-supplied unknownDuration text', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4' }, { unknownDuration: 'unknown length' }), {
    key: 'video',
    values: { name: 'clip.mp4', duration: 'unknown length' },
  });
});

test('mediaLabelFor: a durationSec of 0 is a KNOWN zero-length duration, not "unknown"', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'voice', durationSec: 0 }), { key: 'voice', values: { duration: '0:00' } });
});

test('mediaLabelFor: a text attachment uses filePreview once fetched, else the plain file form', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'text', name: 'notes.txt' }), { key: 'file', values: { name: 'notes.txt' } });
  assert.deepEqual(mediaLabelFor({ kind: 'text', name: 'notes.txt', previewText: 'hello world' }), {
    key: 'filePreview',
    values: { name: 'notes.txt', text: 'hello world' },
  });
});

test('mediaLabelFor: a plain file renders the file form', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'file', name: 'archive.zip' }), { key: 'file', values: { name: 'archive.zip' } });
});

test('mediaLabelFor: a link with description text uses linkText, else link', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'link', site: 's', title: 't' }), { key: 'link', values: { site: 's', title: 't' } });
  assert.deepEqual(mediaLabelFor({ kind: 'link', site: 's', title: 't', text: 'd' }), {
    key: 'linkText',
    values: { site: 's', title: 't', text: 'd' },
  });
});

// --- collectPictures / isDescribable -------------------------------------------

function message(id, overrides = {}) {
  return { id, ts: 0, attachments: [], links: [], ...overrides };
}

test('collectPictures: picks image/gif/video attachments, skips audio/voice/text/file', () => {
  const m = message('m1', {
    attachments: [
      { id: 'a1', kind: 'image', url: 'u1', name: 'a.png' },
      { id: 'a2', kind: 'gif', url: 'u2', name: 'a.gif' },
      { id: 'a3', kind: 'video', url: 'u3', name: 'a.mp4', durationSec: 5 },
      { id: 'a4', kind: 'audio', url: 'u4', name: 'a.mp3' },
      { id: 'a5', kind: 'file', url: 'u5', name: 'a.zip' },
    ],
  });
  const pictures = collectPictures(m);
  assert.deepEqual(pictures.map((p) => p.itemId), ['a1', 'a2', 'a3']);
  assert.equal(pictures[2].durationSec, 5);
});

test('collectPictures: includes any embed with a thumbnail, gif or link kind alike', () => {
  const m = message('m1', {
    links: [
      { id: 'm1#e0', kind: 'gif', thumbnailUrl: 'https://t/x.png', title: 'cat', site: 'Tenor' },
      { id: 'm1#e1', kind: 'link', thumbnailUrl: 'https://y/thumb.jpg', title: 'video', site: 'YouTube' },
      { id: 'm1#e2', kind: 'link', thumbnailUrl: null, title: 'no thumb', site: 'example.com' },
    ],
  });
  const pictures = collectPictures(m);
  assert.deepEqual(pictures.map((p) => p.itemId), ['m1#e0', 'm1#e1']);
});

test('isDescribable: true for image/gif/video/sticker/emoji/link (a link thumbnail is describable)', () => {
  assert.equal(isDescribable({ kind: 'image' }), true);
  assert.equal(isDescribable({ kind: 'gif' }), true);
  assert.equal(isDescribable({ kind: 'video' }), true);
  assert.equal(isDescribable({ kind: 'sticker' }), true);
  assert.equal(isDescribable({ kind: 'emoji' }), true);
  assert.equal(isDescribable({ kind: 'link', thumbnailUrl: 'x' }), true);
  assert.equal(isDescribable({ kind: 'audio' }), false);
  assert.equal(isDescribable({ kind: 'voice' }), false);
  assert.equal(isDescribable({ kind: 'text' }), false);
  assert.equal(isDescribable({ kind: 'file' }), false);
});

// --- selectPictures -------------------------------------------------------------

const MIN = 60_000;

function pictureMessage(id, ts, itemId) {
  return message(id, { ts, attachments: [{ id: itemId, kind: 'image', url: `url-${itemId}`, name: `${itemId}.png` }] });
}

test('selectPictures: vision off (maxImages 0) selects nothing', () => {
  const now = 1_000_000;
  const trigger = pictureMessage('t', now, 'trig');
  const picked = selectPictures({ trigger, history: [trigger], visionCfg: { maxImages: 0, recentImages: 3, recentImageMinutes: 30 }, now });
  assert.deepEqual(picked, []);
});

test('selectPictures: trigger pictures come first', () => {
  const now = 1_000_000;
  const trigger = pictureMessage('t', now, 'trig');
  const picked = selectPictures({
    trigger,
    history: [trigger],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked.map((p) => p.itemId), ['trig']);
});

test('selectPictures: replied-to message pictures come after the trigger\'s own', () => {
  const now = 1_000_000;
  const replied = pictureMessage('r', now - 5 * MIN, 'replied');
  const trigger = { ...pictureMessage('t', now, 'trig'), replyToId: 'r' };
  const picked = selectPictures({
    trigger,
    history: [replied, trigger],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked.map((p) => p.itemId), ['replied', 'trig']);
});

test('selectPictures: recent channel pictures fill up to recentImages, newest first, then re-sorted to transcript order', () => {
  const now = 1_000_000;
  const m1 = pictureMessage('m1', now - 20 * MIN, 'p1');
  const m2 = pictureMessage('m2', now - 10 * MIN, 'p2');
  const m3 = pictureMessage('m3', now - 5 * MIN, 'p3');
  const picked = selectPictures({
    trigger: null,
    history: [m1, m2, m3],
    visionCfg: { maxImages: 4, recentImages: 2, recentImageMinutes: 30 },
    now,
  });
  // p1 is the oldest, dropped because recentImages caps at 2; p2/p3 kept, in transcript (chronological) order.
  assert.deepEqual(picked.map((p) => p.itemId), ['p2', 'p3']);
});

test('selectPictures: recent pictures older than recentImageMinutes are excluded', () => {
  const now = 1_000_000;
  const old = pictureMessage('old', now - 40 * MIN, 'old-pic');
  const recent = pictureMessage('recent', now - 5 * MIN, 'recent-pic');
  const picked = selectPictures({
    trigger: null,
    history: [old, recent],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked.map((p) => p.itemId), ['recent-pic']);
});

test('selectPictures: a spontaneous turn (no trigger) only ever picks from the recent tier', () => {
  const now = 1_000_000;
  const recent = pictureMessage('m1', now - 1 * MIN, 'p1');
  const picked = selectPictures({
    trigger: null,
    history: [recent],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked.map((p) => p.itemId), ['p1']);
});

test('selectPictures: the overall maxImages cap wins even when more would qualify', () => {
  const now = 1_000_000;
  const trigger = message('t', {
    ts: now,
    attachments: [
      { id: 'a', kind: 'image', url: 'ua', name: 'a.png' },
      { id: 'b', kind: 'image', url: 'ub', name: 'b.png' },
      { id: 'c', kind: 'image', url: 'uc', name: 'c.png' },
    ],
  });
  const picked = selectPictures({
    trigger,
    history: [trigger],
    visionCfg: { maxImages: 2, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.equal(picked.length, 2);
});

test('selectPictures: never picks the same item twice across tiers', () => {
  const now = 1_000_000;
  const trigger = pictureMessage('t', now, 'shared');
  trigger.replyToId = 't'; // pathological but must not double-count
  const picked = selectPictures({
    trigger,
    history: [trigger],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked.map((p) => p.itemId), ['shared']);
});

// --- stickerUrl / emojiUrl / linkThumbnailCacheKey ------------------------

test('stickerUrl: PNG and APNG sizes to media.discordapp.net/.../<id>.png?size=160', () => {
  assert.equal(stickerUrl('123', 1), 'https://media.discordapp.net/stickers/123.png?size=160');
  assert.equal(stickerUrl('123', 2), 'https://media.discordapp.net/stickers/123.png?size=160');
});

test('stickerUrl: GIF sizes to media.discordapp.net/.../<id>.gif?size=160, never cdn.discordapp.com', () => {
  const url = stickerUrl('123', 4);
  assert.equal(url, 'https://media.discordapp.net/stickers/123.gif?size=160');
  assert.ok(!url.includes('cdn.discordapp.com'));
});

test('stickerUrl: Lottie (format 3) is never a picture -- null', () => {
  assert.equal(stickerUrl('123', 3), null);
});

test('stickerUrl: an unknown/missing format is never a picture -- null', () => {
  assert.equal(stickerUrl('123', undefined), null);
  assert.equal(stickerUrl('123', 99), null);
});

test('emojiUrl: cdn.discordapp.com/emojis/<id>.webp?size=96, same for static and animated', () => {
  assert.equal(emojiUrl('456'), 'https://cdn.discordapp.com/emojis/456.webp?size=96');
});

test('linkThumbnailCacheKey: stable across different signed query strings for the same picture', () => {
  const a = linkThumbnailCacheKey('https://i.ytimg.com/vi/xyz/hq.jpg?ex=1&is=2&hm=abc');
  const b = linkThumbnailCacheKey('https://i.ytimg.com/vi/xyz/hq.jpg?ex=9&is=8&hm=zzz');
  assert.equal(a, b);
  assert.ok(a.startsWith('link:'));
});

test('linkThumbnailCacheKey: a different path hashes to a different key', () => {
  const a = linkThumbnailCacheKey('https://i.ytimg.com/vi/xyz/hq.jpg');
  const b = linkThumbnailCacheKey('https://i.ytimg.com/vi/other/hq.jpg');
  assert.notEqual(a, b);
});

test('linkThumbnailCacheKey: an unparsable URL never throws, still deterministic', () => {
  assert.equal(linkThumbnailCacheKey('not a url'), linkThumbnailCacheKey('not a url'));
});

// --- stickerLabelFor -------------------------------------------------------------

function sticker(name, url) {
  return { name, url };
}

test('stickerLabelFor: a Lottie sticker (url null) is always the plain name form, ignoring attached/description', () => {
  assert.deepEqual(stickerLabelFor(sticker('dancing-cat', null)), { key: 'sticker', values: { name: 'dancing-cat' } });
  assert.deepEqual(stickerLabelFor(sticker('dancing-cat', null), { attachedIndex: 1, description: 'a cat dances' }), {
    key: 'sticker',
    values: { name: 'dancing-cat' },
  });
});

test('stickerLabelFor: a picture-format sticker blind vs described', () => {
  assert.deepEqual(stickerLabelFor(sticker('pepe', 'https://x')), { key: 'sticker', values: { name: 'pepe' } });
  assert.deepEqual(stickerLabelFor(sticker('pepe', 'https://x'), { description: 'a frog gives a thumbs up' }), {
    key: 'stickerDescribed',
    values: { name: 'pepe', text: 'a frog gives a thumbs up' },
  });
});

test('stickerLabelFor: attached wins over described, keeps the sticker tag and adds frameAttached', () => {
  const result = stickerLabelFor(sticker('pepe', 'https://x'), { attachedIndex: 2, description: 'a frog gives a thumbs up' });
  assert.deepEqual(result, {
    key: 'stickerDescribed',
    values: { name: 'pepe', text: 'a frog gives a thumbs up' },
    extra: { key: 'frameAttached', values: { n: 2 } },
  });
});

test('stickerLabelFor: attached with no description keeps the blind sticker tag plus frameAttached', () => {
  assert.deepEqual(stickerLabelFor(sticker('pepe', 'https://x'), { attachedIndex: 1 }), {
    key: 'sticker',
    values: { name: 'pepe' },
    extra: { key: 'frameAttached', values: { n: 1 } },
  });
});

// --- collectPictures / collectEmojiItems: stickers and emoji --------------

function stickerMessage(id, ts, stickers) {
  return message(id, { ts, stickers });
}

test('collectPictures: a picture-format sticker is included, a Lottie one is not', () => {
  const m = stickerMessage('m1', 0, [
    { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
    { id: 's2', name: 'dance', format: 3, url: null },
  ]);
  const pictures = collectPictures(m);
  assert.deepEqual(pictures.map((p) => p.itemId), ['sticker:s1']);
  assert.equal(pictures[0].kind, 'sticker');
  assert.equal(pictures[0].source, 'sticker');
});

test('collectEmojiItems: every distinct emoji of a message becomes a describable, never-a-picture item', () => {
  const m = message('m1', {
    emojis: [
      { id: 'e1', name: 'pog', animated: false, url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' },
      { id: 'e2', name: 'kekw', animated: true, url: 'https://cdn.discordapp.com/emojis/e2.webp?size=96' },
    ],
  });
  const items = collectEmojiItems(m);
  assert.deepEqual(items.map((i) => i.itemId), ['emoji:e1', 'emoji:e2']);
  assert.ok(items.every((i) => i.source === 'emoji' && isDescribable(i)));
  // Never eligible for vision: collectPictures ignores message.emojis entirely.
  assert.deepEqual(collectPictures(m).map((p) => p.itemId), []);
});

// --- selectPictures: sticker vision eligibility ---------------------------

test('selectPictures: the trigger\'s own picture-format sticker is eligible, same priority as its images', () => {
  const now = 1_000_000;
  const trigger = stickerMessage('t', now, [
    { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
  ]);
  const picked = selectPictures({ trigger, history: [trigger], visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 }, now });
  assert.deepEqual(picked.map((p) => p.itemId), ['sticker:s1']);
});

test('selectPictures: a Lottie sticker on the trigger is never vision-eligible (no url to attach)', () => {
  const now = 1_000_000;
  const trigger = stickerMessage('t', now, [{ id: 's1', name: 'dance', format: 3, url: null }]);
  const picked = selectPictures({ trigger, history: [trigger], visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 }, now });
  assert.deepEqual(picked, []);
});

test('selectPictures: a sticker on the REPLIED-TO message is never vision-eligible, only the trigger\'s own', () => {
  const now = 1_000_000;
  const replied = stickerMessage('r', now - 5 * MIN, [
    { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
  ]);
  const trigger = { ...message('t', { ts: now }), replyToId: 'r' };
  const picked = selectPictures({
    trigger,
    history: [replied, trigger],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked, []);
});

test('selectPictures: a sticker in the "recent" tier is never vision-eligible, even with room to spare', () => {
  const now = 1_000_000;
  const recent = stickerMessage('m1', now - MIN, [
    { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
  ]);
  const picked = selectPictures({
    trigger: null,
    history: [recent],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked, []);
});
