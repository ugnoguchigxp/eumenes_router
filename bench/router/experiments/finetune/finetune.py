#!/usr/bin/env python3
"""Few-shot fine-tune of cl-nagoya/ruri-v3-reranker-310m for the sr + ruri -> LLM cascade (CPU).
Data: /tmp/r3/dump.json (round 3 dump: rows with split/gold/acceptable/sr top-8/past, cards with passages).
Training uses ONLY split=dev rows; test (217) is never touched for training or threshold choice.

  python finetune.py train --k 10 --seed 0 --out /tmp/ft/k10-s0 [--arm cardx] [--layers 6] [--epochs 2]
  python finetune.py score <model-dir|hf-name> <out.json>          # rerank scores for every dump row, keyed by row id
  python finetune.py eval  --zs zs.json --ft a.json b.json ... [--meta a/meta.json ...] > eval.json
Card documents are built exactly as round3/rerank.py and correction/models.py do.
"""
import json, sys, time, random, argparse, os, collections
DUMP = os.environ.get('DUMP', '/tmp/r3/dump.json'); BASE = 'cl-nagoya/ruri-v3-reranker-310m'; C = 'conversation.respond'
D = json.load(open(DUMP)); ROWS = D['rows']; CARDS = D['cards']
def doc(cid):
    p = CARDS.get(cid, {}).get('passages') or [cid]
    return p[0] + ' 例: ' + ' / '.join(p[1:6])
ok = lambda r, t: t == r['gold'] or t in r['acceptable']

def pick_train(k, seed):
    """<=k dev rows per gold label (conversation.respond rows give negatives only). Remaining dev rows are held out for the threshold."""
    rnd = random.Random(seed); by = collections.defaultdict(list)
    for r in ROWS:
        if r['split'] == 'dev': by[r['gold']].append(r)
    tr = []
    for g in sorted(by): rs = by[g][:]; rnd.shuffle(rs); tr += rs[:k]
    return tr

def pairs_of(rows, arm, seed):
    P = []
    for r in rows:
        if r['gold'] != C: P.append((r['text'][:400], doc(r['gold']), 1.0))
        for c, _ in r['sr']:
            if c != C and not ok(r, c): P.append((r['text'][:400], doc(c), 0.0))
    if arm == 'cardx':  # SYNTHETIC arm: card-author example sentences not shown in the doc (passages[6:]), 3 random other tools as negatives
        rnd = random.Random(seed + 99); tools = [c for c in CARDS if c != C]
        for c in tools:
            for ex in (CARDS[c]['passages'] or [])[6:]:
                P.append((ex, doc(c), 1.0))
                for n in rnd.sample([t for t in tools if t != c], 3): P.append((ex, doc(n), 0.0))
    return P

def train(a):
    import torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    torch.manual_seed(a.seed); random.seed(a.seed); torch.set_num_threads(os.cpu_count())
    tr = pick_train(a.k, a.seed); P = pairs_of(tr, a.arm, a.seed)
    tok = AutoTokenizer.from_pretrained(BASE); m = AutoModelForSequenceClassification.from_pretrained(BASE)
    layers = [mod for n, mod in m.named_modules() if n.count('.') == 2 and '.layers.' in n]
    for p in m.parameters(): p.requires_grad = False
    train_mods = layers[-a.layers:] + [mod for n, mod in m.named_children() if n != m.base_model_prefix] + [getattr(m, m.base_model_prefix).final_norm] if hasattr(getattr(m, m.base_model_prefix), 'final_norm') else layers[-a.layers:] + [mod for n, mod in m.named_children() if n != m.base_model_prefix]
    for mod in train_mods:
        for p in mod.parameters(): p.requires_grad = True
    params = [p for p in m.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.01); lossf = torch.nn.BCEWithLogitsLoss()
    steps = a.epochs * ((len(P) + a.bs - 1) // a.bs); sch = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / max(1, steps // 10)) * max(0.0, 1 - s / steps))
    t0 = time.time(); m.train(); rnd = random.Random(a.seed); hist = []
    for ep in range(a.epochs):
        rnd.shuffle(P); tot = 0
        for i in range(0, len(P), a.bs):
            b = P[i:i + a.bs]; enc = tok([x[0] for x in b], [x[1] for x in b], truncation=True, max_length=256, padding=True, return_tensors='pt')
            lg = m(**enc).logits[:, 0]; loss = lossf(lg, torch.tensor([x[2] for x in b]))
            loss.backward(); opt.step(); sch.step(); opt.zero_grad(); tot += loss.item() * len(b)
        hist.append(round(tot / len(P), 4)); print('epoch', ep, hist[-1], round(time.time() - t0), 's', file=sys.stderr)
    secs = time.time() - t0; m.eval(); m.save_pretrained(a.out); tok.save_pretrained(a.out)
    cnt = collections.Counter(r['gold'] for r in tr)
    json.dump(dict(k=a.k, seed=a.seed, arm=a.arm, layers=a.layers, epochs=a.epochs, lr=a.lr, pairs=len(P), pos=sum(x[2] for x in P), train_ids=[r['id'] for r in tr],
                   per_tool=dict(cnt), train_seconds=round(secs, 1), loss=hist, trainable_params=sum(p.numel() for p in params)), open(os.path.join(a.out, 'meta.json'), 'w'), indent=1)

def score(name, outp):
    import torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    torch.set_num_threads(os.cpu_count())
    tok = AutoTokenizer.from_pretrained(BASE)  # fine-tuning never changes the tokenizer; reloading the saved copy trips a transformers regex warning
    m = AutoModelForSequenceClassification.from_pretrained(name).eval(); res = {}; lat = []
    with torch.inference_mode():
        for r in ROWS:
            tools = [c for c, _ in r['sr'] if c != C]
            t = time.perf_counter()
            enc = tok([r['text'][:400]] * len(tools), [doc(c) for c in tools], truncation=True, max_length=512, padding=True, return_tensors='pt')
            lg = m(**enc).logits; s = (lg[:, 0] if lg.shape[-1] == 1 else lg[:, -1]).sigmoid().tolist()
            lat.append(1000 * (time.perf_counter() - t)); res[r['id']] = dict(zip(tools, s))
    lat.sort(); json.dump(dict(model=name, rr=res, ms_p50=lat[len(lat) // 2], ms_p95=lat[int(len(lat) * .95)], ms_mean=sum(lat) / len(lat)), open(outp, 'w'))

# ---- evaluation: same fusion as bench/router/correction.ts (w=2, conv=0.18 for ruri) ----
import math
W, CONV = 2.0, 0.18
def front(r, rr):
    s = dict(r['sr']); ids = list(rr) + [C]; comb = [s.get(c, 0) + (CONV if c == C else W * rr[c]) for c in ids]
    mx = max(comb); e = [math.exp(x - mx) for x in comb]; z = sum(e); p = sorted(zip(ids, [x / z for x in e]), key=lambda kv: -kv[1])
    return p, math.log(p[0][1] + 1e-12) - math.log((p[1][1] if len(p) > 1 else 0) + 1e-12)
def th_at(rows, rr, q):
    dm = sorted(front(r, rr[r['id']])[1] for r in rows); return dm[max(int(len(dm) * q) - 1, 0)] + 1e-9
def cascade(rows, rr, th):
    out = []
    for r in rows:
        p, mg = front(r, rr[r['id']]); d = mg < th; out.append((ok(r, r['past'][0][0] if d else p[0][0]), d, ok(r, p[0][0]), p))
    return out
def boot_diff(a, b, B=4000, seed=1):
    dd = [x - y for x, y in zip(a, b)]; n = len(dd); rnd = random.Random(seed); xs = sorted(100 * sum(dd[rnd.randrange(n)] for _ in range(n)) / n for _ in range(B))
    return [round(100 * sum(dd) / n, 1), round(xs[int(B * .025)], 1), round(xs[int(B * .975) - 1], 1)]
def boot_ci(a, B=4000, seed=2):
    n = len(a); rnd = random.Random(seed); xs = sorted(100 * sum(a[rnd.randrange(n)] for _ in range(n)) / n for _ in range(B)); return [round(xs[int(B * .025)], 1), round(xs[int(B * .975) - 1], 1)]
def metrics(rr, train_ids, held_dev):
    test = [r for r in ROWS if r['split'] == 'test']; dev = [r for r in ROWS if r['split'] == 'dev']
    pct = lambda xs: round(100 * sum(xs) / max(1, len(xs)), 1)
    res = {}
    for name, rows in (('thFullDev', dev), ('thHeldDev', held_dev)):
        th = th_at(rows, rr, 0.2); o = cascade(test, rr, th)
        res[name] = dict(th=round(th, 4), n_dev=len(rows), top1=pct([x[0] for x in o]), defer=pct([x[1] for x in o]), none=pct([x[0] for x, r in zip(o, test) if r['none']]), front_top1=pct([x[2] for x in o]), _ok=[x[0] for x in o])
    o = cascade(test, rr, -1e9)
    rec = {k: pct([any(ok(r, c) for c, _ in p[:k]) for (_, _, _, p), r in zip(o, test)]) for k in (1, 2, 3, 5)}
    res['front'] = dict(top1=rec[1], recall=rec, none=pct([x[2] for x, r in zip(o, test) if r['none']]), _ok=[x[2] for x in o])
    # matched comparisons (thresholds read off the test curve: reporting device, not a tuning choice)
    ms = sorted(front(r, rr[r['id']])[1] for r in test)
    th = ms[int(len(ms) * 0.295) - 1] + 1e-9; om = cascade(test, rr, th)
    res['atDefer29.5'] = dict(top1=pct([x[0] for x in om]), defer=pct([x[1] for x in om]), _ok=[x[0] for x in om])
    best = None
    for t in [-1e9] + ms:
        oo = cascade(test, rr, t + 1e-9 if t > -1e9 else t)
        if pct([x[0] for x in oo]) >= 81.6: best = (pct([x[1] for x in oo]), pct([x[0] for x in oo])); break
    res['atTop1_81.6'] = dict(defer=best[0] if best else None, top1=best[1] if best else None)
    # per tool (test gold): front top-1 and cascade top-1 (held-dev threshold)
    oh = cascade(test, rr, res['thHeldDev']['th']); pt = collections.defaultdict(lambda: [0, 0, 0])
    for (c, _, f, _), r in zip(oh, test): x = pt[r['gold']]; x[0] += 1; x[1] += f; x[2] += c
    res['per_tool'] = {g: dict(n=v[0], front=pct([1] * v[1] + [0] * (v[0] - v[1])), cascade=pct([1] * v[2] + [0] * (v[0] - v[2]))) for g, v in pt.items()}
    return res
def evaluate(a):
    zs = json.load(open(a.zs)); out = {'zs_latency_ms': {k: zs[k] for k in ('ms_p50', 'ms_p95', 'ms_mean')}, 'runs': {}}
    dev_ids = {r['id'] for r in ROWS if r['split'] == 'dev'}
    for f, mf in zip(a.ft, a.meta):
        meta = json.load(open(mf)); ft = json.load(open(f)); tid = set(meta['train_ids'])
        held = [r for r in ROWS if r['id'] in dev_ids and r['id'] not in tid]
        z = metrics(zs['rr'], tid, held); m = metrics(ft['rr'], tid, held)
        cmp = {k: boot_diff(m[k]['_ok'], z[k]['_ok']) for k in ('thFullDev', 'thHeldDev', 'front', 'atDefer29.5')}
        strip = lambda d: {k: ({kk: vv for kk, vv in v.items() if kk != '_ok'} if isinstance(v, dict) else v) for k, v in d.items()}
        out['runs'][os.path.basename(os.path.dirname(mf))] = dict(meta={k: meta[k] for k in meta if k != 'train_ids'}, zs=strip(z), ft=strip(m), diff_vs_zs=cmp,
            ci_ft={k: boot_ci(m[k]['_ok']) for k in ('thHeldDev', 'front')}, latency_ms={k: ft[k] for k in ('ms_p50', 'ms_p95', 'ms_mean')})
    print(json.dumps(out, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest='cmd', required=True)
    t = sp.add_parser('train'); t.add_argument('--k', type=int, default=10); t.add_argument('--seed', type=int, default=0); t.add_argument('--out', required=True)
    t.add_argument('--arm', default='real', choices=['real', 'cardx']); t.add_argument('--layers', type=int, default=6); t.add_argument('--epochs', type=int, default=2)
    t.add_argument('--lr', type=float, default=2e-5); t.add_argument('--bs', type=int, default=16)
    s = sp.add_parser('score'); s.add_argument('model'); s.add_argument('out')
    e = sp.add_parser('eval'); e.add_argument('--zs', required=True); e.add_argument('--ft', nargs='+', required=True); e.add_argument('--meta', nargs='+', required=True)
    a = p.parse_args()
    if a.cmd == 'train': train(a)
    elif a.cmd == 'score': score(a.model, a.out)
    else: evaluate(a)
