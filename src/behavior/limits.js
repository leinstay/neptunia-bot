// Pure helpers for limit notices: when a rail (daily request cap, token cap,
// image caps, private reply caps) refuses a directly requested action, the bot
// posts one plain line naming the limit and the numbers, so the requester
// knows it was a limit and not silence in character. The wording lives in
// labels.json (`limits.notice`); the limit name is the config key. See
// docs/en/prompt-contract.md.

import { fill } from '../discord/format.js';

/**
 * The notice line: `labels.limits.notice` with `{limit}` (the config key),
 * `{used}` and `{cap}` filled. An empty string when the label is missing, so
 * a deployment without it simply posts nothing.
 * @param {object} labels
 * @param {{ key: string, used: number, cap: number }} limit
 * @returns {string}
 */
export function limitNotice(labels, { key, used, cap }) {
  const template = labels?.limits?.notice;
  if (typeof template !== 'string' || !template) return '';
  return fill(template, { limit: key, used, cap });
}

/**
 * The limit a rail error carries (`DailyCapError`, `TokenLimitError`,
 * `ImageCapError` set `key`, `used`, `cap`), or null for any other error.
 * @param {unknown} err
 * @returns {{ key: string, used: number, cap: number } | null}
 */
export function limitOf(err) {
  if (!err || typeof err !== 'object') return null;
  const { key, used, cap } = err;
  if (typeof key !== 'string' || !key) return null;
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return null;
  return { key, used, cap };
}
