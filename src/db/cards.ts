import { parseCard, type Card, type Passage } from "../contracts/cards.ts";
import { routerErrors } from "../contracts/errors.ts";
import { sha256Hex } from "../digest.ts";
import type { Candidate, CandidateQuery } from "../route.ts";
import { cardPassages } from "../retrieval/passages.ts";
import {
	CANDIDATE_SLOTS,
	closestSimilarities,
	rankBy,
	ROUTER_SLOTS,
	slotKind,
	slotted,
	type IndexedPassage,
} from "../retrieval/rank.ts";
import {
	assertVector,
	packVector,
	unpackVector,
	vectorSpaceKey,
} from "../vector.ts";
import type { VectorSpace } from "../vector.ts";
import type { RouterDb } from "./connection.ts";

type CardRow = {
	id: string;
	revision: string;
	kind: Candidate["kind"];
	title: string;
	summary: string;
	use_when_json: string;
	impact: Candidate["impact"];
};

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
	}
	const pending: Passage[] = [];
	for (const card of normalized) {
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

/** The router's frame (or the narrower choice frame) for one query vector. */
export function candidatesInTransaction(
	db: RouterDb,
	input: CandidateQuery,
): Candidate[] {
	assertVector(input.vector.space, input.vector.values);
	const key = vectorSpaceKey(input.vector.space);
	const cards = (
		db
			.query(
				`SELECT id, revision, kind, title, summary, use_when_json, impact
 FROM router_cards WHERE enabled=1 ORDER BY id`,
			)
			.all() as CardRow[]
	).filter((card) => input.available(card.id));
	const active = new Set(cards.map((card) => card.id));
	const passages: IndexedPassage[] = (
		db
			.query("SELECT card_id, vector FROM router_passages WHERE space=?")
			.all(key) as Array<{ card_id: string; vector: Uint8Array }>
	).flatMap((row) => {
		if (!active.has(row.card_id)) return [];
		return [{ id: row.card_id, values: unpackVector(row.vector) }];
	});
	const similarity = closestSimilarities(passages, input.vector.values, active);
	const history = new Set(input.fromHistory ?? []);
	const slots = input.slots === "choice" ? CANDIDATE_SLOTS : ROUTER_SLOTS;
	const chosen = similarity.size
		? slotted(
				rankBy(cards, similarity),
				(card) => similarity.get(card.id)!,
				(card) => slotKind(card.kind),
				slots,
			)
		: input.strict
			? []
			: cards.filter((card) => card.kind !== "read");
	const inFrame = new Set(chosen.map((card) => card.id));
	const include = new Set(input.include ?? []);
	const offered = [
		...chosen,
		...cards.filter((card) => include.has(card.id) && !inFrame.has(card.id)),
	];
	return offered.map((card, index) =>
		toCandidate(
			card,
			index + 1,
			similarity.get(card.id) ?? null,
			history.has(card.id),
		),
	);
}

function toCandidate(
	card: CardRow,
	rank: number,
	similarity: number | null,
	fromHistory: boolean,
): Candidate {
	return {
		id: card.id,
		revision: card.revision,
		kind: card.kind,
		title: card.title,
		summary: card.summary,
		useWhen: JSON.parse(card.use_when_json) as string[],
		impact: card.impact,
		similarity,
		rank,
		ftsRank: null,
		fromHistory,
	};
}
