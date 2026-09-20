// Hot reload of everything the owner tunes while the bot is running:
// config.json, config.local.json and the two prompt layers (prompts/ and
// prompts.local/). Callers never cache values — they read `hot.config` /
// `hot.prompts` at the moment of use, so an edit takes effect on the very
// next LLM request without a restart and without touching memory, history or
// scheduler state under data/.
//
// prompts/ is the tracked, generic layer; prompts.local/ is a deployment's
// own, gitignored overrides — it may be entirely absent. A local file
// replaces the base file of the same name once it is non-empty; labels.json
// is deep-merged instead of replaced. A file that fails to parse (half
// -written JSON, editor temp state) is ignored on reload: the previous good
// value stays live and the error is logged. On the very first load, invalid
// JSON still throws so a broken deployment fails fast at startup.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readConfig, deepMerge } from './config.js';
import { log } from './log.js';

const DEBOUNCE_MS = 250;
const CONFIG_FILES = new Set(['config.json', 'config.local.json']);
const LOCAL_PROMPTS_DIRNAME = 'prompts.local';

function stripText(raw) {
  return raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
}

/** Basenames (with extension) of every `*.md` file directly under `dir`, or `[]` when `dir` is absent. */
function listMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith('.md'));
}

/** Text of `<dir>/<file>`, stripped of BOM/CRLF and trimmed, or `null` when the file does not exist. */
function readMdFile(dir, file) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return null;
  return stripText(fs.readFileSync(full, 'utf8'));
}

/**
 * Merge the base and local `*.md` layers into `{ prompts, sources, keptPrevious }`.
 * A local file replaces the base file of the same name once it is non-empty
 * after trimming; otherwise the base text is used. When the resulting text is
 * still empty but a previous, non-empty value is known for that name (an
 * editor may truncate a file before writing it), the previous value and its
 * source are kept so a half-written file never blanks out a live prompt. A
 * name whose files are gone from both layers is simply absent from the
 * result — the caller drops it.
 */
function computePromptFiles(promptsDir, localPromptsDir, prevPrompts, prevSources) {
  const files = new Set([...listMdFiles(promptsDir), ...listMdFiles(localPromptsDir)]);
  const prompts = {};
  const sources = {};
  const keptPrevious = [];

  for (const file of files) {
    const name = path.basename(file, '.md');
    const baseText = readMdFile(promptsDir, file);
    const localText = readMdFile(localPromptsDir, file);
    const useLocal = Boolean(localText);
    const effective = useLocal ? localText : (baseText ?? '');

    if (!effective && prevPrompts[name]) {
      prompts[name] = prevPrompts[name];
      sources[name] = prevSources[name] ?? (useLocal ? 'local' : 'base');
      keptPrevious.push(name);
    } else {
      prompts[name] = effective;
      sources[name] = useLocal ? 'local' : 'base';
    }
  }

  return { prompts, sources, keptPrevious };
}

/** Parsed `<dir>/labels.json`, or `undefined` when the file is absent or blank. Throws on invalid JSON. */
function readLabelsFile(dir) {
  const file = path.join(dir, 'labels.json');
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/**
 * `{ labels, source }` for the deep-merged labels layer. Missing base labels
 * default to `{}`. Throws when either file exists and is not valid JSON —
 * callers on a reload path must catch this and keep the previous labels.
 */
function computeLabels(promptsDir, localPromptsDir) {
  const base = readLabelsFile(promptsDir);
  const local = readLabelsFile(localPromptsDir);
  if (local !== undefined) return { labels: deepMerge(base ?? {}, local), source: 'merged' };
  return { labels: base ?? {}, source: 'base' };
}

function loadPromptLayers(promptsDir, localPromptsDir, prevPrompts, prevSources) {
  const { prompts, sources, keptPrevious } = computePromptFiles(promptsDir, localPromptsDir, prevPrompts, prevSources);
  const { labels, source: labelsSource } = computeLabels(promptsDir, localPromptsDir);
  prompts.labels = labels;
  sources.labels = labelsSource;
  return { prompts, sources, keptPrevious };
}

/**
 * Create a live view over the config and the two prompt layers under `rootDir`.
 * Emits 'change' with `{ what: 'config' | 'prompts' }` after every successful reload.
 */
export function createHot({ rootDir }) {
  const promptsDir = path.join(rootDir, 'prompts');
  const localPromptsDir = path.join(rootDir, LOCAL_PROMPTS_DIRNAME);
  const hot = new EventEmitter();
  const watchers = [];
  const timers = new Map();
  let localWatcher = null;

  hot.config = readConfig(rootDir);
  // Initial load: invalid labels JSON throws so a broken deployment fails at startup.
  const initial = loadPromptLayers(promptsDir, localPromptsDir, {}, {});
  hot.prompts = initial.prompts;
  hot.promptSources = initial.sources;
  hot.promptsDir = promptsDir;
  hot.localPromptsDir = localPromptsDir;
  hot.rootDir = rootDir;

  hot.reloadConfig = () => {
    try {
      hot.config = readConfig(rootDir);
      log.info('hot: config reloaded');
      hot.emit('change', { what: 'config' });
      return true;
    } catch (err) {
      log.warn('hot: config not reloaded, keeping the previous one', { error: err });
      return false;
    }
  };

  hot.reloadPrompts = () => {
    try {
      const { prompts: mdPrompts, sources: mdSources, keptPrevious } = computePromptFiles(
        promptsDir,
        localPromptsDir,
        hot.prompts,
        hot.promptSources,
      );

      let labels = hot.prompts.labels;
      let labelsSource = hot.promptSources.labels;
      try {
        const computed = computeLabels(promptsDir, localPromptsDir);
        labels = computed.labels;
        labelsSource = computed.source;
      } catch (err) {
        log.warn('hot: labels.json not reloaded, keeping the previous labels', { error: err });
      }

      hot.prompts = { ...mdPrompts, labels };
      hot.promptSources = { ...mdSources, labels: labelsSource };
      log.info('hot: prompts reloaded', { prompts: Object.keys(mdPrompts), keptPrevious });
      hot.emit('change', { what: 'prompts' });
      return true;
    } catch (err) {
      log.warn('hot: prompts not reloaded, keeping the previous ones', { error: err });
      return false;
    }
  };

  function schedule(key, fn) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, DEBOUNCE_MS));
  }

  function isPromptFile(file) {
    if (!file) return true;
    const name = String(file);
    return name.endsWith('.md') || name.endsWith('.json');
  }

  function attachErrorHandler(watcher) {
    watcher.on('error', (err) => {
      log.warn('hot: watcher error', { error: err });
    });
  }

  function startLocalWatch() {
    if (localWatcher) return;
    try {
      localWatcher = fs.watch(localPromptsDir, (event, file) => {
        if (isPromptFile(file)) schedule('prompts', hot.reloadPrompts);
      });
      watchers.push(localWatcher);
      attachErrorHandler(localWatcher);
    } catch (err) {
      log.warn('hot: failed to watch prompts.local', { error: err });
    }
  }

  hot.watch = () => {
    const rootWatcher = fs.watch(rootDir, (event, file) => {
      const name = file ? String(file) : '';
      if (CONFIG_FILES.has(name)) {
        schedule('config', hot.reloadConfig);
      } else if (name === LOCAL_PROMPTS_DIRNAME && !localWatcher && fs.existsSync(localPromptsDir)) {
        startLocalWatch();
        schedule('prompts', hot.reloadPrompts);
      }
    });
    watchers.push(rootWatcher);
    attachErrorHandler(rootWatcher);

    const baseWatcher = fs.watch(promptsDir, (event, file) => {
      if (isPromptFile(file)) schedule('prompts', hot.reloadPrompts);
    });
    watchers.push(baseWatcher);
    attachErrorHandler(baseWatcher);

    if (fs.existsSync(localPromptsDir)) startLocalWatch();

    return hot;
  };

  hot.close = () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    watchers.length = 0;
    timers.clear();
    localWatcher = null;
  };

  return hot;
}
