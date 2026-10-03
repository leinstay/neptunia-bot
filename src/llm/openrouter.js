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
import { isPlainObject } from '../config.js';
import { bumpDaily, dailyCounter } from '../time.js';
import { log } from '../log.js';

// ---- transport shared with the images client (src/llm/images.js) ----------

/** HTTP statuses worth a retry: timeouts, rate limits and gateway errors. */
export const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Resolve after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The wait before retry number `attempt` (1-based): 1.5 s, then doubling.
 * @param {number} attempt
 * @returns {number}
 */
export function backoffMs(attempt) {
  return 1500 * 2 ** (attempt - 1);
}

/**
 * The headers of an OpenRouter POST: the bearer key, a JSON body and the
 * neutral app title (never a character name).
 * @param {string} apiKey
 * @returns {Record<string, string>}
 */
export function openRouterHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'neptunia-bot',
  };
}

/**
 * `${baseUrl}/${path}`, tolerating trailing slashes on `baseUrl` and leading
 * ones on `path`.
 * @param {string} baseUrl
 * @param {string} path  E.g. `chat/completions`, `images`.
 * @returns {string}
 */
export function apiUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

/** The state.json fields of the daily request counter. */
const LLM_DAILY = { dayKey: 'llmDay', countKey: 'llmCount' };

/**
 * Video tokens per second when `media.video.tokensPerSecond` is unset or
 * invalid: config.json's value (the rate of a statically sampled clip). The
 * media describer (src/memory/describe.js) sizes its clips with the same one.
 */
export const VIDEO_TOKENS_PER_SECOND_FALLBACK = 120;

export class TokenLimitError extends Error {}
export class DailyCapError extends Error {}

/** The cap keys already reported as not a number (one warn line per key and process). */
const reportedCaps = new Set();

/**
 * One rule for every daily rail (this client's requests, src/llm/images.js's
 * pictures, src/web/lookup.js's reads and searches): a cap that is not a
 * finite number -- missing, null, a string, Infinity -- counts as 0, so the
 * rail refuses everything (fail closed) instead of spending without a limit.
 * The first such cap of each `key` in a process logs
 * `llm: daily cap is not a number, refusing` with the key; later calls stay quiet.
 * @param {unknown} value  The configured cap, read by the caller at the moment of use.
 * @param {string} key     Its config path, e.g. `llm.maxRequestsPerDay`.
 * @returns {number}
 */
export function dailyCapOf(value, key) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!reportedCaps.has(key)) {
    reportedCaps.add(key);
    log.warn('llm: daily cap is not a number, refusing', { key });
  }
  return 0;
}

/**
 * One `llm.providerByModel` key split into its model prefix and its role:
 * `"<prefix>@<role>"` applies to that role only, a key without `@` to any
 * role (`role: null`). Split at the last `@`; model ids carry none.
 * @param {string} key
 * @returns {{ prefix: string, role: string|null }}
 */
export function parseRouteKey(key) {
  const at = key.lastIndexOf('@');
  if (at === -1) return { prefix: key, role: null };
  return { prefix: key.slice(0, at), role: key.slice(at + 1) };
}

/**
 * The `byModel` entry that routes `model` for `role`, or null: among the keys
 * for exactly this role, the longest case-sensitive prefix of `model` (an
 * exact id is simply the longest prefix); when none matches, the same among
 * the role-less keys. A role-specific key beats a role-less one whatever their
 * lengths. A non-string or empty `role` matches role-less keys only.
 * Non-object entries and maps are ignored.
 * @param {unknown} model
 * @param {unknown} byModel
 * @param {unknown} [role]
 * @returns {{ key: string, prefix: string, role: string|null, value: object }|null}
 */
export function matchRoute(model, byModel, role) {
  if (typeof model !== 'string' || !isPlainObject(byModel)) return null;
  const wanted = typeof role === 'string' && role ? role : null;
  let bestRole = null;
  let bestAny = null;
  for (const [key, value] of Object.entries(byModel)) {
    if (!isPlainObject(value)) continue;
    const parsed = parseRouteKey(key);
    if (!model.startsWith(parsed.prefix)) continue;
    const entry = { key, prefix: parsed.prefix, role: parsed.role, value };
    if (parsed.role === null) {
      if (bestAny === null || parsed.prefix.length > bestAny.prefix.length) bestAny = entry;
    } else if (wanted !== null && parsed.role === wanted) {
      if (bestRole === null || parsed.prefix.length > bestRole.prefix.length) bestRole = entry;
    }
  }
  return bestRole ?? bestAny;
}

/**
 * The OpenRouter provider routing for one request, or undefined to send none.
 * Precedence: a plain-object `override` (a caller pinning its own route), then
 * the `byModel` entry chosen by `matchRoute` for `model` and `role` (the
 * longest matching prefix among the keys for this role, else among the
 * role-less keys), then a plain-object `fallback`. Non-object entries, maps
 * and values are ignored. Exists because a provider restriction (e.g. `only`)
 * must differ per model family -- and per subprocess using the model -- when
 * the owner's own provider keys are used: one routing object cannot fit every
 * request. The chosen object is returned as is, never copied or mutated.
 * @param {unknown} model
 * @param {{ override?: unknown, byModel?: unknown, fallback?: unknown, role?: unknown }} [sources]
 * @returns {object|undefined}
 */
export function resolveProvider(model, { override, byModel, fallback, role } = {}) {
  if (isPlainObject(override)) return override;
  const route = matchRoute(model, byModel, role);
  if (route) return route.value;
  return isPlainObject(fallback) ? fallback : undefined;
}

/**
 * @param {object} deps
 * @param {string} deps.apiKey
 * @param {() => object} deps.getConfig   Returns the live config (hot-reloaded).
 * @param {object} deps.calibrator        From createCalibrator().
 * @param {object} deps.state             Persistent state with `llmDay` / `llmCount` fields.
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]       Clock in ms, for the day rollover.
 */
export function createLlm({ apiKey, getConfig, calibrator, state, fetchImpl = fetch, now = Date.now }) {
  function countRequest(configured) {
    const cap = dailyCapOf(configured, 'llm.maxRequestsPerDay');
    const nowMs = now();
    const { count } = dailyCounter(state.data, LLM_DAILY, nowMs);
    if (count >= cap) {
      const err = new DailyCapError(`daily LLM request cap reached (${cap})`);
      throw Object.assign(err, { key: 'llm.maxRequestsPerDay', used: count, cap });
    }
    bumpDaily(state.data, LLM_DAILY, nowMs);
    state.markDirty();
  }

  /**
   * Send one chat completion. Returns `{ text, usage, estimated, finishReason, provider }`.
   * `finishReason` is the provider's `choices[0].finish_reason` verbatim
   * (e.g. `'stop'`, `'length'`), or `undefined` when the provider omitted it —
   * callers use it to tell a cut-off completion (`'length'`) from a genuinely
   * bad answer. `provider` is OpenRouter's name for the upstream provider that
   * served the request (`json.provider`), or `undefined` when the response omits it.
   * `options.model` / `options.maxOutputTokens` / `options.temperature`
   * override the config defaults (`llm.model`, `llm.maxOutputTokens`, `llm.temperature`).
   *
   * Retries (`llm.retries`): a network failure, a timed-out attempt and an
   * HTTP status in `RETRY_STATUS` are retried after `backoffMs`, each retried
   * attempt logged as `llm: retry` (`attempt` 1-based, `status` or null,
   * `name`); the last one is thrown. Once a 200 was received (the request may
   * be billed) nothing is retried: a `json.error` body or an unparsable body is
   * thrown as it is.
   * `options.timeoutMs` overrides `llm.timeoutMs` for the request's abort
   * signal — the analyzer (a large batch, a long JSON answer) and the media
   * describer need more room than a chat reply's default.
   * `options.countAgainstDailyCap` (default true) — see the header comment
   * for the one deliberate exception.
   * `options.maxRequestTokens` — overrides `cfg.maxRequestTokens` for this one call's pre-flight
   * cap check only (the global rail stays in force for every caller that omits it). Exists for
   * the memory warmup (src/memory/warmup.js), whose requests are fitted under a much larger,
   * separately-budgeted cap (`warmup.maxRequestTokens`) than a live chat/analyzer request.
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
   * memory warmup's `/nep warmup stop` (src/memory/warmup.js): the
   * request already counted by the provider cannot be un-billed, but no
   * further retry/tokens are spent past the moment of the abort.
   * `options.provider` — OpenRouter provider routing for this one call; a plain
   * object REPLACES the configured routing (`llm.providerByModel`, then
   * `llm.provider`; see `resolveProvider`); any other value leaves the
   * configured routing in charge. Exists for the video describer, which pins
   * the provider that can fetch a public video URL.
   * `options.role` — which subprocess makes the request (`talk`, `analyzer`,
   * `classifier.text`, `classifier.media`, `classifier.video`, `mentor`; the
   * names of `/nep model`), so a `"<prefix>@<role>"` key of
   * `llm.providerByModel` can route it; never sent. A call without a role
   * matches only role-less keys.
   * `options.reasoning` — OpenRouter's reasoning settings for this one call
   * (e.g. `{ enabled: false }`); a plain object is sent verbatim as
   * `body.reasoning`, anything else omits the field. Exists for the video
   * describer, whose model otherwise spends the output budget on reasoning.
   * `options.videoSeconds` — seconds of video the request carries. A finite,
   * non-negative value adds `ceil(videoSeconds * tokensPerSecond)` to the raw
   * estimate before calibration, because `estimateMessages` cannot size a
   * `video_url` part on its own; the token cap then applies to the sum.
   * `tokensPerSecond` is `options.videoTokensPerSecond` when that is a finite
   * positive number, else `media.video.tokensPerSecond` (`VIDEO_TOKENS_PER_SECOND_FALLBACK`,
   * 120 per second, when unset; the rate of a statically sampled clip). The override exists for
   * the video describer's public-URL requests in agentic processing, where the
   * provider does not count the video as prompt tokens and the per-second cost
   * is far lower (`media.video.directUrlTokensPerSecond`).
   */
  async function complete(messages, options = {}) {
    const cfg = getConfig().llm;
    const tokensPerImage = getConfig().context?.vision?.tokensPerImage;
    let raw = estimateMessages(messages, tokensPerImage);
    if (typeof options.videoSeconds === 'number' && Number.isFinite(options.videoSeconds) && options.videoSeconds >= 0) {
      const override = options.videoTokensPerSecond;
      const tokensPerSecond =
        typeof override === 'number' && Number.isFinite(override) && override > 0
          ? override
          : (getConfig().media?.video?.tokensPerSecond ?? VIDEO_TOKENS_PER_SECOND_FALLBACK);
      raw += Math.ceil(options.videoSeconds * tokensPerSecond);
    }
    const estimated = calibrator.apply(raw);
    const requestTokenCap = Number.isFinite(options.maxRequestTokens) ? options.maxRequestTokens : cfg.maxRequestTokens;
    if (estimated > requestTokenCap) {
      const err = new TokenLimitError(`request estimated at ${estimated} tokens, cap is ${requestTokenCap}`);
      throw Object.assign(err, { key: 'llm.maxRequestTokens', used: estimated, cap: requestTokenCap });
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
    // OpenRouter's provider routing (e.g. `{ ignore: [...] }`, `{ only: [...] }`), sent
    // verbatim and read fresh on every call so it is hot-reloadable: a plain-object
    // `options.provider`, else the `llm.providerByModel` entry for this request's model
    // and `options.role` (see `matchRoute`), else `llm.provider`. When none applies the
    // field is omitted -- OpenRouter then picks providers itself.
    const provider = resolveProvider(body.model, {
      override: options.provider,
      byModel: cfg.providerByModel,
      fallback: cfg.provider,
      role: options.role,
    });
    if (provider) body.provider = provider;
    if (isPlainObject(options.reasoning)) body.reasoning = options.reasoning;

    let lastError;
    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      if (attempt > 0) {
        // `attempt` is also the 1-based number of the attempt that failed and is retried now.
        log.warn('llm: retry', { attempt, status: lastError?.statusCode ?? null, name: lastError?.name ?? null });
        await sleep(backoffMs(attempt));
      }
      if (options.signal?.aborted) throw lastError ?? options.signal.reason ?? new Error('request aborted');
      let response;
      try {
        const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? cfg.timeoutMs);
        const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
        response = await fetchImpl(apiUrl(cfg.baseUrl, 'chat/completions'), {
          method: 'POST',
          headers: openRouterHeaders(apiKey),
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
          if (!RETRY_STATUS.has(response.status)) throw error;
          lastError = error;
          continue;
        }
      } catch (err) {
        if (options.signal?.aborted) throw err; // a deliberate external abort is never retried
        if (err.statusCode && !RETRY_STATUS.has(err.statusCode)) throw err;
        lastError = err; // a network failure or a timed-out attempt: retried
        continue;
      }

      // A 200 was received (and may be billed): whatever goes wrong from here is thrown, never retried.
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
    }
    throw lastError;
  }

  return { complete };
}
