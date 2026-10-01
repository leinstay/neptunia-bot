// Owner commands, driven by Discord slash commands (src/discord/commands.js)
// so the owner can tune the running bot from Discord without a restart and
// without ever touching data/: live rules (prompts.local/rules.md, seeded
// from prompts/rules.md), config overrides (config.local.json, hot-reloaded),
// status, a manual interject/initiate of the spontaneous scheduler, and
// profile inspection/deletion. This is the ONLY place in the project that ever
// deletes stored memory, through the three functions store.js allows for it:
// store.forgetUser (one profile, private layer included), store.forgetPrivate
// (one member's private layer only, `/nep private forget` and
// `/nep private purge`) and
// store.wipeGuild (a whole guild's memory,
// `/nep memory wipe`, gated by the served guild's exact name). The tracked
// prompts/ layer is never written at runtime — live corrections always land
// in the untracked prompts.local/ layer.
//
// This module knows nothing about discord.js: `createAdmin(deps).run` takes
// a `commandKey` (e.g. `'memory.forget'`), a plain `args` object and a
// `context` (`{ guildId, channelId, userId }`) and returns the reply text
// (or, for `/nep draw` and `/nep mentor show`, `{ text, files }` with the
// picture or the report file), or throws an
// `Error` with an operator-facing message on bad input. Mapping a
// discord.js interaction's options onto `args` is src/discord/commands.js's
// job. Everything below the pure-function section is thin I/O glued around
// them; the pure functions (listRules, appendRule, removeRule, setPath,
// unsetPath) are unit-tested directly with no filesystem or Discord involved.

import fs from 'node:fs';
import path from 'node:path';
import { emptyAffinity, affinityBand, roundScore } from './memory/affinity.js';
import { topByRank, sortByRank } from './memory/ranking.js';
import { fromTokens } from './memory/mentions.js';
import { sortEpisodesForDisplay } from './memory/episodes.js';
import { channelActivity } from './memory/channels.js';
import { rankEmojiUsage } from './memory/emoji-usage.js';
import { rankGifs } from './memory/gifs.js';
import { commandKeys } from './discord/commands.js';
import { isAllowed as accessIsAllowed, isOwnerOnly, grant as accessGrant, revoke as accessRevoke } from './discord/access.js';
import { classifierTextModel, classifierMediaModel, classifierVideoModel } from './behavior/mention.js';
import { buildDrawPrompt } from './behavior/prompt.js';
import { effectiveAffinity } from './behavior/private.js';
import { ImageCapError, ImageGenError, UnsupportedImageModelError, familyOf as imageFamilyOf } from './llm/images.js';
import { matchRoute, resolveProvider } from './llm/openrouter.js';
import { anchorMax, checkCaseText } from './mentor/cases.js';
import { renderCard, renderFile, renderLastRun } from './mentor/report.js';
import { log } from './log.js';

/** `/nep access grant/revoke`'s command keys that ONLY read — everything else (including every
 * group and `*`) is treated as opening a write command, and gets the "changes memory or config"
 * note in the grant reply. The owner-only `private` and `mentor` commands are never grantable at all
 * (src/discord/access.js#isOwnerOnly), so they are not listed here. Kept in sync by hand with the read-only command list in AGENTS/README;
 * a new read-only command is simply added here. */
const READ_ONLY_ACCESS_KEYS = new Set([
  'status',
  'ping',
  'memory.show',
  'memory.channel',
  'memory.server',
  'rule.list',
  'lore.list',
  'lore.show',
  'learned.list',
  'model.show',
  'emoji.status',
  'gifs.status',
  'warmup.status',
  'warmup.people',
  'access.list',
  'route.list',
]);

/** How `/nep access grant` names each owner-only group (src/discord/access.js#OWNER_ONLY_GROUPS) when it refuses it. */
const OWNER_ONLY_NAMES = { private: 'private memory', mentor: 'the mentor' };

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Locate the bullet lines (`- …`) that belong to the rules list: those under
 * the LAST `## ` heading of the file, in whatever language it is written.
 * When the file has no `## ` heading at all, every top-level bullet counts.
 */
function locateBullets(text) {
  const lines = text.split('\n');
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^## /.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }

  let start = 0;
  let end = lines.length;

  if (headingIdx !== -1) {
    start = headingIdx + 1;
    end = lines.length;
    for (let i = start; i < lines.length; i += 1) {
      if (/^#/.test(lines[i])) {
        end = i;
        break;
      }
    }
  }

  const indices = [];
  for (let i = start; i < end; i += 1) {
    if (/^- /.test(lines[i])) indices.push(i);
  }
  return { lines, indices };
}

/**
 * Bullet texts (lines starting with `- `) under the last `## ` heading of the
 * file, in order. When the file has no `## ` heading at all, every top-level
 * `- ` bullet in the file is returned instead.
 */
export function listRules(rulesText) {
  const { lines, indices } = locateBullets(String(rulesText ?? ''));
  return indices.map((i) => lines[i].slice(2).trimEnd());
}

/**
 * Append `- <rule>` as the last line of `rulesText`. Newlines inside `rule`
 * collapse to single spaces (the file's rule list stays one bullet per
 * line). When the file has no `## ` heading at all, a plain `## Rules`
 * heading is created first — this technical fallback marker, not persona
 * text. Trailing whitespace of the result is normalized to exactly one
 * final `\n`.
 */
export function appendRule(rulesText, rule) {
  let text = String(rulesText ?? '');
  const singleLine = String(rule)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  if (!/^## /m.test(text)) {
    text = `${text.replace(/\s*$/, '')}\n\n## Rules\n\n`;
  }

  text = `${text.replace(/\s*$/, '')}\n- ${singleLine}`;
  return `${text}\n`;
}

/**
 * Remove the 1-based n-th bullet (in `listRules` order). Returns
 * `{ text, removed }`, or null when `n` is out of range.
 */
export function removeRule(rulesText, n) {
  const text = String(rulesText ?? '');
  const { lines, indices } = locateBullets(text);
  if (!Number.isInteger(n) || n < 1 || n > indices.length) return null;

  const lineIdx = indices[n - 1];
  const removed = lines[lineIdx].slice(2).trimEnd();
  const remaining = [...lines.slice(0, lineIdx), ...lines.slice(lineIdx + 1)].join('\n');
  const trimmed = remaining.replace(/\s*$/, '');
  return { text: trimmed ? `${trimmed}\n` : '', removed };
}

function splitPath(dottedPath) {
  const parts = String(dottedPath).split('.').filter((part) => part.length > 0);
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) throw new Error(`forbidden path segment: ${part}`);
  }
  return parts;
}

/** Deep copy of `object` with `value` set at `dottedPath`, creating intermediate objects. */
export function setPath(object, dottedPath, value) {
  const parts = splitPath(dottedPath);
  const root = structuredClone(object ?? {});
  let node = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const child = node[key];
    node[key] = child && typeof child === 'object' && !Array.isArray(child) ? child : {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
  return root;
}

/** Deep copy of `object` with the key at `dottedPath` removed; empty parent objects are pruned. */
export function unsetPath(object, dottedPath) {
  const parts = splitPath(dottedPath);
  const root = structuredClone(object ?? {});
  const chain = [root];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const node = chain[chain.length - 1];
    const key = parts[i];
    if (node === null || typeof node !== 'object' || !(key in node)) return root;
    chain.push(node[key]);
  }

  const leaf = chain[chain.length - 1];
  if (leaf && typeof leaf === 'object') delete leaf[parts[parts.length - 1]];

  for (let i = chain.length - 1; i >= 1; i -= 1) {
    const obj = chain[i];
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === 0) {
      delete chain[i - 1][parts[i - 1]];
    } else {
      break;
    }
  }
  return root;
}

/** `, last YYYY-MM-DD` for `/nep memory show`, or '' when `lastSeen` is unknown. */
function lastDateSuffix(lastSeen) {
  return typeof lastSeen === 'string' && lastSeen ? `, last ${lastSeen.slice(0, 10)}` : '';
}

/**
 * Every stored `items`, in RANK order (src/memory/ranking.js#topByRank,
 * decayed with `halfLifeDays`), formatted one per line via `formatLine`, with
 * a divider line inserted right after the top `maxShown` -- the ones the
 * persona actually sees (see docs/prompt-contract.md, "More is stored
 * than shown, and rank decays with age") -- so `/nep memory show` makes the
 * gap between "stored" and "shown" visible. `maxShown` not an integer ->
 * every item is shown, no divider. Never throws on an empty `items`.
 * @param {object[]} items
 * @param {number} [maxShown]
 * @param {number} [halfLifeDays]
 * @param {(item: object) => string} formatLine
 * @returns {string[]}
 */
function rankedLines(items, maxShown, halfLifeDays, formatLine) {
  const ordered = topByRank(items, undefined, halfLifeDays);
  const cap = Number.isInteger(maxShown) ? maxShown : ordered.length;
  const lines = [];
  ordered.forEach((item, index) => {
    if (index === cap) lines.push('  -- not shown to the persona (below the shown cap) --');
    lines.push(`  ${formatLine(item)}`);
  });
  return lines;
}

// ---------------------------------------------------------------------------
// `/nep memory show` — sectioned view
// ---------------------------------------------------------------------------

/** The `section` choices `/nep memory show` accepts; anything else falls back to `'summary'`. */
const MEMORY_SHOW_SECTIONS = new Set([
  'summary',
  'character',
  'style',
  'relationship',
  'affinity',
  'aliases',
  'interests',
  'details',
  'episodes',
  'raw',
]);

/** Owner-configurable list length for `/nep memory show`'s per-section views. */
const MEMORY_SHOW_DEFAULT_LIMIT = 25;
const MEMORY_SHOW_MAX_LIMIT = 100;

/** Hard ceiling for the `summary` section: the whole reply must fit a single
 * Discord message (2000 chars) — comfortably under that even after the
 * code-fence wrapping src/discord/commands.js#respond adds. */
const SUMMARY_MAX_CHARS = 1800;

const DIVIDER_LINE = '-- not shown to the persona (below the shown cap) --';

/** `iso` parsed to epoch ms, or 0 when missing/unparsable — never NaN, so callers can sort safely. */
function dateMs(iso) {
  const ms = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * `value` clamped to `maxChars`, with an ellipsis and (when `sectionName` is
 * given) a pointer to the section that shows it in full, appended once it had
 * to be cut. A short-enough value passes through unchanged, with no pointer.
 */
function truncateForSummary(value, maxChars, sectionName) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return sectionName ? `${cut}… (full text: section ${sectionName})` : `${cut}…`;
}

/**
 * `/nep memory show`'s default view: a compact, human-readable digest of one
 * profile GUARANTEED to fit a single Discord message (see `SUMMARY_MAX_CHARS`)
 * — long fields are truncated with an ellipsis and, when the full text lives
 * under its own section, a pointer to it. `<@id>` tokens in free-text fields
 * are resolved via `nameOf` the same way every other analyzer-facing text is
 * (src/memory/mentions.js#fromTokens, mode `'analyzer'`). Pure: no I/O.
 * @param {object} profile
 * @param {object} [memoryCfg]  hot.config.memory
 * @param {(id: string) => (string|null)} [nameOf]
 * @returns {string}
 */
export function buildProfileSummary(profile, memoryCfg = {}, nameOf = () => null) {
  const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');

  const names = Array.isArray(profile?.names) ? profile.names : [];
  const currentName = names[0] || `id ${profile?.id}`;
  const formerNames = names.slice(1).join(', ');

  const aliasNames = topByRank(profile?.aliases ?? [], undefined, memoryCfg.aliasHalfLifeDays).map((a) => a.name);

  const affinity = profile?.affinity ?? emptyAffinity();
  const reason = resolve(affinity.reason);

  const topInterests = topByRank(profile?.interests ?? [], 5, memoryCfg.interestHalfLifeDays).map((it) => it.topic);

  const lines = [
    `name: ${currentName}`,
    `former names: ${truncateForSummary(formerNames || 'none', 150)}`,
    `aliases: ${truncateForSummary(aliasNames.join(', ') || 'none', 150, 'aliases')}`,
    `messages: ${profile?.messageCount ?? 0}`,
    `first seen: ${profile?.firstSeen ? profile.firstSeen.slice(0, 10) : '-'}`,
    `last seen: ${profile?.lastSeen ? profile.lastSeen.slice(0, 10) : '-'}`,
    `attitude: ${roundScore(affinity.score ?? 0)} (${affinityBand(affinity.score ?? 0)})${reason ? ` — ${truncateForSummary(reason, 150)}` : ''}`,
    `character: ${truncateForSummary(resolve(profile?.character) || '(empty)', 240, 'character')}`,
    `style: ${truncateForSummary(resolve(profile?.style) || '(empty)', 240, 'style')}`,
    `relationship: ${truncateForSummary(resolve(profile?.relationship) || '(empty)', 240, 'relationship')}`,
    `interests: ${profile?.interests?.length ?? 0} stored, top: ${truncateForSummary(topInterests.join(', ') || 'none', 200, 'interests')}`,
    `details: ${profile?.details?.length ?? 0} stored`,
    `episodes: ${profile?.episodes?.length ?? 0} stored`,
  ];

  let text = lines.join('\n');
  if (text.length > SUMMARY_MAX_CHARS) text = `${text.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  return text;
}

/**
 * Order + cap one list-shaped section of `/nep memory show` (aliases,
 * interests, details): `order: 'recent'` sorts by `dateOf` descending, no
 * divider; the default `'rank'` order reuses the persona's own rank
 * (src/memory/ranking.js#topByRank) and inserts `DIVIDER_LINE` right after
 * `maxShown` items — the ones the persona is actually shown (see
 * docs/prompt-contract.md, "More is stored than shown, and rank
 * decays with age") — before either is capped to `limit` lines. Never throws
 * on an empty/missing `items`.
 * @param {object[]} items
 * @param {{ order: 'rank'|'recent', limit: number, halfLifeDays?: number,
 *   maxShown?: number, formatLine: (item: object) => string, dateOf: (item: object) => number }} opts
 * @returns {string[]}
 */
function orderedSectionLines(items, { order, limit, halfLifeDays, maxShown, formatLine, dateOf }) {
  if (!Array.isArray(items) || items.length === 0) return [];

  if (order === 'recent') {
    return [...items]
      .sort((a, b) => dateOf(b) - dateOf(a))
      .slice(0, limit)
      .map(formatLine);
  }

  const ranked = topByRank(items, undefined, halfLifeDays).slice(0, limit);
  const lines = [];
  ranked.forEach((item, index) => {
    if (Number.isInteger(maxShown) && index === maxShown) lines.push(DIVIDER_LINE);
    lines.push(formatLine(item));
  });
  return lines;
}

/**
 * `/nep memory show`'s `raw` section: the whole profile as JSON, followed by
 * every stored interest/detail/alias in rank order (divider included) and
 * every episode — `<@id>` tokens are deliberately left unresolved here,
 * unlike every other section.
 */
function rawMemoryShowView(profile, memoryCfg) {
  const lines = [JSON.stringify(profile, null, 2)];
  if (profile.interests?.length) {
    lines.push('', 'interests: (rank order, everything stored -- see the divider for what the persona is shown)');
    lines.push(
      ...rankedLines(profile.interests, memoryCfg?.maxInterests, memoryCfg?.interestHalfLifeDays, (it) => {
        const note = it.note ? `: ${it.note}` : '';
        return `[weight ${it.weight}${lastDateSuffix(it.lastSeen)}] ${it.topic}${note}`;
      }),
    );
  }
  if (profile.details?.length) {
    lines.push('', 'details: (rank order, everything stored -- see the divider for what the persona is shown)');
    lines.push(
      ...rankedLines(profile.details, memoryCfg?.maxDetails, memoryCfg?.detailHalfLifeDays, (d) => `#${d.id} [weight ${d.weight}${lastDateSuffix(d.lastSeen)}] ${d.text}`),
    );
  }
  if (profile.aliases?.length) {
    lines.push('', 'aliases: (rank order, everything stored -- see the divider for what the persona is shown)');
    lines.push(
      ...rankedLines(profile.aliases, memoryCfg?.maxAliases, memoryCfg?.aliasHalfLifeDays, (a) => `[weight ${a.weight}${lastDateSuffix(a.lastSeen)}] ${a.name}`),
    );
  }
  if (profile.episodes?.length) {
    lines.push('', 'episodes:');
    for (const ep of profile.episodes) {
      const quote = ep.quote ? ` "${ep.quote}"` : '';
      lines.push(`  ${ep.date} [weight ${ep.weight}] ${ep.what}${quote}`);
    }
  }
  return lines.join('\n');
}

/** One interest line of `/nep memory show` and `/nep private show`; `resolve` turns `<@id>` tokens into names. */
function interestLine(it, resolve) {
  const note = resolve(it.note);
  const suffix = `[seen ${it.weight}${lastDateSuffix(it.lastSeen)}]`;
  return note ? `${it.topic} — ${note} ${suffix}` : `${it.topic} ${suffix}`;
}

/** One detail line of `/nep memory show` and `/nep private show`. */
function detailLine(d, resolve) {
  return `#${d.id} ${resolve(d.text)} [seen ${d.weight}${lastDateSuffix(d.lastSeen)}]`;
}

/** One episode line of `/nep memory show` and `/nep private show`. */
function episodeLine(ep, resolve) {
  const quote = ep.quote ? ` "${ep.quote}"` : '';
  return `${ep.date} [weight ${ep.weight}] ${resolve(ep.what)}${quote}`;
}

/** `[weight N, last DATE] name`, or just `[weight N] name`, used by
 * both the `raw` view (via `rawMemoryShowView`) and the `aliases` section, and by `/nep alias
 * add`/`remove`'s "resulting alias list" reply. */
function aliasLine(alias) {
  return `[weight ${alias.weight}${lastDateSuffix(alias.lastSeen)}] ${alias.name}`;
}

/** The member's stored aliases, rank-ordered, one per line — the reply `/nep alias
 * add`/`remove` gives after writing. */
function formatAliasList(profile, memoryCfg) {
  const aliases = profile?.aliases ?? [];
  if (!aliases.length) return 'No aliases stored.';
  return topByRank(aliases, undefined, memoryCfg?.aliasHalfLifeDays).map(aliasLine).join('\n');
}

/** Case-insensitive, whitespace-collapsed identity key for one alias name — mirrors
 * src/memory/interests.js#normalizeTopic (also used, via src/memory/aliases.js, as the alias
 * identity store.applyProfileOps merges by) without importing that module, so this file never
 * depends on the exact shape of the parallel interests/aliases work in flight. */
function normalizeAliasKey(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function pathExists(object, dottedPath) {
  const parts = String(dottedPath).split('.').filter((part) => part.length > 0);
  let node = object;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !(part in node)) return false;
    node = node[part];
  }
  return true;
}

function readLocalConfig(localPath) {
  if (!fs.existsSync(localPath)) return {};
  const raw = fs.readFileSync(localPath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeLocalConfig(localPath, value) {
  fs.writeFileSync(localPath, `${JSON.stringify(value, null, 2)}\n`);
}

// The next two mirror src/behavior/turn.js's private helpers of the same name,
// so `/nep draw` builds and names a picture exactly as a turn does.

/** `text` cut to at most `max` code points; a non-number `max` leaves it whole. */
function clampChars(text, max) {
  const value = String(text ?? '');
  return Number.isFinite(max) && max >= 0 ? [...value].slice(0, Math.floor(max)).join('') : value;
}

/** The oldest id of a page of messages, by snowflake order (the next page's `before`). */
function oldestMessageId(batch) {
  let oldest = batch[batch.length - 1].id;
  for (const message of batch) {
    try {
      if (BigInt(message.id) < BigInt(oldest)) oldest = message.id;
    } catch {
      return batch[batch.length - 1].id;
    }
  }
  return oldest;
}

/** Upload file name for a generated picture: `image/jpeg` -> `image.jpg`, else `image.<subtype>`. */
function imageFileName(mediaType) {
  const subtype = String(mediaType ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() || 'png';
  return `image.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * `hot`, `store` — see src/hot.js, src/memory/store.js.
 * `client` — a discord.js Client (used for channels.fetch, guilds.cache, and users.fetch +
 *   createDM for `/nep private purge`).
 * `spontaneous` — the spontaneous scheduler: `force(channel, mode)` and `status()`.
 * `calibrator` — token calibrator (src/llm/tokens.js), read for `.ratio`.
 * `getGuildId` — the single guild this instance serves, or null before it resolves.
 * `isWarmingUp` — `() => boolean`, optional: true while the memory warmup runner
 *   (src/memory/warmup.js) is in flight. Read by `cmdMemoryWipe`, the warmup commands and
 *   `cmdStatus`. Default: never warming up.
 * `turns` — from createTurnRunner() (src/behavior/turn.js), optional: `waitIdle()`, used by
 *   `/nep pause` to wait out a turn already in flight. Absent -> the wait is simply skipped.
 * `memory` — from createMemoryUpdater() (src/memory/update.js), optional: `waitIdle()`, used by
 *   `/nep pause` to wait out a live-analyzer `run()` already in flight (an LLM call can take
 *   30-90s) before the pause flushes and drops the store's caches. Absent -> the wait is skipped.
 * `pending` — `{ clear() }`, optional: clears src/discord/events.js's pending-ping queue on pause.
 *   Absent -> nothing to clear.
 * `llm` — from createLlm() (src/llm/openrouter.js), optional: `complete()`, used by `/nep ping`
 *   to reach each role's model directly. Absent -> `/nep ping` reports it is not available.
 * `warmup` — from createWarmup() (src/memory/warmup.js), optional: the sample-based
 *   memory warmup -- `peopleReport` (read-only), `run`/`runPerson`/`runChannel`/`runServer`/
 *   `runUsers`/`runChannels`/`status`/`reset` (write under data/), `refreshPortrait`, `waitIdle`
 *   (awaited by `/nep pause`, same shape as `memory`/`turns`). Absent -> every `warmup.*`/
 *   `memory.refresh` command reports it is not available.
 * `describer` — from createDescriber() (src/memory/describe.js), optional: `checkYoutube()`, used by
 *   `/nep ping` (video role) to add a line saying which YouTube duration source works on this host.
 *   Absent -> no such line.
 * `lookup` — from createLookup() (src/web/lookup.js), optional: `hasSearch()`, used by `/nep ping`
 *   (classifier.text role) to add a line saying whether the web lookup is on and has a search key.
 *   Absent -> no such line.
 * `images` — from createImageGen() (src/llm/images.js), optional: `generate()` for `/nep draw`,
 *   `quota()` and `familyOf()` for the image lines of `/nep status` and `/nep model show`.
 *   Absent -> `/nep draw` reports it is not available and `/nep status` has no image lines.
 * `imageFetcher` — from createImageFetcher() (src/discord/fetch-image.js), optional: downloads the
 *   bot's avatar as the reference of a `/nep draw self` picture. Absent -> no reference is sent.
 * `emojiBackfill` — from createEmojiBackfill() (src/memory/emoji-backfill.js), optional: `run` (with
 *   `force`, awaited by `/nep emoji rescan`) and `isRunning` (a note in `/nep emoji status`).
 *   Absent -> `/nep emoji rescan` reports it is not available; `/nep emoji status` still works.
 * `gifBackfill` — from createGifBackfill() (src/memory/gif-backfill.js), optional: `run` (with
 *   `force`, awaited by `/nep gifs rescan`) and `isRunning` (a note in `/nep gifs status`).
 *   Absent -> `/nep gifs rescan` reports it is not available; `/nep gifs status` still works.
 * `mentor` — from createMentor() (src/mentor/mentor.js), optional: `run`/`check` (started by
 *   `/nep mentor run|check`, never awaited to the end), `resolveAnchor` (reads the moment of a
 *   message for `/nep mentor add|anchor`), `stop`, `status`; `isRunning` and
 *   `waitIdle` let `/nep pause` stop a run in flight and wait for it. Absent -> every `mentor.*`
 *   command reports it is not available.
 * `mentorCases` — from createCaseStore() (src/mentor/cases.js), optional: the cases, their runs and
 *   the owner's feedback. Absent -> every `mentor.*` command reports it is not available.
 * `mentorBudget` — from createMentorBudget() (src/mentor/budget.js), optional: `snapshot()` for the
 *   token line of `/nep mentor status`. Absent -> that line shows `-`.
 *
 * `run(commandKey, args, context)` throws a plain `Error` (operator-facing
 * message) on bad input; it never touches discord.js.
 */
export function createAdmin({
  hot,
  store,
  client,
  spontaneous,
  calibrator,
  getGuildId,
  isWarmingUp = () => false,
  turns,
  memory,
  pending,
  llm,
  warmup,
  describer,
  lookup,
  images,
  imageFetcher,
  emojiBackfill,
  gifBackfill,
  mentor,
  mentorCases,
  mentorBudget,
  fetchImpl = fetch,
  getApiKey,
}) {
  function isOwner(userId) {
    const owners = hot.config?.bot?.owners ?? [];
    return owners.map(String).includes(String(userId));
  }

  /** Owner, or `bot.access` granted the command by exact key, group, or `*` — see
   * src/discord/access.js#isAllowed. `roleIds` -- the caller's Discord role ids -- comes from
   * src/discord/commands.js#createInteractionHandler, which reads them off the interaction. */
  function isAllowed(commandKey, { userId, roleIds } = {}) {
    return accessIsAllowed({
      commandKey,
      userId,
      roleIds,
      owners: hot.config?.bot?.owners ?? [],
      access: hot.config?.bot?.access ?? {},
    });
  }

  /**
   * `/nep pause`: refuse a command that would write under `data/` while
   * paused, with a hint to resume first. Guards interject, initiate,
   * alias.add, alias.remove, memory.forget, private.forget, private.purge, memory.wipe, memory.affinity (when
   * setting a score), memory.refresh, lore.add, lore.remove, learned.add,
   * learned.remove, warmup.run, warmup.users, warmup.channels, warmup.server,
   * warmup.reset, emoji.rescan, gifs.rescan, draw (it counts against the image rail in state.json) and
   * mentor.add, mentor.anchor, mentor.remove, mentor.run, mentor.check and mentor.wrong.
   */
  function assertNotPaused() {
    if (store.state.data.paused) {
      throw new Error('paused -- run /nep resume first');
    }
  }

  /**
   * A read-only command must see a hand-edit made while paused, even a
   * second one made between two calls of the same command -- `dropCaches`
   * only drops what a WRITE would otherwise dirty (users/guild/channels/lore
   * /media/buffer), so this is safe to call before every read while paused.
   * A no-op when not paused, so callers can call it unconditionally.
   */
  function freshenIfPaused() {
    if (store.state.data.paused && typeof store.dropCaches === 'function') store.dropCaches();
  }

  function localRulesFile() {
    return path.join(hot.localPromptsDir, 'rules.md');
  }

  function baseRulesFile() {
    return path.join(hot.promptsDir, 'rules.md');
  }

  /** The effective rules text: the local override when it exists, else the base file, else empty. */
  function readRules() {
    const localFile = localRulesFile();
    if (fs.existsSync(localFile)) return fs.readFileSync(localFile, 'utf8');
    const baseFile = baseRulesFile();
    return fs.existsSync(baseFile) ? fs.readFileSync(baseFile, 'utf8') : '';
  }

  /** Write `text` to prompts.local/rules.md, creating the directory when needed. The tracked base file is never touched. */
  function writeLocalRules(text) {
    const file = localRulesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }

  function cmdRuleAdd(args) {
    const rule = String(args?.text ?? '').trim();
    if (!rule) throw new Error('rule text is required');
    const next = appendRule(readRules(), rule);
    writeLocalRules(next);
    hot.reloadPrompts();
    return `Rule added: ${rule}`;
  }

  function cmdRuleList() {
    const rules = listRules(readRules());
    if (!rules.length) return 'No rules yet.';
    return rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
  }

  function cmdRuleRemove(args) {
    const n = args?.number;
    if (!Number.isInteger(n)) throw new Error('a rule number is required');
    const result = removeRule(readRules(), n);
    if (!result) throw new Error(`no rule #${n}`);
    writeLocalRules(result.text);
    hot.reloadPrompts();
    return `Removed rule #${n}: ${result.removed}`;
  }

  function cmdSet(args) {
    const dottedPath = String(args?.path ?? '').trim();
    const rawValue = String(args?.value ?? '').trim();
    if (!dottedPath) throw new Error('a config path is required');
    if (!pathExists(hot.config, dottedPath)) throw new Error(`unknown config path: ${dottedPath}`);

    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }

    const localPath = path.join(hot.rootDir, 'config.local.json');
    const next = setPath(readLocalConfig(localPath), dottedPath, value);
    writeLocalConfig(localPath, next);
    const ok = hot.reloadConfig();
    return `Set ${dottedPath} = ${JSON.stringify(value)} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  function cmdUnset(args) {
    const dottedPath = String(args?.path ?? '').trim();
    if (!dottedPath) throw new Error('a config path is required');
    const localPath = path.join(hot.rootDir, 'config.local.json');
    const next = unsetPath(readLocalConfig(localPath), dottedPath);
    writeLocalConfig(localPath, next);
    const ok = hot.reloadConfig();
    return `Unset ${dottedPath} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  function cmdReload() {
    const configOk = hot.reloadConfig();
    const promptsOk = hot.reloadPrompts();
    return `config reload: ${configOk ? 'ok' : 'FAILED'}\nprompts reload: ${promptsOk ? 'ok' : 'FAILED'}`;
  }

  // ---------------------------------------------------------------------
  // pause / resume: a maintenance mode so the owner can edit files
  // under data/ by hand while the process stays up. See src/memory/store.js
  // (dropCaches/reloadState/validate) and the module header comments of
  // src/behavior/turn.js (waitIdle), src/behavior/spontaneous.js and
  // src/memory/update.js (both no-op while paused).
  // ---------------------------------------------------------------------

  /**
   * Sets `paused`/`pausedAt` in state.json FIRST (so a crash or restart
   * mid-pause comes back paused), then waits out a turn already running, AND
   * a live-analyzer `run()` already in flight (its LLM call can take
   * 30-90s; `tick()`/`observe()` are already no-ops from the moment `paused`
   * is set, so no NEW run can start -- this only waits out one that started
   * before the pause), a warmup run, and a mentor run in flight (stopped
   * first, then waited for until it has saved and reported; the reply says
   * so). Only once all are idle does it clear the pending-ping
   * queue, flush everything and drop every cache except state.json itself, so
   * nothing stale (or a late in-flight write) can land in data/ after the
   * owner starts editing it. Idempotent: a second call just reports the
   * state.
   */
  async function cmdPause() {
    const state = store.state.data;
    if (state.paused) {
      return [
        `Already paused (since ${state.pausedAt ?? '?'}).`,
        'Files under data/ can be edited freely. Run /nep resume when done.',
      ].join('\n');
    }

    state.paused = true;
    state.pausedAt = new Date().toISOString();
    store.state.markDirty();
    store.flush();

    if (turns && typeof turns.waitIdle === 'function') {
      await turns.waitIdle();
    }

    // The live analyzer's own in-flight run (if any) must land on disk
    // BEFORE the flush + dropCaches below -- see the header comment above.
    if (memory && typeof memory.waitIdle === 'function') {
      await memory.waitIdle();
    }

    // A warmup run/one-off target already in flight: same rule, its own
    // loop already stops after the request in flight once `paused` is seen.
    if (warmup && typeof warmup.waitIdle === 'function') {
      await warmup.waitIdle();
    }

    // A mentor run in flight saves its run and charges state.json: stop it
    // (the request in flight is aborted) and wait until it has saved and
    // reported. `/nep mentor run|check` are refused from here on.
    let mentorStopped = false;
    if (mentor && typeof mentor.isRunning === 'function' && mentor.isRunning()) {
      mentor.stop();
      mentorStopped = true;
      if (typeof mentor.waitIdle === 'function') await mentor.waitIdle();
    }

    if (pending && typeof pending.clear === 'function') {
      pending.clear();
    }

    store.flush();
    const dropped = typeof store.dropCaches === 'function' ? store.dropCaches() : 0;

    log.info('admin: paused', { dropped, mentorStopped });

    return [
      'Paused. Memory is flushed to disk -- files under data/ can be edited safely now.',
      ...(mentorStopped ? ['A mentor run in flight was stopped.'] : []),
      'Run /nep resume when done.',
    ].join('\n');
  }

  /**
   * Refuses (staying paused) if any `*.json` under data/ fails to parse,
   * naming the offending paths. Otherwise re-reads state.json (the owner may
   * have hand-edited data/ while paused) and clears the pause flags, letting
   * every other cache lazily re-populate from disk. Idempotent: reports "not
   * paused" when called while not paused.
   */
  function cmdResume() {
    const badFiles = typeof store.validate === 'function' ? store.validate() : [];
    if (badFiles.length > 0) {
      return [
        'Still paused: found invalid JSON under data/, fix or restore these files and try again:',
        ...badFiles.map((file) => `  ${file}`),
      ].join('\n');
    }

    if (typeof store.reloadState === 'function') store.reloadState();
    const state = store.state.data;
    if (!state.paused) {
      return 'Not paused.';
    }

    delete state.paused;
    delete state.pausedAt;
    store.state.markDirty();
    store.flush();

    log.info('admin: resumed', {});

    return 'Resumed.';
  }

  function nextSpontaneousFor(guildId) {
    if (typeof spontaneous?.status !== 'function') return null;
    let value;
    try {
      value = spontaneous.status();
    } catch {
      return null;
    }
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
      const perGuild = value[guildId] ?? value[String(guildId)];
      if (perGuild instanceof Date) return perGuild.toISOString();
      // src/behavior/spontaneous.js keeps the schedule as epoch milliseconds.
      if (typeof perGuild === 'number') return new Date(perGuild).toISOString();
      if (perGuild != null) return perGuild;
    }
    return null;
  }

  function cmdStatus() {
    freshenIfPaused(); // read the freshest data/ even mid-pause
    const cfg = hot.config;
    const data = store.state.data ?? {};
    const dryRunOn = cfg?.features?.dryRun === true;
    const dryRunChannelId = cfg?.bot?.dryRunChannelId || '';
    const dryRunLine = dryRunOn ? `dry-run: ON → log${dryRunChannelId ? ` + #${dryRunChannelId}` : ''}` : 'dry-run: off';
    const lines = [
      dryRunLine,
      `model: ${cfg?.llm?.model ?? '-'}`,
      `calibration ratio: ${calibrator ? calibrator.ratio.toFixed(3) : '-'}`,
      `llm requests today: ${data.llmCount ?? 0} / ${cfg?.llm?.maxRequestsPerDay ?? '-'} (day: ${data.llmDay ?? '-'})`,
      data.paused ? `paused: true (since ${data.pausedAt ?? '?'})` : 'paused: false',
      `warming up: ${isWarmingUp() ? 'true' : 'false'}`,
    ];

    if (images) {
      const quota = images.quota({ userId: null });
      lines.push(`images today: ${quota.used}/${quota.cap ?? '-'}`, `image model: ${imageModelLabel(cfg)}`);
    }

    if (warmup && typeof warmup.summary === 'function') {
      const bs = warmup.summary();
      lines.push(
        `warmup: channels=${bs.doneChannels} people=${bs.donePeople} server=${bs.doneServer ? 'done' : 'pending'} ` +
          `tokens=${bs.tokensUsed} requests=${bs.requests} aborted=${bs.aborted ?? 'no'}`,
      );
    }

    const guildId = getGuildId?.() ?? null;
    if (guildId) {
      const guildName = client?.guilds?.cache?.get(guildId)?.name;
      const label = guildName ? `${guildName} (${guildId})` : guildId;
      const profiles = store.countUsers(guildId);
      const buffer = store.getBuffer(guildId);
      const next = nextSpontaneousFor(guildId);
      lines.push(`guild: ${label} profiles=${profiles} buffer=${buffer.length} nextSpontaneous=${next ?? '-'}`);
    } else {
      lines.push('guild: not resolved yet');
    }

    const privateChat = cfg?.features?.privateMessages === true ? 'on' : 'off';
    lines.push(guildId ? `private chat: ${privateChat} · ${store.listPrivate(guildId).length} private files` : `private chat: ${privateChat}`);

    const prompts = hot.prompts ?? {};
    const sources = hot.promptSources ?? {};
    for (const name of Object.keys(prompts)) {
      if (name === 'labels') {
        lines.push(`prompt labels: locale=${prompts.labels?.locale ?? '-'} source=${sources.labels ?? '-'}`);
        continue;
      }
      lines.push(`prompt ${name}: ${prompts[name].length} chars source=${sources[name] ?? '-'}`);
    }

    return lines.join('\n');
  }

  /**
   * Shared handler for `/nep interject` and `/nep initiate`: force a
   * spontaneous turn right now, in `context.channelId` unless a channel
   * argument overrides it, bypassing the schedule.
   */
  async function cmdForce(mode, args, context) {
    assertNotPaused();
    const channelId = args?.channelId || context?.channelId;
    if (!channelId) throw new Error('a channel is required');

    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`channel not found: ${channelId}`);

    const result = await spontaneous.force(channel, mode);
    return `${mode} on ${channel.id}: ${JSON.stringify(result) ?? 'ok'}`;
  }

  function resolvedGuildId(context) {
    return context?.guildId ?? getGuildId?.() ?? null;
  }

  /** The bot's avatar as a data: URL for a self-portrait, or null when it cannot be had. */
  async function avatarReference() {
    if (!imageFetcher || typeof client?.user?.displayAvatarURL !== 'function') return null;
    try {
      const url = client.user.displayAvatarURL({ extension: 'png', size: 1024, forceStatic: true });
      if (!url) return null;
      const downloaded = await imageFetcher.fetchAsDataUrl(url, {
        maxBytes: hot.config.image?.referenceMaxBytes,
        timeoutMs: hot.config.context?.vision?.fetchTimeoutMs,
      });
      return downloaded?.dataUrl || null;
    } catch {
      return null;
    }
  }

  /**
   * `/nep draw`: one picture through the same prompt a turn builds (prompts
   * read now, the request clamped to `image.maxPromptChars`, the avatar as
   * reference for `self` when `image.reference` is `'avatar'`), counted
   * against `image.maxPerDay` only (no member). Answers `{ text, files }`:
   * one line with the model, seconds and cost, plus the picture. A rail or
   * generation failure throws with its reason and HTTP status; the prompt is
   * never logged.
   */
  async function cmdDraw(args, context) {
    if (!images) return 'image generation is not available';
    assertNotPaused();
    const request = String(args?.text ?? '').trim();
    if (!request) throw new Error('text is required');

    const imageCfg = hot.config.image ?? {};
    if (!images.familyOf(imageCfg.model)) {
      return `unsupported image model: ${imageCfg.model ?? '-'} (no supported family); nothing was generated`;
    }

    const self = args?.self === true;
    const guildId = resolvedGuildId(context);
    const selfName = client?.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client?.user?.username ?? '';
    const prompt = buildDrawPrompt({
      prompts: hot.prompts,
      selfName,
      request: clampChars(request, imageCfg.maxPromptChars),
      self,
    });

    let reference = null;
    let referenceMissing = false;
    if (self && imageCfg.reference === 'avatar') {
      reference = await avatarReference();
      referenceMissing = reference === null;
      if (referenceMissing) log.warn('admin: draw avatar reference unavailable', {});
    }

    let picture;
    try {
      picture = await images.generate({ prompt, reference, userId: null });
    } catch (err) {
      if (err instanceof ImageCapError || err instanceof ImageGenError) {
        const status = err.statusCode ? `, HTTP ${err.statusCode}` : '';
        throw new Error(`draw failed (${err.reason}${status}): ${err.message}`);
      }
      if (err instanceof UnsupportedImageModelError) throw new Error(`draw failed: ${err.message}`);
      throw err;
    }

    log.info('admin: drew', { model: picture.model, seconds: picture.seconds, cost: picture.cost, self, bytes: picture.buffer?.length ?? 0 });

    const cost = picture.cost == null ? 'cost unknown' : `cost ${picture.cost}`;
    const parts = [picture.model, `${picture.seconds}s`, cost];
    if (referenceMissing) parts.push('no avatar reference');
    return {
      text: parts.join(' · '),
      files: [{ attachment: picture.buffer, name: imageFileName(picture.mediaType) }],
    };
  }

  /**
   * Sectioned, human-readable view of one member's profile — see the
   * module-level `MEMORY_SHOW_SECTIONS` for the choices and the header
   * comments of `buildProfileSummary`/`orderedSectionLines`/
   * `rawMemoryShowView` for what each section does. `section` defaults to
   * `'summary'`; `order` to `'rank'`; `limit` to 25 (1..100) — anything else
   * given falls back to these defaults rather than throwing, since this is a
   * read-only command. Every section except `'raw'` resolves `<@id>` tokens
   * in free text via `fromTokens(..., 'analyzer')`, the same as the analyzer's
   * own input view.
   */
  function cmdMemoryShow(args, context) {
    freshenIfPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const profile = store.getUser(guildId, userId);
    if (!profile) throw new Error(`no profile for ${userId}`);

    const memoryCfg = hot.config?.memory ?? {};
    const section = MEMORY_SHOW_SECTIONS.has(args?.section) ? args.section : 'summary';
    const order = args?.order === 'recent' ? 'recent' : 'rank';
    const limit =
      Number.isInteger(args?.limit) && args.limit >= 1 && args.limit <= MEMORY_SHOW_MAX_LIMIT
        ? args.limit
        : MEMORY_SHOW_DEFAULT_LIMIT;
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
    const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');

    if (section === 'raw') return rawMemoryShowView(profile, memoryCfg);

    if (section === 'character') return resolve(profile.character) || '(empty)';
    if (section === 'style') return resolve(profile.style) || '(empty)';
    if (section === 'relationship') return resolve(profile.relationship) || '(empty)';

    if (section === 'affinity') {
      const affinity = profile.affinity ?? emptyAffinity();
      const history = (affinity.history ?? [])
        .slice(-5)
        .map((h) => `${h.ts} ${h.delta >= 0 ? '+' : ''}${h.delta} -> ${roundScore(h.score)}${h.reason ? `: ${resolve(h.reason)}` : ''}`)
        .join('\n');
      return [
        `score: ${roundScore(affinity.score)}`,
        `band: ${affinityBand(affinity.score)}`,
        `reason: ${resolve(affinity.reason) || '-'}`,
        history ? `history:\n${history}` : 'history: (empty)',
      ].join('\n');
    }

    if (section === 'aliases') {
      const lines = orderedSectionLines(profile.aliases ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.aliasHalfLifeDays,
        maxShown: memoryCfg.maxAliases,
        formatLine: aliasLine,
        dateOf: (a) => dateMs(a.lastSeen ?? a.firstSeen),
      });
      return lines.length ? lines.join('\n') : 'No aliases stored.';
    }

    if (section === 'interests') {
      const lines = orderedSectionLines(profile.interests ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.interestHalfLifeDays,
        maxShown: memoryCfg.maxInterests,
        formatLine: (it) => interestLine(it, resolve),
        dateOf: (it) => dateMs(it.lastSeen ?? it.firstSeen),
      });
      return lines.length ? lines.join('\n') : 'No interests stored.';
    }

    if (section === 'details') {
      const lines = orderedSectionLines(profile.details ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.detailHalfLifeDays,
        maxShown: memoryCfg.maxDetails,
        formatLine: (d) => detailLine(d, resolve),
        dateOf: (d) => dateMs(d.lastSeen ?? d.firstSeen),
      });
      return lines.length ? lines.join('\n') : 'No details stored.';
    }

    if (section === 'episodes') {
      const episodes = profile.episodes ?? [];
      if (!episodes.length) return 'No episodes stored.';
      const ordered =
        order === 'recent'
          ? [...episodes].sort((a, b) => dateMs(b.addedAt ?? b.date) - dateMs(a.addedAt ?? a.date))
          : sortEpisodesForDisplay(episodes);
      return ordered
        .slice(0, limit)
        .map((ep) => episodeLine(ep, resolve))
        .join('\n');
    }

    return buildProfileSummary(profile, memoryCfg, nameOf);
  }

  // ---------------------------------------------------------------------
  // memory.channel / memory.server: read-only views of the server-wide
  // memory -- the channel map (src/memory/channels.js) and the guild notes
  // (src/memory/store.js#getGuild) -- alongside `memory.show`'s per-member
  // view. Both read fresh data even mid-pause (`freshenIfPaused`, same as
  // `memory.show`) and never write anything.
  // ---------------------------------------------------------------------

  /** `hot.config.memory.mainChannelIds`, normalized to a string Set -- mirrors
   * src/memory/update.js#mainChannelSet and src/memory/warmup.js's own copies. */
  function mainChannelIdSet() {
    return new Set((hot.config?.memory?.mainChannelIds ?? []).map(String));
  }

  /** `YYYY-MM-DD` for an epoch-ms channel timestamp (`firstMessageAt`/`lastMessageAt`), or `-` when missing. */
  function channelDate(ts) {
    return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '-';
  }

  /** A channel's stored `topWriters` (`{ id, count }[]`) resolved to current stored names, comma
   * -separated -- an id with no stored profile (e.g. someone who left) is skipped silently, same as
   * src/memory/channels.js#renderChannel's own topWriters line. `''` when there is nothing to show. */
  function channelTopWritersText(topWriters, nameOf) {
    return (Array.isArray(topWriters) ? topWriters : [])
      .map((writer) => {
        const name = nameOf(writer?.id);
        return name ? `${name} (${writer.count})` : null;
      })
      .filter(Boolean)
      .join(', ');
  }

  /** One line of `/nep memory channel`'s table view (no channel given): name, activity verdict,
   * message count, last message date, whether a note exists (a non-empty `purpose`). */
  function channelTableLine(channel, activity) {
    const note = channel.purpose ? 'yes' : 'no';
    return `${channel.name || channel.id}  activity=${activity}  messages=${channel.messageCount ?? 0}  last=${channelDate(channel.lastMessageAt)}  note=${note}`;
  }

  /**
   * `/nep memory channel [channel]`: with a channel, that channel's full stored note (Discord
   * facts, the analyzer/warmup-written purpose/topics/tone, counters, activity verdict and top
   * writers); without one, a compact table of every stored channel, sorted by last message desc.
   * `<@id>` tokens in `purpose`/`topics`/`tone` are resolved the same way `memory.show` resolves
   * free-text fields (`fromTokens(..., 'analyzer')`).
   */
  function cmdMemoryChannel(args, context) {
    freshenIfPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const activityCfg = hot.config?.context?.channelActivity ?? {};
    const now = Date.now();
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
    const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');

    const channelId = args?.channelId;
    if (channelId) {
      const channel = store.getChannel(guildId, channelId);
      if (!channel) throw new Error(`no channel entry for ${channelId}`);

      const activity = channelActivity(channel, now, activityCfg);
      const isMain = mainChannelIdSet().has(String(channelId));
      const writers = channelTopWritersText(channel.topWriters, nameOf);

      return [
        `name: ${channel.name || '-'}`,
        `category: ${channel.category || '-'}`,
        `topic: ${channel.topic || '-'}`,
        `main: ${isMain}`,
        `purpose: ${resolve(channel.purpose) || '(empty)'}`,
        `topics: ${resolve(channel.topics) || '(empty)'}`,
        `tone: ${resolve(channel.tone) || '(empty)'}`,
        `messages: ${channel.messageCount ?? 0}`,
        `first message: ${channelDate(channel.firstMessageAt)}`,
        `last message: ${channelDate(channel.lastMessageAt)}`,
        `activity: ${activity}`,
        `top writers: ${writers || 'none'}`,
        `updatedAt: ${channel.updatedAt ?? '-'}`,
      ].join('\n');
    }

    const channels = store.listChannels(guildId);
    if (channels.length === 0) return 'No channels stored.';

    return [...channels]
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      .map((channel) => channelTableLine(channel, channelActivity(channel, now, activityCfg)))
      .join('\n');
  }

  /** Numbered `1. …` list of `items` (in-jokes/self facts), each resolved via `resolve`; `'none'`
   * when the list is empty. Used by `cmdMemoryServer`. */
  function numberedNotes(items, resolve) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return 'none';
    return list.map((item, i) => `${i + 1}. ${resolve(item)}`).join('\n');
  }

  /**
   * `/nep memory server`: the stored guild-wide notes (`patterns`, `starters`, numbered
   * in-jokes and self facts -- src/memory/store.js#getGuild) plus counts of what else this guild has
   * stored (profiles, channel notes, lore entries) and when the guild notes were last updated.
   * `<@id>` tokens are resolved the same way `memory.show`/`memory.channel` resolve free text.
   */
  function cmdMemoryServer(_args, context) {
    freshenIfPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const guild = store.getGuild(guildId);
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
    const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');

    return [
      `patterns: ${resolve(guild.patterns) || '(empty)'}`,
      `starters: ${resolve(guild.starters) || '(empty)'}`,
      `in-jokes:\n${numberedNotes(guild.injokes, resolve)}`,
      `self facts:\n${numberedNotes(guild.self, resolve)}`,
      `profiles stored: ${store.countUsers(guildId)}`,
      `channel notes stored: ${store.listChannels(guildId).length}`,
      `lore entries: ${store.getLore(guildId).length}`,
      `updatedAt: ${guild.updatedAt ?? '-'}`,
    ].join('\n');
  }

  /**
   * `/nep alias add`: confirms the alias at once instead of
   * waiting for it to be sighted `memory.confirmAfter` times naturally —
   * store.applyProfileOps/src/memory/aliases.js has no option to set a
   * weight directly, so this calls it repeatedly with `confirmGapHours: 0`
   * (every call then counts as a fresh sighting regardless of the gap, see
   * src/memory/interests.js#applyRankedOps's `isFarEnough`) and the SAME
   * `seenAt`/`now` for every call, so the resulting item's `firstSeen` and
   * `lastSeen` both land on that one instant. Idempotent: already at or past
   * the target weight -> no call at all, nothing changes. Clamping to 40
   * chars and dropping a name equal to one of the member's display names are
   * both store.js's own applyAliasOps behaviour, untouched here.
   */
  function cmdAliasAdd(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const name = String(args?.name ?? '').trim().slice(0, 40);
    if (!name) throw new Error('a name is required');

    const memoryCfg = hot.config?.memory ?? {};
    const confirmAfter = Number.isFinite(memoryCfg.confirmAfter) && memoryCfg.confirmAfter > 0 ? Math.ceil(memoryCfg.confirmAfter) : 2;
    const target = Math.max(1, confirmAfter);

    const key = normalizeAliasKey(name);
    const before = store.getUser(guildId, userId);
    const currentWeight = before?.aliases?.find((a) => normalizeAliasKey(a.name) === key)?.weight ?? 0;
    const needed = Math.max(0, target - currentWeight);

    const now = Date.now();
    for (let i = 0; i < needed; i += 1) {
      store.applyProfileOps(
        guildId,
        userId,
        { aliases: { add: [name] } },
        {
          confirmGapHours: 0,
          seenAt: now,
          now,
          maxAliases: memoryCfg.maxAliases,
          maxAliasesStored: memoryCfg.maxAliasesStored,
          aliasHalfLifeDays: memoryCfg.aliasHalfLifeDays,
        },
      );
    }

    const after = store.getUser(guildId, userId);
    return formatAliasList(after, memoryCfg);
  }

  /** `/nep alias remove`: removes by name, case-insensitively (store.applyProfileOps
   * matches an alias's identity the same way, see src/memory/interests.js#normalizeTopic). */
  function cmdAliasRemove(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const name = String(args?.name ?? '').trim();
    if (!name) throw new Error('a name is required');

    const memoryCfg = hot.config?.memory ?? {};
    store.applyProfileOps(
      guildId,
      userId,
      { aliases: { remove: [name] } },
      {
        maxAliases: memoryCfg.maxAliases,
        maxAliasesStored: memoryCfg.maxAliasesStored,
        aliasHalfLifeDays: memoryCfg.aliasHalfLifeDays,
      },
    );

    const after = store.getUser(guildId, userId);
    return formatAliasList(after, memoryCfg);
  }

  function cmdMemoryForget(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    store.forgetUser(guildId, userId); // cascades to the member's private layer
    return `Forgot ${userId} (public profile and private memory).`;
  }

  // ---------------------------------------------------------------------
  // private: a member's private layer (what they said in direct messages)
  // ---------------------------------------------------------------------

  /**
   * `/nep private show`: one member's private layer, with the same line
   * formats as `memory show`'s sections, under the public profile's current
   * name (the user id when there is none). Adds the private and the effective
   * attitude (src/behavior/private.js#effectiveAffinity -- what the persona
   * feels in the DM), today's DM reply count against the member's cap and the
   * buffer SIZE -- never the buffered messages themselves. No "shown cap"
   * divider: in a DM the private items are ranked together with the public
   * ones. No private layer -> a plain answer, not an error.
   */
  function cmdPrivateShow(args, context) {
    freshenIfPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const publicProfile = store.getUser(guildId, userId);
    const name = publicProfile?.names?.[0];
    const label = name ? `${name} (id:${userId})` : String(userId);

    const priv = store.getPrivate(guildId, userId);
    if (!priv) return `No private memory for this member: ${label}.`;

    const memoryCfg = hot.config?.memory ?? {};
    const privateCfg = hot.config?.private ?? {};
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
    const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');

    const privateAffinity = priv.affinity ?? emptyAffinity();
    const effective = effectiveAffinity(publicProfile?.affinity, privateAffinity);
    const privateReason = resolve(privateAffinity.reason);

    const today = new Date().toISOString().slice(0, 10);
    const replies = priv.replies?.day === today && Number.isFinite(priv.replies.count) ? priv.replies.count : 0;
    const cap = isOwner(userId) ? privateCfg.maxPerOwnerPerDay : privateCfg.maxPerUserPerDay;
    const bufferSize = Array.isArray(priv.buffer) ? priv.buffer.length : 0;

    const section = (title, items, lines) => [`${title} (${items.length} stored):`, ...lines.map((line) => `  ${line}`)];
    const interests = priv.interests ?? [];
    const details = priv.details ?? [];
    const episodes = priv.episodes ?? [];

    return [
      `private memory: ${label}`,
      `private affinity: ${roundScore(privateAffinity.score ?? 0)} (${affinityBand(privateAffinity.score ?? 0)})${privateReason ? ` — ${privateReason}` : ''}`,
      `effective affinity: ${roundScore(effective.score)} (${affinityBand(effective.score)})`,
      `replies today: ${replies} / ${Number.isFinite(cap) ? cap : '-'}`,
      `buffer: ${bufferSize} messages`,
      `first seen: ${priv.firstSeen ? priv.firstSeen.slice(0, 10) : '-'} · last seen: ${priv.lastSeen ? priv.lastSeen.slice(0, 10) : '-'}`,
      `relationship: ${resolve(priv.relationship) || '(empty)'}`,
      ...section(
        'interests',
        interests,
        orderedSectionLines(interests, {
          order: 'rank',
          limit: MEMORY_SHOW_DEFAULT_LIMIT,
          halfLifeDays: memoryCfg.interestHalfLifeDays,
          formatLine: (it) => interestLine(it, resolve),
          dateOf: (it) => dateMs(it.lastSeen ?? it.firstSeen),
        }),
      ),
      ...section(
        'details',
        details,
        orderedSectionLines(details, {
          order: 'rank',
          limit: MEMORY_SHOW_DEFAULT_LIMIT,
          halfLifeDays: memoryCfg.detailHalfLifeDays,
          formatLine: (d) => detailLine(d, resolve),
          dateOf: (d) => dateMs(d.lastSeen ?? d.firstSeen),
        }),
      ),
      ...section(
        'episodes',
        episodes,
        sortEpisodesForDisplay(episodes)
          .slice(0, MEMORY_SHOW_DEFAULT_LIMIT)
          .map((ep) => episodeLine(ep, resolve)),
      ),
    ].join('\n');
  }

  /** `/nep private forget`: deletes one member's private layer only (store.forgetPrivate); the
   * public profile stays. Refused while paused, like `memory forget`. */
  function cmdPrivateForget(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    store.forgetPrivate(guildId, userId);
    return `Forgot the private memory of ${userId}; the public profile is kept.`;
  }

  /**
   * `/nep private purge`: deletes the bot's own messages in the direct-message chat with one
   * member, then that member's private layer (store.forgetPrivate). Pages back through the DM
   * 100 at a time until a short page or `private.purgeMaxMessages` scanned messages (default
   * 5000), deleting sequentially; a failed delete is counted, never thrown. The member's own
   * messages cannot be deleted by a bot and stay. A user that cannot be fetched or a DM that
   * cannot be opened, or a first history page that cannot be read, throws before anything is
   * deleted; a later page fetch that fails stops the scan and the purge finishes with what it
   * had. Refused while paused; a pause that lands mid-run keeps the private layer.
   */
  async function cmdPrivatePurge(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const selfId = client?.user?.id;
    if (!selfId) throw new Error('the bot is not logged in yet');

    let dm;
    try {
      const user = await client.users.fetch(userId);
      dm = await user.createDM();
    } catch (err) {
      log.warn('admin: private purge could not open the DM', { error: err });
      throw new Error(`cannot open the private chat with ${userId}; nothing was deleted`);
    }

    const configured = hot.config?.private?.purgeMaxMessages;
    const maxScanned = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 5000;

    let scanned = 0;
    let deleted = 0;
    let failed = 0;
    let before;
    while (scanned < maxScanned) {
      let page;
      try {
        page = await dm.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
      } catch (err) {
        log.warn('admin: private purge page fetch failed', { scanned, error: err });
        if (!before) throw new Error(`cannot read the private chat with ${userId}; nothing was deleted`);
        break;
      }
      const batch = [...page.values()];
      if (batch.length === 0) break;

      for (const message of batch) {
        if (scanned >= maxScanned) break;
        scanned += 1;
        if (message.author?.id !== selfId) continue;
        try {
          await message.delete();
          deleted += 1;
        } catch {
          failed += 1;
        }
      }

      before = oldestMessageId(batch);
      if (batch.length < 100) break;
    }

    // A `/nep pause` that landed during a long purge: data/ must not be written any more.
    const pausedMidway = Boolean(store.state.data.paused);
    if (!pausedMidway) store.forgetPrivate(guildId, userId);
    log.info('admin: private purged', { deleted, failed, scanned });
    const capped = scanned >= maxScanned ? `; stopped at the ${maxScanned}-message scan cap, run again for older ones` : '';
    const memoryPart = pausedMidway ? 'private memory kept (paused meanwhile, run again after /nep resume)' : 'private memory removed';
    return [
      `Purged ${deleted} own messages in the private chat (${failed} failed, ${scanned} scanned${capped}); ${memoryPart}.`,
      "The member's own messages stay; only they can delete those.",
    ].join('\n');
  }

  /**
   * A deliberate, owner-only clean start: wipes this guild's whole stored
   * memory (store.wipeGuild). Runs only when `confirm` matches the served
   * guild's name exactly (trimmed, case-sensitive) — otherwise nothing
   * changes and the reply says what to type.
   */
  function cmdMemoryWipe(args, context) {
    assertNotPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    if (isWarmingUp()) throw new Error('a warmup is running: /nep warmup stop first');

    const guildName = client?.guilds?.cache?.get(guildId)?.name || guildId;
    const confirm = String(args?.confirm ?? '').trim();
    if (confirm !== guildName) {
      return `This deletes all remembered members, server habits, channel map and analyzer lore for this server. To confirm, run again with confirm: ${guildName}`;
    }

    const counts = store.wipeGuild(guildId);
    log.info('admin: memory wiped', counts);

    return [
      `Memory wiped for ${guildName}.`,
      `users removed: ${counts.users}`,
      `channels removed: ${counts.channels}`,
      `lore removed: ${counts.loreRemoved} (kept: ${counts.loreKept})`,
      `buffer messages cleared: ${counts.bufferMessages}`,
      'Kept: owner lore, the media description cache, token calibration, the daily request count and the spontaneous schedule.',
    ].join('\n');
  }

  function cmdMemoryAffinity(args, context) {
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const score = args?.score;
    if (score === undefined || score === null) {
      freshenIfPaused();
      const profile = store.getUser(guildId, userId);
      if (!profile) throw new Error(`no profile for ${userId}`);
      const affinity = profile.affinity ?? emptyAffinity();
      const history = (affinity.history ?? [])
        .slice(-5)
        .map((h) => `${h.ts} ${h.delta >= 0 ? '+' : ''}${h.delta} -> ${roundScore(h.score)}${h.reason ? `: ${h.reason}` : ''}`)
        .join('\n');
      return [
        `score: ${roundScore(affinity.score)}`,
        `band: ${affinityBand(affinity.score)}`,
        `reason: ${affinity.reason || '-'}`,
        history ? `history:\n${history}` : 'history: (empty)',
      ].join('\n');
    }

    assertNotPaused();
    if (!Number.isInteger(score) || score < -100 || score > 100) {
      throw new Error('score must be an integer between -100 and 100');
    }

    const reason = String(args?.reason ?? '').trim();
    const current = store.getUser(guildId, userId)?.affinity?.score ?? 0;
    const relCfg = hot.config?.relationships ?? {};
    const affinity = store.adjustAffinity(guildId, userId, score - current, reason || 'set by owner', {
      maxDelta: Infinity, // the owner's explicit override bypasses maxDeltaPerUpdate
      historySize: relCfg.historySize ?? 10,
      now: Date.now(),
      damping: false, // an absolute set is never damped
      truncate: false, // `current` may carry two decimals (a damped score); land on `score` exactly
    });
    return `Set affinity for ${userId} to ${roundScore(affinity.score)} (${affinityBand(affinity.score)}).`;
  }

  // ---------------------------------------------------------------------
  // lore: the owner's side of the server lorebook (src/memory/lore.js)
  // ---------------------------------------------------------------------

  function loreLine(entry) {
    return `${entry.id}  ${entry.title}  keys=${entry.keys.join(', ')}  source=${entry.source}${entry.always ? ' always' : ''}`;
  }

  function cmdLoreAdd(args, context) {
    assertNotPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const title = String(args?.title ?? '').trim();
    if (!title) throw new Error('a title is required');
    const keys = String(args?.keys ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const text = String(args?.text ?? '').trim();
    if (!text) throw new Error('text is required');

    const maxEntries = hot.config?.lore?.maxEntries ?? Infinity;
    const upserted = store.setLore(guildId, [{ title, keys, text, always: Boolean(args?.always) }], {
      source: 'owner',
      now: Date.now(),
      maxEntries,
      textChars: hot.config?.lore?.textChars,
      clampTolerance: hot.config?.memory?.clampTolerance,
    });
    if (upserted === 0) {
      throw new Error('invalid lore entry: needs a title, at least one 2-40 char key, and non-empty text');
    }
    return `Lore entry saved: ${title}`;
  }

  function cmdLoreList(args, context) {
    freshenIfPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const query = String(args?.query ?? '').trim().toLowerCase();
    let entries = store.getLore(guildId);
    if (query) {
      entries = entries.filter(
        (entry) => entry.title.toLowerCase().includes(query) || entry.keys.some((key) => key.includes(query)),
      );
    }
    if (entries.length === 0) return 'No lore entries.';
    return entries.map(loreLine).join('\n');
  }

  function cmdLoreShow(args, context) {
    freshenIfPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const id = String(args?.id ?? '').trim();
    const entry = store.getLore(guildId).find((e) => e.id === id);
    if (!entry) throw new Error(`no lore entry ${id}`);
    return JSON.stringify(entry, null, 2);
  }

  function cmdLoreRemove(args, context) {
    assertNotPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const id = String(args?.id ?? '').trim();
    const entry = store.getLore(guildId).find((e) => e.id === id);
    if (!entry) throw new Error(`no lore entry ${id}`);
    store.removeLore(guildId, id);
    return `Removed lore entry ${id}: ${entry.title}`;
  }

  // ---------------------------------------------------------------------
  // learned: the owner's side of the guild's list of things people taught
  // the persona (store.js#applyLearnedOps). Items are detail-shaped
  // (`{ id, text, weight, firstSeen, lastSeen, from? }`); `from` is the
  // teacher as a `<@id>` token. The owner's own adds carry no `from`.
  // ---------------------------------------------------------------------

  /** `<@id>` -> `name (id:…)` for this guild, the same resolution `memory.show` uses; an id with no
   * stored name keeps its token. */
  function tokenResolver(guildId) {
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
    return (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');
  }

  /** `#<id> <text> — from <name> · seen <weight> · last <YYYY-MM-DD>`, the `from` part only when
   * the item has one. */
  function learnedLine(item, resolve) {
    const from = item.from ? ` — from ${resolve(item.from)}` : '';
    const last = String(item.lastSeen ?? item.firstSeen ?? '-').slice(0, 10);
    return `#${item.id} ${resolve(item.text)}${from} · seen ${item.weight} · last ${last}`;
  }

  /** `/nep learned list`: every stored item, rank order (`memory.learnedHalfLifeDays`). */
  function cmdLearnedList(_args, context) {
    freshenIfPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const learned = store.getGuild(guildId).learned ?? [];
    if (learned.length === 0) return '(none)';
    const resolve = tokenResolver(guildId);
    return sortByRank(learned, hot.config?.memory?.learnedHalfLifeDays)
      .map((item) => learnedLine(item, resolve))
      .join('\n');
  }

  /**
   * `/nep learned add`: an `add` op with no `from` that confirms the lesson at once, the same way
   * `/nep alias add` confirms an alias: repeated sightings with `confirmGapHours: 0` and ONE
   * `seenAt` (an add of a stored text counts as a sighting of it) until the item's weight reaches
   * `memory.confirmAfter` (default 2). A lesson already at or past that weight gets one ordinary
   * sighting under the live `config.memory` (so `confirmGapHours` applies) -- never more than the
   * analyzer seeing it again would give. Every other limit is the live `config.memory`. Replies
   * with the resulting item's line.
   */
  function cmdLearnedAdd(args, context) {
    assertNotPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const text = String(args?.text ?? '').trim();
    if (!text) throw new Error('text is required');

    const memoryCfg = hot.config?.memory ?? {};
    const confirmAfter = Number.isFinite(memoryCfg.confirmAfter) && memoryCfg.confirmAfter > 0 ? Math.ceil(memoryCfg.confirmAfter) : 2;
    const target = Math.max(1, confirmAfter);

    const key = normalizeAliasKey(text);
    const before = store.getGuild(guildId).learned ?? [];
    const beforeIds = new Set(before.map((item) => item.id));
    const seenAt = Date.now();
    const seenIso = new Date(seenAt).toISOString();
    // The item this command added or sighted: a fresh id, else the same text, else the one
    // stamped just now (a text the store clamped no longer matches `key`).
    const locate = (items) =>
      items.find((it) => !beforeIds.has(it.id)) ??
      items.find((it) => normalizeAliasKey(it.text) === key) ??
      items.find((it) => it.lastSeen === seenIso);

    const existing = before.find((it) => normalizeAliasKey(it.text) === key);
    let item;
    if (existing && existing.weight >= target) {
      item = locate(store.applyLearnedOps(guildId, { add: [{ text }] }, { ...memoryCfg, seenAt }));
    } else {
      for (let i = 0; i < target; i += 1) {
        item = locate(store.applyLearnedOps(guildId, { add: [{ text }] }, { ...memoryCfg, confirmGapHours: 0, seenAt }));
        if (!item || item.weight >= target) break;
      }
    }
    if (!item) throw new Error('the item was not kept (the learned list is full)');
    return learnedLine(item, tokenResolver(guildId));
  }

  /** `/nep learned remove`: deletes one item by id; an id that is not stored is an error. */
  function cmdLearnedRemove(args, context) {
    assertNotPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const id = args?.id;
    if (!Number.isInteger(id)) throw new Error('an item id is required');
    const existing = (store.getGuild(guildId).learned ?? []).find((item) => item.id === id);
    if (!existing) throw new Error(`no learned item #${id}`);

    store.applyLearnedOps(guildId, { remove: [id] }, { ...(hot.config?.memory ?? {}), seenAt: Date.now() });
    return `Removed learned item #${id}: ${tokenResolver(guildId)(existing.text)}`;
  }

  const MODEL_ID_RE = /^[\w.:/-]{3,100}$/;
const MODEL_ROLE_PATHS = {
  talk: 'llm.model',
  analyzer: 'memory.model',
  'classifier.text': 'classifier.text',
  'classifier.media': 'classifier.media',
  'classifier.video': 'classifier.video',
  mentor: 'mentor.model',
};
const MODEL_ROLES = Object.keys(MODEL_ROLE_PATHS);

/** `image.model` for status and model show, `-` when unset, flagged when src/llm/images.js
 * has no request mapping for its family (every generation would be refused). */
function imageModelLabel(cfg) {
  const model = cfg?.image?.model;
  if (!model) return '-';
  const family = (images?.familyOf ?? imageFamilyOf)(model);
  return family ? model : `${model} (unsupported family)`;
}

function cmdModelShow() {
  const cfg = hot.config;
  const lines = [
    ...MODEL_ROLES.map((role) => `${role}: ${modelForRole(role, cfg) ?? '-'}`),
    `image: ${imageModelLabel(cfg)}`,
    `mediaDescriptions: ${cfg?.features?.mediaDescriptions === true ? 'on' : 'off'}`,
  ];
  return lines.join('\n');
}

function cmdModelSet(args) {
  const role = String(args?.role ?? '');
  const dottedPath = MODEL_ROLE_PATHS[role];
  if (!dottedPath) throw new Error(`unknown role: ${role} (${MODEL_ROLES.join(', ')})`);

  const id = String(args?.id ?? '').trim();
  if (!MODEL_ID_RE.test(id)) throw new Error('id must look like a model id, e.g. anthropic/claude-haiku-4.5 (3-100 chars)');

  const localPath = path.join(hot.rootDir, 'config.local.json');
  const next = setPath(readLocalConfig(localPath), dottedPath, id);
  writeLocalConfig(localPath, next);
  const ok = hot.reloadConfig();
  return `Set ${role} model to ${id} (reload ${ok ? 'ok' : 'FAILED'})`;
}

// ---------------------------------------------------------------------
// ping: one minimal chat completion per role's model, in parallel,
// to tell the owner in seconds whether each one is actually reachable.
// Never touches the daily request cap or token calibration
// (src/llm/openrouter.js#complete's `countAgainstDailyCap`
// / `skipCalibration` options), never writes under data/.
// The drawing model cannot take a chat completion and a generation costs
// money and counts against the image caps, so the `image` role is checked
// against the provider's public model listing instead: one free GET.
// ---------------------------------------------------------------------

/** `/nep ping classifier` pings the three classifier roles together. */
const PING_GROUPS = { classifier: ['classifier.text', 'classifier.media', 'classifier.video'] };

/** The pseudo-role of `/nep ping` that checks `image.model` against the listing; never a MODEL_ROLES entry. */
const PING_IMAGE_ROLE = 'image';

/** The roles one `/nep ping` argument stands for: one role, a group, the image check, or (anything else)
 * all of them, the image check last. */
function pingRolesFor(role) {
  if (MODEL_ROLES.includes(role)) return [role];
  if (PING_GROUPS[role]) return PING_GROUPS[role];
  if (role === PING_IMAGE_ROLE) return [PING_IMAGE_ROLE];
  return [...MODEL_ROLES, PING_IMAGE_ROLE];
}

/** The model id one role resolves to right now — used by model show and ping alike. */
function modelForRole(role, cfg) {
  if (role === 'talk') return cfg?.llm?.model || undefined;
  if (role === 'analyzer') return cfg?.memory?.model || cfg?.llm?.model || undefined;
  if (role === 'classifier.text') return classifierTextModel(cfg);
  if (role === 'classifier.media') return classifierMediaModel(cfg);
  if (role === 'classifier.video') return classifierVideoModel(cfg);
  // No fallback to the talk model: an unset mentor model means the mentor is not configured.
  if (role === 'mentor') return cfg?.mentor?.model || undefined;
  return undefined;
}

/** `entry.step`/`.name`/`.stage`, or `'step'` when a routing-funnel entry names itself none of those. */
function funnelStepName(entry) {
  return entry?.step ?? entry?.name ?? entry?.stage ?? 'step';
}

/** `entry.endpoint_count` (OpenRouter's real key, verbatim from a captured 404 body) first, then a
 * few other plausible spellings, so a future rename does not silently go blank. */
function funnelEndpointCount(entry) {
  return entry?.endpoint_count ?? entry?.endpoints ?? entry?.count ?? entry?.remaining ?? entry?.endpointCount;
}

function describeFunnelStep(entry) {
  const count = funnelEndpointCount(entry);
  return count == null ? funnelStepName(entry) : `${funnelStepName(entry)} -> ${count} endpoints`;
}

/**
 * The last `routing_funnel` step out of an OpenRouter error body, when present -- the diagnostic
 * that actually tells "wrong provider keys" apart from a genuine outage. A real captured 404 body
 * carries it at `error.metadata.routing_funnel` (checked first); a
 * couple of other plausible locations are tried too, and it never throws on a body that is not
 * JSON or carries no such field. When the step that first hit 0 endpoints is not the last step
 * (the funnel kept going after already emptying out), both are shown -- the first zero is usually
 * the actually useful one to fix, the last is what the request ultimately failed at.
 */
function extractRoutingFunnel(rawBody) {
  if (!rawBody) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const funnel = parsed?.error?.metadata?.routing_funnel ?? parsed?.routing_funnel ?? parsed?.error?.routing_funnel;
  if (!Array.isArray(funnel) || funnel.length === 0) return null;
  const last = funnel[funnel.length - 1];
  if (!last || typeof last !== 'object') return null;

  const firstZero = funnel.find((entry) => funnelEndpointCount(entry) === 0);
  const lastLine = `funnel: ${describeFunnelStep(last)}`;
  if (firstZero && firstZero !== last) {
    return `${lastLine} (first hit 0 at ${describeFunnelStep(firstZero)})`;
  }
  return lastLine;
}

/** One role's line on a successful ping. */
function formatPingSuccess(role, model, result, ms) {
  const parts = [`${role}: ${model} — ok, ${ms}ms`];
  if (result.provider) parts.push(`provider=${result.provider}`);
  const usage = result.usage ?? {};
  if (usage.prompt_tokens != null || usage.completion_tokens != null) {
    parts.push(`tokens ${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}`);
  }
  return parts.join(', ');
}

/** One role's line on a failed ping: the HTTP status is already folded into `err.message` by
 * src/llm/openrouter.js, so this only trims it and appends the routing-funnel diagnostic, if any. */
function formatPingFailure(role, model, err, ms) {
  const message = String(err?.message ?? err ?? 'error').slice(0, 200);
  const parts = [`${role}: ${model} — FAIL, ${ms}ms, ${message}`];
  const funnel = extractRoutingFunnel(err?.body);
  if (funnel) parts.push(funnel);
  return parts.join(' | ');
}

/** The YouTube line of `/nep ping video`: the state of the Data API key given which duration
 * source works here (src/memory/youtube-check.js). No duration, no detail. */
function formatYoutubeLine(result) {
  const status = result?.status;
  const keySet = Boolean(result?.keySet);
  let state;
  if (status === 'api') state = 'ok';
  else if (status === 'ytdlp') state = 'not needed (yt-dlp ok)';
  else if (status === 'page') state = keySet ? 'failed (page only, unreliable)' : 'missing (page only, unreliable)';
  else state = keySet ? 'failed (blocked)' : 'missing (blocked)';
  return `youtube: API key — ${state}`;
}

/** Start the YouTube check when the classifier.video role is pinged and a describer is wired; never rejects. */
function startPingYoutube(requested) {
  if (!requested.includes('classifier.video') || typeof describer?.checkYoutube !== 'function') return null;
  return Promise.resolve()
    .then(() => describer.checkYoutube())
    .then(formatYoutubeLine, () => 'youtube: API key — unknown');
}

/** `lines` with the YouTube line inserted right after the classifier.video line. */
function withYoutubeLine(lines, requested, youtubeLine) {
  if (youtubeLine == null) return lines;
  const at = requested.indexOf('classifier.video');
  return [...lines.slice(0, at + 1), youtubeLine, ...lines.slice(at + 1)];
}

/**
 * `lines` with the web lookup line appended when the classifier.text role (the
 * page and search condensers' model) is pinged and a lookup is wired: whether
 * the lookup is on (features.webLookup, a missing key counts as OFF) and a
 * search key is configured. No network call; never the key itself.
 */
function withWebLine(lines, requested) {
  if (!requested.includes('classifier.text') || typeof lookup?.hasSearch !== 'function') return lines;
  let line;
  if (hot.config?.features?.webLookup !== true) line = 'web: API key — off';
  else line = lookup.hasSearch() ? 'web: API key — ok' : 'web: API key — missing';
  return [...lines, line];
}

/** `${baseUrl}/models/<model>/endpoints`, tolerating trailing slashes on `baseUrl` like the llm
 * and image clients do; the model id goes in as is, its slash is a path separator. */
function modelEndpointsUrl(baseUrl, model) {
  return `${String(baseUrl).replace(/\/+$/, '')}/models/${model}/endpoints`;
}

/** The image line before the drawing switch note: one GET against the provider's public
 * listing, or none at all when no model is set or its family is refused. Never rejects;
 * never generates, never counts against a cap, never writes state, never shows the key. */
async function checkImageListing(cfg) {
  const model = cfg?.image?.model;
  if (!model) return `${PING_IMAGE_ROLE}: (no model configured)`;
  if (!(images?.familyOf ?? imageFamilyOf)(model)) return `${PING_IMAGE_ROLE}: ${model} — unsupported family`;

  const start = Date.now();
  const apiKey = typeof getApiKey === 'function' ? getApiKey() : undefined;
  let response;
  try {
    response = await fetchImpl(modelEndpointsUrl(cfg?.llm?.baseUrl, model), {
      method: 'GET',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'X-Title': 'neptunia-bot',
      },
      signal: AbortSignal.timeout(cfg?.llm?.pingTimeoutMs ?? 30000),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
    return `${PING_IMAGE_ROLE}: ${model} — failed: ${reason}`;
  }
  if (response.status === 404) return `${PING_IMAGE_ROLE}: ${model} — not listed (HTTP 404)`;
  if (!response.ok) return `${PING_IMAGE_ROLE}: ${model} — failed: HTTP ${response.status}`;

  const json = await Promise.resolve()
    .then(() => response.json())
    .catch(() => null);
  const modalities = json?.data?.architecture?.output_modalities;
  if (!Array.isArray(modalities) || !modalities.includes('image')) {
    return `${PING_IMAGE_ROLE}: ${model} — listed, but no image output`;
  }
  const endpoints = Array.isArray(json.data.endpoints) ? json.data.endpoints.length : 0;
  return `${PING_IMAGE_ROLE}: ${model} — listed, image output, ${endpoints} endpoint(s), ${Date.now() - start} ms`;
}

/** Start the image check when the image role is requested; never rejects. The line notes when
 * drawing is switched off (features.imageGeneration false; a missing key counts as on). */
function startPingImage(requested, cfg) {
  if (!requested.includes(PING_IMAGE_ROLE)) return null;
  const off = cfg?.features?.imageGeneration === false;
  return checkImageListing(cfg).then((line) => (off ? `${line} (features.imageGeneration is off)` : line));
}

/** `lines` with the image line appended last, after every model line and the lines that follow them. */
function withImageLine(lines, imageLine) {
  if (imageLine == null) return lines;
  return [...lines, imageLine];
}

async function cmdPing(args) {
  if (!llm) throw new Error('ping is not available (no llm client configured)');

  const requested = pingRolesFor(args?.role);
  const modelRoles = requested.filter((role) => role !== PING_IMAGE_ROLE);
  const cfg = hot.config;
  const roleModel = new Map(modelRoles.map((role) => [role, modelForRole(role, cfg)]));

  const youtube = startPingYoutube(modelRoles);
  const image = startPingImage(requested, cfg);

  const promptText = hot.prompts?.labels?.ping?.prompt;
  if (!promptText) {
    const skipped = modelRoles.map((role) => `${role}: ${roleModel.get(role) ?? '(no model configured)'} — skipped: label missing`);
    return withImageLine(withWebLine(withYoutubeLine(skipped, modelRoles, await youtube), modelRoles), await image).join('\n');
  }

  // One request per distinct (model, route): roles sharing a model share a ping unless a
  // role-specific `llm.providerByModel` key routes one of them elsewhere. Each request is
  // sent as the first role that needs it, so it goes out exactly as that role's would.
  const targetOf = (role) => {
    const model = roleModel.get(role);
    const route = resolveProvider(model, { byModel: cfg?.llm?.providerByModel, fallback: cfg?.llm?.provider, role });
    return `${model}\n${JSON.stringify(route ?? null)}`;
  };
  const targets = new Map();
  for (const role of modelRoles) {
    const model = roleModel.get(role);
    if (model && !targets.has(targetOf(role))) targets.set(targetOf(role), { model, role });
  }
  const results = new Map();

  await Promise.all(
    [...targets].map(async ([target, { model, role }]) => {
      const start = Date.now();
      try {
        const result = await llm.complete([{ role: 'user', content: promptText }], {
          model,
          role,
          maxOutputTokens: 16,
          countAgainstDailyCap: false,
          skipCalibration: true,
          timeoutMs: cfg?.llm?.pingTimeoutMs ?? 30000,
        });
        results.set(target, { ok: true, ms: Date.now() - start, result });
      } catch (err) {
        results.set(target, { ok: false, ms: Date.now() - start, err });
      }
    }),
  );

  const lines = modelRoles.map((role) => {
    const model = roleModel.get(role);
    if (!model) return `${role}: (no model configured)`;
    const outcome = results.get(targetOf(role));
    return outcome.ok
      ? formatPingSuccess(role, model, outcome.result, outcome.ms)
      : formatPingFailure(role, model, outcome.err, outcome.ms);
  });
  return withImageLine(withWebLine(withYoutubeLine(lines, modelRoles, await youtube), modelRoles), await image).join('\n');
}

  // ---------------------------------------------------------------------
  // route: which providers serve each model, per role -- the keys of
  // `llm.providerByModel` (`"<prefix>"` for any role, `"<prefix>@<role>"`
  // for one; resolved by src/llm/openrouter.js#matchRoute), written to
  // config.local.json like `/nep set`, never touching data/.
  // ---------------------------------------------------------------------

  /** Every role a route may name: the `/nep model` roles, then the drawing model's. */
  const ROUTE_ROLES = [...MODEL_ROLES, PING_IMAGE_ROLE];

  /** A provider slug as OpenRouter writes it: lowercase letters, digits and `-`. */
  const PROVIDER_SLUG_RE = /^[a-z0-9-]+$/;

  function isPlainRouting(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  /** `llm.providerByModel` as of the last write -- config.local.json's when it has one, else the
   * live config's -- so a list right after a set or remove reads what was written even a moment
   * before the reload lands (the same reasoning as `effectiveAccess`). */
  function effectiveRoutes() {
    const local = readLocalConfig(path.join(hot.rootDir, 'config.local.json'));
    if (isPlainRouting(local?.llm) && Object.hasOwn(local.llm, 'providerByModel')) {
      return isPlainRouting(local.llm.providerByModel) ? local.llm.providerByModel : {};
    }
    const live = hot.config?.llm?.providerByModel;
    return isPlainRouting(live) ? live : {};
  }

  /** The providers part of a routing object: its `only`/`order`/`ignore` lists, or the object as
   * JSON (without `allow_fallbacks`, shown on its own) when it holds anything else. */
  function describeProviders(value) {
    const lists = ['only', 'order', 'ignore'];
    const known = new Set([...lists, 'allow_fallbacks']);
    const parts = lists
      .filter((field) => Array.isArray(value[field]) && value[field].length > 0)
      .map((field) => `${field} ${value[field].join(', ')}`);
    if (parts.length > 0 && Object.keys(value).every((field) => known.has(field))) return parts.join('; ');
    const { allow_fallbacks: _ignored, ...rest } = value;
    return JSON.stringify(rest).slice(0, 200);
  }

  /** `on` unless the routing object says `allow_fallbacks: false` (OpenRouter's default is on). */
  function fallbacksText(value) {
    return value.allow_fallbacks === false ? 'off' : 'on';
  }

  /** `(<providers>, fallbacks: on|off)` for the by-role lines. */
  function routingSummary(value) {
    return `(${describeProviders(value)}, fallbacks: ${fallbacksText(value)})`;
  }

  /** The prefix of a `/nep route` command: trimmed, required, no `@` (the role has its own
   * option), no whitespace, never an object-prototype key. */
  function routePrefixArg(args) {
    const prefix = String(args?.model ?? '').trim();
    if (!prefix) throw new Error('a model id or prefix is required');
    if (prefix.includes('@')) throw new Error('the model prefix cannot contain @ (give the role in the role option)');
    if (/\s/.test(prefix)) throw new Error('the model prefix cannot contain spaces');
    if (prefix.length > 100) throw new Error('the model prefix is too long (100 chars max)');
    if (FORBIDDEN_SEGMENTS.has(prefix)) throw new Error(`forbidden model prefix: ${prefix}`);
    return prefix;
  }

  /** The role of a `/nep route` command, or null for any role. */
  function routeRoleArg(args) {
    const role = args?.role;
    if (role === undefined || role === null || role === '') return null;
    if (!ROUTE_ROLES.includes(String(role))) throw new Error(`unknown role: ${role} (${ROUTE_ROLES.join(', ')})`);
    return String(role);
  }

  /** config.local.json with `llm.providerByModel` replaced by `edit(copyOfTheLocalMap)`'s result;
   * an emptied map, then an emptied `llm`, are pruned. Reloads the config. */
  function writeRoutes(edit) {
    const localPath = path.join(hot.rootDir, 'config.local.json');
    const next = structuredClone(readLocalConfig(localPath));
    const llmCfg = isPlainRouting(next.llm) ? next.llm : {};
    const map = edit(isPlainRouting(llmCfg.providerByModel) ? { ...llmCfg.providerByModel } : {});
    if (Object.keys(map).length > 0) llmCfg.providerByModel = map;
    else delete llmCfg.providerByModel;
    if (Object.keys(llmCfg).length > 0) next.llm = llmCfg;
    else delete next.llm;
    writeLocalConfig(localPath, next);
    return hot.reloadConfig();
  }

  /** The model one route role uses now: the `/nep model` roles as `modelForRole`, `image` as `image.model`. */
  function modelForRouteRole(role, cfg) {
    if (role === PING_IMAGE_ROLE) return cfg?.image?.model || undefined;
    return modelForRole(role, cfg);
  }

  /** One by-role line of `/nep route list`: the model and the routing it gets now. */
  function routeRoleLine(role, cfg, byModel) {
    const model = modelForRouteRole(role, cfg);
    if (!model) return `  ${role}: (no model configured)`;
    const match = matchRoute(model, byModel, role);
    const fallbackName = role === PING_IMAGE_ROLE ? 'image.provider' : 'llm.provider';
    const fallback = role === PING_IMAGE_ROLE ? cfg?.image?.provider : cfg?.llm?.provider;
    let applied = 'none';
    if (match) applied = `${match.key} ${routingSummary(match.value)}`;
    else if (isPlainRouting(fallback)) applied = `${fallbackName} ${routingSummary(fallback)}`;
    const pin = cfg?.media?.video?.provider;
    const pinned = role === 'classifier.video' && isPlainRouting(pin) ? `; direct-URL videos: media.video.provider ${routingSummary(pin)}` : '';
    return `  ${role}: ${model} -> ${applied}${pinned}`;
  }

  /** `/nep route list`: every route, one line each (prefix | role or any | providers | fallbacks),
   * then each role with the model it uses now and the routing that applies to it. */
  function cmdRouteList() {
    const cfg = hot.config;
    const byModel = effectiveRoutes();
    const roleRank = (role) => (role === null ? -1 : ROUTE_ROLES.includes(role) ? ROUTE_ROLES.indexOf(role) : ROUTE_ROLES.length);
    const routes = Object.entries(byModel)
      .filter(([, value]) => isPlainRouting(value))
      .map(([key, value]) => {
        const at = key.lastIndexOf('@');
        return at === -1 ? { prefix: key, role: null, value } : { prefix: key.slice(0, at), role: key.slice(at + 1), value };
      })
      .sort((a, b) => (a.prefix === b.prefix ? roleRank(a.role) - roleRank(b.role) : a.prefix < b.prefix ? -1 : 1));
    const lines = routes.length === 0 ? ['routes: none'] : ['routes:'];
    for (const route of routes) {
      lines.push(`  ${route.prefix} | ${route.role ?? 'any'} | ${describeProviders(route.value)} | fallbacks: ${fallbacksText(route.value)}`);
    }
    lines.push('by role:', ...ROUTE_ROLES.map((role) => routeRoleLine(role, cfg, byModel)));
    return lines.join('\n');
  }

  /** `/nep route set`: `{ only: [providers], allow_fallbacks }` under `<prefix>` or `<prefix>@<role>`. */
  function cmdRouteSet(args) {
    const prefix = routePrefixArg(args);
    const role = routeRoleArg(args);
    const providers = [...new Set(String(args?.providers ?? '').split(',').map((slug) => slug.trim()).filter(Boolean))];
    if (providers.length === 0) throw new Error('at least one provider slug is required, e.g. google-vertex');
    const invalid = providers.find((slug) => !PROVIDER_SLUG_RE.test(slug));
    if (invalid) throw new Error(`invalid provider slug: ${invalid} (lowercase letters, digits and -)`);
    const allowFallbacks = args?.fallbacks === true;

    const key = role ? `${prefix}@${role}` : prefix;
    const ok = writeRoutes((map) => ({ ...map, [key]: { only: providers, allow_fallbacks: allowFallbacks } }));
    return `Route ${key} (${role ?? 'any role'}): only ${providers.join(', ')}, fallbacks: ${allowFallbacks ? 'on' : 'off'} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  /** `/nep route remove`: drops the `<prefix>` or `<prefix>@<role>` key from config.local.json. */
  function cmdRouteRemove(args) {
    const prefix = routePrefixArg(args);
    const role = routeRoleArg(args);
    const key = role ? `${prefix}@${role}` : prefix;
    const local = readLocalConfig(path.join(hot.rootDir, 'config.local.json'));
    const localMap = isPlainRouting(local?.llm?.providerByModel) ? local.llm.providerByModel : {};
    if (!Object.hasOwn(localMap, key)) {
      const live = hot.config?.llm?.providerByModel;
      const fromBase = isPlainRouting(live) && Object.hasOwn(live, key) ? ' in config.local.json (it is set in config.json)' : '';
      throw new Error(`no route: ${key}${fromBase}`);
    }
    const ok = writeRoutes((map) => {
      delete map[key];
      return map;
    });
    return `Removed route ${key} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  // ---------------------------------------------------------------------
  // warmup: the sample-based memory warmup -- see the module header of
  // src/memory/warmup.js. `people`/`status` stay read-only, never guarded
  // by assertNotPaused(); everything else writes under data/ and is.
  // ---------------------------------------------------------------------

  /** `YYYY-MM-DD`, or `-` when `ts` is not a finite timestamp. */
  function warmupDate(ts) {
    return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '-';
  }

  function formatWarmupPeople(report) {
    if (!report.ok) return report.message;
    const lines = report.people.map((p, i) => {
      const topChannels = Object.entries(p.byChannel)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cid, count]) => `${cid}:${count}`)
        .join(', ');
      return `${i + 1}. ${p.name} (id:${p.id}) — ${p.messages} messages, ${warmupDate(p.firstTs)}..${warmupDate(p.lastTs)}, top channels: ${topChannels || '-'}`;
    });
    if (lines.length === 0) lines.push('(nobody currently qualifies)');
    lines.push('');
    lines.push(`channels read: ${report.totals.channelsRead}`);
    lines.push(`messages read: ${report.totals.messagesRead}`);
    lines.push(`people below the threshold: ${report.totals.belowThreshold}`);
    return lines.join('\n');
  }

  async function cmdWarmupPeople(_args, context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    return formatWarmupPeople(await warmup.peopleReport(guildId));
  }

  async function cmdWarmupRun(_args, context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    assertNotPaused();
    if (typeof warmup.isWarmingUp === 'function' && warmup.isWarmingUp()) return 'a warmup is already in flight: see /nep warmup status';

    // Fire and forget: a full run takes many minutes, far beyond an interaction's lifetime.
    // Progress is persisted after every request; /nep warmup status follows it.
    warmup.run(guildId).catch((err) => log.warn('admin: warmup run failed', { error: err }));
    return 'warmup started: channels, then people, then the server. Follow it with /nep warmup status.';
  }

  /** `/nep warmup stop`: ends any warmup work in flight for good -- the full run, a
   * `users`/`channels` bulk redo, or a synchronous one-off -- including cancelling the model call
   * actually in progress (see src/memory/warmup.js#stop). Reads no `data/` itself, so not
   * guarded by assertNotPaused(). */
  function cmdWarmupStop() {
    const result = warmup.stop();
    return result.ok ? 'warmup stopped' : 'no warmup in flight';
  }

  /** `/nep warmup users user:<member>`: a short summary of what was actually written -- sample
   * size, tokens, counts of interests/details/episodes/aliases, and the first ~300 chars of the
   * character field. Relays `outcome.message` unchanged when nothing was written (missing prompt
   * file, no messages in the window, a bad model answer, a stop mid-flight, ...). */
  function formatWarmupUserWritten(outcome) {
    if (!outcome.ok) return outcome.message ?? outcome.reason ?? 'not done';
    const { member, answer, sample, tokensUsed, chunks } = outcome;
    const a = answer ?? {};
    const characterExcerpt = String(a.character ?? '').slice(0, 300) || '(empty)';
    const chunkNote = chunks > 1 ? `, ${chunks} chunks` : '';
    return [
      `profiled ${member.name} (id:${member.id})`,
      `sample: ${sample?.ownCount ?? '?'} own / ${sample?.contextCount ?? '?'} context lines${chunkNote}`,
      `tokens used: ${tokensUsed ?? '?'}`,
      `interests: ${a.interests?.length ?? 0}, details: ${a.details?.length ?? 0}, episodes: ${a.episodes?.length ?? 0}, aliases: ${a.aliases?.length ?? 0}`,
      `character: ${characterExcerpt}`,
    ].join('\n');
  }

  /** `/nep warmup users [user]`: a `user` given
   * -> (re)profiles exactly that member now, synchronously; omitted -> starts a background redo of
   * every qualifying member, sharing every rail with the full run. */
  async function cmdWarmupUsers(args, context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    assertNotPaused();

    const userId = args?.userId;
    if (userId) {
      const result = await warmup.runPerson(guildId, userId);
      return formatWarmupUserWritten(result.ok ? result.outcome : result);
    }

    const result = await warmup.runUsers(guildId);
    if (!result.ok) return result.message ?? 'not started';
    return `started ${result.count} members`;
  }

  /** `/nep warmup channels channel:<channel>`: the note actually written (purpose/topics/tone),
   * plus the counters and top writers `store.setChannelFacts` just filled in -- writers
   * resolved to their current stored name, an id with no profile skipped. Relays `outcome.message`
   * unchanged when nothing was written. */
  function formatWarmupChannelWritten(outcome, guildId) {
    if (!outcome.ok) return outcome.message ?? outcome.reason ?? 'not done';
    const { channel, result, facts } = outcome;
    const lines = [
      `described #${channel.name} (id:${channel.id})`,
      `purpose: ${result.purpose || '(empty)'}`,
      `topics: ${result.topics || '(empty)'}`,
      `tone: ${result.tone || '(empty)'}`,
    ];
    if (facts) {
      lines.push(`messages seen: ${facts.messageCount}`);
      lines.push(`last message: ${facts.lastMessageAt ? humanizeAgo(facts.lastMessageAt) : 'never'}`);
      const writers = (facts.topWriters ?? [])
        .map((w) => store.getUser(guildId, w.id)?.names?.[0])
        .filter(Boolean);
      if (writers.length > 0) lines.push(`top writers: ${writers.join(', ')}`);
    }
    return lines.join('\n');
  }

  /** `/nep warmup channels [channel]`: a
   * `channel` given -> (re)describes exactly that channel now, synchronously; omitted -> starts a
   * background redo of every readable channel, sharing every rail with the full run. */
  async function cmdWarmupChannels(args, context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    assertNotPaused();

    const channelId = args?.channelId;
    if (channelId) {
      const result = await warmup.runChannel(guildId, channelId);
      return formatWarmupChannelWritten(result.ok ? result.outcome : result, guildId);
    }

    const result = await warmup.runChannels(guildId);
    if (!result.ok) return result.message ?? 'not started';
    return `started ${result.count} channels`;
  }

  /** `/nep warmup server`: counts of what was written (patterns/starters lengths, injokes, lore
   * entries). Relays `outcome.message` unchanged when nothing was written. */
  function formatWarmupServerWritten(outcome) {
    if (!outcome.ok) return outcome.message ?? outcome.reason ?? 'not done';
    const c = outcome.counts;
    return `server notes updated: patterns ${c.patternsChars} chars, starters ${c.startersChars} chars, injokes ${c.injokes}, lore entries ${c.lore}`;
  }

  async function cmdWarmupServer(_args, context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    assertNotPaused();

    const result = await warmup.runServer(guildId);
    return formatWarmupServerWritten(result.ok ? result.outcome : result);
  }

  /** `N s ago` / `N min ago` / `N h ago`, or `never` when `lastActivityAt` is unknown. */
  function humanizeAgo(lastActivityAt) {
    if (!Number.isFinite(lastActivityAt)) return 'never';
    const deltaMs = Math.max(0, Date.now() - lastActivityAt);
    const seconds = Math.round(deltaMs / 1000);
    if (seconds < 60) return `${seconds} s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
  }

  /** One `phase: …` line's TEXT from a warmup status's in-memory `activity` snapshot (see
   * src/memory/warmup.js's `touchActivity`) -- falls back to `s.phase` (the coarser "running" /
   * "not started" / "finished" / "aborted (reason)" / "idle" summary) whenever `activity` carries
   * nothing more specific yet (e.g. right after a restart, before the first channel is fetched).
   * Never throws on a missing/partial snapshot. */
  function formatWarmupPhase(s) {
    const a = s?.activity;
    const d = a?.detail ?? {};
    switch (a?.phase) {
      case 'fetching':
        return `fetching history, ${d.channelsFetched ?? 0}/${d.channelsTotal ?? 0} channels`;
      case 'channel': {
        const label = d.name ? `#${d.name}` : d.id ? `id:${d.id}` : 'a channel';
        const count = d.total ? ` (${d.index ?? '?'} of ${d.total})` : '';
        return `describing channel ${label}${count}`;
      }
      case 'person': {
        const who = `${d.name ?? '?'} (id:${d.id ?? '?'})`;
        const count = d.total ? ` (${d.index ?? '?'} of ${d.total})` : '';
        const chunk = d.chunk ? `, chunk ${d.chunk.k}/${d.chunk.n}` : '';
        return `profiling ${who}${count}${chunk}`;
      }
      case 'server':
        return 'building the server notes';
      case 'waiting-rate-limit': {
        const until = Number.isFinite(d.until) ? `${new Date(d.until).toISOString().slice(11, 16)} UTC` : '?';
        return `waiting for the provider rate limit until ${until} (wait ${d.waits ?? 1})`;
      }
      case 'paused':
        return 'paused';
      case 'stopped':
        return 'stopped';
      case 'finished':
        return 'finished';
      case 'aborted':
        return `aborted (${d.reason ?? s?.aborted ?? 'unknown'})`;
      default:
        return s?.phase ?? 'idle';
    }
  }

  async function cmdWarmupStatus(_args, context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    const s = await warmup.status(guildId); // synchronous in the real runner; awaiting a plain value is harmless
    return [
      `phase: ${formatWarmupPhase(s)}`,
      `last activity: ${humanizeAgo(s.activity?.lastActivityAt)}`,
      `channels: ${s.doneChannels}/${s.channelsEligible ?? "?"}`,
      `people: ${s.donePeople}/${s.peopleEligible ?? "?"}`,
      `server: ${s.doneServer ? 'done' : 'pending'}`,
      `tokens used: ${s.tokensUsed} / ${hot.config.warmup?.maxTokens ?? '-'}`,
      `requests: ${s.requests}`,
      `started: ${s.startedAt ?? '-'}`,
      `finished: ${s.finishedAt ?? '-'}`,
      `aborted: ${s.aborted ?? 'no'}`,
      `next target: ${s.nextTarget ?? '-'}`,
    ].join('\n');
  }

  /** `/nep warmup reset`: clears warmup progress only (stored profiles/channel/guild data
   * untouched). Writes `state.json`, so refused while paused like the other warmup commands. */
  function cmdWarmupReset() {
    assertNotPaused();
    const result = warmup.reset();
    return result.ok ? 'Warmup progress reset (stored profiles/channel/guild data untouched).' : result.message;
  }

  /** `/nep memory refresh user:<member>`: forces a portrait refresh (character/style only),
   * ignoring the hours rail, not the daily request cap. Refused while paused. */
  async function cmdMemoryRefresh(args, context) {
    if (!warmup) throw new Error('warmup is not available');
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const result = await warmup.refreshPortrait(guildId, userId, 'manual refresh requested by the owner', { force: true });
    if (!result.ok) return `Refresh not performed: ${result.reason ?? result.message ?? 'unknown reason'}`;
    return `Portrait refreshed for ${userId}.`;
  }

  // ---------------------------------------------------------------------
  // mentor: the manual mentor (src/mentor/*). Cases go through
  // `mentorCases`, runs through `mentor`, numbers through `mentorBudget`.
  // `cases`/`show`/`status`/`stop` only read or abort, so they are never
  // guarded by assertNotPaused(); the rest write under data/ and are.
  // ---------------------------------------------------------------------

  const MENTOR_CASE_TEXT_SHOWN = 80;
  const MENTOR_STATES = ['new', 'passing', 'failing', 'retired'];

  /** The served guild, or an Error before it resolves. */
  function mentorGuildId(context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    return guildId;
  }

  /** The `id` option as a positive integer, or an Error. */
  function mentorCaseId(args) {
    const id = Number(args?.id);
    if (!Number.isInteger(id) || id < 1) throw new Error('a case id is required');
    return id;
  }

  /** The `message` option: a message link or id, or an Error. */
  function mentorMessageRef(args) {
    const ref = typeof args?.message === 'string' ? args.message.trim() : '';
    if (!ref) throw new Error('a message link or id is required');
    return ref;
  }

  /** `moment <id>: <n> messages up to the trigger, an answer of <m> messages`. */
  function momentLine(anchor) {
    return `moment ${anchor.id}: ${anchor.history.length} messages up to the trigger, an answer of ${anchor.original.length} messages`;
  }

  /** A case is a message of the persona plus the owner's comment: both are required, the target is
   * always `reply`. The comment is checked before the message is read; reading it spends no tokens. */
  async function cmdMentorAdd(args, context) {
    assertNotPaused();
    const guildId = mentorGuildId(context);
    const ref = mentorMessageRef(args);
    const text = checkCaseText(args?.text);
    const anchor = await mentor.resolveAnchor(ref, { channelId: context?.channelId ?? null });
    const item = mentorCases.add(guildId, { text, target: 'reply', anchor });
    return `case ${item.id} added (${item.target}), ${momentLine(item.anchors[0])}`;
  }

  /** Adds another moment to a case, at most `mentor.anchor.max` (read now); a case that cannot take
   * one more is refused before the message is read. */
  async function cmdMentorAnchor(args, context) {
    assertNotPaused();
    const guildId = mentorGuildId(context);
    const id = mentorCaseId(args);
    const ref = mentorMessageRef(args);
    const item = mentorCases.get(guildId, id);
    if (!item) throw new Error(`unknown case: ${id}`);
    const max = anchorMax(hot.config.mentor?.anchor?.max);
    const held = Array.isArray(item.anchors) ? item.anchors.length : 0;
    if (held >= max) throw new Error(`case ${id} has ${held} moments; at most ${max} (mentor.anchor.max)`);
    const anchor = await mentor.resolveAnchor(ref, { channelId: context?.channelId ?? null });
    const { item: updated, anchor: added } = mentorCases.addAnchor(guildId, id, anchor, { max });
    return `case ${id}: ${momentLine(added)} (${updated.anchors.length} of ${max})`;
  }

  /** One line per active case: `<id> [<state>] <target> <score or -> <text clipped to 80>`, with
   * `moments <n>` before the text for a case that has any. */
  function cmdMentorCases(_args, context) {
    const list = mentorCases.list(mentorGuildId(context));
    if (list.length === 0) return 'no cases yet';
    return list
      .map((item) => {
        const score = typeof item.lastScore === 'number' && Number.isFinite(item.lastScore) ? String(item.lastScore) : '-';
        const text = String(item.text ?? '').replace(/\s+/g, ' ');
        const shown = text.length > MENTOR_CASE_TEXT_SHOWN ? `${text.slice(0, MENTOR_CASE_TEXT_SHOWN - 3)}...` : text;
        const moments = Array.isArray(item.anchors) && item.anchors.length > 0 ? `moments ${item.anchors.length} ` : '';
        return `${item.id} [${item.state}] ${item.target} ${score} ${moments}${shown}`;
      })
      .join('\n');
  }

  function cmdMentorRemove(args, context) {
    assertNotPaused();
    const id = mentorCaseId(args);
    const item = mentorCases.retire(mentorGuildId(context), id);
    return `case ${item.id} retired`;
  }

  /** Starts the run and answers at once: the run ends far beyond an interaction's lifetime. With an
   * admin channel (`bot.dryRunChannelId`, read now) the mentor posts its report there; without one
   * the reply points at `status` and `show`. A guard of the mentor rejects here. */
  async function cmdMentorRun(args) {
    assertNotPaused();
    const id = mentorCaseId(args);
    await mentor.run(id);
    if (hot.config.bot?.dryRunChannelId) return `run started for case ${id}; the report will come to the admin channel`;
    return `run started for case ${id}; follow it with /nep mentor status, read the report with /nep mentor show ${id}`;
  }

  /** Starts a check of every case with a run; answers at once, like `run`, and the same way
   * points at `status` and `show` when there is no admin channel. */
  async function cmdMentorCheck() {
    assertNotPaused();
    const { cases } = await mentor.check();
    if (hot.config.bot?.dryRunChannelId) return `check started for ${cases} cases`;
    return `check started for ${cases} cases; follow it with /nep mentor status, read each report with /nep mentor show <id>`;
  }

  /** Aborts the run in flight; reads no `data/` itself, so not guarded by assertNotPaused(). */
  function cmdMentorStop() {
    return mentor.stop().ok ? 'stopping' : 'nothing is running';
  }

  /** The case's last run (a `check` run the same way): the card, with the full report attached. */
  function cmdMentorShow(args, context) {
    const guildId = mentorGuildId(context);
    const id = mentorCaseId(args);
    if (!mentorCases.get(guildId, id)) throw new Error(`unknown case: ${id}`);
    const run = mentorCases.lastRun(guildId, id);
    if (!run) throw new Error(`case ${id} has no run yet`);
    const file = renderFile(run);
    return { text: renderCard(run), files: [{ attachment: Buffer.from(file.text, 'utf8'), name: file.name }] };
  }

  /** The owner says the mentor judged a case wrongly; the case store refuses a case without a run. */
  function cmdMentorWrong(args, context) {
    assertNotPaused();
    const id = mentorCaseId(args);
    mentorCases.addFeedback(mentorGuildId(context), { caseId: id, reason: args?.reason });
    return `noted for case ${id}`;
  }

  /** The `last:` line: the newest `finishedAt` among the last runs of every case, retired ones
   * included. A run file or case list that cannot be read gives `last: cannot be read`, never a throw. */
  function mentorLastLine(guildId) {
    let latest = null;
    let latestMs = -Infinity;
    try {
      for (const item of mentorCases.list(guildId, { includeRetired: true })) {
        const run = mentorCases.lastRun(guildId, item.id);
        if (!run) continue;
        const ms = Date.parse(run.finishedAt ?? '');
        const rank = Number.isFinite(ms) ? ms : -Infinity;
        if (!latest || rank > latestMs) {
          latest = run;
          latestMs = rank;
        }
      }
    } catch {
      return 'last: cannot be read';
    }
    return renderLastRun(latest);
  }

  /** Works with the mentor off or without a model -- it is how the owner sees why nothing runs.
   * The last line is always the most recent finished run (`last:`). */
  function cmdMentorStatus(_args, context) {
    const lines = [
      `enabled: ${hot.config.features?.mentor === true ? 'yes' : 'no'}`,
      `model: ${hot.config.mentor?.model || '-'}`,
    ];
    if (mentorBudget) {
      const { used, cap, left } = mentorBudget.snapshot();
      lines.push(`tokens today: ${used} / ${cap} (${left} left)`);
    } else {
      lines.push('tokens today: -');
    }
    const guildId = resolvedGuildId(context);
    if (guildId) {
      const counts = Object.fromEntries(MENTOR_STATES.map((state) => [state, 0]));
      for (const item of mentorCases.list(guildId, { includeRetired: true })) {
        if (Object.hasOwn(counts, item.state)) counts[item.state] += 1;
      }
      lines.push(`cases: ${MENTOR_STATES.map((state) => `${counts[state]} ${state}`).join(', ')}`);
    } else {
      lines.push('cases: -');
    }
    const s = mentor.status();
    lines.push(s?.running ? `running: ${s.kind} case ${s.caseId}, ${s.phase}, ${s.tokens} tokens so far${s.stopping ? ', stopping' : ''}` : 'running: no');
    lines.push(guildId ? mentorLastLine(guildId) : 'last: -');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------
  // access: who besides owners may run which commands (src/discord/access.js)
  // ---------------------------------------------------------------------

  /** `key` is grantable when it is `*`, a known subcommand-group name, or a known
   * `<group>.<name>`/bare top-level command key (src/discord/commands.js#commandKeys). */
  function isKnownAccessKey(key) {
    if (key === '*') return true;
    const { keys, groups } = commandKeys();
    return keys.has(key) || groups.has(key);
  }

  /** True when granting `key` opens at least one command that writes (everything not in
   * READ_ONLY_ACCESS_KEYS) — a bare write key, `*`, or a group containing a write subcommand. */
  function accessKeyOpensWrite(key) {
    if (key === '*') return true;
    const { keys, groups } = commandKeys();
    if (groups.has(key)) {
      for (const full of keys) {
        if (full.startsWith(`${key}.`) && !READ_ONLY_ACCESS_KEYS.has(full)) return true;
      }
      return false;
    }
    return !READ_ONLY_ACCESS_KEYS.has(key);
  }

/** `bot.access` as of the last write, WITHOUT relying on `hot.reloadConfig()` having actually
   * re-merged config.local.json into `hot.config` yet -- config.local.json already holds the whole
   * merged object the moment one grant/revoke writes it (see `writeAccess`), so reading it back
   * first keeps repeated grant/revoke/list calls consistent even a moment before the next reload
   * lands. Falls back to `hot.config.bot.access` (the base config.json default, `{}`) before
   * anything has ever been written locally. */
  function effectiveAccess() {
    const localPath = path.join(hot.rootDir, 'config.local.json');
    const local = readLocalConfig(localPath);
    if (local?.bot && typeof local.bot === 'object' && Object.hasOwn(local.bot, 'access')) {
      return local.bot.access ?? {};
    }
    return hot.config?.bot?.access ?? {};
  }

  /** Writes `nextAccess` to `bot.access` in config.local.json and reloads config -- the same
   * mechanism cmdSet/cmdUnset use. */
  function writeAccess(nextAccess) {
    const localPath = path.join(hot.rootDir, 'config.local.json');
    const next = setPath(readLocalConfig(localPath), 'bot.access', nextAccess);
    writeLocalConfig(localPath, next);
    hot.reloadConfig();
  }

  /** `role <@&id>` / `user <@id>` / `everyone`, matching whichever one target option (or neither) was given. */
  function accessTargetArgs(args) {
    const roleId = args?.roleId;
    const userId = args?.userId;
    if (roleId && userId) throw new Error('give a role or a user, not both');
    if (roleId) return { kind: 'role', id: String(roleId), label: `role <@&${roleId}>` };
    if (userId) return { kind: 'user', id: String(userId), label: `user <@${userId}>` };
    return { kind: 'everyone', label: 'everyone' };
  }

  function cmdAccessGrant(args) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw new Error('a command key is required');
    if (!isKnownAccessKey(key)) throw new Error(`unknown command key: ${key}`);
    if (isOwnerOnly(key)) {
      const group = key.split('.')[0];
      throw new Error(`${OWNER_ONLY_NAMES[group] ?? group} is owner-only and cannot be granted: ${key}`);
    }

    const target = accessTargetArgs(args);
    const what = target.kind === 'role' ? { roleId: target.id } : target.kind === 'user' ? { userId: target.id } : { everyone: true };
    writeAccess(accessGrant(effectiveAccess(), key, what));

    const note = accessKeyOpensWrite(key) ? '\nNote: this opens commands that change memory or config.' : '';
    return `Granted ${key} to ${target.label}${note}`;
  }

  function cmdAccessRevoke(args) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw new Error('a command key is required');
    if (!isKnownAccessKey(key)) throw new Error(`unknown command key: ${key}`);

    const target = accessTargetArgs(args);
    const currentAccess = effectiveAccess();
    const entry = currentAccess[key];
    const existed =
      target.kind === 'role'
        ? Array.isArray(entry?.roles) && entry.roles.map(String).includes(target.id)
        : target.kind === 'user'
          ? Array.isArray(entry?.users) && entry.users.map(String).includes(target.id)
          : entry?.everyone === true;
    if (!existed) return 'Nothing to revoke';

    const what = target.kind === 'role' ? { roleId: target.id } : target.kind === 'user' ? { userId: target.id } : { everyone: true };
    writeAccess(accessRevoke(currentAccess, key, what));
    return `Revoked ${key} from ${target.label}`;
  }

  /** Every grant, one line each; a stale grant on an owner-only command (it opens nothing, see
   * src/discord/access.js#isOwnerOnly) is left out. */
  function cmdAccessList() {
    const access = effectiveAccess();
    const keys = Object.keys(access).filter((key) => !isOwnerOnly(key));
    if (keys.length === 0) return 'No grants';

    return keys
      .map((key) => {
        const entry = access[key];
        const parts = [];
        if (entry?.everyone === true) parts.push('everyone');
        if (Array.isArray(entry?.roles) && entry.roles.length > 0) parts.push(`roles ${entry.roles.map((id) => `<@&${id}>`).join(', ')}`);
        if (Array.isArray(entry?.users) && entry.users.length > 0) parts.push(`users ${entry.users.map((id) => `<@${id}>`).join(', ')}`);
        return `${key}: ${parts.join(', ')}`;
      })
      .join('\n');
  }

  /** `/nep emoji status`: how many emoji the ranking holds, the top 10 (rank order,
   * `context.customEmoji.halfLifeDays`) with their counts, and the history backfill stamp. */
  function cmdEmojiStatus(_args, context) {
    freshenIfPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const guild = store.getGuild(guildId);
    const ranked = rankEmojiUsage(guild.emojiUsage, hot.config?.context?.customEmoji?.halfLifeDays ?? 30);
    const stamp = guild.emojiBackfill;
    const running = emojiBackfill?.isRunning?.() ? ' (running now)' : '';
    const backfill = stamp?.at ? `${stamp.at}, ${stamp.channels} channels, ${stamp.messages} messages` : 'never';
    return [
      `ranking: ${ranked.length} emoji`,
      ranked.length > 0 ? 'top 10:' : 'top 10: (none)',
      ...ranked.slice(0, 10).map((entry) => `  :${entry.name}: x${entry.count}`),
      `backfill: ${backfill}${running}`,
    ].join('\n');
  }

  /** Why `/nep emoji rescan` did not run, by src/memory/emoji-backfill.js's skip reason. */
  const EMOJI_RESCAN_SKIPS = {
    running: 'An emoji backfill is already running.',
    disabled: 'The emoji backfill is off (context.customEmoji.backfillMessages is 0).',
    paused: 'paused -- run /nep resume first',
    'no-guild': 'no guild resolved yet',
  };

  /** `/nep emoji rescan`: clears `emojiUsage` and recounts it from channel history (the backfill
   * with `force`), awaited to the end. Writes under data/, so refused while paused. */
  async function cmdEmojiRescan(_args, context) {
    if (!emojiBackfill) return 'the emoji backfill is not available';
    assertNotPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const result = await emojiBackfill.run(guildId, { force: true });
    if (!result.ok) return EMOJI_RESCAN_SKIPS[result.reason] ?? `not done (${result.reason})`;
    return `Emoji rescan done: ${result.channels} channels, ${result.messages} messages read, ${result.emoji} emoji uses counted.`;
  }

  /** `/nep gifs status`: how many GIFs the library holds, the top 10 (rank order,
   * `gifs.halfLifeDays`) as `g<n> xCOUNT — caption or name`, the history backfill stamp, and
   * how many GIFs the persona posted today (UTC) against `gifs.maxPerDay`. */
  function cmdGifsStatus(_args, context) {
    freshenIfPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const library = store.getGifs(guildId);
    const ranked = rankGifs(library, hot.config?.gifs?.halfLifeDays ?? 30);
    const cache = store.getMediaCache(guildId);
    const captionOf = (entry) => {
      const cached = cache?.[entry.itemId];
      return cached && !cached.miss && typeof cached.text === 'string' ? cached.text.trim() : '';
    };
    const stamp = library.backfill;
    const running = gifBackfill?.isRunning?.() ? ' (running now)' : '';
    const backfill = stamp?.at ? `${stamp.at}, ${stamp.channels} channels, ${stamp.messages} messages` : 'never';
    const data = store.state.data;
    const today = new Date().toISOString().slice(0, 10);
    const postedToday = data.gifDay === today && Number.isFinite(data.gifCount) ? data.gifCount : 0;
    const cap = hot.config?.gifs?.maxPerDay;
    return [
      `library: ${ranked.length} gifs`,
      ranked.length > 0 ? 'top 10:' : 'top 10: (none)',
      ...ranked
        .slice(0, 10)
        .map((entry) => `  ${entry.id} x${entry.count} — ${captionOf(entry) || entry.name || entry.site || entry.url}`),
      `backfill: ${backfill}${running}`,
      `posted today: ${postedToday}/${Number.isFinite(cap) ? cap : 40}`,
    ].join('\n');
  }

  /** Why `/nep gifs rescan` did not run, by src/memory/gif-backfill.js's skip reason. */
  const GIFS_RESCAN_SKIPS = {
    running: 'A GIF backfill is already running.',
    disabled: 'The GIF backfill is off (gifs.backfillMessages is 0).',
    paused: 'paused -- run /nep resume first',
    'no-guild': 'no guild resolved yet',
  };

  /** `/nep gifs rescan`: clears the GIF library and recounts it from channel history, then
   * captions the top ones (the backfill with `force`), awaited to the end. Writes under data/,
   * so refused while paused. */
  async function cmdGifsRescan(_args, context) {
    if (!gifBackfill) return 'the GIF backfill is not available';
    assertNotPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const result = await gifBackfill.run(guildId, { force: true });
    if (!result.ok) return GIFS_RESCAN_SKIPS[result.reason] ?? `not done (${result.reason})`;
    return `GIF rescan done: ${result.channels} channels, ${result.messages} messages read, ${result.gifs} GIF uses counted, ${result.described} described.`;
  }

  /** Wraps a `warmup.*` handler so both report the same thing when the dependency is absent. */
  function withWarmup(fn) {
    return (args, context) => {
      if (!warmup) return 'warmup is not available';
      return fn(args, context);
    };
  }

  /** Wraps a `mentor.*` handler so all of them report the same thing when a dependency is absent. */
  function withMentor(fn) {
    return (args, context) => {
      if (!mentor || !mentorCases) return 'the mentor is not available';
      return fn(args, context);
    };
  }

  const commands = {
    status: () => cmdStatus(),
    ping: (args) => cmdPing(args),
    reload: () => cmdReload(),
    pause: () => cmdPause(),
    resume: () => cmdResume(),
    interject: (args, context) => cmdForce('interject', args, context),
    initiate: (args, context) => cmdForce('initiate', args, context),
    draw: (args, context) => cmdDraw(args, context),
    set: (args) => cmdSet(args),
    unset: (args) => cmdUnset(args),
    'rule.add': (args) => cmdRuleAdd(args),
    'rule.list': () => cmdRuleList(),
    'rule.remove': (args) => cmdRuleRemove(args),
    'memory.show': (args, context) => cmdMemoryShow(args, context),
    'memory.channel': (args, context) => cmdMemoryChannel(args, context),
    'memory.server': (args, context) => cmdMemoryServer(args, context),
    'memory.forget': (args, context) => cmdMemoryForget(args, context),
    'memory.wipe': (args, context) => cmdMemoryWipe(args, context),
    'memory.affinity': (args, context) => cmdMemoryAffinity(args, context),
    'memory.refresh': (args, context) => cmdMemoryRefresh(args, context),
    'private.show': (args, context) => cmdPrivateShow(args, context),
    'private.forget': (args, context) => cmdPrivateForget(args, context),
    'private.purge': (args, context) => cmdPrivatePurge(args, context),
    'alias.add': (args, context) => cmdAliasAdd(args, context),
    'alias.remove': (args, context) => cmdAliasRemove(args, context),
    'lore.add': (args, context) => cmdLoreAdd(args, context),
    'lore.list': (args, context) => cmdLoreList(args, context),
    'lore.show': (args, context) => cmdLoreShow(args, context),
    'lore.remove': (args, context) => cmdLoreRemove(args, context),
    'learned.list': (args, context) => cmdLearnedList(args, context),
    'learned.add': (args, context) => cmdLearnedAdd(args, context),
    'learned.remove': (args, context) => cmdLearnedRemove(args, context),
    'emoji.status': (args, context) => cmdEmojiStatus(args, context),
    'emoji.rescan': (args, context) => cmdEmojiRescan(args, context),
    'gifs.status': (args, context) => cmdGifsStatus(args, context),
    'gifs.rescan': (args, context) => cmdGifsRescan(args, context),
    'model.show': () => cmdModelShow(),
    'model.set': (args) => cmdModelSet(args),
    'route.list': () => cmdRouteList(),
    'route.set': (args) => cmdRouteSet(args),
    'route.remove': (args) => cmdRouteRemove(args),
    'warmup.people': withWarmup((args, context) => cmdWarmupPeople(args, context)),
    'warmup.run': withWarmup((args, context) => cmdWarmupRun(args, context)),
    'warmup.stop': withWarmup(() => cmdWarmupStop()),
    'warmup.users': withWarmup((args, context) => cmdWarmupUsers(args, context)),
    'warmup.channels': withWarmup((args, context) => cmdWarmupChannels(args, context)),
    'warmup.server': withWarmup((args, context) => cmdWarmupServer(args, context)),
    'warmup.status': withWarmup((args, context) => cmdWarmupStatus(args, context)),
    'warmup.reset': withWarmup(() => cmdWarmupReset()),
    'mentor.add': withMentor((args, context) => cmdMentorAdd(args, context)),
    'mentor.anchor': withMentor((args, context) => cmdMentorAnchor(args, context)),
    'mentor.cases': withMentor((args, context) => cmdMentorCases(args, context)),
    'mentor.remove': withMentor((args, context) => cmdMentorRemove(args, context)),
    'mentor.run': withMentor((args) => cmdMentorRun(args)),
    'mentor.check': withMentor(() => cmdMentorCheck()),
    'mentor.stop': withMentor(() => cmdMentorStop()),
    'mentor.show': withMentor((args, context) => cmdMentorShow(args, context)),
    'mentor.wrong': withMentor((args, context) => cmdMentorWrong(args, context)),
    'mentor.status': withMentor((args, context) => cmdMentorStatus(args, context)),
    'access.grant': (args) => cmdAccessGrant(args),
    'access.revoke': (args) => cmdAccessRevoke(args),
    'access.list': () => cmdAccessList(),
  };

  /**
   * Run one command. `commandKey` is `'<name>'` for a top-level command or
   * `'<group>.<name>'` for a grouped one. Throws an operator-facing `Error`
   * on bad input or an unknown key; never touches discord.js.
   */
  async function run(commandKey, args = {}, context = {}) {
    const handler = Object.hasOwn(commands, commandKey) ? commands[commandKey] : null;
    if (!handler) throw new Error(`unknown command: ${commandKey}`);
    return handler(args, context);
  }

  return { isOwner, isAllowed, run };
}
