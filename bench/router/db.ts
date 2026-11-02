/**
 * The bench's own SQLite file: cards, utterances, past choices, labels, the
 * embedding cache and a trigram FTS index. Not the router schema and not an
 * Eumenes database. Only the bench opens it.
 */
import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bench_cards (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL,
 impact TEXT NOT NULL,
 card_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_passages (
 card_id TEXT NOT NULL,
 item INTEGER NOT NULL,
 text TEXT NOT NULL,
 PRIMARY KEY (card_id, item)
);
CREATE VIRTUAL TABLE IF NOT EXISTS bench_fts USING fts5(
 card_id UNINDEXED, text, tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS bench_utterances (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 utterance_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_choices (
 utterance_id TEXT PRIMARY KEY,
 chosen_id TEXT NOT NULL,
 choice_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_labels (
 utterance_id TEXT PRIMARY KEY,
 split TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reviewed','hold')),
 label_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bench_embeddings (
 model TEXT NOT NULL,
 text_hash TEXT NOT NULL,
 dimension INTEGER NOT NULL,
 vector BLOB NOT NULL,
 PRIMARY KEY (model, text_hash)
);
`;

export function openBench(path: string): Database {
	const db = new Database(path, { create: true });
	db.exec("PRAGMA journal_mode=WAL");
	db.exec(SCHEMA);
	return db;
}
