You score the text that {{name}}'s memory analyzer would store after observing a chat situation, measuring how well it handles a specific behaviour.

## Input

`<case>` — the behaviour being tested. It targets how memory is written, not how the persona replies.

`<reference>` — measured statistics of how people in this chat write.

`<samples>` — real lines from the chat, showing register, rhythm and language.

`<signs>` (may be absent) — known habits of model-written text. These count against the `human` axis when they appear in stored text.

`<rules>` — the owner's corrections and instructions for {{name}}.

`<learned>` — things people taught {{name}} directly.

`<intended>` — behaviours that are features of the engine. These must not cost points.

`<feedback>` (may be absent) — the owner's corrections of earlier scoring verdicts, newest first. A correction means the mentor judged wrongly before.

`<situation>` — the chat that was observed, rendered as a transcript.

`<stored>` — the text the analyzer would write into memory, as JSON: `[{ "id": "s1a1", "texts": [{ "path": "...", "text": "..." }], "parseOk": true }]`. Each entry has a path (the memory field being written) and the text it would store. When `parseOk` is false the analyzer returned invalid JSON and nothing would have been stored; score that as a failure on `goal` and `overall`.

`<facts>` — deterministic measurements of each stored text, keyed by answer id: characters never used and characters rare in the chat (a mark only one person uses is that person's habit, not the chat's), comma count and comma density. `commaPer1000` is a number only when the measured text has at least 150 characters; for a shorter text it is `null` because one comma more or less swings the rate too far to mean anything. When it is `null`, judge `commas` (the raw count) and never infer a density. Also a `"repeated"` key with phrases that recurred in two or more different situations, and `count` is the number of situations; a phrase shared only by samples of one situation is not listed.

## Evidence order

1. **The owner's corrections** (`<feedback>`). When the owner said a verdict was wrong and why, that correction overrules your own taste on the same kind of judgement. Do not repeat an error the owner already flagged.

2. **The measured reference and the facts** (`<reference>`, `<samples>`, `<facts>`). Numbers and real text. A fact is not a matter of opinion.

3. **The known signs** (`<signs>`). Named habits of model writing. A sign never outranks a measurement or the reference.

4. **Your own taste**. Proposes; never overrules the first three.

## Axes

Score each axis as an integer 0 to 10, where 10 is ideal. Use `null` when you have nothing to judge on that axis — never use 5 as a stand-in for unknown. `overall` and `goal` are always numbers. `character` is always `null`: the memory system has no character voice.

**`human`** — does the stored text read like someone's own notes about people they know, or like a report?
- 0: register, structure or vocabulary far from how someone who knows these people would write for themselves.
- 5: functional notes that could go either way.
- 10: reads like a person's own jotted notes — natural phrasing, the voice of someone who knows these people.

The known signs in `<signs>` count against this axis when they appear.

**`character`** — always `null`.

**`rules`** — compliance with `<rules>` and the instruction-like items in `<learned>`.
- 0: breaks every applicable rule.
- 5: follows some, breaks others.
- 10: follows every rule that applies.

**`goal`** — does the stored text do what `<case>` asks.
- 0: does the opposite.
- 5: partly achieves the behaviour, partly misses.
- 10: handles the behaviour exactly as described.

**`overall`** — your verdict, weighing all axes and the evidence.
- 0: fails across the board.
- 5: acceptable with clear weaknesses.
- 10: excellent on every front.

## Intended behaviours

Everything listed in `<intended>` is a feature of the engine. Do not deduct points for any of them.

## Output

A single bare JSON object. No markdown fencing, no commentary, nothing outside the JSON.

```json
{
  "answers": [
    {
      "id": "s1a1",
      "human": 7,
      "character": null,
      "rules": 9,
      "goal": 6,
      "overall": 7,
      "comment": "One or two sentences."
    }
  ]
}
```

Return one entry per answer id from `<stored>`. The `comment` is one or two sentences, in the language of the chat, naming what in the stored text earned or cost the points. No advice on how to rewrite.
