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

/**
 * The prompt the structure was measured with (bench/router/experiments/structure/s3.py).
 * Bump `version` when the text changes: results are tied to it.
 */
export const STRUCTURE_PROMPT: {
	readonly version: string;
	readonly system: string;
} = {
	version: "structure-v1",
	system: `あなたは利用者の発言の構造を判断する。担当（ツール）は選ばない。JSON だけを返す（説明や前置きは書かない）。

形: {"requests":[{"text":"…","target":"…","inputs":["…"],"after":[0]}]}
- requests: 利用者がこの発言で、エージェントに今してほしいこと（依頼）。依頼1つに要素1つ。
- text: 依頼の部分。発言の文字列からそのまま抜き出す（言い換えない、足さない）。
- target: その依頼で作る・操作する物。発言の文字列から抜き出す。なければ null。
- inputs: その依頼が参照・材料として使う物（「この写真」「さっきの表」「それ」など）。作る物ではない。発言の文字列から抜き出す。なければ []。
- after: 先に済ませる依頼の番号（0 から）。前の依頼の結果を使うときや、順番を指定されたとき。そうでなければ []。
- 依頼の中身として出てくるだけの動作は、別の依頼にしない（「動画を撮る予定をメモして」はメモする依頼1つ）。
- 感想・雑談・エージェントへの質問だけの発言は、依頼がない（requests は []）。
- 種類が同じ物を2つ頼まれたら、2つの依頼にする。

例:
発言: さっきの表をグラフにして
{"requests":[{"text":"グラフにして","target":"グラフ","inputs":["さっきの表"],"after":[]}]}
発言: レシピを検索して、材料を買い物リストに追加して
{"requests":[{"text":"レシピを検索して","target":"レシピ","inputs":[],"after":[]},{"text":"材料を買い物リストに追加して","target":"買い物リスト","inputs":["材料"],"after":[0]}]}
発言: 今日はいい天気だね
{"requests":[]}`,
};

const codePoints = (text: string, limit: number) => {
	const points = Array.from(text);
	return points.length <= limit ? text : points.slice(0, limit).join("");
};

/** The two messages the host sends: the package's system text and the turn. */
export function structurePrompt(
	text: string,
	previousAgent: string | null,
): { version: string; system: string; user: string } {
	const before = previousAgent
		? `直前のエージェントの発言: ${codePoints(previousAgent, STRUCTURE_LIMITS.previous)}\n`
		: "";
	return {
		version: STRUCTURE_PROMPT.version,
		system: STRUCTURE_PROMPT.system,
		user: `${before}発言: ${codePoints(text, STRUCTURE_LIMITS.text)}`,
	};
}

const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((x) => typeof x === "string");

/**
 * The model's answer read back: the first `{` to the last `}` as JSON. Null when
 * it is not a structure of this utterance: no requests list, more than 8, a part,
 * object or reference that is not in the utterance (or a blank part or reference),
 * or an order naming a later request. The router then routes the whole utterance, as without the stage.
 */
export function parseStructure(raw: string, text: string): Structure | null {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end < start) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	const list =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as { requests?: unknown }).requests
			: undefined;
	return structureFromRequests(list, text);
}

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
