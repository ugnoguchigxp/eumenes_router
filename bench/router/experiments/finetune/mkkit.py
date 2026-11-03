#!/usr/bin/env python3
"""Build the portable fine-tune kit (no weights, no test labels): python mkkit.py <out-dir>
pairs/ from split=dev only; data/rows.jsonl = eval inputs (dev+test text and sr candidates, labels stripped)."""
import json, os, sys, shutil
sys.argv, out = sys.argv[:1], sys.argv[1]
exec(open(os.path.join(os.path.dirname(__file__), 'finetune.py')).read().split("if __name__ == '__main__':")[0])
here = os.path.dirname(os.path.abspath(__file__)); os.makedirs(out + '/pairs', exist_ok=True); os.makedirs(out + '/data', exist_ok=True)
test_ids = {r['id'] for r in ROWS if r['split'] == 'test'}; counts = {}
for k in (3, 5, 10):
    for s in (0, 1, 2):
        for arm in ('real', 'cardx', 'convpos'):
            if arm == 'cardx' and k != 10: continue
            tr = pick_train(k, s); assert not (set(r['id'] for r in tr) & test_ids)
            P = pairs_of(tr, arm, s); name = f'k{k}-{arm}-s{s}'
            with open(f'{out}/pairs/{name}.jsonl', 'w') as f:
                for q, d, y in P: f.write(json.dumps(dict(q=q, doc=d, label=int(y)), ensure_ascii=False) + '\n')
            counts[name] = dict(pairs=len(P), per_tool=dict(collections.Counter(r['gold'] for r in tr)), train_ids=[r['id'] for r in tr])
json.dump(counts, open(f'{out}/pairs/manifest.json', 'w'), ensure_ascii=False, indent=1)
with open(f'{out}/data/rows.jsonl', 'w') as f:
    for r in ROWS: f.write(json.dumps(dict(id=r['id'], text=r['text'], cands=[c for c, _ in r['sr'] if c != C]), ensure_ascii=False) + '\n')
json.dump({c: doc(c) for c in CARDS}, open(f'{out}/data/docs.json', 'w'), ensure_ascii=False)
for f in ('train.py', 'score.py', 'requirements.txt', 'README.md', 'run_all.sh'): shutil.copy(os.path.join(here, 'kit', f), out)
