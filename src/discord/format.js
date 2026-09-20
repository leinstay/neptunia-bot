// Pure text formatting of normalized messages (see normalizeMessage in
// collect.js) into the transcript the model reads. No discord.js imports here,
// so everything is unit-testable. The line format is a contract shared with
// prompts/format.md:
//   #87 [14:32] nick: text (в ответ на #80) [картинка]
//   --- прошло 3 ч 12 мин ---
// Time gaps and date changes are spelled out because the model must tell a
// live conversation from a dead chat that somebody has just poked.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const formatters = new Map();

function formatter(timezone, options) {
  const key = timezone + JSON.stringify(options);
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, ...options }));
  }
  return formatters.get(key);
}

export function formatClock(ts, timezone) {
  return formatter(timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
}

export function formatDate(ts, timezone) {
  return formatter(timezone, { weekday: 'short', day: 'numeric', month: 'long' }).format(ts);
}

export function formatNow(ts, timezone) {
  const date = formatter(timezone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ts);
  return `${date}, ${formatClock(ts, timezone)} (${timezone})`;
}

/** Local hour 0–23 in the given timezone. */
export function localHour(ts, timezone) {
  return Number(formatter(timezone, { hour: 'numeric', hourCycle: 'h23' }).format(ts)) % 24;
}

/** "5 мин", "3 ч 12 мин", "2 дн 4 ч" — coarse on purpose. */
export function formatDuration(ms) {
  if (ms < MINUTE) return 'меньше минуты';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} мин`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms - hours * HOUR) / MINUTE);
    return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms - days * DAY) / HOUR);
  return hours ? `${days} дн ${hours} ч` : `${days} дн`;
}

function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function attachmentTags(message) {
  const tags = [];
  for (const attachment of message.attachments ?? []) {
    tags.push(attachment.kind === 'image' ? '[картинка]' : `[файл: ${attachment.name}]`);
  }
  for (const sticker of message.stickers ?? []) tags.push(`[стикер: ${sticker}]`);
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
 * @param {string} options.selfName     Her display name; own lines read "<name> (ты)".
 * @param {'chat'|'memory'} [options.mode]  'memory' drops #indexes and adds user ids.
 * @returns {{ id: string, index: number, ts: number, text: string }[]}
 */
export function formatTranscript(messages, options) {
  const { timezone, gapMinutes, maxChars, selfName, mode = 'chat' } = options;
  const indexById = new Map(messages.map((message, i) => [message.id, i + 1]));
  const items = [];
  let previous = null;

  for (const message of messages) {
    const index = indexById.get(message.id);
    const parts = [];

    if (previous) {
      const gap = message.ts - previous.ts;
      const dayChanged = formatDate(message.ts, timezone) !== formatDate(previous.ts, timezone);
      if (gap >= gapMinutes * MINUTE) {
        const day = dayChanged ? ` · ${formatDate(message.ts, timezone)}` : '';
        parts.push(`--- прошло ${formatDuration(gap)}${day} ---`);
      } else if (dayChanged) {
        parts.push(`--- ${formatDate(message.ts, timezone)} ---`);
      }
    }

    const name = message.self ? `${selfName} (ты)` : message.authorName;
    const who = mode === 'memory' && !message.self ? `${name} (id:${message.authorId})` : name;
    const head = mode === 'memory' ? `[${formatClock(message.ts, timezone)}]` : `#${index} [${formatClock(message.ts, timezone)}]`;

    const body = [];
    if (message.content) body.push(truncate(message.content, maxChars));
    if (message.replyToId && mode === 'chat') {
      const target = indexById.get(message.replyToId);
      body.push(target ? `(в ответ на #${target})` : '(в ответ на старое сообщение)');
    }
    body.push(...attachmentTags(message));

    parts.push(`${head} ${who}: ${body.join(' ')}`.trimEnd());
    items.push({ id: message.id, index, ts: message.ts, text: parts.join('\n') });
    previous = message;
  }

  return items;
}

/** Join kept items under a date header taken from the first surviving message. */
export function renderTranscript(items, timezone) {
  if (items.length === 0) return '(пусто)';
  return [`=== ${formatDate(items[0].ts, timezone)} ===`, ...items.map((item) => item.text)].join('\n');
}

/**
 * Facts about the pace of a channel. `trigger` is the message that called her
 * (null for spontaneous turns, where silence is measured up to `now`).
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

export function renderTempo(tempo) {
  const lines = [
    `сообщений за последние 10 минут: ${tempo.last10min}, за час: ${tempo.lastHour}, за сутки: ${tempo.lastDay}`,
    `разных людей за последний час: ${tempo.authorsLastHour}`,
  ];
  if (tempo.silenceMs === null) {
    lines.push('канал пустой, до этого никто ничего не писал');
  } else if (tempo.hasTrigger) {
    lines.push(`перед сообщением, которым тебя позвали, в канале молчали: ${formatDuration(tempo.silenceMs)}`);
  } else {
    lines.push(`последнее сообщение в канале было: ${formatDuration(tempo.silenceMs)} назад`);
  }
  if (tempo.sinceOwnMs !== null) {
    lines.push(`ты сама последний раз писала сюда: ${formatDuration(tempo.sinceOwnMs)} назад`);
  }
  if (tempo.lastIsOwn && !tempo.hasTrigger) lines.push('последнее сообщение в канале твоё, на него никто не ответил');

  let verdict = 'мёртвый чат';
  if (tempo.last10min >= 4) verdict = 'живой разговор идёт прямо сейчас';
  else if (tempo.lastHour >= 3) verdict = 'вялый разговор, пишут редко';
  lines.push(`итог: ${verdict}`);
  return lines.join('\n');
}
