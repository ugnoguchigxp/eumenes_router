#!/usr/bin/env bash
# User-correction → orthographic-variant experiment. CPU only, no API keys.
# Needs: a venv with torch(cpu) transformers<5 protobuf fugashi unidic-lite sentencepiece  (PY=...)
#        models in the HF cache: intfloat/multilingual-e5-small, cl-nagoya/ruri-v3-reranker-310m, hotchpotch/japanese-reranker-xsmall-v2
set -euo pipefail
cd "$(dirname "$0")/../../../.."
PY=${PY:-/tmp/cvenv/bin/python}; OUT=${OUT:-out/correct-$(date +%Y%m%d-%H%M%S)}
DIR=bench/router/experiments/correction
"$PY" $DIR/models.py serve 8765 > /tmp/corr-embed.log 2>&1 & SERVER=$!; trap 'kill $SERVER' EXIT
until grep -q ready /tmp/corr-embed.log; do sleep 1; done
bun run router correct --db ${DB:-data/bench-r2.db} --variants ${VARIANTS:-$DIR/variants.jsonl} --controls ${CONTROLS:-$DIR/controls.jsonl} \
  ${CORRECTIONS:+--corrections $CORRECTIONS} --rerank ${RERANK:-ruri,xs} --python "$PY" ${THETA:+--theta $THETA} --out "$OUT"
echo "report: $OUT/report.json"
