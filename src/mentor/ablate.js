// The mentor's what-if run, pure part. At the end of a weak run the mentor
// model names suspects: a layer and a verbatim excerpt of what the persona was
// given (src/mentor/judge.js#parseDiagnosis). A suspect is only proven by
// running the sandbox again WITHOUT that piece and measuring the gain, so this
// module locates the excerpt in the current texts of a view (src/mentor/
// sandbox.js#liveView or an overlay of the same shape) and builds the edits
// object that removes exactly that piece, plus the gain between two verdicts.
// Nothing here reads `hot` or the store, and the view is never mutated.

import { listRules, removeRule } from '../admin.js';

/** parseDiagnosis clips an excerpt to this; a longer one did not come from it. */
const MAX_EXCERPT = 300;
/** Prompts a `prompt` suspect without `ref` never touches: they have their own layers. */
const OWN_LAYER_PROMPTS = new Set(['character-card', 'rules']);
const CARD = 'character-card';
/** The profile fields a `profile` suspect may blank, in search order. */
const PROFILE_FIELDS = ['character', 'style', 'relationship'];

/** The trimmed excerpt, or null when it is not a usable one. */
function excerptOf(suspect) {
  const excerpt = typeof suspect?.excerpt === 'string' ? suspect.excerpt.trim() : '';
  return excerpt && excerpt.length <= MAX_EXCERPT ? excerpt : null;
}

/** Whether `value` is a string containing `excerpt`. */
function holds(value, excerpt) {
  return typeof value === 'string' && value.includes(excerpt);
}

/** The index of the first string item of `list` containing `excerpt` (through `pick`), or -1. */
function indexIn(list, excerpt, pick = (item) => item) {
  if (!Array.isArray(list)) return -1;
  return list.findIndex((item) => holds(pick(item), excerpt));
}

/** The guild memory of the view, or an empty object. */
function guildOf(view) {
  const guild = view?.memory?.getGuild?.();
  return guild && typeof guild === 'object' ? guild : {};
}

/** Where a named prompt holds the excerpt, or null. */
function locatePrompt(view, excerpt, suspect) {
  const prompts = view?.prompts ?? {};
  if (suspect.layer === 'card') return holds(prompts[CARD], excerpt) ? { layer: 'card', name: CARD } : null;
  if (typeof suspect.ref === 'string' && suspect.ref) {
    return holds(prompts[suspect.ref], excerpt) ? { layer: 'prompt', name: suspect.ref } : null;
  }
  for (const name of Object.keys(prompts)) {
    if (OWN_LAYER_PROMPTS.has(name)) continue;
    if (holds(prompts[name], excerpt)) return { layer: 'prompt', name };
  }
  return null;
}

/** Where a stored profile holds the excerpt, or null. */
function locateProfile(view, excerpt, suspect) {
  const memory = view?.memory;
  const profiles = typeof suspect.ref === 'string' && suspect.ref
    ? [memory?.getUser?.(suspect.ref)].filter(Boolean).map((p) => ({ ...p, id: suspect.ref }))
    : (memory?.listUserProfiles?.() ?? []);
  for (const profile of profiles) {
    if (!profile || typeof profile.id !== 'string') continue;
    const field = PROFILE_FIELDS.find((key) => holds(profile[key], excerpt));
    if (field) return { layer: 'profile', userId: profile.id, field };
  }
  return null;
}

/** Where the guild's chat habits (patterns, starters, in-jokes) hold the excerpt, or null. */
function locateGuild(view, excerpt) {
  const guild = guildOf(view);
  for (const field of ['patterns', 'starters']) {
    if (holds(guild[field], excerpt)) return { layer: 'guild', field };
  }
  const index = indexIn(guild.injokes, excerpt);
  return index === -1 ? null : { layer: 'guild', field: 'injokes', index };
}

/**
 * Where a suspect's excerpt sits in what the view gives the persona. The
 * excerpt is trimmed and matched as an exact substring; an empty one or one
 * longer than 300 characters is never located. `rules`: the rule bullet of
 * `prompts.rules` (in `listRules` order, `index` from 0); `prompt`: the prompt
 * named by `suspect.ref`, or without `ref` the first prompt (other than the
 * character card and the rules) that holds it; `card`: the character card;
 * `self` / `learned`: the item of `guild.self` / the item of `guild.learned`
 * whose `text` holds it; `guild`: `patterns`, then `starters`, then an item of
 * `injokes`; `profile`: the first of `character`, `style`, `relationship` of
 * the user `suspect.ref`, or without `ref` of the first profile of
 * `listUserProfiles()` that holds it. `missing` and any other layer: null.
 * @param {{ layer: string, excerpt?: string, ref?: string }} suspect
 * @param {{ prompts: object, memory: { getGuild: () => object, getUser: (id: string) => (object|null),
 *   listUserProfiles: () => object[] } }} view
 * @returns {{ layer: string, name?: string, index?: number, userId?: string, field?: string }|null}
 */
export function locateSuspect(suspect, view) {
  const excerpt = excerptOf(suspect);
  if (!excerpt) return null;
  switch (suspect.layer) {
    case 'rules': {
      const index = indexIn(listRules(view?.prompts?.rules), excerpt);
      return index === -1 ? null : { layer: 'rules', name: 'rules', index };
    }
    case 'prompt':
    case 'card':
      return locatePrompt(view, excerpt, suspect);
    case 'self': {
      const index = indexIn(guildOf(view).self, excerpt);
      return index === -1 ? null : { layer: 'self', index };
    }
    case 'learned': {
      const index = indexIn(guildOf(view).learned, excerpt, (item) => item?.text);
      return index === -1 ? null : { layer: 'learned', index };
    }
    case 'guild':
      return locateGuild(view, excerpt);
    case 'profile':
      return locateProfile(view, excerpt, suspect);
    default:
      return null;
  }
}

/**
 * `text` without the first occurrence of `excerpt`; the whitespace where the
 * two sides meet is tidied: a run with newlines keeps at most two of them
 * (and the indentation after the last one), a run of spaces becomes one space,
 * or none at either end of the text or before a punctuation mark.
 */
function cut(text, excerpt) {
  const at = text.indexOf(excerpt);
  const before = text.slice(0, at);
  const after = text.slice(at + excerpt.length);
  const left = before.replace(/\s+$/, '');
  const right = after.replace(/^\s+/, '');
  const seam = before.slice(left.length) + after.slice(0, after.length - right.length);
  let join;
  if (seam.includes('\n')) {
    const newlines = seam.split('\n').length - 1;
    join = '\n'.repeat(Math.min(newlines, 2)) + seam.slice(seam.lastIndexOf('\n') + 1);
  } else {
    join = seam && left && right && !/^[.,;:!?)]/.test(right) ? ' ' : '';
  }
  return left + join + right;
}

/**
 * The edits (the overlay's shape: `{ prompts?, guild?, users? }`) that remove
 * the piece `locateSuspect` finds, or null when nothing is located. `rules`:
 * the rule removed (`removeRule`), `{ prompts: { rules } }`; `prompt` / `card`:
 * the first occurrence of the excerpt cut from that prompt (see `cut`),
 * `{ prompts: { [name]: text } }`; `self` / `learned` / an in-joke: the array
 * without that item, `{ guild: { [field]: array } }`; `patterns` / `starters`:
 * the excerpt cut from the string; `profile`: `{ users: { [id]: { [field]: '' } } }`.
 * The view is read, never mutated.
 * @param {{ layer: string, excerpt?: string, ref?: string }} suspect  A cause of `parseDiagnosis`.
 * @param {object} view  See `locateSuspect`.
 * @returns {{ prompts?: object, guild?: object, users?: object }|null}
 */
export function ablationEdits(suspect, view) {
  const where = locateSuspect(suspect, view);
  if (!where) return null;
  const excerpt = excerptOf(suspect);
  const without = (list, index) => list.filter((_, i) => i !== index);
  switch (where.layer) {
    case 'rules': {
      const result = removeRule(view.prompts.rules, where.index + 1);
      return result ? { prompts: { rules: result.text } } : null;
    }
    case 'prompt':
    case 'card':
      return { prompts: { [where.name]: cut(view.prompts[where.name], excerpt) } };
    case 'self':
    case 'learned':
      return { guild: { [where.layer]: without(guildOf(view)[where.layer], where.index) } };
    case 'guild': {
      const value = guildOf(view)[where.field];
      return { guild: { [where.field]: Array.isArray(value) ? without(value, where.index) : cut(value, excerpt) } };
    }
    case 'profile':
      return { users: { [where.userId]: { [where.field]: '' } } };
    default:
      return null;
  }
}

/**
 * How much a what-if run moved the overall median: `after.medians.overall -
 * before.medians.overall`, rounded to one decimal.
 * @param {{ medians: { overall: number|null } }|null} before  A `verdict` result.
 * @param {{ medians: { overall: number|null } }|null} after   A `verdict` result.
 * @returns {number|null}  null when either result or its overall median is missing or not a number.
 */
export function gainOf(before, after) {
  const a = before?.medians?.overall;
  const b = after?.medians?.overall;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) * 10) / 10 + 0;
}
