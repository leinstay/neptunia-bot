# 预热

预热从近期消息样本中构建角色对服务器的记忆。首次启动时，当 `warmup.enabled` 为 true 且尚不存在任何档案时，预热会自动运行。预热运行期间角色保持静默。

`/nep warmup run` 可随时启动或恢复完整运行；完整命令列表见[命令](owner-commands.md)。

## 阶段

完整运行按固定顺序进行：频道、人物、服务器。

### 频道

每个可读频道生成一个请求，从最新的 `warmup.messagesPerChannel`（默认 200）条消息中描述，不限消息时效。如果频道历史消息少于该数量，会尝试更深入地抓取。完全没有历史的频道仅从其名称、分类和话题描述。结果是一组频道笔记（用途、话题、氛围）和代码维护的数据（消息计数、最活跃作者、30 天活跃度直方图）。

### 人物

最活跃的成员入选：在最近 `warmup.lookbackDays` 天内至少有 `warmup.minMessages` 条自身消息，最多 `warmup.maxPeople` 人，按活跃度排序。`/nep warmup people` 列出当前设置下符合条件的成员。

对于每个符合条件的成员，引擎采样最多 `warmup.messagesPerPerson` 条其消息，附带 `warmup.contextBefore` 行上下文。单个频道在样本中的占比不超过 `warmup.maxChannelShare`。大样本按时间顺序分成适合 `warmup.maxRequestTokens` 的块；第一块之后的每个块都会收到前一个回答作为 `<draft>` 块，以便模型保留有效内容、纠正变化并用新证据扩展。最终回答存储性格、风格、兴趣、细节、回忆和别名；消息计数和首次/末次出现时间戳由代码计算。

### 服务器

一个请求包含所有频道笔记、每个已建档成员的单行摘要（名称、主要习惯、主要兴趣）以及主频道（`memory.mainChannelIds`；为空时所有频道均计入）的最新 `warmup.serverSampleMessages`（默认 600）行。输出存储为服务器级规律、对话开场白、内部梗和世界书条目。

## 范围

预热写入：频道笔记（用途、话题、氛围）、成员档案（性格、风格、兴趣、细节、回忆、别名）、服务器习惯（规律、开场白、内部梗）和世界书。

态度和关系永远不会被预热。它们仅通过流分析器从实时对话中增长。

`character` 和 `style` 是自由文本字段，仅由档案提示（`profile.md`）撰写，包括预热期间和画像刷新期间。流分析器不会直接编辑它们。数据模型和输出格式请参阅[提示契约](prompt-contract.md)。

## 进度

每次请求后进度持久化到 `state.warmup`，重启后仍保留。因重启、速率限制或 `/nep warmup stop` 中断的运行，在再次调用 `/nep warmup run` 时从中断处恢复。`/nep warmup reset` 仅清除进度，不清除已存储的记忆。

## 限制

运行的总 token 预算为 `warmup.maxTokens`（默认 6,000,000）。每个请求上限为 `warmup.maxRequestTokens`（默认 120,000 输入加输出）和 `warmup.maxOutputTokens`（默认 6,000 输出）。构建样本池的频道获取每个频道最多读取 `warmup.fetchLimitPerChannel`（默认 15,000）条消息。

当 provider 返回 HTTP 429 时，预热等待 `warmup.rateLimitWaitMinutes`（默认 10）分钟后重试。连续等待 `warmup.rateLimitMaxWaits`（默认 36）次后运行中止；进度保留，可以恢复运行。

## 画像刷新

预热完成后，流分析器从实时批次中保持记忆更新。画像通过两种方式刷新。

**按计数器**（`features.portraitRefresh`）。定期调度器每 `memory.portraitCheckMinutes`（默认 60）分钟检查一次，寻找自上次画像以来写了至少 `memory.portraitRefreshMessages`（默认 300）条自身消息，且上次成功刷新距今至少 `memory.portraitRefreshDays`（默认 3）天的成员。每天最多刷新 `memory.portraitRefreshPerDay`（默认 3）人，按活跃度排序。没有画像时间戳的成员会计入所有消息，因此部署后会有多人同时符合条件；日限额将其分散。失败的尝试等待 `memory.portraitRetryHours`（默认 24）小时。采样量被控制在 50k token 限制以内。

**按分析器提示。** 当流分析器检测到存储画像遗漏的反复习惯或写作方式的变化时，返回一行提示，代码将刷新排队。此路径使用现有的每成员冷却时间 `memory.portraitRefreshHours`（默认 24 小时）。流分析器不再能直接覆写 `character` 或 `style`。

两种路径共享日限额。`/nep memory refresh <user>` 无视计时器强制刷新，但仍计入限额。每次刷新计入 `llm.maxRequestsPerDay`。

刷新时以存储的画像为 `<draft>`、分析器笔记为 `<hint>`（如有）调用 `profile.md`。草稿是合并基础：与采样一致的保留（压缩腾出空间），矛盾的修改，新的反复习惯添加，采样中未出现的不删除。新的性格和风格替换存储的版本；回答中的兴趣、细节、回忆和别名被忽略。

## 命令

所有预热命令位于 `/nep warmup` 下。完整参考见[命令](owner-commands.md)。

| 命令 | 说明 |
|---|---|
| `run` | 启动或恢复完整预热（频道、人物、服务器） |
| `users [member]` | 为一个成员或所有符合条件的成员生成档案 |
| `channels [channel]` | 描述一个频道或所有可读频道 |
| `server` | 重建服务器笔记和世界书 |
| `people` | 列出符合条件的成员 |
| `status` | 显示进度和 token 使用量 |
| `stop` | 取消进行中的预热工作；进行中的请求被中止，进度保留 |
| `reset` | 仅清除进度，不清除已存储的记忆 |

`run`、`users` 和 `channels` 在运行进行中时会被拒绝。除 `status`、`people` 和 `stop` 外，所有预热命令在机器人暂停期间会被拒绝。

如需完全重新开始，先使用 `/nep memory wipe`：它会清除成员档案及其态度和回忆、服务器习惯、频道地图、世界书条目和预热进度。

预热配置键的完整列表见[配置：`warmup`](configuration.md#warmup)。
