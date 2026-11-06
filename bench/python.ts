import { existsSync } from "node:fs";
import { join } from "node:path";

export const benchPython =
	process.env["BENCH_PYTHON"] ??
	join(import.meta.dir, "..", ".venv", "bin", "python");
export function hasBenchPython(): boolean {
	return (
		existsSync(benchPython) &&
		Bun.spawnSync([benchPython, "-c", "import numpy, sklearn"]).exitCode === 0
	);
}

export function checkPython(): void {
	if (!hasBenchPython())
		throw new Error(
			"bench_python_required: create .venv and install bench/python-requirements.txt (or set BENCH_PYTHON)",
		);
	for (const name of ["test_best_v1.py", "test_best_v2.py"]) {
		const p = Bun.spawnSync(
			[
				benchPython,
				join(import.meta.dir, "router", "experiments", "best", name),
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (p.exitCode !== 0)
			throw new Error(
				`python_regression_failed: ${name}\n${p.stderr.toString()}`,
			);
	}
}

if (import.meta.main) checkPython();
