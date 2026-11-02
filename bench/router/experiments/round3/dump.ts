// Dump per-utterance sr-cal / past rankings for dev+test to /tmp/r3/dump.json (input to cascade + rerank).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { go } from "../round2/exp.ts";
import { loadLabels, loadUtterances, loadCards, passagesByCard, CONVERSATION } from "../../data.ts";
import { isContextual } from "../../round2.ts";
const DB = "/workspace/eumenes_router/data/bench-r2.db";
const SR = { weights: { sem: 1, lex: 1, proto: 1, name: 0, hist: 0, prior: 1 }, minCombined: 0.7, context: 0 };
const db = new Database(DB);
const labels = loadLabels(db); const utt = new Map(loadUtterances(db).map((u) => [u.id, u]));
const rank = (p: any) => Object.entries(p.probabilities as Record<string, number>).sort((a, b) => b[1] - a[1]);
const rows: any[] = [];
for (const split of ["dev", "test"] as const) {
  const sr = go(DB, "x", split, SR, { tag: "sr-cal" }).preds; const past = go(DB, "past", split).preds;
  for (const l of labels.values()) {
    if (l.status !== "reviewed" || l.split !== split || !sr[l.id] || !past[l.id]) continue;
    const u = utt.get(l.id)!;
    rows.push({ id: l.id, split, text: u.text, prevUser: u.previousUser, gold: l.none ? CONVERSATION : l.gold, acceptable: l.acceptable ?? [], none: !!l.none,
      ctx: isContextual(u.text) && !l.none, sr: rank(sr[l.id]).slice(0, 10), srScores: sr[l.id].scores ?? null, srMs: sr[l.id].durationMs, past: rank(past[l.id]).slice(0, 4) });
  }
}
const cards = Object.fromEntries(loadCards(db).map((c: any) => [c.id, { name: c.name, description: c.description, passages: passagesByCard(db).get(c.id) ?? [] }]));
mkdirSync("/tmp/r3", { recursive: true });
await Bun.write("/tmp/r3/dump.json", JSON.stringify({ rows, cards }));
console.log(rows.length, rows.filter((r) => r.split === "test").length, Object.keys(cards).length);
