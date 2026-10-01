# プロンプトコントラクト

プロンプトファイルとコード（`src/behavior/prompt.js`、`src/llm/parse.js`、`src/discord/format.js`、
`src/memory/update.js`、`src/memory/channels.js`、`src/memory/warmup.js`）が接するポイントです。一方を変更する場合、
もう一方も合わせてください。変更のワークフローについては `CONTRIBUTING.md` を参照してください。

## レイヤー

| ディレクトリ | 追跡対象 | 内容 |
|---|---|---|
| `prompts/` | はい | 英語のエンジンデフォルト + ニュートラルなサンプルキャラクター。そのまま動作します |
| `prompts.local/` | いいえ | デプロイ先のオーバーライド: 同名ファイルがデフォルトを置き換え、`labels.json` はディープマージ |

どちらもホットリロードされます。`/nep rule add` は `prompts.local/rules.md`（デフォルトからシードされる）に書き込み、`prompts/` には書き込みません。
すべてのインストラクションは両レイヤーとも英語です。キャラクターの発話サンプルはそのキャラクターが話す言語で記述できます。

## ファイル

| ファイル | 必須 | 役割 | プレースホルダー |
|---|---|---|---|
| `system-prompt.md` | はい | キャラクター非依存の、チャットメンバーとして振る舞うためのルール: 長さ、アンチ AI ルール、コンテキストの使い方、人に対する態度、境界線。カードが話し方において優先すると明示する | `{{name}}` |
| `character-card.md` | はい | パーソナリティ: 人物像、性格、話し方と言語、メタレイヤー、**ペルソナの好感を得るものと失うもの**（アナライザーが読み取る）、リファレンスライン。デプロイ時に書き換える唯一のファイル | `{{name}}` |
| `rules.md` | いいえ | オーナーのライブ修正、上の二つを上書きする。**最後の `## ` 見出しの下にある箇条書きリストで終わる必要がある。** コードが `- …` 行を追記する | `{{name}}` |
| `format.md` | はい | 出力プロトコル | なし |
| `reply.md` | はい | タスク: 誰かがペルソナに話しかけた | `{{name}}` `{{author}}` `{{trigger}}` `{{target}}` |
| `interject.md` / `initiate.md` | はい | タスク: 進行中の会話に割り込む / 静かなチャットで話題を切り出す | `{{name}}` |
| `forced.md` | いいえ | 強制ターン（`/nep interject`、`/nep initiate`）時にモードプロンプトの後に追加される。デフォルトの `<skip/>` を無効化する | `{{name}}` |
| `memory.md` | はい | ストリームアナライザーのアウトオブキャラクタープロンプト: ライブバッチからのメモリへの差分更新 | `{{name}}` `{{fieldChars}}` `{{guildFieldChars}}` `{{maxDetails}}` `{{maxInjokes}}` `{{maxSelfFacts}}` `{{maxNewEpisodes}}` `{{maxEpisodes}}` `{{maxDeltaPerUpdate}}` `{{maxInterests}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{loreTextChars}}` `{{maxLearned}}` `{{learnedChars}}` |
| `profile.md` | はい | ウォームアップ / ポートレートリフレッシュ: メッセージサンプルからメンバーのプロファイルを作成 | `{{name}}` `{{fieldChars}}` `{{maxInterests}}` `{{maxDetails}}` `{{interestTopicChars}}` `{{interestNoteChars}}` `{{maxNewEpisodes}}` |
| `channel.md` | はい | ウォームアップ: メッセージサンプルからチャンネルノートを作成 | `{{fieldChars}}` |
| `server.md` | はい | ウォームアップ: チャンネルノートとメンバーの要約からサーバーレベルのノートを作成 | `{{name}}` `{{fieldChars}}` `{{maxInjokes}}` `{{loreTextChars}}` |
| `describe.md` | はい | メディア説明モデルのアウトオブキャラクタープロンプト（`features.mediaDescriptions`）: 画像 1 枚を入力、チャットの言語でプレーンテキスト 1 行を出力: 写っているもの、判読可能なテキスト。意見なし、マークダウンなし | なし |
| `describe-video.md` | はい | 動画説明モデルのアウトオブキャラクタープロンプト（`features.videoDescriptions`）: 動画クリップ 1 本（音声付き）を入力、設定可能な長さの完全な説明を出力: 誰が登場するか、何が言われるか（重要なフレーズを引用）、画面上のテキスト、視覚的に何が起きるか、音楽/効果音。キャラクターカードなし | `{{maxChars}}` |
| `describe-gif.md` | いいえ | GIF 説明モデルのアウトオブキャラクタープロンプト（`media.gif.watch`）: 短い無音クリップを入力、1 行のコンパクトな説明を出力: アクション、表現する内容、可視テキスト。常に英語。キャラクターカードなし。ファイルがない場合は `describe-video.md` にフォールバック | `{{today}}` `{{maxChars}}` `{{seconds}}` |
| `rewatch.md` | はい | 分類器: ペルソナが動画を再視聴する必要があるか、または読み込めなかった動画をリトライする必要があるか（`features.videoRewatch`）。番号付きの最近の動画リストとステータス、および新しいメッセージを受け取る。出力は 1 行: `<number> \| <question>`、`<number> \| retry` または `none` | `{{name}}` |
| `rewatch-answer.md` | はい | 再視聴のアウトオブキャラクタープロンプト: 動画モデルがクリップを再度視聴し、1 つの質問に回答する。言語と制約のルールは `describe-video.md` と同じ。キャラクターカードなし | `{{question}}` `{{maxChars}}` |
| `address.md` | はい | 分類器: タグなしメッセージがペルソナ宛かどうか | `{{name}}` |
| `lookup.md` | いいえ | 分類器: ペルソナがこのメッセージに答えるためにウェブ検索が必要か（`features.webLookup`）。短いトランスクリプトと `<candidate>` ブロックを受け取る。出力は 1 行: 検索クエリ（プレーンワード、最大 12 語）または `none` | `{{name}}` |
| `read-link.md` | いいえ | リンク読み取りのアウトオブキャラクタープロンプト（`features.webLookup`、`web.links.enabled`）: フェッチしたページを 1 段落に要約する。ページのタイトルと本文を受け取る。キャラクターカードなし | `{{maxChars}}` |
| `search-summary.md` | いいえ | 検索要約のアウトオブキャラクタープロンプト（`features.webLookup`、`web.search.enabled`）: 番号付き検索結果をインラインソース付きの 1 つのノートに要約する。キャラクターカードなし | `{{query}}` `{{maxChars}}` |
| `private.md` | いいえ | モードプロンプト（`reply.md`）の後、`forced.md` の前に追加。DM（`features.privateMessages`）のみ。プライベートな会話: ここで話されたことはここに留まる。ペルソナは公開知識を保持する。ファイルがなければ何も追加されない | `{{name}}` `{{author}}` |
| `draw.md` | はい | 描画サブプロセスのアウトオブキャラクタープロンプト（`features.imageGeneration`）: シーン説明から画像 1 枚を生成する。外見とリクエストのみを受け取り、キャラクターカードは受け取らない | `{{name}}` `{{appearance}}` `{{request}}` |
| `appearance.md` | いいえ | ペルソナのビジュアル外見。`self="yes"` 時に `draw.md` に挿入される。パーソナリティやバックストーリーなし、1 段落 | `{{name}}` |
| `mentor-situations.md` | いいえ | Mentor: reply ターゲットケースのテスト状況を作成（`features.mentor`）。JSON のみを返す | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-situations-memory.md` | いいえ | Mentor: memory ターゲットケースのテスト状況を作成（`features.mentor`）。JSON のみを返す | `{{name}}` `{{count}}` `{{minLines}}` `{{maxLines}}` |
| `mentor-score.md` | いいえ | Mentor: ペルソナの回答をスコアリング（`features.mentor`）。キャラクターカードを受け取る。JSON のみを返す | `{{name}}` |
| `mentor-score-memory.md` | いいえ | Mentor: アナライザーが保存するテキストをスコアリング（`features.mentor`）。キャラクターカードなし。`character` 軸は常に `null`。JSON のみを返す | `{{name}}` |
| `mentor-signs.md` | いいえ | Mentor: モデル文の既知の癖。すべての mentor リクエストで `<signs>` ブロックとして送信（`features.mentor`）。ファイルがないか空の場合は省略 | `{{name}}` |
| `mentor-diagnose.md` | いいえ | Mentor: スコアリング後に弱い回答の原因をペルソナのコンテキスト内の具体的なテキストで説明（`features.mentor`）。結果は未検証の仮説としてランの `diagnosis` に保存。`mentor.diagnose` が false またはファイルがない場合は省略 | `{{name}}` |
| `variety.md` | いいえ | `classifier.text` リクエスト: ペルソナの最近のメッセージで繰り返されている表現手法を特定（`features.variety`）。キャラクターカードなし | `{{name}}` `{{maxPatterns}}` `{{shapeChars}}` |
| `labels.json` | はい | コードがプロンプトに挿入するすべての文字列。キーは以下で固定、値はライターが記述する | 以下参照 |

`{{name}}` ボットの表示名 · `{{author}}` 発話者の表示名 · `{{trigger}}` `labels.triggers.*` のいずれか ·
`{{target}}` 呼び出しメッセージのインデックス（`#87`）。
システムメッセージ = `system-prompt` + `character-card` + `rules` + `format`。アナライザーの場合: `memory.md` のみ。
強制ターン（`/nep interject`、`/nep initiate`）では、`forced.md` が存在する場合、モードプロンプトの後に追加されます。
プライベートチャットでは、`private.md` がモードプロンプトの後（`forced.md` の前）に同じ `{{name}}` と `{{author}}` プレースホルダーで追加されます。
アナライザーとウォームアップの `profile.md` および `server.md` はキャラクターカードと `rules.md` をユーザーメッセージ内の
`<character>` ブロックとして受け取ります。`channel.md`、`describe.md`、`describe-video.md`、`describe-gif.md`、`draw.md`、`rewatch.md`、`rewatch-answer.md`、`address.md`、`lookup.md`、`read-link.md`、`search-summary.md`、`variety.md` はカードを受け取りません。

`{{guildFieldChars}}` は `fieldChars * 2` で、コードがギルドレベルのパターンとスターターをクランプする上限です。
`{{maxEpisodes}}` はメンバーごとに保持されるエピソードの総数です。どちらも config から設定されますが、デフォルトプロンプトでは
使用されません。カスタムの `memory.md` が参照する場合があります。

## ブロック

ユーザーメッセージのブロックです。空のものは省略され、順序は以下の通りです。

| ブロック | 内容 |
|---|---|
| `<now>` | 日付、曜日、`config.bot.timezone` の時刻。`labels.locale` でフォーマット |
| `<senses>` | ペルソナが今この瞬間に何を知覚でき何を知覚できないか。ライブ設定から生成: どの画像をペルソナ自身が見て、どれがヘルパーの説明文として届き、何が見えず聞こえないか。動画を見たと偽ることなく、自分の声でネタにできるようにする |
| `<about_chat>` | 人々がここでどう話すか、会話の始め方と割り込み方、内輪ネタ、人々がペルソナに教えたこと |
| `<server>` | 現在のチャンネルの詳細（Discord カテゴリとトピック、目的、投稿内容、トーン、アクティビティ、最新メッセージ、トップライター。`labels.server.currentMark` でマーク）に加え、このターンで `<other_channels>` に供給した隣接チャンネルのみ。他のチャンネルは含まない |
| `<lore>` | 直近のメッセージにキーが出現するサーバーのロアブックエントリ（常時表示マーク付きのエントリも含む）: イベント、繰り返し登場するキャラクター、長期にわたるストーリー。ロアブックのように数百エントリが存在できるが、該当する少数だけが表示される |
| `<self_facts>` | ペルソナが自身について主張した内容 |
| `<people>` | メンバープロファイル。発話者が先頭で `labels.profile.interlocutorMark` でマーク。各メンバーにペルソナの態度を付し、発話者には**エピソード**も含む: ペルソナが二人の間で記憶している出来事（日付と短い引用付き） |
| `<other_channels>` | 隣接チャンネルごとに最大 `context.neighborMessages` 件のメッセージ。`context.neighborMaxAgeMinutes` より古いものは含まない |
| `<worn>` | ペルソナが最近のメッセージで使い回している表現手法（`features.variety`）: `labels.variety.intro`、続いて手法ごとに `- <shape> ("<example>", ...)`。パスが実行されなかった、何も検出しなかった、またはスイッチがオフの場合は省略 |
| `<lookup>` | ペルソナがこのターンでオンラインで調べた内容（`features.webLookup`）: クエリ、要約された回答、ソースサイト、または「何も見つからなかった」行。検索分類器が発火し検索が完了した場合にのみ表示される |
| `<chat>` | 現在のチャンネルの最新 `context.channelMessages` 件のメッセージ |
| `<tempo>` | 10 分 / 1 時間 / 1 日のカウント、参加人数、沈黙時間、判定（live / slow / dead） |
| `<task>` | `reply` / `interject` / `initiate`、プレースホルダー補完済み |

バジェットの優先順位（このリストの下からセクションがトリムされる）: system + task + clock + tempo + senses
（カットされない）→ 発話者のプロファイル（エピソード付き）→ lookup（全体として保持または削除）→ about_chat → self_facts → lore → server → chat（新しい順）→
他のプロファイル → worn（全体として保持または削除）→ other channels → 絵文字（下からエントリを削除、次にブロック全体; `context.caps.emoji`）→ GIF（同じトリム; `context.caps.gifs`）。

トランスクリプト行のメディア（利用可能な最も情報量の多い形式）: このリクエストに添付された画像 →
`transcript.imageAttached`（画像がテキストの後に並ぶ順にナンバリング）、説明済み →
`imageDescribed` / `gifDescribed` / `videoDescribed`、それ以外はブラインド形式 `image` / `gif` / `video`。
動画ビジョンが有効な場合（`features.mediaDescriptions` かつ `features.videoDescriptions`）、動画または動画サイトのリンクは
状態を持ちます: `videoWatched`（一次情報、映像と音声を視聴済み）、`videoNotWatchedFrame`（未視聴だが静止フレームの説明あり）、
`videoNotWatched`（未視聴、フレームなし）。理由コード（`length` / `size` / `daily` / `error`）はトランスクリプトに届く前に
`transcript.videoReason.*` の人間向けフレーズに置換されます。リンクはベースタグ（`link` / `linkText`）を維持し、動画のエクストラ
（`linkWatched`、`linkNotWatchedFrame`、`linkNotWatched`）を追加します。静止フレームが画像として添付されている場合、
`frameAttached` も追加されます。リンクは Discord の埋め込みから構築された `link` / `linkText`（サイト、タイトル、スニペット）を
使用。`features.webLookup` が有効でリンクが読み取られた場合、リンクの他のエクストラ（動画、サムネイル）の後に `linkRead` が追加されます。テキストファイルは冒頭を `filePreview` で表示。転送されたメッセージは `forwarded` でラップ。`features.seeReactions` が有効（デフォルト）の場合、リアクションタグがメディアタグおよび転送ラッパーの後、行の末尾に追加されます。1 メッセージあたり最大 `context.reactionsPerMessage` 件のリアクションが頻度降順で表示されます。各項目は `transcript.reactionItem` または `transcript.reactionMine`（ペルソナがリアクションした場合）を使用し、", " で結合され `transcript.reactions` でラップされます。`transcript.reactions` キーのないラベルファイルでは何も表示されません。

動画の結果は添付ファイルごとまたはリンクごとに `data/guilds/<id>/media.json` にキー
`video:<itemId>`（添付ファイル ID、またはリンク URL の安定ハッシュ）で保存されます。キャッシュエントリ:

- 視聴済み: `{ text, ts, watched: true }`: 永続、サマリーテキスト。
- リミットミス（length または size）: `{ miss: true, ts, reason: "length"|"size" }`: 永続、ファイルは変化しない。
- エラーミス: `{ miss: true, ts, reason: "error" }`: `media.video.errorRetryMinutes`（デフォルト 60）分後にリトライ、または再視聴分類器からの強制リトライで即時リトライ。
- デイリーリミット: キャッシュされない。そのターンのみ `{ state: "limit", reason: "daily" }` として返される。

再視聴の回答はキー `video:<itemId>:q:<hash>`（小文字化・空白正規化した質問の SHA-1 の先頭 16 桁の十六進数）で保存されます: `{ text, ts, answer: true }`。1 時間で期限切れ。コードは読み取り時に期限切れのエントリを削除します。

画像の静止フレームエントリは従来通り独自の `<itemId>` キーを保持します。同一アイテムに対して両方が共存できます。

視聴された GIF は GIF 自身の `<itemId>` キー（`video:` プレフィックスなし）でキャッシュされます: `{ text, ts, watched: true, gif: true }`。単一フレームのキャプションは `{ text, ts, gif: true }`（視聴を試みて失敗した場合は `watchFailed` 付き）で保存されます。どちらも画像の記述と同じキャッシュ内に配置されます。

ウェブルックアップの結果も同じ `data/guilds/<id>/media.json` に動画や画像のエントリと並んでキャッシュされます:

- リンク読み取り: `read:<link.id>` は `{ text, ts }`（要約抜粋、永続）または `{ miss, ts, reason }`（6 時間スキップされるミス。理由: `scheme`、`private`、`redirects`、`type`、`size`、`timeout`、`http`、`network`、`empty`、`unreadable`、`llm`）を保持します。`TokenLimitError` や `DailyCapError` はキャッシュされません。
- 検索: `search:<正規化クエリの SHA-1 プレフィックス、16 桁の十六進数>` は `{ query, text, sources, ts }` を保持し、`web.search.cacheHours`（デフォルト 24）時間以内であれば提供されます。空の `text` は結果なし（`labels.lookup.none` を描画）を意味します。失敗はキャッシュされません。

トランスクリプト行: `#87 [14:32] nick: text <replyTo> <media…> <sticker> <reactions>`。自分の行には `labels.self` を使用。
行間に `labels.transcript.gap` / `gapWithDate` / `date`。ブロック冒頭に `labels.transcript.header`。隣接チャンネル:
`#n` なしの同じ行形式、`# channel-name` の下に配置。

## ラベル

`labels.json` のキー。`{x}` はコードが挿入します。

```
locale                                   BCP-47 tag for dates
ping.prompt                              the whole user message of `/nep ping`; must make any model answer one short word
self                                     {name}
units.lessThanMinute | minute | hour | day
transcript.gap                           {duration}
transcript.gapWithDate                   {duration} {date}
transcript.date | header                 {date}
transcript.empty | replyToOld | image
transcript.replyTo                       {index}
transcript.file | sticker                {name}
transcript.stickerDescribed              {name} {text}
transcript.emojiDescribed                {name} {text}: appended to a line for a custom emoji; text keeps :name:
transcript.imageAttached                 {n}: this picture is attached to the request, the persona sees it
transcript.imageDescribed                {text}
transcript.gif                           {name}
transcript.gifDescribed                  {text}
transcript.video                         {name} {duration}
transcript.videoDescribed                {name} {duration} {text}: text describes ONE frame
transcript.videoWatched                  {name} {duration} {text}: first-hand, the persona saw and heard the clip
transcript.videoNotWatched               {name} {duration} {reason}: reason is the human phrase from videoReason.*
transcript.videoNotWatchedFrame          {name} {duration} {reason} {text}: not watched but a still frame was described
transcript.videoAnswered                {question} {text}: extra tag after a watched video tag; the persona re-watched the clip for this question
transcript.videoReason.length | size | daily | error    human phrases for the four reason codes
transcript.linkWatched                   {text}: extra tag after a link tag, first-hand video summary
transcript.linkNotWatched                {reason}: extra tag after a link tag, not watched with reason
transcript.linkNotWatchedFrame           {reason} {text}: extra tag after a link tag, not watched but preview described
transcript.voice                         {duration}
transcript.audio                         {name} {duration}
transcript.link                          {site} {title}
transcript.linkText                      {site} {title} {text}
transcript.linkRead                      {text}: extra tag after a link tag; the page was fetched and condensed, first-hand
transcript.thumbnailDescribed            {text}: follows a link tag; describes the link's preview picture
transcript.filePreview                   {name} {text}
transcript.forwarded                     {text}
transcript.forwardedFrom                 {channel} {text}: used when the source channel is known; falls back to `forwarded`
transcript.frameAttached                 {n}: follows a video/gif item whose still frame is attached picture n
transcript.reactions                     OPTIONAL {list}: appended at the end of a line after all media and forwarded tags; list is items joined with ", ". A labels file without this key renders nothing
transcript.reactionItem                  {emoji} {count}: one reaction; emoji is unicode or :name: for custom
transcript.reactionMine                  {emoji} {count}: used instead of reactionItem when the persona is among the reactors; reads correctly whether count is 1 or more
transcript.unknownDuration               shown in place of {duration} when Discord gave none
senses.imageSee | imageDescribed | imageBlind        one line each; code picks the ones true under the live config
senses.gifWatched | gifDescribed | gifBlind   gifWatched replaces gifDescribed when media.gif.watch is on (needs video vision on and a describe-gif or describe-video prompt); a labels file without gifWatched falls back to gifDescribed
senses.videoDescribed | videoBlind
senses.videoWatch                        replaces videoDescribed when features.videoDescriptions is on (needs mediaDescriptions too); covers watched, still frame and not-watched states
senses.videoRewatch                      shown alongside videoWatch when features.videoRewatch is on; tells the persona that a second look at a watched video may appear, marked as first-hand
senses.stickerSee | stickerDescribed | stickerBlind
senses.lottie
senses.voice | links | files
senses.linksWatch                        replaces links when features.videoDescriptions is on; adds that a linked video may come watched or not watched with the reason
senses.linksRead                         shown after the links line when features.webLookup is on and web.links.enabled is not false; tells the persona that a link may come with a read excerpt, first-hand
senses.search                            shown when features.webLookup is on, web.search.enabled is not false AND a Brave Search key is configured; tells the persona that a `<lookup>` block may appear with web results
senses.draw                              shown when features.imageGeneration is on and an image client is wired; tells the persona it can draw
senses.drawSpent                         replaces draw when the daily picture quota is spent
senses.drawSpentUser                     replaces draw when this member's daily quota is spent
senses.privateChat                       shown in a DM turn: this is a one-on-one conversation, what is said here stays between the two of them
senses.privateAware                      shown on a server turn when features.privateMessages is on: the persona knows it has private chats and never repeats or hints at anything from them
lookup.header                            {query}: heading of the `<lookup>` block
lookup.sources                           {list}: site names, comma-separated by code
lookup.none                              shown in `<lookup>` when the search found nothing useful
tempo.counts                             {last10min} {lastHour} {lastDay}
tempo.authors                            {authors}: a head count
tempo.silenceBeforeTrigger | lastMessageAgo | sinceOwn          {duration}
tempo.emptyChannel | ownUnanswered
tempo.verdict                            {verdict} = tempo.verdictLive | verdictSlow | verdictDead
profile.interlocutorMark                 appended to the caller's heading (starts with a space)
profile.formerNames                      {names}
profile.character | interests | style | details | relationship  {text}
profile.aliases                          {text}: what people in chat call this member (comma-separated by code)
profile.interestItem                     {topic} {note}: one interest with a note
profile.interestItemNoNote               {topic}
profile.unsureMark                       appended to an unconfirmed interest or detail (starts with a space, self-explanatory)
profile.staleMark                        appended to an interest not seen for memory.interestStaleDays (starts with a space)
profile.unknown
profile.messageCount                     {count}
profile.affinity                         {score} {band} {reason}
profile.episodes                         heading line above the caller's episodes
profile.episode                          {date} {what} {quote} {feeling}: one remembered moment
profile.episodeNoQuote                   {date} {what} {feeling}: the same without a quote
lore.entry                               {title} {text}
affinity.bands.hostile | dislike | cool | neutral | warm | fond | devoted
                                         thresholds in code: ≤-60 · ≤-25 · ≤-8 · <8 · <25 · <60 · ≥60
aboutChat.patterns | starters | injokes  {text}
aboutChat.learned                        {text}: things people taught the persona, joined by `; ` by code
aboutChat.learnedItem                    {text} {who}: one lesson with a teacher
aboutChat.learnedItemNoFrom              {text}: one lesson with no known teacher
aboutChat.unsureMark                     appended to an unconfirmed learned item (starts with a space)
server.currentMark                       appended to the current channel's heading (starts with a space)
server.category | topic | purpose | topics | tone               {text}
server.activity                          {activity} = server.activityLive | activitySlow | activityDead
server.lastMessage                       {when}: humanised age of the channel's newest message
server.topWriters                        {names}: current names of the members who write there most
triggers.mention | reply | name | followUp   followUp = an untagged message the address classifier judged to be for the persona; such a turn posts plain, never as a Discord reply
triggers.private                         the trigger for a private (DM) message
triggers.drawFailed                      {reason}: the drawing sub-process failed; reason is the human phrase from draw.reasons.*
draw.reasons.moderation | daily | userDaily | timeout | error    human phrases for the five failure reasons; daily and userDaily are reserved but no longer reached by triggers.drawFailed — an image cap now posts limits.notice instead of a follow-up turn
memory.privateNote                       the <private> block content in a private analyzer batch: marks the batch as a private conversation, constrains output to users for the partner's id only
memory.privateChannel                    heading used in place of a channel name for the <new_messages> section in a private batch
limits.notice                            {limit} {used} {cap}: posted as a plain reply when a rail refuses a triggered action; limit is the config key, used/cap are the numbers
warmup.ownMark                           prefixed to a member's own lines in the profile.md transcript
warmup.contextMark                       prefixed to context lines in the profile.md transcript
mentor.intended                          array of short strings: engine behaviours that must not cost points in the mentor's scoring
mentor.examples                          first line inside the `<examples>` block in a situations request: introduces the real moments
mentor.original                          first line inside the `<original>` block in a score request: introduces the persona's rejected answer
variety.intro                            first line of the `<worn>` block: tells the persona these devices are spent
```

## 出力

モデルの出力で処理されるのは以下のタグのみです:

- `<think>…</think>` 任意、先頭に配置、1–4 行の隠れた計画。閉じていない場合は沈黙を意味する。
- `<msg>text</msg>` チャットメッセージ 1 件、最大 3 件連続可能。`reply="#87"` で Discord リプライになる。
- `<react to="#87">💀</react>` Unicode 絵文字 1 つ。`<msg>` と単独でも併用でも可。
- `<draw self="yes" reply="#87">scene</draw>` 描画サブプロセスへの画像。ターンにつき 1 つ、最初の非空が優先、800 文字でクランプ。`self="yes"` でペルソナの外見が追加。`reply="#87"` は `<msg>` と同じ。`<msg>` や `<react>` と併用可。
- `<skip/>` 沈黙。
- `@nick` トランスクリプトと同一の表記が実際のメンションになる。

`features.reactions: false` は `<react>` を無効化、`features.multiMessage: false` は最初の `<msg>` のみを保持。
`features.imageGeneration: false` またはイメージクライアントなしの場合は `<draw>` を無効化。`drawFailed` ターンでも `<draw>` は無効化されます。プロンプトが知る必要はありません。

## アナライザー

1 回の呼び出し（`memory.md`）でペルソナが記憶するすべてを更新します。ペルソナの**目を通して**人々を判断するため、キャラクターカードを受け取ります。チャンネルが活発かどうかの判断はアナライザーの役割ではなく、コードがカウントします。ウォームアップは古い履歴をウォームアップ用プロンプト（`profile.md`、`channel.md`、`server.md`）を通じて供給し、アナライザーは通しません。

プロンプト内の数値制限はプレースホルダーで、ランタイムに `config.memory.*` と `relationships.maxDeltaPerUpdate` から設定されます。

入力: `<character>` · `<existing_profiles>`（ユーザー ID 別の JSON、現在の `affinity` スコアと理由、保存済みの
`episodes` を含む）· `<existing_lore>` ·
`<existing_guild>`（JSON: パターン、スターター、内輪ネタ、学んだ項目）· `<existing_channels>`（チャンネル ID 別の JSON: `name`、Discord の `category`、`topic`、保存済みの
`purpose`、`topics`、`tone`）· `<new_messages>` は `## #channel-name (id:123)` の下にグループ化、行形式は
`[14:32] nick (id:123): text`、ペルソナ宛の行は `→ ` で始まり、自分の行には `labels.self` を使用。

出力: 素の JSON オブジェクト。プロファイルは**差分更新**されます。アナライザーは変更だけを返し、保存済みの再要約は行わないため、バッチごとの書き換えで事実が劣化しません:

```
{
  "users": { "<userId>": {
      "portrait": "",                                                // OPTIONAL: one-line cue that the stored character/style misses something
      "relationship": "",                                            // OPTIONAL: present when first written or when it must change, then the whole new text
      "aliases": { "add": [""], "remove": [""] },
      "interests": { "add": [ { "topic": "", "note": "", "sure": false } ], "update": [ { "topic": "", "note": "" } ],
                     "seen": [ "topic" ], "remove": [ "topic" ] },
      "details":   { "add": [ { "text": "", "sure": false } ], "seen": [ 3 ], "remove": [ 3 ] },   // numbers = stored detail ids
                                                                                 // "sure" is OPTIONAL everywhere, default true
      "affinity":  { "delta": 0, "reason": "" },
      "episodes":  [ { "date": "YYYY-MM-DD", "what": "", "quote": "", "feeling": "", "weight": 3 } ] } },
  "guild": { "patterns": "", "starters": "", "injokes": [""],
             "learned": { "add": [{ "text": "", "from": "<@id>" }], "seen": [3], "remove": [3] } },
  "channels": { "<channelId>": { "purpose": "", "topics": "", "tone": "" } },
  "lore": [ { "title": "", "keys": [""], "text": "" } ],
  "self": [""]
}
```

- **関心はアトミックな項目であり**、散文ではありません。`topic`（≤ `{{interestTopicChars}}`、アイデンティティ、大文字小文字を無視して比較）と `note`（≤ `{{interestNoteChars}}`、具体的に何が。空でも可）。両方のプレースホルダーは他の制限と同様に `memory.interestTopicChars` / `memory.interestNoteChars` から設定されます。メンバーごとに最大 `memory.maxInterestsStored` 件保存され、アナライザーが再び追加または更新すると重みが増加します。ランク最下位から削除されます。入力には保存済みの項目が表示されるため、アナライザーは新しいものだけを追加し、ノートは新情報があるときだけ更新し、本人が明確にやめたものだけを削除します。
- **詳細もアトミックな項目です**: `{ id, text, weight, firstSeen, lastSeen }`。入力には保存済みの各詳細が数値 `id` 付きで表示されます。`seen` と `remove` はその id で詳細を参照します（コードは保存された正確なテキストも受け付けます）。`add` は `{ text, sure? }` を受け取ります（単純な文字列も受け付けます）。`memory.maxDetailsStored` を超えると、ランク最下位から削除されます。
- **学んだ項目はギルドレベルのアトミックな項目です**: `{ id, text, from, weight, firstSeen, lastSeen }`。`from` は教えたメンバー（`<@id>`、または空）を保持します。詳細と同じ `add` / `seen` / `remove` 操作、同じ確定メカニズム、同じランクと削除ルールを適用します。`memory.maxLearned` 件が表示され、`memory.maxLearnedStored` 件が保持され、`memory.learnedChars` が項目ごとの文字数上限です。チャットモデルには `<about_chat>` 内の内輪ネタの行の後にランク順で表示され、未確定のものは `labels.aboutChat.unsureMark` 付きで表示されます。
- **確定（「(?)」メカニズム）、関心、詳細、学んだ項目に共通。** `weight` はその事柄が観測された個別の機会をカウントします。新しい項目は重み 1 で始まりますが、アナライザーが `"sure": false` をマークした場合は 0 です（誰のものか不明確、本気かどうか不明確、またはアナライザーが認識しない名前）。`seen`（新情報はないが再び話題になった）、既存項目への `add`、`update` はそれぞれ 1 回の目撃としてカウントされます。目撃が重みを 1 上げるのは、そのバッチ内のその人のメッセージが項目の `lastSeen` から少なくとも `memory.confirmGapHours` 時間離れている場合のみです（長い会話がバッチ分割されても 1 回とカウント）。既存項目への `"sure": false` 付きの操作は何も変更しません。項目は重みが `memory.confirmAfter` 以上で**確定**されます。それまではチャットモデルに `labels.profile.unsureMark` 付きで表示されます。
- **表示されるよりも多くが保存され、ランクは時間とともに減衰します。** コードはメンバーごとに最大 `memory.maxInterestsStored` / `memory.maxDetailsStored` 件の項目を保持します。ペルソナとアナライザーはランク上位の `memory.maxInterests` / `memory.maxDetails` 件だけを見ます。ランク = `log2(weight + 0.5) + lastSeen / halfLife`（半減期は `memory.interestHalfLifeDays`、`memory.detailHalfLifeDays`）。つまり重みは沈黙の半減期ごとに半分になり、頻繁かつ最近のものが上位に来ます。新規項目は削除されずに表示されない末尾で重みを蓄積できます。削除はランク最下位から行います。アナライザーが保存済みだが表示されていない項目を `add` した場合、コードは目撃としてカウントします。そのため、プロンプトはアナライザーに対してリストが一杯に見えるからといって控えず、新しいと思うものは何でも追加するよう指示します。
- **日付はメッセージから取得し**、時計からではありません。`firstSeen` / `lastSeen` は、目撃を発生させたバッチ内のその人の最新メッセージの時刻です（min / max。履歴が順序通りでなくても正しく動作します）。`lastSeen` が `memory.interestStaleDays` より古い関心は、チャットモデルに `labels.profile.staleMark` 付きで表示され、新しいものの後にソートされます。詳細は古くなりません。
- 保存済み項目の入力ビュー: 関心 `{ topic, note, seen, last }`、詳細 `{ id, text, seen, last }`（`seen` = weight、`last` = `YYYY-MM-DD`、不明の場合は省略）。
- **帰属、すべてのプロファイルフィールドに適用。** ある人物について記録されるのは、その人物自身のメッセージからのみです。本人が話題にする、繰り返す、実質のある発言をする場合です。他人のトピックにその場にいた、または一度返信しただけでは、その人のものにはなりません。ノートにはそのトピックについて言われたことだけを含めます。どのトピックまたはどの人物に属するか不明確な場合は、記録しないか `"sure": false` でマークします。サーバーの全員がやっていることは `guild.patterns` や `lore` に属し、個々のプロファイルには書きません。
- **各散文フィールドの定義。** `character`: その人が他者とどう振る舞うか、具体的な繰り返される習慣を数個（4–7 個）、ペルソナの声で記述する（「ラベルより習慣」: 形容詞の羅列や評価は決してしない）。スキル、知識、仕事、趣味、一度限りの行動はキャラクターではありません。保存済みの形容詞/評価テキストはバッチから書き直し、パッチしません。`character`、`relationship`、態度の `reason`、エピソードの `feeling` はカードに基づくペルソナの声で書きます（一人称可、臨床的な語彙は不可）。`style`: その人がどう書くか（長さ、リズム、語彙、絵文字の使い方）であり、何をするか、何について話すかではありません。`relationship`: ペルソナとこの人がどういう関係にあるか。近況報告や他者との関係ではありません。保存済みテキストが空で、バッチでペルソナとこの人が実際にやり取りしている（または affinity/episodes がすでにある）場合に初回を書き、以降は変更が必要なときだけ返します。各フィールド ≤ `memory.fieldChars`；フィールドが省略された場合、保存済みのテキストは変更されません。`character` と `style` は `profile.md`（ウォームアップとポートレートリフレッシュ）のみが書き込み、ストリームアナライザーは直接編集しません。アナライザーはバッチがそれを必要とする場合に `portrait`（保存済みテキストが見落としている点を示す一行のヒント）を返し、コードがリフレッシュをキューに入れます。
- **メンバーはニックネームではなく ID で参照します。** ニックネームは頻繁に変わるため、アナライザーが書くすべての自由テキストフィールド（プロファイル散文、関心のノート、詳細のテキスト、エピソードの `what`/`feeling`、態度の reason、`guild` フィールド、チャンネルノート、ロアブックの `text`、`self`）でメンバーは `<@id>` トークンとして記述します（id はトランスクリプトの `nick (id:123)` または `<existing_profiles>` から取得）。アナライザーが誰のことか確信している場合のみ使用します。そうでない場合は名前をそのまま記述します。id を創作しません。逐語的な `quote` とロアブックの `keys`/`title` はそのまま残します。コードは使用時にトークンを解決します。チャットモデルには `<@id>` がメンバーの現在の名前（トランスクリプトに表示されるのと同じ文字列、`@name` も機能します）になり、アナライザーには `name (id:123)` になります。入力時にはモデルが書いた `name (id:123)` をコードがトークンに戻し、不明な id はそのまま残します。
- **エイリアス**は、チャットの中で人々が実際にメンバーを呼ぶ名前（短縮形や翻訳名などの安定したニックネーム）であり、Discord の表示名ではありません。`users.<id>.aliases: { "add": ["…"], "remove": ["…"] }`。関心と同様にランク付き項目として保存されます（`memory.maxAliases` 件表示、`memory.maxAliasesStored` 件保持、`memory.aliasHalfLifeDays`）。既知のエイリアスの `add` は目撃としてカウントされます。入力ビューではプレーンなリストとして表示され、チャットモデルには `labels.profile.aliases` `{text}` を通じて表示されます。現在の名前またはエイリアスが直近のトランスクリプトに出現するメンバーは、発言していなくても `<people>` に含まれます。トリガーまたは直近 5 件のメッセージで（メンション、現在の名前、エイリアス、4 文字以上の名前のプレフィックスマッチで）参照されたメンバーは、発話者の次にフル表示されます（最大 `context.askedAboutProfiles` 件）。その他の最近の参加者はコンパクト形式（名前、エイリアス、キャラクター、態度、トップ 5 トピック）で続きます。バジェットはコンパクトな方から先にトリムします。
- **メインチャンネルがポートレートの情報源です。** `memory.mainChannelIds`（デフォルト `[]`）は人々が互いに話すチャンネルをリストします。`<existing_channels>` でそのようなチャンネルは `"main": true` を持ちます（そうでない場合はキー省略）。`character` と `style` はメインチャンネルでその人が他者とどう話すかから判断します。日記やトピック特化チャンネルは関心と詳細を供給し、話し方は供給しません。その人のメインチャンネルメッセージがまだない間は、ポートレートは暫定的で短いものになります。その人のメインチャンネルメッセージを含むバッチでのポートレートリフレッシュは両フィールドを**洗練**します: 全体の新しいテキスト（≤ `memory.fieldChars`）を返し、まだ当てはまるものを引き継ぎ、バッチが示したものを追加し、新しい証拠が古いものより優先され、もう見られないものを削除します。こうしてポートレートは時間と共にその人を追いかけます。メインとマークされたチャンネルがない場合、すべてのチャンネルがメインとして扱われます。
- **サーバーレベルのノートはサーバーについてです。** ある人が自分のチャンネルでやっていることは `guild` のパターン、スターター、内輪ネタではなく、`lore` でもありません。内輪ネタは複数の人が使っているものです。
- **制限はモデルに対してはソフト、コード内ではクリーンです。** プロンプトは制限値 L（プレースホルダー、`{{loreTextChars}}` は `lore.textChars` から）を示します。コードは `L * memory.clampTolerance`（デフォルト 1.25）まで受け付け、それを超えた場合は最後の文または単語の境界で切り、`<@id>` トークンの途中では切らず、宙ぶらりんの開き括弧や末尾のセパレーターを除去します。途中で途切れた保存済みノートやテキスト（古いバージョンによるカット）は、その主題が次に話題になった際に全体を書き直します。
- **出力の簡潔さ。** `"sure"` は false のときだけ記述します。`affinity` は変更がないときは省略します。
- **ファクトの一元管理。** イベントは `episodes` か `lore` に、事実は `details` に、趣味は `interests` に、ペルソナへの教えは `learned` に入れます。同じことを複数のフィールドに書きません。
- **モデルの知識によるサニティチェック。** ある名前付きのものを別のものに紐付ける（地域、モード、キャラクター、アイテムをゲームに。人物をフランチャイズに）前に、アナライザーはそれらが実際に関連するか確認します。チャットの記述がモデルの知識と矛盾する場合、またはそのものを認識しない場合は紐付けず、そのものを単独で `"sure": false` として記録します。チャットの内容を「修正」することはしません。
- **ノートはその人がトピックについて何をしているかを記述します**（プレイしている、動画を見ている、言及しただけ）。その人がずっと前にやっていてやめたものは関心ではありません（せいぜい詳細）。周囲の会話なしには理解できないものは記録しません。
- 意図的に欠如: アイロニーやサーカズムに関するルール。あらゆる種類の不確実性は `"sure": false` で処理します。
- アナライザープロンプトは短く保ちます。ルールを追加するたびに、既存のテキストを引き締めて対価を支払います。
- 新しい内容があるユーザーとチャンネルのみ返します。返されたチャンネル / `guild` / `self` はマージ後の全体の値で、保存済みの値を置き換えます。空の `guild` / `self` = 新しい内容なし。
- `affinity` は変化量です: 整数の `delta`（通常 ±1…5、際立った出来事で最大 ±`relationships.maxDeltaPerUpdate`）と一行の `reason`（観測されたイベントを記述）。コードは ±`relationships.maxDeltaPerUpdate` にクランプし、−100…100 に累積し、短い履歴を保持します。モデルは絶対スコアを設定しません。
- `episodes` は追記のみで、書き直しません: 数か月間記憶に値する新しい瞬間だけを返します。侮辱、親切、約束、賭け、喧嘩、共有されたジョーク、ペルソナに何かを頼んだこと、または決してしないよう頼んだこと。`what` は 1 行。`quote` はその人自身の言葉を逐語的に、短く（≤ 120 文字）、または空。`feeling` はペルソナがどう受け取ったかをキャラクターカードを通じて判断。`weight` は 1–5（5 = 決して忘れない）。バッチごとにユーザーあたり最大 `memory.maxNewEpisodes` 件。ほとんどのバッチでは追加なし。入力には保存済みのエピソードが表示されるため、同じ出来事を二度記録しません。コードはメンバーごとに `memory.maxEpisodes` 件保持し、最も軽いものから、次に最も古いものから削除します。
- `lore` はサーバーのロアブックです: 会話を超えて残るもの、すなわちイベント（「X が去った日」）、繰り返し登場するキャラクターやペット、長期にわたるストーリー、対立、伝統。`title` はアイデンティティ（同じタイトルのエントリは更新であり、マージ後の全体テキストを持つ）、`keys` は 2–6 個の単語または短いフレーズで、そのことが話題になるとき人々が実際に入力するもの（名前、ニックネーム、ミームの文言、チャットの言語で、小文字）、`text` ≤ `lore.textChars`（`{{loreTextChars}}`）。入力の `<existing_lore>` には保存済みのタイトルとキーのリスト、およびバッチが触れるエントリの全テキストが表示されます。オーナーが追加したエントリ（`/nep lore add`）はアナライザーが変更しません。
- 文字列フィールド ≤ `memory.fieldChars`。詳細 ≤ `memory.maxDetails`、内輪ネタ ≤ `memory.maxInjokes`、self ≤ `memory.maxSelfFacts`。ノートはチャットの言語で記述します。観測された事実のみ。センシティブな情報（住所、電話番号、書類、健康、財務、本名）は記録しません。

## チャンネルマップ

`<server>` ブロックは保存されたチャンネルノートとコードが管理するファクトから構成され、このターンに関連するチャンネルだけにフィルタリングされます。現在のチャンネルが最初に表示され、`labels.server.currentMark` でマークされます。続いて、このターンで `<other_channels>` にメッセージを提供した隣接チャンネルのみがフル表示されます。その他の保存済みチャンネルはすべて除外されます。大規模サーバーではほとんどが無関係でバジェットの無駄です。

チャンネルエントリ（`src/memory/channels.js` の `renderChannel`）が持つ情報:

- **Discord ファクト:** 名前（`# ` 見出し）、カテゴリ、トピック。チャンネルが初めて確認された時点から存在します。
- **アナライザーノート:** 目的、トピック、トーン。ウォームアップ中に `channel.md` が書き込み、ストリームアナライザー（`memory.md`）がライブバッチから更新します。3 つともフリーテキストで、描画時にトークン解決（`<@id>` → 現在の名前）されます。
- **コードが管理するカウンター:** メッセージ数、最初と最後のメッセージのタイムスタンプ、30 日間のアクティビティヒストグラム（UTC 日ごとのメッセージ数、直近 30 日にトリム）、トップ 5 ライター（メッセージ数順、ボットとペルソナを除く）。ウォームアップがチャンネルのフェッチ済み履歴から `store.setChannelFacts` 経由で充填し、ライブトラフィックが `store.touchChannel` 経由で最新に保ちます。
- **アクティビティ判定:** `live`、`slow`、`dead`。カウンターから `channelActivity` が計算し、モデルの判断ではありません。今日と昨日（UTC）のメッセージ合計が `context.channelActivity.liveMessagesPerDay`（デフォルト 20）に達すると `live`。チャンネルにメッセージがないか、最新メッセージが `context.channelActivity.deadAfterDays`（デフォルト 7）日より古い場合は `dead`。その中間はすべて `slow`。`labels.server.activity` / `activityLive` / `activitySlow` / `activityDead` で描画されます。
- **最新メッセージの経過時間:** `labels.server.lastMessage` が存在しデータが利用可能な場合、人間に読みやすい形式で描画されます。
- **トップライター:** `labels.server.topWriters` で描画し、保存された作者 ID を現在の名前に解決します。プロファイルのない ID はスキップされます。

現在のチャンネルに保存済みノートがまだない場合（アナライザーが触れていない）、トランスクリプト内のメッセージの Discord ファクトからフォールバックエントリが合成されるため、ペルソナは自分がどこにいるか把握できます。

## ウォームアップ

各ウォームアップリクエストは一つの作業単位（一つのチャンネル、一人のメンバー、またはサーバー）を処理し、帰属を正確に保ちます。`channel.md` はチャンネルノート（目的、トピック、トーン）を生成します。`profile.md` はメンバーのキャラクター、スタイル、関心、詳細、エピソード、エイリアスを生成します。`server.md` はサーバー全体のパターン、会話の始め方、内輪ネタ、ロアブックを生成します。実行順序、サンプリング、進捗、制限、サブコマンドについては[ウォームアップ](warmup.md)を参照してください。

### データモデル

`character` と `style` は**自由記述のまま**で、`profile.md` のみが書き込みます: ウォームアップ時とポートレートリフレッシュ時です。ストリームアナライザーは編集しません。保存されたポートレートが見落としている、または矛盾している繰り返し見られる習慣や書き方の変化をバッチが示したメンバーについて、アナライザーは `users.<id>.portrait: "一行: ポートレートが見落としていること"` を返します。コードはそのメンバーのリフレッシュをキューに入れます。`profile.md` が `<draft>` = 保存済みの character + style、`<hint>` = アナライザーの一行で呼び出され、回答の `character` と `style` が保存済みのものを置き換えます（その回答の関心、詳細、エピソード、エイリアスは無視されます。これらはストリームの差分更新を通じて引き続き反映されます）。

態度と `relationship` はウォームアップされません。ライブ会話からのみ蓄積されます。

`profile.md` の出力: `{ "character": "", "style": "", "interests": [{ topic, note, times }], "details": [{ text, times }],
"episodes": [...], "aliases": [""] }`。ブロック `<character>` `<member>` `<draft>`（任意）`<hint>`（任意、ポートレートリフレッシュ時のみ）`<snippets>`。スニペット内の本人の行は `labels.warmup.ownMark` で始まり、コンテキスト行は `labels.warmup.contextMark` で始まります。エイリアスは他の人の行（その人をどう呼んでいるか）から得られるため、本人の行の帰属ルールは適用されません。

## アドレス分類器

ペルソナが誰かに応答した後、そのチャンネルで会話ウィンドウが開きます（`mention.followUpMinutes`、応答ごとに延長）。ウィンドウ内でトリガー（メンション、ペルソナへのリプライ、名前）を持たないメッセージは無条件には応答されません。コードはチャンネルの直近 `mention.followUpContext`（デフォルト 15）行を送信します。ペルソナ自身の行は `labels.self` でマーク、新しいメッセージは `<candidate>` としてマークされ、`address.md` に `classifier.text` モデルロール（デフォルト `anthropic/claude-sonnet-4.6`）で送信されます。出力は 1 行: 候補がペルソナに話しかけているか、ペルソナとのやり取りを続けている場合は `yes`、人々が自分たち同士で話しているか別の相手に話している場合は `no`（別のメンバーへのリプライや別のメンバーへのメンションは、モデルに尋ねる前に常に `no`）。`yes` は通常のリプライターンを実行します（モデルは `<skip/>` を返す可能性があります）。3 回連続の `no`（`mention.followUpNoStreak`、デフォルト 3）でウィンドウが閉じます。スイッチ `features.followUp`（デフォルトオン）。カウントと判定のみログに記録されます。
ウィンドウの状態は再起動後も維持されます。アクティブなウィンドウは `data/state.json` の `followUpWindows` に保存され、起動時に復元されます。期限切れのウィンドウは削除されます。

## 再視聴分類器

ペルソナに話しかけられた（リプライターン）とき、チャンネルの直近 `media.video.rewatch.recentMessages`（デフォルト
60）件のメッセージに動画がある場合、分類器がそのメッセージがそれらの動画について質問しているか、または読み込めなかった
動画のリトライを求めているかを判定します。候補は視聴済み動画とエラー状態の動画（リクエストされたリトライはターンの `media.video.maxPerTurn` 試行とは独立した
専用スロットを使用します）です。分類器には最大
`media.video.rewatch.maxCandidates`（デフォルト 6）件の動画が新しい順に渡されます。コードは `rewatch.md` を
システムプロンプトとして `classifier.text` モデルロール（デフォルト `anthropic/claude-sonnet-4.6`）に送信し、
ユーザーメッセージに 3 つのブロックを含めます: チャンネルの直近数件のメッセージを含む短い `<transcript>`（ペルソナ自身の行は `labels.self` でマーク、分類器が候補の返信先を把握できるようにする）、続いて動画リストと候補:

```
<transcript>
...
</transcript>
<videos>
<number> | <name> | <status> | <説明の冒頭>
...
</videos>
<candidate>
<著者名>: <トリガーテキスト>
</candidate>
```

各 `<videos>` 行には `|` 区切りの 4 列: 連番（1 = 最新の動画）、動画名、ステータス（`watched` または `not loaded`）、
サマリーの先頭 200 文字（読み込めなかった動画は空）。名前とサマリーは空白が正規化されて 1 行に。トリガーテキストは
`context.maxMessageChars` で切り詰め。出力は 1 行:

- `<number> | <question>`: メッセージが視聴済み動画について質問しており、説明でカバーされていない詳細を必要とする。番号はリストからそのままコピーする。
- `<number> | retry`: メッセージが読み込めなかった動画について、再試行を求めるかその内容を質問している。番号はリストからそのままコピーする。
- `none`: 再視聴もリトライも不要。

質問でヒットした場合、動画モデルが `rewatch-answer.md`（`{{question}}` と `{{maxChars}}` =
`rewatch.answerChars`、デフォルト 1200）でクリップを再度視聴し、回答は `transcript.videoAnswered`（`{question}`、
`{text}`）として視聴済みタグの後にトランスクリプトに追加されます。`<senses>` ブロックには機能が有効な場合に
`senses.videoRewatch` が含まれます。

リトライでヒットした場合、動画モデルが `force`（エラーキャッシュを無視）でクリップを視聴します。初回視聴と同じ
`describeVideo` パスを使用します。リトライが成功すると、動画のステータスがエラーから視聴済みに変わり、トランスクリプト
にはサマリーがファーストハンドとして表示されます。リトライは `media.video.maxPerTurn` と `media.video.maxPerDay` に
対する新しい動画試行としてカウントされます。

制限: ターンあたり最大 1 回の再視聴またはリトライ。分類器と再視聴はそれぞれ `llm.maxRequestsPerDay` にカウントされ
ます。再視聴は `media.video.maxPerDay` にもカウントされます。`media.video.rewatch.maxPerDay`（デフォルト 20）は
再視聴を個別に制限します。回答は質問ごとに 1 時間キャッシュされます（上記の動画キャッシュセクションを参照）。スイッチ
`features.videoRewatch`（未設定 = オン、`videoDescriptions` が必要）。

## 検索分類器

ペルソナに話しかけられた（リプライターン）とき、以下のすべてが成立する場合（`features.webLookup` がオン、
`web.search.enabled` が false でない、`lookup.md` プロンプトが存在する、`web.search.maxPerTurn` が 1 以上、
`BRAVE_SEARCH_API_KEY` が設定されている）、分類器がトリガーメッセージにウェブ検索が必要かを判定します。`classifier.text`
モデルロールを使用します。コードは `lookup.md` をシステムプロンプトとして送信し、ユーザーメッセージに短い `<transcript>`
（再視聴分類器と同じもの、ペルソナ自身の行は `labels.self` でマーク）と `<candidate>` ブロックを含めます:

```
<transcript>
...
</transcript>
<candidate>
<著者名>: <トリガーテキスト>
</candidate>
```

トランスクリプトには利用可能な場合、説明文、動画サマリー、リンク読み取りが含まれます。トリガーテキストは
`context.maxMessageChars` で切り詰め。出力は 1 行:

- 検索クエリ（プレーンワード、引用符なし、演算子なし、最大 12 語）: メッセージがチャット外の事実を必要とする場合。
- `none`: それ以外すべて。

クエリでヒットした場合、Brave Search がクエリを実行し（`web.search.results` 件の結果、デフォルト 5）、番号付きの結果が
`classifier.text` を通じて `search-summary.md`（`{{query}}`、`{{maxChars}}` = `web.search.summaryChars`、
デフォルト 900）で要約され、回答は `<chat>` の直前に `<lookup>` ブロックとして描画されます: `labels.lookup.header` に
クエリ、要約テキスト、`labels.lookup.sources` にサイト名（重複排除済み）。検索が何も返さなかった場合、または要約が有用な
内容を見つけなかった場合は `labels.lookup.none` が代わりに表示されます。

制限: ターンあたり最大 1 回の検索。分類器と要約はそれぞれ `llm.maxRequestsPerDay` にカウントされます。検索自体は
`web.maxPerDay`（リンク読み取りと共有）にカウントされます。結果は正規化されたクエリごとに `web.search.cacheHours`
（デフォルト 24）時間キャッシュされます。スイッチ `features.webLookup`（未設定 = オフ）。

## 多様性パス

各ターンの前に、`classifier.text` パスがペルソナの最近の自身のメッセージを読み、ペルソナが陥っている繰り返しの手法（言い回し、構造的な型、繰り返すジョークのパターン）を特定します。結果はターンのリクエスト内の `<worn>` ブロックになります。スイッチ `features.variety`（未設定 = オン）。

### メッセージの選択

最大 `variety.window`（デフォルト 12）件のペルソナ自身のメッセージ。ターンのチャンネルから先に取得（最新のものを優先）し、次に他のサーバーチャンネルから取得します（ギルドメモリの `ownLines` リングに保存、ペルソナがサーバーチャンネルに投稿するたびに書き込まれる）。`variety.recentMinutes`（デフォルト 45）より古いメッセージのみ保持。`variety.minLines`（デフォルト 3）未満の場合、パス全体がスキップされます。ボットが投稿したリミット通知（`labels.limits.notice`）はペルソナ自身のメッセージとしてカウントされません。

### `<lines>` フォーマット

メッセージは `#1`、`#2`、... と最も古いものから番号付け。空白は 1 行に折りたたまれます。メッセージが返信であった場合、`(to: <そのメッセージを variety.contextChars までクリップ>)` が付加されます。`variety.contextChars` が 0 の場合、コンテキストは省略されます。

### 出力と検証

1 つの裸の JSON オブジェクト:

```
{ "patterns": [ { "shape": "", "examples": ["", ""], "count": 0 } ] }
```

`shape`: 手法の説明、3 から `variety.shapeChars` 文字、メッセージの言語で記述。`examples`: 1 から 3 つの、ペルソナ自身の言葉からそのまま取った断片（`(to: ...)` コンテキストからではない）。各最大 80 文字。送信されたメッセージに出現する場合のみ保持（大文字小文字を区別しない）。`count`: 最低 2、送信されたメッセージ数が上限。最大 `variety.maxPatterns` 個の有効な手法。空のリストが通常の結果。期待される JSON でない回答はブロックを生成しません。

### キャッシュとストレージ

同じメッセージセットが連続して 2 度問い合わせされることはありません。ギルドレベルのキャッシュがメッセージ id の SHA-1 をキーとし、モデルリクエストなしで前回の結果を再利用します。

`worn` はギルドメモリ（`data/guilds/<id>/guild.json`）に保存されます: 最新のパスの `{ at, key, channelId, lines, patterns }`。`wornHistory` は最大 `variety.history`（デフォルト 20）件の過去パスのリングで、shape と count のみ（examples なし）。プライベートチャットで実行されたパスはそのターン用の patterns を生成しますが、ギルドメモリには保存されません。プライベートでの内容がオーナーの表示や他の会話に漏れることはありません。

### タイムアウトと失敗

`variety.timeoutMs`（デフォルト 8000）がモデルリクエストを制限します。タイムアウトまたは失敗は `<worn>` ブロックを生成せず、ターンはブロックなしで続行し、最後に保存されたパスはそのまま残ります。

### Mentor

Mentor サンドボックスは、reply ターゲットの状況ごとに 1 回の多様性パスを実行し、mentor のトークン予算から差し引かれます（`llm.maxRequestsPerDay` にはカウントされません）。特定された手法は状況レコードの `worn` として保存されます。ジャッジは `<worn>` ブロックを見ることはありません。

## 描画

ペルソナは描画サブプロセス（`features.imageGeneration`、デフォルトオン）を通じて画像を生成できます。モデルが `<draw>` タグを出力すると、`src/behavior/turn.js` が `draw.md` からイメージプロンプトを組み立て、OpenRouter Images API（`src/llm/images.js`）を通じて 1 枚の画像を生成します。画像はペルソナのテキストメッセージの後に独立したメッセージとして投稿され、インラインにはなりません。

### プロンプトの組み立て

`buildDrawPrompt`（`src/behavior/prompt.js`）が `draw.md` を 3 つのプレースホルダーで埋めます:

- `{{name}}` — ボットの表示名。
- `{{appearance}}` — `{{name}}` を埋めた `appearance.md`。`self="yes"` の場合のみ含まれ、それ以外は空。
- `{{request}}` — `<draw>` タグのシーンテキスト。`image.maxPromptChars`（デフォルト 800）でクランプ。

描画サブプロセスはキャラクターカード、`rules.md`、システムプロンプトを一切受け取りません。`draw.md` 内の独自のスタイルセクションに従います。

### リファレンス

ペルソナが画像に含まれ（`self="yes"`）、`image.reference` が `'avatar'`（デフォルト）の場合、ボットの Discord アバターがダウンロードされ `input_references` エントリとして送信されます。アバターの取得に失敗した場合はリファレンスなしで生成が続行されます。

### 感覚

`<senses>` ブロックには、イメージクライアントが接続され `features.imageGeneration` が false でない場合に描画行が 1 行含まれます:

- `senses.draw` — ペルソナは描画できる。
- `senses.drawSpent` — 日次クォータ（`image.maxPerDay`）が使い切られた。
- `senses.drawSpentUser` — このメンバーの日次クォータ（`image.maxPerUserPerDay`）が使い切られた。

`senses.draw` のない古い `labels.json` では何も表示されません。

### 失敗ターン

リプライターンで生成が失敗した場合（誰かが画像を依頼した場合）、2 回目のターンが自動的に発火します:

- `triggerKind: 'drawFailed'`、失敗理由が `labels.draw.reasons.*` を通じて `labels.triggers.drawFailed` の `{reason}` プレースホルダーにレンダリングされます。
- モードは `reply`、同じトリガーメッセージ、リプライ可。
- 2 回目のターン自体の `<draw>` は無効化されるため、モデルは生成をリトライできません。
- チャンネルのアイドル通知は 2 回目のターンが終了するまで保留されるため、保留中のピングはフォローアップの後にのみ処理されます。

自発的ターン（誰も依頼していない）では、失敗はログに記録されるだけでフォローアップは実行されません。

画像上限（`ImageCapError`、理由 `daily` または `userDaily`）は失敗ターンを発火しません。代わりにリミット通知（`labels.limits.notice`）をプレーンリプライとして投稿します。`draw.reasons.daily` と `draw.reasons.userDaily` は `labels.json` に予約されていますが、`triggers.drawFailed` 経由では到達しなくなりました。

### 制限

- ターンあたり `<draw>` は 1 つ。最初の非空が優先、`image.maxPromptChars`（デフォルト 800）でクランプ。
- `image.maxPerDay`（デフォルト 50）と `image.maxPerUserPerDay`（デフォルト 50）はリクエスト前にチェックしカウント。上限エラーは `ImageCapError`（理由 `daily` または `userDaily`）。
- サポートされないモデルファミリー（`openai/*` でも `google/*` でもない）は `UnsupportedImageModelError` で拒否。
- 生成失敗は `ImageGenError`（理由 `moderation`、`timeout`、`error`、`empty`）。
- 一時的な HTTP エラー（408、429、5xx）とネットワーク障害は `image.retries`（デフォルト 1）回までリトライ。
- モデレーション拒否（HTTP 400/403 + モデレーションマーカー）はリトライされない。
- ログにはモデル、カウント、コスト、失敗理由が記録され、プロンプトは含まれません（メンバーを引用する可能性があるため）。
- ドライランでは完全なイメージプロンプト（プロンプトファイル + ペルソナのリクエスト）がログとミラーに記録されますが、何も生成されません。

## プライベートチャット

`features.privateMessages`（デフォルトオフ）で、サーブしているギルドのメンバーが Discord ダイレクトメッセージでペルソナと会話できます。ペルソナは同じキャラクター、同じ公開メモリ。DM で話された内容はメンバーごとのプライベートレイヤーに保存され、他の会話には一切見えません。

### ゲート

DM は以下のすべてが満たされた場合にのみ応答されます（トークンゼロでローカルチェック）:

1. `features.privateMessages` が `true`。
2. 送信者がサーブしているギルドのメンバー。
3. ペルソナが送信者の公開プロファイルを保持している。
4. 公開 `affinity.score >= private.minAffinity`（デフォルト 5）。ボットオーナーはこのチェックをバイパス。
5. 本日のリプライ数がキャップ未満（オーナーは `private.maxPerOwnerPerDay`、それ以外は `private.maxPerUserPerDay`）。

5 で日次キャップに達した場合のみ、1 日 1 人 1 回のリミット通知（`labels.limits.notice`）が投稿されます。

### DM ターンの内容と省略

- `<server>`（チャンネルマップ）と `<other_channels>` は省略。
- `prompts.private`（存在する場合）がモードプロンプト（`reply.md`）の後、`forced.md` の前に追加。`{{name}}` と `{{author}}` が設定される。
- `{{trigger}}` は `labels.triggers.private` から取得。
- `<senses>` に `senses.privateChat` が含まれる。
- サーバーターンでは、`features.privateMessages` がオンの場合、`<senses>` に `senses.privateAware` が代わりに含まれる。
- 対話相手のプロファイルは `mergeProfiles(publicProfile, privateProfile)`。他のプロファイルは公開のみ。

### プライベートレイヤー

`data/guilds/<guildId>/private/<userId>.json` に DM で学んだ内容を保存。独自の `relationship`、`interests`、`details`、`episodes`、`affinity`（初期スコア 0）を持つ。DM でペルソナは公開とプライベートデータの結合を見る: インタレストはトピックで結合（プライベートノートが優先）、ディテールは連結、エピソードは日付順、`relationship` は段落結合。

### DM でのアフィニティ

公開スコアはサーバーバッチからのみ変化。プライベートレイヤーは独自のスコア（初期 0）を持ち、DM バッチからのみ変化。DM でペルソナが感じるのは `clamp(公開 + プライベート, -100, 100)`。サーバーでは公開スコアのみ。ゲートは公開スコアのみを使用。

### プライベートモードのアナライザー

`analyzePrivate` は同じ `memory.md` フォーマットに `<private>` ブロック（`labels.memory.privateNote`）を加えたリクエストを構築。`<existing_profiles>` にはパートナーのみ。回答からは `users[<partnerId>]` のみがプライベートストアメソッドで適用。`portrait`、`aliases`、`guild`、`channels`、`lore`、`self` は破棄。

## Mentor

手動サブプロセス（`features.mentor`）で、独自モデル（`mentor.model`）を使用します。オーナーがケース（ペルソナに期待する行動）を追加し、mentor がチャット状況を作成、サンドボックスでペルソナに回答させ、スコアリングします。不合格またはスコアが低い場合、ペルソナのコンテキスト内の原因を特定し、オーナーが検討する助言として変更を提案します。同時実行は 1 つのみ。すべての作業は `data/` に保存されます。`bot.dryRunChannelId` が設定されている場合、完了したランはそこにも投稿されます。管理チャンネルがない場合、オーナーは `/nep mentor status` でランを追跡し、`/nep mentor show <id>` でレポートを読みます。

### プライバシー

Mentor モデルはレンダリングされたサンドボックスリクエストを読み取るため、ペルソナが実際の人物について記憶している内容を読み取ります。ダイレクトメッセージとプライベートメモリレイヤーはサンドボックスリクエストに含まれません。

### ランの終了方法

ランは通常、判定とレポートで正常終了します。早期終了もあります:

- **停止** (`budget`): 日次トークン予算が枯渇。スイッチと予算は各状況の前と各 mentor リクエストの前にチェックされます。
- **停止** (`owner`): オーナーが `/nep mentor stop` または `/nep pause` を実行。
- **停止** (`disabled`): ラン中に `features.mentor` または `mentor.model` がオフにされた。
- **エラー** (`the reference is empty`): リファレンスウィンドウ内のリファレンスチャンネルから人々のメッセージを読み取れなかった。モデルリクエスト前にランを終了。

停止されたランは既に得られたスコアを保持し、レポートに含めます。

### 実際の moment（anchors）

ケースはチャットからの実際の moment を含むことができます。各 moment はオーナーが拒否したペルソナの 1 つのメッセージです。解決プロセス: ボットはメッセージを取得し、トリガー（リプライ先のメッセージ、またはその前のペルソナ以外の最後のメッセージ）を見つけ、そのチャンネルのトリガーまでの最大 `mentor.anchor.contextMessages`（デフォルト 30）件のメッセージを収集し、ペルソナのバースト全体（指定メッセージから始まる連続メッセージ）をオリジナルの回答として保存します。保存された履歴は通常のトランスクリプトと同じ方法で正規化され（メディアラベル、リアクション）、ダウンロードも記述も行いません。解決時にペルソナが見たメディアも保存されます。各メッセージについて、記述器が `media.json` にキャッシュしたキャプション（画像、GIF、動画フレーム、リンクサムネイル、スタンプ、カスタム絵文字）と視聴済み動画要約のうち、ペルソナのメッセージ以前に書き込まれたエントリが `mediaSeen: { captions?: { <itemId>: text }, watched?: { <itemId>: text } }` になります。保存されないもの: 未視聴状態（制限またはエラー）、再視聴回答（`videoAnswered`）、ウェブ検索読み取り（`linkRead`）、添付画像マーカー。名前とリアクションは取得時のまま保持されます。保存後、チャンネルが進んだりメッセージが削除されても、moment は保存されたメッセージから再生されます。

ケースは moment を `anchors` として保存します:

```json
[{ "id": 1, "channelId": "...", "messageId": "...", "triggerId": "...",
   "addedAt": "...",
   "history": [
     { "...正規化されたメッセージフィールド...",
       "mediaSeen": { "captions": { "<itemId>": "text" }, "watched": { "<itemId>": "text" } } }
   ],
   "original": ["text", "..."] }]
```

ラン中、各使用可能な anchor は独立した状況になり、作成された状況の前に番号が付けられます。状況レコードは `anchor: <id>` を持ちます（作成された状況にはありません）。再生は保存された履歴を使用し、ペルソナのオリジナルメッセージの時点で、anchor 自身のチャンネルで行われます。

再生時、保存された `mediaSeen` はライブのトランスクリプトラベル（`imageDescribed`、`gifDescribed`、`videoDescribed`、`videoWatched`、`thumbnailDescribed`、`linkWatched`、`stickerDescribed`、`emojiDescribed`）でペルソナのリクエスト、`<examples>`、スコアリングの `<situation>`、`<worst>` にレンダリングされます。保存された記述のない項目は、再生時に同じ時間制限（ペルソナの回答）でキャッシュを読み取り専用で参照します。キャッシュにもない場合、項目はプレーンラベルでレンダリングされます。

`mentor.anchor.hideLaterMemory` が `false` でない場合（デフォルト `true`）、再生される moment はトリガー時点より前の記憶状態で回答されます。トリガーのタイムスタンプ以降に記録された項目は非表示になります: エピソード（`addedAt` を使用、なければ `date` の UTC 日付にフォールバック）、態度履歴エントリと態度の理由（スコアは現在の値のまま）、詳細（`firstSeen`）、興味（`firstSeen`）、エイリアス（`firstSeen`）、学習項目（`firstSeen`）、ロアエントリ（`createdAt`）。解析可能な日付のない項目はフィルタリングされません。日付のないフィールド（プロファイルのテキストフィールド、サーバーパターン、スターター、インジョーク、自己事実、チャンネルエントリ）は現在の値で表示されたままです。実際の moment の `<learned>` ブロックも同じ方法でフィルタリングされます。`false` に設定すると、現在の全記憶で moment を再生します。

状況リクエストでは、ケースの anchor が `<examples>`（最後のブロック）として mentor モデルに提示されます。各 `<example>` には保存されたトランスクリプトの `<situation>` とペルソナのメッセージの `<original>` が含まれます。各例の最も古いメッセージはリクエスト予算に収まるようにトリミングされる場合があります。トリガーは削除されません。Mentor は同種の状況を作成します: メッセージの長さ、ターン数、圧力の程度を合わせます。

実際の moment のスコアリングリクエストでは、`<original>` が `<situation>` と `<answers>` の間に配置され、ペルソナの拒否された回答を既知の悪い参照として含みます。

バリデーターの作成された状況の 1 行あたりの上限は 2000 文字（旧 500）になり、mentor が例のメッセージの長さに合わせられます。

### プロンプト

Mentor は 6 つのプロンプトファイルを使用します。ターゲットごとに 1 ペア、特徴ファイルと診断ファイル:

- **Reply ターゲット**: `mentor-situations.md`（状況を作成）と `mentor-score.md`（回答をスコアリング）。
- **Memory ターゲット**: `mentor-situations-memory.md`（状況を作成）と `mentor-score-memory.md`（保存テキストをスコアリング）。
- **診断**: `mentor-diagnose.md`（スコアリング後に弱い回答を説明）。

各プロンプトファイルは 1 つの mentor リクエストのシステムメッセージです。ブロックはユーザーメッセージで送信されます。

コードが埋めるプレースホルダー: 6 つすべてに `{{name}}`。2 つの状況プロンプトに `{{count}}`、`{{minLines}}`、`{{maxLines}}`。

### ブロック

| ブロック | 内容 | どのリクエストで |
|---|---|---|
| `<case>` | オーナーのケーステキスト、逐語 | すべて |
| `<members>` | 保存されたプロファイル 1 行ずつ: `name (id:123)` | 状況 |
| `<reference>` | スタイルプロファイル JSON: 句読点の頻度、長さ、返信頻度、未使用文字 | 状況、スコアリング |
| `<samples>` | チャットからのランダムな行、1 行ずつ | 状況、スコアリング |
| `<signs>` | `{{name}}` を埋めた `mentor-signs.md`: モデル文の既知の癖。ファイルがないか空の場合は省略 | すべて |
| `<intended>` | `labels.mentor.intended`、1 項目ずつ | スコアリング |
| `<feedback>` | オーナーの修正の JSON 配列: `[{ "case": "...", "reason": "..." }]`、新しい順。空の場合省略 | すべて |
| `<examples>` | チャットからの実際の moment: `labels.mentor.examples` を先頭行とし、moment ごとに 1 つの `<example>`。各 `<example>` には `<situation>`（保存されたトランスクリプト、最も古いメッセージはリクエスト予算に合わせてトリミングされる場合あり）と `<original>`（ペルソナのメッセージ）が含まれる。ケースに moment がない場合は省略 | 状況 |
| `<original>` | その時のペルソナの回答（実際の moment のスコアリングリクエスト内）。`labels.mentor.original` を先頭行とし、ペルソナのメッセージが続く。既知の悪い参照であり、スコアリング対象の回答ではない。作成された状況では省略 | スコアリング（reply、実際の moment のみ） |
| `<character>` | `{{name}}` を埋めたキャラクターカード | スコアリング（reply のみ） |
| `<rules>` | ルールプロンプト | スコアリング |
| `<learned>` | ペルソナが見ている指示的な学習項目。`mentor.anchor.hideLaterMemory` が有効な実際の moment では、トリガー以降に書き込まれた項目は非表示 | スコアリング |
| `<situation>` | チャットトランスクリプトとしてレンダリングされた状況（ペルソナの視点）。実際の moment では、最も古いメッセージがリクエスト予算に合わせてトリミングされる場合があり、トリガーは削除されない | スコアリング |
| `<answers>` | JSON 配列: `[{ "id": "s1a1", "messages": ["..."], "reactions": ["..."], "silent": false }]` | スコアリング（reply） |
| `<stored>` | JSON 配列: `[{ "id": "s1a1", "texts": [{ "path": "...", "text": "..." }], "parseOk": true }]`。`parseOk` が false の場合、アナライザーが無効な JSON を返し何も保存されない | スコアリング（memory） |
| `<facts>` | 回答 id をキーとした JSON オブジェクト。確定的測定結果（未使用マーク、レアマーク、コンマ数、コンマ密度、長さ）と、2 つ以上の異なる状況で見つかったフレーズ `"repeated"` を含む。回答ごと: `commas` はカウント、`commaPer1000` は測定テキストが 150 文字以上の場合のみ数値で、短い場合は `null`（短すぎて測定不能、mentor はカウントで判断し密度を推定しない）。`repeated` は異なる状況で繰り返されたフレーズを列挙し、`count` は状況の数 | スコアリング |
| `<verdict>` | JSON: `{ passed, medians, situations, reasons }`。合否結果、各軸の中央値、状況ごとの中央値、診断の理由。理由には作成された状況の `situation <n>: <axis> <v> is under the floor <f>` と実際の moment の `real moment <n>: <axis> <v> is under the pass score <s>` または `real moment <n>: <axis> <v> is under the anchor score <s>` が含まれる | 診断 |
| `<worst>` | JSON: 種類を問わず `overall` 中央値が最低の状況（同率の場合はより低い `goal` 中央値、次に実際の moment が作成された状況より優先、次により小さい `n`）: `{ n, title, transcript, answers }`。各回答は id、messages/reactions/silent（memory の場合は `texts`/`parseOk`）、`facts`、`score` を含む。トランスクリプトはリクエスト予算に合わせてトリミングされる場合がある | 診断 |
| `<seen>` | その状況でペルソナ（memory ケースの場合はアナライザー）に渡された完全なリクエスト。2 つのサブブロック: `<system>`（キャラクターカード、ルール、フォーマットを含むシステムプロンプト）と `<user>`（トランスクリプト、メモリブロック、タスク） | 診断 |

### 回答 ID

`s<状況>a<サンプル>`、どちらも 1 から。例: `s2a3` は 2 番目の状況の 3 番目のサンプル。

### 状況スキーマ

```json
{
  "situations": [
    {
      "title": "短いラベル",
      "lines": [
        {
          "authorId": "123456789 or self",
          "authorName": "表示名",
          "text": "メッセージ",
          "replyTo": null,
          "minutesBefore": 5
        }
      ]
    }
  ]
}
```

`authorId` は `<members>` のメンバー id または `self`（ペルソナ自身の行）。`replyTo` はこの状況の `lines` 配列内の 0 ベースインデックス、または `null`。両ターゲットとも最後の行は `self` であってはなりません。Reply ターゲット状況では最後の行がペルソナに話しかけます。Memory ターゲット状況ではペルソナへの呼びかけは不要です。ペルソナ自身の行は最後の行より前のどこにでも置けます。

実際の moment からの状況レコードは `lines` の代わりに `anchor: <id>` を持ちます。そのトランスクリプトは保存された履歴から構築されます。レコードには `original`（ペルソナのメッセージ）と `at`（ペルソナが回答した時間）も含まれます。

### スコアスキーマ

```json
{
  "answers": [
    {
      "id": "s1a1",
      "human": 7,
      "character": 8,
      "rules": 9,
      "goal": 6,
      "overall": 7,
      "comment": "1～2 文。"
    }
  ]
}
```

各スコアは 0–10 の整数または `null`。`overall` と `goal` は常に数値。Memory ターゲットスコアリングでは `character` は常に `null`。

### 軸

すべて 0–10 の整数、10 が理想、`null` は判定不能時（5 を「不明」の代用にしない）。

| 軸 | 測定内容 | 0 | 5 | 10 |
|---|---|---|---|---|
| `human` | AI らしさの低さ | このチャットの人々の書き方から遠い | どちらとも言えない | リファレンスの実際の人の書き方と一致 |
| `character` | キャラクターカードへの適合度 | 完全にキャラクター外 | 認識できるが滑りあり | カードの声そのもの |
| `rules` | ルールと学習項目の遵守 | すべての適用ルールに違反 | 一部遵守、一部違反 | すべての適用ルールを遵守 |
| `goal` | `<case>` の要求を満たしているか | 逆のことをしている | 部分的に達成、部分的に未達 | 記述通りに行動を処理 |
| `overall` | Mentor の総合判定 | 全面的に不合格 | 明確な弱点はあるが許容範囲 | 全面的に優秀 |

Memory ターゲットスコアリングでは `character` は常に `null`、`human` はテキストが知り合いについての個人的なメモ（10）か、そのような人が自分用に書く文体から遠い（0）かを測定します。

### 合格ルール

ケースが合格する条件: `overall` の中央値 >= `mentor.pass.score`（デフォルト 7）かつ `goal` の中央値 >= `mentor.pass.score` かつ、いずれの軸の中央値も `mentor.pass.floor`（デフォルト 5）を下回らないこと。作成された状況は下限でチェックされます: いずれか 1 つの作成された状況の `overall` 中央値または `goal` 中央値が `mentor.pass.floor` を下回る場合、全回答の中央値に関わらずケースは不合格です。実際の moment はパススコアで判定されます: `mentor.pass.anchorScore`（数値に設定時）または `mentor.pass.score`（`anchorScore` が `null` の場合）を下回ると不合格です。理由文字列: `anchorScore` 未設定時は `real moment <n>: <axis> <v> is under the pass score <s>`、設定時は `real moment <n>: <axis> <v> is under the anchor score <s>`。レポートには各状況の `overall` と `goal` の中央値が表示されます。すべてのスコアが `null` の軸は中央値が `null` となり、チェックされません。

### スコアリングのエビデンス順序

1. `<feedback>` 内のオーナーの修正。Mentor の好みに優先する。
2. 測定されたリファレンス（`<reference>`、`<samples>`）と確定的事実（`<facts>`）。
3. モデル文の既知の特徴（`<signs>`）。測定結果やリファレンスに優先しない。
4. Mentor 自身の好み。提案のみ行い、上記 3 つに優先しない。

### 出典

`mentor-signs.md` の既知の特徴リストは、Wikipedia の "Signs of AI writing" と humanizer skill (MIT) を参考に作成されました。

### 診断

スコアリング後、ランが早期終了せずケースが不合格または任意の状況の `overall` 中央値が `mentor.pass.score` を下回る場合、mentor はもう 1 つのリクエストを行い、ペルソナのコンテキストのどこが弱い回答を引き起こしたかを説明します。スイッチ `mentor.diagnose`（デフォルト `true`）。`/nep mentor check` で開始されたランは診断を要求しません。このステップの失敗はランを失敗させません。ランは `diagnosis: null` で保存され、エラーが記録されます。

結果はランの `diagnosis` として保存され、レポートに出力されます。これらはオーナーが検討するための仮説であり、mentor 自体は何も編集しません。

原因が指すレイヤー: `rules`（ルールブロック内のルール）、`prompt`（エンジンのシステムプロンプト、フォーマット、タスク）、`card`（キャラクターカード）、`self`（ペルソナが自分について保持するメモ）、`learned`（他者が教えたこと）、`guild`（サーバーの習慣や内輪ネタ）、`profile`（ある人についての記憶）、`missing`（あるべき指示が存在しない）。

#### 診断スキーマ

```json
{
  "summary": "1 段落",
  "causes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile|missing",
      "excerpt": "<seen> からの逐語引用、最大 300 文字。missing の場合は空",
      "why": "1～2 文"
    }
  ],
  "changes": [
    {
      "layer": "rules|prompt|card|self|learned|guild|profile",
      "target": "どのファイル、ルール、または項目",
      "from": "置換する逐語テキスト。追加の場合は空",
      "to": "新しいテキスト",
      "why": "1 文"
    }
  ]
}
```

最大 5 個の原因と 5 個の変更。`summary` は 1500 文字に切り詰め、`excerpt` は 300、`from`/`to` は 1000、`target` は 200、`why` は 500。不明な `layer` または `why` のない項目は破棄。`summary` と `why` はチャットの言語で、`to` は対象レイヤーの言語で記述。

## リミット通知

レールがトリガーされたアクション（メンション、リプライ、名前トリガー、フォローアップ、プライベートメッセージ）を拒否した場合、ボットは `labels.limits.notice` から 1 行を投稿。`{limit}`（config キー）、`{used}`、`{cap}` が設定される。自発的ターンはサイレント。ドライランではログとミラーに記録。

`{limit}` に表示される config キー: `llm.maxRequestsPerDay`、`llm.maxRequestTokens`、`image.maxPerDay`、`image.maxPerUserPerDay`、`private.maxPerUserPerDay`、`private.maxPerOwnerPerDay`。
