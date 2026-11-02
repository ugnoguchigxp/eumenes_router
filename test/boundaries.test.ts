import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

test("the package does not open a database, a clock, a network, or a model", () => {
	const banned = [
		"bun:sqlite",
		"new Database",
		".transaction(",
		"PRAGMA",
		"Date.now",
		"Math.random",
		"crypto.randomUUID",
		"fetch(",
		"process.env",
		"onnxruntime",
		"@xenova",
	];
	const sources = files(join(root, "src")).filter((path) =>
		path.endsWith(".ts"),
	);
	expect(sources.length).toBeGreaterThan(5);
	for (const path of sources) {
		const text = readFileSync(path, "utf8");
		for (const word of banned)
			expect(text.includes(word), `${path} ${word}`).toBe(false);
	}
	const index = readFileSync(join(root, "src/index.ts"), "utf8");
	expect(index.includes("sqlite")).toBe(false);
	expect(index.includes("/db/")).toBe(false);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		dependencies?: unknown;
	};
	expect(pkg.dependencies).toBeUndefined();
});
