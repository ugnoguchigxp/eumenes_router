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
 * A card as the reranker reads it: its first passage and the next five after
 * 「例:」, as the reranker was trained and measured (the bench's card document).
 */
export function rerankDocument(card: {
	title: string;
	summary: string;
	useWhen: readonly string[];
	examples: readonly string[];
}): string {
	const [first = "", ...rest] = cardPassages(card);
	return `${first} 例: ${rest.slice(0, 5).join(" / ")}`;
}
