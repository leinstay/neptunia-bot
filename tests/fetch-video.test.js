// Tests for src/discord/fetch-video.js: attachment sent as-is or trimmed by
// ffmpeg, the download hard ceiling, yt-dlp probe and clip runs, failure
// reasons, timeouts, temp-file cleanup and query-free logging. Child
// processes and fetch are fakes; temp files go to a throwaway directory.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVideoFetcher } from '../src/discord/fetch-video.js';

const OPTS = {
  maxSeconds: 60,
  maxBytes: 1000,
  toolTimeoutMs: 60_000,
  fetchTimeoutMs: 10_000,
  ytdlpPath: 'yt-dlp',
  ffmpegPath: 'ffmpeg',
};
const ATTACHMENT = 'https://cdn.discordapp.com/attachments/1/2/clip.webm?ex=deadbeef&is=cafef00d&hm=abc';
const SITE_URL = 'https://www.youtube.com/watch?v=abc123&si=secrettracking';

let tmpDir;
beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fetch-video-test-'));
});
afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function leftovers() {
  return fsp.readdir(tmpDir);
}

/** A body that yields `chunks` one by one and counts how many were pulled. */
function countingBody(chunks) {
  const body = {
    pulled: 0,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        body.pulled += 1;
        yield chunk;
      }
    },
  };
  return body;
}

function fakeResponse({ ok = true, status = 200, contentType = 'video/webm', contentLength, chunks = [Buffer.from('video-bytes')] } = {}) {
  const headers = { 'content-type': contentType, 'content-length': contentLength !== undefined ? String(contentLength) : undefined };
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body: countingBody(chunks),
  };
}

function fakeFetch(response) {
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

/**
 * A spawn stub. `behave(child, command, args)` runs on the next tick and may
 * write to stdout/stderr, create files, and emit `close` / `error`.
 * Leaving it silent simulates a hung tool (for timeouts).
 */
function fakeSpawn(behave) {
  const calls = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGKILL'));
      return true;
    };
    calls.push({ command, args, child });
    setImmediate(() => behave(child, command, args));
    return child;
  };
  return { spawnImpl, calls };
}

function enoent(child) {
  const err = new Error('spawn tool ENOENT');
  err.code = 'ENOENT';
  child.emit('error', err);
}

/** Behaviour that writes `size` bytes to the path after `flag` (or the last arg), then exits 0. */
function writesOutput(size, flag) {
  return async (child, command, args) => {
    const out = flag ? args[args.indexOf(flag) + 1] : args[args.length - 1];
    await fsp.writeFile(out, Buffer.alloc(size, 7));
    child.emit('close', 0, null);
  };
}

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
  for (const line of chunks.join('').split('\n')) {
    if (!line.trim()) continue;
    try {
      logs.push(JSON.parse(line));
    } catch {
      // not a log line
    }
  }
  return { result, logs };
}

// --- fetchAttachment ------------------------------------------------------

test('fetchAttachment: a short small video is sent as-is with its own content type, no ffmpeg', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ contentType: 'video/webm; codecs=vp9' }));
  const { spawnImpl, calls } = fakeSpawn(() => assert.fail('ffmpeg must not run'));
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 12 });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/webm');
  assert.equal(result.dataUrl, `data:video/webm;base64,${Buffer.from('video-bytes').toString('base64')}`);
  assert.equal(result.seconds, 12);
  assert.equal(result.bytes, Buffer.from('video-bytes').byteLength);
  assert.equal(calls.length, 0);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a long video is trimmed by ffmpeg into an mp4 clip', async () => {
  const { fetchImpl, calls: fetchCalls } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(writesOutput(300));
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 125 });

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/mp4');
  assert.ok(result.dataUrl.startsWith('data:video/mp4;base64,'));
  assert.equal(result.seconds, 60);
  assert.equal(result.bytes, 300);
  assert.ok(fetchCalls[0].options.signal instanceof AbortSignal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ffmpeg');
  const args = calls[0].args;
  assert.equal(args[args.indexOf('-t') + 1], '60');
  assert.notEqual(args[args.indexOf('-i') + 1], args[args.length - 1], 'input and output are two different temp files');
  assert.deepEqual(await leftovers(), [], 'both temp files are removed');
});

test('fetchAttachment: an unknown duration always goes through ffmpeg; seconds falls back to maxSeconds', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(writesOutput(100));
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: null });

  assert.equal(result.ok, true);
  assert.equal(result.seconds, 60);
  assert.equal(calls.length, 1);
});

test('fetchAttachment: a short but oversized video is re-encoded; seconds keeps the real duration', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ chunks: [Buffer.alloc(1500, 1)] }));
  const { spawnImpl, calls } = fakeSpawn(writesOutput(500));
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 20 });

  assert.equal(result.ok, true);
  assert.equal(result.seconds, 20);
  assert.equal(calls.length, 1);
});

test('fetchAttachment: ffmpeg missing -> length when the video is too long', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl } = fakeSpawn(enoent);
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 90 });

  assert.deepEqual(result, { ok: false, reason: 'length' });
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: ffmpeg missing -> size when the video was only too big', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ chunks: [Buffer.alloc(1500, 1)] }));
  const { spawnImpl } = fakeSpawn(enoent);
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 30 });

  assert.deepEqual(result, { ok: false, reason: 'size' });
});

test('fetchAttachment: the trimmed clip still over maxBytes -> size', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl } = fakeSpawn(writesOutput(1001));
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 90 });

  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: ffmpeg non-zero exit -> tool', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl } = fakeSpawn((child) => child.emit('close', 1, null));
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 90 }), { ok: false, reason: 'tool' });
});

test('fetchAttachment: a hung ffmpeg is killed after toolTimeoutMs -> timeout', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, toolTimeoutMs: 20, durationSec: 90 });

  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: the download stops at the hard ceiling (maxBytes * 4) and deletes the partial file', async () => {
  const chunks = Array.from({ length: 100 }, () => Buffer.alloc(100, 1)); // 10 000 bytes offered
  const response = fakeResponse({ chunks });
  const { fetchImpl } = fakeFetch(response);
  const { spawnImpl, calls } = fakeSpawn(() => assert.fail('ffmpeg must not run'));
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 });

  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.ok(response.body.pulled <= 41, `pulled ${response.body.pulled} chunks; must stop just past 4000 bytes`);
  assert.equal(calls.length, 0);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a declared content-length over the ceiling is refused before reading the body', async () => {
  const response = fakeResponse({ contentLength: 5000 });
  const { fetchImpl } = fakeFetch(response);
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

  assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 }), { ok: false, reason: 'size' });
  assert.equal(response.body.pulled, 0);
});

test('fetchAttachment: non-video content type, non-OK status and a thrown fetch all give download', async () => {
  for (const response of [fakeResponse({ contentType: 'text/html' }), fakeResponse({ ok: false, status: 403 }), new Error('network down')]) {
    const { fetchImpl } = fakeFetch(response);
    const fetcher = createVideoFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 }), { ok: false, reason: 'download' });
  }
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a download that outlives fetchTimeoutMs is aborted -> timeout', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, fetchTimeoutMs: 20, durationSec: 10 });

  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

// --- probeSite ----------------------------------------------------------

test('probeSite: parses duration and title from yt-dlp stdout', async () => {
  const json = JSON.stringify({ duration: 213, title: 'Ἡ θάλασσα' });
  const { spawnImpl, calls } = fakeSpawn((child) => {
    const bytes = Buffer.from(json);
    child.stdout.emit('data', bytes.subarray(0, 10));
    child.stdout.emit('data', bytes.subarray(10));
    child.emit('close', 0, null);
  });
  const fetcher = createVideoFetcher({ spawnImpl, tmpDir });

  const result = await fetcher.probeSite(SITE_URL, OPTS);

  assert.deepEqual(result, { ok: true, durationSec: 213, title: 'Ἡ θάλασσα' });
  assert.equal(calls[0].command, 'yt-dlp');
  assert.ok(calls[0].args.includes('--dump-single-json'));
  assert.equal(calls[0].args[calls[0].args.length - 1], SITE_URL);
});

test('probeSite: ENOENT -> tool, non-zero -> download, hang -> timeout', async () => {
  const cases = [
    [enoent, 'tool'],
    [(child) => child.emit('close', 1, null), 'download'],
    [() => {}, 'timeout'],
  ];
  for (const [behave, reason] of cases) {
    const fetcher = createVideoFetcher({ spawnImpl: fakeSpawn(behave).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.probeSite(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason });
  }
});

test('probeSite: a spawn that throws synchronously resolves to tool, never rejects', async () => {
  const spawnImpl = () => {
    throw Object.assign(new Error('boom'), { code: 'EACCES' });
  };
  const fetcher = createVideoFetcher({ spawnImpl, tmpDir });
  assert.deepEqual(await fetcher.probeSite(SITE_URL, OPTS), { ok: false, reason: 'tool' });
});

// --- fetchSiteClip -------------------------------------------------------

test('fetchSiteClip: returns the downloaded clip as an mp4 data URL and removes the temp file', async () => {
  const { spawnImpl, calls } = fakeSpawn(writesOutput(400, '-o'));
  const fetcher = createVideoFetcher({ spawnImpl, tmpDir });

  const result = await fetcher.fetchSiteClip(SITE_URL, OPTS);

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/mp4');
  assert.ok(result.dataUrl.startsWith('data:video/mp4;base64,'));
  assert.equal(result.bytes, 400);
  assert.equal(result.seconds, 60);
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
  assert.equal(args[args.indexOf('--max-filesize') + 1], '1000');
  assert.ok(args[args.indexOf('-o') + 1].startsWith(tmpDir));
  assert.deepEqual(await leftovers(), []);
});

test('fetchSiteClip: a shorter probed duration is reported as seconds', async () => {
  const fetcher = createVideoFetcher({ spawnImpl: fakeSpawn(writesOutput(10, '-o')).spawnImpl, tmpDir });
  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 14 });
  assert.equal(result.seconds, 14);
});

test('fetchSiteClip: ENOENT -> tool, non-zero -> download, hang -> timeout, oversize -> size; no leftovers', async () => {
  const cases = [
    [enoent, 'tool'],
    [(child) => child.emit('close', 2, null), 'download'],
    [() => {}, 'timeout'],
    [writesOutput(1001, '-o'), 'size'],
  ];
  for (const [behave, reason] of cases) {
    const fetcher = createVideoFetcher({ spawnImpl: fakeSpawn(behave).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason });
    assert.deepEqual(await leftovers(), [], `leftovers after ${reason}`);
  }
});

// --- logging ---------------------------------------------------------------

test('logging: one warn per failure with source, reason, a query-free location and scrubbed stderr tail', async () => {
  const stderr = `${'x'.repeat(400)} ERROR: unable to fetch https://www.youtube.com/watch?v=abc123&token=secret now`;
  const { spawnImpl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 1, null);
  });
  const fetcher = createVideoFetcher({ spawnImpl, tmpDir });

  const { logs } = await withCapturedLogs(() => fetcher.fetchSiteClip(SITE_URL, OPTS));

  const lines = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.level, 'warn');
  assert.equal(line.source, 'site');
  assert.equal(line.reason, 'download');
  assert.equal(line.location, 'www.youtube.com/watch');
  assert.ok(line.stderr.length <= 200);
  assert.ok(line.stderr.includes('<url>'));
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes('secret'));
  assert.ok(!serialized.includes('abc123'));
  assert.ok(!serialized.includes('?'));
});

test('logging: an attachment failure logs source attachment without the signed query string', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ ok: false, status: 403 }));
  const fetcher = createVideoFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

  const { logs } = await withCapturedLogs(() => fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 5 }));

  const lines = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].source, 'attachment');
  assert.equal(lines[0].location, 'cdn.discordapp.com/attachments/1/2/clip.webm');
  const serialized = JSON.stringify(lines[0]);
  assert.ok(!serialized.includes('deadbeef'));
  assert.ok(!serialized.includes('cafef00d'));
});
