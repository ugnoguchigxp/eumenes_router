# eumenes_router

Eumenes の担当の振り分け（Toolchain Router）から、判断一式を切り出した研究用パッケージです。索引、採点の契約、訂正、決定表、評価を持ちます。Router の完成品ではなく、正解付きのデータで方式を実測し、勝った方式だけを tarball で Eumenes に戻します。

パッケージ名・リポジトリ・フォルダは `eumenes_router` です。作業の入口は [plan.md](plan.md)、作業規則は [AGENTS.md](AGENTS.md) です。

## 状態（2026-11-03）

| 項目 | 状態 |
| --- | --- |
| M0 判断一式と採点 | 実装済み。検査の内訳は下の「検証結果」 |
| 本流（利用者の判断、2026-11-04） | 2つの構成をどちらも採り、パッケージの入口 `route`（A）と `routeStructured`（B）にした（tarball 1つ、`bun run release`）。**A（direct）: best-v2 だけ（ツールの候補 10件）**、**B（structured）: 構造の判断（LLM）→ 参照を伏せる振り分け → 依頼の部分ごとに best-v2**。1つの tarball に両方を入れ、Eumenes 側が呼ぶ関数で選んで試す（plan.md M3d、計画）。best-v2 の判定（`loadBestV2`・`scoreBestV2`）と学習済みの数値（`BEST_V2_PARAMS`）はパッケージに入れた。構造の判断の部品（`src/structure.ts`）と送り先の規則もパッケージに入れた。bench の測定と同じ値になることを、製品の入口から確かめた（`test/route-mainline.test.ts`） |
| M2 方式の比較 | 途中。オフラインの精度・言い換え・訂正は測った。本番機の速度と会話 LLM への干渉、新しい担当の cold start は未測定 |
| 検証して採らなかった実装 | `archive/`（ARCHIVED。LLM による確認、LARM の文脈判定の単体利用、言い換えの意味の Haiku 判定、構造の判断、ruri の学習データの道具、round2・round3・algo4）。結論と実測は [docs/reports/router_verifications_2026-11-03.md](docs/reports/router_verifications_2026-11-03.md) |
| 構造の判断 | 本流（LLM、S3）。作った対 186件で 90.3%（今の経路＋手がかり 47.3%）、参照の側 1.3%、複数 → パイプライン 84.5%、感想・質問 → 会話 100%。test 217件 88.5%（今の経路 87.1%）。1発言 約 900 トークン・p95 2.9 s。係り受け解析（S1）と候補 5 は `archive/structure-judgment/`。LARM の ruri は構造の学習の対を足して学習し直した（`ruri-conv20-structure-v1-s0-fp32-v1`） |
| 正解付け（M1）、出荷（M3） | 未着手。bench の正解ラベルは grok-bot の推論由来で、人の確認はまだ |
| 408件・58会話のスナップショット | `data/` にある（Git 管理外）。正解は 0件。予測に候補ごとの確率は無いので、決定の一致も精度もこのファイルだけでは出せない |
| カード全文と、その回の仕事・確認待ち | 未了。書き出しは Eumenes のセッションで足す |

## 検証結果（2026-11-03）

test 217件（評価は1回）と、test から作った言い換え 1,215件。正解ラベルは grok-bot の推論由来（人の確認はまだ）。詳細は [docs/reports/router_verifications_2026-11-03.md](docs/reports/router_verifications_2026-11-03.md)、実測データ（本文なし）は `docs/reports/data/2026-11-03/` と `archive/*/results/`。

| 構成（LLM なし、1位を採る） | test top1 | LLM に回す率 | 言い換え top1 |
| --- | --- | --- | --- |
| 今の構成（baseline） | 70.0 | 29.5% | — |
| best-v2（学習なしの ruri） | 84.3 | 25.8% | 77.2 |
| best-v2（LARM の旧 network の点数） | 86.6 | 23.0% | 80.2 |
| best-v2（LARM の学習し直した ruri の点数） | 85.7 | 20.7% | 81.0 |
| 同上 ＋ ツールの候補 10件（パッケージの版、改善の候補 2） | 87.1 | 18.0% | 81.6 |
| **本流: 構造の判断（LLM）＋ 参照を伏せる ＋ 上の best-v2** | **88.5** | — | — |
| LARM の文脈判定だけ（不採用） | 83.2 | — | 74.5 |

| 検証 | 結果 |
| --- | --- |
| best-v2 の TS 移植と `best_v2.py` の一致 | test＋言い換え 1,432件で、並びと回す判定がすべて一致。確率の差 ≤ 3.6×10⁻⁸。1件 0.094 ms |
| 訂正の記憶（θ 0.9177・β 1.5・正解を候補に足す） | 訂正した発話 76.2%、その言い換え 68.2% が直る。関係ない発話の崩れ 0%（166件）。回復率 ≥ 90% は未達 |
| パッケージだけの経路（全文検索 → sr-corr → 上位8件と全カードの順位 → 上位10件のツールの reranker → best-v2） | bench の sr-corr と全 1,671 発言で一致。test＋言い換えで best_v2.py と並びが全件一致し、test top1 87.1%・回す率 18.0%・言い換え 81.6% を再現（出荷する版。それ以前の版でも 85.7 / 20.7 / 81.0、旧 network の版で 86.6 / 23.0 / 80.2 を再現した） |
| LLM（Haiku）による確認（不採用） | LARM 版の best-v2 に足すと 86.6 → 88.0%、19,572 トークン（217回で 1回 90） |

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

本流は2つの構成（plan.md M3d）。A は「検索 → best-v2」。B は「構造の判断（LLM、`bench/router/experiments/structure/s3.py`）→ 送り先の規則（`decideStructure`）→ 依頼の部分ごとに best-v2」。構造の判断は、依頼の部分・作る物・参照（材料）・先に済ませる依頼を返す（担当は選ばない）。依頼なしは会話、依頼1つは参照を「これ」に伏せた文を振り分け、担当が2つ以上ならパイプラインの段へ送る。

メインの判断は **best-v2**（`src/scoring/best-v2.ts`）。劣る方式（best-v1、algo4、round2/3、LLM による確認、LARM の文脈判定の単体利用、検索と reranker の単純な融合）はパッケージに入れない。

| best-v2 の段 | 中身 |
| --- | --- |
| 候補 | 検索の上位 8件のうち reranker の点数がある担当と、会話。加えて、検索の全カードの順位の上位 10件のツールのうち、そこに入っていなくて reranker の点数があるもの（追加の候補。検索の確率は 0、順位と点数は全カードの順位から） |
| 融合 | softmax（検索の確率 ＋ 2 × reranker の点数。会話は 0.18 を足す） |
| 特徴 | 検索の確率・順位・生の点数、reranker の点数・順位・1位との差、融合の確率・順位、会話か、記憶の近傍の票（近い 10件、e5 の内積） |
| 判定 | 標準化 ＋ ロジスティック回帰（dev で学習、C 0.03）。1位と2位の確率の差が 0.2989 未満なら回す（LARM の学習し直した ruri の点数とツールの候補 10件で学習した版。以前の版は 0.2933、旧 network の版は 0.3222） |
| 学習済みの数値 | `BEST_V2_PARAMS`（`src/scoring/best-v2.params.ts`、`best_v2.py export-package` が書く）。発話から作ったものは入っていない |
| 記憶 | ホストが渡す（`BestV2Memory`: 正解の id ＋ float32 のベクトル）。dev の発話から作るので、パッケージにも Git にも入れない。数値と同じ `source` の記憶でないと拒む |

`route()` は製品の新しい経路を写している（best-v2 はまだ組み込んでいない）。

| `route()` の段 | 今の実装 |
| --- | --- |
| 検索 | 発言の先頭 2000字を埋め込む。カードの文（「名前: 説明」、`useWhen`、`examples`）との内積の最大で順位を付ける。`route()` の枠は dedicated 10、pipeline 4、general 4。読む担当は dedicated の枠を使う。近いものだけに切らない。FTS は使わず、`ftsRank` は null。その空間にベクトルが無いときは、`read` 以外の有効なカードを id 順に返す |
| 訂正の近傍と候補 | 採点の前に近い訂正を読み、その正解を `include` で候補に足す（枠の外でも。枠は使わない） |
| 採点 | ホストが渡す1回の choice。このパッケージはモデルを持たない |
| 訂正 | 類似度が θ 以上の訂正だけを使う（既定 0.95）。対数確率の移動は、1候補あたり β まで（既定 2）。正解の id が食い違う訂正は、どれも適用しない。e5 small の空間で測った値は θ 0.9177・β 1.5（ホストが `feedbackNear`・`feedbackWeight` で渡す） |
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

`data/` は会話の本文を含む。Git に入れず、ログにも出さない。LARM・Eumenes・推論サーバーは、このリポジトリから起動しない。

## 公開口

1つの tarball に本流の2つの入口が入っている（plan.md M3d）。ホストは呼ぶ関数で選ぶ。ホストが transaction、時計、id、モデルの呼び出し（埋め込み・reranker・構造の判断）、動的候補の文を持つ。構造の判断の指示文だけはパッケージが持つ（測った指示文と出荷する指示文を同じにするため、利用者の判断）。

| import | 内容 |
| --- | --- |
| `eumenes_router` | `route`（A: direct）、`routeStructured`（B: structured）、`decide`、`correctProbabilities`、`predictionSet`、`offerCandidates`、`checkReachability`、`loadBestV2`・`scoreBestV2`・`BEST_V2_PARAMS`、`srScores`・`srOffer`・`srRanking`・`capByKind`、`rerankDocument`、`STRUCTURE_PROMPT`・`structurePrompt`・`parseStructure`・`routedTexts`。DB・時計・乱数・ネットワーク・モデルには触らない |
| `eumenes_router/sqlite` | 表の SQL `migrations`（ホストが自分の migration で当てる）、借りた同期接続への `syncCardsInTransaction`、`saveVectorsInTransaction`、`srCardsInTransaction`、`lexicalInTransaction`、`importExamplesInTransaction`・`examplesInTransaction`（best-v2 の記憶）、`nearFeedback`、`recordFeedbackInTransaction`、`setFeedbackStateInTransaction`、`forgetInTransaction`。open/close・transaction はしない |

| 入口 | ホストの口 | 流れ | 結果 |
| --- | --- | --- | --- |
| `route(ports, turn)` | `embed`、`rerank`（LARM の文脈判定。基準ごとの `scores` が要る）、`read.cards`・`read.lexical`・`read.nearFeedback`、`model`（`loadBestV2(BEST_V2_PARAMS, 記憶)`）、`settings` | 埋め込み → 近い訂正 → sr-corr（上位8件と全カードの順位）→ 上位 10件のツール・訂正の正解・動的な候補 → reranker → best-v2 → 訂正 → 決定表（best-v2 が回さないときが「自信あり」。自信なしでも1位を予告付きで実行し、聞き返しの行 8 にはしない） | `decision`・`corrected`・`answer`・`explain`（gate・defer・衝突した訂正の id） |
| `routeStructured(ports, turn)` | `route` の口 ＋ `analyze`（`{ version, system, user }` を LLM に送り、答えの文字列を返す） | 構造の判断 → 検査（壊れていれば `route` と同じ）→ 依頼なしは会話、依頼1つは参照を「これ」に伏せた文（手がかりなし）、複数は依頼の部分ごとに `route` と同じ流れ → 担当が2つ以上ならパイプラインの段 | `decision`（行 9 の `to: "pipeline"` は依頼の部分ごとの担当と順番）・`structure`・`parts` |

reranker に渡すのは、本文の先頭 400字と、カードの文（`rerankDocument`: 1つ目の文と「例:」に続く5件）。会話の候補は reranker に送らない（best-v2 は会話の点数を使わない）。補正が衝突した訂正の id は `explain.conflicts` に入る。行を `conflict` にするのはホストである。会話と記憶はカードとして同期する（文は `passages` で差し替えられる）。記憶の候補は記憶のカードを同期したときだけ出る（会話のカードが無いときは、会話の候補だけをパッケージが足す）。best-v2 の記憶は発話から作るので tarball に入らない。ホストが `importExamplesInTransaction` で取り込む（`manifest.json` の `requires.memory`）。

出荷物は `bun run release` で作る（型・lint・検査が通ったときだけ）。`release/eumenes_router-<版>-<sha256の先頭12>.tgz`、`.sha256`、`manifest.json`（Git 管理外）。

## リポジトリ

```text
src/        出荷する。公開口は index.ts と sqlite.ts。best-v2 は src/scoring/
bench/      研究専用。評価の採点。出荷しない
archive/    ARCHIVED。検証して採らなかった実装と、その実測データ（本文なし）。出荷しない
docs/       報告。docs/reports/data/ は実測データ（本文なし）
test/       bun test
data/       Git 管理外。評価データ、カードの写し、埋め込み、実行結果、best-v2 の記憶
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
