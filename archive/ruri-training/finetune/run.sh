#!/usr/bin/env bash
# Few-shot ruri fine-tune experiment. CPU only, no API keys. Weights stay under $FT (default /tmp/ft), never in git.
#   PY=/tmp/cvenv/bin/python HF_HOME=/tmp/r3hf HF_HUB_OFFLINE=1 archive/ruri-training/finetune/run.sh
# Env: SEEDS ("0 1 2"), KS ("3 5 10"; k<10 and the synthetic arm use seed 0 only), ARMS ("real cardx"), FT (/tmp/ft)
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-/tmp/cvenv/bin/python}; FT=${FT:-/tmp/ft}; mkdir -p "$FT"
[ -f "$FT/zs.json" ] || "$PY" finetune.py score cl-nagoya/ruri-v3-reranker-310m "$FT/zs.json"
for k in ${KS:-10 5 3}; do for arm in ${ARMS:-real cardx}; do
  seeds=${SEEDS:-0 1 2}; [ "$k" = 10 ] && [ "$arm" = real ] || seeds=0; [ "$arm" = real ] || [ "$k" = 10 ] || continue
  for s in $seeds; do d="$FT/k$k-$arm-s$s"
    [ -f "$d/scores.json" ] && continue
    [ -f "$d/meta.json" ] || "$PY" finetune.py train --k "$k" --seed "$s" --arm "$arm" --out "$d"
    "$PY" finetune.py score "$d" "$d/scores.json"
  done; done; done
"$PY" finetune.py eval --zs "$FT/zs.json" --ft "$FT"/*/scores.json --meta "$FT"/*/meta.json > "$FT/eval.json"
echo "eval: $FT/eval.json"
