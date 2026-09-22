<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../.github/assets/banner-dark.png">
    <img src="../../.github/assets/banner.png" width="700" alt="Neptunia - Discord AI 角色引擎">
  </picture>
</p>
<p align="center"><a href="../../README.md">English</a> | 中文 | <a href="../ja/README.md">日本語</a> | <a href="../ru/README.md">Русский</a></p>
<p align="center">
  <a href="https://github.com/leinstay/neptunia-bot/stargazers"><img src="https://img.shields.io/github/stars/leinstay/neptunia-bot" alt="GitHub stars"></a>
  <a href="https://github.com/leinstay/neptunia-bot/forks"><img src="https://img.shields.io/github/forks/leinstay/neptunia-bot" alt="GitHub forks"></a>
  <a href="https://github.com/leinstay/neptunia-bot/issues"><img src="https://img.shields.io/github/issues/leinstay/neptunia-bot" alt="GitHub issues"></a>
  <a href="https://github.com/leinstay/neptunia-bot/pulls"><img src="https://img.shields.io/github/issues-pr/leinstay/neptunia-bot" alt="GitHub pull requests"></a>
  <a href="https://github.com/leinstay/neptunia-bot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/leinstay/neptunia-bot" alt="License"></a>
  <a href="https://github.com/leinstay/neptunia-bot/actions/workflows/test.yml"><img src="https://github.com/leinstay/neptunia-bot/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
</p>

---

Neptunia 是一个本地运行的 Discord 机器人，通过 LLM 扮演一个可配置的角色，表现得像普通聊天成员。需要 Node.js 20+ 且仅依赖 discord.js，支持任何兼容 OpenRouter 的端点。角色卡无需修改代码即可替换，提示和配置支持热重载，具备按成员记忆（含态度和回忆）、服务器级世界书、附图视觉识别、辅助模型生成的单行媒体描述、所有者斜杠命令实时调优以及试运行模式。自带一个可用的示例角色；编写自己的角色卡即可切换角色。

角色会响应 @提及、回复和名字触发，有时会忽略它们。它会在随机间隔插入对话，在沉寂的频道中发起话题。它记住每个人，追踪 -100 到 100 的态度分数并在回复中使用。分数不会出现在聊天中。所有配置和提示均支持热重载；所有者命令可在 Discord 中实时调整机器人。

每个实例服务一个服务器、一个机器人账号、一个角色。如需第二个服务器或角色，需运行另一个副本，各自拥有独立的 `.env`、`config.local.json`、`prompts.local/` 和 `data/`。Discord 会为机器人账号标注 APP 徽章；本引擎不会隐藏这一标识。

## 快速开始

在 [discord.com/developers](https://discord.com/developers/applications) 创建一个 Discord 应用。在 Bot 页面启用 **Message Content** 特权意图。邀请链接需要两个 scope（`scope=bot%20applications.commands`）和 `permissions=68672`（查看频道、发送消息、读取历史、添加反应）。如果机器人加入后斜杠命令未出现，日志会说明原因；重新打开邀请链接并再次完成流程即可修复注册，无需移除机器人。

从 [OpenRouter](https://openrouter.ai/keys)（或任何兼容端点）获取 API 密钥。

```bash
git clone https://github.com/leinstay/neptunia-bot.git
cd neptunia-bot && npm install
cp .env.example .env
```

编辑 `.env`，填入你的 Discord token 和 API 密钥。创建 `config.local.json`，填入你的 Discord 用户 ID：

```json
{
  "bot": {
    "owners": ["YOUR_DISCORD_USER_ID"]
  }
}
```

```bash
npm start
```

当 `bot.guildId` 为空且机器人只在一个服务器中时，它会自动锁定到该服务器。如果机器人在多个服务器中，则拒绝启动。在 `config.local.json` 中设置 `bot.guildId`。

## 提示层

提示从两个目录加载：

- `prompts/`：随仓库提供的引擎默认值。自带一个可用的示例角色。
- `prompts.local/`：你的角色定义（已加入 gitignore）。此目录下的文件会替换 `prompts/` 中的同名文件。`labels.json` 采用深度合并，因此你只需覆盖需要更改的键。

两者均支持热重载。

### 提示文件

| 文件 | 必需 | 用途 |
|---|---|---|
| `system-prompt.md` | 是 | 如何表现得像普通聊天成员，与角色无关 |
| `character-card.md` | 是 | 角色定义：身份、说话方式、关注点 |
| `rules.md` | 否 | 所有者的实时修正，由 `/nep rule add` 追加 |
| `format.md` | 是 | 输出协议：模型用于行动的标签 |
| `reply.md` | 是 | 任务：有人呼叫了角色 |
| `interject.md` | 是 | 任务：插入正在进行的对话 |
| `initiate.md` | 是 | 任务：打破沉默，发起话题 |
| `memory.md` | 是 | 记忆/关系分析器的技术提示 |
| `describe.md` | 是 | 辅助模型的单行媒体描述 |
| `address.md` | 是 | 分类器：未标记的消息是否在对角色说话 |
| `profile.md` | 是 | 预热：从消息样本生成一个成员的档案 |
| `channel.md` | 是 | 预热：从消息样本生成频道笔记 |
| `server.md` | 是 | 预热：从频道笔记和成员摘要生成服务器级笔记 |
| `labels.json` | 是 | 代码插入提示中的所有字符串（两层之间深度合并） |

**你必须重写的唯一文件是 `character-card.md`。**将其复制到 `prompts.local/` 并编写你的角色。其他内容可直接使用，也可按需覆盖单个文件。

记忆分析器会判断角色对人们的感受。分析器和预热都会接收你的角色卡和 `rules.md`，因此请包含角色的好恶。

每个提示文件可使用的占位符、`labels.json` 键、上下文块和输出标签均在 [`docs/prompt-contract.md`](../prompt-contract.md) 中定义；一方变更时另一方也需同步修改。

## 配置

`config.json` 包含所有设置及其默认值。`config.local.json`（已加入 gitignore）会深度合并覆盖。两者均支持热重载。完整配置参考请参阅 [`configuration.md`](configuration.md)。

## 预热

首次启动时，当 `warmup.enabled` 为 true 且不存在任何档案时，引擎会运行预热，从近期消息样本中构建对人、频道和服务器的记忆。总 token 消耗受 `warmup.maxTokens` 限制。预热运行期间角色保持静默。预热的阶段、进度、限制和所有者命令请参阅 [`warmup.md`](warmup.md)。

## 试运行

设置 `features.dryRun: true` 后，机器人运行完整流程（记忆、触发、LLM 调用）但不发送任何消息或反应。输出写入日志（`dry-run: would send` / `dry-run: would react`）。将 `bot.dryRunChannelId` 设为一个私有频道以获得可读的镜像输出；该频道中的所有消息会被机器人忽略。斜杠命令在任何频道均可使用，包括镜像频道，因为它们不是消息。

在新服务器上首次运行：启用 `features.dryRun`，观察镜像频道或 `journalctl -u neptunia-bot -f`，实时调整，然后执行 `/nep set features.dryRun false`。

## 命令

一个 Discord 斜杠命令 `/nep`（名称来自 `bot.commandName`）。以服务器（guild）命令的形式在启动时注册到所服务的服务器。所有回复仅调用者可见（ephemeral），不论在哪个频道输入。所有子命令和访问授权请参阅 [`owner-commands.md`](owner-commands.md)。

## 回合运作方式

消息经过服务器、频道和自身消息过滤。如果角色被呼叫（@提及、回复或名字触发），忽略启发式会根据基础概率进行判定，该概率会因空提及、重复标记、垃圾消息和呼叫者的关系分数而调整。角色回复某人后，该频道内接下来 `mention.followUpMinutes` 分钟的未标记消息会被发送到 `followUp` 模型角色上的分类器（默认使用媒体模型），判断它们是否在延续对话；连续三个 `no` 判定会关闭窗口。`features.followUp` 可关闭此功能。自发回合由混沌定时器或逐消息窃听概率触发。角色不会在沉默超过 `spontaneous.maxChannelSilenceHours` 小时的频道中主动发言；但该频道中的直接提及仍会回复。

角色在整个服务器范围内同一时间只写一条回复。在角色正在回复时，同一频道的提及会被错过；这些错过的消息会出现在下次回复的对话记录中。来自其他频道的直接提及（@提及或回复其消息，非名字触发）会被挂起，每个频道保留一条，最多在 `mention.maxPending` 个频道中保留 `mention.pendingMinutes` 分钟；同一待处理频道中较新的提及会替换较旧的。当前回复完成后，角色在短暂停顿（`mention.switchDelayMs`）后切换频道，基于当前对话状态进行回复；通常的忽略概率仍然适用。繁忙期间到达的名字触发和窃听命中会被跳过。设置 `mention.oneAtATime: false` 后，每个频道独立处理。角色不会在缺少发送消息权限的频道中发言或做出反应，且在消耗 LLM 请求之前检查权限；此类频道仍会被读取和记忆。

回合收集频道对话记录和相邻频道，然后在 token 预算内构建一个 LLM 请求。各区块按优先级填充：系统提示和任务永不裁剪；然后是呼叫者的档案、服务器习惯和自述事实、频道地图、对话记录（最新优先）、其他档案和相邻频道。模型可以看到服务器的频道地图（用途、话题、氛围、活跃度），当前频道会被标记。每个频道条目还包含代码维护的数据：消息数量、首条和末条消息、近 30 天的活跃度和最活跃的作者；预热从频道历史中填充这些数据，实时流量保持其更新。

模型使用 `<think>`（隐藏的思考过程）、`<msg>`（1–3 条聊天消息；`reply="#87"` 回复对话记录中的某一行）、`<react>`（一个 emoji 反应）或 `<skip/>`（保持沉默）来回应。解析后，按人类速度模拟输入，输出中的 `@nick` 会转换为真实的提及。

记忆分析器在累积了足够的消息时作为单独的 LLM 调用运行。它接收角色卡，以角色的视角评判每个人，返回态度变化、档案更改、频道观察和服务器级笔记。成员性格和说话方式的画像取自 `memory.mainChannelIds` 中的频道；当列表为空时，所有频道均计入。档案以增量方式更新：分析器只返回变更内容，已存储的事实不会被重新概括。性格和风格是由档案提示在预热期间完整撰写的自由文本段落，当分析器标记出缺失或矛盾时会从近期消息刷新。兴趣和细节是独立的条目，在另一个场合再次出现时变为已确认；每个人保存的条目多于显示的，按频率和近期程度排名，权重随时间衰减。长时间未出现的兴趣会以过时状态展示给角色。存储的记忆通过 id 引用成员，使用时替换为当前名称，因此改名不会破坏已存储的笔记。角色还会学习聊天中人们对彼此的称呼，即使某成员不在对话中，也能通过名字或别名识别。

## 回忆与世界书

记忆分析器在档案之外记录两种长期笔记。

回忆是角色记住的关于个人的时刻：一次冒犯、一次善意、一个承诺、一次打赌、一个共同的笑话、某人要求角色做或不做的事情。分析器将它们追加到相应人员的档案中，附带日期、简短描述、有时还有当事人的原话，以及 1 到 5 的权重。权重最高的存续最久；当档案达到 `memory.maxEpisodes` 上限时，最轻的先被淘汰，然后是最旧的。只有呼叫者的回忆会在 `<people>` 块中显示。

世界书存储跨对话的服务器级知识：事件、常驻角色、长期故事、恩怨、传统。每个条目有一个标题、一组关键词和一段简短文本。代码扫描最近 `lore.scanMessages` 条消息以匹配关键词，在 `<lore>` 块中最多包含 `lore.maxMatches` 个条目；标记为 `always` 的条目每次都会出现。可以存在数百个条目而几乎不增加开销，因为只有匹配的少数才会被展示。

分析器会自行添加和更新世界书条目，但不会触碰所有者通过 `/nep lore` 命令添加的条目。世界书数据存储在 `data/guilds/<id>/lore.json`。

## 视觉与媒体

对话记录行在括号中携带媒体标记：图片、GIF、视频、贴纸、自定义表情、语音消息、音频文件、链接、文本文件预览和转发消息。来自同一服务器其他频道的转发消息会标注源频道。角色感知到什么取决于两个功能开关。

`features.vision` 将呼叫消息、被回复消息以及频道中最新的几张图片作为图像附加到 LLM 请求中，通过 Discord 的媒体代理缩小。机器人自行下载每张图片并以内联数据发送，因为 Discord 拒绝来自模型提供商的下载请求；超过 `context.vision.maxBytes` 或下载时间超过 `context.vision.fetchTimeoutMs` 的图片会被跳过。角色直接看到这些图片。设置位于 `context.vision` 下。

`features.mediaDescriptions`（默认开启）运行辅助模型（`media.model`）为图片、GIF 帧、视频封面、贴纸、自定义表情和链接缩略图生成单行描述。每个附件只描述一次并缓存。描述提供给对话记录、记忆分析器和预热，预热的 token 预算支付预热描述的开销。描述器的提示是 `prompts/describe.md`。设置位于 `media` 下。

贴纸和自定义表情经常重复出现，因此按 id 缓存，首次描述后几乎没有开销。启用 `features.vision` 时，呼叫消息的贴纸会作为图片附加。Discord 内置的动态贴纸是 Lottie 动画而非图片，因此只能显示名称。

用户消息中的 `<senses>` 块告知角色在当前配置下能和不能感知什么。角色信任此块的内容，不会声称看到、听到或打开了超出其描述的任何东西。

角色无法观看视频或收听音频；它只能获得名称、时长，最多还有一帧描述。语音消息只显示时长。链接显示站点、标题和 Discord 嵌入中的摘要，不显示页面本身。

## 成本与隐私

每个回合是一次 LLM 请求；记忆更新再增加一次。成本取决于模型和端点；`llm.model` 和 `llm.baseUrl` 接受任何兼容的值。每日上限（`llm.maxRequestsPerDay`）防止开销失控。

`data/` 存储每个成员的档案、关系分数、频道观察和服务器规律。它保留在你的机器上，已加入 gitignore，仅作为上下文发送给 LLM。分析器被指示不存储敏感信息。`/nep memory forget` 会完全删除一个档案。

请告知服务器成员。他们应该知道自己的消息会被 LLM 处理，且机器人会保留笔记。

## 作为服务运行

示例 systemd 单元文件在 `deploy/neptunia-bot.service`。调整 `WorkingDirectory` 和 `User`，然后安装：

```bash
sudo cp deploy/neptunia-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now neptunia-bot
```

私有层与代码放在一起：`.env`、`config.local.json`、`prompts.local/`、`data/`。更新方法：

```bash
git pull && sudo systemctl restart neptunia-bot
```

重启不会丢失任何数据；所有状态都在磁盘上。仅在 `src/` 下的代码变更后才需要重启。提示和配置的编辑会实时生效。

记忆保存在进程内存中并写入 `data/`；机器人运行时直接编辑这些文件并不安全，因为下一次写入会覆盖更改。手动编辑记忆的方法：`/nep pause`，编辑文件，`/nep resume`。暂停会停止所有活动，将记忆刷入磁盘并卸载；正在运行的预热会在当前请求完成后暂停。状态会被持久化：重启后仍保持暂停状态，预热在恢复前不会自动启动。`/nep resume` 会验证 `data/` 下的每个 JSON 文件，如果有任何文件无法解析则拒绝恢复并指出哪些文件有问题；否则重新加载记忆并继续，包括从中断处恢复预热。暂停期间只读和配置命令仍可使用；写入记忆的命令会被拒绝。`/nep status` 会显示暂停状态。

## 参与贡献

欢迎提交 issue 和 pull request；请先阅读 `CONTRIBUTING.md`。目标分支为 `main`，每个 pull request 只包含一项变更，`npm test` 测试通过，仅限英语。提示文件与代码之间的契约在 `docs/prompt-contract.md` 中。一方的变更需要在同一个 pull request 中同步另一方。引擎保持角色中立；特定角色的行为属于该部署的 `prompts.local/`。安全报告通过 `SECURITY.md` 提交，不使用公开 issue。

## 测试

```bash
npm test
```

使用 `node --test` 运行。无需网络或 Discord 连接。同一命令在每次 pull request 时在 CI 中运行。

## 项目结构

```
config.json                所有设置及其默认值，热重载
.env.example               DISCORD_TOKEN 和 OPENROUTER_API_KEY 的模板
prompts/
  system-prompt.md         如何表现得像普通聊天成员
  character-card.md        角色定义（可用示例）
  rules.md                 所有者的实时修正
  format.md                模型使用的输出标签
  reply.md                 任务：有人呼叫了你
  interject.md             任务：插入对话
  initiate.md              任务：发起话题
  memory.md                记忆分析器的提示
  describe.md              媒体描述器的提示
  address.md               后续消息分类器
  profile.md               预热：从消息样本生成一个成员的档案
  channel.md               预热：从消息样本生成频道笔记
  server.md                预热：从频道笔记和成员摘要生成服务器级笔记
  labels.json              代码插入提示中的所有字符串
prompts.local/             你的角色定义（已加入 gitignore）
docs/
  prompt-contract.md       提示文件与代码之间的契约
  en/
    configuration.md       所有配置键的完整参考
    owner-commands.md      所有子命令和访问授权
    warmup.md              预热：阶段、进度、限制、命令
  zh/                      中文
    README.md
    configuration.md
    owner-commands.md
    warmup.md
  ja/                      日文
    README.md
    configuration.md
    owner-commands.md
    warmup.md
  ru/                      俄文
    README.md
    configuration.md
    owner-commands.md
    warmup.md
src/
  index.js                 入口，组装，定时器，关闭
  config.js                .env 解析器，配置加载器，deepMerge
  hot.js                   通过 fs.watch 实时更新的配置和提示
  log.js                   结构化 JSON 日志
  admin.js                 所有者命令
  llm/
    tokens.js              带自校准的 token 估算
    budget.js              按优先级裁剪区块
    openrouter.js          聊天补全，安全限制
    parse.js               输出标签转为动作
  discord/
    guild.js               单服务器解析
    commands.js            斜杠命令，注册，交互适配器
    events.js              消息流水线
    collect.js             频道历史，相邻频道，权限
    format.js              对话记录行，时间间隔，节奏
    media.js               媒体分类，标签选择，代理 URL
    fetch-image.js         下载并缓存图片供 LLM 内联请求使用
  behavior/
    mention.js             呼叫检测，忽略启发式
    prompt.js              带 token 预算的请求构建器
    turn.js                一个回合：收集、构建、调用、执行
    spontaneous.js         混沌定时器，窃听
    pending.js             角色繁忙时挂起的直接提及
  memory/
    store.js               JSON 文件持久化，原子写入
    update.js              批量记忆更新
    affinity.js            关系分数逻辑
    interests.js           记住的兴趣：观察、确认、淘汰
    details.js             记住的细节：观察、确认、淘汰
    aliases.js             记住的别名：观察、确认、淘汰
    episodes.js            记住的回忆：追加、按权重淘汰
    channels.js            频道地图渲染，活跃度判定
    mentions.js            存储文本中的成员 id 标记：toTokens 和 fromTokens
    clamp.js               文本截断：软限制、句子边界、完整的成员标记
    ranking.js             兴趣和细节的共享排名：频率、近期程度、衰减
    lore.js                世界书逻辑：关键词匹配、条目选择
    describe.js            媒体描述器：一张图片进，一条缓存的描述出
    warmup.js              基于样本的记忆预热
tests/                     node --test，纯函数单元测试
deploy/
  neptunia-bot.service     systemd 单元示例
data/                      持久状态（已加入 gitignore，运行时创建）
  state.json               调度时间、token 校准、每日请求计数、预热进度
  guilds/<id>/guild.json   服务器习惯、内部梗、角色的自述
  guilds/<id>/buffer.json  自上次记忆更新以来观察到的消息
  guilds/<id>/media.json   媒体描述缓存
  guilds/<id>/users/       每成员档案和关系
  guilds/<id>/channels/    分析器的频道观察
  guilds/<id>/lore.json    世界书条目
```
