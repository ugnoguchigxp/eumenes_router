/**
 * Production-shaped routing with the best-v2 artifact (`bun run router route`, or `run --algo best-v2 --text …`).
 *
 *   route --db <corr.db> --artifact <dir> (--text <utterance> [--prev <previous user turn>] [--hints <json>] | --in <jsonl> [--out <jsonl>])
 *         --model <embedding cache key> [--python <venv python>] [--url <e5 server>] [--rr-all <every-card scores.json>]
 *
 * Per utterance: sr-corr (TS, catalog + trigram index + e5 vector) → best_v2.py predict (ruri rerank, kNN memory,
 * LR ranker, p1−p2 gate from the exported artifact; no retraining). Output: one JSON per utterance with the tool, the
 * candidate scores, `defer` (send `llm_candidates` to the LLM) and per-stage latency. The database is copied to a temp
 * file first (new texts are embedded into the copy). Without --url an e5 server (models.py serve) is started locally.
 * Batch input rows: {"id"?, "text", "prev"?, "hints"?}.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVERSATION, loadCards, passagesByCard, type Utterance } from "./data.ts";
import { cachedVectors, fillCache, httpProvider } from "./embed.ts";
import { ALGORITHMS, ftsSearch, ranking, registerSr, SR_DEFAULTS, type AlgorithmEnv, type CandidateCard, type SrOptions } from "./algorithms.ts";
import { loadHistory } from "./data.ts";
import { SR_CAL } from "./correction.ts";
import { capByKind, srRanking } from "../../src/index.ts";

export type RouteRow = { id?: string; text: string; prev?: string | null; hints?: Utterance["hints"] };
export type RouteOptions = {
	db: string; artifact: string; rows: RouteRow[]; python?: string | undefined; url?: string | undefined; model?: string | undefined;
	/** Reranker scores of every card per text (context.py score-all): used for the offered and extra tools instead of the artifact's ruri. */
	rrAll?: Record<string, Record<string, number>> | undefined;
	offer?: number; temperature?: number;
};
const HERE = import.meta.dir;
const softmax = (v: readonly number[], t: number) => { const m = Math.max(...v); const e = v.map((x) => Math.exp((x - m) / t)); const z = e.reduce((s, x) => s + x, 0); return e.map((x) => x / z); };

async function e5Server(python: string): Promise<{ url: string; stop: () => void }> {
	const port = 18000 + Math.floor(Math.random() * 2000);
	const p = Bun.spawn([python, join(HERE, "experiments/correction/models.py"), "serve", String(port)], { stdout: "pipe", stderr: "ignore" });
	const reader = p.stdout.getReader(); let buf = "";
	while (!buf.includes("ready")) { const { value, done } = await reader.read(); if (done) throw new Error("e5_server_failed"); buf += new TextDecoder().decode(value); }
	return { url: `http://127.0.0.1:${port}`, stop: () => p.kill() };
}

export async function route(o: RouteOptions) {
	const python = o.python ?? "/tmp/cvenv/bin/python"; const model = o.model;
	if (!model) throw new Error("route: --model (the embedding cache key the artifact was trained with) is required");
	const offer = o.offer ?? 8; const temperature = o.temperature ?? 0.1;
	const tmp = mkdtempSync(join(tmpdir(), "route-")); const dbPath = join(tmp, "route.db"); copyFileSync(o.db, dbPath);
	const server = o.url ? null : await e5Server(python);
	try {
		const db = new Database(dbPath);
		const t0 = performance.now();
		await fillCache(db, httpProvider({ baseUrl: o.url ?? server!.url, model }), o.rows.map((r) => r.text));
		const e5Ms = (performance.now() - t0) / Math.max(1, o.rows.length);
		registerSr("sr-corr", { ...SR_DEFAULTS, ...SR_CAL, weights: { ...SR_DEFAULTS.weights, ...SR_CAL.weights } } as SrOptions, true);
		const algo = ALGORITHMS["sr-corr"]!; const cards = loadCards(db); const passages = passagesByCard(db); const vector = cachedVectors(db, model);
		const env: AlgorithmEnv = { fts: ftsSearch(db), vector, history: loadHistory(db), cardText: new Map(cards.map((c) => [c.id, { title: c.title, summary: c.summary }])) };
		const all: CandidateCard[] = cards.map((c) => ({ id: c.id, kind: c.kind, passages: passages.get(c.id) ?? [] }));
		const kindOf = new Map(cards.map((c) => [c.id, c.kind]));
		const inRows = o.rows.map((r, i) => {
			const utterance: Utterance = { id: r.id ?? `q-${i}`, conversationId: "route", seq: i, text: r.text, previousUser: r.prev ?? null, previousAgent: null, hints: r.hints ?? {} };
			const avail = utterance.hints.availableToolchainIds; const cands = avail ? all.filter((c) => c.id === CONVERSATION || avail.includes(c.id)) : all;
			const t = performance.now(); const scores = algo.score({ utterance, candidates: cands }, env);
			const order = capByKind(ranking(scores), (id: string) => kindOf.get(id)).slice(0, offer);
			if (!order.includes(CONVERSATION)) { if (order.length >= offer) order.pop(); order.push(CONVERSATION); }
			const best = Math.max(0, ...order.map((id) => scores.get(id) ?? 0)); const scaled = order.map((id) => (best > 0 ? Math.max(0, scores.get(id) ?? 0) / best : 0));
			const p = softmax(scaled, temperature); const srMs = performance.now() - t;
			// The ranking of every tool (kind slots, as the package): an artifact with extra tools takes them from it.
			const srfull = srRanking(scores, (ranked) => capByKind(ranked, (id: string) => kindOf.get(id)));
			// A text the scores file lacks (over the provider's limit) keeps the artifact's ruri for the offer and gets no extra
			// tools, as the corr swap and the package (no rerank score, no extra tool) do.
			const scored = o.rrAll?.[r.text];
			const rr = scored ? Object.fromEntries(Object.entries(scored).filter(([id]) => id !== CONVERSATION)) : undefined;
			return { id: utterance.id, text: r.text, sr: order.map((id, k) => [id, Number(p[k]!.toFixed(6))]), sr_scores: Object.fromEntries(order.map((id, k) => [id, Number(scaled[k]!.toFixed(6))])), vec: [...vector(r.text)], srfull: o.rrAll && !scored ? [] : srfull, sr_ms: srMs, ...(rr ? { rr } : {}) };
		});
		db.close();
		const inp = join(tmp, "in.jsonl"); const outp = join(tmp, "out.jsonl");
		writeFileSync(inp, inRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const pr = Bun.spawnSync([python, join(HERE, "experiments/best/best_v2.py"), "predict", "--artifact", o.artifact, "--in", inp, "--out", outp], { stderr: "pipe" });
		if (pr.exitCode !== 0) throw new Error(`predict_failed: ${pr.stderr.toString().slice(-800)}`);
		const outs = readFileSync(outp, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { latency_ms: Record<string, number> } & Record<string, unknown>);
		return outs.map((r, i) => {
			const lat: Record<string, number> = { ...r.latency_ms, e5_ms: Number(e5Ms.toFixed(2)), sr_ms: Number(inRows[i]!.sr_ms.toFixed(2)) };
			lat["total"] = Number((Object.entries(lat).filter(([k]) => k !== "total").reduce((s, [, v]) => s + v, 0)).toFixed(2));
			return { ...r, text: inRows[i]!.text, latency_ms: lat };
		});
	} finally {
		server?.stop(); rmSync(tmp, { recursive: true, force: true });
	}
}
