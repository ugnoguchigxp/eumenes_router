# 構造の判断: 本流に採らなかった方式

> **ARCHIVED（2026-11-04）**: 本流の構造の判断は LLM（S3、`bench/router/experiments/structure/`）。ここには、試して採らなかった方式を残す。結論は `docs/reports/router_improvements_2026-11-03.md` §4・§5、plan.md M3c。実測は `results/2026-11-03/`（本文なし）。

| ファイル | 方式 | 結論 |
| --- | --- | --- |
| `s1.py` | S1: 係り受け解析（GiNZA `ja_ginza` 5.3.0）＋規則。規則は構造の評価セットの dev 半分だけで作った | 作った対 test 半分で今の経路＋手がかり 45.6 → 85.4%、解析 p95 6.4 ms。test 217件 87.1 → 85.7%（説明の「〜ていて」・答え方の指定・言い直しの扱いの穴）。条件未達 |
| （コードは消した） | 候補 5: 分けたほうが良いときだけ分ける（best-v2 の自信で確かめる） | 作った対で 90.3 → 83.9%（−6.5pt）。best-v2 の自信は参照に引かれた誤りでも高い。不採用 |

S1 を動かすとき（GiNZA を入れた環境）: `python archive/structure-judgment/s1.py ja_ginza data/structure/items.jsonl data/structure/s1.jsonl [--half dev --show]`。採点は本流の `bench/router/structure.ts score --structures S1=…`。
