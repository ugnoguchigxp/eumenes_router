#!/usr/bin/env python3
"""Score the eval inputs (rows.jsonl: id, text, candidate card ids; NO labels) with a model dir -> scores.json for the box eval.
  python score.py runs/k10-real-s0 runs/k10-real-s0/scores.json [--device auto]
  python score.py cl-nagoya/ruri-v3-reranker-310m zs.json        # zero-shot, same machine (latency comparison)"""
import json, time, sys, os, argparse, torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification
p = argparse.ArgumentParser(); p.add_argument('model'); p.add_argument('out'); p.add_argument('--device', default='auto'); p.add_argument('--rows', default=os.path.join(os.path.dirname(__file__), 'data/rows.jsonl'))
a = p.parse_args(); dev = ('cuda' if torch.cuda.is_available() else 'cpu') if a.device == 'auto' else a.device
docs = json.load(open(os.path.join(os.path.dirname(a.rows), 'docs.json'))); rows = [json.loads(l) for l in open(a.rows)]
tok = AutoTokenizer.from_pretrained('cl-nagoya/ruri-v3-reranker-310m'); m = AutoModelForSequenceClassification.from_pretrained(a.model).to(dev).eval(); res = {}; lat = []
with torch.inference_mode():
    for r in rows:
        t = time.perf_counter()
        enc = tok([r['text'][:400]] * len(r['cands']), [docs[c] for c in r['cands']], truncation=True, max_length=512, padding=True, return_tensors='pt').to(dev)
        lg = m(**enc).logits; s = (lg[:, 0] if lg.shape[-1] == 1 else lg[:, -1]).sigmoid().tolist()
        if dev == 'cuda': torch.cuda.synchronize()
        lat.append(1000 * (time.perf_counter() - t)); res[r['id']] = dict(zip(r['cands'], s))
lat.sort(); json.dump(dict(model=a.model, device=dev, rr=res, ms_p50=lat[len(lat) // 2], ms_p95=lat[int(len(lat) * .95)], ms_mean=sum(lat) / len(lat)), open(a.out, 'w'))
print('scored', len(res), 'p50 ms', round(lat[len(lat) // 2], 1))
