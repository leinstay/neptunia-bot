// Pure logic for the server memory: how alive a channel is (computed from
// real message statistics, never the model's call — see
// docs/prompt-contract.md, "Server memory (the channel map)") and how
// one channel entry is rendered into the <server> prompt block. No I/O here;
// `now` and the channel record are always injected.

import { fill, formatDuration } from '../discord/format.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_ACTIVITY_THRESHOLDS = { liveMessagesPerDay: 20, deadAfterDays: 7 };

function utcDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * How alive a channel is, from stored message statistics only.
 * `live`   — today's + yesterday's (UTC) message counts reach `liveMessagesPerDay`.
 * `dead`   — never seen a message, or the last one is older than `deadAfterDays`.
 * `slow`   — anything in between.
 *
 * @param {{ days?: Record<string, number>, lastMessageAt?: number|null }} channel
 * @param {number} now
 * @param {{ liveMessagesPerDay?: number, deadAfterDays?: number }} [cfg]  Defaults to
 *   DEFAULT_ACTIVITY_THRESHOLDS when omitted or missing a key.
 * @returns {'live'|'slow'|'dead'}
 */
export function channelActivity(channel, now, cfg) {
  const liveMessagesPerDay = cfg?.liveMessagesPerDay ?? DEFAULT_ACTIVITY_THRESHOLDS.liveMessagesPerDay;
  const deadAfterDays = cfg?.deadAfterDays ?? DEFAULT_ACTIVITY_THRESHOLDS.deadAfterDays;
  const days = channel?.days ?? {};

  const todayKey = utcDateKey(now);
  const yesterdayKey = utcDateKey(now - DAY_MS);
  const recent = (days[todayKey] ?? 0) + (days[yesterdayKey] ?? 0);
  if (recent >= liveMessagesPerDay) return 'live';

  const lastMessageAt = channel?.lastMessageAt ?? null;
  if (lastMessageAt === null || now - lastMessageAt > deadAfterDays * DAY_MS) return 'dead';

  return 'slow';
}

/**
 * The `labels.server.topWriters` line's `{names}`: up to the stored `topWriters`' current names
 * (`nameOf`, the store's `profile.names[0]`), in the stored (count-descending) order,
 * comma-separated -- an id `nameOf` cannot resolve (no profile, e.g. someone who left) is skipped
 * silently, never rendered as a bare id. `''` when there is nothing to show, or when `nameOf` is
 * missing.
 * @param {{id: string, count: number}[]} topWriters
 * @param {(id: string) => (string|null)} [nameOf]
 */
function topWritersText(topWriters, nameOf) {
  if (!Array.isArray(topWriters) || topWriters.length === 0 || typeof nameOf !== 'function') return '';
  return topWriters
    .map((writer) => nameOf(writer?.id))
    .filter((name) => typeof name === 'string' && name)
    .join(', ');
}

/**
 * Render one channel entry for the <server> prompt block.
 *
 * @param {{ name: string, category?: string|null, topic?: string|null, purpose?: string,
 *   topics?: string, tone?: string, lastMessageAt?: number|null,
 *   topWriters?: {id: string, count: number}[] }} channel
 * @param {object} labels  Live `prompts.labels`; uses `labels.server.*`/`labels.units`.
 * @param {{ current?: boolean, activity: 'live'|'slow'|'dead', now?: number,
 *   nameOf?: (id: string) => (string|null) }} options  `now` and `labels.server.lastMessage`
 *   together render "how long ago the last message was" (`formatDuration`, the same humanised-age
 *   helper the `<tempo>` block uses); `nameOf` and `labels.server.topWriters` together render who
 *   writes here most. Either fact is omitted -- not rendered as an empty/placeholder line -- when
 *   its label is missing (an older labels.json never breaks), when the underlying data is missing,
 *   or (for the last-message line) when `now` was not given.
 * @returns {string}
 */
export function renderChannel(channel, labels, { current = false, activity, now, nameOf } = {}) {
  const s = labels.server;
  const mark = current ? s.currentMark : '';
  const lines = [`# ${channel.name}${mark}`];

  if (channel.category) lines.push(fill(s.category, { text: channel.category }));
  if (channel.topic) lines.push(fill(s.topic, { text: channel.topic }));
  if (channel.purpose) lines.push(fill(s.purpose, { text: channel.purpose }));
  if (channel.topics) lines.push(fill(s.topics, { text: channel.topics }));
  if (channel.tone) lines.push(fill(s.tone, { text: channel.tone }));

  if (s.lastMessage && Number.isFinite(channel.lastMessageAt) && Number.isFinite(now)) {
    const when = formatDuration(Math.max(0, now - channel.lastMessageAt), labels.units);
    lines.push(fill(s.lastMessage, { when }));
  }

  const topWritersLine = s.topWriters ? topWritersText(channel.topWriters, nameOf) : '';
  if (topWritersLine) lines.push(fill(s.topWriters, { names: topWritersLine }));

  const activityLabel = { live: s.activityLive, slow: s.activitySlow, dead: s.activityDead }[activity];
  lines.push(fill(s.activity, { activity: activityLabel }));

  return lines.join('\n');
}
