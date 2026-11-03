# 構造の判断の実験（plan.md §10 M3b）

評価データ（`data/structure/`）は会話の本文を含むので Git に入れない。ここには道具だけを置く。サーバーは立てない（e5 と ruri はスクリプトの中で読む）。

| ファイル | すること |
| --- | --- |
| `../../structure.ts` | `build`（評価セットの検査と書き出し）、`requests`（振り分ける部分の一覧）、`score`（S0・S*・解析器を同じ物差しで数える）、`test-parts`・`test-score`（今の test で S0 との差） |
| `e5cache.py` | 新しい文の e5 small のベクトルを bench の DB のキャッシュに足す（`models.py serve` と同じ作り） |
| `s3.py` | S3: クラウドの LLM に構造を返させる（`.env` の `ROUTER_LLM_MODEL`・`ROUTER_LLM_EFFORT`）。担当は選ばせない。続きから再開できる |
| `mktrain.py` | S2: ruri の学習の対（キットの `{q, doc, label}`）。評価の文と同じか近すぎる文を外す |
| `summary.py` | `score` の結果から §9 の合否の表を出す |

```bash
S=data/structure PY=<venv>/bin/python
sqlite3 data/variants-v2/corr/corr.db ".backup $S/s0.db"
bun bench/router/structure.ts build --src $S/pairs.src.txt --real $S/real.src.txt --db $S/s0.db --out $S/items.jsonl --rows $S/rows.jsonl --rows-hints $S/rows-hints.jsonl
$PY bench/router/experiments/best/best_v2.py export --corr data/variants-v2/corr --artifact $S/best-v2-zs --python $PY --variants data/variants-v2/variants.final.jsonl
$PY bench/router/experiments/structure/e5cache.py $S/s0.db $S/rows.jsonl
bun run router route --db $S/s0.db --artifact $S/best-v2-zs --in $S/rows.jsonl --out $S/s0-rows.out.jsonl --python $PY --url http://127.0.0.1:9
uv run --no-project --with anthropic==2.4.0 python bench/router/experiments/structure/s3.py $S/items.jsonl $S/s3.jsonl
bun bench/router/structure.ts requests --items $S/items.jsonl --structures S3=$S/s3.jsonl --out $S/req.rows.jsonl
$PY bench/router/experiments/structure/e5cache.py $S/s0.db $S/req.rows.jsonl
bun run router route --db $S/s0.db --artifact $S/best-v2-zs --in $S/req.rows.jsonl --out $S/req.out.jsonl --python $PY --url http://127.0.0.1:9
bun bench/router/structure.ts score --items $S/items.jsonl --routes $S/s0-rows.out.jsonl,$S/req.out.jsonl --structures S3=$S/s3.jsonl --out $S/report.json
python3 bench/router/experiments/structure/summary.py $S/report.json S0 'S*/mask' 'S3/mask'
```

`--url http://127.0.0.1:9` は使われない（ベクトルがキャッシュにあるので e5 のサーバーを呼ばない）。
