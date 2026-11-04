/** Versions a manifest publishes. Bump a key when that contract changes. */
export const contractVersions = {
	cards: 1,
	/** 2: the reranker's scores and best-v2 (route), the structured route and its pipeline stage. */
	route: 2,
	feedback: 1,
	/** The structure model's prompt and answer (STRUCTURE_PROMPT.version is the prompt's own version). */
	structure: 1,
} as const;

/** `router_schema.version`. A database newer or older than this is refused. */
export const dbSchemaVersion = 2;
