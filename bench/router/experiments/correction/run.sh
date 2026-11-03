#!/usr/bin/env bash
# User-correction → orthographic-variant experiment. CPU only, no API keys.
# Needs: a venv with torch(cpu) transformers<5 protobuf fugashi unidic-lite sentencepiece  (PY=...)
#        models in the HF cache: intfloat/multilingual-e5-small, cl-nagoya/ruri-v3-reranker-310m, hotchpotch/japanese-reranker-xsmall-v2
set -euo pipefail
cd "$(dirname "$0")/../../../.."
PY=${PY:-/tmp/cvenv/bin/python}; OUT=${OUT:-out/correct-$(date +%Y%m%d-%H%M%S)}
DIR=bench/router/experiments/correction
PORT=${PORT:-8765}; LOG=$(mktemp)
"$PY" $DIR/models.py serve "$PORT" > "$LOG" 2>&1 & SERVER=$!; trap 'kill $SERVER 2>/dev/null; rm -f "$LOG"' EXIT
until grep -q ready "$LOG"; do kill -0 $SERVER 2>/dev/null || { cat "$LOG"; exit 1; }; sleep 1; done
bun run router correct --url "http://127.0.0.1:$PORT" --db ${DB:-data/bench-r2.db} --variants ${VARIANTS:-$DIR/variants.jsonl} --controls ${CONTROLS:-$DIR/controls.jsonl} \
  ${CORRECTIONS:+--corrections $CORRECTIONS} --rerank ${RERANK:-ruri,xs} --python "$PY" ${THETA:+--theta $THETA} ${TABLE:+--table} --out "$OUT"
echo "report: $OUT/report.json"
