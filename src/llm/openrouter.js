// OpenRouter chat-completions client on the built-in fetch. Owns the two hard
// safety rails of the project: no request above the token cap ever leaves the
// process, and no more than `llm.maxRequestsPerDay` requests are made per day
// (a spammed mention must not burn the owner's balance).
//
// Deliberate exception: `complete(messages, { countAgainstDailyCap: false })`
// skips the daily-request counter and is never refused by it. This exists
// ONLY for a long-running memory-seeding job with its own separate token
// budget, which would otherwise burn through the whole day's request cap
// while seeding memory. The per-request token cap (`TokenLimitError`) always
// applies, with no exception.

import { estimateMessages } from './tokens.js';
import { log } from '../log.js';

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `${baseUrl}/chat/completions`, tolerating a trailing slash on `baseUrl`. */
function chatCompletionsUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
}

export class TokenLimitError extends Error {}
export class DailyCapError extends Error {}

/**
 * @param {object} deps
 * @param {string} deps.apiKey
 * @param {() => object} deps.getConfig   Returns the live config (hot-reloaded).
 * @param {object} deps.calibrator        From createCalibrator().
 * @param {object} deps.state             Persistent state with `llmDay` / `llmCount` fields.
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createLlm({ apiKey, getConfig, calibrator, state, fetchImpl = fetch }) {
  function countRequest(cap) {
    const today = new Date().toISOString().slice(0, 10);
    if (state.data.llmDay !== today) {
      state.data.llmDay = today;
      state.data.llmCount = 0;
    }
    if (state.data.llmCount >= cap) throw new DailyCapError(`daily LLM request cap reached (${cap})`);
    state.data.llmCount += 1;
    state.markDirty();
  }

  /**
   * Send one chat completion. Returns `{ text, usage, estimated, finishReason }`.
   * `finishReason` is the provider's `choices[0].finish_reason` verbatim
   * (e.g. `'stop'`, `'length'`), or `undefined` when the provider omitted it —
   * callers use it to tell a cut-off completion (`'length'`) from a genuinely
   * bad answer.
   * `options.model` / `options.maxOutputTokens` override the config defaults.
   * `options.timeoutMs` overrides `llm.timeoutMs` for the request's abort
   * signal — the analyzer (a large batch, a long JSON answer) and the media
   * describer need more room than a chat reply's default.
   * `options.countAgainstDailyCap` (default true) — see the header comment
   * for the one deliberate exception.
   * `options.maxRequestTokens` — overrides `cfg.maxRequestTokens` for this one call's pre-flight
   * cap check only (the global rail stays in force for every caller that omits it). Exists for
   * the memory bootstrap (src/memory/bootstrap.js), whose requests are fitted under a much larger,
   * separately-budgeted cap (`bootstrap.maxRequestTokens`) than a live chat/analyzer request.
   * `options.skipCalibration` (default false) — never feeds `usage.prompt_tokens`
   * into the calibrator. For `/nep ping`: a 16-token ping reply is
   * nothing like a real turn's request/response shape, and would only skew
   * the ratio every other request is checked against.
   * `options.signal` — an external `AbortSignal` (e.g. an `AbortController`'s)
   * that cancels the in-flight HTTP request the moment it aborts, on top of
   * the per-attempt timeout signal (`options.timeoutMs`/`cfg.timeoutMs`) —
   * both combined with `AbortSignal.any`. Once `options.signal` is aborted,
   * a caught error is rethrown immediately with NO retry (an external abort
   * is deliberate, not a transient failure worth retrying). Exists for the
   * memory bootstrap's `/nep warmup stop` (src/memory/bootstrap.js): the
   * request already counted by the provider cannot be un-billed, but no
   * further retry/tokens are spent past the moment of the abort.
   */
  async function complete(messages, options = {}) {
    const cfg = getConfig().llm;
    const tokensPerImage = getConfig().context?.vision?.tokensPerImage;
    const raw = estimateMessages(messages, tokensPerImage);
    const estimated = calibrator.apply(raw);
    const requestTokenCap = Number.isFinite(options.maxRequestTokens) ? options.maxRequestTokens : cfg.maxRequestTokens;
    if (estimated > requestTokenCap) {
      throw new TokenLimitError(`request estimated at ${estimated} tokens, cap is ${requestTokenCap}`);
    }
    if (options.countAgainstDailyCap !== false) {
      countRequest(cfg.maxRequestsPerDay);
    }

    const body = {
      model: options.model ?? cfg.model,
      messages,
      temperature: options.temperature ?? cfg.temperature,
      max_tokens: options.maxOutputTokens ?? cfg.maxOutputTokens,
    };
    // OpenRouter's provider routing (e.g. `{ ignore: [...] }`, `{ order: [...] }`), sent
    // verbatim and read fresh on every call so it is hot-reloadable. A non-object (including
    // the default null) omits the field entirely -- OpenRouter then picks providers itself.
    if (cfg.provider && typeof cfg.provider === 'object' && !Array.isArray(cfg.provider)) {
      body.provider = cfg.provider;
    }

    let lastError;
    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      if (attempt > 0) await sleep(1500 * 2 ** (attempt - 1));
      if (options.signal?.aborted) throw lastError ?? options.signal.reason ?? new Error('request aborted');
      try {
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? cfg.timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
        const response = await fetchImpl(chatCompletionsUrl(cfg.baseUrl), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'neptunia-bot',
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          // Full (untrimmed) body kept on `.body` for a caller that needs more than the
          // 500-char message allows -- e.g. `/nep ping` picking OpenRouter's
          // `routing_funnel` diagnostic out of a "No endpoints found" error.
          const rawBody = await response.text();
          const detail = rawBody.slice(0, 500);
          const error = new Error(`OpenRouter HTTP ${response.status}: ${detail}`);
          error.statusCode = response.status;
          error.body = rawBody;
          if (RETRY_STATUS.has(response.status)) {
            lastError = error;
            continue;
          }
          throw error;
        }

        const json = await response.json();
        if (json.error) throw new Error(`OpenRouter error: ${JSON.stringify(json.error).slice(0, 500)}`);
        const text = json.choices?.[0]?.message?.content ?? '';
        const usage = json.usage ?? {};
        const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
        if (options.skipCalibration !== true && usage.prompt_tokens) calibrator.observe(raw, usage.prompt_tokens);
        if (usage.prompt_tokens > requestTokenCap) {
          log.warn('llm: provider counted more prompt tokens than the cap', { usage, estimated });
        }
        // `json.provider` is OpenRouter's own name for whichever upstream provider
        // actually served the request (undefined when the response omits it) --
        // surfaced so `/nep ping` can report it without a second request shape.
        return { text: typeof text === 'string' ? text : '', usage, estimated, finishReason, provider: json.provider };
      } catch (err) {
        if (options.signal?.aborted) throw err; // a deliberate external abort is never retried
        if (err.statusCode && !RETRY_STATUS.has(err.statusCode)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  return { complete };
}
