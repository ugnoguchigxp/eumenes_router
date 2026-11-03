/** Versions a manifest publishes. Bump a key when that contract changes. */
export const contractVersions = {
	cards: 1,
	route: 1,
	feedback: 1,
} as const;

/** `router_schema.version`. A database newer or older than this is refused. */
export const dbSchemaVersion = 2;
