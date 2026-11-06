import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fingerprintFiles,
	sourceSnapshot,
} from "../scripts/source-snapshot.ts";
import { requiredTestResults } from "../scripts/test-results.ts";
import { verifyPackage } from "../scripts/verify-package.ts";

test("checked source fingerprint is stable across order, but changes with bytes, names and added files", () => {
	const dir = mkdtempSync(join(tmpdir(), "router-snapshot-"));
	try {
		writeFileSync(join(dir, "a"), "one");
		writeFileSync(join(dir, "b"), "two");
		const first = fingerprintFiles(dir, ["a", "b"]);
		expect(fingerprintFiles(dir, ["b", "a", "a"])).toBe(first);
		writeFileSync(join(dir, "a"), "ONE");
		expect(fingerprintFiles(dir, ["a", "b"])).not.toBe(first);
		writeFileSync(join(dir, "a"), "one");
		writeFileSync(join(dir, "c"), "two");
		expect(fingerprintFiles(dir, ["a", "c"])).not.toBe(first);
		expect(fingerprintFiles(dir, ["a", "b", "c"])).not.toBe(first);
		expect(() => fingerprintFiles(dir, ["missing"])).toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("source snapshot includes ignored build inputs but not generated caches or private data", () => {
	const dir = mkdtempSync(join(tmpdir(), "router-git-snapshot-"));
	try {
		const git = (...args: string[]) => {
			const p = Bun.spawnSync(["git", ...args], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(p.exitCode).toBe(0);
		};
		git("init", "--quiet");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, ".gitignore"), "src/ignored.ts\n*.pyc\ndata/\n");
		writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
		git("add", ".gitignore", "src/index.ts");
		const baseline = sourceSnapshot(dir);
		writeFileSync(join(dir, "src", "ignored.ts"), "export const n = 1;\n");
		const added = sourceSnapshot(dir);
		expect(added).not.toBe(baseline);
		writeFileSync(join(dir, "src", "ignored.ts"), "export const n = 2;\n");
		expect(sourceSnapshot(dir)).not.toBe(added);
		const changed = sourceSnapshot(dir);
		mkdirSync(join(dir, "bench", "__pycache__"), { recursive: true });
		writeFileSync(join(dir, "bench", "__pycache__", "cache.pyc"), "cache");
		mkdirSync(join(dir, "data"));
		writeFileSync(join(dir, "data", "private.json"), "{}");
		expect(sourceSnapshot(dir)).toBe(changed);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("required release checks reject real Bun reports with skipped, todo, failed or empty tests", () => {
	const dir = mkdtempSync(join(tmpdir(), "router-test-report-"));
	try {
		const report = (body: string) => {
			const file = join(dir, "probe.test.ts");
			writeFileSync(file, `import { test } from "bun:test";\n${body}\n`);
			const p = Bun.spawnSync([process.execPath, "test", file], {
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
			return p.stdout.toString() + p.stderr.toString();
		};
		const valid = 'test("complete", () => {});';
		expect(requiredTestResults(report(valid))).toEqual({
			pass: 1,
			fail: 0,
			skip: 0,
			todo: 0,
		});
		for (const partial of [
			'test.skip("skipped", () => {});',
			'test.todo("unfinished");',
			'test("failed", () => { throw new Error("synthetic failure"); });',
		]) {
			expect(() => requiredTestResults(report(valid + partial))).toThrow(
				"required_tests_incomplete",
			);
		}
		expect(() => requiredTestResults(report(""))).toThrow();
		expect(() => requiredTestResults("missing test report")).toThrow(
			"required_tests_invalid_report",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("archive verification refuses checksum mismatch, unexpected data and symlinks before running consumer code", () => {
	const dir = mkdtempSync(join(tmpdir(), "router-archive-"));
	try {
		const pkg = join(dir, "package");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		const artifact = join(dir, "test.tgz");
		const pack = () => {
			const p = Bun.spawnSync(["tar", "-czf", artifact, "-C", dir, "package"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(p.exitCode).toBe(0);
			return createHash("sha256").update(readFileSync(artifact)).digest("hex");
		};
		writeFileSync(join(pkg, "unexpected.txt"), "not shipped");
		let hash = pack();
		expect(() => verifyPackage(artifact, "0".repeat(64))).toThrow(
			"package_checksum_mismatch",
		);
		expect(() => verifyPackage(artifact, hash)).toThrow(
			"package_unexpected_content",
		);
		rmSync(join(pkg, "unexpected.txt"));
		writeFileSync(join(pkg, "dist", ".env"), "SYNTHETIC_ONLY=fixture");
		hash = pack();
		expect(() => verifyPackage(artifact, hash)).toThrow(
			"package_unexpected_content",
		);
		rmSync(join(pkg, "dist", ".env"));
		symlinkSync("../../outside", join(pkg, "dist", "link.js"));
		hash = pack();
		expect(() => verifyPackage(artifact, hash)).toThrow(
			"package_unsupported_entry",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
