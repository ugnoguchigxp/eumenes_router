import { readFileSync } from "node:fs";

export function readJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line, i) => {
			try {
				return JSON.parse(line) as T;
			} catch {
				throw new Error(`jsonl_invalid: ${path}:${i + 1}`);
			}
		});
}

/** A JSON array file or a JSONL file, by extension. */
export function readRecords<T>(path: string): T[] {
	if (path.endsWith(".jsonl")) return readJsonl<T>(path);
	const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!Array.isArray(value)) throw new Error(`json_not_array: ${path}`);
	return value as T[];
}

export const jsonl = (rows: readonly unknown[]) =>
	rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

/** JSON with sorted keys, so equal values print equally. */
export function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: v,
	);
}
