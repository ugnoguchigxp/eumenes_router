import { createHash } from "node:crypto";

/** Hex sha256. Card digests and vector-space keys both use this. */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

/** Stable JSON: object keys in code-unit order, arrays in the order given. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		);
		return `{${entries
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
