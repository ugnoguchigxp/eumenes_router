# A+C: cascade with sr+rr front (margin of combined score), defer to past. Usage: python cascade_rr.py tag
import json, sys
exec(open('cascade.py').read().split('dev = [')[0])
tag = sys.argv[1]; E = json.load(open(f'/tmp/r3/rreval-{tag}.json'))['sr+rr']; w, th0 = E['w'], E['th']
rr = {o['id']: o['rr'] for o in json.load(open(f'/tmp/r3/rr-{tag}.json'))['out']}
dev = [r for r in rows if r['split'] == 'dev']; test = [r for r in rows if r['split'] == 'test']
def front(r):
    s = dict(r['sr']); comb = {c: s.get(c, 0) + w * v for c, v in rr[r['id']].items()}; comb[C] = s.get(C, 0) + th0
    a = sorted(comb.items(), key=lambda kv: -kv[1]); return a[0][0], a[0][1] - (a[1][1] if len(a) > 1 else 0)
def runf(rs, th):
    o = []
    for r in rs:
        t, mg = front(r); use = mg >= th
        o.append((ok(r, t if use else r['past'][0][0]), r['none'], r['ctx'], not use))
    return o
past_t = run(test, 9); dm = sorted(front(r)[1] for r in dev); res = {'curve': []}
for q in [0, 10, 20, 30, 40, 50]:
    th = -9 if q == 0 else dm[int(len(dm) * q / 100) - 1] + 1e-9; ot = runf(test, th)
    res['curve'].append(dict(targetDefer=q, dev=m(runf(dev, th)), test=m(ot), ciTop1=ci(ot, past_t), ciNone=ci(ot, past_t, sel=lambda i: test[i]['none'])))
json.dump(res, open(f'/tmp/r3/cascade-rr-{tag}.json', 'w'), indent=1)
for c in res['curve']: print(c['targetDefer'], {k: round(v, 1) for k, v in c['test'].items()}, c['ciTop1'], c['ciNone'])
