// Pure text formatting of normalized messages (see normalizeMessage in
// collect.js) into the transcript the model reads. No discord.js imports here,
// so everything is unit-testable. Every word that ends up in the prompt comes
// from `labels` (see prompts/labels.json and docs/prompt-contract.md);
// this module only knows the shape of a transcript line, e.g.:
//   #87 [14:32] nick: text (replyTo marker) [image]
//   --- {duration} passed ---
// Time gaps and date changes are spelled out because the model must tell a
// live conversation from a dead chat that somebody has just poked.

import { clipWithEllipsis, mediaLabelFor, stickerLabelFor, stickerUrl } from './media.js';
import { gifHandleOf } from '../memory/gifs.js';
import { MINUTE_MS, HOUR_MS, DAY_MS } from '../time.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';

// config.json's context.replyQuoteChars: how much of a reply's parent its line quotes.
const DEFAULT_REPLY_QUOTE_CHARS = 80;

// A language-neutral marker (memory transcript only) for a message addressed
// to the persona, so the analyzer can weigh "how people talk TO it" apart
// from general chatter. See docs/prompt-contract.md, "The analyzer".
const DIRECT_MARKER = '→ '; // "→ "

// A value no real channelId can equal, so the very first message of a memory
// transcript always opens with a channel heading (see formatTranscript).
const NO_CHANNEL = Symbol('no-channel');

const formatters = new Map();

function formatter(timezone, locale, options) {
  const key = `${timezone}|${locale}|${JSON.stringify(options)}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat(locale, { timeZone: timezone, ...options }));
  }
  return formatters.get(key);
}

/**
 * Fill `{key}` placeholders in a label template with `values[key]`. Unknown
 * keys are left untouched (e.g. a typo in a deployment's labels.json does not
 * silently swallow text); a missing/empty template returns ''.
 * @param {string} template
 * @param {object} [values]
 */
export function fill(template, values = {}) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (all, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : all,
  );
}

/**
 * Wall-clock time of `ts` in `timezone`, 24-hour `HH:MM` as `locale` writes it.
 * @param {number} ts  epoch milliseconds
 * @param {string} timezone  IANA zone name
 * @param {string} [locale]
 * @returns {string}
 */
export function formatClock(ts, timezone, locale = 'en-US') {
  return formatter(timezone, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
}

/**
 * The date of `ts` in `timezone`: short weekday, day and month name in
 * `locale` (the transcript's date and gap markers).
 * @param {number} ts  epoch milliseconds
 * @param {string} timezone  IANA zone
 * @param {string} [locale]
 * @returns {string}
 */
export function formatDate(ts, timezone, locale = 'en-US') {
  return formatter(timezone, locale, { weekday: 'short', day: 'numeric', month: 'long' }).format(ts);
}

/**
 * The full "now" of `ts` in `timezone`: long weekday, day, month and year in
 * `locale`, then the clock (formatClock) and the zone name in parentheses.
 * @param {number} ts  epoch milliseconds
 * @param {string} timezone  IANA zone
 * @param {string} [locale]
 * @returns {string}
 */
export function formatNow(ts, timezone, locale = 'en-US') {
  const date = formatter(timezone, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ts);
  return `${date}, ${formatClock(ts, timezone, locale)} (${timezone})`;
}

/** Local hour 0-23 in the given timezone. Locale-independent by design. */
export function localHour(ts, timezone) {
  return Number(formatter(timezone, 'en-US', { hour: 'numeric', hourCycle: 'h23' }).format(ts)) % 24;
}

/**
 * Coarse, human-scale duration, e.g. "5 min", "3 h 12 min", "2 d 4 h". Rounds
 * to the nearest minute/hour and rolls the result over into the next unit
 * rather than ever printing "60 min" or "24 h".
 * @param {number} ms
 * @param {{lessThanMinute: string, minute: string, hour: string, day: string}} units
 */
export function formatDuration(ms, units) {
  if (ms < MINUTE_MS) return units.lessThanMinute;

  if (ms < HOUR_MS) {
    const minutes = Math.round(ms / MINUTE_MS);
    if (minutes >= 60) return `1 ${units.hour}`;
    return `${minutes} ${units.minute}`;
  }

  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    let minutes = Math.round((ms - hours * HOUR_MS) / MINUTE_MS);
    let wholeHours = hours;
    if (minutes >= 60) {
      wholeHours += 1;
      minutes = 0;
    }
    if (wholeHours >= 24) return `1 ${units.day}`;
    return minutes ? `${wholeHours} ${units.hour} ${minutes} ${units.minute}` : `${wholeHours} ${units.hour}`;
  }

  const days = Math.floor(ms / DAY_MS);
  let hours = Math.round((ms - days * DAY_MS) / HOUR_MS);
  let wholeDays = days;
  if (hours >= 24) {
    wholeDays += 1;
    hours = 0;
  }
  return hours ? `${wholeDays} ${units.day} ${hours} ${units.hour}` : `${wholeDays} ${units.day}`;
}

/**
 * One rendered tag per attachment/embed/sticker of `message`, most
 * informative form available (see docs/prompt-contract.md, "Media in
 * a transcript line" and src/discord/media.js#mediaLabelFor/stickerLabelFor):
 * attached to this request > described > blind, plus one extra tag per
 * distinct described custom emoji unless `context.emojiInline` is false (the
 * request describes them once elsewhere). `context.attachedIndex`/
 * `context.descriptions` are optional `Map`s keyed by the item's id (an
 * attachment's Discord id, a link's synthesized id, `sticker:<id>` or
 * `emoji:<id>` — see normalizeMessage). `context.videos` is an optional
 * `Map` of the same ids to a video state (see mediaLabelFor); it only takes
 * effect when the labels carry `transcript.videoWatched` (a key blanked in
 * prompts.local/labels.json switches this form off); a video state's
 * `answer` (a second look on a question) likewise needs
 * `transcript.videoAnswered`. `context.reads` is an optional `Map` of link
 * ids to the excerpt the web lookup read from that page (src/web/lookup.js);
 * it needs `transcript.linkRead`, blanked the same way to switch it off.
 * `context.imageAnswers` is an optional `Map` of picture ids to a second look
 * on a question (`{ question, text }`, src/memory/describe.js#relookImage);
 * it needs `transcript.imageAnswered`, blanked the same way to switch it off.
 * `context.gifHandles` is an optional `Map` from src/memory/gifs.js#gifHandleMap:
 * a GIF (attachment or embed) the library knows renders `transcript.gifKnown` /
 * `gifKnownNoText` with its handle; with the key in question blanked it
 * renders `gifDescribed` / `gif` instead.
 */
function mediaTags(message, labels, context = {}) {
  const unknownDuration = labels.transcript.unknownDuration ?? '?';
  const videosOn = Boolean(labels.transcript.videoWatched);
  // A second look's answer (videoAnswered): a key blanked in
  // prompts.local/labels.json switches this form off.
  const answersOn = Boolean(labels.transcript.videoAnswered);
  // A read page's excerpt (linkRead): blanking the key switches it off too.
  const readsOn = Boolean(labels.transcript.linkRead);
  // A picture's second look on a question (imageAnswered): blanking the key switches it off.
  const answerOf = (id) => (labels.transcript.imageAnswered ? (context.imageAnswers?.get(id) ?? null) : null);
  const videoOf = (id) => {
    const video = videosOn ? (context.videos?.get(id) ?? null) : null;
    if (!video?.answer || answersOn) return video;
    const { answer, ...rest } = video;
    return rest;
  };
  const tags = [];
  // A video tag's `reason` is a code (media.js is label-free): swap it for
  // its label before filling.
  const pushTag = ({ key, values }) => {
    const filled =
      values && Object.prototype.hasOwnProperty.call(values, 'reason')
        ? { ...values, reason: labels.transcript.videoReason?.[values.reason] ?? '' }
        : values;
    tags.push(fill(labels.transcript[key], filled));
  };
  const pushLabel = ({ key, values, extra }) => {
    pushTag({ key, values });
    for (const tag of Array.isArray(extra) ? extra : extra ? [extra] : []) pushTag(tag);
  };
  // An attached picture's caption (imageAttachedDescribed): a key blanked in
  // prompts.local/labels.json switches this form off, the bare imageAttached
  // renders instead.
  const attachedCaptionOn = Boolean(labels.transcript.imageAttachedDescribed);
  // A library GIF's handle (gifKnown / gifKnownNoText): blanking the one
  // chosen switches it off, the plain GIF form renders instead.
  const handleOf = (item, kind) => (item.kind === 'gif' ? gifHandleOf(context.gifHandles, item, kind) : null);
  const withGifFallback = (label) => {
    if (label.key === 'gifKnown' && !labels.transcript.gifKnown) {
      return { ...label, key: 'gifDescribed', values: { text: label.values.text } };
    }
    if (label.key === 'gifKnownNoText' && !labels.transcript.gifKnownNoText) {
      return { ...label, key: 'gif', values: { name: label.values.name } };
    }
    return label;
  };
  for (const attachment of message.attachments ?? []) {
    const attachedIndex = context.attachedIndex?.get(attachment.id) ?? null;
    const description = context.descriptions?.get(attachment.id) ?? null;
    const video = videoOf(attachment.id);
    const gifHandle = handleOf(attachment, 'attachment');
    const answer = answerOf(attachment.id);
    const label = withGifFallback(mediaLabelFor(attachment, { attachedIndex, description, unknownDuration, video, gifHandle, answer }));
    pushLabel(
      label.key === 'imageAttachedDescribed' && !attachedCaptionOn ? { ...label, key: 'imageAttached', values: { n: label.values.n } } : label,
    );
  }
  for (const link of message.links ?? []) {
    const attachedIndex = context.attachedIndex?.get(link.id) ?? null;
    // A plain 'link' (video-site preview) thumbnail description
    // (transcript.thumbnailDescribed): a key blanked in
    // prompts.local/labels.json switches this form off -- a 'gif' embed's
    // own description (gifDescribed) is a base contract key and is never
    // gated this way.
    const canDescribe = link.kind !== 'link' || Boolean(labels.transcript.thumbnailDescribed);
    const description = canDescribe ? (context.descriptions?.get(link.id) ?? null) : null;
    const read = readsOn ? (context.reads?.get(link.id) ?? null) : null;
    const gifHandle = handleOf(link, 'link');
    const answer = answerOf(link.id);
    pushLabel(withGifFallback(mediaLabelFor(link, { attachedIndex, description, unknownDuration, video: videoOf(link.id), read, gifHandle, answer })));
  }
  for (const sticker of message.stickers ?? []) {
    const attachedIndex = context.attachedIndex?.get(`sticker:${sticker.id}`) ?? null;
    const description = labels.transcript.stickerDescribed
      ? (context.descriptions?.get(`sticker:${sticker.id}`) ?? null)
      : null;
    // The slim memory buffer keeps no `url` (see src/memory/update.js
    // `observe()`) -- rebuild it from id/format when absent, so a memory
    // transcript tells a picture-format sticker from a Lottie one exactly
    // like a live chat transcript does.
    const url = sticker.url ?? stickerUrl(sticker.id, sticker.format);
    pushLabel(stickerLabelFor({ ...sticker, url }, { attachedIndex, description }));
  }
  // `context.emojiInline === false`: the request lists the emoji once in its
  // `<emoji>` block (src/behavior/prompt.js), so the line keeps the bare `:name:`.
  if (labels.transcript.emojiDescribed && context.emojiInline !== false) {
    for (const emoji of message.emojis ?? []) {
      const description = context.descriptions?.get(`emoji:${emoji.id}`) ?? null;
      if (!description) continue;
      tags.push(fill(labels.transcript.emojiDescribed, { name: emoji.name, text: description }));
    }
  }
  // A key blanked in prompts.local/labels.json (fill() returns '' for it)
  // must not leave a stray double space where that tag would have sat.
  return tags.filter(Boolean);
}

/**
 * The reactions tag of a message (`transcript.reactions` over at most `max`
 * items, `reactionMine` for the bot's own, else `reactionItem`), or '' when
 * the list is empty or the labels have no `transcript.reactions` key.
 */
function reactionsTag(message, labels, max) {
  const template = labels.transcript.reactions;
  const reactions = Array.isArray(message.reactions) ? message.reactions.slice(0, Math.max(0, max)) : [];
  if (!template || reactions.length === 0) return '';
  const list = reactions
    .map(({ emoji, count, mine }) =>
      fill(mine ? (labels.transcript.reactionMine ?? labels.transcript.reactionItem) : labels.transcript.reactionItem, { emoji, count }),
    )
    .filter(Boolean)
    .join(', ');
  return list ? fill(template, { list }) : '';
}

/**
 * What a reply line quotes of its parent: the parent's text on one line, else
 * its media tags (mediaTags) joined, cut to `maxChars` code points at a word
 * boundary with an ellipsis (src/memory/clamp.js#clampWithEllipsis; 0 =
 * whole); '' when the parent has neither.
 */
function replyQuote(parent, labels, context, maxChars) {
  const text = oneLine(parent.content) || oneLine(mediaTags(parent, labels, context).join(' '));
  return clampWithEllipsis(text, maxChars);
}

/**
 * The marker of a line that replies to `parent`, shown in the list as `#index`:
 * `labels.transcript.replyTo` with `{index}`, `{author}` (the parent's name,
 * `labels.self` filled with `selfName` for the persona's own line) and
 * `{quote}` (replyQuote under `replyQuoteChars`, 80 when omitted; 0 = whole;
 * `context` as mediaTags reads it, every map optional). The one copy for the
 * transcript and the GIF picker's `<reply>` (src/behavior/turn.js). Pure.
 * @param {object} parent  A normalized message.
 * @param {number} index
 * @param {{ labels: object, selfName: string, replyQuoteChars?: number, context?: object }} options
 * @returns {string}
 */
export function replyMarker(parent, index, { labels, selfName, replyQuoteChars, context = {} }) {
  const author = parent.self ? fill(labels.self, { name: selfName }) : parent.authorName;
  const quote = replyQuote(parent, labels, context, replyQuoteChars ?? DEFAULT_REPLY_QUOTE_CHARS);
  return fill(labels.transcript.replyTo, { index, author, quote });
}

/**
 * One forwarded message-snapshot, wrapped in `labels.transcript.forwardedFrom`
 * when the source channel's name is known AND that key is set (a key blanked
 * in prompts.local/labels.json switches this form off); otherwise the plain
 * `labels.transcript.forwarded`. A media-only snapshot (no text) still
 * renders its media tags inside the wrapper.
 */
function renderForwarded(snapshot, labels, context, maxChars, channelName) {
  const body = [];
  if (snapshot.content) body.push(clipWithEllipsis(snapshot.content, maxChars));
  body.push(...mediaTags(snapshot, labels, context));
  const text = body.filter(Boolean).join(' ').trim();
  if (channelName && labels.transcript.forwardedFrom) {
    return fill(labels.transcript.forwardedFrom, { channel: channelName, text });
  }
  return fill(labels.transcript.forwarded, { text });
}

/**
 * Format messages (oldest first) into transcript items, one per message.
 * `item.text` already carries the gap/date marker that precedes the message,
 * so dropping items from the start keeps the rest self-explanatory.
 *
 * @param {object[]} messages  Normalized messages, oldest first.
 * @param {object} options
 * @param {string} options.timezone
 * @param {number} options.gapMinutes   Silence longer than this gets a marker.
 * @param {number} options.maxChars     Per-message content limit.
 * @param {string} options.selfName     The persona's display name, used to fill `labels.self`.
 * @param {object} options.labels       Live `prompts.labels` (locale, self, units, transcript.*).
 * @param {'chat'|'memory'} [options.mode]  'memory' drops #indexes and adds user ids;
 *   it also groups by channel (see below).
 * @param {Map<string, number>} [options.attachedIndex]  Item id -> its 1-based
 *   position among this request's `image_url` parts (see
 *   src/behavior/prompt.js#selectPictures); renders `transcript.imageAttached`, or
 *   `transcript.imageAttachedDescribed` when `descriptions` also has a caption for it.
 * @param {Map<string, string>} [options.descriptions]  Item id -> a describer
 *   caption (src/memory/describe.js); renders the `*Described` label forms.
 * @param {Map<string, { state: 'watched'|'limit'|'error'|'pending', text?: string, reason?: string }>} [options.videos]
 *   Item id -> a video state (the video describer); renders the
 *   `videoWatched`/`videoNotWatched*`/`linkWatched`/`linkNotWatched*` forms.
 *   Ignored when the labels have no `transcript.videoWatched` key.
 * @param {Map<string, string>} [options.reads]  Link id -> the excerpt the web lookup read from
 *   that page (src/web/lookup.js); renders `transcript.linkRead`. Ignored when the labels have
 *   no `transcript.linkRead` key.
 * @param {Map<string, string>} [options.gifHandles]  The GIF library's handles
 *   (src/memory/gifs.js#gifHandleMap); a GIF it knows renders `transcript.gifKnown` /
 *   `transcript.gifKnownNoText` with its handle, falling back to `gifDescribed` / `gif`
 *   when the labels lack that key.
 * @param {Map<string, { question: string, text: string }>} [options.imageAnswers]  Picture id -> a
 *   second look on a question (src/memory/describe.js#relookImage); renders `transcript.imageAnswered`
 *   after the picture's tag. Ignored when the labels have no `transcript.imageAnswered` key.
 * @param {boolean} [options.seeReactions]  Default true: a message's `reactions` render as
 *   `transcript.reactions` at the end of its line. Ignored when the labels have no
 *   `transcript.reactions` key.
 * @param {number} [options.reactionsPerMessage]  Default 6: at most this many reactions per message.
 * @param {number} [options.replyQuoteChars]  `context.replyQuoteChars` (80 when omitted; 0 = whole):
 *   a reply to a message of the list renders `transcript.replyTo` with `{index}`, `{author}` (the
 *   parent's name, the persona's self label for its own line) and `{quote}` (replyQuote).
 * @param {boolean} [options.emojiInline]  Default true; false leaves out the `emojiDescribed` tag of a
 *   custom emoji (the request lists the emoji with their descriptions in `<emoji>` instead).
 * @param {number} [options.indexOffset]  Default 0 (when undefined or null): the first message
 *   is numbered `indexOffset + 1`, and every index (the `#index`, a reply target inside the
 *   list, `item.index`) shifts by it, so a second block (another channel's lines) continues
 *   the numbering of the first and its indices never collide with it.
 * @throws {RangeError} when `indexOffset` is given but is not an integer of at least 0.
 * @returns {{ id: string, index: number, ts: number, text: string }[]}
 *
 * In `mode: 'memory'`, messages come from possibly several channels (see
 * docs/prompt-contract.md, "The analyzer"): whenever the channel
 * changes between two consecutive messages — including before the very first
 * one — the item opens with a `## #channel-name (id:channelId)` heading, and
 * the gap/date marker is computed against the previous message of the SAME
 * channel run, never across a channel switch.
 */
export function formatTranscript(messages, options) {
  const { timezone, gapMinutes, maxChars, selfName, labels, mode = 'chat', attachedIndex, descriptions, videos, reads, gifHandles, imageAnswers } = options;
  const seeReactions = options.seeReactions ?? true;
  const reactionsPerMessage = options.reactionsPerMessage ?? 6;
  const replyQuoteChars = options.replyQuoteChars ?? DEFAULT_REPLY_QUOTE_CHARS;
  const mediaContext = { attachedIndex, descriptions, videos, reads, gifHandles, imageAnswers, emojiInline: options.emojiInline !== false };
  const locale = labels.locale;
  const selfLabel = fill(labels.self, { name: selfName });
  const indexOffset = options.indexOffset ?? 0;
  // A bad offset is a caller bug: counting it as 0 would renumber a second
  // block from #1 over the first block's indices, so a tag aimed at one line
  // would silently land on another.
  if (!Number.isInteger(indexOffset) || indexOffset < 0) {
    throw new RangeError(`formatTranscript: indexOffset must be an integer >= 0, got ${String(indexOffset)}`);
  }
  const indexById = new Map(messages.map((message, i) => [message.id, indexOffset + i + 1]));
  const byId = new Map(messages.map((message) => [message.id, message]));
  const items = [];
  let previous = null;
  let previousChannelId = NO_CHANNEL;

  for (const message of messages) {
    const index = indexById.get(message.id);
    const parts = [];

    const channelChanged = mode === 'memory' && message.channelId !== previousChannelId;
    if (channelChanged) {
      parts.push(`## #${message.channelName} (id:${message.channelId})`);
    }

    const gapPrevious = channelChanged ? null : previous;
    if (gapPrevious) {
      const gap = message.ts - gapPrevious.ts;
      const date = formatDate(message.ts, timezone, locale);
      const dayChanged = date !== formatDate(gapPrevious.ts, timezone, locale);
      if (gap >= gapMinutes * MINUTE_MS) {
        const duration = formatDuration(gap, labels.units);
        parts.push(dayChanged ? fill(labels.transcript.gapWithDate, { duration, date }) : fill(labels.transcript.gap, { duration }));
      } else if (dayChanged) {
        parts.push(fill(labels.transcript.date, { date }));
      }
    }

    const name = message.self ? selfLabel : message.authorName;
    const who = mode === 'memory' && !message.self ? `${name} (id:${message.authorId})` : name;
    const head = mode === 'memory' ? `[${formatClock(message.ts, timezone, locale)}]` : `#${index} [${formatClock(message.ts, timezone, locale)}]`;

    const body = [];
    if (message.content) body.push(clipWithEllipsis(message.content, maxChars));
    if (message.replyToId && mode === 'chat') {
      const target = indexById.get(message.replyToId);
      if (target) {
        body.push(replyMarker(byId.get(message.replyToId), target, { labels, selfName, replyQuoteChars, context: mediaContext }));
      } else {
        body.push(labels.transcript.replyToOld);
      }
    }
    body.push(...mediaTags(message, labels, mediaContext));
    for (const snapshot of message.forwarded ?? []) {
      body.push(renderForwarded(snapshot, labels, mediaContext, maxChars, message.forwardedFrom));
    }
    if (seeReactions) body.push(reactionsTag(message, labels, reactionsPerMessage));

    const marker = mode === 'memory' && message.direct ? DIRECT_MARKER : '';
    parts.push(`${marker}${head} ${who}: ${body.filter(Boolean).join(' ')}`.trimEnd());
    items.push({ id: message.id, index, ts: message.ts, text: parts.join('\n') });
    previous = message;
    previousChannelId = message.channelId;
  }

  return items;
}

/** Join kept items under a date header taken from the first surviving message. */
export function renderTranscript(items, timezone, labels) {
  if (items.length === 0) return labels.transcript.empty;
  return [fill(labels.transcript.header, { date: formatDate(items[0].ts, timezone, labels.locale) }), ...items.map((item) => item.text)].join(
    '\n',
  );
}

/**
 * Facts about the pace of a channel. `trigger` is the message that called the
 * persona (null for spontaneous turns, where silence is measured up to `now`).
 */
export function computeTempo(messages, now, trigger = null) {
  const others = trigger ? messages.filter((message) => message.id !== trigger.id) : messages;
  const edge = trigger ? trigger.ts : now;
  const within = (ms) => others.filter((message) => edge - message.ts <= ms && message.ts <= edge);
  const last = others.at(-1) ?? null;
  const lastOwn = [...others].reverse().find((message) => message.self) ?? null;
  const lastHour = within(HOUR_MS);

  return {
    last10min: within(10 * MINUTE_MS).length,
    lastHour: lastHour.length,
    lastDay: within(DAY_MS).length,
    authorsLastHour: new Set(lastHour.filter((message) => !message.self).map((message) => message.authorId)).size,
    silenceMs: last ? Math.max(0, edge - last.ts) : null,
    lastIsOwn: Boolean(last?.self),
    sinceOwnMs: lastOwn ? Math.max(0, now - lastOwn.ts) : null,
    hasTrigger: Boolean(trigger),
  };
}

// Defaults mirror config.json's context.tempo; used whenever the caller omits
// `thresholds` or one of its two keys (e.g. an older config.local.json).
const DEFAULT_TEMPO_THRESHOLDS = { liveMessages10min: 4, deadSilenceMinutes: 45 };

/**
 * Render the tempo block. The verdict looks at silence, not only at message
 * counts: a channel can have few messages in the last 10 minutes and still be
 * "live" if the silence right now is short (e.g. 2 messages 4-5 minutes ago).
 * `silenceMs` already means "silence before the trigger" in reply mode and
 * "time since the last message" in spontaneous mode (see computeTempo), so
 * one rule serves both.
 *
 * @param {object} tempo       Output of computeTempo.
 * @param {object} labels      Live prompts.labels.
 * @param {{liveMessages10min: number, deadSilenceMinutes: number}} [thresholds]
 *   Defaults to DEFAULT_TEMPO_THRESHOLDS when omitted or missing a key.
 */
export function renderTempo(tempo, labels, thresholds) {
  const liveMessages10min = thresholds?.liveMessages10min ?? DEFAULT_TEMPO_THRESHOLDS.liveMessages10min;
  const deadSilenceMinutes = thresholds?.deadSilenceMinutes ?? DEFAULT_TEMPO_THRESHOLDS.deadSilenceMinutes;
  const t = labels.tempo;
  const lines = [
    fill(t.counts, { last10min: tempo.last10min, lastHour: tempo.lastHour, lastDay: tempo.lastDay }),
    fill(t.authors, { authors: tempo.authorsLastHour }),
  ];
  if (tempo.silenceMs === null) {
    lines.push(t.emptyChannel);
  } else if (tempo.hasTrigger) {
    lines.push(fill(t.silenceBeforeTrigger, { duration: formatDuration(tempo.silenceMs, labels.units) }));
  } else {
    lines.push(fill(t.lastMessageAgo, { duration: formatDuration(tempo.silenceMs, labels.units) }));
  }
  if (tempo.sinceOwnMs !== null) {
    lines.push(fill(t.sinceOwn, { duration: formatDuration(tempo.sinceOwnMs, labels.units) }));
  }
  if (tempo.lastIsOwn && !tempo.hasTrigger) lines.push(t.ownUnanswered);

  let verdict;
  if (tempo.last10min >= liveMessages10min) verdict = t.verdictLive;
  else if (tempo.silenceMs === null || tempo.silenceMs >= deadSilenceMinutes * MINUTE_MS) verdict = t.verdictDead;
  else verdict = t.verdictSlow;
  lines.push(fill(t.verdict, { verdict }));
  return lines.join('\n');
}
