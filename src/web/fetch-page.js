// Fetches a web page someone linked so the persona can read it, as plain
// text. The URL comes from a chat message, i.e. from anyone, so this module
// is first of all an SSRF guard: only http/https; never localhost or an IP
// literal; the hostname is resolved before EVERY request (the first one and
// each redirect, which are followed by hand) and refused when any address it
// resolves to is loopback, private, link-local, unspecified (or an
// IPv4-mapped IPv6 form of one). The body is streamed under a byte cap and a
// single timeout covers the whole chain, DNS included.
//
// A residual window stays: `fetch` resolves the hostname again itself, so a
// DNS answer that changes between our check and its connect (rebinding) is
// not caught here -- pinning the address would need a custom dispatcher,
// which the built-in fetch does not expose without a dependency.
//
// Every call resolves to a result object and never rejects. One warn line per
// failure, carrying the reason, an HTTP status and `host/path` -- never a
// query string (tracking ids, tokens), never the page text.

import dns from 'node:dns';
import net from 'node:net';
import { log } from '../log.js';
import { htmlToText, pageTitle, truncateText } from './readable.js';

const REQUEST_HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (compatible; neptunia-bot/1.0)',
  Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
  'Accept-Language': 'en,ru;q=0.8',
});
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const PLAIN_TYPE = 'text/plain';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const CHARSET_SNIFF_BYTES = 2048;

/** `hostname/path`, no query string -- safe to log. */
function safeLocation(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '(unparsable url)';
  }
}

/** `type/subtype` in lowercase, parameters dropped. */
function bareContentType(value) {
  return String(value ?? '').split(';')[0].trim().toLowerCase();
}

/** The four octets of a dotted IPv4 address, or null. */
function ipv4Octets(ip) {
  if (net.isIPv4(ip) !== true) return null;
  return ip.split('.').map(Number);
}

function isForbiddenIpv4([a, b]) {
  return a === 0 // this network, 0.0.0.0 included
    || a === 127 // loopback
    || a === 10 // private
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 169 && b === 254) // link-local
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || a >= 224; // multicast, reserved, broadcast
}

/** The eight 16-bit groups of an IPv6 address (zone id already removed), or null. */
function ipv6Groups(ip) {
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const dotted = text.slice(lastColon + 1);
  if (dotted.includes('.')) {
    // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes its two hex groups.
    const octets = ipv4Octets(dotted);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part ? part.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(missing).fill(0), ...rest];
  return groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * Whether the bot must never connect to `ip`: loopback (127/8, ::1), private
 * (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16,
 * fe80::/10), unspecified (0.0.0.0, ::), an IPv4-mapped or IPv4-compatible
 * IPv6 form of those -- plus 0/8, carrier-grade NAT (100.64/10) and
 * multicast/reserved space, which no public page lives on either. Anything
 * that is not a valid address fails closed (true).
 * @param {string} ip
 * @returns {boolean}
 */
export function isForbiddenAddress(ip) {
  if (typeof ip !== 'string' || !ip) return true;
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = ipv4Octets(bare);
  if (v4) return isForbiddenIpv4(v4);
  if (net.isIPv6(bare) !== true) return true;
  const g = ipv6Groups(bare);
  if (!g) return true;
  const firstFive = g.slice(0, 5).every((x) => x === 0);
  if (firstFive && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
    return isForbiddenIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]); // ::ffff:a.b.c.d, ::a.b.c.d
  }
  return (g[0] & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (g[0] & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (g[0] & 0xff00) === 0xff00; // multicast
}

/** `promise`, rejected early when `signal` aborts. */
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Drop a response body we will not read, ignoring any error. */
function discardBody(response) {
  try {
    const pending = response?.body?.cancel?.();
    pending?.catch?.(() => {});
  } catch {
    // nothing to release
  }
}

/** The charset to decode with: the header's, else an HTML meta declaration, else utf-8. */
function pickCharset(contentTypeHeader, bytes, isHtml) {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentTypeHeader ?? ''));
  if (fromHeader) return fromHeader[1];
  if (!isHtml) return 'utf-8';
  const head = bytes.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1');
  const fromMeta = /<meta\b[^>]*charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'utf-8';
}

function decode(bytes, charset) {
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(host: string, options: { all: true }) => Promise<Array<{ address: string, family: number }>>} [deps.lookup]
 */
export function createPageFetcher({ fetchImpl = fetch, lookup = dns.promises.lookup } = {}) {
  /** One warn line (reason, status, host/path), then the failure object. */
  function fail(url, reason, status) {
    const meta = { reason };
    if (status !== undefined) meta.status = status;
    meta.location = safeLocation(url);
    log.warn('fetch-page: failed', meta);
    return status === undefined ? { ok: false, reason } : { ok: false, reason, status };
  }

  /**
   * 'ok', 'private' or 'network' for `hostname`. localhost and IP literals
   * are refused without a lookup. A lookup cut short by the timeout rethrows,
   * so the caller reports `timeout`.
   */
  async function checkHost(hostname, signal) {
    const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost')) return 'private';
    if (net.isIP(host.split('%')[0]) !== 0) return 'private';
    let answers;
    try {
      answers = await raceAbort(lookup(host, { all: true }), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      return 'network';
    }
    const list = (Array.isArray(answers) ? answers : [answers]).filter(Boolean);
    if (!list.length) return 'network';
    return list.some((entry) => isForbiddenAddress(typeof entry === 'string' ? entry : entry.address)) ? 'private' : 'ok';
  }

  /**
   * Fetch `url` as readable text behind the SSRF guard (see the header
   * comment). HTML goes through `htmlToText` (cut to `maxChars`) with its
   * title; text/plain comes back as written (cut to `maxChars` when given).
   * Never rejects.
   * @param {string} url
   * @param {{ maxBytes?: number, timeoutMs?: number, maxRedirects?: number, maxChars?: number }} [options]
   * @returns {Promise<{ ok: true, text: string, title: string|null, contentType: string, bytes: number, finalUrl: string }
   *   | { ok: false, reason: 'scheme'|'private'|'redirects'|'type'|'size'|'timeout'|'http'|'network', status?: number }>}
   */
  async function fetchText(url, { maxBytes, timeoutMs, maxRedirects = 3, maxChars } = {}) {
    const byteCap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const hops = Number.isInteger(maxRedirects) && maxRedirects >= 0 ? maxRedirects : 3;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, waitMs);

    let current = String(url ?? '');
    try {
      for (let hop = 0; ; hop += 1) {
        let parsed;
        try {
          parsed = new URL(current);
        } catch {
          return fail(current, 'scheme');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail(current, 'scheme');

        const verdict = await checkHost(parsed.hostname, controller.signal);
        if (verdict !== 'ok') return fail(current, verdict);

        const response = await fetchImpl(parsed.href, {
          method: 'GET',
          redirect: 'manual',
          headers: { ...REQUEST_HEADERS },
          signal: controller.signal,
        });
        if (!response || typeof response !== 'object') return fail(current, 'network');
        const { status } = response;

        if (REDIRECT_STATUSES.has(status)) {
          discardBody(response);
          const location = response.headers?.get?.('location');
          if (!location) return fail(current, 'http', status);
          if (hop >= hops) return fail(current, 'redirects');
          try {
            current = new URL(location, parsed).href;
          } catch {
            return fail(current, 'http', status);
          }
          continue;
        }
        if (!response.ok) {
          discardBody(response);
          return fail(current, 'http', status);
        }

        const rawType = response.headers?.get?.('content-type');
        const contentType = bareContentType(rawType);
        const isHtml = HTML_TYPES.has(contentType);
        if (!isHtml && contentType !== PLAIN_TYPE) {
          discardBody(response);
          return fail(current, 'type');
        }
        const declared = Number(response.headers?.get?.('content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > byteCap) {
          discardBody(response);
          return fail(current, 'size');
        }

        const chunks = [];
        let bytes = 0;
        if (response.body) {
          for await (const chunk of response.body) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buf.byteLength;
            if (bytes > byteCap) {
              controller.abort();
              return fail(current, 'size');
            }
            chunks.push(buf);
          }
        }
        const raw = Buffer.concat(chunks);
        const source = decode(raw, pickCharset(rawType, raw, isHtml));
        return {
          ok: true,
          text: isHtml ? htmlToText(source, { maxChars }) : truncateText(source, maxChars),
          title: isHtml ? pageTitle(source) : null,
          contentType,
          bytes,
          finalUrl: parsed.href,
        };
      }
    } catch {
      return fail(current, timedOut ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchText };
}
