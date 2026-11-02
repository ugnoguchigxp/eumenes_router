# Evaluate rerank outputs: rr-only and sr+w*rr, none threshold tuned on dev. Usage: python rreval.py tag
import json, sys
exec(open('cascade.py').read().split('dev = [')[0])
tag = sys.argv[1]; R = json.load(open(f'/tmp/r3/rr-{tag}.json')); rr = {o['id']: o for o in R['out']}
dev = [r for r in rows if r['split'] == 'dev']; test = [r for r in rows if r['split'] == 'test']
def pred(r, w, th):
    s = dict(r['sr']); x = rr[r['id']]['rr']
    if not x: return C
    if w is None:  # rr only, none by threshold
        c, v = max(x.items(), key=lambda kv: kv[1]); return c if v >= th else C
    comb = {c: s.get(c, 0) + w * v for c, v in x.items()}; comb[C] = s.get(C, 0) + th
    return max(comb.items(), key=lambda kv: kv[1])[0]
def ev(rs, w, th): return [(ok(r, pred(r, w, th)), r['none'], r['ctx'], False) for r in rs]
res = {}
for mode, ws, ths in [('rr', [None], [i / 100 for i in range(0, 100, 2)]), ('sr+rr', [0.1, 0.25, 0.5, 1, 2, 3, 4, 6, 8], [i / 50 for i in range(-25, 26)])]:
    best = max(((m(ev(dev, w, th))['top1'], w, th) for w in ws for th in ths), key=lambda z: z[0])
    _, w, th = best; ot = ev(test, w, th)
    res[mode] = dict(w=w, th=th, dev=m(ev(dev, w, th)), test=m(ot), ciVsSr=ci(ot, run(test, -1)), ciVsPast=ci(ot, run(test, 9)), ctxCiVsSr=ci(ot, run(test, -1), sel=lambda i: test[i]['ctx']))
ms = sorted(o['ms'] for o in R['out'])
res['lat'] = dict(p50=ms[len(ms)//2], p95=ms[int(len(ms)*.95)], max=ms[-1], pairsPerQ=sum(o['n'] for o in R['out'])/len(ms), loadSec=R['loadSec'], rssMB=R['rssMB'], threads=R['threads'])
json.dump(res, open(f'/tmp/r3/rreval-{tag}.json', 'w'), indent=1); print(json.dumps(res))
