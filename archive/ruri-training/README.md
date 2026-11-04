# ruri の学習データの道具

> **ARCHIVED（2026-11-04）**: 本流の実行には使わない。本流の reranker は LARM の文脈判定（network `ruri-conv20-structure-v1-s0-fp32-v1`）で、学習は LARM 側（AI MAX 395）で行う。ここには、その学習データを作った道具を出どころとして残す。

| ファイル | 中身 |
| --- | --- |
| `finetune/` | bench の FT（`finetune.py`）と、LARM 側に渡す kit（`mkkit.py`、`kit/`）。kit の学習の対は dev だけから作る。入力は `../round3/dump.ts` が作る `/tmp/r3/dump.json` |
| `mktrain.py` | 構造の学習の対（依頼の側を正例、参照の側を難しい負例）。`data/structure/train.src.txt` から `data/structure/train/` を作る。評価の文と同じか e5 で 0.97 以上近い文は外す |

本流の network の学習データ: kit の dev の学習セット（seed 0、811組）＋ `mktrain.py` の 290組（63文、SHA-256 `dde18d7e…`）。集計は `docs/reports/data/2026-11-03/structure/train-manifest.json`。LARM 側の学習の記録は LARM にある。

```bash
python archive/ruri-training/mktrain.py data/structure/train.src.txt data/structure/items.jsonl data/structure/s0.db data/variants-v2/corr/rerank-in.json data/structure/train intfloat/multilingual-e5-small local:e5-small
```
