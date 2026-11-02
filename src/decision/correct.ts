import type { NearFeedback } from "../contracts/feedback.ts";

/** A probability of zero must still be a log. */
const FLOOR = 1e-9;

/**
 * The correction of the probabilities by the corrections near this utterance.
 * Corrections that name different right answers cancel each other: none applies.
 * `weight` 0 turns the corrections off.
 */
export function correctProbabilities(
	candidates: ReadonlyArray<{ id: string; p: number }>,
	near: readonly NearFeedback[],
	options: { threshold: number; weight: number },
): { p: number[]; shift: number[]; conflict: boolean } {
	const none = {
		p: candidates.map((candidate) => candidate.p),
		shift: candidates.map(() => 0),
	};
	if (!near.length || options.weight <= 0) return { ...none, conflict: false };
	if (new Set(near.map((row) => row.rightId)).size > 1)
		return { ...none, conflict: true };
	const { threshold: theta, weight: beta } = options;
	const shifts = new Map<string, number>();
	for (const row of near) {
		const w =
			theta >= 1 ? 1 : Math.max(0, (row.similarity - theta) / (1 - theta));
		shifts.set(row.rightId, (shifts.get(row.rightId) ?? 0) + beta * w);
		if (row.wrongId)
			shifts.set(row.wrongId, (shifts.get(row.wrongId) ?? 0) - beta * w);
	}
	const shift = candidates.map((candidate) =>
		Math.max(-beta, Math.min(beta, shifts.get(candidate.id) ?? 0)),
	);
	const logs = candidates.map(
		(candidate, i) => Math.log(candidate.p + FLOOR) + shift[i]!,
	);
	const top = Math.max(...logs);
	const exp = logs.map((value) => Math.exp(value - top));
	const total = exp.reduce((sum, value) => sum + value, 0);
	return {
		p: exp.map((value) => value / total),
		shift,
		conflict: false,
	};
}
