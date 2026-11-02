import { expect, test } from "bun:test";
import {
	cardDigest,
	offerCandidates,
	parseCard,
	routerPassage,
	type RouteCandidate,
	type Skipped,
} from "../src/index.ts";
import {
	CANDIDATE_SLOTS,
	closestSimilarities,
	rankBy,
	slotted,
} from "../src/retrieval/rank.ts";

test("a card digest follows the card text, and the router passage keeps two use cases", () => {
	const body = {
		id: "music.create",
		revision: "r1",
		kind: "dedicated" as const,
		title: "作曲",
		summary: "曲を作る",
		useWhen: ["作曲の依頼", "BGM"],
		examples: ["静かな曲を作って"],
		impact: "create" as const,
	};
	expect(cardDigest(body).startsWith("sha256:")).toBe(true);
	expect(cardDigest({ ...body, examples: ["別の例"] })).not.toBe(
		cardDigest(body),
	);
	expect(routerPassage(body)).toBe("作曲: 曲を作る（作曲の依頼／BGM）");
	expect(() => parseCard({ ...body, digest: "sha256:nope" })).toThrow(
		"router_card_invalid",
	);
});

test("slots keep a near pipeline and drop one farther than `near`", () => {
	const cards = [
		{ id: "a", kind: "dedicated" as const, similarity: 0.9 },
		{ id: "b", kind: "dedicated" as const, similarity: 0.88 },
		{ id: "c", kind: "pipeline" as const, similarity: 0.86 },
		{ id: "d", kind: "pipeline" as const, similarity: 0.8 },
		{ id: "e", kind: "general" as const, similarity: 0.7 },
	];
	expect(
		slotted(
			cards,
			(card) => card.similarity,
			(card) => card.kind,
			CANDIDATE_SLOTS,
		).map((card) => card.id),
	).toEqual(["a", "b", "c"]);
});

test("the closest passage of a card is the one the rank uses", () => {
	const similarity = closestSimilarities(
		[
			{ id: "a", values: [1, 0] },
			{ id: "a", values: [0, 1] },
			{ id: "b", values: [0.6, 0.8] },
		],
		[1, 0],
		new Set(["a", "b"]),
	);
	expect(similarity.get("a")).toBe(1);
	expect(similarity.get("b")).toBeCloseTo(0.6);
	expect(
		rankBy([{ id: "b" }, { id: "a" }], similarity).map((card) => card.id),
	).toEqual(["a", "b"]);
});

test("search hits sort with the conversation by id, and dynamic candidates follow", () => {
	const tool = (id: string): RouteCandidate => ({
		id,
		kind: "toolchain",
		passage: `${id} の説明`,
		card: {
			id,
			title: id,
			score: { rank: 1, ftsRank: null, similarity: 1, fromHistory: false },
		},
		choice: { id, title: id },
	});
	const cancel: RouteCandidate = {
		id: "t1.cancel",
		kind: "work",
		todo: "t1",
		operation: "cancel",
		title: "",
		passage: "仕事をやめる",
	};
	const skipped: Skipped[] = [];
	const offered = offerCandidates({
		searched: [tool("music.create")],
		dynamic: [
			{
				id: "conversation.respond",
				kind: "conversation",
				passage: "会話で返事する",
			},
			{ id: "memory.request", kind: "memory", passage: "記憶を頼む" },
			cancel,
			{ ...cancel, id: "bad id" },
		],
		skipped,
	});
	expect(offered.map((candidate) => candidate.id)).toEqual([
		"conversation.respond",
		"memory.request",
		"music.create",
		"t1.cancel",
	]);
	expect(skipped).toEqual([{ id: "bad id", reason: "invalid_name" }]);
});
