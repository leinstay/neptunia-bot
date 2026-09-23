// Turns a video the persona is shown into something a video-capable model can
// take: a Discord attachment is downloaded and, when short and small enough,
// inlined as-is; otherwise ffmpeg cuts it to the first `maxSeconds` at 360p.
// A video-site link goes through yt-dlp: a metadata-only probe (duration,
// title) and a clip download of the first `maxSeconds`. The argument arrays
// come from the pure src/discord/video-sites.js; this module is only the edge
// (child processes, fetch, temp files).
//
// Every function resolves to a result object and never rejects. Temp files
// live in a fresh directory per call under `tmpDir`, removed in `finally`.
// Log lines carry the host and path only -- never a query string (a Discord
// CDN signature, tracking ids), never file contents; the tool's stderr tail
// is logged with every URL in it replaced by `<url>`.

import { spawn } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { ffmpegTrimArgs, parseProbe, safeLocation, ytdlpClipArgs, ytdlpProbeArgs } from './video-sites.js';

const STDERR_KEEP_CHARS = 4000;
const STDERR_LOG_CHARS = 200;
const STDOUT_MAX_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_CEILING_FACTOR = 4;
const URL_IN_TEXT = /https?:\/\/\S+/gi;

/** The last STDERR_LOG_CHARS of `text` with every http(s) URL replaced by `<url>`. */
function scrub(text) {
  return String(text ?? '').replace(URL_IN_TEXT, '<url>').slice(-STDERR_LOG_CHARS);
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
 */
export function createVideoFetcher({
  spawnImpl = spawn,
  fetchImpl = fetch,
  fs = fsPromises,
  tmpDir = os.tmpdir(),
} = {}) {
  /** One warn line per failure, then the failure object. */
  function fail(source, url, reason, extra = {}) {
    const meta = { source, reason, location: safeLocation(url) };
    if (extra.stderr) meta.stderr = scrub(extra.stderr);
    if (extra.error) meta.error = scrub(extra.error);
    if (extra.status !== undefined) meta.status = extra.status;
    log.warn('fetch-video: failed', meta);
    return { ok: false, reason };
  }

  /**
   * Run one tool; resolves `{ code, stdout, stderr, spawnError, timedOut }`.
   * A tool still running at `timeoutMs` is killed and reported as timed out.
   */
  function runTool({ command, args }, timeoutMs) {
    return new Promise((resolve) => {
      const out = [];
      let outBytes = 0;
      let stderr = '';
      let settled = false;
      let timer = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr, ...result });
      };

      let child;
      try {
        child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        settle({ code: null, spawnError: err, timedOut: false });
        return;
      }

      child.stdout?.on?.('data', (chunk) => {
        if (outBytes >= STDOUT_MAX_BYTES) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        out.push(buf);
        outBytes += buf.byteLength;
      });
      child.stderr?.on?.('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-STDERR_KEEP_CHARS);
      });
      child.on('error', (err) => settle({ code: null, spawnError: err, timedOut: false }));
      child.on('close', (code) => settle({ code, spawnError: null, timedOut: false }));

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
          settle({ code: null, spawnError: null, timedOut: true });
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
      return { ok: false, reason: 'download', extra: { error: err?.message ?? err } };
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
   * @returns {Promise<{ ok: true, dataUrl: string, mimeType: string, seconds: number|null, bytes: number }
   *   | { ok: false, reason: 'length'|'size'|'download'|'tool'|'timeout' }>}
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
      if (run.timedOut) return fail('attachment', url, 'timeout', { stderr: run.stderr });
      if (run.spawnError) {
        const reason = run.spawnError.code === 'ENOENT' ? (fitsLength ? 'size' : 'length') : 'tool';
        return fail('attachment', url, reason, { error: run.spawnError.code ?? run.spawnError.message });
      }
      if (run.code !== 0) return fail('attachment', url, 'tool', { stderr: run.stderr });

      const bytes = await sizeOf(outPath);
      if (bytes === null) return fail('attachment', url, 'tool', { stderr: run.stderr });
      if (bytes > maxBytes) return fail('attachment', url, 'size');
      return {
        ok: true,
        dataUrl: await asDataUrl(outPath, 'video/mp4'),
        mimeType: 'video/mp4',
        seconds: Math.min(knownDuration ?? maxSeconds, maxSeconds),
        bytes,
      };
    } catch (err) {
      return fail('attachment', url, 'download', { error: err?.code ?? err?.message ?? err });
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
      if (run.timedOut) return fail('site', url, 'timeout', { stderr: run.stderr });
      if (run.spawnError) return fail('site', url, 'tool', { error: run.spawnError.code ?? run.spawnError.message });
      if (run.code !== 0) return fail('site', url, 'download', { stderr: run.stderr });
      return { ok: true, ...parseProbe(run.stdout) };
    } catch (err) {
      return fail('site', url, 'tool', { error: err?.message ?? err });
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
      if (run.timedOut) return fail('site', url, 'timeout', { stderr: run.stderr });
      if (run.spawnError) return fail('site', url, 'tool', { error: run.spawnError.code ?? run.spawnError.message });
      if (run.code !== 0) return fail('site', url, 'download', { stderr: run.stderr });

      // yt-dlp exits 0 without writing anything when --max-filesize skips the download.
      const bytes = await sizeOf(outPath);
      if (bytes === null || bytes > maxBytes) return fail('site', url, 'size', { stderr: run.stderr });
      const seconds = Number.isFinite(durationSec) && durationSec < maxSeconds ? durationSec : maxSeconds;
      return {
        ok: true,
        dataUrl: await asDataUrl(outPath, 'video/mp4'),
        mimeType: 'video/mp4',
        seconds,
        bytes,
      };
    } catch (err) {
      return fail('site', url, 'download', { error: err?.code ?? err?.message ?? err });
    } finally {
      await removeWorkDir(dir);
    }
  }

  return { fetchAttachment, probeSite, fetchSiteClip };
}
