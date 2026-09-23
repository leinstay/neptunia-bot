// Tests for src/discord/fetch-video.js: attachment sent as-is or trimmed by
// ffmpeg, the download hard ceiling, yt-dlp probe and clip runs, failure
// reasons, timeouts (the whole tool process tree killed, cleanup only after
// the tool closed), temp-file cleanup and logging that carries codes only,
// never tool output or a query string. Child processes, process.kill and
// fetch are fakes; temp files go to a throwaway directory.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVideoFetcher } from '../src/discord/fetch-video.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

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

// Every fake child by pid, so the fake process.kill can find the one it targets.
const children = new Map();
let nextPid = 1000;

/**
 * A spawn stub. `behave(child, command, args)` runs on the next tick and may
 * write to stdout/stderr, create files, and emit `close` / `error`.
 * Leaving it silent simulates a hung tool (for timeouts).
 */
function fakeSpawn(behave) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGKILL'));
      return true;
    };
    children.set(child.pid, child);
    calls.push({ command, args, options, child });
    setImmediate(() => behave(child, command, args));
    return child;
  };
  return { spawnImpl, calls };
}

/** A process.kill stub: a negative pid is a process group; the target child closes on the next tick. */
function fakeKill() {
  const kills = [];
  const killProcess = (pid, signal) => {
    kills.push({ pid, signal });
    const child = children.get(Math.abs(pid));
    if (!child) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    child.killed = true;
    setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  return { killProcess, kills };
}

/** createVideoFetcher on a POSIX platform with a fake process.kill, unless overridden. */
function makeFetcher(deps) {
  return createVideoFetcher({ platform: 'linux', killProcess: fakeKill().killProcess, ...deps });
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

// --- fetchAttachment ------------------------------------------------------

test('fetchAttachment: a short small video is sent as-is with its own content type, no ffmpeg', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ contentType: 'video/webm; codecs=vp9' }));
  const { spawnImpl, calls } = fakeSpawn(() => assert.fail('ffmpeg must not run'));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

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
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

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
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: null });

  assert.equal(result.ok, true);
  assert.equal(result.seconds, 60);
  assert.equal(calls.length, 1);
});

test('fetchAttachment: a short but oversized video is re-encoded; seconds keeps the real duration', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ chunks: [Buffer.alloc(1500, 1)] }));
  const { spawnImpl, calls } = fakeSpawn(writesOutput(500));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 20 });

  assert.equal(result.ok, true);
  assert.equal(result.seconds, 20);
  assert.equal(calls.length, 1);
});

test('fetchAttachment: ffmpeg missing -> tool (retryable), whether the video was too long or only too big', async () => {
  const cases = [
    [fakeResponse(), 90],
    [fakeResponse({ chunks: [Buffer.alloc(1500, 1)] }), 30],
  ];
  for (const [response, durationSec] of cases) {
    const { fetchImpl } = fakeFetch(response);
    const { spawnImpl } = fakeSpawn(enoent);
    const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

    assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec }), { ok: false, reason: 'tool' });
    assert.deepEqual(await leftovers(), []);
  }
});

test('fetchAttachment: the trimmed clip still over maxBytes -> size', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl } = fakeSpawn(writesOutput(1001));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 90 });

  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: ffmpeg non-zero exit -> tool', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl } = fakeSpawn((child) => child.emit('close', 1, null));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 90 }), { ok: false, reason: 'tool' });
});

test('fetchAttachment: a hung ffmpeg is killed after toolTimeoutMs -> timeout', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse());
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, toolTimeoutMs: 20, durationSec: 90 });

  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual(await leftovers(), []);
});

// --- killing the tool process tree -------------------------------------------

test('kill: on POSIX a tool is spawned detached and a timeout kills its whole process group', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const { killProcess, kills } = fakeKill();
  const fetcher = createVideoFetcher({ spawnImpl, killProcess, platform: 'linux', tmpDir });

  assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason: 'timeout' });

  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(kills, [{ pid: -calls[0].child.pid, signal: 'SIGKILL' }]);
  assert.deepEqual(await leftovers(), []);
});

test('kill: the temp directory is removed only after the killed tool has closed', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  let seenBeforeClose = null;
  const killProcess = (pid) => {
    const child = children.get(Math.abs(pid));
    setTimeout(async () => {
      seenBeforeClose = await fsp.readdir(tmpDir);
      child.emit('close', null, 'SIGKILL');
    }, 30);
    return true;
  };
  const fetcher = createVideoFetcher({ spawnImpl, killProcess, platform: 'linux', tmpDir });

  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 });

  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(calls.length, 1);
  assert.equal(seenBeforeClose.length, 1, 'the work directory still exists while the tool is closing');
  assert.deepEqual(await leftovers(), [], 'and is removed once it has closed');
});

test('kill: a tool that never closes after the kill is given up on after the grace period', async () => {
  const { spawnImpl } = fakeSpawn(() => {});
  const fetcher = createVideoFetcher({ spawnImpl, killProcess: () => true, platform: 'linux', closeGraceMs: 30, tmpDir });

  assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason: 'timeout' });
  assert.deepEqual(await leftovers(), []);
});

test('kill: a failing group kill falls back to killing the child itself', async () => {
  const { spawnImpl, calls } = fakeSpawn(() => {});
  const killProcess = () => {
    throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
  };
  const fetcher = createVideoFetcher({ spawnImpl, killProcess, platform: 'linux', tmpDir });

  assert.deepEqual(await fetcher.probeSite(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason: 'timeout' });
  assert.equal(calls[0].child.killed, true);
});

test('kill: on Windows the tool is not detached and the tree is killed with taskkill /T /F', async () => {
  const { spawnImpl, calls } = fakeSpawn((child, command, args) => {
    if (command !== 'taskkill') return; // the tool itself hangs
    const target = children.get(Number(args[args.indexOf('/PID') + 1]));
    target.emit('close', 1, null);
    child.emit('close', 0, null);
  });
  const killProcess = () => assert.fail('no process-group kill on Windows');
  const fetcher = createVideoFetcher({ spawnImpl, killProcess, platform: 'win32', tmpDir });

  assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason: 'timeout' });

  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[1].command, 'taskkill');
  assert.deepEqual(calls[1].args, ['/PID', String(calls[0].child.pid), '/T', '/F']);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: the download stops at the hard ceiling (maxBytes * 4) and deletes the partial file', async () => {
  const chunks = Array.from({ length: 100 }, () => Buffer.alloc(100, 1)); // 10 000 bytes offered
  const response = fakeResponse({ chunks });
  const { fetchImpl } = fakeFetch(response);
  const { spawnImpl, calls } = fakeSpawn(() => assert.fail('ffmpeg must not run'));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl, tmpDir });

  const result = await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 });

  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.ok(response.body.pulled <= 41, `pulled ${response.body.pulled} chunks; must stop just past 4000 bytes`);
  assert.equal(calls.length, 0);
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a declared content-length over the ceiling is refused before reading the body', async () => {
  const response = fakeResponse({ contentLength: 5000 });
  const { fetchImpl } = fakeFetch(response);
  const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

  assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 }), { ok: false, reason: 'size' });
  assert.equal(response.body.pulled, 0);
});

test('fetchAttachment: non-video content type, non-OK status and a thrown fetch all give download', async () => {
  for (const response of [fakeResponse({ contentType: 'text/html' }), fakeResponse({ ok: false, status: 403 }), new Error('network down')]) {
    const { fetchImpl } = fakeFetch(response);
    const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 10 }), { ok: false, reason: 'download' });
  }
  assert.deepEqual(await leftovers(), []);
});

test('fetchAttachment: a download that outlives fetchTimeoutMs is aborted -> timeout', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

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
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

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
    const fetcher = makeFetcher({ spawnImpl: fakeSpawn(behave).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.probeSite(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason });
  }
});

test('probeSite: a spawn that throws synchronously resolves to tool, never rejects', async () => {
  const spawnImpl = () => {
    throw Object.assign(new Error('boom'), { code: 'EACCES' });
  };
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  assert.deepEqual(await fetcher.probeSite(SITE_URL, OPTS), { ok: false, reason: 'tool' });
});

// --- fetchSiteClip -------------------------------------------------------

test('fetchSiteClip: returns the downloaded clip as an mp4 data URL and removes the temp file', async () => {
  const { spawnImpl, calls } = fakeSpawn(writesOutput(400, '-o'));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const result = await fetcher.fetchSiteClip(SITE_URL, OPTS);

  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'video/mp4');
  assert.ok(result.dataUrl.startsWith('data:video/mp4;base64,'));
  assert.equal(result.bytes, 400);
  assert.equal(result.seconds, 60);
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
  assert.equal(args[args.indexOf('--max-filesize') + 1], '1000');
  assert.equal(args.includes('--ffmpeg-location'), false, 'a bare ffmpeg name is left to PATH');
  assert.ok(args[args.indexOf('-o') + 1].startsWith(tmpDir));
  assert.deepEqual(await leftovers(), []);
});

test('fetchSiteClip: a shorter probed duration is reported as seconds and skips the cut', async () => {
  const { spawnImpl, calls } = fakeSpawn(writesOutput(10, '-o'));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, durationSec: 14 });
  assert.equal(result.seconds, 14);
  const args = calls[0].args;
  assert.equal(args.includes('--download-sections'), false);
  assert.equal(args.includes('--force-keyframes-at-cuts'), false);
});

test('fetchSiteClip: a longer probed duration keeps the cut; a path ffmpeg is passed on', async () => {
  const { spawnImpl, calls } = fakeSpawn(writesOutput(10, '-o'));
  const fetcher = makeFetcher({ spawnImpl, tmpDir });
  const result = await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, ffmpegPath: '/usr/bin/ffmpeg', durationSec: 125 });
  assert.equal(result.seconds, 60);
  const args = calls[0].args;
  assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
  assert.equal(args[args.indexOf('--ffmpeg-location') + 1], '/usr/bin/ffmpeg');
});

test('fetchSiteClip: ENOENT -> tool, non-zero -> download, hang -> timeout, oversize -> size; no leftovers', async () => {
  const cases = [
    [enoent, 'tool'],
    [(child) => child.emit('close', 2, null), 'download'],
    [() => {}, 'timeout'],
    [writesOutput(1001, '-o'), 'size'],
  ];
  for (const [behave, reason] of cases) {
    const fetcher = makeFetcher({ spawnImpl: fakeSpawn(behave).spawnImpl, tmpDir });
    assert.deepEqual(await fetcher.fetchSiteClip(SITE_URL, { ...OPTS, toolTimeoutMs: 20 }), { ok: false, reason });
    assert.deepEqual(await leftovers(), [], `leftovers after ${reason}`);
  }
});

// --- logging ---------------------------------------------------------------

test('logging: one warn per failure with source, reason, a query-free location and the exit code -- never tool output', async () => {
  const stderr = `${'x'.repeat(400)} ERROR: unable to fetch https://www.youtube.com/watch?v=abc123&token=secret now`;
  const { spawnImpl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 1, null);
  });
  const fetcher = makeFetcher({ spawnImpl, tmpDir });

  const { logs } = await withCapturedLogs(() => fetcher.fetchSiteClip(SITE_URL, OPTS));

  const lines = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(line.level, 'warn');
  assert.equal(line.source, 'site');
  assert.equal(line.reason, 'download');
  assert.equal(line.location, 'www.youtube.com/watch');
  assert.equal(line.code, 1);
  assert.ok(!('stderr' in line));
  assert.ok(!('error' in line));
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes('unable to fetch'));
  assert.ok(!serialized.includes('xxxx'));
  assert.ok(!serialized.includes('secret'));
  assert.ok(!serialized.includes('abc123'));
  assert.ok(!serialized.includes('?'));
});

test('logging: an attachment failure logs source attachment without the signed query string', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ ok: false, status: 403 }));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

  const { logs } = await withCapturedLogs(() => fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 5 }));

  const lines = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].source, 'attachment');
  assert.equal(lines[0].location, 'cdn.discordapp.com/attachments/1/2/clip.webm');
  const serialized = JSON.stringify(lines[0]);
  assert.ok(!serialized.includes('deadbeef'));
  assert.ok(!serialized.includes('cafef00d'));
});

test('logging: a thrown error logs its code or name only, never its message', async () => {
  const cases = [
    [Object.assign(new Error('connect ECONNREFUSED https://cdn.discordapp.com/x?hm=secret'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
    [new TypeError('fetch failed for https://cdn.discordapp.com/x?hm=secret'), 'TypeError'],
  ];
  for (const [error, code] of cases) {
    const { fetchImpl } = fakeFetch(error);
    const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });

    const { logs } = await withCapturedLogs(() => fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 5 }));

    const [line] = logs.filter((l) => l.msg.startsWith('fetch-video:'));
    assert.equal(line.reason, 'download');
    assert.equal(line.code, code);
    assert.ok(!('error' in line));
    const serialized = JSON.stringify(line);
    assert.ok(!serialized.includes('secret'));
    assert.ok(!serialized.includes('fetch failed'));
  }
});

test('logging: a missing tool logs its errno code', async () => {
  const fetcher = makeFetcher({ spawnImpl: fakeSpawn(enoent).spawnImpl, tmpDir });
  const { logs } = await withCapturedLogs(() => fetcher.probeSite(SITE_URL, OPTS));
  const [line] = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(line.reason, 'tool');
  assert.equal(line.code, 'ENOENT');
  assert.ok(!JSON.stringify(line).includes('spawn tool'));
});

test('logging: a non-OK download logs its HTTP status', async () => {
  const { fetchImpl } = fakeFetch(fakeResponse({ ok: false, status: 403 }));
  const fetcher = makeFetcher({ fetchImpl, spawnImpl: fakeSpawn(() => {}).spawnImpl, tmpDir });
  const { logs } = await withCapturedLogs(() => fetcher.fetchAttachment(ATTACHMENT, { ...OPTS, durationSec: 5 }));
  const [line] = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(line.status, 403);
});

// --- probeYoutube ----------------------------------------------------------

const API_KEY = 'AIzaSecretTestKey';
const WATCH_PAGE = 'https://www.youtube.com/watch?v=abc123&hl=en';
const API_URL = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=abc123&key=${API_KEY}`;

/** An HTTP response whose body is `text` (or the given chunks). */
function textResponse(text, { ok = true, status = 200, chunks } = {}) {
  return fakeResponse({ ok, status, contentType: 'text/html', chunks: chunks ?? [Buffer.from(text)] });
}

/** A fetch fake answering by URL prefix: `routes` maps a prefix to a response, an Error or a function. */
function routedFetch(routes) {
  return fakeFetch((url, options) => {
    for (const [prefix, response] of Object.entries(routes)) {
      if (!url.startsWith(prefix)) continue;
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, options) : response;
    }
    throw new Error(`unexpected url ${url}`);
  });
}

const API_PREFIX = 'https://www.googleapis.com/';
const PAGE_PREFIX = 'https://www.youtube.com/watch';
const API_OK = JSON.stringify({ items: [{ contentDetails: { duration: 'PT3M34S' } }] });

test('probeYoutube: with an API key the Data API answers first and the page is never fetched', async () => {
  const { fetchImpl, calls } = routedFetch({ [API_PREFIX]: textResponse(API_OK) });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });

  const result = await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: API_KEY });

  assert.deepEqual(result, { ok: true, durationSec: 214 });
  assert.deepEqual(calls.map((c) => c.url), [API_URL]);
});

test('probeYoutube: without an API key only the watch page is fetched, with a browser UA and Accept-Language', async () => {
  for (const apiKey of [undefined, null, '']) {
    const { fetchImpl, calls } = routedFetch({ [PAGE_PREFIX]: textResponse('<script>{"lengthSeconds":"42"}</script>') });
    const fetcher = makeFetcher({ fetchImpl, tmpDir });

    const result = await fetcher.probeYoutube('https://youtu.be/abc123?si=track', { fetchTimeoutMs: 10_000, apiKey });

    assert.deepEqual(result, { ok: true, durationSec: 42 });
    assert.deepEqual(calls.map((c) => c.url), [WATCH_PAGE]);
    const { headers } = calls[0].options;
    assert.equal(
      headers['User-Agent'],
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    );
    assert.equal(headers['Accept-Language'], 'en');
  }
});

test('probeYoutube: an API failure falls through to the page, logging reason api without the key', async () => {
  const apiFailures = [
    textResponse('{"error":{}}', { ok: false, status: 403 }),
    textResponse(JSON.stringify({ items: [] })),
    Object.assign(new Error(`connect ECONNRESET ${API_URL}`), { code: 'ECONNRESET' }),
  ];
  for (const apiResponse of apiFailures) {
    const { fetchImpl, calls } = routedFetch({
      [API_PREFIX]: apiResponse,
      [PAGE_PREFIX]: textResponse('{"approxDurationMs":"61500"}'),
    });
    const fetcher = makeFetcher({ fetchImpl, tmpDir });

    const { result, logs } = await withCapturedLogs(() =>
      fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: API_KEY }),
    );

    assert.deepEqual(result, { ok: true, durationSec: 62 });
    assert.deepEqual(calls.map((c) => c.url), [API_URL, WATCH_PAGE]);
    const lines = logs.filter((l) => l.msg.startsWith('fetch-video:'));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'api');
    assert.equal(lines[0].location, 'www.googleapis.com/youtube/v3/videos');
    const serialized = JSON.stringify(lines);
    assert.ok(!serialized.includes(API_KEY), 'the key is never logged');
    assert.ok(!serialized.includes('ECONNRESET https'), 'never an error message');
  }
});

test('probeYoutube: the API failure log carries the HTTP status', async () => {
  const { fetchImpl } = routedFetch({
    [API_PREFIX]: textResponse('', { ok: false, status: 403 }),
    [PAGE_PREFIX]: textResponse('{"lengthSeconds":"42"}'),
  });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  const { logs } = await withCapturedLogs(() => fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: API_KEY }));
  const [line] = logs.filter((l) => l.msg.startsWith('fetch-video:'));
  assert.equal(line.status, 403);
});

test('probeYoutube: a page without a duration, a non-OK page or a thrown fetch gives download', async () => {
  for (const page of [
    textResponse('<html>Before you continue to YouTube</html>'),
    textResponse('', { ok: false, status: 429 }),
    new TypeError('fetch failed'),
  ]) {
    const { fetchImpl } = routedFetch({ [PAGE_PREFIX]: page });
    const fetcher = makeFetcher({ fetchImpl, tmpDir });
    assert.deepEqual(await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000 }), { ok: false, reason: 'download' });
  }
});

test('probeYoutube: a page that outlives fetchTimeoutMs is aborted -> timeout', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  assert.deepEqual(await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 20 }), { ok: false, reason: 'timeout' });
});

test('probeYoutube: at most 2 MB of the page is read -- a duration past the cap is never seen', async () => {
  const filler = Buffer.alloc(2 * 1024 * 1024, 'x');
  const page = textResponse('', { chunks: [filler, Buffer.from('{"lengthSeconds":"42"}'), Buffer.from('tail')] });
  const { fetchImpl } = routedFetch({ [PAGE_PREFIX]: page });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });

  const result = await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000 });

  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.ok(page.body.pulled <= 2, `pulled ${page.body.pulled} chunks`);
});

test('probeYoutube: a duration inside the first 2 MB is found', async () => {
  const filler = Buffer.alloc(1024 * 1024, 'x');
  const page = textResponse('', { chunks: [filler, Buffer.from('{"lengthSeconds":"42"}')] });
  const { fetchImpl } = routedFetch({ [PAGE_PREFIX]: page });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  assert.deepEqual(await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000 }), { ok: true, durationSec: 42 });
});

test('probeYoutube: a non-YouTube URL gives download without any request', async () => {
  const { fetchImpl, calls } = fakeFetch(textResponse('{"lengthSeconds":"42"}'));
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  const result = await fetcher.probeYoutube('https://www.tiktok.com/@someone/video/123', { fetchTimeoutMs: 10_000, apiKey: API_KEY });
  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.equal(calls.length, 0);
});

test('probeYoutube: pageFallback false stops after a failed Data API call, never fetching the page', async () => {
  const { fetchImpl, calls } = routedFetch({
    [API_PREFIX]: textResponse('', { ok: false, status: 403 }),
    [PAGE_PREFIX]: textResponse('{"lengthSeconds":"42"}'),
  });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  const { result } = await withCapturedLogs(() =>
    fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: API_KEY, pageFallback: false }),
  );
  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.deepEqual(calls.map((c) => c.url), [API_URL]);
});

test('probeYoutube: pageFallback false still returns a Data API duration', async () => {
  const { fetchImpl } = routedFetch({ [API_PREFIX]: textResponse(API_OK) });
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  const result = await fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: API_KEY, pageFallback: false });
  assert.deepEqual(result, { ok: true, durationSec: 214 });
});

test('probeYoutube: pageFallback false without a key makes no request', async () => {
  const { fetchImpl, calls } = fakeFetch(textResponse('{"lengthSeconds":"42"}'));
  const fetcher = makeFetcher({ fetchImpl, tmpDir });
  const { result } = await withCapturedLogs(() =>
    fetcher.probeYoutube(SITE_URL, { fetchTimeoutMs: 10_000, apiKey: null, pageFallback: false }),
  );
  assert.deepEqual(result, { ok: false, reason: 'download' });
  assert.equal(calls.length, 0);
});
