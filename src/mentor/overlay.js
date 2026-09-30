// What-if edits for the mentor. A sandbox run (src/mentor/sandbox.js) reads
// prompts, config and memory only through a `view`; this module wraps a base
// view (liveView) in one of the same shape whose reads carry edits made in
// memory -- a prompt rewritten or removed, a note about the persona dropped,
// a member's profile read differently -- so the mentor can ask "what if" and
// measure it without writing anything anywhere. Everything here is pure: the
// base view is the only source, it is read at call time and never mutated,
// and every helper returns a new edits object. The repair loop also uses it
// to show an edit before the change store writes it (`editToOverlay`).

import { removeRule as removeRuleEntry } from '../admin.js';
import { profileGuard } from './changes.js';

// Keys an edit may never set: they would reach an object's prototype.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// The profile fields a user edit may set; any other key is ignored.
const USER_FIELDS = ['character', 'style', 'relationship'];

/** A shallow copy of an edit value, so a caller's later change to the edits never leaks into a read. */
function copyValue(value) {
  return Array.isArray(value) ? [...value] : value;
}

/** `target` with each defined `[key, value]` of `patch` applied: null deletes the key, anything else replaces it. */
function applyPatch(target, patch, allowed = null) {
  if (!patch || typeof patch !== 'object') return target;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || FORBIDDEN_KEYS.has(key)) continue;
    if (allowed && !allowed.includes(key)) continue;
    if (value === null) delete target[key];
    else target[key] = copyValue(value);
  }
  return target;
}

/**
 * A view of the same shape as `liveView`'s (src/mentor/sandbox.js) whose
 * reads return the base value with `edits` applied. `config` and
 * `calibrator` pass through untouched; `prompts` is a getter returning a new
 * object on every read (the base prompts, then each `edits.prompts[name]`: a
 * string replaces, null deletes the key). `memory.getGuild()` is the base
 * guild spread with each defined key of `edits.guild` applied (null deletes
 * it, an array or a string replaces it). `memory.getUser(id)` is the base
 * profile spread with `edits.users[id]` applied -- only `character`, `style`
 * and `relationship` (a string replaces, null deletes), other keys are
 * ignored; a member the base does not know stays null. `listUserProfiles()`
 * maps through the same; `listChannels()` and `getLore()` pass through. Every
 * read goes to the base at call time, nothing is cached, and neither the base
 * nor `edits` is mutated. Pure.
 * @param {{ readonly prompts: object, readonly config: object, calibrator?: object, memory: {
 *   getGuild: () => object, getUser: (id: string) => (object|null), listUserProfiles: () => object[],
 *   listChannels: () => object[], getLore: () => object[] } }} base  From `liveView`.
 * @param {{ prompts?: { [name: string]: string|null },
 *   guild?: { self?: string[]|null, learned?: object[]|null, patterns?: string|null, starters?: string|null,
 *     injokes?: string[]|null, [key: string]: unknown },
 *   users?: { [id: string]: { character?: string|null, style?: string|null, relationship?: string|null } } }} [edits]
 * @returns {object} A view of the same shape.
 */
export function overlayView(base, edits = {}) {
  const promptEdits = edits?.prompts ?? {};
  const guildEdits = edits?.guild ?? {};
  const userEdits = edits?.users ?? {};

  // A profile with its member's edits applied; the base profile itself when there are none.
  const withUserEdits = (profile, id = profile?.id) => {
    if (!profile) return null;
    const patch = Object.hasOwn(userEdits, String(id)) ? userEdits[String(id)] : null;
    return patch ? applyPatch({ ...profile }, patch, USER_FIELDS) : profile;
  };

  return {
    get prompts() {
      const out = { ...base.prompts };
      for (const [name, value] of Object.entries(promptEdits)) {
        if (FORBIDDEN_KEYS.has(name)) continue;
        if (value === null) delete out[name];
        else if (typeof value === 'string') out[name] = value;
      }
      return out;
    },
    get config() {
      return base.config;
    },
    get calibrator() {
      return base.calibrator;
    },
    memory: {
      getGuild: () => applyPatch({ ...(base.memory.getGuild() ?? {}) }, guildEdits),
      getUser: (id) => withUserEdits(base.memory.getUser(id), id),
      listUserProfiles: () => (base.memory.listUserProfiles() ?? []).map((profile) => withUserEdits(profile)),
      listChannels: () => base.memory.listChannels(),
      getLore: () => base.memory.getLore(),
    },
  };
}

/**
 * Several edits objects merged left to right into one, so an ablation and a
 * repair can be stacked: per prompt name, per guild key and per user field,
 * a later defined value (null included) wins over an earlier one; undefined
 * values and null/undefined edits objects are skipped. The inputs are not
 * mutated. Pure.
 * @param {...object} list
 * @returns {{ prompts: object, guild: object, users: object }}
 */
export function overlayEdits(...list) {
  const merged = { prompts: {}, guild: {}, users: {} };
  const put = (target, key, value) => {
    if (value === undefined || FORBIDDEN_KEYS.has(key)) return;
    target[key] = copyValue(value);
  };
  for (const edits of list) {
    if (!edits || typeof edits !== 'object') continue;
    for (const [name, value] of Object.entries(edits.prompts ?? {})) put(merged.prompts, name, value);
    for (const [key, value] of Object.entries(edits.guild ?? {})) put(merged.guild, key, value);
    for (const [id, fields] of Object.entries(edits.users ?? {})) {
      if (!fields || typeof fields !== 'object' || FORBIDDEN_KEYS.has(id)) continue;
      const user = (merged.users[id] ??= {});
      for (const [field, value] of Object.entries(fields)) put(user, field, value);
    }
  }
  return merged;
}

/**
 * New edits whose `prompts[name]` is the prompt text with the first exact
 * occurrence of `from` replaced by `to` (literally: no replacement patterns).
 * The text edited is `edits.prompts[name]` when it already holds a string
 * (edits stack), else `baseText` -- the base view's `prompts[name]`, passed
 * in because the edits object does not carry it. `edits` is not mutated. Pure.
 * @param {object} edits
 * @param {string} baseText
 * @param {string} name
 * @param {string} from
 * @param {string} to
 * @returns {object}
 * @throws {Error} 'excerpt not found' when `from` is empty or absent from the text.
 */
export function editPrompt(edits, baseText, name, from, to) {
  const earlier = edits?.prompts?.[name];
  const text = typeof earlier === 'string' ? earlier : baseText;
  const at = typeof text === 'string' && typeof from === 'string' && from ? text.indexOf(from) : -1;
  if (at === -1) throw new Error('excerpt not found');
  const next = text.slice(0, at) + String(to ?? '') + text.slice(at + from.length);
  return { ...(edits ?? {}), prompts: { ...(edits?.prompts ?? {}), [name]: next } };
}

/**
 * The rules text without bullet `n` (1-based, in the order of the bullets
 * under the last `## ` heading; every top-level bullet when there is none).
 * The parsing and the removal are src/admin.js#removeRule's, the one `/nep
 * rule remove` uses, so the mentor removes exactly what the owner would; this
 * returns only its text and throws where it returns null. Pure.
 * @param {string} rulesText
 * @param {number} n
 * @returns {string}
 * @throws {Error} 'rule not found' when there is no bullet `n`.
 */
export function removeRule(rulesText, n) {
  const result = removeRuleEntry(rulesText, n);
  if (!result) throw new Error('rule not found');
  return result.text;
}

// ---- an edit as the change store would apply it -------------------------------
//
// These mirror src/mentor/changes.js (`plan` and its helpers): the repair loop
// verifies an edit on an overlay built here, then the change store writes the
// same edit, so both must read an edit the same way. Change one, change both.

const GUILD_STRINGS = ['patterns', 'starters'];
const PROFILE_FIELDS = ['character', 'style', 'relationship'];
// Prompts the `prompt` layer may not touch: the card is the owner's, the rules have their own layer.
const REFUSED_PROMPTS = new Set(['character-card', 'rules']);
const PROMPT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** `text` with the first exact occurrence of `from` replaced literally by `to`. */
function replaceFirst(text, from, to) {
  const at = text.indexOf(from);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** `text` with `to` appended as a new paragraph. */
function appendParagraph(text, to) {
  const head = text.replace(/\s+$/, '');
  return head ? `${head}\n\n${to.trim()}\n` : `${to.trim()}\n`;
}

/** A prompt file's text after the edit: `from` replaced, or (`allowAppend`) `to` appended for an empty `from`. */
function editedFile(text, from, to, allowAppend) {
  if (!from) return allowAppend ? { text: appendParagraph(text, to) } : { error: 'text not found' };
  return text.includes(from) ? { text: replaceFirst(text, from, to) } : { error: 'text not found' };
}

/** The guild list `key` after the edit: the item whose trimmed text is `from` rewritten to `to`, or removed. */
function editedList(list, from, to) {
  const items = Array.isArray(list) ? list.map((item) => String(item)) : [];
  const want = from.trim();
  const index = want ? items.findIndex((item) => item.trim() === want) : -1;
  if (index === -1) return { error: 'text not found' };
  const next = [...items];
  if (to.trim()) next[index] = to.trim();
  else next.splice(index, 1);
  return { list: next };
}

/** The learned list after the edit: a rewrite keeps the item (id, weight, dates), a removal drops it. */
function editedLearned(items, from, to) {
  const list = Array.isArray(items) ? items : [];
  const want = from.trim();
  const item = want ? list.find((i) => String(i?.text).trim() === want) : undefined;
  if (!item) return { error: 'text not found' };
  const text = to.trim();
  if (!text) return { list: list.filter((i) => i !== item) };
  if (list.some((i) => i !== item && i?.text === text)) return { error: 'duplicate item' };
  return { list: list.map((i) => (i === item ? { ...i, text } : i)) };
}

/** A profile field after the edit, held to `profileGuard`. */
function editedProfile(view, target, from, to) {
  const dot = typeof target === 'string' ? target.lastIndexOf('.') : -1;
  const userId = dot > 0 ? target.slice(0, dot) : '';
  const field = dot > 0 ? target.slice(dot + 1) : '';
  if (!PROFILE_FIELDS.includes(field) || !/^\d+$/.test(userId)) return { error: 'target not allowed' };
  const user = view.memory.getUser(userId);
  if (!user) return { error: 'unknown member' };
  const text = typeof user[field] === 'string' ? user[field] : '';
  if (!from || !text.includes(from)) return { error: 'text not found' };
  const after = replaceFirst(text, from, to);
  const guard = profileGuard(text, after);
  if (!guard.ok) return { error: guard.reason };
  return { edits: { users: { [userId]: { [field]: after } } } };
}

/**
 * The edits (the overlay's shape) that show `view` as if `edit` had been
 * applied by the change store (src/mentor/changes.js#apply), or `{ error }`
 * with the reason the store would refuse it for. Per layer, read from the
 * view at call time: `rules` -- the first exact occurrence of `from` in the
 * rules text replaced by `to` (`from` must be non-empty); `prompt` -- the same
 * in prompt `target` (a lowercase name, never the character card or the
 * rules), an empty `from` appends `to` as a new paragraph; `self` / an in-joke
 * (`guild`, target `injokes`) -- the item whose trimmed text equals the
 * trimmed `from` rewritten to the trimmed `to`, or removed for an empty `to`;
 * `learned` -- the same, a rewrite keeping the item's id, weight and dates;
 * `guild` `patterns` / `starters` -- `from` replaced in the string; `profile`
 * -- `from` replaced in field `character`, `style` or `relationship` of
 * member `<userId>.<field>`, held to `profileGuard`. Reasons: 'layer not
 * allowed', 'target not allowed', 'unknown prompt', 'unknown member', 'text
 * not found', 'duplicate item', or a `profileGuard` reason. The view is never
 * mutated. Pure.
 * @param {{ layer: string, target?: string, from?: string, to?: string }} edit
 * @param {object} view  From `liveView` (or an overlay of the same shape).
 * @returns {{ prompts?: object, guild?: object, users?: object }|{ error: string }}
 */
export function editToOverlay(edit, view) {
  if (!edit || typeof edit !== 'object') return { error: 'layer not allowed' };
  const from = typeof edit.from === 'string' ? edit.from : '';
  const to = typeof edit.to === 'string' ? edit.to : '';
  const guild = () => view.memory.getGuild() ?? {};
  const asGuild = (key, result) => (result.error ? result : { guild: { [key]: result.list } });
  switch (edit.layer) {
    case 'rules': {
      const text = view.prompts?.rules;
      if (typeof text !== 'string') return { error: 'unknown prompt' };
      const result = editedFile(text, from, to, false);
      return result.error ? result : { prompts: { rules: result.text } };
    }
    case 'prompt': {
      const name = edit.target;
      if (typeof name !== 'string' || !PROMPT_NAME.test(name) || REFUSED_PROMPTS.has(name)) return { error: 'target not allowed' };
      const text = view.prompts?.[name];
      if (typeof text !== 'string') return { error: 'unknown prompt' };
      const result = editedFile(text, from, to, true);
      return result.error ? result : { prompts: { [name]: result.text } };
    }
    case 'self':
      return asGuild('self', editedList(guild().self, from, to));
    case 'learned':
      return asGuild('learned', editedLearned(guild().learned, from, to));
    case 'guild': {
      if (edit.target === 'injokes') return asGuild('injokes', editedList(guild().injokes, from, to));
      if (!GUILD_STRINGS.includes(edit.target)) return { error: 'target not allowed' };
      const value = guild()[edit.target];
      const text = typeof value === 'string' ? value : '';
      if (!from || !text.includes(from)) return { error: 'text not found' };
      return { guild: { [edit.target]: replaceFirst(text, from, to) } };
    }
    case 'profile': {
      const result = editedProfile(view, edit.target, from, to);
      return result.error ? result : result.edits;
    }
    default:
      return { error: 'layer not allowed' };
  }
}

/** How many times `char` repeats at the end (`fromEnd`) or the start of `text`. */
function runOf(text, char, fromEnd) {
  let count = 0;
  if (fromEnd) {
    while (count < text.length && text[text.length - 1 - count] === char) count += 1;
  } else {
    while (count < text.length && text[count] === char) count += 1;
  }
  return count;
}

/**
 * `text` without the first exact occurrence of `excerpt`. Only the seam the
 * removal leaves is tidied: a run of spaces on both sides keeps the wider
 * side's width (two spaces become one), spaces left just before a line break
 * are dropped, and a run of line breaks on both sides keeps the wider side's
 * width (a removed paragraph leaves one blank line, a removed line none).
 * Pure.
 * @param {string} text
 * @param {string} excerpt
 * @returns {string}
 * @throws {Error} 'excerpt not found' when `excerpt` is empty or absent.
 */
export function removeExcerpt(text, excerpt) {
  const at = typeof text === 'string' && typeof excerpt === 'string' && excerpt ? text.indexOf(excerpt) : -1;
  if (at === -1) throw new Error('excerpt not found');
  let before = text.slice(0, at);
  let after = text.slice(at + excerpt.length);

  const spacesBefore = runOf(before, ' ', true);
  const spacesAfter = runOf(after, ' ', false);
  if (spacesBefore && spacesAfter) {
    after = after.slice(Math.min(spacesBefore, spacesAfter));
  } else if (spacesBefore && after.startsWith('\n')) {
    before = before.slice(0, before.length - spacesBefore);
  }

  const breaksBefore = runOf(before, '\n', true);
  const breaksAfter = runOf(after, '\n', false);
  if (breaksBefore && breaksAfter) after = after.slice(Math.min(breaksBefore, breaksAfter));

  return before + after;
}
