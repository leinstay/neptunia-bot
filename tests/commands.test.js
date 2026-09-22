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

test('buildCommandTree: top-level leaves (status, ping, reload, pause, resume, poke, set, unset)', () => {
  const [command] = buildCommandTree('nep');
  const names = command.options.map((o) => o.name);
  assert.deepEqual(names, ['status', 'ping', 'reload', 'pause', 'resume', 'poke', 'set', 'unset', 'rule', 'memory', 'lore', 'model', 'warmup']);

  const status = findOption(command.options, 'status');
  assert.equal(status.type, 1); // SUBCOMMAND

  const ping = findOption(command.options, 'ping');
  assert.equal(ping.type, 1); // SUBCOMMAND
  const pingRole = findOption(ping.options, 'role');
  assert.equal(pingRole.type, 3); // STRING
  assert.equal(pingRole.required, false);
  assert.deepEqual(pingRole.choices.map((c) => c.value), ['talk', 'analyzer', 'media']);

  const pause = findOption(command.options, 'pause');
  assert.equal(pause.type, 1); // SUBCOMMAND
  assert.equal(pause.options, undefined);

  const resume = findOption(command.options, 'resume');
  assert.equal(resume.type, 1); // SUBCOMMAND
  assert.equal(resume.options, undefined);

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

test('buildCommandTree: memory group (show/channel/server/forget/affinity/wipe/alias-add/alias-remove/refresh)', () => {
  const [command] = buildCommandTree('nep');
  const memory = findOption(command.options, 'memory');
  assert.equal(memory.type, 2);
  assert.deepEqual(
    memory.options.map((o) => o.name),
    ['show', 'channel', 'server', 'forget', 'alias-add', 'alias-remove', 'affinity', 'wipe', 'refresh'],
  );

  const show = findOption(memory.options, 'show');
  const user = findOption(show.options, 'user');
  assert.equal(user.type, 6); // USER
  assert.equal(user.required, true);

  const section = findOption(show.options, 'section');
  assert.equal(section.type, 3); // STRING
  assert.equal(section.required, false);
  assert.deepEqual(
    section.choices.map((c) => c.value),
    ['summary', 'character', 'style', 'relationship', 'affinity', 'aliases', 'interests', 'details', 'episodes', 'raw'],
  );

  const limit = findOption(show.options, 'limit');
  assert.equal(limit.type, 4); // INTEGER
  assert.equal(limit.required, false);
  assert.equal(limit.min_value, 1);
  assert.equal(limit.max_value, 100);

  const order = findOption(show.options, 'order');
  assert.equal(order.type, 3);
  assert.equal(order.required, false);
  assert.deepEqual(
    order.choices.map((c) => c.value),
    ['rank', 'recent'],
  );

  const channel = findOption(memory.options, 'channel');
  assert.equal(channel.type, 1); // SUBCOMMAND
  const channelOpt = findOption(channel.options, 'channel');
  assert.equal(channelOpt.type, 7); // CHANNEL
  assert.equal(channelOpt.required, false);
  assert.deepEqual(channelOpt.channel_types, [0]); // GUILD_TEXT
  assert.ok(channelOpt.description.length <= 100);

  const server = findOption(memory.options, 'server');
  assert.equal(server.type, 1); // SUBCOMMAND
  assert.equal(server.options, undefined);

  const aliasAdd = findOption(memory.options, 'alias-add');
  assert.equal(findOption(aliasAdd.options, 'user').required, true);
  assert.equal(findOption(aliasAdd.options, 'name').required, true);

  const aliasRemove = findOption(memory.options, 'alias-remove');
  assert.equal(findOption(aliasRemove.options, 'user').required, true);
  assert.equal(findOption(aliasRemove.options, 'name').required, true);

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

  const refresh = findOption(memory.options, 'refresh');
  assert.equal(refresh.type, 1); // SUBCOMMAND
  assert.equal(findOption(refresh.options, 'user').required, true);
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

test('buildCommandTree: warmup group (people, run, stop, users, channels, server, status, reset)', () => {
  const [command] = buildCommandTree('nep');
  const bootstrap = findOption(command.options, 'warmup');
  assert.equal(bootstrap.type, 2); // SUBCOMMAND_GROUP
  assert.deepEqual(
    bootstrap.options.map((o) => o.name),
    ['people', 'run', 'stop', 'users', 'channels', 'server', 'status', 'reset'],
  );
  for (const opt of bootstrap.options) {
    assert.ok(opt.description.length <= 100, `${opt.name} description must be <= 100 chars`);
  }

  const people = findOption(bootstrap.options, 'people');
  assert.equal(people.type, 1); // SUBCOMMAND
  assert.equal(people.options, undefined);

  const run = findOption(bootstrap.options, 'run');
  assert.equal(run.type, 1); // SUBCOMMAND
  assert.equal(run.options, undefined);

  const stop = findOption(bootstrap.options, 'stop');
  assert.equal(stop.type, 1); // SUBCOMMAND
  assert.equal(stop.options, undefined);

  const users = findOption(bootstrap.options, 'users');
  assert.equal(users.type, 1); // SUBCOMMAND
  const userOpt = findOption(users.options, 'user');
  assert.equal(userOpt.type, 6); // USER
  assert.equal(userOpt.required, false);
  assert.ok(userOpt.description.length <= 100);

  const channels = findOption(bootstrap.options, 'channels');
  assert.equal(channels.type, 1); // SUBCOMMAND
  const channelOpt = findOption(channels.options, 'channel');
  assert.equal(channelOpt.type, 7); // CHANNEL
  assert.equal(channelOpt.required, false);
  assert.deepEqual(channelOpt.channel_types, [0]); // GUILD_TEXT
  assert.ok(channelOpt.description.length <= 100);

  const server = findOption(bootstrap.options, 'server');
  assert.equal(server.type, 1); // SUBCOMMAND
  assert.equal(server.options, undefined);

  const status = findOption(bootstrap.options, 'status');
  assert.equal(status.type, 1);
  assert.equal(status.options, undefined);

  const reset = findOption(bootstrap.options, 'reset');
  assert.equal(reset.type, 1);
  assert.equal(reset.options, undefined);
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
      llm: {}, memory: {}, relationships: {}, spontaneous: {}, mention: {},
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

test('interaction handler: memory.show maps the user option to userId, section/limit/order undefined when omitted', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'memory',
    subcommand: 'show',
    optionValues: { user: { id: 'target1' } },
  });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'memory.show');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1', section: undefined, limit: undefined, order: undefined });
});

test('interaction handler: memory.show maps section/limit/order straight through when given', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    group: 'memory',
    subcommand: 'show',
    optionValues: { user: { id: 'target1' }, section: 'interests', limit: 10, order: 'recent' },
  });
  await handler(interaction);

  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1', section: 'interests', limit: 10, order: 'recent' });
});

test('interaction handler: memory.alias-add/alias-remove map user/name straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({
    group: 'memory',
    subcommand: 'alias-add',
    optionValues: { user: { id: 'target1' }, name: 'Ari' },
  }));
  assert.equal(admin.runCalls[0][0], 'memory.alias-add');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1', name: 'Ari' });

  await handler(fakeInteraction({
    group: 'memory',
    subcommand: 'alias-remove',
    optionValues: { user: { id: 'target1' }, name: 'Ari' },
  }));
  assert.equal(admin.runCalls[1][0], 'memory.alias-remove');
  assert.deepEqual(admin.runCalls[1][1], { userId: 'target1', name: 'Ari' });
});

test('interaction handler: memory.channel maps the optional channel option to channelId (undefined when omitted)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'memory', subcommand: 'channel', optionValues: { channel: { id: 'chan1' } } }));
  assert.equal(admin.runCalls[0][0], 'memory.channel');
  assert.deepEqual(admin.runCalls[0][1], { channelId: 'chan1' });

  await handler(fakeInteraction({ group: 'memory', subcommand: 'channel' }));
  assert.deepEqual(admin.runCalls[1][1], { channelId: undefined });
});

test('interaction handler: memory.server maps to empty args', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'memory', subcommand: 'server' }));
  assert.equal(admin.runCalls[0][0], 'memory.server');
  assert.deepEqual(admin.runCalls[0][1], {});
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

test('interaction handler: warmup.people maps to empty args', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'people' }));

  assert.equal(admin.runCalls[0][0], 'warmup.people');
  assert.deepEqual(admin.runCalls[0][1], {});
});

test('interaction handler: warmup.users maps the optional user option to userId (undefined when omitted)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'users', optionValues: { user: { id: 'target1' } } }));
  assert.equal(admin.runCalls[0][0], 'warmup.users');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1' });

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'users' }));
  assert.deepEqual(admin.runCalls[1][1], { userId: undefined });
});

test('interaction handler: warmup.channels maps the optional channel option to channelId (undefined when omitted)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'channels', optionValues: { channel: { id: 'chan1' } } }));
  assert.equal(admin.runCalls[0][0], 'warmup.channels');
  assert.deepEqual(admin.runCalls[0][1], { channelId: 'chan1' });

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'channels' }));
  assert.deepEqual(admin.runCalls[1][1], { channelId: undefined });
});

test('interaction handler: warmup.people/server/run/stop map to empty args', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'people' }));
  assert.equal(admin.runCalls[0][0], 'warmup.people');
  assert.deepEqual(admin.runCalls[0][1], {});

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'server' }));
  assert.deepEqual(admin.runCalls[1][1], {});

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'run' }));
  assert.deepEqual(admin.runCalls[2][1], {});

  await handler(fakeInteraction({ group: 'warmup', subcommand: 'stop' }));
  assert.equal(admin.runCalls[3][0], 'warmup.stop');
  assert.deepEqual(admin.runCalls[3][1], {});
});

test('interaction handler: defers then edits for every bootstrap subcommand (slow commands)', async () => {
  const admin = fakeAdmin({ runImpl: () => 'bootstrap result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const peopleInteraction = fakeInteraction({ group: 'warmup', subcommand: 'people' });
  await handler(peopleInteraction);
  assert.equal(peopleInteraction.deferred, true);
  assert.equal(peopleInteraction.edits[0].content, 'bootstrap result');

  const usersInteraction = fakeInteraction({ group: 'warmup', subcommand: 'users', optionValues: { user: { id: 'target1' } } });
  await handler(usersInteraction);
  assert.equal(usersInteraction.deferred, true);
  assert.equal(usersInteraction.edits[0].content, 'bootstrap result');

  const usersBulkInteraction = fakeInteraction({ group: 'warmup', subcommand: 'users' });
  await handler(usersBulkInteraction);
  assert.equal(usersBulkInteraction.deferred, true);

  const channelsInteraction = fakeInteraction({ group: 'warmup', subcommand: 'channels', optionValues: { channel: { id: 'chan1' } } });
  await handler(channelsInteraction);
  assert.equal(channelsInteraction.deferred, true);

  const channelsBulkInteraction = fakeInteraction({ group: 'warmup', subcommand: 'channels' });
  await handler(channelsBulkInteraction);
  assert.equal(channelsBulkInteraction.deferred, true);

  const serverInteraction = fakeInteraction({ group: 'warmup', subcommand: 'server' });
  await handler(serverInteraction);
  assert.equal(serverInteraction.deferred, true);

  const resetInteraction = fakeInteraction({ group: 'warmup', subcommand: 'reset' });
  await handler(resetInteraction);
  assert.equal(resetInteraction.deferred, true);

  const stopInteraction = fakeInteraction({ group: 'warmup', subcommand: 'stop' });
  await handler(stopInteraction);
  assert.equal(stopInteraction.deferred, true);
  assert.equal(stopInteraction.edits[0].content, 'bootstrap result');
});

test('interaction handler: poke maps the optional mode (default) and channel', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'poke', optionValues: {} });
  await handler(interaction);

  assert.deepEqual(admin.runCalls[0][1], { mode: 'interject', channelId: undefined });
});

test('interaction handler: ping maps the optional role (undefined when omitted)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'ping', optionValues: {} });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'ping');
  assert.deepEqual(admin.runCalls[0][1], { role: undefined });
});

test('interaction handler: ping maps a given role straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'ping', optionValues: { role: 'media' } });
  await handler(interaction);

  assert.deepEqual(admin.runCalls[0][1], { role: 'media' });
});

test('interaction handler: defers then edits for a slow command (ping)', async () => {
  const admin = fakeAdmin({ runImpl: () => 'talk: x — ok, 100ms' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'ping', optionValues: {} });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'talk: x — ok, 100ms');
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

// ---------------------------------------------------------------------------
// pause / resume — F30
// ---------------------------------------------------------------------------

test('interaction handler: pause/resume take no options and map to empty args', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ subcommand: 'pause' }));
  assert.equal(admin.runCalls[0][0], 'pause');
  assert.deepEqual(admin.runCalls[0][1], {});

  await handler(fakeInteraction({ subcommand: 'resume' }));
  assert.equal(admin.runCalls[1][0], 'resume');
  assert.deepEqual(admin.runCalls[1][1], {});
});

test('interaction handler: pause defers then edits, like the other slow commands', async () => {
  const admin = fakeAdmin({ runImpl: () => 'Paused.' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'pause' });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'Paused.');
});

test('interaction handler: resume defers then edits, like the other slow commands', async () => {
  const admin = fakeAdmin({ runImpl: () => 'Resumed.' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'resume' });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'Resumed.');
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

test('buildCommandTree: every description fits Discord\'s 1..100 character limit', () => {
  const tree = buildCommandTree('nep');
  const top = Array.isArray(tree) ? tree[0] : tree;
  const walk = (o, path) => {
    if (o.description !== undefined) {
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${path}: ${o.description.length} chars`);
    }
    for (const x of o.options || []) walk(x, `${path}/${x.name}`);
  };
  walk(top, top.name);
});
