# コマンド

チャンネル、ロール、ユーザーは Discord 標準のピッカーから選択します。`set`/`unset` と `access grant`/`access revoke` では `path`/`command` オプションがオートコンプリートされます。

`/nep` は最初からすべてのメンバーに表示されます。アクセスはコマンド実行時にコマンド単位でゲートされ、Discord 自体のコマンド表示設定は使いません。オーナー（`bot.owners`）はすべてのコマンドを常に実行できます。それ以外のユーザーにはグラントが必要です。`/nep access grant <command> [role] [user]` で一つのコマンドキー（例: `memory.show`）、グループ全体（例: `memory`）、またはすべてのコマンド（`*`）を、全員（ロール/ユーザー指定なし）、ロール、またはユーザーに開放します。`/nep access revoke` でグラントを取り消し、`/nep access list` で現在のグラント一覧を表示します。グラントのないオーナー以外のユーザーが `/nep` を実行すると、エフェメラルな「Not allowed」の応答が返ります。`private.show`、`private.forget`、`private.purge` はオーナー専用で、すべてのグラントから除外されます。`access grant` はこれらを拒否し、`access list` にも表示されません。`mentor` グループも同様にオーナー専用で、グラントできません。

| コマンド | 説明 |
|---|---|
| `/nep status` | モデル、キャリブレーション、クォータ（画像カウントと画像モデルを含む）、ギルドごとのメモリ状況、プライベートチャットのオン/オフとプライベートファイル数を表示 |
| `/nep reload` | 設定とプロンプトを即時リロード |
| `/nep ping [role]` | 一つまたはすべてのモデルロール（`talk`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`）にミニマルリクエストを送信し、モデル、レイテンシ、プロバイダー、トークン数またはエラーを報告。`classifier.video` の後に `youtube: API key — {status}`（例: `ok`、`not needed (yt-dlp ok)`、`missing (blocked)`）を報告。`classifier.text` の後に `web: API key — {status}`（`ok`、`missing`、`off`）を報告。`llm.maxRequestsPerDay` にカウントされず、一時停止中やウォームアップ中でも動作 |
| `/nep pause` | すべてのアクティビティを停止し、メモリをディスクにフラッシュしてアンロード。一時停止中は `data/` を安全に編集可能 |
| `/nep resume` | `data/` からメモリをリロードして再開。JSON ファイルがパースできない場合は拒否し、壊れたファイル名を表示 |
| `/nep interject [channel]` | そのチャンネルの会話に今すぐ割り込む |
| `/nep initiate [channel]` | そのチャンネルで今すぐ話題を切り出す |
| `/nep draw <text> [self]` | 描画プロンプトを通じて 1 枚の画像を描く。応答は本人のみ（エフェメラル、画像添付）。`image.maxPerDay` の残高を消費するがメンバーのクォータにはカウントしない。一時停止中は拒否。`features.imageGeneration` に依存しない |
| `/nep set <path> <value>` | 設定値をオーバーライド（`config.local.json` に書き込み） |
| `/nep unset <path>` | 設定のオーバーライドを削除 |
| `/nep rule add <text>` | `prompts.local/rules.md` にルールを追記 |
| `/nep rule list` | ルール一覧を番号付きで表示 |
| `/nep rule remove <number>` | 番号指定でルールを削除 |
| `/nep model show` | 各ロール（`talk`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`）のアクティブなモデルを表示 |
| `/nep model set <role> <id>` | ロール（`talk`、`analyzer`、`classifier.text`、`classifier.media`、`classifier.video`、`mentor`）のモデルを設定 |
| `/nep memory show <user> [section] [limit] [order]` | セクション指定なし: コンパクトな要約。セクション: `character`、`style`、`relationship`、`affinity`、`aliases`、`interests`、`details`、`episodes`、`raw`（保存された JSON）。リスト系セクションは `limit` 1..100（デフォルト 25）と `order`: `rank`（デフォルト、表示上限で区切り線あり）または `recent` を指定可能。保存されたメンバー参照は現在の名前に解決されるが、`raw` では解決しない |
| `/nep memory channel [channel]` | チャンネル指定あり: 保存されたノートの全文（目的、トピック、トーン、メッセージ数、アクティビティ、トップライター）。指定なし: ペルソナが把握している全チャンネルの一覧（最終メッセージ順） |
| `/nep memory server` | サーバー全体のノート: 会話のしかた、会話の始め方、内輪ネタ、自己言及、およびプロファイル・チャンネル・ロアブックエントリの件数 |
| `/nep memory refresh <user>` | メンバーのポートレートを強制リフレッシュ |
| `/nep memory forget <user>` | 保存されたプロファイルとプライベートメモリを削除 |
| `/nep memory affinity <user> [score] [reason]` | 態度を表示または設定（-100..100） |
| `/nep memory wipe <confirm>` | このサーバーのアナライザーメモリをすべて消去（プライベートファイル含む）。確認のためサーバー名を正確に入力 |
| `/nep private show <user>` | メンバーのプライベートメモリを表示: リレーションシップ、インタレスト、ディテール、エピソード、プライベートと実効アティチュード、本日のリプライ数。プライベートレイヤーなしの場合はプレーン応答。オーナー専用; グラント不可 |
| `/nep private forget <user>` | メンバーのプライベートメモリのみを削除。公開プロファイルは保持。オーナー専用; グラント不可 |
| `/nep private purge <user>` | メンバーとの DM チャットにおけるボット自身のメッセージを削除（最大 `private.purgeMaxMessages` 件をスキャン）し、プライベートメモリも削除。メンバー自身のメッセージは残る。一時停止中は拒否。オーナー専用; グラント不可 |
| `/nep alias add <user> <name>` | チャット用エイリアスを追加（即時確定） |
| `/nep alias remove <user> <name>` | チャット用エイリアスを削除 |
| `/nep learned list` | レッスンの一覧を表示（ID、教えた人、観測回数付き） |
| `/nep learned add <text>` | レッスンを手動で追加（教師なし、確定済み） |
| `/nep learned remove <id>` | レッスンを削除 |
| `/nep lore add <title> <keys> <text> [always]` | ロアブックエントリを追加または上書き。同じタイトルのエントリは置き換えられオーナー所有になるため、アナライザーは以後編集しない |
| `/nep lore list [query]` | ロアブックエントリ一覧を表示 |
| `/nep lore show <id>` | ロアブックエントリを表示 |
| `/nep lore remove <id>` | ロアブックエントリを削除 |
| `/nep warmup run` | フルランを開始または再開: チャンネル、メンバー、サーバーの順 |
| `/nep warmup users [member]` | メンバー指定あり: そのメンバーのプロファイルを作成または再作成。指定なし: 対象となるすべてのメンバーを再プロファイル |
| `/nep warmup channels [channel]` | チャンネル指定あり: そのチャンネルを記述または再記述。指定なし: 読み取り可能な全チャンネル |
| `/nep warmup server` | サーバーノートとロアブックを再構築 |
| `/nep warmup people` | 対象メンバー一覧を表示 |
| `/nep warmup status` | ウォームアップの進捗とトークン使用量を表示 |
| `/nep warmup stop` | 実行中のウォームアップ作業を即時終了。進行中のリクエストはキャンセルされ、進捗は保持されるため `run` で再開可能 |
| `/nep warmup reset` | ウォームアップの進捗のみをクリア（保存されたメモリは消去しない） |
| `/nep mentor add <text> [target]` | ケースを追加: ペルソナに期待する行動を自分の言葉で。`target` は `reply`（デフォルト）または `memory`。ケース id を返答 |
| `/nep mentor cases` | ケース一覧: id、状態（`new`、`passing`、`failing`）、ターゲット、前回スコア、80 文字までのテキスト |
| `/nep mentor remove <id>` | ケースを削除 |
| `/nep mentor run <id>` | 1 つのケースのフルサイクルを実行。開始した旨を即時応答。レポートは管理チャンネルに送信 |
| `/nep mentor check` | 実行記録のあるすべてのアクティブケースの保存済み状況を再プレイし、状況ごとに `mentor.check.samples` サンプルで、1 つの統合レポートを投稿 |
| `/nep mentor stop` | 実行中のランをキャンセル（進行中のモデル呼び出しを含む） |
| `/nep mentor show <id>` | 前回ランのレポート: 状況、回答、スコアとコメント |
| `/nep mentor wrong <id> <reason>` | そのケースの判定が誤っていたことと理由を mentor に伝える。今後のスコアリングの反例として保存 |
| `/nep mentor status` | モデル、有効/無効、本日のトークン使用量/上限、状態別ケース数、実行中のラン |
| `/nep access grant <command> [role] [user]` | コマンド、グループ、または `*` を全員（デフォルト）、ロール、またはユーザーに開放。`private.*` と `mentor.*` は除外; 上記参照 |
| `/nep access revoke <command> [role] [user]` | 以前のグラントを全員（デフォルト）、ロール、またはユーザーから取り消し |
| `/nep access list` | 現在のアクセスグラント一覧を表示 |
