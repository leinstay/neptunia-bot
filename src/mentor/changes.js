// The mentor's hands: it writes the edits the mentor decided on into the
// private layer and remembers each one, so the owner can see and undo it.
// An edit rewrites a rule in the local rules file, a local copy of an engine
// prompt (created from the tracked file on first use), a note in the guild's
// memory or a field of a member's profile. Nothing here decides what to
// change; it applies the edit it is given, or refuses it with a reason.
//
//   data/guilds/<guildId>/mentor/changes.json                  { nextId, changes: [...] }
//   data/guilds/<guildId>/mentor/changes/<id>/before.json      the piece before the change
//   data/guilds/<guildId>/mentor/changes/<id>/after.json       the piece after it
//   data/guilds/<guildId>/mentor/overrides.json                { [prompt]: { baseHash, writtenHash, patches: [{ changeId, from, to }] } }
//
// A "piece" is the whole thing an edit touched: a prompt file's text, one
// list item's text (null when absent), one string field. Undo restores the
// piece only while it still equals what the change left, so nothing written
// since is ever overwritten. A local prompt override remembers the sha256 of
// the tracked file it was copied from, the sha256 of the file as the mentor
// last wrote it and the patches made to it; after a deploy changes the
// tracked file, `rebase` rebuilds the override from the new tracked text and
// re-applies the patches that still fit, unless someone edited it by hand.
//
// The records come before the piece: `apply` and `undo` store the change
// (marked `pending`) before they write, and clear the mark after, so a write
// that fails half way is never a change nobody knows about.
//
// Tracked prompts are only ever read. Prompt files are written atomically
// (temp file in the same directory, then a rename) so the live reloader never
// sees half a file. Memory goes through the memory store only, never its
// files. Like src/mentor/cases.js there is no cache, a missing file is empty
// and a broken one throws; refusals are results, not errors.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendRule } from '../admin.js';
import { writeJsonAtomic } from '../memory/store.js';
import { normalizeTopic } from '../memory/interests.js';

const GUILD_STRINGS = ['patterns', 'starters'];
const GUILD_TARGETS = [...GUILD_STRINGS, 'injokes'];
const PROFILE_FIELDS = ['character', 'style', 'relationship'];
// Prompts the `prompt` layer may not touch: the card is the owner's, the rules have their own layer.
const REFUSED_PROMPTS = new Set(['character-card', 'rules']);
const PROMPT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SUMMARY_CLIP = 60;

const refuse = (reason) => ({ ok: false, reason });

/**
 * Parse a JSON file; `fallback` when the file cannot be read (missing), an
 * Error naming the file when it exists but does not parse or has the wrong shape.
 */
function readJsonStrict(file, fallback, isValid) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`broken JSON in ${file}`);
  }
  if (!isValid(value)) throw new Error(`unexpected content in ${file}`);
  return value;
}

/** Raw text of a file, or null when it does not exist. */
function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Text as edits see it: no BOM, LF line ends. */
function normalizeText(raw) {
  return raw === null ? null : raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Length in characters (code points), as the memory store counts them. */
function length(text) {
  return [...String(text ?? '')].length;
}

/**
 * The text an edit of a prompt file starts from, read the way src/hot.js
 * reads the two layers: the local file when it holds anything but
 * whitespace, else the tracked file (a blank local file counts as absent).
 * Both are read as edits see them: no BOM, LF line ends. The one rule for
 * both the change store and the repair loop's what-if view
 * (src/mentor/overlay.js#editToOverlay), so the text verified and the text
 * written start from the same string. Pure.
 * @param {string|null} localRaw    The local file's raw text, null when it does not exist.
 * @param {string|null} trackedRaw  The tracked file's raw text, null when it does not exist.
 * @returns {{ text: string, source: 'local'|'tracked', exists: boolean }|null}  `exists`: whether a
 *   local file exists at all (blank or not); null when neither layer gives a text.
 */
export function promptStartText(localRaw, trackedRaw) {
  const exists = typeof localRaw === 'string';
  const local = exists ? normalizeText(localRaw) : null;
  if (local !== null && local.trim()) return { text: local, source: 'local', exists };
  if (typeof trackedRaw !== 'string') return null;
  return { text: normalizeText(trackedRaw), source: 'tracked', exists };
}

/** Write `text` through a temp file in the same directory and a rename; creates the directory. */
function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse to rename over a file an antivirus holds open.
    fs.writeFileSync(file, text);
    fs.rmSync(tmp, { force: true });
  }
}

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

/** One line, at most SUMMARY_CLIP characters, for the operator's summary. */
function clip(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return '(empty)';
  return line.length > SUMMARY_CLIP ? `${line.slice(0, SUMMARY_CLIP - 3)}...` : line;
}

/** Every token of `text` matching `re` (global), in order. */
function tokens(text, re) {
  return String(text ?? '').match(re) ?? [];
}

function sameMultiset(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function sameSet(a, b) {
  return sameMultiset([...new Set(a)], [...new Set(b)]);
}

/**
 * Whether rewriting a profile field from `before` to `after` keeps its facts:
 * refuses an emptied field, a changed multiset of numbers, a changed set of
 * `<@id>` tokens, a changed set of dates, or a capitalised word of `before`
 * (a name, most often) missing from `after`; a new capitalised word is
 * allowed. Pure.
 * @param {string} before
 * @param {string} after
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function profileGuard(before, after) {
  const was = typeof before === 'string' ? before : '';
  const now = typeof after === 'string' ? after : '';
  if (!now.trim()) return refuse('field emptied');
  const mention = /<@\d+>/g;
  if (!sameSet(tokens(was, mention), tokens(now, mention))) return refuse('mentions changed');
  const date = /\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4}/g;
  if (!sameSet(tokens(was, date), tokens(now, date))) return refuse('dates changed');
  if (!sameMultiset(tokens(was, /\d+/g), tokens(now, /\d+/g))) return refuse('numbers changed');
  const name = /(?<!\p{L})\p{Lu}\p{L}+/gu;
  const kept = new Set(tokens(now, name));
  if (tokens(was, name).some((word) => !kept.has(word))) return refuse('names changed');
  return { ok: true };
}

/**
 * The mentor's change store over one data directory and the two prompt layers.
 * @param {{ dataDir: string, promptsDir: string, localPromptsDir: string,
 *   store: { getGuild: Function, updateGuild: Function, applyLearnedOps: Function, rewriteLearned: Function, getUser: Function, updateUser: Function },
 *   getConfig: () => { memory?: object }, now?: () => number }} opts
 *   `promptsDir` is only ever read; `localPromptsDir` is created when missing.
 *   `getConfig` is read at the moment of use (the learned-list limits and
 *   `memory.fieldChars`, default 400: a profile field may hold that many
 *   characters, a guild string twice as many).
 */
export function createChangeStore({ dataDir, promptsDir, localPromptsDir, store, getConfig, now = Date.now }) {
  const mentorDir = (guildId) => path.join(dataDir, 'guilds', String(guildId), 'mentor');
  const changesFile = (guildId) => path.join(mentorDir(guildId), 'changes.json');
  const overridesFile = (guildId) => path.join(mentorDir(guildId), 'overrides.json');
  const pieceFile = (guildId, id, which) => path.join(mentorDir(guildId), 'changes', String(id), `${which}.json`);
  const trackedFile = (name) => path.join(promptsDir, `${name}.md`);
  const localFile = (name) => path.join(localPromptsDir, `${name}.md`);

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function readChanges(guildId) {
    return readJsonStrict(
      changesFile(guildId),
      { nextId: 1, changes: [] },
      (v) => isObject(v) && Number.isInteger(v.nextId) && Array.isArray(v.changes),
    );
  }

  function readOverrides(guildId) {
    return readJsonStrict(overridesFile(guildId), {}, isObject);
  }

  function readPiece(guildId, id, which) {
    return readJsonStrict(pieceFile(guildId, id, which), null, () => true);
  }

  function learnedOpts() {
    return { ...(getConfig?.()?.memory ?? {}), seenAt: now() };
  }

  /** `memory.fieldChars` now, else the config.json default. */
  function fieldChars() {
    const value = getConfig?.()?.memory?.fieldChars;
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 400;
  }

  /** The guild's list stored under `key` as trimmed strings (a copy). */
  function guildList(guildId, key) {
    const list = store.getGuild(guildId)?.[key];
    return Array.isArray(list) ? list.map((item) => String(item)) : [];
  }

  // ---- prompt files (rules and prompt layers) ----

  /** Both layers of one prompt, raw; nulls for a name that is not a safe prompt name or is the card. */
  function promptLayers(name) {
    if (typeof name !== 'string' || !PROMPT_NAME.test(name) || name === 'character-card') return { local: null, tracked: null };
    return { local: readRaw(localFile(name)), tracked: readRaw(trackedFile(name)) };
  }

  // ---- apply per layer: each returns a refusal or { target, before, after, write, extra } ----

  /**
   * A local prompt file edit, from the text `promptStartText` gives. A file
   * started from the tracked text is `created`; when a blank local file was
   * there, it is `blank` and its bytes are the piece before (undo writes them back).
   */
  function planFile(name, edit, { append }) {
    const layers = promptLayers(name);
    const start = promptStartText(layers.local, layers.tracked);
    if (!start) return refuse('unknown prompt');
    const { from, to } = edit;
    let after;
    if (!from) {
      if (!append || !to.trim()) return refuse('text not found');
      after = append(start.text, to);
    } else {
      if (!start.text.includes(from)) return refuse('text not found');
      after = replaceFirst(start.text, from, to);
    }
    const created = start.source === 'tracked';
    const blank = created && start.exists;
    return {
      before: blank ? layers.local : start.text,
      after,
      created,
      blank,
      trackedRaw: created ? layers.tracked : null,
      write: () => writeTextAtomic(localFile(name), after),
    };
  }

  function planListItem(guildId, key, edit) {
    const list = guildList(guildId, key);
    const want = edit.from.trim();
    const index = want ? list.findIndex((item) => item.trim() === want) : -1;
    if (index === -1) return refuse('text not found');
    const to = edit.to.trim();
    const next = [...list];
    if (to) next[index] = to;
    else next.splice(index, 1);
    return {
      before: list[index],
      after: to || null,
      extra: { index },
      write: () => store.updateGuild(guildId, { [key]: next }),
    };
  }

  /** `patterns` / `starters`: rewritten, never emptied, at most twice `memory.fieldChars` long. */
  function planGuildString(guildId, key, edit) {
    const value = store.getGuild(guildId)?.[key];
    const text = typeof value === 'string' ? value : '';
    if (!edit.from || !text.includes(edit.from)) return refuse('text not found');
    if (!edit.to.trim()) return refuse('deletion not allowed');
    const after = replaceFirst(text, edit.from, edit.to);
    if (length(after) > fieldChars() * 2) return refuse('text too long');
    return { before: text, after, write: () => store.updateGuild(guildId, { [key]: after }) };
  }

  /**
   * A learned item: a rewrite changes its text in place (it keeps its id,
   * weight and dates, so it stays as sure as it was); a removal goes through
   * `applyLearnedOps` and remembers the teacher, so an undo can add it back.
   */
  function planLearned(guildId, edit) {
    const items = store.getGuild(guildId)?.learned ?? [];
    const want = edit.from.trim();
    const item = want ? items.find((i) => String(i.text).trim() === want) : undefined;
    if (!item) return refuse('text not found');
    const to = edit.to.trim();
    if (to) {
      if (items.some((i) => i !== item && i.text === to)) return refuse('duplicate item');
      return {
        before: item.text,
        after: to,
        extra: { itemId: item.id },
        write: () => store.rewriteLearned(guildId, item.id, to),
      };
    }
    const teacher = typeof item.from === 'string' && item.from ? item.from : null;
    return {
      before: item.text,
      after: null,
      extra: { itemId: item.id, teacher },
      write: () => store.applyLearnedOps(guildId, { remove: [item.id] }, learnedOpts()),
    };
  }

  function planProfile(guildId, target, edit) {
    const dot = typeof target === 'string' ? target.lastIndexOf('.') : -1;
    const userId = dot > 0 ? target.slice(0, dot) : '';
    const field = dot > 0 ? target.slice(dot + 1) : '';
    if (!PROFILE_FIELDS.includes(field) || !/^\d+$/.test(userId)) return refuse('target not allowed');
    const user = store.getUser(guildId, userId);
    if (!user) return refuse('unknown member');
    const text = typeof user[field] === 'string' ? user[field] : '';
    if (!edit.from || !text.includes(edit.from)) return refuse('text not found');
    const after = replaceFirst(text, edit.from, edit.to);
    const guard = profileGuard(text, after);
    if (!guard.ok) return guard;
    if (length(after) > fieldChars()) return refuse('text too long');
    return { target: `${userId}.${field}`, before: text, after, write: () => store.updateUser(guildId, userId, { [field]: after }) };
  }

  /** A plan for `edit`, or a refusal. Reads the current piece; writes nothing. */
  function plan(guildId, edit) {
    const layer = edit.layer;
    switch (layer) {
      case 'rules': {
        // An addition is a new rule, added as `/nep rule add` adds one.
        const p = planFile('rules', edit, { append: appendRule });
        return p.ok === false ? p : { target: 'rules', ...p };
      }
      case 'prompt': {
        const name = edit.target;
        if (typeof name !== 'string' || !PROMPT_NAME.test(name) || REFUSED_PROMPTS.has(name)) return refuse('target not allowed');
        const p = planFile(name, edit, { append: appendParagraph });
        return p.ok === false ? p : { target: name, ...p };
      }
      case 'self': {
        const p = planListItem(guildId, 'self', edit);
        return p.ok === false ? p : { target: null, ...p };
      }
      case 'learned': {
        const p = planLearned(guildId, edit);
        if (p.ok === false) return p;
        p.target = null;
        return p;
      }
      case 'guild': {
        if (!GUILD_TARGETS.includes(edit.target)) return refuse('target not allowed');
        const p = edit.target === 'injokes' ? planListItem(guildId, 'injokes', edit) : planGuildString(guildId, edit.target, edit);
        return p.ok === false ? p : { target: edit.target, ...p };
      }
      case 'profile':
        return planProfile(guildId, edit.target, edit);
      default:
        return refuse('layer not allowed');
    }
  }

  // ---- undo per layer: the current piece, and how to put `before` back ----

  function undoFile(name, change, before, after) {
    const file = localFile(name);
    if (normalizeText(readRaw(file)) !== after) return refuse('changed since');
    // A file the change created is removed again, so the tracked text takes over as before;
    // a blank file that was there gets its bytes back (the tracked text is live again either way).
    return {
      write: () => {
        if (change.created && !change.blank) fs.rmSync(file, { force: true });
        else writeTextAtomic(file, before);
      },
    };
  }

  function undoListItem(guildId, key, change, before, after) {
    const list = guildList(guildId, key);
    const next = [...list];
    if (after !== null) {
      const index = list.findIndex((item) => item.trim() === after);
      if (index === -1) return refuse('changed since');
      next[index] = before;
    } else {
      if (list.some((item) => item.trim() === String(before).trim())) return refuse('changed since');
      next.splice(Math.min(Number(change.index) || 0, next.length), 0, before);
    }
    return { write: () => store.updateGuild(guildId, { [key]: next }) };
  }

  /**
   * A rewrite goes back in place on the same item. A removal is undone by
   * adding the text again (with its teacher): the item cannot get its old id
   * back, so the change is marked `readded`.
   */
  function undoLearned(guildId, change, before, after) {
    const items = store.getGuild(guildId)?.learned ?? [];
    if (after !== null) {
      const item = items.find((i) => i.id === change.itemId);
      if (!item || item.text !== after) return refuse('changed since');
      if (items.some((i) => i !== item && i.text === before)) return refuse('duplicate item');
      return { write: () => store.rewriteLearned(guildId, item.id, before) };
    }
    // An item with the same identity would absorb the add as a sighting instead of coming back.
    if (items.some((i) => normalizeTopic(i.text) === normalizeTopic(before))) return refuse('changed since');
    const add = change.teacher ? { text: before, from: change.teacher, sure: true } : { text: before, sure: true };
    return {
      mark: { readded: true },
      write: () => store.applyLearnedOps(guildId, { add: [add] }, learnedOpts()),
    };
  }

  function undoString(read, write, before, after) {
    if (read() !== after) return refuse('changed since');
    return { write: () => write(before) };
  }

  function undoPlan(guildId, change, before, after) {
    switch (change.layer) {
      case 'rules':
        return undoFile('rules', change, before, after);
      case 'prompt':
        return undoFile(change.target, change, before, after);
      case 'self':
        return undoListItem(guildId, 'self', change, before, after);
      case 'learned':
        return undoLearned(guildId, change, before, after);
      case 'guild':
        if (change.target === 'injokes') return undoListItem(guildId, 'injokes', change, before, after);
        return undoString(
          () => {
            const value = store.getGuild(guildId)?.[change.target];
            return typeof value === 'string' ? value : '';
          },
          (text) => store.updateGuild(guildId, { [change.target]: text }),
          before,
          after,
        );
      case 'profile': {
        const dot = change.target.lastIndexOf('.');
        const userId = change.target.slice(0, dot);
        const field = change.target.slice(dot + 1);
        return undoString(
          () => {
            const value = store.getUser(guildId, userId)?.[field];
            return typeof value === 'string' ? value : '';
          },
          (text) => store.updateUser(guildId, userId, { [field]: text }),
          before,
          after,
        );
      }
      default:
        return refuse('layer not allowed');
    }
  }

  /**
   * Whether the piece a change touched is as it was before the change: for a
   * record left `pending` by a write that did not finish, this is how undo
   * tells a write that never happened (or an undo that did) from one that did.
   */
  function pieceIsBefore(guildId, change, before, after) {
    const current = (read) => {
      const value = read();
      return typeof value === 'string' ? value : '';
    };
    switch (change.layer) {
      case 'rules':
      case 'prompt': {
        const raw = readRaw(localFile(change.layer === 'rules' ? 'rules' : change.target));
        if (change.blank) return raw === before;
        if (change.created) return raw === null;
        return normalizeText(raw) === before;
      }
      case 'self':
      case 'guild': {
        if (change.layer === 'guild' && change.target !== 'injokes') return current(() => store.getGuild(guildId)?.[change.target]) === before;
        const list = guildList(guildId, change.layer === 'self' ? 'self' : 'injokes');
        const has = (text) => list.some((item) => item.trim() === String(text).trim());
        return has(before) && (after === null || !has(after));
      }
      case 'learned': {
        const items = store.getGuild(guildId)?.learned ?? [];
        if (after === null) return items.some((i) => normalizeTopic(i.text) === normalizeTopic(before));
        return items.some((i) => i.id === change.itemId && i.text === before);
      }
      case 'profile': {
        const dot = change.target.lastIndexOf('.');
        return current(() => store.getUser(guildId, change.target.slice(0, dot))?.[change.target.slice(dot + 1)]) === before;
      }
      default:
        return false;
    }
  }

  /** The sha256 of a local prompt file as it is now, or null when it does not exist. */
  function localHash(name) {
    const raw = readRaw(localFile(name));
    return raw === null ? null : sha256(raw);
  }

  /** Whether a local override differs from what the mentor last wrote (an override without `writtenHash` always does). */
  function handEdited(name, entry) {
    return typeof entry?.writtenHash !== 'string' || localHash(name) !== entry.writtenHash;
  }

  return {
    /**
     * Both layers of one prompt as they are on disk now, raw: what
     * `promptStartText` takes. The repair loop hands this to
     * src/mentor/overlay.js#editToOverlay, so the text it verifies starts
     * from the same files `apply` writes. A name that is not a safe prompt
     * name, or the character card, reads as `{ local: null, tracked: null }`.
     * @param {string} name  A prompt name without `.md`.
     * @returns {{ local: string|null, tracked: string|null }}
     */
    promptLayers(name) {
      return promptLayers(name);
    },

    /**
     * Apply one edit to the private layer and record it. Reads the current
     * piece and refuses when `from` is not in it (and, for `patterns` /
     * `starters`, an emptied string or one over twice `memory.fieldChars`, for
     * a profile field one over `memory.fieldChars`). Then the records come
     * first: the pieces before and after and the change, marked `pending`;
     * then the piece is written; then the mark is cleared and the prompt
     * override (with the `writtenHash` of the file written) is stored. A
     * write that throws propagates and leaves the record `pending`. An empty
     * `from` appends: a new rule on the `rules` layer (as `/nep rule add`
     * adds one), a new paragraph on the `prompt` layer. A prompt file is
     * started from `promptStartText` (a blank local file counts as absent;
     * the change is then `created` and `blank`, its before piece the blank
     * file's bytes).
     * @param {string} guildId
     * @param {{ layer: 'rules'|'prompt'|'self'|'learned'|'guild'|'profile', target?: string, from?: string, to?: string, why?: string }} edit
     * @param {{ caseId?: number, runId?: string }} [meta]
     * @returns {{ ok: true, change: object } | { ok: false, reason: string }}
     */
    apply(guildId, edit, meta = {}) {
      if (!isObject(edit)) return refuse('layer not allowed');
      const clean = {
        layer: edit.layer,
        target: edit.target,
        from: typeof edit.from === 'string' ? edit.from : '',
        to: typeof edit.to === 'string' ? edit.to : '',
      };
      // Read the records first, so a broken file throws before anything is written.
      const data = readChanges(guildId);
      const overrides = clean.layer === 'prompt' ? readOverrides(guildId) : null;
      const p = plan(guildId, clean);
      if (p.ok === false) return p;

      const id = data.nextId;
      const change = {
        id,
        caseId: meta?.caseId ?? null,
        runId: meta?.runId ?? null,
        layer: clean.layer,
        target: p.target ?? null,
        at: new Date(now()).toISOString(),
        summary: `${[clean.layer, p.target].filter(Boolean).join(' ')}: ${clip(clean.from)} -> ${clip(clean.to)}`,
        ...(p.extra ?? {}),
      };
      if (p.created !== undefined) change.created = p.created;
      if (p.blank) change.blank = true;
      let entry = null;
      if (clean.layer === 'prompt') {
        entry = p.created || !overrides[p.target]
          ? { baseHash: p.trackedRaw === null ? null : sha256(p.trackedRaw), patches: [] }
          : { ...overrides[p.target], patches: [...(overrides[p.target].patches ?? [])] };
        entry.patches.push({ changeId: id, from: clean.from, to: clean.to });
        entry.writtenHash = sha256(p.after);
        change.baseHash = entry.baseHash;
      }
      // The records before the piece: a piece written without its record could never be undone.
      writeJsonAtomic(pieceFile(guildId, id, 'before'), p.before);
      writeJsonAtomic(pieceFile(guildId, id, 'after'), p.after);
      const record = { ...change, pending: true };
      data.changes.push(record);
      data.nextId += 1;
      writeJsonAtomic(changesFile(guildId), data);

      p.write();
      delete record.pending;
      writeJsonAtomic(changesFile(guildId), data);
      if (entry) {
        overrides[p.target] = entry;
        writeJsonAtomic(overridesFile(guildId), overrides);
      }
      return { ok: true, change: { ...change, before: p.before, after: p.after } };
    },

    /**
     * The recorded changes, newest first, without their pieces. A record
     * still carrying `pending: true` is one whose write (by `apply` or by
     * `undo`, when it also has `undoneAt`) did not finish; `undo` settles it.
     * @param {string} guildId
     * @returns {object[]}
     */
    list(guildId) {
      return readChanges(guildId).changes.slice().sort((a, b) => b.id - a.id);
    },

    /**
     * One change with its `before` and `after` pieces, or null for an unknown id.
     * @param {string} guildId
     * @param {number} id
     */
    get(guildId, id) {
      const change = readChanges(guildId).changes.find((c) => c.id === Number(id));
      if (!change) return null;
      return { ...change, before: readPiece(guildId, change.id, 'before'), after: readPiece(guildId, change.id, 'after') };
    },

    /**
     * Put the piece a change touched back as it was. Refuses when the piece
     * no longer equals what the change left (a later change or a hand edit).
     * The record is marked (`undoneAt`, `pending`) before the piece is
     * written and the mark cleared after; a write that throws propagates and
     * leaves the record `pending`. A `pending` record (an apply or an undo
     * that did not finish) is settled by what the piece is now: equal to
     * `after`, it is restored; equal to `before`, only the record is
     * finished; anything else is 'changed since'. A prompt override loses the
     * change's patch (a created override is dropped) and its `writtenHash`
     * moves to the file as the undo left it.
     * @param {string} guildId
     * @param {number} id
     * @returns {{ ok: true, change: object } | { ok: false, reason: string }}
     */
    undo(guildId, id) {
      const data = readChanges(guildId);
      const change = data.changes.find((c) => c.id === Number(id));
      if (!change) return refuse('unknown change');
      if (change.undoneAt && !change.pending) return refuse('already undone');
      const overrides = change.layer === 'prompt' ? readOverrides(guildId) : null;
      const before = readPiece(guildId, change.id, 'before');
      const after = readPiece(guildId, change.id, 'after');
      let p = undoPlan(guildId, change, before, after);
      if (p.ok === false) {
        if (!change.pending || !pieceIsBefore(guildId, change, before, after)) return p;
        // The piece is as it was before the change: nothing to write, only the record to finish.
        p = { write: () => {} };
      }

      Object.assign(change, p.mark ?? {});
      change.undoneAt = new Date(now()).toISOString();
      change.pending = true;
      writeJsonAtomic(changesFile(guildId), data);
      p.write();
      delete change.pending;
      writeJsonAtomic(changesFile(guildId), data);
      if (overrides && overrides[change.target]) {
        if (change.created) delete overrides[change.target];
        else {
          overrides[change.target].patches = (overrides[change.target].patches ?? []).filter((x) => x.changeId !== change.id);
          overrides[change.target].writtenHash = localHash(change.target);
        }
        writeJsonAtomic(overridesFile(guildId), overrides);
      }
      return { ok: true, change: { ...change, before, after } };
    },

    /**
     * For every local prompt override: whether the tracked file is still the
     * one it was made from. `unknown` when the override predates the mentor
     * (no base hash), `missing` when the tracked file is gone. `handEdited`:
     * the local file is not what the mentor last wrote (always true for an
     * override recorded without `writtenHash`).
     * @param {string} guildId
     * @returns {{ name: string, status: 'current'|'stale'|'unknown'|'missing', baseHash: string|null,
     *   trackedHash: string|null, patches: number, handEdited: boolean }[]}
     */
    rebaseStatus(guildId) {
      const overrides = readOverrides(guildId);
      return Object.keys(overrides).sort().map((name) => {
        const entry = overrides[name];
        const raw = readRaw(trackedFile(name));
        const trackedHash = raw === null ? null : sha256(raw);
        const baseHash = entry.baseHash ?? null;
        let status;
        if (trackedHash === null) status = 'missing';
        else if (baseHash === null) status = 'unknown';
        else status = trackedHash === baseHash ? 'current' : 'stale';
        return {
          name,
          status,
          baseHash,
          trackedHash,
          patches: Array.isArray(entry.patches) ? entry.patches.length : 0,
          handEdited: handEdited(name, entry),
        };
      });
    },

    /**
     * Rebuild a local prompt override from the tracked file as it is now:
     * each recorded patch whose `from` is found is applied again, in order
     * (an empty `from` appends); the others are dropped from the override
     * and reported. The base hash moves to the tracked file's, the written
     * hash to the rebuilt file's. Refuses, writing nothing: 'no override',
     * 'unknown base', 'tracked file missing', 'edited by hand' (the local
     * file is not what the mentor last wrote: rebuilding would lose that
     * edit) and 'already current' (the tracked file is still the base).
     * @param {string} guildId
     * @param {string} name
     * @returns {{ ok: true, applied: number[], dropped: { changeId: number, from: string, to: string }[] }
     *   | { ok: false, reason: string }}
     */
    rebase(guildId, name) {
      const overrides = readOverrides(guildId);
      if (typeof name !== 'string' || !Object.hasOwn(overrides, name)) return refuse('no override');
      const entry = overrides[name];
      if (!entry.baseHash) return refuse('unknown base');
      const raw = readRaw(trackedFile(name));
      if (raw === null) return refuse('tracked file missing');
      if (handEdited(name, entry)) return refuse('edited by hand');
      if (sha256(raw) === entry.baseHash) return refuse('already current');
      let text = normalizeText(raw);
      const applied = [];
      const kept = [];
      const dropped = [];
      for (const patch of Array.isArray(entry.patches) ? entry.patches : []) {
        if (!patch.from) {
          text = appendParagraph(text, patch.to);
        } else if (text.includes(patch.from)) {
          text = replaceFirst(text, patch.from, patch.to);
        } else {
          dropped.push({ changeId: patch.changeId, from: patch.from, to: patch.to });
          continue;
        }
        applied.push(patch.changeId);
        kept.push(patch);
      }
      writeTextAtomic(localFile(name), text);
      overrides[name] = { baseHash: sha256(raw), writtenHash: sha256(text), patches: kept };
      writeJsonAtomic(overridesFile(guildId), overrides);
      return { ok: true, applied, dropped };
    },
  };
}
