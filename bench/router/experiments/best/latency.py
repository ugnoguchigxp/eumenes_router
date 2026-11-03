# Box-CPU latency of e5 embed (1 query) and ruri rerank (sr top-8 tools) on 20 real rows.
#   python latency.py <corr-dir>
import json, sys, time, statistics as st, torch
from transformers import AutoTokenizer, AutoModel, AutoModelForSequenceClassification
d = json.load(open(sys.argv[1] + '/rerank-in.json')); rows = d['rows'][:20]; cards = d['cards']; C = 'conversation.respond'
torch.set_num_threads(max(1, torch.get_num_threads()))
def doc(c):
    p = cards.get(c, {}).get('passages') or [c]; return p[0] + ' 例: ' + ' / '.join(p[1:6])
def p50(f):
    f(rows[0]); t = []
    for r in rows:
        a = time.perf_counter(); f(r); t.append((time.perf_counter() - a) * 1000)
    return round(st.median(t), 1), round(max(t), 1)
out = {'threads': torch.get_num_threads()}
with torch.inference_mode():
    n = 'intfloat/multilingual-e5-small'; tk = AutoTokenizer.from_pretrained(n); m = AutoModel.from_pretrained(n).eval()
    out['e5_embed_ms_p50_max'] = p50(lambda r: m(**tk(['passage: ' + r['text']], return_tensors='pt', truncation=True)))
    n = 'cl-nagoya/ruri-v3-reranker-310m'; tk = AutoTokenizer.from_pretrained(n); m = AutoModelForSequenceClassification.from_pretrained(n).eval()
    def rr(r):
        tools = [c for c in r['cands'] if c != C]
        m(**tk([r['text'][:400]] * len(tools), [doc(c) for c in tools], truncation=True, max_length=512, padding=True, return_tensors='pt'))
    out['ruri_rerank_ms_p50_max'] = p50(rr)
print(json.dumps(out))
