/**
 * The release: `bun scripts/pack.ts [--out release]`.
 * Runs the typecheck, the lint and the tests (any failure stops it), builds and packs the package, names the
 * tarball `eumenes_router-<version>-<sha256 head 12>.tgz`, and writes `<artifact>.sha256` and `manifest.json`
 * beside it (the form of Eumenes' vendored packages), with the commit it was built from and whether the tree had
 * uncommitted changes. The mainline parity tests must run (they need the local evaluation data in data/).
 * One tarball holds the direct, structured and conditional fallback entries.
 */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkPython } from "../bench/python.ts";
import { verifyPackage } from "./verify-package.ts";
import { sourceSnapshot } from "./source-snapshot.ts";
import { requiredTestResults } from "./test-results.ts";
import {
	BEST_V2_MEMORY_FORMAT,
	BEST_V2_PARAMS,
	contractVersions,
	dbSchemaVersion,
	TURN_STRUCTURE_PROMPT,
} from "../src/index.ts";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: { out: { type: "string" } },
});
// Everything is relative to the repository, wherever the script is run from.
const root = join(import.meta.dir, "..");
const out = resolve(root, values.out ?? "release");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	name: string;
	version: string;
};

function run(command: string[]): string {
	const p = Bun.spawnSync(command, {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const text = p.stdout.toString() + p.stderr.toString();
	if (p.exitCode !== 0)
		throw new Error(`${command.join(" ")} failed:\n${text.slice(-2000)}`);
	return text;
}

const treeDigest = sourceSnapshot(root);
run(["bun", "run", "typecheck"]);
run(["bun", "run", "lint"]);
run(["bun", "run", "format:check"]);
checkPython();
const tests = run(["bun", "test"]);
const counts = requiredTestResults(tests);
// The mainline parity (both entries against the bench's records) must have run, not been skipped for want of data/.
const parity = run(["bun", "test", "test/route-mainline.test.ts"]);
if (requiredTestResults(parity).pass !== 2)
	throw new Error("the mainline parity tests did not run (data/ missing?)");
const commit = run(["git", "rev-parse", "HEAD"]).trim();
// Changes (untracked files included) in what the package is built and checked from.
const dirty =
	run([
		"git",
		"status",
		"--porcelain",
		"--",
		"src",
		"test",
		"scripts",
		"bench",
		"package.json",
		"bun.lock",
		".oxfmtrc.json",
		".oxlintrc.json",
		"tsconfig.json",
		"tsconfig.build.json",
	]).trim() !== "";

const tmp = mkdtempSync(join(tmpdir(), "router-pack-"));
try {
	run(["bun", "pm", "pack", "--destination", tmp]);
	const packed = readdirSync(tmp).filter((f) => f.endsWith(".tgz"));
	if (packed.length !== 1)
		throw new Error("bun pm pack did not write one tarball");
	const file = join(tmp, packed[0]!);
	const bytes = readFileSync(file);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	verifyPackage(file, sha256);
	// Negative control: an untrusted checksum must stop before extraction.
	let refused = false;
	try {
		verifyPackage(file, "0".repeat(64));
	} catch (error) {
		if (error instanceof Error && error.message === "package_checksum_mismatch")
			refused = true;
		else throw error;
	}
	if (!refused) throw new Error("package_checksum_negative_control_failed");
	if (sourceSnapshot(root) !== treeDigest)
		throw new Error("source_changed_during_verification");
	const artifact = `${pkg.name}-${pkg.version}-${sha256.slice(0, 12)}.tgz`;
	mkdirSync(out, { recursive: true });
	renameSync(file, join(out, artifact));
	writeFileSync(join(out, `${artifact}.sha256`), `${sha256}  ${artifact}\n`);
	const manifest = {
		package: pkg.name,
		version: pkg.version,
		artifact,
		sha256,
		source: { commit, dirty, treeDigest },
		contractVersions,
		dbSchemaVersion,
		entries: {
			route: {
				flavor: "direct",
				ports: [
					"embed",
					"rerank",
					"read.cards",
					"read.lexical",
					"read.nearFeedback",
					"model",
					"settings",
				],
			},
			routeStructured: {
				flavor: "structured",
				ports: [
					"analyze",
					"embed",
					"rerank",
					"read.cards",
					"read.lexical",
					"read.nearFeedback",
					"model",
					"settings",
				],
				structurePrompt: TURN_STRUCTURE_PROMPT.version,
			},
			routeWithFallback: {
				flavor: "conditional-structured",
				ports: [
					"embed",
					"rerank",
					"read.cards",
					"read.lexical",
					"read.nearFeedback",
					"model",
					"settings",
					"beginStructured",
				],
				structurePrompt: TURN_STRUCTURE_PROMPT.version,
			},
		},
		bestV2: {
			format: BEST_V2_PARAMS.format,
			version: BEST_V2_PARAMS.version,
			source: BEST_V2_PARAMS.source,
			deferBelow: BEST_V2_PARAMS.gate.deferBelow,
			extraTools: BEST_V2_PARAMS.extra.tools,
		},
		requires: {
			memory: {
				format: BEST_V2_MEMORY_FORMAT,
				source: BEST_V2_PARAMS.source,
				dimension: BEST_V2_PARAMS.knn.dimension,
				note: "the host imports it (importExamplesInTransaction); made from utterances, it is not in the tarball",
			},
		},
		verifiedWith: `eumenes_router: typecheck, lint, format, required offline Python regressions, bun test ${counts.pass} pass / 0 skip / 0 todo / 0 fail, mainline parity ran; tarball checksum and isolated consumer on built JavaScript/SQLite passed; wrong checksum refused`,
	};
	writeFileSync(
		join(out, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	console.log(JSON.stringify({ artifact: join(out, artifact), sha256 }));
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
