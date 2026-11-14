import { parseArgs } from "node:util";
import {
	cardPassages,
	routeWithSelection,
	type Analyze,
	type Card,
	type SelectionMode,
} from "../../src/index.ts";
import type { RouterCard } from "../../src/sqlite.ts";
import exampleCards from "../fixtures/example/cards.json";
import { fakeProvider } from "./embed.ts";

export function responsesPort(options: {
	apiKey: string;
	model: string;
	signal: AbortSignal;
	request?: typeof fetch;
}): Analyze {
	const request = options.request ?? fetch;
	return async ({ version, system, user, outputSchema }) => {
		const response = await request("https://api.openai.com/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${options.apiKey}`,
			},
			signal: options.signal,
			body: JSON.stringify({
				model: options.model,
				instructions: system,
				input: user,
				store: false,
				max_output_tokens: 2048,
				reasoning: { effort: "none" },
				text: {
					format: {
						type: "json_schema",
						name: version,
						strict: true,
						schema: outputSchema,
					},
				},
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`selection_http_${response.status}`);
		}
		const body = (await response.json().catch(() => {
			options.signal.throwIfAborted();
			throw new Error("selection_provider_invalid_output");
		})) as {
			status?: string;
			output?: Array<{
				type?: string;
				role?: string;
				status?: string;
				content?: Array<{ type?: string; text?: string }>;
			}>;
		} | null;
		if (body?.status !== "completed" || !Array.isArray(body.output))
			throw new Error("selection_provider_incomplete");
		const messages = body.output.filter((item) => item?.type !== "reasoning");
		const message = messages[0];
		const output = message?.content?.[0];
		if (
			messages.length !== 1 ||
			message?.type !== "message" ||
			message.role !== "assistant" ||
			message.status !== "completed" ||
			!Array.isArray(message.content) ||
			message.content.length !== 1 ||
			output?.type !== "output_text" ||
			typeof output.text !== "string"
		)
			throw new Error("selection_provider_invalid_output");
		return output.text;
	};
}

// Manual smoke path with the published synthetic catalog and local fake embeddings.
async function main() {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			text: { type: "string" },
			mode: { type: "string", default: "conversation" },
			model: { type: "string" },
		},
	});
	const { text, model } = values;
	const mode = values.mode as SelectionMode;
	if (
		!text?.trim() ||
		!model?.trim() ||
		(mode !== "conversation" && mode !== "tools-only")
	)
		throw new Error(
			"usage: bun bench/router/selection.ts --text <request> --model <id> [--mode conversation|tools-only]",
		);
	const apiKey =
		process.env["OPEN_AI_API_KEY"] || process.env["OPENAI_API_KEY"];
	if (!apiKey) throw new Error("OPEN_AI_API_KEY or OPENAI_API_KEY is required");

	const provider = fakeProvider();
	const space = {
		modelId: provider.model,
		revision: "1",
		artifactDigest: "fixture",
		dimension: 256,
	};
	const cards: RouterCard[] = await Promise.all(
		(exampleCards as Omit<Card, "revision" | "digest">[]).map(async (card) => ({
			...card,
			revision: "1",
			useWhen: [...card.useWhen],
			examples: [...card.examples],
			passages: await provider.embed(cardPassages(card)),
		})),
	);
	const signal = AbortSignal.timeout(20_000);
	const result = await routeWithSelection(
		{
			embed: async (texts) => ({ space, vectors: await provider.embed(texts) }),
			read: {
				cards: ({ available }) => cards.filter(({ id }) => available(id)),
				lexical: () => new Map(),
				nearFeedback: () => [],
			},
			select: responsesPort({ apiKey, model, signal }),
		},
		{
			state: { text, previousAgent: null, previousUser: null },
			available: () => true,
		},
		{ mode, signal },
	);
	console.log(
		JSON.stringify(
			{
				decision: result.decision.to,
				parts: result.parts.map(({ candidates, selection }) => ({
					candidates: candidates.map(({ candidate, ...search }) => ({
						id: candidate.id,
						...search,
					})),
					selection:
						selection.kind === "candidate"
							? { kind: selection.kind, id: selection.id }
							: { kind: selection.kind },
				})),
			},
			null,
			2,
		),
	);
}

if (import.meta.main) await main();
