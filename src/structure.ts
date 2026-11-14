/**
 * The structure of an utterance (plan §10 M3b, M3d): which parts are requests,
 * what each makes or operates, what it refers to, and their order. An LLM gives
 * it (the host calls the model through the `analyze` port with this package's
 * prompt); this module builds the prompt, reads the answer back, and says which
 * texts the router routes. Pure: no network, no model.
 */

/** One request: its part of the utterance, its object, its references, the requests it waits for. */
export type StructureRequest = {
	text: string;
	target: string | null;
	inputs: string[];
	after: number[];
};

export type Structure = { requests: StructureRequest[] };

export const STRUCTURE_LIMITS = {
	/** Requests one structure may hold. */
	requests: 8,
	/** The utterance sent, in code points (the router's embedding head). */
	text: 2000,
	/** The previous agent turn sent, in code points. */
	previous: 400,
	/** Native response length, in UTF-16 code units before JSON decoding. */
	response: 65_536,
	/** Literal references in one request of a native response. */
	references: 32,
} as const;

const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((x) => typeof x === "string");

/** Reuse literal and order checks for both recorded and native request objects. */
export function structureFromRequests(
	list: unknown,
	text: string,
	requiredFields?: readonly string[],
): Structure | null {
	if (!Array.isArray(list) || list.length > STRUCTURE_LIMITS.requests)
		return null;
	const requests: StructureRequest[] = [];
	for (const [i, item] of list.entries()) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return null;
		const r = item as Record<string, unknown>;
		if (
			requiredFields &&
			(Object.keys(r).length !== requiredFields.length ||
				!requiredFields.every((key) => Object.hasOwn(r, key)))
		)
			return null;
		const part = r["text"];
		if (typeof part !== "string" || !part.trim() || !text.includes(part))
			return null;
		const target = r["target"] ?? null;
		if (
			target !== null &&
			(typeof target !== "string" || (target && !text.includes(target)))
		)
			return null;
		const inputs = "inputs" in r ? r["inputs"] : [];
		if (
			!strings(inputs) ||
			(requiredFields && inputs.length > STRUCTURE_LIMITS.references) ||
			inputs.some((x) => !x.trim() || !text.includes(x))
		)
			return null;
		const after = "after" in r ? r["after"] : [];
		if (
			!Array.isArray(after) ||
			after.some(
				(a) => !Number.isInteger(a) || (a as number) < 0 || (a as number) >= i,
			)
		)
			return null;
		requests.push({
			text: part,
			target: target || null,
			inputs: [...inputs],
			after: [...(after as number[])],
		});
	}
	return { requests };
}

/**
 * The texts the router routes for a structure: the whole utterance (no structure,
 * or one request that refers to nothing), the utterance with its references masked
 * as 「これ」 (one request with references), or each request part (several; a part
 * that is only its object borrows the predicate of the next one that has one).
 * No request routes nothing.
 */
export function routedTexts(text: string, s: Structure | null): string[] {
	if (!s) return [text];
	const [first, ...rest] = s.requests;
	if (!first) return [];
	if (!rest.length) {
		if (!first.inputs.length) return [text];
		return [maskReferences(text, first)];
	}
	return s.requests.map((r, i) => {
		if (!r.target || r.text !== r.target) return r.text;
		const next = s.requests
			.slice(i + 1)
			.find(
				(n) => n.target && n.text.startsWith(n.target) && n.text !== n.target,
			);
		return next ? r.text + next.text.slice(next.target!.length) : r.text;
	});
}

type Span = { start: number; end: number };

function occurrences(text: string, part: string): Span[] {
	if (!part) return [];
	const spans: Span[] = [];
	for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1))
		spans.push({ start: at, end: at + part.length });
	return spans;
}

/** Positions come from the LLM's literal part/target, never a language rule. */
function maskReferences(text: string, request: StructureRequest): string {
	let target: Span | null = null;
	if (request.target) {
		const parts = occurrences(text, request.text);
		const targets = occurrences(request.text, request.target);
		if (parts.length === 1 && targets.length === 1) {
			target = {
				start: parts[0]!.start + targets[0]!.start,
				end: parts[0]!.start + targets[0]!.end,
			};
		} else {
			const all = occurrences(text, request.target);
			// The answer does not locate the target uniquely: keep the words, rather than guess.
			if (all.length !== 1) return text;
			target = all[0]!;
		}
	}
	const spans = [...new Set(request.inputs)]
		.flatMap((input) => occurrences(text, input))
		.filter((s) => !target || s.end <= target.start || s.start >= target.end)
		.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: Span[] = [];
	for (const span of spans) {
		const last = merged.at(-1);
		if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
		else merged.push({ ...span });
	}
	let at = 0;
	let masked = "";
	for (const span of merged) {
		masked += text.slice(at, span.start) + "これ";
		at = span.end;
	}
	return masked + text.slice(at);
}
