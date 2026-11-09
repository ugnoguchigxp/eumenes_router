import { routeStructured } from "../src/index.ts";

/** Scripts describe canonical decisions; malformed wire text stays literal for negative tests. */
export function routeStructuredFixture(
	ports: Parameters<typeof routeStructured>[0],
	turn: Parameters<typeof routeStructured>[1],
) {
	return routeStructured(
		{
			...ports,
			analyze: async (prompt) => {
				const raw = await ports.analyze(prompt);
				try {
					return JSON.stringify({ decision: JSON.parse(raw) });
				} catch {
					return raw;
				}
			},
		},
		turn,
	);
}
