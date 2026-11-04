import { parseCard, type Card, type Passage } from "../contracts/cards.ts";
import { routerErrors } from "../contracts/errors.ts";
import { sha256Hex } from "../digest.ts";
import { cardPassages } from "../retrieval/passages.ts";
import { assertVector, packVector, vectorSpaceKey } from "../vector.ts";
import type { VectorSpace } from "../vector.ts";
import type { RouterDb } from "./connection.ts";

/**
 * Upserts the published cards and returns the passages whose stored vector, in `space`,
 * is missing or was stored for different text. Learning does not run here.
 * Cards absent from the list are disabled and leave the index.
 */
export function syncCardsInTransaction(
	db: RouterDb,
	cards: readonly Card[],
	space: VectorSpace,
): { pending: Passage[] } {
	assertVector(space, empty(space.dimension));
	const key = vectorSpaceKey(space);
	const seen = new Set<string>();
	const normalized: Card[] = [];
	for (const card of cards) {
		const ready = parseCard(card);
		if (seen.has(ready.id)) throw new Error(routerErrors.invalidCard);
		seen.add(ready.id);
		normalized.push(ready);
	}
	const existing = db.query("SELECT id FROM router_cards").all() as Array<{
		id: string;
	}>;
	for (const row of existing) {
		if (seen.has(row.id)) continue;
		db.query("UPDATE router_cards SET enabled=0 WHERE id=?").run(row.id);
		db.query("DELETE FROM router_passages WHERE card_id=?").run(row.id);
		db.query("DELETE FROM router_passages_fts WHERE card_id=?").run(row.id);
	}
	const pending: Passage[] = [];
	const previous = db.query(
		"SELECT digest, enabled FROM router_cards WHERE id=?",
	);
	for (const card of normalized) {
		const before = previous.get(card.id) as {
			digest: string;
			enabled: number;
		} | null;
		// The digest covers every field the passages come from: an unchanged, enabled card keeps its lexical rows.
		const unchanged = before?.enabled === 1 && before.digest === card.digest;
		db.query(
			`INSERT INTO router_cards(
 id, revision, kind, title, summary, use_when_json, examples_json, impact, digest, enabled
) VALUES (?,?,?,?,?,?,?,?,?,1)
ON CONFLICT(id) DO UPDATE SET
 revision=excluded.revision, kind=excluded.kind, title=excluded.title, summary=excluded.summary,
 use_when_json=excluded.use_when_json, examples_json=excluded.examples_json,
 impact=excluded.impact, digest=excluded.digest, enabled=1`,
		).run(
			card.id,
			card.revision,
			card.kind,
			card.title,
			card.summary,
			JSON.stringify(card.useWhen),
			JSON.stringify(card.examples),
			card.impact,
			card.digest,
		);
		const texts = cardPassages(card);
		db.query("DELETE FROM router_passages WHERE card_id=? AND item>=?").run(
			card.id,
			texts.length,
		);
		// The lexical index: one row per passage, as the retrieval was trained on.
		if (!unchanged) {
			db.query("DELETE FROM router_passages_fts WHERE card_id=?").run(card.id);
			for (const text of texts)
				db.query(
					"INSERT INTO router_passages_fts(card_id, text) VALUES (?,?)",
				).run(card.id, text);
		}
		for (let item = 0; item < texts.length; item++) {
			const text = texts[item]!;
			const digest = sha256Hex(text);
			const stored = db
				.query(
					"SELECT space, text_digest, revision FROM router_passages WHERE card_id=? AND item=?",
				)
				.all(card.id, item) as Array<{
				space: string;
				text_digest: string;
				revision: string;
			}>;
			for (const row of stored)
				if (row.text_digest !== digest)
					db.query(
						"DELETE FROM router_passages WHERE card_id=? AND item=? AND space=?",
					).run(card.id, item, row.space);
			const kept = db
				.query(
					"SELECT revision FROM router_passages WHERE card_id=? AND item=? AND space=?",
				)
				.get(card.id, item, key) as { revision: string } | null;
			if (!kept)
				pending.push({ id: card.id, revision: card.revision, item, text });
			else if (kept.revision !== card.revision)
				db.query(
					"UPDATE router_passages SET revision=? WHERE card_id=? AND item=? AND space=?",
				).run(card.revision, card.id, item, key);
		}
	}
	return { pending };
}

function empty(dimension: number): number[] {
	return Array.from({ length: dimension }, () => 0);
}

export type VectorRow = {
	id: string;
	revision: string;
	item: number;
	text: string;
	vector: readonly number[];
};

/**
 * Stores vectors for passages that still have the same text. A passage whose text
 * changed since it was listed is skipped; the next sync lists it again.
 */
export function saveVectorsInTransaction(
	db: RouterDb,
	space: VectorSpace,
	rows: readonly VectorRow[],
): void {
	assertVector(space, empty(space.dimension));
	const key = vectorSpaceKey(space);
	for (const row of rows) {
		assertVector(space, row.vector);
		const card = db
			.query(
				"SELECT revision, title, summary, use_when_json, examples_json FROM router_cards WHERE id=? AND enabled=1",
			)
			.get(row.id) as {
			revision: string;
			title: string;
			summary: string;
			use_when_json: string;
			examples_json: string;
		} | null;
		if (!card || card.revision !== row.revision) continue;
		const texts = cardPassages({
			title: card.title,
			summary: card.summary,
			useWhen: JSON.parse(card.use_when_json) as string[],
			examples: JSON.parse(card.examples_json) as string[],
		});
		if (texts[row.item] !== row.text) continue;
		db.query(
			`INSERT INTO router_passages(card_id, revision, item, space, text_digest, vector)
 VALUES (?,?,?,?,?,?)
 ON CONFLICT(card_id, item, space) DO UPDATE SET
 revision=excluded.revision, text_digest=excluded.text_digest, vector=excluded.vector`,
		).run(
			row.id,
			row.revision,
			row.item,
			key,
			sha256Hex(row.text),
			packVector(row.vector),
		);
	}
}
