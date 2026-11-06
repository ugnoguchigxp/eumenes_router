import { expect, test } from "bun:test";
import { auditDataset } from "./audit.ts";
import type { StoredLabel, Utterance } from "./data.ts";

const u = (id: string, conversationId: string, text: string): Utterance => ({
	id,
	conversationId,
	text,
	seq: 0,
	previousAgent: null,
	previousUser: null,
	hints: {},
});
const label = (id: string, split: "dev" | "test"): StoredLabel => ({
	id,
	split,
	gold: "a",
	status: "reviewed",
});

test("the split audit connects conversations, normalized identical texts and explicit source families transitively", () => {
	const utterances = [
		u("1", "c1", "同文"),
		u("2", "c1", "別"),
		u("3", "c2", "同文"),
		u("4", "c3", "言い換え"),
		u("5", "c4", "全角Ａ"),
	];
	const labels = new Map(
		[
			label("1", "dev"),
			label("3", "test"),
			label("4", "test"),
			label("5", "dev"),
		].map((l) => [l.id, l]),
	);
	const got = auditDataset(utterances, labels, [{ id: "4", sourceId: "2" }]);
	expect(got).toMatchObject({
		ok: false,
		crossSplitComponents: 1,
		crossSplitTexts: 1,
		unlabeled: 1,
	});
	expect(got.humanReviewProvenance).toBe("not_verified");
	expect(JSON.stringify(got)).not.toContain("同文");
	const separate = auditDataset(
		[u("a", "x", "全角Ａ"), u("b", "y", "全角A")],
		new Map([
			["a", label("a", "dev")],
			["b", label("b", "test")],
		]),
	);
	expect(separate.crossSplitTexts).toBe(1);
	const valid = auditDataset(
		[u("a", "x", "one"), u("b", "y", "two")],
		new Map([
			["a", label("a", "dev")],
			["b", label("b", "test")],
		]),
	);
	expect(valid.ok).toBe(true);
	expect(
		auditDataset(
			[u("a", "x", "one")],
			new Map([["missing", label("missing", "test")]]),
			[{ id: "a", sourceId: "missing" }],
		),
	).toMatchObject({ ok: false, missingUtterances: 1, unknownLineage: 1 });
});
