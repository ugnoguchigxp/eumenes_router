/** Versions a manifest publishes. Bump a key when that contract changes. */
export const contractVersions = {
	cards: 1,
	/** 4: typed turn structure, pending references, fail-closed and repeated operations. */
	route: 4,
	feedback: 1,
	/** The structure model's prompt and answer (STRUCTURE_PROMPT.version is the prompt's own version). */
	structure: 2,
} as const;

/** The number of `migrations` (`eumenes_router/sqlite`): the host has applied them all. */
export const dbSchemaVersion = 1;
