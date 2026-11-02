import { go, hits, agg } from "./exp.ts";
import { rmSync } from "node:fs";
const DB = "/workspace/eumenes_router/data/bench-r2.db";
const mins = [0.3,0.35,0.4,0.45,0.5,0.55,0.6,0.65,0.7,0.75];
function evalCfg(sr: any) { const r = go(DB, "x", "dev", sr); const a = agg(hits(DB, r.preds, "dev")); rmSync(r.out, { recursive: true }); return a; }
const results: any[] = [];
const mode = process.argv[2];
if (mode === "sr") {
  for (let m = 0; m < 64; m++) { const b = (i: number) => (m >> i) & 1;
    const weights = { sem: b(0), lex: b(1), proto: b(2), name: b(3), hist: b(4), prior: b(5) };
    if (!weights.sem && !weights.lex && !weights.proto && !weights.name) continue;
    for (const minCombined of mins) for (const context of [0, 0.5]) { const a = evalCfg({ weights, minCombined, context }); results.push({ weights, minCombined, context, ...a }); } }
} else if (mode === "hyb") {
  const ws = [0, 0.5, 1, 2];
  for (const sem of ws) for (const lex of ws) for (const proto of ws) { if (!sem && !lex && !proto) continue;
    for (const minCombined of mins) { const weights = { sem, lex, proto, name: 0, hist: 0, prior: 0 }; const a = evalCfg({ weights, minCombined, context: 0 }); results.push({ weights, minCombined, context: 0, ...a }); } }
} else if (mode === "prev") {
  const base = JSON.parse(process.argv[3]!);
  for (const prev of [0, 0.25, 0.5, 1, 2]) for (const prevGate of ["contextual", "always"]) for (const minCombined of mins) {
    const weights = { ...base.weights, prev }; const a = evalCfg({ ...base, weights, prevGate, minCombined }); results.push({ weights, prevGate, minCombined, context: base.context, ...a }); }
}
const nf = (r: any) => Object.values(r.weights).filter((x: any) => x > 0).length;
results.sort((x, y) => y.top1 - x.top1 || y.none - x.none || nf(x) - nf(y));
await Bun.write(`/tmp/r2/grid-${mode}.json`, JSON.stringify(results, null, 1));
console.log(results.length, JSON.stringify(results.slice(0, 8)));
