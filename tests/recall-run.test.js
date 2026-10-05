// Tests for src/behavior/recall-run.js: the recall runner over a fake guild
// (REST search, member search, channels with history), a fake store, a fake
// LLM and a fake describer. No network, no real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecall } from '../src/behavior/recall-run.js';
import { HIT_MARK, snowflakeAt } from '../src/behavior/recall.js';
import { DailyCapError } from '../src/llm/openrouter.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const RABBIT = Date.UTC(2026, 9, 1, 18, 44);
const GUILD = 'g1';
const PROMPT = 'You are {{name}}; {{answerChars}}.';

/** The shipped config.json with the given groups merged over a fresh copy (one level deep). */
function config(overrides = {}) {
  const base = structuredClone(SHIPPED_CONFIG);
  base.bot = { ...base.bot, timezone: 'UTC' };
  for (const [key, value] of Object.entries(overrides)) base[key] = { ...base[key], ...value };
  return base;
}

/** One stored line of a fake channel: `{ id, ts, author, content, bot, attachment }`. */
function line(id, ts, { author = 'u1', name = 'Ana', content = `line ${id}`, bot = false, attachment = null } = {}) {
  return { id, ts, author, name, content, bot, attachment };
}

/** A discord.js-shaped message of `channelId` from a stored line. */
function djs(channelId, l) {
  const attachments = new Map();
  if (l.attachment) attachments.set(l.attachment.id, { id: l.attachment.id, contentType: 'image/png', name: 'x.png', url: 'https://cdn.example/x.png', size: 10 });
  return {
    id: l.id,
    channelId,
    createdTimestamp: l.ts,
    cleanContent: l.content,
    content: l.content,
    author: { id: l.author, username: l.name.toLowerCase(), bot: l.bot },
    member: { displayName: l.name },
    attachments,
    embeds: [],
    stickers: new Map(),
    reactions: { cache: new Map() },
    mentions: { users: new Map() },
  };
}

/** A raw API search hit of a stored line. */
function rawHit(channelId, l) {
  return { id: l.id, channel_id: channelId, timestamp: new Date(l.ts).toISOString(), author: { id: l.author, username: l.name.toLowerCase(), global_name: l.name, bot: l.bot }, content: l.content };
}

/**
 * A scene: a guild with #general (c1, the turn's channel), #garden (c2) and #private (c4, which @everyone cannot
 * view, so the audience rail refuses it here); `lines` per channel id; `answers(route, query)` gives the REST body.
 */
function scene({ lines = {}, answers = () => ({ total_results: 0, messages: [] }), answer = 'stretch: 1\nAna did it on October 1.', features = {}, recall = {}, state = {}, capLeft = 100, describer = null, profiles = [], timers } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const guild = {
    id: GUILD,
    members: { me: { id: 'self' } },
    roles: { everyone: { id: GUILD }, cache: new Map() },
    channels: { cache: new Map() },
    client: {
      rest: {
        get: async (route, { query, signal }) => {
          calls.push({ route, query: Object.fromEntries(query), signal });
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return answers(route, Object.fromEntries(query), signal);
        },
      },
    },
  };
  const fetches = [];
  const addChannel = (id, name, { everyone = true } = {}) => {
    const stored = lines[id] ?? [];
    const channel = {
      id,
      name,
      guild,
      viewable: true,
      lastMessageId: null,
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor: (target) => ({ has: () => everyone || target?.id === 'self' }),
      permissionOverwrites: { cache: new Map() },
      messages: {
        fetch: async ({ around, limit }) => {
          fetches.push({ channel: id, around, limit });
          const at = stored.findIndex((l) => l.id === around);
          const from = Math.max(0, at - Math.floor(limit / 2));
          return new Map(stored.slice(from, from + limit).map((l) => [l.id, djs(id, l)]));
        },
      },
    };
    guild.channels.cache.set(id, channel);
    return channel;
  };
  const channel = addChannel('c1', 'general');
  addChannel('c2', 'garden');
  addChannel('c4', 'private', { everyone: false });

  const data = { ...state };
  let dirty = 0;
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {
        dirty += 1;
      },
    },
    listUserProfiles: () => profiles,
  };
  const llmCalls = [];
  const llm = {
    capLeft: () => capLeft,
    complete: async (messages, options) => {
      llmCalls.push({ messages, options });
      if (answer instanceof Error) throw answer;
      return { text: answer };
    },
  };
  const hot = {
    config: config({ features, recall: { ...recall }, llm: { helperTimeoutMs: 30000 } }),
    prompts: { 'recall-summary': PROMPT, labels },
  };
  const recaller = createRecall({ hot, store, llm, describer, now: () => NOW, ...(timers ? { timers } : {}) });
  const history = [
    { id: 'h1', channelId: 'c1', ts: NOW - 30 * MINUTE, self: false, bot: false, authorName: 'Nikos', content: 'τι έγινε με το κουνέλι;' },
    { id: 'h2', channelId: 'c1', ts: NOW - MINUTE, self: false, bot: false, authorName: 'Nikos', content: 'ποιος σκότωσε το κουνέλι;' },
  ];
  const args = { guild, guildId: GUILD, channel, selfId: 'self', selfName: 'Zoë', history, candidate: history[1] };
  return {
    recaller,
    args,
    calls,
    fetches,
    llmCalls,
    data,
    hot,
    dirty: () => dirty,
    maxInFlight: () => maxInFlight,
  };
}

/** The message searches among the REST calls. */
const searches = (calls) => calls.filter((c) => c.route.endsWith('/messages/search'));

const RABBIT_LINES = [
  line('r0', RABBIT - 6 * MINUTE, { name: 'Βασίλης', author: 'u2', content: 'πάμε κυνήγι' }),
  line('r1', RABBIT - 4 * MINUTE, { name: 'Ana', content: 'bang', attachment: { id: 'p1' } }),
  line('r2', RABBIT, { name: 'Βασίλης', author: 'u2', content: 'το κουνέλι πέθανε' }),
  line('r3', RABBIT + 2 * MINUTE, { name: 'Ana', content: 'κηδεία για το κουνέλι' }),
  line('r4', RABBIT + 3 * MINUTE, { name: 'Birthdays', author: 'bot1', content: 'κουνέλι birthday!', bot: true }),
];
const GARDEN_LINES = [
  line('g1', RABBIT - 30 * HOUR, { name: 'Éloïse', author: 'u3', content: 'ένα κουνέλι στον κήπο' }),
  line('g2', RABBIT - 30 * HOUR + MINUTE, { name: 'Ana', content: 'ωραίο' }),
];
const PRIVATE_LINES = [line('s1', RABBIT - HOUR, { name: 'Ana', content: 'μυστικό κουνέλι' })];

/** Search answers: `κουνέλι` hits the rabbit lines (the bot's too), the garden and the private channel; `κουνελιού` nothing. */
function rabbitAnswers(route, query) {
  if (route.endsWith('/members/search')) return [];
  if (query.content === 'κουνέλι') {
    return {
      total_results: 5,
      messages: [[rawHit('c1', RABBIT_LINES[4])], [rawHit('c1', RABBIT_LINES[3])], [rawHit('c1', RABBIT_LINES[2])], [rawHit('c4', PRIVATE_LINES[0])], [rawHit('c2', GARDEN_LINES[0])]],
    };
  }
  return { total_results: 0, messages: [] };
}

const RABBIT_SERVER = { forms: ['κουνέλι', 'κουνελιού'], who: [], from: null, to: null };

test('recall: forms are searched one after another in order; the summary reads the windows and names a stretch', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES, c4: PRIVATE_LINES }, answers: rabbitAnswers, recall: { answerChars: 900 } });
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.deepEqual(searches(s.calls).map((c) => c.query.content), ['κουνέλι', 'κουνελιού']);
  assert.equal(s.maxInFlight(), 1, 'never two searches at once');
  assert.ok(searches(s.calls).every((c) => c.query.max_id === snowflakeAt(NOW - 30 * MINUTE)), 'the turn\'s own chat never takes a result slot');
  assert.equal(result.text, 'Ana did it on October 1.');
  assert.equal(result.stretch.channelId, 'c1');
  assert.equal(result.stretch.channelName, 'general');
  assert.equal(s.data.recallCount, 1, 'one run, one count');
  assert.ok(s.dirty() >= 1);

  const { messages, options } = s.llmCalls[0];
  assert.equal(options.purpose, 'recall-summary');
  assert.equal(options.role, 'classifier.text');
  assert.equal(messages[0].content, 'You are Zoë; 900.');
  const user = messages[1].content;
  assert.ok(user.includes('## 1 | 2026-10-01 | #general') && user.includes('## 2 | 2026-09-30 | #garden'), user);
  assert.ok(user.includes(`${HIT_MARK}#3 [18:44] Βασίλης: το κουνέλι πέθανε`), user);
  assert.ok(user.endsWith('<question>\nNikos: ποιος σκότωσε το κουνέλι;\n</question>'));
  const summary = logs.find((l) => l.msg === 'recall: summary');
  assert.deepEqual([summary.answer, summary.stretch], ['text', true]);
});

test('recall: a channel the audience rail refuses contributes nothing, other bots are dropped, the persona stays', async () => {
  const own = line('r5', RABBIT + 5 * MINUTE, { name: 'Zoë', author: 'self', content: 'κουνέλι, αντίο' });
  const s = scene({
    lines: { c1: [...RABBIT_LINES, own], c2: GARDEN_LINES, c4: PRIVATE_LINES },
    answers: (route, query) => (query.content === 'κουνέλι' ? { total_results: 3, messages: [[rawHit('c1', own)], [rawHit('c1', RABBIT_LINES[4])], [rawHit('c4', PRIVATE_LINES[0])]] } : rabbitAnswers(route, query)),
  });
  const { logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { ...RABBIT_SERVER, forms: ['κουνέλι'] } }));
  assert.ok(!s.fetches.some((f) => f.channel === 'c4'), 'no window of the refused channel');
  assert.deepEqual(s.fetches.map((f) => f.around), ['r5'], 'the bot\'s hit is gone, the persona\'s own is kept');
  const user = s.llmCalls[0].messages[1].content;
  assert.ok(!user.includes('μυστικό') && !user.includes('birthday'), 'neither the refused channel nor the bot line is shown');
  assert.ok(user.includes('Zoë (you): κουνέλι, αντίο'));
  const searched = logs.find((l) => l.msg === 'recall: searched');
  assert.deepEqual([searched.hits, searched.kept, searched.clusters], [3, 1, 1]);
});

test('recall: the turn\'s own lines are dropped from the hits and the windows', async () => {
  const visible = line('h2', NOW - MINUTE, { name: 'Nikos', author: 'u5', content: 'ποιος σκότωσε το κουνέλι;' });
  const s = scene({
    lines: { c1: [...RABBIT_LINES.slice(0, 4), visible] },
    answers: (route, query) => (query.content === 'κουνέλι' ? { total_results: 2, messages: [[rawHit('c1', visible)], [rawHit('c1', RABBIT_LINES[3])]] } : { total_results: 0, messages: [] }),
  });
  const { logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { ...RABBIT_SERVER, forms: ['κουνέλι'] } }));
  assert.equal(logs.find((l) => l.msg === 'recall: searched').kept, 1);
  assert.deepEqual(s.fetches.map((f) => f.around), ['r3']);
  assert.ok(!s.llmCalls[0].messages[1].content.includes('<found>\n## 1 | 2026-10-05'), 'the window holds no line of the turn');
  assert.equal((s.llmCalls[0].messages[1].content.match(/ποιος σκότωσε/g) ?? []).length, 1, 'the question alone carries it');
});

test('recall: a Latin name form found by the member search adds an author query; a stored name needs no member search', async () => {
  const kite = line('k1', RABBIT - 300 * HOUR, { name: 'Kitezu', author: 'u7', content: 'γεια' });
  const s = scene({
    lines: { c1: [kite] },
    answers: (route, query) => {
      if (route.endsWith('/members/search')) return [{ nick: null, user: { id: 'u7', username: 'kitezu.', global_name: 'Kitezu', bot: false } }];
      if (query.author_id === 'u7') return { total_results: 1, messages: [[rawHit('c1', kite)]] };
      return { total_results: 0, messages: [] };
    },
  });
  const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { forms: [], who: ['kitezu'], from: null, to: null } }));
  assert.deepEqual(s.calls.map((c) => [c.route.split('/').at(-2), c.query.query ?? c.query.content ?? c.query.author_id]), [
    ['members', 'kitezu'],
    ['messages', 'kitezu'],
    ['messages', 'u7'],
  ]);
  assert.deepEqual(result.people, [{ id: 'u7', name: 'Kitezu', username: 'kitezu.', count: 1, newestTs: kite.ts }]);
  assert.ok(s.llmCalls[0].messages[1].content.includes('<people>\nKitezu | kitezu. | 1 | 2026-09-19\n</people>'));
  assert.equal(s.data.recallCount, 1, 'the member search and the message searches count as one run');

  const stored = scene({ profiles: [{ id: 'u3', names: ['Éloïse'], aliases: [{ name: 'Ελο' }] }] });
  await withCapturedLogs(() => stored.recaller.run({ ...stored.args, server: { forms: [], who: ['ελο'], from: null, to: null } }));
  assert.ok(!stored.calls.some((c) => c.route.endsWith('/members/search')), 'no member search for a stored name');
  assert.deepEqual(searches(stored.calls).map((c) => c.query.content ?? c.query.author_id), ['ελο', 'u3']);
});

test('recall: a date range alone is sampled at evenly spaced offsets of its total', async () => {
  const day = line('d1', Date.UTC(2025, 11, 18, 15), { content: 'καλημέρα' });
  const s = scene({
    lines: { c1: [day] },
    recall: { dateSamples: 4 },
    answers: (route, query) => ({ total_results: 2115, messages: query.offset ? [] : [[rawHit('c1', day)]] }),
  });
  const from = Date.UTC(2025, 11, 18);
  const to = Date.UTC(2025, 11, 19) - 1;
  await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { forms: [], who: [], from, to } }));
  const sent = searches(s.calls);
  assert.deepEqual(sent.map((c) => c.query.offset ?? '0'), ['0', '528', '1057', '1586']);
  assert.ok(sent.every((c) => !c.query.content && !c.query.author_id && c.query.min_id === snowflakeAt(from) && c.query.max_id === snowflakeAt(to + 1)));
});

test('recall: the daily recall cap and the daily request cap stop it before any request', async () => {
  const capped = scene({ recall: { maxPerDay: 3 }, state: { recallDay: '2026-10-05', recallCount: 3 } });
  const first = await withCapturedLogs(() => capped.recaller.run({ ...capped.args, server: RABBIT_SERVER }));
  assert.equal(capped.calls.length, 0);
  assert.equal(capped.recaller.available(), false);
  assert.deepEqual(first.logs.map((l) => [l.msg, l.reason]), [['recall: skipped', 'daily']]);
  assert.equal(capped.data.recallCount, 3);

  const spent = scene({ capLeft: 0 });
  const second = await withCapturedLogs(() => spent.recaller.run({ ...spent.args, server: RABBIT_SERVER }));
  assert.equal(spent.calls.length, 0);
  assert.deepEqual(second.logs.map((l) => [l.msg, l.reason]), [['recall: skipped', 'daily-cap']]);
  assert.equal(second.result.text, null);
  assert.equal(scene().recaller.available(), true);
});

test('recall: the switch off, a private chat or nothing asked make no request', async () => {
  const off = scene({ features: { recall: false } });
  const quiet = await withCapturedLogs(() => off.recaller.run({ ...off.args, server: RABBIT_SERVER }));
  assert.equal(off.calls.length, 0);
  assert.equal(quiet.logs.length, 0);
  assert.equal(off.recaller.available(), false);

  const dm = scene();
  const priv = await withCapturedLogs(() => dm.recaller.run({ ...dm.args, channel: { id: 'dm1' }, server: RABBIT_SERVER }));
  assert.deepEqual(priv.logs.map((l) => l.reason), ['private-chat']);
  const none = await withCapturedLogs(() => dm.recaller.run({ ...dm.args, server: { forms: [], who: [], from: null, to: null } }));
  assert.deepEqual(none.logs.map((l) => l.reason), ['no-query']);
  assert.equal(dm.calls.length, 0);
});

test('recall: the time budget abandons the run with no text and aborts its request', async () => {
  const s = scene({
    recall: { timeoutMs: 20 },
    // Ref'd timers: the production one is unref'd, and nothing else keeps this test's event loop alive.
    timers: { set: (fn, ms) => ({ handle: setTimeout(fn, ms) }), clear: (timer) => clearTimeout(timer.handle) },
    answers: (route, query, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
  });
  const { result, logs } = await withCapturedLogs(async () => {
    const out = await s.recaller.run({ ...s.args, server: RABBIT_SERVER });
    await new Promise((resolve) => setImmediate(resolve));
    return out;
  });
  assert.equal(result.text, null);
  assert.equal(result.stretch, null);
  assert.ok(s.calls[0].signal.aborted);
  assert.equal(searches(s.calls).length, 1, 'no further search after the abandon');
  assert.ok(logs.some((l) => l.msg === 'recall: failed' && l.reason === 'timeout'));
  assert.ok(!logs.some((l) => l.msg === 'recall: summary'));
  assert.equal(s.llmCalls.length, 0);
});

test('recall: a nothing answer gives no text and no stretch; a refused summary logs its rail code', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, answer: 'nothing' });
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.deepEqual([result.text, result.stretch], [null, null]);
  const summary = logs.find((l) => l.msg === 'recall: summary');
  assert.deepEqual([summary.answer, summary.stretch], ['nothing', false]);

  const refused = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, answer: new DailyCapError('cap') });
  const second = await withCapturedLogs(() => refused.recaller.run({ ...refused.args, server: RABBIT_SERVER }));
  assert.equal(second.result.text, null);
  assert.equal(second.logs.find((l) => l.msg === 'recall: failed').reason, 'daily-cap');
});

test('recall: no hit left skips the summary', async () => {
  const s = scene();
  const { result, logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(result.text, null);
  assert.equal(s.llmCalls.length, 0);
  assert.ok(logs.some((l) => l.msg === 'recall: skipped' && l.reason === 'no-hits'));
});

test('recall: a window shows the cached caption of its picture and asks for no fresh one', async () => {
  const asked = [];
  const describer = {
    cachedDescriptions: (guildId, items) => {
      asked.push(items.map((i) => i.itemId));
      return new Map([['p1', 'ένα κουνέλι στο γρασίδι']]);
    },
    describeMany: async () => {
      throw new Error('fixture: no fresh caption may be asked');
    },
  };
  const s = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, describer });
  await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.deepEqual(asked, [['p1']]);
  assert.ok(s.llmCalls[0].messages[1].content.includes('Ana: bang [image: ένα κουνέλι στο γρασίδι]'));

  const blind = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, describer, features: { mediaDescriptions: false } });
  await withCapturedLogs(() => blind.recaller.run({ ...blind.args, server: RABBIT_SERVER }));
  assert.equal(asked.length, 1, 'captions off: the cache is not asked');
  assert.ok(blind.llmCalls[0].messages[1].content.includes('Ana: bang [image]'));
});

test('recall: the stretch is the named window without indices; out of range names none; the cut keeps matched lines', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES }, answers: rabbitAnswers, answer: 'stretch: 2\nÉloïse saw one.' });
  const { result } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: RABBIT_SERVER }));
  assert.equal(result.stretch.channelId, 'c2');
  assert.equal(result.stretch.startTs, GARDEN_LINES[0].ts);
  assert.equal(result.stretch.lines, `${HIT_MARK}[12:44] Éloïse: ένα κουνέλι στον κήπο\n[12:45] Ana: ωραίο`);

  const far = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES }, answers: rabbitAnswers, answer: 'stretch: 3\nÉloïse saw one.' });
  const second = await withCapturedLogs(() => far.recaller.run({ ...far.args, server: RABBIT_SERVER }));
  assert.equal(second.result.stretch, null);
  assert.equal(second.result.text, 'Éloïse saw one.');

  const cut = scene({ lines: { c1: RABBIT_LINES }, answers: rabbitAnswers, recall: { stretchChars: 60 }, answer: 'stretch: 1\nAna.' });
  const third = await withCapturedLogs(() => cut.recaller.run({ ...cut.args, server: RABBIT_SERVER }));
  const kept = third.result.stretch.lines.split('\n');
  assert.deepEqual(kept, [`${HIT_MARK}[18:44] Βασίλης: το κουνέλι πέθανε`, `${HIT_MARK}[18:46] Ana: κηδεία για το κουνέλι`]);
});

test('recall: logs carry counts, ids and codes, never a form, a name or a message', async () => {
  const s = scene({ lines: { c1: RABBIT_LINES, c2: GARDEN_LINES }, answers: rabbitAnswers, profiles: [{ id: 'u3', names: ['Éloïse'], aliases: [] }] });
  const { logs } = await withCapturedLogs(() => s.recaller.run({ ...s.args, server: { ...RABBIT_SERVER, who: ['éloïse'] } }));
  const text = JSON.stringify(logs);
  for (const secret of ['κουνέλι', 'κουνελιού', 'éloïse', 'Éloïse', 'Βασίλης', 'πέθανε', 'Ana did it', 'general', 'garden']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.ok(logs.some((l) => l.msg === 'recall: searched' && Number.isInteger(l.queries)));
});
