#!/usr/bin/env python3
"""Round 4 non-ruri algorithms on the sr + ruri -> LLM cascade (CPU, local only, no API).
Rerank inputs are FIXED: zero-shot ruri (zs) and FT k10 conv-positive seeds 0/1/2 (cp0..cp2).
Protocol: everything learned/tuned on dev only (5-fold CV on dev for model selection; for cp* the ruri-training rows are excluded
-> held-dev), test (217) read once per config. Baseline = fused w=2 conv=0.18, defer if margin < 20% dev quantile.
"LLM" = recorded past choice (round-3 LLM log); E5/E6 LLM variants are SIMULATED (see report).
  python algo4.py /tmp/a4/out.json"""
import json, math, os, sys, random, collections
import numpy as np
D = json.load(open('/tmp/r3/dump.json')); ROWS = D['rows']; C = 'conversation.respond'; W, CONV = 2.0, 0.18
for r in ROWS:
    for k in ('acceptable', 'none', 'ctx'):
        if isinstance(r[k], str): r[k] = eval(r[k])
ok = lambda r, t: t == r['gold'] or t in r['acceptable']
TEST = [r for r in ROWS if r['split'] == 'test']; DEV = [r for r in ROWS if r['split'] == 'dev']
KNN = json.load(open('/tmp/a4/knn.json'))
def load_rr(tag):
    if tag == 'zs': base = json.load(open('/tmp/ft/zs.json'))['rr']; tid = set(); xf = '/tmp/a4/rrx-zs.json'
    else:
        s = tag[2:]; base = json.load(open(f'/tmp/ft/k10-convpos-s{s}/scores.json'))['rr']; tid = set(json.load(open(f'/tmp/ft/k10-convpos-s{s}/meta.json'))['train_ids']); xf = f'/tmp/a4/rrx-cp{s}.json'
    ext = json.load(open(xf)) if os.path.exists(xf) else {}
    return base, tid, ext
def extra_of(r, ext, N):
    if N == 0: return {}
    ex = [c for c, _ in KNN[r['id']] if c != C and c not in dict(r['sr'])][:N]
    if not ex: return {}
    sc = ext.get(r['text'] + '\x00' + '|'.join([c for c, _ in KNN[r['id']] if c != C and c not in dict(r['sr'])][:3]), {})
    return {c: sc[c] for c in ex if c in sc}
def fuse(r, rr, k=8, extra=None, w=W, conv=CONV):
    s = dict(r['sr'][:k]); ids = [c for c in s if c != C]; ids = [c for c in ids if c in rr] + [C]
    x = dict(rr); x.update(extra or {}); ids += [c for c in (extra or {}) if c not in ids]
    comb = [s.get(c, 0) + (conv + w * rr.get(C, 0) if c == C else w * x[c]) for c in ids]
    mx = max(comb); e = [math.exp(v - mx) for v in comb]; z = sum(e)
    return sorted(zip(ids, [v / z for v in e]), key=lambda kv: -kv[1])
marg = lambda p: math.log(p[0][1] + 1e-12) - math.log((p[1][1] if len(p) > 1 else 0) + 1e-12)
llm = lambda r: r['past'][0][0]
def casc(rows, P, score, th):  # defer when score < th
    return [ok(r, llm(r)) if s < th else ok(r, p[0][0]) for r, p, s in zip(rows, P, score)], [s < th for s in score]
def q_th(scores, q=0.2): s = sorted(scores); return s[max(int(len(s) * q) - 1, 0)] + 1e-9
pct = lambda xs: round(100 * sum(xs) / max(1, len(xs)), 1)
def boot(a, b, B=4000, seed=1):
    d = np.array(a, float) - np.array(b, float); rnd = np.random.default_rng(seed); n = len(d)
    xs = np.sort(d[rnd.integers(0, n, (B, n))].mean(1)) * 100; return [round(d.mean() * 100, 1), round(xs[int(B * .025)], 1), round(xs[int(B * .975) - 1], 1)]
def curve(rows, P, score):
    """deferral sweep on test: (defer%, top1%) for every cut point"""
    order = sorted(range(len(rows)), key=lambda i: score[i]); fr = [ok(r, p[0][0]) for r, p in zip(rows, P)]; lm = [ok(r, llm(r)) for r in rows]
    out = []; cur = sum(fr)
    out.append((0.0, 100 * cur / len(rows)))
    for j, i in enumerate(order): cur += lm[i] - fr[i]; out.append((100 * (j + 1) / len(rows), 100 * cur / len(rows)))
    return out
def at_defer(cv, d): return round(min(cv, key=lambda x: abs(x[0] - d))[1], 1)
def defer_at(cv, t): xs = [x[0] for x in cv if x[1] >= t]; return round(min(xs), 1) if xs else None
def ece(p, y, nb=10):
    p = np.array(p); y = np.array(y, float); e = 0
    for i in range(nb):
        m = (p >= i / nb) & (p < (i + 1) / nb + (1e-9 if i == nb - 1 else 0))
        if m.any(): e += m.mean() * abs(p[m].mean() - y[m].mean())
    return round(100 * e, 1)

# ---------------- features ----------------
def ent(ps): return -sum(p * math.log(p + 1e-12) for p in ps)
def gate_feats(r, rr, P):
    sr = r['sr']; sp = [p for _, p in sr]; ss = sorted(r['srScores'].values(), reverse=True)
    rrs = sorted([v for c, v in rr.items() if c != C], reverse=True) + [0, 0]
    return [sp[0], sp[1], sp[0] - sp[1], ent(sp), ss[0], ss[1],  # sr 6
            rr.get(P[0][0], 0), rrs[0] - rrs[1], marg(P), P[0][1] - P[1][1], ent([p for _, p in P]),
            float(sr[0][0] == max(rr, key=rr.get)), float(sr[0][0] == P[0][0]), float(bool(r.get('prevUser'))), float(r['ctx']),
            math.log1p(len(r['text'])), rr.get(C, 0), float(P[0][0] == C), dict(P).get(C, 0)]
GATE_NAMES = 'sr_p1 sr_p2 sr_marg sr_ent srS1 srS2 rr_top1 rr_marg fused_logmarg fused_marg fused_ent agree_sr_rr agree_sr_fused has_prev ctx log_len rr_conv top1_is_conv fused_conv'.split()
def cand_feats(r, rr, P, c, rank, use_knn=True):
    s = dict(r['sr']); sr_rank = [x for x, _ in r['sr']].index(c) if c in s else 9
    rrs = sorted([v for k, v in rr.items() if k != C], reverse=True); rv = rr.get(c, 0)
    kn = dict(KNN[r['id']]); kmax = max(kn.values()) if kn else 1
    return [s.get(c, 0), sr_rank, r['srScores'].get(c, 0), rv, (rrs.index(rv) if rv in rrs else 9), rv - (rrs[0] if rrs else 0), dict(P).get(c, 0), rank, float(c == C)] + ([kn.get(c, 0) / kmax] if use_knn else [])

def cv_folds(n, k=5, seed=0): idx = list(range(n)); random.Random(seed).shuffle(idx); return [idx[i::k] for i in range(k)]

def run(tag, Nx=0):
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import make_pipeline
    from sklearn.isotonic import IsotonicRegression
    import lightgbm as lgb
    base, tid, ext = load_rr(tag); held = [r for r in DEV if r['id'] not in tid]
    PH = {r['id']: fuse(r, base[r['id']], extra=extra_of(r, ext, Nx)) for r in ROWS}
    res = {'tag': tag, 'n_heldDev': len(held), 'knnN': Nx}
    Pt = [PH[r['id']] for r in TEST]; mt = [marg(p) for p in Pt]
    th = q_th([marg(PH[r['id']]) for r in held]); bl, bd = casc(TEST, Pt, mt, th); cvb = curve(TEST, Pt, mt)
    res['baseline'] = dict(front=pct([ok(r, p[0][0]) for r, p in zip(TEST, Pt)]), top1=pct(bl), defer=pct(bd), R={k: pct([any(ok(r, c) for c, _ in p[:k]) for r, p in zip(TEST, Pt)]) for k in (1, 2, 3, 5, 10)},
                          at20=at_defer(cvb, 20), at29_5=at_defer(cvb, 29.5), defer_at81_6=defer_at(cvb, 81.6))
    target = res['baseline']['top1']
    # ---- E1 gate ----
    Xh = np.array([gate_feats(r, base[r['id']], PH[r['id']]) for r in held]); yh = np.array([ok(r, PH[r['id']][0][0]) for r in held], int)
    Xt = np.array([gate_feats(r, base[r['id']], PH[r['id']]) for r in TEST]); yt = [ok(r, p[0][0]) for r, p in zip(TEST, Pt)]
    def mk(kind, hp, seed):
        if kind == 'lr': return make_pipeline(StandardScaler(), LogisticRegression(C=hp, max_iter=2000))
        return lgb.LGBMClassifier(n_estimators=hp, learning_rate=0.05, num_leaves=4, min_child_samples=15, reg_lambda=10, subsample=0.7, subsample_freq=1, colsample_bytree=0.7, random_state=seed, verbose=-1)
    def cvpred(kind, hp, seed):
        pr = np.zeros(len(yh))
        for f in cv_folds(len(yh), 5, seed):
            tr = np.setdiff1d(np.arange(len(yh)), f)
            if yh[tr].min() == yh[tr].max(): pr[f] = yh[tr].mean(); continue
            m = mk(kind, hp, seed).fit(Xh[tr], yh[tr]); pr[f] = m.predict_proba(Xh[f])[:, 1]
        return pr
    ll = lambda p: float(-np.mean(yh * np.log(np.clip(p, 1e-6, 1)) + (1 - yh) * np.log(np.clip(1 - p, 1e-6, 1))))
    gates = {}
    for kind, grid in (('lr', [0.01, 0.03, 0.1, 0.3, 1.0]), ('gbm', [25, 50, 100, 200])):
        per_seed = []
        for seed in ((0,) if kind == 'lr' else (0, 1, 2)):
            sel = min(grid, key=lambda hp: ll(cvpred(kind, hp, seed))); pcv = cvpred(kind, sel, seed)
            m = mk(kind, sel, seed).fit(Xh, yh); pt = m.predict_proba(Xt)[:, 1]
            iso = IsotonicRegression(out_of_bounds='clip', y_min=0.01, y_max=0.99).fit(pcv, yh); ptc = iso.predict(pt)
            gth = q_th(list(pcv)); gl, gd = casc(TEST, Pt, list(pt), gth); cv = curve(TEST, Pt, list(pt))
            per_seed.append(dict(hp=sel, cv_logloss=round(ll(pcv), 3), top1=pct(gl), defer=pct(gd), at20=at_defer(cv, 20), at29_5=at_defer(cv, 29.5), defer_at81_6=defer_at(cv, 81.6),
                                 defer_at_baseline=defer_at(cv, target), ece_raw=ece(pt, yt), ece_iso=ece(ptc, yt), vs_baseline=boot(gl, bl), _ok=gl))
            if kind == 'lr': per_seed[-1]['coef'] = dict(zip(GATE_NAMES, np.round(m[-1].coef_[0], 2).tolist()))
        gates[kind] = per_seed
    # margin-only calibrated (ECE reference)
    pm = 1 / (1 + np.exp(-np.array(mt))); res['baseline']['ece_sigmoid_margin'] = ece(pm, yt)
    res['E1'] = {k: [{kk: vv for kk, vv in s.items() if kk != '_ok'} for s in v] for k, v in gates.items()}
    # ---- E2 ranker over fused candidates ----
    e2 = {}
    for uk in (False, True):
      def cands(r): P = PH[r['id']]; return P, [cand_feats(r, base[r['id']], P, c, i, uk) for i, (c, _) in enumerate(P)]
      Gh = [cands(r) for r in held]; Gt = [cands(r) for r in TEST]
      Xc = np.array([f for _, F in Gh for f in F]); yc = np.array([int(ok(r, c)) for r, (P, _) in zip(held, Gh) for c, _ in P]); grp = [len(P) for P, _ in Gh]
      gid = np.repeat(np.arange(len(Gh)), grp)
      def rank_eval(scores_by_row, rows, G):
          Pn = [sorted(zip([c for c, _ in P], s), key=lambda kv: -kv[1]) for (P, _), s in zip(G, scores_by_row)]
          return Pn
      for kind in ('lr', 'lambdarank'):
          runs = []
          for seed in ((0,) if kind == 'lr' else (0, 1, 2)):
              def fit(Xa, ya, ga):
                  if kind == 'lr': return make_pipeline(StandardScaler(), LogisticRegression(C=0.1, max_iter=2000)).fit(Xa, ya)
                  return lgb.LGBMRanker(n_estimators=100, learning_rate=0.05, num_leaves=4, min_child_samples=10, reg_lambda=10, subsample=0.7, subsample_freq=1, random_state=seed, verbose=-1).fit(Xa, ya, group=ga)
              pred = (lambda m, X: m.predict_proba(X)[:, 1]) if kind == 'lr' else (lambda m, X: m.predict(X))
              # CV margins on dev for the deferral threshold
              cvm = np.zeros(len(Gh))
              for f in cv_folds(len(Gh), 5, seed):
                  tr = np.setdiff1d(np.arange(len(Gh)), f); mtr = np.isin(gid, tr)
                  m = fit(Xc[mtr], yc[mtr], [grp[i] for i in tr])
                  for i in f:
                      s = np.sort(pred(m, np.array(Gh[i][1])))[::-1]; cvm[i] = s[0] - (s[1] if len(s) > 1 else -9)
              m = fit(Xc, yc, grp); St = [pred(m, np.array(F)) for _, F in Gt]
              Pn = rank_eval(St, TEST, Gt); sc = [float(s[0][1] - s[1][1]) for s in Pn]
              gl, gd = casc(TEST, Pn, sc, q_th(list(cvm))); cv = curve(TEST, Pn, sc)
              runs.append(dict(front=pct([ok(r, p[0][0]) for r, p in zip(TEST, Pn)]), R={k: pct([any(ok(r, c) for c, _ in p[:k]) for r, p in zip(TEST, Pn)]) for k in (1, 2, 3, 5)},
                               top1=pct(gl), defer=pct(gd), at20=at_defer(cv, 20), at29_5=at_defer(cv, 29.5), defer_at81_6=defer_at(cv, 81.6), vs_baseline=boot(gl, bl)))
          e2[('knnfeat|' if uk else 'nofeat|') + kind] = runs
    res['E2'] = e2
    # ---- E5 candidate counts (sr k into ruri; LLM top-n, simulated) ----
    e5 = {}
    for k in (3, 5, 8):
        Pk = {r['id']: fuse(r, base[r['id']], k=k) for r in ROWS}; P2 = [Pk[r['id']] for r in TEST]; s2 = [marg(p) for p in P2]
        gl, gd = casc(TEST, P2, s2, q_th([marg(Pk[r['id']]) for r in held])); cv = curve(TEST, P2, s2)
        e5[f'sr_k{k}'] = dict(R_sr={kk: pct([any(ok(r, c) for c, _ in r['sr'][:kk]) for r in TEST]) for kk in (1, 3, 5, 8)}, front=pct([ok(r, p[0][0]) for r, p in zip(TEST, P2)]), top1=pct(gl), defer=pct(gd), at29_5=at_defer(cv, 29.5))
    for n in (1, 2, 3, 4):  # SIMULATED LLM restricted to fused top-n: picks the highest-probability past choice inside top-n, else fused top-1
        def pick(r, p): top = [c for c, _ in p[:n]]; inn = [c for c, _ in r['past'] if c in top]; return inn[0] if inn else top[0]
        out = [ok(r, pick(r, p)) if d else ok(r, p[0][0]) for r, p, d in zip(TEST, Pt, bd)]
        e5[f'llm_top{n}_sim'] = dict(top1=pct(out), defer=pct(bd), upper_bound_gold_in_topn=pct([any(ok(r, c) for c, _ in p[:n]) if d else ok(r, p[0][0]) for r, p, d in zip(TEST, Pt, bd)]), vs_baseline=boot(out, bl))
    res['E5'] = e5
    # ---- E6 procedural verifier protocols (SIMULATED verifier: true-yes on a correct candidate with prob 1-fn, false-yes on a wrong one with prob fy) ----
    e6 = {}
    for fy in (0.0, 0.1, 0.2, 0.3):
        for fn in (0.0, 0.1):
            for proto in ('a_seq3', 'b_top2', 'c_top3list'):
                tops, calls, dfr, fyes = [], [], [], []
                for seed in range(20):
                    rnd = random.Random(seed * 7 + 1); T = []; Cl = 0; Fy = 0
                    for r, p, d in zip(TEST, Pt, bd):
                        if not d: T.append(ok(r, p[0][0])); continue
                        if proto == 'a_seq3':
                            ans = None
                            for c, _ in p[:3]:
                                Cl += 1; yes = (rnd.random() >= fn) if ok(r, c) else (rnd.random() < fy)
                                if yes: ans = c; Fy += not ok(r, c); break
                            T.append(ok(r, ans) if ans else ok(r, llm(r)))  # all-no -> full LLM call
                            Cl += ans is None
                        else:
                            n = 2 if proto == 'b_top2' else 3; Cl += 1; top = [c for c, _ in p[:n]]; good = [c for c in top if ok(r, c)]
                            # choice among n: correct if a correct one is present and the verifier doesn't slip (prob fy picks a wrong one); none present -> wrong
                            if good and rnd.random() >= fy: T.append(True)
                            else: T.append(False); Fy += 1
                    tops.append(pct(T)); calls.append(Cl / len(TEST)); fyes.append(Fy)
                e6[f'{proto}|fy{fy}|fn{fn}'] = dict(top1=round(float(np.mean(tops)), 1), sd=round(float(np.std(tops)), 1), llm_calls_per_item=round(float(np.mean(calls)), 3), defer=pct(bd), wrong_accepts=round(float(np.mean(fyes)), 1))
    res['E6'] = e6; res['E6_note'] = 'deferred items only; non-deferred keep fused top-1. 20 Monte-Carlo runs. baseline full-list LLM = recorded past choice.'
    # ---- E3 knn effect ----
    return res

def export_verify(tag, outp):
    """Items for tokens.py verify: the baseline's deferred test items with the fused ranking (top-4) and card texts."""
    base, tid, _ = load_rr(tag); held = [r for r in DEV if r['id'] not in tid]
    PH = {r['id']: fuse(r, base[r['id']]) for r in ROWS}; th = q_th([marg(PH[r['id']]) for r in held])
    doc = lambda c: (lambda p: p[0] + ' 例: ' + ' / '.join(p[1:6]))(D['cards'].get(c, {}).get('passages') or [c])
    with open(outp, 'w') as f:
        for r in TEST:
            p = PH[r['id']]
            if marg(p) < th: cs = [c for c, _ in p[:4]]; f.write(json.dumps(dict(id=r['id'], text=r['text'], cands=cs, docs={c: doc(c) for c in cs}, gold=r['gold'], acceptable=r['acceptable']), ensure_ascii=False) + '\n')

if __name__ == '__main__':
    if sys.argv[1] == 'export-verify': export_verify(sys.argv[2], sys.argv[3]); sys.exit()
    out = {}
    for tag in sys.argv[2:] or ['zs', 'cp0', 'cp1', 'cp2']:
        for Nx in (0, 1, 3):
            if Nx and not os.path.exists('/tmp/a4/rrx-' + tag.replace('cp', 'cp') + '.json'): continue
            out[f'{tag}|knn{Nx}'] = run(tag, Nx); print(tag, Nx, 'done', file=sys.stderr)
            json.dump(out, open(sys.argv[1], 'w'), ensure_ascii=False, indent=1)
