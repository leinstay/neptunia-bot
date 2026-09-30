// Tests for src/mentor/overlay.js: a view of the same shape as liveView with
// what-if edits applied in memory (prompts, guild memory, member profiles),
// the pure helpers that build those edits, and proof that the base view and
// the edits objects are never mutated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlayView, overlayEdits, editPrompt, editToOverlay, removeRule, removeExcerpt } from '../src/mentor/overlay.js';
import { liveView, situationToHistory } from '../src/mentor/sandbox.js';
import { buildRequest } from '../src/behavior/prompt.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const SELF_ID = '900000000000000001';
const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';
const CHANNEL = { id: '500000000000000001', name: 'general', category: 'Talk', topic: null };

const RULES = [
  '# Rules',
  '',
  'Intro text that is not a rule.',
  '',
  '## Live rules',
  '',
  '- first rule',
  '- second rule',
  '- third rule',
  '',
].join('\n');

function fakeConfig() {
  return {
    bot: { timezone: 'UTC' },
    context: {
      channelMessages: 100,
      maxMessageChars: 800,
      gapMarkerMinutes: 20,
      otherProfiles: 6,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
    },
    llm: { model: 'x/chat', maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000 },
    memory: { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20, maxEpisodes: 20 },
    relationships: { maxDeltaPerUpdate: 15, historySize: 10 },
    lore: { maxEntries: 500 },
    features: {},
  };
}

function fakeHot() {
  return {
    config: fakeConfig(),
    prompts: {
      'system-prompt': 'SYSTEM_MARKER: you are a regular member of this chat.',
      'character-card': 'You are friendly and terse. You like the café by the harbour.',
      rules: RULES,
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      labels,
    },
  };
}

function baseMemory() {
  return {
    guild: {
      self: ['SELF_ONE likes tea with honey', 'SELF_TWO dislikes early mornings'],
      patterns: 'PATTERNS_MARKER short lines',
      starters: 'STARTERS_MARKER a greeting',
      injokes: ['INJOKE_MARKER the broken kettle'],
      learned: [],
    },
    users: {
      [ALICE]: { id: ALICE, names: ['Alice'], character: 'ALICE_CHARACTER solves chess problems', style: 'ALICE_STYLE lowercase' },
      [BRUNO]: { id: BRUNO, names: ['Bruno'], character: 'BRUNO_CHARACTER bakes bread', style: 'BRUNO_STYLE long messages' },
    },
    channels: [{ id: CHANNEL.id, purpose: 'Everyday talk.' }],
    lore: [{ title: 'Kettle', keys: ['kettle'], text: 'It broke twice.' }],
  };
}

function fakeStore(memory) {
  return {
    getGuild: () => memory.guild,
    getUser: (guildId, id) => memory.users[id] ?? null,
    listUserProfiles: () => Object.values(memory.users),
    listChannels: () => memory.channels,
    getLore: () => memory.lore,
  };
}

function baseView(hot = fakeHot(), memory = baseMemory()) {
  return liveView({ hot, store: fakeStore(memory), guildId: 'g1' });
}

/** A snapshot of everything a view returns, for before/after comparisons. */
function snapshot(view) {
  return structuredClone({
    prompts: view.prompts,
    config: view.config,
    guild: view.memory.getGuild(),
    alice: view.memory.getUser(ALICE),
    bruno: view.memory.getUser(BRUNO),
    profiles: view.memory.listUserProfiles(),
    channels: view.memory.listChannels(),
    lore: view.memory.getLore(),
  });
}

function twoLines() {
  return {
    title: 'a small talk',
    lines: [
      { authorId: BRUNO, authorName: 'Bruno', text: 'καλημέρα', replyTo: null, minutesBefore: 5 },
      { authorId: ALICE, authorName: 'Alice', text: 'what do you think about chess?', replyTo: null, minutesBefore: 1 },
    ],
  };
}

/** The reply request buildRequest renders over `view`, built as src/mentor/sandbox.js#answerReply builds it. */
function render(view) {
  const memory = view.memory;
  const { history, trigger, triggerKind } = situationToHistory(twoLines(), { selfId: SELF_ID, selfName: 'Zoë', now: NOW, channel: CHANNEL });
  const request = buildRequest({
    config: view.config,
    prompts: view.prompts,
    calibrator: view.calibrator,
    mode: 'reply',
    forced: false,
    now: NOW,
    selfName: 'Zoë',
    history,
    neighbors: [],
    trigger,
    triggerKind,
    guildMemory: memory.getGuild(),
    interlocutor: memory.getUser(trigger.authorId),
    privateChat: null,
    privateProfile: null,
    otherProfiles: [BRUNO].map((id) => memory.getUser(id)).filter(Boolean),
    candidateProfiles: memory.listUserProfiles(),
    nameOf: (id) => memory.getUser(id)?.names?.[0] ?? null,
    channels: memory.listChannels(),
    loreEntries: memory.getLore(),
    currentChannelId: CHANNEL.id,
    descriptions: new Map(),
    videos: new Map(),
    reads: new Map(),
    lookup: null,
    searchAvailable: false,
    drawQuota: undefined,
  });
  const [system, user] = request.messages;
  return { system: system.content, user: typeof user.content === 'string' ? user.content : request.textFallback };
}

// ---- overlayView -------------------------------------------------------------

test('overlayView: a prompt edit is seen by buildRequest, the base is untouched', () => {
  const base = baseView();
  const before = snapshot(base);
  const edits = editPrompt({}, base.prompts['character-card'], 'character-card', 'the café by the harbour', 'EDITED_CARD_MARKER');
  const view = overlayView(base, edits);

  const edited = render(view);
  const plain = render(base);
  assert.ok(edited.system.includes('EDITED_CARD_MARKER'));
  assert.equal(edited.system.includes('the café by the harbour'), false);
  assert.ok(plain.system.includes('the café by the harbour'));
  assert.equal(plain.system.includes('EDITED_CARD_MARKER'), false);
  assert.ok(edited.system.includes('SYSTEM_MARKER'), 'the other prompts stay');

  assert.deepEqual(snapshot(base), before);
});

test('overlayView: a null prompt removes it', () => {
  const base = baseView();
  const view = overlayView(base, { prompts: { rules: null } });
  assert.equal('rules' in view.prompts, false);
  assert.equal(render(view).system.includes('second rule'), false);
  assert.ok(render(base).system.includes('second rule'));
  assert.ok('rules' in base.prompts);
});

test('overlayView: prompts is a new object on every read', () => {
  const base = baseView();
  const view = overlayView(base, { prompts: { format: 'F' } });
  const first = view.prompts;
  first.format = 'mutated by a caller';
  assert.equal(view.prompts.format, 'F');
  assert.notEqual(view.prompts, base.prompts);
});

test('overlayView: a removed self item is not rendered', () => {
  const base = baseView();
  const before = snapshot(base);
  const kept = base.memory.getGuild().self.filter((fact) => !fact.startsWith('SELF_TWO'));
  const view = overlayView(base, { guild: { self: kept } });

  const edited = render(view);
  const plain = render(base);
  assert.ok(plain.user.includes('SELF_TWO'));
  assert.equal(edited.user.includes('SELF_TWO'), false);
  assert.ok(edited.user.includes('SELF_ONE'));
  assert.deepEqual(snapshot(base), before);
});

test('overlayView: guild fields are replaced or removed, the rest pass through', () => {
  const base = baseView();
  const view = overlayView(base, { guild: { patterns: null, starters: 'NEW_STARTERS', injokes: [], self: undefined } });
  const guild = view.memory.getGuild();
  assert.equal('patterns' in guild, false);
  assert.equal(guild.starters, 'NEW_STARTERS');
  assert.deepEqual(guild.injokes, []);
  assert.deepEqual(guild.self, base.memory.getGuild().self);
  assert.equal(base.memory.getGuild().patterns, 'PATTERNS_MARKER short lines');
  const user = render(view).user;
  assert.equal(user.includes('PATTERNS_MARKER'), false);
  assert.equal(user.includes('INJOKE_MARKER'), false);
  assert.ok(user.includes('NEW_STARTERS'));
});

test('overlayView: a profile rewrite is seen only for that user', () => {
  const base = baseView();
  const before = snapshot(base);
  const view = overlayView(base, {
    users: { [ALICE]: { character: 'ALICE_REWRITTEN plays go', style: null, names: ['Mallory'], affinity: { score: 99 } } },
  });

  const alice = view.memory.getUser(ALICE);
  assert.equal(alice.character, 'ALICE_REWRITTEN plays go');
  assert.equal('style' in alice, false);
  assert.deepEqual(alice.names, ['Alice'], 'only character, style and relationship may be set');
  assert.equal('affinity' in alice, false);
  assert.deepEqual(view.memory.getUser(BRUNO), base.memory.getUser(BRUNO));

  const listed = view.memory.listUserProfiles();
  assert.equal(listed.find((p) => p.id === ALICE).character, 'ALICE_REWRITTEN plays go');
  assert.equal(listed.find((p) => p.id === BRUNO).character, 'BRUNO_CHARACTER bakes bread');

  const edited = render(view).user;
  assert.ok(edited.includes('ALICE_REWRITTEN'));
  assert.equal(edited.includes('ALICE_CHARACTER'), false);
  assert.ok(edited.includes('BRUNO_CHARACTER'));
  assert.ok(render(base).user.includes('ALICE_CHARACTER'));

  assert.deepEqual(snapshot(base), before);
});

test('overlayView: an unknown member stays unknown', () => {
  const view = overlayView(baseView(), { users: { '333333333333333333': { character: 'invented' } } });
  assert.equal(view.memory.getUser('333333333333333333'), null);
});

test('overlayView: reads follow the base when nothing is edited', () => {
  const hot = fakeHot();
  const memory = baseMemory();
  const base = baseView(hot, memory);
  const view = overlayView(base, {});
  assert.deepEqual(snapshot(view), snapshot(base));
  assert.equal(view.config, base.config);
  assert.equal(view.calibrator, base.calibrator);
  assert.equal(view.memory.listChannels(), memory.channels);
  assert.equal(view.memory.getLore(), memory.lore);

  // Reads are live: a change in the base after the overlay was made shows through.
  hot.prompts = { ...hot.prompts, reply: 'LATER_REPLY' };
  hot.config = { ...hot.config, marker: 1 };
  memory.guild = { ...memory.guild, patterns: 'LATER_PATTERNS' };
  memory.users[ALICE] = { ...memory.users[ALICE], style: 'LATER_STYLE' };
  assert.equal(view.prompts.reply, 'LATER_REPLY');
  assert.equal(view.config.marker, 1);
  assert.equal(view.memory.getGuild().patterns, 'LATER_PATTERNS');
  assert.equal(view.memory.getUser(ALICE).style, 'LATER_STYLE');

  // Also with edits in place: the unedited parts follow the base.
  const edited = overlayView(base, { prompts: { format: 'F' }, guild: { starters: 'S' }, users: { [ALICE]: { character: 'C' } } });
  memory.users[ALICE] = { ...memory.users[ALICE], relationship: 'LATER_RELATIONSHIP' };
  assert.equal(edited.prompts.reply, 'LATER_REPLY');
  assert.equal(edited.memory.getGuild().patterns, 'LATER_PATTERNS');
  assert.equal(edited.memory.getUser(ALICE).relationship, 'LATER_RELATIONSHIP');
  assert.equal(edited.memory.getUser(ALICE).character, 'C');
});

test('overlayView: a base without a calibrator stays without one', () => {
  const base = { ...baseView(), calibrator: undefined };
  const view = overlayView({ get prompts() { return base.prompts; }, config: base.config, memory: base.memory }, {});
  assert.equal(view.calibrator, undefined);
});

test('overlayView: the edits object is not mutated and later changes to it do not leak in', () => {
  const edits = { prompts: { format: 'F' }, guild: { self: ['only one'] }, users: { [ALICE]: { character: 'C' } } };
  const before = structuredClone(edits);
  const view = overlayView(baseView(), edits);
  view.memory.getGuild().self.push('pushed by a caller');
  view.prompts;
  view.memory.getUser(ALICE);
  view.memory.listUserProfiles();
  assert.deepEqual(edits, before);
  assert.deepEqual(view.memory.getGuild().self, ['only one']);
});

// ---- editPrompt --------------------------------------------------------------

test('editPrompt: exact first occurrence', () => {
  const base = 'one two one two';
  const edits = { guild: { patterns: null } };
  const next = editPrompt(edits, base, 'rules', 'one', 'ένα');
  assert.deepEqual(next, { guild: { patterns: null }, prompts: { rules: 'ένα two one two' } });
  assert.deepEqual(edits, { guild: { patterns: null } }, 'the input is not mutated');
  assert.equal(editPrompt({}, 'cost is $5', 'rules', 'is', 'was $&').prompts.rules, 'cost was $& $5', 'no replacement patterns');
  assert.throws(() => editPrompt({}, 'One two', 'rules', 'one', 'x'), /excerpt not found/, 'case matters');
});

test('editPrompt: edits stack on an earlier edit of the same prompt', () => {
  const first = editPrompt({}, 'alpha beta gamma', 'format', 'beta', 'BETA');
  const second = editPrompt(first, 'alpha beta gamma', 'format', 'gamma', 'GAMMA');
  assert.equal(second.prompts.format, 'alpha BETA GAMMA');
  assert.equal(first.prompts.format, 'alpha BETA gamma');
  assert.throws(() => editPrompt(first, 'alpha beta gamma', 'format', 'beta', 'x'), /excerpt not found/);
});

test('editPrompt: throws when the excerpt is absent', () => {
  assert.throws(() => editPrompt({}, 'alpha', 'format', 'omega', 'x'), /excerpt not found/);
  assert.throws(() => editPrompt({}, undefined, 'format', 'omega', 'x'), /excerpt not found/);
  assert.throws(() => editPrompt({}, 'alpha', 'format', '', 'x'), /excerpt not found/);
});

// ---- removeRule ----------------------------------------------------------------

test('removeRule: keeps the heading and the other bullets', () => {
  const text = removeRule(RULES, 2);
  assert.equal(text, ['# Rules', '', 'Intro text that is not a rule.', '', '## Live rules', '', '- first rule', '- third rule', ''].join('\n'));
  assert.equal(removeRule(RULES, 1).includes('- first rule'), false);
  assert.ok(removeRule(RULES, 3).includes('- second rule'));
});

test('removeRule: throws for a bullet that does not exist', () => {
  assert.throws(() => removeRule(RULES, 0), /rule not found/);
  assert.throws(() => removeRule(RULES, 4), /rule not found/);
});

// ---- removeExcerpt -------------------------------------------------------------

test('removeExcerpt: removes the first exact occurrence', () => {
  assert.equal(removeExcerpt('xyz-xyz', 'xyz'), '-xyz');
  assert.equal(removeExcerpt('à la carte, à la mode', 'à la mode'), 'à la carte, ');
});

test('removeExcerpt: collapses a doubled space or blank line left behind', () => {
  assert.equal(removeExcerpt('She is kind. She is loud. She is here.', 'She is loud.'), 'She is kind. She is here.');
  assert.equal(removeExcerpt('Para one.\n\nPara two.\n\nPara three.', 'Para two.'), 'Para one.\n\nPara three.');
  assert.equal(removeExcerpt('- a\n- b\n- c', '- b'), '- a\n- c');
  assert.equal(removeExcerpt('Line one. Gone.\nLine two.', ' Gone.'), 'Line one.\nLine two.');
  assert.equal(removeExcerpt('Kept.\n\nGone.\n\n\nOther.', 'Gone.'), 'Kept.\n\n\nOther.', 'a run wider on one side keeps that width');
  assert.equal(removeExcerpt('One.  Two. Three.', ' Three.'), 'One.  Two.', 'whitespace away from the seam is left alone');
});

test('removeExcerpt: throws when absent', () => {
  assert.throws(() => removeExcerpt('Καλημέρα', 'καλημέρα'), /excerpt not found/);
  assert.throws(() => removeExcerpt('text', ''), /excerpt not found/);
});

// ---- overlayEdits ------------------------------------------------------------

test('overlayEdits: merges left to right, later wins per key', () => {
  const ablation = { prompts: { rules: 'R1', format: null }, guild: { self: ['a'], patterns: null }, users: { [ALICE]: { character: 'C1', style: 'S1' } } };
  const repair = { prompts: { rules: 'R2' }, guild: { patterns: 'P2', starters: undefined }, users: { [ALICE]: { style: 'S2' }, [BRUNO]: { relationship: 'B2' } } };
  const before = structuredClone([ablation, repair]);
  const merged = overlayEdits(ablation, null, repair, undefined);
  assert.deepEqual(merged, {
    prompts: { rules: 'R2', format: null },
    guild: { self: ['a'], patterns: 'P2' },
    users: { [ALICE]: { character: 'C1', style: 'S2' }, [BRUNO]: { relationship: 'B2' } },
  });
  assert.deepEqual([ablation, repair], before, 'the inputs are not mutated');
  assert.deepEqual(overlayEdits(), { prompts: {}, guild: {}, users: {} });
});

// ---- editToOverlay -------------------------------------------------------------

/** The base memory with two learned items, for the learned layer. */
function memoryWithLearned() {
  const memory = baseMemory();
  memory.guild.learned = [
    { id: 4, text: 'LEARNED_ONE the kettle is off limits', weight: 3, firstSeen: '2026-09-01', lastSeen: '2026-09-20' },
    { id: 7, text: 'LEARNED_TWO greet with καλημέρα', weight: 1, firstSeen: '2026-09-02', lastSeen: '2026-09-02' },
  ];
  return memory;
}

/** `edit` turned into edits and read back through an overlay of `base`; the base is checked untouched. */
function throughOverlay(edit, base = baseView(fakeHot(), memoryWithLearned())) {
  const before = snapshot(base);
  const edits = editToOverlay(edit, base);
  assert.deepEqual(snapshot(base), before, 'the base view is not mutated');
  return { edits, view: edits.error ? null : overlayView(base, edits) };
}

test('editToOverlay rules: replaces the first exact occurrence in the rules text', () => {
  const { edits, view } = throughOverlay({ layer: 'rules', target: 'rules', from: 'second rule', to: 'second rule, reworded', why: 'x' });
  assert.deepEqual(Object.keys(edits), ['prompts']);
  assert.equal(view.prompts.rules, RULES.replace('second rule', 'second rule, reworded'));
});

test('editToOverlay prompt: replaces text, or appends a paragraph for an empty from', () => {
  const replaced = throughOverlay({ layer: 'prompt', target: 'format', from: '<react>', to: '<react> (rarely)', why: 'x' });
  assert.equal(replaced.view.prompts.format, 'Use <msg> and <react> (rarely) tags.');
  const appended = throughOverlay({ layer: 'prompt', target: 'format', from: '', to: '  One idea per message.  ', why: 'x' });
  assert.equal(appended.view.prompts.format, 'Use <msg> and <react> tags.\n\nOne idea per message.\n');
});

test('editToOverlay self: rewrites or removes the item matched by its exact text', () => {
  const rewritten = throughOverlay({ layer: 'self', target: '', from: ' SELF_ONE likes tea with honey ', to: 'SELF_ONE likes tea, no sugar', why: 'x' });
  assert.deepEqual(rewritten.view.memory.getGuild().self, ['SELF_ONE likes tea, no sugar', 'SELF_TWO dislikes early mornings']);
  const removed = throughOverlay({ layer: 'self', target: '', from: 'SELF_TWO dislikes early mornings', to: '', why: 'x' });
  assert.deepEqual(removed.view.memory.getGuild().self, ['SELF_ONE likes tea with honey']);
});

test('editToOverlay learned: a rewrite keeps the item, a removal drops it', () => {
  const rewritten = throughOverlay({ layer: 'learned', target: '', from: 'LEARNED_ONE the kettle is off limits', to: 'LEARNED_ONE nobody touches the kettle', why: 'x' });
  const [first, second] = rewritten.view.memory.getGuild().learned;
  assert.deepEqual(first, { id: 4, text: 'LEARNED_ONE nobody touches the kettle', weight: 3, firstSeen: '2026-09-01', lastSeen: '2026-09-20' });
  assert.equal(second.id, 7);
  const removed = throughOverlay({ layer: 'learned', target: '', from: 'LEARNED_TWO greet with καλημέρα', to: '', why: 'x' });
  assert.deepEqual(removed.view.memory.getGuild().learned.map((i) => i.id), [4]);
});

test('editToOverlay guild: a string field is edited in place, an in-joke by its exact text', () => {
  const patterns = throughOverlay({ layer: 'guild', target: 'patterns', from: 'short lines', to: 'short lines, few emoji', why: 'x' });
  assert.equal(patterns.view.memory.getGuild().patterns, 'PATTERNS_MARKER short lines, few emoji');
  assert.equal(patterns.view.memory.getGuild().starters, 'STARTERS_MARKER a greeting');
  const injoke = throughOverlay({ layer: 'guild', target: 'injokes', from: 'INJOKE_MARKER the broken kettle', to: 'INJOKE_MARKER the kettle, again', why: 'x' });
  assert.deepEqual(injoke.view.memory.getGuild().injokes, ['INJOKE_MARKER the kettle, again']);
});

test('editToOverlay profile: rewrites one field of one member', () => {
  const { edits, view } = throughOverlay({ layer: 'profile', target: `${ALICE}.character`, from: 'solves chess problems', to: 'likes chess puzzles', why: 'x' });
  assert.deepEqual(edits, { users: { [ALICE]: { character: 'ALICE_CHARACTER likes chess puzzles' } } });
  assert.equal(view.memory.getUser(ALICE).character, 'ALICE_CHARACTER likes chess puzzles');
  assert.equal(view.memory.getUser(ALICE).style, 'ALICE_STYLE lowercase');
  assert.equal(view.memory.getUser(BRUNO).character, 'BRUNO_CHARACTER bakes bread');
});

test('editToOverlay: a layer no edit may touch is refused', () => {
  for (const layer of ['card', 'missing', 'lore', undefined]) {
    assert.deepEqual(throughOverlay({ layer, target: 'character-card', from: 'friendly', to: 'kind', why: 'x' }).edits, { error: 'layer not allowed' }, String(layer));
  }
  assert.deepEqual(editToOverlay(null, baseView()), { error: 'layer not allowed' });
});

test('editToOverlay: a target that is not allowed is refused', () => {
  const refused = (edit) => throughOverlay({ from: 'x', to: 'y', why: 'x', ...edit }).edits;
  for (const target of ['character-card', 'rules', 'Format', '../rules', '']) {
    assert.deepEqual(refused({ layer: 'prompt', target }), { error: 'target not allowed' }, target);
  }
  assert.deepEqual(refused({ layer: 'guild', target: 'lore' }), { error: 'target not allowed' });
  assert.deepEqual(refused({ layer: 'profile', target: `${ALICE}.names` }), { error: 'target not allowed' });
  assert.deepEqual(refused({ layer: 'profile', target: 'alice.character' }), { error: 'target not allowed' });
});

test('editToOverlay: an unknown prompt or member is refused', () => {
  const refused = (edit) => throughOverlay({ from: 'x', to: 'y', why: 'x', ...edit }).edits;
  assert.deepEqual(refused({ layer: 'prompt', target: 'nosuch' }), { error: 'unknown prompt' });
  assert.deepEqual(refused({ layer: 'prompt', target: 'labels' }), { error: 'unknown prompt' });
  assert.deepEqual(refused({ layer: 'profile', target: '333333333333333333.character' }), { error: 'unknown member' });
});

test('editToOverlay: text that is not in the current piece is refused', () => {
  const refused = (edit) => throughOverlay({ to: 'y', why: 'x', ...edit }).edits;
  assert.deepEqual(refused({ layer: 'rules', from: 'no such rule' }), { error: 'text not found' });
  // Only a prompt may take an addition.
  assert.deepEqual(refused({ layer: 'rules', from: '' }), { error: 'text not found' });
  assert.deepEqual(refused({ layer: 'prompt', target: 'format', from: 'Use <msg> and <REACT>' }), { error: 'text not found' });
  // A list item is matched by its whole text, never a part of it.
  assert.deepEqual(refused({ layer: 'self', from: 'SELF_ONE likes tea' }), { error: 'text not found' });
  assert.deepEqual(refused({ layer: 'self', from: '' }), { error: 'text not found' });
  assert.deepEqual(refused({ layer: 'learned', from: 'LEARNED_ONE' }), { error: 'text not found' });
  assert.deepEqual(refused({ layer: 'guild', target: 'starters', from: 'farewell' }), { error: 'text not found' });
  assert.deepEqual(refused({ layer: 'guild', target: 'injokes', from: 'the broken kettle' }), { error: 'text not found' });
  assert.deepEqual(refused({ layer: 'profile', target: `${ALICE}.style`, from: 'uppercase' }), { error: 'text not found' });
});

test('editToOverlay: a learned rewrite onto another item is refused', () => {
  const edit = { layer: 'learned', from: 'LEARNED_ONE the kettle is off limits', to: 'LEARNED_TWO greet with καλημέρα', why: 'x' };
  assert.deepEqual(throughOverlay(edit).edits, { error: 'duplicate item' });
});

test('editToOverlay: a profile rewrite that loses a fact is refused', () => {
  const refused = (from, to) => throughOverlay({ layer: 'profile', target: `${ALICE}.character`, from, to, why: 'x' }).edits;
  assert.deepEqual(refused('ALICE_CHARACTER solves', 'solves'), { error: 'names changed' });
  assert.deepEqual(refused('chess problems', 'chess problems since 2019'), { error: 'numbers changed' });
  assert.deepEqual(refused('ALICE_CHARACTER solves chess problems', ''), { error: 'field emptied' });
});
