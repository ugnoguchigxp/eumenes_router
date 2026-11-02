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
	expect(result.corrected[0]?.p).toBeCloseTo(0.7);
});
