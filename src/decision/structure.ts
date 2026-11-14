import type { Analyze, SelectionTurn } from "../contracts/selection.ts";
import type { Structure } from "../structure.ts";
import {
	parseTurnResponse,
	turnStructurePrompt,
	type TurnStructure,
} from "../turn-structure.ts";
import type { RouteDecision, RunDecision } from "./result.ts";

export async function analyzeTurn(
	analyze: Analyze,
	turn: Pick<SelectionTurn, "state" | "pending" | "controls">,
): Promise<TurnStructure> {
	const text = turn.state.text;
	const raw = await analyze(
		turnStructurePrompt(
			text,
			turn.state.previousAgent,
			turn.pending ?? [],
			turn.controls ?? [],
		),
	);
	const structure = parseTurnResponse(
		raw,
		text,
		turn.pending ?? [],
		turn.controls ?? [],
	);
	if (!structure) throw new Error("structure_invalid");
	return structure;
}

export function structuredControlDecision(
	structure: TurnStructure,
	dynamic: NonNullable<SelectionTurn["dynamic"]>,
): RunDecision | Extract<RouteDecision, { to: "clarify" }> | null {
	if (structure.kind === "control") {
		const candidate = dynamic.find(
			(c) =>
				c.id === structure.ref && c.kind === "work" && c.operation === "cancel",
		);
		if (!candidate) throw new Error("structure_reference_unavailable");
		return { row: 6, to: "run", candidate, announce: "none" };
	}
	if (structure.kind === "answer") {
		const candidate = dynamic.find(
			(c) =>
				c.id === structure.ref &&
				c.kind === "pending" &&
				c.operation === "answer",
		);
		if (!candidate) throw new Error("structure_reference_unavailable");
		return { row: 5, to: "run", candidate, announce: "none" };
	}
	if (structure.kind === "clarify")
		return {
			row: 8,
			to: "clarify",
			question: structure.question,
			unhandled: structure.unhandled,
		};
	return null;
}

export function pipelineDecision(
	structure: Structure,
	parts: ReadonlyArray<{
		text: string;
		decision: RunDecision;
	}>,
): Extract<RouteDecision, { to: "pipeline" }> {
	return {
		row: 9,
		to: "pipeline",
		steps: parts.map(({ text, decision }, i) => ({
			text,
			candidate: decision.candidate,
			decision,
			after: structure.requests[i]!.after,
		})),
	};
}
