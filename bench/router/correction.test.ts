import { expect, test } from "bun:test";
import { bootMean, correctionStore, fuse, margin } from "./correction.ts";
import { keyOf } from "./variant-table.ts";

const unit = (xs: number[]) => { const n = Math.hypot(...xs); return xs.map((x) => x / n); };

test("a stored correction moves a near utterance through the router's feedback path", () => {
	const store = correctionStore("m", 3);
	store.add({ text: "a", right: "music.create", wrong: "music.library" }, unit([1, 0, 0]));
	const ranked: Array<[string, number]> = [["music.library", 0.6], ["music.create", 0.4]];
	const same = store.correct(ranked, unit([1, 0, 0]));
	expect(same.near).toBe(1);
	expect(same.ranked[0]![0]).toBe("music.create");
	const far = store.correct(ranked, unit([0, 1, 0]));
	expect(far.near).toBe(0);
	expect(far.ranked[0]![0]).toBe("music.library");
});

test("conflicting corrections cancel", () => {
	const store = correctionStore("m", 2);
	store.add({ text: "a", right: "x" }, unit([1, 0]));
	store.add({ text: "b", right: "y" }, unit([1, 0.001]));
	const r = store.correct([["z", 0.7], ["x", 0.2], ["y", 0.1]], unit([1, 0]));
	expect(r.conflict).toBe(true);
	expect(r.ranked[0]![0]).toBe("z");
});

test("fuse ranks by sr + w*rerank and the margin is the score gap", () => {
	const r = fuse([["a", 0.5], ["conversation.respond", 0.3], ["b", 0.2]], { a: 0.1, b: 0.9 }, 2, 0.18);
	expect(r[0]![0]).toBe("b");
	expect(margin(r)).toBeCloseTo(0.2 + 1.8 - (0.5 + 0.2), 6);
});

test("bootMean brackets the mean", () => {
	const b = bootMean([1, 0, 1, 1, 0, 1, 0, 1]);
	expect(b.mean).toBe(0.625);
	expect(b.lo).toBeLessThanOrEqual(b.mean);
	expect(b.hi).toBeGreaterThanOrEqual(b.mean);
});

test("the rule table matches a normalized variant the embedding misses", () => {
	const store = correctionStore("m", 2, { tau: 0.8 });
	store.add({ text: "ギットを開いて", right: "browser.operate", wrong: "web.search" }, unit([1, 0]), keyOf("ギットを開いて"));
	const ranked: Array<[string, number]> = [["web.search", 0.6], ["browser.operate", 0.4]];
	expect(store.correct(ranked, unit([0, 1])).ranked[0]![0]).toBe("web.search");
	const r = store.correct(ranked, unit([0, 1]), undefined, keyOf("ｇｉｔを開いてください"));
	expect(r.near).toBe(1);
	expect(r.ranked[0]![0]).toBe("browser.operate");
});
