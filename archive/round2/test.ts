import { go, hits, agg, boot } from "./exp.ts";
const DB = "/workspace/eumenes_router/data/bench-r2.db";
const dup = new Set<string>(require("/tmp/r2/dupids.json"));
const cfg: Record<string, any> = {
  fts: null, embed: null, hybrid: null, past: null,
  "sr-r1-nohist": { weights: { hist: 0 }, minCombined: 0.55, context: 0 },
  "sr-cal": { weights: { sem: 1, lex: 1, proto: 1, name: 0, hist: 0, prior: 1 }, minCombined: 0.7, context: 0 },
  "hyb-proto-none": { weights: { sem: 0, lex: 0.5, proto: 1, name: 0, hist: 0, prior: 0 }, minCombined: 0.7, context: 0 },
  "sr-cal+prev": { weights: { sem: 1, lex: 1, proto: 1, name: 0, hist: 0, prior: 1, prev: 0.25 }, prevGate: "contextual", minCombined: 0.7, context: 0 },
};
const H: Record<string, any> = {}; const rows: any[] = [];
for (const [n, c] of Object.entries(cfg)) {
  const r = go(DB, n, "test", c ?? undefined, { tag: n });
  const h = hits(DB, r.preds, "test"); H[n] = h;
  const a = agg(h); const nd = agg(h, new Set(Object.keys(h).filter((id) => !dup.has(id))));
  const lat = Object.values(r.preds).map((p: any) => p.durationMs).sort((x: number, y: number) => x - y);
  rows.push({ n, N: a.n, top1: a.top1, ctx: a.ctx, nCtx: a.nCtx, none: a.none, nNone: a.nNone, dedupTop1: nd.top1, nDedup: nd.n, r4: r.s.recallAt4, dec: r.s.decisionAccuracy, p95: lat[Math.floor(lat.length * 0.95)] });
}
console.table(rows.map((r) => ({ ...r, top1: (r.top1*100).toFixed(1), ctx: (r.ctx*100).toFixed(1), none: (r.none*100).toFixed(1), dedupTop1: (r.dedupTop1*100).toFixed(1), r4: (r.r4*100).toFixed(1), dec: (r.dec*100).toFixed(1) })));
const base = ["fts","embed","hybrid","past","sr-r1-nohist"].sort((a, b) => agg(H[b]).top1 - agg(H[a]).top1)[0]!;
console.log("best existing baseline:", base);
for (const n of ["sr-cal", "hyb-proto-none", "sr-cal+prev", "sr-r1-nohist", "past", "fts"]) {
  const all = boot(H[n], H[base]); const c = boot(H[n], H[base], (x) => x.ctx);
  console.log(n, "vs", base, "all", JSON.stringify(all), "ctx", JSON.stringify(c));
}
await Bun.write("/tmp/r2/test-hits.json", JSON.stringify(H));
