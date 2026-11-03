#!/usr/bin/env python3
"""best-v2: algo4 E2 ranker (candidate features + p1−p2 gate) inside the best-v1 harness. Local CPU only, no external APIs.

  python best_v2.py eval    --corr DIR [--out DIR] [--rerank tag=FTDIR ...] [--skip-robust]
  python best_v2.py export  --corr DIR --artifact OUT [--cfg best-v2]        versioned artifact (model.json + memory.npz)
  python best_v2.py predict --artifact OUT [--in rows.jsonl | --row JSON] [--ruri MODEL]   one or many utterances, no retraining
  python best_v2.py export-verify --corr DIR --out items.jsonl     deferred test items for tokens.py verify
  python best_v2.py leak-check --corr DIR [--ft FTDIR ...] [--pairs pairs.jsonl ...]   test labels never reach training

Pipeline (per utterance):
 1 candidates = sr top-8 that have a ruri score + conversation.respond (algo4 `fuse`, k=8); +tbl: table-hit tools added
 2 features   = algo4 cand_feats: sr p, sr rank, sr score, ruri, ruri rank, ruri − ruri top, fused p, fused rank, is_conv,
                kNN vote / max (e5 cosine, dev memory, M=10)  [+tbl: table score, table hit]
 3 ranker     = StandardScaler + LogisticRegression; C chosen by grouped 5-fold CV log-likelihood on dev only
 4 gate       = p1 − p2 of the LR candidate probabilities; defer below the 20th percentile of the dev-CV gate scores
 5 LLM        = deferred items go to the LLM (here: the recorded full-list LLM choice `past`)
"""
import argparse, json, math, os, sys, time, random, hashlib, collections
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import best_v1 as B
C, W, CONV, M = B.C, B.W, B.CONV, 10
VERSION = 'best-v2/2026-11-03'
FN2 = ['sr_p', 'sr_rank', 'sr_score', 'rr', 'rr_rank', 'rr_gap', 'fused_p', 'fused_rank', 'is_conv', 'knn', 'tbl', 'tbl_hit']
CFGS = {
    'best-v2':      dict(knn=True, tbl=False),
    'best-v2+tbl':  dict(knn=True, tbl=True),
    'best-v2-knn':  dict(knn=False, tbl=False),
}
CGRID = (0.01, 0.03, 0.1, 0.3, 1.0, 3.0)
ok = B.ok
# ---------------- features (pure numpy; shared by eval and predict) ----------------
def fuse(x, rr, extra=None):
    s = dict(x['sr'][:8]); ids = [c for c in s if c != C and c in rr] + [C]
    xr = dict(rr); xr.update(extra or {}); ids += [c for c in (extra or {}) if c not in ids]
    comb = [s.get(c, 0) + (CONV + W * rr.get(C, 0) if c == C else W * xr[c]) for c in ids]
    mx = max(comb); e = [math.exp(v - mx) for v in comb]; z = sum(e)
    return sorted(zip(ids, [v / z for v in e]), key=lambda kv: -kv[1]), xr
def cand_matrix(x, rr, votes, tbl, cfg, extra_rr=None):
    """rr: ruri scores of the sr tools; extra_rr: ruri scores of table-hit tools (only used with cfg tbl)."""
    extra = {c: extra_rr[c] for c in tbl if c != C and c not in rr and extra_rr and c in extra_rr} if cfg['tbl'] else {}
    P, xr = fuse(x, rr, extra); s = dict(x['sr']); order = [c for c, _ in x['sr']]
    rrs = sorted([v for k, v in rr.items() if k != C], reverse=True); kn = dict(votes) if cfg['knn'] else {}; kmax = max(kn.values()) if kn else 1
    F = []
    for i, (c, p) in enumerate(P):
        rv = xr.get(c, 0)
        F.append([s.get(c, 0), order.index(c) if c in s else 9, x['sr_scores'].get(c, 0), rv, (rrs.index(rv) if rv in rrs else 9), rv - (rrs[0] if rrs else 0), p, i, float(c == C),
                  kn.get(c, 0) / kmax if kmax else 0, tbl.get(c, 0) if cfg['tbl'] else 0, float(c in tbl) if cfg['tbl'] else 0])
    return [c for c, _ in P], np.array(F, float)
def sig(z): return 1 / (1 + np.exp(-z))
class Ranker:
    """Scaler + LR in plain numpy (identical to sklearn's pipeline decision_function); serialisable."""
    def __init__(self, mean, scale, coef, b): self.mean, self.scale, self.coef, self.b = map(np.asarray, (mean, scale, coef, b))
    @classmethod
    def from_sk(cls, pipe): sc, lr = pipe.steps[0][1], pipe.steps[1][1]; return cls(sc.mean_, sc.scale_, lr.coef_[0], lr.intercept_[0])
    def proba(self, F): return sig(((F - self.mean) / self.scale) @ self.coef + self.b)
    def to_json(self): return dict(mean=self.mean.tolist(), scale=self.scale.tolist(), coef=self.coef.tolist(), intercept=float(self.b))
def route(cs, F, ranker):
    p = ranker.proba(F); o = np.argsort(-p, kind='stable'); P = [(cs[i], float(p[i])) for i in o]
    gs = float(P[0][1] - (P[1][1] if len(P) > 1 else -9)); return P, gs
# ---------------- fit on labelled rows ----------------
def fit_sk(Xs, ys, Cc):
    from sklearn.linear_model import LogisticRegression; from sklearn.preprocessing import StandardScaler; from sklearn.pipeline import make_pipeline
    return make_pipeline(StandardScaler(), LogisticRegression(C=Cc, max_iter=2000)).fit(Xs, ys)
def featurize(x, mem, cfg, tau, EXTRA, loo):
    votes = B.knn_votes(x, mem, M, loo=loo) if cfg['knn'] else []
    tbl = B.tbl_scores(x, mem, tau, loo=loo) if cfg['tbl'] else {}
    ex = {c: EXTRA[(x['text'], c)] for c in tbl if (x['text'], c) in EXTRA}
    return cand_matrix(x, x['rr'], votes, tbl, cfg, ex)
def fit(train, cfg, tau, EXTRA, inner_seed=0, Cfix=None):
    X = {x['id']: featurize(x, train, cfg, tau, EXTRA, loo=True) for x in train}
    folds = B.gkfold(train, 5, inner_seed); res = {}
    for Cc in ((Cfix,) if Cfix else CGRID):
        ll = 0; gsc = {}
        for f in folds:
            fs = set(f); tr = [r for j, r in enumerate(train) if j not in fs]
            m = Ranker.from_sk(fit_sk(np.vstack([X[r['id']][1] for r in tr]), np.concatenate([[float(ok(r, c)) for c in X[r['id']][0]] for r in tr]), Cc))
            for j in f:
                r = train[j]; cs, F = X[r['id']]; p = m.proba(F)
                d = np.log(p + 1e-12) - np.log(1 - p + 1e-12); sm = np.exp(d - d.max()); sm /= sm.sum()   # item softmax of the decision values
                ll += -math.log(max([sm[i] for i, c in enumerate(cs) if ok(r, c)] + [1e-6]))
                gsc[r['id']] = route(cs, F, m)[1]
        res[Cc] = (ll, gsc)
    bestC = min(res, key=lambda c: res[c][0]); gsc = res[bestC][1]
    model = Ranker.from_sk(fit_sk(np.vstack([X[r['id']][1] for r in train]), np.concatenate([[float(ok(r, c)) for c in X[r['id']][0]] for r in train]), bestC))
    s = sorted(gsc.values()); th = s[max(int(len(s) * 0.2) - 1, 0)] + 1e-9
    return dict(model=model, C=bestC, th=th, cv_ll={str(k): round(v[0], 2) for k, v in res.items()})
def apply(fitted, evals, mem, cfg, tau, EXTRA):
    out = {}
    for x in evals:
        cs, F = featurize(x, mem, cfg, tau, EXTRA, loo=False); P, s = route(cs, F, fitted['model'])
        out[x['id']] = dict(P=P, s=s, defer=s < fitted['th'])
    return out
# ---------------- data ----------------
def load(corr, rr_file=None):
    items, utt = B.load(corr); S = {}
    for sp in ('dev', 'test'):
        for l in open(os.path.join(corr, 'runs', f'sr-corr-{sp}', 'predictions.jsonl')):
            d = json.loads(l); S[d['id']] = d.get('scores', {})
    for x in items: x['sr_scores'] = S.get(x['id'], {})
    if rr_file:
        R = json.load(open(rr_file)); srfull = {}
        for sp in ('dev', 'test'):
            for l in open(os.path.join(corr, 'runs', f'sr-corr-{sp}', 'predictions.jsonl')):
                d = json.loads(l); srfull[d['id']] = '|'.join(c for c, _ in sorted(d['probabilities'].items(), key=lambda kv: -kv[1]))
        for x in items: x['rr'] = R.get(x['text'] + '\x00' + srfull[x['id']])
        items = [x for x in items if x['rr'] is not None]
    return items, utt
def setup(items, variants):
    real = [x for x in items if x['kind'] == 'real']
    for x in real: x['grp'] = f"{x['conv']}#{x['seq'] // 20}" if x['conv'] == 'main' else x['conv']
    var = [x for x in items if x['kind'] == 'variant']; ctl = [x for x in items if x['kind'] == 'control']; test = [x for x in real if x['split'] == 'test']
    vmeta = [json.loads(l) for l in open(variants)]
    def src_of(p): return next((x['id'] for x in test if x['id'].startswith(p)), None) or next((x['id'] for x in real if x['id'].startswith(p)), None)
    for x in var: m = vmeta[int(x['id'].split('-')[1])]; x['vtype'] = m['type']; x['src'] = src_of(m['source']); x['past'] = next((r['past'] for r in real if r['id'] == x['src']), None)
    return real, var, ctl
def ft_train_ids(d):
    for f in ('meta.json', 'meta-eval.json'):
        p = os.path.join(d, f)
        if os.path.exists(p):
            t = json.load(open(p)).get('train_ids')
            if t: return set(t)
    return None
# ---------------- eval ----------------
def summarize(test, R, base_acc=None, past_acc=None, dedup=None):
    acc = B.evaluate(test, R); cv = B.curve(test, R); nn = [x for x in test if x['none']]
    dec = lambda x: x['past'] if R[x['id']]['defer'] else R[x['id']]['P'][0][0]
    row = dict(top1=round(100 * acc.mean(), 1), defer=round(100 * np.mean([R[x['id']]['defer'] for x in test]), 1), front=round(100 * np.mean([ok(x, R[x['id']]['P'][0][0]) for x in test]), 1),
               cand_recall=round(100 * np.mean([any(ok(x, c) for c, _ in R[x['id']]['P']) for x in test]), 1), none_acc=round(100 * np.mean([ok(x, dec(x)) for x in nn]), 1), n_none=len(nn),
               at20=B.at(cv, 20), at29_5=B.at(cv, 29.5), d_at81_6=B.d_at(cv, 81.6), d_at90=B.d_at(cv, 90), n=len(test))
    if base_acc is not None: row['vs_baseline'] = B.boot(acc, base_acc)
    if past_acc is not None: row['vs_past_llm'] = B.boot(acc, past_acc)
    if dedup is not None:
        ix = [i for i, x in enumerate(test) if x['id'] in dedup]; row['dedup'] = dict(n=len(ix), top1=round(100 * acc[ix].mean(), 1))
        if base_acc is not None: row['dedup']['vs_baseline'] = B.boot(acc[ix], np.asarray(base_acc)[ix])
    return row, acc
def cmd_eval(a):
    out_dir = a.out or os.path.join(a.corr, 'best-v2'); os.makedirs(out_dir, exist_ok=True)
    items, _ = load(a.corr); EXTRA = B.ensure_extra(items, a.corr, a.python)
    real, var, ctl = setup(items, a.variants); dev = [x for x in real if x['split'] == 'dev']; test = [x for x in real if x['split'] == 'test']
    tau = B.tune_tau([dict(key=x['key'], gold=x['gold']) for x in dev])
    devtext = {x['text'] for x in dev}; dedup = {x['id'] for x in test if x['text'] not in devtext}
    REP = dict(version=VERSION, n=dict(dev=len(dev), test=len(test), test_dedup=len(dedup), variants=len(var), controls=len(ctl)), tau=tau, configs={}, policy='C by grouped 5-fold dev-CV LL; defer = 20th pct of dev-CV gate scores; no test-set tuning')
    save = lambda: json.dump(REP, open(os.path.join(out_dir, 'report.json'), 'w'), ensure_ascii=False, indent=1)
    Rb, _ = B.run_pipe(dev, test, B.CFGS['baseline'], EXTRA, tau); base_row, base_acc = summarize(test, Rb, dedup=dedup); REP['configs']['baseline'] = base_row
    past_acc = np.array([float(ok(x, x['past'])) for x in test]); REP['configs']['past-llm(all)'] = dict(top1=round(100 * past_acc.mean(), 1), defer=100.0, vs_baseline=B.boot(past_acc, base_acc),
        none_acc=round(100 * np.mean([ok(x, x['past']) for x in test if x['none']]), 1), dedup=dict(n=len(dedup), top1=round(100 * np.mean([ok(x, x['past']) for x in test if x['id'] in dedup]), 1)))
    base_row['vs_past_llm'] = B.boot(base_acc, past_acc); save()
    FITS = {}
    for name, cfg in CFGS.items():
        t0 = time.time(); f = fit(dev, cfg, tau, EXTRA); FITS[name] = f; R = apply(f, test, dev, cfg, tau, EXTRA)
        row, _ = summarize(test, R, base_acc, past_acc, dedup); row.update(C=f['C'], th=round(f['th'], 4), cv_ll=f['cv_ll'], fit_sec=round(time.time() - t0, 1))
        # C / inner-fold sensitivity (all dev-only)
        row['C_sensitivity'] = {str(Cc): summarize(test, apply(fit(dev, cfg, tau, EXTRA, Cfix=Cc), test, dev, cfg, tau, EXTRA))[0]['top1'] for Cc in CGRID}
        row['inner_seed'] = [summarize(test, apply(fit(dev, cfg, tau, EXTRA, inner_seed=s), test, dev, cfg, tau, EXTRA))[0]['top1'] for s in (1, 2)]
        REP['configs'][name] = row; save(); print(name, json.dumps(row, ensure_ascii=False), file=sys.stderr)
    # ---- FT ruri swap-in (held-dev = dev minus the model's train ids) ----
    for spec in a.rerank:
        tag, d = spec.split('=', 1); rrf = os.path.join(a.corr, f'rerank-{tag}.json')
        if not os.path.exists(rrf): print('missing', rrf, file=sys.stderr); continue
        tid = ft_train_ids(d) or set(); fitems, _ = load(a.corr, rrf); freal, _, _ = setup(fitems, a.variants)
        assert not (tid & {x['id'] for x in freal if x['split'] == 'test'}), 'FT train ids overlap test'
        fdev = [x for x in freal if x['split'] == 'dev' and x['id'] not in tid]; ftest = [x for x in freal if x['split'] == 'test']; ids = {x['id'] for x in ftest}
        bt = [x for x in test if x['id'] in ids]; bix = [i for i, x in enumerate(test) if x['id'] in ids]
        for name in ('best-v2',):
            cfg = CFGS[name]; f = fit(fdev, cfg, tau, EXTRA); R = apply(f, ftest, fdev, cfg, tau, EXTRA)
            row, _ = summarize(ftest, R, base_acc[bix], past_acc[bix], dedup); row.update(C=f['C'], held_dev=len(fdev), train_ids_excluded=len(tid), ft_dir=d)
            # same held-dev with zero-shot ruri, for a like-for-like comparison
            zs = [x for x in dev if x['id'] not in tid]; fz = fit(zs, cfg, tau, EXTRA); rz, az = summarize(bt, apply(fz, bt, zs, cfg, tau, EXTRA)); row['zs_same_heldDev_top1'] = rz['top1']
            row['vs_zs_same_heldDev'] = B.boot(B.evaluate(ftest, R), az)
            REP['configs'][f'{name}[{tag}]'] = row; save(); print(tag, json.dumps(row, ensure_ascii=False), file=sys.stderr)
    # ---- phase B: user corrections ----
    PB = {}
    for name in ('best-v2', 'best-v2+tbl'):
        cfg = CFGS[name]; f = FITS[name]; R = apply(f, test + var + ctl, dev, cfg, tau, EXTRA)
        dec = lambda x, R: x['past'] if R[x['id']]['defer'] else R[x['id']]['P'][0][0]
        wrong = [x for x in test if not ok(x, dec(x, R))]; ws = {x['id'] for x in wrong}
        mem = dev + [dict(x, id='c-' + x['id'], corr=True) for x in wrong]; R2 = apply(f, test + var + ctl, mem, cfg, tau, EXTRA)
        vs = [x for x in var if x['src'] in ws]; rest = [x for x in test if x['id'] not in ws]; b = lambda xs, RR: [ok(x, dec(x, RR)) for x in xs]
        PB[name] = dict(corrections=len(wrong), variants_n=len(vs), variants_before=round(100 * np.mean(b(vs, R)), 1), variants_after=round(100 * np.mean(b(vs, R2)), 1),
                        kana_after=f"{sum(ok(x, dec(x, R2)) for x in vs if x['vtype'] == 'kana')}/{sum(x['vtype'] == 'kana' for x in vs)}",
                        misfire_rest=round(100 * np.mean([not ok(x, dec(x, R2)) for x in rest if ok(x, dec(x, R))]), 1),
                        controls_front_changed=sum(R[x['id']]['P'][0][0] != R2[x['id']]['P'][0][0] for x in ctl), controls_acc_before=round(100 * np.mean([ok(x, R[x['id']]['P'][0][0]) for x in ctl]), 1), controls_acc_after=round(100 * np.mean([ok(x, R2[x['id']]['P'][0][0]) for x in ctl]), 1),
                        all_variants_before=round(100 * np.mean(b(var, R)), 1), test_after=round(100 * np.mean(b(test, R2)), 1))
        REP['phaseB'] = PB; save(); print('phaseB', name, PB[name], file=sys.stderr)
    # ---- latency of the post-ruri stages (box CPU, per utterance) ----
    cfg = CFGS['best-v2+tbl']; f = FITS['best-v2+tbl']; lat = {}
    t0 = time.perf_counter()
    for x in test: B.knn_votes(x, dev, M, loo=False)
    lat['knn_ms'] = round(1000 * (time.perf_counter() - t0) / len(test), 3)
    t0 = time.perf_counter()
    for x in test: B.tbl_scores(x, dev, tau, loo=False)
    lat['table_ms'] = round(1000 * (time.perf_counter() - t0) / len(test), 3)
    pre = [(x, B.knn_votes(x, dev, M, loo=False), B.tbl_scores(x, dev, tau, loo=False)) for x in test]; t0 = time.perf_counter()
    for x, v, t in pre: route(*cand_matrix(x, x['rr'], v, t, cfg, {c: EXTRA.get((x['text'], c)) for c in t if (x['text'], c) in EXTRA}), f['model'])
    lat['features_lr_gate_ms'] = round(1000 * (time.perf_counter() - t0) / len(test), 3)
    lat['sr_ms_p50'] = float(np.median([x['sr_ms'] for x in test if x['sr_ms'] is not None])); REP['latency_post'] = lat; save()
    if not a.skip_robust: robust(real, EXTRA, REP, save)
    print(json.dumps(REP, ensure_ascii=False, indent=1))
def robust(real, EXTRA, REP, save):
    rob = {}
    for name in ('baseline', 'best-v2', 'best-v2+tbl'):
        accs, dfs = [], []
        def go(tr, ev):
            tau = B.tune_tau([dict(key=x['key'], gold=x['gold']) for x in tr])
            if name == 'baseline': R, _ = B.run_pipe(tr, ev, B.CFGS['baseline'], EXTRA, tau)
            else: R = apply(fit(tr, CFGS[name], tau, EXTRA), ev, tr, CFGS[name], tau, EXTRA)
            return 100 * B.evaluate(ev, R).mean(), 100 * np.mean([R[x['id']]['defer'] for x in ev])
        for sd in range(3):
            for fo in B.gkfold(real, 5, 100 + sd):
                fs = set(fo); a_, d_ = go([r for j, r in enumerate(real) if j not in fs], [real[j] for j in fo]); accs.append(a_); dfs.append(d_)
        rob[name] = dict(group5fold_top1_mean=round(float(np.mean(accs)), 1), sd=round(float(np.std(accs)), 1), min=round(min(accs), 1), max=round(max(accs), 1), defer_mean=round(float(np.mean(dfs)), 1), n_folds=len(accs))
        main = sorted([r for r in real if r['conv'] == 'main'], key=lambda r: r['seq']); other = [r for r in real if r['conv'] != 'main']; ts = []
        for q in (.5, .6, .7):
            k = int(len(main) * q); a_, d_ = go(main[:k] + other, main[k:]); ts.append(dict(train_frac=q, n_eval=len(main) - k, top1=round(a_, 1), defer=round(d_, 1)))
        rob[name]['time_split_main'] = ts; REP['robust'] = rob; save(); print('robust', name, rob[name], file=sys.stderr)
# ---------------- export / predict ----------------
def cmd_export(a):
    items, _ = load(a.corr); real, _, _ = setup(items, a.variants); dev = [x for x in real if x['split'] == 'dev']; cfg = CFGS[a.cfg]
    EXTRA = B.ensure_extra(items, a.corr, a.python); tau = B.tune_tau([dict(key=x['key'], gold=x['gold']) for x in dev]); f = fit(dev, cfg, tau, EXTRA)
    os.makedirs(a.artifact, exist_ok=True); cards = json.load(open(os.path.join(a.corr, 'rerank-in.json')))['cards']
    np.savez_compressed(os.path.join(a.artifact, 'memory.npz'), vec=np.stack([x['vec'] for x in dev]).astype('<f4'))
    mem = [dict(id=x['id'], gold=x['gold'], text=x['text'], key=list(x['key'])) for x in dev]
    meta = dict(version=VERSION, cfg=a.cfg, flags=cfg, features=FN2, ranker=f['model'].to_json(), C=f['C'], gate=dict(kind='p1-p2', defer_below=f['th'], q=0.2), fuse=dict(W=W, CONV=CONV, k=8), knn=dict(M=M, model='intfloat/multilingual-e5-small', prefix='passage: '),
                table=dict(tau=tau), ruri=dict(model='cl-nagoya/ruri-v3-reranker-310m', revision='bb46934ee9ed09f850b9fcff17501b3ef7ddb2b3', doc="passages[0] + ' 例: ' + ' / '.join(passages[1:6])", max_length=512, text_chars=400),
                n_memory=len(mem), trained_on='dev split only', created=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
    json.dump(dict(meta=meta, memory=mem, cards=cards), open(os.path.join(a.artifact, 'model.json'), 'w'), ensure_ascii=False)
    h = hashlib.sha256(open(os.path.join(a.artifact, 'model.json'), 'rb').read() + open(os.path.join(a.artifact, 'memory.npz'), 'rb').read()).hexdigest()[:16]
    print(json.dumps(dict(artifact=a.artifact, version=VERSION, sha=h, C=f['C'], th=f['th'], n_memory=len(mem)), ensure_ascii=False))
class Predictor:
    def __init__(self, art, ruri=None, e5=None):
        d = json.load(open(os.path.join(art, 'model.json'))); self.meta = d['meta']; self.cards = d['cards']; self.flags = self.meta['flags']
        vec = np.load(os.path.join(art, 'memory.npz'))['vec']; self.mem = [dict(m, vec=vec[i], key=tuple(m['key'])) for i, m in enumerate(d['memory'])]
        r = self.meta['ranker']; self.ranker = Ranker(r['mean'], r['scale'], r['coef'], r['intercept']); self.th = self.meta['gate']['defer_below']
        self.ruri_name = ruri or self.meta['ruri']['model']; self.e5_name = e5 or self.meta['knn']['model']; self._ruri = self._e5 = self._kks = None
    def ruri(self, text, tools):
        import torch
        if self._ruri is None:
            from transformers import AutoTokenizer, AutoModelForSequenceClassification
            self._ruri = (AutoTokenizer.from_pretrained(self.ruri_name), AutoModelForSequenceClassification.from_pretrained(self.ruri_name).eval())
        tok, mdl = self._ruri
        def doc(c): p = self.cards.get(c, {}).get('passages') or [c]; return p[0] + ' 例: ' + ' / '.join(p[1:6])
        if not tools: return {}
        with torch.inference_mode():
            enc = tok([text[:400]] * len(tools), [doc(c) for c in tools], truncation=True, max_length=512, padding=True, return_tensors='pt'); lg = mdl(**enc).logits
            return dict(zip(tools, (lg[:, 0] if lg.shape[-1] == 1 else lg[:, -1]).sigmoid().tolist()))
    def e5(self, text):
        import torch
        if self._e5 is None:
            from transformers import AutoTokenizer, AutoModel
            self._e5 = (AutoTokenizer.from_pretrained(self.e5_name), AutoModel.from_pretrained(self.e5_name).eval())
        tok, mdl = self._e5
        with torch.inference_mode():
            enc = tok(['passage: ' + text], truncation=True, max_length=512, return_tensors='pt'); h = mdl(**enc).last_hidden_state; m = enc['attention_mask'].unsqueeze(-1).float()
            return torch.nn.functional.normalize((h * m).sum(1) / m.sum(1), dim=-1)[0].numpy().astype('<f4')
    def key(self, text):
        import unicodedata
        if self._kks is None: import pykakasi; self._kks = pykakasi.kakasi()
        rd = ''.join(t['hira'] for t in self._kks.convert(unicodedata.normalize('NFKC', text))); return (B.skey(text), B.skey(rd))
    def predict(self, row):
        """row: {text, sr: [[tool, p], ...] (sr-corr probabilities, ≤8), sr_scores: {tool: score}, vec?: [e5], rr?: {tool: ruri}}"""
        T = {}; t = time.perf_counter(); x = dict(id=row.get('id', '_q'), text=row['text'], sr=[tuple(p) for p in sorted(row['sr'], key=lambda kv: -kv[1])][:8], sr_scores=row.get('sr_scores', {}))
        x['vec'] = np.asarray(row['vec'], '<f4') if row.get('vec') is not None else self.e5(row['text']); T['e5_ms'] = 1000 * (time.perf_counter() - t)
        t = time.perf_counter(); votes = B.knn_votes(x, self.mem, M, loo=False) if self.flags['knn'] else []; T['knn_ms'] = 1000 * (time.perf_counter() - t)
        t = time.perf_counter(); tbl = {}
        if self.flags['tbl']: x['key'] = self.key(row['text']); tbl = B.tbl_scores(x, self.mem, self.meta['table']['tau'], loo=False)
        T['table_ms'] = 1000 * (time.perf_counter() - t)
        t = time.perf_counter(); tools = [c for c, _ in x['sr'] if c != C]; extra = [c for c in tbl if c != C and c not in tools]
        rr = row.get('rr') or self.ruri(row['text'], tools + extra); T['ruri_ms'] = 1000 * (time.perf_counter() - t)
        t = time.perf_counter(); cs, F = cand_matrix(x, {c: rr[c] for c in tools if c in rr}, votes, tbl, self.flags, {c: rr[c] for c in extra if c in rr}); P, s = route(cs, F, self.ranker); T['rank_gate_ms'] = 1000 * (time.perf_counter() - t)
        return dict(id=x['id'], tool=P[0][0], defer=bool(s < self.th), gate=round(s, 4), defer_below=round(self.th, 4), scores=[[c, round(p, 4)] for c, p in P], llm_candidates=[c for c, _ in P[:3]] if s < self.th else [],
                    latency_ms={k: round(v, 2) for k, v in T.items()} | dict(total=round(sum(T.values()), 2)), version=self.meta['version'])
def cmd_predict(a):
    p = Predictor(a.artifact, a.ruri, a.e5)
    rows = [json.loads(a.row)] if a.row else [json.loads(l) for l in (open(a.inp) if a.inp != '-' else sys.stdin) if l.strip()]
    out = open(a.out, 'w') if a.out else sys.stdout
    for r in rows: out.write(json.dumps(p.predict(r), ensure_ascii=False) + '\n'); out.flush()
def cmd_export_verify(a):
    """Items for tokens.py verify: best-v2's deferred test items, LR top-4 candidates with card texts (gold kept for scoring only)."""
    items, _ = load(a.corr); EXTRA = B.ensure_extra(items, a.corr, a.python); real, _, _ = setup(items, a.variants)
    dev = [x for x in real if x['split'] == 'dev']; test = [x for x in real if x['split'] == 'test']; cfg = CFGS[a.cfg]
    tau = B.tune_tau([dict(key=x['key'], gold=x['gold']) for x in dev]); f = fit(dev, cfg, tau, EXTRA); R = apply(f, test, dev, cfg, tau, EXTRA)
    cards = json.load(open(os.path.join(a.corr, 'rerank-in.json')))['cards']; doc = lambda c: (lambda p: p[0] + ' 例: ' + ' / '.join(p[1:6]))(cards.get(c, {}).get('passages') or [c]); n = 0
    with open(a.out, 'w') as o:
        for x in test:
            if R[x['id']]['defer']:
                cs = [c for c, _ in R[x['id']]['P'][:4]]; n += 1
                o.write(json.dumps(dict(id=x['id'], text=x['text'], cands=cs, docs={c: doc(c) for c in cs}, gold=x['gold'], acceptable=sorted(x['acc']), past=x['past']), ensure_ascii=False) + '\n')
    print(json.dumps(dict(out=a.out, deferred=n, of=len(test))))
def cmd_leak_check(a):
    """No test label may reach training: FT train ids ⊆ dev, and (optionally) a pairs jsonl carries no test-only utterance text or test id."""
    import sqlite3, unicodedata
    db = sqlite3.connect(os.path.join(a.corr, 'corr.db')); sp = {i: s for i, s in db.execute('select utterance_id, split from bench_labels')}
    txt = {i: json.loads(j)['text'] for i, j in db.execute('select id, utterance_json from bench_utterances')}; N = lambda t: unicodedata.normalize('NFKC', t).strip()
    dev_t = {N(txt[i]) for i, s in sp.items() if s == 'dev' and i in txt}; test_ids = {i for i, s in sp.items() if s == 'test' and not i.startswith(('var-', 'ctl-'))}
    test_only = {N(txt[i]) for i in test_ids if i in txt} - dev_t; rep = dict(models={}, pairs={}); bad = False
    for d in a.ft:
        t = ft_train_ids(d) or set(); r = dict(train_ids=len(t), in_test=len(t & test_ids), in_dev=sum(sp.get(i) == 'dev' for i in t), unknown=sum(i not in sp for i in t)); rep['models'][d] = r; bad |= r['in_test'] > 0
    for pf in a.pairs:
        ids = texts = 0; n = 0
        for l in open(pf):
            if not l.strip(): continue
            n += 1; row = json.loads(l); vals = [v for v in (row.values() if isinstance(row, dict) else row) if isinstance(v, str)]
            ids += any(v in test_ids for v in vals); texts += any(N(v) in test_only for v in vals)
        rep['pairs'][pf] = dict(rows=n, rows_with_test_id=ids, rows_with_test_only_text=texts); bad |= ids > 0 or texts > 0
    rep['note'] = f'{len(test_ids)} test ids; {len(test_ids) - len(test_only)} test texts also occur in dev (legitimate dev memory, not a leak)'; rep['pass'] = not bad
    print(json.dumps(rep, ensure_ascii=False, indent=1)); sys.exit(0 if not bad else 1)
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('cmd', choices=['eval', 'export', 'predict', 'export-verify', 'leak-check']); ap.add_argument('--corr'); ap.add_argument('--out'); ap.add_argument('--python', default=sys.executable)
    ap.add_argument('--variants', default=os.path.join(HERE, '..', 'correction', 'variants.jsonl')); ap.add_argument('--rerank', action='append', default=[]); ap.add_argument('--skip-robust', action='store_true')
    ap.add_argument('--artifact'); ap.add_argument('--cfg', default='best-v2'); ap.add_argument('--in', dest='inp'); ap.add_argument('--row'); ap.add_argument('--ruri'); ap.add_argument('--e5'); ap.add_argument('--ft', action='append', default=[]); ap.add_argument('--pairs', action='append', default=[]); a = ap.parse_args()
    {'eval': cmd_eval, 'export': cmd_export, 'predict': cmd_predict, 'export-verify': cmd_export_verify, 'leak-check': cmd_leak_check}[a.cmd](a)
if __name__ == '__main__': main()
