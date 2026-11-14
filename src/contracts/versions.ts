/** Versions a manifest publishes. Bump a key when that contract changes. */
export const contractVersions = {
	cards: 1,
	/** 9: direct model selection replaces the scored routing entry points. */
	route: 9,
	/** 2: SQLite operations for feedback inputs already checked by the host. */
	feedback: 2,
	/** 6: strict native request fields and bounded responses. The prompt is versioned separately. */
	structure: 6,
	/** 1: selection from five search candidates with optional conversation. */
	selection: 1,
} as const;

/** The number of `migrations` (`eumenes_router/sqlite`): the host has applied them all. */
export const dbSchemaVersion = 1;
