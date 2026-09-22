# 所有者命令

频道、身份组和用户从 Discord 自带的选择器中选取；`set`/`unset` 和 `access grant`/`access revoke` 会自动补全其 `path`/`command` 选项。机器人不读取私信。

`/nep` 从一开始就对所有成员可见；访问权限在命令执行时按命令逐一检查，不通过 Discord 自身的命令可见性控制。所有者（`bot.owners`）始终可以运行所有命令。其他人需要授权：`/nep access grant <command> [role] [user]` 可开放一个命令键（如 `memory.show`）、一个完整组（如 `memory`）或所有命令（`*`）给所有人（不指定身份组/用户）、某个身份组或某个用户；`/nep access revoke` 撤销授权；`/nep access list` 显示当前授权。没有授权的非所有者运行 `/nep` 会收到一条仅自己可见的 “Not allowed” 回复。

| 命令 | 说明 |
|---|---|
| `/nep status` | 模型、校准、配额和每服务器记忆状态 |
| `/nep reload` | 立即重新加载配置和提示 |
| `/nep ping [role]` | 向一个或所有模型角色（`talk`、`analyzer`、`media`、`followup`）发送最小请求并报告模型、延迟、provider、token 或错误；不计入 `llm.maxRequestsPerDay`，在暂停或预热期间均可使用 |
| `/nep pause` | 停止所有活动，将记忆刷入磁盘并卸载；暂停期间可安全编辑 `data/` |
| `/nep resume` | 从 `data/` 重新加载记忆并继续；如有 JSON 文件无法解析则拒绝并指出问题文件 |
| `/nep poke [mode] [channel]` | 强制触发一次自发动作 |
| `/nep set <path> <value>` | 覆盖配置值（写入 `config.local.json`） |
| `/nep unset <path>` | 移除配置覆盖 |
| `/nep rule add <text>` | 向 `prompts.local/rules.md` 追加规则 |
| `/nep rule list` | 列出编号的规则 |
| `/nep rule remove <number>` | 按编号移除规则 |
| `/nep model show` | 显示每个角色（`talk`、`analyzer`、`media`、`followup`）的当前模型 |
| `/nep model set <role> <id>` | 设置某个角色（`talk`、`analyzer`、`media`、`followup`）的模型 |
| `/nep memory show <user> [section] [limit] [order]` | 不指定 section：紧凑摘要。可选 section：`character`、`style`、`relationship`、`affinity`、`aliases`、`interests`、`details`、`episodes`、`raw`（存储的 JSON）。列表 section 接受 `limit` 1..100（默认 25）和 `order`：`rank`（默认，在可见性截止处有分隔线）或 `recent`。存储的成员引用解析为当前名称，`raw` 除外 |
| `/nep memory channel [channel]` | 指定频道：完整的存储笔记（用途、话题、氛围、消息数、活跃度、最活跃作者）。不指定：角色已知的所有频道表格，按最后消息排序 |
| `/nep memory server` | 服务器级笔记：人们如何交流、对话如何开始、内部梗、自述事实，以及档案、频道和世界书条目的计数 |
| `/nep memory refresh <user>` | 强制刷新成员画像 |
| `/nep memory forget <user>` | 删除存储的档案 |
| `/nep memory affinity <user> [score] [reason]` | 查看或设置态度（-100..100） |
| `/nep memory alias-add <user> <name>` | 添加聊天别名；立即确认 |
| `/nep memory alias-remove <user> <name>` | 移除聊天别名 |
| `/nep memory wipe <confirm>` | 清除该服务器的所有分析器记忆；输入准确的服务器名称以确认 |
| `/nep lore add <title> <keys> <text> [always]` | 添加或覆盖世界书条目；同标题的条目会被替换并变为所有者拥有，分析器不再编辑 |
| `/nep lore list [query]` | 列出世界书条目 |
| `/nep lore show <id>` | 显示世界书条目 |
| `/nep lore remove <id>` | 移除世界书条目 |
| `/nep warmup run` | 启动或恢复完整运行：频道、人物、服务器 |
| `/nep warmup users [member]` | 指定成员：为该成员生成或重新生成档案；不指定：为所有符合条件的成员重新生成 |
| `/nep warmup channels [channel]` | 指定频道：描述或重新描述该频道；不指定：所有可读频道 |
| `/nep warmup server` | 立即重建服务器笔记和世界书 |
| `/nep warmup people` | 列出符合条件的成员 |
| `/nep warmup status` | 显示预热进度和 token 使用量 |
| `/nep warmup stop` | 立即终止所有预热工作；进行中的请求被取消，进度保留以便 `run` 恢复 |
| `/nep warmup reset` | 清除预热进度，不清除已存储的记忆 |
| `/nep access grant <command> [role] [user]` | 将命令、命令组或 `*` 开放给所有人（默认）、某个身份组或某个用户 |
| `/nep access revoke <command> [role] [user]` | 从所有人（默认）、某个身份组或某个用户撤销授权 |
| `/nep access list` | 列出所有当前访问授权 |
