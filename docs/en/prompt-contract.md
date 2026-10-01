# Prompt contract

Where the prompt files and the code (`src/behavior/prompt.js`, `src/llm/parse.js`, `src/discord/format.js`,
`src/memory/update.js`, `src/memory/channels.js`, `src/memory/warmup.js`) meet. Change one side only with the
other. See `CONTRIBUTING.md` for the workflow around changes.

## Layers

| Directory | Tracked | Content |
|---|---|---|
| `prompts/` | yes | English engine defaults + a neutral example character. Works out of the box |
| `prompts.local/` | no | A deployment's overrides: a file replaces the default of the same name; `labels.json` is deep-merged |

Both hot-reloaded. `/nep rule add` writes to `prompts.local/rules.md` (seeded from the default), never to `prompts/`.
All instructions are English in both layers; a character's speech samples may be in the language it speaks.

## Files

| File | Required | Role | Placeholders |
|---|---|---|---|
| `system-prompt.md` | yes | Character-agnostic rules for acting like a chat member: length, anti-AI rules, use of context, attitude toward people, boundaries. Says the card wins on voice | `{{name}}` |
| `character-card.md` | yes | The personality: who, character, voice and language, meta layer, **what earns and loses their good opinion** (read by the analyzer), reference lines. The one file a deployer rewrites | `{{name}}` |
| `rules.md` | no | Owner's live corrections, override the two above. **Must end with the bullet list under its last `## ` heading.** Code appends `- …` lines | `{{name}}` |
| `format.md` | yes | The output protocol | none |
| `reply.md` | yes | Task: somebody called the persona | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `interject.md` / `initiate.md` | yes | Tasks: cut into a live conversation / start a topic in a silent chat | `{{name}}` |
| `forced.md` | no | Appended after the mode prompt on a forced turn (`/nep interject`, `/nep initiate`). Overrides the `<skip/>` default | `{{name}}` |
| `memory.md` | yes | Out-of-character prompt of the stream analyzer: targeted edits to memory from live batches | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` |
| `profile.md` | yes | Warmup / portrait refresh: one member's profile from a message sample | `{{name}}` `{{fieldChars}}` `{{maxInterests}}` `{{maxDetails}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{maxNewEpisodes}}` |
| `channel.md` | yes | Warmup: channel notes from a message sample | `{{fieldChars}}` |
| `server.md` | yes | Warmup: server-level notes from channel notes and member summaries | `{{name}}` `{{fieldChars}}` `{{maxInjokes}}` `{{loreTextChars}}` |
| `describe.md` | yes | Out-of-character prompt of the media describer (`features.mediaDescriptions`): one picture in, one plain line out: the action and the point, legible text quoted in its original script. Always English. No commentary, no moralising, no markdown | `{{today}}` `{{maxChars}}` (optional) |
| `describe-video.md` | yes | Out-of-character prompt of the video describer (`features.videoDescriptions`): one video clip in (with sound), a full ordered account out: who appears, what is said (key phrases quoted), text on screen, what happens visually, music/sound when relevant. Configurable length. Always English; speech, captions and on-screen text quoted in their original language. No character card | `{{today}}` `{{maxChars}}` |
| `describe-gif.md` | no | Out-of-character prompt for the GIF describer (`media.gif.watch`): a short silent clip in, one compact line out: the action, what it expresses, visible text. Always English. No character card. Falls back to `describe-video.md` when absent | `{{today}}` `{{maxChars}}` `{{seconds}}` |
| `rewatch.md` | yes | Classifier: does this message need the persona to re-watch a video or retry one that did not load (`features.videoRewatch`). Receives a numbered list of recent videos with their status and the new message. Output is ONE line: `<number> \| <question>`, `<number> \| retry` or `none` | `{{name}}` |
| `rewatch-answer.md` | yes | Out-of-character prompt for the re-watch answer: the video model watches a clip again and answers one question in the language of the question. No character card | `{{today}}` `{{question}}` `{{maxChars}}` |
| `address.md` | yes | Classifier: is this untagged message addressed to the persona | `{{name}}` |
| `lookup.md` | no | Classifier: does the persona need to search the web to answer this message (`features.webLookup`). Receives a short transcript and a `<candidate>` block. Output is ONE line: a search query (plain words, at most 12) or `none` | `{{name}}` `{{today}}` |
| `read-link.md` | no | Out-of-character prompt for the link reader (`features.webLookup`, `web.links.enabled`): condense a fetched page into one paragraph. Receives the page title and body. No character card | `{{today}}` `{{maxChars}}` |
| `search-summary.md` | no | Out-of-character prompt for the search condenser (`features.webLookup`, `web.search.enabled`): condense numbered search results into one note with inline sources. No character card | `{{today}}` `{{query}}` `{{maxChars}}` |
| `private.md` | no | Appended after the mode prompt (`reply.md`), before `forced.md`, only in a DM (`features.privateMessages`). This is a private conversation: what is said here stays here; the persona keeps its public knowledge. A missing file adds nothing | `{{name}}` `{{author}}` |
| `draw.md` | yes | Out-of-character prompt of the drawing sub-process (`features.imageGeneration`): produces one picture from a scene description. Receives only the appearance and the request — never the character card | `{{name}}` `{{appearance}}` `{{request}}` |
| `appearance.md` | no | The persona's visual look, inserted into `draw.md` when `self="yes"`. One paragraph, no personality, no backstory | `{{name}}` |
| `mentor-situations.md` | no | Mentor: invent test chat situations for a reply-target case (`features.mentor`). Returns JSON only | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-situations-memory.md` | no | Mentor: invent test chat excerpts for a memory-target case (`features.mentor`). Returns JSON only | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-score.md` | no | Mentor: score the persona's answers to a situation (`features.mentor`). Receives the character card. Returns JSON only | `{{name}}` |
| `mentor-score-memory.md` | no | Mentor: score the text the analyzer would store (`features.mentor`). No character card. `character` axis is always `null`. Returns JSON only | `{{name}}` |
| `mentor-signs.md` | no | Mentor: known habits of model-written text, sent as the `<signs>` block in every mentor request (`features.mentor`). Omitted when missing or empty | `{{name}}` |
| `mentor-diagnose.md` | no | Mentor: explain weak answers after scoring by pointing at specific text in the persona's context (`features.mentor`). The result is an unverified opinion stored as `diagnosis` on the run. Omitted when `mentor.diagnose` is false or the file is missing | `{{name}}` |
| `variety.md` | no | `classifier.text` request: name the repeated devices in the persona's own recent lines (`features.variety`). No character card | `{{name}}` `{{maxPatterns}}` `{{shapeChars}}` |
| `labels.json` | yes | Every string the CODE inserts into a prompt. Keys fixed below, values are the writer's | see below |

`{{name}}` bot's display name · `{{author}}` caller's display name · `{{trigger}}` one of `labels.triggers.*` ·
`{{target}}` index of the calling message (`#87`).
System message = `system-prompt` + `character-card` + `rules` + `format`. For the analyzer: `memory.md` alone.
On a forced turn (`/nep interject`, `/nep initiate`), `forced.md` is appended after the mode prompt if the file exists.
In a private chat, `private.md` is appended after the mode prompt (before `forced.md`) with the same `{{name}}` and `{{author}}` placeholders.
The analyzer and the warmup's `profile.md` and `server.md` receive the character card and `rules.md` as a
`<character>` block in the user message. `channel.md`, `describe.md`, `describe-video.md`, `describe-gif.md`, `draw.md`, `rewatch.md`, `rewatch-answer.md`, `address.md`, `lookup.md`, `read-link.md`, `search-summary.md` and `variety.md` do not receive the card.

`{{guildFieldChars}}` is `fieldChars * 2`, the limit code clamps guild-level patterns and starters to.
`{{maxEpisodes}}` is the total episodes kept per person. Both are filled from config but not used by the default
prompts; a custom `memory.md` may reference them.

## Blocks

The blocks of the user message. Empty ones are omitted; the order below is the order in the request.

| Block | Content |
|---|---|
| `<now>` | Date, weekday, time in `config.bot.timezone`, formatted with `labels.locale` |
| `<senses>` | What the persona can and cannot perceive RIGHT NOW, generated from the live config: which pictures it sees itself, which come as a helper's description, what it is blind and deaf to. So it never pretends to have watched a video and can joke about it in its own voice |
| `<about_chat>` | How people talk here, how they start and cut into conversations, in-jokes, things people taught the persona |
| `<emoji>` | Custom emoji the persona can use (`features.customEmoji`): at most `context.customEmoji.max` entries, ranked by member usage. Each carries `:name:` and the helper's caption when one is cached |
| `<gifs>` | GIFs the persona can post (`features.gifs`): at most `gifs.max` entries from the library, ranked by recency-weighted use. Each carries the handle (`g1`, `g2`, …) and the helper's caption when one is cached |
| `<server>` | The CURRENT channel in full (Discord category and topic, purpose, what people write, tone, activity, last message, top writers; marked with `labels.server.currentMark`) plus only the neighbour channels that fed `<other_channels>` this turn; no other channel |
| `<lore>` | Server lore entries whose keys occur in the recent messages (plus entries marked always): events, recurring characters, long-running stories. Like a lorebook: hundreds may exist, only the relevant few are shown |
| `<self_facts>` | What the persona has claimed about itself |
| `<people>` | Member profiles; the caller first, marked with `labels.profile.interlocutorMark`; each with the persona's attitude and, for the caller, the **episodes**: moments the persona remembers about the two of them, with dates and short quotes |
| `<other_channels>` | Up to `context.neighborMessages` messages per neighbouring channel, not older than `context.neighborMaxAgeMinutes` |
| `<worn>` | Devices the persona is overusing in its own recent lines (`features.variety`): `labels.variety.intro`, then `- <shape> ("<example>", ...)` per pattern. Omitted when the variety pass did not run, returned nothing, or the switch is off |
| `<lookup>` | What the persona looked up online this turn (`features.webLookup`): the query, the condensed answer and the source sites, or a "nothing found" line. Appears only when the search classifier fired and the search completed |
| `<chat>` | Up to `context.channelMessages` latest messages of the current channel |
| `<tempo>` | Counts for 10 min / hour / day, distinct people, silence, a verdict (live / slow / dead) |
| `<task>` | `reply` / `interject` / `initiate`, placeholders filled |

Budget priority (sections are trimmed from the bottom of this list first): system + task + clock + tempo + senses
(never cut) → caller's profile with episodes → lookup (kept or dropped whole) → about_chat → self_facts → lore → server → chat (newest first) →
other profiles → worn (kept or dropped whole) → other channels → emoji (entries from the bottom, then the whole block; `context.caps.emoji`) → gifs (same trimming; `context.caps.gifs`).

Media in a transcript line, most informative form available: a picture attached to THIS request →
`transcript.imageAttached`, or `transcript.imageAttachedDescribed` when `features.attachedDescriptions` is on and
the helper captioned it (numbered in the order the pictures follow the text); a described one →
`imageDescribed` / `gifDescribed` / `videoDescribed`; otherwise the blind forms `image` / `gif` / `video`.
When video vision is on (`features.mediaDescriptions` AND `features.videoDescriptions`), a video or video-site link
gains a state: `videoWatched` (first-hand, seen and heard), `videoNotWatchedFrame` (not watched but a still frame was
described), or `videoNotWatched` (not watched, no frame). The reason code (`length` / `size` / `daily` / `error`) is
swapped for the human phrase from `transcript.videoReason.*` before it reaches the transcript. Links keep their base
tag (`link` / `linkText`) and add a video extra: `linkWatched`, `linkNotWatchedFrame` or `linkNotWatched`. When a still
frame is attached as a picture, `frameAttached` is added as well. Links use `link` / `linkText` built from Discord's
embed (site, title, snippet); when `features.webLookup` is on and the link was read, `linkRead` is appended after the
link's other extras (video, thumbnail). Text files show their beginning via `filePreview`; a forwarded message is
wrapped in `forwarded`. When `features.seeReactions` is on (the default), a reactions tag is appended at the very
end of a line, after media tags and forwarded wrappers. It lists at most `context.reactionsPerMessage` reactions per
message, most frequent first; each item uses `transcript.reactionItem` or `transcript.reactionMine` (when the persona
is among the reactors), joined with ", " and wrapped in `transcript.reactions`. A labels file without
`transcript.reactions` renders nothing.

Video results are cached per attachment or per link in `data/guilds/<id>/media.json` under the key
`video:<itemId>` (the attachment id, or a stable hash of the link URL). Cache entries:

- Watched: `{ text, ts, watched: true }`: permanent, the summary text.
- Limit miss (length or size): `{ miss: true, ts, reason: "length"|"size" }`: permanent, the file will not change.
- Error miss: `{ miss: true, ts, reason: "error" }`: retried after `media.video.errorRetryMinutes` (default 60) minutes, or at once on a forced retry from the re-watch classifier.
- Daily limit: not cached; returned as `{ state: "limit", reason: "daily" }` for that turn only.

A re-watch answer is cached under the key `video:<itemId>:q:<hash>` (the first 16 hex digits of SHA-1 of the lower-cased, whitespace-collapsed question): `{ text, ts, answer: true }`. Expires after one hour; code deletes expired entries on read.

A picture's still-frame entry keeps its own `<itemId>` key as before. Both can coexist for the same item.

A watched GIF is cached under the GIF's own `<itemId>` key (not `video:` prefixed): `{ text, ts, watched: true, gif: true }`. A one-frame caption keeps `{ text, ts, gif: true }` (plus `watchFailed` when a watch was attempted). Both sit alongside picture entries in the same cache.

Web lookup results are cached in the same `data/guilds/<id>/media.json` alongside video and picture entries:

- Read link: `read:<link.id>` holds `{ text, ts }` (the condensed excerpt, permanent) or `{ miss, ts, reason }` (a miss skipped for 6 hours; reasons: `scheme`, `private`, `redirects`, `type`, `size`, `timeout`, `http`, `network`, `empty`, `unreadable`, `llm`). A `TokenLimitError` or `DailyCapError` is never cached.
- Search: `search:<sha1 prefix of the normalised query, 16 hex>` holds `{ query, text, sources, ts }`, served while younger than `web.search.cacheHours` (default 24). An empty `text` means no results (renders `labels.lookup.none`). Failures are never cached.

Transcript line: `#87 [14:32] nick: text <replyTo> <media…> <sticker> <reactions>`; own lines use `labels.self`; between
lines `labels.transcript.gap` / `gapWithDate` / `date`; the block opens with `labels.transcript.header`. Neighbour
channels: same lines without `#n`, under `# channel-name`.

## Labels

The keys of `labels.json`; `{x}` is filled by code.

```
locale                                   BCP-47 tag for dates
ping.prompt                              the whole user message of `/nep ping`; must make any model answer one short word
self                                     {name}
units.lessThanMinute | minute | hour | day
transcript.gap                           {duration}
transcript.gapWithDate                   {duration} {date}
transcript.date | header                 {date}
transcript.empty | replyToOld | image
transcript.replyTo                       {index}
transcript.file | sticker                {name}
transcript.stickerDescribed              {name} {text}
transcript.emojiDescribed                {name} {text}: appended to a line for a custom emoji; text keeps :name:
transcript.imageAttached                 {n}: this picture is attached to the request, the persona sees it
transcript.imageAttachedDescribed        {n} {text}: attached to the request and captioned by the helper (features.attachedDescriptions)
transcript.imageDescribed                {text}
transcript.gif                           {name}
transcript.gifDescribed                  {text}
transcript.gifKnown                      {id} {text}: a GIF that is in the library; id is its handle, text is the caption
transcript.gifKnownNoText                {id} {name}: a library GIF without a caption; id is the handle, name is the file or link name
transcript.video                         {name} {duration}
transcript.videoDescribed                {name} {duration} {text}: text describes ONE frame
transcript.videoWatched                  {name} {duration} {text}: first-hand, the persona saw and heard the clip
transcript.videoNotWatched               {name} {duration} {reason}: reason is the human phrase from videoReason.*
transcript.videoNotWatchedFrame          {name} {duration} {reason} {text}: not watched but a still frame was described
transcript.videoAnswered                {question} {text}: extra tag after a watched video tag; the persona re-watched the clip for this question
transcript.videoReason.length | size | daily | error    human phrases for the four reason codes
transcript.linkWatched                   {text}: extra tag after a link tag, first-hand video summary
transcript.linkNotWatched                {reason}: extra tag after a link tag, not watched with reason
transcript.linkNotWatchedFrame           {reason} {text}: extra tag after a link tag, not watched but preview described
transcript.voice                         {duration}
transcript.audio                         {name} {duration}
transcript.link                          {site} {title}
transcript.linkText                      {site} {title} {text}
transcript.linkRead                      {text}: extra tag after a link tag; the page was fetched and condensed, first-hand
transcript.thumbnailDescribed            {text}: follows a link tag; describes the link's preview picture
transcript.filePreview                   {name} {text}
transcript.forwarded                     {text}
transcript.forwardedFrom                 {channel} {text}: used when the source channel is known; falls back to `forwarded`
transcript.frameAttached                 {n}: follows a video/gif item whose still frame is attached picture n
transcript.reactions                     OPTIONAL {list}: appended at the end of a line after all media and forwarded tags; list is items joined with ", ". A labels file without this key renders nothing
transcript.reactionItem                  {emoji} {count}: one reaction; emoji is unicode or :name: for custom
transcript.reactionMine                  {emoji} {count}: used instead of reactionItem when the persona is among the reactors; reads correctly whether count is 1 or more
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageSee | imageDescribed | imageBlind        one line each; code picks the ones true under the live config. imageSee also covers the helper's note when features.attachedDescriptions is on
senses.gifWatched | gifDescribed | gifBlind   gifWatched replaces gifDescribed when media.gif.watch is on (needs video vision on and a describe-gif or describe-video prompt); a labels file without gifWatched falls back to gifDescribed
senses.videoDescribed | videoBlind
senses.videoWatch                        replaces videoDescribed when features.videoDescriptions is on (needs mediaDescriptions too); covers watched, still frame and not-watched states
senses.videoRewatch                      shown alongside videoWatch when features.videoRewatch is on; tells the persona that a second look at a watched video may appear, marked as first-hand
senses.stickerSee | stickerDescribed | stickerBlind
senses.lottie
senses.customEmoji                       shown when features.customEmoji is on and the server has at least one custom emoji; tells the persona it can use server custom emoji by writing :name:
senses.gifs                              shown when features.gifs is on and the library is not empty; tells the persona it can post one GIF per turn by handle from the list
senses.voice | links | files
senses.linksWatch                        replaces links when features.videoDescriptions is on; adds that a linked video may come watched or not watched with the reason
senses.linksRead                         shown after the links line when features.webLookup is on and web.links.enabled is not false; tells the persona that a link may come with a read excerpt, first-hand
senses.search                            shown when features.webLookup is on, web.search.enabled is not false AND a Brave Search key is configured; tells the persona that a `<lookup>` block may appear with web results and that no search can happen during the reply itself
senses.draw                              shown when features.imageGeneration is on and an image client is wired; tells the persona it can draw
senses.drawSpent                         replaces draw when the daily picture quota is spent
senses.drawSpentUser                     replaces draw when this member's daily quota is spent
senses.privateChat                       shown in a DM turn: this is a one-on-one conversation, what is said here stays between the two of them
senses.privateAware                      shown on a server turn when features.privateMessages is on: the persona knows it has private chats and never repeats or hints at anything from them
lookup.header                            {query}: heading of the `<lookup>` block
lookup.sources                           {list}: site names, comma-separated by code
lookup.none                              shown in `<lookup>` when the search found nothing useful
tempo.counts                             {last10min} {lastHour} {lastDay}
tempo.authors                            {authors}: a head count
tempo.silenceBeforeTrigger | lastMessageAgo | sinceOwn          {duration}
tempo.emptyChannel | ownUnanswered
tempo.verdict                            {verdict} = tempo.verdictLive | verdictSlow | verdictDead
profile.interlocutorMark                 appended to the caller's heading (starts with a space)
profile.formerNames                      {names}
profile.character | interests | style | details | relationship  {text}
profile.aliases                          {text}: what people in chat call this member (comma-separated by code)
profile.interestItem                     {topic} {note}: one interest with a note
profile.interestItemNoNote               {topic}
profile.unsureMark                       appended to an unconfirmed interest or detail (starts with a space, self-explanatory)
profile.staleMark                        appended to an interest not seen for memory.interestStaleDays (starts with a space)
profile.unknown
profile.messageCount                     {count}
profile.affinity                         {score} {band} {reason}
profile.episodes                         heading line above the caller's episodes
profile.episode                          {date} {what} {quote} {feeling}: one remembered moment
profile.episodeNoQuote                   {date} {what} {feeling}: the same without a quote
lore.entry                               {title} {text}
emoji.header                             introduces the custom emoji list
emoji.entry                              {name} {text}: one emoji with a caption
emoji.entryNoText                        {name}: one emoji without a caption
gifs.header                              introduces the GIF library list
gifs.entry                               {id} {text}: one GIF with a caption
gifs.entryNoText                         {id}: one GIF without a caption
affinity.bands.hostile | dislike | cool | neutral | warm | fond | devoted
                                         thresholds in code: ≤-60 · ≤-25 · ≤-8 · <8 · <25 · <60 · ≥60
aboutChat.patterns | starters | injokes  {text}
aboutChat.learned                        {text}: things people taught the persona, joined by `; ` by code
aboutChat.learnedItem                    {text} {who}: one lesson with a teacher
aboutChat.learnedItemNoFrom              {text}: one lesson with no known teacher
aboutChat.unsureMark                     appended to an unconfirmed learned item (starts with a space)
server.currentMark                       appended to the current channel's heading (starts with a space)
server.category | topic | purpose | topics | tone               {text}
server.activity                          {activity} = server.activityLive | activitySlow | activityDead
server.lastMessage                       {when}: humanised age of the channel's newest message
server.topWriters                        {names}: current names of the members who write there most
triggers.mention | reply | name | followUp   followUp = an untagged message the address classifier judged to be for the persona; such a turn posts plain, never as a Discord reply
triggers.private                         the trigger for a private (DM) message
triggers.drawFailed                      {reason}: the drawing sub-process failed; reason is the human phrase from draw.reasons.*
draw.reasons.moderation | daily | userDaily | timeout | error    human phrases for the five failure reasons; daily and userDaily are reserved but no longer reached by triggers.drawFailed — an image cap now posts limits.notice instead of a follow-up turn
memory.privateNote                       the <private> block content in a private analyzer batch: marks the batch as a private conversation, constrains output to users for the partner's id only
memory.privateChannel                    heading used in place of a channel name for the <new_messages> section in a private batch
limits.notice                            {limit} {used} {cap}: posted as a plain reply when a rail refuses a triggered action; limit is the config key, used/cap are the numbers
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
mentor.intended                          array of short strings: engine behaviours that must not cost points in the mentor's scoring
mentor.examples                          first line inside the `<examples>` block in a situations request: introduces the real moments
mentor.original                          first line inside the `<original>` block in a score request: introduces the persona's rejected answer
variety.intro                            first line of the `<worn>` block: tells the persona these devices are spent
```

## Output

Only these tags are acted on:

- `<think>…</think>` optional, first, 1–4 lines of hidden planning; an unclosed one means silence.
- `<msg>text</msg>` one chat message, up to 3 in a row; `reply="#87"` makes it a Discord reply.
- `<react to="#87">💀</react>` one unicode emoji or one server custom emoji as `:name:`; alone or with `<msg>`.
- `<gif reply="#87">g12</gif>` posts a GIF from the library by handle (body = the handle from the `<gifs>` list or from the transcript, never a URL). One per turn; `reply` optional as on `<msg>`. May stand alone or alongside `<msg>`, `<react>`, `<draw>`. Unknown handle = nothing posted.
- `<draw self="yes" reply="#87">scene</draw>` a picture for the drawing sub-process. One per turn, first non-empty wins, clamped to 800 chars. `self="yes"` adds the persona's appearance; `reply="#87"` works like on `<msg>`. May appear alongside `<msg>` and `<react>`.
- `<skip/>` stay silent.
- `@nick` exactly as in the transcript becomes a real mention.
- `:name:` of a known server custom emoji becomes the real emoji in `<msg>` and `<react>`; an unknown name stays as plain text.

`features.reactions: false` drops `<react>`, `features.multiMessage: false` keeps the first `<msg>`;
`features.gifs: false` or an empty library drops `<gif>`; `features.imageGeneration: false` or no image client drops `<draw>`; on a `drawFailed` turn `<draw>` is dropped too. Prompts need not know.

## Analyzer

One call (`memory.md`) updates everything the persona remembers. It judges people **through the persona's eyes**, so it receives
the character card. Whether a channel is alive is NOT its call; code counts that. The warmup feeds old history
through the warmup prompts (`profile.md`, `channel.md`, `server.md`), not through the analyzer.

The numeric limits in the prompt are placeholders filled at runtime from `config.memory.*` and `relationships.maxDeltaPerUpdate`.

Input: `<character>` · `<existing_profiles>` (JSON by user id, incl. current `affinity` score and reason and stored
`episodes`) · `<existing_lore>` ·
`<existing_guild>` (JSON: patterns, starters, in-jokes, learned items) · `<existing_channels>` (JSON by channel id: `name`, Discord `category`, `topic`, stored `purpose`,
`topics`, `tone`) · `<new_messages>` grouped under `## #channel-name (id:123)`, lines `[14:32] nick (id:123): text`,
a line addressed to the persona starts with `→ `, own lines use `labels.self`.

Output: a bare JSON object. Profiles are updated INCREMENTALLY: the analyzer returns changes, never a re-summary
of what is already stored, so facts are not degraded by being rewritten batch after batch:

```
{
  "users": { "<userId>": {
      "portrait": "",                                                // OPTIONAL: one-line cue that the stored character/style misses something
      "relationship": "",                                            // OPTIONAL: present when first written or when it must change, then the whole new text
      "aliases": { "add": [""], "remove": [""] },
      "interests": { "add": [ { "topic": "", "note": "", "sure": false } ], "update": [ { "topic": "", "note": "" } ],
                     "seen": [ "topic" ], "remove": [ "topic" ] },
      "details":   { "add": [ { "text": "", "sure": false } ], "seen": [ 3 ], "remove": [ 3 ] },   // numbers = stored detail ids
                                                                                 // "sure" is OPTIONAL everywhere, default true
      "affinity":  { "delta": 0, "reason": "" },
      "episodes":  [ { "date": "YYYY-MM-DD", "what": "", "quote": "", "feeling": "", "weight": 3 } ] } },
  "guild": { "patterns": "", "starters": "", "injokes": [""],
             "learned": { "add": [{ "text": "", "from": "<@id>" }], "seen": [3], "remove": [3] } },
  "channels": { "<channelId>": { "purpose": "", "topics": "", "tone": "" } },
  "lore": [ { "title": "", "keys": [""], "text": "" } ],
  "self": [""]
}
```

- **Interests are atomic items**, not prose: `topic` (≤ `{{interestTopicChars}}`, the identity, compared
  case-insensitively) and `note` (≤ `{{interestNoteChars}}`, what exactly about it; may be empty). Both placeholders
  are filled from `memory.interestTopicChars` / `memory.interestNoteChars` like the other limits. Stored per person up to `memory.maxInterestsStored`, each with a
  weight that grows when the analyzer adds or updates it again; the lowest rank is evicted first. The input shows the
  stored items so the analyzer adds only new ones, updates a note only when it learned something, removes only what
  the person has clearly dropped.
- **Details are atomic items too**: `{ id, text, weight, firstSeen, lastSeen }`. The input shows each stored detail
  with its numeric `id`; `seen` and `remove` refer to details by that id (code also accepts the exact stored text).
  `add` takes `{ text, sure? }` (a bare string is accepted). Over `memory.maxDetailsStored` the lowest rank is
  evicted.
- **Learned items are atomic items at the guild level**: `{ id, text, from, weight, firstSeen, lastSeen }`. `from`
  stores the member who taught it (`<@id>`, or empty). The same `add` / `seen` / `remove` ops, the same confirmation
  mechanics, the same rank and eviction as details. `memory.maxLearned` shown, `memory.maxLearnedStored` kept,
  `memory.learnedChars` per item. The chat model sees them in `<about_chat>` after the in-jokes line, ranked,
  unconfirmed ones marked with `labels.aboutChat.unsureMark`.
- **Confirmation (the "(?)" mechanism), same for interests, details and learned items.** `weight` counts the separate OCCASIONS a
  thing was observed. A new item starts at weight 1, or 0 when the analyzer marks it `"sure": false` (unclear whose it
  is, unclear whether it was meant seriously, or a name the analyzer does not recognise). `seen` (nothing new to say,
  but it came up again), `add` of an existing item and `update` each count as one sighting; a sighting raises the
  weight by 1 only when the person's messages in this batch are at least `memory.confirmGapHours` away from the
  item's `lastSeen` (so one long conversation split across batches counts once). An op with `"sure": false` on an
  existing item changes nothing. An item is CONFIRMED when weight ≥ `memory.confirmAfter`; until then the chat model
  sees it with `labels.profile.unsureMark`.
- **More is stored than shown, and rank decays with age.** Code keeps up to `memory.maxInterestsStored` /
  `memory.maxDetailsStored` items per person; the persona AND the analyzer see only the top `memory.maxInterests` /
  `memory.maxDetails` by rank. Rank = `log2(weight + 0.5) + lastSeen / halfLife` (half-lives
  `memory.interestHalfLifeDays`, `memory.detailHalfLifeDays`), i.e. weight halves with every half-life of silence, so
  what is frequent AND recent is on top, and a newcomer can gather weight in the unseen tail instead of being evicted
  the moment it arrives. Eviction drops the lowest rank. If the analyzer `add`s something that is stored but not
  shown, code counts a sighting; the prompt therefore tells it to add whatever is new to IT and never to hold back
  because a list looks full.
- **Dates come from the messages**, not from the clock: `firstSeen` / `lastSeen` are the time of the person's
  newest message in the batch that produced the sighting (min / max, so history fed out of order still works). An
  interest whose `lastSeen` is older than `memory.interestStaleDays` is rendered for the chat model with
  `labels.profile.staleMark` and sorted after the fresh ones. Details never go stale.
- The input view of a stored item: interests `{ topic, note, seen, last }`, details `{ id, text, seen, last }`
  (`seen` = weight, `last` = `YYYY-MM-DD`, omitted when unknown).
- **Attribution, for every profile field.** Something is recorded about a person only from that person's OWN
  messages: they bring it up, return to it, or speak about it with substance. Being present in, or replying once to,
  someone else's topic is not theirs. A note may only contain what was said about THAT topic; when it is unclear
  which topic or which person a remark belongs to, it is dropped or marked `"sure": false`. Things everybody on the
  server does belong to `guild.patterns` or `lore`, not to every profile.
- **What each prose field is.** `character`: how the person acts with others, as a handful (4–7) of concrete
  RECURRING habits told in the persona's voice ("habits beat labels": never a row of adjectives or an assessment);
  skills, knowledge, jobs, hobbies and one-off actions are not character. Stored adjective/assessment text is
  rewritten from the batch, not patched. `character`, `relationship`, the affinity `reason` and an episode's `feeling`
  are written in the persona's voice from the card (first person allowed, no clinical vocabulary). `style`:
  HOW the person writes (length, rhythm, vocabulary, emoji habits), not what they do or talk about. `relationship`:
  how the persona and this person stand with each other, not news and not the person's relations with others; written
  first when the stored text is empty and a batch shows them dealing with each other (or affinity/episodes already
  exist), afterwards only when it must change. Each ≤ `memory.fieldChars`; an absent field leaves the stored text
  untouched.
  `character` and `style` are written ONLY by `profile.md` (the warmup and a portrait refresh), never edited by the
  stream analyzer directly. The analyzer returns `portrait` (a one-line cue about what the stored text misses) when
  a batch warrants it, and code queues a refresh.
- **Members are referred to by id, never by nickname.** Nicknames change daily, so in every free-text field the
  analyzer writes (profile prose, interest notes, detail text, episode `what`/`feeling`, affinity reason, `guild`
  fields, channel notes, lore `text`, `self`) a member is written as the token `<@id>` (the id from the transcript's
  `nick (id:123)` or from `<existing_profiles>`). Only when the analyzer is sure who is meant; otherwise the name stays
  as written; an id is never invented. Verbatim `quote`s and lore `keys`/`title` are left alone. Code resolves tokens
  at the moment of use: for the chat model `<@id>` becomes the member's current name (the same string the transcript
  shows, so `@name` still works), for the analyzer it becomes `name (id:123)`; on the way in, code turns a
  `name (id:123)` the model wrote back into the token and leaves unknown ids untouched.
- **Aliases** are what people in chat actually call a member (a stable nickname like a shortened or translated name),
  NOT Discord display names. `users.<id>.aliases: { "add": ["…"], "remove": ["…"] }`; stored as ranked items like
  interests (`memory.maxAliases` shown, `memory.maxAliasesStored` kept, `memory.aliasHalfLifeDays`), an `add` of a
  known alias is a sighting. The input view shows them as a plain list; the chat model sees them through
  `labels.profile.aliases` `{text}`. A member whose current name OR alias occurs in the recent transcript is pulled
  into `<people>` even if they have not spoken; members referred to in the trigger or the last five messages (by mention, current name or alias, prefix match for names of 4+ characters) come right after the interlocutor in full (`context.askedAboutProfiles` at most), the other recent participants after them in compact form (name, aliases, character, attitude, top 5 topics); the budget trims the compact ones first.
- **Main channels are the source of the portrait.** `memory.mainChannelIds` (default `[]`) lists the channels where
  people talk to each other; in `<existing_channels>` such a channel carries `"main": true` (key omitted otherwise).
  `character` and `style` are judged from how the person talks with others in a main channel; diaries and topical
  channels feed interests and details, not the manner of speech. While a person has no main-channel messages the
  portrait is provisional and short. In a batch with the person's main-channel messages the portrait refresh REFINES both
  fields: returns the whole new text (≤ `memory.fieldChars`), carrying forward what still holds, adding what the batch
  showed, letting newer evidence outweigh older and dropping what no longer shows, so the portrait follows the person
  over the years. When no channel is marked main, every channel counts as main.
- **Server-level notes are about the server.** What one person does in their own channel is not a `guild` pattern,
  starter or in-joke, and not `lore`; an in-joke is something several people use.
- **Limits are soft for the model, clean in code.** The prompt names a limit L (placeholders, incl. `{{loreTextChars}}`
  from `lore.textChars`); code accepts up to `L * memory.clampTolerance` (default 1.25) and, beyond that, cuts at the
  last sentence or word boundary, never inside a `<@id>` token, and drops dangling opening brackets and trailing
  separators. A stored note or text that visibly breaks off mid-word (cut by an older version) is rewritten whole the
  next time its subject comes up.
- **Output economy.** `"sure"` is written only when false; `affinity` is omitted when nothing changed.
- **One home per fact.** An event goes to `episodes` or `lore`, a fact to `details`, a pastime to `interests`, a
  lesson addressed to the persona to `learned`; the same thing is never written into several fields.
- **Sanity check against what the model knows.** Before attaching one named thing to another (a region, mode,
  character or item to a game; a person to a franchise), the analyzer checks that they belong together. When the
  chat's wording conflicts with its knowledge, or it does not recognise the thing, it does not glue: it records the
  thing on its own with `"sure": false`. It never "corrects" the chat.
- **The note says what the person does with the topic** (plays, watches videos about, only mentioned), and something
  the person did long ago and dropped is not an interest (at most a detail). What cannot be understood without the
  conversation around it is not recorded.
- Deliberately absent: any rule about irony or sarcasm. Uncertainty of every kind goes through `"sure": false`.
- The analyzer prompt stays short; every added rule is paid for by tightening existing text.
- Only users and channels with something new. A returned channel / `guild` / `self` is the WHOLE merged value and
  replaces the stored one; empty `guild` / `self` = nothing new.
- `affinity` is a CHANGE: integer `delta` (usually ±1…5, up to ±`relationships.maxDeltaPerUpdate` for something
  striking), one-line `reason` naming an observed event. Code clamps it to ±`relationships.maxDeltaPerUpdate`, accumulates into −100…100, keeps a short
  history. The model never sets the absolute score.
- `episodes` are APPENDED, never rewritten: return only NEW moments worth remembering for months: an insult, a
  kindness, a promise, a bet, a fight, a shared joke, something the person asked the persona to do or never do. `what`
  one line; `quote` the person's own words verbatim, short (≤ 120 chars), or empty; `feeling` how the persona took it,
  judged through the character card; `weight` 1–5 (5 = never forget). At most `memory.maxNewEpisodes` per user per
  batch; most batches add none. The input shows the episodes already stored so nothing is recorded twice. Code keeps
  `memory.maxEpisodes` per person, evicting the lightest, then the oldest.
- `lore` is the server's lorebook: things that outlive a conversation: events ("the day X left"), recurring
  characters and pets, long-running stories, feuds, traditions. `title` is the identity (an entry with the same title
  is an UPDATE and carries the whole merged text), `keys` 2–6 words or short phrases that people actually type when
  the thing comes up (names, nicknames, the meme's wording, in the chat's language, lowercase), `text` ≤ `lore.textChars` (`{{loreTextChars}}`).
  Input `<existing_lore>` lists stored titles with their keys, and the full text of entries the batch touches.
  Entries added by the owner (`/nep lore add`) are never changed by the analyzer.
- String fields ≤ `memory.fieldChars`; details ≤ `memory.maxDetails`, injokes ≤ `memory.maxInjokes`, self ≤ `memory.maxSelfFacts`. Notes in the language the chat speaks.
  Observed facts only; nothing sensitive (addresses, phones, documents, health, finances, real full names).

## Channel map

The `<server>` block is assembled from stored channel notes and code-maintained facts, filtered to only the channels
that matter for this turn. The current channel appears first, marked with `labels.server.currentMark`; then only the
neighbour channels that contributed messages to `<other_channels>` this turn, each in full. Every other stored channel
is left out. On a large server most of them are irrelevant and waste budget.

A channel entry (`renderChannel` in `src/memory/channels.js`) carries:

- **Discord facts:** name (the `# heading`), category, topic. Present from the moment the channel is first seen.
- **Analyzer notes:** purpose, topics, tone. Written by `channel.md` during the warmup and updated by the stream
  analyzer (`memory.md`) from live batches. All three are free-text, token-resolved (`<@id>` → current name) at render
  time.
- **Code-maintained counters:** message count, the timestamp of the first and last message, a 30-day activity
  histogram (messages per UTC day, trimmed to the 30 most recent days), and the top 5 writers (by message count,
  excluding bots and the persona). The warmup fills these from the channel's fetched history via
  `store.setChannelFacts`; live traffic keeps them current via `store.touchChannel`.
- **Activity verdict:** `live`, `slow` or `dead`, computed by `channelActivity` from the counters, never the model's
  call. `live` when the sum of today's and yesterday's (UTC) messages reaches
  `context.channelActivity.liveMessagesPerDay` (default 20). `dead` when the channel has never seen a message or the
  last one is older than `context.channelActivity.deadAfterDays` (default 7). `slow` is everything in between.
  Rendered via `labels.server.activity` / `activityLive` / `activitySlow` / `activityDead`.
- **Last message age:** humanised via `labels.server.lastMessage` when the label exists and the data is available.
- **Top writers:** rendered via `labels.server.topWriters`, resolving stored author ids to current names; an id with
  no profile is skipped.

When the current channel has no stored note yet (the analyzer has not touched it), a fallback entry is synthesised from
the Discord facts of the messages in the transcript, so the persona still knows where it is.

## Warmup

Each warmup request handles one unit of work (one channel, one person or the server), so attribution stays clean.
`channel.md` produces channel notes (purpose, topics, tone). `profile.md` produces a member's character, style,
interests, details, episodes and aliases. `server.md` produces server-wide patterns, conversation starters, in-jokes and
lore. For the run order, sampling, progress, rails and subcommands see [Warmup](warmup.md).

### Data model

`character` and `style` STAY PROSE and are written ONLY by `profile.md`: by the warmup and by a PORTRAIT REFRESH.
The stream analyzer never edits them: for a member whose batch showed a recurring habit or a change in how they write
that the stored portrait misses or contradicts, it returns `users.<id>.portrait: "one line: what the portrait misses"`.
Code then queues a refresh for that member: `profile.md` is called with `<draft>` = the stored character + style,
`<hint>` = the analyzer's line, and the answer's `character` and `style` replace the stored ones (interests, details,
episodes and aliases of that answer are IGNORED; they keep flowing through the stream ops).

Attitude and `relationship` are NOT warmed up; they grow from live conversation only.

`profile.md` output: `{ "character": "", "style": "", "interests": [{ topic, note, times }], "details": [{ text, times }],
"episodes": [...], "aliases": [""] }`; blocks `<character>` `<member>` `<draft>` (optional) `<hint>` (optional, portrait
refresh only) `<snippets>`. Own lines in the snippets start with `labels.warmup.ownMark`; context lines start with
`labels.warmup.contextMark`. Aliases come from OTHER people's lines (how they address the member), so the
own-lines attribution rule does not apply to them.

## Address classifier

After the persona answers someone, a conversation window opens in that channel (`mention.followUpMinutes`, extended
by every further answer). A message inside the window that carries no trigger (no mention, no reply to the persona,
no name) is not answered blindly: code sends the last `mention.followUpContext` (default 15) lines of the channel, the
persona's own lines marked with `labels.self`, plus the new message marked as `<candidate>`, to `address.md` on the
`classifier.text` model role (default `anthropic/claude-sonnet-4.6`). The transcript carries cached media captions
(pictures, stickers, GIFs, custom emoji, watched videos) in the same label forms as the persona's transcript. Code
makes no new describer requests for the history lines; it describes only the candidate's own media before running the
classifier. Output is ONE line: `yes` when the candidate
addresses the persona or continues the exchange with it, `no` when people talk among themselves or to someone else
(a reply to another member or a mention of another member is always `no` before the model is asked). `yes` runs a
normal reply turn (the model may still `<skip/>`); three `no` in a row (`mention.followUpNoStreak`, default 3) close
the window. Switch `features.followUp` (default on). Logged as counts and verdicts only.
The window state survives a restart: active windows are saved in `data/state.json` under `followUpWindows` and restored at startup, with expired ones dropped.

## Re-watch classifier

When the persona is addressed (a reply turn) and a video sits in the last `media.video.rewatch.recentMessages`
(default 60) messages of the channel, a classifier decides whether the message asks about one of those videos or asks
to retry one that did not load. Candidates are watched videos and error-state videos (a requested retry uses its own slot, independent of the turn's
`media.video.maxPerTurn` attempts). At most `media.video.rewatch.maxCandidates` (default 6) are
offered to the classifier, newest-message first. Code sends `rewatch.md` as the system prompt on the
`classifier.text` model role (default `anthropic/claude-sonnet-4.6`) with a user message
containing three blocks: a short `<transcript>` of the last few channel messages with the persona's own lines marked
with `labels.self` (so the classifier sees what the candidate replies to), then the video list and the candidate:

```
<transcript>
...
</transcript>
<videos>
<number> | <name> | <status> | <beginning of the account>
...
</videos>
<candidate>
<author name>: <trigger text>
</candidate>
```

Each `<videos>` line carries four pipe-separated columns: a sequential number (1 = newest video), the video name,
a status (`watched` or `not loaded`), and the first 200 characters of the summary (empty for not-loaded videos).
Names and summaries are whitespace-collapsed to one line. The trigger text is cut at `context.maxMessageChars`.
Output is ONE line:

- `<number> | <question>`: the message asks about a watched video and needs a detail the account does not cover. The number is copied from the list.
- `<number> | retry`: the message is about a not-loaded video and asks to try again or asks about its content. The number is copied from the list.
- `none`: no second look or retry needed.

On a question hit, the video model watches the clip again with `rewatch-answer.md` (`{{question}}` and `{{maxChars}}`
= `rewatch.answerChars`, default 1200) and the answer is appended to the transcript as `transcript.videoAnswered`
(`{question}`, `{text}`) after the watched tag. The `<senses>` block includes `senses.videoRewatch` when the feature
is on.

On a retry hit, the video model watches the clip with `force` (ignoring the error cache), using the same
`describeVideo` path as a first watch. If the retry succeeds, the video's state changes from error to watched and the
transcript shows the summary as first-hand. A retry counts as a new video attempt against `media.video.maxPerTurn` and
`media.video.maxPerDay`.

Rails: at most one re-watch or retry per turn; the classifier and the second look each count against
`llm.maxRequestsPerDay`; the second look also counts against `media.video.maxPerDay`;
`media.video.rewatch.maxPerDay` (default 20) caps the re-watches separately. Answers are cached for one hour per
question (see the video cache section above). Switch `features.videoRewatch` (missing = on, needs
`videoDescriptions` on).

## Search classifier

When the persona is addressed (a reply turn) and all of the following hold (`features.webLookup` is on,
`web.search.enabled` is not false, the `lookup.md` prompt exists, `web.search.maxPerTurn` is at least 1, and a
`BRAVE_SEARCH_API_KEY` is configured), the classifier decides whether the trigger message asks something that needs
a web search. It uses the `classifier.text` model role. Code sends `lookup.md` as the system prompt with a user
message containing a short `<transcript>` (the same as the re-watch classifier, with the persona's own lines
marked by `labels.self`) and a `<candidate>` block:

```
<transcript>
...
</transcript>
<candidate>
<author name>: <trigger text>
</candidate>
```

The transcript carries descriptions, video summaries and link reads when available. The trigger text is cut at
`context.maxMessageChars`. Output is ONE line:

- A search query (plain words, no quotes, no operators, at most 12 words) when the message needs facts from
  outside the chat, or when it explicitly asks to search the web.
- `none` for everything else.

On a query hit, Brave Search runs the query (`web.search.results` results, default 5), the numbered results are
condensed by `classifier.text` through `search-summary.md` (`{{today}}`, `{{query}}`, `{{maxChars}}` = `web.search.summaryChars`,
default 900), and the answer is rendered as a `<lookup>` block right before `<chat>`: `labels.lookup.header` with
the query, the condensed text, and `labels.lookup.sources` with the distinct site names. When the search returned
nothing or the condenser found nothing useful, `labels.lookup.none` appears instead.

Rails: at most one search per turn; both the classifier and the condenser count against `llm.maxRequestsPerDay`;
the search itself counts against `web.maxPerDay` (shared with link reads). Results are cached for
`web.search.cacheHours` (default 24) hours per normalised query. Switch `features.webLookup` (missing = off).

## Variety pass

Before a turn, a `classifier.text` pass reads the persona's own most recent lines and names the repeated devices
(turns of phrase, structural moves, recurring joke shapes) the persona has fallen into. The result becomes a `<worn>`
block in the turn's request. Switch `features.variety` (missing = on).

### Line selection

Up to `variety.window` (default 12) of the persona's own lines, taken first from the turn's channel (newest kept),
then from other server channels (a ring stored in guild memory as `ownLines`, written whenever the persona posts in a
server channel). Only lines younger than `variety.recentMinutes` (default 45) are kept. Fewer than `variety.minLines`
(default 3) skips the pass entirely. A limit notice (`labels.limits.notice`) posted by the bot is never counted as the
persona's own line.

### The `<lines>` format

Each line is numbered `#1`, `#2`, ... oldest first, whitespace collapsed to a single line. When the line answered a
message (a reply), `(to: <that message clipped to variety.contextChars>)` is appended. `variety.contextChars` of 0
omits the context.

### Output and validation

One bare JSON object:

```
{ "patterns": [ { "shape": "", "examples": ["", ""], "count": 0 } ] }
```

`shape`: what the device does, 3 to `variety.shapeChars` characters, in the language the lines use. `examples`: 1 to 3
verbatim pieces from the persona's own words (not from the `(to: ...)` context), each at most 80 characters, kept only
when the text occurs in a sent line (case-insensitive). `count`: at least 2, capped at the number of lines sent. At
most `variety.maxPatterns` valid patterns; an empty list is the normal answer. An answer that is not the expected JSON
produces no block.

### Cache and storage

The same set of lines is never asked twice in a row. A per-guild cache, keyed by the SHA-1 of the line ids, reuses the
previous answer without a model request.

`worn` is stored in guild memory (`data/guilds/<id>/guild.json`): the latest pass with `{ at, key, channelId, lines,
patterns }`. `wornHistory` is a ring of up to `variety.history` (default 20) past passes, shapes and counts only, no
examples. A pass that runs in a private chat produces patterns for that turn but saves nothing to guild memory, so
nothing said in private reaches the owner's view or another conversation.

### Timeout and failure

`variety.timeoutMs` (default 8000) caps the model request. A timeout or a failure produces no `<worn>` block; the turn
proceeds without one and the latest stored pass stays unchanged.

### Mentor

The mentor sandbox runs one variety pass per reply-target situation, charged to the mentor's token budget (not to
`llm.maxRequestsPerDay`). The patterns are saved as `worn` on the situation record. The judge never sees the `<worn>`
block.

## Drawing

The persona can produce pictures through a drawing sub-process (`features.imageGeneration`, on by default). When the
model emits a `<draw>` tag, `src/behavior/turn.js` assembles the image prompt from `draw.md` and generates one picture
through OpenRouter's Images API (`src/llm/images.js`). The picture is posted as its own message after the persona's
text messages, never inlined.

### Prompt assembly

`buildDrawPrompt` (`src/behavior/prompt.js`) fills `draw.md` with three placeholders:

- `{{name}}` — the bot's display name.
- `{{appearance}}` — `appearance.md` with `{{name}}` filled, included only when `self="yes"`. Empty otherwise.
- `{{request}}` — the scene text from the `<draw>` tag, clamped to `image.maxPromptChars` (default 800).

The drawing sub-process never receives the character card, `rules.md` or the system prompt. It follows its own style
section inside `draw.md`.

### Reference

When the persona is in the picture (`self="yes"`) and `image.reference` is `'avatar'` (the default), the bot's
Discord avatar is downloaded and sent as an `input_references` entry so the image model can see what the persona looks
like. If the avatar cannot be fetched, the generation proceeds without a reference.

### Senses

The `<senses>` block includes one drawing line when an image client is wired and `features.imageGeneration` is not
false:

- `senses.draw` — the persona can draw.
- `senses.drawSpent` — the daily quota (`image.maxPerDay`) is spent.
- `senses.drawSpentUser` — this member's daily quota (`image.maxPerUserPerDay`) is spent.

An older `labels.json` without `senses.draw` shows nothing.

### Failure turn

When a generation fails on a reply turn (someone asked for the picture), a second turn fires automatically:

- `triggerKind: 'drawFailed'`, with the failure reason rendered through `labels.draw.reasons.*` into
  `labels.triggers.drawFailed`'s `{reason}` placeholder.
- Mode is `reply`, same trigger message, replies allowed.
- The second turn's own `<draw>` is dropped, so the model cannot retry the generation.
- The channel's idle notification is held until the second turn finishes, so a pending ping is drained only after
  the follow-up.

On a spontaneous turn (nobody asked), a failed generation is only logged and no follow-up runs.

An image cap (`ImageCapError`, reason `daily` or `userDaily`) does NOT fire the failure turn. Instead, the turn posts a
limit notice (`labels.limits.notice`) as a plain reply. The senses line already told the persona the quota was spent;
the notice tells the requester which limit and the numbers. `draw.reasons.daily` and `draw.reasons.userDaily` are
reserved in `labels.json` but no longer reached by `triggers.drawFailed`.

### Rails

- One `<draw>` per turn; first non-empty wins, clamped to `image.maxPromptChars` (default 800).
- `image.maxPerDay` (default 50) and `image.maxPerUserPerDay` (default 50) are checked and counted before the
  request; a cap error throws `ImageCapError` with reason `daily` or `userDaily`.
- An unsupported model family (not `openai/*` or `google/*`) is refused with `UnsupportedImageModelError`.
- Generation failures throw `ImageGenError` with reason `moderation`, `timeout`, `error` or `empty`.
- Transient HTTP errors (408, 429, 5xx) and network failures are retried up to `image.retries` (default 1).
- Moderation refusals (HTTP 400/403 with a moderation marker) are not retried.
- Logs carry the model, counts, cost and failure reasons — never the prompt, because it may quote members.
- In dry-run, the full image prompt (prompt files + the persona's request) is logged and mirrored, but nothing is
  generated.

## Private chat

`features.privateMessages` (off by default) lets members of the served guild talk to the persona in Discord direct
messages. The persona is the same character with the same public memory; what is said in a DM stays in a per-member
private layer that no other conversation ever sees.

### Gate

A DM is answered when ALL of the following hold, checked locally with zero tokens:

1. `features.privateMessages` is `true`.
2. The author is a member of the served guild.
3. The persona has a stored public profile for the author.
4. The author's public `affinity.score >= private.minAffinity` (default 5). Bot owners bypass this check.
5. Today's reply count for this person is under the cap (`private.maxPerOwnerPerDay` for owners,
   `private.maxPerUserPerDay` otherwise).

Anything that fails is dropped silently, except step 5: when the daily cap is reached, the bot posts a limit notice
(`labels.limits.notice` with the config key) once per person per day.

### What a DM turn contains and omits

- The `<server>` block (channel map) and `<other_channels>` are omitted.
- `prompts.private` (when present) is appended after the mode prompt (`reply.md`), before `forced.md`, with
  `{{name}}` and `{{author}}` filled.
- `{{trigger}}` comes from `labels.triggers.private`.
- `<senses>` carries `senses.privateChat`.
- On a server turn, when `features.privateMessages` is on, `<senses>` carries `senses.privateAware` instead (the
  rule about never repeating anything from private).
- The interlocutor's profile is `mergeProfiles(publicProfile, privateProfile)` from `src/behavior/private.js`.
  Other profiles (`askedAbout`, participants) stay public-only.
- No ignore chance, no follow-up window, no eavesdrop, no address classifier.
- One attention applies: a DM that arrives while the persona is busy elsewhere is held as a pending ping.

### The private layer

`data/guilds/<guildId>/private/<userId>.json` stores what the persona learned from one member in DMs. It holds its own
`relationship`, `interests`, `details`, `episodes` and `affinity` (score starting at 0). It is never shown to any
other conversation, never written by a server batch, and never mixed into the public profile on disk.

In a DM, the persona sees the public and private data merged (a view, never stored): interests are unioned by topic
(the private note wins on a shared topic), details are concatenated, episodes are sorted by date, `relationship` is
the public text followed by the private text as a second paragraph.

### Affinity in a DM

The public score changes only from server batches. The private layer has its own score starting at 0, changed only by
DM batches. In the DM the persona feels `clamp(public + private, -100, 100)`; on the server only the public score.
The gate uses the public score alone.

### Analyzer in private mode

`analyzePrivate` builds a `memory.md` request with the same format and a `<private>` block
(`labels.memory.privateNote`). `<existing_profiles>` contains ONLY the partner, rendered as the private profile
(private details with ids, private interests, private episodes, the effective affinity view). `<public_profile>`
shows the partner's public profile (read-only, via `renderProfile`). `<existing_guild>`, `<existing_lore>` appear as
usual (read-only context). `<new_messages>` is headed by `labels.memory.privateChannel`.

From the answer, only `users[<partnerId>]` is applied through the private store methods. `portrait` and `aliases`
are ignored. `guild`, `channels`, `lore`, `self` and any other user ids are dropped and logged as counts.

## Mentor

A manual sub-process (`features.mentor`) with its own model (`mentor.model`). The owner adds a case (a behaviour he wants from the persona), and the mentor invents chat situations, runs the persona through them in a sandbox, and scores the answers. When a run fails or scores poorly, the mentor names likely causes in the persona's context and proposes changes as advice for the owner to review. One run at a time. All work stays in `data/`; when `bot.dryRunChannelId` is set, a finished run is posted there as well. Without an admin channel the owner follows a run with `/nep mentor status` and reads the report with `/nep mentor show <id>`.

### Privacy

The mentor model reads the rendered sandbox request, so it reads what the persona remembers about real people. Direct messages and the private memory layer are never part of a sandbox request.

### How a run ends

A run ends normally with a verdict and a report. It can also end early:

- **Stopped** (`budget`): the daily token budget is exhausted. The switches and the budget are checked before every situation and before every mentor request.
- **Stopped** (`owner`): the owner ran `/nep mentor stop` or `/nep pause`.
- **Stopped** (`disabled`): `features.mentor` or `mentor.model` was turned off during the run.
- **Error** (`the reference is empty`): no message of people could be read from the reference channels in the reference window. This ends the run before any model request.

A stopped run keeps the scores it already has and reports them.

### Real moments (anchors)

A case may carry real moments from the chat. Each moment is one message of the persona that the owner rejected. Resolving: the bot fetches the message, finds the trigger (the message it replies to, or the last message before it that is not the persona's), collects up to `mentor.anchor.contextMessages` (default 30) messages of that channel ending at the trigger, and stores the persona's whole burst (consecutive messages starting at the linked one) as the original answer. The stored history is normalized the same way the regular transcript is (media labels, reactions) but nothing is downloaded or described. Resolving stores what the persona saw of the media: for each message, the describer's captions (pictures, gifs, video frames, link thumbnails, stickers, custom emoji) and watched video summaries from `media.json` entries written no later than the persona's message become `mediaSeen: { captions?: { <itemId>: text }, watched?: { <itemId>: text } }`. Not-watched states (limit or error), second-look answers (`videoAnswered`), web lookup reads (`linkRead`) and attached-picture markers are not kept. Names and reactions stay as they were at fetch time. Once stored, a moment is replayed from its stored messages even after the channel moves on or a message is deleted.

A case stores its moments as `anchors`:

```json
[{ "id": 1, "channelId": "...", "messageId": "...", "triggerId": "...",
   "addedAt": "...",
   "history": [
     { "...normalized message fields...",
       "mediaSeen": { "captions": { "<itemId>": "text" }, "watched": { "<itemId>": "text" } } }
   ],
   "original": ["text", "..."] }]
```

In a run, each usable anchor becomes a situation of its own, numbered before the invented ones. The situation record carries `anchor: <id>` (absent on invented situations). The replay uses the stored history at the time of the persona's original message, in the anchor's own channel.

At replay, stored `mediaSeen` renders with the live transcript labels (`imageDescribed`, `gifDescribed`, `videoDescribed`, `videoWatched`, `thumbnailDescribed`, `linkWatched`, `stickerDescribed`, `emojiDescribed`) in the persona's request, in `<examples>`, in the score `<situation>` and in `<worst>`. For an item with nothing stored, the cache is read at replay time with the same time bound (the persona's answer). If the cache has nothing either, the item renders with its plain label.

When `mentor.anchor.hideLaterMemory` is not `false` (the default is `true`), a replayed moment is answered with the memory as it stood before its trigger. Items dated at or after the trigger's timestamp are hidden: episodes (by `addedAt`, falling back to `date` by UTC day), affinity history entries and the affinity reason (the score stays at its current value), details (by `firstSeen`), interests (by `firstSeen`), aliases (by `firstSeen`), learned items (by `firstSeen`) and lore entries (by `createdAt`). Items with no parseable date pass through. Undated fields (profile prose, guild patterns, starters, in-jokes, self-facts, channel entries) stay visible with their current values. The judge's `<learned>` block for a real moment is filtered the same way. Setting the switch to `false` replays the moment with all of today's memory.

In the situations request, the case's anchors are shown to the mentor model as `<examples>` (the last block). Each `<example>` holds a `<situation>` with the stored transcript and an `<original>` with the persona's messages. The oldest messages of each example may be trimmed so the block fits the request budget; the trigger is never dropped. The mentor invents situations of the same kind: matching message lengths, turn count and pressure.

In the score request for a real moment, `<original>` appears between `<situation>` and `<answers>`, carrying the persona's rejected answer as a known-bad reference.

The validator's cap on a single line of an invented situation is 2000 characters (not the former 500), so the mentor can match the length of messages in the examples.

### Prompts

The mentor uses six prompt files, one pair per target, the signs file and the diagnosis file:

- **Reply target**: `mentor-situations.md` (invent situations) and `mentor-score.md` (score answers).
- **Memory target**: `mentor-situations-memory.md` (invent situations) and `mentor-score-memory.md` (score stored text).
- **Diagnosis**: `mentor-diagnose.md` (explain weak answers after scoring).

Each prompt file is the system message of one mentor request. The blocks arrive in the user message.

Placeholders filled by code: `{{name}}` in all six; `{{count}}`, `{{minLines}}`, `{{maxLines}}` in the two situations prompts.

### Blocks

| Block | Content | In which request |
|---|---|---|
| `<case>` | The owner's case text, verbatim | all |
| `<members>` | One line per stored profile: `name (id:123)` | situations |
| `<reference>` | Style profile as JSON: punctuation rates, lengths, reply frequency, characters never used | situations, score |
| `<samples>` | Random lines from the chat, one per line | situations, score |
| `<signs>` | `mentor-signs.md` with `{{name}}` filled: known habits of model-written text. Omitted when the file is missing or empty | all |
| `<intended>` | `labels.mentor.intended`, one line per item | score |
| `<feedback>` | JSON array of the owner's corrections: `[{ "case": "...", "reason": "..." }]`, newest first; omitted when empty | all |
| `<examples>` | Real moments from the chat: `labels.mentor.examples` as the first line, then one `<example>` per moment. Each `<example>` holds a `<situation>` (the stored transcript, oldest messages trimmed to the request budget) and an `<original>` (the persona's messages). Omitted when the case has no moments | situations |
| `<original>` | The persona's answer at the time (in a score request for a real moment). `labels.mentor.original` as the first line, then the persona's messages. A known-bad reference, never an answer to score. Omitted for invented situations | score (reply target, real moments only) |
| `<character>` | The character card with `{{name}}` filled | score (reply target only) |
| `<rules>` | The rules prompt | score |
| `<learned>` | Instruction-like learned items as the persona sees them. For a real moment with `mentor.anchor.hideLaterMemory` on, items written at or after the trigger are hidden | score |
| `<situation>` | The situation rendered as a chat transcript, the way the persona saw it. For a real moment, the oldest messages may be trimmed to fit the request budget; the trigger is never dropped | score |
| `<answers>` | JSON array: `[{ "id": "s1a1", "messages": ["..."], "reactions": ["..."], "silent": false }]` | score (reply target) |
| `<stored>` | JSON array: `[{ "id": "s1a1", "texts": [{ "path": "...", "text": "..." }], "parseOk": true }]`. When `parseOk` is false the analyzer returned invalid JSON and nothing would have been stored | score (memory target) |
| `<facts>` | JSON object keyed by answer id with deterministic measurements (unused marks, rare marks, comma count, comma density, length), plus `"repeated"` with phrases found in two or more different situations. Per answer: `commas` is a count; `commaPer1000` is a number only when the measured text has at least 150 characters, `null` for a shorter one (too short to measure; the mentor judges the count, never infers a density). `repeated` lists phrases that recurred across different situations, and `count` is the number of situations | score |
| `<verdict>` | JSON: `{ passed, medians, situations, reasons }` with the pass/fail result, medians of each axis, per-situation medians and the reasons the case was brought to diagnosis. Reasons include `situation <n>: <axis> <v> is under the floor <f>` for invented situations and `real moment <n>: <axis> <v> is under the pass score <s>` or `real moment <n>: <axis> <v> is under the anchor score <s>` for real moments | diagnosis |
| `<worst>` | JSON: the situation with the lowest median `overall` of any kind (ties: the lower median `goal`, then a real moment before an invented situation, then the lower `n`): `{ n, title, transcript, answers }` where each answer carries its id, messages/reactions/silent (or `texts`/`parseOk` for memory), `facts` and `score`. The transcript may be trimmed to the request budget | diagnosis |
| `<seen>` | The full request the persona (or the analyzer for a memory case) was given for that situation, as two sub-blocks: `<system>` (the system prompt with the character card, rules and format) and `<user>` (the transcript, memory blocks and task) | diagnosis |

### Answer ids

`s<situation>a<sample>`, both counting from 1. Example: `s2a3` is the third sample of the second situation.

### Situations schema

```json
{
  "situations": [
    {
      "title": "short label",
      "lines": [
        {
          "authorId": "123456789 or self",
          "authorName": "display name",
          "text": "the message",
          "replyTo": null,
          "minutesBefore": 5
        }
      ]
    }
  ]
}
```

`authorId` is a member id from `<members>` or `self` for the persona's own earlier line. `replyTo` is a 0-based index into the same situation's `lines` array, or `null`. For both targets the last line is never by `self`. For reply-target situations it addresses the persona. For memory-target situations no line is required to address the persona; the persona's own lines may appear anywhere before the last line.

A situation record from a real moment has `anchor: <id>` instead of `lines`. Its transcript is rendered from the stored history; its record also carries `original` (the persona's messages) and `at` (the time the persona answered).

### Scores schema

```json
{
  "answers": [
    {
      "id": "s1a1",
      "human": 7,
      "character": 8,
      "rules": 9,
      "goal": 6,
      "overall": 7,
      "comment": "One or two sentences."
    }
  ]
}
```

Each score is an integer 0–10 or `null`. `overall` and `goal` are always numbers. For memory-target scoring `character` is always `null`.

### Axes

All integers 0–10, 10 ideal, `null` when there is nothing to judge (never 5 as a stand-in for unknown).

| Axis | What it measures | 0 | 5 | 10 |
|---|---|---|---|---|
| `human` | How little it reads as AI | Far from how the people of this chat write | Could be either | Matches how people in the reference write |
| `character` | Fit to the character card | Completely out of character | Recognizable with slips | Exactly the card's voice |
| `rules` | Compliance with rules and learned items | Breaks every applicable rule | Follows some, breaks others | Follows every applicable rule |
| `goal` | Does what `<case>` asks | Does the opposite | Partly achieves, partly misses | Handles the behaviour exactly |
| `overall` | The mentor's verdict | Fails across the board | Acceptable with clear weaknesses | Excellent on every front |

For memory-target scoring `character` is always `null` and `human` measures whether the text reads like someone's own notes about people they know (10) or far from how such a person would write for themselves (0).

### Pass rule

A case passes when the median of `overall` >= `mentor.pass.score` (default 7) AND the median of `goal` >= `mentor.pass.score` AND no axis has a median below `mentor.pass.floor` (default 5). Invented situations are held to the floor: the case fails when the median `overall` or the median `goal` of any one invented situation is under `mentor.pass.floor`, whatever the medians over all answers. A real moment is held to the pass score instead: the case fails when its median `overall` or `goal` is under `mentor.pass.anchorScore` (when set to a number) or under `mentor.pass.score` (when `anchorScore` is `null`). The reason string is `real moment <n>: <axis> <v> is under the pass score <s>` when `anchorScore` is not set, or `real moment <n>: <axis> <v> is under the anchor score <s>` when it is. The report shows the median `overall` and `goal` of every situation. An axis where every score is `null` has median `null` and is not checked.

### Evidence order for scoring

1. The owner's corrections in `<feedback>`, which overrule the mentor's taste.
2. The measured reference (`<reference>`, `<samples>`) and the deterministic facts (`<facts>`).
3. The known signs of model writing (`<signs>`). A sign never outranks a measurement or the reference.
4. The mentor's own taste, which proposes but never overrules the first three.

### Sources

The list of known signs in `mentor-signs.md` was informed by Wikipedia's "Signs of AI writing" and the humanizer skill (MIT).

### Diagnosis

After scoring, when the run did not end early and the case failed or any situation's median `overall` is under `mentor.pass.score`, the mentor makes one more request to explain what in the persona's context caused the weak answers. Switch `mentor.diagnose` (default `true`). A run started with `/nep mentor check` never asks for a diagnosis. A failure of this step never fails the run: the run is saved with `diagnosis: null` and the error noted.

The result is stored on the run as `diagnosis` and printed in the report. These are hypotheses for the owner to review; the mentor does not edit anything.

Layers a cause may name: `rules` (a rule in the rules block), `prompt` (the engine's system prompt, format or task), `card` (the character card), `self` (a note the persona keeps about itself), `learned` (something people taught it), `guild` (a server habit or in-joke), `profile` (what it remembers about a person), `missing` (an instruction that should be there is absent).

#### Diagnosis schema

```json
{
  "summary": "one paragraph",
  "causes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile|missing",
      "excerpt": "verbatim from <seen>, at most 300 chars; empty for missing",
      "why": "one or two sentences"
    }
  ],
  "changes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile",
      "target": "which file, rule or item",
      "from": "verbatim text to replace; empty for an addition",
      "to": "the new text",
      "why": "one sentence"
    }
  ]
}
```

At most 5 causes and 5 changes. `summary` clipped to 1500 characters; `excerpt` to 300; `from`/`to` to 1000; `target` to 200; `why` to 500. An item with an unknown `layer` or without `why` is dropped. `summary` and `why` are in the language of the chat; `to` is in the language of the layer it targets.

## Limit notices

When a rail refuses a directly requested action (a mention, reply, name trigger, follow-up or private message), the
bot posts one plain line from `labels.limits.notice` with `{limit}` (the config key), `{used}` and `{cap}` filled.
Spontaneous turns that hit a rail stay silent. In dry-run the notice is logged and mirrored, not sent.

The config keys that can appear as `{limit}`: `llm.maxRequestsPerDay`, `llm.maxRequestTokens`, `image.maxPerDay`,
`image.maxPerUserPerDay`, `private.maxPerUserPerDay`, `private.maxPerOwnerPerDay`.

Private DM caps post the notice once per person per day (tracked by `replies.noticedDay` in the private file).
Image caps post the notice instead of the `drawFailed` follow-up turn (the senses line already told the persona;
the notice is the technical marker for the requester). Video and web daily caps do not block a reply and keep their
in-transcript states; no notice.
