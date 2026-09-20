// Pure logic for the server memory: how alive a channel is (computed from
// real message statistics, never the model's call — see
// .claude/docs/prompt-contract.md, "Server memory (the channel map)") and how
// one channel entry is rendered into the <server> prompt block. No I/O here;
// `now` and the channel record are always injected.

import { fill } from '../discord/format.js';

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
 * Render one channel entry for the <server> prompt block.
 *
 * @param {{ name: string, category?: string|null, topic?: string|null, purpose?: string,
 *   topics?: string, tone?: string }} channel
 * @param {object} labels  Live `prompts.labels`; uses `labels.server.*`.
 * @param {{ current?: boolean, activity: 'live'|'slow'|'dead' }} options
 * @returns {string}
 */
export function renderChannel(channel, labels, { current = false, activity } = {}) {
  const s = labels.server;
  const mark = current ? s.currentMark : '';
  const lines = [`# ${channel.name}${mark}`];

  if (channel.category) lines.push(fill(s.category, { text: channel.category }));
  if (channel.topic) lines.push(fill(s.topic, { text: channel.topic }));
  if (channel.purpose) lines.push(fill(s.purpose, { text: channel.purpose }));
  if (channel.topics) lines.push(fill(s.topics, { text: channel.topics }));
  if (channel.tone) lines.push(fill(s.tone, { text: channel.tone }));

  const activityLabel = { live: s.activityLive, slow: s.activitySlow, dead: s.activityDead }[activity];
  lines.push(fill(s.activity, { activity: activityLabel }));

  return lines.join('\n');
}
