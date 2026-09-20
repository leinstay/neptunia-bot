// OpenRouter chat-completions client on the built-in fetch. Owns the two hard
// safety rails of the project: no request above the token cap ever leaves the
// process, and no more than `llm.maxRequestsPerDay` requests are made per day
// (a spammed mention must not burn the owner's balance).

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
   * Send one chat completion. Returns `{ text, usage, estimated }`.
   * `options.model` / `options.maxOutputTokens` override the config defaults.
   */
  async function complete(messages, options = {}) {
    const cfg = getConfig().llm;
    const tokensPerImage = getConfig().context?.vision?.tokensPerImage;
    const raw = estimateMessages(messages, tokensPerImage);
    const estimated = calibrator.apply(raw);
    if (estimated > cfg.maxRequestTokens) {
      throw new TokenLimitError(`request estimated at ${estimated} tokens, cap is ${cfg.maxRequestTokens}`);
    }
    countRequest(cfg.maxRequestsPerDay);

    const body = {
      model: options.model ?? cfg.model,
      messages,
      temperature: options.temperature ?? cfg.temperature,
      max_tokens: options.maxOutputTokens ?? cfg.maxOutputTokens,
    };

    let lastError;
    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      if (attempt > 0) await sleep(1500 * 2 ** (attempt - 1));
      try {
        const response = await fetchImpl(chatCompletionsUrl(cfg.baseUrl), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'neptunia-bot',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });

        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          const error = new Error(`OpenRouter HTTP ${response.status}: ${detail}`);
          error.statusCode = response.status;
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
        if (usage.prompt_tokens) calibrator.observe(raw, usage.prompt_tokens);
        if (usage.prompt_tokens > cfg.maxRequestTokens) {
          log.warn('llm: provider counted more prompt tokens than the cap', { usage, estimated });
        }
        return { text: typeof text === 'string' ? text : '', usage, estimated };
      } catch (err) {
        if (err.statusCode && !RETRY_STATUS.has(err.statusCode)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  return { complete };
}
