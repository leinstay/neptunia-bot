// Tests for src/llm/parse.js: the model output tag parser and JSON extractor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutput, parseJsonObject } from '../src/llm/parse.js';

test('parseOutput: a single <msg> with no reply', () => {
  const result = parseOutput('<msg>γεια</msg>');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, [{ text: 'γεια', replyTo: null }]);
  assert.deepEqual(result.reactions, []);
});

test('parseOutput: reply="#87" is parsed as replyTo 87', () => {
  const result = parseOutput('<msg reply="#87">hi</msg>');
  assert.equal(result.messages[0].replyTo, 87);
});

test('parseOutput: reply="87" (no #) is also parsed as replyTo 87', () => {
  const result = parseOutput('<msg reply="87">hi</msg>');
  assert.equal(result.messages[0].replyTo, 87);
});

test('parseOutput: at most 3 messages are kept, extras are dropped', () => {
  const result = parseOutput('<msg>1</msg><msg>2</msg><msg>3</msg><msg>4</msg>');
  assert.deepEqual(result.messages.map((m) => m.text), ['1', '2', '3']);
});

test('parseOutput: <think> is stripped from output and returned separately', () => {
  const result = parseOutput('<think> το σχέδιο </think><msg>γεια</msg>');
  assert.equal(result.think, 'το σχέδιο');
  assert.deepEqual(result.messages, [{ text: 'γεια', replyTo: null }]);
  assert.equal(result.skip, false);
});

test('parseOutput: an unclosed <think> means silence, even with a <msg> after it', () => {
  const result = parseOutput('<think> σχέδιο χωρίς τέλος <msg>αυτό δεν πρέπει να σταλεί</msg>');
  assert.equal(result.skip, true);
  assert.deepEqual(result.messages, []);
});

test('parseOutput: <skip/> alone means silence', () => {
  const result = parseOutput('<skip/>');
  assert.equal(result.skip, true);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.reactions, []);
});

test('parseOutput: <skip /> with a space before the slash also works', () => {
  const result = parseOutput('<skip />');
  assert.equal(result.skip, true);
});

test('parseOutput: a reaction alone is not silence', () => {
  const result = parseOutput('<react to="#5">💀</react>');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.reactions, [{ to: 5, emoji: '💀' }]);
});

test('parseOutput: plain text with no tags falls back to one message when short', () => {
  const result = parseOutput('απλό κείμενο χωρίς ετικέτες');
  assert.equal(result.skip, false);
  assert.deepEqual(result.messages, [{ text: 'απλό κείμενο χωρίς ετικέτες', replyTo: null }]);
});

test('parseOutput: plain text with no tags falls back to silence when too long', () => {
  const result = parseOutput('α'.repeat(601));
  assert.equal(result.skip, true);
  assert.deepEqual(result.messages, []);
});

test('parseOutput: plain text of exactly the fallback limit still becomes one message', () => {
  const result = parseOutput('α'.repeat(600));
  assert.equal(result.skip, false);
  assert.equal(result.messages.length, 1);
});

test('parseOutput: an emoji reaction longer than 16 chars is dropped', () => {
  const result = parseOutput('<react to="#1">this is way more than sixteen chars</react>');
  assert.deepEqual(result.reactions, []);
  // no messages, no reactions, no other tags -> falls through to skip (leftover text is empty after stripping nothing)
  assert.equal(result.skip, true);
});

test('parseOutput: an empty <msg> is ignored, but a later non-empty one is kept', () => {
  const result = parseOutput('<msg>   </msg><msg>πραγματικό μήνυμα</msg>');
  assert.deepEqual(result.messages, [{ text: 'πραγματικό μήνυμα', replyTo: null }]);
});

test('parseOutput: only empty <msg> tags and no reactions results in skip, not a text fallback', () => {
  const result = parseOutput('<msg>   </msg>');
  assert.equal(result.skip, true);
  assert.deepEqual(result.messages, []);
});

test('parseOutput: messages longer than MAX_MESSAGE_CHARS are truncated', () => {
  const result = parseOutput(`<msg>${'a'.repeat(2000)}</msg>`);
  assert.equal(result.messages[0].text.length, 1900);
});

test('parseOutput: <msg> and <react> can appear together', () => {
  const result = parseOutput('<msg>χα</msg><react to="#3">🔥</react>');
  assert.equal(result.messages.length, 1);
  assert.equal(result.reactions.length, 1);
  assert.equal(result.skip, false);
});

test('parseOutput: whitespace-only raw input falls back to skip', () => {
  const result = parseOutput('   ');
  assert.equal(result.skip, true);
});

test('parseOutput: null/undefined raw input is treated as empty and skipped', () => {
  assert.equal(parseOutput(undefined).skip, true);
  assert.equal(parseOutput(null).skip, true);
});

test('parseJsonObject: extracts a bare JSON object', () => {
  const parsed = parseJsonObject('{"a": 1, "b": "x"}');
  assert.deepEqual(parsed, { a: 1, b: 'x' });
});

test('parseJsonObject: extracts JSON from inside a code fence', () => {
  const parsed = parseJsonObject('```json\n{"a": 1}\n```');
  assert.deepEqual(parsed, { a: 1 });
});

test('parseJsonObject: extracts JSON surrounded by chatter', () => {
  const parsed = parseJsonObject('Sure, here you go:\n{"a": 1}\nHope that helps!');
  assert.deepEqual(parsed, { a: 1 });
});

test('parseJsonObject: throws when there is no JSON object at all', () => {
  assert.throws(() => parseJsonObject('no json here'), /no JSON object in the model reply/);
});

test('parseJsonObject: throws on an empty string', () => {
  assert.throws(() => parseJsonObject(''), /no JSON object in the model reply/);
});
