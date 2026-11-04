# Re-tune fusion (w, conv) on held-out dev only (dev rows not used for training), then report on test.
# usage: python tune.py --zs zs.json --ft A/scores.json ... --meta A/meta.json ...
import argparse, json, os
import finetune as F
WS = [0.5, 1, 1.5, 2, 3, 4]; CS = [-0.4, -0.2, 0, 0.1, 0.18, 0.3, 0.45, 0.6, 0.8, 1.0, 1.3]
def ev(rows, rr, th):
    o = F.cascade(rows, rr, th); n = len(rows); nn = [x for x, r in zip(o, rows) if r['none']]
    return dict(top1=round(100 * sum(x[0] for x in o) / n, 1), defer=round(100 * sum(x[1] for x in o) / n, 1),
                none=round(100 * sum(x[0] for x in nn) / max(1, len(nn)), 1), front=round(100 * sum(x[2] for x in o) / n, 1),
                front_none=round(100 * sum(x[2] for x in nn) / max(1, len(nn)), 1), _ok=[x[0] for x in o])
def run(rr, held, test):
    best = None
    for w in WS:
        for c in CS:
            F.W, F.CONV = w, c; th = F.th_at(held, rr, 0.2); h = ev(held, rr, th)
            key = (h['top1'], -h['defer'])
            if best is None or key > best[0]: best = (key, w, c, th, h)
    _, w, c, th, h = best; F.W, F.CONV = w, c; t = ev(test, rr, th)
    F.W, F.CONV = 2.0, 0.18; t0 = ev(test, rr, F.th_at(held, rr, 0.2))
    return dict(w=w, conv=c, th=round(th, 4), held=dict((k, v) for k, v in h.items() if k != '_ok'), test=t, test_default=t0)
if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--zs'); p.add_argument('--ft', nargs='+'); p.add_argument('--meta', nargs='+'); a = p.parse_args()
    zs = json.load(open(a.zs))['rr']; test = [r for r in F.ROWS if r['split'] == 'test']; out = {}
    for f, mf in zip(a.ft, a.meta):
        tid = set(json.load(open(mf))['train_ids']); held = [r for r in F.ROWS if r['split'] == 'dev' and r['id'] not in tid]
        z = run(zs, held, test); m = run(json.load(open(f))['rr'], held, test)
        m['diff_vs_zs_tuned'] = F.boot_diff(m['test']['_ok'], z['test']['_ok']); m['diff_vs_zs_default'] = F.boot_diff(m['test']['_ok'], z['test_default']['_ok'])
        for d in (z, m):
            for k in ('test', 'test_default'): d[k].pop('_ok')
        out[os.path.basename(os.path.dirname(mf))] = dict(zs=z, ft=m)
    print(json.dumps(out, ensure_ascii=False, indent=1))
