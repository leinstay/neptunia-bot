// Tests for src/memory/mentions.js: toTokens/fromTokens (the analyzer's
// id-token round trip). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTokens, fromTokens, occursAsWholeWord } from '../src/memory/mentions.js';

const ID_A = '123456789012345678';
const ID_B = '223456789012345678';

// ---- toTokens ---------------------------------------------------------------

test('toTokens: converts "Name (id:123...)" into the token when the id is known', () => {
  const text = `Vertex (id:${ID_A}) helped with the raid`;
  const out = toTokens(text, (id) => id === ID_A);
  assert.equal(out, `<@${ID_A}> helped with the raid`);
});

test('toTokens: an unknown id is left completely untouched', () => {
  const text = `Vertex (id:${ID_A}) helped`;
  const out = toTokens(text, () => false);
  assert.equal(out, text);
});

test('toTokens: everything else in the text is untouched', () => {
  const text = `Before. Vertex (id:${ID_A}) helped. After.`;
  const out = toTokens(text, (id) => id === ID_A);
  assert.equal(out, `Before. <@${ID_A}> helped. After.`);
});

test('toTokens: only the single word immediately before the id marker is captured -- a leading word of a multi-word name is left as plain text next to the token, never dropped', () => {
  const text = `Vertex Prime (id:${ID_A}) said hi`;
  const out = toTokens(text, () => true);
  assert.equal(out, `Vertex <@${ID_A}> said hi`);
});

test('toTokens: a preposition or verb directly before the id marker is never swallowed into the token', () => {
  const text = `argued with Vertex (id:${ID_A}) yesterday`;
  const out = toTokens(text, () => true);
  assert.equal(out, `argued with <@${ID_A}> yesterday`);
});

test('toTokens: two distinct id markers in the same text are each resolved independently', () => {
  const text = `Alpha (id:${ID_A}) argued with Beta (id:${ID_B})`;
  const out = toTokens(text, (id) => id === ID_A);
  assert.equal(out, `<@${ID_A}> argued with Beta (id:${ID_B})`, 'only the known id becomes a token');
});

test('toTokens: idempotent -- running it twice gives the same result', () => {
  const text = `Vertex (id:${ID_A}) helped`;
  const once = toTokens(text, () => true);
  const twice = toTokens(once, () => true);
  assert.equal(twice, once);
});

test('toTokens: non-string / empty input is returned as-is', () => {
  assert.equal(toTokens('', () => true), '');
  assert.equal(toTokens(undefined, () => true), undefined);
  assert.equal(toTokens(null, () => true), null);
});

test('toTokens: text with no id marker at all is untouched', () => {
  const text = 'just a plain sentence about Vertex';
  assert.equal(toTokens(text, () => true), text);
});

// ---- toTokens: name-aware matching (namesOf) -- the "Al Sus" defect -----------

test('toTokens: a known two-word name is consumed whole, not just its last word', () => {
  const text = `Al Sus (id:${ID_A}) plays it`;
  const out = toTokens(text, () => true, () => ['Al Sus']);
  assert.equal(out, `<@${ID_A}> plays it`);
});

test('toTokens: a known three-word name is consumed whole', () => {
  const text = `The Great Vertex (id:${ID_A}) said hi`;
  const out = toTokens(text, () => true, () => ['The Great Vertex']);
  assert.equal(out, `<@${ID_A}> said hi`);
});

test('toTokens: a known name containing digits and underscores is matched exactly', () => {
  const text = `ask h534905nu_243 (id:${ID_A}) about it`;
  const out = toTokens(text, () => true, () => ['h534905nu_243']);
  assert.equal(out, `ask <@${ID_A}> about it`);
});

test('toTokens: a known name in Greek is matched exactly', () => {
  const text = `το είπε ο Νικόλαος Παπαδόπουλος (id:${ID_A}) χθες`;
  const out = toTokens(text, () => true, () => ['Νικόλαος Παπαδόπουλος']);
  assert.equal(out, `το είπε ο <@${ID_A}> χθες`);
});

test('toTokens: a known name at the very start of the text is matched (nothing precedes it)', () => {
  const text = `Al Sus (id:${ID_A}) plays it`;
  const out = toTokens(text, () => true, (id) => (id === ID_A ? ['Al Sus'] : []));
  assert.equal(out, `<@${ID_A}> plays it`);
});

test('toTokens: two different members, each with a multi-word name, in one sentence', () => {
  const text = `Al Sus (id:${ID_A}) argued with Vertex Prime (id:${ID_B})`;
  const names = { [ID_A]: ['Al Sus'], [ID_B]: ['Vertex Prime'] };
  const out = toTokens(text, () => true, (id) => names[id]);
  assert.equal(out, `<@${ID_A}> argued with <@${ID_B}>`);
});

test('toTokens: the longest known name is preferred when a shorter one is also a suffix', () => {
  const text = `Vertex Prime (id:${ID_A}) said hi`;
  const out = toTokens(text, () => true, () => ['Prime', 'Vertex Prime']);
  assert.equal(out, `<@${ID_A}> said hi`);
});

test('toTokens: when the preceding words are NOT a known name, falls back to the single-word capture', () => {
  const text = `heard from Al Sus (id:${ID_A}) yesterday`;
  const out = toTokens(text, () => true, () => ['Vertex Prime']);
  assert.equal(out, `heard from Al <@${ID_A}> yesterday`, 'no known name matches, so only the single trailing word is consumed');
});

test('toTokens: namesOf returning an empty array or nothing falls back to the single-word capture', () => {
  const text = `Vertex (id:${ID_A}) helped`;
  assert.equal(toTokens(text, () => true, () => []), `<@${ID_A}> helped`);
  assert.equal(toTokens(text, () => true, () => null), `<@${ID_A}> helped`);
  assert.equal(toTokens(text, () => true, () => undefined), `<@${ID_A}> helped`);
});

test('toTokens: without namesOf at all, behaviour is unchanged (single-word capture)', () => {
  const text = `Al Sus (id:${ID_A}) plays it`;
  const out = toTokens(text, () => true);
  assert.equal(out, `Al <@${ID_A}> plays it`);
});

test('toTokens: name-aware matching is idempotent -- converting twice gives the same result', () => {
  const text = `Al Sus (id:${ID_A}) plays it`;
  const namesOf = () => ['Al Sus'];
  const once = toTokens(text, () => true, namesOf);
  const twice = toTokens(once, () => true, namesOf);
  assert.equal(twice, once);
});

test('toTokens: a known multi-word name is still respected even for an unknown id (no crash, id stays untouched)', () => {
  const text = `Al Sus (id:${ID_A}) plays it`;
  const out = toTokens(text, () => false, () => ['Al Sus']);
  assert.equal(out, text);
});

// ---- fromTokens ---------------------------------------------------------------

test('fromTokens: chat mode resolves a token to the member\'s current name alone', () => {
  const text = `<@${ID_A}> helped with the raid`;
  const out = fromTokens(text, (id) => (id === ID_A ? 'Vertex' : null), 'chat');
  assert.equal(out, 'Vertex helped with the raid');
});

test('fromTokens: analyzer mode resolves a token to "name (id:...)"', () => {
  const text = `<@${ID_A}> helped`;
  const out = fromTokens(text, (id) => (id === ID_A ? 'Vertex' : null), 'analyzer');
  assert.equal(out, `Vertex (id:${ID_A}) helped`);
});

test('fromTokens: an id nameOf cannot resolve is left as the bare token', () => {
  const text = `<@${ID_A}> helped`;
  assert.equal(fromTokens(text, () => null, 'chat'), text);
  assert.equal(fromTokens(text, () => undefined, 'analyzer'), text);
});

test('fromTokens: a member renamed between write and read shows the NEW name', () => {
  const text = `<@${ID_A}> said thanks`;
  const names = { [ID_A]: 'OldName' };
  const before = fromTokens(text, (id) => names[id] ?? null, 'chat');
  assert.equal(before, 'OldName said thanks');
  names[ID_A] = 'NewName';
  const after = fromTokens(text, (id) => names[id] ?? null, 'chat');
  assert.equal(after, 'NewName said thanks');
});

test('fromTokens: multiple distinct tokens each resolve independently', () => {
  const text = `<@${ID_A}> and <@${ID_B}> talked`;
  const names = { [ID_A]: 'Alpha', [ID_B]: 'Beta' };
  const out = fromTokens(text, (id) => names[id] ?? null, 'chat');
  assert.equal(out, 'Alpha and Beta talked');
});

test('fromTokens: non-string / empty input is returned as-is', () => {
  assert.equal(fromTokens('', () => 'x', 'chat'), '');
  assert.equal(fromTokens(undefined, () => 'x', 'chat'), undefined);
});

// ---- round trip ---------------------------------------------------------------

test('round trip: toTokens then fromTokens(analyzer) reconstructs an equivalent "name (id:...)" form', () => {
  const original = `Vertex (id:${ID_A}) helped`;
  const tokenized = toTokens(original, () => true);
  const back = fromTokens(tokenized, (id) => (id === ID_A ? 'Vertex' : null), 'analyzer');
  assert.equal(back, original);
});

// ---- occursAsWholeWord ----------------------------------------------------------

test('occursAsWholeWord: matches a whole word, case must already match (caller lowercases)', () => {
  assert.equal(occursAsWholeWord('vertex helped today', 'vertex'), true);
  assert.equal(occursAsWholeWord('vertexes helped today', 'vertex'), false);
});

test('occursAsWholeWord: an empty needle never matches', () => {
  assert.equal(occursAsWholeWord('anything', ''), false);
});
