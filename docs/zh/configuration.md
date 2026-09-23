# 配置

`config.json` 中所有键及其默认值，按节分组。

## `features`

| 键 | 默认值 | 说明 |
|---|---|---|
| `dryRun` | `false` | 完整流程运行但不发送（见[试运行](README.md#试运行)） |
| `mentions` | `true` | 响应 @提及 |
| `replies` | `true` | 响应回复 |
| `nameTriggers` | `true` | 响应消息中的名字提及 |
| `spontaneous` | `true` | 随机定时器触发的主动消息 |
| `eavesdrop` | `true` | 随机概率对任意消息插话 |
| `memory` | `true` | 构建档案、追踪服务器规律、记录自述 |
| `relationships` | `true` | 每成员态度分数（-100..100） |
| `episodes` | `true` | 每人的长期回忆（时刻、引言、恩怨） |
| `lore` | `true` | 服务器级世界书 |
| `reactions` | `true` | 表情反应 |
| `multiMessage` | `true` | 允许连续发 2–3 条消息 |
| `vision` | `true` | 处理附加图片 |
| `mediaDescriptions` | `true` | 为图片、GIF、视频帧和链接缩略图生成单行描述 |
| `videoDescriptions` | `true` | 通过支持视频的模型观看短视频片段；需同时开启 `mediaDescriptions` |
| `videoRewatch` | `true` | 被呼叫时重看视频以回答相关问题；需要 `videoDescriptions` |
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
| `dryRunChannelId` | `""` | 试运行镜像频道（见[试运行](README.md#试运行)） |
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

`llm.provider` 在每个请求上设置 OpenRouter 的 provider 路由字段，例如 `{ "ignore": ["some-provider"] }` 或 `{ "order": ["anthropic"], "allow_fallbacks": true }`。如果 OpenRouter 账户本身限制了允许的 provider，忽略仅剩的那个会导致每个请求失败并报错 "No endpoints found"。更改 provider 设置后，运行 `/nep ping` 验证每个模型角色是否可达。

## `context`

| 键 | 默认值 | 说明 |
|---|---|---|
| `channelMessages` | `100` | 当前频道消息数 |
| `neighborMessages` | `5` | 每个相邻频道的消息数 |
| `neighborMaxAgeMinutes` | `60` | 相邻频道消息最大时效（分钟） |
| `neighborMaxChannels` | `8` | 最大相邻频道数 |
| `maxMessageChars` | `800` | 超出此长度的消息会被截断（字符） |
| `gapMarkerMinutes` | `20` | 时间间隔标记阈值（分钟） |
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

## `media`

媒体描述器（`features.mediaDescriptions`）的设置。

| 键 | 默认值 | 说明 |
|---|---|---|
| `model` | `"anthropic/claude-haiku-4.5"` | 描述器模型 |
| `maxOutputTokens` | `120` | 每次描述的最大输出 token 数 |
| `imageSize` | `512` | 缩放目标像素 |
| `maxPerTurn` | `6` | 每回合生成的最大描述数 |
| `cacheEntries` | `5000` | 描述缓存大小，以附件为键 |
| `filePreviewChars` | `500` | 文本文件开头显示的字符数 |
| `embedTextChars` | `200` | 链接嵌入文本显示的字符数 |

### `media.video`

视频描述器（`features.videoDescriptions`）的设置。视频视觉需要同时开启 `features.mediaDescriptions` 和 `features.videoDescriptions`。一个独立的支持视频的模型观看短视频片段：Discord 视频附件和 `media.video.sites` 中站点的链接。结果与图片描述一起缓存在媒体缓存中；重复发布不产生额外开销。

| 键 | 默认值 | 说明 |
|---|---|---|
| `model` | `"google/gemini-3.8-flash"` | 支持视频的模型；必须同时接受视频和音频输入 |
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | 直接 URL 路径（在长度限制内的 YouTube）的 OpenRouter provider 路由；`null` 使用 `llm.provider` |
| `maxOutputTokens` | `800` | 每个视频摘要的最大输出 token 数 |
| `summaryChars` | `1500` | 视频描述的最大字符数；填充 `describe-video.md` 中的 `{{maxChars}}` |
| `maxRequestTokens` | `60000` | 每次视频请求的 token 上限（输入 + 输出），替代 `llm.maxRequestTokens`；3 分钟片段按 `tokensPerSecond` 约为 54 000 token，超过默认全局上限 |
| `maxSeconds` | `60` | 附件和下载的站点视频的最大片段时长（秒）；更长的附件由 `ffmpeg` 裁剪，更长的站点视频回退到静帧。直接 URL 站点使用 `directUrlMaxSeconds` |
| `directUrlMaxSeconds` | `180` | 通过公开 URL 发送给提供商的视频的最大时长（秒），适用于 YouTube 及其他 `directUrlSites`；更长的视频走下载裁剪路径，受 `maxSeconds` 限制 |
| `maxBytes` | `8000000` | 最大附件大小（字节）；裁剪后仍超过则永久未命中 |
| `maxPerTurn` | `1` | 每回合最大新视频数；每次获取尝试都计数，无论成功与否 |
| `maxPerDay` | `40` | 每日视频请求上限（在 `state.json` 中存储为 `videoDay`/`videoCount`） |
| `tokensPerSecond` | `300` | 视频每秒的 token 估算，用于预算检查 |
| `timeoutMs` | `90000` | 视频的 LLM 请求超时（毫秒） |
| `toolTimeoutMs` | `60000` | `yt-dlp` 和 `ffmpeg` 子进程的超时（毫秒） |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | 其链接被视为视频的主机名 |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | 可将公开 URL 直接传递给提供商（由提供商自行获取视频）的站点 |
| `directUrlUnknownDuration` | `false` | 即使所有探测均未获取到时长，仍将 directUrlSites 站点的链接发送给提供商；token 估算使用 `maxSeconds`。参见下方的时长探测链 |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | 启动时和 `/nep ping video` 探测的固定 YouTube 视频，用于确认此主机上哪个时长来源可用 |
| `ytdlpPath` | `"yt-dlp"` | `yt-dlp` 二进制文件的路径；站点视频链接和探测时长需要此工具 |
| `ffmpegPath` | `"ffmpeg"` | `ffmpeg` 的路径；裁剪和缩小过长或过大的附件需要此工具 |
| `errorRetryMinutes` | `60` | 错误缓存视频自动重试前的等待分钟数；重看分类器的强制重试忽略此值 |
| `urlProcessing` | `"agentic"` | 公开 URL 视频部分发送的 OpenRouter 处理模式；缺少时某些提供商只能看到单帧。`null` 省略该字段 |
| `reasoning` | `{ "effort": "low" }` | 每个视频请求的 OpenRouter `reasoning` 设置；防止推理占用输出预算。非对象值省略该字段 |
| `prefill` | `true` | 视频到达时立即观看，以便下次回合时已有缓存 |

`yt-dlp` 和 `ffmpeg` 均为可选的系统二进制文件。没有它们时，在限制内的附件仍然可用（直接发送）。更长的附件和所有站点链接会回退到静帧或预览图，角色会被告知原因。每个视频请求都计入 `llm.maxRequestsPerDay` 和视频 token 上限（`maxRequestTokens`）。

YouTube 链接的时长通过以下链式探测获取：首先尝试 yt-dlp，然后尝试 YouTube Data API（需在 `.env` 中设置 `YOUTUBE_API_KEY`），最后尝试抓取观看页面。如果所有探测均失败且 `directUrlUnknownDuration` 处于关闭状态（默认），链接将报告为"无法加载"。开启该开关后，URL 仍会发送给提供商，token 估算按 `maxSeconds` 计费。Data API 密钥免费获取：在 Google Cloud 控制台中启用 YouTube Data API v3 并创建密钥；免费配额为每天 10,000 个单位，一次时长查询消耗 1 个单位。`/nep ping video` 探测 `canaryUrl` 并报告此主机上哪个时长来源可用。缓存的长度限制结果会记录视频时长，当上限提高后会重新尝试。

### `media.video.rewatch`

重看分类器（`features.videoRewatch`）的设置。当角色被呼叫且近期对话记录中有已观看的视频时，一个低成本分类器判断消息是否在询问其中某个视频；如果是，视频模型再次观看片段，回答追加到对话记录中。分类器使用后续模型（`mention.followUpModel`，默认媒体模型）。重看始终使用 `media.video.model`。

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxPerDay` | `20` | 每日重看上限（独立于 `media.video.maxPerDay`） |
| `maxOutputTokens` | `600` | 重看回答的最大输出 token 数 |
| `answerChars` | `1200` | 回答的最大字符数；填充 `rewatch-answer.md` 中的 `{{maxChars}}` |
| `recentMessages` | `60` | 扫描已观看或错误状态视频的近期消息数 |
| `maxCandidates` | `6` | 从近期窗口中提供给分类器的最大视频数，按最新排序 |
| `contextMessages` | `8` | 作为 `<transcript>` 块渲染给分类器的近期频道消息数（不含触发消息）；`0` 省略该块 |

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
| `maxPending` | `3` | 繁忙时可挂起直接提及的频道数 |
| `pendingMinutes` | `10` | 挂起的提及过期时间（分钟） |
| `switchDelayMs` | `[2000, 9000]` | 在下一个频道回复前的暂停时间（毫秒） |
| `followUpMinutes` | `2` | 角色最后一条回复后的后续窗口（分钟） |
| `followUpContext` | `15` | 发送给分类器的对话记录行数 |
| `followUpModel` | `null` | 分类器模型（`null` = 媒体模型） |
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
| `portraitRefreshPerDay` | `20` | 每服务器每天最大画像刷新次数 |
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

启用 `damping` 后，推离零点的分数变化会按 `(1 - |score| / 100) ^ dampingPower` 缩放，因此极端值需要持续努力才能达到；趋向零的变化全额应用。分数以小数精度存储，以整数显示；`/nep memory affinity` 可直接设置分数，不受阻尼影响。

## `lore`

| 键 | 默认值 | 说明 |
|---|---|---|
| `maxEntries` | `500` | 每服务器最大世界书条目数 |
| `scanMessages` | `30` | 扫描关键词匹配的消息数 |
| `maxMatches` | `8` | 每请求显示的最大条目数 |
| `textChars` | `600` | 世界书条目文本限制（字符） |

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

## 选择模型

引擎使用五个模型角色。每个独立设置，因此语音可以使用高端模型，而辅助工具保持低成本。

### `llm.model` — 角色的声音

预算允许范围内最强的模型。角色扮演质量、角色一致性和自然对话均依赖于此。较小的模型会破坏角色、忽略上下文线索且语气平淡。

默认：`anthropic/claude-opus-4.6`。更便宜的选择：`anthropic/claude-sonnet-4.5`。

### `memory.model` — 分析器

在长对话记录上进行推理并返回严格的 JSON。需要与语音相同级别的智能。`null`（默认）使用角色的模型。适用相同的示例。

### `media.model` — 图片

任何低成本的视觉模型。只需写一行描述，推理能力几乎不重要。

默认：`anthropic/claude-haiku-4.5`。最便宜的替代：`google/gemini-2.5-flash-lite`。

### `mention.followUpModel` — 地址分类器

能可靠回答 "yes" 或 "no" 的最便宜的文本模型。`null`（默认）使用媒体模型。

重看分类器共享此模型：同样是低成本的 yes/no 判断（消息是否在询问已观看的视频？）。重看始终使用视频模型。

### `media.video.model` — 带声音的视频

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
