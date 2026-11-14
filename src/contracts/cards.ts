import { canonicalJson, sha256Hex } from "../digest.ts";
import { routerErrors } from "./errors.ts";

export const routeCandidateId = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/;

export const cardKinds = ["dedicated", "pipeline", "general", "read"] as const;
export type CardKind = (typeof cardKinds)[number];

/** What a toolchain's work does to what exists, least first. The host decides the real effect. */
export const impacts = [
	"none",
	"create",
	"modify_existing",
	"irreversible",
] as const;
export type Impact = (typeof impacts)[number];

/**
 * A routing card. The host builds it from a published toolchain.
 * `digest` is `cardDigest` of the other fields.
 */
export type Card = {
	id: string;
	revision: string;
	kind: CardKind;
	title: string;
	summary: string;
	useWhen: readonly string[];
	examples: readonly string[];
	impact: Impact;
	digest: string;
};

/** A passage the index embeds. `item` is its place in `cardPassages`. */
export type Passage = {
	id: string;
	revision: string;
	item: number;
	text: string;
};

const kindSet = new Set<string>(cardKinds);
const impactSet = new Set<string>(impacts);

/** sha256 of the card's canonical JSON, prefixed so a bare hex string is not mistaken for it. */
export function cardDigest(card: Omit<Card, "digest">): string {
	return `sha256:${sha256Hex(canonicalJson(cardBody(card)))}`;
}

function cardBody(card: Omit<Card, "digest">) {
	return {
		examples: card.examples,
		id: card.id,
		impact: card.impact,
		kind: card.kind,
		revision: card.revision,
		summary: card.summary,
		title: card.title,
		useWhen: card.useWhen,
	};
}

function strings(value: unknown): readonly string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return null;
		out.push(item);
	}
	return out;
}

/**
 * The card, or an error when the shape, the id, or the digest is wrong.
 * Counts and string lengths are not capped: a published card is not rejected for size.
 */
export function parseCard(value: Card): Card {
	const useWhen = strings(value.useWhen);
	const examples = strings(value.examples);
	if (
		typeof value.id !== "string" ||
		!routeCandidateId.test(value.id) ||
		typeof value.revision !== "string" ||
		value.revision.length < 1 ||
		!kindSet.has(value.kind) ||
		typeof value.title !== "string" ||
		value.title.length < 1 ||
		typeof value.summary !== "string" ||
		!useWhen ||
		!examples ||
		!impactSet.has(value.impact)
	)
		throw new Error(routerErrors.invalidCard);
	const card: Omit<Card, "digest"> = {
		id: value.id,
		revision: value.revision,
		kind: value.kind,
		title: value.title,
		summary: value.summary,
		useWhen,
		examples,
		impact: value.impact,
	};
	if (value.digest !== cardDigest(card))
		throw new Error(routerErrors.invalidCard);
	return { ...card, digest: value.digest };
}
