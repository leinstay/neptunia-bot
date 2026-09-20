// Owner commands (`!nep …`) so the owner can tune the running bot from
// Discord without a restart and without ever touching data/: live rules
// (prompts/rules.md), config overrides (config.local.json, hot-reloaded),
// status, a manual poke of the spontaneous scheduler, and profile
// inspection/deletion. This is the ONLY place in the project allowed to
// delete a stored profile (via store.forgetUser).
//
// Everything below the pure-function section is thin I/O glued around them;
// the pure functions (parseCommand, listRules, appendRule, removeRule,
// setPath, unsetPath) are unit-tested directly with no filesystem or Discord
// involved.

import fs from 'node:fs';
import path from 'node:path';

const RULES_HEADING = '## Правила';
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const REPLY_CHUNK_CHARS = 1900;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Parse `content` as an owner command. Returns `{ name, args }` (`name`
 * lowercased, `args` the rest trimmed in its original case) or null when
 * `content` does not start with `prefix` followed by whitespace or end of
 * string. A bare prefix parses as the `help` command.
 */
export function parseCommand(content, prefix) {
  if (typeof content !== 'string' || typeof prefix !== 'string' || !prefix) return null;
  if (!content.startsWith(prefix)) return null;

  const after = content.slice(prefix.length);
  if (after.length > 0 && !/^\s/.test(after)) return null;

  const rest = after.trim();
  if (!rest) return { name: 'help', args: '' };

  const spaceIdx = rest.search(/\s/);
  if (spaceIdx === -1) return { name: rest.toLowerCase(), args: '' };
  return { name: rest.slice(0, spaceIdx).toLowerCase(), args: rest.slice(spaceIdx + 1).trim() };
}

/** Locate the bullet lines (`- …`) that belong to the rules list. */
function locateBullets(text) {
  const lines = text.split('\n');
  const headingIdx = text.indexOf(RULES_HEADING);
  let start = 0;
  let end = lines.length;

  if (headingIdx !== -1) {
    start = text.slice(0, headingIdx).split('\n').length; // first line after the heading
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
 * Bullet texts (lines starting with `- `) under the `## Правила` heading, in
 * order. When the heading is missing, every top-level `- ` bullet in the
 * file is returned instead.
 */
export function listRules(rulesText) {
  const { lines, indices } = locateBullets(String(rulesText ?? ''));
  return indices.map((i) => lines[i].slice(2).trimEnd());
}

/**
 * Append `- <rule>` as the last line of `rulesText`. Newlines inside `rule`
 * collapse to single spaces (the file's rule list stays one bullet per
 * line). The `## Правила` heading is created first when missing. Trailing
 * whitespace of the result is normalized to exactly one final `\n`.
 */
export function appendRule(rulesText, rule) {
  let text = String(rulesText ?? '');
  const singleLine = String(rule)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  if (!text.includes(RULES_HEADING)) {
    text = `${text.replace(/\s*$/, '')}\n\n${RULES_HEADING}\n\n`;
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

function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function extractUserId(arg) {
  const trimmed = String(arg ?? '').trim();
  const mention = /^<@!?(\d+)>$/.exec(trimmed);
  if (mention) return mention[1];
  if (/^\d+$/.test(trimmed)) return trimmed;
  return null;
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

const HELP_TEXT = [
  'Owner commands:',
  '  help                                 this list',
  '  rule <text>                          append a bullet to prompts/rules.md',
  '  rules                                list the rules, numbered',
  '  unrule <n>                           remove rule #n',
  '  set <dotted.path> <json>             override a config.json value (config.local.json)',
  '  unset <dotted.path>                  remove a config override',
  '  reload                               reload config and prompts now',
  '  status                               model, calibration, quotas, per-guild memory',
  '  poke [interject|initiate] [channel]  force a spontaneous action',
  '  memory <@mention|userId>             show a stored profile',
  '  forget <@mention|userId>             delete a stored profile',
].join('\n');

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * `hot`, `store` — see src/hot.js, src/memory/store.js.
 * `client` — a discord.js Client (used for channels.fetch and guilds.cache).
 * `spontaneous` — the spontaneous scheduler: `poke(channel, mode)` and `status()`.
 * `calibrator` — token calibrator (src/llm/tokens.js), read for `.ratio`.
 */
export function createAdmin({ hot, store, client, spontaneous, calibrator }) {
  function isOwner(userId) {
    const owners = hot.config?.bot?.owners ?? [];
    return owners.map(String).includes(String(userId));
  }

  function rulesFile() {
    return path.join(hot.promptsDir, 'rules.md');
  }

  function readRules() {
    const file = rulesFile();
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }

  function cmdRule(args) {
    const rule = args.trim();
    if (!rule) throw new Error('usage: rule <text>');
    const next = appendRule(readRules(), rule);
    fs.writeFileSync(rulesFile(), next);
    hot.reloadPrompts();
    return `Rule added: ${rule}`;
  }

  function cmdRules() {
    const rules = listRules(readRules());
    if (!rules.length) return 'No rules yet.';
    return rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
  }

  function cmdUnrule(args) {
    const n = Number.parseInt(args.trim(), 10);
    if (!Number.isInteger(n)) throw new Error('usage: unrule <n>');
    const result = removeRule(readRules(), n);
    if (!result) throw new Error(`no rule #${n}`);
    fs.writeFileSync(rulesFile(), result.text);
    hot.reloadPrompts();
    return `Removed rule #${n}: ${result.removed}`;
  }

  function cmdSet(args) {
    const spaceIdx = args.search(/\s/);
    if (spaceIdx === -1) throw new Error('usage: set <dotted.path> <json>');
    const dottedPath = args.slice(0, spaceIdx).trim();
    const rawValue = args.slice(spaceIdx + 1).trim();
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
    const dottedPath = args.trim();
    if (!dottedPath) throw new Error('usage: unset <dotted.path>');
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
    const lines = [
      `model: ${cfg?.llm?.model ?? '-'}`,
      `calibration ratio: ${calibrator ? calibrator.ratio.toFixed(3) : '-'}`,
      `llm requests today: ${data.llmCount ?? 0} / ${cfg?.llm?.maxRequestsPerDay ?? '-'} (day: ${data.llmDay ?? '-'})`,
    ];

    const guildIds = typeof store.listGuilds === 'function' ? store.listGuilds() : [];
    for (const guildId of guildIds) {
      const profiles = store.countUsers(guildId);
      const buffer = store.getBuffer(guildId);
      const next = nextSpontaneousFor(guildId);
      lines.push(`guild ${guildId}: profiles=${profiles} buffer=${buffer.length} nextSpontaneous=${next ?? '-'}`);
    }

    const prompts = hot.prompts ?? {};
    for (const name of Object.keys(prompts)) {
      lines.push(`prompt ${name}: ${prompts[name].length} chars`);
    }

    return lines.join('\n');
  }

  async function cmdPoke(args, message) {
    const tokens = args.split(/\s+/).filter(Boolean);
    let mode = 'interject';
    let channelId = null;
    for (const token of tokens) {
      if (token === 'interject' || token === 'initiate') mode = token;
      else channelId = token;
    }

    let channel;
    if (channelId) {
      channel = await client.channels.fetch(channelId);
    } else if (message.guild) {
      channel = message.channel;
    } else {
      throw new Error('a channelId is required in a DM');
    }
    if (!channel) throw new Error(`channel not found: ${channelId}`);

    const result = await spontaneous.poke(channel, mode);
    return `poke ${mode} on ${channel.id}: ${JSON.stringify(result) ?? 'ok'}`;
  }

  function cmdMemory(args, message) {
    const userId = extractUserId(args);
    if (!userId) throw new Error('usage: memory <@mention|userId>');

    if (message.guild) {
      const profile = store.getUser(message.guild.id, userId);
      if (!profile) throw new Error(`no profile for ${userId} in this guild`);
      return JSON.stringify(profile, null, 2);
    }

    for (const guild of client.guilds.cache.values()) {
      const profile = store.getUser(guild.id, userId);
      if (profile) return `guild ${guild.id}:\n${JSON.stringify(profile, null, 2)}`;
    }
    throw new Error(`no profile for ${userId} in any guild`);
  }

  function cmdForget(args, message) {
    const userId = extractUserId(args);
    if (!userId) throw new Error('usage: forget <@mention|userId>');

    if (message.guild) {
      store.forgetUser(message.guild.id, userId);
      return `Forgot ${userId} in guild ${message.guild.id}.`;
    }

    let found = false;
    for (const guild of client.guilds.cache.values()) {
      if (store.getUser(guild.id, userId)) {
        store.forgetUser(guild.id, userId);
        found = true;
      }
    }
    if (!found) throw new Error(`no profile for ${userId} in any guild`);
    return `Forgot ${userId} everywhere.`;
  }

  const commands = {
    help: () => HELP_TEXT,
    rule: (args) => cmdRule(args),
    rules: () => cmdRules(),
    unrule: (args) => cmdUnrule(args),
    set: (args) => cmdSet(args),
    unset: (args) => cmdUnset(args),
    reload: () => cmdReload(),
    status: () => cmdStatus(),
    poke: (args, message) => cmdPoke(args, message),
    memory: (args, message) => cmdMemory(args, message),
    forget: (args, message) => cmdForget(args, message),
  };

  async function sendReply(message, text) {
    const body = String(text ?? '');
    const wrap = body.includes('\n');
    for (const chunk of chunkText(body, REPLY_CHUNK_CHARS)) {
      await message.author.send(wrap ? `\`\`\`\n${chunk}\n\`\`\`` : chunk);
    }
  }

  async function react(message, ok) {
    if (!message.guild) return;
    try {
      await message.react(ok ? '✅' : '❌');
    } catch {
      // best effort — the reply already carries the outcome
    }
  }

  async function handle(message) {
    const authorId = message?.author?.id;
    if (!isOwner(authorId)) return false;

    const prefix = hot.config?.bot?.commandPrefix || '!nep';
    const parsed = parseCommand(String(message?.content ?? ''), prefix);
    if (!parsed) return false;

    const handler = Object.hasOwn(commands, parsed.name) ? commands[parsed.name] : null;
    try {
      const reply = handler ? await handler(parsed.args, message) : `Unknown command: ${parsed.name}\n\n${HELP_TEXT}`;
      await sendReply(message, reply);
      await react(message, true);
    } catch (err) {
      // The owner may have DMs closed; the reaction still tells them it failed.
      await sendReply(message, `Error: ${err?.message ?? String(err)}`).catch(() => {});
      await react(message, false);
    }
    return true;
  }

  return { isOwner, handle };
}
