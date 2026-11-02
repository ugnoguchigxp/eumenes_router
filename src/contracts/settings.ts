import { routeErrors } from "./route.ts";

/** The decision table's lines and the correction's reach. The host owns them. */
export type RouteSettings = {
	/** τ採用. The top candidate is taken at least this probable, with `margin` over the second. */
	accept: number;
	/** τ低. Below this, the top candidate is not taken. */
	low: number;
	/** δ. The least lead of the top candidate over the second. */
	margin: number;
	/** τ承認. A confirmation is approved only this probable. */
	approve: number;
	/** τ多. Two toolchains scoring at least this, independently, are several jobs. */
	multi: number;
	/** θ. A correction applies to an utterance at least this similar. */
	feedbackNear: number;
	/** β. The most a correction moves a log-probability. 0 turns corrections off. */
	feedbackWeight: number;
};

/** The product's defaults (spec §3.3, §5.4). A measurement changes them, not the code. */
export const DEFAULT_ROUTE_SETTINGS: RouteSettings = {
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
	feedbackNear: 0.95,
	feedbackWeight: 2,
};

const KEYS = [
	"accept",
	"low",
	"margin",
	"approve",
	"multi",
	"feedbackNear",
	"feedbackWeight",
] as const;

function unit(value: unknown, max: number): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= max
	);
}

/** Defaults filled in. An unknown field or a line out of order (`low ≤ accept ≤ approve`) is refused. */
export function routeSettings(partial: object = {}): RouteSettings {
	const raw = partial as Record<string, unknown>;
	for (const key of Object.keys(raw))
		if (!KEYS.includes(key as (typeof KEYS)[number]))
			throw new Error(routeErrors.invalidRequest);
	const settings: RouteSettings = { ...DEFAULT_ROUTE_SETTINGS };
	for (const key of KEYS) {
		if (!Object.hasOwn(raw, key)) continue;
		const max = key === "feedbackWeight" ? 5 : 1;
		const value = raw[key];
		if (!unit(value, max)) throw new Error(routeErrors.invalidRequest);
		settings[key] = value;
	}
	if (!(settings.low <= settings.accept && settings.accept <= settings.approve))
		throw new Error(routeErrors.invalidRequest);
	return settings;
}
