/** Verify the trusted manifest's checksum before extraction, then run an isolated consumer using only the tarball. */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function verifyPackage(artifact: string, sha256: string): void {
	if (
		createHash("sha256").update(readFileSync(artifact)).digest("hex") !== sha256
	)
		throw new Error("package_checksum_mismatch");
	const run = (command: string[], cwd?: string) => {
		const p = Bun.spawnSync(command, {
			...(cwd ? { cwd } : {}),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (p.exitCode !== 0)
			throw new Error(
				`package_verification_failed: ${command[0]}\n${p.stderr.toString()}`,
			);
		return p.stdout.toString();
	};
	const names = run(["tar", "-tzf", artifact]).trim().split("\n");
	if (
		names.some(
			(name) =>
				name.split("/").includes("..") ||
				(name !== "package/" &&
					name !== "package/dist/" &&
					!/^package\/(?:dist\/[A-Za-z0-9_./-]+\.(?:js|d\.ts)|package\.json|README\.md|LICENSE)$/.test(
						name,
					)),
		)
	)
		throw new Error("package_unexpected_content");
	if (
		names.some((name) =>
			/\/(?:scoring\/|route(?:-fallback)?\.[^/]+$|best-v2[^/]*$|(?:decide|correct|offer|example-memory)\.[^/]+$)/.test(
				name,
			),
		)
	)
		throw new Error("package_retired_routing_content");
	// Even a trusted checksum must not authorize a link that redirects extraction outside the consumer.
	const entries = run(["tar", "-tvzf", artifact]).trim().split("\n");
	if (entries.some((entry) => !entry.startsWith("-") && !entry.startsWith("d")))
		throw new Error("package_unsupported_entry");
	const consumer = mkdtempSync(join(tmpdir(), "router-consumer-"));
	try {
		const pkg = join(consumer, "node_modules", "eumenes_router");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(consumer, "package.json"), '{"type":"module"}\n');
		run(["tar", "-xzf", artifact, "--strip-components=1", "-C", pkg]);
		copyFileSync(
			join(import.meta.dir, "..", "test", "fixtures", "package-smoke.mjs"),
			join(consumer, "smoke.mjs"),
		);
		run([process.execPath, "smoke.mjs"], consumer);
	} finally {
		rmSync(consumer, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const file = resolve(process.argv[2] ?? "release/manifest.json");
	const m = JSON.parse(readFileSync(file, "utf8")) as {
		artifact: string;
		sha256: string;
	};
	const { dirname } = await import("node:path");
	verifyPackage(resolve(dirname(file), m.artifact), m.sha256);
	console.log("package verified");
}
