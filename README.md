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

Neptunia is a locally run Discord bot that plays one configurable character through an LLM, behaving like an ordinary chat member. It runs on Node.js 20+ with a single dependency (discord.js) and talks to any OpenRouter-compatible endpoint. It comes with a pluggable character card written without touching code, hot-reloaded prompts and config, per-member memory with attitudes and episodes, a server-wide lorebook, vision for attached pictures, one-line media descriptions from a helper model, owner slash commands for live tuning, and a dry-run mode. A working example character is included; write your own card for a different persona.

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

- `prompts/`: tracked engine defaults shipping a working example character.
- `prompts.local/`: your personality (gitignored). A file here replaces the same-named file in `prompts/`. `labels.json` is deep-merged, so only overridden keys are needed.

Both are hot-reloaded.

The only file you must rewrite is `character-card.md`. Copy it to `prompts.local/` and write your persona. Everything else works as-is, or override individual files as needed.

The prompt files, placeholders, labels, context blocks and output tags are described in [`docs/en/prompt-contract.md`](docs/en/prompt-contract.md).

## Configuration

`config.json` holds every setting with its default. `config.local.json` (gitignored) is deep-merged over it. Both are hot-reloaded. See [`docs/en/configuration.md`](docs/en/configuration.md) for the full reference of every key.

## Warmup

On first start, when `warmup.enabled` is true and no profile exists, the engine runs a warmup that builds memory of people, channels and the server from a sample of recent messages. The total token spend is capped by `warmup.maxTokens`. The persona stays mute while the warmup runs. See [`docs/en/warmup.md`](docs/en/warmup.md) for the stages, progress, rails and owner commands.

## Dry run

With `features.dryRun: true` the bot runs the full pipeline (memory, triggers, LLM calls) but never sends a message or reaction. Output goes to the log (`dry-run: would send` / `dry-run: would react`). Set `bot.dryRunChannelId` to a private channel for a readable mirror; everything posted in that channel is ignored by the bot. Slash commands work in any channel, the mirror included, because they are not messages.

First run on a new server: enable `features.dryRun`, watch the mirror or `journalctl -u neptunia-bot -f`, tune live, then `/nep set features.dryRun false`.

## Commands

One Discord slash command, `/nep` (the name comes from `bot.commandName`). They are registered as guild commands on start, for the served server only. Every answer is ephemeral; only the caller sees it, in whatever channel it was typed. See [`docs/en/owner-commands.md`](docs/en/owner-commands.md) for every subcommand and the access grants.

## Messages and memory

The persona responds to mentions, replies and name triggers, sometimes ignoring them. It cuts into conversations at random intervals and starts topics in dead channels. After answering, it tracks follow-up messages in that channel through a classifier. It writes one reply at a time across the server; pings in other channels are held and answered in turn.

A separate memory analyzer runs when enough messages accumulate. It builds per-member profiles with interests, details, aliases, episodes and attitudes, server-wide habits and in-jokes, and a lorebook of events and stories. Profiles are updated incrementally; stored facts are never re-summarised. The persona also learns what people call each other and recognises a member by name or alias.

See [`docs/en/messages-and-memory.md`](docs/en/messages-and-memory.md) for the pipeline steps, the analyzer, profiles, episodes, the lorebook and the owner commands that touch memory.

## Media

The persona can see attached pictures, watch short video clips, read pages behind links and search the web for facts it does not have. Each capability is a separate feature switch, off or capped by default, with its own daily limit. A `<senses>` block in each request tells the persona what is on; it never claims to have perceived anything beyond it. See [`docs/en/media.md`](docs/en/media.md) for pictures, video vision, link reading, search, tools, costs and privacy.

## Cost and privacy

Each turn is one LLM request; a memory update adds a second. Cost depends on the model and endpoint; `llm.model` and `llm.baseUrl` accept any compatible values. The daily cap (`llm.maxRequestsPerDay`) prevents runaway spending. Video descriptions add one request per watched clip to a separate, cheaper model (`media.video.maxPerDay` caps the daily count); `yt-dlp` and `ffmpeg` run locally and cost nothing beyond bandwidth. Link reads and searches (`features.webLookup`, off by default) add requests to the text classifier model, capped by `web.maxPerDay`; search additionally needs a Brave Search API key (free tier: 2,000 queries/month). With `features.webLookup` on, the bot makes outbound HTTP requests to fetch pages and to the Brave Search API; private addresses are refused.

`data/` holds per-member profiles, relationship scores, channel observations, server patterns, cached media descriptions and web excerpts. It stays on your machine, is gitignored, and is only sent to the LLM as context. The analyzer is instructed not to store sensitive details. `/nep memory forget` deletes a profile entirely.

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

Issues and pull requests are welcome; read `CONTRIBUTING.md` first. Target branch is `main`, one change per pull request, tests pass with `npm test`, English only. The contract between the prompt files and the code is in `docs/en/prompt-contract.md`. A change on one side requires the matching change on the other, in the same pull request. The engine stays character-neutral; behaviour of one character belongs in that deployment's `prompts.local/`. Security reports go through `SECURITY.md`, not public issues.

## Tests

```bash
npm test
```

Runs with `node --test`. No network or Discord connection needed. The same command runs in CI on every pull request.

## Project structure

```
config.json                defaults for every setting, hot-reloaded
.env.example               template for DISCORD_TOKEN, OPENROUTER_API_KEY, optional YOUTUBE_API_KEY and BRAVE_SEARCH_API_KEY
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
  describe-video.md        prompt for the video describer
  rewatch.md               classifier: re-watch a video for a question
  rewatch-answer.md        prompt for the re-watch answer
  address.md               classifier for follow-up messages
  lookup.md                classifier: does a question need a web search
  read-link.md             condense a fetched page
  search-summary.md        condense search results
  profile.md               warmup: one member's profile from a message sample
  channel.md               warmup: channel notes from a message sample
  server.md                warmup: server-level notes from channel notes and member summaries
  labels.json              every code-inserted string in prompts
prompts.local/             your personality (gitignored)
docs/
  en/
    prompt-contract.md   the contract between prompt files and code
    configuration.md       full reference for every config key
    owner-commands.md      every subcommand and the access grants
    warmup.md              the warmup: stages, progress, rails, commands
    media.md               pictures, video, links, search, tools, costs
    messages-and-memory.md the pipeline, the analyzer, profiles, episodes, the lorebook
  zh/                      Chinese
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
  ja/                      Japanese
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
  ru/                      Russian
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
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
    video-sites.js         video site matching, URL cache keys, yt-dlp/ffmpeg args
    fetch-video.js         download, probe and trim videos for the video describer
  web/
    readable.js            HTML to text, paywall detection
    fetch-page.js          SSRF-guarded page fetcher
    brave.js               Brave Search client
    lookup.js              link reading and web search
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
