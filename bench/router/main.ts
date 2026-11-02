/**
 * `bun run router <command>`: the evaluation bench, independent of Eumenes.
 *
 *   import   --db <file> [--cards <json|jsonl>] [--utterances <jsonl>] [--choices <jsonl>] [--labels <jsonl>]
 *   label    export --db <file> --out <sheet.jsonl> [--md <sheet.md>] [--model <m>] [--limit N]
 *   label    import --db <file> --labels <jsonl>
 *   label    stats  --db <file>
 *   embed    --db <file> (--provider fake | --provider http --url <base> --model <m>)
 *   run      --db <file> --algo fts|embed|hybrid [--model <m>] [--split test|dev|any] [--feedback] [--out <dir>]
 *   score    --run <dir>             (prints the run's summary)
 *   compare  [<run dir> ...] [--root out]
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
	importLabels,
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

const OPTIONS = {
	db: { type: "string" },
	cards: { type: "string" },
	utterances: { type: "string" },
	choices: { type: "string" },
	labels: { type: "string" },
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
	run: { type: "string" },
	root: { type: "string" },
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
	const [command, sub] = positionals;
	const db = () => openBench(need(v.db, "db"));
	switch (command) {
		case "import": {
			const bench = db();
			const counts: Record<string, unknown> = {};
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
				const counts = importLabels(bench, need(v.labels, "labels"));
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
				...loadUtterances(bench).map((u) => u.text),
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
