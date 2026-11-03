# Adds e5-small vectors of new texts to a bench database's embedding cache, in-process (no server).
#   python e5cache.py <bench.db> <rows.jsonl> [<rows.jsonl> ...]     rows: {"text": ...}
# Same vectors as models.py serve ("passage: " prefix, mean pooling, normalized) under the model key local:e5-small.
import hashlib, json, sqlite3, sys
import numpy as np, torch
from transformers import AutoTokenizer, AutoModel
db = sqlite3.connect(sys.argv[1]); key = 'local:e5-small'
texts = sorted({json.loads(l)['text'] for f in sys.argv[2:] for l in open(f) if l.strip()})
have = {r[0] for r in db.execute('SELECT text_hash FROM bench_embeddings WHERE model=?', (key,))}
todo = [t for t in texts if hashlib.sha256(t.encode()).hexdigest() not in have]
name = 'intfloat/multilingual-e5-small'; tok = AutoTokenizer.from_pretrained(name); mdl = AutoModel.from_pretrained(name).eval()
with torch.inference_mode():
    for i in range(0, len(todo), 32):
        part = todo[i:i + 32]
        enc = tok(['passage: ' + t for t in part], truncation=True, max_length=512, padding=True, return_tensors='pt')
        h = mdl(**enc).last_hidden_state; m = enc['attention_mask'].unsqueeze(-1).float()
        v = torch.nn.functional.normalize((h * m).sum(1) / m.sum(1), dim=-1).numpy().astype('<f4')
        db.executemany('INSERT INTO bench_embeddings(model, text_hash, dimension, vector) VALUES (?,?,?,?)',
                       [(key, hashlib.sha256(t.encode()).hexdigest(), v.shape[1], v[j].tobytes()) for j, t in enumerate(part)])
db.commit(); print(json.dumps(dict(texts=len(texts), added=len(todo))))
