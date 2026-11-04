# A: cascade sr-cal -> past (simulated LLM). B: candidate-set recall. Bootstrap CIs. Reads /tmp/r3/dump.json
import json, random
d = json.load(open('/tmp/r3/dump.json')); rows = d['rows']
C = 'conversation.respond'
ok = lambda r, t: t == r['gold'] or t in r['acceptable']
def conf(r):
    s = r['sr']; return s[0][1] - (s[1][1] if len(s) > 1 else 0)
def run(rs, th):  # answer with sr when margin >= th else past
    out = []
    for r in rs:
        use = conf(r) >= th
        t = r['sr'][0][0] if use else r['past'][0][0]
        out.append((ok(r, t), r['none'], r['ctx'], not use))
    return out
def m(o):
    f = lambda xs: 100 * sum(x[0] for x in xs) / max(1, len(xs))
    return dict(top1=f(o), none=f([x for x in o if x[1]]), ctx=f([x for x in o if x[2]]), defer=100 * sum(x[3] for x in o) / len(o))
def ci(a, b, B=10000, sel=lambda i: True):
    idx = [i for i in range(len(a)) if sel(i)]; dd = [a[i][0] - b[i][0] for i in idx]; rnd = random.Random(1); xs = []
    for _ in range(B): xs.append(100 * sum(dd[rnd.randrange(len(dd))] for _ in dd) / len(dd))
    xs.sort(); return round(100 * sum(dd) / len(dd), 1), round(xs[int(B * .025)], 1), round(xs[int(B * .975)], 1)
dev = [r for r in rows if r['split'] == 'dev']; test = [r for r in rows if r['split'] == 'test']
past_t = run(test, 9); sr_t = run(test, -1)
res = {'past': m(past_t), 'sr': m(sr_t), 'curve': []}
# thresholds achieving target defer rates on dev (quantiles of dev margin)
dm = sorted(conf(r) for r in dev)
for q in [0, 10, 20, 30, 40, 50, 70]:
    th = -1 if q == 0 else dm[int(len(dm) * q / 100) - 1] + 1e-9
    od = run(dev, th); ot = run(test, th)
    res['curve'].append(dict(targetDefer=q, th=round(th, 4), dev=m(od), test=m(ot), ciTop1=ci(ot, past_t), ciNone=ci(ot, past_t, sel=lambda i: test[i]['none'])))
# dev-tuned pick: smallest dev defer with dev top1>=past-1 and none>=past-1
pd = m(run(dev, 9)); best = None
for th in sorted(set(dm)):
    md = m(run(dev, th + 1e-9 if th > -1 else th))
    if md['top1'] >= pd['top1'] - 1 and md['none'] >= pd['none'] - 1: best = th; break
if best is not None:
    th = best + 1e-9; ot = run(test, th)
    res['tuned'] = dict(th=round(th, 4), dev=m(run(dev, th)), test=m(ot), ciTop1=ci(ot, past_t), ciNone=ci(ot, past_t, sel=lambda i: test[i]['none']))
res['pastDev'] = pd
# B
def rec(rs, key, k=4, toolOnly=False):
    xs = [r for r in rs if not toolOnly or not r['none']]
    return round(100 * sum(any(ok(r, t) for t, _ in r[key][:k]) for r in xs) / len(xs), 1), len(xs)
pastWrong = [r for r in test if not ok(r, r['past'][0][0])]
res['B'] = dict(srR4=rec(test, 'sr'), pastR4=rec(test, 'past'), srR4tool=rec(test, 'sr', toolOnly=True), pastR4tool=rec(test, 'past', toolOnly=True),
    union=round(100 * sum(any(ok(r, t) for t, _ in r['sr'][:4]) or ok(r, r['past'][0][0]) for r in test) / len(test), 1),
    pastWrong=len(pastWrong), pastWrongGoldInSr4=sum(any(ok(r, t) for t, _ in r['sr'][:4]) for r in pastWrong))
json.dump(res, open('/tmp/r3/cascade.json', 'w'), indent=1); print(json.dumps(res, indent=1)[:6000])
