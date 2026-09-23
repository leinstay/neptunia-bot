// The media describer: turns one picture (an image, a gif frame or a video
// poster — see src/discord/media.js#isDescribable) into a plain one-line
// caption via a cheap vision-capable model, so the persona can react to what
// is on a picture it did not itself see (features.mediaDescriptions, on by
// default). One request per NEW picture; results are cached per
// attachment/embed id in data/guilds/<id>/media.json (src/memory/store.js),
// LRU-trimmed to `media.cacheEntries`. A failure is cached as a miss for an
// hour, so a broken picture is not retried on every turn/batch. Descriptions
// are data: never logged.
//
// The picture is downloaded first (src/discord/fetch-image.js) and sent to
// the model as a data: URL, never as a bare Discord URL -- the provider's own
// fetcher gets a 403 from Discord on some CDN hosts even though our server
// fetches the same URL fine (see src/behavior/turn.js for the live-vision
// side of the same fix). A failed download costs nothing and is cached as a
// miss exactly like a failed LLM request.
//
// The same module watches videos (features.mediaDescriptions AND
// features.videoDescriptions -- a missing key counts as on -- like the senses
// line): an attached video or a link to a known video site
// (src/discord/media.js#collectVideos)
// is fetched through src/discord/fetch-video.js -- or, for a video of at most
// `media.video.directUrlMaxSeconds` on a site whose public URL the pinned
// provider can open itself (`media.video.directUrlSites`, and only when
// `media.video.provider` is a real provider object), passed by URL -- and
// summarised by a
// video-capable model into one line. A link's duration comes from yt-dlp;
// when yt-dlp fails on a YouTube link, from the YouTube Data API (with a
// configured key) or the watch page (src/discord/fetch-video.js#probeYoutube).
// With no duration at all a direct-URL link is sent only when the owner
// opted in (`media.video.directUrlUnknownDuration`, billed as `maxSeconds`).
// Results share the picture cache under `video:<itemId>`: a watched summary,
// a `length` miss (a video over its cap whose clip download fails; it keeps
// the known `durationSec` and is retried once the live cap -- see lengthCap
// -- has grown to fit it, or when the duration is unknown), a permanent
// `size` miss, or an `error`
// miss (retried after an hour). A separate daily
// counter (`state.data.videoDay` / `videoCount`, `media.video.maxPerDay`)
// caps how many videos are attempted per day: the slot is reserved before the
// fetch and kept even when the fetch or the request fails. Summaries are
// data: never logged. `checkYoutube()` probes one canary video to tell the
// operator which link of the YouTube duration chain works here.

import { mediaProxyUrl } from '../discord/media.js';
import { createImageFetcher } from '../discord/fetch-image.js';
import { createVideoFetcher } from '../discord/fetch-video.js';
import { isDirectUrlSite, safeLocation, youtubeVideoId } from '../discord/video-sites.js';
import { TokenLimitError, DailyCapError } from '../llm/openrouter.js';
import { clampText } from './clamp.js';
import { createYoutubeCheck } from './youtube-check.js';
import { log } from '../log.js';

const MISS_TTL_MS = 60 * 60_000;
const VIDEO_TEXT_CHARS = 600;
const PERMANENT_VIDEO_MISSES = new Set(['length', 'size']);

/** Whether `item` is one collectVideos candidate (an attached video or a video-site link). */
function isVideoCandidate(item) {
  return (
    Boolean(item) && (item.source === 'attachment' || item.source === 'link') && Boolean(item.itemId) && Boolean(item.url)
  );
}

/** Collapse every run of whitespace to one space, then cap at a word boundary. */
function cleanVideoText(raw) {
  const collapsed = String(raw ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  return clampText(collapsed, VIDEO_TEXT_CHARS, { tolerance: 1 });
}

/** Whether `value` is a plain object (a usable OpenRouter `provider` routing block). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A stand-in for the persistent state when none is wired (tests, tools): the daily count lives in memory. */
function memoryState() {
  return { data: {}, markDirty() {} };
}

/** ≤200 chars, with any query string stripped -- an error message must never leak a signed URL. */
function safeDetail(message) {
  return String(message ?? '')
    .replace(/\?[^\s'")]*/g, '')
    .slice(0, 200);
}

/** Move `key` to the end of `cache` (most-recently-used), inserting it if new. */
function touchKey(cache, key, value) {
  delete cache[key];
  cache[key] = value;
}

/** Drop the oldest entries once `cache` holds more than `maxEntries`. */
function trimCache(cache, maxEntries) {
  const keys = Object.keys(cache);
  const overflow = keys.length - Math.max(0, maxEntries);
  for (let i = 0; i < overflow; i += 1) delete cache[keys[i]];
}

/**
 * @param {object} deps
 * @param {object} deps.hot     Live config + prompts; read at the moment of use.
 * @param {object} deps.store
 * @param {object} deps.llm     From createLlm().
 * @param {() => number} [deps.now]
 * @param {object} [deps.imageFetcher]  From createImageFetcher() (src/discord/fetch-image.js).
 * @param {object} [deps.videoFetcher]  From createVideoFetcher() (src/discord/fetch-video.js).
 * @param {{ data: object, markDirty: () => void }} [deps.state]  The persistent state (store.state) holding the
 *   daily video counter; without it the counter lives in memory only.
 * @param {string|null} [deps.youtubeApiKey]  Optional YouTube Data API key (YOUTUBE_API_KEY), handed to
 *   probeYoutube only; never logged.
 */
export function createDescriber({
  hot,
  store,
  llm,
  now = Date.now,
  imageFetcher = createImageFetcher(),
  videoFetcher = createVideoFetcher(),
  state = memoryState(),
  youtubeApiKey = null,
}) {
  /**
   * @param {string} guildId
   * @param {{ itemId: string, kind: string, url: string }} item  See
   *   src/discord/media.js#collectPictures.
   * @param {{ countAgainstDailyCap?: boolean }} [options]
   * @returns {Promise<{ text: string, usage: object|null, estimated: number, cached?: boolean }|null>}
   */
  async function describe(guildId, item, { countAgainstDailyCap = true } = {}) {
    if (hot.config.features?.mediaDescriptions !== true) return null;
    const promptText = hot.prompts?.describe;
    if (!promptText) return null;

    const mediaCfg = hot.config.media ?? {};
    const cache = store.getMediaCache(guildId);
    const cached = cache[item.itemId];
    if (cached) {
      if (cached.miss) {
        if (now() - cached.ts < MISS_TTL_MS) return null;
      } else {
        touchKey(cache, item.itemId, cached);
        store.markMediaCacheDirty(guildId);
        return { text: cached.text, usage: null, estimated: 0, cached: true };
      }
    }

    // A sticker/emoji URL is already fully sized by its own pure builder
    // (stickerUrl/emojiUrl -- `size=`, not width/height/format, and the
    // emoji CDN host is deliberately not media.discordapp.net): the proxy
    // must never touch either. Every other kind (image/gif/video/link) goes
    // through it as before -- a no-op for a non-Discord host such as a
    // YouTube thumbnail's i.ytimg.com.
    let imageUrl;
    if (item.kind === 'sticker' || item.kind === 'emoji') {
      imageUrl = item.url;
    } else {
      const proxyOptions =
        item.kind === 'video' ? { format: 'webp' } : { width: mediaCfg.imageSize, height: mediaCfg.imageSize, format: 'webp' };
      imageUrl = mediaProxyUrl(item.url, proxyOptions);
    }

    const recordMiss = () => {
      touchKey(cache, item.itemId, { miss: true, ts: now() });
      trimCache(cache, mediaCfg.cacheEntries ?? Infinity);
      store.markMediaCacheDirty(guildId);
    };

    const visionCfg = hot.config.context?.vision ?? {};
    const downloaded = await imageFetcher.fetchAsDataUrl(imageUrl, {
      maxBytes: visionCfg.maxBytes,
      timeoutMs: visionCfg.fetchTimeoutMs,
    });
    if (!downloaded) {
      log.warn('describe: failed', { kind: item.kind, reason: 'download' });
      recordMiss();
      return null;
    }

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: promptText },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: downloaded.dataUrl } }] },
        ],
        {
          model: mediaCfg.model,
          maxOutputTokens: mediaCfg.maxOutputTokens,
          countAgainstDailyCap,
          // A vision request has its own (usually cheap/fast) model, but still
          // deserves the same chat timeout, not the analyzer's much larger one.
          timeoutMs: hot.config.llm?.timeoutMs,
        },
      );
    } catch (err) {
      log.warn('describe: failed', { kind: item.kind, reason: 'llm', status: err.statusCode, detail: safeDetail(err.message) });
      recordMiss();
      return null;
    }

    const text = String(completion.text ?? '')
      .trim()
      .split('\n')[0]
      .slice(0, 200);

    if (!text) {
      log.warn('describe: failed', { kind: item.kind, reason: 'empty' });
      recordMiss();
      return null;
    }

    touchKey(cache, item.itemId, { text, ts: now() });
    trimCache(cache, mediaCfg.cacheEntries ?? Infinity);
    store.markMediaCacheDirty(guildId);
    return { text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
  }

  /**
   * Describe up to `maxNew` NEW (non-cached) pictures of `items`, in the
   * order given; cache hits are free and never count against `maxNew`.
   * Returns `{ descriptions, newCount }` — `descriptions` maps `itemId` to
   * caption text, ready to hand to formatTranscript's `descriptions` option.
   * `onCharge(result)` is called once per NEW request (successful or not,
   * whenever the provider actually billed something) so a caller with its
   * own separate token budget (a history backfill) can account for it.
   * @param {string} guildId
   * @param {object[]} items
   * @param {{ maxNew?: number, countAgainstDailyCap?: boolean, onCharge?: (r: object) => void }} [options]
   */
  async function describeMany(guildId, items, { maxNew = Infinity, countAgainstDailyCap = true, onCharge } = {}) {
    const descriptions = new Map();
    let newCount = 0;
    for (const item of items) {
      if (newCount >= maxNew) break;
      const result = await describe(guildId, item, { countAgainstDailyCap });
      if (!result) continue;
      if (!result.cached) {
        newCount += 1;
        onCharge?.(result);
      }
      descriptions.set(item.itemId, result.text);
    }
    return { descriptions, newCount };
  }

  // One in-flight watch per guild + video: a message prefill and a turn that
  // reach the same new video at once share one request.
  const inFlight = new Map();

  /** Store a video cache entry, LRU-touched and trimmed like the picture entries. */
  function putVideoEntry(guildId, key, value) {
    const cache = store.getMediaCache(guildId);
    touchKey(cache, key, value);
    trimCache(cache, hot.config.media?.cacheEntries ?? Infinity);
    store.markMediaCacheDirty(guildId);
  }

  /**
   * Whether `item` is a link that may go out by its public URL: a pinned
   * provider object and a `directUrlSites` site.
   */
  function isPinnableLink(item, videoCfg) {
    return (
      item.source === 'link' &&
      isPlainObject(videoCfg.provider) &&
      isDirectUrlSite(item.url, videoCfg.directUrlSites ?? [])
    );
  }

  /**
   * The length cap that applies to `item` under the live config: a pinnable
   * direct-URL link is sent by URL up to `directUrlMaxSeconds` (falling back
   * to `maxSeconds` when unset); anything else is clipped at `maxSeconds`.
   * `directUrlMaxSeconds * tokensPerSecond` must stay under
   * `media.video.maxRequestTokens` (180 * 300 = 54 000 < 60 000 by default),
   * or every long direct-URL video trips the token rail.
   */
  function lengthCap(item, videoCfg) {
    if (isPinnableLink(item, videoCfg)) return videoCfg.directUrlMaxSeconds ?? videoCfg.maxSeconds;
    return videoCfg.maxSeconds;
  }

  /**
   * The cached state under `key`, or null when the video must be (re)watched.
   * A watched entry is LRU-touched; an error miss counts only for an hour; a
   * `length` miss is treated as absent when its `durationSec` is unknown
   * (null or missing, as in entries written before it was stored) or now fits
   * `lengthCap(item)`, so a raised cap retries it.
   */
  function cachedVideo(guildId, key, item) {
    const cache = store.getMediaCache(guildId);
    const entry = cache[key];
    if (!entry) return null;
    if (entry.watched) {
      touchKey(cache, key, entry);
      store.markMediaCacheDirty(guildId);
      return { state: 'watched', text: entry.text, usage: null, estimated: 0, cached: true };
    }
    if (entry.miss && entry.reason === 'length') {
      // An unknown duration (older entries included) costs one probe to learn.
      if (typeof entry.durationSec !== 'number') return null;
      if (entry.durationSec <= lengthCap(item, hot.config.media?.video ?? {})) return null;
    }
    if (entry.miss && PERMANENT_VIDEO_MISSES.has(entry.reason)) return { state: 'limit', reason: entry.reason };
    if (entry.miss && now() - entry.ts < MISS_TTL_MS) return { state: 'error' };
    return null;
  }

  /** Today's video count; resets the counter when the day changed (same day logic as the LLM client's). */
  function videoCountToday() {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (state.data.videoDay !== today) {
      state.data.videoDay = today;
      state.data.videoCount = 0;
      state.markDirty();
    }
    return state.data.videoCount ?? 0;
  }

  /**
   * Get the media of one candidate: `{ ok: true, url, seconds, bytes, pinned }`
   * or `{ ok: false, reason }` (a `length` failure adds `durationSec`, null when unknown).
   */
  async function fetchVideoMedia(item, videoCfg) {
    const { maxSeconds, maxBytes, toolTimeoutMs, ffmpegPath, ytdlpPath } = videoCfg;
    if (item.source === 'attachment') {
      const got = await videoFetcher.fetchAttachment(item.url, {
        durationSec: item.durationSec,
        maxSeconds,
        maxBytes,
        toolTimeoutMs,
        ffmpegPath,
        fetchTimeoutMs: hot.config.context?.vision?.fetchTimeoutMs,
      });
      if (got.ok) return { ok: true, url: got.dataUrl, seconds: got.seconds, bytes: got.bytes, pinned: false };
      if (got.reason === 'length') {
        return { ok: false, reason: 'length', durationSec: Number.isFinite(got.durationSec) ? got.durationSec : null };
      }
      return got;
    }
    let probe = await videoFetcher.probeSite(item.url, { ytdlpPath, toolTimeoutMs });
    // yt-dlp can be blocked by YouTube's bot check; the duration alone is
    // still learnable from the Data API or the watch page.
    if (!probe.ok && youtubeVideoId(item.url) !== null) {
      const youtube = await videoFetcher.probeYoutube(item.url, {
        fetchTimeoutMs: hot.config.context?.vision?.fetchTimeoutMs,
        apiKey: youtubeApiKey,
      });
      if (youtube.ok) probe = youtube;
    }
    // The public URL goes out only with a pinned provider that can open it;
    // without one the clip is downloaded like any other site's.
    const pinnable = isPinnableLink(item, videoCfg);
    if (!probe.ok) {
      // No duration at all: only the owner's explicit switch sends the URL,
      // billed as the longest allowed video.
      if (pinnable && videoCfg.directUrlUnknownDuration === true) {
        return { ok: true, url: item.url, seconds: maxSeconds, bytes: null, pinned: true };
      }
      return probe;
    }
    const durationSec = probe.durationSec ?? item.durationSec ?? null;
    // A direct-URL video has its own cap (directUrlMaxSeconds, see lengthCap);
    // past it the clip route below still gets the first maxSeconds.
    if (pinnable && durationSec != null && durationSec <= lengthCap(item, videoCfg)) {
      return { ok: true, url: item.url, seconds: durationSec, bytes: null, pinned: true };
    }
    const clip = await videoFetcher.fetchSiteClip(item.url, {
      ytdlpPath,
      ffmpegPath,
      maxSeconds,
      maxBytes,
      toolTimeoutMs,
      durationSec,
    });
    if (clip.ok) return { ok: true, url: clip.dataUrl, seconds: clip.seconds, bytes: clip.bytes, pinned: false };
    // Too long and not clippable: the video will not get shorter, so this is final.
    // The duration is kept so a later, larger cap can retry it (cachedVideo).
    if (durationSec != null && durationSec > maxSeconds) return { ok: false, reason: 'length', durationSec };
    return clip;
  }

  /**
   * The uncached part of describeVideo: resolves `{ result, sent, attempted }`.
   * `sent` = a request reached the provider; `attempted` = the media was
   * fetched (or probed) at all, successful or not -- the daily cap alone is
   * not an attempt.
   */
  async function watchVideo(guildId, item, key, promptText, countAgainstDailyCap) {
    const videoCfg = hot.config.media?.video ?? {};
    const report = (result, extra = {}) => {
      log.info('describe: video', {
        source: item.source,
        state: result.state,
        reason: result.reason ?? extra.reason ?? null,
        seconds: extra.seconds ?? null,
        bytes: extra.bytes ?? null,
        status: extra.status,
        cached: false,
        location: safeLocation(item.url),
      });
      return result;
    };
    const errorMiss = (reason, extra = {}) => {
      putVideoEntry(guildId, key, { miss: true, ts: now(), reason: 'error' });
      return report({ state: 'error' }, { ...extra, reason });
    };

    // Reserve the daily slot synchronously, before any await, so concurrent
    // watches can never overshoot maxPerDay. A failed fetch or request keeps
    // its slot: attempts count, like media.video.maxPerTurn.
    const countToday = videoCountToday();
    if (countToday >= (videoCfg.maxPerDay ?? Infinity)) {
      return { result: report({ state: 'limit', reason: 'daily' }), sent: false, attempted: false };
    }
    state.data.videoCount = countToday + 1;
    state.markDirty();

    const media = await fetchVideoMedia(item, videoCfg);
    if (!media.ok) {
      if (PERMANENT_VIDEO_MISSES.has(media.reason)) {
        const entry = { miss: true, ts: now(), reason: media.reason };
        if (media.reason === 'length') entry.durationSec = media.durationSec ?? null;
        putVideoEntry(guildId, key, entry);
        return { result: report({ state: 'limit', reason: media.reason }), sent: false, attempted: true };
      }
      return { result: errorMiss(media.reason ?? 'download'), sent: false, attempted: true };
    }

    const sizes = { seconds: media.seconds ?? null, bytes: media.bytes ?? null };
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: promptText },
          { role: 'user', content: [{ type: 'video_url', video_url: { url: media.url } }] },
        ],
        {
          model: videoCfg.model,
          maxOutputTokens: videoCfg.maxOutputTokens,
          timeoutMs: videoCfg.timeoutMs,
          videoSeconds: media.seconds ?? videoCfg.maxSeconds,
          // Video requests have their own pre-flight cap; every other caller
          // stays under the global llm.maxRequestTokens.
          maxRequestTokens: videoCfg.maxRequestTokens,
          provider: media.pinned ? videoCfg.provider : undefined,
          countAgainstDailyCap,
          // A video's provider-counted prompt tokens say nothing about the
          // text ratio every chat request is checked against.
          skipCalibration: true,
        },
      );
    } catch (err) {
      const railHit = err instanceof TokenLimitError || err instanceof DailyCapError;
      const reason = err instanceof TokenLimitError ? 'tokenLimit' : err instanceof DailyCapError ? 'dailyCap' : 'llm';
      return { result: errorMiss(reason, { ...sizes, status: err.statusCode }), sent: !railHit, attempted: true };
    }

    const text = cleanVideoText(completion.text);
    if (!text) return { result: errorMiss('empty', sizes), sent: true, attempted: true };

    putVideoEntry(guildId, key, { text, ts: now(), watched: true });
    const result = { state: 'watched', text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
    report(result, sizes);
    return { result, sent: true, attempted: true };
  }

  /**
   * describeVideo plus describeVideos' accounting: `sent` (a request reached
   * the provider) and `attempted` (a fetch was tried, or this call waited on
   * another caller's in-flight watch of the same video).
   */
  async function describeVideoCharged(guildId, item, { countAgainstDailyCap = true, cacheOnly = false } = {}) {
    // Video vision needs both switches, like the senses line (src/behavior/prompt.js#renderSenses);
    // a missing videoDescriptions counts as on.
    const features = hot.config.features ?? {};
    if (features.mediaDescriptions !== true || features.videoDescriptions === false) {
      return { result: null, sent: false, attempted: false };
    }
    const promptText = hot.prompts?.['describe-video'];
    if (!promptText || !isVideoCandidate(item)) return { result: null, sent: false, attempted: false };

    const key = `video:${item.itemId}`;
    const cached = cachedVideo(guildId, key, item);
    if (cached) {
      log.info('describe: video', { source: item.source, state: cached.state, reason: cached.reason ?? null, cached: true });
      return { result: cached, sent: false, attempted: false };
    }
    if (cacheOnly) return { result: null, sent: false, attempted: false };

    const flightKey = `${guildId}:${key}`;
    const running = inFlight.get(flightKey);
    if (running) {
      const { result } = await running;
      return { result, sent: false, attempted: true };
    }
    const promise = watchVideo(guildId, item, key, promptText, countAgainstDailyCap).finally(() =>
      inFlight.delete(flightKey),
    );
    inFlight.set(flightKey, promise);
    return promise;
  }

  /**
   * Watch one video candidate (src/discord/media.js#collectVideos) and
   * summarise it in one line, through the shared media cache.
   * @param {string} guildId
   * @param {object} item  One collectVideos candidate.
   * @param {{ countAgainstDailyCap?: boolean }} [options]
   * @returns {Promise<{ state: 'watched', text: string, usage: object|null, estimated: number, cached?: true }
   *   | { state: 'limit', reason: 'length'|'size'|'daily' } | { state: 'error' } | null>}  null when the
   *   feature is off, the prompt is missing or `item` is not a video candidate.
   */
  async function describeVideo(guildId, item, { countAgainstDailyCap = true } = {}) {
    const { result } = await describeVideoCharged(guildId, item, { countAgainstDailyCap });
    return result;
  }

  /**
   * Try up to `maxNew` NEW videos of `items`, in the order given. Every fetch
   * ATTEMPT counts toward `maxNew` -- a probe, download or LLM failure
   * included -- so a caller never waits on several tool timeouts in a row;
   * cache hits (limit/error states included) and the daily cap are free.
   * `onCharge(result)` fires only for a request actually sent. Past `maxNew`
   * the remaining items are still looked up in the cache, never fetched.
   * Returns `{ videos, newCount }` (`newCount` = attempts) -- `videos` maps
   * `itemId` to a video state, ready for formatTranscript's `videos` option.
   * @param {string} guildId
   * @param {object[]} items
   * @param {{ maxNew?: number, countAgainstDailyCap?: boolean, onCharge?: (r: object) => void }} [options]
   */
  async function describeVideos(guildId, items, { maxNew = Infinity, countAgainstDailyCap = true, onCharge } = {}) {
    const videos = new Map();
    let newCount = 0;
    for (const item of items) {
      const cacheOnly = newCount >= maxNew;
      const { result, sent, attempted } = await describeVideoCharged(guildId, item, { countAgainstDailyCap, cacheOnly });
      if (attempted) newCount += 1;
      if (sent) onCharge?.(result);
      if (result) videos.set(item.itemId, result);
    }
    return { videos, newCount };
  }

  // Which link of the YouTube duration chain works on this host (src/memory/youtube-check.js):
  // the same fetcher and key as a real link, no LLM call, nothing cached.
  const checkYoutube = createYoutubeCheck({ hot, videoFetcher, youtubeApiKey });

  return { describe, describeMany, describeVideo, describeVideos, checkYoutube };
}
