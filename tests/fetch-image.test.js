// Tests for src/discord/fetch-image.js: content-type allowlist, size guards
// (header and body), timeout/failure handling, the LRU cache and its
// query-string-free logging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageFetcher } from '../src/discord/fetch-image.js';

const PNG_BYTES = Buffer.from('fake-png-bytes');

function fakeResponse({ ok = true, status = 200, contentType = 'image/png', contentLength, body = PNG_BYTES } = {}) {
  const headers = {
    'content-type': contentType,
    'content-length': contentLength !== undefined ? String(contentLength) : undefined,
  };
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function fakeFetchImpl(response) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, options) : response;
    },
  };
}

/** Captures process.stdout.write calls (the log module's only sink) around `fn`. */
async function withCapturedLogs(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = original;
  }
  const logs = [];
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        logs.push(JSON.parse(line));
      } catch {
        // not one of our JSON log lines -- ignore
      }
    }
  }
  return { result, logs };
}

const OPTIONS = { maxBytes: 1_500_000, timeoutMs: 10_000 };

test('fetchAsDataUrl: a successful png download returns a data: URL with bytes and contentType', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ contentType: 'image/png' }));
  const fetcher = createImageFetcher({ fetchImpl });

  const result = await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic.png?ex=1&is=2&hm=3', OPTIONS);

  assert.ok(result);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.bytes, PNG_BYTES.byteLength);
  assert.ok(result.dataUrl.startsWith('data:image/png;base64,'));
});

test('fetchAsDataUrl: content-type allowlist accepts png/jpeg/gif/webp', async () => {
  for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const { fetchImpl } = fakeFetchImpl(fakeResponse({ contentType }));
    const fetcher = createImageFetcher({ fetchImpl });
    const result = await fetcher.fetchAsDataUrl('https://x/pic', OPTIONS);
    assert.ok(result, `expected ${contentType} to be accepted`);
  }
});

test('fetchAsDataUrl: content-type allowlist rejects everything else, and strips parameters before matching', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ contentType: 'image/svg+xml' }));
  const fetcher = createImageFetcher({ fetchImpl });
  assert.equal(await fetcher.fetchAsDataUrl('https://x/pic.svg', OPTIONS), null);

  const { fetchImpl: fetchImpl2 } = fakeFetchImpl(fakeResponse({ contentType: 'image/png; charset=binary' }));
  const fetcher2 = createImageFetcher({ fetchImpl: fetchImpl2 });
  const result = await fetcher2.fetchAsDataUrl('https://x/pic.png', OPTIONS);
  assert.ok(result, 'a content-type with parameters must still match after stripping them');
});

test('fetchAsDataUrl: refuses via the declared content-length header before reading the body', async () => {
  const response = fakeResponse({ contentLength: 5_000_000 });
  let bodyRead = false;
  response.arrayBuffer = async () => {
    bodyRead = true;
    return PNG_BYTES.buffer;
  };
  const { fetchImpl } = fakeFetchImpl(response);
  const fetcher = createImageFetcher({ fetchImpl });

  const result = await fetcher.fetchAsDataUrl('https://x/pic.png', { maxBytes: 1_500_000, timeoutMs: 10_000 });

  assert.equal(result, null);
  assert.equal(bodyRead, false, 'the body must never be read once the declared size already exceeds the limit');
});

test('fetchAsDataUrl: refuses on the real body length when content-length is absent or understates it', async () => {
  const bigBody = Buffer.alloc(2_000_000, 1);
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ body: bigBody, contentLength: undefined }));
  const fetcher = createImageFetcher({ fetchImpl });

  const result = await fetcher.fetchAsDataUrl('https://x/pic.png', { maxBytes: 1_500_000, timeoutMs: 10_000 });

  assert.equal(result, null);
});

test('fetchAsDataUrl: a non-OK HTTP response returns null', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ ok: false, status: 403 }));
  const fetcher = createImageFetcher({ fetchImpl });

  assert.equal(await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS), null);
});

test('fetchAsDataUrl: a thrown fetch error (timeout or network failure) returns null instead of throwing', async () => {
  const { fetchImpl } = fakeFetchImpl(new Error('The operation was aborted'));
  const fetcher = createImageFetcher({ fetchImpl });

  const result = await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);
  assert.equal(result, null);
});

test('fetchAsDataUrl: a body-read failure returns null instead of throwing', async () => {
  const response = fakeResponse();
  response.arrayBuffer = async () => {
    throw new Error('stream error');
  };
  const { fetchImpl } = fakeFetchImpl(response);
  const fetcher = createImageFetcher({ fetchImpl });

  assert.equal(await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS), null);
});

test('fetchAsDataUrl: passes an AbortSignal built from timeoutMs to fetchImpl', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl });

  await fetcher.fetchAsDataUrl('https://x/pic.png', { maxBytes: 1_500_000, timeoutMs: 5_000 });

  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

// --- LRU cache -------------------------------------------------------------

test('fetchAsDataUrl: a cache hit on the same URL (ignoring its query string) avoids a second download', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl });

  const first = await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic.png?ex=111&is=222&hm=333', OPTIONS);
  const second = await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic.png?ex=999&is=888&hm=777', OPTIONS);

  assert.equal(calls.length, 1, 'the second call must be served from cache, ignoring the rotated signed query string');
  assert.deepEqual(second, first);
});

test('fetchAsDataUrl: a different path is never a cache hit', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl });

  await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic1.png?ex=1', OPTIONS);
  await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic2.png?ex=1', OPTIONS);

  assert.equal(calls.length, 2);
});

test('fetchAsDataUrl: a cache entry expires after cacheTtlMs and is re-downloaded', async () => {
  let nowValue = 1_000_000;
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl, now: () => nowValue, cacheTtlMs: 1000 });

  await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);
  nowValue += 1001;
  await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);

  assert.equal(calls.length, 2, 'the cache entry must have expired');
});

test('fetchAsDataUrl: evicts the least-recently-used entry once over cacheMaxEntries', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl, cacheMaxEntries: 2 });

  await fetcher.fetchAsDataUrl('https://x/a.png', OPTIONS);
  await fetcher.fetchAsDataUrl('https://x/b.png', OPTIONS);
  await fetcher.fetchAsDataUrl('https://x/c.png', OPTIONS); // evicts a.png

  await fetcher.fetchAsDataUrl('https://x/a.png', OPTIONS); // must re-download: evicted
  assert.equal(calls.length, 4);

  calls.length = 0;
  await fetcher.fetchAsDataUrl('https://x/c.png', OPTIONS); // still cached
  assert.equal(calls.length, 0, 'c.png must still be cached');
});

test('fetchAsDataUrl: a failed download is never cached -- retried on the next call', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse({ ok: false, status: 500 }));
  const fetcher = createImageFetcher({ fetchImpl });

  await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);
  await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);

  assert.equal(calls.length, 2, 'a failure must never be served from cache');
});

// --- logging -----------------------------------------------------------

test('fetchAsDataUrl: a failure logs the host and path only, never the signed query string', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ ok: false, status: 403 }));
  const fetcher = createImageFetcher({ fetchImpl });

  const { logs } = await withCapturedLogs(() =>
    fetcher.fetchAsDataUrl('https://media.discordapp.net/attachments/1/2/pic.png?ex=deadbeef&is=cafef00d&hm=abc123', OPTIONS),
  );

  const line = logs.find((l) => l.msg.startsWith('fetch-image:'));
  assert.ok(line, 'expected a fetch-image log line');
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes('ex=deadbeef'));
  assert.ok(!serialized.includes('cafef00d'));
  assert.ok(!serialized.includes('?'));
  assert.ok(serialized.includes('media.discordapp.net/attachments/1/2/pic.png'));
});

test('fetchAsDataUrl: an unsupported content type also logs without the query string', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ contentType: 'application/pdf' }));
  const fetcher = createImageFetcher({ fetchImpl });

  const { logs } = await withCapturedLogs(() => fetcher.fetchAsDataUrl('https://x/file.pdf?token=secret', OPTIONS));

  const line = logs.find((l) => l.msg.startsWith('fetch-image:'));
  assert.ok(line);
  assert.ok(!JSON.stringify(line).includes('secret'));
});
