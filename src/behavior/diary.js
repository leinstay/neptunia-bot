// The persona keeps a diary: one owner-chosen channel where it posts on its
// own, rarely and irregularly, the way a person runs a personal feed. This
// module owns the diary's decisions: which local times of a day get a post
// (configured windows in `bot.timezone`, quiet days, a minimum gap, a daily
// cap), which planned slot is due now (a slot missed by more than the grace
// while the bot was down is dropped, never fired late in a burst), which kind
// of post a plan names (validated against the weighted `diary.kinds`, with a
// weighted random fallback), and how the post history, the kinds and the
// random seeds are rendered for the plan and compose requests. All wording
// comes from `labels.diary.*`; kind keys are config keys.
//
// Pure: randomness and the clock are injected (`rng`, `nowMs`). The factory
// that ticks, runs the turn and keeps the day plan in state.json comes later
// in this module; nothing here touches discord.js, the disk or the model.

import { fill } from '../discord/format.js';
import { oneLine, clampText } from '../memory/clamp.js';
import { MINUTE_MS, zonedDay, zonedEpoch, utcDay } from '../time.js';

/** The daily counter of diary posts in state.json (src/time.js dailyCounter / bumpDaily). */
export const DIARY_DAILY = { dayKey: 'diaryDay', countKey: 'diaryPosts' };
/** The daily counter of diary pictures in state.json (src/time.js dailyCounter / bumpDaily). */
export const DIARY_PICTURES_DAILY = { dayKey: 'diaryPicturesDay', countKey: 'diaryPictures' };

const BRIEF_CHARS = 300;
const DEFAULT_GRACE_MINUTES = 30; // diary.slotGraceMinutes
const DEFAULT_MAX_PER_DAY = 3; // diary.maxPerDay
const DEFAULT_HISTORY_POSTS = 150; // diary.historyPosts
const DEFAULT_GIST_CHARS = 200; // diary.gistChars
const DEFAULT_SEARCH_KINDS = ['news', 'facts']; // diary.searchKinds
const DEFAULT_FAMILY = 'seed';
const URL_RE = /https?:///iu;

/**
 * The local date key (`YYYY-MM-DD`) of `nowMs` in `timezone` (UTC when missing).
 * @param {number} nowMs
 * @param {string} [timezone]  IANA zone name.
 * @returns {string}
 */
export function localDayKey(nowMs, timezone) {
  return zonedDay(nowMs, timezone || 'UTC');
}

/** The date key one day after `dayKey`. */
function nextDayKey(dayKey) {
  const [year, month, day] = dayKey.split('-').map(Number);
  return utcDay(Date.UTC(year, month - 1, day + 1));
}

/** A whole hour 0..24, or null. */
function hourOf(value) {
  return Number.isInteger(value) && value >= 0 && value <= 24 ? value : null;
}

/** A non-negative whole count, or 0. */
function countOf(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The instant of `hour`:00 local on `dayKey`, 24 meaning the next day's midnight. */
function hourInstant(dayKey, hour, timezone) {
  return hour === 24 ? zonedEpoch(nextDayKey(dayKey), 0, 0, timezone) : zonedEpoch(dayKey, hour, 0, timezone);
}

/** `[start, end)` of one window on the local day `dayKey`, or null for a malformed window. A window
 * whose `to` is not after `from` ends the next day (18 -> 1 runs 18:00 to 01:00); `from === to` is a
 * whole day. */
function windowSpan(window, dayKey, timezone) {
  const from = hourOf(window?.from);
  const to = hourOf(window?.to);
  if (from === null || to === null || from === 24) return null;
  const start = hourInstant(dayKey, from, timezone);
  const end = to > from ? hourInstant(dayKey, to, timezone) : hourInstant(nextDayKey(dayKey), to, timezone);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return [start, end];
}

/**
 * The diary's plan for the local day of `nowMs`. With chance `quietDayChance`
 * the day is quiet (no slots). Otherwise every window draws its count
 * `min + floor(rng() * (max - min + 1))` from `posts: [min, max]` and places
 * that many slots uniformly inside itself (local hours; a window with `to <=
 * from` ends the next day); the slots are sorted, a slot closer than
 * `minGapMinutes` to the previous kept one is dropped, and the rest is cut to
 * the first `maxPerDay`. Slots already past at planning time are kept:
 * dueSlot decides what still fires. A malformed window is skipped.
 * @param {{ windows?: Array<{ from: number, to: number, posts: [number, number] }>, quietDayChance?: number,
 *   minGapMinutes?: number, maxPerDay?: number }} cfg  config.diary
 * @param {number} nowMs
 * @param {string} [timezone]  bot.timezone
 * @param {() => number} rng
 * @returns {{ day: string, slots: number[], quiet: boolean, done: number[] }}
 */
export function planDay(cfg, nowMs, timezone, rng) {
  const zone = timezone || 'UTC';
  const day = localDayKey(nowMs, zone);
  const quiet = rng() < (cfg?.quietDayChance ?? 0.3);
  if (quiet) return { day, slots: [], quiet: true, done: [] };

  const placed = [];
  for (const window of Array.isArray(cfg?.windows) ? cfg.windows : []) {
    const min = countOf(window?.posts?.[0]);
    const max = Math.max(min, countOf(window?.posts?.[1]));
    const n = min + Math.floor(rng() * (max - min + 1));
    const span = windowSpan(window, day, zone);
    if (!span) continue;
    const [start, end] = span;
    for (let i = 0; i < n; i += 1) placed.push(Math.floor(start + rng() * (end - start)));
  }
  placed.sort((a, b) => a - b);

  const gapMs = Math.max(0, cfg?.minGapMinutes ?? 90) * MINUTE_MS;
  const slots = [];
  for (const slot of placed) {
    if (slots.length > 0 && slot - slots[slots.length - 1] < gapMs) continue;
    slots.push(slot);
  }
  return { day, slots: slots.slice(0, countOf(cfg?.maxPerDay ?? DEFAULT_MAX_PER_DAY)), quiet: false, done: [] };
}

/**
 * The slot of `plan` to run at `nowMs`. Among the slots at or before `nowMs`
 * that are not in `plan.done`, those older than `graceMinutes` are `dropped`
 * (the caller marks them done without firing them) and the oldest remaining
 * one is the `slot`. Null when nothing is due and nothing is dropped;
 * `{ slot: null, dropped }` when every due slot was missed.
 * @param {{ slots?: number[], done?: number[] }} plan
 * @param {number} nowMs
 * @param {number} [graceMinutes]  diary.slotGraceMinutes
 * @returns {{ slot: number|null, dropped: number[] }|null}
 */
export function dueSlot(plan, nowMs, graceMinutes) {
  const done = new Set(Array.isArray(plan?.done) ? plan.done : []);
  const graceMs = Math.max(0, graceMinutes ?? DEFAULT_GRACE_MINUTES) * MINUTE_MS;
  const due = (Array.isArray(plan?.slots) ? plan.slots : [])
    .filter((slot) => Number.isFinite(slot) && slot <= nowMs && !done.has(slot))
    .sort((a, b) => a - b);
  const dropped = due.filter((slot) => nowMs - slot > graceMs);
  const live = due.filter((slot) => nowMs - slot <= graceMs);
  if (live.length === 0 && dropped.length === 0) return null;
  return { slot: live[0] ?? null, dropped };
}

/** The `[key, weight]` pairs of `kinds` with a finite positive weight, in key order. */
function weightedKinds(kinds) {
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) return [];
  return Object.entries(kinds).filter(([, weight]) => Number.isFinite(weight) && weight > 0);
}

/**
 * One kind key drawn from `kinds` (`{ key: weight }`, `diary.kinds`) in
 * proportion to its weight; a kind with a weight of 0 or less is never drawn.
 * Null when no kind has a positive weight.
 * @param {Record<string, number>} kinds
 * @param {() => number} rng
 * @returns {string|null}
 */
export function pickKind(kinds, rng) {
  const entries = weightedKinds(kinds);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    if (roll < weight) return key;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

/**
 * The plan request's answer, normalised. `kind` must be a key of `kinds` with
 * a positive weight, else the whole answer is replaced by a weighted random
 * kind (pickKind; null when no kind is weighted) with an empty brief and
 * search (`fallback: true`). `brief` is one line, at most 300 characters;
 * `search` is kept only for a kind in `searchKinds`; `picture` is true only
 * when the answer says `true` and `pictureAllowed`.
 * @param {unknown} parsed  The JSON the model answered (untrusted).
 * @param {Record<string, number>} kinds  diary.kinds
 * @param {{ pictureAllowed?: boolean, searchKinds?: string[] }} opts  searchKinds: diary.searchKinds
 * @param {() => number} rng
 * @returns {{ kind: string|null, brief: string, search: string, picture: boolean, fallback: boolean }}
 */
export function validatePlan(parsed, kinds, { pictureAllowed = false, searchKinds } = {}, rng) {
  const answer = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const picture = answer.picture === true && pictureAllowed === true;
  const valid = weightedKinds(kinds).some(([key]) => key === answer.kind);
  if (!valid) return { kind: pickKind(kinds, rng), brief: '', search: '', picture, fallback: true };
  const searchable = Array.isArray(searchKinds) ? searchKinds : DEFAULT_SEARCH_KINDS;
  const brief = typeof answer.brief === 'string' ? clampText(oneLine(answer.brief), BRIEF_CHARS, { tolerance: 1 }) : '';
  const search = typeof answer.search === 'string' && searchable.includes(answer.kind) ? oneLine(answer.search) : '';
  return { kind: answer.kind, brief, search, picture, fallback: false };
}

/** The picture suffix of one post: the scene, `pictureUnknown` for a picture with no recorded
 * scene (`true` or ''), nothing for no picture. */
function pictureSuffix(picture, labels) {
  if (typeof picture === 'string' && picture.trim()) return fill(labels.diary?.picture, { scene: oneLine(picture) });
  if (picture === true || picture === '') return fill(labels.diary?.picture, { scene: labels.diary?.pictureUnknown ?? '' });
  return '';
}

/**
 * The body of the `<diary>` block: `labels.diary.intro`, then one
 * `labels.diary.line` per post (`{date}` the post's local date in
 * `timezone`, `{kind}` its kind key or `labels.diary.kindUnknown`, `{gist}`)
 * with `labels.diary.picture` appended when the post had a picture. The
 * newest `max` posts, oldest first. '' when there is no post.
 * @param {Array<{ at: number, kind: string|null, gist: string, picture?: string|boolean|null }>} posts  Oldest first.
 * @param {object} labels
 * @param {{ timezone?: string, max?: number }} [opts]  max: diary.historyPosts
 * @returns {string}
 */
export function renderDiaryBlock(posts, labels, { timezone, max } = {}) {
  const list = Array.isArray(posts) ? posts : [];
  const limit = countOf(max ?? DEFAULT_HISTORY_POSTS);
  const shown = limit > 0 ? list.slice(-limit) : [];
  if (shown.length === 0) return '';
  const lines = shown.map((post) => {
    const date = Number.isFinite(post?.at) ? localDayKey(post.at, timezone) : '';
    const kind = typeof post?.kind === 'string' && post.kind ? post.kind : labels.diary?.kindUnknown ?? '';
    const line = fill(labels.diary?.line, { date, kind, gist: oneLine(post?.gist) });
    return line + pictureSuffix(post?.picture, labels);
  });
  return [labels.diary?.intro, ...lines].filter(Boolean).join('\n');
}

/**
 * The body of the `<kinds>` block: `labels.diary.kinds`, then one
 * `labels.diary.kindLine` per kind with a positive weight (`{key}`,
 * `{weight}`, `{count}` its uses among the newest `window` posts, `{window}`
 * how many posts that is). '' when no kind is weighted.
 * @param {Record<string, number>} kinds  diary.kinds
 * @param {Array<{ kind: string|null }>} posts  Oldest first.
 * @param {object} labels
 * @param {{ window?: number }} [opts]  window: diary.historyPosts
 * @returns {string}
 */
export function renderKindsBlock(kinds, posts, labels, { window } = {}) {
  const entries = weightedKinds(kinds);
  if (entries.length === 0) return '';
  const limit = countOf(window ?? DEFAULT_HISTORY_POSTS);
  const recent = limit > 0 && Array.isArray(posts) ? posts.slice(-limit) : [];
  const lines = entries.map(([key, weight]) =>
    fill(labels.diary?.kindLine, {
      key,
      weight,
      count: recent.filter((post) => post?.kind === key).length,
      window: recent.length,
    }),
  );
  return [labels.diary?.kinds, ...lines].filter(Boolean).join('\n');
}

/**
 * The seed families of `prompts['diary-seeds']`: a `# name` line starts a
 * family, every other non-blank line (trimmed) is one seed of the current
 * family; lines before the first header belong to the family `seed`. Families
 * keep their header order; a header with no lines is an empty family.
 * @param {unknown} text
 * @returns {Record<string, string[]>}
 */
export function parseSeedFamilies(text) {
  const families = {};
  if (typeof text !== 'string') return families;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^#+\s*(.+)$/.exec(line);
    if (header) {
      current = header[1].trim();
      families[current] ??= [];
      continue;
    }
    if (current === null) {
      current = DEFAULT_FAMILY;
      families[current] ??= [];
    }
    families[current].push(line);
  }
  return families;
}

/**
 * `sets` seed combinations: each one random line of every non-empty family,
 * in the families' order. [] when no family has a line or `sets` is not a
 * positive count.
 * @param {Record<string, string[]>} families  parseSeedFamilies
 * @param {number} sets  diary.seedSets
 * @param {() => number} rng
 * @returns {string[][]}
 */
export function pickSeeds(families, sets, rng) {
  const lists = Object.values(families && typeof families === 'object' ? families : {}).filter(
    (lines) => Array.isArray(lines) && lines.length > 0,
  );
  const count = countOf(sets);
  if (lists.length === 0 || count === 0) return [];
  const result = [];
  for (let i = 0; i < count; i += 1) {
    result.push(lists.map((lines) => lines[Math.min(lines.length - 1, Math.floor(rng() * lines.length))]));
  }
  return result;
}

/**
 * The body of the `<seeds>` block: `labels.diary.seeds`, then one `- a; b; c`
 * line per combination. '' when there is none.
 * @param {string[][]} sets  pickSeeds
 * @param {object} labels
 * @returns {string}
 */
export function renderSeedsBlock(sets, labels) {
  const lines = (Array.isArray(sets) ? sets : [])
    .filter((set) => Array.isArray(set) && set.length > 0)
    .map((set) => `- ${set.join('; ')}`);
  if (lines.length === 0) return '';
  return [labels.diary?.seeds, ...lines].filter(Boolean).join('\n');
}

/**
 * `text` with every http(s) URL removed (an `<url>` wrapper included) and the
 * spaces the removal leaves collapsed; lines are kept. Text with no URL is
 * returned as it is.
 * @param {unknown} text
 * @returns {string}
 */
export function stripUrls(text) {
  const value = String(text ?? '');
  if (!URL_RE.test(value)) return value;
  return value
    .replace(/<?https?:\/\/[^\s>]+>?/giu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .trim();
}

/**
 * A post's one-line gist for diary.json: whitespace collapsed, then cut at a
 * word boundary to at most `chars` characters (diary.gistChars).
 * @param {unknown} text
 * @param {number} [chars]
 * @returns {string}
 */
export function gistOf(text, chars) {
  return clampText(oneLine(text), chars ?? DEFAULT_GIST_CHARS, { tolerance: 1 });
}
