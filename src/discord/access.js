// Owner-managed access grants: pure decision over `config.bot.access`, the
// shape `/nep access grant|revoke|list` (src/admin.js) read and write. An
// owner (`bot.owners`) always passes; everyone else needs a grant that
// matches the exact command key (`memory.show`), its group (`memory`), or
// `*`, in that order — any one match is enough, so precedence between the
// three never matters. A grant is `{ everyone, roles: [], users: [] }`;
// `grant`/`revoke` add or remove one thing from it immutably, and an entry
// left with nothing set is dropped entirely. Validating that a command key is
// one commands.js actually knows about is the caller's job (see
// src/discord/commands.js#commandKeys), not this module's — it only shapes
// and reads the grants it is given.

/** True when `userId` (an owner, or matched by a grant on the exact command
 * key, its group, or `*`) may run `commandKey`. Owners always pass, even with
 * no `access` at all. A missing/invalid `access` denies everyone else.
 * @param {{ commandKey: string, userId: string, roleIds?: (string|number)[],
 *   owners?: (string|number)[], access?: object }} args
 * @returns {boolean}
 */
export function isAllowed({ commandKey, userId, roleIds, owners, access }) {
  const ownerIds = (Array.isArray(owners) ? owners : []).map(String);
  if (ownerIds.includes(String(userId))) return true;

  if (!access || typeof access !== 'object') return false;

  const group = typeof commandKey === 'string' && commandKey.includes('.') ? commandKey.split('.')[0] : null;
  const candidates = [commandKey, group, '*'].filter((key) => typeof key === 'string' && key.length > 0);
  const roleSet = new Set((Array.isArray(roleIds) ? roleIds : []).map(String));

  for (const key of candidates) {
    const entry = access[key];
    if (!entry || typeof entry !== 'object') continue;
    if (entry.everyone === true) return true;
    if (Array.isArray(entry.users) && entry.users.map(String).includes(String(userId))) return true;
    if (Array.isArray(entry.roles) && entry.roles.some((roleId) => roleSet.has(String(roleId)))) return true;
  }

  return false;
}

/** True when `access` grants at least one thing (everyone, a role or a user)
 * on at least one entry — used to decide whether the command tree should be
 * visible to ordinary members at all (see commands.js#buildCommandTree). */
export function hasAnyGrant(access) {
  if (!access || typeof access !== 'object') return false;
  return Object.values(access).some(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      (entry.everyone === true ||
        (Array.isArray(entry.roles) && entry.roles.length > 0) ||
        (Array.isArray(entry.users) && entry.users.length > 0)),
  );
}

/** `access[key]`, normalized to `{ everyone, roles, users }` with fresh arrays (never the caller's own). */
function entryOf(access, key) {
  const raw = access?.[key];
  return {
    everyone: raw?.everyone === true,
    roles: Array.isArray(raw?.roles) ? [...raw.roles] : [],
    users: Array.isArray(raw?.users) ? [...raw.users] : [],
  };
}

/**
 * `access` with `key`'s grant widened by exactly one of `{ everyone: true }`,
 * `{ roleId }` or `{ userId }` — never mutates `access`. Adding a role/user
 * already present is a no-op. `key` is used as given, not validated (see the
 * module header comment).
 * @param {object} access
 * @param {string} key
 * @param {{ everyone?: boolean, roleId?: (string|number), userId?: (string|number) }} what
 * @returns {object}
 */
export function grant(access, key, { everyone, roleId, userId } = {}) {
  const next = entryOf(access, key);
  if (everyone) {
    next.everyone = true;
  } else if (roleId != null) {
    const id = String(roleId);
    if (!next.roles.includes(id)) next.roles.push(id);
  } else if (userId != null) {
    const id = String(userId);
    if (!next.users.includes(id)) next.users.push(id);
  }
  return { ...(access ?? {}), [key]: next };
}

/**
 * `access` with exactly one of `{ everyone: true }`, `{ roleId }` or
 * `{ userId }` removed from `key`'s grant — never mutates `access`. An entry
 * left with nothing set (`everyone` false, both arrays empty) is deleted
 * outright rather than kept as an empty object. Revoking something not
 * present, or from a key with no entry at all, is a no-op.
 * @param {object} access
 * @param {string} key
 * @param {{ everyone?: boolean, roleId?: (string|number), userId?: (string|number) }} what
 * @returns {object}
 */
export function revoke(access, key, { everyone, roleId, userId } = {}) {
  if (!access?.[key]) return { ...(access ?? {}) };

  const next = entryOf(access, key);
  if (everyone) {
    next.everyone = false;
  } else if (roleId != null) {
    const id = String(roleId);
    next.roles = next.roles.filter((r) => String(r) !== id);
  } else if (userId != null) {
    const id = String(userId);
    next.users = next.users.filter((u) => String(u) !== id);
  }

  const out = { ...(access ?? {}) };
  if (!next.everyone && next.roles.length === 0 && next.users.length === 0) {
    delete out[key];
  } else {
    out[key] = next;
  }
  return out;
}
