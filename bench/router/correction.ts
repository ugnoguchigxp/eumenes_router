/**
 * User correction → orthographic-variant experiment (`bun run router correct`).
 *
 * Corrections go through the router's own correction path: rows are written with
 * `recordFeedbackInTransaction` into a migrated router database, read back with
 * `nearFeedback` (θ = feedbackNear), and applied with `correctProbabilities`
 * (β = feedbackWeight), as `route()` does. Nothing here looks texts up by key.
 *
 * Configurations:
 *   sr            sr-cal alone (round-3 settings)
 *   <tag>         sr + cross-encoder rerank, defer to the recorded LLM choice (`past`)
 *                 when the corrected margin is under the dev threshold (20th percentile)
 *   <tag>+pin     the same, but a near correction keeps the router's answer (no deferral)
 *   <tag>+tblpin  rule table on; only a rule-table hit (exact key / reading Dice ≥ τ) pins the corrected answer (no deferral)
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrateInTransaction } from "../../src/db/schema.ts";
import { nearFeedback, recordFeedbackInTransaction } from "../../src/db/feedback.ts";
import { correctProbabilities } from "../../src/decision/correct.ts";
import { routeSettings } from "../../src/contracts/settings.ts";
import type { VectorSpace } from "../../src/vector.ts";
import { CONVERSATION, loadLabels, loadUtterances, passagesByCard } from "./data.ts";
import { cachedVectors, fillCache, httpProvider } from "./embed.ts";
import { registerSr, SR_DEFAULTS, type SrOptions } from "./algorithms.ts";
import { run } from "./run.ts";
import { keyOf as tableKey, tableScore, tuneTau, type Keyed } from "./variant-table.ts";
import type { NearFeedback } from "../../src/contracts/feedback.ts";

export type Correction = { text: string; right: string; wrong?: string | null; id?: string };
export type Variant = { source: string; type: string; text: string; gold?: string };
export type Control = { id?: string; text: string; gold: string };
export type Ranked = Array<[string, number]>;

/** Round-3 sr-cal and the dev-tuned rerank fusion (w, conversation offset). */
export const SR_CAL: Partial<SrOptions> = { weights: { ...SR_DEFAULTS.weights, sem: 1, lex: 1, proto: 1, name: 0, hist: 0, prior: 1 }, minCombined: 0.7, context: 0 };
export const RERANKERS: Record<string, { model: string; w: number; conv: number }> = {
	ruri: { model: "cl-nagoya/ruri-v3-reranker-310m", w: 2, conv: 0.18 },
	xs: { model: "hotchpotch/japanese-reranker-xsmall-v2", w: 2, conv: 0.1 },
};

/** The router's correction store, in memory, in the bench's vector space. */
export function correctionStore(model: string, dimension: number, table?: { tau: number }) {
	const db = new Database(":memory:");
	migrateInTransaction(db as never);
	const space: VectorSpace = { modelId: model, revision: "bench", artifactDigest: "bench", dimension };
	const settings = routeSettings({});
	let n = 0;
	const keyed: Array<{ id: string; key: Keyed; right: string; wrong: string | null }> = [];
	return {
		settings,
		add(c: Correction, vector: ArrayLike<number>, key?: Keyed) {
			n++;
			if (key) keyed.push({ id: c.id ?? `corr-${n}`, key, right: c.right, wrong: c.wrong ?? null });
			recordFeedbackInTransaction(db as never, {
				id: c.id ?? `corr-${n}`, conversationId: "bench", messageId: `m-${n}`, messageIds: [],
				runId: `r-${n}`, source: "redirect", text: c.text, space, vector: Array.from(vector),
				wrongId: c.wrong ?? null, rightId: c.right, at: n,
			});
		},
		near(vector: ArrayLike<number>, threshold = settings.feedbackNear) {
			return nearFeedback(db as never, { vector: Array.from(vector), space, threshold });
		},
		/** Rule-table matches (exact normalized key or reading Dice ≥ τ), at full strength. */
		tableNear(key: Keyed): NearFeedback[] {
			if (!table) return [];
			return keyed.filter((k) => tableScore(k.key, key) >= table.tau).map((k) => ({ id: k.id, wrongId: k.wrong, rightId: k.right, similarity: 1 }));
		},
		correct(ranked: Ranked, vector: ArrayLike<number>, threshold = settings.feedbackNear, key?: Keyed) {
			const emb = this.near(vector, threshold);
			const tbl = key ? this.tableNear(key) : [];
			const near = [...tbl, ...emb.filter((e) => !tbl.some((t) => t.id === e.id))];
			const out = correctProbabilities(ranked.map(([id, p]) => ({ id, p })), near, { threshold, weight: settings.feedbackWeight });
			const r: Ranked = ranked.map(([id], i) => [id, out.p[i]!]);
			return { ranked: r.sort((a, b) => b[1] - a[1]), near: near.length, tableHits: tbl.length, conflict: out.conflict };
		},
	};
}

const softmax = (xs: number[]) => { const m = Math.max(...xs); const e = xs.map((x) => Math.exp(x - m)); const s = e.reduce((a, b) => a + b, 0); return e.map((x) => x / s); };
/** sr probabilities fused with rerank scores, as round3/cascade_rr.py; returned as p = softmax(score). */
export function fuse(sr: Ranked, rr: Record<string, number>, w: number, conv: number): Ranked {
	const s = new Map(sr);
	const ids = [...Object.keys(rr), CONVERSATION];
	const comb = ids.map((c) => (s.get(c) ?? 0) + (c === CONVERSATION ? conv : w * rr[c]!));
	const p = softmax(comb);
	return ids.map((c, i) => [c, p[i]!] as [string, number]).sort((a, b) => b[1] - a[1]);
}
export const margin = (r: Ranked) => Math.log(r[0]![1] + 1e-12) - Math.log((r[1]?.[1] ?? 0) + 1e-12);

/** Percentile bootstrap of a mean (values 0/1 or paired differences). */
export function bootMean(xs: number[], B = 4000, seed = 7) {
	if (!xs.length) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
	let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
	const ms: number[] = [];
	for (let b = 0; b < B; b++) { let t = 0; for (let i = 0; i < xs.length; i++) t += xs[Math.floor(rnd() * xs.length)]!; ms.push(t / xs.length); }
	ms.sort((a, b) => a - b);
	return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, lo: ms[Math.floor(B * 0.025)]!, hi: ms[Math.floor(B * 0.975)]!, n: xs.length };
}

const readJsonl = <T>(p: string): T[] => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

type Item = { id: string; text: string; gold: string; acceptable: readonly string[]; split: string; kind: "real" | "variant" | "control"; type?: string; source?: string; past?: string | undefined };

export type ExperimentOptions = {
	db: string; out: string; variants?: string | undefined; controls?: string | undefined; corrections?: string | undefined;
	url: string; model?: string | undefined; python?: string | undefined; rerankers?: string[]; thetas?: number[] | undefined; deferThresholds?: Record<string, number> | undefined;
	/** Add `<cfg>+tbl` configurations: the variant-aware rule table (needs `python` with pykakasi for readings). */
	table?: boolean | undefined; tableMaxFalse?: number | undefined;
	print?: (s: string) => void;
};

export async function correctionExperiment(o: ExperimentOptions) {
	const print = o.print ?? console.log;
	const model = o.model ?? "local:e5-small";
	mkdirSync(o.out, { recursive: true });
	const dbPath = join(o.out, "corr.db");
	copyFileSync(o.db, dbPath);
	const db = new Database(dbPath);
	const labels = loadLabels(db);
	const utts = loadUtterances(db);
	const byPrefix = (p: string) => utts.find((u) => u.id.startsWith(p) && labels.get(u.id)?.split === "test") ?? utts.find((u) => u.id.startsWith(p));
	const goldOf = (id: string) => { const l = labels.get(id)!; return l.none ? CONVERSATION : l.gold!; };
	const variants = o.variants ? readJsonl<Variant>(o.variants) : [];
	const controls = o.controls ? readJsonl<Control>(o.controls) : [];
	// Synthetic utterances join the test split under their own ids; labels carry the gold.
	const insU = db.query("INSERT INTO bench_utterances(id,conversation_id,seq,utterance_json) VALUES (?,?,?,?)");
	const insL = db.query("INSERT INTO bench_labels(utterance_id,split,status,label_json) VALUES (?,?,?,?)");
	const synth: Item[] = [];
	const add = (id: string, text: string, gold: string, hints: unknown, extra: Partial<Item>) => {
		insU.run(id, "synthetic", synth.length, JSON.stringify({ id, conversationId: "synthetic", seq: synth.length, text, previousUser: null, previousAgent: null, hints: hints ?? {} }));
		insL.run(id, "test", "reviewed", JSON.stringify({ id, gold: gold === CONVERSATION ? null : gold, acceptable: [], none: gold === CONVERSATION, status: "reviewed", split: "test", labeler: "grok-bot-self-inference" }));
		synth.push({ id, text, gold, acceptable: [], split: "test", kind: "control", ...extra });
	};
	variants.forEach((v, i) => {
		const src = byPrefix(v.source);
		if (!src) throw new Error(`variant_source_unknown: ${v.source}`);
		add(`var-${i}`, v.text, v.gold ?? goldOf(src.id), src.hints, { kind: "variant", type: v.type, source: src.id, acceptable: labels.get(src.id)?.acceptable ?? [] });
	});
	controls.forEach((c, i) => add(c.id ?? `ctl-${i}`, c.text, c.gold, {}, { kind: "control" }));
	const texts = loadUtterances(db).map((u) => u.text);
	const emb = await fillCache(db, httpProvider({ baseUrl: o.url, model }), texts);
	print(`embedded ${emb.added} new of ${emb.total}`);
	const vec = cachedVectors(db, model);
	// sr and past rankings for dev + test (synthetic rows are test).
	registerSr("sr-corr", { ...SR_DEFAULTS, ...SR_CAL, weights: { ...SR_DEFAULTS.weights, ...SR_CAL.weights } } as SrOptions, true);
	const rank = (p: Record<string, number>): Ranked => Object.entries(p).sort((a, b) => b[1] - a[1]);
	const preds = (algo: string, split: "dev" | "test") => {
		const dir = join(o.out, "runs", `${algo}-${split}`);
		if (existsSync(dir)) rmSync(dir, { recursive: true });
		run(db, { algo, split, model, offer: 8, temperature: 0.1, feedback: false, out: dir } as never);
		return Object.fromEntries(readFileSync(join(dir, "predictions.jsonl"), "utf8").trim().split("\n").map((l) => { const p = JSON.parse(l); return [p.id, rank(p.probabilities)]; })) as Record<string, Ranked>;
	};
	const sr = { ...preds("sr-corr", "dev"), ...preds("sr-corr", "test") };
	const past = { ...preds("past", "dev"), ...preds("past", "test") };
	const real: Item[] = [...loadLabels(db).values()]
		.filter((l) => l.status === "reviewed" && !l.id.startsWith("var-") && !l.id.startsWith("ctl-") && sr[l.id] && past[l.id])
		.map((l) => ({ id: l.id, text: utts.find((u) => u.id === l.id)!.text, gold: l.none ? CONVERSATION : l.gold!, acceptable: l.acceptable ?? [], split: l.split, kind: "real" as const, past: past[l.id]![0]![0] }));
	// The LLM stand-in for a variant is its source's recorded choice; controls have none.
	for (const s of synth) s.past = s.source ? past[s.source]?.[0]?.[0] : undefined;
	const items = [...real, ...synth];
	// Cross-encoder scores (cached by text + candidates).
	const tags = (o.rerankers ?? []).map((t) => {
		const [tag, model] = t.split("=");
		if (model) RERANKERS[tag!] = { model, w: RERANKERS["ruri"]!.w, conv: RERANKERS["ruri"]!.conv };
		return tag!;
	});
	const rr: Record<string, Record<string, Record<string, number>>> = {};
	const cards = Object.fromEntries([...passagesByCard(db)].map(([id, p]) => [id, { passages: p }]));
	const keyOf = (it: Item) => it.text + "\x00" + sr[it.id]!.map(([c]) => c).join("|");
	if (tags.length) {
		const inp = join(o.out, "rerank-in.json");
		writeFileSync(inp, JSON.stringify({ cards, rows: items.map((it) => ({ text: it.text, cands: sr[it.id]!.map(([c]) => c) })) }));
		for (const tag of tags) {
			const file = join(o.out, `rerank-${tag}.json`);
			if (o.python && !existsSync(file)) { // cached scores are reused (resume-safe; delete the file to rescore)
				const p = Bun.spawnSync([o.python, join(import.meta.dir, "experiments/correction/models.py"), "rerank", inp, file, RERANKERS[tag]!.model, tag], { stdout: "inherit", stderr: "inherit" });
				if (p.exitCode !== 0) throw new Error(`rerank_failed: ${tag}`);
			}
			rr[tag] = JSON.parse(readFileSync(file, "utf8"));
		}
	}
	const front = (cfg: string, it: Item): Ranked => {
		if (cfg === "sr") return sr[it.id]!;
		const t = RERANKERS[cfg]!; return fuse(sr[it.id]!, rr[cfg]![keyOf(it)]!, t.w, t.conv);
	};
	const thOf: Record<string, number> = {};
	for (const tag of tags) {
		const dm = real.filter((r) => r.split === "dev").map((r) => margin(front(tag, r))).sort((a, b) => a - b);
		thOf[tag] = o.deferThresholds?.[tag] ?? dm[Math.floor(dm.length * 0.2) - 1]! + 1e-9;
	}
	// Variant-aware table: readings from the Python preprocessor, τ tuned on dev (different-gold false-match bound).
	const readings: Record<string, string> = {};
	let tau = 1; let tauCurve: unknown = null;
	if (o.table) {
		const rin = join(o.out, "reading-in.json"), rout = join(o.out, "readings.json");
		writeFileSync(rin, JSON.stringify([...new Set(items.map((it) => it.text))]));
		const p = Bun.spawnSync([o.python ?? "python3", join(import.meta.dir, "experiments/correction/reading.py"), rin, rout], { stdout: "inherit", stderr: "inherit" });
		if (p.exitCode !== 0) throw new Error("reading_failed");
		Object.assign(readings, JSON.parse(readFileSync(rout, "utf8")));
		const t = tuneTau(real.filter((r) => r.split === "dev").map((r) => ({ key: tableKey(r.text, readings[r.text]), gold: r.gold })), o.tableMaxFalse ?? 0.02);
		tau = t.tau; tauCurve = t.curve; print(`table τ=${tau} (dev)`);
	}
	const kOf = (text: string) => tableKey(text, readings[text]);
	const ok = (it: Item, t: string | undefined) => t !== undefined && (t === it.gold || it.acceptable.includes(t));
	type Pick = { top: string | undefined; frontTop: string; deferred: boolean; near: number };
	const hasTbl = (cfg: string) => /\+tbl(pin)?$/.test(cfg);
	const decide = (cfg: string, it: Item, store: ReturnType<typeof correctionStore> | null, theta?: number): Pick => {
		const base = cfg.replace(/\+(pin|tblpin|tbl)$/, "");
		let r = front(base, it); let near = 0; let tbl = 0;
		if (store) { const c = store.correct(r, vec(it.text), theta, hasTbl(cfg) ? kOf(it.text) : undefined); r = c.ranked; near = c.near; tbl = c.tableHits; }
		if (base === "sr") return { top: r[0]![0], frontTop: r[0]![0], deferred: false, near };
		const defer = margin(r) < thOf[base]! && !(cfg.endsWith("+pin") && near > 0) && !(cfg.endsWith("+tblpin") && tbl > 0);
		return { top: defer ? it.past : r[0]![0], frontTop: r[0]![0], deferred: defer, near };
	};
	const configs = ["sr", ...tags, ...tags.map((t) => `${t}+pin`), ...(o.table ? ["sr+tbl", ...tags.map((t) => `${t}+tbl`), ...tags.map((t) => `${t}+tblpin`)] : [])];
	const test = real.filter((r) => r.split === "test");
	const userCorr = o.corrections ? readJsonl<Correction>(o.corrections) : null;
	const report: Record<string, unknown> = { model, theta: routeSettings({}).feedbackNear, beta: routeSettings({}).feedbackWeight, deferThreshold: thOf, table: o.table ? { tau, maxFalse: o.tableMaxFalse ?? 0.02, devCurve: tauCurve } : null, counts: { test: test.length, variants: variants.length, controls: controls.length }, configs: {} };
	const pct = (b: ReturnType<typeof bootMean>) => ({ rate: +(b.mean * 100).toFixed(1), lo: +(b.lo * 100).toFixed(1), hi: +(b.hi * 100).toFixed(1), n: b.n });
	for (const cfg of configs) for (const theta of o.thetas ?? [routeSettings({}).feedbackNear]) {
		const before = new Map(items.map((it) => [it.id, decide(cfg, it, null)]));
		// Corrections: the user fixes each wrong test answer of this configuration (or the given JSONL).
		const corrected = test.filter((it) => !ok(it, before.get(it.id)!.top));
		const corrections: Correction[] = userCorr ?? corrected.map((it) => ({ id: `c-${it.id}`, text: it.text, right: it.gold, wrong: before.get(it.id)!.top ?? null }));
		const store = correctionStore(model, vec(items[0]!.text).length, hasTbl(cfg) ? { tau } : undefined);
		for (const c of corrections) store.add(c, vec(c.text), hasTbl(cfg) ? kOf(c.text) : undefined);
		const after = new Map(items.map((it) => [it.id, decide(cfg, it, store, theta)]));
		const hit = (m: Map<string, Pick>, it: Item) => (ok(it, m.get(it.id)!.top) ? 1 : 0);
		const fix = (xs: Item[]) => pct(bootMean(xs.filter((it) => !hit(before, it)).map((it) => hit(after, it))));
		const acc = (m: Map<string, Pick>, xs: Item[]) => pct(bootMean(xs.map((it) => hit(m, it))));
		const broke = (xs: Item[]) => pct(bootMean(xs.filter((it) => hit(before, it)).map((it) => 1 - hit(after, it))));
		const cset = new Set(corrected.map((c) => c.id));
		const rest = test.filter((it) => !cset.has(it.id));
		const vsAll = synth.filter((s) => s.kind === "variant"), vs = userCorr ? vsAll : vsAll.filter((v) => cset.has(v.source!)), cs = synth.filter((s) => s.kind === "control");
		const asFront = (m: Map<string, Pick>) => new Map([...m].map(([k, p]) => [k, { ...p, top: p.frontTop }]));
		const fb = asFront(before), fa = asFront(after);
		const frontFix = (xs: Item[]) => pct(bootMean(xs.filter((it) => !hit(fb, it)).map((it) => hit(fa, it))));
		const byType: Record<string, unknown> = {};
		for (const t of [...new Set(vs.map((v) => v.type!))].sort()) {
			const xs = vs.filter((v) => v.type === t);
			byType[t] = { n: xs.length, before: acc(before, xs), after: acc(after, xs), fix: fix(xs), frontFix: frontFix(xs), frontBefore: acc(fb, xs), frontAfter: acc(fa, xs), nearHit: +(100 * xs.filter((x) => after.get(x.id)!.near > 0).length / xs.length).toFixed(1) };
		}
		const diff = bootMean(test.map((it) => hit(after, it) - hit(before, it)));
		const frontChanged = (xs: Item[]) => xs.filter((x) => before.get(x.id)!.frontTop !== after.get(x.id)!.frontTop).length;
		const key = (o.thetas?.length ?? 0) > 1 ? `${cfg}@θ${theta}` : cfg;
		(report["configs"] as Record<string, unknown>)[key] = {
			corrections: corrections.length,
			exactFront: frontFix(corrected), exact: fix(userCorr ? test.filter((it) => corrections.some((c) => c.text === it.text)) : corrected),
			testTop1: { before: acc(before, test), after: acc(after, test), diff: { d: +(diff.mean * 100).toFixed(1), lo: +(diff.lo * 100).toFixed(1), hi: +(diff.hi * 100).toFixed(1) } },
			rest: { n: rest.length, before: acc(before, rest), after: acc(after, rest), misfire: broke(rest), frontChanged: frontChanged(rest) },
			variants: { n: vs.length, sources: new Set(vs.map((v) => v.source)).size, misfireOther: broke(vsAll.filter((v) => !vs.includes(v))), before: acc(before, vs), after: acc(after, vs), fix: fix(vs), frontBefore: acc(fb, vs), frontAfter: acc(fa, vs), frontFix: frontFix(vs), inCandidates: vs.filter((v) => sr[v.id]!.some(([c]) => c === v.gold || v.acceptable.includes(c))).length, wrongBefore: vs.filter((v) => !hit(before, v)).length, nearHit: +(100 * vs.filter((x) => after.get(x.id)!.near > 0).length / vs.length).toFixed(1), byType },
			controls: { n: cs.length, nearHit: cs.filter((x) => after.get(x.id)!.near > 0).length, frontChanged: frontChanged(cs), frontMisfire: cs.filter((x) => x.gold === before.get(x.id)!.frontTop && x.gold !== after.get(x.id)!.frontTop).length, frontBefore: acc(new Map(cs.map((x) => [x.id, { ...before.get(x.id)!, top: before.get(x.id)!.frontTop }])), cs), deferBefore: cs.filter((x) => before.get(x.id)!.deferred).length, deferAfter: cs.filter((x) => after.get(x.id)!.deferred).length },
			deferRate: { before: +(100 * test.filter((x) => before.get(x.id)!.deferred).length / test.length).toFixed(1), after: +(100 * test.filter((x) => after.get(x.id)!.deferred).length / test.length).toFixed(1) },
			perTest: test.map((x) => ({ id: x.id, text: x.text, deferBefore: before.get(x.id)!.deferred, deferAfter: after.get(x.id)!.deferred })),
			perVariant: vs.map((v) => ({ id: v.id, type: v.type, source: v.source!.slice(0, 8), text: v.text, gold: v.gold, before: before.get(v.id)!.top, after: after.get(v.id)!.top, frontBefore: before.get(v.id)!.frontTop, frontAfter: after.get(v.id)!.frontTop, inCandidates: sr[v.id]!.some(([c]) => c === v.gold || v.acceptable.includes(c)), near: after.get(v.id)!.near, deferred: after.get(v.id)!.deferred, maxSim: Math.max(...corrections.map((c) => { const a = vec(c.text), b = vec(v.text); let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; })) })),
			perControl: cs.map((c) => ({ id: c.id, text: c.text, gold: c.gold, frontBefore: before.get(c.id)!.frontTop, frontAfter: after.get(c.id)!.frontTop, near: after.get(c.id)!.near })),
		};
		const r = (report["configs"] as Record<string, any>)[key];
		print(`${key}: corrections ${r.corrections} exact ${r.exact.rate}% variants ${r.variants.before.rate}→${r.variants.after.rate}% (fix ${r.variants.fix.rate}%) rest misfire ${r.rest.misfire.rate}% test ${r.testTop1.before.rate}→${r.testTop1.after.rate} controls near ${r.controls.nearHit}/${r.controls.n}`);
	}
	writeFileSync(join(o.out, "report.json"), JSON.stringify(report, null, 1));
	db.close();
	return report;
}
