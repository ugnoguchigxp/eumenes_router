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

export const ALGORITHMS: Record<string, Algorithm> = { fts, embed, hybrid };
