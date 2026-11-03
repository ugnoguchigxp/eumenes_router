/** Codes this package throws. Callers match the string; none is shown to a person as is. */
export const routerErrors = {
	/** A card breaks the contract (shape, id, digest). */
	invalidCard: "router_card_invalid",
	/** A vector does not belong to the space it names. */
	invalidEmbedding: "invalid_embedding_result",
	/** The borrowed database is newer than this package. */
	schemaNewer: "router_schema_newer",
	/** The borrowed database is an older schema this package does not migrate. */
	schemaOlder: "router_schema_older",
	/** A correction row breaks the contract. */
	invalidFeedback: "router_feedback_invalid",
	/** A scorer's trained parameters break the contract. */
	invalidModel: "router_model_invalid",
} as const;
