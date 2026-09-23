// Decides whether the persona reacts to being called at all — before any LLM
// money is spent. People do not answer every ping: the persona sometimes
// ignores one for no reason, ignores more when the same person keeps tagging
// it, and almost always ignores tag spam. The model gets a second veto later
// (<skip/>) for calls that are simply not interesting.

import { ignoreAdjustment } from '../memory/affinity.js';

const MINUTE = 60_000;

/** How the persona was called. Order matters: a pinged reply is a 'reply', not a 'mention'. */
export function detectTrigger({ mentionsSelf, repliesToSelf, content, nameTriggers }) {
  if (repliesToSelf) return 'reply';
  if (mentionsSelf) return 'mention';
  const lowered = content.toLowerCase();
  const named = nameTriggers.some((name) => {
    const at = lowered.indexOf(name.toLowerCase());
    if (at === -1) return false;
    // Whole word only, so a name trigger inside a longer word or URL does not count.
    const before = lowered[at - 1];
    const after = lowered[at + name.length];
    const isLetter = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
    return !isLetter(before) && !isLetter(after);
  });
  return named ? 'name' : null;
}

/** Message text without the mention itself — an empty rest means a bare ping. */
export function strippedLength(content, selfName) {
  return content.replaceAll(`@${selfName}`, '').replace(/<@!?\d+>/g, '').trim().length;
}

/**
 * Remembers when each user called the persona, to spot repeated tags and spam.
 * Deliberately in-memory only: a restart forgiving everyone is fine.
 */
export function createTagHistory() {
  const times = new Map();
  return {
    /** Register a call and return how many calls this user made within `windowMs`, this one included. */
    hit(userId, now, windowMs) {
      const recent = (times.get(userId) ?? []).filter((ts) => now - ts <= windowMs);
      recent.push(now);
      times.set(userId, recent);
      return recent.length;
    },
  };
}

/**
 * @param {object} input
 * @param {'mention'|'reply'|'name'} input.kind
 * @param {number} input.textLength     Length of the message without the mention.
 * @param {number} input.recentCalls    Calls by this user within the repeat window, this one included.
 * @param {boolean} input.neverIgnore
 * @param {number} [input.affinityScore]  The caller's stored affinity score, if known
 *   (features.relationships). Nudges the ignore chance up for someone disliked, down
 *   for someone liked; never for neverIgnore, a name trigger, or tag spam.
 * @param {object} input.cfg            config.mention
 * @param {() => number} input.rng
 * @returns {{ respond: boolean, reason: string, ignoreChance: number }}
 */
export function decideMention({ kind, textLength, recentCalls, neverIgnore, affinityScore, cfg, rng }) {
  if (neverIgnore) return { respond: true, reason: 'never-ignore', ignoreChance: 0 };

  if (kind === 'name') {
    const roll = rng();
    const respond = roll < cfg.nameTriggerChance;
    return { respond, reason: respond ? 'name' : 'name-unnoticed', ignoreChance: 1 - cfg.nameTriggerChance, roll };
  }

  let ignoreChance = cfg.ignoreChance;
  let reason = 'random';
  if (recentCalls >= cfg.spamThreshold) {
    ignoreChance = cfg.spamIgnoreChance;
    reason = 'spam';
  } else {
    if (kind === 'mention' && textLength === 0) {
      ignoreChance = cfg.emptyMentionIgnoreChance;
      reason = 'bare-ping';
    }
    if (recentCalls > 1) {
      ignoreChance += cfg.repeatPenalty * (recentCalls - 1);
      reason = 'repeat';
    }
    ignoreChance += ignoreAdjustment(affinityScore, cfg);
  }
  ignoreChance = Math.min(0.97, Math.max(0, ignoreChance));

  const roll = rng();
  const respond = roll >= ignoreChance;
  return { respond, reason: respond ? 'respond' : `ignored:${reason}`, ignoreChance, roll };
}

export const repeatWindowMs = (cfg) => cfg.repeatWindowMinutes * MINUTE;

// --- The address classifier --------------------------------------------------
// After the persona answers in a channel, a conversation window stays open for
// a little while: an UNTAGGED message inside it is not answered blindly, it is
// checked by a cheap classifier first (see events.js and
// docs/prompt-contract.md, "The address classifier"). The functions
// below are the pure pieces of that decision.

/**
 * Whether a follow-up window (per channel; see events.js) is currently open:
 * the persona answered recently enough, and has not been ignored
 * `cfg.followUpNoStreak` times in a row since.
 * @param {{ lastAnswerAt: number, noStreak: number }|null|undefined} state
 * @param {number} now
 * @param {{ followUpMinutes?: number, followUpNoStreak?: number }} cfg  config.mention
 */
export function isFollowUpOpen(state, now, cfg) {
  if (!state) return false;
  const minutes = cfg?.followUpMinutes ?? 15;
  const noStreakLimit = cfg?.followUpNoStreak ?? 3;
  return now - state.lastAnswerAt < minutes * MINUTE && state.noStreak < noStreakLimit;
}

/**
 * A reply to another member, or a mention of another member (not the
 * persona), is always `no` before the classifier is ever asked — see the
 * prompt contract. `normalized` is the shape src/discord/collect.js's
 * `normalizeMessage` produces.
 * @param {{ replyToId: string|null, mentionedUserIds: string[] }} normalized
 * @param {string} selfId
 */
export function followUpPreFilter(normalized, selfId) {
  if (normalized.replyToId) return true;
  return (normalized.mentionedUserIds ?? []).some((id) => id !== selfId);
}

/** The classifier answers with one word: `yes` when it starts with 'y' (case-insensitive), else `no`. */
export function parseFollowUpVerdict(text) {
  const firstWord = String(text ?? '').trim().split(/\s+/)[0] ?? '';
  return firstWord.toLowerCase().startsWith('y') ? 'yes' : 'no';
}

// The helper models, grouped by modality under the `classifier` config block.
// Each resolver takes the full hot config at the moment of use. The older
// per-feature keys are never read: config.json always ships `classifier.*`,
// so they could never take effect; deprecatedModelKeys lets startup warn.

/**
 * The text classifier model (the address classifier, the re-watch
 * classifier): `classifier.text`, else the media model
 * (classifierMediaModel); `undefined` when none is set.
 * @param {object|undefined} config  the full hot config
 * @returns {string|undefined}
 */
export function classifierTextModel(config) {
  return config?.classifier?.text || classifierMediaModel(config);
}

/**
 * The picture model (the media describer): `classifier.media`. No fallback:
 * the describer needs a vision-capable model. `undefined` when none is set.
 * @param {object|undefined} config  the full hot config
 * @returns {string|undefined}
 */
export function classifierMediaModel(config) {
  return config?.classifier?.media || undefined;
}

/**
 * The video model (the video describer and its second look):
 * `classifier.video`. `undefined` when none is set.
 * @param {object|undefined} config  the full hot config
 * @returns {string|undefined}
 */
export function classifierVideoModel(config) {
  return config?.classifier?.video || undefined;
}

const DEPRECATED_MODEL_KEYS = [
  { key: 'llm.classifierModel', use: 'classifier.text', read: (c) => c?.llm?.classifierModel },
  { key: 'mention.followUpModel', use: 'classifier.text', read: (c) => c?.mention?.followUpModel },
  { key: 'media.model', use: 'classifier.media', read: (c) => c?.media?.model },
  { key: 'media.video.model', use: 'classifier.video', read: (c) => c?.media?.video?.model },
];

/**
 * The old model keys set (non-null) in `config`, each with the key that
 * replaced it -- they are ignored, so startup warns about them. Key names
 * only, never a value.
 * @param {object|undefined} config  the full hot config
 * @returns {Array<{ key: string, use: string }>}
 */
export function deprecatedModelKeys(config) {
  return DEPRECATED_MODEL_KEYS.filter(({ read }) => read(config) != null).map(({ key, use }) => ({ key, use }));
}

/**
 * DEPRECATED alias of classifierTextModel, kept for callers written against
 * the earlier `llm.classifierModel` shape.
 * @param {object|undefined} config  the full hot config
 * @returns {string|undefined}
 */
export function classifierModelOf(config) {
  return classifierTextModel(config);
}
