// Tests for src/llm/openrouter.js: the two hard safety rails (token cap,
// daily request cap), retry behaviour, calibration feedback and the usage log
// line. No network: fetchImpl is always a fake. Only the few retry tests marked
// below exercise a real retry sleep (~1.5s) -- the backoff sleep in src is not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLlm,
  TokenLimitError,
  DailyCapError,
  resolveProvider,
  matchRoute,
  parseRouteKey,
  RETRY_STATUS,
  sleep,
  openRouterHeaders,
  apiUrl,
  backoffMs,
  dailyCapOf,
  VIDEO_TOKENS_PER_SECOND_FALLBACK,
  providerLimitOf,
  cacheTtlFor,
  withCacheMarker,
  fullPromptTokens,
} from '../src/llm/openrouter.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

function baseConfig(overrides = {}) {
  return {
    llm: {
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'test-model',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 1000,
      maxRequestsPerDay: 300,
      timeoutMs: 5000,
      retries: 2,
      ...overrides,
    },
    context: { vision: { tokensPerImage: 1600 } },
  };
}

function fakeState() {
  return { data: {}, markDirty() { this.dirty = (this.dirty ?? 0) + 1; } };
}

function fakeCalibrator() {
  const observed = [];
  return {
    ratio: 1,
    apply: (n) => n,
    observe: (raw, actual) => observed.push([raw, actual]),
    observed,
  };
}

function okResponse(text, usage = { prompt_tokens: 42 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text } }], usage }),
  };
}

function errorResponse(status, body = 'error') {
  return { ok: false, status, text: async () => body };
}

test('complete: refuses with TokenLimitError above the cap without calling fetch', async () => {
  let called = false;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { called = true; return okResponse('x'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'a'.repeat(2000) }]),
    (err) => err instanceof TokenLimitError,
  );
  assert.equal(called, false);
});

test('complete: a rejected-for-size request does not count against the daily cap', async () => {
  const state = fakeState();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'a'.repeat(2000) }]));
  assert.equal(state.data.llmCount ?? 0, 0);
});

test('complete: DailyCapError once the daily cap is reached, without calling fetch', async () => {
  let calls = 0;
  const state = fakeState();
  const today = new Date().toISOString().slice(0, 10);
  state.data.llmDay = today;
  state.data.llmCount = 1;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 1 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => { calls += 1; return okResponse('x'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'hi' }]),
    (err) => err instanceof DailyCapError,
  );
  assert.equal(calls, 0);
});

test('complete: the daily counter follows the injected clock and starts again on a new UTC day', async () => {
  const state = fakeState();
  state.data.llmDay = '2026-09-20';
  state.data.llmCount = 1;
  let nowMs = Date.UTC(2026, 8, 20, 23, 59, 0);
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 1 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
    now: () => nowMs,
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => err instanceof DailyCapError);
  nowMs = Date.UTC(2026, 8, 21, 0, 1, 0);
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(state.data.llmDay, '2026-09-21');
  assert.equal(state.data.llmCount, 1);
});

test('complete: DailyCapError carries the limit key, the used count and the cap', async () => {
  const state = fakeState();
  state.data.llmDay = new Date().toISOString().slice(0, 10);
  state.data.llmCount = 3;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 3 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('x'),
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => {
    assert.ok(err instanceof DailyCapError);
    assert.equal(err.message, 'daily LLM request cap reached (3)');
    assert.equal(err.key, 'llm.maxRequestsPerDay');
    assert.equal(err.used, 3);
    assert.equal(err.cap, 3);
    return true;
  });
});

test('complete: TokenLimitError carries the limit key, the estimate as used and the cap', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('x'),
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'a'.repeat(2000) }]), (err) => {
    assert.ok(err instanceof TokenLimitError);
    assert.equal(err.key, 'llm.maxRequestTokens');
    assert.equal(err.cap, 50);
    assert.ok(Number.isFinite(err.used) && err.used > 50);
    assert.equal(err.message, `request estimated at ${err.used} tokens, cap is 50`);
    return true;
  });
});

test('complete: a day rollover resets the counter and lets a new request through', async () => {
  const state = fakeState();
  state.data.llmDay = '2000-01-01'; // long past day, at/over the old cap
  state.data.llmCount = 1;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 1 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => okResponse('hi there'),
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hi there');
  assert.equal(state.data.llmCount, 1); // reset to 0, then incremented once
  assert.equal(state.data.llmDay, new Date().toISOString().slice(0, 10));
});

test('complete: a cap that is not a finite number counts as 0 -- every request refused, logged once per process', async () => {
  const { logs } = await withCapturedLogs(async () => {
    for (const cap of [undefined, null, Number.NaN, '300', Infinity]) {
      let calls = 0;
      const state = fakeState();
      const llm = createLlm({
        apiKey: 'k',
        getConfig: () => baseConfig({ maxRequestsPerDay: cap }),
        calibrator: fakeCalibrator(),
        state,
        fetchImpl: async () => { calls += 1; return okResponse('x'); },
      });
      await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => {
        assert.ok(err instanceof DailyCapError, String(cap));
        assert.equal(err.cap, 0);
        assert.equal(err.key, 'llm.maxRequestsPerDay');
        return true;
      });
      assert.equal(calls, 0, String(cap));
      assert.equal(state.data.llmCount ?? 0, 0, String(cap));
    }
  });
  const lines = logs.filter((l) => l.msg === 'llm: daily cap is not a number, refusing');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].key, 'llm.maxRequestsPerDay');
});

test('dailyCapOf: a finite number is the cap as given; anything else is 0', () => {
  assert.equal(dailyCapOf(5, 'test.finite'), 5);
  assert.equal(dailyCapOf(0, 'test.finite'), 0);
  for (const value of [undefined, null, Number.NaN, '5', Infinity, {}]) assert.equal(dailyCapOf(value, 'test.other'), 0);
});

test('complete: a json.error body after a 200 is thrown and never retried', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ error: { message: 'upstream refused' } }) };
    },
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), /OpenRouter error/);
  assert.equal(calls, 1);
});

test('complete: an unparsable 200 body is thrown and never retried', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } };
    },
  });
  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => err instanceof SyntaxError);
  assert.equal(calls, 1);
});

test('complete: a non-retryable 4xx throws immediately with statusCode, fetch called once', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls += 1; return errorResponse(400, 'bad request'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'hi' }]),
    (err) => err.statusCode === 400,
  );
  assert.equal(calls, 1);
});

test('complete: feeds the calibrator from usage.prompt_tokens on success', async () => {
  const calibrator = fakeCalibrator();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => okResponse('hi', { prompt_tokens: 777 }),
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(calibrator.observed.length, 1);
  assert.equal(calibrator.observed[0][1], 777);
});

test('complete: options.skipCalibration true never feeds the calibrator, even with usage.prompt_tokens present', async () => {
  const calibrator = fakeCalibrator();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => okResponse('pong', { prompt_tokens: 777 }),
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { skipCalibration: true });
  assert.equal(calibrator.observed.length, 0);
});

test('complete: returns the provider named in the response json', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: {}, provider: 'Anthropic' }),
    }),
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.provider, 'Anthropic');
});

test('complete: provider is undefined when the response omits it', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.provider, undefined);
});

test('complete: a non-retryable HTTP error carries the untrimmed body as .body, for a caller that needs more than the trimmed message', async () => {
  const longBody = JSON.stringify({ error: { message: 'No endpoints found' }, routing_funnel: [{ step: 'BYOK endpoints', endpoints: 0 }] });
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => errorResponse(404, longBody),
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'hi' }]),
    (err) => err.statusCode === 404 && err.body === longBody,
  );
});

test('complete: does not call calibrator.observe when usage.prompt_tokens is absent', async () => {
  const calibrator = fakeCalibrator();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => okResponse('hi', {}),
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(calibrator.observed.length, 0);
});

test('complete: an empty/non-string model content falls back to an empty string', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse(null),
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, '');
});

test('complete: posts to `${baseUrl}/chat/completions` when baseUrl has no trailing slash', async () => {
  let seenUrl = null;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ baseUrl: 'https://example.com/v1' }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url) => {
      seenUrl = url;
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(seenUrl, 'https://example.com/v1/chat/completions');
});

test('complete: a trailing slash on baseUrl is tolerated, no double slash in the URL', async () => {
  let seenUrl = null;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ baseUrl: 'https://example.com/v1/' }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url) => {
      seenUrl = url;
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(seenUrl, 'https://example.com/v1/chat/completions');
});

test('complete: sends the neutral X-Title header, not a character name', async () => {
  let seenHeaders = null;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenHeaders = init.headers;
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(seenHeaders['X-Title'], 'neptunia-bot');
});

test('complete: countAgainstDailyCap: false neither counts against nor is refused by the daily cap', async () => {
  const state = fakeState();
  const today = new Date().toISOString().slice(0, 10);
  state.data.llmDay = today;
  state.data.llmCount = 1;
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestsPerDay: 1 }), // already at/over cap
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => { calls += 1; return okResponse('hi'); },
  });

  const result = await llm.complete([{ role: 'user', content: 'hi' }], { countAgainstDailyCap: false });

  assert.equal(result.text, 'hi');
  assert.equal(calls, 1);
  assert.equal(state.data.llmCount, 1, 'the counter is untouched by a call that opts out of the daily cap');
});

test('complete: countAgainstDailyCap: false still enforces the per-request token cap', async () => {
  let called = false;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { called = true; return okResponse('x'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'a'.repeat(2000) }], { countAgainstDailyCap: false }),
    (err) => err instanceof TokenLimitError,
  );
  assert.equal(called, false);
});

test('complete: options.maxRequestTokens overrides the global cap for one call only', async () => {
  let called = false;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { called = true; return okResponse('x'); },
  });
  const result = await llm.complete([{ role: 'user', content: 'a'.repeat(200) }], { maxRequestTokens: 1000 });
  assert.equal(called, true);
  assert.equal(result.text, 'x');
});

test('complete: options.maxRequestTokens can also tighten the cap for one call', async () => {
  let called = false;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 1000 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { called = true; return okResponse('x'); },
  });
  await assert.rejects(
    llm.complete([{ role: 'user', content: 'a'.repeat(2000) }], { maxRequestTokens: 50 }),
    (err) => err instanceof TokenLimitError,
  );
  assert.equal(called, false);
});

test('complete: passes through choices[0].finish_reason as finishReason', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'cut off' }, finish_reason: 'length' }], usage: {} }),
    }),
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.finishReason, 'length');
});

test('complete: finishReason is undefined when the provider omits it', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'), // okResponse's choices carry no finish_reason
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.finishReason, undefined);
});

test('complete: defaults to llm.timeoutMs for the request signal when options.timeoutMs is absent', async () => {
  let seenSignal;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ timeoutMs: 100000 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenSignal = init.signal;
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(seenSignal.aborted, false);
});

test('complete: options.timeoutMs overrides llm.timeoutMs for the request signal', async () => {
  let seenSignal;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ timeoutMs: 100000 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenSignal = init.signal;
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seenSignal.aborted, true, 'a short options.timeoutMs must win over the much longer llm.timeoutMs');
});

test('complete: omits the provider field when llm.provider is null (the default)', async () => {
  let seenBody = null;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: null }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenBody = JSON.parse(init.body);
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal('provider' in seenBody, false);
});

test('complete: omits the provider field when llm.provider is a non-object (e.g. a stray string)', async () => {
  let seenBody = null;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: 'anthropic' }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenBody = JSON.parse(init.body);
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal('provider' in seenBody, false);
});

test('complete: sends llm.provider verbatim as the request\'s provider field when it is an object', async () => {
  let seenBody = null;
  const provider = { order: ['anthropic'], allow_fallbacks: true };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenBody = JSON.parse(init.body);
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(seenBody.provider, provider);
});

test('complete: llm.provider is read fresh on every call (hot-reloadable), not cached from the first request', async () => {
  const bodies = [];
  let provider = { ignore: ['amazon-bedrock'] };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  provider = null;
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(bodies[0].provider, { ignore: ['amazon-bedrock'] });
  assert.equal('provider' in bodies[1], false);
});

test('complete: options.provider is sent as the provider field and overrides a configured llm.provider', async () => {
  let seenBody = null;
  const pinned = { order: ['google-ai-studio'], allow_fallbacks: false };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: { ignore: ['amazon-bedrock'] } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenBody = JSON.parse(init.body);
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: pinned });
  assert.deepEqual(seenBody.provider, pinned);
});

test('complete: options.provider is sent even when llm.provider is null', async () => {
  let seenBody = null;
  const pinned = { order: ['google-ai-studio'], allow_fallbacks: false };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: null }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenBody = JSON.parse(init.body);
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: pinned });
  assert.deepEqual(seenBody.provider, pinned);
});

test('complete: a non-object options.provider (array, null, string) falls back to llm.provider', async () => {
  const bodies = [];
  const configured = { ignore: ['amazon-bedrock'] };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ provider: configured }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: ['google-ai-studio'] });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: null });
  await llm.complete([{ role: 'user', content: 'hi' }], { provider: 'google-ai-studio' });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  for (const body of bodies) assert.deepEqual(body.provider, configured);
});

test('complete: options.videoSeconds raises the estimate by videoSeconds * media.video.tokensPerSecond', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  const withVideo = await llm.complete(messages, { videoSeconds: 60 });
  assert.equal(withVideo.estimated - plain.estimated, 18000);
});

test('complete: options.videoSeconds defaults to 120 tokens per second (config.json) when media.video is absent', async () => {
  assert.equal(VIDEO_TOKENS_PER_SECOND_FALLBACK, 120);
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ maxRequestTokens: 50000 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  const withVideo = await llm.complete(messages, { videoSeconds: 10 });
  assert.equal(withVideo.estimated - plain.estimated, 1200);
});

test('complete: options.videoSeconds counts against the token cap (just below passes, just above refuses)', async () => {
  const messages = [{ role: 'user', content: 'hi' }];
  // raw text estimate: overhead 6 + ceil(2/3.5)=1 -> 7; plus 60 s * 300 = 18000 -> 18007
  const make = (cap) => createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: cap }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const ok = await make(18007).complete(messages, { videoSeconds: 60 });
  assert.equal(ok.estimated, 18007);
  await assert.rejects(
    make(18006).complete(messages, { videoSeconds: 60 }),
    (err) => err instanceof TokenLimitError,
  );
});

test('complete: the calibrator is applied to the text estimate plus the video estimate', async () => {
  const calibrator = { ...fakeCalibrator(), apply: (n) => n * 2 };
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 100000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator,
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }], { videoSeconds: 60 });
  assert.equal(result.estimated, (7 + 18000) * 2);
});

test('complete: a non-finite or negative options.videoSeconds leaves the estimate unchanged', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  for (const videoSeconds of [NaN, Infinity, -5, '60', undefined]) {
    const result = await llm.complete(messages, { videoSeconds });
    assert.equal(result.estimated, plain.estimated, `videoSeconds=${String(videoSeconds)}`);
  }
});

test('complete: options.videoTokensPerSecond replaces media.video.tokensPerSecond for this one call', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  const agentic = await llm.complete(messages, { videoSeconds: 3289, videoTokensPerSecond: 10 });
  assert.equal(agentic.estimated - plain.estimated, 32890);
  const fractional = await llm.complete(messages, { videoSeconds: 3, videoTokensPerSecond: 0.5 });
  assert.equal(fractional.estimated - plain.estimated, 2);
  const next = await llm.complete(messages, { videoSeconds: 60 });
  assert.equal(next.estimated - plain.estimated, 18000, 'the override never sticks to later calls');
});

test('complete: a non-finite or non-positive options.videoTokensPerSecond falls back to media.video.tokensPerSecond', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  for (const videoTokensPerSecond of [NaN, Infinity, -Infinity, 0, -10, '10', null, undefined, {}]) {
    const result = await llm.complete(messages, { videoSeconds: 60, videoTokensPerSecond });
    assert.equal(result.estimated - plain.estimated, 18000, `videoTokensPerSecond=${String(videoTokensPerSecond)}`);
  }
});

test('complete: options.videoTokensPerSecond alone (no videoSeconds) leaves the estimate unchanged', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => ({ ...baseConfig({ maxRequestTokens: 50000 }), media: { video: { tokensPerSecond: 300 } } }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => okResponse('hi'),
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const plain = await llm.complete(messages);
  const result = await llm.complete(messages, { videoTokensPerSecond: 10 });
  assert.equal(result.estimated, plain.estimated);
});

// options.signal -- an external AbortController cancels the in-flight
// request (for /nep warmup stop), and is never retried afterwards.
test('complete: options.signal aborts the in-flight fetch and rejects without retrying', async () => {
  let calls = 0;
  let seenSignal;
  const controller = new AbortController();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: (url, init) => {
      calls += 1;
      seenSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  });

  const promise = llm.complete([{ role: 'user', content: 'hi' }], { signal: controller.signal });
  controller.abort();

  await assert.rejects(promise, (err) => err.name === 'AbortError');
  assert.equal(seenSignal.aborted, true, 'the signal handed to fetch must reflect the external abort');
  assert.equal(calls, 1, 'a deliberate external abort must never be retried');
});

test('complete: options.signal already aborted before the call is never sent to fetch', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls += 1; return okResponse('x'); },
  });

  await assert.rejects(llm.complete([{ role: 'user', content: 'hi' }], { signal: controller.signal }));
  assert.equal(calls, 0);
});

test('complete: without options.signal, behaviour is unchanged (only the per-request timeout applies)', async () => {
  let seenSignal;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ timeoutMs: 100000 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      seenSignal = init.signal;
      return okResponse('hi');
    },
  });
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'hi');
  assert.equal(seenSignal.aborted, false);
});

// Only FIVE tests exercise the real retry backoff sleep (~1.5s at attempt 1): a gateway error, a
// timeout, a rate limit with a JSON body, the retried 429 kinds side by side and a rate limit
// followed by a daily quota (below).
test('complete: retries once on a 503 then succeeds, logging the retried attempt', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 1 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return errorResponse(503, 'temporarily unavailable');
      return okResponse('recovered');
    },
  });
  const { result, logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }]));
  assert.equal(result.text, 'recovered');
  assert.equal(calls, 2);
  const retries = logs.filter((l) => l.msg === 'llm: retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[0].status, 503);
  assert.equal(retries[0].name, 'Error');
  assert.ok(!JSON.stringify(logs).includes('temporarily unavailable'), 'the provider body is never logged');
  assert.equal('limitSource' in retries[0], false, 'a plain-text body adds no limit source');
  assert.equal('provider' in retries[0], false, 'a plain-text body adds no provider');
});

test('complete: a timed-out attempt is retried and logged with its error name', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 1 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return okResponse('recovered');
    },
  });
  const { result, logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }]));
  assert.equal(result.text, 'recovered');
  assert.equal(calls, 2);
  const retries = logs.filter((l) => l.msg === 'llm: retry');
  assert.deepEqual(retries.map((l) => [l.attempt, l.status, l.name]), [[1, null, 'TimeoutError']]);
  assert.equal('limitSource' in retries[0] || 'provider' in retries[0], false, 'no body, no limit fields');
});

test('complete: a 429 whose JSON body names the limit source and the provider puts both on the retry line', async () => {
  let calls = 0;
  const body = JSON.stringify({
    error: {
      message: 'Provider returned error',
      code: 429,
      metadata: { raw: 'the upstream asks to slow down', provider_name: 'Google AI Studio', limit_source: 'upstream', is_byok: true },
    },
  });
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 1 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return errorResponse(429, body);
      return okResponse('recovered');
    },
  });
  const { result, logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }]));
  assert.equal(result.text, 'recovered');
  assert.equal(calls, 2);
  const retries = logs.filter((l) => l.msg === 'llm: retry');
  assert.equal(retries.length, 1);
  const { level, time, msg, ...fields } = retries[0];
  assert.equal(level, 'warn');
  assert.equal(typeof time, 'string');
  assert.equal(msg, 'llm: retry');
  assert.deepEqual(fields, { attempt: 1, status: 429, name: 'Error', limitSource: 'upstream', provider: 'Google AI Studio' });
  assert.ok(!JSON.stringify(logs).includes('slow down'), 'the raw body is never logged');
});

test('complete: the last failed attempt is thrown, not logged as a retry', async () => {
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 0 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls += 1; return errorResponse(503, 'temporarily unavailable'); },
  });
  const { logs } = await withCapturedLogs(() => assert.rejects(llm.complete([{ role: 'user', content: 'hi' }]), (err) => err.statusCode === 503));
  assert.equal(calls, 1);
  assert.equal(logs.filter((l) => l.msg === 'llm: retry').length, 0);
});

// --- a provider's 429: which limit it names, and no retry on a daily quota ---

/** The provider's own text when its account ran out of the day's token quota. */
const DAILY_RAW = 'Too many tokens per day, please wait before trying again.';

/** A 429 body in OpenRouter's provider-error shape, the limit on the provider account (`raw` omitted when undefined). */
function upstreamLimitBody(raw, provider = 'Amazon Bedrock') {
  const metadata = { provider_name: provider, limit_source: 'upstream_provider_account', is_byok: true };
  if (raw !== undefined) metadata.raw = raw;
  return JSON.stringify({ error: { message: 'Provider returned error', code: 429, metadata } });
}

/** OpenRouter's own 429: no provider metadata, even when its text names a day. */
const OPENROUTER_429 = JSON.stringify({ error: { message: 'Rate limit exceeded: too many requests per day', code: 429 } });

/** An error shaped as `complete()` throws it for a non-ok answer. */
function httpError(status, body) {
  return Object.assign(new Error(`OpenRouter HTTP ${status}`), { statusCode: status, body });
}

const NO_LIMIT = { limitSource: null, provider: null, kind: null };

test('providerLimitOf: a 429 naming upstream_provider_account and a per-day limit is kind daily', () => {
  assert.deepEqual(providerLimitOf(httpError(429, upstreamLimitBody(DAILY_RAW))), {
    status: 429,
    limitSource: 'upstream_provider_account',
    provider: 'Amazon Bedrock',
    kind: 'daily',
  });
  for (const raw of ['Daily token quota exceeded for this account.', JSON.stringify({ message: DAILY_RAW })]) {
    assert.equal(providerLimitOf(httpError(429, upstreamLimitBody(raw))).kind, 'daily', raw);
  }
});

test('providerLimitOf: a text naming both a day and a throttle is kind daily', () => {
  // Each also reads as a short-window throttle ("too many requests", "too many tokens"):
  // the quota of the day wins, so the order of the two checks is pinned here.
  for (const raw of [
    'Too many requests per day, please wait before trying again.',
    'Rate exceeded: daily token quota, too many tokens.',
    DAILY_RAW,
  ]) {
    assert.equal(providerLimitOf(httpError(429, upstreamLimitBody(raw))).kind, 'daily', raw);
  }
});

test('providerLimitOf: a 429 saying too many requests is kind rate', () => {
  for (const raw of [
    'Too many requests, please wait before trying again.',
    'Too many tokens, please wait before trying again.',
    'Rate exceeded: 5 requests per minute.',
  ]) {
    assert.deepEqual(
      providerLimitOf(httpError(429, upstreamLimitBody(raw))),
      { status: 429, limitSource: 'upstream_provider_account', provider: 'Amazon Bedrock', kind: 'rate' },
      raw,
    );
  }
});

test('providerLimitOf: upstream_provider_account without a raw text is kind unknown', () => {
  assert.deepEqual(providerLimitOf(httpError(429, upstreamLimitBody(undefined, 'Fournisseur Éclair'))), {
    status: 429,
    limitSource: 'upstream_provider_account',
    provider: 'Fournisseur Éclair',
    kind: 'unknown',
  });
  for (const raw of ['', null, 42, 'Le fournisseur est momentanément indisponible.']) {
    assert.equal(providerLimitOf(httpError(429, upstreamLimitBody(raw))).kind, 'unknown', String(raw));
  }
});

test('providerLimitOf: another status, an OpenRouter 429, no body or a body that is not JSON give kind null', () => {
  // The same provider body on another status: its fields are read, no kind.
  assert.deepEqual(providerLimitOf(httpError(503, upstreamLimitBody(DAILY_RAW))), {
    status: 503,
    limitSource: 'upstream_provider_account',
    provider: 'Amazon Bedrock',
    kind: null,
  });
  // OpenRouter's own 429, and a 429 whose limit sits anywhere but the provider account.
  assert.deepEqual(providerLimitOf(httpError(429, OPENROUTER_429)), { status: 429, ...NO_LIMIT });
  const elsewhere = JSON.stringify({ error: { code: 429, metadata: { limit_source: 'upstream', raw: DAILY_RAW } } });
  assert.deepEqual(providerLimitOf(httpError(429, elsewhere)), { status: 429, ...NO_LIMIT, limitSource: 'upstream' });
  // No body, a body that is not JSON, JSON of another shape.
  for (const body of [undefined, '', DAILY_RAW, 'null', '[]', JSON.stringify({ error: { metadata: 'x' } })]) {
    assert.deepEqual(providerLimitOf(httpError(429, body)), { status: 429, ...NO_LIMIT }, String(body));
  }
  // Not an HTTP answer at all: no numeric statusCode.
  for (const err of [undefined, null, new Error('fetch failed'), new DailyCapError('cap'), httpError('429', upstreamLimitBody(DAILY_RAW)), httpError(Number.NaN, '')]) {
    assert.equal(providerLimitOf(err), null);
  }
});

test('complete: a daily provider quota 429 is thrown after one attempt and logs llm: provider limit', async () => {
  let calls = 0;
  const state = fakeState();
  const body = upstreamLimitBody(DAILY_RAW);
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state,
    fetchImpl: async () => { calls += 1; return errorResponse(429, body); },
  });
  const { logs } = await withCapturedLogs(() =>
    assert.rejects(llm.complete([{ role: 'user', content: 'hi' }], { role: 'talk' }), (err) => {
      assert.equal(err.statusCode, 429, 'the turn runner still sees a 429');
      assert.equal(err.body, body, 'the untrimmed body stays on the error');
      assert.ok(err.message.startsWith('OpenRouter HTTP 429: '));
      return true;
    }),
  );
  assert.equal(calls, 1, 'a daily quota is not retried');
  assert.equal(state.data.llmCount, 1, 'one request counted');
  assert.equal(logs.filter((l) => l.msg === 'llm: retry').length, 0);
  const limits = logs.filter((l) => l.msg === 'llm: provider limit');
  assert.equal(limits.length, 1);
  const { level, time, msg, ...fields } = limits[0];
  assert.equal(level, 'warn');
  assert.equal(typeof time, 'string');
  assert.equal(msg, 'llm: provider limit');
  assert.deepEqual(fields, {
    role: 'talk',
    model: 'test-model',
    status: 429,
    limitSource: 'upstream_provider_account',
    provider: 'Amazon Bedrock',
    kind: 'daily',
    retried: false,
  });
  assert.ok(!JSON.stringify(logs).includes('per day'), 'the provider raw text is never logged');
});

test('complete: a rate 429, an unknown upstream 429 and an OpenRouter 429 are still retried llm.retries times', async () => {
  // The three run side by side, so the one real backoff sleep is shared.
  const bodies = {
    rate: upstreamLimitBody('Too many requests, please wait before trying again.'),
    unknown: upstreamLimitBody(undefined, 'Fournisseur Éclair'),
    openrouter: OPENROUTER_429,
  };
  const calls = { rate: 0, unknown: 0, openrouter: 0 };
  const llmFor = (name) => createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 1 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls[name] += 1; return errorResponse(429, bodies[name]); },
  });
  const { logs } = await withCapturedLogs(() =>
    Promise.all(
      Object.keys(bodies).map((name) =>
        assert.rejects(
          llmFor(name).complete([{ role: 'user', content: 'hi' }], { role: 'talk' }),
          (err) => err.statusCode === 429 && err.body === bodies[name],
        ),
      ),
    ),
  );
  assert.deepEqual(calls, { rate: 2, unknown: 2, openrouter: 2 }, 'one attempt plus llm.retries');
  assert.equal(logs.filter((l) => l.msg === 'llm: provider limit').length, 0);
  const retries = logs
    .filter((l) => l.msg === 'llm: retry')
    .map(({ level, time, msg, ...fields }) => fields)
    .sort((a, b) => (a.kind ?? '').localeCompare(b.kind ?? ''));
  assert.deepEqual(retries, [
    { attempt: 1, status: 429, name: 'Error' },
    { attempt: 1, status: 429, name: 'Error', limitSource: 'upstream_provider_account', provider: 'Amazon Bedrock', kind: 'rate' },
    { attempt: 1, status: 429, name: 'Error', limitSource: 'upstream_provider_account', provider: 'Fournisseur Éclair', kind: 'unknown' },
  ]);
});

test('complete: llm: retry carries kind when the body names one, never the raw text', async () => {
  const rateRaw = 'Too many tokens, please wait before trying again.';
  const bodies = [upstreamLimitBody(rateRaw), upstreamLimitBody(DAILY_RAW)];
  let calls = 0;
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig({ retries: 2 }),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => { calls += 1; return errorResponse(429, bodies[calls - 1]); },
  });
  const { logs } = await withCapturedLogs(() =>
    assert.rejects(
      llm.complete([{ role: 'user', content: 'hi' }], { role: 'talk' }),
      (err) => err.statusCode === 429 && err.body === bodies[1],
    ),
  );
  assert.equal(calls, 2, 'the rate limit was retried, the daily quota after it was not');
  const retries = logs.filter((l) => l.msg === 'llm: retry').map(({ level, time, msg, ...fields }) => fields);
  assert.deepEqual(retries, [
    { attempt: 1, status: 429, name: 'Error', limitSource: 'upstream_provider_account', provider: 'Amazon Bedrock', kind: 'rate' },
  ]);
  assert.deepEqual(logs.filter((l) => l.msg === 'llm: provider limit').map((l) => l.kind), ['daily']);
  const text = JSON.stringify(logs);
  for (const raw of [rateRaw, DAILY_RAW, 'please wait']) assert.ok(!text.includes(raw), raw);
});

// --- one `llm: usage` line per answered request, whatever its role ---

/** The `llm: usage` lines of `logs`, each reduced to its own fields (level/time/msg checked and dropped). */
function usageFields(logs) {
  return logs
    .filter((l) => l.msg === 'llm: usage')
    .map(({ level, time, msg, ...fields }) => {
      assert.equal(level, 'info');
      assert.equal(typeof time, 'string');
      assert.equal(msg, 'llm: usage');
      return fields;
    });
}

function jsonResponse(json) {
  return { ok: true, status: 200, json: async () => json };
}

const NO_USAGE = {
  provider: null,
  promptTokens: null,
  completionTokens: null,
  reasoningTokens: null,
  cachedTokens: null,
  cacheWriteTokens: null,
  cache: 'off',
  cost: null,
  upstreamCost: null,
  byok: null,
  id: null,
};

test('complete: an answered request logs exactly one llm: usage line filled from the response', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => jsonResponse({
      id: 'gen-1700000000-abc',
      provider: 'Google AI Studio',
      choices: [{ message: { content: 'the answer itself' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 150 },
        completion_tokens_details: { reasoning_tokens: 30 },
        cost: 0.0042,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0038 },
      },
    }),
  });
  const { result, logs } = await withCapturedLogs(() =>
    llm.complete([{ role: 'user', content: 'the prompt itself' }], { role: 'analyzer', model: 'google/gemini-x' }),
  );
  assert.equal(result.text, 'the answer itself');
  assert.equal(result.provider, 'Google AI Studio');
  assert.deepEqual(usageFields(logs), [{
    role: 'analyzer',
    model: 'google/gemini-x',
    provider: 'Google AI Studio',
    promptTokens: 1200,
    completionTokens: 80,
    reasoningTokens: 30,
    cachedTokens: 1000,
    cacheWriteTokens: 150,
    cache: 'off', // no marker was sent: the counts stay, the code says the bot did not ask for caching
    cost: 0.0042,
    upstreamCost: 0.0038,
    byok: true,
    id: 'gen-1700000000-abc',
  }]);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('the prompt itself') && !text.includes('the answer itself'), 'no prompt or answer text');
});

test('complete: a response without usage logs the usage line with nulls and still answers', async () => {
  for (const extra of [{}, { usage: null }, { usage: { prompt_tokens_details: null, completion_tokens_details: null, cost_details: null } }]) {
    const llm = createLlm({
      apiKey: 'k',
      getConfig: () => baseConfig(),
      calibrator: fakeCalibrator(),
      state: fakeState(),
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'hi' } }], ...extra }),
    });
    const { result, logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }]));
    assert.equal(result.text, 'hi', JSON.stringify(extra));
    assert.deepEqual(usageFields(logs), [{ role: null, model: 'test-model', ...NO_USAGE }], JSON.stringify(extra));
  }
});

test('complete: the usage line keeps numbers, booleans and ids only; a value of another type is null', async () => {
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async () => jsonResponse({
      id: { text: 'not an id' },
      provider: ['not a name'],
      choices: [{ message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 'many',
        completion_tokens: null,
        prompt_tokens_details: { cached_tokens: 'some', cache_write_tokens: [1] },
        completion_tokens_details: 'none',
        cost: '0.1',
        is_byok: 'yes',
        cost_details: { upstream_inference_cost: { value: 1 } },
      },
    }),
  });
  const { logs } = await withCapturedLogs(() => llm.complete([{ role: 'user', content: 'hi' }], { role: 7 }));
  assert.deepEqual(usageFields(logs), [{ role: null, model: 'test-model', ...NO_USAGE }]);
});

test('complete: a refused, failed or json.error request logs no usage line', async () => {
  const make = (fetchImpl, cfg = {}) =>
    createLlm({ apiKey: 'k', getConfig: () => baseConfig(cfg), calibrator: fakeCalibrator(), state: fakeState(), fetchImpl });
  const { logs } = await withCapturedLogs(async () => {
    await assert.rejects(make(async () => okResponse('x'), { maxRequestTokens: 1 }).complete([{ role: 'user', content: 'hi' }]));
    await assert.rejects(make(async () => errorResponse(400, 'bad request')).complete([{ role: 'user', content: 'hi' }]));
    await assert.rejects(make(async () => jsonResponse({ error: { message: 'refused' } })).complete([{ role: 'user', content: 'hi' }]));
  });
  assert.deepEqual(usageFields(logs), []);
});

test('complete: options.reasoning (a plain object) is sent verbatim as body.reasoning; anything else omits it', async () => {
  const bodies = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => baseConfig(),
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return okResponse('hi');
    },
  });
  await llm.complete([{ role: 'user', content: 'hi' }], { reasoning: { enabled: false } });
  await llm.complete([{ role: 'user', content: 'hi' }]);
  await llm.complete([{ role: 'user', content: 'hi' }], { reasoning: null });
  await llm.complete([{ role: 'user', content: 'hi' }], { reasoning: 'off' });
  await llm.complete([{ role: 'user', content: 'hi' }], { reasoning: ['x'] });
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
  for (const body of bodies.slice(1)) assert.equal('reasoning' in body, false);
});

// --- provider routing per model family (llm.providerByModel) ---

const BEDROCK = { only: ['amazon-bedrock'], allow_fallbacks: false };
const VERTEX = { only: ['google-vertex'] };

test('resolveProvider: a plain-object override wins over by-model and fallback', () => {
  const override = { order: ['x'] };
  const got = resolveProvider('anthropic/claude-opus-4.6', { override, byModel: { 'anthropic/': BEDROCK }, fallback: VERTEX });
  assert.equal(got, override);
});

test('resolveProvider: a by-model entry wins over the fallback', () => {
  const got = resolveProvider('anthropic/claude-opus-4.6', { byModel: { 'anthropic/': BEDROCK }, fallback: VERTEX });
  assert.equal(got, BEDROCK);
});

test('resolveProvider: the longest matching prefix is chosen, regardless of key order', () => {
  const exact = { only: ['anthropic'] };
  for (const byModel of [
    { 'anthropic/': BEDROCK, 'anthropic/claude-opus-4.6': exact },
    { 'anthropic/claude-opus-4.6': exact, 'anthropic/': BEDROCK },
  ]) {
    assert.equal(resolveProvider('anthropic/claude-opus-4.6', { byModel }), exact);
    assert.equal(resolveProvider('anthropic/claude-sonnet-4.6', { byModel }), BEDROCK);
  }
});

test('resolveProvider: a non-matching model falls to the fallback, then to nothing', () => {
  const byModel = { 'anthropic/': BEDROCK, 'google/': VERTEX };
  const fallback = { ignore: ['some-provider'] };
  assert.equal(resolveProvider('openai/gpt-x', { byModel, fallback }), fallback);
  assert.equal(resolveProvider('openai/gpt-x', { byModel }), undefined);
  assert.equal(resolveProvider('openai/gpt-x', { byModel, fallback: null }), undefined);
});

test('resolveProvider: keys are compared case-sensitively', () => {
  assert.equal(resolveProvider('anthropic/claude-opus-4.6', { byModel: { 'Anthropic/': BEDROCK } }), undefined);
});

test('resolveProvider: a non-object entry is ignored and a shorter valid prefix still matches', () => {
  const byModel = { 'anthropic/': BEDROCK, 'anthropic/claude-opus-4.6': ['amazon-bedrock'], 'anthropic/claude': null, 'anthropic/c': 'x' };
  assert.equal(resolveProvider('anthropic/claude-opus-4.6', { byModel }), BEDROCK);
  assert.equal(resolveProvider('anthropic/claude-opus-4.6', { byModel: { 'anthropic/': 'amazon-bedrock' }, fallback: VERTEX }), VERTEX);
});

test('resolveProvider: a non-object map, override or fallback is ignored; a non-string model skips the map', () => {
  for (const byModel of [null, undefined, 'anthropic/', ['anthropic/']]) {
    assert.equal(resolveProvider('anthropic/claude-opus-4.6', { byModel, override: ['x'], fallback: VERTEX }), VERTEX);
  }
  assert.equal(resolveProvider(undefined, { byModel: { '': BEDROCK }, fallback: VERTEX }), VERTEX);
  assert.equal(resolveProvider('anthropic/x', { byModel: { 'anthropic/': BEDROCK }, override: 'pinned', fallback: [1] }), BEDROCK);
  assert.equal(resolveProvider('anthropic/x'), undefined);
});

function capturingLlm(getConfig) {
  const bodies = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig,
    calibrator: fakeCalibrator(),
    state: fakeState(),
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return okResponse('hi');
    },
  });
  return { llm, bodies };
}

test('complete: precedence options.provider > llm.providerByModel (longest prefix) > llm.provider > none', async () => {
  const exact = { only: ['anthropic'] };
  const fallback = { ignore: ['some-provider'] };
  const pinned = { order: ['google-ai-studio'], allow_fallbacks: false };
  let cfg = baseConfig({
    model: 'anthropic/claude-opus-4.6',
    provider: fallback,
    providerByModel: { 'anthropic/': BEDROCK, 'anthropic/claude-opus-4.6': exact, 'google/': VERTEX },
  });
  const { llm, bodies } = capturingLlm(() => cfg);
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm.complete(msgs, { provider: pinned });
  await llm.complete(msgs);
  await llm.complete(msgs, { model: 'anthropic/claude-haiku-4.5' });
  await llm.complete(msgs, { model: 'google/gemini-3.8-flash', provider: null });
  await llm.complete(msgs, { model: 'openai/gpt-x' });
  cfg = baseConfig({ model: 'openai/gpt-x', provider: null, providerByModel: { 'anthropic/': BEDROCK } });
  await llm.complete(msgs);
  assert.deepEqual(bodies[0].provider, pinned);
  assert.deepEqual(bodies[1].provider, exact);
  assert.deepEqual(bodies[2].provider, BEDROCK);
  assert.deepEqual(bodies[3].provider, VERTEX);
  assert.deepEqual(bodies[4].provider, fallback);
  assert.equal('provider' in bodies[5], false);
});

test('complete: an invalid llm.providerByModel entry is ignored and llm.provider applies', async () => {
  const fallback = { ignore: ['some-provider'] };
  const { llm, bodies } = capturingLlm(() => baseConfig({
    model: 'anthropic/claude-opus-4.6',
    provider: fallback,
    providerByModel: { 'anthropic/': ['amazon-bedrock'], 'anthropic/claude-opus-4.6': 'amazon-bedrock' },
  }));
  await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(bodies[0].provider, fallback);
});

test('complete: llm.providerByModel is read fresh on every call (hot-reloadable)', async () => {
  let providerByModel = { 'anthropic/': BEDROCK };
  const { llm, bodies } = capturingLlm(() => baseConfig({ model: 'anthropic/claude-opus-4.6', providerByModel }));
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm.complete(msgs);
  providerByModel = { 'anthropic/': { only: ['anthropic'] } };
  await llm.complete(msgs);
  providerByModel = {};
  await llm.complete(msgs);
  assert.deepEqual(bodies[0].provider, BEDROCK);
  assert.deepEqual(bodies[1].provider, { only: ['anthropic'] });
  assert.equal('provider' in bodies[2], false);
});

// --- role-aware routes (`<prefix>@<role>` keys in llm.providerByModel) ---

const STUDIO = { only: ['google-ai-studio'], allow_fallbacks: false };

test('resolveProvider: a role key beats a role-less key, even when the role-less prefix is longer', () => {
  const byModel = { 'google/gemini-3.8-flash': VERTEX, 'google/@classifier.video': STUDIO };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'classifier.video' }), STUDIO);
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'talk' }), VERTEX);
});

test('resolveProvider: the longest prefix wins within the role group, regardless of key order', () => {
  const exact = { only: ['google'] };
  for (const byModel of [
    { 'google/@talk': VERTEX, 'google/gemini-3.8-flash@talk': exact },
    { 'google/gemini-3.8-flash@talk': exact, 'google/@talk': VERTEX },
  ]) {
    assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'talk' }), exact);
    assert.equal(resolveProvider('google/gemini-3.8-pro', { byModel, role: 'talk' }), VERTEX);
  }
});

test('resolveProvider: a role key whose prefix does not match falls to the role-less group', () => {
  const byModel = { 'anthropic/@talk': BEDROCK, 'google/': VERTEX };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'talk' }), VERTEX);
});

test('resolveProvider: a key for another role never applies; the fallback does', () => {
  const fallback = { ignore: ['some-provider'] };
  const byModel = { 'google/@classifier.video': STUDIO };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'talk', fallback }), fallback);
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'talk' }), undefined);
});

test('resolveProvider: without a role (or with a non-string one) only role-less keys match', () => {
  const byModel = { 'google/@talk': STUDIO, 'google/': VERTEX };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel }), VERTEX);
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 42 }), VERTEX);
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel: { 'google/@talk': STUDIO } }), undefined);
});

test('resolveProvider: the per-call override wins over a role key', () => {
  const pinned = { order: ['google-ai-studio'], allow_fallbacks: false };
  const byModel = { 'google/@classifier.video': VERTEX };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { override: pinned, byModel, role: 'classifier.video' }), pinned);
});

test('resolveProvider: a non-object role entry is ignored and the role-less group still applies', () => {
  const byModel = { 'google/@talk': 'google-ai-studio', 'google/': VERTEX };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'talk' }), VERTEX);
});

test('resolveProvider: an empty prefix with a role matches every model for that role', () => {
  const byModel = { '@mentor': STUDIO, 'google/': VERTEX };
  assert.equal(resolveProvider('google/gemini-3.8-flash', { byModel, role: 'mentor' }), STUDIO);
  assert.equal(resolveProvider('openai/gpt-x', { byModel, role: 'mentor' }), STUDIO);
});

test('matchRoute: names the matching key and its role, or null', () => {
  const byModel = { 'google/': VERTEX, 'google/@classifier.video': STUDIO };
  assert.deepEqual(matchRoute('google/gemini-3.8-flash', byModel, 'classifier.video'), {
    key: 'google/@classifier.video', prefix: 'google/', role: 'classifier.video', value: STUDIO,
  });
  assert.deepEqual(matchRoute('google/gemini-3.8-flash', byModel, 'talk'), { key: 'google/', prefix: 'google/', role: null, value: VERTEX });
  assert.equal(matchRoute('openai/gpt-x', byModel, 'talk'), null);
});

test('parseRouteKey: splits at the last @; a key without one has no role', () => {
  assert.deepEqual(parseRouteKey('google/'), { prefix: 'google/', role: null });
  assert.deepEqual(parseRouteKey('google/@classifier.video'), { prefix: 'google/', role: 'classifier.video' });
  assert.deepEqual(parseRouteKey('@talk'), { prefix: '', role: 'talk' });
});

test('complete: options.role selects the role key; a call without a role uses the role-less key', async () => {
  const fallback = { ignore: ['some-provider'] };
  const { llm, bodies } = capturingLlm(() => baseConfig({
    model: 'google/gemini-3.8-flash',
    provider: fallback,
    providerByModel: { 'google/gemini-3.8-flash': VERTEX, 'google/@classifier.video': STUDIO },
  }));
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm.complete(msgs, { role: 'classifier.video' });
  await llm.complete(msgs, { role: 'talk' });
  await llm.complete(msgs);
  await llm.complete(msgs, { role: 'classifier.video', provider: { order: ['x'] } });
  await llm.complete(msgs, { role: 'talk', model: 'openai/gpt-x' });
  assert.deepEqual(bodies[0].provider, STUDIO);
  assert.deepEqual(bodies[1].provider, VERTEX);
  assert.deepEqual(bodies[2].provider, VERTEX);
  assert.deepEqual(bodies[3].provider, { order: ['x'] });
  assert.deepEqual(bodies[4].provider, fallback);
  assert.equal('role' in bodies[0], false, 'the role is never sent to OpenRouter');
});

test('complete: without any route, a role changes nothing (llm.provider, else no field)', async () => {
  let cfg = baseConfig({ model: 'google/gemini-3.8-flash', provider: VERTEX, providerByModel: {} });
  const { llm, bodies } = capturingLlm(() => cfg);
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm.complete(msgs, { role: 'talk' });
  cfg = baseConfig({ model: 'google/gemini-3.8-flash', provider: null });
  await llm.complete(msgs, { role: 'talk' });
  assert.deepEqual(bodies[0].provider, VERTEX);
  assert.equal('provider' in bodies[1], false);
});

// --- prompt caching: the marker on the system message, the full prompt count, the usage code ---

/** config.json's `llm.cache` (no `models`: the code's fallback, `['anthropic/']`, applies). */
const CACHE = { ttl: '1h', roles: ['talk'], promptIncludesCached: true };

/** A model id of the family `llm.cache.models` admits by default. */
const LISTED_MODEL = 'anthropic/claude-test-4';
/** A model id outside it. */
const UNLISTED_MODEL = 'openai/gpt-test-5';

/**
 * A config with `features.promptCache` (on by default here), `llm.cache` as given and a talk
 * model of the listed family (`LISTED_MODEL`) unless `model` says otherwise.
 */
function cachingConfig({ promptCache = true, cache = CACHE, ...llm } = {}) {
  return { ...baseConfig({ maxRequestTokens: 50000, model: LISTED_MODEL, ...llm, cache }), features: { promptCache } };
}

const SYSTEM_TEXT = 'Tu es la persona du salon : réponds brièvement, sans en faire trop.';
const USER_TEXT = '<chat>\nΚαλημέρα σε όλους\n</chat>';
const MARK_1H = { type: 'ephemeral', ttl: '1h' };
const MARK_5M = { type: 'ephemeral' };

/** A reply-shaped request: one string system message, one string user message (fresh each call). */
function replyMessages() {
  return [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: USER_TEXT },
  ];
}

/** The parts of `messages` that carry a `cache_control`. */
function markedParts(messages) {
  return messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => 'cache_control' in p);
}

/**
 * The real client over a fetch that keeps every sent body as the exact string, answering with
 * `usage` (an object, or a function of the 0-based call number).
 */
function cachingLlm(getConfig, { usage = { prompt_tokens: 42 }, calibrator = fakeCalibrator() } = {}) {
  const sent = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig,
    calibrator,
    state: fakeState(),
    fetchImpl: async (url, init) => {
      sent.push(init.body);
      const answer = typeof usage === 'function' ? usage(sent.length - 1) : usage;
      return okResponse('hi', answer);
    },
  });
  return { llm, sent, bodies: () => sent.map((s) => JSON.parse(s)) };
}

test('cacheTtlFor: no marker unless features.promptCache is exactly true', () => {
  assert.equal(cacheTtlFor(cachingConfig(), 'talk', LISTED_MODEL), '1h');
  for (const promptCache of [false, undefined, null, 'true', 1, {}]) {
    assert.equal(cacheTtlFor({ ...cachingConfig(), features: { promptCache } }, 'talk', LISTED_MODEL), null, String(promptCache));
  }
  for (const config of [undefined, null, {}, { features: {} }, baseConfig({ cache: CACHE })]) {
    assert.equal(cacheTtlFor(config, 'talk', LISTED_MODEL), null, JSON.stringify(config));
  }
});

test('cacheTtlFor: a role outside llm.cache.roles gets none; a non-array roles reads as talk only', () => {
  for (const role of ['analyzer', 'classifier.text', 'mentor', undefined, null, 7]) {
    assert.equal(cacheTtlFor(cachingConfig(), role, LISTED_MODEL), null, String(role));
  }
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, roles: ['talk', 'analyzer'] } }), 'analyzer', LISTED_MODEL), '1h');
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, roles: [] } }), 'talk', LISTED_MODEL), null, 'an empty list marks nothing');
  for (const roles of [undefined, null, 'analyzer', { analyzer: true }]) {
    const config = cachingConfig({ cache: { ...CACHE, roles } });
    assert.equal(cacheTtlFor(config, 'talk', LISTED_MODEL), '1h', JSON.stringify(roles));
    assert.equal(cacheTtlFor(config, 'analyzer', LISTED_MODEL), null, JSON.stringify(roles));
  }
  const noCacheBlock = { ...baseConfig(), features: { promptCache: true } };
  assert.equal(cacheTtlFor(noCacheBlock, 'talk', LISTED_MODEL), '1h', 'a missing llm.cache reads as config.json: 1h, talk');
  assert.equal(cacheTtlFor(noCacheBlock, 'analyzer', LISTED_MODEL), null);
});

test('cacheTtlFor: a model outside llm.cache.models gets no marker; a non-array models reads as anthropic/ only', () => {
  // the fallback: Anthropic's ids only, whatever the switch and the role say
  for (const model of [UNLISTED_MODEL, 'google/gemini-test', 'Anthropic/claude-test-4', 'claude-test-4', '', undefined, null, 7]) {
    assert.equal(cacheTtlFor(cachingConfig(), 'talk', model), null, String(model));
  }
  for (const models of [undefined, null, 'openai/', { 'openai/': true }]) {
    const config = cachingConfig({ cache: { ...CACHE, models } });
    assert.equal(cacheTtlFor(config, 'talk', LISTED_MODEL), '1h', JSON.stringify(models));
    assert.equal(cacheTtlFor(config, 'talk', UNLISTED_MODEL), null, JSON.stringify(models));
  }
  // a listed prefix admits its family; an empty list marks nothing; a non-string entry matches nothing
  const both = cachingConfig({ cache: { ...CACHE, models: ['anthropic/', 'openai/'] } });
  assert.equal(cacheTtlFor(both, 'talk', UNLISTED_MODEL), '1h');
  assert.equal(cacheTtlFor(both, 'talk', 'google/gemini-test'), null);
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, models: [] } }), 'talk', LISTED_MODEL), null);
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, models: [null, 7, { a: 1 }] } }), 'talk', LISTED_MODEL), null);
  // the role gate still applies to a listed model
  assert.equal(cacheTtlFor(cachingConfig(), 'analyzer', LISTED_MODEL), null);
});

test('cacheTtlFor: an unknown ttl reads as 1h; force true and false override the policy', () => {
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, ttl: '5m' } }), 'talk', LISTED_MODEL), '5m');
  for (const ttl of [undefined, null, '1h', '10m', '5M', 300]) {
    assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, ttl } }), 'talk', LISTED_MODEL), '1h', String(ttl));
  }
  // true marks whatever the switch, the role list and the model list say (the cache probe sends it with the switch off)
  assert.equal(cacheTtlFor(baseConfig(), 'mentor', 'test-model', true), '1h');
  assert.equal(cacheTtlFor({ llm: { cache: { ttl: '5m' } } }, undefined, undefined, true), '5m');
  assert.equal(cacheTtlFor(cachingConfig({ promptCache: false }), 'talk', LISTED_MODEL, true), '1h');
  assert.equal(cacheTtlFor(cachingConfig({ cache: { ...CACHE, models: [] } }), 'talk', UNLISTED_MODEL, true), '1h');
  // false forbids it on a listed role and model with the switch on
  assert.equal(cacheTtlFor(cachingConfig(), 'talk', LISTED_MODEL, false), null);
  // anything else leaves the policy in charge
  for (const force of [undefined, null, 'true', 1]) {
    assert.equal(cacheTtlFor(cachingConfig(), 'talk', LISTED_MODEL, force), '1h', String(force));
    assert.equal(cacheTtlFor(cachingConfig(), 'analyzer', LISTED_MODEL, force), null, String(force));
    assert.equal(cacheTtlFor(cachingConfig(), 'talk', UNLISTED_MODEL, force), null, String(force));
  }
});

test('fullPromptTokens: prompt_tokens as reported by default; plus cached and cache-write tokens when llm.cache.promptIncludesCached is false', () => {
  const usage = { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 8500, cache_write_tokens: 300 } };
  const includes = [
    undefined,
    {},
    baseConfig(),
    cachingConfig(),
    cachingConfig({ cache: { ...CACHE, promptIncludesCached: undefined } }),
    cachingConfig({ cache: { ...CACHE, promptIncludesCached: 'no' } }),
  ];
  for (const config of includes) assert.equal(fullPromptTokens(usage, config, true), 1200, JSON.stringify(config));
  const net = cachingConfig({ cache: { ...CACHE, promptIncludesCached: false } });
  assert.equal(fullPromptTokens(usage, net, true), 10000);
  assert.equal(fullPromptTokens({ prompt_tokens: 1200 }, net, true), 1200, 'no details add nothing');
  assert.equal(
    fullPromptTokens({ prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 'many', cache_write_tokens: -5 } }, net, true),
    1200,
    'a detail that is not a count adds nothing',
  );
  assert.equal(fullPromptTokens({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 900 } }, net, true), 900);
});

test('fullPromptTokens: an unmarked request keeps prompt_tokens as reported even under promptIncludesCached false', () => {
  // A provider that caches on its own (no marker sent) already counts its cached tokens inside
  // prompt_tokens: adding them back would count them twice.
  const usage = { prompt_tokens: 20000, prompt_tokens_details: { cached_tokens: 5000, cache_write_tokens: 300 } };
  const net = cachingConfig({ cache: { ...CACHE, promptIncludesCached: false } });
  for (const marked of [false, undefined, null, 'true', 1]) {
    assert.equal(fullPromptTokens(usage, net, marked), 20000, String(marked));
  }
  assert.equal(fullPromptTokens(usage, net, true), 25300, 'only a marked request is read by the probed route');
});

test('fullPromptTokens: no reported prompt count gives null', () => {
  const net = cachingConfig({ cache: { ...CACHE, promptIncludesCached: false } });
  for (const usage of [undefined, null, 5, {}, { prompt_tokens: 0 }, { prompt_tokens: 'many' }, { prompt_tokens: Number.NaN }, { prompt_tokens: -3 }, { prompt_tokens: Infinity }]) {
    assert.equal(fullPromptTokens(usage, cachingConfig(), true), null, JSON.stringify(usage));
  }
  assert.equal(fullPromptTokens({ prompt_tokens_details: { cached_tokens: 900 } }, net, true), null, 'details without a prompt count are no count');
  assert.equal(fullPromptTokens({ prompt_tokens: 0 }, net, true), null);
  assert.equal(fullPromptTokens({ prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 900 } }, net, false), null, 'unmarked: nothing is added back');
});

test('withCacheMarker: a string system message becomes one text part with the same text and the marker', () => {
  const messages = replyMessages();
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(sent, [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_1H }] },
    { role: 'user', content: USER_TEXT },
  ]);
  assert.equal(sent[1], messages[1], 'the user message is passed on as it is');
});

test('withCacheMarker: 5m sends type ephemeral without ttl, 1h adds ttl 1h', () => {
  assert.deepEqual(withCacheMarker(replyMessages(), '5m')[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_5M }]);
  assert.deepEqual(withCacheMarker(replyMessages(), '1h')[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_1H }]);
});

test('withCacheMarker: an array system content gets the marker on its last text part', () => {
  const picture = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'première partie' }, { type: 'text', text: 'dernière partie' }, picture] },
    { role: 'user', content: USER_TEXT },
  ];
  const sent = withCacheMarker(messages, '1h');
  assert.deepEqual(sent[0].content, [
    { type: 'text', text: 'première partie' },
    { type: 'text', text: 'dernière partie', cache_control: MARK_1H },
    picture,
  ]);
  assert.equal(sent[1], messages[1]);
});

test('withCacheMarker: a request without a system message is unchanged', () => {
  const plain = [{ role: 'user', content: 'Γεια σου' }];
  assert.deepEqual(withCacheMarker(plain, '1h'), [{ role: 'user', content: 'Γεια σου' }]);
  assert.deepEqual(withCacheMarker(plain, '5m'), [{ role: 'user', content: 'Γεια σου' }]);
  // an empty system text gets no marker either: an empty block carrying a marker would be refused
  const empty = [{ role: 'system', content: '' }, { role: 'user', content: 'Γεια σου' }];
  assert.deepEqual(withCacheMarker(empty, '1h'), [{ role: 'system', content: '' }, { role: 'user', content: 'Γεια σου' }]);
  const noText = [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }];
  assert.deepEqual(markedParts(withCacheMarker(noText, '1h')), []);
});

test("withCacheMarker: the caller's messages and parts are never mutated", () => {
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'bloc stable', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: USER_TEXT },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      ],
    },
  ];
  const before = structuredClone(messages);
  const first = withCacheMarker(messages, '5m');
  withCacheMarker(messages, '1h');
  withCacheMarker(messages, null);
  assert.deepEqual(messages, before);
  // two markers of one result are separate objects: a later change to one never reaches the other
  const [systemMark, userMark] = markedParts(first).map((p) => p.cache_control);
  assert.notEqual(systemMark, userMark);
});

test('withCacheMarker: without a ttl every builder-placed cache_control is stripped', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    { role: 'user', content: [{ type: 'text', text: 'bloc stable', cache_control: { type: 'ephemeral' } }, { type: 'text', text: USER_TEXT }] },
  ];
  for (const ttl of [null, undefined, '2h']) {
    assert.deepEqual(withCacheMarker(messages, ttl), [
      { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT }] },
      { role: 'user', content: [{ type: 'text', text: 'bloc stable' }, { type: 'text', text: USER_TEXT }] },
    ], String(ttl));
  }
  // nothing to strip: the very same messages come back, a string system content stays a string
  const plain = replyMessages();
  assert.equal(withCacheMarker(plain, null), plain);
});

test('withCacheMarker: a builder-placed marker takes the configured ttl', () => {
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: [{ type: 'text', text: 'bloc stable', cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: USER_TEXT }] },
  ];
  const sent = withCacheMarker(messages, '5m');
  assert.deepEqual(sent[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_5M }]);
  assert.deepEqual(sent[1].content, [{ type: 'text', text: 'bloc stable', cache_control: MARK_5M }, { type: 'text', text: USER_TEXT }]);
});

test('withCacheMarker: no more than four markers are sent', () => {
  const letters = ['α', 'β', 'γ', 'δ', 'ε'];
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: letters.map((text) => ({ type: 'text', text, cache_control: { type: 'ephemeral' } })) },
  ];
  const sent = withCacheMarker(messages, '5m');
  assert.equal(markedParts(sent).length, 4);
  assert.deepEqual(sent[0].content[0].cache_control, MARK_5M, 'the system marker comes first in message order');
  assert.deepEqual(sent[1].content.map((p) => 'cache_control' in p), [true, true, true, false, false]);
  assert.deepEqual(sent[1].content.map((p) => p.text), letters, 'the text is kept on every part');
  // without a system message the first four builder markers survive
  assert.deepEqual(withCacheMarker([messages[1]], '1h')[0].content.map((p) => 'cache_control' in p), [true, true, true, true, false]);
});

test('complete: with promptCache on, a talk request carries the marker on the system part and the user message is sent unchanged', async () => {
  let config = cachingConfig();
  const { llm, bodies } = cachingLlm(() => config);
  await llm.complete(replyMessages(), { role: 'talk' });
  config = cachingConfig({ cache: { ...CACHE, ttl: '5m' } });
  await llm.complete(replyMessages(), { role: 'talk' });
  const [hour, minutes] = bodies();
  assert.deepEqual(hour.messages, [
    { role: 'system', content: [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_1H }] },
    { role: 'user', content: USER_TEXT },
  ]);
  assert.deepEqual(minutes.messages[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_5M }]);
  assert.deepEqual(minutes.messages[1], { role: 'user', content: USER_TEXT });
  for (const body of [hour, minutes]) {
    assert.equal('cache_control' in body, false, 'no top-level marker: it would put the breakpoint after the whole prompt');
    assert.equal(markedParts(body.messages).length, 1);
  }
});

test('complete: a classifier.text request carries no marker even with promptCache on', async () => {
  const { llm, sent } = cachingLlm(() => cachingConfig());
  for (const role of ['classifier.text', 'analyzer', 'mentor', undefined]) {
    await llm.complete(replyMessages(), { role });
  }
  assert.equal(sent.length, 4);
  for (const body of sent) {
    assert.deepEqual(JSON.parse(body).messages, replyMessages());
    assert.ok(!body.includes('cache_control'));
  }
});

test("complete: with promptCache off or the role not listed the body is byte-identical to today's", async () => {
  const messages = [
    { role: 'system', content: SYSTEM_TEXT },
    { role: 'user', content: [{ type: 'text', text: USER_TEXT }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
  ];
  const today = (model) => JSON.stringify({ model, messages, temperature: 1, max_tokens: 100 });
  const configs = [
    baseConfig({ maxRequestTokens: 50000 }),
    cachingConfig({ promptCache: false }),
    { ...cachingConfig(), features: {} },
    { ...cachingConfig(), features: { promptCache: 'true' } },
  ];
  for (const config of configs) {
    const { llm, sent } = cachingLlm(() => config);
    for (const role of ['talk', 'analyzer', 'classifier.text', 'mentor', undefined]) await llm.complete(messages, { role });
    for (const body of sent) assert.equal(body, today(config.llm.model));
  }
  const { llm, sent } = cachingLlm(() => cachingConfig());
  for (const role of ['analyzer', 'classifier.text', 'classifier.media', 'mentor', undefined]) await llm.complete(messages, { role });
  for (const body of sent) assert.equal(body, today(LISTED_MODEL));
});

test('complete: a talk request on a non-listed model is byte-identical with promptCache on', async () => {
  const messages = replyMessages();
  const today = (model) => JSON.stringify({ model, messages, temperature: 1, max_tokens: 100 });
  // the configured talk model hot-switched to another family, or another model passed for one call
  let config = cachingConfig({ model: UNLISTED_MODEL });
  const { llm, sent } = cachingLlm(() => config);
  await llm.complete(messages, { role: 'talk' });
  config = cachingConfig();
  await llm.complete(messages, { role: 'talk', model: UNLISTED_MODEL });
  config = cachingConfig({ model: UNLISTED_MODEL, cache: { ...CACHE, models: ['anthropic/'] } });
  await llm.complete(messages, { role: 'talk' });
  assert.deepEqual(sent, [today(UNLISTED_MODEL), today(UNLISTED_MODEL), today(UNLISTED_MODEL)]);
  // a listed family marks the same request, and a list naming the other family marks it too
  await llm.complete(messages, { role: 'talk', model: LISTED_MODEL });
  config = cachingConfig({ model: UNLISTED_MODEL, cache: { ...CACHE, models: ['openai/'] } });
  await llm.complete(messages, { role: 'talk' });
  assert.deepEqual(sent.slice(3).map((body) => markedParts(JSON.parse(body).messages).length), [1, 1]);
});

test('complete: options.cache false forbids the marker and true forces it', async () => {
  let config = cachingConfig();
  const { llm, bodies } = cachingLlm(() => config);
  await llm.complete(replyMessages(), { role: 'talk', cache: false });
  // no features.promptCache at all, and a model outside llm.cache.models: the force wins over both
  config = baseConfig({ maxRequestTokens: 50000, cache: { ...CACHE, ttl: '5m' } });
  await llm.complete(replyMessages(), { role: 'classifier.text', cache: true });
  await llm.complete(replyMessages(), { role: 'talk' });
  const [forbidden, forced, policy] = bodies();
  assert.deepEqual(forbidden.messages, replyMessages());
  assert.deepEqual(forced.messages[0].content, [{ type: 'text', text: SYSTEM_TEXT, cache_control: MARK_5M }]);
  assert.deepEqual(policy.messages, replyMessages(), 'the force is for one call only');
});

test('complete: a request without a system message is sent unchanged with promptCache on', async () => {
  const { llm, sent } = cachingLlm(() => cachingConfig());
  const messages = [{ role: 'user', content: 'Γεια σου' }];
  await llm.complete(messages, { role: 'talk' });
  await llm.complete(messages, { role: 'talk', cache: true });
  for (const body of sent) {
    assert.equal(body, JSON.stringify({ model: LISTED_MODEL, messages, temperature: 1, max_tokens: 100 }));
  }
});

test('complete: the cache policy is read from the live config on every call', async () => {
  let config = cachingConfig({ promptCache: false });
  const { llm, bodies } = cachingLlm(() => config);
  await llm.complete(replyMessages(), { role: 'talk' });
  config = cachingConfig();
  await llm.complete(replyMessages(), { role: 'talk' });
  config = cachingConfig({ cache: { ...CACHE, roles: ['analyzer'] } });
  await llm.complete(replyMessages(), { role: 'talk' });
  assert.deepEqual(bodies().map((b) => markedParts(b.messages).length), [0, 1, 0]);
});

test('complete: the estimate and the token cap check are the same with and without a marker', async () => {
  const applied = [];
  const calibrator = { ...fakeCalibrator(), apply: (n) => { applied.push(n); return n; } };
  let config = cachingConfig({ promptCache: false });
  const { llm, sent } = cachingLlm(() => config, { calibrator });
  const plain = await llm.complete(replyMessages(), { role: 'talk' });
  config = cachingConfig();
  const marked = await llm.complete(replyMessages(), { role: 'talk' });
  assert.equal(markedParts(JSON.parse(sent[1]).messages).length, 1, 'the second request did carry the marker');
  assert.equal(marked.estimated, plain.estimated);
  assert.deepEqual(applied, [plain.estimated, plain.estimated], 'the estimator saw the same raw count');
  // the cap at exactly the estimate lets both through; one below refuses both before any fetch
  for (const promptCache of [false, true]) {
    config = cachingConfig({ promptCache, maxRequestTokens: plain.estimated });
    await llm.complete(replyMessages(), { role: 'talk' });
    config = cachingConfig({ promptCache, maxRequestTokens: plain.estimated - 1 });
    await assert.rejects(llm.complete(replyMessages(), { role: 'talk' }), (err) => {
      assert.ok(err instanceof TokenLimitError);
      assert.equal(err.used, plain.estimated);
      return true;
    });
  }
  assert.equal(sent.length, 4, 'only the requests under the cap were sent');
});

test('complete: llm: usage carries cache read, write, none or off from the usage fields', async () => {
  const usages = {
    read: { prompt_tokens: 9300, prompt_tokens_details: { cached_tokens: 8900, cache_write_tokens: 0 } },
    write: { prompt_tokens: 9300, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 8900 } },
    both: { prompt_tokens: 9300, prompt_tokens_details: { cached_tokens: 8900, cache_write_tokens: 200 } },
    none: { prompt_tokens: 9300, prompt_tokens_details: { cached_tokens: 0 } },
    bare: { prompt_tokens: 9300 },
  };
  const order = Object.keys(usages);
  let config = cachingConfig();
  const { llm } = cachingLlm(() => config, { usage: (call) => usages[order[call]] ?? usages.read });
  const { logs } = await withCapturedLogs(async () => {
    for (let i = 0; i < order.length; i += 1) await llm.complete(replyMessages(), { role: 'talk' });
    await llm.complete(replyMessages(), { role: 'classifier.text' }); // a read reported, no marker sent
    await llm.complete([{ role: 'user', content: 'Γεια σου' }], { role: 'talk' }); // nothing to mark
    config = cachingConfig({ promptCache: false });
    await llm.complete(replyMessages(), { role: 'talk' });
  });
  const lines = usageFields(logs);
  assert.deepEqual(lines.map((l) => l.cache), ['read', 'write', 'read', 'none', 'none', 'off', 'off', 'off']);
  assert.deepEqual(lines.map((l) => [l.cachedTokens, l.cacheWriteTokens]).slice(0, 2), [[8900, 0], [0, 8900]]);
  assert.equal(lines[5].cachedTokens, 8900, 'the counts are logged whether or not a marker was sent');
  const text = JSON.stringify(logs);
  assert.ok(!text.includes('persona du salon') && !text.includes('Καλημέρα'), 'counts and codes only, never prompt text');
});

test('complete: the calibrator observes the full prompt count when the usage reports cached tokens', async () => {
  // Under both readings of llm.cache.promptIncludesCached: as reported (true, the default) or
  // net of the cache (false: the cached and written tokens are added back).
  const usage = { prompt_tokens: 600, prompt_tokens_details: { cached_tokens: 8500, cache_write_tokens: 200 } };
  const cases = [
    [CACHE, 600],
    [{ ttl: '1h', roles: ['talk'] }, 600],
    [{ ...CACHE, promptIncludesCached: false }, 9300],
  ];
  for (const [cache, counted] of cases) {
    const calibrator = fakeCalibrator();
    const { llm } = cachingLlm(() => cachingConfig({ cache }), { usage, calibrator });
    const result = await llm.complete(replyMessages(), { role: 'talk' });
    assert.deepEqual(calibrator.observed, [[result.estimated, counted]], JSON.stringify(cache));
    assert.equal(result.promptTokens, counted, 'the caller gets the same full count');
  }
  // skipCalibration still feeds nothing, and still returns the full count
  const calibrator = fakeCalibrator();
  const { llm } = cachingLlm(() => cachingConfig({ cache: { ...CACHE, promptIncludesCached: false } }), { usage, calibrator });
  const skipped = await llm.complete(replyMessages(), { role: 'talk', skipCalibration: true });
  assert.deepEqual(calibrator.observed, []);
  assert.equal(skipped.promptTokens, 9300);
  // no usage count: null
  const { llm: bare } = cachingLlm(() => cachingConfig(), { usage: {} });
  assert.equal((await bare.complete(replyMessages(), { role: 'talk' })).promptTokens, null);
});

test('complete: an unmarked request reporting cached tokens feeds prompt_tokens unchanged under promptIncludesCached false', async () => {
  // An analyzer on a provider that caches on its own: no marker sent, cached tokens already inside prompt_tokens.
  const usage = { prompt_tokens: 20000, prompt_tokens_details: { cached_tokens: 5000, cache_write_tokens: 0 } };
  const net = { ...CACHE, promptIncludesCached: false };
  const cases = [
    [cachingConfig({ cache: net }), { role: 'analyzer' }],
    [cachingConfig({ cache: net, model: UNLISTED_MODEL }), { role: 'talk' }],
    [cachingConfig({ cache: net }), { role: 'talk', cache: false }],
    [cachingConfig({ cache: net, promptCache: false }), { role: 'talk' }],
  ];
  for (const [config, options] of cases) {
    const calibrator = fakeCalibrator();
    const { llm, sent } = cachingLlm(() => config, { usage, calibrator });
    const result = await llm.complete(replyMessages(), options);
    assert.ok(!sent[0].includes('cache_control'), JSON.stringify(options));
    assert.deepEqual(calibrator.observed, [[result.estimated, 20000]], JSON.stringify(options));
    assert.equal(result.promptTokens, 20000);
  }
  // the same answer to a marked request is read as net of the cache
  const calibrator = fakeCalibrator();
  const { llm } = cachingLlm(() => cachingConfig({ cache: net }), { usage, calibrator });
  const marked = await llm.complete(replyMessages(), { role: 'talk' });
  assert.deepEqual(calibrator.observed, [[marked.estimated, 25000]]);
});

test('complete: the token-cap warning uses the same full prompt count', async () => {
  const usage = { prompt_tokens: 800, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 0 } };
  const warned = async (promptIncludesCached) => {
    const { llm } = cachingLlm(() => cachingConfig({ maxRequestTokens: 1000, cache: { ...CACHE, promptIncludesCached } }), { usage });
    const { logs } = await withCapturedLogs(() => llm.complete(replyMessages(), { role: 'talk' }));
    return logs.filter((l) => l.msg === 'llm: provider counted more prompt tokens than the cap').length;
  };
  assert.equal(await warned(true), 0, '800 as reported is under the cap of 1000');
  assert.equal(await warned(false), 1, '800 + 600 counted back is over it');
});

// --- shared transport helpers (also used by src/llm/images.js) ---

test('apiUrl: joins the base URL and a path with exactly one slash', () => {
  assert.equal(apiUrl('https://example.com/v1', 'images'), 'https://example.com/v1/images');
  assert.equal(apiUrl('https://example.com/v1//', 'chat/completions'), 'https://example.com/v1/chat/completions');
  assert.equal(apiUrl('https://example.com/v1/', '/images'), 'https://example.com/v1/images');
});

test('openRouterHeaders: bearer key, JSON body and the neutral X-Title', () => {
  assert.deepEqual(openRouterHeaders('k1'), {
    Authorization: 'Bearer k1',
    'Content-Type': 'application/json',
    'X-Title': 'neptunia-bot',
  });
});

test('backoffMs: 1.5 s before the first retry, doubling after that', () => {
  assert.deepEqual([1, 2, 3, 4].map(backoffMs), [1500, 3000, 6000, 12000]);
});

test('RETRY_STATUS: timeouts, rate limits and gateway errors are retried; client errors are not', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(RETRY_STATUS.has(status), true, String(status));
  for (const status of [400, 401, 403, 404]) assert.equal(RETRY_STATUS.has(status), false, String(status));
});

test('sleep: resolves after the timer', async () => {
  const started = Date.now();
  await sleep(5);
  assert.ok(Date.now() - started >= 4);
});

// ---------------------------------------------------------------------------
// modelEndpoints: the free listing GET of /nep ping image
// ---------------------------------------------------------------------------

test('modelEndpoints: one GET of the listing with the key and a timeout; nothing counted, nothing calibrated', async () => {
  const calls = [];
  const state = fakeState();
  const calibrator = fakeCalibrator();
  const body = { data: { architecture: { output_modalities: ['image'] }, endpoints: [{}] } };
  const llm = createLlm({
    apiKey: 'k-test',
    getConfig: () => baseConfig({ baseUrl: 'https://openrouter.ai/api/v1/' }),
    calibrator,
    state,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => body };
    },
  });

  const result = await llm.modelEndpoints('openai/gpt-image-x', { timeoutMs: 1234 });

  assert.deepEqual(result, { ok: true, status: 200, json: body });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models/openai/gpt-image-x/endpoints');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k-test');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(state.data, {}, 'the daily counter is untouched');
  assert.equal(state.dirty, undefined);
  assert.deepEqual(calibrator.observed, []);
});

test('modelEndpoints: a non-2xx answer has no json, an unparsable body reads as null, a network failure throws', async () => {
  const make = (fetchImpl) =>
    createLlm({ apiKey: 'k', getConfig: () => baseConfig(), calibrator: fakeCalibrator(), state: fakeState(), fetchImpl });

  const missing = make(async () => ({ ok: false, status: 404, json: async () => ({ error: 'x' }) }));
  assert.deepEqual(await missing.modelEndpoints('a/b'), { ok: false, status: 404, json: null });

  const garbled = make(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }));
  assert.deepEqual(await garbled.modelEndpoints('a/b'), { ok: true, status: 200, json: null });

  const down = make(async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(() => down.modelEndpoints('a/b'), TypeError);
});
