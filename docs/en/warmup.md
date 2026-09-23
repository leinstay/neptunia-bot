# Warmup

The warmup builds the persona's memory of a server from a sample of recent messages. On first start, when `warmup.enabled` is true and no profile exists yet, it runs automatically. The persona stays mute while a warmup run is in flight.

`/nep warmup run` starts or resumes a full run at any time; see [Commands](owner-commands.md) for the complete list.

## Stages

A full run proceeds in a fixed order: channels, people, server.

### Channels

Every readable channel gets one request, described from the newest `warmup.messagesPerChannel` (default 200) messages regardless of their age. When a channel's history has fewer messages than that, a deeper fetch is attempted. A channel with no history at all is described from its name, category and topic alone. The result is a set of channel notes (purpose, topics, tone) and code-maintained facts (message counts, top writers, a 30-day activity histogram).

### People

The most active members qualify: at least `warmup.minMessages` own messages within the last `warmup.lookbackDays` days, up to `warmup.maxPeople`, most active first. `/nep warmup people` lists qualifying members under the current settings.

For each qualifying member the engine samples up to `warmup.messagesPerPerson` of their messages with `warmup.contextBefore` lines of surrounding context. No single channel may contribute more than `warmup.maxChannelShare` of the sample. Large samples are split chronologically into chunks that fit `warmup.maxRequestTokens`; each chunk after the first receives the previous answer as a `<draft>` block so the model keeps what holds, corrects what changed and extends with new evidence. The final answer stores character, style, interests, details, episodes and aliases; message count and first/last seen timestamps are computed by code.

### Server

One request takes all channel notes, a one-line summary per profiled member (name, top habits, top interests) and the newest `warmup.serverSampleMessages` (default 600) lines of the main channels (`memory.mainChannelIds`; when empty, every channel counts). The output is stored as server-wide patterns, conversation starters, in-jokes and lore entries.

## Scope

The warmup writes: channel notes (purpose, topics, tone), member profiles (character, style, interests, details, episodes, aliases), server habits (patterns, starters, in-jokes) and lore.

Attitude and relationship are never warmed up. They grow only from live conversation through the stream analyzer.

`character` and `style` are prose fields written exclusively by the profile prompt (`profile.md`), both during the warmup and during a portrait refresh. The stream analyzer never edits them directly. See the [prompt contract](prompt-contract.md) for the data model and the output schema.

## Progress

Progress is persisted to `state.warmup` after every request and survives restarts. A run interrupted by a restart, a rate limit or `/nep warmup stop` resumes from where it left off when `/nep warmup run` is called again. `/nep warmup reset` clears progress only, not stored memory.

## Rails

The total token budget for a run is `warmup.maxTokens` (default 6,000,000). Each request is capped at `warmup.maxRequestTokens` (default 120,000 input plus output) and `warmup.maxOutputTokens` (default 6,000 output). The channel fetch that builds the sample pool reads up to `warmup.fetchLimitPerChannel` (default 15,000) messages per channel.

When the provider returns HTTP 429, the warmup waits `warmup.rateLimitWaitMinutes` (default 10) minutes and retries. After `warmup.rateLimitMaxWaits` (default 36) consecutive waits the run aborts; progress is kept and the run can be resumed.

## Portrait refresh

After the warmup finishes, the stream analyzer keeps memory current from live batches. When it detects that a stored portrait misses a recurring habit or contradicts how the person now writes, the engine queues a portrait refresh: the member's newest `warmup.refreshMessages` (default 400) messages are sampled the same way as the warmup, and `profile.md` is called with the stored portrait as a draft and the analyzer's note as a hint. The new character and style replace the stored ones; interests, details, episodes and aliases from the refresh answer are ignored because those keep flowing through the stream analyzer's incremental updates.

A portrait can be refreshed at most once every `memory.portraitRefreshHours` (default 24) hours per member, up to `memory.portraitRefreshPerDay` (default 20) per day across the server. Each refresh counts against the daily request cap. `/nep memory refresh <user>` forces one regardless of the timer.

## Commands

All warmup commands live under `/nep warmup`. See [Commands](owner-commands.md) for the full reference.

| Command | What it does |
|---|---|
| `run` | Start or resume a full warmup (channels, people, server) |
| `users [member]` | Profile one member or every qualifying member |
| `channels [channel]` | Describe one channel or every readable channel |
| `server` | Rebuild server notes and lore |
| `people` | List qualifying members |
| `status` | Show progress and token usage |
| `stop` | Cancel warmup work in flight; the request in progress is aborted, progress is kept |
| `reset` | Clear progress only, not stored memory |

`run`, `users` and `channels` are refused while a run is already in flight. All warmup commands except `status`, `people` and `stop` are refused while the bot is paused.

For a truly fresh start, use `/nep memory wipe` first: it clears member profiles with their attitudes and episodes, server habits, the channel map, lore entries and warmup progress.

For the full list of warmup configuration keys see [Configuration: warmup](configuration.md#warmup).
