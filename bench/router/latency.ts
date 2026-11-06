/** CPU/SQLite only. Synthetic catalogs and mock model ports: never an accuracy or live latency benchmark. */
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import {
	BEST_V2_FEATURES,
	BEST_V2_FORMAT,
	BEST_V2_MEMORY_FORMAT,
	DEFAULT_ROUTE_SETTINGS,
	cardDigest,
	loadBestV2,
	route,
	type Card,
	type RoutePorts,
	type RouteTurn,
} from "../../src/index.ts";
import {
	migrations,
	syncCardsInTransaction,
	saveVectorsInTransaction,
	srCardsInTransaction,
	lexicalInTransaction,
	nearFeedback,
} from "../../src/sqlite.ts";

const dimension = 384;
const memoryCount = 177;
export function workload(size: number, criteria: number) {
	const db = new Database(":memory:");
	for (const sql of migrations) db.exec(sql);
	const cards: Card[] = Array.from({ length: size }, (_, i) => {
		const body = {
			id: `tool${i}`,
			revision: "fixture",
			kind: "dedicated" as const,
			title: `合成 ${i}`,
			summary: "規模検証用の操作",
			useWhen: ["検査対象"],
			examples: ["実行して"],
			impact: "none" as const,
		};
		return { ...body, digest: cardDigest(body) };
	});
	const vector = Array.from(
		{ length: dimension },
		() => 1 / Math.sqrt(dimension),
	);
	const space = {
		modelId: "synthetic",
		revision: "fixture",
		artifactDigest: "fixture",
		dimension,
	};
	db.transaction(() => {
		const pending = syncCardsInTransaction(db, cards, space).pending;
		saveVectorsInTransaction(
			db,
			space,
			pending.map((p) => ({ ...p, vector })),
		);
	})();
	const n = BEST_V2_FEATURES.length;
	const model = loadBestV2(
		{
			format: BEST_V2_FORMAT,
			version: "fixture",
			source: "synthetic",
			features: BEST_V2_FEATURES,
			ranker: {
				mean: Array(n).fill(0),
				scale: Array(n).fill(1),
				coef: BEST_V2_FEATURES.map((f) => (f === "rr" ? 4 : 0)),
				intercept: 0,
			},
			gate: { deferBelow: 0.1 },
			fuse: { weight: 2, conversation: 0.18, top: 8 },
			extra: { tools: 10 },
			knn: { neighbors: 10, dimension },
		},
		{
			format: BEST_V2_MEMORY_FORMAT,
			source: "synthetic",
			dimension,
			labels: Array.from({ length: memoryCount }, (_, i) => `tool${i % size}`),
			vectors: Buffer.from(
				new Float32Array(
					Array.from({ length: memoryCount }, () => vector).flat(),
				).buffer,
			).toString("base64"),
		},
	);
	let observed = 0;
	const ports: RoutePorts = {
		model,
		settings: DEFAULT_ROUTE_SETTINGS,
		embed: async () => ({ space, vectors: [vector] }),
		rerank: async (input) => {
			observed = input.criteria.length;
			const names = input.criteria.map((c) => c.name);
			return {
				choice: names[0]!,
				probabilities: Object.fromEntries(
					names.map((name) => [name, 1 / names.length]),
				),
				scores: Object.fromEntries(
					names.map((name, i) => [name, i === 0 ? 0.9 : 0.1]),
				),
				model: "fixture",
				headRevision: null,
				calibrationRevision: null,
			};
		},
		read: {
			cards: (q) => srCardsInTransaction(db, q),
			lexical: (text) => lexicalInTransaction(db, text),
			nearFeedback: (q) => nearFeedback(db, q),
		},
	};
	const turn: RouteTurn = {
		state: {
			text: "規模検証用の操作を実行して",
			previousAgent: null,
			previousUser: null,
		},
		dynamic: Array.from({ length: criteria - 10 }, (_, i) => ({
			id: `work${i}.check`,
			kind: "work" as const,
			todo: `w${i}`,
			operation: "check" as const,
			title: "合成",
			passage: "合成の進捗確認",
		})),
		available: () => true,
		instructions: "",
	};
	return {
		run: async () => {
			await route(ports, turn);
			if (observed !== criteria) throw new Error("latency_criteria_mismatch");
		},
		close: () => db.close(),
	};
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: { out: { type: "string" }, runs: { type: "string" } },
	});
	const runs = Number(values.runs ?? 100);
	if (!Number.isSafeInteger(runs) || runs < 100)
		throw new Error("latency_needs_100_runs");
	const results = [];
	for (const size of [100, 500, 1000, 2000])
		for (const criteria of [20, 40, 64, 128]) {
			const w = workload(size, criteria);
			try {
				for (let i = 0; i < 10; i++) await w.run();
				const ms = [];
				for (let i = 0; i < runs; i++) {
					const start = performance.now();
					await w.run();
					ms.push(performance.now() - start);
				}
				ms.sort((a, b) => a - b);
				results.push({
					cards: size,
					criteria,
					runs,
					p50ms: ms[Math.ceil(runs * 0.5) - 1],
					p95ms: ms[Math.ceil(runs * 0.95) - 1],
					maxMs: ms.at(-1),
					rssBytes: process.memoryUsage().rss,
				});
				console.log(
					JSON.stringify({ cards: size, criteria, complete: results.length }),
				);
			} finally {
				w.close();
			}
		}
	const report = {
		kind: "offline-synthetic-cpu-sqlite",
		bun: Bun.version,
		platform: process.platform,
		arch: process.arch,
		warmup: 10,
		dimension,
		memoryCount,
		modelCalls: 0,
		accuracy: null,
		liveLatency: null,
		results,
	};
	await Bun.write(
		values.out ?? "data/offline-improvement-2026-11-06/cpu-latency.json",
		JSON.stringify(report, null, 2) + "\n",
	);
}
