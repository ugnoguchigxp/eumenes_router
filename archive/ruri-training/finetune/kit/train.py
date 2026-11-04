#!/usr/bin/env python3
"""Fine-tune cl-nagoya/ruri-v3-reranker-310m on a pairs JSONL ({"q","doc","label"}). Same recipe as the box run:
top-6 layers + final_norm + head trainable, AdamW lr 2e-5, wd 0.01, bs 16, 2 epochs, 10% warmup + linear decay, BCE, max_len 256.
  python train.py --pairs pairs/k10-real-s0.jsonl --seed 0 --out runs/k10-real-s0 [--device auto|cuda|cpu] [--full]
On ROCm PyTorch the GPU shows up as "cuda". Writes the model dir plus meta.json (time, loss)."""
import json, time, random, argparse, os, torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification
BASE = 'cl-nagoya/ruri-v3-reranker-310m'
p = argparse.ArgumentParser(); p.add_argument('--pairs', required=True); p.add_argument('--seed', type=int, default=0); p.add_argument('--out', required=True)
p.add_argument('--device', default='auto'); p.add_argument('--layers', type=int, default=6); p.add_argument('--epochs', type=int, default=2)
p.add_argument('--lr', type=float, default=2e-5); p.add_argument('--bs', type=int, default=16); p.add_argument('--full', action='store_true', help='train all layers (GPU)')
a = p.parse_args()
dev = ('cuda' if torch.cuda.is_available() else 'cpu') if a.device == 'auto' else a.device
torch.manual_seed(a.seed); random.seed(a.seed)
P = [json.loads(l) for l in open(a.pairs)]; P = [(x['q'], x['doc'], float(x['label'])) for x in P]
tok = AutoTokenizer.from_pretrained(BASE); m = AutoModelForSequenceClassification.from_pretrained(BASE).to(dev)
if not a.full:
    for q in m.parameters(): q.requires_grad = False
    mods = [mod for n, mod in m.named_modules() if n.count('.') == 2 and '.layers.' in n][-a.layers:] + [mod for n, mod in m.named_children() if n != m.base_model_prefix] + [m.model.final_norm]
    for mod in mods:
        for q in mod.parameters(): q.requires_grad = True
params = [q for q in m.parameters() if q.requires_grad]
opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.01); lossf = torch.nn.BCEWithLogitsLoss()
steps = a.epochs * ((len(P) + a.bs - 1) // a.bs); sch = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / max(1, steps // 10)) * max(0.0, 1 - s / steps))
t0 = time.time(); m.train(); rnd = random.Random(a.seed); hist = []
for ep in range(a.epochs):
    rnd.shuffle(P); tot = 0
    for i in range(0, len(P), a.bs):
        b = P[i:i + a.bs]; enc = tok([x[0] for x in b], [x[1] for x in b], truncation=True, max_length=256, padding=True, return_tensors='pt').to(dev)
        loss = lossf(m(**enc).logits[:, 0], torch.tensor([x[2] for x in b], device=dev)); loss.backward(); opt.step(); sch.step(); opt.zero_grad(); tot += loss.item() * len(b)
    hist.append(round(tot / len(P), 4)); print('epoch', ep, hist[-1], round(time.time() - t0), 's', flush=True)
m.eval(); m.save_pretrained(a.out); tok.save_pretrained(a.out)
json.dump(dict(pairs=a.pairs, seed=a.seed, device=dev, full=a.full, layers=a.layers, epochs=a.epochs, lr=a.lr, train_seconds=round(time.time() - t0, 1), loss=hist,
               torch=torch.__version__, trainable_params=sum(q.numel() for q in params)), open(os.path.join(a.out, 'meta.json'), 'w'), indent=1)
