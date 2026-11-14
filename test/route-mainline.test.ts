import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	decideStructure,
	type StructureItem,
} from "../bench/router/structure.ts";
import { sha256Hex } from "../src/digest.ts";
import { BEST_V2_PARAMS } from "../bench/legacy/scoring/best-v2.params.ts";
import {
	CONVERSATION_ID,
	head,
	unpackVector,
	type Card,
	type VectorSpace,
} from "../src/index.ts";
import { loadBestV2 } from "../bench/legacy/scoring/best-v2.ts";
import {
	ROUTE_LIMITS,
	type RouteAnswer,
} from "../bench/legacy/contracts/route.ts";
import {
	route,
	type RoutePorts,
	type RouteTurn,
} from "../bench/legacy/route.ts";
import { routeWithFallback } from "../bench/legacy/route-fallback.ts";
import { type RouteDecision } from "../bench/legacy/decision/decide.ts";
import { routeStructuredFixture as routeStructured } from "./turn-response.fixture.ts";
import {
	examplesInTransaction,
	importExamplesInTransaction,
} from "../bench/legacy/db/example-memory.ts";
import {
	lexicalInTransaction,
	migrations,
	saveVectorsInTransaction,
	srCardsInTransaction,
	syncCardsInTransaction,
} from "../src/sqlite.ts";

// The two mainline entries (plan §10 M3d) on the recorded evaluation data, through the package alone: the
// cards, vectors and memory synced into a package database, embeddings and the reranker's (LARM's) scores from
// their records, the structure from the recorded structure model's answers. A must give the recorded best-v2
// ranking's top and deferral; B the bench's destination (bench/router/structure.ts decideStructure on the
// recorded routings). Texts over the reranker's 400 characters had other scores in the bench and are left out.
// The inputs are evaluation data (data/, outside Git).
const D = "data/structure";
const files = {
	db: `${D}/s0.db`,
	memory: "data/best-v2-parity/memory.json",
	ranked: "docs/reports/data/2026-11-03/best-v2-larm2-k10.ranked.jsonl",
	scores: `${D}/larm2-merged.json`,
	rows: `${D}/check-rows.jsonl`,
	s3test: `${D}/s3-test.jsonl`,
	s3: `${D}/s3.jsonl`,
	items: `${D}/items.jsonl`,
	routes: [
		`${D}/check-k10.out.jsonl`,
		`${D}/test-parts-k10.out.jsonl`,
		`${D}/s0-k10.out.jsonl`,
		`${D}/req-k10.out.jsonl`,
	],
	hinted: `${D}/s0h-k10.out.jsonl`,
};
const ready = [
	files.db,
	files.memory,
	files.ranked,
	files.scores,
	files.rows,
	files.s3test,
	files.s3,
	files.items,
	files.hinted,
	...files.routes,
].every(existsSync);

const lines = <T>(file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as T);

function setup() {
	const bench = new Database(files.db);
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
	const vectorOf = (text: string) => {
		const row = bench
			.query(
				"SELECT vector FROM bench_embeddings WHERE model=? AND text_hash=?",
			)
			.get(model, sha256Hex(text)) as { vector: Uint8Array } | null;
		return row ? Array.from(unpackVector(row.vector)) : null;
	};
	const cards = (
		bench
			.query("SELECT card_json FROM bench_cards ORDER BY id")
			.all() as Array<{ card_json: string }>
	).map((r) => JSON.parse(r.card_json) as Card);
	const db = new Database(":memory:");
	for (const sql of migrations) db.exec(sql);
	const { pending } = syncCardsInTransaction(db, cards, space);
	saveVectorsInTransaction(
		db,
		space,
		pending.map((p) => ({ ...p, vector: vectorOf(p.text)! })),
	);
	importExamplesInTransaction(
		db,
		JSON.parse(readFileSync(files.memory, "utf8")),
		space,
	);
	const best = loadBestV2(
		BEST_V2_PARAMS,
		examplesInTransaction(db, { source: BEST_V2_PARAMS.source, space })!,
	);
	const every: Record<string, Record<string, number>> = JSON.parse(
		readFileSync(files.scores, "utf8"),
	);
	// The embedding and the reranker receive the text's head: look the record up by the head.
	const fullOf = new Map<string, string>();
	const known = (text: string) => {
		fullOf.set(head(text, ROUTE_LIMITS.text), text);
		fullOf.set(head(text, ROUTE_LIMITS.rerankText), text);
	};
	const ports = (): RoutePorts => ({
		embed: async (texts) => ({
			space,
			vectors: texts.map((t) => {
				const v = vectorOf(fullOf.get(t) ?? t);
				if (!v) throw new Error("no vector for a text");
				return v;
			}),
		}),
		rerank: async (input): Promise<RouteAnswer> => {
			const s = every[fullOf.get(input.text) ?? input.text];
			if (!s) throw new Error("no scores for a text");
			const names = input.criteria.map((c) => c.name);
			return {
				choice: names[0]!,
				probabilities: Object.fromEntries(
					names.map((name) => [name, 1 / names.length]),
				),
				scores: Object.fromEntries(names.map((name) => [name, s[name]!])),
				model: "recorded",
				headRevision: null,
				calibrationRevision: null,
			};
		},
		read: {
			cards: (q) => srCardsInTransaction(db, q),
			lexical: (text) => lexicalInTransaction(db, text),
			nearFeedback: () => [],
		},
		model: best,
		settings: {
			accept: 0.6,
			low: 0.3,
			margin: 0.15,
			approve: 0.85,
			multi: 0.5,
			feedbackNear: 0.9177,
			feedbackWeight: 1.5,
		},
	});
	const turnOf = (
		text: string,
		hints: {
			referencedResource?: { kind?: string };
			availableToolchainIds?: string[];
		},
		previousAgent: string | null = null,
	): RouteTurn => {
		known(text);
		const list = hints.availableToolchainIds;
		return {
			state: { text, previousAgent, previousUser: null },
			dynamic: [],
			available: (id) => !list || id === CONVERSATION_ID || list.includes(id),
			instructions: "",
			resource: hints.referencedResource?.kind ?? null,
		};
	};
	const scored = (text: string) => text.length <= ROUTE_LIMITS.rerankText;
	return {
		ports,
		turnOf,
		known,
		scored,
		every,
		close: () => (bench.close(), db.close()),
	};
}

const destination = (d: RouteDecision): string =>
	d.to === "pipeline"
		? `pipeline:${[...new Set(d.steps.map((s) => s.candidate.id).filter((id) => id !== CONVERSATION_ID))].sort().join("+")}`
		: d.to === "conversation"
			? CONVERSATION_ID
			: d.to === "ask" || d.to === "clarify"
				? d.to
				: d.candidate.id;

test.skipIf(!ready)(
	"A (route): the recorded best-v2 top and deferral on every test utterance the reranker scored",
	async () => {
		const s = setup();
		const want = new Map(
			lines<{ id: string; ranked: Array<[string, number]> }>(files.ranked).map(
				(r) => [r.id, r.ranked] as const,
			),
		);
		const rows = lines<{
			id: string;
			text: string;
			hints?: Record<string, never>;
		}>(files.rows);
		const wrong: string[] = [];
		let compared = 0;
		let unchanged = 0;
		for (const r of rows) {
			if (!s.scored(r.text)) continue;
			const ports = s.ports();
			const turn = s.turnOf(r.text, r.hints ?? {});
			const result = await route(ports, turn);
			const w = want.get(r.id)!;
			const gate = w[0]![1] - (w[1]?.[1] ?? -9);
			compared++;
			if (
				result.corrected[0]!.candidate.id !== w[0]![0] ||
				result.explain.defer !== gate < BEST_V2_PARAMS.gate.deferBelow
			)
				wrong.push(r.id);
			if (result.explain.defer === false) {
				const conditional = await routeWithFallback(ports, turn, () => {
					throw new Error("unexpected B setup");
				});
				expect(conditional).toEqual({
					direct: result,
					structured: null,
					decision: result.decision,
				});
				unchanged++;
			}
		}
		s.close();
		expect(compared).toBeGreaterThan(210);
		expect(unchanged).toBeGreaterThan(0);
		expect(wrong).toEqual([]);
	},
);

test.skipIf(!ready)(
	"B (routeStructured): the bench's destination on the test utterances and the structure set",
	async () => {
		const s = setup();
		const routed = new Map<string, string>();
		for (const f of files.routes)
			for (const p of lines<{ text: string; tool: string }>(f))
				routed.set(p.text, p.tool);
		const hinted = new Map(
			lines<{ id: string; tool: string }>(files.hinted).map((p) => [
				p.id,
				p.tool,
			]),
		);
		const cases: Array<{
			id: string;
			text: string;
			hints: Record<string, unknown>;
			previousAgent: string | null;
			structure: unknown;
			whole: string;
		}> = [];
		const s3test = new Map(
			lines<{ id: string; structure: unknown }>(files.s3test).map((r) => [
				r.id,
				r.structure,
			]),
		);
		for (const r of lines<{
			id: string;
			text: string;
			hints?: Record<string, unknown>;
		}>(files.rows))
			cases.push({
				id: r.id,
				text: r.text,
				hints: r.hints ?? {},
				previousAgent: null,
				structure: s3test.get(r.id) ?? null,
				whole: routed.get(r.text)!,
			});
		const s3 = new Map(
			lines<{ id: string; structure: unknown }>(files.s3).map((r) => [
				r.id,
				r.structure,
			]),
		);
		const resourceOf = new Map(
			lines<{ id: string; hints?: Record<string, unknown> }>(
				`${D}/rows-hints.jsonl`,
			).map((r) => [r.id, r.hints ?? {}]),
		);
		for (const i of lines<StructureItem>(files.items))
			cases.push({
				id: i.id,
				text: i.text,
				hints: resourceOf.get(i.id) ?? {},
				previousAgent: i.previousAgent,
				structure: s3.get(i.id) ?? null,
				whole: hinted.get(i.id)!,
			});
		const wrong: string[] = [];
		let compared = 0;
		for (const c of cases) {
			const structure = c.structure as Parameters<typeof decideStructure>[1];
			const routedTexts: string[] = [];
			const expectedParts: string[] = [];
			const expected = decideStructure(
				c.text,
				structure,
				(t) => {
					routedTexts.push(t);
					const expectedPart = t === c.text ? c.whole : routed.get(t)!;
					expectedParts.push(expectedPart);
					return expectedPart;
				},
				"mask",
			);
			if (!routedTexts.every((t) => s.scored(t) && s.every[t])) continue;
			if (!c.text.trim() || Array.from(c.text).length > 2000) {
				await expect(
					routeStructured(
						{ ...s.ports(), analyze: async () => JSON.stringify(structure) },
						s.turnOf(c.text, {}, c.previousAgent),
					),
				).rejects.toThrow("structure_input_invalid");
				compared++;
				continue;
			}
			if (!structure) {
				await expect(
					routeStructured(
						{ ...s.ports(), analyze: async () => "no structure" },
						s.turnOf(c.text, {}, c.previousAgent),
					),
				).rejects.toThrow("structure_invalid");
				compared++;
				continue;
			}
			// Contract 4 keeps every real operation, including repeated tool IDs;
			// a part whose recorded destination is conversation cannot be silently omitted.
			const want =
				expectedParts.length > 1
					? expectedParts.includes(CONVERSATION_ID)
						? "clarify"
						: `pipeline:${[...new Set(expectedParts)].sort().join("+")}`
					: expected.route === "pipeline"
						? `pipeline:${[...expected.tools].sort().join("+")}`
						: expected.tool!;
			const result = await routeStructured(
				{
					...s.ports(),
					analyze: async () =>
						structure ? JSON.stringify(structure) : "no structure",
				},
				s.turnOf(
					c.text,
					c.hints as Parameters<typeof s.turnOf>[1],
					c.previousAgent,
				),
			);
			for (const part of result.parts) s.known(part.text);
			compared++;
			if (destination(result.decision) !== want)
				wrong.push(`${c.id}:${want}:${destination(result.decision)}`);
		}
		s.close();
		expect(compared).toBeGreaterThan(380);
		expect(wrong).toEqual([]);
	},
);
