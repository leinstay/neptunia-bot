// Tests for src/llm/openrouter.js: the two hard safety rails (token cap,
// daily request cap), retry behaviour and calibration feedback. No network:
// fetchImpl is always a fake. Only ONE test exercises a real retry sleep
// (~1.5s) as instructed -- the backoff sleep in src is not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm, TokenLimitError, DailyCapError } from '../src/llm/openrouter.js';

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

test('complete: options.videoSeconds defaults to 300 tokens per second when media.video is absent', async () => {
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
  assert.equal(withVideo.estimated - plain.estimated, 3000);
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

// Only ONE test exercises the real retry backoff sleep (~1.5s at attempt 1).
test('complete: retries once on a 503 then succeeds', async () => {
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
  const result = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(result.text, 'recovered');
  assert.equal(calls, 2);
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
