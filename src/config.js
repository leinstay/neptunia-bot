// Loads .env (simple KEY=VALUE parser — not the `dotenv` package) into
// process.env without overriding already-set variables, and reads
// config.json (+ optional config.local.json, deep-merged) for non-secret
// settings. Secrets are read once at startup; the JSON config is re-read by
// src/hot.js whenever the files change, so nothing here caches it.
// Pure helpers (parseEnv, applyEnv, deepMerge) are exported separately so they
// can be unit-tested without touching the filesystem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse the contents of a .env file into a plain object of string values.
 * Supports blank lines, full-line `#` comments, unquoted values (with an
 * optional trailing ` # comment`), and single/double quoted values.
 * Double-quoted values support \n, \r and \" escapes; single-quoted values
 * are taken literally. Only the first `=` on a line separates key from value,
 * so values may themselves contain `=`.
 */
export function parseEnv(content) {
  const result = {};
  const lines = String(content).split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"');
    } else if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
      value = value.slice(1, -1);
    } else {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx);
      value = value.trim();
    }

    result[key] = value;
  }

  return result;
}

/**
 * Copy parsed .env values onto `target` (defaults to process.env), skipping
 * any key that is already present so real environment variables always win.
 */
export function applyEnv(parsed, target = process.env) {
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in target)) target[key] = value;
  }
  return target;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge `override` onto `base`. Arrays and scalars in `override` fully
 * replace the corresponding value in `base`; plain objects are merged key by
 * key, recursively.
 */
export function deepMerge(base, override) {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const result = { ...base };
    for (const key of Object.keys(override)) {
      result[key] = deepMerge(base[key], override[key]);
    }
    return result;
  }
  return override;
}

/** Load `<rootDir>/.env` into process.env (no-op when the file is absent). */
export function loadDotEnv(rootDir = ROOT_DIR) {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return;
  applyEnv(parseEnv(fs.readFileSync(file, 'utf8')));
}

/** Read config.json merged with config.local.json. Throws on invalid JSON. */
export function readConfig(rootDir = ROOT_DIR) {
  const base = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
  const localPath = path.join(rootDir, 'config.local.json');
  if (!fs.existsSync(localPath)) return base;
  const raw = fs.readFileSync(localPath, 'utf8').trim();
  if (!raw) return base;
  return deepMerge(base, JSON.parse(raw));
}

export const env = process.env;

/** Return env[key], throwing an Error whose message is exactly `key` if unset/empty. */
export function need(key) {
  const value = env[key];
  if (value === undefined || value === '') throw new Error(key);
  return value;
}
