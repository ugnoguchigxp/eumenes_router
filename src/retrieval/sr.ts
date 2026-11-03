import type { CardKind } from "../contracts/cards.ts";
import { CONVERSATION_ID } from "../decision/decide.ts";
import { dot } from "../vector.ts";
import { ROUTER_SLOTS, slotKind, type Slots } from "./rank.ts";

/**
 * sr-corr: the retrieval score best-v2 was trained on. Per card, the mean of four
 * features: meaning (best inner product of the utterance with the card's
 * passages), prototype (0.7·best + 0.3·mean of the top three), lexical (bm25 of
 * shared character trigrams, divided by the best hit) and the referenced
 * resource's kind. Meaning and prototype are stretched to 0..1 within the
 * candidates, so the candidates must be every available card, as in training.
 * The conversation is fixed at 0.7. The offer is the top 8 (the conversation
 * always in), divided by the best score and turned into probabilities by a
 * softmax at temperature 0.1; probabilities and scores are rounded to six
 * decimals, as the trained numbers expect. Pure. Same numbers as
 * `bench/router/algorithms.ts` `srWeighted` with `SR_CAL` and `bench/router/run.ts`.
 */
export const SR = {
	conversation: 0.7,
	prototypeWeight: 0.7,
	prototypeTop: 3,
	offer: 8,
	temperature: 0.1,
} as const;

/** Resource kinds a host may pass, and words on cards that serve them. */
const RESOURCE_WORDS: Readonly<Record<string, readonly string[]>> = {
	image: ["画像", "写真", "イメージ"],
	pdf: ["文書", "PDF"],
	document: ["文書"],
	repository: ["GitHub", "リポジトリ", "コード"],
	audio: ["曲", "音楽"],
	video: ["動画"],
};

export type SrCard = {
	id: string;
	kind: CardKind;
	title: string;
	summary: string;
	/** The card's passage vectors, in the utterance's space. */
	passages: readonly ArrayLike<number>[];
};

export type SrOffer = {
	/** The offered candidates and their probabilities (the conversation included), best first. */
	retrieval: Array<[string, number]>;
	/** Each offered candidate's score divided by the best. */
	scores: Record<string, number>;
};

/** The utterance's character trigrams as an FTS5 OR query; null under three characters. NUL is dropped (SQLite ends a string there). */
export function trigramQuery(text: string): string | null {
	const chars = [
		...text.normalize("NFKC").replace(/\s+/g, "").replaceAll("\u0000", ""),
	];
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= chars.length; i++)
		grams.add(chars.slice(i, i + 3).join(""));
	if (!grams.size) return null;
	return [...grams].map((g) => `"${g.replaceAll('"', '""')}"`).join(" OR ");
}

const unit = (m: ReadonlyMap<string, number>) => {
	const top = Math.max(0, ...m.values());
	return new Map(
		[...m].map(([k, v]) => [k, top > 0 ? Math.max(0, v) / top : 0]),
	);
};
const band = (m: ReadonlyMap<string, number>) => {
	const values = [...m.values()];
	const lo = Math.min(...values);
	const hi = Math.max(...values);
	return new Map(
		[...m].map(([k, v]) => [k, hi > lo ? (v - lo) / (hi - lo) : 0]),
	);
};
const round = (v: number) => Number(v.toFixed(6));

/**
 * Scores of the candidates. `cards` are the available tool cards; `lexical` is
 * the best −bm25 per card over every indexed card (not only the candidates).
 */
export function srScores(input: {
	vector: ArrayLike<number>;
	cards: readonly SrCard[];
	lexical: ReadonlyMap<string, number>;
	resource?: string | null;
	conversation: boolean;
}): Map<string, number> {
	const tools = input.cards.filter((card) => card.id !== CONVERSATION_ID);
	const lexical = unit(input.lexical);
	const meaning = new Map<string, number>();
	const prototype = new Map<string, number>();
	for (const card of tools) {
		const sims = card.passages
			.map((p) => dot(input.vector, p))
			.sort((a, b) => b - a);
		if (!sims.length) continue;
		meaning.set(card.id, sims[0]!);
		const top = sims.slice(0, SR.prototypeTop);
		prototype.set(
			card.id,
			SR.prototypeWeight * sims[0]! +
				(1 - SR.prototypeWeight) *
					(top.reduce((s, v) => s + v, 0) / top.length),
		);
	}
	const meaningU = band(meaning);
	const prototypeU = band(prototype);
	const words = input.resource
		? (RESOURCE_WORDS[input.resource] ?? [input.resource])
		: null;
	const out = new Map<string, number>();
	for (const card of tools) {
		const prior =
			words &&
			words.some((w) => card.summary.includes(w) || card.title.includes(w))
				? 1
				: 0;
		const f =
			(meaningU.get(card.id) ?? 0) +
			Math.max(lexical.get(card.id) ?? 0, 0) +
			(prototypeU.get(card.id) ?? 0) +
			prior;
		out.set(card.id, f / 4);
	}
	if (input.conversation) out.set(CONVERSATION_ID, SR.conversation);
	return out;
}

/**
 * The kind slots (plan decision 1) over a ranking: at most `slots[kind]` cards
 * of each kind, read tools in the dedicated slot; the conversation is not counted.
 */
export function capByKind(
	ranked: readonly string[],
	kindOf: (id: string) => CardKind | undefined,
	slots: Pick<Slots, "dedicated" | "pipeline" | "general"> = ROUTER_SLOTS,
): string[] {
	const used = { dedicated: 0, pipeline: 0, general: 0 };
	return ranked.filter((id) => {
		if (id === CONVERSATION_ID) return true;
		const kind = kindOf(id);
		if (!kind) return true;
		const slot = slotKind(kind);
		if (used[slot] >= slots[slot]) return false;
		used[slot]++;
		return true;
	});
}

/** The top of the scores as the offer best-v2 takes (the conversation always in). */
export function srOffer(
	scores: ReadonlyMap<string, number>,
	cap?: (ranked: readonly string[]) => string[],
): SrOffer {
	const sorted = [...scores]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([id]) => id);
	const order = (cap ? cap(sorted) : sorted).slice(0, SR.offer);
	if (!order.includes(CONVERSATION_ID) && scores.has(CONVERSATION_ID)) {
		if (order.length >= SR.offer) order.pop();
		order.push(CONVERSATION_ID);
	}
	const best = Math.max(0, ...order.map((id) => scores.get(id) ?? 0));
	const scaled = order.map((id) =>
		best > 0 ? Math.max(0, scores.get(id) ?? 0) / best : 0,
	);
	const top = Math.max(...scaled);
	const exp = scaled.map((v) => Math.exp((v - top) / SR.temperature));
	const total = exp.reduce((s, v) => s + v, 0);
	return {
		retrieval: order.map((id, i) => [id, round(exp[i]! / total)]),
		scores: Object.fromEntries(order.map((id, i) => [id, round(scaled[i]!)])),
	};
}
