> **ARCHIVED（2026-11-04）**: best-v2 に至るまでの探索（カスケードと reranker）。best-v2 に置き換わった。`dump.ts` は `../ruri-training/finetune` の入力（`/tmp/r3/dump.json`）を作る。

# round-3 experiment scripts
1. `bun dump.ts` → /tmp/r3/dump.json (sr-cal と past の順位、dev+test、data/bench-r2.db)
2. `python3 cascade.py` / `cascade2.py` — A: sr→past カスケード、B: 候補集合の再現率
3. `python rerank.py <hf-model> <tag>`（torch CPU + transformers<5 + protobuf + fugashi/unidic-lite の venv）→ `python3 rreval.py <tag>` → `python3 cascade_rr.py <tag>`
