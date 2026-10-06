# Configuration

Every key in `config.json` with its default, grouped by section.

## `features`

| Key | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Full pipeline, never sends. See [Dry run](../../README.md#dry-run) |
| `mentions` | `true` | React to @mentions |
| `replies` | `true` | React to replies |
| `nameTriggers` | `true` | React to name mentions in messages |
| `spontaneous` | `true` | Unprompted messages on a random timer |
| `eavesdrop` | `true` | Random chance to jump into any message |
| `memory` | `true` | Build profiles, track server patterns, record self-claims |
| `relationships` | `true` | Per-member attitude scores (-100..100) |
| `episodes` | `true` | Per-person long-term memories (moments, quotes, grudges) |
| `lore` | `true` | Server-wide lorebook |
| `reactions` | `true` | Emoji reactions (the persona places them) |
| `seeReactions` | `true` | Show reactions on messages in the transcript. A missing key counts as on. Distinct from `reactions`, which controls whether the persona PLACES reactions; this one controls whether they SEE them |
| `customEmoji` | `true` | List the server's custom emoji ranked by usage so the persona can use them by `:name:`. A missing key counts as on |
| `gifs` | `true` | Build a GIF library from what members share and let the persona post from it by handle. A missing key counts as on |
| `multiMessage` | `true` | Allow 2–3 messages in a row |
| `vision` | `true` | Process attached images |
| `mediaDescriptions` | `true` | One-line descriptions for pictures, GIFs, video frames and link thumbnails |
| `attachedDescriptions` | `true` | Run the describer for pictures that are also attached to the request. Without this, attached pictures carry no helper's caption. A missing key counts as on. Needs both `vision` and `mediaDescriptions` on; one extra describer request per new picture, within `media.maxPerTurn` |
| `videoDescriptions` | `false` | Watch short video clips through a video-capable model; needs `mediaDescriptions` on as well. Turn on in `config.local.json`; still needs a video-capable model and, for site links, `yt-dlp`/`ffmpeg` |
| `videoRewatch` | `true` | When addressed, re-watch a video to answer a question about it; needs `videoDescriptions` on |
| `webLookup` | `false` | Read links posted in chat and search the web when asked a factual question. Unlike other features, a missing key counts as OFF. Needs `BRAVE_SEARCH_API_KEY` in `.env` for search; without it only link reading works. See [Media: Links and search](media.md#links) |
| `imageGeneration` | `false` | Let the persona draw pictures through a drawing sub-process. A missing key counts as on. Turn on in `config.local.json`; needs an image-capable model in `image.model`. See [Media: Drawing](media.md#drawing) |
| `privateMessages` | `false` | Answer direct messages from guild members. Needs a stored public profile and `affinity.score >= private.minAffinity`. See [Messages and memory: Private layer](messages-and-memory.md#private-layer) |
| `privateLikeServer` | `true` | A private chat works like a server channel: the route classifier, channel pull, server search (recall) and asked-about episodes all run in a DM. A pulled channel enters a DM only when the partner has View Channel permission on it. A missing key counts as on. `false` restores the old DM behaviour (no pull, no route, no recall, no asked-about episodes) |
| `channelPull` | `true` | Pull another channel into a turn's request when the recent messages or the trigger contain a real channel mention. A missing key counts as on. See `context.pull.*` |
| `elsewhere` | `true` | Answer a call (@mention, reply, name) from a channel where the bot can read but not send. The answer goes to the first usable channel in `memory.mainChannelIds`. A missing key counts as on |
| `portraitRefresh` | `true` | Refresh a member's portrait by message counters on a periodic schedule. A missing key counts as on |
| `memoryTwoStage` | `false` | Split the memory analyzer into two stages: a neutral GPT model decides what changed (stage A), then the voice model words the persona's texts (stage B). Must be exactly `true` to enable; a missing key counts as off. See `memory.voice.*` |
| `mentor` | `false` | Manual testing sub-process with its own model. Must be exactly `true` to enable; a missing key counts as off. See [Mentor](#mentor) |
| `promptCache` | `false` | Mark the system message for the provider's prompt cache. A cached read costs a fraction of normal input; some providers do not count cached reads against token quotas. Must be exactly `true` to enable; a missing key counts as off. See `llm.cache.*` |
| `recall` | `true` | Search the server's own message history beside the web search when a question calls for it. A missing key counts as on. See [Media: Search](media.md#search) and `recall.*` |
| `recent` | `true` | Show a `<recent>` block of what happened on the server in the last few days. A missing key counts as on. See `memory.recentHours` and `context.caps.recent` |
| `channelRoute` | `true` | A classifier picks a channel the conversation is about before a turn, so the channel can be pulled into the request. A missing key counts as on. See `route.*` |
| `pauseNotice` | `true` | Post a short notice when the persona is called while paused. A missing key counts as on. See `mention.pauseNoticeMinutes` and `labels.limits.paused` |
| `variety` | `true` | A model pass names the devices the persona is overusing in their own recent lines. The result becomes a `<worn>` block in the turn's request. A missing key counts as on |
| `varietyPrecompute` | `true` | Start the variety pass right after the persona posts text, so the next turn finds the result ready. Off: the pass runs only at the turn, but a late answer is still stored for later. A missing key counts as on |
| `fillerGuard` | `true` | Block words and phrases the persona overuses from repeating in replies until a cooldown expires. The variety passes feed the list automatically; the owner can pin entries with `/nep variety add type:filler`. When a fresh reply holds an entry on cooldown, one rewrite request replaces it. A missing key counts as on |
| `patternGuard` | `true` | Before posting, check the reply against the current worn patterns and rewrite when a match is found. A missing key counts as on |
| `splitTasks` | `true` | Split a long structured direct call into separate parts, each answered in its own turn. A missing key counts as on. Needs `prompts/split.md` and `labels.task.part` |
| `followUp` | `true` | Classify untagged messages after the persona answers to continue a conversation |
| `typingSimulation` | `true` | Simulate typing speed |
| `adminCommands` | `true` | Owner slash commands; `false` unregisters them |

## `bot`

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `"UTC"` | Timezone for model timestamps |
| `owners` | `[]` | User IDs for owner commands |
| `commandName` | `"nep"` | Slash command name (lowercase `a-z 0-9 _ -`, up to 32 chars; re-registered on change) |
| `nameTriggers` | `[]` | Extra trigger strings besides @mention |
| `guildId` | `""` | Server to lock to; auto-detected if in exactly one |
| `dryRunChannelId` | `""` | Channel for the dry-run mirror. See [Dry run](../../README.md#dry-run) |
| `channels.allow` | `[]` | Allowed channels (empty = all visible) |
| `channels.deny` | `[]` | Ignored channels |
| `access` | `{}` | Who besides owners may run which commands (managed by `/nep access`) |

## `llm`

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | Chat completions endpoint |
| `model` | `"anthropic/claude-opus-4.6"` | Model ID |
| `temperature` | `1` | Sampling temperature |
| `maxOutputTokens` | `700` | Max output tokens |
| `maxRequestTokens` | `50000` | Hard token cap per request |
| `safetyMargin` | `0.9` | Budgeting fraction of maxRequestTokens |
| `timeoutMs` | `300000` | Request timeout (ms) |
| `helperTimeoutMs` | `30000` | Timeout for a helper that runs alongside the turn (the route classifier, the search classifier and the recall summary). A helper that runs past this limit is abandoned; the turn continues without its result |
| `pingTimeoutMs` | `30000` | Timeout for `/nep ping` requests (ms) |
| `retries` | `2` | Retries on transient HTTP errors (408/429/5xx) and network failures. A provider account's daily-quota 429 gets one attempt and is thrown at once, not retried |
| `maxRequestsPerDay` | `300` | Daily request cap |
| `provider` | `null` | OpenRouter `provider` routing object, passed verbatim; `null` sends nothing |
| `providerByModel` | `{}` | Per-model provider routing; see below |
| `cache.ttl` | `"1h"` | Cache TTL sent on the marker: `"1h"` or `"5m"` |
| `cache.roles` | `["voice"]` | Request roles whose system message gets the cache marker. Memory-voice requests opt out, so only the reply is cached |
| `cache.models` | `["anthropic/"]` | Model id prefixes (case-sensitive) whose provider accepts the `cache_control` marker. A request to a model outside the list is sent without one |
| `cache.promptIncludesCached` | `true` | Whether the provider's reported `prompt_tokens` already includes cached and cache-write tokens. Set once from a probe; the token calibration and the per-request cap use the full count either way |
| `hedge.roles` | `["classifier.text"]` | Request roles whose calls are hedged (two concurrent attempts, first to finish wins) |
| `hedge.afterMs` | `2500` | Milliseconds before the second attempt starts. `0` or below turns hedging off for all roles |
| `hedge.timeoutMs` | `8000` | Milliseconds from the first attempt's start at which both are aborted if neither has returned |
| `hedge.longTimeoutMs` | `20000` | Timeout used instead of `timeoutMs` when the caller marks the request `long: true` (the route classifier does this for a large channel list) |

`llm.provider` sets a default OpenRouter provider routing on chat requests, for example `{ "ignore": ["some-provider"] }` or `{ "order": ["anthropic"], "allow_fallbacks": true }`. `llm.providerByModel` adds per-model overrides: each key is a model id prefix (matching any role) or `<prefix>@<role>` (matching one role only), and each value is an OpenRouter routing object sent verbatim.

For one request the provider is resolved in order: a per-call pin (the video describer uses `media.video.provider` for the direct-URL path), then the longest matching prefix among `providerByModel` keys for the request's role, then the longest matching prefix among role-less keys, then `llm.provider` (for image requests `image.provider`), then nothing. A role-specific key always beats a role-less key for the same model. Role names: `voice`, `analyzer`, `classifier.text`, `classifier.media`, `classifier.video`, `mentor`, `image`. For compatibility, a route key or a roles list that still says `talk` is read as `voice` with one log line (`config: role talk is now voice`).

Example: `"google/": { "only": ["google-vertex"], "allow_fallbacks": false }` routes all Google models through Vertex, while `"google/@classifier.video": { "only": ["google-ai-studio"], "allow_fallbacks": false }` sends the video classifier through AI Studio. Route keys that contain dots (e.g. `google/@classifier.video`) cannot be edited through `/nep set` because it splits on dots; use `/nep route set` and `/nep route remove`.

If the OpenRouter account itself restricts allowed providers, ignoring the only one left makes every request fail with "No endpoints found". After changing provider settings, run `/nep ping` to verify that every model role is reachable; each role follows its `llm.providerByModel` route, so the provider shown is the one that route selects.

With `features.promptCache` on, the system message is marked for the provider's prompt cache on requests whose role is in `llm.cache.roles` and whose model starts with a prefix in `llm.cache.models`. The marker goes on after the token estimate, so the 50k per-request cap and the calibration are unaffected. `llm.cache.promptIncludesCached` tells the engine how the provider reports cached tokens; set it once from a real probe. The `llm: usage` log line gains `cache`: `write`, `read`, `none` or `off`.

The `llm: usage` log line also carries `ms` (wall time of the request), `purpose` (a short string naming what the request was for, e.g. `route-channel`, `recall-summary`, `address`), `origin` (e.g. `mentor` for requests the mentor made or caused), `hedged` (true when the request was hedged) and `attempt` (1 or 2 for hedged requests, absent otherwise).

With `llm.hedge` configured, requests on the roles it lists are hedged: a second attempt fires `llm.hedge.afterMs` after the first, and the first to finish wins. Both are aborted at `llm.hedge.timeoutMs` (or `longTimeoutMs` for a `long: true` request). This adds one extra request per hedged call that did not finish before the second started; both count against `llm.maxRequestsPerDay`.

## `classifier`

The three helper model roles, grouped under one key. Each is set independently, so the helpers can stay on cheap models while the voice uses a premium one.

| Key | Default | Meaning |
|---|---|---|
| `text` | `"anthropic/claude-sonnet-4.6"` | Runs the address classifier (`features.followUp`), the search classifier, the link reader, the search condenser and the recall summary (`features.webLookup`, `features.recall`), the re-watch classifier (`features.videoRewatch`), the room classifier (`spontaneous.roomQuestionChance`), the channel route classifier (`features.channelRoute`) and the variety pass (`features.variety`) |
| `media` | `"anthropic/claude-haiku-4.5"` | Picture describer (`features.mediaDescriptions`): one-line descriptions for pictures, GIF frames, video posters, stickers, custom emoji and link thumbnails |
| `video` | `"google/gemini-3.8-flash"` | Video describer (`features.videoDescriptions`): watches short clips, re-watches on a question, retries on request. Must accept both video and audio input |

**Migration from the old keys.** The deprecated keys `llm.classifierModel`, `mention.followUpModel`, `media.model` and `media.video.model` are no longer read. If any of them is present in `config.local.json`, the bot logs a startup warning (`index: deprecated model key ignored`) naming the key and its replacement. Move the value to `classifier.text`, `classifier.media` or `classifier.video` respectively.

## `context`

| Key | Default | Meaning |
|---|---|---|
| `channelMessages` | `100` | Current channel messages |
| `neighborMessages` | `5` | Messages per neighbour channel |
| `neighborMaxAgeMinutes` | `60` | Max age for neighbour messages (min) |
| `neighborMaxChannels` | `8` | Max neighbour channels |
| `neighborMessageChars` | `300` | Characters kept per message from a neighbouring channel (`<other_channels>`) |
| `maxMessageChars` | `800` | Truncate messages beyond this (chars) |
| `gapMarkerMinutes` | `20` | Time-gap marker threshold (min) |
| `reactionsPerMessage` | `6` | Max reactions listed per message in the transcript, most frequent first |
| `otherProfiles` | `6` | Max other profiles shown |
| `askedAboutProfiles` | `3` | Members named in recent messages whose profiles are shown in full, ahead of the other participants |
| `askedAboutEpisodes` | `3` | Episodes shown per member who is asked about. `0` hides episodes for asked-about members. In a private chat, shown when `features.privateLikeServer` is on (the default); hidden otherwise |
| `attitudes` | `6` | Members shown in the `<attitudes>` block, ranked by attitude score strength, warm and cool mixed. `0` turns the block off |
| `tempo.liveMessages10min` | `4` | Messages in 10 min = "live" |
| `tempo.deadSilenceMinutes` | `45` | Silence minutes = "dead" |
| `caps.interlocutor` | `6000` | Token cap: caller's profile with episodes |
| `caps.aboutChat` | `2500` | Token cap: server habits / self-facts |
| `caps.lore` | `1500` | Token cap: lore entries |
| `caps.people` | `9000` | Token cap: other profiles |
| `caps.attitudes` | `400` | Token cap: attitude list |
| `caps.neighbors` | `3000` | Token cap: neighbour channels |
| `caps.server` | `4000` | Token cap: channel map |
| `caps.emoji` | `800` | Token cap: custom emoji |
| `caps.gifs` | `900` | Token cap: GIF library |
| `caps.pulled` | `4000` | Token cap: pulled channel block (`<channel_view>`) |
| `channelActivity.liveMessagesPerDay` | `20` | Daily messages = "active" channel |
| `channelActivity.deadAfterDays` | `7` | Days without messages = "dead" channel |
| `vision.maxImages` | `4` | Max images per request |
| `vision.tokensPerImage` | `400` | Token budget per image |
| `vision.imageSize` | `512` | Downscale target in px, via Discord's media proxy |
| `vision.recentImages` | `3` | Recent channel images to include |
| `vision.recentImageMinutes` | `30` | Max age for recent images (min) |
| `vision.maxBytes` | `1500000` | Max image file size (bytes); larger pictures are skipped |
| `vision.fetchTimeoutMs` | `10000` | Download timeout per image (ms) |

### `context.customEmoji`

Settings for the custom emoji block (`features.customEmoji`). The memory analyzer tracks which custom emoji members use and how often.

| Key | Default | Meaning |
|---|---|---|
| `max` | `30` | Custom emoji shown in the `<emoji>` block, ranked by member usage; when fewer than `max` have been ranked the rest are filled from the server's emoji in server order |
| `storeMax` | `200` | Custom emoji kept in the usage ranking; the top `max` are shown |
| `halfLifeDays` | `30` | Recency half-life for the usage ranking (days); rank = log2(count + 0.5) + last / halfLife; an emoji not used recently sinks below one used often |
| `backfillMessages` | `500` | Messages read per channel from history at startup to seed the ranking. Runs once when `features.customEmoji` is on and no backfill has run yet for this server; the result is stamped in `guild.json`. `0` disables the backfill |

### `context.pull`

Settings for pulling another channel into a turn's request (`features.channelPull`). When the recent messages or the trigger contain a real Discord channel mention (`<#id>`), the mentioned channel's latest messages are rendered as a `<channel_view>` block. The window ends at that channel's newest message, however old.

| Key | Default | Meaning |
|---|---|---|
| `windowMinutes` | `60` | Minutes of messages to pull, ending at the channel's newest message |
| `minMessages` | `5` | Minimum messages in the window; the window extends further back to reach this count |
| `maxMessages` | `60` | Maximum messages pulled per channel |
| `maxPictures` | `10` | Pictures whose captions are included; cached captions are free, fresh ones are requested only when the turn is certain to run |
| `maxNewDescriptions` | `8` | Fresh describer requests for pictures in a pulled channel per turn |
| `describeTimeoutMs` | `15000` | Timeout for fresh caption requests (ms) |
| `scanMessages` | `20` | Recent messages of the current channel scanned for channel mentions |
| `maxChannels` | `1` | Channels that can be pulled per turn |
| `maxAgeDays` | `0` | Refuse a pull when the channel's newest message is older than this many days. `0` = no limit |
| `sameAudience` | `true` | Check that every role allowed to view the destination channel can also view the source. Also governs which neighbour channels appear in `<other_channels>` and which server-search windows the recall run keeps. When false, content from a restricted channel can reach a wider audience |

## `elsewhere`

Settings for answering calls from channels where the bot can read but not send (`features.elsewhere`). A call (mention, reply, name) in such a channel waits for the conversation there to settle, then the persona answers in the first usable channel of `memory.mainChannelIds` with a link back to the call.

| Key | Default | Meaning |
|---|---|---|
| `settleSeconds` | `90` | Seconds after the last message in the source channel before the call is answered |
| `settleMaxSeconds` | `300` | Maximum seconds from the first call in a burst before the answer fires regardless |
| `rememberPings` | `20` | Calls remembered in the ring per channel |
| `pingMaxAgeDays` | `7` | Days before a remembered call expires from the ring |

## `pace`

How long each stage of a turn may take when someone is waiting for the answer. All hot-reloaded. A helper that misses its deadline is dropped; the turn continues without it. A turn whose answer is not in hand by `dropAfterMs` is dropped entirely (logged as `turn: dropped`). Each request logs the time of every stage in `turn: timings`.

| Key | Default | Meaning |
|---|---|---|
| `prepareMs` | `6000` | Milliseconds from the turn's start before the voice request. Everything that runs before the LLM call (history, captions, the variety pass, the route and search classifiers) must finish within this window. `0` or a non-number removes the limit |
| `prepareSearchMs` | `12000` | Extended deadline once the search classifier asked for a web or server search. Never shorter than `prepareMs`. `0` or a non-number removes the limit |
| `prepareMediaMs` | `20000` | Extended deadline on a direct call whose trigger message (or the line it replies to) carries a picture, GIF or video the describer or video stage will work on. Never shorter than `prepareMs`; when the search extension also applies, the larger limit wins. `0` or a non-number removes the extension |
| `dropAfterMs` | `60000` | Milliseconds from the turn's start. If the finished answer has not arrived by this time, the turn is dropped unposted (`turn: dropped`). `0` or a non-number removes the bar |
| `replyHedgeMs` | `20000` | On a turn answering a direct call, when the reply request has no answer after this many milliseconds, a second identical request is sent. The first to finish wins and the other is aborted. The second attempt counts against `llm.maxRequestsPerDay`. The `dropAfterMs` bar still ends everything. `0` or a non-number = one attempt only. Turns nobody waits for (`unpromptedWaits`) never send a second attempt |
| `typingWhilePreparing` | `false` | Show the typing indicator from the start of a turn answering a direct call (mention, reply, name, follow-up, private), not only while the finished answer is being typed out. Must be exactly `true` to enable |
| `unpromptedWaits` | `true` | A turn nobody waits for (interjecting, starting a topic, noticed comment, room question, overheard) waits for every stage and posts when ready, ignoring `prepareMs`, `prepareSearchMs` and `dropAfterMs`. `false` applies the same deadlines to every turn. A missing key counts as on |

## `route`

Settings for the channel route classifier (`features.channelRoute`). When the conversation names or refers to another channel, a classifier (`prompts/route-channel.md` on the `classifier.text` role) picks the channel number from a list. The picked channel is pulled into the request as a `<channel_view>` block alongside any explicit channel mentions. Logged as `route: classified`, `route: skipped` or `route: failed`.

| Key | Default | Meaning |
|---|---|---|
| `contextMessages` | `20` | Recent channel messages rendered for the classifier |
| `maxChannels` | `40` | Channels listed for the classifier to choose from |
| `purposeChars` | `80` | Characters of each channel's stored purpose shown in the list |
| `maxOutputTokens` | `120` | Max output tokens for the classifier |

## `split`

Settings for the task splitter (`features.splitTasks`). When a direct call (mention, reply, name, follow-up, private message) is long enough and structured enough, a classifier (`prompts/split.md` on the `classifier.text` role) decides whether it holds several separate requests. Each part is answered in its own turn; the first replies to the message, the rest post plain. The splitter runs beside the turn's preparation and never slows a single request. Logged as `split: verdict`, `split: skipped` or `split: failed`; each part logs `turn: part`.

| Key | Default | Meaning |
|---|---|---|
| `minChars` | `80` | Minimum characters (links and Discord tokens excluded) before the splitter is asked |
| `minPartChars` | `20` | A returned part shorter than this (characters, links and Discord tokens excluded, like `minChars`) is folded into the next part (the last into the previous). When fewer than two parts remain the message is one request. `0` = no folding |
| `maxTasks` | `4` | Maximum parts the splitter may return. Below 2 the splitter is off |
| `contextMessages` | `6` | Recent channel messages rendered for the classifier alongside the candidate |
| `maxOutputTokens` | `300` | Max output tokens for the classifier |

## `recall`

Settings for the server-history search (`features.recall`). When the lookup classifier (`prompts/lookup.md`) answers with `server:` forms, `who:` name forms or `when:` date ranges, the engine searches the server's own message history through Discord's search API, groups the hits into clusters, fetches a window of messages around each, and asks a summary helper (`prompts/recall-summary.md` on the `classifier.text` role) what the history answers. The summary may single out one stretch that the persona then gets verbatim alongside the condensed note. Logged as `recall: searched`, `recall: summary`, `recall: skipped` or `recall: failed`.

| Key | Default | Meaning |
|---|---|---|
| `maxForms` | `5` | Search forms (word inflections) the classifier may list per `server:` line |
| `maxPeople` | `2` | People the `who:` line may name |
| `dateSamples` | `4` | Date-only queries sampled across a `when:` range when no content forms are given |
| `clusterGapMinutes` | `30` | Gap between hits that separates them into clusters |
| `maxClusters` | `5` | Clusters kept, ranked by topic score (each distinct `server:` form with hits in the cluster adds 2 when rare, 1 otherwise), then by all distinct queries, then newest first. A cluster with only name or author hits ranks below any cluster with a topic hit |
| `keepOldest` | `0` | Of the `maxClusters` kept, this many slots go to the oldest clusters with a topic score of at least 2. A cluster scoring below 2 never gets a reserved slot. `0` = ranked order only |
| `rareHits` | `5` | A `server:` form whose search returned at most this many hits on the whole server counts double in a cluster's topic score. `0` = no rarity bonus |
| `windowMessages` | `16` | Messages fetched around each cluster centre |
| `answerChars` | `1200` | Max characters for the summary note; fills `{{answerChars}}` in `recall-summary.md` |
| `stretchChars` | `1500` | Max characters of the verbatim stretch shown to the persona |
| `maxPerDay` | `100` | Daily recall runs (stored in `state.json` as `recallDay` / `recallCount`) |
| `timeoutMs` | `10000` | Total time for the recall run (search, windows, summary). Once half the time is gone no further search is sent; the summary runs only when at least `minSummaryMs` is left |
| `minSummaryMs` | `2500` | Minimum time left for the summary helper to be asked. Without it the verbatim stretch of the top window is returned without a note |
| `memoryItems` | `6` | Stored memory items (episodes, lore, lessons, recent lines) matched against the classifier's word forms and name forms and sent in the `<memory>` block of the recall summary. `0` turns the match off |
| `maxOutputTokens` | `500` | Max output tokens for the summary helper |

## `gifs`

Settings for the GIF library (`features.gifs`). Uses are counted as each message arrives (members only, bots and the persona excluded). A one-time backfill from channel history seeds the ranking at startup.

| Key | Default | Meaning |
|---|---|---|
| `max` | `40` | GIFs shown in the `<gifs>` block, ranked by recency-weighted use |
| `listChars` | `70` | Characters kept per caption in the `<gifs>` list, cut at a word boundary. `0` shows the whole caption |
| `storeMax` | `300` | GIFs kept in the library; the top `max` are shown |
| `halfLifeDays` | `30` | Recency half-life for the usage ranking (days); same formula as custom emoji |
| `maxPerDay` | `40` | GIFs the persona may post per day |
| `backfillMessages` | `500` | Messages read per channel from history at startup to seed the library. Runs once when `features.gifs` is on and no backfill has run yet for this server. `0` disables |
| `backfillDescribe` | `20` | Top GIFs by rank that are sent to the describer for a caption right after the backfill; the rest get captions as the chat meets them |
| `recachePerRun` | `50` | Library GIFs re-described per `/nep gifs recache` run. One-frame captions outside the library are dropped at once; then up to this many library entries are watched in the background, oldest first |
| `ownMarkHours` | `24` | Hours after the persona posts a GIF during which the entry carries `gifs.ownMark` in the `<gifs>` list. `0` turns the mark off |

## `media`

Settings for the media describer (`features.mediaDescriptions`). The describer model is `classifier.media`.

| Key | Default | Meaning |
|---|---|---|
| `maxOutputTokens` | `120` | Max output tokens per description; raise for a reasoning model whose thinking counts against this cap |
| `descriptionChars` | `200` | Max characters for a picture description; the first line is kept and cut on a word boundary. Fills `{{maxChars}}` in `describe.md` when the placeholder is present |
| `imageSize` | `512` | Downscale target in px |
| `maxPerTurn` | `6` | Max descriptions generated per turn |
| `prefillPerMessage` | `2` | Pictures, stickers and custom emoji of one observed message sent to the describer as they arrive; `0` turns the picture prefill off |
| `cacheEntries` | `5000` | Description cache size, keyed by attachment |
| `filePreviewChars` | `500` | Characters shown from the beginning of text files |
| `embedTextChars` | `200` | Characters shown from link embed text |

### `media.gif`

Settings for watching GIFs as short clips (`media.gif.watch`). When enabled, a GIF's animation is converted to a short mp4 and sent to the `classifier.video` model instead of describing a single frame. The watched caption replaces the one-frame description. A GIF that cannot be watched (no animation source, a failed conversion, a spent daily cap) falls back to the one-frame description.

| Key | Default | Meaning |
|---|---|---|
| `watch` | `true` | Watch GIFs as short video clips instead of describing a single frame. Needs `features.mediaDescriptions` and `features.videoDescriptions` on. A missing key counts as on |
| `maxSeconds` | `8` | Seconds of the animation sent to the video model; the clip is converted with ffmpeg |
| `maxPerDay` | `200` | Daily GIF watch cap, counted separately from `media.video.maxPerDay`. Once spent, a GIF gets the one-frame description instead |

### `media.video`

Settings for the video describer (`features.videoDescriptions`). Video vision needs BOTH `features.mediaDescriptions` and `features.videoDescriptions` on. The video model is `classifier.video`. A separate video-capable model watches short clips: Discord video attachments and links to the sites in `media.video.sites`. Results are cached in the media cache alongside picture descriptions; a repost costs nothing.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | OpenRouter provider routing for the direct-URL path (YouTube within the length cap). Overrides `llm.providerByModel` and `llm.provider` for this path; `null` lets the normal resolution order apply |
| `maxOutputTokens` | `800` | Max output tokens per video summary |
| `summaryChars` | `1500` | Max characters for a video account; fills `{{maxChars}}` in `describe-video.md` |
| `maxRequestTokens` | `60000` | Token cap per video request (input + output), used instead of `llm.maxRequestTokens`. A public-URL video in agentic mode uses `directUrlTokensPerSecond` (10) for the estimate: one hour of YouTube is 36 000 tokens. Downloaded clips use `tokensPerSecond` (120): three minutes is 21 600 tokens |
| `maxSeconds` | `180` | Max clip duration (seconds) for attachments and downloaded site videos; longer attachments are trimmed with `ffmpeg`, longer site videos are cut to their first `maxSeconds` by `yt-dlp`. Direct-URL sites use `directUrlMaxSeconds` instead |
| `directUrlMaxSeconds` | `3600` | Max duration (seconds) for a public-URL video (YouTube and other `directUrlSites`) when `urlProcessing` is `agentic`. In any other mode the effective cap is the smaller of this value and `maxRequestTokens / tokensPerSecond`. Longer videos take the download route (first `maxSeconds` via yt-dlp), which YouTube often blocks with a bot check on servers |
| `maxBytes` | `12000000` | Max file size (bytes) for attachments and downloaded site clips; the download itself may be up to 4x this size. Over-size files are re-encoded to 360p with `ffmpeg` first; only a clip still too large after re-encoding is refused as a permanent miss |
| `maxPerTurn` | `1` | Max NEW videos per turn; every fetch attempt counts, failed or not |
| `maxPerDay` | `40` | Daily video request cap (stored in `state.json` as `videoDay`/`videoCount`) |
| `tokensPerSecond` | `120` | Token estimate per second of video for the budget check. Applies to downloaded clips and to public-URL videos outside agentic mode; in agentic mode `directUrlTokensPerSecond` is used instead |
| `directUrlTokensPerSecond` | `10` | Per-second token estimate for the pre-flight budget check on a public-URL video in agentic mode (the model loads only what it needs; the video itself is not counted as prompt tokens). A missing or invalid value falls back to `tokensPerSecond`. `tokensPerSecond` (120) still applies to downloaded clips and to URLs in other modes |
| `timeoutMs` | `90000` | LLM request timeout for video (ms) |
| `toolTimeoutMs` | `60000` | Timeout for `yt-dlp` and `ffmpeg` subprocesses (ms) |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | Hostnames whose links are treated as video |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | Sites whose public URL can be passed directly to the provider (the provider fetches the video itself) |
| `directUrlUnknownDuration` | `false` | Send a direct-URL-site link to the provider even when no probe could determine the duration; the token estimate uses `maxSeconds`. See the duration chain below |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | A fixed YouTube video probed at startup and by `/nep ping classifier.video` to test the YouTube API key and duration sources |
| `ytdlpPath` | `"yt-dlp"` | Path to the `yt-dlp` binary; needed for site video links and for probing duration |
| `ffmpegPath` | `"ffmpeg"` | Path to `ffmpeg`; needed for trimming and downscaling long or large attachments |
| `errorRetryMinutes` | `60` | Minutes before an error-cached video is retried on its own; a forced retry from the re-watch classifier ignores this |
| `urlProcessing` | `"agentic"` | OpenRouter's processing mode sent on public-URL video parts; without it some providers see only a single frame. `null` omits the field |
| `reasoning` | `{ "effort": "low" }` | OpenRouter `reasoning` setting for every video request; keeps reasoning from eating the output budget. A non-object omits the field |
| `prefill` | `true` | Watch a video as soon as it arrives, so the next turn finds it cached |
| `prefillPerMessage` | `1` | Videos of one observed message watched as they arrive (with `prefill` on); `0` turns the video prefill off |

Both `yt-dlp` and `ffmpeg` are optional system binaries. Without them, attachments within the caps still work (sent as-is). Longer attachments and all site links fall back to the still frame or preview picture, and the persona is told the reason. Every video request counts against `llm.maxRequestsPerDay` and the video token cap (`maxRequestTokens`).

For YouTube links, the duration is learned through a chain: yt-dlp first, then the YouTube Data API (when `YOUTUBE_API_KEY` is set in `.env`), then a scrape of the watch page. When every probe fails and `directUrlUnknownDuration` is off (the default), the link is reported as "could not load." With the switch on, the URL is sent to the provider anyway, billed as `maxSeconds` in the token estimate. The Data API key is free: enable YouTube Data API v3 in the Google Cloud console and create a key; the free quota is 10,000 units/day and one duration lookup costs 1 unit. `/nep ping classifier.video` probes `canaryUrl` and reports the API key status (e.g. `youtube: API key — ok`). A cached length-limit result records the video's duration and is retried when the cap is raised.

### `media.video.rewatch`

Settings for the re-watch classifier (`features.videoRewatch`). When the persona is addressed and a watched video sits in the recent transcript, a cheap classifier decides whether the message asks about one of those videos; if so, the video model watches the clip again and the answer is appended to the transcript. The classifier uses `classifier.text`. The second look always uses `classifier.video`.

| Key | Default | Meaning |
|---|---|---|
| `maxPerDay` | `20` | Daily re-watch cap (separate from `media.video.maxPerDay`) |
| `maxOutputTokens` | `600` | Max output tokens for the re-watch answer (the video model's second-look response, not the classifier's pick) |
| `classifierMaxOutputTokens` | `120` | Max output tokens for the re-watch classifier (the pick/retry/none decision). A reasoning model that thinks before answering needs a larger cap, or it returns an empty answer |
| `answerChars` | `1200` | Max characters for the answer; fills `{{maxChars}}` in `rewatch-answer.md` |
| `recentMessages` | `60` | How many recent messages to scan for watched or error-state videos |
| `maxCandidates` | `6` | Max videos offered to the classifier from the recent window, newest first |
| `contextMessages` | `50` | Recent channel messages (excluding the trigger) rendered as a `<transcript>` block for the classifier; `0` omits the block |

At most one re-watch or retry per turn. Answers are cached for one hour per question. The classifier and the second look each count against `llm.maxRequestsPerDay`; the second look also counts against `media.video.maxPerDay`.

## `mention`

| Key | Default | Meaning |
|---|---|---|
| `ignoreChance` | `0` | Base ignore chance; raise to make the persona skip some pings |
| `emptyMentionIgnoreChance` | `0` | Ignore chance for bare @mention; raise to make the persona skip some |
| `repeatWindowMinutes` | `10` | Repeat tracking window (min) |
| `repeatPenalty` | `0` | Added ignore chance per repeat; raise to penalize repeats |
| `spamThreshold` | `50` | Calls in window before spam |
| `spamIgnoreChance` | `0.9` | Ignore chance when spammed |
| `nameTriggerChance` | `1` | Name trigger response chance |
| `neverIgnore` | `[]` | User IDs never ignored |
| `affinityIgnoreBonus` | `0` | Max added ignore at affinity -100; raise so disliked members are ignored more often |
| `affinityLikeBonus` | `0.08` | Max reduced ignore at affinity +100 |
| `oneAtATime` | `true` | One reply at a time across the server |
| `pendingSameChannel` | `true` | Hold a direct ping in the same channel while a turn is running there; answered after the turn with the usual ignore chance. Missing key = on |
| `maxPending` | `6` | Total pending calls held across all channels and authors. The single oldest is evicted when full (`mention: dropped`, reason `full`) |
| `pendingMinutes` | `10` | Minutes before a held ping expires |
| `switchDelayMs` | `[2000, 9000]` | Pause before answering in the next channel (ms) |
| `followUpMinutes` | `15` | Follow-up window after the persona's last reply (min) |
| `followUpClassifyReplies` | `true` | Send a reply to another member's message to the classifier instead of automatic `no`. Missing key = on. With the switch off, any reply is `no` before the model is asked |
| `followUpContext` | `15` | Transcript lines sent to the classifier |
| `followUpMaxOutputTokens` | `8` | Max output tokens for the address classifier. A reasoning model that thinks before answering needs a larger cap, or it returns an empty answer |
| `followUpOverheard` | `true` | When on, an `overheard` answer from the address classifier starts its own kind of turn with `prompts/overheard.md`. Off: an `overheard` answer counts as a plain `yes` (a follow-up turn). Missing key = on |
| `followUpAliases` | `5` | Stored aliases of the persona sent to the address classifier alongside their name, so the classifier recognises them as a call. `0` sends none |
| `followUpNoStreak` | `3` | Consecutive `no` verdicts that close the window |
| `pauseNoticeMinutes` | `10` | Minimum minutes between pause notices in the same channel. `0` posts one for every call |

Follow-up windows are persisted in `data/state.json` under `followUpWindows` and restored at startup; expired ones are dropped.

## `typing`

| Key | Default | Meaning |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | Reaction delay range (ms) |
| `msPerChar` | `[35, 75]` | Per-character typing speed (ms) |
| `minMs` | `900` | Min typing duration (ms) |
| `maxMs` | `12000` | Max typing duration (ms) |
| `betweenMessagesMs` | `[700, 3500]` | Pause between messages (ms) |

## `spontaneous`

| Key | Default | Meaning |
|---|---|---|
| `channels` | `[]` | Allowed channels |
| `maxChannelSilenceHours` | `72` | Channel silence that blocks spontaneous messages (hours); 0 = no limit |
| `someoneAroundMinutes` | `120` | No spontaneous turn when every readable channel's last message is older than this (minutes). The persona's own last post in a channel does not count; another bot's does. `0` = no gate |
| `initiateCooldownHours` | `[6, 12]` | Cooldown after starting a topic (hours); no further topic starts until it expires. Interjecting, room questions, eavesdrop, noticed comments and `/nep initiate` are not affected. Stored in `state.json`; `/nep status` shows the end while active. `[0, 0]` = no cooldown |
| `minIntervalMinutes` | `25` | Min check interval (min) |
| `maxIntervalMinutes` | `420` | Max check interval (min) |
| `burstChance` | `0.15` | Burst follow-up chance |
| `burstMinutes` | `[3, 15]` | Burst timing range (min) |
| `activeHours` | `{ from: 10, to: 3 }` | Active hours (wraps midnight) |
| `liveWindowMinutes` | `15` | Live window (min) |
| `liveMinMessages` | `4` | Min messages for "live" |
| `deadAfterMinutes` | `90` | Silence before "dead" (min) |
| `initiateChance` | `0.35` | Chance of starting a topic vs interjecting |
| `roomQuestionChance` | `0.04` | Chance that a message put to the room (not to one person) is picked up by the persona. A classifier (`prompts/room.md`) pre-filters. `0` turns it off |
| `eavesdropChance` | `0.02` | Per-message jump-in chance |
| `eavesdropDelayMs` | `[5000, 40000]` | Eavesdrop delay range (ms) |
| `minGapMinutes` | `12` | Min gap between actions (min) |

## `memory`

| Key | Default | Meaning |
|---|---|---|
| `model` | `null` | Analyzer model (`null` = llm.model) |
| `temperature` | `0.3` | Sampling temperature of every analyzer-role request: stream analyzer batches (server and private), the warmup's channel, profile and server requests and the portrait refresh |
| `mainChannelIds` | `[]` | Channels where people talk to each other; the portrait of a member's character and style is drawn from them; empty means every channel counts. Also the destination for answers to calls from read-only channels (`features.elsewhere`): the first usable channel in the list is used |
| `portraitRefreshHours` | `24` | Min hours between portrait refreshes triggered by the analyzer's cue per member |
| `portraitRefreshMessages` | `300` | Own messages since the last portrait before a code-triggered refresh is due. Also the sample size for the refresh |
| `portraitRefreshDays` | `3` | Days since the last successful refresh before a code-triggered refresh is due |
| `portraitRefreshPerDay` | `3` | Max portrait refreshes per server per day (code-triggered, analyzer cue and `/nep memory refresh` share this cap). The day counter lives in `state.json` as `portraitDay` / `portraitCount` and survives `/nep warmup reset` |
| `portraitRetryHours` | `24` | Hours to wait after a failed refresh attempt before trying the same member again |
| `portraitCheckMinutes` | `60` | How often the portrait scheduler checks for members due a refresh |
| `analyzerEpisodes` | `8` | Episodes shown per author in the analyzer's `<existing_profiles>`. Only the top by weight and recency are sent; the stored list keeps every episode. `0` sends none |
| `keepNewestEpisodes` | `5` | The newest episodes (by when they were added) are exempt from eviction. `0` uses the previous rule: evict lightest first, then oldest |
| `recentHours` | `72` | Hours of recent notes kept and shown in the `<recent>` block. Lowering it narrows the view at once and deletes older lines at the next write |
| `maxRecentStored` | `150` | Lines kept on disk. When a write adds lines past this cap, the lightest, then the oldest are evicted |
| `maxNewRecent` | `3` | Lines the analyzer may add per batch |
| `recentChars` | `160` | Max characters per recent line |
| `recentShown` | `12` | Live recent lines the analyzer is shown in `<existing_recent>` so it does not repeat them |
| `notesStaleDays` | `7` | Days after which a channel's or the server's notes are flagged for a re-check by the analyzer. `0` turns the flag off |
| `notesMinLines` | `20` | Batch lines a channel needs in this batch for its staleness flag to be sent |
| `privateMaxAgeMinutes` | `360` | Minutes before a quiet private buffer is analyzed even though it has not reached `minBatchMessages` |
| `channelWritersStored` | `20` | Top writers kept per channel, ranked by a decayed tally |
| `channelWritersHalfLifeDays` | `30` | Half-life of the per-channel writer tally (days); a writer who stopped writing sinks below active ones |
| `reasoning` | `null` | OpenRouter `reasoning` object sent on the analyzer's stage A requests and the warmup's neutral route. `null` omits the field. Example: `{ "effort": "low" }` |
| `batchMessages` | `60` | Ideal batch size |
| `minBatchMessages` | `15` | Min messages before update |
| `maxBatchAgeMinutes` | `180` | Force update after (min) |
| `maxOutputTokens` | `20000` | Max analyzer output tokens |
| `fieldChars` | `1000` | Profile field limit (chars) |
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
| `maxLearned` | `20` | Lessons shown to the analyzer and the chat model |
| `maxLearnedStored` | `60` | Lessons kept on disk; the top by frequency and recency are shown |
| `learnedChars` | `160` | Max chars per lesson |
| `learnedHalfLifeDays` | `720` | Weight half-life for lessons (days) |
| `maxAliases` | `5` | Aliases shown to the persona and analyzer per profile |
| `maxAliasesStored` | `15` | Aliases kept per profile; the top by frequency and recency are shown |
| `aliasRosterSize` | `40` | Members carried in the `<known_members>` block of a guild analyzer batch: stored profiles not present as authors, so the analyzer can record an alias for one of them. `0` turns the roster off. Private batches never carry it |
| `aliasHalfLifeDays` | `365` | Weight half-life for aliases (days) |
| `maxInjokes` | `15` | Max server in-jokes |
| `maxSelfFacts` | `20` | Max self-claims |
| `maxEpisodes` | `20` | Max episodes kept per person |
| `maxNewEpisodes` | `3` | Max new episodes per person per batch |
| `timeoutMs` | `900000` | Analyzer timeout (ms), separate from `llm.timeoutMs` |

The analyzer prompt reads these limits as placeholders, so raising a value takes effect on the next batch. Bigger profiles cost context tokens (`context.caps.people`, `context.caps.interlocutor`) and analyzer output (`memory.maxOutputTokens`).

**Migration.** `memory.voiceModel` is no longer read; a config that still sets it logs one warning and the value is ignored. Replies and memory wording both use `llm.model`.

### `memory.voice`

Settings for stage B of the two-stage analyzer (`features.memoryTwoStage`). Stage B takes the neutral briefs queued by stage A and words them in the persona's voice. The queue is persisted in `data/guilds/<id>/voice.json` and survives restarts.

| Key | Default | Meaning |
|---|---|---|
| `maxItems` | `24` | Items per voice request, fitted under the 50k token rail |
| `maxPerDay` | `100` | Voice requests per UTC day. `0` prevents sending (useful for stage-A-only simulation runs) |
| `maxOutputTokens` | `3000` | Max output tokens per voice request |
| `retryMinutes` | `15` | Back-off after a voice answer that left an item out; the delay doubles on each miss |
| `maxAttempts` | `4` | Answers that left an item out before it takes the degraded path. A failed request (bad JSON, timeout) does not count toward this |
| `queueMax` | `100` | Items kept in the queue; the oldest non-character items overflow to the degraded path |
| `queueHours` | `24` | Hours before a queued item expires to the degraded path. Character items never expire |
| `timeoutMs` | `120000` | Request timeout for voice requests (ms) |

## `relationships`

| Key | Default | Meaning |
|---|---|---|
| `damping` | `true` | Damp score changes that push further from zero; changes toward zero apply in full |
| `dampingPower` | `1` | Exponent of the damping factor; higher values make the ends of the scale harder to reach |
| `maxDeltaPerUpdate` | `15` | Max score change per update |
| `historySize` | `10` | Attitude changes kept per member |
| `shownMoves` | `4` | Attitude moves shown after the score in the profile, strongest by absolute delta first. `0` hides them |
| `directTriggerCount` | `6` | Direct interactions that force early update |
| `decayPerDay` | `0.04` | Daily drift toward zero; per day the score loses `decayPerDay * |score| * (|score| / 100) ^ decayPower`. `0` or missing = off |
| `decayPower` | `1` | Exponent of the decay curve; higher values make scores close to zero decay slower. Not a positive number = 1 |
| `rewriteOnBandChange` | `true` | Flag a stored `relationship` text for rewrite when the attitude band has changed since it was written. Missing key = on |
| `rewriteOnDrift` | `8` | Flag the text for rewrite when the score has drifted this many points since the text was written, even within the same band. `0` = off |
| `rewriteAfterMoves` | `6` | Flag the text for rewrite after this many attitude history entries since the text was written. `0` = off |
| `bandHysteresis` | `2` | Points past the old band's edge before a band change is counted as a rewrite cause. Prevents rewrites from scores that hover near a band boundary |
| `textChars` | `600` | Max characters for the relationship text. Fills `{{relationshipChars}}` in the analyzer prompt |

With `damping` on, a change that pushes the score further from zero is scaled by `(1 - |score| / 100) ^ dampingPower`, so extremes take sustained effort; a change back toward zero applies at full strength. The score is stored with fractional precision and shown as a whole number; `/nep memory affinity` sets it directly without damping.

With `decayPerDay` set, every stored affinity (public and private) drifts toward zero once a day. At score 100 with the default settings, the daily loss is 4; at 64 about 1.6; at 30 about 0.36. The sweep runs at startup and hourly, applying whole days from a per-profile stamp (`affinity.decayedAt`), so downtime is caught up. Never runs while paused or during the warmup. No attitude history entry is written.

## `lore`

| Key | Default | Meaning |
|---|---|---|
| `maxEntries` | `500` | Max lorebook entries per server |
| `scanMessages` | `30` | Messages scanned for key matches |
| `maxMatches` | `8` | Max entries shown per request |
| `textChars` | `600` | Lore entry text limit (chars) |

## `web`

Settings for the web lookup (`features.webLookup`). Both link reading and search share a daily counter (`web.maxPerDay`). Results are cached in the media cache (`data/guilds/<id>/media.json`). All model calls go through the `classifier.text` role.

| Key | Default | Meaning |
|---|---|---|
| `maxPerDay` | `60` | Shared daily cap for link reads and search requests combined |
| `acceptLanguage` | `"en,ru;q=0.8"` | The Accept-Language header sent when a page is read; empty sends none |

### `web.links`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Read links posted in chat (http/https only, private addresses refused, video-site links excluded) |
| `prefill` | `true` | Read a link as soon as it arrives, so the next turn finds it cached |
| `prefillPerUserPerDay` | `10` | Max links the prefill reads per member per day on arrival; the turn path is not limited by this |
| `maxPerTurn` | `2` | Max new link reads per turn (each fetch attempt counts) |
| `maxBytes` | `1500000` | Max page size (bytes) before the page is refused |
| `textChars` | `6000` | Max characters of page text sent to the condenser |
| `summaryChars` | `700` | Max characters for the condensed excerpt; fills `{{maxChars}}` in `read-link.md` |
| `maxOutputTokens` | `300` | Max output tokens for the condenser |
| `fetchTimeoutMs` | `10000` | Download timeout per page (ms) |
| `skipSites` | `["cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com", "klipy.com", "imgur.com", "i.redd.it", "v.redd.it", "pbs.twimg.com"]` | Hostnames (subdomains included) whose links are never read (in addition to video sites, which are always excluded) |

### `web.search`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run a search when the classifier fires; needs `BRAVE_SEARCH_API_KEY` in `.env` |
| `maxPerTurn` | `1` | Max searches per turn |
| `results` | `5` | Number of Brave Search results requested |
| `summaryChars` | `900` | Max characters for the condensed answer; fills `{{maxChars}}` in `search-summary.md` |
| `maxOutputTokens` | `400` | Max output tokens for the condenser |
| `classifierMaxOutputTokens` | `200` | Max output tokens for the search classifier. Raised to fit the multi-line answer format (`web:`, `server:`, `who:`, `when:`). A reasoning model that thinks before answering needs a larger cap |
| `cacheHours` | `24` | Hours a cached search result is served before re-searching |
| `contextMessages` | `50` | Recent channel messages rendered as a `<transcript>` for the search classifier |
| `timeoutMs` | `10000` | Brave Search request timeout (ms) |

## `image`

Settings for the drawing sub-process (`features.imageGeneration`). The persona emits a `<draw>` tag; code generates one picture through OpenRouter's Images API and posts it as a separate message. Generation and daily counts are stored in `data/state.json` (`imageDay`, `imageCount`, `imageUsers`). All pictures go through `image.model`, not the chat or classifier models.

| Key | Default | Meaning |
|---|---|---|
| `model` | `"openai/gpt-image-2.5-flare"` | Image model ID. Only `openai/*` and `google/*` families are supported; anything else is refused before any request |
| `maxPerDay` | `50` | Daily generation cap for the whole instance |
| `maxPerUserPerDay` | `50` | Daily generation cap per member; spontaneous turns and `/nep draw` do not count against a member |
| `maxPromptChars` | `800` | Scene text from the `<draw>` tag is clamped to this length |
| `reference` | `"avatar"` | What to send as a visual reference when the persona is in the picture (`self="yes"`). `"avatar"` downloads the bot's Discord avatar; any other value or `null` sends nothing |
| `referenceMaxBytes` | `4000000` | Max avatar file size (bytes); a larger avatar is skipped |
| `outputFormat` | `"png"` | Requested output format (`png`, `jpeg`, `webp`) |
| `aspectRatio` | `"auto"` | Aspect ratio (`auto`, `1:1`, `16:9`, `9:16`, etc.). For Google models, `auto` is omitted from the request |
| `timeoutMs` | `120000` | Request timeout (ms) |
| `retries` | `1` | Retries on transient failures (HTTP 408/429/5xx, network errors) |
| `provider` | `null` | OpenRouter `provider` routing for image requests, used when no `llm.providerByModel` entry matches; `null` sends nothing. Family-specific provider options (e.g. `openai.moderation`) are merged over the resolved routing |

### `image.openai`

Provider-specific options for `openai/*` image models.

| Key | Default | Meaning |
|---|---|---|
| `quality` | `"medium"` | Image quality (`auto`, `low`, `medium`, `high`; 2.5 models also accept `xhigh`, `max`) |
| `background` | `"auto"` | Background mode (`auto`, `opaque`; 2.5 models also accept `transparent`) |
| `moderation` | `"low"` | Sent as a provider passthrough under `provider.options.openai.moderation` |

### `image.google`

Provider-specific options for `google/*` image models.

| Key | Default | Meaning |
|---|---|---|
| `resolution` | `"1K"` | Output resolution (`512`, `1K`, `2K`, `4K`; support varies by model). `gemini-2.5-flash-image` has no resolution knob |

## `variety`

Settings for the variety pass (`features.variety`). The persona's own recent lines go to the `classifier.text` model, which names the repeated devices. With `features.varietyPrecompute` on, the pass starts right after the persona posts text so the next turn finds the answer ready; at the turn, a ready answer is used from cache, or the turn joins a pass already in flight and waits at most `variety.timeoutMs`. The result becomes a `<worn>` block in the turn's request. A timeout or a failed pass never delays or fails the turn; the turn simply goes without the block. A second, longer pass (`variety.longLines`) runs at most once per `variety.longEveryHours` over the ring of the persona's own lines across all channels, using `prompts/variety-long.md` on the `classifier.text` model. Its patterns are stored as `wornLong` in guild memory and stay in force until the next long pass; a turn receives them ahead of the short pass's patterns. All hot-reloaded.

| Key | Default | Meaning |
|---|---|---|
| `window` | `16` | Own lines the pass looks at, taken from the turn's channel first, then from other channels |
| `recentMinutes` | `180` | A line older than this many minutes is left out |
| `minLines` | `3` | Fewer lines than this skips the pass |
| `contextChars` | `120` | Characters kept from the message each line answered (the `(to: ...)` context) |
| `maxPatterns` | `4` | Most patterns one pass may name |
| `shapeChars` | `140` | Max characters for one shape description |
| `maxOutputTokens` | `500` | Max output tokens for the pass |
| `timeoutMs` | `8000` | How long a turn waits for a pass result (ms). A pass that outlives this wait keeps running to `requestTimeoutMs`; a late answer is stored and serves the next turn. The mentor sandbox uses this value as its request timeout |
| `requestTimeoutMs` | `30000` | Request timeout for the variety model call (ms). The pass is cut at this time; `variety.timeoutMs` is only how long a turn waits for it |
| `history` | `20` | Passes kept in the history ring for `/nep variety` |
| `longLines` | `300` | Own lines the long pass reads from the ring, across all channels with no age limit. `0` turns the long pass off |
| `longEveryHours` | `6` | Hours between long passes; a failure counts so it is not retried after every post |
| `longMinLines` | `60` | Fewer lines than this in the ring skips the long pass |
| `longMaxPatterns` | `3` | Most patterns the long pass may name |

### `variety.fillers`

Settings for the filler guard (`features.fillerGuard`). Two kinds of entry: a PREFIX entry ends with `*` (at least 3 letters before the `*`) and matches every word starting with that prefix on a word boundary; an EXACT entry (no `*`) matches the word or phrase whole. The variety passes are the main source: a word-type habit the pass finds becomes an entry with weight equal to its count. The owner can pin entries with `/nep variety add type:filler` as a fallback. The list is ranked with eviction like interests: capacity `max`, weight with recency decay (`halfLifeDays`), the weakest evicted when full. Owner-added entries are pinned: never evicted or decayed. An entry may be reused only after a cooldown in hours or in the persona's own posted messages, whichever comes first. When a fresh reply holds an entry on cooldown, the speaking model rewrites the reply without it (`prompts/reword.md`). State in guild memory: `fillers` and `ownMessageCount`.

| Key | Default | Meaning |
|---|---|---|
| `cooldownHours` | `36` | Hours since an entry's last use before it is free again |
| `cooldownMessages` | `300` | The persona's own posted messages since an entry's last use before it is free again |
| `max` | `12` | Entries kept in the list; the weakest by rank is evicted when full |
| `halfLifeDays` | `14` | Recency half-life for the entry ranking (days); same decay formula as interests |
| `maxOutputTokens` | `400` | Max output tokens for the rewrite request |

### `variety.patternCheck`

Settings for the pattern guard (`features.patternGuard`). Before posting, when the reply has at least `minChars` characters and the worn lists (short and long) are not empty, a classifier (`classifier.text`, `prompts/pattern-check.md`) checks which worn patterns the reply falls into. On a match the same rewrite request rewrites the reply without that pattern. The classifier runs during the typing simulation of the first message, so it adds no visible delay; only a rewrite does.

| Key | Default | Meaning |
|---|---|---|
| `minChars` | `15` | Minimum characters in the reply before the check runs |
| `maxOutputTokens` | `40` | Max output tokens for the pattern check classifier |

## `private`

Settings for private chat (`features.privateMessages`). All hot-reloaded. The gate checks these locally with zero tokens before any LLM request.

| Key | Default | Meaning |
|---|---|---|
| `minAffinity` | `5` | Minimum public attitude score to answer a DM; owners bypass this check |
| `maxPerUserPerDay` | `100` | DM turns per member per day that reached the model (answered or silent); a cap hit posts a limit notice once per day |
| `maxPerOwnerPerDay` | `200` | DM turns per day for bot owners that reached the model (answered or silent) |
| `purgeMaxMessages` | `5000` | Max DM messages `/nep private purge` scans (newest first) in one run |

With `features.relationships` off, public scores stay at 0, so with the default `minAffinity` only owners can DM.

## `mentor`

Settings for the manual testing sub-process (`features.mentor`). The mentor invents chat situations, runs the persona through them in a sandbox, and scores the answers. It uses its own model and its own daily token budget; nothing it does counts against `llm.maxRequestsPerDay`. All hot-reloaded.

| Key | Default | Meaning |
|---|---|---|
| `model` | `null` | Mentor model ID. `null` or missing disables all commands that need the model |
| `maxTokensPerDay` | `400000` | Daily token budget. Counted from real usage: prompt tokens x1, cached prompt tokens x`cachedTokenWeight`, output tokens x`outputTokenWeight`. Sandbox answers of the persona's voice model are counted the same way |
| `outputTokenWeight` | `5` | Weight of output tokens in the budget. Accounts for the higher cost of generated tokens |
| `cachedTokenWeight` | `0.1` | Weight of cached prompt tokens in the budget |
| `maxOutputTokens` | `6000` | Max output tokens per mentor request |
| `timeoutMs` | `300000` | Request timeout for mentor requests (ms) |
| `situations` | `5` | Chat situations invented per run |
| `situationLines` | `[6, 15]` | Min and max lines per situation |
| `samples` | `3` | Persona completions per situation. Real moments use `anchor.samples` instead |
| `check.samples` | `1` | Persona completions per situation during `/nep mentor check`. Real moments use `anchor.samples` instead |
| `pass.score` | `7` | A case passes when the median of `overall` and the median of `goal` reach this threshold |
| `pass.anchorScore` | `null` | Threshold for a real moment. When set to a number, a real moment fails the case when its median `overall` or `goal` is under that number. `null` uses `pass.score` |
| `pass.floor` | `5` | A case fails when any axis has a median below this floor. Every invented situation is held to this floor too: the case fails when the median `overall` or median `goal` of any one invented situation is under it, whatever the medians over all answers. A real moment is held to the pass score (`pass.anchorScore` when set, otherwise `pass.score`) |
| `diagnose` | `true` | After a failing or weak run, the mentor states what in the context caused the weak answers. Stored as `diagnosis` on the run; a check never asks |
| `reference.days` | `7` | Days of chat history used to build the style reference |
| `reference.samples` | `60` | Random lines (2–200 characters) picked from the reference window as style examples |
| `reference.maxMessages` | `3000` | Max messages read from the reference channels |
| `reference.rarePer1000` | `0.5` | A mark used less often than this many times per 1000 characters counts as rare |
| `reference.rareMinAuthors` | `2` | A mark used by fewer authors than this counts as rare |
| `anchor.max` | `5` | Real moments per case. Each moment is a message of the persona the owner rejected, stored with the chat that led to it |
| `anchor.contextMessages` | `30` | Messages of the channel fetched as context when resolving a moment, ending at the trigger |
| `anchor.samples` | `5` | Persona completions per real moment in a run and in `/nep mentor check` |
| `anchor.hideLaterMemory` | `true` | When replaying a real moment, hide memory written at or after its trigger (episodes, attitude changes, details, interests, aliases, learned items, lore entries). `false` replays it with all of today's memory |
| `anchor.ledgerSize` | `300` | Entries kept in the post ledger (`state.json` `postLedger`). The ledger maps each posted message to its turn so the mentor can find the trigger of a real moment. Written only while `features.mentor` is on. `0` keeps none |
| `feedbackExamples` | `10` | Latest owner corrections (`/nep mentor wrong`) included in every scoring request |

`llm.maxRequestTokens` (50k per request) applies to every request the mentor makes or causes, including sandbox answers. Before each mentor request the budget check counts the prompt plus the most the answer may cost (`mentor.maxOutputTokens` at `mentor.outputTokenWeight`), so a request is refused when its possible output does not fit what is left. When the budget runs out the run stops and reports what it has. A run also stops when `features.mentor` or `mentor.model` is turned off during it, or when the reference channels hold no messages of people in the reference window.

## `warmup`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Run the warmup automatically on first start |
| `lookbackDays` | `60` | How far back to sample (days) |
| `minMessages` | `30` | Own messages for a member to qualify |
| `maxPeople` | `40` | Members processed, most active first |
| `messagesPerPerson` | `2000` | Own messages sampled per member |
| `contextBefore` | `1` | Context lines before each sampled message |
| `maxChannelShare` | `0.5` | Max share of samples from one channel |
| `messagesPerChannel` | `200` | Newest messages a channel is described from |
| `serverSampleMessages` | `600` | Recent main-channel messages for the server request |
| `fetchLimitPerChannel` | `15000` | Messages fetched per channel for the sample pool |
| `maxOutputTokens` | `6000` | Max output tokens per warmup request |
| `maxRequestTokens` | `120000` | Max tokens per warmup request (input + output) |
| `maxTokens` | `6000000` | Total token budget for the run |
| `rateLimitWaitMinutes` | `10` | Minutes to wait on a rate limit |
| `rateLimitMaxWaits` | `36` | Consecutive waits before the run aborts |

## Models

The engine uses seven model roles. Each is set independently, so the voice can use a premium model while the helpers stay cheap.

### Voice (`llm.model`)

Role `voice`. The most capable model the budget allows. Roleplay quality, in-character consistency and natural conversation all depend on it. A smaller model breaks character, forgets context cues and sounds flat. In two-stage mode, the same model also words the persona's memory texts (stage B: relationship notes, attitude reasons, episode feelings, lessons, self-facts, server patterns, starters and the character portrait). Both kinds of request carry role `voice` in the usage log; they are told apart by purpose (`reply`, `memory-voice`).

Default: `anthropic/claude-opus-4.6`. A cheaper option: `anthropic/claude-sonnet-4.6`.

### Analyzer (`memory.model`)

Role `analyzer`. Reasons over long transcripts and returns strict JSON. Needs the same tier of intelligence as the voice. `null` (default) uses the persona's model. The same examples apply. In two-stage mode (`features.memoryTwoStage`), this model runs stage A (neutral decisions).

### Text classifiers (`classifier.text`)

The cheapest text model that can answer "yes" or "no" reliably. Runs the address classifier (`features.followUp`), the search classifier, the link reader, the search condenser and the recall summary (`features.webLookup`, `features.recall`), the re-watch classifier (`features.videoRewatch`), the room classifier (`spontaneous.roomQuestionChance`), the channel route classifier (`features.channelRoute`) and the variety pass (`features.variety`). Default: `anthropic/claude-sonnet-4.6`.

### Pictures (`classifier.media`)

Any cheap vision model. Writes one-line descriptions, so reasoning power barely matters.

Default: `anthropic/claude-haiku-4.5`. Cheapest alternative: `google/gemini-2.5-flash-lite`.

### Video (`classifier.video`)

Only models that accept BOTH video and audio input through OpenRouter work here. Models that take frames but no audio (Qwen VL, GLM, Seed, Gemma) do not hear speech and miss most of the point.

`google/gemini-flash-latest` is a floating alias whose price can change without notice. Batch (`:batch`) variants are asynchronous and unusable for a live reply. The direct-URL path (YouTube within the length cap, sent as a public URL with `media.video.provider`) needs Google AI Studio as the provider.

Cost per one-minute clip, USD, from OpenRouter prices on 2026-09-23:

| Model | ~USD / 1 min clip |
|---|---|
| `google/gemini-2.5-flash-lite` | 0.002 |
| `google/gemini-3.1-flash-lite` | 0.005 |
| `google/gemini-3.5-flash-lite` | 0.006 |
| `google/gemini-3.7-flash` | 0.014 |
| `google/gemini-3.8-flash` (default) | 0.014 |

`qwen/qwen3.8-omni-flash` also accepts video and audio. Prices change; the table is a snapshot as of the date above.

### Mentor (`mentor.model`)

Role `mentor`. Scores the persona's answers and invents test situations. A model from a different family than the voice model is recommended: a model is blind to the habits of its own family. `null` (default) leaves the mentor disabled; `/nep mentor` commands that need the model say so.

### Pictures out (`image.model`)

Separate from `classifier.media` (which describes pictures IN). This model generates pictures through OpenRouter's Images API (`POST /api/v1/images`). Only two families are supported: `openai/*` and `google/*`. An unsupported family is refused before any request or count.

**OpenAI models.** Honour `image.openai.quality`, `image.openai.background`, `image.openai.moderation`, `image.aspectRatio`, `image.outputFormat` and `input_references`.

| Model | Notes |
|---|---|
| `openai/gpt-image-2.5-flare` (default) | Fast tier |
| `openai/gpt-image-2.5-sunburst` | Editing-precision tier |
| `openai/gpt-image-2` | |
| `openai/gpt-image-1` | |
| `openai/gpt-image-1-mini` | |

**Google models.** Honour `image.google.resolution`, `image.aspectRatio`, `image.outputFormat` and `input_references`. `image.aspectRatio` of `auto` is omitted from the Google request.

| Model | Notes |
|---|---|
| `google/gemini-3.1-flash-image` | Nano Banana 2 |
| `google/gemini-3-pro-image-preview` | |
| `google/gemini-2.5-flash-image` | No resolution knob |

Pricing is per output token, not per picture; the provider's `usage.cost` is reported by `/nep draw` and logged. A request refused by the engine before it is sent (daily or per-member cap, unsupported model family) costs nothing; a generation the provider rejects is usually not billed; a timeout, or an upload that fails after the picture was generated, may still be billed.
