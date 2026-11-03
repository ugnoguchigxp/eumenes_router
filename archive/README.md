# archive — 検証済み・メインに採らない実装

ここにあるものは **ARCHIVED**（2026-11-03）。検証は済んでいて、結論も出ている。メインの判断の実装は best-v2（`bench/router/experiments/best/best_v2.py`）で、ここのコードはパッケージ（tarball）にも入らない。同じ改善をやり直さないための証跡として、コード・実測データ・結論を残す。数値の詳細は `docs/reports/router_verifications_2026-11-03.md` にある。

| フォルダ | 問い | 結論 | 実測データ |
| --- | --- | --- | --- |
| `llm-verify/` | best-v2 が LLM に回す回（25.8%）を、LLM（Haiku）に「はい／いいえ」か候補一覧で確かめさせると、精度とトークンはどうなるか | 学習なしの ruri 版では、最良の設定（はい／いいえ・上位3件・400字で切る・effort low）で 1位を採るより +5件（86.6%）、Haiku 25,500 トークン（56件）。LARM の ruri 版では 88.0%、19,572 トークン（50件）だが、LLM なしでも 86.6%。候補一覧方式はトークンが多く正解も減った。誤った「はい」は会話の候補との境目と browser.operate／web.service-search の組に固まる。**LLM の確認は採らない（LLM なしの best-v2 を基本にする）** | `llm-verify/results/2026-11-03/` |
| `larm-context/` | LARM の文脈判定（`ruri-conv20-s0-fp32-v1`）を単体の Router として使えるか | test 83.2%（best-v2 の LLM なし 84.3% とほぼ同じ）。履歴と記憶を使えず、言い換えに弱い（音声入力風 −14.5pt）。**単体では採らない**。ただし点数を best-v2 の ruri に入れると 86.6%（+2.3pt）、回す率 23.0%（`swap`・`score-all` がその入力を作った） | `larm-context/results/2026-11-03/` |
| `variants-check/` | 手で書いた言い換え 1,215件が元と同じ意味かを Haiku に判定させられるか | 238件を「違う」としたが、見直すと 223件は Haiku の誤り（遠回し・省略・音声の誤変換を意味違いと見る）。直したのは 15件。**判定は人の見直しが前提で、単独では使えない** | `variants-check/results/2026-11-03/` |

## アーカイブしていないもの（メイン）

| もの | 場所 |
| --- | --- |
| best-v2（メインの判断） | `bench/router/experiments/best/best_v2.py`（`eval`・`export`・`predict`・`export-ranked`）、`bench/router/route.ts` |
| 言い換えの評価セット（本文は `data/variants-v2/` だけ、Git 管理外） | 集計は best-v2 の `eval` の `variants` |
| 訂正の記憶の測定と設定（θ 0.9177、β 1.5、正解を候補に足す） | `bench/router/correction.ts`（`--theta dev`・`--beta`・`--split`・`--external`・`--rerank-all`）、`src/route.ts`・`src/db/cards.ts` の `include` |

## 実測データの扱い

リポジトリに置いたのは、発話の本文を含まないものだけ（id・候補・点数・トークン・集計）。発話、言い換えの文、Haiku の答えの文、見直しの理由は落とした。本文が要る入力（`verify-items*.jsonl`、`variants.final.jsonl`、`rerank-larm-all.json`、`corr*/`）は `data/` にだけある。

## 動かすとき

- `llm-verify/tokens.py`：`--provider anthropic` は `uv run --no-project --with anthropic==2.4.0 python archive/llm-verify/tokens.py ...`。キーとモデルはリポジトリ直下の `.env`
- `larm-context/context.py`：`config.json`（Git 管理外）と環境変数の `LARM_API_TOKEN`。macOS では LAN に出られる `/usr/bin/python3` で動かす
- `variants-check/check.py`：`llm-verify/tokens.py` の provider を使う
