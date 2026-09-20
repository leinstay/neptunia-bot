# neptunia-bot

A generic engine for a Discord pseudo-user with a pluggable personality.

Node.js 20+, one dependency (discord.js), any OpenRouter-compatible endpoint. Ships with a working example character; write your own without touching code. Each instance serves one server, one bot account, one personality. For a second server or character, run a second copy with its own `.env`, `config.local.json`, `prompts.local/` and `data/`.

Discord marks bot accounts with an APP badge. The engine does not disguise that; the goal is behaviour and voice.

The persona responds to mentions, replies and name triggers, sometimes ignoring them. It cuts into conversations at random intervals and starts topics in dead channels. It remembers people, tracks attitudes from -100 to 100, and lets those shape how it engages -- the score never appears in chat. All config and prompts are hot-reloaded; owner commands tune the bot live from Discord.

## Quick start

Create a Discord application at [discord.com/developers](https://discord.com/developers/applications). Enable the **Message Content** privileged intent on the Bot page. Invite the bot with permissions to read message history, send messages, and add reactions.

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

When `bot.guildId` is empty and the bot is in exactly one server, it locks to that server automatically. If the bot is in several servers, it refuses to start -- set `bot.guildId` in `config.local.json`.

## Prompt layers

Prompts load from two directories:

- **`prompts/`** -- tracked engine defaults (English). Ships with a working example character.
- **`prompts.local/`** -- your personality (gitignored). A file here replaces the same-named file in `prompts/`. `labels.json` is deep-merged, so you only override the keys you change.

Both are hot-reloaded.

### Prompt files

| File | Required | Purpose |
|---|---|---|
| `system-prompt.md` | yes | How to pass for a human chat member. Character-agnostic |
| `character-card.md` | yes | The personality: who they are, how they talk, what they care about |
| `rules.md` | no | Owner's live corrections, appended by `!nep rule` |
| `format.md` | yes | Output protocol -- tags the model uses to act |
| `reply.md` | yes | Task: someone addressed the persona |
| `interject.md` | yes | Task: cut into a live conversation |
| `initiate.md` | yes | Task: break a silence, start a topic |
| `memory.md` | yes | Technical prompt for the memory/relationship analyzer |
| `labels.json` | yes | Every string the code inserts into prompts (deep-merged between layers) |

**The only file you must rewrite is `character-card.md`.** Copy it to `prompts.local/` and write your persona. Everything else works as-is, or override individual files as needed.

Write your prompts in the language the character speaks. Translate `labels.json` too -- copy it to `prompts.local/`, change the `locale` and values, so the model reads one language throughout.

The memory analyzer judges how the character feels about people. It receives your character card, so include what your character likes and dislikes -- that drives the relationship scores.

### Tips

The system prompt handles sounding human, so the card is purely personality. Give the character opinions and a default mood rather than agreeability. Keep reference lines short and varied -- they anchor style over long conversations. Write the card in the character's voice. Make profanity carry meaning, not fill space. Make silence a real option -- a character that always answers is the most obvious bot tell.

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
| `reactions` | `true` | Emoji reactions |
| `multiMessage` | `true` | Allow 2--3 messages in a row |
| `vision` | `true` | Process attached images |
| `typingSimulation` | `true` | Simulate typing speed |
| `adminCommands` | `true` | Owner commands via DM or channel |

### `bot`

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `"UTC"` | Timezone for model timestamps |
| `owners` | `[]` | User IDs for owner commands |
| `commandPrefix` | `"!nep"` | Owner command prefix |
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
| `retries` | `2` | Retries on transient failures |
| `maxRequestsPerDay` | `300` | Daily request cap |

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
| `caps.interlocutor` | `2500` | Token cap: caller's profile |
| `caps.aboutChat` | `2500` | Token cap: server habits / self-facts |
| `caps.people` | `4000` | Token cap: other profiles |
| `caps.neighbors` | `3000` | Token cap: neighbour channels |
| `caps.server` | `2500` | Token cap: channel map |
| `channelActivity.liveMessagesPerDay` | `20` | Daily messages = "active" channel |
| `channelActivity.deadAfterDays` | `7` | Days without messages = "dead" channel |
| `vision.maxImages` | `2` | Images per request |
| `vision.tokensPerImage` | `1600` | Token budget per image |

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
| `batchMessages` | `60` | Ideal batch size |
| `minBatchMessages` | `15` | Min messages before update |
| `maxBatchAgeMinutes` | `180` | Force update after (min) |
| `maxOutputTokens` | `4000` | Max analyzer output tokens |
| `fieldChars` | `400` | Profile field limit (chars) |
| `maxDetails` | `15` | Max detail items per profile |
| `maxInjokes` | `15` | Max server in-jokes |
| `maxSelfFacts` | `20` | Max self-claims |

### `relationships`

| Key | Default | Meaning |
|---|---|---|
| `maxDeltaPerUpdate` | `15` | Max score change per update |
| `historySize` | `10` | Attitude changes kept per member |
| `directTriggerCount` | `6` | Direct interactions that force early update |

## Warm-up

With `warmup.enabled: true`, the bot reads channel history before speaking. It feeds messages oldest-first through the memory analyzer in large batches, building profiles, attitudes, the channel map and in-jokes. The bot stays mute until warm-up finishes; incoming messages are still observed and owner commands work.

The budget `warmup.maxTokens` is counted from the provider's reported usage. Warm-up is exempt from `llm.maxRequestsPerDay` but the per-request cap applies. Progress persists across restarts. Three failed batches in a row abort without leaving the bot mute.

**Cost note.** The warm-up budget is real money. Set `memory.model` to a cheaper model for the analyzer and warm-up.

### `warmup`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Warm up before talking |
| `maxTokens` | `1000000` | Token budget (input + output) |
| `messagesPerChannel` | `2000` | Max messages to read per channel |
| `batchMessages` | `150` | Messages per analyzer batch |
| `maxAgeDays` | `0` | Max message age in days (0 = unlimited) |
| `channels` | `[]` | Channels to warm up (empty = all readable) |

## Dry run

With `features.dryRun: true` the bot runs the full pipeline -- warm-up, memory, triggers, LLM calls -- but never sends a message or reaction. Output goes to the log (`dry-run: would send` / `dry-run: would react`). Set `bot.dryRunChannelId` to a private channel for a readable mirror; messages in that channel are ignored by the bot.

First run on a new server: enable `warmup.enabled` and `features.dryRun`, watch the mirror or `journalctl -u neptunia-bot -f`, tune live, then `!nep set features.dryRun false`.

## Owner commands

Send in a DM or channel. Replies come by DM; in a channel, a checkmark or cross reaction confirms the result.

| Command | What it does |
|---|---|
| `help` | Show the command list |
| `rule <text>` | Append a rule to `prompts.local/rules.md` |
| `rules` | List current rules, numbered |
| `unrule <n>` | Remove rule #n |
| `set <dotted.path> <json>` | Override a config value (writes to `config.local.json`) |
| `unset <dotted.path>` | Remove a config override |
| `reload` | Force-reload config and prompts |
| `status` | Model, calibration, daily quota, per-guild stats |
| `poke [interject\|initiate] [channel]` | Force a spontaneous action |
| `memory <@user\|id>` | Show a stored profile |
| `affinity <@user\|id> [score] [reason]` | Show or set attitude (-100..100) |
| `forget <@user\|id>` | Delete a stored profile |
| `warmup` | Show warm-up status |
| `warmup run` | Start warm-up regardless of warmup.enabled |
| `warmup reset` | Clear warm-up progress (memory untouched) |

## How a turn works

A message passes through guild, channel and self-message filters. If the persona was called -- @mention, reply, or name trigger -- an ignore heuristic rolls against a base chance adjusted for bare pings, repeated tags, spam, and the caller's relationship score. Spontaneous turns fire from a chaotic timer or the per-message eavesdrop chance.

The turn collects the channel transcript and neighbouring channels, then builds one LLM request inside the token budget. Sections fill in priority order: system prompt and task are never cut; then the caller's profile, server habits and self-facts, the channel map, the transcript (newest first), other profiles, and neighbouring channels. The model sees a map of the server's channels -- purpose, topics, tone, activity level -- with the current channel marked.

The model responds with `<think>` (hidden planning), `<msg>` (1--3 chat messages; `reply="#87"` replies to a transcript line), `<react>` (one emoji reaction), or `<skip/>` (silence). After parsing, typing is simulated at human speed and `@nick` in the output becomes a real mention.

The memory analyzer runs as a separate LLM call when enough messages accumulate. It receives the character card and judges each person through the character's eyes, returning small attitude deltas, updated profiles, channel observations, and server-level notes.

## Cost and privacy

Each turn is one LLM request; a memory update adds a second. Cost depends on the model and endpoint -- `llm.model` and `llm.baseUrl` accept any compatible values. The daily cap (`llm.maxRequestsPerDay`) prevents runaway spending.

**Privacy.** `data/` holds per-member profiles, relationship scores, channel observations and server patterns. It stays on your machine, is gitignored, and is only sent to the LLM as context. The analyzer is instructed not to store sensitive details. `!nep forget <@user>` deletes a profile entirely.

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
