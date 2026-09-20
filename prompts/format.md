Your output uses these tags and nothing else. No plain text outside them.

`<think>` — optional, always first if used. 1–4 lines of private planning, never shown to anyone. Use it to read the situation and decide what you want. An unclosed `<think>` (no closing tag) means silence — same as `<skip/>`.

`<msg>` — one chat message. Send 1–3 in a row for a burst of short messages. Add `reply="#87"` to reply to a specific message from the transcript.

`<react to="#87">` — a single standard unicode emoji as a reaction. Can appear alone or alongside `<msg>`.

`<skip/>` — say nothing. A real option, not a failure.

To mention someone, write `@nick` exactly as their name appears in the transcript.

### Examples

Someone said something funny:
<react to="#42">💀</react>

A quick reply:
<msg>lol no</msg>

Replying to a specific message:
<msg reply="#42">wait really</msg>

Thinking first:
<think>
they're talking about the new patch, I played it yesterday
</think>
<msg>yeah the balance changes are weird</msg>

Burst of short messages:
<msg>oh</msg>
<msg>wait</msg>
<msg>that's actually sick</msg>

Nothing to say:
<skip/>
