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
| `eavesdrop` | `true` | 任意のメッセージに割り込むランダムチャンス |
| `memory` | `true` | プロファイル構築、サーバーパターン追跡、自己言及の記録 |
| `relationships` | `true` | メンバーごとの態度スコア（-100..100） |
| `episodes` | `true` | メンバーごとの長期記憶（出来事、引用、恨み） |
| `lore` | `true` | サーバー全体のロアブック |
| `reactions` | `true` | 絵文字リアクション |
| `multiMessage` | `true` | 2〜3 件の連続メッセージを許可 |
| `vision` | `true` | 添付画像を処理 |
| `mediaDescriptions` | `true` | 画像、GIF、動画フレーム、リンクサムネイルの一行説明文 |
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

メディアデスクライバー（`features.mediaDescriptions`）の設定です。

| キー | デフォルト | 説明 |
|---|---|---|
| `model` | `"anthropic/claude-haiku-4.5"` | デスクライバーモデル |
| `maxOutputTokens` | `120` | 説明文あたりの最大出力トークン数 |
| `imageSize` | `512` | ダウンスケール目標（px） |
| `maxPerTurn` | `6` | ターンあたりの最大説明文生成数 |
| `cacheEntries` | `5000` | 添付ファイルをキーとする説明文キャッシュサイズ |
| `filePreviewChars` | `500` | テキストファイル冒頭から表示する文字数 |
| `embedTextChars` | `200` | リンクの埋め込みテキストから表示する文字数 |

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
| `followUpMinutes` | `2` | ペルソナの最後のリプライ後のフォローアップウィンドウ（分） |
| `followUpContext` | `15` | 分類器に送信するトランスクリプト行数 |
| `followUpModel` | `null` | 分類器モデル（`null` = メディアモデル） |
| `followUpMaxOutputTokens` | `8` | 分類器の最大出力トークン数 |
| `followUpNoStreak` | `3` | ウィンドウを閉じる連続 `no` 判定回数 |

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
| `burstChance` | `0.15` | バースト追随の確率 |
| `burstMinutes` | `[3, 15]` | バーストのタイミング範囲（分） |
| `activeHours` | `{ from: 10, to: 3 }` | アクティブ時間帯（深夜をまたぐ） |
| `liveWindowMinutes` | `15` | ライブウィンドウ（分） |
| `liveMinMessages` | `4` | 「ライブ」判定に必要な最小メッセージ数 |
| `deadAfterMinutes` | `90` | 「デッド」判定までの沈黙時間（分） |
| `initiateChance` | `0.35` | 割り込みに対する話題切り出しの確率 |
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

`damping` が有効な場合、ゼロから離れる方向のスコア変化は `(1 - |score| / 100) ^ dampingPower` でスケールされるため、極端な値には継続的な努力が必要です。ゼロに向かう変化はフルの強度で適用されます。スコアは小数精度で保存され、整数で表示されます。`/nep memory affinity` は減衰なしで直接設定します。

## `lore`

| キー | デフォルト | 説明 |
|---|---|---|
| `maxEntries` | `500` | サーバーあたりのロアブックエントリの最大数 |
| `scanMessages` | `30` | キーマッチのためにスキャンするメッセージ数 |
| `maxMatches` | `8` | リクエストあたりに表示されるエントリの最大数 |
| `textChars` | `600` | ロアブックエントリのテキスト上限（文字） |

## `warmup`

| キー | デフォルト | 説明 |
|---|---|---|
| `enabled` | `true` | 初回起動時にウォームアップを自動実行 |
| `lookbackDays` | `60` | サンプルする過去の日数 |
| `minMessages` | `30` | メンバーが対象となるための自身のメッセージの最低数 |
| `maxPeople` | `40` | 処理するメンバー数（アクティブ順） |
| `messagesPerPerson` | `2000` | メンバーあたりにサンプルする自身のメッセージ数 |
| `contextBefore` | `1` | サンプルメッセージごとの前後コンテキスト行数 |
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
