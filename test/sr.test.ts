import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	CONVERSATION_ID,
	capByKind,
	trigramQuery,
	unpackVector,
	type Card,
	type VectorSpace,
} from "../src/index.ts";
import { SR, srOffer, srScores } from "../bench/legacy/retrieval/sr.ts";
import { sha256Hex } from "../src/digest.ts";
import { cardDigest } from "../src/index.ts";
import {
	lexicalInTransaction,
	migrations,
	saveVectorsInTransaction,
	srCardsInTransaction,
	syncCardsInTransaction,
} from "../src/sqlite.ts";

function cardOf(id: string, summary: string): Card {
	const body = {
		id,
		revision: `rev-${id}-${summary}`,
		kind: "dedicated" as const,
		title: id,
		summary,
		useWhen: ["使う"],
		examples: ["例"],
		impact: "none" as const,
	};
	return { ...body, digest: cardDigest(body) };
}

test("trigrams of the normalized text, quoted, as an OR query", () => {
	expect(trigramQuery("天気 予報")).toBe('"天気予" OR "気予報"');
	expect(trigramQuery("あい")).toBeNull();
	// A double quote inside a trigram is doubled: a"b -> "a""b", "bc -> """bc".
	expect(trigramQuery('a"bc')).toBe(['"a""b"', '"""bc"'].join(" OR "));
});

test("the four features average, the conversation is fixed, the offer always has it", () => {
	const cards = [
		{
			id: "music.create",
			kind: "dedicated" as const,
			title: "作曲",
			summary: "曲を作る",
			passages: [[1, 0]],
		},
		{
			id: "image.create",
			kind: "dedicated" as const,
			title: "画像",
			summary: "画像を作る",
			passages: [[0, 1]],
		},
		{
			id: CONVERSATION_ID,
			kind: "general" as const,
			title: "会話",
			summary: "話す",
			passages: [[1, 0]],
		},
	];
	const scores = srScores({
		vector: [1, 0],
		cards,
		lexical: new Map([
			["music.create", 4],
			["image.create", 2],
		]),
		resource: "image",
		conversation: true,
	});
	// music: meaning 1, lexical 1, prototype 1, prior 0; image: 0, 0.5, 0, 1 (the resource word is on the card)
	expect(scores.get("music.create")).toBeCloseTo(3 / 4, 12);
	expect(scores.get("image.create")).toBeCloseTo(1.5 / 4, 12);
	expect(scores.get(CONVERSATION_ID)).toBe(SR.conversation);
	const offer = srOffer(scores);
	expect(offer.retrieval.map(([id]) => id)).toEqual([
		"music.create",
		CONVERSATION_ID,
		"image.create",
	]);
	expect(offer.scores["music.create"]).toBe(1);
	expect(offer.retrieval.reduce((s, [, p]) => s + p, 0)).toBeCloseTo(1, 5);
	const many = new Map(
		[...Array(9)].map((_, i) => [`t${i}`, 0.9 - i * 0.01] as [string, number]),
	);
	many.set(CONVERSATION_ID, 0.1);
	const capped = srOffer(many).retrieval.map(([id]) => id);
	expect(capped).toHaveLength(SR.offer);
	expect(capped.at(-1)).toBe(CONVERSATION_ID);
});

test("kind slots cap a ranking, read tools in the dedicated slot, the conversation not counted", () => {
	const kinds: Record<string, "dedicated" | "general" | "read" | "pipeline"> = {
		a: "general",
		b: "general",
		c: "read",
		d: "dedicated",
		e: "general",
	};
	const capped = capByKind(
		["a", CONVERSATION_ID, "b", "c", "d", "e"],
		(id) => kinds[id],
		{ dedicated: 1, pipeline: 1, general: 2 },
	);
	expect(capped).toEqual(["a", CONVERSATION_ID, "b", "c"]);
});

// Parity with the bench's sr-corr (bench/router/algorithms.ts srWeighted + SR_CAL, run.ts) on every utterance of the
// evaluation data: the bench's cards and vectors go into a package database, and the package's lexical index,
// candidates and scores must give the bench's predictions to the last rounded digit. The data lives in data/.
const corr = "data/variants-v2/corr";
const parity =
	existsSync(`${corr}/corr.db`) &&
	existsSync(`${corr}/runs/sr-corr-test/predictions.jsonl`);
test.skipIf(!parity)(
	"the package's sr-corr gives the bench's predictions on every utterance",
	() => {
		const bench = new Database(`${corr}/corr.db`);
		// The embedding cache key the records were made with: the one with the most vectors.
		const model = (
			bench
				.query(
					"SELECT model FROM bench_embeddings GROUP BY model ORDER BY count(*) DESC LIMIT 1",
				)
				.get() as { model: string }
		).model;
		const vector = (text: string) => {
			const row = bench
				.query(
					"SELECT vector FROM bench_embeddings WHERE model=? AND text_hash=?",
				)
				.get(model, sha256Hex(text)) as { vector: Uint8Array } | null;
			if (!row)
				throw new Error(
					`no vector for a text (${sha256Hex(text).slice(0, 8)})`,
				);
			return Array.from(unpackVector(row.vector));
		};
		const cards = (
			bench
				.query("SELECT card_json FROM bench_cards ORDER BY id")
				.all() as Array<{ card_json: string }>
		).map((r) => JSON.parse(r.card_json) as Card);
		const space: VectorSpace = {
			modelId: model,
			revision: "bench",
			artifactDigest: "bench",
			dimension: 384,
		};
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
		const utterances = new Map(
			(
				bench
					.query("SELECT id, utterance_json FROM bench_utterances")
					.all() as Array<{ id: string; utterance_json: string }>
			).map((r) => {
				const u = JSON.parse(r.utterance_json) as {
					text: string;
					hints?: Hints;
				};
				return [r.id, { text: u.text, hints: u.hints ?? {} }];
			}),
		);
		let n = 0;
		const wrong: string[] = [];
		for (const split of ["dev", "test"]) {
			for (const line of readFileSync(
				`${corr}/runs/sr-corr-${split}/predictions.jsonl`,
				"utf8",
			)
				.trim()
				.split("\n")) {
				const want = JSON.parse(line) as {
					id: string;
					probabilities: Record<string, number>;
					scores: Record<string, number>;
				};
				const { text: t, hints } = utterances.get(want.id)!;
				const list = hints.availableToolchainIds;
				const pool = srCardsInTransaction(db, {
					space,
					available: (id) =>
						!list || id === CONVERSATION_ID || list.includes(id),
				});
				const got = srOffer(
					srScores({
						vector: vector(t),
						cards: pool,
						lexical: lexicalInTransaction(db, t),
						resource: hints.referencedResource?.kind ?? null,
						conversation: true,
					}),
				);
				n++;
				const ok =
					JSON.stringify(Object.fromEntries(got.retrieval)) ===
						JSON.stringify(want.probabilities) &&
					JSON.stringify(got.scores) === JSON.stringify(want.scores);
				if (!ok) wrong.push(want.id);
			}
		}
		bench.close();
		db.close();
		expect(n).toBeGreaterThan(1500);
		expect(wrong).toEqual([]);
	},
);

test("a NUL in the utterance does not reach the query", () => {
	expect(trigramQuery("天\u0000気予報")).toBe(
		['"天気予"', '"気予報"'].join(" OR "),
	);
});

test("an unchanged card keeps its lexical rows", () => {
	const db = new Database(":memory:");
	for (const sql of migrations) db.exec(sql);
	const space: VectorSpace = {
		modelId: "embed",
		revision: "1",
		artifactDigest: "d",
		dimension: 2,
	};
	const cards = (bench: string) => [
		cardOf("music.create", bench),
		cardOf("image.create", "画像を作る"),
	];
	syncCardsInTransaction(db, cards("曲を作る"), space);
	const rows = () =>
		db
			.query("SELECT rowid, card_id FROM router_passages_fts ORDER BY rowid")
			.all();
	const before = rows();
	syncCardsInTransaction(db, cards("曲を作る"), space);
	expect(rows()).toEqual(before);
	syncCardsInTransaction(db, cards("曲を新しく作る"), space);
	expect(rows()).not.toEqual(before);
	db.close();
});
