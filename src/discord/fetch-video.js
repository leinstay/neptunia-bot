// Turns a video the persona is shown into something a video-capable model can
// take: a Discord attachment is downloaded and, when short and small enough,
// inlined as-is; otherwise ffmpeg cuts it to the first `maxSeconds` at 360p.
// A video-site link goes through yt-dlp: a metadata-only probe (duration,
// title) and a clip download of the first `maxSeconds`. Where yt-dlp cannot
// read YouTube (a bot check), probeYoutube learns the duration without it:
// the YouTube Data API when a key is configured, else the watch page itself.
// The argument arrays and parsers come from the pure
// src/discord/video-sites.js; this module is only the edge (child processes,
// fetch, temp files).
//
// Every function resolves to a result object and never rejects. Temp files
// live in a fresh directory per call under `tmpDir`, removed in `finally`.
// A tool that outlives its timeout is killed with its whole process tree (on
// POSIX the tool runs detached as its own process group and the group is
// killed; on Windows `taskkill /T /F` kills the tree, falling back to killing
// the tool alone when taskkill cannot run), and the temp directory is removed
// only once the tool has closed (or a short grace period ran out) -- so an
// ffmpeg that yt-dlp started never writes into a directory being removed.
// Log lines carry codes only: source, reason, the host and path (never a
// query string -- a Discord CDN signature, tracking ids), an exit code,
// signal or errno, an HTTP status. Never tool output, never an error
// message, never file contents, never the Data API key (its request is
// logged under a fixed key-free location).

import { spawn } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import {
  ffmpegTrimArgs,
  parseProbe,
  parseYoutubeDataApi,
  parseYoutubePageDuration,
  safeLocation,
  youtubeDataApiUrl,
  youtubeVideoId,
  ytdlpClipArgs,
  ytdlpProbeArgs,
} from './video-sites.js';

const STDOUT_MAX_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_CEILING_FACTOR = 4;
const CLOSE_GRACE_MS = 5000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const YOUTUBE_API_LOCATION = 'www.googleapis.com/youtube/v3/videos';
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en',
};

/** The loggable code of a thrown error: its errno-style `code`, else its class name. Never the message. */
function errorCode(err) {
  return err?.code ?? err?.name ?? null;
}

/** `type/subtype` in lowercase, parameters dropped. */
function bareContentType(value) {
  return String(value ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * @param {object} [deps]
 * @param {typeof spawn} [deps.spawnImpl]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {typeof fsPromises} [deps.fs]
 * @param {string} [deps.tmpDir]
 * @param {string} [deps.platform]  `process.platform` by default; 'win32' switches the tree kill to taskkill.
 * @param {typeof process.kill} [deps.killProcess]  Used for the POSIX process-group kill.
 * @param {number} [deps.closeGraceMs]  How long a killed tool may take to close before cleanup goes ahead.
 */
export function createVideoFetcher({
  spawnImpl = spawn,
  fetchImpl = fetch,
  fs = fsPromises,
  tmpDir = os.tmpdir(),
  platform = process.platform,
  killProcess = process.kill.bind(process),
  closeGraceMs = CLOSE_GRACE_MS,
} = {}) {
  const isWindows = platform === 'win32';

  /** One warn line per failure (codes only, see the header), then the failure object. */
  function fail(source, url, reason, extra = {}) {
    const meta = { source, reason, location: safeLocation(url) };
    if (extra.code !== undefined && extra.code !== null) meta.code = extra.code;
    if (extra.status !== undefined) meta.status = extra.status;
    log.warn('fetch-video: failed', meta);
    return { ok: false, reason };
  }

  /** The loggable code of a tool run: errno of a spawn failure, else exit code, else the signal. */
  function runCode(run) {
    if (run.spawnError) return errorCode(run.spawnError);
    return run.code ?? run.signal ?? null;
  }

  /** Plain kill of the tool alone -- the fallback when the tree kill cannot run. */
  function killChild(child) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  /**
   * Kill `child` with every process it started. POSIX: the tool was spawned
   * detached (its own process group), so the whole group gets SIGKILL.
   * Windows: `taskkill /PID <pid> /T /F`; when taskkill itself cannot run,
   * only the tool is killed and a grandchild (ffmpeg under yt-dlp) may
   * survive until it finishes on its own -- a known Windows limitation.
   */
  function killTree(child) {
    if (!child.pid) {
      killChild(child);
      return;
    }
    if (isWindows) {
      try {
        const killer = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on?.('error', () => killChild(child));
      } catch {
        killChild(child);
      }
      return;
    }
    try {
      killProcess(-child.pid, 'SIGKILL');
    } catch {
      killChild(child);
    }
  }

  /**
   * Run one tool; resolves `{ code, signal, stdout, spawnError, timedOut }`.
   * A tool still running at `timeoutMs` is killed with its process tree and
   * reported as timed out -- but only once it has closed, or `closeGraceMs`
   * after the kill, so the caller never removes a directory it still writes
   * to. stderr is never read (never logged either).
   */
  function runTool({ command, args }, timeoutMs) {
    return new Promise((resolve) => {
      const out = [];
      let outBytes = 0;
      let settled = false;
      let timedOut = false;
      let timer = null;
      let graceTimer = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        resolve({ stdout: Buffer.concat(out).toString('utf8'), signal: null, ...result, timedOut });
      };

      let child;
      try {
        child = spawnImpl(command, args, {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          detached: !isWindows,
        });
      } catch (err) {
        settle({ code: null, spawnError: err });
        return;
      }

      child.stdout?.on?.('data', (chunk) => {
        if (outBytes >= STDOUT_MAX_BYTES) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        out.push(buf);
        outBytes += buf.byteLength;
      });
      child.on('error', (err) => {
        // After a timeout kill only `close` (or the grace timer) ends the run.
        if (!timedOut) settle({ code: null, spawnError: err });
      });
      child.on('close', (code, signal) => settle({ code, signal: signal ?? null, spawnError: null }));

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          timer = null;
          timedOut = true;
          killTree(child);
          graceTimer = setTimeout(() => settle({ code: null, spawnError: null }), closeGraceMs);
        }, timeoutMs);
      }
    });
  }

  /** A fresh per-call directory under tmpDir. */
  function makeWorkDir() {
    return fs.mkdtemp(path.join(tmpDir, 'nep-video-'));
  }

  async function removeWorkDir(dir) {
    if (!dir) return;
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn('fetch-video: temp cleanup failed', { code: err?.code ?? null });
    }
  }

  /** Size of `file` in bytes, or null when it does not exist. */
  async function sizeOf(file) {
    try {
      return (await fs.stat(file)).size;
    } catch {
      return null;
    }
  }

  async function asDataUrl(file, mimeType) {
    const buffer = await fs.readFile(file);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  /**
   * Stream `url` into `file`, stopping at `ceiling` bytes.
   * @returns {Promise<{ ok: true, bytes: number, contentType: string } | { ok: false, reason: string, extra?: object }>}
   */
  async function download(url, file, { ceiling, timeoutMs }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
      : null;
    let handle = null;
    try {
      const response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
      if (!response?.ok) return { ok: false, reason: 'download', extra: { status: response?.status } };
      const contentType = bareContentType(response.headers?.get?.('content-type'));
      if (!contentType.startsWith('video/')) return { ok: false, reason: 'download' };
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > ceiling) return { ok: false, reason: 'size' };
      if (!response.body) return { ok: false, reason: 'download' };

      handle = await fs.open(file, 'w');
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > ceiling) {
          controller.abort();
          return { ok: false, reason: 'size' };
        }
        await handle.write(chunk);
      }
      return { ok: true, bytes, contentType };
    } catch (err) {
      if (timedOut) return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'download', extra: { code: errorCode(err) } };
    } finally {
      if (timer) clearTimeout(timer);
      if (handle) {
        try {
          await handle.close();
        } catch {
          // the directory is removed anyway
        }
      }
    }
  }

  /**
   * Download a video attachment and return it inline: as-is when its known
   * duration fits `maxSeconds` and it fits `maxBytes`, else cut by ffmpeg to
   * a 360p mp4 of the first `maxSeconds`. Never rejects.
   * @param {string} url
   * @param {{ durationSec?: number|null, maxSeconds: number, maxBytes: number, toolTimeoutMs: number,
   *   ffmpegPath: string, fetchTimeoutMs?: number }} options  `fetchTimeoutMs` falls back to `toolTimeoutMs`.
   * A missing ffmpeg (ENOENT) is `tool` -- an error miss the describer retries
   * later, so installing ffmpeg takes effect -- never a permanent length/size.
   * @returns {Promise<{ ok: true, dataUrl: string, mimeType: string, seconds: number|null, bytes: number }
   *   | { ok: false, reason: 'size'|'download'|'tool'|'timeout' }>}
   */
  async function fetchAttachment(url, {
    durationSec = null, maxSeconds, maxBytes, toolTimeoutMs, ffmpegPath, fetchTimeoutMs,
  } = {}) {
    let dir = null;
    try {
      dir = await makeWorkDir();
      const inPath = path.join(dir, 'in');
      const outPath = path.join(dir, 'out.mp4');
      const got = await download(url, inPath, {
        ceiling: maxBytes * DOWNLOAD_CEILING_FACTOR,
        timeoutMs: Number.isFinite(fetchTimeoutMs) ? fetchTimeoutMs : toolTimeoutMs,
      });
      if (!got.ok) return fail('attachment', url, got.reason, got.extra);

      const knownDuration = Number.isFinite(durationSec) ? durationSec : null;
      const fitsLength = knownDuration !== null && knownDuration <= maxSeconds;
      if (fitsLength && got.bytes <= maxBytes) {
        return {
          ok: true,
          dataUrl: await asDataUrl(inPath, got.contentType),
          mimeType: got.contentType,
          seconds: knownDuration,
          bytes: got.bytes,
        };
      }

      const run = await runTool(ffmpegTrimArgs(inPath, outPath, { ffmpegPath, maxSeconds }), toolTimeoutMs);
      if (run.timedOut) return fail('attachment', url, 'timeout', { code: runCode(run) });
      if (run.spawnError) return fail('attachment', url, 'tool', { code: runCode(run) });
      if (run.code !== 0) return fail('attachment', url, 'tool', { code: runCode(run) });

      const bytes = await sizeOf(outPath);
      if (bytes === null) return fail('attachment', url, 'tool', { code: runCode(run) });
      if (bytes > maxBytes) return fail('attachment', url, 'size');
      return {
        ok: true,
        dataUrl: await asDataUrl(outPath, 'video/mp4'),
        mimeType: 'video/mp4',
        seconds: Math.min(knownDuration ?? maxSeconds, maxSeconds),
        bytes,
      };
    } catch (err) {
      return fail('attachment', url, 'download', { code: errorCode(err) });
    } finally {
      await removeWorkDir(dir);
    }
  }

  /**
   * yt-dlp metadata only: duration and title of a video-site link. Never rejects.
   * @param {string} url
   * @param {{ ytdlpPath: string, toolTimeoutMs: number }} options
   * @returns {Promise<{ ok: true, durationSec: number|null, title: string|null }
   *   | { ok: false, reason: 'download'|'tool'|'timeout' }>}
   */
  async function probeSite(url, { ytdlpPath, toolTimeoutMs } = {}) {
    try {
      const run = await runTool(ytdlpProbeArgs(url, { ytdlpPath }), toolTimeoutMs);
      if (run.timedOut) return fail('site', url, 'timeout', { code: runCode(run) });
      if (run.spawnError) return fail('site', url, 'tool', { code: runCode(run) });
      if (run.code !== 0) return fail('site', url, 'download', { code: runCode(run) });
      return { ok: true, ...parseProbe(run.stdout) };
    } catch (err) {
      return fail('site', url, 'tool', { code: errorCode(err) });
    }
  }

  /**
   * yt-dlp clip of the first `maxSeconds` of a video-site link, inlined as an
   * mp4 data URL. `durationSec` (from a probe) lowers the reported seconds
   * when the video is shorter. Never rejects.
   * @param {string} url
   * @param {{ ytdlpPath: string, ffmpegPath: string, maxSeconds: number, maxBytes: number,
   *   toolTimeoutMs: number, durationSec?: number|null }} options
   * @returns {Promise<{ ok: true, dataUrl: string, mimeType: string, seconds: number, bytes: number }
   *   | { ok: false, reason: 'size'|'download'|'tool'|'timeout' }>}
   */
  async function fetchSiteClip(url, {
    ytdlpPath, ffmpegPath, maxSeconds, maxBytes, toolTimeoutMs, durationSec = null,
  } = {}) {
    let dir = null;
    try {
      dir = await makeWorkDir();
      const outPath = path.join(dir, 'clip.mp4');
      const run = await runTool(
        ytdlpClipArgs(url, { ytdlpPath, ffmpegPath, maxSeconds, maxBytes, outPath }),
        toolTimeoutMs,
      );
      if (run.timedOut) return fail('site', url, 'timeout', { code: runCode(run) });
      if (run.spawnError) return fail('site', url, 'tool', { code: runCode(run) });
      if (run.code !== 0) return fail('site', url, 'download', { code: runCode(run) });

      // yt-dlp exits 0 without writing anything when --max-filesize skips the download.
      const bytes = await sizeOf(outPath);
      if (bytes === null || bytes > maxBytes) return fail('site', url, 'size');
      const seconds = Number.isFinite(durationSec) && durationSec < maxSeconds ? durationSec : maxSeconds;
      return {
        ok: true,
        dataUrl: await asDataUrl(outPath, 'video/mp4'),
        mimeType: 'video/mp4',
        seconds,
        bytes,
      };
    } catch (err) {
      return fail('site', url, 'download', { code: errorCode(err) });
    } finally {
      await removeWorkDir(dir);
    }
  }

  /**
   * GET `url` and read at most `maxBytes` of its body as text (the rest is
   * never pulled). Never rejects.
   * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: 'download'|'timeout', extra?: object }>}
   */
  async function fetchText(url, { headers, timeoutMs, maxBytes }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
      : null;
    try {
      const options = { method: 'GET', signal: controller.signal };
      if (headers) options.headers = headers;
      const response = await fetchImpl(url, options);
      if (!response?.ok) return { ok: false, reason: 'download', extra: { status: response?.status } };
      if (!response.body) return { ok: false, reason: 'download' };
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buf);
        bytes += buf.byteLength;
        if (bytes >= maxBytes) {
          controller.abort();
          break;
        }
      }
      return { ok: true, text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8') };
    } catch (err) {
      if (timedOut) return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'download', extra: { code: errorCode(err) } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The duration of a YouTube video without yt-dlp: the Data API first when
   * `apiKey` is a non-empty string (any failure is logged as `api` and falls
   * through), then the watch page (at most 2 MB of it). `pageFallback: false`
   * stops after the Data API (the startup check tells the two apart). Never rejects.
   * @param {string} url
   * @param {{ fetchTimeoutMs?: number, apiKey?: string|null, pageFallback?: boolean }} options
   * @returns {Promise<{ ok: true, durationSec: number } | { ok: false, reason: 'download'|'timeout' }>}
   */
  async function probeYoutube(url, { fetchTimeoutMs, apiKey, pageFallback = true } = {}) {
    try {
      const id = youtubeVideoId(url);
      if (!id) return fail('youtube', url, 'download');

      if (typeof apiKey === 'string' && apiKey) {
        const got = await fetchText(youtubeDataApiUrl(id, apiKey), { timeoutMs: fetchTimeoutMs, maxBytes: PAGE_MAX_BYTES });
        const durationSec = got.ok ? parseYoutubeDataApi(got.text) : null;
        if (durationSec !== null) return { ok: true, durationSec };
        const meta = { source: 'youtube', reason: 'api', location: YOUTUBE_API_LOCATION };
        if (got.ok) meta.status = 200;
        else if (got.reason === 'timeout') meta.code = 'timeout';
        else {
          if (got.extra?.status !== undefined) meta.status = got.extra.status;
          if (got.extra?.code !== undefined && got.extra.code !== null) meta.code = got.extra.code;
        }
        log.warn('fetch-video: failed', meta);
      }
      if (pageFallback === false) return { ok: false, reason: 'download' };

      const pageUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=en`;
      const page = await fetchText(pageUrl, { headers: PAGE_HEADERS, timeoutMs: fetchTimeoutMs, maxBytes: PAGE_MAX_BYTES });
      if (!page.ok) return fail('youtube', pageUrl, page.reason, page.extra);
      const durationSec = parseYoutubePageDuration(page.text);
      if (durationSec === null) return fail('youtube', pageUrl, 'download');
      return { ok: true, durationSec };
    } catch (err) {
      return fail('youtube', url, 'download', { code: errorCode(err) });
    }
  }

  return { fetchAttachment, probeSite, fetchSiteClip, probeYoutube };
}
