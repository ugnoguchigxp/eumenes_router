import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	parseStructure,
	STRUCTURE_PROMPT,
	structurePrompt,
} from "../bench/legacy/structure.ts";
import { routedTexts } from "../src/index.ts";

test("the prompt is the one the structure was measured with (s3.py), to the character", () => {
	const source = readFileSync(
		"bench/router/experiments/structure/s3.py",
		"utf8",
	);
	const measured = /SYSTEM = """([\s\S]*?)"""/.exec(source)![1];
	expect(STRUCTURE_PROMPT.system).toBe(measured!);
	expect(STRUCTURE_PROMPT.version).toBe("structure-v1");
});

test("the turn message cuts the utterance at 2000 and the previous turn at 400 code points", () => {
	const long = "🎵".repeat(2001);
	const user = structurePrompt(long, "あ".repeat(401)).user;
	expect(
		user.startsWith(`直前のエージェントの発言: ${"あ".repeat(400)}\n発言: `),
	).toBe(true);
	expect(Array.from(user.split("発言: ").at(-1)!).length).toBe(2000);
	expect(structurePrompt("曲を作って", null).user).toBe("発言: 曲を作って");
});

test("an answer is read from its first { to its last }, and only a structure of this utterance passes", () => {
	const text = "この音楽に合う画像を作って";
	expect(
		parseStructure(
			'前置き {"requests":[{"text":"画像を作って","target":"画像","inputs":["この音楽"],"after":[]}]} 後書き',
			text,
		),
	).toEqual({
		requests: [
			{ text: "画像を作って", target: "画像", inputs: ["この音楽"], after: [] },
		],
	});
	expect(parseStructure('{"requests":[]}', text)).toEqual({ requests: [] });
	const refused = [
		"no json",
		'{"requests":"x"}',
		'{"requests":[{"text":"音楽を作って"}]}',
		'{"requests":[{"text":"画像を作って","inputs":null}]}',
		'{"requests":[{"text":"画像を作って","inputs":[""]}]}',
		'{"requests":[{"text":" ","inputs":[]}]}',
		'{"requests":[{"text":"画像を作って","after":[0]}]}',
		'{"requests":[{"text":"画像を作って","target":"絵"}]}',
		`{"requests":[${Array(9).fill('{"text":"画像"}').join(",")}]}`,
	];
	for (const raw of refused) expect(parseStructure(raw, text)).toBeNull();
});

test("routed texts: the whole utterance, the masked one, or the parts with a borrowed predicate", () => {
	const one = (inputs: string[]) => ({
		requests: [{ text: "画像を作って", target: "画像", inputs, after: [] }],
	});
	expect(routedTexts("この音楽に合う画像を作って", null)).toEqual([
		"この音楽に合う画像を作って",
	]);
	expect(routedTexts("画像を作って", one([]))).toEqual(["画像を作って"]);
	expect(
		routedTexts("この音楽に合う画像を作って、この音楽で", one(["この音楽"])),
	).toEqual(["これに合う画像を作って、これで"]);
	expect(routedTexts("x", { requests: [] })).toEqual([]);
	expect(
		routedTexts("曲と画像を作って", {
			requests: [
				{ text: "曲", target: "曲", inputs: [], after: [] },
				{ text: "画像を作って", target: "画像", inputs: [], after: [] },
			],
		}),
	).toEqual(["曲を作って", "画像を作って"]);
});

test("masking protects the LLM's target occurrence, merges overlapping references and does not replace inserted words", () => {
	for (const noun of ["画像", "文書", "🎵", "item"]) {
		const text = `${noun}を元に${noun}を作って`;
		const request = {
			text: `${noun}を作って`,
			target: noun,
			inputs: [noun],
			after: [],
		};
		const s = parseStructure(JSON.stringify({ requests: [request] }), text);
		expect(s).not.toBeNull();
		expect(routedTexts(text, s)).toEqual([`これを元に${noun}を作って`]);
	}
	const text = "この画像から画像を作って";
	expect(
		routedTexts(text, {
			requests: [
				{
					text: "画像を作って",
					target: "画像",
					inputs: ["この画像", "画像", "これ"],
					after: [],
				},
			],
		}),
	).toEqual(["これから画像を作って"]);
	const ambiguous = "画像と画像を使って";
	expect(
		routedTexts(ambiguous, {
			requests: [
				{ text: ambiguous, target: "画像", inputs: ["画像"], after: [] },
			],
		}),
	).toEqual([ambiguous]);
});
