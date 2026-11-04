"""Paired comparison of two best-v2 configurations (plan M3c's adoption rule), from export-ranked outputs.
  python compare.py --corr DIR --variants V.jsonl --a ranked_a.jsonl --th-a T --b ranked_b.jsonl --th-b T [--out report.json]
Per item: the top candidate taken without the LLM (gold or acceptable) and deferred (p1 - p2 < th). The test differences
(b - a) get a paired bootstrap 95% CI (2,000 resamples of the test items, seed 11). Counts only: no text is written."""
import argparse, json, os, sys, random
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import best_v2 as V


def per_item(path, th):
    out = {}
    for l in open(path):
        r = json.loads(l); P = r['ranked']; gate = P[0][1] - (P[1][1] if len(P) > 1 else -9)
        out[r['id']] = (P[0][0], gate < th)
    return out


def main():
    p = argparse.ArgumentParser()
    for k in ('corr', 'variants', 'a', 'b', 'out'): p.add_argument('--' + k)
    p.add_argument('--th-a', type=float, required=True); p.add_argument('--th-b', type=float, required=True); a = p.parse_args()
    items, _ = V.load(a.corr); real, var, _ = V.setup(items, a.variants); test = [x for x in real if x['split'] == 'test']
    A, Bm = per_item(a.a, a.th_a), per_item(a.b, a.th_b)
    def rows(xs): return [(float(V.ok(x, A[x['id']][0])), float(V.ok(x, Bm[x['id']][0])), float(A[x['id']][1]), float(Bm[x['id']][1])) for x in xs]
    t, v = rows(test), rows(var); rnd = random.Random(11); n = len(t)
    def ci(i, j):
        d = sorted(sum(t[k][j] - t[k][i] for k in (rnd.randrange(n) for _ in range(n))) / n for _ in range(2000))
        return [round(100 * d[49], 1), round(100 * d[1949], 1)]
    pct = lambda xs, i: round(100 * sum(r[i] for r in xs) / len(xs), 1)
    rep = dict(n_test=n, n_variants=len(v),
               test=dict(a_top1=pct(t, 0), b_top1=pct(t, 1), top1_diff=round(pct(t, 1) - pct(t, 0), 1), top1_ci=ci(0, 1),
                         a_defer=pct(t, 2), b_defer=pct(t, 3), defer_diff=round(pct(t, 3) - pct(t, 2), 1), defer_ci=ci(2, 3),
                         better=sum(1 for r in t if r[1] > r[0]), worse=sum(1 for r in t if r[1] < r[0])),
               variants=dict(a_top1=pct(v, 0), b_top1=pct(v, 1), a_defer=pct(v, 2), b_defer=pct(v, 3)))
    print(json.dumps(rep, ensure_ascii=False, indent=1))
    if a.out: json.dump(rep, open(a.out, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__': main()
