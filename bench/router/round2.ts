/** Round-2 evaluation helpers: the context subset, the time-ordered split, agreement and bootstrap. */
export const CONTEXT_MARKERS = ["それ", "これ", "この", "その", "あれ", "続き", "作り直", "もう一度", "もう一回", "再生", "はい", "いいよ", "お願い", "さっき", "同じ", "やって", "やり直"];
/** Leans on context: a deictic word or a continuation request. */
export function isContextual(text: string): boolean {
	return CONTEXT_MARKERS.some((m) => text.includes(m));
}
