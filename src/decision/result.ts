import type { Impact } from "../contracts/cards.ts";

export const CONVERSATION_ID = "conversation.respond";
export const MEMORY_ID = "memory.request";
export const DISCARD_ID = "switch.discard";

/** Tool metadata passed to the host for its routing handoff. */
export type DecisionCard = {
	id: string;
	title: string;
	general?: true;
	execution?: string;
	minImpact?: Impact;
	score: {
		rank: number;
		ftsRank: number | null;
		similarity: number | null;
		fromHistory: boolean;
	};
};

export type ChoiceRef = { id: string; title: string };

type Tool = { card: DecisionCard; choice: ChoiceRef };
type Confirmation = { confirmation: string; toolchain: string };

/** One thing the router may send the turn to. */
export type RouteCandidate = { id: string; passage: string } & (
	| { kind: "conversation" }
	| ({ kind: "toolchain" } & Tool)
	| ({ kind: "read" } & Tool)
	| { kind: "memory" }
	| {
			kind: "work";
			todo: string;
			operation: "check" | "amend" | "cancel";
			title: string;
	  }
	| {
			kind: "redirect";
			todo: string;
			title: string;
			toolchainId: string;
			target: string;
	  }
	| ({ kind: "pending"; operation: "approve" } & Confirmation)
	| ({ kind: "pending"; operation: "decline" } & Confirmation)
	| { kind: "pending"; operation: "answer"; todo: string; title: string }
	| { kind: "pending"; operation: "discard"; toolchain: string; title: string }
);

export type RunDecision = {
	row: 2 | 4 | 5 | 6;
	to: "run";
	candidate: RouteCandidate;
	announce: "fixed" | "try" | "none";
};

export type RouteDecision =
	| RunDecision
	| { row: 1; to: "conversation" }
	| { row: 8; to: "clarify"; question: string; unhandled: readonly string[] }
	| {
			row: 8;
			to: "unresolved";
			reason: "no_candidate" | "ambiguous";
			requests: ReadonlyArray<{
				text: string;
				options: readonly RouteCandidate[];
			}>;
	  }
	| {
			row: 9;
			to: "pipeline";
			steps: ReadonlyArray<{
				text: string;
				candidate: RouteCandidate;
				decision: RunDecision;
				after: readonly number[];
			}>;
	  };

export function decidedId(decision: RouteDecision): string | null {
	if (decision.to === "conversation") return CONVERSATION_ID;
	return decision.to === "run" ? decision.candidate.id : null;
}

export function decidedKind(decision: RouteDecision): string {
	return decision.to === "run" ? decision.candidate.kind : decision.to;
}
