// Pure text formatting of normalized messages (see normalizeMessage in
// collect.js) into the transcript the model reads. No discord.js imports here,
// so everything is unit-testable. Every word that ends up in the prompt comes
// from `labels` (see prompts/labels.json and .claude/docs/prompt-contract.md);
// this module only knows the shape of a transcript line, e.g.:
//   #87 [14:32] nick: text (replyTo marker) [image]
//   --- {duration} passed ---
// Time gaps and date changes are spelled out because the model must tell a
// live conversation from a dead chat that somebody has just poked.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A language-neutral marker (memory transcript only) for a message addressed
// to the persona, so the analyzer can weigh "how people talk TO it" apart
// from general chatter. See .claude/docs/prompt-contract.md, "Memory update".
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

export function formatClock(ts, timezone, locale = 'en-US') {
  return formatter(timezone, locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
}

export function formatDate(ts, timezone, locale = 'en-US') {
  return formatter(timezone, locale, { weekday: 'short', day: 'numeric', month: 'long' }).format(ts);
}

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
  if (ms < MINUTE) return units.lessThanMinute;

  if (ms < HOUR) {
    const minutes = Math.round(ms / MINUTE);
    if (minutes >= 60) return `1 ${units.hour}`;
    return `${minutes} ${units.minute}`;
  }

  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    let minutes = Math.round((ms - hours * HOUR) / MINUTE);
    let wholeHours = hours;
    if (minutes >= 60) {
      wholeHours += 1;
      minutes = 0;
    }
    if (wholeHours >= 24) return `1 ${units.day}`;
    return minutes ? `${wholeHours} ${units.hour} ${minutes} ${units.minute}` : `${wholeHours} ${units.hour}`;
  }

  const days = Math.floor(ms / DAY);
  let hours = Math.round((ms - days * DAY) / HOUR);
  let wholeDays = days;
  if (hours >= 24) {
    wholeDays += 1;
    hours = 0;
  }
  return hours ? `${wholeDays} ${units.day} ${hours} ${units.hour}` : `${wholeDays} ${units.day}`;
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function attachmentTags(message, labels) {
  const tags = [];
  for (const attachment of message.attachments ?? []) {
    tags.push(attachment.kind === 'image' ? labels.transcript.image : fill(labels.transcript.file, { name: attachment.name }));
  }
  for (const sticker of message.stickers ?? []) tags.push(fill(labels.transcript.sticker, { name: sticker }));
  return tags;
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
 * @returns {{ id: string, index: number, ts: number, text: string }[]}
 *
 * In `mode: 'memory'`, messages come from possibly several channels (see
 * .claude/docs/prompt-contract.md, "Memory update"): whenever the channel
 * changes between two consecutive messages — including before the very first
 * one — the item opens with a `## #channel-name (id:channelId)` heading, and
 * the gap/date marker is computed against the previous message of the SAME
 * channel run, never across a channel switch.
 */
export function formatTranscript(messages, options) {
  const { timezone, gapMinutes, maxChars, selfName, labels, mode = 'chat' } = options;
  const locale = labels.locale;
  const selfLabel = fill(labels.self, { name: selfName });
  const indexById = new Map(messages.map((message, i) => [message.id, i + 1]));
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
      if (gap >= gapMinutes * MINUTE) {
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
    if (message.content) body.push(truncate(message.content, maxChars));
    if (message.replyToId && mode === 'chat') {
      const target = indexById.get(message.replyToId);
      body.push(target ? fill(labels.transcript.replyTo, { index: target }) : labels.transcript.replyToOld);
    }
    body.push(...attachmentTags(message, labels));

    const marker = mode === 'memory' && message.direct ? DIRECT_MARKER : '';
    parts.push(`${marker}${head} ${who}: ${body.join(' ')}`.trimEnd());
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
  const lastHour = within(HOUR);

  return {
    last10min: within(10 * MINUTE).length,
    lastHour: lastHour.length,
    lastDay: within(DAY).length,
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
  else if (tempo.silenceMs === null || tempo.silenceMs >= deadSilenceMinutes * MINUTE) verdict = t.verdictDead;
  else verdict = t.verdictSlow;
  lines.push(fill(t.verdict, { verdict }));
  return lines.join('\n');
}
