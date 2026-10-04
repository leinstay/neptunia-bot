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
