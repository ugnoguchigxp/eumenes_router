import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { go, hits } from "./exp.ts";
const SRC = "/workspace/eumenes_router/data/bench-r2.db";
const cfg: Record<string, any> = {
  "sr-cal": { weights: { sem: 1, lex: 1, proto: 1, name: 0, hist: 0, prior: 1 }, minCombined: 0.7, context: 0 },
  "sr-r1-nohist": { weights: { hist: 0 }, minCombined: 0.55, context: 0 } };
const para = require("./para.json");
function mark(db: Database, wrong: Record<string, string>) {
  for (const [id, w] of Object.entries(wrong)) { const r: any = db.query("select label_json from bench_labels where utterance_id=?").get(id); const l = JSON.parse(r.label_json); l.wrong = w; db.query("update bench_labels set label_json=? where utterance_id=?").run(JSON.stringify(l), id); }
}
const summary = (base: any, after: any, targets: string[]) => {
  const ids = Object.keys(after);
  const fixed = targets.filter((id) => after[id] && !base[id].hit && after[id].hit).length;
  const misfire = ids.filter((id) => base[id].hit && !after[id].hit).length;
  const changed = ids.filter((id) => base[id].top !== after[id].top).length;
  return { corrections: targets.length, fixed, fixRate: (fixed / targets.length * 100).toFixed(1), misfire, misfireRate: (misfire / ids.length * 100).toFixed(2), changed, n: ids.length };
};
for (const [n, c] of Object.entries(cfg)) {
  const b: any = {}; for (const s of ["dev", "test"] as const) b[s] = hits(SRC, go(SRC, n, s, c, { tag: `b-${n}` }).preds, s);
  const wrongOf = (s: "dev"|"test") => Object.fromEntries(Object.entries(b[s]).filter(([, x]: any) => !x.hit).map(([id, x]: any) => [id, x.top]));
  // cross: corrections from one split, measured on the other.
  for (const [from, to] of [["dev","test"],["test","dev"]] as const) {
    const p = `/tmp/r2/c-${n}-${from}.db`; copyFileSync(SRC, p); const db = new Database(p); mark(db, wrongOf(from)); db.close();
    const a = hits(p, go(p, n, to, c, { tag: `x-${n}`, feedback: true }).preds, to);
    const targets = Object.keys(wrongOf(to));
    console.log(n, `cross ${from}->${to}`, JSON.stringify(summary(b[to], a, targets)));
  }
  // self: test corrections applied to the same test items.
  { const p = `/tmp/r2/c-${n}-self.db`; copyFileSync(SRC, p); const db = new Database(p); const w = wrongOf("test"); mark(db, w); db.close();
    const a = hits(p, go(p, n, "test", c, { tag: `s-${n}`, feedback: true, feedbackFrom: "same" }).preds, "test");
    console.log(n, "self test->test", JSON.stringify(summary(b.test, a, Object.keys(w)))); }
  // paraphrase: one paraphrase per corrected test item, stored in dev as a correction.
  { const p = `/tmp/r2/c-${n}-para.db`; copyFileSync(SRC, p); const db = new Database(p); const w = wrongOf("test");
    const targets: string[] = [];
    for (const [id, top] of Object.entries(w)) { const key = id.slice(0, 8); const text = para[key]; if (!text) continue; targets.push(id);
      const u: any = db.query("select utterance_json from bench_utterances where id=?").get(id); const uj = JSON.parse(u.utterance_json); const nid = `para-${id}`;
      uj.id = nid; uj.text = text; uj.conversationId = "synthetic-para";
      db.query("insert into bench_utterances(id,conversation_id,seq,utterance_json) values (?,?,?,?)").run(nid, "synthetic-para", 0, JSON.stringify(uj));
      const l: any = db.query("select label_json from bench_labels where utterance_id=?").get(id); const lj = JSON.parse(l.label_json); lj.id = nid; lj.wrong = top;
      db.query("insert into bench_labels(utterance_id,split,status,label_json) values (?,?,?,?)").run(nid, "dev", "reviewed", JSON.stringify(lj)); }
    db.close();
    await Bun.$`cd /workspace/eumenes_router && bun run bench/router/main.ts embed --db ${p} --provider http --url http://127.0.0.1:8765 --model local:e5-small`.quiet();
    const a = hits(p, go(p, n, "test", c, { tag: `p-${n}`, feedback: true }).preds, "test");
    console.log(n, "paraphrase dev->test", JSON.stringify(summary(b.test, a, targets)), "missing paraphrases", Object.keys(w).length - targets.length); }
}
