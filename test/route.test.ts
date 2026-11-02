import { expect, test } from "bun:test";
import {
	CONVERSATION_ID,
	route,
	type Candidate,
	type NearFeedback,
	type RouteAnswer,
	type RouteCandidate,
} from "../src/index.ts";
import type { VectorSpace } from "../src/index.ts";

const space: VectorSpace = {
	modelId: "embed",
	revision: "1",
	artifactDigest: "digest",
	dimension: 2,
};

const conversation: RouteCandidate = {
	id: CONVERSATION_ID,
	kind: "conversation",
	passage: "会話で返事する",
};

const music: Candidate = {
	id: "music.create",
	revision: "r1",
	kind: "dedicated",
	title: "作曲",
	summary: "曲を作る",
	useWhen: ["作曲の依頼"],
	impact: "create",
	similarity: 0.91,
	rank: 1,
	ftsRank: null,
	fromHistory: false,
};

test("route scores the offer, applies a correction, and decides", async () => {
	const logged: string[] = [];
	const near: NearFeedback[] = [
		{
			id: "f1",
			wrongId: CONVERSATION_ID,
			rightId: "music.create",
			similarity: 0.99,
		},
	];
	let sawText = "";
	const result = await route(
		{
			embed: async (texts) => {
				sawText = texts[0] ?? "";
				return { space, vectors: [[1, 0]] };
			},
			score: async (input) => {
				const names = input.criteria.map((criterion) => criterion.name);
				expect(names).toEqual(["conversation.respond", "music.create"]);
				const probabilities: Record<string, number> = {
					"conversation.respond": 0.55,
					"music.create": 0.45,
				};
				const answer: RouteAnswer = {
					choice: "conversation.respond",
					probabilities,
					scores: null,
					model: "scorer",
					headRevision: null,
					calibrationRevision: null,
				};
				return answer;
			},
			read: {
				candidates: () => [music],
				nearFeedback: () => near,
			},
			settings: {
				accept: 0.6,
				low: 0.3,
				margin: 0.15,
				approve: 0.85,
				multi: 0.5,
				feedbackNear: 0.9,
				feedbackWeight: 2,
			},
			log: (event) => logged.push(event.name),
		},
		{
			state: {
				text: "静かな曲を作って",
				previousAgent: null,
				previousUser: null,
			},
			dynamic: [conversation],
			available: () => true,
			instructions: "選ぶ",
			signals: { intentChat: 0.2 },
		},
	);
	expect(sawText).toBe("静かな曲を作って");
	expect(result.decision).toMatchObject({
		row: 2,
		to: "run",
		candidate: { id: "music.create" },
	});
	expect(result.explain.conflict).toBe(false);
	expect(result.explain.conflicts).toEqual([]);
	expect(result.explain.intentChat).toBe(0.2);
	expect(logged).toEqual(["router.decided"]);
	expect(JSON.stringify(result.explain)).not.toContain("静かな曲");
});

test("corrections that disagree leave the probabilities as the scorer gave them", async () => {
	const result = await route(
		{
			embed: async () => ({ space, vectors: [[1, 0]] }),
			score: async () => ({
				choice: "music.create",
				probabilities: { "music.create": 0.7, "conversation.respond": 0.3 },
				scores: null,
				model: "scorer",
				headRevision: null,
				calibrationRevision: null,
			}),
			read: {
				candidates: () => [music],
				nearFeedback: () => [
					{ id: "a", wrongId: null, rightId: "music.create", similarity: 1 },
					{
						id: "b",
						wrongId: null,
						rightId: "conversation.respond",
						similarity: 1,
					},
				],
			},
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
		{
			state: { text: "曲", previousAgent: null, previousUser: null },
			dynamic: [conversation],
			available: () => true,
			instructions: "",
		},
	);
	expect(result.explain.conflict).toBe(true);
	expect(result.explain.conflicts).toEqual(["a", "b"]);
	expect(result.corrected[0]?.p).toBeCloseTo(0.7);
});

const settings = {
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
	feedbackNear: 0.9,
	feedbackWeight: 2,
};

test("an empty offer is a conversation and does not call the scorer", async () => {
	const result = await route(
		{
			embed: async () => ({ space, vectors: [[1, 0]] }),
			score: async () => {
				throw new Error("scored");
			},
			read: { candidates: () => [], nearFeedback: () => [] },
			settings,
		},
		{
			state: { text: "曲", previousAgent: null, previousUser: null },
			dynamic: [],
			available: () => true,
			instructions: "",
		},
	);
	expect(result.answer).toBeNull();
	expect(result.decision).toEqual({ row: 8, to: "conversation" });
	expect(result.explain).toMatchObject({
		offered: [],
		conflict: false,
		conflicts: [],
	});
});

test("passages fill a missing conversation and memory request", async () => {
	const result = await route(
		{
			embed: async () => ({ space, vectors: [[1, 0]] }),
			score: async (input) => {
				expect(input.criteria.map((criterion) => criterion.name)).toEqual([
					"conversation.respond",
					"memory.request",
					"music.create",
				]);
				expect(input.criteria[0]?.description).toBe("会話で返事する");
				expect(input.criteria[1]?.description).toBe("記憶を頼む");
				return {
					choice: "music.create",
					probabilities: {
						"conversation.respond": 0.2,
						"memory.request": 0.1,
						"music.create": 0.7,
					},
					scores: null,
					model: "scorer",
					headRevision: null,
					calibrationRevision: null,
				};
			},
			read: { candidates: () => [music], nearFeedback: () => [] },
			settings,
		},
		{
			state: { text: "曲", previousAgent: null, previousUser: null },
			dynamic: [],
			passages: { conversation: "会話で返事する", memory: "記憶を頼む" },
			available: () => true,
			instructions: "",
		},
	);
	expect(result.decision.row).toBe(2);
	expect(result.explain.offered).toEqual([
		"conversation.respond",
		"memory.request",
		"music.create",
	]);
});

test("a past choice is forwarded and does not change the offer", async () => {
	const result = await route(
		{
			embed: async () => ({ space, vectors: [[1, 0]] }),
			score: async () => ({
				choice: "music.create",
				probabilities: { "conversation.respond": 0.3, "music.create": 0.7 },
				scores: null,
				model: "scorer",
				headRevision: null,
				calibrationRevision: null,
			}),
			read: {
				candidates: (query) => {
					expect(query.fromHistory).toEqual(["music.create"]);
					return [{ ...music, fromHistory: true }];
				},
				nearFeedback: () => [],
			},
			settings,
		},
		{
			state: { text: "曲", previousAgent: null, previousUser: null },
			dynamic: [conversation],
			fromHistory: ["music.create"],
			available: () => true,
			instructions: "",
		},
	);
	expect(result.candidates[0]?.fromHistory).toBe(true);
	expect(result.decision).toMatchObject({
		row: 2,
		candidate: { card: { score: { fromHistory: true } } },
	});
});

test("a blank description rejects the request before the scorer", async () => {
	await expect(
		route(
			{
				embed: async () => ({ space, vectors: [[1, 0]] }),
				score: async () => {
					throw new Error("scored");
				},
				read: { candidates: () => [], nearFeedback: () => [] },
				settings,
			},
			{
				state: { text: "曲", previousAgent: null, previousUser: null },
				dynamic: [{ ...conversation, passage: "   " }],
				available: () => true,
				instructions: "",
			},
		),
	).rejects.toThrow("larm_invalid_route_request");
});

test("more stable candidates than the scorer accepts is a bad request", async () => {
	const many: Candidate[] = Array.from({ length: 129 }, (_, index) => ({
		...music,
		id: `c${index}`,
		title: `c${index}`,
	}));
	await expect(
		route(
			{
				embed: async () => ({ space, vectors: [[1, 0]] }),
				score: async () => {
					throw new Error("scored");
				},
				read: { candidates: () => many, nearFeedback: () => [] },
				settings,
			},
			{
				state: { text: "曲", previousAgent: null, previousUser: null },
				dynamic: [],
				available: () => true,
				instructions: "",
			},
		),
	).rejects.toThrow("larm_invalid_route_request");
});

test("a bad intent signal fails before the embedding", async () => {
	let embedded = false;
	await expect(
		route(
			{
				embed: async () => {
					embedded = true;
					return { space, vectors: [[1, 0]] };
				},
				score: async () => {
					throw new Error("scored");
				},
				read: { candidates: () => [], nearFeedback: () => [] },
				settings,
			},
			{
				state: { text: "曲", previousAgent: null, previousUser: null },
				dynamic: [conversation],
				available: () => true,
				instructions: "",
				signals: { intentChat: 2 },
			},
		),
	).rejects.toThrow("larm_invalid_route_request");
	expect(embedded).toBe(false);
});
