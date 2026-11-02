import { go, hits, agg } from "./exp.ts";
const H = require("/tmp/r2/test-hits.json");
const cfg: Record<string, any> = { fts: null, hybrid: null, past: null,
  "sr-r1-nohist": { weights: { hist: 0 }, minCombined: 0.55, context: 0 },
  "sr-cal": { weights: { sem: 1, lex: 1, proto: 1, name: 0, hist: 0, prior: 1 }, minCombined: 0.7, context: 0 },
  "hyb-proto-none": { weights: { sem: 0, lex: 0.5, proto: 1, name: 0, hist: 0, prior: 0 }, minCombined: 0.7, context: 0 },
  "sr-cal+prev": { weights: { sem: 1, lex: 1, proto: 1, name: 0, hist: 0, prior: 1, prev: 0.25 }, prevGate: "contextual", minCombined: 0.7, context: 0 } };
for (const [n, c] of Object.entries(cfg)) {
  const r = go("/tmp/r2/scale2000.db", n, "test", c ?? undefined, { tag: "s-" + n });
  const h = hits("/tmp/r2/scale2000.db", r.preds, "test");
  const lat = Object.values(r.preds).map((p: any) => p.durationMs).sort((a: number, b: number) => a - b);
  const lost = Object.keys(h).filter((id) => H[n][id].hit && !h[id].hit).length;
  console.log(n, "top1", (agg(h).top1 * 100).toFixed(1), "p50", lat[Math.floor(lat.length / 2)], "p95", lat[Math.floor(lat.length * 0.95)], "lost", lost);
}
