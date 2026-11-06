import { expect, test } from "bun:test";
import { benchPython as py, hasBenchPython } from "../python.ts";
// Python regression tests for bench/router/experiments/best/best_v2.py; skipped when no python with sklearn is available.
const hasPy = hasBenchPython();
test.skipIf(!hasPy)(
	"best_v2: numpy ranker = sklearn, fold isolation, p1−p2 gate and artifact round trip (synthetic, no models)",
	() => {
		const r = Bun.spawnSync([
			py,
			"bench/router/experiments/best/test_best_v2.py",
		]);
		expect(r.stderr.toString()).not.toContain("Error");
		expect(r.exitCode).toBe(0);
	},
	120000,
);
