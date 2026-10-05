// The input of one turn's request, named in full. src/behavior/prompt.js#buildRequest
// reads many optional inputs, and an input a caller forgets is silently
// absent: the request is built without its block and nothing fails. Every
// caller that builds a turn's request (src/behavior/turn.js, and the mentor's
// sandbox, which leaves some out on purpose) passes its context through here,
// so a key left out throws instead. `null` says "deliberately absent";
// `undefined` (or a missing key) is an omission. Pure.

/**
 * Every input buildRequest reads, in the order of its JSDoc. A test reads
 * buildRequest's source and fails when this list and its inputs differ.
 * @type {readonly string[]}
 */
export const TURN_INPUT_KEYS = Object.freeze([
  'config',
  'prompts',
  'calibrator',
  'mode',
  'forced',
  'now',
  'selfName',
  'history',
  'neighbors',
  'trigger',
  'triggerKind',
  'guildMemory',
  'interlocutor',
  'privateChat',
  'privateProfile',
  'otherProfiles',
  'candidateProfiles',
  'nameOf',
  'channels',
  'loreEntries',
  'currentChannelId',
  'descriptions',
  'neighborDescriptions',
  'videos',
  'reads',
  'lookup',
  'searchAvailable',
  'drawQuota',
  'drawReason',
  'customEmoji',
  'mediaCache',
  'gifs',
  'worn',
  'pulled',
  'source',
  'focus',
  'elsewhereDestination',
  'readOnlyIds',
  'recentLines',
  'recentAudience',
]);

const KNOWN = new Set(TURN_INPUT_KEYS);

/**
 * buildRequest's input from a turn's context: every key of TURN_INPUT_KEYS,
 * in that order, taken from `ctx` as it is. A key that is missing or
 * `undefined` throws (an input nobody named); `null` passes as the
 * deliberately absent input, which buildRequest reads like an omitted one.
 * A key buildRequest does not read throws too (a misspelt input).
 * @param {Record<string, unknown>} ctx
 * @returns {Record<string, unknown>}
 * @throws {Error} naming the first key that is missing or unknown.
 */
export function turnRequestInput(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('turnRequestInput: no context');
  const unknown = Object.keys(ctx).find((key) => !KNOWN.has(key));
  if (unknown !== undefined) throw new Error(`turnRequestInput: buildRequest reads no input '${unknown}'`);
  const input = {};
  for (const key of TURN_INPUT_KEYS) {
    if (ctx[key] === undefined) throw new Error(`turnRequestInput: input '${key}' is not named (null marks it absent)`);
    input[key] = ctx[key];
  }
  return input;
}
