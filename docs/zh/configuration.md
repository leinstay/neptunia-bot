# 配置

`config.json` 中所有键及其默认值，按节分组。

## `features`

| 键 | 默认值 | 说明 |
|---|---|---|
| `dryRun` | `false` | 完整流程运行但不发送。见[试运行](README.md#试运行) |
| `mentions` | `true` | 响应 @提及 |
| `replies` | `true` | 响应回复 |
| `nameTriggers` | `true` | 响应消息中的名字提及 |
| `spontaneous` | `true` | 随机定时器触发的主动消息 |
| `eavesdrop` | `true` | 随机概率对任意消息插话 |
| `memory` | `true` | 构建档案、追踪服务器规律、记录自述 |
| `relationships` | `true` | 每成员态度分数（-100..100） |
| `episodes` | `true` | 每人的长期回忆（时刻、引言、恩怨） |
| `lore` | `true` | 服务器级世界书 |
| `reactions` | `true` | 表情反应（角色放置反应） |
| `seeReactions` | `true` | 在对话记录中显示消息上的反应。缺失的键视为开启。与 `reactions`（控制角色是否放置反应）不同，此项控制角色是否看到反应 |
| `multiMessage` | `true` | 允许连续发 2–3 条消息 |
| `vision` | `true` | 处理附加图片 |
| `mediaDescriptions` | `true` | 为图片、GIF、视频帧和链接缩略图生成单行描述 |
| `videoDescriptions` | `false` | 通过支持视频的模型观看短视频片段；需同时开启 `mediaDescriptions`。在 `config.local.json` 中开启；还需要支持视频的模型，以及站点链接需要 `yt-dlp`/`ffmpeg` |
| `videoRewatch` | `true` | 被呼叫时重看视频以回答相关问题；需要 `videoDescriptions` |
| `webLookup` | `false` | 阅读聊天中发布的链接并在被问到事实性问题时搜索网络。与其他功能不同，缺失的键视为关闭。搜索需要 `.env` 中的 `BRAVE_SEARCH_API_KEY`；没有密钥时只有链接阅读可用。参见[媒体：链接与搜索](media.md#链接) |
| `imageGeneration` | `false` | 允许角色通过绘画子进程绘制图片。缺失的键视为开启。在 `config.local.json` 中启用；需要 `image.model` 中配置支持图像生成的模型。参见[媒体：绘画](media.md#绘画) |
| `privateMessages` | `false` | 回复公会成员的私信。需要已存储的公共档案且 `affinity.score >= private.minAffinity`。参见[消息与记忆：私有层](messages-and-memory.md#私有层) |
| `mentor` | `false` | 手动测试子进程，使用独立模型。必须严格为 `true` 才能启用；缺失的键视为关闭。参见 [Mentor](#mentor) |
| `variety` | `true` | 每轮之前，模型过程识别角色在近期消息中过度使用的表达手法。缺失的键视为开启 |
| `followUp` | `true` | 角色回复后对未标记消息进行分类以延续对话 |
| `typingSimulation` | `true` | 模拟输入速度 |
| `adminCommands` | `true` | 所有者斜杠命令；设为 `false` 时注销命令 |

## `bot`

| 键 | 默认值 | 说明 |
|---|---|---|
| `timezone` | `"UTC"` | 模型时间戳的时区 |
| `owners` | `[]` | 所有者命令的用户 ID |
| `commandName` | `"nep"` | 斜杠命令名称（小写 `a-z 0-9 _ -`，最多 32 字符；更改后重新注册） |
| `nameTriggers` | `[]` | 除 @提及外的额外触发字符串 |
| `guildId` | `""` | 锁定的服务器；若只在一个服务器中则自动检测 |
| `dryRunChannelId` | `""` | 试运行镜像频道。见[试运行](README.md#试运行) |
| `channels.allow` | `[]` | 允许的频道（空 = 所有可见频道） |
| `channels.deny` | `[]` | 忽略的频道 |
| `access` | `{}` | 除所有者外谁可运行哪些命令（由 `/nep access` 管理） |

## `llm`

| 键 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | 聊天补全端点 |
| `model` | `"anthropic/claude-opus-4.6"` | 模型 ID |
| `temperature` | `1` | 采样温度 |
| `maxOutputTokens` | `700` | 最大输出 token 数 |
| `maxRequestTokens` | `50000` | 每请求硬性 token 上限 |
| `safetyMargin` | `0.9` | `maxRequestTokens` 的预算比例 |
| `timeoutMs` | `300000` | 请求超时（毫秒） |
| `pingTimeoutMs` | `30000` | `/nep ping` 请求超时（毫秒） |
| `retries` | `2` | 临时故障重试次数 |
| `maxRequestsPerDay` | `300` | 每日请求上限 |
| `provider` | `null` | OpenRouter `provider` 路由对象，原样传递；`null` 表示不发送该字段 |
| `providerByModel` | `{}` | 按模型路由 provider；详见下文 |

`llm.provider` 为聊天请求设置默认的 OpenRouter provider 路由字段，例如 `{ "ignore": ["some-provider"] }` 或 `{ "order": ["anthropic"], "allow_fallbacks": true }`。`llm.providerByModel` 按模型添加覆盖：每个键是模型 id 前缀（匹配任意角色）或 `<prefix>@<role>`（仅匹配一个角色），值为原样传递的 OpenRouter 路由对象。

单个请求的 provider 按以下顺序解析：每次调用的固定路由（视频描述器的直接 URL 路径使用 `media.video.provider`），然后是 `providerByModel` 中与该请求角色匹配的最长前缀，然后是无角色键中匹配的最长前缀，然后是 `llm.provider`（图像请求使用 `image.provider`），最后是无路由（由 OpenRouter 选择）。角色专用键始终优先于同一模型的无角色键。角色名称：`talk`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`、`image`。

示例：`"google/": { "only": ["google-vertex"], "allow_fallbacks": false }` 将所有 Google 模型路由到 Vertex，而 `"google/@classifier.video": { "only": ["google-ai-studio"], "allow_fallbacks": false }` 将视频分类器发送到 AI Studio。包含点号的路由键（如 `google/@classifier.video`）无法通过 `/nep set` 编辑，因为它会按点号拆分路径；请使用 `/nep route set` 和 `/nep route remove`。

如果 OpenRouter 账户本身限制了允许的 provider，忽略仅剩的那个会导致每个请求失败并报错 "No endpoints found"。更改 provider 设置后，运行 `/nep ping` 验证每个模型角色是否可达；每个角色遵循其 `llm.providerByModel` 路由，因此显示的 provider 就是该路由选定的。

## `classifier`

三个辅助模型角色，统一归入一个键下。每个独立设置，因此辅助工具可以使用低成本模型，而语音使用高端模型。

| 键 | 默认值 | 说明 |
|---|---|---|
| `text` | `"anthropic/claude-sonnet-4.6"` | 文本分类器：地址分类器（`features.followUp`）、重看分类器（`features.videoRewatch`）和搜索分类器（`features.webLookup`）。同时负责浓缩链接阅读和搜索结果 |
| `media` | `"anthropic/claude-haiku-4.5"` | 图片描述器（`features.mediaDescriptions`）：为图片、GIF 帧、视频封面、贴纸、自定义表情和链接缩略图生成单行描述 |
| `video` | `"google/gemini-3.8-flash"` | 视频描述器（`features.videoDescriptions`）：观看短片段，基于问题重看，按请求重试。必须同时接受视频和音频输入 |

**从旧键迁移。**已废弃的键 `llm.classifierModel`、`mention.followUpModel`、`media.model` 和 `media.video.model` 不再读取。如果 `config.local.json` 中存在这些键，机器人会在启动时记录一条警告（`index: deprecated model key ignored`），指出该键及其替代键。请将值分别移至 `classifier.text`、`classifier.media` 或 `classifier.video`。

## `context`

| 键 | 默认值 | 说明 |
|---|---|---|
| `channelMessages` | `100` | 当前频道消息数 |
| `neighborMessages` | `5` | 每个相邻频道的消息数 |
| `neighborMaxAgeMinutes` | `60` | 相邻频道消息最大时效（分钟） |
| `neighborMaxChannels` | `8` | 最大相邻频道数 |
| `neighborMessageChars` | `300` | 每条相邻频道消息保留的字符数（`<other_channels>`） |
| `maxMessageChars` | `800` | 超出此长度的消息会被截断（字符） |
| `gapMarkerMinutes` | `20` | 时间间隔标记阈值（分钟） |
| `reactionsPerMessage` | `6` | 对话记录中每条消息列出的最大反应数，按频率降序 |
| `otherProfiles` | `6` | 显示的其他档案最大数量 |
| `askedAboutProfiles` | `3` | 在近期消息中被提及的成员以完整档案显示，排在其他参与者之前 |
| `tempo.liveMessages10min` | `4` | 10 分钟内的消息数 = “活跃” |
| `tempo.deadSilenceMinutes` | `45` | 沉默分钟数 = “沉寂” |
| `caps.interlocutor` | `6000` | Token 上限：呼叫者的档案与回忆 |
| `caps.aboutChat` | `2500` | Token 上限：服务器习惯/自述事实 |
| `caps.lore` | `1500` | Token 上限：世界书条目 |
| `caps.people` | `9000` | Token 上限：其他档案 |
| `caps.neighbors` | `3000` | Token 上限：相邻频道 |
| `caps.server` | `4000` | Token 上限：频道地图 |
| `channelActivity.liveMessagesPerDay` | `20` | 每日消息数 = “活跃”频道 |
| `channelActivity.deadAfterDays` | `7` | 无消息天数 = “沉寂”频道 |
| `vision.maxImages` | `4` | 每请求最大图片数 |
| `vision.tokensPerImage` | `400` | 每张图片的 token 预算 |
| `vision.imageSize` | `512` | 通过 Discord 媒体代理缩放的目标像素 |
| `vision.recentImages` | `3` | 包含的近期频道图片数 |
| `vision.recentImageMinutes` | `30` | 近期图片最大时效（分钟） |
| `vision.maxBytes` | `1500000` | 图片文件大小上限（字节）；更大的图片会被跳过 |
| `vision.fetchTimeoutMs` | `10000` | 每张图片下载超时（毫秒） |

## `gifs`

GIF 库（`features.gifs`）的设置。使用次数在每条消息到达时统计（仅成员，排除机器人和角色）。

| 键 | 默认值 | 说明 |
|---|---|---|
| `recachePerRun` | `50` | 每次 `/nep gifs recache` 运行时重新描述的库 GIF 数量。库外的单帧说明立即删除；然后在后台从最旧的开始观看最多此数量的库条目 |

## `media`

媒体描述器（`features.mediaDescriptions`）的设置。描述器模型为 `classifier.media`。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxOutputTokens` | `120` | 每次描述的最大输出 token 数 |
| `imageSize` | `512` | 缩放目标像素 |
| `maxPerTurn` | `6` | 每回合生成的最大描述数 |
| `cacheEntries` | `5000` | 描述缓存大小，以附件为键 |
| `filePreviewChars` | `500` | 文本文件开头显示的字符数 |
| `embedTextChars` | `200` | 链接嵌入文本显示的字符数 |

### `media.gif`

将 GIF 作为短视频片段观看（`media.gif.watch`）的设置。启用后，GIF 的动画被转换为短 mp4 并发送给 `classifier.video` 模型，而非描述单帧。观看后的说明替代单帧描述。无法观看的 GIF（无动画来源、日限额耗尽、转换失败）回退到单帧描述。

| 键 | 默认值 | 说明 |
|---|---|---|
| `watch` | `true` | 将 GIF 作为短视频片段观看而非描述单帧。需同时开启 `features.mediaDescriptions` 和 `features.videoDescriptions`。缺失的键视为开启 |
| `maxSeconds` | `8` | 发送给视频模型的动画秒数；片段通过 ffmpeg 转换 |
| `maxPerDay` | `200` | 每日 GIF 观看上限，独立于 `media.video.maxPerDay`。耗尽后 GIF 获得单帧描述 |

### `media.video`

视频描述器（`features.videoDescriptions`）的设置。视频视觉需要同时开启 `features.mediaDescriptions` 和 `features.videoDescriptions`。视频模型为 `classifier.video`。一个独立的支持视频的模型观看短视频片段：Discord 视频附件和 `media.video.sites` 中站点的链接。结果与图片描述一起缓存在媒体缓存中；重复发布不产生额外开销。

| 键 | 默认值 | 说明 |
|---|---|---|
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | 直接 URL 路径（在长度限制内的 YouTube）的 OpenRouter provider 路由。覆盖 `llm.providerByModel` 和 `llm.provider`；`null` 按正常解析顺序处理 |
| `maxOutputTokens` | `800` | 每个视频摘要的最大输出 token 数 |
| `summaryChars` | `1500` | 视频描述的最大字符数；填充 `describe-video.md` 中的 `{{maxChars}}` |
| `maxRequestTokens` | `60000` | 每次视频请求的 token 上限（输入 + 输出），替代 `llm.maxRequestTokens`。agentic 模式下公开 URL 视频使用 `directUrlTokensPerSecond`（10）估算: 一小时 YouTube 为 36 000 token。下载的片段使用 `tokensPerSecond`（120）估算: 三分钟为 21 600 token |
| `maxSeconds` | `180` | 附件和下载的站点视频的最大片段时长（秒）；更长的附件由 `ffmpeg` 裁剪，更长的站点视频由 `yt-dlp` 截取前 `maxSeconds`。直接 URL 站点使用 `directUrlMaxSeconds` |
| `directUrlMaxSeconds` | `3600` | 公开 URL 视频（YouTube 及其他 `directUrlSites`）的最大时长（秒），当 `urlProcessing` 为 `agentic` 时生效。其他模式下有效上限为此值与 `maxRequestTokens / tokensPerSecond` 中较小者。超长视频走下载路径（通过 yt-dlp 取前 `maxSeconds`），但 YouTube 在服务器上经常以 bot 验证阻止下载 |
| `maxBytes` | `12000000` | 附件和下载的站点片段的最大文件大小（字节）；下载本身最大可达此值的 4 倍。超限的文件先由 `ffmpeg` 重编码为 360p；仅重编码后仍超限的片段才被拒绝为永久未命中 |
| `maxPerTurn` | `1` | 每回合最大新视频数；每次获取尝试都计数，无论成功与否 |
| `maxPerDay` | `40` | 每日视频请求上限（在 `state.json` 中存储为 `videoDay`/`videoCount`） |
| `tokensPerSecond` | `120` | 视频每秒的 token 估算，用于预算检查。适用于下载的片段和非 agentic 模式的公开 URL 视频；agentic 模式下使用 `directUrlTokensPerSecond` 替代 |
| `directUrlTokensPerSecond` | `10` | agentic 模式下公开 URL 视频预检 token 预算的每秒估算值（模型按需加载，视频本身不计为提示 token）。缺失或无效时回退到 `tokensPerSecond`。`tokensPerSecond`（120）仍适用于下载的片段和非 agentic 模式的 URL |
| `timeoutMs` | `90000` | 视频的 LLM 请求超时（毫秒） |
| `toolTimeoutMs` | `60000` | `yt-dlp` 和 `ffmpeg` 子进程的超时（毫秒） |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | 其链接被视为视频的主机名 |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | 可将公开 URL 直接传递给提供商（由提供商自行获取视频）的站点 |
| `directUrlUnknownDuration` | `false` | 即使所有探测均未获取到时长，仍将 directUrlSites 站点的链接发送给提供商；token 估算使用 `maxSeconds`。参见下方的时长探测链 |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | 启动时和 `/nep ping classifier.video` 探测的固定 YouTube 视频，用于测试 YouTube API key 和时长来源 |
| `ytdlpPath` | `"yt-dlp"` | `yt-dlp` 二进制文件的路径；站点视频链接和探测时长需要此工具 |
| `ffmpegPath` | `"ffmpeg"` | `ffmpeg` 的路径；裁剪和缩小过长或过大的附件需要此工具 |
| `errorRetryMinutes` | `60` | 错误缓存视频自动重试前的等待分钟数；重看分类器的强制重试忽略此值 |
| `urlProcessing` | `"agentic"` | 公开 URL 视频部分发送的 OpenRouter 处理模式；缺少时某些提供商只能看到单帧。`null` 省略该字段 |
| `reasoning` | `{ "effort": "low" }` | 每个视频请求的 OpenRouter `reasoning` 设置；防止推理占用输出预算。非对象值省略该字段 |
| `prefill` | `true` | 视频到达时立即观看，以便下次回合时已有缓存 |

`yt-dlp` 和 `ffmpeg` 均为可选的系统二进制文件。没有它们时，在限制内的附件仍然可用（直接发送）。更长的附件和所有站点链接会回退到静帧或预览图，角色会被告知原因。每个视频请求都计入 `llm.maxRequestsPerDay` 和视频 token 上限（`maxRequestTokens`）。

YouTube 链接的时长通过以下链式探测获取：首先尝试 yt-dlp，然后尝试 YouTube Data API（需在 `.env` 中设置 `YOUTUBE_API_KEY`），最后尝试抓取观看页面。如果所有探测均失败且 `directUrlUnknownDuration` 处于关闭状态（默认），链接将报告为"无法加载"。开启该开关后，URL 仍会发送给提供商，token 估算按 `maxSeconds` 计费。Data API 密钥免费获取：在 Google Cloud 控制台中启用 YouTube Data API v3 并创建密钥；免费配额为每天 10,000 个单位，一次时长查询消耗 1 个单位。`/nep ping classifier.video` 探测 `canaryUrl` 并报告 API key 状态（如 `youtube: API key — ok`）。缓存的长度限制结果会记录视频时长，当上限提高后会重新尝试。

### `media.video.rewatch`

重看分类器（`features.videoRewatch`）的设置。当角色被呼叫且近期对话记录中有已观看的视频时，一个低成本分类器判断消息是否在询问其中某个视频；如果是，视频模型再次观看片段，回答追加到对话记录中。分类器使用 `classifier.text`。重看始终使用 `classifier.video`。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxPerDay` | `20` | 每日重看上限（独立于 `media.video.maxPerDay`） |
| `maxOutputTokens` | `600` | 重看回答的最大输出 token 数 |
| `answerChars` | `1200` | 回答的最大字符数；填充 `rewatch-answer.md` 中的 `{{maxChars}}` |
| `recentMessages` | `60` | 扫描已观看或错误状态视频的近期消息数 |
| `maxCandidates` | `6` | 从近期窗口中提供给分类器的最大视频数，按最新排序 |
| `contextMessages` | `50` | 作为 `<transcript>` 块渲染给分类器的近期频道消息数（不含触发消息）；`0` 省略该块 |

每回合最多一次重看或重试。回答按问题缓存一小时。分类器和重看各自计入 `llm.maxRequestsPerDay`；重看还计入 `media.video.maxPerDay`。

## `mention`

| 键 | 默认值 | 说明 |
|---|---|---|
| `ignoreChance` | `0` | 基础忽略概率；调高可使角色跳过部分提及 |
| `emptyMentionIgnoreChance` | `0` | 空 @提及的忽略概率；调高可使角色跳过部分空提及 |
| `repeatWindowMinutes` | `10` | 重复追踪窗口（分钟） |
| `repeatPenalty` | `0` | 每次重复增加的忽略概率；调高可惩罚重复 |
| `spamThreshold` | `50` | 窗口内的呼叫次数达到此值视为垃圾消息 |
| `spamIgnoreChance` | `0.9` | 被刷屏时的忽略概率 |
| `nameTriggerChance` | `1` | 名字触发的响应概率 |
| `neverIgnore` | `[]` | 永不忽略的用户 ID |
| `affinityIgnoreBonus` | `0` | 态度 -100 时增加的最大忽略概率；调高可使不喜欢的成员更易被忽略 |
| `affinityLikeBonus` | `0.08` | 态度 +100 时减少的最大忽略概率 |
| `oneAtATime` | `true` | 全服务器同一时间只处理一条回复 |
| `pendingSameChannel` | `true` | 当同一频道中正在执行回合时挂起该频道的直接提及；回合结束后以通常的忽略概率回复。缺失键 = 开启 |
| `maxPending` | `3` | 繁忙时可挂起直接提及的频道数 |
| `pendingMinutes` | `10` | 挂起的提及过期时间（分钟） |
| `switchDelayMs` | `[2000, 9000]` | 在下一个频道回复前的暂停时间（毫秒） |
| `followUpMinutes` | `15` | 角色最后一条回复后的后续窗口（分钟） |
| `followUpClassifyReplies` | `true` | 将对另一成员消息的回复发送给分类器而非自动 `no`。缺失键 = 开启。关闭时，任何回复在询问模型之前即为 `no` |
| `followUpContext` | `15` | 发送给分类器的对话记录行数 |
| `followUpMaxOutputTokens` | `8` | 分类器的最大输出 token 数 |
| `followUpNoStreak` | `3` | 连续 `no` 判定次数达到此值关闭窗口 |

后续窗口保存在 `data/state.json` 的 `followUpWindows` 中，启动时恢复；过期的窗口会被丢弃。

## `typing`

| 键 | 默认值 | 说明 |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | 反应延迟范围（毫秒） |
| `msPerChar` | `[35, 75]` | 每字符输入速度（毫秒） |
| `minMs` | `900` | 最短输入持续时间（毫秒） |
| `maxMs` | `12000` | 最长输入持续时间（毫秒） |
| `betweenMessagesMs` | `[700, 3500]` | 消息之间的暂停（毫秒） |

## `spontaneous`

| 键 | 默认值 | 说明 |
|---|---|---|
| `channels` | `[]` | 允许的频道 |
| `maxChannelSilenceHours` | `72` | 阻止主动消息的频道沉默时长（小时）；0 = 无限制 |
| `minIntervalMinutes` | `25` | 最短检查间隔（分钟） |
| `maxIntervalMinutes` | `420` | 最长检查间隔（分钟） |
| `burstChance` | `0.15` | 连发追加消息的概率 |
| `burstMinutes` | `[3, 15]` | 连发时间范围（分钟） |
| `activeHours` | `{ from: 10, to: 3 }` | 活跃时段（跨午夜） |
| `liveWindowMinutes` | `15` | 活跃窗口（分钟） |
| `liveMinMessages` | `4` | “活跃”所需最少消息数 |
| `deadAfterMinutes` | `90` | 沉默达此时长视为“沉寂”（分钟） |
| `initiateChance` | `0.35` | 发起话题（而非插话）的概率 |
| `eavesdropChance` | `0.02` | 逐消息插入概率 |
| `eavesdropDelayMs` | `[5000, 40000]` | 窃听延迟范围（毫秒） |
| `minGapMinutes` | `12` | 动作之间的最短间隔（分钟） |

## `memory`

| 键 | 默认值 | 说明 |
|---|---|---|
| `model` | `null` | 分析器模型（`null` = `llm.model`） |
| `mainChannelIds` | `[]` | 人们相互交流的频道；成员性格和风格的画像取自这些频道；为空表示所有频道均计入 |
| `portraitRefreshHours` | `24` | 每成员画像刷新最短间隔（小时） |
| `portraitRefreshPerDay` | `20` | 每服务器每天最大画像刷新次数。日计数器存储在 `state.json` 中（`portraitDay` / `portraitCount`），`/nep warmup reset` 不会清除它 |
| `batchMessages` | `60` | 理想批次大小 |
| `minBatchMessages` | `15` | 更新前的最少消息数 |
| `maxBatchAgeMinutes` | `180` | 超过此时长强制更新（分钟） |
| `maxOutputTokens` | `20000` | 分析器最大输出 token 数 |
| `fieldChars` | `1000` | 档案字段限制（字符） |
| `clampTolerance` | `1.25` | 分析器输出的文本超出限制的允许倍数，超出后在句或词边界截断，不会在成员引用内部截断 |
| `maxDetails` | `15` | 每档案向角色和分析器展示的细节条目数 |
| `maxDetailsStored` | `40` | 每档案保存的细节条目数；按频率和近期程度排名最高的会被展示 |
| `maxInterests` | `12` | 每档案向角色和分析器展示的兴趣条目数 |
| `maxInterestsStored` | `40` | 每档案保存的兴趣条目数；按频率和近期程度排名最高的会被展示 |
| `interestTopicChars` | `40` | 兴趣主题最大字符数 |
| `interestNoteChars` | `120` | 兴趣备注最大字符数 |
| `confirmAfter` | `2` | 兴趣或细节被确认所需的观察次数 |
| `confirmGapHours` | `12` | 计为新一次观察所需的间隔小时数 |
| `interestStaleDays` | `90` | 未被观察到多少天后兴趣标记为过时 |
| `interestHalfLifeDays` | `180` | 兴趣的权重半衰期（天）；未被观察的条目权重每个周期减半，新爱好可以超过旧的 |
| `detailHalfLifeDays` | `720` | 细节的权重半衰期（天） |
| `maxLearned` | `20` | 向分析器和聊天模型展示的所学条目数 |
| `maxLearnedStored` | `60` | 磁盘上保存的所学条目数；按频率和近期程度排名最高的会被展示 |
| `learnedChars` | `160` | 每条所学内容的最大字符数 |
| `learnedHalfLifeDays` | `720` | 所学条目的权重半衰期（天） |
| `maxAliases` | `5` | 每档案向角色和分析器展示的别名数 |
| `maxAliasesStored` | `15` | 每档案保存的别名数；按频率和近期程度排名最高的会被展示 |
| `aliasHalfLifeDays` | `365` | 别名的权重半衰期（天） |
| `maxInjokes` | `15` | 服务器内部梗最大数量 |
| `maxSelfFacts` | `20` | 自述事实最大数量 |
| `maxEpisodes` | `20` | 每人保存的最大回忆数 |
| `maxNewEpisodes` | `3` | 每人每批次的最大新回忆数 |
| `timeoutMs` | `900000` | 分析器超时（毫秒），独立于 `llm.timeoutMs` |

分析器提示通过占位符读取这些限制，因此调高某个值会在下一批次生效。更大的档案会消耗更多上下文 token（`context.caps.people`、`context.caps.interlocutor`）和分析器输出（`memory.maxOutputTokens`）。

## `relationships`

| 键 | 默认值 | 说明 |
|---|---|---|
| `damping` | `true` | 阻尼推离零点的分数变化；趋向零的变化全额应用 |
| `dampingPower` | `1` | 阻尼因子的指数；值越高两端越难达到 |
| `maxDeltaPerUpdate` | `15` | 每次更新的最大分数变化 |
| `historySize` | `10` | 每成员保留的态度变化记录数 |
| `directTriggerCount` | `6` | 强制提前更新的直接互动次数 |
| `decayPerDay` | `0.04` | 每日向零漂移；每天损失 `decayPerDay * |score| * (|score| / 100) ^ decayPower`。`0` 或缺失 = 关 |
| `decayPower` | `1` | 衰减曲线的指数；值越高，接近零的分数衰减越慢。非正数 = 1 |
| `rewriteOnBandChange` | `true` | 当态度区间与写入时不同时，标记已存储的 `relationship` 文本需要重写。缺失键 = 开 |

启用 `damping` 后，推离零点的分数变化会按 `(1 - |score| / 100) ^ dampingPower` 缩放，因此极端值需要持续努力才能达到；趋向零的变化全额应用。分数以小数精度存储，以整数显示；`/nep memory affinity` 可直接设置分数，不受阻尼影响。

设置 `decayPerDay` 后，所有已存储的态度分数（公共和私有）每天向零漂移。使用默认设置时，分数 100 的每日损失为 4；64 时约 1.6；30 时约 0.36。扫描在启动时和每小时运行，从档案上的时间戳（`affinity.decayedAt`）按整天数应用，因此停机时间会被追上。暂停期间和预热期间不运行。不写入态度历史条目。

## `lore`

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxEntries` | `500` | 每服务器最大世界书条目数 |
| `scanMessages` | `30` | 扫描关键词匹配的消息数 |
| `maxMatches` | `8` | 每请求显示的最大条目数 |
| `textChars` | `600` | 世界书条目文本限制（字符） |

## `web`

网络查询（`features.webLookup`）的设置。链接阅读和搜索共享一个每日计数器（`web.maxPerDay`）。结果缓存在媒体缓存（`data/guilds/<id>/media.json`）中。所有模型调用通过 `classifier.text` 角色。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxPerDay` | `60` | 链接阅读和搜索请求合计的共享每日上限 |
| `acceptLanguage` | `"en,ru;q=0.8"` | 读取页面时发送的 Accept-Language 请求头；为空则不发送 |

### `web.links`

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 阅读聊天中发布的链接（仅 http/https，拒绝私有地址，排除视频站点链接） |
| `prefill` | `true` | 链接到达时立即阅读，以便下次回合时已有缓存 |
| `prefillPerUserPerDay` | `10` | 预读在到达时每个成员每天最多阅读的链接数；回合路径不受此限制 |
| `maxPerTurn` | `2` | 每回合最大新链接阅读数（每次抓取尝试都计数） |
| `maxBytes` | `1500000` | 页面大小上限（字节），超过则拒绝 |
| `textChars` | `6000` | 发送给浓缩器的页面文本最大字符数 |
| `summaryChars` | `700` | 浓缩摘要的最大字符数；填充 `read-link.md` 中的 `{{maxChars}}` |
| `maxOutputTokens` | `300` | 浓缩器的最大输出 token 数 |
| `fetchTimeoutMs` | `10000` | 每页下载超时（毫秒） |
| `skipSites` | `["cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com", "klipy.com", "imgur.com", "i.redd.it", "v.redd.it", "pbs.twimg.com"]` | 永不阅读的主机名（含子域名；在视频站点之外，视频站点始终排除） |

### `web.search`

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 分类器触发时运行搜索；需要 `.env` 中的 `BRAVE_SEARCH_API_KEY` |
| `maxPerTurn` | `1` | 每回合最大搜索次数 |
| `results` | `5` | 请求的 Brave Search 结果数 |
| `summaryChars` | `900` | 浓缩答案的最大字符数；填充 `search-summary.md` 中的 `{{maxChars}}` |
| `maxOutputTokens` | `400` | 浓缩器的最大输出 token 数 |
| `cacheHours` | `24` | 缓存的搜索结果在重新搜索前服务的小时数 |
| `contextMessages` | `50` | 为搜索分类器渲染为 `<transcript>` 的近期频道消息数 |
| `timeoutMs` | `10000` | Brave Search 请求超时（毫秒） |

## `image`

绘画子进程（`features.imageGeneration`）的设置。角色输出 `<draw>` 标签后，代码通过 OpenRouter Images API 生成一张图片并作为独立消息发布。生成次数和每日计数器存储在 `data/state.json`（`imageDay`、`imageCount`、`imageUsers`）中。所有图片使用 `image.model`，不使用聊天模型或分类器模型。

| 键 | 默认值 | 说明 |
|---|---|---|
| `model` | `"openai/gpt-image-2.5-flare"` | 图像模型 ID。仅支持 `openai/*` 和 `google/*` 系列；其他系列在发送请求前即被拒绝 |
| `maxPerDay` | `50` | 整个实例的每日生成上限 |
| `maxPerUserPerDay` | `50` | 每个成员的每日生成上限；自发回合和 `/nep draw` 不计入成员配额 |
| `maxPromptChars` | `800` | `<draw>` 标签的场景文本截断至此长度 |
| `reference` | `"avatar"` | 角色出现在图片中（`self="yes"`）时发送的视觉参考。`"avatar"` 下载机器人的 Discord 头像；其他值或 `null` 不发送 |
| `referenceMaxBytes` | `4000000` | 头像最大文件大小（字节）；超过则跳过 |
| `outputFormat` | `"png"` | 请求的输出格式（`png`、`jpeg`、`webp`） |
| `aspectRatio` | `"auto"` | 宽高比（`auto`、`1:1`、`16:9`、`9:16` 等）。Google 模型中 `auto` 从请求中省略 |
| `timeoutMs` | `120000` | 请求超时（毫秒） |
| `retries` | `1` | 瞬态错误（HTTP 408/429/5xx、网络错误）的重试次数 |
| `provider` | `null` | 图像请求的 OpenRouter `provider` 路由，在 `llm.providerByModel` 无匹配时使用；`null` 不发送。系列特定的 provider 选项（如 `openai.moderation`）会合并在最终路由之上 |

### `image.openai`

`openai/*` 图像模型的特定选项。

| 键 | 默认值 | 说明 |
|---|---|---|
| `quality` | `"medium"` | 图像质量（`auto`、`low`、`medium`、`high`；2.5 模型还接受 `xhigh`、`max`） |
| `background` | `"auto"` | 背景模式（`auto`、`opaque`；2.5 模型还接受 `transparent`） |
| `moderation` | `"low"` | 作为 provider passthrough 发送到 `provider.options.openai.moderation` |

### `image.google`

`google/*` 图像模型的特定选项。

| 键 | 默认值 | 说明 |
|---|---|---|
| `resolution` | `"1K"` | 输出分辨率（`512`、`1K`、`2K`、`4K`；支持因模型而异）。`gemini-2.5-flash-image` 无分辨率设置 |

## `variety`

多样性过程的设置（`features.variety`）。每轮之前，角色近期的消息会发送给 `classifier.text` 模型，由其识别重复的表达手法。结果以 `<worn>` 块的形式出现在本轮请求中。超时或过程失败不会延迟或中断本轮，本轮会在没有该块的情况下继续。全部热重载。

| 键 | 默认值 | 说明 |
|---|---|---|
| `window` | `16` | 过程查看的角色自身消息数：先取本轮频道的，再取其他频道的 |
| `recentMinutes` | `180` | 超过此分钟数的消息不纳入 |
| `minLines` | `3` | 消息少于此数时跳过过程 |
| `contextChars` | `120` | 每条消息所回复内容保留的字符数（`(to: ...)` 上下文） |
| `maxPatterns` | `4` | 一次过程最多可识别的手法数 |
| `shapeChars` | `140` | 一个手法描述的最大字符数 |
| `maxOutputTokens` | `500` | 过程的最大输出 token 数 |
| `timeoutMs` | `8000` | 请求超时（毫秒）；过慢或失败的过程不会延迟本轮 |
| `history` | `20` | `/nep variety` 显示的历史过程环的容量 |

## `private`

私聊设置（`features.privateMessages`）。全部热重载。门控在无 LLM 请求的情况下本地检查。

| 键 | 默认值 | 说明 |
|---|---|---|
| `minAffinity` | `5` | 回复私信所需的最低公共好感度分数；所有者跳过此检查 |
| `maxPerUserPerDay` | `100` | 每成员每日到达模型的私信回合数（无论回复或沉默）；达到时每天发送一次限制通知 |
| `maxPerOwnerPerDay` | `200` | 所有者每日到达模型的私信回合数（无论回复或沉默） |
| `purgeMaxMessages` | `5000` | `/nep private purge` 单次运行扫描的最大私信消息数（从最新开始） |

当 `features.relationships` 关闭时，公共分数保持为 0，因此在默认 `minAffinity` 下只有所有者可以发送私信。

## `mentor`

手动测试子进程的设置（`features.mentor`）。Mentor 构造聊天场景，在沙盒中让角色作答并评分。使用独立的模型和独立的每日 token 预算；其操作不计入 `llm.maxRequestsPerDay`。全部热重载。

| 键 | 默认值 | 说明 |
|---|---|---|
| `model` | `null` | Mentor 模型 ID。`null` 或缺失时，所有需要模型的命令会提示未配置 |
| `maxTokensPerDay` | `400000` | 每日 token 预算。按实际用量计算：提示 token x1、缓存提示 token x`cachedTokenWeight`、输出 token x`outputTokenWeight`。沙盒中角色模型的回答以相同方式计算 |
| `outputTokenWeight` | `5` | 输出 token 在预算中的权重，反映生成 token 的较高成本 |
| `cachedTokenWeight` | `0.1` | 缓存提示 token 在预算中的权重 |
| `maxOutputTokens` | `6000` | 每次 mentor 请求的最大输出 token |
| `timeoutMs` | `300000` | Mentor 请求超时（毫秒） |
| `situations` | `5` | 每次运行构造的聊天场景数 |
| `situationLines` | `[6, 15]` | 每个场景的最小和最大行数 |
| `samples` | `3` | 每个场景的角色回答数。真实 moment 使用 `anchor.samples` |
| `check.samples` | `1` | `/nep mentor check` 时每个场景的角色回答数。真实 moment 使用 `anchor.samples` |
| `pass.score` | `7` | `overall` 和 `goal` 的中位数达到此阈值时案例通过 |
| `pass.anchorScore` | `null` | 真实 moment 的阈值。设为数字时，真实 moment 的 `overall` 或 `goal` 中位数低于该值则案例失败。`null` 使用 `pass.score` |
| `pass.floor` | `5` | 任一轴的中位数低于此下限时案例失败。每个构造场景也受此下限约束：当任一构造场景的 `overall` 中位数或 `goal` 中位数低于此值时案例失败，无论所有回答的中位数如何。真实 moment 以通过分（设置了 `pass.anchorScore` 时用其值，否则用 `pass.score`）为阈值 |
| `diagnose` | `true` | 失败或存在弱场景的运行结束后，mentor 说明上下文中导致弱回答的原因。存储为运行中的 `diagnosis`；check 不请求 |
| `reference.days` | `7` | 用于构建风格参考的聊天历史天数 |
| `reference.samples` | `60` | 从参考窗口中随机选取的风格示例行数（2–200 字符） |
| `reference.maxMessages` | `3000` | 从参考频道读取的最大消息数 |
| `reference.rarePer1000` | `0.5` | 每 1000 字符中使用次数低于此值的标点视为稀有 |
| `reference.rareMinAuthors` | `2` | 使用该标点的作者数少于此值时视为稀有 |
| `anchor.max` | `5` | 每个案例的真实 moment 数。每个 moment 是所有者拒绝的角色消息，连同之前的聊天一起存储 |
| `anchor.contextMessages` | `30` | 解析 moment 时从频道获取的上下文消息数，截止到触发消息 |
| `anchor.samples` | `5` | 运行和 `/nep mentor check` 中每个真实 moment 的角色回答数 |
| `anchor.hideLaterMemory` | `true` | 重放真实 moment 时，隐藏在触发消息时间点或之后写入的记忆（事件、态度变化、详情、兴趣、别名、学到的内容、知识库条目）。设为 `false` 则使用当前全部记忆重放 |
| `feedbackExamples` | `10` | 在每次评分请求中包含的最新所有者修正（`/nep mentor wrong`）数 |

`llm.maxRequestTokens`（每次请求 50k）适用于 mentor 发出或引起的每个请求，包括沙盒回答。每次 mentor 请求前，预算检查计入提示加上回答可能的最大成本（`mentor.maxOutputTokens` 乘以 `mentor.outputTokenWeight`），因此当可能的输出不适合剩余预算时请求被拒绝。预算耗尽时运行停止并报告已有结果。运行期间 `features.mentor` 或 `mentor.model` 被关闭时运行也会停止，参考窗口内参考频道中没有人的消息时同样停止。

## `warmup`

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 首次启动时自动运行预热 |
| `lookbackDays` | `60` | 回溯采样天数 |
| `minMessages` | `30` | 成员入选所需的最少自身消息数 |
| `maxPeople` | `40` | 处理的成员数，按活跃度排序 |
| `messagesPerPerson` | `2000` | 每成员采样的自身消息数 |
| `contextBefore` | `1` | 每条采样消息前的上下文行数 |
| `maxChannelShare` | `0.5` | 单个频道在样本中的最大占比 |
| `messagesPerChannel` | `200` | 用于描述频道的最新消息数 |
| `serverSampleMessages` | `600` | 服务器请求使用的近期主频道消息数 |
| `refreshMessages` | `400` | 画像刷新采样的消息数 |
| `fetchLimitPerChannel` | `15000` | 每频道为样本池获取的消息数 |
| `maxOutputTokens` | `6000` | 每次预热请求的最大输出 token 数 |
| `maxRequestTokens` | `120000` | 每次预热请求的最大 token 数（输入 + 输出） |
| `maxTokens` | `6000000` | 运行的总 token 预算 |
| `rateLimitWaitMinutes` | `10` | 遇到速率限制时等待的分钟数 |
| `rateLimitMaxWaits` | `36` | 连续等待次数达到此值后运行中止 |

## 模型

引擎使用五个模型角色。每个独立设置，因此语音可以使用高端模型，而辅助工具保持低成本。

### 声音（`llm.model`）

`talk` 角色。预算允许范围内最强的模型。角色扮演质量、角色一致性和自然对话均依赖于此。较小的模型会破坏角色、忽略上下文线索且语气平淡。

默认：`anthropic/claude-opus-4.6`。更便宜的选择：`anthropic/claude-sonnet-4.6`。

### 分析器（`memory.model`）

`analyzer` 角色。在长对话记录上进行推理并返回严格的 JSON。需要与语音相同级别的智能。`null`（默认）使用角色的模型。适用相同的示例。

### 文本分类器（`classifier.text`）

能可靠回答 "yes" 或 "no" 的最便宜的文本模型。运行地址分类器、重看分类器、搜索分类器，并浓缩链接阅读和搜索结果。默认：`anthropic/claude-sonnet-4.6`。

### 图片（`classifier.media`）

任何低成本的视觉模型。只需写一行描述，推理能力几乎不重要。

默认：`anthropic/claude-haiku-4.5`。最便宜的替代：`google/gemini-2.5-flash-lite`。

### 视频（`classifier.video`）

只有通过 OpenRouter 同时接受视频和音频输入的模型才能在此工作。接受帧但不接受音频的模型（Qwen VL、GLM、Seed、Gemma）无法听到语音，会遗漏大部分要点。

`google/gemini-flash-latest` 是一个浮动别名，其价格可能随时变化。批量（`:batch`）变体是异步的，不适用于实时回复。直接 URL 路径（在长度限制内的 YouTube，以公开 URL 通过 `media.video.provider` 发送）需要 Google AI Studio 作为 provider。

每分钟片段成本（美元），基于 2026-09-23 的 OpenRouter 价格：

| 模型 | ~USD / 1 min clip |
|---|---|
| `google/gemini-2.5-flash-lite` | 0.002 |
| `google/gemini-3.1-flash-lite` | 0.005 |
| `google/gemini-3.5-flash-lite` | 0.006 |
| `google/gemini-3.7-flash` | 0.014 |
| `google/gemini-3.8-flash` (default) | 0.014 |

`qwen/qwen3.8-omni-flash` 同样接受视频和音频。价格会变化；上表是截至上述日期的快照。

### Mentor（`mentor.model`）

`mentor` 角色。对角色的回答进行评分并构造测试场景。建议使用与对话模型不同家族的模型：模型看不到自身家族的习惯。`null`（默认）保持 mentor 禁用；需要模型的 `/nep mentor` 命令会提示。

### 图片输出（`image.model`）

与 `classifier.media`（描述输入图片的模型）分开。此模型通过 OpenRouter Images API（`POST /api/v1/images`）生成图片。仅支持两个系列：`openai/*` 和 `google/*`。不支持的系列在发送请求或计数前即被拒绝。

**OpenAI 模型。** 使用 `image.openai.quality`、`image.openai.background`、`image.openai.moderation`、`image.aspectRatio`、`image.outputFormat` 和 `input_references`。

| 模型 | 备注 |
|---|---|
| `openai/gpt-image-2.5-flare` (default) | 快速层 |
| `openai/gpt-image-2.5-sunburst` | 高精度层 |
| `openai/gpt-image-2` | |
| `openai/gpt-image-1` | |
| `openai/gpt-image-1-mini` | |

**Google 模型。** 使用 `image.google.resolution`、`image.aspectRatio`、`image.outputFormat` 和 `input_references`。`image.aspectRatio` 为 `auto` 时从 Google 请求中省略。

| 模型 | 备注 |
|---|---|
| `google/gemini-3.1-flash-image` | Nano Banana 2 |
| `google/gemini-3-pro-image-preview` | |
| `google/gemini-2.5-flash-image` | 无分辨率设置 |

按输出 token 计费，而非按图片计费；provider 的 `usage.cost` 由 `/nep draw` 报告并记入日志。引擎在发送前拒绝的请求（每日或每人上限、不支持的模型系列）不产生费用；provider 拒绝的生成通常不计费；超时或图片生成后上传失败的情况仍可能产生费用。
