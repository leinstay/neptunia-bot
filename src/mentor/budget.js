// The mentor's own daily token budget. The mentor is a manual sub-process that
// tests the persona in a sandbox and scores the answers; it can spend far more
// than a chat turn (long prompts, several samples per situation), so it gets a
// cap of its own, `mentor.maxTokensPerDay`, separate from the chat's request
// cap and the warm-up budget. Tokens are weighted so the cap tracks cost rather
// than raw volume: output tokens cost more, cached prompt tokens much less.
// The counter lives in state.json (`mentorDay` / `mentorTokens`) and resets on
// a new UTC day. Pure apart from the injected `state`, `getConfig` and `now`.

/** A finite, non-negative number, or 0. */
function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A finite, non-negative weight, or 1 (unweighted) when unset. */
function weight(value) {
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

/**
 * The cost of one completion in weighted tokens:
 * `(prompt - cached) + cached * cachedTokenWeight + completion * outputTokenWeight`, rounded up.
 * Missing numbers count as 0; a missing weight counts as 1.
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
  const total = (prompt - cached) + cached * weight(cfg?.cachedTokenWeight) + completion * weight(cfg?.outputTokenWeight);
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
    const day = new Date(now()).toISOString().slice(0, 10);
    if (state.data.mentorDay !== day) {
      state.data.mentorDay = day;
      state.data.mentorTokens = 0;
      state.markDirty();
    }
    return day;
  }

  function used() {
    openDay();
    return count(state.data.mentorTokens);
  }

  function left() {
    return Math.max(0, cap() - used());
  }

  function canSpend(estimate) {
    return used() + count(estimate) <= cap();
  }

  function charge(usage, fallbackEstimate) {
    const amount = hasUsage(usage) ? weightedTokens(usage, mentorConfig()) : Math.ceil(count(fallbackEstimate));
    state.data.mentorTokens = used() + amount;
    state.markDirty();
    return amount;
  }

  function snapshot() {
    const day = openDay();
    const spent = used();
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
