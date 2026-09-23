# 提示与代码的契约

提示文件与代码（`src/behavior/prompt.js`、`src/llm/parse.js`、`src/discord/format.js`、
`src/memory/update.js`、`src/memory/channels.js`、`src/memory/warmup.js`）的交汇点。修改一方时需同步修改
另一方。变更的工作流程参见 `CONTRIBUTING.md`。

## 层级

| 目录 | 受版本控制 | 内容 |
|---|---|---|
| `prompts/` | 是 | 英文引擎默认值 + 一个中性的示例角色。开箱即用 |
| `prompts.local/` | 否 | 部署的覆盖文件：一个文件替换同名的默认文件；`labels.json` 采用深度合并 |

两者均支持热重载。`/nep rule add` 写入 `prompts.local/rules.md`（从默认文件初始化），永远不写入 `prompts/`。
两层中的所有指令均为英文；角色的语音示例可以使用角色所说的语言。

## 文件

| 文件 | 必需 | 用途 | 占位符 |
|---|---|---|---|
| `system-prompt.md` | 是 | 与角色无关的规则，指导如何表现得像普通聊天成员：长度、反 AI 检测规则、上下文使用、对人的态度、边界。声明角色卡在语气上具有优先权 | `{{name}}` |
| `character-card.md` | 是 | 角色定义：身份、性格、语气和语言、元层、**什么能赢得或失去角色的好感**（分析器会读取此内容）、参考台词。部署者需要重写的唯一文件 | `{{name}}` |
| `rules.md` | 否 | 所有者的实时修正，覆盖前两个文件。**必须以最后一个 `## ` 标题下的项目列表结尾。**代码会追加 `- …` 行 | `{{name}}` |
| `format.md` | 是 | 输出协议 | 无 |
| `reply.md` | 是 | 任务：有人呼叫了角色 | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `interject.md` / `initiate.md` | 是 | 任务：插入正在进行的对话 / 在沉寂的频道中发起话题 | `{{name}}` |
| `forced.md` | 否 | 强制回合（`/nep interject`、`/nep initiate`）时追加在模式提示之后。覆盖默认的 `<skip/>` 选项 | `{{name}}` |
| `memory.md` | 是 | 角色外提示，用于流分析器：从实时批次中对记忆进行针对性编辑 | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` |
| `profile.md` | 是 | 预热 / 画像刷新：从消息样本生成一个成员的档案 | `{{name}}` `{{fieldChars}}` `{{maxInterests}}` `{{maxDetails}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{maxNewEpisodes}}` |
| `channel.md` | 是 | 预热：从消息样本生成频道笔记 | `{{fieldChars}}` |
| `server.md` | 是 | 预热：从频道笔记和成员摘要生成服务器级笔记 | `{{name}}` `{{fieldChars}}` `{{maxInjokes}}` `{{loreTextChars}}` |
| `describe.md` | 是 | 角色外提示，用于媒体描述器（`features.mediaDescriptions`）：输入一张图片，输出一行描述：图中内容、可辨认的文字，使用聊天所用的语言。无评论，无 markdown | 无 |
| `describe-video.md` | 是 | 角色外提示，用于视频描述器（`features.videoDescriptions`）：输入一个视频片段（含声音），输出可配置长度的完整有序描述：谁出现了、说了什么（关键短语引用）、屏幕上的文字、视觉上发生了什么、音乐/音效。不接收角色卡 | `{{maxChars}}` |
| `rewatch.md` | 是 | 分类器：角色是否需要重看视频或重试未加载的视频（`features.videoRewatch`）。接收带状态的编号近期视频列表和新消息。输出为一行：`<number> \| <question>`、`<number> \| retry` 或 `none` | `{{name}}` |
| `rewatch-answer.md` | 是 | 角色外提示，用于重看回答：视频模型再次观看片段并回答一个问题。语言和限制规则与 `describe-video.md` 相同。不接收角色卡 | `{{question}}` `{{maxChars}}` |
| `address.md` | 是 | 分类器：未标记的消息是否在对角色说话 | `{{name}}` |
| `labels.json` | 是 | 代码插入提示中的所有字符串。键在下方固定，值由编写者决定 | 见下文 |

`{{name}}` 机器人的显示名称 · `{{author}}` 呼叫者的显示名称 · `{{trigger}}` `labels.triggers.*` 之一 ·
`{{target}}` 呼叫消息的索引（`#87`）。
系统消息 = `system-prompt` + `character-card` + `rules` + `format`。分析器则单独使用 `memory.md`。
在强制回合（`/nep interject`、`/nep initiate`）中，如果 `forced.md` 存在，则追加在模式提示之后。
分析器和预热的 `profile.md`、`server.md` 在用户消息中以 `<character>` 块接收角色卡和 `rules.md`。
`channel.md`、`describe.md`、`describe-video.md`、`rewatch.md`、`rewatch-answer.md` 和 `address.md` 不接收角色卡。

`{{guildFieldChars}}` 等于 `fieldChars * 2`，是代码对服务器级规律和开场白进行截断的上限。
`{{maxEpisodes}}` 是每人保留的回忆总数上限。两者均从配置填充，但默认提示未使用；自定义的 `memory.md`
可引用它们。

## 用户消息块（空块省略，按此顺序排列）

| 块 | 内容 |
|---|---|
| `<now>` | 日期、星期、`config.bot.timezone` 中的时间，使用 `labels.locale` 格式化 |
| `<senses>` | 角色此刻能感知和不能感知的内容，根据实时配置生成：哪些图片由角色自己看到，哪些通过辅助描述获得，对什么视而不见、听而不闻。使角色不会假装看过视频，并能用自己的语气开玩笑 |
| `<about_chat>` | 人们在这里如何交谈，如何发起和插入对话，内部梗 |
| `<server>` | 当前频道的完整信息（Discord 分类和话题、用途、人们写什么、氛围、活跃度、最后一条消息、最活跃作者；以 `labels.server.currentMark` 标记），加上仅限本轮向 `<other_channels>` 提供了消息的相邻频道；不包含其他频道 |
| `<lore>` | 关键词出现在近期消息中的服务器世界书条目（加上标记为 always 的条目）：事件、常驻角色、长期故事。如同世界书：可存在数百个，仅显示相关的少数 |
| `<self_facts>` | 角色声称过的关于自身的事实 |
| `<people>` | 成员档案；呼叫者排首位，以 `labels.profile.interlocutorMark` 标记；每个档案包含角色的态度，呼叫者还包含**回忆**：角色记住的关于两人之间的时刻，附带日期和简短引用 |
| `<other_channels>` | 每个相邻频道最多 `context.neighborMessages` 条消息，不超过 `context.neighborMaxAgeMinutes` 的时效 |
| `<chat>` | 当前频道最新的 `context.channelMessages` 条消息 |
| `<tempo>` | 10 分钟 / 1 小时 / 1 天的消息计数，不同人数，沉默时长，一个判定（活跃 / 缓慢 / 沉寂） |
| `<task>` | `reply` / `interject` / `initiate`，占位符已填充 |

预算优先级（区块从此列表的底部开始裁剪）：系统提示 + 任务 + 时钟 + 节奏 + 感知
（永不裁剪）→ 呼叫者的档案含回忆 → 聊天习惯 → 自述事实 → 世界书 → 服务器 → 对话记录（最新优先）→
其他档案 → 相邻频道。

对话记录行中的媒体，使用可用的最具信息量的形式：附加在当前请求上的图片 →
`transcript.imageAttached`（按图片在文本后的顺序编号）；已描述的 →
`imageDescribed` / `gifDescribed` / `videoDescribed`；其他情况使用盲形式 `image` / `gif` / `video`。
当视频视觉开启时（`features.mediaDescriptions` 和 `features.videoDescriptions` 同时启用），视频或视频站点链接
会获得一个状态：`videoWatched`（亲自观看，看到并听到）、`videoNotWatchedFrame`（未观看但静帧已描述）或
`videoNotWatched`（未观看，无帧）。原因代码（`length` / `size` / `daily` / `error`）在进入对话记录前会被替换
为 `transcript.videoReason.*` 中的人类可读短语。链接保留其基础标签（`link` / `linkText`）并添加视频附加标签：
`linkWatched`、`linkNotWatchedFrame` 或 `linkNotWatched`。当静帧作为图片附加时，还会添加 `frameAttached`。
链接使用 `link` / `linkText`，取自 Discord 的嵌入（站点、标题、摘要）；文本文件通过 `filePreview` 显示开头
内容；转发消息用 `forwarded` 包裹。

视频结果按附件或链接缓存在 `data/guilds/<id>/media.json` 中，键为 `video:<itemId>`（附件 id 或链接 URL 的稳定
哈希）。缓存条目：

- 已观看：`{ text, ts, watched: true }` — 永久，摘要文本。
- 限制未命中（时长或大小）：`{ miss: true, ts, reason: "length"|"size" }` — 永久，文件不会改变。
- 错误未命中：`{ miss: true, ts, reason: "error" }` — `media.video.errorRetryMinutes`（默认 60）分钟后重试，或在重看分类器发出强制重试时立即重试。
- 每日上限：不缓存；仅在该回合返回 `{ state: "limit", reason: "daily" }`。

重看回答缓存在键 `video:<itemId>:q:<hash>`（问题小写化并合并空白后 SHA-1 的前 16 位十六进制数字）下：`{ text, ts, answer: true }`。一小时后过期；代码在读取时删除过期条目。

图片的静帧条目保留其自身的 `<itemId>` 键。同一个条目可以同时存在两者。

对话记录行：`#87 [14:32] nick: text <replyTo> <media…> <sticker>`；角色自身的行使用 `labels.self`；行间使用
`labels.transcript.gap` / `gapWithDate` / `date`；区块以 `labels.transcript.header` 开头。相邻频道：相同的行
格式但不含 `#n`，位于 `# channel-name` 之下。

## `labels.json` 键（`{x}` 由代码填充）

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
transcript.videoWatched                  {name} {duration} {text}: first-hand — the persona saw and heard the clip
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
server.currentMark                       appended to the current channel's heading (starts with a space)
server.category | topic | purpose | topics | tone               {text}
server.activity                          {activity} = server.activityLive | activitySlow | activityDead
server.lastMessage                       {when}: humanised age of the channel's newest message
server.topWriters                        {names}: current names of the members who write there most
triggers.mention | reply | name | followUp   followUp = an untagged message the address classifier judged to be for the persona; such a turn posts plain, never as a Discord reply
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
```

## 模型输出：仅限以下标签

- `<think>…</think>` 可选，位于最前，1–4 行隐藏的思考过程；未闭合表示保持沉默。
- `<msg>text</msg>` 一条聊天消息，连续最多 3 条；`reply="#87"` 使其成为对对话记录中某行的 Discord 回复。
- `<react to="#87">💀</react>` 一个 unicode 表情；可单独使用，也可与 `<msg>` 一起使用。
- `<skip/>` 保持沉默。
- `@nick` 与对话记录中完全一致时转换为真实的提及。

`features.reactions: false` 移除 `<react>`，`features.multiMessage: false` 仅保留第一个 `<msg>`；提示无需知道这些。

## 分析器（`memory.md`）

一次调用更新角色记住的所有内容。它以角色的视角评判人们，因此会接收角色卡。频道是否活跃不由它判断，
由代码计数。预热通过预热提示（`profile.md`、`channel.md`、`server.md`）输入旧历史，不通过分析器。

提示中的数值限制是占位符，在运行时从 `config.memory.*` 和 `relationships.maxDeltaPerUpdate` 填充。

输入：`<character>` · `<existing_profiles>`（按用户 id 的 JSON，包含当前 `affinity` 分数、原因和已存储的
`episodes`）· `<existing_lore>` ·
`<existing_guild>` · `<existing_channels>`（按频道 id 的 JSON：`name`、Discord `category`、`topic`、已存储的
`purpose`、`topics`、`tone`）· `<new_messages>` 按 `## #channel-name (id:123)` 分组，行格式为
`[14:32] nick (id:123): text`，对角色说话的行以 `→ ` 开头，角色自身的行使用 `labels.self`。

输出：一个裸 JSON 对象。档案以增量方式更新：分析器返回变更内容，而非对已存储内容的重新概括，因此事实
不会因为逐批重写而退化：

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
  "guild": { "patterns": "", "starters": "", "injokes": [""] },
  "channels": { "<channelId>": { "purpose": "", "topics": "", "tone": "" } },
  "lore": [ { "title": "", "keys": [""], "text": "" } ],
  "self": [""]
}
```

- **兴趣是独立条目**，而非文本段落：`topic`（≤ `{{interestTopicChars}}`，标识，大小写不敏感地比较）和
  `note`（≤ `{{interestNoteChars}}`，具体是关于它的什么；可为空）。两个占位符分别从
  `memory.interestTopicChars` / `memory.interestNoteChars` 填充，与其他限制类似。每人最多存储
  `memory.maxInterests` 个，每个有一个权重，当分析器再次添加或更新时权重增长；权重最低的最先被淘汰。输入
  中显示已存储的条目，因此分析器仅添加新的，仅在学到新内容时更新笔记，仅移除该成员已明确放弃的。
- **细节也是独立条目**：`{ id, text, weight, firstSeen, lastSeen }`。输入中显示每个已存储细节及其数字
  `id`；`seen` 和 `remove` 通过该 id 引用细节（代码也接受完全匹配的已存储文本）。`add` 接受
  `{ text, sure? }`（也接受纯字符串）。超过 `memory.maxDetails` 时，权重最低的先淘汰，然后是最旧的。
- **确认（"(?)" 机制），兴趣和细节通用。**`weight` 统计一个事物被观察到的不同场合次数。新条目起始权重为
  1，或当分析器标记 `"sure": false` 时为 0（不确定属于谁、不确定是否认真的、或分析器不认识的名称）。
  `seen`（无新内容可说，但再次出现）、对已有条目的 `add` 和 `update` 各计为一次观察；仅当该成员在此批次
  中的消息距离该条目的 `lastSeen` 至少 `memory.confirmGapHours` 时，一次观察才使权重增加 1（因此一段跨
  多个批次的长对话只计一次）。对已有条目的 `"sure": false` 操作不产生任何变化。条目在权重 ≥
  `memory.confirmAfter` 时变为已确认；在此之前，聊天模型看到的条目会带有 `labels.profile.unsureMark`。
- **存储多于显示，且排名随时间衰减。**代码为每人保留最多 `memory.maxInterestsStored` /
  `memory.maxDetailsStored` 个条目；角色和分析器仅看到排名前 `memory.maxInterests` /
  `memory.maxDetails` 个。排名 = `log2(weight + 0.5) + lastSeen / halfLife`（半衰期为
  `memory.interestHalfLifeDays`、`memory.detailHalfLifeDays`），即权重随每个半衰期的沉默减半，因此频繁且
  近期的排在最前，而新条目可以在不可见的尾部积累权重而不是一出现就被淘汰。淘汰移除排名最低的。如果分析
  器 `add` 了一个已存储但未显示的条目，代码将其计为一次观察；因此提示告知分析器添加一切对它而言是新的
  内容，不要因为列表看起来满了就有所保留。
- **日期来自消息**，而非时钟：`firstSeen` / `lastSeen` 取自产生该观察的批次中该成员最新消息的时间（取
  最小值/最大值，因此乱序输入的历史仍能正常工作）。`lastSeen` 超过 `memory.interestStaleDays` 的兴趣在
  渲染给聊天模型时会带有 `labels.profile.staleMark`，并排在新鲜条目之后。细节永远不会过时。
- 已存储条目的输入视图：兴趣 `{ topic, note, seen, last }`，细节 `{ id, text, seen, last }`
  （`seen` = 权重，`last` = `YYYY-MM-DD`，未知时省略）。
- **归属，适用于每个档案字段。**某事只从该成员自身的消息中记录：他们提起了它、再次谈论它、或有实质性地
  讨论它。仅仅在场或仅回复了一次别人的话题，不构成归属。笔记只能包含关于那个话题的内容；当不确定某个
  评论属于哪个话题或哪个人时，丢弃或标记 `"sure": false`。服务器上每个人都做的事情属于 `guild.patterns`
  或 `lore`，不属于每个人的档案。
- **各个文本字段的定义。**`character`：该成员与他人互动时的表现方式，以少量（4–7 个）具体的反复出现的
  习惯表述，使用角色的声音（"习惯胜过标签"：绝不是一行形容词或评价）；技能、知识、职业、爱好和一次性
  行为不是性格。已存储的形容词/评价文本从该批次中重写，而非修补。`character`、`relationship`、态度
  `reason` 和回忆的 `feeling` 以角色卡中的角色声音撰写（可用第一人称，不用生硬术语）。`style`：该成员
  怎么写（长度、节奏、词汇、表情使用习惯），而非他们做什么或谈什么。`relationship`：角色和这个人之间的
  关系如何，不是新闻，也不是该成员与其他人的关系；当已存储文本为空且批次显示双方有实际互动（或已有
  affinity/episodes）时首次写入，之后仅在需要变更时返回。每个字段 ≤ `memory.fieldChars`；缺失的字段保持
  已存储的文本不变。`character` 和 `style` 仅由 `profile.md`（预热和画像刷新）撰写，流
  分析器不直接编辑。分析器在批次有必要时返回 `portrait`（一行提示，指出已存储文本遗漏了什么），代码会
  排队进行刷新。
- **成员通过 id 引用，而非昵称。**昵称随时变化，因此分析器撰写的每个自由文本字段（档案文本、兴趣笔记、
  细节文本、回忆的 `what`/`feeling`、态度原因、`guild` 字段、频道笔记、世界书 `text`、`self`）中的成员
  都写作 `<@id>` 标记（id 来自对话记录的 `nick (id:123)` 或 `<existing_profiles>`）。仅在分析器确定
  所指之人时使用；否则保留原名不变；id 绝不会被编造。逐字引用的 `quote` 和世界书 `keys`/`title` 保持
  原样。代码在使用时解析标记：对聊天模型 `<@id>` 变为该成员的当前名称（与对话记录中显示的相同，因此
  `@name` 仍然有效），对分析器则变为 `name (id:123)`；在输入端，代码将模型写回的 `name (id:123)` 转回
  标记，对未知 id 保持不变。
- **别名**是人们在聊天中实际称呼某成员的方式（一个稳定的昵称，如缩写或翻译过的名字），不是 Discord
  显示名称。`users.<id>.aliases: { "add": ["…"], "remove": ["…"] }`；存储为与兴趣类似的排名条目
  （`memory.maxAliases` 个显示，`memory.maxAliasesStored` 个保留，`memory.aliasHalfLifeDays`），对已知
  别名的 `add` 视为一次观察。输入视图将它们显示为简单列表；聊天模型通过 `labels.profile.aliases`
  `{text}` 看到它们。当前名称或别名出现在近期对话记录中的成员会被拉入 `<people>`，即使他们未发言；在
  触发消息或最近五条消息中被提及的成员（通过提及、当前名称或别名、4 个字符以上名称的前缀匹配）紧随呼叫
  者之后以完整形式显示（最多 `context.askedAboutProfiles` 个），其他近期参与者以简要形式显示（名称、
  别名、性格、态度、前 5 个话题）；预算先裁剪简要形式的档案。
- **主频道是画像的来源。**`memory.mainChannelIds`（默认 `[]`）列出人们相互交谈的频道；在
  `<existing_channels>` 中此类频道带有 `"main": true`（否则省略此键）。`character` 和 `style` 根据该
  成员在主频道中与他人交谈的方式来判断；日记和主题频道提供兴趣和细节，而非说话方式。在该成员没有主频道
  消息期间，画像是临时的且简短的。在包含该成员主频道消息的批次中，画像刷新会细化两个字段：返回完整的
  新文本（≤ `memory.fieldChars`），保留仍然成立的内容，添加批次中展现的新内容，让较新的证据优先于较旧
  的，丢弃不再体现的特征，使画像随着时间跟随该成员变化。当没有频道被标记为主频道时，所有频道都视为主
  频道。
- **服务器级笔记是关于服务器的。**一个人在自己频道中做的事情不是 `guild` 的规律、开场白或内部梗，也不是
  `lore`；内部梗是多人都在用的东西。
- **限制对模型是软性的，在代码中保持整洁。**提示指定一个限制 L（占位符，包括 `{{loreTextChars}}`，来自
  `lore.textChars`）；代码接受最多 `L * memory.clampTolerance`（默认 1.25），超出部分在最后一个句子或词
  的边界处截断，不会截在 `<@id>` 标记中间，并去除悬挂的左括号和末尾的分隔符。可见地在词中间断开的已
  存储笔记或文本（被旧版本截断）会在其主题下次出现时被完整重写。
- **输出精简。**`"sure"` 仅在值为 false 时写入；`affinity` 在无变化时省略。
- **每个事实只归一处。**一个事件归入 `episodes` 或 `lore`，一个事实归入 `details`，一个消遣归入
  `interests`；同一事物绝不写入多个字段。
- **与模型已有知识的合理性检查。**在将一个命名事物关联到另一个（一个地区、模式、角色或物品关联到一个
  游戏；一个人关联到一个作品系列）之前，分析器检查它们确实相关。当聊天的措辞与其知识冲突，或它不认识该
  事物时，不进行关联：单独记录该事物并标记 `"sure": false`。它绝不"纠正"聊天内容。
- **笔记说明该成员对这个话题做了什么**（玩、看相关视频、仅提到过），一个人很久以前做过但已放弃的事不是
  兴趣（至多是一个细节）。脱离对话上下文就无法理解的内容不予记录。
- 刻意未设：关于反讽或讽刺的任何规则。所有类型的不确定性都通过 `"sure": false` 表达。
- 分析器的提示保持简短；每增加一条规则都需要通过收紧现有文本来支付。
- 仅包含有新内容的用户和频道。返回的频道 / `guild` / `self` 是完整的合并值，替换已存储的值；空的
  `guild` / `self` = 无新内容。
- `affinity` 是一个变化量：整数 `delta`（通常 ±1…5，重大事件时最多 ±`relationships.maxDeltaPerUpdate`），
  单行 `reason` 指明观察到的事件。代码将其限制在 ±`relationships.maxDeltaPerUpdate` 范围内，累积到
  −100…100，保留简短历史。模型永远不设置绝对分数。
- `episodes` 是追加的，永不重写：仅返回值得记忆数月的新时刻：一次冒犯、一次善意、一个承诺、一次打赌、
  一场争执、一个共同的笑话、某人要求角色做或不做的事情。`what` 一行；`quote` 当事人的原话逐字引用，简短
  （≤ 120 字符），或为空；`feeling` 角色如何看待此事，通过角色卡判断；`weight` 1–5（5 = 永不遗忘）。
  每个用户每批次最多 `memory.maxNewEpisodes` 个；大多数批次不添加任何回忆。输入中显示已存储的回忆，因此
  不会重复记录。代码为每人保留 `memory.maxEpisodes` 个，先淘汰最轻的，然后是最旧的。
- `lore` 是服务器的世界书：跨越对话存在的事物：事件（"某某离开的那天"）、常驻角色和宠物、长期故事、
  恩怨、传统。`title` 是标识（同标题的条目视为更新，携带完整的合并文本），`keys` 2–6 个人们实际输入的词
  或短语（名称、昵称、梗的原话，使用聊天的语言，小写），`text` ≤ `lore.textChars`（`{{loreTextChars}}`）。
  输入 `<existing_lore>` 列出已存储的标题及其关键词，以及批次涉及的条目的完整文本。所有者通过
  `/nep lore add` 添加的条目永远不会被分析器修改。
- 字符串字段 ≤ `memory.fieldChars`；细节 ≤ `memory.maxDetails`，内部梗 ≤ `memory.maxInjokes`，自述 ≤
  `memory.maxSelfFacts`。笔记使用聊天所用的语言。仅记录观察到的事实；不记录敏感信息（地址、电话、证件、
  健康、财务、真实全名）。

## 服务器记忆（频道地图）

`<server>` 块由已存储的频道笔记和代码维护的事实组装而成，过滤后仅包含与本轮相关的频道。当前频道排首位，
以 `labels.server.currentMark` 标记；然后仅包含本轮向 `<other_channels>` 贡献了消息的相邻频道，各自完整
显示。其他所有已存储的频道均被排除。在大型服务器上，其中大多数与当前无关，会浪费预算。

频道条目（`src/memory/channels.js` 中的 `renderChannel`）包含：

- **Discord 事实：**名称（`# heading`）、分类、话题。从首次看到该频道时即存在。
- **分析器笔记：**用途、话题、氛围。由预热期间的 `channel.md` 写入，由流分析器（`memory.md`）从实时批次
  中更新。三者均为自由文本，在渲染时进行标记解析（`<@id>` → 当前名称）。
- **代码维护的计数器：**消息数量、首条和末条消息的时间戳、30 天活跃度直方图（每 UTC 天的消息数，截取至
  最近 30 天）以及前 5 名作者（按消息数量，排除机器人和角色自身）。预热通过 `store.setChannelFacts` 从
  频道获取的历史中填充这些数据；实时流量通过 `store.touchChannel` 保持其更新。
- **活跃度判定：**`live`、`slow` 或 `dead`，由 `channelActivity` 从计数器计算，永远不由模型判定。当今日
  和昨日（UTC）消息总数达到 `context.channelActivity.liveMessagesPerDay`（默认 20）时为 `live`。当频道从
  未有过消息或最后一条消息超过 `context.channelActivity.deadAfterDays`（默认 7）天时为 `dead`。其余为
  `slow`。通过 `labels.server.activity` / `activityLive` / `activitySlow` / `activityDead` 渲染。
- **最后消息时效：**当标签存在且数据可用时，通过 `labels.server.lastMessage` 人性化显示。
- **最活跃作者：**通过 `labels.server.topWriters` 渲染，将已存储的作者 id 解析为当前名称；无档案的 id
  被跳过。

当前频道尚无存储笔记（分析器尚未处理过）时，会从对话记录中消息的 Discord 事实合成一个回退条目，使角色
仍然知道自己在哪里。

## 预热（`profile.md`、`channel.md`、`server.md`）：记忆如何启动

每个预热请求处理一个工作单元（一个频道、一个成员或服务器），以保持归属的清晰。`channel.md` 生成频道笔记
（用途、话题、氛围）。`profile.md` 生成成员的性格、风格、兴趣、细节、回忆和别名。`server.md` 生成服务器
级的规律、开场白、内部梗和世界书。运行顺序、采样、进度、限制和子命令见[预热](warmup.md)。

### 数据模型

`character` 和 `style` 保持自由文本形式，仅由 `profile.md` 撰写：预热和画像刷新。流分析器不直接编辑
它们：对于批次中显示出存储画像遗漏或矛盾的反复出现的习惯或写作方式变化的成员，分析器返回
`users.<id>.portrait: "一行：画像遗漏了什么"`。然后代码为该成员排队进行刷新：以已存储的性格 + 风格作为
`<draft>`，分析器的那行作为 `<hint>`，使用该成员最新的消息调用 `profile.md`，回答中的 `character` 和
`style` 替换已存储的版本（该回答中的兴趣、细节、回忆和别名被忽略；它们通过流操作持续流入）。

态度和 `relationship` 不参与预热；它们仅从实时对话中增长。

`profile.md` 输出：`{ "character": "", "style": "", "interests": [{ topic, note, times }], "details": [{ text, times }],
"episodes": [...], "aliases": [""] }`；块 `<character>` `<member>` `<draft>`（可选）`<hint>`（可选，仅画像
刷新时）`<snippets>`。片段中自身的行以 `labels.warmup.ownMark` 开头；上下文行以
`labels.warmup.contextMark` 开头。别名来自其他人的行（他们如何称呼该成员），因此自身消息的归属规则不适用
于别名。

## 地址分类器（`address.md`）：未标记的消息是否在对角色说话？

角色回复某人后，该频道内打开一个对话窗口（`mention.followUpMinutes`，每次进一步回复时延长）。窗口内不
携带触发信号（无提及、无对角色消息的回复、无名字）的消息不会被盲目回复：代码将频道最近的
`mention.followUpContext`（默认 15）行发送给 `address.md`，角色自身的行以 `labels.self` 标记，加上以
`<candidate>` 标记的新消息，使用 `followUp` 模型角色（`mention.followUpModel`，默认 `anthropic/claude-sonnet-4.6`）。输出
为一行：当候选消息是在对角色说话或延续与角色的对话时为 `yes`，当人们在相互交谈或对其他人说话时为 `no`
（对另一成员的回复或对另一成员的提及在询问模型之前即为 `no`）。`yes` 触发正常的回复回合（模型仍可
`<skip/>`）；连续三个 `no`（`mention.followUpNoStreak`，默认 3）关闭窗口。开关 `features.followUp`
（默认开启）。仅记录计数和判定结果。
窗口状态在重启后保留：活跃窗口保存在 `data/state.json` 的 `followUpWindows` 中，启动时恢复，过期的窗口会被丢弃。

## 重看分类器（`rewatch.md`）：是否需要再看一遍视频？

当角色被呼叫（回复回合）且频道最近 `media.video.rewatch.recentMessages`（默认 60）条消息中有视频时，分类器判断
该消息是否在询问其中某个视频，或请求重试一个未加载的视频。候选包括已观看视频和错误状态视频（请求的重试使用独立于回合 `media.video.maxPerTurn`
尝试次数的专用槽位）。分类器最多收到 `media.video.rewatch.maxCandidates`（默认 6）个视频，按最新
消息优先排列。代码将 `rewatch.md` 作为系统提示发送到后续模型角色（`mention.followUpModel`，默认 `anthropic/claude-sonnet-4.6`），
用户消息包含三个块：一个短的 `<transcript>` 包含频道最近几条消息，角色自身的行以 `labels.self` 标记（使分类器能看到候选消息回复的对象），然后是视频列表和候选：

```
<transcript>
...
</transcript>
<videos>
<number> | <name> | <status> | <描述的开头>
...
</videos>
<candidate>
<作者名>: <触发文本>
</candidate>
```

每行 `<videos>` 包含四个 `|` 分隔的列：序号（1 = 最新视频）、视频名称、状态（`watched` 或 `not loaded`）和摘要的
前 200 个字符（未加载的视频为空）。名称和摘要的空白合并为一行。触发文本在 `context.maxMessageChars` 处截断。输出
为一行：

- `<number> | <question>` — 消息询问已观看视频，需要描述未涵盖的细节。编号从列表原样复制。
- `<number> | retry` — 消息关于未加载的视频，请求再试或询问其内容。编号从列表原样复制。
- `none` — 不需要重看或重试。

问题命中时，视频模型使用 `rewatch-answer.md`（`{{question}}` 和 `{{maxChars}}` = `rewatch.answerChars`，默认
1200）再次观看片段，回答以 `transcript.videoAnswered`（`{question}`、`{text}`）的形式追加在已观看标签之后。当功能
开启时，`<senses>` 块包含 `senses.videoRewatch`。

重试命中时，视频模型使用 `force`（忽略错误缓存）观看片段，使用与首次观看相同的 `describeVideo` 路径。如果重试成功，
视频状态从错误变为已观看，对话记录中显示的摘要为第一手内容。重试计为 `media.video.maxPerTurn` 和
`media.video.maxPerDay` 的新视频尝试。

限制：每回合最多一次重看或重试；分类器和重看各自计入 `llm.maxRequestsPerDay`；重看还计入
`media.video.maxPerDay`；`media.video.rewatch.maxPerDay`（默认 20）单独限制重看次数。回答按问题缓存一小时（参见
上方视频缓存部分）。开关 `features.videoRewatch`（缺失 = 开启，需要 `videoDescriptions`）。
