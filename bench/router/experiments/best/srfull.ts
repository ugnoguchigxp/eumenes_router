/**
 * sr-corr's ranking over every available card for each labeled utterance, through the package's own functions
 * (the same path as test/best-v2-pipeline.test.ts), for best_v2.py candidates beyond the sr top-8.
 *   bun bench/router/experiments/best/srfull.ts <corr dir> <embedding cache key> <out.json>
 * Output: {utterance id: [[card id, score / best score], …]} in rank order after the kind slots, conversation left out.
 * Ids and numbers only.
 */
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import {
	CONVERSATION_ID,
	capByKind,
	unpackVector,
	type Card,
	type VectorSpace,
} from "../../../../src/index.ts";
import { srRanking, srScores } from "../../../legacy/retrieval/sr.ts";
import { sha256Hex } from "../../../../src/digest.ts";
import {
	lexicalInTransaction,
	migrations,
	saveVectorsInTransaction,
	srCardsInTransaction,
	syncCardsInTransaction,
} from "../../../../src/sqlite.ts";

const [corr, model, out] = Bun.argv.slice(2);
if (!corr || !model || !out)
	throw new Error(
		"usage: srfull.ts <corr dir> <embedding cache key> <out.json>",
	);
const bench = new Database(`${corr}/corr.db`);
const space: VectorSpace = {
	modelId: model,
	revision: "bench",
	artifactDigest: "bench",
	dimension: 384,
};
const vector = (text: string) => {
	const row = bench
		.query("SELECT vector FROM bench_embeddings WHERE model=? AND text_hash=?")
		.get(model, sha256Hex(text)) as { vector: Uint8Array } | null;
	if (!row) throw new Error("no vector for a text");
	return Array.from(unpackVector(row.vector));
};
const cards = (
	bench.query("SELECT card_json FROM bench_cards ORDER BY id").all() as Array<{
		card_json: string;
	}>
).map((r) => JSON.parse(r.card_json) as Card);
const kindOf = new Map(cards.map((c) => [c.id, c.kind]));
const db = new Database(":memory:");
for (const sql of migrations) db.exec(sql);
const { pending } = syncCardsInTransaction(db, cards, space);
saveVectorsInTransaction(
	db,
	space,
	pending.map((p) => ({ ...p, vector: vector(p.text) })),
);
type Hints = {
	referencedResource?: { kind?: string };
	availableToolchainIds?: string[];
};
const labeled = new Set(
	(
		bench.query("SELECT utterance_id AS id FROM bench_labels").all() as Array<{
			id: string;
		}>
	).map((r) => r.id),
);
const result: Record<string, Array<[string, number]>> = {};
for (const r of bench
	.query("SELECT id, utterance_json FROM bench_utterances")
	.all() as Array<{ id: string; utterance_json: string }>) {
	if (!labeled.has(r.id)) continue;
	const u = JSON.parse(r.utterance_json) as { text: string; hints?: Hints };
	const list = u.hints?.availableToolchainIds;
	const pool = srCardsInTransaction(db, {
		space,
		available: (id) => !list || id === CONVERSATION_ID || list.includes(id),
	});
	const scores = srScores({
		vector: vector(u.text),
		cards: pool,
		lexical: lexicalInTransaction(db, u.text),
		resource: u.hints?.referencedResource?.kind ?? null,
		conversation: true,
	});
	result[r.id] = srRanking(scores, (ranked) =>
		capByKind(ranked, (id: string) => kindOf.get(id)),
	);
}
writeFileSync(out, JSON.stringify(result));
console.log(JSON.stringify({ utterances: Object.keys(result).length }));
