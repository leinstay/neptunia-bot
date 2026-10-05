# Messages and memory

How the persona processes messages and remembers people.

## Pipeline

A message passes through guild, channel and self-message filters. If the persona was called (@mention, reply, or name trigger), an ignore heuristic rolls against a base chance adjusted for bare pings, repeated tags, spam, and the caller's relationship score. When the roll fails, the message is ignored; the ignored messages are still in the transcript when the next reply is built.

After the persona answers someone, untagged messages in that channel for the next `mention.followUpMinutes` minutes are sent to a classifier on the `classifier.text` role that answers `yes`, `overheard` or `no`. A `yes` continues the exchange; an `overheard` (talk about the persona, not to them) starts its own kind of turn with `prompts/overheard.md` when `mention.followUpOverheard` is on (the default), or counts as a plain follow-up otherwise. Three `no` in a row (`mention.followUpNoStreak`) close the window; `overheard` counts as `yes` for the streak. Follow-up windows survive restarts. `features.followUp` switches it off.

Spontaneous turns fire from a chaotic timer or the per-message eavesdrop chance (`spontaneous.eavesdropChance`). A message put to the room (not to one person) has a chance (`spontaneous.roomQuestionChance`, default 0.04) of being picked up, after a classifier (`prompts/room.md`) confirms it is open; the turn is focused on that message. After `spontaneous.deadAfterMinutes` of silence the persona may open a topic even when their own line was the last one; the persona never interjects on their own last line. The persona will not speak unprompted in a channel silent for more than `spontaneous.maxChannelSilenceHours` hours; a direct ping there is still answered.

### One reply

The persona writes one reply at a time across the server (`mention.oneAtATime`). When `mention.pendingSameChannel` is on (default `true`, missing key = on), a direct ping (an @mention or a reply to the persona's message) in the same channel while a turn is running there is held as pending: one per channel, answered after the current turn with the `mention.switchDelayMs` pause, the ignore chance rolled at that moment. The held ping is not answered a second time when the turn that was running already spoke with it in the history. With the switch off, the ping is missed and shows only in the transcript of the next reply. A direct ping in another channel is held the same way, in up to `mention.maxPending` channels for `mention.pendingMinutes` minutes; a newer ping in the same pending channel replaces the older one. When the current reply finishes, the persona switches channel after a short pause (`mention.switchDelayMs`) and answers from the conversation as it stands; the usual ignore chance applies. A pending ping is not answered while the bot is paused. Name triggers and eavesdrop hits that arrive while busy are skipped. With `mention.oneAtATime: false` every channel is handled independently. The persona never writes where they lack Send Messages; such channels are still read and remembered. When `features.elsewhere` is on and the bot is called (@mention, reply, name) in a read-only channel, the call waits for the conversation there to settle (`elsewhere.settleSeconds`, capped at `elsewhere.settleMaxSeconds`), then the persona answers in the first usable channel of `memory.mainChannelIds` with a jump link back to the call. The ordinary ignore and spam rules apply; the settle wait holds no attention. A newer call in the same source replaces the waiting one. A call whose message was deleted (`gone`) or could not be fetched (`fetch-failed`) while waiting is dropped. A restart during the wait loses the call (it stays unanswered in the ring). Calls are remembered in a per-channel ring (`elsewhere.rememberPings`, default 20) for `elsewhere.pingMaxAgeDays` (default 7) days. The persona can also comment unprompted on something they read in a read-only channel (logged as `spontaneous: noticed`); the comment is posted in the main channel with `prompts/elsewhere.md` as the task.

When `features.pauseNotice` is on (the default), a call that arrives while the persona is paused gets a short reply (`labels.limits.paused`). At most one per channel per `mention.pauseNoticeMinutes` (default 10) minutes.

### Timing

Everything that runs before the talk request (history, captions, the variety pass, the route and search classifiers) has a deadline: `pace.prepareMs` (default 6 s), extended to `pace.prepareSearchMs` (default 12 s) once a search is in flight. A helper that misses its deadline is dropped and the turn continues without it (logged as `turn: stage late` or `turn: stage failed`). The finished answer itself must arrive within `pace.dropAfterMs` (default 60 s) from the turn's start; past that, the turn is dropped unposted (logged as `turn: dropped`). Every turn logs the time of each stage in `turn: timings`.

Requests on the roles listed in `llm.hedge.roles` (default: `classifier.text`) are hedged: a second attempt starts `llm.hedge.afterMs` (default 2.5 s) after the first, and the first to finish wins. Both are aborted at `llm.hedge.timeoutMs` (default 8 s) from the start. `llm.helperTimeoutMs` (default 30 s) caps the route classifier, the search classifier and the recall summary individually.

With `pace.typingWhilePreparing` on (off as shipped), the typing indicator shows from the start of a turn answering a direct call, not only while the finished answer is being typed out.

### Request

The turn collects the channel transcript and neighbouring channels, then builds one LLM request inside the token budget. Sections fill in priority order: system prompt and task are never cut; then the caller's profile, the lookup result (web, server or both), server habits and self-facts, the channel map, lore entries, the transcript (newest first), other profiles, and neighbouring channels.

When `features.channelRoute` is on (the default), a classifier (`prompts/route-channel.md`) picks a channel the conversation is about from a list of up to `route.maxChannels` (default 40) candidates, so that channel can be pulled into the request as a `<channel_view>` block. This works alongside explicit channel mentions (`features.channelPull`): the route classifier resolves indirect references ("that channel", "X's channel"), while a real `<#id>` mention is always pulled directly.

The model sees a map of the server's channels (purpose, topics, tone, activity level), with the current channel marked. Each channel entry also carries code-maintained facts: message count, first and last message, a 30-day activity histogram and the top writers (`memory.channelWritersStored`, decayed by `memory.channelWritersHalfLifeDays`). The warmup fills them from the channel's history and live traffic keeps them current. When a channel's notes have not changed for `memory.notesStaleDays` (default 7) and the batch has at least `memory.notesMinLines` (default 20) lines from it, the analyzer is asked to re-check them.

The model responds with `<think>` (hidden planning), `<msg>` (1 to 3 chat messages; `reply="#87"` replies to a transcript line), `<react>` (one emoji reaction), or `<skip/>` (silence). After parsing, typing is simulated at human speed and `@nick` in the output becomes a real mention. Each message is cut to Discord's 2000-character limit. A message that fails to send is logged (`turn: send failed`) and ends the posting for that turn.

## Recent

When `features.recent` is on (the default), a `<recent>` block shows what happened on the server in the last `memory.recentHours` (default 72) hours: short dated lines the analyzer writes and recent episodes of the members the turn addresses. A line appears only from the turn's own channel or from a channel everyone here can also read; in a private chat, only from channels every server member can read, with no episodes. Items about the people the turn addresses rank first. The block is capped at `context.caps.recent` (default 1200) tokens.

The analyzer writes at most `memory.maxNewRecent` (default 3) lines per batch, each up to `memory.recentChars` (default 160) characters. Lines are stored in `data/guilds/<id>/recent.json` (up to `memory.maxRecentStored`, default 150) and expire after `memory.recentHours`. `/nep memory recent` shows the live lines.

## Analyzer

The memory analyzer runs as a separate LLM call when enough messages accumulate (`memory.batchMessages`, `memory.minBatchMessages`, `memory.maxBatchAgeMinutes`). It receives the character card and judges each person through the character's eyes, returning attitude deltas, profile changes, channel observations, and server-level notes.

When a batch is too large for the token cap, the oldest lines that fit are analyzed and the rest are deferred for the next batch (the log reports `consumed`, `shown` and `deferred`). A quiet private buffer (no new messages for `memory.privateMaxAgeMinutes`, default 360) is analyzed even when it has not reached `minBatchMessages`. In-joke and self-fact lists make room for new entries by evicting the stalest existing one when the list is full. Lore evicts the stalest entry when `lore.maxEntries` is reached.

A failed batch (truncated output, unparsable JSON, over the token limit) halves the batch size for the next attempt. When the batch is already at the floor (20 messages) and still fails, it backs off for 15 minutes instead of retrying at once (logged as `memory: update failed ... backing off` with `atFloor: true` and `backoffMs`). The buffer is kept either way.

### Profiles

Profiles are updated incrementally: the analyzer returns only what changed, and stored facts are never re-summarised. Each profile contains:

- **Character and style**: prose paragraphs written whole by the profile prompt (`profile.md`) during the warmup and refreshed from recent messages by code (on a message-count schedule) or when the analyzer flags a gap or contradiction. The stream analyzer never edits them directly; a stream batch that returns `character` or `style` has those fields dropped.
- **Interests**: atomic items with a topic and a note. Ranked by frequency and recency with a weight that decays over time (`memory.interestHalfLifeDays`). More items are kept per person than shown (`memory.maxInterestsStored` vs `memory.maxInterests`), so a newcomer can gather weight in the unseen tail. Interests not seen for `memory.interestStaleDays` are shown to the persona as old.
- **Details**: atomic items (a fact, a trait, a piece of context). Same ranking and confirmation mechanics as interests, with their own half-life (`memory.detailHalfLifeDays`).
- **Aliases**: what people in chat actually call a member. The persona recognises a member mentioned by name or alias even when they are not in the conversation.
- **Relationship**: how the persona and this person stand with each other, written in the persona's voice.
- **Attitude**: a score from -100 to 100 (`features.relationships`). The analyzer returns a small delta, never the absolute score. The score never appears in chat; it shows in how much effort the persona puts in. Scores decay toward zero daily when `relationships.decayPerDay` is set, faster the further from zero. The relationship text is flagged for rewrite when it goes stale: a band change (past `relationships.bandHysteresis` points), a drift of `relationships.rewriteOnDrift` points since it was written, or `relationships.rewriteAfterMoves` attitude moves since then. The text is capped at `relationships.textChars` (default 600).

The portrait of a member's character and manner of speech is drawn from the channels in `memory.mainChannelIds`; when the list is empty, every channel counts. `memory.mainChannelIds` also names the destination for answers to calls from read-only channels (`features.elsewhere`). Stored memory refers to members by id and the current name is substituted when the memory is used, so renames never break stored notes.

### Confirmation

Interests and details share a confirmation mechanism. A new item starts at weight 1 (or 0 when the analyzer marks it `"sure": false`). A sighting on a separate occasion (at least `memory.confirmGapHours` apart) raises the weight by 1. An item is confirmed when weight reaches `memory.confirmAfter`; until then the persona sees it with a "(unconfirmed)" mark. Aliases use the same ranking and sighting mechanics, but the `"sure": false` mechanism and the unconfirmed mark do not apply to them. All three are ranked by `log2(weight + 0.5) + lastSeen / halfLife`, so what is frequent AND recent is on top.

## Episodes

Episodes are moments the persona remembers about individual people: an insult, a kindness, a promise, a bet, a shared joke, something someone asked the persona to do or never do. The analyzer appends them to the person's profile with a date, a short description, sometimes the person's own words, and a weight from 1 to 5. The heaviest survive longest; when a profile hits `memory.maxEpisodes`, the lightest are evicted first, then the oldest. The `memory.keepNewestEpisodes` (default 5) most recently added episodes are exempt from eviction, so a light new moment is not pushed out on arrival. Only the caller's episodes are shown, inside the `<people>` block.

## Lorebook

The lorebook stores server-wide knowledge that outlives any conversation: events, recurring characters, long-running stories, feuds, traditions. Each entry has a title, a set of keywords and a short text (`lore.textChars`). The code scans the last `lore.scanMessages` messages for keyword matches and includes up to `lore.maxMatches` entries in a `<lore>` block; entries marked `always` appear every time. Hundreds of entries can exist at negligible cost because only the matching few are shown.

The analyzer adds and updates lorebook entries but never touches entries added by the owner through `/nep lore` commands. Lorebook data lives in `data/guilds/<id>/lore.json`.

The analyzer also records things people taught the persona directly (words and expressions, facts about the server, requests about their behaviour) as server-level learned items that are always present in the prompt.

## Private layer

When `features.privateMessages` is on, members who pass the gate (guild membership, a stored profile, public affinity at or above `private.minAffinity`, today's reply count under the cap) can write to the persona in Discord DMs. The persona is the same character with the same public memory; what is said in a DM stays in a per-member private layer.

Only bot owners can inspect a member's private layer (`/nep private show`); this command cannot be granted to other users.

The private file `data/guilds/<guildId>/private/<userId>.json` stores its own `relationship`, `interests`, `details`, `episodes`, `affinity` (score starting at 0), the daily reply counter and an observation buffer. It is never shown to any other conversation, never written by a server batch, and never mixed into the public profile on disk. The public profile is never changed by a DM.

In a DM the persona sees public and private data merged: interests unioned by topic (the private note wins), details concatenated, episodes sorted by date, relationship paragraphs joined. The effective affinity is `clamp(public + private, -100, 100)`. On the server the persona sees only the public score.

The private analyzer (`analyzePrivate`) runs the same `memory.md` prompt with a `<private>` block. Only `users[<partnerId>]` from the answer is applied through the private store; `portrait`, `aliases`, `guild`, `channels`, `lore`, `self` and other user ids are dropped.

`/nep memory forget <user>` deletes both the public profile and the private file. `/nep memory wipe` removes the entire `private/` directory for the server. `/nep private forget <user>` deletes only the private file; the public profile is kept.

## Commands

The full command list is in [Commands](owner-commands.md). The most relevant for memory:

| Command | What it does |
|---|---|
| `/nep memory recent` | Show the live recent lines |
| `/nep memory show <user>` | Compact summary or a specific section of a stored profile |
| `/nep memory channel` | Stored channel notes and code-maintained facts |
| `/nep memory server` | Server-wide habits, in-jokes, self-facts |
| `/nep memory refresh <user>` | Force a portrait refresh for one member |
| `/nep memory forget <user>` | Delete a stored profile, private memory and queued voice items |
| `/nep memory affinity <user>` | Show or set attitude |
| `/nep memory wipe` | Wipe all analyzer memory for the server, including private files |
| `/nep private show <user>` | Show a member's private memory |
| `/nep private forget <user>` | Delete only the private file; the public profile is kept |
| `/nep lore add` | Add or overwrite a lorebook entry |
| `/nep pause` / `/nep resume` | Stop activity and flush memory to disk for safe manual editing |
