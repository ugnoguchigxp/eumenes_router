import type { CardKind } from "../contracts/cards.ts";

/**
 * The search's slots by kind. Dedicated toolchains closest to the request, and pipelines
 * and general toolchains of their own, those within `near` of the closest candidate.
 * Read cards take a dedicated slot.
 */
export const CANDIDATE_SLOTS = {
	dedicated: 3,
	pipeline: 2,
	general: 2,
	near: 0.05,
} as const;

/**
 * The router's slots: wider than the choice call's, and cut by no distance from the
 * closest, so a pipeline or a general card reaches the router beside the dedicated ones.
 */
export const ROUTER_SLOTS = {
	dedicated: 10,
	pipeline: 4,
	general: 4,
	near: Number.POSITIVE_INFINITY,
} as const;

export type Slots = {
	dedicated: number;
	pipeline: number;
	general: number;
	near: number;
};

export type SlotKind = "dedicated" | "pipeline" | "general";

/** Read cards share the dedicated slots (they have no catalog of their own). */
export function slotKind(kind: CardKind): SlotKind {
	return kind === "read" ? "dedicated" : kind;
}

export type IndexedPassage = {
	id: string;
	values: ArrayLike<number>;
};

/** Each card's closest passage to the request. `active` is the card ids still offered. */
export function closestSimilarities(
	rows: readonly IndexedPassage[],
	values: ArrayLike<number>,
	active: ReadonlySet<string>,
): Map<string, number> {
	const similarity = new Map<string, number>();
	for (const row of rows) {
		if (!active.has(row.id) || row.values.length !== values.length) continue;
		let score = 0;
		for (let i = 0; i < values.length; i++)
			score += row.values[i]! * values[i]!;
		if (score > (similarity.get(row.id) ?? Number.NEGATIVE_INFINITY))
			similarity.set(row.id, score);
	}
	return similarity;
}

/** The cards the index found, closest first (ties by id). */
export function rankBy<T extends { id: string }>(
	active: readonly T[],
	similarity: ReadonlyMap<string, number>,
): T[] {
	return active
		.filter((card) => similarity.has(card.id))
		.sort(
			(a, b) =>
				similarity.get(b.id)! - similarity.get(a.id)! ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
}

/**
 * The ranked entries (closest first) each kind's slots take, in the ranked order.
 * Past the closest dedicated ones, an entry farther than `near` from the closest can
 * take no slot, nor can any after it.
 */
export function slotted<T>(
	ranked: readonly T[],
	similarityOf: (entry: T) => number,
	kind: (entry: T) => SlotKind,
	slots: Slots = CANDIDATE_SLOTS,
): T[] {
	const best = ranked[0] ? similarityOf(ranked[0]) : 0;
	const taken: Record<SlotKind, number> = {
		dedicated: 0,
		pipeline: 0,
		general: 0,
	};
	const out: T[] = [];
	for (const entry of ranked) {
		const far = best - similarityOf(entry) > slots.near;
		if (far && taken.dedicated >= slots.dedicated) break;
		const slot = kind(entry);
		if (taken[slot] >= slots[slot] || (slot !== "dedicated" && far)) continue;
		taken[slot]++;
		out.push(entry);
	}
	return out;
}
