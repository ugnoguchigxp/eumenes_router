/**
 * The router's tables, as migrations the host applies in order, each once, in its own migration system and
 * transaction (as `eumenes-memory/sqlite` and `eumenes-world-model/sqlite` publish theirs). A migration never
 * changes once published; a change of the tables is a new entry. `IF NOT EXISTS` lets a host that already holds a
 * table of the same definition (Eumenes' `router_feedback`, which this one was copied from) keep it.
 */
export const migrations: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS router_cards (
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
`,
];
