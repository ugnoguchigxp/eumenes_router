# eumenes-router

Eumenes の担当の振り分け（Toolchain Router）から、判断一式を切り出した研究用パッケージです。索引、採点の契約、訂正、決定表、評価を持ちます。Router の完成品ではなく、正解付きのデータで方式を実測し、勝った方式だけを tarball で Eumenes に戻します。

パッケージ名は `eumenes-router` です。リポジトリとフォルダの名前は `eumenes_router` です。作業の入口は [plan.md](plan.md)、作業規則は [AGENTS.md](AGENTS.md) です。

## 状態（2026-11-02）

| 項目 | 状態 |
| --- | --- |
| M0 判断一式と採点 | 実装済み。`bun test` 45件成功。確率つき予測 202件で、決定は Eumenes の `score.ts` と一致 |
| 正解付け、方式の比較、出荷 | 未着手（M1 以降） |
| 408件・58会話のスナップショット | `data/` にある（Git 管理外）。正解は 0件。予測に候補ごとの確率は無いので、決定の一致も精度もこのファイルだけでは出せない |
| カード全文と、その回の仕事・確認待ち | 未了。書き出しは Eumenes のセッションで足す |

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
| `eumenes-router` | `route`、`decide`、`correctProbabilities`、`predictionSet`、`offerCandidates`、`checkReachability`。DB・時計・乱数・ネットワーク・モデルには触らない |
| `eumenes-router/sqlite` | 借りた同期接続への `migrateInTransaction`、`syncCardsInTransaction`、`saveVectorsInTransaction`、`candidatesInTransaction`、`nearFeedback`、`recordFeedbackInTransaction`、`setFeedbackStateInTransaction`、`forgetInTransaction`。open/close・transaction はしない |

`route()` は、ホストが渡した埋め込みと採点を順に呼び、そのあいだで検索と近傍訂正を同期で読む。空の候補は行 8（会話）で、採点は呼ばない。補正が衝突した訂正の id は `explain.conflicts` に入る。行を `conflict` にするのはホストである。会話と記憶の文は `passages` か `dynamic` で渡す。このパッケージは文を作らない。

## リポジトリ

```text
src/        出荷する。公開口は index.ts と sqlite.ts
bench/      研究専用。評価の採点。出荷しない
test/       bun test
data/       Git 管理外。評価データ、カードの写し、埋め込み、実行結果
inspector/  未作成。正解付けの画面（M1）
```
