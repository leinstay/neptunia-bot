# Neptunia Engine

SillyTavern-inspired Discord pseudo-user engine with a pluggable personality.

Node.js 20+, one dependency (discord.js), any OpenRouter-compatible endpoint. Ships with a working example character; write your own without touching code. Each instance serves one server, one bot account, one personality. For a second server or character, run a second copy with its own `.env`, `config.local.json`, `prompts.local/` and `data/`.

Discord marks bot accounts with an APP badge. The engine does not disguise that; the goal is behaviour and voice.

The persona responds to mentions, replies and name triggers, sometimes ignoring them. It cuts into conversations at random intervals and starts topics in dead channels. It remembers people, tracks attitudes from -100 to 100, and lets those shape how it engages. The score never appears in chat. All config and prompts are hot-reloaded; owner commands tune the bot live from Discord.

## Quick start

Create a Discord application at [discord.com/developers](https://discord.com/developers/applications). Enable the **Message Content** privileged intent on the Bot page. The invite URL needs both scopes (`scope=bot%20applications.commands`) and `permissions=68672` (view channels, send messages, read history, add reactions). If slash commands do not appear after the bot joins, the log says why; re-opening the invite URL and walking through it again fixes registration without removing the bot.

Get an API key from [OpenRouter](https://openrouter.ai/keys) (or any compatible endpoint).

```bash
git clone https://github.com/leinstay/neptunia-bot.git
cd neptunia-bot && npm install
cp .env.example .env
```

Edit `.env` with your Discord token and API key. Create `config.local.json` with your Discord user ID:

```json
{
  "bot": {
    "owners": ["YOUR_DISCORD_USER_ID"]
  }
}
```

```bash
npm start
```

When `bot.guildId` is empty and the bot is in exactly one server, it locks to that server automatically. If the bot is in several servers, it refuses to start. Set `bot.guildId` in `config.local.json`.

## Prompt layers

Prompts load from two directories:

- `prompts/`: tracked engine defaults. Ships with a working example character.
- `prompts.local/`: your personality (gitignored). A file here replaces the same-named file in `prompts/`. `labels.json` is deep-merged, so you only override the keys you change.

Both are hot-reloaded.

### Prompt files

| File | Required | Purpose |
|---|---|---|
| `system-prompt.md` | yes | How to pass for a human chat member, character-agnostic |
| `character-card.md` | yes | The personality: who they are, how they talk, what they care about |
| `rules.md` | no | Owner's live corrections, appended by `/nep rule add` |
| `format.md` | yes | Output protocol: tags the model uses to act |
| `reply.md` | yes | Task: someone addressed the persona |
| `interject.md` | yes | Task: cut into a live conversation |
| `initiate.md` | yes | Task: break a silence, start a topic |
| `memory.md` | yes | Technical prompt for the memory/relationship analyzer |
| `describe.md` | yes | One-line media descriptions for the helper model |
| `profile.md` | yes | Bootstrap: one member's profile from a message sample |
| `channel.md` | yes | Bootstrap: channel notes from a message sample |
| `server.md` | yes | Bootstrap: server-level notes from channel notes and member summaries |
| `labels.json` | yes | Every string the code inserts into prompts (deep-merged between layers) |

**The only file you must rewrite is `character-card.md`.** Copy it to `prompts.local/` and write your persona. Everything else works as-is, or override individual files as needed.

Write your prompts in the language the character speaks. Translate `labels.json` too: copy it to `prompts.local/`, change the `locale` and values, so the model reads one language throughout.

The memory analyzer judges how the character feels about people. It receives your character card, so include what your character likes and dislikes; that drives the relationship scores.

### Tips

The system prompt handles sounding human, so the card is purely personality. Give the character opinions and a default mood rather than agreeability. Keep reference lines short and varied; they anchor style over long conversations. Write the card in the character's voice. Make profanity carry meaning, not fill space. Make silence a real option. A character that always answers is the most obvious bot tell.

## Configuration

`config.json` holds every setting with its default. `config.local.json` (gitignored) is deep-merged over it. Both are hot-reloaded.

### `features`

| Key | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Full pipeline, never sends (see [Dry run](#dry-run)) |
| `mentions` | `true` | React to @mentions |
| `replies` | `true` | React to replies |
| `nameTriggers` | `true` | React to name mentions in messages |
| `spontaneous` | `true` | Unprompted messages on a random timer |
| `eavesdrop` | `true` | Random chance to jump into any message |
| `memory` | `true` | Build profiles, track server patterns, record self-claims |
| `relationships` | `true` | Per-member attitude scores (-100..100) |
| `episodes` | `true` | Per-person long-term memories (moments, quotes, grudges) |
| `lore` | `true` | Server-wide lorebook |
| `reactions` | `true` | Emoji reactions |
| `multiMessage` | `true` | Allow 2–3 messages in a row |
| `vision` | `true` | Process attached images |
| `mediaDescriptions` | `false` | One-line descriptions for pictures, GIFs, video frames and link thumbnails |
| `typingSimulation` | `true` | Simulate typing speed |
| `adminCommands` | `true` | Owner slash commands; `false` unregisters them |

### `bot`

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `"UTC"` | Timezone for model timestamps |
| `owners` | `[]` | User IDs for owner commands |
| `commandName` | `"nep"` | Slash command name (lowercase `a-z 0-9 _ -`, up to 32 chars; re-registered on change) |
| `nameTriggers` | `[]` | Extra trigger strings besides @mention |
| `guildId` | `""` | Server to lock to; auto-detected if in exactly one |
| `dryRunChannelId` | `""` | Channel for dry-run mirror (see [Dry run](#dry-run)) |
| `channels.allow` | `[]` | Allowed channels (empty = all visible) |
| `channels.deny` | `[]` | Ignored channels |

### `llm`

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | Chat completions endpoint |
| `model` | `"anthropic/claude-opus-4.6"` | Model ID |
| `temperature` | `1` | Sampling temperature |
| `maxOutputTokens` | `700` | Max output tokens |
| `maxRequestTokens` | `50000` | Hard token cap per request |
| `safetyMargin` | `0.9` | Budgeting fraction of maxRequestTokens |
| `timeoutMs` | `90000` | Request timeout (ms) |
| `pingTimeoutMs` | `30000` | Timeout for `/nep ping` requests (ms) |
| `retries` | `2` | Retries on transient failures |
| `maxRequestsPerDay` | `300` | Daily request cap |
| `provider` | `null` | OpenRouter `provider` routing object, passed verbatim; `null` sends nothing |

`llm.provider` sets OpenRouter's provider routing field on every request, for example `{ "ignore": ["some-provider"] }` or `{ "order": ["anthropic"], "allow_fallbacks": true }`. If the OpenRouter account itself restricts allowed providers, ignoring the only one left makes every request fail with "No endpoints found". After changing provider settings, run `/nep ping` to verify that every model role is reachable.

### `context`

| Key | Default | Meaning |
|---|---|---|
| `channelMessages` | `100` | Current channel messages |
| `neighborMessages` | `5` | Messages per neighbour channel |
| `neighborMaxAgeMinutes` | `60` | Max age for neighbour messages (min) |
| `neighborMaxChannels` | `8` | Max neighbour channels |
| `maxMessageChars` | `800` | Truncate messages beyond this (chars) |
| `gapMarkerMinutes` | `20` | Time-gap marker threshold (min) |
| `otherProfiles` | `6` | Max other profiles shown |
| `tempo.liveMessages10min` | `4` | Messages in 10 min = "live" |
| `tempo.deadSilenceMinutes` | `45` | Silence minutes = "dead" |
| `caps.interlocutor` | `3500` | Token cap: caller's profile with episodes |
| `caps.aboutChat` | `2500` | Token cap: server habits / self-facts |
| `caps.lore` | `1500` | Token cap: lore entries |
| `caps.people` | `4000` | Token cap: other profiles |
| `caps.neighbors` | `3000` | Token cap: neighbour channels |
| `caps.server` | `2500` | Token cap: channel map |
| `channelActivity.liveMessagesPerDay` | `20` | Daily messages = "active" channel |
| `channelActivity.deadAfterDays` | `7` | Days without messages = "dead" channel |
| `vision.maxImages` | `4` | Max images per request |
| `vision.tokensPerImage` | `400` | Token budget per image |
| `vision.imageSize` | `512` | Downscale target in px, via Discord's media proxy |
| `vision.recentImages` | `3` | Recent channel images to include |
| `vision.recentImageMinutes` | `30` | Max age for recent images (min) |
| `vision.maxBytes` | `1500000` | Max image file size (bytes); larger pictures are skipped |
| `vision.fetchTimeoutMs` | `10000` | Download timeout per image (ms) |

### `media`

Settings for the media describer (`features.mediaDescriptions`).

| Key | Default | Meaning |
|---|---|---|
| `model` | `"anthropic/claude-haiku-4.5"` | Describer model |
| `maxOutputTokens` | `120` | Max output tokens per description |
| `imageSize` | `512` | Downscale target in px |
| `maxPerTurn` | `6` | Max descriptions generated per turn |
| `maxPerBatch` | `20` | Max descriptions per memory batch |
| `cacheEntries` | `5000` | Description cache size, keyed by attachment |
| `filePreviewChars` | `500` | Characters shown from the beginning of text files |
| `embedTextChars` | `200` | Characters shown from link embed text |

### `mention`

| Key | Default | Meaning |
|---|---|---|
| `ignoreChance` | `0.12` | Base ignore chance |
| `emptyMentionIgnoreChance` | `0.35` | Ignore chance for bare @mention |
| `repeatWindowMinutes` | `10` | Repeat tracking window (min) |
| `repeatPenalty` | `0.25` | Added ignore chance per repeat |
| `spamThreshold` | `4` | Calls in window before spam |
| `spamIgnoreChance` | `0.9` | Ignore chance when spammed |
| `nameTriggerChance` | `0.5` | Name trigger response chance |
| `neverIgnore` | `[]` | User IDs never ignored |
| `affinityIgnoreBonus` | `0.3` | Max added ignore at affinity -100 |
| `affinityLikeBonus` | `0.08` | Max reduced ignore at affinity +100 |
| `oneAtATime` | `true` | One reply at a time across the server |
| `maxPending` | `3` | Channels that can hold a direct ping while busy |
| `pendingMinutes` | `10` | Minutes before a held ping expires |
| `switchDelayMs` | `[2000, 9000]` | Pause before answering in the next channel (ms) |

### `typing`

| Key | Default | Meaning |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | Reaction delay range (ms) |
| `msPerChar` | `[35, 75]` | Per-character typing speed (ms) |
| `minMs` | `900` | Min typing duration (ms) |
| `maxMs` | `12000` | Max typing duration (ms) |
| `betweenMessagesMs` | `[700, 3500]` | Pause between messages (ms) |

### `spontaneous`

| Key | Default | Meaning |
|---|---|---|
| `channels` | `[]` | Allowed channels |
| `maxChannelSilenceHours` | `72` | Channel silence that blocks spontaneous messages (hours); 0 = no limit |
| `minIntervalMinutes` | `25` | Min check interval (min) |
| `maxIntervalMinutes` | `420` | Max check interval (min) |
| `burstChance` | `0.15` | Burst follow-up chance |
| `burstMinutes` | `[3, 15]` | Burst timing range (min) |
| `activeHours` | `{ from: 10, to: 3 }` | Active hours (wraps midnight) |
| `liveWindowMinutes` | `15` | Live window (min) |
| `liveMinMessages` | `4` | Min messages for "live" |
| `deadAfterMinutes` | `90` | Silence before "dead" (min) |
| `initiateChance` | `0.35` | Chance of starting a topic vs interjecting |
| `eavesdropChance` | `0.02` | Per-message jump-in chance |
| `eavesdropDelayMs` | `[5000, 40000]` | Eavesdrop delay range (ms) |
| `minGapMinutes` | `12` | Min gap between actions (min) |

### `memory`

| Key | Default | Meaning |
|---|---|---|
| `model` | `null` | Analyzer model (`null` = llm.model) |
| `mainChannelIds` | `[]` | Channels where people talk to each other; the portrait of a member's character and style is drawn from them; empty means every channel counts |
| `portraitRefreshHours` | `24` | Min hours between portrait refreshes per member |
| `portraitRefreshPerDay` | `20` | Max portrait refreshes per server per day |
| `batchMessages` | `60` | Ideal batch size |
| `minBatchMessages` | `15` | Min messages before update |
| `maxBatchAgeMinutes` | `180` | Force update after (min) |
| `maxOutputTokens` | `8000` | Max analyzer output tokens |
| `fieldChars` | `400` | Profile field limit (chars) |
| `clampTolerance` | `1.25` | Text from the analyzer may exceed a limit by this factor before it is cut; cuts land on a sentence or word boundary and never inside a member reference |
| `maxDetails` | `15` | Detail items shown to the persona and analyzer per profile |
| `maxDetailsStored` | `40` | Detail items kept per profile; the top by frequency and recency are shown |
| `maxInterests` | `12` | Interest items shown to the persona and analyzer per profile |
| `maxInterestsStored` | `40` | Interest items kept per profile; the top by frequency and recency are shown |
| `interestTopicChars` | `40` | Max chars for an interest topic |
| `interestNoteChars` | `120` | Max chars for an interest note |
| `confirmAfter` | `2` | Sightings before an interest or detail is confirmed |
| `confirmGapHours` | `12` | Hours between sightings to count as a new occasion |
| `interestStaleDays` | `90` | Days without sighting before an interest is marked old |
| `interestHalfLifeDays` | `180` | Weight half-life for interests (days); an unseen item's weight halves each period, so a new pastime can overtake an old one |
| `detailHalfLifeDays` | `720` | Weight half-life for details (days) |
| `maxAliases` | `5` | Aliases shown to the persona and analyzer per profile |
| `maxAliasesStored` | `15` | Aliases kept per profile; the top by frequency and recency are shown |
| `aliasHalfLifeDays` | `365` | Weight half-life for aliases (days) |
| `maxInjokes` | `15` | Max server in-jokes |
| `maxSelfFacts` | `20` | Max self-claims |
| `maxEpisodes` | `20` | Max episodes kept per person |
| `maxNewEpisodes` | `3` | Max new episodes per person per batch |
| `timeoutMs` | `300000` | Analyzer timeout (ms), separate from `llm.timeoutMs` |

The analyzer prompt reads these limits as placeholders, so raising a value takes effect on the next batch. Bigger profiles cost context tokens (`context.caps.people`, `context.caps.interlocutor`) and analyzer output (`memory.maxOutputTokens`).

### `relationships`

| Key | Default | Meaning |
|---|---|---|
| `damping` | `true` | Damp score changes that push further from zero; changes toward zero apply in full |
| `dampingPower` | `1` | Exponent of the damping factor; higher values make the ends of the scale harder to reach |
| `maxDeltaPerUpdate` | `15` | Max score change per update |
| `historySize` | `10` | Attitude changes kept per member |
| `directTriggerCount` | `6` | Direct interactions that force early update |

With `damping` on, a change that pushes the score further from zero is scaled by `(1 - |score| / 100) ^ dampingPower`, so extremes take sustained effort; a change back toward zero applies at full strength. The score is stored with fractional precision and shown as a whole number; `/nep memory affinity` sets it directly without damping.

### `lore`

| Key | Default | Meaning |
|---|---|---|
| `maxEntries` | `500` | Max lorebook entries per server |
| `scanMessages` | `30` | Messages scanned for key matches |
| `maxMatches` | `8` | Max entries shown per request |
| `textChars` | `600` | Lore entry text limit (chars) |

## Getting started with memory

The engine builds its memory of people and channels from a sample of recent messages. On first start, when `bootstrap.enabled` is true and no profile exists yet, a bootstrap run starts automatically. The persona stays mute while it runs.

**Order of operations:**

1. **Channels**: every readable channel gets one request. The result is a set of channel notes: purpose, topics, tone.
2. **People**: the most active members (at least `bootstrap.minMessages` own messages in the window, up to `bootstrap.maxPeople`) each get a profile. The engine samples up to `bootstrap.messagesPerPerson` of their messages with `bootstrap.contextBefore` lines of surrounding context. Large samples are split into chunks that fit `bootstrap.maxRequestTokens`; each later chunk receives the previous answer as a draft to keep, correct and extend. The final answer stores character, style, interests, details, episodes and aliases.
3. **Server**: one request takes the channel notes, a summary line per profiled member and the newest `bootstrap.serverSampleMessages` lines of the main channels, and produces server-wide patterns, conversation starters, in-jokes and lore.

Attitude and relationship are not bootstrapped; they grow from live conversation.

Progress is persisted after every request and survives restarts. The total token budget is `bootstrap.maxTokens`; the per-request cap (`bootstrap.maxRequestTokens`) applies to each call. A provider rate limit (HTTP 429) is waited out for `bootstrap.rateLimitWaitMinutes` per wait, up to `bootstrap.rateLimitMaxWaits` consecutive waits.

After the bootstrap finishes, the live stream analyzer keeps memory current. It processes batches of new messages and updates interests, details, attitudes, episodes, aliases, channel notes and server patterns. When it detects that a stored portrait misses a recurring habit or contradicts how the person now writes, the engine refreshes the portrait from `bootstrap.refreshMessages` recent messages using the profile prompt. A portrait can be refreshed at most once every `memory.portraitRefreshHours` hours, up to `memory.portraitRefreshPerDay` times per day across the server. `/nep memory refresh <user>` forces one.

`/nep bootstrap run` starts or resumes a run. `/nep bootstrap run [user|channel|server]` reruns one target or one phase. `/nep bootstrap people` lists qualifying members. `/nep bootstrap preview <user|channel>` previews what would be written without writing anything. `/nep bootstrap reset` clears progress only, not stored memory. For a truly fresh start, use `/nep memory wipe` first: it clears member profiles with their attitudes and moments, server habits, the channel map, the analyzer's lore entries and the bootstrap progress, after the owner types the server's exact name.

### `bootstrap`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the bootstrap automatically on first start |
| `lookbackDays` | `60` | How far back to sample (days) |
| `minMessages` | `30` | Own messages for a member to qualify |
| `maxPeople` | `40` | Members processed, most active first |
| `messagesPerPerson` | `2000` | Own messages sampled per member |
| `contextBefore` | `1` | Context lines before each sampled message |
| `maxChannelShare` | `0.5` | Max share of samples from one channel |
| `messagesPerChannel` | `200` | Messages sampled per channel |
| `serverSampleMessages` | `600` | Recent main-channel messages for the server request |
| `refreshMessages` | `400` | Messages sampled for a portrait refresh |
| `fetchLimitPerChannel` | `15000` | Messages fetched per channel for the sample pool |
| `maxOutputTokens` | `6000` | Max output tokens per bootstrap request |
| `maxRequestTokens` | `120000` | Max tokens per bootstrap request (input + output) |
| `maxTokens` | `6000000` | Total token budget for the run |
| `rateLimitWaitMinutes` | `10` | Minutes to wait on a rate limit |
| `rateLimitMaxWaits` | `36` | Consecutive waits before the run aborts |

## Dry run

With `features.dryRun: true` the bot runs the full pipeline (memory, triggers, LLM calls) but never sends a message or reaction. Output goes to the log (`dry-run: would send` / `dry-run: would react`). Set `bot.dryRunChannelId` to a private channel for a readable mirror; everything posted in that channel is ignored by the bot. Slash commands work in any channel, the mirror included, because they are not messages.

First run on a new server: enable `features.dryRun`, watch the mirror or `journalctl -u neptunia-bot -f`, tune live, then `/nep set features.dryRun false`.

## Owner commands

One Discord slash command, `/nep` (the name comes from `bot.commandName`). Guild commands, registered on start for the served server. Hidden from ordinary members (`default_member_permissions: 0`) and restricted to the ids in `bot.owners`. Every answer is ephemeral; only the owner sees it, in whatever channel it was typed. Channels and users are picked from Discord's own pickers; `set`/`unset` autocomplete config paths. The bot does not read direct messages.

| Command | What it does |
|---|---|
| `/nep status` | Model, calibration, quotas and per-guild memory status |
| `/nep reload` | Reload config and prompts now |
| `/nep ping [role]` | Send a minimal request to one or all model roles (`talk`, `analyzer`, `media`) and report model, latency, provider, tokens or the error; does not count against `llm.maxRequestsPerDay` and works while paused or bootstrapping |
| `/nep pause` | Stop all activity, flush memory to disk and unload it; `data/` is safe to edit while paused |
| `/nep resume` | Reload memory from `data/` and continue; refuses if any JSON file does not parse, naming the broken ones |
| `/nep poke [mode] [channel]` | Force a spontaneous action |
| `/nep set <path> <value>` | Override a config value (writes to `config.local.json`) |
| `/nep unset <path>` | Remove a config override |
| `/nep rule add <text>` | Append a rule to `prompts.local/rules.md` |
| `/nep rule list` | List the rules, numbered |
| `/nep rule remove <number>` | Remove a rule by number |
| `/nep model show` | Show active models for each role (`talk`, `analyzer`, `media`) |
| `/nep model set <role> <id>` | Set the model for a role (`talk`, `analyzer`, `media`) |
| `/nep memory show <user> [section] [limit] [order]` | Without a section: compact summary. Sections: `character`, `style`, `relationship`, `affinity`, `aliases`, `interests`, `details`, `episodes`, `raw` (stored JSON). List sections take `limit` 1..100 (default 25) and `order`: `rank` (default, divider at the visibility cutoff) or `recent`. Stored member references resolve to the current name, except in `raw` |
| `/nep memory refresh <user>` | Force a portrait refresh for a member |
| `/nep memory forget <user>` | Delete a stored profile |
| `/nep memory affinity <user> [score] [reason]` | Show or set attitude (-100..100) |
| `/nep memory alias-add <user> <name>` | Add a chat alias; confirmed at once |
| `/nep memory alias-remove <user> <name>` | Remove a chat alias |
| `/nep memory wipe <confirm>` | Wipe all analyzer memory for this server; type the exact server name to confirm |
| `/nep lore add <title> <keys> <text> [always]` | Add a lorebook entry |
| `/nep lore list [query]` | List lorebook entries |
| `/nep lore show <id>` | Show a lorebook entry |
| `/nep lore remove <id>` | Remove a lorebook entry |
| `/nep bootstrap run [user\|channel\|server]` | Start or resume a bootstrap; optionally rerun one target or phase |
| `/nep bootstrap people` | List members who qualify for bootstrap |
| `/nep bootstrap preview <user\|channel>` | Preview what would be written without writing anything |
| `/nep bootstrap reset` | Clear bootstrap progress, not stored memory |

## How a turn works

A message passes through guild, channel and self-message filters. If the persona was called (@mention, reply, or name trigger), an ignore heuristic rolls against a base chance adjusted for bare pings, repeated tags, spam, and the caller's relationship score. Spontaneous turns fire from a chaotic timer or the per-message eavesdrop chance. The persona will not speak unprompted in a channel silent for more than `spontaneous.maxChannelSilenceHours` hours; a direct ping there is still answered.

The persona writes one reply at a time across the server. A ping in the same channel while it is already answering is missed; the missed messages are in the transcript when the next reply is built. A direct ping in another channel (an @mention or reply to its message, not a name trigger) is held, one per channel, in up to `mention.maxPending` channels for `mention.pendingMinutes` minutes; a newer ping in the same pending channel replaces the older one. When the current reply finishes, the persona switches channel after a short pause (`mention.switchDelayMs`) and answers from the conversation as it stands; the usual ignore chance applies. Name triggers and eavesdrop hits that arrive while busy are skipped. With `mention.oneAtATime: false` every channel is handled independently. The persona never writes or reacts where it lacks Send Messages, checking before it spends an LLM request; such channels are still read and remembered.

The turn collects the channel transcript and neighbouring channels, then builds one LLM request inside the token budget. Sections fill in priority order: system prompt and task are never cut; then the caller's profile, server habits and self-facts, the channel map, the transcript (newest first), other profiles, and neighbouring channels. The model sees a map of the server's channels (purpose, topics, tone, activity level), with the current channel marked.

The model responds with `<think>` (hidden planning), `<msg>` (1–3 chat messages; `reply="#87"` replies to a transcript line), `<react>` (one emoji reaction), or `<skip/>` (silence). After parsing, typing is simulated at human speed and `@nick` in the output becomes a real mention.

The memory analyzer runs as a separate LLM call when enough messages accumulate. It receives the character card and judges each person through the character's eyes, returning attitude deltas, profile changes, channel observations, and server-level notes. The portrait of a member's character and manner of speech is drawn from the channels in `memory.mainChannelIds`; when the list is empty, every channel counts. Profiles are updated incrementally: the analyzer returns only what changed, and stored facts are never re-summarised. Character and style are prose paragraphs written whole by the profile prompt at bootstrap and refreshed from recent messages when the analyzer flags a gap or contradiction. Interests and details are separate items that become confirmed when they come up again on a separate occasion; more items are kept per person than shown, ranked by frequency and recency with a weight that decays over time. Interests not seen for a long time are shown to the persona as old. Stored memory refers to members by id and the current name is substituted when the memory is used, so renames never break stored notes. The persona also learns what people in chat call each other and recognises a member mentioned by name or alias even when they are not in the conversation.

## Episodes and lorebook

The memory analyzer writes two kinds of long-term notes beyond profiles.

Episodes are moments the persona remembers about individual people: an insult, a kindness, a promise, a bet, a shared joke, something someone asked the persona to do or never do. The analyzer appends them to the person's profile with a date, a short description, sometimes the person's own words, and a weight from 1 to 5. The heaviest survive longest; when a profile hits `memory.maxEpisodes`, the lightest are evicted first, then the oldest. Only the caller's episodes are shown, inside the `<people>` block.

The lorebook stores server-wide knowledge that outlives any conversation: events, recurring characters, long-running stories, feuds, traditions. Each entry has a title, a set of keywords and a short text. The code scans the last `lore.scanMessages` messages for keyword matches and includes up to `lore.maxMatches` entries in a `<lore>` block; entries marked `always` appear every time. Hundreds of entries can exist at negligible cost because only the matching few are shown.

The analyzer adds and updates lorebook entries on its own but never touches entries added by the owner through `/nep lore` commands. Lorebook data lives in `data/guilds/<id>/lore.json`.

## Vision and media

Transcript lines carry media markers in brackets: pictures, GIFs, videos, stickers, custom emoji, voice messages, audio files, links, text file previews and forwarded messages. Forwarded messages from another channel of the same server name the source channel. What the persona perceives depends on two features.

`features.vision` attaches pictures from the calling message, from the message it replies to, and the newest few in the channel to the LLM request as images, downscaled through Discord's media proxy. The bot downloads every picture itself and sends it inline as data, because Discord refuses downloads coming from the model provider; pictures larger than `context.vision.maxBytes` or slower than `context.vision.fetchTimeoutMs` are skipped. The persona sees these directly. Settings live under `context.vision`.

`features.mediaDescriptions` (off by default) runs a helper model (`media.model`) that writes a one-line description for pictures, GIF frames, video posters, stickers, custom emoji and link thumbnails. Each attachment is described once and cached. Descriptions feed the chat transcript, the memory analyzer and the bootstrap, whose token budget pays for bootstrap descriptions. The describer's prompt is `prompts/describe.md`. Settings live under `media`.

Stickers and custom emoji recur constantly, so they are cached by id and cost nearly nothing after the first description. With `features.vision`, the sticker of the calling message is attached as a picture. Discord's built-in animated stickers are Lottie animations, not images, so they are never more than a name.

A `<senses>` block in the user message tells the persona what it can and cannot perceive under the current config. The persona trusts this block and never claims to have seen, heard or opened anything beyond it.

The persona can't watch videos or listen to audio; it gets a name, a duration, and at best a one-frame description. Voice messages show only duration. Links show the site, the title and a snippet from Discord's embed, never the page itself.

## Cost and privacy

Each turn is one LLM request; a memory update adds a second. Cost depends on the model and endpoint; `llm.model` and `llm.baseUrl` accept any compatible values. The daily cap (`llm.maxRequestsPerDay`) prevents runaway spending.

`data/` holds per-member profiles, relationship scores, channel observations and server patterns. It stays on your machine, is gitignored, and is only sent to the LLM as context. The analyzer is instructed not to store sensitive details. `/nep memory forget` deletes a profile entirely.

Tell your server members. They should know their messages are processed by an LLM and that the bot keeps notes.

## Running as a service

An example systemd unit is in `deploy/neptunia-bot.service`. Adjust `WorkingDirectory` and `User`, then install:

```bash
sudo cp deploy/neptunia-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now neptunia-bot
```

The private layer lives alongside the code: `.env`, `config.local.json`, `prompts.local/`, `data/`. To update:

```bash
git pull && sudo systemctl restart neptunia-bot
```

A restart loses nothing; all state is on disk. Restarts are only needed after code changes under `src/`. Prompt and config edits apply live.

Memory lives in the process and is written to `data/`; editing those files under a running bot is unsafe because the next write overwrites the change. To edit memory by hand: `/nep pause`, edit the files, `/nep resume`. The pause stops all activity, flushes memory to disk and unloads it; a running bootstrap pauses after the current request. The state is persisted: a restart comes back paused, and the bootstrap does not auto-start until resume. `/nep resume` validates every JSON file under `data/` and refuses if any do not parse, naming the broken ones; otherwise it reloads memory and continues, including a bootstrap from where it left off. Read-only and config commands work while paused; commands that write memory are refused. `/nep status` shows the paused state.

## Tests

```bash
npm test
```

Runs with `node --test`. No network or Discord connection needed.

## Project structure

```
config.json                defaults for every setting, hot-reloaded
.env.example               template for DISCORD_TOKEN and OPENROUTER_API_KEY
prompts/
  system-prompt.md         how to pass for a human chat member
  character-card.md        the personality (working example)
  rules.md                 owner's live corrections
  format.md                output tags the model uses
  reply.md                 task: someone called you
  interject.md             task: jump into a conversation
  initiate.md              task: start a topic
  memory.md                prompt for the memory analyzer
  describe.md              prompt for the media describer
  profile.md               bootstrap: one member's profile from a message sample
  channel.md               bootstrap: channel notes from a message sample
  server.md                bootstrap: server-level notes from channel notes and member summaries
  labels.json              every code-inserted string in prompts
prompts.local/             your personality (gitignored)
src/
  index.js                 entry point, wiring, timers, shutdown
  config.js                .env parser, config loader, deepMerge
  hot.js                   live config + prompts via fs.watch
  log.js                   structured JSON logging
  admin.js                 owner commands
  llm/
    tokens.js              token estimation with self-calibration
    budget.js              priority-ordered section trimming
    openrouter.js          chat completions, safety rails
    parse.js               output tags to actions
  discord/
    guild.js               single-guild resolution
    commands.js            slash commands, registration, interaction adapter
    events.js              message pipeline
    collect.js             channel history, neighbours, permissions
    format.js              transcript lines, time gaps, tempo
  behavior/
    mention.js             call detection, ignore heuristics
    prompt.js              request builder with token budget
    turn.js                one turn: collect, build, call, act
    spontaneous.js         chaotic timer, eavesdrop
  memory/
    store.js               JSON file persistence, atomic writes
    update.js              batch memory updates
    affinity.js            relationship score logic
    interests.js           remembered interests: sightings, confirmation, eviction
    details.js             remembered details: sightings, confirmation, eviction
    channels.js            channel map rendering, activity verdicts
    bootstrap.js           sample-based memory bootstrap
tests/                     node --test, pure-function unit tests
deploy/
  neptunia-bot.service     example systemd unit
data/                      persistent state (gitignored, created at runtime)
  guilds/<id>/users/       per-member profiles and relationships
  guilds/<id>/channels/    channel observations from the analyzer
  guilds/<id>/lore.json    lorebook entries
```
