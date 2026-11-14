import { expect, test } from "bun:test";
import { responsesPort } from "../bench/router/selection.ts";
import {
	CONVERSATION_ID,
	MEMORY_ID,
	routeWithSelection,
	type Analyze,
	type NearFeedback,
	type SelectionPorts,
	type SelectionTurn,
} from "../src/index.ts";
import type { RouterCard } from "../src/sqlite.ts";

const space = {
	modelId: "fixture",
	revision: "1",
	artifactDigest: "fixture",
	dimension: 2,
};

function card(
	id: string,
	score = 1,
	kind: RouterCard["kind"] = "dedicated",
): RouterCard {
	return {
		id,
		kind,
		revision: "1",
		title: id,
		summary: `${id} の説明`,
		useWhen: [],
		examples: [],
		impact: "create",
		passages: [[score, 0]],
	};
}

const turn = (text: string): SelectionTurn => ({
	state: { text, previousAgent: null, previousUser: null },
	available: () => true,
});

function ports(
	cards: RouterCard[],
	select: Analyze,
	near: NearFeedback[] = [],
): SelectionPorts {
	return {
		embed: async (texts) => ({ space, vectors: texts.map(() => [1, 0]) }),
		read: {
			cards: () => cards,
			lexical: () => new Map(),
			nearFeedback: () => near,
		},
		select,
	};
}

function response(
	...selections: Array<{ kind: string; id?: string; question?: string }>
) {
	return JSON.stringify({
		selections: Object.fromEntries(
			selections.map((selection, i) => [i, selection]),
		),
	});
}

const fixtureRequest = (text: string, after: number[] = []) => ({
	text,
	target: null,
	inputs: [],
	after,
});
const structure = (...requests: ReturnType<typeof fixtureRequest>[]) =>
	JSON.stringify({ decision: { requests } });

test("tools-only sends five ranked candidates with existing match scores, including a correction within the cap", async () => {
	const cards = [
		...Array.from({ length: 6 }, (_, i) => card(`tool.${i + 1}`, 6 - i)),
		card(MEMORY_ID, 50),
		card(CONVERSATION_ID, 100),
		card("unavailable", 200),
	];
	const utterance = {
		...turn("担当を探す"),
		available: (id: string) => id !== "unavailable",
		retained: ["tool.5", "tool.6", "unavailable", MEMORY_ID],
	};
	const result = await routeWithSelection(
		{
			...ports(
				cards,
				async ({ user, outputSchema, version }) => {
					expect(version).toBe("route-selection-v1");
					const candidateIds = [
						"tool.1",
						"tool.2",
						"tool.3",
						"tool.5",
						"tool.6",
					];
					const sent = JSON.parse(user).requests[0].candidates;
					expect(sent.map((c: { id: string }) => c.id)).toEqual(candidateIds);
					expect(sent.map((c: { searchRank: number }) => c.searchRank)).toEqual(
						[1, 2, 3, 5, 6],
					);
					expect(sent.map((c: { matchScore: number }) => c.matchScore)).toEqual(
						[0.5, 0.4, 0.3, 0.1, 0],
					);
					expect(JSON.stringify(outputSchema)).not.toContain('"conversation"');
					return response({ kind: "candidate", id: "tool.6" });
				},
				[
					{
						id: "feedback",
						wrongId: "tool.1",
						rightId: "tool.6",
						similarity: 1,
					},
				],
			),
			analyze: async () => {
				throw new Error("unexpected structure");
			},
		},
		utterance,
		{ mode: "tools-only" },
	);
	expect(result.decision).toMatchObject({
		to: "run",
		candidate: { id: "tool.6" },
	});
	expect(result.parts[0]!.candidates).toHaveLength(5);
});

test("conversation is the default, with an early structure result or an explicit selection outside the five slots", async () => {
	const cards = ["a", "b", "c", "d", "e"].map((id) => card(id));
	const talk = await routeWithSelection(
		{
			...ports(cards, async () => structure()),
			embed: async () => {
				throw new Error("unexpected retrieval");
			},
		},
		turn("こんにちは"),
	);
	expect(talk.decision.to).toBe("conversation");
	const result = await routeWithSelection(
		ports(cards, async ({ version, user, outputSchema }) => {
			if (version.startsWith("turn-structure"))
				return structure(fixtureRequest("説明して"));
			expect(JSON.parse(user).requests[0].candidates).toHaveLength(5);
			expect(JSON.stringify(outputSchema)).toContain('"conversation"');
			return response({ kind: "conversation" });
		}),
		turn("説明して"),
	);
	expect(result.decision.to).toBe("conversation");
});

test("tools-only returns no match for an empty offer, and validates all other outcomes", async () => {
	const options = { mode: "tools-only" as const };
	const request = turn("担当を探す");
	const empty = await routeWithSelection(
		ports([], async () => {
			throw new Error("unexpected model call");
		}),
		request,
		options,
	);
	expect(empty.decision).toMatchObject({
		to: "unresolved",
		reason: "no_candidate",
	});
	const cards = [card("a")];
	const noMatch = await routeWithSelection(
		ports(cards, async () => response({ kind: "no_match" })),
		request,
		options,
	);
	expect(noMatch.decision).toMatchObject({
		to: "unresolved",
		reason: "no_candidate",
		requests: [{ options: [] }],
	});
	const clarify = await routeWithSelection(
		ports(cards, async () =>
			response({ kind: "clarify", question: "どの対象ですか？" }),
		),
		request,
		options,
	);
	expect(clarify.decision).toMatchObject({
		to: "clarify",
		question: "どの対象ですか？",
	});
	for (const raw of [
		response({ kind: "conversation" }),
		response({ kind: "candidate", id: "missing" }),
		response({ kind: "no_match", id: "a" }),
		response({ kind: "clarify", question: " " }),
		'{"selections":{"1":{"kind":"no_match"}}}',
		'{"selections":{},"extra":true}',
	]) {
		await expect(
			routeWithSelection(
				ports(cards, async () => raw),
				request,
				options,
			),
		).rejects.toThrow("route_selection_invalid_response");
	}
});

test("compound requests share one model call and cannot dispatch a subset", async () => {
	const request = turn("資料を調べて、結果をまとめて");
	const cards = [card("lookup"), card("summary")];
	const analyze = async () =>
		structure(
			fixtureRequest("資料を調べて"),
			fixtureRequest("結果をまとめて", [0]),
		);
	for (const second of ["candidate", "no_match"] as const) {
		let calls = 0;
		const result = await routeWithSelection(
			{
				...ports(cards, async ({ user }) => {
					calls++;
					expect(
						JSON.parse(user).requests.map((p: { index: string }) => p.index),
					).toEqual(["0", "1"]);
					return response(
						{ kind: "candidate", id: "lookup" },
						second === "candidate"
							? { kind: second, id: "summary" }
							: { kind: second },
					);
				}),
				analyze,
			},
			request,
		);
		expect(calls).toBe(1);
		if (second === "candidate")
			expect(result.decision).toMatchObject({
				to: "pipeline",
				steps: [
					{ candidate: { id: "lookup" }, after: [] },
					{ candidate: { id: "summary" }, after: [0] },
				],
			});
		else
			expect(result.decision).toMatchObject({
				to: "unresolved",
				reason: "no_candidate",
			});
	}
});

test("per-request validation rejects an ID that was offered only for a different request", async () => {
	const request = turn("資料を調べて、結果をまとめて");
	let current = "";
	const base = ports([], async () =>
		response(
			{ kind: "candidate", id: "summary" },
			{ kind: "candidate", id: "summary" },
		),
	);
	await expect(
		routeWithSelection(
			{
				...base,
				analyze: async () =>
					structure(
						fixtureRequest("資料を調べて"),
						fixtureRequest("結果をまとめて"),
					),
				embed: async (texts) => {
					current = texts[0]!;
					return base.embed(texts);
				},
				read: {
					...base.read,
					cards: () =>
						current === "資料を調べて" ? [card("lookup")] : [card("summary")],
				},
			},
			request,
		),
	).rejects.toThrow("route_selection_invalid_response");
});

test("an explicit cancellation uses the existing finite reference, and state-changing tool choices carry the existing handoff row", async () => {
	const base = ports(
		[{ ...card("edit"), impact: "modify_existing" }],
		async () => response({ kind: "candidate", id: "edit" }),
	);
	const edited = await routeWithSelection(base, turn("資料を編集して"), {
		mode: "tools-only",
	});
	expect(edited.decision).toMatchObject({ to: "run", row: 4, announce: "try" });

	const text = "取り消して";
	const candidate = {
		id: "t1.cancel",
		kind: "work" as const,
		todo: "t1",
		operation: "cancel" as const,
		title: "資料",
		passage: "資料の処理を取り消す",
	};
	const input = {
		...turn(text),
		controls: [{ title: "資料", ref: candidate.id }],
		dynamic: [candidate],
	};
	const cancel = await routeWithSelection(
		{
			...base,
			analyze: async () =>
				JSON.stringify({ decision: { control: { text, ref: candidate.id } } }),
		},
		input,
	);
	expect(cancel.decision).toEqual({
		to: "run",
		row: 6,
		candidate,
		announce: "none",
	});
});

test("aborting rejects a selection even when the model port delivers a late response", async () => {
	const stop = new AbortController();
	const reason = new Error("deadline");
	const result = routeWithSelection(
		ports([card("a")], async () => {
			stop.abort(reason);
			return response({ kind: "candidate", id: "a" });
		}),
		turn("担当を探す"),
		{ mode: "tools-only", signal: stop.signal },
	);
	await expect(result).rejects.toBe(reason);
});

test("the OpenAI adapter sends a strict schema and accepts only completed JSON output", async () => {
	const prompt = {
		version: "fixture",
		system: "system",
		user: "data",
		outputSchema: { type: "object" },
	};
	const signal = new AbortController().signal;
	const raw = response({ kind: "candidate", id: "a" });
	for (const mode of ["text", "refusal", "incomplete"] as const) {
		const select = responsesPort({
			apiKey: "fixture",
			model: "fixture",
			signal,
			request: (async (url, init) => {
				expect(url).toBe("https://api.openai.com/v1/responses");
				expect(init?.signal).toBe(signal);
				expect(JSON.parse(String(init?.body))).toMatchObject({
					store: false,
					reasoning: { effort: "none" },
					model: "fixture",
					instructions: prompt.system,
					input: prompt.user,
					text: {
						format: {
							type: "json_schema",
							strict: true,
							schema: prompt.outputSchema,
						},
					},
				});
				return Response.json({
					status: mode === "incomplete" ? "incomplete" : "completed",
					output: [
						{ type: "reasoning" },
						{
							type: "message",
							role: "assistant",
							status: "completed",
							content: [
								mode === "refusal"
									? { type: "refusal" }
									: { type: "output_text", text: raw },
							],
						},
					],
				});
			}) as typeof fetch,
		});
		if (mode === "text") expect(await select(prompt)).toBe(raw);
		else await expect(select(prompt)).rejects.toThrow("selection_provider_");
	}
});
