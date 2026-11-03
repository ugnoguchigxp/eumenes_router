# 言い換えの意味の判定（Haiku）

> **ARCHIVED（2026-11-03）。** 検証済み・単独では使わない。手で書いた言い換え 1,215件のうち 238件を Haiku が「元と違う」と判定したが、見直すと 223件は Haiku の誤りで、直したのは 15件（うち 13件が遠回し）。結論と数値は `archive/README.md` と `docs/reports/router_verifications_2026-11-03.md`。旧 `bench/router/experiments/variants/check.py`。

`check.py run` は言い換え1件ごとに1回、`../llm-verify/tokens.py` の provider で「同じ／違う」を聞く。`check.py stats` は種類ごとの件数と「違う」の行番号を出す。

実測データ（本文なし）は `results/2026-11-03/`：

| ファイル | 中身 |
| --- | --- |
| `summary.json` | 書いた件数、Haiku が「違う」とした件数、見直しの内訳、最終の件数（種類ごと） |
| `check-haiku-low.jsonl` / `.stats.json` | 1件ごとの判定（`answer` の文は落とした）と集計 |
| `review-1.jsonl` / `review-2.jsonl` | 見直しの判定（`keep`・`fix`・`drop`。直した文と理由は落とした） |

言い換えの本文（`variants.final.jsonl`）は `data/variants-v2/` にだけある（Git 管理外）。
