import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardDigest, type Card, type VectorSpace } from "../src/index.ts";
import {
	forgetInTransaction,
	DB_SCHEMA_VERSION,
	migrateInTransaction,
	nearFeedback,
	recordFeedbackInTransaction,
	saveVectorsInTransaction,
	srCardsInTransaction,
	setFeedbackStateInTransaction,
	syncCardsInTransaction,
} from "../src/sqlite.ts";

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
	migrateInTransaction(db);
	return {
		db,
		close() {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

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

test("a newer schema is refused and a second migrate does nothing", () => {
	const { db, close } = open();
	try {
		migrateInTransaction(db);
		db.query("UPDATE router_schema SET version=? WHERE id=1").run(
			DB_SCHEMA_VERSION + 1,
		);
		expect(() => migrateInTransaction(db)).toThrow("router_schema_newer");
	} finally {
		close();
	}
});
