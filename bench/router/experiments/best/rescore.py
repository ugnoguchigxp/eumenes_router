"""Copy a corr dir with its reranker scores taken from a provider's every-card scores (context.py score-all), so
best_v2.py eval/export run unchanged on the copy under the new scores.
  python rescore.py --corr <corr dir> --all <scores.json> --out <new corr dir>
rerank-ruri.json and rerank-ruri-extra.json keys are "<text>\\0<card>|<card>…": each card of a key gets the provider's
score of (text, card). A text the provider did not score (over its limit) keeps the original scores, and is counted.
The binding (<scores.json>.binding.json: model, scenario, network, precision) is written to <out>/swap.json."""
import argparse, json, shutil, sys
from pathlib import Path


def main():
    p = argparse.ArgumentParser(); p.add_argument('--corr', required=True); p.add_argument('--all', required=True); p.add_argument('--out', required=True); a = p.parse_args()
    src, dst = Path(a.corr), Path(a.out)
    if dst.exists(): sys.exit(f'{dst} exists')
    side = Path(a.all + '.binding.json')
    if not side.exists(): sys.exit(f'{a.all} has no binding')
    every = json.load(open(a.all)); counts = {}
    shutil.copytree(src, dst)
    for name in ('rerank-ruri.json', 'rerank-ruri-extra.json'):
        rr = json.load(open(src / name)); swapped = kept = 0
        for k, v in rr.items():
            s = every.get(k.split('\x00')[0])
            if s and all(c in s for c in v): rr[k] = {c: s[c] for c in v}; swapped += 1
            else: kept += 1
        json.dump(rr, open(dst / name, 'w'), ensure_ascii=False); counts[name] = dict(replaced=swapped, kept_original=kept)
    meta = dict(source=str(src), scores=a.all, binding=json.load(open(side)), **counts)
    json.dump(meta, open(dst / 'swap.json', 'w'), ensure_ascii=False, indent=1); print(json.dumps(meta, ensure_ascii=False, indent=1))


if __name__ == '__main__': main()
