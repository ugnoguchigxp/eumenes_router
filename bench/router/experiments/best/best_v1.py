#!/usr/bin/env python3
"""best-v1: zero-shot ruri fixed, everything else learned on dev. Local CPU only, no external APIs.

  python best_v1.py --corr DIR [--out DIR] [--python PY] [--seeds 3]
DIR = output of `bun run router correct --rerank ruri --table 1 --variants ... --controls ...` (corr.db with e5 vectors,
runs/sr-corr-*, runs/past-*, rerank-ruri.json, readings.json). Missing ruri scores for kNN extra candidates are computed
with experiments/correction/models.py (cached in DIR/rerank-ruri-extra.json).

Pipeline (per utterance):
 1 candidates = sr top-8 ∪ kNN extras (e5 cosine, dev memory, M=10 neighbours, ≤N tools not in sr)
 2 fusion     = logistic regression over (sr p, sr rank, ruri, is_conv, kNN vote, table score/hit, in_sr), C by 5-fold CV on dev
 3 table      = variant-aware key (NFKC/kana/alias/endings + pykakasi reading Dice), τ tuned on dev; soft feature only (no pin)
 4 gate       = LightGBM (λ=10, 4 leaves) or LR+isotonic on 15 features incl. kNN & table-hit; P(front correct); operating point on dev CV
 5 LLM        = recorded full-list LLM choice (past) on deferred items; or SIMULATED sequential yes/no (top-3, false-yes 0–30%)
Phase B (user correction): wrong test answers are added to the kNN/table memory, then variants / controls / rest are re-routed.
"""
import argparse, json, math, os, random, re, sqlite3, struct, subprocess, sys, time, unicodedata, hashlib, collections
import numpy as np
C = 'conversation.respond'; W, CONV = 2.0, 0.18
HERE = os.path.dirname(os.path.abspath(__file__))
# ---------------- variant table (port of bench/router/variant-table.ts) ----------------
ALIASES = dict(git="ぎっと", github="ぎっとはぶ", google="ぐーぐる", youtube="ゆーちゅーぶ", python="ぱいそん", excel="えくせる", word="わーど", pdf="ぴーでぃーえふ", ai="えーあい", chatgpt="ちゃっとじーぴーてぃー", gpt="じーぴーてぃー", slack="すらっく", zoom="ずーむ", mail="めーる", email="いーめーる", gmail="じーめーる", image="いめーじ", music="みゅーじっく", song="そんぐ", timer="たいまー", alarm="あらーむ", weather="うぇざー", news="にゅーす", web="うぇぶ", search="さーち", app="あぷり", ui="ゆーあい", html="えいちてぃーえむえる", css="しーえすえす", api="えーぴーあい", url="ゆーあーるえる", browser="ぶらうざ", chrome="くろーむ", amazon="あまぞん", spotify="すぽてぃふぁい", x="えっくす", twitter="ついったー", line="らいん", pc="ぴーしー", iphone="あいふぉん", android="あんどろいど", model="もでる", data="でーた", memo="めも", map="まっぷ", cg="しーじー", bgm="びーじーえむ", ok="おーけー", note="のーと")
ALIASES["3d"] = "すりーでぃー"
ENDINGS = ["おねがいします", "おねがいいたします", "おねがい", "くださいませ", "ください", "くれませんか", "もらえますか", "もらえる", "ほしいです", "ほしい", "くれる", "ちょうだい", "ませんか", "ますか", "ます", "です", "でしょうか", "かな", "よね", "ね", "よ", "な", "か", "わ", "くれ", "て"]
def k2h(s): return ''.join(chr(ord(c) - 0x60) if '\u30a1' <= c <= '\u30f6' else c for c in s)
def strip_end(s):
    ch = True
    while ch:
        ch = False
        for e in ENDINGS:
            if len(s) > len(e) + 2 and s.endswith(e): s = s[:-len(e)]; ch = True; break
    return s
def skey(t):
    s = unicodedata.normalize('NFKC', t).lower(); s = re.sub(r'[a-z0-9][a-z0-9.+#-]*', lambda m: ALIASES.get(m.group(0), m.group(0)), s)
    s = ''.join(c for c in k2h(s) if not (c.isspace() or unicodedata.category(c)[0] in 'PS' or c in 'ー〜'))
    return strip_end(s)
def bigr(s): return collections.Counter(s[i:i + 2] for i in range(len(s) - 1))
def dice(a, b):
    if a == b: return 1.0
    A, B = bigr(a), bigr(b); n = sum(A.values()) + sum(B.values()); return 2 * sum((A & B).values()) / n if n else 0.0
def tscore(a, b): return 1.0 if a[0] == b[0] or a[1] == b[1] else dice(a[1], b[1])
def tune_tau(dev, maxf=0.02, grid=(.5, .55, .6, .65, .7, .75, .8, .85, .9, .95)):
    best = [max([0] + [tscore(x['key'], y['key']) for y in dev if y is not x and y['gold'] != x['gold']]) for x in dev]
    for t in grid:
        if sum(b >= t for b in best) / len(dev) <= maxf: return t
    return 1.0
# ---------------- data ----------------
def load(corr):
    db = sqlite3.connect(os.path.join(corr, 'corr.db'))
    utt = {i: dict(json.loads(j), conv=c, seq=s) for i, c, s, j in db.execute('select id,conversation_id,seq,utterance_json from bench_utterances')}
    lab = {i: (sp, json.loads(j)) for i, sp, st, j in db.execute('select utterance_id,split,status,label_json from bench_labels') if st == 'reviewed'}
    rank = lambda p: sorted(p.items(), key=lambda kv: -kv[1])
    def preds(name):
        out = {}
        for sp in ('dev', 'test'):
            for l in open(os.path.join(corr, 'runs', f'{name}-{sp}', 'predictions.jsonl')):
                d = json.loads(l); out[d['id']] = (rank(d['probabilities']), d.get('durationMs'))
        return out
    sr, past = preds('sr-corr'), preds('past')
    vec = {}
    for h, b in db.execute("select text_hash, vector from bench_embeddings where model='local:e5-small'"):
        vec[h] = np.frombuffer(b, dtype='<f4')
    rr = json.load(open(os.path.join(corr, 'rerank-ruri.json'))); rd = json.load(open(os.path.join(corr, 'readings.json')))
    items = []
    for i, (sp, l) in lab.items():
        if i not in sr or i not in utt: continue
        u = utt[i]; kind = 'variant' if i.startswith('var-') else 'control' if i.startswith('ctl-') else 'real'
        if kind == 'real' and i not in past: continue
        gold = C if l.get('none') else l['gold']
        items.append(dict(id=i, split=sp, kind=kind, text=u['text'], prev=bool(u.get('previousUser')), conv=u['conv'], seq=u['seq'], gold=gold, acc=set(l.get('acceptable') or []), none=bool(l.get('none')),
                          sr=sr[i][0][:8], sr_ms=sr[i][1], past=past[i][0][0][0] if i in past else None, vec=vec[hashlib.sha256(u['text'].encode()).hexdigest()],
                          rr=rr[u['text'] + '\x00' + '|'.join(c for c, _ in sr[i][0])], key=(skey(u['text']), skey(rd.get(u['text'], u['text'])))))
    return items, utt
# variants: source + type from variants.jsonl order (var-i); LLM stand-in = source's past (as correction.ts)
ok = lambda x, t: t is not None and (t == x['gold'] or t in x['acc'])
# ---------------- kNN ----------------
def knn_votes(x, mem, M=10, loo=True):
    if not mem: return []
    # float64 and a stable order, as the package computes them (float32 sums flip near-ties at the 10th neighbour)
    V = np.stack([m['vec'] for m in mem]).astype(np.float64); s = V @ np.asarray(x['vec'], np.float64)
    idx = [j for j in np.argsort(-s, kind='stable') if mem[j]['id'] != x['id'] and (not loo or mem[j].get('corr') or mem[j]['text'] != x['text'])][:M]
    v = collections.defaultdict(float)
    for j in idx: v[mem[j]['gold']] += float(s[j])
    return sorted(v.items(), key=lambda kv: -kv[1])
def tbl_scores(x, mem, tau, loo=True):
    t = collections.defaultdict(float)
    for m in mem:
        if m['id'] == x['id'] or (loo and m['text'] == x['text'] and not m.get('corr')): continue
        s = tscore(x['key'], m['key'])
        if s > t[m['gold']]: t[m['gold']] = s
    return {g: s for g, s in t.items() if s >= tau}
# ---------------- candidate features ----------------
FN = ['sr_p', 'sr_rank', 'in_sr', 'rr', 'base_fused', 'is_conv', 'knn', 'knn_top', 'tbl', 'tbl_hit']
def candidates(x, cfg, EXTRA):
    srd = dict(x['sr']); cs = [c for c, _ in x['sr'] if c == C or c in x['rr']]
    if C not in cs: cs.append(C)
    if cfg['knn_cands']:
        ex = [c for c, _ in x['votes'] if c not in cs][:cfg['N']]
        cs += [c for c in ex if (x['text'], c) in EXTRA]
    if cfg['tbl'] and cfg.get('tbl_cands', True): cs += [c for c in x['tbl'] if c not in cs and (x['text'], c) in EXTRA]
    return cs
def feats(x, cs, cfg, EXTRA):
    srd = dict(x['sr']); order = {c: i for i, (c, _) in enumerate(x['sr'])}
    rrs = {c: (0.0 if c == C else x['rr'].get(c, EXTRA.get((x['text'], c), 0.0))) for c in cs}
    base = [srd.get(c, 0) + (CONV if c == C else W * rrs[c]) for c in cs]; mx = max(base); e = [math.exp(b - mx) for b in base]; z = sum(e)
    vt = dict(x['votes']) if cfg['knn_feat'] else {}; vtop = x['votes'][0][0] if cfg['knn_feat'] and x['votes'] else None
    tb = x['tbl'] if cfg['tbl'] else {}
    return np.array([[srd.get(c, 0), order.get(c, 9) / 9, float(c in srd), rrs[c], e[i] / z, float(c == C), vt.get(c, 0), float(c == vtop), tb.get(c, 0), float(c in tb)] for i, c in enumerate(cs)])
def softmax(v): v = np.asarray(v, float); v = v - v.max(); e = np.exp(v); return e / e.sum()
# ---------------- fusion (LR) ----------------
from sklearn.linear_model import LogisticRegression
def fit_lr(X, rows, Cc):
    Xs = np.vstack([X[r['id']][0] for r in rows]); ys = np.concatenate([[float(ok(r, c)) for c in X[r['id']][1]] for r in rows])
    # StandardScaler is required: features live on different scales (sr_rank/9, raw kNN vote sums). Without it E2 drops 91.7 -> 88.5.
    from sklearn.preprocessing import StandardScaler; from sklearn.pipeline import make_pipeline
    return make_pipeline(StandardScaler(), LogisticRegression(C=Cc, max_iter=2000)).fit(Xs, ys)
def rank_with(model, X, x):
    F, cs = X[x['id']]
    s = model.decision_function(F) if model is not None else np.log(F[:, 4] + 1e-12)
    p = softmax(s); o = np.argsort(-p); return [(cs[i], float(p[i])) for i in o]
def gkfold(rows, k=5, seed=0):
    g = sorted({r['grp'] for r in rows}); random.Random(seed).shuffle(g); fold = {x: i % k for i, x in enumerate(g)}
    return [[j for j, r in enumerate(rows) if fold[r['grp']] == f] for f in range(k)]
# ---------------- gate ----------------
GN = ['p1', 'p2', 'logm', 'ent', 'sr_p1', 'agree_sr', 'rr_top', 'knn_top_vote', 'knn_agree', 'tbl_top', 'tbl_any', 'top_conv', 'log_len', 'prev', 'n_cands']
def gfeat(x, P, X):
    F, cs = X[x['id']]; i = cs.index(P[0][0]); p1, p2 = P[0][1], P[1][1] if len(P) > 1 else 1e-9
    vt = dict(x['votes']); return [p1, p2, math.log(p1 + 1e-12) - math.log(p2 + 1e-12), -sum(p * math.log(p + 1e-12) for _, p in P), x['sr'][0][1], float(x['sr'][0][0] == P[0][0]),
                                  F[i, 3], vt.get(P[0][0], 0), float(bool(x['votes']) and x['votes'][0][0] == P[0][0]), F[i, 8], float(F[:, 9].max() if len(F) else 0), float(P[0][0] == C), math.log(len(x['text']) + 1), float(x['prev']), len(cs)]
def fit_gate(kind, G, y, seed):
    G = np.asarray(G); y = np.asarray(y)
    if kind == 'gbm':
        import lightgbm as lgb
        return lgb.LGBMClassifier(n_estimators=100, num_leaves=4, min_child_samples=10, reg_lambda=10, learning_rate=0.05, subsample=0.8, subsample_freq=1, colsample_bytree=0.8, random_state=seed, verbose=-1).fit(G, y)
    from sklearn.preprocessing import StandardScaler; from sklearn.pipeline import make_pipeline
    return make_pipeline(StandardScaler(), LogisticRegression(C=0.3, max_iter=2000)).fit(G, y)
# ---------------- whole pipeline on (train rows, eval rows) ----------------
def prepare(x, mem, cfg, tau, loo=True):
    # loo=True for training rows (self + same-text duplicates excluded); eval rows see the whole memory (a repeated dev utterance is legitimate memory)
    x['votes'] = knn_votes(x, mem, loo=loo) if (cfg['knn_cands'] or cfg['knn_feat']) else []
    x['tbl'] = tbl_scores(x, mem, tau, loo=loo) if cfg['tbl'] else {}
def run_pipe(train, evals, cfg, EXTRA, tau, seed=0, inner_seed=0, mem=None):
    """train: labelled rows (memory + fit). evals: rows to route (memory = train). Returns dict id -> (ranking, gate score, front)."""
    for x in train: prepare(x, train, cfg, tau)   # leave-one-out inside knn_votes / tbl_scores (self excluded)
    X = {}
    for x in train: cs = candidates(x, cfg, EXTRA); X[x['id']] = (feats(x, cs, cfg, EXTRA), cs)
    folds = gkfold(train, 5, inner_seed)
    # C by 5-fold CV log-likelihood of the gold candidate (item-level softmax)
    bestC, cvP = None, None
    if cfg['lr']:
        res = {}
        for Cc in (0.01, 0.03, 0.1, 0.3, 1.0, 3.0):
            ll = 0; P = {}
            for f in folds:
                fs = set(f); m = fit_lr(X, [r for j, r in enumerate(train) if j not in fs], Cc)
                for j in f:
                    r = train[j]; P[r['id']] = rank_with(m, X, r); ll += -math.log(max([p for c, p in P[r['id']] if ok(r, c)] + [1e-6]))
            res[Cc] = (ll, P)
        bestC = min(res, key=lambda c: res[c][0]); cvP = res[bestC][1]; model = fit_lr(X, train, bestC)
    else:
        model = None; cvP = {r['id']: rank_with(None, X, r) for r in train}
    # gate trained on CV rankings of train
    Gt = [gfeat(r, cvP[r['id']], X) for r in train]; yt = [float(ok(r, cvP[r['id']][0][0])) for r in train]
    if cfg['gate'] == 'margin':
        gscore_tr = [g[2] for g in Gt]; gm = None
    else:
        # CV predictions of the gate on train -> operating point + isotonic
        gscore_tr = [0.0] * len(train)
        for f in folds:
            fs = set(f); m = fit_gate(cfg['gate'], [Gt[j] for j in range(len(train)) if j not in fs], [yt[j] for j in range(len(train)) if j not in fs], seed)
            pr = m.predict_proba(np.asarray([Gt[j] for j in f]))[:, 1]
            for j, p in zip(f, pr): gscore_tr[j] = float(p)
        gm = fit_gate(cfg['gate'], Gt, yt, seed)
    # operating point on train CV: defer fraction q
    th = pick_th(train, cvP, gscore_tr, cfg)
    out = {}
    for x in evals:
        prepare(x, mem or train, cfg, tau, loo=False); cs = candidates(x, cfg, EXTRA); X[x['id']] = (feats(x, cs, cfg, EXTRA), cs)
        P = rank_with(model, X, x); g = gfeat(x, P, X)
        s = g[2] if gm is None else float(gm.predict_proba(np.asarray([g]))[0, 1])
        out[x['id']] = dict(P=P, s=s, defer=s < th)
    return out, dict(C=bestC, th=th, n_train=len(train))
def pick_th(train, cvP, sc, cfg):
    o = sorted(sc)
    if cfg.get('op') == 'q20' or cfg['gate'] == 'margin': return o[max(int(len(o) * 0.2) - 1, 0)] + 1e-9
    # dev-CV operating point: smallest deferral whose cascade Top-1 is within 1pt of the best over q in 0..50%
    best = []
    for q in range(0, 51, 1):
        th = o[max(int(len(o) * q / 100) - 1, 0)] + 1e-9 if q else -1e9
        acc = np.mean([ok(r, r['past']) if s < th else ok(r, cvP[r['id']][0][0]) for r, s in zip(train, sc)])
        best.append((q, acc, th))
    mx = max(a for _, a, _ in best); return next(th for q, a, th in best if a >= mx - 0.01)
# ---------------- LLM step ----------------
def llm_answer(x, P, mode, fy, rnd):
    if mode == 'past': return x['past']
    for c, _ in P[:3]:   # sequential yes/no, max 3; SIMULATED verifier: yes iff correct, flipped with prob fy (wrong->yes)
        if ok(x, c) or rnd.random() < fy: return c
    return x['past']
def evaluate(rows, R, mode='past', fy=0.0, mc=1, seed=0):
    accs = []
    for k in range(mc):
        rnd = random.Random(seed * 1000 + k)
        accs.append([ok(x, llm_answer(x, R[x['id']]['P'], mode, fy, rnd)) if R[x['id']]['defer'] else ok(x, R[x['id']]['P'][0][0]) for x in rows])
    return np.mean(np.array(accs, float), 0)
def curve(rows, R):
    o = sorted(rows, key=lambda x: R[x['id']]['s']); n = len(rows); front = {x['id']: ok(x, R[x['id']]['P'][0][0]) for x in rows}; L = {x['id']: ok(x, x['past']) for x in rows}
    acc = sum(front.values()); cv = [(0.0, 100 * acc / n)]
    for i, x in enumerate(o): acc += L[x['id']] - front[x['id']]; cv.append((100 * (i + 1) / n, 100 * acc / n))
    return cv
at = lambda cv, d: round(min(cv, key=lambda t: abs(t[0] - d))[1], 1)
def d_at(cv, t): xs = [d for d, a in cv if a >= t - 1e-9]; return round(min(xs), 1) if xs else None
def boot(a, b=None, B=4000, seed=1):
    a = np.asarray(a, float); d = a - (np.asarray(b, float) if b is not None else 0); rnd = np.random.default_rng(seed); n = len(d)
    s = np.sort(d[rnd.integers(0, n, (B, n))].mean(1)); return [round(100 * d.mean(), 1), round(100 * s[int(.025 * B)], 1), round(100 * s[int(.975 * B) - 1], 1)]
# ---------------- main ----------------
CFGS = {
    'baseline':   dict(knn_cands=False, knn_feat=False, tbl=False, lr=False, gate='margin', N=3),
    'E2':         dict(knn_cands=False, knn_feat=True, tbl=False, lr=True, gate='margin', N=3),
    'best-v1':    dict(knn_cands=True, knn_feat=True, tbl=True, lr=True, gate='gbm', N=3),
    'best-v1/lrgate': dict(knn_cands=True, knn_feat=True, tbl=True, lr=True, gate='lr', N=3),
    # ablations (remove one stage)
    '-knn_cands': dict(knn_cands=False, knn_feat=True, tbl=True, lr=True, gate='gbm', N=3),
    '-knn_feat':  dict(knn_cands=True, knn_feat=False, tbl=True, lr=True, gate='gbm', N=3),
    '-knn(all)':  dict(knn_cands=False, knn_feat=False, tbl=True, lr=True, gate='gbm', N=3),
    '-lr_fusion': dict(knn_cands=True, knn_feat=True, tbl=True, lr=False, gate='gbm', N=3),
    '-table':     dict(knn_cands=True, knn_feat=True, tbl=False, lr=True, gate='gbm', N=3),
    '-gate(margin)': dict(knn_cands=True, knn_feat=True, tbl=True, lr=True, gate='margin', N=3),
    # build-up
    '+knn_cands': dict(knn_cands=True, knn_feat=False, tbl=False, lr=False, gate='margin', N=3),
    '+lr(knn)':   dict(knn_cands=True, knn_feat=True, tbl=False, lr=True, gate='margin', N=3),
    '+table':     dict(knn_cands=True, knn_feat=True, tbl=True, lr=True, gate='margin', N=3),
}
BUILD = ['baseline', '+knn_cands', '+lr(knn)', '+table', 'best-v1']
def ensure_extra(items, corr, py, N=5):
    """ruri scores for kNN / table extra candidates (memory = all labelled real rows, superset of every fold's memory)."""
    path = os.path.join(corr, 'rerank-ruri-extra.json'); cache = json.load(open(path)) if os.path.exists(path) else {}
    reals = [x for x in items if x['kind'] == 'real']; rows = []
    allt = tune_tau([dict(key=x['key'], gold=x['gold']) for x in reals if x['split'] == 'dev'])
    for x in items:
        v = knn_votes(x, reals, loo=False); t = tbl_scores(x, reals, allt, loo=False)
        ex = sorted({c for c, _ in v[:N] if c != C and c not in x['rr']} | {c for c in t if c != C and c not in x['rr']})
        if ex: rows.append(dict(text=x['text'], cands=ex))
    need = [r for r in rows if r['text'] + '\x00' + '|'.join(r['cands']) not in cache]
    if need:
        inp = os.path.join(corr, 'rerank-extra-in.json'); cards = json.load(open(os.path.join(corr, 'rerank-in.json')))['cards']
        json.dump(dict(cards=cards, rows=need), open(inp, 'w'), ensure_ascii=False)
        t0 = time.time(); subprocess.run([py, os.path.join(HERE, '..', 'correction', 'models.py'), 'rerank', inp, path, 'cl-nagoya/ruri-v3-reranker-310m', 'ruri-extra'], check=True)
        cache = json.load(open(path)); print(f'ruri extra: {len(need)} rows in {time.time() - t0:.0f}s', file=sys.stderr)
    E = {}
    for k, d in cache.items():
        t = k.split('\x00')[0]
        for c, s in d.items(): E[(t, c)] = s
    return E
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--corr', required=True); ap.add_argument('--out', default=None); ap.add_argument('--python', default=sys.executable)
    ap.add_argument('--seeds', type=int, default=3); ap.add_argument('--variants', default=os.path.join(HERE, '..', 'correction', 'variants.jsonl')); ap.add_argument('--skip-robust', action='store_true'); a = ap.parse_args()
    out_dir = a.out or os.path.join(a.corr, 'best-v1'); os.makedirs(out_dir, exist_ok=True)
    T0 = time.time(); items, utt = load(a.corr); print(f'loaded {len(items)} items in {time.time() - T0:.1f}s', file=sys.stderr)
    EXTRA = ensure_extra(items, a.corr, a.python)
    real = [x for x in items if x['kind'] == 'real']; dev = [x for x in real if x['split'] == 'dev']; test = [x for x in real if x['split'] == 'test']
    var = [x for x in items if x['kind'] == 'variant']; ctl = [x for x in items if x['kind'] == 'control']
    vmeta = [json.loads(l) for l in open(a.variants)]
    def src_of(p): return next((x['id'] for x in test if x['id'].startswith(p)), None) or next((x['id'] for x in real if x['id'].startswith(p)), None)
    for x in var: m = vmeta[int(x['id'].split('-')[1])]; x['vtype'] = m['type']; x['src'] = src_of(m['source']); x['past'] = next((r['past'] for r in real if r['id'] == x['src']), None)
    for x in real: x['grp'] = f"{x['conv']}#{x['seq'] // 20}" if x['conv'] == 'main' else x['conv']   # 'main' split into 20-turn blocks
    tau = tune_tau([dict(key=x['key'], gold=x['gold']) for x in dev]); print('tau', tau, file=sys.stderr)
    REP = dict(n=dict(dev=len(dev), test=len(test), variants=len(var), controls=len(ctl)), tau=tau, configs={})
    PER = {}
    def save():
        json.dump(REP, open(os.path.join(out_dir, 'report.json'), 'w'), ensure_ascii=False, indent=1)
    seeds = range(a.seeds)
    for name, cfg in CFGS.items():
        stoch = cfg['gate'] in ('gbm',); res = []
        for sd in (seeds if stoch else [0]):
            t0 = time.time(); R, info = run_pipe(dev, test, cfg, EXTRA, tau, seed=sd); dt = time.time() - t0
            acc = evaluate(test, R); cv = curve(test, R)
            res.append(dict(R=R, acc=acc, cv=cv, info=info, sec=dt))
        accm = np.mean([r['acc'] for r in res], 0); PER[name] = accm
        dfr = np.mean([np.mean([r['R'][x['id']]['defer'] for x in test]) for r in res])
        front = np.mean([np.mean([ok(x, r['R'][x['id']]['P'][0][0]) for x in test]) for r in res])
        nn = [x for x in test if x['none']]
        none_acc = np.mean([np.mean([ok(x, r['R'][x['id']]['P'][0][0]) if not r['R'][x['id']]['defer'] else ok(x, x['past']) for x in nn]) for r in res])
        R10 = np.mean([np.mean([any(ok(x, c) for c, _ in r['R'][x['id']]['P']) for x in test]) for r in res])
        row = dict(top1=round(100 * accm.mean(), 1), top1_sd=round(float(np.std([100 * r['acc'].mean() for r in res])), 1), defer=round(100 * dfr, 1), front=round(100 * front, 1), cand_recall=round(100 * R10, 1), none_acc=round(100 * none_acc, 1), n_none=len(nn),
                   at20=round(np.mean([at(r['cv'], 20) for r in res]), 1), at29_5=round(np.mean([at(r['cv'], 29.5) for r in res]), 1),
                   d_at81_6=[d_at(r['cv'], 81.6) for r in res], d_at90=[d_at(r['cv'], 90) for r in res], C=[r['info']['C'] for r in res][0], th=[round(r['info']['th'], 4) for r in res], fit_sec=round(np.mean([r['sec'] for r in res]), 1))
        if name != 'baseline': row['vs_baseline'] = boot(accm, PER['baseline'])
        if name not in ('baseline', 'E2') and 'E2' in PER: row['vs_E2'] = boot(accm, PER['E2'])
        if name == 'best-v1':
            seq = {}
            for fy in (0, .1, .2, .3):
                sa = np.mean([evaluate(test, r['R'], 'seq', fy, mc=20, seed=i) for i, r in enumerate(res)], 0); seq[f'fy{int(fy * 100)}'] = dict(top1=round(100 * sa.mean(), 1), vs_baseline=boot(sa, PER['baseline']), vs_E2=boot(sa, PER['E2']))
            row['llm_seq_SIMULATED'] = seq
        REP['configs'][name] = row; save(); print(name, json.dumps({k: v for k, v in row.items() if k not in ('llm_seq_SIMULATED',)}, ensure_ascii=False), file=sys.stderr)
    # ---------------- phase B: user corrections -> variants / controls / misfire ----------------
    PB = {}
    for name in ('baseline', '+lr(knn)', 'best-v1', '-table', '-knn(all)'):
        cfg = CFGS[name]; R, _ = run_pipe(dev, test + var + ctl, cfg, EXTRA, tau, seed=0)
        dec = lambda x, R: x['past'] if R[x['id']]['defer'] else R[x['id']]['P'][0][0]
        wrong = [x for x in test if not ok(x, dec(x, R))]; ws = {x['id'] for x in wrong}
        corr_rows = [dict(x, id='c-' + x['id'], corr=True) for x in wrong]   # user correction = labelled copy of the wrong utterance
        # models fitted on dev only (same seed -> same fit); routing memory = dev + corrections
        R2, _ = run_pipe(dev, test + var + ctl, cfg, EXTRA, tau, seed=0, mem=dev + corr_rows)
        vs = [x for x in var if x['src'] in ws]
        rest = [x for x in test if x['id'] not in ws]
        b = lambda xs, RR: [ok(x, dec(x, RR)) for x in xs]
        PB[name] = dict(corrections=len(wrong), variants_n=len(vs), variants_before=round(100 * np.mean(b(vs, R)), 1), variants_after=round(100 * np.mean(b(vs, R2)), 1),
                        variants_fix=round(100 * np.mean([ok(x, dec(x, R2)) for x in vs if not ok(x, dec(x, R))] or [0]), 1),
                        kana_after=f"{sum(ok(x, dec(x, R2)) for x in vs if x['vtype'] == 'kana')}/{sum(x['vtype'] == 'kana' for x in vs)}",
                        misfire_rest=round(100 * np.mean([not ok(x, dec(x, R2)) for x in rest if ok(x, dec(x, R))]), 1),
                        controls_front_changed=sum(R[x['id']]['P'][0][0] != R2[x['id']]['P'][0][0] for x in ctl), controls_acc_before=round(100 * np.mean([ok(x, R[x['id']]['P'][0][0]) for x in ctl]), 1), controls_acc_after=round(100 * np.mean([ok(x, R2[x['id']]['P'][0][0]) for x in ctl]), 1),
                        test_after=round(100 * np.mean(b(test, R2)), 1))
        REP['phaseB'] = PB; save(); print('phaseB', name, PB[name], file=sys.stderr)
    # ---------------- latency (box CPU) ----------------
    lat = dict(sr_ms_p50=float(np.median([x['sr_ms'] for x in test if x['sr_ms'] is not None])))
    t0 = time.perf_counter(); n = 0
    for x in test[:100]: knn_votes(x, dev); n += 1
    lat['knn_ms'] = round(1000 * (time.perf_counter() - t0) / n, 2)
    t0 = time.perf_counter()
    for x in test[:100]: tbl_scores(x, dev, tau)
    lat['table_ms'] = round(1000 * (time.perf_counter() - t0) / 100, 2)
    REP['latency'] = lat; save()
    if not a.skip_robust: robust(real, EXTRA, a.seeds, REP, save)
    print(json.dumps(REP, ensure_ascii=False, indent=1))
def robust(real, EXTRA, nseeds, REP, save):
    """Fresh-data proxy: blocked group 5-fold on dev+test (main split into 20-turn blocks), whole pipeline refit per fold; and forward time-split on 'main'."""
    rob = {}
    for name in ('baseline', 'E2', 'best-v1'):
        cfg = CFGS[name]; accs = []; dfs = []
        for sd in range(nseeds):
            folds = gkfold(real, 5, 100 + sd)
            for f in folds:
                fs = set(f); tr = [r for j, r in enumerate(real) if j not in fs]; ev = [real[j] for j in f]
                tau = tune_tau([dict(key=x['key'], gold=x['gold']) for x in tr]); R, _ = run_pipe(tr, ev, cfg, EXTRA, tau, seed=sd)
                accs.append(100 * evaluate(ev, R).mean()); dfs.append(100 * np.mean([R[x['id']]['defer'] for x in ev]))
        rob[name] = dict(group5fold_top1_mean=round(float(np.mean(accs)), 1), top1_sd_over_folds=round(float(np.std(accs)), 1), min=round(min(accs), 1), max=round(max(accs), 1), defer_mean=round(float(np.mean(dfs)), 1), n_folds=len(accs))
        # forward time split on 'main' (seq order): train = first 50/60/70% of main + all other conversations' rows; eval = the rest of main
        main = sorted([r for r in real if r['conv'] == 'main'], key=lambda r: r['seq']); other = [r for r in real if r['conv'] != 'main']; ts = []
        for q in (.5, .6, .7):
            k = int(len(main) * q); tr, ev = main[:k] + other, main[k:]
            tau = tune_tau([dict(key=x['key'], gold=x['gold']) for x in tr]); R, _ = run_pipe(tr, ev, cfg, EXTRA, tau, seed=0)
            ts.append(dict(train_frac=q, n_eval=len(ev), top1=round(100 * evaluate(ev, R).mean(), 1), defer=round(100 * np.mean([R[x['id']]['defer'] for x in ev]), 1)))
        rob[name]['time_split_main'] = ts
        REP['robust'] = rob; save(); print('robust', name, rob[name], file=sys.stderr)
if __name__ == '__main__': main()
