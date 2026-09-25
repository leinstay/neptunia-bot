# 媒体

角色能看到、听到和阅读什么，以及实现这些功能的辅助工具。

对话记录行在括号中携带媒体标记：图片、GIF、视频、贴纸、自定义表情、语音消息、音频文件、链接、文本文件预览和转发消息。角色实际感知到什么取决于以下功能开关。用户消息中的 `<senses>` 块告知角色在当前配置下什么是开启的、什么是关闭的；角色信任此块的内容，不会声称看到、听到或打开了超出其描述的任何东西。

## 图片

`features.vision` 将呼叫消息、被回复消息以及频道中最新的几张图片作为图像附加到 LLM 请求中，通过 Discord 的媒体代理缩小。机器人自行下载每张图片并以内联数据发送，因为 Discord 拒绝来自模型提供商的下载请求。超过 `context.vision.maxBytes` 或下载时间超过 `context.vision.fetchTimeoutMs` 的图片会被跳过。角色直接看到这些图片。

`features.mediaDescriptions`（默认开启）运行 `classifier.media` 模型为图片、GIF 帧、视频封面、贴纸、自定义表情和链接缩略图生成单行描述。每个附件只描述一次并缓存在 `data/guilds/<id>/media.json` 中。描述提供给对话记录、记忆分析器和预热。描述器的提示是 `prompts/describe.md`。

贴纸和自定义表情经常重复出现，因此按 id 缓存，首次描述后几乎没有开销。启用 `features.vision` 时，呼叫消息的贴纸会作为图片附加。Discord 内置的动态贴纸是 Lottie 动画而非图片，因此只能显示名称。

设置：直接视觉位于 `context.vision.*`，描述器位于 `media.*`。每个键请参阅[配置](configuration.md#media)。

## 视频

`features.videoDescriptions` 默认关闭；在 `config.local.json` 中开启，并同时开启 `mediaDescriptions`。开启后会添加 `classifier.video` 模型，可观看短视频片段：Discord 视频附件和已知视频站点的链接（YouTube、TikTok、VK、X、Reddit、Twitch）。模型必须通过 OpenRouter 同时接受视频和音频输入。

### 限制

附件和下载的站点视频受 `media.video.maxSeconds`（默认 60 秒）和 `media.video.maxBytes` 限制（超限的文件先重编码为 360p；仅重编码后仍超限的片段才被拒绝）。agentic 模式（`urlProcessing`，默认）下，公开 URL 视频（YouTube 及其他 `directUrlSites`）在 `directUrlMaxSeconds`（默认 3600 秒，一小时）以内时通过 URL 发送给固定的提供商；其他模式下有效上限为此值与 `maxRequestTokens / tokensPerSecond`（默认值下为 200 秒）中较小者。超长视频走下载路径（通过 yt-dlp 取前 `maxSeconds`），但 YouTube 在服务器上经常以 bot 验证阻止下载。每回合最多 `maxPerTurn` 个新视频（每次尝试都计数，无论成功与否），每天最多 `maxPerDay` 个。结果与图片描述一起缓存；重复发布不产生额外开销。

### 工具

超出限制的所有内容通过 `yt-dlp` 下载并使用 `ffmpeg` 裁剪，两者均为可选的系统二进制文件。没有它们时，在限制内的附件仍然可用（直接发送）。更长的附件和所有站点链接会回退到静帧。对于 YouTube，当 `yt-dlp` 无法探测时长时，`.env` 中的可选 `YOUTUBE_API_KEY`（免费，Google Cloud 控制台，YouTube Data API v3）或观看页面抓取可以提供时长信息。`/nep ping classifier.video` 报告 API key 状态。

### 重看

当有人对角色提出关于已观看视频的问题时，分类器（`prompts/rewatch.md`，使用 `classifier.text` 角色）判断是否需要再看一遍。如果需要，视频模型使用 `prompts/rewatch-answer.md` 再次观看片段，回答与原始摘要一起出现在对话记录中。当有人再次询问未能加载的视频时，同一分类器也可以重试加载。每回合最多一次重看或重试；回答缓存一小时。开关 `features.videoRewatch`（默认开启）。

视频提示是 `prompts/describe-video.md`。设置位于 `media.video` 下。每个键和模型对比表请参阅[配置](configuration.md#mediavideo)。

## 链接

`features.webLookup`（默认关闭；与其他功能不同，缺失的键视为关闭）允许角色打开聊天中发布的链接并阅读它们。

当功能开启且 `web.links.enabled` 不为 false 时，对话记录中的链接（仅 http/https，拒绝私有地址，排除视频站点链接，排除 `web.links.skipSites`）会通过 SSRF 防护的页面抓取器获取（大小限制 `web.links.maxBytes`，超时 `web.links.fetchTimeoutMs`，最多 3 次重定向，仅 html 和纯文本）。页面文本通过 `classifier.text` 模型经由 `prompts/read-link.md` 浓缩为不超过 `web.links.summaryChars` 字符的摘要。摘要以 `transcript.linkRead` 追加到链接的对话记录标签之后，显示为第一手信息：角色自己打开并阅读了页面，在该摘要的范围内。无法阅读的页面（付费墙、同意屏幕、登录门控、空内容）会被检测并缓存为未命中。URL 路径以图片、视频、音频或压缩文件扩展名（png、jpg、jpeg、gif、webp、avif、svg、mp4、webm、mov、mkv、mp3、ogg、wav、zip、rar、7z、pdf）结尾的链接不论主机一律不读取，`web.links.skipSites`（含子域名）默认排除 Discord CDN、Tenor、Giphy、Klipy、Imgur、Reddit 媒体和 Twitter 图片。

当 `web.links.prefill` 开启时（默认如此），链接在到达时立即被阅读，以便下次回合时已有缓存。预读按每个成员每天 `web.links.prefillPerUserPerDay`（默认 10）个限制；回合路径不受此限制。回合期间每次抓取尝试计入 `web.links.maxPerTurn`（默认 2）。链接阅读和搜索共享一个每日计数器，上限为 `web.maxPerDay`（默认 60）。

阅读结果缓存在媒体缓存中：`read:<link.id>` 保存摘要或未命中记录（跳过 6 小时）。当功能开启时，`<senses>` 块包含 `senses.linksRead`，告知角色链接可能附带阅读摘要。

## 搜索

当角色被呼叫且触发消息提出了需要聊天之外事实的问题时，分类器（`prompts/lookup.md`，使用 `classifier.text` 角色）生成一个网络搜索查询。搜索通过 Brave Search 运行（`.env` 中的 `BRAVE_SEARCH_API_KEY`；免费层：每月 2,000 次查询，之后每 1,000 次 $5），编号的结果通过 `prompts/search-summary.md` 浓缩，答案出现在 `<chat>` 之前的 `<lookup>` 块中。

分类器仅在以下条件全部满足时触发：存在触发消息、`features.webLookup` 开启、`web.search.enabled` 不为 false、`lookup.md` 提示文件存在、`web.search.maxPerTurn` 至少为 1、且已配置 `BRAVE_SEARCH_API_KEY`。没有密钥时，链接阅读仍然可用但搜索不可用。

每回合最多一次搜索；分类器和浓缩器各自计入 `llm.maxRequestsPerDay`。结果按规范化查询缓存 `web.search.cacheHours`（默认 24）小时。`<senses>` 块仅在配置了 Brave 密钥时包含 `senses.search`。

设置位于 `web` 下。每个键请参阅[配置](configuration.md#web)。提示文件与代码之间的契约在[提示契约](prompt-contract.md)中。

## 盲区

语音消息只显示时长。音频文件显示名称和时长。角色无法听到任何一种。如何处理盲区由角色卡决定。

## 成本

每个回合是一次 LLM 请求；记忆更新再增加一次。视频描述为每个观看的片段向 `classifier.video` 模型发送一次请求（`media.video.maxPerDay` 限制每日数量）；`yt-dlp` 和 `ffmpeg` 在本地运行，除带宽外不产生费用。链接阅读和搜索向 `classifier.text` 模型发送请求，受 `web.maxPerDay`（共享）和 `llm.maxRequestsPerDay`（全局）限制。搜索还需要 Brave Search 密钥；免费层可以处理低流量的服务器。

## 隐私

启用 `features.webLookup` 后，机器人会发出出站 HTTP 请求以读取页面和访问 Brave Search API。页面直接从主机获取；私有地址（回环、链路本地、私有网段）会被拒绝。页面内容通过 LLM 端点发送给 `classifier.text` 模型进行浓缩；页面文本和搜索查询均不会被记录到日志中。`data/` 在你的机器上保存缓存的摘要和搜索结果，已加入 gitignore，仅作为上下文发送给 LLM。
