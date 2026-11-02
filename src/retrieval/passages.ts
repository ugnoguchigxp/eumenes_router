/** The longest description a router criterion carries. */
export const ROUTER_PASSAGE_CHARS = 300;

/**
 * A card's description as the router reads it: its name and summary, and the first two
 * use cases. The kind is not written.
 */
export function routerPassage(card: {
	title: string;
	summary: string;
	useWhen?: readonly string[];
}): string {
	const uses = (card.useWhen ?? []).slice(0, 2);
	const text = `${card.title}: ${card.summary}${uses.length ? `（${uses.join("／")}）` : ""}`;
	return text.length > ROUTER_PASSAGE_CHARS
		? text.slice(0, ROUTER_PASSAGE_CHARS)
		: text;
}

/** The passages a card is found by: its purpose, use cases and example requests. */
export function cardPassages(card: {
	title: string;
	summary: string;
	useWhen: readonly string[];
	examples: readonly string[];
}): string[] {
	return [`${card.title}: ${card.summary}`, ...card.useWhen, ...card.examples];
}
