// The owner's Discord surface: one top-level guild slash command (name from
// `config.bot.commandName`) whose tree is built here as plain JSON — no
// discord.js builder classes — so `buildCommandTree` is trivially unit
// -tested. `registerCommands` pushes that tree to the single guild this
// instance serves; `createInteractionHandler` turns a discord.js interaction
// into an `admin.run(commandKey, args, context)` call and replies, always
// ephemerally, never letting an error escape into discord.js.
//
// Every option → args mapping lives in one place (OPTION_MAPPERS) so adding a
// command means adding one tree entry and one mapper, nothing else.

import { log } from '../log.js';

// Raw Discord API option-type numbers (application-command-option-type):
// https://discord.com/developers/docs/interactions/application-commands
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;
const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;
const USER = 6;
const CHANNEL = 7;

// application-command-types#channel-type: GUILD_TEXT
const GUILD_TEXT = 0;

const REPLY_CHUNK_CHARS = 1900;
const MAX_AUTOCOMPLETE_CHOICES = 25;

/** Commands that may take long enough to need `deferReply` before `editReply`. */
const SLOW_COMMANDS = new Set(['poke', 'warmup.plan', 'warmup.run', 'reload', 'pause', 'resume']);

const DISABLED_MESSAGE = 'Owner commands are disabled (features.adminCommands is off).';
const NOT_ALLOWED_MESSAGE = 'Not allowed.';

/** `^[a-z0-9_-]{1,32}$` — Discord's rule for a command name. */
export function isValidCommandName(name) {
  return typeof name === 'string' && /^[a-z0-9_-]{1,32}$/.test(name);
}

/**
 * The whole command tree as plain, JSON-serializable objects (the shape
 * `guild.commands.set([...])` expects), for one top-level command named
 * `commandName`. Pure — no discord.js import, no I/O.
 */
export function buildCommandTree(commandName) {
  return [
    {
      name: commandName,
      description: 'Owner controls for the persona.',
      default_member_permissions: '0',
      options: [
        { type: SUBCOMMAND, name: 'status', description: 'Model, calibration, quotas and per-guild memory status.' },
        { type: SUBCOMMAND, name: 'reload', description: 'Reload config and prompts now.' },
        {
          type: SUBCOMMAND,
          name: 'pause',
          description: 'Pause the persona and flush memory so data/ can be edited safely by hand.',
        },
        {
          type: SUBCOMMAND,
          name: 'resume',
          description: 'Resume after a pause, refusing if data/ has an invalid file.',
        },
        {
          type: SUBCOMMAND,
          name: 'poke',
          description: 'Force a spontaneous action.',
          options: [
            {
              type: STRING,
              name: 'mode',
              description: 'Which kind of spontaneous action to force.',
              required: false,
              choices: [
                { name: 'interject', value: 'interject' },
                { name: 'initiate', value: 'initiate' },
              ],
            },
            {
              type: CHANNEL,
              name: 'channel',
              description: 'Channel to poke (defaults to the current one).',
              required: false,
              channel_types: [GUILD_TEXT],
            },
          ],
        },
        {
          type: SUBCOMMAND,
          name: 'set',
          description: 'Override a config.json value (written to config.local.json).',
          options: [
            { type: STRING, name: 'path', description: 'Dotted config path.', required: true, autocomplete: true },
            { type: STRING, name: 'value', description: 'New value (JSON, or a plain string).', required: true },
          ],
        },
        {
          type: SUBCOMMAND,
          name: 'unset',
          description: 'Remove a config override.',
          options: [
            { type: STRING, name: 'path', description: 'Dotted config path.', required: true, autocomplete: true },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'rule',
          description: "Owner's live corrections (prompts.local/rules.md).",
          options: [
            {
              type: SUBCOMMAND,
              name: 'add',
              description: 'Append a rule.',
              options: [{ type: STRING, name: 'text', description: 'Rule text.', required: true }],
            },
            { type: SUBCOMMAND, name: 'list', description: 'List the rules, numbered.' },
            {
              type: SUBCOMMAND,
              name: 'remove',
              description: 'Remove a rule by number.',
              options: [{ type: INTEGER, name: 'number', description: 'Rule number to remove.', required: true, min_value: 1 }],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'memory',
          description: "Inspect or edit a member's stored profile.",
          options: [
            {
              type: SUBCOMMAND,
              name: 'show',
              description: "Show a member's stored profile.",
              options: [
                { type: USER, name: 'user', description: 'Member.', required: true },
                {
                  type: STRING,
                  name: 'section',
                  description: 'Which part of the profile to show (default: summary).',
                  required: false,
                  choices: [
                    { name: 'summary', value: 'summary' },
                    { name: 'character', value: 'character' },
                    { name: 'style', value: 'style' },
                    { name: 'relationship', value: 'relationship' },
                    { name: 'affinity', value: 'affinity' },
                    { name: 'aliases', value: 'aliases' },
                    { name: 'interests', value: 'interests' },
                    { name: 'details', value: 'details' },
                    { name: 'episodes', value: 'episodes' },
                    { name: 'raw', value: 'raw' },
                  ],
                },
                {
                  type: INTEGER,
                  name: 'limit',
                  description: 'Max items to list, for a list section (1..100, default 25).',
                  required: false,
                  min_value: 1,
                  max_value: 100,
                },
                {
                  type: STRING,
                  name: 'order',
                  description: 'List order, for a list section (default: rank).',
                  required: false,
                  choices: [
                    { name: 'rank', value: 'rank' },
                    { name: 'recent', value: 'recent' },
                  ],
                },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'forget',
              description: "Delete a member's stored profile.",
              options: [{ type: USER, name: 'user', description: 'Member.', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'alias-add',
              description: "Add, or strengthen, a member's alias -- a nickname others in chat call them.",
              options: [
                { type: USER, name: 'user', description: 'Member.', required: true },
                { type: STRING, name: 'name', description: 'The alias.', required: true },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'alias-remove',
              description: "Remove one of a member's stored aliases.",
              options: [
                { type: USER, name: 'user', description: 'Member.', required: true },
                { type: STRING, name: 'name', description: 'The alias to remove.', required: true },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'affinity',
              description: "Show, or set, a member's attitude score.",
              options: [
                { type: USER, name: 'user', description: 'Member.', required: true },
                {
                  type: INTEGER,
                  name: 'score',
                  description: 'New score (-100..100); omit to just show the current one.',
                  required: false,
                  min_value: -100,
                  max_value: 100,
                },
                { type: STRING, name: 'reason', description: 'Why (only used together with score).', required: false },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'wipe',
              description: 'Delete ALL remembered members, server habits, channel map and analyzer lore for this server.',
              options: [
                {
                  type: STRING,
                  name: 'confirm',
                  description: "Type this server's exact name to confirm.",
                  required: true,
                },
              ],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'lore',
          description: "The server's lorebook (events, recurring characters, running jokes).",
          options: [
            {
              type: SUBCOMMAND,
              name: 'add',
              description: 'Add or overwrite a lore entry (always an owner entry afterwards).',
              options: [
                { type: STRING, name: 'title', description: 'Entry title (its identity).', required: true },
                { type: STRING, name: 'keys', description: 'Comma-separated keys/phrases people type.', required: true },
                { type: STRING, name: 'text', description: 'The lore text, up to 400 chars.', required: true },
                { type: BOOLEAN, name: 'always', description: 'Always show this entry, regardless of a match.', required: false },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'list',
              description: 'List lore entries, optionally filtered.',
              options: [{ type: STRING, name: 'query', description: 'Filter by a substring of the title/keys.', required: false }],
            },
            {
              type: SUBCOMMAND,
              name: 'show',
              description: 'Show one lore entry in full.',
              options: [{ type: STRING, name: 'id', description: 'Entry id.', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'remove',
              description: 'Delete one lore entry.',
              options: [{ type: STRING, name: 'id', description: 'Entry id.', required: true }],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'model',
          description: 'Which model talks, analyzes memory, and describes pictures.',
          options: [
            { type: SUBCOMMAND, name: 'show', description: 'Show the model configured for each role.' },
            {
              type: SUBCOMMAND,
              name: 'set',
              description: 'Set the model for one role (config.local.json).',
              options: [
                {
                  type: STRING,
                  name: 'role',
                  description: 'Which role to change.',
                  required: true,
                  choices: [
                    { name: 'talk', value: 'talk' },
                    { name: 'analyzer', value: 'analyzer' },
                    { name: 'media', value: 'media' },
                  ],
                },
                { type: STRING, name: 'id', description: 'OpenRouter model id.', required: true },
              ],
            },
          ],
        },
        {
          type: SUBCOMMAND_GROUP,
          name: 'warmup',
          description: 'Memory warm-up controls.',
          options: [
            { type: SUBCOMMAND, name: 'status', description: 'Warm-up status.' },
            { type: SUBCOMMAND, name: 'plan', description: 'The ordered read plan.' },
            { type: SUBCOMMAND, name: 'run', description: 'Start or resume the warm-up now.' },
            { type: SUBCOMMAND, name: 'stop', description: 'Pause after the batch in flight.' },
            { type: SUBCOMMAND, name: 'reset', description: 'Clear warm-up progress.' },
            {
              type: SUBCOMMAND,
              name: 'channel',
              description: "Set a channel's read depth.",
              options: [
                { type: CHANNEL, name: 'channel', description: 'Channel.', required: true, channel_types: [GUILD_TEXT] },
                {
                  type: INTEGER,
                  name: 'depth',
                  description: 'Messages to read (0 skips the channel).',
                  required: true,
                  min_value: 0,
                  max_value: 1_000_000,
                },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'channel-default',
              description: "Remove a channel's depth override.",
              options: [
                { type: CHANNEL, name: 'channel', description: 'Channel.', required: true, channel_types: [GUILD_TEXT] },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'only',
              description: 'Read only channels with a set depth.',
              options: [{ type: BOOLEAN, name: 'enabled', description: 'On or off.', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'depth',
              description: 'Default read depth.',
              options: [
                {
                  type: INTEGER,
                  name: 'messages',
                  description: 'Messages per channel (1..1000000).',
                  required: true,
                  min_value: 1,
                  max_value: 1_000_000,
                },
              ],
            },
            {
              type: SUBCOMMAND,
              name: 'budget',
              description: 'Warm-up token budget.',
              options: [{ type: STRING, name: 'tokens', description: 'Amount, k/m allowed (e.g. 500k, 10m).', required: true }],
            },
            {
              type: SUBCOMMAND,
              name: 'output',
              description: 'Analyzer output limit.',
              options: [
                {
                  type: INTEGER,
                  name: 'tokens',
                  description: 'Output tokens (256..32000).',
                  required: true,
                  min_value: 256,
                  max_value: 32000,
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * Register (or clear) the guild command tree for `guild`. Never throws:
 * a registration failure (e.g. the bot was invited without the
 * `applications.commands` scope, Discord error 50001) is logged once, with
 * the re-invite URL, and the bot carries on without commands.
 * @param {import('discord.js').Guild} guild
 * @param {object} config  the live merged config (hot.config)
 * @returns {Promise<boolean>} true when a command tree was successfully set
 */
export async function registerCommands(guild, config) {
  if (config?.features?.adminCommands === false) {
    try {
      await guild.commands.set([]);
    } catch (err) {
      log.warn('commands: failed to clear guild commands', { error: err });
    }
    return false;
  }

  const commandName = config?.bot?.commandName ?? 'nep';
  if (!isValidCommandName(commandName)) {
    log.error('commands: invalid bot.commandName, not registering', { commandName });
    return false;
  }

  try {
    await guild.commands.set(buildCommandTree(commandName));
    return true;
  } catch (err) {
    const appId = guild.client?.application?.id ?? guild.client?.user?.id ?? 'YOUR_APPLICATION_ID';
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands`;
    log.error(`commands: failed to register guild commands — re-invite the bot: ${inviteUrl}`, { error: err });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Interaction handling
// ---------------------------------------------------------------------------

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

/** The `<group>.<name>` (or plain `<name>`) command key for a chat-input interaction. */
function commandKeyFor(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);
  if (!sub) return null;
  return group ? `${group}.${sub}` : sub;
}

const OPTION_MAPPERS = {
  status: () => ({}),
  reload: () => ({}),
  pause: () => ({}),
  resume: () => ({}),
  poke: (options) => ({
    mode: options.getString('mode') ?? 'interject',
    channelId: options.getChannel('channel')?.id,
  }),
  set: (options) => ({ path: options.getString('path', true), value: options.getString('value', true) }),
  unset: (options) => ({ path: options.getString('path', true) }),
  'rule.add': (options) => ({ text: options.getString('text', true) }),
  'rule.list': () => ({}),
  'rule.remove': (options) => ({ number: options.getInteger('number', true) }),
  'memory.show': (options) => ({
    userId: options.getUser('user', true).id,
    section: options.getString('section') ?? undefined,
    limit: options.getInteger('limit') ?? undefined,
    order: options.getString('order') ?? undefined,
  }),
  'memory.forget': (options) => ({ userId: options.getUser('user', true).id }),
  'memory.alias-add': (options) => ({ userId: options.getUser('user', true).id, name: options.getString('name', true) }),
  'memory.alias-remove': (options) => ({ userId: options.getUser('user', true).id, name: options.getString('name', true) }),
  'memory.wipe': (options) => ({ confirm: options.getString('confirm', true) }),
  'memory.affinity': (options) => ({
    userId: options.getUser('user', true).id,
    score: options.getInteger('score') ?? undefined,
    reason: options.getString('reason') ?? undefined,
  }),
  'lore.add': (options) => ({
    title: options.getString('title', true),
    keys: options.getString('keys', true),
    text: options.getString('text', true),
    always: options.getBoolean('always') ?? false,
  }),
  'lore.list': (options) => ({ query: options.getString('query') ?? undefined }),
  'lore.show': (options) => ({ id: options.getString('id', true) }),
  'lore.remove': (options) => ({ id: options.getString('id', true) }),
  'model.show': () => ({}),
  'model.set': (options) => ({ role: options.getString('role', true), id: options.getString('id', true) }),
  'warmup.status': () => ({}),
  'warmup.plan': () => ({}),
  'warmup.run': () => ({}),
  'warmup.stop': () => ({}),
  'warmup.reset': () => ({}),
  'warmup.channel': (options) => ({
    channelId: options.getChannel('channel', true).id,
    depth: options.getInteger('depth', true),
  }),
  'warmup.channel-default': (options) => ({ channelId: options.getChannel('channel', true).id }),
  'warmup.only': (options) => ({ enabled: options.getBoolean('enabled', true) }),
  'warmup.depth': (options) => ({ messages: options.getInteger('messages', true) }),
  'warmup.budget': (options) => ({ tokens: options.getString('tokens', true) }),
  'warmup.output': (options) => ({ tokens: options.getInteger('tokens', true) }),
};

function buildArgs(commandKey, interaction) {
  const mapper = OPTION_MAPPERS[commandKey];
  return mapper ? mapper(interaction.options) : {};
}

/** Every dotted leaf path of a plain config object, deepest first key order preserved. */
export function leafPaths(config, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    const isPlainObject = value !== null && typeof value === 'object' && !Array.isArray(value);
    if (isPlainObject && Object.keys(value).length > 0) {
      out.push(...leafPaths(value, full));
    } else {
      out.push(full);
    }
  }
  return out;
}

async function respond(interaction, text, deferred) {
  const body = String(text ?? '');
  const wrap = body.includes('\n');
  const chunks = chunkText(body, REPLY_CHUNK_CHARS);
  const format = (chunk) => (wrap ? `\`\`\`\n${chunk}\n\`\`\`` : chunk);

  if (deferred) {
    await interaction.editReply({ content: format(chunks[0]) });
  } else {
    await interaction.reply({ content: format(chunks[0]), ephemeral: true });
  }
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: format(chunk), ephemeral: true });
  }
}

/**
 * `hot`, `admin` — see src/hot.js, src/admin.js#createAdmin.
 * `getGuildId` — the single guild this instance serves, or null before it resolves.
 * @returns {(interaction: import('discord.js').Interaction) => Promise<void>}
 */
export function createInteractionHandler({ hot, admin, getGuildId }) {
  async function handleAutocomplete(interaction) {
    if (interaction.guildId !== getGuildId()) return;
    const config = hot.config;
    if (config?.features?.adminCommands === false) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    if (!admin.isOwner(interaction.user.id)) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'path') {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const typed = String(focused.value ?? '').toLowerCase();
    const choices = leafPaths(hot.config)
      .filter((p) => p.toLowerCase().includes(typed))
      .slice(0, MAX_AUTOCOMPLETE_CHOICES)
      .map((p) => ({ name: p, value: p }));
    await interaction.respond(choices).catch(() => {});
  }

  async function handleChatInput(interaction) {
    if (interaction.guildId !== getGuildId()) return;
    const config = hot.config;

    if (config?.features?.adminCommands === false) {
      await interaction.reply({ content: DISABLED_MESSAGE, ephemeral: true }).catch(() => {});
      return;
    }

    if (!admin.isOwner(interaction.user.id)) {
      await interaction.reply({ content: NOT_ALLOWED_MESSAGE, ephemeral: true }).catch(() => {});
      return;
    }

    const commandKey = commandKeyFor(interaction);
    if (!commandKey) {
      await interaction.reply({ content: 'Error: no subcommand given.', ephemeral: true }).catch(() => {});
      return;
    }

    const slow = SLOW_COMMANDS.has(commandKey);
    try {
      if (slow) await interaction.deferReply({ ephemeral: true });
      const args = buildArgs(commandKey, interaction);
      const context = { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id };
      const result = await admin.run(commandKey, args, context);
      await respond(interaction, result, slow);
    } catch (err) {
      await respond(interaction, `Error: ${err?.message ?? String(err)}`, slow).catch(() => {});
    }
  }

  return async function handleInteraction(interaction) {
    try {
      if (interaction.isAutocomplete?.()) {
        await handleAutocomplete(interaction);
        return;
      }
      if (interaction.isChatInputCommand?.()) {
        await handleChatInput(interaction);
        return;
      }
    } catch (err) {
      log.error('commands: interaction handler failed', { error: err });
    }
  };
}
