import { routerErrors } from "../contracts/errors.ts";
import { trigramQuery, type SrCard } from "../retrieval/sr.ts";
import {
	BEST_V2_MEMORY_FORMAT,
	validLabels,
	type BestV2Memory,
} from "../scoring/best-v2.ts";
import {
	assertVector,
	decodeVectors,
	encodeVectors,
	packVector,
	unpackVector,
	vectorSpaceKey,
	type VectorSpace,
} from "../vector.ts";
import type { RouterDb } from "./connection.ts";

/** The best −bm25 of each card over the lexical index of every synced card (sr-corr's lexical feature). */
export function lexicalInTransaction(
	db: RouterDb,
	text: string,
): Map<string, number> {
	const out = new Map<string, number>();
	const q = trigramQuery(text);
	if (!q) return out;
	const rows = db
		.query(
			"SELECT card_id AS id, bm25(router_passages_fts) AS s FROM router_passages_fts WHERE router_passages_fts MATCH ?",
		)
		.all(q) as Array<{ id: string; s: number }>;
	for (const row of rows) {
		const value = -row.s;
		if (value > (out.get(row.id) ?? Number.NEGATIVE_INFINITY))
			out.set(row.id, value);
	}
	return out;
}

/** The enabled, available cards with their passage vectors in the space (sr-corr's candidates). */
export function srCardsInTransaction(
	db: RouterDb,
	input: { space: VectorSpace; available: (id: string) => boolean },
): SrCard[] {
	const key = vectorSpaceKey(input.space);
	const cards = (
		db
			.query(
				"SELECT id, kind, title, summary FROM router_cards WHERE enabled=1 ORDER BY id",
			)
			.all() as Array<{
			id: string;
			kind: SrCard["kind"];
			title: string;
			summary: string;
		}>
	).filter((card) => input.available(card.id));
	const vectors = new Map<string, Float32Array[]>();
	for (const row of db
		.query(
			"SELECT card_id, vector FROM router_passages WHERE space=? ORDER BY card_id, item",
		)
		.all(key) as Array<{ card_id: string; vector: Uint8Array }>) {
		const list = vectors.get(row.card_id) ?? [];
		list.push(unpackVector(row.vector));
		vectors.set(row.card_id, list);
	}
	return cards.map((card) => ({
		id: card.id,
		kind: card.kind,
		title: card.title,
		summary: card.summary,
		passages: vectors.get(card.id) ?? [],
	}));
}

/** Stores the labeled-example memory best-v2 was trained with, replacing that source's rows in the space. */
export function importExamplesInTransaction(
	db: RouterDb,
	memory: BestV2Memory,
	space: VectorSpace,
): number {
	// Everything is checked before the old rows go.
	if (
		memory?.format !== BEST_V2_MEMORY_FORMAT ||
		memory.dimension !== space.dimension ||
		typeof memory.source !== "string" ||
		!memory.source ||
		!validLabels(memory.labels)
	)
		throw new Error(routerErrors.invalidModel);
	const vectors = decodeVectors(
		memory.vectors,
		memory.labels.length,
		space.dimension,
	);
	if (!vectors) throw new Error(routerErrors.invalidModel);
	for (const vector of vectors) assertVector(space, Array.from(vector));
	const key = vectorSpaceKey(space);
	db.query("DELETE FROM router_examples WHERE source=? AND space=?").run(
		memory.source,
		key,
	);
	memory.labels.forEach((label, item) =>
		db
			.query(
				"INSERT INTO router_examples(source, space, item, label, vector) VALUES (?,?,?,?,?)",
			)
			.run(
				memory.source,
				key,
				item,
				label,
				packVector(Array.from(vectors[item]!)),
			),
	);
	return memory.labels.length;
}

/** The stored memory of a source in the space, in the form loadBestV2 takes; null when there is none. */
export function examplesInTransaction(
	db: RouterDb,
	input: { source: string; space: VectorSpace },
): BestV2Memory | null {
	const rows = db
		.query(
			"SELECT label, vector FROM router_examples WHERE source=? AND space=? ORDER BY item",
		)
		.all(input.source, vectorSpaceKey(input.space)) as Array<{
		label: string;
		vector: Uint8Array;
	}>;
	if (!rows.length) return null;
	return {
		format: BEST_V2_MEMORY_FORMAT,
		source: input.source,
		dimension: input.space.dimension,
		labels: rows.map((row) => row.label),
		vectors: encodeVectors(rows.map((row) => new Uint8Array(row.vector))),
	};
}
