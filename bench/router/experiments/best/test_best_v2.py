"""Regression tests for best_v2.py (2026-11-03).
  python test_best_v2.py   (needs numpy + scikit-learn; the data test runs only when BEST_V2_CORR / /tmp/corr/e4 exists)"""
import os, sys, json, tempfile, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import best_v1 as B, best_v2 as V
CORR = os.environ.get('BEST_V2_CORR', '/tmp/corr/e4')

def test_numpy_ranker_matches_sklearn():
    rng = np.random.default_rng(0); X = rng.normal(0, [1, 50, 0.01] * 4, (300, 12)); y = (X[:, 0] + 100 * X[:, 2] > 0).astype(float)
    sk = V.fit_sk(X, y, 0.1); np.testing.assert_allclose(V.Ranker.from_sk(sk).proba(X), sk.predict_proba(X)[:, 1], rtol=1e-6)

def test_gate_is_p1_minus_p2():
    r = V.Ranker(np.zeros(12), np.ones(12), np.eye(12)[0] * 3, 0.0); F = np.zeros((3, 12)); F[:, 0] = [2, 1, -1]
    P, g = V.route(['a', 'b', 'c'], F, r); assert [c for c, _ in P] == ['a', 'b', 'c']; assert abs(g - (V.sig(6) - V.sig(3))) < 1e-9

def test_e2_dev_only_number():
    """algo4 E2 ported into the harness, every choice dev-only: 92.2 / defer 25.8 on test 217 (91.2 with algo4's random CV folds)."""
    if not os.path.exists(os.path.join(CORR, 'corr.db')): print('skip: no corr data'); return
    items, _ = V.load(CORR); E = B.ensure_extra(items, CORR, sys.executable); real, _, _ = V.setup(items, os.path.join(V.HERE, '..', 'correction', 'variants.jsonl'))
    dev = [x for x in real if x['split'] == 'dev']; test = [x for x in real if x['split'] == 'test']; tau = B.tune_tau([dict(key=x['key'], gold=x['gold']) for x in dev])
    assert (len(dev), len(test)) == (177, 217), (len(dev), len(test))
    cfg = V.CFGS['best-v2']; f = V.fit(dev, cfg, tau, E); R = V.apply(f, test, dev, cfg, tau, E)
    top1 = 100 * B.evaluate(test, R).mean(); dfr = 100 * np.mean([R[x['id']]['defer'] for x in test])
    assert 91.2 - 1e-6 <= round(top1, 1) <= 92.2 + 1e-6, top1; assert 18 <= dfr <= 30, dfr; assert f['C'] in V.CGRID
    # artifact round trip: export -> Predictor (no retraining, rr/vec supplied) gives the same decisions
    with tempfile.TemporaryDirectory() as d:
        class A: pass
        a = A(); a.corr = CORR; a.variants = os.path.join(V.HERE, '..', 'correction', 'variants.jsonl'); a.python = sys.executable; a.artifact = d; a.cfg = 'best-v2'
        V.cmd_export(a); p = V.Predictor(d)
        for x in test[:40]:
            o = p.predict(dict(id=x['id'], text=x['text'], sr=x['sr'], sr_scores=x['sr_scores'], vec=x['vec'].tolist(), rr=x['rr']))
            assert o['tool'] == R[x['id']]['P'][0][0] and o['defer'] == R[x['id']]['defer'], (x['id'], o, R[x['id']])

if __name__ == '__main__':
    for n, f in list(globals().items()):
        if n.startswith('test_'): f(); print('ok', n)
