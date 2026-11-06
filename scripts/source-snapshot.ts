import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Names and bytes, including new checked files. Independent of mtimes and git staging. */
export function fingerprintFiles(
	root: string,
	paths: readonly string[],
): string {
	const hash = createHash("sha256");
	for (const path of [...new Set(paths)].sort()) {
		const bytes = readFileSync(join(root, path));
		hash.update(JSON.stringify([path, bytes.length]));
		hash.update(bytes);
	}
	return hash.digest("hex");
}

export function sourceSnapshot(root: string): string {
	const paths = [
		"src",
		"test",
		"bench",
		"scripts",
		"package.json",
		"bun.lock",
		"tsconfig.json",
		"tsconfig.build.json",
		".oxfmtrc.json",
		".oxlintrc.json",
		".gitignore",
		"README.md",
		"LICENSE",
	];
	const list = (options: string[]) => {
		const p = Bun.spawnSync(
			[
				"git",
				"ls-files",
				"-z",
				...options,
				"--exclude-standard",
				"--",
				...paths,
			],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		if (p.exitCode !== 0) throw new Error("source_snapshot_failed");
		return p.stdout.toString().split("\0").filter(Boolean);
	};
	// Ignoring a source file in Git does not stop tsc/Bun/Python from using it.
	// Include such inputs, while leaving generated caches and private data out.
	const ignoredSources = list(["--others", "--ignored"]).filter((path) =>
		/\.(?:[cm]?[jt]sx?|json|py|sh|txt|lock)$/.test(path),
	);
	return fingerprintFiles(root, [
		...list(["--cached", "--others"]),
		...ignoredSources,
	]);
}
