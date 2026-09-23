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

Neptunia 是一个本地运行的 Discord 机器人，用 LLM 扮演一个可配置的角色，看起来就像普通聊天成员。基于 Node.js 20+，唯一依赖是 discord.js，支持任何兼容 OpenRouter 的端点。角色卡无需改代码即可替换，提示词和配置热重载。具备按成员记忆（含态度和回忆）、服务器级世界书、附图识别、辅助模型的单行媒体描述、所有者斜杠命令和试运行模式。自带可用的示例角色；换角色只需写自己的角色卡。

角色响应 @提及、回复和名字触发，有时会选择无视。它会随机插入对话，在安静的频道发起话题。它记住每个人，追踪 -100 到 100 的态度分数并体现在回复中。分数不会出现在聊天里。配置和提示词全部热重载；所有者命令可在 Discord 中实时调整。

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

- `prompts/`：附带可用示例角色的引擎默认值（随仓库追踪）。
- `prompts.local/`：你的角色定义（已加入 gitignore）。此目录下的文件会替换 `prompts/` 中的同名文件。`labels.json` 采用深度合并，只需覆盖需要更改的键即可。

两者均支持热重载。

你必须重写的唯一文件是 `character-card.md`。将其复制到 `prompts.local/` 并编写你的角色。其他内容可直接使用，也可按需覆盖单个文件。

提示文件、占位符、标签、上下文块和输出标签均在 [`prompt-contract.md`](prompt-contract.md) 中定义。

## 配置

`config.json` 包含所有设置及其默认值。`config.local.json`（已加入 gitignore）会深度合并覆盖。两者均支持热重载。完整配置参考请参阅 [`configuration.md`](configuration.md)。

## 预热

首次启动时，若 `warmup.enabled` 为 true 且尚无档案，引擎会运行预热：从近期消息样本构建对人、频道和服务器的记忆。token 消耗受 `warmup.maxTokens` 限制。预热期间角色保持静默。详见 [`warmup.md`](warmup.md)。

## 试运行

设置 `features.dryRun: true` 后，机器人运行完整流程（记忆、触发、LLM 调用）但不发送任何消息或反应。输出写入日志（`dry-run: would send` / `dry-run: would react`）。将 `bot.dryRunChannelId` 设为一个私有频道以获得可读的镜像输出；该频道中的所有消息会被机器人忽略。斜杠命令在任何频道均可使用，包括镜像频道，因为它们不是消息。

在新服务器上首次运行：启用 `features.dryRun`，观察镜像频道或 `journalctl -u neptunia-bot -f`，实时调整，然后执行 `/nep set features.dryRun false`。

## 命令

Discord 斜杠命令只有一个：`/nep`（名称来自 `bot.commandName`）。启动时注册为服务器命令，仅限所服务的服务器。回复全部仅调用者可见（ephemeral），不论在哪个频道。详见 [`owner-commands.md`](owner-commands.md)。

## 消息与记忆

角色响应提及、回复和名字触发，有时选择无视。随机插入对话，在安静的频道发起话题。回复某人后，通过分类器追踪该频道的后续消息。整个服务器同一时间只写一条回复；其他频道的提及挂起后依次处理。

独立的记忆分析器在消息累积到一定量时运行。它为每个成员建立档案，包含兴趣、细节、别名、回忆和态度，以及服务器级的习惯、内部梗和事件故事的世界书。档案增量更新；已存储的事实不会被重新概括。角色还会学习人们怎么互称，通过名字或别名认出成员。

详见 [`messages-and-memory.md`](messages-and-memory.md)。

## 媒体

角色可以看到附加图片、观看短视频片段、阅读链接后的页面以及搜索网络以获取它没有的事实。每种能力是一个独立的功能开关，默认关闭或有上限，各自有每日限制。每个请求中的 `<senses>` 块告知角色当前什么是开启的；它不会声称感知了超出此块描述的任何东西。详见 [`media.md`](media.md)：图片、视频视觉、链接阅读、搜索、工具、成本和隐私。

## 成本

每个回合消耗一次 LLM 请求；记忆更新再加一次。成本取决于模型和端点；`llm.model` 和 `llm.baseUrl` 接受任何兼容值。每日上限（`llm.maxRequestsPerDay`）防止超支。视频描述每个片段向更便宜的独立模型发一次请求（`media.video.maxPerDay` 限制每日数量）；`yt-dlp` 和 `ffmpeg` 在本地运行，只消耗带宽。链接阅读和搜索（`features.webLookup`，默认关闭）向文本分类器发请求，受 `web.maxPerDay` 限制；搜索还需要 Brave Search API 密钥（免费层：每月 2,000 次查询）。启用 `features.webLookup` 后，机器人会发出 HTTP 请求获取页面和访问 Brave Search API；私有地址拒绝访问。

`data/` 存储成员档案、关系分数、频道观察、服务器规律、媒体描述和网页摘要的缓存。全部保留在你的机器上，已加入 gitignore，仅作为上下文发送给 LLM。分析器被指示不存储敏感信息。`/nep memory forget` 可完全删除某人的档案。

请告知服务器成员。他们应该知道自己的消息会被 LLM 处理，且机器人会保留笔记。

## 服务

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

记忆保存在进程中并写入 `data/`；运行时直接编辑这些文件不安全，下一次写入会覆盖更改。手动编辑记忆的方法：`/nep pause`，编辑文件，`/nep resume`。暂停会停止所有活动，将记忆刷入磁盘并卸载；正在运行的预热会在当前请求完成后暂停。状态会被持久化：重启后仍保持暂停状态，预热在恢复前不会自动启动。`/nep resume` 会验证 `data/` 下的每个 JSON 文件，如果有任何文件无法解析则拒绝恢复并指出哪些文件有问题；否则重新加载记忆并继续，包括从中断处恢复预热。暂停期间只读和配置命令仍可使用；写入记忆的命令会被拒绝。`/nep status` 会显示暂停状态。

## 参与贡献

欢迎提交 issue 和 pull request；请先阅读 `CONTRIBUTING.md`。目标分支为 `main`，每个 pull request 只包含一项变更，`npm test` 测试通过，仅限英语。提示文件与代码之间的契约在 `docs/zh/prompt-contract.md` 中。一方的变更需要在同一个 pull request 中同步另一方。引擎保持角色中立；特定角色的行为属于该部署的 `prompts.local/`。安全报告通过 `SECURITY.md` 提交，不使用公开 issue。

## 测试

```bash
npm test
```

使用 `node --test` 运行。无需网络或 Discord 连接。同一命令在每次 pull request 时在 CI 中运行。

## 结构

```
config.json                所有设置及其默认值，热重载
.env.example               DISCORD_TOKEN、OPENROUTER_API_KEY 和可选的 YOUTUBE_API_KEY、BRAVE_SEARCH_API_KEY 的模板
prompts/
  system-prompt.md         如何表现得像普通聊天成员
  character-card.md        角色定义（可用示例）
  rules.md                 所有者的实时修正
  format.md                模型使用的输出标签
  reply.md                 任务：有人呼叫了你
  interject.md             任务：插入对话
  initiate.md              任务：发起话题
  forced.md                强制回合（/nep interject、/nep initiate）时追加
  memory.md                记忆分析器的提示
  describe.md              媒体描述器的提示
  describe-video.md        视频描述器的提示
  rewatch.md               分类器：是否需要重看视频
  rewatch-answer.md        重看回答的提示
  address.md               后续消息分类器
  lookup.md                分类器：问题是否需要网络搜索
  read-link.md             浓缩获取的页面
  search-summary.md        浓缩搜索结果
  profile.md               预热：从消息样本生成一个成员的档案
  channel.md               预热：从消息样本生成频道笔记
  server.md                预热：从频道笔记和成员摘要生成服务器级笔记
  labels.json              代码插入提示中的所有字符串
prompts.local/             你的角色定义（已加入 gitignore）
docs/
  en/
    prompt-contract.md     提示文件与代码之间的契约
    configuration.md       所有配置键的完整参考
    owner-commands.md      所有子命令和访问授权
    warmup.md              预热：阶段、进度、限制、命令
    media.md               图片、视频、链接、搜索、工具、成本
    messages-and-memory.md 流程、分析器、档案、回忆、世界书
  zh/                      中文
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
  ja/                      日文
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
  ru/                      俄文
    README.md
    prompt-contract.md
    configuration.md
    owner-commands.md
    warmup.md
    media.md
    messages-and-memory.md
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
    access.js              非所有者的按命令访问授权
    events.js              消息流水线
    collect.js             频道历史，相邻频道，权限
    format.js              对话记录行，时间间隔，节奏
    media.js               媒体分类，标签选择，代理 URL
    fetch-image.js         下载并缓存图片供 LLM 内联请求使用
    video-sites.js         视频站点匹配、URL 缓存键、yt-dlp/ffmpeg 参数
    fetch-video.js         下载、探测和裁剪视频供视频描述器使用
  web/
    readable.js            HTML 转文本，付费墙检测
    fetch-page.js          SSRF 防护的页面抓取器
    brave.js               Brave Search 客户端
    lookup.js              链接阅读和网络搜索
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
    youtube-check.js       YouTube 时长探测和 API 密钥检查
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
