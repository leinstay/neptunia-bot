// Tests for src/discord/access.js: the pure owner-managed access decision
// (isAllowed, hasAnyGrant) and the immutable grant/revoke helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowed, hasAnyGrant, grant, revoke } from '../src/discord/access.js';

// ---------------------------------------------------------------------------
// isAllowed
// ---------------------------------------------------------------------------

test('isAllowed: an owner always passes, even with no access at all', () => {
  const allowed = isAllowed({ commandKey: 'memory.wipe', userId: '1', roleIds: [], owners: ['1'], access: undefined });
  assert.equal(allowed, true);
});

test('isAllowed: owner id compared as a string against a numeric owners list', () => {
  const allowed = isAllowed({ commandKey: 'status', userId: '1', roleIds: [], owners: [1], access: {} });
  assert.equal(allowed, true);
});

test('isAllowed: a non-owner with no matching grant is refused', () => {
  const allowed = isAllowed({ commandKey: 'memory.show', userId: '2', roleIds: [], owners: ['1'], access: {} });
  assert.equal(allowed, false);
});

test('isAllowed: everyone: true on the exact command key lets a non-owner through', () => {
  const access = { 'memory.show': { everyone: true, roles: [], users: [] } };
  const allowed = isAllowed({ commandKey: 'memory.show', userId: '2', roleIds: [], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isAllowed: a matching role id lets a non-owner through', () => {
  const access = { status: { everyone: false, roles: ['role-a'], users: [] } };
  const allowed = isAllowed({ commandKey: 'status', userId: '2', roleIds: ['role-a'], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isAllowed: role id compared as a string (number vs numeric string)', () => {
  const access = { status: { everyone: false, roles: [12345], users: [] } };
  const allowed = isAllowed({ commandKey: 'status', userId: '2', roleIds: ['12345'], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isAllowed: a non-matching role does not let a non-owner through', () => {
  const access = { status: { everyone: false, roles: ['role-a'], users: [] } };
  const allowed = isAllowed({ commandKey: 'status', userId: '2', roleIds: ['role-b'], owners: ['1'], access });
  assert.equal(allowed, false);
});

test('isAllowed: a matching user id lets a non-owner through', () => {
  const access = { status: { everyone: false, roles: [], users: ['2'] } };
  const allowed = isAllowed({ commandKey: 'status', userId: '2', roleIds: [], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isAllowed: user id compared as a string (number vs numeric string)', () => {
  const access = { status: { everyone: false, roles: [], users: [999] } };
  const allowed = isAllowed({ commandKey: 'status', userId: '999', roleIds: [], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isAllowed: falls back to the group key when the exact command key has no grant', () => {
  const access = { memory: { everyone: true, roles: [], users: [] } };
  const allowed = isAllowed({ commandKey: 'memory.show', userId: '2', roleIds: [], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isAllowed: falls back to * when neither the exact key nor the group has a grant', () => {
  const access = { '*': { everyone: true, roles: [], users: [] } };
  const allowed = isAllowed({ commandKey: 'memory.show', userId: '2', roleIds: [], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isAllowed: a bare top-level command key (no group) is looked up directly, never split', () => {
  const access = { status: { everyone: true, roles: [], users: [] } };
  const allowed = isAllowed({ commandKey: 'status', userId: '2', roleIds: [], owners: ['1'], access });
  assert.equal(allowed, true);
});

test('isAllowed: precedence does not matter -- any one of the three matching is enough', () => {
  const access = {
    'memory.show': { everyone: false, roles: [], users: [] },
    memory: { everyone: false, roles: [], users: ['2'] },
    '*': { everyone: false, roles: [], users: [] },
  };
  const allowed = isAllowed({ commandKey: 'memory.show', userId: '2', roleIds: [], owners: ['1'], access });
  assert.equal(allowed, true);
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

// ---------------------------------------------------------------------------
// hasAnyGrant
// ---------------------------------------------------------------------------

test('hasAnyGrant: false for an empty, missing or invalid access', () => {
  assert.equal(hasAnyGrant({}), false);
  assert.equal(hasAnyGrant(undefined), false);
  assert.equal(hasAnyGrant(null), false);
  assert.equal(hasAnyGrant('nope'), false);
});

test('hasAnyGrant: false when every entry is empty', () => {
  const access = { status: { everyone: false, roles: [], users: [] } };
  assert.equal(hasAnyGrant(access), false);
});

test('hasAnyGrant: true with an everyone grant', () => {
  assert.equal(hasAnyGrant({ status: { everyone: true, roles: [], users: [] } }), true);
});

test('hasAnyGrant: true with a role grant', () => {
  assert.equal(hasAnyGrant({ status: { everyone: false, roles: ['r1'], users: [] } }), true);
});

test('hasAnyGrant: true with a user grant', () => {
  assert.equal(hasAnyGrant({ status: { everyone: false, roles: [], users: ['u1'] } }), true);
});

// ---------------------------------------------------------------------------
// grant / revoke
// ---------------------------------------------------------------------------

test('grant: everyone on a fresh key creates the entry', () => {
  const result = grant({}, 'status', { everyone: true });
  assert.deepEqual(result, { status: { everyone: true, roles: [], users: [] } });
});

test('grant: a role on a fresh key creates the entry with that role', () => {
  const result = grant({}, 'status', { roleId: 'r1' });
  assert.deepEqual(result, { status: { everyone: false, roles: ['r1'], users: [] } });
});

test('grant: a user on a fresh key creates the entry with that user', () => {
  const result = grant({}, 'status', { userId: 'u1' });
  assert.deepEqual(result, { status: { everyone: false, roles: [], users: ['u1'] } });
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

test('revoke: everyone clears the flag but keeps the rest of the entry', () => {
  const access = { status: { everyone: true, roles: ['r1'], users: [] } };
  const result = revoke(access, 'status', { everyone: true });
  assert.deepEqual(result.status, { everyone: false, roles: ['r1'], users: [] });
});

test('revoke: a role removes just that role', () => {
  const access = { status: { everyone: false, roles: ['r1', 'r2'], users: [] } };
  const result = revoke(access, 'status', { roleId: 'r1' });
  assert.deepEqual(result.status.roles, ['r2']);
});

test('revoke: a user removes just that user', () => {
  const access = { status: { everyone: false, roles: [], users: ['u1', 'u2'] } };
  const result = revoke(access, 'status', { userId: 'u1' });
  assert.deepEqual(result.status.users, ['u2']);
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

test('grant/revoke round trip: grant then revoke the same thing returns to empty', () => {
  let access = {};
  access = grant(access, 'memory', { roleId: 'r1' });
  access = revoke(access, 'memory', { roleId: 'r1' });
  assert.deepEqual(access, {});
});
