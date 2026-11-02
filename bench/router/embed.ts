/**
 * Embedding providers and the vector cache. A provider is an HTTP server the user
 * runs (OpenAI-compatible `/v1/embeddings`), or the deterministic `fake` provider for
 * tests. The bench never starts a server. Vectors are L2-normalized before they are
 * cached, so the inner product is the cosine.
 */
import type { Database } from "bun:sqlite";
import { packVector, unpackVector } from "../../src/index.ts";
import { sha256Hex } from "../../src/digest.ts";

export type EmbedProvider = {
	/** The cache key's model part. Two providers with the same name must give the same vectors. */
	model: string;
	embed: (texts: readonly string[]) => Promise<number[][]>;
};

function normalized(values: readonly number[]): number[] {
	const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
	return norm > 0 ? values.map((v) => v / norm) : values.map(() => 0);
}

/**
 * Hashed character 1–3-grams in `dimension` buckets. No model, no network: a fixed
 * function of the text, for tests and for runs on the example data only.
 */
export function fakeProvider(dimension = 256): EmbedProvider {
	return {
		model: `fake-ngram-${dimension}`,
		embed: async (texts) =>
			texts.map((text) => {
				const v = Array.from({ length: dimension }, () => 0);
				const chars = [
					...text.normalize("NFKC").toLowerCase().replace(/\s+/g, ""),
				];
				for (let n = 1; n <= 3; n++)
					for (let i = 0; i + n <= chars.length; i++) {
						const gram = chars.slice(i, i + n).join("");
						const h = parseInt(sha256Hex(gram).slice(0, 8), 16);
						v[h % dimension]! += n;
					}
				return v;
			}),
	};
}

/** An OpenAI-compatible server: POST `${baseUrl}/v1/embeddings` with `{ model, input }`. */
export function httpProvider(options: {
	baseUrl: string;
	model: string;
	batch?: number;
	fetch?: typeof fetch;
}): EmbedProvider {
	const call = options.fetch ?? fetch;
	const batch = options.batch ?? 32;
	const url = `${options.baseUrl.replace(/\/+$/, "")}/v1/embeddings`;
	return {
		model: options.model,
		embed: async (texts) => {
			const out: number[][] = [];
			for (let i = 0; i < texts.length; i += batch) {
				const input = texts.slice(i, i + batch);
				const response = await call(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: options.model, input }),
				});
				if (!response.ok)
					throw new Error(`embedding_http_${response.status}: ${url}`);
				const body = (await response.json()) as {
					data?: Array<{ index?: number; embedding?: number[] }>;
				};
				const data = [...(body.data ?? [])].sort(
					(a, b) => (a.index ?? 0) - (b.index ?? 0),
				);
				if (
					data.length !== input.length ||
					data.some((d) => !Array.isArray(d.embedding))
				)
					throw new Error("embedding_invalid_response");
				for (const d of data) out.push(d.embedding!);
			}
			return out;
		},
	};
}

export const textHash = (text: string) => sha256Hex(text);

/** Embeds the texts the cache lacks for `provider.model`; returns how many were new. */
export async function fillCache(
	db: Database,
	provider: EmbedProvider,
	texts: readonly string[],
): Promise<{ total: number; added: number }> {
	const unique = [...new Set(texts)];
	const has = db.query(
		"SELECT 1 FROM bench_embeddings WHERE model=? AND text_hash=?",
	);
	const missing = unique.filter((t) => !has.get(provider.model, textHash(t)));
	if (missing.length) {
		const vectors = await provider.embed(missing);
		if (vectors.length !== missing.length)
			throw new Error("embedding_count_mismatch");
		const dim = vectors[0]!.length;
		db.transaction(() => {
			missing.forEach((text, i) => {
				const v = vectors[i]!;
				if (v.length !== dim) throw new Error("embedding_dimension_mismatch");
				db.query(
					"INSERT INTO bench_embeddings(model, text_hash, dimension, vector) VALUES (?,?,?,?)",
				).run(provider.model, textHash(text), dim, packVector(normalized(v)));
			});
		})();
	}
	return { total: unique.length, added: missing.length };
}

/** A synchronous lookup into the cache; a text that was not embedded is an error. */
export function cachedVectors(db: Database, model: string) {
	const get = db.query(
		"SELECT vector FROM bench_embeddings WHERE model=? AND text_hash=?",
	);
	const memo = new Map<string, Float32Array>();
	return (text: string): Float32Array => {
		const key = textHash(text);
		const had = memo.get(key);
		if (had) return had;
		const row = get.get(model, key) as { vector: Uint8Array } | null;
		if (!row)
			throw new Error(
				`embedding_not_cached: run \`router embed\` first (${model})`,
			);
		const v = unpackVector(row.vector);
		memo.set(key, v);
		return v;
	};
}
