// Pure media semantics shared by src/discord/collect.js (normalization),
// src/discord/format.js (transcript rendering) and src/behavior/prompt.js
// (vision selection): classifying an attachment/embed into a kind, choosing
// which label form a media item takes in a transcript line, rewriting a
// Discord CDN URL through the media proxy for resizing, and picking which
// pictures of a channel a live turn may see, and listing the video
// candidates of a message (attached videos, video-site links) for the video
// describer. No network I/O, no discord.js
// import — callers hand in plain data already read off a discord.js
// Message/Embed (node:crypto is used only for a deterministic, synchronous
// hash, not for any I/O).

import { createHash } from 'node:crypto';
import { videoSiteFor } from './video-sites.js';

const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const GIF_PROVIDERS = new Set(['tenor', 'giphy']);
const GIF_HOST_RE = /(^|\.)((tenor|giphy)\.com)$/i;

// Extensions Discord may leave without a contentType (or none at all, for
// bots that strip it): a conservative, deliberately small map — anything
// unmatched falls back to the generic 'file' kind.
const EXT_KIND = {
  gif: 'gif',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  txt: 'text',
  md: 'text',
  log: 'text',
  csv: 'text',
  json: 'text',
};

// Media "picture" kinds: the ones that can be attached to a request as an
// image_url part (see selectPictures/collectPictures below).
const PICTURE_ATTACHMENT_KINDS = new Set(['image', 'gif', 'video']);
// Media kinds the describer (src/memory/describe.js) can produce a caption
// for. 'sticker'/'emoji' are added here for the same reason a picture-format
// sticker or a custom emoji is describable, even though neither is a Discord
// attachment/embed kind. 'link' (a video-site embed such as YouTube) is
// describable through its thumbnail alone -- collectPictures only ever
// offers a 'link' item that actually carries one (see below), so the kind
// alone is a safe signal here.
const DESCRIBABLE_KINDS = new Set(['image', 'gif', 'video', 'sticker', 'emoji', 'link']);

// Sticker format types (Discord's `sticker.format`): PNG=1, APNG=2, Lottie=3,
// GIF=4 -- Lottie is a vector animation, never a raster picture, so it is
// deliberately absent from this map (see stickerUrl below).
const STICKER_FORMAT_EXT = { 1: 'png', 2: 'png', 4: 'gif' };
// Verified against the live CDN: media.discordapp.net/stickers/<id>.<ext>
// takes a `size` query param (a power of two), NOT width/height/format —
// cdn.discordapp.com 404s on a GIF sticker entirely, so that host is never
// used here.
const STICKER_SIZE = 160;
// Verified against the live CDN: this exact host+path+size serves both a
// static and an animated custom emoji as image/webp.
const EMOJI_SIZE = 96;

function extOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : null;
}

function truncateText(text, maxChars) {
  const trimmed = String(text ?? '').trim();
  if (!maxChars || trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Classify one Discord attachment into `image | gif | video | audio | voice |
 * text | file`. `isVoice` reflects the MESSAGE's voice-message flag (Discord
 * flags the whole message, not the attachment); a voice message's attachment
 * always classifies as `voice`, ahead of its content type.
 * @param {{ contentType?: string|null, name?: string|null, isVoice?: boolean }} input
 */
export function classifyAttachment({ contentType, name, isVoice = false } = {}) {
  if (isVoice) return 'voice';
  const type = String(contentType ?? '').toLowerCase();
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/')) return 'text';
  const ext = extOf(name);
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  return 'file';
}

/**
 * Classify one Discord embed into a link-ish item: `{ site, title, text,
 * thumbnailUrl, kind, url }`. `kind` is `'gif'` for a tenor/giphy embed (its
 * thumbnail is the frame to describe), else `'link'` — a video-site embed
 * (e.g. YouTube) keeps `kind: 'link'` but still carries `thumbnailUrl`.
 * `thumbnail.proxyURL` is preferred over `thumbnail.url` when discord.js
 * exposes one: Discord's own embed proxy (`media.discordapp.net` /
 * `images-ext-*.discordapp.net`) is reliably fetchable, unlike some
 * third-party thumbnail hosts.
 * @param {{ url?: string|null, title?: string|null, description?: string|null,
 *   thumbnail?: { url?: string|null, proxyURL?: string|null }|null,
 *   provider?: { name?: string|null }|null }} embed
 * @param {{ embedTextChars?: number }} [options]
 */
export function classifyEmbed(embed, { embedTextChars = 200 } = {}) {
  const url = embed?.url ?? null;
  const host = hostnameOf(url ?? '');
  const providerName = String(embed?.provider?.name ?? '');
  const isGif = GIF_PROVIDERS.has(providerName.toLowerCase()) || GIF_HOST_RE.test(host);
  const site = providerName || host || '';
  return {
    site,
    title: truncateText(embed?.title ?? '', embedTextChars),
    text: truncateText(embed?.description ?? '', embedTextChars),
    thumbnailUrl: embed?.thumbnail?.proxyURL ?? embed?.thumbnail?.url ?? null,
    kind: isGif ? 'gif' : 'link',
    url,
  };
}

/**
 * A stable cache key for a link/embed thumbnail: `link:<sha1 prefix of the
 * URL without its query string>`. A signed Discord proxy URL (or any
 * re-fetched embed) carries a query string that changes between fetches of
 * the very same picture; the origin+path does not, so it is dropped before
 * hashing. Deterministic and pure (no I/O) -- see stickerUrl/emojiUrl for the
 * same "rebuild an id from stable inputs" idea.
 * @param {string} url
 */
export function linkThumbnailCacheKey(url) {
  let base = String(url ?? '');
  try {
    const parsed = new URL(base);
    base = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // An unparsable URL still hashes to something stable -- best effort.
  }
  return `link:${createHash('sha1').update(base).digest('hex').slice(0, 16)}`;
}

/** `m:ss`, floored/rounded to the nearest second, never negative. */
export function formatDurationShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Rewrite a Discord attachment URL through the media proxy so it is served at
 * a given size/format. Measured against real Discord payloads:
 * `cdn.discordapp.com` silently IGNORES `width`/`height`/`format` and serves
 * the original file (a full-size image, or for a video attachment the whole
 * file -- never something safe to hand a model as an `image_url` part);
 * `media.discordapp.net` is the host that actually resizes/reformats. So both
 * `cdn.discordapp.com` and `media.discordapp.net` attachment URLs are
 * rewritten to the `media.discordapp.net` host, with `width` / `height` /
 * `format` set (or replaced, when already present) — every other existing
 * query parameter survives untouched, crucially the signed `ex`/`is`/`hm`
 * ones. Every other host is returned unchanged (its own thumbnail is already
 * a plain image, not a video needing frame extraction). Best-effort: an
 * unparsable URL is returned as-is.
 * @param {string} url
 * @param {{ width?: number, height?: number, format?: string }} [options]
 */
export function mediaProxyUrl(url, { width, height, format } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return url;
  }
  if (!DISCORD_CDN_HOSTS.has(parsed.hostname)) return url;
  parsed.hostname = 'media.discordapp.net';
  if (width != null) parsed.searchParams.set('width', String(width));
  if (height != null) parsed.searchParams.set('height', String(height));
  if (format) parsed.searchParams.set('format', format);
  return parsed.toString();
}

/**
 * Rebuild a sticker's picture URL from just its id/format -- the only two
 * fields the slim memory buffer keeps for a sticker (see src/memory/update.js
 * `observe()`), so the live analyzer never needs a stored URL to look up a
 * description-cache entry. `null` for a Lottie sticker (format 3) or any
 * other non-picture format: it is never a picture, name only.
 * @param {string} id
 * @param {number} format
 */
export function stickerUrl(id, format) {
  const ext = STICKER_FORMAT_EXT[format];
  return ext ? `https://media.discordapp.net/stickers/${id}.${ext}?size=${STICKER_SIZE}` : null;
}

/**
 * Rebuild a custom emoji's picture URL from just its id -- the only field the
 * slim memory buffer keeps for an emoji (see src/memory/update.js
 * `observe()`). The same URL serves a static and an animated emoji alike
 * (image/webp either way).
 * @param {string} id
 */
export function emojiUrl(id) {
  return `https://cdn.discordapp.com/emojis/${id}.webp?size=${EMOJI_SIZE}`;
}

/**
 * `m:ss` for a known duration, or `unknownDuration` when `durationSec` is
 * null/undefined -- Discord's own `duration_secs` is usually present on a
 * video/voice/audio attachment but can be missing; this must never silently
 * render as "0:00" for an unknown length.
 */
function durationOrUnknown(durationSec, unknownDuration) {
  return durationSec == null ? unknownDuration : formatDurationShort(durationSec);
}

/**
 * The reason CODE of a not-watched video state: `'length' | 'size' | 'daily'`
 * for a `limit` state, `'error'` for an `error` state. Label-free on purpose:
 * src/discord/format.js swaps it for `labels.transcript.videoReason[code]`.
 */
function videoReasonCode(video) {
  return video.state === 'error' ? 'error' : String(video.reason ?? '');
}

/**
 * The ONE video extra tag of a `link` item with a video state: `linkWatched`
 * when the video was watched, else `linkNotWatchedFrame` when a thumbnail
 * caption exists, else `linkNotWatched`.
 */
function linkVideoExtra(video, description) {
  if (video.state === 'watched') return { key: 'linkWatched', values: { text: video.text ?? '' } };
  const reason = videoReasonCode(video);
  return description
    ? { key: 'linkNotWatchedFrame', values: { reason, text: description } }
    : { key: 'linkNotWatched', values: { reason } };
}

/**
 * The `videoAnswered` extra of a watched video that got a second look on a
 * question (`video.answer = { question, text }`), else null.
 */
function answeredExtra(video) {
  if (video?.state !== 'watched' || !video.answer) return null;
  return { key: 'videoAnswered', values: { question: video.answer.question ?? '', text: video.answer.text ?? '' } };
}

/** `extras` without the nulls: none -> undefined, one -> that tag, more -> the array. */
function extraOf(...extras) {
  const kept = extras.flatMap((extra) => (Array.isArray(extra) ? extra : extra ? [extra] : []));
  if (kept.length === 0) return undefined;
  return kept.length === 1 ? kept[0] : kept;
}

/**
 * Choose which `labels.transcript.*` key (and fill values) renders one media
 * item, in priority order: attached to this request (most informative) >
 * described > blind. `item` is a normalized attachment or link/embed item
 * (see src/discord/collect.js): `{ kind, name?, site?, title?, text?,
 * durationSec?, previewText? }`.
 *
 * A plain image/thumbnail attached to the request renders as a bare
 * `imageAttached`. A video or gif whose still frame is attached keeps its
 * normal form (`video`/`videoDescribed`/`gif`/`gifDescribed` -- so the
 * persona still knows it WAS a video, its name, its duration) and carries a
 * second tag in `extra`: `frameAttached`, numbered the same way. A `link`
 * (a video-site embed, e.g. YouTube) never swaps its own tag: the plain
 * `link`/`linkText` form always stays, and ONE extra tag follows it —
 * `frameAttached` when its thumbnail is attached, else `thumbnailDescribed`
 * when a caption exists, else nothing.
 *
 * `context.video` is the item's video state (see collectVideos and the video
 * describer): `{ state: 'watched', text }`, `{ state: 'limit', reason:
 * 'length'|'size'|'daily' }` or `{ state: 'error' }`; null keeps the
 * still-frame behaviour above. A `video` item that was watched renders
 * `videoWatched`; one not watched renders `videoNotWatchedFrame` (a still
 * frame caption exists) or `videoNotWatched`, `values.reason` carrying the
 * reason CODE (`'length'|'size'|'daily'|'error'`, never a label -- see
 * src/discord/format.js). A `link` with a video state swaps its one extra for
 * `linkWatched` / `linkNotWatchedFrame` / `linkNotWatched`; when its
 * thumbnail is also attached, `extra` is an array: `frameAttached` first,
 * the video extra second. A watched video (attachment or link) whose state
 * carries `answer: { question, text }` (a second look on a question, see
 * src/memory/describe.js#rewatchVideo) appends `videoAnswered` after every
 * other tag of the item. Every other kind ignores `context.video`.
 *
 * `context.read` is the excerpt of a `link` page read by the web lookup
 * (src/web/lookup.js#readLink): it appends `linkRead` after every other extra
 * of the link (frameAttached, the video extra, videoAnswered or
 * thumbnailDescribed). Every other kind ignores it.
 * @param {object} item
 * @param {{ attachedIndex?: number|null, description?: string|null, unknownDuration?: string,
 *   video?: { state: 'watched'|'limit'|'error', text?: string, reason?: string,
 *     answer?: { question: string, text: string } }|null, read?: string|null }} [context]
 * @returns {{ key: string, values: object,
 *   extra?: { key: string, values: object }|{ key: string, values: object }[] }}
 */
export function mediaLabelFor(item, { attachedIndex = null, description = null, unknownDuration = '?', video = null, read = null } = {}) {
  const isPicture = PICTURE_ATTACHMENT_KINDS.has(item.kind) || (item.kind === 'link' && item.thumbnailUrl);
  if (attachedIndex != null && isPicture && item.kind !== 'link') {
    if (item.kind === 'video' || item.kind === 'gif') {
      const base = mediaLabelFor(item, { description, unknownDuration, video });
      return { ...base, extra: extraOf({ key: 'frameAttached', values: { n: attachedIndex } }, base.extra) };
    }
    return { key: 'imageAttached', values: { n: attachedIndex } };
  }

  switch (item.kind) {
    case 'image':
      return description ? { key: 'imageDescribed', values: { text: description } } : { key: 'image', values: {} };
    case 'gif':
      return description
        ? { key: 'gifDescribed', values: { text: description } }
        : { key: 'gif', values: { name: item.name || item.title || item.site || '' } };
    case 'video': {
      const name = item.name ?? '';
      const duration = durationOrUnknown(item.durationSec, unknownDuration);
      if (video?.state === 'watched') {
        const watched = { key: 'videoWatched', values: { name, duration, text: video.text ?? '' } };
        const extra = extraOf(answeredExtra(video));
        return extra ? { ...watched, extra } : watched;
      }
      if (video) {
        const reason = videoReasonCode(video);
        return description
          ? { key: 'videoNotWatchedFrame', values: { name, duration, reason, text: description } }
          : { key: 'videoNotWatched', values: { name, duration, reason } };
      }
      return description
        ? { key: 'videoDescribed', values: { name, duration, text: description } }
        : { key: 'video', values: { name, duration } };
    }
    case 'voice':
      return { key: 'voice', values: { duration: durationOrUnknown(item.durationSec, unknownDuration) } };
    case 'audio':
      return { key: 'audio', values: { name: item.name ?? '', duration: durationOrUnknown(item.durationSec, unknownDuration) } };
    case 'text':
      return item.previewText
        ? { key: 'filePreview', values: { name: item.name ?? '', text: item.previewText } }
        : { key: 'file', values: { name: item.name ?? '' } };
    case 'link': {
      const base = item.text
        ? { key: 'linkText', values: { site: item.site ?? '', title: item.title ?? '', text: item.text } }
        : { key: 'link', values: { site: item.site ?? '', title: item.title ?? '' } };
      const frame = attachedIndex != null && item.thumbnailUrl ? { key: 'frameAttached', values: { n: attachedIndex } } : null;
      const readExtra = read ? { key: 'linkRead', values: { text: read } } : null;
      if (video) {
        const videoExtra = linkVideoExtra(video, description);
        return { ...base, extra: extraOf(frame, videoExtra, answeredExtra(video), readExtra) };
      }
      const thumbnail = !frame && description ? { key: 'thumbnailDescribed', values: { text: description } } : null;
      const extra = extraOf(frame, thumbnail, readExtra);
      return extra ? { ...base, extra } : base;
    }
    default:
      return { key: 'file', values: { name: item.name ?? '' } };
  }
}

/**
 * Choose which `labels.transcript.*` key (and fill values) renders one
 * sticker item, mirroring `mediaLabelFor`'s priority for the picture-format
 * ones (PNG/APNG/GIF -- `sticker.url` is set, see stickerUrl): attached >
 * described > blind (plain `sticker`, name only). A Lottie sticker
 * (`sticker.url` is null) is never a picture: always the plain `sticker`
 * form, regardless of `attachedIndex`/`description` -- see
 * `senses.lottie`.
 * @param {{ name: string, url: string|null }} sticker
 * @param {{ attachedIndex?: number|null, description?: string|null }} [context]
 * @returns {{ key: string, values: object, extra?: { key: string, values: object } }}
 */
export function stickerLabelFor(sticker, { attachedIndex = null, description = null } = {}) {
  if (!sticker.url) return { key: 'sticker', values: { name: sticker.name } };
  if (attachedIndex != null) {
    const base = stickerLabelFor(sticker, { description });
    return { ...base, extra: { key: 'frameAttached', values: { n: attachedIndex } } };
  }
  return description
    ? { key: 'stickerDescribed', values: { name: sticker.name, text: description } }
    : { key: 'sticker', values: { name: sticker.name } };
}

/**
 * Every "picture" of one normalized message, in the order they appear in it
 * (attachments first, then embeds/links, then a picture-format sticker): an
 * image/gif/video attachment, any embed carrying a thumbnail (gif or link
 * kind alike), or a PNG/APNG/GIF sticker (never a Lottie one -- `sticker.url`
 * is null for those, see stickerUrl). Each item is stamped with a stable
 * `itemId` (the attachment's Discord id, the message+embed-index for a link,
 * or `sticker:<id>`) so it can be looked up in a vision-selection or
 * description-cache map. Custom emoji are never included here -- see
 * collectEmojiItems: they are never eligible to be attached as a vision
 * picture, only describable.
 * @param {object} message  A normalized message (see src/discord/collect.js).
 */
export function collectPictures(message) {
  const items = [];
  for (const attachment of message.attachments ?? []) {
    if (!PICTURE_ATTACHMENT_KINDS.has(attachment.kind)) continue;
    items.push({
      source: 'attachment',
      messageId: message.id,
      itemId: attachment.id,
      kind: attachment.kind,
      url: attachment.url,
      name: attachment.name,
      durationSec: attachment.durationSec,
    });
  }
  (message.links ?? []).forEach((link) => {
    if (!link.thumbnailUrl) return;
    items.push({
      source: 'embed',
      messageId: message.id,
      itemId: link.id,
      kind: link.kind,
      url: link.thumbnailUrl,
      name: link.title || link.site,
    });
  });
  for (const sticker of message.stickers ?? []) {
    if (!sticker.url) continue; // Lottie: name only, never a picture
    items.push({
      source: 'sticker',
      messageId: message.id,
      itemId: `sticker:${sticker.id}`,
      kind: 'sticker',
      url: sticker.url,
      name: sticker.name,
    });
  }
  return items;
}

/**
 * Every custom emoji written in one normalized message's text (see
 * src/discord/collect.js), as a describable item -- never a vision picture
 * (too small a slot to spend an attached-image budget on, see
 * docs/prompt-contract.md), so this is kept apart from
 * collectPictures on purpose: nothing here is ever picked by selectPictures.
 * @param {object} message  A normalized message (see src/discord/collect.js).
 */
export function collectEmojiItems(message) {
  return (message.emojis ?? []).map((emoji) => ({
    source: 'emoji',
    messageId: message.id,
    itemId: `emoji:${emoji.id}`,
    kind: 'emoji',
    url: emoji.url,
    name: emoji.name,
  }));
}

/**
 * The video candidates of one normalized message (see src/discord/collect.js),
 * in the order they appear in it: every attachment of kind `video`, then every
 * link whose `url` belongs to one of `sites` (see videoSiteFor in
 * src/discord/video-sites.js). `itemId` is the id the transcript's `videos`
 * state map is keyed by (the attachment's Discord id, or the link's id).
 * `sites` missing or empty -> attachments only.
 * @param {object} message  A normalized message (see src/discord/collect.js).
 * @param {{ sites?: string[] }} [options]
 */
export function collectVideos(message, { sites = [] } = {}) {
  const items = [];
  for (const attachment of message.attachments ?? []) {
    if (attachment.kind !== 'video') continue;
    items.push({
      source: 'attachment',
      messageId: message.id,
      itemId: attachment.id,
      kind: 'video',
      url: attachment.url,
      name: attachment.name,
      durationSec: attachment.durationSec,
      bytes: attachment.size,
    });
  }
  if (!Array.isArray(sites) || sites.length === 0) return items;
  for (const link of message.links ?? []) {
    if (!link.url) continue;
    const site = videoSiteFor(link.url, sites);
    if (!site) continue;
    items.push({
      source: 'link',
      messageId: message.id,
      itemId: link.id,
      kind: 'link',
      url: link.url,
      site,
      name: link.title || link.site,
      durationSec: null,
    });
  }
  return items;
}

/**
 * The links of one normalized message (see src/discord/collect.js) the web
 * lookup may read (src/web/lookup.js#readLinks), in the order they appear in
 * it: every `link` item with a url, minus the ones on a video site of
 * `sites` (the video describer's, see collectVideos) and every gif embed.
 * `sites` missing or empty -> no link is excluded as a video.
 * @param {object} message  A normalized message (see src/discord/collect.js).
 * @param {{ sites?: string[] }} [options]
 * @returns {{ id: string, messageId: string, url: string, site: string, title: string }[]}
 */
export function collectReadableLinks(message, { sites = [] } = {}) {
  const items = [];
  for (const link of message.links ?? []) {
    if (link?.kind !== 'link' || !link.url || !link.id) continue;
    if (Array.isArray(sites) && sites.length > 0 && videoSiteFor(link.url, sites)) continue;
    items.push({ id: link.id, messageId: message.id, url: link.url, site: link.site ?? '', title: link.title ?? '' });
  }
  return items;
}

/** Whether a picture item (see collectPictures/collectEmojiItems) is one the describer can caption. */
export function isDescribable(item) {
  return DESCRIBABLE_KINDS.has(item.kind);
}

/**
 * Select which pictures of a live turn are attached as `image_url` parts, in
 * priority order until `visionCfg.maxImages`: the trigger message's own
 * pictures, then the message it replies to, then the newest
 * `visionCfg.recentImages` pictures of the channel not older than
 * `visionCfg.recentImageMinutes` (measured from `now`). With no trigger
 * (a spontaneous turn) only the "recent" tier applies. The result is ordered
 * by where the picture actually sits in the transcript (oldest message
 * first, then item order within a message) — not by selection priority — so
 * the persona reads its own the numbering top-to-bottom as it reads the chat.
 *
 * A picture-format sticker (see collectPictures) is only ever eligible from
 * the TRIGGER's own message, at the same priority as its images -- never from
 * the message it replies to, nor from the "recent" tier, nor for a
 * spontaneous turn (no trigger at all).
 * @param {object} params
 * @param {object|null} params.trigger   Normalized trigger message, or null.
 * @param {object[]} params.history      Normalized channel messages, oldest first.
 * @param {{ maxImages: number, recentImages: number, recentImageMinutes: number }} params.visionCfg
 * @param {number} params.now
 */
export function selectPictures({ trigger, history, visionCfg, now }) {
  const maxImages = visionCfg?.maxImages ?? 0;
  if (maxImages <= 0) return [];

  const picked = [];
  const seen = new Set();
  const order = new Map(history.map((message, index) => [message.id, index]));

  function addFrom(message, { allowStickers = false } = {}) {
    if (!message || picked.length >= maxImages) return;
    for (const item of collectPictures(message)) {
      if (item.source === 'sticker' && !allowStickers) continue;
      if (picked.length >= maxImages) break;
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      picked.push(item);
    }
  }

  if (trigger) {
    addFrom(trigger, { allowStickers: true });
    if (picked.length < maxImages && trigger.replyToId) {
      addFrom(history.find((message) => message.id === trigger.replyToId));
    }
  }

  if (picked.length < maxImages) {
    const minTs = now - (visionCfg?.recentImageMinutes ?? 0) * 60_000;
    const recentImages = visionCfg?.recentImages ?? 0;
    let recentTaken = 0;
    for (let i = history.length - 1; i >= 0 && recentTaken < recentImages && picked.length < maxImages; i -= 1) {
      const message = history[i];
      if (message.ts < minTs) break;
      for (const item of collectPictures(message)) {
        if (item.source === 'sticker') continue;
        if (recentTaken >= recentImages || picked.length >= maxImages) break;
        if (seen.has(item.itemId)) continue;
        seen.add(item.itemId);
        picked.push(item);
        recentTaken += 1;
      }
    }
  }

  return picked.sort((a, b) => {
    const orderA = order.get(a.messageId) ?? 0;
    const orderB = order.get(b.messageId) ?? 0;
    return orderA - orderB;
  });
}
