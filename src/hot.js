// Hot reload of everything the owner tunes while the bot is running:
// config.json, config.local.json and every prompts/*.md file. Callers never
// cache values — they read `hot.config` / `hot.prompts` at the moment of use,
// so an edit takes effect on the very next LLM request without a restart and
// without touching memory, history or scheduler state under data/.
// A file that fails to parse (half-written JSON, editor temp state) is
// ignored: the previous good value stays live and the error is logged.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { readConfig } from './config.js';
import { log } from './log.js';

const DEBOUNCE_MS = 250;
const CONFIG_FILES = new Set(['config.json', 'config.local.json']);

function readPrompts(promptsDir) {
  const prompts = {};
  for (const file of fs.readdirSync(promptsDir)) {
    if (!file.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(promptsDir, file), 'utf8');
    prompts[path.basename(file, '.md')] = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
  }
  return prompts;
}

/**
 * Create a live view over the config and prompt files under `rootDir`.
 * Emits 'change' with `{ what: 'config' | 'prompts' }` after every successful reload.
 */
export function createHot({ rootDir }) {
  const promptsDir = path.join(rootDir, 'prompts');
  const hot = new EventEmitter();
  const watchers = [];
  const timers = new Map();

  hot.config = readConfig(rootDir);
  hot.prompts = readPrompts(promptsDir);
  hot.promptsDir = promptsDir;
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
      const next = readPrompts(promptsDir);
      // An editor may truncate a file before writing it; never swap a prompt for an empty one.
      const empty = Object.keys(next).filter((name) => !next[name] && hot.prompts[name]);
      for (const name of empty) next[name] = hot.prompts[name];
      hot.prompts = next;
      log.info('hot: prompts reloaded', { prompts: Object.keys(next), keptPrevious: empty });
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

  hot.watch = () => {
    watchers.push(fs.watch(rootDir, (event, file) => {
      if (file && CONFIG_FILES.has(String(file))) schedule('config', hot.reloadConfig);
    }));
    watchers.push(fs.watch(promptsDir, (event, file) => {
      if (!file || String(file).endsWith('.md')) schedule('prompts', hot.reloadPrompts);
    }));
    return hot;
  };

  hot.close = () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    watchers.length = 0;
    timers.clear();
  };

  return hot;
}
