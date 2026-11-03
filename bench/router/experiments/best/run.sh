#!/usr/bin/env bash
# best-v1 end-to-end (zero-shot ruri). Re-runnable on AI MAX.
#   bench/router/experiments/best/run.sh CORR_DIR OUT_DIR [PYTHON] [extra best_v1.py args]
# CORR_DIR = output of `bun run router correct ... --rerank ruri --table 1` (sr/past runs, ruri, readings, e5 in corr.db).
set -euo pipefail
H=$(cd "$(dirname "$0")" && pwd); C=$1; O=$2; PY=${3:-python3}; shift $(( $# < 3 ? $# : 3 ))
mkdir -p "$O"
"$PY" "$H/best_v1.py" --corr "$C" --out "$O" --python "$PY" "$@"
"$PY" "$H/latency.py" "$C" > "$O/latency-models.json" || echo "latency skipped (models not cached)" >&2
echo "report: $O/report.json"
