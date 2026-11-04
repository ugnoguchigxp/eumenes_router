import { expect, test } from "bun:test";
import {
	cardDigest,
	offerCandidates,
	parseCard,
	rerankDocument,
	type RouteCandidate,
	type Skipped,
} from "../src/index.ts";

test("a card digest follows the card text, and the reranker reads the first passage and five more", () => {
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
	expect(rerankDocument(body)).toBe(
		"作曲: 曲を作る 例: 作曲の依頼 / BGM / 静かな曲を作って",
	);
	expect(() => parseCard({ ...body, digest: "sha256:nope" })).toThrow(
		"router_card_invalid",
	);
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

test("a blank passage stays, and stable candidates are not cut at 128", () => {
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
	const skipped: Skipped[] = [];
	const offered = offerCandidates({
		searched: Array.from({ length: 130 }, (_, index) => tool(`c${index}`)),
		dynamic: [
			{ id: "conversation.respond", kind: "conversation", passage: "   " },
			{
				id: "t1.cancel",
				kind: "work",
				todo: "t1",
				operation: "cancel",
				title: "",
				passage: "仕事をやめる",
			},
		],
		skipped,
	});
	expect(offered).toHaveLength(131);
	expect(
		offered.find((candidate) => candidate.id === "conversation.respond")
			?.passage,
	).toBe("   ");
	expect(skipped).toEqual([{ id: "t1.cancel", reason: "criteria_limit" }]);
});

test("a long card is accepted when its digest matches", () => {
	const body = {
		id: "music.create",
		revision: "r".repeat(201),
		kind: "dedicated" as const,
		title: "あ".repeat(501),
		summary: "い".repeat(4001),
		useWhen: Array.from({ length: 40 }, (_, index) => `u${index}`),
		examples: Array.from({ length: 80 }, (_, index) => `e${index}`),
		impact: "create" as const,
	};
	expect(parseCard({ ...body, digest: cardDigest(body) }).revision).toBe(
		body.revision,
	);
	expect(() =>
		parseCard({
			...body,
			title: "",
			digest: cardDigest({ ...body, title: "" }),
		}),
	).toThrow("router_card_invalid");
});
