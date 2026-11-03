import type { CardKind, Impact } from "./contracts/cards.ts";
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
import type {
	DecisionCard,
	Ranked,
	RouteCandidate,
	RouteDecision,
} from "./decision/decide.ts";
import { CONVERSATION_ID, decide, MEMORY_ID } from "./decision/decide.ts";
import { offerCandidates, type Skipped } from "./decision/offer.ts";
import { correctProbabilities } from "./decision/correct.ts";
import { routerPassage } from "./retrieval/passages.ts";
import { head, tail } from "./text.ts";
import type { VectorSpace } from "./vector.ts";
import { assertVector } from "./vector.ts";

/** One search hit. `ftsRank` is null: trigram ranking is not scored. */
export type Candidate = {
	id: string;
	revision: string;
	kind: CardKind;
	title: string;
	summary: string;
	useWhen: readonly string[];
	impact: Impact;
	similarity: number | null;
	rank: number;
	ftsRank: null;
	/** A past choice. It does not change rank or slots. */
	fromHistory: boolean;
};

export type Embed = (
	texts: readonly string[],
) => Promise<{ space: VectorSpace; vectors: number[][] }>;

export type Score = (input: RouteInput) => Promise<RouteAnswer>;

export type CandidateQuery = {
	vector: { space: VectorSpace; values: readonly number[] };
	available: (id: string) => boolean;
	/** `"router"` is the wide frame. `"choice"` is the narrower one. */
	slots?: "router" | "choice";
	/** Past choices. They mark candidates and do not change rank or slots. */
	fromHistory?: readonly string[];
	/** When set, an empty index stays empty instead of returning every card. */
	strict?: boolean;
	/**
	 * Cards offered even outside the frame: the right answers of corrections
	 * near this utterance. They come after the frame and do not take its slots;
	 * ids that are not enabled, available cards are left out.
	 */
	include?: readonly string[];
};

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
	score: Score;
	read: {
		candidates: (query: CandidateQuery) => readonly Candidate[];
		nearFeedback: (query: FeedbackQuery) => readonly NearFeedback[];
	};
	settings: RouteSettings;
	log?: RouteLog;
};

export type RouteTurn = {
	state: {
		text: string;
		previousAgent: string | null;
		previousUser: string | null;
	};
	/**
	 * Candidates the host builds: work, pending questions and redirects. The
	 * conversation and a memory request may be here, or in `passages`. Search hits
	 * are not repeated here.
	 */
	dynamic: readonly RouteCandidate[];
	/**
	 * Sentences for the conversation and a memory request. Each one missing from
	 * `dynamic` is added. The host writes the sentences; this package does not.
	 */
	passages?: { conversation: string; memory: string };
	/** Past choices, forwarded to the search. They do not change rank or slots. */
	fromHistory?: readonly string[];
	available: (id: string) => boolean;
	/** The host's instructions for the choice. This package does not write them. */
	instructions: string;
	/** The candidate the host asked about in the turn before (decision rows 5 and 6). */
	asked?: string | null;
	/** Passed through. The decision table does not read it. */
	signals?: { intentChat?: number };
};

export type RouteResult = {
	/** The search frame, in slot order. */
	candidates: readonly Candidate[];
	/** Null when nothing was offered, so the scorer was not called. */
	answer: RouteAnswer | null;
	/** The offer after correction, best probability first. */
	corrected: readonly Ranked[];
	decision: RouteDecision;
	explain: {
		offered: readonly string[];
		skipped: readonly Skipped[];
		conflict: boolean;
		/** Ids of the corrections that disagreed, in the order they were read. */
		conflicts: readonly string[];
		intentChat: number | null;
	};
};

function bounded(state: RouteTurn["state"]) {
	return {
		text: head(state.text, ROUTE_LIMITS.text),
		previousAgent: state.previousAgent
			? tail(state.previousAgent, ROUTE_LIMITS.previous)
			: null,
		previousUser: state.previousUser
			? tail(state.previousUser, ROUTE_LIMITS.previous)
			: null,
	};
}

function retrievedCandidate(row: Candidate, rank: number): RouteCandidate {
	const card: DecisionCard = {
		id: row.id,
		title: row.title,
		...(row.kind === "general" ? { general: true as const } : {}),
		...(row.kind === "pipeline" ? { execution: "pipeline" } : {}),
		...(row.kind === "read" ? { execution: "read" } : {}),
		minImpact: row.impact,
		score: {
			rank,
			ftsRank: null,
			similarity:
				row.similarity === null ? null : Number(row.similarity.toFixed(4)),
			fromHistory: row.fromHistory,
		},
	};
	const choice = { id: row.id, title: row.title };
	const passage = routerPassage(row);
	if (row.kind === "read")
		return { id: row.id, kind: "read", passage, card, choice };
	return { id: row.id, kind: "toolchain", passage, card, choice };
}

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

/**
 * Search, one score, the correction, then the decision table.
 * `read` runs after `embed` and before `score`, both calls synchronous, so the host
 * must not keep a transaction open across either await.
 * An empty offer is decision row 8 and does not call `score`. A blank description,
 * or more criteria than the scorer accepts, is `larm_invalid_route_request`.
 * Conflict ids are returned. This function does not write them.
 */
export async function route(
	ports: RoutePorts,
	turn: RouteTurn,
): Promise<RouteResult> {
	const settings = routeSettings(ports.settings);
	const intentChat = intentOf(turn.signals);
	const state = bounded(turn.state);
	const embedded = await ports.embed([state.text]);
	const vector = embedded.vectors[0];
	if (embedded.vectors.length !== 1 || !vector)
		throw new Error(routeErrors.invalidResponse);
	assertVector(embedded.space, vector);
	const near = ports.read.nearFeedback({
		vector,
		space: embedded.space,
		threshold: settings.feedbackNear,
	});
	// A correction can only move a candidate that is offered, so the right
	// answer of near corrections is offered even when the frame missed it —
	// only when the correction applies (they agree, and the weight is on).
	const rights = [...new Set(near.map((row) => row.rightId))];
	const include =
		settings.feedbackWeight > 0 && rights.length === 1 ? rights : [];
	const retrieved = ports.read.candidates({
		vector: { space: embedded.space, values: vector },
		available: turn.available,
		slots: "router",
		...(turn.fromHistory !== undefined
			? { fromHistory: turn.fromHistory }
			: {}),
		...(include.length ? { include } : {}),
	});
	const skipped: Skipped[] = [];
	const offered = offerCandidates({
		searched: retrieved.map((row, index) => retrievedCandidate(row, index + 1)),
		dynamic: withPassages(turn.dynamic, turn.passages),
		skipped,
	});
	if (!offered.length) {
		const decision = decide([], settings);
		ports.log?.({
			name: "router.decided",
			fields: {
				row: decision.row,
				candidates: 0,
				skipped: skipped.length,
				conflict: 0,
			},
		});
		return {
			candidates: retrieved,
			answer: null,
			corrected: [],
			decision,
			explain: {
				offered: [],
				skipped,
				conflict: false,
				conflicts: [],
				intentChat,
			},
		};
	}
	assertSendable(offered);
	const criteria = offered.map((candidate) => ({
		name: candidate.id,
		description: candidate.passage,
	}));
	const answer = await ports.score({
		text: state.text,
		previousAgent: state.previousAgent,
		previousUser: state.previousUser,
		instructions: turn.instructions,
		criteria,
	});
	assertRouteAnswer(answer, criteria);
	const corrected = correctProbabilities(
		offered.map((candidate) => ({
			id: candidate.id,
			p: answer.probabilities[candidate.id]!,
		})),
		near,
		{ threshold: settings.feedbackNear, weight: settings.feedbackWeight },
	);
	const ranked: Ranked[] = offered.map((candidate, index) => ({
		candidate,
		raw: answer.probabilities[candidate.id]!,
		correction: corrected.shift[index]!,
		p: corrected.p[index]!,
		score: answer.scores ? answer.scores[candidate.id]! : null,
	}));
	ranked.sort((a, b) => b.p - a.p);
	const decision = decide(ranked, settings, turn.asked ?? null);
	const conflicts = corrected.conflict ? near.map((row) => row.id) : [];
	ports.log?.({
		name: "router.decided",
		fields: {
			row: decision.row,
			candidates: offered.length,
			skipped: skipped.length,
			conflict: corrected.conflict ? 1 : 0,
		},
	});
	return {
		candidates: retrieved,
		answer,
		corrected: ranked,
		decision,
		explain: {
			offered: offered.map((candidate) => candidate.id),
			skipped,
			conflict: corrected.conflict,
			conflicts,
			intentChat,
		},
	};
}

function withPassages(
	dynamic: readonly RouteCandidate[],
	passages: RouteTurn["passages"],
): readonly RouteCandidate[] {
	if (!passages) return dynamic;
	const ids = new Set(dynamic.map((candidate) => candidate.id));
	const extra: RouteCandidate[] = [];
	if (!ids.has(CONVERSATION_ID))
		extra.push({
			id: CONVERSATION_ID,
			kind: "conversation",
			passage: passages.conversation,
		});
	if (!ids.has(MEMORY_ID))
		extra.push({
			id: MEMORY_ID,
			kind: "memory",
			passage: passages.memory,
		});
	return extra.length ? [...extra, ...dynamic] : dynamic;
}

/** A set the scorer would refuse as a whole: too many, or a blank description. */
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
