<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.png">
    <img src=".github/assets/banner.png" width="700" alt="Neptunia - AI character engine for Discord">
  </picture>
</p>
<p align="center">English | <a href="docs/zh/README.md">中文</a> | <a href="docs/ja/README.md">日本語</a> | <a href="docs/ru/README.md">Русский</a></p>
<p align="center">
  <a href="https://github.com/leinstay/neptunia-bot/stargazers"><img src="https://img.shields.io/github/stars/leinstay/neptunia-bot" alt="GitHub stars"></a>
  <a href="https://github.com/leinstay/neptunia-bot/forks"><img src="https://img.shields.io/github/forks/leinstay/neptunia-bot" alt="GitHub forks"></a>
  <a href="https://github.com/leinstay/neptunia-bot/issues"><img src="https://img.shields.io/github/issues/leinstay/neptunia-bot" alt="GitHub issues"></a>
  <a href="https://github.com/leinstay/neptunia-bot/pulls"><img src="https://img.shields.io/github/issues-pr/leinstay/neptunia-bot" alt="GitHub pull requests"></a>
  <a href="https://github.com/leinstay/neptunia-bot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/leinstay/neptunia-bot" alt="License"></a>
  <a href="https://github.com/leinstay/neptunia-bot/actions/workflows/test.yml"><img src="https://github.com/leinstay/neptunia-bot/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
</p>

---

Neptunia is a locally run Discord bot that plays one configurable character through an LLM, behaving like an ordinary chat member. Node.js 20+ with a single dependency (discord.js), any OpenRouter-compatible endpoint, a pluggable character card written without touching code, hot-reloaded prompts and config, per-member memory with attitudes and episodes, a server-wide lorebook, vision for attached pictures, one-line media descriptions from a helper model, owner slash commands for live tuning, and a dry-run mode. It ships with a working example character; write your own card for a different persona.

The persona responds to mentions, replies and name triggers, sometimes ignoring them. It cuts into conversations at random intervals and starts topics in dead channels. It remembers people, tracks attitudes from -100 to 100, and uses them in replies. The score never appears in chat. All config and prompts are hot-reloaded; owner commands tune the bot live from Discord.

Each instance serves one server, one bot account, one personality. For a second server or character, run a second copy with its own `.env`, `config.local.json`, `prompts.local/` and `data/`. Discord marks bot accounts with an APP badge; the engine does not disguise that.

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
| `system-prompt.md` | yes | How to behave like an ordinary chat member, character-agnostic |
| `character-card.md` | yes | The personality: who they are, how they talk, what they care about |
| `rules.md` | no | Owner's live corrections, appended by `/nep rule add` |
| `format.md` | yes | Output protocol: tags the model uses to act |
| `reply.md` | yes | Task: someone addressed the persona |
| `interject.md` | yes | Task: cut into a live conversation |
| `initiate.md` | yes | Task: break a silence, start a topic |
| `memory.md` | yes | Technical prompt for the memory/relationship analyzer |
| `describe.md` | yes | One-line media descriptions for the helper model |
| `address.md` | yes | Classifier: is an untagged message addressed to the persona |
| `profile.md` | yes | Warmup: one member's profile from a message sample |
| `channel.md` | yes | Warmup: channel notes from a message sample |
| `server.md` | yes | Warmup: server-level notes from channel notes and member summaries |
| `labels.json` | yes | Every string the code inserts into prompts (deep-merged between layers) |

**The only file you must rewrite is `character-card.md`.** Copy it to `prompts.local/` and write your persona. Everything else works as-is, or override individual files as needed.

The memory analyzer judges how the character feels about people. Both it and the warmup receive your character card and `rules.md`, so include what your character likes and dislikes; a live rule about voice or judgement shapes portraits and attitude the same way the card does.

The placeholders, `labels.json` keys, context blocks and output tags every prompt file may use are specified in [`docs/prompt-contract.md`](docs/prompt-contract.md); a change on one side changes the other.

### Tips

The system prompt handles sounding human, so the card is purely personality. Give the character opinions and a default mood rather than agreeability. Keep reference lines short and varied; they anchor style over long conversations. Write the card in the character's voice. Make profanity carry meaning, not fill space. Make silence a real option. A character that always answers is the most obvious bot tell.

## Configuration

`config.json` holds every setting with its default. `config.local.json` (gitignored) is deep-merged over it. Both are hot-reloaded. See [`docs/en/configuration.md`](docs/en/configuration.md) for the full reference of every key.

## Getting started with memory

On first start, when `warmup.enabled` is true and no profile exists, the engine runs a warmup that builds memory of people, channels and the server from a sample of recent messages. The total token spend is capped by `warmup.maxTokens`. The persona stays mute while the warmup runs. See [`docs/en/warmup.md`](docs/en/warmup.md) for the stages, progress, rails and owner commands.

## Dry run

With `features.dryRun: true` the bot runs the full pipeline (memory, triggers, LLM calls) but never sends a message or reaction. Output goes to the log (`dry-run: would send` / `dry-run: would react`). Set `bot.dryRunChannelId` to a private channel for a readable mirror; everything posted in that channel is ignored by the bot. Slash commands work in any channel, the mirror included, because they are not messages.

First run on a new server: enable `features.dryRun`, watch the mirror or `journalctl -u neptunia-bot -f`, tune live, then `/nep set features.dryRun false`.

## Owner commands

One Discord slash command, `/nep` (the name comes from `bot.commandName`). Guild commands, registered on start for the served server. Every answer is ephemeral; only the caller sees it, in whatever channel it was typed. See [`docs/en/owner-commands.md`](docs/en/owner-commands.md) for every subcommand and the access grants.

## How a turn works

A message passes through guild, channel and self-message filters. If the persona was called (@mention, reply, or name trigger), an ignore heuristic rolls against a base chance adjusted for bare pings, repeated tags, spam, and the caller's relationship score. After the persona answers someone, untagged messages in that channel for the next `mention.followUpMinutes` minutes are sent to a classifier on the `followUp` model role, defaulting to the media model, that decides whether they continue the exchange; three `no` in a row close the window. `features.followUp` switches it off. Spontaneous turns fire from a chaotic timer or the per-message eavesdrop chance. The persona will not speak unprompted in a channel silent for more than `spontaneous.maxChannelSilenceHours` hours; a direct ping there is still answered.

The persona writes one reply at a time across the server. A ping in the same channel while it is already answering is missed; the missed messages are in the transcript when the next reply is built. A direct ping in another channel (an @mention or reply to its message, not a name trigger) is held, one per channel, in up to `mention.maxPending` channels for `mention.pendingMinutes` minutes; a newer ping in the same pending channel replaces the older one. When the current reply finishes, the persona switches channel after a short pause (`mention.switchDelayMs`) and answers from the conversation as it stands; the usual ignore chance applies. Name triggers and eavesdrop hits that arrive while busy are skipped. With `mention.oneAtATime: false` every channel is handled independently. The persona never writes or reacts where it lacks Send Messages, checking before it spends an LLM request; such channels are still read and remembered.

The turn collects the channel transcript and neighbouring channels, then builds one LLM request inside the token budget. Sections fill in priority order: system prompt and task are never cut; then the caller's profile, server habits and self-facts, the channel map, the transcript (newest first), other profiles, and neighbouring channels. The model sees a map of the server's channels (purpose, topics, tone, activity level), with the current channel marked. Each channel entry also carries facts the code maintains: message count, first and last message, activity over the last 30 days and the top writers; the warmup fills them from the channel's history and live traffic keeps them current.

The model responds with `<think>` (hidden planning), `<msg>` (1–3 chat messages; `reply="#87"` replies to a transcript line), `<react>` (one emoji reaction), or `<skip/>` (silence). After parsing, typing is simulated at human speed and `@nick` in the output becomes a real mention.

The memory analyzer runs as a separate LLM call when enough messages accumulate. It receives the character card and judges each person through the character's eyes, returning attitude deltas, profile changes, channel observations, and server-level notes. The portrait of a member's character and manner of speech is drawn from the channels in `memory.mainChannelIds`; when the list is empty, every channel counts. Profiles are updated incrementally: the analyzer returns only what changed, and stored facts are never re-summarised. Character and style are prose paragraphs written whole by the profile prompt during the warmup and refreshed from recent messages when the analyzer flags a gap or contradiction. Interests and details are separate items that become confirmed when they come up again on a separate occasion; more items are kept per person than shown, ranked by frequency and recency with a weight that decays over time. Interests not seen for a long time are shown to the persona as old. Stored memory refers to members by id and the current name is substituted when the memory is used, so renames never break stored notes. The persona also learns what people in chat call each other and recognises a member mentioned by name or alias even when they are not in the conversation.

## Episodes and lorebook

The memory analyzer writes two kinds of long-term notes beyond profiles.

Episodes are moments the persona remembers about individual people: an insult, a kindness, a promise, a bet, a shared joke, something someone asked the persona to do or never do. The analyzer appends them to the person's profile with a date, a short description, sometimes the person's own words, and a weight from 1 to 5. The heaviest survive longest; when a profile hits `memory.maxEpisodes`, the lightest are evicted first, then the oldest. Only the caller's episodes are shown, inside the `<people>` block.

The lorebook stores server-wide knowledge that outlives any conversation: events, recurring characters, long-running stories, feuds, traditions. Each entry has a title, a set of keywords and a short text. The code scans the last `lore.scanMessages` messages for keyword matches and includes up to `lore.maxMatches` entries in a `<lore>` block; entries marked `always` appear every time. Hundreds of entries can exist at negligible cost because only the matching few are shown.

The analyzer adds and updates lorebook entries on its own but never touches entries added by the owner through `/nep lore` commands. Lorebook data lives in `data/guilds/<id>/lore.json`.

## Vision and media

Transcript lines carry media markers in brackets: pictures, GIFs, videos, stickers, custom emoji, voice messages, audio files, links, text file previews and forwarded messages. Forwarded messages from another channel of the same server name the source channel. What the persona perceives depends on two features.

`features.vision` attaches pictures from the calling message, from the message it replies to, and the newest few in the channel to the LLM request as images, downscaled through Discord's media proxy. The bot downloads every picture itself and sends it inline as data, because Discord refuses downloads coming from the model provider; pictures larger than `context.vision.maxBytes` or slower than `context.vision.fetchTimeoutMs` are skipped. The persona sees these directly. Settings live under `context.vision`.

`features.mediaDescriptions` (on by default) runs a helper model (`media.model`) that writes a one-line description for pictures, GIF frames, video posters, stickers, custom emoji and link thumbnails. Each attachment is described once and cached. Descriptions feed the chat transcript, the memory analyzer and the warmup, whose token budget pays for warmup descriptions. The describer's prompt is `prompts/describe.md`. Settings live under `media`.

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

Memory lives in the process and is written to `data/`; editing those files under a running bot is unsafe because the next write overwrites the change. To edit memory by hand: `/nep pause`, edit the files, `/nep resume`. The pause stops all activity, flushes memory to disk and unloads it; a running warmup pauses after the current request. The state is persisted: a restart comes back paused, and the warmup does not auto-start until resume. `/nep resume` validates every JSON file under `data/` and refuses if any do not parse, naming the broken ones; otherwise it reloads memory and continues, including a warmup from where it left off. Read-only and config commands work while paused; commands that write memory are refused. `/nep status` shows the paused state.

## Contributing

Issues and pull requests are welcome; read `CONTRIBUTING.md` first. Target branch is `main`, one change per pull request, tests pass with `npm test`, English only. The contract between the prompt files and the code is in `docs/prompt-contract.md`. A change on one side changes the other in the same pull request. The engine stays character-neutral; behaviour of one character belongs in that deployment's `prompts.local/`. Security reports go through `SECURITY.md`, not public issues.

## Tests

```bash
npm test
```

Runs with `node --test`. No network or Discord connection needed. The same command runs in CI on every pull request.

## Project structure

```
config.json                defaults for every setting, hot-reloaded
.env.example               template for DISCORD_TOKEN and OPENROUTER_API_KEY
prompts/
  system-prompt.md         how to behave like an ordinary chat member
  character-card.md        the personality (working example)
  rules.md                 owner's live corrections
  format.md                output tags the model uses
  reply.md                 task: someone called you
  interject.md             task: jump into a conversation
  initiate.md              task: start a topic
  memory.md                prompt for the memory analyzer
  describe.md              prompt for the media describer
  address.md               classifier for follow-up messages
  profile.md               warmup: one member's profile from a message sample
  channel.md               warmup: channel notes from a message sample
  server.md                warmup: server-level notes from channel notes and member summaries
  labels.json              every code-inserted string in prompts
prompts.local/             your personality (gitignored)
docs/
  prompt-contract.md       the contract between prompt files and code
  en/
    configuration.md       full reference for every config key
    owner-commands.md      every subcommand and the access grants
    warmup.md              the warmup: stages, progress, rails, commands
  zh/                      Chinese
    README.md
    configuration.md
    owner-commands.md
    warmup.md
  ja/                      Japanese
    README.md
    configuration.md
    owner-commands.md
    warmup.md
  ru/                      Russian
    README.md
    configuration.md
    owner-commands.md
    warmup.md
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
    media.js               media classification, label selection, proxy URLs
    fetch-image.js         download and cache images for inline LLM requests
  behavior/
    mention.js             call detection, ignore heuristics
    prompt.js              request builder with token budget
    turn.js                one turn: collect, build, call, act
    spontaneous.js         chaotic timer, eavesdrop
    pending.js             pending direct pings while the persona is busy
  memory/
    store.js               JSON file persistence, atomic writes
    update.js              batch memory updates
    affinity.js            relationship score logic
    interests.js           remembered interests: sightings, confirmation, eviction
    details.js             remembered details: sightings, confirmation, eviction
    aliases.js             remembered aliases: sightings, confirmation, eviction
    episodes.js            remembered episodes: append, weight-based eviction
    channels.js            channel map rendering, activity verdicts
    mentions.js            member-id tokens in stored text: toTokens and fromTokens
    clamp.js               text clamping: soft limits, sentence boundaries, safe member tokens
    ranking.js             shared ranking for interests and details: frequency, recency, decay
    lore.js                lorebook logic: key matching, entry selection
    describe.js            media describer: one picture in, one cached caption out
    warmup.js              sample-based memory warmup
tests/                     node --test, pure-function unit tests
deploy/
  neptunia-bot.service     example systemd unit
data/                      persistent state (gitignored, created at runtime)
  state.json               scheduler times, token calibration, daily request counter, warmup progress
  guilds/<id>/guild.json   server habits, in-jokes, the persona's self-claims
  guilds/<id>/buffer.json  messages observed since the last memory update
  guilds/<id>/media.json   media description cache
  guilds/<id>/users/       per-member profiles and relationships
  guilds/<id>/channels/    channel observations from the analyzer
  guilds/<id>/lore.json    lorebook entries
```
