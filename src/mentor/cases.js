// The mentor's own memory: the cases the owner gives it (a behaviour he wants
// from the persona, in his words, with the real moments of the chat that show
// it -- "anchors", see src/mentor/anchor.js), the runs made from them and the
// owner's feedback when he thinks the mentor judged a case wrongly.
//
//   data/guilds/<guildId>/mentor/cases.json               { nextId, cases: [...] }
//     a case: { id, text, target, state, createdAt, lastRunId, lastScore,
//       anchors?: [{ id, channelId, messageId, triggerId, addedAt, history, original,
//         mode?, triggerKind?, sourceChannelId?, triggerGuessed?, pulled? }] }
//     (the turn a moment was and the other channels it showed: src/mentor/anchor.js#resolveAnchor;
//     an anchor stored before them has none and replays as a reply or a mention)
//   data/guilds/<guildId>/mentor/feedback.json            [{ caseId, runId, reason, at }]
//   data/guilds/<guildId>/mentor/runs/<caseId>/<runId>.json  one run, stored whole
//
// Volumes are tiny, so there is no cache: every call reads the file, changes
// the value and writes it back through the atomic writer of the memory store.
// A missing file is empty; a file that holds broken JSON throws, so nothing
// ever starts over on top of the owner's data. Nothing here deletes a file.
//
// Every case is a `reply` case: it judges the persona's answers. A case stored
// by an earlier version with another target (`memory`) stays readable and is
// listed as it is; the mentor reports it as unsupported (src/mentor/mentor.js).

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../memory/store.js';
import { anchorKind, anchorMode, isSpontaneous, isUsableAnchor, storedWindows } from './anchor.js';

/** The one target a new case takes. */
const CASE_TARGET = 'reply';
const TEXT_MIN = 10;
const TEXT_MAX = 1000;
const REASON_MIN = 3;
const REASON_MAX = 500;

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

/** Trimmed text within [min, max] characters, or an Error naming the field. */
function checkedText(value, field, min, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max) {
    throw new Error(`${field} must be ${min} to ${max} characters`);
  }
  return text;
}

/** A case text, trimmed, or an Error when it is not 10 to 1000 characters (what `add` accepts). */
export function checkCaseText(text) {
  return checkedText(text, 'case text', TEXT_MIN, TEXT_MAX);
}

/** `mentor.anchor.max` as a positive integer; the config.json default (5) when unusable. */
export function anchorMax(value) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 5;
}

/** A non-empty string id. */
function isId(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** The warning code of a moment whose trigger was guessed (no post ledger entry named it). */
const TRIGGER_GUESSED = 'trigger-guessed';

/**
 * A resolved moment (src/mentor/anchor.js#resolveAnchor) as it is stored,
 * without its id and time, and the warnings to report with it; an Error when
 * it cannot be replayed: its history must be a non-empty list of messages
 * and its trigger not the persona's (src/mentor/anchor.js#isUsableAnchor,
 * the rule a replay applies); a turn with a trigger needs its id, a
 * spontaneous one (`mode` `interject` / `initiate`) none. The turn it was is
 * kept when the moment carries it -- `mode` and `triggerKind` (null for a
 * value a turn does not have), `sourceChannelId`, `triggerGuessed: true` --
 * and its windows of other channels, cleaned (src/mentor/anchor.js#storedWindows).
 * Warnings are kebab-case codes: `trigger-guessed` for a guessed trigger.
 * @returns {{ moment: object, warnings: string[] }}
 */
function checkedAnchor(anchor) {
  const history = anchor?.history;
  const triggerOk = isId(anchor?.triggerId) || (isSpontaneous(anchor?.mode) && (anchor?.triggerId === null || anchor?.triggerId === undefined));
  const ok =
    isId(anchor?.channelId) &&
    isId(anchor?.messageId) &&
    triggerOk &&
    isUsableAnchor(anchor) &&
    history.every((m) => m !== null && typeof m === 'object');
  if (!ok) throw new Error('the moment cannot be replayed: its chat is empty or ends with the persona');
  const original = Array.isArray(anchor.original) ? anchor.original.filter((text) => typeof text === 'string') : [];
  const moment = { channelId: anchor.channelId, messageId: anchor.messageId, triggerId: isId(anchor.triggerId) ? anchor.triggerId : null, history, original };
  if (anchor.mode !== undefined) moment.mode = anchorMode(anchor.mode);
  if (anchor.triggerKind !== undefined) moment.triggerKind = anchorKind(anchor.triggerKind);
  if (anchor.sourceChannelId !== undefined) moment.sourceChannelId = isId(anchor.sourceChannelId) ? anchor.sourceChannelId : null;
  if (anchor.triggerGuessed === true) moment.triggerGuessed = true;
  const pulled = storedWindows(anchor.pulled);
  if (pulled.length > 0) moment.pulled = pulled;
  return { moment, warnings: moment.triggerGuessed ? [TRIGGER_GUESSED] : [] };
}

/**
 * The mentor's case store for one data directory.
 * @param {{ dataDir: string, now?: () => number }} opts
 */
export function createCaseStore({ dataDir, now = Date.now }) {
  const mentorDir = (guildId) => path.join(dataDir, 'guilds', String(guildId), 'mentor');
  const casesFile = (guildId) => path.join(mentorDir(guildId), 'cases.json');
  const feedbackFile = (guildId) => path.join(mentorDir(guildId), 'feedback.json');
  const runsDir = (guildId, caseId) => path.join(mentorDir(guildId), 'runs', String(caseId));

  function readCases(guildId) {
    return readJsonStrict(
      casesFile(guildId),
      { nextId: 1, cases: [] },
      (v) => v !== null && typeof v === 'object' && Number.isInteger(v.nextId) && Array.isArray(v.cases),
    );
  }

  function readFeedback(guildId) {
    return readJsonStrict(feedbackFile(guildId), [], Array.isArray);
  }

  function findCase(data, id) {
    const found = data.cases.find((c) => c.id === Number(id));
    if (!found) throw new Error(`unknown case: ${id}`);
    return found;
  }

  /** Run ids of a case as numbers, ascending; files that are not `<number>.json` are ignored. */
  function runIds(guildId, caseId) {
    let names;
    try {
      names = fs.readdirSync(runsDir(guildId, caseId));
    } catch {
      return [];
    }
    return names
      .map((name) => /^(\d+)\.json$/.exec(name))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  return {
    /**
     * Store a new case in state `new`. With `anchor` (a resolved moment) the
     * case starts with it as its anchor 1, and the returned case carries
     * `warnings` (kebab-case codes about that moment, never stored; see
     * `checkedAnchor`) for the reply to report. `target` is always `reply`.
     * @param {string} guildId
     * @param {{ text: string, target: 'reply', anchor?: object }} input
     * @returns {object}  The stored case; with an anchor, plus `warnings: string[]`.
     */
    add(guildId, { text, target, anchor } = {}) {
      if (target !== CASE_TARGET) throw new Error(`target must be ${CASE_TARGET}`);
      const clean = checkCaseText(text);
      const checked = anchor === undefined ? null : checkedAnchor(anchor);
      const moment = checked?.moment ?? null;
      const data = readCases(guildId);
      const createdAt = new Date(now()).toISOString();
      const item = {
        id: data.nextId,
        text: clean,
        target,
        state: 'new',
        createdAt,
        lastRunId: null,
        lastScore: null,
      };
      if (moment) item.anchors = [{ id: 1, ...moment, addedAt: createdAt }];
      data.cases.push(item);
      data.nextId += 1;
      writeJsonAtomic(casesFile(guildId), data);
      return checked ? { ...item, warnings: checked.warnings } : item;
    },

    /**
     * Cases oldest first; retired ones only on request.
     * @param {string} guildId
     * @param {{ includeRetired?: boolean }} [opts]
     */
    list(guildId, { includeRetired = false } = {}) {
      return readCases(guildId)
        .cases.filter((c) => includeRetired || c.state !== 'retired')
        .sort((a, b) => a.id - b.id);
    },

    /** One case, or null when there is no such id. */
    get(guildId, id) {
      return readCases(guildId).cases.find((c) => c.id === Number(id)) ?? null;
    },

    /**
     * Add a moment to a case as its next anchor. Refused: an unknown or
     * retired case, a case that is not `reply`, a case that has `max` anchors
     * already, a message the case already holds, a moment that cannot be replayed.
     * @param {string} guildId
     * @param {number} id
     * @param {object} anchor  A resolved moment (src/mentor/anchor.js#resolveAnchor).
     * @param {{ max: number }} options  `mentor.anchor.max`, read by the caller now.
     * @returns {{ item: object, anchor: object, warnings: string[] }}  `warnings`: kebab-case codes about
     *   the moment for the reply to report (see `checkedAnchor`), never stored.
     */
    addAnchor(guildId, id, anchor, { max } = {}) {
      const data = readCases(guildId);
      const item = findCase(data, id);
      if (item.state === 'retired') throw new Error(`case ${item.id} is retired`);
      if (item.target !== CASE_TARGET) throw new Error(`case ${item.id} is not a reply case; only a reply case takes a moment`);
      const anchors = Array.isArray(item.anchors) ? item.anchors : [];
      const limit = anchorMax(max);
      if (anchors.length >= limit) throw new Error(`case ${item.id} has ${anchors.length} moments; at most ${limit} (mentor.anchor.max)`);
      const { moment, warnings } = checkedAnchor(anchor);
      if (anchors.some((a) => a.messageId === moment.messageId)) throw new Error(`that message is already a moment of case ${item.id}`);
      const nextId = anchors.reduce((top, a) => (Number.isInteger(a?.id) && a.id > top ? a.id : top), 0) + 1;
      const added = { id: nextId, ...moment, addedAt: new Date(now()).toISOString() };
      item.anchors = [...anchors, added];
      writeJsonAtomic(casesFile(guildId), data);
      return { item, anchor: added, warnings };
    },

    /** Mark a case retired; its runs and feedback stay on disk. Throws on an unknown id. */
    retire(guildId, id) {
      const data = readCases(guildId);
      const item = findCase(data, id);
      item.state = 'retired';
      writeJsonAtomic(casesFile(guildId), data);
      return item;
    },

    /**
     * Store a run whole under a fresh id and update its case. A run carrying
     * `error` or `stopped` is kept but leaves the case's state and score alone.
     * @param {string} guildId
     * @param {{ caseId: number, passed: boolean, medians?: { overall?: number | null }, error?: unknown, stopped?: unknown }} run
     */
    saveRun(guildId, run) {
      const data = readCases(guildId);
      const item = findCase(data, run?.caseId);
      const ids = runIds(guildId, item.id);
      const newest = ids.length ? ids[ids.length - 1] : -Infinity;
      // Strictly after the newest stored run: unique within a millisecond and ordered even if the clock steps back.
      const id = `${Math.max(now(), newest + 1)}`;
      const stored = { ...run, id };
      writeJsonAtomic(path.join(runsDir(guildId, item.id), `${id}.json`), stored);
      item.lastRunId = id;
      if (!run.error && !run.stopped) {
        const overall = run.medians?.overall;
        item.lastScore = typeof overall === 'number' && Number.isFinite(overall) ? overall : null;
        if (item.state !== 'retired') item.state = run.passed ? 'passing' : 'failing';
      }
      writeJsonAtomic(casesFile(guildId), data);
      return stored;
    },

    /** The newest run of a case, or null when it has none. */
    lastRun(guildId, caseId) {
      const ids = runIds(guildId, caseId);
      if (!ids.length) return null;
      const file = path.join(runsDir(guildId, caseId), `${ids[ids.length - 1]}.json`);
      return readJsonStrict(file, null, (v) => v !== null && typeof v === 'object');
    },

    /**
     * Record that the mentor judged a case wrongly; attaches the case's last run.
     * @param {string} guildId
     * @param {{ caseId: number, reason: string }} input
     */
    addFeedback(guildId, { caseId, reason } = {}) {
      const item = findCase(readCases(guildId), caseId);
      if (!item.lastRunId) throw new Error(`case ${item.id} has no run yet`);
      const clean = checkedText(reason, 'reason', REASON_MIN, REASON_MAX);
      const list = readFeedback(guildId);
      const entry = { caseId: item.id, runId: item.lastRunId, reason: clean, at: new Date(now()).toISOString() };
      list.push(entry);
      writeJsonAtomic(feedbackFile(guildId), list);
      return entry;
    },

    /**
     * The newest `n` feedback entries, newest first, each with its case text
     * (null when the case is gone from cases.json).
     */
    recentFeedback(guildId, n) {
      const count = Math.max(0, Math.floor(Number(n) || 0));
      if (!count) return [];
      const list = readFeedback(guildId);
      const cases = readCases(guildId).cases;
      return list
        .slice(-count)
        .reverse()
        .map((f) => ({ ...f, caseText: cases.find((c) => c.id === f.caseId)?.text ?? null }));
    },
  };
}
