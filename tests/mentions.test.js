// Tests for src/memory/mentions.js: toTokens/fromTokens (the analyzer's
// id-token round trip) and teacherToken (the lesson teacher rule). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEACHER_TOKEN_RE, isWordChar, toTokens, fromTokens, occursAsWholeWord, teacherToken } from '../src/memory/mentions.js';

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

test('toTokens: without namesOf only the single word immediately before the id marker is captured, never a word before it', () => {
  const rows = [
    [
      'a leading word of a multi-word name is left as plain text next to the token, never dropped',
      `Vertex Prime (id:${ID_A}) said hi`,
      `Vertex <@${ID_A}> said hi`,
    ],
    [
      'a preposition or verb directly before the id marker is never swallowed into the token',
      `argued with Vertex (id:${ID_A}) yesterday`,
      `argued with <@${ID_A}> yesterday`,
    ],
  ];
  for (const [label, text, expected] of rows) {
    assert.equal(toTokens(text, () => true), expected, label);
  }
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

// ---- toTokens: name-aware matching (namesOf) -- the "Al Sus" defect -----------

test('toTokens: a known multi-word name is consumed whole, not just its last word', () => {
  const rows = [
    ['a known two-word name, at the very start of the text', `Al Sus (id:${ID_A}) plays it`, 'Al Sus', `<@${ID_A}> plays it`],
    ['a known three-word name', `The Great Vertex (id:${ID_A}) said hi`, 'The Great Vertex', `<@${ID_A}> said hi`],
  ];
  for (const [label, text, name, expected] of rows) {
    assert.equal(toTokens(text, () => true, () => [name]), expected, label);
  }
});

test('toTokens: a known name in Greek is matched exactly', () => {
  const text = `το είπε ο Νικόλαος Παπαδόπουλος (id:${ID_A}) χθες`;
  const out = toTokens(text, () => true, () => ['Νικόλαος Παπαδόπουλος']);
  assert.equal(out, `το είπε ο <@${ID_A}> χθες`);
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

// ---- occursAsWholeWord ----------------------------------------------------------

test('occursAsWholeWord: matches a whole word, case must already match (caller lowercases)', () => {
  assert.equal(occursAsWholeWord('vertex helped today', 'vertex'), true);
  assert.equal(occursAsWholeWord('vertexes helped today', 'vertex'), false);
});

test('occursAsWholeWord: an empty needle never matches', () => {
  assert.equal(occursAsWholeWord('anything', ''), false);
});

test('occursAsWholeWord: an occurrence inside a longer word does not hide a later whole one', () => {
  assert.equal(occursAsWholeWord('vertexes and vertex', 'vertex'), true);
});

// ---- isWordChar / ID_DIGITS ---------------------------------------------------------

test('isWordChar: letters, digits and underscore in any script; punctuation, space and undefined are not', () => {
  for (const ch of ['a', 'é', 'λ', '7', '_']) assert.equal(isWordChar(ch), true, ch);
  for (const ch of [' ', ',', '-', '@', undefined]) assert.equal(isWordChar(ch), false, String(ch));
});

// ---- teacherToken / TEACHER_TOKEN_RE ---------------------------------------------------

const known = (id) => id === ID_A || id === ID_B;

test('teacherToken: one token or one name (id:...) reference of a known id gives the token', () => {
  const forms = [
    `<@${ID_A}>`,
    `Νίκος (id:${ID_A})`,
    `Νίκος Παπάς (id:${ID_A})`,
    `(id:${ID_A})`,
    `\t<@${ID_A}>\n`,
  ];
  for (const from of forms) assert.equal(teacherToken(from, known), `<@${ID_A}>`, from);
  assert.equal(teacherToken(`Ελένη (id:${ID_B})`, known), `<@${ID_B}>`);
});

test('teacherToken: a bare name, an unknown id, two references or other text around a token is no teacher', () => {
  const forms = [
    'Νίκος',
    `Zoë (id:999999999999999999)`,
    `μαζί με Νίκος (id:${ID_A}) και Ελένη (id:${ID_B})`,
    `ο <@${ID_A}>`,
    `<@!${ID_A}>`,
    `Νίκος (id:${ID_A}) χθες`,
    `(id:${ID_A.slice(0, 16)})`,
  ];
  for (const from of forms) assert.equal(teacherToken(from, known), undefined, from);
});

test('teacherToken: not a string, or no isKnownId, gives undefined', () => {
  for (const from of [undefined, 42, [`<@${ID_A}>`]]) assert.equal(teacherToken(from, known), undefined, String(from));
  assert.equal(teacherToken(`<@${ID_A}>`, undefined), undefined);
  assert.equal(teacherToken(`<@${ID_A}>`, () => false), undefined);
});

test('teacherToken: isKnownId is asked about the id alone', () => {
  const asked = [];
  teacherToken(`Ελένη Π. (id:${ID_B})`, (id) => (asked.push(id), true));
  assert.deepEqual(asked, [ID_B]);
});

test('TEACHER_TOKEN_RE: exactly one <@id> token, the form a teacher is stored in', () => {
  assert.equal(TEACHER_TOKEN_RE.exec(`<@${ID_A}>`)?.[1], ID_A);
  for (const value of [` <@${ID_A}>`, `<@!${ID_A}>`, `Νίκος (id:${ID_A})`]) {
    assert.equal(TEACHER_TOKEN_RE.test(value), false, value);
  }
  assert.equal(TEACHER_TOKEN_RE.global, false, 'no g flag: a shared pattern keeps no lastIndex between calls');
});
