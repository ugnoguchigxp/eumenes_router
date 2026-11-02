import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trigramQuery } from "./algorithms.ts";
import { splitOf } from "./data.ts";
import { openBench } from "./db.ts";
import { fakeProvider, fillCache, httpProvider } from "./embed.ts";
import { main } from "./main.ts";

const F = "bench/fixtures/example";
const dir = mkdtempSync(join(tmpdir(), "router-bench-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const quiet = () => {};
const MODEL = "fake-ngram-256";

async function fresh(name: string) {
	const db = join(dir, `${name}.db`);
	await main(
		[
			"import",
			"--db",
			db,
			"--cards",
			`${F}/cards.json`,
			"--utterances",
			`${F}/utterances.jsonl`,
			"--choices",
			`${F}/choices.jsonl`,
			"--labels",
			`${F}/labels.jsonl`,
		],
		quiet,
	);
	await main(["embed", "--db", db, "--provider", "fake"], quiet);
	return db;
}

const strip = (s: Record<string, unknown>) => {
	const { latencyMs: _l, ...rest } = s;
	return rest;
};

test("two identical runs on fresh databases give identical metrics and predictions", async () => {
	const out: Array<Record<string, unknown>> = [];
	for (const name of ["a", "b"]) {
		const db = await fresh(name);
		out.push(
			(await main(
				[
					"run",
					"--db",
					db,
					"--algo",
					"hybrid",
					"--model",
					MODEL,
					"--split",
					"any",
					"--out",
					join(dir, `det-${name}`),
				],
				quiet,
			)) as Record<string, unknown>,
		);
	}
	expect(strip(out[0]!)).toEqual(strip(out[1]!));
	const preds = (name: string) =>
		readFileSync(join(dir, `det-${name}`, "predictions.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const { durationMs: _d, ...p } = JSON.parse(line) as Record<
					string,
					unknown
				>;
				return p;
			});
	expect(preds("a")).toEqual(preds("b"));
});

test("fts, embed and hybrid run end to end and appear in one compare table", async () => {
	const db = await fresh("algos");
	const root = join(dir, "runs");
	for (const algo of ["fts", "embed", "hybrid"]) {
		const s = (await main(
			[
				"run",
				"--db",
				db,
				"--algo",
				algo,
				"--model",
				MODEL,
				"--split",
				"any",
				"--out",
				join(root, algo),
			],
			quiet,
		)) as { n: number; algo: string };
		expect(s.n).toBe(22);
		expect(s.algo).toBe(algo);
		expect(readFileSync(join(root, algo, "report.md"), "utf8")).toContain(
			"# Router 採点結果",
		);
	}
	const table = (await main(["compare", "--root", root], quiet)) as string;
	for (const algo of ["fts", "embed", "hybrid"])
		expect(table).toContain(`| ${algo} | ${algo} |`);
	expect(table.split("\n")).toHaveLength(5);
});

test("fts needs no embeddings; embed refuses to run without a cached model", async () => {
	const db = join(dir, "noembed.db");
	await main(
		[
			"import",
			"--db",
			db,
			"--cards",
			`${F}/cards.json`,
			"--utterances",
			`${F}/utterances.jsonl`,
			"--labels",
			`${F}/labels.jsonl`,
		],
		quiet,
	);
	await main(
		[
			"run",
			"--db",
			db,
			"--algo",
			"fts",
			"--split",
			"any",
			"--out",
			join(dir, "fts-only"),
		],
		quiet,
	);
	await expect(
		main(
			[
				"run",
				"--db",
				db,
				"--algo",
				"embed",
				"--split",
				"any",
				"--out",
				join(dir, "x"),
			],
			quiet,
		),
	).rejects.toThrow("model_required");
	await expect(
		main(
			[
				"run",
				"--db",
				db,
				"--algo",
				"embed",
				"--model",
				MODEL,
				"--split",
				"any",
				"--out",
				join(dir, "y"),
			],
			quiet,
		),
	).rejects.toThrow("embedding_not_cached");
});

test("the cache embeds a text once per model", async () => {
	const db = openBench(join(dir, "cache.db"));
	let calls = 0;
	const base = fakeProvider(8);
	const counted = {
		model: base.model,
		embed: async (t: readonly string[]) => ((calls += t.length), base.embed(t)),
	};
	expect(await fillCache(db, counted, ["あ", "い", "あ"])).toEqual({
		total: 2,
		added: 2,
	});
	expect(await fillCache(db, counted, ["あ", "い", "う"])).toEqual({
		total: 3,
		added: 1,
	});
	expect(calls).toBe(3);
});

test("the http provider posts to /v1/embeddings and orders by index", async () => {
	const seen: Array<{ url: string; body: unknown }> = [];
	const provider = httpProvider({
		baseUrl: "http://embed.invalid/",
		model: "m",
		fetch: (async (url: string, init: RequestInit) => {
			seen.push({ url, body: JSON.parse(String(init.body)) });
			return new Response(
				JSON.stringify({
					data: [
						{ index: 1, embedding: [0, 1] },
						{ index: 0, embedding: [1, 0] },
					],
				}),
			);
		}) as unknown as typeof fetch,
	});
	expect(await provider.embed(["a", "b"])).toEqual([
		[1, 0],
		[0, 1],
	]);
	expect(seen).toEqual([
		{
			url: "http://embed.invalid/v1/embeddings",
			body: { model: "m", input: ["a", "b"] },
		},
	]);
});

test("labels: one conversation, one split; a reviewed label needs a gold id", async () => {
	expect(splitOf("c1")).toBe(splitOf("c1"));
	const db = join(dir, "labels.db");
	await main(
		["import", "--db", db, "--utterances", `${F}/utterances.jsonl`],
		quiet,
	);
	const bad = join(dir, "bad.jsonl");
	writeFileSync(
		bad,
		`${JSON.stringify({ id: "ex01", gold: null, status: "reviewed" })}\n`,
	);
	await expect(
		main(["label", "import", "--db", db, "--labels", bad], quiet),
	).rejects.toThrow("label_missing_gold");
});

test("the review sheet lists only unlabeled utterances, with candidates", async () => {
	const db = await fresh("sheet");
	const out = join(dir, "sheet.jsonl");
	await main(
		[
			"label",
			"export",
			"--db",
			db,
			"--model",
			MODEL,
			"--out",
			out,
			"--md",
			join(dir, "sheet.md"),
		],
		quiet,
	);
	const rows = readFileSync(out, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { id: string; candidates: unknown[] });
	expect(rows.map((r) => r.id).sort()).toEqual(["ex09", "ex18"]);
	expect(rows[0]!.candidates.length).toBeGreaterThan(0);
});

test("a trigram query quotes grams and is empty under three characters", () => {
	expect(trigramQuery("ab")).toBeNull();
	expect(trigramQuery('a"bc')).toBe('"a""b" OR """bc"');
});

test("past, recorded-embed and sr-weighted variants run deterministically on the fixture", async () => {
	const db = await fresh("sr");
	for (const algo of ["past", "recorded-embed", "sr-weighted", "sr-weighted-noembed", "sr-weighted-nohist"]) {
		const runs: Array<Record<string, unknown>> = [];
		for (const k of [1, 2])
			runs.push(
				strip(
					(await main(
						["run", "--db", db, "--algo", algo, "--model", MODEL, "--split", "any", "--out", join(dir, `${algo}-${k}`)],
						quiet,
					)) as Record<string, unknown>,
				),
			);
		expect(runs[0]).toEqual(runs[1]!);
	}
	const tuned = (await main(
		["run", "--db", db, "--algo", "sr-x", "--sr", '{"weights":{"hist":0},"minCombined":0.9}', "--model", MODEL, "--split", "any", "--out", join(dir, "sr-x")],
		quiet,
	)) as { algo: string };
	expect(tuned.algo).toBe("sr-x");
});
