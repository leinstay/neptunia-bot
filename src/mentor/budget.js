// The mentor's own daily token budget. The mentor is a manual sub-process that
// tests the persona in a sandbox and scores the answers; it can spend far more
// than a chat turn (long prompts, several samples per situation), so it gets a
// cap of its own, `mentor.maxTokensPerDay`, separate from the chat's request
// cap and the warm-up budget. Tokens are weighted so the cap tracks cost rather
// than raw volume: output tokens cost more, cached prompt tokens much less.
// The counter lives in state.json (`mentorDay` / `mentorTokens`) and resets on
// a new UTC day. Pure apart from the injected `state`, `getConfig` and `now`.

import { bumpDaily, dailyCounter } from '../time.js';

/** The state.json fields of the daily token counter. */
const MENTOR_DAILY = { dayKey: 'mentorDay', countKey: 'mentorTokens' };

/** A finite, non-negative number, or 0. */
function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A finite, non-negative weight, else `fallback`. */
function weight(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * `mentor.outputTokenWeight`: a finite, non-negative number, else 5 (the
 * config.json value). The one reader of the key: the budget charges with it
 * and the mentor's pre-flight check reserves output with it.
 * @param {{ outputTokenWeight?: unknown } | null | undefined} cfg  The `mentor` config section.
 * @returns {number}
 */
export function outputTokenWeight(cfg) {
  return weight(cfg?.outputTokenWeight, 5);
}

/**
 * `mentor.cachedTokenWeight`: a finite, non-negative number, else 0.1 (the
 * config.json value). The one reader of the key.
 * @param {{ cachedTokenWeight?: unknown } | null | undefined} cfg  The `mentor` config section.
 * @returns {number}
 */
export function cachedTokenWeight(cfg) {
  return weight(cfg?.cachedTokenWeight, 0.1);
}

/**
 * The cost of one completion in weighted tokens:
 * `(prompt - cached) + cached * cachedTokenWeight + completion * outputTokenWeight`, rounded up.
 * Missing numbers count as 0; a missing or invalid weight counts as its
 * config.json value (see `outputTokenWeight`, `cachedTokenWeight`).
 *
 * @param {{ prompt_tokens?: number, completion_tokens?: number,
 *   prompt_tokens_details?: { cached_tokens?: number } } | null | undefined} usage  The provider's usage object.
 * @param {{ outputTokenWeight?: number, cachedTokenWeight?: number } | null | undefined} cfg  The `mentor` config section.
 * @returns {number}
 */
export function weightedTokens(usage, cfg) {
  const prompt = count(usage?.prompt_tokens);
  const cached = Math.min(prompt, count(usage?.prompt_tokens_details?.cached_tokens));
  const completion = count(usage?.completion_tokens);
  const total = (prompt - cached) + cached * cachedTokenWeight(cfg) + completion * outputTokenWeight(cfg);
  // Round away float noise (0.1 * 3 = 0.30000000000000004) before rounding up.
  return Math.ceil(Math.round(total * 1e6) / 1e6);
}

/** Whether `usage` carries any real token count (an empty `{}` does not). */
function hasUsage(usage) {
  return Number.isFinite(usage?.prompt_tokens) || Number.isFinite(usage?.completion_tokens);
}

/**
 * The mentor's daily budget over `state.data.mentorDay` ('YYYY-MM-DD', UTC) and
 * `state.data.mentorTokens`. `getConfig().mentor` is read at every call; a missing
 * or invalid `maxTokensPerDay` counts as 0, so nothing can be spent.
 *
 * @param {object} deps
 * @param {{ data: object, markDirty: () => void }} deps.state  The persisted bot state.
 * @param {() => object} deps.getConfig  Returns the live config (hot-reloaded).
 * @param {() => number} [deps.now]
 * @returns {{ left: () => number, used: () => number, canSpend: (estimate: number) => boolean,
 *   charge: (usage: object|null|undefined, fallbackEstimate: number) => number,
 *   snapshot: () => { day: string, used: number, cap: number, left: number } }}
 */
export function createMentorBudget({ state, getConfig, now = Date.now }) {
  function mentorConfig() {
    return getConfig()?.mentor ?? {};
  }

  function cap() {
    return count(mentorConfig().maxTokensPerDay);
  }

  /** Today's UTC day; a new day starts the counter from zero. */
  function openDay() {
    const { day, count: spent, rolled } = dailyCounter(state.data, MENTOR_DAILY, now());
    if (rolled) state.markDirty();
    return { day, spent };
  }

  function used() {
    return openDay().spent;
  }

  function left() {
    return Math.max(0, cap() - used());
  }

  function canSpend(estimate) {
    return used() + count(estimate) <= cap();
  }

  function charge(usage, fallbackEstimate) {
    const amount = hasUsage(usage) ? weightedTokens(usage, mentorConfig()) : Math.ceil(count(fallbackEstimate));
    bumpDaily(state.data, MENTOR_DAILY, now(), amount);
    state.markDirty();
    return amount;
  }

  function snapshot() {
    const { day, spent } = openDay();
    const limit = cap();
    return { day, used: spent, cap: limit, left: Math.max(0, limit - spent) };
  }

  return { left, used, canSpend, charge, snapshot };
}

/** Thrown when a mentor run would go past `mentor.maxTokensPerDay`. */
export class MentorBudgetError extends Error {
  /**
   * @param {string} [message]
   * @param {{ used?: number, cap?: number }} [details]
   */
  constructor(message, { used, cap } = {}) {
    super(message ?? `mentor daily token budget reached (${used}/${cap})`);
    this.name = 'MentorBudgetError';
    this.key = 'mentor.maxTokensPerDay';
    this.used = used;
    this.cap = cap;
  }
}
