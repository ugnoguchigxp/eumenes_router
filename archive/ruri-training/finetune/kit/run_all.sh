#!/usr/bin/env bash
# Resumable: skips runs whose scores.json exists.  SEEDS="0 1 2" KS="10 5 3" ARMS="convpos real" ./run_all.sh
set -euo pipefail; cd "$(dirname "$0")"; PY=${PY:-python}; mkdir -p runs
[ -f runs/zs.json ] || "$PY" score.py cl-nagoya/ruri-v3-reranker-310m runs/zs.json
for k in ${KS:-10 5 3}; do for arm in ${ARMS:-convpos real}; do for s in ${SEEDS:-0 1 2}; do
  [ "$arm" = cardx ] && [ "$k" != 10 ] && continue
  d=runs/k$k-$arm-s$s; [ -f $d/scores.json ] && continue
  [ -f $d/meta.json ] || "$PY" train.py --pairs pairs/k$k-$arm-s$s.jsonl --seed $s --out $d ${FULL:+--full}
  "$PY" score.py $d $d/scores.json $([ "$arm" = convpos ] && echo --with-conv)
done; done; done
# Send back: runs/*/scores.json and runs/*/meta.json (small). The model weights are not needed.
tar czf results.tgz runs/zs.json runs/*/scores.json runs/*/meta.json && echo "results.tgz ready"
