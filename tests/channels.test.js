// Tests for src/memory/channels.js: pure activity classification and channel
// rendering for the <server> prompt block (see docs/prompt-contract.md,
// "Server memory (the channel map)"). tests/fixtures/labels.js is an English
// fixture covering every key of the prompt contract, including labels.server.*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelActivity, renderChannel } from '../src/memory/channels.js';
import { labels } from './fixtures/labels.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0); // Sun 20 Sep 2026, 12:00 UTC
const TODAY_KEY = '2026-09-20';
const YESTERDAY_KEY = '2026-09-19';

function channel(overrides = {}) {
  return {
    id: 'c1',
    name: 'general',
    category: null,
    topic: null,
    purpose: '',
    topics: '',
    tone: '',
    days: {},
    messageCount: 0,
    lastMessageAt: null,
    updatedAt: null,
    ...overrides,
  };
}

// --- channelActivity --------------------------------------------------------

test('channelActivity: live when today + yesterday reach the default threshold (20)', () => {
  const c = channel({ days: { [TODAY_KEY]: 15, [YESTERDAY_KEY]: 5 }, lastMessageAt: NOW });
  assert.equal(channelActivity(c, NOW, undefined), 'live');
});

test('channelActivity: exactly at the live threshold is inclusive', () => {
  const c = channel({ days: { [TODAY_KEY]: 20 }, lastMessageAt: NOW });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'live');
});

test('channelActivity: one message short of the live threshold is not live', () => {
  const c = channel({ days: { [TODAY_KEY]: 19 }, lastMessageAt: NOW });
  assert.notEqual(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'live');
});

test('channelActivity: only counts today + yesterday, older days do not count toward "live"', () => {
  const c = channel({ days: { '2026-09-10': 500 }, lastMessageAt: NOW - DAY });
  assert.notEqual(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'live');
});

test('channelActivity: an empty days object never counts as live', () => {
  const c = channel({ days: {}, lastMessageAt: NOW });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 1, deadAfterDays: 7 }), 'slow');
});

test('channelActivity: dead when lastMessageAt is null, regardless of days', () => {
  const c = channel({ lastMessageAt: null });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'dead');
});

test('channelActivity: dead when the last message is older than deadAfterDays', () => {
  const c = channel({ lastMessageAt: NOW - 8 * DAY });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'dead');
});

test('channelActivity: exactly at deadAfterDays is NOT dead yet (slow)', () => {
  const c = channel({ lastMessageAt: NOW - 7 * DAY });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'slow');
});

test('channelActivity: one millisecond past deadAfterDays is dead', () => {
  const c = channel({ lastMessageAt: NOW - 7 * DAY - 1 });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'dead');
});

test('channelActivity: recent activity below the live threshold and within deadAfterDays is "slow"', () => {
  const c = channel({ days: { [TODAY_KEY]: 2 }, lastMessageAt: NOW - DAY });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 20, deadAfterDays: 7 }), 'slow');
});

test('channelActivity: default thresholds (20 / 7 days) apply when cfg is entirely missing', () => {
  const dead = channel({ lastMessageAt: NOW - 8 * DAY });
  assert.equal(channelActivity(dead, NOW), 'dead');
  const slow = channel({ lastMessageAt: NOW - DAY });
  assert.equal(channelActivity(slow, NOW), 'slow');
  const live = channel({ days: { [TODAY_KEY]: 20 }, lastMessageAt: NOW });
  assert.equal(channelActivity(live, NOW), 'live');
});

test('channelActivity: default thresholds apply when cfg is missing one of the two keys', () => {
  const c = channel({ lastMessageAt: NOW - 8 * DAY });
  assert.equal(channelActivity(c, NOW, { liveMessagesPerDay: 1 }), 'dead'); // deadAfterDays still defaults to 7
});

// --- renderChannel -----------------------------------------------------------

test('renderChannel: heading only, no facts, still shows the activity line', () => {
  const c = channel({ name: 'general' });
  const text = renderChannel(c, labels, { current: false, activity: 'slow' });
  assert.equal(text, '# general\nactivity: slow');
});

test('renderChannel: fact lines appear in the documented order: category, topic, purpose, topics, tone, activity', () => {
  const c = channel({
    name: 'general',
    category: 'Text channels',
    topic: 'no politics',
    purpose: 'general chatter',
    topics: 'games, memes',
    tone: 'casual, lots of emoji',
  });
  const text = renderChannel(c, labels, { current: false, activity: 'live' });
  assert.equal(
    text,
    [
      '# general',
      'category: Text channels',
      'topic: no politics',
      'purpose: general chatter',
      'what people write here: games, memes',
      'tone: casual, lots of emoji',
      'activity: live',
    ].join('\n'),
  );
});

test('renderChannel: empty/null facts are omitted, not rendered as empty lines', () => {
  const c = channel({ name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '' });
  const text = renderChannel(c, labels, { current: false, activity: 'dead' });
  assert.equal(text, '# general\nactivity: dead');
});

test('renderChannel: a partial set of facts renders only the non-empty ones, in order', () => {
  const c = channel({ name: 'general', topic: 'no politics', tone: 'chill' });
  const text = renderChannel(c, labels, { current: false, activity: 'slow' });
  assert.equal(text, '# general\ntopic: no politics\ntone: chill\nactivity: slow');
});

test('renderChannel: the current channel gets labels.server.currentMark appended to the heading', () => {
  const c = channel({ name: 'general' });
  const text = renderChannel(c, labels, { current: true, activity: 'live' });
  assert.ok(text.startsWith(`# general${labels.server.currentMark}`));
});

test('renderChannel: activityLive/Slow/Dead select the right label for {activity}', () => {
  const c = channel({ name: 'general' });
  assert.ok(renderChannel(c, labels, { activity: 'live' }).includes(`activity: ${labels.server.activityLive}`));
  assert.ok(renderChannel(c, labels, { activity: 'slow' }).includes(`activity: ${labels.server.activitySlow}`));
  assert.ok(renderChannel(c, labels, { activity: 'dead' }).includes(`activity: ${labels.server.activityDead}`));
});

test('renderChannel: lastMessage is omitted when now is not given, even with lastMessageAt set', () => {
  const c = channel({ name: 'general', lastMessageAt: NOW - 3 * DAY });
  const text = renderChannel(c, labels, { current: false, activity: 'slow' });
  assert.ok(!text.includes('last message'));
});

test('renderChannel: lastMessage is omitted when the channel has never seen a message', () => {
  const c = channel({ name: 'general', lastMessageAt: null });
  const text = renderChannel(c, labels, { current: false, activity: 'dead', now: NOW });
  assert.ok(!text.includes('last message'));
});

test('renderChannel: lastMessage renders a humanised age via labels.units, right before the activity line', () => {
  const c = channel({ name: 'general', lastMessageAt: NOW - 3 * DAY });
  const text = renderChannel(c, labels, { current: false, activity: 'slow', now: NOW });
  assert.equal(text, '# general\nlast message: 3 d ago\nactivity: slow');
});

test('renderChannel: lastMessage under a minute old renders labels.units.lessThanMinute', () => {
  const c = channel({ name: 'general', lastMessageAt: NOW });
  const text = renderChannel(c, labels, { current: false, activity: 'live', now: NOW });
  assert.ok(text.includes(`last message: ${labels.units.lessThanMinute} ago`));
});

test('renderChannel: lastMessage line is omitted entirely when labels.server.lastMessage is missing', () => {
  const noLastMessageLabels = { server: { ...labels.server, lastMessage: undefined }, units: labels.units };
  const c = channel({ name: 'general', lastMessageAt: NOW - 3 * DAY });
  const text = renderChannel(c, noLastMessageLabels, { current: false, activity: 'slow', now: NOW });
  assert.ok(!text.includes('last message'));
});

test('renderChannel: topWriters resolves ids to current names via nameOf, in the stored order', () => {
  const c = channel({ name: 'general', topWriters: [{ id: 'a', count: 8 }, { id: 'b', count: 3 }] });
  const nameOf = (id) => ({ a: 'Alice', b: 'Bob' })[id] ?? null;
  const text = renderChannel(c, labels, { current: false, activity: 'live', nameOf });
  assert.equal(text, '# general\nwrites here most: Alice, Bob\nactivity: live');
});

test('renderChannel: topWriters skips an id nameOf cannot resolve (e.g. someone who left)', () => {
  const c = channel({ name: 'general', topWriters: [{ id: 'a', count: 8 }, { id: 'gone', count: 3 }, { id: 'b', count: 1 }] });
  const nameOf = (id) => ({ a: 'Alice', b: 'Bob' })[id] ?? null;
  const text = renderChannel(c, labels, { current: false, activity: 'live', nameOf });
  assert.ok(text.includes('writes here most: Alice, Bob'));
  assert.ok(!text.includes('gone'));
});

test('renderChannel: topWriters is omitted when there is no nameOf, or an empty list, or no label', () => {
  const c = channel({ name: 'general', topWriters: [{ id: 'a', count: 8 }] });
  assert.ok(!renderChannel(c, labels, { current: false, activity: 'live' }).includes('writes here most'));
  const nameOf = (id) => ({ a: 'Alice' })[id] ?? null;
  assert.ok(!renderChannel(channel({ name: 'general', topWriters: [] }), labels, { activity: 'live', nameOf }).includes('writes here most'));
  const noTopWritersLabels = { server: { ...labels.server, topWriters: undefined }, units: labels.units };
  assert.ok(!renderChannel(c, noTopWritersLabels, { activity: 'live', nameOf }).includes('writes here most'));
});

test('renderChannel: works with a non-English (Greek) labels object', () => {
  const grLabels = {
    server: {
      currentMark: ' (είσαι εδώ)',
      category: 'κατηγορία: {text}',
      topic: 'θέμα: {text}',
      purpose: 'σκοπός: {text}',
      topics: 'τι γράφουν: {text}',
      tone: 'ύφος: {text}',
      activity: 'δραστηριότητα: {activity}',
      activityLive: 'ζωντανό',
      activitySlow: 'αργό',
      activityDead: 'νεκρό',
    },
  };
  const c = channel({ name: 'γενικά', purpose: 'κουβέντα' });
  const text = renderChannel(c, grLabels, { current: true, activity: 'live' });
  assert.equal(text, '# γενικά (είσαι εδώ)\nσκοπός: κουβέντα\nδραστηριότητα: ζωντανό');
});
