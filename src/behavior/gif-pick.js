// The GIF picker's pure side. The `<gifs>` block of a turn shows only the top
// of the library by popularity, so a GIF that carries the reaction of a short
// reply is rarely in front of the persona. After the reply is written, a short
// one (at most `gifs.pick.maxChars` code points) goes to a cheap classifier
// (prompts/gif-pick.md) together with the WHOLE captioned library; when it names
// a handle, the GIF is posted instead of the text (src/behavior/turn.js). This
// module decides when the picker runs, renders the library it reads and reads
// its one-line answer.

import { isPlainObject } from '../config.js';
import { gifCaption, gifLine } from './prompt.js';

/** config.json's `gifs.pick` values: the fallback of a missing or unusable key. */
export const GIF_PICK_DEFAULTS = Object.freeze({
  maxChars: 60,
  contextMessages: 4,
  maxOutputTokens: 60,
});

/**
 * The `gifs.pick` settings of the live config, key by key: `maxChars` (the
 * longest reply, in code points, the picker may replace; a finite number >= 0,
 * floored), `contextMessages` (the chat lines its `<context>` shows; >= 0,
 * floored) and `maxOutputTokens` (> 0, floored); a missing or unusable key
 * takes config.json's value (GIF_PICK_DEFAULTS).
 * @param {object} config  The whole live config.
 * @returns {{ maxChars: number, contextMessages: number, maxOutputTokens: number }}
 */
export function gifPickSettings(config) {
  const group = isPlainObject(config?.gifs?.pick) ? config.gifs.pick : {};
  const read = (key, min) => (Number.isFinite(group[key]) && group[key] >= min ? Math.floor(group[key]) : GIF_PICK_DEFAULTS[key]);
  return { maxChars: read('maxChars', 0), contextMessages: read('contextMessages', 0), maxOutputTokens: read('maxOutputTokens', 1) };
}

/**
 * Whether the picker runs on a reply: its text (the messages joined by a blank
 * line) is not blank and holds at most `settings.maxChars` code points, the
 * turn posts no GIF of its own, and the library has at least one captioned
 * entry. Pure.
 * @param {{ text: string, postsGif: boolean, captioned: number }|null} reply
 *   `captioned`: how many entries renderGifLibrary listed.
 * @param {{ maxChars: number }} settings  gifPickSettings.
 * @returns {boolean}
 */
export function pickCandidates(reply, settings) {
  if (!reply || typeof reply.text !== 'string' || reply.text.trim() === '') return false;
  if (reply.postsGif === true) return false;
  if (!(reply.captioned > 0)) return false;
  return [...reply.text].length <= settings.maxChars;
}

/**
 * The entries of `entries` that have a caption (src/behavior/prompt.js#gifCaption,
 * cut to `listChars`), in the order given: the ones the picker lists. Pure.
 * @param {object[]} entries  The library's entries (src/memory/gifs.js#rankGifs).
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {number} listChars  `gifs.listChars` (0 = whole caption).
 * @returns {object[]}
 */
export function captionedEntries(entries, mediaCache, listChars) {
  return Array.isArray(entries) ? entries.filter((entry) => gifCaption(entry, mediaCache, listChars) !== '') : [];
}

/**
 * The picker's `<gifs>` lines: one per entry of `entries` that has a caption
 * (src/behavior/prompt.js#gifCaption), in the order given, rendered as the
 * turn's `<gifs>` block renders an entry (src/behavior/prompt.js#gifLine:
 * `labels.gifs.entry`, the persona's own-post mark within `ownMarkHours`);
 * no header, no top slice. Entries without a caption are left out; `[]` when
 * the labels carry no `gifs.entry`. Pure.
 * @param {object[]} entries  The library's entries (src/memory/gifs.js#rankGifs).
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {object} labels
 * @param {{ now: number, ownMarkHours: number, listChars: number }} options
 *   `listChars`: `gifs.listChars` (0 = whole caption).
 * @returns {string[]}
 */
export function renderGifLibrary(entries, mediaCache, labels, { now, ownMarkHours, listChars }) {
  if (!labels?.gifs?.entry) return [];
  return captionedEntries(entries, mediaCache, listChars).map((entry) => gifLine(entry, mediaCache, labels, { listChars, ownMarkHours, now }));
}

/**
 * The picker's answer read strictly: the trimmed text, one line, equal to one
 * of `handles` in any case -> that handle as listed; `none`, anything else,
 * several lines or no text -> null. Pure.
 * @param {unknown} text
 * @param {string[]} handles  The handles the request listed.
 * @returns {string|null}
 */
export function parseGifPick(text, handles) {
  if (typeof text !== 'string' || !Array.isArray(handles)) return null;
  const line = text.trim();
  if (line === '' || /[\r\n]/.test(line)) return null;
  const wanted = line.toLowerCase();
  return handles.find((handle) => String(handle).toLowerCase() === wanted) ?? null;
}
