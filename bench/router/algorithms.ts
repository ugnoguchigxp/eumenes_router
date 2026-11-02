/**
 * The plug-in point for ranking methods. An algorithm turns one utterance, its
 * context hints and the candidate cards into a score per candidate (higher is
 * better). Everything after the scores — the offer, the probabilities, the
 * correction and the decision table — is shared (`run.ts`), so methods differ only
 * here. No algorithm may call a generative model.
 */
import type { Database } from "bun:sqlite";
import { dot } from "../../src/index.ts";
import type { Utterance } from "./data.ts";
import { isContextual } from "./round2.ts";

export type CandidateCard = {
	id: string;
	kind: string;
	passages: readonly string[];
};

export type AlgorithmInput = {
	utterance: Utterance;
	candidates: readonly CandidateCard[];
};

export type AlgorithmEnv = {
	/** bm25 of the trigram index, as `-bm25` (higher is better), by card id. */
	fts: (text: string) => Map<string, number>;
	/** The cached, normalized vector of a text. */
	vector: (text: string) => Float32Array;
	/** Past product choices, for the reference rows and for transition features. Optional. */
	history?: BenchHistory;
	/** Card titles and summaries by id (name/target features). Optional. */
	cardText?: Map<string, { title: string; summary: string }>;
};

export type BenchHistory = {
	/** The product's own choice for this utterance (current ids; retired ids mapped). */
	past: (utteranceId: string) => string | null;
	/** The product's recorded top candidates with similarity, for this utterance. */
	recorded: (utteranceId: string) => Array<{ id: string; similarity: number }>;
	/** The product's choice for the previous routed turn of the same conversation. */
	previous: (utteranceId: string) => string | null;
	/** Transition counts prev -> next over past choices, without this utterance's own pair. */
	transition: (utteranceId: string, from: string, to: string) => { pair: number; from: number };
};

export type Algorithm = {
	name: string;
	needsEmbeddings: boolean;
	score: (input: AlgorithmInput, env: AlgorithmEnv) => Map<string, number>;
};

/** The utterance's character trigrams as an FTS5 OR query; null under three characters. */
export function trigramQuery(text: string): string | null {
	const chars = [...text.normalize("NFKC").replace(/\s+/g, "")];
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= chars.length; i++)
		grams.add(chars.slice(i, i + 3).join(""));
	if (!grams.size) return null;
	return [...grams].map((g) => `"${g.replaceAll('"', '""')}"`).join(" OR ");
}

export function ftsSearch(db: Database) {
	const query = db.query(
		"SELECT card_id AS id, bm25(bench_fts) AS s FROM bench_fts WHERE bench_fts MATCH ?",
	);
	return (text: string): Map<string, number> => {
		const out = new Map<string, number>();
		const q = trigramQuery(text);
		if (!q) return out;
		for (const row of query.all(q) as Array<{ id: string; s: number }>) {
			const value = -row.s;
			if (value > (out.get(row.id) ?? -Infinity)) out.set(row.id, value);
		}
		return out;
	};
}

const fts: Algorithm = {
	name: "fts",
	needsEmbeddings: false,
	score: ({ utterance, candidates }, env) => {
		const hits = env.fts(utterance.text);
		const ids = new Set(candidates.map((c) => c.id));
		return new Map([...hits].filter(([id]) => ids.has(id)));
	},
};

/** The closest passage of each card by inner product, as the product's search ranks. */
const embed: Algorithm = {
	name: "embed",
	needsEmbeddings: true,
	score: ({ utterance, candidates }, env) => {
		const q = env.vector(utterance.text);
		const out = new Map<string, number>();
		for (const c of candidates) {
			let best = -Infinity;
			for (const p of c.passages) best = Math.max(best, dot(q, env.vector(p)));
			if (best > -Infinity) out.set(c.id, best);
		}
		return out;
	},
};

/** Ids by score, best first; ties by id. */
export function ranking(scores: Map<string, number>): string[] {
	return [...scores]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([id]) => id);
}

export const RRF_K = 60;

/** Reciprocal rank fusion of `fts` and `embed`. */
const hybrid: Algorithm = {
	name: "hybrid",
	needsEmbeddings: true,
	score: (input, env) => {
		const out = new Map<string, number>();
		for (const algo of [fts, embed])
			ranking(algo.score(input, env)).forEach((id, i) =>
				out.set(id, (out.get(id) ?? 0) + 1 / (RRF_K + i + 1)),
			);
		return out;
	},
};

/** Reference row: the product's past choice as the only candidate (its decision as recorded). */
const past: Algorithm = {
	name: "past",
	needsEmbeddings: false,
	score: ({ utterance }, env) => {
		const id = env.history?.past(utterance.id) ?? null;
		return new Map(id ? [[id, 1]] : []);
	},
};

/**
 * Reference row: the product's recorded embedding similarities (top 4 at most). Not a
 * full embed run — only the candidates the product kept, with the vectors it had.
 */
const recordedEmbed: Algorithm = {
	name: "recorded-embed",
	needsEmbeddings: false,
	score: ({ utterance, candidates }, env) => {
		const ids = new Set(candidates.map((c) => c.id));
		return new Map(
			(env.history?.recorded(utterance.id) ?? [])
				.filter((r) => ids.has(r.id))
				.map((r) => [r.id, r.similarity]),
		);
	},
};

/** Normalized to 0..1 by the best value in the map. */
function unit(m: Map<string, number>): Map<string, number> {
	const top = Math.max(0, ...m.values());
	return new Map([...m].map(([k, v]) => [k, top > 0 ? Math.max(0, v) / top : 0]));
}

function bigrams(text: string): Set<string> {
	const c = [...text.normalize("NFKC").toLowerCase().replace(/\s+/g, "")];
	const out = new Set<string>();
	for (let i = 0; i + 2 <= c.length; i++) out.add(c[i]! + c[i + 1]!);
	return out;
}


export type SrOptions = {
	weights: { sem: number; lex: number; proto: number; name: number; hist: number; prior: number; prev?: number };
	/** When the previous-turn feature applies: only to turns that lean on context, or always. */
	prevGate?: "contextual" | "always";
	/** The conversation's fixed score: below it, no toolchain is chosen. */
	minCombined: number;
	/** Prototype mix: w·best + (1−w)·mean of the top M passages. */
	protoW: number;
	protoM: number;
	/** Weight of the previous user turn in the lexical query (dual query). */
	context: number;
};

export const SR_DEFAULTS: SrOptions = {
	weights: { sem: 1, lex: 1, proto: 1, name: 1, hist: 1, prior: 1 },
	minCombined: 0.3,
	protoW: 0.7,
	protoM: 3,
	context: 0.5,
};

/** Resource kinds a host may pass, and words on cards that serve them. */
const RESOURCE_WORDS: Record<string, string[]> = {
	image: ["画像", "写真", "イメージ"],
	pdf: ["文書", "PDF"],
	document: ["文書"],
	repository: ["GitHub", "リポジトリ", "コード"],
	audio: ["曲", "音楽"],
	video: ["動画"],
};

/**
 * `sr-weighted`: vLLM semantic-router's weighted fusion and history prior, ported.
 * score(c) = Σ w_i·f_i(c) / Σ w_i over six features; the conversation gets
 * `minCombined`. With `needsEmbeddings` false (no vectors), f_sem and f_proto drop out
 * and their weight with them.
 */
export function srWeighted(name: string, options: SrOptions, useVectors: boolean): Algorithm {
	return {
		name,
		needsEmbeddings: useVectors && (options.weights.sem > 0 || options.weights.proto > 0 || (options.weights.prev ?? 0) > 0),
		score: ({ utterance, candidates }, env) => {
			const w = { ...options.weights };
			if (!useVectors) {
				w.sem = 0;
				w.proto = 0;
			}
			const tools = candidates.filter((c) => c.id !== CONVERSATION_ID);
			const lexNow = unit(env.fts(utterance.text));
			const lexCtx =
				options.context > 0 && utterance.previousUser
					? unit(env.fts(utterance.previousUser))
					: new Map<string, number>();
			const sem = new Map<string, number>();
			const proto = new Map<string, number>();
			if (w.sem > 0 || w.proto > 0) {
				const q = env.vector(utterance.text);
				for (const c of tools) {
					const sims = c.passages.map((p) => dot(q, env.vector(p))).sort((a, b) => b - a);
					if (!sims.length) continue;
					sem.set(c.id, sims[0]!);
					const top = sims.slice(0, options.protoM);
					proto.set(
						c.id,
						options.protoW * sims[0]! +
							(1 - options.protoW) * (top.reduce((s, v) => s + v, 0) / top.length),
					);
				}
			}
			// Cosines live in a narrow band: rescale to 0..1 within the candidates.
			const band = (m: Map<string, number>) => {
				const vals = [...m.values()];
				const lo = Math.min(...vals);
				const hi = Math.max(...vals);
				return new Map([...m].map(([k, v]) => [k, hi > lo ? (v - lo) / (hi - lo) : 0]));
			};
			const semU = band(sem);
			const protoU = band(proto);
			// Previous-turn carry (no past production choices): how well the previous user
			// turn matches each card, as a band-normalized prototype score.
			const prevU = new Map<string, number>();
			const prevOn =
				(w.prev ?? 0) > 0 &&
				!!utterance.previousUser &&
				(options.prevGate === "always" || isContextual(utterance.text));
			if (!prevOn) w.prev = 0;
			if (prevOn) {
				const q = env.vector(utterance.previousUser!);
				const m = new Map<string, number>();
				for (const c of tools) {
					const sims = c.passages.map((p) => dot(q, env.vector(p))).sort((a, b) => b - a);
					if (sims.length) m.set(c.id, sims[0]!);
				}
				for (const [k, v] of band(m)) prevU.set(k, v);
			}
			const grams = bigrams(utterance.text);
			const prev = env.history?.previous(utterance.id) ?? null;
			const kind = utterance.hints.referencedResource?.kind ?? null;
			// The previous-turn feature is an additive bonus: it does not dilute the other features.
			const total = Object.entries(w).reduce((s, [k, v]) => (k === "prev" ? s : s + v), 0) || 1;
			const out = new Map<string, number>();
			for (const c of tools) {
				const lex = Math.max(lexNow.get(c.id) ?? 0, options.context * (lexCtx.get(c.id) ?? 0));
				const text = env.cardText?.get(c.id);
				let nameHit = 0;
				if (text) {
					const tg = bigrams(text.title);
					let hit = 0;
					for (const g of tg) if (grams.has(g)) hit++;
					nameHit = tg.size ? hit / tg.size : 0;
				}
				let hist = 0.5;
				if (prev && env.history) {
					const t = env.history.transition(utterance.id, prev, c.id);
					hist = t.from > 0 && t.pair > 0 ? t.pair / t.from : prev === c.id ? 0.12 : 0.62;
				}
				let prior = 0;
				if (kind && text) {
					const words = RESOURCE_WORDS[kind] ?? [kind];
					prior = words.some((x) => text.summary.includes(x) || text.title.includes(x)) ? 1 : 0;
				}
				const f =
					w.sem * (semU.get(c.id) ?? 0) +
					w.lex * lex +
					w.proto * (protoU.get(c.id) ?? 0) +
					w.name * nameHit +
					w.hist * hist +
					w.prior * prior +
					(w.prev ?? 0) * (prevU.get(c.id) ?? 0);
				out.set(c.id, f / total);
			}
			if (candidates.some((c) => c.id === CONVERSATION_ID)) out.set(CONVERSATION_ID, options.minCombined);
			return out;
		},
	};
}

const CONVERSATION_ID = "conversation.respond";

export const ALGORITHMS: Record<string, Algorithm> = {
	fts,
	embed,
	hybrid,
	past,
	"recorded-embed": recordedEmbed,
	"sr-weighted": srWeighted("sr-weighted", SR_DEFAULTS, true),
	"sr-weighted-noembed": srWeighted("sr-weighted-noembed", SR_DEFAULTS, false),
	"sr-weighted-nohist": srWeighted(
		"sr-weighted-nohist",
		{ ...SR_DEFAULTS, weights: { ...SR_DEFAULTS.weights, hist: 0 } },
		true,
	),
	"sr-weighted-noproto": srWeighted(
		"sr-weighted-noproto",
		{ ...SR_DEFAULTS, weights: { ...SR_DEFAULTS.weights, proto: 0 } },
		true,
	),
};

/** Register a tuned variant (from `run --sr <json>`). */
export function registerSr(name: string, options: SrOptions, useVectors: boolean) {
	ALGORITHMS[name] = srWeighted(name, options, useVectors);
}
