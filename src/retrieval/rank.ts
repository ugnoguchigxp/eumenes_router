import type { CardKind } from "../contracts/cards.ts";

/**
 * The router's slots by kind (kept from the product's search, plan §0 decision 1):
 * dedicated, pipeline and general cards each up to their count, so a pipeline or a
 * general card reaches the router beside the dedicated ones. Read cards take a
 * dedicated slot.
 */
export const ROUTER_SLOTS = {
	dedicated: 10,
	pipeline: 4,
	general: 4,
} as const;

export type Slots = {
	dedicated: number;
	pipeline: number;
	general: number;
};

export type SlotKind = "dedicated" | "pipeline" | "general";

/** Read cards share the dedicated slots (they have no catalog of their own). */
export function slotKind(kind: CardKind): SlotKind {
	return kind === "read" ? "dedicated" : kind;
}
