"""E7 oracle / upper-bound analysis on test (uses gold labels; ceilings only, not deployable).
Stages: candidate ceiling (R@k sr, +kNN union) -> perfect reranker -> perfect gate (exact / budgets) -> perfect LLM -> combined.
Loss waterfall of the baseline cascade errors: retrieval miss / rank error not caught by gate / LLM error on deferred."""
import json, sys
from algo4 import *
def run7(tag):
    base, tid, ext = load_rr(tag); held = [r for r in DEV if r['id'] not in tid]
    P = {r['id']: fuse(r, base[r['id']]) for r in ROWS}; th = q_th([marg(P[r['id']]) for r in held])
    n = len(TEST); o = {}
    srR = lambda r, k: any(ok(r, c) for c, _ in r['sr'][:k]) or ok(r, C)
    o['R_sr'] = {k: pct([srR(r, k) for r in TEST]) for k in range(1, 9)}; o['R_sr_9to15'] = '未測定 (dump has sr top-8 only)'
    knn = lambda r, N: [c for c, _ in KNN[r['id']] if c != C and c not in dict(r['sr'])][:N]
    o['R_sr8_knn'] = {N: pct([srR(r, 8) or any(ok(r, c) for c in knn(r, N)) for r in TEST]) for N in (1, 3, 5)}
    cand = [any(ok(r, c) for c, _ in P[r['id']]) for r in TEST]  # gold among the candidates ruri actually ranks
    front = [ok(r, P[r['id']][0][0]) for r in TEST]; L = [ok(r, llm(r)) for r in TEST]; d = [marg(P[r['id']]) < th for r in TEST]
    base_t1 = [L[i] if d[i] else front[i] for i in range(n)]
    o['baseline'] = dict(front=pct(front), top1=pct(base_t1), defer=pct(d), llm_all=pct(L))
    o['perfect_rerank'] = dict(front=pct(cand), cascade_same_gate=pct([L[i] if d[i] else cand[i] for i in range(n)]))
    wrong = [not f for f in front]; fixable = [wrong[i] and L[i] for i in range(n)]
    o['perfect_gate'] = dict(top1=pct([front[i] or L[i] for i in range(n)]), defer=pct(wrong), defer_only_fixable=pct(fixable))
    o['perfect_gate_budget'] = {b: pct([1] * 0 + [1] * min(int(round(b / 100 * n)), sum(fixable)) + [0] * 0) and round(100 * (sum(front) + min(int(round(b / 100 * n)), sum(fixable))) / n, 1) for b in (10, 20, 29.5, 30)}
    o['perfect_llm_same_defer'] = pct([True if d[i] else front[i] for i in range(n)])
    o['perfect_rerank_and_gate'] = pct([cand[i] or L[i] for i in range(n)])
    o['combined_ceiling_perfect_llm'] = 100.0
    # waterfall of baseline errors
    miss = sum(1 for i in range(n) if not d[i] and not front[i] and not cand[i])
    rank = sum(1 for i in range(n) if not d[i] and not front[i] and cand[i])
    llme = sum(1 for i in range(n) if d[i] and not L[i]); llme_present = sum(1 for i in range(n) if d[i] and not L[i] and cand[i])
    o['waterfall_items'] = dict(errors=n - sum(base_t1), retrieval_miss_kept=miss, rank_error_gate_missed=rank, llm_error_on_deferred=llme, llm_error_gold_in_cands=llme_present,
                                wasted_defer_front_was_right=sum(1 for i in range(n) if d[i] and front[i] and not L[i]))
    return o
if __name__ == '__main__':
    out = {t: run7(t) for t in ('zs', 'cp0', 'cp1', 'cp2')}
    json.dump(out, open('/tmp/a4/e7.json', 'w'), ensure_ascii=False, indent=1); print(json.dumps(out, ensure_ascii=False, indent=1))
