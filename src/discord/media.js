// Pure media semantics shared by src/discord/collect.js (normalization),
// src/discord/format.js (transcript rendering) and src/behavior/prompt.js
// (vision selection): classifying an attachment/embed into a kind, choosing
// which label form a media item takes in a transcript line, rewriting a
// Discord CDN URL through the media proxy for resizing, and picking which
// pictures of a channel a live turn may see. No I/O, no discord.js import —
// callers hand in plain data already read off a discord.js Message/Embed.

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
// for. A video-site link embed (kind 'link') never gets one: there is no
// labels.transcript slot for it, only its thumbnail may be attached as-is.
const DESCRIBABLE_KINDS = new Set(['image', 'gif', 'video']);

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
 * @param {{ url?: string|null, title?: string|null, description?: string|null,
 *   thumbnail?: { url?: string|null }|null, provider?: { name?: string|null }|null }} embed
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
    thumbnailUrl: embed?.thumbnail?.url ?? null,
    kind: isGif ? 'gif' : 'link',
    url,
  };
}

/** `m:ss`, floored/rounded to the nearest second, never negative. */
export function formatDurationShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Rewrite a Discord CDN URL through the media proxy so it is served at a
 * given size/format. `cdn.discordapp.com` / `media.discordapp.net` URLs get
 * `width` / `height` / `format` query parameters appended (or replaced, when
 * already present); every other host is returned unchanged. Best-effort: an
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
  if (width != null) parsed.searchParams.set('width', String(width));
  if (height != null) parsed.searchParams.set('height', String(height));
  if (format) parsed.searchParams.set('format', format);
  return parsed.toString();
}

/**
 * Choose which `labels.transcript.*` key (and fill values) renders one media
 * item, in priority order: attached to this request (most informative) >
 * described > blind. `item` is a normalized attachment or link/embed item
 * (see src/discord/collect.js): `{ kind, name?, site?, title?, text?,
 * durationSec?, previewText? }`.
 * @param {object} item
 * @param {{ attachedIndex?: number|null, description?: string|null }} [context]
 * @returns {{ key: string, values: object }}
 */
export function mediaLabelFor(item, { attachedIndex = null, description = null } = {}) {
  const isPicture = PICTURE_ATTACHMENT_KINDS.has(item.kind) || (item.kind === 'link' && item.thumbnailUrl);
  if (attachedIndex != null && isPicture) {
    return { key: 'imageAttached', values: { n: attachedIndex } };
  }

  switch (item.kind) {
    case 'image':
      return description ? { key: 'imageDescribed', values: { text: description } } : { key: 'image', values: {} };
    case 'gif':
      return description
        ? { key: 'gifDescribed', values: { text: description } }
        : { key: 'gif', values: { name: item.name || item.title || item.site || '' } };
    case 'video':
      return description
        ? {
            key: 'videoDescribed',
            values: { name: item.name ?? '', duration: formatDurationShort(item.durationSec ?? 0), text: description },
          }
        : { key: 'video', values: { name: item.name ?? '', duration: formatDurationShort(item.durationSec ?? 0) } };
    case 'voice':
      return { key: 'voice', values: { duration: formatDurationShort(item.durationSec ?? 0) } };
    case 'audio':
      return { key: 'audio', values: { name: item.name ?? '', duration: formatDurationShort(item.durationSec ?? 0) } };
    case 'text':
      return item.previewText
        ? { key: 'filePreview', values: { name: item.name ?? '', text: item.previewText } }
        : { key: 'file', values: { name: item.name ?? '' } };
    case 'link':
      return item.text
        ? { key: 'linkText', values: { site: item.site ?? '', title: item.title ?? '', text: item.text } }
        : { key: 'link', values: { site: item.site ?? '', title: item.title ?? '' } };
    default:
      return { key: 'file', values: { name: item.name ?? '' } };
  }
}

/**
 * Every "picture" of one normalized message, in the order they appear in it
 * (attachments first, then embeds/links): an image/gif/video attachment, or
 * any embed carrying a thumbnail (gif or link kind alike). Each item is
 * stamped with a stable `itemId` (the attachment's Discord id, or the
 * message+embed-index for a link) so it can be looked up in a
 * vision-selection or description-cache map.
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
  return items;
}

/** Whether a picture item (see collectPictures) is one the describer can caption. */
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

  function addFrom(message) {
    if (!message || picked.length >= maxImages) return;
    for (const item of collectPictures(message)) {
      if (picked.length >= maxImages) break;
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      picked.push(item);
    }
  }

  if (trigger) {
    addFrom(trigger);
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
