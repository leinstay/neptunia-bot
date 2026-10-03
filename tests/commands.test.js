// Tests for src/discord/commands.js: the pure command tree, command-name
// validation, guild registration (including the swallowed-failure path) and
// the interaction handler (owner gate, option -> args mapping, defer/edit,
// chunked follow-ups, autocomplete).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import {
  buildCommandTree,
  isValidCommandName,
  registerCommands,
  createInteractionHandler,
  leafPaths,
  commandKeys,
  commandSize,
  MODEL_ROLES,
  MEMORY_SHOW_SECTIONS,
} from '../src/discord/commands.js';
import { isAllowed as accessIsAllowed } from '../src/discord/access.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

function findOption(options, name) {
  return options?.find((o) => o.name === name);
}

// ---------------------------------------------------------------------------
// buildCommandTree
// ---------------------------------------------------------------------------

test('buildCommandTree: one top-level command, named from the argument', () => {
  const tree = buildCommandTree('nep');
  assert.equal(tree.length, 1);
  const [command] = tree;
  assert.equal(command.name, 'nep');
});

test('buildCommandTree: never emits default_member_permissions -- always visible, gating happens in code', () => {
  const [command] = buildCommandTree('nep');
  assert.equal('default_member_permissions' in command, false);
});

test('buildCommandTree: top-level leaves (status, ping, reload, pause, resume, interject, initiate, draw, set, unset)', () => {
  const [command] = buildCommandTree('nep');
  const names = command.options.map((o) => o.name);
  assert.deepEqual(names, ['status', 'ping', 'reload', 'variety', 'pause', 'resume', 'interject', 'initiate', 'draw', 'set', 'unset', 'rule', 'memory', 'private', 'alias', 'lore', 'learned', 'emoji', 'gifs', 'model', 'route', 'warmup', 'mentor', 'access']);

  const status = findOption(command.options, 'status');
  assert.equal(status.type, 1); // SUBCOMMAND

  const ping = findOption(command.options, 'ping');
  assert.equal(ping.type, 1); // SUBCOMMAND
  const pingRole = findOption(ping.options, 'role');
  assert.equal(pingRole.type, 3); // STRING
  assert.equal(pingRole.required, false);
  assert.deepEqual(pingRole.choices.map((c) => c.value), ['talk', 'analyzer', 'classifier.text', 'classifier.media', 'classifier.video', 'mentor', 'image', 'classifier']);

  const pause = findOption(command.options, 'pause');
  assert.equal(pause.type, 1); // SUBCOMMAND
  assert.equal(pause.options, undefined);

  const resume = findOption(command.options, 'resume');
  assert.equal(resume.type, 1); // SUBCOMMAND
  assert.equal(resume.options, undefined);

  const interject = findOption(command.options, 'interject');
  assert.equal(interject.type, 1);
  const interjectChannel = findOption(interject.options, 'channel');
  assert.equal(interjectChannel.type, 7); // CHANNEL
  assert.equal(interjectChannel.required, false);
  assert.deepEqual(interjectChannel.channel_types, [0]); // GUILD_TEXT

  const initiate = findOption(command.options, 'initiate');
  assert.equal(initiate.type, 1);
  const initiateChannel = findOption(initiate.options, 'channel');
  assert.equal(initiateChannel.type, 7); // CHANNEL
  assert.equal(initiateChannel.required, false);
  assert.deepEqual(initiateChannel.channel_types, [0]); // GUILD_TEXT

  assert.equal(findOption(command.options, 'poke'), undefined);

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

test('buildCommandTree: memory group (show/channel/server/forget/affinity/wipe/refresh), no alias subcommands', () => {
  const [command] = buildCommandTree('nep');
  const memory = findOption(command.options, 'memory');
  assert.equal(memory.type, 2);
  assert.deepEqual(
    memory.options.map((o) => o.name),
    ['show', 'channel', 'server', 'forget', 'affinity', 'wipe', 'refresh'],
  );
  assert.ok(!memory.options.some((o) => o.name.startsWith('alias')), 'the alias commands moved to their own group');

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

test('buildCommandTree: private group (show/forget/purge), each with a required user', () => {
  const [command] = buildCommandTree('nep');
  const group = findOption(command.options, 'private');
  assert.equal(group.type, 2); // SUBCOMMAND_GROUP
  assert.ok(group.description.length <= 100);
  assert.deepEqual(
    group.options.map((o) => o.name),
    ['show', 'forget', 'purge'],
  );
  for (const sub of group.options) {
    assert.equal(sub.type, 1); // SUBCOMMAND
    assert.ok(sub.description.length <= 100, `${sub.name} description must be <= 100 chars`);
    assert.equal(sub.options.length, 1);
    const user = findOption(sub.options, 'user');
    assert.equal(user.type, 6); // USER
    assert.equal(user.required, true);
  }
});

test('buildCommandTree: alias group (add/remove), each with a required user and name', () => {
  const [command] = buildCommandTree('nep');
  const alias = findOption(command.options, 'alias');
  assert.equal(alias.type, 2); // SUBCOMMAND_GROUP
  assert.deepEqual(
    alias.options.map((o) => o.name),
    ['add', 'remove'],
  );
  for (const sub of alias.options) {
    assert.equal(sub.type, 1); // SUBCOMMAND
    assert.ok(sub.description.length <= 100, `${sub.name} description must be <= 100 chars`);
    const user = findOption(sub.options, 'user');
    assert.equal(user.type, 6); // USER
    assert.equal(user.required, true);
    const name = findOption(sub.options, 'name');
    assert.equal(name.type, 3); // STRING
    assert.equal(name.required, true);
  }
});

test('buildCommandTree: emoji group (status/rescan), no options', () => {
  const [command] = buildCommandTree('nep');
  const emoji = findOption(command.options, 'emoji');
  assert.equal(emoji.type, 2); // SUBCOMMAND_GROUP
  assert.ok(emoji.description.length <= 100);
  assert.deepEqual(emoji.options.map((o) => o.name), ['status', 'rescan']);
  for (const sub of emoji.options) {
    assert.equal(sub.type, 1); // SUBCOMMAND
    assert.ok(sub.description.length <= 100, `${sub.name} description must be <= 100 chars`);
    assert.equal(sub.options, undefined);
  }
  const { keys } = commandKeys();
  assert.ok(keys.has('emoji.status'));
  assert.ok(keys.has('emoji.rescan'));
});

test('buildCommandTree: gifs group (status/rescan/recache), no options', () => {
  const [command] = buildCommandTree('nep');
  const gifs = findOption(command.options, 'gifs');
  assert.equal(gifs.type, 2); // SUBCOMMAND_GROUP
  assert.ok(gifs.description.length <= 100);
  assert.deepEqual(gifs.options.map((o) => o.name), ['status', 'rescan', 'recache']);
  for (const sub of gifs.options) {
    assert.equal(sub.type, 1); // SUBCOMMAND
    assert.ok(sub.description.length <= 100, `${sub.name} description must be <= 100 chars`);
    assert.equal(sub.options, undefined);
  }
  const { keys } = commandKeys();
  assert.ok(keys.has('gifs.status'));
  assert.ok(keys.has('gifs.rescan'));
  assert.ok(keys.has('gifs.recache'));
});

test('buildCommandTree: learned group (list/add/remove)', () => {
  const [command] = buildCommandTree('nep');
  const learned = findOption(command.options, 'learned');
  assert.equal(learned.type, 2); // SUBCOMMAND_GROUP
  assert.ok(learned.description.length <= 100);
  assert.deepEqual(
    learned.options.map((o) => o.name),
    ['list', 'add', 'remove'],
  );
  for (const sub of learned.options) {
    assert.equal(sub.type, 1); // SUBCOMMAND
    assert.ok(sub.description.length <= 100, `${sub.name} description must be <= 100 chars`);
  }

  const list = findOption(learned.options, 'list');
  assert.equal(list.options, undefined);

  const add = findOption(learned.options, 'add');
  const text = findOption(add.options, 'text');
  assert.equal(text.type, 3); // STRING
  assert.equal(text.required, true);

  const remove = findOption(learned.options, 'remove');
  const id = findOption(remove.options, 'id');
  assert.equal(id.type, 4); // INTEGER
  assert.equal(id.required, true);
  assert.equal(id.min_value, 1);
});

test('buildCommandTree: no subcommand or group name anywhere in the tree contains a hyphen', () => {
  const [command] = buildCommandTree('nep');
  const names = [];
  const walk = (options) => {
    for (const option of options ?? []) {
      if (option.type === 1 || option.type === 2) {
        names.push(option.name);
        walk(option.options);
      }
    }
  };
  walk(command.options);
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(!name.includes('-'), `${name} must not contain a hyphen`);
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

test('buildCommandTree: model group (show/set) role choices are talk/analyzer/classifier.text/classifier.media/classifier.video/mentor', () => {
  const [command] = buildCommandTree('nep');
  const model = findOption(command.options, 'model');
  assert.equal(model.type, 2); // SUBCOMMAND_GROUP
  assert.deepEqual(
    model.options.map((o) => o.name),
    ['show', 'set'],
  );

  const set = findOption(model.options, 'set');
  const role = findOption(set.options, 'role');
  assert.equal(role.type, 3); // STRING
  assert.equal(role.required, true);
  assert.deepEqual(role.choices.map((c) => c.value), ['talk', 'analyzer', 'classifier.text', 'classifier.media', 'classifier.video', 'mentor']);
});

test('buildCommandTree: the ping role choices contain image, the model-set choices do not', () => {
  const [command] = buildCommandTree('nep');
  const pingRole = findOption(findOption(command.options, 'ping').options, 'role');
  assert.ok(pingRole.choices.some((c) => c.value === 'image' && c.name === 'image'));

  const set = findOption(findOption(command.options, 'model').options, 'set');
  const setRole = findOption(set.options, 'role');
  assert.ok(!setRole.choices.some((c) => c.value === 'image'));
});

test('MODEL_ROLES: the model-set, route and ping role choices are all derived from the one list', () => {
  assert.deepEqual(MODEL_ROLES, ['talk', 'analyzer', 'classifier.text', 'classifier.media', 'classifier.video', 'mentor']);
  assert.ok(Object.isFrozen(MODEL_ROLES));
  const [command] = buildCommandTree('nep');
  const values = (option) => option.choices.map((c) => c.value);
  const names = (option) => option.choices.map((c) => c.name);
  const setRole = findOption(findOption(findOption(command.options, 'model').options, 'set').options, 'role');
  assert.deepEqual(values(setRole), [...MODEL_ROLES]);
  const route = findOption(command.options, 'route');
  for (const sub of ['set', 'remove']) {
    const role = findOption(findOption(route.options, sub).options, 'role');
    assert.deepEqual(values(role), [...MODEL_ROLES, 'image'], sub);
    assert.deepEqual(names(role), values(role), sub);
  }
  const pingRole = findOption(findOption(command.options, 'ping').options, 'role');
  assert.deepEqual(values(pingRole), [...MODEL_ROLES, 'image', 'classifier']);
  assert.deepEqual(names(pingRole), values(pingRole));
});

test('MEMORY_SHOW_SECTIONS: the memory.show section choices, in order', () => {
  assert.ok(Object.isFrozen(MEMORY_SHOW_SECTIONS));
  const [command] = buildCommandTree('nep');
  const show = findOption(findOption(command.options, 'memory').options, 'show');
  const section = findOption(show.options, 'section');
  assert.deepEqual(section.choices, MEMORY_SHOW_SECTIONS.map((name) => ({ name, value: name })));
});

test('buildCommandTree: warmup group (people, run, stop, users, channels, server, status, reset)', () => {
  const [command] = buildCommandTree('nep');
  const warmup = findOption(command.options, 'warmup');
  assert.equal(warmup.type, 2); // SUBCOMMAND_GROUP
  assert.deepEqual(
    warmup.options.map((o) => o.name),
    ['people', 'run', 'stop', 'users', 'channels', 'server', 'status', 'reset'],
  );
  for (const opt of warmup.options) {
    assert.ok(opt.description.length <= 100, `${opt.name} description must be <= 100 chars`);
  }

  const people = findOption(warmup.options, 'people');
  assert.equal(people.type, 1); // SUBCOMMAND
  assert.equal(people.options, undefined);

  const run = findOption(warmup.options, 'run');
  assert.equal(run.type, 1); // SUBCOMMAND
  assert.equal(run.options, undefined);

  const stop = findOption(warmup.options, 'stop');
  assert.equal(stop.type, 1); // SUBCOMMAND
  assert.equal(stop.options, undefined);

  const users = findOption(warmup.options, 'users');
  assert.equal(users.type, 1); // SUBCOMMAND
  const userOpt = findOption(users.options, 'user');
  assert.equal(userOpt.type, 6); // USER
  assert.equal(userOpt.required, false);
  assert.ok(userOpt.description.length <= 100);

  const channels = findOption(warmup.options, 'channels');
  assert.equal(channels.type, 1); // SUBCOMMAND
  const channelOpt = findOption(channels.options, 'channel');
  assert.equal(channelOpt.type, 7); // CHANNEL
  assert.equal(channelOpt.required, false);
  assert.deepEqual(channelOpt.channel_types, [0]); // GUILD_TEXT
  assert.ok(channelOpt.description.length <= 100);

  const server = findOption(warmup.options, 'server');
  assert.equal(server.type, 1); // SUBCOMMAND
  assert.equal(server.options, undefined);

  const status = findOption(warmup.options, 'status');
  assert.equal(status.type, 1);
  assert.equal(status.options, undefined);

  const reset = findOption(warmup.options, 'reset');
  assert.equal(reset.type, 1);
  assert.equal(reset.options, undefined);
});

test('buildCommandTree: access group (grant/revoke/list), every description <= 100 chars', () => {
  const [command] = buildCommandTree('nep');
  const access = findOption(command.options, 'access');
  assert.equal(access.type, 2); // SUBCOMMAND_GROUP
  assert.deepEqual(
    access.options.map((o) => o.name),
    ['grant', 'revoke', 'list'],
  );
  for (const opt of access.options) {
    assert.ok(opt.description.length <= 100, `${opt.name} description must be <= 100 chars`);
  }

  for (const subName of ['grant', 'revoke']) {
    const sub = findOption(access.options, subName);
    assert.equal(sub.type, 1); // SUBCOMMAND

    const commandOpt = findOption(sub.options, 'command');
    assert.equal(commandOpt.type, 3); // STRING
    assert.equal(commandOpt.required, true);
    assert.equal(commandOpt.autocomplete, true);

    const role = findOption(sub.options, 'role');
    assert.equal(role.type, 8); // ROLE
    assert.equal(role.required, false);

    const user = findOption(sub.options, 'user');
    assert.equal(user.type, 6); // USER
    assert.equal(user.required, false);
  }

  const list = findOption(access.options, 'list');
  assert.equal(list.type, 1); // SUBCOMMAND
  assert.equal(list.options, undefined);
});

// ---------------------------------------------------------------------------
// commandKeys
// ---------------------------------------------------------------------------

test('commandKeys: every group and every leaf command key, derived from the tree', () => {
  const { keys, groups } = commandKeys();
  assert.ok(groups.has('memory'));
  assert.ok(groups.has('rule'));
  assert.ok(groups.has('lore'));
  assert.ok(groups.has('model'));
  assert.ok(groups.has('warmup'));
  assert.ok(groups.has('access'));
  assert.ok(groups.has('alias'));
  assert.ok(groups.has('learned'));
  assert.ok(groups.has('private'));
  assert.ok(!groups.has('status'), 'a bare top-level command is not a group');
  assert.ok(keys.has('private.show'));
  assert.ok(keys.has('private.forget'));
  assert.ok(keys.has('private.purge'));

  assert.ok(keys.has('status'));
  assert.ok(keys.has('memory.show'));
  assert.ok(keys.has('access.grant'));
  assert.ok(keys.has('access.revoke'));
  assert.ok(keys.has('access.list'));
  assert.ok(keys.has('alias.add'));
  assert.ok(keys.has('alias.remove'));
  assert.ok(keys.has('learned.list'));
  assert.ok(keys.has('learned.add'));
  assert.ok(keys.has('learned.remove'));
  assert.ok(!keys.has('memory.alias-add'));
  assert.ok(!keys.has('memory.alias-remove'));
  assert.ok(!keys.has('memory'), 'a group name alone is not a leaf key');
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

test('registerCommands: pushes a visible tree (no default_member_permissions) regardless of bot.access', async () => {
  const guild = fakeGuild();
  const config = {
    bot: { commandName: 'nep', access: { status: { everyone: true, roles: [], users: [] } } },
    features: { adminCommands: true },
  };

  const ok = await registerCommands(guild, config);

  assert.equal(ok, true);
  assert.deepEqual(guild.setCalls[0], buildCommandTree('nep'));
  assert.equal('default_member_permissions' in guild.setCalls[0][0], false);
});

test('registerCommands: an empty bot.access (no grants) still pushes a visible tree', async () => {
  const guild = fakeGuild();
  const config = { bot: { commandName: 'nep', access: {} }, features: { adminCommands: true } };

  await registerCommands(guild, config);

  assert.equal('default_member_permissions' in guild.setCalls[0][0], false);
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
  assert.equal(errorLog.msg, 'commands: registration failed');
  assert.equal(errorLog.reason, 'scope');
  assert.match(errorLog.inviteUrl, /scope=bot%20applications\.commands/);
  assert.match(errorLog.inviteUrl, /client_id=app999/);
  assert.equal(errorLog.error.code, 50001);
});

test('registerCommands: a command-too-large refusal logs the tree size and the limit, not the re-invite hint', async () => {
  const err = Object.assign(
    new Error('Invalid Form Body\n0[APPLICATION_COMMAND_TOO_LARGE]: Command exceeds maximum size (8000)'),
    { name: 'DiscordAPIError[50035]', code: 50035 },
  );
  const guild = fakeGuild({
    setImpl: () => {
      throw err;
    },
  });
  const config = { bot: { commandName: 'nep' }, features: { adminCommands: true } };

  const { result: ok, logs } = await withCapturedLogs(() => registerCommands(guild, config));

  assert.equal(ok, false);
  const errorLog = logs.find((l) => l.level === 'error');
  assert.ok(errorLog, 'expected one error log line');
  assert.equal(errorLog.msg, 'commands: registration failed');
  assert.equal(errorLog.reason, 'too-large');
  assert.equal(errorLog.size, commandSize(buildCommandTree('nep')[0]));
  assert.equal(errorLog.limit, 8000);
  assert.equal(errorLog.inviteUrl, undefined, 'a tree over the size limit is no scope problem: no re-invite URL');
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

/** A fake admin whose `isAllowed` runs the real, pure src/discord/access.js#isAllowed against
 * `owners`/`access`, exactly the way src/admin.js#createAdmin wires it -- so these tests exercise
 * the real gating logic, not a stand-in for it. */
function fakeAdmin({ owners = ['owner1'], access = {}, runImpl } = {}) {
  const runCalls = [];
  return {
    isOwner: (userId) => owners.includes(String(userId)),
    isAllowed: (commandKey, { userId, roleIds } = {}) =>
      accessIsAllowed({ commandKey, userId, roleIds, owners, access }),
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
    member: overrides.member,
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
      getRole: (name) => optionValues[name] ?? null,
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
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(interaction.replies[0].content, /disabled/i);
});

test('interaction handler: an interaction without a subcommand gets an ephemeral error and no admin.run', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: null });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.deepEqual(interaction.replies, [{ content: 'Error: no subcommand given.', flags: MessageFlags.Ephemeral }]);
});

test('interaction handler: a non-owner is refused ephemerally and admin.run is never called', async () => {
  const admin = fakeAdmin({ owners: ['owner1'] });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'intruder' }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.equal(interaction.replies.length, 1);
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(interaction.replies[0].content, /not allowed/i);
});

test('interaction handler: a non-owner granted the exact command key by role is let through', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { status: { everyone: false, roles: ['staff'], users: [] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'helper1' }, member: { roles: ['staff'] }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'status');
  assert.equal(interaction.replies[0].content, 'ok: status');
});

test('interaction handler: a non-owner granted by user id on the group key is let through for any subcommand in it', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { memory: { everyone: false, roles: [], users: ['helper1'] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    user: { id: 'helper1' },
    group: 'memory',
    subcommand: 'server',
  });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'memory.server');
});

test('interaction handler: a non-owner granted everyone via * is let through for any command', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { '*': { everyone: true, roles: [], users: [] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'anyone' }, subcommand: 'reload' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'reload');
});

test('interaction handler: a non-owner with a grant on a DIFFERENT key is still refused', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { ping: { everyone: true, roles: [], users: [] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ user: { id: 'helper1' }, subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 0);
  assert.match(interaction.replies[0].content, /not allowed/i);
});

test('interaction handler: /nep private stays owner-only even with a grant on it, its group or *', async () => {
  const open = { everyone: true, roles: [], users: [] };
  const admin = fakeAdmin({ owners: ['owner1'], access: { '*': open, private: open, 'private.show': open, 'private.forget': open, 'private.purge': open } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  for (const subcommand of ['show', 'forget', 'purge']) {
    const interaction = fakeInteraction({ user: { id: 'helper1' }, group: 'private', subcommand, optionValues: { user: { id: 'target1' } } });
    await handler(interaction);
    assert.match(interaction.replies[0].content, /not allowed/i, subcommand);
  }
  assert.equal(admin.runCalls.length, 0);

  await handler(fakeInteraction({ group: 'private', subcommand: 'show', optionValues: { user: { id: 'target1' } } }));
  assert.equal(admin.runCalls.length, 1, 'the owner still runs it');
});

test('interaction handler: access.grant/revoke map command/role/user straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({
    group: 'access',
    subcommand: 'grant',
    optionValues: { command: 'memory', role: { id: 'role1' } },
  }));
  assert.equal(admin.runCalls[0][0], 'access.grant');
  assert.deepEqual(admin.runCalls[0][1], { command: 'memory', roleId: 'role1', userId: undefined });

  await handler(fakeInteraction({
    group: 'access',
    subcommand: 'revoke',
    optionValues: { command: 'memory', user: { id: 'user1' } },
  }));
  assert.equal(admin.runCalls[1][0], 'access.revoke');
  assert.deepEqual(admin.runCalls[1][1], { command: 'memory', roleId: undefined, userId: 'user1' });
});

test('interaction handler: access.list maps to empty args', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'access', subcommand: 'list' }));
  assert.equal(admin.runCalls[0][0], 'access.list');
  assert.deepEqual(admin.runCalls[0][1], {});
});

test('interaction handler: a top-level subcommand maps to its bare command key', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.equal(admin.runCalls.length, 1);
  assert.equal(admin.runCalls[0][0], 'status');
  assert.deepEqual(admin.runCalls[0][2], { guildId: 'g1', channelId: 'c1', userId: 'owner1' });
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
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

test('interaction handler: alias.add/alias.remove map user/name straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({
    group: 'alias',
    subcommand: 'add',
    optionValues: { user: { id: 'target1' }, name: 'Ari' },
  }));
  assert.equal(admin.runCalls[0][0], 'alias.add');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1', name: 'Ari' });

  await handler(fakeInteraction({
    group: 'alias',
    subcommand: 'remove',
    optionValues: { user: { id: 'target1' }, name: 'Ari' },
  }));
  assert.equal(admin.runCalls[1][0], 'alias.remove');
  assert.deepEqual(admin.runCalls[1][1], { userId: 'target1', name: 'Ari' });
});

test('interaction handler: emoji.status replies at once, emoji.rescan is deferred', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const status = fakeInteraction({ group: 'emoji', subcommand: 'status' });
  await handler(status);
  assert.equal(admin.runCalls[0][0], 'emoji.status');
  assert.deepEqual(admin.runCalls[0][1], {});
  assert.ok(!status.replies.some((r) => r.deferred));

  const rescan = fakeInteraction({ group: 'emoji', subcommand: 'rescan' });
  await handler(rescan);
  assert.equal(admin.runCalls[1][0], 'emoji.rescan');
  assert.deepEqual(admin.runCalls[1][1], {});
  assert.ok(rescan.replies.some((r) => r.deferred));
  assert.equal(rescan.edits.length, 1);
});

test('interaction handler: gifs.status replies at once, gifs.rescan is deferred', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const status = fakeInteraction({ group: 'gifs', subcommand: 'status' });
  await handler(status);
  assert.equal(admin.runCalls[0][0], 'gifs.status');
  assert.deepEqual(admin.runCalls[0][1], {});
  assert.ok(!status.replies.some((r) => r.deferred));

  const rescan = fakeInteraction({ group: 'gifs', subcommand: 'rescan' });
  await handler(rescan);
  assert.equal(admin.runCalls[1][0], 'gifs.rescan');
  assert.deepEqual(admin.runCalls[1][1], {});
  assert.ok(rescan.replies.some((r) => r.deferred));
  assert.equal(rescan.edits.length, 1);
});

test('interaction handler: memory.forget, memory.wipe and private.forget are deferred (they wait for the analyzer)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  for (const [group, subcommand, optionValues] of [
    ['memory', 'forget', { user: { id: 'target1' } }],
    ['memory', 'wipe', { confirm: 'The Server' }],
    ['private', 'forget', { user: { id: 'target1' } }],
  ]) {
    const interaction = fakeInteraction({ group, subcommand, optionValues });
    await handler(interaction);
    assert.ok(interaction.replies.some((r) => r.deferred), `${group}.${subcommand}`);
    assert.equal(interaction.edits.length, 1, `${group}.${subcommand}`);
  }
});

test('buildCommandTree: the case id help names the configured command', () => {
  const [command] = buildCommandTree('bot2');
  const mentorGroup = findOption(command.options, 'mentor');
  const helps = mentorGroup.options.flatMap((sub) => (sub.options ?? []).filter((o) => o.name === 'id').map((o) => o.description));
  assert.equal(helps.length, 5);
  assert.ok(helps.every((help) => help === 'Case id from /bot2 mentor cases.'), helps.join(' | '));
});

test('interaction handler: gifs.recache replies at once, its work goes on in the background', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const recache = fakeInteraction({ group: 'gifs', subcommand: 'recache' });
  await handler(recache);
  assert.equal(admin.runCalls[0][0], 'gifs.recache');
  assert.deepEqual(admin.runCalls[0][1], {});
  assert.ok(!recache.replies.some((r) => r.deferred));
});

test('interaction handler: learned.list/add/remove map their options straight through', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'learned', subcommand: 'list' }));
  assert.equal(admin.runCalls[0][0], 'learned.list');
  assert.deepEqual(admin.runCalls[0][1], {});

  await handler(fakeInteraction({ group: 'learned', subcommand: 'add', optionValues: { text: 'ο καφές πρώτα' } }));
  assert.equal(admin.runCalls[1][0], 'learned.add');
  assert.deepEqual(admin.runCalls[1][1], { text: 'ο καφές πρώτα' });

  await handler(fakeInteraction({ group: 'learned', subcommand: 'remove', optionValues: { id: 7 } }));
  assert.equal(admin.runCalls[2][0], 'learned.remove');
  assert.deepEqual(admin.runCalls[2][1], { id: 7 });
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

test('interaction handler: private.show/private.forget map the user option to userId', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'private', subcommand: 'show', optionValues: { user: { id: 'target1' } } }));
  assert.equal(admin.runCalls[0][0], 'private.show');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1' });

  await handler(fakeInteraction({ group: 'private', subcommand: 'forget', optionValues: { user: { id: 'target1' } } }));
  assert.equal(admin.runCalls[1][0], 'private.forget');
  assert.deepEqual(admin.runCalls[1][1], { userId: 'target1' });
});

test('interaction handler: private.purge defers, maps the user option to userId and edits the reply', async () => {
  const admin = fakeAdmin({ runImpl: () => 'purged' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'private', subcommand: 'purge', optionValues: { user: { id: 'target1' } } });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'private.purge');
  assert.deepEqual(admin.runCalls[0][1], { userId: 'target1' });
  assert.equal(interaction.deferred, true);
  assert.deepEqual(interaction.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } });
  assert.equal(interaction.edits[0].content, 'purged');
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

test('interaction handler: defers then edits for every warmup subcommand (slow commands)', async () => {
  const admin = fakeAdmin({ runImpl: () => 'warmup result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const peopleInteraction = fakeInteraction({ group: 'warmup', subcommand: 'people' });
  await handler(peopleInteraction);
  assert.equal(peopleInteraction.deferred, true);
  assert.equal(peopleInteraction.edits[0].content, 'warmup result');

  const usersInteraction = fakeInteraction({ group: 'warmup', subcommand: 'users', optionValues: { user: { id: 'target1' } } });
  await handler(usersInteraction);
  assert.equal(usersInteraction.deferred, true);
  assert.equal(usersInteraction.edits[0].content, 'warmup result');

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
  assert.equal(stopInteraction.edits[0].content, 'warmup result');
});

test('interaction handler: interject maps the optional channel', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'interject', optionValues: {} });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'interject');
  assert.deepEqual(admin.runCalls[0][1], { channelId: undefined });
});

test('interaction handler: initiate maps the optional channel', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'initiate', optionValues: { channel: { id: 'c9' } } });
  await handler(interaction);

  assert.equal(admin.runCalls[0][0], 'initiate');
  assert.deepEqual(admin.runCalls[0][1], { channelId: 'c9' });
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

test('interaction handler: defers then edits for a slow command (interject)', async () => {
  const admin = fakeAdmin({ runImpl: () => 'interjected' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'interject', optionValues: {} });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.equal(interaction.replies.some((r) => r.deferred), true);
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'interjected');
});

// ---------------------------------------------------------------------------
// pause / resume
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
  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
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

  assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(interaction.replies[0].content, /Error: bad input/);
});

test('interaction handler: a thrown admin.run error is logged with the command key, even when the reply fails too', async () => {
  const admin = fakeAdmin({
    runImpl: () => {
      throw new Error('bad input');
    },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'memory', subcommand: 'server' });
  interaction.reply = async () => {
    throw new Error('Unknown interaction');
  };
  const { logs } = await withCapturedLogs(() => handler(interaction));

  const line = logs.find((l) => l.msg === 'commands: command failed');
  assert.ok(line, 'expected a command-failed log line');
  assert.equal(line.level, 'warn');
  assert.equal(line.command, 'memory.server');
  assert.equal(line.error.message, 'bad input');
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
    assert.equal(followUp.flags, MessageFlags.Ephemeral);
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

  const interaction = fakeInteraction({ kind: 'autocomplete', subcommand: 'set', focused: { name: 'path', value: 'llm.' } });
  await handler(interaction);

  assert.equal(interaction.respondCalls.length, 1);
  const choices = interaction.respondCalls[0];
  assert.ok(choices.length <= 25);
  assert.ok(choices.every((c) => c.name.toLowerCase().includes('llm.')));
  assert.ok(choices.some((c) => c.name === 'llm.model'));
});

test('autocomplete: command-option choices for /nep access grant|revoke -- every key, group and *, filtered', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    kind: 'autocomplete',
    group: 'access',
    subcommand: 'grant',
    focused: { name: 'command', value: 'mem' },
  });
  await handler(interaction);

  assert.equal(interaction.respondCalls.length, 1);
  const choices = interaction.respondCalls[0];
  assert.ok(choices.length <= 25);
  assert.ok(choices.every((c) => c.name.toLowerCase().includes('mem')));
  assert.ok(choices.some((c) => c.name === 'memory'));
  assert.ok(choices.some((c) => c.name === 'memory.show'));
});

test('autocomplete: command-option choices never offer the owner-only private commands', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  for (const [subcommand, value] of [['grant', 'priv'], ['revoke', 'priv'], ['grant', '']]) {
    const interaction = fakeInteraction({ kind: 'autocomplete', group: 'access', subcommand, focused: { name: 'command', value } });
    await handler(interaction);
    const names = interaction.respondCalls[0].map((c) => c.name);
    assert.ok(!names.some((name) => name === 'private' || name.startsWith('private.')), `${subcommand} "${value}"`);
  }
});

test('autocomplete: an allowed non-owner (granted access.* by role) gets command-key choices too', async () => {
  const admin = fakeAdmin({ owners: ['owner1'], access: { '*': { everyone: false, roles: ['staff'], users: [] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({
    kind: 'autocomplete',
    user: { id: 'helper1' },
    member: { roles: ['staff'] },
    group: 'access',
    subcommand: 'revoke',
    focused: { name: 'command', value: '' },
  });
  await handler(interaction);

  assert.ok(interaction.respondCalls[0].length > 0);
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

// ---------------------------------------------------------------------------
// commandSize: Discord's 8000-character limit for one application command
// ---------------------------------------------------------------------------

test('commandSize: sums names, descriptions, choice names and values through every level', () => {
  const command = {
    name: 'abc', // 3
    description: 'Top.', // 4
    options: [
      {
        type: 2,
        name: 'grp', // 3
        description: 'Group.', // 6
        options: [
          {
            type: 1,
            name: 'sub', // 3
            description: 'Sub.', // 4
            options: [
              {
                type: 3,
                name: 'pick', // 4
                description: 'Pick.', // 5
                choices: [{ name: 'Héllo', value: 'hé' }], // 5 + 2
                min_length: 12345, // not counted
              },
              {
                type: 4,
                name: 'num', // 3
                description: 'N.', // 2
                choices: [{ name: 'ten', value: 10 }, { name: 'neg', value: -2.5 }], // 3 + 2, 3 + 4
              },
            ],
          },
        ],
      },
      { type: 1, name: 'x', description: 'Y.' }, // 1 + 2
    ],
  };
  assert.equal(commandSize(command), 3 + 4 + 3 + 6 + 3 + 4 + 4 + 5 + 5 + 2 + 3 + 2 + 3 + 2 + 3 + 4 + 1 + 2);
});

test('commandSize: an empty or partial command counts only what it has', () => {
  assert.equal(commandSize({ name: 'nep' }), 3);
  assert.equal(commandSize({}), 0);
});

test('buildCommandTree: the whole command stays under 7600 characters (Discord refuses over 8000)', () => {
  const [command] = buildCommandTree('nep');
  const size = commandSize(command);
  assert.ok(size <= 7600, `the command tree is ${size} characters`);
  // The longest valid command name leaves the same margin.
  assert.ok(commandSize(buildCommandTree('a'.repeat(32))[0]) <= 7600 + 29);
});

test('buildCommandTree: at most 25 options and 25 choices per level, valid names, choice names 1..100', () => {
  const [command] = buildCommandTree('nep');
  const walk = (o, path) => {
    assert.ok((o.options ?? []).length <= 25, `${path}: ${(o.options ?? []).length} options`);
    assert.ok((o.choices ?? []).length <= 25, `${path}: ${(o.choices ?? []).length} choices`);
    for (const choice of o.choices ?? []) {
      assert.ok(choice.name.length >= 1 && choice.name.length <= 100, `${path}: choice ${choice.name}`);
      assert.ok(String(choice.value).length >= 1 && String(choice.value).length <= 100, `${path}: choice value ${choice.value}`);
    }
    for (const x of o.options ?? []) {
      assert.ok(isValidCommandName(x.name), `${path}/${x.name}: invalid name`);
      walk(x, `${path}/${x.name}`);
    }
  };
  walk(command, command.name);
});

// ---------------------------------------------------------------------------
// draw: an ephemeral answer with a file
// ---------------------------------------------------------------------------

test('buildCommandTree: draw takes a required text and an optional self flag', () => {
  const [command] = buildCommandTree('nep');
  const draw = findOption(command.options, 'draw');
  assert.equal(draw.type, 1); // SUBCOMMAND

  const text = findOption(draw.options, 'text');
  assert.equal(text.type, 3); // STRING
  assert.equal(text.required, true);

  const self = findOption(draw.options, 'self');
  assert.equal(self.type, 5); // BOOLEAN
  assert.equal(self.required, false);

  assert.ok(commandKeys().keys.has('draw'));
});

test('interaction handler: draw maps text and self (self false when omitted)', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a lighthouse', self: true } }));
  assert.equal(admin.runCalls[0][0], 'draw');
  assert.deepEqual(admin.runCalls[0][1], { text: 'a lighthouse', self: true });

  await handler(fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } }));
  assert.deepEqual(admin.runCalls[1][1], { text: 'a cat', self: false });
});

test('interaction handler: draw defers, then edits the reply with the text and the file', async () => {
  const attachment = Buffer.from('fake-png');
  const admin = fakeAdmin({ runImpl: () => ({ text: 'openai/x · 12.3s · cost 0.04', files: [{ attachment, name: 'image.png' }] }) });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } });
  await handler(interaction);

  assert.equal(interaction.deferred, true);
  assert.deepEqual(interaction.replies[0], { deferred: true, opts: { flags: MessageFlags.Ephemeral } });
  assert.equal(interaction.edits.length, 1);
  assert.equal(interaction.edits[0].content, 'openai/x · 12.3s · cost 0.04');
  assert.deepEqual(interaction.edits[0].files, [{ attachment, name: 'image.png' }]);
  assert.equal(interaction.followUps.length, 0);
});

test('interaction handler: an object result on a fast command replies ephemerally with its files', async () => {
  const attachment = Buffer.from('fake-png');
  const admin = fakeAdmin({ runImpl: () => ({ text: 'done', files: [{ attachment, name: 'image.png' }] }) });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.deepEqual(interaction.replies[0], { content: 'done', files: [{ attachment, name: 'image.png' }], flags: MessageFlags.Ephemeral });
});

test('interaction handler: a plain string result carries no files key', async () => {
  const admin = fakeAdmin({ runImpl: () => 'fast result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'status' });
  await handler(interaction);

  assert.deepEqual(interaction.replies[0], { content: 'fast result', flags: MessageFlags.Ephemeral });
});

test('interaction handler: a failed draw is reported as an error text with no file', async () => {
  const admin = fakeAdmin({
    runImpl: () => {
      throw new Error('draw failed (moderation, HTTP 400)');
    },
  });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ subcommand: 'draw', optionValues: { text: 'a cat' } });
  await handler(interaction);

  assert.equal(interaction.edits.length, 1);
  assert.match(interaction.edits[0].content, /Error: draw failed \(moderation, HTTP 400\)/);
  assert.equal(interaction.edits[0].files, undefined);
});

// ---------------------------------------------------------------------------
// mentor: the owner-only group that measures the persona in a sandbox
// ---------------------------------------------------------------------------

const MENTOR_SUBCOMMANDS = ['add', 'anchor', 'cases', 'remove', 'run', 'check', 'stop', 'show', 'wrong', 'status'];

test('buildCommandTree: mentor group (add/anchor/cases/remove/run/check/stop/show/wrong/status) with their options', () => {
  const [command] = buildCommandTree('nep');
  const mentor = findOption(command.options, 'mentor');
  assert.equal(mentor.type, 2); // SUBCOMMAND_GROUP
  assert.deepEqual(mentor.options.map((o) => o.name), MENTOR_SUBCOMMANDS);
  for (const sub of mentor.options) assert.equal(sub.type, 1, sub.name); // SUBCOMMAND

  // A case is a message of the persona plus the owner's comment: both required, no target any more.
  const add = findOption(mentor.options, 'add');
  assert.deepEqual(add.options.map((o) => o.name), ['message', 'text']);
  for (const option of add.options) {
    assert.equal(option.type, 3, option.name); // STRING
    assert.equal(option.required, true, option.name);
  }
  const anchor = findOption(mentor.options, 'anchor');
  assert.deepEqual(anchor.options.map((o) => o.name), ['id', 'message']);
  const message = findOption(anchor.options, 'message');
  assert.equal(message.type, 3); // STRING
  assert.equal(message.required, true);

  for (const name of ['anchor', 'remove', 'run', 'show', 'wrong']) {
    const sub = findOption(mentor.options, name);
    const id = findOption(sub.options, 'id');
    assert.equal(id.type, 4, name); // INTEGER
    assert.equal(id.required, true, name);
    assert.equal(id.min_value, 1, name);
  }
  const wrong = findOption(mentor.options, 'wrong');
  assert.deepEqual(wrong.options.map((o) => o.name), ['id', 'reason']);
  const reason = findOption(wrong.options, 'reason');
  assert.equal(reason.type, 3); // STRING
  assert.equal(reason.required, true);

  for (const name of ['cases', 'check', 'stop', 'status']) {
    assert.equal(findOption(mentor.options, name).options, undefined, name);
  }

  const { keys, groups } = commandKeys();
  assert.ok(groups.has('mentor'));
  for (const name of MENTOR_SUBCOMMANDS) assert.ok(keys.has(`mentor.${name}`), name);
  // The mentor only measures: the commands over its own changes are gone.
  for (const name of ['log', 'undo', 'rebase']) assert.equal(keys.has(`mentor.${name}`), false, name);
});

test('interaction handler: every mentor subcommand maps its options', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  const cases = [
    ['add', { message: '800000000000000004', text: 'answer a greeting briefly' }, { message: '800000000000000004', text: 'answer a greeting briefly' }],
    ['anchor', { id: 7, message: 'https://discord.com/channels/1/2/3' }, { id: 7, message: 'https://discord.com/channels/1/2/3' }],
    ['cases', {}, {}],
    ['remove', { id: 3 }, { id: 3 }],
    ['run', { id: 2 }, { id: 2 }],
    ['check', {}, {}],
    ['stop', {}, {}],
    ['show', { id: 4 }, { id: 4 }],
    ['wrong', { id: 5, reason: 'the answer was fine' }, { id: 5, reason: 'the answer was fine' }],
    ['status', {}, {}],
  ];
  for (const [i, [subcommand, optionValues, expected]] of cases.entries()) {
    await handler(fakeInteraction({ group: 'mentor', subcommand, optionValues }));
    assert.equal(admin.runCalls[i][0], `mentor.${subcommand}`);
    assert.deepEqual(admin.runCalls[i][1], expected, subcommand);
  }
});

test('interaction handler: mentor.add/anchor/run/check/show defer; the other mentor commands reply directly', async () => {
  const admin = fakeAdmin({ runImpl: () => 'mentor result' });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  const slow = new Set(['add', 'anchor', 'run', 'check', 'show']);
  for (const subcommand of MENTOR_SUBCOMMANDS) {
    const interaction = fakeInteraction({ group: 'mentor', subcommand, optionValues: { id: 1, text: 'a case text', message: '800000000000000004', reason: 'why' } });
    await handler(interaction);
    assert.equal(interaction.deferred, slow.has(subcommand), subcommand);
    if (slow.has(subcommand)) assert.equal(interaction.edits[0].content, 'mentor result', subcommand);
    else assert.deepEqual(interaction.replies[0], { content: 'mentor result', flags: MessageFlags.Ephemeral }, subcommand);
  }
});

test('interaction handler: mentor.show edits the deferred reply with the card and the report file', async () => {
  const attachment = Buffer.from('report', 'utf8');
  const admin = fakeAdmin({ runImpl: () => ({ text: 'Mentor run: case 1', files: [{ attachment, name: 'mentor-case-1-7.txt' }] }) });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  const interaction = fakeInteraction({ group: 'mentor', subcommand: 'show', optionValues: { id: 1 } });
  await handler(interaction);

  assert.equal(interaction.edits[0].content, 'Mentor run: case 1');
  assert.deepEqual(interaction.edits[0].files, [{ attachment, name: 'mentor-case-1-7.txt' }]);
});

test('interaction handler: /nep mentor stays owner-only even with a grant on it, its group or *', async () => {
  const open = { everyone: true, roles: [], users: [] };
  const access = { '*': open, mentor: open, ...Object.fromEntries(MENTOR_SUBCOMMANDS.map((name) => [`mentor.${name}`, open])) };
  const admin = fakeAdmin({ owners: ['owner1'], access });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  for (const subcommand of MENTOR_SUBCOMMANDS) {
    const interaction = fakeInteraction({ user: { id: 'helper1' }, group: 'mentor', subcommand, optionValues: { id: 1 } });
    await handler(interaction);
    assert.match(interaction.replies[0].content, /not allowed/i, subcommand);
  }
  assert.equal(admin.runCalls.length, 0);

  await handler(fakeInteraction({ group: 'mentor', subcommand: 'status' }));
  assert.equal(admin.runCalls.length, 1, 'the owner still runs it');
});

test('autocomplete: command-option choices never offer the owner-only mentor commands', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  for (const [subcommand, value] of [['grant', 'ment'], ['revoke', 'ment'], ['grant', '']]) {
    const interaction = fakeInteraction({ kind: 'autocomplete', group: 'access', subcommand, focused: { name: 'command', value } });
    await handler(interaction);
    const names = interaction.respondCalls[0].map((c) => c.name);
    assert.ok(!names.some((name) => name === 'mentor' || name.startsWith('mentor.')), `${subcommand} "${value}"`);
  }
});

// ---------------------------------------------------------------------------
// route: provider routing per model prefix and role (llm.providerByModel)
// ---------------------------------------------------------------------------

const ROUTE_ROLES = ['talk', 'analyzer', 'classifier.text', 'classifier.media', 'classifier.video', 'mentor', 'image'];

test('buildCommandTree: route group (list/set/remove) with model, providers, role and fallbacks options', () => {
  const [command] = buildCommandTree('nep');
  const route = findOption(command.options, 'route');
  assert.equal(route.type, 2); // SUBCOMMAND_GROUP
  assert.deepEqual(route.options.map((o) => o.name), ['list', 'set', 'remove']);
  assert.equal(findOption(route.options, 'list').options, undefined);

  const set = findOption(route.options, 'set');
  assert.deepEqual(set.options.map((o) => [o.name, o.type, o.required]), [
    ['model', 3, true],
    ['providers', 3, true],
    ['role', 3, false],
    ['fallbacks', 5, false],
  ]);
  assert.equal(findOption(set.options, 'model').autocomplete, true);
  assert.deepEqual(findOption(set.options, 'role').choices.map((c) => c.value), ROUTE_ROLES);

  const remove = findOption(route.options, 'remove');
  assert.deepEqual(remove.options.map((o) => [o.name, o.type, o.required]), [
    ['model', 3, true],
    ['role', 3, false],
  ]);
  assert.equal(findOption(remove.options, 'model').autocomplete, true);
  assert.deepEqual(findOption(remove.options, 'role').choices.map((c) => c.value), ROUTE_ROLES);
});

test('commandKeys: the route group and its three commands are grantable keys', () => {
  const { keys, groups } = commandKeys();
  assert.ok(groups.has('route'));
  for (const key of ['route.list', 'route.set', 'route.remove']) assert.ok(keys.has(key), key);
});

test('interaction handler: route.set/remove/list map their options; role and fallbacks undefined when omitted', async () => {
  const admin = fakeAdmin();
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });

  await handler(fakeInteraction({ group: 'route', subcommand: 'set', optionValues: { model: 'google/', providers: 'google-vertex' } }));
  await handler(fakeInteraction({
    group: 'route',
    subcommand: 'set',
    optionValues: { model: 'google/', providers: 'google-ai-studio', role: 'classifier.video', fallbacks: true },
  }));
  await handler(fakeInteraction({ group: 'route', subcommand: 'remove', optionValues: { model: 'google/', role: 'classifier.video' } }));
  await handler(fakeInteraction({ group: 'route', subcommand: 'list' }));

  assert.deepEqual(admin.runCalls.map(([key, args]) => [key, args]), [
    ['route.set', { model: 'google/', providers: 'google-vertex', role: undefined, fallbacks: undefined }],
    ['route.set', { model: 'google/', providers: 'google-ai-studio', role: 'classifier.video', fallbacks: true }],
    ['route.remove', { model: 'google/', role: 'classifier.video' }],
    ['route.list', {}],
  ]);
});

test('interaction handler: route.set is refused to a non-owner without a grant; a route.list grant opens only the list', async () => {
  const admin = fakeAdmin({ access: { 'route.list': { roles: ['r1'] } } });
  const handler = createInteractionHandler({ hot: baseHot(), admin, getGuildId: () => 'g1' });
  const member = { roles: ['r1'] };

  const set = fakeInteraction({ user: { id: 'u1' }, member, group: 'route', subcommand: 'set', optionValues: { model: 'google/', providers: 'x' } });
  await handler(set);
  const list = fakeInteraction({ user: { id: 'u1' }, member, group: 'route', subcommand: 'list' });
  await handler(list);

  assert.equal(set.replies[0].content, 'Not allowed');
  assert.deepEqual(admin.runCalls.map(([key]) => key), ['route.list']);
});

test('autocomplete: the route model option offers the route prefixes and the models in use, filtered', async () => {
  const admin = fakeAdmin();
  const hot = {
    config: {
      bot: { commandName: 'nep', owners: ['owner1'] },
      features: {},
      llm: { model: 'anthropic/claude-opus-4.6', providerByModel: { 'google/': { only: ['google-vertex'] }, 'google/@classifier.video': { only: ['google-ai-studio'] } } },
      memory: { model: null },
      classifier: { text: null, media: 'google/gemini-3.8-flash', video: 'google/gemini-3.8-flash' },
      image: { model: 'openai/gpt-image-x' },
    },
  };
  const handler = createInteractionHandler({ hot, admin, getGuildId: () => 'g1' });

  const all = fakeInteraction({ kind: 'autocomplete', group: 'route', subcommand: 'set', focused: { name: 'model', value: '' } });
  await handler(all);
  assert.deepEqual(all.respondCalls[0].map((c) => c.value), ['google/', 'anthropic/claude-opus-4.6', 'google/gemini-3.8-flash', 'openai/gpt-image-x']);

  const typed = fakeInteraction({ kind: 'autocomplete', group: 'route', subcommand: 'remove', focused: { name: 'model', value: 'GOO' } });
  await handler(typed);
  assert.deepEqual(typed.respondCalls[0].map((c) => c.value), ['google/', 'google/gemini-3.8-flash']);
});

test('buildCommandTree: variety is a top-level leaf with no options, mapped to empty args', () => {
  const [command] = buildCommandTree('nep');
  const variety = findOption(command.options, 'variety');
  assert.equal(variety.type, 1); // SUBCOMMAND
  assert.equal(variety.options, undefined);
  assert.ok(commandKeys().keys.has('variety'));
});
