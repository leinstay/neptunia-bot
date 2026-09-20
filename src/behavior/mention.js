// Decides whether the persona reacts to being called at all — before any LLM
// money is spent. People do not answer every ping: the persona sometimes
// ignores one for no reason, ignores more when the same person keeps tagging
// it, and almost always ignores tag spam. The model gets a second veto later
// (<skip/>) for calls that are simply not interesting.

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
 * @param {object} input.cfg            config.mention
 * @param {() => number} input.rng
 * @returns {{ respond: boolean, reason: string, ignoreChance: number }}
 */
export function decideMention({ kind, textLength, recentCalls, neverIgnore, cfg, rng }) {
  if (neverIgnore) return { respond: true, reason: 'never-ignore', ignoreChance: 0 };

  if (kind === 'name') {
    const respond = rng() < cfg.nameTriggerChance;
    return { respond, reason: respond ? 'name' : 'name-unnoticed', ignoreChance: 1 - cfg.nameTriggerChance };
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
  }
  ignoreChance = Math.min(0.97, Math.max(0, ignoreChance));

  const respond = rng() >= ignoreChance;
  return { respond, reason: respond ? 'respond' : `ignored:${reason}`, ignoreChance };
}

export const repeatWindowMs = (cfg) => cfg.repeatWindowMinutes * MINUTE;
