# eumenes_router

Eumenes の担当の振り分け（Toolchain Router）から、判断一式を切り出した研究用パッケージです。索引、採点の契約、訂正、決定表、評価を持ちます。Router の完成品ではなく、正解付きのデータで方式を実測し、勝った方式だけを tarball で Eumenes に戻します。

パッケージ名・リポジトリ・フォルダは `eumenes_router` です。作業の入口は [plan.md](plan.md)、作業規則は [AGENTS.md](AGENTS.md) です。

## 状態（2026-11-02）

| 項目 | 状態 |
| --- | --- |
| M0 判断一式と採点 | 実装済み。検査の内訳は下の「検証結果」 |
| 正解付け、方式の比較、出荷 | 未着手（M1 以降） |
| 408件・58会話のスナップショット | `data/` にある（Git 管理外）。正解は 0件。予測に候補ごとの確率は無いので、決定の一致も精度もこのファイルだけでは出せない |
| カード全文と、その回の仕事・確認待ち | 未了。書き出しは Eumenes のセッションで足す |

## 検証結果（2026-11-02）

精度の数値はない。live と本番機の計測もしていない。実行結果の `summary.json` や `report.md` も残っていない。

| 検証 | 結果 | 何を見たか |
| --- | --- | --- |
| `bun test` | 45件成功、387 expect | 決定表、訂正、検索の枠、`route()`、SQLite、到達性、採点器 |
| 決定の一致 | 202件で不一致 0 | `bench/parity.test.ts`。乱数の確率 200件と、手で書いた 2件を、Eumenes の `score.ts` の `decisionOf` と比較 |
| 訂正・決定表・予測集合 | 固定の1例で一致 | 同じテストで、Eumenes の `correctProbabilities`・`decide`・`predictionSet` と比較 |
| 408件・58会話の写し | 採点できない | 正解は空。候補ごとの確率は 0件。`data/router-eval/2026-11-01-snapshot/`（Git 管理外） |

202件は評価データの発言ではない。確率をこちらで作り、決定の関数だけを比べている。`route()` と Eumenes の `routerTurn` は比べていない。

## 採用している方式

製品の新しい経路を写している。検索の順位は埋め込みの最大内積で、そのあとにホストが渡す採点を1回、訂正、決定表、と進む。plan.md §8 の採点方式はまだ比べておらず、勝った方式はない。

| 段 | 今の実装 |
| --- | --- |
| 検索 | 発言の先頭 2000字を埋め込む。カードの文（「名前: 説明」、`useWhen`、`examples`）との内積の最大で順位を付ける。`route()` の枠は dedicated 10、pipeline 4、general 4。読む担当は dedicated の枠を使う。近いものだけに切らない。FTS は使わず、`ftsRank` は null。その空間にベクトルが無いときは、`read` 以外の有効なカードを id 順に返す |
| 採点 | ホストが渡す1回の choice。このパッケージはモデルを持たない |
| 訂正 | 類似度が θ 以上の訂正だけを使う（既定 0.95）。対数確率の移動は、1候補あたり β まで（既定 2）。正解の id が食い違う訂正は、どれも適用しない |
| 決定 | 行 1〜9 の決定表。既定は accept 0.6、low 0.3、margin 0.15、approve 0.85、multi 0.5。空の候補は行 8（会話） |

## 開発

Bun 1.4.4。実行時の依存はない。テストは `src/` を直接読む。

```sh
bun install
bun test
bun run typecheck
bun run lint
bun run format
```

配布物は `bun run build` で `dist/` を作る。`prepack` も同じことをする。研究用の採点は `bun run bench:score`（`bench/score.ts`）で、予測をこのパッケージの `decide` に通す。

`data/` は会話の本文を含む。Git に入れず、ログや外部にも出さない。LARM・Eumenes・推論サーバーは、このリポジトリから起動しない。

## 公開口

契約の詳細は plan.md §4。ホストが transaction、時計、id、指示文、動的候補の文を持つ。

| import | 内容 |
| --- | --- |
| `eumenes_router` | `route`、`decide`、`correctProbabilities`、`predictionSet`、`offerCandidates`、`checkReachability`。DB・時計・乱数・ネットワーク・モデルには触らない |
| `eumenes_router/sqlite` | 借りた同期接続への `migrateInTransaction`、`syncCardsInTransaction`、`saveVectorsInTransaction`、`candidatesInTransaction`、`nearFeedback`、`recordFeedbackInTransaction`、`setFeedbackStateInTransaction`、`forgetInTransaction`。open/close・transaction はしない |

`route()` は、ホストが渡した埋め込みと採点を順に呼び、そのあいだで検索と近傍訂正を同期で読む。空の候補は行 8（会話）で、採点は呼ばない。補正が衝突した訂正の id は `explain.conflicts` に入る。行を `conflict` にするのはホストである。会話と記憶の文は `passages` か `dynamic` で渡す。このパッケージは文を作らない。

## リポジトリ

```text
src/        出荷する。公開口は index.ts と sqlite.ts
bench/      研究専用。評価の採点。出荷しない
test/       bun test
data/       Git 管理外。評価データ、カードの写し、埋め込み、実行結果
inspector/  未作成。正解付けの画面（M1）
```

## ライセンス

[MIT](LICENSE) です。`package.json` の `license` も `MIT` です。

## 評価の土台（`bun run router`）

Eumenes なしで、担当の選び方（アルゴリズム）を同じ物差しで比べるための CLI。生成モデルは呼ばない。正解付けはレビュー担当がシートを読んで行う。

| コマンド | すること |
| --- | --- |
| `import --db b.db --cards … --utterances … --choices … --labels …` | カード・発言・過去の選択・正解を独立した SQLite に入れる（FTS5 trigram の索引も作る） |
| `label export --db b.db --out sheet.jsonl --md sheet.md [--model m]` | 未ラベルの発言を、迷いやすい順に正解付けシートとして書き出す |
| `label import --db b.db --labels labels.jsonl` / `label stats` | 正解（`gold`・`acceptable`・`none`・`status: reviewed|hold`・`wrong`）を入れる。split は会話単位で決まる |
| `embed --db b.db --provider http --url <base> --model <m>` | 利用者が動かしている OpenAI 互換 `/v1/embeddings` を呼ぶ。model＋本文の hash で SQLite にキャッシュ。`--provider fake` はテスト用の決定的なベクトル |
| `run --db b.db --algo fts\|embed\|hybrid [--model m] [--split test] [--feedback]` | 共通の経路（候補 8 件＋会話、softmax、訂正、製品の決定表）で採点し、`out/<日時>-<algo>/` に `summary.json`・`report.md`・`predictions.jsonl` を書く |
| `score --run <dir>` / `compare [--root out]` | 1 回分の要約／複数回の比較表 |

アルゴリズムは `bench/router/algorithms.ts` の `Algorithm`（発言・文脈ヒント・候補 → 候補ごとの点数）を足すだけで差し込める。`bench/fixtures/example/` は配線確認用の合成データで、そこでの値は精度ではない。
