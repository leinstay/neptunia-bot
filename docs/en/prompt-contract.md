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
| `describe.md` | yes | Out-of-character prompt of the media describer (`features.mediaDescriptions`): one picture in, one plain line out: what is on it, any legible text, in the language the chat speaks. No opinions, no markdown | none |
| `describe-video.md` | yes | Out-of-character prompt of the video describer (`features.videoDescriptions`): one video clip in (with sound), a full ordered account out: who appears, what is said (key phrases quoted), text on screen, what happens visually, music/sound when relevant. Configurable length. Same language and restriction rules as `describe.md`. No character card | `{{maxChars}}` |
| `rewatch.md` | yes | Classifier: does this message need the persona to re-watch a video or retry one that did not load (`features.videoRewatch`). Receives a numbered list of recent videos with their status and the new message. Output is ONE line: `<number> \| <question>`, `<number> \| retry` or `none` | `{{name}}` |
| `rewatch-answer.md` | yes | Out-of-character prompt for the re-watch answer: the video model watches a clip again and answers one question. Same language and restriction rules as `describe-video.md`. No character card | `{{question}}` `{{maxChars}}` |
| `address.md` | yes | Classifier: is this untagged message addressed to the persona | `{{name}}` |
| `lookup.md` | no | Classifier: does the persona need to search the web to answer this message (`features.webLookup`). Receives a short transcript and a `<candidate>` block. Output is ONE line: a search query (plain words, at most 12) or `none` | `{{name}}` |
| `read-link.md` | no | Out-of-character prompt for the link reader (`features.webLookup`, `web.links.enabled`): condense a fetched page into one paragraph. Receives the page title and body. No character card | `{{maxChars}}` |
| `search-summary.md` | no | Out-of-character prompt for the search condenser (`features.webLookup`, `web.search.enabled`): condense numbered search results into one note with inline sources. No character card | `{{query}}` `{{maxChars}}` |
| `labels.json` | yes | Every string the CODE inserts into a prompt. Keys fixed below, values are the writer's | see below |

`{{name}}` bot's display name · `{{author}}` caller's display name · `{{trigger}}` one of `labels.triggers.*` ·
`{{target}}` index of the calling message (`#87`).
System message = `system-prompt` + `character-card` + `rules` + `format`. For the analyzer: `memory.md` alone.
On a forced turn (`/nep interject`, `/nep initiate`), `forced.md` is appended after the mode prompt if the file exists.
The analyzer and the warmup's `profile.md` and `server.md` receive the character card and `rules.md` as a
`<character>` block in the user message. `channel.md`, `describe.md`, `describe-video.md`, `rewatch.md`, `rewatch-answer.md`, `address.md`, `lookup.md`, `read-link.md` and `search-summary.md` do not receive the card.

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
| `<server>` | The CURRENT channel in full (Discord category and topic, purpose, what people write, tone, activity, last message, top writers; marked with `labels.server.currentMark`) plus only the neighbour channels that fed `<other_channels>` this turn; no other channel |
| `<lore>` | Server lore entries whose keys occur in the recent messages (plus entries marked always): events, recurring characters, long-running stories. Like a lorebook: hundreds may exist, only the relevant few are shown |
| `<self_facts>` | What the persona has claimed about itself |
| `<people>` | Member profiles; the caller first, marked with `labels.profile.interlocutorMark`; each with the persona's attitude and, for the caller, the **episodes**: moments the persona remembers about the two of them, with dates and short quotes |
| `<other_channels>` | Up to `context.neighborMessages` messages per neighbouring channel, not older than `context.neighborMaxAgeMinutes` |
| `<lookup>` | What the persona looked up online this turn (`features.webLookup`): the query, the condensed answer and the source sites, or a "nothing found" line. Appears only when the search classifier fired and the search completed |
| `<chat>` | Up to `context.channelMessages` latest messages of the current channel |
| `<tempo>` | Counts for 10 min / hour / day, distinct people, silence, a verdict (live / slow / dead) |
| `<task>` | `reply` / `interject` / `initiate`, placeholders filled |

Budget priority (sections are trimmed from the bottom of this list first): system + task + clock + tempo + senses
(never cut) → caller's profile with episodes → lookup (kept or dropped whole) → about_chat → self_facts → lore → server → chat (newest first) →
other profiles → other channels.

Media in a transcript line, most informative form available: a picture attached to THIS request →
`transcript.imageAttached` (numbered in the order the pictures follow the text); a described one →
`imageDescribed` / `gifDescribed` / `videoDescribed`; otherwise the blind forms `image` / `gif` / `video`.
When video vision is on (`features.mediaDescriptions` AND `features.videoDescriptions`), a video or video-site link
gains a state: `videoWatched` (first-hand, seen and heard), `videoNotWatchedFrame` (not watched but a still frame was
described), or `videoNotWatched` (not watched, no frame). The reason code (`length` / `size` / `daily` / `error`) is
swapped for the human phrase from `transcript.videoReason.*` before it reaches the transcript. Links keep their base
tag (`link` / `linkText`) and add a video extra: `linkWatched`, `linkNotWatchedFrame` or `linkNotWatched`. When a still
frame is attached as a picture, `frameAttached` is added as well. Links use `link` / `linkText` built from Discord's
embed (site, title, snippet); when `features.webLookup` is on and the link was read, `linkRead` is appended after the
link's other extras (video, thumbnail). Text files show their beginning via `filePreview`; a forwarded message is
wrapped in `forwarded`.

Video results are cached per attachment or per link in `data/guilds/<id>/media.json` under the key
`video:<itemId>` (the attachment id, or a stable hash of the link URL). Cache entries:

- Watched: `{ text, ts, watched: true }`: permanent, the summary text.
- Limit miss (length or size): `{ miss: true, ts, reason: "length"|"size" }`: permanent, the file will not change.
- Error miss: `{ miss: true, ts, reason: "error" }`: retried after `media.video.errorRetryMinutes` (default 60) minutes, or at once on a forced retry from the re-watch classifier.
- Daily limit: not cached; returned as `{ state: "limit", reason: "daily" }` for that turn only.

A re-watch answer is cached under the key `video:<itemId>:q:<hash>` (the first 16 hex digits of SHA-1 of the lower-cased, whitespace-collapsed question): `{ text, ts, answer: true }`. Expires after one hour; code deletes expired entries on read.

A picture's still-frame entry keeps its own `<itemId>` key as before. Both can coexist for the same item.

Web lookup results are cached in the same `data/guilds/<id>/media.json` alongside video and picture entries:

- Read link: `read:<link.id>` holds `{ text, ts }` (the condensed excerpt, permanent) or `{ miss, ts, reason }` (a miss skipped for 6 hours; reasons: `scheme`, `private`, `redirects`, `type`, `size`, `timeout`, `http`, `network`, `empty`, `unreadable`, `llm`). A `TokenLimitError` or `DailyCapError` is never cached.
- Search: `search:<sha1 prefix of the normalised query, 16 hex>` holds `{ query, text, sources, ts }`, served while younger than `web.search.cacheHours` (default 24). An empty `text` means no results (renders `labels.lookup.none`). Failures are never cached.

Transcript line: `#87 [14:32] nick: text <replyTo> <media…> <sticker>`; own lines use `labels.self`; between
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
transcript.imageDescribed                {text}
transcript.gif                           {name}
transcript.gifDescribed                  {text}
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
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageSee | imageDescribed | imageBlind        one line each; code picks the ones true under the live config
senses.gifDescribed | gifBlind
senses.videoDescribed | videoBlind
senses.videoWatch                        replaces videoDescribed when features.videoDescriptions is on (needs mediaDescriptions too); covers watched, still frame and not-watched states
senses.videoRewatch                      shown alongside videoWatch when features.videoRewatch is on; tells the persona that a second look at a watched video may appear, marked as first-hand
senses.stickerSee | stickerDescribed | stickerBlind
senses.lottie
senses.voice | links | files
senses.linksWatch                        replaces links when features.videoDescriptions is on; adds that a linked video may come watched or not watched with the reason
senses.linksRead                         shown after the links line when features.webLookup is on and web.links.enabled is not false; tells the persona that a link may come with a read excerpt, first-hand
senses.search                            shown when features.webLookup is on, web.search.enabled is not false AND a Brave Search key is configured; tells the persona that a `<lookup>` block may appear with web results
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
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
```

## Output

Only these tags are acted on:

- `<think>…</think>` optional, first, 1–4 lines of hidden planning; an unclosed one means silence.
- `<msg>text</msg>` one chat message, up to 3 in a row; `reply="#87"` makes it a Discord reply.
- `<react to="#87">💀</react>` one unicode emoji; alone or with `<msg>`.
- `<skip/>` stay silent.
- `@nick` exactly as in the transcript becomes a real mention.

`features.reactions: false` drops `<react>`, `features.multiMessage: false` keeps the first `<msg>`; prompts need not know.

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
`classifier.text` model role (default `anthropic/claude-sonnet-4.6`). Output is ONE line: `yes` when the candidate
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
  outside the chat.
- `none` for everything else.

On a query hit, Brave Search runs the query (`web.search.results` results, default 5), the numbered results are
condensed by `classifier.text` through `search-summary.md` (`{{query}}`, `{{maxChars}}` = `web.search.summaryChars`,
default 900), and the answer is rendered as a `<lookup>` block right before `<chat>`: `labels.lookup.header` with
the query, the condensed text, and `labels.lookup.sources` with the distinct site names. When the search returned
nothing or the condenser found nothing useful, `labels.lookup.none` appears instead.

Rails: at most one search per turn; both the classifier and the condenser count against `llm.maxRequestsPerDay`;
the search itself counts against `web.maxPerDay` (shared with link reads). Results are cached for
`web.search.cacheHours` (default 24) hours per normalised query. Switch `features.webLookup` (missing = off).
