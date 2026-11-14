export function strictObject(properties: Record<string, unknown>) {
	return {
		type: "object",
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	};
}

export function parseBoundedJson(raw: string, limit: number): unknown {
	if (typeof raw !== "string" || raw.length > limit) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
