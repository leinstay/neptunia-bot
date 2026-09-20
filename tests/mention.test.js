// Tests for src/behavior/mention.js: whether/how the persona was called, and
// whether it reacts to it at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTrigger, strippedLength, createTagHistory, decideMention, repeatWindowMs } from '../src/behavior/mention.js';

const NAME_TRIGGERS = ['нептуния', 'непка'];

// --- detectTrigger ----------------------------------------------------------

test('detectTrigger: a reply takes priority over a mention', () => {
  const kind = detectTrigger({ mentionsSelf: true, repliesToSelf: true, content: '', nameTriggers: NAME_TRIGGERS });
  assert.equal(kind, 'reply');
});

test('detectTrigger: a mention takes priority over a name match', () => {
  const kind = detectTrigger({
    mentionsSelf: true,
    repliesToSelf: false,
    content: 'непка привет',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'mention');
});

test('detectTrigger: falls back to a name match when neither reply nor mention', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'эй непка как дела',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: returns null when nothing matches', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'просто болтовня',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, null);
});

test('detectTrigger: name matching is case-insensitive', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'ЭЙ НЕПКА ЧТО ТАМ',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: only matches whole words, not a substring inside a longer word', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'непканепонятно вообще',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, null);
});

test('detectTrigger: whole-word matching works with Cyrillic word boundaries (punctuation)', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'слушай, непка, ты тут?',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: a name at the very start or end of the message still matches', () => {
  const start = detectTrigger({ mentionsSelf: false, repliesToSelf: false, content: 'непка', nameTriggers: NAME_TRIGGERS });
  assert.equal(start, 'name');
});

// --- strippedLength -----------------------------------------------------------

test('strippedLength: a bare @name mention leaves nothing', () => {
  assert.equal(strippedLength('@Непка', 'Непка'), 0);
});

test('strippedLength: a bare Discord <@id> mention leaves nothing', () => {
  assert.equal(strippedLength('<@123456>', 'Непка'), 0);
});

test('strippedLength: a nickname mention format <@!id> is also stripped', () => {
  assert.equal(strippedLength('<@!123456>', 'Непка'), 0);
});

test('strippedLength: counts the remaining text after removing the mention', () => {
  assert.equal(strippedLength('@Непка как дела?', 'Непка'), 'как дела?'.length);
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
