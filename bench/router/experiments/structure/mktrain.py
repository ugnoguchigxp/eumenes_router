"""S2 of plan §8: ruri training pairs for "the request, not the reference" ({q, doc, label}, the fine-tune kit's format).
  python mktrain.py <train.src.txt> <items.jsonl> <bench.db> <rerank-in.json> <out dir>
Source lines: `family gold reference-tool text` (the file's own header). Per sentence: (text, gold card) 1; (text, the
reference's card) 0 when there is one; (text, conversation card) 0 for a request, 1 for a comment; two other cards 0
(seeded). Card documents are built as the kit's (passages[0] + ' 例: ' + passages[1:6]). A sentence equal to an
evaluation item, or with an e5 cosine >= 0.97 to one, is left out (the evaluation set must not be learned).
The e5 vectors of the evaluation items come from the bench database's cache; the training sentences are embedded here."""
import hashlib, json, os, random, sqlite3, sys, collections
import numpy as np, torch
from transformers import AutoTokenizer, AutoModel

C = 'conversation.respond'
MAKE = ['image.create', 'music.create', 'model3d.studio', 'ui.compose', 'excalidraw.edit']
NEAR = 0.97


def main(src, items_path, db_path, rerank_in, out):
    cards = json.load(open(rerank_in))['cards']
    doc = lambda c: (lambda p: p[0] + ' 例: ' + ' / '.join(p[1:6]))(cards.get(c, {}).get('passages') or [c])
    rows = []
    for line in open(src):
        if not line.strip() or line.startswith('#'): continue
        fam, gold, ref, text = line.rstrip('\n').split(' ', 3)
        for t in (gold, ref):
            if t != '-' and t not in cards: sys.exit(f'unknown tool {t}')
        rows.append(dict(family=fam, gold=gold, ref=None if ref == '-' else ref, text=text))
    items = [json.loads(l) for l in open(items_path)]
    db = sqlite3.connect(db_path); key = 'local:e5-small'
    store = {r[0]: r[1] for r in db.execute('SELECT text_hash, vector FROM bench_embeddings WHERE model=?', (key,))}
    ev = np.stack([np.frombuffer(store[hashlib.sha256(i['text'].encode()).hexdigest()], '<f4') for i in items])
    name = 'intfloat/multilingual-e5-small'; tok = AutoTokenizer.from_pretrained(name); mdl = AutoModel.from_pretrained(name).eval()
    with torch.inference_mode():
        enc = tok(['passage: ' + r['text'] for r in rows], truncation=True, max_length=512, padding=True, return_tensors='pt')
        h = mdl(**enc).last_hidden_state; m = enc['attention_mask'].unsqueeze(-1).float()
        tv = torch.nn.functional.normalize((h * m).sum(1) / m.sum(1), dim=-1).numpy()
    nearest = (tv @ ev.T).max(1); texts = {i['text'] for i in items}
    keep = [r for r, s in zip(rows, nearest) if r['text'] not in texts and s < NEAR]
    stats = lambda xs: dict(min=round(float(min(xs)), 4), median=round(float(np.median(xs)), 4), max=round(float(max(xs)), 4))
    rnd = random.Random(0); pairs = []
    for r in keep:
        q = r['text'][:400]
        if r['gold'] == C: pairs.append(dict(q=q, doc=doc(C), label=1))
        else: pairs += [dict(q=q, doc=doc(r['gold']), label=1), dict(q=q, doc=doc(C), label=0)]
        if r['ref']: pairs.append(dict(q=q, doc=doc(r['ref']), label=0))
        others = [t for t in MAKE if t not in (r['gold'], r['ref'])]
        pairs += [dict(q=q, doc=doc(t), label=0) for t in rnd.sample(others, 2)]
    os.makedirs(f'{out}/pairs', exist_ok=True); os.makedirs(f'{out}/data', exist_ok=True)
    with open(f'{out}/pairs/structure-v1.jsonl', 'w') as f:
        for p in pairs: f.write(json.dumps(p, ensure_ascii=False) + '\n')
    used = sorted({C, *MAKE, *(r['gold'] for r in keep)})
    json.dump({c: doc(c) for c in used}, open(f'{out}/data/docs.json', 'w'), ensure_ascii=False, indent=1)
    manifest = dict(file='pairs/structure-v1.jsonl', sentences=len(keep), left_out=len(rows) - len(keep), pairs=len(pairs),
                    positives=sum(p['label'] for p in pairs), per_gold=dict(collections.Counter(r['gold'] for r in keep)),
                    per_family=dict(collections.Counter(r['family'] for r in keep)),
                    nearest_eval_cosine_kept=stats([s for r, s in zip(rows, nearest) if r in keep]),
                    nearest_eval_cosine_all_written=stats(list(nearest)),
                    rule=f'left out: equal to an evaluation item, or e5 cosine >= {NEAR} to one')
    json.dump(manifest, open(f'{out}/manifest.json', 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == '__main__': main(*sys.argv[1:6])
