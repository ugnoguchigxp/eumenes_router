import type { Impact } from "../contracts/cards.ts";
import { trigramQuery, type SrCard } from "../retrieval/sr.ts";
import { unpackVector, vectorSpaceKey, type VectorSpace } from "../vector.ts";
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

/** A synced card as the router reads it: the search inputs and the fields used by the routing decision. */
export type RouterCard = SrCard & {
	revision: string;
	impact: Impact;
	useWhen: string[];
	examples: string[];
};

/** The enabled, available cards with their passage vectors in the space (sr-corr's candidates). */
export function srCardsInTransaction(
	db: RouterDb,
	input: { space: VectorSpace; available: (id: string) => boolean },
): RouterCard[] {
	const key = vectorSpaceKey(input.space);
	const cards = (
		db
			.query(
				"SELECT id, revision, kind, title, summary, use_when_json, examples_json, impact FROM router_cards WHERE enabled=1 ORDER BY id",
			)
			.all() as Array<{
			id: string;
			revision: string;
			kind: SrCard["kind"];
			title: string;
			summary: string;
			use_when_json: string;
			examples_json: string;
			impact: Impact;
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
		revision: card.revision,
		kind: card.kind,
		title: card.title,
		summary: card.summary,
		useWhen: JSON.parse(card.use_when_json) as string[],
		examples: JSON.parse(card.examples_json) as string[],
		impact: card.impact,
		passages: vectors.get(card.id) ?? [],
	}));
}
