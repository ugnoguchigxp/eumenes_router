import { expect, test } from "bun:test";
import {
	decisionOf as ours,
	type CatalogEntry,
	type Prediction,
} from "./score.ts";
import {
	correctProbabilities as ourCorrect,
	decide as ourDecide,
	predictionSet as ourSet,
	type Ranked,
	type RouteCandidate,
} from "../src/index.ts";

const eumenesScorePath =
	"/Users/y.noguchi/Code/eumenes/scripts/router-bench/score.ts";
const eumenesRoutePath =
	"/Users/y.noguchi/Code/eumenes/api/domains/dialogue/service/routed-route.ts";
const eumenesScore = (await import(eumenesScorePath)) as {
	decisionOf: typeof ours;
};
const eumenesRoute = (await import(eumenesRoutePath)) as {
	correctProbabilities: typeof ourCorrect;
	decide: (
		ranked: readonly Ranked[],
		settings: typeof THRESHOLDS,
	) => { row: number; to: string };
	predictionSet: (ranked: readonly Ranked[]) => string[];
};

const THRESHOLDS = {
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
};

function mulberry32(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const IDS = [
	"conversation.respond",
	"memory.request",
	"music.create",
	"music.library",
	"studio.pipeline",
	"files.edit",
	"read_memory",
	"t1.cancel",
	"t2.check",
	"c1.approve",
	"c1.decline",
	"t3.answer",
	"switch.discard",
	"t4.redirect:music.create",
];

const CATALOG: Record<string, CatalogEntry> = {
	"music.library": { general: true },
	"studio.pipeline": { execution: "pipeline" },
	"files.edit": { minImpact: "modify_existing" },
	read_memory: { read: true },
};

function prediction(
	rand: () => number,
	count: number,
	withScores: boolean,
): Prediction {
	const ids = [...IDS].sort(() => rand() - 0.5).slice(0, count);
	const weights = ids.map(() => rand());
	const total = weights.reduce((sum, value) => sum + value, 0) || 1;
	const probabilities: Record<string, number> = {};
	const scores: Record<string, number> = {};
	ids.forEach((id, index) => {
		probabilities[id] = weights[index]! / total;
		scores[id] = rand();
	});
	return {
		id: "p",
		probabilities,
		...(withScores ? { scores } : {}),
	};
}

test("decisions match Eumenes score.ts on the same predictions", () => {
	const rand = mulberry32(20261102);
	const cases: Prediction[] = [];
	for (let i = 0; i < 200; i++)
		cases.push(prediction(rand, 2 + Math.floor(rand() * 5), rand() > 0.5));
	cases.push(
		{
			id: "row9",
			probabilities: {
				"music.create": 0.6,
				"files.edit": 0.3,
				"conversation.respond": 0.1,
			},
			scores: {
				"music.create": 0.9,
				"files.edit": 0.8,
				"conversation.respond": 0.1,
			},
		},
		{
			id: "pipeline",
			probabilities: {
				"music.create": 0.6,
				"files.edit": 0.2,
				"studio.pipeline": 0.2,
			},
			scores: {
				"music.create": 0.9,
				"files.edit": 0.8,
				"studio.pipeline": 0.7,
			},
		},
	);
	const mismatches: string[] = [];
	for (const [index, row] of cases.entries()) {
		const theirs = eumenesScore.decisionOf(row, THRESHOLDS, CATALOG);
		const oursDecision = ours(row, THRESHOLDS, CATALOG);
		if (JSON.stringify(theirs) !== JSON.stringify(oursDecision))
			mismatches.push(`${index}:${row.id}`);
	}
	expect(mismatches).toEqual([]);
});

test("correctProbabilities, decide and predictionSet match Eumenes on the same inputs", () => {
	const candidates = [
		{ id: "a", p: 0.5 },
		{ id: "b", p: 0.4 },
		{ id: "c", p: 0.1 },
	];
	const near = [{ id: "f", wrongId: "a", rightId: "b", similarity: 0.99 }];
	const options = { threshold: 0.9, weight: 2 };
	expect(ourCorrect(candidates, near, options)).toEqual(
		eumenesRoute.correctProbabilities(candidates, near, options),
	);
	const tool = (
		id: string,
		score: number | null,
		execution?: string,
	): Ranked => ({
		candidate: {
			id,
			kind: "toolchain",
			passage: "",
			card: {
				id,
				title: id,
				...(execution ? { execution } : {}),
				score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
			},
			choice: { id, title: id },
		} as RouteCandidate,
		raw: 0.6,
		correction: 0,
		p: 0.6,
		score,
	});
	const ranked = [tool("music.create", 0.9), tool("files.edit", 0.8)];
	ranked[0]!.p = 0.6;
	ranked[1]!.p = 0.3;
	const decision = ourDecide(ranked, THRESHOLDS);
	const theirs = eumenesRoute.decide(ranked as never, THRESHOLDS);
	expect(decision.row).toBe(theirs.row as typeof decision.row);
	expect(decision.to).toBe(theirs.to as typeof decision.to);
	expect(ourSet(ranked)).toEqual(eumenesRoute.predictionSet(ranked as never));
});
