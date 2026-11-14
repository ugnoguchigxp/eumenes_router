import {
	STRUCTURE_LIMITS,
	structureFromRequests,
	type Structure,
} from "../../src/structure.ts";

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
