import { expect, test } from "bun:test";
import {
	BEST_V2_FEATURES,
	BEST_V2_FORMAT,
	BEST_V2_MEMORY_FORMAT,
	CONVERSATION_ID,
	loadBestV2,
	rerankDocument,
	route,
	routeErrors,
	routeStructured,
	type BestV2Params,
	type NearFeedback,
	type RouteAnswer,
	type RouteInput,
	type RoutePorts,
	type RouteTurn,
	type VectorSpace,
} from "../src/index.ts";
import type { RouterCard } from "../src/sqlite.ts";

const space: VectorSpace = {
	modelId: "test",
	revision: "r1",
	artifactDigest: "test",
	dimension: 2,
};
const n = BEST_V2_FEATURES.length;
const only = (name: (typeof BEST_V2_FEATURES)[number], w: number) =>
	BEST_V2_FEATURES.map((f) => (f === name ? w : 0));
const params: BestV2Params = {
	format: BEST_V2_FORMAT,
	version: "test",
	source: "test",
	features: [...BEST_V2_FEATURES],
	ranker: {
		mean: Array(n).fill(0),
		scale: Array(n).fill(1),
		coef: only("rr", 4),
		intercept: 0,
	},
	gate: { deferBelow: 0.1 },
	fuse: { weight: 2, conversation: 0.18, top: 8 },
	extra: { tools: 4 },
	knn: { neighbors: 1, dimension: 2 },
};
const model = loadBestV2(params, {
	format: BEST_V2_MEMORY_FORMAT,
	source: "test",
	dimension: 2,
	labels: ["music.create"],
	vectors: btoa(
		String.fromCharCode(...new Uint8Array(new Float32Array([0, 1]).buffer)),
	),
});

function card(
	id: string,
	kind: RouterCard["kind"],
	vector: number[],
	impact: RouterCard["impact"] = "create",
): RouterCard {
	return {
		id,
		revision: "r1",
		kind,
		title: id,
		summary: `${id} の説明`,
		useWhen: [`${id} の用途`],
		examples: [`${id} の例`],
		impact,
		passages: [new Float32Array(vector)],
	};
}
const CARDS = [
	card(CONVERSATION_ID, "general", [0, 1], "none"),
	card("music.create", "dedicated", [1, 0]),
	card("image.create", "dedicated", [0.9, 0.1]),
	card("timers.manage", "dedicated", [0.2, 0.8], "modify_existing"),
];

type Calls = { embed: string[]; rerank: RouteInput[] };

function ports(
	scores: Record<string, number>,
	options: {
		near?: NearFeedback[];
		cards?: RouterCard[];
		withoutScores?: boolean;
	} = {},
): { ports: RoutePorts; calls: Calls } {
	const calls: Calls = { embed: [], rerank: [] };
	return {
		calls,
		ports: {
			embed: async (texts) => {
				calls.embed.push(...texts);
				return { space, vectors: texts.map(() => [1, 0]) };
			},
			rerank: async (input): Promise<RouteAnswer> => {
				calls.rerank.push(input);
				const names = input.criteria.map((c) => c.name);
				return {
					choice: names[0]!,
					probabilities: Object.fromEntries(
						names.map((name) => [name, 1 / names.length]),
					),
					scores: options.withoutScores
						? null
						: Object.fromEntries(
								names.map((name) => [name, scores[name] ?? 0]),
							),
					model: "test",
					headRevision: null,
					calibrationRevision: null,
				};
			},
			read: {
				cards: () => options.cards ?? CARDS,
				lexical: () => new Map(),
				nearFeedback: () => options.near ?? [],
			},
			model,
			settings: {
				accept: 0.6,
				low: 0.3,
				margin: 0.15,
				approve: 0.85,
				multi: 0.5,
				feedbackNear: 0.9,
				feedbackWeight: 2,
			},
		},
	};
}

const turn = (text: string, extra: Partial<RouteTurn> = {}): RouteTurn => ({
	state: { text, previousAgent: null, previousUser: null },
	dynamic: [],
	available: () => true,
	instructions: "担当を選ぶ",
	...extra,
});

const near = (id: string, rightId: string, wrongId: string | null = null) =>
	({
		id,
		similarity: 1,
		rightId,
		wrongId,
		state: "active",
	}) as NearFeedback;

test("route: the reranker's scores through best-v2; a sure top runs (row 2), the conversation is not sent", async () => {
	const { ports: p, calls } = ports({
		"music.create": 0.9,
		"image.create": 0.2,
		"timers.manage": 0.1,
	});
	const result = await route(p, turn("曲を作って"));
	expect(result.decision).toMatchObject({ row: 2, to: "run" });
	expect(result.corrected[0]!.candidate.id).toBe("music.create");
	expect(result.explain.defer).toBe(false);
	const sent = calls.rerank[0]!.criteria;
	expect(sent.map((c) => c.name).sort()).toEqual([
		"image.create",
		"music.create",
		"timers.manage",
	]);
	expect(sent.find((c) => c.name === "music.create")!.description).toBe(
		rerankDocument(CARDS[1]!),
	);
	expect(calls.embed).toEqual(["曲を作って"]);
});

test("route: an unsure top is still run with a notice (row 3), never asked about", async () => {
	// Two tools below `multi` (0.5): not "several jobs" (row 9), and close enough to defer.
	const { ports: p } = ports({
		"music.create": 0.45,
		"image.create": 0.44,
	});
	const result = await route(p, turn("何か作って"));
	expect(result.explain.defer).toBe(true);
	expect(result.decision).toMatchObject({ row: 3, to: "run", announce: "try" });
});

test("route: a near correction moves the top and makes it unsure; disagreeing ones do not move anything", async () => {
	const scores = { "music.create": 0.45, "image.create": 0.3 };
	const moved = await route(
		ports(scores, { near: [near("f1", "image.create", "music.create")] }).ports,
		turn("曲を作って"),
	);
	expect(moved.corrected[0]!.candidate.id).toBe("image.create");
	expect(moved.decision).toMatchObject({ row: 3, to: "run" });
	const split = await route(
		ports(scores, {
			near: [near("f1", "image.create"), near("f2", "timers.manage")],
		}).ports,
		turn("曲を作って"),
	);
	expect(split.explain.conflict).toBe(true);
	expect(split.explain.conflicts).toEqual(["f1", "f2"]);
	expect(split.corrected[0]!.candidate.id).toBe("music.create");
});

test("route: with no tool to offer the reranker is not called and the decision is row 8", async () => {
	const { ports: p, calls } = ports({}, { cards: [CARDS[0]!] });
	const result = await route(p, turn("こんにちは"));
	expect(result.decision).toEqual({ row: 8, to: "conversation" });
	expect(calls.rerank).toEqual([]);
	expect(result.answer).toBeNull();
});

test("route: a retained card the search does not reach is offered and scored", async () => {
	// 25 tools, the further down the less similar: the offer and the extra tools stop before the last ones.
	const many = [
		CARDS[0]!,
		...Array.from({ length: 25 }, (_, i) =>
			card(`d${String(i).padStart(2, "0")}`, "dedicated", [
				Math.cos(i / 20),
				Math.sin(i / 20),
			]),
		),
	];
	const searched = await route(ports({}, { cards: many }).ports, turn("曲"));
	expect(searched.explain.offered).not.toContain("d24");
	const { ports: p, calls } = ports({ d24: 0.9 }, { cards: many });
	const result = await route(p, turn("曲", { retained: ["d24", "gone"] }));
	expect(calls.rerank[0]!.criteria.map((c) => c.name)).toContain("d24");
	expect(result.corrected.map((r) => r.candidate.id)).toContain("d24");
	expect(result.explain.offered).not.toContain("gone");
});

test("route: an answer without scores is refused", async () => {
	const { ports: p } = ports({}, { withoutScores: true });
	await expect(route(p, turn("曲を作って"))).rejects.toThrow(
		routeErrors.invalidResponse,
	);
});

test("routeStructured: no request is the conversation, without routing anything", async () => {
	const { ports: p, calls } = ports({ "music.create": 0.9 });
	const result = await routeStructured(
		{ ...p, analyze: async () => '{"requests":[]}' },
		turn("この曲いいね"),
	);
	expect(result.decision).toEqual({ row: 1, to: "conversation" });
	expect(result.parts).toEqual([]);
	expect(calls.embed).toEqual([]);
});

test("routeStructured: one request with a reference routes the masked utterance, without the resource hint", async () => {
	const { ports: p, calls } = ports({
		"image.create": 0.9,
		"music.create": 0.3,
	});
	const prompts: string[] = [];
	const result = await routeStructured(
		{
			...p,
			analyze: async (prompt) => {
				prompts.push(prompt.user);
				return JSON.stringify({
					requests: [
						{
							text: "画像を作って",
							target: "画像",
							inputs: ["この音楽"],
							after: [],
						},
					],
				});
			},
		},
		turn("この音楽に合う画像を作って", {
			resource: "audio",
			state: {
				text: "この音楽に合う画像を作って",
				previousAgent: "曲を作りました。",
				previousUser: null,
			},
		}),
	);
	expect(prompts).toEqual([
		"直前のエージェントの発言: 曲を作りました。\n発言: この音楽に合う画像を作って",
	]);
	expect(calls.embed).toEqual(["これに合う画像を作って"]);
	expect(result.parts.map((part) => part.text)).toEqual([
		"これに合う画像を作って",
	]);
	expect(result.decision).toMatchObject({ to: "run" });
	expect(result.parts[0]!.result.corrected[0]!.candidate.id).toBe(
		"image.create",
	);
});

test("routeStructured: requests of two tools go to the pipeline stage in order", async () => {
	const { ports: p } = ports({ "music.create": 0.9, "image.create": 0.1 });
	const byText: Record<string, Record<string, number>> = {
		曲を作って: { "music.create": 0.9, "image.create": 0.1 },
		画像も作って: { "music.create": 0.1, "image.create": 0.9 },
	};
	const result = await routeStructured(
		{
			...p,
			rerank: async (input) => {
				const s = byText[input.text]!;
				const names = input.criteria.map((c) => c.name);
				return {
					choice: names[0]!,
					probabilities: Object.fromEntries(
						names.map((name) => [name, 1 / names.length]),
					),
					scores: Object.fromEntries(names.map((name) => [name, s[name] ?? 0])),
					model: "test",
					headRevision: null,
					calibrationRevision: null,
				};
			},
			analyze: async () =>
				JSON.stringify({
					requests: [
						{ text: "曲を作って", target: "曲", inputs: [], after: [] },
						{
							text: "画像も作って",
							target: "画像",
							inputs: ["それ"],
							after: [0],
						},
					],
				}),
		},
		turn("曲を作って、それに合う画像も作って"),
	);
	expect(result.decision.to).toBe("pipeline");
	if (result.decision.to !== "pipeline") throw new Error("not a pipeline");
	expect(
		result.decision.steps.map((s) => [s.text, s.candidate.id, s.after]),
	).toEqual([
		["曲を作って", "music.create", []],
		["画像も作って", "image.create", [0]],
	]);
});

test("routeStructured: an answer that is not a structure of the utterance routes the whole utterance, as route()", async () => {
	const { ports: p, calls } = ports({ "music.create": 0.9 });
	const result = await routeStructured(
		{
			...p,
			analyze: async () =>
				'{"requests":[{"text":"音楽を作って","target":null,"inputs":[],"after":[]}]}',
		},
		turn("曲を作って"),
	);
	expect(result.structure).toBeNull();
	expect(calls.embed).toEqual(["曲を作って"]);
	expect(result.decision).toMatchObject({ row: 2, to: "run" });
});

test("route: a dynamic candidate is scored by the reranker and decided by its row (an asked approval runs, row 5)", async () => {
	const pending = {
		id: "pending.approve",
		kind: "pending" as const,
		operation: "approve" as const,
		confirmation: "c1",
		toolchain: "music.create",
		passage: "曲の生成を承認する",
	};
	const { ports: p, calls } = ports({
		"pending.approve": 0.95,
		"music.create": 0.2,
	});
	const result = await route(
		p,
		turn("はい、お願い", { dynamic: [pending], asked: "pending.approve" }),
	);
	expect(calls.rerank[0]!.criteria.map((c) => c.name)).toContain(
		"pending.approve",
	);
	expect(result.corrected[0]!.candidate.id).toBe("pending.approve");
	expect(result.decision).toMatchObject({ row: 5, to: "run" });
});

test("route: a blank description is refused before the reranker; a long card document is cut, not dropped", async () => {
	const blank = {
		id: "work.check",
		kind: "work" as const,
		todo: "t1",
		operation: "check" as const,
		title: "確認",
		passage: "  ",
	};
	const { ports: p, calls } = ports({ "music.create": 0.9 });
	await expect(
		route(p, turn("曲を作って", { dynamic: [blank] })),
	).rejects.toThrow(routeErrors.invalidRequest);
	expect(calls.rerank).toEqual([]);
	const long = {
		...card("music.create", "dedicated", [1, 0]),
		examples: ["あ".repeat(5000)],
	};
	const { ports: q, calls: sent } = ports(
		{ "music.create": 0.9 },
		{ cards: [CARDS[0]!, long] },
	);
	const result = await route(q, turn("曲を作って"));
	const description = sent.rerank[0]!.criteria.find(
		(c) => c.name === "music.create",
	)!.description;
	expect(description.length).toBe(4096);
	expect(result.corrected[0]!.candidate.id).toBe("music.create");
});
