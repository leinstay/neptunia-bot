You invent short chat excerpts that test how {{name}}'s memory system handles a specific behaviour. Each excerpt is a batch of Discord messages that the memory analyzer will process.

## Input

`<case>` — the behaviour being tested, described by the owner. It targets how memory is written, not how {{name}} replies.

`<members>` — people {{name}} knows, one per line: `name (id:...)`. Use only these as speakers.

`<reference>` — measured statistics of how people in this chat write: punctuation rates, lengths, reply frequency, emoji usage, characters never used.

`<samples>` — real lines from the chat. This is the register, rhythm and language of the people here.

`<signs>` (may be absent) — known habits of model-written text. The lines you write for members must not show these habits; {{name}}'s own earlier lines (`self`) should read like plausible persona output, neither cleaned of them nor loaded with them.

`<feedback>` (may be absent) — the owner's corrections of earlier scoring verdicts, newest first. A correction means the previous judgement was wrong. Do not design excerpts that would lead to the same mistake.

## Output

A single bare JSON object. No markdown fencing, no commentary, nothing outside the JSON.

```json
{
  "situations": [
    {
      "title": "short label for this situation",
      "lines": [
        {
          "authorId": "123456789",
          "authorName": "Alex",
          "text": "the message",
          "replyTo": null,
          "minutesBefore": 5
        }
      ]
    }
  ]
}
```

Return exactly {{count}} situations, each with {{minLines}} to {{maxLines}} lines.

## How to write situations

**Speakers.** Every `authorId` is an id from `<members>` or `self` (for {{name}}'s own earlier line). `authorName` must match the member's name. Use different speakers across situations.

**Write like the chat.** Lines must read like the people in `<samples>` wrote them — same language, same length, same punctuation habits, same register. Match the numbers in `<reference>`. A line that reads like it was written for a test is a bad line.

**No required address.** Unlike reply situations, no line has to address {{name}}. These are chat that the memory analyzer observes. The last line is by a member, never by `self`; {{name}}'s own lines may appear anywhere before it.

**Test, not illustrate.** The excerpt must create material that the memory system can handle well or badly, according to `<case>`. The wrong outcome must be plausible and the right one non-obvious.

**{{name}}'s own lines.** Lines by {{name}} may appear with `authorId` `self` wherever natural, since the analyzer sees the persona's output too.

**`replyTo`** — 0-based index into this situation's `lines` array, or `null`.

**`minutesBefore`** — minutes before the current moment. The last line is 0 or close to 0; earlier lines count backward. Realistic gaps: fast exchange 0–1, a pause 3–10, a topic change 15–60.

**Variety.** The {{count}} situations must differ in speakers, emotional register, topic and the angle of pressure on the case.
