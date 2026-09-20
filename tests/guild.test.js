import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGuild } from '../src/discord/guild.js';

test('resolveGuild: configured id present among the bot\'s guilds resolves to it', () => {
  const guilds = [{ id: 'g1', name: 'Alpha' }, { id: 'g2', name: 'Beta' }];
  assert.deepEqual(resolveGuild('g2', guilds), { guildId: 'g2' });
});

test('resolveGuild: configured id not among the bot\'s guilds is an error naming it and listing what it is in', () => {
  const guilds = [{ id: 'g1', name: 'Alpha' }, { id: 'g2', name: 'Beta' }];
  const result = resolveGuild('g3', guilds);
  assert.ok(result.error);
  assert.match(result.error, /g3/);
  assert.match(result.error, /Alpha \(g1\)/);
  assert.match(result.error, /Beta \(g2\)/);
});

test('resolveGuild: configured id not found and the bot is in no guild at all still names the configured id', () => {
  const result = resolveGuild('g3', []);
  assert.ok(result.error);
  assert.match(result.error, /g3/);
});

test('resolveGuild: no configured id and exactly one guild resolves to it without an error', () => {
  const guilds = [{ id: 'g1', name: 'Alpha' }];
  assert.deepEqual(resolveGuild('', guilds), { guildId: 'g1' });
});

test('resolveGuild: no configured id and zero guilds is an error telling to invite the bot', () => {
  const result = resolveGuild('', []);
  assert.ok(result.error);
  assert.match(result.error, /invite/i);
});

test('resolveGuild: no configured id and several guilds is an error listing them and naming bot.guildId', () => {
  const guilds = [{ id: 'g1', name: 'Alpha' }, { id: 'g2', name: 'Beta' }];
  const result = resolveGuild('', guilds);
  assert.ok(result.error);
  assert.match(result.error, /Alpha \(g1\)/);
  assert.match(result.error, /Beta \(g2\)/);
  assert.match(result.error, /bot\.guildId/);
});

test('resolveGuild: undefined configured id behaves the same as an empty string', () => {
  const guilds = [{ id: 'g1', name: 'Alpha' }];
  assert.deepEqual(resolveGuild(undefined, guilds), { guildId: 'g1' });
});

test('resolveGuild: undefined guilds list behaves as an empty one', () => {
  const result = resolveGuild('', undefined);
  assert.ok(result.error);
  assert.match(result.error, /invite/i);
});
