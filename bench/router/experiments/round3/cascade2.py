# A': two thresholds (sr top = conversation vs tool), dev-tuned: min dev defer s.t. dev top1/none >= past-1.
import json
exec(open('cascade.py').read().split('dev = [')[0])
dev = [r for r in rows if r['split'] == 'dev']; test = [r for r in rows if r['split'] == 'test']
def run2(rs, tc, tt):
    o = []
    for r in rs:
        th = tc if r['sr'][0][0] == C else tt; use = conf(r) >= th
        o.append((ok(r, r['sr'][0][0] if use else r['past'][0][0]), r['none'], r['ctx'], not use))
    return o
pd = m(run(dev, 9)); past_t = run(test, 9)
grid = sorted(set([-1] + [round(conf(r), 4) for r in dev])); best = None
for tc in grid:
    for tt in grid:
        md = m(run2(dev, tc, tt))
        if md['top1'] >= pd['top1'] - 1 and md['none'] >= pd['none'] - 1 and (best is None or md['defer'] < best[0]): best = (md['defer'], tc, tt)
_, tc, tt = best; ot = run2(test, tc, tt)
r = dict(tc=tc, tt=tt, dev=m(run2(dev, tc, tt)), test=m(ot), ciTop1=ci(ot, past_t), ciNone=ci(ot, past_t, sel=lambda i: test[i]['none']))
json.dump(r, open('/tmp/r3/cascade2.json', 'w'), indent=1); print(json.dumps(r))
