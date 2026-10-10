# コマンド

チャンネル、ロール、ユーザーは Discord 標準のピッカーから選択します。`set`/`unset` と `access grant`/`access revoke` では `path`/`command` オプションがオートコンプリートされます。

`/nep` は最初からすべてのメンバーに表示されます。アクセスはコマンド実行時にコマンド単位でゲートされ、Discord 自体のコマンド表示設定は使いません。オーナー（`bot.owners`）はすべてのコマンドを常に実行できます。それ以外のユーザーにはグラントが必要です。`/nep access grant <command> [role] [user]` で一つのコマンドキー（例: `memory.show`）、グループ全体（例: `memory`）、またはすべてのコマンド（`*`）を、全員（ロール/ユーザー指定なし）、ロール、またはユーザーに開放します。`/nep access revoke` でグラントを取り消し、`/nep access list` で現在のグラント一覧を表示します。グラントのないオーナー以外のユーザーが `/nep` を実行すると、エフェメラルな「Not allowed」の応答が返ります。`private.show`、`private.forget`、`private.purge` はオーナー専用で、すべてのグラントから除外されます。`access grant` はこれらを拒否し、`access list` にも表示されません。`mentor` と `access` グループも同様にオーナー専用で、グラントできません。

| コマンド | 説明 |
|---|---|
| `/nep status` | モデル、キャリブレーション、クォータ（深夜以降の LLM リクエスト数、画像カウントと画像モデル、GIF 視聴数、ポートレートリフレッシュ数）、ギルドごとのメモリ状況（プロファイル数、バッファー、次回の自発）、ボイスキューのサイズと今日のボイスリクエスト数（2 段階有効時）、多様性パス（スイッチ、手法数と経過時間）、プライベートチャットのオン/オフとプライベートファイル数を表示 |
| `/nep reload` | 設定とプロンプトを即時リロード |
| `/nep ping [role]` | 一つまたはすべてのモデルロール（`voice`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`、`image`）にミニマルリクエストを送信し、各ロールの `llm.providerByModel` ルートに従って、モデル、レイテンシ、プロバイダー、トークン数またはエラーを報告。`/nep ping classifier` で 3 つの分類器ロールすべてをピング。モデル行がまとめて表示された後、API キーチェック: `youtube: API key — {status}`（例: `ok`、`not needed (yt-dlp ok)`、`missing (blocked)`）と `web: API key — {status}`（`ok`、`missing`、`off`）。`role:image` はプロバイダーの公開モデルリストで `image.model` を検証し（無料の GET 1 回、生成なし）、モデルが登録済みで画像出力に対応していることを確認するが、生成の成功は保証しない。ロール指定なしの場合 image の検査は他のモデル行の後に実行される。`llm.maxRequestsPerDay` にカウントされず、一時停止中やウォームアップ中でも動作 |
| `/nep pause` | すべてのアクティビティを停止し、メモリをディスクにフラッシュしてアンロード。実行中の mentor ランは停止され、フラッシュ前にレポートが投稿される。一時停止中は `data/` を安全に編集可能 |
| `/nep resume` | `data/` からメモリをリロードして再開。JSON ファイルがパースできない場合は拒否し、壊れたファイル名を表示 |
| `/nep interject [channel]` | そのチャンネルの会話に今すぐ割り込む |
| `/nep initiate [channel]` | そのチャンネルで今すぐ話題を切り出す |
| `/nep draw <text> [self]` | 描画プロンプトを通じて 1 枚の画像を描く。応答は本人のみ（エフェメラル、画像添付）。`image.maxPerDay` の残高を消費するがメンバーのクォータにはカウントしない。一時停止中は拒否。`features.imageGeneration` に依存しない |
| `/nep set <path> <value>` | 設定値をオーバーライド（`config.local.json` に書き込み）。`bot.owners` と `bot.access` 配下のパスは `set` のグラントを持つメンバーでもオーナー専用。値は現在の値と同じ JSON 型でなければならず、パスは末端キーを指す必要がある |
| `/nep unset <path>` | 設定のオーバーライドを削除。`set` と同じオーナー専用・末端キーの制約 |
| `/nep rule add <text>` | `prompts.local/rules.md` にルールを追記 |
| `/nep rule list` | ルール一覧を番号付きで表示 |
| `/nep rule remove <number>` | 番号指定でルールを削除 |
| `/nep model show` | 各ロール（`voice`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`、`image`）のアクティブなモデルを表示 |
| `/nep model set <role> <id>` | ロール（`voice`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`、`image`）のモデルを設定 |
| `/nep route list` | `llm.providerByModel` のすべてのルート、各ロールの現在のモデルと適用されるルーティングを表示。アクセスキー `route.list`（読み取り専用） |
| `/nep route set <model> <providers> [role] [fallbacks]` | モデルプレフィックスを指定のプロバイダーのみにルーティング。`model` はモデル id またはプレフィックス（例: `google/`、`@` やスペース不可）。`providers` はプロバイダー slug のカンマ区切りリスト（例: `google-vertex`、小文字、数字、ハイフン）。`role` はルートを 1 つのロールに限定（デフォルト: 任意）。`fallbacks` はこれらが利用不可の場合に他のプロバイダーを許可（デフォルト: false）。`config.local.json` の `llm.providerByModel` に `{ "only": [...], "allow_fallbacks": ... }` を書き込みリロード。アクセスキー `route.set` |
| `/nep route remove <model> [role]` | ルートを削除。キーは `config.local.json` に存在する必要がある。`config.json` にのみ設定されたキーはこの方法では削除不可。アクセスキー `route.remove` |
| `/nep memory show <user> [section] [limit] [order]` | セクション指定なし: コンパクトな要約。セクション: `character`、`style`、`relationship`、`affinity`、`aliases`、`interests`、`details`、`episodes`、`raw`（保存された JSON）。リスト系セクションは `limit` 1..100（デフォルト 25）と `order`: `rank`（デフォルト、表示上限で区切り線あり）または `recent` を指定可能。保存されたメンバー参照は現在の名前に解決されるが、`raw` では解決しない |
| `/nep memory channel [channel]` | チャンネル指定あり: 保存されたノートの全文（目的、トピック、トーン、メッセージ数、アクティビティ、トップライター）。指定なし: ペルソナが把握している全チャンネルの一覧（最終メッセージ順） |
| `/nep memory server` | サーバー全体のノート: 会話のしかた、会話の始め方、内輪ネタ、自己言及、およびプロファイル・チャンネル・ロアブックエントリの件数 |
| `/nep memory recent` | ギルドのライブ最近ライン: 現在の `memory.recentHours` ウィンドウ内のノートを新しい順に表示（id、時刻、チャンネル、重み付き） |
| `/nep memory refresh <user>` | メンバーのポートレートを強制リフレッシュ。50k トークン制限内にサンプルを収める。`memory.portraitRefreshPerDay` にカウント。キャラクターテキストのボイスアイテムがキュー中（`voice-pending`）の場合、その旨を応答し、強制でない限り拒否 |
| `/nep memory forget <user>` | 保存されたプロファイル、プライベートメモリ、およびキューされたボイスアイテム（そのメンバーが教えたレッスンを含む）を削除。実行中のアナライザーバッチの完了を待つ |
| `/nep memory affinity <user> [score] [reason]` | 態度を表示または設定（-100..100） |
| `/nep memory wipe <confirm>` | このサーバーのアナライザーメモリをすべて消去。確認のためサーバー名を正確に入力。削除対象: メンバープロファイルとプライベートメモリ、サーバーの傾向（パターン、スターター、内輪ネタ）、学習項目、ボイスキュー、最近のライン、絵文字ランキング、多様性パスの履歴、チャンネルマップ、アナライザーのロア、ウォームアップの進捗。保持対象: オーナーのロアエントリ、メディア説明キャッシュ、GIF ライブラリ、トークンキャリブレーション、日次カウンター、自発スケジュール。実行中のアナライザーバッチの完了を待つ |
| `/nep private show <user>` | メンバーのプライベートメモリを表示: リレーションシップ、インタレスト、ディテール、エピソード、プライベートと実効アティチュード、本日のリプライ数。プライベートレイヤーなしの場合はプレーン応答。オーナー専用; グラント不可 |
| `/nep private forget <user>` | メンバーのプライベートメモリのみを削除。公開プロファイルは保持。実行中のアナライザーバッチの完了を待つ。オーナー専用; グラント不可 |
| `/nep private purge <user>` | メンバーとの DM チャットにおけるボット自身のメッセージを削除（最大 `private.purgeMaxMessages` 件をスキャン）し、プライベートメモリも削除。メンバー自身のメッセージは残る。一時停止中は拒否。オーナー専用; グラント不可 |
| `/nep diary set <channel>` | 日記をこのチャンネルに設定する。ボットが閲覧、送信、履歴読み取り、ファイル添付できる必要がある。`diary.channelId` を `config.local.json` に書き込む。日記の履歴が空の場合、そのチャンネルのペルソナの過去の投稿から埋める。チャンネル、バックフィル件数、今日の計画を返す |
| `/nep diary show` | 日記チャンネル、今日のスロットと完了マーク（`bot.timezone`）、今日使った投稿数と画像数、履歴サイズを表示 |
| `/nep diary off` | `diary.channelId` をクリア。日記の履歴ファイルは残る |
| `/nep diary post [kind] [topic]` | 今すぐ 1 投稿を強制する。実行中のターンがあれば `diary.forceWaitMs` まで完了を待つ。タイムアウト時は `busy` と応答。種類キー（例: `selfPicture`, `thought`）はオプション。不明な種類は一覧とともに拒否。フリーテキストの topic はオプションで、投稿の題材を指定する。日次上限に従う。上限による拒否は設定キーと使用数/上限数を表示する。画像種類は投稿が画像を含められない場合に拒否される: 上限が原因なら上限とその数を表示し、それ以外なら `pictures` と表示される。ドライランではミラーのみ |
| `/nep alias add <user> <name>` | チャット用エイリアスを追加（即時確定） |
| `/nep alias remove <user> <name>` | チャット用エイリアスを削除 |
| `/nep learned list` | レッスンの一覧を表示（ID、教えた人、観測回数付き） |
| `/nep learned add <text>` | レッスンを手動で追加（教師なし、確定済み） |
| `/nep learned remove <id>` | レッスンを削除 |
| `/nep lore add <title> <keys> <text> [always]` | ロアブックエントリを追加または上書き。同じタイトルのエントリは置き換えられオーナー所有になるため、アナライザーは以後編集しない |
| `/nep lore list [query]` | ロアブックエントリ一覧を表示 |
| `/nep lore show <id>` | ロアブックエントリを表示 |
| `/nep lore remove <id>` | ロアブックエントリを削除 |
| `/nep gifs status` | GIF ライブラリを表示: サイズ、ランク順上位 10 件（ハンドル、カウント、キャプションまたは名前付き）、履歴バックフィル時刻、本日の投稿数 / `gifs.maxPerDay`、本日の視聴数 / `media.gif.maxPerDay`、`captions:`（ライブラリ内の視聴済み / 単一フレーム / 視聴失敗 / なしの内訳）、`caption format:`（フィールド付きで視聴済み / 旧形式で視聴済み、要再記述 / 未視聴） |
| `/nep gifs rescan` | 使用カウントをゼロにリセットしチャンネル履歴から再カウント。エントリとハンドルは保持、見つからないエントリはサイズ上限で削除されるまでゼロのまま |
| `/nep gifs recache` | ライブラリ外の単一フレーム GIF キャプションを削除し、旧形式の視聴済みエントリ（`reaction` フィールドなし）を再記述用にキューし、バックグラウンドで最大 `gifs.recachePerRun` 件のライブラリ GIF を古いものから順に視聴。日次上限 `media.gif.maxPerDay` はライブ視聴と共有; 300 エントリを 50 件/回で処理するには 6 回のコマンドと最低 2 UTC 日が必要。即座に応答。進捗は `/nep gifs status` で確認。一時停止中、ウォームアップ中、GIF 視聴がオフの場合は拒否 |
| `/nep warmup run` | フルランを開始または再開: チャンネル、メンバー、サーバーの順 |
| `/nep warmup users [member]` | メンバー指定あり: そのメンバーのプロファイルを作成または再作成。指定なし: 対象となるすべてのメンバーを再プロファイル |
| `/nep warmup channels [channel]` | チャンネル指定あり: そのチャンネルを記述または再記述。指定なし: 読み取り可能な全チャンネル |
| `/nep warmup server` | サーバーノートとロアブックを再構築 |
| `/nep warmup people` | 対象メンバー一覧を表示 |
| `/nep warmup status` | ウォームアップの進捗とトークン使用量を表示 |
| `/nep warmup stop` | 実行中のウォームアップ作業を即時終了。進行中のリクエストはキャンセルされ、進捗は保持されるため `run` で再開可能 |
| `/nep warmup reset` | ウォームアップの進捗のみをクリア（保存されたメモリは消去しない） |
| `/nep mentor add message:<link or id> text:<comment>` | ケースを追加: 拒否したペルソナのメッセージと、何が問題かの一文。両方とも必須。メッセージはペルソナのものである必要があります。他のサーバーへのリンク、DM、ボットが読めないチャンネル、削除されたリプライ先、ペルソナ以外のメッセージは拒否されます |
| `/nep mentor anchor id:<case> message:<link or id>` | 既存のケースに別の moment を追加。`add` と同じ拒否条件に加え、不明なケース、削除済みケース、非 reply ケース、同じメッセージの重複、履歴が空かペルソナのメッセージで終わる moment、`mentor.anchor.max` 超過も拒否されます |
| `/nep mentor cases` | ケース一覧: id、状態（`new`、`passing`、`failing`）、ターゲット、前回スコア、moment 数（ある場合）、80 文字までのテキスト |
| `/nep mentor remove <id>` | ケースを削除 |
| `/nep mentor run <id>` | 1 つのケースのフルサイクルを実行。開始した旨を即時応答。管理チャンネル（`bot.dryRunChannelId`）がある場合はそこにレポートを投稿。ない場合は `/nep mentor status` と `/nep mentor show <id>` を案内 |
| `/nep mentor check` | 実行記録のあるすべてのアクティブケースの保存済み状況を再プレイし、状況ごとに `mentor.check.samples` サンプル（実際の moment は `mentor.anchor.samples` を使用）。管理チャンネルがある場合は統合レポートを投稿。ない場合は `/nep mentor status` と `/nep mentor show <id>` を案内 |
| `/nep mentor stop` | 実行中のランをキャンセル（進行中のモデル呼び出しを含む） |
| `/nep mentor show <id>` | 前回ランのレポート: 状況、回答、スコア、コメント、および診断（存在する場合） |
| `/nep mentor wrong <id> <reason>` | そのケースの判定が誤っていたことと理由を mentor に伝える。今後のスコアリングの反例として保存 |
| `/nep mentor status` | モデル、有効/無効、本日のトークン使用量/上限、状態別ケース数、実行中のラン（停止保留中は `, stopping` を表示）、および最近完了したラン（`last:`）: ケース、結果、overall 中央値、スコアリング済み回答数、トークン数、完了時刻 |
| `/nep access grant <command> [role] [user]` | コマンド、グループ、または `*` を全員（デフォルト）、ロール、またはユーザーに開放。`private.*`、`mentor.*`、`access.*` は除外; 上記参照 |
| `/nep access revoke <command> [role] [user]` | 以前のグラントを全員（デフォルト）、ロール、またはユーザーから取り消し |
| `/nep access list` | 現在のアクセスグラント一覧を表示 |

## メンバーコマンド

`/nep pings` は、`bot.access` のグラントなしにすべてのサーバーメンバーが使用できる唯一のコマンドです。`features.memberCommands: false` でオーナーのみに制限されます。

| コマンド | 説明 |
|---|---|
| `/nep pings [mode]` | ペルソナのメッセージからの通知を受け取るかどうかを表示・変更します。`mode` なし: 現在の設定を表示。`on` / `off`: 設定を切り替え。オフの場合、あなたのメッセージへのリプライにリプライピングが付かず、ペルソナのテキスト内のあなたへの @メンションは表示されますが通知は送信されません。ペルソナの文面は変わりません。エフェメラルな応答: `Pings: on` または `Pings: off`。サーバーごとに保存され、再起動後も維持され、`/nep memory wipe` でのみ削除されます |
