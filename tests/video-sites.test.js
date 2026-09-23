// Tests for src/discord/video-sites.js: site matching, URL extraction, the
// stable cache key, the yt-dlp / ffmpeg argument arrays, probe parsing and
// the query-free log location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  videoSiteFor,
  extractVideoUrls,
  videoUrlCacheKey,
  isDirectUrlSite,
  ytdlpProbeArgs,
  ytdlpClipArgs,
  ffmpegTrimArgs,
  parseProbe,
  safeLocation,
} from '../src/discord/video-sites.js';

const SITES = ['youtube.com', 'youtu.be', 'tiktok.com', 'vk.com', 'vkvideo.ru', 'x.com', 'twitter.com', 'reddit.com', 'twitch.tv'];
const DIRECT = ['youtube.com', 'youtu.be'];

test('videoSiteFor: matches the exact host and any subdomain, case-insensitive', () => {
  assert.equal(videoSiteFor('https://youtube.com/watch?v=abc', SITES), 'youtube.com');
  assert.equal(videoSiteFor('https://www.youtube.com/watch?v=abc', SITES), 'youtube.com');
  assert.equal(videoSiteFor('https://M.YouTube.COM/watch?v=abc', SITES), 'youtube.com');
  assert.equal(videoSiteFor('https://youtu.be/abc', SITES), 'youtu.be');
  assert.equal(videoSiteFor('https://vm.tiktok.com/xyz', SITES), 'tiktok.com');
});

test('videoSiteFor: a look-alike host, an unknown host or an unparsable URL gives null', () => {
  assert.equal(videoSiteFor('https://notyoutube.com/watch?v=abc', SITES), null);
  assert.equal(videoSiteFor('https://youtube.com.evil.example/watch', SITES), null);
  assert.equal(videoSiteFor('https://example.com/video.mp4', SITES), null);
  assert.equal(videoSiteFor('not a url', SITES), null);
  assert.equal(videoSiteFor(undefined, SITES), null);
  assert.equal(videoSiteFor('https://youtube.com/x', undefined), null);
});

test('isDirectUrlSite: same matching rule as videoSiteFor', () => {
  assert.equal(isDirectUrlSite('https://www.youtube.com/watch?v=abc', DIRECT), true);
  assert.equal(isDirectUrlSite('https://youtu.be/abc', DIRECT), true);
  assert.equal(isDirectUrlSite('https://www.tiktok.com/@a/video/1', DIRECT), false);
  assert.equal(isDirectUrlSite('garbage', DIRECT), false);
});

test('extractVideoUrls: finds matching http(s) URLs in order, distinct, trailing punctuation stripped', () => {
  const text = 'régarde (https://youtu.be/abc). et https://www.tiktok.com/@a/video/1, puis <https://x.com/u/status/9> '
    + 'aussi https://example.com/v.mp4 et encore https://youtu.be/abc';
  assert.deepEqual(extractVideoUrls(text, SITES), [
    'https://youtu.be/abc',
    'https://www.tiktok.com/@a/video/1',
    'https://x.com/u/status/9',
  ]);
});

test('extractVideoUrls: empty or non-string text gives an empty array; non-http schemes are ignored', () => {
  assert.deepEqual(extractVideoUrls('', SITES), []);
  assert.deepEqual(extractVideoUrls(undefined, SITES), []);
  assert.deepEqual(extractVideoUrls('ftp://youtube.com/x και τίποτα άλλο', SITES), []);
});

test('videoUrlCacheKey: stable across www./m., host case and tracking params; keeps only v', () => {
  const a = videoUrlCacheKey('https://www.youtube.com/watch?v=abc123&t=42&list=PL1&si=zzz');
  const b = videoUrlCacheKey('https://m.YouTube.com/watch?si=other&v=abc123');
  const c = videoUrlCacheKey('https://youtube.com/watch?v=abc123');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /^video:url:[0-9a-f]{16}$/);
});

test('videoUrlCacheKey: a different video id or path gives a different key', () => {
  assert.notEqual(videoUrlCacheKey('https://youtube.com/watch?v=abc'), videoUrlCacheKey('https://youtube.com/watch?v=abd'));
  assert.notEqual(videoUrlCacheKey('https://youtu.be/abc'), videoUrlCacheKey('https://youtu.be/abd'));
  assert.equal(videoUrlCacheKey('https://youtu.be/abc?si=1'), videoUrlCacheKey('https://www.youtu.be/abc?utm_source=x'));
});

test('videoUrlCacheKey: every YouTube form of one video maps to the canonical watch?v= key', () => {
  const canonical = videoUrlCacheKey('https://youtube.com/watch?v=abc123');
  for (const url of [
    'https://youtu.be/abc123',
    'https://youtu.be/abc123?si=tracking&t=10',
    'https://www.youtube.com/watch?v=abc123&feature=share',
    'https://m.youtube.com/watch?v=abc123',
    'https://youtube.com/shorts/abc123',
    'https://www.youtube.com/shorts/abc123?si=x',
    'https://m.youtube.com/shorts/abc123',
    'https://www.youtube.com/embed/abc123',
    'https://youtube.com/embed/abc123?start=5',
    'https://www.youtube.com/live/abc123',
    'https://m.youtube.com/live/abc123?si=y',
  ]) {
    assert.equal(videoUrlCacheKey(url), canonical, url);
  }
  assert.notEqual(videoUrlCacheKey('https://youtube.com/shorts/abc124'), canonical);
});

test('videoUrlCacheKey: TikTok short links keep their own key (no id to extract)', () => {
  const vm = videoUrlCacheKey('https://vm.tiktok.com/ZMabc/');
  const vt = videoUrlCacheKey('https://vt.tiktok.com/ZMabc/');
  assert.match(vm, /^video:url:[0-9a-f]{16}$/);
  assert.notEqual(vm, vt);
  assert.notEqual(vm, videoUrlCacheKey('https://www.tiktok.com/@a/video/1'));
  assert.equal(vm, videoUrlCacheKey('https://vm.tiktok.com/ZMabc/?utm=x'));
});

test('videoUrlCacheKey: an unparsable URL still yields a well-formed key', () => {
  assert.match(videoUrlCacheKey('not a url'), /^video:url:[0-9a-f]{16}$/);
});

test('ytdlpProbeArgs: metadata-only arguments', () => {
  assert.deepEqual(ytdlpProbeArgs('https://youtu.be/abc', { ytdlpPath: 'yt-dlp' }), {
    command: 'yt-dlp',
    args: ['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', '--quiet', '--', 'https://youtu.be/abc'],
  });
});

test('ytdlpClipArgs: clip download arguments, one element per token', () => {
  const out = ytdlpClipArgs('https://youtu.be/abc', {
    ytdlpPath: '/opt/yt-dlp', ffmpegPath: '/usr/bin/ffmpeg', maxSeconds: 60, maxBytes: 8_000_000, outPath: '/tmp/d/clip.mp4',
  });
  assert.deepEqual(out, {
    command: '/opt/yt-dlp',
    args: [
      '--no-playlist', '--no-warnings', '--quiet',
      '--ffmpeg-location', '/usr/bin/ffmpeg',
      '-f', 'bv*[height<=360]+ba/b[height<=360]/w',
      '--merge-output-format', 'mp4',
      '--download-sections', '*0-60',
      '--force-keyframes-at-cuts',
      '--max-filesize', '8000000',
      '-o', '/tmp/d/clip.mp4',
      '--',
      'https://youtu.be/abc',
    ],
  });
});

test('ffmpegTrimArgs: trim and re-encode arguments', () => {
  assert.deepEqual(ffmpegTrimArgs('/tmp/in.webm', '/tmp/out.mp4', { ffmpegPath: 'ffmpeg', maxSeconds: 60 }), {
    command: 'ffmpeg',
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', '/tmp/in.webm',
      '-t', '60',
      '-vf', 'scale=-2:360',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      '/tmp/out.mp4',
    ],
  });
});

test('parseProbe: reads duration and title; tolerates missing fields and bad JSON', () => {
  assert.deepEqual(parseProbe(JSON.stringify({ duration: 42.5, title: 'Ἀρχή καὶ τέλος' })), { durationSec: 42.5, title: 'Ἀρχή καὶ τέλος' });
  assert.deepEqual(parseProbe(JSON.stringify({ id: 'x' })), { durationSec: null, title: null });
  assert.deepEqual(parseProbe(JSON.stringify({ duration: 'long', title: 7 })), { durationSec: null, title: null });
  assert.deepEqual(parseProbe('{not json'), { durationSec: null, title: null });
  assert.deepEqual(parseProbe('null'), { durationSec: null, title: null });
  assert.deepEqual(parseProbe(undefined), { durationSec: null, title: null });
});

test('safeLocation: host and path only, never the query string', () => {
  assert.equal(safeLocation('https://www.youtube.com/watch?v=abc&token=secret'), 'www.youtube.com/watch');
  assert.equal(safeLocation('nonsense'), '(unparsable url)');
});
