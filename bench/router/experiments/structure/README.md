# 構造の判断（本流、plan.md §10 M3b）

本流（2026-11-04、利用者の判断: トークンよりこの判定を優先する）は、**構造の判断（S3: LLM）→ 参照を「これ」に伏せる振り分け（mask）・述語を借りる（borrow）→ 依頼の部分ごとに best-v2（ツールの候補 10件）→ 送り先（担当・パイプラインの段・会話）**。参照の種類の手がかり（`referencedResource`）は、文全体を振り分けるときだけ使う。評価データ（`data/structure/`）は会話の本文を含むので Git に入れない。ここには道具だけを置く。サーバーは立てない（e5 と ruri はスクリプトの中で読み、LLM と LARM は API）。

| ファイル | すること |
| --- | --- |
| `../../structure.ts` | `build`（評価セットの検査と書き出し）、`requests`（振り分ける部分の一覧）、`score`（今の経路・正しい構造・構造の判断を同じ物差しで数える。`--half`・`--whole-hinted`）、`test-parts`・`test-score`（test 217件で今の経路との差）。送り先の規則は `decideStructure`・`routedTexts` |
| `s3.py` | 構造の判断（LLM、`.env` の `ROUTER_LLM_MODEL`・`ROUTER_LLM_EFFORT`）。担当は選ばせない。抜き出しが原文の一部でない構造は拒む（今の経路のまま）。続きから再開できる |
| `summary.py` | `score` の結果から §9 の合否の表を出す |

本流の値（2026-11-04、ツールの候補 10件の best-v2、LARM `ruri-conv20-structure-v1-s0-fp32-v1`、`claude-haiku-5-5`・effort low）: 作った対 186件で 90.3%、参照の側 1.3%、複数 → パイプライン 84.5%、単一 → パイプライン 0.9%、感想・質問 → 会話 100%。test 217件で 88.5%（今の経路 87.1%）。1発言 約 900 トークン、p95 2.9 s。記録は `docs/reports/data/2026-11-03/structure/report-mainline*.json`。

```bash
S=data/structure PY=<venv>/bin/python E5=intfloat/multilingual-e5-small KEY=local:e5-small A=data/best-v2-artifact-larm2-k10 RR=$S/larm2-merged.json
bun bench/router/structure.ts build --src $S/pairs.src.txt --real $S/real.src.txt --db $S/s0.db --out $S/items.jsonl --rows $S/rows.jsonl --rows-hints $S/rows-hints.jsonl
uv run --no-project --with anthropic==2.4.0 python bench/router/experiments/structure/s3.py $S/items.jsonl $S/s3.jsonl
bun bench/router/structure.ts requests --items $S/items.jsonl --structures S3=$S/s3.jsonl --out $S/req.rows.jsonl
$PY bench/router/experiments/best/e5cache.py $S/s0.db $E5 $KEY $S/rows.jsonl $S/req.rows.jsonl
# LARM の点数（合図の後）: archive/larm-context/context.py score-all で $RR を作る
for x in rows rows-hints req.rows; do bun run router route --model $KEY --db $S/s0.db --artifact $A --in $S/$x.jsonl --out $S/$x.out.jsonl --python $PY --url http://127.0.0.1:9 --rr-all $RR; done
bun bench/router/structure.ts score --items $S/items.jsonl --routes $S/rows.out.jsonl,$S/req.rows.out.jsonl --hinted $S/rows-hints.out.jsonl --whole-hinted --structures S3=$S/s3.jsonl --out $S/report.json
python3 bench/router/experiments/structure/summary.py $S/report.json S0+hints 'S3/mask'
```

`--url http://127.0.0.1:9` は使われない（ベクトルがキャッシュにあるので e5 のサーバーを呼ばない）。
