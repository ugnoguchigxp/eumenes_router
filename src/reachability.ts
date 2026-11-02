/**
 * Registration check (spec §3.8). The host has already searched: each case is one
 * example or one evaluated utterance of a card, with the frame it landed in, the
 * first place, and, when the host has it, the prediction set. This function does
 * not embed and does not score.
 * A card whose Recall@1 falls by 0.02 or more against `before` is a regression.
 * Recall@set is the share of that card's cases whose set contains the card. It is
 * null when the card has no cases, or any of its cases omits `set`.
 */
export type ReachabilityCase = {
	cardId: string;
	offered: readonly string[];
	top1: string;
	/** The prediction set for this case. Omit it and Recall@set stays null. */
	set?: readonly string[];
};

export type ReachabilityCard = {
	id: string;
	n: number;
	recallAtFrame: number | null;
	recallAt1: number | null;
	/** Share of cases whose prediction set contains the card. */
	recallAtSet: number | null;
	/** `before` minus Recall@1, when both exist. */
	delta: number | null;
};

export type ReachabilityReport = {
	byCard: ReachabilityCard[];
	/** Recall@1 fell by 0.02 or more. The host refuses the registration. */
	regressions: Array<{ id: string; before: number; after: number }>;
	refused: boolean;
};

const REGRESSION = 0.02;

export function checkReachability(input: {
	cards: readonly { id: string }[];
	eval: readonly ReachabilityCase[];
	before?: Readonly<Record<string, number>>;
}): ReachabilityReport {
	const ids = new Set<string>();
	for (const card of input.cards) ids.add(card.id);
	for (const row of input.eval) ids.add(row.cardId);
	const byCard: ReachabilityCard[] = [];
	const regressions: ReachabilityReport["regressions"] = [];
	for (const id of [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
		const rows = input.eval.filter((row) => row.cardId === id);
		const n = rows.length;
		const recallAtFrame = n
			? rows.filter((row) => row.offered.includes(id)).length / n
			: null;
		const recallAt1 = n
			? rows.filter((row) => row.top1 === id).length / n
			: null;
		const recallAtSet =
			n && rows.every((row) => row.set !== undefined)
				? rows.filter((row) => (row.set ?? []).includes(id)).length / n
				: null;
		const previous = input.before?.[id];
		const delta =
			recallAt1 !== null && typeof previous === "number"
				? previous - recallAt1
				: null;
		if (
			recallAt1 !== null &&
			typeof previous === "number" &&
			previous - recallAt1 >= REGRESSION
		)
			regressions.push({ id, before: previous, after: recallAt1 });
		byCard.push({ id, n, recallAtFrame, recallAt1, recallAtSet, delta });
	}
	return { byCard, regressions, refused: regressions.length > 0 };
}
