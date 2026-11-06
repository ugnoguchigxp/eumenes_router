import { expect, test } from "bun:test";
import {
	assertRouteAnswer,
	routeErrors,
	type RouteAnswer,
} from "../src/index.ts";

const criteria = [
	{ name: "a", description: "first" },
	{ name: "b", description: "second" },
];
const answer = (): RouteAnswer => ({
	choice: "a",
	probabilities: { a: 0.5, b: 0.5 },
	scores: { a: 0.8, b: 0.2 },
	model: "fixture",
	headRevision: null,
	calibrationRevision: null,
});

test("untrusted scorer shapes, inherited values, invalid numbers and missing names fail with the declared error", () => {
	const inherited = Object.assign(Object.create({ a: 0.5, b: 0.5 }), {
		x: 0.5,
		y: 0.5,
	});
	const invalid: unknown[] = [
		null,
		[],
		{},
		{ ...answer(), choice: "other" },
		{ ...answer(), probabilities: inherited },
		{ ...answer(), scores: inherited },
		{ ...answer(), probabilities: { a: 0.5 } },
		{ ...answer(), scores: { a: 0.2 } },
		{ ...answer(), probabilities: { a: 0.3, b: 0.3 } },
		{ ...answer(), model: null },
		{ ...answer(), headRevision: {} },
		{ ...answer(), calibrationRevision: false },
	];
	for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1, "0.5", null]) {
		invalid.push(
			{ ...answer(), probabilities: { a: value, b: 0.5 } },
			{ ...answer(), scores: { a: value, b: 0.5 } },
		);
	}
	for (const value of invalid)
		expect(() => assertRouteAnswer(value as RouteAnswer, criteria)).toThrow(
			routeErrors.invalidResponse,
		);
});

test("valid probability boundaries remain accepted without mutating the scorer answer", () => {
	for (let i = 0; i <= 100; i++) {
		const a = answer();
		a.probabilities = { a: i / 100, b: 1 - i / 100 };
		const before = JSON.stringify(a);
		assertRouteAnswer(a, criteria);
		expect(JSON.stringify(a)).toBe(before);
	}
});
