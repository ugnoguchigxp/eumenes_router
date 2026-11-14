# eumenes_router

Eumenes の依頼を、会話または登録済みの担当へ振り分けるパッケージです。検索で依頼ごとに最大5件を絞り、選択モデルに候補の説明・検索順位・マッチ度を渡します。

| モード | 入力と結果 |
| --- | --- |
| 会話込み（既定） | 発言と必要な文脈を渡します。構造判断で会話、保留への回答、取消、新規依頼を判別し、新規依頼では候補 ID・会話・聞き返し・該当なしを選べます。複数依頼は各依頼の担当と依存順が揃えばパイプラインへ渡します。 |
| ツール専用 | 担当を探す依頼を渡し、`mode: "tools-only"` を指定します。ツール候補 ID・聞き返し・該当なしを返します。 |

試作時の比較と採用経緯はリポジトリの `plan.md` §14 に記録しています。

## OpenAI に候補を選ばせる

`routeWithSelection` は、既存の検索から各依頼につき最大5件を選び、候補 ID、説明、検索順位、マッチ度をホストの `select` に渡します。マッチ度には同じ検索内で比較できる `srScores` の値（0〜1）を使います。既定では構造判断と会話への振り分けを含みます。ツール専用では、呼び出し側が担当を探したい依頼を渡します。

```js
import { routeWithSelection } from "eumenes_router";

const ports = { embed, read, select: requestStructuredOutput };
const withConversation = await routeWithSelection(ports, turn, { signal });
const toolsOnly = await routeWithSelection(ports, turn, {
	mode: "tools-only",
	signal,
});
```

`select` は `{ version, system, user, outputSchema }` を受け、厳密な構造化出力の JSON を文字列で返します。構造判断に別の接続を使う場合は `analyze` を渡せます。ホストは `decision` を受け、候補の利用可能性と実行時の確認要否を検査します。聞き返しは `clarify`、該当なしは `unresolved` です。通信の失敗、期限切れ、不正な応答は例外として受け取り、確認や案内につなげます。ターンの取り消しも例外として伝わります。`parts` の候補と選択は判断の確認に使えます。

合成カタログで OpenAI Responses API への接続を試す入口です。推論設定は `reasoning.effort: none` です。環境変数 `OPEN_AI_API_KEY`（未設定の場合は `OPENAI_API_KEY`）を読み、指定されたモデル ID を使います。`--mode tools-only` を省略すると会話込みです。

```sh
bun bench/router/selection.ts --model '<model-id>' --text 'PDFを要約して'
bun bench/router/selection.ts --model '<model-id>' --mode tools-only --text 'PDFを要約して'
```

## ホストに接続する

| 公開口 | 契約 |
| --- | --- |
| `eumenes_router` | `routeWithSelection`、カードと結果の型、構造化応答の指示と検査、検索と到達性の関数を公開します。ホストは埋め込み、カードと索引の読み取り、構造判断と選択の接続を渡します。 |
| `eumenes_router/sqlite` | `migrations`、カード同期、ベクトル保存、検索、訂正の読み書き・忘却を公開します。ホストが接続とトランザクションを管理します。 |

入力 `turn` には `state: { text, previousAgent, previousUser }` と `available(id)` を指定します。任意で `resource`、進行中の担当 `retained`、会話込みで使う `pending`・`controls`・`dynamic` を渡せます。選択モデルへの送信は SQLite トランザクションの外で行います。近い訂正の候補補完は `settings.feedbackNear` で距離を、`settings.feedbackWeight` のゼロで無効化を指定できます。

配布契約 `route: 9` では、ホストは `routeWithSelection` を呼び、返された `decision` を使います。カードの同期、利用可能性の再検査、実行前の確認はホストが担います。

## 検証と配布

```sh
bun install --frozen-lockfile
bun test
bun run release
bun run verify:package release/manifest.json
```

配布スクリプトは型・lint・整形・Python 回帰・評価結果の再現を検査し、隔離した利用側から tarball の両モードと SQLite を確認します。出力は `release/` の tarball、SHA256、`manifest.json` です。過去の比較に使った方式は `bench/legacy/` で再現できます。

通常の`label export`は予測・過去の選択を表示せず、未確認・保留の発言を正解付け用に出力します。既存のモデル由来ラベルなども人が見直す場合は`--recheck`を付けます。既存のgoldを見せず、元のDBも変更しません。`--diagnostic`を明示したときだけ候補を表示する診断用の形式になります。`label audit --db … [--lineage data/lineage.jsonl] [--out data/audit.json]`は、会話・同文・明示した派生元系列の分割越えを件数で監査し、不整合なら失敗します。lineageは`{id, sourceId}`です。意味の同一性や人確認の出所を自動認定する機能ではありません。

## リポジトリ

| 場所 | 内容 |
| --- | --- |
| `src/` | 配布するルーティングと SQLite の公開口 |
| `bench/` | 評価と過去方式の再現 |
| `archive/` | 過去の試作と記録 |
| `data/` | Git 管理外の評価データと個別結果 |
| `docs/reports/` | 過去の検証結果 |

## 評価の土台（`bun run router`）

Eumenes なしで、担当の選び方（アルゴリズム）を同じ物差しで比べるための CLI。生成モデルは呼ばない。正解付けはレビュー担当がシートを読んで行う。

| コマンド | すること |
| --- | --- |
| `import --db b.db --cards … --utterances … --choices … --labels …` | カード・発言・過去の選択・正解を独立した SQLite に入れる（FTS5 trigram の索引も作る） |
| `label export --db b.db --out data/sheet.jsonl --md data/sheet.md` | 未確認・保留の発言を予測なしで正解付け用に書き出す。診断用は`--diagnostic [--model m]` |
| `label import --db b.db --labels labels.jsonl` / `label stats` | 正解（`gold`・`acceptable`・`none`・`status: reviewed|hold`・`wrong`）を入れる。split は会話単位で決まる |
| `embed --db b.db --provider http --url <base> --model <m>` | 利用者が動かしている OpenAI 互換 `/v1/embeddings` を呼ぶ。model＋本文の hash で SQLite にキャッシュ。`--provider fake` はテスト用の決定的なベクトル |
| `run --db b.db --algo fts\|embed\|hybrid [--model m] [--split test] [--feedback]` | 共通の経路（候補 8 件＋会話、softmax、訂正、従来の決定表）で採点し、`out/<日時>-<algo>/` に `summary.json`・`report.md`・`predictions.jsonl` を書く |
| `score --run <dir>` / `compare [--root out]` | 1 回分の要約／複数回の比較表 |

アルゴリズムは `bench/router/algorithms.ts` の `Algorithm`（発言・文脈ヒント・候補 → 候補ごとの点数）を足すだけで差し込める。`bench/fixtures/example/` は配線確認用の合成データで、そこでの値は精度ではない。

## 依存更新と復元の確認

Routerの変更担当が依存変更の責任を持ち、固定版・出所・宣言されたライセンスを確認します。実行時の外部依存はありません。開発用JS依存はMIT/Apache-2.0の宣言を確認し、Pythonの数値検査環境は別のハッシュ付きlockで固定します。変更前に`bun audit --json`と、固定Python依存の既知脆弱性監査を行い、差分と到達する実行経路を確認します。監査で検出なしでも脆弱性が存在しない保証にはしません。

更新時は`bun install --frozen-lockfile`と上記Python環境を別の作業用環境で再現し、`bun run release`で通し検査します。出荷manifestには検査対象ソースのdigestも記録し、検査中に変更があれば出荷しません。配布物のリンク等は展開前に拒否します。

SQLiteはホストが接続・transaction・backupを所有します。書込み失敗はホストtransactionをrollbackしてからpendingを読み直します。再起動後は同じ埋め込み空間のデータを読み込みます。古いbackupから復元する場合、ホストはbackup以降の忘却要求を再適用してから利用を再開してください。実ホストでの更新・復元はEumenes側のセッションで検証します。
