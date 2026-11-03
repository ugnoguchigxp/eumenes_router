import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
// Python regression tests for bench/router/experiments/best/best_v2.py; skipped when no python with sklearn is available.
const py = process.env["BEST_V1_PYTHON"] ?? "/tmp/cvenv/bin/python";
const hasPy = existsSync(py) && Bun.spawnSync([py, "-c", "import sklearn, numpy"]).exitCode === 0;
test.skipIf(!hasPy)("best_v2: numpy ranker = sklearn, p1−p2 gate, E2 dev-only 91.2–92.2, artifact round trip", () => {
	const r = Bun.spawnSync([py, "bench/router/experiments/best/test_best_v2.py"]);
	expect(r.stderr.toString()).not.toContain("Error");
	expect(r.exitCode).toBe(0);
}, 120000);
