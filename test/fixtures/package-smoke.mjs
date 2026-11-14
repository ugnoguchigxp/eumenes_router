// Runs in a temporary consumer with only the packed package.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import * as router from "eumenes_router";
import * as sqlite from "eumenes_router/sqlite";

assert.equal(router.contractVersions.route, 9);
assert.equal(router.contractVersions.structure, 6);
assert.equal(router.contractVersions.feedback, 2);
for (const name of [
	"route",
	"routeStructured",
	"routeWithFallback",
	"scoreBestV2",
	"loadBestV2",
	"BEST_V2_PARAMS",
	"assertRouteAnswer",
])
	assert.equal(Object.hasOwn(router, name), false);
for (const name of ["importExamplesInTransaction", "examplesInTransaction"])
	assert.equal(Object.hasOwn(sqlite, name), false);

const space = {
	modelId: "fixture",
	revision: "1",
	artifactDigest: "fixture",
	dimension: 2,
};
const db = new Database(":memory:");
try {
	for (const sql of sqlite.migrations) db.exec(sql);
	const cards = Array.from({ length: 6 }, (_, i) => {
		const card = {
			id: String.fromCharCode(97 + i),
			revision: "1",
			kind: "dedicated",
			title: String.fromCharCode(97 + i),
			summary: "説明",
			useWhen: [],
			examples: [],
			impact: "create",
		};
		return { ...card, digest: router.cardDigest(card) };
	});
	db.transaction(() => {
		const pending = sqlite.syncCardsInTransaction(db, cards, space).pending;
		sqlite.saveVectorsInTransaction(
			db,
			space,
			pending.map((p) => ({ ...p, vector: [1, 0] })),
		);
		sqlite.insertFeedbackInTransaction(db, {
			id: "f",
			conversationId: "c",
			messageId: "m",
			runId: "r",
			source: "review",
			text: "fixture",
			space,
			vector: [1, 0],
			wrongId: null,
			rightId: "f",
			at: 1,
		});
	})();

	const calls = [];
	let second = { kind: "no_match" };
	const ports = {
		embed: async () => ({ space, vectors: [[1, 0]] }),
		read: {
			cards: (q) => sqlite.srCardsInTransaction(db, q),
			lexical: (s) => sqlite.lexicalInTransaction(db, s),
			nearFeedback: (q) => sqlite.nearFeedback(db, q),
		},
		select: async ({ version, user, outputSchema }) => {
			calls.push(version);
			const input = JSON.parse(user);
			if (version === "turn-structure-v8") {
				assert.deepEqual(outputSchema.required, ["decision"]);
				if (input.text === "こんにちは") return '{"decision":{"requests":[]}}';
				return JSON.stringify({
					decision: {
						requests: [
							{ text: "資料を作って", target: "資料", inputs: [], after: [] },
							{ text: "まとめて", target: null, inputs: [], after: [0] },
						],
					},
				});
			}
			for (const { candidates } of input.requests) {
				assert.deepEqual(
					candidates.map(({ id, searchRank }) => [id, searchRank]),
					[
						["a", 1],
						["b", 2],
						["c", 3],
						["d", 4],
						["f", 6],
					],
				);
				assert.ok(
					candidates.every(({ matchScore }) => Number.isFinite(matchScore)),
				);
			}
			const first = { kind: "candidate", id: "f" };
			return JSON.stringify({
				selections:
					input.requests.length === 1 ? { 0: first } : { 0: first, 1: second },
			});
		},
	};
	const turn = (text) => ({
		state: { text, previousAgent: null, previousUser: null },
		available: () => true,
	});
	const chat = await router.routeWithSelection(ports, turn("こんにちは"));
	assert.equal(chat.decision.to, "conversation");
	assert.deepEqual(calls.splice(0), ["turn-structure-v8"]);
	const tool = await router.routeWithSelection(ports, turn("資料を作って"), {
		mode: "tools-only",
	});
	assert.equal(tool.decision.to, "run");
	assert.equal(tool.decision.candidate.id, "f");
	assert.deepEqual(calls.splice(0), ["route-selection-v1"]);

	const compound = turn("資料を作って、まとめて");
	const held = await router.routeWithSelection(ports, compound);
	assert.equal(held.decision.to, "unresolved");
	assert.deepEqual(calls.splice(0), [
		"turn-structure-v8",
		"route-selection-v1",
	]);
	second = { kind: "candidate", id: "a" };
	const both = await router.routeWithSelection(ports, compound);
	assert.equal(both.decision.to, "pipeline");
	assert.deepEqual(
		both.decision.steps.map(({ candidate, after }) => [candidate.id, after]),
		[
			["f", []],
			["a", [0]],
		],
	);

	db.transaction(() => {
		const query = { space, vector: [1, 0], threshold: 1 };
		assert.deepEqual(sqlite.searchFeedback(db, query), [
			{ id: "f", wrongId: null, rightId: "f", similarity: 1 },
		]);
		assert.deepEqual(sqlite.searchFeedback(db, { ...query, limit: 0 }), []);
		assert.equal(
			sqlite.updateFeedbackStateInTransaction(db, "f", "retracted", 2),
			true,
		);
		assert.deepEqual(sqlite.nearFeedback(db, query), []);
		assert.equal(sqlite.forgetInTransaction(db, ["m"]), 1);
	})();
} finally {
	db.close();
}
