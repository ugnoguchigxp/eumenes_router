import { untilAborted } from "../../src/abort.ts";
import type { RouteCandidate, RouteDecision } from "./decision/decide.ts";
import {
	route,
	routeStructured,
	type RoutePorts,
	type RouteResult,
	type RouteTurn,
	type StructuredPorts,
	type StructuredResult,
} from "./route.ts";

type UnresolvedDecision = {
	row: 8;
	to: "unresolved";
	reason:
		| "no_candidate"
		| "structure_timeout"
		| "structure_failed"
		| "ambiguous";
	requests: ReadonlyArray<{
		text: string;
		/** Empty: no matching candidate to offer. Otherwise ask the user. */
		options: readonly RouteCandidate[];
	}>;
};

export type FallbackDecision = RouteDecision | UnresolvedDecision;

export type FallbackResult = {
	/** The only decision the host may act on. */
	decision: FallbackDecision;
	direct: RouteResult;
	structured: StructuredResult | null;
};

/** The host starts the deadline and binds B's external ports to it on demand. */
export type BeginStructured = () => {
	ports: StructuredPorts;
	deadline: AbortSignal;
	/** The original turn when A scored an expanded request from a prior question. */
	turn?: RouteTurn;
};

function unresolved(
	parts: StructuredResult["parts"],
	low: number,
	reason: UnresolvedDecision["reason"],
): UnresolvedDecision {
	return {
		row: 8,
		to: "unresolved",
		reason,
		requests: parts.map(({ text, result }) => ({
			text,
			options: result.corrected
				.filter(
					({ candidate, p }) => candidate.kind !== "conversation" && p >= low,
				)
				.map(({ candidate }) => candidate),
		})),
	};
}

/** A first. B only on its measured defer signal, with no tentative dispatch on failure. */
export async function routeWithFallback(
	ports: RoutePorts,
	turn: RouteTurn,
	beginStructured: BeginStructured,
	signal?: AbortSignal,
): Promise<FallbackResult> {
	signal?.throwIfAborted();
	const direct = await route(ports, turn);
	signal?.throwIfAborted();
	if (direct.answer === null)
		return {
			direct,
			structured: null,
			decision: unresolved(
				[{ text: turn.state.text, result: direct }],
				ports.settings.low,
				"no_candidate",
			),
		};
	if (direct.explain.defer !== true)
		return { direct, structured: null, decision: direct.decision };

	let deadline: AbortSignal | undefined;
	let structured: StructuredResult;
	try {
		const scope = beginStructured();
		deadline = scope.deadline;
		const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
		stop.throwIfAborted();
		const scoped = scope.ports;
		structured = await routeStructured(
			{
				...scoped,
				analyze: (prompt) => untilAborted(stop, () => scoped.analyze(prompt)),
				embed: (texts) => untilAborted(stop, () => scoped.embed(texts)),
				rerank: (input) => untilAborted(stop, () => scoped.rerank(input)),
			},
			scope.turn ?? turn,
		);
		stop.throwIfAborted();
	} catch {
		signal?.throwIfAborted();
		return {
			direct,
			structured: null,
			decision: unresolved(
				[{ text: turn.state.text, result: direct }],
				ports.settings.low,
				deadline?.aborted ? "structure_timeout" : "structure_failed",
			),
		};
	}

	const undecided = structured.parts.filter(({ result }) => {
		const { decision } = result;
		return (
			result.explain.defer !== false ||
			decision.to !== "run" ||
			decision.announce === "try" ||
			decision.announce === "partial"
		);
	});
	return {
		direct,
		structured,
		decision: undecided.length
			? unresolved(undecided, ports.settings.low, "ambiguous")
			: structured.decision,
	};
}
