# archive — 検証済み・メインに採らない実装

ここにあるものは **ARCHIVED**（2026-11-03・2026-11-04）。検証は済んでいて、結論も出ている。本流は2つの構成（利用者の判断、2026-11-04。1つの tarball に両方を入れ、Eumenes 側が呼び方で選ぶ）: A は best-v2（ツールの候補 10件、`src/scoring/best-v2.ts`・`bench/router/experiments/best/best_v2.py`）だけ、B は構造の判断（LLM、`bench/router/experiments/structure/`）→ 参照を伏せる振り分け → 依頼の部分ごとに best-v2。どちらも LARM の学習し直した ruri の点数＋ sr-corr ＋ 訂正の記憶を使う。ここのコードはパッケージ（tarball）に入らず、本流の実行にも使わない。同じ改善をやり直さないための証跡として、コード・実測データ・結論を残す。数値の詳細は `docs/reports/router_verifications_2026-11-03.md` と `docs/reports/router_improvements_2026-11-03.md` にある。

| フォルダ | 問い | 結論 | 実測データ |
| --- | --- | --- | --- |
| `llm-verify/` | best-v2 が LLM に回す回（25.8%）を、LLM（Haiku）に「はい／いいえ」か候補一覧で確かめさせると、精度とトークンはどうなるか | 学習なしの ruri 版では、最良の設定（はい／いいえ・上位3件・400字で切る・effort low）で 1位を採るより +5件（86.6%）、Haiku 25,500 トークン（56件）。LARM の ruri 版では 88.0%、19,572 トークン（50件）だが、LLM なしでも 86.6%。候補一覧方式はトークンが多く正解も減った。誤った「はい」は会話の候補との境目と browser.operate／web.service-search の組に固まる。**LLM の確認は採らない（LLM なしの best-v2 を基本にする）** | `llm-verify/results/2026-11-03/` |
| `larm-context/` | LARM の文脈判定（`ruri-conv20-s0-fp32-v1`）を単体の Router として使えるか | test 83.2%（best-v2 の LLM なし 84.3% とほぼ同じ）。履歴と記憶を使えず、言い換えに弱い（音声入力風 −14.5pt）。**単体では採らない**。ただし点数を best-v2 の ruri に入れると 86.6%（+2.3pt）、回す率 23.0%（`swap`・`score-all` がその入力を作った） | `larm-context/results/2026-11-03/` |
| `variants-check/` | 手で書いた言い換え 1,215件が元と同じ意味かを Haiku に判定させられるか | 238件を「違う」としたが、見直すと 223件は Haiku の誤り（遠回し・省略・音声の誤変換を意味違いと見る）。直したのは 15件。**判定は人の見直しが前提で、単独では使えない** | `variants-check/results/2026-11-03/` |
| `structure-judgment/` | 構造の判断のうち、本流（LLM の S3）に採らなかった方式。係り受け解析（GiNZA）＋規則の S1 と、best-v2 の自信で分けるかを決める規則（候補 5） | S1 は作った対 test で今の経路＋手がかり 45.6 → 85.4%・p95 6.4 ms だが test 217件 87.1 → 85.7%（条件未達）。候補 5 は作った対で −6.5pt。**本流に入れない**。本流の構造の判断（S3＋mask＋best-v2）は作った対 90.3%・test 217件 88.5% | `structure-judgment/results/2026-11-03/` |
| `ruri-training/` | ruri（reranker）の学習データの道具。bench の FT の kit（`finetune/`）と、構造の学習の対（`mktrain.py`） | 本流の LARM の network（`ruri-conv20-structure-v1-s0-fp32-v1`）は、kit の dev の学習セットに `mktrain.py` の 290組を足して LARM 側で学習した。学習は LARM 側で行うので、ここの道具は本流の実行に使わない。出どころとして残す | `docs/reports/data/2026-11-03/structure/train-manifest.json` |
| `round2/`・`round3/`・`algo4/` | best-v2 に至るまでの探索（検索の重みの格子・言い換え、sr と過去の選択のカスケードと reranker、候補の特徴と kNN の LR） | best-v2 に置き換わった（best-v2 は algo4 の特徴と best-v1 の枠組みを使う）。`round3/dump.ts` は `ruri-training/finetune` の入力を作る | `bench/router/experiments/best/report-*.json` |

## アーカイブしていないもの（メイン）

| もの | 場所 |
| --- | --- |
| best-v2（本流の判断、ツールの候補 10件） | `src/scoring/best-v2.ts`・`src/retrieval/sr.ts`、`bench/router/experiments/best/best_v2.py`（`eval`・`select`・`export`・`predict`・`export-ranked`・`export-package`・`export-parity`）、`compare.py`・`rescore.py`・`srfull.ts`・`e5cache.py`、`bench/router/route.ts` |
| 言い換えの評価セット（本文は `data/variants-v2/` だけ、Git 管理外） | 集計は best-v2 の `eval` の `variants` |
| 本流の2つの入口（パッケージ） | `src/route.ts` の `route`（A: best-v2 だけ）と `routeStructured`（B: 構造の判断＋best-v2）、`src/structure.ts`。出荷物は `bun run release` |
| 構造の判断の測定（本流 B の評価） | `bench/router/structure.ts`（`decideStructure`・`routedTexts`）、`bench/router/experiments/structure/`（`s3.py`・`summary.py`） |
| 訂正の記憶の測定と設定（θ 0.9177、β 1.5、正解を候補に足す） | `bench/router/correction.ts`（`--theta dev`・`--beta`・`--split`・`--external`・`--rerank-all`）、`src/route.ts`・`src/db/cards.ts` の `include` |

## 実測データの扱い

リポジトリに置いたのは、発話の本文を含まないものだけ（id・候補・点数・トークン・集計）。発話、言い換えの文、Haiku の答えの文、見直しの理由は落とした。本文が要る入力（`verify-items*.jsonl`、`variants.final.jsonl`、`rerank-larm-all.json`、`corr*/`）は `data/` にだけある。

## 動かすとき

- `llm-verify/tokens.py`：`--provider anthropic` は `uv run --no-project --with anthropic==2.4.0 python archive/llm-verify/tokens.py ...`。キーとモデルはリポジトリ直下の `.env`
- `larm-context/context.py`：`config.json`（Git 管理外）と環境変数の `LARM_API_TOKEN`。macOS では LAN に出られる `/usr/bin/python3` で動かす
- `variants-check/check.py`：`llm-verify/tokens.py` の provider を使う
