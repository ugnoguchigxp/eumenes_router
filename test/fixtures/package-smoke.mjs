// Runs in a temporary consumer with only the packed package. No source tree or private data.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	BEST_V2_FEATURES,
	BEST_V2_FORMAT,
	BEST_V2_MEMORY_FORMAT,
	DEFAULT_ROUTE_SETTINGS,
	cardDigest,
	loadBestV2,
	route,
	routeWithFallback,
	contractVersions,
} from "eumenes_router";
import {
	migrations,
	syncCardsInTransaction,
	saveVectorsInTransaction,
	srCardsInTransaction,
	lexicalInTransaction,
	nearFeedback,
	importExamplesInTransaction,
	examplesInTransaction,
} from "eumenes_router/sqlite";

assert.equal(contractVersions.route, 8);
assert.equal(contractVersions.structure, 6);
const readme = await Bun.file(
	new URL("./node_modules/eumenes_router/README.md", import.meta.url),
).text();
const example =
	/<!-- route-structured-example -->\r?\n```js\r?\n([\s\S]+?)\r?\n```/.exec(
		readme,
	)?.[1];
assert.ok(
	example,
	"packaged README must contain the structured consumer example",
);
const exampleFile = new URL("./readme-route.mjs", import.meta.url);
await Bun.write(exampleFile, example);
const { routeWithStructure } = await import(exampleFile.href);
const space = {
	modelId: "synthetic",
	revision: "1",
	artifactDigest: "fixture",
	dimension: 2,
};
const n = BEST_V2_FEATURES.length;
const params = {
	format: BEST_V2_FORMAT,
	version: "fixture",
	source: "fixture",
	features: BEST_V2_FEATURES,
	ranker: {
		mean: Array(n).fill(0),
		scale: Array(n).fill(1),
		coef: BEST_V2_FEATURES.map((f) => (f === "rr" ? 4 : 0)),
		intercept: 0,
	},
	gate: { deferBelow: 0.1 },
	fuse: { weight: 2, conversation: 0.18, top: 8 },
	extra: { tools: 2 },
	knn: { neighbors: 1, dimension: 2 },
};
const memory = {
	format: BEST_V2_MEMORY_FORMAT,
	source: "fixture",
	dimension: 2,
	labels: ["a"],
	vectors: Buffer.from(new Float32Array([0, 1]).buffer).toString("base64"),
};
const db = new Database(":memory:");
try {
	for (const sql of migrations) db.exec(sql);
	const cards = ["a", "b"].map((id) => {
		const c = {
			id,
			revision: "1",
			kind: "dedicated",
			title: id,
			summary: "説明",
			useWhen: [],
			examples: [],
			impact: "create",
		};
		return { ...c, digest: cardDigest(c) };
	});
	db.transaction(() => {
		const pending = syncCardsInTransaction(db, cards, space).pending;
		saveVectorsInTransaction(
			db,
			space,
			pending.map((p) => ({ ...p, vector: [1, 0] })),
		);
		importExamplesInTransaction(db, memory, space);
	})();
	const loaded = examplesInTransaction(db, { source: "fixture", space });
	const ports = {
		model: loadBestV2(params, loaded),
		settings: DEFAULT_ROUTE_SETTINGS,
		embed: async () => ({ space, vectors: [[1, 0]] }),
		rerank: async (input) => {
			const names = input.criteria.map((c) => c.name);
			return {
				choice: names[0],
				probabilities: Object.fromEntries(
					names.map((name) => [name, 1 / names.length]),
				),
				scores: Object.fromEntries(
					names.map((name) => [name, name === "a" ? 0.9 : 0.1]),
				),
				model: "fixture",
				headRevision: null,
				calibrationRevision: null,
			};
		},
		read: {
			cards: (q) => srCardsInTransaction(db, q),
			lexical: (s) => lexicalInTransaction(db, s),
			nearFeedback: (q) => nearFeedback(db, q),
		},
	};
	const turn = {
		state: { text: "作って", previousAgent: null, previousUser: null },
		dynamic: [],
		available: () => true,
		instructions: "",
	};
	const direct = await route(ports, turn);
	assert.equal(direct.decision.candidate.id, "a");
	assert.deepEqual(
		await routeWithFallback(ports, turn, () => assert.fail("unexpected B")),
		{ decision: direct.decision, direct, structured: null },
	);
	const deadline = new AbortController();
	deadline.abort();
	const deferred = {
		...ports,
		model: loadBestV2({ ...params, gate: { deferBelow: 1 } }, loaded),
	};
	const stopped = await routeWithFallback(deferred, turn, () => ({
		ports: { ...ports, analyze: async () => assert.fail("expired B") },
		deadline: deadline.signal,
	}));
	assert.equal(stopped.direct.explain.defer, true);
	assert.equal(stopped.structured, null);
	assert.equal(stopped.decision.to, "unresolved");
	assert.equal(stopped.decision.reason, "structure_timeout");
	assert.ok(stopped.decision.requests[0].options.length > 0);
	assert.equal(
		(
			await routeWithStructure(
				ports,
				turn,
				async ({ version, messages, schema }) => {
					assert.equal(version, "turn-structure-v8");
					assert.equal(messages[0].role, "system");
					assert.equal(messages[1].role, "user");
					assert.equal(JSON.parse(messages[1].content).text, turn.state.text);
					assert.deepEqual(schema.required, ["decision"]);
					assert.deepEqual(
						schema.properties.decision.anyOf[0].properties.requests.items
							.required,
						["text", "target", "inputs", "after"],
					);
					return '{"decision":{"requests":[]}}';
				},
			)
		).decision.to,
		"conversation",
	);
	for (const invalid of [
		'{"requests":[]}',
		'{"decision":{"requests":[{"text":"作って","target":null,"inputs":[]}]}}',
	]) {
		await assert.rejects(
			routeWithStructure(ports, turn, async () => invalid),
			/structure_invalid/,
		);
	}
	const compound = await routeWithStructure(
		{
			...ports,
			rerank: async (input) => {
				const result = await ports.rerank(input);
				if (input.text === "bを作って") result.scores = { a: 0.1, b: 0.9 };
				return result;
			},
		},
		{ ...turn, state: { ...turn.state, text: "aを作って、bを作って" } },
		async () =>
			JSON.stringify({
				decision: {
					requests: [
						{ text: "aを作って", target: "a", inputs: [], after: [] },
						{ text: "bを作って", target: "b", inputs: [], after: [0] },
					],
				},
			}),
	);
	assert.equal(compound.decision.to, "pipeline");
	assert.deepEqual(
		compound.decision.steps.map((step) => [
			step.decision.to,
			step.candidate.id,
			step.after,
		]),
		[
			["run", "a", []],
			["run", "b", [0]],
		],
	);
	assert.throws(() => loadBestV2(params, { ...memory, source: "other" }));
	await assert.rejects(
		route(
			{
				...ports,
				rerank: async () => {
					throw new Error("unavailable");
				},
			},
			turn,
		),
	);
} finally {
	db.close();
}
