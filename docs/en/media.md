# Media

What the persona can see, hear and read, and the helpers that make it happen.

Transcript lines carry media markers in brackets: pictures, GIFs, videos, stickers, custom emoji, voice messages, audio files, links, text file previews and forwarded messages. What the persona actually perceives depends on the features below. A `<senses>` block in the user message tells the persona what is on and what is off under the current config; it trusts this block and never claims to have seen, heard or opened anything beyond it.

## Pictures

`features.vision` attaches pictures from the calling message, from the message it replies to, and the newest few in the channel to the LLM request as images, downscaled through Discord's media proxy. The bot downloads every picture itself and sends it inline as data, because Discord refuses downloads coming from the model provider. Pictures larger than `context.vision.maxBytes` or slower than `context.vision.fetchTimeoutMs` are skipped. The persona sees these directly.

`features.mediaDescriptions` (on by default) runs the `classifier.media` model to write a one-line description for pictures, GIF frames, video posters, stickers, custom emoji and link thumbnails. Each attachment is described once and cached in `data/guilds/<id>/media.json`. Descriptions feed the chat transcript, the memory analyzer and the warmup. The describer's prompt is `prompts/describe.md`.

Stickers and custom emoji recur constantly, so they are cached by id and cost nearly nothing after the first description. With `features.vision`, the sticker of the calling message is attached as a picture. Discord's built-in animated stickers are Lottie animations, not images, so they are never more than a name.

Settings: `context.vision.*` for direct vision, `media.*` for the describer. See [Configuration](configuration.md#media) for every key.

## Video

`features.videoDescriptions` is off by default; turn it on in `config.local.json`, with `mediaDescriptions` on as well. It adds the `classifier.video` model, which watches short clips: Discord video attachments and links to known video sites (YouTube, TikTok, VK, X, Reddit, Twitch). The model must accept both video and audio input through OpenRouter.

### Caps

Attachments and downloaded site videos are capped at `media.video.maxSeconds` (default 180 s) and `media.video.maxBytes` (over-size files are re-encoded to 360p at a capped bitrate first; only a clip still too large after re-encoding is refused). In agentic mode (`urlProcessing`, the default), public-URL videos (YouTube and other `directUrlSites`) up to `directUrlMaxSeconds` (default 3600 s, one hour) are sent by URL to the pinned provider; in other modes the effective cap is the smaller of this value and `maxRequestTokens / tokensPerSecond` (500 s with the defaults). Longer videos take the download route (first `maxSeconds` via yt-dlp), which YouTube often blocks with a bot check on servers. At most `maxPerTurn` new videos per turn (every attempt counts, failed or not) and `maxPerDay` per day. Results are cached alongside picture descriptions; a repost costs nothing.

### Tools

Everything beyond attachments within the caps is downloaded with `yt-dlp` and trimmed with `ffmpeg`, both optional system binaries. Without them, attachments within the caps still work (sent as-is). Longer attachments and all site links fall back to a still frame. For YouTube, when `yt-dlp` cannot probe the duration, an optional `YOUTUBE_API_KEY` in `.env` (free, from the Google Cloud console's YouTube Data API v3) or a watch-page scrape provides it. `/nep ping classifier.video` reports the API key status.

### Re-watch

When someone addresses the persona with a question about a video it has already watched, a classifier (`prompts/rewatch.md`, on the `classifier.text` role) decides whether a second look is needed. If so, the video model watches the clip again with `prompts/rewatch-answer.md` and the answer appears in the transcript alongside the original summary. The same classifier can retry a video that failed to load when the person asks about it again. At most one re-watch or retry per turn; answers are cached for one hour. Switch `features.videoRewatch` (default on).

The video prompt is `prompts/describe-video.md`. Settings live under `media.video`. See [Configuration](configuration.md#mediavideo) for every key and a model comparison table.

## Links

`features.webLookup` (off by default; unlike other features, a missing key counts as off) lets the persona open links posted in the chat and read them.

When the feature is on and `web.links.enabled` is not false, a link in the transcript (http/https only, private addresses refused, video-site links excluded, `web.links.skipSites` excluded) is fetched through an SSRF-guarded page fetcher (size capped at `web.links.maxBytes`, timeout `web.links.fetchTimeoutMs`, at most 3 redirects, html and plain text only). The page text is condensed by the `classifier.text` model through `prompts/read-link.md` into an excerpt of at most `web.links.summaryChars` characters. The excerpt is appended to the link's transcript tag as `transcript.linkRead` and appears as first-hand: the persona opened and read the page itself, within that excerpt. Unreadable pages (paywalls, consent screens, login gates, empty content) are detected and cached as a miss. Links whose URL path ends with an image, video, audio or archive extension (png, jpg, jpeg, gif, webp, avif, svg, mp4, webm, mov, mkv, mp3, ogg, wav, zip, rar, 7z, pdf) are never read regardless of the host, and `web.links.skipSites` (subdomains included) skips Discord CDN, Tenor, Giphy, Klipy, Imgur, Reddit media and Twitter images by default.

With `web.links.prefill` on (the default), links are read as soon as they arrive so the next turn finds them cached. The prefill is capped at `web.links.prefillPerUserPerDay` (default 10) per member per day; the turn path is not limited by it. Each fetch attempt during a turn counts against `web.links.maxPerTurn` (default 2). Link reads and searches share a daily counter capped at `web.maxPerDay` (default 60).

Read results are cached in the media cache: `read:<link.id>` holds the excerpt or a miss (skipped for 6 hours). The `<senses>` block includes `senses.linksRead` when the feature is on, telling the persona that a link may come with a read excerpt.

## Search

When the persona is addressed and the trigger message asks something that needs facts from outside the chat, a classifier (`prompts/lookup.md`, on the `classifier.text` role) phrases a web search query. The search runs through Brave Search (`BRAVE_SEARCH_API_KEY` in `.env`; free tier: 2,000 queries/month, then $5 per 1,000), the numbered results are condensed through `prompts/search-summary.md`, and the answer appears in a `<lookup>` block right before `<chat>`.

The classifier fires only when all of these hold: there is a trigger, `features.webLookup` is on, `web.search.enabled` is not false, the `lookup.md` prompt exists, `web.search.maxPerTurn` is at least 1, and a `BRAVE_SEARCH_API_KEY` is configured. Without a key, link reading still works but search does not.

At most one search per turn; both the classifier and the condenser count against `llm.maxRequestsPerDay`. Results are cached for `web.search.cacheHours` (default 24) hours per normalised query. The `<senses>` block includes `senses.search` only when a Brave key is configured.

Settings live under `web`. See [Configuration](configuration.md#web) for every key. The contract between the prompt files and the code is in [Prompt contract](prompt-contract.md).

## Blind spots

Voice messages show only duration. Audio files show a name and duration. The persona cannot hear either. How it handles a blind spot is the character card's call.

## Cost

Each turn is one LLM request; a memory update adds a second. Video descriptions add one request per watched clip to the `classifier.video` model (`media.video.maxPerDay` caps the daily count); `yt-dlp` and `ffmpeg` run locally and cost nothing beyond bandwidth. Link reads and searches add requests to the `classifier.text` model, capped by `web.maxPerDay` (shared) and `llm.maxRequestsPerDay` (global). Search additionally needs a Brave Search key; the free tier handles a low-traffic server.

## Privacy

With `features.webLookup` on, the bot makes outbound HTTP requests to read pages and to the Brave Search API. Pages are fetched directly from the host; private addresses (loopback, link-local, private ranges) are refused. Page content is sent to the `classifier.text` model through the LLM endpoint for condensation; neither the page text nor the search query is logged. `data/` holds the cached excerpts and search results on your machine, gitignored, sent to the LLM as context only.
