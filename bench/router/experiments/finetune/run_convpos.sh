#!/usr/bin/env bash
# Experiment A: conversation.respond as an explicit positive class (arm convpos), k10, seeds 0 1 2. Resumable.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-/tmp/cvenv/bin/python}; FT=${FT:-/tmp/ft}
for s in ${SEEDS:-0 1 2}; do d="$FT/k10-convpos-s$s"
  [ -f "$d/scores.json" ] && continue
  [ -f "$d/meta.json" ] || "$PY" finetune.py train --k 10 --seed "$s" --arm convpos --out "$d"
  "$PY" finetune.py score "$d" "$d/scores.json"
done
for cv in 0.18 0; do CONV=$cv "$PY" finetune.py eval --zs "$FT/zs.json" --ft "$FT"/k10-{real,convpos}-s?/scores.json --meta "$FT"/k10-{real,convpos}-s?/meta.json > "$FT/eval-convpos-c$cv.json"; done
echo done
