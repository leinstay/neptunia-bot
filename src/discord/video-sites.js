// Pure helpers for the persona's video vision: which links point at a video
// site, a stable cache key for a video URL (so a repost of the same video
// shares one cache entry), the exact yt-dlp / ffmpeg argument arrays the
// fetcher (src/discord/fetch-video.js) runs, and the parsers behind the
// YouTube duration probe that works without yt-dlp (the watch page, the
// optional Data API). No I/O here -- the child processes and requests live at
// the edge, these functions only decide what to run and read what came back.

import { createHash } from 'node:crypto';

// `>` closes Discord's `<url>` embed-suppression form; quotes and `<` never
// belong to a bare URL in chat text.
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[).,>]+$/;
const YTDLP_FORMAT = 'bv*[height<=360]+ba/b[height<=360]/w';

/** Lowercase hostname of `url`, or null when it does not parse. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The entry of `sites` that `host` equals or is a subdomain of, else null. */
function matchSite(host, sites) {
  if (!host || !Array.isArray(sites)) return null;
  for (const site of sites) {
    const s = String(site ?? '').toLowerCase();
    if (!s) continue;
    if (host === s || host.endsWith(`.${s}`)) return site;
  }
  return null;
}

/**
 * The site from `sites` whose domain `url`'s host equals or ends with
 * `.<site>` (case-insensitive), or null (also for an unparsable URL).
 * @param {string} url
 * @param {string[]} sites
 * @returns {string|null}
 */
export function videoSiteFor(url, sites) {
  return matchSite(hostOf(url), sites);
}

/**
 * Whether `url` belongs to a site whose public URL is handed to the model
 * as-is. Same matching rule as videoSiteFor.
 * @param {string} url
 * @param {string[]} directUrlSites
 * @returns {boolean}
 */
export function isDirectUrlSite(url, directUrlSites) {
  return videoSiteFor(url, directUrlSites) !== null;
}

/**
 * Distinct http(s) URLs in `text` that point at one of `sites`, in order of
 * appearance, with trailing `)`, `.`, `,`, `>` stripped. Plain text only.
 * @param {string} text
 * @param {string[]} sites
 * @returns {string[]}
 */
export function extractVideoUrls(text, sites) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    if (!url || out.includes(url)) continue;
    if (videoSiteFor(url, sites) !== null) out.push(url);
  }
  return out;
}

// YouTube paths whose second segment is the video id.
const YOUTUBE_ID_PATHS = new Set(['shorts', 'embed', 'live']);

/**
 * The video id of a YouTube URL (`youtu.be/<id>`, `youtube.com/watch?v=<id>`,
 * `/shorts/<id>`, `/embed/<id>`, `/live/<id>`), or null. `host` is already
 * lowercased and stripped of a leading `www.` / `m.`.
 */
function youtubeId(host, parsed) {
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') return segments[0] ?? null;
  if (host !== 'youtube.com') return null;
  if (segments[0] === 'watch') return parsed.searchParams.get('v') || null;
  if (YOUTUBE_ID_PATHS.has(segments[0])) return segments[1] ?? null;
  return null;
}

/** Lowercase hostname of a parsed URL without a leading `www.` / `m.`. */
function canonicalHost(parsed) {
  return parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
}

/**
 * The video id of any YouTube URL form videoUrlCacheKey canonicalises
 * (`youtu.be/<id>`, `watch?v=<id>`, `/shorts/<id>`, `/embed/<id>`,
 * `/live/<id>`, on `www.` or `m.`), else null (also for an unparsable URL).
 * @param {string} url
 * @returns {string|null}
 */
export function youtubeVideoId(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    return youtubeId(canonicalHost(parsed), parsed);
  } catch {
    return null;
  }
}

/**
 * `video:url:<16 hex>` -- sha1 of a canonical form: lowercase host without a
 * leading `www.` / `m.`, the path, and only the `v` query param (YouTube's
 * video id) when present. Every YouTube form of one video (`youtu.be/<id>`,
 * `/shorts/<id>`, `/embed/<id>`, `/live/<id>`, `watch?v=<id>`, any of them on
 * `m.`) canonicalises to `youtube.com/watch?v=<id>` first, so an embed and a
 * typed link of the same video share one key. Tracking params, timestamps
 * and playlists never split the cache. Short links with no id in them
 * (TikTok's `vm.` / `vt.`) are hashed as they are.
 * @param {string} url
 * @returns {string}
 */
export function videoUrlCacheKey(url) {
  let base = String(url ?? '');
  try {
    const parsed = new URL(base);
    const host = canonicalHost(parsed);
    const id = youtubeId(host, parsed);
    if (id) {
      base = `youtube.com/watch?v=${id}`;
    } else {
      const v = parsed.searchParams.get('v');
      base = `${host}${parsed.pathname}${v !== null ? `?v=${v}` : ''}`;
    }
  } catch {
    // An unparsable URL still hashes to something stable -- best effort.
  }
  return `video:url:${createHash('sha1').update(base).digest('hex').slice(0, 16)}`;
}

/**
 * A metadata-only yt-dlp run (duration, title), no download.
 * @param {string} url
 * @param {{ ytdlpPath: string }} options
 * @returns {{ command: string, args: string[] }}
 */
export function ytdlpProbeArgs(url, { ytdlpPath } = {}) {
  return {
    command: ytdlpPath,
    args: ['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', '--quiet', '--', String(url)],
  };
}

/**
 * A yt-dlp run that downloads only the first `maxSeconds` of the video at
 * low resolution, merged into one mp4 at `outPath`.
 * @param {string} url
 * @param {{ ytdlpPath: string, ffmpegPath: string, maxSeconds: number, maxBytes: number, outPath: string }} options
 * @returns {{ command: string, args: string[] }}
 */
export function ytdlpClipArgs(url, { ytdlpPath, ffmpegPath, maxSeconds, maxBytes, outPath } = {}) {
  return {
    command: ytdlpPath,
    args: [
      '--no-playlist', '--no-warnings', '--quiet',
      '--ffmpeg-location', String(ffmpegPath),
      '-f', YTDLP_FORMAT,
      '--merge-output-format', 'mp4',
      '--download-sections', `*0-${maxSeconds}`,
      '--force-keyframes-at-cuts',
      '--max-filesize', String(maxBytes),
      '-o', String(outPath),
      '--',
      String(url),
    ],
  };
}

/**
 * An ffmpeg run that cuts `inPath` to its first `maxSeconds` and re-encodes
 * it small (360p H.264 + AAC) into `outPath`.
 * @param {string} inPath
 * @param {string} outPath
 * @param {{ ffmpegPath: string, maxSeconds: number }} options
 * @returns {{ command: string, args: string[] }}
 */
export function ffmpegTrimArgs(inPath, outPath, { ffmpegPath, maxSeconds } = {}) {
  return {
    command: ffmpegPath,
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', String(inPath),
      '-t', String(maxSeconds),
      '-vf', 'scale=-2:360',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      String(outPath),
    ],
  };
}

/**
 * Duration and title from yt-dlp's `--dump-single-json` output; anything
 * missing, mistyped or unparsable becomes null.
 * @param {string} jsonText
 * @returns {{ durationSec: number|null, title: string|null }}
 */
export function parseProbe(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText));
  } catch {
    return { durationSec: null, title: null };
  }
  if (!data || typeof data !== 'object') return { durationSec: null, title: null };
  const duration = Number.isFinite(data.duration) && data.duration >= 0 ? data.duration : null;
  const title = typeof data.title === 'string' ? data.title : null;
  return { durationSec: duration, title };
}

/**
 * `hostname/path`, never the query string -- safe to log.
 * @param {string} url
 * @returns {string}
 */
export function safeLocation(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '(unparsable url)';
  }
}

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Seconds of an ISO 8601 duration (`PT3M34S` -> 214, `PT1H` -> 3600,
 * `P1DT1S` -> 86401; fractional seconds round up), or null when `text` is not
 * one (an empty `P` / `PT` included).
 * @param {string} text
 * @returns {number|null}
 */
export function parseIsoDuration(text) {
  if (typeof text !== 'string') return null;
  const match = ISO_DURATION.exec(text);
  if (!match || text.endsWith('T')) return null;
  const [, days, hours, minutes, seconds] = match;
  if (days === undefined && hours === undefined && minutes === undefined && seconds === undefined) return null;
  const total =
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
  return Math.ceil(total);
}

/** A positive whole number of seconds, else null -- a zero length is a live stream, not a duration. */
function positiveSeconds(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The duration of a YouTube watch page in seconds, or null. Tried in order:
 * `"lengthSeconds":"<n>"`, `"approxDurationMs":"<n>"` (rounded up to whole
 * seconds), the `itemprop="duration" content="PT..."` meta tag. A zero value
 * (a live stream) counts as missing and the next field is tried.
 * @param {string} html
 * @returns {number|null}
 */
export function parseYoutubePageDuration(html) {
  if (typeof html !== 'string' || !html) return null;
  const length = /"lengthSeconds":"(\d+)"/.exec(html);
  const fromLength = length ? positiveSeconds(Number(length[1])) : null;
  if (fromLength !== null) return fromLength;
  const approx = /"approxDurationMs":"(\d+)"/.exec(html);
  const fromApprox = approx ? positiveSeconds(Math.ceil(Number(approx[1]) / 1000)) : null;
  if (fromApprox !== null) return fromApprox;
  const meta = /itemprop="duration"\s+content="([^"]*)"/.exec(html);
  return meta ? positiveSeconds(parseIsoDuration(meta[1])) : null;
}

/**
 * The YouTube Data API v3 request for one video's contentDetails. The URL
 * carries the key: never log it (log the fixed path instead).
 * @param {string} id
 * @param {string} key
 * @returns {string}
 */
export function youtubeDataApiUrl(id, key) {
  return (
    'https://www.googleapis.com/youtube/v3/videos?part=contentDetails' +
    `&id=${encodeURIComponent(String(id))}&key=${encodeURIComponent(String(key))}`
  );
}

/**
 * Seconds from a Data API `videos` response (`items[0].contentDetails.duration`),
 * or null -- no items (private, deleted), a live `P0D`, anything unparsable.
 * @param {string} jsonText
 * @returns {number|null}
 */
export function parseYoutubeDataApi(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText));
  } catch {
    return null;
  }
  const duration = data?.items?.[0]?.contentDetails?.duration;
  return positiveSeconds(parseIsoDuration(duration));
}
