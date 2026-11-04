# C: cross-encoder rerank of sr top candidates (box CPU). Usage: python rerank.py <hf-model> <tag>
import json, sys, time, os, psutil, torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification
name, tag = sys.argv[1], sys.argv[2]
d = json.load(open('/tmp/r3/dump.json')); rows, cards = d['rows'], d['cards']; C = 'conversation.respond'
proc = psutil.Process(); rss0 = proc.memory_info().rss
t0 = time.perf_counter()
tok = AutoTokenizer.from_pretrained(name); mdl = AutoModelForSequenceClassification.from_pretrained(name).eval()
load = time.perf_counter() - t0
def doc(cid):
    p = cards.get(cid, {}).get('passages') or [cid]
    return p[0] + ' 例: ' + ' / '.join(p[1:6])
out = []
with torch.inference_mode():
    for r in rows[:3]:  # warmup
        tools = [c for c, _ in r['sr'] if c != C]; mdl(**tok([r['text']] * len(tools), [doc(c) for c in tools], truncation=True, max_length=512, padding=True, return_tensors='pt'))
    for r in rows:
        tools = [c for c, _ in r['sr'] if c != C]
        t = time.perf_counter()
        enc = tok([r['text'][:400]] * len(tools), [doc(c) for c in tools], truncation=True, max_length=512, padding=True, return_tensors='pt')
        lg = mdl(**enc).logits
        s = (lg[:, 0] if lg.shape[-1] == 1 else lg[:, -1]).sigmoid().tolist()
        out.append(dict(id=r['id'], rr=dict(zip(tools, s)), ms=(time.perf_counter() - t) * 1000, n=len(tools)))
rss = proc.memory_info().rss
json.dump(dict(model=name, loadSec=load, rssMB=rss / 2**20, rssDeltaMB=(rss - rss0) / 2**20, threads=torch.get_num_threads(), out=out), open(f'/tmp/r3/rr-{tag}.json', 'w'))
ms = sorted(o['ms'] for o in out); print(tag, 'load', round(load, 2), 'rssMB', round(rss / 2**20), 'p50', round(ms[len(ms)//2], 1), 'p95', round(ms[int(len(ms)*.95)], 1))
