import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
// Python regression tests for bench/router/experiments/best/best_v1.py; skipped when no python with sklearn is available.
const py = process.env.BEST_V1_PYTHON ?? "/tmp/cvenv/bin/python";
const hasPy = existsSync(py) && Bun.spawnSync([py, "-c", "import sklearn, numpy"]).exitCode === 0;
test.skipIf(!hasPy)("best_v1: LR standardization + eval kNN memory (E2 reproducibility)", () => {
	const r = Bun.spawnSync([py, "bench/router/experiments/best/test_best_v1.py"]);
	expect(r.stderr.toString()).not.toContain("Error");
	expect(r.exitCode).toBe(0);
}, 60000);
