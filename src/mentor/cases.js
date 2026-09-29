// The mentor's own memory: the cases the owner gives it (a behaviour he wants
// from the persona, in his words), the runs made from them and the owner's
// feedback when he thinks the mentor judged a case wrongly.
//
//   data/guilds/<guildId>/mentor/cases.json               { nextId, cases: [...] }
//   data/guilds/<guildId>/mentor/feedback.json            [{ caseId, runId, reason, at }]
//   data/guilds/<guildId>/mentor/runs/<caseId>/<runId>.json  one run, stored whole
//
// Volumes are tiny, so there is no cache: every call reads the file, changes
// the value and writes it back through the atomic writer of the memory store.
// A missing file is empty; a file that holds broken JSON throws, so nothing
// ever starts over on top of the owner's data. Nothing here deletes a file.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../memory/store.js';

const TARGETS = ['reply', 'memory'];
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
     * Store a new case in state `new`.
     * @param {string} guildId
     * @param {{ text: string, target: 'reply' | 'memory' }} input
     */
    add(guildId, { text, target } = {}) {
      if (!TARGETS.includes(target)) throw new Error(`target must be one of: ${TARGETS.join(', ')}`);
      const clean = checkedText(text, 'case text', TEXT_MIN, TEXT_MAX);
      const data = readCases(guildId);
      const item = {
        id: data.nextId,
        text: clean,
        target,
        state: 'new',
        createdAt: new Date(now()).toISOString(),
        lastRunId: null,
        lastScore: null,
      };
      data.cases.push(item);
      data.nextId += 1;
      writeJsonAtomic(casesFile(guildId), data);
      return item;
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
