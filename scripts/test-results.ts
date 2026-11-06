/** A release requires a nonempty, complete Bun test run, including data-backed checks. */
export function requiredTestResults(report: string) {
	const count = (name: string) =>
		new RegExp(`(?:^|\\n)\\s*(\\d+) ${name}\\r?(?=\\n|$)`).exec(report)?.[1];
	const pass = count("pass");
	const fail = count("fail");
	if (pass === undefined || fail === undefined)
		throw new Error("required_tests_invalid_report");
	const result = {
		pass: Number(pass),
		fail: Number(fail),
		skip: Number(count("skip") ?? 0),
		todo: Number(count("todo") ?? 0),
	};
	if (!result.pass || result.fail || result.skip || result.todo)
		throw new Error("required_tests_incomplete");
	return result;
}
