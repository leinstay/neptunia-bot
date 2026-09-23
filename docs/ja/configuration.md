# 設定

`config.json` の全キーとデフォルト値をセクション別に記載します。

## `features`

| キー | デフォルト | 説明 |
|---|---|---|
| `dryRun` | `false` | フルパイプラインを実行するが送信しない（[ドライラン](README.md#ドライラン)を参照） |
| `mentions` | `true` | @メンションに反応 |
| `replies` | `true` | リプライに反応 |
| `nameTriggers` | `true` | メッセージ中の名前トリガーに反応 |
| `spontaneous` | `true` | ランダムタイマーによる自発的メッセージ |
| `eavesdrop` | `true` | どのメッセージにも割り込みうるランダムな確率 |
| `memory` | `true` | プロファイル構築、サーバーパターン追跡、自己言及の記録 |
| `relationships` | `true` | メンバーごとの態度スコア（-100..100） |
| `episodes` | `true` | メンバーごとの長期記憶（出来事、引用、恨み） |
| `lore` | `true` | サーバー全体のロアブック |
| `reactions` | `true` | 絵文字リアクション |
| `multiMessage` | `true` | 2〜3 件の連続メッセージを許可 |
| `vision` | `true` | 添付画像を処理 |
| `mediaDescriptions` | `true` | 画像、GIF、動画フレーム、リンクサムネイルの一行説明文 |
| `videoDescriptions` | `false` | 動画対応モデルで短い動画クリップを視聴。`mediaDescriptions` も有効にする必要がある。`config.local.json` で有効化。動画対応モデルが必要で、サイトリンクには `yt-dlp`/`ffmpeg` も必要 |
| `videoRewatch` | `true` | 話しかけられた時に動画を再視聴して質問に回答。`videoDescriptions` が必要 |
| `webLookup` | `false` | チャットに投稿されたリンクを読み取り、事実に関する質問にウェブ検索で回答。他の機能と異なり、キーが存在しない場合はオフとして扱われる。検索には `.env` に `BRAVE_SEARCH_API_KEY` が必要。キーがない場合はリンク読み取りのみ動作する。[メディア: リンクと検索](media.md#リンク-ページの読み取り)を参照 |
| `followUp` | `true` | ペルソナの応答後、タグなしメッセージを分類して会話を継続 |
| `typingSimulation` | `true` | タイピング速度をシミュレート |
| `adminCommands` | `true` | オーナースラッシュコマンド。`false` でコマンド登録を解除 |

## `bot`

| キー | デフォルト | 説明 |
|---|---|---|
| `timezone` | `"UTC"` | モデルのタイムスタンプに使うタイムゾーン |
| `owners` | `[]` | オーナーコマンド用のユーザー ID |
| `commandName` | `"nep"` | スラッシュコマンド名（小文字 `a-z 0-9 _ -`、最大 32 文字。変更時に再登録） |
| `nameTriggers` | `[]` | @メンション以外の追加トリガー文字列 |
| `guildId` | `""` | ロックするサーバー。一つだけに参加している場合は自動検出 |
| `dryRunChannelId` | `""` | ドライランミラー用チャンネル（[ドライラン](README.md#ドライラン)を参照） |
| `channels.allow` | `[]` | 許可チャンネル（空 = 表示可能なすべて） |
| `channels.deny` | `[]` | 無視するチャンネル |
| `access` | `{}` | オーナー以外がどのコマンドを実行できるか（`/nep access` で管理） |

## `llm`

| キー | デフォルト | 説明 |
|---|---|---|
| `baseUrl` | `"https://openrouter.ai/api/v1"` | チャットコンプリーションのエンドポイント |
| `model` | `"anthropic/claude-opus-4.6"` | モデル ID |
| `temperature` | `1` | サンプリング温度 |
| `maxOutputTokens` | `700` | 最大出力トークン数 |
| `maxRequestTokens` | `50000` | リクエストあたりのハードトークン上限 |
| `safetyMargin` | `0.9` | `maxRequestTokens` のバジェット比率 |
| `timeoutMs` | `300000` | リクエストタイムアウト（ミリ秒） |
| `pingTimeoutMs` | `30000` | `/nep ping` リクエストのタイムアウト（ミリ秒） |
| `retries` | `2` | 一時的な障害時のリトライ回数 |
| `maxRequestsPerDay` | `300` | 1 日あたりのリクエスト上限 |
| `provider` | `null` | OpenRouter の `provider` ルーティングオブジェクト（そのまま渡される）。`null` の場合は送信しない |

`llm.provider` はすべてのリクエストで OpenRouter のプロバイダールーティングフィールドを設定します。例: `{ "ignore": ["some-provider"] }` や `{ "order": ["anthropic"], "allow_fallbacks": true }`。OpenRouter アカウント自体が許可プロバイダーを制限している場合、唯一残ったプロバイダーを除外するとすべてのリクエストが "No endpoints found" で失敗します。プロバイダー設定を変更した後は `/nep ping` を実行してすべてのモデルロールが到達可能か確認してください。

## `classifier`

3 つのヘルパーモデルロールを 1 つのキーにまとめています。それぞれ独立して設定できるため、ペルソナの声にはプレミアムモデルを使い、ヘルパーには安価なモデルを使うことができます。

| キー | デフォルト | 説明 |
|---|---|---|
| `text` | `"anthropic/claude-sonnet-4.6"` | テキスト分類器: アドレス分類器（`features.followUp`）、再視聴分類器（`features.videoRewatch`）、検索分類器（`features.webLookup`）。リンク読み取りと検索結果の要約も行う |
| `media` | `"anthropic/claude-haiku-4.5"` | 画像説明モデル（`features.mediaDescriptions`）: 画像、GIF フレーム、動画ポスター、スティッカー、カスタム絵文字、リンクサムネイルの一行説明文 |
| `video` | `"google/gemini-3.8-flash"` | 動画説明モデル（`features.videoDescriptions`）: 短いクリップの視聴、質問に対する再視聴、リクエストに応じたリトライ。動画と音声の両方の入力を受け付ける必要がある |

**旧キーからの移行。** 非推奨のキー `llm.classifierModel`、`mention.followUpModel`、`media.model`、`media.video.model` は読み取られなくなりました。これらのいずれかが `config.local.json` に存在する場合、ボットは起動時に警告をログに記録し（`config: deprecated model key ignored`）、キー名とその置き換え先を示します。値を `classifier.text`、`classifier.media`、`classifier.video` にそれぞれ移行してください。

## `context`

| キー | デフォルト | 説明 |
|---|---|---|
| `channelMessages` | `100` | 現在のチャンネルのメッセージ数 |
| `neighborMessages` | `5` | 隣接チャンネルあたりのメッセージ数 |
| `neighborMaxAgeMinutes` | `60` | 隣接メッセージの最大経過時間（分） |
| `neighborMaxChannels` | `8` | 隣接チャンネルの最大数 |
| `maxMessageChars` | `800` | この文字数を超えるメッセージを切り詰め（文字） |
| `gapMarkerMinutes` | `20` | タイムギャップマーカーの閾値（分） |
| `otherProfiles` | `6` | 表示する他のプロファイルの最大数 |
| `askedAboutProfiles` | `3` | 最近のメッセージで言及されたメンバーを他の参加者より先にフル表示する最大数 |
| `tempo.liveMessages10min` | `4` | 10 分間のメッセージ数がこの値で「ライブ」 |
| `tempo.deadSilenceMinutes` | `45` | この分数の沈黙で「デッド」 |
| `caps.interlocutor` | `6000` | トークン上限: 発話者のプロファイル（エピソード含む） |
| `caps.aboutChat` | `2500` | トークン上限: サーバーの傾向 / 自己言及 |
| `caps.lore` | `1500` | トークン上限: ロアブックエントリ |
| `caps.people` | `9000` | トークン上限: 他のプロファイル |
| `caps.neighbors` | `3000` | トークン上限: 隣接チャンネル |
| `caps.server` | `4000` | トークン上限: チャンネルマップ |
| `channelActivity.liveMessagesPerDay` | `20` | 1 日あたりのメッセージ数がこの値で「アクティブ」チャンネル |
| `channelActivity.deadAfterDays` | `7` | メッセージがないまま経過した日数で「デッド」チャンネル |
| `vision.maxImages` | `4` | リクエストあたりの最大画像数 |
| `vision.tokensPerImage` | `400` | 画像あたりのトークンバジェット |
| `vision.imageSize` | `512` | Discord のメディアプロキシによるダウンスケール目標（px） |
| `vision.recentImages` | `3` | 含める最近のチャンネル画像数 |
| `vision.recentImageMinutes` | `30` | 最近の画像の最大経過時間（分） |
| `vision.maxBytes` | `1500000` | 画像ファイルの最大サイズ（バイト）。超過した画像はスキップ |
| `vision.fetchTimeoutMs` | `10000` | 画像あたりのダウンロードタイムアウト（ミリ秒） |

## `media`

メディア説明モデル（`features.mediaDescriptions`）の設定です。説明モデルは `classifier.media` です。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxOutputTokens` | `120` | 説明文あたりの最大出力トークン数 |
| `imageSize` | `512` | ダウンスケール目標（px） |
| `maxPerTurn` | `6` | ターンあたりの最大説明文生成数 |
| `cacheEntries` | `5000` | 添付ファイルをキーとする説明文キャッシュサイズ |
| `filePreviewChars` | `500` | テキストファイル冒頭から表示する文字数 |
| `embedTextChars` | `200` | リンクの埋め込みテキストから表示する文字数 |

### `media.video`

動画説明モデル（`features.videoDescriptions`）の設定です。動画ビジョンは `features.mediaDescriptions` と `features.videoDescriptions` の両方が有効である必要があります。動画モデルは `classifier.video` です。動画対応の別モデルが短いクリップを視聴します。対象は Discord の動画添付ファイルと `media.video.sites` に含まれるサイトへのリンクです。結果は画像の説明文と同じメディアキャッシュに保存されるため、再投稿のコストはかかりません。

| キー | デフォルト | 説明 |
|---|---|---|
| `provider` | `{ "order": ["google-ai-studio"], "allow_fallbacks": false }` | ダイレクト URL パス（上限内の YouTube）用の OpenRouter プロバイダールーティング。`null` の場合は `llm.provider` を使用 |
| `maxOutputTokens` | `800` | 動画サマリーあたりの最大出力トークン数 |
| `summaryChars` | `1500` | 動画説明の最大文字数。`describe-video.md` の `{{maxChars}}` に使用 |
| `maxRequestTokens` | `60000` | 動画リクエストあたりのトークン上限（入力 + 出力）、`llm.maxRequestTokens` の代わりに使用。3 分のクリップを `tokensPerSecond` で換算すると約 54 000 トークンとなり、デフォルトのグローバル上限を超える |
| `maxSeconds` | `60` | 添付ファイルとダウンロードしたサイト動画のクリップの最大長（秒）。超過する添付ファイルは `ffmpeg` でトリムされ、超過するサイト動画は静止フレームにフォールバック。ダイレクト URL サイトには `directUrlMaxSeconds` が適用される |
| `directUrlMaxSeconds` | `180` | 公開 URL でプロバイダーに送信する動画の最大長（秒）。YouTube およびその他の `directUrlSites` が対象。超過する動画はダウンロード＋クリップルート（上限 `maxSeconds`）へ移行 |
| `maxBytes` | `8000000` | 添付ファイルの最大サイズ（バイト）。トリム後も超過する場合は永続ミス |
| `maxPerTurn` | `1` | ターンあたりの最大新規動画数。成否を問わずすべてのフェッチ試行がカウントされる |
| `maxPerDay` | `40` | 1 日あたりの動画リクエスト上限（`state.json` に `videoDay`/`videoCount` として保存） |
| `tokensPerSecond` | `300` | バジェットチェック用の動画 1 秒あたりのトークン推定値 |
| `timeoutMs` | `90000` | 動画用の LLM リクエストタイムアウト（ミリ秒） |
| `toolTimeoutMs` | `60000` | `yt-dlp` と `ffmpeg` サブプロセスのタイムアウト（ミリ秒） |
| `sites` | `["youtube.com", "youtu.be", "tiktok.com", "vk.com", "vkvideo.ru", "x.com", "twitter.com", "reddit.com", "twitch.tv"]` | 動画として扱うリンクのホスト名 |
| `directUrlSites` | `["youtube.com", "youtu.be"]` | 公開 URL を直接プロバイダーに渡せるサイト（プロバイダーが動画を取得） |
| `directUrlUnknownDuration` | `false` | プローブで再生時間を特定できなかった場合でも directUrlSites のリンクをプロバイダーに送信する。トークン推定は `maxSeconds` を使用。下記の再生時間チェーンを参照 |
| `canaryUrl` | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | 起動時と `/nep ping video` でプローブされる固定の YouTube 動画。このホストでどの再生時間ソースが動作するかを確認する |
| `ytdlpPath` | `"yt-dlp"` | `yt-dlp` バイナリのパス。サイト動画リンクと再生時間のプローブに必要 |
| `ffmpegPath` | `"ffmpeg"` | `ffmpeg` のパス。長い、またはサイズの大きい添付ファイルのトリムとダウンスケールに必要 |
| `errorRetryMinutes` | `60` | エラーキャッシュされた動画が自動リトライされるまでの分数。再視聴分類器からの強制リトライはこの値を無視する |
| `urlProcessing` | `"agentic"` | 公開 URL 動画パーツに送信される OpenRouter の処理モード。これがないと一部のプロバイダーは 1 フレームしか見ない。`null` でフィールドを省略 |
| `reasoning` | `{ "effort": "low" }` | すべての動画リクエストに使用する OpenRouter `reasoning` 設定。推論が出力バジェットを消費するのを防ぐ。非オブジェクトでフィールドを省略 |
| `prefill` | `true` | 動画が届いた時点で視聴し、次のターンでキャッシュ済みの状態にする |

`yt-dlp` と `ffmpeg` はどちらもオプションのシステムバイナリです。これらがなくても上限内の添付ファイルはそのまま動作します（そのまま送信されます）。長い添付ファイルとすべてのサイトリンクは静止フレームまたはプレビュー画像にフォールバックし、ペルソナには理由が伝えられます。すべての動画リクエストは `llm.maxRequestsPerDay` と動画トークン上限（`maxRequestTokens`）にカウントされます。

YouTube リンクの再生時間は次の順序で取得されます: まず yt-dlp、次に YouTube Data API（`.env` に `YOUTUBE_API_KEY` が設定されている場合）、最後にウォッチページのスクレイプ。すべてのプローブが失敗し `directUrlUnknownDuration` がオフ（デフォルト）の場合、リンクは「読み込めませんでした」と報告されます。スイッチがオンの場合、URL はそのままプロバイダーに送信され、トークン推定では `maxSeconds` として計上されます。Data API キーは無料です: Google Cloud コンソールで YouTube Data API v3 を有効にしてキーを作成します。無料枠は 1 日 10,000 ユニット、再生時間のルックアップ 1 回は 1 ユニットです。`/nep ping video` は `canaryUrl` をプローブし、このホストでどのソースが動作するかを報告します。キャッシュされた長さ制限の結果は動画の再生時間を記録し、上限が引き上げられたときに再試行されます。

### `media.video.rewatch`

再視聴分類器（`features.videoRewatch`）の設定です。ペルソナに話しかけられた時に直近のトランスクリプトに視聴済み動画がある場合、安価な分類器がメッセージがそれらの動画について質問しているかを判定します。ヒットすると動画モデルがクリップを再度視聴し、回答がトランスクリプトに追加されます。分類器は `classifier.text` を使用します。再視聴は常に `classifier.video` を使用します。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxPerDay` | `20` | 1 日あたりの再視聴上限（`media.video.maxPerDay` とは別） |
| `maxOutputTokens` | `600` | 再視聴回答の最大出力トークン数 |
| `answerChars` | `1200` | 回答の最大文字数。`rewatch-answer.md` の `{{maxChars}}` に使用 |
| `recentMessages` | `60` | 視聴済みまたはエラー状態の動画をスキャンする直近のメッセージ数 |
| `maxCandidates` | `6` | 直近ウィンドウから分類器に渡す最大動画数（新しい順） |
| `contextMessages` | `50` | 分類器に `<transcript>` ブロックとして渡す直近のチャンネルメッセージ数（トリガーを除く）。`0` でブロック省略 |

ターンあたり最大 1 回の再視聴またはリトライ。回答は質問ごとに 1 時間キャッシュされます。分類器と再視聴はそれぞれ `llm.maxRequestsPerDay` にカウントされます。再視聴は `media.video.maxPerDay` にもカウントされます。

## `mention`

| キー | デフォルト | 説明 |
|---|---|---|
| `ignoreChance` | `0` | ベースの無視確率。上げるとペルソナが一部のピングをスキップ |
| `emptyMentionIgnoreChance` | `0` | 素の @メンションの無視確率。上げるとペルソナが一部をスキップ |
| `repeatWindowMinutes` | `10` | リピート追跡ウィンドウ（分） |
| `repeatPenalty` | `0` | リピートごとに加算される無視確率。上げるとリピートにペナルティ |
| `spamThreshold` | `50` | ウィンドウ内でスパムとみなす呼び出し回数 |
| `spamIgnoreChance` | `0.9` | スパム時の無視確率 |
| `nameTriggerChance` | `1` | 名前トリガーへの応答確率 |
| `neverIgnore` | `[]` | 無視しないユーザー ID |
| `affinityIgnoreBonus` | `0` | 態度 -100 時に追加される最大無視率。上げると嫌いなメンバーがより無視される |
| `affinityLikeBonus` | `0.08` | 態度 +100 時に減少する最大無視率 |
| `oneAtATime` | `true` | サーバー全体で一度に一つのリプライ |
| `maxPending` | `3` | ビジー時に直接ピングを保持できるチャンネル数 |
| `pendingMinutes` | `10` | 保持されたピングが期限切れになるまでの分数 |
| `switchDelayMs` | `[2000, 9000]` | 次のチャンネルで応答する前の待機時間（ミリ秒） |
| `followUpMinutes` | `15` | ペルソナの最後のリプライ後のフォローアップウィンドウ（分） |
| `followUpContext` | `15` | 分類器に送信するトランスクリプト行数 |
| `followUpMaxOutputTokens` | `8` | 分類器の最大出力トークン数 |
| `followUpNoStreak` | `3` | ウィンドウを閉じる連続 `no` 判定回数 |

フォローアップウィンドウは `data/state.json` の `followUpWindows` に保存され、起動時に復元されます。期限切れのウィンドウは削除されます。

## `typing`

| キー | デフォルト | 説明 |
|---|---|---|
| `reactionDelayMs` | `[800, 4000]` | リアクション遅延の範囲（ミリ秒） |
| `msPerChar` | `[35, 75]` | 1 文字あたりのタイピング速度（ミリ秒） |
| `minMs` | `900` | タイピングの最短時間（ミリ秒） |
| `maxMs` | `12000` | タイピングの最長時間（ミリ秒） |
| `betweenMessagesMs` | `[700, 3500]` | メッセージ間のポーズ（ミリ秒） |

## `spontaneous`

| キー | デフォルト | 説明 |
|---|---|---|
| `channels` | `[]` | 許可チャンネル |
| `maxChannelSilenceHours` | `72` | 自発的メッセージをブロックするチャンネル沈黙時間（時間）。0 = 制限なし |
| `minIntervalMinutes` | `25` | 最小チェック間隔（分） |
| `maxIntervalMinutes` | `420` | 最大チェック間隔（分） |
| `burstChance` | `0.15` | バースト（続けてもう一言）の確率 |
| `burstMinutes` | `[3, 15]` | バーストのタイミング範囲（分） |
| `activeHours` | `{ from: 10, to: 3 }` | アクティブ時間帯（深夜をまたぐ） |
| `liveWindowMinutes` | `15` | ライブウィンドウ（分） |
| `liveMinMessages` | `4` | 「ライブ」判定に必要な最小メッセージ数 |
| `deadAfterMinutes` | `90` | 「デッド」判定までの沈黙時間（分） |
| `initiateChance` | `0.35` | 割り込みではなく話題を切り出す確率 |
| `eavesdropChance` | `0.02` | メッセージごとの割り込み確率 |
| `eavesdropDelayMs` | `[5000, 40000]` | 盗み聞き時の遅延範囲（ミリ秒） |
| `minGapMinutes` | `12` | アクション間の最小間隔（分） |

## `memory`

| キー | デフォルト | 説明 |
|---|---|---|
| `model` | `null` | アナライザーモデル（`null` = `llm.model`） |
| `mainChannelIds` | `[]` | メンバー同士が会話するチャンネル。キャラクターとスタイルのポートレートはここから作成される。空の場合はすべてのチャンネルが対象 |
| `portraitRefreshHours` | `24` | メンバーごとのポートレートリフレッシュの最小間隔（時間） |
| `portraitRefreshPerDay` | `20` | サーバーあたりのポートレートリフレッシュの 1 日最大数 |
| `batchMessages` | `60` | 理想的なバッチサイズ |
| `minBatchMessages` | `15` | 更新前の最小メッセージ数 |
| `maxBatchAgeMinutes` | `180` | この分数経過後に更新を強制（分） |
| `maxOutputTokens` | `20000` | アナライザーの最大出力トークン数 |
| `fieldChars` | `1000` | プロファイルフィールドの文字数上限（文字） |
| `clampTolerance` | `1.25` | アナライザーからのテキストがこの倍率まで上限を超過できる。超過分は文の境界または単語の境界で切り詰められ、メンバー参照の中では切らない |
| `maxDetails` | `15` | プロファイルごとにペルソナとアナライザーに表示される詳細項目数 |
| `maxDetailsStored` | `40` | プロファイルごとに保持される詳細項目数。頻度と新しさの上位が表示される |
| `maxInterests` | `12` | プロファイルごとにペルソナとアナライザーに表示される関心項目数 |
| `maxInterestsStored` | `40` | プロファイルごとに保持される関心項目数。頻度と新しさの上位が表示される |
| `interestTopicChars` | `40` | 関心トピックの最大文字数 |
| `interestNoteChars` | `120` | 関心ノートの最大文字数 |
| `confirmAfter` | `2` | 関心または詳細が確定するまでの目撃回数 |
| `confirmGapHours` | `12` | 新しい機会としてカウントするための目撃間隔（時間） |
| `interestStaleDays` | `90` | 目撃されないまま経過すると関心が古いとマークされる日数 |
| `interestHalfLifeDays` | `180` | 関心の重み半減期（日）。目撃されない項目の重みは半減期ごとに半減するため、新しい趣味が古い趣味を追い越せる |
| `detailHalfLifeDays` | `720` | 詳細の重み半減期（日） |
| `maxAliases` | `5` | プロファイルごとにペルソナとアナライザーに表示されるエイリアス数 |
| `maxAliasesStored` | `15` | プロファイルごとに保持されるエイリアス数。頻度と新しさの上位が表示される |
| `aliasHalfLifeDays` | `365` | エイリアスの重み半減期（日） |
| `maxInjokes` | `15` | サーバー内輪ネタの最大数 |
| `maxSelfFacts` | `20` | 自己言及の最大数 |
| `maxEpisodes` | `20` | メンバーごとに保持されるエピソードの最大数 |
| `maxNewEpisodes` | `3` | メンバーごと・バッチごとの新規エピソードの最大数 |
| `timeoutMs` | `900000` | アナライザーのタイムアウト（ミリ秒）。`llm.timeoutMs` とは別 |

アナライザープロンプトはこれらの上限をプレースホルダーとして読み取るため、値を上げると次のバッチから反映されます。プロファイルを大きくするとコンテキストトークン（`context.caps.people`、`context.caps.interlocutor`）とアナライザー出力（`memory.maxOutputTokens`）のコストが増加します。

## `relationships`

| キー | デフォルト | 説明 |
|---|---|---|
| `damping` | `true` | ゼロから離れる方向のスコア変化を減衰。ゼロに向かう変化はそのまま適用 |
| `dampingPower` | `1` | 減衰係数の指数。大きいほどスケールの両端に到達しにくくなる |
| `maxDeltaPerUpdate` | `15` | 更新あたりの最大スコア変化 |
| `historySize` | `10` | メンバーごとに保持される態度変化の履歴数 |
| `directTriggerCount` | `6` | 早期更新を強制する直接インタラクション回数 |

`damping` が有効な場合、ゼロから離れる方向のスコア変化は `(1 - |score| / 100) ^ dampingPower` でスケールされるため、極端な値には継続的な努力が必要です。ゼロに向かう変化はそのまま適用されます。スコアは小数精度で保存され、整数で表示されます。`/nep memory affinity` は減衰なしで直接設定します。

## `lore`

| キー | デフォルト | 説明 |
|---|---|---|
| `maxEntries` | `500` | サーバーあたりのロアブックエントリの最大数 |
| `scanMessages` | `30` | キーマッチのためにスキャンするメッセージ数 |
| `maxMatches` | `8` | リクエストあたりに表示されるエントリの最大数 |
| `textChars` | `600` | ロアブックエントリのテキスト上限（文字） |

## `web`

ウェブルックアップ（`features.webLookup`）の設定です。リンク読み取りと検索は日次カウンター（`web.maxPerDay`）を共有します。結果はメディアキャッシュ（`data/guilds/<id>/media.json`）に保存されます。すべてのモデル呼び出しは `classifier.text` ロールを使用します。

| キー | デフォルト | 説明 |
|---|---|---|
| `maxPerDay` | `60` | リンク読み取りと検索リクエストの合計に対する共有日次上限 |

### `web.links`

| キー | デフォルト | 説明 |
|---|---|---|
| `enabled` | `true` | チャットに投稿されたリンクを読み取り（http/https のみ、プライベートアドレスは拒否、動画サイトリンクは除外） |
| `prefill` | `true` | リンクが投稿された時点で読み取り、次のターンでキャッシュ済みの状態にする |
| `prefillPerUserPerDay` | `10` | プリフィルがメンバーあたり 1 日に到着時に読み取る最大リンク数。ターンパスはこの制限を受けない |
| `maxPerTurn` | `2` | ターンあたりの最大新規リンク読み取り数（各フェッチ試行がカウントされる） |
| `maxBytes` | `1500000` | ページの最大サイズ（バイト）。超過するとページを拒否 |
| `textChars` | `6000` | 要約モデルに送信するページテキストの最大文字数 |
| `summaryChars` | `700` | 要約抜粋の最大文字数。`read-link.md` の `{{maxChars}}` に使用 |
| `maxOutputTokens` | `300` | 要約モデルの最大出力トークン数 |
| `fetchTimeoutMs` | `10000` | ページあたりのダウンロードタイムアウト（ミリ秒） |
| `skipSites` | `[]` | リンクを読み取らないホスト名（動画サイトは常に除外されるため、それに追加） |

### `web.search`

| キー | デフォルト | 説明 |
|---|---|---|
| `enabled` | `true` | 分類器が発火した時に検索を実行。`.env` に `BRAVE_SEARCH_API_KEY` が必要 |
| `maxPerTurn` | `1` | ターンあたりの最大検索数 |
| `results` | `5` | Brave Search に要求する結果数 |
| `summaryChars` | `900` | 要約回答の最大文字数。`search-summary.md` の `{{maxChars}}` に使用 |
| `maxOutputTokens` | `400` | 要約モデルの最大出力トークン数 |
| `cacheHours` | `24` | キャッシュされた検索結果が再検索されるまでの時間 |
| `contextMessages` | `50` | 検索分類器に `<transcript>` として渡す直近のチャンネルメッセージ数 |
| `timeoutMs` | `10000` | Brave Search リクエストのタイムアウト（ミリ秒） |

## `warmup`

| キー | デフォルト | 説明 |
|---|---|---|
| `enabled` | `true` | 初回起動時にウォームアップを自動実行 |
| `lookbackDays` | `60` | サンプルする過去の日数 |
| `minMessages` | `30` | メンバーが対象となるための自身のメッセージの最低数 |
| `maxPeople` | `40` | 処理するメンバー数（アクティブ順） |
| `messagesPerPerson` | `2000` | メンバーあたりにサンプルする自身のメッセージ数 |
| `contextBefore` | `1` | サンプルメッセージごとの直前のコンテキスト行数 |
| `maxChannelShare` | `0.5` | 一つのチャンネルからのサンプルの最大割合 |
| `messagesPerChannel` | `200` | チャンネル記述に使う最新メッセージ数 |
| `serverSampleMessages` | `600` | サーバーリクエスト用のメインチャンネルの最新メッセージ数 |
| `refreshMessages` | `400` | ポートレートリフレッシュ時にサンプルするメッセージ数 |
| `fetchLimitPerChannel` | `15000` | サンプルプール用にチャンネルごとにフェッチするメッセージ数 |
| `maxOutputTokens` | `6000` | ウォームアップリクエストあたりの最大出力トークン数 |
| `maxRequestTokens` | `120000` | ウォームアップリクエストあたりの最大トークン数（入力 + 出力） |
| `maxTokens` | `6000000` | ラン全体のトークンバジェット |
| `rateLimitWaitMinutes` | `10` | レートリミット時の待機時間（分） |
| `rateLimitMaxWaits` | `36` | ランを中断する前の連続待機回数 |

## モデルの選択

エンジンは 5 つのモデルロールを使用します。それぞれ独立して設定できるため、ペルソナの声にはプレミアムモデルを使い、ヘルパーには安価なモデルを使うことができます。

### `llm.model` — ペルソナの声（`talk`）

バジェットが許す最も高性能なモデルを選びます。ロールプレイの品質、キャラクターの一貫性、自然な会話のすべてがこのモデルに依存します。小さなモデルはキャラクターが崩れ、コンテキストの手がかりを忘れ、平坦に聞こえます。

デフォルト: `anthropic/claude-opus-4.6`。より安価な選択肢: `anthropic/claude-sonnet-4.5`。

### `memory.model` — アナライザー（`analyzer`）

長いトランスクリプトを推論し、厳密な JSON を返します。ペルソナの声と同じティアの知性が必要です。`null`（デフォルト）はペルソナのモデルを使用します。同じ例が適用されます。

### `classifier.text` — テキスト分類器（`classifier.text`）

「yes」または「no」を確実に回答できる最も安価なテキストモデルです。アドレス分類器、再視聴分類器、検索分類器を実行し、リンク読み取りと検索結果の要約も行います。デフォルト: `anthropic/claude-sonnet-4.6`。

### `classifier.media` — 画像（`classifier.media`）

安価なビジョンモデルであれば何でも使えます。一行の説明文を書くだけなので、推論能力はほとんど問題になりません。

デフォルト: `anthropic/claude-haiku-4.5`。最も安価な代替: `google/gemini-2.5-flash-lite`。

### `classifier.video` — 音声付き動画（`classifier.video`）

OpenRouter を通じて動画と音声の両方の入力を受け付けるモデルのみがここで動作します。フレームは受け付けるが音声は受け付けないモデル（Qwen VL、GLM、Seed、Gemma）は音声を聞き取れず、重要な情報の大部分を逃します。

`google/gemini-flash-latest` は価格が予告なく変わる可能性のあるフローティングエイリアスです。バッチ（`:batch`）バリアントは非同期であり、ライブリプライには使用できません。ダイレクト URL パス（上限内の YouTube を `media.video.provider` で公開 URL として送信）には Google AI Studio をプロバイダーとして指定する必要があります。

1 分間のクリップあたりのコスト（USD）、2026-09-23 時点の OpenRouter 価格:

| モデル | 1 分クリップあたり約 USD |
|---|---|
| `google/gemini-2.5-flash-lite` | 0.002 |
| `google/gemini-3.1-flash-lite` | 0.005 |
| `google/gemini-3.5-flash-lite` | 0.006 |
| `google/gemini-3.7-flash` | 0.014 |
| `google/gemini-3.8-flash` (default) | 0.014 |

`qwen/qwen3.8-omni-flash` も動画と音声を受け付けます。価格は変動します。上の表は記載日時点のスナップショットです。
