#!/usr/bin/env python3
"""E3 prep: e5-small embeddings of every dump row and kNN candidate tools from DEV-only memory (leave-one-out for dev rows).
  python knn.py embed /tmp/a4/emb.json
  python knn.py cands /tmp/a4/emb.json /tmp/a4/knn.json [M=10]     -> per row: ranked kNN tools (gold labels of nearest dev rows)
  python knn.py rerank-in /tmp/a4/knn.json /tmp/a4/rr-in.json [N=3] -> rows needing rerank for kNN tools not already in sr top-8"""
import json, sys, os, collections
D = json.load(open(os.environ.get('DUMP', '/tmp/r3/dump.json'))); ROWS = D['rows']; C = 'conversation.respond'
cmd = sys.argv[1]
if cmd == 'embed':
    import torch
    from transformers import AutoTokenizer, AutoModel
    name = 'intfloat/multilingual-e5-small'; tok = AutoTokenizer.from_pretrained(name); mdl = AutoModel.from_pretrained(name).eval(); out = {}
    with torch.inference_mode():
        for i in range(0, len(ROWS), 32):
            b = ROWS[i:i + 32]; enc = tok(['passage: ' + r['text'] for r in b], truncation=True, max_length=512, padding=True, return_tensors='pt')
            h = mdl(**enc).last_hidden_state; m = enc['attention_mask'].unsqueeze(-1).float(); v = torch.nn.functional.normalize((h * m).sum(1) / m.sum(1), dim=-1)
            for r, x in zip(b, v.tolist()): out[r['id']] = x
    json.dump(out, open(sys.argv[2], 'w'))
elif cmd == 'cands':
    E = json.load(open(sys.argv[2])); M = int(sys.argv[4]) if len(sys.argv) > 4 else 10
    mem = [r for r in ROWS if r['split'] == 'dev']; out = {}
    for r in ROWS:
        q = E[r['id']]; sims = sorted(((sum(a * b for a, b in zip(q, E[m['id']])), m['gold']) for m in mem if m['id'] != r['id']), reverse=True)[:M]
        vote = collections.defaultdict(float)
        for s, g in sims: vote[g] += s
        out[r['id']] = sorted(vote.items(), key=lambda kv: -kv[1])
    json.dump(out, open(sys.argv[3], 'w'))
elif cmd == 'rerank-in':
    K = json.load(open(sys.argv[2])); N = int(sys.argv[4]) if len(sys.argv) > 4 else 3; rows = []
    for r in ROWS:
        extra = [c for c, _ in K[r['id']] if c != C and c not in dict(r['sr'])][:N]
        if extra: rows.append(dict(id=r['id'], text=r['text'], cands=extra))
    json.dump(dict(rows=rows, cards=D['cards']), open(sys.argv[3], 'w'), ensure_ascii=False); print(len(rows), 'rows')
