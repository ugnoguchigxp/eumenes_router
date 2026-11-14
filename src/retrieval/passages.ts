/** The passages a card is found by: its purpose, use cases and example requests. */
export function cardPassages(card: {
	title: string;
	summary: string;
	useWhen: readonly string[];
	examples: readonly string[];
}): string[] {
	return [`${card.title}: ${card.summary}`, ...card.useWhen, ...card.examples];
}

/**
 * A card description for model selection: its first passage and five examples.
 */
export function candidateDocument(card: {
	title: string;
	summary: string;
	useWhen: readonly string[];
	examples: readonly string[];
}): string {
	const [first = "", ...rest] = cardPassages(card);
	return `${first} 例: ${rest.slice(0, 5).join(" / ")}`;
}
