# Messages and memory

How the persona processes messages and remembers people.

## The message pipeline

A message passes through guild, channel and self-message filters. If the persona was called (@mention, reply, or name trigger), an ignore heuristic rolls against a base chance adjusted for bare pings, repeated tags, spam, and the caller's relationship score. When the roll fails, the message is ignored; the ignored messages are still in the transcript when the next reply is built.

After the persona answers someone, untagged messages in that channel for the next `mention.followUpMinutes` minutes are sent to a classifier on the `classifier.text` role that decides whether they continue the exchange; three `no` in a row (`mention.followUpNoStreak`) close the window. Follow-up windows survive restarts. `features.followUp` switches it off.

Spontaneous turns fire from a chaotic timer or the per-message eavesdrop chance (`spontaneous.eavesdropChance`). The persona will not speak unprompted in a channel silent for more than `spontaneous.maxChannelSilenceHours` hours; a direct ping there is still answered.

### One reply at a time

The persona writes one reply at a time across the server (`mention.oneAtATime`). A ping in the same channel while it is already answering is missed; the missed messages are in the transcript when the next reply is built. A direct ping in another channel (an @mention or reply to its message, not a name trigger) is held, one per channel, in up to `mention.maxPending` channels for `mention.pendingMinutes` minutes; a newer ping in the same pending channel replaces the older one. When the current reply finishes, the persona switches channel after a short pause (`mention.switchDelayMs`) and answers from the conversation as it stands; the usual ignore chance applies. Name triggers and eavesdrop hits that arrive while busy are skipped. With `mention.oneAtATime: false` every channel is handled independently. The persona never writes or reacts where it lacks Send Messages, checking before it spends an LLM request; such channels are still read and remembered.

### Building the request

The turn collects the channel transcript and neighbouring channels, then builds one LLM request inside the token budget. Sections fill in priority order: system prompt and task are never cut; then the caller's profile, the web lookup result, server habits and self-facts, the channel map, lore entries, the transcript (newest first), other profiles, and neighbouring channels.

The model sees a map of the server's channels (purpose, topics, tone, activity level), with the current channel marked. Each channel entry also carries code-maintained facts: message count, first and last message, a 30-day activity histogram and the top writers. The warmup fills them from the channel's history and live traffic keeps them current.

The model responds with `<think>` (hidden planning), `<msg>` (1–3 chat messages; `reply="#87"` replies to a transcript line), `<react>` (one emoji reaction), or `<skip/>` (silence). After parsing, typing is simulated at human speed and `@nick` in the output becomes a real mention.

## The memory analyzer

The memory analyzer runs as a separate LLM call when enough messages accumulate (`memory.batchMessages`, `memory.minBatchMessages`, `memory.maxBatchAgeMinutes`). It receives the character card and judges each person through the character's eyes, returning attitude deltas, profile changes, channel observations, and server-level notes.

### Profiles

Profiles are updated incrementally: the analyzer returns only what changed, and stored facts are never re-summarised. Each profile contains:

- **Character and style** — prose paragraphs written whole by the profile prompt (`profile.md`) during the warmup and refreshed from recent messages when the analyzer flags a gap or contradiction. The stream analyzer never edits them directly; it returns a one-line portrait hint, and code queues a portrait refresh.
- **Interests** — atomic items with a topic and a note. Ranked by frequency and recency with a weight that decays over time (`memory.interestHalfLifeDays`). More items are kept per person than shown (`memory.maxInterestsStored` vs `memory.maxInterests`), so a newcomer can gather weight in the unseen tail. Interests not seen for `memory.interestStaleDays` are shown to the persona as old.
- **Details** — atomic items (a fact, a trait, a piece of context). Same ranking and confirmation mechanics as interests, with their own half-life (`memory.detailHalfLifeDays`).
- **Aliases** — what people in chat actually call a member. The persona recognises a member mentioned by name or alias even when they are not in the conversation.
- **Relationship** — how the persona and this person stand with each other, written in the persona's voice.
- **Attitude** — a score from -100 to 100 (`features.relationships`). The analyzer returns a small delta, never the absolute score. The score never appears in chat; it shows in how much effort the persona puts in.

The portrait of a member's character and manner of speech is drawn from the channels in `memory.mainChannelIds`; when the list is empty, every channel counts. Stored memory refers to members by id and the current name is substituted when the memory is used, so renames never break stored notes.

### The confirmation mechanism

Interests, details and aliases share a confirmation mechanism. A new item starts at weight 1 (or 0 when the analyzer marks it `"sure": false`). A sighting on a separate occasion (at least `memory.confirmGapHours` apart) raises the weight by 1. An item is confirmed when weight reaches `memory.confirmAfter`; until then the persona sees it with a "(unconfirmed)" mark. Items are ranked by `log2(weight) + lastSeen / halfLife`, so what is frequent AND recent is on top.

## Episodes

Episodes are moments the persona remembers about individual people: an insult, a kindness, a promise, a bet, a shared joke, something someone asked the persona to do or never do. The analyzer appends them to the person's profile with a date, a short description, sometimes the person's own words, and a weight from 1 to 5. The heaviest survive longest; when a profile hits `memory.maxEpisodes`, the lightest are evicted first, then the oldest. Only the caller's episodes are shown, inside the `<people>` block.

## The lorebook

The lorebook stores server-wide knowledge that outlives any conversation: events, recurring characters, long-running stories, feuds, traditions. Each entry has a title, a set of keywords and a short text (`lore.textChars`). The code scans the last `lore.scanMessages` messages for keyword matches and includes up to `lore.maxMatches` entries in a `<lore>` block; entries marked `always` appear every time. Hundreds of entries can exist at negligible cost because only the matching few are shown.

The analyzer adds and updates lorebook entries on its own but never touches entries added by the owner through `/nep lore` commands. Lorebook data lives in `data/guilds/<id>/lore.json`.

## Owner commands that touch memory

The full command list is in [Commands](owner-commands.md). The most relevant for memory:

| Command | What it does |
|---|---|
| `/nep memory show <user>` | Compact summary or a specific section of a stored profile |
| `/nep memory channel` | Stored channel notes and code-maintained facts |
| `/nep memory server` | Server-wide habits, in-jokes, self-facts |
| `/nep memory refresh <user>` | Force a portrait refresh for one member |
| `/nep memory forget <user>` | Delete a stored profile entirely |
| `/nep memory affinity <user>` | Show or set attitude |
| `/nep memory wipe` | Wipe all analyzer memory for the server |
| `/nep lore add` | Add or overwrite a lorebook entry |
| `/nep pause` / `/nep resume` | Stop activity and flush memory to disk for safe manual editing |
