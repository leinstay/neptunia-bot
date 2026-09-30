// Tests for src/mentor/ablate.js: a suspect named by the mentor model located
// in what the persona was given, the edits that remove exactly that piece, and
// the gain of a what-if run -- all against a fake view built here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ablationEdits, locateSuspect, gainOf } from '../src/mentor/ablate.js';

const ALICE = '111111111111111111';
const BRUNO = '222222222222222222';

const RULES = [
  '# Rules',
  '',
  'Intro text that is not a bullet.',
  '',
  '## Live rules',
  '',
  '- keep answers short',
  '- never use the long dash',
  '- write in lower case',
  '',
].join('\n');

function fakeView() {
  const prompts = {
    'system-prompt': 'You are a member of this chat. Stay natural.\n\nAnswer like a person.',
    'character-card': 'Name: Ἑλένη. She is café-loving and blunt. She hates emojis.',
    rules: RULES,
    format: 'One line per message.',
    reply: 'Answer the last message. Mind the tempo.',
    labels: { aboutChat: { patterns: 'x' } },
  };
  const guild = {
    self: ['I like chess', 'I never sleep before three', 'my favourite colour is blue'],
    learned: [
      { id: 1, text: 'say καλημέρα in the morning', from: ALICE, weight: 2 },
      { id: 2, text: 'the moderators are strict', weight: 1 },
    ],
    patterns: 'Short messages. Lots of irony, few questions.',
    starters: 'People open with a meme.',
    injokes: ['the broken kettle', 'Tuesday is pizza day'],
  };
  const users = {
    [ALICE]: { id: ALICE, character: 'Calm and precise.', style: 'Writes long sentences.', relationship: 'A good friend.' },
    [BRUNO]: { id: BRUNO, character: 'Loud and funny.', style: 'Uses many exclamation marks.', relationship: 'Teases the persona.' },
  };
  return {
    prompts,
    config: {},
    memory: {
      getGuild: () => guild,
      getUser: (id) => users[id] ?? null,
      listUserProfiles: () => Object.values(users),
      listChannels: () => [],
      getLore: () => [],
    },
  };
}

function snapshot(view) {
  return JSON.stringify({ prompts: view.prompts, guild: view.memory.getGuild(), users: view.memory.listUserProfiles() });
}

test('ablationEdits: rules removes the bullet that contains the excerpt', () => {
  const view = fakeView();
  const before = snapshot(view);
  const edits = ablationEdits({ layer: 'rules', excerpt: '  the long dash ' }, view);
  assert.deepEqual(Object.keys(edits), ['prompts']);
  assert.deepEqual(Object.keys(edits.prompts), ['rules']);
  assert.ok(!edits.prompts.rules.includes('long dash'));
  assert.ok(edits.prompts.rules.includes('- keep answers short\n- write in lower case'));
  assert.ok(edits.prompts.rules.includes('Intro text that is not a bullet.'));
  assert.equal(snapshot(view), before);
  assert.deepEqual(locateSuspect({ layer: 'rules', excerpt: 'the long dash' }, view), { layer: 'rules', name: 'rules', index: 1 });
});

test('ablationEdits: rules text outside the rule bullets is not located', () => {
  assert.equal(ablationEdits({ layer: 'rules', excerpt: 'Intro text' }, fakeView()), null);
});

test('ablationEdits: prompt removes the excerpt from the prompt named by ref', () => {
  const view = fakeView();
  const edits = ablationEdits({ layer: 'prompt', ref: 'reply', excerpt: 'Mind the tempo.' }, view);
  assert.deepEqual(edits, { prompts: { reply: 'Answer the last message.' } });
  assert.deepEqual(locateSuspect({ layer: 'prompt', ref: 'reply', excerpt: 'Mind the tempo.' }, view), { layer: 'prompt', name: 'reply' });
});

test('ablationEdits: prompt without ref searches every prompt but the card and the rules', () => {
  const view = fakeView();
  const edits = ablationEdits({ layer: 'prompt', excerpt: 'Stay natural.' }, view);
  assert.deepEqual(edits, { prompts: { 'system-prompt': 'You are a member of this chat.\n\nAnswer like a person.' } });
  assert.equal(ablationEdits({ layer: 'prompt', excerpt: 'hates emojis' }, view), null);
  assert.equal(ablationEdits({ layer: 'prompt', excerpt: 'keep answers short' }, view), null);
});

test('ablationEdits: prompt collapses a triple newline left behind', () => {
  const view = fakeView();
  const edits = ablationEdits({ layer: 'prompt', ref: 'system-prompt', excerpt: 'Answer like a person.' }, view);
  assert.deepEqual(edits, { prompts: { 'system-prompt': 'You are a member of this chat. Stay natural.\n\n' } });
  const view2 = fakeView();
  view2.prompts.format = 'First.\n\nMiddle.\n\nLast.';
  assert.deepEqual(ablationEdits({ layer: 'prompt', ref: 'format', excerpt: 'Middle.' }, view2), {
    prompts: { format: 'First.\n\nLast.' },
  });
});

test('ablationEdits: card removes the excerpt from the character card', () => {
  const view = fakeView();
  const edits = ablationEdits({ layer: 'card', excerpt: 'She is café-loving and blunt.' }, view);
  assert.deepEqual(edits, { prompts: { 'character-card': 'Name: Ἑλένη. She hates emojis.' } });
  assert.deepEqual(locateSuspect({ layer: 'card', excerpt: 'blunt' }, view), { layer: 'card', name: 'character-card' });
});

test('ablationEdits: self removes the fact that contains the excerpt', () => {
  const view = fakeView();
  const before = snapshot(view);
  const edits = ablationEdits({ layer: 'self', excerpt: 'never sleep' }, view);
  assert.deepEqual(edits, { guild: { self: ['I like chess', 'my favourite colour is blue'] } });
  assert.equal(snapshot(view), before);
  assert.deepEqual(locateSuspect({ layer: 'self', excerpt: 'never sleep' }, view), { layer: 'self', index: 1 });
});

test('ablationEdits: learned removes the item whose text contains the excerpt', () => {
  const view = fakeView();
  const edits = ablationEdits({ layer: 'learned', excerpt: 'καλημέρα' }, view);
  assert.deepEqual(edits, { guild: { learned: [{ id: 2, text: 'the moderators are strict', weight: 1 }] } });
  assert.deepEqual(locateSuspect({ layer: 'learned', excerpt: 'strict' }, view), { layer: 'learned', index: 1 });
});

test('ablationEdits: guild removes an in-joke or cuts the excerpt from patterns and starters', () => {
  const view = fakeView();
  assert.deepEqual(ablationEdits({ layer: 'guild', excerpt: 'kettle' }, view), { guild: { injokes: ['Tuesday is pizza day'] } });
  assert.deepEqual(locateSuspect({ layer: 'guild', excerpt: 'kettle' }, view), { layer: 'guild', field: 'injokes', index: 0 });
  assert.deepEqual(ablationEdits({ layer: 'guild', excerpt: 'Lots of irony, few questions.' }, view), {
    guild: { patterns: 'Short messages.' },
  });
  assert.deepEqual(locateSuspect({ layer: 'guild', excerpt: 'meme' }, view), { layer: 'guild', field: 'starters' });
  assert.deepEqual(ablationEdits({ layer: 'guild', excerpt: 'with a meme' }, view), { guild: { starters: 'People open.' } });
});

test('ablationEdits: profile blanks the field of the user named by ref', () => {
  const view = fakeView();
  const edits = ablationEdits({ layer: 'profile', ref: BRUNO, excerpt: 'exclamation marks' }, view);
  assert.deepEqual(edits, { users: { [BRUNO]: { style: '' } } });
  assert.equal(ablationEdits({ layer: 'profile', ref: ALICE, excerpt: 'exclamation marks' }, view), null);
  assert.equal(ablationEdits({ layer: 'profile', ref: '999', excerpt: 'Calm' }, view), null);
});

test('ablationEdits: profile without ref searches every profile, first hit wins', () => {
  const view = fakeView();
  assert.deepEqual(ablationEdits({ layer: 'profile', excerpt: 'Teases the persona' }, view), {
    users: { [BRUNO]: { relationship: '' } },
  });
  assert.deepEqual(locateSuspect({ layer: 'profile', excerpt: 'friend' }, view), {
    layer: 'profile',
    userId: ALICE,
    field: 'relationship',
  });
  assert.deepEqual(ablationEdits({ layer: 'profile', excerpt: 'and' }, view), { users: { [ALICE]: { character: '' } } });
});

test('ablationEdits: missing gives null', () => {
  assert.equal(ablationEdits({ layer: 'missing', excerpt: 'I like chess' }, fakeView()), null);
  assert.equal(locateSuspect({ layer: 'missing', excerpt: 'I like chess' }, fakeView()), null);
});

test('ablationEdits: an excerpt found nowhere gives null', () => {
  const view = fakeView();
  for (const layer of ['rules', 'prompt', 'card', 'self', 'learned', 'guild', 'profile']) {
    assert.equal(ablationEdits({ layer, excerpt: 'nothing like this anywhere' }, view), null, layer);
  }
});

test('ablationEdits: an empty, too long or unknown suspect gives null', () => {
  const view = fakeView();
  assert.equal(ablationEdits({ layer: 'self', excerpt: '   ' }, view), null);
  assert.equal(ablationEdits({ layer: 'self' }, view), null);
  assert.equal(ablationEdits({ layer: 'self', excerpt: 'x'.repeat(301) }, view), null);
  assert.equal(ablationEdits({ layer: 'lore', excerpt: 'I like chess' }, view), null);
  assert.equal(ablationEdits(null, view), null);
  assert.equal(ablationEdits({ layer: 'prompt', ref: 'nope', excerpt: 'Stay natural.' }, view), null);
});

test('ablationEdits: an empty view gives null', () => {
  const view = { prompts: {}, memory: { getGuild: () => ({}), getUser: () => null, listUserProfiles: () => [] } };
  for (const layer of ['rules', 'prompt', 'card', 'self', 'learned', 'guild', 'profile']) {
    assert.equal(ablationEdits({ layer, excerpt: 'chess' }, view), null, layer);
  }
});

test('gainOf: the overall median after minus before, rounded to one decimal', () => {
  assert.equal(gainOf({ medians: { overall: 5.5 } }, { medians: { overall: 7.25 } }), 1.8);
  assert.equal(gainOf({ medians: { overall: 7 } }, { medians: { overall: 6.5 } }), -0.5);
  assert.equal(gainOf({ medians: { overall: 6.3 } }, { medians: { overall: 6.3 } }), 0);
});

test('gainOf: null when either result or its overall median is missing', () => {
  assert.equal(gainOf(null, { medians: { overall: 7 } }), null);
  assert.equal(gainOf({ medians: { overall: 7 } }, undefined), null);
  assert.equal(gainOf({ medians: { overall: null } }, { medians: { overall: 7 } }), null);
  assert.equal(gainOf({ medians: { overall: 5 } }, { medians: {} }), null);
  assert.equal(gainOf({ medians: { overall: 5 } }, { medians: { overall: NaN } }), null);
});
