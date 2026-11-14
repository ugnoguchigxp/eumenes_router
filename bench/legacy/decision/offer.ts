import { ROUTE_LIMITS, routeCriterionName } from "../contracts/route.ts";
import type { RouteCandidate } from "./decide.ts";

/** Why a candidate was left out of the offer. */
export type Skipped = {
	id: string;
	reason: "invalid_name" | "description_too_long" | "criteria_limit";
};

const isStable = (candidate: RouteCandidate) =>
	candidate.kind === "conversation" || candidate.kind === "memory";

/**
 * Search hits, the conversation and a memory request, sorted by id, then the host's
 * dynamic candidates in the order given. A name the scorer would refuse, or a
 * description longer than the limit, is left out. A blank description stays, and the
 * caller rejects the whole request. Stable candidates are not cut to fit. When the
 * offer is full, dynamic candidates give way, pending ones last.
 */
export function offerCandidates(input: {
	searched: readonly RouteCandidate[];
	dynamic: readonly RouteCandidate[];
	skipped?: Skipped[];
}): RouteCandidate[] {
	const skipped = input.skipped;
	const admit = (candidates: readonly RouteCandidate[]) =>
		candidates.filter((candidate) => {
			const reason = !routeCriterionName.test(candidate.id)
				? "invalid_name"
				: candidate.passage.length > ROUTE_LIMITS.description
					? "description_too_long"
					: null;
			if (reason) skipped?.push({ id: candidate.id, reason });
			return !reason;
		});
	const seen = new Set<string>();
	const take = (candidate: RouteCandidate) => {
		if (seen.has(candidate.id)) return false;
		seen.add(candidate.id);
		return true;
	};
	const stable = admit([
		...input.searched,
		...input.dynamic.filter(isStable),
	]).filter(take);
	stable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const dynamic = admit(
		input.dynamic.filter((candidate) => !isStable(candidate)),
	).filter(take);
	const room = Math.max(0, ROUTE_LIMITS.criteria - stable.length);
	const kept = new Set(
		[...dynamic]
			.sort(
				(a, b) => Number(b.kind === "pending") - Number(a.kind === "pending"),
			)
			.slice(0, room)
			.map((candidate) => candidate.id),
	);
	for (const candidate of dynamic)
		if (!kept.has(candidate.id))
			skipped?.push({ id: candidate.id, reason: "criteria_limit" });
	return [...stable, ...dynamic.filter((candidate) => kept.has(candidate.id))];
}
