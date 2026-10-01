# 提示契约

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
| `memory.md` | 是 | 角色外提示，用于流分析器：从实时批次中对记忆进行针对性编辑 | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` |
| `profile.md` | 是 | 预热 / 画像刷新：从消息样本生成一个成员的档案 | `{{name}}` `{{fieldChars}}` `{{maxInterests}}` `{{maxDetails}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{maxNewEpisodes}}` |
| `channel.md` | 是 | 预热：从消息样本生成频道笔记 | `{{fieldChars}}` |
| `server.md` | 是 | 预热：从频道笔记和成员摘要生成服务器级笔记 | `{{name}}` `{{fieldChars}}` `{{maxInjokes}}` `{{loreTextChars}}` |
| `describe.md` | 是 | 角色外提示，用于媒体描述器（`features.mediaDescriptions`）：输入一张图片，输出一行描述：图中内容、可辨认的文字，使用聊天所用的语言。无评论，无 markdown | 无 |
| `describe-video.md` | 是 | 角色外提示，用于视频描述器（`features.videoDescriptions`）：输入一个视频片段（含声音），输出可配置长度的完整有序描述：谁出现了、说了什么（关键短语引用）、屏幕上的文字、视觉上发生了什么、音乐/音效。不接收角色卡 | `{{maxChars}}` |
| `rewatch.md` | 是 | 分类器：角色是否需要重看视频或重试未加载的视频（`features.videoRewatch`）。接收带状态的编号近期视频列表和新消息。输出为一行：`<number> \| <question>`、`<number> \| retry` 或 `none` | `{{name}}` |
| `rewatch-answer.md` | 是 | 角色外提示，用于重看回答：视频模型再次观看片段并回答一个问题。语言和限制规则与 `describe-video.md` 相同。不接收角色卡 | `{{question}}` `{{maxChars}}` |
| `address.md` | 是 | 分类器：未标记的消息是否在对角色说话 | `{{name}}` |
| `lookup.md` | 否 | 分类器：角色是否需要搜索网络来回答这条消息（`features.webLookup`）。接收一段短对话记录和一个 `<candidate>` 块。输出为一行：一个搜索查询（纯文字，最多 12 个词）或 `none` | `{{name}}` |
| `read-link.md` | 否 | 角色外提示，用于链接阅读器（`features.webLookup`，`web.links.enabled`）：将获取的页面浓缩为一个段落。接收页面标题和正文。不接收角色卡 | `{{maxChars}}` |
| `search-summary.md` | 否 | 角色外提示，用于搜索浓缩器（`features.webLookup`，`web.search.enabled`）：将编号的搜索结果浓缩为带内联来源的笔记。不接收角色卡 | `{{query}}` `{{maxChars}}` |
| `private.md` | 否 | 追加在模式提示（`reply.md`）之后、`forced.md` 之前，仅在 DM 中使用（`features.privateMessages`）。这是一段私聊：此处所说的一切留在此处；角色保留其公共知识。文件不存在则不追加任何内容 | `{{name}}` `{{author}}` |
| `draw.md` | 是 | 绘画子进程的角色外提示（`features.imageGeneration`）：根据场景描述生成一张图片。仅接收外貌和请求，不接收角色卡 | `{{name}}` `{{appearance}}` `{{request}}` |
| `appearance.md` | 否 | 角色的视觉外貌，在 `self="yes"` 时插入 `draw.md`。一段话，无性格，无背景故事 | `{{name}}` |
| `mentor-situations.md` | 否 | Mentor：为 reply 目标案例构造测试场景（`features.mentor`）。仅返回 JSON | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-situations-memory.md` | 否 | Mentor：为 memory 目标案例构造测试场景（`features.mentor`）。仅返回 JSON | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-score.md` | 否 | Mentor：对角色的回答进行评分（`features.mentor`）。接收角色卡。仅返回 JSON | `{{name}}` |
| `mentor-score-memory.md` | 否 | Mentor：对分析器将存储的文本进行评分（`features.mentor`）。无角色卡。`character` 轴始终为 `null`。仅返回 JSON | `{{name}}` |
| `mentor-signs.md` | 否 | Mentor：已知的模型文本习惯，作为 `<signs>` 块在每次 mentor 请求中发送（`features.mentor`）。文件缺失或为空时省略 | `{{name}}` |
| `mentor-diagnose.md` | 否 | Mentor：评分后解释弱回答，指出角色上下文中的具体文本（`features.mentor`）。结果为未验证的假设，存储为运行中的 `diagnosis`。`mentor.diagnose` 为 false 或文件缺失时省略 | `{{name}}` |
| `variety.md` | 否 | `classifier.text` 请求：识别角色近期消息中重复的表达手法（`features.variety`）。不接收角色卡 | `{{name}}` `{{maxPatterns}}` `{{shapeChars}}` |
| `labels.json` | 是 | 代码插入提示中的所有字符串。键在下方固定，值由编写者决定 | 见下文 |

`{{name}}` 机器人的显示名称 · `{{author}}` 呼叫者的显示名称 · `{{trigger}}` `labels.triggers.*` 之一 ·
`{{target}}` 呼叫消息的索引（`#87`）。
系统消息 = `system-prompt` + `character-card` + `rules` + `format`。分析器则单独使用 `memory.md`。
在强制回合（`/nep interject`、`/nep initiate`）中，如果 `forced.md` 存在，则追加在模式提示之后。
在私聊中，`private.md` 追加在模式提示之后（`forced.md` 之前），使用相同的 `{{name}}` 和 `{{author}}` 占位符。
分析器和预热的 `profile.md`、`server.md` 在用户消息中以 `<character>` 块接收角色卡和 `rules.md`。
`channel.md`、`describe.md`、`describe-video.md`、`draw.md`、`rewatch.md`、`rewatch-answer.md`、`address.md`、`lookup.md`、`read-link.md`、`search-summary.md` 和 `variety.md` 不接收角色卡。

`{{guildFieldChars}}` 等于 `fieldChars * 2`，是代码对服务器级规律和开场白进行截断的上限。
`{{maxEpisodes}}` 是每人保留的回忆总数上限。两者均从配置填充，但默认提示未使用；自定义的 `memory.md`
可引用它们。

## 块

用户消息的各个块。空块省略；顺序如下表所列。

| 块 | 内容 |
|---|---|
| `<now>` | 日期、星期、`config.bot.timezone` 中的时间，使用 `labels.locale` 格式化 |
| `<senses>` | 角色此刻能感知和不能感知的内容，根据实时配置生成：哪些图片由角色自己看到，哪些通过辅助描述获得，对什么视而不见、听而不闻。使角色不会假装看过视频，并能用自己的语气开玩笑 |
| `<about_chat>` | 人们在这里如何交谈，如何发起和插入对话，内部梗，人们教给角色的东西 |
| `<server>` | 当前频道的完整信息（Discord 分类和话题、用途、人们写什么、氛围、活跃度、最后一条消息、最活跃作者；以 `labels.server.currentMark` 标记），加上仅限本轮向 `<other_channels>` 提供了消息的相邻频道；不包含其他频道 |
| `<lore>` | 关键词出现在近期消息中的服务器世界书条目（加上标记为 always 的条目）：事件、常驻角色、长期故事。如同世界书：可存在数百个，仅显示相关的少数 |
| `<self_facts>` | 角色声称过的关于自身的事实 |
| `<people>` | 成员档案；呼叫者排首位，以 `labels.profile.interlocutorMark` 标记；每个档案包含角色的态度，呼叫者还包含**回忆**：角色记住的关于两人之间的时刻，附带日期和简短引用 |
| `<other_channels>` | 每个相邻频道最多 `context.neighborMessages` 条消息，不超过 `context.neighborMaxAgeMinutes` 的时效 |
| `<worn>` | 角色在近期消息中过度使用的手法（`features.variety`）：`labels.variety.intro`，然后每个手法一行 `- <shape> ("<example>", ...)`。过程未执行、未发现或开关关闭时省略 |
| `<lookup>` | 角色本轮在线查询的内容（`features.webLookup`）：查询词、浓缩的答案和来源站点，或"未找到"行。仅在搜索分类器触发且搜索完成后出现 |
| `<chat>` | 当前频道最新的 `context.channelMessages` 条消息 |
| `<tempo>` | 10 分钟 / 1 小时 / 1 天的消息计数，不同人数，沉默时长，一个判定（活跃 / 缓慢 / 沉寂） |
| `<task>` | `reply` / `interject` / `initiate`，占位符已填充 |

预算优先级（区块从此列表的底部开始裁剪）：系统提示 + 任务 + 时钟 + 节奏 + 感知
（永不裁剪）→ 呼叫者的档案含回忆 → 查询结果（整体保留或丢弃）→ 聊天习惯 → 自述事实 → 世界书 → 服务器 → 对话记录（最新优先）→
其他档案 → worn（整体保留或丢弃）→ 相邻频道 → 表情符号（从底部删除条目，然后删除整个块；`context.caps.emoji`）→ GIF（同样的裁剪；`context.caps.gifs`）。

对话记录行中的媒体，使用可用的最具信息量的形式：附加在当前请求上的图片 →
`transcript.imageAttached`（按图片在文本后的顺序编号）；已描述的 →
`imageDescribed` / `gifDescribed` / `videoDescribed`；其他情况使用盲形式 `image` / `gif` / `video`。
当视频视觉开启时（`features.mediaDescriptions` 和 `features.videoDescriptions` 同时启用），视频或视频站点链接
会获得一个状态：`videoWatched`（亲自观看，看到并听到）、`videoNotWatchedFrame`（未观看但静帧已描述）或
`videoNotWatched`（未观看，无帧）。原因代码（`length` / `size` / `daily` / `error`）在进入对话记录前会被替换
为 `transcript.videoReason.*` 中的人类可读短语。链接保留其基础标签（`link` / `linkText`）并添加视频附加标签：
`linkWatched`、`linkNotWatchedFrame` 或 `linkNotWatched`。当静帧作为图片附加时，还会添加 `frameAttached`。
链接使用 `link` / `linkText`，取自 Discord 的嵌入（站点、标题、摘要）；当 `features.webLookup` 开启且链接已被阅读时，`linkRead` 追加在链接的其他附加标签（视频、缩略图）之后。文本文件通过 `filePreview` 显示开头
内容；转发消息用 `forwarded` 包裹。当 `features.seeReactions` 开启（默认）时，反应标签追加在行的
最末尾，位于媒体标签和转发包裹之后。每条消息最多列出 `context.reactionsPerMessage` 个反应，按频率降序排列；
每个条目使用 `transcript.reactionItem` 或 `transcript.reactionMine`（当角色是反应者之一时），以 ", " 连接
并包裹在 `transcript.reactions` 中。缺少 `transcript.reactions` 键的标签文件不渲染任何内容。

视频结果按附件或链接缓存在 `data/guilds/<id>/media.json` 中，键为 `video:<itemId>`（附件 id 或链接 URL 的稳定
哈希）。缓存条目：

- 已观看：`{ text, ts, watched: true }`：永久，摘要文本。
- 限制未命中（时长或大小）：`{ miss: true, ts, reason: "length"|"size" }`：永久，文件不会改变。
- 错误未命中：`{ miss: true, ts, reason: "error" }`：`media.video.errorRetryMinutes`（默认 60）分钟后重试，或在重看分类器发出强制重试时立即重试。
- 每日上限：不缓存；仅在该回合返回 `{ state: "limit", reason: "daily" }`。

重看回答缓存在键 `video:<itemId>:q:<hash>`（问题小写化并合并空白后 SHA-1 的前 16 位十六进制数字）下：`{ text, ts, answer: true }`。一小时后过期；代码在读取时删除过期条目。

图片的静帧条目保留其自身的 `<itemId>` 键。同一个条目可以同时存在两者。

网络查询结果缓存在同一个 `data/guilds/<id>/media.json` 中，与视频和图片条目并列：

- 链接阅读：`read:<link.id>` 保存 `{ text, ts }`（浓缩摘要，永久）或 `{ miss, ts, reason }`（未命中跳过 6 小时；原因：`scheme`、`private`、`redirects`、`type`、`size`、`timeout`、`http`、`network`、`empty`、`unreadable`、`llm`）。`TokenLimitError` 或 `DailyCapError` 不缓存。
- 搜索：`search:<规范化查询 SHA-1 前缀，16 位十六进制>` 保存 `{ query, text, sources, ts }`，在 `web.search.cacheHours`（默认 24）小时内从缓存提供。空 `text` 表示无结果（渲染 `labels.lookup.none`）。失败不缓存。

对话记录行：`#87 [14:32] nick: text <replyTo> <media…> <sticker> <reactions>`；角色自身的行使用 `labels.self`；行间使用
`labels.transcript.gap` / `gapWithDate` / `date`；区块以 `labels.transcript.header` 开头。相邻频道：相同的行
格式但不含 `#n`，位于 `# channel-name` 之下。

## 标签

`labels.json` 的键；`{x}` 由代码填充。

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
transcript.reactions                     OPTIONAL {list}: appended at the end of a line after all media and forwarded tags; list is items joined with ", ". A labels file without this key renders nothing
transcript.reactionItem                  {emoji} {count}: one reaction; emoji is unicode or :name: for custom
transcript.reactionMine                  {emoji} {count}: used instead of reactionItem when the persona is among the reactors; reads correctly whether count is 1 or more
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

## 输出

模型输出中只处理以下标签：

- `<think>…</think>` 可选，位于最前，1–4 行隐藏的思考过程；未闭合表示保持沉默。
- `<msg>text</msg>` 一条聊天消息，连续最多 3 条；`reply="#87"` 使其成为对对话记录中某行的 Discord 回复。
- `<react to="#87">💀</react>` 一个 unicode 表情；可单独使用，也可与 `<msg>` 一起使用。
- `<draw self="yes" reply="#87">scene</draw>` 提交给绘画子进程的图片。每回合一个，首个非空优先，截断至 800 字符。`self="yes"` 添加角色外貌；`reply="#87"` 与 `<msg>` 用法相同。可与 `<msg>` 和 `<react>` 同时出现。
- `<skip/>` 保持沉默。
- `@nick` 与对话记录中完全一致时转换为真实的提及。

`features.reactions: false` 移除 `<react>`，`features.multiMessage: false` 仅保留第一个 `<msg>`；
`features.imageGeneration: false` 或无图像客户端时移除 `<draw>`；`drawFailed` 回合中 `<draw>` 也被移除。提示无需知道这些。

## 分析器

一次调用（`memory.md`）更新角色记住的所有内容。它以角色的视角评判人们，因此会接收角色卡。频道是否活跃不由它判断，
由代码计数。预热通过预热提示（`profile.md`、`channel.md`、`server.md`）输入旧历史，不通过分析器。

提示中的数值限制是占位符，在运行时从 `config.memory.*` 和 `relationships.maxDeltaPerUpdate` 填充。

输入：`<character>` · `<existing_profiles>`（按用户 id 的 JSON，包含当前 `affinity` 分数、原因和已存储的
`episodes`）· `<existing_lore>` ·
`<existing_guild>`（JSON：规律、开场白、内部梗、学到的条目）· `<existing_channels>`（按频道 id 的 JSON：`name`、Discord `category`、`topic`、已存储的
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
  "guild": { "patterns": "", "starters": "", "injokes": [""],
             "learned": { "add": [{ "text": "", "from": "<@id>" }], "seen": [3], "remove": [3] } },
  "channels": { "<channelId>": { "purpose": "", "topics": "", "tone": "" } },
  "lore": [ { "title": "", "keys": [""], "text": "" } ],
  "self": [""]
}
```

- **兴趣是独立条目**，而非文本段落：`topic`（≤ `{{interestTopicChars}}`，标识，大小写不敏感地比较）和
  `note`（≤ `{{interestNoteChars}}`，具体是关于它的什么；可为空）。两个占位符分别从
  `memory.interestTopicChars` / `memory.interestNoteChars` 填充，与其他限制类似。每人最多存储
  `memory.maxInterestsStored` 个，每个有一个权重，当分析器再次添加或更新时权重增长；排名最低的最先被淘汰。输入
  中显示已存储的条目，因此分析器仅添加新的，仅在学到新内容时更新笔记，仅移除该成员已明确放弃的。
- **细节也是独立条目**：`{ id, text, weight, firstSeen, lastSeen }`。输入中显示每个已存储细节及其数字
  `id`；`seen` 和 `remove` 通过该 id 引用细节（代码也接受完全匹配的已存储文本）。`add` 接受
  `{ text, sure? }`（也接受纯字符串）。超过 `memory.maxDetailsStored` 时，排名最低的先淘汰。
- **学到的条目是服务器级的独立条目**：`{ id, text, from, weight, firstSeen, lastSeen }`。`from` 存储教导者
  （`<@id>`，或为空）。使用与细节相同的 `add` / `seen` / `remove` 操作、相同的确认机制、相同的排名和淘汰规则。
  `memory.maxLearned` 个显示，`memory.maxLearnedStored` 个保留，`memory.learnedChars` 为每个条目的字符上限。
  聊天模型在 `<about_chat>` 中内部梗行之后按排名顺序看到它们，未确认的带有 `labels.aboutChat.unsureMark` 标记。
- **确认（"(?)" 机制），兴趣、细节和学到的条目通用。**`weight` 统计一个事物被观察到的不同场合次数。新条目起始权重为
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
  `interests`，对角色的教导归入 `learned`；同一事物绝不写入多个字段。
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

## 频道地图

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

## 预热

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

## 地址分类器

角色回复某人后，该频道内打开一个对话窗口（`mention.followUpMinutes`，每次进一步回复时延长）。窗口内不
携带触发信号（无提及、无对角色消息的回复、无名字）的消息不会被盲目回复：代码将频道最近的
`mention.followUpContext`（默认 15）行发送给 `address.md`，角色自身的行以 `labels.self` 标记，加上以
`<candidate>` 标记的新消息，使用 `classifier.text` 模型角色（默认 `anthropic/claude-sonnet-4.6`）。输出
为一行：当候选消息是在对角色说话或延续与角色的对话时为 `yes`，当人们在相互交谈或对其他人说话时为 `no`
（对另一成员的回复或对另一成员的提及在询问模型之前即为 `no`）。`yes` 触发正常的回复回合（模型仍可
`<skip/>`）；连续三个 `no`（`mention.followUpNoStreak`，默认 3）关闭窗口。开关 `features.followUp`
（默认开启）。仅记录计数和判定结果。
窗口状态在重启后保留：活跃窗口保存在 `data/state.json` 的 `followUpWindows` 中，启动时恢复，过期的窗口会被丢弃。

## 重看分类器

当角色被呼叫（回复回合）且频道最近 `media.video.rewatch.recentMessages`（默认 60）条消息中有视频时，分类器判断
该消息是否在询问其中某个视频，或请求重试一个未加载的视频。候选包括已观看视频和错误状态视频（请求的重试使用独立于回合 `media.video.maxPerTurn`
尝试次数的专用槽位）。分类器最多收到 `media.video.rewatch.maxCandidates`（默认 6）个视频，按最新
消息优先排列。代码将 `rewatch.md` 作为系统提示发送到 `classifier.text` 模型角色（默认 `anthropic/claude-sonnet-4.6`），
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

- `<number> | <question>`：消息询问已观看视频，需要描述未涵盖的细节。编号从列表原样复制。
- `<number> | retry`：消息关于未加载的视频，请求再试或询问其内容。编号从列表原样复制。
- `none`：不需要重看或重试。

问题命中时，视频模型使用 `rewatch-answer.md`（`{{question}}` 和 `{{maxChars}}` = `rewatch.answerChars`，默认
1200）再次观看片段，回答以 `transcript.videoAnswered`（`{question}`、`{text}`）的形式追加在已观看标签之后。当功能
开启时，`<senses>` 块包含 `senses.videoRewatch`。

重试命中时，视频模型使用 `force`（忽略错误缓存）观看片段，使用与首次观看相同的 `describeVideo` 路径。如果重试成功，
视频状态从错误变为已观看，对话记录中显示的摘要为第一手内容。重试计为 `media.video.maxPerTurn` 和
`media.video.maxPerDay` 的新视频尝试。

限制：每回合最多一次重看或重试；分类器和重看各自计入 `llm.maxRequestsPerDay`；重看还计入
`media.video.maxPerDay`；`media.video.rewatch.maxPerDay`（默认 20）单独限制重看次数。回答按问题缓存一小时（参见
上方视频缓存部分）。开关 `features.videoRewatch`（缺失 = 开启，需要 `videoDescriptions`）。

## 搜索分类器

当角色被呼叫（回复回合）且以下条件全部满足时（`features.webLookup` 开启、`web.search.enabled` 不为 false、
`lookup.md` 提示文件存在、`web.search.maxPerTurn` 至少为 1、且已配置 `BRAVE_SEARCH_API_KEY`），分类器判断触发消息
是否需要网络搜索。它使用 `classifier.text` 模型角色。代码将 `lookup.md` 作为系统提示，用户消息包含一个短的
`<transcript>`（与重看分类器相同，角色自身的行以 `labels.self` 标记）和一个 `<candidate>` 块：

```
<transcript>
...
</transcript>
<candidate>
<作者名>: <触发文本>
</candidate>
```

对话记录在可用时携带描述、视频摘要和链接阅读内容。触发文本在 `context.maxMessageChars` 处截断。输出为一行：

- 一个搜索查询（纯文字，无引号，无操作符，最多 12 个词）：当消息需要聊天之外的事实时。
- `none`：其他所有情况。

查询命中时，Brave Search 运行查询（`web.search.results` 个结果，默认 5），编号的结果通过 `classifier.text` 经
`search-summary.md`（`{{query}}`、`{{maxChars}}` = `web.search.summaryChars`，默认 900）浓缩，答案渲染为
`<chat>` 之前的 `<lookup>` 块：`labels.lookup.header` 附带查询词，浓缩文本，以及 `labels.lookup.sources` 附带
不同的站点名称。当搜索无结果或浓缩器未找到有用内容时，显示 `labels.lookup.none`。

限制：每回合最多一次搜索；分类器和浓缩器各自计入 `llm.maxRequestsPerDay`；搜索本身计入 `web.maxPerDay`
（与链接阅读共享）。结果按规范化查询缓存 `web.search.cacheHours`（默认 24）小时。开关 `features.webLookup`
（缺失 = 关闭）。

## 多样性过程

每轮之前，`classifier.text` 过程读取角色近期的自身消息，识别角色正在陷入的重复手法（惯用表达、结构性套路、重复的玩笑模式）。结果成为本轮请求中的 `<worn>` 块。开关 `features.variety`（缺失 = 开启）。

### 消息选取

最多 `variety.window`（默认 12）条角色自身消息：先取本轮频道的（最新的优先），再取其他服务器频道的（存储在服务器记忆中的 `ownLines` 环，角色每次在服务器频道发送消息时写入）。只保留不超过 `variety.recentMinutes`（默认 45）分钟的消息。少于 `variety.minLines`（默认 3）条时整个过程跳过。机器人发出的限制通知（`labels.limits.notice`）不计为角色自身消息。

### `<lines>` 格式

消息编号 `#1`、`#2`、... 从最旧开始，空白折叠为一行。当消息是对另一条的回复时，附加 `(to: <该消息截断至 variety.contextChars>)`。`variety.contextChars` 为 0 时省略上下文。

### 输出与验证

一个裸 JSON 对象：

```
{ "patterns": [ { "shape": "", "examples": ["", ""], "count": 0 } ] }
```

`shape`：手法的描述，3 到 `variety.shapeChars` 字符，使用消息的语言。`examples`：1 到 3 个从角色自身用语中逐字复制的片段（不来自 `(to: ...)` 上下文），每个最多 80 字符，仅当文本出现在发送的消息中时保留（不区分大小写）。`count`：至少 2，上限为发送的消息数。最多 `variety.maxPatterns` 个有效手法；空列表是正常结果。不是预期 JSON 的回答不产生块。

### 缓存与存储

同一组消息不会连续被询问两次。服务器级缓存以消息 id 的 SHA-1 为键，无需模型请求即可复用上次结果。

`worn` 存储在服务器记忆中（`data/guilds/<id>/guild.json`）：最新过程的 `{ at, key, channelId, lines, patterns }`。`wornHistory` 是最多 `variety.history`（默认 20）次历史过程的环，仅 shape 和 count，不含 examples。在私聊中执行的过程会为本轮产生 patterns，但不保存到服务器记忆，私聊中的内容不会出现在所有者视图或其他对话中。

### 超时与失败

`variety.timeoutMs`（默认 8000）限制模型请求。超时或失败不产生 `<worn>` 块；本轮在没有该块的情况下继续，最近存储的过程保持不变。

### Mentor

Mentor 沙盒为每个 reply 目标场景执行一次多样性过程，计入 mentor 的 token 预算（不计入 `llm.maxRequestsPerDay`）。识别的手法保存为场景记录上的 `worn`。评分者不会看到 `<worn>` 块。

## 绘画

角色可以通过绘画子进程（`features.imageGeneration`，默认开启）生成图片。当模型输出 `<draw>` 标签时，
`src/behavior/turn.js` 从 `draw.md` 组装图像提示，通过 OpenRouter Images API（`src/llm/images.js`）生成一张图片。
图片作为独立消息发布在角色的文本消息之后，不会内联。

### 提示组装

`buildDrawPrompt`（`src/behavior/prompt.js`）用三个占位符填充 `draw.md`：

- `{{name}}` — 机器人的显示名称。
- `{{appearance}}` — 填充了 `{{name}}` 的 `appearance.md`，仅在 `self="yes"` 时包含。否则为空。
- `{{request}}` — `<draw>` 标签的场景文本，截断至 `image.maxPromptChars`（默认 800）。

绘画子进程不接收角色卡、`rules.md` 或系统提示。它遵循 `draw.md` 内的独立风格部分。

### 参考图

当角色出现在图片中（`self="yes"`）且 `image.reference` 为 `'avatar'`（默认）时，机器人的 Discord 头像被下载并作为
`input_references` 条目发送，使图像模型能看到角色的外观。如果无法获取头像，则不带参考图继续生成。

### 感知

当图像客户端已连接且 `features.imageGeneration` 不为 false 时，`<senses>` 块包含一行绘画信息：

- `senses.draw` — 角色可以绘画。
- `senses.drawSpent` — 每日配额（`image.maxPerDay`）已用完。
- `senses.drawSpentUser` — 该成员的每日配额（`image.maxPerUserPerDay`）已用完。

没有 `senses.draw` 的旧版 `labels.json` 不会显示任何内容。

### 失败回合

当回复回合中生成失败时（有人请求了图片），自动触发第二个回合：

- `triggerKind: 'drawFailed'`，失败原因通过 `labels.draw.reasons.*` 渲染到 `labels.triggers.drawFailed` 的
  `{reason}` 占位符中。
- 模式为 `reply`，同一触发消息，允许回复。
- 第二个回合自身的 `<draw>` 被移除，因此模型无法重试生成。
- 频道的空闲通知被保留到第二个回合结束，因此挂起的 ping 仅在后续回合完成后才被排空。

自发回合（无人请求）中，失败仅记录日志，不触发后续回合。

图片配额超限（`ImageCapError`，原因 `daily` 或 `userDaily`）不会触发失败回合。代之以限制通知（`labels.limits.notice`）作为普通回复发布。`draw.reasons.daily` 和 `draw.reasons.userDaily` 保留在 `labels.json` 中，但不再通过 `triggers.drawFailed` 到达。

### 限制

- 每回合一个 `<draw>`；首个非空优先，截断至 `image.maxPromptChars`（默认 800）。
- `image.maxPerDay`（默认 50）和 `image.maxPerUserPerDay`（默认 50）在请求前检查和计数；超限抛出 `ImageCapError`（原因 `daily` 或 `userDaily`）。
- 不支持的模型系列（非 `openai/*` 或 `google/*`）以 `UnsupportedImageModelError` 拒绝。
- 生成失败抛出 `ImageGenError`（原因 `moderation`、`timeout`、`error` 或 `empty`）。
- 瞬态 HTTP 错误（408、429、5xx）和网络故障重试最多 `image.retries`（默认 1）次。
- 内容审核拒绝（HTTP 400/403 带审核标记）不重试。
- 日志记录模型、计数、费用和失败原因，不记录提示（因为可能引用成员）。
- 试运行中，完整的图像提示（提示文件 + 角色的请求）被记录并镜像，但不生成任何图片。

## 私聊

`features.privateMessages`（默认关闭）允许所服务公会的成员通过 Discord 私信与角色交谈。角色不变，公共记忆不变；私信中说的话存储在每个成员的私有层中，其他对话不可见。

### 门控

当以下所有条件均满足时（本地零 token 检查），私信才会得到回复：

1. `features.privateMessages` 为 `true`。
2. 发送者是所服务公会的成员。
3. 角色拥有该发送者的公共档案。
4. 公共 `affinity.score >= private.minAffinity`（默认 5）。机器人所有者跳过此检查。
5. 今日回复数未超过上限（所有者使用 `private.maxPerOwnerPerDay`，其余使用 `private.maxPerUserPerDay`）。

达到每日上限时（步骤 5），机器人每人每天发送一次限制通知（`labels.limits.notice`）。

### DM 回合的内容和省略

- `<server>`（频道地图）和 `<other_channels>` 被省略。
- `prompts.private`（如果存在）追加在模式提示（`reply.md`）之后、`forced.md` 之前，填充 `{{name}}` 和 `{{author}}`。
- `{{trigger}}` 取自 `labels.triggers.private`。
- `<senses>` 包含 `senses.privateChat`。
- 服务器回合中，当 `features.privateMessages` 开启时，`<senses>` 改为包含 `senses.privateAware`。
- 对话伙伴的档案为 `mergeProfiles(publicProfile, privateProfile)`。其他档案仅公共。

### 私有层

`data/guilds/<guildId>/private/<userId>.json` 存储角色从私信中了解到的内容。拥有自己的 `relationship`、`interests`、`details`、`episodes` 和 `affinity`（初始分数 0）。私信中角色看到公共和私有数据的合并：兴趣按主题合并（私有笔记优先），细节连接，回忆按日期排序，`relationship` 段落拼接。

### DM 中的好感度

公共分数仅由服务器批次改变。私有层有自己的分数（初始 0），仅由 DM 批次改变。DM 中角色感受到 `clamp(公共 + 私有, -100, 100)`；服务器上仅有公共分数。门控仅使用公共分数。

### 私有模式的分析器

`analyzePrivate` 构建与相同 `memory.md` 格式的请求，加上 `<private>` 块（`labels.memory.privateNote`）。`<existing_profiles>` 仅包含伙伴。回答中仅 `users[<partnerId>]` 通过私有存储方法应用。`portrait`、`aliases`、`guild`、`channels`、`lore`、`self` 被丢弃。

## Mentor

手动子进程（`features.mentor`），使用独立模型（`mentor.model`）。所有者添加案例（角色应有的行为），mentor 构造聊天场景，在沙盒中让角色作答并评分。运行失败或得分较低时，mentor 指出角色上下文中的可能原因，并将修改建议作为参考意见提交给所有者。一次只运行一个。所有工作留在 `data/`；设置了 `bot.dryRunChannelId` 时，完成的运行也会发布到该频道。没有管理频道时，所有者通过 `/nep mentor status` 跟踪运行，通过 `/nep mentor show <id>` 读取报告。

### 隐私

Mentor 模型读取渲染后的沙盒请求，因此可以读取角色记忆中关于真实用户的内容。私信和私有记忆层永远不会出现在沙盒请求中。

### 运行如何结束

运行正常结束时会产生判定和报告。也可能提前结束：

- **停止** (`budget`)：每日 token 预算耗尽。开关和预算在每个场景前和每个 mentor 请求前检查。
- **停止** (`owner`)：所有者执行了 `/nep mentor stop` 或 `/nep pause`。
- **停止** (`disabled`)：运行期间 `features.mentor` 或 `mentor.model` 被关闭。
- **错误** (`the reference is empty`)：参考窗口内无法从参考频道读取任何人的消息。在任何模型请求之前结束运行。

停止的运行保留已有的分数并在报告中包含它们。

### 真实 moment（anchors）

案例可包含来自聊天的真实 moment。每个 moment 是所有者拒绝的角色的一条消息。解析过程：机器人获取该消息，找到触发消息（该消息回复的消息，或其之前最后一条非角色消息），收集该频道直到触发消息的最多 `mentor.anchor.contextMessages`（默认 30）条消息，并将角色的整个连续消息（从指定消息开始的连续消息）存储为原始回答。存储的历史与常规转录的规范化方式相同（媒体标签、反应），但不下载或描述任何内容。解析同时存储角色所见的媒体：对每条消息，描述器在 `media.json` 中缓存的标注（图片、GIF、视频帧、链接缩略图、贴纸、自定义表情）和已观看视频摘要（写入时间不晚于角色消息的条目）成为 `mediaSeen: { captions?: { <itemId>: text }, watched?: { <itemId>: text } }`。不保留的内容：未观看状态（限制或错误）、二次查看回答（`videoAnswered`）、网页查询读取（`linkRead`）和附加图片标记。名称和反应保持获取时的状态。存储后，moment 从其存储的消息重放，即使频道继续或消息被删除。

案例将 moment 存储为 `anchors`：

```json
[{ "id": 1, "channelId": "...", "messageId": "...", "triggerId": "...",
   "addedAt": "...",
   "history": [
     { "...规范化消息字段...",
       "mediaSeen": { "captions": { "<itemId>": "text" }, "watched": { "<itemId>": "text" } } }
   ],
   "original": ["text", "..."] }]
```

在运行中，每个可用的 anchor 成为独立的场景，编号在构造的场景之前。场景记录携带 `anchor: <id>`（构造的场景没有此字段）。重放使用存储的历史，在角色原始消息的时间点，在 anchor 自己的频道中。

重放时，存储的 `mediaSeen` 使用当前转录标签（`imageDescribed`、`gifDescribed`、`videoDescribed`、`videoWatched`、`thumbnailDescribed`、`linkWatched`、`stickerDescribed`、`emojiDescribed`）在角色请求、`<examples>`、评分 `<situation>` 和 `<worst>` 中渲染。对于没有存储描述的项，在重放时以相同的时间限制（角色的回答）只读查询缓存。若缓存中也没有，项使用其原始标签渲染。

当 `mentor.anchor.hideLaterMemory` 不为 `false` 时（默认 `true`），重放的 moment 使用触发消息之前的记忆状态回答。时间在触发消息时间点或之后的条目被隐藏：事件（按 `addedAt`，回退到 `date` 按 UTC 天）、态度历史记录和态度原因（分数保持当前值）、详情（按 `firstSeen`）、兴趣（按 `firstSeen`）、别名（按 `firstSeen`）、学到的内容（按 `firstSeen`）和知识库条目（按 `createdAt`）。没有可解析日期的条目不被过滤。无日期字段（档案文本字段、服务器模式、开场白、梗、自我事实、频道条目）保持可见并使用当前值。评分中真实 moment 的 `<learned>` 块也以相同方式过滤。设为 `false` 则使用当前全部记忆重放。

在场景请求中，案例的 anchor 以 `<examples>`（最后一个块）的形式展示给 mentor 模型。每个 `<example>` 包含存储转录的 `<situation>` 和角色消息的 `<original>`。每个示例的最旧消息可能被裁剪以适应请求预算；触发消息不会被删除。Mentor 构造同类场景：匹配消息长度、回合数和压力程度。

在真实 moment 的评分请求中，`<original>` 出现在 `<situation>` 和 `<answers>` 之间，携带角色被拒绝的回答作为已知的差参考。

验证器对构造场景单行的上限为 2000 字符（原先为 500），使 mentor 能够匹配示例中的消息长度。

### 提示

Mentor 使用六个提示文件：每个目标一对，加上特征文件和诊断文件：

- **Reply 目标**：`mentor-situations.md`（构造场景）和 `mentor-score.md`（评分回答）。
- **Memory 目标**：`mentor-situations-memory.md`（构造场景）和 `mentor-score-memory.md`（评分存储文本）。
- **诊断**：`mentor-diagnose.md`（评分后解释弱回答）。

每个提示文件是一次 mentor 请求的系统消息。块在用户消息中传递。

代码填充的占位符：所有六个文件中的 `{{name}}`；两个场景提示中的 `{{count}}`、`{{minLines}}`、`{{maxLines}}`。

### 块

| 块 | 内容 | 在哪个请求中 |
|---|---|---|
| `<case>` | 所有者的案例文本，逐字 | 全部 |
| `<members>` | 每行一个存储的档案：`name (id:123)` | 场景 |
| `<reference>` | 风格档案 JSON：标点频率、长度、回复频率、未使用的字符 | 场景、评分 |
| `<samples>` | 聊天中的随机行，每行一条 | 场景、评分 |
| `<signs>` | 填充了 `{{name}}` 的 `mentor-signs.md`：已知的模型文本习惯。文件缺失或为空时省略 | 全部 |
| `<intended>` | `labels.mentor.intended`，每项一行 | 评分 |
| `<feedback>` | 所有者修正的 JSON 数组：`[{ "case": "...", "reason": "..." }]`，从新到旧；空时省略 | 全部 |
| `<examples>` | 聊天中的真实 moment：`labels.mentor.examples` 为首行，然后每个 moment 一个 `<example>`。每个 `<example>` 包含 `<situation>`（存储的转录，最旧消息可裁剪以适应请求预算）和 `<original>`（角色的消息）。案例无 moment 时省略 | 场景 |
| `<original>` | 角色当时的回答（在真实 moment 的评分请求中）。`labels.mentor.original` 为首行，然后是角色的消息。已知的差参考，不是待评分的回答。构造的场景省略此块 | 评分（reply，仅真实 moment） |
| `<character>` | 填充了 `{{name}}` 的角色卡 | 评分（仅 reply） |
| `<rules>` | 规则提示 | 评分 |
| `<learned>` | 角色看到的指令式已学内容。对于启用了 `mentor.anchor.hideLaterMemory` 的真实 moment，在触发消息时间点或之后写入的内容被隐藏 | 评分 |
| `<situation>` | 渲染为聊天记录的场景，角色所见。真实 moment 的最旧消息可能被裁剪以适应请求预算；触发消息不会被删除 | 评分 |
| `<answers>` | JSON 数组：`[{ "id": "s1a1", "messages": ["..."], "reactions": ["..."], "silent": false }]` | 评分（reply） |
| `<stored>` | JSON 数组：`[{ "id": "s1a1", "texts": [{ "path": "...", "text": "..." }], "parseOk": true }]`。当 `parseOk` 为 false 时分析器返回了无效 JSON，不会存储任何内容 | 评分（memory） |
| `<facts>` | 按回答 id 索引的 JSON 对象，包含确定性测量结果（未使用标记、稀有标记、逗号计数、逗号密度、长度），以及在两个或更多不同场景中出现的短语 `"repeated"`。每个回答：`commas` 为计数；`commaPer1000` 仅在测量文本至少 150 字符时为数字，更短时为 `null`（太短无法测量；mentor 根据计数评判，不推断密度）。`repeated` 列出在不同场景中重复出现的短语，`count` 为场景数 | 评分 |
| `<verdict>` | JSON：`{ passed, medians, situations, reasons }`，包含通过/失败结果、各轴中位数、各场景中位数和诊断原因。原因包括构造场景的 `situation <n>: <axis> <v> is under the floor <f>` 和真实 moment 的 `real moment <n>: <axis> <v> is under the pass score <s>` 或 `real moment <n>: <axis> <v> is under the anchor score <s>` | 诊断 |
| `<worst>` | JSON：`overall` 中位数最低的任意类型场景（平局时取较小的 `goal` 中位数，然后真实 moment 优先于构造场景，再取较小的 `n`）：`{ n, title, transcript, answers }`，每个回答包含 id、messages/reactions/silent（memory 目标为 `texts`/`parseOk`）、`facts` 和 `score`。转录可能被裁剪以适应请求预算 | 诊断 |
| `<seen>` | 角色（或 memory 案例中的分析器）在该场景中收到的完整请求，分两个子块：`<system>`（系统提示含角色卡、规则和格式）和 `<user>`（聊天记录、记忆块和任务） | 诊断 |

### 回答 ID

`s<场景>a<样本>`，均从 1 开始。示例：`s2a3` 是第二个场景的第三个样本。

### 场景 schema

```json
{
  "situations": [
    {
      "title": "简短标签",
      "lines": [
        {
          "authorId": "123456789 or self",
          "authorName": "显示名称",
          "text": "消息内容",
          "replyTo": null,
          "minutesBefore": 5
        }
      ]
    }
  ]
}
```

`authorId` 是 `<members>` 中的成员 id 或 `self`（角色自己的行）。`replyTo` 是该场景 `lines` 数组中的 0 索引，或 `null`。两种目标的最后一行都不能是 `self`。Reply 场景的最后一行必须对角色说话。Memory 场景不要求对角色说话；角色自己的行可以出现在最后一行之前的任何位置。

来自真实 moment 的场景记录携带 `anchor: <id>` 而非 `lines`。其转录从存储的历史构建；记录还包含 `original`（角色的消息）和 `at`（角色回答的时间）。

### 评分 schema

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
      "comment": "一两句话。"
    }
  ]
}
```

每个分数为 0–10 的整数或 `null`。`overall` 和 `goal` 始终为数字。Memory 评分中 `character` 始终为 `null`。

### 轴

均为 0–10 整数，10 为理想，`null` 表示无法评判（绝不用 5 代替"未知"）。

| 轴 | 测量内容 | 0 | 5 | 10 |
|---|---|---|---|---|
| `human` | 多大程度上不像 AI 写的 | 与聊天中真人的写法相差甚远 | 可能是人也可能是 AI | 与参考中的真人写法一致 |
| `character` | 与角色卡的匹配度 | 完全不符 | 可识别但有偏差 | 完全符合卡的声音 |
| `rules` | 遵守规则和已学内容 | 违反所有适用规则 | 部分遵守部分违反 | 遵守每条适用规则 |
| `goal` | 是否做到 `<case>` 要求的 | 做了相反的事 | 部分达成部分遗漏 | 完全按描述处理 |
| `overall` | Mentor 的综合判断 | 全面失败 | 尚可但有明显弱点 | 全面优秀 |

Memory 评分中 `character` 始终为 `null`，`human` 衡量文本是否读起来像某人关于熟悉的人的个人笔记（10），还是与这种人为自己写笔记的方式相差甚远（0）。

### 通过规则

案例通过条件：`overall` 中位数 >= `mentor.pass.score`（默认 7）且 `goal` 中位数 >= `mentor.pass.score` 且没有任何轴的中位数低于 `mentor.pass.floor`（默认 5）。构造场景受下限约束：当任一构造场景的 `overall` 中位数或 `goal` 中位数低于 `mentor.pass.floor` 时案例失败，无论所有回答的中位数如何。真实 moment 以通过分为阈值：当其 `overall` 或 `goal` 中位数低于 `mentor.pass.anchorScore`（设为数字时）或低于 `mentor.pass.score`（`anchorScore` 为 `null` 时）案例失败。原因字符串：`anchorScore` 未设置时为 `real moment <n>: <axis> <v> is under the pass score <s>`，设置时为 `real moment <n>: <axis> <v> is under the anchor score <s>`。报告显示每个场景的 `overall` 和 `goal` 中位数。所有分数均为 `null` 的轴中位数为 `null`，不参与检查。

### 评分证据顺序

1. `<feedback>` 中所有者的修正，优先于 mentor 的品味。
2. 测量的参考（`<reference>`、`<samples>`）和确定性事实（`<facts>`）。
3. 已知的模型文本特征（`<signs>`）。特征绝不凌驾于测量结果或参考。
4. Mentor 自身的品味，提出建议但绝不凌驾于前三者。

### 来源

`mentor-signs.md` 中的已知特征列表参考了维基百科的 "Signs of AI writing" 和 humanizer skill (MIT)。

### 诊断

评分后，当运行未提前结束且案例失败或任一场景的 `overall` 中位数低于 `mentor.pass.score` 时，mentor 再发起一次请求，解释角色上下文中导致弱回答的原因。开关 `mentor.diagnose`（默认 `true`）。通过 `/nep mentor check` 启动的运行不请求诊断。此步骤的失败不会导致运行失败：运行以 `diagnosis: null` 保存并记录错误。

结果存储在运行中的 `diagnosis` 字段，并在报告中输出。这些是供所有者审阅的假设，mentor 本身不进行任何修改。

原因可以指向的层：`rules`（规则块中的一条规则）、`prompt`（引擎系统提示、格式或任务）、`card`（角色卡）、`self`（角色关于自己的笔记）、`learned`（他人教会角色的内容）、`guild`（服务器习惯或梗）、`profile`（角色对某人的记忆）、`missing`（应当存在但缺失的指令）。

#### 诊断 schema

```json
{
  "summary": "一个段落",
  "causes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile|missing",
      "excerpt": "逐字引自 <seen>，至多 300 字符；missing 时为空",
      "why": "一两句话"
    }
  ],
  "changes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile",
      "target": "哪个文件、规则或项目",
      "from": "逐字引用要替换的文本；添加时为空",
      "to": "新文本",
      "why": "一句话"
    }
  ]
}
```

最多 5 个原因和 5 个修改。`summary` 截断至 1500 字符；`excerpt` 至 300；`from`/`to` 至 1000；`target` 至 200；`why` 至 500。`layer` 未知或缺少 `why` 的项被丢弃。`summary` 和 `why` 使用聊天语言；`to` 使用目标层的语言。

## 限制通知

当限制（rail）拒绝了被触发的操作（提及、回复、名字触发、follow-up 或私信）时，机器人发布 `labels.limits.notice` 的一行，填充 `{limit}`（配置键）、`{used}` 和 `{cap}`。自发回合保持沉默。试运行中通知被记录并镜像。

`{limit}` 中可能出现的配置键：`llm.maxRequestsPerDay`、`llm.maxRequestTokens`、`image.maxPerDay`、`image.maxPerUserPerDay`、`private.maxPerUserPerDay`、`private.maxPerOwnerPerDay`。
