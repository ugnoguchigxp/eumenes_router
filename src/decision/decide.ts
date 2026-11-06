import type { Impact } from "../contracts/cards.ts";

export const CONVERSATION_ID = "conversation.respond";
export const MEMORY_ID = "memory.request";
export const DISCARD_ID = "switch.discard";

/** The prediction set: the best candidates until this probable together, at most this many. */
const SET_MASS = 0.9;
const SET_SIZE = 3;

/** What the decision table reads of a toolchain or a read tool. */
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

/** A candidate scored: the raw probability, the correction added to its log, and the probability after it. */
export type Ranked = {
	candidate: RouteCandidate;
	raw: number;
	correction: number;
	p: number;
	/** The scorer's independent score (0..1) when it gave one. */
	score: number | null;
};

export type Announce = "fixed" | "try" | "partial" | "none";
export type DirectDecision =
	| { row: 1 | 7 | 8; to: "conversation" }
	| { row: 8; to: "ask"; options: [RouteCandidate, RouteCandidate] }
	| {
			row: 2 | 3 | 4 | 5 | 6 | 9;
			to: "run";
			candidate: RouteCandidate;
			announce: Announce;
	  }
	/** Not sure enough to do it (a yes, a cancellation): the host asks once more instead. */
	| { row: 5 | 6; to: "again"; candidate: RouteCandidate };

export type RouteDecision =
	| DirectDecision
	| { row: 8; to: "clarify"; question: string; unhandled: readonly string[] }
	/** Requests of two or more tools (the structured route): the pipeline stage takes them, in this order. */
	| {
			row: 9;
			to: "pipeline";
			steps: ReadonlyArray<{
				text: string;
				candidate: RouteCandidate;
				/** The part's decision, including its notice/confirmation and conversation outcome. */
				decision: DirectDecision;
				after: readonly number[];
			}>;
	  };

const isTool = (candidate: RouteCandidate) =>
	candidate.kind === "toolchain" || candidate.kind === "read";
const cancelling = (candidate: RouteCandidate) =>
	candidate.kind === "redirect" ||
	(candidate.kind === "work" && candidate.operation === "cancel");

/** The decision table (spec §3.3, rows 1 to 9; row 10, a router that failed, is the caller's). */
export function decide(
	ranked: readonly Ranked[],
	settings: {
		accept: number;
		low: number;
		margin: number;
		approve: number;
		multi: number;
	},
	/** The candidate the host asked about in the turn before (rows 5 and 6). */
	asked: string | null = null,
	/** Whether the top is sure, when the scorer decides it (best-v2's gate); else from `accept` and `margin`. */
	confident?: boolean,
): DirectDecision {
	const top = ranked[0];
	const next = ranked[1];
	if (!top) return { row: 8, to: "conversation" };
	const { accept, low, margin, approve, multi } = settings;
	const candidate = top.candidate;
	const p1 = top.p;
	const p2 = next?.p ?? 0;
	if (candidate.kind === "conversation") {
		if (p1 >= accept) return { row: 1, to: "conversation" };
		if (next && p2 >= low) return { row: 7, to: "conversation" };
		return { row: p1 < low ? 8 : 1, to: "conversation" };
	}
	if (p1 < low) {
		if (next && isTool(candidate) && isTool(next.candidate))
			return { row: 8, to: "ask", options: [candidate, next.candidate] };
		return { row: 8, to: "conversation" };
	}
	const sure = confident ?? (p1 >= accept && p1 - p2 >= margin);
	if (candidate.kind === "toolchain" && several(ranked, accept, multi))
		return { row: 9, to: "run", candidate, announce: "partial" };
	if (isTool(candidate)) {
		if (sure) return { row: 2, to: "run", candidate, announce: "fixed" };
		const changes =
			candidate.kind === "toolchain" &&
			(candidate.card.minImpact === "modify_existing" ||
				candidate.card.minImpact === "irreversible");
		return {
			row: changes ? 4 : 3,
			to: "run",
			candidate,
			announce: "try",
		};
	}
	if (candidate.kind === "work" && candidate.operation === "check")
		return {
			row: sure ? 2 : 3,
			to: "run",
			candidate,
			announce: "none",
		};
	if (cancelling(candidate))
		return p1 >= accept || candidate.id === asked
			? { row: 6, to: "run", candidate, announce: "none" }
			: { row: 6, to: "again", candidate };
	if (
		candidate.kind === "pending" &&
		(candidate.operation === "approve" || candidate.operation === "discard")
	)
		return p1 >= approve || candidate.id === asked
			? { row: 5, to: "run", candidate, announce: "none" }
			: { row: 5, to: "again", candidate };
	return sure
		? { row: 2, to: "run", candidate, announce: "none" }
		: { row: 7, to: "conversation" };
}

/**
 * A request of several jobs (row 9): two dedicated toolchains each score at least `multi`
 * on their own. A router that gives no independent scores never makes a request several.
 * A pipeline that scores `accept` would do them all, so the row is not 9.
 */
function several(ranked: readonly Ranked[], accept: number, multi: number) {
	const toolchains = ranked.filter(
		(
			row,
		): row is Ranked & {
			candidate: Extract<RouteCandidate, { kind: "toolchain" }>;
		} => row.candidate.kind === "toolchain",
	);
	const jobs = toolchains.filter(
		(row) =>
			!row.candidate.card.general &&
			row.candidate.card.execution !== "pipeline" &&
			(row.score ?? 0) >= multi,
	);
	return (
		jobs.length >= 2 &&
		!toolchains.some(
			(row) =>
				row.candidate.card.execution === "pipeline" &&
				(row.score ?? 0) >= accept,
		)
	);
}

/** The best candidates until they are this probable together, at most three. */
export function predictionSet(ranked: readonly Ranked[]): string[] {
	const set: string[] = [];
	let mass = 0;
	for (const row of ranked) {
		set.push(row.candidate.id);
		mass += row.p;
		if (mass >= SET_MASS || set.length >= SET_SIZE) break;
	}
	return set;
}

/** The id a decision lands on. A question between two candidates decides nothing yet. */
export function decidedId(decision: RouteDecision): string | null {
	switch (decision.to) {
		case "conversation":
			return CONVERSATION_ID;
		case "ask":
		case "clarify":
		case "pipeline":
			return null;
		default:
			return decision.candidate.id;
	}
}

/** What a log may name of a decision: its kind, never the words. */
export function decidedKind(decision: RouteDecision): string {
	return decision.to === "run" || decision.to === "again"
		? decision.candidate.kind
		: decision.to;
}
