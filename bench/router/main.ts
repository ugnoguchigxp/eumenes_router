/**
 * `bun run router <command>`: the evaluation bench, independent of Eumenes.
 *
 *   import   --db <file> [--export <router-export dir>] [--cards <json|jsonl>] [--utterances <jsonl>] [--choices <jsonl>] [--labels <jsonl>]
 *   label    export --db <file> --out <sheet.jsonl> [--md <sheet.md>] [--model <m>] [--limit N]
 *   label    import --db <file> --labels <jsonl> [--split-time <conversation>:<devShare>]
 *   label    stats  --db <file>
 *   embed    --db <file> (--provider fake | --provider http --url <base> --model <m>)
 *   run      --db <file> --algo fts|embed|hybrid|past|recorded-embed|sr-weighted[-noembed|-nohist|-noproto] [--sr <json>] [--model <m>] [--split test|dev|any] [--feedback] [--out <dir>]
 *   score    --run <dir>             (prints the run's summary)
 *   compare  [<run dir> ...] [--root out]
 *   route    --db <corr.db> --artifact <best-v2 dir> (--text <utt> [--prev <turn>] [--hints <json>] | --in <jsonl> [--out <jsonl>])
 *            [--python <venv python>] [--url <e5 server>]   best-v2 routing of new utterances (tool, scores, defer, latency)
 *            `run --algo best-v2 --text … | --in …` is the same command.
 *   correct  --db <file> [--variants <jsonl>] [--controls <jsonl>] [--corrections <jsonl>] [--url <embed server>]
 *            [--rerank ruri,xs --python <venv python>] [--theta dev|0.95[,0.9]] [--beta 2[,1]] [--defer-th tag=0.12]
 *            [--external tag=<ranked.jsonl>[,…]]   outside rankers (best_v2.py export-ranked): the product's correction on top, corrected top-1
 *            [--rerank-all tag=<every-card scores.json>]   adds <tag>+inj: near corrections' right answers join the offer, as route() does
 *            [--split dev|test]   where the wrong answers are corrected and measured (dev: choose β without test)
 *            [--table [--table-max-false 0.02]]   variant-aware rule table (+tbl configs; readings via --python + pykakasi)
 *            --rerank accepts tag=<model dir> (fused with ruri's w/conv), e.g. ft=/tmp/ft/k10-real-s0 [--out <dir>]
 *            (user corrections through the router's feedback store, then variants/controls)
 *
 * No command calls a generative model. `embed --provider http` calls the server the
 * user runs; the bench does not start one.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compareTable, runDirs } from "./compare.ts";
import {
	importCards,
	importChoices,
	importExportEmbeddings,
	importLabels,
	parseSplitRule,
	importUtterances,
	loadLabels,
	loadUtterances,
	passagesByCard,
} from "./data.ts";
import { openBench } from "./db.ts";
import { fakeProvider, fillCache, httpProvider } from "./embed.ts";
import { jsonl } from "./io.ts";
import { reviewSheet, sheetMarkdown } from "./label.ts";
import { RUN_DEFAULTS, run } from "./run.ts";
import { registerSr, SR_DEFAULTS, type SrOptions } from "./algorithms.ts";

const OPTIONS = {
	db: { type: "string" },
	cards: { type: "string" },
	utterances: { type: "string" },
	choices: { type: "string" },
	labels: { type: "string" },
	"split-time": { type: "string" },
	export: { type: "string" },
	out: { type: "string" },
	md: { type: "string" },
	model: { type: "string" },
	provider: { type: "string" },
	url: { type: "string" },
	dimension: { type: "string" },
	limit: { type: "string" },
	algo: { type: "string" },
	split: { type: "string" },
	offer: { type: "string" },
	temperature: { type: "string" },
	feedback: { type: "boolean" },
	sr: { type: "string" },
	run: { type: "string" },
	root: { type: "string" },
	variants: { type: "string" },
	controls: { type: "string" },
	corrections: { type: "string" },
	python: { type: "string" },
	rerank: { type: "string" },
	theta: { type: "string" },
	beta: { type: "string" },
	external: { type: "string" },
	"rerank-all": { type: "string" },
	"defer-th": { type: "string" },
	table: { type: "boolean" },
	"table-max-false": { type: "string" },
	artifact: { type: "string" },
	text: { type: "string" },
	prev: { type: "string" },
	hints: { type: "string" },
	in: { type: "string" },
} as const;

const stamp = () =>
	new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");

function need<T>(value: T | undefined, name: string): T {
	if (value === undefined) throw new Error(`missing --${name}`);
	return value;
}

export async function main(
	argv: readonly string[],
	print: (line: string) => void = console.log,
) {
	const { values: v, positionals } = parseArgs({
		args: [...argv],
		options: OPTIONS,
		allowPositionals: true,
	});
	const [given, sub] = positionals;
	// `run --algo best-v2 --text … | --in …` routes new utterances with the exported artifact (same as `route`).
	const command = given === "run" && v.algo === "best-v2" ? "route" : given;
	const db = () => openBench(need(v.db, "db"));
	switch (command) {
		case "import": {
			const bench = db();
			const counts: Record<string, unknown> = {};
			if (v.export) {
				const dir = v.export;
				counts["cards"] = importCards(bench, join(dir, "cards.jsonl"));
				counts["utterances"] = importUtterances(bench, join(dir, "utterances.jsonl"));
				counts["choices"] = importChoices(bench, join(dir, "choices.jsonl"));
				const emb = join(dir, "embeddings.jsonl.gz");
				if (existsSync(emb)) counts["embeddings"] = importExportEmbeddings(bench, emb);
				const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
					counts: Record<string, number>;
				};
				counts["manifest"] = manifest.counts;
			}
			if (v.cards) counts["cards"] = importCards(bench, v.cards);
			if (v.utterances)
				counts["utterances"] = importUtterances(bench, v.utterances);
			if (v.choices) counts["choices"] = importChoices(bench, v.choices);
			if (v.labels) counts["labels"] = importLabels(bench, v.labels);
			print(JSON.stringify(counts));
			return counts;
		}
		case "label": {
			const bench = db();
			if (sub === "import") {
				const counts = importLabels(bench, need(v.labels, "labels"), parseSplitRule(v["split-time"]));
				print(JSON.stringify(counts));
				return counts;
			}
			if (sub === "export") {
				const rows = reviewSheet(bench, {
					model: v.model ?? null,
					limit: Number(v.limit ?? 100),
					top: 5,
				});
				writeFileSync(need(v.out, "out"), jsonl(rows));
				if (v.md) writeFileSync(v.md, sheetMarkdown(rows));
				print(JSON.stringify({ exported: rows.length }));
				return { exported: rows.length };
			}
			if (sub === "stats") {
				const labels = [...loadLabels(bench).values()];
				const stats = {
					utterances: loadUtterances(bench).length,
					labeled: labels.length,
					reviewed: labels.filter((l) => l.status === "reviewed").length,
					hold: labels.filter((l) => l.status === "hold").length,
					none: labels.filter((l) => l.none).length,
					bySplit: Object.fromEntries(
						["dev", "test"].map((s) => [
							s,
							labels.filter((l) => l.split === s && l.status === "reviewed")
								.length,
						]),
					),
					byGold: labels.reduce<Record<string, number>>((acc, l) => {
						if (l.status !== "reviewed") return acc;
						const key = l.none ? "none" : l.gold!;
						acc[key] = (acc[key] ?? 0) + 1;
						return acc;
					}, {}),
				};
				print(JSON.stringify(stats, null, 2));
				return stats;
			}
			throw new Error("usage: label export|import|stats");
		}
		case "embed": {
			const bench = db();
			const provider =
				v.provider === "http"
					? httpProvider({
							baseUrl: need(v.url, "url"),
							model: need(v.model, "model"),
						})
					: v.provider === "fake"
						? fakeProvider(Number(v.dimension ?? 256))
						: (() => {
								throw new Error("usage: --provider fake|http");
							})();
			const texts = [
				...[...passagesByCard(bench).values()].flat(),
				...loadUtterances(bench).flatMap((u) => [u.text, ...(u.previousUser ? [u.previousUser] : [])]),
			];
			const result = {
				model: provider.model,
				...(await fillCache(bench, provider, texts)),
			};
			print(JSON.stringify(result));
			return result;
		}
		case "run": {
			const algo = need(v.algo, "algo");
			if (v.sr) {
				// A tuned sr-weighted variant: `{ "vectors": bool, ...partial SrOptions }`.
				const o = JSON.parse(v.sr) as Partial<SrOptions> & { vectors?: boolean };
				registerSr(
					algo,
					{ ...SR_DEFAULTS, ...o, weights: { ...SR_DEFAULTS.weights, ...(o.weights ?? {}) } },
					o.vectors !== false,
				);
			}
			const out = v.out ?? join("out", `${stamp()}-${algo}`);
			if (existsSync(out)) throw new Error(`out_exists: ${out}`);
			const summary = run(db(), {
				algo,
				split: v.split ?? RUN_DEFAULTS.split,
				model: v.model ?? null,
				offer: Number(v.offer ?? RUN_DEFAULTS.offer),
				temperature: Number(v.temperature ?? RUN_DEFAULTS.temperature),
				feedback: v.feedback ?? false,
				out,
			});
			print(`${out} top1=${summary.top1} digest=${summary.digest}`);
			return summary;
		}
		case "score": {
			const text = readFileSync(
				join(need(v.run, "run"), "summary.json"),
				"utf8",
			);
			print(text);
			return JSON.parse(text) as unknown;
		}
		case "route": {
			const { route } = await import("./route.ts");
			const rows = v.in
				? readFileSync(v.in, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { text: string })
				: [{ text: need(v.text, "text"), prev: v.prev ?? null, hints: v.hints ? JSON.parse(v.hints) : {} }];
			const out = await route({ db: need(v.db, "db"), artifact: need(v.artifact, "artifact"), rows, python: v.python, url: v.url, model: v.model });
			const text = out.map((r) => JSON.stringify(r)).join("\n");
			if (v.out) writeFileSync(v.out, text + "\n"); else print(text);
			return out;
		}
		case "correct": {
			const { correctionExperiment } = await import("./correction.ts");
			return correctionExperiment({
				db: need(v.db, "db"), out: v.out ?? `out/correct-${stamp()}`,
				variants: v.variants, controls: v.controls, corrections: v.corrections,
				url: v.url ?? "http://127.0.0.1:8765", model: v.model, python: v.python,
				rerankers: v.rerank ? v.rerank.split(",") : [],
				deferThresholds: v["defer-th"] ? Object.fromEntries(v["defer-th"].split(",").map((kv) => { const [k, x] = kv.split("="); return [k!, Number(x)]; })) : undefined,
				thetas: v.theta ? v.theta.split(",").map((t) => (t === "dev" ? ("dev" as const) : Number(t))) : undefined,
				betas: v.beta ? v.beta.split(",").map(Number) : undefined,
				external: v.external ? Object.fromEntries(v.external.split(",").map((kv) => { const [k, f] = kv.split("="); return [k!, f!]; })) : undefined,
				split: v.split === "dev" ? "dev" : v.split === undefined || v.split === "test" ? undefined : (() => { throw new Error("split must be dev or test"); })(),
				rerankAll: v["rerank-all"] ? Object.fromEntries(v["rerank-all"].split(",").map((kv) => { const [k, f] = kv.split("="); return [k!, f!]; })) : undefined, print,
				table: v.table, tableMaxFalse: v["table-max-false"] ? Number(v["table-max-false"]) : undefined,
			});
		}
		case "compare": {
			const table = compareTable(
				runDirs(positionals.slice(1), v.root ?? "out"),
			);
			print(table);
			return table;
		}
		default:
			throw new Error(
				"usage: bun run router import|label|embed|run|score|compare (see bench/router/main.ts)",
			);
	}
}

if (import.meta.main)
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
