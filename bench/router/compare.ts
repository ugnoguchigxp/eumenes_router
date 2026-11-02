import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = Record<string, unknown> & {
	latencyMs: { p50: number | null; p95: number | null };
	falseDispatchRate: { rate: number | null };
};

const pct = (v: unknown) =>
	typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "なし";
const ms = (v: number | null) => (v === null ? "なし" : `${v.toFixed(3)} ms`);

/** Run directories given, or every run under `root` (those with a summary.json). */
export function runDirs(paths: readonly string[], root: string): string[] {
	if (paths.length) return [...paths];
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.sort()
		.map((d) => join(root, d))
		.filter((d) => existsSync(join(d, "summary.json")));
}

export function compareTable(dirs: readonly string[]): string {
	const lines = [
		"| run | algo | split | n | Top-1 | Recall@4 | 該当なし正答率 | 決定の正解率 | p50 | p95 | digest |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const dir of dirs) {
		const s = JSON.parse(
			readFileSync(join(dir, "summary.json"), "utf8"),
		) as Row;
		lines.push(
			`| ${dir.split("/").pop()} | ${s["algo"]} | ${s["split"]} | ${s["n"]} | ${pct(s["top1"])} | ${pct(s["recallAt4"])} | ${pct(s["noneAccuracy"])} | ${pct(s["decisionAccuracy"])} | ${ms(s.latencyMs.p50)} | ${ms(s.latencyMs.p95)} | ${s["digest"]} |`,
		);
	}
	return lines.join("\n");
}
