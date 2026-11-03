"""Regression tests for best_v1.py (E2 reproducibility, 2026-11-03).
  python test_best_v1.py   (needs numpy + scikit-learn)"""
import os, sys, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import best_v1 as B

def test_fit_lr_standardizes():
    # features on very different scales: an unscaled L2-LR under-uses the small-scale informative one
    rng = np.random.default_rng(0); rows = []; X = {}
    for i in range(200):
        cs = ['a', 'b']; good = i % 2; F = np.zeros((2, 10))
        F[:, 1] = rng.normal(0, 100, 2)            # large-scale noise
        F[good, 6] = 0.01                          # tiny-scale but perfectly informative
        rows.append(dict(id=str(i), gold=cs[good], acc=set())); X[str(i)] = (F, cs)
    m = B.fit_lr(X, rows, 0.1)
    assert any(type(s).__name__ == 'StandardScaler' for s in getattr(m, 'named_steps', {}).values()), 'fit_lr must standardize features'
    acc = np.mean([B.rank_with(m, X, r)[0][0] == r['gold'] for r in rows]); assert acc > 0.95, acc

def test_knn_eval_sees_same_text_memory():
    v = lambda *a: np.array(a, dtype='<f4')
    mem = [dict(id='d1', text='音楽かけて', gold='music.play', vec=v(1, 0)), dict(id='d2', text='他', gold='x', vec=v(0, 1))]
    q = dict(id='t1', text='音楽かけて', vec=v(1, 0))
    assert B.knn_votes(q, mem, loo=False)[0][0] == 'music.play'   # eval: a repeated dev utterance is legitimate memory
    assert B.knn_votes(q, mem, loo=True)[0][0] == 'x'             # train LOO: same-text rows excluded

if __name__ == '__main__':
    for n, f in list(globals().items()):
        if n.startswith('test_'): f(); print('ok', n)
