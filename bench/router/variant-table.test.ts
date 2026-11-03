import { expect, test } from "bun:test";
import { dice, keyOf, surfaceKey, tableScore, tuneTau } from "./variant-table.ts";

test("normalization folds width, case, katakana, punctuation and polite endings", () => {
	expect(surfaceKey("ＧｉｔＨｕｂを開いてください。")).toBe(surfaceKey("githubを開いて"));
	expect(surfaceKey("ギットを使う")).toBe(surfaceKey("gitを使う"));
	expect(surfaceKey("テンキ を 教えて！")).toBe("てんきを教え");
});
test("reading key matches all-hiragana and kanji spellings", () => {
	const a = keyOf("天気を教えて", "てんきをおしえて"), b = keyOf("てんきをおしえて");
	expect(tableScore(a, b)).toBe(1);
});
test("dice is 1 for equal, 0 for disjoint, partial otherwise", () => {
	expect(dice("abcd", "abcd")).toBe(1);
	expect(dice("abcd", "wxyz")).toBe(0);
	expect(dice("てんきおしえ", "てんきしらべ")).toBeGreaterThan(0.2);
});
test("tuneTau picks the smallest τ under the dev false-match bound", () => {
	const dev = [{ key: keyOf("あいうえお"), gold: "a" }, { key: keyOf("あいうえか"), gold: "b" }, { key: keyOf("さしすせそ"), gold: "c" }];
	const r = tuneTau(dev, 0.0);
	expect(r.tau).toBeGreaterThan(0.75);
});
