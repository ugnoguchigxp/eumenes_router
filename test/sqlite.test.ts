import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardDigest, type Card, type VectorSpace } from "../src/index.ts";
import {
	candidatesInTransaction,
	forgetInTransaction,
	migrateInTransaction,
	nearFeedback,
	recordFeedbackInTransaction,
	saveVectorsInTransaction,
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
	const dir = mkdtempSync(join(tmpdir(), "eumenes-router-"));
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

test("changed passages are pending, saved vectors are searched, a disabled card leaves", () => {
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
		const found = candidatesInTransaction(db, {
			vector: { space, values: [1, 0] },
			available: () => true,
			slots: "router",
		});
		expect(found[0]?.id).toBe("music.create");
		expect(found.map((row) => row.id).sort()).toEqual([
			"image.create",
			"music.create",
		]);
		const changed = card("music.create", ["別の例"]);
		const again = syncCardsInTransaction(db, [changed], space);
		expect(again.pending.map((row) => row.item)).toEqual([2]);
		expect(
			candidatesInTransaction(db, {
				vector: { space, values: [0, 1] },
				available: () => true,
			}).map((row) => row.id),
		).toEqual(["music.create"]);
	} finally {
		close();
	}
});

test("choice slots drop a pipeline farther than `near` from the closest", () => {
	const { db, close } = open();
	try {
		const dedicated = {
			...card("alpha.do"),
			kind: "dedicated" as const,
		};
		dedicated.digest = cardDigest(dedicated);
		const pipeline = {
			...card("beta.pipe"),
			kind: "pipeline" as const,
		};
		pipeline.digest = cardDigest(pipeline);
		const pending = syncCardsInTransaction(db, [dedicated, pipeline], space);
		saveVectorsInTransaction(
			db,
			space,
			pending.pending.map((row) => ({
				...row,
				vector: row.id === "alpha.do" ? [1, 0] : [0.6, 0.8],
			})),
		);
		const wide = candidatesInTransaction(db, {
			vector: { space, values: [1, 0] },
			available: () => true,
			slots: "router",
		});
		const narrow = candidatesInTransaction(db, {
			vector: { space, values: [1, 0] },
			available: () => true,
			slots: "choice",
		});
		expect(wide.map((row) => row.id).sort()).toEqual(["alpha.do", "beta.pipe"]);
		expect(narrow.map((row) => row.id)).toEqual(["alpha.do"]);
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
		db.query("UPDATE router_schema SET version=2 WHERE id=1").run();
		expect(() => migrateInTransaction(db)).toThrow("router_schema_newer");
	} finally {
		close();
	}
});
