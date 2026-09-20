# neptunia-bot

*A generic engine for a Discord pseudo-user with a pluggable personality.*

## About

A pseudo-user is a bot that lives in your Discord server as one more member. It answers some pings and ignores others, cuts into conversations at chaotic intervals, starts topics when the chat is dead, remembers everyone, holds grudges and favourites, and talks in whatever voice you write for it.

Discord shows an APP badge next to bot accounts -- the point is behaviour and voice, not deception of the platform. This is meant for a server whose members know, or will enjoy finding out.

Node.js, one runtime dependency (discord.js), any OpenRouter-compatible endpoint. Ship it with the included example character or write your own -- no code changes needed. Each instance serves one server, one bot account, one personality. To run a second server or a second character, spin up a second copy with its own `.env`, `config.local.json`, `prompts.local/` and `data/`.

## What it does

- **Calls and ignoring.** Responds to @mentions, replies to its messages, and name triggers. Ignores some on purpose: bare pings more often, repeated tags even more, spam almost always. People it dislikes get ignored slightly more; people it likes, slightly less.
- **Context.** Reads the last 100 messages from the current channel and up to 5 fresh ones from each neighbouring channel. Time gaps are spelled out in the transcript so the model can tell a live conversation from a dead one that somebody poked.
- **Reply length.** Mostly 1--5 words. Sometimes a sentence or two. Rarely up to about a hundred words. Can send 2--3 short messages in a row, drop a single emoji reaction with no text, or stay silent.
- **Spontaneous messages.** A chaotic timer fires at random intervals within configurable active hours. When it fires, the bot either cuts into a live conversation or starts a topic in a dead channel. A separate eavesdrop chance lets it jump into any message at any time. It never responds to itself.
- **Memory.** Per-member profiles (character, interests, communication style, relationship with the bot), a map of the server's channels (what each is for, what people write about, the tone -- by the analyzer; alive/slow/dead -- counted by code from real message statistics), server-level patterns (conversation starters, running jokes), and a record of what it has claimed about itself. Updated in batches by a separate LLM call.
- **Relationships.** Each member carries an attitude score from -100 to 100, judged through the character's eyes by the memory analyzer. Changes are small and gradual. The score never appears in chat -- it shows only in how willing the bot is to engage and how warmly it lands. It also nudges the chance of ignoring a ping.
- **Hard limits.** 50,000 tokens per request with a self-calibrating estimate that adjusts against real usage. A daily request cap covers all activity.
- **Hot reload.** Edit a prompt file or config and save -- changes apply to the next message, no restart, memory untouched.
- **Owner console.** Commands sent in a DM or channel for live tuning: add behaviour rules, override config values, inspect and delete profiles, adjust relationships, force a spontaneous message.
- **Dry run.** A mode that runs the full pipeline -- triggers, memory, LLM calls -- but never sends a message or reaction. Would-be output goes to the log and an optional mirror channel, so you can watch the bot think before you let it talk.

## Quick start

Requires Node.js 20 or later.

Create a Discord application at [discord.com/developers](https://discord.com/developers/applications). On the Bot page, enable the **Message Content** privileged intent. Invite the bot to your server with permissions to read message history, send messages, and add reactions.

Get an API key from [OpenRouter](https://openrouter.ai/keys) (or any compatible endpoint).

```bash
git clone https://github.com/leinstay/neptunia-bot.git
```

```bash
cd neptunia-bot && npm install
```

```bash
cp .env.example .env
```

Edit `.env` and fill in your Discord token and API key. Then create `config.local.json` with your Discord user ID so you can use owner commands:

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

The bot locks to a single server. When `bot.guildId` is empty and the bot is in exactly one server, it adopts that server automatically. If the bot is in several servers, it refuses to start and lists them -- set `bot.guildId` in `config.local.json` to pick one. It runs out of the box with the included example character.

## Make it yours

### Two prompt layers

Prompts load from two directories:

- **`prompts/`** -- tracked engine defaults (English, generic). Ships with a working example character.
- **`prompts.local/`** -- your personality (gitignored). A file here replaces the same-named file in `prompts/`. `labels.json` is deep-merged, so you only need the keys you change.

Both are hot-reloaded. You never need to edit the tracked files.

### Prompt files

| File | Required | Purpose |
|---|---|---|
| `system-prompt.md` | yes | How to pass for a human chat member -- voice, boundaries, behaviour. Character-agnostic |
| `character-card.md` | yes | The personality: who they are, how they talk, what they care about |
| `rules.md` | no | Owner's live corrections, appended by `!nep rule` |
| `format.md` | yes | Output protocol -- the tags the model uses to act |
| `reply.md` | yes | Task prompt: someone addressed the persona |
| `interject.md` | yes | Task prompt: cut into a live conversation uninvited |
| `initiate.md` | yes | Task prompt: break a silence, start a topic |
| `memory.md` | yes | Technical prompt for the memory and relationship analyzer |
| `labels.json` | yes | Every string the code inserts into prompts (deep-merged between layers) |

**The only file you must rewrite is `character-card.md`.** Copy it to `prompts.local/character-card.md` and write your persona from scratch. Everything else works as-is, or override individual files as needed.

### Language

Write your prompts in the language the character speaks. Translate `labels.json` too -- copy the default to `prompts.local/labels.json`, change the `locale` and the values, so the entire prompt the model reads is one language.

### Relationships and the character card

The memory analyzer also judges how the character feels about people. It receives your character card and uses it to decide what earns and costs points. Include a section in your card that describes what your character likes and dislikes in people -- that section drives the relationship scores.

### Tips for a convincing character

The system prompt handles the mechanics of sounding human, so your card is purely personality. Give the character opinions and a default mood rather than making them agreeable. Keep reference lines short and varied -- they anchor the model's style over long conversations. Write the card in the character's voice, not in third person. Make sure profanity carries meaning, not filler. And make silence a real option -- a character that always answers everything is the most obvious bot tell.

## Configuration

`config.json` holds every setting with its default. `config.local.json` (gitignored) is deep-merged over it. Both are hot-reloaded -- edit and save, the next message uses the new values.

### `features`

Every feature is an independent toggle.

| Key | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Run the full pipeline but never send -- the one switch that defaults to OFF (see [Testing it invisibly](#testing-it-invisibly)) |
| `mentions` | `true` | Respond to @mentions |
| `replies` | `true` | Respond to replies to the bot's messages |
| `nameTriggers` | `true` | Respond when someone says the bot's name |
| `spontaneous` | `true` | Send messages unprompted on a chaotic timer |
| `eavesdrop` | `true` | Small chance to jump into any message |
| `memory` | `true` | Remember people, server patterns, own claims |
| `relationships` | `true` | Track per-member attitude scores (-100..100) |
| `reactions` | `true` | Allow emoji reactions in output |
| `multiMessage` | `true` | Allow 2--3 messages in a row |
| `vision` | `true` | Read images attached to messages |
| `typingSimulation` | `true` | Simulate human typing speed |
| `adminCommands` | `true` | Enable owner commands |

### `bot`

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `"UTC"` | Timezone for timestamps the model sees |
| `owners` | `[]` | Discord user IDs that can use owner commands |
| `commandPrefix` | `"!nep"` | Prefix for owner commands |
| `nameTriggers` | `[]` | Extra strings that trigger a response besides @mention |
| `guildId` | `""` | The server this instance runs. When empty and the bot is in one server, adopts it; in several, refuses to start. Pin it in `config.local.json` |
| `dryRunChannelId` | `""` | Private channel for dry-run mirror output (see [Testing it invisibly](#testing-it-invisibly)) |
| `channels.allow` | `[]` | Limit to these channel IDs (empty = all visible) |
| `channels.deny` | `[]` | Ignore these channel IDs |

### `llm`

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | Chat completions endpoint |
| `model` | `"anthropic/claude-opus-4.6"` | Model ID (any model available on your endpoint) |
| `temperature` | `1` | Sampling temperature |
| `maxOutputTokens` | `700` | Max tokens in the model's response |
| `maxRequestTokens` | `50000` | Hard cap on tokens per request |
| `safetyMargin` | `0.9` | Fraction of maxRequestTokens actually used for budgeting |
| `timeoutMs` | `90000` | Request timeout (ms) |
| `retries` | `2` | Retries on transient failures |
| `maxRequestsPerDay` | `300` | Daily request cap across all activity |

### `context`

| Key | Default | Meaning |
|---|---|---|
| `channelMessages` | `100` | Messages from the current channel |
| `neighborMessages` | `5` | Messages per neighbouring channel |
| `neighborMaxAgeMinutes` | `60` | Ignore neighbour messages older than this |
| `neighborMaxChannels` | `8` | Max neighbouring channels to include |
| `maxMessageChars` | `800` | Truncate individual messages beyond this length |
| `gapMarkerMinutes` | `20` | Insert a time-gap marker when messages are this far apart |
| `otherProfiles` | `6` | Max profiles of other people present in the transcript |
| `tempo.liveMessages10min` | `4` | Messages in 10 minutes for the channel to count as "live" in `<tempo>` |
| `tempo.deadSilenceMinutes` | `45` | Minutes of silence for the channel to count as "dead" in `<tempo>` |
| `caps.interlocutor` | `2500` | Token cap for the caller's profile |
| `caps.aboutChat` | `2500` | Token cap for server habits and self-facts |
| `caps.people` | `4000` | Token cap for other profiles |
| `caps.neighbors` | `3000` | Token cap for neighbouring channels |
| `caps.server` | `2500` | Token cap for the channel map |
| `channelActivity.liveMessagesPerDay` | `20` | Daily message count for a channel to be "active" in `<server>` |
| `channelActivity.deadAfterDays` | `7` | Days without a message before a channel is "dead" in `<server>` |
| `vision.maxImages` | `2` | Images per request |
| `vision.tokensPerImage` | `1600` | Token budget reserved per image |

### `mention`

| Key | Default | Meaning |
|---|---|---|
| `ignoreChance` | `0.12` | Base chance of ignoring a direct call |
| `emptyMentionIgnoreChance` | `0.35` | Ignore chance for a bare @mention with no text |
| `repeatWindowMinutes` | `10` | Window for tracking repeated calls from one person |
| `repeatPenalty` | `0.25` | Added to ignore chance per repeated call in the window |
| `spamThreshold` | `4` | Calls in the window that count as spam |
| `spamIgnoreChance` | `0.9` | Ignore chance when spammed |
| `nameTriggerChance` | `0.5` | Chance of reacting to a name trigger |
| `neverIgnore` | `[]` | User IDs that are never ignored |
| `affinityIgnoreBonus` | `0.3` | Max added ignore chance at affinity -100 |
| `affinityLikeBonus` | `0.08` | Max reduced ignore chance at affinity +100 |

### `typing`

| Key | Default | Meaning |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | Delay range before a reaction (ms) |
| `msPerChar` | `[35, 75]` | Typing speed range per character |
| `minMs` | `900` | Minimum typing duration |
| `maxMs` | `12000` | Maximum typing duration |
| `betweenMessagesMs` | `[700, 3500]` | Pause between consecutive messages |

### `spontaneous`

| Key | Default | Meaning |
|---|---|---|
| `channels` | `[]` | Channel IDs where spontaneous messages are allowed |
| `minIntervalMinutes` | `25` | Minimum time between spontaneous checks |
| `maxIntervalMinutes` | `420` | Maximum time between spontaneous checks |
| `burstChance` | `0.15` | Chance of scheduling the next check sooner |
| `burstMinutes` | `[3, 15]` | Range for burst follow-up timing (min) |
| `activeHours` | `{ from: 10, to: 3 }` | Hours when spontaneous activity runs (wraps past midnight) |
| `liveWindowMinutes` | `15` | How recent messages must be for a channel to count as live |
| `liveMinMessages` | `4` | Minimum messages in the live window |
| `deadAfterMinutes` | `90` | Silence threshold for a dead channel |
| `initiateChance` | `0.35` | When the timer fires, chance of starting a topic vs interjecting |
| `eavesdropChance` | `0.02` | Per-message chance of jumping in uninvited |
| `eavesdropDelayMs` | `[5000, 40000]` | Delay range before an eavesdrop response (ms) |
| `minGapMinutes` | `12` | Minimum gap between any two spontaneous actions |

### `memory`

| Key | Default | Meaning |
|---|---|---|
| `model` | `null` | Model for memory updates (`null` = same as `llm.model`) |
| `batchMessages` | `60` | Ideal batch size for memory updates |
| `minBatchMessages` | `15` | Minimum messages before a memory update runs |
| `maxBatchAgeMinutes` | `180` | Force an update when the oldest buffered message is this old |
| `maxOutputTokens` | `4000` | Max tokens in the analyzer's response |
| `fieldChars` | `400` | Max characters per profile field |
| `maxDetails` | `15` | Max detail items per profile |
| `maxInjokes` | `15` | Max server in-jokes |
| `maxSelfFacts` | `20` | Max recorded self-claims |

### `relationships`

| Key | Default | Meaning |
|---|---|---|
| `maxDeltaPerUpdate` | `15` | Max attitude change per memory update |
| `historySize` | `10` | Recent attitude changes kept per member |
| `directTriggerCount` | `6` | Direct interactions in the buffer that force an early memory update |

## Warm-up

With `warmup.enabled: true`, the bot reads channel history before it says a word. It feeds each channel's messages oldest-first through the memory analyzer in large batches, building profiles, attitudes, the channel map and in-jokes before it ever speaks. The bot stays mute until warm-up finishes -- it still observes incoming messages and owner commands still work.

The token budget `warmup.maxTokens` is counted from the provider's reported usage. Warm-up is exempt from `llm.maxRequestsPerDay` (it has its own rail), but the per-request token cap still applies. Progress is saved after every batch, so a restart picks up where it left off and never re-reads the same messages. Three failed batches in a row abort the warm-up without leaving the bot mute forever.

### `warmup`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Run the warm-up before the bot starts talking |
| `maxTokens` | `1000000` | Total token budget for the warm-up (input + output) |
| `messagesPerChannel` | `2000` | Max messages to read per channel |
| `batchMessages` | `150` | Messages per analyzer batch |
| `maxAgeDays` | `0` | Ignore messages older than this (0 = no limit) |
| `channels` | `[]` | Channel IDs to warm up (empty = all readable channels) |

**Cost note.** The warm-up budget is real money at the analyzer model's price. `memory.model` can point the analyzer -- and therefore the warm-up -- at a cheaper model than the one that talks.

## Testing it invisibly

With `features.dryRun: true` the bot does everything for real -- warm-up, memory updates, relationship changes, trigger decisions, LLM requests (so it costs real tokens) -- but never types, sends or reacts in the chat. Every would-be message and reaction goes to the log (`dry-run: would send` / `dry-run: would react` -- the one place message text is logged). When `bot.dryRunChannelId` points at a private channel, a readable mirror is posted there without pinging anyone; messages in that mirror channel are ignored by the bot. It still paces itself as if it had spoken.

Suggested first run on a new server: turn on `warmup.enabled` and `features.dryRun`, watch the mirror channel or `journalctl -u neptunia-bot -f`, tune the character and the numbers live, then switch dry-run off with `!nep set features.dryRun false` -- no restart needed. `!nep status` shows the dry-run state on its first line.

## Tuning it live

Edit a prompt or config file and save. The change applies to the next message -- no restart, no lost memory.

### Owner commands

Send these in a DM to the bot or in any channel. The answer always comes by DM. In a channel, a checkmark or cross reaction confirms whether it worked.

| Command | What it does |
|---|---|
| `help` | Show the command list |
| `rule <text>` | Append a behaviour rule to `prompts.local/rules.md` |
| `rules` | List current rules, numbered |
| `unrule <n>` | Remove rule #n |
| `set <dotted.path> <json>` | Override a config value (writes to `config.local.json`) |
| `unset <dotted.path>` | Remove a config override |
| `reload` | Force-reload config and prompts now |
| `status` | Model, calibration ratio, daily quota, per-guild stats |
| `poke [interject\|initiate] [channel]` | Force a spontaneous message |
| `memory <@user\|id>` | Show a stored profile |
| `affinity <@user\|id> [score] [reason]` | Show a member's standing, or set it exactly (-100..100) |
| `forget <@user\|id>` | Delete a stored profile |
| `warmup` | Show warm-up status |
| `warmup run` | Start the warm-up now |
| `warmup reset` | Clear the progress marker (memory untouched) |

`rule` is the fastest way to correct behaviour on the fly -- the note lands in `prompts.local/rules.md` and is picked up immediately.

### What needs a restart

Only changes to code under `src/`. A restart loses nothing -- all state lives in files on disk.

## How it works

A message arrives and passes through guild and channel filters, then bot and self-message filtering. If the persona was called -- by @mention, reply, or name trigger -- an ignore heuristic rolls against a base chance adjusted for bare pings, repeated tags, spam, and the caller's relationship score. Spontaneous turns fire from a chaotic timer or the per-message eavesdrop chance instead.

The turn collects the channel transcript and neighbouring channels, then builds one LLM request inside the token budget. The model sees a map of the server's channels -- what each is for, what people write there, the tone, how alive each one is -- with the current channel marked. Sections are fitted in priority order: system prompt (character card + rules + output format), the task, clock and tempo are never cut; then the caller's profile, server habits and self-facts, the channel map, the channel transcript newest-first, other profiles, and neighbouring channels. In the rendered prompt, reference material comes first and the live chat with the task come last, where the model attends best.

The model responds with these tags:

- `<think>` -- hidden planning, 1--4 lines, never shown
- `<msg>` -- a chat message (1--3 for a burst); `reply="#87"` replies to a specific transcript line
- `<react to="#87">` -- a single emoji reaction
- `<skip/>` -- silence

After parsing, the code simulates typing at human speed and sends. `@nick` in the output is resolved to a real Discord mention.

The memory analyzer runs as a separate LLM call when enough messages have accumulated or when enough direct interactions have happened. It receives the character card, judges each person through the character's eyes, and returns small attitude deltas, updated profiles, channel observations (what each is for, what people write about, the tone), server-level notes, and any new self-facts.

## Cost and safety

Each turn is one LLM request. A memory update, when triggered, adds a second. Typical chat context stays well below the 50k token cap. Cost per request depends on the model -- `llm.model` accepts any model ID on your endpoint, and `llm.baseUrl` can point to any OpenRouter-compatible API. The daily cap (`llm.maxRequestsPerDay`) prevents runaway spending.

**Privacy.** `data/` holds notes about real people and channels -- profiles, relationship scores, channel observations, server patterns (`data/guilds/<id>/users/`, `data/guilds/<id>/channels/`). It stays on your machine, is gitignored, and is never sent anywhere except to the LLM as context for the next reply. The analyzer is instructed not to store sensitive details (addresses, documents, health, finances). `!nep forget <@user>` deletes a profile entirely.

Tell your server members. They should know their messages are processed by an LLM and that the bot keeps notes about them.

## Running as a service

An example systemd unit is in `deploy/neptunia-bot.service`. Adjust `WorkingDirectory` and `User` to match your setup, then install:

```bash
sudo cp deploy/neptunia-bot.service /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload
```

```bash
sudo systemctl enable --now neptunia-bot
```

On the server, the private layer lives alongside the code: `.env`, `config.local.json`, `prompts.local/`, and `data/`. To update:

```bash
git pull
```

```bash
sudo systemctl restart neptunia-bot
```

A restart is only needed after code changes under `src/`. Prompt and config edits are picked up live.

## Tests

```bash
npm test
```

Runs with `node --test`. No network, no Discord connection needed.

## Project structure

```
config.json                defaults for every setting, hot-reloaded
.env.example               template for DISCORD_TOKEN and OPENROUTER_API_KEY
prompts/
  system-prompt.md         how to pass for a human chat member
  character-card.md        the personality (example -- rewrite this one)
  rules.md                 owner's live corrections
  format.md                output tags the model uses
  reply.md                 task: someone called you
  interject.md             task: jump into a conversation
  initiate.md              task: start a topic
  memory.md                prompt for the memory analyzer
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
    channels.js            channel map rendering, activity verdicts
    warmup.js              pre-talk channel history ingestion
tests/                     node --test, pure-function unit tests
deploy/
  neptunia-bot.service     example systemd unit
data/                      persistent state (gitignored, created at runtime)
  guilds/<id>/users/       per-member profiles and relationships
  guilds/<id>/channels/    channel observations from the analyzer
```

## License

[MIT](LICENSE)
