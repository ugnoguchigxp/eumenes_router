import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	BEST_V2_PARAMS,
	CONVERSATION_ID,
	capByKind,
	loadBestV2,
	scoreBestV2,
	srOffer,
	srRanking,
	srScores,
	unpackVector,
	type Card,
	type VectorSpace,
} from "../src/index.ts";
import { sha256Hex } from "../src/digest.ts";
import {
	examplesInTransaction,
	importExamplesInTransaction,
	lexicalInTransaction,
	migrateInTransaction,
	saveVectorsInTransaction,
	srCardsInTransaction,
	syncCardsInTransaction,
} from "../src/sqlite.ts";

// The whole package path on the evaluation data, without Python: cards and passage vectors synced into a package
// database, the memory imported into it, then lexical index → sr-corr → kind slots → top 8 and the ranking of every
// tool → reranker scores of the top tools up to extra.tools (LARM, as recorded) → best-v2. Every test item and variant
// must give best_v2.py's ranking, and the totals the report's. The inputs are evaluation data (data/, outside Git):
// data/larm-context/corr-larm2 (the scores of the LARM network the shipped numbers were trained on), its every-card
// scores data/larm-context/rerank-larm2-all.json, data/best-v2-parity/memory.json, and the recorded ranking
// docs/reports/data/2026-11-03/best-v2-larm2-k10.ranked.jsonl.
const corr = "data/larm-context/corr-larm2";
const memoryFile = "data/best-v2-parity/memory.json";
const rankedFile =
	"docs/reports/data/2026-11-03/best-v2-larm2-k10.ranked.jsonl";
const everyFile = "data/larm-context/rerank-larm2-all.json";
const ready =
	existsSync(`${corr}/corr.db`) &&
	existsSync(`${corr}/rerank-ruri.json`) &&
	existsSync(memoryFile) &&
	existsSync(rankedFile) &&
	existsSync(everyFile);

test.skipIf(!ready)(
	"the package path gives best_v2.py's ranking and the report's totals",
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
		const space: VectorSpace = {
			modelId: model,
			revision: "bench",
			artifactDigest: "bench",
			dimension: 384,
		};
		const vector = (text: string) => {
			const row = bench
				.query(
					"SELECT vector FROM bench_embeddings WHERE model=? AND text_hash=?",
				)
				.get(model, sha256Hex(text)) as { vector: Uint8Array } | null;
			if (!row) throw new Error("no vector for a text");
			return Array.from(unpackVector(row.vector));
		};
		const cards = (
			bench
				.query("SELECT card_json FROM bench_cards ORDER BY id")
				.all() as Array<{ card_json: string }>
		).map((r) => JSON.parse(r.card_json) as Card);
		const kindOf = new Map(cards.map((c) => [c.id, c.kind]));
		const db = new Database(":memory:");
		migrateInTransaction(db);
		const { pending } = syncCardsInTransaction(db, cards, space);
		saveVectorsInTransaction(
			db,
			space,
			pending.map((p) => ({ ...p, vector: vector(p.text) })),
		);
		importExamplesInTransaction(
			db,
			JSON.parse(readFileSync(memoryFile, "utf8")),
			space,
		);
		const memory = examplesInTransaction(db, {
			source: BEST_V2_PARAMS.source,
			space,
		});
		expect(memory).not.toBeNull();
		const best = loadBestV2(BEST_V2_PARAMS, memory!);
		const rerank: Record<string, Record<string, number>> = JSON.parse(
			readFileSync(`${corr}/rerank-ruri.json`, "utf8"),
		);
		const every: Record<string, Record<string, number>> = JSON.parse(
			readFileSync(everyFile, "utf8"),
		);
		const want = new Map(
			readFileSync(rankedFile, "utf8")
				.trim()
				.split("\n")
				.map((l) => {
					const r = JSON.parse(l) as {
						id: string;
						ranked: Array<[string, number]>;
					};
					return [r.id, r.ranked];
				}),
		);
		type Hints = {
			referencedResource?: { kind?: string };
			availableToolchainIds?: string[];
		};
		const utterance = new Map(
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
		const labels = (
			bench
				.query(
					"SELECT utterance_id AS id, split, label_json FROM bench_labels WHERE status='reviewed'",
				)
				.all() as Array<{ id: string; split: string; label_json: string }>
		).map((r) => {
			const l = JSON.parse(r.label_json) as {
				gold: string | null;
				acceptable?: string[];
				none?: boolean;
			};
			return {
				id: r.id,
				split: r.split,
				gold: l.none ? CONVERSATION_ID : l.gold!,
				acceptable: l.acceptable ?? [],
			};
		});
		const rows = labels.filter(
			(l) => l.split === "test" && !l.id.startsWith("ctl-") && want.has(l.id),
		);
		let compared = 0,
			worst = 0;
		const order: string[] = [];
		const tally = {
			test: { n: 0, top1: 0, defer: 0 },
			variant: { n: 0, top1: 0 },
		};
		for (const l of rows) {
			const { text, hints } = utterance.get(l.id)!;
			const list = hints.availableToolchainIds;
			const pool = srCardsInTransaction(db, {
				space,
				available: (id) => !list || id === CONVERSATION_ID || list.includes(id),
			});
			const scores = srScores({
				vector: vector(text),
				cards: pool,
				lexical: lexicalInTransaction(db, text),
				resource: hints.referencedResource?.kind ?? null,
				conversation: true,
			});
			const offer = srOffer(scores, (ranked) =>
				capByKind(ranked, (id: string) => kindOf.get(id)),
			);
			const rr =
				rerank[`${text}\u0000${offer.retrieval.map(([id]) => id).join("|")}`];
			if (!rr) continue; // texts over the reranker's limit kept other scores in the recorded run
			// The host scores the ranking's top tools up to extra.tools (a text over the limit has the offer's only).
			const ranking = srRanking(scores, (ranked) =>
				capByKind(ranked, (id: string) => kindOf.get(id)),
			);
			const all = every[text];
			const extra = all
				? Object.fromEntries(
						ranking
							.slice(0, BEST_V2_PARAMS.extra.tools)
							.filter(
								([id]) => !Object.hasOwn(rr, id) && Object.hasOwn(all, id),
							)
							.map(([id]) => [id, all[id]!]),
					)
				: {};
			const got = scoreBestV2(best, {
				retrieval: offer.retrieval,
				retrievalScores: offer.scores,
				rerank: { ...rr, ...extra },
				ranking,
				vector: vector(text),
			});
			const w = want.get(l.id)!;
			compared++;
			if (
				got.ranked.map((c) => c.id).join("|") !== w.map(([id]) => id).join("|")
			)
				order.push(l.id);
			w.forEach(
				([, p], i) =>
					(worst = Math.max(worst, Math.abs((got.ranked[i]?.p ?? NaN) - p))),
			);
			const hit =
				got.ranked[0]!.id === l.gold ||
				l.acceptable.includes(got.ranked[0]!.id);
			const t = l.id.startsWith("var-") ? tally.variant : tally.test;
			t.n++;
			if (hit) t.top1++;
			if (!l.id.startsWith("var-") && got.defer) tally.test.defer++;
		}
		bench.close();
		db.close();
		expect(compared).toBeGreaterThan(1400);
		expect(order).toEqual([]);
		expect(worst).toBeLessThan(1e-6);
		// best-v2 (LARM ruri, 10 tools), no LLM, the top candidate taken: the report's 87.1% top-1 and 18.0% deferral on the test.
		expect(tally.test.n).toBe(217);
		expect(+((100 * tally.test.top1) / tally.test.n).toFixed(1)).toBe(87.1);
		expect(+((100 * tally.test.defer) / tally.test.n).toFixed(1)).toBe(18.0);
		expect(+((100 * tally.variant.top1) / tally.variant.n).toFixed(1)).toBe(
			81.6,
		);
	},
);
