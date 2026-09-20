// Tests for src/discord/commands.js: the pure command tree, command-name
// validation, guild registration (including the swallowed-failure path) and
// the interaction handler (owner gate, option -> args mapping, defer/edit,
// chunked follow-ups, autocomplete).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommandTree,
  isValidCommandName,
  registerCommands,
  createInteractionHandler,
  leafPaths,
} from '../src/discord/commands.js';

/** Runs `fn`, capturing every `process.stdout.write` call (the log module's only sink) and
 * restoring the original afterwards even if `fn` throws. Returns the parsed JSON log entries
 * alongside `fn`'s resolved value; non-JSON stdout noise is silently skipped. */
async function withCapturedLogs(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = original;
  }
  const logs = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        logs.push(JSON.parse(line));
      } catch {
        // not one of our JSON log lines -- ignore
      }
    }
  }
  return { result, logs };
}

function findOption(options, name) {
  return options?.find((o) => o.name === name);
}

// ---------------------------------------------------------------------------
// buildCommandTree
// ---------------------------------------------------------------------------

test('buildCommandTree: one top-level command, hidden by default, named from the argument', () => {
  const tree = buildCommandTree('nep');
  assert.equal(tree.length, 1);
  const [command] = tree;
  assert.equal(command.name, 'nep');
  assert.equal(command.default_member_permissions, '0');
});

test('buildCommandTree: top-level leaves (status, reload, poke, set, unset)', () => {
  const [command] = buildCommandTree('nep');
  const names = command.options.map((o) => o.name);
  assert.deepEqual(names, ['status', 'reload', 'poke', 'set', 'unset', 'rule', 'memory', 'lore', 'model', 'warmup']);

  const status = findOption(command.options, 'status');
  assert.equal(status.type, 1); // SUBCOMMAND

  const poke = findOption(command.options, 'poke');
  assert.equal(poke.type, 1);
  const mode = findOption(poke.options, 'mode');
  assert.equal(mode.type, 3); // STRING
  assert.equal(mode.required, false);
  assert.deepEqual(
    mode.choices.map((c) => c.value),
    ['interject', 'initiate'],
  );
  const pokeChannel = findOption(poke.options, 'channel');
  assert.equal(pokeChannel.type, 7); // CHANNEL
  assert.equal(pokeChannel.required, false);
  assert.deepEqual(pokeChannel.channel_types, [0]); // GUILD_TEXT

  const set = findOption(command.options, 'set');
  const setPath = findOption(set.options, 'path');
  assert.equal(setPath.type, 3);
  assert.equal(setPath.required, true);
  assert.equal(setPath.autocomplete, true);
  const setValue = findOption(set.options, 'value');
  assert.equal(setValue.required, true);
  assert.equal(setValue.autocomplete, undefined);

  const unset = findOption(command.options, 'unset');
  assert.equal(findOption(unset.options, 'path').autocomplete, true);
});

test('buildCommandTree: rule group (add/list/remove)', () => {
  const [command] = buildCommandTree('nep');
  const rule = findOption(command.options, 'rule');
  assert.equal(rule.type, 2); // SUBCOMMAND_GROUP
  const names = rule.options.map((o) => o.name);
  assert.deepEqual(names, ['add', 'list', 'remove']);

  const add = findOption(rule.options, 'add');
  assert.equal(findOption(add.options, 'text').required, true);

  const remove = findOption(rule.options, 'remove');
  const number = findOption(remove.options, 'number');
  assert.equal(number.type, 4); // INTEGER
  assert.equal(number.min_value, 1);
});

test('buildCommandTree: memory group (show/forget/affinity)', () => {
  const [command] = buildCommandTree('nep');
  const memory = findOption(command.options, 'memory');
  assert.equal(memory.type, 2);
  assert.deepEqual(
    memory.options.map((o) => o.name),
    ['show', 'forget', 'affinity', 'wipe'],
  );

  const show = findOption(memory.options, 'show');
  const user = findOption(show.options, 'user');
  assert.equal(user.type, 6); // USER
  assert.equal(user.required, true);

  const affinity = findOption(memory.options, 'affinity');
  assert.equal(findOption(affinity.options, 'user').required, true);
  const score = findOption(affinity.options, 'score');
  assert.equal(score.type, 4);
  assert.equal(score.required, false);
  assert.equal(score.min_value, -100);
  assert.equal(score.max_value, 100);
  const reason = findOption(affinity.options, 'reason');
  assert.equal(reason.required, false);

  const wipe = findOption(memory.options, 'wipe');
  assert.equal(wipe.type, 1); // SUBCOMMAND
  const confirm = findOption(wipe.options, 'confirm');
  assert.equal(confirm.type, 3); // STRING
  assert.equal(confirm.required, true);
});

test('buildCommandTree: lore group (add/list/show/remove)', () => {
  const [command] = buildCommandTree('nep');
  const lore = findOption(command.options, 'lore');
  assert.equal(lore.type, 2); // SUBCOMMAND_GROUP
  assert.deepEqual(
    lore.options.map((o) => o.name),
    ['add', 'list', 'show', 'remove'],
  );

  const add = findOption(lore.options, 'add');
  assert.equal(findOption(add.options, 'title').required, true);
  assert.equal(findOption(add.options, 'keys').required, true);
  assert.equal(findOption(add.options, 'text').required, true);
  const always = findOption(add.options, 'always');
  assert.equal(always.type, 5); // BOOLEAN
  assert.equal(always.required, false);

  const list = findOption(lore.options, 'list');
  assert.equal(findOption(list.options, 'query').required, false);

  const show = findOption(lore.options, 'show');
  assert.equal(findOption(show.options, 'id').required, true);

  const remove = findOption(lore.options, 'remove');
  assert.equal(findOption(remove.options, 'id').required, true);
});

test('buildCommandTree: warmup group, every sub-command and its bounds', () => {
  const [command] = buildCommandTree('nep');
  const warmup = findOption(command.options, 'warmup');
  assert.equal(warmup.type, 2);
  assert.deepEqual(
    warmup.options.map((o) => o.name),
    ['status', 'plan', 'run', 'stop', 'reset', 'primary', 'channel', 'channel-default', 'only', 'depth', 'budget', 'output'],
  );

  const primary = findOption(warmup.options, 'primary');
  const primaryChannel = findOption(primary.options, 'channel');
  assert.equal(primaryChannel.required, false);
  assert.deepEqual(primaryChannel.channel_types, [0]);

  const channel = findOption(warmup.options, 'channel');
  assert.equal(findOption(channel.options, 'channel').required, true);
  const depth = findOption(channel.options, 'depth');
  assert.equal(depth.type, 4);
  assert.equal(depth.min_value, 0);
  assert.equal(depth.max_value, 1_000_000);

  const channelDefault = findOption(warmup.options, 'channel-default');
  assert.equal(findOption(channelDefault.options, 'channel').required, true);

  const only = findOption(warmup.options, 'only');
  const enabled = findOption(only.options, 'enabled');
  assert.equal(enabled.type, 5); // BOOLEAN
  assert.equal(enabled.required, true);

  const depthCmd = findOption(warmup.options, 'depth');
  const messages = findOption(depthCmd.options, 'messages');
  assert.equal(messages.min_value, 1);
  assert.equal(messages.max_value, 1_000_000);

  const budget = findOption(warmup.options, 'budget');
  assert.equal(findOption(budget.options, 'tokens').type, 3); // STRING, k/m parsed by admin.js

  const output = findOption(warmup.options, 'output');
  const tokens = findOption(output.options, 'tokens');
  assert.equal(tokens.type, 4);
  assert.equal(tokens.min_value, 256);
  assert.equal(tokens.max_value, 32000);
});

// ---------------------------------------------------------------------------
// isValidCommandName
// ---------------------------------------------------------------------------

test('isValidCommandName: accepts lowercase letters, digits, - and _, 1..32 chars', () => {
  assert.equal(isValidCommandName('nep'), true);
  assert.equal(isValidCommandName('my-bot_2'), true);
  assert.equal(isValidCommandName('a'.repeat(32)), true);
});

test('isValidCommandName: rejects uppercase, spaces, empty, too long, non-strings', () => {
  assert.equal(isValidCommandName('NEP'), false);
  assert.equal(isValidCommandName('my bot'), false);
  assert.equal(isValidCommandName(''), false);
  assert.equal(isValidCommandName('a'.repeat(33)), false);
  assert.equal(isValidCommandName(undefined), false);
  assert.equal(isValidCommandName(null), false);
});

// ---------------------------------------------------------------------------
// leafPaths
// ---------------------------------------------------------------------------

test('leafPaths: dotted paths of every leaf key, empty objects counted as leaves', () => {
  const paths = leafPaths({ a: { b: 1, c: { d: 2 } }, e: [], f: {} });
  assert.deepEqual(paths.sort(), ['a.b', 'a.c.d', 'e', 'f'].sort());
});

// ---------------------------------------------------------------------------
// registerCommands
// ---------------------------------------------------------------------------

function fakeGuild({ setImpl, applicationId = 'app123' } = {}) {
  const calls = [];
  return {
    client: { application: { id: applicationId } },
    commands: {
      set: async (tree) => {
        calls.push(tree);
        if (setImpl) return setImpl(tree);
        return tree;
      },
    },
    setCalls: calls,
  };
}

test('registerCommands: pushes the built tree for the configured command name', async () => {
  const guild = fakeGuild();
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: true } };

  const ok = await registerCommands(guild, config);

  assert.equal(ok, true);
  assert.equal(guild.setCalls.length, 1);
  assert.deepEqual(guild.setCalls[0], buildCommandTree('nep'));
});

test('registerCommands: features.adminCommands false clears the guild command list instead of setting the tree', async () => {
  const guild = fakeGuild();
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: false } };

  const ok = await registerCommands(guild, config);

  assert.equal(ok, false);
  assert.deepEqual(guild.setCalls, [[]]);
});

test('registerCommands: an invalid commandName is refused without touching the guild', async () => {
  const guild = fakeGuild();
  const config = { bot: { commandName: 'Not Valid' }, features: { adminCommands: true } };

  const { result: ok, logs } = await withCapturedLogs(() => registerCommands(guild, config));

  assert.equal(ok, false);
  assert.equal(guild.setCalls.length, 0);
  assert.ok(logs.some((l) => l.level === 'error'));
});

test('registerCommands: a registration failure (missing applications.commands scope) is swallowed and logged with the re-invite hint', async () => {
  const err = Object.assign(new Error('Missing Access'), { code: 50001 });
  const guild = fakeGuild({
    setImpl: () => {
      throw err;
    },
    applicationId: 'app999',
  });
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: true } };

  const { result: ok, logs } = await withCapturedLogs(() => registerCommands(guild, config));

  assert.equal(ok, false);
  const errorLog = logs.find((l) => l.level === 'error');
  assert.ok(errorLog, 'expected one error log line');
  assert.match(errorLog.msg, /applications\.commands/);
  assert.match(errorLog.msg, /scope=bot%20applications\.commands/);
  assert.match(errorLog.msg, /app999/);
});

test('registerCommands: a failure while clearing commands (adminCommands off) is also swallowed', async () => {
  const guild = fakeGuild({
    setImpl: () => {
      throw new Error('boom');
    },
  });
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: false } };

  const { result: ok } = await withCapturedLogs(() => registerCommands(guild, config));
  assert.equal(ok, false);
});

// ---------------------------------------------------------------------------
// createInteractionHandler
// ---------------------------------------------------------------------------

function fakeAdmin({ owners = ['owner1'], runImpl } = {}) {
  const runCalls = [];
  return {
    isOwner: (userId) => owners.includes(String(userId)),
    run: async (commandKey, args, context) => {
      runCalls.push([commandKey, args, context]);
      if (runImpl) return runImpl(commandKey, args, context);
      return `ok: ${commandKey}`;
    },
    runCalls,
  };
}

function fakeInteraction(overrides = {}) {
  const replies = [];
  const followUps = [];
  const edits = [];
  const respondCalls = [];
  const optionValues = overrides.optionValues ?? {};
  const interaction = {
    guildId: overrides.guildId ?? 'g1',
    channelId: overrides.channelId ?? 'c1',
    user: overrides.user ?? { id: 'owner1' },
    commandName: overrides.commandName ?? 'nep',
    deferred: false,
    replied: false,
    isChatInputCommand: () => overrides.kind !== 'autocomplete',
    isAutocomplete: () => overrides.kind === 'autocomplete',
    options: {
      getSubcommandGroup: () => overrides.group ?? null,
      getSubcommand: () => overrides.subcommand ?? null,
      getString: (name) => optionValues[name] ?? null,
      getInteger: (name) => (optionValues[name] === undefined ? null : optionValues[name]),
      getBoolean: (name) => (optionValues[name] === undefined ? null : optionValues[name]),
      getUser: (name) => optionValues[name] ?? null,
      getChannel: (name) => optionValues[name] ?? null,
      getFocused: () => overrides.focused ?? { name: 'path', value: '' },
    },
    deferReply: async (opts) => {
      interaction.deferred = true;
      replies.push({ deferred: true, opts });
    },
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
    },
    editReply: async (payload) => {
      edits.push(payload);
    },
    followUp: async (payload) => {
      followUps.push(payload);
    },
    respond: async (choices) => {
      respondCalls.push(choices);
    },
    replies,
    edits,
    followUps,
    respondCalls,
  };
  return interaction;
}

function baseHot(featuresOverrides = {}) {
  return {
    config: {
      bot: { commandName: 'nep', owners: ['owner1'] },
      features: { ...featuresOverrides },
      llm: {}, memory: {}, warmup: {}, relationships: {}, spontaneous: {}, mention: {},
    },
  };
}

test('interaction handler: a foreign guild is ignored entirely', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'served-guild' });

  const interaction = fakeInteraction({ guildId: 'other-guild', subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.equal(interaction.replies.length, 0);
});

test('interaction handler: features.adminCommands false replies "disabled" without calling admin.run', async () => {
  const admin = fakeAdmin();
  const hot = baseHot({ adminCommands: false });
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.match(interaction.replies[0].content, /disabled/i);
});

test('interaction handler: a non-owner is refused ephemerally and admin.run is never called', async () => {
  const admin = fakeAdmin({ owners: ['owner1'] });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'intruder' }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.match(interaction.replies[0].content, /not allowed/i);
});

test('interaction handler: a top-level subcommand maps to its bare command key', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'status');
  assert.deepEqual(admin.runCalls[0][2], { guildId: 'g1', channelId: 'c1', userId: 'owner1' });
  assert.equal(interaction.replies[0].ephemeral, true);
  assert.equal(interaction.replies[0].content, 'ok: status');
});

test('interaction handler: memory.show maps the user option to userId', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'memory',
    subcommand: 'show',
    optionValues: { user: { id: 'target1' } },
  });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'memory.show');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1' });
});

test('interaction handler: memory.wipe maps the confirm string option straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'memory',
    subcommand: 'wipe',
    optionValues: { confirm: 'The Server' },
  });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'memory.wipe');
  assert.deepEqual(admin.runCalls[0][1], { confirm: 'The Server' });
});

test('interaction handler: lore.add maps title/keys/text/always straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'lore',
    subcommand: 'add',
    optionValues: { title: 'Founders Day', keys: 'founders, founding day', text: 'The server was founded then.', always: true },
  });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'lore.add');
  assert.deepEqual(admin.runCalls[0][1], {
    title: 'Founders Day',
    keys: 'founders, founding day',
    text: 'The server was founded then.',
    always: true,
  });
});

test('interaction handler: lore.add defaults always to false when omitted', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'lore',
    subcommand: 'add',
    optionValues: { title: 'X', keys: 'x', text: 'text' },
  });
  await handler(interaction);

  assert.equal(admin.runCalls[0][1].always, false);
});

test('interaction handler: lore.show/lore.remove map id straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'lore', subcommand: 'show', optionValues: { id: 'abc123' } }));
  assert.deepEqual(admin.runCalls[0][1], { id: 'abc123' });

  await handler(fakeInteraction({ group: 'lore', subcommand: 'remove', optionValues: { id: 'abc123' } }));
  assert.deepEqual(admin.runCalls[1][1], { id: 'abc123' });
});

test('interaction handler: warmup.channel maps the channel option to channelId and an integer depth', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'warmup',
    subcommand: 'channel',
    optionValues: { channel: { id: 'chan1' }, depth: 500 },
  });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'warmup.channel');
  assert.deepEqual(admin.runCalls[0][1], { channelId: 'chan1', depth: 500 });
});

test('interaction handler: warmup.only maps the boolean option', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'warmup', subcommand: 'only', optionValues: { enabled: true } });
  await handler(interaction);

  assert.deepEqual(admin.runCalls[0][1], { enabled: true });
});

test('interaction handler: warmup.primary omits channelId when the channel option is not given', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'warmup', subcommand: 'primary', optionValues: {} });
  await handler(interaction);

  assert.deepEqual(admin.runCalls[0][1], { channelId: undefined });
});

test('interaction handler: poke maps the optional mode (default) and channel', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'poke', optionValues: {} });
  await handler(interaction);

  assert.deepEqual(admin.runCalls[0][1], { mode: 'interject', channelId: undefined });
});

test('interaction handler: defers then edits for a slow command (poke)', async () => {
  const admin = fakeAdmin({ runImpl: () => 'poked' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'poke', optionValues: {} });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.equal(interaction.replies.some((r) => r.deferred), true);
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'poked');
});

test('interaction handler: a fast command replies directly, no defer', async () => {
  const admin = fakeAdmin({ runImpl: () => 'fast result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.equal(interaction.deferred, false);
  assert.equal(interaction.edits.length, 0);
  assert.equal(interaction.replies[0].content, 'fast result');
  assert.equal(interaction.replies[0].ephemeral, true);
});

test('interaction handler: a thrown admin.run error is reported ephemerally, not thrown', async () => {
  const admin = fakeAdmin({
    runImpl: () => {
      throw new Error('bad input');
    },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await assert.doesNotReject(() => handler(interaction));

  assert.equal(interaction.replies[0].ephemeral, true);
  assert.match(interaction.replies[0].content, /Error: bad input/);
});

test('interaction handler: long output is chunked into ephemeral follow-ups', async () => {
  const longLine = 'x'.repeat(1000);
  const longBody = Array.from({ length: 5 }, () => longLine).join('\n');
  const admin = fakeAdmin({ runImpl: () => longBody });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.ok(interaction.followUps.length >= 1, 'expected at least one follow-up for the overflow');
  for (const followUp of interaction.followUps) {
    assert.equal(followUp.ephemeral, true);
  }
});

test('interaction handler: multi-line output is wrapped in a code block', async () => {
  const admin = fakeAdmin({ runImpl: () => 'line one\nline two' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.match(interaction.replies[0].content, /^```\n/);
});

// ---------------------------------------------------------------------------
// autocomplete
// ---------------------------------------------------------------------------

test('autocomplete: returns up to 25 leaf config paths filtered by the typed text', async () => {
  const admin = fakeAdmin();
  const config = { bot: { commandName: 'nep', owners: ['owner1'] }, features: {}, llm: { model: 'x', maxOutputTokens: 1 } };
  const hot = { config };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ kind: 'autocomplete', focused: { name: 'path', value: 'llm.' } });
  await handler(interaction);

  assert.equal(interaction.respondCalls.length, 1);
  const choices = interaction.respondCalls[0];
  assert.ok(choices.length <= 25);
  assert.ok(choices.every((c) => c.name.toLowerCase().includes('llm.')));
  assert.ok(choices.some((c) => c.name === 'llm.model'));
});

test('autocomplete: a non-owner gets no choices', async () => {
  const admin = fakeAdmin({ owners: ['owner1'] });
  const hot = baseHot();
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ kind: 'autocomplete', user: { id: 'intruder' } });
  await handler(interaction);

  assert.deepEqual(interaction.respondCalls[0], []);
});

test('autocomplete: features.adminCommands false returns no choices', async () => {
  const admin = fakeAdmin();
  const hot = baseHot({ adminCommands: false });
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ kind: 'autocomplete' });
  await handler(interaction);

  assert.deepEqual(interaction.respondCalls[0], []);
});

test('autocomplete: a foreign guild is ignored', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'served-guild' });

  const interaction = fakeInteraction({ kind: 'autocomplete', guildId: 'other-guild' });
  await handler(interaction);

  assert.equal(interaction.respondCalls.length, 0);
});
