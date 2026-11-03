# Local models for the correction experiment (CPU, no API keys).
#   python models.py serve [port]            OpenAI-style /v1/embeddings with intfloat/multilingual-e5-small ("passage: " prefix, as in round 2/3)
#   python models.py rerank <in.json> <out.json> <hf-model> <tag>   cross-encoder scores for rows {id,text,cands}
# Card documents are built exactly as round3/rerank.py does.
import json, sys
def serve(port):
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import torch
    from transformers import AutoTokenizer, AutoModel
    name = 'intfloat/multilingual-e5-small'; tok = AutoTokenizer.from_pretrained(name); mdl = AutoModel.from_pretrained(name).eval()
    def emb(texts):
        out = []
        with torch.inference_mode():
            for i in range(0, len(texts), 32):
                enc = tok(['passage: ' + t for t in texts[i:i + 32]], truncation=True, max_length=512, padding=True, return_tensors='pt')
                h = mdl(**enc).last_hidden_state; m = enc['attention_mask'].unsqueeze(-1).float()
                v = torch.nn.functional.normalize((h * m).sum(1) / m.sum(1), dim=-1); out += v.tolist()
        return out
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            inp = body['input']; inp = [inp] if isinstance(inp, str) else inp
            data = json.dumps({'data': [{'index': i, 'embedding': v} for i, v in enumerate(emb(inp))]}).encode()
            self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(data)
        def log_message(self, *a): pass
    srv = HTTPServer(('127.0.0.1', port), H); print('ready', flush=True); srv.serve_forever()  # ready only once the port is bound
def rerank(inp, outp, name, tag):
    import time, torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    d = json.load(open(inp)); cards = d['cards']; C = 'conversation.respond'
    tok = AutoTokenizer.from_pretrained(name); mdl = AutoModelForSequenceClassification.from_pretrained(name).eval()
    def doc(cid):
        p = cards.get(cid, {}).get('passages') or [cid]
        return p[0] + ' 例: ' + ' / '.join(p[1:6])
    res = {}
    try: res = json.load(open(outp))
    except Exception: pass
    with torch.inference_mode():
        for r in d['rows']:
            key = r['text'] + '\x00' + '|'.join(r['cands'])
            if key in res: continue
            tools = [c for c in r['cands'] if c != C]
            t = time.perf_counter()
            enc = tok([r['text'][:400]] * len(tools), [doc(c) for c in tools], truncation=True, max_length=512, padding=True, return_tensors='pt')
            lg = mdl(**enc).logits; s = (lg[:, 0] if lg.shape[-1] == 1 else lg[:, -1]).sigmoid().tolist()
            res[key] = dict(zip(tools, s))
    json.dump(res, open(outp, 'w'), ensure_ascii=False); print(tag, 'scored', len(res))
if __name__ == '__main__':
    if sys.argv[1] == 'serve': serve(int(sys.argv[2]) if len(sys.argv) > 2 else 8765)
    else: rerank(*sys.argv[2:6])
