// Tests for src/behavior/mention.js: whether/how the persona was called, and
// whether it reacts to it at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTrigger,
  strippedLength,
  createTagHistory,
  decideMention,
  repeatWindowMs,
  isFollowUpOpen,
  followUpPreFilter,
  parseFollowUpVerdict,
} from '../src/behavior/mention.js';

const NAME_TRIGGERS = ['νεπτούνια'];

// --- detectTrigger ----------------------------------------------------------

test('detectTrigger: a reply takes priority over a mention', () => {
  const kind = detectTrigger({ mentionsSelf: true, repliesToSelf: true, content: '', nameTriggers: NAME_TRIGGERS });
  assert.equal(kind, 'reply');
});

test('detectTrigger: a mention takes priority over a name match', () => {
  const kind = detectTrigger({
    mentionsSelf: true,
    repliesToSelf: false,
    content: 'νεπτούνια γεια',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'mention');
});

test('detectTrigger: falls back to a name match when neither reply nor mention', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'έι νεπτούνια πώς είσαι',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: returns null when nothing matches', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'απλή κουβέντα',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, null);
});

test('detectTrigger: name matching is case-insensitive', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'ΕΙ ΝΕΠΤΟΎΝΙΑ ΤΙ ΓΙΝΕΤΑΙ',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: only matches whole words, not a substring inside a longer word', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'νεπτούνιαπου ακατανόητο εντελώς',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, null);
});

test('detectTrigger: whole-word matching works with non-Latin word boundaries (punctuation)', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'άκου, νεπτούνια, είσαι εδώ;',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: a name at the very start or end of the message still matches', () => {
  const start = detectTrigger({ mentionsSelf: false, repliesToSelf: false, content: 'νεπτούνια', nameTriggers: NAME_TRIGGERS });
  assert.equal(start, 'name');
});

// --- strippedLength -----------------------------------------------------------

test('strippedLength: a bare @name mention leaves nothing', () => {
  assert.equal(strippedLength('@Νεπτούνια', 'Νεπτούνια'), 0);
});

test('strippedLength: a bare Discord <@id> mention leaves nothing', () => {
  assert.equal(strippedLength('<@123456>', 'Νεπτούνια'), 0);
});

test('strippedLength: a nickname mention format <@!id> is also stripped', () => {
  assert.equal(strippedLength('<@!123456>', 'Νεπτούνια'), 0);
});

test('strippedLength: counts the remaining text after removing the mention', () => {
  assert.equal(strippedLength('@Νεπτούνια πώς είσαι;', 'Νεπτούνια'), 'πώς είσαι;'.length);
});

// --- createTagHistory -----------------------------------------------------------

test('createTagHistory: counts hits within the window, this call included', () => {
  const history = createTagHistory();
  assert.equal(history.hit('u1', 1000, 60_000), 1);
  assert.equal(history.hit('u1', 2000, 60_000), 2);
  assert.equal(history.hit('u1', 3000, 60_000), 3);
});

test('createTagHistory: hits outside the window age out', () => {
  const history = createTagHistory();
  history.hit('u1', 0, 1000);
  assert.equal(history.hit('u1', 5000, 1000), 1); // the first hit is long gone
});

test('createTagHistory: tracks different users independently', () => {
  const history = createTagHistory();
  history.hit('u1', 0, 60_000);
  assert.equal(history.hit('u2', 100, 60_000), 1);
});

test('repeatWindowMs: converts minutes to milliseconds', () => {
  assert.equal(repeatWindowMs({ repeatWindowMinutes: 10 }), 10 * 60_000);
});

// --- decideMention -----------------------------------------------------------

const CFG = {
  ignoreChance: 0.12,
  emptyMentionIgnoreChance: 0.35,
  repeatPenalty: 0.25,
  spamThreshold: 4,
  spamIgnoreChance: 0.9,
  nameTriggerChance: 0.5,
  affinityIgnoreBonus: 0.3,
  affinityLikeBonus: 0.08,
};

function rngReturning(value) {
  return () => value;
}

test('decideMention: neverIgnore always responds regardless of rng', () => {
  const result = decideMention({
    kind: 'mention',
    textLength: 0,
    recentCalls: 10,
    neverIgnore: true,
    cfg: CFG,
    rng: rngReturning(0.999),
  });
  assert.deepEqual(result, { respond: true, reason: 'never-ignore', ignoreChance: 0 });
});

test('decideMention: name trigger responds based on nameTriggerChance', () => {
  const respond = decideMention({ kind: 'name', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0.4) });
  assert.equal(respond.respond, true); // 0.4 < 0.5
  assert.equal(respond.reason, 'name');

  const ignore = decideMention({ kind: 'name', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0.6) });
  assert.equal(ignore.respond, false); // 0.6 >= 0.5
  assert.equal(ignore.reason, 'name-unnoticed');
  assert.equal(ignore.ignoreChance, 0.5);
});

test('decideMention: a bare ping (mention, empty text) uses emptyMentionIgnoreChance', () => {
  const result = decideMention({ kind: 'mention', textLength: 0, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0.5) });
  assert.equal(result.ignoreChance, CFG.emptyMentionIgnoreChance);
  assert.equal(result.reason, 'respond'); // rng 0.5 >= 0.35
});

test('decideMention: a bare ping can also be ignored when rng lands under the chance', () => {
  const result = decideMention({ kind: 'mention', textLength: 0, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  assert.equal(result.reason, 'ignored:bare-ping');
  assert.equal(result.respond, false);
});

test('decideMention: repeat calls accumulate a penalty on top of the base ignore chance', () => {
  // kind 'reply', textLength > 0 -> base ignoreChance, recentCalls=3 adds repeatPenalty*(3-1)
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 3, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  const expected = CFG.ignoreChance + CFG.repeatPenalty * 2;
  assert.equal(result.ignoreChance, expected);
  assert.equal(result.reason, 'ignored:repeat'); // rng 0 < ignoreChance -> ignored
});

test('decideMention: repeat penalty accumulation can still let it respond when rng is high enough', () => {
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 3, neverIgnore: false, cfg: CFG, rng: rngReturning(1) });
  assert.equal(result.reason, 'respond');
  assert.equal(result.respond, true);
});

test('decideMention: spam threshold overrides the ignore chance entirely (not additive)', () => {
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 4, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  assert.equal(result.ignoreChance, CFG.spamIgnoreChance);
  assert.equal(result.reason, 'ignored:spam'); // rng 0 < 0.9 -> ignored
});

test('decideMention: spam can still slip through on a high rng roll', () => {
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 4, neverIgnore: false, cfg: CFG, rng: rngReturning(0.95) });
  assert.equal(result.reason, 'respond');
  assert.equal(result.respond, true); // rng 0.95 >= 0.9
});

test('decideMention: the ignore chance is clamped to 0.97 at most', () => {
  // A high spamThreshold keeps this in the repeat-penalty branch instead of the spam branch.
  const cfg = { ...CFG, ignoreChance: 0.9, repeatPenalty: 0.5, spamThreshold: 1000 };
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 10, neverIgnore: false, cfg, rng: rngReturning(0.98) });
  assert.equal(result.ignoreChance, 0.97);
  assert.equal(result.respond, true); // rng 0.98 >= 0.97
});

test('decideMention: the ignore chance never drops below 0', () => {
  const cfg = { ...CFG, ignoreChance: -5 };
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 1, neverIgnore: false, cfg, rng: rngReturning(0.001) });
  assert.equal(result.ignoreChance, 0);
  assert.equal(result.respond, true);
});

test('decideMention: plain random ignore uses the base ignoreChance for a non-empty mention/reply', () => {
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  assert.equal(result.ignoreChance, CFG.ignoreChance);
  assert.equal(result.reason, 'ignored:random');
  assert.equal(result.respond, false); // rng 0 < 0.12
});

// --- decideMention: affinityScore -------------------------------------------

test('decideMention: a disliked caller (negative affinity) raises the ignore chance', () => {
  const neutral = decideMention({ kind: 'reply', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  const disliked = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: false,
    affinityScore: -100,
    cfg: CFG,
    rng: rngReturning(0),
  });
  assert.equal(disliked.ignoreChance, neutral.ignoreChance + CFG.affinityIgnoreBonus);
});

test('decideMention: a liked caller (positive affinity) lowers the ignore chance', () => {
  const neutral = decideMention({ kind: 'reply', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  const liked = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: false,
    affinityScore: 100,
    cfg: CFG,
    rng: rngReturning(0),
  });
  assert.equal(liked.ignoreChance, neutral.ignoreChance - CFG.affinityLikeBonus);
});

test('decideMention: the affinity adjustment still respects the 0..0.97 clamp', () => {
  const cfg = { ...CFG, ignoreChance: 0.9 };
  const result = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: false,
    affinityScore: -100,
    cfg,
    rng: rngReturning(0.99),
  });
  assert.equal(result.ignoreChance, 0.97);
});

test('decideMention: affinityScore is ignored for neverIgnore', () => {
  const result = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: true,
    affinityScore: -100,
    cfg: CFG,
    rng: rngReturning(0.999),
  });
  assert.deepEqual(result, { respond: true, reason: 'never-ignore', ignoreChance: 0 });
});

test('decideMention: affinityScore is ignored for the "name" kind', () => {
  const withAffinity = decideMention({
    kind: 'name',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: false,
    affinityScore: -100,
    cfg: CFG,
    rng: rngReturning(0.4),
  });
  const withoutAffinity = decideMention({ kind: 'name', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0.4) });
  assert.deepEqual(withAffinity, withoutAffinity);
});

// --- The address classifier: isFollowUpOpen / followUpPreFilter / parseFollowUpVerdict --

const FOLLOW_UP_CFG = { followUpMinutes: 2, followUpNoStreak: 3 };

test('isFollowUpOpen: false when there is no window at all', () => {
  assert.equal(isFollowUpOpen(null, 1000, FOLLOW_UP_CFG), false);
  assert.equal(isFollowUpOpen(undefined, 1000, FOLLOW_UP_CFG), false);
});

test('isFollowUpOpen: true right after the persona answered', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 0 };
  assert.equal(isFollowUpOpen(state, 1000, FOLLOW_UP_CFG), true);
  assert.equal(isFollowUpOpen(state, 1000 + 60_000, FOLLOW_UP_CFG), true); // 1 min < followUpMinutes=2
});

test('isFollowUpOpen: false once followUpMinutes has passed since the last answer', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 0 };
  assert.equal(isFollowUpOpen(state, 1000 + 2 * 60_000, FOLLOW_UP_CFG), false);
});

test('isFollowUpOpen: false once noStreak reaches followUpNoStreak, even if still fresh', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 3 };
  assert.equal(isFollowUpOpen(state, 1000, FOLLOW_UP_CFG), false);
});

test('isFollowUpOpen: true just below the noStreak cap', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 2 };
  assert.equal(isFollowUpOpen(state, 1000, FOLLOW_UP_CFG), true);
});

test('isFollowUpOpen: falls back to defaults (2 min, streak 3) when cfg omits the keys', () => {
  const state = { openedAt: 0, lastAnswerAt: 0, noStreak: 0 };
  assert.equal(isFollowUpOpen(state, 119_000, {}), true); // just under 2 min
  assert.equal(isFollowUpOpen(state, 120_000, {}), false); // exactly 2 min
});

test('followUpPreFilter: a reply to another message is always "no" material', () => {
  const normalized = { replyToId: 'm100', mentionedUserIds: [] };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
});

test('followUpPreFilter: a mention of another member is always "no" material', () => {
  const normalized = { replyToId: null, mentionedUserIds: ['u2'] };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
});

test('followUpPreFilter: a mention of the persona itself does not pre-filter', () => {
  const normalized = { replyToId: null, mentionedUserIds: ['self1'] };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: plain text with no reply and no mention reaches the model', () => {
  const normalized = { replyToId: null, mentionedUserIds: [] };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: mentionedUserIds omitted is treated as empty', () => {
  const normalized = { replyToId: null };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('parseFollowUpVerdict: a bare "yes" is a yes', () => {
  assert.equal(parseFollowUpVerdict('yes'), 'yes');
});

test('parseFollowUpVerdict: case-insensitive and tolerates surrounding text/whitespace', () => {
  assert.equal(parseFollowUpVerdict('  Yes, obviously.'), 'yes');
  assert.equal(parseFollowUpVerdict('YES'), 'yes');
});

test('parseFollowUpVerdict: "no" and anything else is a no', () => {
  assert.equal(parseFollowUpVerdict('no'), 'no');
  assert.equal(parseFollowUpVerdict('No.'), 'no');
  assert.equal(parseFollowUpVerdict('not sure'), 'no');
  assert.equal(parseFollowUpVerdict(''), 'no');
  assert.equal(parseFollowUpVerdict(null), 'no');
  assert.equal(parseFollowUpVerdict(undefined), 'no');
});

test('decideMention: affinityScore is ignored inside the spam branch', () => {
  const withAffinity = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 4,
    neverIgnore: false,
    affinityScore: -100,
    cfg: CFG,
    rng: rngReturning(0),
  });
  const withoutAffinity = decideMention({ kind: 'reply', textLength: 5, recentCalls: 4, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  assert.equal(withAffinity.ignoreChance, withoutAffinity.ignoreChance);
  assert.equal(withAffinity.ignoreChance, CFG.spamIgnoreChance);
});
