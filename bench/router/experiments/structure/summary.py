# plan §9 (M3b) figures from structure.ts score reports: python summary.py <report.json> [method ...]
import json, sys
r = json.load(open(sys.argv[1])); methods = sys.argv[2:] or list(r)
SINGLE = ['single-ref', 'single-embedded', 'single', 'single-modifier', 'single-same-tool']; MULTI = ['multi-seq', 'multi-par']
def agg(bk, src, kinds, key): return sum(bk.get(f'{src}:{k}', {}).get(key, 0) for k in kinds)
pct = lambda a, b: f'{100 * a / b:5.1f}% ({a}/{b})' if b else '—'
print('| 方式 | 対象 | 送り先と担当が合う | 参照の側に送る | 複数→パイプライン | 単一→パイプライン | 依頼なし→会話 | 壊れた構造 | トークン |')
print('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
for m in methods:
    bk = r[m]['byKind']
    for src in ('pairs', 'real'):
        allk = SINGLE + MULTI + ['none']; n = agg(bk, src, allk, 'n')
        if not n: continue
        print(f"| {m} | {src} | {pct(agg(bk, src, allk, 'right'), n)} | {pct(agg(bk, src, ['single-ref'], 'referenceSide'), agg(bk, src, ['single-ref'], 'n'))} | "
              f"{pct(agg(bk, src, MULTI, 'toPipeline'), agg(bk, src, MULTI, 'n'))} | {pct(agg(bk, src, SINGLE, 'toPipeline'), agg(bk, src, SINGLE, 'n'))} | "
              f"{pct(agg(bk, src, ['none'], 'right'), agg(bk, src, ['none'], 'n'))} | {agg(bk, src, allk, 'fallback')} | {r[m].get('tokens', 0) if src == 'pairs' else ''} |")
