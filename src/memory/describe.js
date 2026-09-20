// The media describer: turns one picture (an image, a gif frame or a video
// poster — see src/discord/media.js#isDescribable) into a plain one-line
// caption via a cheap vision-capable model, so the persona can react to what
// is on a picture it did not itself see (features.mediaDescriptions, off by
// default). One request per NEW picture; results are cached per
// attachment/embed id in data/guilds/<id>/media.json (src/memory/store.js),
// LRU-trimmed to `media.cacheEntries`. A failure is cached as a miss for an
// hour, so a broken picture is not retried on every turn/batch. Descriptions
// are data: never logged.

import { mediaProxyUrl } from '../discord/media.js';

const MISS_TTL_MS = 60 * 60_000;

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
 */
export function createDescriber({ hot, store, llm, now = Date.now }) {
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

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: promptText },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }] },
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
    } catch {
      touchKey(cache, item.itemId, { miss: true, ts: now() });
      trimCache(cache, mediaCfg.cacheEntries ?? Infinity);
      store.markMediaCacheDirty(guildId);
      return null;
    }

    const text = String(completion.text ?? '')
      .trim()
      .split('\n')[0]
      .slice(0, 200);

    if (!text) {
      touchKey(cache, item.itemId, { miss: true, ts: now() });
      trimCache(cache, mediaCfg.cacheEntries ?? Infinity);
      store.markMediaCacheDirty(guildId);
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
   * own budget (the warm-up) can account for it.
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

  return { describe, describeMany };
}
