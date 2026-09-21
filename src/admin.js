// Owner commands, driven by Discord slash commands (src/discord/commands.js)
// so the owner can tune the running bot from Discord without a restart and
// without ever touching data/: live rules (prompts.local/rules.md, seeded
// from prompts/rules.md), config overrides (config.local.json, hot-reloaded),
// status, a manual poke of the spontaneous scheduler, and profile
// inspection/deletion. This is the ONLY place in the project that ever
// deletes stored memory, through the two functions store.js allows for it:
// store.forgetUser (one profile) and store.wipeGuild (a whole guild's memory,
// `/nep memory wipe`, gated by the served guild's exact name and refused
// while a warm-up is running). The tracked prompts/ layer is never written at
// runtime — live corrections always land in the untracked prompts.local/
// layer.
//
// This module knows nothing about discord.js: `createAdmin(deps).run` takes
// a `commandKey` (e.g. `'warmup.channel'`), a plain `args` object and a
// `context` (`{ guildId, channelId, userId }`) and returns the reply text, or
// throws an `Error` with an operator-facing message on bad input. Mapping a
// discord.js interaction's options onto `args` is src/discord/commands.js's
// job. Everything below the pure-function section is thin I/O glued around
// them; the pure functions (listRules, appendRule, removeRule, setPath,
// unsetPath) are unit-tested directly with no filesystem or Discord involved.

import fs from 'node:fs';
import path from 'node:path';
import { emptyAffinity, affinityBand, roundScore } from './memory/affinity.js';
import { topByRank } from './memory/ranking.js';
import { fromTokens } from './memory/mentions.js';
import { sortEpisodesForDisplay } from './memory/episodes.js';
import { log } from './log.js';

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
 * persona actually sees (see .claude/docs/prompt-contract.md, "More is stored
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
// `/nep memory show` — sectioned view (F32)
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

/** Owner-configurable list length for `/nep memory show`'s per-section views (F32). */
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
 * .claude/docs/prompt-contract.md, "More is stored than shown, and rank
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
 * The exact output `/nep memory show` produced before F32 (section `'raw'`):
 * the whole profile as JSON, followed by every stored interest/detail/alias
 * in rank order (divider included) and every episode — `<@id>` tokens are
 * deliberately left unresolved here, unlike every other section.
 */
function legacyMemoryShowView(profile, memoryCfg) {
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

/** `[weight N, last DATE] name`, or just `[weight N] name` — unchanged since before F32, used by
 * both the `raw` view (via `legacyMemoryShowView`) and the `aliases` section, and by `/nep memory
 * alias add`/`remove`'s "resulting alias list" reply. */
function aliasLine(alias) {
  return `[weight ${alias.weight}${lastDateSuffix(alias.lastSeen)}] ${alias.name}`;
}

/** The member's stored aliases, rank-ordered, one per line — the reply `/nep memory alias
 * add`/`remove` gives after writing (see the module header's DO §2). */
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

/**
 * A token amount: a plain integer, or an integer followed by `k` (x1,000) or
 * `m` (x1,000,000) — e.g. `500k`, `10m`. Returns null for anything else.
 */
function parseTokenAmount(raw) {
  const trimmed = String(raw ?? '').trim().toLowerCase();
  const match = /^(\d+)([km]?)$/.exec(trimmed);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n)) return null;
  if (match[2] === 'k') return n * 1_000;
  if (match[2] === 'm') return n * 1_000_000;
  return n;
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * `hot`, `store` — see src/hot.js, src/memory/store.js.
 * `client` — a discord.js Client (used for channels.fetch and guilds.cache).
 * `spontaneous` — the spontaneous scheduler: `poke(channel, mode)` and `status()`.
 * `calibrator` — token calibrator (src/llm/tokens.js), read for `.ratio`.
 * `getGuildId` — the single guild this instance serves, or null before it resolves.
 * `warmup` — from createWarmup() (src/memory/warmup.js), optional: `run()`, `stop()`, `status()`, `plan()`,
 *   `reset()`. When absent, every `warmup.*` command reports it is not available.
 * `turns` — from createTurnRunner() (src/behavior/turn.js), optional: `waitIdle()`, used by
 *   `/nep pause` (F30) to wait out a turn already in flight. Absent -> the wait is simply skipped.
 * `memory` — from createMemoryUpdater() (src/memory/update.js), optional: `waitIdle()`, used by
 *   `/nep pause` (F30) to wait out a live-analyzer `run()` already in flight (an LLM call can take
 *   30-90s) before the pause flushes and drops the store's caches. Absent -> the wait is skipped.
 * `pending` — `{ clear() }`, optional: clears src/discord/events.js's pending-ping queue on pause
 *   (F30). Absent -> nothing to clear.
 * `llm` — from createLlm() (src/llm/openrouter.js), optional: `complete()`, used by `/nep ping`
 *   (F35) to reach each role's model directly. Absent -> `/nep ping` reports it is not available.
 * `bootstrap` — from createBootstrap() (src/memory/bootstrap.js), optional: `peopleReport(guildId)`,
 *   `previewUser(guildId, userId)`, `previewChannel(guildId, channelId)` — the sample-based
 *   bootstrap PREVIEW (F36 phase A), writes nothing under data/. Absent -> every `bootstrap.*`
 *   command reports it is not available.
 *
 * `run(commandKey, args, context)` throws a plain `Error` (operator-facing
 * message) on bad input; it never touches discord.js.
 */
export function createAdmin({ hot, store, client, spontaneous, calibrator, getGuildId, warmup, turns, memory, pending, llm, bootstrap }) {
  function isOwner(userId) {
    const owners = hot.config?.bot?.owners ?? [];
    return owners.map(String).includes(String(userId));
  }

  /**
   * F30 (`/nep pause`): refuse a command that would write under `data/` while
   * paused, with a hint to resume first -- see the module header comment's
   * "MUST NOT touch" list in the task and the DESIGN section 3 list of
   * refused commands (memory.forget, memory.affinity with a score,
   * memory.wipe, lore.add, lore.remove, warmup.run, warmup.reset, poke).
   */
  function assertNotPaused() {
    if (store.state.data.paused) {
      throw new Error('paused -- run /nep resume first');
    }
  }

  /**
   * F30: a read-only command must see a hand-edit made while paused, even a
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
  // pause / resume — F30: a maintenance mode so the owner can edit files
  // under data/ by hand while the process stays up. See src/memory/store.js
  // (dropCaches/reloadState/validate) and the module header comments of
  // src/behavior/turn.js (waitIdle), src/behavior/spontaneous.js and
  // src/memory/update.js (both no-op while paused).
  // ---------------------------------------------------------------------

  /**
   * Sets `paused`/`pausedAt` in state.json FIRST (so a crash or restart
   * mid-pause comes back paused), then waits out a warm-up in flight (via
   * its own `stop()`, remembering `resumeWarmup` for `/nep resume`), a turn
   * already running, AND a live-analyzer `run()` already in flight (its LLM
   * call can take 30-90s; `tick()`/`observe()` are already no-ops from the
   * moment `paused` is set, so no NEW run can start -- this only waits out
   * one that started before the pause). Only once all three are idle does it
   * clear the pending-ping queue, flush everything and drop every cache
   * except state.json itself, so nothing stale (or a late in-flight write)
   * can land in data/ after the owner starts editing it. Idempotent: a
   * second call just reports the state.
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

    let warmupInterrupted = false;
    if (warmup && typeof warmup.status === 'function' && typeof warmup.stop === 'function' && typeof warmup.run === 'function') {
      let running = false;
      try {
        running = Boolean(warmup.status()?.running);
      } catch {
        running = false;
      }
      if (running) {
        warmupInterrupted = true;
        warmup.stop();
        try {
          await warmup.run(); // the SAME in-flight run (warmup.run() is idempotent while running) -- resolves once it pauses
        } catch (err) {
          log.warn('admin: the interrupted warm-up run rejected while pausing', { error: err });
        }
      }
    }

    if (warmupInterrupted) {
      store.state.data.resumeWarmup = true;
      store.state.markDirty();
    }

    if (turns && typeof turns.waitIdle === 'function') {
      await turns.waitIdle();
    }

    // The live analyzer's own in-flight run (if any) must land on disk
    // BEFORE the flush + dropCaches below -- see the header comment above.
    if (memory && typeof memory.waitIdle === 'function') {
      await memory.waitIdle();
    }

    if (pending && typeof pending.clear === 'function') {
      pending.clear();
    }

    store.flush();
    const dropped = typeof store.dropCaches === 'function' ? store.dropCaches() : 0;

    log.info('admin: paused', { warmupInterrupted, dropped });

    return [
      'Paused. Memory is flushed to disk -- files under data/ can be edited safely now.',
      'Run /nep resume when done.',
    ].join('\n');
  }

  /**
   * Refuses (staying paused) if any `*.json` under data/ fails to parse,
   * naming the offending paths. Otherwise re-reads state.json (the owner may
   * have hand-edited warm-up progress while paused), clears the pause flags
   * and lets every other cache lazily re-populate from disk. Restarts the
   * warm-up (not awaited) if it was the one interrupted by this pause.
   * Idempotent: reports "not paused" when called while not paused.
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

    const resumeWarmup = Boolean(state.resumeWarmup);
    delete state.paused;
    delete state.pausedAt;
    delete state.resumeWarmup;
    store.state.markDirty();
    store.flush();

    if (resumeWarmup && warmup && typeof warmup.run === 'function') {
      warmup.run().catch((err) => log.error('admin: resumed warm-up run failed', { error: err }));
    }

    log.info('admin: resumed', { resumeWarmup });

    return resumeWarmup ? 'Resumed. The warm-up will continue where it left off.' : 'Resumed.';
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
    freshenIfPaused(); // F30: read the freshest data/ even mid-pause
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
    ];

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

  async function cmdPoke(args, context) {
    assertNotPaused();
    const mode = args?.mode === 'initiate' ? 'initiate' : 'interject';
    const channelId = args?.channelId || context?.channelId;
    if (!channelId) throw new Error('a channel is required');

    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`channel not found: ${channelId}`);

    const result = await spontaneous.poke(channel, mode);
    return `poke ${mode} on ${channel.id}: ${JSON.stringify(result) ?? 'ok'}`;
  }

  function resolvedGuildId(context) {
    return context?.guildId ?? getGuildId?.() ?? null;
  }

  /**
   * F32: sectioned, human-readable view of one member's profile — see the
   * module-level `MEMORY_SHOW_SECTIONS` for the choices and the header
   * comments of `buildProfileSummary`/`orderedSectionLines`/
   * `legacyMemoryShowView` for what each section does. `section` defaults to
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

    if (section === 'raw') return legacyMemoryShowView(profile, memoryCfg);

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
        formatLine: (it) => {
          const note = resolve(it.note);
          const suffix = `[seen ${it.weight}${lastDateSuffix(it.lastSeen)}]`;
          return note ? `${it.topic} — ${note} ${suffix}` : `${it.topic} ${suffix}`;
        },
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
        formatLine: (d) => `#${d.id} ${resolve(d.text)} [seen ${d.weight}${lastDateSuffix(d.lastSeen)}]`,
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
        .map((ep) => {
          const quote = ep.quote ? ` "${ep.quote}"` : '';
          return `${ep.date} [weight ${ep.weight}] ${resolve(ep.what)}${quote}`;
        })
        .join('\n');
    }

    return buildProfileSummary(profile, memoryCfg, nameOf);
  }

  /**
   * F32 (`/nep memory alias add`): confirms the alias at once instead of
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
  function cmdMemoryAliasAdd(args, context) {
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

  /** F32 (`/nep memory alias remove`): removes by name, case-insensitively (store.applyProfileOps
   * matches an alias's identity the same way, see src/memory/interests.js#normalizeTopic). */
  function cmdMemoryAliasRemove(args, context) {
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

    store.forgetUser(guildId, userId);
    return `Forgot ${userId}.`;
  }

  /**
   * A deliberate, owner-only clean start: wipes this guild's whole stored
   * memory (store.wipeGuild) and resets warm-up progress with it, so a
   * re-run never double-counts against old data. Runs only when `confirm`
   * matches the served guild's name exactly (trimmed, case-sensitive) —
   * otherwise nothing changes and the reply says what to type. Refused
   * outright while a warm-up is running.
   */
  function cmdMemoryWipe(args, context) {
    assertNotPaused();
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    if (warmup && typeof warmup.status === 'function') {
      let running = false;
      try {
        running = Boolean(warmup.status()?.running);
      } catch {
        running = false;
      }
      if (running) throw new Error('a warm-up is running — run /nep warmup stop first');
    }

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
      'Warm-up progress was cleared. Next step: /nep warmup run.',
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

  const MODEL_ID_RE = /^[\w.:/-]{3,100}$/;
const MODEL_ROLE_PATHS = { talk: 'llm.model', analyzer: 'memory.model', media: 'media.model' };

function cmdModelShow() {
  const cfg = hot.config;
  const lines = [
    `talk: ${cfg?.llm?.model ?? '-'}`,
    `analyzer: ${cfg?.memory?.model ?? cfg?.llm?.model ?? '-'}`,
    `media: ${cfg?.media?.model ?? '-'}`,
    `mediaDescriptions: ${cfg?.features?.mediaDescriptions === true ? 'on' : 'off'}`,
  ];
  return lines.join('\n');
}

function cmdModelSet(args) {
  const role = String(args?.role ?? '');
  const dottedPath = MODEL_ROLE_PATHS[role];
  if (!dottedPath) throw new Error(`unknown role: ${role} (talk, analyzer, media)`);

  const id = String(args?.id ?? '').trim();
  if (!MODEL_ID_RE.test(id)) throw new Error('id must look like a model id, e.g. anthropic/claude-haiku-4.5 (3-100 chars)');

  const localPath = path.join(hot.rootDir, 'config.local.json');
  const next = setPath(readLocalConfig(localPath), dottedPath, id);
  writeLocalConfig(localPath, next);
  const ok = hot.reloadConfig();
  return `Set ${role} model to ${id} (reload ${ok ? 'ok' : 'FAILED'})`;
}

// ---------------------------------------------------------------------
// ping (F35): one minimal chat completion per role's model, in parallel,
// to tell the owner in seconds whether each one is actually reachable --
// see the module header's DO list. Never touches the daily request cap or
// token calibration (src/llm/openrouter.js#complete's `countAgainstDailyCap`
// / `skipCalibration` options), never writes under data/.
// ---------------------------------------------------------------------

const PING_ROLES = ['talk', 'analyzer', 'media'];

/** The model id one role resolves to right now — mirrors cmdModelShow/MODEL_ROLE_PATHS. */
function pingModelFor(role, cfg) {
  if (role === 'talk') return cfg?.llm?.model || undefined;
  if (role === 'analyzer') return cfg?.memory?.model || cfg?.llm?.model || undefined;
  if (role === 'media') return cfg?.media?.model || undefined;
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
 * that actually tells "wrong provider keys" apart from a genuine outage (see the module header's
 * WHY). A real captured 404 body carries it at `error.metadata.routing_funnel` (checked first); a
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

async function cmdPing(args) {
  if (!llm) throw new Error('ping is not available (no llm client configured)');

  const requested = PING_ROLES.includes(args?.role) ? [args.role] : PING_ROLES;
  const cfg = hot.config;
  const roleModel = new Map(requested.map((role) => [role, pingModelFor(role, cfg)]));

  const promptText = hot.prompts?.labels?.ping?.prompt;
  if (!promptText) {
    return requested.map((role) => `${role}: ${roleModel.get(role) ?? '(no model configured)'} — skipped: label missing`).join('\n');
  }

  const uniqueModels = [...new Set([...roleModel.values()].filter(Boolean))];
  const results = new Map();

  await Promise.all(
    uniqueModels.map(async (model) => {
      const start = Date.now();
      try {
        const result = await llm.complete([{ role: 'user', content: promptText }], {
          model,
          maxOutputTokens: 16,
          countAgainstDailyCap: false,
          skipCalibration: true,
          timeoutMs: cfg?.llm?.pingTimeoutMs ?? 30000,
        });
        results.set(model, { ok: true, ms: Date.now() - start, result });
      } catch (err) {
        results.set(model, { ok: false, ms: Date.now() - start, err });
      }
    }),
  );

  return requested
    .map((role) => {
      const model = roleModel.get(role);
      if (!model) return `${role}: (no model configured)`;
      const outcome = results.get(model);
      return outcome.ok
        ? formatPingSuccess(role, model, outcome.result, outcome.ms)
        : formatPingFailure(role, model, outcome.err, outcome.ms);
    })
    .join('\n');
}

function warmupLocalConfigPath() {
    return path.join(hot.rootDir, 'config.local.json');
  }

  /** Read-modify-write one key of config.local.json, the same path `set` uses. */
  function writeWarmupConfig(dottedPath, value) {
    const localPath = warmupLocalConfigPath();
    const next = setPath(readLocalConfig(localPath), dottedPath, value);
    writeLocalConfig(localPath, next);
    return hot.reloadConfig();
  }

  function unsetWarmupConfig(dottedPath) {
    const localPath = warmupLocalConfigPath();
    const next = unsetPath(readLocalConfig(localPath), dottedPath);
    writeLocalConfig(localPath, next);
    return hot.reloadConfig();
  }

  /** `N s ago` / `N min ago`, or `never` when `lastActivityAt` is unknown (F35 addendum). */
  function humanizeAgo(lastActivityAt) {
    if (!Number.isFinite(lastActivityAt)) return 'never';
    const deltaMs = Math.max(0, Date.now() - lastActivityAt);
    const seconds = Math.round(deltaMs / 1000);
    if (seconds < 60) return `${seconds} s ago`;
    return `${Math.round(seconds / 60)} min ago`;
  }

  /** One terse `phase: …` line from a warm-up's in-memory `activity` snapshot (F35 addendum, see
   * src/memory/warmup.js's `touchActivity`) — never throws on a missing/partial snapshot. */
  function formatWarmupPhase(activity) {
    const a = activity ?? {};
    const phase = a.phase ?? 'idle';
    if (phase === 'fetching') {
      return `phase: fetching history, ${a.channelsFetched ?? 0}/${a.channelsTotal ?? 0} channels`;
    }
    if (phase === 'analysing' || phase === 'describing') {
      const verb = phase === 'describing' ? 'describing media' : 'analysing';
      return `phase: ${verb}, batch ${a.windowBatch ?? 0} of ${a.windowBatches ?? 0} in the window (${a.messages ?? 0} messages)`;
    }
    if (phase === 'waiting-rate-limit') {
      const until = Number.isFinite(a.until) ? `${new Date(a.until).toISOString().slice(11, 16)} UTC` : '?';
      return `phase: waiting for the provider rate limit until ${until} (wait ${a.waits ?? 1})`;
    }
    if (phase === 'paused') return 'phase: paused';
    if (phase === 'aborted') {
      const reason = a.reason ?? 'unknown';
      const detail = a.detail ? `: ${String(a.detail).slice(0, 160)}` : '';
      return `phase: aborted (${reason}${detail})`;
    }
    if (phase === 'done') return 'phase: done';
    return 'phase: idle';
  }

  function cmdWarmupStatus() {
    const s = warmup.status();
    const reached = s.reachedTs ? new Date(s.reachedTs).toISOString() : '(not started)';
    const analyzerModel = hot.config?.memory?.model ?? hot.config?.llm?.model ?? '-';
    const lines = [
      formatWarmupPhase(s.activity),
      `last activity: ${humanizeAgo(s.activity?.lastActivityAt)}`,
      `analyzer model: ${analyzerModel}`,
      `enabled: ${s.enabled}`,
      `done: ${s.done}`,
      `paused: ${s.paused}`,
      `aborted: ${s.aborted}`,
      `running: ${s.running}`,
      `tokens: ${s.tokensUsed} / ${s.maxTokens}`,
      `requests: ${s.requests}`,
      `analysed ${s.messagesAnalyzed} of ${s.messagesTotal} messages`,
      `timeline reached: ${reached}`,
      `skipped messages: ${s.skippedMessages}`,
      `only listed channels: ${s.onlyListed}`,
    ];
    for (const row of s.channels ?? []) {
      const label = row.name ? `#${row.name} (${row.id})` : row.id;
      lines.push(`  ${label}: ${row.messages}/${row.limit ?? '?'} msgs`);
    }
    return lines.join('\n');
  }

  async function cmdWarmupPlan() {
    const p = await warmup.plan();
    const lines = p.plan.map((c, i) => `${i + 1}. #${c.name ?? c.id} (${c.id}) — ${c.depth}, ${c.role}`);
    if (lines.length === 0) lines.push('(no readable channels)');
    if (p.missing.length > 0) lines.push(`missing: ${p.missing.join(', ')}`);
    lines.push(`budget: ${p.maxTokens} tokens, output limit: ${p.outputTokens}, batch size: ${p.batchMessages}`);
    return lines.join('\n');
  }

  function cmdWarmupChannel(args) {
    const channelId = args?.channelId;
    const depth = args?.depth;
    if (!channelId) throw new Error('a channel is required');
    if (!Number.isInteger(depth) || depth < 0 || depth > 1_000_000) {
      throw new Error('depth must be an integer between 0 and 1000000');
    }
    const ok = writeWarmupConfig(`warmup.channelDepths.${channelId}`, depth);
    return `Channel ${channelId}: depth set to ${depth}${depth === 0 ? ' (will be skipped)' : ''} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  function cmdWarmupChannelDefault(args) {
    const channelId = args?.channelId;
    if (!channelId) throw new Error('a channel is required');
    const ok = unsetWarmupConfig(`warmup.channelDepths.${channelId}`);
    return `Channel ${channelId}: depth reset to the default (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  function cmdWarmupOnly(args) {
    const enabled = Boolean(args?.enabled);
    const ok = writeWarmupConfig('warmup.onlyListed', enabled);
    return `Only listed channels: ${enabled} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  function cmdWarmupDepth(args) {
    const n = args?.messages;
    if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
      throw new Error('messages must be an integer between 1 and 1000000');
    }
    const ok = writeWarmupConfig('warmup.messagesPerChannel', n);
    return `Default read depth set to ${n} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  function cmdWarmupBudget(args) {
    const tokens = parseTokenAmount(args?.tokens);
    if (tokens == null || tokens < 1) throw new Error('tokens must be an amount like 500k or 10m');
    const ok = writeWarmupConfig('warmup.maxTokens', tokens);
    return `Warm-up token budget set to ${tokens} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  function cmdWarmupOutput(args) {
    const n = args?.tokens;
    if (!Number.isInteger(n) || n < 256 || n > 32000) {
      throw new Error('tokens must be an integer between 256 and 32000');
    }
    const ok = writeWarmupConfig('memory.maxOutputTokens', n);
    return `Analyzer output limit set to ${n} (reload ${ok ? 'ok' : 'FAILED'})`;
  }

  function cmdWarmupRun() {
    assertNotPaused();
    const s = warmup.status();
    if (s.running) return 'warm-up is already running.';
    if (s.done) return 'warm-up has already finished.';
    warmup.run().catch((err) => log.error('warmup: run failed', { error: err }));
    return 'Warm-up started.';
  }

  function cmdWarmupStop() {
    const s = warmup.status();
    if (!s.running) return 'warm-up is not running.';
    warmup.stop();
    return 'Stop requested: warm-up will pause after the batch in flight.';
  }

  function cmdWarmupReset() {
    assertNotPaused();
    warmup.reset();
    return 'Warm-up progress reset.';
  }

  /** Wraps a `warmup.*` handler so every one of them reports the same thing when the dependency is absent. */
  function withWarmup(fn) {
    return (args, context) => {
      if (!warmup) return 'warm-up is not available';
      return fn(args, context);
    };
  }

  // ---------------------------------------------------------------------
  // bootstrap (F36 phase A): a read-only sample-based preview -- see the
  // module header of src/memory/bootstrap.js. Never writes under data/, so
  // unlike most commands here it is never guarded by assertNotPaused().
  // ---------------------------------------------------------------------

  /** `YYYY-MM-DD`, or `-` when `ts` is not a finite timestamp. */
  function bootstrapDate(ts) {
    return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '-';
  }

  function formatBootstrapPeople(report) {
    if (!report.ok) return report.message;
    const lines = report.people.map((p, i) => {
      const topChannels = Object.entries(p.byChannel)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cid, count]) => `${cid}:${count}`)
        .join(', ');
      return `${i + 1}. ${p.name} (id:${p.id}) — ${p.messages} messages, ${bootstrapDate(p.firstTs)}..${bootstrapDate(p.lastTs)}, top channels: ${topChannels || '-'}`;
    });
    if (lines.length === 0) lines.push('(nobody currently qualifies)');
    lines.push('');
    lines.push(`channels read: ${report.totals.channelsRead}`);
    lines.push(`messages read: ${report.totals.messagesRead}`);
    lines.push(`people below the threshold: ${report.totals.belowThreshold}`);
    return lines.join('\n');
  }

  function formatBootstrapProfilePreview(preview) {
    if (!preview.ok) return preview.message;
    const { member, sample, estimatedTokens, usage, result } = preview;
    const usageLine = usage ? `${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}` : '-';
    return [
      `member: ${member.name} (id:${member.id})`,
      `messages in window: ${member.messages}, ${bootstrapDate(member.firstTs)}..${bootstrapDate(member.lastTs)}`,
      `sample: ${sample.ownCount} own / ${sample.contextCount} context lines, channels: ${sample.channels.join(', ') || '-'}`,
      `estimated input tokens: ${estimatedTokens}, real usage: ${usageLine}`,
      '',
      `character: ${result?.character || '(empty)'}`,
      `style: ${result?.style || '(empty)'}`,
      'interests:',
      ...(result?.interests?.length
        ? result.interests.map((it) => `  ${it.topic}${it.note ? ` — ${it.note}` : ''} (times: ${it.times})`)
        : ['  (none)']),
      'details:',
      ...(result?.details?.length ? result.details.map((d) => `  ${d.text} (times: ${d.times})`) : ['  (none)']),
      'episodes:',
      ...(result?.episodes?.length
        ? result.episodes.map((ep) => `  ${ep.date} [weight ${ep.weight}] ${ep.what}${ep.quote ? ` "${ep.quote}"` : ''} (${ep.feeling})`)
        : ['  (none)']),
      `aliases: ${result?.aliases?.join(', ') || '(none)'}`,
    ].join('\n');
  }

  function formatBootstrapChannelPreview(preview) {
    if (!preview.ok) return preview.message;
    const { channel, sample, estimatedTokens, usage, result } = preview;
    const usageLine = usage ? `${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}` : '-';
    return [
      `channel: #${channel.name} (id:${channel.id})${channel.isMain ? ' [main]' : ''}`,
      channel.category ? `category: ${channel.category}` : null,
      channel.topic ? `topic: ${channel.topic}` : null,
      `sample: ${sample.kept} of ${sample.total} messages kept (${sample.dropped} dropped to fit)`,
      `estimated input tokens: ${estimatedTokens}, real usage: ${usageLine}`,
      '',
      `purpose: ${result?.purpose || '(empty)'}`,
      `topics: ${result?.topics || '(empty)'}`,
      `tone: ${result?.tone || '(empty)'}`,
    ]
      .filter((line) => line !== null)
      .join('\n');
  }

  async function cmdBootstrapPeople(_args, context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    return formatBootstrapPeople(await bootstrap.peopleReport(guildId));
  }

  async function cmdBootstrapPreview(args, context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');
    const hasUser = Boolean(args?.userId);
    const hasChannel = Boolean(args?.channelId);
    if (hasUser === hasChannel) throw new Error('give exactly one of user or channel');
    if (hasUser) return formatBootstrapProfilePreview(await bootstrap.previewUser(guildId, args.userId));
    return formatBootstrapChannelPreview(await bootstrap.previewChannel(guildId, args.channelId));
  }

  /** Wraps a `bootstrap.*` handler so both report the same thing when the dependency is absent. */
  function withBootstrap(fn) {
    return (args, context) => {
      if (!bootstrap) return 'bootstrap is not available';
      return fn(args, context);
    };
  }

  const commands = {
    status: () => cmdStatus(),
    ping: (args) => cmdPing(args),
    reload: () => cmdReload(),
    pause: () => cmdPause(),
    resume: () => cmdResume(),
    poke: (args, context) => cmdPoke(args, context),
    set: (args) => cmdSet(args),
    unset: (args) => cmdUnset(args),
    'rule.add': (args) => cmdRuleAdd(args),
    'rule.list': () => cmdRuleList(),
    'rule.remove': (args) => cmdRuleRemove(args),
    'memory.show': (args, context) => cmdMemoryShow(args, context),
    'memory.forget': (args, context) => cmdMemoryForget(args, context),
    'memory.alias-add': (args, context) => cmdMemoryAliasAdd(args, context),
    'memory.alias-remove': (args, context) => cmdMemoryAliasRemove(args, context),
    'memory.wipe': (args, context) => cmdMemoryWipe(args, context),
    'memory.affinity': (args, context) => cmdMemoryAffinity(args, context),
    'lore.add': (args, context) => cmdLoreAdd(args, context),
    'lore.list': (args, context) => cmdLoreList(args, context),
    'lore.show': (args, context) => cmdLoreShow(args, context),
    'lore.remove': (args, context) => cmdLoreRemove(args, context),
    'model.show': () => cmdModelShow(),
    'model.set': (args) => cmdModelSet(args),
    'warmup.status': withWarmup(() => cmdWarmupStatus()),
    'warmup.plan': withWarmup(() => cmdWarmupPlan()),
    'warmup.run': withWarmup(() => cmdWarmupRun()),
    'warmup.stop': withWarmup(() => cmdWarmupStop()),
    'warmup.reset': withWarmup(() => cmdWarmupReset()),
    'warmup.channel': withWarmup((args) => cmdWarmupChannel(args)),
    'warmup.channel-default': withWarmup((args) => cmdWarmupChannelDefault(args)),
    'warmup.only': withWarmup((args) => cmdWarmupOnly(args)),
    'warmup.depth': withWarmup((args) => cmdWarmupDepth(args)),
    'warmup.budget': withWarmup((args) => cmdWarmupBudget(args)),
    'warmup.output': withWarmup((args) => cmdWarmupOutput(args)),
    'bootstrap.people': withBootstrap((args, context) => cmdBootstrapPeople(args, context)),
    'bootstrap.preview': withBootstrap((args, context) => cmdBootstrapPreview(args, context)),
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

  return { isOwner, run };
}
