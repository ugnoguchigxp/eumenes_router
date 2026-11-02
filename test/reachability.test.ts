import { expect, test } from "bun:test";
import { checkReachability } from "../src/index.ts";

test("a card whose Recall@1 falls by 0.02 or more is refused", () => {
	const report = checkReachability({
		cards: [{ id: "music.create" }, { id: "music.library" }],
		eval: [
			{
				cardId: "music.create",
				offered: ["music.create"],
				top1: "music.create",
			},
			{
				cardId: "music.create",
				offered: ["music.library"],
				top1: "music.library",
			},
			{
				cardId: "music.library",
				offered: ["music.library"],
				top1: "music.library",
			},
			{
				cardId: "music.library",
				offered: ["music.create", "music.library"],
				top1: "music.create",
			},
		],
		before: { "music.create": 1, "music.library": 0.5 },
	});
	expect(report.byCard).toEqual([
		{
			id: "music.create",
			n: 2,
			recallAtFrame: 0.5,
			recallAt1: 0.5,
			delta: 0.5,
		},
		{
			id: "music.library",
			n: 2,
			recallAtFrame: 1,
			recallAt1: 0.5,
			delta: 0,
		},
	]);
	expect(report.refused).toBe(true);
	expect(report.regressions).toEqual([
		{ id: "music.create", before: 1, after: 0.5 },
	]);
});

test("a card with no cases is not a regression", () => {
	const report = checkReachability({
		cards: [{ id: "new.tool" }],
		eval: [],
		before: { "new.tool": 1 },
	});
	expect(report.byCard[0]).toMatchObject({
		n: 0,
		recallAt1: null,
		delta: null,
	});
	expect(report.refused).toBe(false);
});
