import { expect, test } from "bun:test";
import {
	CONVERSATION_ID,
	correctProbabilities,
	decide,
	predictionSet,
	type DecisionCard,
	type Impact,
	type Ranked,
	type RouteCandidate,
} from "../src/index.ts";

const SETTINGS = {
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
};

function card(
	id: string,
	extra: { general?: true; execution?: string; minImpact?: Impact } = {},
): DecisionCard {
	return {
		id,
		title: id,
		...extra,
		score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
	};
}
const tool = (
	id: string,
	extra?: { general?: true; execution?: string; minImpact?: Impact },
): RouteCandidate => ({
	id,
	kind: "toolchain",
	passage: "",
	card: card(id, extra),
	choice: { id, title: id },
});
const conversation: RouteCandidate = {
	id: CONVERSATION_ID,
	kind: "conversation",
	passage: "",
};
const ranked = (
	...entries: Array<[RouteCandidate, number, number?]>
): Ranked[] =>
	entries.map(([candidate, p, score]) => ({
		candidate,
		raw: p,
		correction: 0,
		p,
		score: score ?? null,
	}));
const work = (operation: "check" | "amend" | "cancel"): RouteCandidate => ({
	id: `t1.${operation}`,
	kind: "work",
	todo: "t1",
	operation,
	title: "",
	passage: "",
});
const confirm = (operation: "approve" | "decline"): RouteCandidate => ({
	id: `c1.${operation}`,
	kind: "pending",
	operation,
	confirmation: "c1",
	toolchain: "",
	passage: "",
});

test("a correction near the utterance moves its right answer up and its wrong one down", () => {
	const candidates = [
		{ id: "a", p: 0.5 },
		{ id: "b", p: 0.4 },
		{ id: "c", p: 0.1 },
	];
	const options = { threshold: 0.9, weight: 2 };
	const near = correctProbabilities(
		candidates,
		[{ id: "f", wrongId: "a", rightId: "b", similarity: 0.99 }],
		options,
	);
	expect(near.shift[0]).toBeCloseTo(-1.8);
	expect(near.shift[1]).toBeCloseTo(1.8);
	expect(near.shift[2]).toBe(0);
	expect(near.p[1]!).toBeGreaterThan(near.p[0]!);
	expect(near.p.reduce((sum, p) => sum + p, 0)).toBeCloseTo(1);
	const edge = correctProbabilities(
		candidates,
		[{ id: "f", wrongId: "a", rightId: "b", similarity: 0.9 }],
		options,
	);
	expect(edge.shift).toEqual([0, 0, 0]);
	expect(edge.p[0]!).toBeGreaterThan(edge.p[1]!);
});

test("a correction moves a candidate by the weight at most", () => {
	const rows = Array.from({ length: 5 }, (_, i) => ({
		id: `f${i}`,
		wrongId: null,
		rightId: "b",
		similarity: 1,
	}));
	const out = correctProbabilities(
		[
			{ id: "a", p: 0.9 },
			{ id: "b", p: 0.1 },
		],
		rows,
		{ threshold: 0.9, weight: 1.5 },
	);
	expect(out.shift).toEqual([0, 1.5]);
});

test("corrections that name different right answers cancel; weight 0 turns them off", () => {
	const candidates = [
		{ id: "a", p: 0.6 },
		{ id: "b", p: 0.4 },
	];
	const rows = [
		{ id: "f1", wrongId: "a", rightId: "b", similarity: 0.99 },
		{ id: "f2", wrongId: "b", rightId: "a", similarity: 0.99 },
	];
	expect(
		correctProbabilities(candidates, rows, { threshold: 0.9, weight: 2 }),
	).toMatchObject({ conflict: true, p: [0.6, 0.4], shift: [0, 0] });
	expect(
		correctProbabilities(candidates, rows.slice(0, 1), {
			threshold: 0.9,
			weight: 0,
		}),
	).toMatchObject({ conflict: false, p: [0.6, 0.4] });
});

test("rows 1 and 7: the conversation is taken when it leads, and when a toolchain follows closely", () => {
	expect(
		decide(ranked([conversation, 0.8], [tool("image"), 0.2]), SETTINGS),
	).toEqual({ row: 1, to: "conversation" });
	expect(
		decide(ranked([conversation, 0.5], [tool("image"), 0.4]), SETTINGS),
	).toEqual({ row: 7, to: "conversation" });
});

test("rows 2, 3 and 4: a sure toolchain, an unsure one, and one that changes something", () => {
	expect(
		decide(ranked([tool("image"), 0.8], [tool("music"), 0.1]), SETTINGS),
	).toMatchObject({ row: 2, announce: "fixed", candidate: { id: "image" } });
	expect(
		decide(ranked([tool("image"), 0.62], [tool("music"), 0.5]), SETTINGS),
	).toMatchObject({ row: 3, announce: "try" });
	expect(
		decide(ranked([tool("image"), 0.4], [tool("music"), 0.1]), SETTINGS),
	).toMatchObject({ row: 3, announce: "try" });
	expect(
		decide(
			ranked(
				[tool("image", { minImpact: "modify_existing" }), 0.4],
				[tool("music"), 0.1],
			),
			SETTINGS,
		),
	).toMatchObject({ row: 4, announce: "try" });
});

test("row 5: a yes is taken only above the approval line", () => {
	expect(
		decide(ranked([confirm("approve"), 0.9], [conversation, 0.1]), SETTINGS),
	).toMatchObject({ row: 5, to: "run" });
	expect(
		decide(ranked([confirm("approve"), 0.7], [conversation, 0.3]), SETTINGS),
	).toMatchObject({ row: 5, to: "again" });
	expect(
		decide(
			ranked([confirm("approve"), 0.7], [conversation, 0.3]),
			SETTINGS,
			"c1.approve",
		),
	).toMatchObject({ row: 5, to: "run" });
});

test("row 6: a cancellation is done above the adoption line and asked about below it", () => {
	expect(
		decide(ranked([work("cancel"), 0.65], [conversation, 0.35]), SETTINGS),
	).toMatchObject({ row: 6, to: "run" });
	expect(
		decide(ranked([work("cancel"), 0.5], [conversation, 0.5]), SETTINGS),
	).toMatchObject({ row: 6, to: "again" });
});

test("a correction, a decline or a memory request below the margin makes no promise", () => {
	expect(
		decide(ranked([work("amend"), 0.5], [conversation, 0.45]), SETTINGS),
	).toEqual({
		row: 7,
		to: "conversation",
	});
	expect(
		decide(ranked([work("amend"), 0.8], [conversation, 0.1]), SETTINGS),
	).toMatchObject({ row: 2, to: "run" });
});

test("row 8: nothing sure is the conversation, or a question between two toolchains", () => {
	expect(
		decide(ranked([tool("image"), 0.2], [conversation, 0.19]), SETTINGS),
	).toEqual({
		row: 8,
		to: "conversation",
	});
	const asked = decide(
		ranked([tool("image"), 0.2], [tool("music"), 0.19], [conversation, 0.1]),
		SETTINGS,
	);
	expect(asked).toMatchObject({ row: 8, to: "ask" });
	if (asked.to === "ask")
		expect(asked.options.map((option) => option.id)).toEqual([
			"image",
			"music",
		]);
	expect(
		decide(ranked([work("check"), 0.2], [tool("image"), 0.19]), SETTINGS),
	).toEqual({
		row: 8,
		to: "conversation",
	});
});

test("row 9: two dedicated toolchains scoring on their own, unless a pipeline would do all of it", () => {
	expect(
		decide(
			ranked(
				[tool("image"), 0.6, 0.9],
				[tool("music"), 0.3, 0.8],
				[conversation, 0.1],
			),
			SETTINGS,
		),
	).toMatchObject({ row: 9, announce: "partial", candidate: { id: "image" } });
	expect(
		decide(ranked([tool("image"), 0.6], [tool("music"), 0.3]), SETTINGS),
	).toMatchObject({ row: 2 });
	expect(
		decide(
			ranked([tool("image"), 0.6, 0.9], [tool("music"), 0.3, 0.2]),
			SETTINGS,
		),
	).toMatchObject({ row: 2 });
	expect(
		decide(
			ranked(
				[tool("image"), 0.6, 0.9],
				[tool("music", { general: true }), 0.3, 0.8],
			),
			SETTINGS,
		),
	).toMatchObject({ row: 2 });
	expect(
		decide(
			ranked(
				[tool("image"), 0.6, 0.9],
				[tool("music"), 0.2, 0.8],
				[tool("research", { execution: "pipeline" }), 0.1, 0.7],
			),
			SETTINGS,
		),
	).toMatchObject({ row: 2 });
});

test("the prediction set is the best candidates until they are 0.9 together, at most three", () => {
	const set = (...p: number[]) =>
		predictionSet(
			p.map((value, i) => ({
				candidate: { id: `c${i}`, kind: "memory", passage: "" },
				raw: value,
				correction: 0,
				p: value,
				score: null,
			})),
		);
	expect(set(0.95, 0.03, 0.02)).toEqual(["c0"]);
	expect(set(0.5, 0.42, 0.05, 0.03)).toEqual(["c0", "c1"]);
	expect(set(0.3, 0.3, 0.2, 0.2)).toEqual(["c0", "c1", "c2"]);
});

test("an empty offer is the conversation", () => {
	expect(decide([], SETTINGS)).toEqual({ row: 8, to: "conversation" });
});
