import { expect, test } from "bun:test";
import {
	parseTurnStructure,
	turnStructurePrompt,
	routeStructured,
	type RoutePorts,
	type RouteTurn,
} from "../src/index.ts";

const pending = [
	{ ref: "t7.answer", title: "任意の仕事", question: "どの対象ですか？" },
];
test("answer binds only a supplied reference and literal current text", () => {
	for (const text of ["15秒です", "焼き用のほう", "item β", "🌱"]) {
		expect(
			parseTurnStructure(
				JSON.stringify({ answer: { ref: "t7.answer", text } }),
				text,
				pending,
			),
		).toEqual({ kind: "answer", ref: "t7.answer", text, requests: [] });
		for (const answer of [
			{ ref: "t8.answer", text },
			{ ref: "t7.answer", text: "別の本文" },
			{ ref: "t7.answer", text, command: "execute" },
		])
			expect(
				parseTurnStructure(JSON.stringify({ answer }), text, pending),
			).toBeNull();
		expect(
			parseTurnStructure(
				JSON.stringify({ answer: { ref: "t7.answer", text } }),
				text,
				[],
			),
		).toBeNull();
	}
});

test("four alternatives reject mixed envelopes, non-JSON, invalid DAG and invented remainder", () => {
	expect(parseTurnStructure('{"requests":[]}', "相談したい", pending)).toEqual({
		kind: "conversation",
		requests: [],
	});
	expect(
		parseTurnStructure(
			'{"clarify":{"question":"どちらの仕事ですか？","unhandled":["15秒です"]}}',
			"15秒です",
			pending,
		),
	).toMatchObject({ kind: "clarify", unhandled: ["15秒です"] });
	for (const raw of [
		"{}",
		'prefix {"requests":[]}',
		'{"requests":[],"answer":{"ref":"t7.answer","text":"15秒です"}}',
		'{"clarify":{"question":"？","unhandled":["存在しない依頼"]}}',
		'{"requests":[{"text":"15秒です","after":[0]}]}',
	])
		expect(parseTurnStructure(raw, "15秒です", pending)).toBeNull();
});

test("runtime data is JSON and input limits reject the whole turn before analysis", () => {
	const prompt = turnStructurePrompt("今の発言", "前の返答", pending);
	expect(JSON.parse(prompt.user)).toEqual({
		text: "今の発言",
		previousAgent: "前の返答",
		pending,
	});
	expect(prompt.version).toBe("turn-structure-v2");
	for (const [text, questions] of [
		["a".repeat(2001), []],
		["x", [...pending, ...pending]],
		["x", [{ ...pending[0]!, question: "" }]],
	] as const)
		expect(() => turnStructurePrompt(text, null, questions)).toThrow(
			"structure_input_invalid",
		);
});

test("answers and clarification do not call retrieval or scoring; stale references fail closed", async () => {
	let called = 0;
	const ports = {
		embed: async () => {
			called++;
			throw new Error("unexpected_embed");
		},
	} as unknown as RoutePorts;
	const candidate = {
		id: "t7.answer",
		kind: "pending" as const,
		operation: "answer" as const,
		todo: "t7",
		title: "任意の仕事",
		passage: "質問へ答える",
	};
	const turn: RouteTurn = {
		state: { text: "15秒です", previousAgent: null, previousUser: null },
		pending,
		dynamic: [candidate],
		available: () => true,
		instructions: "",
	};
	const answer = await routeStructured(
		{
			...ports,
			analyze: async () => '{"answer":{"ref":"t7.answer","text":"15秒です"}}',
		},
		turn,
	);
	expect(answer.decision).toMatchObject({
		to: "run",
		candidate,
		announce: "none",
	});
	const clarification = await routeStructured(
		{
			...ports,
			analyze: async () =>
				'{"clarify":{"question":"どちらですか？","unhandled":["15秒です"]}}',
		},
		turn,
	);
	expect(clarification.decision.to).toBe("clarify");
	await expect(
		routeStructured(
			{
				...ports,
				analyze: async () => '{"answer":{"ref":"t7.answer","text":"15秒です"}}',
			},
			{ ...turn, dynamic: [] },
		),
	).rejects.toThrow("structure_reference_unavailable");
	await expect(
		routeStructured(
			{
				...ports,
				analyze: async () => {
					throw new Error("timeout");
				},
			},
			turn,
		),
	).rejects.toThrow("timeout");
	expect(called).toBe(0);
});
