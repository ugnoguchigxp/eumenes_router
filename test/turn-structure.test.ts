import { expect, test } from "bun:test";
import { parseTurnStructure, turnStructurePrompt } from "../src/index.ts";
import {
	routeStructured as nativeRouteStructured,
	type RoutePorts,
	type RouteTurn,
} from "../bench/legacy/route.ts";
import { routeStructuredFixture as routeStructured } from "./turn-response.fixture.ts";
import { parseTurnResponse } from "../src/turn-structure.ts";

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
		controls: [],
	});
	expect(prompt.version).toBe("turn-structure-v8");
	for (const [text, questions] of [
		["a".repeat(2001), []],
		["x", [...pending, ...pending]],
		["x", [{ ...pending[0]!, question: "" }]],
	] as const)
		expect(() => turnStructurePrompt(text, null, questions)).toThrow(
			"structure_input_invalid",
		);
});

test("native output contract carries finite references and requires one decision envelope", async () => {
	const text = "現在の回答";
	const controls = [{ ref: "t2.cancel", title: "別の仕事" }];
	const schema = turnStructurePrompt(
		text,
		null,
		pending,
		controls,
	).outputSchema;
	expect(schema).toMatchObject({
		type: "object",
		required: ["decision"],
		additionalProperties: false,
	});
	const branches = (
		schema["properties"] as { decision: { anyOf: Record<string, unknown>[] } }
	).decision.anyOf;
	expect(branches).toHaveLength(4);
	expect(JSON.stringify(schema)).toContain(
		JSON.stringify({ type: "string", enum: ["t7.answer"] }),
	);
	expect(JSON.stringify(schema)).toContain(
		JSON.stringify({ type: "string", enum: ["t2.cancel"] }),
	);
	expect(JSON.stringify(schema)).toContain(
		JSON.stringify({ type: "string", enum: [text] }),
	);
	const empty = turnStructurePrompt(text, null, []).outputSchema;
	expect(
		(empty["properties"] as { decision: { anyOf: unknown[] } }).decision.anyOf,
	).toHaveLength(2);
	const turn: RouteTurn = {
		state: { text, previousAgent: null, previousUser: null },
		dynamic: [],
		available: () => true,
		instructions: "",
	};
	let calls = 0;
	const ports = {
		embed: async () => {
			calls++;
			throw new Error("unexpected_embed");
		},
	} as unknown as RoutePorts;
	const raw = JSON.stringify({ decision: { requests: [] } });
	expect(parseTurnResponse(raw, text, [])).toEqual({
		kind: "conversation",
		requests: [],
	});
	expect(
		(
			await nativeRouteStructured(
				{
					...ports,
					analyze: async (prompt) => {
						expect(prompt.outputSchema).toEqual(empty);
						return raw;
					},
				},
				turn,
			)
		).decision.to,
	).toBe("conversation");
	for (const invalid of [
		'{"requests":[]}',
		'{"decision":{"requests":[]},"extra":true}',
		`prefix ${raw}`,
		"null",
	]) {
		expect(parseTurnResponse(invalid, text, [])).toBeNull();
		await expect(
			nativeRouteStructured({ ...ports, analyze: async () => invalid }, turn),
		).rejects.toThrow("structure_invalid");
	}
	expect(calls).toBe(0);
});

test("native requests reject missing, extra and ill-typed fields before routing", async () => {
	const text = "Create a note, then publish the result";
	const first = { text: "Create a note", target: null, inputs: [], after: [] };
	const second = {
		text: "publish the result",
		target: "the result",
		inputs: ["a note"],
		after: [0],
	};
	const wire = (request: unknown) =>
		JSON.stringify({ decision: { requests: [first, request] } });
	expect(parseTurnResponse(wire(second), text, [])?.requests).toEqual([
		first,
		second,
	]);
	const invalid = [
		...Object.keys(second).map((key) =>
			Object.fromEntries(
				Object.entries(second).filter(([name]) => name !== key),
			),
		),
		{ ...second, extra: true },
		{ ...second, text: 42 },
		{ ...second, target: [] },
		{ ...second, inputs: null },
		{ ...second, after: ["0"] },
	];
	const turn: RouteTurn = {
		state: { text, previousAgent: null, previousUser: null },
		dynamic: [],
		available: () => true,
		instructions: "",
	};
	let calls = 0;
	const unexpected = () => {
		calls++;
		throw new Error("unexpected_routing");
	};
	const ports = {
		embed: unexpected,
		rerank: unexpected,
	} as unknown as RoutePorts;
	for (const request of invalid) {
		await expect(
			nativeRouteStructured(
				{ ...ports, analyze: async () => wire(request) },
				turn,
			),
		).rejects.toThrow("structure_invalid");
	}
	expect(calls).toBe(0);
});

test("native response caps reject oversized input while preserving eight requests and 32 references each", async () => {
	const parts = Array.from({ length: 8 }, (_, i) => `Task ${i}`);
	const inputs = Array.from({ length: 32 }, (_, i) => `source-${i}`);
	const text = [...parts, ...inputs].join(" ");
	const requests = parts.map((part, i) => ({
		text: part,
		target: null,
		inputs,
		after: i > 0 ? [i - 1] : [],
	}));
	const raw = JSON.stringify({ decision: { requests } }).padEnd(65_536);
	expect(parseTurnResponse(raw, text, [])?.requests).toEqual(requests);
	const repeatedText = "x".repeat(2_000);
	const oversizedReferences = (count: number) =>
		JSON.stringify({
			decision: {
				requests: [
					{
						text: "x",
						target: null,
						inputs: Array(count).fill("x"),
						after: [],
					},
				],
			},
		});
	let calls = 0;
	const unexpected = () => {
		calls++;
		throw new Error("unexpected_routing");
	};
	const ports = {
		embed: unexpected,
		rerank: unexpected,
	} as unknown as RoutePorts;
	for (const [source, response] of [
		[text, raw + " "],
		[repeatedText, oversizedReferences(33)],
		[repeatedText, oversizedReferences(256)],
	] as const) {
		await expect(
			nativeRouteStructured(
				{ ...ports, analyze: async () => response },
				{
					state: { text: source, previousAgent: null, previousUser: null },
					dynamic: [],
					available: () => true,
					instructions: "",
				},
			),
		).rejects.toThrow("structure_invalid");
	}
	expect(calls).toBe(0);
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

test("cancellation accepts only a supplied control reference and literal text, never a mixed envelope", () => {
	const text = "その仕事を取り消してください";
	const controls = [{ ref: "t2.cancel", title: "任意の仕事" }];
	const control = { ref: "t2.cancel", text };
	expect(
		parseTurnStructure(JSON.stringify({ control }), text, pending, controls),
	).toEqual({ kind: "control", ...control, requests: [] });
	for (const value of [
		{ control: { ...control, ref: "t3.cancel" } },
		{ control: { ...control, text: "別の発言" } },
		{ control: { ...control, operation: "approve" } },
		{ control, requests: [] },
		{ control, answer: { ref: "t7.answer", text } },
	])
		expect(
			parseTurnStructure(JSON.stringify(value), text, pending, controls),
		).toBeNull();
	expect(
		parseTurnStructure(JSON.stringify({ control }), text, pending, []),
	).toBeNull();
	expect(
		JSON.parse(turnStructurePrompt(text, null, pending, controls).user)
			.controls,
	).toEqual(controls);
	for (const invalid of [
		Array.from({ length: 7 }, (_, i) => ({
			ref: `t${i}.cancel`,
			title: "仕事",
		})),
		[...controls, ...controls],
		[{ ref: "t7.answer", title: "仕事" }],
		[{ ref: "", title: "仕事" }],
		[{ ref: "t2.cancel", title: "" }],
	])
		expect(() => turnStructurePrompt(text, null, pending, invalid)).toThrow(
			"structure_input_invalid",
		);
});

test("answer and cancellation cannot discard the remainder of the current utterance", () => {
	const controls = [{ ref: "t2.cancel", title: "仕事" }];
	const mixed = "15秒です。それとは別に天気を調べてください。";
	expect(
		parseTurnStructure(
			JSON.stringify({ answer: { ref: "t7.answer", text: "15秒です" } }),
			mixed,
			pending,
			controls,
		),
	).toBeNull();
	const deferred = "その話は後にして、少し話を聞いてください。";
	expect(
		parseTurnStructure(
			JSON.stringify({
				control: { ref: "t2.cancel", text: "その話は後にして" },
			}),
			deferred,
			pending,
			controls,
		),
	).toBeNull();
	for (const key of ["answer", "control"]) {
		expect(
			parseTurnStructure(
				JSON.stringify({
					[key]: {
						ref: key === "answer" ? "t7.answer" : "t2.cancel",
						text: "",
					},
				}),
				"",
				pending,
				controls,
			),
		).toBeNull();
	}
});

test("cancellation uses the exact work/cancel candidate without retrieval; stale and other operations are refused", async () => {
	let calls = 0;
	const ports = {
		embed: async () => {
			calls++;
			throw new Error("unexpected_embed");
		},
	} as unknown as RoutePorts;
	const candidate = {
		id: "t2.cancel",
		kind: "work" as const,
		operation: "cancel" as const,
		todo: "t2",
		title: "仕事",
		passage: "仕事の取消",
	};
	const turn: RouteTurn = {
		state: {
			text: "取り消してください",
			previousAgent: null,
			previousUser: null,
		},
		pending: [],
		controls: [{ ref: candidate.id, title: candidate.title }],
		dynamic: [candidate],
		available: () => true,
		instructions: "",
	};
	const p = {
		...ports,
		analyze: async () =>
			JSON.stringify({ control: { ref: candidate.id, text: turn.state.text } }),
	};
	expect((await routeStructured(p, turn)).decision).toEqual({
		row: 6,
		to: "run",
		candidate,
		announce: "none",
	});
	for (const dynamic of [[], [{ ...candidate, operation: "check" as const }]])
		await expect(routeStructured(p, { ...turn, dynamic })).rejects.toThrow(
			"structure_reference_unavailable",
		);
	expect(calls).toBe(0);
});
