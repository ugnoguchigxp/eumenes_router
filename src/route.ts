import type { NearFeedback } from "./contracts/feedback.ts";
import {
	assertRouteAnswer,
	ROUTE_LIMITS,
	routeCriterionName,
	routeErrors,
	type RouteAnswer,
	type RouteInput,
} from "./contracts/route.ts";
import { routeSettings, type RouteSettings } from "./contracts/settings.ts";
import type { RouterCard } from "./db/retrieval.ts";
import { correctProbabilities } from "./decision/correct.ts";
import type {
	DecisionCard,
	Ranked,
	RouteCandidate,
	RouteDecision,
} from "./decision/decide.ts";
import { CONVERSATION_ID, decide, MEMORY_ID } from "./decision/decide.ts";
import { offerCandidates, type Skipped } from "./decision/offer.ts";
import { rerankDocument } from "./retrieval/passages.ts";
import { capByKind, srOffer, srRanking, srScores } from "./retrieval/sr.ts";
import { scoreBestV2, type BestV2Model } from "./scoring/best-v2.ts";
import {
	parseStructure,
	routedTexts,
	structurePrompt,
	type Structure,
} from "./structure.ts";
import { head, tail } from "./text.ts";
import type { VectorSpace } from "./vector.ts";
import { assertVector } from "./vector.ts";

export type Embed = (
	texts: readonly string[],
) => Promise<{ space: VectorSpace; vectors: number[][] }>;

/** The reranker (LARM's context judgment): an answer with `scores` for every criterion sent. */
export type Score = (input: RouteInput) => Promise<RouteAnswer>;

/** The structure model: the package's prompt in, the model's text out (structured route only). */
export type Analyze = (prompt: {
	version: string;
	system: string;
	user: string;
}) => Promise<string>;

export type FeedbackQuery = {
	vector: readonly number[];
	space: VectorSpace;
	threshold: number;
	limit?: number;
};

/**
 * A line the host may log. Fields are ids and numbers: no utterance, no vector,
 * no scorer body.
 */
export type RouteLog = (event: {
	name: string;
	fields: Record<string, string | number>;
}) => void;

export type RoutePorts = {
	embed: Embed;
	rerank: Score;
	read: {
		/** Enabled, available cards with their passage vectors in the space (`srCardsInTransaction`). */
		cards: (query: {
			space: VectorSpace;
			available: (id: string) => boolean;
		}) => readonly RouterCard[];
		/** The lexical index's best −bm25 per card (`lexicalInTransaction`). */
		lexical: (text: string) => ReadonlyMap<string, number>;
		nearFeedback: (query: FeedbackQuery) => readonly NearFeedback[];
	};
	/** best-v2 loaded with the host's memory (`loadBestV2(BEST_V2_PARAMS, memory)`). */
	model: BestV2Model;
	settings: RouteSettings;
	log?: RouteLog;
};

export type StructuredPorts = RoutePorts & { analyze: Analyze };

export type RouteTurn = {
	state: {
		text: string;
		previousAgent: string | null;
		previousUser: string | null;
	};
	/**
	 * Candidates the host builds: work, pending questions and redirects. The
	 * conversation and a memory request come from the synced cards; a sentence
	 * for them may be given in `passages`. Search hits are not repeated here.
	 */
	dynamic: readonly RouteCandidate[];
	/** Sentences for the conversation and a memory request when the host writes them. */
	passages?: { conversation: string; memory: string };
	available: (id: string) => boolean;
	/** The host's instructions for the reranker. This package does not write them. */
	instructions: string;
	/**
	 * The kind of the resource the utterance refers to (image, audio, …), when the
	 * host knows it. The structured route uses it only for the whole utterance.
	 */
	resource?: string | null;
	/** The candidate the host asked about in the turn before (decision rows 5 and 6). */
	asked?: string | null;
	/** Passed through. The decision table does not read it. */
	signals?: { intentChat?: number };
};

export type RouteResult = {
	/** The reranker's answer; null when no tool was offered, so it was not called. */
	answer: RouteAnswer | null;
	/** The offer after best-v2 and the correction, best first. */
	corrected: readonly Ranked[];
	decision: RouteDecision;
	explain: {
		/** sr-corr's offer (top 8 after the kind slots, the conversation included) with its probabilities. */
		retrieval: ReadonlyArray<readonly [string, number]>;
		offered: readonly string[];
		skipped: readonly Skipped[];
		/** best-v2's top-two gap and whether it was below the defer threshold (not sure). */
		gate: number | null;
		defer: boolean | null;
		conflict: boolean;
		/** Ids of the corrections that disagreed, in the order they were read. */
		conflicts: readonly string[];
		intentChat: number | null;
	};
};

export type StructuredResult = {
	/** The model's structure; null when the answer was not a structure of the utterance. */
	structure: Structure | null;
	/** One routing per routed text: the whole utterance, the masked one, or each request part. */
	parts: ReadonlyArray<{ text: string; result: RouteResult }>;
	decision: RouteDecision;
};

function intentOf(signals: RouteTurn["signals"]): number | null {
	if (!signals || signals.intentChat === undefined) return null;
	const value = signals.intentChat;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 1
	)
		throw new Error(routeErrors.invalidRequest);
	return value;
}

function cardCandidate(
	card: RouterCard,
	rank: number,
	passages: RouteTurn["passages"],
): RouteCandidate {
	// A card's document is cut at the reranker's limit rather than dropped from the offer.
	const passage = head(rerankDocument(card), ROUTE_LIMITS.description);
	if (card.id === CONVERSATION_ID)
		return {
			id: card.id,
			kind: "conversation",
			passage: passages?.conversation ?? passage,
		};
	if (card.id === MEMORY_ID)
		return {
			id: card.id,
			kind: "memory",
			passage: passages?.memory ?? passage,
		};
	const decisionCard: DecisionCard = {
		id: card.id,
		title: card.title,
		...(card.kind === "general" ? { general: true as const } : {}),
		...(card.kind === "pipeline" ? { execution: "pipeline" } : {}),
		...(card.kind === "read" ? { execution: "read" } : {}),
		minImpact: card.impact,
		score: { rank, ftsRank: null, similarity: null, fromHistory: false },
	};
	const choice = { id: card.id, title: card.title };
	if (card.kind === "read")
		return { id: card.id, kind: "read", passage, card: decisionCard, choice };
	return {
		id: card.id,
		kind: "toolchain",
		passage,
		card: decisionCard,
		choice,
	};
}

/** Criteria the reranker would refuse as a whole: too many, a bad name, a blank or too long description. */
function assertSendable(offered: readonly RouteCandidate[]): void {
	if (offered.length > ROUTE_LIMITS.criteria)
		throw new Error(routeErrors.invalidRequest);
	const seen = new Set<string>();
	for (const candidate of offered) {
		if (
			seen.has(candidate.id) ||
			!routeCriterionName.test(candidate.id) ||
			candidate.passage.length > ROUTE_LIMITS.description ||
			!candidate.passage.trim()
		)
			throw new Error(routeErrors.invalidRequest);
		seen.add(candidate.id);
	}
}

/**
 * One text through the direct route: embedding, near corrections, sr-corr
 * (offer and ranking), the reranker on the offered and extra tools, best-v2,
 * the correction, the decision table with best-v2's gate as "sure".
 */
async function routeText(
	ports: RoutePorts,
	turn: RouteTurn,
	text: string,
	resource: string | null,
): Promise<RouteResult> {
	const settings = routeSettings(ports.settings);
	const intentChat = intentOf(turn.signals);
	const model = ports.model;
	const embedText = head(text, ROUTE_LIMITS.text);
	const embedded = await ports.embed([embedText]);
	const vector = embedded.vectors[0];
	if (embedded.vectors.length !== 1 || !vector)
		throw new Error(routeErrors.invalidResponse);
	assertVector(embedded.space, vector);
	const near = ports.read.nearFeedback({
		vector,
		space: embedded.space,
		threshold: settings.feedbackNear,
	});
	// A correction moves only an offered candidate: the right answer of near
	// corrections is offered when the correction applies (they agree, weight on).
	const rights = [...new Set(near.map((row) => row.rightId))];
	const include =
		settings.feedbackWeight > 0 && rights.length === 1 ? rights : [];
	const cards = ports.read.cards({
		space: embedded.space,
		available: turn.available,
	});
	const byId = new Map(cards.map((card) => [card.id, card]));
	const cap = (ranked: readonly string[]) =>
		capByKind(ranked, (id: string) => byId.get(id)?.kind);
	const scores = srScores({
		vector,
		cards,
		lexical: ports.read.lexical(embedText),
		resource,
		conversation: true,
	});
	const offer = srOffer(scores, cap);
	const ranking = srRanking(scores, cap);
	const offeredIds = offer.retrieval.map(([id]) => id);
	const extraIds = ranking
		.slice(0, model.params.extra.tools)
		.map(([id]) => id)
		.filter((id) => !offeredIds.includes(id));
	const searchedIds = [
		...offeredIds,
		...extraIds,
		...include.filter(
			(id) =>
				byId.has(id) && !offeredIds.includes(id) && !extraIds.includes(id),
		),
	];
	const skipped: Skipped[] = [];
	const offered = offerCandidates({
		searched: searchedIds
			.filter((id) => byId.has(id))
			.map((id, i) => cardCandidate(byId.get(id)!, i + 1, turn.passages)),
		dynamic: turn.dynamic,
		skipped,
	});
	const sent = offered.filter((c) => c.kind !== "conversation");
	const conversation = offered.find((c) => c.kind === "conversation") ?? {
		id: CONVERSATION_ID,
		kind: "conversation" as const,
		passage: turn.passages?.conversation ?? CONVERSATION_ID,
	};
	const base = {
		retrieval: offer.retrieval,
		offered: offered.map((c) => c.id),
		skipped,
		intentChat,
	};
	if (!sent.length) {
		const decision = decide([], settings);
		ports.log?.({
			name: "router.decided",
			fields: { row: decision.row, candidates: 0, skipped: skipped.length },
		});
		return {
			answer: null,
			corrected: [],
			decision,
			explain: {
				...base,
				gate: null,
				defer: null,
				conflict: false,
				conflicts: [],
			},
		};
	}
	assertSendable(sent);
	const criteria = sent.map((c) => ({ name: c.id, description: c.passage }));
	const answer = await ports.rerank({
		text: head(text, ROUTE_LIMITS.rerankText),
		previousAgent: turn.state.previousAgent
			? tail(turn.state.previousAgent, ROUTE_LIMITS.previous)
			: null,
		previousUser: turn.state.previousUser
			? tail(turn.state.previousUser, ROUTE_LIMITS.previous)
			: null,
		instructions: turn.instructions,
		criteria,
	});
	assertRouteAnswer(answer, criteria);
	if (!answer.scores) throw new Error(routeErrors.invalidResponse);
	const rerank = answer.scores;
	const dynamicIds = sent.filter((c) => !byId.has(c.id)).map((c) => c.id);
	const best = scoreBestV2(model, {
		retrieval: offer.retrieval,
		retrievalScores: offer.scores,
		rerank,
		ranking,
		include: [...include, ...dynamicIds],
		vector,
	});
	const candidateOf = new Map<string, RouteCandidate>([
		...offered.map((c) => [c.id, c] as const),
		[CONVERSATION_ID, conversation],
	]);
	const kept = best.ranked.filter((r) => candidateOf.has(r.id));
	const corrected = correctProbabilities(kept, near, {
		threshold: settings.feedbackNear,
		weight: settings.feedbackWeight,
	});
	const ranked: Ranked[] = kept.map((r, i) => ({
		candidate: candidateOf.get(r.id)!,
		raw: r.p,
		correction: corrected.shift[i]!,
		p: corrected.p[i]!,
		score: Object.hasOwn(rerank, r.id) ? rerank[r.id]! : null,
	}));
	ranked.sort((a, b) => b.p - a.p);
	// Sure when best-v2 does not defer and the correction left its top in place;
	// unsure tops are still run with a notice (row 3) or confirmed (row 4), never asked about (low 0).
	const sure = !best.defer && ranked[0]?.candidate.id === kept[0]?.id;
	const decision = decide(
		ranked,
		{ ...settings, low: 0 },
		turn.asked ?? null,
		sure,
	);
	const conflicts = corrected.conflict ? near.map((row) => row.id) : [];
	ports.log?.({
		name: "router.decided",
		fields: {
			row: decision.row,
			candidates: offered.length,
			skipped: skipped.length,
			defer: best.defer ? 1 : 0,
			conflict: corrected.conflict ? 1 : 0,
		},
	});
	return {
		answer,
		corrected: ranked,
		decision,
		explain: {
			...base,
			gate: best.gate,
			defer: best.defer,
			conflict: corrected.conflict,
			conflicts,
		},
	};
}

/**
 * The direct route (mainline A, plan §10 M3d): the whole utterance through
 * sr-corr, the reranker and best-v2, then the correction and the decision table.
 * `read` runs between the awaits, synchronously, so the host must not keep a
 * transaction open across an await. With no tool offered the reranker is not
 * called and the decision is row 8. Conflict ids are returned, not written.
 */
export async function route(
	ports: RoutePorts,
	turn: RouteTurn,
): Promise<RouteResult> {
	return routeText(ports, turn, turn.state.text, turn.resource ?? null);
}

/**
 * The structured route (mainline B, plan §10 M3d): the structure model first
 * (the host's `analyze` with this package's prompt), then the direct route on
 * what the structure says to route. No request: the conversation (row 1). One
 * request: the utterance, with its references masked as 「これ」 when it has
 * some (then without the resource hint). Several: each part; parts of two or
 * more tools go to the pipeline stage, of one tool to that tool. An answer that
 * is not a structure of the utterance routes the whole utterance (as route()).
 */
export async function routeStructured(
	ports: StructuredPorts,
	turn: RouteTurn,
): Promise<StructuredResult> {
	const text = turn.state.text;
	const raw = await ports.analyze(
		structurePrompt(text, turn.state.previousAgent),
	);
	const structure = parseStructure(raw, text);
	const texts = routedTexts(text, structure);
	if (structure && !texts.length) {
		ports.log?.({
			name: "router.structured",
			fields: { requests: 0, parts: 0, row: 1 },
		});
		return {
			structure,
			parts: [],
			decision: { row: 1, to: "conversation" },
		};
	}
	const parts: Array<{ text: string; result: RouteResult }> = [];
	for (const part of texts)
		parts.push({
			text: part,
			result: await routeText(
				ports,
				turn,
				part,
				part === text ? (turn.resource ?? null) : null,
			),
		});
	const decision =
		parts.length === 1 ? parts[0]!.result.decision : several(structure!, parts);
	ports.log?.({
		name: "router.structured",
		fields: {
			requests: structure ? structure.requests.length : -1,
			parts: parts.length,
			row: decision.row,
		},
	});
	return { structure, parts, decision };
}

/** Several request parts: the pipeline stage when their tops are two or more tools, else that one tool or the conversation. */
function several(
	structure: Structure,
	parts: ReadonlyArray<{ text: string; result: RouteResult }>,
): RouteDecision {
	const tops = parts.map((p) => p.result.corrected[0]?.candidate ?? null);
	const tools = [
		...new Set(
			tops.filter((c) => c && c.kind !== "conversation").map((c) => c!.id),
		),
	];
	if (tools.length >= 2)
		return {
			row: 9,
			to: "pipeline",
			steps: parts.map((p, i) => ({
				text: p.text,
				candidate: tops[i] ?? {
					id: CONVERSATION_ID,
					kind: "conversation",
					passage: CONVERSATION_ID,
				},
				after: structure.requests[i]!.after,
			})),
		};
	if (tools.length === 1)
		return parts[tops.findIndex((c) => c?.id === tools[0])]!.result.decision;
	return { row: 1, to: "conversation" };
}
