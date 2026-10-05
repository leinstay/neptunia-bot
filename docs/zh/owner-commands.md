# 命令

频道、身份组和用户从 Discord 自带的选择器中选取；`set`/`unset` 和 `access grant`/`access revoke` 会自动补全其 `path`/`command` 选项。

`/nep` 从一开始就对所有成员可见；访问权限在命令执行时按命令逐一检查，不通过 Discord 自身的命令可见性控制。所有者（`bot.owners`）始终可以运行所有命令。其他人需要授权：`/nep access grant <command> [role] [user]` 可开放一个命令键（如 `memory.show`）、一个完整组（如 `memory`）或所有命令（`*`）给所有人（不指定身份组/用户）、某个身份组或某个用户；`/nep access revoke` 撤销授权；`/nep access list` 显示当前授权。没有授权的非所有者运行 `/nep` 会收到一条仅自己可见的 “Not allowed” 回复。`private.show`、`private.forget` 和 `private.purge` 仅限所有者使用，不可通过任何授权方式开放；`access grant` 会拒绝它们，`access list` 也不会显示。`mentor` 和 `access` 组同样仅限所有者使用，不可授权。

| 命令 | 说明 |
|---|---|
| `/nep status` | 模型、校准、配额（今日午夜后的 LLM 请求数、图片计数和图像模型、GIF 观看数、已刷新画像数）、每服务器记忆状态（档案、缓冲区、下次自发）、语音队列大小和今日语音请求数（两阶段开启时）、多样性过程（开关、手法数和时间）、私聊开关和私有文件数 |
| `/nep reload` | 立即重新加载配置和提示 |
| `/nep ping [role]` | 向一个或所有模型角色（`talk`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`）发送最小请求，遵循每个角色的 `llm.providerByModel` 路由，并报告模型、延迟、provider、token 或错误；`classifier.video` 之后报告 `youtube: API key — {status}`（如 `ok`、`not needed (yt-dlp ok)`、`missing (blocked)`）；`classifier.text` 之后报告 `web: API key — {status}`（`ok`、`missing` 或 `off`）。`role:image` 检查 `image.model` 是否在 provider 的公开模型列表中且支持图片输出（一次免费 GET，不进行生成）；检查通过不代表生成一定成功。不指定 role 时 image 检查排在最后。不计入 `llm.maxRequestsPerDay`，在暂停或预热期间均可使用 |
| `/nep pause` | 停止所有活动，将记忆刷入磁盘并卸载；进行中的 mentor 运行会被停止，其报告在刷盘前发布。暂停期间可安全编辑 `data/` |
| `/nep resume` | 从 `data/` 重新加载记忆并继续；如有 JSON 文件无法解析则拒绝并指出问题文件 |
| `/nep interject [channel]` | 立即插入该频道的当前对话 |
| `/nep initiate [channel]` | 立即在该频道中发起话题 |
| `/nep draw <text> [self]` | 通过绘画提示绘制一张图片。仅回复给你（ephemeral 附带图片）。消耗 `image.maxPerDay` 的余额但不计入成员配额。暂停时拒绝。不依赖 `features.imageGeneration` |
| `/nep set <path> <value>` | 覆盖配置值（写入 `config.local.json`）。`bot.owners` 和 `bot.access` 下的路径即使对被授予 `set` 权限的成员也仅限所有者。值必须与当前值的 JSON 类型一致，路径必须指向叶节点 |
| `/nep unset <path>` | 移除配置覆盖。与 `set` 相同的所有者和叶节点限制 |
| `/nep rule add <text>` | 向 `prompts.local/rules.md` 追加规则 |
| `/nep rule list` | 列出编号的规则 |
| `/nep rule remove <number>` | 按编号移除规则 |
| `/nep model show` | 显示每个角色（`talk`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`、`voice`）的当前模型 |
| `/nep model set <role> <id>` | 设置某个角色（`talk`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`、`voice`）的模型。`voice` 角色写入 `memory.voiceModel` |
| `/nep route list` | 列出 `llm.providerByModel` 中的所有路由，然后是每个角色的当前模型及其适用的路由。访问键 `route.list`（只读） |
| `/nep route set <model> <providers> [role] [fallbacks]` | 将模型前缀路由到指定的 provider。`model` 为模型 id 或前缀（如 `google/`，不含 `@` 或空格）。`providers` 为逗号分隔的 provider slug 列表（如 `google-vertex`；小写字母、数字和连字符）。`role` 限制路由到一个角色（默认：任意）。`fallbacks` 在这些 provider 不可用时允许其他 provider（默认：false）。将 `{ "only": [...], "allow_fallbacks": ... }` 写入 `config.local.json` 的 `llm.providerByModel` 下并重新加载。访问键 `route.set` |
| `/nep route remove <model> [role]` | 移除一条路由。键必须存在于 `config.local.json`；仅存在于 `config.json` 中的键无法通过此方式移除。访问键 `route.remove` |
| `/nep memory show <user> [section] [limit] [order]` | 不指定 section：紧凑摘要。可选 section：`character`、`style`、`relationship`、`affinity`、`aliases`、`interests`、`details`、`episodes`、`raw`（存储的 JSON）。列表 section 接受 `limit` 1..100（默认 25）和 `order`：`rank`（默认，在可见性截止处有分隔线）或 `recent`。存储的成员引用解析为当前名称，`raw` 除外 |
| `/nep memory channel [channel]` | 指定频道：完整的存储笔记（用途、话题、氛围、消息数、活跃度、最活跃作者）。不指定：角色已知的所有频道表格，按最后消息排序 |
| `/nep memory server` | 服务器级笔记：人们如何交流、对话如何开始、内部梗、自述事实，以及档案、频道和世界书条目的计数 |
| `/nep memory recent` | 显示服务器的实时近期记事行：当前 `memory.recentHours` 窗口内的记事，从新到旧，附带 id、时间、频道和权重 |
| `/nep memory refresh <user>` | 强制刷新成员画像。token 限制下调整采样量。计入 `memory.portraitRefreshPerDay`。当该成员有排队的角色文本语音条目（`voice-pending`）时，回复会说明并拒绝，除非强制刷新 |
| `/nep memory forget <user>` | 删除存储的档案、私有记忆和排队的语音条目（包括该成员教授的课程）。等待正在运行的分析器批次完成后再执行 |
| `/nep memory affinity <user> [score] [reason]` | 查看或设置态度（-100..100） |
| `/nep memory wipe <confirm>` | 清除该服务器的所有分析器记忆；输入准确的服务器名称以确认。删除项：成员档案及其私有记忆、服务器习惯（模式、开场白、内部梗）、所学条目、语音队列、近期记事、表情排名、多样性历史、频道地图、分析器世界书、预热进度。保留项：所有者世界书条目、媒体描述缓存、GIF 库、token 校准、每日计数器、自发时间表。等待正在运行的分析器批次完成后再执行 |
| `/nep private show <user>` | 显示成员的私有记忆：关系、兴趣、细节、回忆、私有和有效好感度、今日回复数。无私有层则为普通回答。仅限所有者；不可授权 |
| `/nep private forget <user>` | 仅删除成员的私有记忆；公共档案保留。等待正在运行的分析器批次完成后再执行。仅限所有者；不可授权 |
| `/nep private purge <user>` | 删除机器人在与成员的私信对话中发送的消息（扫描最多 `private.purgeMaxMessages` 条），然后删除该成员的私有记忆。成员自己的消息保留。暂停时拒绝。仅限所有者；不可授权 |
| `/nep alias add <user> <name>` | 添加聊天别名；立即确认 |
| `/nep alias remove <user> <name>` | 移除聊天别名 |
| `/nep learned list` | 列出所学内容（含 ID、教授者、观察次数） |
| `/nep learned add <text>` | 手动添加所学内容（无教授者，已确认） |
| `/nep learned remove <id>` | 删除一条所学内容 |
| `/nep lore add <title> <keys> <text> [always]` | 添加或覆盖世界书条目；同标题的条目会被替换并变为所有者拥有，分析器不再编辑 |
| `/nep lore list [query]` | 列出世界书条目 |
| `/nep lore show <id>` | 显示世界书条目 |
| `/nep lore remove <id>` | 移除世界书条目 |
| `/nep gifs status` | 显示 GIF 库：大小，按排名前 10（含 handle、计数和说明或名称），历史回填时间，今日已发送 / `gifs.maxPerDay`，今日已观看 / `media.gif.maxPerDay`，以及 `captions:`（库条目中已观看 / 单帧 / 观看失败 / 无说明各多少） |
| `/nep gifs rescan` | 将使用计数归零并从频道历史重新统计；条目和 handle 保留，未找到的条目保留零计数直到被大小上限淘汰 |
| `/nep gifs recache` | 删除库外的单帧 GIF 说明，然后在后台对最多 `gifs.recachePerRun` 个库 GIF 进行观看式重新描述。立即回复；通过 `/nep gifs status` 跟踪进度。暂停、预热期间或 GIF 未被观看时拒绝 |
| `/nep warmup run` | 启动或恢复完整运行：频道、人物、服务器 |
| `/nep warmup users [member]` | 指定成员：为该成员生成或重新生成档案；不指定：为所有符合条件的成员重新生成 |
| `/nep warmup channels [channel]` | 指定频道：描述或重新描述该频道；不指定：所有可读频道 |
| `/nep warmup server` | 立即重建服务器笔记和世界书 |
| `/nep warmup people` | 列出符合条件的成员 |
| `/nep warmup status` | 显示预热进度和 token 使用量 |
| `/nep warmup stop` | 立即终止所有预热工作；进行中的请求被取消，进度保留以便 `run` 恢复 |
| `/nep warmup reset` | 清除预热进度，不清除已存储的记忆 |
| `/nep mentor add message:<link or id> text:<comment>` | 添加案例：一条你拒绝的角色消息，加上一句说明问题所在。两个参数均必填。消息必须是角色的；指向其他服务器的链接、私信、机器人无法读取的频道、已删除的回复目标以及非角色的消息均被拒绝 |
| `/nep mentor anchor id:<case> message:<link or id>` | 向现有案例添加另一个 moment。与 `add` 相同的拒绝条件，另加：未知案例、已退役案例、非 reply 案例、重复的消息、历史为空或以角色消息结尾的 moment，以及超过 `mentor.anchor.max` 个 moment |
| `/nep mentor cases` | 列出案例：id、状态（`new`、`passing`、`failing`）、目标、上次分数、moment 数量（如有）、文本截至 80 字符 |
| `/nep mentor remove <id>` | 移除案例 |
| `/nep mentor run <id>` | 为一个案例运行完整周期。立即回复已启动。有管理频道（`bot.dryRunChannelId`）时报告发布到该频道；没有时回复指向 `/nep mentor status` 和 `/nep mentor show <id>` |
| `/nep mentor check` | 重放每个有过运行记录的活跃案例的已存储场景，每个场景 `mentor.check.samples` 个样本（真实 moment 使用 `mentor.anchor.samples`）。有管理频道时发布一份合并报告；没有时回复指向 `/nep mentor status` 和 `/nep mentor show <id>` |
| `/nep mentor stop` | 取消进行中的运行，包括正在进行的模型调用 |
| `/nep mentor show <id>` | 上次运行的报告：场景、回答、分数、评论、以及诊断（如有） |
| `/nep mentor wrong <id> <reason>` | 告知 mentor 对该案例判断有误以及原因；作为反例保存供未来评分 |
| `/nep mentor status` | 模型、是否启用、今日 token 使用量/上限、各状态的案例数、进行中的运行（停止待处理时显示 `, stopping`），以及最近完成的运行（`last:`）：案例、结果、overall 中位数、已评分回答数、token 数和完成时间 |
| `/nep variety` | 多样性过程：最新短列表含示例，长过程的列表含其行数，然后是从新到旧的历史过程。只读，可通过权限授予 |
| `/nep access grant <command> [role] [user]` | 将命令、命令组或 `*` 开放给所有人（默认）、某个身份组或某个用户。`private.*`、`mentor.*` 和 `access.*` 被排除；见上文 |
| `/nep access revoke <command> [role] [user]` | 从所有人（默认）、某个身份组或某个用户撤销授权 |
| `/nep access list` | 列出所有当前访问授权 |
