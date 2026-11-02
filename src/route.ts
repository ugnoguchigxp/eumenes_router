import type { CardKind, Impact } from "./contracts/cards.ts";
import type { NearFeedback } from "./contracts/feedback.ts";
import {
	assertRouteAnswer,
	ROUTE_LIMITS,
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
import { decide } from "./decision/decide.ts";
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
	 * Candidates the host builds: the conversation, a memory request, work, pending
	 * questions and redirects. Search hits are not repeated here.
	 */
	dynamic: readonly RouteCandidate[];
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
	answer: RouteAnswer;
	/** The offer after correction, best probability first. */
	corrected: readonly Ranked[];
	decision: RouteDecision;
	explain: {
		offered: readonly string[];
		skipped: readonly Skipped[];
		conflict: boolean;
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
			fromHistory: false,
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
 */
export async function route(
	ports: RoutePorts,
	turn: RouteTurn,
): Promise<RouteResult> {
	const settings = routeSettings(ports.settings);
	const state = bounded(turn.state);
	const embedded = await ports.embed([state.text]);
	const vector = embedded.vectors[0];
	if (embedded.vectors.length !== 1 || !vector)
		throw new Error(routeErrors.invalidResponse);
	assertVector(embedded.space, vector);
	const retrieved = ports.read.candidates({
		vector: { space: embedded.space, values: vector },
		available: turn.available,
		slots: "router",
	});
	const near = ports.read.nearFeedback({
		vector,
		space: embedded.space,
		threshold: settings.feedbackNear,
	});
	const skipped: Skipped[] = [];
	const offered = offerCandidates({
		searched: retrieved.map((row, index) => retrievedCandidate(row, index + 1)),
		dynamic: turn.dynamic,
		skipped,
	});
	if (!offered.length) throw new Error(routeErrors.invalidRequest);
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
	const intentChat = intentOf(turn.signals);
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
			intentChat,
		},
	};
}
