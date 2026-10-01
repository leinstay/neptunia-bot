// Pure rules of the GIF watch (src/memory/describe.js#watchGif), shared by
// the describer, the `<senses>` block (src/behavior/prompt.js) and the owner's
// status lines (src/admin.js), so all three agree on whether GIFs are watched
// right now, which prompt a watch uses and how many watches today has left.
// A GIF watch has its own daily counter (`state.data.gifWatchDay` /
// `gifWatchCount`, `media.gif.maxPerDay`), separate from the video one.

/** `media.gif.maxPerDay` when missing or invalid (config.json carries the same). */
export const GIF_MAX_PER_DAY_FALLBACK = 200;

/** The prompt files a GIF watch can use, the dedicated one first. */
const GIF_PROMPTS = ['describe-gif', 'describe-video'];

/**
 * The prompt a GIF watch uses under the live prompts: `describe-gif` when it
 * is there, else `describe-video`; null when neither is.
 * @param {object} [prompts]  hot.prompts.
 * @returns {{ name: string, text: string }|null}
 */
export function gifWatchPrompt(prompts) {
  for (const name of GIF_PROMPTS) {
    const text = prompts?.[name];
    if (typeof text === 'string' && text) return { name, text };
  }
  return null;
}

/**
 * Why GIFs are not watched under the live config and prompts, or null when
 * they are: `off` (features.mediaDescriptions not on, or `media.gif.watch`
 * false -- a missing key counts as on), `video-off` (features.videoDescriptions
 * false: video vision off) or `prompt` (neither describe-gif nor describe-video).
 * @param {object} [config]   hot.config.
 * @param {object} [prompts]  hot.prompts.
 * @returns {'off'|'video-off'|'prompt'|null}
 */
export function gifWatchBlocker(config, prompts) {
  const features = config?.features ?? {};
  if (features.mediaDescriptions !== true || config?.media?.gif?.watch === false) return 'off';
  if (features.videoDescriptions === false) return 'video-off';
  if (!gifWatchPrompt(prompts)) return 'prompt';
  return null;
}

/**
 * The daily GIF watch cap: `media.gif.maxPerDay` (0 = no watches), else the fallback.
 * @param {object} [config]  hot.config.
 * @returns {number}
 */
export function gifWatchCap(config) {
  const cap = config?.media?.gif?.maxPerDay;
  return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? cap : GIF_MAX_PER_DAY_FALLBACK;
}

/**
 * Today's GIF watches against the cap, read only (the describer rolls the day over).
 * @param {object} [data]    store.state.data.
 * @param {object} [config]  hot.config.
 * @param {string} today     `YYYY-MM-DD` (UTC).
 * @returns {{ used: number, cap: number }}
 */
export function gifWatchesToday(data, config, today) {
  const count = data?.gifWatchCount;
  const used = data?.gifWatchDay === today && Number.isFinite(count) ? count : 0;
  return { used, cap: gifWatchCap(config) };
}
