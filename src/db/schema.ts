import { dbSchemaVersion } from "../contracts/versions.ts";
import { routerErrors } from "../contracts/errors.ts";
import type { RouterDb } from "./connection.ts";

export const DB_SCHEMA_VERSION = dbSchemaVersion;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS router_cards (
 id TEXT PRIMARY KEY,
 revision TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('dedicated','pipeline','general','read')),
 title TEXT NOT NULL,
 summary TEXT NOT NULL,
 use_when_json TEXT NOT NULL,
 examples_json TEXT NOT NULL,
 impact TEXT NOT NULL CHECK(impact IN ('none','create','modify_existing','irreversible')),
 digest TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS router_passages (
 card_id TEXT NOT NULL,
 revision TEXT NOT NULL,
 item INTEGER NOT NULL,
 space TEXT NOT NULL,
 text_digest TEXT NOT NULL,
 vector BLOB NOT NULL,
 PRIMARY KEY (card_id, item, space)
);
CREATE INDEX IF NOT EXISTS router_passages_card ON router_passages(card_id);
CREATE INDEX IF NOT EXISTS router_passages_space ON router_passages(space);
CREATE TABLE IF NOT EXISTS router_feedback (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 message_ids_json TEXT NOT NULL,
 run_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('redirect','ask_answer','ui_pick','review')),
 query_text TEXT NOT NULL,
 query_space TEXT NOT NULL,
 query_vector BLOB NOT NULL,
 wrong_id TEXT,
 right_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','retracted','stale','conflict')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS router_feedback_space ON router_feedback(query_space, state);
CREATE INDEX IF NOT EXISTS router_feedback_message ON router_feedback(message_id);
CREATE VIRTUAL TABLE IF NOT EXISTS router_passages_fts USING fts5(
 card_id UNINDEXED, text, tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS router_examples (
 source TEXT NOT NULL,
 space TEXT NOT NULL,
 item INTEGER NOT NULL,
 label TEXT NOT NULL,
 vector BLOB NOT NULL,
 PRIMARY KEY (source, space, item)
);
`;

/**
 * Creates the router tables when the database has none.
 * The host calls this inside its own transaction. A newer or older schema is refused
 * rather than altered: this package does not migrate a database it did not create.
 */
export function migrateInTransaction(db: RouterDb): void {
	db.exec(
		`CREATE TABLE IF NOT EXISTS router_schema (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 version INTEGER NOT NULL
)`,
	);
	const row = db
		.query("SELECT version FROM router_schema WHERE id=1")
		.get() as { version: number } | null;
	const version = row ? row.version : null;
	if (version === DB_SCHEMA_VERSION) return;
	if (version !== null && version > DB_SCHEMA_VERSION)
		throw new Error(routerErrors.schemaNewer);
	if (version !== null && version < DB_SCHEMA_VERSION)
		throw new Error(routerErrors.schemaOlder);
	db.exec(SCHEMA);
	db.query("INSERT INTO router_schema(id, version) VALUES (1, ?)").run(
		DB_SCHEMA_VERSION,
	);
}
