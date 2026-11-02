/**
 * The router's choice contract (spec toolchain-router-redesign 2026-11-01 §3.2).
 * One choice over the criteria a turn offers. Filling fields is the host's.
 */
export const ROUTE_LIMITS = {
	/** Criteria of one choice (the search keeps a turn's offer far below this). */
	criteria: 128,
	/** A criterion's name: ASCII, starting with a letter. */
	name: 96,
	/** A criterion's description, in characters. */
	description: 300,
	/** The newest utterance: its head. */
	text: 2000,
	/** The agent's and the user's utterance before it: their tails. */
	previous: 1000,
} as const;

/** A letter, then letters, digits and `.`, `:`, `_`, `-`. */
export const routeCriterionName = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/;

export type RouteCriterion = { name: string; description: string };

/** What the scorer reads. The host supplies `instructions`; this package does not write them. */
export type RouteInput = {
	text: string;
	previousAgent: string | null;
	previousUser: string | null;
	instructions: string;
	criteria: readonly RouteCriterion[];
};

/** The scorer's answer: scores of what was offered, never an instruction. */
export type RouteAnswer = {
	choice: string;
	/** Every criterion sent, summing to 1. */
	probabilities: Record<string, number>;
	/** Independent 0..1 per criterion when the scorer gives them; else null. */
	scores: Record<string, number> | null;
	model: string;
	headRevision: string | null;
	calibrationRevision: string | null;
};

/** Codes the route throws. Copied from the product's choice contract. */
export const routeErrors = {
	invalidRequest: "larm_invalid_route_request",
	invalidResponse: "larm_invalid_route_response",
	truncated: "larm_route_truncated",
	extractUnsupported: "larm_route_extract_unsupported",
	portRequired: "larm_route_port_required",
} as const;

const unit = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value >= 0 &&
	value <= 1;

/**
 * The answer covers exactly the criteria sent, each score in [0,1], the probabilities
 * summing to 1 within 0.01. Anything else is an invalid answer.
 */
export function assertRouteAnswer(
	answer: RouteAnswer,
	criteria: readonly RouteCriterion[],
): void {
	const names = criteria.map((criterion) => criterion.name);
	if (typeof answer.choice !== "string" || !names.includes(answer.choice))
		throw new Error(routeErrors.invalidResponse);
	const probabilities = answer.probabilities;
	if (!probabilities || typeof probabilities !== "object")
		throw new Error(routeErrors.invalidResponse);
	if (Object.keys(probabilities).length !== names.length)
		throw new Error(routeErrors.invalidResponse);
	let sum = 0;
	for (const name of names) {
		const score = probabilities[name];
		if (!unit(score)) throw new Error(routeErrors.invalidResponse);
		sum += score;
	}
	if (Math.abs(sum - 1) > 0.01) throw new Error(routeErrors.invalidResponse);
	if (answer.scores !== null) {
		if (!answer.scores || typeof answer.scores !== "object")
			throw new Error(routeErrors.invalidResponse);
		if (Object.keys(answer.scores).length !== names.length)
			throw new Error(routeErrors.invalidResponse);
		for (const name of names)
			if (!unit(answer.scores[name]))
				throw new Error(routeErrors.invalidResponse);
	}
	if (typeof answer.model !== "string")
		throw new Error(routeErrors.invalidResponse);
	if (answer.headRevision !== null && typeof answer.headRevision !== "string")
		throw new Error(routeErrors.invalidResponse);
	if (
		answer.calibrationRevision !== null &&
		typeof answer.calibrationRevision !== "string"
	)
		throw new Error(routeErrors.invalidResponse);
}
