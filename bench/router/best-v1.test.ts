import { expect, test } from "bun:test";
import { benchPython as py, hasBenchPython } from "../python.ts";
// Python regression tests for bench/router/experiments/best/best_v1.py; skipped when no python with sklearn is available.
const hasPy = hasBenchPython();
test.skipIf(!hasPy)(
	"best_v1: LR standardization + eval kNN memory (E2 reproducibility)",
	() => {
		const r = Bun.spawnSync([
			py,
			"bench/router/experiments/best/test_best_v1.py",
		]);
		expect(r.stderr.toString()).not.toContain("Error");
		expect(r.exitCode).toBe(0);
	},
	60000,
);
