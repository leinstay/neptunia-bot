// Tests for src/discord/access.js: the pure owner-managed access decision
// (isAllowed) and the immutable grant/revoke helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowed, grant, revoke, hasGrant, isOwnerId, isOwnerOnly, isMemberCommand } from '../src/discord/access.js';

// ---------------------------------------------------------------------------
// isOwnerId / hasGrant
// ---------------------------------------------------------------------------

test('isOwnerId: a listed id passes as a string or a number; no user and no owners list never do', () => {
  const config = { bot: { owners: ['1', 2] } };
  assert.equal(isOwnerId(config, '1'), true);
  assert.equal(isOwnerId(config, '2'), true);
  assert.equal(isOwnerId(config, '3'), false);
  assert.equal(isOwnerId(config, undefined), false);
  assert.equal(isOwnerId({}, '1'), false);
  assert.equal(isOwnerId(undefined, '1'), false);
});

test('hasGrant: true exactly when revoke with the same arguments would change something', () => {
  const access = { status: { everyone: true, roles: ['5'], users: [7] } };
  assert.equal(hasGrant(access, 'status', { everyone: true }), true);
  assert.equal(hasGrant(access, 'status', { roleId: 5 }), true);
  assert.equal(hasGrant(access, 'status', { userId: '7' }), true);
  assert.equal(hasGrant(access, 'status', { roleId: '6' }), false);
  assert.equal(hasGrant(access, 'memory', { everyone: true }), false);
  assert.equal(hasGrant({ status: { roles: ['5'] } }, 'status', { everyone: true }), false);
  assert.equal(hasGrant(undefined, 'status', { everyone: true }), false);
});

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

// One row per case: `label` names it in a failure, `expected` is isAllowed's answer, the rest are its arguments.
const IS_ALLOWED_CASES = [
  {
    label: 'an owner always passes, even with no access at all',
    commandKey: 'memory.wipe',
    userId: '1',
    roleIds: [],
    owners: ['1'],
    access: undefined,
    expected: true,
  },
  {
    label: 'a non-owner with no matching grant is refused',
    commandKey: 'memory.show',
    userId: '2',
    roleIds: [],
    owners: ['1'],
    access: {},
    expected: false,
  },
  {
    label: 'everyone: true on the exact command key lets a non-owner through',
    commandKey: 'memory.show',
    userId: '2',
    roleIds: [],
    owners: ['1'],
    access: { 'memory.show': { everyone: true, roles: [], users: [] } },
    expected: true,
  },
  {
    label: 'a matching role id lets a non-owner through',
    commandKey: 'status',
    userId: '2',
    roleIds: ['role-a'],
    owners: ['1'],
    access: { status: { everyone: false, roles: ['role-a'], users: [] } },
    expected: true,
  },
  {
    label: 'role id compared as a string (number vs numeric string)',
    commandKey: 'status',
    userId: '2',
    roleIds: ['12345'],
    owners: ['1'],
    access: { status: { everyone: false, roles: [12345], users: [] } },
    expected: true,
  },
  {
    label: 'a non-matching role does not let a non-owner through',
    commandKey: 'status',
    userId: '2',
    roleIds: ['role-b'],
    owners: ['1'],
    access: { status: { everyone: false, roles: ['role-a'], users: [] } },
    expected: false,
  },
  {
    label: 'a matching user id lets a non-owner through',
    commandKey: 'status',
    userId: '2',
    roleIds: [],
    owners: ['1'],
    access: { status: { everyone: false, roles: [], users: ['2'] } },
    expected: true,
  },
  {
    label: 'falls back to the group key when the exact command key has no grant',
    commandKey: 'memory.show',
    userId: '2',
    roleIds: [],
    owners: ['1'],
    access: { memory: { everyone: true, roles: [], users: [] } },
    expected: true,
  },
  {
    label: 'falls back to * when neither the exact key nor the group has a grant',
    commandKey: 'memory.show',
    userId: '2',
    roleIds: [],
    owners: ['1'],
    access: { '*': { everyone: true, roles: [], users: [] } },
    expected: true,
  },
  {
    label: 'precedence does not matter -- any one of the three matching is enough',
    commandKey: 'memory.show',
    userId: '2',
    roleIds: [],
    owners: ['1'],
    access: {
      'memory.show': { everyone: false, roles: [], users: [] },
      memory: { everyone: false, roles: [], users: ['2'] },
      '*': { everyone: false, roles: [], users: [] },
    },
    expected: true,
  },
];

test('isAllowed: an owner always passes; a non-owner needs a user, role or everyone grant on the exact key, its group or *', () => {
  for (const { label, expected, ...args } of IS_ALLOWED_CASES) {
    assert.equal(isAllowed(args), expected, label);
  }
});

test('isAllowed: an invalid access shape (not an object) denies every non-owner', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const allowed = isAllowed({ commandKey: 'status', userId: '2', roleIds: [], owners: ['1'], access: bad });
    assert.equal(allowed, false, `expected access=${JSON.stringify(bad)} to deny`);
  }
});

test('isAllowed: a malformed entry (not an object) on a matching key is skipped, not thrown on', () => {
  const access = { status: 'not an object', '*': { everyone: true, roles: [], users: [] } };
  const allowed = isAllowed({ commandKey: 'status', userId: '2', roleIds: [], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isOwnerOnly: a group and every key in it, not a command that merely starts with its name', () => {
  for (const group of ['access', 'private', 'mentor']) {
    assert.equal(isOwnerOnly(group), true, group);
    assert.equal(isOwnerOnly(`${group}.show`), true, `${group}.show`);
  }
  for (const other of ['accessible', 'privateer', 'mentors', 'memory.show', '*', undefined]) {
    assert.equal(isOwnerOnly(other), false, String(other));
  }
});

// One row per owner-only group: every key in it, and the group itself, gets an everyone + role + user grant.
const OWNER_ONLY_CASES = [
  {
    label: 'private commands refuse every non-owner, whatever bot.access grants',
    group: 'private',
    keys: ['private.show', 'private.forget', 'private.purge'],
  },
  {
    label: 'the mentor group is owner-only even with a * grant',
    group: 'mentor',
    keys: ['mentor.add', 'mentor.cases', 'mentor.remove', 'mentor.run', 'mentor.check', 'mentor.stop', 'mentor.show', 'mentor.wrong', 'mentor.status'],
  },
  {
    label: 'the access group is owner-only even with a * grant',
    group: 'access',
    keys: ['access.grant', 'access.revoke', 'access.list'],
  },
];

test('isAllowed: the owner-only groups refuse every non-owner even with a * grant, the owner passes', () => {
  const everyone = { everyone: true, roles: ['staff'], users: ['2'] };
  for (const { label, group, keys } of OWNER_ONLY_CASES) {
    const access = { '*': everyone, [group]: everyone, ...Object.fromEntries(keys.map((key) => [key, everyone])) };
    for (const commandKey of [...keys, group]) {
      assert.equal(isAllowed({ commandKey, userId: '2', roleIds: ['staff'], owners: ['1'], access }), false, `${label}: ${commandKey}`);
      assert.equal(isAllowed({ commandKey, userId: '1', roleIds: [], owners: ['1'], access: {} }), true, `${label}: ${commandKey}: owner`);
    }
    // the same wildcard still opens everything else
    assert.equal(isAllowed({ commandKey: 'memory.show', userId: '2', roleIds: [], owners: ['1'], access }), true, `${label}: memory.show`);
  }
});

test('isMemberCommand: the bare pings key only, never a group, a dotted key or an owner command', () => {
  assert.equal(isMemberCommand('pings'), true);
  for (const other of ['pings.on', 'ping', 'status', 'access', '*', '', undefined, 7]) {
    assert.equal(isMemberCommand(other), false, String(other));
  }
});

test('isAllowed: a member command passes for anyone, with no owners and no access at all', () => {
  assert.equal(isAllowed({ commandKey: 'pings', userId: '2' }), true);
  assert.equal(isAllowed({ commandKey: 'pings', userId: '2', roleIds: [], owners: [], access: undefined }), true);
  assert.equal(isAllowed({ commandKey: 'pings', userId: '2', roleIds: [], owners: ['1'], access: {} }), true);
  assert.equal(isAllowed({ commandKey: 'pings', userId: '2', roleIds: [], owners: ['1'], access: {}, memberCommands: true }), true);
  // it opens nothing else
  assert.equal(isAllowed({ commandKey: 'status', userId: '2', roleIds: [], owners: ['1'], access: {} }), false);
});

test('isAllowed: memberCommands false closes a member command to everyone but an owner, a * grant included', () => {
  const open = { '*': { everyone: true, roles: [], users: [] } };
  assert.equal(isAllowed({ commandKey: 'pings', userId: '2', roleIds: [], owners: ['1'], access: {}, memberCommands: false }), false);
  assert.equal(isAllowed({ commandKey: 'pings', userId: '2', roleIds: [], owners: ['1'], access: open, memberCommands: false }), false);
  assert.equal(isAllowed({ commandKey: 'pings', userId: '1', roleIds: [], owners: ['1'], access: {}, memberCommands: false }), true);
});

// ---------------------------------------------------------------------------
// grant / revoke
// ---------------------------------------------------------------------------

const GRANT_FRESH_CASES = [
  {
    label: 'everyone on a fresh key creates the entry',
    what: { everyone: true },
    expected: { status: { everyone: true, roles: [], users: [] } },
  },
  {
    label: 'a role on a fresh key creates the entry with that role',
    what: { roleId: 'r1' },
    expected: { status: { everyone: false, roles: ['r1'], users: [] } },
  },
  {
    label: 'a user on a fresh key creates the entry with that user',
    what: { userId: 'u1' },
    expected: { status: { everyone: false, roles: [], users: ['u1'] } },
  },
];

test('grant: everyone, a role or a user on a fresh key creates the entry with just that', () => {
  for (const { label, what, expected } of GRANT_FRESH_CASES) {
    assert.deepEqual(grant({}, 'status', what), expected, label);
  }
});

test('grant: adding a role already present is a no-op, not a duplicate', () => {
  const access = { status: { everyone: false, roles: ['r1'], users: [] } };
  const result = grant(access, 'status', { roleId: 'r1' });
  assert.deepEqual(result.status.roles, ['r1']);
});

test('grant: a numeric role/user id is stored as a string', () => {
  const result = grant({}, 'status', { roleId: 12345 });
  assert.deepEqual(result.status.roles, ['12345']);
});

test('grant: does not mutate its input', () => {
  const access = { status: { everyone: false, roles: [], users: [] } };
  const snapshot = JSON.parse(JSON.stringify(access));
  grant(access, 'status', { everyone: true });
  assert.deepEqual(access, snapshot);
});

test('grant: leaves other keys untouched', () => {
  const access = { ping: { everyone: true, roles: [], users: [] } };
  const result = grant(access, 'status', { everyone: true });
  assert.deepEqual(result.ping, { everyone: true, roles: [], users: [] });
  assert.deepEqual(result.status, { everyone: true, roles: [], users: [] });
});

// `expected` is the whole entry left behind: the one thing named is gone, the rest of the entry stays.
// The first three rows leave only one kind set (roles, roles, users), so an emptiness check that ignores that
// kind deletes the entry and fails. The next three hold the other two kinds as well, so a revoke that wipes a
// neighbouring list fails. The last leaves only the flag, for an emptiness check that ignores `everyone`.
const REVOKE_ONE_CASES = [
  {
    label: 'everyone clears the flag but keeps the rest of the entry',
    entry: { everyone: true, roles: ['r1'], users: [] },
    what: { everyone: true },
    expected: { everyone: false, roles: ['r1'], users: [] },
  },
  {
    label: 'a role removes just that role',
    entry: { everyone: false, roles: ['r1', 'r2'], users: [] },
    what: { roleId: 'r1' },
    expected: { everyone: false, roles: ['r2'], users: [] },
  },
  {
    label: 'a user removes just that user',
    entry: { everyone: false, roles: [], users: ['u1', 'u2'] },
    what: { userId: 'u1' },
    expected: { everyone: false, roles: [], users: ['u2'] },
  },
  {
    label: 'everyone clears the flag but keeps the roles and users',
    entry: { everyone: true, roles: ['r1'], users: ['u9'] },
    what: { everyone: true },
    expected: { everyone: false, roles: ['r1'], users: ['u9'] },
  },
  {
    label: 'a role removes just that role, keeping the flag and the users',
    entry: { everyone: true, roles: ['r1', 'r2'], users: ['u9'] },
    what: { roleId: 'r1' },
    expected: { everyone: true, roles: ['r2'], users: ['u9'] },
  },
  {
    label: 'a user removes just that user, keeping the flag and the roles',
    entry: { everyone: true, roles: ['r9'], users: ['u1', 'u2'] },
    what: { userId: 'u1' },
    expected: { everyone: true, roles: ['r9'], users: ['u2'] },
  },
  {
    label: 'the last role goes but the everyone flag still holds the entry',
    entry: { everyone: true, roles: ['r1'], users: [] },
    what: { roleId: 'r1' },
    expected: { everyone: true, roles: [], users: [] },
  },
];

test('revoke: everyone, a role or a user removes just that one thing from the entry', () => {
  for (const { label, entry, what, expected } of REVOKE_ONE_CASES) {
    assert.deepEqual(revoke({ status: entry }, 'status', what).status, expected, label);
  }
});

test('revoke: the last thing in an entry deletes the whole entry', () => {
  const access = { status: { everyone: false, roles: ['r1'], users: [] } };
  const result = revoke(access, 'status', { roleId: 'r1' });
  assert.deepEqual(result, {});
});

test('revoke: revoking from a key with no entry at all is a no-op', () => {
  const access = { ping: { everyone: true, roles: [], users: [] } };
  const result = revoke(access, 'status', { everyone: true });
  assert.deepEqual(result, access);
});

test('revoke: revoking something not present leaves the entry as-is', () => {
  const access = { status: { everyone: false, roles: ['r1'], users: [] } };
  const result = revoke(access, 'status', { roleId: 'nope' });
  assert.deepEqual(result.status.roles, ['r1']);
});

test('revoke: does not mutate its input', () => {
  const access = { status: { everyone: true, roles: [], users: [] } };
  const snapshot = JSON.parse(JSON.stringify(access));
  revoke(access, 'status', { everyone: true });
  assert.deepEqual(access, snapshot);
});
