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
| `seeReactions` | `true` | Show reactions on messages in the transcript. A missing key counts as on. Distinct from `reactions`, which controls whether the persona PLACES reactions; this one controls whether it SEES them |
| `customEmoji` | `true` | List the server's custom emoji ranked by usage so the persona can use them by `:name:`. A missing key counts as on |
| `gifs` | `true` | Build a GIF library from what members share (Tenor, Giphy links and .gif attachments) and let the persona post from it by handle. A missing key counts as on |
| `multiMessage` | `true` | Allow 2–3 messages in a row |
| `vision` | `true` | Process attached images |
| `mediaDescriptions` | `true` | One-line descriptions for pictures, GIFs, video frames and link thumbnails |
| `attachedDescriptions` | `true` | Run the describer for pictures that are also attached to the request. Without this, attached pictures carry no helper's caption. A missing key counts as on. Needs both `vision` and `mediaDescriptions` on; one extra describer request per new picture, within `media.maxPerTurn` |
| `videoDescriptions` | `false` | Watch short video clips through a video-capable model; needs `mediaDescriptions` on as well. Turn on in `config.local.json`; still needs a video-capable model and, for site links, `yt-dlp`/`ffmpeg` |
| `videoRewatch` | `true` | When addressed, re-watch a video to answer a question about it; needs `videoDescriptions` on |
| `webLookup` | `false` | Read links posted in chat and search the web when asked a factual question. Unlike other features, a missing key counts as OFF. Needs `BRAVE_SEARCH_API_KEY` in `.env` for search; without it only link reading works. See [Media: Links and search](media.md#links) |
| `imageGeneration` | `false` | Let the persona draw pictures through a drawing sub-process. A missing key counts as on. Turn on in `config.local.json`; needs an image-capable model in `image.model`. See [Media: Drawing](media.md#drawing) |
| `privateMessages` | `false` | Answer direct messages from guild members. Needs a stored public profile and `affinity.score >= private.minAffinity`. See [Messages and memory: Private layer](messages-and-memory.md#private-layer) |
| `mentor` | `false` | Manual testing sub-process with its own model. Must be exactly `true` to enable; a missing key counts as off. See [Mentor](#mentor) |
| `mentorAutoFix` | `false` | After a failed `/nep mentor run`, continue into a repair loop that proves the diagnosis by ablation, writes one verified edit and applies it. Must be exactly `true` to enable |
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
| `pingTimeoutMs` | `30000` | Timeout for `/nep ping` requests (ms) |
| `retries` | `2` | Retries on transient failures |
| `maxRequestsPerDay` | `300` | Daily request cap |
| `provider` | `null` | OpenRouter `provider` routing object, passed verbatim; `null` sends nothing |

`llm.provider` sets OpenRouter's provider routing field on every request, for example `{ "ignore": ["some-provider"] }` or `{ "order": ["anthropic"], "allow_fallbacks": true }`. If the OpenRouter account itself restricts allowed providers, ignoring the only one left makes every request fail with "No endpoints found". After changing provider settings, run `/nep ping` to verify that every model role is reachable.

## `classifier`

The three helper model roles, grouped under one key. Each is set independently, so the helpers can stay on cheap models while the voice uses a premium one.

| Key | Default | Meaning |
|---|---|---|
| `text` | `"anthropic/claude-sonnet-4.6"` | Text classifiers: the address classifier (`features.followUp`), the re-watch classifier (`features.videoRewatch`) and the search classifier (`features.webLookup`). Also condenses link reads and search results |
| `media` | `"anthropic/claude-haiku-4.5"` | Picture describer (`features.mediaDescriptions`): one-line descriptions for pictures, GIF frames, video posters, stickers, custom emoji and link thumbnails |
| `video` | `"google/gemini-3.8-flash"` | Video describer (`features.videoDescriptions`): watches short clips, re-watches on a question, retries on request. Must accept both video and audio input |

**Migration from the old keys.** The deprecated keys `llm.classifierModel`, `mention.followUpModel`, `media.model` and `media.video.model` are no longer read. If any of them is present in `config.local.json`, the bot logs a startup warning (`config: deprecated model key ignored`) naming the key and its replacement. Move the value to `classifier.text`, `classifier.media` or `classifier.video` respectively.

## `context`

| Key | Default | Meaning |
|---|---|---|
| `channelMessages` | `100` | Current channel messages |
| `neighborMessages` | `5` | Messages per neighbour channel |
| `neighborMaxAgeMinutes` | `60` | Max age for neighbour messages (min) |
| `neighborMaxChannels` | `8` | Max neighbour channels |
| `maxMessageChars` | `800` | Truncate messages beyond this (chars) |
| `gapMarkerMinutes` | `20` | Time-gap marker threshold (min) |
| `reactionsPerMessage` | `6` | Max reactions listed per message in the transcript, most frequent first |
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
| `caps.emoji` | `800` | Token cap: custom emoji |
| `caps.gifs` | `600` | Token cap: GIF library |
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

## `gifs`

Settings for the GIF library (`features.gifs`). Uses are counted as each message arrives (members only, bots and the persona excluded). A one-time backfill from channel history seeds the ranking at startup.

| Key | Default | Meaning |
|---|---|---|
| `max` | `20` | GIFs shown in the `<gifs>` block, ranked by recency-weighted use |
| `storeMax` | `300` | GIFs kept in the library; the top `max` are shown |
| `halfLifeDays` | `30` | Recency half-life for the usage ranking (days); same formula as custom emoji |
| `maxPerDay` | `40` | GIFs the persona may post per day |
| `backfillMessages` | `500` | Messages read per channel from history at startup to seed the library. Runs once when `features.gifs` is on and no backfill has run yet for this server. `0` disables |
| `backfillDescribe` | `20` | Top GIFs by rank that are sent to the describer for a caption right after the backfill; the rest get captions as the chat meets them |

## `media`

Settings for the media describer (`features.mediaDescriptions`). The describer model is `classifier.media`.

| Key | Default | Meaning |
|---|---|---|
| `maxOutputTokens` | `120` | Max output tokens per description; raise for a reasoning model whose thinking counts against this cap |
| `descriptionChars` | `200` | Max characters for a picture description; the first line is kept and cut on a word boundary. Fills `{{maxChars}}` in `describe.md` when the placeholder is present |
| `imageSize` | `512` | Downscale target in px |
| `maxPerTurn` | `6` | Max descriptions generated per turn |
| `cacheEntries` | `5000` | Description cache size, keyed by attachment |
| `filePreviewChars` | `500` | Characters shown from the beginning of text files |
| `embedTextChars` | `200` | Characters shown from link embed text |

### `media.video`

Settings for the video describer (`features.videoDescriptions`). Video vision needs BOTH `features.mediaDescriptions` and `features.videoDescriptions` on. The video model is `classifier.video`. A separate video-capable model watches short clips: Discord video attachments and links to the sites in `media.video.sites`. Results are cached in the media cache alongside picture descriptions; a repost costs nothing.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | OpenRouter provider routing for the direct-URL path (YouTube within the length cap); `null` uses `llm.provider` |
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

Both `yt-dlp` and `ffmpeg` are optional system binaries. Without them, attachments within the caps still work (sent as-is). Longer attachments and all site links fall back to the still frame or preview picture, and the persona is told the reason. Every video request counts against `llm.maxRequestsPerDay` and the video token cap (`maxRequestTokens`).

For YouTube links, the duration is learned through a chain: yt-dlp first, then the YouTube Data API (when `YOUTUBE_API_KEY` is set in `.env`), then a scrape of the watch page. When every probe fails and `directUrlUnknownDuration` is off (the default), the link is reported as "could not load." With the switch on, the URL is sent to the provider anyway, billed as `maxSeconds` in the token estimate. The Data API key is free: enable YouTube Data API v3 in the Google Cloud console and create a key; the free quota is 10,000 units/day and one duration lookup costs 1 unit. `/nep ping classifier.video` probes `canaryUrl` and reports the API key status (e.g. `youtube: API key — ok`). A cached length-limit result records the video's duration and is retried when the cap is raised.

### `media.video.rewatch`

Settings for the re-watch classifier (`features.videoRewatch`). When the persona is addressed and a watched video sits in the recent transcript, a cheap classifier decides whether the message asks about one of those videos; if so, the video model watches the clip again and the answer is appended to the transcript. The classifier uses `classifier.text`. The second look always uses `classifier.video`.

| Key | Default | Meaning |
|---|---|---|
| `maxPerDay` | `20` | Daily re-watch cap (separate from `media.video.maxPerDay`) |
| `maxOutputTokens` | `600` | Max output tokens for the re-watch answer |
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
| `maxPending` | `3` | Channels that can hold a direct ping while busy |
| `pendingMinutes` | `10` | Minutes before a held ping expires |
| `switchDelayMs` | `[2000, 9000]` | Pause before answering in the next channel (ms) |
| `followUpMinutes` | `15` | Follow-up window after the persona's last reply (min) |
| `followUpContext` | `15` | Transcript lines sent to the classifier |
| `followUpMaxOutputTokens` | `8` | Max output tokens for the classifier |
| `followUpNoStreak` | `3` | Consecutive `no` verdicts that close the window |

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
| `maxLearned` | `20` | Lessons shown to the analyzer and the chat model |
| `maxLearnedStored` | `60` | Lessons kept on disk; the top by frequency and recency are shown |
| `learnedChars` | `160` | Max chars per lesson |
| `learnedHalfLifeDays` | `720` | Weight half-life for lessons (days) |
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

## `web`

Settings for the web lookup (`features.webLookup`). Both link reading and search share a daily counter (`web.maxPerDay`). Results are cached in the media cache (`data/guilds/<id>/media.json`). All model calls go through the `classifier.text` role.

| Key | Default | Meaning |
|---|---|---|
| `maxPerDay` | `60` | Shared daily cap for link reads and search requests combined |

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
| `cacheHours` | `24` | Hours a cached search result is served before re-searching |
| `contextMessages` | `50` | Recent channel messages rendered as a `<transcript>` for the search classifier |
| `timeoutMs` | `10000` | Brave Search request timeout (ms) |

## `image`

Settings for the drawing sub-process (`features.imageGeneration`). The persona emits a `<draw>` tag; code generates one picture through OpenRouter's Images API and posts it as its own message. Generation and daily counts are stored in `data/state.json` (`imageDay`, `imageCount`, `imageUsers`). All pictures go through `image.model`, not the chat or classifier models.

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
| `provider` | `null` | OpenRouter `provider` routing object for image requests; `null` sends nothing. Family-specific provider options (e.g. `openai.moderation`) are merged over this |

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
| `maxTokensPerDay` | `400000` | Daily token budget. Counted from real usage: prompt tokens x1, cached prompt tokens x`cachedTokenWeight`, output tokens x`outputTokenWeight`. Sandbox answers of the persona's talk model are counted the same way |
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
| `suspects` | `2` | Causes from the diagnosis tested per attempt in the repair loop |
| `ablationGain` | `1` | Minimum rise in the median `overall` when a suspect is removed for the suspect to count as confirmed |
| `ablationSamples` | `2` | Persona completions per situation during an ablation measurement |
| `fix.maxAttempts` | `3` | Maximum repair attempts per run |
| `fix.maxGrowthChars` | `300` | Maximum characters a prompt file may grow by in one edit |
| `fix.layers` | `["rules", "prompt", "self", "learned", "guild"]` | Layers an edit may touch. The character card is never editable regardless of this list. A deployment may add `profile` to the list |
| `fix.files` | `["system-prompt", "format", "reply", "memory", "profile"]` | Prompt files that may receive a local override. A reply case's files are the configured list intersected with `system-prompt`, `format`, `reply`; a memory case edits only the memory writer's prompts, only through the `prompt` layer |
| `regression.situations` | `2` | Stored situations of each other active case replayed for the regression check |
| `regression.tolerance` | `1` | Maximum allowed drop in a stored situation's median `overall` against its own recorded median |
| `verify.situations` | `3` | Fresh situations invented for the verification of an edit |
| `verify.samples` | `2` | Persona completions per situation during verification |
| `verify.minSituations` | `2` | Minimum fresh situations that must survive filtering; fewer refuses the attempt as `too few fresh situations` |
| `reference.days` | `7` | Days of chat history used to build the style reference |
| `reference.samples` | `60` | Random lines (2–200 characters) picked from the reference window as style examples |
| `reference.maxMessages` | `3000` | Max messages read from the reference channels |
| `reference.rarePer1000` | `0.5` | A mark used less often than this many times per 1000 characters counts as rare |
| `reference.rareMinAuthors` | `2` | A mark used by fewer authors than this counts as rare |
| `anchor.max` | `5` | Real moments per case. Each moment is a message of the persona the owner rejected, stored with the chat that led to it |
| `anchor.contextMessages` | `30` | Messages of the channel fetched as context when resolving a moment, ending at the trigger |
| `anchor.samples` | `5` | Persona completions per real moment in a run and in `/nep mentor check`. The repair loop's control and ablation use `ablationSamples`, verification uses `verify.samples` |
| `anchor.hideLaterMemory` | `true` | When replaying a real moment, hide memory written at or after its trigger (episodes, attitude changes, details, interests, aliases, learned items, lore entries). `false` replays it with all of today's memory |
| `feedbackExamples` | `10` | Latest owner corrections (`/nep mentor wrong`) included in every scoring request |

`llm.maxRequestTokens` (50k per request) applies to every request the mentor makes or causes, including sandbox answers. Before each mentor request the budget check counts the prompt plus the most the answer may cost (`mentor.maxOutputTokens` at `mentor.outputTokenWeight`), so a request is refused when its possible output does not fit what is left. When the budget runs out the run stops and reports what it has. A run also stops when `features.mentor` or `mentor.model` is turned off during it, or when the reference channels hold no messages of people in the reference window.

When a repair edits a member's profile (`profile` layer), code checks that numbers, dates, names and `<@id>` mentions in the field stay unchanged. Only the wording may change.

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

## Models

The engine uses five model roles. Each is set independently, so the voice can use a premium model while the helpers stay cheap.

### Voice (`llm.model`)

Role `talk`. The most capable model the budget allows. Roleplay quality, in-character consistency and natural conversation all depend on it. A smaller model breaks character, forgets context cues and sounds flat.

Default: `anthropic/claude-opus-4.6`. A cheaper option: `anthropic/claude-sonnet-4.6`.

### Analyzer (`memory.model`)

Role `analyzer`. Reasons over long transcripts and returns strict JSON. Needs the same tier of intelligence as the voice. `null` (default) uses the persona's model. The same examples apply.

### Text classifiers (`classifier.text`)

The cheapest text model that can answer "yes" or "no" reliably. Runs the address classifier, the re-watch classifier, the search classifier, and condenses link reads and search results. Default: `anthropic/claude-sonnet-4.6`.

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

Role `mentor`. Scores the persona's answers and invents test situations. A model from a different family than the talk model is recommended: a model is blind to the habits of its own family. `null` (default) leaves the mentor disabled; `/nep mentor` commands that need the model say so.

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
