import { CONVERSATION_ID } from "../../../src/decision/result.ts";
import {
	rankSearch,
	srScores as searchScores,
} from "../../../src/retrieval/sr.ts";
export { capByKind, trigramQuery } from "../../../src/retrieval/sr.ts";
export type { SrCard } from "../../../src/retrieval/sr.ts";

export const SR = { conversation: 0.7, offer: 8, temperature: 0.1 } as const;
const round = (v: number) => Number(v.toFixed(6));

export function srScores(
	input: Parameters<typeof searchScores>[0] & { conversation: boolean },
) {
	const scores = searchScores(input);
	if (input.conversation) scores.set(CONVERSATION_ID, SR.conversation);
	return scores;
}

export type SrOffer = {
	/** The offered candidates and their probabilities (the conversation included), best first. */
	retrieval: Array<[string, number]>;
	/** Each offered candidate's score divided by the best. */
	scores: Record<string, number>;
};

/** The top of the scores as the offer best-v2 takes (the conversation always in). */
export function srOffer(
	scores: ReadonlyMap<string, number>,
	cap?: (ranked: readonly string[]) => string[],
): SrOffer {
	const order = rankSearch(scores, cap).slice(0, SR.offer);
	if (!order.includes(CONVERSATION_ID) && scores.has(CONVERSATION_ID)) {
		if (order.length >= SR.offer) order.pop();
		order.push(CONVERSATION_ID);
	}
	const best = Math.max(0, ...order.map((id) => scores.get(id) ?? 0));
	const scaled = order.map((id) =>
		best > 0 ? Math.max(0, scores.get(id) ?? 0) / best : 0,
	);
	const top = Math.max(...scaled);
	const exp = scaled.map((v) => Math.exp((v - top) / SR.temperature));
	const total = exp.reduce((s, v) => s + v, 0);
	return {
		retrieval: order.map((id, i) => [id, round(exp[i]! / total)]),
		scores: Object.fromEntries(order.map((id, i) => [id, round(scaled[i]!)])),
	};
}

/**
 * Every available tool in sr-corr's order (kind slots applied, the
 * conversation left out), with its score over the best, rounded as the offer
 * is: best-v2's extra candidates beyond the offer come from it.
 */
export function srRanking(
	scores: ReadonlyMap<string, number>,
	cap?: (ranked: readonly string[]) => string[],
): Array<[string, number]> {
	let best = 0;
	for (const v of scores.values()) if (v > best) best = v;
	return rankSearch(scores, cap)
		.filter((id) => id !== CONVERSATION_ID)
		.map((id) => [
			id,
			round(best > 0 ? Math.max(0, scores.get(id) ?? 0) / best : 0),
		]);
}
