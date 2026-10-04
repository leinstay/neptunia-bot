// The media describer: turns one picture (an image, a gif frame or a video
// poster — see src/discord/media.js#isDescribable) into a plain one-line
// caption via a cheap vision-capable model, so the persona can react to what
// is on a picture it did not itself see (features.mediaDescriptions, on by
// default). One request per NEW picture; results are cached per
// attachment/embed id in data/guilds/<id>/media.json (src/memory/store.js),
// LRU-trimmed to `media.cacheEntries`. A failure is cached as a miss for an
// hour, so a broken picture is not retried on every turn/batch. Descriptions
// are data: never logged. A caption is capped at `media.descriptionChars`
// (the describe prompt may learn the cap through `{{maxChars}}`).
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
// `media.video.directUrlMaxSeconds` (less outside agentic processing, see
// lengthCap) on a site whose public URL the pinned
// provider can open itself (`media.video.directUrlSites`, and only when
// `media.video.provider` is a real provider object), passed by URL -- and
// summarised by a
// video-capable model into one line. A public URL goes out with OpenRouter's
// processing mode (`media.video.urlProcessing`); every video request carries
// `media.video.reasoning` so reasoning does not eat the output budget. A link's duration comes from yt-dlp;
// when yt-dlp fails on a YouTube link, from the YouTube Data API (with a
// configured key) or the watch page (src/discord/fetch-video.js#probeYoutube).
// With no duration at all a direct-URL link is sent only when the owner
// opted in (`media.video.directUrlUnknownDuration`, billed as `maxSeconds`).
// Results share the picture cache under `video:<itemId>`: a watched summary,
// a `length` miss (a video over its cap whose clip download fails; it keeps
// the known `durationSec` and is retried once the live cap -- see lengthCap
// -- has grown to fit it, or when the duration is unknown), a permanent
// `size` miss, or an `error`
// miss (retried after `media.video.errorRetryMinutes`, default 60, or at
// once on a forced attempt -- describeVideo's `force`, used when the person
// asks to try a video that did not load again). A separate daily
// counter (`state.data.videoDay` / `videoCount`, `media.video.maxPerDay`)
// caps how many videos are attempted per day: the slot is reserved before the
// fetch and kept even when the fetch or the request fails. Summaries are
// data: never logged. `checkYoutube()` probes one canary video to tell the
// operator which link of the YouTube duration chain works here.
//
// A summary is capped at `media.video.summaryChars` (the describe-video
// prompt learns the cap through `{{maxChars}}`). `rewatchVideo()` is the
// second look on a question (features.videoRewatch, a missing key counts as
// on): the same media fetch as a watch, asked one question through the
// `rewatch-answer` prompt. It has its own daily counter
// (`state.data.rewatchDay` / `rewatchCount`, `media.video.rewatch.maxPerDay`)
// on top of the ordinary video one; its answer is cached for an hour under
// `video:<itemId>:q:<hash of the question>`, failures never.
//
// A GIF is watched, not described from one still frame (`media.gif.watch`,
// a missing key counts as on, plus video vision on and the describe-gif or
// describe-video prompt, see src/memory/gif-watch.js): its animation -- the
// mp4 of a tenor/giphy embed, an attached .gif, a .gif link -- is converted
// to a short mp4 (the first `media.gif.maxSeconds`) and summarised by the
// video model under the video request rails, but with its own daily counter
// (`state.data.gifWatchDay` / `gifWatchCount`, `media.gif.maxPerDay`): a GIF
// never takes a video slot, nor a video a GIF one. The caption is cached under the
// GIF's own item id like a picture's (so the transcript, the analyzer and
// the GIF library read it unchanged), marked `watched: true`. A GIF that
// cannot be watched -- the switches, no animation, a spent daily rail, a
// failed fetch, conversion or request -- gets the one-frame description as
// before (marked `gif: true`, plus `watchFailed` when a watch failed). A
// cached one-frame caption is served as it is; only `watchGif()` (the
// owner's recache, src/memory/gif-recache.js) replaces it.

import { createHash } from 'node:crypto';
import { isPlainObject } from '../config.js';
import { mediaProxyUrl } from '../discord/media.js';
import { createImageFetcher } from '../discord/fetch-image.js';
import { createVideoFetcher } from '../discord/fetch-video.js';
import { isDirectUrlSite, safeLocation, youtubeVideoId } from '../discord/video-sites.js';
import { TokenLimitError, DailyCapError, VIDEO_TOKENS_PER_SECOND_FALLBACK as STATIC_TOKENS_PER_SECOND_FALLBACK } from '../llm/openrouter.js';
import { clampText } from './clamp.js';
import { classifierMediaModel, classifierVideoModel } from '../behavior/mention.js';
import { fillPromptTemplate } from '../behavior/prompt.js';
import { createYoutubeCheck, isVideoVisionOn } from './youtube-check.js';
import { gifWatchBlocker as gifWatchBlockerOf, gifWatchCap, gifWatchPrompt } from './gif-watch.js';
import { log } from '../log.js';
import { dailyCounter, utcDay } from '../time.js';

const MISS_TTL_MS = 60 * 60_000;
// Only when media.descriptionChars is missing or invalid (config.json always has it).
const DESCRIPTION_CHARS_FALLBACK = 200;
// Only when media.video.errorRetryMinutes is missing or invalid (config.json always has it).
const VIDEO_ERROR_RETRY_MINUTES_FALLBACK = 60;
// Only when media.video.urlProcessing is missing (config.json always has it; null omits the field).
const VIDEO_URL_PROCESSING_FALLBACK = 'agentic';
// Only when media.video.summaryChars is missing (config.json always has it, the same value).
const VIDEO_TEXT_CHARS_FALLBACK = 1500;
const REWATCH_ANSWER_CHARS_FALLBACK = 1200;
const REWATCH_TTL_MS = 60 * 60_000;
const PERMANENT_VIDEO_MISSES = new Set(['length', 'size']);
// Only when media.gif.maxSeconds is missing or invalid (config.json always has it).
const GIF_MAX_SECONDS_FALLBACK = 8;

/**
 * The file a GIF watch downloads: a gif embed's `animationUrl` (the mp4 of
 * a tenor/giphy embed, or a `.gif` link, see src/discord/media.js#classifyEmbed),
 * else an attached gif's own file. Null for anything else -- a gif embed
 * with neither keeps the one-frame description.
 */
function gifAnimationSource(item) {
  if (item?.kind !== 'gif') return null;
  if (typeof item.animationUrl === 'string' && item.animationUrl) return item.animationUrl;
  if (item.source === 'attachment' && typeof item.url === 'string' && item.url) return item.url;
  return null;
}

/** Whether `item` is one collectVideos candidate (an attached video or a video-site link). */
function isVideoCandidate(item) {
  return (
    Boolean(item) && (item.source === 'attachment' || item.source === 'link') && Boolean(item.itemId) && Boolean(item.url)
  );
}

/** Collapse every run of whitespace to one space, then cap at `maxChars` on a word boundary. */
function cleanVideoText(raw, maxChars) {
  const collapsed = String(raw ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  return clampText(collapsed, maxChars, { tolerance: 1 });
}

/** A positive number from the config, else `fallback`. */
function positiveOr(value, fallback) {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** The cache key of one question's answer: lower-cased, whitespace-collapsed, sha1-prefixed. */
function questionKey(itemId, question) {
  const normalised = String(question ?? '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
  const digest = createHash('sha1').update(normalised).digest('hex').slice(0, 16);
  return `video:${itemId}:q:${digest}`;
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

/** The log/outcome code of a failed request: a rail (`token-limit`, `daily-cap`) or `llm-error`. */
function requestFailureReason(err) {
  if (err instanceof TokenLimitError) return 'token-limit';
  if (err instanceof DailyCapError) return 'daily-cap';
  return 'llm-error';
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
 * Whether `item` is a link that may go out by its public URL: a pinned
 * provider object and a `directUrlSites` site.
 */
function isPinnableLink(item, videoCfg) {
  return (
    item?.source === 'link' &&
    isPlainObject(videoCfg.provider) &&
    isDirectUrlSite(item.url, videoCfg.directUrlSites ?? [])
  );
}

/**
 * The length cap that applies to `item` under the live config: a pinnable
 * direct-URL link is sent by URL up to `directUrlMaxSeconds` (falling back
 * to `maxSeconds` when unset); anything else is clipped at `maxSeconds`.
 * With agentic processing `directUrlMaxSeconds * directUrlTokensPerSecond`
 * must stay under `media.video.maxRequestTokens` (3600 * 10 = 36 000 <
 * 60 000 by default), or every long direct-URL video trips the token rail.
 * With any other processing mode the request is estimated at
 * `tokensPerSecond`, so the cap is also held to what the video token cap
 * allows (60 000 / 120 = 500 s by default): a longer video takes the clip
 * route instead of being refused by the rail on every retry.
 */
function lengthCap(item, videoCfg, llmCfg) {
  if (!isPinnableLink(item, videoCfg)) return videoCfg.maxSeconds;
  const cap = videoCfg.directUrlMaxSeconds ?? videoCfg.maxSeconds;
  if (urlProcessingMode(videoCfg) === 'agentic') return cap;
  const tokenSeconds = staticRequestSeconds(videoCfg, llmCfg);
  return tokenSeconds === null ? cap : Math.min(cap, tokenSeconds);
}

/**
 * How many seconds of video fit the pre-flight token cap at the static
 * per-second estimate: `floor(maxRequestTokens / tokensPerSecond)`, with the
 * same values the client then applies (`media.video.maxRequestTokens`, else
 * `llm.maxRequestTokens`; `tokensPerSecond`, else 300). Null when no cap is
 * known.
 */
function staticRequestSeconds(videoCfg, llmCfg) {
  const isPositive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const maxRequestTokens = isPositive(videoCfg.maxRequestTokens)
    ? videoCfg.maxRequestTokens
    : llmCfg?.maxRequestTokens;
  if (!isPositive(maxRequestTokens)) return null;
  const tokensPerSecond = isPositive(videoCfg.tokensPerSecond) ? videoCfg.tokensPerSecond : STATIC_TOKENS_PER_SECOND_FALLBACK;
  return Math.floor(maxRequestTokens / tokensPerSecond);
}

/** The processing mode a public URL goes out with (see videoPart), or null when the field is omitted. */
function urlProcessingMode(videoCfg) {
  const mode = videoCfg.urlProcessing === undefined ? VIDEO_URL_PROCESSING_FALLBACK : videoCfg.urlProcessing;
  return typeof mode === 'string' && mode ? mode : null;
}

/**
 * The lasting video state a media cache entry (`video:<item id>`) stands for, by the describer's
 * own rules, read-only: `{ state: 'watched', text }`, `{ state: 'limit', reason }` for a
 * permanent miss (`length`, `size`), or null -- no entry, an error miss (retried after
 * `media.video.errorRetryMinutes`, see describeVideo), or a `length` miss whose duration is
 * unknown or fits the length cap that applies to `item` now (a raised cap retries it). `item`
 * (a collectVideos candidate) only decides the cap: a pinnable direct-URL link has its own; without
 * one (a buffered message keeps no URL) the cap is `media.video.maxSeconds`. Pure. Shared by the
 * describer's cache lookup and the live analyzer (src/memory/update.js).
 * @param {object|undefined} entry
 * @param {object} config  Live config (`media.video`, `llm`).
 * @param {object} [item]
 * @returns {{ state: 'watched', text: string } | { state: 'limit', reason: string } | null}
 */
export function videoStateFromCache(entry, config, item = {}) {
  if (!entry) return null;
  if (entry.watched) return { state: 'watched', text: entry.text };
  if (!entry.miss || !PERMANENT_VIDEO_MISSES.has(entry.reason)) return null;
  if (entry.reason === 'length') {
    // An unknown duration (older entries included) costs one probe to learn.
    if (typeof entry.durationSec !== 'number') return null;
    if (entry.durationSec <= lengthCap(item, config?.media?.video ?? {}, config?.llm)) return null;
  }
  return { state: 'limit', reason: entry.reason };
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
 *   daily video and re-watch counters; without it the counters live in memory only.
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
  /** Today's UTC date as `YYYY-MM-DD` from the injected clock: the daily counters and the prompts' `{{today}}`. */
  function todayDate() {
    return utcDay(now());
  }

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
    const descriptionChars = positiveOr(mediaCfg.descriptionChars, DESCRIPTION_CHARS_FALLBACK);
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

    // A GIF is watched like a short video first (see watchGifShared); one
    // that cannot be watched, or whose watch fails, keeps the one-frame
    // description below -- never nothing.
    let watchFailed = false;
    if (item.kind === 'gif') {
      const watched = await watchGifShared(guildId, item, countAgainstDailyCap);
      if (watched?.state === 'watched') {
        return { text: watched.text, usage: watched.usage ?? null, estimated: watched.estimated ?? 0 };
      }
      watchFailed = watched?.state === 'failed';
    }

    // A sticker/emoji URL is already fully sized by its own pure builder
    // (stickerUrl/emojiUrl -- `size=`, not width/height/format, and the
    // emoji CDN host is deliberately not media.discordapp.net): the proxy
    // must never touch either. Every other kind (image/gif/video/link) goes
    // through it -- a no-op for a non-Discord host such as a YouTube
    // thumbnail's i.ytimg.com. A gif asks for one still png frame: as webp
    // the proxy serves the whole animation, often above context.vision.maxBytes.
    let imageUrl;
    if (item.kind === 'sticker' || item.kind === 'emoji') {
      imageUrl = item.url;
    } else {
      const sized = { width: mediaCfg.imageSize, height: mediaCfg.imageSize };
      let proxyOptions;
      if (item.kind === 'video') proxyOptions = { format: 'webp' };
      else if (item.kind === 'gif') proxyOptions = { ...sized, format: 'png', animated: false };
      else proxyOptions = { ...sized, format: 'webp' };
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
          { role: 'system', content: fillPromptTemplate(promptText, { maxChars: descriptionChars, today: todayDate() }) },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: downloaded.dataUrl } }] },
        ],
        {
          model: classifierMediaModel(hot.config),
          role: 'classifier.media',
          maxOutputTokens: mediaCfg.maxOutputTokens,
          countAgainstDailyCap,
          // A vision request has its own (usually cheap/fast) model, but still
          // deserves the same chat timeout, not the analyzer's much larger one.
          timeoutMs: hot.config.llm?.timeoutMs,
          // A picture is estimated at a flat context.vision.tokensPerImage while
          // the vision model counts far more: its provider-counted prompt tokens
          // say nothing about the text ratio every chat request is checked against.
          skipCalibration: true,
        },
      );
    } catch (err) {
      log.warn('describe: failed', { kind: item.kind, reason: 'llm-error', status: err.statusCode, detail: safeDetail(err.message) });
      recordMiss();
      return null;
    }

    // First line only, hard-capped on a word boundary (never mid-token).
    const firstLine = String(completion.text ?? '')
      .trim()
      .split('\n')[0];
    const text = clampText(firstLine, descriptionChars, { tolerance: 1 });

    if (!text) {
      log.warn('describe: failed', { kind: item.kind, reason: 'empty' });
      recordMiss();
      return null;
    }

    // A GIF's one-frame caption is marked (`gif`) so the recache can find it
    // (src/memory/gif-recache.js), and `watchFailed` when a watch was tried.
    const entry = { text, ts: now() };
    if (item.kind === 'gif') entry.gif = true;
    if (watchFailed) entry.watchFailed = entry.ts;
    touchKey(cache, item.itemId, entry);
    trimCache(cache, mediaCfg.cacheEntries ?? Infinity);
    store.markMediaCacheDirty(guildId);
    return { text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
  }

  /**
   * Why GIFs are not watched under the live config and prompts, or null when
   * they are: `off`, `video-off` or `no-prompt` (src/memory/gif-watch.js#gifWatchBlocker).
   * @returns {'off'|'video-off'|'no-prompt'|null}
   */
  function gifWatchBlocker() {
    return gifWatchBlockerOf(hot.config, hot.prompts);
  }

  /**
   * One GIF watch, uncached: the animation at `source` is downloaded and
   * converted to a short mp4 (src/discord/fetch-video.js#fetchGif, the first
   * `media.gif.maxSeconds`, the video size and tool settings), then
   * summarised by the video model through the `describe-gif` prompt
   * (`{{maxChars}}` = `media.descriptionChars` -- a GIF caption keeps a
   * picture caption's length -- and `{{seconds}}` = `media.gif.maxSeconds`),
   * else the `describe-video` prompt with `{{maxChars}}` alone as before;
   * under the video token cap and output budget, and a slot of the GIF's own
   * `media.gif.maxPerDay` (never the video one) reserved before the fetch and
   * kept on failure. A watched caption is cached under the GIF's own item id
   * as `{ text, ts, watched: true, gif: true }`; nothing is cached otherwise.
   * Resolves `{ state: 'watched', text, usage, estimated }`, `{ state:
   * 'failed', reason }` (the fetch, the conversion, the request or an empty
   * answer) or `{ state: 'unavailable', reason: 'daily'|'daily-cap' }` (a
   * daily rail is spent: no failure of this GIF). One `describe: gif` log
   * line, codes only.
   */
  async function watchGifNow(guildId, item, source, countAgainstDailyCap) {
    const mediaCfg = hot.config.media ?? {};
    const videoCfg = mediaCfg.video ?? {};
    const maxSeconds = positiveOr(mediaCfg.gif?.maxSeconds, GIF_MAX_SECONDS_FALLBACK);
    const descriptionChars = positiveOr(mediaCfg.descriptionChars, DESCRIPTION_CHARS_FALLBACK);
    const report = (outcome, extra = {}) => {
      log.info('describe: gif', {
        state: outcome.state,
        reason: outcome.reason ?? null,
        seconds: extra.seconds ?? null,
        bytes: extra.bytes ?? null,
        status: extra.status,
        location: safeLocation(source),
      });
      return outcome;
    };

    // The daily GIF slot, reserved synchronously like a video watch's.
    const watchedToday = countToday('gifWatchDay', 'gifWatchCount');
    if (watchedToday >= gifWatchCap(hot.config)) return report({ state: 'unavailable', reason: 'daily' });
    state.data.gifWatchCount = watchedToday + 1;
    state.markDirty();

    const media = await videoFetcher.fetchGif(source, {
      maxSeconds,
      maxBytes: videoCfg.maxBytes,
      toolTimeoutMs: videoCfg.toolTimeoutMs,
      ffmpegPath: videoCfg.ffmpegPath,
      fetchTimeoutMs: hot.config.context?.vision?.fetchTimeoutMs,
    });
    if (!media.ok) return report({ state: 'failed', reason: media.reason ?? 'download' });

    const clip = { url: media.dataUrl, seconds: Math.min(media.seconds ?? maxSeconds, maxSeconds), pinned: false };
    const sizes = { seconds: clip.seconds, bytes: media.bytes ?? null };
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: gifSystemPrompt(descriptionChars, maxSeconds) },
          { role: 'user', content: [videoPart(videoCfg, clip)] },
        ],
        videoRequestOptions(videoCfg, clip, { maxOutputTokens: videoCfg.maxOutputTokens, countAgainstDailyCap }),
      );
    } catch (err) {
      const reason = requestFailureReason(err);
      if (reason === 'daily-cap') return report({ state: 'unavailable', reason }, sizes);
      return report({ state: 'failed', reason }, { ...sizes, status: err.statusCode });
    }

    const text = cleanVideoText(completion.text, descriptionChars);
    if (!text) return report({ state: 'failed', reason: 'empty' }, sizes);
    putVideoEntry(guildId, item.itemId, { text, ts: now(), watched: true, gif: true });
    report({ state: 'watched' }, sizes);
    return { state: 'watched', text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
  }

  /**
   * The system message of a GIF watch: `describe-gif` with `{{maxChars}}`,
   * `{{seconds}}` and `{{today}}`, else `describe-video` exactly as a GIF got
   * it before (`{{maxChars}}`, `{{today}}`). Read at the moment of use.
   */
  function gifSystemPrompt(maxChars, seconds) {
    const prompt = gifWatchPrompt(hot.prompts);
    const values = { maxChars, today: todayDate() };
    if (prompt?.name === 'describe-gif') values.seconds = seconds;
    return fillPromptTemplate(prompt?.text, values);
  }

  /**
   * watchGifNow behind the switches and the in-flight guard: null when GIFs
   * are not watched now (gifWatchBlocker) or the item has no animation to
   * download (gifAnimationSource); otherwise the outcome, shared with any
   * caller already watching the same GIF of the same guild.
   */
  function watchGifShared(guildId, item, countAgainstDailyCap) {
    if (gifWatchBlocker() !== null) return null;
    const source = gifAnimationSource(item);
    if (!source) return null;
    const flightKey = `${guildId}:gif:${item.itemId}`;
    const running = inFlight.get(flightKey);
    if (running) return running;
    const promise = watchGifNow(guildId, item, source, countAgainstDailyCap).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
    return promise;
  }

  /** Mark a GIF's cache entry as a failed watch (`watchFailed`): its caption, if any, is kept. */
  function markGifWatchFailed(guildId, itemId) {
    const cache = store.getMediaCache(guildId);
    const entry = cache[itemId];
    const ts = now();
    const next =
      entry && !entry.miss && typeof entry.text === 'string' && entry.text
        ? { ...entry, watchFailed: ts }
        : { miss: true, ts, gif: true, watchFailed: ts };
    putVideoEntry(guildId, itemId, next);
  }

  /**
   * Re-describe one GIF by watching it, for the recache
   * (src/memory/gif-recache.js): an entry already watched is served from the
   * cache; any other cached caption (a one-frame one) is ignored and, when
   * the watch succeeds, replaced -- under the same item id, so nothing else
   * has to change. A failed watch never falls back to one frame here: the
   * old caption stays and the entry is marked `watchFailed` (a GIF with no
   * caption gets a miss so marked). Every rail of watchGifNow applies.
   * @param {string} guildId
   * @param {object} item  A gif picture item (src/discord/media.js#collectPictures).
   * @param {{ countAgainstDailyCap?: boolean }} [options]
   * @returns {Promise<{ state: 'watched', text: string, cached?: true }
   *   | { state: 'failed', reason: string } | { state: 'unavailable', reason: string }>}
   *   `unavailable`: GIFs are not watched now (see gifWatchBlocker) or a daily rail is spent.
   */
  async function watchGif(guildId, item, { countAgainstDailyCap = true } = {}) {
    const blocker = gifWatchBlocker();
    if (blocker !== null) return { state: 'unavailable', reason: blocker };
    const cached = store.getMediaCache(guildId)[item.itemId];
    if (cached?.watched && typeof cached.text === 'string') return { state: 'watched', text: cached.text, cached: true };
    if (!gifAnimationSource(item)) {
      markGifWatchFailed(guildId, item.itemId);
      log.info('describe: gif', { state: 'failed', reason: 'source' });
      return { state: 'failed', reason: 'source' };
    }
    const outcome = await watchGifShared(guildId, item, countAgainstDailyCap);
    if (outcome.state === 'failed') markGifWatchFailed(guildId, item.itemId);
    if (outcome.state === 'watched') return { state: 'watched', text: outcome.text };
    return { state: outcome.state, reason: outcome.reason };
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

  /**
   * The captions the media cache already holds for `items`, never a
   * download or a request, never a daily count: `itemId` -> caption text,
   * ready for formatTranscript's `descriptions` option. Misses and unknown
   * items are left out; a hit is LRU-touched as describe() does. Empty
   * when describe() would not run (features.mediaDescriptions off, no
   * describe prompt). Used where a caption helps but may not cost a request
   * (the address classifier, src/discord/events.js).
   * @param {string} guildId
   * @param {object[]} items
   * @returns {Map<string, string>}
   */
  function cachedDescriptions(guildId, items) {
    const descriptions = new Map();
    if (hot.config.features?.mediaDescriptions !== true || !hot.prompts?.describe) return descriptions;
    const cache = store.getMediaCache(guildId);
    let touched = false;
    for (const item of items ?? []) {
      const entry = item?.itemId ? cache[item.itemId] : undefined;
      if (!entry || entry.miss || typeof entry.text !== 'string' || !entry.text) continue;
      touchKey(cache, item.itemId, entry);
      touched = true;
      descriptions.set(item.itemId, entry.text);
    }
    if (touched) store.markMediaCacheDirty(guildId);
    return descriptions;
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
   * The cached state under `key`, or null when the video must be (re)watched:
   * the lasting states by videoStateFromCache (a watched entry is LRU-touched;
   * a `length` miss of unknown duration, or one that fits the cap now, is
   * absent so a raised cap retries it), plus an error miss, which counts only
   * for `media.video.errorRetryMinutes` (read now) and never when `force` is set.
   */
  function cachedVideo(guildId, key, item, force = false) {
    const cache = store.getMediaCache(guildId);
    const entry = cache[key];
    if (!entry) return null;
    const lasting = videoStateFromCache(entry, hot.config, item);
    if (lasting?.state === 'watched') {
      touchKey(cache, key, entry);
      store.markMediaCacheDirty(guildId);
      return { ...lasting, usage: null, estimated: 0, cached: true };
    }
    if (lasting) return lasting;
    if (entry.miss && PERMANENT_VIDEO_MISSES.has(entry.reason)) return null; // a length miss to retry
    if (entry.miss && !force && now() - entry.ts < videoErrorTtlMs()) return { state: 'error' };
    return null;
  }

  /** How long a video error miss is served from the cache: `media.video.errorRetryMinutes`, read at the moment of use. */
  function videoErrorTtlMs() {
    const minutes = hot.config.media?.video?.errorRetryMinutes;
    const valid = typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0;
    return (valid ? minutes : VIDEO_ERROR_RETRY_MINUTES_FALLBACK) * 60_000;
  }

  /**
   * Today's count of one daily counter (`state.data[dayKey]` / `[countKey]`);
   * resets it when the day changed (same day logic as the LLM client's).
   */
  function countToday(dayKey, countKey) {
    const { count, rolled } = dailyCounter(state.data, { dayKey, countKey }, now());
    if (rolled) state.markDirty();
    return count;
  }

  /** Today's video count (every watch and every re-watch attempt). */
  function videoCountToday() {
    return countToday('videoDay', 'videoCount');
  }

  /**
   * The `video_url` part of a video request. A public URL (a pinned
   * direct-URL request) carries OpenRouter's processing mode
   * (`media.video.urlProcessing`, a missing key = 'agentic', a non-string or
   * empty value omits it) -- without it the provider samples a single frame;
   * a data: URL part never does.
   */
  function videoPart(videoCfg, media) {
    const videoUrl = { url: media.url };
    if (media.pinned) {
      const mode = urlProcessingMode(videoCfg);
      if (mode) videoUrl.processing = mode;
    }
    return { type: 'video_url', video_url: videoUrl };
  }

  /**
   * The per-second token estimate of a public URL in agentic processing
   * (`media.video.directUrlTokensPerSecond`), or undefined for every other
   * request -- a data: URL clip, a public URL in another or no processing
   * mode, a missing or invalid setting -- which then keeps the client's
   * `media.video.tokensPerSecond`. Agentic processing does not bill the video
   * as prompt tokens; its exploration shows up as a few completion tokens per
   * second of video.
   */
  function videoTokensPerSecond(videoCfg, media) {
    if (!media.pinned || urlProcessingMode(videoCfg) !== 'agentic') return undefined;
    const value = videoCfg.directUrlTokensPerSecond;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  /**
   * The `llm.complete` options of a video request (a watch or a re-watch):
   * the video model and timeout, the video-only token cap, the per-second
   * estimate of an agentic public URL, the pinned provider only for a public
   * URL, the reasoning settings (`media.video.reasoning`, a plain object or
   * nothing), never the text calibration.
   */
  function videoRequestOptions(videoCfg, media, { maxOutputTokens, countAgainstDailyCap }) {
    return {
      model: classifierVideoModel(hot.config),
      role: 'classifier.video',
      maxOutputTokens,
      timeoutMs: videoCfg.timeoutMs,
      videoSeconds: media.seconds ?? videoCfg.maxSeconds,
      videoTokensPerSecond: videoTokensPerSecond(videoCfg, media),
      // Video requests have their own pre-flight cap; every other caller
      // stays under the global llm.maxRequestTokens.
      maxRequestTokens: videoCfg.maxRequestTokens,
      provider: media.pinned ? videoCfg.provider : undefined,
      // Without it the video model's reasoning can eat the whole output budget.
      reasoning: isPlainObject(videoCfg.reasoning) ? videoCfg.reasoning : undefined,
      countAgainstDailyCap,
      // A video's provider-counted prompt tokens say nothing about the
      // text ratio every chat request is checked against.
      skipCalibration: true,
    };
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
    if (pinnable && durationSec != null && durationSec <= lengthCap(item, videoCfg, hot.config.llm)) {
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
   * not an attempt. `forced` only marks the log line.
   */
  async function watchVideo(guildId, item, key, promptText, countAgainstDailyCap, forced = false) {
    const videoCfg = hot.config.media?.video ?? {};
    const summaryChars = positiveOr(videoCfg.summaryChars, VIDEO_TEXT_CHARS_FALLBACK);
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
        ...(forced ? { forced: true } : {}),
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
          { role: 'system', content: fillPromptTemplate(promptText, { maxChars: summaryChars, today: todayDate() }) },
          { role: 'user', content: [videoPart(videoCfg, media)] },
        ],
        videoRequestOptions(videoCfg, media, { maxOutputTokens: videoCfg.maxOutputTokens, countAgainstDailyCap }),
      );
    } catch (err) {
      const railHit = err instanceof TokenLimitError || err instanceof DailyCapError;
      return { result: errorMiss(requestFailureReason(err), { ...sizes, status: err.statusCode }), sent: !railHit, attempted: true };
    }

    const text = cleanVideoText(completion.text, summaryChars);
    if (!text) return { result: errorMiss('empty', sizes), sent: true, attempted: true };

    putVideoEntry(guildId, key, { text, ts: now(), watched: true });
    const result = { state: 'watched', text, usage: completion.usage ?? null, estimated: completion.estimated ?? 0 };
    report(result, sizes);
    return { result, sent: true, attempted: true };
  }

  /**
   * describeVideo plus describeVideos' accounting: `sent` (a request reached
   * the provider) and `attempted` (a fetch was tried, or this call waited on
   * another caller's in-flight watch of the same video). `force` ignores an
   * `error` miss (a limit miss and a watched entry still count; every rail
   * still applies).
   */
  async function describeVideoCharged(guildId, item, { countAgainstDailyCap = true, cacheOnly = false, force = false } = {}) {
    // Video vision needs both switches, like the senses line (src/behavior/prompt.js#renderSenses).
    if (!isVideoVisionOn(hot.config)) return { result: null, sent: false, attempted: false };
    const promptText = hot.prompts?.['describe-video'];
    if (!promptText || !isVideoCandidate(item)) return { result: null, sent: false, attempted: false };

    const key = `video:${item.itemId}`;
    const cached = cachedVideo(guildId, key, item, force);
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
    const promise = watchVideo(guildId, item, key, promptText, countAgainstDailyCap, force).finally(() =>
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
   * @param {{ countAgainstDailyCap?: boolean, force?: boolean }} [options]  `force`: try again
   *   despite a cached `error` miss (a limit and a watched entry are still served from the cache).
   * @returns {Promise<{ state: 'watched', text: string, usage: object|null, estimated: number, cached?: true }
   *   | { state: 'limit', reason: 'length'|'size'|'daily' } | { state: 'error' } | null>}  null when the
   *   feature is off, the prompt is missing or `item` is not a video candidate.
   */
  async function describeVideo(guildId, item, { countAgainstDailyCap = true, force = false } = {}) {
    const { result } = await describeVideoCharged(guildId, item, { countAgainstDailyCap, force });
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

  /**
   * The video states the media cache already holds for `items` (the same
   * lookup as describeVideos past its `maxNew`): never a fetch, a request or
   * a daily video slot, and an in-flight watch is not waited for. `itemId`
   * -> video state, ready for formatTranscript's `videos` option.
   * @param {string} guildId
   * @param {object[]} items  collectVideos candidates.
   * @returns {Promise<Map<string, object>>}
   */
  async function cachedVideos(guildId, items) {
    const videos = new Map();
    for (const item of items ?? []) {
      const { result } = await describeVideoCharged(guildId, item, { cacheOnly: true });
      if (result) videos.set(item.itemId, result);
    }
    return videos;
  }

  /**
   * The second look on a question: fetch `item` again exactly like a watch
   * (fetchVideoMedia -- same probe chain, direct-URL rules, caps and pinned
   * provider) and ask the video model `question` through the
   * `rewatch-answer` prompt (`{{question}}`, `{{maxChars}}` =
   * `media.video.rewatch.answerChars`). Needs video vision on,
   * `features.videoRewatch` not false, the prompt, a video candidate and a
   * non-empty question. Both daily counters must have room
   * (`media.video.rewatch.maxPerDay` and `media.video.maxPerDay`); both
   * slots are reserved before the fetch and kept on failure. An answer is
   * cached for an hour under `video:<itemId>:q:<hash>`; a failure is never
   * cached. The question and the answer are data: never logged.
   * @param {string} guildId
   * @param {object} item  One collectVideos candidate.
   * @param {string} question
   * @returns {Promise<{ question: string, text: string }|null>}
   */
  async function rewatchVideo(guildId, item, question) {
    if (!isVideoVisionOn(hot.config) || hot.config.features?.videoRewatch === false) return null;
    const promptText = hot.prompts?.['rewatch-answer'];
    const asked = String(question ?? '').trim();
    if (!promptText || !isVideoCandidate(item) || !asked) return null;

    const videoCfg = hot.config.media?.video ?? {};
    const rewatchCfg = videoCfg.rewatch ?? {};
    const answerChars = positiveOr(rewatchCfg.answerChars, REWATCH_ANSWER_CHARS_FALLBACK);
    const report = (outcome, extra = {}) => {
      log.info('describe: rewatch', {
        source: item.source,
        state: outcome,
        reason: extra.reason ?? null,
        cached: extra.cached ?? false,
        seconds: extra.seconds ?? null,
        location: safeLocation(item.url),
      });
    };

    const cache = store.getMediaCache(guildId);
    const key = questionKey(item.itemId, asked);
    const hit = cache[key];
    if (hit && typeof hit.answer === 'string') {
      if (now() - hit.ts < REWATCH_TTL_MS) {
        touchKey(cache, key, hit);
        store.markMediaCacheDirty(guildId);
        report('answered', { cached: true });
        return { question: hit.question ?? asked, text: hit.answer };
      }
      delete cache[key];
      store.markMediaCacheDirty(guildId);
    }

    // Both rails, both reserved synchronously before any await (like a watch).
    const rewatchedToday = countToday('rewatchDay', 'rewatchCount');
    const videosToday = videoCountToday();
    if (rewatchedToday >= (rewatchCfg.maxPerDay ?? Infinity) || videosToday >= (videoCfg.maxPerDay ?? Infinity)) {
      report('limit', { reason: 'daily' });
      return null;
    }
    state.data.rewatchCount = rewatchedToday + 1;
    state.data.videoCount = videosToday + 1;
    state.markDirty();

    const media = await fetchVideoMedia(item, videoCfg);
    if (!media.ok) {
      report(PERMANENT_VIDEO_MISSES.has(media.reason) ? 'limit' : 'error', { reason: media.reason ?? 'download' });
      return null;
    }

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(promptText, { question: asked, maxChars: answerChars, today: todayDate() }) },
          { role: 'user', content: [videoPart(videoCfg, media)] },
        ],
        videoRequestOptions(videoCfg, media, { maxOutputTokens: rewatchCfg.maxOutputTokens, countAgainstDailyCap: true }),
      );
    } catch (err) {
      report('error', { reason: requestFailureReason(err), seconds: media.seconds ?? null });
      return null;
    }

    const text = cleanVideoText(completion.text, answerChars);
    if (!text) {
      report('error', { reason: 'empty', seconds: media.seconds ?? null });
      return null;
    }
    putVideoEntry(guildId, key, { answer: text, question: asked, ts: now() });
    report('answered', { seconds: media.seconds ?? null });
    return { question: asked, text };
  }

  // Which link of the YouTube duration chain works on this host (src/memory/youtube-check.js):
  // the same fetcher and key as a real link, no LLM call, nothing cached.
  const checkYoutube = createYoutubeCheck({ hot, videoFetcher, youtubeApiKey });

  return {
    describe,
    describeMany,
    cachedDescriptions,
    describeVideo,
    describeVideos,
    cachedVideos,
    rewatchVideo,
    watchGif,
    gifWatchBlocker,
    checkYoutube,
  };
}
