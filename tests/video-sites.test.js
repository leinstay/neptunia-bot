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
  youtubeVideoId,
  parseYoutubePageDuration,
  parseIsoDuration,
  youtubeDataApiUrl,
  parseYoutubeDataApi,
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

const CLIP = { ytdlpPath: '/opt/yt-dlp', maxSeconds: 60, maxBytes: 8_000_000, outPath: '/tmp/d/clip.mp4' };

test('ytdlpClipArgs: a long or unknown video is cut to its first maxSeconds, one element per token', () => {
  const out = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: '/usr/bin/ffmpeg', durationSec: 125 });
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

test('ytdlpClipArgs: a null or missing duration keeps the cut', () => {
  for (const durationSec of [null, undefined, Number.NaN]) {
    const { args } = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: '/usr/bin/ffmpeg', durationSec });
    assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
    assert.ok(args.includes('--force-keyframes-at-cuts'));
  }
});

test('ytdlpClipArgs: a video no longer than maxSeconds is downloaded whole, without a cut', () => {
  for (const durationSec of [14, 60]) {
    const out = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: '/usr/bin/ffmpeg', durationSec });
    assert.deepEqual(out, {
      command: '/opt/yt-dlp',
      args: [
        '--no-playlist', '--no-warnings', '--quiet',
        '--ffmpeg-location', '/usr/bin/ffmpeg',
        '-f', 'bv*[height<=360]+ba/b[height<=360]/w',
        '--merge-output-format', 'mp4',
        '--max-filesize', '8000000',
        '-o', '/tmp/d/clip.mp4',
        '--',
        'https://youtu.be/abc',
      ],
    });
  }
});

test('ytdlpClipArgs: a bare ffmpeg name omits --ffmpeg-location so yt-dlp searches PATH', () => {
  const { args } = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: 'ffmpeg', durationSec: null });
  assert.equal(args.includes('--ffmpeg-location'), false);
  assert.equal(args.includes('ffmpeg'), false);
  assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
  const short = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: 'ffmpeg', durationSec: 14 }).args;
  assert.deepEqual(short, [
    '--no-playlist', '--no-warnings', '--quiet',
    '-f', 'bv*[height<=360]+ba/b[height<=360]/w',
    '--merge-output-format', 'mp4',
    '--max-filesize', '8000000',
    '-o', '/tmp/d/clip.mp4',
    '--',
    'https://youtu.be/abc',
  ]);
});

test('ytdlpClipArgs: a path with either separator is passed as --ffmpeg-location', () => {
  for (const ffmpegPath of ['/usr/local/bin/ffmpeg', 'C:\\tools\\ffmpeg.exe', './bin/ffmpeg']) {
    const { args } = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath, durationSec: null });
    assert.equal(args[args.indexOf('--ffmpeg-location') + 1], ffmpegPath);
  }
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

// --- YouTube duration without yt-dlp ---------------------------------------

test('youtubeVideoId: every YouTube form canonicalised by the cache key gives the id', () => {
  for (const url of [
    'https://youtu.be/dQw4w9WgXcQ?si=track',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ]) {
    assert.equal(youtubeVideoId(url), 'dQw4w9WgXcQ', url);
  }
});

test('youtubeVideoId: a non-YouTube URL, a YouTube page without an id or garbage gives null', () => {
  assert.equal(youtubeVideoId('https://www.tiktok.com/@someone/video/123'), null);
  assert.equal(youtubeVideoId('https://notyoutube.com/watch?v=abc'), null);
  assert.equal(youtubeVideoId('https://www.youtube.com/@channel'), null);
  assert.equal(youtubeVideoId('https://www.youtube.com/watch'), null);
  assert.equal(youtubeVideoId('not a url'), null);
  assert.equal(youtubeVideoId(undefined), null);
});

test('parseIsoDuration: hours, minutes and seconds in any combination', () => {
  assert.equal(parseIsoDuration('PT3M34S'), 214);
  assert.equal(parseIsoDuration('PT1H'), 3600);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT10M'), 600);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration('PT1.5S'), 2, 'fractional seconds round up');
  assert.equal(parseIsoDuration('P0D'), 0);
});

test('parseIsoDuration: garbage gives null', () => {
  for (const text of ['', 'PT', 'P', '3M34S', 'PT3X', 'PTMS', 'pt3m', 'PT3M34S extra', null, undefined, 214]) {
    assert.equal(parseIsoDuration(text), null, JSON.stringify(text));
  }
});

test('parseYoutubePageDuration: lengthSeconds first', () => {
  const html = '<script>var x = {"videoDetails":{"videoId":"abc","lengthSeconds":"214","approxDurationMs":"999000"}};</script>';
  assert.equal(parseYoutubePageDuration(html), 214);
});

test('parseYoutubePageDuration: approxDurationMs when lengthSeconds is absent, rounded up to whole seconds', () => {
  assert.equal(parseYoutubePageDuration('{"approxDurationMs":"213401","mimeType":"video/mp4"}'), 214);
  assert.equal(parseYoutubePageDuration('{"approxDurationMs":"214000"}'), 214);
});

test('parseYoutubePageDuration: the itemprop duration meta tag as the last resort', () => {
  const html = '<meta itemprop="name" content="Ἡ θάλασσα"><meta itemprop="duration" content="PT3M34S">';
  assert.equal(parseYoutubePageDuration(html), 214);
});

test('parseYoutubePageDuration: nothing usable gives null; a zero length (a live stream) is not a duration', () => {
  assert.equal(parseYoutubePageDuration('<html><body>Before you continue</body></html>'), null);
  assert.equal(parseYoutubePageDuration(''), null);
  assert.equal(parseYoutubePageDuration(undefined), null);
  assert.equal(parseYoutubePageDuration('{"lengthSeconds":"0"}'), null);
  assert.equal(parseYoutubePageDuration('{"lengthSeconds":"0","approxDurationMs":"61000"}'), 61);
  assert.equal(parseYoutubePageDuration('<meta itemprop="duration" content="PT0S">'), null);
  assert.equal(parseYoutubePageDuration('<meta itemprop="duration" content="garbage">'), null);
});

test('youtubeDataApiUrl: the videos endpoint with contentDetails, the id and the key', () => {
  assert.equal(
    youtubeDataApiUrl('dQw4w9WgXcQ', 'AIzaTestKey_1-2'),
    'https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=dQw4w9WgXcQ&key=AIzaTestKey_1-2',
  );
});

test('parseYoutubeDataApi: the first item contentDetails.duration in seconds', () => {
  const json = JSON.stringify({ kind: 'youtube#videoListResponse', items: [{ id: 'abc', contentDetails: { duration: 'PT3M34S' } }] });
  assert.equal(parseYoutubeDataApi(json), 214);
});

test('parseYoutubeDataApi: no items, a bad duration, a live P0D or invalid JSON gives null', () => {
  assert.equal(parseYoutubeDataApi(JSON.stringify({ items: [] })), null);
  assert.equal(parseYoutubeDataApi(JSON.stringify({})), null);
  assert.equal(parseYoutubeDataApi(JSON.stringify({ items: [{ contentDetails: { duration: 'soon' } }] })), null);
  assert.equal(parseYoutubeDataApi(JSON.stringify({ items: [{ contentDetails: { duration: 'P0D' } }] })), null);
  assert.equal(parseYoutubeDataApi(JSON.stringify({ items: [{ contentDetails: {} }] })), null);
  assert.equal(parseYoutubeDataApi('null'), null);
  assert.equal(parseYoutubeDataApi('{not json'), null);
});
