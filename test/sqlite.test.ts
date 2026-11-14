import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cardDigest,
	dbSchemaVersion,
	type Card,
	type VectorSpace,
	routerErrors,
} from "../src/index.ts";
import { BEST_V2_MEMORY_FORMAT } from "../bench/legacy/scoring/best-v2.ts";
import {
	forgetInTransaction,
	insertFeedbackInTransaction,
	migrations,
	nearFeedback,
	recordFeedbackInTransaction,
	searchFeedback,
	saveVectorsInTransaction,
	srCardsInTransaction,
	setFeedbackStateInTransaction,
	updateFeedbackStateInTransaction,
	syncCardsInTransaction,
	lexicalInTransaction,
	type FeedbackInsert,
} from "../src/sqlite.ts";
import {
	importExamplesInTransaction,
	examplesInTransaction,
} from "../bench/legacy/db/example-memory.ts";

const space: VectorSpace = {
	modelId: "embed",
	revision: "1",
	artifactDigest: "digest",
	dimension: 2,
};

function card(id: string, examples: string[] = ["例"]): Card {
	const body = {
		id,
		revision: `rev-${id}`,
		kind: "dedicated" as const,
		title: id,
		summary: "説明",
		useWhen: ["使う"],
		examples,
		impact: "none" as const,
	};
	return { ...body, digest: cardDigest(body) };
}

function open() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes_router-"));
	const db = new Database(join(dir, "router.sqlite"));
	db.exec("PRAGMA journal_mode = WAL");
	for (const sql of migrations) db.exec(sql);
	return {
		db,
		close() {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("host reopen and backup restore preserve state; replayed forgetting removes restored corrections", () => {
	const dir = mkdtempSync(join(tmpdir(), "router-recovery-"));
	const path = join(dir, "state.db");
	const backup = join(dir, "backup.db");
	let db = new Database(path);
	try {
		for (const sql of migrations) db.exec(sql);
		db.transaction(() => {
			const pending = syncCardsInTransaction(
				db,
				[card("a", ["永続化の例"])],
				space,
			).pending;
			saveVectorsInTransaction(
				db,
				space,
				pending.map((p) => ({ ...p, vector: [1, 0] })),
			);
			importExamplesInTransaction(
				db,
				{
					format: BEST_V2_MEMORY_FORMAT,
					source: "persist",
					dimension: 2,
					labels: ["a"],
					vectors: Buffer.from(new Float32Array([1, 0]).buffer).toString(
						"base64",
					),
				},
				space,
			);
			recordFeedbackInTransaction(db, {
				id: "f",
				conversationId: "c",
				messageId: "m",
				messageIds: ["related"],
				runId: "r",
				source: "review",
				text: "合成の訂正",
				space,
				vector: [1, 0],
				wrongId: null,
				rightId: "a",
				at: 1,
			});
		})();
		db.close();
		copyFileSync(path, backup);
		db = new Database(path);
		expect(
			srCardsInTransaction(db, { space, available: () => true })[0]!.passages,
		).toHaveLength(3);
		expect(lexicalInTransaction(db, "永続化").has("a")).toBe(true);
		expect(
			examplesInTransaction(db, { source: "persist", space })!.labels,
		).toEqual(["a"]);
		expect(
			nearFeedback(db, { space, vector: [1, 0], threshold: 0.9 }),
		).toHaveLength(1);
		expect(() =>
			db.transaction(() => {
				setFeedbackStateInTransaction(db, "f", "retracted", 2);
				throw new Error("crash_before_commit");
			})(),
		).toThrow("crash_before_commit");
		expect(
			nearFeedback(db, { space, vector: [1, 0], threshold: 0.9 }),
		).toHaveLength(1);
		expect(forgetInTransaction(db, ["related"])).toBe(1);
		db.close();
		copyFileSync(backup, path);
		db = new Database(path);
		// A backup predates a forget request. The host must replay its deletion ledger before serving it.
		expect(forgetInTransaction(db, ["related"])).toBe(1);
		expect(forgetInTransaction(db, ["related"])).toBe(0);
		expect(nearFeedback(db, { space, vector: [1, 0], threshold: 0.9 })).toEqual(
			[],
		);
		expect(setFeedbackStateInTransaction(db, "missing", "retracted", 3)).toBe(
			false,
		);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("changed passages are pending, saved vectors are read back, a disabled card leaves", () => {
	const { db, close } = open();
	try {
		const music = card("music.create");
		const image = card("image.create", ["絵を描いて"]);
		const first = syncCardsInTransaction(db, [music, image], space);
		expect(first.pending.map((row) => `${row.id}:${row.item}`)).toEqual([
			"music.create:0",
			"music.create:1",
			"music.create:2",
			"image.create:0",
			"image.create:1",
			"image.create:2",
		]);
		saveVectorsInTransaction(
			db,
			space,
			first.pending.map((row) => ({
				...row,
				vector: row.id === "music.create" && row.item === 0 ? [1, 0] : [0, 1],
			})),
		);
		expect(syncCardsInTransaction(db, [music, image], space).pending).toEqual(
			[],
		);
		const found = srCardsInTransaction(db, { space, available: () => true });
		expect(found.map((row) => [row.id, row.passages.length])).toEqual([
			["image.create", 3],
			["music.create", 3],
		]);
		expect(found.find((row) => row.id === "image.create")?.examples).toEqual([
			"絵を描いて",
		]);
		const changed = card("music.create", ["別の例"]);
		const again = syncCardsInTransaction(db, [changed], space);
		expect(again.pending.map((row) => row.item)).toEqual([2]);
		expect(
			srCardsInTransaction(db, { space, available: () => true }).map(
				(row) => row.id,
			),
		).toEqual(["music.create"]);
	} finally {
		close();
	}
});

test("late vectors are refused and host rollback leaves the pending work retryable", () => {
	const { db, close } = open();
	try {
		const before = card("a");
		const old = syncCardsInTransaction(db, [before], space).pending;
		const changed = { ...before, revision: "next", examples: ["新しい文"] };
		const next = { ...changed, digest: cardDigest(changed) };
		const pending = db.transaction(
			() => syncCardsInTransaction(db, [next], space).pending,
		)();
		saveVectorsInTransaction(
			db,
			space,
			old.map((p) => ({ ...p, vector: [1, 0] })),
		);
		expect(
			srCardsInTransaction(db, { space, available: () => true })[0]!.passages,
		).toHaveLength(0);
		expect(() =>
			db.transaction(() =>
				saveVectorsInTransaction(db, space, [
					{ ...pending[0]!, vector: [1, 0] },
					{ ...pending[1]!, vector: [NaN, 0] },
				]),
			)(),
		).toThrow();
		expect(
			srCardsInTransaction(db, { space, available: () => true })[0]!.passages,
		).toHaveLength(0);
		const again = syncCardsInTransaction(db, [next], space).pending;
		expect(again).toEqual(pending);
		db.transaction(() =>
			saveVectorsInTransaction(
				db,
				space,
				again.map((p) => ({ ...p, vector: [1, 0] })),
			),
		)();
		expect(syncCardsInTransaction(db, [next], space).pending).toEqual([]);
		const hidden = srCardsInTransaction(db, { space, available: () => false });
		expect(hidden).toEqual([]);
	} finally {
		close();
	}
});

test("a correction is found by its vector, retracted, and removed with its message", () => {
	const { db, close } = open();
	try {
		recordFeedbackInTransaction(db, {
			id: "f1",
			conversationId: "c",
			messageId: "m1",
			messageIds: ["m2"],
			runId: "run",
			source: "review",
			text: "曲を作って",
			space,
			vector: [1, 0],
			wrongId: "music.library",
			rightId: "music.create",
			at: 10,
		});
		recordFeedbackInTransaction(db, {
			id: "f2",
			conversationId: "c",
			messageId: "m9",
			messageIds: [],
			runId: "run",
			source: "review",
			text: "遠くの依頼",
			space,
			vector: [0, 1],
			wrongId: null,
			rightId: "image.create",
			at: 11,
		});
		expect(
			nearFeedback(db, { vector: [1, 0], space, threshold: 0.95 }).map(
				(row) => row.id,
			),
		).toEqual(["f1"]);
		expect(setFeedbackStateInTransaction(db, "f1", "retracted", 12)).toBe(true);
		expect(
			nearFeedback(db, { vector: [1, 0], space, threshold: 0.95 }),
		).toEqual([]);
		expect(forgetInTransaction(db, ["m2"])).toBe(1);
		expect(forgetInTransaction(db, ["m9"])).toBe(1);
	} finally {
		close();
	}
});

test("the migrations are the published schema count, and a host's router_feedback of the same definition keeps its rows", () => {
	expect(migrations.length).toBe(dbSchemaVersion);
	const db = new Database(":memory:");
	try {
		// Eumenes made this table first (toolchain-history/0005-router); the package's migration keeps it.
		db.exec(`CREATE TABLE router_feedback(
 id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,message_ids_json TEXT NOT NULL,run_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('redirect','ask_answer','ui_pick','review')),
 query_text TEXT NOT NULL,query_space TEXT NOT NULL,query_vector BLOB NOT NULL,
 wrong_id TEXT,right_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','retracted','stale','conflict')),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX router_feedback_space ON router_feedback(query_space,state);
CREATE INDEX router_feedback_message ON router_feedback(message_id);`);
		recordFeedbackInTransaction(db, {
			id: "kept",
			conversationId: "c",
			messageId: "m1",
			messageIds: [],
			runId: "run",
			source: "review",
			text: "曲を作って",
			space,
			vector: [1, 0],
			wrongId: null,
			rightId: "music.create",
			at: 1,
		});
		for (const sql of migrations) db.exec(sql);
		const tables = (
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'router_%' AND name NOT LIKE 'router_passages_fts_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((r) => r.name);
		expect(tables).toEqual([
			"router_cards",
			"router_examples",
			"router_feedback",
			"router_passages",
			"router_passages_fts",
		]);
		expect(
			nearFeedback(db, { vector: [1, 0], space, threshold: 0.9 }).map(
				(f) => f.id,
			),
		).toEqual(["kept"]);
	} finally {
		db.close();
	}
});

const correction = {
	id: "f",
	conversationId: "c",
	messageId: "primary",
	runId: "run",
	source: "review",
	text: "x".repeat(2001),
	space,
	vector: [1, 0],
	wrongId: null,
	rightId: "a",
	at: 1,
} satisfies FeedbackInsert;

test("feedback entry points share storage and state updates while keeping their validation", () => {
	const { db, close } = open();
	try {
		const strict = { ...correction, id: "strict", messageIds: ["primary"] };
		insertFeedbackInTransaction(db, correction);
		recordFeedbackInTransaction(db, strict);
		insertFeedbackInTransaction(db, {
			...correction,
			id: "related",
			messageIds: ["also", "primary", "also"],
		});
		const rows = db
			.query<Record<string, unknown>, []>(
				"SELECT * FROM router_feedback ORDER BY rowid",
			)
			.all();
		expect(rows[0]).toEqual({ ...rows[1], id: "f" });
		expect(rows[0]).toMatchObject({
			message_ids_json: '["primary"]',
			query_text: "x".repeat(2000),
			state: "active",
			created_at: 1,
			updated_at: 1,
		});
		expect(rows[2]).toMatchObject({ message_ids_json: '["primary","also"]' });

		expect(() =>
			recordFeedbackInTransaction(db, { ...strict, id: "" }),
		).toThrow(routerErrors.invalidFeedback);
		expect(() =>
			recordFeedbackInTransaction(db, { ...strict, vector: [1] }),
		).toThrow(routerErrors.invalidEmbedding);
		expect(() =>
			recordFeedbackInTransaction(db, { ...strict, vector: [NaN, 0] }),
		).toThrow(routerErrors.invalidEmbedding);
		expect(() => setFeedbackStateInTransaction(db, "f", "stale", -1)).toThrow(
			routerErrors.invalidFeedback,
		);
		expect(updateFeedbackStateInTransaction(db, "f", "stale", -1)).toBe(true);
		expect(setFeedbackStateInTransaction(db, "strict", "stale", 2)).toBe(true);
		expect(updateFeedbackStateInTransaction(db, "missing", "stale", 2)).toBe(
			false,
		);
		expect(
			db
				.query("SELECT state,updated_at FROM router_feedback ORDER BY rowid")
				.all(),
		).toEqual([
			{ state: "stale", updated_at: -1 },
			{ state: "stale", updated_at: 2 },
			{ state: "active", updated_at: 1 },
		]);
	} finally {
		close();
	}
});

test("feedback searches preserve the scan limit, tie order and host query boundaries", () => {
	const { db, close } = open();
	try {
		db.transaction(() => {
			insertFeedbackInTransaction(db, {
				...correction,
				id: "outside-scan",
				vector: [2, 0],
			});
			for (let i = 0; i < 499; i++)
				insertFeedbackInTransaction(db, { ...correction, id: `f${i}`, at: 2 });
			// The host can store vectors whose length differs from the space.
			insertFeedbackInTransaction(db, {
				...correction,
				id: "legacy",
				vector: [1],
				at: 3,
			});
			insertFeedbackInTransaction(db, {
				...correction,
				id: "other",
				space: { ...space, revision: "2" },
				at: 4,
			});
		})();
		const query = { space, vector: [1, 0], threshold: 1 };
		const shared = searchFeedback(db, query);
		expect(nearFeedback(db, query)).toEqual(shared);
		expect(shared.map((f) => f.id)).toEqual([
			"f498",
			"f497",
			"f496",
			"f495",
			"f494",
		]);
		expect(searchFeedback(db, { ...query, limit: 501 })).toHaveLength(499);
		expect(searchFeedback(db, { ...query, threshold: 1.01 })).toEqual([]);
		expect(searchFeedback(db, { ...query, limit: 0 })).toEqual([]);
		expect(searchFeedback(db, { ...query, limit: 1.9 })).toEqual(
			shared.slice(0, 1),
		);
		expect(searchFeedback(db, { ...query, vector: [1] })).toEqual([
			{ id: "legacy", wrongId: null, rightId: "a", similarity: 1 },
		]);
		expect(() => nearFeedback(db, { ...query, vector: [1] })).toThrow(
			routerErrors.invalidEmbedding,
		);
		for (const limit of [0, 1.9])
			expect(() => nearFeedback(db, { ...query, limit })).toThrow(
				routerErrors.invalidFeedback,
			);
		expect(() => nearFeedback(db, { ...query, threshold: Infinity })).toThrow(
			routerErrors.invalidFeedback,
		);
	} finally {
		close();
	}
});

test("forgetting rolls back earlier chunks on failure and can be retried", () => {
	const { db, close } = open();
	try {
		const ids = Array.from({ length: 251 }, (_, i) => `source-${i}`);
		for (const messageId of [ids[0]!, ids[250]!])
			insertFeedbackInTransaction(db, {
				...correction,
				id: messageId,
				messageIds: [messageId],
			});
		db.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON router_feedback
 WHEN OLD.id = 'source-250' BEGIN SELECT RAISE(ABORT, 'delete failed'); END;`);
		const forget = db.transaction(() => forgetInTransaction(db, ids));
		expect(forget).toThrow("delete failed");
		expect(
			db.query("SELECT id FROM router_feedback ORDER BY rowid").all(),
		).toEqual([{ id: "source-0" }, { id: "source-250" }]);
		db.exec("DROP TRIGGER reject_delete");
		expect(forget()).toBe(2);
		expect(forget()).toBe(0);
	} finally {
		close();
	}
});
