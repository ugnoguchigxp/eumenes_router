"""Synthetic numerical and fold-isolation regressions. No evaluation data, model runtime or network.
Historical scores remain in the reports; changed CV requires new dev selection before new accuracy claims."""
import os, sys, json, tempfile, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import best_v1 as B, best_v2 as V

def test_numpy_ranker_matches_sklearn():
    rng = np.random.default_rng(0); X = rng.normal(0, [1, 50, 0.01] * 4, (300, 12)); y = (X[:, 0] + 100 * X[:, 2] > 0).astype(float)
    sk = V.fit_sk(X, y, 0.1); np.testing.assert_allclose(V.Ranker.from_sk(sk).proba(X), sk.predict_proba(X)[:, 1], rtol=1e-6)

def test_gate_is_p1_minus_p2():
    r = V.Ranker(np.zeros(12), np.ones(12), np.eye(12)[0] * 3, 0.0); F = np.zeros((3, 12)); F[:, 0] = [2, 1, -1]
    P, g = V.route(['a', 'b', 'c'], F, r); assert [c for c, _ in P] == ['a', 'b', 'c']; assert abs(g - (V.sig(6) - V.sig(3))) < 1e-9

def rows():
    return [dict(id=f'q{i}', grp=f'g{i // 2}', text=f'query-{i}', key=(f'key-{i}', f'key-{i}'),
                 vec=np.array([1., i / 20], dtype='<f4'), gold='a' if i % 2 else 'b', acc=set(),
                 sr=[('a', .6), ('b', .3), (B.C, .1)], sr_scores={'a': 1., 'b': .8, B.C: .7},
                 rr={'a': .8 if i % 2 else .2, 'b': .2 if i % 2 else .8}) for i in range(20)]

def test_fold_memory_does_not_see_validation_gold():
    import copy
    data = rows(); train, valid = data[:16], data[16:]
    for cfg in (V.CFGS['best-v2'], V.CFGS['best-v2+tbl']):
        left = V.fold_features(train, valid, cfg, .5, {})
        changed = copy.deepcopy(valid)
        for x in changed: x['gold'] = 'other'
        right = V.fold_features(train, changed, cfg, .5, {})
        for a, b in zip(left, right):
            for key in a:
                assert a[key][0] == b[key][0]
                np.testing.assert_array_equal(a[key][1], b[key][1])
    # A negative control: the old full-memory features do change with a held-out label.
    altered = copy.deepcopy(data); altered[-1]['gold'] = 'other'
    old = V.featurize(data[-2], data, V.CFGS['best-v2'], .5, {}, loo=True)[1]
    leaked = V.featurize(altered[-2], altered, V.CFGS['best-v2'], .5, {}, loo=True)[1]
    assert not np.array_equal(old, leaked)

def test_fit_uses_only_training_side_memory():
    data = rows(); original = V.featurize; calls = []
    def watch(x, mem, cfg, tau, extra, loo):
        calls.append((x['id'], {m['id'] for m in mem}, loo))
        return original(x, mem, cfg, tau, extra, loo)
    V.featurize = watch
    try: fitted = V.fit(data, V.CFGS['best-v2'], .5, {}, Cfix=.03)
    finally: V.featurize = original
    # fold training calls: 5 * 16, fold validation: 20, final training: 20.
    assert len(calls) == 120, len(calls)
    for q, mem, loo in calls[:100]:
        if not loo:
            assert q not in mem
            own = next(x['grp'] for x in data if x['id'] == q)
            assert all(x['grp'] != own for x in data if x['id'] in mem)
        else: assert len(mem) == 16
    assert all(len(mem) == 20 and loo for _, mem, loo in calls[100:])
    assert fitted['C'] == .03 and np.isfinite(fitted['th'])

def test_grouped_fit_and_artifact_round_trip():
    data = rows(); cfg = V.CFGS['best-v2']; f = V.fit(data, cfg, .5, {}, Cfix=.03)
    result = V.apply(f, data, data, cfg, .5, {})
    with tempfile.TemporaryDirectory() as d:
        meta = dict(version=V.VERSION, flags=cfg, ranker=f['model'].to_json(), gate=dict(defer_below=f['th']),
                    ruri=dict(model='unused'), knn=dict(model='unused'), table=dict(tau=.5))
        memory = [dict(id=x['id'], gold=x['gold'], text=x['text'], key=x['key']) for x in data]
        with open(os.path.join(d, 'model.json'), 'w') as file: json.dump(dict(meta=meta, memory=memory, cards={}), file)
        np.savez_compressed(os.path.join(d, 'memory.npz'), vec=np.stack([x['vec'] for x in data]))
        p = V.Predictor(d)
        # Any attempt to load a model is an error in this offline test.
        p.ruri = p.e5 = lambda *a: (_ for _ in ()).throw(AssertionError('model call'))
        for x in data:
            got = p.predict(dict(id=x['id'], text=x['text'], sr=x['sr'], sr_scores=x['sr_scores'], vec=x['vec'].tolist(), rr=x['rr']))
            want = result[x['id']]
            assert got['tool'] == want['P'][0][0] and got['defer'] == want['defer']
            assert [c for c, _ in got['scores']] == [c for c, _ in want['P']]
    try: V.fit(data[:1], cfg, .5, {})
    except ValueError: pass
    else: raise AssertionError('one group must be refused')

if __name__ == '__main__':
    for n, f in list(globals().items()):
        if n.startswith('test_'): f(); print('ok', n)
