# 消息与记忆

角色如何处理消息和记住人们。

## 流程

消息经过服务器、频道和自身消息过滤。如果角色被呼叫（@提及、回复或名字触发），忽略启发式会根据基础概率进行判定，该概率会因空提及、重复标记、垃圾消息和呼叫者的关系分数而调整。判定失败时消息会被忽略；被忽略的消息仍会出现在下次回复构建的对话记录中。

角色回复某人后，该频道内接下来 `mention.followUpMinutes` 分钟的未标记消息会被发送到 `classifier.text` 角色上的分类器，回答 `yes`、`overheard` 或 `no`。`yes` 延续对话；`overheard`（谈论角色而非对它说话）在 `mention.followUpOverheard` 开启（默认）时启动使用 `prompts/overheard.md` 的独立回合，否则视为普通跟进。连续三个 `no` 判定（`mention.followUpNoStreak`）关闭窗口；`overheard` 在连续判定中视为 `yes`。后续窗口在重启后保留。`features.followUp` 可关闭此功能。

自发回合由混沌定时器或逐消息窃听概率（`spontaneous.eavesdropChance`）触发。面向全体（而非面向特定人）的消息有概率（`spontaneous.roomQuestionChance`，默认 0.04）被角色接听，经分类器（`prompts/room.md`）确认后回合聚焦于该消息。`spontaneous.deadAfterMinutes` 的沉默后，即使角色自己的消息是频道中的最后一条，角色也可以发起话题；角色永远不会在自己的最后一条消息上插话。角色不会在沉默超过 `spontaneous.maxChannelSilenceHours` 小时的频道中主动发言；但该频道中的直接提及仍会回复。

### 一次一条回复

角色在整个服务器范围内同一时间只写一条回复（`mention.oneAtATime`）。当 `mention.pendingSameChannel` 开启（默认 `true`，缺失键 = 开启）时，同一频道中在回合执行期间到达的直接提及（@提及或对角色消息的回复）会被挂起，回合结束后以 `mention.switchDelayMs` 的暂停回复，忽略概率在那时判定。如果正在执行的回合已经在历史记录中处理了该提及，则不会重复回复。关闭该开关时，提及会被错过，仅出现在下次回复的对话记录中。来自其他频道的直接提及以相同方式挂起。每个呼叫按到达顺序等候，不会相互替换。跨所有频道和作者最多挂起 `mention.maxPending`（默认 6）个呼叫；超出时淘汰最早的一个（`mention: dropped`，原因 `full`）。呼叫在 `mention.pendingMinutes` 分钟后过期。当前回复完成后，角色在短暂停顿（`mention.switchDelayMs`）后切换频道，基于当前对话状态回复最早的挂起呼叫；通常的忽略概率仍然适用。挂起的呼叫在机器人暂停时不会被回复。繁忙期间到达的名字触发和窃听命中会被跳过。设置 `mention.oneAtATime: false` 后，每个频道独立处理。角色不会在缺少发送消息权限的频道中发言；此类频道仍会被读取和记忆。

当有呼叫来自在该频道已有等候条目的作者时（分拆消息中尚未处理的部分，或之前排队的呼叫），合并分类器（`prompts/merge.md`，使用 `classifier.text`，用途标记 `merge`）判断新消息是否属于其中某个条目。如果是，新消息被折叠进该条目而非作为独立呼叫排队；该条目的回合通过 `labels.task.added` 看到它。没有提示文件时，每个呼叫都单独排队。记录为 `merge: verdict` 或 `merge: failed`。

回答呼叫的回合会通过 `labels.task.queued` 列出同一作者的其他等候呼叫（在分拆回合中作为 `labels.task.part` 的 `{others}` 的一部分），通过 `labels.task.queuedOthers` 列出频道中其他成员的等候呼叫。以这种方式列出的呼叫不会因为已出现在回合的历史记录中而被丢弃。没有这些标签时使用旧规则，等候呼叫不被列出。

当 `features.elsewhere` 开启且角色在只读频道中被呼叫（@提及、回复、名字）时，呼叫等待对话稳定（`elsewhere.settleSeconds`，上限 `elsewhere.settleMaxSeconds`），然后角色在 `memory.mainChannelIds` 中第一个可用的频道回复，附带跳转链接。等候中的较新呼叫替换旧的（除非新呼叫更弱：名字触发替换不了标签呼叫）。等候期间消息被删除的（`gone`）或无法获取的（`fetch-failed`）呼叫会被丢弃。重启会丢失等候中的呼叫（它在环中保持未回复状态）。呼叫记录保留在每频道的环中（`elsewhere.rememberPings`，默认 20），保留 `elsewhere.pingMaxAgeDays`（默认 7）天。角色也可以主动评论自己在只读频道中读到的内容（记录为 `spontaneous: noticed`），评论发布在主频道，使用 `prompts/elsewhere.md` 作为任务。

### 分拆消息

当 `features.splitTasks` 开启（默认如此）且一个直接呼叫（提及、回复、名字、跟进、私信）足够长且有结构（`split.minChars`，至少两个分隔符），分类器（`prompts/split.md`，使用 `classifier.text`，用途标记 `split`）判断其中是否包含多个独立的请求。分类器与回合的准备过程并行运行，不会延迟单个请求。回答为 `one`（一个请求）或 2 到 `split.maxTasks` 行，每行以 `- ` 开头，用作者自己的话表述一个部分。

各部分成为同一消息上的普通回合链。每个部分是其自身回合的查询、频道路由和 recall 辅助的候选，角色的请求会指出正在回答的部分和其余部分（`labels.task.part`）。第一个部分回复消息，其余的发布为普通消息。每个部分有自己的截止时间和丢弃限制。角色以沉默、失败或拒绝回答的部分不会阻止下一个。暂停或预热会提前结束链（`turn: chain stopped`）。忽略概率、私聊每日上限和环标记在每条消息上只计一次。链运行期间，挂起呼叫继续排队；注意力在链结束时才释放。

设置：`features.splitTasks`、`split` 组（`minChars`、`maxTasks`、`contextMessages`、`maxOutputTokens`）。没有 `prompts/split.md` 或没有 `labels.task.part` 时分拆器关闭。日志：`split: verdict`、`split: skipped`、`split: failed`、`turn: part`、`turn: chain stopped`。

当 `features.pauseNotice` 开启时（默认如此），角色在暂停时被呼叫会收到一条简短回复（`labels.limits.paused`）。每个频道每 `mention.pauseNoticeMinutes`（默认 10）分钟最多一条。

### 时机

对话请求之前运行的所有任务（历史、说明、多样性过程、路由和搜索分类器）有一个截止时间：`pace.prepareMs`（默认 6 秒），搜索发起后延长到 `pace.prepareSearchMs`（默认 12 秒）。超时的辅助任务被丢弃，回合在没有其结果的情况下继续（记录为 `turn: stage late` 或 `turn: stage failed`）。完成的回答本身必须在回合开始后 `pace.dropAfterMs`（默认 60 秒）内到达；超时后回合被丢弃不发布（记录为 `turn: dropped`）。每个回合在 `turn: timings` 中记录各阶段的耗时。

`llm.hedge.roles`（默认 `classifier.text`）中列出的角色的请求会被对冲：第二次尝试在第一次之后 `llm.hedge.afterMs`（默认 2.5 秒）启动，先完成的获胜。两者在 `llm.hedge.timeoutMs`（默认 8 秒）后中止。`llm.helperTimeoutMs`（默认 30 秒）分别限制路由分类器、搜索分类器和 recall 摘要。

当 `pace.typingWhilePreparing` 开启（默认关闭）时，输入指示器从回答直接呼叫的回合开始显示，而非仅在完成的回答打字阶段显示。

### 请求

回合收集频道对话记录和相邻频道，然后在 token 预算内构建一个 LLM 请求。各区块按优先级填充：系统提示和任务永不裁剪；然后是呼叫者的档案、查询结果（网络、服务器或两者兼有）、服务器习惯和自述事实、频道地图、世界书条目、对话记录（最新优先）、其他档案和相邻频道。

当 `features.channelRoute` 开启时（默认如此），分类器（`prompts/route-channel.md`）从最多 `route.maxChannels`（默认 40）个候选频道中选出对话中提及的频道，以便将其作为 `<channel_view>` 块拉入请求。这与显式频道提及（`features.channelPull`）并行：路由分类器解析间接引用（"那个频道"、"某某的频道"），而真实的 `<#id>` 提及始终直接拉取。

模型可以看到服务器的频道地图（用途、话题、氛围、活跃度），当前频道会被标记。每个频道条目还包含代码维护的数据：消息数量、首条和末条消息、近 30 天的活跃度和最活跃的作者（`memory.channelWritersStored`，按 `memory.channelWritersHalfLifeDays` 衰减）。预热从频道历史中填充这些数据，实时流量保持其更新。当频道笔记在 `memory.notesStaleDays`（默认 7）天内未变更且批次中有至少 `memory.notesMinLines`（默认 20）行来自该频道时，分析器会被要求重新检查。

模型使用 `<think>`（隐藏的思考过程）、`<msg>`（1 到 3 条聊天消息；`reply="#87"` 回复对话记录中的某一行）、`<react>`（一个 emoji 反应）或 `<skip/>`（保持沉默）来回应。解析后，按人类速度模拟输入，输出中的 `@nick` 会转换为真实的提及。每条消息截断至 Discord 的 2000 字符限制。发送失败的消息会被记录（`turn: send failed`）并终止该回合的发布。

## 近期记事

当 `features.recent` 开启时（默认如此），`<recent>` 块显示服务器最近 `memory.recentHours`（默认 72）小时内发生的事情：分析器写入的带日期短行，以及本轮提及的成员的近期回忆。一行仅来自本轮自身的频道或此处所有人都能阅读的频道；私聊中仅来自所有服务器成员都能阅读的频道，不含回忆。本轮提及的人的条目排在前面。块上限为 `context.caps.recent`（默认 1200）token。

分析器每批次最多写入 `memory.maxNewRecent`（默认 3）行，每行最多 `memory.recentChars`（默认 160）字符。行存储在 `data/guilds/<id>/recent.json`（最多 `memory.maxRecentStored`，默认 150），`memory.recentHours` 后过期。`/nep memory recent` 显示实时行。

## 分析器

记忆分析器在累积了足够消息时（`memory.batchMessages`、`memory.minBatchMessages`、`memory.maxBatchAgeMinutes`）作为单独的 LLM 调用运行。它接收角色卡，以角色的视角评判每个人，返回态度变化、档案更改、频道观察和服务器级笔记。

当批次对 token 上限来说过大时，分析最早的可容纳行，剩余的推迟到下一批次（日志报告 `consumed`、`shown` 和 `deferred`）。安静的私聊缓冲区（`memory.privateMaxAgeMinutes`，默认 360 分钟内无新消息）即使未达到 `minBatchMessages` 也会被分析。内部梗和自述事实列表在满员时通过淘汰最过时的已有条目来为新条目腾出空间。世界书在达到 `lore.maxEntries` 时淘汰最过时的条目。

失败的批次（输出截断、JSON 无法解析、超 token 上限）将批次大小减半用于下次尝试。当批次已经处于下限（20 条消息）仍然失败时，等待 15 分钟后再重试而非立即重试（日志记录 `memory: update failed ... backing off`，附带 `atFloor: true` 和 `backoffMs`）。缓冲区始终保留。

### 档案

档案以增量方式更新：分析器只返回变更内容，已存储的事实不会被重新概括。每个档案包含：

- **性格和风格**：由档案提示（`profile.md`）在预热期间完整撰写的自由文本段落，由代码（基于消息计数器的定期调度）或分析器标记出缺失或矛盾时刷新。流分析器不直接编辑它们；流批次返回的 `character` 和 `style` 会被丢弃。
- **兴趣**：独立条目，带有主题和备注。按频率和近期程度排名，权重随时间衰减（`memory.interestHalfLifeDays`）。每人保存的条目多于显示的（`memory.maxInterestsStored` vs `memory.maxInterests`），因此新条目可以在不可见的尾部积累权重。超过 `memory.interestStaleDays` 未被观察到的兴趣会以过时状态展示给角色。
- **细节**：独立条目（一个事实、一个特征、一段背景信息）。与兴趣相同的排名和确认机制，有自己的半衰期（`memory.detailHalfLifeDays`）。
- **别名**：人们在聊天中实际称呼某成员的方式。角色能通过名字或别名识别被提及的成员，即使该成员不在对话中。
- **关系**：角色和这个人之间的关系如何，以角色的声音撰写。
- **态度**：-100 到 100 的分数（`features.relationships`）。分析器返回一个小的变化量，永远不设置绝对分数。分数不会出现在聊天中；它体现在角色投入多少精力上。设置 `relationships.decayPerDay` 后，分数每天向零漂移，离零越远越快。relationship 文本在陈旧时标记为重写：区间变化（`relationships.bandHysteresis` 点余量）、自写入以来 `relationships.rewriteOnDrift` 点的漂移或 `relationships.rewriteAfterMoves` 次态度变动。文本限制为 `relationships.textChars`（默认 600）字符。

成员性格和说话方式的画像取自 `memory.mainChannelIds` 中的频道；当列表为空时，所有频道均计入。`memory.mainChannelIds` 也是只读频道呼叫响应的目标频道（`features.elsewhere`）。存储的记忆通过 id 引用成员，使用时替换为当前名称，因此改名不会破坏已存储的笔记。

### 确认

兴趣和细节共享一个确认机制。新条目起始权重为 1（或当分析器标记 `"sure": false` 时为 0）。在不同场合的观察（间隔至少 `memory.confirmGapHours`）使权重增加 1。条目在权重达到 `memory.confirmAfter` 时变为已确认；在此之前角色看到它时会带有"(未确认)"标记。别名使用相同的排名和观察机制，但 `"sure": false` 机制和未确认标记不适用于别名。三者均按 `log2(weight + 0.5) + lastSeen / halfLife` 排名，因此频繁且近期的排在最前。

## 回忆

回忆是角色记住的关于个人的时刻：一次冒犯、一次善意、一个承诺、一次打赌、一个共同的笑话、某人要求角色做或不做的事情。分析器将它们追加到相应人员的档案中，附带日期、简短描述、有时还有当事人的原话，以及 1 到 5 的权重。权重最高的存续最久；当档案达到 `memory.maxEpisodes` 上限时，最轻的先被淘汰，然后是最旧的。只有呼叫者的回忆会在 `<people>` 块中显示。

## 世界书

世界书存储跨对话的服务器级知识：事件、常驻角色、长期故事、恩怨、传统。每个条目有一个标题、一组关键词和一段简短文本（`lore.textChars`）。代码扫描最近 `lore.scanMessages` 条消息以匹配关键词，在 `<lore>` 块中最多包含 `lore.maxMatches` 个条目；标记为 `always` 的条目每次都会出现。可以存在数百个条目而几乎不增加开销，因为只有匹配的少数才会被展示。

分析器添加和更新世界书条目，但不会触碰所有者通过 `/nep lore` 命令添加的条目。世界书数据存储在 `data/guilds/<id>/lore.json`。

分析器还会记录人们直接教给角色的东西（词语和表达、关于服务器的事实、关于角色行为方式的请求），作为服务器级的所学条目，始终出现在提示中。

## 私有层

当 `features.privateMessages` 开启时，通过门控（公会成员身份、已存储档案、公共好感度不低于 `private.minAffinity`、今日回复数未超限）的成员可以在 Discord 私信中与角色交谈。角色不变，公共记忆不变；私信中说的话存储在每成员的私有层中。

只有机器人所有者可以查看成员的私有层（`/nep private show`）；此命令不可授权给其他用户。

私有文件 `data/guilds/<guildId>/private/<userId>.json` 存储自己的 `relationship`、`interests`、`details`、`episodes`、`affinity`（初始分数 0）、每日回复计数器和观察缓冲区。不显示给其他对话，不由服务器批次写入，不在磁盘上混入公共档案。

私信中角色看到公共和私有数据的合并：兴趣按主题合并（私有笔记优先），细节连接，回忆按日期排序。有效好感度为 `clamp(公共 + 私有, -100, 100)`。服务器上仅有公共分数。

`/nep memory forget <user>` 同时删除公共档案和私有文件。`/nep memory wipe` 删除服务器的整个 `private/` 目录。`/nep private forget <user>` 仅删除私有文件，公共档案保留。

## 命令

完整命令列表请参阅[命令](owner-commands.md)。与记忆最相关的命令：

| 命令 | 功能 |
|---|---|
| `/nep memory recent` | 显示实时近期记事行 |
| `/nep memory show <user>` | 已存储档案的简要摘要或特定部分 |
| `/nep memory channel` | 已存储的频道笔记和代码维护的数据 |
| `/nep memory server` | 服务器级的习惯、内部梗、自述事实 |
| `/nep memory refresh <user>` | 强制刷新某个成员的画像 |
| `/nep memory forget <user>` | 删除已存储的档案和私有记忆 |
| `/nep memory affinity <user>` | 显示或设置态度 |
| `/nep memory wipe` | 清除服务器的所有分析器记忆（包括私有文件） |
| `/nep private show <user>` | 显示成员的私有记忆 |
| `/nep private forget <user>` | 仅删除私有文件；公共档案保留 |
| `/nep lore add` | 添加或覆盖一个世界书条目 |
| `/nep pause` / `/nep resume` | 停止活动并将记忆刷入磁盘，以便安全地手动编辑 |
