import { routerErrors } from "../contracts/errors.ts";
import { CONVERSATION_ID } from "../decision/decide.ts";
import { dot, unpackVector } from "../vector.ts";

/**
 * best-v2, the main decision's scorer. The candidates are the retrieval's top
 * tools that have a reranker score, plus the conversation. Each gets features
 * from the retrieval, the reranker, their fusion and the labeled-example memory
 * (kNN); a standardized logistic ranker gives it a probability, and the gap of
 * the top two decides whether to defer. Pure: no database, clock, randomness,
 * network or model. The numbers are those of
 * `bench/router/experiments/best/best_v2.py predict`.
 */

/** The ranker's inputs, in order. The table features stay 0 (not used). */
export const BEST_V2_FEATURES = [
	"sr_p",
	"sr_rank",
	"sr_score",
	"rr",
	"rr_rank",
	"rr_gap",
	"fused_p",
	"fused_rank",
	"is_conv",
	"knn",
	"tbl",
	"tbl_hit",
] as const;

export const BEST_V2_FORMAT = "best-v2.v1";
export const BEST_V2_MEMORY_FORMAT = "best-v2-memory.v1";

/**
 * The trained numbers, shipped in the package (`best-v2.params.ts`, written by
 * `best_v2.py export-package`). Nothing in them comes from an utterance.
 */
export type BestV2Params = {
	format: typeof BEST_V2_FORMAT;
	version: string;
	/** Digest of the bench artifact it came from; the memory must carry the same. */
	source: string;
	features: readonly string[];
	ranker: {
		mean: readonly number[];
		scale: readonly number[];
		coef: readonly number[];
		intercept: number;
	};
	gate: { deferBelow: number };
	/** Fusion: softmax of retrieval p + weight·rerank, the conversation at a fixed offset, over the top retrieved. */
	fuse: { weight: number; conversation: number; top: number };
	knn: { neighbors: number; dimension: number };
};

/**
 * The labeled-example memory the ranker was trained with. The host keeps it
 * (it is made from utterances) and passes it in; it is not in the package.
 * One label per vector; vectors are float32 little-endian, base64.
 */
export type BestV2Memory = {
	format: typeof BEST_V2_MEMORY_FORMAT;
	source: string;
	dimension: number;
	labels: readonly string[];
	vectors: string;
};

export type BestV2Model = {
	params: BestV2Params;
	labels: readonly string[];
	memory: readonly Float32Array[];
};

export type BestV2Input = {
	/** The retrieval's candidates and probabilities, the conversation included. */
	retrieval: ReadonlyArray<readonly [string, number]>;
	/** The retrieval's raw scores by candidate. */
	retrievalScores: Readonly<Record<string, number>>;
	/** The reranker's score by retrieved tool. A tool without one is not offered. */
	rerank: Readonly<Record<string, number>>;
	/** The utterance in the memory's embedding space, normalized. */
	vector: ArrayLike<number>;
};

export type BestV2Result = {
	/** The offer, by probability. */
	ranked: Array<{ id: string; p: number }>;
	/** The top probability minus the second. */
	gate: number;
	defer: boolean;
};

const invalid = () => new Error(routerErrors.invalidModel);
const finite = (xs: readonly number[]) => xs.every(Number.isFinite);

export function loadBestV2(
	params: BestV2Params,
	memory: BestV2Memory,
): BestV2Model {
	const a = params;
	const n = BEST_V2_FEATURES.length;
	if (
		a?.format !== BEST_V2_FORMAT ||
		a.features.length !== n ||
		a.features.some((name, i) => name !== BEST_V2_FEATURES[i])
	)
		throw invalid();
	const { mean, scale, coef, intercept } = a.ranker;
	if (
		[mean, scale, coef].some((v) => v.length !== n || !finite(v)) ||
		scale.some((v) => v === 0) ||
		!finite([intercept, a.gate.deferBelow, a.fuse.weight, a.fuse.conversation])
	)
		throw invalid();
	const { neighbors, dimension } = a.knn;
	if (
		!Number.isInteger(a.fuse.top) ||
		a.fuse.top <= 0 ||
		!Number.isInteger(neighbors) ||
		neighbors <= 0 ||
		!Number.isInteger(dimension) ||
		dimension <= 0
	)
		throw invalid();
	// The kNN feature was learned with this memory: another one changes the scores.
	if (
		memory?.format !== BEST_V2_MEMORY_FORMAT ||
		memory.source !== a.source ||
		memory.dimension !== dimension
	)
		throw invalid();
	const bytes = Uint8Array.from(atob(memory.vectors), (c) => c.charCodeAt(0));
	if (bytes.byteLength !== memory.labels.length * dimension * 4)
		throw invalid();
	const all = unpackVector(bytes);
	return {
		params: a,
		labels: memory.labels,
		memory: memory.labels.map((_, i) =>
			all.subarray(i * dimension, (i + 1) * dimension),
		),
	};
}

export function scoreBestV2(
	model: BestV2Model,
	input: BestV2Input,
): BestV2Result {
	const a = model.params;
	const conv = CONVERSATION_ID;
	if (input.vector.length !== a.knn.dimension)
		throw new Error(routerErrors.invalidEmbedding);
	const retrieved = [...input.retrieval]
		.sort((x, y) => y[1] - x[1])
		.slice(0, a.fuse.top);
	const sr = new Map(retrieved.map(([id, p]) => [id, p]));
	const order = retrieved.map(([id]) => id);
	const rerank = new Map<string, number>();
	for (const id of order)
		if (id !== conv && Object.hasOwn(input.rerank, id))
			rerank.set(id, input.rerank[id]!);
	// Fusion over the offer: retrieved tools with a rerank score, then the conversation.
	const ids = order.filter((id) => id !== conv && rerank.has(id));
	ids.push(conv);
	const comb = ids.map(
		(id) =>
			(sr.get(id) ?? 0) +
			(id === conv
				? a.fuse.conversation + a.fuse.weight * (rerank.get(conv) ?? 0)
				: a.fuse.weight * rerank.get(id)!),
	);
	const top = Math.max(...comb);
	const exp = comb.map((v) => Math.exp(v - top));
	const total = exp.reduce((sum, v) => sum + v, 0);
	const fused = ids
		.map((id, i) => ({ id, p: exp[i]! / total }))
		.sort((x, y) => y.p - x.p);
	// Labeled-example memory: similarity-weighted votes of the nearest examples.
	const sims = model.memory.map((v) => dot(v, input.vector));
	const nearest = sims
		.map((_, j) => j)
		.sort((i, j) => sims[j]! - sims[i]!)
		.slice(0, a.knn.neighbors);
	const votes = new Map<string, number>();
	for (const j of nearest) {
		const label = model.labels[j]!;
		votes.set(label, (votes.get(label) ?? 0) + sims[j]!);
	}
	const most = votes.size ? Math.max(...votes.values()) : 1;
	const scores = [...rerank.values()].sort((x, y) => y - x);
	const { mean, scale, coef, intercept } = a.ranker;
	const ranked = fused
		.map(({ id, p }, i) => {
			const r = rerank.get(id) ?? 0;
			const at = scores.indexOf(r);
			const f = [
				sr.get(id) ?? 0,
				order.includes(id) ? order.indexOf(id) : 9,
				input.retrievalScores[id] ?? 0,
				r,
				at >= 0 ? at : 9,
				r - (scores[0] ?? 0),
				p,
				i,
				id === conv ? 1 : 0,
				most ? (votes.get(id) ?? 0) / most : 0,
				0,
				0,
			];
			let z = 0;
			for (let k = 0; k < f.length; k++)
				z += ((f[k]! - mean[k]!) / scale[k]!) * coef[k]!;
			return { id, p: 1 / (1 + Math.exp(-(z + intercept))) };
		})
		.sort((x, y) => y.p - x.p);
	const gate = ranked[0]!.p - (ranked[1]?.p ?? -9);
	return { ranked, gate, defer: gate < a.gate.deferBelow };
}
