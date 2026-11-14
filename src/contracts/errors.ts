/** Codes this package throws. Callers match the string; none is shown to a person as is. */
export const routerErrors = {
	/** A card breaks the contract (shape, id, digest). */
	invalidCard: "router_card_invalid",
	/** A vector does not belong to the space it names. */
	invalidEmbedding: "invalid_embedding_result",
	/** A correction row breaks the contract. */
	invalidFeedback: "router_feedback_invalid",
} as const;
