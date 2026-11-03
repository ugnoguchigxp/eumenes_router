import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	BEST_V2_FEATURES,
	BEST_V2_FORMAT,
	BEST_V2_MEMORY_FORMAT,
	BEST_V2_PARAMS,
	CONVERSATION_ID,
	loadBestV2,
	routerErrors,
	scoreBestV2,
	type BestV2Memory,
	type BestV2Params,
} from "../src/index.ts";

const n = BEST_V2_FEATURES.length;
const base64 = (values: number[]) =>
	btoa(String.fromCharCode(...new Uint8Array(new Float32Array(values).buffer)));

const params = (coef: number[]): BestV2Params => ({
	format: BEST_V2_FORMAT,
	version: "test",
	source: "test",
	features: [...BEST_V2_FEATURES],
	ranker: {
		mean: Array(n).fill(0),
		scale: Array(n).fill(1),
		coef,
		intercept: 0,
	},
	gate: { deferBelow: 0.1 },
	fuse: { weight: 2, conversation: 0.18, top: 8 },
	knn: { neighbors: 2, dimension: 2 },
});
const memory: BestV2Memory = {
	format: BEST_V2_MEMORY_FORMAT,
	source: "test",
	dimension: 2,
	labels: ["music.create", "image.create"],
	vectors: base64([1, 0, 0, 1]),
};
const only = (name: (typeof BEST_V2_FEATURES)[number], w: number) =>
	BEST_V2_FEATURES.map((f) => (f === name ? w : 0));

test("offers the retrieved tools that have a rerank score, plus the conversation", () => {
	const model = loadBestV2(params(only("rr", 4)), memory);
	const result = scoreBestV2(model, {
		retrieval: [
			["image.create", 0.2],
			["music.create", 0.5],
			[CONVERSATION_ID, 0.3],
			["web.search", 0.1],
		],
		retrievalScores: {},
		rerank: { "music.create": 0.9, "image.create": 0.2 },
		vector: [1, 0],
	});
	expect(result.ranked.map((c) => c.id)).toEqual([
		"music.create",
		"image.create",
		CONVERSATION_ID,
	]);
	expect(result.gate).toBeCloseTo(
		result.ranked[0]!.p - result.ranked[1]!.p,
		12,
	);
});

test("the memory's nearest labels raise their candidate", () => {
	const model = loadBestV2(params(only("knn", 5)), memory);
	const input = {
		retrieval: [
			["music.create", 0.5],
			["image.create", 0.5],
		] as const,
		retrievalScores: {},
		rerank: { "music.create": 0.5, "image.create": 0.5 },
	};
	expect(scoreBestV2(model, { ...input, vector: [1, 0] }).ranked[0]!.id).toBe(
		"music.create",
	);
	expect(scoreBestV2(model, { ...input, vector: [0, 1] }).ranked[0]!.id).toBe(
		"image.create",
	);
});

test("with the conversation alone, the gap is p + 9 and nothing defers", () => {
	const model = loadBestV2(params(only("rr", 1)), memory);
	const result = scoreBestV2(model, {
		retrieval: [["web.search", 1]],
		retrievalScores: {},
		rerank: {},
		vector: [1, 0],
	});
	expect(result.ranked.map((c) => c.id)).toEqual([CONVERSATION_ID]);
	expect(result.gate).toBeCloseTo(result.ranked[0]!.p + 9, 12);
	expect(result.defer).toBe(false);
});

test("broken numbers, another memory, or a vector of another size are refused", () => {
	const good = params(only("rr", 1));
	const refused = (p: BestV2Params, m: BestV2Memory) =>
		expect(() => loadBestV2(p, m)).toThrow(routerErrors.invalidModel);
	refused({ ...good, format: "other" as never }, memory);
	refused({ ...good, features: [...BEST_V2_FEATURES].reverse() }, memory);
	refused(
		{ ...good, ranker: { ...good.ranker, scale: Array(n).fill(0) } },
		memory,
	);
	refused(good, { ...memory, source: "another training" });
	refused(good, { ...memory, vectors: base64([1, 0, 0]) });
	expect(() =>
		scoreBestV2(loadBestV2(good, memory), {
			retrieval: [],
			retrievalScores: {},
			rerank: {},
			vector: [1, 0, 0],
		}),
	).toThrow(routerErrors.invalidEmbedding);
});

test("the shipped numbers hold nothing from an utterance", () => {
	expect(Object.keys(BEST_V2_PARAMS).sort()).toEqual([
		"features",
		"format",
		"fuse",
		"gate",
		"knn",
		"ranker",
		"source",
		"version",
	]);
	expect(BEST_V2_PARAMS.features).toEqual([...BEST_V2_FEATURES]);
});

// Parity with bench/router/experiments/best/best_v2.py on the test items and variants. The memory and the inputs come
// from the evaluation data, so they live in data/ (outside Git): `best_v2.py export-package` and `export-parity`.
const dir = "data/best-v2-parity";
const parity =
	existsSync(`${dir}/memory.json`) && existsSync(`${dir}/rows.jsonl`);
test.skipIf(!parity)(
	"the shipped numbers with the host's memory match best_v2.py on every test item and variant",
	() => {
		const model = loadBestV2(
			BEST_V2_PARAMS,
			JSON.parse(readFileSync(`${dir}/memory.json`, "utf8")),
		);
		const rows = readFileSync(`${dir}/rows.jsonl`, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		let worst = 0;
		const wrong: string[] = [];
		for (const row of rows) {
			const got = scoreBestV2(model, row.input);
			const want = row.expected as {
				ranked: Array<[string, number]>;
				gate: number;
				defer: boolean;
			};
			const same =
				got.ranked.map((c) => c.id).join("|") ===
					want.ranked.map(([id]) => id).join("|") && got.defer === want.defer;
			if (!same) wrong.push(row.id);
			for (let i = 0; i < want.ranked.length; i++)
				worst = Math.max(
					worst,
					Math.abs((got.ranked[i]?.p ?? NaN) - want.ranked[i]![1]),
				);
			worst = Math.max(worst, Math.abs(got.gate - want.gate));
		}
		expect(rows.length).toBeGreaterThan(1000);
		expect(wrong).toEqual([]);
		expect(worst).toBeLessThan(1e-6);
	},
);
