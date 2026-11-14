import {
	feedbackSources,
	feedbackStates,
	type FeedbackInsert,
	type FeedbackState,
	type FeedbackWrite,
	type NearFeedback,
} from "../contracts/feedback.ts";
import { routerErrors } from "../contracts/errors.ts";
import type { FeedbackQuery } from "../contracts/selection.ts";
import {
	assertVector,
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
} from "../vector.ts";
import type { RouterDb } from "./connection.ts";

const NEAR_SCAN = 500;
const NEAR_LIMIT = 5;
const TEXT_MAX = 2000;
const sources = new Set<string>(feedbackSources);
const states = new Set<string>(feedbackStates);

const cap = (text: string) => text.slice(0, TEXT_MAX);

function messageIdsJson(primary: string, more: readonly string[] = []) {
	return JSON.stringify([...new Set([primary, ...more])]);
}

function assertWrite(input: FeedbackWrite) {
	if (
		typeof input.id !== "string" ||
		input.id.length < 1 ||
		typeof input.conversationId !== "string" ||
		typeof input.messageId !== "string" ||
		input.messageId.length < 1 ||
		typeof input.runId !== "string" ||
		!sources.has(input.source) ||
		typeof input.text !== "string" ||
		(input.wrongId !== null && typeof input.wrongId !== "string") ||
		typeof input.rightId !== "string" ||
		input.rightId.length < 1 ||
		!Number.isInteger(input.at) ||
		input.at < 0 ||
		!Array.isArray(input.messageIds) ||
		input.messageIds.some((id) => typeof id !== "string" || id.length < 1)
	)
		throw new Error(routerErrors.invalidFeedback);
	assertVector(input.space, input.vector);
}

/** Inserts one active correction. The host supplies the id and the time. */
export function recordFeedbackInTransaction(
	db: RouterDb,
	input: FeedbackWrite,
): void {
	assertWrite(input);
	insertFeedbackInTransaction(db, input);
}

/** Inserts an active correction using inputs already checked by the host. */
export function insertFeedbackInTransaction(
	db: RouterDb,
	input: FeedbackInsert,
): void {
	db.query(
		`INSERT INTO router_feedback(
 id, conversation_id, message_id, message_ids_json, run_id, source, query_text,
 query_space, query_vector, wrong_id, right_id, state, created_at, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
	).run(
		input.id,
		input.conversationId,
		input.messageId,
		messageIdsJson(input.messageId, input.messageIds),
		input.runId,
		input.source,
		cap(input.text),
		vectorSpaceKey(input.space),
		packVector(input.vector),
		input.wrongId,
		input.rightId,
		input.at,
		input.at,
	);
}

/**
 * Active corrections of the vector's space at least `threshold` similar, nearest first.
 * The newest 500 are scanned. `limit` defaults to 5.
 */
export function nearFeedback(
	db: RouterDb,
	input: FeedbackQuery,
): NearFeedback[] {
	assertVector(input.space, input.vector);
	if (typeof input.threshold !== "number" || !Number.isFinite(input.threshold))
		throw new Error(routerErrors.invalidFeedback);
	const limit = input.limit;
	if (limit != null && (!Number.isInteger(limit) || limit < 1))
		throw new Error(routerErrors.invalidFeedback);
	return searchFeedback(db, input);
}

/** Searches the newest 500 active corrections in the same space using a host-checked query. */
export function searchFeedback(
	db: RouterDb,
	input: FeedbackQuery,
): NearFeedback[] {
	const rows = db
		.query(
			`SELECT id, wrong_id, right_id, query_vector FROM router_feedback
 WHERE query_space=? AND state='active'
 ORDER BY created_at DESC, rowid DESC LIMIT ?`,
		)
		.all(vectorSpaceKey(input.space), NEAR_SCAN) as Array<{
		id: string;
		wrong_id: string | null;
		right_id: string;
		query_vector: Uint8Array;
	}>;
	return rows
		.map((row) => {
			const values = unpackVector(row.query_vector);
			return {
				id: row.id,
				wrongId: row.wrong_id,
				rightId: row.right_id,
				similarity:
					values.length === input.vector.length
						? dot(values, input.vector)
						: Number.NEGATIVE_INFINITY,
			};
		})
		.filter((row) => row.similarity >= input.threshold)
		.sort((a, b) => b.similarity - a.similarity)
		.slice(0, input.limit ?? NEAR_LIMIT);
}

/** Sets a correction's state. `at` is the host's clock. Returns whether a row changed. */
export function setFeedbackStateInTransaction(
	db: RouterDb,
	id: string,
	state: FeedbackState,
	at: number,
): boolean {
	if (!states.has(state) || !Number.isInteger(at) || at < 0)
		throw new Error(routerErrors.invalidFeedback);
	return updateFeedbackStateInTransaction(db, id, state, at);
}

/** Updates a correction using host-checked inputs. Returns whether a row changed. */
export function updateFeedbackStateInTransaction(
	db: RouterDb,
	id: string,
	state: FeedbackState,
	at: number,
): boolean {
	const changed = db
		.query("UPDATE router_feedback SET state=?, updated_at=? WHERE id=?")
		.run(state, at, id).changes;
	return changed > 0;
}

/**
 * Removes corrections made from any of the messages.
 * Returns how many rows were deleted.
 */
export function forgetInTransaction(
	db: RouterDb,
	messageIds: readonly string[],
): number {
	if (!messageIds.length) return 0;
	let removed = 0;
	for (let i = 0; i < messageIds.length; i += 250) {
		const chunk = messageIds.slice(i, i + 250);
		const marks = chunk.map(() => "?").join(",");
		removed += db
			.query(
				`DELETE FROM router_feedback WHERE message_id IN (${marks})
 OR EXISTS (
  SELECT 1 FROM json_each(router_feedback.message_ids_json) m
  WHERE m.value IN (${marks})
 )`,
			)
			.run(...chunk, ...chunk).changes;
	}
	return removed;
}
