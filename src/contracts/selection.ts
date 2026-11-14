import type { NearFeedback } from "./feedback.ts";
import type { RouterCard } from "../db/retrieval.ts";
import type { RouteCandidate } from "../decision/result.ts";
import type { PendingQuestion, WorkControl } from "../turn-structure.ts";
import type { VectorSpace } from "../vector.ts";

export type Embed = (
	texts: readonly string[],
) => Promise<{ space: VectorSpace; vectors: number[][] }>;

/** A host call returning the model's structured output as a JSON string. */
export type Analyze = (prompt: {
	version: string;
	system: string;
	user: string;
	outputSchema: Record<string, unknown>;
}) => Promise<string>;

export type FeedbackQuery = {
	vector: readonly number[];
	space: VectorSpace;
	threshold: number;
	limit?: number;
};

export type SearchPorts = {
	embed: Embed;
	read: {
		cards: (query: {
			space: VectorSpace;
			available: (id: string) => boolean;
		}) => readonly RouterCard[];
		lexical: (text: string) => ReadonlyMap<string, number>;
		nearFeedback: (query: FeedbackQuery) => readonly NearFeedback[];
	};
};

export type SelectionTurn = {
	state: {
		text: string;
		previousAgent: string | null;
		previousUser: string | null;
	};
	/**
	 * Candidates the host builds: references for pending questions and cancellable work.
	 */
	dynamic?: readonly RouteCandidate[];
	/** Current, conversation-scoped questions validated by the host. */
	pending?: readonly PendingQuestion[];
	/** Finite references to currently cancellable work. */
	controls?: readonly WorkControl[];
	/** An optional host description for the memory request. */
	passages?: { memory: string };
	/**
	 * Synced cards the host keeps on offer though the search may not find them: the
	 * toolchains of the work in progress.
	 */
	retained?: readonly string[];
	available: (id: string) => boolean;
	/**
	 * The kind of the resource the utterance refers to (image, audio, …), when the
	 * host knows it. The structured route uses it only for the whole utterance.
	 */
	resource?: string | null;
};

export type SelectionSettings = {
	feedbackNear: number;
	/** A positive value enables candidate expansion using recent corrections. */
	feedbackWeight: number;
};

export function selectionSettings(
	input: SelectionSettings | undefined,
): SelectionSettings {
	const { feedbackNear = 0.95, feedbackWeight = 2 } = input ?? {};
	if (
		!Number.isFinite(feedbackNear) ||
		feedbackNear < 0 ||
		feedbackNear > 1 ||
		!Number.isFinite(feedbackWeight) ||
		feedbackWeight < 0 ||
		feedbackWeight > 5
	)
		throw new Error("route_selection_invalid_settings");
	return { feedbackNear, feedbackWeight };
}
