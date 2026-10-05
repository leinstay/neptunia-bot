// Tests for src/mentor/moment.js: the memory as it stood at a real moment of
// the chat -- every dated item written at or after the cutoff hidden, the
// base view never changed, its prompts and config read at call time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenLater, momentCutoff, momentView } from '../src/mentor/moment.js';

const CUTOFF = Date.UTC(2026, 8, 29, 18, 2, 0);
const iso = (ms) => new Date(ms).toISOString();
const BEFORE = iso(CUTOFF - 60_000);
const EARLIER = iso(CUTOFF - 3_600_000);
const AT = iso(CUTOFF);
const AFTER = iso(CUTOFF + 60_000);
const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';

function alice() {
  return {
    id: ALICE,
    names: ['Alice'],
    firstSeen: '2026-08-01T10:00:00.000Z',
    lastSeen: AFTER,
    messageCount: 40,
    character: 'Argues with care.',
    style: 'Long messages, accents: é à.',
    relationship: 'Old friend of the persona.',
    interests: [
      { topic: 'chess', note: '', weight: 3, firstSeen: EARLIER, lastSeen: AFTER },
      { topic: 'όπερα', note: 'new', weight: 1, firstSeen: AT, lastSeen: AT },
      { topic: 'sailing', note: '', weight: 1, firstSeen: AFTER, lastSeen: AFTER },
      { topic: 'tea', note: '', weight: 1, firstSeen: null, lastSeen: null },
    ],
    details: [
      { id: 1, text: 'lives by the sea', weight: 2, firstSeen: BEFORE, lastSeen: AFTER },
      { id: 2, text: 'lost the argument', weight: 1, firstSeen: AFTER, lastSeen: AFTER },
      { id: 3, text: 'undated detail', weight: 1, firstSeen: null, lastSeen: null },
    ],
    detailsSeq: 4,
    aliases: [
      { name: 'Ali', weight: 2, firstSeen: EARLIER, lastSeen: AFTER },
      { name: 'Λίσα', weight: 1, firstSeen: AT, lastSeen: AT },
    ],
    affinity: {
      score: 12,
      reason: 'R3 after the argument',
      history: [
        { ts: EARLIER, delta: 5, appliedDelta: 5, score: 5, reason: 'R1' },
        { ts: BEFORE, delta: 4, appliedDelta: 4, score: 9, reason: 'R2' },
        { ts: AFTER, delta: 3, appliedDelta: 3, score: 12, reason: 'R3 after the argument' },
      ],
    },
    episodes: [
      { date: '2026-09-20', what: 'old episode', quote: '', feeling: '', weight: 3, addedAt: EARLIER },
      { date: '2026-09-29', what: 'the argument itself', quote: '', feeling: 'won it', weight: 4, addedAt: AFTER },
      { date: '2026-09-29', what: 'written at the cutoff', quote: '', feeling: '', weight: 2, addedAt: AT },
      { date: '2026-09-28', what: 'no addedAt, the day before', quote: '', feeling: '', weight: 2 },
      { date: '2026-09-29', what: 'no addedAt, the same day', quote: '', feeling: '', weight: 2 },
      { what: 'no date at all', quote: '', feeling: '', weight: 1 },
    ],
    updatedAt: AFTER,
  };
}

function bruno() {
  return {
    id: BRUNO,
    names: ['Bruno'],
    character: 'Quiet.',
    style: '',
    relationship: '',
    interests: [],
    details: [],
    aliases: [],
    affinity: { score: -4, reason: 'R only after', history: [{ ts: AFTER, delta: -4, appliedDelta: -4, score: -4, reason: 'R only after' }] },
    episodes: [],
  };
}

function guild() {
  return {
    patterns: 'Short greetings.',
    starters: 'Games.',
    injokes: ['the café'],
    self: ['likes rain'],
    learned: [
      { id: 1, text: 'answer in one line', weight: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: AFTER },
      { id: 2, text: 'taught right after', weight: 1, firstSeen: AFTER, lastSeen: AFTER, from: `<@${ALICE}>` },
    ],
    learnedNextId: 3,
  };
}

function lore() {
  return [
    { id: 'a', title: 'Old tale', keys: ['tale'], text: 'Known.', source: 'analyzer', createdAt: EARLIER, updatedAt: AFTER },
    { id: 'b', title: 'The argument', keys: ['argument'], text: 'How it ended.', source: 'analyzer', createdAt: AFTER, updatedAt: AFTER },
    { id: 'c', title: 'Owner note', keys: ['note'], text: 'Undated.', source: 'owner' },
  ];
}

/** A base view (liveView's shape) over plain data, counting its reads; its data is deep-frozen. */
function baseView() {
  const data = deepFreeze({ users: { [ALICE]: alice(), [BRUNO]: bruno() }, guild: guild(), lore: lore(), channels: [{ id: 'c1', name: 'games' }] });
  const hot = { prompts: { rules: 'RULES' }, config: { mentor: {} } };
  return {
    data,
    hot,
    view: {
      get prompts() {
        return hot.prompts;
      },
      get config() {
        return hot.config;
      },
      calibrator: { ratio: 1, apply: (n) => n },
      memory: {
        getGuild: () => data.guild,
        getUser: (id) => data.users[id] ?? null,
        listUserProfiles: () => Object.values(data.users),
        listChannels: () => data.channels,
        getLore: () => data.lore,
      },
    },
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

test('momentCutoff: the trigger time, else the answer time, else null', () => {
  const history = [{ ts: CUTOFF - 120_000 }, { ts: CUTOFF }];
  assert.equal(momentCutoff({ history, at: CUTOFF + 5000 }), CUTOFF);
  assert.equal(momentCutoff({ history: [{ ts: 1 }, {}], at: CUTOFF + 5000 }), CUTOFF + 5000);
  assert.equal(momentCutoff({ history: [{}], at: undefined }), null);
  assert.equal(momentCutoff({ lines: [] }), null);
});

test('momentCutoff: the newest line she saw -- a call in another channel after the chat, or the chat after the trigger', () => {
  const history = [{ id: 'a', ts: CUTOFF - 120_000 }, { id: 'b', ts: CUTOFF - 60_000 }];
  const call = { id: 'c', ts: CUTOFF, self: false };
  const routed = { history, triggerId: 'c', pulled: [{ channelId: '500000000000000002', reason: 'routed', messages: [call] }], at: CUTOFF + 5000 };
  assert.equal(momentCutoff(routed), CUTOFF);
  // Lines after the trigger that her request held: the last of them.
  assert.equal(momentCutoff({ history: [{ id: 't', ts: CUTOFF - 60_000 }, { id: 'n', ts: CUTOFF }], triggerId: 't', at: CUTOFF + 5000 }), CUTOFF);
  // A trigger id found nowhere: the last line, as before.
  assert.equal(momentCutoff({ history, triggerId: 'gone', at: CUTOFF + 5000 }), CUTOFF - 60_000);
});

test('momentView: episodes written at or after the cutoff are hidden, earlier ones kept', () => {
  const { view } = baseView();
  const episodes = momentView(view, CUTOFF).memory.getUser(ALICE).episodes.map((e) => e.what);
  assert.deepEqual(episodes, ['old episode', 'no addedAt, the day before', 'no date at all']);
});

test('momentView: affinity history entries at or after the cutoff are hidden; the reason falls back, the score stays', () => {
  const { view } = baseView();
  const moment = momentView(view, CUTOFF);
  const affinity = moment.memory.getUser(ALICE).affinity;
  assert.deepEqual(affinity.history.map((h) => h.reason), ['R1', 'R2']);
  assert.equal(affinity.reason, 'R2');
  assert.equal(affinity.score, 12);
  // Every entry after the cutoff: no reason left.
  const other = moment.memory.getUser(BRUNO).affinity;
  assert.deepEqual(other.history, []);
  assert.equal(other.reason, '');
  assert.equal(other.score, -4);
  // A reason whose latest entry is before the cutoff is kept as it is.
  const later = momentView(view, CUTOFF + 3_600_000).memory.getUser(ALICE).affinity;
  assert.equal(later.reason, 'R3 after the argument');
  assert.equal(later.history.length, 3);
});

test('momentView: the restored reason looks past kept entries whose reason is empty', () => {
  const { view } = baseView();
  // A two-stage move before the cutoff whose reason was never worded: its entry has none.
  const profile = {
    ...alice(),
    affinity: {
      score: 14,
      reason: 'R3 after the argument',
      history: [
        { ts: EARLIER, delta: 5, appliedDelta: 5, score: 5, reason: 'R1' },
        { ts: BEFORE, delta: 4, appliedDelta: 4, score: 9, reason: '' },
        { ts: AFTER, delta: 5, appliedDelta: 5, score: 14, reason: 'R3 after the argument' },
      ],
    },
  };
  const moment = momentView({ ...view, memory: { ...view.memory, getUser: () => profile } }, CUTOFF);
  const affinity = moment.memory.getUser(ALICE).affinity;
  assert.deepEqual(affinity.history.map((h) => h.reason), ['R1', '']);
  assert.equal(affinity.reason, 'R1');
});

test('momentView: details, interests and aliases first recorded at or after the cutoff are hidden', () => {
  const { view } = baseView();
  const profile = momentView(view, CUTOFF).memory.getUser(ALICE);
  assert.deepEqual(profile.details.map((d) => d.text), ['lives by the sea', 'undated detail']);
  assert.deepEqual(profile.interests.map((i) => i.topic), ['chess', 'tea']);
  assert.deepEqual(profile.aliases.map((a) => a.name), ['Ali']);
  // A kept item is the stored one, unchanged (its later sighting included).
  assert.deepEqual(profile.details[0], alice().details[0]);
});

test('momentView: learned items and lore entries created at or after the cutoff are hidden', () => {
  const { view } = baseView();
  const moment = momentView(view, CUTOFF);
  assert.deepEqual(moment.memory.getGuild().learned.map((i) => i.text), ['answer in one line']);
  assert.deepEqual(moment.memory.getLore().map((e) => e.title), ['Old tale', 'Owner note']);
});

test('momentView: recent lines added at or after the cutoff are hidden; a base without a recent store reads none', () => {
  const { view } = baseView();
  const line = (id, fields = {}) => ({ id, at: CUTOFF - 7_200_000, addedAt: EARLIER, channelId: 'c1', text: `σημείωση ${id}`, who: [], weight: 2, ...fields });
  const stored = deepFreeze({
    nextId: 6,
    lines: [
      line(1),
      line(2, { addedAt: AT }),
      // About a line before the cutoff, written down after it.
      line(3, { at: CUTOFF - 60_000, addedAt: AFTER }),
      // Without the time it was added: judged by the moment it is about.
      line(4, { addedAt: null }),
      line(5, { at: CUTOFF + 60_000, addedAt: null }),
    ],
  });
  const base = { prompts: view.prompts, config: view.config, memory: { ...view.memory, getRecent: () => stored } };
  const seen = momentView(base, CUTOFF).memory.getRecent();
  assert.deepEqual(seen.lines.map((entry) => entry.id), [1, 4]);
  assert.equal(seen.nextId, 6);
  assert.equal(seen.lines[0], stored.lines[0], 'a kept line is the stored one');
  // Nothing to hide: the stored value itself.
  assert.equal(momentView(base, CUTOFF + 3_600_000).memory.getRecent(), stored);
  assert.equal(momentView(view, CUTOFF).memory.getRecent(), null);
  // The counts for the log do not include them.
  assert.deepEqual(hiddenLater(base, CUTOFF), hiddenLater(view, CUTOFF));
});

test('momentView: undated fields, channels, prompts and config are untouched', () => {
  const { view, hot } = baseView();
  const moment = momentView(view, CUTOFF);
  const profile = moment.memory.getUser(ALICE);
  const stored = alice();
  for (const key of ['id', 'names', 'firstSeen', 'lastSeen', 'messageCount', 'character', 'style', 'relationship', 'detailsSeq', 'updatedAt']) {
    assert.deepEqual(profile[key], stored[key], key);
  }
  const g = moment.memory.getGuild();
  const storedGuild = guild();
  for (const key of ['patterns', 'starters', 'injokes', 'self', 'learnedNextId']) assert.deepEqual(g[key], storedGuild[key], key);
  assert.equal(moment.memory.listChannels(), view.memory.listChannels());
  assert.equal(moment.memory.getUser('333333333333333333'), null);
  assert.equal(moment.calibrator, view.calibrator);
  // Prompts and config are read through at call time.
  hot.prompts = { rules: 'NEW RULES' };
  assert.equal(moment.prompts.rules, 'NEW RULES');
  assert.equal(moment.config, hot.config);
});

test('momentView: listUserProfiles is filtered like getUser', () => {
  const { view } = baseView();
  const moment = momentView(view, CUTOFF);
  const listed = moment.memory.listUserProfiles();
  assert.deepEqual(listed.map((p) => p.id), [ALICE, BRUNO]);
  assert.deepEqual(listed[0], moment.memory.getUser(ALICE));
});

test('momentView: a profile or guild without the dated lists passes through', () => {
  const bare = { id: ALICE, names: ['Alice'], character: 'x' };
  const view = {
    prompts: {},
    config: {},
    memory: { getGuild: () => ({ patterns: 'p' }), getUser: () => bare, listUserProfiles: () => [bare], listChannels: () => [], getLore: () => null },
  };
  const moment = momentView(view, CUTOFF);
  assert.deepEqual(moment.memory.getUser(ALICE), bare);
  assert.deepEqual(moment.memory.getGuild(), { patterns: 'p' });
  assert.equal(moment.memory.getLore(), null);
  assert.deepEqual(hiddenLater(view, CUTOFF), { episodes: 0, affinity: 0, reasons: 0, details: 0, interests: 0, aliases: 0, learned: 0, lore: 0 });
});

test('hiddenLater: counts what the cutoff hides, by kind', () => {
  const { view } = baseView();
  assert.deepEqual(hiddenLater(view, CUTOFF), {
    episodes: 3,
    affinity: 2,
    reasons: 2,
    details: 1,
    interests: 2,
    aliases: 1,
    learned: 1,
    lore: 1,
  });
});
