/**
 * `eumenes_router/sqlite`. Synchronous reads and writes on a connection the host lends.
 * The host opens, closes, and wraps the call in a transaction. This module does none of that.
 */
export type { RouterDb, SqlValue } from "./db/connection.ts";
export { migrateInTransaction, DB_SCHEMA_VERSION } from "./db/schema.ts";
export {
	candidatesInTransaction,
	saveVectorsInTransaction,
	syncCardsInTransaction,
} from "./db/cards.ts";
export type { VectorRow } from "./db/cards.ts";
export {
	forgetInTransaction,
	nearFeedback,
	recordFeedbackInTransaction,
	setFeedbackStateInTransaction,
} from "./db/feedback.ts";
export type { Candidate, CandidateQuery, FeedbackQuery } from "./route.ts";
export type { Card, Passage } from "./contracts/cards.ts";
export type {
	FeedbackState,
	FeedbackWrite,
	NearFeedback,
} from "./contracts/feedback.ts";
export type { VectorSpace } from "./vector.ts";
export { dbSchemaVersion } from "./contracts/versions.ts";
