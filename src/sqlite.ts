/**
 * `eumenes_router/sqlite`. Synchronous reads and writes on a connection the host lends.
 * The host opens, closes, and wraps the call in a transaction. This module does none of that.
 * `migrations` are the tables' SQL, which the host applies in its own migration system.
 */
export type { RouterDb, SqlValue } from "./db/connection.ts";
export { migrations } from "./db/schema.ts";
export {
	saveVectorsInTransaction,
	syncCardsInTransaction,
} from "./db/cards.ts";
export type { VectorRow } from "./db/cards.ts";
export {
	examplesInTransaction,
	importExamplesInTransaction,
	lexicalInTransaction,
	srCardsInTransaction,
} from "./db/retrieval.ts";
export {
	forgetInTransaction,
	nearFeedback,
	recordFeedbackInTransaction,
	setFeedbackStateInTransaction,
} from "./db/feedback.ts";
export type { FeedbackQuery } from "./route.ts";
export type { RouterCard } from "./db/retrieval.ts";
export type { Card, Passage } from "./contracts/cards.ts";
export type {
	FeedbackState,
	FeedbackWrite,
	NearFeedback,
} from "./contracts/feedback.ts";
export type { VectorSpace } from "./vector.ts";
export { dbSchemaVersion } from "./contracts/versions.ts";
