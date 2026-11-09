/** Versions a manifest publishes. Bump a key when that contract changes. */
export const contractVersions = {
	cards: 1,
	/** 7: native structured output with an exclusive decision envelope. */
	route: 7,
	feedback: 1,
	/** 6: strict native request fields and bounded responses. The prompt is versioned separately. */
	structure: 6,
} as const;

/** The number of `migrations` (`eumenes_router/sqlite`): the host has applied them all. */
export const dbSchemaVersion = 1;
