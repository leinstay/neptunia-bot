// Owner commands, driven by Discord slash commands (src/discord/commands.js)
// so the owner can tune the running bot from Discord without a restart and
// without ever touching data/: live rules (prompts.local/rules.md, seeded
// from prompts/rules.md), config overrides (config.local.json, hot-reloaded),
// status, a manual poke of the spontaneous scheduler, and profile
// inspection/deletion. This is the ONLY place in the project allowed to
// delete a stored profile (via store.forgetUser). The tracked prompts/ layer
// is never written at runtime — live corrections always land in the
// untracked prompts.local/ layer.
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
import { emptyAffinity, affinityBand } from './memory/affinity.js';
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
 *
 * `run(commandKey, args, context)` throws a plain `Error` (operator-facing
 * message) on bad input; it never touches discord.js.
 */
export function createAdmin({ hot, store, client, spontaneous, calibrator, getGuildId, warmup }) {
  function isOwner(userId) {
    const owners = hot.config?.bot?.owners ?? [];
    return owners.map(String).includes(String(userId));
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

  function cmdMemoryShow(args, context) {
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const profile = store.getUser(guildId, userId);
    if (!profile) throw new Error(`no profile for ${userId}`);
    return JSON.stringify(profile, null, 2);
  }

  function cmdMemoryForget(args, context) {
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    store.forgetUser(guildId, userId);
    return `Forgot ${userId}.`;
  }

  function cmdMemoryAffinity(args, context) {
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error('no guild resolved yet');

    const score = args?.score;
    if (score === undefined || score === null) {
      const profile = store.getUser(guildId, userId);
      if (!profile) throw new Error(`no profile for ${userId}`);
      const affinity = profile.affinity ?? emptyAffinity();
      const history = (affinity.history ?? [])
        .slice(-5)
        .map((h) => `${h.ts} ${h.delta >= 0 ? '+' : ''}${h.delta} -> ${h.score}${h.reason ? `: ${h.reason}` : ''}`)
        .join('\n');
      return [
        `score: ${affinity.score}`,
        `band: ${affinityBand(affinity.score)}`,
        `reason: ${affinity.reason || '-'}`,
        history ? `history:\n${history}` : 'history: (empty)',
      ].join('\n');
    }

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
    });
    return `Set affinity for ${userId} to ${affinity.score} (${affinityBand(affinity.score)}).`;
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

  function cmdWarmupStatus() {
    const s = warmup.status();
    const lines = [
      `enabled: ${s.enabled}`,
      `done: ${s.done}`,
      `paused: ${s.paused}`,
      `aborted: ${s.aborted}`,
      `running: ${s.running}`,
      `tokens: ${s.tokensUsed} / ${s.maxTokens}`,
      `requests: ${s.requests}`,
      `channels: ${s.channelsDone} / ${s.channelsTotal}`,
      `messages analyzed: ${s.messagesAnalyzed}`,
      `skipped messages: ${s.skippedMessages}`,
      `primary channel: ${s.primaryChannelId || '(none)'}`,
      `only listed channels: ${s.onlyListed}`,
    ];
    for (const row of s.channels ?? []) {
      const label = row.name ? `#${row.name} (${row.id})` : row.id;
      lines.push(`  ${label}: ${row.messages}/${row.limit ?? '?'} msgs, ${row.batchesDone} batches, ${row.done ? 'done' : 'in progress'}`);
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

  function cmdWarmupPrimary(args) {
    const channelId = args?.channelId;
    if (!channelId) {
      const ok = writeWarmupConfig('warmup.primaryChannelId', '');
      return `Primary channel cleared (reload ${ok ? 'ok' : 'FAILED'})`;
    }
    const ok = writeWarmupConfig('warmup.primaryChannelId', channelId);
    return `Primary channel set to ${channelId} (reload ${ok ? 'ok' : 'FAILED'})`;
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

  const commands = {
    status: () => cmdStatus(),
    reload: () => cmdReload(),
    poke: (args, context) => cmdPoke(args, context),
    set: (args) => cmdSet(args),
    unset: (args) => cmdUnset(args),
    'rule.add': (args) => cmdRuleAdd(args),
    'rule.list': () => cmdRuleList(),
    'rule.remove': (args) => cmdRuleRemove(args),
    'memory.show': (args, context) => cmdMemoryShow(args, context),
    'memory.forget': (args, context) => cmdMemoryForget(args, context),
    'memory.affinity': (args, context) => cmdMemoryAffinity(args, context),
    'warmup.status': withWarmup(() => cmdWarmupStatus()),
    'warmup.plan': withWarmup(() => cmdWarmupPlan()),
    'warmup.run': withWarmup(() => cmdWarmupRun()),
    'warmup.stop': withWarmup(() => cmdWarmupStop()),
    'warmup.reset': withWarmup(() => cmdWarmupReset()),
    'warmup.primary': withWarmup((args) => cmdWarmupPrimary(args)),
    'warmup.channel': withWarmup((args) => cmdWarmupChannel(args)),
    'warmup.channel-default': withWarmup((args) => cmdWarmupChannelDefault(args)),
    'warmup.only': withWarmup((args) => cmdWarmupOnly(args)),
    'warmup.depth': withWarmup((args) => cmdWarmupDepth(args)),
    'warmup.budget': withWarmup((args) => cmdWarmupBudget(args)),
    'warmup.output': withWarmup((args) => cmdWarmupOutput(args)),
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
