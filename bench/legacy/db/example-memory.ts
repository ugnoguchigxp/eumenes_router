import { decodeVectors, encodeVectors } from "../scoring/memory-vectors.ts";
import type { RouterDb } from "../../../src/db/connection.ts";
import {
	BEST_V2_MEMORY_FORMAT,
	invalidModel,
	validLabels,
	type BestV2Memory,
} from "../scoring/best-v2.ts";
import {
	assertVector,
	packVector,
	vectorSpaceKey,
	type VectorSpace,
} from "../../../src/vector.ts";

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
		throw new Error(invalidModel);
	const vectors = decodeVectors(
		memory.vectors,
		memory.labels.length,
		space.dimension,
	);
	if (!vectors) throw new Error(invalidModel);
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
