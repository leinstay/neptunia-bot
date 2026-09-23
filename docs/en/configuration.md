# Configuration

Every key in `config.json` with its default, grouped by section.

## `features`

| Key | Default | Meaning |
|---|---|---|
| `dryRun` | `false` | Full pipeline, never sends (see [Dry run](../../README.md#dry-run)) |
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
| `mediaDescriptions` | `true` | One-line descriptions for pictures, GIFs, video frames and link thumbnails |
| `videoDescriptions` | `true` | Watch short video clips through a video-capable model; needs `mediaDescriptions` on as well |
| `videoRewatch` | `true` | When addressed, re-watch a video to answer a question about it; needs `videoDescriptions` on |
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
| `dryRunChannelId` | `""` | Channel for dry-run mirror (see [Dry run](../../README.md#dry-run)) |
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
| `pingTimeoutMs` | `30000` | Timeout for `/nep ping` requests (ms) |
| `retries` | `2` | Retries on transient failures |
| `maxRequestsPerDay` | `300` | Daily request cap |
| `provider` | `null` | OpenRouter `provider` routing object, passed verbatim; `null` sends nothing |

`llm.provider` sets OpenRouter's provider routing field on every request, for example `{ "ignore": ["some-provider"] }` or `{ "order": ["anthropic"], "allow_fallbacks": true }`. If the OpenRouter account itself restricts allowed providers, ignoring the only one left makes every request fail with "No endpoints found". After changing provider settings, run `/nep ping` to verify that every model role is reachable.

## `context`

| Key | Default | Meaning |
|---|---|---|
| `channelMessages` | `100` | Current channel messages |
| `neighborMessages` | `5` | Messages per neighbour channel |
| `neighborMaxAgeMinutes` | `60` | Max age for neighbour messages (min) |
| `neighborMaxChannels` | `8` | Max neighbour channels |
| `maxMessageChars` | `800` | Truncate messages beyond this (chars) |
| `gapMarkerMinutes` | `20` | Time-gap marker threshold (min) |
| `otherProfiles` | `6` | Max other profiles shown |
| `askedAboutProfiles` | `3` | Members named in recent messages whose profiles are shown in full, ahead of the other participants |
| `tempo.liveMessages10min` | `4` | Messages in 10 min = "live" |
| `tempo.deadSilenceMinutes` | `45` | Silence minutes = "dead" |
| `caps.interlocutor` | `6000` | Token cap: caller's profile with episodes |
| `caps.aboutChat` | `2500` | Token cap: server habits / self-facts |
| `caps.lore` | `1500` | Token cap: lore entries |
| `caps.people` | `9000` | Token cap: other profiles |
| `caps.neighbors` | `3000` | Token cap: neighbour channels |
| `caps.server` | `4000` | Token cap: channel map |
| `channelActivity.liveMessagesPerDay` | `20` | Daily messages = "active" channel |
| `channelActivity.deadAfterDays` | `7` | Days without messages = "dead" channel |
| `vision.maxImages` | `4` | Max images per request |
| `vision.tokensPerImage` | `400` | Token budget per image |
| `vision.imageSize` | `512` | Downscale target in px, via Discord's media proxy |
| `vision.recentImages` | `3` | Recent channel images to include |
| `vision.recentImageMinutes` | `30` | Max age for recent images (min) |
| `vision.maxBytes` | `1500000` | Max image file size (bytes); larger pictures are skipped |
| `vision.fetchTimeoutMs` | `10000` | Download timeout per image (ms) |

## `media`

Settings for the media describer (`features.mediaDescriptions`).

| Key | Default | Meaning |
|---|---|---|
| `model` | `"anthropic/claude-haiku-4.5"` | Describer model |
| `maxOutputTokens` | `120` | Max output tokens per description |
| `imageSize` | `512` | Downscale target in px |
| `maxPerTurn` | `6` | Max descriptions generated per turn |
| `cacheEntries` | `5000` | Description cache size, keyed by attachment |
| `filePreviewChars` | `500` | Characters shown from the beginning of text files |
| `embedTextChars` | `200` | Characters shown from link embed text |

### `media.video`

Settings for the video describer (`features.videoDescriptions`). Video vision needs BOTH `features.mediaDescriptions` and `features.videoDescriptions` on. A separate video-capable model watches short clips: Discord video attachments and links to the sites in `media.video.sites`. Results are cached in the media cache alongside picture descriptions; a repost costs nothing.

| Key | Default | Meaning |
|---|---|---|
| `model` | `"google/gemini-3.8-flash"` | Video-capable model; must accept both video and audio input |
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | OpenRouter provider routing for the direct-URL path (YouTube within the length cap); `null` uses `llm.provider` |
| `maxOutputTokens` | `800` | Max output tokens per video summary |
| `summaryChars` | `1500` | Max characters for a video account; fills `{{maxChars}}` in `describe-video.md` |
| `maxRequestTokens` | `60000` | Token cap per video request (input + output), used instead of `llm.maxRequestTokens`; a 3-minute clip at `tokensPerSecond` is ~54 000 tokens, above the default global cap |
| `maxSeconds` | `60` | Max clip duration (seconds) for attachments and downloaded site videos; longer attachments are trimmed with `ffmpeg`, longer site videos fall back to a still frame. Direct-URL sites use `directUrlMaxSeconds` instead |
| `directUrlMaxSeconds` | `180` | Max duration (seconds) for a video sent to the provider by public URL (YouTube and other `directUrlSites`); longer ones take the download-and-clip route capped at `maxSeconds` |
| `maxBytes` | `8000000` | Max attachment size (bytes); over-size after trimming is a permanent miss |
| `maxPerTurn` | `1` | Max NEW videos per turn; every fetch attempt counts, failed or not |
| `maxPerDay` | `40` | Daily video request cap (stored in `state.json` as `videoDay`/`videoCount`) |
| `tokensPerSecond` | `300` | Token estimate per second of video for the budget check |
| `timeoutMs` | `90000` | LLM request timeout for video (ms) |
| `toolTimeoutMs` | `60000` | Timeout for `yt-dlp` and `ffmpeg` subprocesses (ms) |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | Hostnames whose links are treated as video |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | Sites whose public URL can be passed directly to the provider (the provider fetches the video itself) |
| `directUrlUnknownDuration` | `false` | Send a direct-URL-site link to the provider even when no probe could determine the duration; the token estimate uses `maxSeconds`. See the duration chain below |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | A fixed YouTube video probed at startup and by `/nep ping video` to learn which duration source works on this host |
| `ytdlpPath` | `"yt-dlp"` | Path to the `yt-dlp` binary; needed for site video links and for probing duration |
| `ffmpegPath` | `"ffmpeg"` | Path to `ffmpeg`; needed for trimming and downscaling long or large attachments |
| `errorRetryMinutes` | `60` | Minutes before an error-cached video is retried on its own; a forced retry from the re-watch classifier ignores this |
| `urlProcessing` | `"agentic"` | OpenRouter's processing mode sent on public-URL video parts; without it some providers see only a single frame. `null` omits the field |
| `reasoning` | `{ "effort": "low" }` | OpenRouter `reasoning` setting for every video request; keeps reasoning from eating the output budget. A non-object omits the field |
| `prefill` | `true` | Watch a video as soon as it arrives, so the next turn finds it cached |

Both `yt-dlp` and `ffmpeg` are optional system binaries. Without them, attachments within the caps still work (sent as-is). Longer attachments and all site links fall back to the still frame or preview picture, and the persona is told the reason. Every video request counts against `llm.maxRequestsPerDay` and the video token cap (`maxRequestTokens`).

For YouTube links, the duration is learned through a chain: yt-dlp first, then the YouTube Data API (when `YOUTUBE_API_KEY` is set in `.env`), then a scrape of the watch page. When every probe fails and `directUrlUnknownDuration` is off (the default), the link is reported as "could not load." With the switch on, the URL is sent to the provider anyway, billed as `maxSeconds` in the token estimate. The Data API key is free: enable YouTube Data API v3 in the Google Cloud console and create a key; the free quota is 10,000 units/day and one duration lookup costs 1 unit. `/nep ping video` probes `canaryUrl` and reports which source works on this host. A cached length-limit result records the video's duration and is retried when the cap is raised.

### `media.video.rewatch`

Settings for the re-watch classifier (`features.videoRewatch`). When the persona is addressed and a watched video sits in the recent transcript, a cheap classifier decides whether the message asks about one of those videos; if so, the video model watches the clip again and the answer is appended to the transcript. The classifier model defaults through `mention.followUpModel` to the media model. The second look always uses `media.video.model`.

| Key | Default | Meaning |
|---|---|---|
| `model` | `null` | Classifier model (`null` = `mention.followUpModel`, which defaults to `media.model`) |
| `maxPerDay` | `20` | Daily re-watch cap (separate from `media.video.maxPerDay`) |
| `maxOutputTokens` | `600` | Max output tokens for the re-watch answer |
| `answerChars` | `1200` | Max characters for the answer; fills `{{maxChars}}` in `rewatch-answer.md` |
| `recentMessages` | `60` | How many recent messages to scan for watched or error-state videos |
| `maxCandidates` | `6` | Max videos offered to the classifier from the recent window, newest first |
| `contextMessages` | `8` | Recent channel messages (excluding the trigger) rendered as a `<transcript>` block for the classifier; `0` omits the block |

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
| `maxPending` | `3` | Channels that can hold a direct ping while busy |
| `pendingMinutes` | `10` | Minutes before a held ping expires |
| `switchDelayMs` | `[2000, 9000]` | Pause before answering in the next channel (ms) |
| `followUpMinutes` | `2` | Follow-up window after the persona's last reply (min) |
| `followUpContext` | `15` | Transcript lines sent to the classifier |
| `followUpModel` | `null` | Classifier model (`null` = media model) |
| `followUpMaxOutputTokens` | `8` | Max output tokens for the classifier |
| `followUpNoStreak` | `3` | Consecutive `no` verdicts that close the window |

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

## `memory`

| Key | Default | Meaning |
|---|---|---|
| `model` | `null` | Analyzer model (`null` = llm.model) |
| `mainChannelIds` | `[]` | Channels where people talk to each other; the portrait of a member's character and style is drawn from them; empty means every channel counts |
| `portraitRefreshHours` | `24` | Min hours between portrait refreshes per member |
| `portraitRefreshPerDay` | `20` | Max portrait refreshes per server per day |
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
| `maxAliases` | `5` | Aliases shown to the persona and analyzer per profile |
| `maxAliasesStored` | `15` | Aliases kept per profile; the top by frequency and recency are shown |
| `aliasHalfLifeDays` | `365` | Weight half-life for aliases (days) |
| `maxInjokes` | `15` | Max server in-jokes |
| `maxSelfFacts` | `20` | Max self-claims |
| `maxEpisodes` | `20` | Max episodes kept per person |
| `maxNewEpisodes` | `3` | Max new episodes per person per batch |
| `timeoutMs` | `900000` | Analyzer timeout (ms), separate from `llm.timeoutMs` |

The analyzer prompt reads these limits as placeholders, so raising a value takes effect on the next batch. Bigger profiles cost context tokens (`context.caps.people`, `context.caps.interlocutor`) and analyzer output (`memory.maxOutputTokens`).

## `relationships`

| Key | Default | Meaning |
|---|---|---|
| `damping` | `true` | Damp score changes that push further from zero; changes toward zero apply in full |
| `dampingPower` | `1` | Exponent of the damping factor; higher values make the ends of the scale harder to reach |
| `maxDeltaPerUpdate` | `15` | Max score change per update |
| `historySize` | `10` | Attitude changes kept per member |
| `directTriggerCount` | `6` | Direct interactions that force early update |

With `damping` on, a change that pushes the score further from zero is scaled by `(1 - |score| / 100) ^ dampingPower`, so extremes take sustained effort; a change back toward zero applies at full strength. The score is stored with fractional precision and shown as a whole number; `/nep memory affinity` sets it directly without damping.

## `lore`

| Key | Default | Meaning |
|---|---|---|
| `maxEntries` | `500` | Max lorebook entries per server |
| `scanMessages` | `30` | Messages scanned for key matches |
| `maxMatches` | `8` | Max entries shown per request |
| `textChars` | `600` | Lore entry text limit (chars) |

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
| `refreshMessages` | `400` | Messages sampled for a portrait refresh |
| `fetchLimitPerChannel` | `15000` | Messages fetched per channel for the sample pool |
| `maxOutputTokens` | `6000` | Max output tokens per warmup request |
| `maxRequestTokens` | `120000` | Max tokens per warmup request (input + output) |
| `maxTokens` | `6000000` | Total token budget for the run |
| `rateLimitWaitMinutes` | `10` | Minutes to wait on a rate limit |
| `rateLimitMaxWaits` | `36` | Consecutive waits before the run aborts |

## Choosing models

The engine uses five model roles. Each is set independently, so the voice can use a premium model while the helpers stay cheap.

### `llm.model` — the persona's voice

The most capable model the budget allows. Roleplay quality, in-character consistency and natural conversation all depend on it. A smaller model breaks character, forgets context cues and sounds flat.

Default: `anthropic/claude-opus-4.6`. A cheaper option: `anthropic/claude-sonnet-4.5`.

### `memory.model` — the analyzer

Reasons over long transcripts and returns strict JSON. Needs the same tier of intelligence as the voice. `null` (default) uses the persona's model. The same examples apply.

### `media.model` — pictures

Any cheap vision model. Writes one-line descriptions, so reasoning power barely matters.

Default: `anthropic/claude-haiku-4.5`. Cheapest alternative: `google/gemini-2.5-flash-lite`.

### `mention.followUpModel` — the address classifier

The cheapest text model that can answer "yes" or "no" reliably. `null` (default) uses the media model.

The re-watch classifier (`media.video.rewatch.model`) is an optional override for the same kind of job: decide whether a message asks about a watched video. `null` (default) uses the follow-up model, then the media model. It is not a separate role; the second look always uses the video model.

### `media.video.model` — video with sound

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
