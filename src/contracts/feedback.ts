import type { VectorSpace } from "../vector.ts";

export const feedbackSources = [
	"redirect",
	"ask_answer",
	"ui_pick",
	"review",
] as const;
export type FeedbackSource = (typeof feedbackSources)[number];

export const feedbackStates = [
	"active",
	"retracted",
	"stale",
	"conflict",
] as const;
export type FeedbackState = (typeof feedbackStates)[number];

/** A correction near the utterance being routed, with how near (inner product). */
export type NearFeedback = {
	id: string;
	wrongId: string | null;
	rightId: string;
	similarity: number;
};

/**
 * One correction to store. The host chooses `id` and `at` (this package has no clock
 * and no random source). `messageIds` are every message the text was made from.
 */
export type FeedbackWrite = {
	id: string;
	conversationId: string;
	messageId: string;
	messageIds: readonly string[];
	runId: string;
	source: FeedbackSource;
	text: string;
	space: VectorSpace;
	vector: readonly number[];
	wrongId: string | null;
	rightId: string;
	at: number;
};
